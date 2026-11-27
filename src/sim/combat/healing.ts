/**
 * [combat] Healers (units with def.heal, e.g. Field Medic): heal the most-damaged friendly non-structure
 * unit, in pulses of HEAL_PULSE seconds (one entityHealed event per pulse).
 *   roam — idle / attackMove / patrol: look within sight and walk into heal range (leashed like combat)
 *   stay — follow / hold: only heal what is already within heal range, never move
 */
import { dist } from '../../core/math';
import type { Entity, EntityId, UnitDef, Vec2 } from '../../core/types';
import { CHASE_REFRESH, HEAL_PULSE, LEASH_MUL, RANGE_TOLERANCE, SCAN_INTERVAL } from './constants';
import type { CombatRuntime } from './runtime';
import { cx, faceToward } from './state';

export type HealMode = 'roam' | 'stay';

/** Valid heal target: alive friendly unit (not self, not a structure) that is missing hp. */
export function canHeal(rt: CombatRuntime, healer: Entity, t: Entity): boolean {
  return t.alive && t !== healer && t.kind === 'unit' && !t.tags.has('structure')
    && rt.world.isAlly(healer.owner, t.owner) && t.hp < t.stats.maxHp - 1e-3;
}

const isHurt = (t: Entity | undefined): boolean => !!t && t.hp < t.stats.maxHp - 1e-3;

/** Most damaged (lowest hp fraction, then closest) healable unit within `radius` edge distance. */
function pickHealTarget(rt: CombatRuntime, e: Entity, radius: number, origin: Vec2 | null, preferId: EntityId | null): Entity | null {
  const w = rt.world;
  if (preferId != null) {
    const p = w.getAlive(preferId);
    if (p && canHeal(rt, e, p) && w.edgeDistance(e, p) <= radius) return p;
  }
  const leash = e.stats.sight * LEASH_MUL;
  const out = rt.scratch;
  out.length = 0;
  w.spatial.queryRadius(e.pos, radius + e.radius, undefined, out); // units only: exact without padding
  let best: Entity | null = null, bestS = Infinity;
  for (let i = 0; i < out.length; i++) {
    const o = out[i]!;
    if (o.kind !== 'unit' || !canHeal(rt, e, o)) continue;
    const d = w.edgeDistance(e, o);
    if (d > radius) continue;
    if (origin && dist(origin, o.pos) > leash) continue;
    const s = o.hp / o.stats.maxHp + d * 0.01;
    if (s < bestS) { bestS = s; best = o; }
  }
  out.length = 0;
  return best;
}

/**
 * Run healer behaviour for this tick. Returns true while busy healing (or walking to heal).
 * `origin`: leash origin for roaming (null = unrestricted). `preferId`: the unit being followed —
 * healed first whenever it needs it.
 */
export function healerTick(rt: CombatRuntime, e: Entity, mode: HealMode, origin: Vec2 | null = null, preferId: EntityId | null = null): boolean {
  const hd = e.kind === 'unit' ? (e.def as UnitDef).heal : undefined;
  if (!hd) return false;
  const w = rt.world, x = cx(e);
  const searchR = mode === 'roam' ? Math.max(hd.range, e.stats.sight) : hd.range + RANGE_TOLERANCE;
  let t = w.getAlive(x.healTargetId) ?? null;
  const lost = x.healTargetId != null && (!t || !canHeal(rt, e, t) || (mode === 'stay' && w.edgeDistance(e, t) > searchR));
  if (lost) t = null;
  // staggered re-pick: every SCAN_INTERVAL ticks when idle-handed, every 2× while treating someone,
  // immediately when the patient is lost or the followed unit gets hurt
  const phase = (w.tick + e.id) % (t ? SCAN_INTERVAL * 2 : SCAN_INTERVAL) === 0;
  const preferHurt = preferId != null && (!t || t.id !== preferId) && isHurt(w.getAlive(preferId));
  if (lost || phase || preferHurt) {
    t = pickHealTarget(rt, e, searchR, mode === 'roam' ? origin : null, preferId) ?? t;
  }
  // leashed roaming: don't wander after patients once far from where we started
  if (t && mode === 'roam' && origin && dist(e.pos, origin) > e.stats.sight * LEASH_MUL && w.edgeDistance(e, t) > hd.range) t = null;
  x.healTargetId = t ? t.id : null;
  if (!t) return false;
  return healStep(rt, e, t, mode === 'roam');
}

/** Move into heal range of `t` (if allowed) and heal it in pulses. False if out of range and can't move. */
export function healStep(rt: CombatRuntime, e: Entity, t: Entity, mayMove: boolean): boolean {
  const hd = (e.def as UnitDef).heal;
  if (!hd) return false;
  const w = rt.world, x = cx(e);
  const d = w.edgeDistance(e, t);
  if (d > hd.range + RANGE_TOLERANCE) {
    if (!mayMove || !e.mover) return false;
    if (x.chaseId !== t.id || (!e.mover.moving && w.time - x.chaseAt >= CHASE_REFRESH)) {
      w.movement.moveToEntity(e, t, Math.max(0.3, hd.range * 0.8));
      x.chaseId = t.id;
      x.chaseAt = w.time;
    }
    e.activity = 'moving';
    return true;
  }
  if (mayMove && e.mover && (e.mover.moving || x.chaseId != null)) w.movement.stop(e);
  if (mayMove) x.chaseId = null;
  faceToward(e, t.pos, w.dt);
  e.activity = 'healing';
  x.healTargetId = t.id;
  if (w.time >= x.nextHealAt - 1e-9) {
    rt.service.heal(t, hd.rate * e.stats.healRateMul * HEAL_PULSE, e);
    x.nextHealAt = w.time + HEAL_PULSE;
  }
  return true;
}
