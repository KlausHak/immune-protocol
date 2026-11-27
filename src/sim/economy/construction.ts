/**
 * [economy] Construction & repair: 'build', 'construct', 'repair' order handlers and construction progress.
 *
 * build: walk next to the site → re-validate → push units off the footprint → spend → foundation (10% hp) →
 * construct. Up to MAX_BUILDERS workers ('construct' order) work on a foundation; each extra one adds ASSIST_BONUS
 * speed. No builder in range = paused. Workers that came from mining go back to their cache when the work chain
 * (including shift-queued builds) ends. Repair (hospital workers): mech units and own completed structures, costs
 * REPAIR_COST_FRACTION of the target's matter cost for a full repair.
 */
import { TICK_DT } from '../../config';
import type { BuildingDef, Entity, OrderStatus, UnitDef } from '../../core/types';
import { BUILDING_DEFS } from '../../data';
import type { OrderHandler } from '../services';
import type { World } from '../World';
import {
  ARRIVE_SLACK, ASSIST_BONUS, BUILD_RANGE, HEAL_EVENT_INTERVAL, MAX_BUILDERS, REPAIR_COST_FRACTION, REPAIR_RANGE,
  REPAIR_RATE_MAX, REPAIR_RATE_MIN, SITE_BLOCKED_PATIENCE, SWITCH_RADIUS,
} from './constants';
import { expandRect, footprintRect, perimeterPoints, pointRectDist, type Rect } from './geometry';
import { isGatherable, pickNode, releaseNode } from './gather';
import { notEnoughResource, notify, notifyFailure } from './messages';
import { approachEntity, approachPoint, faceToward, haltLeg, resetLeg } from './motion';
import { checkPlacement, normTile } from './placement';
import { workerEco, type WorkerEco } from './state';

// ───────────────────────── work chains (return to mining afterwards) ─────────────────────────

/** Called when a build/construct/repair order starts. Decides whether the worker returns to its cache afterwards. */
function beginWork(world: World, e: Entity, x: WorkerEco): void {
  const g = e.gatherer;
  if (g) {
    if (x.gatherStopTick === world.tick) x.resumeNodeId = g.nodeId;       // replaced a gather order just now
    else if (x.workEndTick !== world.tick) x.resumeNodeId = null;          // not chained to previous work
    releaseNode(world, e);
    g.phase = 'idle';
  }
  resetLeg(x);
  x.constructing = null;
  x.blockedTime = 0;
}

/** Order end (stop handler). */
function endWork(world: World, e: Entity): void {
  const x = workerEco(e);
  x.constructing = null;
  x.workEndTick = world.tick;
  resetLeg(x);
  world.movement.stop(e);
  e.activity = 'idle';
}

/** Finish a work order; with nothing else queued, a worker that came from mining goes back to it. */
function endChain(world: World, e: Entity, status: OrderStatus): OrderStatus {
  const x = workerEco(e);
  x.constructing = null;
  x.workEndTick = world.tick;
  if (e.orders.length === 1 && x.resumeNodeId != null && e.gatherer) {
    const n = world.getAlive(x.resumeNodeId);
    const node = isGatherable(n) ? n : pickNode(world, e, x.lastNodePos ?? e.pos, SWITCH_RADIUS);
    if (node) e.orders.splice(1, 0, { type: 'gather', targetId: node.id });
    x.resumeNodeId = null;
  }
  return status;
}

// ───────────────────────── builders ─────────────────────────

function isWorkingOn(u: Entity, b: Entity): boolean {
  if (!u.alive || workerEco(u).constructing !== b.id) return false;
  const o = u.orders[0];
  return !!o && ((o.type === 'build' && o.buildingId === b.id) || (o.type === 'construct' && o.targetId === b.id));
}

/** Workers actively constructing b right now (excluding `except`). */
export function activeBuilders(world: World, b: Entity, except?: Entity): number {
  let n = 0;
  for (const u of world.spatial.queryRadius(b.pos, b.radius + 4, (u) => u.kind === 'unit' && !!u.gatherer)) {
    if (u !== except && isWorkingOn(u, b)) n++;
  }
  return n;
}

function canWorkOn(e: Entity, b: Entity): boolean {
  const ud = e.def as UnitDef;
  return b.owner === e.owner && (ud.builds?.includes(b.defId) ?? false);
}

/** One tick of "stand next to the foundation and build". */
function constructStep(world: World, e: Entity, b: Entity, x: WorkerEco, dt: number): OrderStatus {
  const working = x.constructing === b.id;
  const d = world.edgeDistance(e, b);
  if (d > (working ? BUILD_RANGE + 0.6 : BUILD_RANGE)) {
    if (working) { x.constructing = null; resetLeg(x); }
    const r = approachEntity(world, e, b, BUILD_RANGE * 0.5);
    if (r === 'moving') { e.activity = 'moving'; return 'running'; }
    if (r === 'stuck') { notify(world, e.owner, 'invalidTarget', "Can't reach the construction site"); return endChain(world, e, 'failed'); }
  }
  if (x.legTarget != null) haltLeg(world, e);
  if (!working) {
    if (activeBuilders(world, b, e) >= MAX_BUILDERS) return endChain(world, e, 'done'); // site is full
    x.constructing = b.id;
  }
  const c = b.construction!;
  const primary = world.getAlive(c.builderId);
  if (!primary || !isWorkingOn(primary, b)) c.builderId = e.id;
  e.activity = 'building';
  faceToward(e, b.pos, dt);
  return 'running';
}

/** Walk-to point next to a not-yet-placed site: walkable, just outside the footprint, closest first. */
function siteApproachPoints(world: World, e: Entity, rect: Rect): Array<{ x: number; y: number }> {
  const ring = expandRect(rect, e.radius + 0.35);
  const pts = perimeterPoints(ring, 0.5).filter((p) => world.movement.isWalkable(p));
  pts.sort((a, b) => (a.x - e.pos.x) ** 2 + (a.y - e.pos.y) ** 2 - ((b.x - e.pos.x) ** 2 + (b.y - e.pos.y) ** 2));
  return pts;
}

/** An own foundation of the same type already standing on exactly this site (e.g. two workers sent to build it). */
function sameFoundation(world: World, e: Entity, defId: string, tile: { x: number; y: number }): Entity | null {
  const def = BUILDING_DEFS[defId];
  if (!def) return null;
  const c = { x: tile.x + def.footprint.w / 2, y: tile.y + def.footprint.h / 2 };
  for (const b of world.spatial.queryRadius(c, 1, (b) => b.kind === 'building')) {
    if (b.owner === e.owner && b.defId === defId && b.construction && b.tile?.x === tile.x && b.tile?.y === tile.y) return b;
  }
  return null;
}

export const buildHandler: OrderHandler<'build'> = {
  start(world, e, o) {
    const x = workerEco(e);
    beginWork(world, e, x);
    x.buildError = null;
    if (o.buildingId != null) return; // continue an existing foundation
    const def = BUILDING_DEFS[o.defId];
    const ud = e.def as UnitDef;
    if (!def) { x.buildError = { kind: 'invalidTarget', reason: 'Unknown structure' }; return; }
    if (!ud.builds?.includes(o.defId)) { x.buildError = { kind: 'invalidTarget', reason: `${ud.name} can't build a ${def.name}` }; return; }
    if (sameFoundation(world, e, o.defId, normTile(o.tile))) return; // will help build it
    const chk = checkPlacement(world, e.owner, o.defId, o.tile, e.id);
    if (!chk.ok && !chk.transient) { x.buildError = chk; return; }
    const r = world.players.get(e.owner)?.resources;
    if (r && r.matter < (def.cost.matter ?? 0) - 1e-9) x.buildError = { kind: 'matter', reason: notEnoughResource(world, e.owner, 'matter') };
    else if (r && r.energy < (def.cost.energy ?? 0) - 1e-9) x.buildError = { kind: 'energy', reason: notEnoughResource(world, e.owner, 'energy') };
  },
  update(world, e, o, dt) {
    const x = workerEco(e);
    if (x.buildError) { notifyFailure(world, e.owner, x.buildError); x.buildError = null; return endChain(world, e, 'failed'); }
    if (o.buildingId == null) {
      const def = BUILDING_DEFS[o.defId];
      if (!def) return endChain(world, e, 'failed');
      const tile = normTile(o.tile);
      const rect = footprintRect(tile, def.footprint.w, def.footprint.h);
      const gap = (): number => pointRectDist(e.pos, rect) - e.radius;
      let pts: Array<{ x: number; y: number }> | null = null;
      const r = approachPoint(world, e,
        () => { const g = gap(); return g >= -0.02 && g <= BUILD_RANGE; },
        () => { const g = gap(); return g >= -0.3 && g <= BUILD_RANGE + ARRIVE_SLACK; },
        (attempt) => { pts ??= siteApproachPoints(world, e, rect); return pts[Math.min(attempt, pts.length - 1)] ?? world.movement.nearestWalkable({ x: rect.x + rect.w / 2, y: rect.y + rect.h + 1 }, 6); });
      if (r === 'moving') { e.activity = 'moving'; return 'running'; }
      if (r === 'stuck' && gap() > BUILD_RANGE + 2) { notify(world, e.owner, 'placement', "Can't reach the build site"); return endChain(world, e, 'failed'); }
      // next to the site: re-validate, then lay the foundation
      if (x.legTarget != null) haltLeg(world, e);
      const twin = sameFoundation(world, e, o.defId, tile);
      if (twin) { o.buildingId = twin.id; return constructStep(world, e, twin, x, dt); } // someone already started it: help
      const chk = checkPlacement(world, e.owner, o.defId, tile, e.id);
      if (!chk.ok) {
        if (chk.transient && x.blockedTime < SITE_BLOCKED_PATIENCE) { x.blockedTime += dt; e.activity = 'idle'; return 'running'; }
        notifyFailure(world, e.owner, chk);
        return endChain(world, e, 'failed');
      }
      const b = world.economy.placeFoundation(e.owner, o.defId, tile, e);
      if (!b) return endChain(world, e, 'failed'); // placeFoundation already reported why
      o.buildingId = b.id;
      resetLeg(x);
    }
    const b = world.getAlive(o.buildingId);
    if (!b || b.kind !== 'building' || !b.construction) return endChain(world, e, 'done');
    return constructStep(world, e, b, x, dt);
  },
  stop(world, e) { endWork(world, e); },
};

export const constructHandler: OrderHandler<'construct'> = {
  start(world, e) { beginWork(world, e, workerEco(e)); },
  update(world, e, o, dt) {
    const b = world.getAlive(o.targetId);
    if (!b || b.kind !== 'building' || !b.construction) return endChain(world, e, 'done');
    if (!canWorkOn(e, b)) { notify(world, e.owner, 'invalidTarget', "Can't construct that"); return endChain(world, e, 'failed'); }
    return constructStep(world, e, b, workerEco(e), dt);
  },
  stop(world, e) { endWork(world, e); },
};

// ───────────────────────── construction progress (economy system) ─────────────────────────

function completeConstruction(world: World, b: Entity): void {
  b.construction = undefined;
  b.hp = Math.min(b.stats.maxHp, Math.max(1, b.hp));
  b.activity = 'idle';
  const p = world.players.get(b.owner);
  if (p) p.stats.buildingsBuilt++;
  world.events.emit('constructionComplete', { building: b });
}

/** Advance every foundation that has builders next to it (no builder = paused); complete those that are done. */
export function updateConstruction(world: World, dt: number): void {
  const builders = new Map<number, number>();
  const sites: Entity[] = [];
  for (const u of world.list) {
    if (!u.alive) continue;
    if (u.kind === 'building') { if (u.construction) sites.push(u); continue; }
    if (u.kind !== 'unit' || !u.gatherer) continue;
    const id = (u.ext.economy as WorkerEco | undefined)?.constructing;
    if (id == null) continue;
    const b = world.get(id);
    if (b && isWorkingOn(u, b)) builders.set(id, (builders.get(id) ?? 0) + 1);
  }
  for (const b of sites) {
    const c = b.construction;
    if (!b.alive || !c) continue;
    const total = Math.max(TICK_DT, c.total);
    const n = builders.get(b.id) ?? 0;
    if (n > 0 && c.progress < total) {
      const rate = 1 + ASSIST_BONUS * (Math.min(n, MAX_BUILDERS) - 1);
      const before = c.progress;
      c.progress = Math.min(total, c.progress + dt * rate);
      b.hp = Math.min(b.stats.maxHp, b.hp + (b.stats.maxHp * 0.9 * (c.progress - before)) / total);
    }
    if (c.progress >= total - 1e-9) completeConstruction(world, b);
  }
}

// ───────────────────────── repair ─────────────────────────

/** Hospital workers repair; pathogen workers cannot. */
export const canRepair = (e: Entity): boolean => !!e.gatherer && (e.def as UnitDef).faction === 'hospital';

/** Why `target` can't be repaired by e (null = repairable). Under-construction buildings are handled separately. */
export function repairBlocker(world: World, e: Entity, t: Entity): string | null {
  if (t.id === e.id) return "Can't repair itself";
  if (t.kind === 'building') return t.owner === e.owner ? null : 'Can only repair your own structures';
  if (t.kind === 'unit') return t.tags.has('mech') && world.isAlly(e.owner, t.owner) ? null : 'Can only repair mechanical units';
  return "Can't repair that";
}

/** hp/s one repairer restores (a full repair takes about the build time). */
export function repairRate(t: Entity): number {
  const def = t.def as BuildingDef | UnitDef;
  return Math.min(REPAIR_RATE_MAX, Math.max(REPAIR_RATE_MIN, t.stats.maxHp / Math.max(1, def.buildTime ?? 1)));
}

/** Matter per hp repaired (objective structures without a cost use a quarter of their max hp as the base). */
export function repairCostPerHp(t: Entity): number {
  const def = t.def as BuildingDef | UnitDef;
  const base = (def.cost?.matter ?? 0) > 0 ? def.cost.matter! : t.stats.maxHp * 0.25;
  return (REPAIR_COST_FRACTION * base) / Math.max(1, t.stats.maxHp);
}

function flushHeal(world: World, e: Entity, t: Entity | undefined, x: WorkerEco): void {
  if (x.healPending > 0 && t) world.events.emit('entityHealed', { entity: t, amount: x.healPending, source: e });
  x.healPending = 0;
  x.healTimer = HEAL_EVENT_INTERVAL;
}

export const repairHandler: OrderHandler<'repair'> = {
  start(world, e) {
    const x = workerEco(e);
    beginWork(world, e, x);
    x.healPending = 0;
    x.healTimer = HEAL_EVENT_INTERVAL;
  },
  update(world, e, o, dt) {
    const x = workerEco(e);
    const t = world.getAlive(o.targetId);
    if (!t) return endChain(world, e, 'done');
    if (!canRepair(e)) { notify(world, e.owner, 'invalidTarget', `${(e.def as UnitDef).name} can't repair`); return endChain(world, e, 'failed'); }
    if (t.kind === 'building' && t.construction) {
      if (t.owner !== e.owner) return endChain(world, e, 'failed');
      e.orders.splice(1, 0, { type: 'construct', targetId: t.id }); // repairing a foundation = helping build it
      x.workEndTick = world.tick;
      return 'done';
    }
    const why = repairBlocker(world, e, t);
    if (why) { notify(world, e.owner, 'invalidTarget', why); return endChain(world, e, 'failed'); }
    if (t.hp >= t.stats.maxHp - 1e-6) { flushHeal(world, e, t, x); return endChain(world, e, 'done'); }
    const inRange = world.edgeDistance(e, t) <= (e.activity === 'building' ? REPAIR_RANGE + 0.5 : REPAIR_RANGE);
    if (!inRange) {
      const r = approachEntity(world, e, t, REPAIR_RANGE * 0.5);
      if (r === 'moving') { e.activity = 'moving'; return 'running'; }
      if (r === 'stuck') { notify(world, e.owner, 'invalidTarget', "Can't reach the repair target"); return endChain(world, e, 'failed'); }
    }
    if (x.legTarget != null) haltLeg(world, e);
    const p = world.players.get(e.owner);
    if (!p) return 'failed';
    const heal = Math.min(repairRate(t) * dt, t.stats.maxHp - t.hp);
    const cost = heal * repairCostPerHp(t);
    if (cost > p.resources.matter + 1e-9) {
      flushHeal(world, e, t, x);
      notify(world, e.owner, 'matter', notEnoughResource(world, e.owner, 'matter'));
      return endChain(world, e, 'failed');
    }
    p.resources.matter = Math.max(0, p.resources.matter - cost);
    t.hp = Math.min(t.stats.maxHp, t.hp + heal);
    x.healPending += heal;
    x.healTimer -= dt;
    if (x.healTimer <= 0) flushHeal(world, e, t, x);
    e.activity = 'building';
    faceToward(e, t.pos, dt);
    return 'running';
  },
  stop(world, e, o) {
    flushHeal(world, e, world.getAlive(o.targetId), workerEco(e));
    endWork(world, e);
  },
};
