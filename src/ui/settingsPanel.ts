/**
 * [ui] Settings form shared by the in-game pause menu and the main menu. Edits app.settings in place and
 * persists through app.saveSettings() (which also re-applies audio volumes).
 */
import type { AppApi } from '../game/contracts';
import { DEFAULT_SETTINGS, type Quality, type Settings } from '../game/settings';
import { el } from './dom';

type NumKey = 'masterVolume' | 'musicVolume' | 'sfxVolume' | 'voiceVolume' | 'scrollSpeed';
type BoolKey = 'edgeScroll' | 'showFps';

export interface SettingsPanel {
  readonly el: HTMLElement;
  /** Re-read values from app.settings (e.g. after a reset elsewhere). */
  refresh(): void;
  dispose(): void;
}

export function createSettingsPanel(app: AppApi): SettingsPanel {
  const s = app.settings;
  const root = el('div', 'ip-settings');
  const refreshers: Array<() => void> = [];
  let saveTimer = 0;
  let pending = false;
  const save = (immediate = false) => {
    window.clearTimeout(saveTimer);
    if (immediate) { pending = false; app.saveSettings(); return; }
    pending = true;
    saveTimer = window.setTimeout(() => { pending = false; app.saveSettings(); }, 160);
  };
  const ui = (k: Parameters<AppApi['audio']['playUi']>[0]) => { try { app.audio.playUi(k); } catch { /* audio optional */ } };

  const group = (title: string) => {
    const g = el('div', 'ip-set-group', root);
    el('div', 'ip-set-title', g, title);
    return g;
  };
  const row = (parent: HTMLElement, label: string, hint?: string) => {
    const r = el('div', 'ip-set-row', parent);
    const l = el('div', '', r);
    el('div', 'ip-set-label', l, label);
    if (hint) el('div', 'ip-set-hint', l, hint);
    return r;
  };

  const slider = (parent: HTMLElement, key: NumKey, label: string, min: number, max: number, step: number, fmt: (v: number) => string) => {
    const r = row(parent, label);
    const input = el('input', 'ip-range', r);
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
    input.setAttribute('aria-label', label);
    const val = el('div', 'ip-set-val', r);
    const paint = () => {
      const v = s[key];
      input.value = String(v);
      input.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
      val.textContent = fmt(v);
    };
    input.addEventListener('input', () => { s[key] = Number(input.value); paint(); save(); });
    input.addEventListener('change', () => { save(true); ui('select'); });
    refreshers.push(paint);
    paint();
  };

  const toggle = (parent: HTMLElement, key: BoolKey, label: string, hint?: string) => {
    const r = row(parent, label, hint);
    const b = el('button', 'ip-switch', r);
    b.type = 'button'; b.setAttribute('role', 'switch'); b.setAttribute('aria-label', label);
    el('div', 'ip-set-val', r);
    const paint = () => b.setAttribute('aria-checked', String(!!s[key]));
    b.addEventListener('click', () => { s[key] = !s[key]; paint(); save(true); ui('click'); });
    refreshers.push(paint);
    paint();
  };

  const segmented = <K extends 'quality' | 'healthBars'>(parent: HTMLElement, key: K, label: string, options: Array<[Settings[K], string]>, hint?: string) => {
    const r = row(parent, label, hint);
    const seg = el('div', 'ip-seg', r);
    seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', label);
    el('div', 'ip-set-val', r);
    const btns = options.map(([v, text]) => {
      const b = el('button', '', seg, text);
      b.type = 'button';
      b.addEventListener('click', () => { s[key] = v; paint(); save(true); ui('click'); });
      return [v, b] as const;
    });
    const paint = () => { for (const [v, b] of btns) b.setAttribute('aria-pressed', String(s[key] === v)); };
    refreshers.push(paint);
    paint();
  };

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const audio = group('Audio');
  slider(audio, 'masterVolume', 'Master volume', 0, 1, 0.01, pct);
  slider(audio, 'musicVolume', 'Music', 0, 1, 0.01, pct);
  slider(audio, 'sfxVolume', 'Effects', 0, 1, 0.01, pct);
  slider(audio, 'voiceVolume', 'Announcer voice', 0, 1, 0.01, pct);
  {
    // Spoken announcer (speechSynthesis) — owned/persisted by the audio engine, default off.
    const au = app.audio as unknown as { speechEnabled?: boolean; setSpeechEnabled?: (on: boolean) => void };
    if (typeof au.setSpeechEnabled === 'function') {
      const r = row(audio, 'Spoken announcer', 'Read alerts aloud (browser speech)');
      const b = el('button', 'ip-switch', r);
      b.type = 'button'; b.setAttribute('role', 'switch'); b.setAttribute('aria-label', 'Spoken announcer');
      el('div', 'ip-set-val', r);
      const paint = () => b.setAttribute('aria-checked', String(!!au.speechEnabled));
      b.addEventListener('click', () => { au.setSpeechEnabled!(!au.speechEnabled); paint(); ui('click'); });
      refreshers.push(paint);
      paint();
    }
  }

  const controls = group('Controls');
  slider(controls, 'scrollSpeed', 'Camera scroll speed', 0.5, 2, 0.05, (v) => `${v.toFixed(2).replace(/0$/, '')}×`);
  toggle(controls, 'edgeScroll', 'Screen-edge scrolling', 'Move the camera at the window edges');

  const display = group('Display');
  segmented(display, 'quality', 'Graphics quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] as Array<[Quality, string]>, 'Applies to the next match');
  segmented(display, 'healthBars', 'Health bars', [['always', 'Always'], ['damaged', 'Damaged'], ['selected', 'Selected']]);
  toggle(display, 'showFps', 'FPS counter');

  const foot = el('div', 'ip-set-foot', root);
  el('div', 'ip-set-hint', foot, 'Settings are saved automatically.');
  const reset = el('button', 'ip-btn', foot, 'Reset to defaults');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    Object.assign(s, DEFAULT_SETTINGS);
    for (const f of refreshers) f();
    save(true);
    ui('confirm');
  });

  return {
    el: root,
    refresh: () => { for (const f of refreshers) f(); },
    dispose: () => { window.clearTimeout(saveTimer); if (pending) app.saveSettings(); root.remove(); },
  };
}
