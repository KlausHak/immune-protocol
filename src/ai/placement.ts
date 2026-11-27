/**
 * [ai] Building placement search. Self-contained: candidate footprints are generated in square rings
 * around an anchor and validated with world.economy.canPlaceBuilding (so whatever placement rules the
 * economy enforces are respected automatically). On top of that the AI keeps mining lanes clear, keeps
 * a walkable gap around new buildings (no accidental walls), avoids keep-clear circles (army staging)
 * and footprints of foundations it has ordered but not yet placed.
 */
import type { PlayerId, TilePos, Vec2 } from '../core/types';
import { BUILDING_DEFS } from '../data';
import type { World } from '../sim/World';
import type { Site } from './brain';
import { pointRectDist, rectRectDist, rectsOverlap, segmentRectDist, type Rect } from './util';

export interface Lane { a: Vec2; b: Vec2 }

export interface PlaceOptions {
  anchor: Vec2;
  /** search radius in tiles (default 18) */
  maxRadius?: number;
  /** worker paths (hive → cache) to keep clear */
  lanes?: Lane[];
  laneRadius?: number;
  /** keep-clear circles */
  avoid?: Array<{ p: Vec2; r: number }>;
  /** footprints already claimed (ordered foundations) */
  reserved?: Rect[];
  /** tiles to skip (recent failures) */
  skip?: (tile: TilePos) => boolean;
  /** require a walkable 1-tile ring around the footprint on the first pass (default true) */
  spacing?: boolean;
  /** evaluate every ring up to maxRadius instead of stopping shortly after the first hit */
  exhaustive?: boolean;
  /** lower is better; default = distance from the anchor */
  score?: (rect: Rect, center: Vec2) => number;
}

export interface Spot { tile: TilePos; center: Vec2 }

const ringCache: Array<Array<[number, number]>> = [];
function ring(r: number): Array<[number, number]> {
  let out = ringCache[r];
  if (out) return out;
  out = [];
  if (r === 0) out.push([0, 0]);
  else {
    for (let x = -r; x <= r; x++) { out.push([x, -r]); out.push([x, r]); }
    for (let y = -r + 1; y <= r - 1; y++) { out.push([-r, y]); out.push([r, y]); }
  }
  ringCache[r] = out;
  return out;
}

function ringWalkable(world: World, tile: TilePos, w: number, h: number): boolean {
  const map = world.map;
  for (let y = tile.y - 1; y <= tile.y + h; y++) {
    for (let x = tile.x - 1; x <= tile.x + w; x++) {
      if (y !== tile.y - 1 && y !== tile.y + h && x !== tile.x - 1 && x !== tile.x + w) continue;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
      if (!world.movement.isWalkable({ x: x + 0.5, y: y + 0.5 })) return false;
    }
  }
  return true;
}

/** Cheap static/dynamic footprint test (map buildable, not blocked, no building/cache on it) before the full rules. */
function footprintOpen(world: World, tile: TilePos, w: number, h: number): boolean {
  const map = world.map;
  for (let y = tile.y; y < tile.y + h; y++) {
    for (let x = tile.x; x < tile.x + w; x++) {
      const i = y * map.width + x;
      if (!map.buildable[i] || map.blocked[i]) return false;
      if (!world.movement.isWalkable({ x: x + 0.5, y: y + 0.5 })) return false;
    }
  }
  return true;
}

function search(world: World, me: PlayerId, defId: string, o: PlaceOptions, spacing: boolean, lanes: boolean): Spot | null {
  const def = BUILDING_DEFS[defId]!;
  const { w, h } = def.footprint;
  const map = world.map;
  const ax = Math.round(o.anchor.x - w / 2), ay = Math.round(o.anchor.y - h / 2);
  const maxR = o.maxRadius ?? 18;
  const laneR = o.laneRadius ?? 1.6;
  /** AI-preference filters (cheap) */
  const prefOk = (tile: TilePos, rect: Rect): boolean => {
    if (tile.x < 1 || tile.y < 1 || tile.x + w > map.width - 1 || tile.y + h > map.height - 1) return false;
    if (lanes && o.lanes && o.lanes.some((l) => segmentRectDist(l.a, l.b, rect) < laneR)) return false;
    if (o.avoid && o.avoid.some((c) => pointRectDist(c.p, rect) < c.r)) return false;
    if (o.reserved && o.reserved.some((q) => rectsOverlap({ x: q.x - 1, y: q.y - 1, w: q.w + 2, h: q.h + 2 }, rect))) return false;
    return !(o.skip && o.skip(tile));
  };
  /** rules (footprint, gap ring, the economy's own placement check) */
  const valid = (tile: TilePos): boolean =>
    footprintOpen(world, tile, w, h) && (!spacing || ringWalkable(world, tile, w, h)) && world.economy.canPlaceBuilding(me, defId, tile).ok;
  const scoreOf = (rect: Rect): number => {
    const cx = rect.x + w / 2, cy = rect.y + h / 2;
    return o.score ? o.score(rect, { x: cx, y: cy }) : Math.hypot(cx - o.anchor.x, cy - o.anchor.y);
  };

  if (o.exhaustive) {
    // score every candidate cheaply, then validate best-first (usually only a handful of full checks)
    const cands: Array<{ tile: TilePos; s: number }> = [];
    for (let r = 0; r <= maxR; r++) {
      for (const [dx, dy] of ring(r)) {
        const tile = { x: ax + dx, y: ay + dy };
        const rect: Rect = { x: tile.x, y: tile.y, w, h };
        if (prefOk(tile, rect)) cands.push({ tile, s: scoreOf(rect) });
      }
    }
    cands.sort((a, b) => a.s - b.s || a.tile.y - b.tile.y || a.tile.x - b.tile.x);
    for (const c of cands) if (valid(c.tile)) return { tile: c.tile, center: { x: c.tile.x + w / 2, y: c.tile.y + h / 2 } };
    return null;
  }

  // ring search outward from the anchor; best score among the first rings that contain a valid spot
  let best: Spot | null = null, bestScore = Infinity, bestRing = -1;
  for (let r = 0; r <= maxR; r++) {
    if (best && r > bestRing + 1) break;
    for (const [dx, dy] of ring(r)) {
      const tile = { x: ax + dx, y: ay + dy };
      const rect: Rect = { x: tile.x, y: tile.y, w, h };
      if (!prefOk(tile, rect)) continue;
      const sc = scoreOf(rect);
      if (sc >= bestScore || !valid(tile)) continue;
      bestScore = sc;
      best = { tile, center: { x: tile.x + w / 2, y: tile.y + h / 2 } };
      if (bestRing < 0) bestRing = r;
    }
  }
  return best;
}

/**
 * Find a valid footprint for `defId` near `opts.anchor`. Passes relax the AI's own preferences
 * (spacing, then mining lanes) before giving up; the economy's rules are never relaxed.
 */
export function findBuildSpot(world: World, me: PlayerId, defId: string, opts: PlaceOptions): Spot | null {
  const def = BUILDING_DEFS[defId];
  if (!def) return null;
  if (!world.economy.meetsRequirements(me, def.requires)) return null;
  const passes: Array<[boolean, boolean]> = opts.spacing === false ? [[false, true], [false, false]] : [[true, true], [false, true], [false, false]];
  for (const [spacing, lanes] of passes) {
    if (!lanes && !opts.lanes?.length) continue;
    const spot = search(world, me, defId, opts, spacing, lanes);
    if (spot) return spot;
  }
  return null;
}

/**
 * Best Infection Core spot for a resource site: every cache ~3 tiles from the core's edge (short worker
 * trips, room to walk), never hugging a cache, slightly preferring the side facing `from`.
 */
export function findHiveSpot(world: World, me: PlayerId, hiveId: string, site: Site, from: Vec2, reserved: Rect[] = []): Spot | null {
  const caches: Rect[] = [];
  for (const n of site.nodes) {
    if (!n.alive) continue;
    const r = world.footRect(n);
    caches.push(r ?? { x: n.pos.x - 1, y: n.pos.y - 1, w: 2, h: 2 });
  }
  if (!caches.length) return null;
  const score = (rect: Rect, center: Vec2): number => {
    let s = 0;
    for (const c of caches) {
      const gap = rectRectDist(rect, c);
      s += Math.abs(gap - 3) + (gap < 1.5 ? 8 : 0);
    }
    return s + 0.02 * Math.hypot(center.x - from.x, center.y - from.y);
  };
  return findBuildSpot(world, me, hiveId, { anchor: site.center, maxRadius: 10, exhaustive: true, score, reserved, spacing: true });
}
