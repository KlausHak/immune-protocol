/**
 * [ui] Modal overlays: pause menu (Resume / Settings / Restart / Quit, with inline confirmation),
 * in-game settings and the end screen (victory/defeat banner, stats table, next/retry/menu).
 */
import type { EndScreenResult } from '../../core/ui';
import { FACTIONS } from '../../data';
import { CAMPAIGN } from '../../campaign';
import type { GameContext } from '../../game/contracts';
import type { UiSound } from '../../audio/AudioEngine';
import { el, esc } from '../dom';
import { fmtClock } from '../format';
import { glyphHtml } from '../icons';
import { createSettingsPanel, type SettingsPanel } from '../settingsPanel';
import { createLoadPanel, createSavePanel, type Panel } from '../saveLoad';
import type { NotifyKind } from '../../core/ui';


function button(parent: HTMLElement, label: string, glyph: string, cls = '', key?: string): HTMLButtonElement {
  const b = el('button', `ip-btn ${cls}`.trim(), parent);
  b.type = 'button';
  b.innerHTML = `${glyphHtml(glyph)}<span>${esc(label)}</span>${key ? `<span class="ip-key">${esc(key)}</span>` : ''}`;
  return b;
}

/** Arrow-key focus cycling among the buttons of a container. */
function arrowFocus(container: HTMLElement, e: KeyboardEvent): boolean {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false;
  const btns = [...container.querySelectorAll<HTMLElement>('button:not([disabled]), input')].filter((b) => b.offsetParent !== null);
  if (!btns.length) return false;
  const i = btns.indexOf(document.activeElement as HTMLElement);
  const n = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
  btns[i < 0 ? 0 : n]!.focus();
  return true;
}

export class PauseMenu {
  private el: HTMLDivElement | null = null;
  private view: 'main' | 'settings' | 'confirm' | 'save' | 'load' = 'main';
  private settings: SettingsPanel | null = null;
  private panel: Panel | null = null;
  private wasPaused = false;

  constructor(private parent: HTMLElement, private game: GameContext, private sound: (k: UiSound) => void,
    private toast: (text: string, kind: NotifyKind) => void = () => {}) {}

  get isOpen(): boolean { return this.el !== null; }

  open(): void {
    if (this.el) return;
    this.wasPaused = this.game.paused;
    this.game.pause();
    this.el = el('div', 'ip-modal ip-pause', this.parent);
    this.el.dataset.testid = 'pause-menu';
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('mousedown', (e) => { if (e.target === this.el) e.preventDefault(); });
    this.sound('open');
    this.showMain();
  }

  close(): void {
    if (!this.el) return;
    this.settings?.dispose();
    this.settings = null;
    this.panel?.dispose();
    this.panel = null;
    this.el.remove();
    this.el = null;
    if (!this.wasPaused) this.game.resume();
    this.sound('close');
    try { (this.game.renderer?.three?.domElement as HTMLCanvasElement | undefined)?.focus(); } catch { /* optional */ }
  }

  private subtitle(): string {
    const g = this.game;
    const diff = g.config.difficulty[0]!.toUpperCase() + g.config.difficulty.slice(1);
    if (g.mission) return `${g.mission.info.subtitle} · ${g.mission.info.title} · ${diff}`;
    return `Skirmish · ${g.map.name} · ${diff}`;
  }

  private card(cls: string): HTMLDivElement {
    this.settings?.dispose();
    this.settings = null;
    this.panel?.dispose();
    this.panel = null;
    this.el!.textContent = '';
    return el('div', `ip-panel ip-ecg ${cls}`, this.el!);
  }

  private showMain(): void {
    this.view = 'main';
    const c = this.card('ip-pause-card');
    el('div', 'ip-pause-title', c, 'PAUSED');
    el('div', 'ip-pause-sub', c, this.subtitle());
    el('div', 'ip-flatline', c);
    const resume = button(c, 'Resume', 'ui.play', 'ip-btn-primary', 'Esc');
    resume.addEventListener('click', () => this.close());
    const save = button(c, 'Save game', 'ui.flag', '', 'F5');
    save.dataset.testid = 'pause-save';
    save.disabled = !this.game.canSave();
    if (save.disabled) save.title = 'The match has ended — nothing to save.';
    save.addEventListener('click', () => { this.sound('click'); this.showSaveLoad('save'); });
    const load = button(c, 'Load game', 'ui.restart', '', 'F9');
    load.dataset.testid = 'pause-load';
    load.addEventListener('click', () => { this.sound('click'); this.showSaveLoad('load'); });
    button(c, 'Settings', 'ui.sliders').addEventListener('click', () => { this.sound('click'); this.showSettings(); });
    button(c, this.game.mission ? 'Restart mission' : 'Restart match', 'ui.restart').addEventListener('click', () => { this.sound('click'); this.confirm('restart'); });
    button(c, 'Quit to main menu', 'ui.exit', 'ip-btn-danger').addEventListener('click', () => { this.sound('click'); this.confirm('quit'); });
    resume.focus();
  }

  private confirm(what: 'restart' | 'quit'): void {
    this.view = 'confirm';
    const c = this.card('ip-pause-card');
    el('div', 'ip-pause-title', c, what === 'restart' ? 'RESTART?' : 'QUIT?');
    el('div', 'ip-pause-sub', c, this.subtitle());
    el('div', 'ip-flatline', c);
    const box = el('div', 'ip-confirm', c);
    el('div', 'ip-confirm-txt', box, what === 'restart' ? 'Restart from the beginning? Current progress will be lost.' : 'Abandon this operation and return to the main menu?');
    const row = el('div', 'ip-confirm-row', box);
    const yes = button(row, what === 'restart' ? 'Restart' : 'Quit', what === 'restart' ? 'ui.restart' : 'ui.exit', 'ip-btn-danger');
    const no = button(row, 'Cancel', 'ui.cross');
    yes.addEventListener('click', () => {
      this.sound('confirm');
      const g = this.game;
      this.el?.remove(); this.el = null;
      if (what === 'restart') g.restart(); else g.quitToMenu();
    });
    no.addEventListener('click', () => { this.sound('click'); this.showMain(); });
    no.focus();
  }

  private showSettings(): void {
    this.view = 'settings';
    const c = this.card('ip-set-card');
    const head = el('div', 'ip-card-head', c);
    head.innerHTML = glyphHtml('ui.sliders');
    el('h2', '', head, 'Settings');
    const back = button(head, 'Back', 'ui.next', '', 'Esc');
    back.querySelector('.ip-glyph')?.setAttribute('style', 'transform:scaleX(-1)');
    back.addEventListener('click', () => { this.sound('click'); this.showMain(); });
    this.settings = createSettingsPanel(this.game.app);
    c.appendChild(this.settings.el);
    back.focus();
  }

  /** Open the menu directly on the Save or Load panel. */
  openPanel(kind: 'save' | 'load'): void {
    this.open();
    this.showSaveLoad(kind);
  }

  private showSaveLoad(kind: 'save' | 'load'): void {
    this.view = kind;
    const c = this.card('ip-set-card ip-save-card');
    const head = el('div', 'ip-card-head', c);
    head.innerHTML = glyphHtml(kind === 'save' ? 'ui.flag' : 'ui.restart');
    el('h2', '', head, kind === 'save' ? 'Save game' : 'Load game');
    const back = button(head, 'Back', 'ui.next', '', 'Esc');
    back.querySelector('.ip-glyph')?.setAttribute('style', 'transform:scaleX(-1)');
    back.addEventListener('click', () => { this.sound('click'); this.showMain(); });
    const ctx = { app: this.game.app, game: this.game, toast: this.toast, sound: this.sound };
    this.panel = kind === 'save' ? createSavePanel(ctx) : createLoadPanel(ctx);
    c.appendChild(this.panel.el);
    (c.querySelector<HTMLInputElement>('.ip-input:not([disabled])') ?? back).focus();
  }

  /** Keyboard while open. Returns true when handled. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.el) return false;
    if (e.key === 'Escape' || e.key === 'F10') {
      if (this.view === 'main') this.close(); else { this.sound('close'); this.showMain(); }
      return true;
    }
    return arrowFocus(this.el, e);
  }

  dispose(): void {
    this.settings?.dispose();
    this.panel?.dispose();
    this.el?.remove();
    this.el = null;
  }
}

/** ECG paths for the end banner: steady rhythm (victory) or a final beat into flatline (defeat). */
function ecgPath(victory: boolean): string {
  const beat = (x: number) => `L${x} 30 L${x + 6} 26 L${x + 10} 30 L${x + 14} 30 L${x + 18} 6 L${x + 23} 50 L${x + 27} 22 L${x + 31} 30 L${x + 40} 30 Q${x + 46} 22 ${x + 52} 30`;
  if (victory) {
    let d = 'M0 30';
    for (let x = 20; x < 560; x += 110) d += ` ${beat(x)}`;
    return `${d} L600 30`;
  }
  return `M0 30 ${beat(40)} ${beat(150)} L240 30 L256 27 L262 33 L268 30 L600 30`;
}

export class EndScreen {
  private el: HTMLDivElement | null = null;
  private timer = 0;

  constructor(private parent: HTMLElement, private game: GameContext, private sound: (k: UiSound) => void) {}

  get isOpen(): boolean { return this.el !== null || this.timer !== 0; }

  /** Show after a short beat so the final moment of the battle is visible. */
  show(result: EndScreenResult, delayMs = 1100): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = 0; this.build(result); }, Math.max(0, delayMs));
  }

  private build(r: EndScreenResult): void {
    this.el?.remove();
    const g = this.game;
    const me = g.world.player(g.localPlayerId), foe = g.world.player(g.enemyPlayerId);
    const m = el('div', `ip-modal ip-end ${r.victory ? 'is-victory' : 'is-defeat'}`, this.parent);
    m.dataset.testid = 'end-screen';
    m.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el = m;
    const c = el('div', 'ip-panel ip-ecg ip-end-card', m);
    c.insertAdjacentHTML('beforeend', `<svg class="ip-end-ecg" viewBox="0 0 600 56" preserveAspectRatio="none" aria-hidden="true"><path d="${ecgPath(r.victory)}"/></svg>`);
    const campaign = !!r.missionId;
    el('div', 'ip-end-kicker', c, r.victory ? (campaign ? 'Mission complete' : 'Victory') : (campaign ? 'Mission failed' : 'Defeat'));
    el('div', 'ip-end-title', c, r.title || (r.victory ? 'VICTORY' : 'DEFEAT'));
    if (r.subtitle) el('div', 'ip-end-sub', c, r.subtitle);
    el('div', 'ip-end-time', c, `Operation time ${fmtClock(r.timeSeconds)}`);
    if (r.stats?.length) {
      const t = el('table', 'ip-end-stats', c);
      const youName = FACTIONS[me.faction]?.name ?? 'You';
      const foeName = FACTIONS[foe.faction]?.name ?? 'Enemy';
      t.innerHTML = `<thead><tr><th></th><th>${esc(youName)}</th><th>${esc(foeName)}</th></tr></thead><tbody>${r.stats.map((s) =>
        `<tr><td>${esc(s.label)}</td><td class="is-you">${esc(String(s.you))}</td><td>${s.enemy == null ? '—' : esc(String(s.enemy))}</td></tr>`).join('')}</tbody>`;
    }
    const btns = el('div', 'ip-end-btns', c);
    let first: HTMLButtonElement | null = null;
    if (r.nextMissionId) {
      const next = CAMPAIGN.find((x) => x.id === r.nextMissionId);
      const b = button(btns, next ? `Next: ${next.title}` : 'Next mission', 'ui.next', 'ip-btn-primary');
      b.addEventListener('click', () => { this.sound('confirm'); g.app.startGame({ mode: 'campaign', missionId: r.nextMissionId!, difficulty: g.config.difficulty }); });
      first = b;
    }
    const retry = button(btns, r.victory ? 'Play again' : 'Retry', 'ui.restart', r.nextMissionId || r.victory ? '' : 'ip-btn-primary');
    retry.addEventListener('click', () => { this.sound('confirm'); g.restart(); });
    const menu = button(btns, 'Main menu', 'ui.home');
    menu.addEventListener('click', () => { this.sound('click'); g.quitToMenu(); });
    (first ?? retry).focus();
    this.sound(r.victory ? 'confirm' : 'error');
  }

  /** Keyboard while shown (arrow keys move focus between the buttons). Returns true when handled. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.el) return false;
    return arrowFocus(this.el, e);
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.el?.remove();
    this.el = null;
  }
}
