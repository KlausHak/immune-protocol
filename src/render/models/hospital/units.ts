/**
 * [models-hospital] Hospital Defense Corps units. Model space: origin at ground centre, +X forward,
 * +Y up, +Z = unit's right. Each unit = a handful of meshes sharing ONE atlas material; static parts are
 * merged per def × team colour and cached. Only child objects are animated (root belongs to the render core).
 */
import * as THREE from 'three';
import { DEFAULT_FLY_HEIGHT } from '../../../config';
import type { UnitDef } from '../../../core/types';
import { tryGetDef } from '../../../data';
import type { EntityModel, ModelAnimState, ModelBuildContext, ModelBuilder } from '../types';
import {
  TAU, attackPulse, clamp01, damp, dampAngle, easeInCubic, flicker, lerp, safeDt, toppleDeath, wreckDeath,
} from './anim';
import { Kit, atlasMat, bucket, fixFx, flashMat, fx, glowRamp, makeMesh, memo, rampPick, teamPal, type Sw, type TeamPal, type V3 } from './kit';

type Geo = THREE.BufferGeometry;

function unitGeo<T>(id: string, ctx: ModelBuildContext, variant: number, build: (team: TeamPal) => T): T {
  const team = teamPal(ctx.teamColor);
  return memo(`unit:${id}:${team.key}:${variant}`, () => build(team));
}

/** Scale factor so a model designed for `design` radius fills the def's actual radius. */
function fitScale(ctx: ModelBuildContext, design: number): number {
  const r = ctx.radius > 0 ? ctx.radius : design;
  return Math.min(1.5, Math.max(0.7, r / design));
}

const UNIT_MAT = (): THREE.MeshStandardMaterial => atlasMat('unit');
const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Shared skeleton for walking humans: body group (bob/topple) holding torso + two legs. */
class Biped {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly torso: THREE.Mesh;
  readonly legL: THREE.Mesh;
  readonly legR: THREE.Mesh;
  phase = 0;
  walk = 0;
  private first = true;
  private readonly breathe: number;

  constructor(name: string, torso: Geo, leg: Geo, hip: number, legZ: number, scale: number, seed: number) {
    const mat = UNIT_MAT();
    this.root.name = `model:${name}`;
    this.body.scale.setScalar(scale);
    this.root.add(this.body);
    this.torso = makeMesh(torso, mat, 'torso');
    this.legL = makeMesh(leg, mat, 'legL'); this.legL.position.set(0, hip, -legZ);
    this.legR = makeMesh(leg, mat, 'legR'); this.legR.position.set(0, hip, legZ);
    this.body.add(this.torso, this.legL, this.legR);
    this.breathe = (seed % 97) * 0.37;
  }

  /** Legs, bob, breathing. Returns the swing value (-1..1) for arm counter-swing. */
  step(st: ModelAnimState, dt: number, time: number, stride: number, amp: number, bob: number): number {
    if (this.first) { fixFx(this.root); this.first = false; }
    this.walk = damp(this.walk, st.moving && st.speed > 0.05 ? 1 : 0, 9, dt);
    this.phase = (this.phase + dt * Math.max(st.speed, this.walk * 0.6) * (TAU / stride)) % TAU;
    const sw = Math.sin(this.phase) * this.walk;
    this.legL.rotation.z = sw * amp;
    this.legR.rotation.z = -sw * amp;
    this.body.position.set(0, Math.abs(Math.cos(this.phase)) * bob * this.walk, 0);
    this.body.rotation.set(0, 0, -0.06 * this.walk);
    this.torso.position.y = Math.sin(time * 2.1 + this.breathe) * 0.006 * (1 - this.walk);
    return sw;
  }
}

/** Leg hanging from a hip pivot: thigh, shin, boot (bottom at y = -hip). */
function addLeg(k: Kit, hip: number, w: number, trouser: Sw, boot: Sw, knee?: Sw): void {
  k.box(trouser, [w, hip * 0.56, w], [0, -hip * 0.27, 0]);
  k.box(trouser, [w * 0.86, hip * 0.44, w * 0.86], [0.012, -hip * 0.7, 0]);
  if (knee) k.box(knee, [0.05, hip * 0.2, w * 0.8], [w * 0.5, -hip * 0.52, 0]);
  k.box(boot, [w * 1.45, 0.1, w * 1.05], [w * 0.25, -hip + 0.05, 0]);
}

// ───────────────────────────── Sanitizer ─────────────────────────────

const SAN_HIP = 0.5;
const SAN_ARMS: V3 = [0.02, 0.9, 0];

function sanitizerGeo(team: TeamPal) {
  const t = new Kit(team);
  t.box('hazmat', [0.22, 0.14, 0.3], [0, 0.54, 0]);
  t.box('graphite', [0.24, 0.05, 0.32], [0, 0.6, 0]);
  t.cyl('hazmat', 0.2, 0.17, 0.32, 8, [0, 0.78, 0], undefined, [0.72, 1, 1]);
  t.cyl('team', 0.205, 0.2, 0.05, 8, [0, 0.9, 0], undefined, [0.74, 1, 1.0]);
  for (const z of [-0.19, 0.19]) t.box('team', [0.17, 0.07, 0.13], [0, 0.94, z]);
  t.cyl('hazmatDark', 0.1, 0.11, 0.06, 8, [0, 0.96, 0]);
  t.sphere('hazmat', 0.15, [0, 1.07, 0], [1, 1.05, 1]);
  t.sphere('visor', 0.12, [0.1, 1.075, 0], [0.55, 0.72, 1.1]);
  t.cyl('graphite', 0.045, 0.045, 0.07, 8, [0.15, 0.97, 0], [0, 0, Math.PI / 2]);
  t.box('team', [0.22, 0.03, 0.07], [-0.01, 1.222, 0]);
  // twin disinfectant tanks
  t.box('graphite', [0.05, 0.36, 0.26], [-0.13, 0.8, 0]);
  for (const z of [-0.078, 0.078]) {
    t.post('steel', 0.075, 0.42, [-0.2, 0.6, z], 10);
    t.dome('team', 0.075, [-0.2, 1.02, z], 1, 10, 4);
  }
  t.box('team', [0.03, 0.06, 0.3], [-0.276, 0.86, 0]);
  t.rod('rubber', [-0.17, 0.66, 0.13], [0.05, 0.62, 0.22], 0.018);

  const leg = new Kit(team);
  addLeg(leg, SAN_HIP, 0.14, 'hazmat', 'rubber', 'hazmatDark');

  const a = new Kit(team);
  for (const s of [-1, 1]) a.sphere('hazmat', 0.068, [0, 0, 0.2 * s], 1, 8, 6);
  a.beam('hazmat', [0, -0.01, 0.2], [0.1, -0.2, 0.2], 0.1, 0.1);
  a.beam('hazmat', [0.1, -0.2, 0.2], [0.25, -0.17, 0.12], 0.09, 0.09);
  a.box('rubber', [0.075, 0.075, 0.075], [0.27, -0.17, 0.11]);
  a.beam('hazmat', [0, -0.01, -0.2], [0.12, -0.18, -0.17], 0.1, 0.1);
  a.beam('hazmat', [0.12, -0.18, -0.17], [0.3, -0.14, 0.04], 0.09, 0.09);
  a.box('rubber', [0.075, 0.075, 0.075], [0.31, -0.14, 0.05]);
  // sprayer
  a.box('steel', [0.25, 0.085, 0.075], [0.27, -0.13, 0.09]);
  a.cyl('team', 0.045, 0.045, 0.14, 8, [0.22, -0.2, 0.09], [0, 0, Math.PI / 2]);
  a.rod('chrome', [0.38, -0.125, 0.09], [0.56, -0.112, 0.09], 0.022);
  a.cyl('teal', 0.038, 0.03, 0.06, 8, [0.575, -0.11, 0.09], [0, 0, -Math.PI / 2]);
  return { torso: t.merge(), leg: leg.merge(), arms: a.merge() };
}

const mistGeo = (): Geo => memo('fx:mist', () => new THREE.ConeGeometry(0.11, 0.42, 9, 1, true).rotateZ(Math.PI / 2).translate(0.21, 0, 0));
const sparkGeo = (): Geo => memo('fx:spark', () => new THREE.IcosahedronGeometry(0.06, 0));

function sanitizer(ctx: ModelBuildContext): EntityModel {
  const g = unitGeo('hosp_sanitizer', ctx, 0, sanitizerGeo);
  const sc = fitScale(ctx, 0.4);
  const b = new Biped('hosp_sanitizer', g.torso, g.leg, SAN_HIP, 0.09, sc, ctx.seed);
  const arms = makeMesh(g.arms, UNIT_MAT(), 'arms');
  arms.position.set(...SAN_ARMS);
  const mist = fx(makeMesh(mistGeo(), flashMat(0x9ff6ff, 1.3), 'mist'));
  mist.position.set(0.59, -0.11, 0.09); mist.visible = false;
  arms.add(mist);
  b.body.add(arms);
  let aim = 0;
  return {
    root: b.root, height: 1.25 * sc, muzzle: v3(0.62, 0.79, 0.09).multiplyScalar(sc), handlesDeath: true,
    update(st, dtRaw, time) {
      const dt = safeDt(dtRaw);
      if (st.death > 0) { toppleDeath(b.body, st.death); mist.visible = false; return; }
      const sw = b.step(st, dt, time, 1.05, 0.62, 0.035);
      aim = damp(aim, st.activity === 'attacking' || st.sinceAttack < 1 ? 1 : 0, 7, dt);
      const k = attackPulse(st.sinceAttack, 0.18);
      arms.rotation.set(sw * 0.05, 0, lerp(-0.38, 0.02, aim) + Math.cos(b.phase * 2) * 0.03 * b.walk);
      arms.position.set(SAN_ARMS[0] - 0.05 * k, SAN_ARMS[1], SAN_ARMS[2]);
      mist.visible = k > 0;
      if (k > 0) mist.scale.set(0.5 + (1 - k) * 1.1, 0.6 + (1 - k) * 0.9, 0.6 + (1 - k) * 0.9);
    },
    dispose() { b.root.clear(); },
  };
}

// ───────────────────────────── Field Medic ─────────────────────────────

const MED_HIP = 0.5;
const SKINS: Sw[] = ['skin1', 'skin2', 'skin3'];

function medicGeo(team: TeamPal, skin: Sw) {
  const t = new Kit(team);
  t.box('graphite', [0.22, 0.14, 0.3], [0, 0.54, 0]);
  t.box('charcoal', [0.24, 0.045, 0.32], [0, 0.6, 0]);
  t.cyl('white', 0.19, 0.165, 0.33, 8, [0, 0.785, 0], undefined, [0.72, 1, 1]);
  t.cyl('team', 0.2, 0.178, 0.24, 8, [0, 0.76, 0], undefined, [0.76, 1, 1]);
  t.cyl('alu', 0.204, 0.198, 0.035, 8, [0, 0.7, 0], undefined, [0.77, 1, 1.01]);
  t.cyl('alu', 0.206, 0.2, 0.035, 8, [0, 0.83, 0], undefined, [0.77, 1, 1.01]);
  t.cyl(skin, 0.055, 0.06, 0.07, 8, [0, 0.965, 0]);
  t.sphere(skin, 0.1, [0.012, 1.05, 0], [1, 1.05, 0.95]);
  t.dome('white', 0.122, [0, 1.07, 0], [1.05, 1, 1]);
  t.cyl('team', 0.124, 0.126, 0.035, 12, [0, 1.085, 0], undefined, [1.05, 1, 1]);
  t.box('white', [0.08, 0.02, 0.18], [0.12, 1.08, 0]);
  // medical pack: white with a team lid and white "+"
  t.box('white', [0.17, 0.3, 0.3], [-0.18, 0.82, 0]);
  t.box('team', [0.16, 0.02, 0.27], [-0.18, 0.975, 0]);
  t.plus('white', 0.17, 0.055, 0.014, [-0.18, 0.99, 0], '+y');
  t.box('team', [0.012, 0.2, 0.2], [-0.267, 0.84, 0]);
  t.plus('white', 0.15, 0.048, 0.012, [-0.275, 0.84, 0], '-x');
  t.post('steel', 0.012, 0.22, [-0.22, 0.97, -0.11], 5);
  t.sphere('greenGlow', 0.022, [-0.22, 1.2, -0.11], 1, 6, 4);

  const leg = new Kit(team);
  addLeg(leg, MED_HIP, 0.135, 'graphite', 'rubber');
  leg.box('team', [0.012, 0.18, 0.06], [0.07, -0.18, 0]);

  const arm = (scanner: boolean) => {
    const a = new Kit(team);
    a.sphere('white', 0.062, [0, 0, 0], 1, 8, 6);
    a.beam('white', [0, -0.01, 0], [0.02, -0.21, 0], 0.09, 0.09);
    a.beam('white', [0.02, -0.21, 0], [0.06, -0.38, 0], 0.08, 0.08);
    a.box('team', [0.088, 0.045, 0.088], [0.055, -0.345, 0]);
    a.box('nitrile', [0.07, 0.075, 0.07], [0.065, -0.42, 0]);
    if (scanner) {
      a.box('steel', [0.13, 0.05, 0.08], [0.1, -0.455, 0]);
      a.box('screen', [0.05, 0.03, 0.06], [0.14, -0.428, 0]);
    }
    return a.merge();
  };
  return { torso: t.merge(), leg: leg.merge(), armL: arm(false), armR: arm(true) };
}

function medic(ctx: ModelBuildContext): EntityModel {
  const skinIdx = bucket(ctx.seed, SKINS.length);
  const g = unitGeo('hosp_medic', ctx, skinIdx, (team) => medicGeo(team, SKINS[skinIdx]!));
  const sc = fitScale(ctx, 0.4);
  const b = new Biped('hosp_medic', g.torso, g.leg, MED_HIP, 0.09, sc, ctx.seed);
  const mat = UNIT_MAT();
  const armL = makeMesh(g.armL, mat, 'armL'); armL.position.set(0, 0.93, -0.205);
  const armR = makeMesh(g.armR, mat, 'armR'); armR.position.set(0, 0.93, 0.205);
  const ramp = glowRamp(0x48ffb0, 0.4, 3.6, false);
  const heal = fx(makeMesh(sparkGeo(), ramp[0]!, 'healGlow'));
  heal.position.set(0.17, -0.455, 0); heal.scale.setScalar(0.7);
  armR.add(heal);
  b.body.add(armL, armR);
  let healT = 0;
  return {
    root: b.root, height: 1.25 * sc, handlesDeath: true,
    update(st, dtRaw, time) {
      const dt = safeDt(dtRaw);
      if (st.death > 0) { toppleDeath(b.body, st.death); heal.visible = false; return; }
      const sw = b.step(st, dt, time, 1.05, 0.62, 0.035);
      healT = damp(healT, st.activity === 'healing' || st.activity === 'casting' ? 1 : 0, 6, dt);
      armL.rotation.z = -sw * 0.55;
      armR.rotation.z = lerp(sw * 0.55, 1.25 + Math.sin(time * 5) * 0.05, healT);
      armR.rotation.x = lerp(0, -0.35, healT);
      heal.visible = healT > 0.05;
      if (heal.visible) {
        const p = 0.5 + 0.5 * Math.sin(time * 9);
        heal.material = rampPick(ramp, healT * (0.45 + 0.55 * p));
        heal.scale.setScalar(0.6 + 0.5 * p * healT);
      }
    },
    dispose() { b.root.clear(); },
  };
}

// ───────────────────────────── UV Lancer ─────────────────────────────

const LAN_HIP = 0.56;
const LAN_ARMS: V3 = [0.02, 0.98, 0];
const LANCE_B: V3 = [-0.05, -0.33, 0.14];
const LANCE_T: V3 = [0.8, -0.2, 0.07];

function lancerGeo(team: TeamPal) {
  const t = new Kit(team);
  t.box('graphite', [0.25, 0.15, 0.34], [0, 0.6, 0]);
  for (const z of [-0.1, 0, 0.1]) t.box('visorUv', [0.02, 0.04, 0.05], [0.13, 0.62, z]);
  t.cyl('graphite', 0.22, 0.18, 0.37, 8, [0, 0.86, 0], undefined, [0.75, 1, 1]);
  t.box('ivory', [0.12, 0.27, 0.3], [0.085, 0.89, 0]);
  t.box('team', [0.125, 0.05, 0.31], [0.088, 0.97, 0]);
  for (const z of [-0.245, 0.245]) {
    t.cyl('ivory', 0.13, 0.12, 0.07, 10, [0, 0.98, z], undefined, [1.15, 1, 1]);
    t.dome('team', 0.13, [0, 1.01, z], [1.15, 0.8, 1], 10, 4);
  }
  t.cyl('charcoal', 0.08, 0.09, 0.06, 8, [0, 1.06, 0]);
  t.sphere('ivory', 0.145, [0.005, 1.16, 0], [1.05, 1, 0.95]);
  t.box('visorUv', [0.05, 0.05, 0.2], [0.14, 1.155, 0]);
  t.box('graphite', [0.08, 0.06, 0.16], [0.12, 1.08, 0]);
  t.box('team', [0.24, 0.035, 0.05], [-0.01, 1.3, 0]);
  // UV-C reactor pack
  t.box('graphite', [0.2, 0.44, 0.34], [-0.21, 0.92, 0]);
  t.box('ivory', [0.21, 0.08, 0.35], [-0.21, 0.73, 0]);
  for (const z of [-0.1, 0, 0.1]) t.post('uvGlow', 0.03, 0.3, [-0.315, 0.78, z], 6);
  t.cyl('team', 0.13, 0.13, 0.04, 12, [-0.21, 1.15, 0]);
  t.torus('steel', 0.12, 0.03, [-0.21, 1.19, 0], [Math.PI / 2, 0, 0]);
  t.cyl('uvGlow', 0.07, 0.07, 0.06, 10, [-0.21, 1.19, 0]);
  t.rod('rubber', [-0.12, 0.72, 0.16], [0.08, 0.66, 0.2], 0.02);

  const leg = new Kit(team);
  addLeg(leg, LAN_HIP, 0.15, 'graphite', 'charcoal', 'ivory');

  const a = new Kit(team);
  for (const s of [-1, 1]) a.sphere('graphite', 0.07, [0, 0, 0.245 * s], 1, 8, 6);
  a.beam('graphite', [0, -0.01, 0.245], [0.05, -0.22, 0.245], 0.1, 0.1);
  a.beam('ivory', [0.05, -0.22, 0.245], [0.18, -0.3, 0.15], 0.1, 0.1);
  a.box('charcoal', [0.08, 0.08, 0.08], [0.19, -0.31, 0.145]);
  a.beam('graphite', [0, -0.01, -0.245], [0.15, -0.16, -0.2], 0.1, 0.1);
  a.beam('ivory', [0.15, -0.16, -0.2], [0.36, -0.22, 0.05], 0.095, 0.095);
  a.box('charcoal', [0.08, 0.08, 0.08], [0.37, -0.22, 0.06]);
  // the lance
  a.rod('steelDark', LANCE_B, LANCE_T, 0.032, 8);
  const d = new THREE.Vector3(LANCE_T[0] - LANCE_B[0], LANCE_T[1] - LANCE_B[1], LANCE_T[2] - LANCE_B[2]).normalize();
  const at = (s: number): V3 => [LANCE_T[0] + d.x * s, LANCE_T[1] + d.y * s, LANCE_T[2] + d.z * s];
  a.rod('ivory', at(-0.46), at(-0.2), 0.05, 8);
  a.rod('team', at(-0.2), at(-0.12), 0.055, 8);
  a.rod('steel', at(-0.08), at(0.02), 0.07, 8, 0.05);
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * TAU;
    const off = (r: number, s: number): V3 => { const p = at(s); return [p[0], p[1] + Math.cos(ang) * r, p[2] + Math.sin(ang) * r]; };
    a.rod('chrome', off(0.05, 0.0), off(0.065, 0.14), 0.012, 4);
  }
  return { torso: t.merge(), leg: leg.merge(), arms: a.merge(), tip: at(0.09) };
}

function uvLancer(ctx: ModelBuildContext): EntityModel {
  const g = unitGeo('hosp_uv_lancer', ctx, 0, lancerGeo);
  const sc = fitScale(ctx, 0.45);
  const b = new Biped('hosp_uv_lancer', g.torso, g.leg, LAN_HIP, 0.1, sc, ctx.seed);
  const arms = makeMesh(g.arms, UNIT_MAT(), 'arms');
  arms.position.set(...LAN_ARMS);
  const ramp = glowRamp(0xb15cff, 0.6, 4.0, false);
  const emitter = fx(makeMesh(memo('fx:lens', () => new THREE.IcosahedronGeometry(0.06, 1)), ramp[0]!, 'emitter'));
  emitter.position.set(...g.tip);
  const flare = fx(makeMesh(sparkGeo(), flashMat(0xc890ff, 1.8), 'flare'));
  flare.position.set(...g.tip); flare.visible = false;
  arms.add(emitter, flare);
  b.body.add(arms);
  let aim = 0; let charge = 0;
  return {
    root: b.root, height: 1.4 * sc, muzzle: v3(LAN_ARMS[0] + g.tip[0], LAN_ARMS[1] + g.tip[1], g.tip[2]).multiplyScalar(sc), handlesDeath: true,
    update(st, dtRaw, time) {
      const dt = safeDt(dtRaw);
      if (st.death > 0) { toppleDeath(b.body, st.death); flare.visible = false; emitter.material = ramp[0]!; return; }
      const sw = b.step(st, dt, time, 1.15, 0.55, 0.03);
      const engaged = st.activity === 'attacking' || st.sinceAttack < 1.4;
      const casting = st.activity === 'casting';
      aim = damp(aim, engaged || casting ? 1 : 0, 6, dt);
      charge = damp(charge, casting ? 1 : engaged ? 0.6 : 0.25, 4, dt);
      const k = attackPulse(st.sinceAttack, 0.2);
      arms.rotation.set(sw * 0.04, 0, lerp(-0.22, 0.04, aim) + (casting ? 0.5 : 0) + Math.cos(b.phase * 2) * 0.025 * b.walk);
      arms.position.set(LAN_ARMS[0] - 0.045 * k, LAN_ARMS[1], LAN_ARMS[2]);
      const pulse = 0.5 + 0.5 * Math.sin(time * (3 + charge * 6));
      emitter.material = rampPick(ramp, Math.max(k, charge * (0.55 + 0.45 * pulse)));
      emitter.scale.setScalar(1 + k * 0.6);
      flare.visible = k > 0;
      if (k > 0) flare.scale.setScalar(1.2 + (1 - k) * 2.2);
    },
    dispose() { b.root.clear(); },
  };
}

// ───────────────────────────── Orderly Bot ─────────────────────────────

const ORD_ARMS: V3 = [0.06, 0.66, 0];

function orderlyGeo(team: TeamPal) {
  const t = new Kit(team);
  t.box('panel', [0.52, 0.14, 0.42], [0, 0.2, 0]);
  t.box('ivory', [0.5, 0.05, 0.4], [0, 0.295, 0]);
  for (const z of [-0.214, 0.214]) t.box('team', [0.46, 0.045, 0.012], [0, 0.22, z]);
  for (const x of [-0.272, 0.272]) t.box('rubber', [0.04, 0.07, 0.38], [x, 0.16, 0]);
  for (const z of [-0.12, 0.12]) t.box('screen', [0.02, 0.03, 0.08], [0.28, 0.225, z]);
  for (const x of [-0.19, 0.19]) t.sphere('graphite', 0.05, [x, 0.05, 0], 1, 6, 4);
  t.box('steelDark', [0.13, 0.16, 0.13], [0, 0.39, 0]);
  t.box('ivory', [0.32, 0.3, 0.38], [-0.02, 0.6, 0]);
  for (const z of [-0.196, 0.196]) t.box('team', [0.26, 0.19, 0.012], [-0.02, 0.6, z]);
  t.box('team', [0.24, 0.014, 0.3], [-0.04, 0.755, 0]);
  t.quad('screen', 0.17, 0.06, [0.141, 0.66, 0], '+x');
  t.box('graphite', [0.08, 0.22, 0.3], [-0.2, 0.6, 0]);
  t.box('amberGlow', [0.02, 0.03, 0.2], [-0.241, 0.67, 0]);
  t.cyl('steelDark', 0.05, 0.055, 0.07, 8, [0, 0.79, 0]);
  t.cyl('ivory', 0.115, 0.115, 0.26, 12, [0.01, 0.89, 0], [Math.PI / 2, 0, 0]);
  t.box('graphite', [0.04, 0.13, 0.18], [0.105, 0.885, 0]);
  for (const z of [-0.045, 0.045]) t.box('screen', [0.014, 0.04, 0.04], [0.127, 0.9, z]);
  t.box('team', [0.12, 0.022, 0.262], [0, 1.0, 0]);
  t.rod('steel', [-0.05, 0.99, -0.09], [-0.07, 1.13, -0.1], 0.009, 4);
  t.sphere('amberGlow', 0.022, [-0.07, 1.14, -0.1], 1, 6, 4);

  const w = new Kit(team);
  for (const z of [-0.25, 0.25]) {
    w.cyl('rubber', 0.15, 0.15, 0.08, 14, [0, 0, z], [Math.PI / 2, 0, 0]);
    w.cyl('steel', 0.085, 0.085, 0.09, 10, [0, 0, z], [Math.PI / 2, 0, 0]);
    w.box('team', [0.16, 0.04, 0.092], [0, 0, z]);
  }

  const a = new Kit(team);
  for (const s of [-1, 1]) {
    const z = 0.225 * s;
    a.sphere('steelDark', 0.05, [0, 0, z], 1, 8, 6);
    a.beam('steel', [0, 0, z], [0.16, -0.12, z], 0.07, 0.07);
    a.beam('ivory', [0.16, -0.12, z], [0.32, -0.08, z * 0.86], 0.065, 0.065);
    a.box('team', [0.06, 0.07, 0.07], [0.24, -0.1, z * 0.93]);
    a.box('graphite', [0.07, 0.03, 0.035], [0.355, -0.055, z * 0.86]);
    a.box('graphite', [0.07, 0.03, 0.035], [0.355, -0.115, z * 0.86]);
  }
  a.rod('chrome', [0.36, -0.085, 0.19], [0.44, -0.1, 0.19], 0.012, 5);

  const c = new Kit(team);
  c.box('ivory', [0.26, 0.22, 0.3], [0.33, -0.03, 0]);
  c.box('teal', [0.262, 0.03, 0.302], [0.33, 0.065, 0]);
  for (const z of [-0.085, 0.085]) c.box('graphite', [0.264, 0.224, 0.02], [0.33, -0.03, z]);
  c.plus('teal', 0.11, 0.035, 0.012, [0.33, 0.088, 0], '+y');
  c.plus('teal', 0.1, 0.032, 0.01, [0.33, -0.04, 0.152], '+z');
  c.plus('teal', 0.1, 0.032, 0.01, [0.33, -0.04, -0.152], '-z');
  return { body: t.merge(), wheels: w.merge(), arms: a.merge(), crate: c.merge() };
}

function orderly(ctx: ModelBuildContext): EntityModel {
  const g = unitGeo('hosp_orderly', ctx, 0, orderlyGeo);
  const sc = fitScale(ctx, 0.38);
  const mat = UNIT_MAT();
  const root = new THREE.Group(); root.name = 'model:hosp_orderly';
  const body = new THREE.Group(); body.scale.setScalar(sc); root.add(body);
  const hull = makeMesh(g.body, mat, 'body');
  const wheels = makeMesh(g.wheels, mat, 'wheels'); wheels.position.set(0, 0.15, 0);
  const arms = makeMesh(g.arms, mat, 'arms'); arms.position.set(...ORD_ARMS);
  const crate = makeMesh(g.crate, mat, 'crate'); crate.visible = false;
  const spark = fx(makeMesh(sparkGeo(), flashMat(0xbff4ff, 2.2), 'spark')); spark.position.set(0.45, -0.1, 0.19); spark.visible = false;
  arms.add(crate, spark);
  body.add(hull, wheels, arms);
  let first = true, roll = 0, work = 0, carry = 0, moveT = 0;
  return {
    root, height: 1.15 * sc, muzzle: v3(0.45, 0.56, 0.19).multiplyScalar(sc), handlesDeath: true,
    update(st, dtRaw, time) {
      const dt = safeDt(dtRaw);
      if (first) { fixFx(root); first = false; }
      if (st.death > 0) { wreckDeath(body, st.death, 0.9); spark.visible = false; return; }
      moveT = damp(moveT, st.moving ? 1 : 0, 8, dt);
      roll += (st.speed * dt) / (0.15 * sc);
      wheels.rotation.z = -roll;
      hull.position.y = Math.abs(Math.sin(roll * 0.9)) * 0.012 * moveT + Math.sin(time * 2 + ctx.seed) * 0.004;
      body.rotation.z = -0.05 * moveT;
      const working = st.activity === 'gathering' || st.activity === 'building';
      work = damp(work, working ? 1 : 0, 6, dt);
      carry = damp(carry, st.carrying ? 1 : 0, 10, dt);
      crate.visible = st.carrying;
      let armZ = lerp(-0.25, 0.02, carry);
      if (st.activity === 'gathering') armZ = lerp(armZ, -0.55 + Math.sin(time * 5.5) * 0.3, work);
      else if (st.activity === 'building') armZ = lerp(armZ, 0.15 + Math.abs(Math.sin(time * 7)) * 0.35, work);
      else armZ += Math.sin(time * 1.7 + ctx.seed) * 0.02;
      const hit = attackPulse(st.sinceAttack, 0.2);
      arms.rotation.z = armZ + hit * 0.4;
      arms.position.y = ORD_ARMS[1] + (hull.position.y);
      const welding = st.activity === 'building' && work > 0.5;
      spark.visible = (welding && flicker(time, ctx.seed) > 0.45) || hit > 0;
      if (spark.visible) spark.scale.setScalar(0.6 + flicker(time + 0.3, ctx.seed) * 0.9);
    },
    dispose() { root.clear(); },
  };
}

// ───────────────────────────── Antibiotic Launcher ─────────────────────────────

const LNC_TURRET: V3 = [-0.32, 0.6, 0];
const LNC_DIR = new THREE.Vector3(Math.cos(0.62), Math.sin(0.62), 0);

function launcherGeo(team: TeamPal) {
  const t = new Kit(team);
  t.box('graphite', [1.6, 0.14, 0.78], [0, 0.33, 0]);
  t.box('ivory', [0.48, 0.36, 0.9], [0.58, 0.58, 0]);
  t.box('ivory', [0.38, 0.27, 0.86], [0.52, 0.895, 0]);
  t.box('team', [0.485, 0.07, 0.905], [0.58, 0.62, 0]);
  t.quad('glass', 0.78, 0.2, [0.712, 0.9, 0], '+x');
  for (const s of [-1, 1]) t.quad('glass', 0.24, 0.17, [0.54, 0.91, 0.4305 * s], s > 0 ? '+z' : '-z');
  t.box('teamGlow', [0.1, 0.05, 0.62], [0.5, 1.05, 0]);
  t.box('blueGlow', [0.09, 0.045, 0.1], [0.5, 1.05, 0.36]);
  t.box('blueGlow', [0.09, 0.045, 0.1], [0.5, 1.05, -0.36]);
  t.box('charcoal', [0.06, 0.12, 0.92], [0.84, 0.42, 0]);
  for (const z of [-0.3, 0.3]) t.box('headlight', [0.02, 0.06, 0.14], [0.825, 0.56, z]);
  t.quad('graphite', 0.36, 0.1, [0.8205, 0.64, 0], '+x');
  // converted pharmacy body (bed) with stripes and a pharmacy cross
  t.box('ivory', [1.0, 0.24, 0.9], [-0.3, 0.52, 0]);
  t.box('team', [1.02, 0.07, 0.92], [-0.3, 0.5, 0]);
  for (const s of [-1, 1]) {
    t.box('white', [0.2, 0.2, 0.01], [0.08, 0.53, 0.455 * s]);
    t.plus('pharmGreen', 0.15, 0.05, 0.012, [0.08, 0.53, 0.462 * s], s > 0 ? '+z' : '-z');
  }
  for (const s of [-1, 1]) for (const x of [-0.72, -0.55]) {
    t.cyl('capsuleA', 0.05, 0.05, 0.09, 8, [x - 0.045, 0.69, 0.385 * s], [0, 0, Math.PI / 2]);
    t.cyl('capsuleB', 0.05, 0.05, 0.09, 8, [x + 0.045, 0.69, 0.385 * s], [0, 0, Math.PI / 2]);
    t.sphere('capsuleA', 0.05, [x - 0.09, 0.69, 0.385 * s], 1, 8, 5);
    t.sphere('capsuleB', 0.05, [x + 0.09, 0.69, 0.385 * s], 1, 8, 5);
  }
  for (const z of [-0.33, 0.33]) t.box('tailLight', [0.02, 0.07, 0.1], [-0.805, 0.52, z]);
  for (const x of [0.52, -0.5]) for (const z of [-0.42, 0.42]) t.box('charcoal', [0.5, 0.05, 0.17], [x, 0.44, z]);

  const wheel = new Kit(team);
  for (const z of [-0.4, 0.4]) {
    wheel.cyl('rubber', 0.2, 0.2, 0.15, 14, [0, 0, z], [Math.PI / 2, 0, 0]);
    wheel.cyl('steel', 0.1, 0.1, 0.16, 8, [0, 0, z], [Math.PI / 2, 0, 0]);
    wheel.box('steelDark', [0.2, 0.04, 0.165], [0, 0, z]);
  }

  const tu = new Kit(team);
  tu.cyl('steelDark', 0.3, 0.32, 0.08, 14, [0, 0.04, 0]);
  tu.box('ivory', [0.36, 0.14, 0.44], [0, 0.15, 0]);
  tu.box('team', [0.37, 0.04, 0.45], [0, 0.2, 0]);
  tu.cyl('steelDark', 0.08, 0.08, 0.46, 10, [-0.08, 0.27, 0], [Math.PI / 2, 0, 0]);
  tu.rod('steel', [0.08, 0.2, 0], [0.16, 0.36, 0], 0.035);
  const c = new THREE.Vector3(0.1, 0.42, 0);
  for (const z of [-0.12, 0.12]) {
    const p = (s: number): V3 => [c.x + LNC_DIR.x * s, c.y + LNC_DIR.y * s, z];
    tu.rod('ivory', p(-0.38), p(0.3), 0.105, 12);
    tu.rod('team', p(0.3), p(0.4), 0.115, 12);
    tu.rod('graphite', p(0.4), p(0.405), 0.085, 10);
    tu.sphere('capsuleB', 0.07, p(0.36), 1, 8, 5);
  }
  const mouth = c.clone().addScaledVector(LNC_DIR, 0.46);
  return { body: t.merge(), wheel: wheel.merge(), turret: tu.merge(), mouth };
}

function antibioticLauncher(ctx: ModelBuildContext): EntityModel {
  const g = unitGeo('hosp_antibiotic_launcher', ctx, 0, launcherGeo);
  const sc = fitScale(ctx, 0.8);
  const mat = UNIT_MAT();
  const root = new THREE.Group(); root.name = 'model:hosp_antibiotic_launcher';
  const body = new THREE.Group(); body.scale.setScalar(sc); root.add(body);
  const chassis = new THREE.Group(); body.add(chassis);
  const hull = makeMesh(g.body, mat, 'body');
  const wf = makeMesh(g.wheel, mat, 'wheelsFront'); wf.position.set(0.52, 0.2, 0);
  const wr = makeMesh(g.wheel, mat, 'wheelsRear'); wr.position.set(-0.5, 0.2, 0);
  const turret = makeMesh(g.turret, mat, 'turret'); turret.position.set(...LNC_TURRET);
  const flashGeo = memo('fx:lncFlash', () => {
    const k = new Kit();
    for (const z of [-0.12, 0.12]) k.sphere('white', 0.13, [g.mouth.x, g.mouth.y, z], 1, 8, 6);
    return k.merge();
  });
  const flash = fx(makeMesh(flashGeo, flashMat(0xffe2a0, 1.8), 'flash')); flash.visible = false;
  turret.add(flash);
  chassis.add(hull, turret);
  body.add(wf, wr);
  const muzzle = v3(0, 0, 0);
  let first = true, roll = 0, yaw = 0, moveT = 0;
  const setMuzzle = () => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    muzzle.set(LNC_TURRET[0] + g.mouth.x * c, LNC_TURRET[1] + g.mouth.y, -g.mouth.x * s).multiplyScalar(sc);
  };
  setMuzzle();
  return {
    root, height: 1.45 * sc, muzzle, handlesDeath: true,
    update(st, dtRaw, time) {
      const dt = safeDt(dtRaw);
      if (first) { fixFx(root); first = false; }
      if (st.death > 0) { wreckDeath(body, st.death, 1.3); flash.visible = false; return; }
      moveT = damp(moveT, st.moving ? 1 : 0, 6, dt);
      roll += (st.speed * dt) / (0.2 * sc);
      wf.rotation.z = -roll; wr.rotation.z = -roll;
      chassis.position.y = Math.sin(time * 13 + ctx.seed) * 0.012 * moveT;
      chassis.rotation.x = Math.sin(time * 9.3 + ctx.seed) * 0.012 * moveT;
      const target = st.aimAngle != null ? -(st.aimAngle - st.facing) : 0;
      yaw = dampAngle(yaw, target, st.aimAngle != null ? 5 : 2, dt);
      turret.rotation.y = yaw;
      const k = attackPulse(st.sinceAttack, 0.22);
      turret.position.set(LNC_TURRET[0] - Math.cos(yaw) * 0.07 * k, LNC_TURRET[1] - 0.02 * k, Math.sin(yaw) * 0.07 * k);
      flash.visible = k > 0;
      if (k > 0) flash.scale.setScalar(0.7 + (1 - k) * 1.2);
      chassis.rotation.z = 0.03 * k;
      setMuzzle();
    },
    dispose() { root.clear(); },
  };
}

// ───────────────────────────── Macrophage Mech ─────────────────────────────

const MAC_HIP: V3 = [0, 1.12, 0.56];
const MAC_SHOULDER: V3 = [0.32, 1.74, 0.82];
const MAC_MAW: V3 = [0.74, 1.52, 0];

function macrophageGeo(team: TeamPal) {
  const t = new Kit(team);
  const hullScl: V3 = [1.05, 0.82, 0.95];
  t.sphere('ivory', 0.8, [0, 1.6, 0], hullScl, 18, 12);
  t.dome('team', 0.812, [0, 1.6, 0], hullScl, 18, 5, 0.62);
  // equator armour band (open at the front for the maw) and a visor strip
  t.add(new THREE.TorusGeometry(0.8, 0.055, 6, 30, TAU - 1.3), 'steelDark', [0, 1.55, 0], [Math.PI / 2, 0, 0.65], [1.06, 0.96, 1]);
  t.add(new THREE.TorusGeometry(0.8, 0.03, 5, 30), 'steel', [0, 2.0, 0], [Math.PI / 2, 0, 0], [0.84, 0.77, 1]);
  t.box('visor', [0.08, 0.09, 0.5], [0.66, 1.96, 0]);
  t.box('steelDark', [0.5, 0.1, 0.1], [0.02, 2.27, 0]);
  t.box('teamGlow', [0.3, 0.03, 0.11], [0.02, 2.325, 0]);
  t.torus('steel', 0.36, 0.075, MAC_MAW, [0, Math.PI / 2, 0], TAU, 8, 22);
  t.cyl('charcoal', 0.34, 0.34, 0.06, 18, [0.72, 1.52, 0], [0, 0, Math.PI / 2]);
  for (const s of [-1, 1]) {
    t.box('steelDark', [0.06, 0.1, 0.42], [-0.82, 1.48 + 0.14 * (s + 1), 0]);
    t.post('steelDark', 0.05, 0.3, [-0.55, 1.98, 0.25 * s], 8);
    t.cyl('steelDark', 0.16, 0.16, 0.2, 12, [0, 1.12, 0.5 * s], [Math.PI / 2, 0, 0]);
    t.box('teamDark', [0.5, 0.3, 0.05], [-0.1, 1.42, 0.76 * s]);
  }
  t.box('steelDark', [0.06, 0.1, 0.42], [-0.82, 1.48, 0]);
  t.box('graphite', [0.55, 0.32, 0.92], [0, 1.06, 0]);

  const leg = new Kit(team);
  leg.beam('ivory', [0, 0, 0], [0.22, -0.5, 0], 0.32, 0.3);
  leg.sphere('steelDark', 0.14, [0.22, -0.5, 0], 1, 10, 7);
  leg.beam('graphite', [0.22, -0.5, 0], [0.02, -0.98, 0], 0.25, 0.22);
  leg.beam('ivory', [0.27, -0.56, 0], [0.11, -0.92, 0], 0.2, 0.08);
  leg.sphere('steelDark', 0.1, [0.02, -0.98, 0], 1, 8, 6);
  leg.box('charcoal', [0.62, 0.13, 0.42], [0.08, -1.055, 0]);
  leg.box('team', [0.1, 0.06, 0.43], [0.36, -1.03, 0]);

  const arm = new Kit(team);
  arm.sphere('ivory', 0.2, [0, 0, 0], 1, 12, 8);
  arm.dome('team', 0.206, [0, 0, 0], 1, 12, 4, 0.9);
  arm.sphere('ivory', 0.15, [0.1, -0.26, 0.02], [1, 1.3, 1], 10, 7);
  arm.sphere('steelDark', 0.09, [0.2, -0.42, 0.02], 1, 8, 6);
  arm.sphere('ivory', 0.13, [0.3, -0.55, 0], [1.2, 1, 1], 10, 7);
  arm.cyl('steelDark', 0.11, 0.12, 0.14, 10, [0.44, -0.66, 0], [0, 0, -0.9]);
  for (const [z, y] of [[-0.09, 0.02], [0.09, 0.02], [0, -0.1]] as const) {
    arm.beam('steel', [0.48, -0.7, z * 0.6], [0.72, -0.62 + y, z], 0.05, 0.05);
    arm.box('screen', [0.05, 0.05, 0.05], [0.74, -0.62 + y, z]);
  }
  return { hull: t.merge(), leg: leg.merge(), arm: arm.merge() };
}

function macrophage(ctx: ModelBuildContext): EntityModel {
  const g = unitGeo('hosp_macrophage', ctx, 0, macrophageGeo);
  const sc = fitScale(ctx, 1.0);
  const mat = UNIT_MAT();
  const root = new THREE.Group(); root.name = 'model:hosp_macrophage';
  const body = new THREE.Group(); body.scale.setScalar(sc); root.add(body);
  const upper = new THREE.Group(); body.add(upper);
  const hull = makeMesh(g.hull, mat, 'hull');
  const legL = makeMesh(g.leg, mat, 'legL'); legL.position.set(MAC_HIP[0], MAC_HIP[1], -MAC_HIP[2]);
  const legR = makeMesh(g.leg, mat, 'legR'); legR.position.set(...MAC_HIP);
  const armL = makeMesh(g.arm, mat, 'armL'); armL.position.set(MAC_SHOULDER[0], MAC_SHOULDER[1], -MAC_SHOULDER[2]);
  const armR = makeMesh(g.arm, mat, 'armR'); armR.position.set(...MAC_SHOULDER);
  const ramp = glowRamp(0x3dffc2, 0.5, 3.6, false);
  const core = fx(makeMesh(memo('fx:macCore', () => new THREE.IcosahedronGeometry(0.25, 1)), ramp[2]!, 'core'));
  core.position.set(MAC_MAW[0] + 0.02, MAC_MAW[1], 0);
  upper.add(hull, armL, armR, core);
  body.add(legL, legR);
  let first = true, phase = 0, walk = 0, grab = 0;
  return {
    root, height: 2.5 * sc, muzzle: v3(MAC_MAW[0] + 0.2, MAC_MAW[1], 0).multiplyScalar(sc), handlesDeath: true,
    update(st, dtRaw, time) {
      const dt = safeDt(dtRaw);
      if (first) { fixFx(root); first = false; }
      if (st.death > 0) {
        wreckDeath(body, st.death, 2.6);
        legL.rotation.z = legR.rotation.z = 0;
        core.material = rampPick(ramp, 1 - st.death);
        return;
      }
      walk = damp(walk, st.moving && st.speed > 0.05 ? 1 : 0, 6, dt);
      phase = (phase + dt * Math.max(st.speed, walk * 0.5) * (TAU / 2.3)) % TAU;
      const sw = Math.sin(phase) * walk;
      legL.rotation.z = sw * 0.36;
      legR.rotation.z = -sw * 0.36;
      upper.position.y = Math.abs(Math.cos(phase)) * 0.07 * walk - 0.04 * walk;
      upper.rotation.x = Math.sin(phase) * 0.035 * walk;
      upper.rotation.z = -0.04 * walk + Math.sin(time * 1.3 + ctx.seed) * 0.01;
      const engaged = st.activity === 'attacking' || st.sinceAttack < 1.4;
      const k = attackPulse(st.sinceAttack, 0.35);
      grab = damp(grab, engaged ? 1 : 0, 5, dt);
      const reach = lerp(-0.12, 0.25, grab) + k * 0.65;
      armL.rotation.set(-0.15 * grab - k * 0.25, 0.2 * k, reach + sw * 0.12);
      armR.rotation.set(0.15 * grab + k * 0.25, -0.2 * k, reach - sw * 0.12);
      const pulse = 0.5 + 0.5 * Math.sin(time * (2 + grab * 3));
      core.material = rampPick(ramp, Math.max(k, 0.25 + 0.35 * pulse + 0.2 * grab));
      core.scale.setScalar(1 + k * 0.25);
    },
    dispose() { root.clear(); },
  };
}

// ───────────────────────────── Sterilizer Drone ─────────────────────────────

const DRONE_MOTORS: V3[] = [[0.42, 0.115, 0.42], [0.42, 0.115, -0.42], [-0.42, 0.115, 0.42], [-0.42, 0.115, -0.42]];

function droneGeo(team: TeamPal) {
  const t = new Kit(team);
  t.sphere('white', 0.22, [0, 0, 0], [1.5, 0.72, 1.05], 14, 9);
  t.box('team', [0.44, 0.03, 0.1], [-0.02, 0.152, 0]);
  t.sphere('visor', 0.1, [0.2, 0.07, 0], [1.2, 0.7, 1.0], 10, 7);
  for (const [x, , z] of DRONE_MOTORS) {
    t.beam('team', [x * 0.22, 0.02, z * 0.22], [x * 0.95, 0.04, z * 0.95], 0.065, 0.045);
    t.post('graphite', 0.06, 0.1, [x, 0.0, z], 10);
    t.torus('steel', 0.2, 0.018, [x, 0.07, z], [Math.PI / 2, 0, 0], TAU, 5, 20);
    t.box(x > 0 ? 'screen' : 'tailLight', [0.03, 0.03, 0.03], [x * 1.08, 0.03, z * 1.08]);
  }
  t.cyl('steelDark', 0.065, 0.05, 0.12, 10, [0.27, -0.12, 0]);
  t.box('uvGlow', [0.08, 0.02, 0.08], [0.27, -0.185, 0]);
  for (const z of [-0.15, 0.15]) {
    t.rod('graphite', [-0.2, -0.23, z], [0.2, -0.23, z], 0.014, 4);
    t.rod('graphite', [-0.1, -0.23, z], [-0.06, -0.1, z * 0.7], 0.012, 4);
    t.rod('graphite', [0.1, -0.23, z], [0.06, -0.1, z * 0.7], 0.012, 4);
  }
  // all four rotors merged into ONE mesh; ROTOR_FRAMES pre-rotated copies are swapped per frame to spin
  const rotorFrames: Geo[] = [];
  for (let f = 0; f < ROTOR_FRAMES; f++) {
    const r = new Kit(team);
    DRONE_MOTORS.forEach((p, i) => {
      const a = (i * 0.7) + (i % 2 ? 1 : -1) * (f / ROTOR_FRAMES) * Math.PI;
      r.group(p, [0, a, 0], () => {
        r.box('graphite', [0.36, 0.012, 0.045], [0, 0.0, 0]);
        r.box('teamLight', [0.04, 0.014, 0.047], [0.16, 0.001, 0]);
        r.box('teamLight', [0.04, 0.014, 0.047], [-0.16, 0.001, 0]);
        r.cyl('steel', 0.025, 0.025, 0.03, 8, [0, 0, 0]);
      });
    });
    rotorFrames.push(r.merge());
  }
  return { body: t.merge(), rotorFrames };
}

const ROTOR_FRAMES = 5;

function sterilizerDrone(ctx: ModelBuildContext): EntityModel {
  const g = unitGeo('hosp_sterilizer_drone', ctx, 0, droneGeo);
  const sc = fitScale(ctx, 0.6);
  const def = tryGetDef(ctx.defId) as UnitDef | undefined;
  const fly = def?.flyHeight ?? DEFAULT_FLY_HEIGHT;
  const mat = UNIT_MAT();
  const root = new THREE.Group(); root.name = 'model:hosp_sterilizer_drone';
  const body = new THREE.Group(); body.scale.setScalar(sc); root.add(body);
  const hull = makeMesh(g.body, mat, 'body');
  body.add(hull);
  const rotors = makeMesh(g.rotorFrames[0]!, mat, 'rotors');
  body.add(rotors);
  let rotorPhase = ctx.seed % ROTOR_FRAMES;
  const spinRotors = (rate: number, dt: number) => {
    rotorPhase = (rotorPhase + rate * dt) % ROTOR_FRAMES;
    rotors.geometry = g.rotorFrames[Math.floor(rotorPhase)]!;
  };
  const ramp = glowRamp(0xb46bff, 0.6, 4, false);
  const lens = fx(makeMesh(memo('fx:lens', () => new THREE.IcosahedronGeometry(0.06, 1)), ramp[1]!, 'lens'));
  lens.position.set(0.28, -0.2, 0);
  body.add(lens);
  let first = true, tilt = 0, bank = 0, lastFacing: number | null = null, spin = 0;
  const phase = (ctx.seed % 13) * 0.5;
  return {
    root, height: 0.4 * sc, muzzle: v3(0.28, -0.2, 0).multiplyScalar(sc), handlesDeath: true,
    update(st, dtRaw, time) {
      const dt = safeDt(dtRaw);
      if (first) { fixFx(root); first = false; }
      if (st.death > 0) {
        const f = easeInCubic(clamp01(st.death));
        spin += dt * (6 + st.death * 14);
        body.position.set(0, -fly * f, 0);
        body.rotation.set(0.5 * f, spin, -0.6 * f);
        spinRotors(30 * (1 - st.death), dt);
        return;
      }
      const spd = clamp01(st.speed / 4.2);
      tilt = damp(tilt, -0.28 * spd, 5, dt);
      let turnRate = 0;
      if (lastFacing != null && dt > 0) turnRate = Math.atan2(Math.sin(st.facing - lastFacing), Math.cos(st.facing - lastFacing)) / dt;
      lastFacing = st.facing;
      bank = damp(bank, Math.max(-0.4, Math.min(0.4, turnRate * 0.12)), 4, dt);
      body.position.set(0, Math.sin(time * 2.3 + phase) * 0.06, 0);
      body.rotation.set(bank, 0, tilt);
      spinRotors(40 + spd * 12, dt);
      const k = attackPulse(st.sinceAttack, 0.15);
      const engaged = st.activity === 'attacking' || st.sinceAttack < 1;
      lens.material = rampPick(ramp, Math.max(k, engaged ? 0.45 + 0.2 * Math.sin(time * 10) : 0.2));
      lens.scale.setScalar(1 + k * 0.8);
    },
    dispose() { root.clear(); },
  };
}

export const HOSPITAL_UNIT_MODELS: Record<string, ModelBuilder> = {
  hosp_orderly: orderly,
  hosp_sanitizer: sanitizer,
  hosp_medic: medic,
  hosp_uv_lancer: uvLancer,
  hosp_antibiotic_launcher: antibioticLauncher,
  hosp_macrophage: macrophage,
  hosp_sterilizer_drone: sterilizerDrone,
};
