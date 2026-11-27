/**
 * [economy] Gathering: 'gather' / 'returnCargo' order handlers.
 *
 * Trip: toNode → (waiting while another worker holds the cache's single gathering slot; may bounce to a free
 * cache nearby) → gathering (gatherTime) → toDropoff (nearest completed own drop-off, short hand-over) → deliver
 * (× gatherMul) → back to the same cache. Depleted caches are removed and their workers switch to the best cache
 * nearby. Group gather commands are spread across the field up-front (see planSpread).
 *
 * GathererState.phase is kept accurate (the movement module disables unit collisions while a worker is in
 * toNode / waiting / gathering / toDropoff); any non-gathering order leaves the worker in 'idle'.
 */
import { clone, dist } from '../../core/math';
import type { BuildingDef, Command, Entity, EntityId, GathererState, GatherPhase, OrderStatus, UnitDef } from '../../core/types';
import type { OrderHandler } from '../services';
import type { World } from '../World';
import {
  ARRIVE_SLACK, BOUNCE_RADIUS, DROPOFF_RANGE, DROPOFF_TIME, GATHER_RANGE, MAX_BOUNCES, SATURATION_PENALTY,
  SLOT_HANDOFF, SPREAD_RADIUS, SWITCH_RADIUS, WAIT_RECHECK,
} from './constants';
import { notify } from './messages';
import { approachEntity, faceToward, haltLeg, resetLeg } from './motion';
import { nodeEco, workerEco, type WorkerEco } from './state';

type Step = OrderStatus | GatherPhase;
const isStatus = (s: Step): s is OrderStatus => s === 'running' || s === 'done' || s === 'failed';

// ───────────────────────── basics ─────────────────────────

export function isGatherable(n: Entity | null | undefined): n is Entity {
  return !!n && n.alive && n.kind === 'resource' && !!n.resource && n.resource.amount > 0;
}

/** Carry capacity per trip (def + upgrades). */
export function capacityOf(e: Entity): number {
  return Math.max(1, ((e.def as UnitDef).gather?.capacity ?? 5) + e.stats.gatherCapacityAdd);
}

export function gatherTimeOf(e: Entity): number {
  return Math.max(0.05, (e.def as UnitDef).gather?.gatherTime ?? 2.2);
}

/** A completed drop-off building owned by the worker's player. */
export function isOwnDropoff(b: Entity | null | undefined, worker: Entity): b is Entity {
  return !!b && b.alive && b.kind === 'building' && b.owner === worker.owner && !b.construction && !!(b.def as BuildingDef).dropoff;
}

function validDropoff(world: World, e: Entity, id: EntityId | null): Entity | null {
  const b = world.getAlive(id);
  return isOwnDropoff(b, e) ? b : null;
}

function setNode(e: Entity, node: Entity): void {
  e.gatherer!.nodeId = node.id;
  workerEco(e).lastNodePos = clone(node.pos);
}

// ───────────────────────── cache occupancy (one active gatherer per cache) ─────────────────────────

/** The worker currently holding the node's gathering slot (stale claims are cleared). */
export function occupantOf(world: World, node: Entity): Entity | null {
  const nx = nodeEco(node);
  if (nx.occupant != null) {
    const o = world.getAlive(nx.occupant);
    const g = o?.gatherer;
    if (o && g && g.phase === 'gathering' && g.nodeId === node.id && o.orders[0]?.type === 'gather' && workerEco(o).occupying === node.id) {
      if (node.resource) node.resource.activeGatherers = 1;
      return o;
    }
    nx.occupant = null;
  }
  if (node.resource) node.resource.activeGatherers = 0;
  return null;
}

/** Seconds until the node's gathering slot is free for a newcomer (0 = free now). */
function slotWait(world: World, node: Entity): number {
  const occ = occupantOf(world, node);
  const clearing = Math.max(0, nodeEco(node).busyUntil - world.time);
  return occ ? Math.max(0, occ.gatherer?.timer ?? 0) + SLOT_HANDOFF : clearing;
}

function claim(node: Entity, e: Entity): void {
  nodeEco(node).occupant = e.id;
  if (node.resource) node.resource.activeGatherers = 1;
  workerEco(e).occupying = node.id;
}

/** Give up the gathering slot this worker holds (if any). */
export function releaseNode(world: World, e: Entity): void {
  const x = workerEco(e);
  if (x.occupying == null) return;
  const node = world.get(x.occupying);
  if (node) {
    const nx = nodeEco(node);
    if (nx.occupant === e.id) { nx.occupant = null; if (node.resource) node.resource.activeGatherers = 0; }
  }
  x.occupying = null;
}

/** Remove an exhausted cache (emits resourceDepleted; its workers re-target on their next update). */
export function depleteNode(world: World, node: Entity): void {
  if (!node.alive) return;
  if (node.resource) { node.resource.amount = 0; node.resource.activeGatherers = 0; }
  nodeEco(node).occupant = null;
  world.events.emit('resourceDepleted', { node });
  world.removeEntity(node);
}

// ───────────────────────── choosing caches ─────────────────────────

export interface NodeLoad { assigned: number; incoming: number }

/** Workers with a current gather order per cache (`incoming` = walking to it or waiting at it). */
export function nodeLoads(world: World, exclude?: ReadonlySet<EntityId>): Map<EntityId, NodeLoad> {
  const m = new Map<EntityId, NodeLoad>();
  for (const u of world.list) {
    const g = u.gatherer;
    if (!g || g.nodeId == null || !u.alive || exclude?.has(u.id)) continue;
    if (u.orders[0]?.type !== 'gather') continue;
    let l = m.get(g.nodeId);
    if (!l) { l = { assigned: 0, incoming: 0 }; m.set(g.nodeId, l); }
    l.assigned++;
    if (g.phase === 'toNode' || g.phase === 'waiting') l.incoming++;
  }
  return m;
}

/** Best cache near `center` for worker e: close to the worker, preferring caches with fewer workers. */
export function pickNode(world: World, e: Entity, center: { x: number; y: number }, radius: number, excludeId?: EntityId): Entity | null {
  const loads = nodeLoads(world, new Set([e.id]));
  let best: Entity | null = null, bestScore = Infinity;
  for (const n of world.spatial.queryRadius(center, radius, isGatherable)) {
    if (n.id === excludeId) continue;
    const assigned = loads.get(n.id)?.assigned ?? 0;
    const score = dist(e.pos, n.pos) + SATURATION_PENALTY * assigned;
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && best && n.id < best.id)) { best = n; bestScore = score; }
  }
  return best;
}

/**
 * Spread workers sent to `target` evenly across the caches within SPREAD_RADIUS of it: every cache gets a 1st
 * worker (the clicked one first, then the nearest), then a 2nd, and so on. Stores a per-worker plan that the
 * gather order picks up when it starts.
 */
export function planSpread(world: World, workers: Entity[], target: Entity): void {
  if (!isGatherable(target) || workers.length === 0) return;
  const loads = nodeLoads(world, new Set(workers.map((u) => u.id)));
  // the field = caches near the target that are served by the same drop-off (don't spill into another base's field)
  const drops = world.entitiesOf(workers[0]!.owner, (b) => isOwnDropoff(b, workers[0]!));
  const servedBy = (n: Entity): Entity | null => {
    let best: Entity | null = null, bd = Infinity;
    for (const d of drops) { const dd = world.edgeDistanceToPoint(d, n.pos); if (dd < bd) { bd = dd; best = d; } }
    return best;
  };
  const home = servedBy(target);
  const field = world.spatial.queryRadius(target.pos, SPREAD_RADIUS, (n) => isGatherable(n) && servedBy(n) === home);
  if (!field.some((n) => n.id === target.id)) field.push(target);
  const count = new Map<EntityId, number>(field.map((n) => [n.id, loads.get(n.id)?.assigned ?? 0]));
  const dT = new Map<EntityId, number>(field.map((n) => [n.id, dist(n.pos, target.pos)]));
  const order = [...workers].sort((a, b) => dist(a.pos, target.pos) - dist(b.pos, target.pos) || a.id - b.id);
  for (const u of order) {
    let best = target, bestB = Infinity, bestD = Infinity;
    for (const n of field) {
      const b = count.get(n.id) ?? 0;
      const d = dT.get(n.id) ?? 0;
      if (b < bestB || (b === bestB && (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && n.id < best.id)))) { best = n; bestB = b; bestD = d; }
    }
    count.set(best.id, (count.get(best.id) ?? 0) + 1);
    workerEco(u).plan = best.id === target.id ? null : { target: target.id, node: best.id };
  }
}

/** commandIssued listener: any new command clears stale spread plans; group gathers get a fresh plan. */
export function onCommandIssued(world: World, cmd: Command): void {
  if (!('unitIds' in cmd) || !Array.isArray(cmd.unitIds)) return;
  const workers: Entity[] = [];
  for (const id of cmd.unitIds) {
    const u = world.getAlive(id);
    if (!u || u.owner !== cmd.playerId || u.kind !== 'unit' || !u.gatherer) continue;
    workerEco(u).plan = null;
    workers.push(u);
  }
  if ((cmd.type !== 'gather' && cmd.type !== 'smart') || workers.length < 2) return;
  const target = world.getAlive(cmd.targetId ?? null);
  if (isGatherable(target)) planSpread(world, workers, target);
}

/** Cache with nobody gathering, walking to or waiting at it (and < 2 workers) that e can reach before `wait` runs out. */
function freeNodeNear(world: World, e: Entity, node: Entity, wait: number): Entity | null {
  const loads = nodeLoads(world, new Set([e.id]));
  let best: Entity | null = null, bestT = Infinity;
  for (const n of world.spatial.queryRadius(node.pos, BOUNCE_RADIUS, isGatherable)) {
    if (n.id === node.id) continue;
    const l = loads.get(n.id);
    if (l && (l.incoming > 0 || l.assigned >= 2)) continue;
    if (slotWait(world, n) > 1e-9) continue;
    const t = world.edgeDistance(e, n) / Math.max(0.5, e.stats.speed) + 0.3;
    if (t < bestT - 1e-9) { bestT = t; best = n; }
  }
  return best && bestT < wait ? best : null;
}

/** Workers waiting at `node` that queued before e (first come, first served). */
function waitersAhead(world: World, e: Entity, node: Entity, x: WorkerEco): number {
  let n = 0;
  for (const u of world.spatial.queryRadius(node.pos, node.radius + 3, (u) => u.kind === 'unit' && u.id !== e.id && u.gatherer?.phase === 'waiting')) {
    if (u.gatherer!.nodeId !== node.id || u.orders[0]?.type !== 'gather') continue;
    const ux = workerEco(u);
    if (ux.waitSince < x.waitSince - 1e-9 || (Math.abs(ux.waitSince - x.waitSince) <= 1e-9 && u.id < e.id)) n++;
  }
  return n;
}

/** The worker's cache, or (if it is gone) the best replacement around where it was. */
function currentNode(world: World, e: Entity, g: GathererState, x: WorkerEco): Entity | null {
  const n = world.getAlive(g.nodeId);
  if (isGatherable(n)) return n;
  const center = x.lastNodePos ?? world.get(g.nodeId)?.pos ?? e.pos;
  const alt = pickNode(world, e, center, SWITCH_RADIUS);
  if (alt) { setNode(e, alt); return alt; }
  g.nodeId = null;
  return null;
}

// ───────────────────────── delivery ─────────────────────────

function deliver(world: World, e: Entity, g: GathererState, x: WorkerEco): void {
  const carried = g.carrying;
  g.carrying = 0;
  const p = world.players.get(e.owner);
  if (!p || carried <= 0) return;
  const mul = Number.isFinite(p.gatherMul) ? Math.max(0, p.gatherMul) : 1;
  const amount = carried * mul;
  const kind = x.cargo ?? 'matter';
  world.economy.addResources(e.owner, kind === 'matter' ? { matter: amount } : { energy: amount });
  if (kind === 'matter') p.stats.matterGathered += amount;
  world.events.emit('resourceDelivered', { worker: e, playerId: e.owner, kind, amount });
}

// ───────────────────────── phases ─────────────────────────

function enter(world: World, e: Entity, g: GathererState, x: WorkerEco, phase: GatherPhase): void {
  g.phase = phase;
  resetLeg(x);
  if (phase === 'gathering') {
    const node = world.getAlive(g.nodeId);
    if (node) claim(node, e);
    g.timer = gatherTimeOf(e);
    e.activity = 'gathering';
  } else if (phase === 'waiting') {
    x.waitSince = world.time;
    x.waitCheck = 0;
    e.activity = 'idle';
  } else if (phase === 'toDropoff') {
    x.dwell = 0;
  }
}

function stepToNode(world: World, e: Entity, g: GathererState, x: WorkerEco): Step {
  const node = currentNode(world, e, g, x);
  if (!node) return g.carrying > 0 ? 'toDropoff' : 'done';
  const r = approachEntity(world, e, node, GATHER_RANGE);
  if (r === 'moving') { e.activity = 'moving'; return 'running'; }
  if (r === 'stuck') {
    if (x.bounces < MAX_BOUNCES + 2) {
      const alt = pickNode(world, e, node.pos, BOUNCE_RADIUS, node.id);
      if (alt) { x.bounces++; setNode(e, alt); resetLeg(x); return 'running'; }
    }
    e.activity = 'idle';
    return 'failed';
  }
  haltLeg(world, e);
  return slotWait(world, node) > 1e-9 ? 'waiting' : 'gathering';
}

function stepWaiting(world: World, e: Entity, g: GathererState, x: WorkerEco, dt: number): Step {
  const node = world.getAlive(g.nodeId);
  if (!isGatherable(node)) return 'toNode';
  if (world.edgeDistance(e, node) > GATHER_RANGE + ARRIVE_SLACK + 0.5) return 'toNode'; // got pushed away
  e.activity = 'idle';
  faceToward(e, node.pos, dt);
  const slot = slotWait(world, node);
  const ahead = waitersAhead(world, e, node, x);
  if (slot <= 1e-9 && ahead === 0) return 'gathering';
  x.waitCheck -= dt;
  if (x.waitCheck <= 0) {
    x.waitCheck = WAIT_RECHECK;
    if (x.bounces < MAX_BOUNCES) {
      const wait = slot + ahead * (gatherTimeOf(e) + SLOT_HANDOFF);
      const alt = freeNodeNear(world, e, node, wait);
      if (alt) { x.bounces++; setNode(e, alt); return 'toNode'; }
    }
  }
  return 'running';
}

function stepGathering(world: World, e: Entity, g: GathererState, x: WorkerEco, dt: number): Step {
  const node = world.getAlive(g.nodeId);
  if (!isGatherable(node)) { releaseNode(world, e); return 'toNode'; }
  if (nodeEco(node).occupant !== e.id) {
    const occ = occupantOf(world, node);
    if (occ && occ !== e) { releaseNode(world, e); return 'waiting'; }
    claim(node, e); // our claim went stale (validation) but nobody took the slot
  }
  e.activity = 'gathering';
  faceToward(e, node.pos, dt);
  g.timer -= dt;
  if (g.timer > 1e-9) return 'running';
  const res = node.resource!;
  const take = Math.min(Math.max(0, capacityOf(e) - g.carrying), res.amount);
  res.amount = Math.max(0, res.amount - take);
  g.carrying += take;
  x.cargo = res.kind;
  x.lastNodePos = clone(node.pos);
  x.bounces = 0;
  releaseNode(world, e);
  nodeEco(node).busyUntil = world.time + SLOT_HANDOFF;
  if (res.amount <= 1e-6) depleteNode(world, node);
  return g.carrying > 0 ? 'toDropoff' : 'toNode';
}

function stepToDropoff(world: World, e: Entity, g: GathererState, x: WorkerEco, dt: number): Step {
  if (g.carrying <= 1e-9) { g.carrying = 0; return 'toNode'; }
  let d = validDropoff(world, e, g.dropoffId);
  if (!d) {
    x.dwell = 0;
    d = world.economy.nearestDropoff(e);
    g.dropoffId = d?.id ?? null;
    if (!d) { haltLeg(world, e); e.activity = 'idle'; return 'running'; } // hold the load until a drop-off exists
  }
  if (x.dwell > 0) {
    e.activity = 'carrying';
    x.dwell -= dt;
    if (x.dwell > 1e-9) return 'running';
    x.dwell = 0;
    deliver(world, e, g, x);
    return 'toNode';
  }
  const r = approachEntity(world, e, d, DROPOFF_RANGE);
  if (r === 'moving') { e.activity = 'carrying'; return 'running'; }
  if (r === 'stuck') { g.dropoffId = null; resetLeg(x); e.activity = 'idle'; return 'running'; } // re-pick next tick
  haltLeg(world, e);
  faceToward(e, d.pos, dt);
  e.activity = 'carrying';
  if (DROPOFF_TIME > 0) { x.dwell = DROPOFF_TIME; return 'running'; }
  deliver(world, e, g, x);
  return 'toNode';
}

function stepPhase(world: World, e: Entity, g: GathererState, x: WorkerEco, dt: number): Step {
  switch (g.phase) {
    case 'toNode': return stepToNode(world, e, g, x);
    case 'waiting': return stepWaiting(world, e, g, x, dt);
    case 'gathering': return stepGathering(world, e, g, x, dt);
    case 'toDropoff': return stepToDropoff(world, e, g, x, dt);
    default: return g.carrying >= capacityOf(e) ? 'toDropoff' : 'toNode';
  }
}

// ───────────────────────── order handlers ─────────────────────────

export const gatherHandler: OrderHandler<'gather'> = {
  start(world, e, o) {
    const g = e.gatherer;
    if (!g) return;
    const x = workerEco(e);
    releaseNode(world, e);
    resetLeg(x);
    x.dwell = 0; x.bounces = 0; x.gatherInvalid = null;
    g.dropoffId = null;
    const t = world.getAlive(o.targetId);
    if (t && t.kind === 'resource') {
      let node: Entity = t;
      if (x.plan && x.plan.target === t.id) { const pn = world.getAlive(x.plan.node); if (isGatherable(pn)) node = pn; }
      if (isGatherable(node)) setNode(e, node);
      else { const alt = pickNode(world, e, t.pos, SWITCH_RADIUS); if (alt) setNode(e, alt); else g.nodeId = null; }
    } else if (t) {
      x.gatherInvalid = g.carrying > 0 && isOwnDropoff(t, e) ? 'return' : 'invalid';
    } else {
      // the cache vanished between command and start (depleted): use the area it was in
      const last = world.get(o.targetId);
      const alt = pickNode(world, e, last?.pos ?? x.lastNodePos ?? e.pos, SWITCH_RADIUS);
      if (alt) setNode(e, alt); else g.nodeId = null;
    }
    x.plan = null;
    g.phase = g.carrying >= capacityOf(e) ? 'toDropoff' : 'toNode';
  },
  update(world, e, o, dt) {
    const g = e.gatherer;
    if (!g) return 'failed';
    const x = workerEco(e);
    if (x.gatherInvalid === 'return') { x.gatherInvalid = null; e.orders.splice(1, 0, { type: 'returnCargo', targetId: o.targetId }); return 'done'; }
    if (x.gatherInvalid === 'invalid') { x.gatherInvalid = null; notify(world, e.owner, 'invalidTarget', 'Must target a Supply Cache'); return 'failed'; }
    if (e.orders.length > 1) return 'done'; // a queued command takes over (build chains bring the worker back)
    for (let guard = 0; guard < 6; guard++) {
      const s = stepPhase(world, e, g, x, dt);
      if (isStatus(s)) return s;
      enter(world, e, g, x, s);
    }
    return 'running';
  },
  stop(world, e) {
    releaseNode(world, e);
    const x = workerEco(e);
    x.gatherStopTick = world.tick;
    resetLeg(x);
    x.dwell = 0;
    if (e.gatherer) e.gatherer.phase = 'idle';
    world.movement.stop(e);
    e.activity = 'idle';
  },
};

/** After returning cargo, a worker with a cache goes back to mining (unless more orders are queued). */
function resumeAfterReturn(world: World, e: Entity): OrderStatus {
  const g = e.gatherer;
  if (g && e.orders.length === 1 && g.nodeId != null) {
    const n = world.getAlive(g.nodeId);
    const node = isGatherable(n) ? n : pickNode(world, e, workerEco(e).lastNodePos ?? e.pos, SWITCH_RADIUS);
    if (node) e.orders.splice(1, 0, { type: 'gather', targetId: node.id });
  }
  return 'done';
}

export const returnCargoHandler: OrderHandler<'returnCargo'> = {
  start(world, e, o) {
    const g = e.gatherer;
    if (!g) return;
    const x = workerEco(e);
    releaseNode(world, e);
    resetLeg(x);
    x.dwell = 0;
    g.phase = g.carrying > 0 ? 'toDropoff' : 'idle';
    g.dropoffId = o.targetId != null ? validDropoff(world, e, o.targetId)?.id ?? null : null;
  },
  update(world, e, _o, dt) {
    const g = e.gatherer;
    if (!g) return 'failed';
    if (g.carrying <= 1e-9) return resumeAfterReturn(world, e);
    if (!validDropoff(world, e, g.dropoffId) && !world.economy.nearestDropoff(e)) { e.activity = 'idle'; return 'failed'; }
    g.phase = 'toDropoff';
    const s = stepToDropoff(world, e, g, workerEco(e), dt);
    return s === 'running' ? 'running' : resumeAfterReturn(world, e);
  },
  stop(world, e) {
    const x = workerEco(e);
    resetLeg(x);
    x.dwell = 0;
    if (e.gatherer) e.gatherer.phase = 'idle';
    world.movement.stop(e);
    e.activity = 'idle';
  },
};
