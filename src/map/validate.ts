/**
 * [map] Map validation & ground-distance utilities. Headless (Node) safe; used by MapBuilder.validate(),
 * tests/map and the sandbox debug view.
 *
 * Static obstacles for every check = map.blocked ∪ Supply Cache footprints ∪ the slot HQ footprints (World blocks
 * caches and HQs dynamically as soon as they spawn, so the map must stay connected with them in place).
 * Ground moves are 8-neighbour without corner cutting (connectivity uses the stricter 4-neighbour flood).
 */
import type { MapData, MapRegion, Vec2 } from '../core/types';
import { FACTIONS, getBuildingDef } from '../data';

export interface SiteSpec {
  name: string;
  /** top-left tile and size (tiles) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** minimum edge gap (tiles) to any Supply Cache footprint */
  minCacheGap?: number;
}
/** Two named places (point / region / 'slot1' / 'slot2') that must be joined by a corridor ≥ width tiles wide. */
export interface CorridorSpec { from: string; to: string; width: number }
/** Path length slot1 → via[0] → … → slot2 (or from/to if given), reported in stats.lanes. */
export interface LaneSpec { name: string; via: string[]; from?: string; to?: string }
export interface MapRequirements {
  regions?: string[];
  points?: string[];
  sites?: SiteSpec[];
  corridors?: CorridorSpec[];
  lanes?: LaneSpec[];
}

export interface MapStats {
  walkable: number;
  buildable: number;
  blocked: number;
  ramps: number;
  water: number;
  doodads: number;
  decals: number;
  caches: number;
  /** ground path distance (tiles) between the slot-1 and slot-2 HQ edges; null if unreachable */
  slotDistance: number | null;
  lanes: Record<string, number | null>;
  /** caches nearer (by ground path, with a 6-tile margin) to slot 1 / slot 2, and the contested rest */
  cachesNearer: { slot1: number; slot2: number; contested: number };
}

export interface ValidationReport { ok: boolean; errors: string[]; warnings: string[]; stats: MapStats }

export interface TileRect { x: number; y: number; w: number; h: number }

// ───────────────────────────── footprints & obstacles ─────────────────────────────
/** Tile rect of the 2×2 Supply Cache World.spawnResource() creates at `pos`. */
export function cacheRect(pos: Vec2): TileRect { return { x: Math.round(pos.x - 1), y: Math.round(pos.y - 1), w: 2, h: 2 }; }

/** Tile rect of the HQ spawnSkirmishStart() places for a slot (null for factions without an HQ). */
export function slotHqRect(slot: MapData['slots'][number]): TileRect | null {
  const hq = FACTIONS[slot.faction]?.hq;
  if (!hq) return null;
  const { w, h } = getBuildingDef(hq).footprint;
  return { x: Math.round(slot.start.x - w / 2), y: Math.round(slot.start.y - h / 2), w, h };
}

/** blocked ∪ caches ∪ slot HQ footprints. */
export function obstacleGrid(map: MapData, opts: { caches?: boolean; hqs?: boolean } = {}): Uint8Array {
  const W = map.width, H = map.height;
  const g = map.blocked.slice();
  const mark = (r: TileRect) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = 1;
  };
  if (opts.caches !== false) for (const r of map.resources) mark(cacheRect(r.pos));
  if (opts.hqs !== false) for (const s of map.slots) { const r = slotHqRect(s); if (r) mark(r); }
  return g;
}

const rectDist = (a: TileRect, b: TileRect): number => {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.hypot(dx, dy);
};

// ───────────────────────────── distance fields ─────────────────────────────
class MinHeap {
  private idx: number[] = [];
  private key: number[] = [];
  get size(): number { return this.idx.length; }
  push(i: number, k: number): void {
    const a = this.idx, b = this.key;
    a.push(i); b.push(k);
    let n = a.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (b[p]! <= k) break;
      a[n] = a[p]!; b[n] = b[p]!; n = p;
    }
    a[n] = i; b[n] = k;
  }
  pop(): [number, number] {
    const a = this.idx, b = this.key;
    const top: [number, number] = [a[0]!, b[0]!];
    const li = a.pop()!, lk = b.pop()!;
    if (a.length) {
      let n = 0;
      for (;;) {
        const l = 2 * n + 1, r = l + 1;
        let m = n, mk = lk;
        if (l < a.length && b[l]! < mk) { m = l; mk = b[l]!; }
        if (r < a.length && b[r]! < mk) { m = r; mk = b[r]!; }
        if (m === n) break;
        a[n] = a[m]!; b[n] = b[m]!; n = m;
      }
      a[n] = li; b[n] = lk;
    }
    return top;
  }
}

export interface Seed { i: number; d: number }

/** Dijkstra ground distance (tiles) from seeds; 8-neighbour, no corner cutting. Infinity = unreachable. */
export function distanceField(map: MapData, obstacles: Uint8Array, seeds: readonly Seed[]): Float64Array {
  const W = map.width, H = map.height;
  const dist = new Float64Array(W * H).fill(Infinity);
  const heap = new MinHeap();
  for (const s of seeds) if (!obstacles[s.i] && s.d < dist[s.i]!) { dist[s.i] = s.d; heap.push(s.i, s.d); }
  while (heap.size) {
    const [i, d] = heap.pop();
    if (d > dist[i]!) continue;
    const x = i % W, y = (i - x) / W;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (obstacles[j]) continue;
      if (dx && dy && (obstacles[y * W + nx] || obstacles[ny * W + x])) continue;
      const nd = d + (dx && dy ? Math.SQRT2 : 1);
      if (nd < dist[j]!) { dist[j] = nd; heap.push(j, nd); }
    }
  }
  return dist;
}

/** Free tiles in the 1-tile ring around a rect. */
export function ringSeeds(map: MapData, obstacles: Uint8Array, r: TileRect): Seed[] {
  const out: Seed[] = [];
  for (let y = r.y - 1; y <= r.y + r.h; y++) for (let x = r.x - 1; x <= r.x + r.w; x++) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) continue;
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
    const i = y * map.width + x;
    if (!obstacles[i]) out.push({ i, d: 0 });
  }
  return out;
}

/** Free tiles within `radius` of a world point (cost = distance to the point). */
export function pointSeeds(map: MapData, obstacles: Uint8Array, p: Vec2, radius = 2.5): Seed[] {
  const out: Seed[] = [];
  for (let y = Math.floor(p.y - radius); y <= Math.ceil(p.y + radius); y++) for (let x = Math.floor(p.x - radius); x <= Math.ceil(p.x + radius); x++) {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
    const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
    const i = y * map.width + x;
    if (d <= radius && !obstacles[i]) out.push({ i, d });
  }
  return out;
}

/** Resolve 'slot1' | 'slot2' | point name | region name to seed tiles (and a representative world point). */
export function placeSeeds(map: MapData, obstacles: Uint8Array, name: string): { seeds: Seed[]; at: Vec2 } | null {
  const sm = /^slot(\d+)$/.exec(name);
  if (sm) {
    const slot = map.slots.find((s) => s.id === Number(sm[1]));
    if (!slot) return null;
    const r = slotHqRect(slot);
    return { seeds: r ? ringSeeds(map, obstacles, r) : pointSeeds(map, obstacles, slot.start), at: { ...slot.start } };
  }
  const p = map.points[name];
  if (p) return { seeds: pointSeeds(map, obstacles, p), at: { ...p } };
  const g = map.regions[name];
  if (g) { const c = { x: g.x + g.w / 2, y: g.y + g.h / 2 }; return { seeds: pointSeeds(map, obstacles, c, Math.max(2.5, Math.min(g.w, g.h) / 4)), at: c }; }
  return null;
}

/** Shortest ground distance between two named places (null if unreachable or unknown). */
export function placeDistance(map: MapData, obstacles: Uint8Array, from: string, to: string): number | null {
  const a = placeSeeds(map, obstacles, from), b = placeSeeds(map, obstacles, to);
  if (!a || !b || !a.seeds.length || !b.seeds.length) return null;
  const f = distanceField(map, obstacles, a.seeds);
  let best = Infinity;
  for (const s of b.seeds) best = Math.min(best, f[s.i]! + s.d);
  return Number.isFinite(best) ? best : null;
}

/** Ground path (tile centres) from one named place to another, following the distance field downhill. */
export function placePath(map: MapData, obstacles: Uint8Array, from: string, to: string): Vec2[] | null {
  const a = placeSeeds(map, obstacles, from), b = placeSeeds(map, obstacles, to);
  if (!a || !b || !a.seeds.length || !b.seeds.length) return null;
  const f = distanceField(map, obstacles, b.seeds);
  let cur = -1, best = Infinity;
  for (const s of a.seeds) if (f[s.i]! < best) { best = f[s.i]!; cur = s.i; }
  if (cur < 0 || !Number.isFinite(best)) return null;
  const W = map.width, out: Vec2[] = [];
  for (let guard = 0; guard < W * map.height; guard++) {
    const x = cur % W, y = (cur - x) / W;
    out.push({ x: x + 0.5, y: y + 0.5 });
    if (f[cur] === 0) break;
    let next = -1, nb = f[cur]!;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= map.height) continue;
      const j = ny * W + nx;
      if (f[j]! < nb) { nb = f[j]!; next = j; }
    }
    if (next < 0) break;
    cur = next;
  }
  return out;
}

// ───────────────────────────── corridor width (k×k squares) ─────────────────────────────
/** free[y*W+x] = 1 if the k×k square with top-left tile (x, y) contains no obstacle. */
export function squareFree(map: MapData, obstacles: Uint8Array, k: number): Uint8Array {
  const W = map.width, H = map.height, SW = W + 1;
  const sat = new Int32Array(SW * (H + 1));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    sat[(y + 1) * SW + x + 1] = obstacles[y * W + x]! + sat[y * SW + x + 1]! + sat[(y + 1) * SW + x]! - sat[y * SW + x]!;
  }
  const out = new Uint8Array(W * H);
  for (let y = 0; y + k <= H; y++) for (let x = 0; x + k <= W; x++) {
    const s = sat[(y + k) * SW + x + k]! - sat[y * SW + x + k]! - sat[(y + k) * SW + x]! + sat[y * SW + x]!;
    if (s === 0) out[y * W + x] = 1;
  }
  return out;
}

/** True if a k×k body can travel between the two named places. */
export function corridorConnected(map: MapData, obstacles: Uint8Array, from: string, to: string, k: number): boolean | null {
  const a = placeSeeds(map, obstacles, from), b = placeSeeds(map, obstacles, to);
  if (!a || !b) return null;
  const W = map.width, H = map.height;
  const free = squareFree(map, obstacles, k);
  const near = (p: Vec2, isSlot: boolean): number[] => {
    const R = k / 2 + (isSlot ? 4.5 : 3);
    const out: number[] = [];
    for (let y = Math.floor(p.y - R - k); y <= Math.ceil(p.y + R); y++) for (let x = Math.floor(p.x - R - k); x <= Math.ceil(p.x + R); x++) {
      if (x < 0 || y < 0 || x + k > W || y + k > H || !free[y * W + x]) continue;
      if (Math.hypot(x + k / 2 - p.x, y + k / 2 - p.y) <= R) out.push(y * W + x);
    }
    return out;
  };
  const src = near(a.at, from.startsWith('slot')), dst = new Set(near(b.at, to.startsWith('slot')));
  if (!src.length || !dst.size) return false;
  const seen = new Uint8Array(W * H);
  const q = [...src];
  for (const i of q) seen[i] = 1;
  for (let h = 0; h < q.length; h++) {
    const i = q[h]!;
    if (dst.has(i)) return true;
    const x = i % W, y = (i - x) / W;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (free[j] && !seen[j]) { seen[j] = 1; q.push(j); }
    }
  }
  return false;
}

// ───────────────────────────── validation ─────────────────────────────
export function validateMap(map: MapData, req: MapRequirements = {}): ValidationReport {
  const errors: string[] = [], warnings: string[] = [];
  const W = map.width, H = map.height, N = W * H;
  const stats: MapStats = {
    walkable: 0, buildable: 0, blocked: 0, ramps: 0, water: 0, doodads: map.doodads.length, decals: map.decals.length,
    caches: map.resources.length, slotDistance: null, lanes: {}, cachesNearer: { slot1: 0, slot2: 0, contested: 0 },
  };
  const finish = (): ValidationReport => ({ ok: errors.length === 0, errors, warnings, stats });

  // 0. array shapes
  for (const [k, arr] of [['terrain', map.terrain], ['levels', map.levels], ['ramps', map.ramps], ['blocked', map.blocked], ['buildable', map.buildable]] as const) {
    if (arr.length !== N) errors.push(`${k} has length ${arr.length}, expected ${N}`);
  }
  if (map.heights.length !== (W + 1) * (H + 1)) errors.push(`heights has length ${map.heights.length}, expected ${(W + 1) * (H + 1)}`);
  if (errors.length) return finish();
  for (let i = 0; i < N; i++) {
    if (map.blocked[i]) stats.blocked++; else stats.walkable++;
    if (map.buildable[i]) { stats.buildable++; if (map.blocked[i]) { errors.push(`tile ${i % W},${Math.floor(i / W)} is buildable but blocked`); break; } }
    if (map.ramps[i]) stats.ramps++;
    if (map.terrain[i] === 5) stats.water++;
  }
  for (let i = 0; i < map.heights.length; i++) if (!Number.isFinite(map.heights[i]!)) { errors.push(`heights[${i}] is not finite`); break; }

  // 1. names
  const inMap = (r: MapRegion) => r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H;
  for (const n of req.regions ?? []) if (!map.regions[n]) errors.push(`missing required region "${n}"`);
  for (const n of req.points ?? []) if (!map.points[n]) errors.push(`missing required point "${n}"`);
  for (const [n, r] of Object.entries(map.regions)) if (!inMap(r)) errors.push(`region "${n}" is empty or out of bounds`);
  for (const [n, p] of Object.entries(map.points)) {
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) errors.push(`point "${n}" (${p.x},${p.y}) is out of bounds`);
    else if (map.blocked[ty * W + tx]) errors.push(`point "${n}" (${p.x},${p.y}) is on a blocked tile`);
  }

  // 2. slots & sites
  const cacheRects = map.resources.map((r) => cacheRect(r.pos));
  const slotRects: TileRect[] = [];
  if (map.slots.length < 2) warnings.push(`only ${map.slots.length} player slot(s)`);
  if (new Set(map.slots.map((s) => s.id)).size !== map.slots.length) errors.push('duplicate slot ids');
  const checkSite = (name: string, r: TileRect, minGap: number) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) { errors.push(`${name}: footprint leaves the map at ${x},${y}`); return; }
      if (!map.buildable[y * W + x]) { errors.push(`${name}: tile ${x},${y} is not buildable`); return; }
    }
    for (const c of cacheRects) {
      const d = rectDist(r, c);
      if (d < minGap) { errors.push(`${name}: only ${d.toFixed(1)} tiles from the cache at ${c.x + 1},${c.y + 1} (need ≥ ${minGap})`); return; }
    }
  };
  for (const s of map.slots) {
    const r = slotHqRect(s);
    if (!r) continue;
    checkSite(`slot ${s.id} HQ`, r, 3);
    for (const o of slotRects) if (rectDist(r, o) < 1) errors.push(`slot ${s.id} HQ overlaps another slot`);
    slotRects.push(r);
  }
  for (const s of req.sites ?? []) checkSite(`site ${s.name}`, s, s.minCacheGap ?? 0);

  // 3. caches
  for (let k = 0; k < cacheRects.length; k++) {
    const c = cacheRects[k]!;
    for (let y = c.y; y < c.y + 2; y++) for (let x = c.x; x < c.x + 2; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) { errors.push(`cache ${k} leaves the map`); continue; }
      if (map.blocked[y * W + x]) errors.push(`cache ${k} at ${c.x + 1},${c.y + 1}: tile ${x},${y} is statically blocked`);
      if (map.buildable[y * W + x]) errors.push(`cache ${k} at ${c.x + 1},${c.y + 1}: tile ${x},${y} is buildable`);
    }
    for (let j = 0; j < k; j++) if (overlap(c, cacheRects[j]!)) errors.push(`caches ${j} and ${k} overlap`);
    for (const s of slotRects) if (overlap(c, s)) errors.push(`cache ${k} overlaps a slot HQ`);
  }

  // 4. connectivity (4-neighbour flood from slot 1's HQ ring)
  const obst = obstacleGrid(map);
  const reach = new Uint8Array(N);
  const startSlot = map.slots[0];
  const startSeeds = startSlot ? (slotHqRect(startSlot) ? ringSeeds(map, obst, slotHqRect(startSlot)!) : pointSeeds(map, obst, startSlot.start)) : [];
  if (startSlot && !startSeeds.length) errors.push(`slot ${startSlot.id} HQ is sealed in (no free tile around it)`);
  {
    const q = startSeeds.map((s) => s.i);
    for (const i of q) reach[i] = 1;
    for (let h = 0; h < q.length; h++) {
      const i = q[h]!, x = i % W, y = (i - x) / W;
      if (x > 0 && !obst[i - 1] && !reach[i - 1]) { reach[i - 1] = 1; q.push(i - 1); }
      if (x < W - 1 && !obst[i + 1] && !reach[i + 1]) { reach[i + 1] = 1; q.push(i + 1); }
      if (y > 0 && !obst[i - W] && !reach[i - W]) { reach[i - W] = 1; q.push(i - W); }
      if (y < H - 1 && !obst[i + W] && !reach[i + W]) { reach[i + W] = 1; q.push(i + W); }
    }
  }
  const ringReach = (r: TileRect): number => ringSeeds(map, obst, r).filter((s) => reach[s.i]).length;
  if (startSlot) {
    for (const s of map.slots.slice(1)) {
      const r = slotHqRect(s);
      const ok = r ? ringReach(r) > 0 : pointSeeds(map, obst, s.start).some((q) => reach[q.i]);
      if (!ok) errors.push(`slot ${s.id} at (${s.start.x},${s.start.y}) is not reachable by ground from slot ${startSlot.id}`);
    }
    for (const [n, g] of Object.entries(map.regions)) {
      let any = false;
      for (let y = Math.max(0, g.y); y < Math.min(H, g.y + g.h) && !any; y++) for (let x = Math.max(0, g.x); x < Math.min(W, g.x + g.w); x++) if (reach[y * W + x]) { any = true; break; }
      if (!any) errors.push(`region "${n}" (${g.x},${g.y} ${g.w}×${g.h}) has no ground-reachable tile`);
    }
    for (const [n, p] of Object.entries(map.points)) {
      // points at an HQ centre (player_start, enemy_start) are covered by the slot check
      if (slotRects.some((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h)) continue;
      if (!pointSeeds(map, obst, p, 1.5).some((q) => reach[q.i])) errors.push(`point "${n}" (${p.x},${p.y}) is not reachable by ground`);
    }
    for (const s of req.sites ?? []) if (ringReach(s) === 0) errors.push(`site ${s.name} is not reachable by ground`);
    cacheRects.forEach((c, k) => {
      const n = ringReach(c);
      if (n < 3) errors.push(`cache ${k} at ${c.x + 1},${c.y + 1} has only ${n} reachable access tiles (need ≥ 3)`);
    });
    let lost = 0, sample = -1;
    for (let i = 0; i < N; i++) if (!obst[i] && !reach[i]) { lost++; if (sample < 0) sample = i; }
    if (lost >= 4) errors.push(`${lost} walkable tiles are unreachable by ground (e.g. ${sample % W},${Math.floor(sample / W)})`);
    else if (lost > 0) warnings.push(`${lost} walkable tile(s) are unreachable (e.g. ${sample % W},${Math.floor(sample / W)})`);
  }

  // 5. corridors (k×k bodies)
  for (const c of req.corridors ?? []) {
    const ok = corridorConnected(map, obst, c.from, c.to, c.width);
    if (ok === null) errors.push(`corridor ${c.from} → ${c.to}: unknown place`);
    else if (!ok) errors.push(`corridor ${c.from} → ${c.to}: no passage at least ${c.width} tiles wide`);
  }

  // 6. stats: slot distance, lanes, resource sides
  const s1 = map.slots.find((s) => s.id === 1), s2 = map.slots.find((s) => s.id === 2);
  if (s1 && s2) {
    const f1 = distanceField(map, obst, placeSeeds(map, obst, 'slot1')!.seeds);
    const f2 = distanceField(map, obst, placeSeeds(map, obst, 'slot2')!.seeds);
    let best = Infinity;
    for (const s of placeSeeds(map, obst, 'slot2')!.seeds) best = Math.min(best, f1[s.i]!);
    stats.slotDistance = Number.isFinite(best) ? Math.round(best * 10) / 10 : null;
    for (const c of cacheRects) {
      const ring = ringSeeds(map, obst, c);
      const d1 = Math.min(...ring.map((s) => f1[s.i]!)), d2 = Math.min(...ring.map((s) => f2[s.i]!));
      if (d1 + 6 < d2) stats.cachesNearer.slot1++;
      else if (d2 + 6 < d1) stats.cachesNearer.slot2++;
      else stats.cachesNearer.contested++;
    }
  }
  for (const lane of req.lanes ?? []) {
    const stops = [lane.from ?? 'slot1', ...lane.via, lane.to ?? 'slot2'];
    let total = 0;
    for (let k = 0; k + 1 < stops.length; k++) {
      const d = placeDistance(map, obst, stops[k]!, stops[k + 1]!);
      if (d === null) { warnings.push(`lane ${lane.name}: ${stops[k]} → ${stops[k + 1]} unreachable`); total = NaN; break; }
      total += d;
    }
    stats.lanes[lane.name] = Number.isFinite(total) ? Math.round(total * 10) / 10 : null;
  }
  return finish();
}

function overlap(a: TileRect, b: TileRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** One-line-per-issue text summary (console / sandbox). */
export function formatReport(r: ValidationReport): string {
  const s = r.stats;
  const lines = [
    `${r.ok ? 'OK' : 'FAILED'} — ${r.errors.length} error(s), ${r.warnings.length} warning(s)`,
    `walkable ${s.walkable} · buildable ${s.buildable} · blocked ${s.blocked} · ramps ${s.ramps} · water ${s.water}`,
    `doodads ${s.doodads} · decals ${s.decals} · caches ${s.caches} (slot1 ${s.cachesNearer.slot1} / slot2 ${s.cachesNearer.slot2} / contested ${s.cachesNearer.contested})`,
    `slot1↔slot2 ground distance: ${s.slotDistance ?? 'unreachable'}`,
    ...Object.entries(s.lanes).map(([k, v]) => `lane ${k}: ${v ?? 'unreachable'}`),
    ...r.errors.map((e) => `ERROR ${e}`),
    ...r.warnings.map((w) => `warn  ${w}`),
  ];
  return lines.join('\n');
}
