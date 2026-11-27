import { describe, expect, it } from 'vitest';
import { aiMatch, supplyTracker } from './helpers';

/** The real campus map: the normal AI expands, attacks and beats a passive player; difficulties differ. */
describe('AI on meilahti', () => {
  it('normal beats a passive player within 15 minutes', () => {
    const { m, ai } = aiMatch({ mapId: 'meilahti', difficulty: 'normal', seed: 3 });
    const supply = supplyTracker(m);
    m.runFor(900, () => supply.tick());
    expect(m.world.rules.gameOver).toBe(true);
    expect(m.world.rules.winnerTeam).toBe(m.world.player(2).team);
    expect(supply.max()).toBeLessThan(20);
    expect(ai.debugState().wavesLaunched).toBeGreaterThan(0);
    expect(ai.debugState().errors).toBe(0);
  });

  it('easy and hard differ: hard has more income and waves earlier/larger', () => {
    const probe = (difficulty: 'easy' | 'hard') => {
      const { m, ai } = aiMatch({ mapId: 'meilahti', difficulty, personality: 'balanced', seed: 3 });
      m.runFor(200);
      const st = ai.debugState();
      return { gathered: m.world.player(2).stats.matterGathered, workers: st.workers, waveAt: st.nextWaveAt, waveSize: st.nextWaveSize };
    };
    const easy = probe('easy'), hard = probe('hard');
    expect(hard.gathered).toBeGreaterThan(easy.gathered * 1.3);
    expect(hard.workers).toBeGreaterThan(easy.workers);
    expect(hard.waveAt).toBeLessThan(easy.waveAt - 90);
    expect(hard.waveSize).toBeGreaterThan(easy.waveSize);
  });
});
