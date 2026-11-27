/**
 * [movement] OWNER: movement agent. Pathfinding, steering/collision, spatial index, fog of war.
 *
 * installMovement(world) sets world.movement (MovementController), world.vision (FogOfWar) and a faster
 * world.spatial (FastSpatialIndex), registers the 'move' / 'follow' order handlers and the systems
 * 'movement' (order 30) and 'vision' (order 60), replacing the stubs of the same names.
 *
 *  navgrid.ts       walkability, size-class clearance, components, capsule LOS, wall resolution
 *  pathfinder.ts    A*, Dijkstra fields, string-pulling
 *  movement.ts      MovementService + steering/collision system
 *  formation.ts     groupTargets layout
 *  vision.ts        fog of war
 *  spatialIndex.ts  SpatialIndex
 *  handlers.ts      'move' / 'follow'
 *  constants.ts     tuning
 */
import type { World } from '../World';
import { followHandler, moveHandler } from './handlers';
import { MovementController, type MovementSave } from './movement';
import { FastSpatialIndex } from './spatialIndex';
import { FogOfWar, type VisionSave } from './vision';

export { MovementController, isGhosting, newMoveExt, type MoveExt } from './movement';
export { FogOfWar } from './vision';
export { FastSpatialIndex } from './spatialIndex';
export { NavGrid, sizeClass, MAX_CLASS } from './navgrid';

export interface MovementInternals {
  movement: MovementController;
  vision: FogOfWar;
  spatial: FastSpatialIndex;
}

const internals = new WeakMap<World, MovementInternals>();

/** Access the concrete movement/vision objects of a world (tests, debug overlays). */
export function getMovementInternals(world: World): MovementInternals | undefined {
  return internals.get(world);
}

export function installMovement(world: World): void {
  const spatial = new FastSpatialIndex(world);
  world.spatial = spatial;
  spatial.rebuild();
  const movement = new MovementController(world);
  world.movement = movement;
  // a world that already has structures (late install): stamp their footprints
  for (const e of world.list) {
    if (!e.alive || !e.tile || e.def.kind === 'unit') continue;
    movement.setFootprintBlocked(e.tile, e.def.footprint.w, e.def.footprint.h, true);
  }
  const vision = new FogOfWar(world);
  world.vision = vision;
  world.orderHandlers.move = moveHandler;
  world.orderHandlers.follow = followHandler;
  world.addSystem({ name: 'movement', order: 30, update: (_w, dt) => movement.update(dt) });
  world.addSystem({ name: 'vision', order: 60, update: () => vision.update() });
  // save/load: per-unit state lives in entity.ext.movement / ext.vision / ext.follow (plain data, saved by the
  // core); module runtime goes through these participants. Seen-building memory is ext.vision.seen.
  world.registerSaveParticipant({
    key: 'movement',
    save: () => movement.saveState(),
    load: (_w, data) => movement.loadState(data as MovementSave),
  });
  world.registerSaveParticipant({
    key: 'vision',
    save: () => vision.saveState(),
    load: (_w, data) => vision.loadState(data as VisionSave),
  });
  internals.set(world, { movement, vision, spatial });
}
