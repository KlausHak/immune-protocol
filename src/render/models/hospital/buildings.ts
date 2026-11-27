/**
 * [models-hospital] Hospital buildings and the Supply Cache resource node.
 *
 * Origin = footprint centre on the ground, footprint w along X × h along Z. Entrances / unit exits face +Z
 * (sim +y, the side the default RTS camera looks at). Construction: a foundation slab + scaffold appear and
 * the merged building body rises out of the ground with progress (the terrain clips the part below);
 * finished buildings have no scaffold. Producing buildings spin their fans faster and blink beacons.
 */
import * as THREE from 'three';
import { tryGetDef } from '../../../data';
import type { EntityModel, ModelAnimState, ModelBuildContext, ModelBuilder } from '../types';
import { TAU, attackPulse, clamp01, dampAngle, easeInCubic, safeDt } from './anim';
import { band, fanGeo, fins, floors, hvac, parapet, roof, supplyCrate, windows, type Rect } from './arch';
import {
  Kit, atlasMat, bucket, fixFx, flashMat, fx, glowMat, glowRamp, makeMesh, memo, rampPick, rng, teamPal,
  type Sw, type TeamPal, type V3,
} from './kit';

type Geo = THREE.BufferGeometry;
interface Fp { w: number; h: number }

function footprintOf(ctx: ModelBuildContext, fallback: Fp): Fp {
  const def = tryGetDef(ctx.defId);
  const fp = ctx.footprint ?? (def && def.kind !== 'unit' ? def.footprint : undefined) ?? fallback;
  return { w: Math.max(1, fp.w), h: Math.max(1, fp.h) };
}

// ───────────────────────────── construction rig ─────────────────────────────

function scaffoldGeo(w: number, d: number, H: number): Geo {
  return memo(`scaffold:${w}x${d}x${H.toFixed(2)}`, () => {
    const k = new Kit();
    const hw = w / 2 - 0.07, hd = d / 2 - 0.07;
    const nx = Math.max(1, Math.round(w / 1.2)), nz = Math.max(1, Math.round(d / 1.2));
    for (let i = 0; i <= nx; i++) for (const z of [-hd, hd]) k.block('steel', [0.05, H, 0.05], [-hw + (2 * hw * i) / nx, 0, z]);
    for (let j = 1; j < nz; j++) for (const x of [-hw, hw]) k.block('steel', [0.05, H, 0.05], [x, 0, -hd + (2 * hd * j) / nz]);
    const levels = Math.max(1, Math.round(H / 0.8));
    for (let l = 1; l <= levels; l++) {
      const y = (H * l) / levels;
      k.box('scaffold', [2 * hw, 0.04, 0.04], [0, y, hd]); k.box('scaffold', [2 * hw, 0.04, 0.04], [0, y, -hd]);
      k.box('scaffold', [0.04, 0.04, 2 * hd], [hw, y, 0]); k.box('scaffold', [0.04, 0.04, 2 * hd], [-hw, y, 0]);
      if (l % 2 === 1) {
        k.box('plank', [2 * hw, 0.03, 0.16], [0, y - 0.035, hd]); k.box('plank', [2 * hw, 0.03, 0.16], [0, y - 0.035, -hd]);
      }
    }
    for (const z of [-hd, hd]) k.beam('scaffold', [-hw, 0.05, z], [hw, H - 0.05, z], 0.03, 0.03);
    for (const x of [-hw, hw]) k.beam('scaffold', [x, 0.05, -hd], [x, H - 0.05, hd], 0.03, 0.03);
    return k.merge();
  });
}

function slabGeo(w: number, d: number): Geo {
  return memo(`slab:${w}x${d}`, () => {
    const k = new Kit();
    k.block('concrete', [w - 0.04, 0.06, d - 0.04], [0, 0, 0]);
    const seg = 0.3;
    const edge = (len: number, place: (t: number, s: Sw) => void) => {
      const n = Math.max(2, Math.round(len / seg));
      for (let i = 0; i < n; i++) place(-len / 2 + (i + 0.5) * (len / n), i % 2 ? 'hazBlack' : 'hazYellow');
    };
    const sw = (len: number) => len / Math.max(2, Math.round(len / seg)) - 0.01;
    edge(w - 0.1, (t, s) => { k.box(s, [sw(w - 0.1), 0.012, 0.08], [t, 0.066, d / 2 - 0.08]); k.box(s, [sw(w - 0.1), 0.012, 0.08], [t, 0.066, -d / 2 + 0.08]); });
    edge(d - 0.26, (t, s) => { k.box(s, [0.08, 0.012, sw(d - 0.26)], [w / 2 - 0.08, 0.066, t]); k.box(s, [0.08, 0.012, sw(d - 0.26)], [-w / 2 + 0.08, 0.066, t]); });
    return k.merge();
  });
}

function workLightGeo(w: number, d: number): Geo {
  return memo(`worklights:${w}x${d}`, () => {
    const k = new Kit();
    for (const x of [-w / 2 + 0.07, w / 2 - 0.07]) for (const z of [-d / 2 + 0.07, d / 2 - 0.07]) k.box('white', [0.09, 0.09, 0.09], [x, 0.06, z]);
    return k.merge();
  });
}

interface Spinner { o: THREE.Object3D; idle: number; active: number }
interface Blinker { m: THREE.Mesh; on: THREE.Material; off: THREE.Material; rate: number; phase: number; mode: 'producing' | 'always' }

/**
 * Shared building behaviour: construction reveal, damage tint, death sink, fans and beacons.
 * `body` holds everything that belongs to the finished building.
 */
class BuildingRig {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly main: THREE.Mesh;
  readonly spinners: Spinner[] = [];
  readonly blinkers: Blinker[] = [];
  private readonly scaffold: THREE.Mesh;
  private readonly slab: THREE.Mesh;
  private readonly lights: THREE.Mesh;
  private readonly normal = atlasMat('struct');
  private readonly damaged = atlasMat('structDamaged');
  private readonly amberOn = glowMat(0xffa21f, 3.2, true);
  private readonly amberOff = glowMat(0x3a2406, 0.3, true);
  private first = true;
  private readonly scaffoldH: number;

  constructor(name: string, geo: Geo, fp: Fp, readonly height: number, sx = 1, sz = 1) {
    this.root.name = `model:${name}`;
    this.body.scale.set(sx, 1, sz);
    this.root.add(this.body);
    this.main = makeMesh(geo, this.normal, 'main');
    this.body.add(this.main);
    this.scaffoldH = Math.min(height + 0.3, Math.max(1.5, height * 0.8 + 0.4));
    this.scaffold = makeMesh(scaffoldGeo(fp.w, fp.h, this.scaffoldH), this.normal, 'scaffold');
    this.slab = makeMesh(slabGeo(fp.w, fp.h), this.normal, 'foundation');
    this.lights = fx(makeMesh(workLightGeo(fp.w, fp.h), this.amberOn, 'workLights'));
    this.root.add(this.slab, this.scaffold, this.lights);
  }

  addSpinner(o: THREE.Object3D, idle: number, active: number): void { this.spinners.push({ o, idle, active }); }
  addBlinker(m: THREE.Mesh, on: THREE.Material, off: THREE.Material, rate: number, mode: Blinker['mode'], phase = 0): void {
    fx(m); this.blinkers.push({ m, on, off, rate, phase, mode });
  }

  /** Returns true when the building is complete and alive (operational). */
  update(st: ModelAnimState, dt: number, time: number): boolean {
    if (this.first) { fixFx(this.root); this.first = false; }
    if (st.death > 0) {
      const d = clamp01(st.death);
      this.body.position.set(0, -(this.height + 0.2) * easeInCubic(d), 0);
      this.body.rotation.set(d * 0.05, 0, d * 0.07);
      this.main.material = this.damaged;
      this.scaffold.visible = this.slab.visible = this.lights.visible = false;
      for (const b of this.blinkers) b.m.material = b.off;
      return false;
    }
    const c = clamp01(Number.isFinite(st.construction) ? st.construction : 1);
    const building = c < 0.999;
    this.scaffold.visible = this.slab.visible = this.lights.visible = building;
    if (building) {
      this.body.position.set(0, -(this.height + 0.06) * (1 - c), 0);
      const s = 0.3 + 0.7 * clamp01(c * 1.3);
      this.scaffold.scale.set(1, s, 1);
      this.lights.position.y = this.scaffoldH * s;
      this.lights.material = Math.sin(time * 7) > 0 ? this.amberOn : this.amberOff;
    } else {
      this.body.position.set(0, 0, 0);
    }
    this.body.rotation.set(0, 0, 0);
    this.main.material = !building && st.hpFrac < 0.35 ? this.damaged : this.normal;
    const on = !building;
    for (const s of this.spinners) s.o.rotation.y += dt * (on ? (st.producing ? s.active : s.idle) : 0);
    for (const b of this.blinkers) {
      const active = on && (b.mode === 'always' || st.producing);
      b.m.material = active && Math.sin(time * b.rate * TAU + b.phase) > 0.2 ? b.on : b.off;
    }
    return on;
  }
}

function fanMesh(r: number, at: V3): THREE.Mesh {
  const m = makeMesh(fanGeo(r), atlasMat('struct'), 'fan');
  m.position.set(...at);
  return m;
}

const beaconGeo = (): Geo => memo('beacon', () => {
  const k = new Kit();
  k.cyl('white', 0.06, 0.07, 0.1, 10, [0, 0.05, 0]);
  k.sphere('white', 0.06, [0, 0.11, 0], 1, 8, 5);
  return k.merge();
});

function beaconMesh(at: V3, s = 1): THREE.Mesh {
  const m = makeMesh(beaconGeo(), atlasMat('struct'), 'beacon');
  m.position.set(...at); m.scale.setScalar(s);
  return m;
}

function buildingGeo<T>(id: string, ctx: ModelBuildContext, build: (team: TeamPal) => T): T {
  const team = teamPal(ctx.faction === 'neutral' ? 0x2fd6c6 : ctx.teamColor);
  return memo(`bld:${id}:${team.key}`, () => build(team));
}

/** Scale factors if a def footprint differs from the designed one. */
const fit = (fp: Fp, w: number, h: number): [number, number] => [fp.w / w, fp.h / h];

const plainModel = (rig: BuildingRig, extra?: (st: ModelAnimState, dt: number, time: number, on: boolean) => void): EntityModel => ({
  root: rig.root, height: rig.height, handlesDeath: true,
  update(st, dtRaw, time) { const dt = safeDt(dtRaw); const on = rig.update(st, dt, time); extra?.(st, dt, time, on); },
  dispose() { rig.root.clear(); },
});

// ───────────────────────────── Central Hospital (HQ) 5×5 ─────────────────────────────

const HQ_TOWER: Rect = { cx: -0.4, cz: -0.55, sx: 3.5, sz: 3.2 };

function hqGeo(team: TeamPal) {
  const k = new Kit(team); const rnd = rng(501);
  k.block('concrete', [4.92, 0.12, 4.92], [0, 0, 0]);
  k.box('concreteLight', [4.7, 0.02, 0.66], [0, 0.13, 2.13]);
  // podium (lobby floor)
  const pod: Rect = { cx: 0, cz: -0.2, sx: 4.6, sz: 4.0 };
  k.block('ivory', [pod.sx, 1.5, pod.sz], [pod.cx, 0.12, pod.cz]);
  band(k, pod, 1.52, 0.1, 'offwhite', 0.03);
  windows(k, pod, '+z', 0.22, { h: 0.92, pane: 0.42, lit: 0.6, cool: 0.2, glass: 'winCyan', margin: 0.15 }, rnd);
  floors(k, pod, ['-z', '+x'], [0.42], { h: 0.62, pane: 0.5, lit: 0.45 }, rnd);
  windows(k, pod, '-x', 0.42, { h: 0.62, pane: 0.5, lit: 0.45, from: 0, to: 0.55 }, rnd);
  k.box('roofDark', [4.5, 0.02, 3.9], [pod.cx, 1.63, pod.cz]);
  // tower (3 ward floors)
  const T = HQ_TOWER;
  k.block('ivory', [T.sx, 3.3, T.sz], [T.cx, 1.62, T.cz]);
  for (let f = 0; f < 3; f++) {
    const y = 1.62 + 0.3 + f * 1.02;
    floors(k, T, ['-z', '+x', '-x'], [y], { h: 0.6, pane: 0.42, lit: 0.42, cool: 0.18 }, rnd);
    windows(k, T, '+z', y, { h: 0.6, pane: 0.42, lit: 0.42, cool: 0.18, from: 0, to: 0.56 }, rnd);
    band(k, T, y - 0.14, 0.05, 'offwhite', 0.015);
  }
  band(k, T, 4.73, 0.16, 'team', 0.03);
  parapet(k, T, 4.92, 0.14, 0.1, 'offwhite');
  roof(k, T, 4.92);
  // the hospital's teal "+" lightbox on the tower front
  k.box('white', [1.1, 1.1, 0.08], [0.76, 3.95, 1.09]);
  k.plus('tealGlow', 0.86, 0.28, 0.05, [0.76, 3.95, 1.15], '+z');
  k.box('white', [0.08, 0.9, 0.9], [1.39, 3.95, 0.35]);
  k.plus('tealGlow', 0.7, 0.23, 0.05, [1.44, 3.95, 0.35], '+x');
  // entrance canopy
  k.box('white', [2.5, 0.09, 0.68], [0.15, 1.2, 2.12]);
  k.box('team', [2.52, 0.09, 0.05], [0.15, 1.2, 2.44]);
  for (const x of [-0.95, 1.25]) k.post('steel', 0.035, 1.1, [x, 0.13, 2.33], 8);
  k.quad('winCyan', 1.0, 0.85, [0.15, 0.56, 1.815], '+z');
  // supply drop-off dock (−X side): roll-up door, bollards, crates
  k.quad('darkGrey', 1.1, 0.95, [-2.305, 0.6, 0.95], '-x');
  for (let i = 0; i < 5; i++) k.quad('graphite', 1.08, 0.025, [-2.31, 0.25 + i * 0.18, 0.95], '-x');
  k.box('hazYellow', [0.02, 0.06, 1.16], [-2.31, 1.1, 0.95]);
  for (const z of [0.25, 1.65]) k.post('hazYellow', 0.05, 0.4, [-2.42, 0.12, z], 8);
  supplyCrate(k, -1.95, 0.13, 1.95, 0.42, 'ivory', 0.3);
  supplyCrate(k, -1.5, 0.13, 2.1, 0.36, 'cardboard', -0.2);
  // podium roof plant + helipad on the tower
  const fanA = hvac(k, 1.86, 1.64, -1.35, 0.72, 0.9, 0.42, 0.26);
  const fanB = hvac(k, 1.86, 1.64, 0.15, 0.72, 0.9, 0.42, 0.26);
  for (const x of [-0.8, 0.8]) for (const z of [-0.8, 0.8]) k.block('steelDark', [0.1, 0.16, 0.1], [T.cx + x, 4.94, T.cz + z]);
  k.cyl('steelDark', 1.36, 1.36, 0.08, 28, [T.cx, 5.14, T.cz]);
  k.cyl('charcoal', 1.29, 1.29, 0.02, 28, [T.cx, 5.19, T.cz]);
  k.ring('white', 0.98, 1.08, [T.cx, 5.205, T.cz], 32);
  k.text('white', 'H', 0.12, 0.02, [T.cx, 5.21, T.cz], '+y');
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    k.box('greenGlow', [0.07, 0.05, 0.07], [T.cx + Math.cos(a) * 1.3, 5.2, T.cz + Math.sin(a) * 1.3]);
  }
  k.post('steel', 0.03, 0.62, [1.22, 4.92, 0.92], 6);
  return { geo: k.merge(), fans: [fanA, fanB], beacon: [1.22, 5.54, 0.92] as V3 };
}

function hq(ctx: ModelBuildContext): EntityModel {
  const fp = footprintOf(ctx, { w: 5, h: 5 });
  const g = buildingGeo('hosp_hq', ctx, hqGeo);
  const rig = new BuildingRig('hosp_hq', g.geo, fp, 5.6, ...fit(fp, 5, 5));
  for (const f of g.fans) { const m = fanMesh(0.25, f); rig.body.add(m); rig.addSpinner(m, 2.5, 9); }
  const bcn = beaconMesh(g.beacon); rig.body.add(bcn);
  rig.addBlinker(bcn, glowMat(0xff3326, 3.4, true), glowMat(0x5a0d08, 0.6, true), 0.9, 'always');
  const pr = beaconMesh([1.86, 2.2, 1.0], 0.8); rig.body.add(pr);
  rig.addBlinker(pr, glowMat(0x2fe8d8, 3.4, true), glowMat(0x0c3a36, 0.4, true), 2.2, 'producing');
  return plainModel(rig);
}

// ───────────────────────────── Patient Ward 2×2 ─────────────────────────────

function wardGeo(team: TeamPal) {
  const k = new Kit(team); const rnd = rng(502);
  k.block('concrete', [1.95, 0.08, 1.95], [0, 0, 0]);
  const m1: Rect = { cx: 0, cz: -0.1, sx: 1.8, sz: 1.55 };
  const m2: Rect = { cx: 0.04, cz: -0.1, sx: 1.8, sz: 1.55 };
  k.block('ivory', [m1.sx, 0.84, m1.sz], [m1.cx, 0.08, m1.cz]);
  k.block('graphite', [1.76, 0.05, 1.5], [0, 0.92, -0.1]);
  k.block('white', [m2.sx, 0.84, m2.sz], [m2.cx, 0.97, m2.cz]);
  band(k, m1, 0.75, 0.1, 'team', 0.02);
  band(k, m2, 1.64, 0.1, 'team', 0.02);
  for (const [r, y] of [[m1, 0.3], [m2, 1.19]] as const) {
    windows(k, r, '+z', y, { h: 0.34, pane: 0.4, lit: 0.7, cool: 0.1, from: 0, to: 0.62 }, rnd);
    windows(k, r, '-z', y, { h: 0.34, pane: 0.4, lit: 0.7, cool: 0.1 }, rnd);
    windows(k, r, '-x', y, { h: 0.34, pane: 0.45, lit: 0.7 }, rnd);
  }
  windows(k, m1, '+x', 0.3, { h: 0.34, pane: 0.45, lit: 0.6 }, rnd);
  // entrance door + canopy + ramp
  k.quad('glassBlue', 0.34, 0.6, [0.6, 0.39, 0.6555], '+z');
  k.box('white', [0.56, 0.04, 0.28], [0.6, 0.76, 0.79]);
  k.block('concreteLight', [0.56, 0.05, 0.3], [0.6, 0.08, 0.8]);
  // "+" sign on the upper module
  k.box('team', [0.03, 0.46, 0.46], [0.955, 1.36, -0.1]);
  k.plus('white', 0.34, 0.11, 0.02, [0.975, 1.36, -0.1], '+x');
  // roof: AC unit + skylight
  roof(k, m2, 1.81);
  const fan = hvac(k, -0.45, 1.82, -0.45, 0.5, 0.5, 0.22, 0.17);
  k.block('glass', [0.5, 0.07, 0.34], [0.42, 1.82, -0.35]);
  k.block('steel', [0.54, 0.03, 0.38], [0.42, 1.89, -0.35]);
  return { geo: k.merge(), fan };
}

function ward(ctx: ModelBuildContext): EntityModel {
  const fp = footprintOf(ctx, { w: 2, h: 2 });
  const g = buildingGeo('hosp_ward', ctx, wardGeo);
  const rig = new BuildingRig('hosp_ward', g.geo, fp, 2.1, ...fit(fp, 2, 2));
  const m = fanMesh(0.16, g.fan); rig.body.add(m); rig.addSpinner(m, 3, 6);
  return plainModel(rig);
}

// ───────────────────────────── Backup Generator 2×2 ─────────────────────────────

function generatorGeo(team: TeamPal) {
  const k = new Kit(team);
  k.block('concrete', [1.95, 0.12, 1.95], [0, 0, 0]);
  const hs: Rect = { cx: 0.0, cz: 0.32, sx: 1.6, sz: 1.0 };
  k.block('panel', [hs.sx, 0.95, hs.sz], [hs.cx, 0.12, hs.cz]);
  k.block('ivory', [hs.sx + 0.03, 0.07, hs.sz + 0.03], [hs.cx, 1.07, hs.cz]);
  band(k, hs, 0.86, 0.09, 'team', 0.015);
  for (let i = 0; i < 6; i++) k.quad('graphite', 0.62, 0.035, [0.35, 0.3 + i * 0.075, 0.8215], '+z');
  k.quad('charcoal', 0.75, 0.6, [-0.802, 0.55, 0.32], '-x');
  for (let i = 0; i < 7; i++) k.quad('steelDark', 0.03, 0.58, [-0.808, 0.55, 0.32 - 0.33 + i * 0.11], '-x');
  k.quad('screen', 0.26, 0.15, [0.8015, 0.72, 0.42], '+x');
  k.box('hazYellow', [0.012, 0.16, 0.16], [0.806, 0.48, 0.12]);
  k.quad('hazBlack', 0.06, 0.1, [0.8135, 0.48, 0.12], '+x');
  k.quad('graphite', 0.42, 0.62, [-0.3, 0.5, 0.8215], '+z');
  // fan shroud on top
  k.cyl('steel', 0.36, 0.36, 0.1, 20, [-0.32, 1.19, 0.32], undefined, undefined, true);
  k.cyl('charcoal', 0.32, 0.32, 0.02, 20, [-0.32, 1.15, 0.32]);
  // exhaust stacks
  for (const z of [0.18, 0.5]) {
    k.post('steel', 0.065, 0.95, [0.5, 1.14, z], 10);
    k.cyl('steelDark', 0.1, 0.09, 0.04, 10, [0.5, 2.11, z]);
    k.post('charcoal', 0.05, 0.02, [0.5, 2.09, z], 8);
  }
  // fuel tank on saddles
  k.cyl('white', 0.3, 0.3, 1.45, 16, [0, 0.52, -0.58], [0, 0, Math.PI / 2]);
  for (const x of [-0.725, 0.725]) k.sphere('white', 0.3, [x, 0.52, -0.58], [0.25, 1, 1], 12, 8);
  for (const x of [-0.45, 0.45]) {
    k.cyl('hazYellow', 0.305, 0.305, 0.09, 16, [x, 0.52, -0.58], [0, 0, Math.PI / 2]);
    k.block('concreteDark', [0.18, 0.24, 0.5], [x, 0.12, -0.58]);
  }
  k.rod('steelDark', [0.2, 0.75, -0.4], [0.2, 0.75, -0.18], 0.035);
  k.rod('steelDark', [0.2, 0.75, -0.18], [0.2, 0.45, -0.18], 0.035);
  k.cyl('team', 0.305, 0.305, 0.12, 16, [0, 0.52, -0.58], [0, 0, Math.PI / 2]);
  return { geo: k.merge(), fan: [-0.32, 1.17, 0.32] as V3 };
}

function generator(ctx: ModelBuildContext): EntityModel {
  const fp = footprintOf(ctx, { w: 2, h: 2 });
  const g = buildingGeo('hosp_generator', ctx, generatorGeo);
  const rig = new BuildingRig('hosp_generator', g.geo, fp, 2.15, ...fit(fp, 2, 2));
  const m = fanMesh(0.3, g.fan); rig.body.add(m); rig.addSpinner(m, 11, 14);
  const led = beaconMesh([0.62, 1.12, 0.62], 0.6); rig.body.add(led);
  rig.addBlinker(led, glowMat(0x37ff7a, 3.2, true), glowMat(0x0d3a1a, 0.5, true), 0.7, 'always');
  return plainModel(rig);
}

// ───────────────────────────── Pharmacy 3×3 ─────────────────────────────

function pharmacyGeo(team: TeamPal) {
  const k = new Kit(team); const rnd = rng(503);
  k.block('concrete', [2.95, 0.1, 2.95], [0, 0, 0]);
  const b: Rect = { cx: 0, cz: -0.22, sx: 2.72, sz: 2.4 };
  k.block('ivory', [b.sx, 1.95, b.sz], [b.cx, 0.1, b.cz]);
  // shop front (+Z): big glazing + door, canopy with team fascia
  windows(k, b, '+z', 0.2, { h: 1.0, pane: 0.5, lit: 0.75, cool: 0.15, to: 0.72, margin: 0.14 }, rnd);
  k.quad('frame', 0.5, 1.0, [0.95, 0.68, 0.986], '+z');
  k.quad('winCyan', 0.42, 0.92, [0.95, 0.66, 0.992], '+z');
  k.box('white', [2.66, 0.07, 0.5], [0, 1.36, 1.2]);
  k.box('team', [2.68, 0.13, 0.06], [0, 1.36, 1.45]);
  floors(k, b, ['+z', '-z', '-x'], [1.5], { h: 0.32, pane: 0.42, lit: 0.4 }, rnd);
  windows(k, b, '+x', 1.5, { h: 0.32, pane: 0.42, lit: 0.4, from: 0.5, to: 1 }, rnd);
  parapet(k, b, 2.05, 0.15, 0.1, 'team');
  roof(k, b, 2.05);
  // green pharmacy cross on the side facade
  k.box('white', [0.06, 0.8, 0.8], [1.39, 1.15, -0.55]);
  k.plus('greenGlow', 0.62, 0.21, 0.05, [1.43, 1.15, -0.55], '+x');
  // dispensing hatch (+X)
  k.quad('darkGrey', 0.7, 0.7, [1.362, 0.48, 0.45], '+x');
  for (let i = 0; i < 5; i++) k.quad('graphite', 0.68, 0.02, [1.366, 0.2 + i * 0.13, 0.45], '+x');
  k.box('team', [0.08, 0.05, 0.8], [1.39, 0.86, 0.45]);
  // roof plant + sign pylon
  const fan = hvac(k, -0.78, 2.07, -0.85, 0.62, 0.62, 0.3, 0.21);
  k.block('glass', [0.7, 0.08, 0.5], [0.0, 2.07, -0.75]);
  k.post('steel', 0.06, 0.55, [0.85, 2.06, 0.55], 8);
  k.block('steelDark', [0.3, 0.06, 0.3], [0.85, 2.06, 0.55]);
  return { geo: k.merge(), fan, sign: [0.85, 2.98, 0.55] as V3 };
}

const pharmCrossGeo = (): Geo => memo('pharmCross', () => {
  const k = new Kit();
  // a 3D cross lightbox (reads from any angle): two "+" slabs crossing, white edges
  k.plus('greenGlow', 0.78, 0.26, 0.2, [0, 0, 0], '+z');
  k.plus('greenGlow', 0.78, 0.26, 0.2, [0, 0, 0], '+x');
  k.box('white', [0.3, 0.04, 0.3], [0, -0.4, 0]);
  return k.merge();
});

function pharmacy(ctx: ModelBuildContext): EntityModel {
  const fp = footprintOf(ctx, { w: 3, h: 3 });
  const g = buildingGeo('hosp_pharmacy', ctx, pharmacyGeo);
  const rig = new BuildingRig('hosp_pharmacy', g.geo, fp, 3.4, ...fit(fp, 3, 3));
  const m = fanMesh(0.2, g.fan); rig.body.add(m); rig.addSpinner(m, 3, 8);
  const cross = makeMesh(pharmCrossGeo(), atlasMat('struct'), 'cross'); cross.position.set(...g.sign);
  rig.body.add(cross);
  return plainModel(rig, (st, dt, _t, on) => { if (on) cross.rotation.y += dt * (st.producing ? 1.6 : 0.25); });
}

// ───────────────────────────── Research Lab 3×3 ─────────────────────────────

function labGeo(team: TeamPal) {
  const k = new Kit(team); const rnd = rng(504);
  k.block('concrete', [2.95, 0.1, 2.95], [0, 0, 0]);
  const b: Rect = { cx: -0.36, cz: -0.1, sx: 2.1, sz: 2.6 };
  k.block('offwhite', [b.sx, 2.0, b.sz], [b.cx, 0.1, b.cz]);
  floors(k, b, ['+z', '-z'], [0.35, 1.25], { h: 0.5, pane: 0.3, lit: 0.35, cool: 0.35, coolSw: 'winCyan' }, rnd);
  floors(k, b, ['-x'], [0.35, 1.25], { h: 0.5, pane: 0.35, lit: 0.3, cool: 0.4, coolSw: 'winCyan' }, rnd);
  fins(k, b, '+z', 0.12, 1.92, 0.3, 'steel', 0.12, 0.05);
  fins(k, b, '-z', 0.12, 1.92, 0.3, 'steel', 0.12, 0.05);
  band(k, b, 1.9, 0.12, 'team', 0.02);
  parapet(k, b, 2.1, 0.12, 0.08, 'offwhite');
  roof(k, b, 2.1);
  // glass atrium (+X) with mullions
  const at: Rect = { cx: 1.08, cz: 0.0, sx: 0.74, sz: 2.2 };
  k.block('glass', [at.sx, 2.28, at.sz], [at.cx, 0.1, at.cz]);
  for (let i = 0; i <= 6; i++) k.block('steel', [0.04, 2.28, 0.04], [at.cx + at.sx / 2 + 0.01, 0.1, -1.1 + i * (2.2 / 6)]);
  for (const y of [0.85, 1.6]) k.box('steel', [0.04, 0.04, 2.2], [at.cx + at.sx / 2 + 0.01, y, 0]);
  for (let i = 0; i <= 2; i++) k.block('steel', [0.04, 2.28, 0.04], [at.cx - 0.36 + i * 0.36, 0.1, at.sz / 2 + 0.01]);
  k.block('steel', [at.sx + 0.04, 0.06, at.sz + 0.04], [at.cx, 2.38, at.cz]);
  k.quad('winWarm', 0.5, 0.5, [at.cx, 0.62, at.sz / 2 + 0.03], '+z');
  // rooftop bioreactor, fume stacks, dish
  k.post('white', 0.42, 0.85, [-0.75, 2.1, -0.45], 18);
  k.dome('white', 0.42, [-0.75, 2.95, -0.45], [1, 0.45, 1], 18, 5);
  k.post('steel', 0.04, 0.35, [-0.75, 3.1, -0.45], 6);
  for (const x of [0.05, 0.3, 0.55]) {
    k.post('steel', 0.055, 0.78, [x, 2.1, -1.05], 8);
    k.cyl('steelDark', 0.075, 0.075, 0.05, 8, [x, 2.9, -1.05]);
  }
  k.rod('steelDark', [0.0, 2.25, -1.05], [0.6, 2.25, -1.05], 0.03);
  k.post('steelDark', 0.05, 0.25, [-0.1, 2.1, 0.65], 6);
  k.dome('white', 0.34, [-0.1, 2.55, 0.65], [1, 0.4, 1], 14, 4, Math.PI / 2, [0.6, 0, -0.5]);
  const fan = hvac(k, 0.45, 2.12, 0.55, 0.5, 0.5, 0.24, 0.17);
  return { geo: k.merge(), fan };
}

const labRingsGeo = (): Geo => memo('labRings', () => {
  const k = new Kit();
  for (const y of [2.35, 2.62, 2.89]) k.cyl('white', 0.435, 0.435, 0.07, 18, [-0.75, y, -0.45]);
  return k.merge();
});

function lab(ctx: ModelBuildContext): EntityModel {
  const fp = footprintOf(ctx, { w: 3, h: 3 });
  const g = buildingGeo('hosp_lab', ctx, labGeo);
  const rig = new BuildingRig('hosp_lab', g.geo, fp, 3.2, ...fit(fp, 3, 3));
  const m = fanMesh(0.16, g.fan); rig.body.add(m); rig.addSpinner(m, 3, 9);
  const ramp = glowRamp(0x45e6ff, 0.3, 3.4, true);
  const rings = fx(makeMesh(labRingsGeo(), ramp[2]!, 'bioreactor'));
  rig.body.add(rings);
  return plainModel(rig, (st, _dt, time, on) => {
    const p = 0.5 + 0.5 * Math.sin(time * (st.producing ? 4.5 : 1.2));
    rings.material = rampPick(ramp, on ? (st.producing ? 0.45 + 0.55 * p : 0.2 + 0.15 * p) : 0);
  });
}

// ───────────────────────────── Ambulance Depot 4×4 ─────────────────────────────

const BAY_DOORS = [-0.28, 1.18];

function vehicleBayGeo(team: TeamPal) {
  const k = new Kit(team); const rnd = rng(505);
  k.block('concrete', [3.95, 0.1, 3.95], [0, 0, 0]);
  const hall: Rect = { cx: 0.45, cz: -0.25, sx: 3.0, sz: 3.3 };
  k.block('ivory', [hall.sx, 2.2, hall.sz], [hall.cx, 0.1, hall.cz]);
  const ann: Rect = { cx: -1.5, cz: -0.25, sx: 0.9, sz: 3.3 };
  k.block('white', [ann.sx, 2.55, ann.sz], [ann.cx, 0.1, ann.cz]);
  floors(k, ann, ['+z', '-x', '-z'], [0.4, 1.5], { h: 0.5, pane: 0.4, lit: 0.55, cool: 0.15 }, rnd);
  parapet(k, ann, 2.65, 0.1, 0.07, 'team');
  roof(k, ann, 2.65);
  floors(k, hall, ['-z', '+x'], [1.45], { h: 0.4, pane: 0.5, lit: 0.3, cool: 0.2 }, rnd);
  band(k, hall, 1.9, 0.16, 'team', 0.025);
  parapet(k, hall, 2.3, 0.1, 0.08, 'offwhite');
  roof(k, hall, 2.3);
  // garage door frames + lit interiors (+Z face at z = 1.4)
  const fz = hall.cz + hall.sz / 2;
  for (const x of BAY_DOORS) {
    k.quad('graphite', 1.3, 1.6, [x, 0.9, fz + 0.005], '+z');
    k.quad('winWarm', 1.16, 1.48, [x, 0.84, fz + 0.01], '+z');
    k.block('hazYellow', [0.06, 1.55, 0.06], [x - 0.63, 0.1, fz + 0.03]);
    k.block('hazYellow', [0.06, 1.55, 0.06], [x + 0.63, 0.1, fz + 0.03]);
    for (let i = 0; i < 4; i++) k.box(i % 2 ? 'hazBlack' : 'hazYellow', [0.24, 0.012, 0.1], [x - 0.36 + i * 0.24, 0.106, fz + 0.3]);
  }
  k.box('team', [0.72, 0.36, 0.04], [0.45, 1.98, fz + 0.04]);
  k.plus('white', 0.28, 0.09, 0.02, [0.45, 1.98, fz + 0.065], '+z');
  // roof: skylights + drone pad + fan
  for (const z of [-1.3, -0.65]) { k.block('glass', [2.4, 0.07, 0.3], [0.45, 2.3, z]); k.block('steel', [2.44, 0.025, 0.34], [0.45, 2.37, z]); }
  k.cyl('charcoal', 0.62, 0.62, 0.04, 24, [0.75, 2.33, 0.6]);
  k.ring('white', 0.44, 0.52, [0.75, 2.355, 0.6], 28);
  k.plus('white', 0.42, 0.08, 0.01, [0.75, 2.36, 0.6], '+y');
  const fan = hvac(k, -0.55, 2.32, 0.65, 0.5, 0.5, 0.24, 0.17);
  // parked ambulance beside the depot (+X apron)
  return { geo: k.merge(), fan, doorZ: fz };
}

const shutterGeo = (): Geo => memo('bayShutter', () => {
  const k = new Kit();
  for (const x of BAY_DOORS) {
    k.block('panel', [1.18, 1.48, 0.04], [x, 0, 0]);
    for (let i = 1; i < 9; i++) k.box('grey', [1.18, 0.02, 0.045], [x, i * 0.165, 0]);
    k.box('steelDark', [1.18, 0.06, 0.05], [x, 0.03, 0]);
  }
  return k.merge();
});

const bayBeaconGeo = (): Geo => memo('bayBeacons', () => {
  const k = new Kit();
  for (const x of [-1.0, 1.9]) { k.box('white', [0.14, 0.09, 0.14], [x, 0.045, 0]); }
  return k.merge();
});

function vehicleBay(ctx: ModelBuildContext): EntityModel {
  const fp = footprintOf(ctx, { w: 4, h: 4 });
  const g = buildingGeo('hosp_vehicle_bay', ctx, vehicleBayGeo);
  const rig = new BuildingRig('hosp_vehicle_bay', g.geo, fp, 2.75, ...fit(fp, 4, 4));
  const m = fanMesh(0.16, g.fan); rig.body.add(m); rig.addSpinner(m, 3, 9);
  const shutter = makeMesh(shutterGeo(), atlasMat('struct'), 'shutters');
  shutter.position.set(0, 0.1, g.doorZ + 0.03);
  rig.body.add(shutter);
  const bcn = makeMesh(bayBeaconGeo(), atlasMat('struct'), 'beacons'); bcn.position.set(0, 2.4, g.doorZ - 0.12);
  rig.body.add(bcn);
  rig.addBlinker(bcn, glowMat(0x3e7bff, 3.8, true), glowMat(0x0d1a3d, 0.5, true), 2.4, 'producing');
  let open = 0;
  return plainModel(rig, (st, dt, _t, on) => {
    open += ((on && st.producing ? 1 : 0) - open) * Math.min(1, dt * 1.5);
    // shutter rolls up into the lintel
    shutter.scale.y = 1 - 0.85 * open;
    shutter.position.y = 0.1 + 1.48 * 0.85 * open;
  });
}

// ───────────────────────────── UV Turret 2×2 ─────────────────────────────

const TUR_HEAD: V3 = [0, 1.86, 0];

function turretGeo(team: TeamPal) {
  const k = new Kit(team);
  k.frustum('concrete', 1.85, 1.85, 1.45, 1.45, 0.32, [0, 0, 0]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) k.box('hazYellow', [0.22, 0.03, 0.22], [x * 0.62, 0.33, z * 0.62]);
  k.post('steelDark', 0.62, 0.12, [0, 0.32, 0], 16);
  k.post('team', 0.5, 0.08, [0, 0.44, 0], 16);
  k.post('steel', 0.2, 1.32, [0, 0.5, 0], 12, 0.16);
  k.post('team', 0.185, 0.1, [0, 1.25, 0], 12);
  k.rod('rubber', [0.21, 0.55, 0.08], [0.17, 1.55, 0.06], 0.025);
  k.post('steelDark', 0.22, 0.06, [0, 1.8, 0], 14);
  const h = new Kit(team);
  h.box('ivory', [0.78, 0.4, 0.56], [0.02, 0.12, 0]);
  h.box('graphite', [0.8, 0.06, 0.58], [0.02, -0.07, 0]);
  for (const s of [-1, 1]) {
    h.box('team', [0.6, 0.22, 0.02], [0.0, 0.13, 0.285 * s]);
    for (let i = 0; i < 4; i++) h.box('graphite', [0.04, 0.3, 0.06], [-0.28 + i * 0.07, 0.12, 0.3 * s]);
  }
  h.cyl('steelDark', 0.19, 0.2, 0.26, 14, [0.5, 0.12, 0], [0, 0, Math.PI / 2]);
  h.cyl('graphite', 0.21, 0.21, 0.04, 14, [0.63, 0.12, 0], [0, 0, Math.PI / 2]);
  h.box('graphite', [0.2, 0.3, 0.42], [-0.42, 0.1, 0]);
  h.dome('steel', 0.12, [-0.12, 0.32, 0], 1, 10, 4);
  h.post('steel', 0.012, 0.3, [-0.3, 0.32, 0.18], 4);
  h.box('screen', [0.03, 0.05, 0.12], [0.41, 0.28, 0]);
  return { base: k.merge(), head: h.merge() };
}

function uvTurret(ctx: ModelBuildContext): EntityModel {
  const fp = footprintOf(ctx, { w: 2, h: 2 });
  const g = buildingGeo('hosp_uv_turret', ctx, turretGeo);
  const [sx, sz] = fit(fp, 2, 2);
  const rig = new BuildingRig('hosp_uv_turret', g.base, fp, 2.4, sx, sz);
  const head = makeMesh(g.head, atlasMat('struct'), 'head'); head.position.set(...TUR_HEAD);
  const ramp = glowRamp(0xb05cff, 0.6, 4, true);
  const lens = fx(makeMesh(memo('fx:turLens', () => new THREE.CylinderGeometry(0.15, 0.15, 0.04, 14).rotateZ(Math.PI / 2)), ramp[1]!, 'lens'));
  lens.position.set(0.655, 0.12, 0);
  const flash = fx(makeMesh(memo('fx:spark', () => new THREE.IcosahedronGeometry(0.06, 0)), flashMat(0xc890ff, 2), 'flash'));
  flash.position.set(0.72, 0.12, 0); flash.visible = false;
  head.add(lens, flash);
  rig.body.add(head);
  let yaw = 0;
  const muzzle = new THREE.Vector3();
  const setMuzzle = () => muzzle.set(Math.cos(yaw) * 0.72 * sx, TUR_HEAD[1] + 0.12, -Math.sin(yaw) * 0.72 * sz);
  setMuzzle();
  const scanPhase = (ctx.seed % 11) * 0.6;
  return {
    root: rig.root, height: rig.height, muzzle, handlesDeath: true,
    update(st, dtRaw, time) {
      const dt = safeDt(dtRaw);
      const on = rig.update(st, dt, time);
      if (!on) { flash.visible = false; lens.material = ramp[0]!; return; }
      const target = st.aimAngle != null ? -(st.aimAngle - st.facing) : Math.sin(time * 0.35 + scanPhase) * 1.4;
      yaw = dampAngle(yaw, target, st.aimAngle != null ? 7 : 1.5, dt);
      head.rotation.y = yaw;
      const k = attackPulse(st.sinceAttack, 0.18);
      head.position.set(TUR_HEAD[0] - Math.cos(yaw) * 0.06 * k, TUR_HEAD[1], Math.sin(yaw) * 0.06 * k);
      const engaged = st.aimAngle != null || st.sinceAttack < 1.2;
      lens.material = rampPick(ramp, Math.max(k, engaged ? 0.55 + 0.15 * Math.sin(time * 9) : 0.3 + 0.1 * Math.sin(time * 2)));
      flash.visible = k > 0;
      if (k > 0) flash.scale.setScalar(1.5 + (1 - k) * 2.5);
      setMuzzle();
    },
    dispose() { rig.root.clear(); },
  };
}

// ───────────────────────────── Quarantine Barricade 2×2 ─────────────────────────────

function barricadeGeo(team: TeamPal) {
  const k = new Kit(team);
  k.frustum('concreteDark', 1.96, 1.96, 1.84, 1.84, 0.36, [0, 0, 0]);
  // hazard chevrons around the base
  for (const face of ['+z', '-z', '+x', '-x'] as const) {
    for (let i = 0; i < 6; i++) {
      const t = -0.75 + i * 0.3;
      const s: Sw = i % 2 ? 'hazBlack' : 'hazYellow';
      const e = 0.963;
      const p: V3 = face === '+z' ? [t, 0.18, e] : face === '-z' ? [t, 0.18, -e] : face === '+x' ? [e, 0.18, t] : [-e, 0.18, t];
      k.quad(s, 0.29, 0.14, p, face);
    }
  }
  const w: Rect = { cx: 0, cz: 0, sx: 1.72, sz: 1.72 };
  k.block('white', [w.sx, 1.0, w.sz], [0, 0.36, 0]);
  band(k, w, 1.08, 0.13, 'team', 0.02);
  for (const face of ['+z', '-z', '+x', '-x'] as const) {
    const n = face === '+z' ? [0, 1] : face === '-z' ? [0, -1] : face === '+x' ? [1, 0] : [-1, 0];
    const at = (t: number, y: number, off: number): V3 => [n[0]! * (0.86 + off) + (n[0] ? 0 : t), y, n[1]! * (0.86 + off) + (n[1] ? 0 : t)];
    k.quad('panel', 0.7, 0.55, at(-0.38, 0.68, 0.005), face);
    k.quad('panel', 0.7, 0.55, at(0.38, 0.68, 0.005), face);
    k.plus('team', 0.26, 0.08, 0.02, at(0, 0.68, 0.012), face);
  }
  // top: steel rim + hazard-striped lid
  k.block('steel', [1.78, 0.06, 1.78], [0, 1.36, 0]);
  k.block('hazYellow', [1.56, 0.02, 1.56], [0, 1.42, 0]);
  for (let i = 0; i < 5; i++) k.box('hazBlack', [0.14, 0.012, 1.56], [-0.62 + i * 0.31, 1.446, 0]);
  for (const x of [-0.86, 0.86]) for (const z of [-0.86, 0.86]) {
    k.post('steel', 0.08, 1.2, [x, 0.36, z], 8);
    k.post('amberGlow', 0.07, 0.07, [x, 1.56, z], 8);
  }
  return { geo: k.merge() };
}

function barricade(ctx: ModelBuildContext): EntityModel {
  const fp = footprintOf(ctx, { w: 2, h: 2 });
  const g = buildingGeo('hosp_barricade', ctx, barricadeGeo);
  return plainModel(new BuildingRig('hosp_barricade', g.geo, fp, 1.65, ...fit(fp, 2, 2)));
}

// ───────────────────────────── Children's Hospital 6×6 ─────────────────────────────

const PLAY: Sw[] = ['playRed', 'playOrange', 'playYellow', 'playGreen', 'playBlue', 'playPurple', 'playPink'];

/** Shared by the objective building and the campus doodad. */
export function childrensHospitalGeo(team: TeamPal): { geo: Geo; pinwheel: V3 } {
  const k = new Kit(team); const rnd = rng(506);
  k.block('concreteLight', [5.95, 0.12, 5.95], [0, 0, 0]);
  k.box('lawn', [2.2, 0.03, 0.5], [1.6, 0.135, 2.65]);
  k.box('lawn', [1.6, 0.03, 0.45], [-1.6, 0.135, 2.72]);
  // main block with colourful fins
  const m: Rect = { cx: 0, cz: -1.0, sx: 5.3, sz: 3.6 };
  k.block('ivory', [m.sx, 3.0, m.sz], [m.cx, 0.12, m.cz]);
  floors(k, m, ['+z', '-z', '+x', '-x'], [0.42, 1.62], { h: 0.72, pane: 0.36, lit: 0.6, cool: 0.15 }, rnd);
  fins(k, m, '+z', 0.12, 2.86, 0.36, (i) => PLAY[i % PLAY.length]!, 0.12, 0.09);
  fins(k, m, '-x', 0.12, 2.86, 0.4, (i) => PLAY[(i + 3) % PLAY.length]!, 0.1, 0.08);
  fins(k, m, '+x', 0.12, 2.86, 0.4, (i) => PLAY[(i + 5) % PLAY.length]!, 0.1, 0.08);
  band(k, m, 2.88, 0.18, 'team', 0.03);
  parapet(k, m, 3.12, 0.12, 0.1, 'white');
  roof(k, m, 3.12, 'lawn', 0.12);
  // roof garden: little trees and planters
  for (const [x, z, r] of [[-1.9, -2.2, 0.32], [-1.2, -0.3, 0.26], [1.0, -2.3, 0.3], [2.0, -1.0, 0.24], [0.2, -1.4, 0.28]] as const) {
    k.block('woodLight', [r * 1.6, 0.14, r * 1.6], [x, 3.15, z]);
    k.ico(rnd() > 0.5 ? 'leafGreen' : 'leafLime', r, [x, 3.42 + r * 0.6, z], 0);
  }
  // west wing with rooftop playground
  const w: Rect = { cx: -1.6, cz: 1.65, sx: 1.9, sz: 1.9 };
  k.block('white', [w.sx, 2.2, w.sz], [w.cx, 0.12, w.cz]);
  floors(k, w, ['+z', '-x'], [0.42, 1.42], { h: 0.6, pane: 0.36, lit: 0.6 }, rnd);
  fins(k, w, '+z', 0.12, 2.1, 0.36, (i) => PLAY[(i + 2) % PLAY.length]!, 0.1, 0.08);
  k.box('playBlue', [w.sx - 0.1, 0.03, w.sz - 0.1], [w.cx, 2.335, w.cz]);
  parapet(k, w, 2.32, 0.28, 0.05, 'steel');
  k.beam('playYellow', [-2.2, 2.85, 1.2], [-1.55, 2.38, 2.05], 0.28, 0.05);
  k.block('playRed', [0.3, 0.5, 0.3], [-2.25, 2.33, 1.12]);
  for (const x of [-1.35, -0.85]) {
    k.beam('playRed', [x, 2.34, 1.15], [x, 3.0, 1.45], 0.05, 0.05);
    k.beam('playRed', [x, 2.34, 1.75], [x, 3.0, 1.45], 0.05, 0.05);
  }
  k.box('playRed', [0.55, 0.05, 0.05], [-1.1, 3.0, 1.45]);
  k.box('playGreen', [0.18, 0.03, 0.12], [-1.1, 2.6, 1.45]);
  // round tower with colour bands, portholes and the "+" sign
  const tx = 1.85, tz = 1.6;
  k.post('white', 0.82, 4.1, [tx, 0.12, tz], 22);
  for (let i = 0; i < 5; i++) k.post(PLAY[(i * 2) % PLAY.length]!, 0.835, 0.14, [tx, 0.62 + i * 0.75, tz], 22);
  for (let f = 0; f < 4; f++) for (let j = 0; j < 7; j++) {
    const a = -Math.PI * 0.15 + (j / 6) * Math.PI * 1.15 + (f % 2) * 0.2;
    const x = tx + Math.cos(a) * 0.835, z = tz + Math.sin(a) * 0.835;
    k.add(new THREE.CircleGeometry(0.11, 10), rnd() < 0.7 ? 'winWarm' : 'winCool', [x, 0.95 + f * 0.75, z], [0, Math.PI / 2 - a, 0]);
  }
  k.dome('playBlue', 0.86, [tx, 4.22, tz], [1, 0.32, 1], 22, 5);
  k.box('white', [0.9, 0.9, 0.14], [tx, 4.75, tz + 0.15]);
  k.plus('tealGlow', 0.7, 0.23, 0.05, [tx, 4.75, tz + 0.24], '+z');
  k.plus('tealGlow', 0.7, 0.23, 0.05, [tx, 4.75, tz + 0.06], '-z');
  // rainbow entrance arch + canopy + doors
  k.box('white', [1.4, 0.07, 1.0], [0.15, 1.32, 1.3]);
  k.box('team', [1.42, 0.07, 0.04], [0.15, 1.32, 1.8]);
  k.quad('winCyan', 1.0, 0.95, [0.15, 0.6, 0.805], '+z');
  PLAY.slice(0, 6).forEach((s, i) => k.torus(s, 0.75 - i * 0.065, 0.035, [0.15, 0.12, 1.78], undefined, Math.PI, 5, 20));
  return { geo: k.merge(), pinwheel: [-0.6, 3.55, -0.1] };
}

const pinwheelGeo = (): Geo => memo('pinwheel', () => {
  const k = new Kit();
  ['playRed', 'playYellow', 'playBlue', 'playGreen'].forEach((s, i) => {
    k.group([0, 0, 0], [i * (Math.PI / 2), 0, 0], () => k.box(s as Sw, [0.03, 0.34, 0.15], [0, 0.17, 0.05]));
  });
  k.sphere('white', 0.05, [0.02, 0, 0], 1, 6, 4);
  return k.merge();
});

export const pinwheelGeoForDoodad = (): Geo => pinwheelGeo();

export function pinwheelMesh(at: V3, mat: THREE.Material): THREE.Mesh {
  const m = makeMesh(pinwheelGeo(), mat, 'pinwheel');
  m.position.set(...at);
  return m;
}

function childrensHospital(ctx: ModelBuildContext): EntityModel {
  const fp = footprintOf(ctx, { w: 6, h: 6 });
  const g = buildingGeo('obj_childrens_hospital', ctx, childrensHospitalGeo);
  const rig = new BuildingRig('obj_childrens_hospital', g.geo, fp, 5.2, ...fit(fp, 6, 6));
  // pinwheel on a pole (spins around X, faces +X)
  const pole = makeMesh(memo('pinPole', () => new Kit().post('steel', 0.025, 0.42, [0, 0, 0], 6).merge()), atlasMat('struct'), 'pole');
  pole.position.set(g.pinwheel[0], 3.13, g.pinwheel[2]);
  const pin = pinwheelMesh(g.pinwheel, atlasMat('struct'));
  rig.body.add(pole, pin);
  return plainModel(rig, (_st, dt, _t, on) => { if (on) pin.rotation.x += dt * 2.2; });
}

// ───────────────────────────── Supply Cache (resource) 2×2 ─────────────────────────────

const CRATE_SW: Sw[] = ['ivory', 'cardboard', 'binBlue', 'wrap'];
const QUADS: Array<[number, number]> = [[-0.47, 0.47], [0.47, 0.47], [0.47, -0.47], [-0.47, -0.47]];
/** groups of crate "units" (layer, quadrant), removed top-down as the cache depletes */
const CACHE_GROUPS: Array<Array<[number, number]>> = [
  [[0, 0], [0, 1]], [[0, 2], [0, 3]], [[1, 0], [1, 2]], [[1, 1], [1, 3]], [[2, 1], [2, 3]], [[2, 0], [2, 2]],
];

function cacheGeo(variant: number) {
  const rnd = rng(900 + variant);
  const base = new Kit();
  for (const [x, z] of QUADS) {
    base.block('wood', [0.86, 0.06, 0.86], [x, 0.045, z]);
    for (const dz of [-0.36, 0, 0.36]) base.block('woodDark', [0.86, 0.045, 0.1], [x, 0, z + dz]);
  }
  // marker post with the teal "+" (readable landmark from far away)
  base.post('steel', 0.035, 1.55, [-0.9, 0, 0.9], 8);
  base.box('white', [0.5, 0.5, 0.06], [-0.9, 1.72, 0.9]);
  base.plus('tealGlow', 0.38, 0.12, 0.04, [-0.9, 1.72, 0.94], '+z');
  base.plus('tealGlow', 0.38, 0.12, 0.04, [-0.9, 1.72, 0.86], '-z');
  const groupGeos = CACHE_GROUPS.map((units) => {
    const k = new Kit();
    for (const [layer, qd] of units) {
      const [qx, qz] = QUADS[qd]!;
      const y = 0.11 + layer * 0.37;
      const sw = CRATE_SW[Math.floor(rnd() * CRATE_SW.length)]!;
      const jx = (rnd() - 0.5) * 0.06, jz = (rnd() - 0.5) * 0.06, rot = (rnd() - 0.5) * 0.12;
      k.group([qx + jx, y, qz + jz], [0, rot, 0], () => {
        if (sw === 'binBlue' || sw === 'cardboard') {
          for (const [dx, dz] of [[-0.19, -0.19], [0.19, -0.19], [-0.19, 0.19], [0.19, 0.19]] as const) {
            k.block(sw, [0.36, 0.34, 0.36], [dx, 0, dz]);
            if (sw === 'binBlue') k.block('white', [0.37, 0.04, 0.37], [dx, 0.3, dz]);
            else k.block('offwhite', [0.37, 0.02, 0.06], [dx, 0.33, dz]);
          }
        } else {
          k.block(sw, [0.78, 0.35, 0.78], [0, 0, 0]);
          if (sw === 'ivory') {
            k.block('teal', [0.79, 0.05, 0.79], [0, 0.3, 0]);
            k.plus('teal', 0.3, 0.1, 0.01, [0, 0.356, 0], '+y');
            k.plus('teal', 0.22, 0.07, 0.01, [0, 0.15, 0.396], '+z');
            k.plus('teal', 0.22, 0.07, 0.01, [0.396, 0.15, 0], '+x');
          } else {
            for (const d of [-0.2, 0.2]) k.block('offwhite', [0.79, 0.36, 0.04], [0, -0.005, d]);
          }
        }
      });
    }
    return k.merge();
  });
  // stacks[n] = first n groups merged (swapped in as the cache depletes → one crate mesh, one draw call)
  const stacks: Array<Geo | null> = [null];
  for (let n = 1; n <= groupGeos.length; n++) {
    const k = new Kit();
    for (let i = 0; i < n; i++) k.addPainted(groupGeos[i]!);
    stacks.push(k.merge());
  }
  for (const gg of groupGeos) gg.dispose();
  return { base: base.merge(), stacks };
}

function supplyCache(ctx: ModelBuildContext): EntityModel {
  const variant = bucket(ctx.seed, 3);
  const g = memo(`cache:${variant}`, () => cacheGeo(variant));
  const fp = footprintOf(ctx, { w: 2, h: 2 });
  const mat = atlasMat('struct');
  const root = new THREE.Group(); root.name = 'model:res_supply_cache';
  const body = new THREE.Group(); body.scale.set(fp.w / 2, 1, fp.h / 2); root.add(body);
  body.add(makeMesh(g.base, mat, 'pallets'));
  const crates = makeMesh(g.stacks[g.stacks.length - 1]!, mat, 'crates');
  body.add(crates);
  const levels = g.stacks.length - 1;
  body.rotation.y = fp.w === fp.h ? (bucket(ctx.seed, 4) * Math.PI) / 2 : bucket(ctx.seed, 2) * Math.PI;
  return {
    root, height: 1.9, handlesDeath: true,
    update(st) {
      const f = clamp01(Number.isFinite(st.resourceFrac) ? st.resourceFrac : 1);
      const n = f <= 0 ? 0 : Math.max(1, Math.ceil(f * levels - 1e-6));
      const geo = g.stacks[n];
      crates.visible = !!geo;
      if (geo && crates.geometry !== geo) crates.geometry = geo;
      body.position.y = st.death > 0 ? -1.2 * easeInCubic(clamp01(st.death)) : 0;
    },
    dispose() { root.clear(); },
  };
}

export const HOSPITAL_BUILDING_MODELS: Record<string, ModelBuilder> = {
  hosp_hq: hq,
  hosp_ward: ward,
  hosp_generator: generator,
  hosp_pharmacy: pharmacy,
  hosp_lab: lab,
  hosp_vehicle_bay: vehicleBay,
  hosp_uv_turret: uvTurret,
  hosp_barricade: barricade,
  obj_childrens_hospital: childrensHospital,
  res_supply_cache: supplyCache,
};
