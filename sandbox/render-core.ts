/**
 * [render-core] Visual testbed: a World on the test map with both factions, an ally, a damaged building,
 * a foundation, flyers and gatherers, rendered by GameRenderer standalone with a fixed-step loop.
 *
 * URL flags:
 *   quality=low|medium|high   bars=always|damaged|selected (default always)
 *   select=1   select own army + pharmacy + one ally/enemy unit + a cache (all ring colours)
 *   hover=1    hover the generator          rally=1   pharmacy rally point (flag + dashed line)
 *   ghost=valid|invalid  [ghostDef=hosp_uv_turret]   placement preview
 *   markers=1  all command marker kinds, re-triggered      fight=1   enemies attack-move into the army
 *   pause=1    freeze the sim               t=<sec>   pre-simulate before the first frame
 *   cx,cy,dist,yaw   camera                 kill=1    kill a few units after 1.5 s (death animation)
 *   fog=1      keep fog of war (default: revealed)
 *   still=<sec> stop the loop after <sec> s of wall time (headless screenshots need an idle page)
 * Debug handle: window.__rc = { renderer, world, settings }.
 */
import { TICK_DT } from '../src/config';
import type { Entity, PlayerId, Vec2 } from '../src/core/types';
import { DEFAULT_SETTINGS, type Quality, type Settings } from '../src/game/settings';
import { getMap } from '../src/map';
import { GameRenderer, type CommandMarkerKind } from '../src/render/core/GameRenderer';
import { createWorld, spawnMapResources, spawnSkirmishStart } from '../src/sim/setup';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  quality: (q.get('quality') as Quality | null) ?? 'high',
  healthBars: (q.get('bars') as Settings['healthBars'] | null) ?? 'always',
  edgeScroll: q.get('edge') === '1',
};

const LOCAL: PlayerId = 1, ENEMY: PlayerId = 2, ALLY: PlayerId = 3;
const world = createWorld(getMap('test'), [
  { id: LOCAL, faction: 'hospital', team: 1, controller: 'human' },
  { id: ENEMY, faction: 'pathogen', team: 2, controller: 'ai' },
  { id: ALLY, faction: 'hospital', team: 1, controller: 'ai', name: 'Allied Corps' },
], 7);
world.player(ALLY).startPos = { x: 41, y: 86 };
spawnMapResources(world);
spawnSkirmishStart(world);

const unit = (defId: string, owner: PlayerId, x: number, y: number, facing = 0, hpFrac = 1): Entity => {
  const e = world.spawnUnit(defId, owner, { x, y }, { facing });
  e.hp = Math.max(1, e.stats.maxHp * hpFrac);
  return e;
};

// ── own base & army ──
const pharmacy = world.spawnBuilding('hosp_pharmacy', LOCAL, { x: 26, y: 70 }, { complete: true });
pharmacy.hp = pharmacy.stats.maxHp * 0.42;
const ward = world.spawnBuilding('hosp_ward', LOCAL, { x: 25, y: 77 }, { complete: false });
ward.construction!.progress = ward.construction!.total * 0.45;
ward.hp = ward.stats.maxHp * 0.5;
const generator = world.spawnBuilding('hosp_generator', LOCAL, { x: 23, y: 67 }, { complete: true });
world.spawnBuilding('hosp_uv_turret', LOCAL, { x: 31, y: 73 }, { complete: true });
const army: Entity[] = [
  unit('hosp_sanitizer', LOCAL, 29, 64.5, -0.6), unit('hosp_sanitizer', LOCAL, 30.2, 63.6, -0.6, 0.5),
  unit('hosp_sanitizer', LOCAL, 31.4, 64.6, -0.6), unit('hosp_sanitizer', LOCAL, 30.3, 65.7, -0.6, 0.8),
  unit('hosp_medic', LOCAL, 33, 66.5, -0.6), unit('hosp_uv_lancer', LOCAL, 33.8, 64, -0.6),
  unit('hosp_antibiotic_launcher', LOCAL, 30, 68, -0.6, 0.65), unit('hosp_macrophage', LOCAL, 35.5, 68.4, -0.6, 0.24),
  unit('hosp_sterilizer_drone', LOCAL, 32.5, 61.5, -0.6),
];
// queue production on the HQ so the progress bar shows
const hq = world.entitiesOf(LOCAL, (e) => e.defId === 'hosp_hq')[0];
if (hq) { world.player(LOCAL).resources.matter += 200; world.economy.queueTrain(hq, 'hosp_orderly'); }

// ── ally ──
const allyUnits = [unit('hosp_sanitizer', ALLY, 38.5, 74, 0.4), unit('hosp_uv_lancer', ALLY, 40, 75.2, 0.4)];

// ── enemy ──
const enemy: Entity[] = [
  unit('path_phage', ENEMY, 45, 57.2, 2.5), unit('path_phage', ENEMY, 46.2, 56.6, 2.5), unit('path_phage', ENEMY, 45.6, 58.4, 2.5, 0.55),
  unit('path_bacillus', ENEMY, 47.6, 58.2, 2.5), unit('path_spirochete', ENEMY, 48.6, 56.4, 2.5),
  unit('path_fungal_mortar', ENEMY, 50, 58.5, 2.5), unit('path_superbug', ENEMY, 48.2, 60.6, 2.5, 0.6),
  unit('path_flu_drifter', ENEMY, 46.5, 54.2, 2.5),
];
world.spawnBuilding('path_toxin_spitter', ENEMY, { x: 51, y: 53 }, { complete: true });

if (q.get('fog') !== '1') world.vision.revealAll(LOCAL, true); // ?fog=1 keeps the real fog of war

// ── pre-simulate (workers start carrying) ──
const preSim = num('t', 3);
for (let i = 0; i < Math.round(preSim / TICK_DT); i++) world.step();

const canvas = document.getElementById('rc-canvas') as HTMLCanvasElement;
const renderer = new GameRenderer({ canvas, world, localPlayerId: LOCAL, settings });
renderer.cameraCtl.lookAt({ x: num('cx', 34), y: num('cy', 67) });
if (q.has('dist')) renderer.cameraCtl.setDistance(num('dist', 34), true);
if (q.has('yaw')) renderer.cameraCtl.setYaw((num('yaw', 0) * Math.PI) / 180, true);

const caches = world.list.filter((e) => e.kind === 'resource');
if (q.get('rally') === '1') pharmacy.rally = { pos: { x: 37, y: 59 } };
if (q.get('select') === '1' || q.get('rally') === '1') {
  const ids = [...army.map((e) => e.id), pharmacy.id];
  if (q.get('select') === '1') ids.push(allyUnits[0]!.id, enemy[6]!.id, caches[0]?.id ?? -1, ward.id);
  renderer.setSelection(ids.filter((id) => id >= 0));
}
if (q.get('hover') === '1') renderer.setHover(generator.id);
const ghostMode = q.get('ghost');
if (ghostMode) {
  const defId = q.get('ghostDef') ?? (ghostMode === 'invalid' ? 'hosp_pharmacy' : 'hosp_uv_turret');
  const tile = ghostMode === 'invalid' ? { x: 27, y: 68 } : { x: 36, y: 71 };
  renderer.setPlacementGhost({ defId, tile, valid: ghostMode !== 'invalid' });
}
if (q.get('fight') === '1') world.issue({ type: 'attackMove', playerId: ENEMY, unitIds: enemy.map((e) => e.id), target: { x: 31, y: 66 } });

const markerSpots: Array<[CommandMarkerKind, Vec2]> = [
  ['move', { x: 38, y: 62 }], ['attack', { x: 42, y: 61 }], ['gather', { x: 38, y: 66 }], ['build', { x: 42, y: 65.5 }],
  ['rally', { x: 38, y: 70 }], ['patrol', { x: 42, y: 70 }], ['repair', { x: 46, y: 66 }],
];
let markerClock = 0;
const fireMarkers = (): void => { for (const [kind, p] of markerSpots) renderer.showCommandMarker(p, kind); };
if (q.get('markers') === '1') fireMarkers();

let killAt = q.get('kill') === '1' ? 1.5 : -1;
const paused = q.get('pause') === '1';
const info = document.getElementById('rc-info') as HTMLDivElement;
let last = performance.now(), acc = 0, fpsT = 0, frames = 0, fps = 0, clock = 0;

const stillAt = q.has('still') ? num('still', 4) * 1000 : Infinity;
const startedAt = performance.now();
function frame(now: number): void {
  if (now - startedAt > stillAt) { document.title = 'render-core: still'; return; }
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  clock += dt;
  if (!paused) {
    acc += dt;
    let n = 0;
    while (acc >= TICK_DT && n < 8) { world.step(); acc -= TICK_DT; n++; }
    if (acc > TICK_DT * 4) acc = 0;
  }
  if (q.get('markers') === '1') { markerClock += dt; if (markerClock > 1.1) { markerClock = 0; fireMarkers(); } }
  if (killAt >= 0 && clock >= killAt) {
    killAt = -1;
    for (const e of [army[3], enemy[0], enemy[7]]) if (e?.alive) world.killEntity(e, null);
  }
  renderer.render(paused ? 1 : Math.min(1, acc / TICK_DT), dt);
  frames++; fpsT += dt;
  if (fpsT >= 0.5) {
    fps = frames / fpsT; frames = 0; fpsT = 0;
    const s = renderer.getStats();
    info.textContent = `render-core sandbox · ${s.quality} · ${fps.toFixed(0)} fps · dpr ${s.pixelRatio}\n` +
      `${s.calls} calls · ${(s.triangles / 1000).toFixed(1)}k tris · ${s.views} views · ${s.bars} bars · ${s.decals} decals`;
  }
}
requestAnimationFrame(frame);

(window as unknown as { __rc: unknown }).__rc = { renderer, world, settings };
