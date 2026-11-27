/**
 * [combat] OWNER: combat agent. Weapons, projectiles, damage, healing, abilities, unit combat behaviour.
 * install(world) sets: world.combat, world.abilities, world.idleBehavior,
 * order handlers 'attack' 'attackMove' 'patrol' 'hold' 'heal' 'ability', and the 'combat' system (order 40).
 *
 * Event semantics (for VFX / audio / AI):
 *  - weaponFired      at attack release (after the weapon's windup). projectile=null → instant hit
 *                     (spray / beam / melee): damage is applied right after the event, same tick.
 *                     Otherwise `projectile` is the live object in world.projectiles.
 *  - projectileImpact when a projectile lands / hits, before its damage is applied. target=null for arc
 *                     shells (they hit the ground at the launch-time target position) and lost homing shots.
 *  - entityHealed     one per heal pulse (every HEAL_PULSE = 0.5 s while a healer is treating a unit).
 *  - abilityUsed      uv_flare / emergency_supply at cast (flare damage follows immediately; supplies arrive
 *                     EMERGENCY_SUPPLY_DELAY = 2 s later); viral_burst when a phage dies (source = the corpse,
 *                     target = burst centre); omega_spawn when Strain Omega sheds phages (target = its position).
 * Projectile heights: startHeight/endHeight = shotHeight(entity): ground units 0.5 + 0.75 × radius (≈0.8 for
 *   infantry), air units def.flyHeight, buildings 1.5; arc shells end at 0 (ground).
 * entity.combat.targetId is the target being engaged THIS tick (null otherwise) — the renderer aims with it.
 */
import type { Entity } from '../../core/types';
import { ALL_UNITS } from '../../data';
import type { World } from '../World';
import { AbilityServiceImpl } from './abilities';
import { createIdleBehavior } from './idle';
import { createOrderHandlers } from './orders';
import { CombatRuntime, type CombatSave } from './runtime';
import { splashDamage, type SplashSpec } from './service';
import { createCombatSystem } from './system';

export { CombatRuntime } from './runtime';
export { CombatServiceImpl, splashDamage, type SplashSpec } from './service';
export { AbilityServiceImpl } from './abilities';
export { shotHeight } from './state';
export { scoreTarget } from './targeting';
export { EMERGENCY_SUPPLY_DELAY, HEAL_PULSE } from './constants';

const runtimes = new WeakMap<World, CombatRuntime>();

/** The combat runtime installed on a world (undefined if installCombat was never called). */
export function combatRuntime(world: World): CombatRuntime | undefined { return runtimes.get(world); }

/** Splash damage through the installed combat module (no friendly fire, linear falloff to 50%). */
export function applySplash(world: World, spec: SplashSpec): number {
  const rt = runtimes.get(world);
  return rt && rt.active ? splashDamage(rt, spec) : 0;
}

export function installCombat(world: World): void {
  runtimes.get(world)?.dispose(); // re-install (tests: installStubs → installCombat) must not double-subscribe
  const rt = new CombatRuntime(world);
  runtimes.set(world, rt);
  for (const def of ALL_UNITS) if (AbilityServiceImpl.hasTickPassive(def)) rt.tickPassiveDefs.add(def.id);

  world.combat = rt.service;
  world.abilities = rt.abilities;
  world.idleBehavior = createIdleBehavior(rt);
  const h = createOrderHandlers(rt);
  world.orderHandlers.attack = h.attack;
  world.orderHandlers.attackMove = h.attackMove;
  world.orderHandlers.patrol = h.patrol;
  world.orderHandlers.hold = h.hold;
  world.orderHandlers.heal = h.heal;
  world.orderHandlers.ability = h.ability;
  world.addSystem(createCombatSystem(rt));
  world.registerSaveParticipant({
    key: 'combat',
    save: () => rt.saveState(),
    load: (_w, data) => rt.loadState(data as CombatSave),
  });

  // on-death passives (viral_burst). Deaths caused while a burst resolves are queued, not recursed into.
  const pending: Entity[] = [];
  let draining = false;
  rt.unsubs.push(world.events.on('entityDied', ({ entity }) => {
    if (!rt.active || world.restoring || entity.def.kind === 'resource' || entity.def.abilities.length === 0) return;
    pending.push(entity);
    if (draining) return;
    draining = true;
    try {
      while (pending.length) rt.abilities.onDeath(pending.shift()!);
    } finally { draining = false; }
  }));
}
