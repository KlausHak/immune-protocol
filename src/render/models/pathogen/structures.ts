/**
 * [models-pathogen] Colony structures. Each fills its footprint (w along X × h along Z) and sits on a
 * glossy "creep" splat of contaminated tissue. Shared behaviour (see rig.ts): breathing (faster while
 * producing), growth from a small blob during construction, deflate-and-sink death.
 * Structure materials are fog-of-war patched (getPalette(team, fog = true)).
 */
import * as THREE from 'three';
import type { BuildingDef } from '../../../core/types';
import { tryGetDef } from '../../../data';
import type { EntityModel, ModelAnimState, ModelBuildContext, ModelBuilder } from '../types';
import { GeoBuilder, alignY, ball, blob, cached, cone, curve, cyl, fibonacciSphere, flattenBelow, lathe, noise3, prep, rng, splat, sweep, torus } from './geom';
import {
  Rig, TAU, attackPulse, boing, breathe, clamp01, constructionPose, damp, dampAngle, easeOut, lerp, seeded, setInst, smooth,
  structureDeathPose, structureVariant, wrapAngle,
} from './rig';
import { GREEN, grey, lin, qe } from './units';

// ───────────────────────────── shared pieces ─────────────────────────────

/** Ground creep splat covering (and spilling past) the footprint; glossy goo with glowing veins. */
function creepGeo(w: number, h: number, v: number): THREE.BufferGeometry {
  return cached(`creep:${w}x${h}:${v}`, () => {
    const nz = noise3(500 + v * 13 + w * 7, 5, 1.6 / Math.max(1, Math.min(w, h) * 0.35));
    const g = splat(w * 0.64, h * 0.64, 40, 0.28, 510 + v + w, 5);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const e = Math.hypot(x / (w * 0.64), z / (h * 0.64));
      pos.setY(i, 0.04 * (1 - smooth(e)) + 0.008);
    }
    g.computeVertexNormals();
    return new GeoBuilder().add(g, (p) => {
      const vein = smooth((1 - Math.abs(nz(p.x, 0.3, p.z)) - 0.9) / 0.07);
      const e = Math.hypot(p.x / (w * 0.64), p.z / (h * 0.64));
      return { color: grey(0.32 + 0.2 * (1 - e)), accent: 0.55 * vein * (1 - e * 0.6), glow: 0.04, rim: 0.12, rough: 0.16 };
    }).build();
  });
}
const germGeo = (): THREE.BufferGeometry => cached('struct:germ', () =>
  new GeoBuilder().add(blob(0.5, 3, 0.2, 2.2, 520), (p) => ({ color: grey(0.7), glow: 0.45, accent: p.y > 0.3 ? 0.3 : 0, rim: 1.3, rough: 0.3, wobble: 1.6 }), { p: [0, 0.22, 0], s: [1, 0.75, 1] }).build());

/** Root tendrils spreading from a base towards the footprint corners/edges. */
function addRoots(b: GeoBuilder, w: number, h: number, count: number, y0: number, thick: number, seed: number): void {
  const rr = rng(seed);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + rr() * 0.5;
    const ex = Math.cos(a) * w * 0.5 * (0.85 + rr() * 0.2), ez = Math.sin(a) * h * 0.5 * (0.85 + rr() * 0.2);
    const sx = ex * 0.3, sz = ez * 0.3;
    const c = curve([[sx, y0, sz], [ex * 0.6, y0 * 0.75 + 0.05, ez * 0.6], [ex * 0.88, 0.07, ez * 0.88], [ex, 0.02, ez]]);
    b.add(sweep(c, (t) => lerp(thick, thick * 0.25, t), 6, 10), (p) => ({ color: grey(0.38), accent: p.y < 0.08 ? 0.25 : 0, rim: 0.8, rough: 0.5 }));
  }
}

interface StructParts { rig: Rig; creep: THREE.Mesh; germ: THREE.Mesh; fp: { w: number; h: number }; v: number; ph: number; rnd: () => number }

function structureParts(ctx: ModelBuildContext, nominal: { w: number; h: number }, variants: number): StructParts {
  const def = tryGetDef(ctx.defId) as BuildingDef | undefined;
  const fp = ctx.footprint ?? def?.footprint ?? nominal;
  const rig = new Rig(`model:${ctx.defId}`, ctx.teamColor, true);
  // normalise if the footprint ever differs from the nominal design size
  const kx = fp.w / nominal.w, kz = fp.h / nominal.h;
  rig.base.scale.set(kx, Math.min(kx, kz), kz);
  const v = Math.abs(ctx.seed) % variants;
  const creep = rig.mesh(creepGeo(nominal.w, nominal.h, v), rig.base);
  creep.rotation.y = (Math.abs(ctx.seed) % 4) * (Math.PI / 2);
  const germ = rig.mesh(germGeo(), rig.body);
  germ.visible = false;
  const rnd = seeded(ctx.seed);
  return { rig, creep, germ, fp, v, ph: rnd() * TAU, rnd };
}

/**
 * Standard structure update wrapper. `animate(st, dt, time, alive)` runs for alive structures (also during
 * construction, with `c` < 1) and does the model-specific part animation.
 */
function structureModel(sp: StructParts, height: number, germSize: number, opts: { muzzle?: THREE.Vector3 },
  animate: (st: ModelAnimState, dt: number, time: number, c: number) => void): EntityModel {
  const { rig, creep, germ, ph } = sp;
  return {
    root: rig.root,
    height: height * rig.base.scale.y,
    muzzle: opts.muzzle,
    handlesDeath: true,
    update(st, dtRaw, time) {
      if (!rig.root.visible && st.death <= 0) return;
      const dt = Math.min(Math.max(dtRaw, 0), 0.1);
      rig.setVariant(structureVariant(st));
      if (st.death > 0) {
        const t = Math.min(1, st.death);
        germ.visible = false;
        structureDeathPose(rig.body, t, height, time);
        const cs = 1 - 0.35 * smooth(t);
        creep.scale.set(cs, 1, cs);
        return;
      }
      const c = clamp01(st.construction);
      if (c < 1) {
        constructionPose(rig.body, c, time, ph, germ, germSize);
        const cs = 0.3 + 0.7 * easeOut(c);
        creep.scale.set(cs, 1, cs);
      } else {
        germ.visible = false;
        creep.scale.set(1, 1, 1);
        breathe(rig.body, time, ph, st.producing);
      }
      animate(st, dt, time, c);
    },
    dispose: () => rig.dispose(),
  };
}

/** Lub-dub heartbeat pulse in 0..1. */
const heartbeat = (t: number): number => {
  const a = Math.max(0, Math.sin(t)), b = Math.max(0, Math.sin(t - 0.55));
  return Math.pow(a, 10) + 0.6 * Math.pow(b, 10);
};

// ═════════════════════════════ INFECTION CORE (hive, 5×5) ═════════════════════════════
const HIVE_VENTS: Array<[number, number, number]> = [[-1.35, 1.05, -1.15], [1.25, 1.0, -1.25], [-1.25, 0.95, 1.35]]; // vent mouths base points (x, y, z)

function hiveMound(v: number): THREE.BufferGeometry {
  return cached(`hive:mound:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(600 + v, 6, 1.2);
    const paintFlesh = (p: THREE.Vector3) => {
      const up = clamp01(p.y / 3.2);
      const vein = smooth((1 - Math.abs(nz(p.x * 0.9, p.y * 0.9, p.z * 0.9)) - 0.88) / 0.07);
      return { color: grey(0.42 + 0.45 * up), accent: 0.7 * vein, glow: 0.1 + 0.2 * up, rim: 1.1, rough: 0.42, wobble: 0.5 };
    };
    b.add(flattenBelow(blob(2.1, 5, 0.12, 1.3, 601 + v, [1.15, 0.55, 1.15]), -0.12), paintFlesh, { p: [0, 0.15, 0] });
    // corner lobes so the silhouette fills the square footprint
    const lobes: Array<[number, number, number]> = [[1.55, 1.5, 0.75], [-1.6, 1.45, 0.8], [1.5, -1.6, 0.72], [-1.55, -1.5, 0.78]];
    lobes.forEach(([x, z, r], i) => b.add(flattenBelow(blob(r, 3, 0.15, 1.8, 610 + i + v), -r * 0.5), paintFlesh, { p: [x, r * 0.45, z], s: [1, 0.8, 1] }));
    // central column
    b.add(blob(1.25, 4, 0.1, 1.5, 620 + v, [1, 1.15, 1]), paintFlesh, { p: [0, 2.05, 0] });
    // draped veins from the column to the ground
    const rr = rng(630 + v);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + rr() * 0.3;
      const c = Math.cos(a), s = Math.sin(a);
      const k = 1 + rr() * 0.12;
      const pts = curve([[c * 0.9, 2.7, s * 0.9], [c * 1.35 * k, 1.9, s * 1.35 * k], [c * 2.05 * k, 1.05, s * 2.05 * k], [c * 2.45 * k, 0.35, s * 2.45 * k], [c * 2.6 * k, 0.03, s * 2.6 * k]]);
      b.add(sweep(pts, (t) => lerp(0.13, 0.07, t), 6, 16), { color: lin(0.35, 0.9, 0.25), team: 0.15, accent: 0.85, rim: 0.6, rough: 0.3, wobble: 0.3 });
    }
    // vents: organic chimneys with glowing throats
    for (const [x, y, z] of HIVE_VENTS) {
      const d = new THREE.Vector3(x * 0.35, 1, z * 0.35).normalize();
      const vent = new GeoBuilder();
      vent.add(lathe([[0.42, 0], [0.36, 0.3], [0.27, 0.62], [0.32, 0.82], [0.4, 0.9], [0.3, 0.92], [0.22, 0.75], [0.16, 0.5], [0, 0.45]], 14),
        (p) => ({ color: grey(0.48), accent: p.y > 0.6 && Math.hypot(p.x, p.z) < 0.3 ? 1.2 : 0, glow: 0.1, rim: 1, rough: 0.45 }), undefined, { local: true });
      b.addPainted(vent.build(), { p: [x, y - 0.25, z], r: alignY(d) });
    }
    // drop-off maw at the front (workers deliver Biomass here)
    b.add(torus(0.55, 0.16, 8, 22), { color: grey(0.5), accent: 0.35, rim: 1, rough: 0.4 }, { p: [2.05, 0.55, 0], r: [0, Math.PI / 2, 0.35], s: [1, 0.75, 1] });
    b.add(ball(0.52, 12, 8), { color: GREEN, team: 0, accent: 1.1, glow: 0, rim: 0.2, rough: 0.2 }, { p: [1.98, 0.55, 0], r: [0, 0, 0.35], s: [0.3, 0.72, 0.95] });
    // crown horns around the heart
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + 0.2;
      const c = Math.cos(a), s = Math.sin(a);
      const pts = curve([[c * 0.85, 2.9, s * 0.85], [c * 1.15, 3.6, s * 1.15], [c * 1.2, 4.3, s * 1.2], [c * 0.95, 4.85, s * 0.95]]);
      b.add(sweep(pts, (t) => lerp(0.16, 0.02, t), 6, 12), (p) => ({ color: grey(0.5), accent: p.y > 4.4 ? 1 : 0, rim: 1.2, rough: 0.35 }));
    }
    return b.build();
  });
}
const hiveHeart = (v: number): THREE.BufferGeometry => cached(`hive:heart:${v}`, () => {
  const nz = noise3(640 + v, 5, 2.4);
  return new GeoBuilder().add(blob(0.95, 4, 0.08, 2, 641 + v, [1, 1.08, 1]), (p) => {
    const vein = smooth((1 - Math.abs(nz(p.x, p.y, p.z)) - 0.86) / 0.08);
    return { color: grey(0.85), glow: 0.75, accent: 0.6 * vein, rim: 1.4, rough: 0.3, wobble: 0.8 };
  }).build();
});
const puffGeo = (): THREE.BufferGeometry => cached('struct:puff', () =>
  new GeoBuilder().add(blob(0.3, 2, 0.18, 2.5, 650), { color: lin(0.6, 1, 0.45), team: 0.2, accent: 0.55, rim: 1.4, rough: 0.5, wobble: 1 }).build());

const buildHive: ModelBuilder = (ctx) => {
  const sp = structureParts(ctx, { w: 5, h: 5 }, 2);
  const { rig, v, ph } = sp;
  rig.mesh(hiveMound(v));
  const heartG = new THREE.Group();
  heartG.position.set(0, 3.55, 0);
  rig.body.add(heartG);
  rig.mesh(hiveHeart(v), heartG);
  const PUFFS = 3;
  const puffs = rig.instanced(puffGeo(), HIVE_VENTS.length * PUFFS, rig.body, 'glass', 7);
  const mouths = HIVE_VENTS.map(([x, y, z]) => {
    const d = new THREE.Vector3(x * 0.35, 1, z * 0.35).normalize();
    return { p: new THREE.Vector3(x, y - 0.25, z).addScaledVector(d, 0.9), d };
  });
  let beat = sp.rnd() * TAU, puffT = sp.rnd() * 10;
  return structureModel(sp, 5.0, 2.2, {}, (st, dt, time, c) => {
    const rate = st.producing ? 2.4 : 1.1;
    beat += dt * rate * TAU * 0.5;
    const hb = heartbeat(beat);
    const s = 1 + 0.07 * hb + 0.015 * Math.sin(time * 0.8 + ph);
    heartG.scale.set(s, s * (1 - 0.02 * hb), s);
    puffT += dt * (st.producing ? 0.75 : 0.42) * (c < 1 ? 0.3 : 1);
    let i = 0;
    for (const m of mouths) for (let k = 0; k < PUFFS; k++, i++) {
      const u = (puffT + k / PUFFS + i * 0.13) % 1;
      const sc = (0.25 + 0.9 * u) * Math.sqrt(1 - u) * (c < 1 ? c : 1);
      setInst(puffs, i, m.p.x + m.d.x * u * 1.3, m.p.y + u * 1.6, m.p.z + m.d.z * u * 1.3, u * 2, i, 0, sc);
    }
    puffs.instanceMatrix.needsUpdate = true;
  });
};

// ═════════════════════════════ SPORE NEST (2×2) ═════════════════════════════
const NEST_SACS: Array<[number, number, number, number]> = [
  [-0.4, 0.68, -0.3, 0.4], [0.42, 0.62, -0.32, 0.36], [0.05, 0.66, 0.42, 0.38], [0.0, 1.35, -0.05, 0.42], [-0.45, 0.55, 0.45, 0.27],
];
function nestBase(v: number): THREE.BufferGeometry {
  return cached(`nest:base:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(700 + v, 5, 2.5);
    b.add(flattenBelow(blob(0.82, 3, 0.16, 2.2, 701 + v, [1.15, 0.42, 1.15]), -0.12), (p) => ({
      color: grey(0.42 + 0.3 * clamp01(p.y / 0.5)), accent: 0.5 * smooth((1 - Math.abs(nz(p.x * 2, p.y * 2, p.z * 2)) - 0.85) / 0.1), glow: 0.08, rim: 1, rough: 0.5, wobble: 0.4,
    }), { p: [0, 0.14, 0] });
    addRoots(b, 2, 2, 6, 0.3, 0.09, 702 + v);
    // stalks holding each sac
    for (const [x, y, z, r] of NEST_SACS) {
      const pts = curve([[x * 0.4, 0.3, z * 0.4], [x * 0.8, (y - r) * 0.7 + 0.15, z * 0.8], [x, y - r * 0.85, z]]);
      b.add(sweep(pts, (t) => lerp(0.08, 0.05, t), 6, 8), { color: grey(0.5), accent: 0.2, rim: 1, rough: 0.45 });
    }
    // little pustules on the base
    const rr = rng(710 + v);
    for (let i = 0; i < 6; i++) {
      const a = rr() * TAU, rad = 0.55 + rr() * 0.3;
      b.add(ball(0.05 + rr() * 0.03, 7, 5), { color: GREEN, team: 0, accent: 1.1, rim: 0.4 }, { p: [Math.cos(a) * rad, 0.26 - rad * 0.15, Math.sin(a) * rad] });
    }
    return b.build();
  });
}
const sacGeo = (): THREE.BufferGeometry => cached('nest:sac', () =>
  new GeoBuilder().add(blob(1, 3, 0.06, 2, 720, [1, 1.22, 1]), (p) => ({ color: grey(1), glow: 0.25, accent: p.y > 1.05 ? 0.35 : 0, rim: 1.7, rough: 0.15, wobble: 0.5 })).build());
const embryoGeo = (): THREE.BufferGeometry => cached('nest:embryo', () => {
  const b = new GeoBuilder();
  const c = curve([[0.25, 0.1, 0], [0.05, 0.3, 0.05], [-0.25, 0.1, 0.02], [-0.15, -0.25, -0.05], [0.12, -0.2, 0]]);
  b.add(sweep(c, (t) => 0.17 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05)) + 0.04, 8, 16), { color: grey(1), glow: 1.0, rim: 0.6, rough: 0.3 });
  b.add(ball(0.08, 8, 6), { color: GREEN, team: 0, accent: 1.3, rim: 0.2 }, { p: [0.24, 0.12, 0.08] });
  return b.build();
});

const buildNest: ModelBuilder = (ctx) => {
  const sp = structureParts(ctx, { w: 2, h: 2 }, 2);
  const { rig, v } = sp;
  rig.mesh(nestBase(v));
  const embryos = rig.instanced(embryoGeo(), NEST_SACS.length, rig.body, 'flesh', 3);
  const sacs = rig.instanced(sacGeo(), NEST_SACS.length, rig.body, 'glass', 3);
  sacs.renderOrder = 2;
  const phases = NEST_SACS.map(() => sp.rnd() * TAU);
  return structureModel(sp, 2.25, 0.95, {}, (_st, _dt, time) => {
    NEST_SACS.forEach(([x, y, z, r], i) => {
      const th = Math.sin(time * 1.6 + phases[i]!);
      const s = r * (1 + 0.06 * th);
      setInst(sacs, i, x, y, z, 0, phases[i]!, 0, s, s * (1 - 0.03 * th), s);
      const es = r * 0.55;
      setInst(embryos, i, x, y + r * 0.05, z, 0.2 * Math.sin(time * 0.9 + i), phases[i]! + time * 0.25, 0.15 * Math.sin(time * 1.3 + i * 2), es);
    });
    sacs.instanceMatrix.needsUpdate = true;
    embryos.instanceMatrix.needsUpdate = true;
  });
};

// ═════════════════════════════ FERMENTATION VAT (2×2) ═════════════════════════════
const VAT_LIQUID_Y = 0.98;
function vatGeo(v: number): THREE.BufferGeometry {
  return cached(`vat:body:${v}`, () => {
    const b = new GeoBuilder();
    const g = lathe([[0.5, 0], [0.74, 0.08], [0.86, 0.38], [0.86, 0.74], [0.79, 0.98], [0.84, 1.08], [0.78, 1.15], [0.7, 1.08], [0.66, 0.92], [0.0, 0.92]], 28);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const r = Math.hypot(x, z);
      if (r < 0.01 || y > 1.0) continue;
      const a = Math.atan2(z, x);
      const k = 1 + 0.05 * Math.cos(a * 8) * smooth(y / 0.3) * (1 - smooth((y - 0.85) / 0.12));
      pos.setX(i, x * k); pos.setZ(i, z * k);
    }
    g.computeVertexNormals();
    b.add(g, (p) => {
      const a = Math.atan2(p.z, p.x), r = Math.hypot(p.x, p.z);
      const valley = Math.cos(a * 8) < -0.88 && p.y < 0.95 && r > 0.6 ? 1 : 0;
      return { color: grey(0.38 + 0.35 * clamp01(p.y / 1.1)), accent: 0.75 * valley, glow: 0.06, rim: 1.1, rough: 0.4, wobble: 0.25 };
    });
    // the bubbling toxin brew (sloshes via wobble)
    b.add(new THREE.CircleGeometry(0.72, 28, 0, TAU), { color: lin(0.25, 0.7, 0.12), team: 0, accent: 1.15, rim: 0.4, rough: 0.05, wobble: 1.2 }, { p: [0, VAT_LIQUID_Y, 0], r: [-Math.PI / 2, 0, 0] });
    // distiller pipe to the side sac + feet
    const pipe = curve([[0.62, 1.1, -0.3], [0.8, 1.45, -0.45], [0.55, 1.62, -0.58]]);
    b.add(sweep(pipe, 0.055, 6, 10), { color: grey(0.5), accent: 0.3, rim: 1, rough: 0.35 });
    addRoots(b, 2, 2, 5, 0.25, 0.08, 730 + v);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.6;
      b.add(blob(0.16, 2, 0.15, 2, 731 + i), { color: grey(0.35), rim: 0.8, rough: 0.6 }, { p: [Math.cos(a) * 0.72, 0.08, Math.sin(a) * 0.72], s: [1, 0.6, 1] });
    }
    return b.build();
  });
}
const distillerGeo = (): THREE.BufferGeometry => cached('vat:distiller', () => {
  const b = new GeoBuilder();
  b.add(blob(0.3, 3, 0.08, 2.5, 740, [1, 1.15, 1]), (p) => ({ color: lin(0.4, 0.85, 0.3), team: 0.3, accent: 0.6 + 0.4 * clamp01(-p.y / 0.3), glow: 0.1, rim: 1.2, rough: 0.2, wobble: 0.8 }));
  b.add(cone(0.05, 0.16, 6), { color: GREEN, team: 0, accent: 1.2 }, { p: [0, -0.3, 0], r: [Math.PI, 0, 0] });
  return b.build();
});
const bubbleGeo = (): THREE.BufferGeometry => cached('vat:bubble', () =>
  new GeoBuilder().add(ball(0.1, 10, 7), { color: lin(0.5, 1, 0.35), team: 0, accent: 1.0, rim: 1.2, rough: 0.05 }).build());

const buildFermenter: ModelBuilder = (ctx) => {
  const sp = structureParts(ctx, { w: 2, h: 2 }, 2);
  const { rig, v, ph } = sp;
  rig.mesh(vatGeo(v));
  const dist = rig.mesh(distillerGeo());
  dist.position.set(0.5, 1.72, -0.62);
  const B = 7;
  const bubbles = rig.instanced(bubbleGeo(), B, rig.body, 'flesh', 2);
  const seeds = Array.from({ length: B }, () => [sp.rnd() * 0.55, sp.rnd() * TAU, 0.55 + sp.rnd() * 0.7, sp.rnd()] as const);
  return structureModel(sp, 2.05, 0.9, {}, (_st, _dt, time, c) => {
    seeds.forEach(([rad, a, speed, off], i) => {
      const u = (time * speed + off) % 1;
      const grow = u < 0.85 ? 0.35 + 0.65 * (u / 0.85) : 1 + 2.5 * (u - 0.85);
      const s = (u < 0.85 ? 0.6 + 0.8 * rad : (1 - (u - 0.85) / 0.15) * 1.4) * grow * (c < 1 ? c : 1);
      setInst(bubbles, i, Math.cos(a + u) * rad, VAT_LIQUID_Y + 0.02 + u * 0.06, Math.sin(a + u) * rad, 0, 0, 0, s, s * 0.8, s);
    });
    bubbles.instanceMatrix.needsUpdate = true;
    const d = 1 + 0.06 * Math.sin(time * 2.2 + ph) + 0.05 * boing((time + ph) % 3.1, 9, 4);
    dist.scale.set(d, 2 - d, d);
  });
};

// ═════════════════════════════ REPLICATION POD (3×3) ═════════════════════════════
function podBase(v: number): THREE.BufferGeometry {
  return cached(`pod:base:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(800 + v, 5, 1.8);
    b.add(flattenBelow(blob(1.35, 4, 0.12, 1.8, 801 + v, [1.08, 0.36, 1.08]), -0.15), (p) => ({
      color: grey(0.38 + 0.3 * clamp01(p.y / 0.5)), accent: 0.55 * smooth((1 - Math.abs(nz(p.x, p.y, p.z)) - 0.86) / 0.08), glow: 0.05, rim: 1, rough: 0.5, wobble: 0.3,
    }), { p: [0, 0.18, 0] });
    addRoots(b, 3, 3, 8, 0.32, 0.13, 802 + v);
    // glowing division seam between the two lobes
    b.add(torus(0.62, 0.09, 8, 26), { color: GREEN, team: 0.1, accent: 1.1, rim: 0.4, rough: 0.3, wobble: 0.4 }, { p: [0, 1.3, 0], r: [0, Math.PI / 2, 0], s: [1, 1.45, 1] });
    // birth slit at the front where new strains emerge
    b.add(blob(0.3, 2, 0.1, 2, 803), { color: GREEN, team: 0, accent: 1.3, rim: 0.3, rough: 0.2 }, { p: [1.1, 0.42, 0], s: [0.35, 0.9, 1.1] });
    b.add(torus(0.32, 0.08, 6, 18), { color: grey(0.45), accent: 0.2, rim: 1, rough: 0.45 }, { p: [1.12, 0.42, 0], r: [0, Math.PI / 2, 0], s: [1.2, 0.95, 1] });
    return b.build();
  });
}
function podLobe(v: number, side: number): THREE.BufferGeometry {
  return cached(`pod:lobe:${v}:${side}`, () => {
    const g = blob(0.92, 4, 0.04, 2, 810 + v * 3 + side, [0.95, 1.32, 1]);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const a = Math.atan2(z, x);
      const k = 1 + 0.06 * Math.cos(a * 9) * (1 - Math.abs(y) / 1.25);
      pos.setX(i, x * k); pos.setZ(i, z * k);
    }
    g.computeVertexNormals();
    const b = new GeoBuilder();
    b.add(g, (p) => {
      const a = Math.atan2(p.z, p.x);
      const ridge = Math.cos(a * 9);
      return { color: grey(0.5 + 0.35 * clamp01((p.y + 0.8) / 2)), glow: 0.25 + 0.3 * clamp01(-ridge), accent: ridge < -0.9 ? 0.3 : 0, rim: 1.25, rough: 0.32, wobble: 0.6 };
    });
    // crown of short cilia on top
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + side;
      const d = new THREE.Vector3(Math.cos(a) * 0.35, 1, Math.sin(a) * 0.35).normalize();
      b.add(cone(0.05, 0.32, 5), (p) => ({ color: grey(0.55), accent: p.y > 1.35 ? 1 : 0, rim: 1.1 }), { p: [d.x * 0.35, 1.05 + d.y * 0.1, d.z * 0.35], r: alignY(d) });
    }
    return b.build();
  });
}

const buildReplicator: ModelBuilder = (ctx) => {
  const sp = structureParts(ctx, { w: 3, h: 3 }, 2);
  const { rig, v, ph } = sp;
  rig.mesh(podBase(v));
  const lobes = [-1, 1].map((side) => {
    const g = new THREE.Group();
    g.position.set(side * 0.46, 1.28, 0);
    g.rotation.z = -side * 0.1;
    rig.body.add(g);
    rig.mesh(podLobe(v, side > 0 ? 1 : 0), g);
    return g;
  });
  let throb = sp.rnd() * TAU;
  return structureModel(sp, 2.95, 1.3, {}, (st, dt, time) => {
    throb += dt * (st.producing ? 4.6 : 1.5);
    lobes.forEach((g, i) => {
      const s = Math.sin(throb + i * Math.PI);
      const a = st.producing ? 0.06 : 0.03;
      g.scale.set(1 + a * s, 1 + a * 0.6 * s, 1 + a * s);
      g.rotation.y = 0.04 * Math.sin(time * 0.7 + ph + i);
    });
  });
};

// ═════════════════════════════ MUTATION PIT (3×3) ═════════════════════════════
function pitRim(v: number): THREE.BufferGeometry {
  return cached(`pit:rim:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(900 + v, 5, 2);
    const ring = new THREE.TorusGeometry(1.08, 0.4, 12, 40);
    ring.rotateX(Math.PI / 2);
    const pos = ring.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const k = 1 + 0.12 * nz(x * 1.5, y * 1.5, z * 1.5);
      const a = Math.atan2(z, x), cx = Math.cos(a) * 1.08, cz = Math.sin(a) * 1.08;
      pos.setXYZ(i, cx + (x - cx) * k * 1.05, y * k * 1.25, cz + (z - cz) * k * 1.05);
    }
    ring.computeVertexNormals();
    b.add(ring, (p) => ({ color: grey(0.4 + 0.35 * clamp01((p.y + 0.3) / 0.8)), glow: 0.08, accent: Math.hypot(p.x, p.z) < 0.8 ? 0.35 : 0, rim: 1.1, rough: 0.45, wobble: 0.4 }), { p: [0, 0.3, 0] });
    // inward teeth around the lip
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      const d = new THREE.Vector3(-Math.cos(a) * 0.8, 1, -Math.sin(a) * 0.8).normalize();
      b.add(cone(0.07, 0.3, 5), (p) => ({ color: grey(0.7), accent: p.y > 0.95 ? 0.9 : 0, rim: 1.1, rough: 0.35 }), { p: [Math.cos(a) * 0.82, 0.62, Math.sin(a) * 0.82], r: alignY(d) });
    }
    addRoots(b, 3, 3, 7, 0.25, 0.12, 905 + v);
    return b.build();
  });
}
const pitPool = (): THREE.BufferGeometry => cached('pit:pool', () => {
  const g = new THREE.CircleGeometry(0.98, 40, 0, TAU);
  g.rotateX(-Math.PI / 2);
  return new GeoBuilder().add(g, (p) => {
    const r = Math.hypot(p.x, p.z), a = Math.atan2(p.z, p.x);
    const arm = 0.5 + 0.5 * Math.sin(a * 3 + r * 9);
    return { color: lin(0.2, 0.08, 0.3), team: 0.6, accent: 0.9 * smooth((arm - 0.55) / 0.35), glow: 0.5 * (1 - arm), rim: 0.2, rough: 0.08, wobble: 0.8 };
  }, { p: [0, 0.42, 0] }).build();
});
const pitHelix = (): THREE.BufferGeometry => cached('pit:helix', () => {
  const b = new GeoBuilder();
  const H = 2.05, turns = 2.3, R = 0.3;
  for (const off of [0, Math.PI]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 60; i++) { const t = i / 60, a = t * turns * TAU + off; pts.push(new THREE.Vector3(Math.cos(a) * R * (1 - 0.3 * t), t * H, Math.sin(a) * R * (1 - 0.3 * t))); }
    b.add(sweep(pts, (t) => lerp(0.07, 0.04, t), 6), { color: grey(0.95), glow: 0.8, rim: 1.2, rough: 0.3 });
  }
  for (let i = 1; i < 14; i++) {
    const t = i / 14, a = t * turns * TAU, r = R * (1 - 0.3 * t);
    const rung = cyl(0.025, 0.025, 2 * r, 5);
    rung.translate(0, -r, 0);
    b.add(rung, { color: GREEN, team: 0, accent: 1.2, rim: 0.3 }, { p: [0, t * H, 0], r: qe(0, -a, Math.PI / 2, 'YXZ') });
  }
  b.add(ball(0.14, 10, 8), { color: GREEN, team: 0, accent: 1.4 }, { p: [0, H + 0.05, 0] });
  return b.build();
});
const moteGeo = (): THREE.BufferGeometry => cached('struct:mote', () =>
  new GeoBuilder().add(blob(0.1, 1, 0.2, 3, 950), { color: grey(1), glow: 1.1, accent: 0.3, rim: 0.8, rough: 0.3 }).build());

const buildMutationPit: ModelBuilder = (ctx) => {
  const sp = structureParts(ctx, { w: 3, h: 3 }, 2);
  const { rig, v, ph } = sp;
  rig.mesh(pitRim(v));
  const pool = rig.mesh(pitPool());
  const helixG = new THREE.Group();
  helixG.position.y = 0.4;
  rig.body.add(helixG);
  rig.mesh(pitHelix(), helixG);
  const M = 6;
  const motes = rig.instanced(moteGeo(), M, rig.body, 'flesh', 3);
  let spin = sp.rnd() * TAU, swirl = 0;
  return structureModel(sp, 2.6, 1.3, {}, (st, dt, time, c) => {
    const busy = st.producing ? 1 : 0;
    spin += dt * (0.5 + 1.4 * busy);
    swirl += dt * (0.35 + 1.2 * busy);
    pool.rotation.y = -swirl;
    helixG.rotation.y = spin;
    helixG.position.y = 0.4 + 0.08 * Math.sin(time * 1.1 + ph);
    const hs = c < 1 ? 0.4 + 0.6 * c : 1 + 0.03 * Math.sin(time * 2.3 + ph);
    helixG.scale.set(1, hs, 1);
    for (let i = 0; i < M; i++) {
      const a = spin * 1.6 + (i / M) * TAU;
      const y = 0.8 + ((time * (0.25 + busy * 0.35) + i / M) % 1) * 1.6;
      const r = 0.55 + 0.15 * Math.sin(time + i);
      setInst(motes, i, Math.cos(a) * r, y, Math.sin(a) * r, time + i, a, 0, 0.8 + 0.4 * Math.sin(time * 3 + i));
    }
    motes.instanceMatrix.needsUpdate = true;
  });
};

// ═════════════════════════════ BIOFILM SPIRE (4×4, tall) ═════════════════════════════
const SPIRE_H = 5.0, SPIRE_Y0 = 0.3;
const spireAxis = (t: number, s: number): [number, number] => [0.2 * Math.sin(t * 2.6 + s), 0.16 * Math.cos(t * 2.1 + s * 1.3)];
const spireR = (t: number, s: number): number => lerp(1.0, 0.2, Math.pow(t, 0.85)) * (1 + 0.07 * Math.sin(t * 17 + s));
function spireGeo(v: number): THREE.BufferGeometry {
  return cached(`spire:body:${v}`, () => {
    const s = 1.3 + v * 2.1;
    const rings = 56, radial = 20;
    const verts: number[] = [], idx: number[] = [];
    for (let i = 0; i <= rings; i++) {
      const t = i / rings, y = SPIRE_Y0 + t * SPIRE_H;
      const [cx, cz] = spireAxis(t, s), R = spireR(t, s);
      for (let j = 0; j < radial; j++) {
        const a = (j / radial) * TAU;
        const r = R * (1 + 0.19 * Math.cos(3 * (a + t * 4.2)));
        verts.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
      }
    }
    for (let i = 0; i < rings; i++) for (let j = 0; j < radial; j++) {
      const j1 = (j + 1) % radial;
      const a = i * radial + j, b2 = i * radial + j1, c = (i + 1) * radial + j, d = (i + 1) * radial + j1;
      idx.push(a, c, b2, b2, c, d);
    }
    const top = verts.length / 3;
    const [tx, tz] = spireAxis(1, s);
    verts.push(tx, SPIRE_Y0 + SPIRE_H + 0.08, tz);
    for (let j = 0; j < radial; j++) idx.push(top, rings * radial + ((j + 1) % radial), rings * radial + j);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const b = new GeoBuilder();
    b.add(g, (p) => {
      const t = clamp01((p.y - SPIRE_Y0) / SPIRE_H);
      const [cx, cz] = spireAxis(t, s);
      const a = Math.atan2(p.z - cz, p.x - cx);
      const ridge = Math.cos(3 * (a + t * 4.2));
      return { color: grey(0.35 + 0.5 * t), accent: ridge > 0.93 ? 0.95 : 0.0, glow: 0.12 + 0.25 * t, rim: 1.2, rough: 0.38, wobble: 0.25 };
    });
    // base mound + roots
    b.add(flattenBelow(blob(1.6, 4, 0.12, 1.6, 1001 + v, [1.12, 0.34, 1.12]), -0.2), (p) => ({ color: grey(0.35 + 0.2 * clamp01(p.y / 0.5)), glow: 0.04, rim: 0.9, rough: 0.5, wobble: 0.3 }), { p: [0, 0.22, 0] });
    addRoots(b, 4, 4, 8, 0.4, 0.17, 1002 + v);
    // bracket-fungus shelves (biofilm layers) with glowing gills underneath
    const rr = rng(1010 + v);
    for (let i = 0; i < 5; i++) {
      const t = 0.14 + i * 0.16 + rr() * 0.04;
      const [cx, cz] = spireAxis(t, s);
      const a = i * 2.3 + rr();
      const R = spireR(t, s);
      const sz = lerp(0.85, 0.45, t);
      b.add(blob(sz, 2, 0.1, 2.5, 1020 + i), (lp) => ({ color: grey(lp.y > 0 ? 0.75 : 0.35), accent: lp.y < -0.03 ? 0.8 : 0, rim: 1.1, rough: 0.45 }),
        { p: [cx + Math.cos(a) * R * 0.9, SPIRE_Y0 + t * SPIRE_H, cz + Math.sin(a) * R * 0.9], r: [0, -a, 0.12], s: [1, 0.22, 1] }, { local: true });
    }
    return b.build();
  });
}
const spireOrb = (v: number): THREE.BufferGeometry => cached(`spire:orb:${v}`, () => {
  const b = new GeoBuilder();
  b.add(blob(0.42, 3, 0.08, 2.4, 1030 + v), { color: grey(1), glow: 1.0, accent: 0.15, rim: 1.4, rough: 0.25, wobble: 0.8 });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    const d = new THREE.Vector3(Math.cos(a), 0.55, Math.sin(a)).normalize();
    b.add(cone(0.06, 0.34, 5), (p) => ({ color: grey(0.55), accent: p.y > 0.45 ? 1 : 0, rim: 1.1 }), { p: d.clone().multiplyScalar(0.36), r: alignY(d) });
  }
  return b.build();
});

const buildSpire: ModelBuilder = (ctx) => {
  const sp = structureParts(ctx, { w: 4, h: 4 }, 2);
  const { rig, v, ph } = sp;
  rig.mesh(spireGeo(v));
  const s = 1.3 + v * 2.1;
  const [tx, tz] = spireAxis(1, s);
  const orbG = new THREE.Group();
  orbG.position.set(tx, SPIRE_Y0 + SPIRE_H + 0.32, tz);
  rig.body.add(orbG);
  rig.mesh(spireOrb(v), orbG);
  const M = 9;
  const motes = rig.instanced(moteGeo(), M, rig.body, 'flesh', 6);
  let swirl = sp.rnd() * TAU;
  return structureModel(sp, 6.1, 1.7, {}, (st, dt, time, c) => {
    const busy = st.producing ? 1 : 0;
    swirl += dt * (0.35 + 0.9 * busy);
    const p = 1 + (0.05 + 0.04 * busy) * Math.sin(time * (1.8 + 2.5 * busy) + ph);
    orbG.scale.set(p, p, p);
    orbG.rotation.y = swirl * 0.5;
    for (let i = 0; i < M; i++) {
      const u = (swirl * 0.12 + i / M) % 1;
      const t = u;
      const [cx, cz] = spireAxis(t, s);
      const a = swirl * 1.3 + i * 2.1 + u * 5;
      const r = spireR(t, s) + 0.45;
      const sc = (0.7 + 0.5 * Math.sin(time * 2 + i)) * Math.sin(Math.PI * u) * (c < 1 ? c : 1);
      setInst(motes, i, cx + Math.cos(a) * r, SPIRE_Y0 + t * SPIRE_H, cz + Math.sin(a) * r, 0, a, 0, sc);
    }
    motes.instanceMatrix.needsUpdate = true;
  });
};

// ═════════════════════════════ TOXIN SPITTER (2×2 turret) ═════════════════════════════
const SPIT_NECK_Y = 1.32;
function spitterBase(v: number): THREE.BufferGeometry {
  return cached(`spitter:base:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(1100 + v, 5, 2.4);
    b.add(flattenBelow(blob(0.8, 3, 0.15, 2.2, 1101 + v, [1.12, 0.45, 1.12]), -0.14), (p) => ({
      color: grey(0.38 + 0.3 * clamp01(p.y / 0.5)), accent: 0.5 * smooth((1 - Math.abs(nz(p.x * 2, p.y * 2, p.z * 2)) - 0.86) / 0.1), glow: 0.05, rim: 1, rough: 0.5, wobble: 0.3,
    }), { p: [0, 0.16, 0] });
    addRoots(b, 2, 2, 6, 0.3, 0.1, 1102 + v);
    // thick muscular neck
    const neck = curve([[0, 0.3, 0], [0.06, 0.7, 0.03], [-0.04, 1.05, -0.02], [0, SPIT_NECK_Y, 0]]);
    b.add(sweep(neck, (t) => lerp(0.3, 0.19, t) * (1 + 0.08 * Math.sin(t * 18)), 10, 16), (p) => ({
      color: grey(0.45 + 0.25 * clamp01(p.y / 1.3)), accent: Math.sin(p.y * 18) > 0.85 ? 0.5 : 0, glow: 0.08, rim: 1.15, rough: 0.4, wobble: 0.45,
    }));
    return b.build();
  });
}
const spitterHead = (v: number): THREE.BufferGeometry => cached(`spitter:head:${v}`, () => {
  const b = new GeoBuilder();
  const nz = noise3(1110 + v, 4, 3);
  b.add(blob(0.4, 3, 0.07, 2.5, 1111 + v, [1.2, 0.88, 1]), (p) => ({
    color: grey(0.55 + 0.35 * clamp01((p.y + 0.3) / 0.6)), glow: 0.25 + 0.2 * nz(p.x * 4, p.y * 4, p.z * 4), rim: 1.3, rough: 0.32, wobble: 0.5,
  }), { p: [0.05, 0.12, 0] });
  // spitting orifice (+X): lips + glowing throat
  b.add(torus(0.15, 0.065, 8, 18), { color: lin(0.5, 0.85, 0.35), team: 0.4, accent: 0.5, rim: 1, rough: 0.3 }, { p: [0.5, 0.12, 0], r: [0, Math.PI / 2, 0] });
  b.add(ball(0.13, 10, 7), { color: GREEN, team: 0, accent: 1.6, rim: 0.2, rough: 0.2 }, { p: [0.49, 0.12, 0], s: [0.45, 1, 1] });
  // crest spikes along the back of the head
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const d = new THREE.Vector3(-0.6 - t * 0.4, 1, (t - 0.5) * 0.25).normalize();
    b.add(cone(0.055, 0.3 - Math.abs(t - 0.5) * 0.15, 5), (lp) => ({ color: grey(0.5), accent: lp.y > 0.2 ? 1 : 0, rim: 1.1 }),
      { p: [0.15 - t * 0.38, 0.42 - Math.abs(t - 0.5) * 0.1, (t - 0.5) * 0.2], r: alignY(d) }, { local: true });
  }
  // eyespots
  for (const z of [-0.17, 0.17]) b.add(ball(0.05, 8, 6), { color: grey(1), team: 0.1, glow: 1.6, rim: 0.2 }, { p: [0.4, 0.3, z] });
  return b.build();
});
const glandGeo = (): THREE.BufferGeometry => cached('spitter:gland', () =>
  new GeoBuilder().add(blob(0.17, 2, 0.1, 3, 1120, [1.25, 0.9, 1]), { color: lin(0.4, 0.9, 0.3), team: 0.2, accent: 1.0, rim: 0.7, rough: 0.2, wobble: 0.9 }).build());

const buildToxinSpitter: ModelBuilder = (ctx) => {
  const sp = structureParts(ctx, { w: 2, h: 2 }, 2);
  const { rig, v, ph } = sp;
  rig.mesh(spitterBase(v));
  const headG = new THREE.Group();
  headG.position.y = SPIT_NECK_Y;
  rig.body.add(headG);
  const recoilG = new THREE.Group();
  headG.add(recoilG);
  rig.mesh(spitterHead(v), recoilG);
  const glands = rig.instanced(glandGeo(), 2, recoilG, 'flesh', 1);
  const muzzle = new THREE.Vector3(0.55, SPIT_NECK_Y + 0.12, 0);
  const local = new THREE.Vector3();
  let yaw = sp.rnd() * TAU, pitch = 0;
  return structureModel(sp, 2.0, 0.95, { muzzle }, (st, dt, time, c) => {
    // aim: local yaw = aimAngle − facing (sim convention); three rotation.y = −angle
    const scan = 0.7 * Math.sin(time * 0.35 + ph);
    const target = st.aimAngle != null && c >= 1 ? wrapAngle(st.aimAngle - st.facing) : scan;
    yaw = dampAngle(yaw, target, st.aimAngle != null ? 9 : 1.5, dt);
    pitch = damp(pitch, st.aimAngle != null ? 0.12 : 0.04 * Math.sin(time * 0.8 + ph), 4, dt);
    headG.rotation.set(0, -yaw, -pitch);
    const atk = attackPulse(st.sinceAttack, 0.3);
    const kick = boing(st.sinceAttack, 16, 8);
    recoilG.position.set(-0.13 * atk, 0, 0);
    recoilG.scale.set(1 - 0.1 * kick, 1 + 0.12 * kick, 1 + 0.06 * kick);
    const refill = isFinite(st.sinceAttack) ? easeOut(clamp01(st.sinceAttack / 1.1)) : 1;
    for (let i = 0; i < 2; i++) {
      const s = (0.45 + 0.55 * refill) * (1 + 0.05 * Math.sin(time * 3 + i * 2 + ph));
      setInst(glands, i, -0.12, 0.08, i ? 0.3 : -0.3, 0, i ? 0.4 : -0.4, 0, s);
    }
    glands.instanceMatrix.needsUpdate = true;
    // keep the muzzle on the orifice (model space) for projectile origins
    local.set(0.55 - 0.13 * atk, 0.12, 0).applyEuler(headG.rotation);
    muzzle.set(local.x, local.y + SPIT_NECK_Y, local.z).multiply(rig.base.scale);
  });
};

export const STRUCTURE_MODELS: Record<string, ModelBuilder> = {
  path_hive: buildHive,
  path_nest: buildNest,
  path_fermenter: buildFermenter,
  path_replicator: buildReplicator,
  path_mutation_pit: buildMutationPit,
  path_biofilm_spire: buildSpire,
  path_toxin_spitter: buildToxinSpitter,
};
// keep tree-shaking honest for helpers only used in some variants
void fibonacciSphere; void prep; void cyl;
