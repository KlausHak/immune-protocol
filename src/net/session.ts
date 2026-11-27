/**
 * LanSession: the browser's connection to the LAN relay (lobby, chat, ping) + the GameChannel the lockstep
 * driver talks through. OWNER: net.
 *
 * Robustness: a lost socket (relay restart, Wi-Fi blip, laptop sleep) flips status to 'reconnecting' and
 * retries with backoff (0.5 s → 5 s, forever; 'disconnected' after ~15 s of failures). On reconnect the session
 * sends its resume token; the relay hands back the same room slot if it still holds it (8 s grace in a lobby,
 * 90 s in a match), otherwise the room is gone ('roomClosed' + 'error', and 'opponentLeft' if a match was running).
 * Lobby requests made while (re)connecting are queued and sent after the handshake; peer (lockstep) traffic is
 * dropped while down and recovered by the drivers' `sync` exchange.
 *
 * Works in Node too (tests): pass a WebSocket implementation (e.g. the `ws` package) as `WebSocketImpl`.
 */
import type { FactionId, PlayerId } from '../core/types';
import { ChannelBase } from './channel';
import {
  CLOSE_BAD_HELLO, CLOSE_VERSION, HEARTBEAT_MS, MAX_CHAT, MAX_NAME,
  type ClientMsg, type PeerMsg, type ServerMsg,
} from './protocol';
import {
  NET_PROTOCOL_VERSION, defaultRelayUrl,
  type LobbyState, type MatchStart, type NetEvents, type NetSession, type NetStatus,
} from './types';

/** Minimal WebSocket surface shared by the browser and the `ws` package. */
interface WsLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WsLike;

export interface LanSessionOptions {
  url?: string;
  name: string;
  WebSocketImpl?: WebSocketCtor;
  /** opponent ping interval, ms (default 2000) */
  pingIntervalMs?: number;
}

const OPEN = 1;
const PING_EWMA = 0.3;

type Listener<K extends keyof NetEvents> = (e: NetEvents[K]) => void;

/** The session's GameChannel (lockstep ↔ relay). */
class SessionChannel extends ChannelBase {
  constructor(private s: LanSession) { super(); }
  send(m: PeerMsg): void { this.s.sendPeer(m); }
  emitDesync(e: NetEvents['desync']): void { this.s.emitEvent('desync', e); }
  emitError(message: string): void { this.s.emitEvent('error', { message }); }
  ended(): void { this.s.sendRaw({ t: 'ended' }); }
  get connected(): boolean { return this.s.isOpen; }
  get pingMs(): number { return this.s.pingMs; }
}

export class LanSession implements NetSession {
  readonly name: string;
  readonly url: string;
  readonly channel: SessionChannel;
  private _status: NetStatus = 'connecting';
  private _role: 'host' | 'guest' | null = null;
  private _lobby: LobbyState | null = null;
  private _ping = Number.NaN;
  private slot: PlayerId | 0 = 0;
  private match: MatchStart | null = null;
  private ws: WsLike | null = null;
  private welcomed = false;
  private token: string | null = null;
  private outbox: ClientMsg[] = [];
  private listeners = new Map<keyof NetEvents, Set<(e: never) => void>>();
  private closed = false;
  private attempts = 0;
  private everConnected = false;
  private lastRecv = 0;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingSeq = 0;
  private pingsOut = new Map<number, number>();
  private readonly WS: WebSocketCtor;

  constructor(opts: LanSessionOptions) {
    this.name = (opts.name || 'Player').trim().slice(0, MAX_NAME) || 'Player';
    this.url = opts.url ?? defaultRelayUrl();
    const impl = opts.WebSocketImpl ?? (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!impl) throw new Error('No WebSocket implementation available');
    this.WS = impl;
    this.channel = new SessionChannel(this);
    const pingEvery = opts.pingIntervalMs ?? 2000;
    this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.pingOpponent(), pingEvery));
    this.connect();
  }

  // ───────────────────────── NetSession ─────────────────────────
  get status(): NetStatus { return this._status; }
  get role(): 'host' | 'guest' | null { return this._role; }
  get lobby(): LobbyState | null { return this._lobby; }
  get pingMs(): number { return this._ping; }
  /** our player slot in the room (1 = host, 2 = guest), 0 outside a room */
  get localSlot(): PlayerId | 0 { return this.slot; }
  get isOpen(): boolean { return !!this.ws && this.ws.readyState === OPEN && this.welcomed; }

  listRooms(): void { this.request({ t: 'listRooms' }); }
  createRoom(opts: { mapId: string; hostFaction: FactionId; guestFaction: FactionId }): void {
    this.request({ t: 'createRoom', mapId: opts.mapId, hostFaction: opts.hostFaction, guestFaction: opts.guestFaction });
  }
  joinRoom(roomId: string): void { this.request({ t: 'joinRoom', roomId: String(roomId).trim().toUpperCase() }); }
  updateRoom(opts: { mapId?: string; hostFaction?: FactionId; guestFaction?: FactionId }): void {
    if (this._role !== 'host') { this.emitEvent('error', { message: 'Only the host can change the room settings.' }); return; }
    this.request({ t: 'updateRoom', ...opts });
  }
  /** (the relay answers with an error if we are not in a room — e.g. a join still in flight that failed) */
  setReady(ready: boolean): void { this.request({ t: 'setReady', ready: !!ready }); }
  startMatch(): void {
    const l = this._lobby;
    if (this._role !== 'host' || !l) { this.emitEvent('error', { message: 'Only the host can start the match.' }); return; }
    if (l.players.length < 2 || !l.players.every((p) => p.ready && p.connected)) {
      this.emitEvent('error', { message: 'Both players must be connected and ready.' }); return;
    }
    this.request({ t: 'startMatch' });
  }
  sendChat(text: string): void {
    const t = String(text ?? '').trim().slice(0, MAX_CHAT);
    if (!t) return;
    if (!this._lobby) { this.emitEvent('error', { message: 'Join a room to chat.' }); return; }
    this.request({ t: 'chat', text: t });
  }
  leave(): void {
    if (this._lobby || this.match) this.request({ t: 'leave' });
    this.clearRoom();
    if (!this.closed) this.setStatus(this.isOpen ? 'connected' : this._status);
  }
  close(): void {
    if (this.closed) return;
    if (this._lobby && this.isOpen) this.sendRaw({ t: 'leave' });
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws; this.ws = null;
    try { ws?.close(1000, 'bye'); } catch { /* ignore */ }
    this.clearRoom();
    this.setStatus('closed');
  }

  on<K extends keyof NetEvents>(type: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(fn as (e: never) => void);
    return () => { set!.delete(fn as (e: never) => void); };
  }

  // ───────────────────────── internals (also used by SessionChannel) ─────────────────────────
  emitEvent<K extends keyof NetEvents>(type: K, e: NetEvents[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { (fn as Listener<K>)(e); } catch (err) { console.error(`[net] '${String(type)}' listener threw`, err); }
    }
  }

  sendRaw(m: ClientMsg): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN || (!this.welcomed && m.t !== 'hello')) return false;
    try { ws.send(JSON.stringify(m)); return true; } catch { return false; }
  }

  sendPeer(m: PeerMsg): void { this.sendRaw({ t: 'peer', m }); }

  /** lobby-level request: sent now, or queued until the (re)connection handshake completes */
  private request(m: ClientMsg): void {
    if (this.closed) { this.emitEvent('error', { message: 'The LAN session is closed.' }); return; }
    if (!this.sendRaw(m)) { if (this.outbox.length < 50) this.outbox.push(m); }
  }

  private setStatus(s: NetStatus): void {
    if (s === this._status) return;
    this._status = s;
    this.emitEvent('status', s);
  }

  private clearRoom(): void {
    this._lobby = null; this._role = null; this.slot = 0; this.match = null;
    this._ping = Number.NaN; this.pingsOut.clear();
  }

  private connect(): void {
    if (this.closed) return;
    this.welcomed = false;
    let ws: WsLike;
    try {
      ws = new this.WS(this.url);
    } catch (err) {
      this.emitEvent('error', { message: `Invalid relay URL ${this.url}: ${(err as Error).message}` });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.lastRecv = Date.now();
      ws.send(JSON.stringify({ t: 'hello', v: NET_PROTOCOL_VERSION, name: this.name, resume: this.token ?? undefined } satisfies ClientMsg));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastRecv = Date.now();
      let msg: ServerMsg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as ServerMsg; } catch { return; }
      try { this.handle(msg); } catch (err) { console.error('[net] message handler failed', msg.t, err); }
    };
    ws.onerror = () => { /* onclose follows with the details */ };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.welcomed = false;
      if (this.closed) return;
      if (ev.code === CLOSE_VERSION || ev.code === CLOSE_BAD_HELLO) {
        this.emitEvent('error', { message: ev.reason || 'The relay rejected this client (protocol version mismatch) — reload the page.' });
        this.closed = true;
        for (const t of this.timers) clearInterval(t);
        this.clearRoom();
        this.setStatus('closed');
        return;
      }
      if (!this.everConnected && this.attempts === 0) {
        this.emitEvent('error', { message: `Could not reach the LAN relay at ${this.url}. Is the host's server running?` });
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.attempts++;
    this.setStatus(this.attempts > 6 ? 'disconnected' : this.everConnected ? 'reconnecting' : 'connecting');
    const delay = Math.min(5000, 500 * 2 ** Math.min(this.attempts - 1, 4));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  private heartbeat(): void {
    if (this.closed || !this.ws) return;
    if (this.ws.readyState === OPEN) {
      this.sendRaw({ t: 'hb' });
      // the relay beats every HEARTBEAT_MS; silence for 3 beats = dead link (e.g. the host's laptop slept)
      if (Date.now() - this.lastRecv > HEARTBEAT_MS * 3) { try { this.ws.close(4000, 'heartbeat timeout'); } catch { /* ignore */ } this.forceDrop(); }
    }
  }

  /** treat the current socket as dead right away (close events can lag behind on a half-open TCP link) */
  private forceDrop(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null; this.welcomed = false;
    ws.onclose = null; ws.onmessage = null;
    this.scheduleReconnect();
  }

  private pingOpponent(): void {
    const l = this._lobby;
    if (!this.isOpen || !l || l.players.length < 2 || !l.players.every((p) => p.connected)) return;
    const id = ++this.pingSeq;
    this.pingsOut.set(id, nowMs());
    if (this.pingsOut.size > 10) this.pingsOut.delete(this.pingsOut.keys().next().value!);
    this.sendPeer({ t: 'ping', id });
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome': {
        const hadRoom = !!this._lobby;
        const wasInGame = !!this.match;
        this.welcomed = true;
        this.everConnected = true;
        this.attempts = 0;
        this.token = msg.token;
        if (msg.resumed) {
          this.setStatus(wasInGame ? 'in-game' : hadRoom ? 'lobby' : 'connected');
          if (wasInGame) this.channel.peerEvent({ type: 'resumed' });
        } else {
          if (hadRoom) {
            const opp = this._lobby?.players.find((p) => p.slot !== this.slot)?.name ?? 'Opponent';
            this.clearRoom();
            const reason = 'Connection to the relay was lost and the room no longer exists (the relay may have restarted).';
            this.emitEvent('roomClosed', { reason });
            this.emitEvent('error', { message: reason });
            if (wasInGame) {
              this.emitEvent('opponentLeft', { name: opp, reason: 'relay connection lost' });
              this.channel.peerEvent({ type: 'left', name: opp, reason: 'disconnected' });
            }
          }
          this.setStatus('connected');
        }
        const queued = this.outbox; this.outbox = [];
        for (const m of queued) this.sendRaw(m);
        return;
      }
      case 'rooms': this.emitEvent('rooms', msg.rooms); return;
      case 'lobby': {
        this._lobby = msg.lobby;
        this.slot = msg.slot;
        this._role = msg.slot === 1 ? 'host' : 'guest';
        if (msg.lobby.state !== 'in-game' && msg.lobby.state !== 'ended') this.match = null;
        this.setStatus(this.match ? 'in-game' : 'lobby');
        this.emitEvent('lobby', msg.lobby);
        return;
      }
      case 'roomClosed':
        this.clearRoom();
        this.setStatus('connected');
        this.emitEvent('roomClosed', { reason: msg.reason });
        this.emitEvent('error', { message: msg.reason });
        return;
      case 'chat': this.emitEvent('chat', msg.msg); return;
      case 'start':
        this.match = msg.start;
        this.channel.reset();
        this.setStatus('in-game');
        this.emitEvent('start', msg.start);
        return;
      case 'peerLeft':
        this.emitEvent('opponentLeft', { name: msg.name, reason: msg.reason });
        this.channel.peerEvent({ type: 'left', name: msg.name, reason: msg.reason });
        return;
      case 'peerReturned':
        this.emitEvent('opponentReturned', { name: msg.name });
        this.channel.peerEvent({ type: 'returned', name: msg.name });
        return;
      case 'error': this.emitEvent('error', { message: msg.message }); return;
      case 'hb': return;
      case 'peer': {
        const m = msg.m;
        if (!m || typeof m !== 'object') return;
        if (m.t === 'ping') { this.sendPeer({ t: 'pong', id: m.id }); return; }
        if (m.t === 'pong') {
          const t0 = this.pingsOut.get(m.id);
          if (t0 !== undefined) {
            this.pingsOut.delete(m.id);
            const rtt = nowMs() - t0;
            this._ping = Number.isNaN(this._ping) ? rtt : this._ping + (rtt - this._ping) * PING_EWMA;
          }
          return;
        }
        this.channel.deliver(m);
        return;
      }
    }
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
