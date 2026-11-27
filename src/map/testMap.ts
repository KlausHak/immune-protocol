import { Terrain, type MapData, type Vec2 } from '../core/types';

/**
 * Small flat test map used by unit tests and as a fallback. KEEP the signature, size (96x96),
 * slot ids/positions and resource layout stable — many tests depend on it.
 *   slot 1 (hospital) start (20, 76) · slot 2 (pathogen) start (76, 20) · 6 caches per base · 4 in the centre.
 */
export function createTestMap(): MapData {
  const W = 96, H = 96, N = W * H;
  const terrain = new Uint8Array(N).fill(Terrain.Grass);
  const levels = new Uint8Array(N);
  const ramps = new Uint8Array(N);
  const blocked = new Uint8Array(N);
  const buildable = new Uint8Array(N).fill(1);
  const heights = new Float32Array((W + 1) * (H + 1));
  const idx = (x: number, y: number) => y * W + x;

  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { blocked[idx(x, y)] = 1; buildable[idx(x, y)] = 0; }
  }
  // pond west of centre
  for (let y = 40; y < 56; y++) for (let x = 14; x < 30; x++) {
    if ((x - 22) ** 2 + (y - 48) ** 2 <= 49) { terrain[idx(x, y)] = Terrain.Water; blocked[idx(x, y)] = 1; buildable[idx(x, y)] = 0; }
  }
  // a road through the middle (diagonal band)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (Math.abs(x + y - 96) <= 2 && !blocked[idx(x, y)]) terrain[idx(x, y)] = Terrain.Asphalt;
  }
  // granite outcrops east of centre
  for (const [cx, cy] of [[64, 52], [58, 60]] as const) for (let y = cy - 2; y <= cy + 1; y++) for (let x = cx - 2; x <= cx + 1; x++) {
    terrain[idx(x, y)] = Terrain.Rock; blocked[idx(x, y)] = 1; buildable[idx(x, y)] = 0;
  }
  for (let vy = 0; vy <= H; vy++) for (let vx = 0; vx <= W; vx++) {
    const tx = Math.min(W - 1, vx), ty = Math.min(H - 1, vy);
    heights[vy * (W + 1) + vx] = terrain[idx(tx, ty)] === Terrain.Water ? -0.6 : 0;
  }

  const p1: Vec2 = { x: 20, y: 76 }, p2: Vec2 = { x: 76, y: 20 };
  const resources: MapData['resources'] = [];
  const arc = (s: Vec2, baseAngle: number) => {
    for (let i = 0; i < 6; i++) {
      const a = baseAngle + (i - 2.5) * 0.36;
      resources.push({ pos: { x: Math.round(s.x + Math.cos(a) * 8), y: Math.round(s.y + Math.sin(a) * 8) }, amount: 1500 });
    }
  };
  arc(p1, Math.atan2(1, -1));   // toward the SW corner (away from centre)
  arc(p2, Math.atan2(-1, 1));   // toward the NE corner
  for (const [x, y] of [[44, 44], [52, 44], [44, 52], [52, 52]] as const) resources.push({ pos: { x, y }, amount: 1000 });

  return {
    id: 'test', name: 'Test Grounds', description: 'Flat 96×96 proving ground used by automated tests.',
    width: W, height: H, terrain, levels, ramps, blocked, buildable, heights,
    doodads: [], decals: [], resources,
    slots: [{ id: 1, faction: 'hospital', start: p1 }, { id: 2, faction: 'pathogen', start: p2 }],
    regions: {
      player_base: { x: 8, y: 64, w: 24, h: 24 },
      enemy_base: { x: 64, y: 8, w: 24, h: 24 },
      center: { x: 40, y: 40, w: 16, h: 16 },
    },
    points: { player_start: p1, enemy_start: p2, center: { x: 48, y: 48 } },
    lighting: 'day', waterLevel: -0.3,
  };
}
