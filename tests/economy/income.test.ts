import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/core/types';
import { incomeRate, workersOnNode } from '../../src/sim/economy';
import { addWorkers, cachesNear, hqOf, newMatch } from './util';

/** n workers sent (one group command) to the 6 caches next to the test-map HQ; returns matter/min after warm-up. */
function measure(n: number): { perMin: number; rolling: number; perCache: number[] } {
  const m = newMatch();
  const w = m.world;
  const hq = hqOf(w);
  const workers: Entity[] = w.entitiesOf(1, (e) => !!e.gatherer);
  workers.push(...addWorkers(w, n - workers.length, { x: hq.pos.x, y: hq.pos.y + 4 }));
  const field = cachesNear(w, hq.pos, 6);
  w.issue({ type: 'gather', playerId: 1, unitIds: workers.map((u) => u.id), targetId: field[0]!.id });
  m.runFor(30);
  const p = w.player(1);
  const g0 = p.stats.matterGathered;
  m.runFor(60);
  return { perMin: p.stats.matterGathered - g0, rolling: incomeRate(w, 1).matterPerMin, perCache: field.map((c) => workersOnNode(w, c.id)) };
}

describe('income', () => {
  it('6 workers ≈ 300/min, 12 workers ≈ 500–650/min, a 3rd worker per cache adds little', () => {
    const six = measure(6), twelve = measure(12), eighteen = measure(18);
    expect(six.perCache).toEqual([1, 1, 1, 1, 1, 1]);
    expect(twelve.perCache).toEqual([2, 2, 2, 2, 2, 2]);
    expect(six.perMin).toBeGreaterThan(250);
    expect(six.perMin).toBeLessThan(360);
    expect(twelve.perMin).toBeGreaterThan(500);
    expect(twelve.perMin).toBeLessThan(650);
    expect(twelve.perMin).toBeGreaterThan(six.perMin * 1.7);    // ~2 workers per cache is efficient
    expect(eighteen.perMin).toBeLessThan(twelve.perMin * 1.35); // more queue
    // the rolling-window rate matches what was actually delivered
    for (const r of [six, twelve, eighteen]) expect(Math.abs(r.rolling - r.perMin) / r.perMin).toBeLessThan(0.08);
  });

  it('incomeRate tracks a rolling window and is 0 for an idle economy', () => {
    const m = newMatch();
    const w = m.world;
    expect(incomeRate(w, 1)).toEqual({ matterPerMin: 0, energyPerMin: 0 });
    m.runFor(40);
    const a = incomeRate(w, 1);
    expect(a.matterPerMin).toBeGreaterThan(150);
    expect(a.energyPerMin).toBeCloseTo(15, 0); // HQ: 0.25 Power/s
    w.issue({ type: 'stop', playerId: 1, unitIds: w.entitiesOf(1, (e) => !!e.gatherer).map((u) => u.id) });
    m.runFor(65);
    expect(incomeRate(w, 1).matterPerMin).toBe(0);
    expect(incomeRate(w, 1, 10).energyPerMin).toBeCloseTo(15, 0);
    expect(incomeRate(w, 99)).toEqual({ matterPerMin: 0, energyPerMin: 0 });
  });
});
