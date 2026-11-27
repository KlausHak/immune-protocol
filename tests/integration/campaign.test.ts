/**
 * [qa] FAST campaign contract checks. The per-mission 5-minute runs live in campaign-m1/m2/m3.test.ts (parallel
 * files); any EXTRA mission registered beyond m1–m3 is run here. Missions/maps not registered yet are skipped.
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGN, createMission } from '../../src/campaign';
import { createHeadlessMatch } from '../../src/game/headless';
import { missionCase, missionSkipReason } from '../helpers/campaignCase';

const EXPECTED = ['m1', 'm2', 'm3'];

describe('campaign (fast)', () => {
  it('m1–m3 are all registered in CAMPAIGN', () => {
    expect(EXPECTED.filter((id) => !CAMPAIGN.some((m) => m.id === id)), 'missing missions').toEqual([]);
  });

  for (const extra of CAMPAIGN.map((m) => m.id).filter((id) => !EXPECTED.includes(id))) missionCase(extra);

  const runnable = CAMPAIGN.filter((m) => !missionSkipReason(m.id));
  it.skipIf(!runnable.length)('mission setup follows the MissionRunner contract (autoDefeat off, both sides spawned, createMission(id) honours id)', () => {
    for (const info of runnable) {
      const m = createHeadlessMatch({ mode: 'campaign', missionId: info.id, enemyAi: true });
      expect(m.mission?.info.id, `${info.id}: headless match runs the requested mission`).toBe(info.id);
      expect(m.world.rules.autoDefeat, `${info.id}: setup() must set world.rules.autoDefeat = false`).toBe(false);
      expect(m.world.entitiesOf(1).length, `${info.id}: player forces spawned`).toBeGreaterThan(0);
      expect(m.world.entitiesOf(2).length, `${info.id}: enemy forces spawned`).toBeGreaterThan(0);
      const again = createMission(info.id, { world: m.world, playerId: 1, enemyId: 2, ai: null, difficulty: 'normal' });
      expect(again.info.id).toBe(info.id);
      expect(info.briefing.length, `${info.id}: briefing`).toBeGreaterThan(0);
      expect(info.objectivesPreview.length, `${info.id}: objectivesPreview`).toBeGreaterThan(0);
    }
  });
});
