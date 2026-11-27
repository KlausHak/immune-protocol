import { describe, expect, it } from 'vitest';
import { makeWorld, mapWith, runUntil } from './helpers';

const tile = (w: ReturnType<typeof makeWorld>, p: number, x: number, y: number) => w.vision.fogGrid(p)[y * w.map.width + x];

describe('vision / fog of war', () => {
  it('units reveal their sight radius; leaving makes tiles explored', () => {
    const w = makeWorld();
    const u = w.spawnUnit('hosp_sanitizer', 1, { x: 60.5, y: 20.5 }); // sight 9
    w.step();
    expect(tile(w, 1, 60, 20)).toBe(2);
    expect(tile(w, 1, 68, 20)).toBe(2);   // 8 tiles away
    expect(tile(w, 1, 71, 20)).toBe(0);   // 10.5 away: never seen
    expect(tile(w, 1, 66, 27)).toBe(0);   // diagonal ~9.2: outside the circle
    expect(tile(w, 2, 60, 20)).toBe(0);   // the enemy saw nothing
    expect(w.vision.isVisible(1, { x: 64, y: 22 })).toBe(true);
    w.issue({ type: 'move', playerId: 1, unitIds: [u.id], target: { x: 60.5, y: 60.5 } });
    runUntil(w, 20, () => u.mover!.arrived);
    runUntil(w, 0.3, () => false);
    expect(tile(w, 1, 60, 20)).toBe(1);   // explored, not visible
    expect(w.vision.isExplored(1, { x: 60.5, y: 20.5 })).toBe(true);
    expect(w.vision.isVisible(1, { x: 60.5, y: 20.5 })).toBe(false);
    expect(tile(w, 1, 60, 60)).toBe(2);
  });

  it('high ground: units below cannot see up a cliff; units on top and air units can', () => {
    // plateau (level 1) at x 50..69, y 10..29; ramp tiles carry the high level
    const map = mapWith(() => false, (x, y) => (x >= 50 && x < 70 && y >= 10 && y < 30 ? 1 : 0));
    const w = makeWorld(map);
    const low = w.spawnUnit('hosp_sanitizer', 1, { x: 46.5, y: 20.5 });  // 3.5 tiles west of the cliff
    w.step();
    expect(tile(w, 1, 44, 20)).toBe(2);   // low ground around it
    expect(tile(w, 1, 51, 20)).toBe(0);   // plateau edge 4.5 away: hidden
    const enemyOnTop = w.spawnUnit('path_phage', 2, { x: 52.5, y: 20.5 });
    runUntil(w, 0.25, () => false);
    expect(w.vision.isEntityVisible(1, enemyOnTop)).toBe(false);
    expect(w.vision.isEntityVisible(2, low)).toBe(true);   // the phage looks down and sees it
    // a friendly unit on the plateau lifts the veil (shared vision)
    const scout = w.spawnUnit('hosp_sanitizer', 1, { x: 56.5, y: 26.5 });
    runUntil(w, 0.25, () => false);
    expect(tile(w, 1, 51, 20)).toBe(2);
    expect(w.vision.isEntityVisible(1, enemyOnTop)).toBe(true);
    w.removeEntity(scout);
    runUntil(w, 0.25, () => false);
    expect(tile(w, 1, 51, 20)).toBe(1);
    // an air unit over low ground sees the plateau
    w.spawnUnit('hosp_sterilizer_drone', 1, { x: 46.5, y: 14.5 });
    runUntil(w, 0.25, () => false);
    expect(tile(w, 1, 51, 14)).toBe(2);
  });

  it('isEntityVisible: own/allied always, enemy units on visible tiles, enemy buildings remembered', () => {
    const w = makeWorld();
    const eye = w.spawnUnit('hosp_sanitizer', 1, { x: 30.5, y: 20.5 });
    const enemy = w.spawnUnit('path_phage', 2, { x: 36.5, y: 20.5 });
    const far = w.spawnUnit('path_phage', 2, { x: 80.5, y: 80.5 });
    const nest = w.spawnBuilding('path_nest', 2, { x: 36, y: 24 }, { complete: true });
    const farNest = w.spawnBuilding('path_nest', 2, { x: 85, y: 10 }, { complete: true });
    w.rules.autoDefeat = false;
    runUntil(w, 0.25, () => false);
    expect(w.vision.isEntityVisible(1, eye)).toBe(true);
    expect(w.vision.isEntityVisible(2, far)).toBe(true);     // own
    expect(w.vision.isEntityVisible(1, enemy)).toBe(true);
    expect(w.vision.isEntityVisible(1, far)).toBe(false);
    expect(w.vision.isEntityVisible(1, nest)).toBe(true);
    expect(w.vision.isEntityVisible(1, farNest)).toBe(false);
    // walk away: the unit vanishes into the fog, the building is remembered
    w.issue({ type: 'move', playerId: 1, unitIds: [eye.id], target: { x: 10.5, y: 80.5 } });
    runUntil(w, 30, () => eye.mover!.arrived);
    runUntil(w, 0.3, () => false);
    expect(w.vision.isVisible(1, enemy.pos)).toBe(false);
    expect(w.vision.isEntityVisible(1, enemy)).toBe(false);
    expect(w.vision.isEntityVisible(1, nest)).toBe(true);    // remembered
    expect(w.vision.isEntityVisible(1, farNest)).toBe(false); // never seen
  });

  it('revealAll and revealArea', () => {
    const w = makeWorld();
    w.spawnUnit('hosp_sanitizer', 1, { x: 10.5, y: 10.5 });
    const enemy = w.spawnUnit('path_phage', 2, { x: 80.5, y: 80.5 });
    w.vision.revealAll(1, true);
    expect(w.vision.fogGrid(1).every((v) => v === 2)).toBe(true);
    expect(w.vision.isEntityVisible(1, enemy)).toBe(true);
    runUntil(w, 0.5, () => false);
    expect(w.vision.fogGrid(1).every((v) => v === 2)).toBe(true);
    w.vision.revealAll(1, false);
    expect(w.vision.isVisible(1, { x: 80.5, y: 80.5 })).toBe(false);
    expect(w.vision.isExplored(1, { x: 80.5, y: 80.5 })).toBe(true); // everything was on display once
    expect(w.vision.isVisible(1, { x: 10.5, y: 10.5 })).toBe(true);
    // timed reveal (scan): immediate, sees every level, expires
    w.vision.revealArea(2, { x: 50, y: 50 }, 5, 1);
    expect(w.vision.isVisible(2, { x: 52, y: 52 })).toBe(true);
    expect(w.vision.isVisible(2, { x: 50, y: 56 })).toBe(false);
    runUntil(w, 1.5, () => false);
    expect(w.vision.isVisible(2, { x: 52, y: 52 })).toBe(false);
    expect(w.vision.isExplored(2, { x: 52, y: 52 })).toBe(true);
  });

  it('version increments only when a fog grid changes', () => {
    const w = makeWorld();
    w.spawnUnit('hosp_sanitizer', 1, { x: 10.5, y: 10.5 });
    w.vision.fogGrid(1);
    runUntil(w, 0.5, () => false);
    const v0 = w.vision.version;
    runUntil(w, 1, () => false); // nothing moves
    expect(w.vision.version).toBe(v0);
    const u = w.spawnUnit('hosp_sanitizer', 1, { x: 40.5, y: 40.5 });
    runUntil(w, 0.25, () => false);
    expect(w.vision.version).toBeGreaterThan(v0);
    expect(w.vision.isEntityVisible(2, u)).toBe(false);
    expect(w.vision.fogGrid(0).length).toBe(w.map.width * w.map.height); // neutral/spectator grid
  });
});
