/**
 * [vfx] Mesh-based effect pieces:
 *  - ProjectileMeshes: InstancedMeshes for projectile bodies (antibiotic capsule, spore cluster, acid glob)
 *    with an unlit fresnel "glow glass" shader (HDR → bloom). One draw call per body type.
 *  - DomePool: additive fresnel hemispheres (UV Flare sterilisation dome).
 *  - Helicopter / supply crate builders (Emergency Supply Drop), shared geometry & materials.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fogUniforms } from './atlas';

const GLOW_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
#include <fog_pars_vertex>
void main() {
  vec4 p = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
    n = mat3(instanceMatrix) * n;
  #endif
  vec4 mvPosition = modelViewMatrix * p;
  vN = normalize(mat3(modelViewMatrix) * n);
  vV = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const GLOW_FRAG = /* glsl */`
uniform vec3 uBase;
uniform vec3 uRim;
uniform float uRimPow;
uniform float uPulse;
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
#include <fog_pars_fragment>
void main() {
  float f = 1.0 - max(dot(normalize(vN), normalize(vV)), 0.0);
  float rim = pow(f, uRimPow);
  float pulse = 1.0 + uPulse * sin(uTime * 14.0);
  vec3 col = (uBase + uRim * rim) * pulse;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

function glowMaterial(base: [number, number, number], rim: [number, number, number], rimPow: number, pulse = 0): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...fogUniforms(),
      uBase: { value: new THREE.Vector3(...base) }, uRim: { value: new THREE.Vector3(...rim) }, uRimPow: { value: rimPow },
      uPulse: { value: pulse }, uTime: { value: 0 },
    },
    vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, fog: true,
  });
}

/** Instanced projectile bodies. Call begin() each frame, set() per visible body, flush() at the end. */
export class ProjectileMeshes {
  readonly group = new THREE.Group();
  readonly capsule: THREE.InstancedMesh;
  readonly spores: THREE.InstancedMesh;
  readonly glob: THREE.InstancedMesh;
  private readonly mats: THREE.ShaderMaterial[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private nCapsule = 0; private nSpores = 0; private nGlob = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly qs = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private static readonly X = new THREE.Vector3(1, 0, 0);

  constructor(readonly capacity: number) {
    const capGeo = new THREE.CapsuleGeometry(0.1, 0.3, 4, 10).rotateZ(-Math.PI / 2);
    const sporeParts: THREE.BufferGeometry[] = [];
    const offs: Array<[number, number, number, number]> = [[0, 0, 0, 0.15], [0.13, 0.05, 0.04, 0.1], [-0.1, 0.08, -0.07, 0.11], [0.02, -0.1, 0.11, 0.09], [-0.04, 0.02, 0.14, 0.08], [0.06, 0.12, -0.11, 0.07]];
    for (const [x, y, z, r] of offs) sporeParts.push(new THREE.IcosahedronGeometry(r, 1).translate(x, y, z));
    const sporeGeo = mergeGeometries(sporeParts) ?? new THREE.IcosahedronGeometry(0.16, 1);
    for (const g of sporeParts) g.dispose();
    const globGeo = new THREE.IcosahedronGeometry(0.15, 2);
    this.geos.push(capGeo, sporeGeo, globGeo);
    const capMat = glowMaterial([0.55, 1.5, 1.3], [1.4, 3.6, 3.0], 1.6, 0.06);
    const sporeMat = glowMaterial([0.2, 0.17, 0.05], [1.4, 1.7, 0.35], 2.2, 0.0);
    const globMat = glowMaterial([0.35, 1.25, 0.08], [1.3, 3.2, 0.3], 1.8, 0.12);
    this.mats.push(capMat, sporeMat, globMat);
    this.capsule = new THREE.InstancedMesh(capGeo, capMat, capacity);
    this.spores = new THREE.InstancedMesh(sporeGeo, sporeMat, capacity);
    this.glob = new THREE.InstancedMesh(globGeo, globMat, capacity);
    for (const im of [this.capsule, this.spores, this.glob]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.count = 0;
      im.renderOrder = 5;
      this.group.add(im);
    }
    this.group.name = 'vfx:projectile-meshes';
  }

  begin(time: number): void {
    this.nCapsule = this.nSpores = this.nGlob = 0;
    for (const m of this.mats) m.uniforms.uTime!.value = time;
  }

  /** Orients +X along (dx, dy, dz), applies a roll around it, non-uniform scale (sx along travel). */
  private compose(x: number, y: number, z: number, dx: number, dy: number, dz: number, roll: number, sx: number, syz: number): THREE.Matrix4 {
    this.dir.set(dx, dy, dz);
    if (this.dir.lengthSq() < 1e-8) this.dir.set(1, 0, 0); else this.dir.normalize();
    this.q.setFromUnitVectors(ProjectileMeshes.X, this.dir);
    this.qs.setFromAxisAngle(ProjectileMeshes.X, roll);
    this.q.multiply(this.qs);
    this.p.set(x, y, z);
    this.s.set(sx, syz, syz);
    return this.m.compose(this.p, this.q, this.s);
  }

  addCapsule(x: number, y: number, z: number, dx: number, dy: number, dz: number, roll: number, scale: number): void {
    if (this.nCapsule >= this.capacity) return;
    this.capsule.setMatrixAt(this.nCapsule++, this.compose(x, y, z, dx, dy, dz, roll, scale, scale));
  }
  addSpores(x: number, y: number, z: number, roll: number, scale: number): void {
    if (this.nSpores >= this.capacity) return;
    // tumble: roll about a tilted axis
    this.spores.setMatrixAt(this.nSpores++, this.compose(x, y, z, Math.cos(roll * 0.7), 0.4, Math.sin(roll * 0.7), roll, scale, scale));
  }
  addGlob(x: number, y: number, z: number, dx: number, dy: number, dz: number, wobble: number, scale: number): void {
    if (this.nGlob >= this.capacity) return;
    const stretch = 1.35 + 0.15 * Math.sin(wobble * 17);
    this.glob.setMatrixAt(this.nGlob++, this.compose(x, y, z, dx, dy, dz, wobble, scale * stretch, scale * (1.05 - 0.1 * Math.sin(wobble * 17))));
  }

  flush(): void {
    const set = (im: THREE.InstancedMesh, n: number) => { im.count = n; if (n > 0) im.instanceMatrix.needsUpdate = true; };
    set(this.capsule, this.nCapsule); set(this.spores, this.nSpores); set(this.glob, this.nGlob);
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.capsule.dispose(); this.spores.dispose(); this.glob.dispose();
  }
}

// ───────────────────────── domes ─────────────────────────
const DOME_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
varying float vH;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mvPosition.xyz);
  vH = position.y;
  gl_Position = projectionMatrix * mvPosition;
}
`;
const DOME_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying float vH;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(f, 2.2);
  float bands = 0.85 + 0.15 * sin(vH * 26.0 - uTime * 18.0);
  float base = smoothstep(0.0, 0.12, vH) * 0.35 + 0.65;
  vec3 col = uColor * (0.22 + rim * 1.6) * bands * base;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * uAlpha, 0.0);
}
`;

export interface Dome { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; t0: number; dur: number; radius: number; active: boolean }

/** Small pool of additive hemispheres. */
export class DomePool {
  readonly group = new THREE.Group();
  readonly domes: Dome[] = [];
  private readonly geo = new THREE.SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2);

  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Vector3(1, 1, 1) }, uAlpha: { value: 0 }, uTime: { value: 0 } },
        vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 9;
      this.group.add(mesh);
      this.domes.push({ mesh, mat, t0: 0, dur: 1, radius: 1, active: false });
    }
    this.group.name = 'vfx:domes';
  }

  /** Grabs a free dome (or recycles the oldest). */
  acquire(): Dome {
    let best = this.domes[0]!;
    for (const d of this.domes) { if (!d.active) return d; if (d.t0 < best.t0) best = d; }
    return best;
  }

  dispose(): void {
    this.geo.dispose();
    for (const d of this.domes) d.mat.dispose();
  }
}

// ───────────────────────── helicopter & crate ─────────────────────────
export interface HeliRig { root: THREE.Group; rotor: THREE.Object3D; tailRotor: THREE.Object3D }
export interface CrateRig { root: THREE.Group; chute: THREE.Object3D }

/** Shared low-poly parts for the medical supply helicopter (≈ 3.4 units long, +X forward). */
export class HeliParts {
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly body: THREE.BufferGeometry;
  private readonly stripe: THREE.BufferGeometry;
  private readonly glass: THREE.BufferGeometry;
  private readonly dark: THREE.BufferGeometry;
  private readonly blade: THREE.BufferGeometry;
  private readonly crate: THREE.BufferGeometry;
  private readonly plus: THREE.BufferGeometry;
  private readonly chute: THREE.BufferGeometry;
  readonly white: THREE.MeshStandardMaterial;
  readonly teal: THREE.MeshStandardMaterial;
  readonly glassMat: THREE.MeshStandardMaterial;
  readonly darkMat: THREE.MeshStandardMaterial;
  readonly chuteMat: THREE.MeshStandardMaterial;

  constructor(teamColor: THREE.Color) {
    const keep = <T extends THREE.BufferGeometry>(g: T): T => { this.geos.push(g); return g; };
    const cabin = new THREE.SphereGeometry(0.5, 14, 10).scale(1.35, 0.85, 0.75).translate(0.25, 0, 0);
    const boom = new THREE.CylinderGeometry(0.09, 0.16, 1.7, 8).rotateZ(Math.PI / 2).translate(-1.05, 0.12, 0);
    const fin = new THREE.BoxGeometry(0.42, 0.5, 0.05).translate(-1.85, 0.36, 0);
    const tailPlane = new THREE.BoxGeometry(0.3, 0.04, 0.6).translate(-1.6, 0.14, 0);
    this.body = keep(mergeGeometries([cabin, boom, fin, tailPlane]) ?? cabin);
    this.stripe = keep(new THREE.BoxGeometry(1.25, 0.12, 0.79).translate(0.15, -0.08, 0));
    this.glass = keep(new THREE.SphereGeometry(0.34, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1.1, 0.8, 0.95).rotateZ(-Math.PI / 2.4).translate(0.72, 0.1, 0));
    const skidL = new THREE.BoxGeometry(1.3, 0.05, 0.05).translate(0.15, -0.55, 0.36);
    const skidR = skidL.clone().translate(0, 0, -0.72);
    const strut1 = new THREE.BoxGeometry(0.05, 0.25, 0.05).translate(0.5, -0.42, 0.33);
    const strut2 = strut1.clone().translate(-0.6, 0, 0);
    const strut3 = strut1.clone().translate(0, 0, -0.66);
    const strut4 = strut2.clone().translate(0, 0, -0.66);
    const mast = new THREE.CylinderGeometry(0.05, 0.07, 0.22, 6).translate(0.2, 0.52, 0);
    this.dark = keep(mergeGeometries([skidL, skidR, strut1, strut2, strut3, strut4, mast]) ?? skidL);
    const b1 = new THREE.BoxGeometry(3.0, 0.02, 0.12);
    const b2 = new THREE.BoxGeometry(0.12, 0.02, 3.0);
    this.blade = keep(mergeGeometries([b1, b2]) ?? b1);
    for (const g of [cabin, boom, fin, tailPlane, skidL, skidR, strut1, strut2, strut3, strut4, mast, b1, b2]) if (!this.geos.includes(g)) g.dispose();
    this.crate = keep(new THREE.BoxGeometry(0.55, 0.45, 0.55));
    const p1 = new THREE.BoxGeometry(0.36, 0.02, 0.11).translate(0, 0.235, 0);
    const p2 = new THREE.BoxGeometry(0.11, 0.02, 0.36).translate(0, 0.235, 0);
    this.plus = keep(mergeGeometries([p1, p2]) ?? p1);
    p1.dispose(); p2.dispose();
    this.chute = keep(new THREE.SphereGeometry(0.75, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.42).translate(0, 0.9, 0));
    this.white = new THREE.MeshStandardMaterial({ color: 0xf1f4f6, roughness: 0.45, metalness: 0.15 });
    this.teal = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.4, metalness: 0.1, emissive: teamColor, emissiveIntensity: 0.25 });
    this.glassMat = new THREE.MeshStandardMaterial({ color: 0x1c2c3a, roughness: 0.15, metalness: 0.6, emissive: 0x2a6f8a, emissiveIntensity: 0.35 });
    this.darkMat = new THREE.MeshStandardMaterial({ color: 0x30353b, roughness: 0.7, metalness: 0.4 });
    this.chuteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide, emissive: teamColor, emissiveIntensity: 0.15 });
    this.mats.push(this.white, this.teal, this.glassMat, this.darkMat, this.chuteMat);
  }

  buildHeli(): HeliRig {
    const root = new THREE.Group();
    root.name = 'vfx:helicopter';
    const body = new THREE.Mesh(this.body, this.white);
    const stripe = new THREE.Mesh(this.stripe, this.teal);
    const glass = new THREE.Mesh(this.glass, this.glassMat);
    const dark = new THREE.Mesh(this.dark, this.darkMat);
    const rotor = new THREE.Mesh(this.blade, this.darkMat);
    rotor.position.set(0.2, 0.64, 0);
    const tailRotor = new THREE.Mesh(this.blade, this.darkMat);
    tailRotor.scale.set(0.22, 0.22, 0.22);
    tailRotor.rotation.x = Math.PI / 2;
    tailRotor.position.set(-1.9, 0.38, 0.06);
    root.add(body, stripe, glass, dark, rotor, tailRotor);
    for (const c of root.children) c.castShadow = true;
    root.visible = false;
    return { root, rotor, tailRotor };
  }

  buildCrate(): CrateRig {
    const root = new THREE.Group();
    root.name = 'vfx:supply-crate';
    const box = new THREE.Mesh(this.crate, this.teal);
    const plus = new THREE.Mesh(this.plus, this.white);
    const chute = new THREE.Mesh(this.chute, this.chuteMat);
    box.castShadow = true; chute.castShadow = true;
    root.add(box, plus, chute);
    root.visible = false;
    return { root, chute };
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
