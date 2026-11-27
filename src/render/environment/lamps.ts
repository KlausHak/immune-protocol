/**
 * [environment] Street-lamp glow without real lights: one additive, terrain-hugging mesh of soft light
 * pools on the ground plus one instanced billboard mesh of halos at the lamp heads (2 draw calls total).
 * Strength follows the preset (off by day, warm at dusk, full at night) and the fog of war.
 */
import * as THREE from 'three';
import { FOW_PARS_FRAGMENT, fogUniforms } from './fog';
import type { ExtendedTerrain } from './heightfield';

const POOL_VERT = /* glsl */ `
attribute vec2 aPool;
varying vec2 vPool;
varying vec3 vPoolW;
void main() {
  vPool = aPool;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vPoolW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const POOL_FRAG = /* glsl */ `
uniform vec3 uLampColor;
uniform float uLampStrength;
varying vec2 vPool;
varying vec3 vPoolW;
${FOW_PARS_FRAGMENT}
void main() {
  float r = length( vPool );
  float f = pow( max( 1.0 - r, 0.0 ), 2.0 ) * ( 0.75 + 0.25 * smoothstep( 0.35, 0.0, r ) );
  vec2 fw = fowSample( vPoolW.xz );
  float vis = fw.y * mix( 0.35, 1.0, fw.x );
  gl_FragColor = vec4( uLampColor * f * uLampStrength * vis, 1.0 );
  #include <colorspace_fragment>
}
`;
const HALO_VERT = /* glsl */ `
attribute vec3 aHead;
uniform float uHaloSize;
varying vec2 vHalo;
varying vec3 vHaloW;
void main() {
  vec3 right = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
  vec3 up = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
  vec3 wp = aHead + ( right * position.x + up * position.y ) * uHaloSize;
  vHalo = position.xy * 2.0;
  vHaloW = aHead;
  vec4 mv = viewMatrix * vec4( wp, 1.0 );
  mv.z += 0.35; // pull toward the camera so the lamp's own head doesn't clip the halo
  gl_Position = projectionMatrix * mv;
}
`;
const HALO_FRAG = /* glsl */ `
uniform vec3 uLampColor;
uniform float uLampStrength;
varying vec2 vHalo;
varying vec3 vHaloW;
${FOW_PARS_FRAGMENT}
void main() {
  float r2 = dot( vHalo, vHalo );
  float f = exp( - r2 * 5.0 ) * 0.7 + exp( - r2 * 38.0 ) * 1.6;
  vec2 fw = fowSample( vHaloW.xz );
  float vis = fw.y * mix( 0.35, 1.0, fw.x );
  gl_FragColor = vec4( uLampColor * f * uLampStrength * vis, 1.0 );
  #include <colorspace_fragment>
}
`;

export class LampGlows {
  readonly group = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.ShaderMaterial[] = [];
  private readonly u = { uLampColor: { value: new THREE.Color(0xffc27a) }, uLampStrength: { value: 0 }, uHaloSize: { value: 1.5 } };

  constructor(heads: readonly THREE.Vector3[], ext: ExtendedTerrain) {
    this.group.name = 'env:lamps';
    if (!heads.length) return;
    // ground pools: 6×6 grid discs that follow the terrain
    const R = 3.2, N = 6;
    const pos: number[] = [], pool: number[] = [], idx: number[] = [];
    for (const h of heads) {
      const base = pos.length / 3;
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
        const u = (i / N) * 2 - 1, v = (j / N) * 2 - 1;
        const x = h.x + u * R, z = h.z + v * R;
        pos.push(x, ext.sample(x, z) + 0.04, z);
        pool.push(u, v);
      }
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const a = base + j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
        idx.push(a, c, d, a, d, b);
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pg.setAttribute('aPool', new THREE.Float32BufferAttribute(pool, 2));
    pg.setIndex(idx);
    pg.computeBoundingSphere();
    const pm = new THREE.ShaderMaterial({
      name: 'env-lamp-pools', uniforms: { ...this.u, ...fogUniforms }, vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
    });
    const pools = new THREE.Mesh(pg, pm);
    pools.name = 'env:lamp-pools';
    pools.renderOrder = -8;
    pools.matrixAutoUpdate = false;
    // halos: instanced billboards
    const quad = new THREE.PlaneGeometry(1, 1);
    const hg = new THREE.InstancedBufferGeometry();
    hg.index = quad.index;
    hg.setAttribute('position', quad.attributes.position!);
    const hp = new Float32Array(heads.length * 3);
    heads.forEach((h, i) => hp.set([h.x, h.y, h.z], i * 3));
    hg.setAttribute('aHead', new THREE.InstancedBufferAttribute(hp, 3));
    hg.instanceCount = heads.length;
    const hm = new THREE.ShaderMaterial({
      name: 'env-lamp-halos', uniforms: { ...this.u, ...fogUniforms }, vertexShader: HALO_VERT, fragmentShader: HALO_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const halos = new THREE.Mesh(hg, hm);
    halos.name = 'env:lamp-halos';
    halos.frustumCulled = false;
    halos.matrixAutoUpdate = false;
    this.group.add(pools, halos);
    this.geos.push(pg, hg, quad);
    this.mats.push(pm, hm);
  }

  setStrength(s: number): void {
    this.u.uLampStrength.value = s;
    this.group.visible = s > 0.001;
  }

  dispose(): void { for (const g of this.geos) g.dispose(); for (const m of this.mats) m.dispose(); }
}
