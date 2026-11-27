/**
 * [environment] Light drifting snowfall around the camera focus: one Points draw call, positions wrapped
 * in a world-anchored box on the GPU (flakes stay put in the world while the box follows the camera).
 */
import * as THREE from 'three';
import { FOW_PARS_FRAGMENT, fogUniforms } from './fog';
import { envUniforms } from './sky';

const VERT = /* glsl */ `
uniform vec3 uBoxMin;
uniform vec3 uBoxSize;
uniform float uFlakeSize;
uniform float uPxScale;
uniform float uEnvTime;
uniform vec4 uEnvMisc;
varying float vFade;
varying vec3 vSnowW;
void main() {
  vec3 p = position;
  float t = uEnvTime;
  vec3 drift = vec3( 0.55 * uEnvMisc.w, -0.9 - p.y * 0.5, 0.25 * uEnvMisc.w ) * t;
  drift.x += sin( t * 0.7 + p.z * 31.0 ) * 0.35;
  drift.z += cos( t * 0.6 + p.x * 27.0 ) * 0.35;
  vec3 w = uBoxMin + mod( p * uBoxSize + drift - uBoxMin, uBoxSize );
  vec3 rel = ( w - uBoxMin ) / uBoxSize;
  vFade = smoothstep( 0.0, 0.12, rel.y ) * smoothstep( 1.0, 0.8, rel.y )
        * smoothstep( 0.0, 0.1, rel.x ) * smoothstep( 1.0, 0.9, rel.x )
        * smoothstep( 0.0, 0.1, rel.z ) * smoothstep( 1.0, 0.9, rel.z );
  vSnowW = w;
  vec4 mv = viewMatrix * vec4( w, 1.0 );
  gl_PointSize = clamp( uFlakeSize * ( 0.55 + fract( p.x * 91.7 ) * 0.9 ) * uPxScale / max( -mv.z, 0.5 ), 1.0, 24.0 );
  gl_Position = projectionMatrix * mv;
}
`;
const FRAG = /* glsl */ `
uniform vec3 uFlakeColor;
uniform float uOpacity;
varying float vFade;
varying vec3 vSnowW;
${FOW_PARS_FRAGMENT}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep( 0.5, 0.1, length( c ) ) * vFade * uOpacity;
  vec2 fw = fowSample( vSnowW.xz );
  a *= 0.35 + 0.65 * fw.y;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uFlakeColor, a );
  #include <colorspace_fragment>
}
`;

export class Snowfall {
  readonly points: THREE.Points;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly u = {
    uBoxMin: { value: new THREE.Vector3() },
    uBoxSize: { value: new THREE.Vector3(84, 26, 84) },
    uFlakeSize: { value: 0.11 },
    uPxScale: { value: 800 },
    uFlakeColor: { value: new THREE.Color(0.92, 0.94, 1.0) },
    uOpacity: { value: 0.75 },
  };

  constructor(maxCount: number) {
    const pos = new Float32Array(maxCount * 3);
    let s = 1234567;
    const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < pos.length; i++) pos[i] = r();
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.mat = new THREE.ShaderMaterial({
      name: 'env-snow', uniforms: { ...this.u, uEnvTime: envUniforms.uEnvTime, uEnvMisc: envUniforms.uEnvMisc, ...fogUniforms },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, toneMapped: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.name = 'env:snow';
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.setDensity(0, maxCount);
  }

  setDensity(density: number, maxCount = this.geo.attributes.position!.count): void {
    const n = Math.round(Math.max(0, Math.min(1, density)) * maxCount);
    this.geo.setDrawRange(0, n);
    this.points.visible = n > 0;
  }

  setLook(color: THREE.ColorRepresentation, opacity: number): void {
    this.u.uFlakeColor.value.set(color);
    this.u.uOpacity.value = opacity;
  }

  update(focus: THREE.Vector3, camera: THREE.PerspectiveCamera, drawingBufferHeight: number): void {
    const b = this.u.uBoxSize.value;
    this.u.uBoxMin.value.set(focus.x - b.x / 2, focus.y - 3, focus.z - b.z / 2);
    this.u.uPxScale.value = drawingBufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }

  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}
