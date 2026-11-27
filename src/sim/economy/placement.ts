/**
 * [economy] Building placement rules (canPlaceBuilding) and the findBuildSpot() search used by the AI / controls.
 *
 * Rules: footprint in bounds, every tile buildable & not blocked, every tile explored by the player, no overlap
 * with structures or Supply Caches, HQs keep HQ_RESOURCE_GAP tiles from every cache, requirements met, and
 * movement.isFootprintFree(...) ignoring the builder and all non-enemy ground units (those are pushed out of
 * the footprint when the foundation is placed). Enemy ground units on the site block it ("Something is in the
 * way" — transient: a builder waits a few seconds for it to clear).
 */
import { inBounds, tileIndex } from '../../core/terrain';
import type { BuildingDef, EntityId, PlayerId, TilePos, Vec2 } from '../../core/types';
import { BUILDING_DEFS } from '../../data';
import type { World } from '../World';
import { HQ_RESOURCE_GAP, LANE_HALF_WIDTH, LANE_RADIUS } from './constants';
import {
  circleOverlapsRect, closestPointInRect, footprintRect, rectRectDist, rectsOverlap, segRectDist, type Rect,
} from './geometry';
import { fail, OK, requiresMessage, type CheckResult } from './messages';
import { missingRequirements } from './requirements';

export const normTile = (t: TilePos): TilePos => ({ x: Math.round(t.x), y: Math.round(t.y) });

/** Full placement check (requirements + site). */
export function checkPlacement(world: World, playerId: PlayerId, defId: string, tile: TilePos, builderId?: EntityId): CheckResult {
  const def = BUILDING_DEFS[defId];
  if (!def) return fail('invalidTarget', 'Unknown structure');
  if (def.buildable === false) return fail('invalidTarget', `${def.name} can't be built`);
  if (!world.players.has(playerId)) return fail('invalidTarget', 'Unknown player');
  const missing = missingRequirements(world, playerId, def.requires);
  if (missing.length) return fail('requirement', requiresMessage(missing));
  return checkSite(world, playerId, def, tile, builderId);
}

function terrainOk(world: World, r: Rect): boolean {
  const { map } = world;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    if (!inBounds(map, x, y)) return false;
    const i = tileIndex(map, x, y);
    if (!map.buildable[i] || map.blocked[i]) return false;
  }
  return true;
}

/** Geometry part of the placement rules (no tech requirements). */
export function checkSite(world: World, playerId: PlayerId, def: BuildingDef, tileIn: TilePos, builderId?: EntityId): CheckResult {
  if (!Number.isFinite(tileIn.x) || !Number.isFinite(tileIn.y)) return fail('placement', "Can't build there");
  const tile = normTile(tileIn);
  const { w, h } = def.footprint;
  const rect = footprintRect(tile, w, h);
  if (!terrainOk(world, rect)) return fail('placement', "Can't build there");
  for (let y = tile.y; y < tile.y + h; y++) for (let x = tile.x; x < tile.x + w; x++) {
    if (!world.vision.isExplored(playerId, { x: x + 0.5, y: y + 0.5 })) return fail('placement', "Can't build in unexplored territory");
  }
  // structures & resource nodes
  const c = { x: tile.x + w / 2, y: tile.y + h / 2 };
  for (const o of world.spatial.queryRadius(c, Math.hypot(w, h) / 2 + HQ_RESOURCE_GAP + 4, (o) => o.kind !== 'unit')) {
    const r = world.footRect(o);
    if (!r) continue;
    if (o.kind === 'resource') {
      if (rectsOverlap(rect, r)) return fail('placement', `Can't build on a ${o.def.name}`);
      if (def.hq && rectRectDist(rect, r) < HQ_RESOURCE_GAP - 1e-6) return fail('placement', `Too close to a ${o.def.name}`);
    } else if (rectsOverlap(rect, r)) {
      return fail('placement', "Can't build there");
    }
  }
  // ground units: friendly/neutral ones get pushed out of the way, enemies block
  const ignore: EntityId[] = builderId != null ? [builderId] : [];
  let enemyInTheWay = false;
  for (const u of world.spatial.queryRect(rect.x - 2.5, rect.y - 2.5, rect.x + w + 2.5, rect.y + h + 2.5, (u) => u.kind === 'unit' && !u.mover?.flying)) {
    if (u.id === builderId) continue;
    if (world.isEnemy(playerId, u.owner)) { if (circleOverlapsRect(u.pos, u.radius, rect)) enemyInTheWay = true; }
    else ignore.push(u.id);
  }
  if (enemyInTheWay) return fail('placement', 'Something is in the way', true);
  if (!world.movement.isFootprintFree(tile, w, h, ignore)) return fail('placement', "Can't build there");
  return OK;
}

// ───────────────────────── findBuildSpot ─────────────────────────

const SPIRAL_MAX = 64;
let spiralCache: Int32Array | null = null; // triples (dx, dy, d²) sorted by distance, then angle

function spiral(): Int32Array {
  if (spiralCache) return spiralCache;
  const pts: Array<[number, number, number, number]> = [];
  for (let dy = -SPIRAL_MAX; dy <= SPIRAL_MAX; dy++) for (let dx = -SPIRAL_MAX; dx <= SPIRAL_MAX; dx++) {
    const d2 = dx * dx + dy * dy;
    if (d2 <= SPIRAL_MAX * SPIRAL_MAX) pts.push([dx, dy, d2, Math.atan2(dy, dx)]);
  }
  pts.sort((a, b) => a[2] - b[2] || a[3] - b[3]);
  const out = new Int32Array(pts.length * 3);
  pts.forEach((p, i) => { out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2]; });
  spiralCache = out;
  return out;
}

export interface Lane { a: Vec2; b: Vec2 }

/** Worker lanes: segments from each of the player's drop-offs to every cache within LANE_RADIUS of it. */
export function resourceLanes(world: World, playerId: PlayerId): Lane[] {
  const lanes: Lane[] = [];
  for (const d of world.entitiesOf(playerId, (e) => e.kind === 'building' && !!(e.def as BuildingDef).dropoff)) {
    const dr = world.footRect(d);
    if (!dr) continue;
    for (const n of world.spatial.queryRadius(d.pos, LANE_RADIUS, (n) => n.kind === 'resource')) {
      lanes.push({ a: closestPointInRect(n.pos, dr), b: { x: n.pos.x, y: n.pos.y } });
    }
  }
  return lanes;
}

/**
 * Nearest valid placement (top-left tile) for `defId` around `near`, searching outward up to `maxRadius` tiles
 * (default 24). Besides canPlaceBuilding's rules it keeps a 1-tile gap to every other structure / cache and, unless
 * `avoidResourceLanes === false`, stays out of the lanes between the player's drop-offs and their caches.
 * Returns null when nothing fits (or requirements are missing).
 */
export function findBuildSpot(
  world: World, playerId: PlayerId, defId: string, near: Vec2,
  opts?: { maxRadius?: number; avoidResourceLanes?: boolean },
): TilePos | null {
  const def = BUILDING_DEFS[defId];
  if (!def || def.buildable === false || !world.players.has(playerId)) return null;
  if (!near || !Number.isFinite(near.x) || !Number.isFinite(near.y)) return null;
  if (missingRequirements(world, playerId, def.requires).length) return null;
  const maxR = Math.max(0, Math.min(SPIRAL_MAX, Math.floor(opts?.maxRadius ?? 24)));
  const lanes = opts?.avoidResourceLanes === false ? [] : resourceLanes(world, playerId);
  const { w, h } = def.footprint;
  const base = { x: Math.round(near.x - w / 2), y: Math.round(near.y - h / 2) };
  const rects: Rect[] = [];
  for (const o of world.spatial.queryRadius(near, maxR + Math.hypot(w, h) + 6, (o) => o.kind !== 'unit')) {
    const r = world.footRect(o);
    if (r) rects.push(r);
  }
  const sp = spiral();
  const maxD2 = maxR * maxR;
  for (let i = 0; i < sp.length; i += 3) {
    if (sp[i + 2]! > maxD2) break;
    const tile = { x: base.x + sp[i]!, y: base.y + sp[i + 1]! };
    const rect = footprintRect(tile, w, h);
    if (!terrainOk(world, rect)) continue;
    let bad = false;
    for (const r of rects) if (rectRectDist(rect, r) < 1 - 1e-6) { bad = true; break; }
    if (!bad) for (const l of lanes) if (segRectDist(l.a, l.b, rect) < LANE_HALF_WIDTH) { bad = true; break; }
    if (bad) continue;
    if (checkSite(world, playerId, def, tile).ok) return tile;
  }
  return null;
}
