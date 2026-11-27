import { describe, expect, it } from 'vitest';
import { aiMatch } from './helpers';

/** Every personality must be able to close out a game against a passive opponent. */
describe('AI personalities beat a passive player', () => {
  for (const personality of ['swarm', 'tech'] as const) {
    it(`${personality} wins within 15 minutes`, () => {
      const { m, ai } = aiMatch({ difficulty: 'normal', personality, seed: 2 });
      m.runFor(900);
      expect(ai.debugState().personality).toBe(personality);
      expect(m.world.rules.gameOver).toBe(true);
      expect(m.world.rules.winnerTeam).toBe(m.world.player(2).team);
      expect(ai.debugState().errors).toBe(0);
    });
  }
});
