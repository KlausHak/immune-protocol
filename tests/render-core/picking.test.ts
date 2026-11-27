import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { sampleHeight } from '../../src/core/terrain';
import type { MapData } from '../../src/core/types';
import { createTestMap } from '../../src/map/testMap';
import { heightBounds, intersectPlaneY, intersectTerrain, rayAabb } from '../../src/render/core/picking';

/** Test map with a 1.6-high plateau (x ≥ 40) to exercise cliffs. */
function cliffMap(): MapData {
  const m = createTestMap();
  const W = m.width;
  for (let vy = 0; vy <= m.height; vy++) for (let vx = 0; vx <= W; vx++) m.heights[vy * (W + 1) + vx] = vx >= 40 ? 1.6 : 0;
  return m;
}

/** First crossing by brute force (tiny steps) for comparison. */
function bruteFirstHit(map: MapData, o: THREE.Vector3, d: THREE.Vector3): number {
  for (let t = 0; t < 400; t += 0.001) if (o.y + d.y * t <= sampleHeight(map, o.x + d.x * t, o.z + d.z * t)) return t;
  return -1;
}

describe('render-core picking math', () => {
  it('caches terrain height bounds', () => {
    const m = createTestMap();
    const b = heightBounds(m);
    expect(b.min).toBeCloseTo(-0.6, 5);
    expect(b.max).toBeCloseTo(0, 5);
    expect(heightBounds(m)).toBe(b);
  });

  it('vertical and oblique rays land exactly on the terrain', () => {
    const m = createTestMap();
    const out = new THREE.Vector3();
    const o = new THREE.Vector3(10.5, 50, 10.5), down = new THREE.Vector3(0, -1, 0);
    expect(intersectTerrain(m, o, down, out)).toBeGreaterThan(0);
    expect(out.x).toBeCloseTo(10.5, 6); expect(out.z).toBeCloseTo(10.5, 6); expect(out.y).toBeCloseTo(0, 4);
    // RTS-like 56° ray toward the pond (heights dip to -0.6)
    const dir = new THREE.Vector3(0, -Math.sin(0.98), -Math.cos(0.98)).normalize();
    const cam = new THREE.Vector3(22, 28, 48 + 28 / Math.tan(0.98));
    const t = intersectTerrain(m, cam, dir, out);
    expect(t).toBeGreaterThan(0);
    expect(Math.abs(out.y - sampleHeight(m, out.x, out.z))).toBeLessThan(1e-3);
    expect(Math.abs(t - bruteFirstHit(m, cam, dir))).toBeLessThan(0.01);
  });

  it('finds the first crossing in front of a cliff (no tunnelling)', () => {
    const m = cliffMap();
    const out = new THREE.Vector3();
    for (const [x0, y0] of [[30, 6], [34, 6], [36.5, 1.4], [38.9, 1.2], [37, 0.8]] as const) {
      // shoot toward +x at a shallow angle: some rays land on the plateau, some on the cliff face
      const o = new THREE.Vector3(x0, y0, 20), d = new THREE.Vector3(1, -0.08 - y0 * 0.08, 0.1).normalize();
      const t = intersectTerrain(m, o, d, out);
      expect(t).toBeGreaterThan(0);
      expect(Math.abs(t - bruteFirstHit(m, o, d))).toBeLessThan(0.01);
    }
  });

  it('returns -1 for rays that never come down and supports a plane fallback', () => {
    const m = createTestMap();
    const out = new THREE.Vector3();
    expect(intersectTerrain(m, new THREE.Vector3(5, 10, 5), new THREE.Vector3(0, 1, 0), out)).toBe(-1);
    expect(intersectPlaneY(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0), 2, out)).toBeCloseTo(8, 6);
    expect(out.y).toBe(2);
  });

  it('slab test: hit, miss, inside', () => {
    const inv = (v: number) => 1 / v;
    // ray along +x at y=z=0.5 hits the unit box at t=2 from x=-2
    expect(rayAabb(-2, 0.5, 0.5, inv(1), inv(0), inv(0), 0, 0, 0, 1, 1, 1)).toBeCloseTo(2, 6);
    expect(rayAabb(-2, 1.5, 0.5, inv(1), inv(0), inv(0), 0, 0, 0, 1, 1, 1)).toBe(Infinity);
    expect(rayAabb(0.5, 0.5, 0.5, inv(0), inv(-1), inv(0), 0, 0, 0, 1, 1, 1)).toBe(0);
    // box behind the ray origin is a miss
    expect(rayAabb(3, 0.5, 0.5, inv(1), inv(0), inv(0), 0, 0, 0, 1, 1, 1)).toBe(Infinity);
  });
});
