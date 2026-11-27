/**
 * [combat] Weapons: engagement (chase / back off / stop and aim), windup → release, instant hits,
 * projectiles (homing & arc) and impacts.
 *
 * Flow per tick: order handlers / idle behaviour (tick order 20) call engage(), which moves the unit and,
 * when in range, records a *fire intent* for this tick. The combat system (order 40, after movement)
 * runs weaponTick(): cooldown, turning toward the target, windup and release. An intent that is not
 * refreshed (order replaced, target lost) cancels a windup — no damage, cooldown refunded.
 */
import { clamp, clone } from '../../core/math';
import type { CombatState, Entity, Projectile, WeaponDef } from '../../core/types';
import { ARC_DIRECT_RADIUS, MAX_FLIGHT, CHASE_REFRESH, RANGE_TOLERANCE, STUCK_TIME, WINDUP_LEEWAY } from './constants';
import type { CombatRuntime, ProjectileMeta } from './runtime';
import { splashDamage } from './service';
import { bonusVs, cx, faceToward, hitRadius, shotHeight } from './state';

export type EngageResult = 'firing' | 'chasing' | 'outOfRange' | 'tooClose' | 'invalid';

/** Range a chaser approaches to (a little inside weapon range so small target movements don't break it). */
const chaseRange = (range: number): number => Math.max(0.05, range - Math.min(0.5, range * 0.15));

/**
 * Engage `t` with the best weapon this tick. mayMove=false (hold position, turrets) never moves the unit.
 *   'firing'     — in range: unit stopped, fire intent set (the combat system aims & shoots)
 *   'chasing'    — moving into range
 *   'tooClose'   — inside a minRange weapon's dead zone (backing off when allowed)
 *   'outOfRange' — out of range and not allowed to move
 *   'invalid'    — no weapon can hit the target
 */
export function engage(rt: CombatRuntime, e: Entity, t: Entity, mayMove: boolean): EngageResult {
  const c = e.combat;
  if (!c) return 'invalid';
  const w = rt.world, svc = rt.service;
  const wp = svc.weaponFor(e, t);
  if (!wp) return 'invalid';
  const x = cx(e);
  const range = svc.weaponRange(e, wp);
  const d = w.edgeDistance(e, t);
  const winding = c.windupLeft > 0 && x.windupTargetId === t.id;
  x.engageTick = w.tick;
  c.targetId = t.id;
  if (wp.minRange && d < wp.minRange && !winding) {
    if (!mayMove || !e.mover) return 'tooClose';
    backOff(rt, e, t, wp.minRange, d);
    e.activity = 'moving';
    return 'tooClose';
  }
  if (d > range + RANGE_TOLERANCE + (winding ? WINDUP_LEEWAY : 0)) {
    if (!mayMove || !e.mover) return 'outOfRange';
    chase(rt, e, t, range);
    e.activity = 'moving';
    return 'chasing';
  }
  if (x.chaseId != null || (e.mover && e.mover.moving)) { w.movement.stop(e); x.chaseId = null; }
  x.stuckSince = -1;
  x.fireTick = w.tick;
  x.fireTargetId = t.id;
  x.fireWeapon = wp;
  e.activity = 'attacking';
  return 'firing';
}

/** moveToEntity into range; re-issued only when the target changes or the unit stopped (rate-limited). */
function chase(rt: CombatRuntime, e: Entity, t: Entity, range: number): void {
  const w = rt.world, x = cx(e), now = w.time;
  const moving = !!e.mover?.moving;
  if (x.chaseId === t.id) {
    if (moving) { x.stuckSince = -1; return; }
    if (x.stuckSince < 0) x.stuckSince = now; // arrived / gave up but still out of range
    if (now - x.chaseAt < CHASE_REFRESH) return;
  } else {
    x.stuckSince = -1;
  }
  w.movement.moveToEntity(e, t, chaseRange(range));
  x.chaseId = t.id;
  x.chaseAt = now;
}

/** True when the current chase has made no progress for STUCK_TIME (target unreachable from here). */
export function chaseStuck(rt: CombatRuntime, e: Entity): boolean {
  const x = cx(e);
  return x.stuckSince >= 0 && rt.world.time - x.stuckSince > STUCK_TIME;
}

/** Step away from a target that is inside a minRange weapon's dead zone. */
function backOff(rt: CombatRuntime, e: Entity, t: Entity, minRange: number, d: number): void {
  const w = rt.world, x = cx(e), now = w.time;
  if (now - x.backoffAt < CHASE_REFRESH && e.mover?.moving) return;
  let ax = e.pos.x - t.pos.x, ay = e.pos.y - t.pos.y;
  let l = Math.hypot(ax, ay);
  if (l < 1e-6) { ax = -Math.cos(e.facing); ay = -Math.sin(e.facing); l = 1; }
  const step = Math.max(1.5, minRange - d + 1);
  const map = w.map;
  const dest = {
    x: clamp(e.pos.x + (ax / l) * step, 1, map.width - 1),
    y: clamp(e.pos.y + (ay / l) * step, 1, map.height - 1),
  };
  const p = e.mover?.flying ? dest : w.movement.nearestWalkable(dest, 3) ?? dest;
  w.movement.moveTo(e, p, { arriveDistance: 0.3 });
  x.backoffAt = now;
  x.chaseId = null;
}

/** Stop whatever combat movement / attack the unit was doing (order ended). */
export function endEngagement(rt: CombatRuntime, e: Entity): void {
  const x = cx(e), c = e.combat;
  if (e.mover && (e.mover.moving || x.chaseId != null)) rt.world.movement.stop(e);
  x.chaseId = null;
  x.stuckSince = -1;
  x.fireTargetId = null;
  if (c) { c.targetId = null; cancelWindup(c, x); }
  if (e.activity !== 'idle') e.activity = 'idle';
}

function cancelWindup(c: CombatState, x: ReturnType<typeof cx>): void {
  if (c.windupLeft > 0) { c.windupLeft = 0; c.cooldown = 0; } // refund: no shot happened
  x.windupTargetId = null;
  x.windupWeapon = null;
}

/** Combat-system step for one armed entity: cooldown, aim, windup, release. */
export function weaponTick(rt: CombatRuntime, e: Entity, c: CombatState, dt: number): void {
  const w = rt.world, x = cx(e), svc = rt.service;
  if (c.cooldown > 0) c.cooldown = Math.max(0, c.cooldown - dt);
  if (x.engageTick !== w.tick && c.targetId != null) c.targetId = null;
  const wants = x.fireTick === w.tick && x.fireTargetId != null;

  if (c.windupLeft > 0) {
    const t = wants && x.fireTargetId === x.windupTargetId ? w.getAlive(x.windupTargetId) : undefined;
    if (!t || !x.windupWeapon || !svc.canTarget(e, t)) {
      cancelWindup(c, x);
    } else {
      faceToward(e, t.pos, dt);
      c.windupLeft -= dt;
      if (c.windupLeft <= 1e-6) {
        const wp = x.windupWeapon;
        c.windupLeft = 0;
        x.windupTargetId = null;
        x.windupWeapon = null;
        release(rt, e, t, wp);
      }
      return;
    }
  }
  if (!wants) return;
  const t = w.getAlive(x.fireTargetId);
  const wp = x.fireWeapon;
  if (!t || !wp || !svc.canTarget(e, t)) return;
  // re-check after the movement phase (the target may have stepped away; the handler chases next tick)
  const d = w.edgeDistance(e, t);
  if (d > svc.weaponRange(e, wp) + RANGE_TOLERANCE * 2) return;
  if (wp.minRange && d < wp.minRange) return;
  const aligned = faceToward(e, t.pos, dt);
  if (!aligned || c.cooldown > 0) return;
  // the cooldown runs from the start of the attack, so DPS = damage / cooldown regardless of windup
  c.cooldown = wp.cooldown * e.stats.cooldownMul;
  const windup = wp.windup ?? 0;
  if (windup > 0) {
    c.windupLeft = windup;
    x.windupTargetId = t.id;
    x.windupWeapon = wp;
  } else {
    release(rt, e, t, wp);
  }
}

/** The moment an attack goes off: instant damage, or a projectile launch. */
function release(rt: CombatRuntime, e: Entity, t: Entity, wp: WeaponDef): void {
  const w = rt.world, svc = rt.service, c = e.combat!;
  c.lastAttackTime = w.time;
  if (!wp.projectileSpeed || wp.projectileSpeed <= 0) {
    const center = clone(t.pos);
    w.events.emit('weaponFired', { source: e, target: t, targetPos: clone(center), weapon: wp, projectile: null });
    if (!t.alive) return;
    svc.applyDamage(t, svc.rawDamage(e, wp, t), wp.damageType, e);
    if (wp.splashRadius && wp.splashRadius > 0) {
      splashDamage(rt, {
        center, radius: wp.splashRadius, ownerPlayer: e.owner, source: e, type: wp.damageType,
        rawFor: (o) => svc.rawDamage(e, wp, o), exclude: t, layers: wp.targets,
      });
    }
    return;
  }
  const p = launchProjectile(rt, e, t, wp);
  w.events.emit('weaponFired', { source: e, target: t, targetPos: clone(p.targetPos), weapon: wp, projectile: p });
}

function launchProjectile(rt: CombatRuntime, e: Entity, t: Entity, wp: WeaponDef): Projectile {
  const w = rt.world;
  const dx = t.pos.x - e.pos.x, dy = t.pos.y - e.pos.y;
  const l = Math.hypot(dx, dy) || 1;
  const off = e.kind === 'unit' ? Math.min(e.radius * 0.6, l * 0.5) : 0; // leave from the unit's front, not its centre
  const start = { x: e.pos.x + (dx / l) * off, y: e.pos.y + (dy / l) * off };
  const arc = !!wp.arc;
  const p: Projectile = {
    id: w.nextProjectileId++,
    ownerPlayer: e.owner,
    sourceId: e.id,
    targetId: arc ? null : t.id,
    weapon: wp,
    vfx: wp.vfx,
    pos: clone(start),
    prevPos: clone(start),
    start,
    targetPos: clone(t.pos),
    t: 0,
    prevT: 0,
    speed: wp.projectileSpeed!,
    arc,
    damage: rt.service.rawDamage(e, wp, t),
    splashRadius: wp.splashRadius ?? 0,
    startHeight: shotHeight(e),
    endHeight: arc ? 0 : shotHeight(t),
  };
  w.projectiles.push(p);
  rt.projMeta.set(p.id, { source: e, damageAdd: e.stats.damageAdd, damageMul: e.stats.damageMul, traveled: 0, launchedAt: w.time });
  return p;
}

/** Advance every projectile; remove the ones that hit. */
export function updateProjectiles(rt: CombatRuntime, dt: number): void {
  const list = rt.world.projectiles;
  const n = list.length;
  if (n === 0) return;
  let write = 0;
  for (let i = 0; i < n; i++) {
    const p = list[i]!;
    let done = true;
    try { done = stepProjectile(rt, p, dt); } catch (err) { console.error('[combat] projectile step threw', err); }
    if (done) rt.projMeta.delete(p.id);
    else list[write++] = p;
  }
  if (rt.world.projectiles !== list) return; // replaced by someone during impacts (campaign cleanup)
  for (let i = n; i < list.length; i++) list[write++] = list[i]!; // launched during impacts (keep)
  list.length = write;
}

/** Returns true when the projectile impacted this tick. */
function stepProjectile(rt: CombatRuntime, p: Projectile, dt: number): boolean {
  const w = rt.world;
  const meta = rt.projMeta.get(p.id);
  if (meta && w.time - meta.launchedAt > MAX_FLIGHT) { // can't catch its target: fizzle (no damage)
    w.events.emit('projectileImpact', { projectile: p, pos: clone(p.pos), target: null });
    return true;
  }
  if (p.arc) {
    const tx = p.targetPos.x - p.start.x, ty = p.targetPos.y - p.start.y;
    const total = Math.hypot(tx, ty);
    p.t = total < 1e-3 ? 1 : Math.min(1, p.t + (p.speed * dt) / total);
    p.pos.x = p.start.x + tx * p.t;
    p.pos.y = p.start.y + ty * p.t;
    if (p.t < 1) return false;
    impact(rt, p, null, meta);
    return true;
  }
  // homing: track the target while it lives, else fly on to its last position
  const tgt = p.targetId != null ? w.getAlive(p.targetId) : undefined;
  if (tgt) { p.targetPos.x = tgt.pos.x; p.targetPos.y = tgt.pos.y; }
  else if (p.targetId != null) p.targetId = null;
  const dx = p.targetPos.x - p.pos.x, dy = p.targetPos.y - p.pos.y;
  const dist = Math.hypot(dx, dy);
  const hitR = tgt ? hitRadius(tgt) : 0;
  const step = p.speed * dt;
  if (dist - hitR <= step) {
    const adv = Math.max(0, dist - hitR);
    if (dist > 1e-6) { p.pos.x += (dx / dist) * adv; p.pos.y += (dy / dist) * adv; }
    p.t = 1;
    impact(rt, p, tgt ?? null, meta);
    return true;
  }
  p.pos.x += (dx / dist) * step;
  p.pos.y += (dy / dist) * step;
  const traveled = (meta ? meta.traveled : 0) + step;
  if (meta) meta.traveled = traveled;
  const remaining = dist - step - hitR;
  p.t = Math.max(p.t, Math.min(0.99, traveled / (traveled + remaining)));
  return false;
}

function impact(rt: CombatRuntime, p: Projectile, tgt: Entity | null, meta: ProjectileMeta | undefined): void {
  const w = rt.world, svc = rt.service, wp = p.weapon;
  const pos = clone(p.pos);
  w.events.emit('projectileImpact', { projectile: p, pos: clone(pos), target: tgt });
  const source = meta?.source ?? w.get(p.sourceId) ?? null;
  const add = meta ? meta.damageAdd : 0, mul = meta ? meta.damageMul : 1;
  const rawFor = (o: Entity): number => (wp.damage + bonusVs(wp.bonus, o) + add) * mul;
  if (!p.arc) {
    const center = tgt ? clone(tgt.pos) : pos;
    if (tgt && tgt.alive) svc.applyDamage(tgt, p.damage, wp.damageType, source);
    if (p.splashRadius > 0) {
      splashDamage(rt, { center, radius: p.splashRadius, ownerPlayer: p.ownerPlayer, source, type: wp.damageType, rawFor, exclude: tgt, layers: wp.targets });
    }
    return;
  }
  // arc shells land where the target stood at launch: everything (enemy) around the landing point is hit
  const splash = p.splashRadius > 0;
  splashDamage(rt, {
    center: pos, radius: splash ? p.splashRadius : ARC_DIRECT_RADIUS, ownerPlayer: p.ownerPlayer, source,
    type: wp.damageType, rawFor, falloff: splash, layers: wp.targets,
  });
}
