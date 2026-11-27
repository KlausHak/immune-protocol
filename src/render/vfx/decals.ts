/**
 * [vfx] Ground decals: goo splats, scorch marks, acid burns, spore stains. A ring buffer of instanced
 * quads laid on the terrain (tilted to the local terrain normal), faded in the shader from the spawn
 * time — one draw call, writes only on spawn. Decals in tiles that stop being visible to the local
 * player are hidden by a cheap periodic visibility sweep (see VfxCore).
 */
import * as THREE from 'three';
import { ATLAS_UV_GLSL, FOG_PREMUL_GLSL, applyPremulBlending, fogUniforms } from './atlas';

const STRIDE = 20;

const VERT = /* glsl */`
uniform float uTime;
attribute vec4 dA; // centre.xyz, size
attribute vec4 dB; // normal.xyz, rot
attribute vec4 dC; // rgb, alpha
attribute vec4 dD; // t0, life, sprite, visible
attribute vec4 dE; // additive, grow-from, fade-out fraction, -
varying vec2 vUv;
varying vec4 vCol;
varying float vAdd;
#include <fog_pars_vertex>
${ATLAS_UV_GLSL}
void main() {
  float age = uTime - dD.x;
  float x = age / dD.y;
  vUv = vec2(0.0); vCol = vec4(0.0); vAdd = 0.0;
  if (x < 0.0 || x >= 1.0 || dD.w < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 n = normalize(dB.xyz);
  vec3 t = normalize(cross(n, vec3(0.0, 0.0, 1.0)));
  vec3 b = cross(t, n);
  float c = cos(dB.w), s = sin(dB.w);
  vec2 corner = position.xy;
  vec2 r = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
  float grow = mix(dE.y, 1.0, 1.0 - pow(1.0 - clamp(age / 0.22, 0.0, 1.0), 3.0));
  vec3 wp = dA.xyz + n * 0.035 + (t * r.x + b * r.y) * dA.w * grow;
  vec4 mvPosition = modelViewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float fadeOut = 1.0 - smoothstep(1.0 - dE.z, 1.0, x);
  float fadeIn = smoothstep(0.0, 0.06, age);
  vCol = vec4(dC.rgb, dC.a * fadeIn * fadeOut);
  vAdd = dE.x;
  vUv = atlasUv(dD.z, corner);
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
  if (a < 0.003) discard;
  vec3 col = vCol.rgb * tex.rgb;
  float add = vAdd;
  ${FOG_PREMUL_GLSL}
}
`;

export class DecalPool {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly data: Float32Array;
  private readonly buf: THREE.InstancedInterleavedBuffer;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private head = 0;
  private total = 0;
  private dirty = false;
  /** world-space x/z of each slot (for visibility sweeps) */
  readonly posX: Float32Array;
  readonly posZ: Float32Array;
  readonly endT: Float32Array;

  constructor(capacity: number, atlas: THREE.Texture) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    this.posX = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.endT = new Float32Array(capacity);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    ['dA', 'dB', 'dC', 'dD', 'dE'].forEach((n, i) => this.geo.setAttribute(n, new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4)));
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms(), uTime: { value: 0 }, uAtlas: { value: atlas } },
      vertexShader: VERT, fragmentShader: FRAG, fog: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    applyPremulBlending(this.mat);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'vfx:decals';
  }

  /**
   * Adds a decal. (nx, ny, nz) = terrain normal (unit). `grow` = starting size fraction (splats pop out),
   * `fadeFrac` = fraction of life spent fading out.
   */
  add(t0: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, size: number, rot: number,
    sprite: number, r: number, g: number, b: number, a: number, life: number, additive = 0, grow = 0.55, fadeFrac = 0.4): void {
    const i = this.head, d = this.data, o = i * STRIDE;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = size;
    d[o + 4] = nx; d[o + 5] = ny; d[o + 6] = nz; d[o + 7] = rot;
    d[o + 8] = r; d[o + 9] = g; d[o + 10] = b; d[o + 11] = a;
    d[o + 12] = t0; d[o + 13] = Math.max(0.1, life); d[o + 14] = sprite; d[o + 15] = 1;
    d[o + 16] = additive; d[o + 17] = grow; d[o + 18] = fadeFrac; d[o + 19] = 0;
    this.posX[i] = x; this.posZ[i] = z; this.endT[i] = t0 + life;
    this.head = i + 1 === this.capacity ? 0 : i + 1;
    this.total++;
    this.dirty = true;
  }

  /** Visibility flag of a slot (cheap; whole buffer re-uploaded at most once per frame when changed). */
  setVisible(i: number, visible: boolean): void {
    const o = i * STRIDE + 15, v = visible ? 1 : 0;
    if (this.data[o] !== v) { this.data[o] = v; this.dirty = true; }
  }

  get liveSlots(): number { return Math.min(this.capacity, this.total); }

  flush(now: number): void {
    this.mat.uniforms.uTime!.value = now;
    this.geo.instanceCount = Math.min(this.capacity, this.total);
    if (this.dirty) { this.buf.clearUpdateRanges(); this.buf.needsUpdate = true; this.dirty = false; }
  }

  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}
