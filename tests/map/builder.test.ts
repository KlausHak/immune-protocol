import { describe, expect, it } from 'vitest';
import { LEVEL_HEIGHT } from '../../src/config';
import { sampleHeight } from '../../src/core/terrain';
import { Terrain, type MapData } from '../../src/core/types';
import { DOODAD_SPECS, MapBuilder, shape } from '../../src/map/builder';
import { cacheRect, corridorConnected, obstacleGrid, placeDistance, validateMap } from '../../src/map/validate';

const { rect } = shape;
const newBuilder = (w = 40, h = 40) => new MapBuilder({ id: 't', name: 'T', description: 'unit', width: w, height: h, seed: 7, lighting: 'day' });
const at = (m: MapData, x: number, y: number) => y * m.width + x;
const vh = (m: MapData, vx: number, vy: number) => m.heights[vy * (m.width + 1) + vx]!;

describe('MapBuilder terrain & elevation', () => {
  it('bakes plateaus with a blocked one-tile cliff ring and a flat buildable top', () => {
    const b = newBuilder();
    b.elevate(rect(10, 10, 12, 12), 1);
    b.ramp(14, 22, 4, 4, 'n', 0, 1);                  // without a ramp the plateau would be sealed as a pocket
    const m = b.finalize();
    expect(m.levels[at(m, 15, 15)]).toBe(1);
    expect(m.levels[at(m, 5, 5)]).toBe(0);
    // ring tiles are cliffs (blocked), interior is walkable + buildable at LEVEL_HEIGHT
    for (const [x, y] of [[10, 10], [15, 10], [21, 15], [11, 21]] as const) expect(m.blocked[at(m, x, y)], `cliff ${x},${y}`).toBe(1);
    expect(m.blocked[at(m, 15, 15)]).toBe(0);
    expect(m.buildable[at(m, 15, 15)]).toBe(1);
    // gentle noise (≤ 0.2) rides on top of the level height
    expect(Math.abs(vh(m, 15, 15) - LEVEL_HEIGHT)).toBeLessThanOrEqual(0.2 + 1e-6);
    expect(Math.abs(sampleHeight(m, 15.5, 15.5) - LEVEL_HEIGHT)).toBeLessThanOrEqual(0.2 + 1e-6);
    expect(vh(m, 11, 11)).toBeCloseTo(LEVEL_HEIGHT, 5);   // next to the cliff the noise fades to exactly flat
    // low ground right next to the cliff stays flat at 0 and walkable
    expect(m.blocked[at(m, 9, 15)]).toBe(0);
    expect(vh(m, 10, 15)).toBeCloseTo(0, 5);   // cliff-foot vertex stays exactly at level 0
  });

  it('ramps interpolate heights smoothly, are walkable, flagged, not buildable, and get side walls', () => {
    const b = newBuilder();
    b.elevate(rect(10, 4, 20, 10), 1);                // plateau rows 4..13
    b.ramp(16, 14, 6, 5, 'n', 0, 1);                  // ramp rows 14..18 ascending north
    const m = b.finalize();
    for (let y = 14; y <= 18; y++) for (let x = 16; x <= 21; x++) {
      expect(m.ramps[at(m, x, y)]).toBe(1);
      expect(m.blocked[at(m, x, y)]).toBe(0);
      expect(m.buildable[at(m, x, y)]).toBe(0);
      expect(m.levels[at(m, x, y)]).toBe(1);
    }
    // heights: linear from 0 at the low edge (y=19) to LEVEL_HEIGHT at the high edge (y=14)
    for (let vy = 14; vy <= 19; vy++) expect(vh(m, 18, vy)).toBeCloseTo((LEVEL_HEIGHT * (19 - vy)) / 5, 5);
    // continuous sampling across the ramp (no steps)
    let prev = sampleHeight(m, 18.5, 19.5);
    for (let y = 19.4; y >= 13.6; y -= 0.2) { const h = sampleHeight(m, 18.5, y); expect(Math.abs(h - prev)).toBeLessThan(0.1); prev = h; }
    // walls beside the ramp are blocked; plateau tile above the ramp and ground below are walkable
    expect(m.blocked[at(m, 15, 16)]).toBe(1);
    expect(m.blocked[at(m, 22, 16)]).toBe(1);
    expect(m.blocked[at(m, 18, 13)]).toBe(0);
    expect(m.blocked[at(m, 18, 19)]).toBe(0);
    // the plateau is reachable from the ground through the ramp
    expect(placeDistance({ ...m, points: { a: { x: 18.5, y: 25.5 }, b: { x: 18.5, y: 8.5 } } }, obstacleGrid(m), 'a', 'b')).not.toBeNull();
    expect(b.validate(m).errors.filter((e) => e.includes('ramp'))).toEqual([]);
  });

  it('reports ramps whose ends do not meet matching ground', () => {
    const b = newBuilder();
    b.elevate(rect(10, 4, 20, 10), 1);
    b.ramp(16, 16, 6, 4, 'n', 0, 1);                  // leaves a gap below the plateau
    const r = b.validate();
    expect(r.errors.some((e) => e.includes('ramp at 16,16'))).toBe(true);
  });

  it('water is blocked, unbuildable and below the water level away from the shore', () => {
    const b = newBuilder();
    b.water(rect(0, 0, 12, 40));
    const m = b.finalize();
    expect(m.terrain[at(m, 4, 20)]).toBe(Terrain.Water);
    expect(m.blocked[at(m, 4, 20)]).toBe(1);
    expect(m.buildable[at(m, 4, 20)]).toBe(0);
    expect(vh(m, 5, 20)).toBeLessThan(m.waterLevel);
    expect(vh(m, 12, 20)).toBeGreaterThan(m.waterLevel);   // shoreline vertex stays at land height
    expect(m.blocked[at(m, 12, 20)]).toBe(0);              // first land tile is walkable
  });

  it('keeps roads/plazas exactly flat and adds only gentle noise to grass', () => {
    const b = newBuilder(64, 64);
    b.road([[0, 32], [64, 32]], { width: 4 });
    b.paint(rect(4, 4, 10, 10), Terrain.Plaza);
    const m = b.finalize();
    let maxGrass = 0;
    for (let vy = 0; vy <= 64; vy++) for (let vx = 0; vx <= 64; vx++) maxGrass = Math.max(maxGrass, Math.abs(vh(m, vx, vy)));
    expect(maxGrass).toBeGreaterThan(0.01);
    expect(maxGrass).toBeLessThanOrEqual(0.2 + 1e-6);
    for (let vx = 0; vx <= 64; vx++) expect(vh(m, vx, 32)).toBe(0);
    for (let v = 4; v <= 14; v++) expect(vh(m, v, 9)).toBe(0);
    expect(m.terrain[at(m, 20, 31)]).toBe(Terrain.Asphalt);
    expect(m.terrain[at(m, 20, 29)]).toBe(Terrain.Concrete);   // kerb
    expect(m.decals.some((d) => d.kind === 'road_line')).toBe(true);
  });
});

describe('MapBuilder doodads, caches, sites', () => {
  it('blocking doodads bake their rotated footprint; walkable ones only make tiles unbuildable', () => {
    const b = newBuilder();
    b.doodad('hospital_wing', 20, 20, { rot: Math.PI / 2 });   // 12×6 rotated → 6 wide (x) × 12 tall (y)
    b.doodad('bush', 5.5, 5.5);
    b.doodad('tree_pine', 30.3, 8.7, { snap: false });
    const m = b.finalize();
    let n = 0;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (m.blocked[at(m, x, y)] && x > 0 && y > 0 && x < 39 && y < 39) n++;
    expect(n).toBe(6 * 12 + 1);
    expect(m.blocked[at(m, 17, 14)]).toBe(1);
    expect(m.blocked[at(m, 22, 25)]).toBe(1);
    expect(m.blocked[at(m, 16, 20)]).toBe(0);
    expect(m.blocked[at(m, 23, 20)]).toBe(0);
    expect(m.blocked[at(m, 5, 5)]).toBe(0);
    expect(m.buildable[at(m, 5, 5)]).toBe(0);
    expect(m.blocked[at(m, 30, 8)]).toBe(1);
    const wing = m.doodads.find((d) => d.kind === 'hospital_wing')!;
    expect(wing.footprint).toEqual({ w: DOODAD_SPECS.hospital_wing.w, h: DOODAD_SPECS.hospital_wing.h });
    expect(m.doodads.find((d) => d.kind === 'bush')!.footprint).toBeUndefined();
  });

  it('caches keep their tiles unblocked but unbuildable, centred where World.spawnResource puts them', () => {
    const b = newBuilder();
    b.cache(20, 20, 1200);
    const m = b.finalize();
    expect(m.resources).toEqual([{ pos: { x: 20, y: 20 }, amount: 1200 }]);
    const r = cacheRect(m.resources[0]!.pos);
    expect(r).toEqual({ x: 19, y: 19, w: 2, h: 2 });
    for (let y = 19; y <= 20; y++) for (let x = 19; x <= 20; x++) {
      expect(m.blocked[at(m, x, y)]).toBe(0);
      expect(m.buildable[at(m, x, y)]).toBe(0);
    }
    expect(m.buildable[at(m, 22, 20)]).toBe(1);
  });

  it('records conflicts: doodads on sites, caches on blockers', () => {
    const b = newBuilder();
    b.site('hq', 10, 10, 5, 5);
    b.doodad('rock_granite', 12, 12);
    b.doodad('dumpster', 30, 30.5);
    b.cache(30, 30);
    const r = b.validate();
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('rock_granite') && e.includes('site'))).toBe(true);
    expect(r.errors.some((e) => e.includes('cache (30,30)'))).toBe(true);
  });

  it('seals tiny walkable pockets enclosed by props', () => {
    const b = newBuilder();
    for (const [x, y] of [[20, 19], [19, 20], [21, 20], [20, 21]] as const) b.doodad('tree_birch', x + 0.5, y + 0.5);
    const m = b.finalize();
    expect(m.blocked[at(m, 20, 20)]).toBe(1);
    expect(b.sealedPocketTiles).toBe(1);
  });
});

describe('validateMap', () => {
  const twoRooms = (gap: number) => {
    const b = newBuilder(48, 32);
    b.block(rect(24, 0, 1, 32));                                    // wall down the middle…
    if (gap > 0) b.forTiles(rect(24, 14, 1, gap), () => {});        // (no-op: carve below)
    const m = b.finalize();
    if (gap > 0) for (let y = 14; y < 14 + gap; y++) { m.blocked[at(m, 24, y)] = 0; }
    m.slots = [{ id: 1, faction: 'hospital', start: { x: 8.5, y: 16.5 } }, { id: 2, faction: 'pathogen', start: { x: 38.5, y: 16.5 } }];
    m.points = { a: { x: 12.5, y: 5.5 }, b: { x: 36.5, y: 5.5 } };
    m.regions = { east: { x: 30, y: 20, w: 8, h: 8 } };
    return m;
  };

  it('reports unreachable slots/regions/points with coordinates', () => {
    const r = validateMap(twoRooms(0), { regions: ['east', 'missing_region'], points: ['a', 'b', 'missing_point'] });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('missing required region "missing_region"');
    expect(r.errors).toContain('missing required point "missing_point"');
    expect(r.errors.some((e) => e.startsWith('slot 2 at (38.5,16.5) is not reachable'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('region "east" (30,20 8×8)'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('point "b" (36.5,5.5)'))).toBe(true);
    expect(r.stats.slotDistance).toBeNull();
  });

  it('measures ground distance and corridor width', () => {
    const m3 = twoRooms(3);
    const r3 = validateMap(m3, { corridors: [{ from: 'slot1', to: 'slot2', width: 4 }] });
    expect(r3.errors.some((e) => e.includes('no passage at least 4 tiles wide'))).toBe(true);
    expect(r3.stats.slotDistance).toBeGreaterThan(20);
    expect(corridorConnected(m3, obstacleGrid(m3), 'slot1', 'slot2', 3)).toBe(true);
    const m4 = twoRooms(4);
    const r4 = validateMap(m4, { corridors: [{ from: 'slot1', to: 'slot2', width: 4 }], lanes: [{ name: 'direct', via: [] }] });
    expect(r4.ok, r4.errors.join('\n')).toBe(true);
    expect(r4.stats.lanes.direct).toBeCloseTo(r4.stats.slotDistance!, 0);
  });

  it('flags caches without access and HQ slots on unbuildable ground', () => {
    const b = newBuilder(48, 32);
    b.cache(10, 10);
    b.block(rect(8, 8, 1, 4)).block(rect(11, 8, 1, 4)).block(rect(9, 8, 2, 1)).block(rect(9, 11, 2, 1));
    b.slot(1, 'hospital', 30.5, 16.5).slot(2, 'pathogen', 40.5, 16.5);
    b.doodad('bench', 30.5, 16.5);
    const r = b.validate();
    expect(r.errors.some((e) => e.includes('cache 0 at 10,10 has only 0 reachable access tiles'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('slot 1 HQ: tile 30,16 is not buildable'))).toBe(true);
  });

  it('is deterministic', () => {
    const mk = () => {
      const b = newBuilder(64, 64);
      b.scatter(['tree_birch', 'rock_granite'], rect(0, 0, 64, 64), { count: 60 });
      b.road([[0, 10], [64, 50]], { width: 4, lamps: 6 });
      return b.finalize();
    };
    const a = mk(), c = mk();
    expect(Buffer.from(a.heights.buffer).equals(Buffer.from(c.heights.buffer))).toBe(true);
    expect(Buffer.from(a.blocked).equals(Buffer.from(c.blocked))).toBe(true);
    expect(JSON.stringify(a.doodads)).toBe(JSON.stringify(c.doodads));
    expect(a.doodads.length).toBeGreaterThan(40);
  });
});
