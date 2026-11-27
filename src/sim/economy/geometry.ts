/**
 * [economy] Small rectangle/segment geometry helpers (world units; rects are footprints in tile units).
 */
import type { TilePos, Vec2 } from '../../core/types';

export interface Rect { x: number; y: number; w: number; h: number }

export const footprintRect = (tile: TilePos, w: number, h: number): Rect => ({ x: tile.x, y: tile.y, w, h });

export const expandRect = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });

/** Distance from a point to a rect (0 inside). */
export function pointRectDist(p: Vec2, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** Gap between two rects (0 when touching or overlapping). */
export function rectRectDist(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

/** True when the rect interiors intersect (touching edges do not count). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
}

/** True when a circle (centre p, radius r) overlaps the rect interior. */
export function circleOverlapsRect(p: Vec2, r: number, rect: Rect): boolean {
  return pointRectDist(p, rect) < r - 1e-6;
}

function pointSegDist(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

/** Liang–Barsky: does segment a→b touch the rect? */
function segIntersectsRect(a: Vec2, b: Vec2, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, a.x - r.x) && clip(dx, r.x + r.w - a.x) && clip(-dy, a.y - r.y) && clip(dy, r.y + r.h - a.y) && t0 <= t1;
}

/** Distance between segment a→b and a rect (0 when they intersect). */
export function segRectDist(a: Vec2, b: Vec2, r: Rect): number {
  if (segIntersectsRect(a, b, r)) return 0;
  const corners: Vec2[] = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y + r.h }];
  let d = Math.min(pointRectDist(a, r), pointRectDist(b, r));
  for (const c of corners) d = Math.min(d, pointSegDist(c, a, b));
  return d;
}

/** Closest point of a rect to p (p itself when inside). */
export function closestPointInRect(p: Vec2, r: Rect): Vec2 {
  return { x: Math.min(Math.max(p.x, r.x), r.x + r.w), y: Math.min(Math.max(p.y, r.y), r.y + r.h) };
}

/** Points along a rect's boundary, roughly `step` apart (corners included). */
export function perimeterPoints(r: Rect, step: number): Vec2[] {
  const out: Vec2[] = [];
  const nx = Math.max(1, Math.round(r.w / step)), ny = Math.max(1, Math.round(r.h / step));
  for (let i = 0; i <= nx; i++) { const x = r.x + (r.w * i) / nx; out.push({ x, y: r.y }, { x, y: r.y + r.h }); }
  for (let j = 1; j < ny; j++) { const y = r.y + (r.h * j) / ny; out.push({ x: r.x, y }, { x: r.x + r.w, y }); }
  return out;
}

/** Where a ray from `c` (inside r) in direction `dir` (unit vector) leaves the rect. */
export function rayRectExit(c: Vec2, dir: Vec2, r: Rect): Vec2 {
  const tx = dir.x > 1e-9 ? (r.x + r.w - c.x) / dir.x : dir.x < -1e-9 ? (r.x - c.x) / dir.x : Infinity;
  const ty = dir.y > 1e-9 ? (r.y + r.h - c.y) / dir.y : dir.y < -1e-9 ? (r.y - c.y) / dir.y : Infinity;
  const t = Math.max(0, Math.min(tx, ty));
  return Number.isFinite(t) ? { x: c.x + dir.x * t, y: c.y + dir.y * t } : { x: c.x, y: r.y + r.h };
}
