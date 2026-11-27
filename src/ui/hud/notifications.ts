/**
 * [ui] Toasts (centre-top, transient, de-duplicated) and the alert log (top-left, clickable → camera).
 * Both run on real time so they keep fading while the game is paused.
 */
import type { NotifyKind } from '../../core/ui';
import type { Vec2 } from '../../core/types';
import { el, retrigger, TextSlot } from '../dom';
import { fmtClock } from '../format';
import { glyphHtml } from '../icons';

interface Toast { el: HTMLDivElement; text: string; kind: NotifyKind; t: number; life: number; count: number; countEl: TextSlot; out: boolean }
interface AlertItem { el: HTMLDivElement; t: number; life: number; pos: Vec2 | null; out: boolean }

const TOAST_LIFE: Record<NotifyKind, number> = { info: 3.8, success: 4.2, warning: 3.2, alert: 5 };
const KIND_ICON: Record<NotifyKind, string> = { info: 'ui.info', success: 'ui.check', warning: 'ui.alert', alert: 'ui.alert' };
const MAX_TOASTS = 4;
const MAX_ALERTS = 5;

export class Notifications {
  readonly toastsEl: HTMLDivElement;
  readonly alertsEl: HTMLDivElement;
  private toasts: Toast[] = [];
  private alerts: AlertItem[] = [];
  /** Position of the most recent located alert (Space = jump there; exposed via Hud.lastAlertPos). */
  lastAlertPos: Vec2 | null = null;

  constructor(toastParent: HTMLElement, alertParent: HTMLElement, private onAlertClick: (pos: Vec2) => void) {
    this.toastsEl = el('div', 'ip-toasts', toastParent);
    this.toastsEl.dataset.testid = 'toasts';
    this.toastsEl.setAttribute('aria-live', 'polite');
    this.alertsEl = el('div', 'ip-alerts', alertParent);
    this.alertsEl.dataset.testid = 'alerts';
  }

  toast(text: string, kind: NotifyKind = 'info'): void {
    const clean = (text ?? '').trim();
    if (!clean) return;
    const dup = this.toasts.find((t) => !t.out && t.text === clean);
    if (dup) {
      dup.t = 0;
      dup.count++;
      dup.countEl.set(`×${dup.count}`);
      retrigger(dup.el, 'is-bump');
      return;
    }
    const n = el('div', `ip-toast k-${kind}`, this.toastsEl);
    n.innerHTML = glyphHtml(KIND_ICON[kind] ?? 'ui.info');
    el('span', '', n, clean);
    const countEl = new TextSlot(el('span', 'ip-toast-count', n));
    this.toasts.push({ el: n, text: clean, kind, t: 0, life: TOAST_LIFE[kind] ?? 3.8, count: 1, countEl, out: false });
    const live = this.toasts.filter((t) => !t.out);
    if (live.length > MAX_TOASTS) this.fadeToast(live[0]!);
  }

  /** Persistent-ish log entry (≈20 s). Located alerts can be clicked to jump the camera. */
  alert(text: string, kind: NotifyKind, gameTime: number, pos: Vec2 | null = null, glyph?: string): void {
    const a = el('div', `ip-alert k-${kind}`, this.alertsEl);
    a.innerHTML = glyphHtml(glyph ?? KIND_ICON[kind] ?? 'ui.info');
    el('span', '', a, text);
    el('span', 'ip-alert-time', a, fmtClock(gameTime));
    if (pos) {
      a.title = 'Click to jump to the location (Space)';
      const p = { x: pos.x, y: pos.y };
      a.addEventListener('click', (e) => { e.stopPropagation(); this.onAlertClick(p); });
      this.lastAlertPos = p;
    } else {
      a.style.cursor = 'default';
    }
    this.alerts.push({ el: a, t: 0, life: 20, pos, out: false });
    const live = this.alerts.filter((x) => !x.out);
    if (live.length > MAX_ALERTS) this.fadeAlert(live[0]!);
  }

  private fadeToast(t: Toast): void {
    if (t.out) return;
    t.out = true;
    t.el.classList.add('is-out');
    window.setTimeout(() => { t.el.remove(); this.toasts = this.toasts.filter((x) => x !== t); }, 460);
  }

  private fadeAlert(a: AlertItem): void {
    if (a.out) return;
    a.out = true;
    a.el.classList.add('is-out');
    window.setTimeout(() => { a.el.remove(); this.alerts = this.alerts.filter((x) => x !== a); }, 620);
  }

  update(dtReal: number): void {
    for (const t of this.toasts) { if (t.out) continue; t.t += dtReal; if (t.t >= t.life) this.fadeToast(t); }
    for (const a of this.alerts) { if (a.out) continue; a.t += dtReal; if (a.t >= a.life) this.fadeAlert(a); }
  }

  dispose(): void {
    this.toastsEl.remove();
    this.alertsEl.remove();
  }
}
