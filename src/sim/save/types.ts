/**
 * Save-game contracts. OWNER: architect. Headless-safe.
 *
 * A save is a full snapshot (not a replay): world core + every entity + players + projectiles, plus each
 * module's private state through SaveParticipants, plus AI and mission state. Correctness is defined by the
 * round-trip test (tests/save): save at tick N, load into a fresh world, and both copies must evolve
 * IDENTICALLY afterwards (the sim is deterministic).
 */
import type { Command, Difficulty } from '../../core/types';
import type { World, WorldRules } from '../World';

export const SAVE_VERSION = 1;

/**
 * A module's save hooks, registered in its install*() via world.registerSaveParticipant(...).
 *  - save(world): return the module's private runtime state as data. It is passed through the codec
 *    (src/sim/save/codec.ts): plain objects, arrays, numbers, strings, booleans, null, Map, Set and typed arrays
 *    are fine; class instances, functions and object references to entities are NOT (store entity ids).
 *  - load(world, data): called after all entities/players are restored (world.restoring === true), in
 *    registration order. Rebuild derived caches here (e.g. nav-grid footprints) and restore runtime state.
 * Entity fields (including entity.ext.<module>) are saved automatically by the core — ext data must be
 * codec-safe too.
 */
export interface SaveParticipant {
  key: string;
  save(world: World): unknown;
  load(world: World, data: unknown): void;
}

export interface WorldCoreState {
  tick: number;
  time: number;
  nextEntityId: number;
  nextProjectileId: number;
  rngState: number;
  rules: WorldRules;
  lastAlert: Array<[number, number]>;
  pendingCommands: Command[];
  pendingRemovalIds: number[];
}

export interface SaveMeta {
  slot: string;              // 'auto' | 'quick' | 'slot1'..'slot8'
  name: string;
  savedAt: string;           // ISO timestamp (set by the client)
  mode: 'campaign' | 'skirmish';
  missionId?: string;
  missionTitle?: string;
  mapId: string;
  mapName: string;
  difficulty: Difficulty;
  gameTime: number;          // seconds of sim time
  thumbnail?: string;        // small JPEG data URL (browser only)
  version: number;
}

export interface SaveLaunch { mode: 'campaign' | 'skirmish'; missionId?: string; mapId: string; difficulty: Difficulty; seed: number }

export interface SaveGame {
  version: number;
  meta: SaveMeta;
  launch: SaveLaunch;
  /** codec-encoded payloads */
  world: unknown;
  modules: Record<string, unknown>;
  ai: Record<string, unknown>;     // by player id
  mission: unknown | null;
  /** optional client view state (camera, speed, selection) — browser only */
  client?: { camera?: { x: number; y: number; distance: number; yaw: number }; speed?: number; selection?: number[] };
}
