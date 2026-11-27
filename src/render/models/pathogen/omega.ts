/**
 * [models-pathogen] STRAIN OMEGA — the campaign boss (radius 2.0, ~5 tall).
 *
 * A mutating viral colossus: a capsid of separated, slowly rotating armour plates with glowing seams,
 * a pulsing core visible through the gaps, ~30 club-tipped spike proteins whose lengths constantly mutate,
 * six satellite virions on tilted orbits, twin glowing halo rings, and eight writhing tentacles it walks on.
 * 7 meshes (4 of them per-model InstancedMeshes) — well under the boss budget of 20.
 */
import * as THREE from 'three';
import type { ModelBuilder } from '../types';
import { GeoBuilder, alignY, ball, blob, cached, cone, curve, cyl, fibonacciSphere, noise3, rng, sweep, torus } from './geom';
import { Rig, TAU, attackPulse, clamp01, damp, easeIn, lerp, seeded, setInst, setInstQ, smooth, unitVariant } from './rig';
import { GREEN, grey, lin } from './units';

const OMEGA_R = 2.0, TORSO_Y = 2.75, SHELL_R = 1.45;

/** Capsid of separated plates: each icosphere face shrunk toward its centroid and extruded outward. */
function omegaShell(): THREE.BufferGeometry {
  return cached('omega:shell', () => {
    const ico = new THREE.IcosahedronGeometry(SHELL_R, 1);
    const pos = ico.getAttribute('position') as THREE.BufferAttribute;
    const verts: number[] = [];
    const glowSide: number[] = [];
    const shade: number[] = [];
    const rr = rng(1500);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cen = new THREE.Vector3(), n = new THREE.Vector3();
    const tri = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, side: number, s: number): void => {
      verts.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
      glowSide.push(side, side, side);
      shade.push(s, s, s);
    };
    for (let f = 0; f < pos.count; f += 3) {
      a.fromBufferAttribute(pos, f); b.fromBufferAttribute(pos, f + 1); c.fromBufferAttribute(pos, f + 2);
      cen.copy(a).add(b).add(c).divideScalar(3);
      n.copy(cen).normalize();
      // the front-lower plates are missing: a glowing "maw" where the core shows through
      if (n.x > 0.72 && n.y < 0.25 && n.y > -0.55) continue;
      const k = 0.84 + rr() * 0.05, th = 0.1 + rr() * 0.08, lift = rr() * 0.06;
      const s = 0.45 + rr() * 0.35;
      const inner = [a, b, c].map((v) => v.clone().sub(cen).multiplyScalar(k).add(cen).addScaledVector(n, lift));
      const outer = inner.map((v) => v.clone().addScaledVector(n, th));
      // bevelled top: a slightly smaller top face
      const top = outer.map((v) => v.clone().sub(cen.clone().addScaledVector(n, lift + th)).multiplyScalar(0.86).add(cen.clone().addScaledVector(n, lift + th * 1.25)));
      tri(top[0]!, top[1]!, top[2]!, 0, s);
      for (let e = 0; e < 3; e++) {
        const i0 = e, i1 = (e + 1) % 3;
        // bevel ring (outer → top) and glowing side walls (inner → outer)
        tri(outer[i0]!, outer[i1]!, top[i1]!, 0, s * 0.8); tri(outer[i0]!, top[i1]!, top[i0]!, 0, s * 0.8);
        tri(inner[i0]!, inner[i1]!, outer[i1]!, 1, s); tri(inner[i0]!, outer[i1]!, outer[i0]!, 1, s);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    const side = new Float32Array(glowSide), sh = new Float32Array(shade);
    let i = 0;
    return new GeoBuilder().add(g, () => {
      const isSide = side[i]! > 0.5, s = sh[i]!;
      i++;
      return isSide ? { color: GREEN, team: 0.2, accent: 0.75, rim: 0.4, rough: 0.3 } : { color: grey(s), rim: 1.2, rough: 0.27, metal: 0.12, glow: 0.04 };
    }).build();
  });
}
function omegaCore(): THREE.BufferGeometry {
  return cached('omega:core', () => {
    const nz = noise3(1510, 6, 2.2);
    return new GeoBuilder().add(blob(1.3, 4, 0.06, 2, 1511), (p) => {
      const swirl = smooth((0.5 + 0.5 * nz(p.x * 1.4, p.y * 1.4, p.z * 1.4) - 0.55) / 0.2);
      return { color: grey(0.8), glow: 1.0 - 0.5 * swirl, accent: 1.1 * swirl, rim: 0.6, rough: 0.3, wobble: 1.4 };
    }).build();
  });
}
function omegaSpike(): THREE.BufferGeometry {
  return cached('omega:spike', () => {
    const b = new GeoBuilder();
    b.add(cyl(0.035, 0.085, 1.0, 7, 4), (p) => ({ color: grey(0.55 + 0.3 * p.y), glow: 0.15 * p.y, rim: 1.2, rough: 0.35, wobble: 0.3 }));
    b.add(torus(0.1, 0.035, 6, 12), { color: grey(0.45), rim: 1, rough: 0.35 }, { p: [0, 0.03, 0], r: [Math.PI / 2, 0, 0] });
    b.add(blob(0.14, 2, 0.12, 3, 1520, [1, 1.25, 1]), { color: GREEN, team: 0, accent: 1.25, rim: 0.5, rough: 0.25, wobble: 0.6 }, { p: [0, 1.06, 0] });
    return b.build();
  });
}
function omegaSatellite(): THREE.BufferGeometry {
  return cached('omega:satellite', () => {
    const b = new GeoBuilder();
    b.add(blob(0.24, 2, 0.06, 3, 1530), { color: grey(0.85), glow: 0.55, rim: 1.4, rough: 0.3 });
    for (const d of fibonacciSphere(14, 0.3, 1531)) {
      b.add(cone(0.035, 0.16, 4), { color: grey(0.6), rim: 1 }, { p: d.clone().multiplyScalar(0.2), r: alignY(d) });
      b.add(ball(0.04, 5, 4), { color: GREEN, team: 0, accent: 1.2 }, { p: d.clone().multiplyScalar(0.37) });
    }
    return b.build();
  });
}
function omegaTentacle(): THREE.BufferGeometry {
  return cached('omega:tentacle', () => {
    const b = new GeoBuilder();
    const c = curve([[0, 0, 0], [0.45, -0.25, 0], [0.92, -0.85, 0], [1.2, -1.45, 0], [1.3, -1.78, 0]], 0.5);
    b.add(sweep(c, (t) => lerp(0.26, 0.07, Math.pow(t, 0.8)) * (1 + 0.1 * Math.sin(t * 30)), 9, 22), (p) => ({
      color: grey(0.42 + 0.2 * Math.max(0, Math.sin(p.x * 22))), accent: Math.sin(p.x * 22) > 0.8 ? 0.45 : 0, rim: 1.2, rough: 0.35, wobble: 0.4,
      whip: -clamp01(-p.y / 1.6) * 0.8,
    }));
    // suckers / glowing pads underneath
    for (let i = 0; i < 4; i++) {
      const t = 0.25 + i * 0.18;
      const p = c.getPoint(t);
      b.add(ball(0.06 - i * 0.008, 6, 4), { color: GREEN, team: 0, accent: 1.1 }, { p: [p.x + 0.05, p.y - 0.12 + i * 0.02, 0] });
    }
    return b.build();
  });
}
function omegaHalo(): THREE.BufferGeometry {
  return cached('omega:halo', () => {
    const b = new GeoBuilder();
    b.add(torus(2.35, 0.035, 5, 72), { color: GREEN, team: 0, accent: 1.1, rim: 0.3 }, { r: [Math.PI / 2, 0, 0] });
    b.add(torus(2.05, 0.028, 5, 64), { color: grey(1), team: 0.3, glow: 1.2, rim: 0.3 }, { r: [Math.PI / 2 + 0.5, 0.3, 0] });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      b.add(blob(0.07, 1, 0.1, 3, 1540 + i), { color: GREEN, team: 0, accent: 1.4 }, { p: [Math.cos(a) * 2.35, 0, Math.sin(a) * 2.35] });
    }
    return b.build();
  });
}

const N_SPIKES = 30, N_SAT = 6, N_TENT = 8;

export const buildStrainOmega: ModelBuilder = (ctx) => {
  const k = ctx.radius > 0 ? ctx.radius / OMEGA_R : 1;
  const rig = new Rig(`model:${ctx.defId}`, ctx.teamColor, false);
  rig.base.scale.setScalar(k);
  const torso = new THREE.Group();
  torso.position.y = TORSO_Y;
  rig.body.add(torso);
  const core = rig.mesh(omegaCore(), torso);
  const shellG = new THREE.Group();
  torso.add(shellG);
  rig.mesh(omegaShell(), shellG);
  const spikes = rig.instanced(omegaSpike(), N_SPIKES, shellG, 'flesh', 3.4);
  const haloG = new THREE.Group();
  torso.add(haloG);
  rig.mesh(omegaHalo(), haloG);
  const sats = rig.instanced(omegaSatellite(), N_SAT, torso, 'flesh', 4);
  const tents = rig.instanced(omegaTentacle(), N_TENT, rig.body, 'flesh', 4);

  // spike directions: skip the underside (tentacles) and the open maw
  const dirs = fibonacciSphere(N_SPIKES + 12, 0.25, 1550).filter((d) => d.y > -0.45 && !(d.x > 0.75 && d.y < 0.3)).slice(0, N_SPIKES);
  while (dirs.length < N_SPIKES) dirs.push(new THREE.Vector3(0, 1, 0));
  const spikeQ = dirs.map((d) => alignY(d));
  const rnd = seeded(ctx.seed);
  const spikePh = dirs.map(() => rnd() * TAU);
  const orbits = Array.from({ length: N_SAT }, (_, i) => ({
    r: 2.45 + (i % 3) * 0.28, tilt: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5 + (i % 3) * 0.45, (i % 3) * 2.1, 0.3 * (i % 2))),
    w: (0.55 + (i % 3) * 0.18) * (i % 2 ? -1 : 1), ph: (i / N_SAT) * TAU * 2 + rnd(),
  }));
  const hips = Array.from({ length: N_TENT }, (_, i) => (i / N_TENT) * TAU + TAU / 16);
  const muzzle = new THREE.Vector3(1.9, TORSO_Y + 0.1, 0).multiplyScalar(k);
  const ph = rnd() * TAU;
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let walk = 0, gait = rnd() * TAU, spin = rnd() * TAU;

  const pose = (st: { moving: boolean; speed: number; sinceAttack: number }, dt: number, time: number, death: number): void => {
    walk = damp(walk, st.moving && death <= 0 ? 1 : 0, 2.5, dt);
    gait += dt * Math.max(st.speed, st.moving ? 0.6 : 0) * 2.8;
    spin += dt * (0.16 + 0.12 * walk);
    const atk = death > 0 ? 0 : attackPulse(st.sinceAttack, 0.6);
    const burst = Math.sin(Math.min(1, atk * 1.4) * Math.PI * 0.5);
    const d = death;
    const collapse = easeIn(clamp01((d - 0.15) / 0.85));
    // torso: heave while walking, recoil on the torrent, sink + deflate on death
    torso.position.set(-0.12 * burst, TORSO_Y + 0.12 * Math.sin(gait * 2) * walk + 0.06 * Math.sin(time * 0.9 + ph) - 1.9 * collapse, 0);
    torso.rotation.set(0.05 * Math.sin(gait) * walk, 0, -0.06 * walk + 0.1 * burst);
    const beat = Math.pow(Math.max(0, Math.sin(time * 2.1 + ph)), 8);
    const cs = (1 + 0.035 * Math.sin(time * 1.7 + ph) + 0.06 * beat + 0.14 * burst) * (1 - 0.85 * collapse);
    core.scale.set(cs, cs, cs);
    shellG.rotation.set(0.08 * Math.sin(time * 0.4 + ph), spin, 0.06 * Math.sin(time * 0.5));
    const sh = (1 + 0.012 * Math.sin(time * 1.3 + ph) + 0.05 * burst + 0.35 * smooth(d / 0.5)) * (1 - 0.7 * collapse);
    shellG.scale.set(sh, sh, sh);
    haloG.rotation.set(0.25 * Math.sin(time * 0.3), -spin * 1.8, 0.2 * Math.cos(time * 0.27));
    const hs = 1 + 0.05 * burst - 0.9 * smooth(d / 0.4);
    haloG.scale.set(hs, hs, hs);
    haloG.visible = hs > 0.05;
    // mutating spikes: lengths drift independently; they flare on attack, retract on death
    for (let i = 0; i < N_SPIKES; i++) {
      const len = (0.72 + 0.22 * Math.sin(time * 1.1 + spikePh[i]!) + 0.12 * Math.sin(time * 2.9 + spikePh[i]! * 2.3) + 0.4 * burst) * (1 - smooth(d / 0.45));
      const w = 1 + 0.15 * Math.sin(time * 1.9 + spikePh[i]!);
      p.copy(dirs[i]!).multiplyScalar(SHELL_R + 0.08);
      setInstQ(spikes, i, p, spikeQ[i]!, s.set(w, Math.max(0.001, len), w));
    }
    spikes.instanceMatrix.needsUpdate = true;
    // satellites circle continuously (spiral in and drop on death)
    for (let i = 0; i < N_SAT; i++) {
      const o = orbits[i]!;
      const a = time * o.w + o.ph;
      const r = o.r * (1 - 0.6 * smooth(d / 0.7));
      p.set(Math.cos(a) * r, 0.25 * Math.sin(a * 2 + i), Math.sin(a) * r).applyQuaternion(o.tilt);
      p.y -= 2.2 * easeIn(clamp01((d - 0.3) / 0.7));
      q.setFromAxisAngle(up, a * 2.5);
      const sc = (1 + 0.1 * Math.sin(time * 3 + i)) * (1 - collapse);
      setInstQ(sats, i, p, q, s.set(sc, sc, sc));
    }
    sats.instanceMatrix.needsUpdate = true;
    // tentacles: walk cycle in two alternating groups, idle writhing, go limp on death
    for (let i = 0; i < N_TENT; i++) {
      const a = hips[i]!;
      const g = gait + (i % 2) * Math.PI;
      const swing = Math.sin(g) * 0.3 * walk + 0.08 * Math.sin(time * 1.3 + i * 1.9) * (1 - walk);
      const lift = Math.max(0, Math.cos(g)) * 0.28 * walk - 0.35 * collapse;
      const hy = TORSO_Y - 1.0 + 0.12 * Math.sin(gait * 2) * walk - 1.9 * collapse;
      setInst(tents, i, Math.cos(a) * 0.72, Math.max(0.2, hy), Math.sin(a) * 0.72, 0, -(a + swing), lift, 1, Math.max(0.3, hy) / (TORSO_Y - 1.0), 1);
    }
    tents.instanceMatrix.needsUpdate = true;
  };

  return {
    root: rig.root,
    height: 5.2 * k,
    muzzle,
    handlesDeath: true,
    update(st, dtRaw, time) {
      if (!rig.root.visible && st.death <= 0) return;
      const dt = Math.min(Math.max(dtRaw, 0), 0.1);
      rig.setVariant(unitVariant(st));
      const d = st.death > 0 ? Math.min(1, st.death) : 0;
      rig.body.scale.set(1, 1, 1);
      rig.body.position.set(0, 0, 0);
      if (d > 0.82) { const f = 1 - (d - 0.82) / 0.18; rig.body.scale.set(f, Math.max(0.02, f), f); }
      pose(st, dt, time, d);
    },
    dispose: () => rig.dispose(),
  };
};

void lin;
