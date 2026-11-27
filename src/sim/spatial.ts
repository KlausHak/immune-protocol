import { dist } from '../core/math';
import type { Entity, Vec2 } from '../core/types';
import type { SpatialIndex } from './services';
import type { World } from './World';

/** Default uniform-grid spatial hash. Entities are inserted into every cell their circle overlaps. */
export class GridSpatialIndex implements SpatialIndex {
  private cells = new Map<number, Entity[]>();
  private readonly cols: number;
  constructor(private world: World, private cellSize = 4) {
    this.cols = Math.ceil(world.map.width / cellSize) + 2;
  }
  private key(cx: number, cy: number): number { return (cy + 1) * this.cols + (cx + 1); }

  rebuild(): void {
    this.cells.clear();
    const cs = this.cellSize;
    for (const e of this.world.list) {
      if (!e.alive) continue;
      const x0 = Math.floor((e.pos.x - e.radius) / cs), x1 = Math.floor((e.pos.x + e.radius) / cs);
      const y0 = Math.floor((e.pos.y - e.radius) / cs), y1 = Math.floor((e.pos.y + e.radius) / cs);
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const k = this.key(cx, cy);
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(e);
      }
    }
  }

  queryRadius(p: Vec2, r: number, filter?: (e: Entity) => boolean, out: Entity[] = []): Entity[] {
    const cs = this.cellSize;
    const x0 = Math.floor((p.x - r) / cs), x1 = Math.floor((p.x + r) / cs);
    const y0 = Math.floor((p.y - r) / cs), y1 = Math.floor((p.y + r) / cs);
    const seen = new Set<number>();
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const arr = this.cells.get(this.key(cx, cy));
      if (!arr) continue;
      for (const e of arr) {
        if (seen.has(e.id) || !e.alive) continue;
        seen.add(e.id);
        if (dist(p, e.pos) <= r + e.radius && (!filter || filter(e))) out.push(e);
      }
    }
    return out;
  }

  nearest(p: Vec2, r: number, filter: (e: Entity) => boolean): Entity | null {
    let best: Entity | null = null, bestD = Infinity;
    for (const e of this.queryRadius(p, r, filter)) {
      const d = this.world.edgeDistanceToPoint(e, p);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  queryRect(x0: number, y0: number, x1: number, y1: number, filter?: (e: Entity) => boolean): Entity[] {
    const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1);
    const out: Entity[] = [];
    for (const e of this.queryRadius({ x: (lx + hx) / 2, y: (ly + hy) / 2 }, Math.hypot(hx - lx, hy - ly) / 2 + 0.01)) {
      if (e.pos.x >= lx && e.pos.x <= hx && e.pos.y >= ly && e.pos.y <= hy && (!filter || filter(e))) out.push(e);
    }
    return out;
  }
}
