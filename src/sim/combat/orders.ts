/**
 * [combat] Order handlers: attack, attackMove, patrol, hold, heal, ability.
 *   attack     chase & fire at one target (no leash); hunts to its last seen position if it slips into fog
 *   attackMove travel to a point, engaging enemies seen en route (leashed), then resume; healers heal en route
 *   patrol     attack-move back and forth forever
 *   hold       never move; fire at the best target in weapon range (healers heal in range)
 *   heal       healer walks to and heals one friendly unit until it is full
 *   ability    walk into the ability's range, cast via world.abilities.cast, brief 'casting' activity
 */
import { clone } from '../../core/math';
import type { Entity, UnitDef, Vec2 } from '../../core/types';
import { ABILITY_DEFS } from '../../data';
import type { OrderHandler } from '../services';
import type { World } from '../World';
import { CAST_ANIM, CHASE_REFRESH } from './constants';
import { canHeal, healerTick, healStep } from './healing';
import type { CombatRuntime } from './runtime';
import { cx, resetAuto } from './state';
import { autoTarget } from './targeting';
import { chaseStuck, endEngagement, engage } from './weapons';

const isHealer = (e: Entity): boolean => e.kind === 'unit' && !!(e.def as UnitDef).heal;

/**
 * Shared attack-move step: engage (or heal) whatever shows up, otherwise travel toward `dest`.
 * Returns 'arrived' once the travel move has completed with nothing left to fight.
 */
function advance(rt: CombatRuntime, w: World, e: Entity, dest: Vec2): 'busy' | 'travelling' | 'arrived' {
  const x = cx(e);
  if (e.combat) {
    const t = autoTarget(rt, e, 'advance');
    if (t && engage(rt, e, t, true) !== 'invalid') { x.moveIssued = false; return 'busy'; }
  }
  if (isHealer(e) && healerTick(rt, e, 'roam', x.leashOrigin ?? e.pos)) {
    if (!x.leashOrigin) x.leashOrigin = clone(e.pos); // left the path here: leash around this point
    x.moveIssued = false;
    return 'busy';
  }
  if (!x.moveIssued) {
    w.movement.moveTo(e, dest);
    x.moveIssued = true;
    x.moveIssuedAt = w.time;
    x.chaseId = null;
    x.leashOrigin = null; // next engagement leashes around where it starts
  }
  e.activity = 'moving';
  return w.time > x.moveIssuedAt && w.movement.hasArrived(e) ? 'arrived' : 'travelling';
}

export function createOrderHandlers(rt: CombatRuntime) {
  const attack: OrderHandler<'attack'> = {
    start(w, e, o) {
      const x = cx(e);
      resetAuto(x);
      x.hunting = false;
      const t = w.getAlive(o.targetId);
      x.lastSeen = t && w.vision.isEntityVisible(e.owner, t) ? clone(t.pos) : null;
    },
    update(w, e, o) {
      const t = w.getAlive(o.targetId);
      if (!t) return 'done';
      if (!e.combat) return 'failed';
      if (t.kind === 'resource' || !w.isEnemy(e.owner, t.owner) || !rt.service.weaponFor(e, t)) return 'failed';
      const x = cx(e);
      if (!w.vision.isEntityVisible(e.owner, t)) {
        // slipped into the fog: go to where it was last seen, then give up (fog is fair)
        if (!x.lastSeen) return 'done';
        if (!x.hunting) { w.movement.moveTo(e, x.lastSeen); x.hunting = true; x.moveIssuedAt = w.time; x.chaseId = null; }
        e.combat.targetId = null;
        e.activity = 'moving';
        return w.time > x.moveIssuedAt && w.movement.hasArrived(e) ? 'done' : 'running';
      }
      if (x.lastSeen) { x.lastSeen.x = t.pos.x; x.lastSeen.y = t.pos.y; } else x.lastSeen = clone(t.pos);
      x.hunting = false;
      const r = engage(rt, e, t, true);
      if (r === 'invalid') return 'failed';
      if (r === 'chasing' && chaseStuck(rt, e)) return 'failed'; // unreachable
      return 'running';
    },
    stop(_w, e) { endEngagement(rt, e); },
  };

  const attackMove: OrderHandler<'attackMove'> = {
    start(_w, e) { resetAuto(cx(e)); },
    update(w, e, o) { return advance(rt, w, e, o.target) === 'arrived' ? 'done' : 'running'; },
    stop(_w, e) { endEngagement(rt, e); },
  };

  const patrol: OrderHandler<'patrol'> = {
    start(_w, e) { resetAuto(cx(e)); },
    update(w, e, o) {
      const x = cx(e);
      if (advance(rt, w, e, o.to) === 'arrived' && w.time - x.moveIssuedAt >= CHASE_REFRESH) {
        const f = o.from; o.from = o.to; o.to = f;
        x.moveIssued = false;
      }
      return 'running';
    },
    stop(_w, e) { endEngagement(rt, e); },
  };

  const hold: OrderHandler<'hold'> = {
    start(w, e) {
      w.movement.stop(e);
      if (e.combat) e.combat.holdPosition = true;
      resetAuto(cx(e));
    },
    update(_w, e) {
      if (e.combat) {
        const t = autoTarget(rt, e, 'hold');
        if (t && engage(rt, e, t, false) === 'firing') return 'running';
      }
      if (isHealer(e) && healerTick(rt, e, 'stay')) return 'running';
      if (e.activity !== 'idle') e.activity = 'idle';
      return 'running';
    },
    stop(_w, e) {
      if (e.combat) e.combat.holdPosition = false;
      endEngagement(rt, e);
    },
  };

  const heal: OrderHandler<'heal'> = {
    update(w, e, o) {
      if (!isHealer(e)) return 'failed';
      const t = w.getAlive(o.targetId);
      if (!t || !canHeal(rt, e, t)) return 'done'; // dead, not friendly, or fully healed
      return healStep(rt, e, t, true) ? 'running' : 'failed';
    },
    stop(w, e) {
      if (e.mover?.moving) w.movement.stop(e);
      cx(e).chaseId = null;
      e.activity = 'idle';
    },
  };

  const ability: OrderHandler<'ability'> = {
    start(_w, e) {
      const x = cx(e);
      x.castAt = -1;
      x.approachAt = -1;
      x.approachTries = 0;
    },
    update(w, e, o) {
      const x = cx(e);
      if (x.castAt >= 0) {
        e.activity = 'casting';
        return w.time - x.castAt >= CAST_ANIM - 1e-9 ? 'done' : 'running';
      }
      const a = ABILITY_DEFS[o.abilityId];
      if (!a || a.target === 'passive') return 'failed';
      const tEnt = o.targetId != null ? w.getAlive(o.targetId) ?? null : null;
      if (a.target === 'unit' && !tEnt) return 'failed';
      const point = a.target === 'point' ? o.target ?? tEnt?.pos : a.target === 'unit' ? tEnt!.pos : undefined;
      const chk = rt.abilities.check(e, a.id, point, tEnt, false);
      if (!chk.ok) { rt.abilities.notify(e, chk); return 'failed'; }
      if (a.range != null && point) {
        const d = a.target === 'unit' && tEnt ? w.edgeDistance(e, tEnt) : w.edgeDistanceToPoint(e, point);
        if (d > a.range) {
          if (!e.mover) return 'failed';
          const stalled = !e.mover.moving && w.time - x.approachAt >= CHASE_REFRESH;
          if (x.approachAt < 0 || stalled) {
            if (x.approachTries >= 3) {
              rt.abilities.notify(e, { ok: false, reason: 'Target is out of range', kind: 'invalidTarget' });
              return 'failed';
            }
            if (a.target === 'unit' && tEnt) w.movement.moveToEntity(e, tEnt, a.range * 0.9);
            else w.movement.moveTo(e, point, { arriveDistance: Math.max(0.2, a.range * 0.9 + e.radius) });
            x.approachAt = w.time;
            x.approachTries++;
          }
          e.activity = 'moving';
          return 'running';
        }
        if (e.mover?.moving) w.movement.stop(e);
        const dx = point.x - e.pos.x, dy = point.y - e.pos.y;
        if (e.kind === 'unit' && dx * dx + dy * dy > 1e-6) e.facing = Math.atan2(dy, dx);
      }
      if (!w.abilities.cast(e, a.id, point ? clone(point) : undefined, tEnt)) return 'failed';
      x.castAt = w.time;
      e.activity = 'casting';
      return 'running';
    },
    stop(w, e) {
      const x = cx(e);
      x.castAt = -1;
      if (e.mover?.moving) w.movement.stop(e);
      e.activity = 'idle';
    },
  };

  return { attack, attackMove, patrol, hold, heal, ability };
}
