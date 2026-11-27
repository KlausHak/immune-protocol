/**
 * [environment] Rugged cliff faces: low-poly granite boulders instanced along natural level changes
 * (man-made level changes keep their concrete retaining-wall look from the terrain shader).
 * 3 rock variants → 3 draw calls for every cliff on the map.
 */
import * as THREE from 'three';
import { LEVEL_HEIGHT } from '../../config';
import { patchFogOfWar } from './fog';
import type { ExtendedTerrain } from './heightfield';
import { Rand, perlin } from './noise';
import { isManMade } from './textures';

const VARIANTS = 3;

function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = perlin(v.x * 1.7 + seed * 3.1, v.z * 1.7 + v.y * 1.3, 64, seed) * 0.22 + perlin(v.y * 3.1, v.x * 3.3 + seed, 64, seed + 9) * 0.1;
    v.multiplyScalar(1 + n);
    v.y = v.y < -0.35 ? -0.35 + (v.y + 0.35) * 0.3 : v.y; // flattened base
    v.x *= 1.15; v.z *= 0.95; v.y *= 0.8;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  const flat = g.index ? g.toNonIndexed() : g;
  if (flat !== g) g.dispose();
  flat.computeVertexNormals();
  flat.computeBoundingSphere();
  return flat;
}

export class CliffRocks {
  readonly group = new THREE.Group();
  readonly count: number;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mat: THREE.MeshStandardMaterial;

  constructor(ext: ExtendedTerrain, opts: { shadows: boolean; density: number }) {
    this.group.name = 'env:cliff-rocks';
    this.mat = new THREE.MeshStandardMaterial({ name: 'env-cliff-rock', color: 0xffffff, roughness: 0.86, metalness: 0, flatShading: true });
    patchFogOfWar(this.mat);
    const map = ext.map, W = map.width, H = map.height;
    const rnd = new Rand(9001);
    const mats: THREE.Matrix4[][] = Array.from({ length: VARIANTS }, () => []);
    const cols: THREE.Color[][] = Array.from({ length: VARIANTS }, () => []);
    const q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), t = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), nrm = new THREE.Vector3();
    const tilt = new THREE.Quaternion();
    const palette = [0x8a817c, 0x7a7674, 0x93807a, 0x6d6b6c, 0x857a70];
    const hAt = (x: number, y: number) => ext.sample(x, y);
    for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      if (map.ramps[i]) continue;
      const h00 = hAt(tx, ty), h10 = hAt(tx + 1, ty), h01 = hAt(tx, ty + 1), h11 = hAt(tx + 1, ty + 1);
      const lo = Math.min(h00, h10, h01, h11), hi = Math.max(h00, h10, h01, h11);
      const drop = hi - lo;
      if (drop < LEVEL_HEIGHT * 0.55) continue;
      // skip if any neighbour is a ramp (keep ramp mouths clean) or the high side is man-made
      let nearRamp = false, highId = map.terrain[i]!, highLv = -1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = tx + dx, y = ty + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const j = y * W + x;
        if (map.ramps[j]) nearRamp = true;
        if (map.levels[j]! > highLv) { highLv = map.levels[j]!; highId = map.terrain[j]!; }
      }
      if (nearRamp || isManMade(highId)) continue;
      const n = Math.max(1, Math.round((1 + rnd.next() * 1.2) * opts.density));
      for (let k = 0; k < n; k++) {
        const x = tx + 0.15 + rnd.next() * 0.7, y = ty + 0.15 + rnd.next() * 0.7;
        const hy = hAt(x, y);
        const along = (hy - lo) / drop;
        if (along < 0.15 || along > 0.92) continue;
        nrm.set(hAt(x - 0.3, y) - hAt(x + 0.3, y), 0.6, hAt(x, y - 0.3) - hAt(x, y + 0.3)).normalize();
        const size = (0.45 + rnd.next() * 0.45) * LEVEL_HEIGHT * 0.62;
        e.set((rnd.next() - 0.5) * 0.6, rnd.next() * Math.PI * 2, (rnd.next() - 0.5) * 0.6);
        q.setFromEuler(e);
        tilt.setFromUnitVectors(up, nrm.lerp(up, 0.55).normalize());
        q.premultiply(tilt);
        s.set(size * (0.9 + rnd.next() * 0.5), size * (0.8 + rnd.next() * 0.6), size * (0.9 + rnd.next() * 0.4));
        t.set(x, hy - size * 0.15, y);
        const v = rnd.int(VARIANTS);
        mats[v]!.push(new THREE.Matrix4().compose(t, q, s));
        cols[v]!.push(new THREE.Color(palette[rnd.int(palette.length)]!).multiplyScalar(0.85 + rnd.next() * 0.3));
        // occasional talus boulder at the foot
        if (rnd.next() < 0.22) {
          const fx = x + nrm.x * 0.9, fy = y + nrm.z * 0.9;
          const fs = size * (0.35 + rnd.next() * 0.3);
          t.set(fx, hAt(fx, fy) - fs * 0.2, fy);
          e.set(rnd.next(), rnd.next() * 6.28, rnd.next());
          q.setFromEuler(e);
          s.set(fs, fs * 0.75, fs * 1.1);
          const v2 = rnd.int(VARIANTS);
          mats[v2]!.push(new THREE.Matrix4().compose(t, q, s));
          cols[v2]!.push(new THREE.Color(palette[rnd.int(palette.length)]!).multiplyScalar(0.8 + rnd.next() * 0.3));
        }
      }
    }
    let count = 0;
    for (let v = 0; v < VARIANTS; v++) {
      const list = mats[v]!;
      if (!list.length) continue;
      const geo = rockGeometry(17 + v * 11);
      const im = new THREE.InstancedMesh(geo, this.mat, list.length);
      list.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, cols[v]![i]!); });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = opts.shadows;
      im.receiveShadow = true;
      im.matrixAutoUpdate = false;
      im.name = `env:cliff-rocks:${v}`;
      this.group.add(im);
      this.geos.push(geo);
      count += list.length;
    }
    this.count = count;
  }

  dispose(): void {
    for (const c of this.group.children) (c as THREE.InstancedMesh).dispose();
    for (const g of this.geos) g.dispose();
    this.mat.dispose();
  }
}
