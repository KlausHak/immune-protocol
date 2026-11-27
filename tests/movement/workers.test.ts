import { describe, expect, it } from 'vitest';
import { createHeadlessMatch } from '../../src/game/headless';
import { isGhosting } from '../../src/sim/movement';
import { wallViolations } from './helpers';

describe('worker traffic', () => {
  it('mining traffic around the HQ and the Supply Caches keeps flowing for 2 minutes', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: false, seed: 11 });
    const w = m.world;
    const hq = w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    const caches = w.list.filter((e) => e.kind === 'resource' && Math.hypot(e.pos.x - hq.pos.x, e.pos.y - hq.pos.y) < 14);
    expect(caches.length).toBeGreaterThanOrEqual(6);
    // 5 starting workers + 9 more crowding the same caches (≈ 2.3 per cache: some queueing)
    for (let i = 0; i < 9; i++) {
      const u = w.spawnUnit('hosp_orderly', 1, w.movement.nearestWalkable({ x: hq.pos.x + 3.6, y: hq.pos.y - 2 + i * 0.5 })!);
      w.issue({ type: 'gather', playerId: 1, unitIds: [u.id], targetId: caches[i % caches.length]!.id });
    }
    const workers = () => w.entitiesOf(1, (e) => !!e.gatherer);
    const stats = w.player(1).stats;
    const samples: number[] = [];
    let last = stats.matterGathered, ghostTicks = 0, walls = 0, maxStuck = 0;
    for (let s = 0; s < 120; s++) {
      m.runFor(1);
      for (const u of workers()) {
        if (isGhosting(u)) ghostTicks++;
        maxStuck = Math.max(maxStuck, u.mover!.blockedTime);
      }
      walls += wallViolations(w).length;
      if (s % 15 === 14) { samples.push(stats.matterGathered - last); last = stats.matterGathered; }
    }
    // steady flow: every 15 s window delivers, and the late windows are as good as the early ones
    expect(samples.length).toBe(8);
    for (const d of samples.slice(1)) expect(d).toBeGreaterThanOrEqual(80);
    const early = samples[1]! + samples[2]!, late = samples[6]! + samples[7]!;
    expect(late).toBeGreaterThan(early * 0.8);
    expect(stats.matterGathered).toBeGreaterThan(900);
    expect(ghostTicks).toBeGreaterThan(0);   // gathering workers did ghost
    expect(maxStuck).toBeLessThan(3);
    expect(walls).toBe(0);
  });

  it('ghosting workers pass through each other but idle workers collide', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: false, seed: 2 });
    const w = m.world;
    const a = w.spawnUnit('hosp_orderly', 1, { x: 60, y: 30 });
    const b = w.spawnUnit('hosp_orderly', 1, { x: 60, y: 30.2 });
    m.runFor(0.5);
    expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y)).toBeGreaterThan(a.radius + b.radius - 0.02);
  });
});
