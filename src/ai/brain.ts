/**
 * [ai] Shared state of one AI player ("the brain"): flags, difficulty profile, personality, the units it
 * controls, worker/unit roles, pending build orders, bases & resource sites, a cached per-tick snapshot of
 * its own entities, the command budget (APM) and once-per-source error logging. Managers (economy,
 * build, army, defence, scouting) read and write it; nothing here issues strategy on its own.
 *
 * Fair play: the brain only ever changes the game through world.issue(...) (budgeted by `issue`), except
 * spawnWave(), the campaign's explicit free-spawn path.
 */
import { clone, dist, normalize, sub } from '../core/math';
import type { Rng } from '../core/rng';
import type { BuildingDef, Command, Cost, Entity, EntityId, Order, PlayerId, PlayerState, TilePos, UnitDef, Vec2 } from '../core/types';
import { BUILDING_DEFS, UNIT_DEFS } from '../data';
import type { World } from '../sim/World';
import type { ArmyManager } from './army';
import type { DefenseManager } from './defense';
import type { AiFlags } from './index';
import { EnemyMemory } from './memory';
import { HIVE, PERSONALITY_DEFS, pickPersonality, type Personality, type PersonalityDef } from './personality';
import { profileFor, type DifficultyProfile } from './profile';
import type { Difficulty } from '../core/types';
import { centroid, densify, hasWeapons, indexAhead, isWorkerUnit, pathLength } from './util';

/** What a unit is currently doing for the AI. Units without a role are "home" (army) or free (workers). */
export type Role = 'builder' | 'scout' | 'explorer' | 'militia' | 'squad' | 'defender' | 'regen';

export interface PendingBuild {
  defId: string;
  tile: TilePos;
  builderId: EntityId;
  /** cost to reserve until the foundation exists */
  cost: Cost;
  issuedAt: number;
  /** foundation entity once placed */
  buildingId: EntityId | null;
}

export interface Base {
  hive: Entity;
  pos: Vec2;
  complete: boolean;
  /** caches with matter left that are closer to this hive than to any other of ours */
  caches: Entity[];
  /** centroid of the caches (null when mined out) */
  mineral: Vec2 | null;
  remaining: number;
}

/** A cluster of resource nodes (a potential base). */
export interface Site {
  key: number;
  center: Vec2;
  nodes: Entity[];
  amount: number;
}

export interface EnemyStart { playerId: PlayerId; pos: Vec2 }

/** Per-tick categorisation of the AI's own entities (cached by world.tick). */
export class Snapshot {
  units: Entity[] = [];
  /** controlled workers */
  workers: Entity[] = [];
  /** controlled combat units (all roles) */
  army: Entity[] = [];
  buildings: Entity[] = [];
  done = new Map<string, Entity[]>();
  wip = new Map<string, Entity[]>();
  /** units/upgrades queued or in progress, by def id */
  queued = new Map<string, number>();
  constructor(readonly tick: number) {}
  doneOf(id: string): Entity[] { return this.done.get(id) ?? []; }
  wipOf(id: string): Entity[] { return this.wip.get(id) ?? []; }
  doneCount(id: string): number { return this.done.get(id)?.length ?? 0; }
  wipCount(id: string): number { return this.wip.get(id)?.length ?? 0; }
  queuedCount(id: string): number { return this.queued.get(id) ?? 0; }
}

export interface BrainOptions { difficulty: Difficulty; personality?: Personality }

export class Brain {
  readonly flags: AiFlags = { economy: true, build: true, army: true, attack: true, expand: true, defend: true };
  prof: DifficultyProfile;
  readonly pers: PersonalityDef;
  readonly rng: Rng;
  readonly memory: EnemyMemory;
  readonly player: PlayerState;
  /** Units this AI commands: its starting forces and everything it trains (never wave/scripted units). */
  readonly controlled = new Set<EntityId>();
  /** Units spawned by sendWave — they stay under script control. */
  readonly waveUnits = new Set<EntityId>();
  readonly roles = new Map<EntityId, Role>();
  pending: PendingBuild[] = [];
  bases: Base[] = [];
  sites: Site[] = [];
  /** army rally/staging point in front of the base (null until a base exists) */
  staging: Vec2 | null = null;
  enemyStarts: EnemyStart[] = [];
  /** campaign override of the wave target */
  attackOverride: Vec2 | null = null;
  initialized = false;
  errors = 0;
  /** recent underAttack alerts for this player */
  attacks: Array<{ pos: Vec2; t: number; id: EntityId }> = [];
  // wired by PathogenAi after construction (managers reference each other through the brain)
  army!: ArmyManager;
  defense!: DefenseManager;

  private income: Array<{ t: number; amount: number }> = [];
  private statSamples: Array<{ t: number; v: number }> = [];
  private actions: number;
  private snapCache: Snapshot | null = null;
  private loadCache: { tick: number; m: Map<EntityId, number> } | null = null;
  private visCache: { tick: number; list: Entity[] } | null = null;
  private basesKey = '';
  private logged = new Set<string>();
  private spawningWave = false;
  private unsub: Array<() => void> = [];
  private sitesAt = -999;
  private basesTick = -1;
  private stagingAt = -999;
  private stagingFrom = -1;
  private distCache = new Map<string, number>();
  /** tiles where a build order failed recently ("x,y" → retry time) */
  private badTiles = new Map<string, number>();

  constructor(readonly world: World, readonly me: PlayerId, opts: BrainOptions) {
    this.prof = profileFor(opts.difficulty);
    this.player = world.player(me);
    // Private stream forked from the seeded world rng: reproducible per seed, and our draws never
    // shift the sequence other modules see.
    this.rng = world.rng.fork(0x5eed1 + me * 7919);
    this.pers = PERSONALITY_DEFS[opts.personality ?? pickPersonality(this.rng, this.prof.personalityWeights)];
    this.memory = new EnemyMemory(this);
    this.actions = this.prof.apm * 2;
    const ev = world.events;
    this.unsub.push(
      ev.on('productionComplete', ({ building, unit }) => { if (building.owner === me) this.adopt(unit); }),
      ev.on('entitySpawned', ({ entity }) => this.onSpawned(entity)),
      ev.on('entityRemoved', ({ entity }) => this.onRemoved(entity.id)),
      ev.on('entityDied', ({ entity }) => { this.memory.forgetUnit(entity.id); if (entity.owner === me) this.roles.delete(entity.id); }),
      ev.on('resourceDelivered', ({ playerId, kind, amount }) => { if (playerId === me && kind === 'matter') this.income.push({ t: world.time, amount }); }),
      ev.on('underAttack', ({ playerId, entity, pos }) => { if (playerId === me) this.attacks.push({ pos: clone(pos), t: world.time, id: entity.id }); }),
      ev.on('constructionStarted', ({ building }) => {
        if (building.owner !== me || !building.tile) return;
        const p = this.pending.find((q) => q.buildingId == null && q.defId === building.defId && q.tile.x === building.tile!.x && q.tile.y === building.tile!.y);
        if (p) { p.buildingId = building.id; p.cost = {}; }
      }),
    );
  }

  dispose(): void { for (const u of this.unsub) u(); this.unsub = []; }

  setDifficulty(d: Difficulty): void {
    this.prof = profileFor(d);
    this.actions = Math.min(this.actions, this.prof.apm * 2);
  }

  /** Lazy first-think setup (the AI is created before the match spawns its entities). */
  init(): void {
    this.initialized = true;
    for (const e of this.world.list) if (e.alive && e.owner === this.me && e.kind === 'unit') this.adopt(e);
    this.enemyStarts = [];
    for (const p of this.world.activePlayers()) {
      if (!this.world.isEnemy(this.me, p.id)) continue;
      const slot = this.world.map.slots.find((s) => s.id === p.id);
      this.enemyStarts.push({ playerId: p.id, pos: clone(slot?.start ?? p.startPos) });
    }
    this.refreshSites(true);
    this.refreshBases();
    this.refreshStaging(true);
  }

  // ───────────────────────── control & events ─────────────────────────

  adopt(e: Entity): void {
    if (e.kind !== 'unit' || e.owner !== this.me || this.spawningWave || this.waveUnits.has(e.id)) return;
    if ((e.def as UnitDef).trainable === false) return; // bosses are campaign-controlled
    this.controlled.add(e.id);
  }

  /** Controlled and not claimed by a script since (any scriptTag opts a unit out of AI control). */
  isControlled(e: Entity): boolean { return this.controlled.has(e.id) && e.scriptTags.size === 0; }

  private onSpawned(e: Entity): void {
    if (!this.initialized || this.spawningWave || e.owner !== this.me || e.kind !== 'unit') return;
    // Fallback adoption in case an economy implementation doesn't emit productionComplete: a unit that
    // appears right next to one of our producers of that unit type is ours.
    for (const b of this.world.list) {
      if (!b.alive || b.owner !== this.me || b.kind !== 'building' || b.construction) continue;
      if (!(b.def as BuildingDef).trains.includes(e.defId)) continue;
      if (this.world.edgeDistance(e, b) <= 4) { this.adopt(e); return; }
    }
  }

  private onRemoved(id: EntityId): void {
    this.controlled.delete(id);
    this.waveUnits.delete(id);
    this.roles.delete(id);
    this.memory.forgetUnit(id);
  }

  /** Campaign free-spawn (the only non-command path). Units stay script-controlled. */
  spawnWave(composition: Record<string, number>, spawnAt: Vec2, target: Vec2): number[] {
    const list: string[] = [];
    for (const [defId, n] of Object.entries(composition ?? {})) {
      const def = UNIT_DEFS[defId];
      if (!def) { this.fail(`sendWave: unknown unit "${defId}"`, new Error(defId)); continue; }
      for (let i = 0; i < Math.max(0, Math.floor(Number(n) || 0)); i++) list.push(defId);
    }
    const ids: number[] = [];
    if (!list.length) return ids;
    const cols = Math.ceil(Math.sqrt(list.length));
    this.spawningWave = true;
    try {
      list.forEach((defId, i) => {
        const p = { x: spawnAt.x + ((i % cols) - (cols - 1) / 2) * 1.3, y: spawnAt.y + (Math.floor(i / cols) - (cols - 1) / 2) * 1.3 };
        const flying = UNIT_DEFS[defId]!.tags.includes('air');
        const pos = flying ? p : this.world.movement.nearestWalkable(p, 10) ?? this.world.movement.nearestWalkable(spawnAt, 16) ?? clone(spawnAt);
        const u = this.world.spawnUnit(defId, this.me, pos);
        u.scriptTags.add('wave');
        this.waveUnits.add(u.id);
        ids.push(u.id);
      });
    } finally {
      this.spawningWave = false;
    }
    this.world.issue({ type: 'attackMove', playerId: this.me, unitIds: ids, target: clone(target) });
    return ids;
  }

  // ───────────────────────── commands & errors ─────────────────────────

  refill(dt: number): void { this.actions = Math.min(this.prof.apm * 2, this.actions + this.prof.apm * dt); }
  canAct(n = 1): boolean { return this.actions >= n; }

  /** Issue a command through the same path as a human. Non-critical commands respect the APM budget. */
  issue(cmd: Command, critical = false): boolean {
    if (!critical && this.actions < 1) return false;
    this.actions = Math.max(-this.prof.apm, this.actions - 1);
    this.world.issue(cmd);
    return true;
  }

  /** Count an error and log it once per source. Never throws. */
  fail(where: string, err: unknown): void {
    this.errors++;
    if (this.logged.has(where)) return;
    this.logged.add(where);
    console.error(`[ai] ${where} failed (later errors from it are only counted)`, err);
  }

  // ───────────────────────── snapshot ─────────────────────────

  snap(): Snapshot {
    const w = this.world;
    if (this.snapCache && this.snapCache.tick === w.tick) return this.snapCache;
    const s = new Snapshot(w.tick);
    for (const e of w.list) {
      if (!e.alive || e.owner !== this.me) continue;
      if (e.kind === 'unit') {
        s.units.push(e);
        if (!this.isControlled(e)) continue;
        if (isWorkerUnit(e)) s.workers.push(e);
        else if (hasWeapons(e)) s.army.push(e);
      } else if (e.kind === 'building') {
        s.buildings.push(e);
        const m = e.construction ? s.wip : s.done;
        let arr = m.get(e.defId);
        if (!arr) { arr = []; m.set(e.defId, arr); }
        arr.push(e);
        for (const it of e.production?.queue ?? []) s.queued.set(it.defId, (s.queued.get(it.defId) ?? 0) + 1);
      }
    }
    this.snapCache = s;
    return s;
  }

  // ───────────────────────── economy helpers ─────────────────────────

  /** Resources minus the cost of ordered-but-not-yet-placed buildings. */
  budget(): { matter: number; energy: number } {
    const r = this.player.resources;
    let matter = r.matter, energy = r.energy;
    for (const p of this.pending) if (p.buildingId == null) { matter -= p.cost.matter ?? 0; energy -= p.cost.energy ?? 0; }
    return { matter, energy };
  }

  pendingCount(defId: string): number {
    let n = 0;
    for (const p of this.pending) if (p.buildingId == null && p.defId === defId) n++;
    return n;
  }

  /** completed + under construction + ordered */
  startedCount(defId: string): number {
    const s = this.snap();
    return s.doneCount(defId) + s.wipCount(defId) + this.pendingCount(defId);
  }

  addPending(defId: string, tile: TilePos, builderId: EntityId, buildingId: EntityId | null = null): void {
    const def = BUILDING_DEFS[defId];
    this.pending.push({ defId, tile: { x: tile.x, y: tile.y }, builderId, cost: buildingId == null && def ? { ...def.cost } : {}, issuedAt: this.world.time, buildingId });
    this.roles.set(builderId, 'builder');
  }

  isBadTile(tile: TilePos): boolean { return (this.badTiles.get(`${tile.x},${tile.y}`) ?? -1) > this.world.time; }

  /** Is worker `w` constructing building `b` (by order or as the registered builder)? */
  isConstructing(w: Entity, b: Entity): boolean {
    const o: Order | undefined = w.orders[0];
    if (!o) return false;
    if (o.type === 'construct') return o.targetId === b.id;
    if (o.type === 'build') return o.buildingId === b.id || (!!b.tile && o.tile.x === b.tile.x && o.tile.y === b.tile.y && o.defId === b.defId);
    if (o.type === 'repair') return o.targetId === b.id;
    return false;
  }

  /** Resolve pending build orders: placed → track construction; failed/timed-out → release the builder. */
  updatePending(): void {
    const t = this.world.time, s = this.snap();
    for (const [k, until] of this.badTiles) if (until <= t) this.badTiles.delete(k);
    this.pending = this.pending.filter((p) => {
      if (p.buildingId == null) {
        const placed = s.wipOf(p.defId).find((b) => b.tile && b.tile.x === p.tile.x && b.tile.y === p.tile.y);
        if (placed) { p.buildingId = placed.id; p.cost = {}; }
      }
      const builder = this.world.getAlive(p.builderId);
      if (p.buildingId != null) {
        const b = this.world.getAlive(p.buildingId);
        const keep = !!b && !!b.construction && !!builder && this.isConstructing(builder, b);
        if (!keep) this.releaseRole(p.builderId, 'builder');
        return keep;
      }
      if (!builder) return false;
      if (t - p.issuedAt < 0.3) return true; // command not processed yet
      const o = builder.orders[0];
      const going = !!o && o.type === 'build' && o.defId === p.defId && o.tile.x === p.tile.x && o.tile.y === p.tile.y;
      if (going && t - p.issuedAt < 75) return true;
      this.badTiles.set(`${p.tile.x},${p.tile.y}`, t + 30);
      this.releaseRole(p.builderId, 'builder');
      if (going) this.issue({ type: 'stop', playerId: this.me, unitIds: [builder.id] }, true);
      return false;
    });
  }

  releaseRole(id: EntityId, role: Role): void { if (this.roles.get(id) === role) this.roles.delete(id); }

  /** Resource node a worker is mining (by current order), or null. */
  gatherNode(w: Entity): EntityId | null {
    const o = w.orders[0];
    if (!o) return null;
    if (o.type === 'gather') return w.gatherer?.nodeId ?? o.targetId;
    if (o.type === 'returnCargo') return w.gatherer?.nodeId ?? null;
    return null;
  }

  /** Number of our workers mining each resource node (cached per tick). */
  cacheLoad(): Map<EntityId, number> {
    const s = this.snap();
    if (this.loadCache && this.loadCache.tick === s.tick) return this.loadCache.m;
    const m = new Map<EntityId, number>();
    for (const w of s.workers) {
      const node = this.gatherNode(w);
      if (node != null) m.set(node, (m.get(node) ?? 0) + 1);
    }
    this.loadCache = { tick: s.tick, m };
    return m;
  }

  /** Pick a free worker near a point (prefers empty-handed, already-gathering drones). */
  pickWorker(near: Vec2, exclude?: ReadonlySet<EntityId>): Entity | null {
    let best: Entity | null = null, bs = Infinity;
    for (const w of this.snap().workers) {
      if (this.roles.has(w.id) || exclude?.has(w.id)) continue;
      const o = w.orders[0];
      if (o && (o.type === 'build' || o.type === 'construct')) continue;
      const score = dist(w.pos, near) + (w.gatherer && w.gatherer.carrying > 0 ? 3 : 0) + (w.hp < w.stats.maxHp * 0.5 ? 10 : 0);
      if (score < bs) { bs = score; best = w; }
    }
    return best;
  }

  workerTarget(): number {
    const s = this.snap();
    let caches = 0;
    for (const b of this.bases) caches += b.caches.length;
    let t = Math.round(caches * this.prof.workersPerCache) + 3;
    if (s.wipCount(HIVE) + this.pendingCount(HIVE) > 0) t += 4; // pre-train drones for the new base
    return Math.max(8, Math.min(this.prof.maxWorkers, t));
  }

  /** Matter income per minute over the last minute. */
  incomePerMin(): number {
    const t = this.world.time;
    while (this.income.length && t - this.income[0]!.t > 60) this.income.shift();
    let sum = 0;
    for (const i of this.income) sum += i.amount;
    const win = Math.min(60, Math.max(15, t));
    let rate = (sum * 60) / win;
    // fallback for economies that don't emit resourceDelivered: player stats delta
    const v = this.player.stats.matterGathered;
    const last = this.statSamples[this.statSamples.length - 1];
    if (!last || t - last.t >= 5) this.statSamples.push({ t, v });
    while (this.statSamples.length > 2 && t - this.statSamples[0]!.t > 60) this.statSamples.shift();
    const first = this.statSamples[0]!;
    if (t - first.t >= 10) rate = Math.max(rate, ((v - first.v) * 60) / (t - first.t));
    return rate;
  }

  // ───────────────────────── geography ─────────────────────────

  /** Nearest ground-walkable point (null if none nearby). */
  walkable(p: Vec2, r = 8): Vec2 | null {
    try { return this.world.movement.nearestWalkable(p, r); } catch { return null; }
  }

  refreshSites(force = false): void {
    const t = this.world.time;
    if (!force && t - this.sitesAt < 10) return;
    this.sitesAt = t;
    const sites: Site[] = [];
    for (const n of this.world.list) {
      if (!n.alive || n.kind !== 'resource' || (n.resource?.amount ?? 0) <= 0) continue;
      let best: Site | null = null, bd = 10;
      for (const s of sites) { const d = dist(s.center, n.pos); if (d < bd) { bd = d; best = s; } }
      if (best) { best.nodes.push(n); best.amount += n.resource!.amount; best.center = centroid(best.nodes); }
      else sites.push({ key: n.id, center: clone(n.pos), nodes: [n], amount: n.resource!.amount });
    }
    this.sites = sites;
    this.memory.setInterestPoints([...this.enemyStarts.map((e) => e.pos), ...sites.map((s) => s.center)]);
  }

  /** Recompute bases (hives + their caches) — at most once a second unless the set of hives changed. */
  refreshBases(): void {
    const s = this.snap();
    if (this.basesTick === s.tick) return;
    const hives = [...s.doneOf(HIVE), ...s.wipOf(HIVE)];
    const key = hives.map((h) => `${h.id}${h.construction ? 'w' : 'd'}`).join(',');
    if (key === this.basesKey && s.tick - this.basesTick < 20 && this.bases.every((b) => b.caches.every((c) => c.alive))) return;
    this.basesKey = key;
    this.basesTick = s.tick;
    const bases: Base[] = hives.map((h) => ({ hive: h, pos: clone(h.pos), complete: !h.construction, caches: [], mineral: null, remaining: 0 }));
    if (bases.length) {
      const seen = new Set<EntityId>();
      for (const base of bases) {
        for (const r of this.world.spatial.queryRadius(base.pos, 12, (e) => e.kind === 'resource' && (e.resource?.amount ?? 0) > 0)) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          let owner = base, od = dist(r.pos, base.pos);
          for (const o of bases) { const d = dist(r.pos, o.pos); if (d < od) { od = d; owner = o; } }
          owner.caches.push(r);
          owner.remaining += r.resource!.amount;
        }
      }
      for (const base of bases) base.mineral = base.caches.length ? centroid(base.caches) : null;
    }
    const start = this.player.startPos;
    bases.sort((a, b) => Number(b.complete) - Number(a.complete) || dist(a.pos, start) - dist(b.pos, start) || a.hive.id - b.hive.id);
    this.bases = bases;
  }

  /** The main base: the completed hive closest to our start (falls back to any hive). */
  get main(): Base | null { return this.bases.find((b) => b.complete) ?? this.bases[0] ?? null; }

  ownsSite(site: Site): boolean { return this.bases.some((b) => dist(b.pos, site.center) < 13); }

  /** Where the enemy most likely is: a remembered HQ, else a known start location. */
  enemyFocus(from: Vec2): Vec2 | null {
    const hq = this.memory.nearestStructure(from, (s) => s.hq);
    if (hq) return hq.pos;
    let best: Vec2 | null = null, bd = Infinity;
    for (const es of this.enemyStarts) {
      if (this.world.players.get(es.playerId)?.defeated) continue;
      const d = dist(es.pos, from);
      if (d < bd) { bd = d; best = es.pos; }
    }
    return best;
  }

  /** Army staging point: ~11 tiles out from the front base along the ground path toward the enemy. */
  refreshStaging(force = false): void {
    const t = this.world.time;
    const front = this.frontBase();
    if (!front) { this.staging = null; return; }
    if (!force && this.staging && t - this.stagingAt < 20 && this.stagingFrom === front.hive.id) return;
    this.stagingAt = t;
    this.stagingFrom = front.hive.id;
    const target = this.enemyFocus(front.pos);
    let dir = target ? normalize(sub(target, front.pos)) : { x: 0, y: 0 };
    if (dir.x === 0 && dir.y === 0) dir = front.mineral ? normalize(sub(front.pos, front.mineral)) : { x: 0, y: 1 };
    if (dir.x === 0 && dir.y === 0) dir = { x: 0, y: 1 };
    const start = this.walkable({ x: front.pos.x + dir.x * 4.5, y: front.pos.y + dir.y * 4.5 }) ?? clone(front.pos);
    let pts: Vec2[] = [start, { x: start.x + dir.x * 10, y: start.y + dir.y * 10 }];
    if (target) {
      const goal = this.walkable(target) ?? target;
      const path = this.safePath(start, goal);
      if (path) pts = [start, ...path];
    }
    const dense = densify(pts, 1.5);
    this.staging = this.walkable(dense[indexAhead(dense, 0, 8)]!) ?? start;
  }

  /** Completed base closest to the enemy (where the army should stand). */
  frontBase(): Base | null {
    const done = this.bases.filter((b) => b.complete);
    if (!done.length) return this.bases[0] ?? null;
    const main = done[0]!;
    const focus = this.enemyFocus(main.pos);
    if (!focus || done.length === 1) return main;
    let best = main, bd = dist(main.pos, focus);
    for (const b of done) {
      const d = dist(b.pos, focus);
      if (d < bd - 8) { bd = d; best = b; }
    }
    return best;
  }

  safePath(from: Vec2, to: Vec2, radius = 0.6): Vec2[] | null {
    try { return this.world.movement.findPath(from, to, radius); } catch { return null; }
  }

  /** Ground path length (cached by key); Infinity when unreachable. */
  groundDistance(a: Vec2, b: Vec2, key: string): number {
    const k = `${key}|${Math.round(a.x)},${Math.round(a.y)}`;
    const c = this.distCache.get(k);
    if (c !== undefined) return c;
    const from = this.walkable(a) ?? a, to = this.walkable(b) ?? b;
    const path = this.safePath(from, to);
    const d = path ? pathLength([from, ...path]) : Infinity;
    this.distCache.set(k, d);
    return d;
  }

  chooseExpansionSite(): Site | null {
    const main = this.main;
    if (!main) return null;
    let best: Site | null = null, bs = Infinity;
    for (const site of this.sites) {
      if (site.amount < 1200 || this.ownsSite(site)) continue;
      if (this.pending.some((p) => p.defId === HIVE && dist(p.tile, site.center) < 14)) continue;
      if (this.memory.structuresNear(site.center, 15).length) continue;
      if (this.enemyStarts.some((es) => !this.world.players.get(es.playerId)?.defeated && dist(es.pos, site.center) < 16)) continue;
      const d = this.groundDistance(main.pos, site.center, `site${site.key}`);
      if (!Number.isFinite(d)) continue;
      let score = d;
      for (const es of this.enemyStarts) { const de = dist(es.pos, site.center); if (de < d) score += (d - de) * 1.5; }
      score += this.memory.enemyUnitsNear(site.center, 14, 60) * 15;
      if (score < bs) { bs = score; best = site; }
    }
    return best;
  }

  /** Site for a replacement hive when we have none: nearest to our remaining forces. */
  rebuildSite(): Site | null {
    const s = this.snap();
    const anchor = s.workers.length ? centroid(s.workers) : s.buildings.length ? centroid(s.buildings) : this.player.startPos;
    let best: Site | null = null, bd = Infinity;
    for (const site of this.sites) {
      if (site.amount < 500 || this.memory.structuresNear(site.center, 15).length) continue;
      const d = dist(site.center, anchor) + this.memory.enemyUnitsNear(site.center, 14, 60) * 20;
      if (d < bd) { bd = d; best = site; }
    }
    return best;
  }

  // ───────────────────────── perception ─────────────────────────

  /** Every enemy entity we can currently see through our own fog (cached per tick, one pass). */
  visibleEnemies(): Entity[] {
    const w = this.world;
    if (this.visCache && this.visCache.tick === w.tick) return this.visCache.list;
    const list: Entity[] = [];
    for (const e of w.list) {
      if (!e.alive || e.kind === 'resource' || e.owner === this.me || !w.isEnemy(this.me, e.owner)) continue;
      if (w.vision.isEntityVisible(this.me, e)) list.push(e);
    }
    this.visCache = { tick: w.tick, list };
    return list;
  }

  /** Visible enemy entities whose body is within r of p. */
  enemiesNear(p: Vec2, r: number, filter?: (e: Entity) => boolean): Entity[] {
    const out: Entity[] = [];
    for (const e of this.visibleEnemies()) {
      const rr = r + e.radius;
      const dx = e.pos.x - p.x, dy = e.pos.y - p.y;
      if (dx * dx + dy * dy <= rr * rr && e.alive && (!filter || filter(e))) out.push(e);
    }
    return out;
  }

  /** underAttack alerts near p within the last `window` seconds. */
  attacksNear(p: Vec2, r: number, window: number): number {
    const t = this.world.time;
    let n = 0;
    for (const a of this.attacks) if (t - a.t <= window && dist(a.pos, p) <= r) n++;
    return n;
  }

  pruneAttacks(): void {
    const t = this.world.time;
    if (this.attacks.length > 0 && t - this.attacks[0]!.t > 240) this.attacks = this.attacks.filter((a) => t - a.t <= 240);
  }

  pathPoints(from: Vec2, to: Vec2, step = 2.5): Vec2[] {
    const start = this.walkable(from) ?? from, goal = this.walkable(to) ?? to;
    const path = this.safePath(start, goal);
    return densify([start, ...(path && path.length ? path : [goal])], step);
  }
}
