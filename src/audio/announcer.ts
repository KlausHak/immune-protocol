/**
 * [audio] Optional spoken announcer lines via the browser's speechSynthesis. Off by default: lines are
 * spoken only when the player opted in (AudioEngine.setSpeechEnabled(true), persisted locally) AND the
 * voice volume is above zero. The tonal stingers (voice bus) always carry the information; speech is a
 * tasteful extra — short lines, never queued, per-line cooldowns and a global gap.
 */

const PREF_KEY = 'immune-protocol.audio.speech.v1';

export function loadSpeechPref(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(PREF_KEY) === '1'; } catch { return false; }
}
export function saveSpeechPref(on: boolean): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

export class Announcer {
  enabled: boolean;
  private lastAny = -1e9;
  private lastLine = new Map<string, number>();
  private voice: SpeechSynthesisVoice | null | undefined;

  constructor(enabled = false) { this.enabled = enabled; }

  static get supported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  /**
   * Speak `line` if enabled, supported and not spoken within `cooldown` s (global gap 3 s).
   * `now` is any monotonic clock in seconds. Returns true if speech was requested.
   */
  say(line: string, volume: number, now: number, cooldown = 10): boolean {
    if (!this.enabled || !(volume > 0) || !Announcer.supported) return false;
    if (now - this.lastAny < 3) return false;
    if (now - (this.lastLine.get(line) ?? -1e9) < cooldown) return false;
    try {
      const synth = window.speechSynthesis;
      if (synth.speaking || synth.pending) return false;
      const u = new SpeechSynthesisUtterance(line);
      u.volume = Math.min(1, volume);
      u.rate = 1.04;
      u.pitch = 0.92;
      u.lang = 'en-GB';
      const v = this.pickVoice(synth);
      if (v) u.voice = v;
      synth.speak(u);
      this.lastAny = now;
      this.lastLine.set(line, now);
      return true;
    } catch {
      return false;
    }
  }

  cancel(): void {
    try { if (Announcer.supported) window.speechSynthesis.cancel(); } catch { /* ignore */ }
  }

  private pickVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
    if (this.voice !== undefined && this.voice !== null) return this.voice;
    const voices = synth.getVoices();
    if (!voices.length) return null; // voices load asynchronously; try again next time
    this.voice = voices.find((v) => v.lang === 'en-GB') ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
    return this.voice;
  }
}
