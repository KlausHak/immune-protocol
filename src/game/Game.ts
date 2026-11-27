/**
 * A running match in the browser: wires sim + AI + mission + renderer + controls + HUD + audio and runs
 * the fixed-timestep loop. Also saves/loads matches (see src/sim/save, src/game/saves.ts).
 * OWNER: architect / integration.
 */
import { TICK_DT } from '../config';
import type { Command, MapData, PlayerId } from '../core/types';
import type { GameUi } from '../core/ui';
import { createAi, type AiController } from '../ai';
import { CAMPAIGN, createMission, type MissionRunner } from '../campaign';
import { DEFAULT_MAP_ID, getMap } from '../map';
import { createWorld, spawnMapResources, spawnSkirmishStart } from '../sim/setup';
import type { World } from '../sim/World';
import { captureMatch, restoreMatch, type SaveLaunch, type SaveMeta } from '../sim/save';
import { GameRenderer } from '../render/core/GameRenderer';
import { Controls } from '../input/Controls';
import { Hud } from '../ui/Hud';
import type { AudioEngine } from '../audio/AudioEngine';
import type { AppApi, GameContext, LaunchConfig } from './contracts';
import type { Settings } from './settings';
import { buildEndResult } from './endResult';
import { AUTO_SLOT, AUTOSAVE_INTERVAL } from './saves';

export const LOCAL_PLAYER: PlayerId = 1;
export const ENEMY_PLAYER: PlayerId = 2;

interface CameraStateApi {
  getState?: () => { x: number; y: number; distance: number; yaw: number };
  setState?: (s: { x: number; y: number; distance: number; yaw: number }) => void;
}

export class Game implements GameContext {
  readonly world: World;
  readonly map: MapData;
  readonly localPlayerId = LOCAL_PLAYER;
  readonly enemyPlayerId = ENEMY_PLAYER;
  readonly settings: Settings;
  readonly audio: AudioEngine;
  /** what to recreate this match from (also stored in saves) */
  readonly launch: SaveLaunch;
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
  private lastAutosave = 0;
  private _saving = false;
  /** true while a save (manual, quick or auto) is being written — the HUD shows a "Saving…" indicator */
  get saving(): boolean { return this._saving; }
  private thumbWaiters: Array<(url: string | undefined) => void> = [];

  constructor(readonly app: AppApi, readonly config: LaunchConfig, canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.settings = app.settings;
    this.audio = app.audio;
    const save = config.load;
    const mode = save?.launch.mode ?? config.mode;
    const difficulty = save?.launch.difficulty ?? config.difficulty;
    const missionId = save?.launch.missionId ?? config.missionId ?? (mode === 'campaign' ? CAMPAIGN[0]!.id : undefined);
    const mapId = save?.launch.mapId
      ?? (mode === 'campaign' ? CAMPAIGN.find((m) => m.id === missionId)?.mapId ?? DEFAULT_MAP_ID() : config.mapId ?? DEFAULT_MAP_ID());
    const seed = save?.launch.seed ?? config.seed ?? 1337;
    this.launch = { mode, missionId, mapId, difficulty, seed };
    this.map = getMap(mapId);
    this.world = createWorld(this.map, [
      { id: LOCAL_PLAYER, faction: 'hospital', team: 1, controller: 'human' },
      { id: ENEMY_PLAYER, faction: 'pathogen', team: 2, controller: 'ai', difficulty },
    ], seed);
    const ai = createAi(this.world, ENEMY_PLAYER, { difficulty });
    this.ais.push(ai);
    if (mode === 'campaign') {
      this.mission = createMission(missionId!, { world: this.world, playerId: LOCAL_PLAYER, enemyId: ENEMY_PLAYER, ai, difficulty });
    }
    if (save) {
      restoreMatch(save, this.world, this.ais, this.mission); // throws on incompatible saves (App handles it)
      this.lastAutosave = this.world.time;
    } else if (this.mission) {
      this.mission.setup();
    } else {
      spawnMapResources(this.world);
      spawnSkirmishStart(this.world);
    }
    if (config.revealMap) this.world.vision.revealAll(LOCAL_PLAYER, true);
    this.speed = save?.client?.speed ?? config.speed ?? 1;

    this.renderer = new GameRenderer({ canvas, world: this.world, localPlayerId: LOCAL_PLAYER, settings: this.settings });
    this.controls = new Controls(this);
    this.ui = new Hud(uiRoot, this);
    this.audio.attach(this);
    if (save?.client?.camera) (this.renderer.cameraCtl as unknown as CameraStateApi).setState?.(save.client.camera);
    if (save?.client?.selection) this.controls.selection.set(save.client.selection.filter((id) => this.world.getAlive(id)));
    this.mission?.attach(this.ui, this.renderer.cameraCtl, { restored: !!save });
    if (save) this.ui.notify(`Loaded “${save.meta.name}”`, 'success');

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

  /** Saving is allowed while the match is running (not after it ended). */
  canSave(): boolean { return !this.world.rules.gameOver && !this.disposed; }

  /** Snapshot the match into a storage slot ('quick' | 'auto' | 'slot1'…'slot8'). Resolves with the stored metadata. */
  async saveGame(slot: string, name?: string): Promise<SaveMeta> {
    if (!this.canSave()) throw new Error('The match has ended — nothing to save.');
    if (this._saving) throw new Error('A save is already in progress.');
    this._saving = true;
    try {
      // Capture the sim synchronously (between ticks), then wait for a rendered frame for the thumbnail.
      const label = name?.trim() || defaultSaveName(this, slot);
      const save = captureMatch({
        world: this.world, ais: this.ais, mission: this.mission, launch: this.launch,
        meta: { slot, name: label, savedAt: new Date().toISOString(), mapName: this.map.name, missionTitle: this.mission?.info.title },
      });
      save.client = {
        camera: (this.renderer.cameraCtl as unknown as CameraStateApi).getState?.(),
        speed: this.speed,
        selection: [...this.controls.selection.ids],
      };
      save.meta.thumbnail = await this.nextThumbnail();
      await this.app.saves.put(save);
      return save.meta;
    } finally {
      this._saving = false;
    }
  }

  /** Advance the simulation one fixed tick (AI → mission → world). Also used by tests via window.__game. */
  stepOnce(): void {
    for (const ai of this.ais) ai.update(TICK_DT);
    this.mission?.update(TICK_DT);
    this.world.step();
  }

  /** Resolves with a small JPEG of the next rendered frame (or undefined after 1 s). */
  private nextThumbnail(): Promise<string | undefined> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (url: string | undefined) => { if (!done) { done = true; resolve(url); } };
      this.thumbWaiters.push(finish);
      setTimeout(() => finish(undefined), 1000);
    });
  }

  private captureThumbnails(): void {
    if (!this.thumbWaiters.length) return;
    const waiters = this.thumbWaiters; this.thumbWaiters = [];
    let url: string | undefined;
    try {
      const src = this.renderer.three.domElement;
      const c = document.createElement('canvas');
      c.width = 256; c.height = Math.max(1, Math.round(256 * src.height / Math.max(1, src.width)));
      c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
      url = c.toDataURL('image/jpeg', 0.7);
    } catch { url = undefined; }
    for (const w of waiters) w(url);
  }

  private maybeAutosave(): void {
    if (this._saving || !this.canSave() || this.world.time - this.lastAutosave < AUTOSAVE_INTERVAL) return;
    this.lastAutosave = this.world.time;
    this.saveGame(AUTO_SLOT, 'Autosave').catch((err) => console.warn('[game] autosave failed', err));
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
        this.maybeAutosave();
      }
      const alpha = this.paused ? 1 : Math.min(1, this.acc / TICK_DT);
      this.controls.update(dtReal);
      this.renderer.render(alpha, dtReal);
      this.captureThumbnails(); // same task as render → the WebGL buffer is still valid
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
    for (const w of this.thumbWaiters) w(undefined);
    this.thumbWaiters = [];
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

function defaultSaveName(game: Game, slot: string): string {
  const t = Math.floor(game.world.time);
  const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  const what = game.mission ? game.mission.info.title : `Skirmish · ${game.map.name}`;
  return `${slot === 'quick' ? 'Quicksave' : slot === 'auto' ? 'Autosave' : what} — ${clock}`;
}
