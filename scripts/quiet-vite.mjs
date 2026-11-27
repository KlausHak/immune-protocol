#!/usr/bin/env node
/**
 * Private Vite dev server WITHOUT HMR or file watching, so other agents' edits don't full-reload your page
 * mid-boot (the shared :5173 server reloads every open page on each save).
 *   node scripts/quiet-vite.mjs 5190 &        # then: node scripts/shot.mjs --base http://127.0.0.1:5190 --url ...
 * Note: no watching → restart it to pick up newer code. (Adapted from the audio engineer's helper.)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createServer } = await import('vite');
const port = Number(process.argv[2] ?? 5190);
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
console.log(`quiet vite on http://127.0.0.1:${port}`);
