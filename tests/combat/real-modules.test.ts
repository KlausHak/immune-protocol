/**
 * [combat] The same behaviours against the REAL movement / vision / economy modules (createWorld).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMap } from '../../src/map';
import { createWorld } from '../../src/sim/setup';
import type { World } from '../../src/sim/World';
import { record, runUntil, spawn } from './helpers';

function realWorld(): World {
  const w = createWorld(getMap('test'), [
    { id: 1, faction: 'hospital', team: 1, controller: 'human' },
    { id: 2, faction: 'pathogen', team: 2, controller: 'ai' },
  ], 2);
  w.rules.autoDefeat = false;
  return w;
}

describe('combat with the real modules', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errors = vi.spyOn(console, 'error'); });
  afterEach(() => { errors.mockRestore(); });

  it('fog is fair: an attacker outside our vision is not acquired, even when it hits us', () => {
    const w = realWorld();
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 40, y: 80 });
    const mortar = spawn(w, 'path_fungal_mortar', 2, { x: 50.4, y: 80 }); // edge 9.25 > sight 9, within range 10
    w.runFor(0.5);
    expect(w.vision.isEntityVisible(1, mortar)).toBe(false);
    w.issue({ type: 'attack', playerId: 2, unitIds: [mortar.id], targetId: s.id });
    runUntil(w, () => s.lastAttackerId === mortar.id, 8);
    w.runFor(1);
    expect(s.combat!.targetId).toBeNull();
    expect(Math.abs(s.pos.x - 40)).toBeLessThan(0.6); // didn't charge an invisible enemy
    // a scout reveals it → now it is a fair target
    spawn(w, 'hosp_sanitizer', 1, { x: 46, y: 80 });
    runUntil(w, () => s.combat!.targetId === mortar.id, 3);
    expect(s.combat!.targetId).toBe(mortar.id);
  });

  it('40-vs-40 brawl with real pathing/collision ends with a winner, no errors', () => {
    const w = realWorld();
    const mk = (owner: 1 | 2, ids: string[], x0: number) => ids.flatMap((d, k) => Array.from({ length: 8 }, (_, i) =>
      spawn(w, d, owner, { x: x0 + (owner === 1 ? -k * 1.6 : k * 1.6), y: 60 + i * 2 }).id));
    const h = mk(1, ['hosp_sanitizer', 'hosp_uv_lancer', 'hosp_medic', 'hosp_macrophage', 'hosp_antibiotic_launcher'], 44);
    const p = mk(2, ['path_phage', 'path_bacillus', 'path_spirochete', 'path_superbug', 'path_fungal_mortar'], 70);
    w.issue({ type: 'attackMove', playerId: 1, unitIds: h, target: { x: 80, y: 68 } });
    w.issue({ type: 'attackMove', playerId: 2, unitIds: p, target: { x: 36, y: 68 } });
    const fired = record(w, 'weaponFired');
    const alive = (o: number) => w.entitiesOf(o, (e) => e.kind === 'unit').length;
    runUntil(w, () => alive(1) === 0 || alive(2) === 0, 240);
    console.log(`[real brawl] t=${w.time.toFixed(1)} hospital ${alive(1)} pathogen ${alive(2)} shots ${fired.length}`);
    expect(alive(1) === 0 || alive(2) === 0).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    for (const e of w.list) if (e.alive) expect(e.hp).toBeGreaterThan(0);
  });
});
