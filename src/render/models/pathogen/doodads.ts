/**
 * [models-pathogen] Infection doodads (static props for the contaminated north of the campus).
 * Each kind is 1 merged mesh (+1 translucent mesh for the vent's spore cloud), geometry cached per
 * kind × variant, materials shared (fog-of-war patched, neutral pathogen magenta). Even though they are
 * static Object3Ds, they stay alive through the shared shader clock (pulsing goo, wobbling slime and
 * spore clouds) — this also survives the environment instancing their meshes.
 * Sizes follow DESIGN §6 at scale 1; the returned group carries ctx.scale.
 */
import * as THREE from 'three';
import type { DoodadKind } from '../../../core/types';
import type { DoodadBuilder } from '../types';
import { GeoBuilder, alignY, ball, blob, cached, cone, curve, cyl, flattenBelow, lathe, noise3, rng, splat, sweep, torus } from './geom';
import { TAU } from './rig';
import { DOODAD_TEAM, getPalette } from './shader';
import { GREEN, grey, lin } from './units';

const HAZARD_YELLOW = lin(0.62, 0.42, 0.03);
const RUST = lin(0.2, 0.1, 0.05);
const STEEL = lin(0.16, 0.17, 0.18);

function makeDoodad(kind: DoodadKind, scale: number, geos: Array<{ geo: THREE.BufferGeometry; glass?: boolean }>): THREE.Object3D {
  const pal = getPalette(DOODAD_TEAM, true);
  const g = new THREE.Group();
  g.name = `doodad:${kind}`;
  for (const { geo, glass } of geos) {
    const m = new THREE.Mesh(geo, pal.get(glass ? 'glass' : 'flesh', 'idle'));
    if (glass) { m.renderOrder = 2; m.castShadow = false; }
    g.add(m);
  }
  g.scale.setScalar(scale > 0 ? scale : 1);
  return g;
}

/** Glossy acid puddle (shared by several props). */
function gooSplat(b: GeoBuilder, rx: number, rz: number, seed: number, at: readonly [number, number, number] = [0, 0, 0], h = 0.03): void {
  const g = splat(rx, rz, 28, 0.35, seed, 4);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const e = Math.hypot(pos.getX(i) / rx, pos.getZ(i) / rz);
    pos.setY(i, h * (1 - Math.min(1, e) ** 2) + 0.006);
  }
  g.computeVertexNormals();
  b.add(g, (p) => {
    const e = Math.min(1, Math.hypot((p.x - at[0]) / rx, (p.z - at[2]) / rz));
    return { color: e > 0.8 ? lin(0.06, 0.03, 0.07) : GREEN, team: e > 0.8 ? 0.6 : 0, accent: 1.05 * (1 - e * e), rim: 0.15, rough: 0.05, wobble: e < 0.7 ? 0.5 : 0 };
  }, { p: at });
}

/** Biohazard trefoil (flat, facing +Z) — three crescents around a ring. */
function trefoil(size: number): THREE.BufferGeometry {
  const shapes: THREE.Shape[] = [];
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + (i * TAU) / 3;
    const s = new THREE.Shape();
    const cx = Math.cos(a) * size * 0.42, cy = Math.sin(a) * size * 0.42;
    s.absarc(cx, cy, size * 0.42, 0, TAU, false);
    const hole = new THREE.Path();
    hole.absarc(Math.cos(a) * size * 0.62, Math.sin(a) * size * 0.62, size * 0.3, 0, TAU, true);
    s.holes.push(hole);
    shapes.push(s);
  }
  const ring = new THREE.Shape();
  ring.absarc(0, 0, size * 0.3, 0, TAU, false);
  const rh = new THREE.Path();
  rh.absarc(0, 0, size * 0.2, 0, TAU, true);
  ring.holes.push(rh);
  shapes.push(ring);
  return new THREE.ShapeGeometry(shapes, 8);
}

// ───────────────────────────── biohazard_barrel (1×1) ─────────────────────────────
function barrelBody(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const prof: Array<[number, number]> = [[0, 0], [0.27, 0], [0.285, 0.03], [0.285, 0.26], [0.3, 0.28], [0.285, 0.3], [0.285, 0.56], [0.3, 0.58], [0.285, 0.6], [0.285, 0.84], [0.27, 0.87], [0, 0.87]];
  b.add(lathe(prof, 20), (p) => {
    const hoop = (Math.abs(p.y - 0.28) < 0.025 || Math.abs(p.y - 0.58) < 0.025);
    const band = p.y > 0.66 && p.y < 0.8;
    return { color: hoop ? STEEL : band ? lin(0.03, 0.03, 0.03) : HAZARD_YELLOW, team: 0, rough: hoop ? 0.4 : 0.55, metal: hoop ? 0.6 : 0.25, rim: 0.25 };
  });
  // trefoil emblems on two sides (black on yellow)
  for (const a of [0, Math.PI]) {
    b.add(trefoil(0.11), { color: lin(0.02, 0.02, 0.02), team: 0, rough: 0.6, rim: 0.1 }, { p: [Math.cos(a) * 0.292, 0.43, Math.sin(a) * 0.292], r: [0, Math.PI / 2 - a, 0] });
  }
  return b.build();
}
const buildBarrel: DoodadBuilder = ({ seed, scale }) => {
  const v = Math.abs(seed) % 3;
  const geo = cached(`dd:barrel:${v}`, () => {
    const b = new GeoBuilder();
    const body = barrelBody();
    const ooze = (bb: GeoBuilder, from: THREE.Vector3[], r: number): void => {
      bb.add(sweep(from, (t) => r * (1 - 0.4 * t), 5, 1, true), { color: GREEN, team: 0, accent: 1.0, rough: 0.05, rim: 0.3, wobble: 0.4 });
    };
    if (v < 2) {
      b.addPainted(body, { r: [0, v * 1.3, 0] });
      // slime streak running down the side + leak puddle
      const a = 0.9 + v;
      const sx = Math.cos(a) * 0.29, sz = Math.sin(a) * 0.29;
      ooze(b, [new THREE.Vector3(sx, 0.86, sz), new THREE.Vector3(sx * 1.04, 0.5, sz * 1.04), new THREE.Vector3(sx * 1.05, 0.12, sz * 1.05), new THREE.Vector3(sx * 1.25, 0.01, sz * 1.25)], 0.035);
      gooSplat(b, 0.42, 0.3, 1600 + v, [Math.cos(a) * 0.38, 0, Math.sin(a) * 0.38]);
      if (v === 1) {
        // lid knocked off, glowing brew inside
        b.add(new THREE.CircleGeometry(0.26, 20), { color: GREEN, team: 0, accent: 1.2, rough: 0.05, wobble: 0.6 }, { p: [0, 0.83, 0], r: [-Math.PI / 2, 0, 0] });
        b.add(cyl(0.29, 0.29, 0.03, 20), { color: STEEL, team: 0, metal: 0.6, rough: 0.4, rim: 0.2 }, { p: [-0.4, 0.06, 0.25], r: [0.25, 0, 1.2] });
      } else {
        b.add(cyl(0.28, 0.28, 0.03, 20), { color: STEEL, team: 0, metal: 0.6, rough: 0.4, rim: 0.2 }, { p: [0, 0.87, 0] });
      }
    } else {
      // tipped over, spilling
      b.addPainted(body, { p: [-0.05, 0.3, 0], r: [0, 0.4, Math.PI / 2] });
      gooSplat(b, 0.55, 0.38, 1610, [0.42, 0, 0.18]);
    }
    return b.build();
  });
  return makeDoodad('biohazard_barrel', scale, [{ geo }]);
};

// ───────────────────────────── goo_puddle (walkable, flat) ─────────────────────────────
const buildGooPuddle: DoodadBuilder = ({ seed, scale }) => {
  const v = Math.abs(seed) % 3;
  const geo = cached(`dd:puddle:${v}`, () => {
    const b = new GeoBuilder();
    const rr = rng(1620 + v);
    gooSplat(b, 0.8 + v * 0.1, 0.62 + v * 0.08, 1621 + v, [0, 0, 0], 0.035);
    for (let i = 0; i < 4 + v; i++) {
      const a = rr() * TAU, r = rr() * 0.45;
      b.add(new THREE.SphereGeometry(0.03 + rr() * 0.04, 8, 4, 0, TAU, 0, Math.PI / 2), { color: lin(0.3, 0.8, 0.2), team: 0, accent: 0.9, rough: 0.02, rim: 1.2 }, { p: [Math.cos(a) * r, 0.03, Math.sin(a) * r] });
    }
    // small satellite droplets
    for (let i = 0; i < 3; i++) {
      const a = rr() * TAU;
      gooSplat(b, 0.12 + rr() * 0.08, 0.1 + rr() * 0.05, 1630 + i + v * 3, [Math.cos(a) * 0.95, 0, Math.sin(a) * 0.75], 0.015);
    }
    return b.build();
  });
  return makeDoodad('goo_puddle', scale, [{ geo }]);
};

// ───────────────────────────── sewer_grate (walkable, flat) ─────────────────────────────
const buildSewerGrate: DoodadBuilder = ({ seed, scale }) => {
  const v = Math.abs(seed) % 2;
  const geo = cached(`dd:grate:${v}`, () => {
    const b = new GeoBuilder();
    // glowing slime below the bars
    b.add(new THREE.PlaneGeometry(0.8, 0.8), { color: GREEN, team: 0, accent: 0.85, rough: 0.1, rim: 0.1, wobble: 0.6 }, { p: [0, 0.01, 0], r: [-Math.PI / 2, 0, 0] });
    // frame
    const frame = (w: number, d: number, x: number, z: number): void => {
      b.add(new THREE.BoxGeometry(w, 0.045, d), { color: STEEL, team: 0, metal: 0.65, rough: 0.45, rim: 0.2 }, { p: [x, 0.022, z] });
    };
    frame(0.96, 0.08, 0, -0.44); frame(0.96, 0.08, 0, 0.44); frame(0.08, 0.8, -0.44, 0); frame(0.08, 0.8, 0.44, 0);
    for (let i = 0; i < 7; i++) {
      b.add(new THREE.BoxGeometry(0.045, 0.04, 0.82), { color: i % 2 ? STEEL : lin(0.12, 0.12, 0.13), team: 0, metal: 0.6, rough: 0.5, rim: 0.2 }, { p: [-0.33 + i * 0.11, 0.022, 0] });
    }
    b.add(new THREE.BoxGeometry(0.82, 0.035, 0.05), { color: STEEL, team: 0, metal: 0.6, rough: 0.5, rim: 0.2 }, { p: [0, 0.02, 0] });
    // slime oozing out over the frame
    const rr = rng(1640 + v);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + rr() * 0.8 + v;
      gooSplat(b, 0.22 + rr() * 0.12, 0.14 + rr() * 0.06, 1641 + i + v * 5, [Math.cos(a) * 0.5, 0.012, Math.sin(a) * 0.5], 0.02);
    }
    return b.build();
  });
  return makeDoodad('sewer_grate', scale, [{ geo }]);
};

// ───────────────────────────── infected_growth (2×2) ─────────────────────────────
const buildInfectedGrowth: DoodadBuilder = ({ seed, scale }) => {
  const v = Math.abs(seed) % 3;
  const geo = cached(`dd:growth:${v}`, () => {
    const b = new GeoBuilder();
    const rr = rng(1660 + v);
    const nz = noise3(1661 + v, 5, 2);
    // fleshy base mat spreading over the 2×2 tile
    b.add(flattenBelow(blob(0.8, 3, 0.25, 2, 1662 + v, [1.15, 0.3, 1.05]), -0.05), (p) => ({
      color: grey(0.35 + 0.3 * Math.max(0, p.y / 0.25)), accent: 0.4 * Math.max(0, 1 - Math.abs(nz(p.x * 3, p.y, p.z * 3)) * 8 - 6), glow: 0.08, rim: 1, rough: 0.45, wobble: 0.5,
    }), { p: [0, 0.05, 0] });
    // pustules with glowing tips
    const n = 6 + v;
    for (let i = 0; i < n; i++) {
      const a = rr() * TAU, r = 0.15 + rr() * 0.55, h = 0.18 + rr() * 0.28;
      const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.9;
      b.add(blob(h, 2, 0.1, 3, 1670 + i), (p) => ({ color: grey(0.6), glow: 0.2, accent: p.y > h * 1.5 + 0.08 ? 1.1 : 0.0, rim: 1.3, rough: 0.3, wobble: 0.8 }), { p: [x, h * 0.75, z], s: [0.85, 1.25, 0.85] });
      b.add(ball(h * 0.32, 7, 5), { color: GREEN, team: 0, accent: 1.3, rim: 0.3 }, { p: [x, h * 1.95, z] });
    }
    // curling tendrils (sway in the shader)
    for (let i = 0; i < 3 + (v % 2); i++) {
      const a = rr() * TAU, r = 0.3 + rr() * 0.4;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const c = curve([[x, 0.1, z], [x * 1.1, 0.45, z * 1.1], [x * 0.9 + 0.1, 0.8, z * 0.9], [x * 0.7 + 0.18, 1.0 + rr() * 0.2, z * 0.7 - 0.05], [x * 0.6 + 0.08, 1.12, z * 0.6 - 0.12]]);
      b.add(sweep(c, (t) => 0.06 * (1 - t) + 0.01, 6, 16), (p) => ({ color: grey(0.5), accent: p.y > 1.0 ? 0.8 : 0, rim: 1.2, rough: 0.35, whip: -Math.min(1, Math.max(0, (p.y - 0.2) / 0.9)) * 0.6 }));
    }
    // a few spikes
    for (let i = 0; i < 4; i++) {
      const a = rr() * TAU, r = 0.4 + rr() * 0.4;
      const d = new THREE.Vector3(Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5).normalize();
      b.add(cone(0.05, 0.3, 5), (p) => ({ color: grey(0.55), accent: p.y > 0.4 ? 0.8 : 0, rim: 1 }), { p: [Math.cos(a) * r, 0.12, Math.sin(a) * r], r: alignY(d) });
    }
    return b.build();
  });
  return makeDoodad('infected_growth', scale, [{ geo }]);
};

// ───────────────────────────── spore_vent (1×1) ─────────────────────────────
const buildSporeVent: DoodadBuilder = ({ seed, scale }) => {
  const v = Math.abs(seed) % 2;
  const geo = cached(`dd:vent:${v}`, () => {
    const b = new GeoBuilder();
    const nz = noise3(1680 + v, 5, 3);
    const g = lathe([[0.46, 0], [0.44, 0.12], [0.34, 0.32], [0.24, 0.55], [0.22, 0.68], [0.27, 0.74], [0.2, 0.76], [0.14, 0.62], [0, 0.55]], 18);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const k = 1 + 0.14 * nz(x * 4, y * 4, z * 4);
      pos.setX(i, x * k); pos.setZ(i, z * k);
    }
    g.computeVertexNormals();
    b.add(g, (p) => {
      const inner = Math.hypot(p.x, p.z) < 0.19 && p.y > 0.5;
      return { color: inner ? GREEN : lin(0.13, 0.12, 0.12), team: inner ? 0 : 0.35, accent: inner ? 1.3 : (p.y < 0.1 ? 0.2 : 0), rough: 0.85, rim: 0.5, metal: 0 };
    });
    // fleshy lip + crust
    b.add(torus(0.22, 0.05, 6, 16), { color: grey(0.45), accent: 0.3, rim: 1.1, rough: 0.4, wobble: 0.4 }, { p: [0, 0.74, 0], r: [Math.PI / 2, 0, 0] });
    gooSplat(b, 0.5, 0.45, 1690 + v, [0, 0, 0], 0.012);
    return b.build();
  });
  const cloud = cached('dd:vent:cloud', () => {
    const b = new GeoBuilder();
    b.add(blob(0.2, 2, 0.2, 2.5, 1695), { color: lin(0.5, 0.9, 0.35), team: 0.2, accent: 0.45, rim: 1.4, rough: 0.5, wobble: 2.2 }, { p: [0, 0.98, 0] });
    b.add(blob(0.15, 2, 0.25, 2.5, 1696), { color: lin(0.5, 0.9, 0.35), team: 0.2, accent: 0.35, rim: 1.4, rough: 0.5, wobble: 2.6 }, { p: [0.06, 1.28, -0.04] });
    b.add(blob(0.1, 1, 0.25, 2.5, 1697), { color: lin(0.5, 0.9, 0.35), team: 0.2, accent: 0.25, rim: 1.4, rough: 0.5, wobble: 3 }, { p: [0.1, 1.52, 0.02] });
    return b.build();
  });
  return makeDoodad('spore_vent', scale, [{ geo }, { geo: cloud, glass: true }]);
};

// ───────────────────────────── waste_container (2×1) ─────────────────────────────
const buildWasteContainer: DoodadBuilder = ({ seed, scale }) => {
  const v = Math.abs(seed) % 2;
  const geo = cached(`dd:container:${v}`, () => {
    const b = new GeoBuilder();
    const paint = v ? lin(0.05, 0.16, 0.1) : lin(0.25, 0.08, 0.02);
    // skip body: open-top trapezoid (wider at the top)
    const W = 1.8, D = 0.82, H = 0.78;
    const box = new THREE.BoxGeometry(W, H, D, 4, 2, 2);
    const pos = box.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i), t = (y + H / 2) / H;
      pos.setX(i, pos.getX(i) * (0.9 + 0.1 * t));
      pos.setZ(i, pos.getZ(i) * (0.92 + 0.08 * t));
    }
    box.computeVertexNormals();
    b.add(box, (p) => {
      const rib = Math.abs(((p.x + 2) % 0.45) - 0.225) < 0.02;
      const rust = Math.sin(p.x * 9 + p.y * 13) * Math.cos(p.z * 11 - p.x * 4) > 0.55;
      return { color: rust ? RUST : rib ? STEEL : paint, team: 0, metal: rib ? 0.6 : 0.35, rough: rust ? 0.85 : 0.5, rim: 0.2 };
    }, { p: [0, H / 2 + 0.06, 0] });
    // feet
    for (const x of [-0.75, 0.75]) b.add(new THREE.BoxGeometry(0.16, 0.08, D * 0.9), { color: STEEL, team: 0, metal: 0.6, rough: 0.5, rim: 0.2 }, { p: [x, 0.04, 0] });
    // hazard label
    b.add(new THREE.PlaneGeometry(0.36, 0.26), { color: HAZARD_YELLOW, team: 0, rough: 0.6, rim: 0.1 }, { p: [0, 0.5, D / 2 + 0.035], r: [0.08, 0, 0] });
    b.add(trefoil(0.09), { color: lin(0.02, 0.02, 0.02), team: 0, rough: 0.6, rim: 0.1 }, { p: [0, 0.5, D / 2 + 0.042], r: [0.08, 0, 0] });
    // overflowing heap of infected waste
    const rr = rng(1700 + v);
    for (let i = 0; i < 9; i++) {
      const x = (rr() - 0.5) * 1.4, z = (rr() - 0.5) * 0.5, r = 0.18 + rr() * 0.16;
      const flesh = rr() < 0.55;
      b.add(blob(r, 2, 0.2, 2.5, 1710 + i + v * 10), flesh
        ? { color: grey(0.55), glow: 0.15, rim: 1.2, rough: 0.35, wobble: 0.6 }
        : { color: lin(0.03, 0.03, 0.035), team: 0, rough: 0.3, rim: 0.4, metal: 0.05 },
      { p: [x, H + 0.06 + r * 0.35, z], s: [1.2, 0.75, 1] });
    }
    // ooze spilling over the front edge down to the ground
    for (const x of [-0.45, 0.35]) {
      const pts = [new THREE.Vector3(x, H + 0.1, D / 2 - 0.05), new THREE.Vector3(x + 0.02, H - 0.05, D / 2 + 0.06), new THREE.Vector3(x, 0.4, D / 2 + 0.05), new THREE.Vector3(x - 0.02, 0.05, D / 2 + 0.12)];
      b.add(sweep(pts, (t) => 0.06 * (1 - 0.4 * t), 6, 1), { color: GREEN, team: 0, accent: 1.05, rough: 0.05, rim: 0.3, wobble: 0.5 });
    }
    gooSplat(b, 0.45, 0.25, 1720 + v, [-0.05, 0, D / 2 + 0.2]);
    // lid flipped open, leaning back
    b.add(new THREE.BoxGeometry(W * 0.98, 0.04, D * 0.6), { color: paint, team: 0, metal: 0.35, rough: 0.55, rim: 0.2 }, { p: [0, H + 0.25, -D / 2 - 0.1], r: [1.15, 0, 0] });
    return b.build();
  });
  return makeDoodad('waste_container', scale, [{ geo }]);
};

export const DOODAD_BUILDERS: Partial<Record<DoodadKind, DoodadBuilder>> = {
  biohazard_barrel: buildBarrel,
  goo_puddle: buildGooPuddle,
  sewer_grate: buildSewerGrate,
  infected_growth: buildInfectedGrowth,
  spore_vent: buildSporeVent,
  waste_container: buildWasteContainer,
};
