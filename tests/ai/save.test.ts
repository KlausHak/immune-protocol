import { describe, expect, it } from 'vitest';
import type { PathogenAi } from '../../src/ai';
import { createHeadlessMatch, loadHeadlessMatch, saveHeadlessMatch, type HeadlessMatch } from '../../src/game/headless';
import { firstDifference, stateHash, type SaveGame } from '../../src/sim/save';

/**
 * AI save/load: a match saved while the AI is mid-attack (squad, waves, memory, threats, scouting, pending builds
 * all live) must evolve identically after a JSON round-trip into a fresh world + fresh AI.
 */
function evolveTogether(a: HeadlessMatch, b: HeadlessMatch, seconds: number): void {
  expect(stateHash(b.world)).toBe(stateHash(a.world));
  for (let i = 0; i < Math.round(seconds / a.world.dt); i++) {
    a.step(); b.step();
    if (stateHash(a.world) !== stateHash(b.world)) throw new Error(`diverged ${i + 1} ticks after load (tick ${a.world.tick}): ${firstDifference(a.world, b.world)}`);
    if (a.world.rules.gameOver) break;
  }
  expect(b.ais[0]!.describe()).toBe(a.ais[0]!.describe());
}

describe('AI save/load round-trip', () => {
  for (const [mapId, at] of [['test', 330], ['meilahti', 320]] as const) {
    it(`${mapId}: a save during the AI's first attack evolves identically for 40 s`, () => {
      const a = createHeadlessMatch({ mapId, seed: 3, difficulty: 'normal' });
      a.runFor(at);
      expect(a.world.rules.gameOver).toBe(false);
      const st = (a.ais[0] as PathogenAi).debugState();
      expect(st.wavesLaunched + st.army, 'AI has an army / wave at save time').toBeGreaterThan(0);
      const save = JSON.parse(JSON.stringify(saveHeadlessMatch(a, `ai-${mapId}`))) as SaveGame;
      const b = loadHeadlessMatch(save);
      expect((b.ais[0] as PathogenAi).debugState()).toEqual(st);
      evolveTogether(a, b, 40);
    });
  }
});
