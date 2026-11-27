/**
 * [combat] The 'combat' system (tick order 40, after movement): weapon cooldowns / aiming / windups /
 * releases for every armed entity, turret target acquisition, healers under 'follow', ticking passive
 * abilities, projectile flight & impact, delayed ability effects.
 */
import type { CombatState, Entity, Order, UnitDef } from '../../core/types';
import type { SimSystem } from '../services';
import { healerTick } from './healing';
import type { CombatRuntime } from './runtime';
import { autoTarget } from './targeting';
import { engage, updateProjectiles, weaponTick } from './weapons';

/** Completed buildings with weapons pick the best target within weapon range and fire (never move). */
function turretTick(rt: CombatRuntime, b: Entity, c: CombatState): void {
  if (b.construction) { c.targetId = null; return; }
  const t = autoTarget(rt, b, 'turret');
  if (t && engage(rt, b, t, false) === 'firing') return;
  if (b.activity === 'attacking') b.activity = 'idle';
}

/** Orders under which a healer heals what is in range from here (movement owns 'follow'). */
const healsInPlace = (o: Order | undefined): o is Extract<Order, { type: 'follow' }> => !!o && o.type === 'follow';

export function createCombatSystem(rt: CombatRuntime): SimSystem {
  return {
    name: 'combat',
    order: 40,
    update(w, dt) {
      const list = w.list;
      const n = list.length; // units spawned this tick (omega brood) start next tick
      for (let i = 0; i < n; i++) {
        const e = list[i]!;
        if (!e.alive) continue;
        const c = e.combat;
        if (c) {
          if (e.kind === 'building') turretTick(rt, e, c);
          weaponTick(rt, e, c, dt);
          if (!e.alive) continue; // e.g. killed by the viral burst of its own victim
        }
        if (e.kind !== 'unit') continue;
        if ((e.def as UnitDef).heal) {
          const o = e.orders[0];
          if (healsInPlace(o)) healerTick(rt, e, 'stay', null, o.targetId);
        }
        if (rt.tickPassiveDefs.has(e.defId) && e.alive) rt.abilities.tick(e);
      }
      updateProjectiles(rt, dt);
      rt.runDelayed();
      if (w.tick % 40 === 0) { rt.pruneHelpCalls(); rt.pruneProjMeta(); }
    },
  };
}
