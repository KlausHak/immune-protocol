/** App shell: menus ↔ matches, settings, campaign progress, audio. OWNER: architect / integration. */
import { AudioEngine } from '../audio/AudioEngine';
import { MainMenu } from '../ui/MainMenu';
import type { AppApi, LaunchConfig } from './contracts';
import { Game } from './Game';
import { loadProgress, loadSettings, saveProgress, saveSettings, type CampaignProgress, type Settings } from './settings';

export class App implements AppApi {
  readonly settings: Settings = loadSettings();
  readonly progress: CampaignProgress = loadProgress();
  readonly audio: AudioEngine;
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
    this.lastConfig = cfg;
    this.menu.hide();
    this.game?.dispose();
    this.game = new Game(this, cfg, this.canvas, this.uiRoot);
    this.canvas.focus();
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
