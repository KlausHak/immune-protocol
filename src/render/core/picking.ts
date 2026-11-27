/**
 * [render-core] Allocation-free ray helpers: ray vs. terrain heightfield (ray-march + bisection on
 * sampleHeight) and ray vs. axis-aligned boxes. Used by picking, the RTS camera and the minimap quad.
 */
import * as THREE from 'three';
import type { MapData } from '../../core/types';
import { sampleHeight } from '../../core/terrain';

interface HeightBounds { min: number; max: number }
const boundsCache = new WeakMap<MapData, HeightBounds>();

/** Min/max terrain vertex height of a map (cached per MapData). */
export function heightBounds(map: MapData): HeightBounds {
  let b = boundsCache.get(map);
  if (!b) {
    let min = Infinity, max = -Infinity;
    const h = map.heights;
    for (let i = 0; i < h.length; i++) { const v = h[i]!; if (v < min) min = v; if (v > max) max = v; }
    if (!Number.isFinite(min)) { min = 0; max = 0; }
    b = { min, max };
    boundsCache.set(map, b);
  }
  return b;
}

const MARCH_STEP = 0.3;

/**
 * Intersect a ray (normalised `dir`) with the terrain. Writes the hit to `out` (three.js coords:
 * x, height, z=sim y) and returns the ray parameter, or -1 when the ray never reaches the ground.
 * Outside the map the terrain is treated as extending its edge heights (sampleHeight clamps).
 */
export function intersectTerrain(map: MapData, origin: THREE.Vector3, dir: THREE.Vector3, out: THREE.Vector3): number {
  const { min, max } = heightBounds(map);
  const ox = origin.x, oy = origin.y, oz = origin.z, dx = dir.x, dy = dir.y, dz = dir.z;
  if (dy >= -1e-6) {
    // looking up / horizontal: only hits if we start below the terrain
    const h = sampleHeight(map, ox, oz);
    if (oy <= h) { out.set(ox, h, oz); return 0; }
    return -1;
  }
  // only march the slab of the ray between the highest and lowest terrain heights
  let t = oy > max ? (oy - max - 0.01) / -dy : 0;
  const tEnd = (oy - min + 0.01) / -dy;
  let prevT = t;
  let prevF = oy + dy * t - sampleHeight(map, ox + dx * t, oz + dz * t);
  if (prevF <= 0) { out.set(ox + dx * t, oy + dy * t, oz + dz * t); return t; }
  while (t < tEnd) {
    t = Math.min(tEnd, t + MARCH_STEP);
    const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
    const f = py - sampleHeight(map, px, pz);
    if (f <= 0) {
      // refine between prevT (above ground) and t (below ground)
      let lo = prevT, hi = t;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) * 0.5;
        const fm = oy + dy * mid - sampleHeight(map, ox + dx * mid, oz + dz * mid);
        if (fm > 0) lo = mid; else hi = mid;
      }
      const tt = (lo + hi) * 0.5;
      out.set(ox + dx * tt, sampleHeight(map, ox + dx * tt, oz + dz * tt), oz + dz * tt);
      return tt;
    }
    prevT = t; prevF = f;
  }
  void prevF;
  // numerical fallback: intersect the lowest plane
  out.set(ox + dx * tEnd, min, oz + dz * tEnd);
  return tEnd;
}

/** Ray vs. horizontal plane y = h. Returns t or -1. */
export function intersectPlaneY(origin: THREE.Vector3, dir: THREE.Vector3, h: number, out: THREE.Vector3): number {
  if (Math.abs(dir.y) < 1e-6) return -1;
  const t = (h - origin.y) / dir.y;
  if (t < 0) return -1;
  out.set(origin.x + dir.x * t, h, origin.z + dir.z * t);
  return t;
}

/**
 * Slab test of a ray against an AABB. `inv*` are 1/dir components (may be ±Infinity).
 * Returns the entry distance (0 if the origin is inside) or Infinity on a miss.
 */
export function rayAabb(
  ox: number, oy: number, oz: number, invX: number, invY: number, invZ: number,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
): number {
  let t1 = (minX - ox) * invX, t2 = (maxX - ox) * invX;
  let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
  t1 = (minY - oy) * invY; t2 = (maxY - oy) * invY;
  tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
  t1 = (minZ - oz) * invZ; t2 = (maxZ - oz) * invZ;
  tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
  if (Number.isNaN(tmin) || Number.isNaN(tmax) || tmax < Math.max(tmin, 0)) return Infinity;
  return Math.max(tmin, 0);
}

/**
 * Builds a world-space picking ray through a canvas-relative pixel. Writes origin/dir (normalised).
 * Requires camera.matrixWorld / projectionMatrixInverse to be current.
 */
export function screenRay(camera: THREE.PerspectiveCamera, sx: number, sy: number, width: number, height: number,
  origin: THREE.Vector3, dir: THREE.Vector3): void {
  const nx = (sx / Math.max(1, width)) * 2 - 1;
  const ny = -(sy / Math.max(1, height)) * 2 + 1;
  ndcRay(camera, nx, ny, origin, dir);
}

/** Ray through NDC (nx, ny). */
export function ndcRay(camera: THREE.PerspectiveCamera, nx: number, ny: number, origin: THREE.Vector3, dir: THREE.Vector3): void {
  origin.setFromMatrixPosition(camera.matrixWorld);
  dir.set(nx, ny, 0.5).unproject(camera).sub(origin).normalize();
}
