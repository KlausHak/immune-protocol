/**
 * [ui] Stylised top-down terrain rendering for the minimap and the skirmish map previews (2D canvas,
 * one ImageData pass — no three.js). Palette is intentionally muted so unit dots and fog read on top.
 */
import { Terrain, type MapData } from '../core/types';

type RGB = [number, number, number];

const TERRAIN_RGB: Record<number, RGB> = {
  [Terrain.Grass]: [44, 72, 58],
  [Terrain.Asphalt]: [40, 46, 54],
  [Terrain.Concrete]: [76, 84, 92],
  [Terrain.Plaza]: [92, 96, 102],
  [Terrain.Sand]: [128, 114, 84],
  [Terrain.Water]: [12, 40, 68],
  [Terrain.Dirt]: [76, 62, 48],
  [Terrain.Snow]: [178, 192, 202],
  [Terrain.Contaminated]: [82, 40, 88],
  [Terrain.Rock]: [96, 98, 104],
};
const STRUCTURE: RGB = [104, 116, 130];
const EDGE: RGB = [8, 12, 16];

/** Deterministic per-tile hash noise in [-1, 1]. */
function noise(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) & 0xffff) / 0xffff) * 2 - 1;
}

export interface MapLayout {
  /** pixels per world unit */
  scale: number;
  ox: number;
  oy: number;
  size: number;
}

/** Fit a map (letterboxed) into a size×size pixel square. */
export function layoutFor(map: Pick<MapData, 'width' | 'height'>, size: number): MapLayout {
  const scale = size / Math.max(map.width, map.height);
  return { scale, ox: (size - map.width * scale) / 2, oy: (size - map.height * scale) / 2, size };
}

/** Render terrain (levels, cliffs, ramps, water, campus structures) into a new size×size canvas. */
export function renderTerrain(map: MapData, size: number): { canvas: HTMLCanvasElement; layout: MapLayout } {
  const S = Math.max(16, Math.round(size));
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const layout = layoutFor(map, S);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const W = map.width, H = map.height;
  // Per-tile colour first (cheap), then sample it per pixel.
  const tileRgb = new Uint8ClampedArray(W * H * 3);
  for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
    const i = ty * W + tx;
    const t = map.terrain[i]!;
    const lvl = map.levels[i] ?? 0;
    let c: RGB = TERRAIN_RGB[t] ?? TERRAIN_RGB[Terrain.Grass]!;
    const border = tx === 0 || ty === 0 || tx === W - 1 || ty === H - 1;
    if (map.blocked[i] && t !== Terrain.Water && t !== Terrain.Rock && !border) c = STRUCTURE;
    let k = 1 + lvl * 0.14;
    if (map.ramps[i]) k += 0.08;
    // cliff shading: darker at the foot of a higher neighbour, a bright rim on the high side
    if (!map.ramps[i]) {
      let higher = false, lower = false;
      for (const [nx, ny] of [[tx - 1, ty], [tx + 1, ty], [tx, ty - 1], [tx, ty + 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nl = map.levels[ny * W + nx] ?? 0;
        if (nl > lvl) higher = true; else if (nl < lvl) lower = true;
      }
      if (higher) k *= 0.55;
      else if (lower) k *= 1.22;
    }
    const n = noise(tx, ty) * (t === Terrain.Water ? 3 : 5);
    const o = i * 3;
    tileRgb[o] = c[0] * k + n; tileRgb[o + 1] = c[1] * k + n; tileRgb[o + 2] = c[2] * k + n;
    if (map.blocked[i] && c === STRUCTURE) {
      // structure outlines: darken tiles that touch non-blocked ground
      let edge = false;
      for (const [nx, ny] of [[tx - 1, ty], [tx + 1, ty], [tx, ty - 1], [tx, ty + 1]] as const) {
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && !map.blocked[ny * W + nx]) edge = true;
      }
      if (edge) { tileRgb[o] = c[0] * 1.25; tileRgb[o + 1] = c[1] * 1.25; tileRgb[o + 2] = c[2] * 1.25; }
    }
  }
  for (let py = 0; py < S; py++) {
    const wy = (py + 0.5 - layout.oy) / layout.scale;
    const ty = Math.floor(wy);
    for (let px = 0; px < S; px++) {
      const o = (py * S + px) * 4;
      const wx = (px + 0.5 - layout.ox) / layout.scale;
      const tx = Math.floor(wx);
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) { d[o] = EDGE[0]; d[o + 1] = EDGE[1]; d[o + 2] = EDGE[2]; d[o + 3] = 255; continue; }
      const s = (ty * W + tx) * 3;
      d[o] = tileRgb[s]!; d[o + 1] = tileRgb[s + 1]!; d[o + 2] = tileRgb[s + 2]!; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // soft vignette for depth
  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return { canvas, layout };
}

/** Cached small preview canvas for menus (start positions marked). */
const previewCache = new Map<string, HTMLCanvasElement>();
export function mapPreview(map: MapData, size: number, key = map.id): HTMLCanvasElement {
  const ck = `${key}@${size}`;
  const hit = previewCache.get(ck);
  if (hit) return hit;
  const { canvas, layout } = renderTerrain(map, size);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(255, 201, 77, 0.9)';
  for (const r of map.resources) {
    const x = layout.ox + r.pos.x * layout.scale, y = layout.oy + r.pos.y * layout.scale;
    ctx.fillRect(x - layout.scale, y - layout.scale, layout.scale * 2, layout.scale * 2);
  }
  for (const s of map.slots) {
    const x = layout.ox + s.start.x * layout.scale, y = layout.oy + s.start.y * layout.scale;
    const col = s.faction === 'pathogen' ? '#d64bff' : '#2fd6c6';
    ctx.beginPath(); ctx.arc(x, y, Math.max(3, size * 0.035), 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = Math.max(1, size * 0.008); ctx.strokeStyle = '#ffffff'; ctx.stroke();
  }
  previewCache.set(ck, canvas);
  return canvas;
}
