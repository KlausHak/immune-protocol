/** [ai] Shared helpers for AI tests: headless matches with a forced personality and a passive player 1. */
import { createAi, type PathogenAi, type Personality } from '../../src/ai';
import type { Difficulty } from '../../src/core/types';
import { createHeadlessMatch, type HeadlessMatch } from '../../src/game/headless';

export interface AiMatch { m: HeadlessMatch; ai: PathogenAi }

/** Match on `mapId` with our AI as player 2. passive=true: player 1's workers are stopped and it never acts. */
export function aiMatch(opts: { mapId?: string; difficulty?: Difficulty; seed?: number; personality?: Personality; passive?: boolean } = {}): AiMatch {
  const difficulty = opts.difficulty ?? 'normal';
  const m = createHeadlessMatch({ mapId: opts.mapId ?? 'test', difficulty, seed: opts.seed ?? 1, enemyAi: false });
  const ai = createAi(m.world, 2, { difficulty, personality: opts.personality }) as PathogenAi;
  m.ais.push(ai);
  if (opts.passive !== false) {
    const w = m.world;
    w.issue({ type: 'stop', playerId: 1, unitIds: w.entitiesOf(1, (e) => e.kind === 'unit').map((e) => e.id) });
  }
  return { m, ai };
}

/** Longest contiguous time (s) the player had popUsed >= popCap below the 150 cap, measured while running. */
export function supplyTracker(m: HeadlessMatch, playerId = 2): { tick(): void; max(): number } {
  let cur = 0, max = 0;
  return {
    tick() {
      const p = m.world.player(playerId);
      if (p.popUsed >= p.popCap && p.popCap < 150) { cur += m.world.dt; if (cur > max) max = cur; } else cur = 0;
    },
    max: () => max,
  };
}
