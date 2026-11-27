/**
 * Relay server on a real localhost port: handshake/version check, rooms, ready/start, forwarding, chat,
 * disconnect notification + resume, cleanup. Plus the browser LanSession client (with the `ws` WebSocket) against
 * it, a relay restart, and two lockstep clients with headless worlds playing over the real relay.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createRelay, isRelayPath, type Relay } from '../../server/relay';
import { createNetMatch } from '../../src/net/match';
import type { ServerMsg } from '../../src/net/protocol';
import { LanSession, type WebSocketCtor } from '../../src/net/session';
import { NET_PROTOCOL_VERSION, type MatchStart, type NetEvents, type NetSession } from '../../src/net/types';
import { stateHash } from '../../src/sim/save';
import { makeWorld } from './helpers';

interface Srv { relay: Relay; server: http.Server; url: string; port: number }
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

async function startRelay(port = 0, opts: Parameters<typeof createRelay>[0] = {}): Promise<Srv> {
  const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  const relay = createRelay(opts);
  relay.attach(server);
  await new Promise<void>((res) => server.listen(port, '127.0.0.1', res));
  const p = (server.address() as AddressInfo).port;
  const srv = { relay, server, port: p, url: `ws://127.0.0.1:${p}/some/prefix/lan` };
  cleanup.push(() => stopRelay(srv));
  return srv;
}
async function stopRelay(s: Srv): Promise<void> {
  s.relay.close();
  s.server.closeAllConnections?.();
  await new Promise<void>((res) => s.server.close(() => res()));
}

/** raw protocol client */
class Raw {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => { this.msgs.push(JSON.parse(d.toString()) as ServerMsg); this.poke(); });
    this.ws.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; this.poke(); });
    this.ws.on('error', () => {});
    cleanup.push(() => this.ws.terminate());
  }
  private poke() { for (const w of this.waiters.splice(0)) w(); }
  async open() { if (this.ws.readyState !== WebSocket.OPEN) await new Promise((r) => this.ws.once('open', r)); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  async next<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 3000): Promise<Extract<ServerMsg, { t: T }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.msgs.findIndex((m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>));
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for ${t}; got ${JSON.stringify(this.msgs.map((m) => m.t))}`);
      await new Promise<void>((r) => { const to = setTimeout(r, left); this.waiters.push(() => { clearTimeout(to); r(); }); });
    }
  }
  async hello(name: string, resume?: string) {
    await this.open();
    this.send({ t: 'hello', v: NET_PROTOCOL_VERSION, name, resume });
    return this.next('welcome');
  }
}

async function lobbyPair(s: Srv) {
  const h = new Raw(s.url), g = new Raw(s.url);
  const hw = await h.hello('Aino'), gw = await g.hello('Joonas');
  h.send({ t: 'createRoom', mapId: 'test', hostFaction: 'hospital', guestFaction: 'pathogen' });
  const { lobby } = await h.next('lobby');
  g.send({ t: 'joinRoom', roomId: lobby.roomId.toLowerCase() });
  await g.next('lobby', (m) => m.lobby.players.length === 2);
  await h.next('lobby', (m) => m.lobby.players.length === 2);
  return { h, g, roomId: lobby.roomId, hw, gw };
}
async function startPair(s: Srv) {
  const p = await lobbyPair(s);
  p.h.send({ t: 'setReady', ready: true });
  p.g.send({ t: 'setReady', ready: true });
  await p.h.next('lobby', (m) => m.lobby.state === 'ready');
  p.h.send({ t: 'startMatch' });
  const hs = (await p.h.next('start')).start, gs = (await p.g.next('start')).start;
  return { ...p, hs, gs };
}

const until = async (f: () => boolean, ms = 5000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`timeout: ${what}`); await new Promise((r) => setTimeout(r, 10)); }
};

describe('relay server', () => {
  it('matches relay paths under any prefix', () => {
    expect(isRelayPath('/lan')).toBe(true);
    expect(isRelayPath('/code/ports/8080/lan')).toBe(true);
    expect(isRelayPath('/x/lan/?a=1')).toBe(true);
    expect(isRelayPath('/')).toBe(false);
    expect(isRelayPath('/plan')).toBe(false);
    expect(isRelayPath('/lan/x')).toBe(false);
  });

  it('rejects a protocol version mismatch with a readable close reason', async () => {
    const s = await startRelay();
    const c = new Raw(s.url);
    await c.open();
    c.send({ t: 'hello', v: 999, name: 'x' });
    await until(() => !!c.closed);
    expect(c.closed!.code).toBe(4001);
    expect(c.closed!.reason).toMatch(/Version mismatch/);
  });

  it('rooms: create, list, join (max 2), host-only settings, ready → start with MatchStart', async () => {
    const s = await startRelay();
    const { h, g, roomId } = await lobbyPair(s);
    const third = new Raw(s.url);
    await third.hello('Leena');
    third.send({ t: 'listRooms' });
    const { rooms } = await third.next('rooms');
    expect(rooms).toEqual([expect.objectContaining({ roomId, hostName: 'Aino', mapId: 'test', players: 2, inGame: false })]);
    third.send({ t: 'joinRoom', roomId });
    expect((await third.next('error')).code).toBe('full');

    g.send({ t: 'updateRoom', mapId: 'meilahti' });
    expect((await g.next('error')).code).toBe('not-host');
    g.send({ t: 'startMatch' });
    expect((await g.next('error')).code).toBe('not-host');
    h.send({ t: 'startMatch' });
    expect((await h.next('error')).code).toBe('not-ready');

    h.send({ t: 'updateRoom', guestFaction: 'hospital' }); // mirror match allowed
    const l = await g.next('lobby', (m) => m.lobby.players[1]?.faction === 'hospital');
    expect(l.slot).toBe(2);
    expect(l.lobby.players.map((p) => [p.slot, p.name, p.faction, p.ready, p.connected])).toEqual([[1, 'Aino', 'hospital', false, true], [2, 'Joonas', 'hospital', false, true]]);

    h.send({ t: 'setReady', ready: true });
    g.send({ t: 'setReady', ready: true });
    await h.next('lobby', (m) => m.lobby.state === 'ready');
    h.send({ t: 'startMatch' });
    const hs = (await h.next('start')).start, gs = (await g.next('start')).start;
    expect(hs.localPlayerId).toBe(1);
    expect(gs.localPlayerId).toBe(2);
    expect({ ...gs, localPlayerId: 1 }).toEqual(hs);
    expect(hs).toMatchObject({ mapId: 'test', turnTicks: 2, inputDelayTurns: 2, startTick: 0, epoch: 0 });
    expect(hs.players).toEqual([{ id: 1, faction: 'hospital', name: 'Aino', team: 1 }, { id: 2, faction: 'hospital', name: 'Joonas', team: 2 }]);
    expect(Number.isInteger(hs.seed)).toBe(true);
    expect(hs.matchId).toMatch(new RegExp(`^${roomId}-`));
    await g.next('lobby', (m) => m.lobby.state === 'in-game');
    third.send({ t: 'joinRoom', roomId });
    expect((await third.next('error')).code).toBe('in-game');
  });

  it('forwards peer messages (sender slot stamped) and broadcasts chat', async () => {
    const s = await startRelay();
    const { h, g } = await startPair(s);
    h.send({ t: 'peer', m: { t: 'turn', mid: 'x', e: 0, k: 2, c: [] } });
    expect(await g.next('peer')).toEqual({ t: 'peer', from: 1, m: { t: 'turn', mid: 'x', e: 0, k: 2, c: [] } });
    g.send({ t: 'peer', m: { t: 'hash', mid: 'x', e: 0, k: 9, tick: 20, h: 'abc' } });
    expect((await h.next('peer')).from).toBe(2);
    g.send({ t: 'chat', text: '  gl hf  ' });
    for (const c of [h, g]) expect((await c.next('chat')).msg).toMatchObject({ from: 'Joonas', slot: 2, text: 'gl hf' });
  });

  it('notifies the opponent of a disconnect, holds the slot, and lets the player resume', async () => {
    const s = await startRelay();
    const { h, g, gw } = await startPair(s);
    g.ws.terminate();
    expect(await h.next('peerLeft')).toEqual({ t: 'peerLeft', name: 'Joonas', reason: 'disconnected' });
    expect((await h.next('lobby', (m) => m.lobby.players[1]?.connected === false)).lobby.state).toBe('in-game');
    const g2 = new Raw(s.url);
    const w = await g2.hello('Joonas', gw.token);
    expect(w.resumed).toBe(true);
    expect((await g2.next('lobby')).slot).toBe(2);
    expect(await h.next('peerReturned')).toEqual({ t: 'peerReturned', name: 'Joonas' });
    g2.send({ t: 'peer', m: { t: 'ping', id: 1 } });
    expect((await h.next('peer')).from).toBe(2);
    // explicit leave in a match
    g2.send({ t: 'leave' });
    expect(await h.next('peerLeft')).toEqual({ t: 'peerLeft', name: 'Joonas', reason: 'left' });
    h.send({ t: 'leave' });
    await until(() => s.relay.stats().rooms === 0, 2000, 'room cleanup');
  });

  it('closes the room when the host leaves the lobby; grace expiry frees a dropped guest', async () => {
    const s = await startRelay(0, { lobbyGraceMs: 150 });
    const a = await lobbyPair(s);
    a.g.ws.terminate();
    await a.h.next('lobby', (m) => m.lobby.players[1]?.connected === false);
    await a.h.next('lobby', (m) => m.lobby.players.length === 1); // grace expired
    a.h.send({ t: 'leave' });
    await until(() => s.relay.stats().rooms === 0, 2000, 'room deleted');

    const b = await lobbyPair(s);
    b.h.send({ t: 'leave' });
    expect((await b.g.next('roomClosed')).reason).toMatch(/Aino closed the room/);
    await until(() => s.relay.stats().rooms === 0, 2000, 'room deleted');
  });

  it('drops clients that stop answering heartbeats', async () => {
    const s = await startRelay(0, { heartbeatMs: 60 });
    const { h, g } = await startPair(s);
    // freeze g: stop its socket from answering pings (pause the underlying TCP socket)
    (g.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    expect((await h.next('peerLeft', () => true, 3000)).reason).toBe('disconnected');
  });
});

// ───────────────────────── browser client (LanSession) against the relay ─────────────────────────
function session(url: string, name: string): LanSession {
  const s = new LanSession({ url, name, WebSocketImpl: WebSocket as unknown as WebSocketCtor, pingIntervalMs: 100 });
  cleanup.push(() => s.close());
  return s;
}
function nextEvent<K extends keyof NetEvents>(s: NetSession, type: K, pred: (e: NetEvents[K]) => boolean = () => true, ms = 4000): Promise<NetEvents[K]> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { off(); reject(new Error(`timeout waiting for '${type}'`)); }, ms);
    const off = s.on(type, (e) => { if (pred(e)) { clearTimeout(to); off(); resolve(e); } });
  });
}

describe('LanSession client', () => {
  it('drives the full lobby flow through the NetSession API and measures ping', async () => {
    const srv = await startRelay();
    const host = session(srv.url, 'Aino');
    const statuses: string[] = [];
    host.on('status', (st) => statuses.push(st));
    // requested while still connecting → queued, sent after the handshake
    host.createRoom({ mapId: 'test', hostFaction: 'pathogen', guestFaction: 'hospital' });
    const lobby = await nextEvent(host, 'lobby');
    expect(host.status).toBe('lobby');
    expect(host.role).toBe('host');
    const guest = session(srv.url, 'Joonas');
    guest.listRooms();
    const rooms = await nextEvent(guest, 'rooms');
    expect(rooms.map((r) => r.roomId)).toContain(lobby.roomId);
    guest.joinRoom(lobby.roomId);
    await nextEvent(guest, 'lobby', (l) => l.players.length === 2);
    expect(guest.role).toBe('guest');
    const chat = nextEvent(host, 'chat');
    guest.sendChat('hei!');
    expect((await chat).text).toBe('hei!');
    const err = nextEvent(guest, 'error');
    guest.startMatch();
    expect((await err).message).toMatch(/Only the host/);
    host.setReady(true); guest.setReady(true);
    await nextEvent(host, 'lobby', (l) => l.state === 'ready');
    await until(() => Number.isFinite(host.pingMs) && Number.isFinite(guest.pingMs), 3000, 'ping estimate');
    expect(host.pingMs).toBeLessThan(500);
    const starts = [nextEvent(host, 'start'), nextEvent(guest, 'start')];
    host.startMatch();
    const [hs, gs] = await Promise.all(starts);
    expect(hs!.localPlayerId).toBe(1);
    expect(gs!.localPlayerId).toBe(2);
    expect(hs!.players[0]!.faction).toBe('pathogen');
    expect(host.status).toBe('in-game');
    expect(statuses.slice(0, 3)).toEqual(['connected', 'lobby', 'in-game']);
    const left = nextEvent(host, 'opponentLeft');
    guest.leave();
    expect(await left).toEqual({ name: 'Joonas', reason: 'left' });
  });

  it('survives a relay restart: reconnecting → connected, with a clear error about the lost room', async () => {
    const srv = await startRelay();
    const host = session(srv.url, 'Aino');
    host.createRoom({ mapId: 'test', hostFaction: 'hospital', guestFaction: 'pathogen' });
    await nextEvent(host, 'lobby');
    const reconnecting = nextEvent(host, 'status', (st) => st === 'reconnecting');
    await stopRelay(srv);
    await reconnecting;
    const closedEv = nextEvent(host, 'roomClosed', () => true, 8000);
    const errEv = nextEvent(host, 'error', () => true, 8000);
    await startRelay(srv.port);
    expect((await closedEv).reason).toMatch(/no longer exists/);
    expect((await errEv).message).toMatch(/relay may have restarted/);
    expect(host.status).toBe('connected');
    expect(host.lobby).toBeNull();
    // and it is usable again
    host.createRoom({ mapId: 'test', hostFaction: 'hospital', guestFaction: 'pathogen' });
    await nextEvent(host, 'lobby');
  });

  it('two lockstep clients with headless worlds play in sync over the real relay', async () => {
    const srv = await startRelay();
    const host = session(srv.url, 'Aino'), guest = session(srv.url, 'Joonas');
    host.createRoom({ mapId: 'test', hostFaction: 'hospital', guestFaction: 'pathogen' });
    const lobby = await nextEvent(host, 'lobby');
    guest.joinRoom(lobby.roomId);
    await nextEvent(host, 'lobby', (l) => l.players.length === 2);
    host.setReady(true); guest.setReady(true);
    await nextEvent(host, 'lobby', (l) => l.state === 'ready');
    const starts = [nextEvent(host, 'start'), nextEvent(guest, 'start')] as Promise<MatchStart>[];
    host.startMatch();
    const [hs, gs] = await Promise.all(starts);
    const clients = [host, guest].map((s, i) => {
      const start = i === 0 ? hs! : gs!;
      const net = createNetMatch(s, start);
      return { net, world: makeWorld(start), me: start.localPlayerId };
    });
    const TARGET = 600; // 30 s of sim time
    for (const c of clients) c.net.lockstep.haltAtTick = TARGET;
    let issued = false;
    // fast-forwarded frames: 50 ms of "real" time per event-loop turn
    await until(() => {
      for (const c of clients) {
        if (!issued && c.world.tick > 100) {
          const units = c.world.entitiesOf(c.me, (e) => e.kind === 'unit' && !e.gatherer);
          if (units.length) c.net.lockstep.submit({ type: 'attackMove', playerId: c.me, unitIds: units.map((u) => u.id), target: c.world.player(c.me === 1 ? 2 : 1).startPos });
        }
        const n = c.net.lockstep.ticksReady(0.05);
        for (let i = 0; i < n; i++) { c.net.lockstep.beforeTick(c.world); c.world.step(); c.net.lockstep.afterTick(c.world); }
      }
      if (clients.every((c) => c.world.tick > 100)) issued = true;
      return clients.every((c) => c.world.tick === TARGET);
    }, 60_000, 'both at tick 600');
    expect(stateHash(clients[0]!.world)).toBe(stateHash(clients[1]!.world));
    expect(clients[0]!.net.lockstep.debug!().hashChecks).toBeGreaterThan(20);
    for (const c of clients) c.net.lockstep.dispose();
  });
});
