/**
 * [map] Shape helpers for the MapBuilder. A Shape is a world-space region with a bounding box and an
 * inside test; painters evaluate it at TILE CENTRES (tx + 0.5, ty + 0.5). Pure math — headless-safe.
 */
import { hash01 } from '../core/rng';
import type { Vec2 } from '../core/types';

/** A point given either as a Vec2 or as a compact [x, y] tuple (map scripts use tuples a lot). */
export type P = Vec2 | readonly [number, number];
export const toV = (p: P): Vec2 => ('x' in p ? { x: p.x, y: p.y } : { x: p[0], y: p[1] });

export interface Shape {
  /** world-space bounding box: [x0, x1) × [y0, y1) */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** true if world point (x, y) lies inside */
  has(x: number, y: number): boolean;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distToPolyline(px: number, py: number, pts: readonly Vec2[]): number {
  if (pts.length === 1) return Math.hypot(px - pts[0]!.x, py - pts[0]!.y);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const d = distToSegment(px, py, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return best;
}

export function pointInPolygon(x: number, y: number, pts: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!, b = pts[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function bboxOf(pts: readonly Vec2[], pad = 0): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** Shape constructors. Rects are in tile units: rect(x, y, w, h) covers tiles x..x+w-1 × y..y+h-1. */
export const shape = {
  rect(x: number, y: number, w: number, h: number): Shape {
    return { x0: x, y0: y, x1: x + w, y1: y + h, has: (px, py) => px >= x && px < x + w && py >= y && py < y + h };
  },
  /** inclusive radius test at tile centres */
  circle(cx: number, cy: number, r: number): Shape {
    const r2 = r * r;
    return { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r, has: (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r2 };
  },
  ellipse(cx: number, cy: number, rx: number, ry: number, rot = 0): Shape {
    const c = Math.cos(rot), s = Math.sin(rot), m = Math.max(rx, ry);
    return {
      x0: cx - m, y0: cy - m, x1: cx + m, y1: cy + m,
      has: (px, py) => {
        const dx = px - cx, dy = py - cy;
        const u = dx * c + dy * s, v = -dx * s + dy * c;
        return (u / rx) ** 2 + (v / ry) ** 2 <= 1;
      },
    };
  },
  poly(points: readonly P[]): Shape {
    const pts = points.map(toV);
    return { ...bboxOf(pts), has: (px, py) => pointInPolygon(px, py, pts) };
  },
  /** capsule polyline: points within width/2 (strict) of the line. Odd widths: put the line on .5 coords. */
  line(points: readonly P[], width: number): Shape {
    const pts = points.map(toV), hw = width / 2;
    return { ...bboxOf(pts, hw), has: (px, py) => distToPolyline(px, py, pts) < hw - 1e-6 };
  },
  /** organic patch: circle whose radius wobbles with angle (deterministic from seed) */
  blob(cx: number, cy: number, r: number, seed: number, roughness = 0.35): Shape {
    const ph = [0, 1, 2, 3].map((k) => hash01(seed, 911 + k) * Math.PI * 2);
    const m = r * (1 + roughness);
    return {
      x0: cx - m, y0: cy - m, x1: cx + m, y1: cy + m,
      has: (px, py) => {
        const dx = px - cx, dy = py - cy, a = Math.atan2(dy, dx);
        const wob = 0.45 * Math.sin(2 * a + ph[0]!) + 0.3 * Math.sin(3 * a + ph[1]!) + 0.15 * Math.sin(5 * a + ph[2]!) + 0.1 * Math.sin(7 * a + ph[3]!);
        const rr = r * (1 + roughness * wob);
        return dx * dx + dy * dy <= rr * rr;
      },
    };
  },
  union(...parts: Shape[]): Shape {
    return {
      x0: Math.min(...parts.map((s) => s.x0)), y0: Math.min(...parts.map((s) => s.y0)),
      x1: Math.max(...parts.map((s) => s.x1)), y1: Math.max(...parts.map((s) => s.y1)),
      has: (px, py) => parts.some((s) => s.has(px, py)),
    };
  },
  minus(a: Shape, ...cut: Shape[]): Shape {
    return { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1, has: (px, py) => a.has(px, py) && !cut.some((s) => s.has(px, py)) };
  },
  intersect(a: Shape, b: Shape): Shape {
    return {
      x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
      has: (px, py) => a.has(px, py) && b.has(px, py),
    };
  },
};
