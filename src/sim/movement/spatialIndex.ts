/**
 * [movement] Faster drop-in SpatialIndex (same contract as sim/spatial.ts GridSpatialIndex).
 * Entities are binned once by centre into 4×4 cells with a counting sort (flat array, no Maps, no per-query
 * Sets); queries widen by the largest binned radius. Very large entities (radius > LARGE_R: HQs, the
 * Children's Hospital, bosses) live in a short side list checked linearly.
 * The movement system rebuilds it after moving units, so combat/economy/vision see fresh positions.
 */
import type { Entity, Vec2 } from '../../core/types';
import type { SpatialIndex } from '../services';
import type { World } from '../World';

const CELL = 4;
const LARGE_R = 2.0;
/** Slack for entities moved after the last rebuild (≤ one tick of motion). */
const MARGIN = 0.6;

export class FastSpatialIndex implements SpatialIndex {
  private readonly cols: number;
  private readonly rows: number;
  private readonly start: Int32Array;
  private readonly fill: Int32Array;
  private cellOf = new Int32Array(256);
  private items: Entity[] = [];
  private large: Entity[] = [];
  private maxR = 0;

  constructor(private readonly world: World) {
    this.cols = Math.ceil(world.map.width / CELL) + 1;
    this.rows = Math.ceil(world.map.height / CELL) + 1;
    this.start = new Int32Array(this.cols * this.rows + 1);
    this.fill = new Int32Array(this.cols * this.rows);
  }

  private col(x: number): number { const c = Math.floor(x / CELL); return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c; }
  private row(y: number): number { const r = Math.floor(y / CELL); return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r; }

  rebuild(): void {
    const list = this.world.list, n = list.length, nCells = this.cols * this.rows;
    const start = this.start;
    start.fill(0);
    if (this.cellOf.length < n) this.cellOf = new Int32Array(Math.max(n * 2, 256));
    const cellOf = this.cellOf;
    this.large.length = 0;
    let maxR = 0, count = 0;
    for (let i = 0; i < n; i++) {
      const e = list[i]!;
      if (!e.alive) { cellOf[i] = -1; continue; }
      if (e.radius > LARGE_R) { cellOf[i] = -1; this.large.push(e); continue; }
      const c = this.row(e.pos.y) * this.cols + this.col(e.pos.x);
      cellOf[i] = c;
      start[c + 1]!++;
      if (e.radius > maxR) maxR = e.radius;
      count++;
    }
    for (let c = 0; c < nCells; c++) start[c + 1]! += start[c]!;
    this.fill.set(start.subarray(0, nCells));
    const items = this.items;
    if (items.length < count) items.length = count;
    for (let i = 0; i < n; i++) {
      const c = cellOf[i]!;
      if (c >= 0) items[this.fill[c]!++] = list[i]!;
    }
    this.maxR = maxR;
  }

  queryRadius(p: Vec2, r: number, filter?: (e: Entity) => boolean, out: Entity[] = []): Entity[] {
    const reach = r + this.maxR + MARGIN;
    const cx0 = this.col(p.x - reach), cx1 = this.col(p.x + reach);
    const cy0 = this.row(p.y - reach), cy1 = this.row(p.y + reach);
    const start = this.start, items = this.items, px = p.x, py = p.y;
    for (let cy = cy0; cy <= cy1; cy++) {
      const base = cy * this.cols;
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = base + cx;
        for (let k = start[c]!, end = start[c + 1]!; k < end; k++) {
          const e = items[k]!;
          if (!e.alive) continue;
          const dx = e.pos.x - px, dy = e.pos.y - py, rr = r + e.radius;
          if (dx * dx + dy * dy <= rr * rr && (!filter || filter(e))) out.push(e);
        }
      }
    }
    for (const e of this.large) {
      if (!e.alive) continue;
      const dx = e.pos.x - px, dy = e.pos.y - py, rr = r + e.radius;
      if (dx * dx + dy * dy <= rr * rr && (!filter || filter(e))) out.push(e);
    }
    return out;
  }

  nearest(p: Vec2, r: number, filter: (e: Entity) => boolean): Entity | null {
    const reach = r + this.maxR + MARGIN;
    const cx0 = this.col(p.x - reach), cx1 = this.col(p.x + reach);
    const cy0 = this.row(p.y - reach), cy1 = this.row(p.y + reach);
    const start = this.start, items = this.items, px = p.x, py = p.y, w = this.world;
    let best: Entity | null = null, bestD = Infinity;
    const consider = (e: Entity): void => {
      if (!e.alive) return;
      const dx = e.pos.x - px, dy = e.pos.y - py, rr = r + e.radius;
      if (dx * dx + dy * dy > rr * rr || !filter(e)) return;
      const d = w.edgeDistanceToPoint(e, p);
      if (d < bestD) { bestD = d; best = e; }
    };
    for (let cy = cy0; cy <= cy1; cy++) {
      const base = cy * this.cols;
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = base + cx;
        for (let k = start[c]!, end = start[c + 1]!; k < end; k++) consider(items[k]!);
      }
    }
    for (const e of this.large) consider(e);
    return best;
  }

  queryRect(x0: number, y0: number, x1: number, y1: number, filter?: (e: Entity) => boolean): Entity[] {
    const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1);
    const out: Entity[] = [];
    const cx0 = this.col(lx - MARGIN), cx1 = this.col(hx + MARGIN), cy0 = this.row(ly - MARGIN), cy1 = this.row(hy + MARGIN);
    const start = this.start, items = this.items;
    const test = (e: Entity): void => {
      if (e.alive && e.pos.x >= lx && e.pos.x <= hx && e.pos.y >= ly && e.pos.y <= hy && (!filter || filter(e))) out.push(e);
    };
    for (let cy = cy0; cy <= cy1; cy++) {
      const base = cy * this.cols;
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = base + cx;
        for (let k = start[c]!, end = start[c + 1]!; k < end; k++) test(items[k]!);
      }
    }
    for (const e of this.large) test(e);
    return out;
  }
}
