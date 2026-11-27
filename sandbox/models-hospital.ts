/**
 * [models-hospital] Visual testbed for hospital units/buildings, the Supply Cache and campus doodads.
 *
 * URL flags:
 *   ?view=all|units|buildings|cache|props|nature|arch   section to frame (default all)
 *   ?focus=<defId|doodadKind>                           close-up of one model
 *   ?anim=walk|attack|build|gather|carry|heal|cast|produce|damaged|constructNN|deathNN
 *   ?since=<s>       force sinceAttack (e.g. 0.05 to catch muzzle flashes)
 *   ?light=day|dusk|night   ?bloom=0|1   ?team=<hex>   ?yaw=<deg> ?pitch=<deg> ?dist=<units>
 *   ?t=<s>          pre-roll animation time (simulated at 30 Hz before the first frame)
 *   ?frames=<n>     render n frames, then freeze into a static image (default 2; 0 = run continuously). window.__ready = done.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { DoodadKind, UnitDef } from '../src/core/types';
import { tryGetDef } from '../src/data';
import { CAMPUS_DOODADS, HOSPITAL_MODELS } from '../src/render/models/hospital';
import type { EntityModel, ModelAnimState } from '../src/render/models/types';

const q = new URLSearchParams(location.search);
const anim = q.get('anim') ?? '';
const light = (q.get('light') ?? 'dusk') as 'day' | 'dusk' | 'night';
const view = q.get('view') ?? 'all';
const focus = q.get('focus');
const team = new THREE.Color(Number.parseInt((q.get('team') ?? '2fd6c6').replace('#', ''), 16));
const forcedSince = q.has('since') ? Number(q.get('since')) : null;
const preroll = Number(q.get('t') ?? 0.6);
const maxFrames = Number(q.get('frames') ?? 2);

type Section = 'units' | 'buildings' | 'cache' | 'props' | 'nature' | 'arch';
interface Item {
  id: string; section: Section; label: string; obj: THREE.Object3D; model?: EntityModel;
  w: number; d: number; h: number; facing: number; frac?: number; phase: number; meshes: number;
}

const UNIT_IDS = ['hosp_orderly', 'hosp_sanitizer', 'hosp_medic', 'hosp_uv_lancer', 'hosp_antibiotic_launcher', 'hosp_macrophage', 'hosp_sterilizer_drone'];
const BUILDING_IDS = ['hosp_barricade', 'hosp_uv_turret', 'hosp_ward', 'hosp_generator', 'hosp_pharmacy', 'hosp_lab', 'hosp_vehicle_bay', 'hosp_hq', 'obj_childrens_hospital'];
const PROPS: DoodadKind[] = ['ambulance', 'car', 'car', 'car', 'bus', 'helicopter_pad', 'street_lamp', 'bench', 'bus_stop', 'traffic_cone', 'barrier', 'fence', 'sign_er', 'dumpster', 'flag_pole', 'flag_pole'];
const NATURE: DoodadKind[] = ['tree_birch', 'tree_birch', 'tree_birch', 'tree_birch', 'tree_pine', 'tree_pine', 'tree_pine', 'bush', 'bush', 'rock_granite', 'rock_granite', 'snow_pile', 'reeds', 'pier'];
const ARCH: DoodadKind[] = ['hospital_tower', 'hospital_wing', 'research_lab', 'parking_garage', 'old_laundry', 'childrens_hospital', 'water_tower', 'skybridge'];
const NOMINAL: Partial<Record<DoodadKind, [number, number]>> = {
  hospital_tower: [14, 10], hospital_wing: [12, 6], childrens_hospital: [6, 6], research_lab: [10, 8], parking_garage: [12, 10],
  old_laundry: [10, 8], water_tower: [3, 3], skybridge: [8, 2], ambulance: [2, 1], car: [2, 1], bus: [4, 1], helicopter_pad: [4, 4],
  street_lamp: [1, 1], bench: [1, 1], bus_stop: [2, 1], traffic_cone: [0.5, 0.5], barrier: [2, 1], fence: [2, 0.5], sign_er: [1, 1],
  dumpster: [2, 1], flag_pole: [1, 1], tree_birch: [1, 1], tree_pine: [1, 1], bush: [1, 1], rock_granite: [2, 2], snow_pile: [1.5, 1.5],
  reeds: [1, 1], pier: [2, 6],
};

// ───────────────────────── renderer / scene ─────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.info.autoReset = false;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.5, 600);
const LIGHTS = {
  day: { bg: 0x9fb8c8, hemi: [0xdfefff, 0x3a3020, 1.2], sun: [0xfff1dc, 2.2], sunDir: [0.35, 1, 0.45] },
  dusk: { bg: 0x45526a, hemi: [0x8ea4c8, 0x2a2219, 0.8], sun: [0xffb978, 1.9], sunDir: [-0.8, 0.55, 0.55] },
  night: { bg: 0x0d1424, hemi: [0x3a4c78, 0x0e0e12, 0.42], sun: [0x9fb6ff, 0.45], sunDir: [0.4, 1, -0.3] },
} as const;
const L = LIGHTS[light];
scene.background = new THREE.Color(L.bg);
scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));
const sun = new THREE.DirectionalLight(L.sun[0], L.sun[1]);
sun.castShadow = true;
sun.shadow.mapSize.set(Number(q.get('shadow') ?? 2048), Number(q.get('shadow') ?? 2048));
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: light === 'night' ? 0x3d443f : 0x6f776c, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const grid = new THREE.GridHelper(400, 400, 0x000000, 0x000000);
(grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.12;
grid.position.y = 0.004; scene.add(grid);

// ───────────────────────── gallery content ─────────────────────────
const items: Item[] = [];
const countMeshes = (o: THREE.Object3D) => { let n = 0; o.traverse((c) => { if ((c as THREE.Mesh).isMesh) n++; }); return n; };

function addModel(id: string, section: Section, frac?: number, label?: string): void {
  const def = tryGetDef(id);
  const builder = HOSPITAL_MODELS[id];
  if (!def || !builder) { console.warn(`[sandbox] missing model ${id}`); return; }
  const fp = def.kind === 'unit' ? undefined : def.footprint;
  const radius = def.kind === 'unit' ? def.radius : def.kind === 'resource' ? def.radius : Math.max(def.footprint.w, def.footprint.h) / 2;
  const model = builder({ defId: id, faction: def.kind === 'resource' ? 'neutral' : def.faction, teamColor: team, radius, footprint: fp, seed: items.length * 7 + 3 });
  model.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const w = fp ? fp.w : radius * 2.2, d = fp ? fp.h : radius * 2.2;
  const facing = def.kind === 'unit' ? Math.PI / 5 : 0;
  items.push({ id, section, label: label ?? def.name, obj: model.root, model, w, d, h: model.height, facing, frac, phase: items.length * 0.37, meshes: countMeshes(model.root) });
}

function addDoodad(kind: DoodadKind, section: Section, seed: number): void {
  const b = CAMPUS_DOODADS[kind];
  if (!b) { console.warn(`[sandbox] missing doodad ${kind}`); return; }
  const obj = b({ seed, scale: 1 });
  obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const box = new THREE.Box3().setFromObject(obj);
  const [nw, nd] = NOMINAL[kind] ?? [1, 1];
  items.push({ id: kind, section, label: `${kind}#${seed}`, obj, w: Math.max(nw, box.max.x - box.min.x), d: Math.max(nd, box.max.z - box.min.z), h: box.max.y, facing: 0, phase: 0, meshes: countMeshes(obj) });
}

if (focus) {
  if (HOSPITAL_MODELS[focus]) addModel(focus, 'units', focus === 'res_supply_cache' ? 1 : undefined);
  else if (CAMPUS_DOODADS[focus as DoodadKind]) for (let s = 0; s < 4; s++) addDoodad(focus as DoodadKind, 'props', s + 1);
} else {
  const want = (sec: Section) => view === 'all' || view === sec;
  if (want('units')) for (const id of UNIT_IDS) addModel(id, 'units');
  if (want('buildings')) for (const id of BUILDING_IDS) addModel(id, 'buildings');
  if (want('cache')) for (const f of [1, 0.7, 0.4, 0.12]) addModel('res_supply_cache', 'cache', f, `Supply Cache ${Math.round(f * 100)}%`);
  if (want('props')) PROPS.forEach((k, i) => addDoodad(k, 'props', i + 1));
  if (want('nature')) NATURE.forEach((k, i) => addDoodad(k, 'nature', i + 1));
  if (want('arch')) ARCH.forEach((k, i) => addDoodad(k, 'arch', i + 1));
}

// layout: each section is a row (wrapping), rows stacked toward −Z (away from the camera)
const SECTION_ORDER: Section[] = ['units', 'cache', 'buildings', 'props', 'nature', 'arch'];
const GAP: Record<Section, number> = { units: 1.4, cache: 1.2, buildings: 2, props: 1.2, nature: 1.2, arch: 3 };
const MAXW: Record<Section, number> = { units: 40, cache: 40, buildings: 44, props: 40, nature: 40, arch: 60 };
const bounds = new Map<Section, THREE.Box3>();
let zCursor = 0;
for (const sec of SECTION_ORDER) {
  const list = items.filter((it) => it.section === sec);
  if (!list.length) continue;
  let x = 0, rowD = 0, rowZ = zCursor;
  const box = new THREE.Box3();
  for (const it of list) {
    if (x > 0 && x + it.w > MAXW[sec]) { rowZ -= rowD + GAP[sec] + 1.2; x = 0; rowD = 0; }
    const cx = x + it.w / 2, cz = rowZ - it.d / 2;
    const def = tryGetDef(it.id);
    const fly = def?.kind === 'unit' ? (def as UnitDef).flyHeight ?? 0 : 0;
    it.obj.position.set(cx, fly, cz);
    it.obj.rotation.y = -it.facing;
    scene.add(it.obj);
    box.expandByPoint(new THREE.Vector3(x, 0, rowZ)); box.expandByPoint(new THREE.Vector3(x + it.w, it.h, rowZ - it.d));
    x += it.w + GAP[sec]; rowD = Math.max(rowD, it.d);
  }
  bounds.set(sec, box);
  zCursor = rowZ - rowD - 4;
}

// labels
const labelRoot = document.getElementById('labels')!;
const labels = items.map((it) => { const el = document.createElement('div'); el.className = 'lbl'; el.textContent = it.label; labelRoot.appendChild(el); return el; });

// camera framing
const all = new THREE.Box3(); for (const b of bounds.values()) all.union(b);
const frame = focus ? all : view === 'all' ? all : bounds.get(view as Section) ?? all;
const size = frame.getSize(new THREE.Vector3()), centre = frame.getCenter(new THREE.Vector3());
const pitch = THREE.MathUtils.degToRad(Number(q.get('pitch') ?? 56));
const yaw = THREE.MathUtils.degToRad(Number(q.get('yaw') ?? 0));
const fitDist = Math.max(size.x * 0.78, size.z * 1.25, size.y * 1.6) + (focus ? 2.5 : 4);
const dist = Number(q.get('dist') ?? fitDist);
const target = focus ? new THREE.Vector3(centre.x, size.y * 0.45, centre.z) : new THREE.Vector3(centre.x, 0, centre.z + size.y * 0.15);
const off = new THREE.Vector3(0, Math.sin(pitch) * dist, Math.cos(pitch) * dist).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
camera.position.copy(target).add(off);
camera.lookAt(target);
const sd = new THREE.Vector3(...L.sunDir).normalize();
sun.position.copy(target).addScaledVector(sd, 120);
sun.target.position.copy(target);
const ext = Math.max(size.x, size.z) * 0.62 + 6;
Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 300 });
sun.shadow.camera.updateProjectionMatrix();

// post
const bloomOn = q.has('bloom') ? q.get('bloom') === '1' : light !== 'day';
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
if (bloomOn) composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.55, 0.45, 0.9));
composer.addPass(new OutputPass());

// ───────────────────────── animation ─────────────────────────
function stateFor(it: Item, t: number): ModelAnimState {
  const def = tryGetDef(it.id);
  const st: ModelAnimState = {
    moving: false, speed: 0, activity: 'idle', sinceAttack: Infinity, construction: 1, hpFrac: 1, carrying: false,
    producing: false, selected: false, death: 0, aimAngle: null, facing: it.facing, resourceFrac: it.frac ?? 1,
  };
  if (!def) return st;
  const isUnit = def.kind === 'unit';
  if (anim === 'walk' || anim === 'carry') { st.moving = isUnit; st.speed = isUnit ? (def as UnitDef).speed : 0; st.activity = isUnit ? 'moving' : 'idle'; }
  if (anim === 'carry') { st.carrying = true; st.activity = 'carrying'; }
  if (anim === 'attack') {
    const w = def.kind === 'resource' ? undefined : def.weapons[0];
    if (w) {
      st.activity = 'attacking';
      st.sinceAttack = forcedSince ?? (t + it.phase) % w.cooldown;
      st.aimAngle = it.facing + 0.9 + Math.sin(t * 0.7 + it.phase) * 1.1;
    }
  }
  if (anim === 'build') { st.activity = it.id === 'hosp_orderly' ? 'building' : isUnit ? 'idle' : 'producing'; st.producing = !isUnit; }
  if (anim === 'gather') st.activity = it.id === 'hosp_orderly' ? 'gathering' : 'idle';
  if (anim === 'heal') st.activity = it.id === 'hosp_medic' ? 'healing' : 'idle';
  if (anim === 'cast') st.activity = it.id === 'hosp_uv_lancer' ? 'casting' : 'idle';
  if (anim === 'produce') st.producing = !isUnit;
  if (anim === 'damaged') st.hpFrac = 0.2;
  const cm = /^construct(\d+)$/.exec(anim); if (cm && def.kind === 'building') st.construction = Number(cm[1]) / 100;
  const dm = /^death(\d+)$/.exec(anim); if (dm) st.death = Number(dm[1]) / 100;
  return st;
}

const hud = document.getElementById('hud')!;
/** Replace the WebGL canvas by a static snapshot (forces GPU completion; keeps headless screenshots cheap). */
function freeze(): void {
  const img = new Image();
  img.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;';
  img.onload = () => { renderer.domElement.style.display = 'none'; (window as unknown as { __ready: boolean }).__ready = true; };
  img.src = renderer.domElement.toDataURL('image/png');
  document.body.prepend(img);
}
const clock = new THREE.Clock();
let frames = 0, time = 0, fpsT = 0, fps = 0;
const tmp = new THREE.Vector3();
for (let i = 0; i < Math.round(preroll * 30); i++) { time += 1 / 30; for (const it of items) it.model?.update(stateFor(it, time), 1 / 30, time); }
clock.getDelta();
function tick(): void {
  const dt = Math.min(0.1, clock.getDelta());
  time += dt; frames++; fpsT += dt;
  if (fpsT > 1) { fps = frames / Math.max(1e-3, time); fpsT = 0; }
  for (const it of items) it.model?.update(stateFor(it, time), dt, time);
  renderer.info.reset();
  composer.render();
  const w = window.innerWidth, h = window.innerHeight;
  items.forEach((it, i) => {
    tmp.set(it.obj.position.x, 0, it.obj.position.z + it.d / 2 + 0.25).project(camera);
    const el = labels[i]!;
    const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
    el.style.display = vis ? 'block' : 'none';
    if (vis) { el.style.left = `${((tmp.x + 1) / 2) * w}px`; el.style.top = `${((1 - tmp.y) / 2) * h}px`; }
  });
  const info = renderer.info.render;
  hud.textContent = `view=${focus ?? view} anim=${anim || '-'} light=${light} bloom=${bloomOn ? 1 : 0} | items ${items.length} | calls ${info.calls} tris ${info.triangles} | ~${fps.toFixed(1)} fps`;
  if (maxFrames > 0 && frames >= maxFrames) { freeze(); return; }
  if (frames === 3) (window as unknown as { __ready: boolean }).__ready = true;
  requestAnimationFrame(tick);
}
(window as unknown as { __items: unknown }).__items = () => items.map((it) => ({ id: it.id, label: it.label, meshes: it.meshes, h: +it.h.toFixed(2), w: it.w, d: it.d }));
window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); composer.setSize(window.innerWidth, window.innerHeight); });
tick();
