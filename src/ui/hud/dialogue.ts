/**
 * [ui] Dialogue "comm link": portrait + speaker + typewriter text, queued lines, auto-advance after
 * `duration` (default ≈ 3 s + reading time), click = finish typing / next line. Strain Omega speaks in a
 * glitching mono font. Timers freeze while the game is paused.
 */
import type { DialogueLine } from '../../core/ui';
import { el, setClass, setStyle, TextSlot } from '../dom';
import { portraitAccent, portraitSvg } from '../portraits';

const CPS = 46;                 // typing speed, characters per second
const GLITCH = '█▓▒░#%&@$<>/\\';

interface Current { line: DialogueLine; t: number; dur: number; typeDur: number; shown: number }

export class DialogueBox {
  readonly el: HTMLDivElement;
  private portrait: HTMLDivElement;
  private name: TextSlot;
  private role: TextSlot;
  private textNode: Text;
  private caret: HTMLSpanElement;
  private more: TextSlot;
  private prog: HTMLElement;
  private queue: DialogueLine[] = [];
  private cur: Current | null = null;
  private gap = 0;
  /** Called when a new line starts (HUD plays a UI blip). */
  onLine: ((line: DialogueLine) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.el = el('div', 'ip-panel ip-ecg ip-dlg-box is-hidden', parent);
    this.el.dataset.testid = 'dialogue';
    this.portrait = el('div', 'ip-dlg-portrait', this.el);
    const body = el('div', 'ip-dlg-body', this.el);
    const head = el('div', 'ip-dlg-head', body);
    this.name = new TextSlot(el('span', 'ip-dlg-name', head));
    this.role = new TextSlot(el('span', 'ip-dlg-role', head));
    el('span', 'ip-dlg-live', head, 'COMM LINK');
    const text = el('div', 'ip-dlg-text', body);
    this.textNode = document.createTextNode('');
    text.appendChild(this.textNode);
    this.caret = el('span', 'ip-caret', text);
    const foot = el('div', 'ip-dlg-foot', body);
    const pb = el('div', 'ip-dlg-prog', foot);
    this.prog = el('i', '', pb);
    this.more = new TextSlot(el('span', '', foot));
    this.el.addEventListener('click', (e) => { e.stopPropagation(); this.skip(); });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get active(): boolean { return this.cur !== null; }

  push(line: DialogueLine): void {
    if (!line || !line.text) return;
    this.queue.push(line);
    if (!this.cur && this.gap <= 0) this.next();
  }

  /** Click: finish typing, else advance. */
  skip(): void {
    const c = this.cur;
    if (!c) return;
    if (c.t < c.typeDur) { c.t = c.typeDur; this.render(); return; }
    this.next();
  }

  clear(): void { this.queue = []; this.cur = null; setClass(this.el, 'is-hidden', true); }

  private next(): void {
    const line = this.queue.shift();
    if (!line) {
      this.cur = null;
      setClass(this.el, 'is-hidden', true);
      return;
    }
    const text = line.text;
    const typeDur = text.length / CPS;
    const auto = 3 + text.length * 0.045;
    const dur = Math.max(typeDur + 1.4, line.duration ?? Math.min(14, auto));
    this.cur = { line, t: 0, dur, typeDur, shown: -1 };
    const [nm, ...rest] = line.speaker.split(',');
    this.name.set((nm ?? line.speaker).trim());
    this.role.set(rest.join(',').trim());
    this.portrait.innerHTML = portraitSvg(line.portrait);
    const accent = portraitAccent(line.portrait);
    setStyle(this.el, '--pa', accent);
    setClass(this.el, 'is-omega', line.portrait === 'omega');
    setClass(this.el, 'is-hidden', false);
    this.textNode.data = '';
    this.render();
    this.onLine?.(line);
  }

  private render(): void {
    const c = this.cur;
    if (!c) return;
    const text = c.line.text;
    const n = Math.min(text.length, Math.floor(c.t * CPS));
    const typing = n < text.length;
    const omega = c.line.portrait === 'omega';
    if (n !== c.shown || (omega && typing)) {
      c.shown = n;
      let s = text.slice(0, n);
      if (omega && typing && s.length > 2) {
        // a couple of corrupted glyphs that resolve as typing moves on
        const chars = [...s];
        for (let k = 0; k < 2; k++) {
          const i = chars.length - 1 - Math.floor(Math.random() * Math.min(6, chars.length));
          if (chars[i] !== ' ') chars[i] = GLITCH[Math.floor(Math.random() * GLITCH.length)]!;
        }
        s = chars.join('');
      }
      this.textNode.data = s;
    }
    this.caret.style.display = typing ? '' : 'none';
    setClass(this.portrait, 'is-talking', typing);
    const left = Math.max(0, 1 - c.t / c.dur);
    setStyle(this.prog, 'transform', `scaleX(${left.toFixed(3)})`);
    const q = this.queue.length;
    this.more.set(typing ? 'Click to skip' : q > 0 ? `Click to continue · ${q} more` : 'Click to close');
  }

  update(dtReal: number, paused: boolean): void {
    if (paused) return;
    if (!this.cur) {
      if (this.gap > 0) { this.gap -= dtReal; if (this.gap <= 0 && this.queue.length) this.next(); }
      return;
    }
    this.cur.t += dtReal;
    if (this.cur.t >= this.cur.dur) {
      this.cur = null;
      if (this.queue.length) { this.gap = 0.18; setClass(this.el, 'is-hidden', true); }
      else this.next();
      return;
    }
    this.render();
  }

  dispose(): void { this.el.remove(); }
}
