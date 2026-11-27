/**
 * [render-core] One dynamic, terrain-conforming quad batch for every flat ground overlay: selection rings
 * and footprint rectangles, hover rings, animated command markers, placement tiles, range rings and the
 * dashed rally line. All shapes are signed-distance fields with derivative-based anti-aliasing, so they stay
 * crisp at every zoom level. One draw call; buffers are rebuilt each frame without allocations.
 */
import * as THREE from 'three';
import type { MapData } from '../../core/types';
import { sampleHeight } from '../../core/terrain';

export const DecalKind = {
  Ring: 0,      // selection / hover: rounded-box ring (+rim glow, optional dashes)
  Tile: 1,      // placement tile: fill + border
  Move: 2,      // shrinking ring + inward chevrons
  Attack: 3,    // ring + rotating ticks
  Pulse: 4,     // double expanding ring (gather / rally)
  Build: 5,     // shrinking rounded square with corner brackets
  Plus: 6,      // medical plus (repair)
  Dash: 7,      // dashed band segment (rally line)
  DashRing: 8,  // dashed circle (weapon range)
  Patrol: 9,    // ring + orbiting chevrons
} as const;
export type DecalKindId = (typeof DecalKind)[keyof typeof DecalKind];

const VERT = /* glsl */`
attribute vec2 aLocal;
attribute vec4 aShape;
attribute vec4 aColor;
attribute vec4 aParam;
varying vec2 vLocal;
varying vec4 vShape;
varying vec4 vColor;
varying vec4 vParam;
void main() {
  vLocal = aLocal; vShape = aShape; vColor = aColor; vParam = aParam;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
uniform float uTime;
varying vec2 vLocal;
varying vec4 vShape;
varying vec4 vColor;
varying vec4 vParam;

const float TAU = 6.28318530718;
float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + vec2(r); return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float band(float d, float hw, float aa) { return 1.0 - smoothstep(hw - aa, hw + aa, abs(d)); }
float fillIn(float d, float aa) { return 1.0 - smoothstep(-aa, aa, d); }
vec2 rot2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
vec2 foldN(vec2 p, float n) { float s = TAU / n; float a = atan(p.y, p.x); a = mod(a + 0.5 * s, s) - 0.5 * s; return vec2(cos(a), sin(a)) * length(p); }
float easeOut(float t) { float u = 1.0 - t; return 1.0 - u * u * u; }

void main() {
  float kind = vParam.x;
  float t = clamp(vParam.y, 0.0, 1.0);
  vec2 p = vLocal;
  float a = 0.0;
  if (kind < 0.5) {
    float d = sdRoundBox(p, vShape.xy, vShape.z);
    float aa = max(fwidth(d), 1e-4);
    float th = max(vShape.w, aa * 1.6);
    float ring = band(d + th * 0.5, th * 0.5, aa);
    if (vParam.w > 0.5) {
      float ph = fract((atan(p.y, p.x) / TAU + uTime * 0.06) * vParam.w);
      ring *= smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.52, 0.6, ph));
    }
    float m = min(vShape.x, vShape.y);
    float rim = fillIn(d, aa) * pow(clamp(1.0 + d / (m * 0.6), 0.0, 1.0), 2.2);
    a = max(ring, rim * vParam.z);
  } else if (kind < 1.5) {
    float d = sdRoundBox(p, vShape.xy, vShape.z);
    float aa = max(fwidth(d), 1e-4);
    float th = max(vShape.w, aa * 1.2);
    a = max(band(d + th * 0.5, th * 0.5, aa), fillIn(d, aa) * vParam.z);
  } else if (kind < 2.5) {
    float R = vShape.x; float e = easeOut(t);
    float l = length(p);
    float aa = max(fwidth(l), 1e-4);
    float hw = max(R * 0.045, aa * 0.8);
    float r = R * mix(1.0, 0.3, e);
    float ring = band(l - r, hw, aa);
    vec2 q = foldN(rot2(p, 0.7853981634), 4.0);
    float rc = r + R * 0.1 + R * 0.28 * (1.0 - e);
    float chev = sdSeg(vec2(q.x, abs(q.y)), vec2(rc, 0.0), vec2(rc + R * 0.2, R * 0.17));
    a = max(ring, band(chev, hw, aa)) * (1.0 - t * t);
    a = max(a, fillIn(l - R * 0.07, aa) * (1.0 - t));
  } else if (kind < 3.5) {
    float R = vShape.x; float e = easeOut(t);
    float l = length(p);
    float aa = max(fwidth(l), 1e-4);
    float hw = max(R * 0.05, aa * 0.8);
    float r = R * mix(1.1, 0.72, e);
    float ring = band(l - r, hw, aa);
    vec2 q = foldN(rot2(p, -e * 0.7853981634), 4.0);
    float tick = sdSeg(q, vec2(r * 0.42, 0.0), vec2(r * 1.18, 0.0));
    a = max(ring, band(tick, hw, aa)) * (1.0 - t * t);
  } else if (kind < 4.5) {
    float R = vShape.x; float l = length(p);
    float aa = max(fwidth(l), 1e-4);
    float hw = max(R * 0.045, aa * 0.8);
    float t2 = clamp(t * 1.4 - 0.4, 0.0, 1.0);
    float r1 = R * mix(0.2, 1.0, easeOut(t)), r2 = R * mix(0.2, 1.0, easeOut(t2));
    a = band(l - r1, hw, aa) * (1.0 - t) + band(l - r2, hw, aa) * (1.0 - t2) * step(0.001, t2);
    a = max(a, fillIn(l - R * 0.1, aa) * (1.0 - t));
  } else if (kind < 5.5) {
    float R = vShape.x; float e = easeOut(t);
    float s = R * mix(1.0, 0.68, e);
    float d = sdRoundBox(p, vec2(s), s * 0.22);
    float aa = max(fwidth(d), 1e-4);
    float hw = max(R * 0.045, aa * 0.8);
    vec2 ap = abs(p);
    float corner = step(s * 0.42, min(ap.x, ap.y));
    a = band(d, hw, aa) * mix(0.3, 1.0, corner) * (1.0 - t * t);
  } else if (kind < 6.5) {
    float R = vShape.x; float e = easeOut(t);
    float s = R * mix(0.45, 0.7, e);
    float d = min(sdRoundBox(p, vec2(s, s * 0.3), s * 0.12), sdRoundBox(p, vec2(s * 0.3, s), s * 0.12));
    float aa = max(fwidth(d), 1e-4);
    float ring = band(length(p) - R * mix(0.8, 1.05, e), max(R * 0.04, aa * 0.8), aa);
    a = max(fillIn(d, aa) * 0.85, ring) * (1.0 - t * t);
  } else if (kind < 7.5) {
    float across = abs(p.y);
    float aa = max(fwidth(across), 1e-4);
    float b = 1.0 - smoothstep(vShape.y - aa, vShape.y + aa, across);
    float period = max(vShape.z, 0.01);
    float ph = fract((p.x - uTime * vParam.w) / period);
    float pa = fwidth(p.x) / period + 0.02;
    float dash = smoothstep(0.0, pa, ph) * (1.0 - smoothstep(0.55 - pa, 0.55, ph));
    a = b * dash;
  } else if (kind < 8.5) {
    float l = length(p);
    float aa = max(fwidth(l), 1e-4);
    float ring = band(l - vShape.x, max(vShape.w * 0.5, aa * 0.75), aa);
    float ph = fract(atan(p.y, p.x) / TAU * vParam.w + uTime * 0.04);
    a = ring * step(ph, 0.6) + fillIn(l - vShape.x, aa) * vParam.z;
  } else {
    float R = vShape.x; float e = easeOut(t);
    float l = length(p);
    float aa = max(fwidth(l), 1e-4);
    float hw = max(R * 0.045, aa * 0.8);
    float r = R * mix(1.0, 0.7, e);
    vec2 q = foldN(rot2(p, -t * 2.5), 2.0);
    float chev = sdSeg(vec2(abs(q.x - r), q.y), vec2(0.0, R * 0.14), vec2(R * 0.16, -R * 0.06));
    a = max(band(l - r, hw, aa) * 0.7, band(chev, hw * 1.2, aa)) * (1.0 - t * t);
  }
  a *= vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const VERTS_PER_QUAD = 4;
/** item sizes of [position, aLocal, aShape, aColor, aParam] */
const ATTR_SIZES = [3, 2, 4, 4, 4] as const;
const IDX_PER_QUAD = 6;

export class GroundDecals {
  readonly mesh: THREE.Mesh;
  private geo!: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private capacity = 0;
  private count = 0;
  private pos!: Float32Array;
  private local!: Float32Array;
  private shape!: Float32Array;
  private color!: Float32Array;
  private param!: Float32Array;
  private attrs: THREE.BufferAttribute[] = [];

  constructor(private readonly map: MapData, initialCapacity = 256) {
    this.mat = new THREE.ShaderMaterial({
      name: 'GroundDecals', vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uTime: { value: 0 } },
      transparent: true, depthWrite: false, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.allocate(initialCapacity);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'render-core:ground-decals';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = -10; // first among transparents: VFX & ghosts draw over the ground overlays
  }

  private allocate(capacity: number): void {
    const old = this.geo;
    const n = capacity * VERTS_PER_QUAD;
    const pos = new Float32Array(n * 3), local = new Float32Array(n * 2), shape = new Float32Array(n * 4);
    const color = new Float32Array(n * 4), param = new Float32Array(n * 4);
    if (old) { pos.set(this.pos); local.set(this.local); shape.set(this.shape); color.set(this.color); param.set(this.param); }
    this.pos = pos; this.local = local; this.shape = shape; this.color = color; this.param = param;
    const idx = new Uint32Array(capacity * IDX_PER_QUAD);
    for (let q = 0; q < capacity; q++) {
      const v = q * 4, i = q * 6;
      idx[i] = v; idx[i + 1] = v + 2; idx[i + 2] = v + 1; idx[i + 3] = v; idx[i + 4] = v + 3; idx[i + 5] = v + 2;
    }
    const geo = new THREE.BufferGeometry();
    const mk = (arr: Float32Array, size: number) => { const a = new THREE.BufferAttribute(arr, size); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.attrs = [mk(pos, 3), mk(local, 2), mk(shape, 4), mk(color, 4), mk(param, 4)];
    geo.setAttribute('position', this.attrs[0]!);
    geo.setAttribute('aLocal', this.attrs[1]!);
    geo.setAttribute('aShape', this.attrs[2]!);
    geo.setAttribute('aColor', this.attrs[3]!);
    geo.setAttribute('aParam', this.attrs[4]!);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    this.capacity = capacity;
    if (old) { (this.mesh as THREE.Mesh).geometry = geo; old.dispose(); }
  }

  begin(): void { this.count = 0; }

  private reserve(quads: number): void {
    if (this.count + quads <= this.capacity) return;
    let c = this.capacity;
    while (c < this.count + quads) c *= 2;
    this.allocate(c);
  }

  /** Writes one vertex. */
  private vtx(v: number, x: number, y: number, h: number, lx: number, ly: number): void {
    this.pos[v * 3] = x; this.pos[v * 3 + 1] = h; this.pos[v * 3 + 2] = y;
    this.local[v * 2] = lx; this.local[v * 2 + 1] = ly;
  }
  private quadAttrs(q: number, s0: number, s1: number, s2: number, s3: number, col: THREE.Color, boost: number, alpha: number,
    kind: number, t: number, p2: number, p3: number): void {
    for (let k = 0; k < 4; k++) {
      const v = q * 4 + k;
      this.shape[v * 4] = s0; this.shape[v * 4 + 1] = s1; this.shape[v * 4 + 2] = s2; this.shape[v * 4 + 3] = s3;
      this.color[v * 4] = col.r * boost; this.color[v * 4 + 1] = col.g * boost; this.color[v * 4 + 2] = col.b * boost; this.color[v * 4 + 3] = alpha;
      this.param[v * 4] = kind; this.param[v * 4 + 1] = t; this.param[v * 4 + 2] = p2; this.param[v * 4 + 3] = p3;
    }
  }

  /**
   * A shape centred at (cx, cy) (sim coords). Local frame: x along `rot` (sim facing convention).
   * shape = (halfW, halfH, corner, thickness) in world units; pad = extra quad margin around the shape;
   * sub = grid subdivisions so large decals follow uneven terrain.
   */
  quad(cx: number, cy: number, halfW: number, halfH: number, pad: number, rot: number, corner: number, thickness: number,
    col: THREE.Color, boost: number, alpha: number, kind: number, t: number, p2: number, p3: number, lift = 0.05, sub = 1): void {
    if (alpha <= 0) return;
    sub = Math.max(1, Math.min(12, sub | 0));
    this.reserve(sub * sub);
    const ex = halfW + pad, ey = halfH + pad;
    const c = Math.cos(rot), s = Math.sin(rot);
    const map = this.map;
    for (let j = 0; j < sub; j++) {
      for (let i = 0; i < sub; i++) {
        const q = this.count++;
        const lx0 = -ex + (2 * ex * i) / sub, lx1 = -ex + (2 * ex * (i + 1)) / sub;
        const ly0 = -ey + (2 * ey * j) / sub, ly1 = -ey + (2 * ey * (j + 1)) / sub;
        for (let k = 0; k < 4; k++) {
          const lx = k === 0 || k === 3 ? lx0 : lx1;
          const ly = k < 2 ? ly0 : ly1;
          const wx = cx + lx * c - ly * s, wy = cy + lx * s + ly * c;
          this.vtx(q * 4 + k, wx, wy, sampleHeight(map, wx, wy) + lift, lx, ly);
        }
        this.quadAttrs(q, halfW, halfH, corner, thickness, col, boost, alpha, kind, t, p2, p3);
      }
    }
  }

  /**
   * Dashed band from a to b (sim coords). `dist0` = distance along the whole line at `a` so dashes flow
   * continuously across consecutive segments.
   */
  segment(ax: number, ay: number, bx: number, by: number, halfWidth: number, dist0: number, period: number, speed: number,
    col: THREE.Color, boost: number, alpha: number, lift = 0.06): void {
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (len < 1e-4 || alpha <= 0) return;
    this.reserve(1);
    const q = this.count++;
    const hw = halfWidth + 0.04;
    const nx = (-dy / len) * hw, ny = (dx / len) * hw;
    const map = this.map;
    const h0 = sampleHeight(map, ax, ay) + lift, h1 = sampleHeight(map, bx, by) + lift;
    this.vtx(q * 4, ax - nx, ay - ny, h0, dist0, -hw);
    this.vtx(q * 4 + 1, bx - nx, by - ny, h1, dist0 + len, -hw);
    this.vtx(q * 4 + 2, bx + nx, by + ny, h1, dist0 + len, hw);
    this.vtx(q * 4 + 3, ax + nx, ay + ny, h0, dist0, hw);
    this.quadAttrs(q, 0, halfWidth, period, 0, col, boost, alpha, DecalKind.Dash, 0, 0, speed);
  }

  /** Uploads the frame's quads. */
  end(time: number): void {
    this.mat.uniforms.uTime!.value = time;
    const n = this.count * VERTS_PER_QUAD;
    for (let i = 0; i < this.attrs.length; i++) {
      const a = this.attrs[i]!;
      a.clearUpdateRanges();
      if (n > 0) { a.addUpdateRange(0, n * ATTR_SIZES[i]!); a.needsUpdate = true; }
    }
    this.geo.setDrawRange(0, this.count * IDX_PER_QUAD);
    this.mesh.visible = this.count > 0;
  }

  get quadCount(): number { return this.count; }

  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}
