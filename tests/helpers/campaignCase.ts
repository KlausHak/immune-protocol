/**
 * [qa] Shared campaign-mission integration case. Each mission lives in its own test file
 * (tests/integration/campaign-<id>.test.ts) so Vitest runs them in parallel workers.
 */
import { expect, it } from 'vitest';
import { CAMPAIGN } from '../../src/campaign';
import { describeSummary, errorViolations, formatExceptions, formatProfile, formatViolations, mapRegistered, runMatch, saveSummary } from './match';

const OBJECTIVE_STATES = ['active', 'done', 'failed'];

/** Why a mission can't run yet (not registered / its map not registered), or null. */
export function missionSkipReason(id: string): string | null {
  const info = CAMPAIGN.find((m) => m.id === id);
  if (!info) return `mission ${id} not registered in CAMPAIGN yet`;
  if (!mapRegistered(info.mapId)) return `map "${info.mapId}" for ${id} not registered yet`;
  return null;
}

/** Register the "sets up and runs N simulated minutes" test for one mission. */
export function missionCase(id: string, minutes = Number(process.env.QA_CAMPAIGN_MINUTES ?? 5)): void {
  const info = CAMPAIGN.find((m) => m.id === id);
  const reason = missionSkipReason(id);
  it.skipIf(!!reason)(`${id}${info ? ` "${info.title}"` : ''} sets up and runs ${minutes} simulated minutes with the bot${reason ? ` — SKIPPED: ${reason}` : ''}`, () => {
    const s = runMatch({ mode: 'campaign', missionId: id, difficulty: 'normal', seed: 3, minutes, bot: 'medium', profile: true });
    console.log(`${describeSummary(s)}\n  ${formatProfile(s)}\n  objectives: ${s.mission?.objectives.map((o) => `${o.id}=${o.state}`).join(' ')}`);
    saveSummary(`campaign-${id}`, s);
    expect(s.fallback).toBeNull();
    expect(s.exceptions, formatExceptions(s)).toEqual([]);
    expect(s.consoleErrors, formatExceptions(s)).toEqual([]);
    expect(errorViolations(s), formatViolations(s)).toEqual([]);
    expect(s.mission, 'mission runner present').not.toBeNull();
    expect(s.mission!.id).toBe(id);
    expect(['running', 'won', 'lost']).toContain(s.mission!.state);
    expect(s.mission!.objectives.length, 'objectives() is not empty').toBeGreaterThan(0);
    for (const o of s.mission!.objectives) {
      expect(typeof o.id).toBe('string');
      expect(o.text.length).toBeGreaterThan(0);
      expect(OBJECTIVE_STATES).toContain(o.state);
    }
    if (s.mission!.state !== 'running') expect(s.gameOver, 'a won/lost mission must end the game via world.endGame').toBe(true);
  }, 300_000);
}
