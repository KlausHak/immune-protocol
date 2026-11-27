/**
 * [movement] OWNER: movement agent. Pathfinding, steering/collision, spatial index, fog of war.
 * install(world) must set: world.movement, world.vision (optionally world.spatial),
 * order handlers 'move' + 'follow', and systems named 'movement' (order 30) and 'vision' (order 60).
 * Until implemented, the stubs from ../stubs.ts stay active.
 */
import type { World } from '../World';

export function installMovement(_world: World): void {
  // TODO(movement agent): replace stub movement/vision.
}
