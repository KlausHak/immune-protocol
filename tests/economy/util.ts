/** Shared helpers for the economy tests (test map, no enemy AI). */
import { createHeadlessMatch, type HeadlessMatch } from '../../src/game/headless';
import type { Entity, GameEvents, PlayerId, TilePos, Vec2 } from '../../src/core/types';
import type { World } from '../../src/sim/World';

export function newMatch(seed = 1): HeadlessMatch {
  return createHeadlessMatch({ mapId: 'test', enemyAi: false, seed });
}

export const hqOf = (w: World, pid: PlayerId = 1): Entity =>
  w.entitiesOf(pid, (e) => e.kind === 'building' && (e.defId === 'hosp_hq' || e.defId === 'path_hive'))[0]!;

export const workersOf = (w: World, pid: PlayerId = 1): Entity[] => w.entitiesOf(pid, (e) => e.kind === 'unit' && !!e.gatherer);

export const caches = (w: World): Entity[] => w.list.filter((e) => e.alive && e.kind === 'resource');

/** The n caches closest to a point. */
export function cachesNear(w: World, p: Vec2, n = 6): Entity[] {
  return caches(w).sort((a, b) => Math.hypot(a.pos.x - p.x, a.pos.y - p.y) - Math.hypot(b.pos.x - p.x, b.pos.y - p.y)).slice(0, n);
}

/** Step until pred() is true (returns elapsed seconds) or maxSec passes (returns -1). */
export function runUntil(m: HeadlessMatch, pred: () => boolean, maxSec: number): number {
  const w = m.world;
  const t0 = w.time;
  const n = Math.round(maxSec / w.dt);
  for (let i = 0; i < n; i++) {
    if (pred()) return w.time - t0;
    m.step();
  }
  return pred() ? w.time - t0 : -1;
}

/** Collect emitted events of one type. */
export function record<K extends keyof GameEvents>(w: World, type: K): Array<GameEvents[K]> {
  const out: Array<GameEvents[K]> = [];
  w.events.on(type, (p) => out.push(p));
  return out;
}

/** Spawn a completed building (no cost). */
export const spawnDone = (w: World, defId: string, owner: PlayerId, tile: TilePos): Entity => w.spawnBuilding(defId, owner, tile, { complete: true });

/** Stop every worker of a player (clears their gather orders) so tests start from a quiet base. */
export function idleAll(m: HeadlessMatch, pid: PlayerId = 1): void {
  const w = m.world;
  w.issue({ type: 'stop', playerId: pid, unitIds: workersOf(w, pid).map((u) => u.id) });
  m.step();
}

export function addWorkers(w: World, n: number, near: Vec2, pid: PlayerId = 1, defId = 'hosp_orderly'): Entity[] {
  const out: Entity[] = [];
  for (let i = 0; i < n; i++) {
    const p = w.movement.nearestWalkable({ x: near.x + (i % 4) - 1.5, y: near.y + Math.floor(i / 4) }, 6) ?? near;
    out.push(w.spawnUnit(defId, pid, p));
  }
  return out;
}
