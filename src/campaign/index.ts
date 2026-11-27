/**
 * [campaign] OWNER: campaign agent. Campaign missions + trigger/objective scripting. Headless-safe:
 * missions must run in Node tests with ui/camera = null.
 */
import type { Difficulty, PlayerId } from '../core/types';
import type { CameraApi, GameUi, ObjectiveView } from '../core/ui';
import type { AiController } from '../ai';
import type { World } from '../sim/World';
import { spawnMapResources, spawnSkirmishStart } from '../sim/setup';

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
  attach(ui: GameUi | null, camera: CameraApi | null): void;
  /** Called every sim tick after the AI and before world.step(). Ends the game via world.endGame(team, reason). */
  update(dt: number): void;
  objectives(): ObjectiveView[];
}

export const CAMPAIGN: MissionInfo[] = [
  {
    id: 'm1', order: 1, title: 'Patient Zero', subtitle: 'Mission 1', mapId: 'meilahti',
    briefing: ['An unknown pathogen has escaped from the old laundry building in the north of the campus.', 'Establish a defence and destroy the Infection Core.'],
    objectivesPreview: ['Destroy the Infection Core'],
  },
];

class StubMission implements MissionRunner {
  state: MissionState = 'running';
  constructor(readonly info: MissionInfo, private ctx: MissionContext) {}
  setup(): void { spawnMapResources(this.ctx.world); spawnSkirmishStart(this.ctx.world); }
  attach(ui: GameUi | null): void {
    ui?.setObjectives(this.objectives());
    ui?.showDialogue({ speaker: 'SISU', text: 'Campaign scripting not installed yet — destroy the enemy base.', portrait: 'sisu' });
  }
  update(): void {}
  objectives(): ObjectiveView[] { return [{ id: 'core', text: 'Destroy the Infection Core', state: 'active', primary: true }]; }
}

export function createMission(id: string, ctx: MissionContext): MissionRunner {
  const info = CAMPAIGN.find((m) => m.id === id) ?? CAMPAIGN[0]!;
  return new StubMission(info, ctx);
}
