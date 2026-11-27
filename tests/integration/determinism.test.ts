/**
 * [qa] FAST determinism check: the same seed must reproduce the same match exactly (summary + full world-state
 * hash). Catches Math.random()/Date.now() in sim/AI/campaign code, iteration over unordered state, and module
 * globals leaking between matches in one process.
 */
import { describe, expect, it } from 'vitest';
import { describeSummary, fingerprint, runMatch, type MatchSummary } from '../helpers/match';

function firstDifference(a: MatchSummary, b: MatchSummary): string {
  const ka = JSON.parse(fingerprint(a)) as Record<string, unknown>, kb = JSON.parse(fingerprint(b)) as Record<string, unknown>;
  for (const k of Object.keys(ka)) {
    const va = JSON.stringify(ka[k]), vb = JSON.stringify(kb[k]);
    if (va !== vb) return `field "${k}" differs:\n  run A: ${va?.slice(0, 600)}\n  run B: ${vb?.slice(0, 600)}`;
  }
  return 'no difference';
}

describe('determinism (fast)', () => {
  it('same seed → identical summary and world state (bot medium vs AI normal, 3 simulated minutes)', () => {
    const opts = { mapId: 'test', difficulty: 'normal' as const, seed: 5, minutes: 3, bot: 'medium' as const };
    const a = runMatch(opts);
    const b = runMatch(opts);
    console.log(describeSummary(a));
    expect(a.exceptions).toEqual([]);
    expect(b.stateHash, firstDifference(a, b)).toBe(a.stateHash);
    expect(fingerprint(b), firstDifference(a, b)).toBe(fingerprint(a));
  });

  it('a different seed still runs cleanly (outcome may or may not differ)', () => {
    const a = runMatch({ mapId: 'test', difficulty: 'normal', seed: 5, minutes: 1, bot: 'weak' });
    const b = runMatch({ mapId: 'test', difficulty: 'normal', seed: 6, minutes: 1, bot: 'weak' });
    expect(a.exceptions).toEqual([]);
    expect(b.exceptions).toEqual([]);
    console.log(`seed 5 hash ${a.stateHash} vs seed 6 hash ${b.stateHash} (${a.stateHash === b.stateHash ? 'identical — sim does not use the seed yet' : 'differ'})`);
  });
});
