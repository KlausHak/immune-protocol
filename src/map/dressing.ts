/**
 * [map] Reusable set-dressing recipes built on MapBuilder (parking lots, crosswalks, groves, snow, infection).
 * Deterministic: randomness comes from the builder's Rng.
 */
import { Terrain, type DoodadKind } from '../core/types';
import type { MapBuilder } from './builder';
import { shape, type Shape } from './shapes';

/** Stall pitch (world units) of parking_lines decals and of cars placed by parkingRow(). */
export const PARKING_STALL_PITCH = 1.5;

/**
 * A row of perpendicular parking stalls (asphalt + parking_lines decal + some parked cars).
 * The row runs along +x (horizontal) or +y (vertical) from (x, y) for `len` tiles; stalls are 2 tiles deep and
 * the cars face `facing` (radians, sim convention) — i.e. toward the aisle they back out into.
 */
export function parkingRow(b: MapBuilder, x: number, y: number, len: number, horizontal: boolean, facing: number, fill = 0.55): void {
  const w = horizontal ? len : 2, h = horizontal ? 2 : len;
  b.paint(shape.rect(x, y, w, h), Terrain.Asphalt);
  b.flatten(shape.rect(x, y, w, h));
  const cx = x + w / 2, cy = y + h / 2;
  b.decal('parking_lines', cx, cy, len, 2, horizontal ? 0 : Math.PI / 2);
  const n = Math.floor(len / PARKING_STALL_PITCH);
  const start = (len - n * PARKING_STALL_PITCH) / 2 + PARKING_STALL_PITCH / 2;
  for (let k = 0; k < n; k++) {
    if (b.rng.next() > fill) continue;
    const along = start + k * PARKING_STALL_PITCH;
    const px = horizontal ? x + along : x + 1, py = horizontal ? y + 1 : y + along;
    b.doodad('car', px, py, { rot: facing + b.rng.range(-0.05, 0.05), snap: false, optional: true });
  }
}

/**
 * Parking lot: alternating stall rows and 3-tile aisles. Horizontal lots stack rows along y.
 * Returns the asphalt rect actually painted.
 */
export function parkingLot(b: MapBuilder, x: number, y: number, w: number, h: number, horizontal = true, fill = 0.55): void {
  b.paint(shape.rect(x, y, w, h), Terrain.Asphalt);
  b.flatten(shape.rect(x, y, w, h));
  const depth = horizontal ? h : w;
  // pattern: [row 2][aisle 3][row 2][row 2][aisle 3][row 2] …
  let o = 0, k = 0;
  while (o + 2 <= depth) {
    const facing = horizontal ? (k % 2 === 0 ? Math.PI / 2 : -Math.PI / 2) : (k % 2 === 0 ? 0 : Math.PI);
    if (horizontal) parkingRow(b, x, y + o, w, true, facing, fill);
    else parkingRow(b, x + o, y, h, false, facing, fill);
    o += 2;
    if (k % 2 === 0) o += 3;
    k++;
  }
}

/** Zebra crossing across a road: (x, y) centre, `rot` = walking direction, `length` across the road. */
export function crosswalk(b: MapBuilder, x: number, y: number, rot: number, length: number, band = 2): void {
  b.decal('crosswalk', x, y, length, band, rot);
}

/** Tree grove: scatter trees at `density` per tile of the shape's bounding box. */
export function grove(b: MapBuilder, kinds: readonly DoodadKind[], area: Shape, density: number, opts: { avoid?: Shape; minDist?: number; scale?: [number, number] } = {}): number {
  const count = Math.round((area.x1 - area.x0) * (area.y1 - area.y0) * density);
  return b.scatter(kinds, area, { count, minDist: opts.minDist ?? 1.6, scale: opts.scale ?? [0.8, 1.25], avoid: opts.avoid });
}

/**
 * Impassable woodland: blocks the whole shape (explicit) and fills it densely with trees so it reads as a wall.
 * Use it to shape lanes — sparse groves do not stop units.
 */
export function forestWall(b: MapBuilder, area: Shape, kinds: readonly DoodadKind[] = ['tree_pine', 'tree_pine', 'tree_birch'], density = 0.55): number {
  b.block(area);
  const count = Math.round((area.x1 - area.x0) * (area.y1 - area.y0) * density);
  return b.scatter(kinds, area, { count, minDist: 1.05, scale: [0.85, 1.35], allowBlocked: true, margin: 0 });
}

/** Light snow: organic Snow patches over grass/dirt plus a few walkable snow piles. */
export function snowPatches(b: MapBuilder, area: Shape, patches: number, r: [number, number], piles = 0): void {
  for (let k = 0; k < patches; k++) {
    const cx = b.rng.range(area.x0, area.x1), cy = b.rng.range(area.y0, area.y1);
    if (!area.has(cx, cy)) continue;
    const blob = shape.blob(cx, cy, b.rng.range(r[0], r[1]), Math.floor(b.rng.next() * 1e6), 0.45);
    b.paint(shape.intersect(blob, area), Terrain.Snow, { over: [Terrain.Grass, Terrain.Dirt] });
  }
  if (piles > 0) b.scatter('snow_pile', area, { count: piles, minDist: 2.5, scale: [0.7, 1.3] });
}

/** Contaminated ground blob with stains and walkable goo puddles. */
export function contaminate(b: MapBuilder, cx: number, cy: number, r: number, opts: { puddles?: number; stains?: number; over?: readonly Terrain[] } = {}): void {
  const blob = shape.blob(cx, cy, r, Math.floor(b.rng.next() * 1e6), 0.4);
  b.paint(blob, Terrain.Contaminated, { over: opts.over ?? [Terrain.Grass, Terrain.Dirt, Terrain.Snow, Terrain.Sand] });
  for (let k = 0; k < (opts.stains ?? Math.round(r / 2)); k++) {
    const a = b.rng.next() * Math.PI * 2, d = b.rng.next() * r * 0.9;
    const s = b.rng.range(1.5, 3.5);
    b.decal('stain', cx + Math.cos(a) * d, cy + Math.sin(a) * d, s, s * b.rng.range(0.6, 1), b.rng.next() * Math.PI * 2);
  }
  if (opts.puddles) b.scatter('goo_puddle', blob, { count: opts.puddles, minDist: 2.2, scale: [0.7, 1.4], allowPaved: true });
}

/** Infection props: growths, vents, barrels, puddles, grates. */
export function infectionProps(b: MapBuilder, area: Shape, n: number, opts: { avoid?: Shape } = {}): void {
  b.scatter('infected_growth', area, { count: Math.round(n * 0.25), minDist: 3.5, scale: [0.85, 1.15], avoid: opts.avoid, allowPaved: true });
  b.scatter('spore_vent', area, { count: Math.round(n * 0.25), minDist: 3, avoid: opts.avoid, allowPaved: true });
  b.scatter('biohazard_barrel', area, { count: Math.round(n * 0.2), minDist: 1.8, avoid: opts.avoid, allowPaved: true });
  b.scatter('goo_puddle', area, { count: Math.round(n * 0.2), minDist: 2.5, scale: [0.7, 1.4], avoid: opts.avoid, allowPaved: true });
  b.scatter('sewer_grate', area, { count: Math.max(1, Math.round(n * 0.1)), minDist: 4, rot: 0, avoid: opts.avoid, allowPaved: true, allowRoads: true });
}

/** Shoreline: granite rocks just inland of the water line, reeds in the shallows of coves. */
export function shoreline(b: MapBuilder, area: Shape, rocks: number, reeds: number): void {
  const nearWater = (tx: number, ty: number, r: number) => {
    for (let y = ty - r; y <= ty + r; y++) for (let x = tx - r; x <= tx + r; x++) {
      if (b.inside(x, y) && b.terrainAt(x, y) === Terrain.Water) return true;
    }
    return false;
  };
  const edge: Shape = { ...area, has: (px, py) => area.has(px, py) && nearWater(Math.floor(px), Math.floor(py), 1) };
  b.scatter('rock_granite', edge, { count: rocks, minDist: 3, scale: [0.85, 1.15] });
  b.scatter('reeds', edge, { count: reeds, minDist: 1.3, scale: [0.8, 1.3] });
}
