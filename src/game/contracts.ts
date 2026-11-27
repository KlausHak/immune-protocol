/**
 * Client-side (browser) contracts between Game, renderer, HUD, controls and audio. OWNER: architect.
 * Type-only imports keep module graphs acyclic at runtime.
 */
import type { Command, Cost, Difficulty, Entity, EntityId, MapData, PlayerId } from '../core/types';
import type { GameUi } from '../core/ui';
import type { World } from '../sim/World';
import type { AiController } from '../ai';
import type { MissionRunner } from '../campaign';
import type { GameRenderer } from '../render/core/GameRenderer';
import type { Controls } from '../input/Controls';
import type { AudioEngine } from '../audio/AudioEngine';
import type { CampaignProgress, Settings } from './settings';
import type { SaveGame, SaveMeta } from '../sim/save';
import type { SaveStore } from './saves';
import type { NetMatch } from '../net/types';

export interface LaunchConfig {
  /** 'multiplayer' = LAN 1v1 via lockstep (config.net required) */
  mode: 'campaign' | 'skirmish' | 'multiplayer';
  missionId?: string;           // campaign
  mapId?: string;               // skirmish (default 'meilahti')
  difficulty: Difficulty;
  seed?: number;
  /** LAN multiplayer match (from src/net): players/map/seed come from net.start */
  net?: NetMatch;
  /** restore this saved match instead of starting fresh (mode/map/mission/difficulty/seed come from the save) */
  load?: SaveGame;
  /** debug/testing */
  revealMap?: boolean;
  /** debug: control this player id in single-player (e.g. 2 = the pathogens; no AI, the other side idles) */
  debugPlayAs?: number;
  speed?: number;
}

/** App-level API (menus use this). */
export interface AppApi {
  readonly settings: Settings;
  readonly audio: AudioEngine;
  readonly progress: CampaignProgress;
  /** save-game storage: list/get/put/delete slots, export/import files (src/game/saves.ts) */
  readonly saves: SaveStore;
  startGame(cfg: LaunchConfig): void;
  /** Load a saved match (slot id or SaveGame). Rejects with a readable Error if missing/incompatible. */
  loadGame(source: string | SaveGame): Promise<void>;
  quitToMenu(): void;
  restartGame(): void;
  saveSettings(): void;
  markMissionComplete(missionId: string): void;
}

/** Everything a client module needs about the running match. Fields may be filled progressively during
 *  construction: in constructors use world/map/renderer/settings; access controls/ui/audio lazily. */
export interface GameContext {
  readonly app: AppApi;
  readonly config: LaunchConfig;
  readonly world: World;
  readonly map: MapData;
  readonly localPlayerId: PlayerId;
  readonly enemyPlayerId: PlayerId;
  readonly settings: Settings;
  readonly renderer: GameRenderer;
  readonly controls: Controls;
  readonly ui: GameUi;
  readonly audio: AudioEngine;
  readonly ais: AiController[];
  readonly mission: MissionRunner | null;
  /** LAN multiplayer: session (chat, ping, events) + lockstep (waitingReason); null in single-player */
  readonly net: NetMatch | null;
  paused: boolean;
  speed: number;
  /** Issue a command for the local player (also used by HUD buttons). */
  issue(cmd: Command): void;
  pause(): void;
  resume(): void;
  setSpeed(s: number): void;
  quitToMenu(): void;
  restart(): void;
  /** false after the match has ended */
  canSave(): boolean;
  /** Save into a slot ('quick' | 'auto' | 'slot1'…'slot8'); name defaults to mission/map + game clock. */
  saveGame(slot: string, name?: string): Promise<SaveMeta>;
}

/** One command-card button (3 rows × 5 cols, slot = row*5+col). Produced by Controls, rendered by the HUD. */
export interface CommandButton {
  id: string;            // 'cmd.move' | 'train.hosp_sanitizer' | 'build.hosp_ward' | 'research.up_x' | 'ability.uv_flare' | 'menu.build' | 'menu.back' ...
  label: string;
  hotkey: string;
  icon: string;          // icon key: a def/upgrade/ability id, or a 'cmd.*' id
  slot: number;
  enabled: boolean;
  disabledReason?: string;
  cost?: Cost & { pop?: number };
  time?: number;
  tooltip: string;
  active?: boolean;
  /** 0..1 cooldown remaining overlay */
  cooldown?: number;
  activate(): void;
}

export interface SelectionApi {
  readonly ids: readonly EntityId[];
  set(ids: EntityId[]): void;
  add(ids: EntityId[]): void;
  remove(ids: EntityId[]): void;
  clear(): void;
  /** Primary (first / active subgroup) entity for the info panel. */
  primary(): Entity | undefined;
  entities(): Entity[];
  onChange(fn: (ids: readonly EntityId[]) => void): () => void;
}

export type ControlMode = 'normal' | 'targeting' | 'placing';
