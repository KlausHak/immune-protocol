/**
 * [environment] Extended terrain grid: the map's own vertex heights plus a natural "skirt" of PAD tiles
 * beyond every edge (gentle hills sloping into the sea) so the camera never looks into a void. Inside the
 * map the heights are exactly MapData.heights, so sampleHeight() and the rendered ground agree.
 */
import * as THREE from 'three';
import { LEVEL_HEIGHT } from '../../config';
import { Terrain, type MapData } from '../../core/types';
import { sampleHeight } from '../../core/terrain';
import { fbm, hash01, smoothstep } from './noise';

export const PAD = 40;

export class ExtendedTerrain {
  /** tiles per side incl. skirt */
  readonly tw: number; readonly th: number;
  /** vertices per side (tw + 1, th + 1) */
  readonly vw: number; readonly vh: number;
  /** world coords of grid vertex (0, 0) */
  readonly x0 = -PAD; readonly y0 = -PAD;
  /** vertex heights (vw × vh) */
  readonly heights: Float32Array;
  /** terrain id per tile (tw × th) */
  readonly ids: Uint8Array;
  readonly waterLevel: number;
  /** lowest point of the outer sea floor */
  readonly seaFloor: number;

  constructor(readonly map: MapData) {
    const W = map.width, H = map.height;
    this.tw = W + 2 * PAD; this.th = H + 2 * PAD;
    this.vw = this.tw + 1; this.vh = this.th + 1;
    this.waterLevel = Number.isFinite(map.waterLevel) ? map.waterLevel : -0.4;
    this.seaFloor = this.waterLevel - 3.2;
    this.heights = new Float32Array(this.vw * this.vh);
    this.ids = new Uint8Array(this.tw * this.th);
    this.buildHeights();
    this.buildIds();
  }

  private buildHeights(): void {
    const map = this.map, W = map.width, H = map.height, wl = this.waterLevel;
    const landBase = Math.max(wl + 0.25, 0);
    for (let j = 0; j < this.vh; j++) for (let i = 0; i < this.vw; i++) {
      const x = i + this.x0, y = j + this.y0;
      let h: number;
      if (x >= 0 && y >= 0 && x <= W && y <= H) {
        h = map.heights[y * (W + 1) + x]!;
      } else {
        const cx = Math.min(Math.max(x, 0), W), cy = Math.min(Math.max(y, 0), H);
        const d = Math.hypot(x - cx, y - cy);
        const edge = sampleHeight(map, cx, cy);
        const u = (x + 200) / 400, v = (y + 200) / 400;
        const n = fbm(u, v, 8, 4, 77) * 0.5 + 0.5;              // 0..1 rolling hills
        if (edge < wl) {
          // sea continues and deepens
          h = edge + (this.seaFloor - edge) * smoothstep(0, 22, d);
        } else {
          // land: blend from the edge height into low hills, then a shoreline drops into the sea
          const hills = landBase + n * 2.6 * LEVEL_HEIGHT * 0.5 + Math.max(0, edge - landBase) * 0.6;
          h = edge + (hills - edge) * smoothstep(1.5, 12, d);
          const shore = 25 + fbm(u * 2, v * 2, 6, 3, 78) * 9;   // irregular coastline
          h += (this.seaFloor - h) * smoothstep(shore - 5, shore + 7, d);
        }
      }
      this.heights[j * this.vw + i] = h;
    }
  }

  private buildIds(): void {
    const map = this.map, W = map.width, H = map.height, wl = this.waterLevel;
    for (let ty = 0; ty < this.th; ty++) for (let tx = 0; tx < this.tw; tx++) {
      const x = tx + this.x0, y = ty + this.y0;
      let id: number;
      if (x >= 0 && y >= 0 && x < W && y < H) id = map.terrain[y * W + x]!;
      else {
        const cx = Math.min(Math.max(x, 0), W - 1), cy = Math.min(Math.max(y, 0), H - 1);
        const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
        const h = this.tileHeight(tx, ty);
        if (d <= 2) id = map.terrain[cy * W + cx]!;
        else if (h < wl - 0.15) id = Terrain.Water;
        else if (h < wl + 0.35) id = hash01(tx >> 2, ty >> 2, 5) > 0.45 ? Terrain.Rock : Terrain.Sand;
        else {
          const u = (x + 200) / 400, v = (y + 200) / 400;
          const r = fbm(u, v, 16, 3, 91), s = fbm(u, v, 12, 3, 92), dd = fbm(u, v, 20, 2, 93);
          id = r > 0.32 ? Terrain.Rock : s > 0.3 ? Terrain.Snow : dd > 0.42 ? Terrain.Dirt : Terrain.Grass;
        }
        // water tiles continue as sea bed; never leave a "Water" id on dry skirt land
        if (id === Terrain.Water && h > wl + 0.05) id = Terrain.Sand;
      }
      this.ids[ty * this.tw + tx] = id;
    }
  }

  /** mean height of a skirt-grid tile */
  tileHeight(tx: number, ty: number): number {
    const v = this.vw, h = this.heights;
    return (h[ty * v + tx]! + h[ty * v + tx + 1]! + h[(ty + 1) * v + tx]! + h[(ty + 1) * v + tx + 1]!) * 0.25;
  }

  /** Vertex height in extended-grid vertex coords (clamped). */
  vertex(i: number, j: number): number {
    i = Math.min(Math.max(i, 0), this.vw - 1); j = Math.min(Math.max(j, 0), this.vh - 1);
    return this.heights[j * this.vw + i]!;
  }

  /** Bilinear height at world (x, y), valid inside the map and the skirt. */
  sample(x: number, y: number): number {
    const gx = Math.min(Math.max(x - this.x0, 0), this.tw), gy = Math.min(Math.max(y - this.y0, 0), this.th);
    const i0 = Math.min(Math.floor(gx), this.tw - 1), j0 = Math.min(Math.floor(gy), this.th - 1);
    const fx = gx - i0, fy = gy - j0, v = this.vw, h = this.heights;
    const a = h[j0 * v + i0]!, b = h[j0 * v + i0 + 1]!, c = h[(j0 + 1) * v + i0]!, d = h[(j0 + 1) * v + i0 + 1]!;
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  /** Terrain id texture (one texel per extended tile; read with texelFetch). */
  createIndexTexture(): THREE.DataTexture {
    const t = new THREE.DataTexture(this.ids, this.tw, this.th, THREE.RedFormat, THREE.UnsignedByteType);
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.unpackAlignment = 1;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }

  /** Half-float height texture over the extended vertex grid (water depth / shoreline foam). */
  createHeightTexture(): THREE.DataTexture {
    const n = this.vw * this.vh, d = new Uint16Array(n);
    for (let i = 0; i < n; i++) d[i] = THREE.DataUtils.toHalfFloat(this.heights[i]!);
    const t = new THREE.DataTexture(d, this.vw, this.vh, THREE.RedFormat, THREE.HalfFloatType);
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.unpackAlignment = 2;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }
}
