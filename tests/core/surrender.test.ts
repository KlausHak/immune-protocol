import { expect, it } from 'vitest';
import { createHeadlessMatch } from '../../src/game/headless';
it('surrender ends the game for the other team', () => {
  const m = createHeadlessMatch({ mapId: 'test', enemyAi: false });
  m.world.issue({ type: 'surrender', playerId: 1 }); m.step();
  expect(m.world.player(1).defeated).toBe(true); expect(m.world.rules.gameOver).toBe(true); expect(m.world.rules.winnerTeam).toBe(2);
});
