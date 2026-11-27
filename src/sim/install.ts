import { installCombat } from './combat';
import { installEconomy } from './economy';
import { installMovement } from './movement';
import type { World } from './World';

/** Install every real simulation module onto a world (stubs are pre-installed by the World constructor). */
export function installSimModules(world: World): void {
  installMovement(world);
  installCombat(world);
  installEconomy(world);
}
