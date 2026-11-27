/**
 * Balance probes: a scripted competent player (tests/campaign/bot.ts) plays each mission on the real
 * 'meilahti' map against the real AI. Slow (~1 min per run), so skipped unless CAMPAIGN_BALANCE=1:
 *   CAMPAIGN_BALANCE=1 npx vitest run tests/campaign/balance.test.ts
 * Results are appended to /tmp/campaign-balance.log. Assertions are deliberately loose (they guard the
 * design intent: normal is beatable by the bot; nothing throws).
 */
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ScriptedMission } from '../../src/campaign/script';
import { dist } from '../../src/core/math';
import type { Difficulty, Vec2 } from '../../src/core/types';
import { createHeadlessMatch } from '../../src/game/headless';
import { PlayerBot, type BotPlan } from './bot';
import { hasMeilahti } from './helpers';

const ENABLED = !!process.env.CAMPAIGN_BALANCE && hasMeilahti();
const LIMIT = 35 * 60;
const cases: Array<[string, Difficulty]> = [];
for (const m of (process.env.CAMPAIGN_MISSIONS ?? 'm1,m2,m3').split(',')) for (const d of (process.env.CAMPAIGN_DIFFS ?? 'easy,normal,hard').split(',')) cases.push([m, d as Difficulty]);

function planFor(missionId: string, mission: ScriptedMission, bot: () => PlayerBot): BotPlan {
  const s = mission.script;
  const pos = (tag: string): Vec2 | null => { const e = s.firstTagged(tag); return e ? { ...e.pos } : null; };
  const anyHive = (): Vec2 | null => { const h = s.world.entitiesOf(2, (e) => e.defId === 'path_hive')[0]; return h ? { ...h.pos } : null; };
  if (missionId === 'm1') {
    let sent = false;
    return {
      target: () => pos('core') ?? anyHive(), attackSize: 18, attackAfter: 540,
      extra: (b) => {
        if (sent || s.time < 70) return;
        sent = true;
        const squad = b.army().slice(0, 3).map((u) => u.id);
        const st = s.refs.region('paramedic_station');
        s.world.issue({ type: 'attackMove', playerId: 1, unitIds: squad, target: { x: st.x + st.w / 2, y: st.y + st.h / 2 } });
      },
    };
  }
  if (missionId === 'm2') {
    return {
      target: () => {
        const sats = ['sat_east', 'sat_west'].map((t) => s.firstTagged(t)).filter((e) => !!e);
        if (!sats.length) return pos('main_core') ?? anyHive();
        const army = bot().army();
        const c = army.length ? { x: army.reduce((a, u) => a + u.pos.x, 0) / army.length, y: army.reduce((a, u) => a + u.pos.y, 0) / army.length } : s.refs.point('player_start');
        sats.sort((a, b) => dist(a!.pos, c) - dist(b!.pos, c));
        return { ...sats[0]!.pos };
      },
      attackSize: 16, attackAfter: 150,
    };
  }
  return {
    muster: () => pos('childrens'),
    target: () => {
      const omega = s.firstTagged('boss');
      if (omega) return { ...omega.pos };
      return s.objectives.isDone('omega') ? pos('core') ?? anyHive() : null;
    },
    attackSize: 1, attackAfter: 0, turrets: 3,
  };
}

describe.skipIf(!ENABLED)('campaign balance probes (meilahti, scripted player)', () => {
  it.each(cases)('%s on %s', (missionId, difficulty) => {
    const t0 = Date.now();
    const m = createHeadlessMatch({ mode: 'campaign', missionId, difficulty, seed: 42 });
    const mission = m.mission as unknown as ScriptedMission;
    let bot!: PlayerBot;
    bot = new PlayerBot(m, planFor(missionId, mission, () => bot));
    let peakArmy = 0;
    m.runFor(LIMIT, () => { bot.tick(); if (m.world.tick % 200 === 0) peakArmy = Math.max(peakArmy, bot.army().length); });
    const w = m.world, s = mission.script, me = w.player(1), foe = w.player(2);
    const objectives = mission.objectives().map((o) => `${o.id}:${o.state}`).join(' ');
    const line = `${missionId} ${difficulty.padEnd(6)} → ${mission.state.padEnd(7)} at ${(s.time / 60).toFixed(1)} min (${s.endReason ?? 'timeout'}) · ` +
      `lost ${me.stats.unitsLost}u/${me.stats.buildingsLost}b · killed ${me.stats.unitsKilled}u/${me.stats.buildingsKilled}b · peak army ${peakArmy} · attacks ${bot.attacks} · ` +
      `${objectives} · ai: ${m.ais[0]?.describe() ?? '-'} · ${((Date.now() - t0) / 1000).toFixed(0)}s`;
    appendFileSync('/tmp/campaign-balance.log', `${line}\n`);
    expect(s.errors).toBe(0);
    if (difficulty === 'normal') expect(mission.state).not.toBe('running');
  }, 600_000);
});
