import { describe, expect, it } from 'vitest';
import { aiMatch, supplyTracker } from './helpers';

/** The headline requirement: on normal, vs a completely passive opponent, the AI macros up and wins. */
describe('AI vs a passive player (normal, test map)', () => {
  it('builds economy and army, never supply-blocks > 20 s, attacks and wins within 15 minutes', () => {
    const { m, ai } = aiMatch({ difficulty: 'normal', personality: 'balanced', seed: 1 });
    const w = m.world;
    const supply = supplyTracker(m);
    let workersAt5 = -1, attackedAt = -1, damageToP1 = 0;
    w.events.on('entityDamaged', ({ entity, source }) => { if (entity.owner === 1 && source?.owner === 2) damageToP1 += 1; });
    let winner: number | null = null, overAt = -1;
    w.events.on('gameOver', ({ winnerTeam }) => { winner = winnerTeam; overAt = w.time; });
    m.runFor(900, () => {
      supply.tick();
      if (workersAt5 < 0 && w.time >= 300) workersAt5 = ai.debugState().workers;
      if (attackedAt < 0 && ai.debugState().wavesLaunched > 0) attackedAt = w.time;
    });
    const count = (id: string) => w.countOf(2, id);
    expect(workersAt5, 'workers at 5:00').toBeGreaterThanOrEqual(14);
    expect(count('path_replicator')).toBeGreaterThanOrEqual(1);
    expect(count('path_nest')).toBeGreaterThanOrEqual(2);
    expect(supply.max(), 'longest supply block (s)').toBeLessThan(20);
    expect(attackedAt, 'first wave launched').toBeGreaterThan(0);
    expect(damageToP1).toBeGreaterThan(0);
    expect(w.rules.gameOver).toBe(true);
    expect(winner).toBe(w.player(2).team);
    expect(overAt).toBeLessThan(900);
    expect(ai.debugState().errors).toBe(0);
    expect(ai.describe()).toMatch(/^phase: \S+ · army \d+ \(value \d+\) · workers \d+ · income \d+\/min · next wave .+$/);
  });
});
