import { describe, expect, it } from 'vitest';
import { createHeadlessMatch } from '../../src/game/headless';
import { createTestMap, getMap } from '../../src/map';

describe('test map contract (must stay stable)', () => {
  it('keeps size, slots, resources and names', () => {
    const m = createTestMap();
    expect([m.id, m.width, m.height]).toEqual(['test', 96, 96]);
    expect(m.slots).toEqual([
      { id: 1, faction: 'hospital', start: { x: 20, y: 76 } },
      { id: 2, faction: 'pathogen', start: { x: 76, y: 20 } },
    ]);
    expect(m.resources.length).toBe(16);
    expect(m.resources.slice(12).map((r) => r.pos)).toEqual([{ x: 44, y: 44 }, { x: 52, y: 44 }, { x: 44, y: 52 }, { x: 52, y: 52 }]);
    expect(Object.keys(m.regions)).toEqual(['player_base', 'enemy_base', 'center']);
    expect(m.points.center).toEqual({ x: 48, y: 48 });
    expect(m.heights.length).toBe(97 * 97);
    expect(getMap('test').resources).toEqual(m.resources);
  });
});

describe('headless skirmish on meilahti', () => {
  it('runs 3 simulated minutes without exceptions', () => {
    const m = createHeadlessMatch({ mapId: 'meilahti', seed: 3 });
    const { world } = m;
    expect(world.map.id).toBe('meilahti');
    expect(world.entitiesOf(1, (e) => e.defId === 'hosp_hq').length).toBe(1);
    expect(world.entitiesOf(2, (e) => e.defId === 'path_hive').length).toBe(1);
    expect(world.list.filter((e) => e.kind === 'resource').length).toBe(world.map.resources.length);
    const hq = world.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    expect(hq.pos).toEqual(world.map.points.player_start);
    m.runFor(180);
    expect(world.time).toBeGreaterThan(170);
    expect(world.player(1).stats.matterGathered).toBeGreaterThan(0);
  });
});
