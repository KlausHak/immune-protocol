import { describe, expect, it } from 'vitest';
import { Terrain, type MapData } from '../../src/core/types';
import { DEFAULT_MAP_ID, getMap, listMaps } from '../../src/map';
import { buildMeilahti, MEILAHTI_POINTS, MEILAHTI_REGIONS } from '../../src/map/meilahti';
import { cacheRect, slotHqRect, validateMap } from '../../src/map/validate';

const b = buildMeilahti();
const map = b.finalize();
const report = b.validate(map);
const at = (m: MapData, x: number, y: number) => y * m.width + x;

/** Every tile of a w×h footprint centred on p (building convention) is buildable. */
function siteBuildable(m: MapData, p: { x: number; y: number }, w: number, h: number): boolean {
  const tx = Math.round(p.x - w / 2), ty = Math.round(p.y - h / 2);
  for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) if (!m.buildable[at(m, x, y)]) return false;
  return true;
}
function minCacheGap(m: MapData, p: { x: number; y: number }, w: number, h: number): number {
  const r = { x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w, h };
  let best = Infinity;
  for (const c of m.resources.map((q) => cacheRect(q.pos))) {
    const dx = Math.max(0, c.x - (r.x + r.w), r.x - (c.x + c.w)), dy = Math.max(0, c.y - (r.y + r.h), r.y - (c.y + c.h));
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}

describe('meilahti map', () => {
  it('passes validate(): connectivity, corridors ≥ 4 wide, accessible caches, sites', () => {
    expect(report.errors, report.errors.join('\n')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('has the DESIGN §6 metadata and every required region & point', () => {
    expect(map.id).toBe('meilahti');
    expect(map.name).toBe('HUS Meilahti Campus');
    expect([map.width, map.height]).toEqual([128, 128]);
    expect(map.lighting).toBe('nordic_dusk');
    expect(map.waterLevel).toBeLessThan(0);
    expect(map.heights.length).toBe(129 * 129);
    for (const r of MEILAHTI_REGIONS) expect(map.regions[r], r).toBeTruthy();
    for (const p of MEILAHTI_POINTS) expect(map.points[p], p).toBeTruthy();
  });

  it('slots: hospital at player_start (SE), pathogen at enemy_start (N, on the plateau)', () => {
    expect(map.slots).toEqual([
      { id: 1, faction: 'hospital', start: map.points.player_start },
      { id: 2, faction: 'pathogen', start: map.points.enemy_start },
    ]);
    const p1 = map.points.player_start!, p2 = map.points.enemy_start!;
    expect(p1.x).toBeGreaterThan(80); expect(p1.y).toBeGreaterThan(80);
    expect(p2.y).toBeLessThan(30);
    expect(map.levels[at(map, Math.floor(p2.x), Math.floor(p2.y))]).toBe(1);
    for (const s of map.slots) expect(siteBuildable(map, s.start, 5, 5), `slot ${s.id}`).toBe(true);
  });

  it('objective & Infection Core sites are valid', () => {
    for (const n of ['east_nest_core', 'west_nest_core'] as const) {
      expect(siteBuildable(map, map.points[n]!, 5, 5), n).toBe(true);
      expect(minCacheGap(map, map.points[n]!, 5, 5), n).toBeGreaterThanOrEqual(3);
    }
    const ch = map.points.childrens_hospital_center!;
    expect(siteBuildable(map, ch, 6, 6)).toBe(true);
    const reg = map.regions.childrens_hospital!;
    expect(ch.x > reg.x && ch.x < reg.x + reg.w && ch.y > reg.y && ch.y < reg.y + reg.h).toBe(true);
    // an 8×8 fully buildable square inside the region
    let found = false;
    for (let y = reg.y; y + 8 <= reg.y + reg.h && !found; y++) for (let x = reg.x; x + 8 <= reg.x + reg.w && !found; x++) {
      let ok = true;
      for (let yy = y; yy < y + 8 && ok; yy++) for (let xx = x; xx < x + 8; xx++) if (!map.buildable[at(map, xx, yy)]) { ok = false; break; }
      found = ok;
    }
    expect(found).toBe(true);
    for (const n of ['player_natural_hq', 'enemy_natural_hq', 'south_lot_hq', 'birch_park_hq', 'center_hq']) {
      expect(siteBuildable(map, map.points[n]!, 5, 5), n).toBe(true);
      expect(minCacheGap(map, map.points[n]!, 5, 5), n).toBeGreaterThanOrEqual(3);
    }
  });

  it('resources: 8 caches per main, 6 per nest, balanced sides', () => {
    const near = (p: { x: number; y: number }, r: number) => map.resources.filter((c) => Math.hypot(c.pos.x - p.x, c.pos.y - p.y) <= r).length;
    expect(near(map.points.player_start!, 10)).toBe(8);
    expect(near(map.points.enemy_start!, 10)).toBe(8);
    expect(near(map.points.east_nest_core!, 10)).toBe(6);
    expect(near(map.points.west_nest_core!, 10)).toBe(6);
    const s = report.stats.cachesNearer;
    expect(s.slot1).toBe(s.slot2);
    expect(s.contested).toBeGreaterThanOrEqual(2);
    // caches never sit on statically blocked tiles and are never buildable
    for (const c of map.resources) {
      const r = cacheRect(c.pos);
      for (let y = r.y; y < r.y + 2; y++) for (let x = r.x; x < r.x + 2; x++) {
        expect(map.blocked[at(map, x, y)]).toBe(0);
        expect(map.buildable[at(map, x, y)]).toBe(0);
      }
    }
  });

  it('balance: main ↔ main ~80–100 tiles, two similar main lanes and a longer west flank', () => {
    const { slotDistance, lanes } = report.stats;
    expect(slotDistance).toBeGreaterThanOrEqual(80);
    expect(slotDistance).toBeLessThanOrEqual(105);
    const c = lanes.central!, e = lanes.east!, w = lanes.west!;
    expect(Math.abs(c - e) / Math.min(c, e)).toBeLessThan(0.15);
    expect(w).toBeGreaterThan(Math.max(c, e) * 1.2);
  });

  it('terrain: sea along the west, ramps, contaminated plateau, snow, dressing kinds present', () => {
    for (let y = 2; y < 126; y += 8) expect([Terrain.Water, Terrain.Rock], `west edge y=${y}`).toContain(map.terrain[at(map, 1, y)]);
    let ramps = 0, snow = 0, cont = 0;
    for (let i = 0; i < map.terrain.length; i++) { ramps += map.ramps[i]!; if (map.terrain[i] === Terrain.Snow) snow++; if (map.terrain[i] === Terrain.Contaminated) cont++; }
    expect(ramps).toBeGreaterThanOrEqual(4 * 20);
    expect(snow).toBeGreaterThan(200);
    expect(cont).toBeGreaterThan(800);
    const kinds = new Set(map.doodads.map((d) => d.kind));
    for (const k of ['hospital_tower', 'hospital_wing', 'research_lab', 'skybridge', 'old_laundry', 'water_tower', 'parking_garage', 'pier',
      'helicopter_pad', 'ambulance', 'sign_er', 'bus', 'bus_stop', 'car', 'street_lamp', 'bench', 'fence', 'dumpster', 'flag_pole',
      'tree_birch', 'tree_pine', 'rock_granite', 'snow_pile', 'reeds', 'biohazard_barrel', 'goo_puddle', 'sewer_grate', 'infected_growth',
      'spore_vent', 'waste_container', 'traffic_cone', 'barrier', 'bush'] as const) expect(kinds.has(k), k).toBe(true);
    const decals = new Set(map.decals.map((d) => d.kind));
    for (const k of ['road_line', 'crosswalk', 'parking_lines', 'helipad_h', 'medical_cross', 'stain'] as const) expect(decals.has(k), k).toBe(true);
    // water heights sit below the water level away from the shore
    expect(map.heights[40 * 129 + 3]!).toBeLessThan(map.waterLevel);
  });

  it('is deterministic and getMap returns fresh copies', () => {
    const a = getMap('meilahti'), c = getMap('meilahti');
    expect(a).not.toBe(c);
    expect(Buffer.from(a.heights.buffer).equals(Buffer.from(c.heights.buffer))).toBe(true);
    expect(Buffer.from(a.blocked).equals(Buffer.from(map.blocked))).toBe(true);
    expect(Buffer.from(a.buildable).equals(Buffer.from(map.buildable))).toBe(true);
    expect(JSON.stringify(a.doodads)).toBe(JSON.stringify(map.doodads));
    expect(JSON.stringify(a.decals)).toBe(JSON.stringify(c.decals));
    a.blocked[500] = 9;
    expect(getMap('meilahti').blocked[500]).toBe(map.blocked[500]);
  });

  it('is registered as the default skirmish map', () => {
    const info = listMaps().find((m) => m.id === 'meilahti')!;
    expect(info).toMatchObject({ id: 'meilahti', name: 'HUS Meilahti Campus', players: 2, skirmish: true });
    expect(DEFAULT_MAP_ID()).toBe('meilahti');
    expect(getMap('does-not-exist').id).toBe('meilahti');
    expect(validateMap(getMap('meilahti')).ok).toBe(true);
    for (const s of map.slots) expect(slotHqRect(s)).not.toBeNull();
  });
});
