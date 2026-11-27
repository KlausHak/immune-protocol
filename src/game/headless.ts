/**
 * Headless match runner for Node tests (no DOM/three). Mirrors Game's tick order: AI → mission → world.step().
 */
import type { Difficulty, MapData, PlayerId } from '../core/types';
import { createAi, type AiController } from '../ai';
import { CAMPAIGN, createMission, type MissionRunner } from '../campaign';
import { getMap } from '../map';
import { createWorld, spawnMapResources, spawnSkirmishStart } from '../sim/setup';
import type { World } from '../sim/World';

export interface HeadlessOptions {
  mode?: 'skirmish' | 'campaign';
  mapId?: string;
  map?: MapData;
  missionId?: string;
  difficulty?: Difficulty;
  seed?: number;
  /** create the pathogen AI for player 2 (default true) */
  enemyAi?: boolean;
}

export interface HeadlessMatch {
  world: World;
  ais: AiController[];
  mission: MissionRunner | null;
  playerId: PlayerId;
  enemyId: PlayerId;
  step(): void;
  /** Run for `seconds` of game time; onTick runs before each tick (e.g. a scripted player bot). Stops early on game over. */
  runFor(seconds: number, onTick?: (m: HeadlessMatch) => void): void;
}

export function createHeadlessMatch(opts: HeadlessOptions = {}): HeadlessMatch {
  const mode = opts.mode ?? 'skirmish';
  const difficulty = opts.difficulty ?? 'normal';
  const map = opts.map ?? getMap(opts.mapId ?? (mode === 'campaign' ? CAMPAIGN.find((m) => m.id === opts.missionId)?.mapId ?? 'meilahti' : 'test'));
  const world = createWorld(map, [
    { id: 1, faction: 'hospital', team: 1, controller: 'human' },
    { id: 2, faction: 'pathogen', team: 2, controller: 'ai', difficulty },
  ], opts.seed ?? 1);
  const ais: AiController[] = [];
  const ai = opts.enemyAi === false ? null : createAi(world, 2, { difficulty });
  if (ai) ais.push(ai);
  let mission: MissionRunner | null = null;
  if (mode === 'campaign') {
    mission = createMission(opts.missionId ?? 'm1', { world, playerId: 1, enemyId: 2, ai, difficulty });
    mission.setup();
    mission.attach(null, null);
  } else {
    spawnMapResources(world);
    spawnSkirmishStart(world);
  }
  const m: HeadlessMatch = {
    world, ais, mission, playerId: 1, enemyId: 2,
    step() { for (const a of ais) a.update(world.dt); mission?.update(world.dt); world.step(); },
    runFor(seconds, onTick) {
      const n = Math.round(seconds / world.dt);
      for (let i = 0; i < n && !world.rules.gameOver; i++) { onTick?.(m); m.step(); }
    },
  };
  return m;
}
