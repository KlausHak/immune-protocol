/**
 * [environment] Sky: gradient dome with sun/moon disc, halo, horizon glow, stars and a subtle aurora,
 * plus the shared sky/fog GLSL used by terrain & water so the horizon is seamless, and a PMREM of the
 * sky for soft PBR reflections (scene.environment).
 */
import * as THREE from 'three';
import { sunDirection, type PresetDef } from './presets';

/** Shared uniform objects (referenced by every environment shader; updated by applyPreset / update). */
export const envUniforms = {
  uEnvTime: { value: 0 },
  uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
  uSunColorL: { value: new THREE.Color(1, 1, 1) },
  uSkyZenith: { value: new THREE.Color() },
  uSkyHorizon: { value: new THREE.Color() },
  uSkyGlow: { value: new THREE.Color() },
  uSkyGround: { value: new THREE.Color() },
  uSkyHalo: { value: new THREE.Color() },
  uSkyDisc: { value: new THREE.Color() },
  /** x = glow power, y = glow strength, z = halo strength, w = cos(disc radius) */
  uSkyParams: { value: new THREE.Vector4(3, 1, 1, 0.9995) },
  /** x = fog density, y = stars, z = aurora, w = wind */
  uEnvMisc: { value: new THREE.Vector4(0.004, 0, 0, 1) },
};

export function applyPresetUniforms(p: PresetDef): void {
  const u = envUniforms;
  sunDirection(p, u.uSunDirW.value);
  u.uSunColorL.value.setHex(p.sun.color).multiplyScalar(p.sun.intensity);
  u.uSkyZenith.value.setHex(p.sky.zenith);
  u.uSkyHorizon.value.setHex(p.sky.horizon);
  u.uSkyGlow.value.setHex(p.sky.glow);
  u.uSkyGround.value.setHex(p.sky.ground);
  u.uSkyHalo.value.setHex(p.sky.halo);
  u.uSkyDisc.value.setHex(p.sky.discColor).multiplyScalar(p.sky.discIntensity);
  u.uSkyParams.value.set(p.sky.glowPower, p.sky.glowStrength, p.sky.haloStrength, Math.cos(p.sky.discSize));
  u.uEnvMisc.value.set(p.fogDensity, p.stars, p.aurora, p.wind);
}

/** GLSL: uniforms + envSky(dir) (linear HDR, no disc) + envFogColor(dir) + envFog(color, worldPos). */
export const ENV_SKY_GLSL = /* glsl */ `
uniform float uEnvTime;
uniform vec3 uSunDirW;
uniform vec3 uSunColorL;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGlow;
uniform vec3 uSkyGround;
uniform vec3 uSkyHalo;
uniform vec3 uSkyDisc;
uniform vec4 uSkyParams;
uniform vec4 uEnvMisc;
vec3 envHorizon( vec3 d ) {
  vec2 a = normalize( d.xz + vec2( 1e-5 ) );
  vec2 s = normalize( uSunDirW.xz + vec2( 1e-5 ) );
  float g = pow( 0.5 + 0.5 * dot( a, s ), uSkyParams.x ) * uSkyParams.y;
  return mix( uSkyHorizon, uSkyGlow, min( g, 1.0 ) );
}
vec3 envSky( vec3 d ) {
  vec3 hz = envHorizon( d );
  float y = d.y;
  vec3 col;
  if ( y >= 0.0 ) {
    float t = pow( clamp( y, 0.0, 1.0 ), 0.42 );
    col = mix( hz, uSkyZenith, smoothstep( 0.0, 1.0, t ) );
  } else {
    col = mix( hz, uSkyGround, smoothstep( 0.0, 0.22, -y ) );
  }
  float sd = max( dot( d, uSunDirW ), 0.0 );
  col += uSkyHalo * ( pow( sd, 6.0 ) * 0.3 + pow( sd, 48.0 ) * 0.8 ) * uSkyParams.z;
  return col;
}
vec3 envFogColor( vec3 d ) {
  vec2 h = d.xz + vec2( 1e-4, 0.0 );
  return envSky( normalize( vec3( h.x, 0.03 * length( h ), h.y ) ) );
}
vec3 envFog( vec3 col, vec3 wp ) {
  vec3 fd = wp - cameraPosition;
  float dist = length( fd );
  float f = 1.0 - exp( - uEnvMisc.x * uEnvMisc.x * dist * dist );
  return mix( col, envFogColor( fd / max( dist, 1e-3 ) ), f );
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vSkyDir;
void main() {
  vSkyDir = position;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.99999; // keep on the far side without clipping
}
`;

const SKY_FRAG = /* glsl */ `
${ENV_SKY_GLSL}
varying vec3 vSkyDir;
float skyHash( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}
float stars( vec3 d ) {
  vec3 p = d * 210.0;
  vec3 c = floor( p );
  float h = skyHash( c );
  if ( h < 0.9962 ) return 0.0;
  vec3 o = vec3( skyHash( c + 7.1 ), skyHash( c + 3.7 ), skyHash( c + 1.3 ) ) * 0.6 + 0.2;
  float dd = length( fract( p ) - o );
  float tw = 0.7 + 0.3 * sin( uEnvTime * ( 1.3 + h * 40.0 ) + h * 517.0 );
  return smoothstep( 0.16, 0.0, dd ) * ( 0.35 + 0.65 * fract( h * 731.0 ) ) * tw;
}
vec3 aurora( vec3 d ) {
  float el = asin( clamp( d.y, -1.0, 1.0 ) );
  if ( el < 0.02 ) return vec3( 0.0 );
  float az = atan( d.x, -d.z ); // 0 = north
  float north = 1.0 - smoothstep( 0.9, 1.7, abs( az ) );
  if ( north <= 0.0 ) return vec3( 0.0 );
  float t = uEnvTime;
  vec3 acc = vec3( 0.0 );
  for ( int i = 0; i < 3; i++ ) {
    float fi = float( i );
    float e0 = 0.2 + fi * 0.07 + 0.06 * sin( az * ( 2.6 + fi ) + t * 0.05 + fi * 2.0 ) + 0.035 * sin( az * 9.0 - t * 0.11 + fi );
    float w = 0.05 + 0.02 * sin( az * 5.0 + t * 0.07 );
    float below = smoothstep( e0 - w * 0.6, e0, el );           // sharp lower edge
    float above = exp( - max( el - e0, 0.0 ) / ( w * 2.2 ) );    // rays fading upward
    float rays = 0.55 + 0.45 * sin( az * 70.0 + sin( az * 11.0 + t * 0.21 + fi ) * 5.0 );
    float k = below * above * rays;
    vec3 c = mix( vec3( 0.15, 1.0, 0.55 ), vec3( 0.45, 0.25, 1.0 ), smoothstep( 0.0, 0.18, el - e0 ) );
    acc += c * k * ( 0.6 - fi * 0.15 );
  }
  return acc * north * smoothstep( 0.02, 0.12, el );
}
void main() {
  vec3 d = normalize( vSkyDir );
  vec3 col = envSky( d );
  #ifndef ENV_MODE
    float sd = dot( d, uSunDirW );
    col += uSkyDisc * smoothstep( uSkyParams.w, mix( uSkyParams.w, 1.0, 0.35 ), sd );
    if ( uEnvMisc.y > 0.0 && d.y > 0.0 ) col += vec3( 0.85, 0.9, 1.0 ) * stars( d ) * uEnvMisc.y * smoothstep( 0.0, 0.25, d.y ) * 1.6;
    if ( uEnvMisc.z > 0.0 ) col += aurora( d ) * uEnvMisc.z * 0.9;
  #endif
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function skyMaterial(envMode: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: envMode ? 'env-sky-pmrem' : 'env-sky',
    uniforms: envUniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    defines: envMode ? { ENV_MODE: 1 } : {},
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
}

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.SphereGeometry(1, 48, 24);
  private readonly mat = skyMaterial(false);
  private pmrem: THREE.PMREMGenerator | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;

  constructor() {
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'env:sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1e6;
    this.mesh.matrixAutoUpdate = true;
  }

  /** Keep the dome centred on the camera, just inside its far plane. */
  update(camera: THREE.PerspectiveCamera): void {
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.9);
  }

  /** Renders the (disc-free) sky into a PMREM for scene.environment. Returns null if it fails. */
  buildEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture | null {
    try {
      this.pmrem ??= new THREE.PMREMGenerator(renderer);
      const scene = new THREE.Scene();
      const m = skyMaterial(true);
      const mesh = new THREE.Mesh(this.geo, m);
      mesh.scale.setScalar(100);
      scene.add(mesh);
      const rt = this.pmrem.fromScene(scene, 0.02, 0.1, 1000);
      m.dispose();
      this.envRT?.dispose();
      this.envRT = rt;
      return rt.texture;
    } catch (err) {
      console.warn('[environment] PMREM generation failed', err);
      return null;
    }
  }

  dispose(): void {
    this.geo.dispose(); this.mat.dispose();
    this.envRT?.dispose(); this.pmrem?.dispose();
    this.envRT = null; this.pmrem = null;
  }
}
