/**
 * LAN relay for IMMUNE PROTOCOL 1v1 (Node, `ws`). OWNER: net.
 *
 * Rooms + lobby state + message forwarding. It NEVER simulates: lockstep traffic (`peer` messages) is forwarded
 * verbatim to the other player of the room with the sender's slot stamped. Protocol: src/net/protocol.ts.
 *
 *  - rooms: create / list / join / leave; max 2 players; host = slot 1, guest = slot 2; ids are 4 characters
 *  - lobby: map + faction per slot (hospital/pathogen, mirror allowed) + names + ready flags; any settings
 *    change or a new guest clears the ready flags
 *  - start: host only, both connected + ready → the relay picks the seed and match id and sends each player a
 *    MatchStart (turnTicks 2, inputDelayTurns 2, startTick 0, its own localPlayerId)
 *  - liveness: ws ping frames + an app-level `hb` every 5 s; a socket that misses 3 beats is terminated.
 *    A dropped player keeps its slot for a grace period (8 s in a lobby, 90 s in a match) and can resume with
 *    its token; the other player gets peerLeft / peerReturned. Empty rooms are deleted.
 *  - protocol version check on `hello` (close 4001 with a readable reason on mismatch)
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { FactionId, PlayerId } from '../src/core/types';
import {
  CLOSE_BAD_HELLO, CLOSE_TIMEOUT, CLOSE_VERSION, FACTION_CHOICES, HEARTBEAT_MS, MAX_CHAT, MAX_FRAME_BYTES, MAX_NAME,
  type ClientMsg, type ServerMsg,
} from '../src/net/protocol.js';
import { NET_PROTOCOL_VERSION, type LobbyState, type MatchStart, type RoomSummary } from '../src/net/types.js';

export interface RelayOptions {
  heartbeatMs?: number;
  lobbyGraceMs?: number;
  gameGraceMs?: number;
  /** MatchStart defaults */
  turnTicks?: number;
  inputDelayTurns?: number;
  log?: (msg: string) => void;
}

export interface Relay {
  /** Take over an HTTP upgrade request (the caller decided it is for the relay). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Listen for upgrades on `server` for every path ending in `/lan` (other upgrades — e.g. Vite HMR — are left alone). */
  attach(server: HttpServer): () => void;
  stats(): { clients: number; rooms: number };
  close(): void;
}

/** true for `/lan`, `/code/ports/8080/lan`, `/x/lan?y` … (the page may be served under a stripped prefix) */
export function isRelayPath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0]!.replace(/\/+$/, '');
  return path === '/lan' || path.endsWith('/lan');
}

interface Member {
  client: Client | null;
  name: string;
  token: string;
  ready: boolean;
  grace: ReturnType<typeof setTimeout> | null;
}

interface Room {
  id: string;
  mapId: string;
  factions: Record<1 | 2, FactionId>;
  members: Partial<Record<1 | 2, Member>>;
  state: LobbyState['state'];
  createdAt: number;
  matchId: string | null;
}

interface Client {
  ws: WebSocket;
  name: string;
  token: string;
  hello: boolean;
  alive: boolean;
  room: Room | null;
  slot: 1 | 2 | 0;
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAP_ID_RE = /^[a-z0-9_-]{1,40}$/i;

export function createRelay(opts: RelayOptions = {}): Relay {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const lobbyGraceMs = opts.lobbyGraceMs ?? 8_000;
  const gameGraceMs = opts.gameGraceMs ?? 90_000;
  const turnTicks = opts.turnTicks ?? 2;
  const inputDelayTurns = opts.inputDelayTurns ?? 2;
  const log = opts.log ?? (() => {});

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  const clients = new Set<Client>();
  const rooms = new Map<string, Room>();
  const byToken = new Map<string, { room: Room; slot: 1 | 2 }>();
  let closed = false;

  const beat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { log(`[relay] ${c.name || '?'} missed heartbeats — dropping`); c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* closing */ }
      send(c, { t: 'hb' });
    }
  }, heartbeatMs);
  beat.unref?.();

  // ───────────────────────── helpers ─────────────────────────
  function send(c: Client | null | undefined, m: ServerMsg): void {
    if (!c || c.ws.readyState !== c.ws.OPEN) return;
    try { c.ws.send(JSON.stringify(m)); } catch { /* socket closing */ }
  }
  const err = (c: Client, code: string, message: string) => send(c, { t: 'error', code, message });

  function lobbyOf(r: Room): LobbyState {
    const players = ([1, 2] as const).flatMap((slot) => {
      const m = r.members[slot];
      return m ? [{ slot: slot as PlayerId, name: m.name, faction: r.factions[slot], ready: m.ready, connected: !!m.client }] : [];
    });
    return { roomId: r.id, mapId: r.mapId, players, state: r.state };
  }
  function broadcastLobby(r: Room): void {
    const lobby = lobbyOf(r);
    for (const slot of [1, 2] as const) { const m = r.members[slot]; if (m?.client) send(m.client, { t: 'lobby', lobby, slot }); }
  }
  function other(r: Room, slot: 1 | 2): Member | undefined { return r.members[slot === 1 ? 2 : 1]; }
  function summary(r: Room): RoomSummary {
    return {
      roomId: r.id, hostName: r.members[1]?.name ?? r.members[2]?.name ?? '?', mapId: r.mapId,
      players: (r.members[1] ? 1 : 0) + (r.members[2] ? 1 : 0), inGame: r.state === 'in-game', createdAt: r.createdAt,
    };
  }
  function refreshState(r: Room): void {
    if (r.state === 'in-game' || r.state === 'ended' || r.state === 'starting') return;
    const ms = [r.members[1], r.members[2]];
    r.state = ms.every((m) => m && m.ready && m.client) ? 'ready' : 'waiting';
  }
  function newRoomId(): string {
    for (let n = 0; n < 1000; n++) {
      let id = '';
      for (let i = 0; i < 4; i++) id += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
      if (!rooms.has(id)) return id;
    }
    return randomBytes(4).toString('hex').toUpperCase();
  }
  const faction = (v: unknown): FactionId | null => (FACTION_CHOICES as readonly unknown[]).includes(v) ? v as FactionId : null;

  /** Remove a member from its room for good (explicit leave, or the grace period expired). */
  function removeMember(r: Room, slot: 1 | 2, reason: 'left' | 'timeout'): void {
    const m = r.members[slot];
    if (!m) return;
    if (m.grace) clearTimeout(m.grace);
    byToken.delete(m.token);
    delete r.members[slot];
    if (m.client) { m.client.room = null; m.client.slot = 0; }
    const o = other(r, slot);
    if (!o) { rooms.delete(r.id); log(`[relay] room ${r.id} closed`); return; }
    if (r.state === 'in-game' || r.state === 'ended') {
      // a match can't continue without the opponent; the remaining client decides (forfeit timer)
      if (reason === 'left' || !m.client) send(o.client, { t: 'peerLeft', name: m.name, reason });
      r.state = 'ended';
      broadcastLobby(r);
      return;
    }
    if (slot === 1) {
      // the host left the lobby: close the room
      byToken.delete(o.token);
      if (o.grace) clearTimeout(o.grace);
      if (o.client) { o.client.room = null; o.client.slot = 0; send(o.client, { t: 'roomClosed', reason: `${m.name} closed the room.` }); }
      rooms.delete(r.id);
      log(`[relay] room ${r.id} closed (host left)`);
      return;
    }
    o.ready = false;
    refreshState(r);
    broadcastLobby(r);
  }

  function leaveRoom(c: Client): void {
    if (c.room && c.slot) removeMember(c.room, c.slot, 'left');
    c.room = null; c.slot = 0;
  }

  function onDisconnect(c: Client): void {
    clients.delete(c);
    const r = c.room, slot = c.slot;
    if (!r || !slot) return;
    const m = r.members[slot];
    if (!m || m.client !== c) return;
    m.client = null;
    const inMatch = r.state === 'in-game';
    const o = other(r, slot);
    if (!o?.client && !inMatch) { removeMember(r, slot, 'timeout'); return; }
    if (inMatch) send(o?.client, { t: 'peerLeft', name: m.name, reason: 'disconnected' });
    m.ready = r.state === 'in-game' ? m.ready : false;
    refreshState(r);
    broadcastLobby(r);
    m.grace = setTimeout(() => {
      m.grace = null;
      if (r.members[slot] === m && !m.client) { log(`[relay] ${m.name} did not come back to ${r.id}`); removeMember(r, slot, 'timeout'); }
    }, inMatch ? gameGraceMs : lobbyGraceMs);
    m.grace.unref?.();
  }

  // ───────────────────────── message handling ─────────────────────────
  function onMessage(c: Client, data: RawData, isBinary: boolean): void {
    if (isBinary) return;
    let m: ClientMsg;
    try { m = JSON.parse(data.toString()) as ClientMsg; } catch { err(c, 'bad-json', 'Malformed message.'); return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    c.alive = true;

    if (!c.hello) {
      if (m.t !== 'hello') { c.ws.close(CLOSE_BAD_HELLO, 'Expected hello'); return; }
      if (m.v !== NET_PROTOCOL_VERSION) {
        c.ws.close(CLOSE_VERSION, `Version mismatch: relay speaks v${NET_PROTOCOL_VERSION}, this page v${String(m.v)} — reload both pages.`);
        return;
      }
      c.hello = true;
      c.name = String(m.name ?? '').trim().slice(0, MAX_NAME) || 'Player';
      const resume = typeof m.resume === 'string' ? byToken.get(m.resume) : undefined;
      const mem = resume ? resume.room.members[resume.slot] : undefined;
      if (resume && mem && !mem.client && rooms.get(resume.room.id) === resume.room) {
        // reclaim the held slot
        if (mem.grace) { clearTimeout(mem.grace); mem.grace = null; }
        mem.client = c; c.token = mem.token; c.room = resume.room; c.slot = resume.slot;
        send(c, { t: 'welcome', v: NET_PROTOCOL_VERSION, token: c.token, resumed: true });
        const o = other(resume.room, resume.slot);
        if (resume.room.state === 'in-game') send(o?.client, { t: 'peerReturned', name: mem.name });
        refreshState(resume.room);
        broadcastLobby(resume.room);
        log(`[relay] ${mem.name} resumed ${resume.room.id}`);
      } else {
        send(c, { t: 'welcome', v: NET_PROTOCOL_VERSION, token: c.token, resumed: false });
      }
      return;
    }

    const r = c.room;
    switch (m.t) {
      case 'hello': return;
      case 'hb': return;
      case 'listRooms':
        send(c, { t: 'rooms', rooms: [...rooms.values()].filter((x) => x.state !== 'ended').map(summary).sort((a, b) => b.createdAt - a.createdAt) });
        return;
      case 'createRoom': {
        const hf = faction(m.hostFaction), gf = faction(m.guestFaction);
        if (!MAP_ID_RE.test(String(m.mapId)) || !hf || !gf) { err(c, 'bad-room', 'Invalid map or faction.'); return; }
        leaveRoom(c);
        const room: Room = {
          id: newRoomId(), mapId: String(m.mapId), factions: { 1: hf, 2: gf }, members: {}, state: 'waiting',
          createdAt: Date.now(), matchId: null,
        };
        room.members[1] = { client: c, name: c.name, token: c.token, ready: false, grace: null };
        rooms.set(room.id, room);
        byToken.set(c.token, { room, slot: 1 });
        c.room = room; c.slot = 1;
        broadcastLobby(room);
        log(`[relay] ${c.name} created room ${room.id} (${room.mapId})`);
        return;
      }
      case 'joinRoom': {
        const room = rooms.get(String(m.roomId ?? '').trim().toUpperCase());
        if (!room) { err(c, 'no-room', `Room ${String(m.roomId)} does not exist.`); return; }
        if (room === r) { broadcastLobby(room); return; }
        if (room.state === 'in-game' || room.state === 'ended') { err(c, 'in-game', 'That match is already running.'); return; }
        const free = !room.members[1] ? 1 : !room.members[2] ? 2 : 0;
        if (!free) { err(c, 'full', 'That room is full.'); return; }
        leaveRoom(c);
        room.members[free] = { client: c, name: c.name, token: c.token, ready: false, grace: null };
        byToken.set(c.token, { room, slot: free });
        c.room = room; c.slot = free;
        for (const s of [1, 2] as const) { const x = room.members[s]; if (x) x.ready = false; }
        refreshState(room);
        broadcastLobby(room);
        log(`[relay] ${c.name} joined room ${room.id}`);
        return;
      }
      case 'updateRoom': {
        if (!r) { err(c, 'no-room', 'You are not in a room.'); return; }
        if (c.slot !== 1) { err(c, 'not-host', 'Only the host can change the room settings.'); return; }
        if (r.state === 'in-game' || r.state === 'ended') { err(c, 'in-game', 'The match is already running.'); return; }
        if (m.mapId !== undefined) { if (!MAP_ID_RE.test(String(m.mapId))) { err(c, 'bad-room', 'Invalid map.'); return; } r.mapId = String(m.mapId); }
        if (m.hostFaction !== undefined) { const f = faction(m.hostFaction); if (!f) { err(c, 'bad-room', 'Invalid faction.'); return; } r.factions[1] = f; }
        if (m.guestFaction !== undefined) { const f = faction(m.guestFaction); if (!f) { err(c, 'bad-room', 'Invalid faction.'); return; } r.factions[2] = f; }
        for (const s of [1, 2] as const) { const x = r.members[s]; if (x) x.ready = false; }
        refreshState(r);
        broadcastLobby(r);
        return;
      }
      case 'setReady': {
        if (!r || !c.slot) { err(c, 'no-room', 'You are not in a room.'); return; }
        if (r.state === 'in-game' || r.state === 'ended') return;
        r.members[c.slot]!.ready = !!m.ready;
        refreshState(r);
        broadcastLobby(r);
        return;
      }
      case 'startMatch': {
        if (!r) { err(c, 'no-room', 'You are not in a room.'); return; }
        if (c.slot !== 1) { err(c, 'not-host', 'Only the host can start the match.'); return; }
        const h = r.members[1], g = r.members[2];
        if (r.state !== 'ready' || !h?.client || !g?.client || !h.ready || !g.ready) {
          err(c, 'not-ready', 'Both players must be connected and ready.'); return;
        }
        r.state = 'in-game';
        r.matchId = `${r.id}-${randomBytes(3).toString('hex')}`;
        const seed = randomInt(1, 2 ** 31 - 1);
        const base: Omit<MatchStart, 'localPlayerId'> = {
          seed, mapId: r.mapId,
          players: [
            { id: 1, faction: r.factions[1], name: h.name, team: 1 },
            { id: 2, faction: r.factions[2], name: g.name, team: 2 },
          ],
          turnTicks, inputDelayTurns, startTick: 0, matchId: r.matchId, epoch: 0,
        };
        send(h.client, { t: 'start', start: { ...base, localPlayerId: 1 } });
        send(g.client, { t: 'start', start: { ...base, localPlayerId: 2 } });
        broadcastLobby(r);
        log(`[relay] room ${r.id} started (seed ${seed}, map ${r.mapId})`);
        return;
      }
      case 'chat': {
        if (!r || !c.slot) { err(c, 'no-room', 'Join a room to chat.'); return; }
        const text = String(m.text ?? '').trim().slice(0, MAX_CHAT);
        if (!text) return;
        const msg: ServerMsg = { t: 'chat', msg: { from: c.name, slot: c.slot, text, at: Date.now() } };
        for (const s of [1, 2] as const) send(r.members[s]?.client, msg);
        return;
      }
      case 'leave': leaveRoom(c); return;
      case 'ended':
        if (r && r.state === 'in-game') { r.state = 'ended'; broadcastLobby(r); }
        return;
      case 'peer': {
        if (!r || !c.slot || !m.m || typeof m.m !== 'object') return;
        send(other(r, c.slot)?.client, { t: 'peer', from: c.slot, m: m.m });
        return;
      }
      default:
        err(c, 'unknown', `Unknown message type ${String((m as { t: unknown }).t)}.`);
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    if (closed) { ws.close(1001, 'Relay shutting down'); return; }
    const c: Client = { ws, name: '', token: randomBytes(12).toString('base64url'), hello: false, alive: true, room: null, slot: 0 };
    clients.add(c);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, isBinary) => { try { onMessage(c, data, isBinary); } catch (e) { log(`[relay] handler error ${(e as Error).message}`); } });
    ws.on('close', () => onDisconnect(c));
    ws.on('error', () => { /* close follows */ });
    // a client that never says hello is dropped
    const t = setTimeout(() => { if (!c.hello) ws.close(CLOSE_TIMEOUT, 'No hello'); }, 10_000);
    t.unref?.();
  });

  const relay: Relay = {
    handleUpgrade(req, socket, head) {
      if (closed) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    attach(server) {
      const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const proto = req.headers['sec-websocket-protocol'];
        if (proto === 'vite-hmr' || proto === 'vite-ping' || !isRelayPath(req.url)) return; // not ours
        relay.handleUpgrade(req, socket, head);
      };
      server.on('upgrade', onUpgrade);
      const onClose = () => relay.close();
      server.on('close', onClose);
      return () => { server.off('upgrade', onUpgrade); server.off('close', onClose); };
    },
    stats: () => ({ clients: clients.size, rooms: rooms.size }),
    close() {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      for (const r of rooms.values()) for (const s of [1, 2] as const) { const m = r.members[s]; if (m?.grace) clearTimeout(m.grace); }
      for (const c of clients) { try { c.ws.close(1001, 'Relay shutting down'); } catch { /* ignore */ } }
      rooms.clear(); byToken.clear();
      wss.close();
    },
  };
  return relay;
}
