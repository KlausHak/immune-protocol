/**
 * [environment] Standalone testbed for src/render/environment.
 *
 *   /sandbox/environment.html?map=test|meilahti|showcase&preset=day|nordic_dusk|night&fog=1
 *     &quality=low|medium|high  &overview=1 (high camera)  &x=..&y=.. (camera target)  &dist=34 &yaw=0 &pitch=56
 *     &bloom=0 (direct render, no post)  &stats=1  &frames=N (stop after N frames; for screenshots)
 * Keys: 1/2/3 presets · arrows pan · +/- zoom · Q/E rotate · O overview · F toggle fog-of-war pattern.
 * Debug handle: window.__env { env, scene, renderer, camera, map, setPreset(id) }.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { LEVEL_HEIGHT } from '../src/config';
import { Terrain, type Decal, type Doodad, type DoodadKind, type LightingPreset, type MapData, type PlayerId, type Vec2 } from '../src/core/types';
import { getMap } from '../src/map';
import type { VisionService } from '../src/sim/services';
import { World } from '../src/sim/World';
import type { Quality } from '../src/game/settings';
import { EnvironmentView } from '../src/render/environment';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);

// ───────────────────────────── showcase map ─────────────────────────────

function createShowcaseMap(): MapData {
  const W = 112, H = 112, N = W * H;
  const terrain = new Uint8Array(N).fill(Terrain.Grass);
  const levels = new Uint8Array(N), ramps = new Uint8Array(N), blocked = new Uint8Array(N), buildable = new Uint8Array(N).fill(1);
  const heights = new Float32Array((W + 1) * (H + 1));
  const idx = (x: number, y: number) => y * W + x;
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const fill = (x0: number, y0: number, w: number, h: number, t: Terrain) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (inb(x, y)) terrain[idx(x, y)] = t; };
  const hash = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const noise = (x: number, y: number) => Math.sin(x * 0.21 + Math.sin(y * 0.13) * 2) * 0.5 + Math.sin(y * 0.17 - x * 0.05) * 0.5;
  const coast = (y: number) => 15 + 4 * Math.sin(y * 0.09) + 2.5 * Math.sin(y * 0.23 + 1);

  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = coast(y);
    if (x < c) terrain[idx(x, y)] = Terrain.Water;
    else if (x < c + 2.6) terrain[idx(x, y)] = y < 46 ? (hash(x, y) > 0.35 ? Terrain.Rock : Terrain.Sand) : Terrain.Sand;
  }
  // north plateau (pathogen base), irregular southern rim
  for (let y = 3; y < 34; y++) for (let x = 34; x < 106; x++) {
    if (y < 29 + 2.5 * Math.sin(x * 0.17) + 1.5 * Math.sin(x * 0.41)) {
      levels[idx(x, y)] = 1;
      terrain[idx(x, y)] = noise(x, y) > 0.35 ? Terrain.Dirt : Terrain.Grass;
    }
  }
  // level-2 granite knoll in the NE corner
  for (let y = 0; y < 16; y++) for (let x = 92; x < W; x++) if ((x - 104) ** 2 + (y - 6) ** 2 < 120) { levels[idx(x, y)] = 2; terrain[idx(x, y)] = Terrain.Rock; }
  // contaminated core with tendrils
  for (let y = 5; y < 30; y++) for (let x = 46; x < 98; x++) {
    if (!levels[idx(x, y)]) continue;
    const d = Math.hypot((x - 72) / 1.5, y - 17);
    if (d + noise(x * 1.7, y * 1.7) * 5 < 12) terrain[idx(x, y)] = Terrain.Contaminated;
  }
  // garage deck (man-made raised level)
  for (let y = 56; y < 68; y++) for (let x = 90; x < 104; x++) { levels[idx(x, y)] = 1; terrain[idx(x, y)] = Terrain.Concrete; }
  // roads + sidewalks
  fill(Math.floor(coast(46)) + 4, 43, W, 6, Terrain.Concrete);  // sidewalks
  fill(Math.floor(coast(46)) + 4, 44, W, 4, Terrain.Asphalt);   // E–W road
  fill(69, 22, 6, H, Terrain.Concrete);
  fill(70, 22, 4, H, Terrain.Asphalt);                           // N–S road (climbs the plateau ramp)
  fill(84, 60, 6, 4, Terrain.Asphalt);                           // garage ramp
  // ramps
  for (let y = 30; y < 35; y++) for (let x = 69; x < 75; x++) { ramps[idx(x, y)] = 1; levels[idx(x, y)] = 1; }
  for (let y = 60; y < 64; y++) for (let x = 85; x < 90; x++) { ramps[idx(x, y)] = 1; levels[idx(x, y)] = 1; }
  // ER plaza, helipad, parking lot
  fill(76, 76, 16, 15, Terrain.Plaza);
  fill(95, 83, 10, 10, Terrain.Concrete);
  fill(40, 52, 23, 13, Terrain.Asphalt);
  // birch park paths (dirt) and snow patches
  for (let t = 0; t < 1; t += 0.004) {
    const px = 26 + t * 34, py = 102 - Math.sin(t * 5) * 6 - t * 20;
    for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) { const x = Math.round(px + dx), y = Math.round(py + dy); if (inb(x, y) && terrain[idx(x, y)] === Terrain.Grass) terrain[idx(x, y)] = Terrain.Dirt; }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (terrain[idx(x, y)] !== Terrain.Grass) continue;
    if (noise(x * 0.7 + 40, y * 0.7) + Math.sin(x * 0.05 + y * 0.08) * 0.4 > 0.86) terrain[idx(x, y)] = Terrain.Snow;
  }

  // vertex heights
  const rampH = (vx: number, vy: number): number | null => {
    if (vx >= 69 && vx <= 75 && vy >= 30 && vy <= 35) return LEVEL_HEIGHT * (1 - (vy - 30) / 5);
    if (vx >= 85 && vx <= 90 && vy >= 60 && vy <= 64) return LEVEL_HEIGHT * ((vx - 85) / 5);
    return null;
  };
  for (let vy = 0; vy <= H; vy++) for (let vx = 0; vx <= W; vx++) {
    let maxLv = 0, water = 0, n = 0, ramp = false;
    for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
      const x = vx + dx, y = vy + dy;
      if (!inb(x, y)) continue;
      n++;
      const i = idx(x, y);
      if (ramps[i]) ramp = true;
      maxLv = Math.max(maxLv, levels[i]!);
      if (terrain[i] === Terrain.Water) water++;
    }
    let h = maxLv * LEVEL_HEIGHT;
    const rh = ramp ? rampH(vx, vy) : null;
    if (rh !== null) h = rh;
    else if (water === n) h = -0.7 - Math.min(2.2, Math.max(0, coast(vy) - vx) * 0.18);
    else if (water > 0) h = -0.3;
    heights[vy * (W + 1) + vx] = h;
  }
  // blocked/buildable: water, cliffs, rock
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y);
    const hs = [heights[y * (W + 1) + x]!, heights[y * (W + 1) + x + 1]!, heights[(y + 1) * (W + 1) + x]!, heights[(y + 1) * (W + 1) + x + 1]!];
    const steep = Math.max(...hs) - Math.min(...hs) > 0.5 && !ramps[i];
    if (terrain[i] === Terrain.Water || steep || terrain[i] === Terrain.Rock || x === 0 || y === 0 || x === W - 1 || y === H - 1) { blocked[i] = 1; buildable[i] = 0; }
    if (ramps[i] || terrain[i] === Terrain.Asphalt) buildable[i] = 0;
  }

  // doodads
  const doodads: Doodad[] = [];
  let seed = 1;
  const add = (kind: DoodadKind, x: number, y: number, rot = 0, scale = 1, fp?: { w: number; h: number }) => {
    doodads.push({ kind, pos: { x, y }, rot, scale, seed: seed++, footprint: fp });
    if (fp) for (let ty = Math.floor(y - fp.h / 2); ty < Math.ceil(y + fp.h / 2); ty++) for (let tx = Math.floor(x - fp.w / 2); tx < Math.ceil(x + fp.w / 2); tx++) if (inb(tx, ty)) { blocked[idx(tx, ty)] = 1; buildable[idx(tx, ty)] = 0; }
  };
  add('hospital_tower', 60, 86, 0, 1, { w: 14, h: 10 });
  add('hospital_wing', 44, 78, Math.PI / 2, 1, { w: 6, h: 12 });
  add('research_lab', 99, 74, 0, 1, { w: 10, h: 8 });
  add('childrens_hospital', 30, 64, 0, 1, { w: 6, h: 6 });
  add('old_laundry', 52, 14, 0, 1, { w: 10, h: 8 });
  add('water_tower', 42, 22, 0, 1, { w: 3, h: 3 });
  add('skybridge', 53, 80.5, 0, 1);
  for (let i = 0; i < 46; i++) {
    const x = 24 + hash(i, 1) * 26, y = 88 + hash(i, 2) * 20;
    if (terrain[idx(Math.floor(x), Math.floor(y))] === Terrain.Grass || terrain[idx(Math.floor(x), Math.floor(y))] === Terrain.Snow) add('tree_birch', x, y, hash(i, 3) * 6.28, 0.85 + hash(i, 4) * 0.35);
  }
  for (let i = 0; i < 40; i++) {
    const x = 20 + hash(i, 5) * 16, y = 6 + hash(i, 6) * 40;
    const t = terrain[idx(Math.floor(x), Math.floor(y))];
    if (t === Terrain.Grass || t === Terrain.Snow || t === Terrain.Dirt) add('tree_pine', x, y, hash(i, 7) * 6.28, 0.8 + hash(i, 8) * 0.45);
  }
  for (let i = 0; i < 18; i++) add('tree_pine', 36 + i * 3.6 + hash(i, 9) * 1.5, 31.5 + hash(i, 10) * 2 + (i % 2) * 1.5, hash(i, 11) * 6, 0.9);
  for (let x = 30; x < 110; x += 7) { if (x > 66 && x < 78) continue; add('street_lamp', x, 42.6, Math.PI / 2); add('street_lamp', x + 3.5, 49.4, -Math.PI / 2); }
  for (let y = 52; y < 110; y += 7) { add('street_lamp', 68.6, y, 0); add('street_lamp', 75.4, y + 3.5, Math.PI); }
  for (let i = 0; i < 9; i++) { add('car', 42 + i * 2.2, 53.8, Math.PI / 2); if (i % 3 !== 1) add('car', 42.4 + i * 2.2, 62.6, -Math.PI / 2); }
  for (let i = 0; i < 5; i++) add('car', 92 + i * 2.4, 58.5, Math.PI / 2);
  add('ambulance', 82, 92.5, 0); add('ambulance', 86, 92.5, 0); add('bus', 34, 49.6, 0); add('bus_stop', 34, 42.4, 0);
  for (let i = 0; i < 6; i++) add('bench', 28 + i * 5, 96 - (i % 2) * 6, hash(i, 12) * 6);
  for (let i = 0; i < 30; i++) add('bush', 76 + hash(i, 13) * 16, i % 2 ? 75.2 : 91.4, 0, 0.8 + hash(i, 14) * 0.5);
  for (let i = 0; i < 8; i++) add('traffic_cone', 95 + (i % 4) * 0.8, 81.6 + Math.floor(i / 4) * 0.7, 0);
  add('barrier', 90, 82, 0); add('barrier', 93, 82, 0); add('sign_er', 77, 78, 0); add('dumpster', 54, 93.5, 0); add('dumpster', 57, 93.5, 0);
  for (let i = 0; i < 3; i++) add('flag_pole', 78 + i * 2, 76.8, 0);
  for (let i = 0; i < 14; i++) { const y = 50 + i * 4.3; add('rock_granite', coast(y) + 1.2 + hash(i, 15), y, hash(i, 16) * 6, 0.6 + hash(i, 17) * 0.6); }
  for (let i = 0; i < 26; i++) { const y = 52 + hash(i, 18) * 56; add('reeds', coast(y) - 0.6 - hash(i, 19) * 1.4, y, hash(i, 20) * 6, 0.8 + hash(i, 21) * 0.4); }
  add('pier', coast(72) - 2.5, 72, 0, 1);
  for (let i = 0; i < 7; i++) add('snow_pile', 20 + hash(i, 22) * 80, 36 + hash(i, 23) * 70, 0, 0.8 + hash(i, 24));
  const inf: DoodadKind[] = ['biohazard_barrel', 'goo_puddle', 'infected_growth', 'spore_vent', 'sewer_grate', 'waste_container'];
  for (let i = 0; i < 30; i++) add(inf[i % inf.length]!, 58 + hash(i, 25) * 28, 9 + hash(i, 26) * 16, hash(i, 27) * 6.28, 0.8 + hash(i, 28) * 0.5);

  // decals
  const decals: Decal[] = [];
  const dec = (kind: Decal['kind'], x: number, y: number, rot: number, sx: number, sy: number) => decals.push({ kind, pos: { x, y }, rot, size: { x: sx, y: sy } });
  const roadW0 = Math.floor(coast(46)) + 5;
  dec('road_line', (roadW0 + 68) / 2, 46, 0, 68 - roadW0, 0.16);
  dec('road_line', 92, 46, 0, 36, 0.16);
  dec('road_line', 72, 80, Math.PI / 2, 60, 0.16);
  dec('road_line', 72, 38.5, Math.PI / 2, 9, 0.16);
  dec('crosswalk', 72, 50.2, 0, 4, 1.6);
  dec('crosswalk', 67.8, 46, Math.PI / 2, 4, 1.6);
  dec('crosswalk', 76.2, 46, Math.PI / 2, 4, 1.6);
  dec('parking_lines', 51, 54.4, 0, 20.8, 2.6);
  dec('parking_lines', 51, 62, 0, 20.8, 2.6);
  dec('medical_cross', 84, 84, 0, 4.5, 4.5);
  dec('helipad_h', 100, 88, 0, 6, 6);
  dec('arrow', 58, 45, Math.PI, 2.4, 0.9); dec('arrow', 86, 47, 0, 2.4, 0.9); dec('arrow', 71, 66, -Math.PI / 2, 2.4, 0.9); dec('arrow', 73, 96, Math.PI / 2, 2.4, 0.9);
  dec('manhole', 80, 45.2, 0, 0.9, 0.9); dec('manhole', 72.8, 60, 0, 0.9, 0.9); dec('manhole', 50, 46.8, 0, 0.9, 0.9);
  dec('stain', 45, 58, 0.4, 1.8, 1.4); dec('stain', 56, 59, 1.2, 1.2, 1.0); dec('stain', 48, 61, 2.1, 2.2, 1.6); dec('stain', 81, 46, 0.3, 1.6, 1.0);

  const p1: Vec2 = { x: 84, y: 98 }, p2: Vec2 = { x: 75, y: 18 };
  return {
    id: 'showcase', name: 'Environment Showcase', description: 'Sandbox map exercising every terrain type, cliffs, ramps, sea, decals and doodads.',
    width: W, height: H, terrain, levels, ramps, blocked, buildable, heights, doodads, decals,
    resources: [], slots: [{ id: 1, faction: 'hospital', start: p1 }, { id: 2, faction: 'pathogen', start: p2 }],
    regions: {}, points: { player_start: p1, enemy_start: p2 }, lighting: 'nordic_dusk', waterLevel: -0.35,
  };
}

// ───────────────────────────── fake fog of war ─────────────────────────────

class FakeVision implements VisionService {
  version = 1;
  private grid: Uint8Array;
  private explored: Uint8Array;
  private t = 0;
  private acc = 0;
  constructor(private map: MapData, private center: Vec2) {
    this.grid = new Uint8Array(map.width * map.height);
    this.explored = new Uint8Array(map.width * map.height);
    const W = map.width;
    for (let y = 0; y < map.height; y++) for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - center.x, (y - center.y) * 1.2);
      const band = Math.abs(y - center.y + (x - center.x) * 0.35) < 5 && x > center.x - 50;
      if (d < 30 + Math.sin(x * 0.3) * 3 || band) this.explored[y * W + x] = 1;
    }
    this.refresh();
  }
  private units(): Vec2[] {
    const c = this.center, t = this.t;
    return [
      { x: c.x, y: c.y + 4 },
      { x: c.x + Math.cos(t * 0.6) * 15, y: c.y + Math.sin(t * 0.6) * 10 },
      { x: c.x - 12 + Math.sin(t * 0.4) * 6, y: c.y - 10 },
      { x: c.x + 18, y: c.y - 6 + Math.cos(t * 0.5) * 8 },
    ];
  }
  private refresh(): void {
    const W = this.map.width, H = this.map.height;
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = this.explored[i] ? 1 : 0;
    for (const u of this.units()) {
      const r = 9;
      for (let y = Math.max(0, Math.floor(u.y - r)); y < Math.min(H, Math.ceil(u.y + r)); y++) for (let x = Math.max(0, Math.floor(u.x - r)); x < Math.min(W, Math.ceil(u.x + r)); x++) {
        if (Math.hypot(x + 0.5 - u.x, y + 0.5 - u.y) <= r) { this.grid[y * W + x] = 2; this.explored[y * W + x] = 1; }
      }
    }
    this.version++;
  }
  tick(dt: number): void { this.t += dt; this.acc += dt; if (this.acc > 0.25) { this.acc = 0; this.refresh(); } }
  fogGrid(_p: PlayerId): Uint8Array { return this.grid; }
  isVisible(_p: PlayerId, p: Vec2): boolean { return this.grid[Math.floor(p.y) * this.map.width + Math.floor(p.x)] === 2; }
  isExplored(_p: PlayerId, p: Vec2): boolean { return (this.grid[Math.floor(p.y) * this.map.width + Math.floor(p.x)] ?? 0) >= 1; }
  isEntityVisible(): boolean { return true; }
  revealAll(): void {}
  revealArea(): void {}
}

// ───────────────────────────── scene ─────────────────────────────

const mapId = q.get('map') ?? 'showcase';
const map = mapId === 'showcase' ? createShowcaseMap() : getMap(mapId);
const preset = (q.get('preset') as LightingPreset | null) ?? undefined;
const quality = ((q.get('quality') as Quality | null) ?? 'high');
const useBloom = q.get('bloom') !== '0';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 400);

const start = map.slots[0]?.start ?? { x: map.width / 2, y: map.height / 2 };
const cam = {
  target: { x: num('x', start.x), y: num('y', start.y) },
  dist: num('dist', 34), yaw: THREE.MathUtils.degToRad(num('yaw', 0)), pitch: THREE.MathUtils.degToRad(num('pitch', 56)),
  overview: q.get('overview') === '1',
};

const world = new World({ map, players: [{ id: 1, name: 'Hospital', faction: 'hospital', team: 1, color: 0x2fd6c6, controller: 'human', startPos: start }] });
let fake: FakeVision | null = null;
if (q.get('fog') === '1') { fake = new FakeVision(map, cam.target); world.vision = fake; }

console.info(`[sandbox] map ${map.id} ready, building environment…`);
const t0 = performance.now();
const env = new EnvironmentView({ scene, renderer, camera, world, map, localPlayerId: 1, quality, preset });
const buildMs = performance.now() - t0;
console.info(`[sandbox] environment built in ${buildMs.toFixed(0)} ms`, JSON.stringify(env.getStats().timings));
let firstFrame = true;

let composer: EffectComposer | null = null;
let bloom: UnrealBloomPass | null = null;
if (useBloom) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 0.9);
  composer.addPass(bloom);
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

function placeCamera(): void {
  const dist = cam.overview ? Math.max(map.width, map.height) * 0.95 : cam.dist;
  const pitch = cam.overview ? THREE.MathUtils.degToRad(58) : cam.pitch;
  camera.far = cam.overview ? 900 : 400;
  camera.updateProjectionMatrix();
  const tgt = cam.overview ? { x: map.width / 2, y: map.height / 2 + 6 } : cam.target;
  const gh = env.heightAt(tgt.x, tgt.y);
  const off = new THREE.Vector3(0, Math.sin(pitch) * dist, Math.cos(pitch) * dist).applyAxisAngle(new THREE.Vector3(0, 1, 0), cam.yaw);
  camera.position.set(tgt.x + off.x, gh + off.y, tgt.y + off.z);
  camera.lookAt(tgt.x, gh, tgt.y);
}

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  keys.add(e.key);
  if (e.key === '1') env.setPreset('day');
  if (e.key === '2') env.setPreset('nordic_dusk');
  if (e.key === '3') env.setPreset('night');
  if (e.key === 'o' || e.key === 'O') cam.overview = !cam.overview;
  if (e.key === 'f' || e.key === 'F') { if (fake) { world.vision = fake; fake = null; env.setFogOfWarEnabled(false); } else { fake = new FakeVision(map, cam.target); world.vision = fake; env.setFogOfWarEnabled(true); } }
});
window.addEventListener('keyup', (e) => keys.delete(e.key));
window.addEventListener('wheel', (e) => { cam.dist = THREE.MathUtils.clamp(cam.dist * (e.deltaY > 0 ? 1.1 : 0.9), 12, 90); });

let last = performance.now(), time = 0, frames = 0, fpsT = 0, fps = 0, total = 0;
/** &frames=N: stop after N frames (keeps the last image — lets headless screenshots finish quickly) */
const maxFrames = num('frames', Infinity);
function frame(now: number): void {
  if (++total < maxFrames) requestAnimationFrame(frame);
  else (window as unknown as { __envDone: boolean }).__envDone = true;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now; time += dt; frames++; fpsT += dt;
  if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  const sp = 30 * dt * (cam.dist / 34);
  if (keys.has('ArrowLeft')) cam.target.x -= sp; if (keys.has('ArrowRight')) cam.target.x += sp;
  if (keys.has('ArrowUp')) cam.target.y -= sp; if (keys.has('ArrowDown')) cam.target.y += sp;
  if (keys.has('q')) cam.yaw += dt; if (keys.has('e')) cam.yaw -= dt;
  if (keys.has('+') || keys.has('=')) cam.dist = Math.max(12, cam.dist - 20 * dt);
  if (keys.has('-')) cam.dist = Math.min(90, cam.dist + 20 * dt);
  fake?.tick(dt);
  placeCamera();
  env.update(dt, time, cam.overview ? { x: map.width / 2, y: map.height / 2 } : cam.target);
  const tr = performance.now();
  if (composer) composer.render(dt); else renderer.render(scene, camera);
  if (total >= maxFrames) {
    // freeze: show the last frame as a plain image so headless screenshots don't wait on the GL compositor
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/png');
    img.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
    document.body.insertBefore(img, hud);
    canvas.style.display = 'none';
    img.onload = () => { (window as unknown as { __envShot: boolean }).__envShot = true; };
  }
  if (firstFrame) { firstFrame = false; console.info(`[sandbox] first frame ${(performance.now() - tr).toFixed(0)} ms, calls ${renderer.info.render.calls}`); }
  if (frames === 0 || total >= maxFrames) {
    const s = env.getStats();
    const info = renderer.info;
    hud.textContent = `map ${map.id} (${map.width}×${map.height}) · preset ${s.preset} · quality ${quality}${useBloom ? ' · bloom' : ''}\n`
      + `fps ${fps.toFixed(1)} · draw calls ${info.render.calls} · tris ${(info.render.triangles / 1000).toFixed(0)}k · build ${buildMs.toFixed(0)} ms\n`
      + `build ${Object.entries(s.timings).map(([k, v]) => `${k} ${v}`).join(' · ')}\n`
      + `doodads ${s.doodads.doodads} → inst ${s.doodads.instanced} + merged ${s.doodads.merged} + single ${s.doodads.standalone} · decals ${s.decals} · cliff rocks ${s.cliffRocks} · lamps ${s.lamps}`
      + (q.get('stats') === '0' ? '' : '\nkeys: 1/2/3 preset · arrows pan · +/- zoom · Q/E rotate · O overview · F fog');
  }
}
requestAnimationFrame(frame);

(window as unknown as { __env: unknown }).__env = { env, scene, renderer, camera, map, world, setPreset: (p: LightingPreset) => env.setPreset(p), bloom };
