/**
 * [movement] Grid search on the NavGrid for one size class:
 *  - A* (8-connected, octile heuristic with a tiny tie-break weight, no diagonal corner cutting) that falls
 *    back to the expanded node closest to the goal if the goal can't be reached within the expansion cap;
 *  - Dijkstra "flow fields" from a source node with early termination once every interested start node is
 *    settled (shared by groups ordered to the same area); paths are read back through parent pointers;
 *  - string-pulling smoothing with exact capsule line of sight (exponential + binary search per anchor).
 * Search state lives in preallocated typed arrays with generation stamps (no clearing between searches).
 */
import type { Vec2 } from '../../core/types';
import { NodeHeap } from './heap';
import type { NavGrid } from './navgrid';

const SQRT2 = Math.SQRT2;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const COST = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];
/** Heuristic weight: breaks f-ties toward the goal (huge expansion savings in open terrain, ≤0.05% longer paths). */
const H_WEIGHT = 1.0005;

/** A cached Dijkstra field (distance to `source` + parent pointer toward it). */
export interface FlowField {
  key: string;
  version: number;
  source: number;
  cls: number;
  dist: Float32Array;
  parent: Int32Array;
  lastUsed: number;
}

export class Pathfinder {
  /** Node expansions of the last search (for budgets / stats). */
  expansions = 0;
  /** Whether the last A* reached its goal. */
  lastFound = false;

  private readonly g: Float64Array;
  private readonly parent: Int32Array;
  private readonly open: Uint32Array;
  private readonly closed: Uint32Array;
  private readonly mark: Uint32Array;
  private readonly heap = new NodeHeap(4096);
  private gen = 0;

  constructor(private readonly nav: NavGrid) {
    const N = nav.N;
    this.g = new Float64Array(N);
    this.parent = new Int32Array(N);
    this.open = new Uint32Array(N);
    this.closed = new Uint32Array(N);
    this.mark = new Uint32Array(N);
  }

  private nextGen(): number {
    if (++this.gen >= 0xfffffff0) { this.open.fill(0); this.closed.fill(0); this.mark.fill(0); this.gen = 1; }
    return this.gen;
  }

  /**
   * A* from `start` to `goal` (node indices) for class `cls`. Returns the node sequence start..end where end
   * is the goal, or — if unreachable within `maxExpansions` — the expanded node with the smallest heuristic.
   */
  astar(start: number, goal: number, cls: number, maxExpansions = Infinity): number[] {
    const nav = this.nav, W = nav.W, H = nav.H, tc = nav.tc;
    const gen = this.nextGen();
    const g = this.g, par = this.parent, open = this.open, closed = this.closed, heap = this.heap;
    heap.clear();
    const gx = goal % W, gy = (goal - gx) / W;
    const sx = start % W, sy = (start - sx) / W;
    const h0 = octile(sx, sy, gx, gy);
    g[start] = 0; par[start] = -1; open[start] = gen;
    heap.push(start, h0 * H_WEIGHT);
    let best = start, bestH = h0, exp = 0, found = false;
    while (heap.size > 0) {
      const cur = heap.pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      exp++;
      if (cur === goal) { found = true; break; }
      const cx = cur % W, cy = (cur - cx) / W;
      const hc = octile(cx, cy, gx, gy);
      if (hc < bestH) { bestH = hc; best = cur; }
      if (exp >= maxExpansions) break;
      const gc = g[cur]!;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d]!, ny = cy + DY[d]!;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (tc[n]! < cls || closed[n] === gen) continue;
        if (d >= 4 && (tc[cy * W + nx]! < cls || tc[ny * W + cx]! < cls)) continue;
        const ng = gc + COST[d]!;
        if (open[n] === gen && ng >= g[n]!) continue;
        g[n] = ng; par[n] = cur; open[n] = gen;
        heap.push(n, ng + octile(nx, ny, gx, gy) * H_WEIGHT);
      }
    }
    this.expansions = exp;
    this.lastFound = found;
    const out: number[] = [];
    for (let n = found ? goal : best, guard = 0; n !== -1 && guard < nav.N; n = par[n]!, guard++) out.push(n);
    out.reverse();
    return out;
  }

  /**
   * Fill `f` with a Dijkstra field from `source`. Stops `slack` path-units after the last of `targets` is
   * settled (targets not admissible/reachable are ignored once the frontier passes them).
   */
  buildField(f: FlowField, source: number, cls: number, targets: ArrayLike<number>, slack: number): void {
    const nav = this.nav, W = nav.W, H = nav.H, tc = nav.tc;
    const gen = this.nextGen();
    const dist = f.dist, par = f.parent, closed = this.closed, mark = this.mark, heap = this.heap;
    dist.fill(Infinity);
    heap.clear();
    let want = 0;
    for (let k = 0; k < targets.length; k++) {
      const t = targets[k]!;
      if (t >= 0 && mark[t] !== gen && tc[t]! >= cls) { mark[t] = gen; want++; }
    }
    dist[source] = 0; par[source] = -1;
    heap.push(source, 0);
    let settled = 0, stopAt = want === 0 ? slack : Infinity, exp = 0;
    while (heap.size > 0) {
      if (heap.peekKey() > stopAt) break;
      const cur = heap.pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      exp++;
      const dc = dist[cur]!;
      if (mark[cur] === gen && ++settled >= want && stopAt === Infinity) stopAt = dc + slack;
      const cx = cur % W, cy = (cur - cx) / W;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d]!, ny = cy + DY[d]!;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (tc[n]! < cls || closed[n] === gen) continue;
        if (d >= 4 && (tc[cy * W + nx]! < cls || tc[ny * W + cx]! < cls)) continue;
        const nd = dc + COST[d]!;
        if (nd >= dist[n]!) continue;
        dist[n] = nd; par[n] = cur;
        heap.push(n, nd);
      }
    }
    // Nodes still in the open list keep tentative distances; their parent is a settled node, so following
    // parents from them still yields a valid (near-shortest) path to the source.
    this.expansions = exp;
    f.source = source; f.cls = cls; f.version = nav.version;
  }

  /** Node sequence from `start` to the field source, or null if the field doesn't cover `start`. */
  extract(f: FlowField, start: number): number[] | null {
    if (!(f.dist[start]! < Infinity)) return null;
    const out: number[] = [];
    for (let n = start, guard = 0; n !== -1 && guard < this.nav.N; n = f.parent[n]!, guard++) out.push(n);
    return out;
  }

  /**
   * String-pull a polyline given as flat [x0, y0, x1, y1, …] (point 0 = current position). Returns the kept
   * waypoints after point 0. Consecutive grid nodes are always mutually visible, so the search per anchor
   * is exponential + binary over "how far ahead can I see".
   */
  smooth(pts: number[], r: number): Vec2[] {
    const m = pts.length >> 1;
    const out: Vec2[] = [];
    if (m < 2) return out;
    const nav = this.nav;
    const los = (a: number, b: number): boolean => nav.segmentClear(pts[2 * a]!, pts[2 * a + 1]!, pts[2 * b]!, pts[2 * b + 1]!, r);
    let a = 0;
    while (a < m - 1) {
      let j: number;
      if (a + 1 === m - 1 || los(a, m - 1)) j = m - 1;
      else {
        let lo = a + 1, hi = m - 1, step = 1;
        for (;;) {
          const probe = lo + step;
          if (probe >= hi) break;
          if (los(a, probe)) { lo = probe; step *= 2; } else { hi = probe; break; }
        }
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (los(a, mid)) lo = mid; else hi = mid;
        }
        j = lo;
      }
      out.push({ x: pts[2 * j]!, y: pts[2 * j + 1]! });
      a = j;
    }
    return out;
  }
}

function octile(x: number, y: number, gx: number, gy: number): number {
  const dx = x > gx ? x - gx : gx - x, dy = y > gy ? y - gy : gy - y;
  return dx < dy ? dy + (SQRT2 - 1) * dx : dx + (SQRT2 - 1) * dy;
}
