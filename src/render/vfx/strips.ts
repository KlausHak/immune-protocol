/**
 * [vfx] Camera-facing strips: instant beams (UV, heal), electric arcs, whip slashes, pseudopods and
 * projectile ribbon trails. Strips are rebuilt every frame on the CPU (≤ 16 points each, expanded
 * perpendicular to both the tangent and the view direction) into one dynamic vertex buffer drawn with a
 * static index buffer — one draw call, additive. The fragment shader gives a soft glow profile across
 * the width, an optional white-hot core, and optional flicker scrolling along the strip.
 */
import * as THREE from 'three';
import { FOG_PREMUL_GLSL, applyPremulBlending, fogUniforms } from './atlas';

export const STRIP_MAX_POINTS = 16;
const VSTRIDE = 12; // pos3, col4, params4 (u, v, seed, core), flicker1

const VERT = /* glsl */`
attribute vec4 aCol;
attribute vec4 aP;
attribute float aF;
varying vec4 vCol;
varying vec4 vP;
varying float vF;
#include <fog_pars_vertex>
void main() {
  vCol = aCol; vP = aP; vF = aF;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */`
uniform float uTime;
varying vec4 vCol;
varying vec4 vP;
varying float vF;
#include <fog_pars_fragment>
void main() {
  float d = abs(vP.y * 2.0 - 1.0);
  float glow = 1.0 - d;
  glow = glow * glow * (0.55 + 0.45 * glow);
  float core = vP.w * smoothstep(0.45, 0.0, d);
  float n = 1.0;
  if (vF > 0.0) {
    float s = vP.z;
    n = 1.0 + vF * (0.5 * sin(vP.x * 29.0 - uTime * 53.0 + s * 7.0) + 0.35 * sin(vP.x * 71.0 + uTime * 97.0 + s * 3.0));
  }
  vec3 col = (vCol.rgb * glow + (vec3(1.0) + vCol.rgb * 0.35) * core) * max(n, 0.0);
  float a = vCol.a;
  float add = 1.0;
  ${FOG_PREMUL_GLSL}
}
`;

export class StripBatch {
  readonly mesh: THREE.Mesh;
  readonly slots: number;
  private readonly data: Float32Array;
  private readonly buf: THREE.InterleavedBuffer;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly range = { start: 0, count: 0 };
  private used = 0;
  // current strip being built
  private n = 0;
  private readonly pts = new Float32Array(STRIP_MAX_POINTS * 5); // x y z width alphaMul
  private cr = 1; private cg = 1; private cb = 1; private ca = 1; private core = 0; private seed = 0; private flicker = 0;
  private camX = 0; private camY = 0; private camZ = 0;
  // fallback side vector (camera right) for tangents parallel to the view direction
  private rx = 1; private ry = 0; private rz = 0;

  constructor(slots: number) {
    this.slots = slots;
    const vertsPerSlot = STRIP_MAX_POINTS * 2;
    this.data = new Float32Array(slots * vertsPerSlot * VSTRIDE);
    this.buf = new THREE.InterleavedBuffer(this.data, VSTRIDE);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.InterleavedBufferAttribute(this.buf, 3, 0));
    this.geo.setAttribute('aCol', new THREE.InterleavedBufferAttribute(this.buf, 4, 3));
    this.geo.setAttribute('aP', new THREE.InterleavedBufferAttribute(this.buf, 4, 7));
    this.geo.setAttribute('aF', new THREE.InterleavedBufferAttribute(this.buf, 1, 11));
    const segs = STRIP_MAX_POINTS - 1;
    const idx = new Uint32Array(slots * segs * 6);
    let k = 0;
    for (let s = 0; s < slots; s++) {
      const base = s * vertsPerSlot;
      for (let j = 0; j < segs; j++) {
        const a = base + j * 2, b = a + 1, c = a + 2, d = a + 3;
        idx[k++] = a; idx[k++] = b; idx[k++] = c;
        idx[k++] = b; idx[k++] = d; idx[k++] = c;
      }
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms(), uTime: { value: 0 } },
      vertexShader: VERT, fragmentShader: FRAG, fog: true, side: THREE.DoubleSide,
    });
    applyPremulBlending(this.mat);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    this.mesh.name = 'vfx:strips';
  }

  get count(): number { return this.used; }

  begin(cam: THREE.Camera, time: number): void {
    this.used = 0;
    this.mat.uniforms.uTime!.value = time;
    const e = cam.matrixWorld.elements;
    this.camX = e[12]!; this.camY = e[13]!; this.camZ = e[14]!;
    this.rx = e[0]!; this.ry = e[1]!; this.rz = e[2]!;
  }

  /** Starts a strip. Returns false when the batch is full (caller should skip its points). */
  start(r: number, g: number, b: number, a: number, core = 0, flicker = 0, seed = 0): boolean {
    if (this.used >= this.slots) return false;
    this.n = 0; this.cr = r; this.cg = g; this.cb = b; this.ca = a; this.core = core; this.flicker = flicker; this.seed = seed;
    return true;
  }

  /** Adds a point (world space) with a full width and an alpha multiplier. */
  point(x: number, y: number, z: number, width: number, alphaMul = 1): void {
    if (this.n >= STRIP_MAX_POINTS) return;
    const o = this.n++ * 5, p = this.pts;
    p[o] = x; p[o + 1] = y; p[o + 2] = z; p[o + 3] = width; p[o + 4] = alphaMul;
  }

  /** Expands the current strip into the vertex buffer. */
  end(): void {
    const n = this.n;
    if (n < 2) return;
    const p = this.pts, d = this.data;
    const base = this.used * STRIP_MAX_POINTS * 2 * VSTRIDE;
    let lx = 0, ly = 0, lz = 0, ux = 0, uy = 0, uz = 0;
    for (let i = 0; i < STRIP_MAX_POINTS; i++) {
      const ii = i < n ? i : n - 1;
      const o = ii * 5;
      const x = p[o]!, y = p[o + 1]!, z = p[o + 2]!, hw = p[o + 3]! * 0.5;
      const am = i < n ? p[o + 4]! : 0;
      if (i < n) {
        const a = (ii > 0 ? ii - 1 : 0) * 5, b = (ii < n - 1 ? ii + 1 : n - 1) * 5;
        const tx = p[b]! - p[a]!, ty = p[b + 1]! - p[a + 1]!, tz = p[b + 2]! - p[a + 2]!;
        const vx = this.camX - x, vy = this.camY - y, vz = this.camZ - z;
        let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
        let sl = Math.hypot(sx, sy, sz);
        if (sl < 1e-6) { sx = this.rx; sy = this.ry; sz = this.rz; sl = Math.hypot(sx, sy, sz) || 1; }
        sx = (sx / sl) * hw; sy = (sy / sl) * hw; sz = (sz / sl) * hw;
        lx = x - sx; ly = y - sy; lz = z - sz; ux = x + sx; uy = y + sy; uz = z + sz;
      }
      const u = n > 1 ? ii / (n - 1) : 0;
      const o0 = base + i * 2 * VSTRIDE, o1 = o0 + VSTRIDE;
      d[o0] = lx; d[o0 + 1] = ly; d[o0 + 2] = lz;
      d[o1] = ux; d[o1 + 1] = uy; d[o1 + 2] = uz;
      const al = this.ca * am;
      d[o0 + 3] = d[o1 + 3] = this.cr; d[o0 + 4] = d[o1 + 4] = this.cg; d[o0 + 5] = d[o1 + 5] = this.cb; d[o0 + 6] = d[o1 + 6] = al;
      d[o0 + 7] = d[o1 + 7] = u; d[o0 + 8] = 0; d[o1 + 8] = 1;
      d[o0 + 9] = d[o1 + 9] = this.seed; d[o0 + 10] = d[o1 + 10] = this.core;
      d[o0 + 11] = d[o1 + 11] = this.flicker;
    }
    this.used++;
  }

  flush(): void {
    const verts = this.used * STRIP_MAX_POINTS * 2;
    this.geo.setDrawRange(0, this.used * (STRIP_MAX_POINTS - 1) * 6);
    if (verts > 0) {
      this.buf.clearUpdateRanges();
      this.range.start = 0; this.range.count = verts * VSTRIDE;
      this.buf.updateRanges.push(this.range);
      this.buf.needsUpdate = true;
    }
  }

  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}
