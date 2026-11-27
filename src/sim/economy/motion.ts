/**
 * [economy] Thin layer over the MovementService contract: one move request per "leg" (cheap for the mover),
 * arrival by edge distance, a few retries when the mover gives up, then 'stuck'.
 */
import { angleOf, turnToward } from '../../core/math';
import type { Entity, Vec2 } from '../../core/types';
import type { World } from '../World';
import { ARRIVE_SLACK, LEG_RETRIES } from './constants';
import { workerEco, type WorkerEco } from './state';

export type Approach = 'arrived' | 'moving' | 'stuck';

/** Forget the current leg so the next approach issues a fresh move request. */
export function resetLeg(x: WorkerEco): void {
  x.legTarget = null;
  x.legPoint = null;
  x.legRetries = 0;
}

/** Walk until world.edgeDistance(e, t) <= range. */
export function approachEntity(world: World, e: Entity, t: Entity, range: number): Approach {
  const x = workerEco(e);
  const d = world.edgeDistance(e, t);
  if (d <= range + 0.02) return 'arrived';
  if (x.legTarget !== t.id) {
    x.legTarget = t.id; x.legPoint = null; x.legRetries = 0; x.legIssuedTick = world.tick;
    world.movement.moveToEntity(e, t, range);
    return 'moving';
  }
  if (world.tick > x.legIssuedTick && world.movement.hasArrived(e)) {
    if (d <= range + ARRIVE_SLACK) return 'arrived';
    if (x.legRetries < LEG_RETRIES) {
      x.legRetries++; x.legIssuedTick = world.tick;
      world.movement.moveToEntity(e, t, range);
      return 'moving';
    }
    return 'stuck';
  }
  return 'moving';
}

/**
 * Walk to a point leg. `done()` decides arrival (e.g. "next to the build site"); `pick(attempt)` supplies the
 * destination (a different one per retry).
 */
export function approachPoint(world: World, e: Entity, done: () => boolean, closeEnough: () => boolean, pick: (attempt: number) => Vec2 | null): Approach {
  const x = workerEco(e);
  if (done()) return 'arrived';
  if (x.legTarget !== -1 || !x.legPoint) {
    const p = pick(0);
    if (!p) return 'stuck';
    x.legTarget = -1; x.legPoint = p; x.legRetries = 0; x.legIssuedTick = world.tick;
    world.movement.moveTo(e, p, { arriveDistance: 0.15 });
    return 'moving';
  }
  if (world.tick > x.legIssuedTick && world.movement.hasArrived(e)) {
    if (closeEnough()) return 'arrived';
    if (x.legRetries < LEG_RETRIES) {
      x.legRetries++;
      const p = pick(x.legRetries);
      if (!p) return 'stuck';
      x.legPoint = p; x.legIssuedTick = world.tick;
      world.movement.moveTo(e, p, { arriveDistance: 0.15 });
      return 'moving';
    }
    return 'stuck';
  }
  return 'moving';
}

/** Stop the mover if a leg is in flight (idempotent, avoids redundant stop calls every tick). */
export function haltLeg(world: World, e: Entity): void {
  const x = workerEco(e);
  if (x.legTarget != null || e.mover?.moving) world.movement.stop(e);
  resetLeg(x);
}

/** Turn smoothly toward a point while working (renderer interpolates facing). */
export function faceToward(e: Entity, p: Vec2, dt: number): void {
  const dx = p.x - e.pos.x, dy = p.y - e.pos.y;
  if (dx * dx + dy * dy < 1e-8) return;
  e.facing = turnToward(e.facing, angleOf({ x: dx, y: dy }), 10 * dt);
}
