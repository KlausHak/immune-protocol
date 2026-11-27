/**
 * Test harness for lockstep: an in-memory network (latency, jitter, reordering, outages) connecting two
 * GameChannels, and headless "clients" (world + Lockstep driver) that mirror Game's multiplayer loop:
 * n = ticksReady(dt); per tick beforeTick → world.step → afterTick.
 */
import type { PlayerId } from '../../src/core/types';
import { getMap } from '../../src/map';
import { ChannelBase } from '../../src/net/channel';
import { Lockstep, type LockstepOptions } from '../../src/net/lockstep';
import type { PeerMsg } from '../../src/net/protocol';
import type { MatchStart, NetEvents } from '../../src/net/types';
import { restoreMatch, stateHash, type SaveGame } from '../../src/sim/save';
import { createWorld, spawnMapResources, spawnSkirmishStart } from '../../src/sim/setup';
import type { World } from '../../src/sim/World';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LinkOptions { latencyMs?: number; jitterMs?: number; /** allow out-of-order delivery */ reorder?: boolean; seed?: number }

/** Virtual-time network between two channels. */
export class SimNet {
  now = 0;
  delivered = 0;
  private q: Array<{ at: number; seq: number; to: MemChannel; m: PeerMsg }> = [];
  private seq = 0;
  private rng: () => number;
  private lastAt = new Map<MemChannel, number>();
  readonly a: MemChannel;
  readonly b: MemChannel;

  constructor(readonly opts: LinkOptions = {}) {
    this.rng = mulberry32(opts.seed ?? 7);
    this.a = new MemChannel(this);
    this.b = new MemChannel(this);
    this.a.peer = this.b;
    this.b.peer = this.a;
  }

  enqueue(to: MemChannel, m: PeerMsg): void {
    const wire = JSON.parse(JSON.stringify(m)) as PeerMsg; // exactly what JSON over a socket delivers
    let at = this.now + (this.opts.latencyMs ?? 0) + this.rng() * (this.opts.jitterMs ?? 0);
    if (!this.opts.reorder) at = Math.max(at, this.lastAt.get(to) ?? 0); // FIFO like a TCP socket
    this.lastAt.set(to, at);
    this.q.push({ at, seq: this.seq++, to, m: wire });
  }

  /** advance virtual time and deliver everything due */
  advance(ms: number): void {
    this.now += ms;
    const due = this.q.filter((x) => x.at <= this.now).sort((x, y) => x.at - y.at || x.seq - y.seq);
    if (!due.length) return;
    this.q = this.q.filter((x) => x.at > this.now);
    for (const d of due) { if (d.to.up) { this.delivered++; d.to.deliver(d.m); } }
  }

  pending(): number { return this.q.length; }
}

export class MemChannel extends ChannelBase {
  peer!: MemChannel;
  up = true;
  desyncs: Array<NetEvents['desync']> = [];
  errors: string[] = [];
  endedCalls = 0;
  sent = 0;
  constructor(private net: SimNet) { super(); }
  send(m: PeerMsg): void {
    this.sent++;
    if (!this.up || !this.peer.up) return; // dropped like a dead socket
    this.net.enqueue(this.peer, m);
  }
  emitDesync(e: NetEvents['desync']): void { this.desyncs.push(e); }
  emitError(message: string): void { this.errors.push(message); }
  ended(): void { this.endedCalls++; }
  get connected(): boolean { return this.up; }
  get pingMs(): number { return Number.NaN; }
}

export function matchStart(local: PlayerId, over: Partial<MatchStart> = {}): MatchStart {
  return {
    seed: 4242, mapId: 'test',
    players: [{ id: 1, faction: 'hospital', name: 'Aino', team: 1 }, { id: 2, faction: 'pathogen', name: 'Joonas', team: 2 }],
    localPlayerId: local, turnTicks: 2, inputDelayTurns: 2, startTick: 0, matchId: 'TEST-1', epoch: 0, ...over,
  };
}

/** Same world construction as Game for a MatchStart (plus an identical extra squad per side, for combat). */
export function makeWorld(start: MatchStart, squads = true): World {
  const w = createWorld(getMap(start.mapId), start.players.map((p) => ({ id: p.id, faction: p.faction, team: p.team, controller: 'human' as const, name: p.name })), start.seed);
  spawnMapResources(w);
  spawnSkirmishStart(w);
  if (squads) {
    const defs: Record<string, string[]> = {
      hospital: ['hosp_sanitizer', 'hosp_sanitizer', 'hosp_sanitizer', 'hosp_medic', 'hosp_uv_lancer', 'hosp_antibiotic_launcher'],
      pathogen: ['path_phage', 'path_phage', 'path_phage', 'path_bacillus', 'path_bacillus', 'path_fungal_mortar'],
    };
    for (const p of w.activePlayers()) {
      defs[p.faction]!.forEach((d, i) => {
        const pos = w.movement.nearestWalkable({ x: p.startPos.x + 5 + (i % 3), y: p.startPos.y + 5 + Math.floor(i / 3) });
        if (pos) w.spawnUnit(d, p.id, pos);
      });
    }
  }
  return w;
}

export interface TestClient {
  slot: PlayerId;
  world: World;
  driver: Lockstep;
  channel: MemChannel;
  /** turn-boundary hashes seen by this client: tick → hash (filled when hashTicks is enabled) */
  hashes: Map<number, string>;
  restarts: number;
  /** submitted commands go through here (so bots work across restarts) */
  submit: (cmd: Parameters<Lockstep['submit']>[0]) => void;
}

export function makeClient(slot: PlayerId, channel: MemChannel, opts: Partial<LockstepOptions> & { now?: () => number; start?: Partial<MatchStart>; squads?: boolean } = {}): TestClient {
  const start = matchStart(slot, opts.start);
  const c: TestClient = {
    slot, world: makeWorld(start, opts.squads ?? true), driver: null as unknown as Lockstep, channel, hashes: new Map(), restarts: 0,
    submit: (cmd) => c.driver.submit(cmd),
  };
  const build = (s: MatchStart): Lockstep => new Lockstep({
    ...opts, start: s, channel,
    onRestart: (next: MatchStart, save: SaveGame) => {
      const w = createWorld(getMap(next.mapId), next.players.map((p) => ({ id: p.id, faction: p.faction, team: p.team, controller: 'human' as const, name: p.name })), next.seed);
      restoreMatch(save, w, [], null);
      c.world = w;
      c.restarts++;
      c.driver = build(next);
    },
  });
  c.driver = build(start);
  return c;
}

/** One frame of Game's multiplayer loop. Returns ticks run. */
export function frame(c: TestClient, dtMs: number, recordHashes = false): number {
  const d = c.driver;
  const n = Math.min(d.ticksReady(dtMs / 1000), 8);
  let ran = 0;
  for (let i = 0; i < n; i++) {
    if (c.driver !== d) break; // restarted (resync)
    d.beforeTick(c.world);
    c.world.step();
    d.afterTick(c.world);
    ran++;
    if (recordHashes && c.driver === d && c.world.tick % 20 === 0) c.hashes.set(c.world.tick, stateHash(c.world));
  }
  return ran;
}

/**
 * Run both clients in virtual time. `fps` per client; `jank(clientIndex, t)` may return extra ms for a frame
 * (simulated hitch). `bot(c)` runs once per frame (submits commands). Stops when `until()` is true or maxMs.
 */
export function runPair(net: SimNet, clients: [TestClient, TestClient], o: {
  maxMs: number; fps?: [number, number]; until?: () => boolean; bot?: (c: TestClient) => void;
  jank?: (i: number, tMs: number) => number; recordHashes?: boolean; stepMs?: number;
}): void {
  const fps = o.fps ?? [60, 60];
  const period = fps.map((f) => 1000 / f);
  const nextFrame = [0, 0];
  const lastFrame = [0, 0];
  const step = o.stepMs ?? 4;
  for (let t = 0; t <= o.maxMs; t += step) {
    net.advance(step);
    for (let i = 0; i < 2; i++) {
      if (net.now < nextFrame[i]!) continue;
      const c = clients[i]!;
      const dt = Math.min(100, net.now - lastFrame[i]!); // Game clamps dtReal to 0.1 s
      lastFrame[i] = net.now;
      nextFrame[i] = net.now + period[i]! + (o.jank?.(i, net.now) ?? 0);
      o.bot?.(c);
      frame(c, dt, o.recordHashes);
    }
    if (o.until?.()) return;
  }
}

/** A scripted player: economy + construction + production + a late attack, all through submit(). */
export function scriptedBot(): (c: TestClient) => void {
  const done = new Map<PlayerId, Set<string>>();
  return (c) => {
    const w = c.world, me = c.slot, t = w.tick;
    let d = done.get(me);
    if (!d) { d = new Set(); done.set(me, d); }
    const once = (key: string, at: number, fn: () => void) => { if (t >= at && !d!.has(key)) { d!.add(key); fn(); } };
    const hq = w.entitiesOf(me, (e) => e.kind === 'building')[0];
    const workers = w.entitiesOf(me, (e) => !!e.gatherer);
    const army = w.entitiesOf(me, (e) => e.kind === 'unit' && !e.gatherer);
    const worker = me === 1 ? 'hosp_orderly' : 'path_spore_drone';
    once('train1', 30, () => { if (hq) { c.submit({ type: 'train', playerId: me, buildingId: hq.id, defId: worker }); c.submit({ type: 'train', playerId: me, buildingId: hq.id, defId: worker }); } });
    once('scout', 120, () => { if (army[0]) c.submit({ type: 'move', playerId: me, unitIds: [army[0].id], target: { x: w.map.width / 2, y: w.map.height / 2 } }); });
    once('rally', 200, () => { if (hq) c.submit({ type: 'setRally', playerId: me, buildingIds: [hq.id], target: { x: hq.pos.x + 3, y: hq.pos.y + 3 } }); });
    once('hold', 260, () => { if (army[1]) c.submit({ type: 'hold', playerId: me, unitIds: [army[1].id] }); });
    once('stopgather', 320, () => { if (workers[0]) c.submit({ type: 'stop', playerId: me, unitIds: [workers[0].id] }); });
    once('regather', 380, () => {
      const node = workers[0] && w.spatial.nearest(workers[0].pos, 30, (e) => e.kind === 'resource');
      if (workers[0] && node) c.submit({ type: 'gather', playerId: me, unitIds: [workers[0].id], targetId: node.id });
    });
    once('attack', 700, () => {
      const foe = w.player(me === 1 ? 2 : 1).startPos;
      if (army.length) c.submit({ type: 'attackMove', playerId: me, unitIds: army.map((u) => u.id), target: foe });
    });
    once('train2', 900, () => { if (hq) c.submit({ type: 'train', playerId: me, buildingId: hq.id, defId: worker }); });
    once('cancel', 905, () => { if (hq) c.submit({ type: 'cancelTrain', playerId: me, buildingId: hq.id }); });
    once('reinforce', 1600, () => {
      const foe = w.player(me === 1 ? 2 : 1).startPos;
      if (army.length) c.submit({ type: 'attackMove', playerId: me, unitIds: army.map((u) => u.id), target: foe, queue: true });
    });
  };
}
