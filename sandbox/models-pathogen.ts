/**
 * [models-pathogen] Visual testbed for every pathogen model: units, Strain Omega, structures and infection
 * doodads on a dark asphalt / contaminated ground, seen from an RTS-like camera.
 *
 * URL flags:
 *   ?anim=idle|walk|attack|produce|construct|construct50|death|death50   animation state (number = fixed %)
 *   ?focus=<defId|doodadKind>   close-up of one item          ?view=all|units|structures|doodads|swarm
 *   ?team=d64bff                team colour (hex)              ?bloom=1   preview with bloom
 *   ?since=0.05                 fixed seconds-since-attack     ?hp=30     hp percent (superbug enrage)
 *   ?dist=40 ?pitch=56 ?yaw=0   camera overrides               ?guides=0  hide footprint / radius guides
 *   ?time=3.2                   freeze the clock (deterministic screenshots; renders a few frames, then idles)
 *   ?shadows=0                  disable shadows (faster on SwiftShader)
 * Screenshot helper: --wait-for "window.__sandbox && window.__sandbox.frames >= 3"
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { createDoodad, createEntityModel, type EntityModel, type ModelAnimState } from '../src/render/models';
import { tryGetDef } from '../src/data';
import type { BuildingDef, DoodadKind, UnitDef } from '../src/core/types';

const q = new URLSearchParams(location.search);
const anim = q.get('anim') ?? 'idle';
const focus = q.get('focus');
const view = q.get('view') ?? 'all';
const team = new THREE.Color(Number.parseInt(q.get('team') ?? 'd64bff', 16));
const fixedSince = q.has('since') ? Number(q.get('since')) : null;
const hpFrac = q.has('hp') ? Number(q.get('hp')) / 100 : 1;
const frozen = q.has('time') ? Number(q.get('time')) : null;
const guides = q.get('guides') !== '0';

const UNITS = ['path_spore_drone', 'path_phage', 'path_bacillus', 'path_spirochete', 'path_fungal_mortar', 'path_superbug', 'path_flu_drifter'];
const STRUCTURES = ['path_hive', 'path_biofilm_spire', 'path_replicator', 'path_mutation_pit', 'path_nest', 'path_fermenter', 'path_toxin_spitter'];
const DOODADS: DoodadKind[] = ['biohazard_barrel', 'goo_puddle', 'sewer_grate', 'infected_growth', 'spore_vent', 'waste_container'];

// ───────────────────────────── renderer / scene ─────────────────────────────
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = q.get('shadows') !== '0';
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
const camera = new THREE.PerspectiveCamera(45, 1, 0.3, 400);

scene.add(new THREE.HemisphereLight(0xdfefff, 0x3a3020, 1.2));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
sun.position.set(-18, 40, -10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -40; sc.right = 40; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 120;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

// ground: dark asphalt with contaminated purple blotches (vertex colours) + faint tile grid
{
  const W = 110, H = 70;
  const g = new THREE.PlaneGeometry(W, H, W, H);
  g.rotateX(-Math.PI / 2);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const asphalt = new THREE.Color(0x2f3237), goo = new THREE.Color(0x4b2356), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const n = Math.sin(x * 0.21 + Math.cos(z * 0.17) * 2) + Math.cos(z * 0.23 - x * 0.07) + 0.5 * Math.sin(x * 0.9 + z * 1.3);
    const k = THREE.MathUtils.smoothstep(n, 0.6, 1.6);
    c.copy(asphalt).lerp(goo, k * 0.85).multiplyScalar(0.92 + 0.16 * Math.sin(x * 7.1 + z * 5.3) * Math.sin(x * 3.3 - z * 4.1));
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  ground.receiveShadow = true;
  scene.add(ground);
  if (guides) {
    const grid = new THREE.GridHelper(W, W, 0x50555e, 0x3a3e45);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.22;
    grid.position.y = 0.005;
    scene.add(grid);
  }
}

// ───────────────────────────── gallery layout ─────────────────────────────
interface Item {
  id: string; label: string; kind: 'unit' | 'building' | 'doodad';
  obj: THREE.Object3D; model?: EntityModel; x: number; z: number; fly: number; size: number; facing: number;
  unitDef?: UnitDef; buildingDef?: BuildingDef; seed: number;
}
const items: Item[] = [];
let seedCounter = 1;

function addModel(id: string, x: number, z: number, facing = 0, label = true): Item | null {
  const def = tryGetDef(id);
  if (!def || def.kind === 'resource') return null;
  const seed = seedCounter++;
  const isUnit = def.kind === 'unit';
  const model = createEntityModel({
    defId: id, faction: 'pathogen', teamColor: team.clone(), radius: isUnit ? (def as UnitDef).radius : 1,
    footprint: isUnit ? undefined : (def as BuildingDef).footprint, seed,
  });
  model.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const fly = isUnit ? (def as UnitDef).flyHeight ?? 0 : 0;
  model.root.position.set(x, fly, z);
  model.root.rotation.y = -facing;
  scene.add(model.root);
  const size = isUnit ? (def as UnitDef).radius : Math.max((def as BuildingDef).footprint.w, (def as BuildingDef).footprint.h) / 2;
  const it: Item = {
    id, label: label ? def.name : '', kind: isUnit ? 'unit' : 'building', obj: model.root, model, x, z, fly, size, facing,
    unitDef: isUnit ? (def as UnitDef) : undefined, buildingDef: isUnit ? undefined : (def as BuildingDef), seed,
  };
  items.push(it);
  if (guides) {
    if (isUnit) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(size * 0.97, size, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x46ff9a, transparent: true, opacity: 0.35, depthWrite: false }));
      ring.position.set(x, 0.02, z);
      scene.add(ring);
    } else {
      const { w, h } = (def as BuildingDef).footprint;
      const pts = [new THREE.Vector3(-w / 2, 0, -h / 2), new THREE.Vector3(w / 2, 0, -h / 2), new THREE.Vector3(w / 2, 0, h / 2), new THREE.Vector3(-w / 2, 0, h / 2)];
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x9dff4a, transparent: true, opacity: 0.5 }));
      line.position.set(x, 0.03, z);
      scene.add(line);
    }
  }
  return it;
}

function addDoodad(kind: DoodadKind, x: number, z: number): void {
  const seed = seedCounter++;
  const obj = createDoodad(kind, seed, 1);
  obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  obj.position.set(x, 0, z);
  scene.add(obj);
  const bb = new THREE.Box3().setFromObject(obj);
  items.push({ id: kind, label: kind, kind: 'doodad', obj, x, z, fly: 0, size: Math.max(0.6, (bb.max.x - bb.min.x) / 2), facing: 0, seed });
}

// row 1: structures (back), row 2: Omega + units, row 3: doodads (front), plus a swarm on the right.
// Only the requested subset is built (SwiftShader is slow): focus → that item, view → its row.
const want = (row: 'structures' | 'units' | 'doodads' | 'swarm', id?: string): boolean =>
  focus ? id === focus : view === 'all' || view === row;
{
  let x = -36;
  for (const id of STRUCTURES) {
    const fp = (tryGetDef(id) as BuildingDef | undefined)?.footprint ?? { w: 2, h: 2 };
    x += fp.w / 2;
    if (want('structures', id)) addModel(id, x, -11 + (5 - fp.h) / 2);
    x += fp.w / 2 + 2.6;
  }
  if (want('units', 'path_strain_omega')) addModel('path_strain_omega', -33, 1.5, 0.35);
  x = -26;
  for (const id of UNITS) {
    const r = (tryGetDef(id) as UnitDef | undefined)?.radius ?? 0.5;
    x += r + 1.4;
    if (want('units', id)) addModel(id, x, 1.5, 0.5);
    x += r + 1.4;
  }
  x = -24;
  for (const kind of DOODADS) { if (want('doodads', kind)) addDoodad(kind, x, 8.5); x += 4.2; }
  // a small swarm (variety + "many on screen")
  const sw = [['path_phage', 12], ['path_spore_drone', 5], ['path_bacillus', 4], ['path_spirochete', 4]] as const;
  let n = 0;
  if (want('swarm')) for (const [id, count] of sw) for (let i = 0; i < count; i++) {
    const a = n * 2.4, rr = 1.2 + Math.sqrt(n) * 0.85;
    addModel(id, 20 + Math.cos(a) * rr, 3 + Math.sin(a) * rr * 0.8, a * 1.7, false);
    n++;
  }
  if (want('swarm')) { addModel('path_flu_drifter', 24, -1, 2.4, false); addModel('path_flu_drifter', 18, -2, 0.9, false); }
}

// ───────────────────────────── labels ─────────────────────────────
const labelRoot = document.getElementById('labels')!;
const labelEls = new Map<Item, HTMLDivElement>();
for (const it of items) {
  if (!it.label) continue;
  const el = document.createElement('div');
  el.className = `lbl ${it.kind === 'building' ? 's' : it.kind === 'doodad' ? 'd' : ''}`;
  el.textContent = it.label;
  labelRoot.appendChild(el);
  labelEls.set(it, el);
}

// ───────────────────────────── camera ─────────────────────────────
const target = new THREE.Vector3(-4, 0, -1);
let dist = 66, pitch = 56, yaw = 0;
const focusItem = focus ? items.find((i) => i.id === focus) : undefined;
if (focusItem) {
  target.set(focusItem.x, focusItem.fly * 0.6 + focusItem.size * 0.5, focusItem.z);
  dist = Math.max(4.5, focusItem.size * 7.5);
  pitch = 42;
  yaw = 0.35;
} else if (view === 'units') { target.set(-10, 0, 1.5); dist = 34; }
else if (view === 'structures') { target.set(-12, 0, -9); dist = 40; }
else if (view === 'doodads') { target.set(-13.5, 0, 8.5); dist = 22; }
else if (view === 'swarm') { target.set(20, 0, 2); dist = 34; }
if (q.has('dist')) dist = Number(q.get('dist'));
if (q.has('pitch')) pitch = Number(q.get('pitch'));
if (q.has('yaw')) yaw = Number(q.get('yaw'));
function placeCamera(): void {
  const p = THREE.MathUtils.degToRad(pitch);
  const off = new THREE.Vector3(0, Math.sin(p) * dist, Math.cos(p) * dist).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  camera.position.copy(target).add(off);
  camera.lookAt(target);
}

// ───────────────────────────── post ─────────────────────────────
let composer: EffectComposer | null = null;
if (q.get('bloom') === '1') {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.55, 0.45, 0.82));
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

// ───────────────────────────── animation state ─────────────────────────────
function pct(prefix: string): number | null {
  const m = anim.match(new RegExp(`^${prefix}(\\d+)$`));
  return m ? Number(m[1]) / 100 : null;
}
function stateFor(it: Item, time: number): ModelAnimState {
  const u = it.unitDef, b = it.buildingDef;
  const weapon = u?.weapons[0] ?? b?.weapons[0];
  const walking = anim === 'walk';
  let sinceAttack = Infinity;
  if (anim === 'attack' && weapon) sinceAttack = fixedSince ?? ((time + it.seed * 0.37) % Math.max(0.6, weapon.cooldown));
  else if (fixedSince != null) sinceAttack = fixedSince;
  let construction = 1;
  if (b) {
    const c = pct('construct');
    if (c != null) construction = c; else if (anim === 'construct') construction = ((time * 0.18 + it.seed * 0.1) % 1.15);
    construction = Math.min(1, construction);
  }
  let death = 0;
  const d = pct('death');
  if (d != null) death = Math.max(0.001, d);
  else if (anim === 'death') { const t = (time * 0.55 + it.seed * 0.13) % 1.6; death = t < 1 ? Math.max(0.001, t) : 0; }
  const aim = b && weapon ? (anim === 'attack' ? time * 0.9 + it.seed : null) : u && anim === 'attack' ? 0.3 : null;
  return {
    moving: walking && !!u, speed: walking && u ? u.speed : 0, activity: walking ? 'moving' : anim === 'attack' ? 'attacking' : 'idle',
    sinceAttack, construction, hpFrac, carrying: walking && !!u?.gather, producing: anim === 'produce' && !!b && b.trains.length + b.researches.length > 0,
    selected: false, death, aimAngle: aim, facing: it.facing, resourceFrac: 1,
  };
}

// ───────────────────────────── loop ─────────────────────────────
const hud = document.getElementById('hud')!;
let last = performance.now();
let time = 0, frames = 0, fpsT = 0, fps = 0;
const v = new THREE.Vector3();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  time = frozen ?? time + dt;
  for (const it of items) if (it.model) it.model.update(stateFor(it, time), frozen != null ? 0.016 : dt, time);
  placeCamera();
  if (composer) composer.render(); else renderer.render(scene, camera);
  const w = window.innerWidth, h = window.innerHeight;
  for (const [it, el] of labelEls) {
    const top = it.model ? it.model.height : it.size;
    v.set(it.x, it.fly + top + 0.35, it.z).project(camera);
    const vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    el.style.display = vis ? '' : 'none';
    if (vis) el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
  }
  frames++; fpsT += dt;
  if (fpsT > 1) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  const info = renderer.info;
  hud.textContent = `anim=${anim} view=${focus ?? view}  calls=${info.render.calls} tris=${info.render.triangles} progs=${info.programs?.length ?? 0} fps=${fps.toFixed(1)}`;
  sandbox.frames++;
  // frozen clock: a few frames are enough — then idle so screenshots don't fight a slow software-GL loop
  if (frozen == null || sandbox.frames < 3) requestAnimationFrame(frame);
}
const sandbox = { items, scene, renderer, frames: 0 };
(window as unknown as { __sandbox: unknown }).__sandbox = sandbox;
requestAnimationFrame(frame);
