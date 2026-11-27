/** App shell: menus ↔ matches, settings, campaign progress, audio. OWNER: architect / integration. */
import { AudioEngine } from '../audio/AudioEngine';
import { MainMenu } from '../ui/MainMenu';
import type { AppApi, LaunchConfig } from './contracts';
import type { SaveGame } from '../sim/save';
import { SaveStore } from './saves';
import { Game } from './Game';
import { loadProgress, loadSettings, saveProgress, saveSettings, type CampaignProgress, type Settings } from './settings';

export class App implements AppApi {
  readonly settings: Settings = loadSettings();
  readonly progress: CampaignProgress = loadProgress();
  readonly audio: AudioEngine;
  readonly saves = new SaveStore();
  private menu: MainMenu;
  private game: Game | null = null;
  private lastConfig: LaunchConfig | null = null;

  constructor(private canvas: HTMLCanvasElement, private uiRoot: HTMLElement) {
    this.audio = new AudioEngine(this.settings);
    this.menu = new MainMenu(uiRoot, this);
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  get currentGame(): Game | null { return this.game; }

  showMenu(): void { this.menu.show(); this.audio.setMusic('menu'); }

  startGame(cfg: LaunchConfig): void {
    this.menu.hide();
    this.game?.dispose();
    this.game = null;
    try {
      this.game = new Game(this, cfg, this.canvas, this.uiRoot);
    } catch (err) {
      // e.g. an incompatible or corrupted save: never leave the player on a dead screen
      console.error('[app] could not start the match', err);
      this.showMenu();
      throw err;
    }
    // "Restart" after loading a save restarts the mission/skirmish from the beginning
    const l = this.game.launch;
    this.lastConfig = cfg.load ? { mode: l.mode, missionId: l.missionId, mapId: l.mapId, difficulty: l.difficulty, seed: l.seed } : cfg;
    this.canvas.focus();
  }

  /** Load a saved match from a storage slot or a SaveGame object (e.g. an imported file). */
  async loadGame(source: string | SaveGame): Promise<void> {
    const save = typeof source === 'string' ? await this.saves.get(source) : source;
    if (!save) throw new Error(`No saved game in slot "${String(source)}".`);
    this.startGame({ mode: save.launch.mode, missionId: save.launch.missionId, mapId: save.launch.mapId, difficulty: save.launch.difficulty, seed: save.launch.seed, load: save });
  }

  quitToMenu(): void {
    this.game?.dispose();
    this.game = null;
    this.showMenu();
  }

  restartGame(): void { if (this.lastConfig) this.startGame(this.lastConfig); }

  saveSettings(): void { saveSettings(this.settings); this.audio.applySettings(this.settings); }

  markMissionComplete(missionId: string): void {
    if (!this.progress.completed.includes(missionId)) this.progress.completed.push(missionId);
    saveProgress(this.progress);
  }
}
