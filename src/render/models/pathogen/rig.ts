/**
 * [models-pathogen] Shared model rig + animation helpers.
 *
 * Hierarchy of every pathogen model:   root (render core owns its transform)
 *                                       └─ base   (static size normalisation, e.g. data radius / nominal radius)
 *                                           └─ body   (death / attack squash / construction growth pivot, at ground origin)
 *                                               └─ … parts (meshes / groups animated by the specific model)
 * Structures also get a ground "creep" splat directly under base (not affected by breathing).
 *
 * Only per-instance resources (Object3Ds, InstancedMesh matrix buffers) are created per model; geometry
 * and materials are shared caches and are never disposed by a model.
 */
import * as THREE from 'three';
import type { ModelAnimState } from '../types';
import { getPalette, type Family, type Palette, type Variant } from './shader';

// ───────────────────────────── math ─────────────────────────────
export const TAU = Math.PI * 2;
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (t: number): number => { const x = clamp01(t); return x * x * (3 - 2 * x); };
export const easeOut = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
export const easeIn = (t: number): number => Math.pow(clamp01(t), 3);
/** frame-rate independent exponential approach */
export const damp = (cur: number, target: number, lambda: number, dt: number): number => lerp(cur, target, 1 - Math.exp(-lambda * dt));
export function wrapAngle(a: number): number { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
export const dampAngle = (cur: number, target: number, lambda: number, dt: number): number => cur + wrapAngle(target - cur) * (1 - Math.exp(-lambda * dt));
/** 1 right after an attack release, falling to 0 after `dur` seconds */
export const attackPulse = (sinceAttack: number, dur = 0.2): number => (sinceAttack < dur && sinceAttack >= 0 ? 1 - sinceAttack / dur : 0);
/** damped spring "boing" for t seconds after an impulse: 1 → oscillating → 0 */
export const boing = (t: number, freq = 14, decay = 7): number => (t < 0 || !isFinite(t) ? 0 : Math.exp(-decay * t) * Math.cos(freq * t));

// ───────────────────────────── variants ─────────────────────────────

export function unitVariant(st: ModelAnimState, busy = false): Variant {
  if (st.death > 0) return st.death < 0.14 ? 'flash' : 'dead';
  if (st.sinceAttack < 0.13) return 'flash';
  if (busy) return 'active';
  return 'idle';
}

export function structureVariant(st: ModelAnimState): Variant {
  if (st.death > 0) return st.death < 0.12 ? 'flash' : 'dead';
  if (st.construction < 1) return 'immature';
  if (st.sinceAttack < 0.13) return 'flash';
  if (st.producing) return 'active';
  return 'idle';
}

// ───────────────────────────── rig ─────────────────────────────

interface Part { mesh: THREE.Mesh; family: Family; fixed?: Variant }

export class Rig {
  readonly root = new THREE.Group();
  /** static size normalisation (data radius / nominal radius) — never animated */
  readonly base = new THREE.Group();
  readonly body = new THREE.Group();
  readonly pal: Palette;
  private parts: Part[] = [];
  private owned: Array<{ dispose(): void }> = [];
  private variant: Variant | null = null;

  constructor(name: string, team: THREE.Color | number, fog: boolean) {
    this.pal = getPalette(team, fog);
    this.root.name = name;
    this.base.name = 'base';
    this.body.name = 'body';
    this.root.add(this.base);
    this.base.add(this.body);
  }

  /** Add a mesh with a shared geometry; `family` picks opaque flesh vs translucent glass materials. */
  mesh(geo: THREE.BufferGeometry, parent: THREE.Object3D = this.body, family: Family = 'flesh', fixed?: Variant): THREE.Mesh {
    const m = new THREE.Mesh(geo, this.pal.get(family, fixed ?? 'idle'));
    parent.add(m);
    this.parts.push({ mesh: m, family, fixed });
    return m;
  }

  /** Per-model InstancedMesh (one draw call for many limbs); its matrix buffer is disposed with the model. */
  instanced(geo: THREE.BufferGeometry, count: number, parent: THREE.Object3D = this.body, family: Family = 'flesh', boundsRadius = 2): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, this.pal.get(family, 'idle'), count);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // animated instances move around: use a generous fixed bounding sphere for culling
    m.boundingSphere = new THREE.Sphere(new THREE.Vector3(), boundsRadius);
    parent.add(m);
    this.parts.push({ mesh: m, family });
    this.owned.push(m);
    return m;
  }

  /** Swap every (non-fixed) part to the shared material of a variant. */
  setVariant(v: Variant): void {
    if (v === this.variant) return;
    this.variant = v;
    for (const p of this.parts) if (!p.fixed) p.mesh.material = this.pal.get(p.family, v);
  }

  /** Override one part's variant (e.g. an "enraged" core) — call after setVariant each frame. */
  setPartVariant(mesh: THREE.Mesh, v: Variant): void {
    const p = this.parts.find((q) => q.mesh === mesh);
    if (p) mesh.material = this.pal.get(p.family, v);
    this.variant = null; // force the next setVariant to re-apply
  }

  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.owned = [];
  }
}

// ───────────────────────────── shared poses ─────────────────────────────

/**
 * Unit death "pop": swell (flash) → burst into a flat splat → melt away. t = 0..1.
 * Scales the body around its pivot; `drop` lowers it (flying units fall to the ground).
 */
export function unitDeathPose(body: THREE.Object3D, t: number, drop = 0): void {
  let sx: number, sy: number;
  if (t < 0.16) { const k = easeOut(t / 0.16); sx = sy = 1 + 0.28 * k; }
  else if (t < 0.34) { const k = smooth((t - 0.16) / 0.18); sx = lerp(1.28, 1.5, k); sy = lerp(1.28, 0.3, k); }
  else { const k = (t - 0.34) / 0.66; sx = lerp(1.5, 0.05, easeIn(k)); sy = lerp(0.3, 0.02, k); }
  body.scale.set(sx, sy, sx);
  body.position.set(0, drop > 0 ? -drop * easeIn(Math.min(1, t * 2.2)) : 0, 0);
  body.rotation.set(0, 0, 0);
}

/** Structure death: shudder, deflate and sink into the creep. t = 0..1. */
export function structureDeathPose(body: THREE.Object3D, t: number, height: number, time: number): void {
  const k = easeIn(t);
  const shake = (1 - t) * 0.035 * Math.sin(time * 61);
  body.scale.set(1 + 0.22 * smooth(t) + shake, Math.max(0.04, 1 - 0.9 * k), 1 + 0.22 * smooth(t) - shake);
  body.position.set(shake * 0.6, -0.12 * height * k, 0);
}

/**
 * Construction: the structure grows out of a small blob. Returns the growth scale applied to body.
 * `germ` (optional) is a lumpy sac that dominates early and recedes as the structure takes shape.
 */
export function constructionPose(body: THREE.Object3D, c: number, time: number, phase: number, germ?: THREE.Object3D | null, germSize = 1): void {
  const g = 0.16 + 0.84 * easeOut(c);
  const wob = 0.035 * Math.sin(time * 5.3 + phase) * (1 - c);
  body.scale.set(g * (1 + wob), g * (0.55 + 0.45 * c) * (1 - wob), g * (1 + wob));
  body.position.set(0, 0, 0);
  if (germ) {
    const s = c < 0.75 ? germSize * (0.55 + 0.45 * Math.sin(Math.min(1, c / 0.75) * Math.PI * 0.5)) * (1 - smooth((c - 0.35) / 0.4)) : 0;
    germ.visible = s > 0.01;
    const pulse = 1 + 0.06 * Math.sin(time * 4.1 + phase);
    germ.scale.set(s * pulse, s * (0.8 + 0.2 * pulse), s * pulse);
  }
}

/** Idle/producing breathing for structures; returns the pulse value (−1..1). */
export function breathe(body: THREE.Object3D, time: number, phase: number, producing: boolean, amp = 0.022): number {
  const rate = producing ? 3.4 : 1.25;
  const a = producing ? amp * 1.7 : amp;
  const s = Math.sin(time * rate + phase);
  body.scale.set(1 + a * s, 1 - a * 0.7 * s, 1 + a * s);
  body.position.set(0, 0, 0);
  return s;
}

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
/** Write one instance matrix from position / Euler (YXZ order: yaw first) / scale. */
export function setInst(m: THREE.InstancedMesh, i: number, px: number, py: number, pz: number, rx: number, ry: number, rz: number, sx = 1, sy = sx, sz = sx, order: THREE.EulerOrder = 'YZX'): void {
  _q.setFromEuler(_e.set(rx, ry, rz, order));
  m.setMatrixAt(i, _m4.compose(_p.set(px, py, pz), _q, _s.set(sx, sy, sz)));
}
export function setInstQ(m: THREE.InstancedMesh, i: number, p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3): void {
  m.setMatrixAt(i, _m4.compose(p, q, s));
}

/** Stable per-entity randomness. */
export function seeded(seed: number): () => number {
  let a = (Math.floor(seed * 2654435761) >>> 0) ^ 0x5bd1e995;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
