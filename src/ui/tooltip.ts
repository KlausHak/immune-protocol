/**
 * [ui] One shared tooltip element per screen. Content changes are diffed (HtmlSlot) so a tooltip that is
 * refreshed every frame (e.g. "not enough Supplies" turning valid) costs nothing when unchanged.
 */
import { el, HtmlSlot, setClass } from './dom';

export type TipPlacement = 'above' | 'below' | 'right' | 'left';

export interface TipAnchor { rect: DOMRect; place?: TipPlacement; align?: 'start' | 'center' | 'end' }

export class Tooltip {
  readonly el: HTMLDivElement;
  private body: HtmlSlot;
  private owner: unknown = null;

  constructor(private parent: HTMLElement) {
    this.el = el('div', 'ip-tip', parent);
    this.el.setAttribute('role', 'tooltip');
    this.body = new HtmlSlot(this.el);
  }

  /** Show `html` next to an anchor. `owner` identifies who opened it (so stale hides are ignored). */
  show(html: string, anchor: TipAnchor, owner: unknown = null): void {
    this.owner = owner;
    this.body.set(html);
    this.position(anchor);
    setClass(this.el, 'is-on', true);
  }

  /** Refresh content in place (no-op if unchanged or hidden). */
  update(html: string, owner: unknown = null): void {
    if (!this.visible || (owner !== null && owner !== this.owner)) return;
    this.body.set(html);
  }

  /** Hide; if `owner` is given only hide when that owner opened the tooltip. */
  hide(owner: unknown = null): void {
    if (owner !== null && owner !== this.owner) return;
    this.owner = null;
    setClass(this.el, 'is-on', false);
  }

  get visible(): boolean { return this.el.classList.contains('is-on'); }
  get currentOwner(): unknown { return this.owner; }

  private position(a: TipAnchor): void {
    const pr = this.parent.getBoundingClientRect();
    const tw = this.el.offsetWidth, th = this.el.offsetHeight;
    const gap = 8, r = a.rect, place = a.place ?? 'above', align = a.align ?? 'center';
    let x: number, y: number;
    if (place === 'above' || place === 'below') {
      x = align === 'start' ? r.left : align === 'end' ? r.right - tw : r.left + r.width / 2 - tw / 2;
      y = place === 'above' ? r.top - th - gap : r.bottom + gap;
      if (place === 'above' && y < pr.top + 4) y = r.bottom + gap;
    } else {
      y = align === 'start' ? r.top : align === 'end' ? r.bottom - th : r.top + r.height / 2 - th / 2;
      x = place === 'right' ? r.right + gap : r.left - tw - gap;
    }
    x = Math.max(pr.left + 6, Math.min(pr.right - tw - 6, x));
    y = Math.max(pr.top + 6, Math.min(pr.bottom - th - 6, y));
    this.el.style.transform = `translate(${Math.round(x - pr.left)}px, ${Math.round(y - pr.top)}px)`;
  }

  dispose(): void { this.el.remove(); }
}
