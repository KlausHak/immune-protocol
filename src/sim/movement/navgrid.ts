/**
 * [movement] Navigation grid.
 *
 *  - `blocked`: static map blocking (water, cliffs, doodads, border) + dynamic footprints (buildings,
 *    Supply Caches) — footprints are reference counted so overlapping stamps can't corrupt the grid.
 *  - Size classes: a ground unit of radius r occupies an s×s tile square, s = ceil(2r) (1..MAX_CLASS).
 *    Node (x, y) of class s means "unit centre at (x + s/2, y + s/2)": class 1 nodes are tile centres,
 *    class 2 nodes tile corners, … A node is admissible when the s×s block whose top-left tile is (x, y)
 *    is in bounds and free, i.e. its "true clearance" `tc` ≥ s (Harabor's annotated-A* clearance). This
 *    makes "never squeeze through a gap narrower than yourself" exact at tile resolution.
 *    Diagonal steps also need both orthogonal neighbours admissible (no corner cutting), so connectivity
 *    is plain 4-connectivity; components are labelled lazily per class and reused until the grid changes.
 *  - `cheb`: Chebyshev distance (tiles) to the nearest blocked tile, used to skip work in open terrain.
 *  - Exact capsule line-of-sight (`segmentClear`) and circle-vs-wall resolution (`resolveCircle`).
 *
 * All hot paths use preallocated typed arrays; nothing here allocates per call except result objects.
 */
import type { MapData, Vec2 } from '../../core/types';

export const MAX_CLASS = 4;
const CHEB_CAP = 15;
/** Walls push circles out to (r - SKIN/2); contact is detected below (r - SKIN). Keeps "touching" stable and
 *  makes world.edgeDistance(unit, building) read exactly 0 for a unit pressed against a footprint. */
export const SKIN = 1e-4;

/** Size class for a unit radius (s×s tiles, s = ceil(diameter)). */
export function sizeClass(radius: number): number {
  const s = Math.ceil(radius * 2 - 1e-6);
  return s < 1 ? 1 : s > MAX_CLASS ? MAX_CLASS : s;
}

export class NavGrid {
  readonly W: number;
  readonly H: number;
  readonly N: number;
  /** 1 = blocked for ground units (static or footprint). */
  readonly blocked: Uint8Array;
  /** True clearance per tile (0..MAX_CLASS). */
  readonly tc: Uint8Array;
  /** Chebyshev distance to the nearest blocked tile (out of bounds counts as blocked), capped. */
  readonly cheb: Uint8Array;
  /** Increments whenever walkability changes; cached paths/fields/labels compare against it. */
  version = 0;
  /** Tile-visit counter for budgeting (callers reset/read it). */
  work = 0;

  private readonly staticBlocked: Uint8Array;
  private readonly dyn: Uint16Array;
  private readonly labels: Int32Array[] = [];
  private readonly labelVersion: number[] = [];
  private readonly stack: Int32Array;
  private readonly stamp: Uint32Array;
  private gen = 0;

  constructor(map: MapData) {
    this.W = map.width;
    this.H = map.height;
    this.N = this.W * this.H;
    this.staticBlocked = new Uint8Array(this.N);
    for (let i = 0; i < this.N; i++) this.staticBlocked[i] = map.blocked[i] ? 1 : 0;
    this.blocked = new Uint8Array(this.staticBlocked);
    this.dyn = new Uint16Array(this.N);
    this.tc = new Uint8Array(this.N);
    this.cheb = new Uint8Array(this.N);
    this.stack = new Int32Array(this.N);
    this.stamp = new Uint32Array(this.N);
    for (let c = 0; c <= MAX_CLASS; c++) { this.labels.push(new Int32Array(0)); this.labelVersion.push(-1); }
    this.computeClearance(0, 0, this.W, this.H);
    this.computeCheb();
  }

  // ───────────────────────── walkability updates ─────────────────────────

  /** Stamp (+1) or remove (−1) a footprint. Returns true if any tile's walkability changed. */
  setFootprint(tx: number, ty: number, w: number, h: number, block: boolean): boolean {
    const x0 = Math.max(0, tx), y0 = Math.max(0, ty);
    const x1 = Math.min(this.W, tx + w), y1 = Math.min(this.H, ty + h);
    if (x0 >= x1 || y0 >= y1) return false;
    let changed = false;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * this.W + x;
        if (block) this.dyn[i]!++;
        else if (this.dyn[i]! > 0) this.dyn[i]!--;
        const b = this.staticBlocked[i] || this.dyn[i]! > 0 ? 1 : 0;
        if (b !== this.blocked[i]) { this.blocked[i] = b; changed = true; }
      }
    }
    if (!changed) return false;
    this.computeClearance(x0 - MAX_CLASS, y0 - MAX_CLASS, x1, y1);
    this.computeCheb();
    this.version++;
    return true;
  }

  /** Recompute true clearance in a region (bottom-right → top-left; tiles right/below are unaffected). */
  private computeClearance(xa: number, ya: number, xb: number, yb: number): void {
    const W = this.W, H = this.H, tc = this.tc, bl = this.blocked;
    xa = Math.max(0, xa); ya = Math.max(0, ya); xb = Math.min(W, xb); yb = Math.min(H, yb);
    for (let y = yb - 1; y >= ya; y--) {
      for (let x = xb - 1; x >= xa; x--) {
        const i = y * W + x;
        if (bl[i]) { tc[i] = 0; continue; }
        const r = x + 1 < W ? tc[i + 1]! : 0;
        const d = y + 1 < H ? tc[i + W]! : 0;
        const dd = x + 1 < W && y + 1 < H ? tc[i + W + 1]! : 0;
        let m = r < d ? r : d;
        if (dd < m) m = dd;
        tc[i] = m + 1 > MAX_CLASS ? MAX_CLASS : m + 1;
      }
    }
  }

  /** Two-pass chamfer Chebyshev distance transform (exact for the chessboard metric). ~0.05 ms. */
  private computeCheb(): void {
    const W = this.W, H = this.H, c = this.cheb, bl = this.blocked;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (bl[i]) { c[i] = 0; continue; }
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { c[i] = 1; continue; }
        let m = CHEB_CAP;
        let v = c[i - 1]! + 1; if (v < m) m = v;
        v = c[i - W]! + 1; if (v < m) m = v;
        v = c[i - W - 1]! + 1; if (v < m) m = v;
        v = c[i - W + 1]! + 1; if (v < m) m = v;
        c[i] = m;
      }
    }
    for (let y = H - 2; y >= 1; y--) {
      for (let x = W - 2; x >= 1; x--) {
        const i = y * W + x;
        let m = c[i]!;
        if (m === 0) continue;
        let v = c[i + 1]! + 1; if (v < m) m = v;
        v = c[i + W]! + 1; if (v < m) m = v;
        v = c[i + W + 1]! + 1; if (v < m) m = v;
        v = c[i + W - 1]! + 1; if (v < m) m = v;
        c[i] = m;
      }
    }
  }

  /** Connected-component labels (4-connected admissible nodes) for a class; 0 = not admissible. */
  labelsFor(cls: number): Int32Array {
    if (this.labelVersion[cls] === this.version) return this.labels[cls]!;
    let lab = this.labels[cls]!;
    if (lab.length !== this.N) { lab = new Int32Array(this.N); this.labels[cls] = lab; } else lab.fill(0);
    const W = this.W, N = this.N, tc = this.tc, st = this.stack;
    let id = 0;
    for (let s = 0; s < N; s++) {
      if (lab[s] !== 0 || tc[s]! < cls) continue;
      id++;
      let sp = 0;
      st[sp++] = s; lab[s] = id;
      while (sp > 0) {
        const i = st[--sp]!;
        const x = i % W;
        let j = i - 1; if (x > 0 && lab[j] === 0 && tc[j]! >= cls) { lab[j] = id; st[sp++] = j; }
        j = i + 1; if (x < W - 1 && lab[j] === 0 && tc[j]! >= cls) { lab[j] = id; st[sp++] = j; }
        j = i - W; if (j >= 0 && lab[j] === 0 && tc[j]! >= cls) { lab[j] = id; st[sp++] = j; }
        j = i + W; if (j < N && lab[j] === 0 && tc[j]! >= cls) { lab[j] = id; st[sp++] = j; }
      }
    }
    this.labelVersion[cls] = this.version;
    return lab;
  }

  // ───────────────────────── node helpers ─────────────────────────

  isBlockedTile(tx: number, ty: number): boolean {
    return tx < 0 || ty < 0 || tx >= this.W || ty >= this.H || this.blocked[ty * this.W + tx] === 1;
  }
  isWalkablePoint(x: number, y: number): boolean {
    return !this.isBlockedTile(Math.floor(x), Math.floor(y));
  }
  nodeX(x: number, cls: number): number {
    const n = Math.floor(x - cls * 0.5 + 0.5);
    return n < 0 ? 0 : n >= this.W ? this.W - 1 : n;
  }
  nodeY(y: number, cls: number): number {
    const n = Math.floor(y - cls * 0.5 + 0.5);
    return n < 0 ? 0 : n >= this.H ? this.H - 1 : n;
  }
  /** Node whose centre is nearest (x, y) for a class (may be inadmissible). */
  nodeAt(x: number, y: number, cls: number): number { return this.nodeY(y, cls) * this.W + this.nodeX(x, cls); }
  centerX(node: number, cls: number): number { return (node % this.W) + cls * 0.5; }
  centerY(node: number, cls: number): number { return Math.floor(node / this.W) + cls * 0.5; }
  admissible(node: number, cls: number): boolean { return this.tc[node]! >= cls; }

  /**
   * Nearest admissible node (by Euclidean distance between its centre and (x, y)) within maxR world units,
   * optionally restricted to component `comp` of `lab`. With `biasW` > 0 the score becomes
   * dist(node, (x, y)) + biasW · dist(node, (bx, by)), so near-ties go to the side of (bx, by) (e.g. the near
   * shore of a lake). Ring search; returns -1 if none.
   */
  nearestNode(x: number, y: number, cls: number, maxR: number, lab?: Int32Array, comp = 0, bx = 0, by = 0, biasW = 0): number {
    const W = this.W, H = this.H, tc = this.tc, half = cls * 0.5;
    const cx = this.nodeX(x, cls), cy = this.nodeY(y, cls);
    const maxK = Math.min(Math.max(W, H), Math.ceil(maxR) + 1);
    const lim2 = (maxR + 0.75) * (maxR + 0.75);
    let best = -1, bestS = Infinity;
    for (let k = 0; k <= maxK; k++) {
      if (best >= 0 && k - 1 > bestS) break; // every node on ring k is ≥ k−1 from (x, y)
      const y0 = cy - k, y1 = cy + k, x0 = cx - k, x1 = cx + k;
      for (let ny = y0; ny <= y1; ny++) {
        if (ny < 0 || ny >= H) continue;
        const full = ny === y0 || ny === y1;
        for (let nx = x0; nx <= x1; nx = full || nx === x1 ? nx + 1 : x1) {
          if (nx < 0 || nx >= W) continue;
          const n = ny * W + nx;
          this.work++;
          if (tc[n]! < cls || (lab && lab[n] !== comp)) continue;
          const dx = nx + half - x, dy = ny + half - y;
          const d2 = dx * dx + dy * dy;
          if (d2 > lim2) continue;
          let s = Math.sqrt(d2);
          if (biasW > 0) s += biasW * Math.hypot(nx + half - bx, ny + half - by);
          if (s < bestS) { bestS = s; best = n; }
        }
      }
    }
    return best;
  }

  /** True if no blocked tile (or map edge) is closer than r to the point. */
  circleFree(x: number, y: number, r: number): boolean {
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r), y0 = Math.floor(y - r), y1 = Math.floor(y + r);
    const lim = r - SKIN, lim2 = lim * lim;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!this.isBlockedTile(tx, ty)) continue;
        const cx = x < tx ? tx : x > tx + 1 ? tx + 1 : x;
        const cy = y < ty ? ty : y > ty + 1 ? ty + 1 : y;
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < lim2) return false;
      }
    }
    return true;
  }

  /**
   * Push a circle out of blocked tiles (slide along walls). Mutates `p`. Returns true on contact.
   * If the centre ends up inside a blocked tile it leaves through the nearest open face, or jumps to the
   * nearest free tile when buried (e.g. a footprint placed on top of it).
   */
  resolveCircle(p: Vec2, r: number): boolean {
    let hit = false;
    const target = r - SKIN * 0.5, trig = r - SKIN, trig2 = trig * trig;
    for (let iter = 0; iter < 4; iter++) {
      const tx0 = Math.floor(p.x), ty0 = Math.floor(p.y);
      if (tx0 >= 0 && ty0 >= 0 && tx0 < this.W && ty0 < this.H && this.cheb[ty0 * this.W + tx0]! > Math.ceil(r) + 1) return hit;
      let moved = false;
      const x0 = Math.floor(p.x - r), x1 = Math.floor(p.x + r), y0 = Math.floor(p.y - r), y1 = Math.floor(p.y + r);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (!this.isBlockedTile(tx, ty)) continue;
          const cx = p.x < tx ? tx : p.x > tx + 1 ? tx + 1 : p.x;
          const cy = p.y < ty ? ty : p.y > ty + 1 ? ty + 1 : p.y;
          const dx = p.x - cx, dy = p.y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= trig2) continue;
          hit = moved = true;
          if (d2 > 1e-12) {
            const d = Math.sqrt(d2), k = (target - d) / d;
            p.x += dx * k; p.y += dy * k;
          } else {
            this.escapeTile(p, tx, ty, target);
          }
        }
      }
      if (!moved) break;
    }
    return hit;
  }

  /** Centre is inside blocked tile (tx, ty): leave through the closest face that opens onto a free tile. */
  private escapeTile(p: Vec2, tx: number, ty: number, target: number): void {
    let best = Infinity, nx = p.x, ny = p.y;
    const fl = p.x - tx, fr = tx + 1 - p.x, ft = p.y - ty, fb = ty + 1 - p.y;
    if (fl < best && !this.isBlockedTile(tx - 1, ty)) { best = fl; nx = tx - target; ny = p.y; }
    if (fr < best && !this.isBlockedTile(tx + 1, ty)) { best = fr; nx = tx + 1 + target; ny = p.y; }
    if (ft < best && !this.isBlockedTile(tx, ty - 1)) { best = ft; nx = p.x; ny = ty - target; }
    if (fb < best && !this.isBlockedTile(tx, ty + 1)) { best = fb; nx = p.x; ny = ty + 1 + target; }
    if (best === Infinity) {
      const n = this.nearestNode(p.x, p.y, 1, Math.max(this.W, this.H));
      if (n >= 0) { nx = this.centerX(n, 1); ny = this.centerY(n, 1); }
    }
    p.x = nx; p.y = ny;
  }

  // ───────────────────────── line of sight ─────────────────────────

  private nextGen(): number {
    if (++this.gen >= 0xfffffff0) { this.stamp.fill(0); this.gen = 1; }
    return this.gen;
  }

  /**
   * Exact capsule test: true if a circle of radius r swept from A to B touches no blocked tile (map edge
   * counts as blocked). Walks the supercover of the segment; around each visited tile, blocked tiles
   * within the ring ceil(r) are tested by exact segment–square distance (skipped via `cheb` in the open).
   */
  segmentClear(ax: number, ay: number, bx: number, by: number, r: number): boolean {
    let tx = Math.floor(ax), ty = Math.floor(ay);
    const ex = Math.floor(bx), ey = Math.floor(by);
    const K = r > 0 ? Math.ceil(r - 1e-9) : 0;
    const lim = r > 1e-6 ? r - 1e-6 : 0;
    const gen = this.nextGen();
    const dx = bx - ax, dy = by - ay;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0, stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tDX = stepX !== 0 ? Math.abs(1 / dx) : Infinity, tDY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
    let tMaxX = stepX > 0 ? (tx + 1 - ax) * tDX : stepX < 0 ? (ax - tx) * tDX : Infinity;
    let tMaxY = stepY > 0 ? (ty + 1 - ay) * tDY : stepY < 0 ? (ay - ty) * tDY : Infinity;
    let guard = Math.abs(ex - tx) + Math.abs(ey - ty) + 4;
    for (;;) {
      if (!this.visitLos(tx, ty, K, lim, ax, ay, bx, by, gen)) return false;
      if ((tx === ex && ty === ey) || --guard < 0) return true;
      if (tMaxX > 1 && tMaxY > 1) return this.visitLos(ex, ey, K, lim, ax, ay, bx, by, gen);
      if (Math.abs(tMaxX - tMaxY) < 1e-12) {
        // exactly through a tile corner: both side tiles are touched (supercover)
        if (!this.visitLos(tx + stepX, ty, K, lim, ax, ay, bx, by, gen)) return false;
        if (!this.visitLos(tx, ty + stepY, K, lim, ax, ay, bx, by, gen)) return false;
        tx += stepX; ty += stepY; tMaxX += tDX; tMaxY += tDY;
      } else if (tMaxX < tMaxY) { tx += stepX; tMaxX += tDX; } else { ty += stepY; tMaxY += tDY; }
    }
  }

  private visitLos(tx: number, ty: number, K: number, lim: number, ax: number, ay: number, bx: number, by: number, gen: number): boolean {
    const W = this.W, H = this.H;
    this.work++;
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    const i = ty * W + tx;
    if (this.blocked[i]) return false;
    if (K === 0 || this.cheb[i]! > K) return true;
    const lim2 = lim * lim, bl = this.blocked, st = this.stamp;
    for (let uy = ty - K; uy <= ty + K; uy++) {
      for (let ux = tx - K; ux <= tx + K; ux++) {
        if (ux < 0 || uy < 0 || ux >= W || uy >= H) {
          if (segSquareDist2(ax, ay, bx, by, ux, uy) < lim2) return false;
          continue;
        }
        const j = uy * W + ux;
        if (st[j] === gen) continue;
        st[j] = gen;
        if (!bl[j]) continue;
        this.work++;
        if (segSquareDist2(ax, ay, bx, by, ux, uy) < lim2) return false;
      }
    }
    return true;
  }
}

/** Squared distance from point to the unit square at (sx, sy). */
function pointSquareDist2(px: number, py: number, sx: number, sy: number): number {
  const dx = px < sx ? sx - px : px > sx + 1 ? px - sx - 1 : 0;
  const dy = py < sy ? sy - py : py > sy + 1 ? py - sy - 1 : 0;
  return dx * dx + dy * dy;
}

/** Squared distance from point to segment AB. */
function pointSegDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}

/**
 * Squared distance between segment AB and the unit square at (sx, sy), for squares the segment does not
 * cross (crossed tiles are caught by the supercover walk). For disjoint convex sets the minimum is attained
 * at a vertex of one of them.
 */
function segSquareDist2(ax: number, ay: number, bx: number, by: number, sx: number, sy: number): number {
  let best = pointSquareDist2(ax, ay, sx, sy);
  let d = pointSquareDist2(bx, by, sx, sy); if (d < best) best = d;
  d = pointSegDist2(sx, sy, ax, ay, bx, by); if (d < best) best = d;
  d = pointSegDist2(sx + 1, sy, ax, ay, bx, by); if (d < best) best = d;
  d = pointSegDist2(sx, sy + 1, ax, ay, bx, by); if (d < best) best = d;
  d = pointSegDist2(sx + 1, sy + 1, ax, ay, bx, by); if (d < best) best = d;
  return best;
}
