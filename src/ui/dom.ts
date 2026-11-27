/**
 * [ui] Tiny DOM helpers shared by the HUD and the menus. Everything here is about writing to the DOM only
 * when a value actually changed (the HUD updates every frame, the DOM must not).
 */

/** Create an element with an optional class list, parent and text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, parent?: HTMLElement | null, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** A text node holder that only touches the DOM when the string changes. */
export class TextSlot {
  private v: string | null = null;
  constructor(readonly el: HTMLElement) {}
  set(v: string): void {
    if (v === this.v) return;
    this.v = v;
    this.el.textContent = v;
  }
}

/** innerHTML holder with change detection (icons, rich tooltips). */
export class HtmlSlot {
  private v: string | null = null;
  constructor(readonly el: HTMLElement) {}
  set(v: string): void {
    if (v === this.v) return;
    this.v = v;
    this.el.innerHTML = v;
  }
  get value(): string | null { return this.v; }
}

/** Toggle a class only when the state changes. */
export function setClass(e: Element, cls: string, on: boolean): void {
  if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
}

/** Set a style property (or CSS custom property) only when it changes. */
export function setStyle(e: HTMLElement, prop: string, value: string): void {
  const s = e.style;
  if (prop.startsWith('--')) {
    if (s.getPropertyValue(prop) !== value) s.setProperty(prop, value);
  } else if ((s as unknown as Record<string, string>)[prop] !== value) {
    (s as unknown as Record<string, string>)[prop] = value;
  }
}

/** Restart a CSS animation class (e.g. a red flash) even if it is already applied. */
export function retrigger(e: HTMLElement, cls: string): void {
  e.classList.remove(cls);
  void e.offsetWidth; // force style flush so the animation restarts
  e.classList.add(cls);
}

/** Escape text for safe use inside innerHTML templates. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Hex colour number → CSS string. */
export const cssHex = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

/** Hex colour number → "r,g,b" (for rgba(var(--x), a)). */
export const rgbTriplet = (c: number): string => `${(c >> 16) & 255},${(c >> 8) & 255},${c & 255}`;
