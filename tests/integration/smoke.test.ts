/**
 * [qa] FAST integration smoke: the scripted hospital bot (medium) plays the pathogen AI (normal) on the
 * `test` map for 5 simulated minutes. Every simulation invariant must hold and nothing may throw — neither
 * directly nor swallowed into console.error by World/EventBus.
 */
import { describe, expect, it } from 'vitest';
import { describeSummary, errorViolations, formatExceptions, formatTimeline, formatViolations, runMatch, saveSummary } from '../helpers/match';

describe('integration smoke (fast)', () => {
  it('bot (medium) vs AI (normal) on the test map — 5 simulated minutes, no exceptions, invariants hold', () => {
    const s = runMatch({ mapId: 'test', difficulty: 'normal', seed: 11, minutes: 5, bot: 'medium' });
    console.log(`${describeSummary(s)}\n${formatTimeline(s)}`);
    saveSummary('smoke-test-normal', s);
    expect(s.fallback).toBeNull();
    expect(s.exceptions, formatExceptions(s)).toEqual([]);
    expect(s.consoleErrors, formatExceptions(s)).toEqual([]);
    expect(errorViolations(s), formatViolations(s)).toEqual([]);
    // the match really ran (5 min = 6000 ticks unless someone won early) and both sides did something
    expect(s.gameOver || s.ticks >= 6000, `stopped at tick ${s.ticks}`).toBe(true);
    const p1 = s.players[1]!, p2 = s.players[2]!;
    expect(p1.stats.matterGathered, 'hospital economy is running').toBeGreaterThan(500);
    expect(p2.stats.matterGathered, 'pathogen economy is running').toBeGreaterThan(100);
    expect(p1.stats.unitsTrained, 'hospital trained units').toBeGreaterThan(5);
  });
});
