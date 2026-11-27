/**
 * [audio] OWNER: audio agent. Procedural WebAudio SFX + adaptive music + announcer. One instance per app
 * (created by App); attach(game) subscribes to a match's world events, detach() on match end.
 */
import type { GameContext } from '../game/contracts';
import type { Settings } from '../game/settings';

export type UiSound = 'click' | 'hover' | 'error' | 'confirm' | 'open' | 'close' | 'select';
export type MusicMood = 'menu' | 'calm' | 'tension' | 'battle' | 'victory' | 'defeat' | 'none';

export class AudioEngine {
  constructor(private settings: Settings) {}
  /** Resume the AudioContext (call from a user gesture). */
  unlock(): void {}
  applySettings(s: Settings): void { this.settings = s; }
  attach(_game: GameContext): void {}
  detach(): void {}
  update(_dtReal: number): void {}
  playUi(_kind: UiSound): void {}
  setMusic(_mood: MusicMood): void {}
}
