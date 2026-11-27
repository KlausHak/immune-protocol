#!/usr/bin/env node
/**
 * [qa] In-browser performance probe: spawns N extra units via window.__game.world.spawnUnit and reports frame time
 * (avg / p50 / p95 / max, fps) and simulation cost (world.step avg / p95, per-system averages, AI, render, HUD).
 * Numbers under headless SwiftShader are only meaningful RELATIVE to each other (N=50 vs 200, before vs after).
 *
 *   node scripts/perf.mjs                          # N = 50,100,200 on the default map, idle units
 *   node scripts/perf.mjs --n 200 --mode fight --seconds 10 --map meilahti
 *   node scripts/perf.mjs --n 300 --mode move --shot /tmp/perf.png
 *
 * Modes: idle  — each side's units in a block near its own base (no combat)
 *        move  — like idle, every 4 s the blocks get move orders back and forth (pathing + steering + collisions)
 *        fight — both blocks spawn mid-map facing each other (combat, projectiles, VFX; N shrinks as units die)
 * DEFAULT: private HMR-free vite server (see smoke.mjs); --shared or --base <url> to use another server.
 * Options: --boot-timeout 150 --base --map --mode idle|move|fight --n 50,100,200 --seconds 8 --warmup 2 --speed 1 --quality high
 *          --width 1600 --height 900 --shot <png> --json <file>
 * Prints one JSON object per N plus a table; exit 1 only on page errors / script failure.
 */
import { writeFileSync } from 'node:fs';
import { collectErrors, ensureServer, launch, parseArgs, sleep, trackLoads, waitFor } from './lib/browser.mjs';

const opts = parseArgs(process.argv.slice(2), {
  base: 'http://localhost:5173', map: '', mode: 'idle', n: '50,100,200', seconds: 8, warmup: 2, speed: 1, quality: 'high',
  width: 1600, height: 900, shot: '', json: '', seed: 1, private: true, shared: false, bootTimeout: 150,
}, { flags: ['private', 'shared'] });
if (opts.help) { console.log('usage: node scripts/perf.mjs [--n 50,100,200] [--mode idle|move|fight] [--seconds 8] [--warmup 2] [--map id] [--speed 1] [--quality high] [--shot file.png] [--json out.json]'); process.exit(0); }
const counts = String(opts.n).split(',').map((s) => Number(s.trim())).filter((x) => Number.isFinite(x) && x >= 0);
const srv = await ensureServer(opts.base, console.log, { forcePrivate: opts.private && !opts.shared && !process.argv.includes('--base') });
const { browser, page } = await launch({ width: opts.width, height: opts.height });
const errs = collectErrors(page, srv.base);
const nav = trackLoads(page);
const results = [];
let failed = false;

/** Runs inside the page: instrument world.step + systems + AI/render/HUD, spawn units, return a measure() handle. */
function setup({ n, mode }) {
  const g = window.__game;
  const w = g.world;
  const P = (window.__perf = { frames: [], step: [], systems: {}, ai: [], render: [], hud: [], recording: false });
  const now = () => performance.now();
  const rec = (arr, d) => { if (P.recording) arr.push(d); };
  const origStep = w.step.bind(w);
  w.step = () => { const t = now(); origStep(); rec(P.step, now() - t); };
  for (const s of w.systems ?? []) {
    const u = s.update;
    s.update = (ww, dt) => { const t = now(); u.call(s, ww, dt); if (P.recording) (P.systems[s.name] ??= []).push(now() - t); };
  }
  for (const ai of g.ais ?? []) { const u = ai.update.bind(ai); ai.update = (dt) => { const t = now(); u(dt); rec(P.ai, now() - t); }; }
  if (g.renderer?.render) { const r = g.renderer.render.bind(g.renderer); g.renderer.render = (...a) => { const t = now(); r(...a); rec(P.render, now() - t); }; }
  if (g.ui?.update) { const h = g.ui.update.bind(g.ui); g.ui.update = (...a) => { const t = now(); h(...a); rec(P.hud, now() - t); }; }
  let last = 0;
  const loop = (t) => { if (last && P.recording) P.frames.push(t - last); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);

  // spawn
  const hosp = ['hosp_sanitizer', 'hosp_sanitizer', 'hosp_uv_lancer', 'hosp_medic', 'hosp_antibiotic_launcher', 'hosp_macrophage', 'hosp_sterilizer_drone'];
  const path = ['path_phage', 'path_phage', 'path_bacillus', 'path_spirochete', 'path_fungal_mortar', 'path_superbug', 'path_flu_drifter'];
  const s1 = w.player(1).startPos, s2 = w.player(2).startPos;
  const mid = { x: (s1.x + s2.x) / 2, y: (s1.y + s2.y) / 2 };
  const dir = { x: s2.x - s1.x, y: s2.y - s1.y }; const L = Math.hypot(dir.x, dir.y) || 1; dir.x /= L; dir.y /= L;
  const anchor1 = mode === 'fight' ? { x: mid.x - dir.x * 7, y: mid.y - dir.y * 7 } : { x: s1.x + dir.x * 12, y: s1.y + dir.y * 12 };
  const anchor2 = mode === 'fight' ? { x: mid.x + dir.x * 7, y: mid.y + dir.y * 7 } : { x: s2.x - dir.x * 12, y: s2.y - dir.y * 12 };
  const ids = { 1: [], 2: [] };
  let spawnErrors = 0;
  const block = (owner, anchor, list, count) => {
    const cols = Math.ceil(Math.sqrt(count));
    for (let i = 0; i < count; i++) {
      const p = { x: anchor.x + ((i % cols) - cols / 2) * 1.6, y: anchor.y + (Math.floor(i / cols) - cols / 2) * 1.6 };
      const q = w.movement.nearestWalkable(p, 10) ?? p;
      try { ids[owner].push(w.spawnUnit(list[i % list.length], owner, q).id); } catch { spawnErrors++; }
    }
  };
  block(1, anchor1, hosp, Math.ceil(n / 2));
  block(2, anchor2, path, Math.floor(n / 2));
  if (mode === 'fight') {
    w.issue({ type: 'attackMove', playerId: 1, unitIds: ids[1], target: anchor2 });
    w.issue({ type: 'attackMove', playerId: 2, unitIds: ids[2], target: anchor1 });
  }
  if (mode === 'move') {
    let flip = false;
    P.mover = setInterval(() => {
      flip = !flip;
      const off = flip ? 8 : -8;
      w.issue({ type: 'move', playerId: 1, unitIds: ids[1], target: { x: anchor1.x + dir.y * off, y: anchor1.y - dir.x * off } });
      w.issue({ type: 'move', playerId: 2, unitIds: ids[2], target: { x: anchor2.x + dir.y * off, y: anchor2.y - dir.x * off } });
    }, 4000);
  }
  const hasSystems = !!(w.systems && w.systems.length);
  return { spawned: ids[1].length + ids[2].length, spawnErrors, entities: w.list.length, hasSystems, map: w.map.id };
}

function measure() {
  const P = window.__perf, w = window.__game.world;
  const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; };
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const r = (x) => Math.round(x * 100) / 100;
  const systems = Object.fromEntries(Object.entries(P.systems).map(([k, v]) => [k, r(avg(v))]).sort((a, b) => b[1] - a[1]));
  const span = P.frames.reduce((a, b) => a + b, 0) / 1000 || 1;
  return {
    frames: P.frames.length, fps: r(P.frames.length / span),
    frameAvgMs: r(avg(P.frames)), frameP50Ms: r(pct(P.frames, 50)), frameP95Ms: r(pct(P.frames, 95)), frameMaxMs: r(Math.max(0, ...P.frames)),
    ticks: P.step.length, ticksPerSec: r(P.step.length / span), tickAvgMs: r(avg(P.step)), tickP95Ms: r(pct(P.step, 95)), tickMaxMs: r(Math.max(0, ...P.step)),
    aiAvgMs: r(avg(P.ai)), renderAvgMs: r(avg(P.render)), renderP95Ms: r(pct(P.render, 95)), hudAvgMs: r(avg(P.hud)),
    systemsAvgMs: systems, entitiesEnd: w.list.filter((e) => e.alive).length, projectilesEnd: w.projectiles.length,
  };
}

try {
  for (const n of counts) {
    errs.phase = `n=${n}`;
    const q = `?autostart=skirmish&reveal=1&seed=${opts.seed}&quality=${opts.quality}&speed=${opts.speed}${opts.map ? `&map=${opts.map}` : ''}`;
    let row = null;
    for (let attempt = 1; attempt <= 3 && !row; attempt++) {
      await page.goto(`${srv.base}/${q}`, { waitUntil: 'load', timeout: opts.bootTimeout * 1000 });
      if (!(await waitFor(page, () => !!window.__game, opts.bootTimeout * 1000))) { console.log(`[perf] n=${n}: window.__game never appeared`); continue; }
      await sleep(1500);
      const loads0 = nav.loads;
      const info = await page.evaluate(setup, { n, mode: opts.mode }).catch((e) => ({ error: e.message }));
      if (info.error) { console.log(`[perf] n=${n}: setup failed: ${info.error}`); continue; }
      await sleep(opts.warmup * 1000);
      const started = await page.evaluate(() => { if (!window.__perf) return false; window.__perf.recording = true; return true; }).catch(() => false);
      if (started) await sleep(opts.seconds * 1000);
      const m = started ? await page.evaluate(() => (window.__perf ? 1 : 0)).catch(() => 0) : 0;
      if (!started || !m || nav.loads !== loads0) {
        console.log(`[perf] n=${n}: page reloaded during the run (shared dev server HMR?) — retry ${attempt}/3 (use --private to avoid)`);
        continue;
      }
      const res = await page.evaluate(measure);
      if (opts.shot) { const f = counts.length > 1 ? opts.shot.replace(/\.png$/, `-${n}.png`) : opts.shot; await page.screenshot({ path: f }); res.screenshot = f; }
      row = { n, mode: opts.mode, map: info.map, spawned: info.spawned, entitiesStart: info.entities, ...res };
      if (!info.hasSystems) row.note = 'world.systems not accessible — per-system timing unavailable';
      if (info.spawnErrors) row.spawnErrors = info.spawnErrors;
      if (attempt > 1) row.attempts = attempt;
    }
    if (!row) { failed = true; continue; }
    results.push(row);
    console.log(JSON.stringify(row));
  }
} catch (err) {
  failed = true;
  console.log(`[perf] script error: ${err.message}`);
} finally {
  await browser.close().catch(() => {});
  await srv.close().catch(() => {});
}
if (results.length) {
  console.table(results.map((r) => ({ n: r.n, mode: r.mode, entities: r.entitiesStart, fps: r.fps, 'frame avg': r.frameAvgMs, 'frame p95': r.frameP95Ms, 'tick avg': r.tickAvgMs, 'tick p95': r.tickP95Ms, 'ticks/s': r.ticksPerSec, render: r.renderAvgMs, ai: r.aiAvgMs, hud: r.hudAvgMs, 'top system': Object.entries(r.systemsAvgMs)[0]?.join(' ') ?? '-' })));
}
const summary = { ok: !failed && errs.pageErrors.length === 0, results, pageErrors: errs.pageErrors, consoleErrors: errs.consoleErrors.length };
if (opts.json) writeFileSync(opts.json, JSON.stringify(summary, null, 2));
console.log(`PERF-SUMMARY ok=${summary.ok} runs=${results.length} pageErrors=${errs.pageErrors.length} consoleErrors=${errs.consoleErrors.length}`);
process.exit(summary.ok ? 0 : 1);
