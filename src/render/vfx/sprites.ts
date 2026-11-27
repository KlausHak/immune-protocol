/**
 * [vfx] Per-frame billboard batch ("immediate mode" sprites): projectile heads, muzzle/impact glows,
 * beam end caps, beacon lights. Everything is rewritten each frame into one instanced interleaved buffer
 * (single upload range, single draw call). Sprites can also be stretched along a world-space axis
 * (bolts, laser streaks) — the stretch is resolved in screen space so it always faces the camera.
 */
import * as THREE from 'three';
import { ATLAS_UV_GLSL, FOG_PREMUL_GLSL, applyPremulBlending, fogUniforms } from './atlas';

const STRIDE = 16;

const VERT = /* glsl */`
attribute vec4 iA; // pos.xyz, size
attribute vec4 iB; // rgb (HDR), a
attribute vec4 iC; // axis.xyz (unit), length (0 = plain billboard)
attribute vec4 iD; // sprite, rot, additive, -
varying vec2 vUv;
varying vec4 vCol;
varying float vAdd;
#include <fog_pars_vertex>
${ATLAS_UV_GLSL}
void main() {
  vec2 corner = position.xy;
  float size = iA.w;
  vec4 mvPosition;
  if (iC.w > 0.0) {
    vec4 a = modelViewMatrix * vec4(iA.xyz - iC.xyz * (iC.w * 0.5), 1.0);
    vec4 b = modelViewMatrix * vec4(iA.xyz + iC.xyz * (iC.w * 0.5), 1.0);
    vec2 d = b.xy - a.xy;
    float L = length(d);
    vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    mvPosition = vec4((a.xyz + b.xyz) * 0.5, 1.0);
    mvPosition.xy += dir * corner.x * (L + size) + nrm * corner.y * size;
  } else {
    float c = cos(iD.y), s = sin(iD.y);
    mvPosition = modelViewMatrix * vec4(iA.xyz, 1.0);
    mvPosition.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
  }
  gl_Position = projectionMatrix * mvPosition;
  vUv = atlasUv(iD.x, corner);
  vCol = iB;
  vAdd = iD.z;
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

export class SpriteBatch {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly data: Float32Array;
  private readonly buf: THREE.InstancedInterleavedBuffer;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly range = { start: 0, count: 0 };
  count = 0;

  constructor(capacity: number, atlas: THREE.Texture) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    ['iA', 'iB', 'iC', 'iD'].forEach((n, i) => this.geo.setAttribute(n, new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4)));
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms(), uAtlas: { value: atlas } },
      vertexShader: VERT, fragmentShader: FRAG, fog: true,
    });
    applyPremulBlending(this.mat);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.name = 'vfx:sprites';
  }

  begin(): void { this.count = 0; }

  /** Camera-facing sprite. Colours are linear HDR; additive 0 = alpha-blended, 1 = additive. */
  add(x: number, y: number, z: number, size: number, sprite: number, r: number, g: number, b: number, a: number, additive = 1, rot = 0): void {
    if (this.count >= this.capacity) return;
    const d = this.data, o = this.count++ * STRIDE;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = size;
    d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = a;
    d[o + 8] = 0; d[o + 9] = 0; d[o + 10] = 0; d[o + 11] = 0;
    d[o + 12] = sprite; d[o + 13] = rot; d[o + 14] = additive; d[o + 15] = 0;
  }

  /** Sprite stretched along a world axis (ax, ay, az must be unit length) by `len` world units. */
  streak(x: number, y: number, z: number, size: number, ax: number, ay: number, az: number, len: number,
    sprite: number, r: number, g: number, b: number, a: number, additive = 1): void {
    if (this.count >= this.capacity) return;
    const d = this.data, o = this.count++ * STRIDE;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = size;
    d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = a;
    d[o + 8] = ax; d[o + 9] = ay; d[o + 10] = az; d[o + 11] = Math.max(1e-3, len);
    d[o + 12] = sprite; d[o + 13] = 0; d[o + 14] = additive; d[o + 15] = 0;
  }

  flush(): void {
    this.geo.instanceCount = this.count;
    if (this.count > 0) {
      this.buf.clearUpdateRanges();
      this.range.start = 0; this.range.count = this.count * STRIDE;
      this.buf.updateRanges.push(this.range);
      this.buf.needsUpdate = true;
    }
  }

  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}
