/**
 * [combat] world.idleBehavior — runs every tick for alive units without orders.
 *  - healers auto-heal the most damaged friendly unit within sight (walking into heal range)
 *  - armed non-workers auto-acquire enemies within sight, retaliate against attackers (even beyond sight)
 *    and help nearby friends under attack; the chase is leashed to LEASH_MUL × sight around the spot
 *    where they stood, and they walk back there afterwards
 *  - workers never auto-fight
 */
import { clone, dist } from '../../core/math';
import type { Entity, UnitDef } from '../../core/types';
import type { World } from '../World';
import { GUARD_RETURN_DIST } from './constants';
import { healerTick } from './healing';
import type { CombatRuntime } from './runtime';
import { cx, resetAuto } from './state';
import { autoTarget } from './targeting';
import { engage } from './weapons';

export function createIdleBehavior(rt: CombatRuntime): (world: World, e: Entity, dt: number) => void {
  return (w, e) => {
    const x = cx(e);
    if (x.idleTick !== w.tick - 1) { // just became idle (new unit, or its orders ran out)
      resetAuto(x);
      x.guardPos = null;
      x.returning = false;
    }
    x.idleTick = w.tick;

    if ((e.def as UnitDef).heal && healerTick(rt, e, 'roam', x.guardPos ?? e.pos)) {
      if (!x.guardPos) x.guardPos = clone(e.pos);
      x.returning = false;
      return;
    }
    if (e.combat && !e.gatherer && !e.tags.has('worker')) {
      const t = autoTarget(rt, e, 'idle');
      if (t && engage(rt, e, t, true) !== 'invalid') { x.returning = false; return; }
    }

    // nothing to do: walk back to where the automatic chase began
    if (x.guardPos) {
      const far = dist(e.pos, x.guardPos) > GUARD_RETURN_DIST;
      if (far && !(x.returning && w.time > x.moveIssuedAt && w.movement.hasArrived(e))) {
        if (!x.returning) {
          w.movement.moveTo(e, x.guardPos, { arriveDistance: 0.5 });
          x.returning = true;
          x.moveIssuedAt = w.time;
          x.chaseId = null;
        }
        e.activity = 'moving';
        return;
      }
      x.guardPos = null;
      x.returning = false;
    }
    if (x.chaseId != null) { w.movement.stop(e); x.chaseId = null; } // the target we chased is gone
    const act = e.mover?.moving ? 'moving' : 'idle';
    if (e.activity !== act) e.activity = act;
  };
}
