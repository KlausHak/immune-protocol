/**
 * [vfx] VFX sandbox — visual testbed for src/render/vfx.
 *
 *   /sandbox/vfx.html                 battle: createWorld(test map) with both factions facing off (real sim
 *                                     modules + revealAll); fresh waves respawn so the fight never ends
 *   /sandbox/vfx.html?grid=1          every effect at a fixed spot, driven through the REAL event paths
 *                                     (weaponFired / projectileImpact / entityDied / ... emitted inside a sim
 *                                     system; projectiles live in world.projectiles), re-triggered every 4 s
 *     &only=weapons|deaths|feedback|abilities   subset with a closer (RTS-distance) camera
 *   ?t=<seconds>|best  deterministic: fast-forward at a fixed 60 fps to t and freeze (grid: best = every cell
 *                      at its showcase moment); &dt=<s> offsets t=best
 *   ?bloom=0 · ?quality=low|medium|high · ?env=1 (EnvironmentView terrain) · ?cam=x,z,dist[,yawDeg] · ?labels=0
 * Debug hook: window.__vfx = { world, vfx, advance(sec), freeze(on), trigger(kind, x, y, opts), stats() }
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { DEFAULT_FLY_HEIGHT, PLAYER_COLORS, TICK_DT } from '../src/config';
import type { BuildingDef, DamageType, Entity, EntityId, PlayerId, Projectile, UnitDef, Vec2, WeaponDef } from '../src/core/types';
import { sampleHeight } from '../src/core/terrain';
import { ABILITY_DEFS, FACTIONS, getBuildingDef, getUnitDef } from '../src/data';
import type { Quality } from '../src/game/settings';
import { getMap } from '../src/map';
import { EnvironmentView } from '../src/render/environment';
import { createEntityModel, type EntityModel, type ModelAnimState } from '../src/render/models';
import { VfxSystem, type SpawnEffectOptions, type VfxEffectKind } from '../src/render/vfx';
import { createWorld } from '../src/sim/setup';
import { World } from '../src/sim/World';

const q = new URLSearchParams(location.search);
const GRID = q.get('grid') === '1';
const ONLY = q.get('only');
const BLOOM = q.get('bloom') !== '0';
const QUALITY = (q.get('quality') as Quality | null) ?? 'high';
const LABELS = q.get('labels') !== '0';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const labelsEl = document.getElementById('labels') as HTMLDivElement;
const hud = document.getElementById('hud') as HTMLDivElement;

// ───────────────────────── world ─────────────────────────
const map = getMap('test');
const players = [
  { id: 1, faction: 'hospital' as const, team: 1, controller: 'human' as const },
  { id: 2, faction: 'pathogen' as const, team: 2, controller: 'ai' as const },
];
let world: World;
if (GRID) {
  // stubs only: fully deterministic and independent of the in-progress sim modules
  world = new World({
    map, seed: 7,
    players: players.map((p) => ({ ...p, name: FACTIONS[p.faction].name, color: PLAYER_COLORS[p.id] ?? FACTIONS[p.faction].color })),
  });
  world.removeSystem('combat');
  world.idleBehavior = () => {};
  world.rules.autoDefeat = false;
} else {
  try { world = createWorld(map, players, 7); } catch (err) {
    console.warn('[vfx-sandbox] createWorld failed, falling back to stub world', err);
    world = new World({ map, seed: 7, players: players.map((p) => ({ ...p, name: p.faction, color: PLAYER_COLORS[p.id]! })) });
  }
  world.rules.autoDefeat = false;
}

// ───────────────────────── three ─────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 400);

if (q.get('env') === '1') {
  try {
    new EnvironmentView({ scene, renderer, camera, world, map, localPlayerId: 1, quality: QUALITY });
  } catch (err) { console.warn('[vfx-sandbox] EnvironmentView failed', err); addSimpleGround(); }
} else addSimpleGround();

function addSimpleGround(): void {
  scene.background = new THREE.Color(0x36474f);
  scene.fog = new THREE.Fog(0x36474f, 70, 160);
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x3a3020, 1.1));
  const sun = new THREE.DirectionalLight(0xffe2c0, 2.0);
  sun.position.set(30, 50, 10);
  sun.target.position.set(48, 0, 48);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 160;
  scene.add(sun, sun.target);
  // a dusk-toned ground with a faint tile grid (readability of scale)
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#4a6a3c'; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 2; g.strokeRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(map.width, map.height); tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(map.width, map.height).rotateX(-Math.PI / 2).translate(map.width / 2, 0, map.height / 2),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  ground.receiveShadow = true;
  scene.add(ground);
}

// ───────────────────────── entity views (mirrors GameRenderer placement) ─────────────────────────
interface View { e: Entity; model: EntityModel; dying: boolean; deathT: number }
const views = new Map<EntityId, View>();
function addView(e: Entity): void {
  if (views.has(e.id)) return;
  const p = world.players.get(e.owner);
  const def = e.def;
  const model = createEntityModel({
    defId: e.defId, faction: def.kind === 'resource' ? 'neutral' : def.faction, teamColor: new THREE.Color(p?.color ?? 0xcccccc),
    radius: e.radius, footprint: def.kind === 'unit' ? undefined : (def as BuildingDef).footprint, seed: e.id,
  });
  model.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(model.root);
  views.set(e.id, { e, model, dying: false, deathT: 0 });
}
function removeView(id: EntityId): void {
  const v = views.get(id); if (!v) return;
  scene.remove(v.model.root); v.model.dispose(); views.delete(id);
}
for (const e of world.list) addView(e);
world.events.on('entitySpawned', ({ entity }) => addView(entity));
world.events.on('entityDied', ({ entity }) => { const v = views.get(entity.id); if (v) v.dying = true; });
world.events.on('entityRemoved', ({ entity, reason }) => { if (reason === 'removed') removeView(entity.id); });

let viewTime = 0;
function updateViews(alpha: number, dt: number): void {
  viewTime += dt;
  for (const [id, v] of views) {
    const e = v.e;
    if (v.dying) { v.deathT += dt / 1.2; if (v.deathT >= 1) { removeView(id); continue; } }
    const x = e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha, y = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha;
    const fly = e.mover?.flying ? (e.def as UnitDef).flyHeight ?? DEFAULT_FLY_HEIGHT : 0;
    const root = v.model.root;
    root.position.set(x, sampleHeight(map, x, y) + fly - (v.dying && !v.model.handlesDeath ? v.deathT * 1.5 : 0), y);
    root.rotation.y = -e.facing;
    const target = e.combat?.targetId != null ? world.getAlive(e.combat.targetId) : undefined;
    const st: ModelAnimState = {
      moving: !!e.mover?.moving, speed: e.mover ? Math.hypot(e.mover.vel.x, e.mover.vel.y) : 0, activity: e.activity,
      sinceAttack: e.combat && e.combat.lastAttackTime >= 0 ? world.time - e.combat.lastAttackTime : Infinity,
      construction: e.construction ? e.construction.progress / e.construction.total : 1,
      hpFrac: e.hp / Math.max(1, e.stats.maxHp), carrying: (e.gatherer?.carrying ?? 0) > 0,
      producing: (e.production?.queue.length ?? 0) > 0 && !e.construction, selected: false,
      death: v.dying ? v.deathT : 0, aimAngle: target ? Math.atan2(target.pos.y - e.pos.y, target.pos.x - e.pos.x) : null, facing: e.facing,
      resourceFrac: e.resource ? e.resource.amount / Math.max(1, e.resource.initial) : 1,
    };
    try { v.model.update(st, dt, viewTime); } catch { /* artist model WIP */ }
  }
}

// ───────────────────────── VFX ─────────────────────────
let shakeT = 0, shakeI = 0;
const vfx = new VfxSystem({
  scene, camera, world, localPlayerId: 1, quality: QUALITY, seed: 1234,
  getEntityModel: (id) => views.get(id)?.model,
  heightAt: (x, y) => sampleHeight(map, x, y),
  onShake: (i, s) => { shakeI = Math.max(shakeI, i); shakeT = Math.max(shakeT, s); },
});

// ───────────────────────── helpers ─────────────────────────
const unit = (defId: string, owner: PlayerId, x: number, z: number, facing = owner === 1 ? 0 : Math.PI): Entity =>
  world.spawnUnit(defId, owner, { x, y: z }, { facing });
const building = (defId: string, owner: PlayerId, cx: number, cz: number, complete = true): Entity => {
  const fp = getBuildingDef(defId).footprint;
  return world.spawnBuilding(defId, owner, { x: Math.round(cx - fp.w / 2), y: Math.round(cz - fp.h / 2) }, { complete });
};
const weaponOf = (defId: string, i = 0): WeaponDef => {
  const d = getUnitDef(defId);
  return d.weapons[i]!;
};
const flyH = (e: Entity): number => (e.mover?.flying ? (e.def as UnitDef).flyHeight ?? DEFAULT_FLY_HEIGHT : 0);

/** What the combat module does for an instant weapon: weaponFired + entityDamaged. */
function fireInstant(src: Entity, tgt: Entity, weapon: WeaponDef): void {
  if (src.combat) src.combat.lastAttackTime = world.time;
  src.facing = Math.atan2(tgt.pos.y - src.pos.y, tgt.pos.x - src.pos.x);
  world.events.emit('weaponFired', { source: src, target: tgt, targetPos: { x: tgt.pos.x, y: tgt.pos.y }, weapon, projectile: null });
  world.events.emit('entityDamaged', { entity: tgt, amount: weapon.damage, type: weapon.damageType, source: src });
}

/** What the combat module does for a projectile weapon: push into world.projectiles + weaponFired. */
function launch(src: Entity, tgt: Entity | null, tp: Vec2, weapon: WeaponDef): Projectile {
  if (src.combat) src.combat.lastAttackTime = world.time;
  src.facing = Math.atan2(tp.y - src.pos.y, tp.x - src.pos.x);
  const p: Projectile = {
    id: world.nextProjectileId++, ownerPlayer: src.owner, sourceId: src.id, targetId: weapon.arc ? null : tgt?.id ?? null,
    weapon, vfx: weapon.vfx, pos: { x: src.pos.x, y: src.pos.y }, prevPos: { x: src.pos.x, y: src.pos.y },
    start: { x: src.pos.x, y: src.pos.y }, targetPos: { x: tp.x, y: tp.y }, t: 0, prevT: 0,
    speed: weapon.projectileSpeed ?? 12, arc: !!weapon.arc, damage: weapon.damage, splashRadius: weapon.splashRadius ?? 0,
    startHeight: flyH(src) + 0.7, endHeight: tgt ? flyH(tgt) + 0.5 : 0.1,
  };
  world.projectiles.push(p);
  world.events.emit('weaponFired', { source: src, target: tgt, targetPos: { ...tp }, weapon, projectile: p });
  return p;
}

/** Sandbox projectile stepping (stands in for the combat module in grid mode). */
function stepProjectiles(dt: number): void {
  for (let i = world.projectiles.length - 1; i >= 0; i--) {
    const p = world.projectiles[i]!;
    const tgt = p.targetId != null ? world.getAlive(p.targetId) : undefined;
    if (tgt) { p.targetPos.x = tgt.pos.x; p.targetPos.y = tgt.pos.y; }
    const total = Math.hypot(p.targetPos.x - p.start.x, p.targetPos.y - p.start.y) || 0.01;
    p.t = Math.min(1, p.t + (p.speed * dt) / total);
    p.pos.x = p.start.x + (p.targetPos.x - p.start.x) * p.t;
    p.pos.y = p.start.y + (p.targetPos.y - p.start.y) * p.t;
    if (p.t >= 1) {
      world.projectiles.splice(i, 1);
      world.events.emit('projectileImpact', { projectile: p, pos: { x: p.targetPos.x, y: p.targetPos.y }, target: tgt ?? null });
      if (tgt) world.events.emit('entityDamaged', { entity: tgt, amount: p.damage, type: p.weapon.damageType as DamageType, source: world.get(p.sourceId) ?? null });
    }
  }
}

// ───────────────────────── grid definition ─────────────────────────
type Group = 'weapons' | 'deaths' | 'feedback' | 'abilities';
interface CellState { x: number; z: number; e: Record<string, Entity>; n: number }
interface CellDef {
  name: string;
  group: Group;
  /** seconds after the trigger when the effect looks most representative */
  best: number;
  setup?: (s: CellState) => void;
  trigger?: (s: CellState) => void;
  /** after-trigger sub-events: [delay, fn] */
  seq?: Array<[number, (s: CellState) => void]>;
  /** every tick */
  tick?: (s: CellState, dt: number) => void;
  /** re-create entities killed by the trigger this long after it */
  respawn?: number;
}

const shotPair = (srcId: string, tgtId: string, tgtOwner: PlayerId = 2, d = 4.4, srcOwner: PlayerId = 1) => (s: CellState) => {
  s.e.src = unit(srcId, srcOwner, s.x - d / 2, s.z);
  s.e.tgt = unit(tgtId, tgtOwner, s.x + d / 2, s.z);
};
const fireAt = (wDef: string, wi = 0) => (s: CellState) => {
  const w = weaponOf(wDef, wi);
  if (w.projectileSpeed) launch(s.e.src!, w.arc ? null : s.e.tgt!, { x: s.e.tgt!.pos.x, y: s.e.tgt!.pos.y }, w);
  else fireInstant(s.e.src!, s.e.tgt!, w);
};
const killer = (defId: string, owner: PlayerId, building = false) => ({
  setup: (s: CellState) => { s.e.v = building ? (bld(defId, owner, s)) : unit(defId, owner, s.x, s.z, 0.6); },
  trigger: (s: CellState) => { const v = s.e.v; if (v?.alive) world.killEntity(v, null); },
  respawn: 1.7,
});
function bld(defId: string, owner: PlayerId, s: CellState): Entity { return building(defId, owner, s.x, s.z); }

const CELLS: CellDef[] = [
  // ── weapons ──
  { name: 'spray · Sanitizer', group: 'weapons', best: 0.13, setup: shotPair('hosp_sanitizer', 'path_phage'), trigger: fireAt('hosp_sanitizer') },
  { name: 'uv_beam · UV Lancer', group: 'weapons', best: 0.08, setup: shotPair('hosp_uv_lancer', 'path_phage', 2, 4.8), trigger: fireAt('hosp_uv_lancer') },
  { name: 'engulf · Macrophage', group: 'weapons', best: 0.17, setup: shotPair('hosp_macrophage', 'path_bacillus', 2, 2.3), trigger: fireAt('hosp_macrophage') },
  { name: 'zap · Orderly', group: 'weapons', best: 0.05, setup: shotPair('hosp_orderly', 'path_phage', 2, 0.95), trigger: fireAt('hosp_orderly') },
  { name: 'bite · Phage', group: 'weapons', best: 0.04, setup: shotPair('path_phage', 'hosp_sanitizer', 1, 0.95, 2), trigger: fireAt('path_phage') },
  { name: 'whip · Spirochete', group: 'weapons', best: 0.1, setup: shotPair('path_spirochete', 'hosp_sanitizer', 1, 1.6, 2), trigger: fireAt('path_spirochete') },
  { name: 'slam · Superbug', group: 'weapons', best: 0.1, setup: shotPair('path_superbug', 'hosp_orderly', 1, 2.0, 2), trigger: fireAt('path_superbug') },
  {
    name: 'antibiotic_capsule · Launcher', group: 'weapons', best: 0.62, setup: shotPair('hosp_antibiotic_launcher', 'path_bacillus', 2, 5),
    trigger: fireAt('hosp_antibiotic_launcher'), seq: [[0.3, fireAt('hosp_antibiotic_launcher')]],
  },
  {
    name: 'laser · Sterilizer Drone', group: 'weapons', best: 0.3, setup: shotPair('hosp_sterilizer_drone', 'path_flu_drifter', 2, 4.8),
    trigger: fireAt('hosp_sterilizer_drone'), seq: [[0.12, fireAt('hosp_sterilizer_drone')], [0.24, fireAt('hosp_sterilizer_drone')]],
  },
  {
    name: 'acid_spit · Bacillus', group: 'weapons', best: 0.45, setup: shotPair('path_bacillus', 'hosp_orderly', 1, 4.4, 2),
    trigger: fireAt('path_bacillus'), seq: [[0.22, fireAt('path_bacillus')]],
  },
  {
    name: 'spore_lob · Fungal Mortar', group: 'weapons', best: 0.72, setup: shotPair('path_fungal_mortar', 'hosp_sanitizer', 1, 5, 2),
    trigger: fireAt('path_fungal_mortar'), seq: [[0.36, fireAt('path_fungal_mortar')]],
  },
  {
    name: 'toxin_bolt · Flu Drifter', group: 'weapons', best: 0.36, setup: shotPair('path_flu_drifter', 'hosp_sanitizer', 1, 4.4, 2),
    trigger: fireAt('path_flu_drifter'), seq: [[0.12, fireAt('path_flu_drifter')], [0.24, fireAt('path_flu_drifter')]],
  },
  // ── deaths ──
  { name: 'Phage death + viral burst', group: 'deaths', best: 0.18, ...killer('path_phage', 2) },
  { name: 'Bacillus death', group: 'deaths', best: 0.22, ...killer('path_bacillus', 2) },
  { name: 'Superbug death (massive)', group: 'deaths', best: 0.3, ...killer('path_superbug', 2) },
  { name: 'Flu Drifter death (air)', group: 'deaths', best: 0.3, ...killer('path_flu_drifter', 2) },
  { name: 'Orderly death (machine)', group: 'deaths', best: 0.16, ...killer('hosp_orderly', 1) },
  { name: 'Macrophage death', group: 'deaths', best: 0.2, ...killer('hosp_macrophage', 1) },
  { name: 'Drone crash (air machine)', group: 'deaths', best: 0.62, ...killer('hosp_sterilizer_drone', 1) },
  { name: 'Sanitizer evac (staff)', group: 'deaths', best: 0.3, ...killer('hosp_sanitizer', 1) },
  { name: 'Pharmacy collapse', group: 'deaths', best: 0.55, ...killer('hosp_pharmacy', 1, true) },
  { name: 'Replication Pod eruption', group: 'deaths', best: 0.5, ...killer('path_replicator', 2, true) },
  // ── feedback ──
  {
    name: 'hit sparks: metal · goo · staff', group: 'feedback', best: 0.1,
    setup: (s) => {
      s.e.a = unit('hosp_orderly', 1, s.x - 1.6, s.z + 0.6); s.e.b = unit('path_bacillus', 2, s.x, s.z - 0.4); s.e.c = unit('hosp_sanitizer', 1, s.x + 1.6, s.z + 0.6);
      s.e.src = unit('path_phage', 2, s.x - 3.5, s.z - 2.5);
    },
    tick: (s) => {
      s.n++;
      if (s.n % 3 !== 0) return;
      for (const k of ['a', 'b', 'c']) world.events.emit('entityDamaged', { entity: s.e[k]!, amount: 10, type: 'melee', source: s.e.src! });
    },
  },
  {
    name: 'heal beam · Field Medic', group: 'feedback', best: 0.1,
    setup: (s) => { s.e.m = unit('hosp_medic', 1, s.x - 1.7, s.z); s.e.p = unit('hosp_sanitizer', 1, s.x + 1.3, s.z, Math.PI); s.e.p.hp = 20; },
    tick: (s) => world.events.emit('entityHealed', { entity: s.e.p!, amount: 0.5, source: s.e.m! }),
  },
  {
    name: 'repair · Orderly', group: 'feedback', best: 0.1,
    setup: (s) => { s.e.o = unit('hosp_orderly', 1, s.x - 1.5, s.z); s.e.l = unit('hosp_antibiotic_launcher', 1, s.x + 0.6, s.z, Math.PI); s.e.l.hp = 60; },
    tick: (s) => world.events.emit('entityHealed', { entity: s.e.l!, amount: 0.4, source: s.e.o! }),
  },
  { name: 'smoke < 50% · Generator', group: 'feedback', best: 0.1, setup: (s) => { const b = bld('hosp_generator', 1, s); b.hp = b.stats.maxHp * 0.42; } },
  { name: 'fire < 25% · Pharmacy', group: 'feedback', best: 0.1, setup: (s) => { const b = bld('hosp_pharmacy', 1, s); b.hp = b.stats.maxHp * 0.18; } },
  { name: 'ooze · Fermentation Vat', group: 'feedback', best: 0.1, setup: (s) => { const b = bld('path_fermenter', 2, s); b.hp = b.stats.maxHp * 0.5; } },
  { name: 'heavy ooze · Spore Nest', group: 'feedback', best: 0.1, setup: (s) => { const b = bld('path_nest', 2, s); b.hp = b.stats.maxHp * 0.2; } },
  {
    name: 'construction · Research Lab', group: 'feedback', best: 0.1,
    setup: (s) => { s.e.b = building('hosp_lab', 1, s.x, s.z, false); s.e.w = unit('hosp_orderly', 1, s.x - 2.3, s.z + 1.8, -0.6); },
    tick: (s, dt) => { const c = s.e.b?.construction; if (c) { c.progress = (c.progress + dt * 6) % (c.total * 0.85); if (c.progress < c.total * 0.25) c.progress = c.total * 0.25; } },
  },
  {
    name: 'construction · Mutation Pit', group: 'feedback', best: 0.1,
    setup: (s) => { s.e.b = building('path_mutation_pit', 2, s.x, s.z, false); },
    tick: (s, dt) => { const c = s.e.b?.construction; if (c) { c.progress = (c.progress + dt * 6) % (c.total * 0.85); if (c.progress < c.total * 0.25) c.progress = c.total * 0.25; } },
  },
  {
    name: 'construction complete · UV Turret', group: 'feedback', best: 0.25, setup: (s) => { s.e.b = bld('hosp_uv_turret', 1, s); },
    trigger: (s) => world.events.emit('constructionComplete', { building: s.e.b! }),
    seq: [[0.0, (s) => world.events.emit('constructionStarted', { building: s.e.b!, builder: null })]],
  },
  {
    name: 'production complete', group: 'feedback', best: 0.2,
    trigger: (s) => {
      for (const k of ['u1', 'u2']) { const u = s.e[k]; if (u) world.removeEntity(u); }
      s.e.u1 = unit('hosp_sanitizer', 1, s.x - 1.3, s.z);
      s.e.u2 = unit('path_bacillus', 2, s.x + 1.3, s.z);
      world.events.emit('productionComplete', { building: s.e.u1, unit: s.e.u1 });
      world.events.emit('productionComplete', { building: s.e.u2, unit: s.e.u2 });
    },
  },
  {
    name: 'resource delivered', group: 'feedback', best: 0.3,
    setup: (s) => { s.e.w = unit('hosp_orderly', 1, s.x - 1, s.z); s.e.d = unit('path_spore_drone', 2, s.x + 1, s.z); },
    trigger: (s) => {
      world.events.emit('resourceDelivered', { worker: s.e.w!, playerId: 1, kind: 'matter', amount: 5 });
      world.events.emit('resourceDelivered', { worker: s.e.d!, playerId: 2, kind: 'matter', amount: 5 });
    },
  },
  // ── abilities ──
  {
    name: 'uv_flare · UV Lancer', group: 'abilities', best: 0.2,
    setup: (s) => { s.e.l = unit('hosp_uv_lancer', 1, s.x - 2.6, s.z + 1.6); for (let i = 0; i < 3; i++) unit('path_phage', 2, s.x + 0.4 + i * 0.7, s.z - 0.3 + (i % 2) * 0.8); },
    trigger: (s) => world.events.emit('abilityUsed', { source: s.e.l!, abilityId: 'uv_flare', target: { x: s.x + 1, y: s.z }, targetEntity: null }),
  },
  {
    name: 'emergency_supply · HQ', group: 'abilities', best: 2.45, setup: (s) => { s.e.hq = bld('hosp_hq', 1, s); },
    trigger: (s) => world.events.emit('abilityUsed', { source: s.e.hq!, abilityId: 'emergency_supply', target: null, targetEntity: null }),
  },
  {
    name: 'Strain Omega: spawn + Plague Torrent', group: 'abilities', best: 0.42,
    setup: (s) => { s.e.o = unit('path_strain_omega', 2, s.x - 1.2, s.z, 0); s.e.t = unit('hosp_sanitizer', 1, s.x + 2.8, s.z + 0.4, Math.PI); },
    trigger: (s) => world.events.emit('abilityUsed', { source: s.e.o!, abilityId: 'omega_spawn', target: null, targetEntity: null }),
    seq: [[0.06, (s) => launch(s.e.o!, s.e.t!, { x: s.e.t!.pos.x, y: s.e.t!.pos.y }, weaponOf('path_strain_omega'))]],
  },
];

// ───────────────────────── grid runtime ─────────────────────────
const T0 = 1.0, PERIOD = 4.0, SHOW = 2.8, CELL = 6;
interface CellRun { def: CellDef; s: CellState; next: number; respawnAt: number; seqAt: number[]; label: HTMLDivElement | null }
const runs: CellRun[] = [];
let gridCenter = { x: 30, z: 20 }, gridDist = 60;

if (GRID) {
  const defs = CELLS.filter((c) => !ONLY || c.group === ONLY);
  const cols = ONLY ? (defs.length <= 3 ? defs.length : 4) : 8;
  const rows = Math.ceil(defs.length / cols);
  const ox = 8, oz = 8;
  defs.forEach((def, i) => {
    const cx = ox + (i % cols) * CELL + CELL / 2, cz = oz + Math.floor(i / cols) * CELL + CELL / 2;
    const s: CellState = { x: cx, z: cz, e: {}, n: 0 };
    def.setup?.(s);
    let label: HTMLDivElement | null = null;
    if (LABELS) { label = document.createElement('div'); label.className = 'lbl'; label.textContent = def.name; labelsEl.appendChild(label); }
    runs.push({ def, s, next: T0 + SHOW - def.best, respawnAt: Infinity, seqAt: [], label });
  });
  gridCenter = { x: ox + (cols * CELL) / 2, z: oz + (rows * CELL) / 2 };
  gridDist = ONLY === 'abilities' ? 44 : ONLY ? 40 : 62;
  world.addSystem({
    name: 'vfx-sandbox', order: 45,
    update: (w, dt) => {
      stepProjectiles(dt);
      for (const r of runs) {
        const { def, s } = r;
        if (w.time >= r.respawnAt) { r.respawnAt = Infinity; def.setup?.(s); }
        if (w.time >= r.next) {
          r.next += PERIOD;
          if (def.trigger) {
            try { def.trigger(s); } catch (err) { console.warn('[vfx-sandbox] trigger failed', def.name, err); }
            if (def.respawn) r.respawnAt = w.time + def.respawn;
            r.seqAt = (def.seq ?? []).map(([d]) => w.time + d);
          }
        }
        for (let k = 0; k < r.seqAt.length; k++) {
          if (w.time >= r.seqAt[k]!) { r.seqAt[k] = Infinity; try { def.seq![k]![1](s); } catch (err) { console.warn('[vfx-sandbox] seq failed', def.name, err); } }
        }
        def.tick?.(s, dt);
      }
    },
  });
} else {
  // ── battle: two lines facing each other + a few structures; waves respawn ──
  const hosp = ['hosp_sanitizer', 'hosp_uv_lancer', 'hosp_sanitizer', 'hosp_antibiotic_launcher', 'hosp_macrophage', 'hosp_sanitizer', 'hosp_uv_lancer', 'hosp_medic', 'hosp_sterilizer_drone', 'hosp_orderly'];
  const path = ['path_phage', 'path_bacillus', 'path_phage', 'path_fungal_mortar', 'path_superbug', 'path_phage', 'path_bacillus', 'path_spirochete', 'path_flu_drifter', 'path_spore_drone'];
  const line = (owner: PlayerId) => {
    const ids = owner === 1 ? hosp : path;
    ids.forEach((id, i) => unit(id, owner, 38.5 + i * 1.25, owner === 1 ? 50 : 56.5));
  };
  line(1); line(2);
  try { building('hosp_uv_turret', 1, 36, 48); building('path_toxin_spitter', 2, 52, 59); } catch { /* placement */ }
  try { const g = building('hosp_generator', 1, 33, 51); g.hp = g.stats.maxHp * 0.4; const n = building('path_nest', 2, 55, 56); n.hp = n.stats.maxHp * 0.25; } catch { /* placement */ }
  try { world.vision.revealAll(1, true); } catch { /* stub */ }
  world.addSystem({
    name: 'vfx-sandbox-waves', order: 95,
    update: (w) => {
      if (w.tick % 20 !== 0) return;
      for (const owner of [1, 2] as PlayerId[]) {
        const n = w.entitiesOf(owner, (e) => e.kind === 'unit').length;
        if (n < 5) line(owner);
      }
    },
  });
  gridCenter = { x: 44, z: 53 };
  gridDist = 34;
}

// ───────────────────────── camera ─────────────────────────
const camOverride = q.get('cam')?.split(',').map(Number);
const camTarget = { x: camOverride?.[0] ?? gridCenter.x, z: camOverride?.[1] ?? gridCenter.z };
const camDist = camOverride?.[2] ?? gridDist;
const camYaw = THREE.MathUtils.degToRad(camOverride?.[3] ?? 0);
const pitch = THREE.MathUtils.degToRad(56);
function placeCamera(): void {
  const off = new THREE.Vector3(0, Math.sin(pitch) * camDist, Math.cos(pitch) * camDist).applyAxisAngle(new THREE.Vector3(0, 1, 0), camYaw);
  let sx = 0, sz = 0;
  if (shakeT > 0) { sx = (Math.random() - 0.5) * shakeI; sz = (Math.random() - 0.5) * shakeI; }
  camera.position.set(camTarget.x + off.x + sx, off.y, camTarget.z + off.z + sz);
  camera.lookAt(camTarget.x + sx, 0, camTarget.z + sz);
}

// ───────────────────────── post ─────────────────────────
let composer: EffectComposer | null = null;
let bloomPass: UnrealBloomPass | null = null;
if (BLOOM) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.55, 0.85);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
}
function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer?.setSize(w, h);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ───────────────────────── loop ─────────────────────────
let acc = 0;
let frozen = false;
let frozenAlpha = 1;
/** frames still to render while frozen (then the loop idles so screenshot capture isn't starved) */
let frozenFrames = 3;
let last = performance.now();
let fpsAcc = 0, fpsN = 0, fps = 0, hudAt = 0;

/** One 'frame' of sim + views + vfx at a fixed dt (deterministic fast-forward). */
function frameStep(dt: number): number {
  acc += dt;
  let steps = 0;
  while (acc >= TICK_DT && steps < 8) { world.step(); acc -= TICK_DT; steps++; }
  if (acc > TICK_DT * 4) acc = 0;
  const alpha = Math.min(1, acc / TICK_DT);
  updateViews(alpha, dt);
  placeCamera();
  vfx.update(dt, viewTime, alpha);
  return alpha;
}

function advance(seconds: number): void {
  const n = Math.max(0, Math.round(seconds * 60));
  for (let i = 0; i < n; i++) frameAlphaLast = frameStep(1 / 60);
}
let frameAlphaLast = 1;

function render(): void {
  if (shakeT > 0) shakeT -= 1 / 60;
  if (composer) composer.render(); else renderer.render(scene, camera);
}

function updateLabels(): void {
  if (!LABELS || !GRID) return;
  const w = window.innerWidth, h = window.innerHeight;
  const v = new THREE.Vector3();
  for (const r of runs) {
    if (!r.label) continue;
    v.set(r.s.x, 0, r.s.z + CELL / 2 - 0.6).project(camera);
    r.label.style.left = `${((v.x + 1) / 2) * w}px`;
    r.label.style.top = `${((1 - v.y) / 2) * h}px`;
    r.label.style.display = v.z < 1 ? 'block' : 'none';
  }
}

function loop(now: number): void {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fpsAcc += dt; fpsN++;
  if (fpsAcc >= 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  if (!frozen) frameAlphaLast = frameStep(dt);
  else {
    if (frozenFrames <= 0) return;
    frozenFrames--;
    updateViews(frozenAlpha, 0); placeCamera(); vfx.update(0, viewTime, frozenAlpha);
  }
  render();
  updateLabels();
  if (now >= hudAt) {
    hudAt = now + 500;
    const s = vfx.stats();
    hud.textContent = `VFX sandbox ${GRID ? `grid${ONLY ? `:${ONLY}` : ''}` : 'battle'} · ${QUALITY}${frozen ? ' · frozen' : ''}\n`
      + `fps ${fps.toFixed(0)} · t ${world.time.toFixed(2)}s\n`
      + `particles ${s.particlesAlive}/${s.particleCapacity} · pressure ${s.pressure.toFixed(2)}\n`
      + `strips ${s.strips} · sprites ${s.sprites} · decals ${s.decals}\n`
      + `projectiles ${s.projectiles} · shots ${s.shots} · emitters ${s.emitters} · heli ${s.helicopters}`;
  }
}

// deterministic time: ?t=<sec> | best
const tParam = q.get('t');
if (tParam != null) {
  // +1 tick: the render clock trails world.time by one tick (interpolation), +a frame for event quantisation
  const target = tParam === 'best' ? T0 + SHOW + TICK_DT + 1 / 60 + Number(q.get('dt') ?? 0) : Number(tParam);
  if (Number.isFinite(target) && target > 0) {
    advance(target);
    frozen = true;
    frozenAlpha = frameAlphaLast;
  }
}

declare global { interface Window { __vfx?: unknown; __vfxReady?: boolean } }
window.__vfx = {
  world, vfx, scene, camera,
  advance: (sec: number) => { advance(sec); frozenAlpha = frameAlphaLast; frozenFrames = 3; },
  freeze: (on: boolean) => { frozen = on; frozenAlpha = frameAlphaLast; frozenFrames = 3; last = performance.now(); },
  trigger: (kind: VfxEffectKind, x: number, y: number, opts?: SpawnEffectOptions) => { vfx.spawnEffect(kind, { x, y }, opts); frozenFrames = 3; },
  stats: () => vfx.stats(),
  abilities: ABILITY_DEFS,
  /** Render now and read the canvas back (+ cell labels) as a PNG data URL — screenshot without compositor capture. */
  snapshot: (): string => {
    render();
    updateLabels();
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    const g = out.getContext('2d')!;
    g.drawImage(canvas, 0, 0);
    const k = canvas.width / Math.max(1, window.innerWidth);
    g.font = `600 ${Math.round(12 * k)}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const r of runs) {
      if (!r.label || r.label.style.display === 'none') continue;
      const x = parseFloat(r.label.style.left) * k, y = parseFloat(r.label.style.top) * k;
      const w = g.measureText(r.def.name).width + 10 * k;
      g.fillStyle = 'rgba(6,18,22,0.65)'; g.fillRect(x - w / 2, y, w, 16 * k);
      g.fillStyle = '#e8fbf8'; g.fillText(r.def.name, x, y + 2 * k);
    }
    return out.toDataURL('image/png');
  },
};
window.__vfxReady = true;
requestAnimationFrame(loop);
