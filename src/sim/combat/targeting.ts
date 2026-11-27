/**
 * [combat] Automatic target acquisition (DESIGN §2): enemies within sight, priority
 *   threats (can attack us) > other units > workers > structures, then closer / more damaged first.
 * Fog is fair: only targets visible to the attacker's owner (world.vision.isEntityVisible) are considered.
 * All candidate searches go through world.spatial.queryRadius; scans are staggered by entity id.
 */
import { clamp, dist } from '../../core/math';
import type { Entity, PlayerId, Vec2, WeaponDef } from '../../core/types';
import {
  CATEGORY_WEIGHT, DAMAGED_WEIGHT, NEAR_SCAN_EXTRA, HELP_BONUS, HELP_CELL, HELP_WINDOW, LEASH_MUL, RANGE_TOLERANCE,
  RESCAN_INTERVAL, RETALIATE_BONUS, RETALIATE_WINDOW, SCAN_INTERVAL, STUCK_TIME, SWITCH_MARGIN,
} from './constants';
import type { CombatRuntime } from './runtime';
import { canHitLayer, cx, helpKey, ignoreTarget, isIgnored, type CombatExt } from './state';

/**
 * idle    — auto-acquire within sight, chase with a leash around the guard position
 * advance — attackMove / patrol: like idle, leash around where the engagement began
 * hold    — hold position: only targets already in weapon range, never moves
 * turret  — buildings: like hold
 */
export type AutoMode = 'idle' | 'advance' | 'hold' | 'turret';

const leashOf = (e: Entity): number => e.stats.sight * LEASH_MUL;
/** Scan query padding: finds buildings up to 2×2 exactly; corners of larger footprints may be found a
 *  fraction of a tile late (cheaper than the exact 1.1 pad — scans dominate the combat budget). */
const SCAN_QUERY_PAD = 0.5;
/** After a near-first scan misses, scan the full radius directly for this long (s). */
const NEAR_MISS_BACKOFF = 1;
const originOf = (x: CombatExt, mode: AutoMode): Vec2 | null => (mode === 'idle' ? x.guardPos : mode === 'advance' ? x.leashOrigin : null);

/** Priority score (lower is better) of candidate `o` at edge distance `d` for attacker `e`. */
export function scoreTarget(e: Entity, o: Entity, d: number): number {
  let cat: number;
  if (o.kind === 'building') cat = o.combat && !o.construction && canHitLayer(o, e) ? 0 : 3;
  else if (o.tags.has('worker')) cat = 2;
  else cat = o.combat && canHitLayer(o, e) ? 0 : 1;
  if (cat !== 0 && o.combat && o.combat.targetId === e.id) cat = 0; // anything currently attacking us is a threat
  const hpFrac = o.stats.maxHp > 0 ? clamp(o.hp / o.stats.maxHp, 0, 1) : 1;
  return cat * CATEGORY_WEIGHT + d + DAMAGED_WEIGHT * hpFrac;
}

/** Reused scan state (scans never re-enter: they deal no damage) — avoids per-scan closures/allocations. */
const S = {
  e: null as unknown as Entity, x: null as unknown as CombatExt, owner: 0 as PlayerId, now: 0,
  inRangeOnly: false, origin: null as Vec2 | null, leash: 0,
  wGround: null as WeaponDef | null, rGround: 0, wAir: null as WeaponDef | null, rAir: 0,
  best: null as Entity | null, bestS: Infinity, tooClose: null as Entity | null, tooCloseD: Infinity,
};

function consider(rt: CombatRuntime, o: Entity, bonus: number, maxD: number): void {
  const e = S.e;
  if (o === e || !o.alive || o.kind === 'resource' || o.owner === S.owner || o.invulnerable) return;
  const air = o.tags.has('air');
  const wp = air ? S.wAir : S.wGround;
  if (!wp) return;
  const w = rt.world;
  if (!w.isEnemy(S.owner, o.owner)) return;
  let d: number;
  if (o.kind === 'unit' && e.kind === 'unit') {
    const dx = o.pos.x - e.pos.x, dy = o.pos.y - e.pos.y;
    d = Math.sqrt(dx * dx + dy * dy) - e.radius - o.radius;
    if (d < 0) d = 0;
  } else d = w.edgeDistance(e, o);
  if (d > maxD) return;
  const range = air ? S.rAir : S.rGround;
  if (S.inRangeOnly && d > range + RANGE_TOLERANCE) return;
  if (S.origin && d > range) { // must be reachable without breaking the leash
    const ox = o.pos.x - S.origin.x, oy = o.pos.y - S.origin.y, lr = S.leash + range;
    if (ox * ox + oy * oy > lr * lr) return;
  }
  if (S.x.ignore.length && isIgnored(S.x, o.id, S.now)) return;
  if (!w.vision.isEntityVisible(S.owner, o)) return;
  if (wp.minRange && d < wp.minRange) {
    if (d < S.tooCloseD) { S.tooCloseD = d; S.tooClose = o; }
    return;
  }
  const sc = scoreTarget(e, o, d) - bonus;
  if (sc < S.bestS) { S.bestS = sc; S.best = o; }
}

function queryAndConsider(rt: CombatRuntime, radius: number): void {
  const e = S.e, out = rt.scratch;
  out.length = 0;
  rt.world.spatial.queryRadius(e.pos, radius + e.radius + SCAN_QUERY_PAD, undefined, out);
  for (let i = 0; i < out.length; i++) consider(rt, out[i]!, 0, radius);
  out.length = 0;
}

/** Retaliation (whoever hit us recently — even beyond sight, e.g. artillery) and ally help calls. */
function considerExtras(rt: CombatRuntime): void {
  const w = rt.world, e = S.e, now = S.now;
  if (e.lastAttackerId != null && now - e.lastDamagedAt <= RETALIATE_WINDOW) {
    const a = w.getAlive(e.lastAttackerId);
    if (a) consider(rt, a, RETALIATE_BONUS, S.leash);
  }
  if (rt.helpCalls.size) {
    const hx = Math.floor(e.pos.x / HELP_CELL), hy = Math.floor(e.pos.y / HELP_CELL);
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const h = rt.helpCalls.get(helpKey(S.owner, hx + ox, hy + oy));
      if (!h || now - h.time > HELP_WINDOW) continue;
      const a = w.getAlive(h.attackerId);
      if (a) consider(rt, a, HELP_BONUS, S.leash);
    }
  }
}

/**
 * Best target for `e` right now, or null. In moving modes, an enemy that is too close for a minRange
 * weapon is returned only when nothing else is available (engage() then backs off from it).
 * Moving modes scan near-first: a threat within weapon range + NEAR_SCAN_EXTRA wins outright (it is
 * also what the full-sight priority would pick, up to tiny distance/damage trade-offs); otherwise the
 * whole sight radius is scanned. `nearOnly` (re-evaluating while busy with a unit) skips the full scan.
 */
export function scanForTarget(rt: CombatRuntime, e: Entity, mode: AutoMode, nearOnly = false): Entity | null {
  const w = rt.world, x = cx(e);
  if (e.def.kind === 'resource' || e.construction) return null;
  S.e = e; S.x = x; S.owner = e.owner; S.now = w.time;
  S.inRangeOnly = mode === 'hold' || mode === 'turret';
  S.origin = originOf(x, mode);
  S.leash = leashOf(e);
  S.wGround = null; S.wAir = null; S.rGround = 0; S.rAir = 0;
  let maxRange = 0;
  for (const wp of e.def.weapons) {
    const r = wp.range + e.stats.rangeAdd;
    if (!S.wGround && wp.targets.includes('ground')) { S.wGround = wp; S.rGround = r; }
    if (!S.wAir && wp.targets.includes('air')) { S.wAir = wp; S.rAir = r; }
    if (r > maxRange) maxRange = r;
  }
  S.best = null; S.bestS = Infinity; S.tooClose = null; S.tooCloseD = Infinity;
  if (!S.wGround && !S.wAir) return null;

  // nobody hostile anywhere near: skip the spatial queries (retaliation/help still apply)
  const reach = S.inRangeOnly ? maxRange + RANGE_TOLERANCE : e.stats.sight;
  if (!rt.enemiesMaybeNear(S.owner, e.pos, reach + e.radius)) {
    if (!S.inRangeOnly) considerExtras(rt);
    return finishScan(S.best);
  }
  if (S.inRangeOnly) {
    queryAndConsider(rt, maxRange + RANGE_TOLERANCE);
    return finishScan(S.best);
  }
  const full = e.stats.sight;
  const near = Math.min(full, maxRange + NEAR_SCAN_EXTRA);
  // near-first (skipped for a moment after it misses, so rear ranks don't pay for two queries)
  if (near < full - 0.5 && (nearOnly || S.now - x.nearMissAt > NEAR_MISS_BACKOFF)) {
    if (rt.enemiesMaybeNear(S.owner, e.pos, near + e.radius)) {
      queryAndConsider(rt, near);
      considerExtras(rt);
      if (nearOnly || (S.best && S.bestS < CATEGORY_WEIGHT)) return finishScan(S.best ?? S.tooClose);
      S.best = null; S.bestS = Infinity; S.tooClose = null; S.tooCloseD = Infinity; // full scan re-finds them
    } else if (nearOnly) {
      considerExtras(rt);
      return finishScan(S.best ?? S.tooClose);
    }
    x.nearMissAt = S.now;
  }
  queryAndConsider(rt, full);
  considerExtras(rt);
  return finishScan(S.best ?? S.tooClose);
}

function finishScan(r: Entity | null): Entity | null {
  S.e = null as unknown as Entity; // don't retain entities between scans
  S.x = null as unknown as CombatExt;
  S.best = null; S.tooClose = null;
  return r;
}

/** Whether an automatic target is still worth pursuing (else it is dropped, possibly ignored for a while). */
function keepAutoTarget(rt: CombatRuntime, e: Entity, t: Entity, mode: AutoMode): boolean {
  const w = rt.world, svc = rt.service, x = cx(e), now = w.time;
  if (t.invulnerable || !svc.canTarget(e, t) || isIgnored(x, t.id, now)) return false;
  const wp = svc.weaponFor(e, t)!;
  const range = svc.weaponRange(e, wp);
  const d = w.edgeDistance(e, t);
  // too close for a minRange weapon: keep it only as the back-off fallback chosen by the last scan
  // (the regular rescan still looks for something we can actually shoot)
  if (wp.minRange && d < wp.minRange) return x.tooCloseFallback && mode !== 'hold' && mode !== 'turret';
  if (mode === 'hold' || mode === 'turret') return d <= range + RANGE_TOLERANCE;
  if (d > range + RANGE_TOLERANCE) {
    const origin = originOf(x, mode);
    if (origin && dist(e.pos, origin) > leashOf(e)) { ignoreTarget(x, t.id, now); return false; }
    if (x.chaseId === t.id && x.stuckSince >= 0 && now - x.stuckSince > STUCK_TIME) { ignoreTarget(x, t.id, now); x.stuckSince = -1; return false; }
    if (d > leashOf(e) + range) return false; // ran far away (still visible through other eyes)
  }
  return true;
}

/** Re-evaluation period while engaged: slower when already shooting a threat in range. */
function rescanInterval(rt: CombatRuntime, e: Entity, cur: Entity): number {
  if (e.combat!.targetId !== cur.id || cx(e).fireTick !== rt.world.tick - 1) return RESCAN_INTERVAL;
  return cur.combat && canHitLayer(cur, e) ? RESCAN_INTERVAL * 2 : RESCAN_INTERVAL;
}

/**
 * Validate / (re)acquire the automatic target of `e` for this tick. Cheap when nothing changes: a full
 * scan happens every SCAN_INTERVAL ticks without a target, every RESCAN_INTERVAL ticks with one, and
 * immediately when the current target is lost. Sets the leash origin / guard position on first contact.
 */
export function autoTarget(rt: CombatRuntime, e: Entity, mode: AutoMode): Entity | null {
  const w = rt.world, x = cx(e), c = e.combat;
  if (!c) return null;
  let cur: Entity | null = w.getAlive(x.autoTargetId) ?? null;
  let lost = x.autoTargetId != null && !cur;
  if (cur && !keepAutoTarget(rt, e, cur, mode)) { cur = null; lost = true; }
  if (lost || (w.tick + e.id) % (cur ? rescanInterval(rt, e, cur) : SCAN_INTERVAL) === 0) {
    // re-evaluating while busy with a unit: only something close can be better (structures/workers: full)
    const found = scanForTarget(rt, e, mode, !!cur && cur.kind === 'unit' && !cur.tags.has('worker'));
    if (found && found !== cur) {
      if (!cur) cur = found;
      else if (c.windupLeft <= 0) {
        const dc = w.edgeDistance(e, cur), df = w.edgeDistance(e, found);
        if (scoreTarget(e, found, df) < scoreTarget(e, cur, dc) - SWITCH_MARGIN) cur = found;
      }
    }
    x.tooCloseFallback = !!cur && isTooClose(rt, e, cur);
  }
  x.autoTargetId = cur ? cur.id : null;
  if (cur) {
    if (mode === 'idle' && !x.guardPos) x.guardPos = { x: e.pos.x, y: e.pos.y };
    if (mode === 'advance' && !x.leashOrigin) x.leashOrigin = { x: e.pos.x, y: e.pos.y };
  }
  return cur;
}

function isTooClose(rt: CombatRuntime, e: Entity, t: Entity): boolean {
  const wp = rt.service.weaponFor(e, t);
  return !!wp && !!wp.minRange && rt.world.edgeDistance(e, t) < wp.minRange;
}
