import { describe, expect, it } from 'vitest';
import { decode, encode } from '../../src/sim/save/codec';
import { incomeRate } from '../../src/sim/economy';
import { hqOf, newMatch, record, runUntil, workersOf } from './util';

describe('economy save state', () => {
  it('ext.economy and the economy participant are codec-safe and round-trip losslessly mid-match', () => {
    const m = newMatch();
    const w = m.world;
    const hq = hqOf(w);
    w.player(1).resources.matter = 500;
    w.issue({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
    const started = record(w, 'constructionStarted');
    w.issue({ type: 'build', playerId: 1, unitIds: [workersOf(w)[0]!.id], defId: 'hosp_ward', tile: { x: 25, y: 69 } });
    runUntil(m, () => started.length > 0, 15);
    m.runFor(20); // mining, waiting, construction and production in flight
    const part = w.getSaveParticipants().find((p) => p.key === 'economy')!;
    expect(part).toBeTruthy();
    const data = JSON.parse(JSON.stringify(encode(part.save(w), 'modules.economy')));
    expect(decode(data)).toEqual(part.save(w));
    for (const e of w.list) {
      if (e.ext.economy === undefined) continue;
      const enc = JSON.parse(JSON.stringify(encode(e.ext.economy, `ext.economy#${e.id}`)));
      expect(decode(enc)).toEqual(e.ext.economy);
    }
    // loading the participant data into another world reproduces incomeRate exactly
    const before = incomeRate(w, 1);
    const fresh = newMatch().world;
    (fresh as unknown as { time: number }).time = w.time;
    for (const [id, p] of w.players) Object.assign(fresh.player(id).stats, p.stats);
    fresh.getSaveParticipants().find((p) => p.key === 'economy')!.load(fresh, decode(data));
    expect(incomeRate(fresh, 1)).toEqual(before);
  });
});
