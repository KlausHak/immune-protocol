/**
 * Vite plugin: serves the LAN relay (server/relay.ts) from the dev AND preview servers. OWNER: net.
 * Every HTTP upgrade whose path ends in `/lan` goes to the relay — so it also works when the page is served
 * under a path prefix that a proxy strips or forwards (e.g. https://<cloudfront>/code/ports/<port>/lan).
 * Vite's own HMR websocket (sec-websocket-protocol vite-hmr) is left alone.
 */
import type { Server as HttpServer } from 'node:http';
import type { Plugin } from 'vite';
import { createRelay, type Relay, type RelayOptions } from './relay.js';

export function lanRelayPlugin(opts: RelayOptions & { quiet?: boolean } = {}): Plugin {
  const relays: Relay[] = [];
  const log = opts.log ?? (opts.quiet || process.env.LAN_QUIET ? () => {} : (m: string) => console.log(m));
  const install = (httpServer: HttpServer | null | undefined) => {
    if (!httpServer) return; // middleware mode (e.g. vitest): no HTTP server to attach to
    const relay = createRelay({ ...opts, log });
    relay.attach(httpServer);
    relays.push(relay);
  };
  return {
    name: 'immune-protocol-lan-relay',
    configureServer(server) { install(server.httpServer as HttpServer | null); },
    configurePreviewServer(server) { install(server.httpServer as HttpServer); },
  };
}
