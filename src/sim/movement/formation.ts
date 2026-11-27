/**
 * [movement] Group destinations (MovementService.groupTargets).
 *
 *  - Compact group travelling farther than its own size → keep the relative layout (tightened a little if
 *    loose), so the blob arrives as it left and paths don't cross.
 *  - Otherwise (scattered selection, or a short re-position) → a tight grid around the target, rows
 *    perpendicular to the travel direction; units are assigned front-to-back then left-to-right by their
 *    current positions, again so paths don't cross.
 *  - Every ground slot is snapped to a spot that fits the unit (admissible for its size class, no wall
 *    overlap), lies in the same connected region as the group centre, has a clear straight line from the
 *    centre (the last leg of a shared group path) and doesn't overlap another slot. Central slots are
 *    placed first. Air units keep their raw slots (clamped to the map).
 */
import type { Entity, Vec2 } from '../../core/types';
import { sizeClass, type NavGrid } from './navgrid';

export interface Formation {
  slots: Vec2[];
  center: Vec2;
  /** Radius of the arranged group around `center` (used for arrival tolerances). */
  radius: number;
}

/** Free space between neighbouring slots. */
const GAP = 0.22;

export function computeFormation(nav: NavGrid, units: Entity[], target: Vec2): Formation {
  const n = units.length;
  const W = nav.W, H = nav.H;
  let gx = 0, gy = 0, maxR = 0.3, anyGround = false;
  for (const u of units) {
    gx += u.pos.x; gy += u.pos.y;
    if (u.radius > maxR) maxR = u.radius;
    if (!u.mover?.flying) anyGround = true;
  }
  gx /= n; gy /= n;
  let spread = 0;
  for (const u of units) spread = Math.max(spread, Math.hypot(u.pos.x - gx, u.pos.y - gy));
  const sp = 2 * maxR + GAP;

  // ── group centre: the target, snapped into the region most ground units stand in ──
  let cx = Math.min(W - 0.5, Math.max(0.5, target.x)), cy = Math.min(H - 0.5, Math.max(0.5, target.y));
  if (anyGround) {
    const lab = nav.labelsFor(1);
    const counts = new Map<number, number>();
    let comp = 0, bestCount = 0;
    for (const u of units) {
      if (u.mover?.flying) continue;
      let s = nav.nodeAt(u.pos.x, u.pos.y, 1);
      if (lab[s] === 0) s = nav.nearestNode(u.pos.x, u.pos.y, 1, 3);
      const c = s >= 0 ? lab[s]! : 0;
      if (c === 0) continue;
      const k = (counts.get(c) ?? 0) + 1;
      counts.set(c, k);
      if (k > bestCount) { bestCount = k; comp = c; }
    }
    const cn = nav.nodeAt(cx, cy, 1);
    if (lab[cn] === 0 || (comp !== 0 && lab[cn] !== comp)) {
      const nn = nav.nearestNode(cx, cy, 1, W + H, comp !== 0 ? lab : undefined, comp, gx, gy, 0.25);
      if (nn >= 0) { cx = nav.centerX(nn, 1); cy = nav.centerY(nn, 1); }
    }
  }

  // ── layout offsets ──
  const ox = new Float64Array(n), oy = new Float64Array(n);
  let dx = cx - gx, dy = cy - gy;
  const travel = Math.hypot(dx, dy);
  if (travel > 1e-6) { dx /= travel; dy /= travel; } else { dx = 1; dy = 0; }
  const compactR = Math.max(2.5, sp * Math.sqrt(n) * 0.8);
  if (spread <= compactR && travel > spread + 2) {
    const snug = sp * Math.sqrt(n) * 0.55;
    const s = spread > snug ? Math.max(0.6, snug / spread) : 1;
    for (let i = 0; i < n; i++) { ox[i] = (units[i]!.pos.x - gx) * s; oy[i] = (units[i]!.pos.y - gy) * s; }
  } else {
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const lx = -dy, ly = dx; // lateral axis
    const fwd = (i: number) => (units[i]!.pos.x - gx) * dx + (units[i]!.pos.y - gy) * dy;
    const lat = (i: number) => (units[i]!.pos.x - gx) * lx + (units[i]!.pos.y - gy) * ly;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => fwd(b) - fwd(a) || units[a]!.id - units[b]!.id);
    for (let r = 0; r < rows; r++) {
      const row = order.slice(r * cols, (r + 1) * cols).sort((a, b) => lat(a) - lat(b) || units[a]!.id - units[b]!.id);
      const cnt = row.length;
      for (let c = 0; c < cnt; c++) {
        const i = row[c]!;
        const l = (c - (cnt - 1) / 2) * sp, f = ((rows - 1) / 2 - r) * sp;
        ox[i] = dx * f + lx * l; oy[i] = dy * f + ly * l;
      }
    }
  }

  // ── snap slots (central first) ──
  const slots: Vec2[] = new Array(n);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (ox[a]! ** 2 + oy[a]! ** 2) - (ox[b]! ** 2 + oy[b]! ** 2) || a - b);
  const placed: number[] = []; // x, y, r triples (ground only)
  const compOf = new Map<number, number>();
  const centerComp = (cls: number): number => {
    let c = compOf.get(cls);
    if (c === undefined) {
      const lab = nav.labelsFor(cls);
      let s = nav.nodeAt(cx, cy, cls);
      if (lab[s] === 0) s = nav.nearestNode(cx, cy, cls, 4);
      c = s >= 0 ? lab[s]! : 0;
      compOf.set(cls, c);
    }
    return c;
  };
  const fits = (x: number, y: number, r: number, cls: number): boolean => {
    if (x < r || y < r || x > W - r || y > H - r) return false;
    for (let k = 0; k < placed.length; k += 3) {
      const ddx = placed[k]! - x, ddy = placed[k + 1]! - y, rr = (placed[k + 2]! + r) * 0.92;
      if (ddx * ddx + ddy * ddy < rr * rr) return false;
    }
    if (!nav.circleFree(x, y, r)) return false;
    const comp = centerComp(cls);
    if (comp !== 0) {
      const node = nav.nodeAt(x, y, cls);
      const lab = nav.labelsFor(cls);
      if (lab[node] !== comp && lab[nav.nearestNode(x, y, cls, 0.8)] !== comp) return false;
    }
    return nav.segmentClear(cx, cy, x, y, Math.max(0, r - 0.06));
  };
  let radius = 0;
  for (const i of order) {
    const u = units[i]!;
    let x = cx + ox[i]!, y = cy + oy[i]!;
    if (u.mover?.flying) {
      slots[i] = { x: Math.min(W - 0.5, Math.max(0.5, x)), y: Math.min(H - 0.5, Math.max(0.5, y)) };
      continue;
    }
    const r = u.radius, cls = sizeClass(r);
    if (!fits(x, y, r, cls)) {
      let found = false;
      for (let ring = 1; ring <= 12 && !found; ring++) {
        const rad = ring * 0.45, steps = 6 * ring;
        for (let s = 0; s < steps; s++) {
          const a = (s / steps) * Math.PI * 2 + ring * 0.37;
          const qx = x + Math.cos(a) * rad, qy = y + Math.sin(a) * rad;
          if (fits(qx, qy, r, cls)) { x = qx; y = qy; found = true; break; }
        }
      }
      if (!found) { x = cx; y = cy; } // crowd onto the centre; bump-arrival sorts it out
    }
    slots[i] = { x, y };
    placed.push(x, y, r);
    radius = Math.max(radius, Math.hypot(x - cx, y - cy) + r);
  }
  return { slots, center: { x: cx, y: cy }, radius: Math.max(radius, sp) };
}
