/**
 * Wire protocol between browsers and the LAN relay (server/relay.ts). JSON text frames, one message per frame,
 * discriminated by `t`. OWNER: net. Pure types + constants: imported by the browser client AND the Node relay.
 *
 * Handshake: the client's first message must be `hello` with NET_PROTOCOL_VERSION; the relay answers `welcome`
 * (with a resume token) or closes with CLOSE_VERSION. A client that lost its socket reconnects and sends
 * `hello { resume: token }` to reclaim its room slot within the grace period.
 *
 * Everything inside `peer` is opaque to the relay: it is forwarded to the other player of the room with the
 * sender's slot stamped as `from`. Lockstep traffic (turn batches, state hashes, resync snapshots) and the
 * opponent ping travel this way.
 */
import type { FactionId, PlayerId } from '../core/types';
import type { SaveGame } from '../sim/save';
import type { ChatMessage, LobbyState, MatchStart, RoomSummary } from './types';

/** WebSocket close codes used by the relay. */
export const CLOSE_VERSION = 4001;
export const CLOSE_BAD_HELLO = 4002;
export const CLOSE_TIMEOUT = 4003;

/** Relay → client keep-alive interval; clients treat ~3 missed beats as a dead connection. */
export const HEARTBEAT_MS = 5000;
export const MAX_NAME = 24;
export const MAX_CHAT = 300;
/** generous: a meilahti resync snapshot is a few hundred KB */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const FACTION_CHOICES: readonly FactionId[] = ['hospital', 'pathogen'];

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; resume?: string }
  | { t: 'listRooms' }
  | { t: 'createRoom'; mapId: string; hostFaction: FactionId; guestFaction: FactionId }
  | { t: 'joinRoom'; roomId: string }
  | { t: 'updateRoom'; mapId?: string; hostFaction?: FactionId; guestFaction?: FactionId }
  | { t: 'setReady'; ready: boolean }
  | { t: 'startMatch' }
  | { t: 'chat'; text: string }
  | { t: 'leave' }
  /** the match reached game over (room state → 'ended') */
  | { t: 'ended' }
  | { t: 'hb' }
  | { t: 'peer'; m: PeerMsg };

export type ServerMsg =
  | { t: 'welcome'; v: number; token: string; resumed: boolean }
  | { t: 'rooms'; rooms: RoomSummary[] }
  /** your room changed; `slot` is your player slot (1 = host, 2 = guest) */
  | { t: 'lobby'; lobby: LobbyState; slot: PlayerId }
  | { t: 'roomClosed'; reason: string }
  | { t: 'chat'; msg: ChatMessage }
  /** per-recipient: localPlayerId is the recipient's slot */
  | { t: 'start'; start: MatchStart }
  | { t: 'peerLeft'; name: string; reason: 'left' | 'disconnected' | 'timeout' }
  | { t: 'peerReturned'; name: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'hb' }
  | { t: 'peer'; from: PlayerId; m: PeerMsg };

/**
 * Lockstep messages between the two clients (opaque to the relay). `mid` = MatchStart.matchId and `e` = epoch
 * scope every message to one match generation; stale ones are dropped, newer ones stashed for the next driver.
 */
export type PeerMsg =
  /** command batch of turn `k` (sent when the sender STARTS turn k − inputDelayTurns; may be empty) */
  | { t: 'turn'; mid: string; e: number; k: number; c: unknown[] }
  /** world stateHash after finishing turn `k` (world.tick === tick) */
  | { t: 'hash'; mid: string; e: number; k: number; tick: number; h: string }
  /** host → guest: restart from this snapshot as epoch `e` (start.startTick = snapshot tick) */
  | { t: 'resync'; mid: string; e: number; start: MatchStart; save: SaveGame }
  /** "I hold your batches up to turn `have`" — the receiver resends anything newer (after a reconnect) */
  | { t: 'sync'; mid: string; e: number; have: number }
  | { t: 'ping'; id: number }
  | { t: 'pong'; id: number };
