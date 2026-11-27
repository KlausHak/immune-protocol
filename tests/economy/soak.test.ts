import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import type { Entity } from '../../src/core/types';
import { UNIT_DEFS } from '../../src/data';
import { createHeadlessMatch } from '../../src/game/headless';
import { findBuildSpot, idleWorkers } from '../../src/sim/economy';

const PHASES = new Set(['toNode', 'waiting', 'gathering', 'toDropoff']);
const BUILDS = ['hosp_ward', 'hosp_generator', 'hosp_pharmacy', 'hosp_lab', 'hosp_uv_turret', 'hosp_barricade', 'hosp_vehicle_bay'];

describe('economy soak', () => {
  it('survives a long chaotic match (enemy AI on, random player commands, deaths, depletion) with invariants intact', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: true, seed: 11 });
    const w = m.world;
    const rng = new Rng(99);
    w.vision.revealAll(1, true);
    const p1 = w.player(1);
    p1.resources.matter = 1500; p1.resources.energy = 600;
    const pick = <T>(a: T[]): T | undefined => (a.length ? a[Math.floor(rng.next() * a.length)] : undefined);
    const mine = (f: (e: Entity) => boolean) => w.entitiesOf(1, f);
    let ticks = 0;
    m.runFor(180, () => {
      ticks++;
      if (ticks % 30 === 0) {
        const r = rng.next();
        const hq = mine((e) => e.defId === 'hosp_hq')[0];
        const workers = mine((e) => !!e.gatherer);
        const buildings = mine((e) => e.kind === 'building');
        if (r < 0.2 && hq) {
          w.issue({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
        } else if (r < 0.35 && workers.length) {
          const defId = pick(BUILDS)!;
          const tile = findBuildSpot(w, 1, defId, hq?.pos ?? workers[0]!.pos, { maxRadius: 20 });
          if (tile) w.issue({ type: 'build', playerId: 1, unitIds: [pick(workers)!.id], defId, tile, queue: rng.chance(0.3) });
        } else if (r < 0.45) {
          const b = pick(buildings.filter((e) => e.production && !e.construction));
          if (b) {
            const def = b.def as { trains: string[]; researches: string[] };
            if (def.researches.length && rng.chance(0.5)) w.issue({ type: 'research', playerId: 1, buildingId: b.id, upgradeId: pick(def.researches)! });
            else if (def.trains.length) w.issue({ type: 'train', playerId: 1, buildingId: b.id, defId: pick(def.trains)! });
          }
        } else if (r < 0.5) {
          const b = pick(buildings.filter((e) => (e.production?.queue.length ?? 0) > 0));
          if (b) w.issue(rng.chance(0.5) ? { type: 'cancelTrain', playerId: 1, buildingId: b.id, index: Math.floor(rng.next() * 6) - 1 } : { type: 'cancelResearch', playerId: 1, buildingId: b.id });
        } else if (r < 0.55) {
          const b = pick(buildings.filter((e) => !!e.construction));
          if (b) w.issue({ type: 'cancelConstruction', playerId: 1, buildingId: b.id });
        } else if (r < 0.65) {
          const idle = idleWorkers(w, 1);
          const node = pick(w.list.filter((e) => e.alive && e.kind === 'resource'));
          if (idle.length && node) w.issue({ type: 'smart', playerId: 1, unitIds: idle.map((u) => u.id), target: node.pos, targetId: node.id });
        } else if (r < 0.7) {
          const b = pick(buildings);
          if (b) { b.hp = Math.max(1, b.hp - 150); const u = pick(workers); if (u) w.issue({ type: 'repair', playerId: 1, unitIds: [u.id], targetId: b.id }); }
        } else if (r < 0.75) {
          const node = pick(w.list.filter((e) => e.alive && e.kind === 'resource'));
          if (hq && node) w.issue({ type: 'setRally', playerId: 1, buildingIds: [hq.id], target: node.pos, targetId: node.id });
        } else if (r < 0.8) {
          const u = pick(workers);
          if (u && workers.length > 4) w.killEntity(u, null); // combat losses mid-trip
        } else if (r < 0.84) {
          const node = pick(w.list.filter((e) => e.alive && e.kind === 'resource'));
          if (node) node.resource!.amount = Math.min(node.resource!.amount, 7); // depletes soon
        } else if (r < 0.88) {
          const b = pick(buildings.filter((e) => e.defId !== 'hosp_hq'));
          if (b) w.killEntity(b, null);
        } else if (r < 0.92 && workers.length) {
          w.issue({ type: 'move', playerId: 1, unitIds: workers.slice(0, 3).map((u) => u.id), target: { x: 30, y: 60 } });
        } else if (workers.length) {
          const u = pick(workers)!;
          if (u.gatherer!.carrying > 0) w.issue({ type: 'returnCargo', playerId: 1, unitIds: [u.id] });
        }
        p1.resources.matter = Math.max(p1.resources.matter, 200);
      }
      // invariants
      for (const p of w.activePlayers()) {
        expect(Number.isFinite(p.resources.matter) && p.resources.matter >= 0).toBe(true);
        expect(Number.isFinite(p.resources.energy) && p.resources.energy >= 0).toBe(true);
        expect(p.popCap).toBeLessThanOrEqual(150);
        for (const id of p.researching) expect(p.upgrades.has(id)).toBe(false);
      }
      for (const e of w.list) {
        if (!e.alive) continue;
        if (e.kind === 'resource') { expect(e.resource!.activeGatherers === 0 || e.resource!.activeGatherers === 1).toBe(true); expect(e.resource!.amount).toBeGreaterThan(0); }
        if (e.gatherer && e.orders[0]?.type === 'gather' && e.gatherer.phase !== 'idle') expect(PHASES.has(e.gatherer.phase)).toBe(true);
        if (e.gatherer && e.orders[0] && !['gather', 'returnCargo'].includes(e.orders[0].type)) expect(e.gatherer.phase).toBe('idle');
        if (e.construction) { expect(e.construction.progress).toBeLessThanOrEqual(e.construction.total + 1e-6); expect(e.hp).toBeLessThanOrEqual(e.stats.maxHp + 1e-6); }
        if (e.production) expect(e.production.queue.length).toBeLessThanOrEqual(5);
      }
    });
    if (process.env.SOAK_DEBUG) {
      const ws = w.entitiesOf(1, (e) => !!e.gatherer);
      console.log('workers', ws.length, 'idle', idleWorkers(w, 1).length, 'gathered', p1.stats.matterGathered, 'p2', w.player(2).stats.matterGathered);
      console.log(ws.map((u) => `${u.id}:${u.orders.map((o) => o.type).join('>') || '-'}:${u.gatherer!.phase}:${u.activity}:c${u.gatherer!.carrying}`).join(' '));
      console.log('caches', w.list.filter((e) => e.alive && e.kind === 'resource').length, 'buildings', w.entitiesOf(1, (e) => e.kind === 'building').map((b) => b.defId + (b.construction ? '*' : '')).join(','));
    }
    expect(ticks).toBeGreaterThan(3000);
    expect(p1.stats.matterGathered).toBeGreaterThan(150); // chaos kills workers and drains caches
    expect(p1.stats.buildingsBuilt).toBeGreaterThan(1);
    expect(p1.stats.unitsTrained).toBeGreaterThan(3);
    // the AI (player 2) ran its economy through the same service
    const p2 = w.player(2);
    expect(p2.stats.matterGathered).toBeGreaterThan(200);
    expect(Object.keys(UNIT_DEFS).length).toBeGreaterThan(0);
  });
});
