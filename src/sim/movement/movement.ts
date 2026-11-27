/**
 * [movement] MovementService implementation and the 'movement' system (order 30).
 *
 * Per request (moveTo / moveToEntity): a straight capsule line-of-sight shortcut, otherwise a queued path
 * request served under a per-tick work budget (units walk straight at their goal while waiting). Queued
 * requests from the same group command share one Dijkstra field once ≥ GROUP_FIELD_MIN are waiting.
 * Unreachable goals are retargeted to the closest reachable node of the unit's region.
 *
 * Per tick: serve the queue → desired velocities (waypoint following, look-ahead skipping, arrival slowdown,
 * turn-rate limited facing) → integrate → 2 × (unit-unit overlap resolution, wall resolution) → write back,
 * arrival / give-up / stuck bookkeeping → rebuild the spatial index.
 *
 * Collision rules: ground units collide with ground, air with air (mildly). Workers in a gather phase
 * "ghost" (no unit collisions) so mining traffic never jams. Idle friends step sideways out of the lane of a
 * unit passing through; units near their destination never shove — touching a stationary friend near the
 * goal (or one that arrived at nearly the same goal) means "arrived", so groups settle instead of jostling.
 * Holding/attacking/building units are heavy, movers slide around them; head-on movers keep right.
 */
import { angleDiff, turnToward } from '../../core/math';
import type { Entity, EntityId, MoverState, TilePos, Vec2 } from '../../core/types';
import type { MovementService } from '../services';
import type { World } from '../World';
import * as K from './constants';
import { computeFormation } from './formation';
import { NavGrid, sizeClass } from './navgrid';
import { Pathfinder, type FlowField } from './pathfinder';

const MODE_NONE = 0, MODE_POINT = 1, MODE_ENTITY = 2;
const ANCHOR_ACTIVITIES: ReadonlySet<string> = new Set(['attacking', 'building', 'gathering', 'casting', 'healing']);
const ARRIVE_EPS = 0.1;

/** Per-unit movement state (entity.ext.movement). A class so every unit shares one hidden shape. */
export class MoveExt {
  mode = MODE_NONE;
  /** Requested point (point mode) — repeated moveTo calls compare against it. */
  reqX = 0; reqY = 0;
  /** Effective goal the unit steers to (closest reachable point / approach point / target position). */
  gx = 0; gy = 0;
  arrive = K.DEFAULT_ARRIVE;
  targetId: EntityId = -1;
  range = 0;
  targetIsUnit = false;
  cls = 1;
  /** Request generation: queued requests carrying an older generation are discarded. */
  gen = 0;
  pending = false;
  hasPath = false;
  /** Following a unit target in a straight line (path[0] tracks the target). */
  direct = false;
  unreachable = false;
  gaveUp = false;
  /** Target position the current path was planned for (moving-target drift). */
  ptx = 0; pty = 0;
  groupId = 0; groupR = 0;
  pendGroup = 0; pendSX = 0; pendSY = 0;
  lastGX = 0; lastGY = 0; lastGoalT = -1e9;
  ancX = 0; ancY = 0; ancT = 0;
  repathT = -1e9;
  endT = 0;
  arrT = -1e9; arrX = 0; arrY = 0;
  /** Path bounding box (incl. start) for invalidation when footprints change. */
  bx0 = 0; by0 = 0; bx1 = 0; by1 = 0;
}

function extOf(e: Entity): MoveExt {
  let x = e.ext.movement as MoveExt | undefined;
  if (!x) { x = new MoveExt(); e.ext.movement = x; }
  return x;
}

/** Workers ignore unit collisions while mining (classic "worker ghosting"). */
export function isGhosting(e: Entity): boolean {
  const g = e.gatherer;
  if (!g) return false;
  const p = g.phase;
  if (p !== 'toNode' && p !== 'gathering' && p !== 'toDropoff' && p !== 'waiting') return false;
  const o = e.orders[0];
  return !o || o.type === 'gather' || o.type === 'returnCargo';
}

/** Wrap to [-π, π) so facings never grow unbounded (renderer lerps along the shortest arc). */
function wrapAngle(a: number): number {
  if (a >= -Math.PI && a < Math.PI) return a;
  const t = Math.PI * 2;
  return ((((a + Math.PI) % t) + t) % t) - Math.PI;
}

function pointRectDist(px: number, py: number, rx: number, ry: number, rw: number, rh: number): number {
  const dx = px < rx ? rx - px : px > rx + rw ? px - rx - rw : 0;
  const dy = py < ry ? ry - py : py > ry + rh ? py - ry - rh : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

interface GroupRec { id: number; cx: number; cy: number; radius: number; time: number }

export interface MovementStats {
  /** A* searches, field-served paths, straight-line shortcuts, Dijkstra fields built. */
  astar: number; fieldPaths: number; direct: number; fields: number;
  /** Total planning work charged; work in the last tick; longest queue seen. */
  work: number; lastTickWork: number; maxQueue: number;
}

export class MovementController implements MovementService {
  readonly nav: NavGrid;
  readonly pf: Pathfinder;
  readonly stats: MovementStats = { astar: 0, fieldPaths: 0, direct: 0, fields: 0, work: 0, lastTickWork: 0, maxQueue: 0 };

  private qIds: number[] = [];
  private qGens: number[] = [];
  private qHead = 0;
  private readonly groups = new Map<number, GroupRec>();
  private groupSeq = 0;
  private readonly pool: FlowField[] = [];
  private tickNo = 0;
  private cost = 0;
  private readonly ptsBuf: number[] = [];
  private readonly targetsBuf: number[] = [];
  private readonly tmpP: Vec2 = { x: 0, y: 0 };
  private readonly tmpC: Vec2 = { x: 0, y: 0 };

  // ── per-tick dense unit arrays ──
  private cap = 0;
  private count = 0;
  private ents: Entity[] = [];
  private px = new Float64Array(0); private py = new Float64Array(0);
  private nx = new Float64Array(0); private ny = new Float64Array(0);
  private vx = new Float64Array(0); private vy = new Float64Array(0);
  private rad = new Float64Array(0); private mass = new Float64Array(0);
  private want = new Float64Array(0); private distGoal = new Float64Array(0); private aimD = new Float64Array(0);
  private lgx = new Float64Array(0); private lgy = new Float64Array(0);
  private team = new Int32Array(0);
  private air = new Uint8Array(0); private ghost = new Uint8Array(0); private mov = new Uint8Array(0);
  private pass = new Uint8Array(0); private anch = new Uint8Array(0); private bump = new Uint8Array(0);
  private wallHit = new Uint8Array(0); private lgOk = new Uint8Array(0); private finalWp = new Uint8Array(0);
  private maxR = 0.5;
  // neighbour grid
  private gHead = new Int32Array(0); private gNext = new Int32Array(0); private gCell = new Int32Array(0);
  private gCols = 1; private gRows = 1; private gCs = 3;

  constructor(private readonly world: World) {
    this.nav = new NavGrid(world.map);
    this.pf = new Pathfinder(this.nav);
  }

  // ═════════════════════════ MovementService ═════════════════════════

  moveTo(e: Entity, target: Vec2, opts?: { arriveDistance?: number }): void {
    const m = e.mover;
    if (!m || !e.alive || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return;
    const x = extOf(e);
    const W = this.nav.W, H = this.nav.H;
    const tx = Math.min(W - 0.05, Math.max(0.05, target.x)), ty = Math.min(H - 0.05, Math.max(0.05, target.y));
    const ad = Math.max(0.02, opts?.arriveDistance ?? K.DEFAULT_ARRIVE);
    if (x.mode === MODE_POINT && Math.abs(tx - x.reqX) < K.SAME_TARGET && Math.abs(ty - x.reqY) < K.SAME_TARGET) {
      x.arrive = ad;
      if (m.moving) return;
      const ax = e.pos.x - x.arrX, ay = e.pos.y - x.arrY;
      if (m.arrived && ax * ax + ay * ay < K.REARRIVE_R * K.REARRIVE_R) return;
    }
    x.mode = MODE_POINT;
    x.reqX = tx; x.reqY = ty; x.gx = tx; x.gy = ty; x.arrive = ad;
    x.targetId = -1; x.targetIsUnit = false;
    x.groupId = 0; x.groupR = 0;
    if (x.pendGroup !== 0 && Math.abs(target.x - x.pendSX) < 1e-3 && Math.abs(target.y - x.pendSY) < 1e-3) {
      const g = this.groups.get(x.pendGroup);
      if (g) { x.groupId = g.id; x.groupR = g.radius; }
    }
    x.pendGroup = 0;
    this.begin(e, m, x);
    const dx = tx - e.pos.x, dy = ty - e.pos.y;
    if (dx * dx + dy * dy <= ad * ad) { this.arriveNow(e, m, x); return; }
    this.requestPath(e, m, x);
  }

  moveToEntity(e: Entity, target: Entity, range: number): void {
    const m = e.mover;
    if (!m || !e.alive) return;
    if (!target || !target.alive || target.id === e.id) { this.stop(e); return; }
    const x = extOf(e);
    const rng = Number.isFinite(range) && range > 0 ? range : 0;
    if (x.mode === MODE_ENTITY && x.targetId === target.id) {
      x.range = rng;
      if (m.moving) return;
    }
    x.mode = MODE_ENTITY;
    x.targetId = target.id; x.range = rng; x.targetIsUnit = target.kind === 'unit';
    x.groupId = 0; x.groupR = 0; x.pendGroup = 0;
    x.gx = target.pos.x; x.gy = target.pos.y;
    this.begin(e, m, x);
    if (this.world.edgeDistance(e, target) <= rng) { this.arriveNow(e, m, x); return; }
    this.updateEntityGoal(e, m, x, target);
    this.requestPath(e, m, x);
  }

  stop(e: Entity): void {
    const m = e.mover;
    if (!m) return;
    const wasMoving = m.moving;
    m.goal = null;
    if (m.path.length) m.path = [];
    m.moving = false; m.arrived = true; m.blockedTime = 0;
    m.vel.x = 0; m.vel.y = 0;
    const x = e.ext.movement as MoveExt | undefined;
    if (!x) return;
    x.mode = MODE_NONE; x.gen++; x.pending = false; x.hasPath = false; x.direct = false; x.groupId = 0;
    if (wasMoving) x.lastGoalT = -1e9; // interrupted mid-way: not "arrived at" anything
  }

  hasArrived(e: Entity): boolean { return e.mover ? e.mover.arrived : true; }

  groupTargets(units: Entity[], target: Vec2): Vec2[] {
    const live = units.filter((u) => !!u);
    if (live.length === 0) return [];
    if (live.length === 1) return [{ x: target.x, y: target.y }];
    const f = computeFormation(this.nav, live, target);
    const gid = ++this.groupSeq;
    this.groups.set(gid, { id: gid, cx: f.center.x, cy: f.center.y, radius: f.radius, time: this.world.time });
    if (this.groups.size > 48) {
      for (const [id, g] of this.groups) {
        if (this.groups.size <= 32 && this.world.time - g.time < 60) break;
        this.groups.delete(id);
      }
    }
    for (let i = 0; i < live.length; i++) {
      const u = live[i]!, s = f.slots[i]!;
      if (!u.mover) continue;
      const x = extOf(u);
      x.pendGroup = gid; x.pendSX = s.x; x.pendSY = s.y;
    }
    // World indexes the result by the original array's positions
    if (live.length === units.length) return f.slots;
    let k = 0;
    return units.map((u) => (u ? f.slots[k++]! : { x: target.x, y: target.y }));
  }

  findPath(from: Vec2, to: Vec2, radius: number): Vec2[] | null {
    const nav = this.nav;
    if (!Number.isFinite(from.x + from.y + to.x + to.y)) return null;
    const cls = sizeClass(radius);
    const r = Math.max(0, radius - 0.06);
    const start = this.startNode(from.x, from.y, cls);
    if (start < 0) return null;
    const lab = nav.labelsFor(cls), comp = lab[start]!;
    let goal = nav.nodeAt(to.x, to.y, cls);
    if (nav.tc[goal]! < cls || lab[goal] !== comp) {
      goal = nav.nearestNode(to.x, to.y, cls, 1.0, lab, comp);
      if (goal < 0) return null;
    }
    if (nav.segmentClear(from.x, from.y, to.x, to.y, r)) return [{ x: to.x, y: to.y }];
    const nodes = this.pf.astar(start, goal, cls);
    if (!this.pf.lastFound) return null;
    const pts: number[] = [from.x, from.y];
    for (const n of nodes) pts.push(nav.centerX(n, cls), nav.centerY(n, cls));
    const lx = pts[pts.length - 2]!, ly = pts[pts.length - 1]!;
    if (nav.segmentClear(lx, ly, to.x, to.y, r)) pts.push(to.x, to.y);
    const path = this.pf.smooth(pts, this.smoothRadius(radius, cls));
    return path.length ? path : [{ x: lx, y: ly }];
  }

  isWalkable(p: Vec2): boolean { return this.nav.isWalkablePoint(p.x, p.y); }

  nearestWalkable(p: Vec2, maxRadius = 8): Vec2 | null {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (this.nav.isWalkablePoint(p.x, p.y)) return { x: p.x, y: p.y };
    const n = this.nav.nearestNode(p.x, p.y, 1, maxRadius);
    return n >= 0 ? { x: this.nav.centerX(n, 1), y: this.nav.centerY(n, 1) } : null;
  }

  setFootprintBlocked(tile: TilePos, w: number, h: number, blocked: boolean): void {
    if (!this.nav.setFootprint(tile.x, tile.y, w, h, blocked)) return;
    this.onNavChanged(tile.x, tile.y, w, h, blocked);
  }

  isFootprintFree(tile: TilePos, w: number, h: number, ignore: EntityId[] = []): boolean {
    for (let y = tile.y; y < tile.y + h; y++) for (let x = tile.x; x < tile.x + w; x++) if (this.nav.isBlockedTile(x, y)) return false;
    const c = { x: tile.x + w / 2, y: tile.y + h / 2 };
    const hits = this.world.spatial.queryRadius(c, Math.hypot(w, h) / 2 + 2.2, (u) => u.kind === 'unit' && !!u.mover && !u.mover.flying);
    for (const u of hits) {
      if (ignore.includes(u.id)) continue;
      if (pointRectDist(u.pos.x, u.pos.y, tile.x, tile.y, w, h) < u.radius - 0.02) return false;
    }
    return true;
  }

  clearFootprint(tile: TilePos, w: number, h: number, ignore: EntityId[] = []): void {
    const c = { x: tile.x + w / 2, y: tile.y + h / 2 };
    const hits = this.world.spatial.queryRadius(c, Math.hypot(w, h) / 2 + 2.2, (u) => u.kind === 'unit' && !!u.mover && !u.mover.flying);
    for (const u of hits) {
      if (!u.alive || ignore.includes(u.id)) continue;
      if (pointRectDist(u.pos.x, u.pos.y, tile.x, tile.y, w, h) >= u.radius - 0.01) continue;
      const p = this.exitPoint(u, tile.x, tile.y, w, h);
      u.pos.x = p.x; u.pos.y = p.y;
      const m = u.mover!, x = u.ext.movement as MoveExt | undefined;
      if (m.moving && x) this.replan(u, m, x);
    }
  }

  // ═════════════════════════ requests ═════════════════════════

  private begin(e: Entity, m: MoverState, x: MoveExt): void {
    x.gen++;
    x.pending = false; x.hasPath = false; x.direct = false; x.unreachable = false; x.gaveUp = false;
    x.endT = 0;
    x.cls = sizeClass(e.radius);
    x.ancX = e.pos.x; x.ancY = e.pos.y; x.ancT = 0;
    x.repathT = this.world.time;
    m.moving = true; m.arrived = false; m.blockedTime = 0;
    if (m.path.length) m.path = [];
    m.goal = { x: x.gx, y: x.gy };
  }

  private arriveNow(e: Entity, m: MoverState, x: MoveExt, gaveUp = false): void {
    m.moving = false; m.arrived = true; m.blockedTime = 0;
    m.vel.x = 0; m.vel.y = 0;
    m.goal = null;
    if (m.path.length) m.path = [];
    x.pending = false; x.hasPath = false; x.direct = false; x.gen++; x.endT = 0;
    x.gaveUp = gaveUp;
    x.arrT = this.world.time; x.arrX = e.pos.x; x.arrY = e.pos.y;
    if (x.mode === MODE_POINT) { x.lastGX = x.gx; x.lastGY = x.gy; x.lastGoalT = this.world.time; }
  }

  private requestPath(e: Entity, m: MoverState, x: MoveExt): void {
    if (m.flying) { this.setPath(e, x, [{ x: x.gx, y: x.gy }]); x.direct = x.targetIsUnit; return; }
    if (this.tryDirect(e, x)) return;
    x.pending = true;
    this.qIds.push(e.id); this.qGens.push(x.gen);
    const ql = this.qIds.length - this.qHead;
    if (ql > this.stats.maxQueue) this.stats.maxQueue = ql;
  }

  /** Re-plan the current request (target drift, blocked, nav change). Keeps following the old path meanwhile. */
  private replan(e: Entity, m: MoverState, x: MoveExt): void {
    x.repathT = this.world.time;
    x.gen++;
    x.pending = false;
    if (x.mode === MODE_ENTITY) {
      const t = this.world.getAlive(x.targetId);
      if (!t) { this.arriveNow(e, m, x); return; }
      this.updateEntityGoal(e, m, x, t);
    }
    this.requestPath(e, m, x);
  }

  private tryDirect(e: Entity, x: MoveExt): boolean {
    const dx = x.gx - e.pos.x, dy = x.gy - e.pos.y;
    if (dx * dx + dy * dy > K.DIRECT_MAX * K.DIRECT_MAX) return false;
    if (!this.nav.segmentClear(e.pos.x, e.pos.y, x.gx, x.gy, Math.max(0, e.radius - 0.06))) return false;
    this.setPath(e, x, [{ x: x.gx, y: x.gy }]);
    x.direct = x.mode === MODE_ENTITY && x.targetIsUnit;
    this.stats.direct++;
    return true;
  }

  private setPath(e: Entity, x: MoveExt, path: Vec2[]): void {
    const m = e.mover!;
    m.path = path;
    x.hasPath = true; x.pending = false;
    if (x.mode === MODE_ENTITY && x.targetIsUnit) {
      const t = this.world.getAlive(x.targetId);
      x.ptx = t ? t.pos.x : x.gx; x.pty = t ? t.pos.y : x.gy;
    } else { x.ptx = x.gx; x.pty = x.gy; }
    let x0 = e.pos.x, x1 = e.pos.x, y0 = e.pos.y, y1 = e.pos.y;
    for (const p of path) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    x.bx0 = x0; x.bx1 = x1; x.by0 = y0; x.by1 = y1;
  }

  private startNode(x: number, y: number, cls: number): number {
    const n = this.nav.nodeAt(x, y, cls);
    if (this.nav.tc[n]! >= cls) return n;
    return this.nav.nearestNode(x, y, cls, K.START_SEARCH_R);
  }

  private smoothRadius(r: number, cls: number): number {
    return r + Math.min(0.1, Math.max(0, cls * 0.5 - r));
  }

  /** Steering goal for moveToEntity: the target itself (units) or the best reachable spot next to its footprint. */
  private updateEntityGoal(e: Entity, m: MoverState, x: MoveExt, t: Entity): void {
    if (x.targetIsUnit || m.flying) {
      if (x.targetIsUnit) { x.gx = t.pos.x; x.gy = t.pos.y; }
      else { const c = this.contactPoint(e, t, e.pos.x, e.pos.y) ?? t.pos; x.gx = c.x; x.gy = c.y; }
    } else {
      this.approachPoint(e, t, x.range, this.tmpC);
      x.gx = this.tmpC.x; x.gy = this.tmpC.y;
    }
    if (m.goal) { m.goal.x = x.gx; m.goal.y = x.gy; } else m.goal = { x: x.gx, y: x.gy };
  }

  /** Best admissible node centre next to target's footprint (close to the unit, within range + 0.75 of the edge). */
  private approachPoint(e: Entity, t: Entity, range: number, out: Vec2): void {
    const rect = this.world.footRect(t);
    if (!rect) { out.x = t.pos.x; out.y = t.pos.y; return; }
    const nav = this.nav, W = nav.W, H = nav.H, cls = sizeClass(e.radius), r = e.radius, half = cls * 0.5;
    const start = this.startNode(e.pos.x, e.pos.y, cls);
    const lab = nav.labelsFor(cls), comp = start >= 0 ? lab[start]! : 0;
    const band = range + 0.75;
    const x0 = Math.max(0, Math.floor(rect.x) - cls - 1), x1 = Math.min(W - 1, Math.ceil(rect.x + rect.w) + 1);
    const y0 = Math.max(0, Math.floor(rect.y) - cls - 1), y1 = Math.min(H - 1, Math.ceil(rect.y + rect.h) + 1);
    let best = -1, bestS = Infinity;
    for (let ny = y0; ny <= y1; ny++) {
      for (let nx = x0; nx <= x1; nx++) {
        const n = ny * W + nx;
        if (nav.tc[n]! < cls || (comp !== 0 && lab[n] !== comp)) continue;
        const cx = nx + half, cy = ny + half;
        const de = pointRectDist(cx, cy, rect.x, rect.y, rect.w, rect.h) - r;
        if (de > band) continue;
        const s = Math.hypot(cx - e.pos.x, cy - e.pos.y) + (de > 0 ? de * 1.5 : 0);
        if (s < bestS) { bestS = s; best = n; }
      }
    }
    if (best < 0) best = nav.nearestNode(t.pos.x, t.pos.y, cls, W + H, comp !== 0 ? lab : undefined, comp, e.pos.x, e.pos.y, K.UNREACHABLE_BIAS);
    if (best >= 0) { out.x = nav.centerX(best, cls); out.y = nav.centerY(best, cls); } else { out.x = t.pos.x; out.y = t.pos.y; }
  }

  /** Point just touching target's footprint on the side facing (px, py), or null for units / inside. */
  private contactPoint(e: Entity, t: Entity, px: number, py: number): Vec2 | null {
    const rect = this.world.footRect(t);
    if (!rect) return null;
    const qx = px < rect.x ? rect.x : px > rect.x + rect.w ? rect.x + rect.w : px;
    const qy = py < rect.y ? rect.y : py > rect.y + rect.h ? rect.y + rect.h : py;
    const dx = px - qx, dy = py - qy, d = Math.hypot(dx, dy);
    if (d < 1e-6) return null;
    const k = (e.mover?.flying ? 0 : Math.max(0, e.radius - 0.05)) / d;
    this.tmpP.x = qx + dx * k; this.tmpP.y = qy + dy * k;
    return this.tmpP;
  }

  // ═════════════════════════ path queue ═════════════════════════

  private processQueue(): void {
    let budget = K.PATH_BUDGET, done = 0, spent = 0;
    const ids = this.qIds, gens = this.qGens;
    while (this.qHead < ids.length && (budget > 0 || done < K.MIN_PATHS_PER_TICK)) {
      const id = ids[this.qHead]!, gen = gens[this.qHead]!;
      this.qHead++;
      const e = this.world.entities.get(id);
      if (!e || !e.alive || !e.mover) continue;
      const x = e.ext.movement as MoveExt | undefined;
      if (!x || x.gen !== gen || !x.pending || !e.mover.moving) continue;
      const c = this.computePath(e, e.mover, x);
      budget -= c; spent += c;
      done++;
    }
    if (this.qHead >= ids.length) { ids.length = 0; gens.length = 0; this.qHead = 0; }
    else if (this.qHead > 256) { ids.splice(0, this.qHead); gens.splice(0, this.qHead); this.qHead = 0; }
    this.stats.lastTickWork = spent;
    this.stats.work += spent;
  }

  /** Plan the unit's current request now. Returns the work spent. */
  private computePath(e: Entity, m: MoverState, x: MoveExt): number {
    const nav = this.nav, pf = this.pf;
    x.pending = false;
    nav.work = 0;
    this.cost = 10;
    if (x.mode === MODE_ENTITY) {
      const t = this.world.getAlive(x.targetId);
      if (!t) { this.arriveNow(e, m, x); return this.cost; }
      this.updateEntityGoal(e, m, x, t);
    }
    if (m.flying) { this.setPath(e, x, [{ x: x.gx, y: x.gy }]); return this.cost; }
    const r = e.radius;
    let cls = x.cls;
    let start = this.startNode(e.pos.x, e.pos.y, cls);
    while (start < 0 && cls > 1) { cls--; start = this.startNode(e.pos.x, e.pos.y, cls); }
    if (start < 0) { this.setPath(e, x, [{ x: x.gx, y: x.gy }]); return this.cost + nav.work; }
    const lab = nav.labelsFor(cls), comp = lab[start]!;
    const gx = x.gx, gy = x.gy;
    let goal = nav.nodeAt(gx, gy, cls);
    let unreachable = false;
    if (nav.tc[goal]! < cls || lab[goal] !== comp) {
      const near = nav.nearestNode(gx, gy, cls, 1.5, lab, comp);
      if (near >= 0) goal = near;
      else { goal = nav.nearestNode(gx, gy, cls, nav.W + nav.H, lab, comp, e.pos.x, e.pos.y, K.UNREACHABLE_BIAS); unreachable = true; }
      if (goal < 0) goal = start;
    }
    let nodes: number[] | null = x.groupId !== 0 && !unreachable ? this.groupFieldPath(e, x, start, cls, lab, comp) : null;
    if (nodes) this.stats.fieldPaths++;
    else {
      nodes = pf.astar(start, goal, cls);
      this.cost += pf.expansions;
      this.stats.astar++;
    }
    const pts = this.ptsBuf;
    pts.length = 0;
    pts.push(e.pos.x, e.pos.y);
    for (const n of nodes) pts.push(nav.centerX(n, cls), nav.centerY(n, cls));
    let fx = gx, fy = gy;
    const lx = pts[pts.length - 2]!, ly = pts[pts.length - 1]!;
    if (unreachable || !nav.segmentClear(lx, ly, gx, gy, Math.max(0, r - 0.06))) { fx = lx; fy = ly; }
    else pts.push(gx, gy);
    const path = pf.smooth(pts, this.smoothRadius(r, cls));
    if (path.length === 0) path.push({ x: fx, y: fy });
    x.unreachable = unreachable;
    if (fx !== x.gx || fy !== x.gy) {
      x.gx = fx; x.gy = fy;
      if (m.goal) { m.goal.x = fx; m.goal.y = fy; }
    }
    this.setPath(e, x, path);
    return this.cost + nav.work;
  }

  /** Path from `start` to the group centre via a shared Dijkstra field, or null if not worthwhile/possible. */
  private groupFieldPath(e: Entity, x: MoveExt, start: number, cls: number, lab: Int32Array, comp: number): number[] | null {
    const g = this.groups.get(x.groupId);
    if (!g) return null;
    const nav = this.nav;
    const key = `${g.id}:${cls}:${comp}`;
    let f: FlowField | null = null;
    for (const p of this.pool) if (p.key === key && p.version === nav.version) { f = p; break; }
    if (!f) {
      const targets = this.targetsBuf;
      targets.length = 0;
      targets.push(start);
      for (let k = this.qHead; k < this.qIds.length; k++) {
        const o = this.world.entities.get(this.qIds[k]!);
        if (!o || !o.alive || !o.mover) continue;
        const ox = o.ext.movement as MoveExt | undefined;
        if (!ox || !ox.pending || ox.gen !== this.qGens[k] || ox.groupId !== g.id || ox.cls !== cls) continue;
        const s = this.startNode(o.pos.x, o.pos.y, cls);
        if (s >= 0 && lab[s] === comp) targets.push(s);
      }
      if (targets.length < K.GROUP_FIELD_MIN) return null;
      let src = nav.nodeAt(g.cx, g.cy, cls);
      if (nav.tc[src]! < cls || lab[src] !== comp) src = nav.nearestNode(g.cx, g.cy, cls, nav.W + nav.H, lab, comp);
      if (src < 0) return null;
      f = this.acquireField(key);
      this.pf.buildField(f, src, cls, targets, K.FIELD_SLACK);
      this.cost += this.pf.expansions;
      this.stats.fields++;
    }
    f.lastUsed = this.tickNo;
    // the unit's own slot is the last leg: it must be in plain sight of the field source
    const sx = nav.centerX(f.source, cls), sy = nav.centerY(f.source, cls);
    if (!nav.segmentClear(sx, sy, x.gx, x.gy, Math.max(0, e.radius - 0.06))) return null;
    const nodes = this.pf.extract(f, start);
    if (nodes) this.cost += nodes.length;
    return nodes;
  }

  private acquireField(key: string): FlowField {
    const N = this.nav.N;
    if (this.pool.length < K.FIELD_POOL) {
      const f: FlowField = { key, version: -1, source: -1, cls: 1, dist: new Float32Array(N), parent: new Int32Array(N), lastUsed: this.tickNo };
      this.pool.push(f);
      return f;
    }
    let lru = this.pool[0]!;
    for (const p of this.pool) if (p.lastUsed < lru.lastUsed) lru = p;
    lru.key = key; lru.version = -1; lru.lastUsed = this.tickNo;
    return lru;
  }

  /** Walkability changed under a footprint: re-plan movers whose path/goal it touches. */
  private onNavChanged(tx: number, ty: number, w: number, h: number, blocked: boolean): void {
    const x0 = tx - 1.5, y0 = ty - 1.5, x1 = tx + w + 1.5, y1 = ty + h + 1.5;
    for (const e of this.world.list) {
      const m = e.mover;
      if (!e.alive || !m || !m.moving || m.flying) continue;
      const x = e.ext.movement as MoveExt | undefined;
      if (!x || x.mode === MODE_NONE) continue;
      const nearPath = !(x.bx1 < x0 || x.bx0 > x1 || x.by1 < y0 || x.by0 > y1);
      const goalNear = x.gx > x0 && x.gx < x1 && x.gy > y0 && x.gy < y1;
      if (blocked ? (nearPath || goalNear || x.pending) : (x.unreachable || goalNear)) this.replan(e, m, x);
    }
  }

  /** Nearest spot outside a newly placed footprint for a unit standing inside it. */
  private exitPoint(u: Entity, tx: number, ty: number, w: number, h: number): Vec2 {
    const nav = this.nav, r = u.radius, px = u.pos.x, py = u.pos.y, off = r + 0.05;
    const cy = Math.min(ty + h, Math.max(ty, py)), cx = Math.min(tx + w, Math.max(tx, px));
    const cands: Array<[number, number]> = [[tx - off, cy], [tx + w + off, cy], [cx, ty - off], [cx, ty + h + off]];
    cands.sort((a, b) => Math.hypot(a[0] - px, a[1] - py) - Math.hypot(b[0] - px, b[1] - py));
    for (const [qx, qy] of cands) if (nav.circleFree(qx, qy, r)) return { x: qx, y: qy };
    let n = nav.nearestNode(px, py, sizeClass(r), 12);
    if (n < 0) n = nav.nearestNode(px, py, 1, nav.W + nav.H);
    const cls = n >= 0 && nav.tc[n]! >= sizeClass(r) ? sizeClass(r) : 1;
    return n >= 0 ? { x: nav.centerX(n, cls), y: nav.centerY(n, cls) } : { x: px, y: py };
  }

  // ═════════════════════════ per-tick system ═════════════════════════

  /** The 'movement' system (order 30). */
  update(dt: number): void {
    this.tickNo++;
    this.processQueue();
    const n = this.collect();
    for (let i = 0; i < n; i++) this.steer(i, dt);
    this.buildGrid(n);
    for (let i = 0; i < n; i++) { this.nx[i] = this.px[i]! + this.vx[i]! * dt; this.ny[i] = this.py[i]! + this.vy[i]! * dt; }
    for (let it = 0; it < 2; it++) { this.collide(n); this.walls(n); }
    for (let i = 0; i < n; i++) this.finish(i, dt);
    for (let i = n; i < this.count; i++) this.ents[i] = undefined as unknown as Entity; // drop stale refs
    this.count = n;
    this.world.spatial.rebuild();
  }

  private grow(min: number): void {
    const cap = Math.max(256, min * 2, this.cap * 2);
    const f64 = (a: Float64Array) => { const b = new Float64Array(cap); b.set(a); return b; };
    const u8 = (a: Uint8Array) => { const b = new Uint8Array(cap); b.set(a); return b; };
    const i32 = (a: Int32Array) => { const b = new Int32Array(cap); b.set(a); return b; };
    this.px = f64(this.px); this.py = f64(this.py); this.nx = f64(this.nx); this.ny = f64(this.ny);
    this.vx = f64(this.vx); this.vy = f64(this.vy); this.rad = f64(this.rad); this.mass = f64(this.mass);
    this.want = f64(this.want); this.distGoal = f64(this.distGoal); this.aimD = f64(this.aimD);
    this.lgx = f64(this.lgx); this.lgy = f64(this.lgy);
    this.team = i32(this.team); this.gNext = i32(this.gNext); this.gCell = i32(this.gCell);
    this.air = u8(this.air); this.ghost = u8(this.ghost); this.mov = u8(this.mov); this.pass = u8(this.pass);
    this.anch = u8(this.anch); this.bump = u8(this.bump); this.wallHit = u8(this.wallHit); this.lgOk = u8(this.lgOk);
    this.finalWp = u8(this.finalWp);
    this.cap = cap;
  }

  private collect(): number {
    const list = this.world.list, players = this.world.players, now = this.world.time;
    let n = 0, maxR = 0.5;
    for (let k = 0; k < list.length; k++) {
      const e = list[k]!;
      const m = e.mover;
      if (!m || !e.alive) continue;
      if (n >= this.cap) this.grow(n + 1);
      this.ents[n] = e;
      this.px[n] = e.pos.x; this.py[n] = e.pos.y;
      const r = e.radius;
      this.rad[n] = r;
      if (r > maxR) maxR = r;
      this.air[n] = m.flying ? 1 : 0;
      this.ghost[n] = isGhosting(e) ? 1 : 0;
      this.team[n] = players.get(e.owner)?.team ?? -1;
      const x = e.ext.movement as MoveExt | undefined;
      if (!m.moving && x && now - x.lastGoalT < K.CHAIN_MEMORY) { this.lgOk[n] = 1; this.lgx[n] = x.lastGX; this.lgy[n] = x.lastGY; }
      else this.lgOk[n] = 0;
      const anchored = !m.moving && (!!e.combat?.holdPosition || ANCHOR_ACTIVITIES.has(e.activity));
      this.anch[n] = anchored ? 1 : 0;
      this.mass[n] = r * r * (anchored ? K.ANCHOR_MASS : 1);
      this.vx[n] = 0; this.vy[n] = 0;
      this.mov[n] = 0; this.pass[n] = 0; this.bump[n] = 0; this.wallHit[n] = 0; this.finalWp[n] = 0;
      this.aimD[n] = Infinity; this.distGoal[n] = Infinity;
      n++;
    }
    this.maxR = maxR;
    return n;
  }

  private bumpRadius(x: MoveExt, r: number): number {
    return x.groupId !== 0 ? Math.max(1.0, x.groupR * 0.8) : r + 0.7;
  }

  private turnRate(r: number): number { return K.TURN_BASE / (0.5 + r); }

  /** Desired velocity for unit i (0 for stationary units). */
  private steer(i: number, dt: number): void {
    const e = this.ents[i]!, m = e.mover!;
    if (!m.moving) return;
    const x = e.ext.movement as MoveExt | undefined;
    if (!x || x.mode === MODE_NONE) { m.moving = false; m.arrived = true; return; }
    const world = this.world;
    let t: Entity | undefined;
    if (x.mode === MODE_ENTITY) {
      t = world.getAlive(x.targetId);
      if (!t || world.edgeDistance(e, t) <= x.range) { this.arriveNow(e, m, x); return; }
      if (x.targetIsUnit) this.trackUnitTarget(e, m, x, t);
    }
    const px = this.px[i]!, py = this.py[i]!, r = this.rad[i]!;
    let ax = x.gx, ay = x.gy, final = true;
    const path = m.path;
    if (x.hasPath && path.length > 0) {
      while (path.length > 1) {
        const w0 = path[0]!;
        const dx = w0.x - px, dy = w0.y - py;
        if (dx * dx + dy * dy < K.WAYPOINT_TOL * K.WAYPOINT_TOL) path.shift(); else break;
      }
      if (path.length > 1 && !m.flying && (this.tickNo + e.id) % 4 === 0) {
        const w1 = path[1]!;
        if (this.nav.segmentClear(px, py, w1.x, w1.y, r * 0.95)) path.shift();
      }
      const w0 = path[0]!;
      ax = w0.x; ay = w0.y;
      final = path.length === 1;
      // pushed/teleported off the path (crowds, wall escape, footprint placement): re-plan if the leg is blocked
      if (!m.flying && !x.pending && (this.tickNo + e.id) % 10 === 5 && this.world.time - x.repathT > K.REPATH_COOLDOWN * 0.5
        && !this.nav.segmentClear(px, py, ax, ay, r * 0.85)) {
        this.replan(e, m, x);
      }
    }
    // last leg to a building / cache: walk into contact with its edge (stops as soon as in range)
    if (final && t && !x.targetIsUnit) {
      const c = this.contactPoint(e, t, px, py);
      if (c && (m.flying || this.nav.segmentClear(px, py, c.x, c.y, Math.max(0, r - 0.12)))) { ax = c.x; ay = c.y; }
    }
    const dx = ax - px, dy = ay - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    this.aimD[i] = d;
    this.finalWp[i] = final ? 1 : 0;
    let v = e.stats.speed;
    if (final && x.mode === MODE_POINT) {
      const slow = Math.max(0.35, v * 0.3);
      if (d < slow) v *= Math.max(0.3, d / slow);
    }
    if (d > 1e-4 && v > 0) {
      const want = Math.atan2(dy, dx);
      const diff = Math.abs(angleDiff(e.facing, want));
      if (diff > K.TURN_SLOW_START) {
        v *= diff >= K.TURN_SLOW_FULL ? K.TURN_MIN_FACTOR
          : 1 - (1 - K.TURN_MIN_FACTOR) * (diff - K.TURN_SLOW_START) / (K.TURN_SLOW_FULL - K.TURN_SLOW_START);
      }
      if (final && v * dt > d) v = d / dt;
      this.vx[i] = (dx / d) * v; this.vy[i] = (dy / d) * v;
      this.want[i] = want;
    }
    this.mov[i] = 1;
    let dg: number;
    if (x.mode === MODE_POINT) { const gdx = x.gx - px, gdy = x.gy - py; dg = Math.sqrt(gdx * gdx + gdy * gdy); }
    else dg = t ? world.edgeDistance(e, t) - x.range : 0;
    this.distGoal[i] = dg;
    this.pass[i] = dg > this.bumpRadius(x, r) ? 1 : 0;
  }

  /** moveToEntity on a unit: steer at its current position; re-plan only when it drifts from the planned spot. */
  private trackUnitTarget(e: Entity, m: MoverState, x: MoveExt, t: Entity): void {
    const tx = t.pos.x, ty = t.pos.y;
    if (x.unreachable && !x.pending) {
      // our path ends at the closest reachable spot; re-check now and then in case the target came closer
      const ddx = tx - x.ptx, ddy = ty - x.pty;
      if (ddx * ddx + ddy * ddy > 4 && this.world.time - x.repathT > 1) { x.gx = tx; x.gy = ty; this.replan(e, m, x); }
      return;
    }
    x.gx = tx; x.gy = ty;
    if (m.goal) { m.goal.x = tx; m.goal.y = ty; }
    const path = m.path;
    if (m.flying || x.direct) {
      if (path.length > 0) { const last = path[path.length - 1]!; last.x = tx; last.y = ty; }
      else { path.push({ x: tx, y: ty }); x.hasPath = true; }
      if (!m.flying && (this.tickNo + e.id) % 5 === 0 && !this.nav.segmentClear(e.pos.x, e.pos.y, tx, ty, Math.max(0, e.radius - 0.06))) {
        x.direct = false;
        this.replan(e, m, x);
      }
      return;
    }
    const ddx = tx - x.ptx, ddy = ty - x.pty;
    const d = Math.hypot(tx - e.pos.x, ty - e.pos.y);
    const thr = Math.max(1.0, 0.25 * d);
    if (ddx * ddx + ddy * ddy > thr * thr && !x.pending && this.world.time - x.repathT > 0.4) this.replan(e, m, x);
  }

  private buildGrid(n: number): void {
    const cs = Math.max(2.8, this.maxR * 2 + 0.8);
    const cols = Math.ceil(this.nav.W / cs) + 1, rows = Math.ceil(this.nav.H / cs) + 1;
    if (this.gHead.length < cols * rows) this.gHead = new Int32Array(cols * rows);
    this.gHead.fill(-1, 0, cols * rows);
    this.gCs = cs; this.gCols = cols; this.gRows = rows;
    const head = this.gHead;
    for (let i = 0; i < n; i++) {
      let cx = Math.floor(this.px[i]! / cs), cy = Math.floor(this.py[i]! / cs);
      cx = cx < 0 ? 0 : cx >= cols ? cols - 1 : cx;
      cy = cy < 0 ? 0 : cy >= rows ? rows - 1 : cy;
      const c = cy * cols + cx;
      this.gCell[i] = c; this.gNext[i] = head[c]!; head[c] = i;
    }
  }

  private collide(n: number): void {
    const cols = this.gCols, rows = this.gRows, head = this.gHead, next = this.gNext, cell = this.gCell;
    const ghost = this.ghost, air = this.air;
    for (let i = 0; i < n; i++) {
      if (ghost[i]) continue;
      const c = cell[i]!, ccx = c % cols, ccy = (c - ccx) / cols;
      const cy0 = ccy > 0 ? ccy - 1 : 0, cy1 = ccy < rows - 1 ? ccy + 1 : ccy;
      const cx0 = ccx > 0 ? ccx - 1 : 0, cx1 = ccx < cols - 1 ? ccx + 1 : ccx;
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          for (let j = head[cy * cols + cx]!; j !== -1; j = next[j]!) {
            if (j <= i || ghost[j] || air[j] !== air[i]) continue;
            this.pair(i, j);
          }
        }
      }
    }
  }

  private pair(i: number, j: number): void {
    const nx = this.nx, ny = this.ny;
    const dx = nx[j]! - nx[i]!, dy = ny[j]! - ny[i]!;
    const minD = this.rad[i]! + this.rad[j]!;
    const d2 = dx * dx + dy * dy;
    const lim = minD + K.CONTACT;
    if (d2 >= lim * lim) return;
    const friendly = this.team[i] === this.team[j];
    const movI = this.mov[i]!, movJ = this.mov[j]!;
    if (friendly && movI !== movJ) { if (movI) this.checkBump(i, j); else this.checkBump(j, i); }
    if (d2 >= minD * minD) return;
    let d = Math.sqrt(d2), ux: number, uy: number;
    if (d > 1e-6) { ux = dx / d; uy = dy / d; }
    else {
      const a = ((this.ents[i]!.id * 7919 + this.ents[j]!.id * 104729) % 6283) * 0.001;
      ux = Math.cos(a); uy = Math.sin(a); d = 0;
    }
    const overlap = minD - d;
    let mi = this.mass[i]! * (this.wallHit[i] ? K.WALL_MASS : 1);
    let mj = this.mass[j]! * (this.wallHit[j] ? K.WALL_MASS : 1);
    let yielder = -1;
    if (friendly) {
      if (this.pass[i] && !movJ && !this.anch[j]) { mj *= K.YIELD_MASS; yielder = j; }
      else if (this.pass[j] && !movI && !this.anch[i]) { mi *= K.YIELD_MASS; yielder = i; }
    }
    const wi = mj / (mi + mj), wj = 1 - wi;
    const k = this.air[i] ? overlap * K.AIR_RELAX : overlap;
    let ix = -ux * k * wi, iy = -uy * k * wi, jx = ux * k * wj, jy = uy * k * wj;
    if (yielder === j) {
      const s = this.sideOf(i, dx, dy);
      if (s) { jx += s.x * k * wj * K.LATERAL; jy += s.y * k * wj * K.LATERAL; }
    } else if (yielder === i) {
      const s = this.sideOf(j, -dx, -dy);
      if (s) { ix += s.x * k * wi * K.LATERAL; iy += s.y * k * wi * K.LATERAL; }
    }
    if (movI && wi > 0.25) {
      const s = this.slide(i, ux, uy);
      if (s) { ix += s.x * k * wi * K.SLIDE; iy += s.y * k * wi * K.SLIDE; }
    }
    if (movJ && wj > 0.25) {
      const s = this.slide(j, -ux, -uy);
      if (s) { jx += s.x * k * wj * K.SLIDE; jy += s.y * k * wj * K.SLIDE; }
    }
    nx[i] = nx[i]! + ix; ny[i] = ny[i]! + iy;
    nx[j] = nx[j]! + jx; ny[j] = ny[j]! + jy;
  }

  /** Unit vector perpendicular to mover m's heading, on the side where (rx, ry) (= other − mover) lies. */
  private sideOf(m: number, rx: number, ry: number): Vec2 | null {
    const vx = this.vx[m]!, vy = this.vy[m]!, vl = Math.hypot(vx, vy);
    if (vl < 1e-6) return null;
    const lx = -vy / vl, ly = vx / vl;
    const s = rx * lx + ry * ly >= 0 ? 1 : -1;
    this.tmpC.x = lx * s; this.tmpC.y = ly * s;
    return this.tmpC;
  }

  /** Tangential deflection for mover i blocked by something in direction (ux, uy); keeps right when head-on. */
  private slide(i: number, ux: number, uy: number): Vec2 | null {
    const vx = this.vx[i]!, vy = this.vy[i]!, vl = Math.hypot(vx, vy);
    if (vl < 1e-6) return null;
    const fx = vx / vl, fy = vy / vl;
    const ahead = fx * ux + fy * uy;
    if (ahead < 0.2) return null;
    let tx = -uy, ty = ux;
    const s = fx * tx + fy * ty;
    if (Math.abs(s) < 0.15) { tx = -fy; ty = fx; } // head-on: keep right (relative to own heading)
    else if (s < 0) { tx = -tx; ty = -ty; }
    this.tmpC.x = tx * ahead; this.tmpC.y = ty * ahead;
    return this.tmpC;
  }

  /** Moving unit i touched stationary friend j: decide whether that ends i's move. */
  private checkBump(i: number, j: number): void {
    if (this.bump[i] || this.ghost[i]) return;
    const x = this.ents[i]!.ext.movement as MoveExt | undefined;
    if (!x) return;
    if (x.mode === MODE_POINT) {
      if (this.lgOk[j]) {
        const cr = Math.max(K.CHAIN_R, x.groupR * 0.8);
        const dx = this.lgx[j]! - x.gx, dy = this.lgy[j]! - x.gy;
        if (dx * dx + dy * dy <= cr * cr) { this.bump[i] = 1; return; }
      }
      if (!this.pass[i]) this.bump[i] = 1;
    } else if (x.mode === MODE_ENTITY && x.targetIsUnit && this.distGoal[i]! <= K.ENTITY_BUMP_R) {
      this.bump[i] = 1;
    }
  }

  private walls(n: number): void {
    const p = this.tmpP, W = this.nav.W, H = this.nav.H;
    for (let i = 0; i < n; i++) {
      if (this.air[i]) {
        const x = this.nx[i]!, y = this.ny[i]!;
        this.nx[i] = x < 0.5 ? 0.5 : x > W - 0.5 ? W - 0.5 : x;
        this.ny[i] = y < 0.5 ? 0.5 : y > H - 0.5 ? H - 0.5 : y;
        continue;
      }
      p.x = this.nx[i]!; p.y = this.ny[i]!;
      if (this.nav.resolveCircle(p, this.rad[i]!)) this.wallHit[i] = 1;
      this.nx[i] = p.x; this.ny[i] = p.y;
    }
  }

  /** Write back position/velocity/facing; arrival, give-up and stuck bookkeeping. */
  private finish(i: number, dt: number): void {
    const e = this.ents[i]!, m = e.mover!;
    let nxp = this.nx[i]!, nyp = this.ny[i]!;
    if (!Number.isFinite(nxp) || !Number.isFinite(nyp)) { nxp = this.px[i]!; nyp = this.py[i]!; }
    e.pos.x = nxp; e.pos.y = nyp;
    if (!m.moving) {
      if (m.vel.x !== 0 || m.vel.y !== 0) { m.vel.x = 0; m.vel.y = 0; }
      return;
    }
    m.vel.x = (nxp - this.px[i]!) / dt; m.vel.y = (nyp - this.py[i]!) / dt;
    if (this.vx[i] !== 0 || this.vy[i] !== 0) e.facing = wrapAngle(turnToward(e.facing, this.want[i]!, this.turnRate(this.rad[i]!) * dt));
    const x = e.ext.movement as MoveExt | undefined;
    if (!x) return;
    if (x.mode === MODE_POINT) {
      const gdx = x.gx - nxp, gdy = x.gy - nyp, rdx = x.reqX - nxp, rdy = x.reqY - nyp;
      const a2 = x.arrive * x.arrive, ag = Math.max(x.arrive, ARRIVE_EPS);
      if (gdx * gdx + gdy * gdy <= ag * ag || rdx * rdx + rdy * rdy <= a2 || this.bump[i]) { this.arriveNow(e, m, x); return; }
    } else {
      const t = this.world.getAlive(x.targetId);
      if (!t || this.world.edgeDistance(e, t) <= x.range || this.bump[i]) { this.arriveNow(e, m, x); return; }
    }
    // reached the end of the path without being there (unreachable / no approach spot in range)
    if (this.finalWp[i] && this.aimD[i]! < 0.15) {
      x.endT += dt;
      if (x.endT > K.END_PATIENCE) { this.arriveNow(e, m, x, true); return; }
    } else x.endT = 0;
    this.trackProgress(e, m, x, i);
  }

  private trackProgress(e: Entity, m: MoverState, x: MoveExt, i: number): void {
    x.ancT += this.world.dt;
    if (x.ancT < K.PROGRESS_WINDOW) return;
    const dx = e.pos.x - x.ancX, dy = e.pos.y - x.ancY;
    const need = e.stats.speed * x.ancT * K.PROGRESS_FRACTION;
    if (dx * dx + dy * dy < need * need) m.blockedTime += x.ancT; else m.blockedTime = 0;
    x.ancX = e.pos.x; x.ancY = e.pos.y; x.ancT = 0;
    if (m.blockedTime <= 0) return;
    const near = this.distGoal[i]! <= this.bumpRadius(x, e.radius) + 1.5;
    if (m.blockedTime >= (near ? K.GIVE_UP_NEAR : K.GIVE_UP_FAR)) { this.arriveNow(e, m, x, true); return; }
    if (m.blockedTime >= K.REPATH_BLOCKED && !m.flying && this.world.time - x.repathT > K.REPATH_COOLDOWN) this.replan(e, m, x);
  }

  // ═════════════════════════ debug / tests ═════════════════════════

  /** Number of queued (not yet served) path requests. */
  queueLength(): number { return this.qIds.length - this.qHead; }
}
