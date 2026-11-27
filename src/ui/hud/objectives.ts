/**
 * [ui] Objectives panel (left column): primary objectives, then bonus ones; active / done / failed
 * styling, progress text, highlight on new objectives and on completion. Rebuilt only when the list changes.
 */
import type { ObjectiveView } from '../../core/ui';
import { el, setClass } from '../dom';
import { glyphHtml } from '../icons';

export class ObjectivesPanel {
  readonly el: HTMLDivElement;
  private list: HTMLDivElement;
  private sig = '';
  private known = new Map<string, ObjectiveView['state']>();
  private collapsed = false;
  /** Called with objectives that just became done / failed (HUD may toast them). */
  onChange: ((obj: ObjectiveView, prev: ObjectiveView['state'] | undefined) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.el = el('div', 'ip-panel ip-ecg ip-obj', parent);
    this.el.dataset.testid = 'objectives';
    const head = el('div', 'ip-obj-head', this.el);
    head.innerHTML = glyphHtml('ui.pulse');
    el('span', 'ip-obj-title', head, 'Objectives');
    const tog = el('span', 'ip-obj-toggle', head, '▾');
    head.addEventListener('click', (e) => {
      e.stopPropagation();
      this.collapsed = !this.collapsed;
      setClass(this.el, 'is-collapsed', this.collapsed);
      tog.textContent = this.collapsed ? '▸' : '▾';
    });
    this.list = el('div', 'ip-obj-list', this.el);
    this.el.style.display = 'none';
  }

  set(objs: ObjectiveView[]): void {
    const sig = JSON.stringify(objs ?? []);
    if (sig === this.sig) return;
    this.sig = sig;
    const items = objs ?? [];
    this.el.style.display = items.length ? '' : 'none';
    this.list.textContent = '';
    const first = this.known.size === 0;
    const primary = items.filter((o) => o.primary), bonus = items.filter((o) => !o.primary);
    const add = (o: ObjectiveView) => {
      const prev = this.known.get(o.id);
      const row = el('div', `ip-obj-item is-${o.state}${o.primary ? '' : ' is-bonus'}`, this.list);
      const mark = el('span', 'ip-obj-mark', row);
      mark.innerHTML = o.state === 'done' ? glyphHtml('ui.check') : o.state === 'failed' ? glyphHtml('ui.cross') : '';
      el('span', 'ip-obj-text', row, o.text);
      if (o.progress && o.state === 'active') el('span', 'ip-obj-prog', row, o.progress);
      if (!first && prev === undefined) row.classList.add('is-new');
      if (prev !== undefined && prev !== o.state && o.state === 'done') row.classList.add('just-done');
      if (prev !== undefined && prev !== o.state && o.state !== 'active') this.onChange?.(o, prev);
    };
    primary.forEach(add);
    if (bonus.length) {
      el('div', 'ip-obj-sub', this.list, 'Bonus');
      bonus.forEach(add);
    }
    this.known = new Map(items.map((o) => [o.id, o.state]));
  }

  dispose(): void { this.el.remove(); }
}
