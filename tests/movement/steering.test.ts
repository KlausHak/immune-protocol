import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/core/types';
import { internals, makeWorld, mapWith, maxOverlap, runUntil, spawnGrid, wallViolations } from './helpers';

/** Run until all units arrived; track the worst blockedTime and wall violations on every tick. */
function runGroup(w: ReturnType<typeof makeWorld>, units: Entity[], maxSeconds: number) {
  let maxBlocked = 0, walls = 0;
  const t = runUntil(w, maxSeconds, () => units.every((u) => u.mover!.arrived), () => {
    for (const u of units) maxBlocked = Math.max(maxBlocked, u.mover!.blockedTime);
    walls += wallViolations(w).length;
  });
  return { t, maxBlocked, walls };
}

describe('steering & collision', () => {
  it('a 20-unit group move across the map arrives cleanly, nobody stuck > 3 s', () => {
    const w = makeWorld();
    const units = spawnGrid(w, 'hosp_sanitizer', 1, 20, { x: 6, y: 14 }, 1.0);
    const target = { x: 70, y: 62 }; // past the granite outcrops
    w.issue({ type: 'move', playerId: 1, unitIds: units.map((u) => u.id), target });
    const r = runGroup(w, units, 45);
    expect(r.t).toBeLessThan(35); // ~80 tiles at 2.7/s ≈ 30 s
    expect(r.maxBlocked).toBeLessThan(3);
    expect(r.walls).toBe(0);
    expect(maxOverlap(units)).toBeLessThan(0.05);
    for (const u of units) {
      expect(u.mover!.moving).toBe(false);
      expect(Math.hypot(u.pos.x - target.x, u.pos.y - target.y)).toBeLessThan(5);
    }
    // settled: no jostling once arrived
    const snap = units.map((u) => ({ x: u.pos.x, y: u.pos.y }));
    runUntil(w, 3, () => false);
    units.forEach((u, i) => expect(Math.hypot(u.pos.x - snap[i]!.x, u.pos.y - snap[i]!.y)).toBeLessThan(0.05));
  });

  it('a mixed-size group goes around the pond and stops without overlaps', () => {
    const w = makeWorld();
    const small = spawnGrid(w, 'hosp_sanitizer', 1, 10, { x: 8, y: 40 }, 1.0);
    const big = spawnGrid(w, 'hosp_macrophage', 1, 4, { x: 6, y: 52 }, 2.4, 2);
    const launchers = spawnGrid(w, 'hosp_antibiotic_launcher', 1, 3, { x: 9, y: 58 }, 1.9, 3);
    const units = [...small, ...big, ...launchers];
    w.issue({ type: 'move', playerId: 1, unitIds: units.map((u) => u.id), target: { x: 40, y: 48 } });
    const r = runGroup(w, units, 40);
    expect(units.every((u) => u.mover!.arrived)).toBe(true);
    expect(r.maxBlocked).toBeLessThan(3);
    expect(r.walls).toBe(0);
    expect(maxOverlap(units)).toBeLessThan(0.05);
    for (const u of units) expect(u.pos.x).toBeGreaterThan(30); // all made it past the water
  });

  it('two groups crossing head-on pass each other', () => {
    const w = makeWorld();
    const a = spawnGrid(w, 'hosp_sanitizer', 1, 16, { x: 48, y: 12 });
    const b = spawnGrid(w, 'hosp_sanitizer', 1, 16, { x: 48, y: 70 });
    w.issue({ type: 'move', playerId: 1, unitIds: a.map((u) => u.id), target: { x: 50, y: 74 } });
    w.issue({ type: 'move', playerId: 1, unitIds: b.map((u) => u.id), target: { x: 50, y: 15 } });
    const r = runGroup(w, [...a, ...b], 45);
    expect(r.t).toBeLessThan(30);
    expect(r.maxBlocked).toBeLessThan(3);
    for (const u of a) expect(u.pos.y).toBeGreaterThan(68);
    for (const u of b) expect(u.pos.y).toBeLessThan(20);
  });

  it('a group squeezes through a 3-wide chokepoint', () => {
    const map = mapWith((x, y) => x === 40 && !(y >= 19 && y <= 21));
    const w = makeWorld(map);
    const units = spawnGrid(w, 'hosp_sanitizer', 1, 20, { x: 26, y: 26 });
    w.issue({ type: 'move', playerId: 1, unitIds: units.map((u) => u.id), target: { x: 55, y: 20 } });
    const r = runGroup(w, units, 45);
    expect(units.every((u) => u.mover!.arrived && u.pos.x > 41)).toBe(true);
    expect(r.maxBlocked).toBeLessThan(3);
    expect(r.walls).toBe(0);
  });

  it('idle friends shuffle aside for a unit passing through', () => {
    const map = mapWith((x, y) => (y === 18 || y === 22) && x >= 30 && x <= 60); // 3-wide corridor
    const w = makeWorld(map);
    const idle = [0, 1, 2, 3, 4].map((i) => w.spawnUnit('hosp_sanitizer', 1, { x: 40 + i * 3, y: 20.5 }));
    const mover = w.spawnUnit('hosp_sanitizer', 1, { x: 20, y: 20.5 });
    w.issue({ type: 'move', playerId: 1, unitIds: [mover.id], target: { x: 66, y: 20.5 } });
    let maxBlocked = 0;
    const t = runUntil(w, 30, () => mover.mover!.arrived, () => { maxBlocked = Math.max(maxBlocked, mover.mover!.blockedTime); });
    expect(t).toBeLessThan(46 / 2.7 + 2); // barely slowed down
    expect(maxBlocked).toBe(0);
    expect(Math.hypot(mover.pos.x - 66, mover.pos.y - 20.5)).toBeLessThan(0.2);
    for (const u of idle) {
      expect(u.mover!.moving).toBe(false);
      expect(Math.abs(u.pos.x - (40 + idle.indexOf(u) * 3))).toBeLessThan(1.5); // stepped aside, not bulldozed
    }
  });

  it('units ordered to the same point stop around it instead of jostling', () => {
    const w = makeWorld();
    const units = spawnGrid(w, 'hosp_sanitizer', 1, 12, { x: 20, y: 20 });
    for (const u of units) w.issue({ type: 'move', playerId: 1, unitIds: [u.id], target: { x: 60, y: 30 } }); // one by one
    const r = runGroup(w, units, 30);
    expect(units.every((u) => u.mover!.arrived)).toBe(true);
    expect(r.maxBlocked).toBeLessThan(3);
    runUntil(w, 1, () => false); // last arrivals may still resolve a small overlap
    expect(maxOverlap(units)).toBeLessThan(0.02);
    const snap = units.map((u) => ({ x: u.pos.x, y: u.pos.y }));
    runUntil(w, 3, () => false);
    units.forEach((u, i) => expect(Math.hypot(u.pos.x - snap[i]!.x, u.pos.y - snap[i]!.y)).toBeLessThan(0.05));
    for (const u of units) expect(Math.hypot(u.pos.x - 60, u.pos.y - 30)).toBeLessThan(3.5);
  });

  it('units never end inside blocked tiles while crowding around obstacles', () => {
    const map = mapWith((x, y) => (x >= 46 && x <= 49 && y >= 26 && y <= 36) || (x === 60 && y % 3 === 0));
    const w = makeWorld(map);
    const units = [
      ...spawnGrid(w, 'hosp_sanitizer', 1, 25, { x: 30, y: 26 }, 1.0),
      ...spawnGrid(w, 'hosp_macrophage', 1, 4, { x: 30, y: 34 }, 2.3, 4),
      ...spawnGrid(w, 'hosp_orderly', 1, 6, { x: 30, y: 38 }, 1.0, 6),
    ];
    const ids = units.map((u) => u.id);
    let violations = 0;
    const targets = [{ x: 66, y: 31 }, { x: 30, y: 30 }, { x: 54, y: 40 }];
    for (const target of targets) {
      w.issue({ type: 'move', playerId: 1, unitIds: ids, target });
      runUntil(w, 14, () => false, () => { violations += wallViolations(w).length; });
    }
    expect(violations).toBe(0);
  });

  it('moveToEntity approaches a building footprint until in range', () => {
    const w = makeWorld();
    const ward = w.spawnBuilding('hosp_ward', 1, { x: 60, y: 20 }, { complete: true });
    const touch = w.spawnUnit('hosp_orderly', 1, { x: 50, y: 30 });
    const ranged = w.spawnUnit('hosp_sanitizer', 1, { x: 70, y: 30 });
    w.movement.moveToEntity(touch, ward, 0);
    w.movement.moveToEntity(ranged, ward, 3);
    runUntil(w, 15, () => touch.mover!.arrived && ranged.mover!.arrived);
    expect(w.edgeDistance(touch, ward)).toBeLessThanOrEqual(0);
    expect(w.edgeDistance(ranged, ward)).toBeLessThanOrEqual(3);
    expect(w.edgeDistance(ranged, ward)).toBeGreaterThan(2.5); // stopped as soon as in range
    // a moving target is tracked
    const leader = w.spawnUnit('hosp_sanitizer', 1, { x: 20, y: 70 });
    const chaser = w.spawnUnit('hosp_orderly', 1, { x: 30, y: 60 });
    w.issue({ type: 'move', playerId: 1, unitIds: [leader.id], target: { x: 40, y: 85 } });
    w.step();
    w.movement.moveToEntity(chaser, leader, 0.5);
    runUntil(w, 20, () => chaser.mover!.arrived && leader.mover!.arrived);
    expect(w.edgeDistance(chaser, leader)).toBeLessThanOrEqual(0.5);
  });

  it('follow keeps up with a moving friend and then idles next to it', () => {
    const w = makeWorld();
    const leader = w.spawnUnit('hosp_sanitizer', 1, { x: 20, y: 20 });
    const followers = spawnGrid(w, 'hosp_sanitizer', 1, 4, { x: 14, y: 26 });
    w.issue({ type: 'follow', playerId: 1, unitIds: followers.map((u) => u.id), targetId: leader.id });
    w.issue({ type: 'move', playerId: 1, unitIds: [leader.id], target: { x: 70, y: 30 } });
    runUntil(w, 30, () => leader.mover!.arrived);
    runUntil(w, 4, () => false);
    for (const f of followers) {
      expect(w.edgeDistance(f, leader)).toBeLessThan(3.5);
      expect(f.orders[0]?.type).toBe('follow');
    }
    // settled, not twitching or creeping
    const snap = followers.map((u) => ({ x: u.pos.x, y: u.pos.y }));
    runUntil(w, 8, () => false);
    followers.forEach((u, i) => expect(Math.hypot(u.pos.x - snap[i]!.x, u.pos.y - snap[i]!.y)).toBeLessThan(0.05));
  });

  it('air units fly straight over water and spread out mildly', () => {
    const w = makeWorld();
    const drones = spawnGrid(w, 'hosp_sterilizer_drone', 1, 6, { x: 10, y: 47 }, 0.6, 3);
    w.issue({ type: 'move', playerId: 1, unitIds: drones.map((u) => u.id), target: { x: 34, y: 48 } });
    let overWater = 0;
    const nav = internals(w).movement.nav;
    runUntil(w, 20, () => drones.every((u) => u.mover!.arrived), () => { if (drones.some((u) => nav.isBlockedTile(Math.floor(u.pos.x), Math.floor(u.pos.y)))) overWater++; });
    expect(drones.every((u) => u.mover!.arrived)).toBe(true);
    expect(overWater).toBeGreaterThan(20); // crossed the pond instead of walking around it
    expect(w.time).toBeLessThan(13);       // ~24 tiles at 4.2/s, straight
    runUntil(w, 2, () => false);
    expect(maxOverlap(drones)).toBeLessThan(0.7); // soft separation only
  });

  it('clearFootprint pushes ground units out of a new foundation', () => {
    const w = makeWorld();
    const inside = spawnGrid(w, 'hosp_sanitizer', 1, 4, { x: 60.6, y: 20.6 }, 1.0, 2);
    const ward = w.spawnBuilding('hosp_ward', 1, { x: 60, y: 20 }, { complete: false });
    for (const u of inside) expect(w.edgeDistance(u, ward)).toBeGreaterThanOrEqual(0);
    const nav = internals(w).movement.nav;
    for (const u of inside) expect(nav.circleFree(u.pos.x, u.pos.y, u.radius - 0.02)).toBe(true);
    runUntil(w, 1, () => false);
    expect(wallViolations(w).length).toBe(0);
  });

  it('repeated moveTo calls with the same target are cheap and do not restart arrival', () => {
    const w = makeWorld();
    const u = w.spawnUnit('hosp_sanitizer', 1, { x: 10, y: 20 });
    const stats = internals(w).movement.stats;
    w.movement.moveTo(u, { x: 70, y: 70 });
    const planned = stats.astar + stats.direct + stats.fieldPaths;
    for (let i = 0; i < 200; i++) { w.movement.moveTo(u, { x: 70.05, y: 70 }); w.step(); }
    expect(stats.astar + stats.direct + stats.fieldPaths).toBeLessThanOrEqual(planned + 2);
    runUntil(w, 40, () => u.mover!.arrived);
    expect(u.mover!.arrived).toBe(true);
    w.movement.moveTo(u, { x: 70, y: 70 });
    expect(u.mover!.arrived).toBe(true); // already there: stays arrived (attack-move style re-issue)
    expect(u.mover!.moving).toBe(false);
  });
});
