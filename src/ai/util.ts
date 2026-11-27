/**
 * [ai] Small pure helpers shared by the AI managers: value estimates, geometry and polyline paths.
 * Headless-safe (no DOM / three.js).
 */
import type { Cost, Entity, TilePos, Vec2, WeaponDef } from '../core/types';

export interface Rect { x: number; y: number; w: number; h: number }

/** Resource value of a cost (matter + energy). */
export const costValue = (c: Cost | undefined): number => (c?.matter ?? 0) + (c?.energy ?? 0);

export function weaponsOf(e: Entity): WeaponDef[] { return e.def.kind === 'resource' ? [] : e.def.weapons; }
export const hasWeapons = (e: Entity): boolean => weaponsOf(e).length > 0;
export const isWorkerUnit = (e: Entity): boolean => e.kind === 'unit' && (e.tags.has('worker') || !!e.gatherer);
export const isAir = (e: Entity): boolean => e.tags.has('air');
export const canHitAir = (e: Entity): boolean => weaponsOf(e).some((w) => w.targets.includes('air'));
export const canHitGround = (e: Entity): boolean => weaponsOf(e).some((w) => w.targets.includes('ground'));
export function maxRange(e: Entity): number {
  let r = 0;
  for (const w of weaponsOf(e)) r = Math.max(r, w.range);
  return r + (e.stats?.rangeAdd ?? 0);
}
export const minRangeOf = (e: Entity): number => weaponsOf(e).reduce((m, w) => Math.max(m, w.minRange ?? 0), 0);
export const isRanged = (e: Entity): boolean => maxRange(e) >= 2;
export const hpFrac = (e: Entity): number => (e.stats.maxHp > 0 ? Math.max(0, Math.min(1, e.hp / e.stats.maxHp)) : 1);

/**
 * Rough fighting strength of an entity for force comparisons: its cost scaled by remaining health.
 * Workers count a little, armed structures count extra (static defence is cost-efficient), other
 * structures don't fight.
 */
export function combatValue(e: Entity): number {
  if (!e.alive || e.def.kind === 'resource') return 0;
  const base = costValue(e.def.cost);
  const hp = hpFrac(e);
  if (e.kind === 'building') return hasWeapons(e) && !e.construction ? base * 1.6 * (0.4 + 0.6 * hp) : 0;
  if (isWorkerUnit(e)) return 12 * hp;
  if (!hasWeapons(e)) return base * 0.5 * hp; // healers & support multiply the strength of others
  return base * (0.3 + 0.7 * hp);
}

export function centroid(list: readonly { pos: Vec2 }[]): Vec2 {
  if (list.length === 0) return { x: 0, y: 0 };
  let x = 0, y = 0;
  for (const e of list) { x += e.pos.x; y += e.pos.y; }
  return { x: x / list.length, y: y / list.length };
}

export const footRect = (tile: TilePos, w: number, h: number): Rect => ({ x: tile.x, y: tile.y, w, h });
export function pointRectDist(p: Vec2, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}
export function rectRectDist(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}
export const rectsOverlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Smallest distance between segment ab and a rect (sampled; segments are short). */
export function segmentRectDist(a: Vec2, b: Vec2, r: Rect): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / 0.5));
  let best = Infinity;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    best = Math.min(best, pointRectDist({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, r));
    if (best === 0) break;
  }
  return best;
}

// ───────────────────────── polylines ─────────────────────────

export function pathLength(points: readonly Vec2[]): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return l;
}

/** Re-sample a polyline so consecutive points are at most `step` apart (keeps the original vertices). */
export function densify(points: readonly Vec2[], step: number): Vec2[] {
  if (points.length === 0) return [];
  const out: Vec2[] = [{ x: points[0]!.x, y: points[0]!.y }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** Index of the polyline point closest to p, searching [from, from + window]. */
export function closestIndex(points: readonly Vec2[], p: Vec2, from = 0, window = Infinity): number {
  let best = Math.max(0, Math.min(from, points.length - 1)), bd = Infinity;
  const end = Math.min(points.length - 1, from + window);
  for (let i = Math.max(0, from); i <= end; i++) {
    const d = (points[i]!.x - p.x) ** 2 + (points[i]!.y - p.y) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Index reached by walking `distance` forward along the polyline from index i (clamped to the end). */
export function indexAhead(points: readonly Vec2[], i: number, distance: number): number {
  let acc = 0, j = i;
  while (j < points.length - 1 && acc < distance) {
    acc += Math.hypot(points[j + 1]!.x - points[j]!.x, points[j + 1]!.y - points[j]!.y);
    j++;
  }
  return j;
}

/** Index reached by walking `distance` backwards from index i (clamped to 0). */
export function indexBehind(points: readonly Vec2[], i: number, distance: number): number {
  let acc = 0, j = i;
  while (j > 0 && acc < distance) {
    acc += Math.hypot(points[j]!.x - points[j - 1]!.x, points[j]!.y - points[j - 1]!.y);
    j--;
  }
  return j;
}

/** [save] Copy the listed own fields of an object (plain data only — the save codec deep-copies). */
export function pickFields<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k as string] = o[k];
  return out;
}
/** [save] Restore fields written by pickFields (missing keys keep their current value). */
export function assignFields<T extends object>(o: T, data: unknown, keys: readonly (keyof T)[]): void {
  if (!data || typeof data !== 'object') return;
  const d = data as Record<string, unknown>;
  for (const k of keys) if ((k as string) in d) (o as Record<string, unknown>)[k as string] = d[k as string];
}

/** "m:ss" */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
