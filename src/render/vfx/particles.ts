/**
 * [vfx] GPU particle pool. Particles are *stateless* on the CPU: each is written once at spawn into an
 * instanced interleaved buffer (ring buffer), and the vertex shader evaluates its motion analytically
 * from the spawn time — position under gravity + linear drag, a floor clamp, size/colour/alpha over life,
 * spin, optional sinusoidal wobble. So per-frame CPU cost is only the bytes of newly spawned particles
 * (uploaded with ≤ 2 bufferSubData ranges) and there are no per-frame allocations.
 *
 * Blending is premultiplied alpha with a per-particle `additive` factor (0 = normal alpha, 1 = additive),
 * so smoke/goo/dust and glows/sparks share ONE draw call.
 *
 * Usage (chainable builder, allocation-free):
 *   pool.begin(SPR.SPARK, PM_STRETCH).at(x, y, z).sphere(3, 7).life(0.2, 0.4).size(0.08, 0.12, 0.3)
 *       .color(3, 2, 1, 1).gravity(-9).drag(2).stretch(0.04).additive(1).emit(12);
 */
import * as THREE from 'three';
import { ATLAS_UV_GLSL, FOG_PREMUL_GLSL, applyPremulBlending, fogUniforms } from './atlas';
import type { VfxRng } from './rng';

/** Camera-facing quad. */
export const PM_BILLBOARD = 0;
/** Quad stretched along the screen-space velocity (sparks, streaks, rain of drips). */
export const PM_STRETCH = 1;
/** Quad lying flat on the XZ plane (ground rings, shockwaves, ground glows). */
export const PM_GROUND = 2;

const STRIDE = 32;

const VERT = /* glsl */`
uniform float uTime;
attribute vec4 aA; // p0.xyz, t0
attribute vec4 aB; // v0.xyz, life
attribute vec4 aC; // gravityY, drag, floorY, spin
attribute vec4 aD; // size0, size1, stretch(seconds), sprite + 16*mode
attribute vec4 aE; // rgb0 (HDR), a0
attribute vec4 aF; // rgb1, a1
attribute vec4 aG; // rot0, fadeIn (life fraction), additive, sizePow
attribute vec4 aH; // colorPow, wobbleAmp, wobbleFreq, seed
varying vec2 vUv;
varying vec4 vCol;
varying float vAdd;
#include <fog_pars_vertex>
${ATLAS_UV_GLSL}
void main() {
  float age = uTime - aA.w;
  float x = age / aB.w;
  vUv = vec2(0.0); vCol = vec4(0.0); vAdd = 0.0;
  if (x < 0.0 || x >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = max(aC.y, 0.01);
  float e = exp(-k * age);
  float f = (1.0 - e) / k;
  vec3 g = vec3(0.0, aC.x, 0.0);
  vec3 wp = aA.xyz + aB.xyz * f + g * ((age - f) / k);
  if (aH.y > 0.0) {
    float ph = aH.w + age * aH.z;
    wp += vec3(sin(ph), sin(ph * 0.71 + 1.3) * 0.5, cos(ph * 1.13 + 0.4)) * aH.y * min(1.0, x * 4.0);
  }
  bool grounded = wp.y <= aC.z;
  wp.y = max(wp.y, aC.z);
  float size = mix(aD.x, aD.y, pow(x, aG.w));
  float mode = floor(aD.w / 16.0 + 0.001);
  float sprite = aD.w - mode * 16.0;
  vec2 corner = position.xy;
  float rot = aG.x + aC.w * age;
  vec4 mvPosition;
  if (mode < 0.5) {
    float c = cos(rot), s = sin(rot);
    mvPosition = modelViewMatrix * vec4(wp, 1.0);
    mvPosition.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
  } else if (mode < 1.5) {
    vec3 vel = aB.xyz * e + g * f;
    if (grounded) vel.y = 0.0;
    mvPosition = modelViewMatrix * vec4(wp, 1.0);
    vec3 vv = mat3(modelViewMatrix) * vel;
    float sp = length(vv.xy);
    vec2 dir = sp > 1e-4 ? vv.xy / sp : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float len = size + aD.z * sp;
    mvPosition.xy += dir * corner.x * len + nrm * corner.y * size;
  } else {
    float c = cos(rot), s = sin(rot);
    vec3 off = vec3(c * corner.x - s * corner.y, 0.0, s * corner.x + c * corner.y) * size;
    mvPosition = modelViewMatrix * vec4(wp + off, 1.0);
  }
  gl_Position = projectionMatrix * mvPosition;
  vUv = atlasUv(sprite, corner);
  float fadeIn = aG.y > 0.0 ? clamp(x / aG.y, 0.0, 1.0) : 1.0;
  vCol = mix(aE, aF, pow(x, aH.x));
  vCol.a *= fadeIn;
  vAdd = aG.z;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */`
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vCol;
varying float vAdd;
#include <fog_pars_fragment>
void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  float a = tex.a * vCol.a;
  if (a < 0.002) discard;
  vec3 col = vCol.rgb * tex.rgb;
  float add = vAdd;
  ${FOG_PREMUL_GLSL}
}
`;

// position modes
const POS_POINT = 0, POS_SPHERE = 1, POS_DISC = 2, POS_BOX = 3, POS_LINE = 4;
// velocity modes
const VEL_FIXED = 0, VEL_SPHERE = 1, VEL_HEMI = 2, VEL_CONE = 3, VEL_RADIAL = 4;

export class ParticlePool {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly data: Float32Array;
  private readonly deathT: Float32Array;
  private readonly buf: THREE.InstancedInterleavedBuffer;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private head = 0;
  /** slots written since the last GPU upload (survives several update() calls between renders) */
  private pendStart = 0;
  private pendCount = 0;
  private total = 0;
  private readonly rangeA = { start: 0, count: 0 };
  private readonly rangeB = { start: 0, count: 0 };

  /** Spawn time stamped on subsequently emitted particles (sim-synced seconds). */
  t0 = 0;
  /** Render time (for live-overwrite detection). */
  now = 0;
  /** Emission multiplier (quality × load pressure) applied by emit(). */
  mul = 1;
  /** Live particles overwritten this frame (pool too small for the load) — drives the pressure throttle. */
  overwrites = 0;

  // ── builder state ──
  private sprite = 0; private mode = 0;
  private px = 0; private py = 0; private pz = 0;
  private posMode = POS_POINT; private pr = 0; private prMin = 0; private bx = 0; private by = 0; private bz = 0;
  private velMode = VEL_FIXED; private bvx = 0; private bvy = 0; private bvz = 0;
  private dx = 0; private dy = 1; private dz = 0; private cosSpread = 1;
  private t1x = 1; private t1y = 0; private t1z = 0; private t2x = 0; private t2y = 0; private t2z = 1;
  private sMin = 0; private sMax = 0; private upMin = 0; private upMax = 0;
  private lifeMin = 1; private lifeMax = 1;
  private s0Min = 0.2; private s0Max = 0.2; private sEnd = 1; private sPow = 1;
  private grav = 0; private drg = 0; private flr = -1e4; private spinMax = 0; private rotFixed = NaN; private str = 0;
  private r0 = 1; private g0 = 1; private b0 = 1; private a0 = 1;
  private r1 = 1; private g1 = 1; private b1 = 1; private a1 = 0;
  private altP = 0; private ar = 1; private ag = 1; private ab = 1;
  private brMin = 1; private brMax = 1;
  private fIn = 0; private cPow = 1; private add = 0; private wobA = 0; private wobF = 0;

  constructor(capacity: number, atlas: THREE.Texture, private readonly rng: VfxRng) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    this.deathT = new Float32Array(capacity);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    this.buf.onUpload(() => { this.pendCount = 0; });
    const names = ['aA', 'aB', 'aC', 'aD', 'aE', 'aF', 'aG', 'aH'];
    names.forEach((n, i) => this.geo.setAttribute(n, new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4)));
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms(), uTime: { value: 0 }, uAtlas: { value: atlas } },
      vertexShader: VERT, fragmentShader: FRAG, fog: true,
    });
    applyPremulBlending(this.mat);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'vfx:particles';
  }

  /** Approximate live count (slots whose death time is in the future) — debug/stats only (O(capacity)). */
  countAlive(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.deathT[i]! > this.now) n++;
    return n;
  }

  // ───────────────────────── builder ─────────────────────────
  begin(sprite: number, mode = PM_BILLBOARD): this {
    this.sprite = sprite; this.mode = mode;
    this.posMode = POS_POINT; this.pr = 0; this.prMin = 0;
    this.velMode = VEL_FIXED; this.bvx = this.bvy = this.bvz = 0; this.sMin = this.sMax = 0; this.upMin = this.upMax = 0;
    this.lifeMin = this.lifeMax = 1;
    this.s0Min = this.s0Max = 0.2; this.sEnd = 1; this.sPow = 1;
    this.grav = 0; this.drg = 0; this.flr = -1e4; this.spinMax = 0; this.rotFixed = NaN; this.str = 0;
    this.r0 = this.g0 = this.b0 = this.a0 = 1; this.r1 = this.g1 = this.b1 = 1; this.a1 = 0;
    this.altP = 0; this.brMin = this.brMax = 1;
    this.fIn = 0; this.cPow = 1; this.add = 0; this.wobA = 0; this.wobF = 0;
    return this;
  }
  at(x: number, y: number, z: number): this { this.px = x; this.py = y; this.pz = z; return this; }
  /** Random offset inside a sphere of radius r. */
  jitter(r: number): this { this.posMode = POS_SPHERE; this.pr = r; return this; }
  /** Random offset in a horizontal annulus [rMin, r]. */
  disc(r: number, rMin = 0): this { this.posMode = POS_DISC; this.pr = r; this.prMin = rMin; return this; }
  box(hx: number, hy: number, hz: number): this { this.posMode = POS_BOX; this.bx = hx; this.by = hy; this.bz = hz; return this; }
  /** Random point along the segment from at() to (x2, y2, z2). */
  line(x2: number, y2: number, z2: number): this { this.posMode = POS_LINE; this.bx = x2; this.by = y2; this.bz = z2; return this; }
  /** Base velocity added to every particle. */
  vel(vx: number, vy: number, vz: number): this { this.bvx = vx; this.bvy = vy; this.bvz = vz; return this; }
  sphere(sMin: number, sMax: number): this { this.velMode = VEL_SPHERE; this.sMin = sMin; this.sMax = sMax; return this; }
  hemi(sMin: number, sMax: number): this { this.velMode = VEL_HEMI; this.sMin = sMin; this.sMax = sMax; return this; }
  /** Velocity inside a cone around (dx, dy, dz) (need not be normalised), half-angle `spread` radians. */
  cone(dx: number, dy: number, dz: number, spread: number, sMin: number, sMax: number): this {
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    this.velMode = VEL_CONE; this.dx = dx; this.dy = dy; this.dz = dz; this.cosSpread = Math.cos(spread);
    this.sMin = sMin; this.sMax = sMax;
    // orthonormal basis around d
    let hx = 0, hy = 1, hz = 0;
    if (Math.abs(dy) > 0.95) { hx = 1; hy = 0; }
    let ax = dy * hz - dz * hy, ay = dz * hx - dx * hz, az = dx * hy - dy * hx;
    const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
    this.t1x = ax; this.t1y = ay; this.t1z = az;
    this.t2x = dy * az - dz * ay; this.t2y = dz * ax - dx * az; this.t2z = dx * ay - dy * ax;
    return this;
  }
  /** Velocity along the spawn offset direction (outward bursts / rings). */
  radial(sMin: number, sMax: number): this { this.velMode = VEL_RADIAL; this.sMin = sMin; this.sMax = sMax; return this; }
  up(min: number, max: number): this { this.upMin = min; this.upMax = max; return this; }
  life(min: number, max = min): this { this.lifeMin = min; this.lifeMax = max; return this; }
  /** Start size range and end size as a multiple of the start size; pow shapes the size curve (<1 = fast growth). */
  size(min: number, max = min, endMul = 1, pow = 1): this { this.s0Min = min; this.s0Max = max; this.sEnd = endMul; this.sPow = pow; return this; }
  gravity(g: number): this { this.grav = g; return this; }
  drag(k: number): this { this.drg = k; return this; }
  floor(y: number): this { this.flr = y; return this; }
  spin(max: number): this { this.spinMax = max; return this; }
  rot(r: number): this { this.rotFixed = r; return this; }
  /** Motion-blur length in seconds of travel (PM_STRETCH). */
  stretch(seconds: number): this { this.str = seconds; return this; }
  /** Start colour (HDR linear rgb + alpha); also sets the end rgb (end alpha stays as is, default 0). */
  color(r: number, g: number, b: number, a = 1): this { this.r0 = this.r1 = r; this.g0 = this.g1 = g; this.b0 = this.b1 = b; this.a0 = a; return this; }
  end(r: number, g: number, b: number, a = 0): this { this.r1 = r; this.g1 = g; this.b1 = b; this.a1 = a; return this; }
  endAlpha(a: number): this { this.a1 = a; return this; }
  /** With probability p a particle starts with this alternate colour instead (end colour scaled alike). */
  alt(r: number, g: number, b: number, p: number): this { this.ar = r; this.ag = g; this.ab = b; this.altP = p; return this; }
  /** Random per-particle brightness multiplier. */
  bright(min: number, max: number): this { this.brMin = min; this.brMax = max; return this; }
  /** fadeIn = life fraction to fade in over; colorPow shapes colour/alpha over life (<1 fades early, >1 holds). */
  fade(fadeIn: number, colorPow = 1): this { this.fIn = fadeIn; this.cPow = colorPow; return this; }
  additive(a: number): this { this.add = a; return this; }
  wobble(amp: number, freq: number): this { this.wobA = amp; this.wobF = freq; return this; }

  /** Emits round(n × mul) particles (stochastically rounded). Returns the count emitted. */
  emit(n: number): number { return this.emitExact(this.rng.round(n * this.mul)); }

  /** Emits exactly n particles regardless of quality scaling (single flashes etc.). */
  emitExact(n: number): number {
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      // position
      let ox = 0, oy = 0, oz = 0;
      switch (this.posMode) {
        case POS_SPHERE: {
          const z = rng.next() * 2 - 1, ph = rng.next() * Math.PI * 2, rr = Math.sqrt(1 - z * z), rad = this.pr * Math.cbrt(rng.next());
          ox = rr * Math.cos(ph) * rad; oy = z * rad; oz = rr * Math.sin(ph) * rad;
          break;
        }
        case POS_DISC: {
          const ph = rng.next() * Math.PI * 2, f0 = this.pr > 0 ? (this.prMin / this.pr) ** 2 : 0;
          const rad = this.pr * Math.sqrt(f0 + (1 - f0) * rng.next());
          ox = Math.cos(ph) * rad; oz = Math.sin(ph) * rad;
          break;
        }
        case POS_BOX: ox = (rng.next() * 2 - 1) * this.bx; oy = (rng.next() * 2 - 1) * this.by; oz = (rng.next() * 2 - 1) * this.bz; break;
        case POS_LINE: { const t = rng.next(); ox = (this.bx - this.px) * t; oy = (this.by - this.py) * t; oz = (this.bz - this.pz) * t; break; }
        default: break;
      }
      // velocity
      let vx = this.bvx, vy = this.bvy, vz = this.bvz;
      const sp = this.sMin + (this.sMax - this.sMin) * rng.next();
      switch (this.velMode) {
        case VEL_SPHERE: case VEL_HEMI: {
          const z = rng.next() * 2 - 1, ph = rng.next() * Math.PI * 2, rr = Math.sqrt(1 - z * z);
          vx += rr * Math.cos(ph) * sp; vy += (this.velMode === VEL_HEMI ? Math.abs(z) : z) * sp; vz += rr * Math.sin(ph) * sp;
          break;
        }
        case VEL_CONE: {
          const ct = 1 - (1 - this.cosSpread) * rng.next(), st = Math.sqrt(Math.max(0, 1 - ct * ct)), ph = rng.next() * Math.PI * 2;
          const c = Math.cos(ph) * st, s = Math.sin(ph) * st;
          vx += (this.dx * ct + this.t1x * c + this.t2x * s) * sp;
          vy += (this.dy * ct + this.t1y * c + this.t2y * s) * sp;
          vz += (this.dz * ct + this.t1z * c + this.t2z * s) * sp;
          break;
        }
        case VEL_RADIAL: {
          let l = Math.hypot(ox, oy, oz);
          let ux = ox, uy = oy, uz = oz;
          if (l < 1e-5) { const ph = rng.next() * Math.PI * 2; ux = Math.cos(ph); uy = 0; uz = Math.sin(ph); l = 1; }
          vx += (ux / l) * sp; vy += (uy / l) * sp; vz += (uz / l) * sp;
          break;
        }
        default: break;
      }
      if (this.upMax !== 0 || this.upMin !== 0) vy += this.upMin + (this.upMax - this.upMin) * rng.next();
      const life = this.lifeMin + (this.lifeMax - this.lifeMin) * rng.next();
      const s0 = this.s0Min + (this.s0Max - this.s0Min) * rng.next();
      const br = this.brMin + (this.brMax - this.brMin) * rng.next();
      const useAlt = this.altP > 0 && rng.next() < this.altP;
      const rot = Number.isNaN(this.rotFixed) ? rng.next() * Math.PI * 2 : this.rotFixed;
      const spin = this.spinMax !== 0 ? (rng.next() * 2 - 1) * this.spinMax : 0;
      this.write(this.px + ox, this.py + oy, this.pz + oz, vx, vy, vz, life, s0, s0 * this.sEnd, rot, spin, br, useAlt);
    }
    return n;
  }

  private write(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number,
    s0: number, s1: number, rot: number, spin: number, br: number, useAlt: boolean): void {
    const i = this.head;
    if (this.deathT[i]! > this.now) this.overwrites++;
    this.deathT[i] = this.t0 + life;
    const d = this.data, o = i * STRIDE;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = this.t0;
    d[o + 4] = vx; d[o + 5] = vy; d[o + 6] = vz; d[o + 7] = Math.max(0.01, life);
    d[o + 8] = this.grav; d[o + 9] = this.drg; d[o + 10] = this.flr; d[o + 11] = spin;
    d[o + 12] = s0; d[o + 13] = s1; d[o + 14] = this.str; d[o + 15] = this.sprite + 16 * this.mode;
    let r0 = this.r0, g0 = this.g0, b0 = this.b0, r1 = this.r1, g1 = this.g1, b1 = this.b1;
    if (useAlt) {
      // keep the start→end ratio of the main colour so alternates fade consistently
      r1 = this.ar * (r0 > 1e-4 ? r1 / r0 : 1); g1 = this.ag * (g0 > 1e-4 ? g1 / g0 : 1); b1 = this.ab * (b0 > 1e-4 ? b1 / b0 : 1);
      r0 = this.ar; g0 = this.ag; b0 = this.ab;
    }
    d[o + 16] = r0 * br; d[o + 17] = g0 * br; d[o + 18] = b0 * br; d[o + 19] = this.a0;
    d[o + 20] = r1 * br; d[o + 21] = g1 * br; d[o + 22] = b1 * br; d[o + 23] = this.a1;
    d[o + 24] = rot; d[o + 25] = this.fIn; d[o + 26] = this.add; d[o + 27] = this.sPow;
    d[o + 28] = this.cPow; d[o + 29] = this.wobA; d[o + 30] = this.wobF; d[o + 31] = this.rng.next() * 100;
    if (this.pendCount === 0) this.pendStart = i;
    this.pendCount++;
    this.head = i + 1 === this.capacity ? 0 : i + 1;
    this.total++;
  }

  // ───────────────────────── frame ─────────────────────────
  beginFrame(now: number): void {
    this.now = now;
    this.overwrites = 0;
  }

  /** Schedules upload of the slots written since the last upload (≤ 2 ranges) and sets the shader clock. */
  flush(now: number): void {
    this.mat.uniforms.uTime!.value = now;
    const n = this.pendCount;
    if (n > 0) {
      const buf = this.buf;
      buf.clearUpdateRanges();
      if (n < this.capacity) {
        const first = Math.min(n, this.capacity - this.pendStart);
        this.rangeA.start = this.pendStart * STRIDE; this.rangeA.count = first * STRIDE;
        buf.updateRanges.push(this.rangeA);
        if (n > first) { this.rangeB.start = 0; this.rangeB.count = (n - first) * STRIDE; buf.updateRanges.push(this.rangeB); }
      } // else: everything changed → no ranges = full upload
      buf.needsUpdate = true;
    }
    this.geo.instanceCount = Math.min(this.capacity, this.total);
  }

  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}
