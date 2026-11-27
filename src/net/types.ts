/**
 * LAN multiplayer contracts (1v1, deterministic lockstep). OWNER: architect.
 *
 * Model: both browsers run the full deterministic simulation. Only player commands cross the network,
 * batched into turns of `turnTicks` sim ticks and scheduled `inputDelayTurns` turns ahead. A client may run
 * a turn only when it holds BOTH players' command batches for it (empty batches are sent every turn).
 * Every few turns clients exchange world state hashes (src/sim/save stateHash) to detect desyncs; the host can
 * resync the guest from a save snapshot (src/sim/save captureMatch / restoreMatch).
 *
 * Transport: a WebSocket relay on the SAME origin/path that served the page (`<page base>/lan`), provided by
 * a Vite plugin (dev + preview servers) and by scripts/lan-server.mjs for a standalone LAN host.
 * The relay only manages rooms and forwards messages; it never runs the simulation.
 */
import type { Command, FactionId, PlayerId } from '../core/types';
import type { World } from '../sim/World';

export const NET_PROTOCOL_VERSION = 1;

export interface NetPlayerInfo { slot: PlayerId; name: string; faction: FactionId; ready: boolean; connected: boolean }

export interface RoomSummary { roomId: string; hostName: string; mapId: string; players: number; inGame: boolean; createdAt: number }

export interface LobbyState {
  roomId: string;
  mapId: string;
  /** players[0] is the host (slot 1), players[1] the guest (slot 2) once joined */
  players: NetPlayerInfo[];
  state: 'waiting' | 'ready' | 'starting' | 'in-game' | 'ended';
}

/** Everything both clients need to create identical worlds. */
export interface MatchStart {
  seed: number;
  mapId: string;
  players: Array<{ id: PlayerId; faction: FactionId; name: string; team: number }>;
  localPlayerId: PlayerId;
  turnTicks: number;          // sim ticks per lockstep turn (default 2 → 100 ms)
  inputDelayTurns: number;    // commands scheduled this many turns ahead (default 2)
  startTick: number;          // 0 for a new match; >0 after a resync from a snapshot
}

export interface ChatMessage { from: string; slot: PlayerId | 0; text: string; at: number }

export type NetStatus = 'connecting' | 'connected' | 'lobby' | 'in-game' | 'reconnecting' | 'disconnected' | 'closed';

export interface NetEvents {
  status: NetStatus;
  lobby: LobbyState;
  rooms: RoomSummary[];
  chat: ChatMessage;
  start: MatchStart;
  /** opponent left / connection lost mid-match (UI offers to wait or quit; forfeit after a timeout) */
  opponentLeft: { name: string; reason: string };
  desync: { tick: number; localHash: string; remoteHash: string; resyncing: boolean };
  error: { message: string };
}

/** The connection to the relay + one room. UI-facing (lobby, chat, status). */
export interface NetSession {
  readonly status: NetStatus;
  readonly name: string;
  readonly role: 'host' | 'guest' | null;
  readonly lobby: LobbyState | null;
  /** round-trip time to the opponent (via relay), ms; NaN when unknown */
  readonly pingMs: number;
  listRooms(): void;                                   // answer arrives as a 'rooms' event
  createRoom(opts: { mapId: string; hostFaction: FactionId; guestFaction: FactionId }): void;
  joinRoom(roomId: string): void;
  /** host only: change map / factions while waiting */
  updateRoom(opts: { mapId?: string; hostFaction?: FactionId; guestFaction?: FactionId }): void;
  setReady(ready: boolean): void;
  /** host only, when both are ready: picks the seed and broadcasts 'start' */
  startMatch(): void;
  sendChat(text: string): void;
  leave(): void;
  on<K extends keyof NetEvents>(type: K, fn: (e: NetEvents[K]) => void): () => void;
}

/** Drives the Game loop in multiplayer (implemented in src/net/lockstep.ts). */
export interface LockstepDriver {
  /** Called once per frame: how many sim ticks may run now (0 while waiting for the opponent's turn data). */
  ticksReady(dtReal: number): number;
  /** Call immediately before each world.step(): issues every command scheduled for world.tick (both players)
   *  through world.issue, in a deterministic order (by player slot, then submission order). */
  beforeTick(world: World): void;
  /** Call right after each world.step(): turn bookkeeping, sending empty batches, desync hashing. */
  afterTick(world: World): void;
  /** Queue a local command (it executes on both clients at a future tick). */
  submit(cmd: Command): void;
  /** Non-null while the simulation is stalled, e.g. 'Waiting for Aino…' (HUD shows an overlay). */
  readonly waitingReason: string | null;
  dispose(): void;
}

/** What App/Game receive to run a networked match (LaunchConfig.net). */
export interface NetMatch {
  readonly start: MatchStart;
  readonly session: NetSession;
  readonly lockstep: LockstepDriver;
}

/** Relay URL for the page that is currently loaded (works behind path-prefix proxies). */
export function defaultRelayUrl(): string {
  const base = new URL('lan', document.baseURI);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return base.toString();
}
