/**
 * [ui] Multiplayer client state that outlives a single screen: the current relay session (it stays connected
 * while a match runs, so "Back to lobby" works), persisted lobby preferences (player name, relay address,
 * last map / factions) and where the main menu should land after a networked match.
 *
 * The session factory is injectable so the UI sandbox can drive every screen with a fake relay; the default is
 * the real LAN client from src/net.
 */
import type { FactionId } from '../../core/types';
import type { NetMatch, NetSession, MatchStart } from '../../net/types';
import { createLanSession, createNetMatch } from '../../net';

export interface MpPrefs {
  name: string;
  /** '' = same origin (defaultRelayUrl()) */
  relayUrl: string;
  mapId?: string;
  hostFaction: Exclude<FactionId, 'neutral'>;
  guestFaction: Exclude<FactionId, 'neutral'>;
}

export interface MpFactories {
  createSession(opts: { url?: string; name: string }): NetSession;
  createMatch(session: NetSession, start: MatchStart): NetMatch;
}

const PREF_KEY = 'immune-protocol.mp.v1';

let factories: MpFactories = { createSession: createLanSession, createMatch: createNetMatch };
let current: NetSession | null = null;
let returnTo: 'lobby' | 'home' | null = null;

/** Sandbox/tests: replace the relay client. */
export function setMpFactories(f: MpFactories): void { factories = f; }
export function mpFactories(): MpFactories { return factories; }

export function currentSession(): NetSession | null { return current; }
export function setCurrentSession(s: NetSession | null): void { current = s; }

/** A session that can still host / join / sit in a lobby. */
export function sessionAlive(s: NetSession | null | undefined): s is NetSession {
  return !!s && s.status !== 'closed' && s.status !== 'disconnected';
}

/** Ask the main menu to open the multiplayer page ('lobby') or the title screen ('home') next time it shows. */
export function setMenuReturn(to: 'lobby' | 'home' | null): void { returnTo = to; }
export function takeMenuReturn(): 'lobby' | 'home' | null { const r = returnTo; returnTo = null; return r; }

export function loadMpPrefs(): MpPrefs {
  const def: MpPrefs = { name: '', relayUrl: '', hostFaction: 'hospital', guestFaction: 'pathogen' };
  try {
    const p = { ...def, ...(JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Partial<MpPrefs>) };
    if (p.hostFaction !== 'hospital' && p.hostFaction !== 'pathogen') p.hostFaction = 'hospital';
    if (p.guestFaction !== 'hospital' && p.guestFaction !== 'pathogen') p.guestFaction = 'pathogen';
    p.name = String(p.name ?? '').slice(0, 24);
    p.relayUrl = String(p.relayUrl ?? '');
    return p;
  } catch { return def; }
}

export function saveMpPrefs(p: MpPrefs): void { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* ignore */ } }

/** Turn relay / transport error text into something a player can act on. */
export function friendlyNetError(message: string, url?: string): string {
  const m = message || 'Unknown network error';
  if (/full/i.test(m)) return 'That room is full — someone else joined first.';
  if (/version|protocol/i.test(m)) return 'Version mismatch — both players need the same build of the game. Reload both pages.';
  if (/not found|no such room|unknown room/i.test(m)) return 'That room no longer exists. Refresh the list.';
  if (/in[- ]?game|already started/i.test(m)) return 'That match has already started.';
  if (/unreachable|refused|failed to connect|websocket|ECONN|network/i.test(m)) return `Relay unreachable${url ? ` at ${url}` : ''}. Check the address and that the host's server is running.`;
  return m;
}
