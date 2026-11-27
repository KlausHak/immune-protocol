/**
 * [economy] OWNER: economy agent. Gathering, construction, production, research, population, energy income.
 * install(world) sets world.economy, the order handlers 'gather' 'returnCargo' 'build' 'construct' 'repair',
 * and the system 'economy' (order 50).
 *
 * Public helpers for the AI / controls / HUD (stable signatures):
 *   findBuildSpot(world, playerId, defId, near, opts?)  → TilePos | null   (placement.ts)
 *   idleWorkers(world, playerId)                         → Entity[]
 *   incomeRate(world, playerId, windowSec?)              → { matterPerMin, energyPerMin }
 *   workersOnNode(world, nodeId, playerId?)              → number
 *
 * Files: service.ts (EconomyService) · gather.ts · construction.ts (build/construct/repair) · production.ts ·
 * placement.ts · system.ts · requirements.ts · messages.ts · motion.ts · geometry.ts · state.ts · constants.ts
 */
import type { OrderHandler } from '../services';
import type { World } from '../World';
import { buildHandler, constructHandler, repairHandler } from './construction';
import { gatherHandler, onCommandIssued, returnCargoHandler } from './gather';
import { EconomyServiceImpl } from './service';
import { initRuntime } from './state';
import { economySystem } from './system';

export { findBuildSpot } from './placement';
export { idleWorkers, incomeRate, workersOnNode } from './helpers';
export { capacityOf, isGatherable, occupantOf } from './gather';
export { activeBuilders, canRepair, repairBlocker } from './construction';
export { EconomyServiceImpl } from './service';
export * as economyConstants from './constants';

/** Install the real economy onto a world (replaces the stub economy, handlers and system). */
export function installEconomy(world: World): void {
  initRuntime(world);
  world.economy = new EconomyServiceImpl(world);
  world.orderHandlers.gather = gatherHandler as OrderHandler<'gather'>;
  world.orderHandlers.returnCargo = returnCargoHandler as OrderHandler<'returnCargo'>;
  world.orderHandlers.build = buildHandler as OrderHandler<'build'>;
  world.orderHandlers.construct = constructHandler as OrderHandler<'construct'>;
  world.orderHandlers.repair = repairHandler as OrderHandler<'repair'>;
  world.addSystem({ name: 'economy', order: 50, update: economySystem });
  world.events.on('commandIssued', ({ command }) => onCommandIssued(world, command));
}
