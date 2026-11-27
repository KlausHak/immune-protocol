/**
 * [combat] Save/load round-trip of combat state, isolated from other modules (stubs only): saved mid-battle
 * with windups, homing + arc shots in flight (one from an already-removed shooter), heal pulses, leashes,
 * a pending emergency-supply drop and Strain Omega's spawn timer — the restored copy must evolve identically.
 */
import { describe, expect, it } from 'vitest';
import { captureWorld, decode, encode, firstDifference, restoreWorld, stateHash } from '../../src/sim/save';
import type { World } from '../../src/sim/World';
import { combatWorld, spawn } from './helpers';

function save(w: World): string {
  const modules: Record<string, unknown> = {};
  for (const p of w.getSaveParticipants()) modules[p.key] = encode(p.save(w), p.key);
  return JSON.stringify({ world: encode(captureWorld(w)), modules });
}
function load(json: string): World {
  const s = JSON.parse(json) as { world: unknown; modules: Record<string, unknown> };
  const w = combatWorld();
  restoreWorld(w, decode(s.world) as Parameters<typeof restoreWorld>[1], s.modules);
  return w;
}

describe('combat save/load', () => {
  it('a mid-battle save evolves identically', () => {
    const a = combatWorld(9);
    const hq = a.spawnBuilding('hosp_hq', 1, { x: 20, y: 60 });
    a.spawnBuilding('hosp_uv_turret', 1, { x: 40, y: 64 });
    const h: number[] = [], p: number[] = [];
    ['hosp_sanitizer', 'hosp_sanitizer', 'hosp_uv_lancer', 'hosp_antibiotic_launcher', 'hosp_medic', 'hosp_medic', 'hosp_sterilizer_drone', 'hosp_macrophage']
      .forEach((d, i) => h.push(spawn(a, d, 1, { x: 38 + (i % 4) * 1.4, y: 70 + Math.floor(i / 4) * 1.6 }).id));
    ['path_phage', 'path_phage', 'path_phage', 'path_bacillus', 'path_bacillus', 'path_fungal_mortar', 'path_superbug', 'path_flu_drifter']
      .forEach((d, i) => p.push(spawn(a, d, 2, { x: 56 + (i % 4) * 1.4, y: 70 + Math.floor(i / 4) * 1.6 }).id));
    const omega = spawn(a, 'path_strain_omega', 2, { x: 75, y: 82 });
    a.issue({ type: 'attackMove', playerId: 1, unitIds: h, target: { x: 70, y: 72 } });
    a.issue({ type: 'attackMove', playerId: 2, unitIds: p, target: { x: 34, y: 72 } });
    a.issue({ type: 'attackMove', playerId: 2, unitIds: [omega.id], target: { x: 40, y: 72 } });
    a.runFor(4.5);
    a.issue({ type: 'buildingAbility', playerId: 1, buildingId: hq.id, abilityId: 'emergency_supply' });
    // advance until there is a shot in flight from a shooter that's already gone from the world
    let tries = 0;
    for (; tries < 400; tries++) {
      a.step();
      const p0 = a.projectiles.find((q) => q.arc);
      if (p0 && tries > 10) { const s = a.get(p0.sourceId); if (s?.alive) { a.killEntity(s); a.step(); break; } }
    }
    expect(a.projectiles.length).toBeGreaterThan(0);
    expect(a.projectiles.some((q) => !a.get(q.sourceId))).toBe(true); // ghost shooter
    expect(a.list.some((e) => e.combat && e.combat.windupLeft > 0) || a.projectiles.length > 1).toBe(true);
    const json = save(a);
    const b = load(json);
    expect(stateHash(b), 'right after load').toBe(stateHash(a));
    const m0 = a.player(1).resources.matter;
    for (let i = 0; i < 20 * 40; i++) {
      a.step(); b.step();
      if (stateHash(a) !== stateHash(b)) throw new Error(`diverged ${i + 1} ticks after load: ${firstDifference(a, b)}`);
    }
    expect(a.player(1).resources.matter).toBeGreaterThanOrEqual(m0 + 100); // the drop landed in both
    expect(a.entitiesOf(2, (e) => e.scriptTags.has('omega_brood')).length).toBeGreaterThan(0);
  });
});
