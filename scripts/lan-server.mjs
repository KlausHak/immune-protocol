#!/usr/bin/env node
/**
 * [net] Standalone LAN host for IMMUNE PROTOCOL 1v1:  npm run lan  [-- --port 8080 --host 0.0.0.0 --rebuild | --no-build]
 *
 * Builds the game with relative asset URLs (`vite build --base ./`, so it also works under a path prefix such
 * as the IDE proxy https://<cloudfront>/code/ports/<port>/), or reuses an existing relative build in dist/,
 * then serves dist/ plus the WebSocket relay (any path ending in /lan) on 0.0.0.0:<port> via `vite preview`
 * (the relay is the lanRelayPlugin registered in vite.config.ts). Prints the LAN URLs to share.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opts = { port: 8080, host: '0.0.0.0', build: 'auto' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opts.port = Number(argv[++i]);
  else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
  else if (a === '--host') opts.host = argv[++i];
  else if (a === '--rebuild') opts.build = 'always';
  else if (a === '--no-build') opts.build = 'never';
  else if (a === '--help' || a === '-h') {
    console.log('usage: node scripts/lan-server.mjs [--port 8080] [--host 0.0.0.0] [--rebuild | --no-build]');
    process.exit(0);
  } else { console.error(`unknown argument ${a}`); process.exit(2); }
}
if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) { console.error('invalid --port'); process.exit(2); }

const dist = path.join(root, 'dist');
const indexHtml = path.join(dist, 'index.html');
/** a build made with --base ./ references its assets relatively */
function relativeBuildPresent() {
  try { return /(src|href)="\.\/assets\//.test(fs.readFileSync(indexHtml, 'utf8')); } catch { return false; }
}

const { build, preview } = await import('vite');
const configFile = path.join(root, 'vite.config.ts');

if (opts.build === 'always' || (opts.build === 'auto' && !relativeBuildPresent())) {
  console.log('[lan] building the game (vite build --base ./) …');
  const t0 = Date.now();
  await build({ root, configFile, base: './', logLevel: 'warn' });
  console.log(`[lan] build done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} else if (!fs.existsSync(indexHtml)) {
  console.error('[lan] dist/ is missing — run without --no-build'); process.exit(1);
} else {
  console.log('[lan] reusing the existing build in dist/ (use --rebuild after code changes)');
}

const server = await preview({
  root, configFile, base: './', logLevel: 'warn',
  preview: { port: opts.port, host: opts.host, strictPort: true, allowedHosts: true, open: false },
});

const lan = [];
for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
  for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) lan.push({ name, url: `http://${a.address}:${opts.port}/` });
}
console.log('');
console.log('  IMMUNE PROTOCOL — LAN server running (game + relay)');
console.log(`    this machine:  http://localhost:${opts.port}/`);
for (const l of lan) console.log(`    LAN (${l.name}):`.padEnd(18) + ` ${l.url}`);
if (!lan.length) console.log('    (no LAN interface found — check your network connection)');
console.log('');
console.log('  Share a LAN URL with the other player: both open it → Multiplayer → one hosts, the other joins.');
console.log(`  Relay endpoint: ws://<address>:${opts.port}/lan   (also works under a proxy prefix, e.g. /code/ports/${opts.port}/lan)`);
console.log('  Ctrl+C to stop.');

const stop = async () => { await server.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
