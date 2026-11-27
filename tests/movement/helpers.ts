/**
 * [movement] Test helpers: worlds on the test map (or a variant), unit spawning, invariant checks.
 */
import type { Entity, MapData, Vec2 } from '../../src/core/types';
import { createTestMap } from '../../src/map/testMap';
import { getMovementInternals, type MovementInternals } from '../../src/sim/movement';
import { createWorld } from '../../src/sim/setup';
import type { World } from '../../src/sim/World';

/** Two-player world (hospital vs pathogen) with every sim module installed and auto-defeat off. */
export function makeWorld(map: MapData = createTestMap(), seed = 1): World {
  const w = createWorld(map, [
    { id: 1, faction: 'hospital', team: 1, controller: 'human' },
    { id: 2, faction: 'pathogen', team: 2, controller: 'ai' },
  ], seed);
  w.rules.autoDefeat = false; // no buildings in most tests: don't end the game at tick 10
  return w;
}

export function internals(w: World): MovementInternals {
  const i = getMovementInternals(w);
  if (!i) throw new Error('movement module not installed');
  return i;
}

/** Test map with extra statically blocked tiles. */
export function mapWith(block: (x: number, y: number) => boolean, levels?: (x: number, y: number) => number): MapData {
  const map = createTestMap();
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const i = y * map.width + x;
    if (block(x, y)) { map.blocked[i] = 1; map.buildable[i] = 0; }
    if (levels) map.levels[i] = levels(x, y);
  }
  return map;
}

/** Spawn n units of a type in a compact grid starting at p. */
export function spawnGrid(w: World, defId: string, owner: number, n: number, p: Vec2, spacing = 1.0, cols = 5): Entity[] {
  const out: Entity[] = [];
  for (let i = 0; i < n; i++) out.push(w.spawnUnit(defId, owner, { x: p.x + (i % cols) * spacing, y: p.y + Math.floor(i / cols) * spacing }));
  return out;
}

/** Ground units whose circle overlaps a blocked tile by more than `tol` (should never happen). */
export function wallViolations(w: World, tol = 0.02): Entity[] {
  const nav = internals(w).movement.nav;
  return w.list.filter((e) => e.alive && e.kind === 'unit' && !e.mover?.flying
    && (nav.isBlockedTile(Math.floor(e.pos.x), Math.floor(e.pos.y)) || !nav.circleFree(e.pos.x, e.pos.y, Math.max(0, e.radius - tol))));
}

/** Step (at least once) until cond() or the time limit; returns seconds simulated. */
export function runUntil(w: World, maxSeconds: number, cond: () => boolean, each?: () => void): number {
  const n = Math.round(maxSeconds / w.dt);
  for (let i = 1; i <= n; i++) {
    w.step();
    each?.();
    if (cond()) return i * w.dt;
  }
  return maxSeconds;
}

/** Largest pairwise overlap (r1 + r2 − d) among the given ground units. */
export function maxOverlap(units: Entity[]): number {
  let worst = 0;
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
    const a = units[i]!, b = units[j]!;
    worst = Math.max(worst, a.radius + b.radius - Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y));
  }
  return worst;
}
