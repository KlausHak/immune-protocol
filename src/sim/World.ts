/**
 * The simulation world: entity store, fixed-tick pipeline, command processing and order dispatch.
 * OWNER: architect. Modules plug in via services (world.movement, world.combat, ...), order handlers
 * (world.orderHandlers) and systems (world.addSystem). Headless-safe: no DOM / three.js.
 */
import { TICK_DT, MAX_POP } from '../config';
import { EventBus } from '../core/events';
import { clone, dist } from '../core/math';
import { Rng } from '../core/rng';
import { computeStats } from '../core/stats';
import { footprintCenter } from '../core/terrain';
import type {
  AnyDef, BuildingDef, Command, DamageType, Entity, EntityId, FactionId, GameEvents, MapData, Order, OrderType,
  PlayerId, PlayerState, Projectile, TilePos, UnitDef, UpgradeDef, Vec2,
} from '../core/types';
import { NEUTRAL_PLAYER } from '../core/types';
import { getDef, SUPPLY_CACHE_ID, UPGRADE_DEFS } from '../data';
import type {
  AbilityService, CombatService, EconomyService, MovementService, OrderHandler, OrderHandlerMap, SimSystem, SpatialIndex, VisionService,
} from './services';
import { GridSpatialIndex } from './spatial';
import { installStubs } from './stubs';

export interface PlayerInit {
  id: PlayerId;
  name: string;
  faction: FactionId;
  team: number;
  color: number;
  controller: 'human' | 'ai' | 'none';
  startPos?: Vec2;
  resources?: { matter: number; energy: number };
}

export interface WorldOptions {
  map: MapData;
  players: PlayerInit[];
  seed?: number;
}

export interface WorldRules {
  /** Skirmish rule: a player with no buildings left is defeated; last team standing wins. Campaign sets false. */
  autoDefeat: boolean;
  gameOver: boolean;
  winnerTeam: number | null;
}

export class World {
  readonly map: MapData;
  readonly events = new EventBus<GameEvents>();
  readonly rng: Rng;
  readonly dt = TICK_DT;
  tick = 0;
  time = 0;

  readonly players = new Map<PlayerId, PlayerState>();
  readonly entities = new Map<EntityId, Entity>();
  /** Stable iteration list of entities (includes dead ones until end-of-tick cleanup — always check e.alive). */
  list: Entity[] = [];
  projectiles: Projectile[] = [];
  nextProjectileId = 1;

  rules: WorldRules = { autoDefeat: true, gameOver: false, winnerTeam: null };

  // ── services (stubs installed in the constructor; real modules overwrite them) ──
  movement!: MovementService;
  vision!: VisionService;
  combat!: CombatService;
  abilities!: AbilityService;
  economy!: EconomyService;
  spatial: SpatialIndex;
  orderHandlers: OrderHandlerMap = {};
  /** Called every tick for alive units with no orders. Owner: combat module (auto-acquire, auto-heal). */
  idleBehavior: (world: World, e: Entity, dt: number) => void = () => {};

  private systems: SimSystem[] = [];
  private nextEntityId = 1;
  private pendingCommands: Command[] = [];
  private pendingRemoval: Entity[] = [];
  private startedOrders = new WeakSet<Order>();
  private lastAlert = new Map<string, number>();

  constructor(opts: WorldOptions) {
    this.map = opts.map;
    this.rng = new Rng(opts.seed ?? 1);
    for (const p of opts.players) {
      this.players.set(p.id, {
        id: p.id, name: p.name, faction: p.faction, team: p.team, color: p.color, controller: p.controller,
        resources: { matter: p.resources?.matter ?? 0, energy: p.resources?.energy ?? 0 },
        popUsed: 0, popCap: 0, upgrades: new Set(), researching: new Set(), defeated: false,
        startPos: p.startPos ? clone(p.startPos) : { x: this.map.width / 2, y: this.map.height / 2 },
        stats: { unitsTrained: 0, unitsLost: 0, unitsKilled: 0, buildingsBuilt: 0, buildingsLost: 0, buildingsKilled: 0, matterGathered: 0, energyGenerated: 0, upgradesResearched: 0 },
        gatherMul: 1,
      });
    }
    if (!this.players.has(NEUTRAL_PLAYER)) {
      this.players.set(NEUTRAL_PLAYER, {
        id: NEUTRAL_PLAYER, name: 'Neutral', faction: 'neutral', team: -1, color: 0xc8c8c8, controller: 'none',
        resources: { matter: 0, energy: 0 }, popUsed: 0, popCap: 0, upgrades: new Set(), researching: new Set(), defeated: false,
        startPos: { x: 0, y: 0 },
        stats: { unitsTrained: 0, unitsLost: 0, unitsKilled: 0, buildingsBuilt: 0, buildingsLost: 0, buildingsKilled: 0, matterGathered: 0, energyGenerated: 0, upgradesResearched: 0 },
        gatherMul: 1,
      });
    }
    this.spatial = new GridSpatialIndex(this, 4);
    installStubs(this);
    this.installBuiltinSystems();
  }

  // ───────────────────────── systems ─────────────────────────
  addSystem(sys: SimSystem): void {
    this.systems = this.systems.filter((s) => s.name !== sys.name);
    this.systems.push(sys);
    this.systems.sort((a, b) => a.order - b.order);
  }
  removeSystem(name: string): void { this.systems = this.systems.filter((s) => s.name !== name); }
  hasSystem(name: string): boolean { return this.systems.some((s) => s.name === name); }
  systemNames(): string[] { return this.systems.map((s) => `${s.order}:${s.name}`); }

  /** Advance the simulation by exactly one fixed tick. */
  step(): void {
    if (this.rules.gameOver) { this.tick++; this.time += this.dt; return; }
    for (const sys of this.systems) sys.update(this, this.dt);
    this.tick++;
    this.time += this.dt;
  }

  /** Convenience for tests/headless runs. */
  runFor(seconds: number, onTick?: (w: World) => void): void {
    const n = Math.round(seconds / this.dt);
    for (let i = 0; i < n; i++) { onTick?.(this); this.step(); }
  }

  // ───────────────────────── players ─────────────────────────
  player(id: PlayerId): PlayerState {
    const p = this.players.get(id);
    if (!p) throw new Error(`Unknown player ${id}`);
    return p;
  }
  /** Non-neutral players. */
  activePlayers(): PlayerState[] { return [...this.players.values()].filter((p) => p.id !== NEUTRAL_PLAYER); }
  isEnemy(a: PlayerId, b: PlayerId): boolean {
    if (a === b || a === NEUTRAL_PLAYER || b === NEUTRAL_PLAYER) return false;
    return this.player(a).team !== this.player(b).team;
  }
  isAlly(a: PlayerId, b: PlayerId): boolean {
    if (a === NEUTRAL_PLAYER || b === NEUTRAL_PLAYER) return a === b;
    return this.player(a).team === this.player(b).team;
  }
  upgradesOf(playerId: PlayerId): UpgradeDef[] {
    const p = this.players.get(playerId);
    if (!p) return [];
    return [...p.upgrades].map((id) => UPGRADE_DEFS[id]).filter((u): u is UpgradeDef => !!u);
  }

  // ───────────────────────── entities ─────────────────────────
  get(id: EntityId | null | undefined): Entity | undefined { return id == null ? undefined : this.entities.get(id); }
  getAlive(id: EntityId | null | undefined): Entity | undefined { const e = this.get(id); return e && e.alive ? e : undefined; }
  /** Alive entities owned by the player (optionally filtered). */
  entitiesOf(playerId: PlayerId, filter?: (e: Entity) => boolean): Entity[] {
    const out: Entity[] = [];
    for (const e of this.list) if (e.alive && e.owner === playerId && (!filter || filter(e))) out.push(e);
    return out;
  }
  countOf(playerId: PlayerId, defId: string, includeUnderConstruction = true): number {
    let n = 0;
    for (const e of this.list) if (e.alive && e.owner === playerId && e.defId === defId && (includeUnderConstruction || !e.construction)) n++;
    return n;
  }

  spawnUnit(defId: string, owner: PlayerId, pos: Vec2, opts: { facing?: number } = {}): Entity {
    const def = getDef(defId);
    if (def.kind !== 'unit') throw new Error(`spawnUnit: "${defId}" is not a unit`);
    const e = this.createEntity(def, owner, pos);
    e.facing = e.prevFacing = opts.facing ?? 0;
    return this.register(e);
  }

  /** Spawn a building with its footprint's top-left at `tile`. complete=false creates a foundation at 0%. */
  spawnBuilding(defId: string, owner: PlayerId, tile: TilePos, opts: { complete?: boolean } = {}): Entity {
    const def = getDef(defId);
    if (def.kind !== 'building') throw new Error(`spawnBuilding: "${defId}" is not a building`);
    const { w, h } = def.footprint;
    const e = this.createEntity(def, owner, footprintCenter(tile, w, h));
    e.tile = { x: tile.x, y: tile.y };
    if (opts.complete === false) {
      e.construction = { progress: 0, total: def.buildTime, builderId: null, costPaid: { ...def.cost } };
      e.hp = Math.max(1, Math.round(e.stats.maxHp * 0.1));
    }
    this.movement.setFootprintBlocked(e.tile, w, h, true);
    this.movement.clearFootprint?.(e.tile, w, h);
    return this.register(e);
  }

  spawnResource(pos: Vec2, amount?: number, defId = SUPPLY_CACHE_ID): Entity {
    const def = getDef(defId);
    if (def.kind !== 'resource') throw new Error(`spawnResource: "${defId}" is not a resource`);
    const { w, h } = def.footprint;
    const tile = { x: Math.round(pos.x - w / 2), y: Math.round(pos.y - h / 2) };
    const e = this.createEntity(def, NEUTRAL_PLAYER, footprintCenter(tile, w, h));
    e.tile = tile;
    e.resource = { kind: def.resource, amount: amount ?? def.defaultAmount, initial: amount ?? def.defaultAmount, activeGatherers: 0 };
    this.movement.setFootprintBlocked(tile, w, h, true);
    return this.register(e);
  }

  /** hp → 0, alive → false, emits entityDied now; actual removal (entityRemoved) happens at end of tick. */
  killEntity(e: Entity, killer: Entity | null = null): void {
    if (!e.alive) return;
    e.alive = false;
    e.hp = 0;
    this.clearOrders(e);
    const victim = this.players.get(e.owner);
    const k = killer ? this.players.get(killer.owner) : undefined;
    if (e.kind === 'unit') { if (victim) victim.stats.unitsLost++; if (k && killer!.owner !== e.owner) k.stats.unitsKilled++; }
    if (e.kind === 'building') { if (victim) victim.stats.buildingsLost++; if (k && killer!.owner !== e.owner) k.stats.buildingsKilled++; }
    this.events.emit('entityDied', { entity: e, killer });
    this.pendingRemoval.push(e);
  }

  /** Remove without dying (despawn, morph, campaign cleanup, depleted resource). */
  removeEntity(e: Entity): void {
    if (!this.entities.has(e.id)) return;
    if (e.alive) { e.alive = false; this.clearOrders(e); }
    (e.ext as Record<string, unknown>).__removeReason = 'removed';
    this.pendingRemoval.push(e);
  }

  /** Recompute effective stats (call after upgrades change). Keeps hp fraction when maxHp changes. */
  recomputeStats(e: Entity): void {
    if (e.kind === 'resource') return;
    const prevMax = e.stats.maxHp;
    e.stats = computeStats(e.def, e.tags, this.upgradesOf(e.owner));
    if (e.stats.maxHp !== prevMax && prevMax > 0) e.hp = Math.min(e.stats.maxHp, e.hp + (e.stats.maxHp - prevMax));
  }
  recomputeStatsForPlayer(playerId: PlayerId): void {
    for (const e of this.list) if (e.alive && e.owner === playerId) this.recomputeStats(e);
  }

  /** Distance between the edges of two entities. Buildings/resources use their rectangular footprint. */
  edgeDistance(a: Entity, b: Entity): number {
    const ar = this.footRect(a), br = this.footRect(b);
    if (ar && br) return rectRectDist(ar, br);
    if (br) return Math.max(0, pointRectDist(a.pos, br) - a.radius);
    if (ar) return Math.max(0, pointRectDist(b.pos, ar) - b.radius);
    return Math.max(0, dist(a.pos, b.pos) - a.radius - b.radius);
  }
  /** Distance from an entity's edge to a point. */
  edgeDistanceToPoint(a: Entity, p: Vec2): number {
    const ar = this.footRect(a);
    return ar ? pointRectDist(p, ar) : Math.max(0, dist(a.pos, p) - a.radius);
  }
  /** World rect of a building/resource footprint, or null for units. */
  footRect(e: Entity): { x: number; y: number; w: number; h: number } | null {
    if (!e.tile || e.def.kind === 'unit') return null;
    const fp = (e.def as BuildingDef).footprint;
    return { x: e.tile.x, y: e.tile.y, w: fp.w, h: fp.h };
  }

  /** Report damage for alerts/AI/audio (called by the combat module's applyDamage). Emits entityDamaged + throttled underAttack. */
  reportDamage(target: Entity, amount: number, type: DamageType, source: Entity | null): void {
    target.lastDamagedAt = this.time;
    target.lastAttackerId = source ? source.id : null;
    this.events.emit('entityDamaged', { entity: target, amount, type, source });
    if (target.owner === NEUTRAL_PLAYER) return;
    const key = `${target.owner}:${Math.floor(target.pos.x / 16)}:${Math.floor(target.pos.y / 16)}`;
    const last = this.lastAlert.get(key) ?? -999;
    if (this.time - last >= 8) {
      this.lastAlert.set(key, this.time);
      this.events.emit('underAttack', { playerId: target.owner, entity: target, pos: clone(target.pos) });
    }
  }

  // ───────────────────────── commands & orders ─────────────────────────
  /** Queue a command for processing at the start of the next tick (same path for human, AI and scripts). */
  issue(cmd: Command): void { this.pendingCommands.push(cmd); }

  /** Replace (or append to) a unit's order queue. */
  setOrders(e: Entity, orders: Order[], queue = false): void {
    if (!e.alive || e.kind !== 'unit') return;
    if (!queue) {
      this.clearOrders(e);
      e.orders = [...orders];
    } else {
      e.orders.push(...orders);
    }
  }
  clearOrders(e: Entity): void {
    const cur = e.orders[0];
    if (cur && this.startedOrders.has(cur)) {
      const h = this.orderHandlers[cur.type] as OrderHandler | undefined;
      try { h?.stop?.(this, e, cur as never); } catch (err) { console.error('[world] order stop threw', err); }
    }
    e.orders = [];
  }

  private processCommands(): void {
    if (this.pendingCommands.length === 0) return;
    const cmds = this.pendingCommands;
    this.pendingCommands = [];
    for (const cmd of cmds) {
      try { this.processCommand(cmd); } catch (err) { console.error('[world] command failed', cmd, err); }
    }
  }

  private processCommand(cmd: Command): void {
    const p = this.players.get(cmd.playerId);
    if (!p || p.defeated) return;
    this.events.emit('commandIssued', { command: cmd });
    const own = (id: EntityId) => { const e = this.getAlive(id); return e && e.owner === cmd.playerId ? e : undefined; };
    switch (cmd.type) {
      case 'train': { const b = own(cmd.buildingId); if (b && b.kind === 'building') this.economy.queueTrain(b, cmd.defId); return; }
      case 'cancelTrain': { const b = own(cmd.buildingId); if (b) this.economy.cancelTrain(b, cmd.index); return; }
      case 'research': { const b = own(cmd.buildingId); if (b && b.kind === 'building') this.economy.queueResearch(b, cmd.upgradeId); return; }
      case 'cancelResearch': { const b = own(cmd.buildingId); if (b) this.economy.cancelResearch(b); return; }
      case 'cancelConstruction': { const b = own(cmd.buildingId); if (b && b.construction) this.economy.cancelConstruction(b); return; }
      case 'setRally': {
        for (const id of cmd.buildingIds) { const b = own(id); if (b && b.kind === 'building') b.rally = { pos: clone(cmd.target), targetId: cmd.targetId }; }
        return;
      }
      case 'buildingAbility': {
        const b = own(cmd.buildingId);
        if (b && !b.construction) this.abilities.cast(b, cmd.abilityId, cmd.target, this.getAlive(cmd.targetId ?? null) ?? null);
        return;
      }
      default: break;
    }
    // ── unit commands ──
    const units = cmd.unitIds.map(own).filter((e): e is Entity => !!e && e.kind === 'unit');
    if (units.length === 0) return;
    const q = !!cmd.queue;
    switch (cmd.type) {
      case 'stop': for (const u of units) { this.setOrders(u, []); this.movement.stop(u); if (u.combat) { u.combat.targetId = null; u.combat.holdPosition = false; } } return;
      case 'hold': for (const u of units) { this.setOrders(u, [{ type: 'hold' }], q); } return;
      case 'move': case 'attackMove': {
        const targets = units.length > 1 ? this.movement.groupTargets(units, cmd.target) : [cmd.target];
        units.forEach((u, i) => this.setOrders(u, [{ type: cmd.type, target: clone(targets[i] ?? cmd.target) } as Order], q));
        return;
      }
      case 'attack': for (const u of units) this.setOrders(u, [{ type: 'attack', targetId: cmd.targetId }], q); return;
      case 'patrol': for (const u of units) this.setOrders(u, [{ type: 'patrol', from: clone(u.pos), to: clone(cmd.target) }], q); return;
      case 'follow': for (const u of units) if (u.id !== cmd.targetId) this.setOrders(u, [{ type: 'follow', targetId: cmd.targetId }], q); return;
      case 'gather': for (const u of units) { if (u.gatherer) this.setOrders(u, [{ type: 'gather', targetId: cmd.targetId }], q); } return;
      case 'returnCargo': for (const u of units) { if (u.gatherer && u.gatherer.carrying > 0) this.setOrders(u, [{ type: 'returnCargo' }], q); } return;
      case 'repair': for (const u of units) { if (u.gatherer) this.setOrders(u, [{ type: 'repair', targetId: cmd.targetId }], q); } return;
      case 'build': {
        const def = getDef(cmd.defId);
        if (def.kind !== 'building') return;
        const builders = units.filter((u) => (u.def as UnitDef).builds?.includes(cmd.defId));
        if (builders.length === 0) return;
        const c = footprintCenter(cmd.tile, def.footprint.w, def.footprint.h);
        builders.sort((a, b) => dist(a.pos, c) - dist(b.pos, c));
        this.setOrders(builders[0]!, [{ type: 'build', defId: cmd.defId, tile: { x: cmd.tile.x, y: cmd.tile.y } }], q);
        return;
      }
      case 'ability': {
        const casters = units.filter((u) => (u.def as UnitDef).abilities.includes(cmd.abilityId));
        if (casters.length === 0) return;
        const targetEntity = this.getAlive(cmd.targetId ?? null) ?? null;
        const ready = casters.filter((u) => (u.cooldowns[cmd.abilityId] ?? 0) <= 0);
        const pool = ready.length ? ready : casters;
        const tp = cmd.target ?? targetEntity?.pos;
        if (tp) pool.sort((a, b) => dist(a.pos, tp) - dist(b.pos, tp));
        const caster = pool[0]!;
        const abilityOrder: Order = { type: 'ability', abilityId: cmd.abilityId, target: cmd.target ? clone(cmd.target) : undefined, targetId: cmd.targetId };
        this.setOrders(caster, [abilityOrder], q);
        return;
      }
      case 'smart': {
        for (const u of units) {
          const o = this.resolveSmart(u, cmd.target, cmd.targetId);
          if (o) this.setOrders(u, [o], q);
        }
        if (units.length > 1 && !cmd.targetId) {
          // spread group ground-moves
          const moving = units.filter((u) => u.orders[u.orders.length - 1]?.type === 'move');
          if (moving.length > 1) {
            const targets = this.movement.groupTargets(moving, cmd.target);
            moving.forEach((u, i) => { const last = u.orders[u.orders.length - 1]; if (last && last.type === 'move') last.target = clone(targets[i] ?? cmd.target); });
          }
        }
        return;
      }
      default: return;
    }
  }

  /** Right-click resolution: attack enemies, gather resources, construct/return/repair for workers, follow friends, else move. */
  resolveSmart(u: Entity, target: Vec2, targetId?: EntityId): Order | null {
    const t = this.getAlive(targetId ?? null);
    const isWorker = !!u.gatherer;
    if (t && t.id !== u.id) {
      if (this.isEnemy(u.owner, t.owner)) {
        if (u.combat && this.combat.weaponFor(u, t)) return { type: 'attack', targetId: t.id };
        return { type: 'move', target: clone(t.pos) };
      }
      if (t.kind === 'resource') return isWorker ? { type: 'gather', targetId: t.id } : { type: 'move', target: clone(target) };
      if (t.owner === u.owner && t.kind === 'building') {
        if (isWorker && t.construction) return { type: 'construct', targetId: t.id };
        if (isWorker && u.gatherer!.carrying > 0 && (t.def as BuildingDef).dropoff) return { type: 'returnCargo', targetId: t.id };
        if (isWorker && (u.def as UnitDef).faction === 'hospital' && t.hp < t.stats.maxHp) return { type: 'repair', targetId: t.id };
        return { type: 'move', target: clone(target) };
      }
      if (this.isAlly(u.owner, t.owner) && t.kind === 'unit') {
        if (isWorker && (u.def as UnitDef).faction === 'hospital' && t.tags.has('mech') && t.hp < t.stats.maxHp) return { type: 'repair', targetId: t.id };
        return { type: 'follow', targetId: t.id };
      }
    }
    return { type: 'move', target: clone(target) };
  }

  private runOrders(e: Entity, dt: number): void {
    for (let guard = 0; guard < 4; guard++) {
      const o = e.orders[0];
      if (!o) { this.idleBehavior(this, e, dt); return; }
      const h = this.orderHandlers[o.type as OrderType] as OrderHandler | undefined;
      if (!h) { e.orders.shift(); continue; }
      if (!this.startedOrders.has(o)) { this.startedOrders.add(o); h.start?.(this, e, o as never); }
      if (!e.alive || e.orders[0] !== o) return; // start() may have replaced orders
      const status = h.update(this, e, o as never, dt);
      if (status === 'running' || e.orders[0] !== o) return;
      h.stop?.(this, e, o as never);
      e.orders.shift();
      if (!e.alive) return;
    }
  }

  // ───────────────────────── internals ─────────────────────────
  private createEntity(def: AnyDef, owner: PlayerId, pos: Vec2): Entity {
    const tags = new Set(def.kind === 'resource' ? [] : def.tags);
    const stats = computeStats(def, tags, this.upgradesOf(owner));
    const radius = def.kind === 'unit' ? def.radius : def.kind === 'resource' ? def.radius : Math.max(def.footprint.w, def.footprint.h) / 2;
    const e: Entity = {
      id: this.nextEntityId++, kind: def.kind, defId: def.id, def, owner,
      pos: clone(pos), prevPos: clone(pos), facing: 0, prevFacing: 0, radius,
      hp: stats.maxHp, alive: true, bornAt: this.time, activity: 'idle', stats, tags,
      orders: [], cooldowns: {}, lastDamagedAt: -999, lastAttackerId: null, scriptTags: new Set(), ext: {},
    };
    if (def.kind === 'unit') {
      e.mover = { flying: tags.has('air'), moving: false, vel: { x: 0, y: 0 }, goal: null, path: [], arrived: true, blockedTime: 0 };
      if (def.weapons.length) e.combat = { targetId: null, cooldown: 0, lastAttackTime: -1, windupLeft: 0, holdPosition: false };
      if (def.gather) e.gatherer = { carrying: 0, nodeId: null, dropoffId: null, phase: 'idle', timer: 0 };
    } else if (def.kind === 'building') {
      if (def.trains.length || def.researches.length) e.production = { queue: [], maxQueue: 5 };
      if (def.weapons.length) e.combat = { targetId: null, cooldown: 0, lastAttackTime: -1, windupLeft: 0, holdPosition: true };
    }
    return e;
  }

  private register(e: Entity): Entity {
    this.entities.set(e.id, e);
    this.list.push(e);
    this.spatial.rebuild();
    this.events.emit('entitySpawned', { entity: e });
    return e;
  }

  private cleanup(): void {
    if (this.pendingRemoval.length === 0) return;
    const removing = this.pendingRemoval;
    this.pendingRemoval = [];
    const gone = new Set<EntityId>();
    for (const e of removing) {
      if (!this.entities.has(e.id)) continue;
      if (e.tile && e.def.kind !== 'unit') {
        const fp = (e.def as BuildingDef).footprint;
        this.movement.setFootprintBlocked(e.tile, fp.w, fp.h, false);
      }
      this.entities.delete(e.id);
      gone.add(e.id);
      const reason = (e.ext as Record<string, unknown>).__removeReason === 'removed' ? 'removed' : 'died';
      this.events.emit('entityRemoved', { entity: e, reason });
    }
    if (gone.size) this.list = this.list.filter((e) => !gone.has(e.id));
    this.spatial.rebuild();
  }

  private installBuiltinSystems(): void {
    this.addSystem({
      name: 'snapshot', order: 0,
      update: (w) => {
        for (const e of w.list) { e.prevPos.x = e.pos.x; e.prevPos.y = e.pos.y; e.prevFacing = e.facing; }
        for (const p of w.projectiles) { p.prevPos.x = p.pos.x; p.prevPos.y = p.pos.y; p.prevT = p.t; }
      },
    });
    this.addSystem({
      name: 'cooldowns', order: 5,
      update: (w, dt) => {
        for (const e of w.list) {
          if (!e.alive) continue;
          for (const k in e.cooldowns) { const v = e.cooldowns[k]!; if (v > 0) e.cooldowns[k] = Math.max(0, v - dt); }
        }
      },
    });
    this.addSystem({ name: 'commands', order: 10, update: (w) => w.processCommands() });
    this.addSystem({
      name: 'orders', order: 20,
      update: (w, dt) => { for (const e of w.list) if (e.alive && e.kind === 'unit') w.runOrders(e, dt); },
    });
    this.addSystem({ name: 'spatial', order: 25, update: (w) => w.spatial.rebuild() });
    this.addSystem({
      name: 'regen', order: 80,
      update: (w, dt) => {
        for (const e of w.list) {
          if (!e.alive || e.construction || e.stats.hpRegen <= 0 || e.hp >= e.stats.maxHp) continue;
          e.hp = Math.min(e.stats.maxHp, e.hp + e.stats.hpRegen * dt);
        }
      },
    });
    this.addSystem({ name: 'rules', order: 90, update: (w) => w.checkRules() });
    this.addSystem({ name: 'cleanup', order: 100, update: (w) => w.cleanup() });
  }

  /** Default skirmish rules. Campaign missions set rules.autoDefeat = false and call endGame() themselves. */
  private checkRules(): void {
    if (!this.rules.autoDefeat || this.rules.gameOver) return;
    if (this.tick % 10 !== 0) return;
    for (const p of this.activePlayers()) {
      if (p.defeated) continue;
      const hasBuilding = this.list.some((e) => e.alive && e.owner === p.id && e.kind === 'building');
      if (!hasBuilding) this.defeatPlayer(p.id);
    }
    const teams = new Set(this.activePlayers().filter((p) => !p.defeated).map((p) => p.team));
    if (teams.size <= 1) this.endGame(teams.size === 1 ? [...teams][0]! : null, 'elimination');
  }

  defeatPlayer(id: PlayerId): void {
    const p = this.players.get(id);
    if (!p || p.defeated) return;
    p.defeated = true;
    this.events.emit('playerDefeated', { playerId: id });
  }

  endGame(winnerTeam: number | null, reason: string): void {
    if (this.rules.gameOver) return;
    this.rules.gameOver = true;
    this.rules.winnerTeam = winnerTeam;
    this.events.emit('gameOver', { winnerTeam, reason });
  }

  /** Population helper (economy recomputes popUsed/popCap each tick; this clamps). */
  clampPop(cap: number): number { return Math.min(MAX_POP, cap); }
}

// ───────────────────────── geometry helpers ─────────────────────────
function pointRectDist(p: Vec2, r: { x: number; y: number; w: number; h: number }): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}
function rectRectDist(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}
