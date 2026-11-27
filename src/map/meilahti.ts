/**
 * [map] HUS Meilahti Campus (fictionalised) — 128×128 tiles, north = −y, nordic dusk. DESIGN §5/§6.
 *
 *   West   the sea bay — shoreline rocks, reeds, skerries and a pier. Impassable for ground units.
 *   North  raised, contaminated plateau (level 1): old laundry, water tower, waste plant — pathogen main (slot 2,
 *          8 caches) with two ramps: S → its natural, E → the sewer outflow (`enemy_east_nest`, NE, 6 caches).
 *   West   waste depot (`enemy_west_nest`, 6 caches) on the shore road.
 *   Centre Tower Hospital complex (tower + 3 wings + skybridge — one solid block), Biomedicum, central plaza
 *          with 4 contested caches + an expansion site, the open Children's Hospital site west of centre.
 *   SE     ER plaza — hospital main (slot 1): 8-cache logistics dock, helipad, ambulance bay, flag poles.
 *   East   natural expansion on the raised parking deck (level 1, ramps N and SW).
 *   South  visitor parking (expansion) and the birch park with the paramedic station (expansion).
 *
 * Lanes (hospital → pathogen): central (plaza → north gate → natural → S ramp), east (corridor beside the deck →
 * east gate → east road → E ramp) and the longer west flank (park → shore road → waste depot → natural).
 * Forest walls (blocked woodland) separate the west flank from the centre; chokepoints are ≥ 5 tiles wide.
 */
import { Terrain, type MapData } from '../core/types';
import { MapBuilder } from './builder';
import { contaminate, crosswalk, forestWall, grove, infectionProps, parkingLot, parkingRow, shoreline, snowPatches } from './dressing';
import { shape, type Shape } from './shapes';

const { rect, circle, poly, blob, union } = shape;
const R90 = Math.PI / 2;
const R180 = Math.PI;

/** Region names the campaign relies on (DESIGN §6). */
export const MEILAHTI_REGIONS = [
  'player_base', 'player_natural', 'enemy_core', 'enemy_natural', 'enemy_east_nest', 'enemy_west_nest',
  'childrens_hospital', 'paramedic_station', 'center', 'north_gate', 'east_gate',
] as const;
/** Point names the campaign relies on (DESIGN §6). */
export const MEILAHTI_POINTS = [
  'player_start', 'enemy_start', 'wave_spawn_north', 'wave_spawn_east', 'wave_spawn_west', 'omega_spawn',
  'rally_center', 'helipad', 'east_nest_core', 'west_nest_core', 'childrens_hospital_center',
] as const;

export const MEILAHTI_DESCRIPTION =
  'The HUS Meilahti hospital campus on the Helsinki shore. The outbreak spreads from the contaminated laundry ' +
  'plateau in the north; the hospital holds the ER plaza in the south-east. Two main lanes through the campus and ' +
  'a long western flank along the sea bay.';

/** Land tiles within `r` tiles (Chebyshev) of water, restricted to `area`. */
function nearWater(b: MapBuilder, area: Shape, r: number): Shape {
  return {
    x0: area.x0, y0: area.y0, x1: area.x1, y1: area.y1,
    has: (px, py) => {
      if (!area.has(px, py)) return false;
      const tx = Math.floor(px), ty = Math.floor(py);
      if (b.inside(tx, ty) && b.terrainAt(tx, ty) === Terrain.Water) return false;
      for (let y = ty - r; y <= ty + r; y++) for (let x = tx - r; x <= tx + r; x++) {
        if (b.inside(x, y) && b.terrainAt(x, y) === Terrain.Water) return true;
      }
      return false;
    },
  };
}

export function buildMeilahti(): MapBuilder {
  const b = new MapBuilder({
    id: 'meilahti', name: 'HUS Meilahti Campus', description: MEILAHTI_DESCRIPTION,
    width: 128, height: 128, seed: 0x4d65696c, lighting: 'nordic_dusk', waterLevel: -0.35,
  });

  // ═════════════════════════ 1. sea bay & skerries ═════════════════════════
  const coast: Array<[number, number]> = [
    [41, 0], [41, 8], [40, 16], [41, 24], [39, 29], [35, 33], [29, 37], [23, 42], [19, 48], [16, 55], [15, 62],
    [16, 68], [19, 73], [18, 79], [15, 85], [13, 92], [13, 100], [15, 108], [17, 116], [18, 122], [19, 128],
  ];
  b.water(poly([[0, 0], ...coast, [0, 128]]));
  for (const [x, y, r] of [[7, 40, 2.6], [13, 20, 1.8], [5, 74, 2.8], [8, 110, 2.1], [24, 9, 1.6]] as const) {
    const s = blob(x, y, r, x * 31 + y, 0.4);
    b.paint(s, Terrain.Rock, { over: [Terrain.Water] });
    b.block(s);
  }
  b.doodad('tree_pine', 7.5, 40.5, { overlap: true, scale: 1.1 });
  b.doodad('tree_pine', 5.5, 73.5, { overlap: true, scale: 0.9 });

  // ═════════════════════════ 2. elevation ═════════════════════════
  // pathogen plateau (level 1), rows 0..31 — the sea tiles inside the polygon are skipped
  b.elevate(poly([[36, 0], [97, 0], [97, 26], [93, 32], [44, 32], [38, 26], [36, 20]]), 1, { terrain: Terrain.Contaminated, cliff: Terrain.Rock });
  b.ramp(58, 32, 6, 5, 'n', 0, 1, { terrain: Terrain.Concrete });   // S ramp: x 58..63, y 32..36
  b.ramp(97, 19, 5, 6, 'w', 0, 1, { terrain: Terrain.Concrete });   // E ramp: x 97..101, y 19..24
  // parking deck (level 1): x 104..126, y 58..86
  b.elevate(rect(104, 58, 23, 29), 1, { terrain: Terrain.Concrete, cliff: Terrain.Concrete });
  b.ramp(110, 53, 6, 5, 's', 0, 1, { terrain: Terrain.Asphalt });   // N ramp: x 110..115, y 53..57
  b.ramp(105, 87, 6, 5, 'n', 0, 1, { terrain: Terrain.Asphalt });   // SW ramp: x 105..110, y 87..91

  // ═════════════════════════ 3. ground ═════════════════════════
  b.paint(rect(84, 89, 31, 28), Terrain.Plaza);                     // ER plaza (player main)
  b.paint(rect(55, 61, 14, 20), Terrain.Plaza);                     // central plaza
  b.paint(rect(69, 51, 28, 30), Terrain.Concrete);                  // tower hospital block
  b.paint(rect(77, 61, 9, 7), Terrain.Grass);                       // its inner garden courtyard
  b.paint(rect(49, 52, 12, 10), Terrain.Concrete);                  // Biomedicum lot
  b.paint(rect(43, 65, 10, 10), Terrain.Concrete);                  // Children's Hospital foundation slab
  b.paint(rect(44, 15, 17, 7), Terrain.Concrete);                   // laundry loading yard (plateau)
  b.paint(rect(78, 2, 18, 12), Terrain.Concrete);                   // waste plant yard (plateau)
  b.paint(rect(18, 52, 15, 20), Terrain.Dirt);                      // waste depot
  b.paint(rect(21, 55, 8, 3), Terrain.Concrete).paint(rect(21, 66, 8, 3), Terrain.Concrete);
  b.paint(blob(114, 19, 11, 3, 0.35), Terrain.Dirt);                 // sewer outflow works
  b.paint(rect(97, 5, 12, 4), Terrain.Concrete);                    // outfall culvert apron
  b.water(blob(115, 6, 5.5, 11, 0.35));                             // contaminated settling pond
  b.paint(nearWater(b, rect(10, 86, 30, 42), 2), Terrain.Sand);     // park beach
  b.paint(nearWater(b, rect(20, 30, 20, 20), 1), Terrain.Sand);     // natural's shingle

  // ═════════════════════════ 4. roads ═════════════════════════
  b.road([[18, 86.5], [100.5, 86.5]], { width: 5, lamps: 9 });                                // cross street (E–W)
  b.road([[61, 37], [61, 41], [67, 47], [67, 84]], { width: 4, lamps: 8, lampSides: 'right' }); // central street via north gate
  b.road([[102, 21.5], [100.5, 26], [100.5, 94]], { width: 5, lamps: 9 });                    // east road → corridor → ER
  b.road([[127, 46], [103, 46]], { width: 4, lamps: 10 });                                    // east entrance
  b.road([[31, 47], [44, 39], [96, 39], [100.5, 34]], { width: 4, lamps: 10 });               // north road
  b.road([[31, 47], [35, 54], [35, 84]], { width: 4, lamps: 10 });                            // shore road (west flank)
  b.road([[70, 89], [70, 102]], { width: 4, centerLine: false });                             // visitor parking drive
  b.road([[70, 104], [86, 104]], { width: 4, centerLine: false });                            // lot ↔ ER link
  b.road([[90, 89], [90, 95]], { width: 4, centerLine: false });                              // ER drive
  b.road([[102, 28], [113, 28]], { width: 4, centerLine: false });                            // outflow access
  b.road([[61, 31], [61, 25], [65, 21]], { width: 4, kerb: 0, centerLine: false });          // plateau: S ramp → core
  b.road([[96, 21.5], [83, 21.5]], { width: 4, kerb: 0, centerLine: false });                // plateau: E ramp → core
  b.road([[108, 86], [108, 76], [113, 66], [113, 58]], { width: 4, kerb: 0, centerLine: false, terrain: Terrain.Asphalt }); // deck drive
  const path = { width: 2, kerb: 0, centerLine: false, terrain: Terrain.Plaza } as const;   // park footpaths
  b.road([[30, 89], [36, 99], [45, 107], [56, 116]], path);
  b.road([[19, 98], [30, 100], [36, 99]], path);
  b.road([[45, 107], [44, 124]], path);
  b.road([[50, 89], [52, 100], [56, 116]], path);

  // ═════════════════════════ 5. sites & caches ═════════════════════════
  const P1 = b.site('player_start', 96, 98, 5, 5);                               // (98.5, 100.5)
  const P2 = b.site('enemy_start', 68, 15, 5, 5);                                // (70.5, 17.5)
  b.cacheArc(P1.x, P1.y, 8.5, 15, 165, 8);                                       // logistics dock
  b.cacheArc(P2.x, P2.y, 8.5, 195, 345, 8);                                      // plateau caches
  const PN = b.site('player_natural_hq', 112, 70, 5, 5, { minCacheGap: 3 });     // (114.5, 72.5)
  b.cacheArc(PN.x, PN.y, 8, -60, 60, 6);
  const EN = b.site('enemy_natural_hq', 46, 41, 5, 5, { minCacheGap: 3 });       // (48.5, 43.5)
  b.cacheArc(EN.x, EN.y, 8.5, 135, 255, 6);
  const EE = b.site('east_nest_core', 114, 20, 5, 5, { minCacheGap: 3 });        // (116.5, 22.5)
  for (const [x, y] of [[111, 15], [114, 14], [117, 14], [120, 15], [123, 17], [123, 21]] as const) b.cache(x, y);
  const EW = b.site('west_nest_core', 25, 59, 5, 5, { minCacheGap: 3 });         // (27.5, 61.5)
  b.cacheArc(EW.x, EW.y, 8, 120, 240, 6);
  const SL = b.site('south_lot_hq', 67, 106, 5, 5, { minCacheGap: 3 });          // (69.5, 108.5)
  b.cacheArc(SL.x, SL.y, 8, 30, 150, 6);
  const BP = b.site('birch_park_hq', 33, 107, 5, 5, { minCacheGap: 3 });         // (35.5, 109.5)
  b.cacheArc(BP.x, BP.y, 8, 120, 240, 6);
  const CC = b.site('center_hq', 59, 66, 5, 5, { minCacheGap: 3 });              // (61.5, 68.5) contested
  for (const [x, y] of [[55, 62], [55, 65], [55, 72], [55, 75]] as const) b.cache(x, y);
  const CH = b.site('childrens_hospital_center', 45, 67, 6, 6);                  // (48, 70)

  // ═════════════════════════ 6. campus architecture ═════════════════════════
  b.doodad('research_lab', 55, 57);                                    // Biomedicum: x 50..59, y 53..60
  b.doodad('hospital_tower', 76, 56);                                  // x 69..82, y 51..60
  b.doodad('skybridge', 76, 64, { rot: R90, overlap: true });          // x 75..76, y 60..67 (tower ↔ wing)
  b.doodad('hospital_wing', 76, 71);                                   // x 70..81, y 68..73
  b.doodad('hospital_wing', 89, 57, { rot: R90 });                     // x 86..91, y 51..62
  b.doodad('hospital_wing', 88, 77);                                   // x 82..93, y 74..79
  b.block(rect(69, 51, 28, 30));                                       // the complex is one solid block
  grove(b, ['tree_birch'], rect(77, 61, 9, 7), 0.25, {});               // (inside the block: courtyard garden)
  b.scatter(['tree_birch', 'bush'], rect(69, 51, 28, 30), { count: 26, minDist: 1.6, allowBlocked: true, allowPaved: true, margin: 0 });
  b.doodad('old_laundry', 52, 11);                                     // x 47..56, y 7..14 (chimney)
  b.doodad('water_tower', 90.5, 7.5);
  b.doodad('parking_garage', 116, 39);                                 // x 110..121, y 34..43
  b.doodad('hospital_wing', 35, 93.5, { scale: 0.5 });                 // paramedic station: x 32..37, y 92..94

  // ═════════════════════════ 7. lane-shaping woodland & rock ═════════════════════════
  forestWall(b, rect(38, 51, 12, 11));                                 // between shore road and the Biomedicum
  forestWall(b, rect(37, 62, 4, 10));                                  // west of the Children's site …
  forestWall(b, rect(37, 78, 4, 5));                                   // … with a 6-tile gap at y 72..77
  forestWall(b, rect(72, 43, 24, 8));                                  // pine belt between north road and the complex
  forestWall(b, rect(82, 92, 2, 10), ['tree_birch']);                  // hedge between visitor parking and the ER plaza
  forestWall(b, rect(82, 107, 2, 19), ['tree_birch']);
  forestWall(b, rect(104, 47, 6, 6), ['tree_pine', 'tree_birch']);     // copse west of the deck's north ramp
  forestWall(b, rect(117, 48, 10, 5), ['tree_pine']);                  // and east of it
  b.rock(blob(26, 96, 2.2, 5), 2).rock(blob(49, 121, 2.6, 6), 3).rock(blob(53, 96, 1.8, 7), 1);
  b.rock(blob(44, 30, 2.0, 8), 2).rock(blob(86, 34, 1.6, 9), 1).rock(blob(122, 30, 2.4, 10), 2);

  // ═════════════════════════ 8. areas ═════════════════════════
  // ── ER plaza (player main) ──
  b.doodad('helicopter_pad', 118, 100);
  b.decal('helipad_h', 118, 100, 3.2, 3.2);
  for (const [x, y] of [[115.5, 97.5], [120.5, 97.5], [115.5, 102.5], [120.5, 102.5]] as const) b.doodad('traffic_cone', x, y, { optional: true });
  b.decal('medical_cross', 91.5, 92.5, 3, 3);
  b.decal('medical_cross', 106, 96.5, 2.4, 2.4);
  for (const x of [95.5, 98.5, 101.5]) b.doodad('flag_pole', x, 94.5, { seed: Math.round(x) });
  b.doodad('sign_er', 94.5, 97.5, { rot: R180 });
  for (const y of [97.5, 99.5, 101.5]) b.doodad('ambulance', 87, y, { rot: 0 });
  b.doodad('ambulance', 112, 92.5, { rot: R180 });
  b.decal('arrow', 92, 92, 1.6, 1, R90).decal('arrow', 100.5, 90, 1.6, 1, R90);
  for (const [x, y] of [[85.5, 95.5], [85.5, 107.5], [112.5, 108.5], [86.5, 113.5]] as const) b.doodad('bench', x, y, { rot: 0, optional: true });
  for (const [x, y] of [[85.5, 90.5], [113.5, 90.5], [85.5, 101.5], [113.5, 105.5], [85.5, 115.5], [113.5, 115.5], [99.5, 115.5]] as const) b.doodad('street_lamp', x, y, { optional: true });
  for (const [x, y] of [[104, 117.5], [108, 117.5], [112, 117.5]] as const) b.doodad('dumpster', x, y, { optional: true });
  for (const [x, y] of [[90, 117.5], [94, 117.5]] as const) b.doodad('barrier', x, y, { optional: true });
  b.doodad('waste_container', 116, 113.5, { rot: R90, optional: true });
  parkingLot(b, 116, 105, 9, 7, true, 0.6);                             // staff parking
  b.scatter(['tree_birch', 'tree_pine'], rect(115, 113, 11, 13), { count: 22, minDist: 1.8 });
  b.scatter(['tree_birch', 'bush'], rect(84, 117, 30, 9), { count: 16, minDist: 2.2 });

  // ── parking deck (player natural) ──
  // stalls only along the deck margins: the drives between both ramps and the HQ site stay open
  parkingRow(b, 105, 59, 5, true, R90, 0.6);
  parkingRow(b, 117, 59, 8, true, R90, 0.6);
  parkingRow(b, 113, 84, 12, true, -R90, 0.6);
  for (const [x, y] of [[104.5, 66.5], [104.5, 78.5], [111.5, 66.5], [111.5, 78.5], [125.5, 61.5], [125.5, 84.5]] as const) b.doodad('street_lamp', x, y, { optional: true });
  b.decal('arrow', 108, 80, 1.6, 1, -R90).decal('arrow', 113, 61, 1.6, 1, -R90);

  // ── visitor parking (south expansion) ──
  parkingLot(b, 56, 91, 12, 10, true, 0.55);
  parkingLot(b, 73, 91, 9, 10, true, 0.5);
  b.doodad('bus_stop', 60, 89.5, { rot: 0 });
  b.doodad('bus', 60, 87.5, { rot: R180 });
  for (const x of [56.5, 63.5]) b.doodad('bench', x, 89.5, { rot: 0, optional: true });
  b.scatter(['tree_birch', 'bush'], rect(56, 117, 26, 9), { count: 18, minDist: 2 });
  b.scatter(['snow_pile'], rect(56, 91, 26, 10), { count: 6, minDist: 3, allowRoads: true, allowPaved: true });

  // ── birch park & paramedic station ──
  for (const y of [96.5, 98.5]) b.doodad('ambulance', 40, y, { rot: R180 });
  b.doodad('sign_er', 38.5, 91.5);
  b.doodad('flag_pole', 31.5, 91.5);
  b.doodad('pier', 13, 104, { rot: R90 });
  b.doodad('pier', 15, 119, { rot: R90 + 0.15, snap: false });
  for (const [x, y] of [[33.5, 98.5], [41.5, 104.5], [49.5, 112.5], [21.5, 99.5], [47.5, 92.5], [43.5, 118.5]] as const) b.doodad('bench', x, y, { rot: 0.4, optional: true });
  for (const [x, y] of [[31.5, 95.5], [39.5, 103.5], [51.5, 113.5], [25.5, 100.5], [44.5, 121.5]] as const) b.doodad('street_lamp', x, y, { optional: true });
  const parkOpen = union(circle(BP.x, BP.y, 11), rect(28, 89, 16, 12), rect(36, 103, 22, 10),
    shape.line([[30, 89], [36, 99], [45, 107], [56, 116]], 7), shape.line([[50, 89], [52, 100], [56, 116]], 7));
  grove(b, ['tree_birch', 'tree_birch', 'tree_birch', 'tree_pine'], rect(18, 89, 38, 37), 0.08, { avoid: parkOpen });
  b.scatter('bush', rect(18, 89, 38, 37), { count: 24, minDist: 2.5 });

  // ── Children's Hospital construction site ──
  for (let x = 43.5; x <= 52.5; x += 3) { b.doodad('traffic_cone', x, 65.5, { optional: true }); b.doodad('traffic_cone', x, 74.5, { optional: true }); }
  for (let y = 68.5; y <= 71.5; y += 3) { b.doodad('traffic_cone', 43.5, y, { optional: true }); b.doodad('traffic_cone', 52.5, y, { optional: true }); }
  for (const [x, y] of [[43, 63.5], [52, 63.5], [43, 76.5], [52, 76.5]] as const) b.doodad('barrier', x, y);

  // ── central plaza & north gate ──
  b.decal('medical_cross', 61.5, 64.5, 2.6, 2.6);
  for (const [x, y] of [[58.5, 62.5], [63.5, 62.5], [58.5, 79.5], [63.5, 79.5]] as const) b.doodad('bench', x, y, { rot: 0, optional: true });
  for (const [x, y] of [[57.5, 64.5], [57.5, 76.5], [57.5, 80.5]] as const) b.doodad('tree_birch', x, y, { optional: true });
  crosswalk(b, 67, 50, 0, 5);
  crosswalk(b, 67, 82, 0, 5);
  crosswalk(b, 63, 86.5, R90, 6);
  crosswalk(b, 100.5, 84, 0, 6);
  crosswalk(b, 35, 82, 0, 5);
  crosswalk(b, 100.5, 48.5, 0, 6);

  // ── pathogen plateau: laundry, waste plant, the core ──
  for (const [x, y, r] of [[47, 18.5, 0], [50, 18.5, 0], [58, 17, R90], [58, 20, R90]] as const) b.doodad('waste_container', x, y, { rot: r, optional: true });
  for (const [x, y] of [[45, 16.5], [53, 20.5]] as const) b.doodad('dumpster', x, y, { optional: true });
  b.doodad('car', 50, 21.5, { rot: 0.3, snap: false, optional: true });
  b.fenceLine([[78, 14], [96, 14]], { skip: (x) => x > 84 && x < 90 });  // waste plant fence with a gate
  b.fenceLine([[78, 2], [78, 14]]);
  for (const [x, y] of [[81, 4.5], [84, 4.5], [81, 7.5], [84, 7.5], [81, 10.5]] as const) b.doodad('waste_container', x, y, { optional: true });
  for (const [x, y] of [[87.5, 3.5], [88.5, 4.5], [93.5, 11.5], [87.5, 11.5]] as const) b.doodad('biohazard_barrel', x, y, { optional: true });
  b.doodad('dumpster', 94, 3.5, { optional: true });
  contaminate(b, 61, 36, 8, { puddles: 5, over: [Terrain.Grass, Terrain.Dirt, Terrain.Snow, Terrain.Sand] });
  contaminate(b, 48, 40, 9, { puddles: 4 });
  contaminate(b, 88, 32, 6, { puddles: 2 });
  infectionProps(b, rect(37, 1, 60, 31), 70, { avoid: union(circle(P2.x, P2.y, 12.5), rect(56, 20, 12, 16), rect(80, 17, 20, 10)) });
  b.scatter('tree_pine', rect(37, 1, 60, 3), { count: 16, minDist: 2, allowBlocked: true });

  // ── enemy natural ──
  infectionProps(b, rect(32, 33, 40, 15), 14, { avoid: union(circle(EN.x, EN.y, 11), rect(54, 33, 16, 16)) });
  b.scatter(['tree_pine', 'rock_granite'], nearWater(b, rect(22, 30, 20, 22), 3), { count: 10, minDist: 2.5 });

  // ── waste depot (west nest) ──
  b.fenceLine([[32, 52], [32, 58]]);
  b.fenceLine([[32, 65], [32, 72]]);
  for (const [x, y] of [[20, 53.5], [23, 53.5], [26, 53.5], [20, 70.5], [23, 70.5], [26, 70.5]] as const) b.doodad('waste_container', x, y, { optional: true });
  for (const [x, y] of [[29, 53.5], [29, 70.5]] as const) b.doodad('dumpster', x, y, { optional: true });
  contaminate(b, 26, 62, 10, { puddles: 5 });
  infectionProps(b, rect(17, 50, 16, 23), 16, { avoid: circle(EW.x, EW.y, 10) });

  // ── sewer outflow (east nest) ──
  contaminate(b, 116, 21, 10, { puddles: 6, over: [Terrain.Grass, Terrain.Dirt, Terrain.Snow] });
  for (const [x, y] of [[99.5, 6.5], [103.5, 6.5], [107.5, 7.5]] as const) b.doodad('sewer_grate', x, y, { optional: true });
  infectionProps(b, rect(102, 2, 24, 30), 18, { avoid: union(circle(EE.x, EE.y, 10), rect(97, 17, 8, 10)) });
  b.scatter(['tree_pine', 'tree_birch'], rect(102, 24, 24, 9), { count: 14, minDist: 2, avoid: rect(100, 25, 16, 6) });

  // ── east entrance & parking garage ──
  b.doodad('car', 106, 42.5, { rot: R180, optional: true });
  b.scatter(['tree_pine', 'tree_birch'], rect(122, 30, 5, 14), { count: 8, minDist: 1.8, allowBlocked: true });

  // ═════════════════════════ 9. weather & ground clutter ═════════════════════════
  b.doodad('reeds', 16.5, 84.5, { optional: true });
  shoreline(b, rect(10, 30, 34, 98), 24, 46);
  snowPatches(b, rect(2, 2, 124, 124), 85, [1.5, 4.2], 0);
  b.scatter('snow_pile', rect(2, 2, 124, 124), { count: 46, minDist: 3, allowPaved: true, scale: [0.7, 1.3] });
  for (let k = 0; k < 14; k++) {
    const x = b.rng.range(20, 100), y = b.rng.range(36, 90);
    const tx = Math.floor(x), ty = Math.floor(y);
    if (b.terrainAt(tx, ty) === Terrain.Asphalt) b.decal('manhole', tx + 0.5, ty + 0.5, 0.9, 0.9);
  }

  // ═════════════════════════ 10. names ═════════════════════════
  b.slot(1, 'hospital', P1.x, P1.y).slot(2, 'pathogen', P2.x, P2.y);
  b.point('player_start', P1.x, P1.y).point('enemy_start', P2.x, P2.y);
  b.point('east_nest_core', EE.x, EE.y).point('west_nest_core', EW.x, EW.y).point('childrens_hospital_center', CH.x, CH.y);
  b.point('wave_spawn_north', 60.5, 42.5).point('wave_spawn_east', 123.5, 46.5).point('wave_spawn_west', 31.5, 49.5);
  b.point('omega_spawn', 54.5, 25.5).point('rally_center', 62.5, 64.5).point('helipad', 118, 100);
  // extra helpers for AI/campaign: expansion HQ centres and lane waypoints
  b.point('player_natural_hq', PN.x, PN.y).point('enemy_natural_hq', EN.x, EN.y).point('south_lot_hq', SL.x, SL.y);
  b.point('birch_park_hq', BP.x, BP.y).point('center_hq', CC.x, CC.y);
  b.point('lane_east', 100.5, 70.5).point('lane_west', 35.5, 76.5).point('lane_north', 84.5, 38.5);
  b.region('player_base', 84, 88, 43, 39).region('player_natural', 104, 58, 23, 29);
  b.region('enemy_core', 40, 1, 57, 31).region('enemy_natural', 32, 32, 40, 17);
  b.region('enemy_east_nest', 102, 2, 25, 30).region('enemy_west_nest', 16, 50, 20, 23);
  b.region('childrens_hospital', 42, 64, 12, 12).region('paramedic_station', 26, 88, 18, 12);
  b.region('center', 54, 61, 15, 20).region('north_gate', 60, 48, 9, 13).region('east_gate', 96, 44, 14, 9);
  b.region('south_lot', 56, 90, 26, 36).region('birch_park', 18, 89, 38, 37);
  b.require({
    regions: [...MEILAHTI_REGIONS], points: [...MEILAHTI_POINTS],
    corridors: [
      ...['enemy_start', 'player_natural_hq', 'enemy_natural_hq', 'east_nest_core', 'west_nest_core', 'south_lot_hq', 'birch_park_hq',
        'center_hq', 'childrens_hospital_center', 'paramedic_station', 'rally_center', 'north_gate', 'east_gate', 'wave_spawn_north',
        'wave_spawn_east', 'wave_spawn_west', 'helipad', 'omega_spawn'].map((to) => ({ from: 'player_start', to, width: 4 })),
      { from: 'omega_spawn', to: 'childrens_hospital_center', width: 5 },
    ],
    // listed from the hospital (slot 1) toward the pathogen main (slot 2)
    lanes: [
      { name: 'central', via: ['rally_center', 'north_gate'] },
      { name: 'east', via: ['lane_east', 'east_gate'] },
      { name: 'west', via: ['lane_west', 'wave_spawn_west'] },
    ],
  });
  return b;
}

export function createMeilahtiMap(): MapData {
  return buildMeilahti().finalize();
}
