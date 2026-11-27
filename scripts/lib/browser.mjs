/**
 * [qa] Shared browser plumbing for scripts/smoke.mjs and scripts/perf.mjs.
 * Same Chromium flags as scripts/shot.mjs (WebGL via SwiftShader) and the same dev-server fallback:
 * if nothing answers at `base`, a private Vite dev server is started for the session.
 */
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--no-sandbox'];

export async function reachable(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; }
}

/**
 * Resolve a usable base URL; starts a private Vite server when `base` is down (like shot.mjs) or when
 * `forcePrivate` is set. A forced private server has HMR and file watching OFF, so other developers saving
 * files can't full-reload the page mid-measurement (the shared server at :5173 reloads on every save).
 * Returns { base, close, privateServer }.
 */
export async function ensureServer(base, log = console.log, { forcePrivate = false } = {}) {
  if (!forcePrivate && (await reachable(base))) return { base, privateServer: false, close: async () => {} };
  const { createServer } = await import('vite');
  const server = await createServer({
    root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1', ...(forcePrivate ? { hmr: false, watch: { ignored: ['**/*'] } } : {}) },
  });
  await server.listen();
  const addr = server.httpServer.address();
  const url = `http://127.0.0.1:${addr.port}`;
  log(forcePrivate ? `[browser] started private vite server (no HMR) at ${url}` : `[browser] ${base} unreachable — started private vite server at ${url}`);
  return { base: url, privateServer: true, close: () => server.close() };
}

/** Count main-frame loads (Vite HMR full reloads show up as extra loads). */
export function trackLoads(page) {
  const t = { loads: 0 };
  page.on('load', () => { t.loads++; });
  return t;
}

export async function launch({ width = 1600, height = 900 } = {}) {
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  const page = await browser.newPage({ viewport: { width, height } });
  return { browser, page };
}

/**
 * Collect page errors, console errors/warnings and failed same-origin requests.
 * `phase` lets callers attribute errors to steps ("menu", "skirmish", "campaign").
 */
export function collectErrors(page, base, opts = {}) {
  const out = { phase: 'init', pageErrors: [], consoleErrors: [], consoleWarnings: 0, warningSamples: [], badResponses: [], echo: opts.echo ?? true };
  const origin = new URL(base).origin;
  page.on('pageerror', (err) => {
    const e = { phase: out.phase, message: err.message, stack: (err.stack ?? '').split('\n').slice(1, 5).map((s) => s.trim()) };
    out.pageErrors.push(e);
    if (out.echo) console.log(`[pageerror:${out.phase}] ${err.message}\n  ${e.stack.join('\n  ')}`);
  });
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error') {
      const loc = msg.location();
      const e = { phase: out.phase, text: msg.text().slice(0, 2000), at: loc?.url ? `${loc.url.replace(origin, '')}:${loc.lineNumber}` : '' };
      out.consoleErrors.push(e);
      if (out.echo) console.log(`[console.error:${out.phase}] ${e.text}${e.at ? ` (${e.at})` : ''}`);
    } else if (t === 'warning') {
      out.consoleWarnings++;
      if (out.warningSamples.length < 15) out.warningSamples.push(`[${out.phase}] ${msg.text().slice(0, 300)}`);
    }
  });
  page.on('response', (res) => {
    const u = res.url();
    if (!u.startsWith(origin) || res.status() < 400 || /favicon\.ico$/.test(u)) return;
    out.badResponses.push({ phase: out.phase, status: res.status(), url: u.replace(origin, '') });
    if (out.echo) console.log(`[http ${res.status()}:${out.phase}] ${u.replace(origin, '')}`);
  });
  // Requests cancelled by a navigation / HMR full reload (net::ERR_ABORTED) are not errors; other network
  // failures are kept as warnings (the HTTP status of real responses is what fails a run).
  out.abortedRequests = 0;
  out.failedRequests = [];
  page.on('requestfailed', (req) => {
    const u = req.url();
    if (!u.startsWith(origin)) return;
    const err = req.failure()?.errorText ?? '';
    if (/ERR_ABORTED/.test(err)) { out.abortedRequests++; return; }
    if (out.failedRequests.length < 30) out.failedRequests.push({ phase: out.phase, url: u.replace(origin, ''), error: err });
  });
  return out;
}

export function parseArgs(argv, defaults, { flags = [] } = {}) {
  const o = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { console.error(`unexpected argument ${a}`); process.exit(2); }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (flags.includes(key)) { o[key] = true; continue; }
    if (key.startsWith('no') && flags.includes(key[2].toLowerCase() + key.slice(3))) { o[key[2].toLowerCase() + key.slice(3)] = false; continue; }
    if (!(key in defaults)) { console.error(`unknown option ${a}`); process.exit(2); }
    const v = argv[++i];
    o[key] = typeof defaults[key] === 'number' ? Number(v) : v;
  }
  return o;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a page expression until truthy; returns the value or null on timeout (never throws on timeout). */
export async function waitFor(page, expr, timeoutMs = 20000, pollMs = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(expr); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

export function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
export const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
export const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
