#!/usr/bin/env node
/**
 * [net] LAN multiplayer end-to-end check:  npm run lan:e2e  [-- --ticks 800 --keep-server]
 *
 * Starts a PRIVATE Vite dev server (no HMR / file watching, relay plugin attached, quiet), opens two headless
 * Chromium pages (SwiftShader, same flags as scripts/shot.mjs; small viewport, quality=low), and drives a full
 * match through the public session API (window.__net, i.e. src/net/index.ts):
 *   host createRoom('test') → guest joinRoom → both ready → host startMatch → both app.startGame(multiplayer)
 *   → commands from both sides via window.__game.issue → both run to exactly tick N (lockstep.haltAtTick)
 *   → compare world tick + stateHash → tamper with the guest world → both detect the desync, the host resyncs,
 *   both Games restart from its snapshot and must match again (skip with --no-resync)
 *   → close the guest page → host must get 'opponentLeft'.
 * Prints a JSON report (last line) and exits 1 on failure.
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TARGET_TICK = Number(argVal('--ticks', 800)); // 40 s of sim time
const VIEW = { width: 480, height: 300 };
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--no-sandbox'];

const t0 = Date.now();
const log = (m) => console.log(`[lan-e2e +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const report = { ok: false, targetTick: TARGET_TICK, steps: [], errors: [] };

process.env.LAN_QUIET = '1';
const { createServer } = await import('vite');
const server = await createServer({
  root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
  server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false, watch: null },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
report.base = base;
log(`private vite server (no HMR, relay on /lan) at ${base}`);

const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
const pages = {};

async function openPage(role) {
  const page = await browser.newPage({ viewport: VIEW });
  page.on('pageerror', (e) => report.errors.push({ role, kind: 'pageerror', message: e.message }));
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push({ role, kind: 'console.error', message: m.text().slice(0, 300) }); });
  await page.goto(`${base}/?quality=low`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => !!window.__app, null, { timeout: 120_000 });
  // the public API module (same instance the app uses) + an event log + auto-start on 'start'
  await page.evaluate(async (name) => {
    const net = await import('/src/net/index.ts');
    const save = await import('/src/sim/save/index.ts');
    const e2e = { net, save, events: [], session: null };
    window.__e2e = e2e;
    const s = net.createLanSession({ name });
    e2e.session = s;
    for (const ev of ['status', 'lobby', 'chat', 'start', 'opponentLeft', 'opponentReturned', 'desync', 'error', 'roomClosed']) {
      s.on(ev, (e) => e2e.events.push({ ev, at: performance.now(), e: ev === 'lobby' ? { state: e.state, n: e.players.length } : e }));
    }
    s.on('start', (st) => window.__app.startGame({ mode: 'multiplayer', difficulty: 'normal', net: net.createNetMatch(s, st) }));
    if (!window.__net) throw new Error('window.__net hook missing');
  }, role === 'host' ? 'Aino (host)' : 'Joonas (guest)');
  pages[role] = page;
  return page;
}

const step = (name, extra = {}) => { report.steps.push({ name, t: +((Date.now() - t0) / 1000).toFixed(1), ...extra }); log(name); };

try {
  const host = await openPage('host');
  const guest = await openPage('guest');
  step('pages loaded');

  await host.evaluate(() => window.__e2e.session.createRoom({ mapId: 'test', hostFaction: 'hospital', guestFaction: 'pathogen' }));
  const roomId = await host.waitForFunction(() => window.__e2e.session.lobby?.roomId, null, { timeout: 15_000 }).then((h) => h.jsonValue());
  report.roomId = roomId;
  step(`host created room ${roomId}`);
  const listed = await guest.evaluate(async () => {
    const s = window.__e2e.session;
    return await new Promise((res) => { const off = s.on('rooms', (r) => { off(); res(r.map((x) => x.roomId)); }); s.listRooms(); });
  });
  if (!listed.includes(roomId)) throw new Error(`room ${roomId} not listed (${listed})`);
  await guest.evaluate((id) => window.__e2e.session.joinRoom(id), roomId);
  await guest.waitForFunction(() => window.__e2e.session.lobby?.players.length === 2, null, { timeout: 15_000 });
  step('guest joined');
  for (const p of [host, guest]) await p.evaluate(() => window.__e2e.session.setReady(true));
  await host.waitForFunction(() => window.__e2e.session.lobby?.state === 'ready', null, { timeout: 15_000 });
  await host.evaluate(() => window.__e2e.session.sendChat('glhf'));
  await host.evaluate(() => window.__e2e.session.startMatch());
  for (const p of [host, guest]) {
    await p.waitForFunction(() => window.__game?.net && window.__game.world, null, { timeout: 120_000 });
    await p.evaluate((n) => { window.__game.net.lockstep.haltAtTick = n; }, TARGET_TICK);
  }
  report.start = await host.evaluate(() => { const s = window.__game.net.start; return { seed: s.seed, mapId: s.mapId, turnTicks: s.turnTicks, inputDelayTurns: s.inputDelayTurns, matchId: s.matchId }; });
  step('match started on both pages', { start: report.start });

  // commands from both sides through the normal Game.issue path (→ lockstep.submit)
  const issueScript = async (page, phase) => page.evaluate((ph) => {
    const g = window.__game, w = g.world, me = g.localPlayerId;
    const hq = w.entitiesOf(me, (e) => e.kind === 'building')[0];
    const workers = w.entitiesOf(me, (e) => !!e.gatherer);
    const workerDef = w.player(me).faction === 'hospital' ? 'hosp_orderly' : 'path_spore_drone';
    const out = [];
    if (ph === 1 && hq) {
      g.issue({ type: 'train', playerId: me, buildingId: hq.id, defId: workerDef }); out.push('train');
      g.issue({ type: 'setRally', playerId: me, buildingIds: [hq.id], target: { x: hq.pos.x + 4, y: hq.pos.y + 2 } }); out.push('rally');
      if (workers[0]) { g.issue({ type: 'move', playerId: me, unitIds: [workers[0].id], target: { x: w.map.width / 2, y: w.map.height / 2 } }); out.push('move'); }
      if (workers[1]) { g.issue({ type: 'stop', playerId: me, unitIds: [workers[1].id] }); out.push('stop'); }
      // a spoofed command for the opponent's units must be neutralised by lockstep validation
      const foe = w.entitiesOf(me === 1 ? 2 : 1, (e) => !!e.gatherer)[0];
      if (foe) { g.issue({ type: 'stop', playerId: me === 1 ? 2 : 1, unitIds: [foe.id] }); out.push('spoof'); }
    }
    if (ph === 2) {
      const node = workers[1] && w.spatial.nearest(workers[1].pos, 40, (e) => e.kind === 'resource');
      if (node) { g.issue({ type: 'gather', playerId: me, unitIds: [workers[1].id], targetId: node.id }); out.push('gather'); }
      if (workers[0]) { g.issue({ type: 'attackMove', playerId: me, unitIds: [workers[0].id], target: w.player(me === 1 ? 2 : 1).startPos }); out.push('attackMove'); }
      if (hq) { g.issue({ type: 'train', playerId: me, buildingId: hq.id, defId: workerDef }); out.push('train'); }
    }
    return { tick: w.tick, issued: out };
  }, phase);

  const ticks = async () => Promise.all([host, guest].map((p) => p.evaluate(() => window.__game.world.tick)));
  let phase = 0;
  const runStart = Date.now();
  let lastLog = 0;
  for (;;) {
    const [a, b] = await ticks();
    if (phase === 0 && a > 60 && b > 60) { phase = 1; report.commands1 = await Promise.all([issueScript(host, 1), issueScript(guest, 1)]); step('phase-1 commands issued', { cmds: report.commands1 }); }
    if (phase === 1 && a > 300 && b > 300) { phase = 2; report.commands2 = await Promise.all([issueScript(host, 2), issueScript(guest, 2)]); step('phase-2 commands issued', { cmds: report.commands2 }); }
    if (a === TARGET_TICK && b === TARGET_TICK) break;
    if (Date.now() - lastLog > 15_000) { lastLog = Date.now(); log(`ticks host=${a} guest=${b}`); }
    if (Date.now() - runStart > 600_000) throw new Error(`timeout: ticks host=${a} guest=${b}`);
    await sleep(1000);
  }
  const realS = (Date.now() - runStart) / 1000;
  report.simRate = +(TARGET_TICK / 20 / realS).toFixed(2);

  const probe = (p) => p.evaluate(() => {
    const g = window.__game, ls = g.net.lockstep;
    return {
      tick: g.world.tick, hash: window.__e2e.save.stateHash(g.world), debug: ls.debug(), waitingReason: ls.waitingReason,
      pingMs: Math.round(window.__e2e.session.pingMs), status: window.__e2e.session.status,
      units: g.world.list.filter((e) => e.alive && e.kind === 'unit').length,
      foeWorkerOrders: g.world.entitiesOf(g.localPlayerId === 1 ? 2 : 1, (e) => !!e.gatherer).map((e) => e.orders.length),
      trained: [...g.world.players.values()].map((p) => p.stats.unitsTrained),
      desyncEvents: window.__e2e.events.filter((x) => x.ev === 'desync').length,
      chat: window.__e2e.events.filter((x) => x.ev === 'chat').length,
    };
  });
  const [ph, pg] = [await probe(host), await probe(guest)];
  report.host = ph; report.guest = pg;
  report.sameTick = ph.tick === pg.tick && ph.tick === TARGET_TICK;
  report.sameHash = ph.hash === pg.hash;
  step(`both at tick ${ph.tick}: host ${ph.hash} / guest ${pg.hash} → ${report.sameHash ? 'IDENTICAL' : 'DIFFERENT'}`);

  // desync → host-driven resync: tamper with the guest's world; both must detect it, the host snapshots,
  // both Games restart from the snapshot (app.startGame({ load })) as epoch 1 and continue identically
  if (!argv.includes('--no-resync')) {
    await guest.evaluate(() => { const g = window.__game; g.world.player(g.localPlayerId).resources.matter += 77; g.net.lockstep.haltAtTick = null; });
    await host.evaluate(() => { window.__game.net.lockstep.haltAtTick = null; });
    step('guest world tampered (+77 matter)');
    for (const p of [host, guest]) await p.waitForFunction(() => window.__game?.net?.start.epoch === 1 && window.__game.world, null, { timeout: 300_000, polling: 500 });
    const [a2, b2] = await ticks();
    const resyncTarget = Math.max(a2, b2) + 60;
    for (const p of [host, guest]) await p.evaluate((n) => { window.__game.net.lockstep.haltAtTick = n; }, resyncTarget);
    step(`both restarted from the host snapshot (epoch 1, startTick ${await host.evaluate(() => window.__game.net.start.startTick)}); running to tick ${resyncTarget}`);
    const rs = Date.now();
    for (;;) {
      const [a, b] = await ticks();
      if (a === resyncTarget && b === resyncTarget) break;
      if (Date.now() - rs > 300_000) throw new Error(`resync timeout: host=${a} guest=${b}`);
      await sleep(1000);
    }
    const [rh, rg] = [await probe(host), await probe(guest)];
    report.resync = {
      tick: rh.tick, hostHash: rh.hash, guestHash: rg.hash, sameHash: rh.hash === rg.hash,
      desyncEvents: [rh.desyncEvents, rg.desyncEvents], epoch: [rh.debug.epoch, rg.debug.epoch],
      desyncEvent: await host.evaluate(() => window.__e2e.events.find((x) => x.ev === 'desync')?.e),
    };
    step(`after resync at tick ${rh.tick}: ${rh.hash} / ${rg.hash} → ${report.resync.sameHash ? 'IDENTICAL' : 'DIFFERENT'}`);
  }

  // opponent leaves: close the guest page, the host must be told
  await host.evaluate(() => { window.__game.net.lockstep.haltAtTick = null; });
  await guest.close();
  step('guest page closed');
  const left = await host.waitForFunction(() => window.__e2e.events.find((x) => x.ev === 'opponentLeft')?.e, null, { timeout: 30_000 }).then((h) => h.jsonValue());
  await sleep(1500);
  report.opponentLeft = left;
  report.afterLeave = await host.evaluate(() => ({ waitingReason: window.__game.net.lockstep.waitingReason, opponentGone: window.__game.net.lockstep.opponentGone }));
  step(`host got opponentLeft (${left.reason}); waiting: ${report.afterLeave.waitingReason}`);

  const realErrors = report.errors.filter((e) => !/AudioContext|autoplay/i.test(e.message));
  report.ok = report.sameTick && report.sameHash && ph.debug.desyncs === 0 && pg.debug.desyncs === 0 && ph.debug.hashChecks > 10
    && !!left && !!report.afterLeave.opponentGone && realErrors.length === 0
    && (!report.resync || (report.resync.sameHash && report.resync.desyncEvents.every((n) => n === 1) && report.resync.epoch.every((e) => e === 1)));
} catch (err) {
  report.errors.push({ kind: 'script', message: String(err?.stack ?? err).slice(0, 1000) });
  log(`FAILED: ${err?.message ?? err}`);
} finally {
  report.durationS = +((Date.now() - t0) / 1000).toFixed(1);
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
  console.log(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}
