/**
 * [environment] Fog-of-war material hook. OWNER: environment agent.
 * Any module can call patchFogOfWar(material) on materials of objects that sit on the ground
 * (terrain, doodads, buildings, resource nodes) so unexplored/explored areas are darkened consistently.
 * The environment view updates fogUniforms every frame. Must be idempotent per material.
 *
 * Contract
 * - `uFogTex` is an RG texture with one texel per map tile (world (x, y) → uv = (x, y) / uFogWorldSize):
 *   R = "visible now" 0..1, G = "explored" 0..1, both smoothly interpolated over ~0.3 s and softened.
 * - Explored-but-not-visible surfaces are dimmed & desaturated (before tone mapping, so the result is
 *   identical with or without post-processing); unexplored surfaces become near-black with a hint of
 *   blue (after scene fog, so distance haze never washes out the black).
 * - Beyond the map edge the fog fades to "explored" so the horizon never ends in a black void.
 * - patchFogOfWar works on every built-in lit/unlit mesh material (Standard, Physical, Lambert, Phong,
 *   Basic, Toon, Matcap…), with instancing and batching. It chains any existing onBeforeCompile and keeps
 *   program caching correct. Calling it again on the same material is a no-op. Depth/distance materials
 *   and shaders without the standard chunks are left untouched.
 * - Custom ShaderMaterials can include FOW_PARS_FRAGMENT and call fowSample(worldXZ) / fowDim() /
 *   fowUnexplored() themselves (terrain, water, decals and lamp glows here do).
 */
import * as THREE from 'three';

export const fogUniforms = {
  uFogTex: { value: null as THREE.Texture | null },
  uFogWorldSize: { value: new THREE.Vector2(1, 1) },
  uFogEnabled: { value: 0 },
  /** x = explored brightness (linear multiplier), y = explored desaturation, z = unexplored detail trace, w = unused */
  uFogParams: { value: new THREE.Vector4(0.58, 0.4, 0.22, 0) },
  /** near-black, slightly blue colour of unexplored ground (output space) */
  uFogUnexplored: { value: new THREE.Color(0.02, 0.028, 0.052) },
};

/** Declarations for vertex shaders that call FOW_VERTEX. */
export const FOW_PARS_VERTEX = /* glsl */ `
varying vec2 vFowWorld;
`;

/** Computes the world-space ground position; requires `transformed` (all built-in materials have it). */
export const FOW_VERTEX = /* glsl */ `
{
  vec4 fowP = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    fowP = batchingMatrix * fowP;
  #endif
  #ifdef USE_INSTANCING
    fowP = instanceMatrix * fowP;
  #endif
  vFowWorld = ( modelMatrix * fowP ).xz;
}
`;

/** Uniforms + helpers. fowSample() returns vec2(visible, explored). */
export const FOW_PARS_FRAGMENT = /* glsl */ `
uniform sampler2D uFogTex;
uniform vec2 uFogWorldSize;
uniform float uFogEnabled;
uniform vec4 uFogParams;
uniform vec3 uFogUnexplored;
vec2 fowSample( vec2 wxz ) {
  if ( uFogEnabled < 0.5 ) return vec2( 1.0 );
  // a gentle domain warp breaks up the tile grid of the fog texture
  vec2 warp = vec2( sin( wxz.y * 0.83 + wxz.x * 0.29 ), cos( wxz.x * 0.77 - wxz.y * 0.31 ) ) * 0.32;
  vec2 f = texture( uFogTex, ( wxz + warp ) / uFogWorldSize ).rg;
  vec2 o = max( -wxz, wxz - uFogWorldSize );
  float outside = max( o.x, o.y );
  return mix( f, vec2( 0.0, 1.0 ), smoothstep( 3.0, 24.0, outside ) );
}
vec3 fowDim( vec3 c, vec2 f ) {
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  vec3 d = mix( c, vec3( l ) * vec3( 0.9, 0.96, 1.1 ), uFogParams.y ) * uFogParams.x;
  return mix( d, c, f.x );
}
vec3 fowUnexplored( vec3 c, vec2 f ) {
  return mix( uFogUnexplored + c * uFogParams.z, c, f.y );
}
`;

const FRAG_PARS = FOW_PARS_FRAGMENT + 'varying vec2 vFowWorld;\nvec2 fowF = vec2( 1.0 );\n';
const FRAG_DIM = /* glsl */ `
fowF = fowSample( vFowWorld );
gl_FragColor.rgb = fowDim( gl_FragColor.rgb, fowF );
`;
const FRAG_UNEXPLORED = /* glsl */ `
gl_FragColor.rgb = fowUnexplored( gl_FragColor.rgb, fowF );
`;

type CompileParams = Parameters<THREE.Material['onBeforeCompile']>[0];

const A_COMMON = '#include <common>';
const A_PROJECT = '#include <project_vertex>';
const A_TONEMAP = '#include <tonemapping_fragment>';
const A_FOG = '#include <fog_fragment>';

/** Injects fog-of-war into a shader object (as passed to onBeforeCompile). Returns false if the shader lacks the anchors. */
export function injectFogOfWar(shader: CompileParams): boolean {
  const vs = shader.vertexShader, fs = shader.fragmentShader;
  if (!vs.includes(A_COMMON) || !vs.includes(A_PROJECT) || !fs.includes(A_COMMON) || !fs.includes(A_TONEMAP) || !fs.includes(A_FOG)) return false;
  if (vs.includes('vFowWorld')) return true; // already injected by a chained hook
  shader.uniforms.uFogTex = fogUniforms.uFogTex;
  shader.uniforms.uFogWorldSize = fogUniforms.uFogWorldSize;
  shader.uniforms.uFogEnabled = fogUniforms.uFogEnabled;
  shader.uniforms.uFogParams = fogUniforms.uFogParams;
  shader.uniforms.uFogUnexplored = fogUniforms.uFogUnexplored;
  shader.vertexShader = vs
    .replace(A_COMMON, `${A_COMMON}\n${FOW_PARS_VERTEX}`)
    .replace(A_PROJECT, `${A_PROJECT}\n${FOW_VERTEX}`);
  shader.fragmentShader = fs
    .replace(A_COMMON, `${A_COMMON}\n${FRAG_PARS}`)
    .replace(A_TONEMAP, `${FRAG_DIM}\n${A_TONEMAP}`)
    .replace(A_FOG, `${A_FOG}\n${FRAG_UNEXPLORED}`);
  return true;
}

const patched = new WeakSet<THREE.Material>();
const FOW_KEY = '|fow2';

/** Idempotently adds fog-of-war darkening to a material (or each material of an array). */
export function patchFogOfWar(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) { for (const m of material) patchFogOfWar(m); return; }
  if (!material || patched.has(material)) return;
  const m = material as THREE.Material & { isMeshDepthMaterial?: boolean; isMeshDistanceMaterial?: boolean; isRawShaderMaterial?: boolean };
  if (m.isMeshDepthMaterial || m.isMeshDistanceMaterial || m.isRawShaderMaterial) return;
  patched.add(material);
  const prev = material.onBeforeCompile;
  const prevKeyFn = material.customProgramCacheKey;
  const defaultKey = prevKeyFn === THREE.Material.prototype.customProgramCacheKey;
  const prevSrc = prev.toString();
  material.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
    prev.call(this, shader, renderer);
    injectFogOfWar(shader);
  };
  material.customProgramCacheKey = function (this: THREE.Material) {
    return (defaultKey ? prevSrc : prevKeyFn.call(this)) + FOW_KEY;
  };
  material.needsUpdate = true;
}

export function isFogOfWarPatched(material: THREE.Material): boolean { return patched.has(material); }

/**
 * CPU side of the fog of war: converts VisionService grids (0 unexplored / 1 explored / 2 visible) into
 * a softened RG8 DataTexture and eases it toward the latest grid over `fadeSeconds`.
 */
export class FogOfWarTexture {
  readonly texture: THREE.DataTexture;
  private readonly data: Uint8Array;
  private readonly cur: Float32Array;   // interleaved (vis, explored), 0..1
  private readonly target: Float32Array;
  private readonly tmp: Float32Array;
  private animating = false;
  private initialised = false;

  constructor(readonly width: number, readonly height: number, private readonly fadeSeconds = 0.3) {
    const n = width * height;
    this.data = new Uint8Array(n * 2).fill(255);
    this.cur = new Float32Array(n * 2).fill(1);
    this.target = new Float32Array(n * 2).fill(1);
    this.tmp = new Float32Array(n * 2);
    this.texture = new THREE.DataTexture(this.data, width, height, THREE.RGFormat, THREE.UnsignedByteType);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.unpackAlignment = 1;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
  }

  /** New vision grid (length width*height): builds the softened target. */
  setGrid(grid: Uint8Array): void {
    const W = this.width, H = this.height, t = this.target, tmp = this.tmp;
    const n = Math.min(grid.length, W * H);
    for (let i = 0; i < n; i++) { const g = grid[i]!; t[i * 2] = g >= 2 ? 1 : 0; t[i * 2 + 1] = g >= 1 ? 1 : 0; }
    // separable [1 2 1] blur, edges clamped — softens the tile staircase before bilinear filtering
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const l = y * W + Math.max(0, x - 1), c = y * W + x, r = y * W + Math.min(W - 1, x + 1);
      tmp[c * 2] = (t[l * 2]! + 2 * t[c * 2]! + t[r * 2]!) * 0.25;
      tmp[c * 2 + 1] = (t[l * 2 + 1]! + 2 * t[c * 2 + 1]! + t[r * 2 + 1]!) * 0.25;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = Math.max(0, y - 1) * W + x, c = y * W + x, d = Math.min(H - 1, y + 1) * W + x;
      t[c * 2] = (tmp[u * 2]! + 2 * tmp[c * 2]! + tmp[d * 2]!) * 0.25;
      t[c * 2 + 1] = (tmp[u * 2 + 1]! + 2 * tmp[c * 2 + 1]! + tmp[d * 2 + 1]!) * 0.25;
    }
    if (!this.initialised) { this.cur.set(t); this.initialised = true; this.upload(); return; }
    this.animating = true;
  }

  /** Eases the displayed fog toward the target; uploads only while something changes. */
  update(dt: number): void {
    if (!this.animating) return;
    const step = this.fadeSeconds > 0 ? Math.max(1e-3, dt / this.fadeSeconds) : 1;
    const c = this.cur, t = this.target;
    let moving = false;
    for (let i = 0; i < c.length; i++) {
      const d = t[i]! - c[i]!;
      if (d === 0) continue;
      if (d > step) { c[i] = c[i]! + step; moving = true; } else if (d < -step) { c[i] = c[i]! - step; moving = true; } else c[i] = t[i]!;
    }
    this.upload();
    this.animating = moving;
  }

  private upload(): void {
    const c = this.cur, d = this.data;
    for (let i = 0; i < c.length; i++) d[i] = (c[i]! * 255 + 0.5) | 0;
    this.texture.needsUpdate = true;
  }

  dispose(): void { this.texture.dispose(); }
}
