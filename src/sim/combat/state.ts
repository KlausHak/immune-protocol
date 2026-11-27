/**
 * [combat] Module-private per-entity state (entity.ext.combat) and small shared helpers.
 * The public, renderer-facing part lives in entity.combat (CombatState, see core/types.ts).
 */
import { DEFAULT_FLY_HEIGHT } from '../../config';
import { angleDiff, turnToward } from '../../core/math';
import type { BuildingDef, Entity, EntityId, UnitDef, Vec2, WeaponDef } from '../../core/types';
import { FIRE_ARC, HEAVY_RADIUS, IGNORE_TIME, SHOT_HEIGHT_BUILDING, TURN_RATE, TURN_RATE_HEAVY } from './constants';

export interface CombatExt {
  // ── engagement intent: refreshed every tick by order handlers / idle behaviour / turret logic ──
  /** world.tick of the last engage() call; entity.combat.targetId is cleared when this goes stale. */
  engageTick: number;
  /** world.tick on which firing at fireTargetId with fireWeapon was requested (combat system fires). */
  fireTick: number;
  fireTargetId: EntityId | null;
  fireWeapon: WeaponDef | null;
  // ── attack in progress ──
  windupTargetId: EntityId | null;
  windupWeapon: WeaponDef | null;
  // ── chasing / backing off ──
  chaseId: EntityId | null;
  chaseAt: number;
  /** world.time since which a chase made no progress while standing still (-1 = not stuck). */
  stuckSince: number;
  backoffAt: number;
  // ── automatic targeting ──
  autoTargetId: EntityId | null;
  /** attackMove / patrol: where the current automatic engagement began (leash origin). */
  leashOrigin: Vec2 | null;
  /** idle: where the unit stood when it auto-engaged; it walks back here afterwards (also the leash origin). */
  guardPos: Vec2 | null;
  returning: boolean;
  /** world.tick of the last idle-behaviour call (detects "just became idle"). */
  idleTick: number;
  /** world.time of the last near-first scan that found no threat (skip near-first for a while) */
  nearMissAt: number;
  /** the automatic target is inside our minRange dead zone and was kept only as a back-off fallback */
  tooCloseFallback: boolean;
  /** targets temporarily excluded from automatic targeting (gave up on them) */
  ignore: Array<{ id: EntityId; until: number }>;
  // ── order bookkeeping ──
  /** attackMove / patrol: travel move has been issued since the last engagement */
  moveIssued: boolean;
  moveIssuedAt: number;
  /** attack: last position where the target was visible, and whether we're hunting toward it */
  lastSeen: Vec2 | null;
  hunting: boolean;
  /** ability: world.time of the cast (-1 = not cast yet), approach bookkeeping */
  castAt: number;
  approachAt: number;
  approachTries: number;
  // ── healer ──
  healTargetId: EntityId | null;
  nextHealAt: number;
  // ── passives ──
  /** Strain Omega: ids of phages it spawned (alive count is capped) */
  brood: EntityId[];
}

function freshExt(): CombatExt {
  return {
    engageTick: -1, fireTick: -1, fireTargetId: null, fireWeapon: null,
    windupTargetId: null, windupWeapon: null,
    chaseId: null, chaseAt: -999, stuckSince: -1, backoffAt: -999,
    autoTargetId: null, leashOrigin: null, guardPos: null, returning: false, idleTick: -10, nearMissAt: -999, tooCloseFallback: false, ignore: [],
    moveIssued: false, moveIssuedAt: -1, lastSeen: null, hunting: false,
    castAt: -1, approachAt: -1, approachTries: 0,
    healTargetId: null, nextHealAt: 0,
    brood: [],
  };
}

/** Per-entity combat ext (created on first use). */
export function cx(e: Entity): CombatExt {
  const ext = e.ext as { combat?: CombatExt };
  return ext.combat ?? (ext.combat = freshExt());
}

/** Forget automatic-engagement state (new order / just became idle). */
export function resetAuto(x: CombatExt): void {
  x.autoTargetId = null;
  x.leashOrigin = null;
  x.chaseId = null;
  x.stuckSince = -1;
  x.moveIssued = false;
}

export function isIgnored(x: CombatExt, id: EntityId, now: number): boolean {
  if (x.ignore.length === 0) return false;
  for (let i = x.ignore.length - 1; i >= 0; i--) {
    const it = x.ignore[i]!;
    if (it.until <= now) { x.ignore.splice(i, 1); continue; }
    if (it.id === id) return true;
  }
  return false;
}

export function ignoreTarget(x: CombatExt, id: EntityId, now: number): void {
  const until = now + IGNORE_TIME;
  for (const it of x.ignore) if (it.id === id) { it.until = until; return; }
  if (x.ignore.length >= 6) x.ignore.shift();
  x.ignore.push({ id, until });
}

export const layerOf = (e: Entity): 'ground' | 'air' => (e.tags.has('air') ? 'air' : 'ground');

/** Key of a help-call cell (cell coords in HELP_CELL tiles) for a player. */
export const helpKey = (owner: number, hx: number, hy: number): number => (owner * 4096 + (hy + 1)) * 4096 + (hx + 1);

/** True if `e` has any weapon able to hit `target`'s layer (ignores range/visibility). */
export function canHitLayer(e: Entity, target: Entity): boolean {
  if (e.def.kind === 'resource') return false;
  const layer = layerOf(target);
  const ws = e.def.weapons;
  for (let i = 0; i < ws.length; i++) if (ws[i]!.targets.includes(layer)) return true;
  return false;
}

/**
 * Height above the ground (world units) where shots leave / hit an entity — used for Projectile
 * startHeight/endHeight: air units fly at def.flyHeight, buildings 1.5, ground units 0.5 + 0.75 × radius
 * (≈0.8 for infantry, ≈1.1 for vehicles, ≈2 for Strain Omega).
 */
export function shotHeight(e: Entity): number {
  if (e.kind !== 'unit') return SHOT_HEIGHT_BUILDING;
  if (e.tags.has('air')) return (e.def as UnitDef).flyHeight ?? DEFAULT_FLY_HEIGHT;
  return 0.5 + 0.75 * e.radius;
}

/** Radius at which a homing shot counts as having reached the entity's surface. */
export function hitRadius(e: Entity): number {
  if (e.kind === 'unit') return e.radius * 0.7;
  const fp = (e.def as BuildingDef).footprint;
  return fp ? Math.min(fp.w, fp.h) * 0.4 : e.radius * 0.7;
}

const TWO_PI = Math.PI * 2;
const normAngle = (a: number): number => {
  if (a > Math.PI || a <= -Math.PI) a -= Math.ceil((a - Math.PI) / TWO_PI) * TWO_PI;
  return a;
};

/**
 * Turn a unit toward point p (limited turn rate) and report whether it is aligned enough to fire.
 * Buildings never rotate (turret models aim via combat.targetId → aimAngle) and are always aligned.
 */
export function faceToward(e: Entity, p: Vec2, dt: number): boolean {
  if (e.kind !== 'unit') return true;
  const dx = p.x - e.pos.x, dy = p.y - e.pos.y;
  if (dx * dx + dy * dy < 1e-8) return true;
  const want = Math.atan2(dy, dx);
  const rate = e.radius >= HEAVY_RADIUS ? TURN_RATE_HEAVY : TURN_RATE;
  e.facing = normAngle(turnToward(e.facing, want, rate * dt));
  return Math.abs(angleDiff(e.facing, want)) <= FIRE_ARC;
}

/** Bonus damage of a weapon/ability bonus table against a target's tags. */
export function bonusVs(bonus: WeaponDef['bonus'], target: Entity): number {
  if (!bonus) return 0;
  let d = 0;
  for (const tag in bonus) if (target.tags.has(tag as never)) d += bonus[tag as keyof typeof bonus] ?? 0;
  return d;
}

/** Longest effective weapon range of an entity (0 if unarmed). */
export function maxWeaponRange(e: Entity): number {
  if (e.def.kind === 'resource') return 0;
  let r = 0;
  for (const w of e.def.weapons) r = Math.max(r, w.range + e.stats.rangeAdd);
  return r;
}
