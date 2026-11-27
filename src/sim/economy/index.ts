/**
 * [economy] OWNER: economy agent. Gathering, construction, production, research, population, energy income.
 * install(world) must set: world.economy, order handlers 'gather' 'returnCargo' 'build' 'construct' 'repair',
 * and a system named 'economy' (order 50).
 */
import type { World } from '../World';

export function installEconomy(_world: World): void {
  // TODO(economy agent): replace stub economy.
}
