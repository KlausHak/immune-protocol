import type { Vec2 } from './types';

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const clone = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const lenSq = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const distSq = (a: Vec2, b: Vec2): number => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };
export const normalize = (a: Vec2): Vec2 => { const l = Math.hypot(a.x, a.y); return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 }; };
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpV = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const fromAngle = (r: number, l = 1): Vec2 => ({ x: Math.cos(r) * l, y: Math.sin(r) * l });
/** Shortest signed angular difference b - a in (-PI, PI]. */
export const angleDiff = (a: number, b: number): number => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d <= -Math.PI) d += Math.PI * 2; return d; };
/** Interpolate angles along the shortest arc. */
export const lerpAngle = (a: number, b: number, t: number): number => a + angleDiff(a, b) * t;
/** Rotate angle `from` toward `to` by at most `maxStep` radians. */
export const turnToward = (from: number, to: number, maxStep: number): number => { const d = angleDiff(from, to); return Math.abs(d) <= maxStep ? to : from + Math.sign(d) * maxStep; };
/** Edge-to-edge distance between two circles. */
export const edgeDist = (a: Vec2, ra: number, b: Vec2, rb: number): number => Math.max(0, dist(a, b) - ra - rb);
export const pointInRect = (p: Vec2, r: { x: number; y: number; w: number; h: number }): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
export const rectCenter = (r: { x: number; y: number; w: number; h: number }): Vec2 => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
