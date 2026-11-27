/**
 * [environment] Sea: one large plane at map.waterLevel with an animated shader — three scrolling normal
 * layers, Schlick fresnel between the depth-tinted water body and the sky gradient, sun/moon glint,
 * shoreline foam & soft fade from the terrain depth (height texture), distance fog and fog of war.
 */
import * as THREE from 'three';
import { FOW_PARS_FRAGMENT, fogUniforms } from './fog';
import type { ExtendedTerrain } from './heightfield';
import type { PresetDef } from './presets';
import { ENV_SKY_GLSL, envUniforms } from './sky';
import { createWaterNormalTexture } from './textures';

const VERT = /* glsl */ `
varying vec3 vWaterWorld;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWaterWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uWaterNormal;
uniform sampler2D uWaterHeight;
uniform sampler2D uWaterNoise;
uniform vec4 uWaterGrid;
uniform float uWaterLevel;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform float uGlint;
varying vec3 vWaterWorld;
${ENV_SKY_GLSL}
${FOW_PARS_FRAGMENT}
void main() {
  vec3 wp = vWaterWorld;
  vec2 xz = wp.xz;
  float t = uEnvTime;
  vec2 huv = ( xz - uWaterGrid.xy + 0.5 ) / ( uWaterGrid.zw + 1.0 );
  float depth = uWaterLevel - texture( uWaterHeight, huv ).r;
  if ( depth < -0.05 ) discard;
  float wind = uEnvMisc.w;
  vec2 uv1 = xz * 0.043 + vec2( t * 0.011, t * 0.006 ) * wind;
  vec2 uv2 = xz * 0.107 + vec2( -t * 0.017, t * 0.012 ) * wind;
  vec2 uv3 = xz * 0.29 + vec2( t * 0.028, -t * 0.02 ) * wind;
  vec2 n1 = texture( uWaterNormal, uv1 ).xy * 2.0 - 1.0;
  vec2 n2 = texture( uWaterNormal, uv2 ).xy * 2.0 - 1.0;
  vec2 n3 = texture( uWaterNormal, uv3 ).xy * 2.0 - 1.0;
  vec2 slope = ( n1 * 0.55 + n2 * 0.4 + n3 * 0.22 ) * mix( 0.35, 1.0, smoothstep( 0.0, 1.6, depth ) );
  vec3 N = normalize( vec3( slope.x, 1.0, slope.y ) );
  vec3 toCam = cameraPosition - wp;
  float dist = length( toCam );
  vec3 V = toCam / dist;
  // distant water flattens (avoids sparkly aliasing at the horizon)
  N = normalize( mix( N, vec3( 0.0, 1.0, 0.0 ), smoothstep( 60.0, 260.0, dist ) * 0.7 ) );
  float NdV = max( dot( N, V ), 0.0 );
  float fres = 0.02 + 0.98 * pow( 1.0 - NdV, 5.0 );
  vec3 R = reflect( -V, N );
  R.y = abs( R.y );
  vec3 sky = envSky( R );
  vec3 body = mix( uShallow, uDeep, smoothstep( 0.0, 4.5, depth ) );
  // a little sun-coloured scattering in the wave crests
  body += uSunColorL * 0.012 * max( slope.x + slope.y, 0.0 );
  vec3 col = mix( body, sky, clamp( fres, 0.0, 1.0 ) * 0.92 );
  float sd = max( dot( R, uSunDirW ), 0.0 );
  col += uSunColorL * ( pow( sd, 420.0 ) * 4.0 + pow( sd, 48.0 ) * 0.1 ) * uGlint;
  // shoreline: lapping foam lines + contact foam
  float fn = texture( uWaterNoise, xz * 0.09 + vec2( t * 0.015, -t * 0.01 ) ).b;
  float fn2 = texture( uWaterNoise, xz * 0.37 - vec2( t * 0.03, 0.0 ) ).g;
  float shore = 1.0 - smoothstep( 0.0, 0.7, depth );
  float lap = sin( depth * 19.0 - t * 1.6 + fn * 7.0 ) * 0.5 + 0.5;
  float foam = shore * smoothstep( 0.6, 0.95, lap * 0.75 + fn2 * 0.45 ) * 0.8;
  foam += ( 1.0 - smoothstep( 0.0, 0.14, depth ) ) * ( 0.55 + 0.45 * fn2 );
  foam = clamp( foam, 0.0, 1.0 ) * smoothstep( -0.05, 0.02, depth );
  col = mix( col, uFoam, foam * 0.85 );
  float alpha = mix( 0.42, 1.0, smoothstep( 0.0, 1.5, depth ) );
  alpha = max( alpha, foam * 0.92 ) * smoothstep( -0.05, 0.04, depth );
  vec2 fw = fowSample( xz );
  col = fowDim( col, fw );
  col = envFog( col, wp );
  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = fowUnexplored( gl_FragColor.rgb, fw );
}
`;

export class WaterView {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.PlaneGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly normalTex: THREE.DataTexture;
  private readonly heightTex: THREE.DataTexture;
  private readonly u: Record<string, THREE.IUniform>;

  constructor(ext: ExtendedTerrain, noise: THREE.Texture) {
    this.normalTex = createWaterNormalTexture();
    this.heightTex = ext.createHeightTexture();
    this.u = {
      uWaterNormal: { value: this.normalTex },
      uWaterHeight: { value: this.heightTex },
      uWaterNoise: { value: noise },
      uWaterGrid: { value: new THREE.Vector4(ext.x0, ext.y0, ext.vw - 1, ext.vh - 1) },
      uWaterLevel: { value: ext.waterLevel },
      uDeep: { value: new THREE.Color() },
      uShallow: { value: new THREE.Color() },
      uFoam: { value: new THREE.Color() },
      uGlint: { value: 1 },
    };
    this.mat = new THREE.ShaderMaterial({
      name: 'env-water',
      uniforms: { ...this.u, ...envUniforms, ...fogUniforms },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: true,
      fog: false,
    });
    const size = 2600;
    this.geo = new THREE.PlaneGeometry(size, size, 1, 1);
    this.geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'env:water';
    this.mesh.position.set(ext.map.width / 2, ext.waterLevel, ext.map.height / 2);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  applyPreset(p: PresetDef): void {
    (this.u.uDeep!.value as THREE.Color).setHex(p.water.deep);
    (this.u.uShallow!.value as THREE.Color).setHex(p.water.shallow);
    (this.u.uFoam!.value as THREE.Color).setHex(p.water.foam);
    this.u.uGlint!.value = p.water.glint;
  }

  dispose(): void {
    this.geo.dispose(); this.mat.dispose(); this.normalTex.dispose(); this.heightTex.dispose();
  }
}
