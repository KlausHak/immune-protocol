import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../src/core/types';
import { createTestMap } from '../../src/map/testMap';
import { internals, makeWorld, mapWith, runUntil } from './helpers';

const pathLength = (from: Vec2, path: Vec2[]): number => {
  let len = 0, p = from;
  for (const q of path) { len += Math.hypot(q.x - p.x, q.y - p.y); p = q; }
  return len;
};

/** Every leg of the path is clear for a circle of radius r (minus a hair of float slack). */
function expectClearPath(w: ReturnType<typeof makeWorld>, from: Vec2, path: Vec2[], r: number): void {
  const nav = internals(w).movement.nav;
  let p = from;
  for (const q of path) {
    expect(nav.segmentClear(p.x, p.y, q.x, q.y, Math.max(0, r - 0.01)), `leg (${p.x},${p.y})→(${q.x},${q.y})`).toBe(true);
    p = q;
  }
}

describe('nav grid & pathfinding', () => {
  it('finds a short, smooth path around the pond', () => {
    const w = makeWorld();
    const from = { x: 9.5, y: 48 }, to = { x: 35.5, y: 48 };
    const path = w.movement.findPath(from, to, 0.4);
    expect(path).not.toBeNull();
    expectClearPath(w, from, path!, 0.4);
    expect(path![path!.length - 1]).toEqual(to);
    const len = pathLength(from, path!);
    expect(len).toBeGreaterThan(26.5);   // can't cross the water
    expect(len).toBeLessThan(33);        // hugs the shore (detour of a 15-wide pond)
    expect(path!.length).toBeLessThan(12); // string-pulled, not a tile-by-tile staircase
  });

  it('routes around the granite outcrops without cutting corners', () => {
    const w = makeWorld();
    const from = { x: 57.5, y: 51.5 }, to = { x: 70.5, y: 51.5 };
    const path = w.movement.findPath(from, to, 0.45);
    expect(path).not.toBeNull();
    expectClearPath(w, from, path!, 0.45);
    // diagonal squeeze between two corner-touching rocks is never allowed
    const map = mapWith((x, y) => (x === 50 && y === 30) || (x === 51 && y === 31));
    const w2 = makeWorld(map);
    const p2 = w2.movement.findPath({ x: 50.5, y: 31.5 }, { x: 51.5, y: 30.5 }, 0.38)!;
    expect(p2).not.toBeNull();
    expectClearPath(w2, { x: 50.5, y: 31.5 }, p2, 0.38);
    expect(p2.length).toBeGreaterThan(1);
  });

  it('never squeezes a unit through a gap narrower than itself (size classes)', () => {
    // three walls across the map at x = 30 / 50 / 70 with gaps of 1 / 2 / 3 tiles around y = 20
    const map = mapWith((x, y) =>
      (x === 30 && y !== 20) || (x === 50 && y !== 20 && y !== 21) || (x === 70 && (y < 20 || y > 22)));
    const w = makeWorld(map);
    const mv = w.movement;
    const at = (x: number) => ({ x, y: 21 });
    // 1-wide gap: infantry yes, Bacillus (r 0.55) no
    expect(mv.findPath(at(25), at(35), 0.4)).not.toBeNull();
    expect(mv.findPath(at(25), at(35), 0.55)).toBeNull();
    // 2-wide gap: Macrophage (r 1.0, diameter 2) yes, Superbug (r 1.05) no
    expect(mv.findPath(at(45), at(55), 1.0)).not.toBeNull();
    expect(mv.findPath(at(45), at(55), 1.05)).toBeNull();
    // 3-wide gap: Superbug yes
    expect(mv.findPath(at(65), at(75), 1.05)).not.toBeNull();
    // and the units actually walk it without clipping the walls
    const mech = w.spawnUnit('hosp_macrophage', 1, { x: 44, y: 21 });
    w.issue({ type: 'move', playerId: 1, unitIds: [mech.id], target: { x: 56, y: 21 } });
    const nav = internals(w).movement.nav;
    let clipped = 0;
    runUntil(w, 20, () => mech.mover!.arrived, () => { if (!nav.circleFree(mech.pos.x, mech.pos.y, mech.radius - 0.02)) clipped++; });
    expect(mech.mover!.arrived).toBe(true);
    expect(Math.hypot(mech.pos.x - 56, mech.pos.y - 21)).toBeLessThan(0.3);
    expect(clipped).toBe(0);
  });

  it('an unreachable goal yields a path to the closest reachable point', () => {
    const w = makeWorld();
    const pond = { x: 22, y: 48 };
    expect(w.movement.findPath({ x: 9.5, y: 48 }, pond, 0.4)).toBeNull();
    const u = w.spawnUnit('hosp_sanitizer', 1, { x: 9.5, y: 30.5 });
    w.issue({ type: 'move', playerId: 1, unitIds: [u.id], target: pond });
    const t = runUntil(w, 30, () => u.mover!.arrived);
    expect(t).toBeLessThan(15);
    expect(w.movement.isWalkable(u.pos)).toBe(true);
    const nav = internals(w).movement.nav;
    let best = Infinity; // closest walkable tile centre to the pond centre
    for (let y = 30; y < 66; y++) for (let x = 4; x < 40; x++) if (!nav.isBlockedTile(x, y)) best = Math.min(best, Math.hypot(x + 0.5 - pond.x, y + 0.5 - pond.y));
    const d = Math.hypot(u.pos.x - pond.x, u.pos.y - pond.y);
    expect(d).toBeLessThan(best + 0.75);           // as close as it gets …
    expect(nav.circleFree(u.pos.x, u.pos.y, u.radius + 0.3)).toBe(false); // … i.e. standing at the water's edge
    // an enclosed pocket (ring of rock): stop at the closest point outside the ring
    const map = mapWith((x, y) => Math.max(Math.abs(x - 70), Math.abs(y - 70)) === 3);
    const w2 = makeWorld(map);
    const v = w2.spawnUnit('hosp_sanitizer', 1, { x: 60.5, y: 70.5 });
    w2.issue({ type: 'move', playerId: 1, unitIds: [v.id], target: { x: 70.5, y: 70.5 } });
    runUntil(w2, 20, () => v.mover!.arrived);
    expect(v.mover!.arrived).toBe(true);
    expect(v.pos.x).toBeGreaterThan(65.5); // the face of the ring on the unit's (west) side …
    expect(v.pos.x).toBeLessThan(67.1);    // … (x = 67 is rock)
    expect(Math.abs(v.pos.y - 70.5)).toBeLessThan(1.5);
  });

  it('building footprints block and then unblock paths', () => {
    // wall at x = 40 with a 2-wide gap at y = 30..31; a 2x2 Patient Ward plugs the gap
    const map = mapWith((x, y) => x === 40 && y !== 30 && y !== 31);
    const w = makeWorld(map);
    const mv = w.movement;
    const a = { x: 30.5, y: 31 }, b = { x: 50.5, y: 31 };
    expect(mv.findPath(a, b, 0.4)).not.toBeNull();
    const ward = w.spawnBuilding('hosp_ward', 1, { x: 40, y: 30 }, { complete: true });
    expect(mv.isWalkable({ x: 40.5, y: 30.5 })).toBe(false);
    expect(mv.isFootprintFree({ x: 40, y: 30 }, 2, 2)).toBe(false);
    expect(mv.findPath(a, b, 0.4)).toBeNull();
    // a unit ordered through the plugged gap stops at the closest point on its side
    const u = w.spawnUnit('hosp_sanitizer', 1, a);
    w.issue({ type: 'move', playerId: 1, unitIds: [u.id], target: b });
    runUntil(w, 20, () => u.mover!.arrived);
    expect(u.pos.x).toBeLessThan(40);
    expect(u.pos.x).toBeGreaterThan(38.5);
    // demolish: the gap opens again and a fresh order goes through
    w.removeEntity(ward);
    w.step(); // cleanup unstamps the footprint
    expect(mv.isWalkable({ x: 40.5, y: 30.5 })).toBe(true);
    expect(mv.findPath(a, b, 0.4)).not.toBeNull();
    w.issue({ type: 'move', playerId: 1, unitIds: [u.id], target: b });
    runUntil(w, 20, () => u.mover!.arrived);
    expect(Math.hypot(u.pos.x - b.x, u.pos.y - b.y)).toBeLessThan(0.3);
  });

  it('a unit already walking re-plans when a building appears on its path', () => {
    const map = mapWith((x, y) => x === 40 && y !== 30 && y !== 31 && y !== 60 && y !== 61);
    const w = makeWorld(map);
    const u = w.spawnUnit('hosp_sanitizer', 1, { x: 30.5, y: 31 });
    w.issue({ type: 'move', playerId: 1, unitIds: [u.id], target: { x: 50.5, y: 31 } });
    runUntil(w, 1.5, () => false);
    expect(u.mover!.moving).toBe(true);
    w.spawnBuilding('hosp_ward', 1, { x: 40, y: 30 }, { complete: true }); // plug the near gap
    const t = runUntil(w, 60, () => u.mover!.arrived);
    expect(t).toBeLessThan(40);
    expect(Math.hypot(u.pos.x - 50.5, u.pos.y - 31)).toBeLessThan(0.3); // went around through the far gap
  });

  it('nearestWalkable, isWalkable and isFootprintFree follow the contract', () => {
    const w = makeWorld();
    const mv = w.movement;
    expect(mv.isWalkable({ x: 22, y: 48 })).toBe(false);
    expect(mv.isWalkable({ x: 0.5, y: 0.5 })).toBe(false); // border
    expect(mv.isWalkable({ x: 5.5, y: 5.5 })).toBe(true);
    const p = mv.nearestWalkable({ x: 22, y: 41.2 })!;
    expect(mv.isWalkable(p)).toBe(true);
    expect(Math.hypot(p.x - 22, p.y - 41.2)).toBeLessThan(1.5);
    expect(mv.nearestWalkable({ x: 22, y: 48 }, 2)).toBeNull(); // pond centre: shore is ~7 away
    const u = w.spawnUnit('hosp_sanitizer', 1, { x: 60.5, y: 20.5 });
    expect(mv.isFootprintFree({ x: 60, y: 20 }, 2, 2)).toBe(false);
    expect(mv.isFootprintFree({ x: 60, y: 20 }, 2, 2, [u.id])).toBe(true);
    expect(mv.isFootprintFree({ x: 95, y: 20 }, 2, 2)).toBe(false); // out of bounds / border
    expect(mv.isFootprintFree({ x: 63, y: 20 }, 2, 2)).toBe(true);
  });

  it('is deterministic', () => {
    const run = () => {
      const w = makeWorld(createTestMap(), 5);
      const ids = [];
      for (let i = 0; i < 12; i++) ids.push(w.spawnUnit('hosp_sanitizer', 1, { x: 8 + (i % 4), y: 30 + Math.floor(i / 4) }).id);
      w.issue({ type: 'move', playerId: 1, unitIds: ids, target: { x: 40, y: 60 } });
      runUntil(w, 12, () => false);
      return ids.map((id) => `${w.get(id)!.pos.x.toFixed(6)},${w.get(id)!.pos.y.toFixed(6)}`).join(';');
    };
    expect(run()).toBe(run());
  });
});
