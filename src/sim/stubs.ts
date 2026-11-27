/**
 * Minimal but FUNCTIONAL stand-ins for every simulation module so the game runs end-to-end from day one.
 * Real modules (src/sim/movement, combat, economy) replace these by overwriting the same services,
 * order handlers and system names ('movement', 'vision', 'combat', 'economy').
 * Tests may call installStubs(world) explicitly to isolate a module from the others.
 * OWNER: architect. Do not grow these — implement the real thing in your module instead.
 */
import { MAX_POP } from '../config';
import { angleOf, clone, dist, normalize, sub } from '../core/math';
import { footprintCenter, inBounds, tileIndex } from '../core/terrain';
import type { BuildingDef, Cost, Entity, EntityId, PlayerId, TilePos, UnitDef, Vec2, WeaponDef } from '../core/types';
import { getDef, UNIT_DEFS, UPGRADE_DEFS, ABILITY_DEFS } from '../data';
import type {
  AbilityService, CombatService, EconomyService, MovementService, OrderHandlerMap, VisionService,
} from './services';
import type { World } from './World';

interface StubMoveExt { arrive: number; targetId: EntityId | null; range: number }

// ───────────────────────── movement (straight lines, no pathfinding) ─────────────────────────
export class StubMovement implements MovementService {
  private dyn: Uint8Array;
  constructor(private w: World) { this.dyn = new Uint8Array(w.map.width * w.map.height); }
  moveTo(e: Entity, target: Vec2, opts?: { arriveDistance?: number }): void {
    const m = e.mover; if (!m) return;
    m.goal = clone(target); m.path = [clone(target)]; m.arrived = false; m.moving = true;
    e.ext.stubMove = { arrive: opts?.arriveDistance ?? 0.15, targetId: null, range: 0 } satisfies StubMoveExt;
  }
  moveToEntity(e: Entity, target: Entity, range: number): void {
    const m = e.mover; if (!m) return;
    m.goal = clone(target.pos); m.path = [clone(target.pos)]; m.arrived = false; m.moving = true;
    e.ext.stubMove = { arrive: 0, targetId: target.id, range } satisfies StubMoveExt;
  }
  stop(e: Entity): void {
    const m = e.mover; if (!m) return;
    m.goal = null; m.path = []; m.moving = false; m.arrived = true; m.vel = { x: 0, y: 0 };
  }
  hasArrived(e: Entity): boolean { return e.mover?.arrived ?? true; }
  groupTargets(units: Entity[], target: Vec2): Vec2[] {
    const n = units.length, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), sp = 1.1;
    return units.map((_, i) => ({ x: target.x + ((i % cols) - (cols - 1) / 2) * sp, y: target.y + (Math.floor(i / cols) - (rows - 1) / 2) * sp }));
  }
  findPath(_from: Vec2, to: Vec2): Vec2[] | null { return [clone(to)]; }
  isWalkable(p: Vec2): boolean {
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    if (!inBounds(this.w.map, tx, ty)) return false;
    const i = tileIndex(this.w.map, tx, ty);
    return this.w.map.blocked[i] === 0 && this.dyn[i] === 0;
  }
  nearestWalkable(p: Vec2, maxRadius = 8): Vec2 | null {
    if (this.isWalkable(p)) return clone(p);
    for (let r = 1; r <= maxRadius; r++) for (let a = 0; a < 16; a++) {
      const q = { x: p.x + Math.cos((a / 16) * Math.PI * 2) * r, y: p.y + Math.sin((a / 16) * Math.PI * 2) * r };
      if (this.isWalkable(q)) return q;
    }
    return null;
  }
  setFootprintBlocked(tile: TilePos, w: number, h: number, blocked: boolean): void {
    for (let y = tile.y; y < tile.y + h; y++) for (let x = tile.x; x < tile.x + w; x++) {
      if (inBounds(this.w.map, x, y)) this.dyn[tileIndex(this.w.map, x, y)] = blocked ? 1 : 0;
    }
  }
  isFootprintFree(tile: TilePos, w: number, h: number, ignore: EntityId[] = []): boolean {
    for (let y = tile.y; y < tile.y + h; y++) for (let x = tile.x; x < tile.x + w; x++) {
      if (!inBounds(this.w.map, x, y)) return false;
      const i = tileIndex(this.w.map, x, y);
      if (this.w.map.blocked[i] || this.dyn[i]) return false;
    }
    const blockers = this.w.spatial.queryRect(tile.x - 0.4, tile.y - 0.4, tile.x + w + 0.4, tile.y + h + 0.4,
      (e) => e.kind === 'unit' && !e.mover?.flying && !ignore.includes(e.id));
    return blockers.length === 0;
  }
}

function stubMoveSystem(w: World, dt: number): void {
  for (const e of w.list) {
    const m = e.mover;
    if (!e.alive || !m || !m.moving || !m.goal) continue;
    const ext = e.ext.stubMove as StubMoveExt | undefined;
    let goal = m.goal;
    if (ext?.targetId != null) {
      const t = w.getAlive(ext.targetId);
      if (!t) { w.movement.stop(e); continue; }
      goal = m.goal = clone(t.pos);
      if (w.edgeDistance(e, t) <= ext.range) { w.movement.stop(e); continue; }
    }
    const d = dist(e.pos, goal);
    const step = e.stats.speed * dt;
    if (d <= Math.max(ext?.arrive ?? 0.15, 1e-3) || d <= step) {
      if (ext?.targetId == null) { e.pos.x = goal.x; e.pos.y = goal.y; }
      w.movement.stop(e);
      continue;
    }
    const dir = normalize(sub(goal, e.pos));
    const nx = e.pos.x + dir.x * step, ny = e.pos.y + dir.y * step;
    if (m.flying || w.movement.isWalkable({ x: nx, y: ny })) { e.pos.x = nx; e.pos.y = ny; m.blockedTime = 0; }
    else if (w.movement.isWalkable({ x: e.pos.x + Math.sign(dir.x) * step, y: e.pos.y })) { e.pos.x += Math.sign(dir.x) * step; }
    else if (w.movement.isWalkable({ x: e.pos.x, y: e.pos.y + Math.sign(dir.y) * step })) { e.pos.y += Math.sign(dir.y) * step; }
    else { m.blockedTime += dt; if (m.blockedTime > 1.5) { m.blockedTime = 0; w.movement.stop(e); continue; } }
    m.vel = { x: dir.x * e.stats.speed, y: dir.y * e.stats.speed };
    e.facing = angleOf(dir);
  }
}

// ───────────────────────── vision (everything visible) ─────────────────────────
export class StubVision implements VisionService {
  version = 1;
  private grids = new Map<PlayerId, Uint8Array>();
  constructor(private w: World) {}
  fogGrid(playerId: PlayerId): Uint8Array {
    let g = this.grids.get(playerId);
    if (!g) { g = new Uint8Array(this.w.map.width * this.w.map.height).fill(2); this.grids.set(playerId, g); }
    return g;
  }
  isVisible(): boolean { return true; }
  isExplored(): boolean { return true; }
  isEntityVisible(): boolean { return true; }
  revealAll(): void {}
  revealArea(): void {}
}

// ───────────────────────── combat ─────────────────────────
export class StubCombat implements CombatService {
  constructor(private w: World) {}
  applyDamage(target: Entity, rawDamage: number, type: import('../core/types').DamageType, source: Entity | null): number {
    if (!target.alive || target.invulnerable || target.kind === 'resource') return 0;
    const dmg = Math.max(0.5, rawDamage * (target.stats.resist[type] ?? 1) - target.stats.armor);
    target.hp -= dmg;
    this.w.reportDamage(target, dmg, type, source);
    if (target.hp <= 0) this.w.killEntity(target, source);
    return dmg;
  }
  heal(target: Entity, amount: number, source: Entity | null): number {
    if (!target.alive) return 0;
    const h = Math.min(amount, target.stats.maxHp - target.hp);
    if (h <= 0) return 0;
    target.hp += h;
    this.w.events.emit('entityHealed', { entity: target, amount: h, source });
    return h;
  }
  rawDamage(attacker: Entity, weapon: WeaponDef, target: Entity): number {
    let d = weapon.damage;
    for (const [tag, bonus] of Object.entries(weapon.bonus ?? {})) if (target.tags.has(tag as never)) d += bonus ?? 0;
    return (d + attacker.stats.damageAdd) * attacker.stats.damageMul;
  }
  weaponFor(attacker: Entity, target: Entity): WeaponDef | null {
    if (attacker.def.kind === 'resource') return null;
    const layer = target.tags.has('air') ? 'air' : 'ground';
    return attacker.def.weapons.find((wp) => wp.targets.includes(layer)) ?? null;
  }
  weaponRange(attacker: Entity, weapon: WeaponDef): number { return weapon.range + attacker.stats.rangeAdd; }
  canTarget(attacker: Entity, target: Entity): boolean {
    return target.alive && target.kind !== 'resource' && this.w.isEnemy(attacker.owner, target.owner) && !!this.weaponFor(attacker, target);
  }
}

/** Shared stub engage step: approach and fire instant-hit shots. Returns true while engaging. */
function stubEngage(w: World, e: Entity, t: Entity, dt: number, mayMove: boolean): boolean {
  const c = e.combat; if (!c) return false;
  const weapon = w.combat.weaponFor(e, t); if (!weapon) return false;
  const range = w.combat.weaponRange(e, weapon);
  if (w.edgeDistance(e, t) > range) {
    if (!mayMove) return false;
    w.movement.moveToEntity(e, t, range * 0.9);
    e.activity = 'moving';
    return true;
  }
  w.movement.stop(e);
  e.facing = angleOf(sub(t.pos, e.pos));
  e.activity = 'attacking';
  c.targetId = t.id;
  if (c.cooldown <= 0) {
    const dmg = w.combat.rawDamage(e, weapon, t);
    c.cooldown = weapon.cooldown * e.stats.cooldownMul;
    c.lastAttackTime = w.time;
    w.events.emit('weaponFired', { source: e, target: t, targetPos: clone(t.pos), weapon, projectile: null });
    w.combat.applyDamage(t, dmg, weapon.damageType, e);
  }
  void dt;
  return true;
}

function nearestEnemy(w: World, e: Entity, radius: number): Entity | null {
  return w.spatial.nearest(e.pos, radius, (o) => w.combat.canTarget(e, o));
}

export class StubAbilities implements AbilityService {
  constructor(private w: World) {}
  canCast(caster: Entity, abilityId: string): { ok: boolean; reason?: string } {
    if ((caster.cooldowns[abilityId] ?? 0) > 0) return { ok: false, reason: 'Ability on cooldown' };
    return { ok: !!ABILITY_DEFS[abilityId] };
  }
  cast(caster: Entity, abilityId: string, target?: Vec2, targetEntity?: Entity | null): boolean {
    const a = ABILITY_DEFS[abilityId];
    if (!a || !this.canCast(caster, abilityId).ok) return false;
    caster.cooldowns[abilityId] = a.cooldown;
    if (a.id === 'emergency_supply') this.w.economy.addResources(caster.owner, { matter: a.amount ?? 100 });
    if (a.damage && a.radius && target) {
      for (const t of this.w.spatial.queryRadius(target, a.radius, (o) => this.w.isEnemy(caster.owner, o.owner))) this.w.combat.applyDamage(t, a.damage, a.damageType ?? 'normal', caster);
    }
    this.w.events.emit('abilityUsed', { source: caster, abilityId, target: target ? clone(target) : null, targetEntity: targetEntity ?? null });
    return true;
  }
}

// ───────────────────────── economy ─────────────────────────
export class StubEconomy implements EconomyService {
  constructor(private w: World) {}
  canAfford(playerId: PlayerId, cost: Cost): boolean {
    const r = this.w.player(playerId).resources;
    return r.matter >= (cost.matter ?? 0) && r.energy >= (cost.energy ?? 0);
  }
  spend(playerId: PlayerId, cost: Cost): boolean {
    const p = this.w.player(playerId);
    if (p.resources.matter < (cost.matter ?? 0)) { this.w.events.emit('notEnough', { playerId, kind: 'matter', message: 'Not enough matter' }); return false; }
    if (p.resources.energy < (cost.energy ?? 0)) { this.w.events.emit('notEnough', { playerId, kind: 'energy', message: 'Not enough energy' }); return false; }
    p.resources.matter -= cost.matter ?? 0; p.resources.energy -= cost.energy ?? 0;
    return true;
  }
  refund(playerId: PlayerId, cost: Cost, fraction = 1): void {
    const r = this.w.player(playerId).resources;
    r.matter += (cost.matter ?? 0) * fraction; r.energy += (cost.energy ?? 0) * fraction;
  }
  addResources(playerId: PlayerId, bag: Cost): void { this.refund(playerId, bag, 1); }
  meetsRequirements(playerId: PlayerId, requires: string[]): boolean { return this.missingRequirements(playerId, requires).length === 0; }
  missingRequirements(playerId: PlayerId, requires: string[]): string[] {
    const p = this.w.player(playerId);
    return requires.filter((id) => (UPGRADE_DEFS[id] ? !p.upgrades.has(id) : this.w.countOf(playerId, id, false) === 0));
  }
  canPlaceBuilding(playerId: PlayerId, defId: string, tile: TilePos, builderId?: EntityId): { ok: boolean; reason?: string } {
    const def = getDef(defId);
    if (def.kind !== 'building') return { ok: false, reason: 'Not a building' };
    const { w, h } = def.footprint;
    for (let y = tile.y; y < tile.y + h; y++) for (let x = tile.x; x < tile.x + w; x++) {
      if (!inBounds(this.w.map, x, y) || !this.w.map.buildable[tileIndex(this.w.map, x, y)]) return { ok: false, reason: "Can't build there" };
    }
    if (!this.w.movement.isFootprintFree(tile, w, h, builderId != null ? [builderId] : [])) return { ok: false, reason: "Can't build there" };
    if (!this.meetsRequirements(playerId, def.requires)) return { ok: false, reason: 'Requirements not met' };
    return { ok: true };
  }
  placeFoundation(playerId: PlayerId, defId: string, tile: TilePos, builder: Entity | null): Entity | null {
    const ok = this.canPlaceBuilding(playerId, defId, tile, builder?.id);
    if (!ok.ok) { this.w.events.emit('notEnough', { playerId, kind: 'placement', message: ok.reason ?? "Can't build there" }); return null; }
    const def = getDef(defId) as BuildingDef;
    if (!this.spend(playerId, def.cost)) return null;
    const b = this.w.spawnBuilding(defId, playerId, tile, { complete: false });
    b.construction!.builderId = builder?.id ?? null;
    this.w.events.emit('constructionStarted', { building: b, builder });
    return b;
  }
  cancelConstruction(b: Entity): void {
    if (!b.construction) return;
    this.refund(b.owner, b.construction.costPaid, 0.75);
    this.w.events.emit('constructionCancelled', { building: b });
    this.w.removeEntity(b);
  }
  canTrain(b: Entity, unitDefId: string): { ok: boolean; reason?: string } {
    const def = b.def as BuildingDef, u = UNIT_DEFS[unitDefId];
    if (b.construction || !u || !def.trains?.includes(unitDefId) || !b.production) return { ok: false, reason: 'Cannot train here' };
    if (b.production.queue.length >= b.production.maxQueue) return { ok: false, reason: 'Queue is full' };
    if (!this.meetsRequirements(b.owner, u.requires)) return { ok: false, reason: 'Requirements not met' };
    const p = this.w.player(b.owner);
    if (p.popUsed + u.pop > p.popCap) return { ok: false, reason: 'Not enough capacity' };
    if (!this.canAfford(b.owner, u.cost)) return { ok: false, reason: 'Not enough resources' };
    return { ok: true };
  }
  queueTrain(b: Entity, unitDefId: string): boolean {
    const ok = this.canTrain(b, unitDefId);
    if (!ok.ok) { this.w.events.emit('notEnough', { playerId: b.owner, kind: 'requirement', message: ok.reason ?? 'Cannot train' }); return false; }
    const u = UNIT_DEFS[unitDefId]!;
    if (!this.spend(b.owner, u.cost)) return false;
    const item = { kind: 'unit' as const, defId: unitDefId, progress: 0, total: u.buildTime, cost: { ...u.cost } };
    b.production!.queue.push(item);
    this.w.player(b.owner).popUsed += u.pop;
    this.w.events.emit('productionQueued', { building: b, item });
    return true;
  }
  cancelTrain(b: Entity, index?: number): void {
    const q = b.production?.queue; if (!q || q.length === 0) return;
    const i = index ?? q.length - 1;
    const [item] = q.splice(i, 1);
    if (item) { this.refund(b.owner, item.cost); if (item.kind === 'upgrade') this.w.player(b.owner).researching.delete(item.defId); }
  }
  canResearch(b: Entity, upgradeId: string): { ok: boolean; reason?: string } {
    const def = b.def as BuildingDef, u = UPGRADE_DEFS[upgradeId], p = this.w.player(b.owner);
    if (b.construction || !u || !def.researches?.includes(upgradeId) || !b.production) return { ok: false, reason: 'Cannot research here' };
    if (p.upgrades.has(upgradeId) || p.researching.has(upgradeId)) return { ok: false, reason: 'Already researched' };
    if (!this.meetsRequirements(b.owner, u.requires)) return { ok: false, reason: 'Requirements not met' };
    if (!this.canAfford(b.owner, u.cost)) return { ok: false, reason: 'Not enough resources' };
    return { ok: true };
  }
  queueResearch(b: Entity, upgradeId: string): boolean {
    if (!this.canResearch(b, upgradeId).ok) return false;
    const u = UPGRADE_DEFS[upgradeId]!;
    if (!this.spend(b.owner, u.cost)) return false;
    const item = { kind: 'upgrade' as const, defId: upgradeId, progress: 0, total: u.researchTime, cost: { ...u.cost } };
    b.production!.queue.push(item);
    this.w.player(b.owner).researching.add(upgradeId);
    this.w.events.emit('productionQueued', { building: b, item });
    return true;
  }
  cancelResearch(b: Entity): void {
    const q = b.production?.queue; if (!q) return;
    const i = q.findIndex((it) => it.kind === 'upgrade');
    if (i >= 0) this.cancelTrain(b, i);
  }
  nearestDropoff(worker: Entity): Entity | null {
    let best: Entity | null = null, bd = Infinity;
    for (const e of this.w.list) {
      if (!e.alive || e.owner !== worker.owner || e.kind !== 'building' || e.construction || !(e.def as BuildingDef).dropoff) continue;
      const d = dist(e.pos, worker.pos); if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
}

function stubEconomySystem(w: World, dt: number): void {
  // population & income
  for (const p of w.activePlayers()) {
    let used = 0, cap = 0, income = 0;
    for (const e of w.list) {
      if (!e.alive || e.owner !== p.id) continue;
      if (e.kind === 'unit') used += (e.def as UnitDef).pop;
      if (e.kind === 'building' && !e.construction) { cap += (e.def as BuildingDef).provides.pop ?? 0; income += (e.def as BuildingDef).provides.energyPerSec ?? 0; }
      for (const it of e.production?.queue ?? []) if (it.kind === 'unit') used += UNIT_DEFS[it.defId]?.pop ?? 0;
    }
    p.popUsed = used; p.popCap = Math.min(MAX_POP, cap);
    p.resources.energy += income * dt; p.stats.energyGenerated += income * dt;
  }
  for (const b of [...w.list]) {
    if (!b.alive || b.kind !== 'building') continue;
    const c = b.construction;
    if (c) {
      const builder = w.getAlive(c.builderId);
      if (builder && w.edgeDistance(builder, b) <= 1.0) {
        c.progress += dt;
        b.hp = Math.min(b.stats.maxHp, b.hp + (b.stats.maxHp * 0.9 * dt) / c.total);
        if (c.progress >= c.total) {
          b.construction = undefined;
          w.player(b.owner).stats.buildingsBuilt++;
          w.events.emit('constructionComplete', { building: b });
        }
      }
      continue;
    }
    const item = b.production?.queue[0];
    if (!item) continue;
    b.activity = 'producing';
    item.progress += dt;
    if (item.progress < item.total) continue;
    b.production!.queue.shift();
    if (item.kind === 'unit') {
      const def = b.def as BuildingDef;
      const out = b.rally?.pos ?? { x: b.pos.x, y: b.pos.y + def.footprint.h / 2 + 1 };
      const dir = normalize(sub(out, b.pos));
      const spawn = w.movement.nearestWalkable({ x: b.pos.x + dir.x * (def.footprint.w / 2 + 0.8), y: b.pos.y + (dir.y || 1) * (def.footprint.h / 2 + 0.8) }) ?? clone(b.pos);
      const u = w.spawnUnit(item.defId, b.owner, spawn, { facing: angleOf(dir) });
      w.player(b.owner).stats.unitsTrained++;
      w.events.emit('productionComplete', { building: b, unit: u });
      if (b.rally) {
        const o = w.resolveSmart(u, b.rally.pos, b.rally.targetId);
        if (o) w.setOrders(u, [o]);
      }
    } else {
      const p = w.player(b.owner);
      p.researching.delete(item.defId); p.upgrades.add(item.defId); p.stats.upgradesResearched++;
      w.recomputeStatsForPlayer(b.owner);
      w.events.emit('researchComplete', { playerId: b.owner, upgradeId: item.defId, building: b });
    }
    if (!b.production!.queue.length) b.activity = 'idle';
  }
}

// ───────────────────────── order handlers ─────────────────────────
function stubOrderHandlers(): OrderHandlerMap {
  return {
    move: {
      start: (w, e, o) => w.movement.moveTo(e, o.target),
      update: (w, e) => { e.activity = 'moving'; return w.movement.hasArrived(e) ? 'done' : 'running'; },
      stop: (w, e) => { w.movement.stop(e); e.activity = 'idle'; },
    },
    follow: {
      update: (w, e, o) => {
        const t = w.getAlive(o.targetId); if (!t) return 'done';
        if (w.edgeDistance(e, t) > 1.5) w.movement.moveToEntity(e, t, 1.0);
        e.activity = e.mover?.moving ? 'moving' : 'idle';
        return 'running';
      },
      stop: (w, e) => w.movement.stop(e),
    },
    attack: {
      update: (w, e, o, dt) => {
        const t = w.getAlive(o.targetId);
        if (!t || !w.combat.canTarget(e, t)) return 'done';
        return stubEngage(w, e, t, dt, true) ? 'running' : 'failed';
      },
      stop: (w, e) => { w.movement.stop(e); if (e.combat) e.combat.targetId = null; e.activity = 'idle'; },
    },
    attackMove: {
      start: (w, e, o) => w.movement.moveTo(e, o.target),
      update: (w, e, o, dt) => {
        const t = e.combat ? nearestEnemy(w, e, e.stats.sight) : null;
        if (t && stubEngage(w, e, t, dt, true)) return 'running';
        if (!e.mover?.moving || e.mover.goal?.x !== o.target.x) w.movement.moveTo(e, o.target);
        e.activity = 'moving';
        return w.movement.hasArrived(e) && dist(e.pos, o.target) < 1.5 ? 'done' : 'running';
      },
      stop: (w, e) => { w.movement.stop(e); e.activity = 'idle'; },
    },
    patrol: {
      start: (w, e, o) => w.movement.moveTo(e, o.to),
      update: (w, e, o, dt) => {
        const t = e.combat ? nearestEnemy(w, e, e.stats.sight) : null;
        if (t && stubEngage(w, e, t, dt, true)) return 'running';
        if (w.movement.hasArrived(e)) { const f = o.from; o.from = o.to; o.to = f; }
        w.movement.moveTo(e, o.to);
        e.activity = 'moving';
        return 'running';
      },
      stop: (w, e) => w.movement.stop(e),
    },
    hold: {
      start: (w, e) => { w.movement.stop(e); if (e.combat) e.combat.holdPosition = true; },
      update: (w, e, _o, dt) => {
        const t = e.combat ? nearestEnemy(w, e, e.stats.sight) : null;
        if (!t || !stubEngage(w, e, t, dt, false)) e.activity = 'idle';
        return 'running';
      },
      stop: (_w, e) => { if (e.combat) e.combat.holdPosition = false; },
    },
    ability: {
      update: (w, e, o) => { w.abilities.cast(e, o.abilityId, o.target, w.getAlive(o.targetId ?? null) ?? null); return 'done'; },
    },
    heal: { update: () => 'done' },
    gather: {
      update: (w, e, o, dt) => {
        const g = e.gatherer; if (!g) return 'failed';
        const cap = ((e.def as UnitDef).gather?.capacity ?? 5) + e.stats.gatherCapacityAdd;
        if (g.carrying >= cap) g.phase = 'toDropoff';
        if (g.phase === 'idle' || g.phase === 'waiting') g.phase = 'toNode';
        if (g.phase === 'toNode' || g.phase === 'gathering') {
          let node = w.getAlive(g.nodeId ?? o.targetId);
          if (!node) node = w.spatial.nearest(e.pos, 12, (r) => r.kind === 'resource') ?? undefined;
          if (!node) return g.carrying > 0 ? (g.phase = 'toDropoff', 'running') : 'done';
          g.nodeId = node.id;
          if (g.phase === 'toNode') {
            if (w.edgeDistance(e, node) > 0.4) { w.movement.moveToEntity(e, node, 0.3); e.activity = 'moving'; return 'running'; }
            w.movement.stop(e); g.phase = 'gathering'; g.timer = (e.def as UnitDef).gather?.gatherTime ?? 2;
          }
          e.activity = 'gathering';
          g.timer -= dt;
          if (g.timer > 0) return 'running';
          const take = Math.min(cap, node.resource!.amount);
          node.resource!.amount -= take; g.carrying = take; g.phase = 'toDropoff';
          if (node.resource!.amount <= 0) { w.events.emit('resourceDepleted', { node }); w.removeEntity(node); g.nodeId = null; }
        }
        const d = w.economy.nearestDropoff(e);
        if (!d) { e.activity = 'idle'; return 'running'; }
        e.activity = 'carrying';
        if (w.edgeDistance(e, d) > 0.4) { w.movement.moveToEntity(e, d, 0.3); return 'running'; }
        const amount = g.carrying * w.player(e.owner).gatherMul;
        w.economy.addResources(e.owner, { matter: amount });
        w.player(e.owner).stats.matterGathered += amount;
        w.events.emit('resourceDelivered', { worker: e, playerId: e.owner, kind: 'matter', amount });
        g.carrying = 0; g.phase = 'toNode';
        return 'running';
      },
      stop: (w, e) => { w.movement.stop(e); if (e.gatherer && e.gatherer.phase !== 'toDropoff') e.gatherer.phase = 'idle'; e.activity = 'idle'; },
    },
    returnCargo: {
      update: (w, e) => {
        const g = e.gatherer; if (!g || g.carrying <= 0) return 'done';
        const d = w.economy.nearestDropoff(e); if (!d) return 'failed';
        if (w.edgeDistance(e, d) > 0.4) { w.movement.moveToEntity(e, d, 0.3); return 'running'; }
        w.economy.addResources(e.owner, { matter: g.carrying }); g.carrying = 0;
        if (g.nodeId != null) { w.setOrders(e, [{ type: 'gather', targetId: g.nodeId }]); return 'running'; }
        return 'done';
      },
    },
    build: {
      update: (w, e, o) => {
        if (o.buildingId == null) {
          const def = getDef(o.defId) as BuildingDef;
          const c = footprintCenter(o.tile, def.footprint.w, def.footprint.h);
          if (dist(e.pos, c) > Math.max(def.footprint.w, def.footprint.h) / 2 + 1.2) { w.movement.moveTo(e, c, { arriveDistance: Math.max(def.footprint.w, def.footprint.h) / 2 + 1 }); e.activity = 'moving'; return 'running'; }
          w.movement.stop(e);
          const b = w.economy.placeFoundation(e.owner, o.defId, o.tile, e);
          if (!b) return 'failed';
          o.buildingId = b.id;
        }
        const b = w.getAlive(o.buildingId);
        if (!b) return 'failed';
        if (!b.construction) return 'done';
        b.construction.builderId = e.id;
        if (w.edgeDistance(e, b) > 0.8) { w.movement.moveToEntity(e, b, 0.4); return 'running'; }
        e.activity = 'building';
        return 'running';
      },
      stop: (w, e) => { w.movement.stop(e); e.activity = 'idle'; },
    },
    construct: {
      update: (w, e, o) => {
        const b = w.getAlive(o.targetId);
        if (!b || !b.construction) return 'done';
        b.construction.builderId = e.id;
        if (w.edgeDistance(e, b) > 0.8) { w.movement.moveToEntity(e, b, 0.4); return 'running'; }
        e.activity = 'building';
        return 'running';
      },
      stop: (w, e) => { w.movement.stop(e); e.activity = 'idle'; },
    },
    repair: { update: () => 'done' },
  };
}

function stubCombatSystem(w: World, dt: number): void {
  for (const e of w.list) {
    const c = e.combat;
    if (!e.alive || !c) continue;
    if (c.cooldown > 0) c.cooldown = Math.max(0, c.cooldown - dt);
    if (e.kind === 'building' && !e.construction) {
      const t = nearestEnemy(w, e, Math.max(...(e.def as BuildingDef).weapons.map((wp) => wp.range)) + 0.5);
      if (t) stubEngage(w, e, t, dt, false);
    }
  }
}

function stubIdle(w: World, e: Entity): void {
  if (e.activity !== 'idle' && !e.mover?.moving) e.activity = 'idle';
  if (!e.combat || e.gatherer || w.tick % 5 !== e.id % 5) return;
  const t = nearestEnemy(w, e, e.stats.sight);
  if (t) w.setOrders(e, [{ type: 'attack', targetId: t.id }]);
}

export function installStubs(world: World): void {
  world.movement = new StubMovement(world);
  world.vision = new StubVision(world);
  world.combat = new StubCombat(world);
  world.abilities = new StubAbilities(world);
  world.economy = new StubEconomy(world);
  world.orderHandlers = stubOrderHandlers();
  world.idleBehavior = stubIdle;
  world.addSystem({ name: 'movement', order: 30, update: stubMoveSystem });
  world.addSystem({ name: 'combat', order: 40, update: stubCombatSystem });
  world.addSystem({ name: 'economy', order: 50, update: stubEconomySystem });
}
