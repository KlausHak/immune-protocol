import type { MapData, TilePos, Vec2 } from './types';

export const tileIndex = (map: MapData, tx: number, ty: number): number => ty * map.width + tx;
export const inBounds = (map: MapData, tx: number, ty: number): boolean => tx >= 0 && ty >= 0 && tx < map.width && ty < map.height;
export const worldToTile = (p: Vec2): TilePos => ({ x: Math.floor(p.x), y: Math.floor(p.y) });
export const tileCenter = (t: TilePos): Vec2 => ({ x: t.x + 0.5, y: t.y + 0.5 });
/** World centre of a building footprint whose top-left tile is `t`. */
export const footprintCenter = (t: TilePos, w: number, h: number): Vec2 => ({ x: t.x + w / 2, y: t.y + h / 2 });
/** Top-left tile for a footprint centred (as closely as possible) on world point p. */
export const footprintTileAt = (p: Vec2, w: number, h: number): TilePos => ({ x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2) });

/** Bilinear terrain height at world (x, y) from MapData.heights ((w+1)*(h+1) vertex grid). */
export function sampleHeight(map: MapData, x: number, y: number): number {
  const W = map.width, H = map.height;
  const cx = Math.min(Math.max(x, 0), W), cy = Math.min(Math.max(y, 0), H);
  const x0 = Math.min(Math.floor(cx), W - 1), y0 = Math.min(Math.floor(cy), H - 1);
  const fx = cx - x0, fy = cy - y0;
  const stride = W + 1;
  const h00 = map.heights[y0 * stride + x0]!, h10 = map.heights[y0 * stride + x0 + 1]!;
  const h01 = map.heights[(y0 + 1) * stride + x0]!, h11 = map.heights[(y0 + 1) * stride + x0 + 1]!;
  return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
}

export function isTileBlocked(map: MapData, tx: number, ty: number): boolean {
  return !inBounds(map, tx, ty) || map.blocked[tileIndex(map, tx, ty)] === 1;
}

export function levelAt(map: MapData, p: Vec2): number {
  const t = worldToTile(p);
  if (!inBounds(map, t.x, t.y)) return 0;
  return map.levels[tileIndex(map, t.x, t.y)]!;
}
