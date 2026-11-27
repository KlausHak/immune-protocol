import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/core/types';
import type { SimSystem } from '../../src/sim/services';
import { getMap } from '../../src/map';
import type { MapData } from '../../src/core/types';
import { internals, makeWorld } from './helpers';

/** Thread CPU ms (robust when the shared machine is overloaded); falls back to wall time. */
const cpuMs = (): number => {
  const f = (process as unknown as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage;
  if (!f) return performance.now();
  const c = f.call(process);
  return (c.user + c.system) / 1000;
};

/**
 * 150 units (small, large, air) cross the test map in several group commands plus individual orders, then
 * everybody is re-ordered back mid-way — 30 simulated seconds. Only the movement + vision systems are timed.
 */
function crossing(map: MapData | undefined, label: string, from: { x: number; y: number }, to: { x: number; y: number }) {
    const w = makeWorld(map);
    const mix: Array<[string, number]> = [['hosp_sanitizer', 90], ['hosp_uv_lancer', 20], ['hosp_antibiotic_launcher', 15], ['hosp_macrophage', 10], ['hosp_sterilizer_drone', 15]];
    const units: Entity[] = [];
    let k = 0;
    for (const [defId, n] of mix) for (let i = 0; i < n; i++, k++) {
      const p = w.movement.nearestWalkable({ x: from.x + (k % 12) * 1.6 - 9, y: from.y + Math.floor(k / 12) * 1.6 - 10 }, 12)!;
      units.push(w.spawnUnit(defId, 1, p));
    }
    expect(units.length).toBe(150);
    // time only our systems
    const systems = (w as unknown as { systems: SimSystem[] }).systems;
    const samples: number[] = [];
    let acc = 0;
    for (const s of systems) {
      if (s.name !== 'movement' && s.name !== 'vision') continue;
      const f = s.update;
      s.update = (ww, dt) => { const t0 = cpuMs(); f(ww, dt); acc += cpuMs() - t0; };
    }
    const order = (targetFor: (i: number) => { x: number; y: number }) => {
      // 5 group commands of 24 + 30 individual orders
      for (let g = 0; g < 5; g++) {
        const ids = units.slice(g * 24, g * 24 + 24).map((u) => u.id);
        w.issue({ type: 'move', playerId: 1, unitIds: ids, target: targetFor(g) });
      }
      for (let i = 120; i < 150; i++) w.issue({ type: 'move', playerId: 1, unitIds: [units[i]!.id], target: targetFor(i) });
    };
    order((i) => ({ x: to.x + (i % 5) * 4 - 8, y: to.y + (i % 7) * 3 - 9 }));
    const ticks = Math.round(30 / w.dt);
    const wall0 = performance.now();
    for (let t = 0; t < ticks; t++) {
      if (t === Math.round(15 / w.dt)) order((i) => ({ x: from.x + (i % 5) * 4 - 8, y: from.y + (i % 6) * 3 - 8 }));
      acc = 0;
      w.step();
      samples.push(acc);
    }
    const wallPerTick = (performance.now() - wall0) / ticks;
    const sorted = [...samples].sort((a, b) => a - b);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!, max = sorted[sorted.length - 1]!;
    const st = internals(w).movement.stats;
    console.log(`[movement perf ${label}] 150 units, ${ticks} ticks: movement+vision CPU avg ${avg.toFixed(2)} ms/tick, p95 ${p95.toFixed(2)}, max ${max.toFixed(2)}; whole world.step wall ${wallPerTick.toFixed(2)} ms | `
      + `A* ${st.astar}, field paths ${st.fieldPaths} (${st.fields} fields), direct ${st.direct}, max queue ${st.maxQueue}`);
    // the machine is shared by many processes: allow headroom over the ~6 ms design target
    expect(avg).toBeLessThan(9);
    expect(p95).toBeLessThan(12);
    expect(units.filter((u) => u.mover!.blockedTime >= 3).length).toBeLessThanOrEqual(3);
}

describe('performance', () => {
  it('150 units re-pathing across the test map: movement + vision stay within budget', () => {
    crossing(undefined, 'test', { x: 14, y: 22 }, { x: 70, y: 62 });
  });
  it('150 units crossing the meilahti campus between the bases', () => {
    const map = getMap('meilahti');
    if (map.id !== 'meilahti') return;
    crossing(map, 'meilahti', map.points.player_start ?? map.slots[0]!.start, map.points.enemy_start ?? map.slots[1]!.start);
  });
});
