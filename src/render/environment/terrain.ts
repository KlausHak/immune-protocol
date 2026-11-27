/**
 * [environment] Terrain: chunked heightfield mesh over the map + skirt, and a splat material built on
 * MeshStandardMaterial (so lights, shadows and the PMREM all work) via onBeforeCompile:
 *  - per-fragment 2×2 tile neighbourhood from an index texture, texture-array layers per Terrain id
 *  - height-based blending (grass overgrows road edges), noise-warped organic borders for natural ground
 *  - macro tonal variation, triplanar rock / concrete retaining walls on cliffs, wet shorelines
 *  - derivative bump from the layer heights, heightfield AO, snow sparkle, glowing contamination veins
 *  - directional sky-coloured distance fog, fog of war (patchFogOfWar)
 */
import * as THREE from 'three';
import { LEVEL_HEIGHT } from '../../config';
import { patchFogOfWar } from './fog';
import type { ExtendedTerrain } from './heightfield';
import { ENV_SKY_GLSL, envUniforms } from './sky';
import { LAYER_COUNT, LAYER_NATURAL, LAYER_ROUGHNESS, LAYER_WORLD_SIZE, createNoiseTexture, createTerrainArrayTexture, isManMade } from './textures';

/** A box that darkens ambient light around it (building footprints) for the baked AO. */
export interface AoOccluder { x: number; y: number; w: number; h: number; rot: number; height: number }

const CHUNK = 32;

const FRAG_PARS = /* glsl */ `
uniform sampler2DArray uTerrTex;
uniform sampler2D uTerrIndex;
uniform sampler2D uTerrNoise;
uniform vec4 uTerrGrid;
uniform float uLayerScale[ ${LAYER_COUNT} ];
uniform float uLayerRough[ ${LAYER_COUNT} ];
uniform float uLayerNatural[ ${LAYER_COUNT} ];
uniform float uWaterLevel;
uniform vec3 uVeinColor;
uniform float uVeinGlow;
uniform float uSparkle;
uniform float uTerrBump;
varying vec3 vTerrWorld;
varying vec3 vTerrNormal;
varying vec3 vTerrAttr;
${ENV_SKY_GLSL}
float terrId( ivec2 c ) { return floor( texelFetch( uTerrIndex, c, 0 ).r * 255.0 + 0.5 ); }
vec4 terrLayer( float id, vec2 p, vec2 dx, vec2 dy ) {
  float s = uLayerScale[ int( id ) ];
  return textureGrad( uTerrTex, vec3( p * s, id ), dx * s, dy * s );
}
vec3 terrTint( float id, vec3 c, vec4 nz ) {
  int i = int( id + 0.5 );
  if ( i == 0 ) {
    c *= 0.84 + 0.32 * nz.r;
    c = mix( c, c * vec3( 1.3, 1.1, 0.6 ), smoothstep( 0.56, 0.8, nz.g ) * 0.55 );
    c = mix( c, c * vec3( 0.78, 0.92, 0.8 ), smoothstep( 0.58, 0.85, 1.0 - nz.g ) * 0.45 );
  } else if ( i == 7 ) {
    c *= 0.95 + 0.07 * nz.g;
  } else if ( i == 8 ) {
    c *= 0.78 + 0.44 * nz.g;
  } else {
    c *= 0.9 + 0.2 * nz.r;
  }
  return c;
}
void terrExtra( float id, vec4 s, float b, inout float vein, inout float snow ) {
  if ( abs( id - 8.0 ) < 0.5 ) vein += b * ( 1.0 - smoothstep( 0.03, 0.12, s.a ) );
  if ( abs( id - 7.0 ) < 0.5 ) snow += b;
}
// surface-gradient bump (Mikkelsen) — h in world units, resolution independent
vec3 terrBump( vec3 p, vec3 n, float h, float fd ) {
  vec3 sx = dFdx( p ), sy = dFdy( p );
  vec3 r1 = cross( sy, n ), r2 = cross( n, sx );
  float det = dot( sx, r1 ) * fd;
  vec3 g = sign( det ) * ( dFdx( h ) * r1 + dFdy( h ) * r2 );
  return normalize( abs( det ) * n - g );
}
`;

const MAP_FRAGMENT = /* glsl */ `
vec3 terrP = vTerrWorld;
vec2 terrXZ = terrP.xz;
vec2 tdx = dFdx( terrXZ ), tdy = dFdy( terrXZ );
vec3 tdpx = dFdx( terrP ), tdpy = dFdy( terrP );
vec4 nz = texture( uTerrNoise, terrXZ * 0.019 );
vec4 nz2 = texture( uTerrNoise, terrXZ * 0.073 + 0.31 );
vec2 tp = terrXZ - uTerrGrid.xy - 0.5;
vec2 tb = floor( tp );
vec2 tf = tp - tb;
ivec2 tmax = ivec2( uTerrGrid.zw ) - 1;
ivec2 c0 = clamp( ivec2( tb ), ivec2( 0 ), tmax );
ivec2 c1 = clamp( ivec2( tb ) + 1, ivec2( 0 ), tmax );
float i00 = terrId( c0 );
float i10 = terrId( ivec2( c1.x, c0.y ) );
float i01 = terrId( ivec2( c0.x, c1.y ) );
float i11 = terrId( c1 );
float nat = max( max( uLayerNatural[ int( i00 ) ], uLayerNatural[ int( i10 ) ] ), max( uLayerNatural[ int( i01 ) ], uLayerNatural[ int( i11 ) ] ) );
vec2 bell = tf * ( 1.0 - tf ) * 4.0;
tf = clamp( tf + ( nz2.gb - 0.5 ) * 1.4 * nat * bell, 0.0, 1.0 );
float w00 = ( 1.0 - tf.x ) * ( 1.0 - tf.y ), w10 = tf.x * ( 1.0 - tf.y ), w01 = ( 1.0 - tf.x ) * tf.y, w11 = tf.x * tf.y;
if ( i10 == i00 ) { w00 += w10; w10 = 0.0; }
if ( i01 == i00 ) { w00 += w01; w01 = 0.0; } else if ( i01 == i10 ) { w10 += w01; w01 = 0.0; }
if ( i11 == i00 ) { w00 += w11; w11 = 0.0; } else if ( i11 == i10 ) { w10 += w11; w11 = 0.0; } else if ( i11 == i01 ) { w01 += w11; w11 = 0.0; }
vec4 s00 = w00 > 0.0 ? terrLayer( i00, terrXZ, tdx, tdy ) : vec4( 0.0 );
vec4 s10 = w10 > 0.0 ? terrLayer( i10, terrXZ, tdx, tdy ) : vec4( 0.0 );
vec4 s01 = w01 > 0.0 ? terrLayer( i01, terrXZ, tdx, tdy ) : vec4( 0.0 );
vec4 s11 = w11 > 0.0 ? terrLayer( i11, terrXZ, tdx, tdy ) : vec4( 0.0 );
float hbDepth = mix( 0.1, 0.24, nat );
float e00 = w00 > 0.0 ? w00 + s00.a * 0.5 : -9.0;
float e10 = w10 > 0.0 ? w10 + s10.a * 0.5 : -9.0;
float e01 = w01 > 0.0 ? w01 + s01.a * 0.5 : -9.0;
float e11 = w11 > 0.0 ? w11 + s11.a * 0.5 : -9.0;
float em = max( max( e00, e10 ), max( e01, e11 ) ) - hbDepth;
float b00 = max( e00 - em, 0.0 ), b10 = max( e10 - em, 0.0 ), b01 = max( e01 - em, 0.0 ), b11 = max( e11 - em, 0.0 );
float bsum = b00 + b10 + b01 + b11;
b00 /= bsum; b10 /= bsum; b01 /= bsum; b11 /= bsum;
vec3 terrAlb = terrTint( i00, s00.rgb, nz ) * b00 + terrTint( i10, s10.rgb, nz ) * b10 + terrTint( i01, s01.rgb, nz ) * b01 + terrTint( i11, s11.rgb, nz ) * b11;
float terrH = s00.a * b00 + s10.a * b10 + s01.a * b01 + s11.a * b11;
float terrRough = ( uLayerRough[ int( i00 ) ] + ( 0.5 - s00.a ) * 0.2 ) * b00 + ( uLayerRough[ int( i10 ) ] + ( 0.5 - s10.a ) * 0.2 ) * b10
  + ( uLayerRough[ int( i01 ) ] + ( 0.5 - s01.a ) * 0.2 ) * b01 + ( uLayerRough[ int( i11 ) ] + ( 0.5 - s11.a ) * 0.2 ) * b11;
float terrVein = 0.0, terrSnow = 0.0;
terrExtra( i00, s00, b00, terrVein, terrSnow );
terrExtra( i10, s10, b10, terrVein, terrSnow );
terrExtra( i01, s01, b01, terrVein, terrSnow );
terrExtra( i11, s11, b11, terrVein, terrSnow );
vec3 tN = normalize( vTerrNormal );
float terrCliff = vTerrAttr.y * smoothstep( 0.93, 0.72, tN.y );
if ( terrCliff > 0.002 ) {
  float cid = vTerrAttr.z > 0.5 ? 2.0 : 9.0;
  float cs = uLayerScale[ int( cid ) ] * 1.25;
  vec3 bw = pow( abs( tN ), vec3( 3.0 ) );
  bw /= ( bw.x + bw.y + bw.z );
  #ifdef TERR_FAST
  vec4 tri = bw.x > bw.z ? textureGrad( uTerrTex, vec3( terrP.zy * cs, cid ), tdpx.zy * cs, tdpy.zy * cs )
                         : textureGrad( uTerrTex, vec3( terrP.xy * cs, cid ), tdpx.xy * cs, tdpy.xy * cs );
  #else
  vec4 tX = textureGrad( uTerrTex, vec3( terrP.zy * cs, cid ), tdpx.zy * cs, tdpy.zy * cs );
  vec4 tZ = textureGrad( uTerrTex, vec3( terrP.xy * cs, cid ), tdpx.xy * cs, tdpy.xy * cs );
  vec4 tY = textureGrad( uTerrTex, vec3( terrXZ * cs, cid ), tdx * cs, tdy * cs );
  vec4 tri = tX * bw.x + tY * bw.y + tZ * bw.z;
  #endif
  vec3 cc = tri.rgb * ( cid > 5.0 ? 0.8 : 0.86 );
  terrAlb = mix( terrAlb, cc, terrCliff );
  terrH = mix( terrH, tri.a, terrCliff );
  terrRough = mix( terrRough, uLayerRough[ int( cid ) ], terrCliff );
  terrVein *= 1.0 - terrCliff;
  terrSnow *= 1.0 - terrCliff;
}
float terrWet = 1.0 - smoothstep( uWaterLevel + 0.02, uWaterLevel + 0.45, terrP.y );
terrAlb *= mix( 1.0, 0.6, terrWet );
terrRough = clamp( mix( terrRough, 0.28, terrWet * 0.85 ), 0.05, 1.0 );
if ( terrP.y < uWaterLevel ) terrAlb *= vec3( 0.7, 0.82, 0.85 );
terrAlb *= mix( 1.0, vTerrAttr.x, 0.45 );
diffuseColor.rgb *= terrAlb * 1.3;
vec3 terrEmissive = vec3( 0.0 );
if ( terrVein > 0.001 ) {
  float pulse = 0.6 + 0.4 * sin( uEnvTime * 1.6 + nz2.r * 14.0 + nz.g * 6.0 );
  terrEmissive += uVeinColor * terrVein * uVeinGlow * pulse;
}
#ifndef TERR_FAST
if ( terrSnow > 0.001 ) {
  vec3 V = normalize( cameraPosition - terrP );
  float sp = textureLod( uTerrNoise, terrXZ * ( 1.0 / 12.8 ) + V.xz * 0.03, 0.0 ).a;
  float sp2 = textureLod( uTerrNoise, terrXZ * ( 1.0 / 7.3 ) - V.xz * 0.06 + 0.5, 0.0 ).a;
  float glint = smoothstep( 0.955, 1.0, sp ) * smoothstep( 0.45, 0.9, sp2 );
  float fade = 1.0 - smoothstep( 35.0, 85.0, length( cameraPosition - terrP ) );
  terrEmissive += uSunColorL * glint * terrSnow * uSparkle * fade * 0.5;
}
#endif
`;

export interface TerrainUniforms {
  uTerrTex: THREE.IUniform<THREE.Texture | null>;
  uTerrIndex: THREE.IUniform<THREE.Texture | null>;
  uTerrNoise: THREE.IUniform<THREE.Texture | null>;
  uTerrGrid: THREE.IUniform<THREE.Vector4>;
  uLayerScale: THREE.IUniform<number[]>;
  uLayerRough: THREE.IUniform<number[]>;
  uLayerNatural: THREE.IUniform<number[]>;
  uWaterLevel: THREE.IUniform<number>;
  uVeinColor: THREE.IUniform<THREE.Color>;
  uVeinGlow: THREE.IUniform<number>;
  uSparkle: THREE.IUniform<number>;
  uTerrBump: THREE.IUniform<number>;
}

export class TerrainView {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly uniforms: TerrainUniforms;
  readonly noiseTexture: THREE.DataTexture;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly textures: THREE.Texture[] = [];

  constructor(private readonly ext: ExtendedTerrain, opts: { anisotropy: number; occluders: AoOccluder[]; castShadow: boolean; fast?: boolean }) {
    this.group.name = 'env:terrain';
    const layers = createTerrainArrayTexture(opts.anisotropy);
    const index = ext.createIndexTexture();
    this.noiseTexture = createNoiseTexture();
    this.textures.push(layers, index, this.noiseTexture);
    this.uniforms = {
      uTerrTex: { value: layers },
      uTerrIndex: { value: index },
      uTerrNoise: { value: this.noiseTexture },
      uTerrGrid: { value: new THREE.Vector4(ext.x0, ext.y0, ext.tw, ext.th) },
      uLayerScale: { value: LAYER_WORLD_SIZE.map((s) => 1 / s) },
      uLayerRough: { value: LAYER_ROUGHNESS.slice() },
      uLayerNatural: { value: LAYER_NATURAL.slice() },
      uWaterLevel: { value: ext.waterLevel },
      uVeinColor: { value: new THREE.Color(0xd24ad8) },
      uVeinGlow: { value: 1 },
      uSparkle: { value: 1 },
      uTerrBump: { value: 0.035 },
    };
    this.material = this.createMaterial(!!opts.fast);
    this.buildMeshes(opts.occluders, opts.castShadow);
  }

  private createMaterial(fast: boolean): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, fog: false });
    if (fast) mat.defines = { TERR_FAST: 1 };
    mat.name = 'env-terrain';
    const u = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u, envUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aTerr;\nvarying vec3 vTerrWorld;\nvarying vec3 vTerrNormal;\nvarying vec3 vTerrAttr;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvTerrNormal = normal;\nvTerrAttr = aTerr;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <map_fragment>', MAP_FRAGMENT)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = terrRough;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = terrBump( - vViewPosition, normal, terrH * uTerrBump, faceDirection );')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += terrEmissive;')
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= vTerrAttr.x;\nreflectedLight.indirectSpecular *= mix( 1.0, vTerrAttr.x, 0.7 );')
        .replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb = envFog( gl_FragColor.rgb, vTerrWorld );\n#include <tonemapping_fragment>');
    };
    mat.customProgramCacheKey = () => `env-terrain-v1${fast ? '-fast' : ''}`;
    patchFogOfWar(mat);
    return mat;
  }

  private buildMeshes(occluders: AoOccluder[], castShadow: boolean): void {
    const ext = this.ext, vw = ext.vw, vh = ext.vh, H = ext.heights;
    const map = ext.map;
    const nVert = vw * vh;
    const normals = new Float32Array(nVert * 3);
    for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) {
      const nx = ext.vertex(i - 1, j) - ext.vertex(i + 1, j), nz = ext.vertex(i, j - 1) - ext.vertex(i, j + 1);
      const l = Math.hypot(nx, 2, nz), k = (j * vw + i) * 3;
      normals[k] = nx / l; normals[k + 1] = 2 / l; normals[k + 2] = nz / l;
    }
    const ao = computeAo(ext, occluders);
    // cliff attributes: steepness (not on/next to ramps) and kind (rock vs. concrete retaining wall)
    const attr = new Float32Array(nVert * 3);
    const W = map.width, Hm = map.height;
    const tileAt = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < Hm ? y * W + x : -1);
    for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) {
      const h = H[j * vw + i]!;
      const slope = Math.max(Math.abs(ext.vertex(i + 1, j) - h), Math.abs(ext.vertex(i - 1, j) - h), Math.abs(ext.vertex(i, j + 1) - h), Math.abs(ext.vertex(i, j - 1) - h));
      let cliff = smootherstep(0.35 * LEVEL_HEIGHT, 0.7 * LEVEL_HEIGHT, slope);
      let kind = 0;
      const x = i + ext.x0, y = j + ext.y0;
      let bestH = -Infinity;
      for (const [dx, dy] of NEIGH) {
        const t = tileAt(x + dx, y + dy);
        if (t < 0) continue;
        if (map.ramps[t]) cliff = 0;
        const th = map.levels[t]!;
        if (th > bestH) { bestH = th; kind = isManMade(map.terrain[t]!) ? 1 : 0; }
      }
      const k = (j * vw + i) * 3;
      attr[k] = ao[j * vw + i]!; attr[k + 1] = cliff; attr[k + 2] = kind;
    }
    for (let cy = 0; cy < ext.th; cy += CHUNK) for (let cx = 0; cx < ext.tw; cx += CHUNK) {
      const cw = Math.min(CHUNK, ext.tw - cx), ch = Math.min(CHUNK, ext.th - cy);
      const geo = this.buildChunk(cx, cy, cw, ch, normals, attr);
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.name = `env:terrain:${cx},${cy}`;
      mesh.receiveShadow = true;
      // only chunks with real relief need to cast (cliffs) — saves shadow-pass work
      mesh.castShadow = castShadow && chunkHasRelief(ext, cx, cy, cw, ch);
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.geos.push(geo);
    }
  }

  private buildChunk(cx: number, cy: number, cw: number, ch: number, normals: Float32Array, attr: Float32Array): THREE.BufferGeometry {
    const ext = this.ext, vw = ext.vw;
    const nx = cw + 1, ny = ch + 1;
    const pos = new Float32Array(nx * ny * 3), nor = new Float32Array(nx * ny * 3), at = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const gi = cx + i, gj = cy + j, g = gj * vw + gi, k = (j * nx + i) * 3;
      pos[k] = gi + ext.x0; pos[k + 1] = ext.heights[g]!; pos[k + 2] = gj + ext.y0;
      nor[k] = normals[g * 3]!; nor[k + 1] = normals[g * 3 + 1]!; nor[k + 2] = normals[g * 3 + 2]!;
      at[k] = attr[g * 3]!; at[k + 1] = attr[g * 3 + 1]!; at[k + 2] = attr[g * 3 + 2]!;
    }
    const idx = new Uint16Array(cw * ch * 6);
    let n = 0;
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      // pick the diagonal that best follows the surface (ramps / cliff corners)
      if (Math.abs(pos[a * 3 + 1]! - pos[d * 3 + 1]!) <= Math.abs(pos[b * 3 + 1]! - pos[c * 3 + 1]!)) {
        idx[n++] = a; idx[n++] = c; idx[n++] = d; idx[n++] = a; idx[n++] = d; idx[n++] = b;
      } else {
        idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aTerr', new THREE.BufferAttribute(at, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  setPresetParams(veinGlow: number, sparkle: number): void {
    this.uniforms.uVeinGlow.value = veinGlow;
    this.uniforms.uSparkle.value = sparkle;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const t of this.textures) t.dispose();
    this.material.dispose();
  }
}

const NEIGH: ReadonlyArray<readonly [number, number]> = [[-1, -1], [0, -1], [-1, 0], [0, 0]];

function smootherstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function chunkHasRelief(ext: ExtendedTerrain, cx: number, cy: number, cw: number, ch: number): boolean {
  let lo = Infinity, hi = -Infinity;
  for (let j = cy; j <= cy + ch; j++) for (let i = cx; i <= cx + cw; i++) {
    const h = ext.heights[j * ext.vw + i]!;
    if (h < lo) lo = h; if (h > hi) hi = h;
  }
  return hi - lo > 0.6;
}

/**
 * Horizon-based ambient occlusion on the vertex grid, including building footprints as occluders.
 * Returns 0.3..1 per vertex.
 */
export function computeAo(ext: ExtendedTerrain, occluders: AoOccluder[]): Float32Array {
  const vw = ext.vw, vh = ext.vh, n = vw * vh;
  const occ = Float32Array.from(ext.heights);
  for (const o of occluders) {
    const c = Math.cos(o.rot), s = Math.sin(o.rot);
    const r = Math.hypot(o.w, o.h) / 2 + 1;
    const ground = ext.sample(o.x, o.y);
    for (let y = Math.floor(o.y - r); y <= Math.ceil(o.y + r); y++) for (let x = Math.floor(o.x - r); x <= Math.ceil(o.x + r); x++) {
      const dx = x - o.x, dy = y - o.y;
      const u = dx * c + dy * s, v = -dx * s + dy * c;
      if (Math.abs(u) > o.w / 2 || Math.abs(v) > o.h / 2) continue;
      const i = x - ext.x0, j = y - ext.y0;
      if (i < 0 || j < 0 || i >= vw || j >= vh) continue;
      occ[j * vw + i] = Math.max(occ[j * vw + i]!, ground + o.height);
    }
  }
  const DIRS = 12, RADII = [1, 2, 3.5, 5.5, 8.5];
  const dx = new Float32Array(DIRS), dy = new Float32Array(DIRS);
  for (let d = 0; d < DIRS; d++) { dx[d] = Math.cos((d / DIRS) * Math.PI * 2); dy[d] = Math.sin((d / DIRS) * Math.PI * 2); }
  const out = new Float32Array(n);
  for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) {
    const h0 = ext.heights[j * vw + i]! + 0.08;
    let sum = 0;
    for (let d = 0; d < DIRS; d++) {
      let best = 0;
      for (const r of RADII) {
        const si = Math.min(vw - 1, Math.max(0, Math.round(i + dx[d]! * r)));
        const sj = Math.min(vh - 1, Math.max(0, Math.round(j + dy[d]! * r)));
        const t = (occ[sj * vw + si]! - h0) / r;
        if (t > best) best = t;
      }
      sum += best / Math.sqrt(1 + best * best);
    }
    out[j * vw + i] = Math.min(1, Math.max(0.3, 1 - (sum / DIRS) * 1.15));
  }
  return out;
}

