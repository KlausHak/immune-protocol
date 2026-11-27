/**
 * [economy] Production progress: the head of each completed building's queue advances; finished units spawn on
 * a free walkable spot of the building edge facing the rally point and receive the rally order
 * (world.resolveSmart — workers rallied to a cache start gathering); finished research is applied to the player.
 */
import { angleOf, dist, normalize, sub } from '../../core/math';
import type { Entity, ProductionItem, UnitDef, Vec2 } from '../../core/types';
import { UNIT_DEFS } from '../../data';
import type { World } from '../World';
import { expandRect, perimeterPoints, rayRectExit } from './geometry';
import { isGatherable, planSpread } from './gather';

/** Where the building's rally points (target entity position, else the rally point); null = no rally. */
function rallyTarget(world: World, b: Entity): Vec2 | null {
  const r = b.rally;
  if (!r || r.targetId === b.id) return null;
  return world.getAlive(r.targetId ?? null)?.pos ?? r.pos;
}

/** Free (or least bad) spot just outside the building footprint, on the side facing `toward`. */
export function spawnPoint(world: World, b: Entity, def: UnitDef, toward: Vec2 | null): Vec2 {
  const rect = world.footRect(b);
  if (!rect) return world.movement.nearestWalkable(b.pos, 6) ?? { x: b.pos.x, y: b.pos.y };
  const flying = def.tags.includes('air');
  let dir = toward ? normalize(sub(toward, b.pos)) : { x: 0, y: 1 };
  if (dir.x === 0 && dir.y === 0) dir = { x: 0, y: 1 };
  const W = world.map.width, H = world.map.height;
  let best: Vec2 | null = null, bestScore = Infinity;
  let crowded: Vec2 | null = null, crowdedScore = Infinity;
  for (let ring = 0; ring < 3; ring++) {
    const ex = expandRect(rect, def.radius + 0.12 + ring);
    const ideal = rayRectExit(b.pos, dir, ex);
    for (const p of perimeterPoints(ex, 0.5)) {
      if (p.x < 1 || p.y < 1 || p.x > W - 1 || p.y > H - 1) continue;
      if (!flying && !world.movement.isWalkable(p)) continue;
      const score = dist(p, ideal) + ring * 3;
      const occupied = !flying && world.spatial.queryRadius(p, def.radius + 0.05, (o) => o.kind === 'unit' && !o.mover?.flying).length > 0;
      if (!occupied) { if (score < bestScore) { best = p; bestScore = score; } }
      else if (score < crowdedScore) { crowded = p; crowdedScore = score; }
    }
  }
  return best ?? crowded ?? world.movement.nearestWalkable(b.pos, 8) ?? { x: b.pos.x, y: rect.y + rect.h + def.radius + 0.12 };
}

function finishUnit(world: World, b: Entity, item: ProductionItem): void {
  const def = UNIT_DEFS[item.defId];
  if (!def) return;
  const toward = rallyTarget(world, b);
  const pos = spawnPoint(world, b, def, toward);
  const u = world.spawnUnit(item.defId, b.owner, pos, { facing: angleOf(sub(pos, b.pos)) });
  const p = world.players.get(b.owner);
  if (p) p.stats.unitsTrained++;
  const r = b.rally;
  if (r && r.targetId !== b.id) {
    const o = world.resolveSmart(u, r.pos, r.targetId);
    if (o) {
      if (o.type === 'gather' && u.gatherer) {
        const node = world.getAlive(o.targetId);
        if (isGatherable(node)) planSpread(world, [u], node); // don't pile every new worker onto one cache
      }
      world.setOrders(u, [o]);
    }
  }
  world.events.emit('productionComplete', { building: b, unit: u });
}

function finishResearch(world: World, b: Entity, item: ProductionItem): void {
  const p = world.players.get(b.owner);
  if (!p) return;
  p.researching.delete(item.defId);
  if (!p.upgrades.has(item.defId)) {
    p.upgrades.add(item.defId);
    p.stats.upgradesResearched++;
    world.recomputeStatsForPlayer(b.owner);
  }
  world.events.emit('researchComplete', { playerId: b.owner, upgradeId: item.defId, building: b });
}

/** Advance production queues of completed buildings (nothing progresses while under construction). */
export function updateProduction(world: World, dt: number): void {
  const n = world.list.length; // units spawned below are appended; no need to visit them
  for (let i = 0; i < n; i++) {
    const b = world.list[i]!;
    if (!b.alive || b.kind !== 'building' || !b.production || b.construction) continue;
    const q = b.production.queue;
    if (q.length === 0) { if (b.activity === 'producing') b.activity = 'idle'; continue; }
    const item = q[0]!;
    b.activity = 'producing';
    item.progress = Math.min(item.total, item.progress + dt);
    if (item.progress < item.total - 1e-9) continue;
    q.shift();
    try {
      if (item.kind === 'unit') finishUnit(world, b, item);
      else finishResearch(world, b, item);
    } catch (err) {
      console.error('[economy] production completion failed', item, err);
    }
    if (q.length === 0 && b.activity === 'producing') b.activity = 'idle';
  }
}
