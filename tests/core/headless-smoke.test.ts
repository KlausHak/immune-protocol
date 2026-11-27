import { describe, expect, it } from 'vitest';
import { createHeadlessMatch } from '../../src/game/headless';

describe('headless skirmish (architect smoke test)', () => {
  it('boots the test map, workers gather, production works, commands resolve', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: true, seed: 7 });
    const { world } = m;
    const p1 = world.player(1);
    expect(world.entitiesOf(1, (e) => e.kind === 'building').length).toBe(1);
    expect(world.entitiesOf(1, (e) => !!e.gatherer).length).toBe(5);
    const hq = world.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    m.runFor(1);
    world.issue({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
    m.runFor(60);
    expect(p1.stats.matterGathered).toBeGreaterThan(100);
    expect(world.entitiesOf(1, (e) => e.defId === 'hosp_orderly').length).toBe(6);
    // build a ward with one worker
    const w = world.entitiesOf(1, (e) => !!e.gatherer)[0]!;
    world.issue({ type: 'build', playerId: 1, unitIds: [w.id], defId: 'hosp_ward', tile: { x: 27, y: 80 } });
    m.runFor(40);
    const ward = world.entitiesOf(1, (e) => e.defId === 'hosp_ward')[0];
    expect(ward, 'ward placed').toBeTruthy();
    expect(ward!.construction, 'ward completed').toBeUndefined();
    expect(p1.popCap).toBe(18);
  });
});
