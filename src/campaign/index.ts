/**
 * [campaign] OWNER: campaign agent. The "Code Red: Meilahti" campaign: mission registry + factory.
 * Headless-safe: missions must run in Node tests with ui/camera = null.
 *
 * Missions are built on the scripting toolkit in ./script.ts (triggers, objectives, dialogue, waves,
 * timer, victory/defeat) and live in ./missions/m1..m3.ts.
 */
import type { Difficulty, PlayerId } from '../core/types';
import type { CameraApi, GameUi, ObjectiveView } from '../core/ui';
import type { AiController } from '../ai';
import type { World } from '../sim/World';
import { M1_INFO, PatientZero } from './missions/m1';
import { ContainmentBreach, M2_INFO } from './missions/m2';
import { M3_INFO, StrainOmega } from './missions/m3';

export interface MissionInfo {
  id: string;                 // 'm1', 'm2', 'm3'
  order: number;
  title: string;
  subtitle: string;
  mapId: string;
  /** briefing paragraphs shown before the mission */
  briefing: string[];
  objectivesPreview: string[];
}

export interface MissionContext {
  world: World;
  playerId: PlayerId;         // human (hospital) = 1
  enemyId: PlayerId;          // pathogen AI = 2
  ai: AiController | null;
  difficulty: Difficulty;
}

export type MissionState = 'running' | 'won' | 'lost';

export interface MissionRunner {
  readonly info: MissionInfo;
  readonly state: MissionState;
  /** Spawn starting forces/resources, configure AI flags, set world.rules.autoDefeat = false. Called before rendering starts. */
  setup(): void;
  /** Called once UI exists (null in headless runs): opening dialogue, objectives, camera intro. */
  attach(ui: GameUi | null, camera: CameraApi | null, opts?: { restored?: boolean }): void;
  /** Called every sim tick after the AI and before world.step(). Ends the game via world.endGame(team, reason). */
  update(dt: number): void;
  objectives(): ObjectiveView[];
  /** [save] Mission script state (triggers fired, objectives, timers, phase…) as codec-safe data. */
  save?(): unknown;
  /** [save] Called INSTEAD of setup() when loading a save, after world/entities/AI are restored. Must rebuild
   *  triggers/objectives from `data` without spawning anything. attach() is then called with { restored: true }
   *  (no intro dialogue/camera pan; re-show objectives and timer). */
  restore?(data: unknown): void;
}

/** Campaign missions in play order (the main menu lists these). */
export const CAMPAIGN: MissionInfo[] = [M1_INFO, M2_INFO, M3_INFO];

/** Create the runner for a mission id (unknown ids fall back to the first mission). */
export function createMission(id: string, ctx: MissionContext): MissionRunner {
  const info = CAMPAIGN.find((m) => m.id === id) ?? CAMPAIGN[0]!;
  switch (info.id) {
    case 'm2': return new ContainmentBreach(info, ctx);
    case 'm3': return new StrainOmega(info, ctx);
    default: return new PatientZero(info, ctx);
  }
}
