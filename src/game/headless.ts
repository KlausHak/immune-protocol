/**
 * Headless match runner for Node tests (no DOM/three). Mirrors Game's tick order: AI → mission → world.step().
 * Supports save/load: saveHeadlessMatch(m) → SaveGame, loadHeadlessMatch(save) → HeadlessMatch.
 */
import type { Difficulty, MapData, PlayerId } from '../core/types';
import { createAi, type AiController } from '../ai';
import { CAMPAIGN, createMission, type MissionRunner } from '../campaign';
import { getMap } from '../map';
import { createWorld, spawnMapResources, spawnSkirmishStart } from '../sim/setup';
import type { World } from '../sim/World';
import { captureMatch, restoreMatch, type SaveGame, type SaveLaunch } from '../sim/save';

export interface HeadlessOptions {
  mode?: 'skirmish' | 'campaign';
  mapId?: string;
  map?: MapData;
  missionId?: string;
  difficulty?: Difficulty;
  seed?: number;
  /** create the pathogen AI for player 2 (default true) */
  enemyAi?: boolean;
  /** restore this save instead of setting up a new match (mode/map/mission/difficulty/seed come from the save) */
  load?: SaveGame;
}

export interface HeadlessMatch {
  world: World;
  ais: AiController[];
  mission: MissionRunner | null;
  playerId: PlayerId;
  enemyId: PlayerId;
  launch: SaveLaunch;
  step(): void;
  /** Run for `seconds` of game time; onTick runs before each tick (e.g. a scripted player bot). Stops early on game over. */
  runFor(seconds: number, onTick?: (m: HeadlessMatch) => void): void;
}

export function createHeadlessMatch(opts: HeadlessOptions = {}): HeadlessMatch {
  const save = opts.load;
  const mode = save?.launch.mode ?? opts.mode ?? 'skirmish';
  const difficulty = save?.launch.difficulty ?? opts.difficulty ?? 'normal';
  const missionId = save?.launch.missionId ?? opts.missionId ?? (mode === 'campaign' ? 'm1' : undefined);
  const mapId = save?.launch.mapId ?? opts.map?.id ?? opts.mapId
    ?? (mode === 'campaign' ? CAMPAIGN.find((m) => m.id === missionId)?.mapId ?? 'meilahti' : 'test');
  const seed = save?.launch.seed ?? opts.seed ?? 1;
  const map = opts.map && !save ? opts.map : getMap(mapId);
  const world = createWorld(map, [
    { id: 1, faction: 'hospital', team: 1, controller: 'human' },
    { id: 2, faction: 'pathogen', team: 2, controller: 'ai', difficulty },
  ], seed);
  const ais: AiController[] = [];
  const ai = opts.enemyAi === false ? null : createAi(world, 2, { difficulty });
  if (ai) ais.push(ai);
  let mission: MissionRunner | null = null;
  if (mode === 'campaign') mission = createMission(missionId ?? 'm1', { world, playerId: 1, enemyId: 2, ai, difficulty });

  if (save) {
    restoreMatch(save, world, ais, mission);
    mission?.attach(null, null, { restored: true });
  } else if (mission) {
    mission.setup();
    mission.attach(null, null);
  } else {
    spawnMapResources(world);
    spawnSkirmishStart(world);
  }

  const m: HeadlessMatch = {
    world, ais, mission, playerId: 1, enemyId: 2,
    launch: { mode, missionId, mapId: map.id, difficulty, seed },
    step() { for (const a of ais) a.update(world.dt); mission?.update(world.dt); world.step(); },
    runFor(seconds, onTick) {
      const n = Math.round(seconds / world.dt);
      for (let i = 0; i < n && !world.rules.gameOver; i++) { onTick?.(m); m.step(); }
    },
  };
  return m;
}

/** Snapshot a headless match (call between ticks). */
export function saveHeadlessMatch(m: HeadlessMatch, name = 'headless save'): SaveGame {
  return captureMatch({
    world: m.world, ais: m.ais, mission: m.mission, launch: m.launch,
    meta: { slot: 'test', name, savedAt: '1970-01-01T00:00:00.000Z', mapName: m.world.map.name, missionTitle: m.mission?.info.title },
  });
}

/** Recreate a match from a save (e.g. after a JSON round-trip). Pass enemyAi:false if the original had no AI. */
export function loadHeadlessMatch(save: SaveGame, opts: { enemyAi?: boolean } = {}): HeadlessMatch {
  return createHeadlessMatch({ load: save, enemyAi: opts.enemyAi });
}
