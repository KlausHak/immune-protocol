/**
 * [environment] Ground decals (map.decals) batched into ONE terrain-hugging mesh using the generated atlas.
 *
 * Decal conventions (Decal.size: x = extent along `rot`, y = extent perpendicular to it):
 *  - road_line      dashed centre line; size.y = painted width (≈0.15). Long decals repeat a dash every ≈2.2
 *                   units; decals ≤ 2.4 long render as ONE solid dash (how the meilahti builder places them).
 *  - crosswalk      zebra; stripes repeat along x (≈0.8 period, i.e. across the road), size.y = crossing width.
 *  - parking_lines  a row of stalls; lines repeat along x (1.5 per stall, = map PARKING_STALL_PITCH), size.y = stall depth.
 *  - helipad_h / medical_cross / manhole / stain   one image stretched over size.
 *  - arrow          points along +x (the `rot` direction).
 */
import * as THREE from 'three';
import type { Decal, DecalKind } from '../../core/types';
import { patchFogOfWar } from './fog';
import type { ExtendedTerrain } from './heightfield';
import { DECAL_CELLS, DECAL_COLS, DECAL_ROWS, createDecalAtlas } from './textures';

const PERIOD: Partial<Record<DecalKind, number>> = { road_line: 2.2, crosswalk: 0.8, parking_lines: 1.5 }; // parking = map PARKING_STALL_PITCH
const LIFT = 0.025;

export class DecalLayer {
  readonly mesh: THREE.Mesh | null = null;
  private readonly geo: THREE.BufferGeometry | null = null;
  private readonly mat: THREE.MeshStandardMaterial | null = null;
  private readonly atlas: THREE.Texture | null = null;
  readonly count: number;

  constructor(decals: readonly Decal[], ext: ExtendedTerrain, anisotropy: number) {
    const valid = decals.filter((d) => d && d.kind in DECAL_CELLS && d.size && d.size.x > 0 && d.size.y > 0);
    this.count = valid.length;
    if (!valid.length) return;
    const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
    const n = new THREE.Vector3();
    const normalAt = (x: number, y: number) => {
      const e = 0.5;
      n.set(ext.sample(x - e, y) - ext.sample(x + e, y), 2 * e, ext.sample(x, y - e) - ext.sample(x, y + e)).normalize();
      return n;
    };
    for (const d of valid) {
      const cell = DECAL_CELLS[d.kind];
      const col = cell % DECAL_COLS, row = Math.floor(cell / DECAL_COLS);
      const c = Math.cos(d.rot), s = Math.sin(d.rot);
      const period = PERIOD[d.kind];
      const segs = period && d.size.x > period * 1.1 ? Math.max(1, Math.round(d.size.x / period)) : 1;
      const segLen = d.size.x / segs;
      // a road_line no longer than one period is a single painted dash (the map places dashes individually)
      const solidDash = d.kind === 'road_line' && d.size.x <= (period ?? 0) * 1.1;
      const u0 = solidDash ? 14 / 256 : 0, u1 = solidDash ? 12 / 256 + 0.58 - 2 / 256 : 1;
      const sub = Math.max(1, Math.ceil(segLen));            // ≤ 1 unit per quad along x
      const nb = Math.max(1, Math.ceil(d.size.y));            // ≤ 1 unit per quad along y
      for (let sg = 0; sg < segs; sg++) {
        const base = pos.length / 3;
        for (let j = 0; j <= nb; j++) for (let i = 0; i <= sub; i++) {
          const fu = i / sub, fv = j / nb;
          const a = -d.size.x / 2 + (sg + fu) * segLen, b = -d.size.y / 2 + fv * d.size.y;
          const x = d.pos.x + a * c - b * s, y = d.pos.y + a * s + b * c;
          pos.push(x, ext.sample(x, y) + LIFT, y);
          const nn = normalAt(x, y);
          nor.push(nn.x, nn.y, nn.z);
          uv.push((col + u0 + (u1 - u0) * fu) / DECAL_COLS, 1 - (row + fv) / DECAL_ROWS);
        }
        const rowLen = sub + 1;
        for (let j = 0; j < nb; j++) for (let i = 0; i < sub; i++) {
          const a = base + j * rowLen + i, b = a + 1, cc = a + rowLen, dd = cc + 1;
          idx.push(a, cc, dd, a, dd, b);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const atlas = createDecalAtlas(anisotropy);
    const mat = new THREE.MeshStandardMaterial({
      name: 'env-decals', map: atlas, transparent: true, depthWrite: false, roughness: 0.7, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    patchFogOfWar(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'env:decals';
    mesh.receiveShadow = true;
    mesh.renderOrder = -9;
    mesh.matrixAutoUpdate = false;
    this.mesh = mesh; this.geo = geo; this.mat = mat; this.atlas = atlas;
  }

  dispose(): void { this.geo?.dispose(); this.mat?.dispose(); this.atlas?.dispose(); }
}
