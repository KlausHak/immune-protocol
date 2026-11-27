import { describe, expect, it, vi } from 'vitest';
import type { Entity } from '../../src/core/types';
import { aiMatch } from './helpers';

/**
 * 20-minute robustness run against a simple scripted hospital bot that mines, builds a Pharmacy and
 * Wards, trains Sanitizers and attacks — exercises defence, retreats, expansions and teching.
 */
describe('AI long run', () => {
  // ~90 s wall: dominated by the sim's movement/orders systems at ~150 entities, not the AI (≈10%).
  it('plays 20 minutes against an active bot without throwing', { timeout: 240_000 }, () => {
    const errSpy = vi.spyOn(console, 'error');
    const { m, ai } = aiMatch({ difficulty: 'easy', seed: 9, passive: false });
    const w = m.world;
    w.rules.autoDefeat = false; // keep the match running the full 20 minutes even if the bot is wiped out
    const me = 1;
    const bot = (): void => {
      if (w.tick % 40) return;
      const p = w.player(me);
      const mine = (f: (e: Entity) => boolean) => w.entitiesOf(me, f);
      const hq = mine((e) => e.defId === 'hosp_hq')[0];
      const workers = mine((e) => !!e.gatherer);
      if (!hq) return;
      if (workers.length < 14 && !hq.production?.queue.length) w.issue({ type: 'train', playerId: me, buildingId: hq.id, defId: 'hosp_orderly' });
      const node = w.spatial.nearest(hq.pos, 14, (e) => e.kind === 'resource');
      const idle = workers.filter((u) => !u.orders.length);
      if (idle.length && node) w.issue({ type: 'gather', playerId: me, unitIds: idle.map((u) => u.id), targetId: node.id });
      const building = (id: string) => w.countOf(me, id);
      const tryBuild = (id: string, dx: number, dy: number): void => {
        const b = workers[0]; if (!b) return;
        w.issue({ type: 'build', playerId: me, unitIds: [b.id], defId: id, tile: { x: Math.round(hq.pos.x + dx), y: Math.round(hq.pos.y + dy) } });
      };
      if (p.popCap - p.popUsed < 3 && w.tick % 400 === 0) tryBuild('hosp_ward', 4 + building('hosp_ward') * 3, -8);
      if (!building('hosp_pharmacy') && p.resources.matter >= 150) tryBuild('hosp_pharmacy', 6, -3);
      for (const ph of mine((e) => e.defId === 'hosp_pharmacy' && !e.construction)) {
        if ((ph.production?.queue.length ?? 0) < 2) w.issue({ type: 'train', playerId: me, buildingId: ph.id, defId: 'hosp_sanitizer' });
      }
      const army = mine((e) => e.defId === 'hosp_sanitizer');
      if (w.time > 420 && w.tick % 3600 === 0 && army.length >= 8) w.issue({ type: 'attackMove', playerId: me, unitIds: army.map((u) => u.id), target: { x: 76, y: 20 } });
    };
    m.runFor(1200, bot);
    expect(w.time).toBeGreaterThanOrEqual(1199);
    const st = ai.debugState();
    expect(st.errors).toBe(0);
    expect(errSpy.mock.calls.filter((c) => String(c[0]).includes('[ai]'))).toHaveLength(0);
    expect(st.defenseResponses + st.wavesLaunched).toBeGreaterThan(0);
    errSpy.mockRestore();
  });
});
