/**
 * [input] The drag box-select rectangle: a DOM overlay in #ui-root (pointer-events: none) styled as teal
 * glass. Coordinates are canvas-relative CSS pixels (the same space as GameRenderer picking).
 */
export class SelectionBox {
  private readonly el: HTMLDivElement;
  private readonly root: HTMLElement;
  private visible = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.root = document.getElementById('ui-root') ?? canvas.parentElement ?? document.body;
    this.el = document.createElement('div');
    this.el.className = 'ip-selection-box';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:0', 'height:0', 'display:none', 'pointer-events:none', 'z-index:4',
      'box-sizing:border-box', 'border:1px solid rgba(118,255,236,0.95)', 'border-radius:3px',
      'background:linear-gradient(135deg, rgba(47,214,198,0.22), rgba(47,214,198,0.07) 60%, rgba(160,255,245,0.12))',
      'box-shadow:0 0 0 1px rgba(0,30,34,0.45), 0 0 12px rgba(47,214,198,0.45), inset 0 0 16px rgba(47,214,198,0.22)',
      'backdrop-filter:brightness(1.12) saturate(1.2)', '-webkit-backdrop-filter:brightness(1.12) saturate(1.2)',
    ].join(';');
    this.root.appendChild(this.el);
  }

  /** Show the rectangle spanning two canvas-relative points (clamped to the canvas). */
  show(x0: number, y0: number, x1: number, y1: number): void {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const cl = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
    const l = cl(Math.min(x0, x1), cw), r = cl(Math.max(x0, x1), cw);
    const t = cl(Math.min(y0, y1), ch), b = cl(Math.max(y0, y1), ch);
    const cr = this.canvas.getBoundingClientRect(), rr = this.root.getBoundingClientRect();
    const s = this.el.style;
    s.left = `${l + cr.left - rr.left}px`;
    s.top = `${t + cr.top - rr.top}px`;
    s.width = `${r - l}px`;
    s.height = `${b - t}px`;
    if (!this.visible) { s.display = 'block'; this.visible = true; }
  }

  hide(): void {
    if (!this.visible) return;
    this.el.style.display = 'none';
    this.visible = false;
  }

  get shown(): boolean { return this.visible; }

  dispose(): void { this.el.remove(); }
}
