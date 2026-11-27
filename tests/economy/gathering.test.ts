import { describe, expect, it } from 'vitest';
import { occupantOf, workersOnNode } from '../../src/sim/economy';
import { addWorkers, cachesNear, caches, hqOf, idleAll, newMatch, record, runUntil, workersOf } from './util';

const GATHER_PHASES = new Set(['toNode', 'waiting', 'gathering', 'toDropoff']);

describe('gathering', () => {
  it('keeps one active gatherer per cache and accurate phases/activities', () => {
    const m = newMatch();
    const w = m.world;
    const workers = workersOf(w);
    expect(workers.length).toBe(5);
    m.step(); // let the initial gather orders start
    let maxActive = 0, sawCarry = false, sawGather = false;
    m.runFor(40, () => {
      for (const c of caches(w)) {
        const active = w.list.filter((u) => u.alive && u.gatherer?.phase === 'gathering' && u.gatherer.nodeId === c.id).length;
        maxActive = Math.max(maxActive, active);
        expect(c.resource!.activeGatherers).toBe(active);
      }
      for (const u of workers) {
        if (u.orders[0]?.type !== 'gather') continue;
        expect(GATHER_PHASES.has(u.gatherer!.phase)).toBe(true);
        if (u.gatherer!.phase === 'gathering') { expect(u.activity).toBe('gathering'); sawGather = true; }
        if (u.gatherer!.phase === 'toDropoff' && u.mover?.moving) { expect(u.activity).toBe('carrying'); sawCarry = true; }
      }
    });
    expect(maxActive).toBe(1);
    expect(sawGather && sawCarry).toBe(true);
    expect(w.player(1).stats.matterGathered).toBeGreaterThan(150);
  });

  it('spreads a group gather order across the field (1 per cache, then 2)', () => {
    for (const n of [6, 12]) {
      const m = newMatch();
      const w = m.world;
      const hq = hqOf(w);
      idleAll(m);
      const ws = [...workersOf(w), ...addWorkers(w, n - 5, { x: hq.pos.x, y: hq.pos.y + 4 })];
      const field = cachesNear(w, hq.pos, 6);
      w.issue({ type: 'gather', playerId: 1, unitIds: ws.map((u) => u.id), targetId: field[0]!.id });
      m.step(); m.step();
      const counts = field.map((c) => workersOnNode(w, c.id));
      expect(counts, `n=${n}`).toEqual(field.map(() => n / 6));
    }
  });

  it('a worker arriving at a busy cache bounces to a free cache nearby', () => {
    const m = newMatch();
    const w = m.world;
    const hq = hqOf(w);
    idleAll(m);
    const [a, b, c] = workersOf(w);
    const target = cachesNear(w, hq.pos, 1)[0]!;
    // three separate single-unit commands: no up-front spreading
    for (const u of [a!, b!, c!]) w.issue({ type: 'gather', playerId: 1, unitIds: [u.id], targetId: target.id });
    m.runFor(12, () => {
      expect(w.list.filter((u) => u.alive && u.gatherer?.phase === 'gathering' && u.gatherer.nodeId === target.id).length).toBeLessThanOrEqual(1);
    });
    const nodes = new Set([a!, b!, c!].map((u) => u.gatherer!.nodeId));
    expect(nodes.size).toBeGreaterThanOrEqual(2);
    for (const u of [a!, b!, c!]) expect(u.orders[0]?.type).toBe('gather');
  });

  it('waits (FIFO) at a busy cache when there is no free cache to bounce to', () => {
    const m = newMatch();
    const w = m.world;
    const hq = hqOf(w);
    idleAll(m);
    const field = cachesNear(w, hq.pos, 6);
    for (const c of field.slice(1)) w.removeEntity(c); // leave a single cache at this base
    m.step();
    const only = field[0]!;
    const ws = workersOf(w).slice(0, 3);
    for (const u of ws) w.issue({ type: 'gather', playerId: 1, unitIds: [u.id], targetId: only.id });
    const delivered = new Map<number, number>();
    w.events.on('resourceDelivered', ({ worker }) => delivered.set(worker.id, (delivered.get(worker.id) ?? 0) + 1));
    let sawWaiting = false;
    m.runFor(40, () => {
      const g = ws.filter((u) => u.gatherer!.phase === 'gathering');
      expect(g.length).toBeLessThanOrEqual(1);
      if (ws.some((u) => u.gatherer!.phase === 'waiting')) {
        sawWaiting = true;
        const waiter = ws.find((u) => u.gatherer!.phase === 'waiting')!;
        expect(waiter.gatherer!.nodeId).toBe(only.id);
      }
      expect(only.resource!.activeGatherers).toBeLessThanOrEqual(1);
    });
    expect(sawWaiting).toBe(true);
    for (const u of ws) expect(delivered.get(u.id) ?? 0, `worker ${u.id} starved`).toBeGreaterThanOrEqual(2);
    expect(occupantOf(w, only) === null || ws.includes(occupantOf(w, only)!)).toBe(true);
  });

  it('removes a depleted cache and its workers switch to the nearest cache', () => {
    const m = newMatch();
    const w = m.world;
    const hq = hqOf(w);
    idleAll(m);
    const target = cachesNear(w, hq.pos, 1)[0]!;
    target.resource!.amount = 12; // 5 + 5 + 2
    const ws = workersOf(w).slice(0, 2);
    for (const u of ws) w.issue({ type: 'gather', playerId: 1, unitIds: [u.id], targetId: target.id });
    const depleted = record(w, 'resourceDepleted');
    const t = runUntil(m, () => depleted.length > 0, 60);
    expect(t).toBeGreaterThan(0);
    expect(depleted[0]!.node).toBe(target);
    m.step();
    expect(w.get(target.id)).toBeUndefined();
    const before = w.player(1).stats.matterGathered;
    m.runFor(20);
    for (const u of ws) {
      expect(u.orders[0]?.type).toBe('gather');
      const node = w.getAlive(u.gatherer!.nodeId);
      expect(node?.kind).toBe('resource');
      expect(Math.hypot(node!.pos.x - target.pos.x, node!.pos.y - target.pos.y)).toBeLessThan(12);
    }
    expect(w.player(1).stats.matterGathered - before).toBeGreaterThanOrEqual(20);
    expect(depleted.length).toBe(1);
  });

  it('returnCargo delivers and resumes mining; right-click on the HQ with cargo returns it', () => {
    const m = newMatch();
    const w = m.world;
    const hq = hqOf(w);
    const u = workersOf(w)[0]!;
    expect(runUntil(m, () => u.gatherer!.carrying > 0, 20)).toBeGreaterThanOrEqual(0);
    const node = u.gatherer!.nodeId;
    w.issue({ type: 'move', playerId: 1, unitIds: [u.id], target: { x: hq.pos.x + 8, y: hq.pos.y - 6 } });
    m.runFor(3);
    expect(u.gatherer!.phase).toBe('idle');
    expect(u.gatherer!.carrying).toBe(5);
    const p = w.player(1);
    const before = p.resources.matter;
    w.issue({ type: 'returnCargo', playerId: 1, unitIds: [u.id] });
    expect(runUntil(m, () => u.gatherer!.carrying === 0, 20)).toBeGreaterThanOrEqual(0);
    expect(p.resources.matter).toBeGreaterThanOrEqual(before + 5);
    m.step();
    expect(u.orders[0]?.type).toBe('gather');
    expect(u.gatherer!.nodeId).toBe(node);
    // smart (right-click) on the HQ while carrying → returnCargo
    expect(runUntil(m, () => u.gatherer!.carrying > 0 && u.gatherer!.phase === 'toDropoff', 20)).toBeGreaterThanOrEqual(0);
    w.issue({ type: 'move', playerId: 1, unitIds: [u.id], target: { x: hq.pos.x + 8, y: hq.pos.y - 6 } });
    m.runFor(2);
    w.issue({ type: 'smart', playerId: 1, unitIds: [u.id], target: hq.pos, targetId: hq.id });
    m.step();
    expect(u.orders[0]?.type).toBe('returnCargo');
    expect(runUntil(m, () => u.gatherer!.carrying === 0, 20)).toBeGreaterThanOrEqual(0);
  });

  it('applies gatherMul and the carry-capacity upgrade', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    p.gatherMul = 2;
    const deliveries = record(w, 'resourceDelivered');
    runUntil(m, () => deliveries.some((d) => d.playerId === 1), 20);
    expect(deliveries.find((d) => d.playerId === 1)!.amount).toBe(10);
    p.gatherMul = 1;
    p.upgrades.add('up_hosp_logistics');
    w.recomputeStatsForPlayer(1);
    const n0 = deliveries.length;
    m.runFor(25);
    const later = deliveries.slice(n0).filter((d) => d.playerId === 1);
    expect(later.length).toBeGreaterThan(2);
    expect(later.every((d) => d.amount === 5 || d.amount === 6)).toBe(true);
    expect(later.some((d) => d.amount === 6)).toBe(true);
  });

  it('a group gather onto a non-resource target is rejected with feedback', () => {
    const m = newMatch();
    const w = m.world;
    idleAll(m);
    const msgs = record(w, 'notEnough');
    const u = workersOf(w)[0]!;
    const hq = hqOf(w);
    w.issue({ type: 'gather', playerId: 1, unitIds: [u.id], targetId: hq.id });
    m.step();
    expect(u.orders.length).toBe(0);
    expect(msgs.some((x) => x.playerId === 1 && x.kind === 'invalidTarget')).toBe(true);
  });
});
