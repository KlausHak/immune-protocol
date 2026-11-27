/**
 * LAN multiplayer — public API. OWNER: net.
 *   createLanSession({ name, url? }) → NetSession   (url defaults to defaultRelayUrl(): <page base>/lan)
 *   createNetMatch(session, start)   → NetMatch     (call on the session's 'start' event, then
 *                                                    app.startGame({ mode: 'multiplayer', difficulty: 'normal', net }))
 * Debug/testing handle in the browser: window.__net = { createLanSession, createNetMatch, sessions }.
 */
import { createNetMatch } from './match';
import { LanSession } from './session';
import type { NetSession } from './types';

export * from './types';
export { createNetMatch, channelOf } from './match';
export { Lockstep, type LockstepOptions } from './lockstep';
export { LanSession, type LanSessionOptions } from './session';
export { sanitizeCommand, sanitizeBatch } from './validate';

const sessions: NetSession[] = [];

export function createLanSession(opts: { url?: string; name: string }): NetSession {
  const s = new LanSession({ url: opts.url, name: opts.name });
  sessions.push(s);
  if (sessions.length > 8) sessions.shift();
  return s;
}

if (typeof window !== 'undefined') {
  (window as unknown as { __net?: unknown }).__net = { createLanSession, createNetMatch, sessions };
}
