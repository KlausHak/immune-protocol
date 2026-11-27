import { describe, expect, it } from 'vitest';
import type { BuildingDef, TilePos } from '../../src/core/types';
import { BUILDING_DEFS } from '../../src/data';
import { findBuildSpot, idleWorkers, workersOnNode } from '../../src/sim/economy';
import type { World } from '../../src/sim/World';
import { cachesNear, hqOf, idleAll, newMatch, spawnDone, workersOf } from './util';

type R = { x: number; y: number; w: number; h: number };
const rectOf = (tile: TilePos, defId: string): R => { const d = BUILDING_DEFS[defId] as BuildingDef; return { x: tile.x, y: tile.y, w: d.footprint.w, h: d.footprint.h }; };
const gap = (a: R, b: R): number => Math.hypot(Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w)), Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h)));
function segDist(a: { x: number; y: number }, b: { x: number; y: number }, r: R): number {
  // sampled segment-rect distance (good enough for a test)
  let d = Infinity;
  for (let i = 0; i <= 50; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / 50, y: a.y + ((b.y - a.y) * i) / 50 };
    d = Math.min(d, Math.hypot(Math.max(r.x - p.x, 0, p.x - (r.x + r.w)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h))));
  }
  return d;
}
const structures = (w: World): R[] => w.list.filter((e) => e.alive && e.kind !== 'unit').map((e) => w.footRect(e)!);

describe('helpers', () => {
  it('findBuildSpot returns valid sites with 1-tile gaps that keep the mining lanes free', () => {
    const m = newMatch();
    const w = m.world;
    const hq = hqOf(w);
    const hqRect = w.footRect(hq)!;
    const field = cachesNear(w, hq.pos, 6);
    const lanes = field.map((c) => ({ a: { x: Math.min(Math.max(c.pos.x, hqRect.x), hqRect.x + hqRect.w), y: Math.min(Math.max(c.pos.y, hqRect.y), hqRect.y + hqRect.h) }, b: c.pos }));
    for (let i = 0; i < 10; i++) {
      const defId = i % 3 === 0 ? 'hosp_pharmacy' : 'hosp_ward';
      const others = structures(w);
      const tile = findBuildSpot(w, 1, defId, hq.pos)!;
      expect(tile, `spot ${i}`).toBeTruthy();
      expect(w.economy.canPlaceBuilding(1, defId, tile).ok).toBe(true);
      const r = rectOf(tile, defId);
      for (const o of others) expect(gap(r, o)).toBeGreaterThanOrEqual(1);
      for (const l of lanes) expect(segDist(l.a, l.b, r)).toBeGreaterThan(1);
      spawnDone(w, defId, 1, tile);
    }
    // without lane avoidance the closest spot may sit in a lane but is still valid
    const t2 = findBuildSpot(w, 1, 'hosp_ward', hq.pos, { avoidResourceLanes: false })!;
    expect(w.economy.canPlaceBuilding(1, 'hosp_ward', t2).ok).toBe(true);
  });

  it('findBuildSpot respects HQ clearance, requirements, fog and the search radius', () => {
    const m = newMatch();
    const w = m.world;
    const center = { x: 48, y: 48 };
    expect(findBuildSpot(w, 1, 'hosp_hq', center, { maxRadius: 6 })).toBeNull(); // unexplored
    w.vision.revealAll(1, true);
    m.step();
    const t = findBuildSpot(w, 1, 'hosp_hq', center, { maxRadius: 16 })!;
    expect(t).toBeTruthy();
    expect(w.economy.canPlaceBuilding(1, 'hosp_hq', t).ok).toBe(true);
    const r = rectOf(t, 'hosp_hq');
    for (const c of cachesNear(w, center, 4)) expect(gap(r, w.footRect(c)!)).toBeGreaterThanOrEqual(3);
    expect(findBuildSpot(w, 1, 'hosp_lab', center)).toBeNull(); // needs a Pharmacy
    expect(findBuildSpot(w, 1, 'hosp_ward', { x: 22, y: 48 }, { maxRadius: 2 })).toBeNull(); // middle of the pond
    expect(findBuildSpot(w, 1, 'not_a_building', center)).toBeNull();
    expect(findBuildSpot(w, 1, 'obj_childrens_hospital', center)).toBeNull();
  });

  it('idleWorkers and workersOnNode', () => {
    const m = newMatch();
    const w = m.world;
    m.step();
    expect(idleWorkers(w, 1).length).toBe(0);
    const field = cachesNear(w, hqOf(w).pos, 6);
    expect(field.reduce((a, c) => a + workersOnNode(w, c.id), 0)).toBe(5);
    idleAll(m);
    expect(idleWorkers(w, 1).map((u) => u.id)).toEqual(workersOf(w).map((u) => u.id));
    expect(field.reduce((a, c) => a + workersOnNode(w, c.id), 0)).toBe(0);
    w.issue({ type: 'gather', playerId: 1, unitIds: workersOf(w).map((u) => u.id), targetId: field[0]!.id });
    m.step();
    expect(idleWorkers(w, 1).length).toBe(0);
    expect(workersOnNode(w, field[0]!.id)).toBe(1);
    expect(workersOnNode(w, field[0]!.id, 2)).toBe(0);
  });
});
