/**
 * [models-pathogen] Pathogen unit models (everything except the Strain Omega boss, see omega.ts).
 * Geometry is built once per def (+ a few seed variants) and cached; each model instance only creates
 * Object3Ds and, for limbs, a small per-instance InstancedMesh (one draw call for all legs/cilia).
 */
import * as THREE from 'three';
import type { UnitDef } from '../../../core/types';
import { tryGetDef } from '../../../data';
import type { EntityModel, ModelAnimState, ModelBuildContext, ModelBuilder } from '../types';
import { GeoBuilder, alignY, ball, blob, cached, capsid, cone, curve, cyl, fibonacciSphere, flattenBelow, lathe, noise3, rng, sweep, torus } from './geom';
import { Rig, TAU, attackPulse, boing, clamp01, damp, dampAngle, easeIn, easeOut, lerp, seeded, setInst, smooth, unitDeathPose, unitVariant } from './rig';
import { ACID_GREEN } from './shader';

// ───────────────────────────── palette helpers (linear colours) ─────────────────────────────
export const lin = (r: number, g: number, b: number): THREE.Color => new THREE.Color().setRGB(r, g, b);
export const grey = (v: number): THREE.Color => lin(v, v, v);
/** acid-green ALBEDO for accent parts (kept dark: the emissive accent channel supplies the glow) */
export const GREEN = new THREE.Color(ACID_GREEN).multiplyScalar(0.38);
/** Quaternion from Euler angles in a chosen order (vector rotated by the LAST letter first… e.g. 'ZYX' = X first). */
export const qe = (x: number, y: number, z: number, order: THREE.EulerOrder = 'XYZ'): THREE.Quaternion =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, order));

/** Common model boilerplate: visibility early-out, dt clamp, death handling. */
function unitModel(rig: Rig, height: number, opts: { muzzle?: THREE.Vector3; death?: (t: number, time: number) => void },
  animate: (st: ModelAnimState, dt: number, time: number) => void): EntityModel {
  return {
    root: rig.root,
    height,
    muzzle: opts.muzzle,
    handlesDeath: true,
    update(st, dtRaw, time) {
      // hidden in fog: skip the animation work entirely (all motion is time-based, resumes seamlessly)
      if (!rig.root.visible && st.death <= 0) return;
      const dt = Math.min(Math.max(dtRaw, 0), 0.1);
      if (st.death > 0) {
        rig.setVariant(unitVariant(st));
        if (opts.death) opts.death(Math.min(1, st.death), time); else unitDeathPose(rig.body, Math.min(1, st.death));
        return;
      }
      rig.body.scale.set(1, 1, 1);
      rig.body.position.set(0, 0, 0);
      rig.body.rotation.set(0, 0, 0);
      animate(st, dt, time);
    },
    dispose: () => rig.dispose(),
  };
}

/** Size factor so the model fills the entity's actual collision radius. */
const sizeK = (ctx: ModelBuildContext, nominal: number): number => (ctx.radius > 0 ? ctx.radius / nominal : 1);

// ═════════════════════════════ SPORE DRONE (worker) ═════════════════════════════
const DRONE_R = 0.38;

function droneShell(v: number): THREE.BufferGeometry {
  return cached(`drone:shell:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(11 + v, 5, 3);
    b.add(blob(0.25, 4, 0.07, 2.4, 3 + v, [1, 0.9, 1]), (p) => {
      const up = clamp01((p.y / 0.25) * 0.5 + 0.5);
      return { color: grey(0.5 + 0.5 * up + 0.08 * nz(p.x * 4, p.y * 4, p.z * 4)), glow: 0.1 + 0.14 * (1 - up), rim: 1.15, rough: 0.38, wobble: 0.45 };
    });
    // equatorial girdle (pollen-grain ridge)
    b.add(torus(0.248, 0.034, 6, 30), { color: grey(0.48), rough: 0.45, rim: 0.8 }, { r: [Math.PI / 2, 0, 0], p: [0, -0.02, 0] });
    // acid pores on the upper hemisphere (keep the "face" clear)
    const rr = rng(40 + v);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + rr() * 0.5, el = 0.3 + rr() * 0.8;
      const d = new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el) * 0.9, Math.sin(a) * Math.cos(el)).normalize();
      if (d.x > 0.5 && Math.abs(d.z) < 0.4) continue;
      b.add(ball(0.03 + rr() * 0.014, 7, 5), { color: GREEN, team: 0, accent: 1.2, rim: 0.4, rough: 0.3 }, { p: d.multiplyScalar(0.232) });
    }
    // twin eyespots facing forward (+X) — creepy-cute and shows facing
    for (const z of [-0.072, 0.072]) b.add(ball(0.036, 8, 6), { color: grey(1), team: 0.1, glow: 1.7, rim: 0.2, rough: 0.2 }, { p: [0.213, 0.055, z] });
    // little sprout on top
    b.add(cone(0.03, 0.11, 5), { color: grey(0.7), rim: 1.2 }, { p: [-0.03, 0.2, 0], r: [0, 0, 0.3] });
    b.add(ball(0.027, 6, 4), { color: GREEN, team: 0, accent: 1.3 }, { p: [-0.065, 0.305, 0] });
    return b.build();
  });
}
const droneCilium = (): THREE.BufferGeometry => cached('drone:cilium', () =>
  new GeoBuilder().add(sweep(curve([[0, 0, 0], [0.08, -0.01, 0], [0.15, -0.045, 0], [0.2, -0.1, 0]]), (t) => lerp(0.017, 0.005, t), 4, 6),
    (p) => ({ color: grey(0.85), accent: p.x > 0.14 ? 0.6 : 0, rim: 1.3, rough: 0.4 })).build());
const droneGlob = (): THREE.BufferGeometry => cached('drone:glob', () =>
  new GeoBuilder().add(blob(0.11, 2, 0.18, 3, 5), { color: GREEN, team: 0.1, accent: 0.9, wobble: 1.2, rough: 0.25, rim: 0.6 }).build());

const buildSporeDrone: ModelBuilder = (ctx) => {
  const v = Math.abs(ctx.seed) % 3, k = sizeK(ctx, DRONE_R);
  const rig = new Rig(`model:${ctx.defId}`, ctx.teamColor, false);
  rig.base.scale.setScalar(k);
  const hover = new THREE.Group();
  rig.body.add(hover);
  const shell = rig.mesh(droneShell(v), hover);
  const ring = new THREE.Group();
  ring.position.y = -0.035;
  hover.add(ring);
  const N = 14;
  const cilia = rig.instanced(droneCilium(), N, ring, 'flesh', 0.6);
  const glob = rig.mesh(droneGlob(), hover);
  glob.position.set(0, -0.3, 0);
  glob.visible = false;
  const r = seeded(ctx.seed), ph = r() * TAU;
  let walk = 0, carry = 0, spin = r() * TAU, beat = r() * TAU;
  return unitModel(rig, 0.98 * k, {}, (st, dt, time) => {
    const busy = st.activity === 'gathering' || st.activity === 'building';
    rig.setVariant(unitVariant(st, busy));
    walk = damp(walk, st.moving ? clamp01(st.speed / 2.4) : 0, 5, dt);
    carry = damp(carry, st.carrying ? 1 : 0, 7, dt);
    const lunge = Math.sin(attackPulse(st.sinceAttack, 0.28) * Math.PI);
    hover.position.set(0.1 * lunge, 0.6 + 0.045 * Math.sin(time * 1.9 + ph) + 0.015 * Math.sin(time * 5.1 + ph), 0);
    hover.rotation.set(0.07 * Math.sin(time * 1.3 + ph), 0, -0.3 * walk - 0.35 * lunge);
    const sq = 1 + 0.04 * Math.sin(time * 2.6 + ph) + 0.08 * lunge;
    shell.scale.set(sq, 2 - sq, sq);
    spin += dt * (0.6 + 3.2 * walk + (busy ? 2 : 0));
    ring.rotation.y = spin;
    beat += dt * (6 + 10 * walk + (busy ? 6 : 0));
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      setInst(cilia, i, Math.cos(a) * 0.235, 0, Math.sin(a) * 0.235, 0, -a, -0.15 + 0.42 * Math.sin(beat - a * 2));
    }
    cilia.instanceMatrix.needsUpdate = true;
    glob.visible = carry > 0.03;
    if (glob.visible) { const g = carry * (1 + 0.07 * Math.sin(time * 6 + ph)); glob.scale.set(g, g * 0.9, g); }
  });
};

// ═════════════════════════════ PHAGE ═════════════════════════════
const PHAGE_R = 0.32, PHAGE_HIP_Y = 0.255, PHAGE_HIP_R = 0.062, PHAGE_COLLAR_Y = 0.585;

function phageHead(v: number): THREE.BufferGeometry {
  return cached(`phage:head:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(70 + v, 4, 3);
    // prolate icosahedral capsid; faceted with per-face shade variation
    b.add(capsid(0.2, 0), (_p, n) => ({ color: grey(0.7 + 0.3 * (0.5 + 0.5 * nz(n.x * 3, n.y * 3, n.z * 3))), glow: 0.28, rim: 1.4, rough: 0.26 }),
      { p: [0, 0.245, 0], s: [1, 1.22, 1], r: [0.32, v * 0.5, 0.18] });
    b.add(torus(0.062, 0.023, 6, 16), { color: grey(0.42), rim: 0.8, rough: 0.4 }, { r: [Math.PI / 2, 0, 0] });
    b.add(cyl(0.042, 0.05, 0.07, 8), { color: grey(0.5) }, { p: [0, -0.02, 0] });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.3;
      b.add(sweep(curve([[0.055, 0, 0], [0.12, -0.035, 0], [0.16, -0.11, 0]]), (t) => lerp(0.009, 0.004, t), 4, 5),
        (p) => ({ color: grey(0.6), accent: p.y < -0.08 ? 0.6 : 0, rim: 1.2 }), { r: [0, -a, 0] });
    }
    return b.build();
  });
}
function phageSheath(): THREE.BufferGeometry {
  return cached('phage:sheath', () => {
    const b = new GeoBuilder();
    const L = PHAGE_COLLAR_Y - PHAGE_HIP_Y, ribs = 8;
    const prof: Array<[number, number]> = [[0, 0]];
    for (let i = 0; i <= ribs * 2; i++) prof.push([i % 2 ? 0.058 : 0.045, (i / (ribs * 2)) * L]);
    prof.push([0, L]);
    b.add(lathe(prof, 10), (p) => ({ color: grey(0.5), accent: Math.hypot(p.x, p.z) > 0.054 ? 0.8 : 0.04, rim: 1.0, rough: 0.35 }));
    b.add(cyl(0.092, 0.092, 0.036, 6), { color: grey(0.4), rim: 1.1, rough: 0.4 }, { p: [0, -0.036, 0] });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      b.add(cone(0.013, 0.05, 4), { color: grey(0.5) }, { p: [Math.cos(a) * 0.08, -0.034, Math.sin(a) * 0.08], r: [Math.PI, 0, 0] });
    }
    b.add(cone(0.021, 0.12, 6), { color: GREEN, team: 0.1, accent: 1.3, rim: 0.4 }, { p: [0, -0.034, 0], r: [Math.PI, 0, 0] });
    return b.build();
  });
}
function phageLeg(): THREE.BufferGeometry {
  return cached('phage:leg', () => {
    const b = new GeoBuilder();
    const c = curve([[0, 0, 0], [0.08, 0.1, 0], [0.17, 0.15, 0], [0.245, 0.06, 0], [0.3, -0.12, 0], [0.318, -PHAGE_HIP_Y, 0]], 0.4);
    b.add(sweep(c, (t) => lerp(0.018, 0.0075, t), 5, 14), (p) => ({ color: grey(0.4 + 0.22 * clamp01(p.y / 0.15)), rim: 1.4, rough: 0.4 }));
    b.add(ball(0.023, 6, 5), { color: grey(0.58), rim: 1.2 }, { p: [0.17, 0.15, 0] });
    b.add(ball(0.014, 5, 4), { color: GREEN, team: 0, accent: 0.9 }, { p: [0.318, -PHAGE_HIP_Y, 0] });
    return b.build();
  });
}

/** head + collar + sheath + baseplate merged into ONE mesh (swarm-friendly: 2 draw calls per phage). */
function phageBody(v: number): THREE.BufferGeometry {
  return cached(`phage:body:${v}`, () => new GeoBuilder()
    .addPainted(phageSheath(), { p: [0, PHAGE_HIP_Y, 0] })
    .addPainted(phageHead(v), { p: [0, PHAGE_COLLAR_Y, 0] })
    .build());
}

const buildPhage: ModelBuilder = (ctx) => {
  const v = Math.abs(ctx.seed) % 3, k = sizeK(ctx, PHAGE_R);
  const rig = new Rig(`model:${ctx.defId}`, ctx.teamColor, false);
  rig.base.scale.setScalar(k);
  const torso = new THREE.Group();
  rig.body.add(torso);
  // pivot at the hips so the injection "contraction" squashes the sheath/head toward the baseplate
  const upper = new THREE.Group();
  upper.position.y = PHAGE_HIP_Y;
  torso.add(upper);
  const bodyM = rig.mesh(phageBody(v), upper);
  bodyM.position.y = -PHAGE_HIP_Y;
  const legs = rig.instanced(phageLeg(), 6, torso, 'flesh', 0.9);
  const r = seeded(ctx.seed), ph = r() * TAU;
  let walk = 0, gait = r() * TAU, look = 0, lookTarget = 0, nextLook = 0;
  return unitModel(rig, 1.07 * k, {}, (st, dt, time) => {
    rig.setVariant(unitVariant(st));
    walk = damp(walk, st.moving ? 1 : 0, 8, dt);
    gait += dt * Math.max(st.speed, st.moving ? 1.5 : 0) * 9.5;
    const atk = attackPulse(st.sinceAttack, 0.34);
    const stab = atk > 0 ? Math.sin(Math.sqrt(atk) * Math.PI) : 0;
    torso.position.y = 0.024 * Math.abs(Math.sin(gait)) * walk;
    torso.rotation.z = -0.12 * walk + 0.1 * stab;
    if (time > nextLook) { lookTarget = (r() - 0.5) * 1.3; nextLook = time + 1.5 + r() * 2.5; }
    look = dampAngle(look, walk > 0.5 ? 0 : lookTarget, 3, dt);
    upper.rotation.set(0.05 * Math.sin(time * 1.7 + ph), look, 0);
    upper.scale.set(1 + 0.08 * stab, 1 - 0.3 * stab, 1 + 0.08 * stab);
    for (let i = 0; i < 6; i++) {
      const a = ((i + 0.5) / 6) * TAU;
      const g = gait + (i % 2) * Math.PI;
      const swing = Math.sin(g) * 0.42 * walk;
      const lift = Math.max(0, Math.cos(g)) * 0.34 * walk;
      const idle = 0.045 * Math.sin(time * 2.3 + i * 1.7 + ph) * (1 - walk);
      setInst(legs, i, Math.cos(a) * PHAGE_HIP_R, PHAGE_HIP_Y, Math.sin(a) * PHAGE_HIP_R, 0, -(a + swing), lift + idle - 0.3 * stab);
    }
    legs.instanceMatrix.needsUpdate = true;
  });
};

// ═════════════════════════════ BACILLUS BRUTE ═════════════════════════════
const BAC_R = 0.55, BAC_TILT = 0.12, BAC_CY = 0.43, BAC_CX = 0.02;
/** model-space point of a body-local point (body frame: rod centre at origin, axis X) */
function bacToModel(x: number, y: number, z: number): THREE.Vector3 {
  const c = Math.cos(BAC_TILT), s = Math.sin(BAC_TILT);
  return new THREE.Vector3(x * c - y * s + BAC_CX, x * s + y * c + BAC_CY, z);
}

function bacillusBody(v: number): THREE.BufferGeometry {
  return cached(`bacillus:body:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(90 + v, 6, 2.5);
    const g = new THREE.CapsuleGeometry(0.26, 0.62, 8, 16, 8);
    g.rotateZ(Math.PI / 2);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const groove = 1 - 0.075 * (Math.exp(-(((x - 0.15) / 0.035) ** 2)) + Math.exp(-(((x + 0.17) / 0.035) ** 2)));
      const lump = 1 + 0.035 * nz(x * 3, y * 3, z * 3);
      pos.setXYZ(i, x * (1 + 0.02 * nz(y * 4, z * 4, x)), y * groove * lump, z * groove * lump);
    }
    g.computeVertexNormals();
    b.add(g, (p) => {
      const top = clamp01((p.y / 0.26) * 0.5 + 0.5);
      const gran = smooth((nz(p.x * 5 + 3, p.y * 5, p.z * 5) - 0.3) / 0.3);
      return { color: grey(0.5 + 0.45 * top), glow: 0.04 + 0.5 * gran, rim: 1.25, rough: 0.3, wobble: 0.3 };
    });
    // pili: short hairs over the upper flanks
    const rr = rng(120 + v);
    for (let i = 0; i < 34; i++) {
      const x = (rr() - 0.5) * 0.7, ang = (rr() - 0.5) * 2.6;
      const n = new THREE.Vector3(0.15 * (rr() - 0.5), Math.cos(ang), Math.sin(ang)).normalize();
      b.add(cone(0.009, 0.07 + rr() * 0.07, 3), (p) => ({ color: grey(0.8), accent: p.y > 0.3 ? 0.35 : 0, rim: 1.3 }),
        { p: [x, Math.cos(ang) * 0.245, Math.sin(ang) * 0.245], r: alignY(n) });
    }
    // acid pore (mouth) at the front tip
    b.add(torus(0.08, 0.03, 6, 16), { color: lin(0.55, 0.9, 0.35), team: 0.35, accent: 0.55, rim: 0.9, rough: 0.3 }, { p: [0.535, 0, 0], r: [0, Math.PI / 2, 0] });
    b.add(ball(0.072, 10, 7), { color: GREEN, team: 0, accent: 1.5, rim: 0.3, rough: 0.2 }, { p: [0.545, 0, 0], s: [0.45, 1, 1] });
    for (const s of [-1, 1]) {
      b.add(cone(0.024, 0.11, 5), { color: grey(0.55), accent: 0.2, rim: 1.2 }, { p: [0.52, -0.05, 0.1 * s], r: qe(0, -0.35 * s, -1.25, 'XYZ') });
    }
    // two flagella trailing behind: travelling wave in the vertex shader
    for (const s of [-1, 1]) {
      const c = curve([[-0.5, 0.03, 0.07 * s], [-0.74, 0.01, 0.13 * s], [-0.97, -0.03, 0.1 * s], [-1.18, -0.07, 0.17 * s]]);
      b.add(sweep(c, (t) => lerp(0.026, 0.007, t), 5, 18), (p) => ({ color: grey(0.7), accent: 0.15, rim: 1.3, rough: 0.4, whip: clamp01((-p.x - 0.5) / 0.65) }));
    }
    // acid gland hump behind the pore (merged: no extra draw call)
    b.add(blob(0.12, 2, 0.1, 3, 9, [1.2, 0.9, 1]), { color: GREEN, team: 0.2, accent: 0.95, rim: 0.8, rough: 0.2, wobble: 1.2 }, { p: [0.24, 0.235, 0] });
    const geo = b.build();
    geo.rotateZ(BAC_TILT);
    geo.translate(BAC_CX, BAC_CY, 0);
    geo.computeBoundingSphere();
    return geo;
  });
}
const bacLeg = (): THREE.BufferGeometry => cached('bacillus:leg', () =>
  new GeoBuilder().add(sweep(curve([[0, 0, 0], [0.025, -0.1, 0], [0.055, -0.2, 0], [0.06, -0.25, 0]]), (t) => lerp(0.024, 0.01, t), 5, 6),
    { color: grey(0.42), rim: 1.2, rough: 0.5 }).build());

const buildBacillus: ModelBuilder = (ctx) => {
  const v = Math.abs(ctx.seed) % 2, k = sizeK(ctx, BAC_R);
  const rig = new Rig(`model:${ctx.defId}`, ctx.teamColor, false);
  rig.base.scale.setScalar(k);
  const torso = new THREE.Group();
  rig.body.add(torso);
  const bodyM = rig.mesh(bacillusBody(v), torso);
  // 2 × 6 crawling pili-legs under the belly
  const legs = rig.instanced(bacLeg(), 12, rig.body, 'flesh', 1.2);
  const hips: THREE.Vector3[] = [];
  for (let i = 0; i < 12; i++) {
    const side = i < 6 ? 1 : -1, x = -0.33 + (i % 6) * 0.13;
    hips.push(bacToModel(x, -0.2, 0.15 * side));
  }
  const muzzle = bacToModel(0.6, 0, 0).multiplyScalar(k);
  const r = seeded(ctx.seed), ph = r() * TAU;
  let walk = 0, crawl = r() * TAU;
  return unitModel(rig, 0.95 * k, { muzzle }, (st, dt, time) => {
    rig.setVariant(unitVariant(st));
    walk = damp(walk, st.moving ? 1 : 0, 6, dt);
    crawl += dt * Math.max(st.speed, st.moving ? 1 : 0) * 5.5;
    const peri = Math.sin(crawl) * walk;
    const breath = 0.018 * Math.sin(time * 1.6 + ph);
    bodyM.scale.set(1 + 0.05 * peri + breath, 1 - 0.03 * peri - breath * 0.5, 1 - 0.03 * peri - breath * 0.5);
    const atk = attackPulse(st.sinceAttack, 0.3);
    torso.position.set(-0.08 * Math.sin(atk * Math.PI) , 0.015 * Math.abs(Math.sin(crawl)) * walk, 0);
    torso.rotation.z = 0.06 * atk;
    for (let i = 0; i < 12; i++) {
      const h = hips[i]!, side = i < 6 ? 1 : -1;
      const swing = 0.4 * Math.sin(crawl * 1.6 - (i % 6) * 0.9) * walk + 0.05 * Math.sin(time * 2 + i) * (1 - walk);
      setInst(legs, i, h.x, h.y, h.z, -0.32 * side, 0, swing, 1, h.y / 0.25, 1);
    }
    legs.instanceMatrix.needsUpdate = true;
  });
};

// ═════════════════════════════ SPIROCHETE LASHER ═════════════════════════════
const SPIRO_R = 0.42, SPIRO_Y = 0.36;

function spiroCoil(v: number): THREE.BufferGeometry {
  return cached(`spiro:coil:${v}`, () => {
    const b = new GeoBuilder();
    const turns = 3.4 + v * 0.3, N = 130, L = 1.1, x0 = -0.55;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, a = t * turns * TAU;
      const R = 0.135 * smooth(t / 0.12) * (1 - smooth((t - 0.86) / 0.14)) + 0.012;
      pts.push(new THREE.Vector3(x0 + t * L, R * Math.cos(a), R * Math.sin(a)));
    }
    b.add(sweep(pts, (t) => 0.07 * (0.3 + 0.7 * Math.pow(Math.sin(Math.PI * clamp01(t * 0.9 + 0.06)), 0.5)), 7),
      (p) => { const band = 0.5 + 0.5 * Math.sin((p.x - x0) * 34); return { color: grey(0.5 + 0.45 * band), glow: 0.2, rim: 1.35, rough: 0.3, wobble: 0.2 }; });
    // glowing axial filament (it's what makes the lash whip)
    b.add(cyl(0.024, 0.024, 1.04, 6), { color: GREEN, team: 0, accent: 1.15, rim: 0.3 }, { r: [0, 0, -Math.PI / 2], p: [-0.52, 0, 0] });
    // head + hooked barb
    b.add(blob(0.088, 2, 0.08, 3, 7 + v, [1.5, 1, 1]), { color: grey(0.95), glow: 0.5, rim: 1.3, rough: 0.3 }, { p: [0.56, 0, 0] });
    b.add(cone(0.046, 0.19, 6), { color: GREEN, team: 0.2, accent: 1.2, rim: 0.6 }, { r: [0, 0, -Math.PI / 2 + 0.25], p: [0.64, 0.01, 0] });
    for (const z of [-0.05, 0.05]) b.add(ball(0.022, 6, 4), { color: grey(1), team: 0.1, glow: 1.5, rim: 0.2 }, { p: [0.6, 0.045, z] });
    return b.build();
  });
}

const buildSpirochete: ModelBuilder = (ctx) => {
  const v = Math.abs(ctx.seed) % 2, k = sizeK(ctx, SPIRO_R);
  const rig = new Rig(`model:${ctx.defId}`, ctx.teamColor, false);
  rig.base.scale.setScalar(k);
  const coilG = new THREE.Group();
  coilG.position.y = SPIRO_Y;
  rig.body.add(coilG);
  rig.mesh(spiroCoil(v), coilG);
  const r = seeded(ctx.seed), ph = r() * TAU;
  let walk = 0, spin = r() * TAU, slither = r() * TAU;
  return unitModel(rig, 0.62 * k, {}, (st, dt, time) => {
    rig.setVariant(unitVariant(st));
    walk = damp(walk, st.moving ? 1 : 0, 5, dt);
    // screw motion: the corkscrew spins about its long axis in proportion to ground speed
    spin += dt * (1.1 + st.speed * 7.5);
    slither += dt * (2 + 6 * walk);
    const atk = attackPulse(st.sinceAttack, 0.3);
    const lash = Math.sin(atk * Math.PI);
    coilG.rotation.set(spin, 0.14 * Math.sin(slither) * walk + 0.55 * Math.sin(atk * TAU) * atk, 0.05 * Math.sin(time * 1.4 + ph));
    coilG.position.set(0.18 * lash, SPIRO_Y + 0.035 * Math.sin(time * 2.2 + ph), 0.045 * Math.sin(slither + 1) * walk);
    coilG.scale.set(1 + 0.22 * lash, 1 - 0.08 * lash, 1 - 0.08 * lash);
  });
};

// ═════════════════════════════ FUNGAL MORTAR ═════════════════════════════
const MORTAR_R = 0.75, MORTAR_BULB_Y = 0.9, MORTAR_TILT = 0.5;

function mushroom(r: number, seed: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const h = r * 0.9;
  b.add(cyl(r * 0.24, r * 0.34, h, 6), { color: lin(1, 0.9, 0.95), team: 0.35, rim: 0.8, rough: 0.7 });
  b.add(new THREE.SphereGeometry(r, 12, 5, 0, TAU, 0, Math.PI / 2), (p) => ({ color: grey(0.75 + 0.25 * clamp01((p.y - h) / (r * 0.5))), glow: 0.15, rim: 1.2, rough: 0.6, wobble: 0.3 }),
    { p: [0, h, 0], s: [1, 0.55, 1] });
  b.add(new THREE.CircleGeometry(r * 0.96, 12), { color: GREEN, team: 0, accent: 0.9, rim: 0.2 }, { p: [0, h + 0.004, 0], r: [Math.PI / 2, 0, 0] });
  void seed;
  return b.build();
}

function mortarMound(v: number): THREE.BufferGeometry {
  return cached(`mortar:mound:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(150 + v, 6, 2.2);
    const mound = flattenBelow(blob(0.66, 4, 0.13, 2.0, 151 + v, [1, 0.7, 0.95]), -0.34);
    b.add(mound, (p) => {
      const up = clamp01((p.y - 0.05) / 0.7);
      const spot = smooth((nz(p.x * 6, p.y * 6, p.z * 6) - 0.42) / 0.16);
      return { color: spot > 0.5 ? lin(1, 0.84, 0.9) : grey(0.4 + 0.55 * up), team: 1 - 0.55 * spot, glow: 0.12, rim: 1.0, rough: 0.72, wobble: 0.35 };
    }, { p: [0, 0.38, 0] });
    b.add(cyl(0.17, 0.25, 0.32, 10), { color: grey(0.62), glow: 0.08, rim: 1, rough: 0.6, wobble: 0.4 }, { p: [0, 0.6, 0] });
    const caps: Array<[number, number]> = [[0.85 * Math.PI, 0.14], [1.32 * Math.PI, 0.17], [0.22 * Math.PI, 0.115], [1.75 * Math.PI, 0.1]];
    caps.forEach(([a, rad], i) => {
      const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      b.addPainted(mushroom(rad, i), { p: [d.x * 0.5, 0.48, d.z * 0.47], r: alignY(new THREE.Vector3(d.x * 0.8, 1, d.z * 0.8)) });
    });
    const rr = rng(160 + v);
    for (let i = 0; i < 7; i++) {
      const a = rr() * TAU, y = 0.25 + rr() * 0.35;
      const rad = 0.62 * Math.sqrt(Math.max(0.05, 1 - ((y - 0.38) / 0.46) ** 2));
      b.add(ball(0.045 + rr() * 0.03, 7, 5), { color: GREEN, team: 0, accent: 1.1, rim: 0.4, rough: 0.25 }, { p: [Math.cos(a) * rad, y, Math.sin(a) * rad] });
    }
    return b.build();
  });
}
function mortarBulb(v: number): THREE.BufferGeometry {
  return cached(`mortar:bulb:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(170 + v, 5, 3);
    b.add(blob(0.34, 3, 0.06, 2.5, 171 + v, [1, 1.12, 1]), (p) => {
      const vein = smooth((1 - Math.abs(nz(p.x * 5, p.y * 5, p.z * 5)) - 0.84) / 0.1);
      return { color: grey(0.88), glow: 0.12 + 0.3 * (1 - clamp01(p.y / 0.75)), accent: 0.6 * vein, rim: 1.3, rough: 0.35, wobble: 0.6 };
    }, { p: [0, 0.34, 0] });
    const d = new THREE.Vector3(Math.sin(MORTAR_TILT), Math.cos(MORTAR_TILT), 0);
    const c = new THREE.Vector3(0, 0.34, 0);
    const q = alignY(d);
    b.add(torus(0.125, 0.05, 7, 18), { color: grey(0.6), accent: 0.3, rim: 1, rough: 0.5 }, { p: c.clone().addScaledVector(d, 0.355), r: q.clone().multiply(qe(Math.PI / 2, 0, 0)) });
    b.add(ball(0.11, 10, 7), { color: GREEN, team: 0, accent: 1.5, rim: 0.2, rough: 0.2 }, { p: c.clone().addScaledVector(d, 0.34), r: q, s: [1, 0.4, 1] });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      const off = new THREE.Vector3(Math.cos(a) * 0.14, 0, Math.sin(a) * 0.14).applyQuaternion(q);
      b.add(ball(0.03, 6, 4), { color: GREEN, team: 0, accent: 1.2 }, { p: c.clone().addScaledVector(d, 0.39).add(off) });
    }
    return b.build();
  });
}
const mortarFoot = (): THREE.BufferGeometry => cached('mortar:foot', () =>
  new GeoBuilder().add(sweep(curve([[0, 0, 0], [0.1, -0.06, 0], [0.17, -0.12, 0], [0.21, -0.165, 0]]), (t) => lerp(0.1, 0.045, t), 6, 6),
    { color: grey(0.46), rim: 1, rough: 0.75, wobble: 0.2 }).build());

const buildFungalMortar: ModelBuilder = (ctx) => {
  const v = Math.abs(ctx.seed) % 2, k = sizeK(ctx, MORTAR_R);
  const rig = new Rig(`model:${ctx.defId}`, ctx.teamColor, false);
  rig.base.scale.setScalar(k);
  const torso = new THREE.Group();
  rig.body.add(torso);
  rig.mesh(mortarMound(v), torso);
  const bulbG = new THREE.Group();
  bulbG.position.y = MORTAR_BULB_Y;
  torso.add(bulbG);
  const bulb = rig.mesh(mortarBulb(v), bulbG);
  const feet = rig.instanced(mortarFoot(), 4, rig.body, 'flesh', 1.2);
  const muzzle = new THREE.Vector3(Math.sin(MORTAR_TILT) * 0.4, MORTAR_BULB_Y + 0.34 + Math.cos(MORTAR_TILT) * 0.4, 0).multiplyScalar(k);
  const r = seeded(ctx.seed), ph = r() * TAU;
  let walk = 0, gait = r() * TAU;
  return unitModel(rig, 1.68 * k, { muzzle }, (st, dt, time) => {
    rig.setVariant(unitVariant(st));
    walk = damp(walk, st.moving ? 1 : 0, 4, dt);
    gait += dt * Math.max(st.speed, st.moving ? 0.8 : 0) * 4.6;
    torso.rotation.set(0.075 * Math.sin(gait) * walk, 0, -0.05 * walk + 0.02 * Math.sin(time * 0.9 + ph));
    torso.position.y = 0.035 * Math.abs(Math.sin(gait)) * walk;
    // launcher bulb: swells while reloading, springs up on release
    const since = st.sinceAttack;
    const charge = isFinite(since) ? 0.86 + 0.14 * easeOut(clamp01(since / 2.6)) : 1;
    const kick = boing(since, 13, 6);
    const breath = 0.03 * Math.sin(time * 1.7 + ph);
    bulbG.scale.set(charge * (1 - 0.2 * kick + breath), charge * (1 + 0.35 * kick - breath * 0.5), charge * (1 - 0.2 * kick + breath));
    bulb.rotation.y = 0.15 * Math.sin(time * 0.6 + ph);
    for (let i = 0; i < 4; i++) {
      const a = ((i + 0.5) / 4) * TAU;
      const step = Math.sin(gait + i * (Math.PI / 2)) * walk;
      setInst(feet, i, Math.cos(a) * 0.4, 0.165, Math.sin(a) * 0.4, 0, -a + 0.3 * step, Math.max(0, step) * 0.35);
    }
    feet.instanceMatrix.needsUpdate = true;
  });
};

// ═════════════════════════════ SUPERBUG ═════════════════════════════
const SB_R = 1.05, SB_TORSO_Y = 0.95;
/** fused cocci of the colony (torso-local): x, y, z, radius */
const SB_SPHERES: Array<[number, number, number, number]> = [
  [0.12, 0.0, 0, 0.62], [-0.42, -0.08, 0.3, 0.5], [-0.42, -0.08, -0.3, 0.5], [0.5, -0.15, 0.34, 0.42],
  [0.5, -0.15, -0.34, 0.42], [-0.12, 0.36, 0, 0.45], [-0.78, 0.04, 0, 0.36],
];
function sbInside(p: THREE.Vector3, skip: number, slack = 0.9): boolean {
  return SB_SPHERES.some(([x, y, z, r], j) => j !== skip && p.distanceTo(new THREE.Vector3(x, y, z)) < r * slack);
}
function sbTop(x: number): number {
  let top = 0;
  for (const [cx, cy, cz, r] of SB_SPHERES) { const d2 = r * r - (x - cx) ** 2 - cz * cz * 0.3; if (d2 > 0) top = Math.max(top, cy + Math.sqrt(d2)); }
  return top;
}
function superbugCore(v: number): THREE.BufferGeometry {
  return cached(`superbug:core:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(200 + v, 5, 3);
    SB_SPHERES.forEach(([x, y, z, r], i) => {
      b.add(blob(r * 0.95, 3, 0.06, 2.2, 201 + i + v * 7), (p) => {
        const m = 0.5 + 0.5 * nz(p.x * 4, p.y * 4, p.z * 4);
        return { color: lin(0.1 + 0.08 * m, 0.3 + 0.2 * m, 0.05), team: 0.2, accent: 0.5 + 0.6 * m, glow: 0.08, rim: 0.5, rough: 0.3, wobble: 0.7 };
      }, { p: [x, y, z] });
    });
    return b.build();
  });
}
function superbugPlates(v: number): THREE.BufferGeometry {
  return cached(`superbug:plates:${v}`, () => {
    const b = new GeoBuilder();
    const rr = rng(230 + v);
    SB_SPHERES.forEach(([x, y, z, r], i) => {
      const c = new THREE.Vector3(x, y, z);
      const n = Math.round(5 + r * r * 22);
      for (const d of fibonacciSphere(n, 0.5, 240 + i + v * 11)) {
        if (d.y < -0.45) continue;
        const p = c.clone().addScaledVector(d, r * 1.0);
        if (sbInside(p, i, 0.92)) continue;
        const rp = r * (0.62 + rr() * 0.12);
        b.add(blob(rp, 2, 0.05, 2.5, 250 + i * 31 + Math.round(d.x * 100)), (lp) => ({
          color: grey(lp.y > 0 ? 0.55 + 0.25 * (lp.y / (rp * 0.36)) : 0.3), rim: 0.95, rough: 0.26, metal: 0.18,
        }), { p, r: alignY(d), s: [1, 0.36, 1] }, { local: true });
      }
    });
    // dorsal spikes along the ridge, tips glowing
    for (let i = 0; i < 5; i++) {
      const x = -0.62 + i * 0.28;
      b.add(cone(0.085, 0.34 - Math.abs(i - 2) * 0.03, 6), (lp) => ({ color: grey(0.42), accent: lp.y > 0.2 ? 1.1 : 0, rim: 1, rough: 0.35 }),
        { p: [x, sbTop(x) + 0.05, 0], r: [0, 0, 0.45] }, { local: true });
    }
    // battering brow + horns (Crushing Slam)
    b.add(blob(0.44, 2, 0.06, 2, 260 + v), (lp) => ({ color: grey(lp.x > 0 ? 0.5 : 0.3), rim: 1.1, rough: 0.3, metal: 0.15 }),
      { p: [0.86, -0.02, 0], r: [0, 0, -0.25], s: [0.32, 0.8, 1.05] }, { local: true });
    for (const s of [-1, 1]) {
      b.add(cone(0.1, 0.4, 7), (lp) => ({ color: grey(0.55), accent: lp.y > 0.25 ? 1.0 : 0, rim: 1.1, rough: 0.35 }),
        { p: [0.95, 0.16, 0.25 * s], r: alignY(new THREE.Vector3(0.85, 0.55, 0.32 * s)) }, { local: true });
    }
    // glowing eyespots under the brow
    for (const s of [-1, 1]) b.add(ball(0.06, 8, 6), { color: GREEN, team: 0, accent: 1.6, rim: 0.2 }, { p: [0.93, -0.2, 0.2 * s] });
    return b.build();
  });
}
const sbLeg = (): THREE.BufferGeometry => cached('superbug:leg', () => {
  const b = new GeoBuilder();
  b.add(sweep(curve([[0, 0, 0], [0.16, -0.17, 0], [0.26, -0.4, 0], [0.28, -0.56, 0]]), (t) => lerp(0.13, 0.085, t), 7, 8), { color: grey(0.38), rim: 0.9, rough: 0.55, wobble: 0.2 });
  b.add(blob(0.11, 1, 0.1, 2, 3), { color: grey(0.3), rim: 0.8, rough: 0.6 }, { p: [0.29, -0.57, 0], s: [1.25, 0.55, 1.25] });
  return b.build();
});

const buildSuperbug: ModelBuilder = (ctx) => {
  const v = Math.abs(ctx.seed) % 2, k = sizeK(ctx, SB_R);
  const rig = new Rig(`model:${ctx.defId}`, ctx.teamColor, false);
  rig.base.scale.setScalar(k);
  const torso = new THREE.Group();
  torso.position.y = SB_TORSO_Y;
  rig.body.add(torso);
  const core = rig.mesh(superbugCore(v), torso);
  const platesG = new THREE.Group();
  torso.add(platesG);
  rig.mesh(superbugPlates(v), platesG);
  const legs = rig.instanced(sbLeg(), 6, rig.body, 'flesh', 1.8);
  const hips: Array<[number, number, number]> = [];
  for (const s of [1, -1]) for (const x of [0.45, 0, -0.45]) hips.push([x, 0.58, 0.42 * s]);
  const r = seeded(ctx.seed), ph = r() * TAU;
  let walk = 0, gait = r() * TAU;
  return unitModel(rig, 2.05 * k, {}, (st, dt, time) => {
    rig.setVariant(unitVariant(st));
    // badly wounded superbugs "enrage": the glowing cracks flare and pulse faster
    if (st.hpFrac < 0.4 && st.sinceAttack >= 0.13) rig.setPartVariant(core, 'active');
    walk = damp(walk, st.moving ? 1 : 0, 4, dt);
    gait += dt * Math.max(st.speed, st.moving ? 0.8 : 0) * 4.2;
    const slam = attackPulse(st.sinceAttack, 0.5);
    const sl = Math.pow(slam, 1.5);
    torso.rotation.set(0.05 * Math.sin(gait) * walk, 0, -0.03 * walk - 0.24 * sl + 0.03 * Math.sin(gait * 2) * walk);
    torso.position.set(0.08 * sl, SB_TORSO_Y + 0.05 * Math.abs(Math.sin(gait)) * walk - 0.13 * sl, 0);
    torso.scale.set(1 + 0.04 * sl, 1 - 0.08 * sl, 1 + 0.04 * sl);
    const br = 1 + 0.014 * Math.sin(time * 1.3 + ph);
    platesG.scale.set(br, br, br);
    for (let i = 0; i < 6; i++) {
      const [hx, hy, hz] = hips[i]!;
      const g = gait + (i % 2) * Math.PI + (i >= 3 ? Math.PI : 0);
      const yaw = (hz > 0 ? Math.PI / 2 : -Math.PI / 2) - (hz > 0 ? 1 : -1) * hx * 0.6;
      const swing = Math.sin(g) * 0.35 * walk;
      const lift = Math.max(0, Math.cos(g)) * 0.25 * walk;
      setInst(legs, i, hx, hy + 0.04 * Math.abs(Math.sin(gait)) * walk - 0.1 * sl, hz, 0, -(yaw + swing * (hz > 0 ? 1 : -1)), lift - 0.2 * sl);
    }
    legs.instanceMatrix.needsUpdate = true;
  });
};

// ═════════════════════════════ INFLUENZA DRIFTER (air) ═════════════════════════════
const FLU_R = 0.6, FLU_FLY = 3.0;
const FLU_VIRIONS: Array<[number, number, number, number]> = [
  [0, 0.05, 0, 0.25], [0.28, -0.04, 0.13, 0.165], [-0.2, 0.0, 0.23, 0.175], [-0.13, -0.05, -0.27, 0.155], [0.14, 0.14, -0.21, 0.13],
];
function fluSpike(green: boolean): THREE.BufferGeometry {
  return cached(`flu:spike:${green ? 1 : 0}`, () => {
    const b = new GeoBuilder();
    b.add(cyl(0.011, 0.014, 0.08, 4), { color: grey(0.7), rim: 0.8, rough: 0.4 });
    if (green) b.add(ball(0.027, 6, 4), { color: GREEN, team: 0, accent: 1.1, rim: 0.3 }, { p: [0, 0.085, 0] });
    else b.add(ball(0.03, 6, 4), { color: grey(1), glow: 0.9, rim: 0.8 }, { p: [0, 0.08, 0], s: [1.3, 0.6, 1.3] });
    return b.build();
  });
}
function fluCluster(v: number): THREE.BufferGeometry {
  return cached(`flu:cluster:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(300 + v, 4, 3);
    FLU_VIRIONS.forEach(([x, y, z, r], i) => {
      const c = new THREE.Vector3(x, y, z);
      b.add(blob(r, 3, 0.04, 2.5, 301 + i), (p) => ({ color: grey(0.8 + 0.2 * nz(p.x * 5, p.y * 5, p.z * 5)), glow: 0.28, rim: 1.25, rough: 0.35, wobble: 0.3 }), { p: c });
      const n = Math.round(560 * r * r);
      fibonacciSphere(n, 0.4, 310 + i + v * 5).forEach((d, j) => {
        const root = c.clone().addScaledVector(d, r * 0.94);
        if (FLU_VIRIONS.some(([ox, oy, oz, orr], o) => o !== i && root.distanceTo(new THREE.Vector3(ox, oy, oz)) < orr * 1.05)) return;
        b.addPainted(fluSpike(j % 3 === 0), { p: root, r: alignY(d) });
      });
    });
    // hanging tendrils (wave in the shader)
    const rr = rng(330 + v);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + rr() * 0.4, rad = 0.1 + rr() * 0.12;
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      const c = curve([[x, -0.12, z], [x * 1.2 + 0.03, -0.3, z * 1.2], [x * 1.1 - 0.03, -0.48, z * 1.3], [x * 1.3, -0.66 - rr() * 0.1, z * 1.4]]);
      b.add(sweep(c, (t) => lerp(0.02, 0.005, t), 4, 10), (p) => ({ color: grey(0.75), accent: p.y < -0.5 ? 0.6 : 0.05, rim: 1.2, whip: -clamp01((-p.y - 0.12) / 0.5) }));
    }
    return b.build();
  });
}
const fluMist = (v: number): THREE.BufferGeometry => cached(`flu:mist:${v}`, () =>
  new GeoBuilder().add(blob(0.47, 3, 0.14, 2, 340 + v, [1.1, 0.85, 1.1]), { color: grey(1), glow: 0.2, rim: 1.6, rough: 0.3, wobble: 1.3 }).build());

/** flyer death: tumble down from flight altitude, splat on the ground, melt away */
function flyerDeathPose(body: THREE.Object3D, t: number, fly: number): void {
  const fall = clamp01(t / 0.42);
  const ground = -fly + 0.12;
  if (t < 0.42) {
    const s = 1 + 0.18 * Math.sin(fall * Math.PI);
    body.scale.set(s, s, s);
    body.position.set(0, ground * easeIn(fall), 0);
    body.rotation.set(fall * 2.2, 0, fall * 1.4);
  } else {
    const k = (t - 0.42) / 0.58;
    const sx = lerp(1.45, 0.05, easeIn(k)), sy = lerp(0.3, 0.02, k);
    body.scale.set(sx, sy, sx);
    body.position.set(0, ground, 0);
    body.rotation.set(0, 0, 0);
  }
}

const buildFluDrifter: ModelBuilder = (ctx) => {
  const v = Math.abs(ctx.seed) % 2, k = sizeK(ctx, FLU_R);
  const rig = new Rig(`model:${ctx.defId}`, ctx.teamColor, false);
  rig.base.scale.setScalar(k);
  const hover = new THREE.Group();
  rig.body.add(hover);
  const cluster = new THREE.Group();
  hover.add(cluster);
  rig.mesh(fluCluster(v), cluster);
  const mist = rig.mesh(fluMist(v), hover, 'glass');
  mist.renderOrder = 2;
  const muzzle = new THREE.Vector3(0.12, -0.25, 0).multiplyScalar(k);
  const fly = (tryGetDef(ctx.defId) as UnitDef | undefined)?.flyHeight ?? FLU_FLY;
  const r = seeded(ctx.seed), ph = r() * TAU;
  let walk = 0, spin = r() * TAU;
  return unitModel(rig, 0.62 * k, { muzzle, death: (t) => flyerDeathPose(rig.body, t, fly / k) }, (st, dt, time) => {
    rig.setVariant(unitVariant(st));
    walk = damp(walk, st.moving ? 1 : 0, 3, dt);
    spin += dt * (0.45 + 0.7 * walk);
    const atk = attackPulse(st.sinceAttack, 0.3);
    hover.position.set(0, 0.09 * Math.sin(time * 1.3 + ph) + 0.08 * Math.sin(atk * Math.PI), 0);
    hover.rotation.set(0, 0, -0.18 * walk);
    cluster.rotation.set(0.12 * Math.sin(time * 0.7 + ph), spin, 0.1 * Math.sin(time * 0.9 + ph));
    const cs = 1 + 0.15 * atk;
    cluster.scale.set(cs, cs, cs);
    const ms = 1 + 0.045 * Math.sin(time * 2.1 + ph) + 0.12 * atk;
    mist.scale.set(ms, ms * 0.96, ms);
    mist.rotation.y = -spin * 0.4;
  });
};

export const UNIT_MODELS: Record<string, ModelBuilder> = {
  path_spore_drone: buildSporeDrone,
  path_phage: buildPhage,
  path_bacillus: buildBacillus,
  path_spirochete: buildSpirochete,
  path_fungal_mortar: buildFungalMortar,
  path_superbug: buildSuperbug,
  path_flu_drifter: buildFluDrifter,
};
