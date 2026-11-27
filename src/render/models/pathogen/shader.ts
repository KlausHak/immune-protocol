/**
 * [models-pathogen] Shared organic material system for The Contagion.
 *
 * ONE MeshStandardMaterial-based shader (onBeforeCompile) renders every pathogen part. Per-vertex
 * attributes written by `geom.ts#paint` select what each vertex looks like, so a whole unit body
 * (membrane + acid pores + glowing nucleus + waving flagella) merges into a single mesh/draw call:
 *
 *   color (vec3) albedo, or a shade multiplier for team-tinted parts
 *   aFx   (vec4) x = team-tint weight · y = acid-green emissive · z = nucleus (team) glow · w = membrane wobble
 *   aMat  (vec4) x = roughness · y = metalness · z = fresnel-rim weight · w = whip wave (+ along X, − along Y)
 *
 * Effects: fresnel rim glow, pulsing emissive nuclei with a fake "seen through the membrane" falloff,
 * pulsing acid accents, vertex wobble and travelling flagella waves. A single shared time uniform drives
 * everything (advanced by `material.onBeforeRender`, so even static doodads animate). Per-object phase
 * comes from the model matrix, so neighbouring units don't pulse in lock-step.
 *
 * Materials are shared per (team colour, family, variant, fog-patched?) — never per instance. State
 * changes (attack flash, producing, construction, death) swap between cached variants; every variant
 * compiles to the same GPU program (same cache key), so swapping is free.
 */
import * as THREE from 'three';
import { patchFogOfWar } from '../../environment/fog';

export type Variant = 'idle' | 'active' | 'flash' | 'immature' | 'dead';
export type Family = 'flesh' | 'glass';

/** Shared shader clock (seconds). */
export const pathogenTime = { value: 0 };
const T0 = typeof performance !== 'undefined' ? performance.now() : 0;
function tickTime(): void { pathogenTime.value = (performance.now() - T0) * 0.001; }

/** Acid-green faction accent (DESIGN §7). */
export const ACID_GREEN = 0x9dff4a;
/** Team colour used for neutral infection doodads (default pathogen magenta). */
export const DOODAD_TEAM = 0xd64bff;

interface VariantLook { glow: number; pulse: number; wobble: number; rim: number; desat: number; dark: number }
const LOOKS: Record<Variant, VariantLook> = {
  idle:     { glow: 1.0,  pulse: 2.1, wobble: 1.0, rim: 1.0,  desat: 0,    dark: 1 },
  active:   { glow: 1.55, pulse: 5.2, wobble: 1.7, rim: 1.25, desat: 0,    dark: 1.05 },
  flash:    { glow: 2.9,  pulse: 9.0, wobble: 1.3, rim: 2.1,  desat: 0,    dark: 1.25 },
  immature: { glow: 0.5,  pulse: 3.4, wobble: 2.6, rim: 0.85, desat: 0.35, dark: 0.85 },
  dead:     { glow: 0.1,  pulse: 0.8, wobble: 0.25, rim: 0.3, desat: 0.7,  dark: 0.5 },
};

const VERT_PARS = /* glsl */`
#define PATHOGEN_FX 1
attribute vec4 aFx;
attribute vec4 aMat;
uniform float uPTime;
uniform float uPWobble;
varying vec4 vPFx;
varying vec4 vPMat;
varying float vPPhase;
`;

const VERT_MAIN = /* glsl */`
vec3 pObj = modelMatrix[3].xyz;
#ifdef USE_INSTANCING
	pObj += mat3( modelMatrix ) * instanceMatrix[3].xyz;
#endif
float pObjPhase = sin( pObj.x * 0.173 + pObj.z * 0.291 ) * 3.1 + cos( pObj.z * 0.137 - pObj.x * 0.219 ) * 3.1;
vPFx = aFx;
vPMat = aMat;
vPPhase = pObjPhase + position.y * 1.9 + dot( position.xz, vec2( 1.1, 0.7 ) );
if ( aFx.w > 0.0 ) {
	float pw = sin( uPTime * 2.7 + pObjPhase + position.x * 4.3 + position.y * 3.1 )
		+ 0.6 * sin( uPTime * 1.9 - pObjPhase + position.z * 3.9 - position.y * 2.3 );
	transformed += objectNormal * ( aFx.w * uPWobble * 0.035 * pw );
}
if ( aMat.w > 0.0 ) {
	float pa = aMat.w * uPWobble;
	float ph = uPTime * 9.0 + pObjPhase + position.x * 10.0;
	transformed.z += pa * 0.11 * sin( ph );
	transformed.y += pa * 0.045 * cos( ph * 0.5 );
} else if ( aMat.w < 0.0 ) {
	float pa = - aMat.w * uPWobble;
	float ph = uPTime * 3.6 + pObjPhase + position.y * 6.0;
	transformed.x += pa * 0.10 * sin( ph );
	transformed.z += pa * 0.10 * cos( ph * 0.83 + 1.0 );
}
`;

const FRAG_PARS = /* glsl */`
#define PATHOGEN_FX 1
uniform float uPTime;
uniform vec3 uPTeam;
uniform vec3 uPNucleus;
uniform vec3 uPAccent;
uniform vec3 uPRim;
uniform vec4 uPLook; // x glow gain · y pulse speed · z rim gain · w desaturation
uniform float uPDark;
varying vec4 vPFx;
varying vec4 vPMat;
varying float vPPhase;
`;

const FRAG_COLOR = /* glsl */`
diffuseColor.rgb *= mix( vec3( 1.0 ), uPTeam, vPFx.x );
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) ) ), uPLook.w ) * uPDark;
`;

const FRAG_PBR = /* glsl */`
roughnessFactor = vPMat.x;
metalnessFactor = vPMat.y;
`;

const FRAG_EMISSIVE = /* glsl */`
{
	vec3 pV = normalize( vViewPosition );
	float pFacing = clamp( dot( normal, pV ), 0.0, 1.0 );
	float pFres = pow( 1.0 - pFacing, 2.6 );
	float pT = uPTime * uPLook.y + vPPhase;
	float pPulseN = 0.6 + 0.4 * sin( pT );
	float pPulseA = 0.62 + 0.38 * sin( pT * 1.31 + 1.7 );
	vec3 pRimCol = mix( uPRim, uPAccent, clamp( vPFx.y * 1.5, 0.0, 1.0 ) );
	totalEmissiveRadiance += uPNucleus * ( vPFx.z * pPulseN * ( 0.35 + 0.65 * pFacing * pFacing ) * uPLook.x );
	totalEmissiveRadiance += uPAccent * ( vPFx.y * pPulseA * uPLook.x );
	totalEmissiveRadiance += pRimCol * ( pFres * uPLook.z * vPMat.z ) * mix( 1.0, uPDark, 0.5 );
}
`;

/** Idempotent: safe if a chained onBeforeCompile (e.g. the fog patch) calls us twice. */
function injectPathogen(shader: THREE.WebGLProgramParametersWithUniforms, u: Record<string, THREE.IUniform>): void {
  Object.assign(shader.uniforms, u);
  if (shader.vertexShader.includes('PATHOGEN_FX')) return;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${FRAG_PBR}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`);
}

const CACHE_KEY = 'pathogen-fx-v1';

function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/**
 * Apply the environment's fog-of-war patch while keeping our injection. Works whether the patch chains to
 * the previous onBeforeCompile or replaces it, and keeps the program cache key unique per patch.
 */
function applyFog(mat: THREE.Material, mine: THREE.Material['onBeforeCompile']): void {
  const myKey = mat.customProgramCacheKey;
  patchFogOfWar(mat);
  const after = mat.onBeforeCompile;
  const keyAfter = mat.customProgramCacheKey;
  if (after === mine && keyAfter === myKey) return; // patch is a no-op (or not installed yet)
  const theirKey = keyAfter !== myKey ? String(keyAfter.call(mat)) : '';
  const theirSrc = after !== mine ? after.toString() : '';
  mat.onBeforeCompile = (shader, renderer) => {
    mine.call(mat, shader, renderer);
    if (after !== mine) after.call(mat, shader, renderer);
  };
  const key = `${CACHE_KEY}|fog:${hashString(theirKey)}:${hashString(theirSrc)}`;
  mat.customProgramCacheKey = () => key;
}

function makeMaterial(team: THREE.Color, family: Family, variant: Variant, fog: boolean): THREE.MeshStandardMaterial {
  const look = LOOKS[variant];
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0 });
  mat.name = `pathogen:${family}:${variant}:${team.getHexString()}${fog ? ':fog' : ''}`;
  if (family === 'glass') {
    mat.transparent = true;
    mat.opacity = 0.4;
    mat.depthWrite = false;
  }
  // Safe values for any geometry that lacks our attributes (WebGL constant attribute).
  (mat as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = {
    color: [1, 1, 1], aFx: [1, 0, 0, 0], aMat: [0.55, 0, 1, 0],
  };
  const white = new THREE.Color(1, 1, 1);
  const uniforms: Record<string, THREE.IUniform> = {
    uPTime: pathogenTime,
    uPWobble: { value: look.wobble },
    // darker diffuse keeps the team colour saturated under ACES; glow/rim carry the brightness
    uPTeam: { value: team.clone().multiplyScalar(0.5) },
    uPNucleus: { value: team.clone().lerp(white, 0.1).multiplyScalar(1.35) },
    uPAccent: { value: new THREE.Color(ACID_GREEN).multiplyScalar(0.95) },
    uPRim: { value: team.clone().lerp(white, 0.1).multiplyScalar(1.3) },
    uPLook: { value: new THREE.Vector4(look.glow, look.pulse, look.rim, look.desat) },
    uPDark: { value: look.dark },
  };
  const mine: THREE.Material['onBeforeCompile'] = (shader) => injectPathogen(shader, uniforms);
  mat.onBeforeCompile = mine;
  mat.customProgramCacheKey = () => CACHE_KEY;
  mat.onBeforeRender = tickTime;
  if (fog) applyFog(mat, mine);
  return mat;
}

/** Shared, lazily-built material set for one team colour. Never dispose these from a model. */
export class Palette {
  private mats = new Map<string, THREE.MeshStandardMaterial>();
  constructor(readonly team: THREE.Color, readonly fog: boolean) {}
  get(family: Family = 'flesh', variant: Variant = 'idle'): THREE.MeshStandardMaterial {
    const k = `${family}|${variant}`;
    let m = this.mats.get(k);
    if (!m) { m = makeMaterial(this.team, family, variant, this.fog); this.mats.set(k, m); }
    return m;
  }
}

const palettes = new Map<string, Palette>();
/**
 * Palette for a team colour. `fog` = patched with the environment's fog-of-war darkening (structures,
 * doodads). Units are hidden by visibility instead, so they use the cheaper unpatched set.
 */
export function getPalette(team: THREE.Color | number, fog: boolean): Palette {
  const c = typeof team === 'number' ? new THREE.Color(team) : team;
  const key = `${c.getHexString()}|${fog ? 1 : 0}`;
  let p = palettes.get(key);
  if (!p) { p = new Palette(c.clone(), fog); palettes.set(key, p); }
  return p;
}
