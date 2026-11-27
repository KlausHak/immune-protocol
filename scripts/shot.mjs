#!/usr/bin/env node
/**
 * Headless-Chromium screenshot / browser-driver tool (WebGL via SwiftShader).
 *
 *   node scripts/shot.mjs --url "/?autostart=skirmish&reveal=1" --wait 4000 --out /tmp/a.png
 *
 * Arguments are executed IN ORDER as actions, so you can script a session:
 *   --url <path|url>        navigate (path is relative to --base, default http://localhost:5173)
 *   --wait <ms>             sleep
 *   --wait-for "<js>"       poll a JS expression until truthy (max 30 s)
 *   --eval "<js>"           evaluate JS in the page (awaits promises); prints the JSON result
 *   --click x,y | --rclick x,y | --move x,y | --drag x0,y0,x1,y1 | --key <Key> (e.g. a, Escape, Control+1)
 *   --out <file.png>        screenshot now (several allowed)
 * Options (anywhere): --width 1600 --height 900 --base <url> --console (print all console output)
 *
 * If nothing answers at --base, a private Vite dev server is started for the session.
 * Prints page errors and console errors/warnings; the last line is a summary:
 *   SHOT-SUMMARY errors=<n> warnings=<n> shots=<files>
 */
import { chromium } from 'playwright-core';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opts = { width: 1600, height: 900, base: 'http://localhost:5173', console: false };
const actions = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  switch (a) {
    case '--width': opts.width = Number(next()); break;
    case '--height': opts.height = Number(next()); break;
    case '--base': opts.base = next(); break;
    case '--console': opts.console = true; break;
    case '--url': case '--wait': case '--wait-for': case '--eval': case '--click': case '--rclick':
    case '--move': case '--drag': case '--key': case '--out':
      actions.push([a.slice(2), next()]); break;
    default: console.error(`unknown arg ${a}`); process.exit(2);
  }
}
if (!actions.some(([k]) => k === 'url')) actions.unshift(['url', '/']);
if (!actions.some(([k]) => k === 'out')) actions.push(['wait', '3000'], ['out', '/tmp/shot.png']);

async function reachable(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; }
}

let server = null;
if (!(await reachable(opts.base))) {
  const { createServer } = await import('vite');
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port: 0, strictPort: false, host: '127.0.0.1' }, logLevel: 'error' });
  await server.listen();
  const addr = server.httpServer.address();
  opts.base = `http://127.0.0.1:${addr.port}`;
  console.log(`[shot] started private vite server at ${opts.base}`);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });
let errors = 0, warnings = 0;
const shots = [];
page.on('pageerror', (err) => { errors++; console.log(`[pageerror] ${err.message}\n${(err.stack ?? '').split('\n').slice(1, 4).join('\n')}`); });
page.on('console', (msg) => {
  const t = msg.type();
  if (t === 'error') { errors++; console.log(`[console.error] ${msg.text()}`); }
  else if (t === 'warning') { warnings++; if (opts.console || warnings <= 10) console.log(`[console.warn] ${msg.text()}`); }
  else if (opts.console) console.log(`[console.${t}] ${msg.text()}`);
});
const xy = (s) => s.split(',').map(Number);

try {
  for (const [kind, val] of actions) {
    switch (kind) {
      case 'url': {
        const url = /^https?:/.test(val) ? val : opts.base + (val.startsWith('/') ? val : `/${val}`);
        await page.goto(url, { waitUntil: 'load', timeout: 60000 });
        break;
      }
      case 'wait': await sleep(Number(val)); break;
      case 'wait-for': await page.waitForFunction(val, null, { timeout: 30000, polling: 250 }); break;
      case 'eval': {
        const res = await page.evaluate(`(async () => (${val}))()`);
        if (res !== undefined) console.log(`[eval] ${JSON.stringify(res)?.slice(0, 4000)}`);
        break;
      }
      case 'click': { const [x, y] = xy(val); await page.mouse.click(x, y); break; }
      case 'rclick': { const [x, y] = xy(val); await page.mouse.click(x, y, { button: 'right' }); break; }
      case 'move': { const [x, y] = xy(val); await page.mouse.move(x, y, { steps: 4 }); break; }
      case 'drag': { const [x0, y0, x1, y1] = xy(val); await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 8 }); await page.mouse.up(); break; }
      case 'key': await page.keyboard.press(val); break;
      case 'out': await page.screenshot({ path: val }); shots.push(val); console.log(`[shot] saved ${val}`); break;
    }
  }
} catch (err) {
  errors++;
  console.log(`[shot] action failed: ${err.message}`);
  try { await page.screenshot({ path: '/tmp/shot-failure.png' }); console.log('[shot] failure screenshot: /tmp/shot-failure.png'); } catch { /* ignore */ }
} finally {
  console.log(`SHOT-SUMMARY errors=${errors} warnings=${warnings} shots=${shots.join(',') || '-'}`);
  await browser.close();
  if (server) await server.close();
}
