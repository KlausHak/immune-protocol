/**
 * [combat] OWNER: combat agent. Weapons, projectiles, damage, healing, abilities, unit combat behaviour.
 * install(world) must set: world.combat, world.abilities, world.idleBehavior,
 * order handlers 'attack' 'attackMove' 'patrol' 'hold' 'heal' 'ability', and a system named 'combat' (order 40).
 */
import type { World } from '../World';

export function installCombat(_world: World): void {
  // TODO(combat agent): replace stub combat.
}
