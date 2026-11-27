#!/usr/bin/env node
/**
 * [qa] Browser smoke test (headless Chromium, WebGL via SwiftShader — same flags/fallback as shot.mjs).
 *
 *   node scripts/smoke.mjs                       # full run, screenshots in /tmp/smoke, JSON report on stdout
 *   node scripts/smoke.mjs --out /tmp/s2 --seconds 20 --no-campaign
 *
 * Steps
 *   1. menu      load `/`, the main menu must render (window.__app + clickable buttons in #ui-root)
 *   2. skirmish  start a skirmish through the UI (click "Skirmish…", then a Start/Launch/Play button if a setup
 *                screen appears); falls back to `/?autostart=skirmish` when the UI path doesn't start a match
 *   3. run       ~30 s real time at speed 4, a screenshot every ~10 s; sanity-check window.__game.world
 *                (tick advanced, entities present, both players alive, game not over)
 *   4. campaign  load `/?autostart=campaign&mission=m1`; mission + objectives exist and the dialogue and
 *                objectives panels are in the DOM
 * Any page error or console.error fails the run. Prints a JSON report as the LAST stdout block
 * (also <out>/report.json) and exits 1 on failure, 0 on success.
 *
 * Options: --base http://localhost:5173 --out /tmp/smoke --seconds 30 --speed 4 --interval 10 --map <id>
 *          --difficulty normal --seed 7 --width 1600 --height 900 --mission m1
 *          --min-ticks 40 (fail below: sim stalled) --expect-ticks 400 (warn below: host overloaded)
 *          --no-campaign --no-ui (skip the UI click path, use ?autostart) --boot-timeout 150 (s per boot wait)
 *          DEFAULT: a private vite server with HMR + file watching OFF (the shared :5173 full-reloads every open
 *          page whenever any agent saves). --shared or an explicit --base uses that server instead.
 *          --quiet
 * Page reloads caused by the shared dev server's HMR (someone saved a file) are detected and the run restarted.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectErrors, ensureServer, launch, parseArgs, sleep, trackLoads, waitFor, round } from './lib/browser.mjs';

const opts = parseArgs(process.argv.slice(2), {
  base: 'http://localhost:5173', out: '/tmp/smoke', seconds: 30, speed: 4, interval: 10, map: '', difficulty: 'normal',
  seed: 7, minTicks: 40, expectTicks: 400, width: 1600, height: 900, mission: 'm1', campaign: true, ui: true, quiet: false, private: true, shared: false, bootTimeout: 150,
}, { flags: ['campaign', 'ui', 'quiet', 'private', 'shared'] });
if (opts.help) {
  console.log('usage: node scripts/smoke.mjs [--base url] [--out dir] [--seconds 30] [--speed 4] [--interval 10] [--map id] [--difficulty normal] [--seed 7] [--min-ticks 200] [--mission m1] [--no-campaign] [--no-ui] [--quiet]');
  process.exit(0);
}
mkdirSync(opts.out, { recursive: true });
const log = (...a) => { if (!opts.quiet) console.log(...a); };
const report = {
  ok: false, startedAt: new Date().toISOString(), base: opts.base, out: path.resolve(opts.out), steps: {}, failures: [], warnings: [],
  screenshots: [], errors: null, durationMs: 0,
};
const fail = (step, msg) => { report.failures.push(`${step}: ${msg}`); log(`[smoke] FAIL ${step}: ${msg}`); };
const warn = (step, msg) => { report.warnings.push(`${step}: ${msg}`); log(`[smoke] warn ${step}: ${msg}`); };
const t0 = Date.now();

const srv = await ensureServer(opts.base, log, { forcePrivate: opts.private && !opts.shared && !process.argv.includes('--base') });
report.base = srv.base;
report.privateServer = srv.privateServer;
const { browser, page } = await launch({ width: opts.width, height: opts.height });
const errs = collectErrors(page, srv.base, { echo: !opts.quiet });
const nav = trackLoads(page);
const shot = async (name) => {
  const file = path.join(opts.out, `${name}.png`);
  try { await page.screenshot({ path: file, timeout: 60000 }); report.screenshots.push(file); log(`[smoke] screenshot ${file}`); } catch (e) { warn('screenshot', `${name}: ${e.message.split('\n')[0]}`); }
  return file;
};
const url = (q) => `${srv.base}/${q}`;
const gameQuery = (extra = '') => `?autostart=skirmish&speed=${opts.speed}&seed=${opts.seed}&difficulty=${opts.difficulty}${opts.map ? `&map=${opts.map}` : ''}${extra}`;

/** Click the best visible element whose text matches `re`. Returns its label or null. */
async function clickText(re, exclude = null) {
  const target = await page.evaluate(([src, flags, exSrc]) => {
    const rx = new RegExp(src, flags), ex = exSrc ? new RegExp(exSrc, 'i') : null;
    const cands = [];
    for (const el of document.querySelectorAll('button, [role=button], a, [onclick], .btn, .button, li, div, span')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none' || Number(cs.opacity) === 0) continue;
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!text || text.length > 60 || !rx.test(text) || (ex && ex.test(text))) continue;
      if (el.disabled) continue;
      const tag = el.tagName.toLowerCase();
      const score = (tag === 'button' ? 0 : el.getAttribute('role') === 'button' || tag === 'a' ? 1 : cs.cursor === 'pointer' ? 2 : 4) + text.length / 100;
      cands.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, text, score });
    }
    cands.sort((a, b) => a.score - b.score);
    return cands[0] ?? null;
  }, [re.source, re.flags, exclude?.source ?? null]).catch(() => null); // page may be reloading (HMR)
  if (!target) return null;
  try { await page.mouse.click(target.x, target.y); } catch { return null; }
  return target.text;
}

const gameStarted = () => page.evaluate(() => !!(window.__game || window.__app?.currentGame)).catch(() => false);

try {
  // ── 1. menu ──
  errs.phase = 'menu';
  const menu = { loaded: false, app: false, buttons: [] };
  report.steps.menu = menu;
  await page.goto(url(''), { waitUntil: 'load', timeout: opts.bootTimeout * 1000 });
  menu.loaded = true;
  menu.app = !!(await waitFor(page, () => !!window.__app, opts.bootTimeout * 1000));
  if (!menu.app) fail('menu', 'window.__app missing after load');
  const btns = await waitFor(page, () => {
    const root = document.getElementById('ui-root') ?? document.body;
    const list = [...root.querySelectorAll('button, [role=button], a, [onclick]')]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((b) => (b.innerText || b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean);
    return list.length ? list : null;
  }, opts.bootTimeout * 1000);
  menu.buttons = btns ?? [];
  if (!btns) fail('menu', 'no clickable menu buttons rendered in #ui-root');
  menu.title = await page.evaluate(() => (document.getElementById('ui-root')?.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3)).catch(() => []);
  await sleep(500);
  await shot('00-menu');

  // ── 2. skirmish (UI path first) ──
  errs.phase = 'skirmish-start';
  const sk = { via: null, clicks: [] };
  report.steps.skirmish = sk;
  if (opts.ui && btns) {
    const steps = [/skirmish/i, /^(start|launch|begin|play|deploy|go|start (match|game|skirmish)|begin (match|outbreak))\b/i, /^(start|launch|begin|play|deploy|confirm|ok)\b/i];
    for (const re of steps) {
      if (await gameStarted()) break;
      const clicked = await clickText(re, /campaign|mission|settings|credits|quit|back/);
      if (clicked) { sk.clicks.push(clicked); log(`[smoke] clicked "${clicked}"`); }
      if (await waitFor(page, () => !!(window.__game || window.__app?.currentGame), 8000)) break;
      if (clicked) await shot(`01-ui-after-${sk.clicks.length}`);
    }
    if (await gameStarted()) sk.via = 'ui';
    else warn('skirmish', `could not start a skirmish through the UI (clicked: ${sk.clicks.join(' → ') || 'nothing'}); falling back to ?autostart`);
  }
  if (!sk.via) {
    await page.goto(url(gameQuery()), { waitUntil: 'load', timeout: opts.bootTimeout * 1000 });
    if (await waitFor(page, () => !!window.__game, opts.bootTimeout * 1000)) sk.via = 'autostart';
  }
  if (!sk.via) {
    fail('skirmish', 'no match started (window.__game never appeared)');
  } else {
    // ── 3. run at speed N, screenshots every interval (restarted once via ?autostart if HMR reloads the page) ──
    errs.phase = 'skirmish';
    let start = null, tStart = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const loads0 = nav.loads;
      await page.evaluate((s) => window.__game?.setSpeed(s), opts.speed);
      start = await page.evaluate(() => { const w = window.__game.world; return { tick: w.tick, time: w.time, entities: w.list.length, map: w.map.id }; });
      sk.map = start.map;
      sk.start = start;
      sk.samples = [];
      await page.evaluate(() => { window.__smokeFrames = 0; const f = () => { window.__smokeFrames++; requestAnimationFrame(f); }; requestAnimationFrame(f); }).catch(() => {});
      tStart = Date.now();
      let n = 0;
      while (Date.now() - tStart < opts.seconds * 1000) {
        const wait = Math.min(opts.interval * 1000, opts.seconds * 1000 - (Date.now() - tStart));
        await sleep(Math.max(0, wait));
        n++;
        const smp = await page.evaluate(() => {
          const g = window.__game; if (!g) return null;
          const w = g.world;
          const per = {};
          for (const p of w.activePlayers()) {
            let units = 0, buildings = 0;
            for (const e of w.list) if (e.alive && e.owner === p.id) { if (e.kind === 'unit') units++; else if (e.kind === 'building') buildings++; }
            per[p.id] = { units, buildings, defeated: p.defeated, matter: Math.floor(p.resources.matter), pop: `${p.popUsed}/${p.popCap}` };
          }
          return { tick: w.tick, time: Math.round(w.time * 10) / 10, frames: window.__smokeFrames ?? null, entities: w.list.length, projectiles: w.projectiles.length, gameOver: w.rules.gameOver, winnerTeam: w.rules.winnerTeam, speed: g.speed, players: per, ai: g.ais?.[0]?.describe?.() ?? null };
        }).catch((e) => ({ error: e.message }));
        sk.samples.push({ realS: round((Date.now() - tStart) / 1000, 1), ...smp });
        await shot(`02-skirmish-${String(n).padStart(2, '0')}`);
      }
      if (nav.loads === loads0) break;
      warn('skirmish', `page reloaded during the run (dev-server HMR — someone saved a file); ${attempt < 2 ? 'restarting via ?autostart' : 'results may be partial'} (use --private to avoid)`);
      if (attempt < 2) {
        await page.goto(url(gameQuery()), { waitUntil: 'load', timeout: opts.bootTimeout * 1000 });
        if (!(await waitFor(page, () => !!window.__game, opts.bootTimeout * 1000))) { fail('skirmish', 'window.__game missing after restart'); break; }
        sk.via += '+restart';
      }
    }
    const end = sk.samples[sk.samples.length - 1] ?? {};
    const ticks = (end.tick ?? 0) - start.tick;
    sk.ticksAdvanced = ticks;
    sk.ticksPerRealSecond = round(ticks / Math.max(1, (Date.now() - tStart) / 1000), 1);
    sk.gameSeconds = round(ticks / 20, 1);
    sk.fps = end.frames != null ? round(end.frames / Math.max(1, (Date.now() - tStart) / 1000), 1) : null;
    let load = '';
    try { const os = await import('node:os'); load = ` (host load avg ${os.loadavg()[0].toFixed(1)} on ${os.cpus().length} CPUs)`; sk.hostLoad = round(os.loadavg()[0], 1); } catch { /* ignore */ }
    if (!(ticks >= opts.minTicks)) fail('skirmish', `simulation essentially stalled: ${ticks} ticks in ${opts.seconds}s at speed ${opts.speed} (min ${opts.minTicks}), ${sk.fps ?? '?'} fps${load}`);
    else if (ticks < opts.expectTicks) warn('skirmish', `slow: ${ticks} ticks in ${opts.seconds}s at speed ${opts.speed} (${sk.ticksPerRealSecond} ticks/s, ${sk.fps ?? '?'} fps)${load}`);
    if (!(end.entities > 10)) fail('skirmish', `only ${end.entities} entities in world.list`);
    const ps = end.players ?? {};
    for (const pid of ['1', '2']) {
      const p = ps[pid];
      if (!p) fail('skirmish', `player ${pid} missing`);
      else {
        if (p.defeated) fail('skirmish', `player ${pid} already defeated after ${sk.gameSeconds}s game time`);
        if (p.units + p.buildings === 0) fail('skirmish', `player ${pid} has no entities`);
      }
    }
    if (end.gameOver) fail('skirmish', `game over after ${sk.gameSeconds}s (winnerTeam ${end.winnerTeam})`);
    const hud = await page.evaluate(() => (document.getElementById('ui-root')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300)).catch(() => '');
    sk.hudText = hud;
    if (!hud) warn('skirmish', 'HUD shows no text');
  }

  // ── 4. campaign m1 ──
  if (opts.campaign) {
    errs.phase = 'campaign';
    const cp = { mission: opts.mission };
    report.steps.campaign = cp;
    await page.goto(url(`?autostart=campaign&mission=${opts.mission}&seed=${opts.seed}`), { waitUntil: 'load', timeout: opts.bootTimeout * 1000 });
    if (!(await waitFor(page, () => !!window.__game, opts.bootTimeout * 1000))) fail('campaign', 'window.__game never appeared');
    else {
      // Poll for up to ~10 s: dialogue lines come and go (typed text, timed lines), objectives may appear late.
      const probe = () => page.evaluate(() => {
        const g = window.__game;
        if (!g) return { pending: true };
        const root = document.getElementById('ui-root') ?? document.body;
        const text = (root.innerText || '').replace(/\s+/g, ' ');
        const objs = g.mission?.objectives?.() ?? [];
        const sel = (re) => [...root.querySelectorAll('*')].filter((el) => re.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('data-testid') ?? ''} ${el.getAttribute('data-role') ?? ''}`) && el.getBoundingClientRect().width > 0);
        const dlgEls = sel(/dialog|dialogue|speech|subtitle|conversation/i);
        const objEls = sel(/objective|mission-goal|goals?\b|tasks?\b/i);
        const cast = ['Virtanen', 'SISU', 'Mäkelä', 'Makela', 'Korhonen', 'Strain Omega'];
        return {
          missionId: g.mission?.info?.id ?? null, missionTitle: g.mission?.info?.title ?? null, state: g.mission?.state ?? null,
          objectives: objs.map((o) => ({ id: o.id, text: o.text, state: o.state })),
          map: g.world.map.id, tick: g.world.tick, autoDefeat: g.world.rules.autoDefeat,
          dialogueEls: dlgEls.length, dialogueSample: (dlgEls[0]?.innerText ?? '').trim().slice(0, 160),
          objectiveEls: objEls.length, objectivesSample: (objEls[0]?.innerText ?? '').trim().slice(0, 160),
          castNamed: cast.filter((c) => text.includes(c)),
          objectiveTextShown: objs.filter((o) => o.text && text.includes(o.text.slice(0, 24))).length,
        };
      }).catch((e) => ({ error: e.message }));
      let info = null;
      const seen = { dialogueEls: 0, objectiveEls: 0, castNamed: new Set(), objectiveTextShown: 0, dialogueSample: '', objectivesSample: '' };
      let shotTaken = false;
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        info = await probe();
        if (info.error) break;
        if (info.pending) { info = null; continue; } // page (re)loading — keep polling
        seen.dialogueEls = Math.max(seen.dialogueEls, info.dialogueEls);
        seen.objectiveEls = Math.max(seen.objectiveEls, info.objectiveEls);
        seen.objectiveTextShown = Math.max(seen.objectiveTextShown, info.objectiveTextShown);
        for (const c of info.castNamed) seen.castNamed.add(c);
        if (info.dialogueSample) seen.dialogueSample ||= info.dialogueSample;
        if (info.objectivesSample) seen.objectivesSample ||= info.objectivesSample;
        if (!shotTaken && (info.dialogueEls > 0 || info.castNamed.length)) { await shot('03-campaign-dialogue'); shotTaken = true; }
        if (i >= 5 && (seen.dialogueEls > 0 || seen.castNamed.size) && (seen.objectiveEls > 0 || seen.objectiveTextShown > 0)) break;
      }
      if (info && !info.error) Object.assign(info, { dialogueEls: seen.dialogueEls, objectiveEls: seen.objectiveEls, objectiveTextShown: seen.objectiveTextShown, castNamed: [...seen.castNamed], dialogueSample: seen.dialogueSample, objectivesSample: seen.objectivesSample });
      info ??= { error: 'probe failed' };
      Object.assign(cp, info);
      await shot('03-campaign');
      if (info.error) fail('campaign', info.error);
      else {
        if (info.missionId !== opts.mission) fail('campaign', `mission is ${info.missionId}, expected ${opts.mission}`);
        if (!info.objectives?.length) fail('campaign', 'mission.objectives() is empty');
        const dialogueOk = info.dialogueEls > 0 || info.castNamed.length > 0;
        if (!dialogueOk) fail('campaign', 'no dialogue in the DOM (no element with dialog/dialogue/speech in id/class/data-testid, and no cast name in #ui-root text)');
        else if (info.dialogueEls === 0) warn('campaign', `dialogue only detected via cast name text (${info.castNamed.join(', ')}) — no dedicated dialogue element`);
        const objectivesOk = info.objectiveEls > 0 || info.objectiveTextShown > 0;
        if (!objectivesOk) fail('campaign', 'objectives panel missing (no element with "objective" in id/class/data-testid and no objective text visible)');
        if (info.map !== 'meilahti') warn('campaign', `campaign runs on map "${info.map}" (meilahti not registered?)`);
      }
    }
  }
} catch (err) {
  fail(errs.phase, `script error: ${err.message}`);
  await shot('99-failure');
} finally {
  report.errors = { pageErrors: errs.pageErrors, consoleErrors: errs.consoleErrors, consoleWarnings: errs.consoleWarnings, warningSamples: errs.warningSamples, badResponses: errs.badResponses, failedRequests: errs.failedRequests, abortedRequests: errs.abortedRequests, pageLoads: nav.loads };
  for (const r of errs.failedRequests) report.warnings.push(`request failed[${r.phase}]: ${r.url} ${r.error}`);
  for (const e of errs.pageErrors) report.failures.push(`pageerror[${e.phase}]: ${e.message}`);
  for (const e of errs.consoleErrors) report.failures.push(`console.error[${e.phase}]: ${e.text.split('\n')[0].slice(0, 300)}`);
  for (const r of errs.badResponses) report.failures.push(`http ${r.status}[${r.phase}]: ${r.url}`);
  report.ok = report.failures.length === 0;
  report.durationMs = Date.now() - t0;
  writeFileSync(path.join(opts.out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  await srv.close().catch(() => {});
  console.log(JSON.stringify(report, null, 2));
  console.log(`SMOKE-SUMMARY ok=${report.ok} failures=${report.failures.length} warnings=${report.warnings.length} pageErrors=${errs.pageErrors.length} consoleErrors=${errs.consoleErrors.length} screenshots=${report.screenshots.length} report=${path.join(report.out, 'report.json')}`);
  process.exit(report.ok ? 0 : 1);
}
