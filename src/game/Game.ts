/**
 * A running match in the browser: wires sim + AI + mission + renderer + controls + HUD + audio and runs
 * the fixed-timestep loop. OWNER: architect / integration.
 */
import { TICK_DT } from '../config';
import type { Command, MapData, PlayerId } from '../core/types';
import type { GameUi } from '../core/ui';
import { createAi, type AiController } from '../ai';
import { CAMPAIGN, createMission, type MissionRunner } from '../campaign';
import { DEFAULT_MAP_ID, getMap } from '../map';
import { createWorld, spawnMapResources, spawnSkirmishStart } from '../sim/setup';
import type { World } from '../sim/World';
import { GameRenderer } from '../render/core/GameRenderer';
import { Controls } from '../input/Controls';
import { Hud } from '../ui/Hud';
import type { AudioEngine } from '../audio/AudioEngine';
import type { AppApi, GameContext, LaunchConfig } from './contracts';
import type { Settings } from './settings';
import { buildEndResult } from './endResult';

export const LOCAL_PLAYER: PlayerId = 1;
export const ENEMY_PLAYER: PlayerId = 2;

export class Game implements GameContext {
  readonly world: World;
  readonly map: MapData;
  readonly localPlayerId = LOCAL_PLAYER;
  readonly enemyPlayerId = ENEMY_PLAYER;
  readonly settings: Settings;
  readonly audio: AudioEngine;
  renderer!: GameRenderer;
  controls!: Controls;
  ui!: GameUi;
  ais: AiController[] = [];
  mission: MissionRunner | null = null;
  paused = false;
  speed = 1;
  private acc = 0;
  private raf = 0;
  private last = 0;
  private disposed = false;
  private errors = 0;
  private unsub: Array<() => void> = [];

  constructor(readonly app: AppApi, readonly config: LaunchConfig, canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.settings = app.settings;
    this.audio = app.audio;
    const mapId = config.mode === 'campaign'
      ? CAMPAIGN.find((m) => m.id === config.missionId)?.mapId ?? DEFAULT_MAP_ID()
      : config.mapId ?? DEFAULT_MAP_ID();
    this.map = getMap(mapId);
    this.world = createWorld(this.map, [
      { id: LOCAL_PLAYER, faction: 'hospital', team: 1, controller: 'human' },
      { id: ENEMY_PLAYER, faction: 'pathogen', team: 2, controller: 'ai', difficulty: config.difficulty },
    ], config.seed ?? 1337);
    const ai = createAi(this.world, ENEMY_PLAYER, { difficulty: config.difficulty });
    this.ais.push(ai);
    if (config.mode === 'campaign') {
      this.mission = createMission(config.missionId ?? CAMPAIGN[0]!.id, { world: this.world, playerId: LOCAL_PLAYER, enemyId: ENEMY_PLAYER, ai, difficulty: config.difficulty });
      this.mission.setup();
    } else {
      spawnMapResources(this.world);
      spawnSkirmishStart(this.world);
    }
    if (config.revealMap) this.world.vision.revealAll(LOCAL_PLAYER, true);
    this.speed = config.speed ?? 1;

    this.renderer = new GameRenderer({ canvas, world: this.world, localPlayerId: LOCAL_PLAYER, settings: this.settings });
    this.controls = new Controls(this);
    this.ui = new Hud(uiRoot, this);
    this.audio.attach(this);
    this.mission?.attach(this.ui, this.renderer.cameraCtl);

    this.unsub.push(this.world.events.on('gameOver', ({ winnerTeam, reason }) => {
      const result = buildEndResult(this, winnerTeam, reason);
      if (result.victory && this.mission) this.app.markMissionComplete(this.mission.info.id);
      this.ui.showEndScreen(result);
    }));

    (window as unknown as { __game?: Game }).__game = this;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  issue(cmd: Command): void { this.world.issue(cmd); }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.last = performance.now(); }
  setSpeed(s: number): void { this.speed = Math.max(0.25, Math.min(8, s)); }
  quitToMenu(): void { this.app.quitToMenu(); }
  restart(): void { this.app.restartGame(); }

  /** Advance the simulation one fixed tick (AI → mission → world). Also used by tests via window.__game. */
  stepOnce(): void {
    for (const ai of this.ais) ai.update(TICK_DT);
    this.mission?.update(TICK_DT);
    this.world.step();
  }

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dtReal = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    try {
      if (!this.paused) {
        this.acc += dtReal * this.speed;
        let steps = 0;
        while (this.acc >= TICK_DT && steps < 8 * Math.max(1, this.speed)) { this.stepOnce(); this.acc -= TICK_DT; steps++; }
        if (this.acc > TICK_DT * 4) this.acc = 0; // drop backlog after a stall
      }
      const alpha = this.paused ? 1 : Math.min(1, this.acc / TICK_DT);
      this.controls.update(dtReal);
      this.renderer.render(alpha, dtReal);
      this.ui.update(dtReal);
      this.audio.update(dtReal);
    } catch (err) {
      if (this.errors++ < 5) console.error('[game] frame error', err);
    }
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const u of this.unsub) u();
    this.audio.detach();
    this.ui.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.world.events.clear();
    const w = window as unknown as { __game?: Game };
    if (w.__game === this) delete w.__game;
  }
}
