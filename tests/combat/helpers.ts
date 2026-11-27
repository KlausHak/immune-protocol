/**
 * [combat] Test helpers: an isolated world on the test map with the architect's stubs for every other
 * module (straight-line movement, everything visible, simple economy) plus the real combat module.
 */
import type { Entity, PlayerId, Vec2 } from '../../src/core/types';
import { getMap } from '../../src/map';
import { installCombat } from '../../src/sim/combat';
import { installStubs } from '../../src/sim/stubs';
import { World } from '../../src/sim/World';

export function combatWorld(seed = 1): World {
  const world = new World({
    map: getMap('test'),
    players: [
      { id: 1, name: 'Hospital', faction: 'hospital', team: 1, color: 0x2fd6c6, controller: 'human', resources: { matter: 0, energy: 0 } },
      { id: 2, name: 'Contagion', faction: 'pathogen', team: 2, color: 0xd64bff, controller: 'ai', resources: { matter: 0, energy: 0 } },
    ],
    seed,
  });
  installStubs(world);
  installCombat(world);
  world.rules.autoDefeat = false; // no buildings in most scenarios — don't end the game at tick 10
  world.vision.revealAll(1, true);
  world.vision.revealAll(2, true);
  return world;
}

export const spawn = (w: World, defId: string, owner: PlayerId, pos: Vec2, facing = 0): Entity => w.spawnUnit(defId, owner, pos, { facing });

/** Record events of one type. */
export function record<K extends keyof import('../../src/core/types').GameEvents>(w: World, type: K): Array<import('../../src/core/types').GameEvents[K]> {
  const out: Array<import('../../src/core/types').GameEvents[K]> = [];
  w.events.on(type, (p) => out.push(p));
  return out;
}

/** Step until `cond` holds or `seconds` pass; returns elapsed seconds (Infinity if it never held). */
export function runUntil(w: World, cond: () => boolean, seconds: number): number {
  const n = Math.round(seconds / w.dt);
  for (let i = 0; i < n; i++) { if (cond()) return i * w.dt; w.step(); }
  return cond() ? n * w.dt : Infinity;
}
