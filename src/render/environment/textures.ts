/**
 * [environment] Procedural textures, generated once on the CPU and cached for the session:
 *  - terrain layer array (one 256² RGBA layer per Terrain id: sRGB albedo + linear height in alpha)
 *  - a tileable multi-octave noise texture (macro variation, sparkle, foam break-up)
 *  - a tileable water normal map
 *  - the decal atlas (road paint, crossings, helipad H, teal medical cross, arrows, manholes, stains)
 */
import * as THREE from 'three';
import { Terrain } from '../../core/types';
import { Field, Rand, clamp01, fbm, hash01, lerp, perlin, smoothstep, worley, type WorleyResult } from './noise';

export const LAYER_SIZE = 256;
export const LAYER_COUNT = 10;
/** World units covered by one repeat of each terrain layer (index = Terrain id). */
export const LAYER_WORLD_SIZE: number[] = [8, 6, 8, 4, 8, 8, 8, 10, 8, 6];
/** Base roughness per layer (modulated by the height channel in the shader). */
export const LAYER_ROUGHNESS: number[] = [0.95, 0.82, 0.88, 0.72, 0.92, 0.55, 0.95, 0.62, 0.42, 0.8];
/** 1 = natural ground (organic, warped borders), 0 = man-made (crisp tile-aligned borders). */
export const LAYER_NATURAL: number[] = [1, 0, 0, 0, 1, 1, 1, 1, 1, 1];
export const isManMade = (t: number): boolean => t === Terrain.Asphalt || t === Terrain.Concrete || t === Terrain.Plaza;

type RGB = [number, number, number];
const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

/** Float RGB + height canvas with wrap-around drawing helpers. */
class Layer {
  readonly rgb: Float32Array;
  readonly h: Float32Array;
  constructor(readonly size: number) { this.rgb = new Float32Array(size * size * 3); this.h = new Float32Array(size * size); }
  set(x: number, y: number, r: number, g: number, b: number, height: number): void {
    const i = y * this.size + x;
    this.rgb[i * 3] = r; this.rgb[i * 3 + 1] = g; this.rgb[i * 3 + 2] = b; this.h[i] = height;
  }
  /** alpha-blend a pixel (wrapped); height blends toward `height` by the same alpha (or max if hMax) */
  blend(x: number, y: number, c: RGB, a: number, height: number, hMax = false): void {
    const s = this.size, m = s - 1;
    const i = ((y & m) * s) + (x & m);
    this.rgb[i * 3] = lerp(this.rgb[i * 3]!, c[0], a);
    this.rgb[i * 3 + 1] = lerp(this.rgb[i * 3 + 1]!, c[1], a);
    this.rgb[i * 3 + 2] = lerp(this.rgb[i * 3 + 2]!, c[2], a);
    this.h[i] = hMax ? Math.max(this.h[i]!, height * a + this.h[i]! * (1 - a)) : lerp(this.h[i]!, height, a);
  }
  /** anti-aliased-ish line (wrapped) */
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, a: number, height: number, width = 1): void {
    const len = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2), n = Math.max(1, Math.ceil(len * 1.5));
    for (let k = 0; k <= n; k++) {
      const t = k / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      if (width <= 1) this.blend(Math.round(x), Math.round(y), c, a, height);
      else this.disc(x, y, width * 0.5, c, a, height);
    }
  }
  disc(cx: number, cy: number, r: number, c: RGB, a: number, height: number, soft = 0.6): void {
    const r2 = r + 1;
    for (let y = Math.floor(cy - r2); y <= Math.ceil(cy + r2); y++) for (let x = Math.floor(cx - r2); x <= Math.ceil(cx + r2); x++) {
      const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      const k = 1 - smoothstep(r - soft, r + soft, d);
      if (k > 0.01) this.blend(x, y, c, a * k, height, true);
    }
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, ang: number, c: RGB, a: number, height: number): void {
    const R = Math.max(rx, ry) + 1, ca = Math.cos(ang), sa = Math.sin(ang);
    for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
      const dx = x - cx, dy = y - cy;
      const u = (dx * ca + dy * sa) / rx, v = (-dx * sa + dy * ca) / ry;
      const d = u * u + v * v;
      if (d < 1.3) this.blend(x, y, c, a * (1 - smoothstep(0.7, 1.3, d)), height, true);
    }
  }
  writeTo(out: Uint8Array, offset: number): void {
    const n = this.size * this.size;
    for (let i = 0; i < n; i++) {
      out[offset + i * 4] = clamp01(this.rgb[i * 3]!) * 255 + 0.5;
      out[offset + i * 4 + 1] = clamp01(this.rgb[i * 3 + 1]!) * 255 + 0.5;
      out[offset + i * 4 + 2] = clamp01(this.rgb[i * 3 + 2]!) * 255 + 0.5;
      out[offset + i * 4 + 3] = clamp01(this.h[i]!) * 255 + 0.5;
    }
  }
}

interface Fields { low: Field; low2: Field; mid: Field; mid2: Field; high: Field }
const mix3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mul3 = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const W: WorleyResult = { f1: 0, f2: 0, id: 0 };

function genGrass(L: Layer, F: Fields): void {
  const S = L.size, rnd = new Rand(11);
  const dark = hex(0x2f4220), base = hex(0x4c5e2c), dry = hex(0x7a7440), moss = hex(0x3d5a2a);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const lo = F.low.at(u, v) * 0.5 + 0.5, md = F.mid.at(u + 0.3, v + 0.7) * 0.5 + 0.5, hf = F.high.at(u, v);
    let c = mix3(dark, base, smoothstep(0.2, 0.8, lo * 0.7 + md * 0.3));
    c = mix3(c, dry, smoothstep(0.55, 0.85, F.low2.at(u, v) * 0.5 + 0.5) * 0.55);
    c = mix3(c, moss, smoothstep(0.6, 0.9, md) * 0.35);
    c = mul3(c, 0.88 + 0.24 * hf);
    L.set(x, y, c[0], c[1], c[2], 0.3 + 0.25 * lo + 0.1 * hf);
  }
  // blades: short strokes in mixed greens / straw
  const blades: RGB[] = [hex(0x5f7434), hex(0x26381a), hex(0x88834a), hex(0x6b8a3c), hex(0x3c5225)];
  const n = (S * S) / 4;
  for (let i = 0; i < n; i++) {
    const x = rnd.next() * S, y = rnd.next() * S, a = rnd.next() * Math.PI * 2, len = 2 + rnd.next() * 5;
    const c = rnd.pick(blades);
    L.line(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, c, 0.25 + rnd.next() * 0.35, 0.65 + rnd.next() * 0.35);
  }
  // fallen birch leaves (late autumn)
  const leaves: RGB[] = [hex(0xb08a3a), hex(0x9a6a34), hex(0x7a5a34), hex(0xb89a52)];
  for (let i = 0; i < 110; i++) {
    const x = rnd.next() * S, y = rnd.next() * S;
    if (F.low2.at(x / S, y / S) < 0.1) continue; // leaves gather in patches
    L.ellipse(x, y, 1.6 + rnd.next() * 1.4, 1 + rnd.next() * 0.8, rnd.next() * 3.14, rnd.pick(leaves), 0.6, 0.8);
  }
}

function genAsphalt(L: Layer, F: Fields): void {
  const S = L.size, rnd = new Rand(23);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const lo = F.low.at(u + 0.5, v) * 0.5 + 0.5, hf = F.high.at(u * 2, v * 2), w = hash01(x, y, 7), w2 = hash01(x >> 1, y >> 1, 9);
    let g = 0.24 + (lo - 0.5) * 0.05 + (hf - 0.5) * 0.04;
    let h = 0.45 + hf * 0.1;
    if (w2 > 0.9) { g += 0.1 + (w2 - 0.9) * 1.2; h += 0.35; }       // light aggregate
    else if (w > 0.95) { g += 0.07; h += 0.2; }
    else if (w < 0.06) { g -= 0.07; h -= 0.15; }                     // voids
    L.set(x, y, g * 1.04, g * 1.02, g * 0.97, h);
  }
  // repaired patches
  for (let p = 0; p < 2; p++) {
    const x0 = rnd.next() * S, y0 = rnd.next() * S, w = 50 + rnd.next() * 90, hh = 30 + rnd.next() * 60;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const e = Math.min(x, y, w - x, hh - y);
      L.blend(Math.floor(x0 + x), Math.floor(y0 + y), [0.13, 0.135, 0.145], 0.55 * smoothstep(0, 3, e), 0.5);
    }
  }
  // cracks (random walks)
  for (let c = 0; c < 7; c++) {
    let x = rnd.next() * S, y = rnd.next() * S, a = rnd.next() * Math.PI * 2;
    const steps = 20 + rnd.int(40);
    for (let s = 0; s < steps; s++) {
      const nx = x + Math.cos(a) * 3, ny = y + Math.sin(a) * 3;
      L.line(x, y, nx, ny, [0.07, 0.07, 0.075], 0.8, 0.05);
      x = nx; y = ny; a += (rnd.next() - 0.5) * 0.9;
    }
  }
}

function genConcrete(L: Layer, F: Fields): void {
  const S = L.size, slab = S / 4;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const sx = Math.floor(x / slab), sy = Math.floor(y / slab);
    const tone = hash01(sx, sy, 31) - 0.5;
    const ex = Math.min(x - sx * slab, (sx + 1) * slab - 1 - x), ey = Math.min(y - sy * slab, (sy + 1) * slab - 1 - y);
    const e = Math.min(ex, ey);
    const stain = smoothstep(0.1, 0.7, F.low.at(u + 0.2, v + 0.6) * 0.5 + 0.5) * 0.07;
    const hf = F.high.at(u * 2, v * 2) - 0.5, w = hash01(x, y, 3);
    let g = 0.6 + tone * 0.07 - stain + hf * 0.05;
    let h = 0.62 + hf * 0.12;
    if (w > 0.985) { g -= 0.12; h -= 0.25; }
    const joint = 1 - smoothstep(0.5, 2.2, e);
    const bevel = 1 - smoothstep(1.5, 6, e);
    g = g * (1 - bevel * 0.1) * (1 - joint * 0.55);
    h = lerp(h, 0.08, joint);
    L.set(x, y, g * 1.0, g * 0.985, g * 0.955, h);
  }
}

function genPlaza(L: Layer, F: Fields): void {
  // running-bond granite setts: 0.5 × 0.25 world units → 8 × 16 stones per 4-unit repeat
  const S = L.size, sw = S / 8, sh = S / 16;
  const stones: RGB[] = [hex(0x8f8e8b), hex(0x9a8f88), hex(0x797a7d), hex(0xa4a19a), hex(0x8a827c)];
  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / sh), off = (row & 1) * sw * 0.5;
    for (let x = 0; x < S; x++) {
      const xx = (x + off) % S, col = Math.floor(xx / sw);
      const id = hash01(col, row, 41);
      const base = stones[Math.floor(id * stones.length)]!;
      const ex = Math.min(xx - col * sw, (col + 1) * sw - 1 - xx), ey = Math.min(y - row * sh, (row + 1) * sh - 1 - y);
      const e = Math.min(ex, ey);
      const grain = hash01(x >> 1, y >> 1, 43) - 0.5, hf = F.high.at(x / S * 2, y / S * 2) - 0.5;
      const tone = 0.92 + hash01(col, row, 47) * 0.16;
      const grout = 1 - smoothstep(0.6, 2.0, e);
      const bevel = smoothstep(1.5, 5, e);
      let c = mul3(base, tone * (0.92 + grain * 0.12 + hf * 0.08) * (0.86 + 0.14 * bevel));
      c = mix3(c, hex(0x3b3833), grout);
      const lo = F.low.at(x / S, y / S) * 0.5 + 0.5;
      c = mul3(c, 0.94 + lo * 0.1);
      L.set(x, y, c[0], c[1], c[2], lerp(0.55 + 0.3 * bevel + grain * 0.06, 0.06, grout));
    }
  }
}

function genSand(L: Layer, F: Fields): void {
  const S = L.size;
  const a = hex(0xb7a47e), b = hex(0x9e8b68);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const lo = F.low.at(u, v + 0.4);
    const r = Math.sin((u * 19 + v * 7) * Math.PI * 2 + lo * 5);
    const w = hash01(x, y, 51) - 0.5;
    let c = mix3(a, b, clamp01(0.5 + lo * 0.6));
    c = mul3(c, 1 + r * 0.035 + w * 0.08);
    const sp = hash01(x, y, 53);
    if (sp > 0.996) c = hex(0xe4dccd); else if (sp < 0.004) c = hex(0x5d5546);
    L.set(x, y, c[0], c[1], c[2], 0.45 + r * 0.14 + w * 0.05);
  }
}

function genSeabed(L: Layer, F: Fields): void {
  const S = L.size;
  const mud = hex(0x4c4a38), dark = hex(0x2d3326), stone = hex(0x6a6860), algae = hex(0x33442a);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    let c = mix3(dark, mud, F.low.at(u + 0.1, v) * 0.5 + 0.5);
    c = mix3(c, algae, smoothstep(0.55, 0.85, F.mid.at(u, v + 0.2) * 0.5 + 0.5) * 0.6);
    worley(u * 22, v * 22, 22, 61, W);
    const st = 1 - smoothstep(0.28, 0.36, W.f1);
    const tone = 0.75 + (W.id % 1000) / 1000 * 0.5;
    c = mix3(c, mul3(stone, tone * (1.05 - W.f1)), st);
    L.set(x, y, c[0], c[1], c[2], 0.3 + st * (0.6 - W.f1));
  }
}

function genDirt(L: Layer, F: Fields): void {
  const S = L.size;
  const a = hex(0x5e4630), b = hex(0x3f3022), peb = hex(0x7c6e5e);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const lo = F.low.at(u + 0.7, v + 0.1) * 0.5 + 0.5, hf = F.high.at(u * 2, v * 2) - 0.5;
    let c = mix3(b, a, smoothstep(0.15, 0.85, lo));
    c = mul3(c, 0.92 + hf * 0.18);
    let h = 0.35 + lo * 0.2 + hf * 0.08;
    worley(u * 10, v * 10, 10, 71, W);
    const crack = 1 - smoothstep(0.0, 0.05, W.f2 - W.f1);
    c = mul3(c, 1 - crack * 0.3); h -= crack * 0.2;
    worley(u * 46, v * 46, 46, 73, W);
    const p = 1 - smoothstep(0.18, 0.27, W.f1);
    if (p > 0) {
      const t = 0.75 + ((W.id >>> 8) % 1000) / 1000 * 0.5;
      c = mix3(c, mul3(peb, t * (1.1 - W.f1 * 2)), p);
      h = lerp(h, 0.75 + (0.25 - W.f1), p);
    }
    L.set(x, y, c[0], c[1], c[2], h);
  }
}

function genSnow(L: Layer, F: Fields): void {
  const S = L.size;
  const shade = hex(0xb4c2d8), white = hex(0xf2f5fa);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const lo = F.low.at(u + 0.33, v + 0.9) * 0.5 + 0.5, md = F.mid.at(u, v) * 0.5 + 0.5;
    const t = clamp01(lo * 0.75 + md * 0.25);
    let c = mix3(shade, white, smoothstep(0.1, 0.75, t));
    const g = hash01(x, y, 81) - 0.5;
    c = mul3(c, 1 + g * 0.03);
    if (hash01(x >> 1, y >> 1, 83) > 0.9985) c = hex(0x8c8275);
    L.set(x, y, c[0], c[1], c[2], 0.35 + t * 0.4);
  }
}

function genContaminated(L: Layer, F: Fields): void {
  const S = L.size;
  const dark = hex(0x2a0f30), base = hex(0x4e1e57), vein = hex(0xd04fd0), pus = hex(0x9ed14a);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const lo = F.low.at(u + 0.15, v + 0.55) * 0.5 + 0.5;
    let c = mix3(dark, base, smoothstep(0.15, 0.85, lo));
    const md = F.mid2.at(u, v);
    c = mul3(c, 0.85 + 0.3 * (md * 0.5 + 0.5));
    // vein network: ridges of two noise octaves
    const r1 = Math.pow(1 - Math.abs(F.mid.at(u * 0.5 + 0.1, v * 0.5)), 10);
    const r2 = Math.pow(1 - Math.abs(F.low2.at(u * 2, v * 2 + 0.3)), 14);
    const veins = clamp01(Math.max(r1, r2 * 0.9));
    let h = 0.35 + lo * 0.3;
    const vm = smoothstep(0.35, 0.75, veins);
    c = mix3(c, vein, vm * 0.85);
    h = lerp(h, 0.02, vm);
    // pustules
    worley(u * 18, v * 18, 18, 91, W);
    const p = 1 - smoothstep(0.1, 0.16, W.f1);
    if (p > 0 && (W.id & 3) === 0) {
      c = mix3(c, mix3(pus, [0.9, 1, 0.7], 1 - W.f1 / 0.16), p * 0.9);
      h = lerp(h, 0.95, p);
    }
    L.set(x, y, c[0], c[1], c[2], h);
  }
}

function genRock(L: Layer, F: Fields): void {
  const S = L.size;
  const grey = hex(0x6d6a68), pink = hex(0x8c726a), lichen = hex(0x8f9a72);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const lo = F.low.at(u + 0.45, v + 0.25) * 0.5 + 0.5, md = F.mid.at(u + 0.6, v) * 0.5 + 0.5;
    let c = mix3(grey, pink, smoothstep(0.25, 0.8, lo));
    // crystal grains (2×2 px)
    const gr = hash01(x >> 1, y >> 1, 101);
    if (gr < 0.07) c = mul3(c, 0.35);
    else if (gr > 0.95) c = mix3(c, [0.82, 0.8, 0.78], 0.7);
    else if (gr > 0.86) c = mix3(c, hex(0xa47c70), 0.6);
    c = mul3(c, 0.9 + (md - 0.5) * 0.25);
    let h = 0.4 + lo * 0.3 + (md - 0.5) * 0.2;
    // fractures
    worley(u * 6, v * 6, 6, 103, W);
    const cr = 1 - smoothstep(0.0, 0.035, W.f2 - W.f1);
    c = mul3(c, 1 - cr * 0.55); h -= cr * 0.35;
    // facet shading per Worley cell
    c = mul3(c, 0.9 + ((W.id >>> 4) % 100) / 100 * 0.2);
    // lichen
    const li = smoothstep(0.62, 0.75, F.mid2.at(u, v + 0.5) * 0.5 + 0.5);
    c = mix3(c, lichen, li * 0.55);
    L.set(x, y, c[0], c[1], c[2], clamp01(h));
  }
}

let layerCache: Uint8Array | null = null;
/** RGBA bytes for all layers (LAYER_COUNT × LAYER_SIZE² × 4), generated once per session. */
export function terrainLayerData(): Uint8Array {
  if (layerCache) return layerCache;
  const S = LAYER_SIZE;
  const F: Fields = {
    low: new Field(128, (u, v) => fbm(u, v, 4, 4, 1)),
    low2: new Field(128, (u, v) => fbm(u, v, 3, 4, 2)),
    mid: new Field(256, (u, v) => fbm(u, v, 12, 3, 3)),
    mid2: new Field(256, (u, v) => fbm(u, v, 16, 3, 4)),
    high: new Field(256, (u, v) => perlin(u * 64, v * 64, 64, 5) * 0.5 + 0.5),
  };
  const out = new Uint8Array(LAYER_COUNT * S * S * 4);
  const gens: Record<number, (L: Layer, F: Fields) => void> = {
    [Terrain.Grass]: genGrass, [Terrain.Asphalt]: genAsphalt, [Terrain.Concrete]: genConcrete, [Terrain.Plaza]: genPlaza,
    [Terrain.Sand]: genSand, [Terrain.Water]: genSeabed, [Terrain.Dirt]: genDirt, [Terrain.Snow]: genSnow,
    [Terrain.Contaminated]: genContaminated, [Terrain.Rock]: genRock,
  };
  for (let i = 0; i < LAYER_COUNT; i++) {
    const L = new Layer(S);
    (gens[i] ?? genGrass)(L, F);
    L.writeTo(out, i * S * S * 4);
  }
  layerCache = out;
  return out;
}

export function createTerrainArrayTexture(maxAnisotropy: number): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(terrainLayerData(), LAYER_SIZE, LAYER_SIZE, LAYER_COUNT);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.min(8, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

let noiseCache: Uint8Array | null = null;
export const NOISE_SIZE = 256;
/** Tileable RGBA noise: R = low fBm, G = mid fBm, B = high fBm, A = white noise. Linear data. */
export function createNoiseTexture(): THREE.DataTexture {
  const S = NOISE_SIZE;
  if (!noiseCache) {
    const d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S, i = (y * S + x) * 4;
      d[i] = clamp01(fbm(u, v, 4, 4, 201) * 0.5 + 0.5) * 255;
      d[i + 1] = clamp01(fbm(u, v, 8, 3, 202) * 0.5 + 0.5) * 255;
      d[i + 2] = clamp01(fbm(u, v, 32, 2, 203) * 0.5 + 0.5) * 255;
      d[i + 3] = hash01(x, y, 204) * 255;
    }
    noiseCache = d;
  }
  const tex = new THREE.DataTexture(noiseCache, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

let waterCache: Uint8Array | null = null;
/** Tileable wave normal map (tangent space, z up in the blue channel). */
export function createWaterNormalTexture(): THREE.DataTexture {
  const S = 256;
  if (!waterCache) {
    const h = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      // a few elongated swells + choppy fBm
      const sw = Math.sin((u * 3 + v * 1) * Math.PI * 2 + perlin(u * 4, v * 4, 4, 301) * 1.5) * 0.35
        + Math.sin((u * -2 + v * 5) * Math.PI * 2 + perlin(u * 6, v * 6, 6, 302)) * 0.2;
      h[y * S + x] = sw + fbm(u, v, 8, 4, 303) * 0.8;
    }
    const d = new Uint8Array(S * S * 4);
    const k = 3.2;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const l = h[y * S + ((x - 1) & (S - 1))]!, r = h[y * S + ((x + 1) & (S - 1))]!;
      const t = h[((y - 1) & (S - 1)) * S + x]!, b = h[((y + 1) & (S - 1)) * S + x]!;
      let nx = (l - r) * k, ny = (t - b) * k, nz = 1;
      const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
      const i = (y * S + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
    waterCache = d;
  }
  const tex = new THREE.DataTexture(waterCache, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ───────────────────────────── decal atlas ─────────────────────────────

export const DECAL_CELL = 256;
export const DECAL_COLS = 4, DECAL_ROWS = 2;
/** Atlas cell index per decal kind. */
export const DECAL_CELLS = { road_line: 0, crosswalk: 1, parking_lines: 2, helipad_h: 3, medical_cross: 4, arrow: 5, manhole: 6, stain: 7 } as const;

/**
 * Draws the decal atlas with Canvas2D (crisp vector shapes), then wears the paint with noise.
 * Each cell has ≥ 10 px transparent margin so mip levels don't bleed between cells.
 */
let atlasCanvas: HTMLCanvasElement | null = null;
export function createDecalAtlas(maxAnisotropy: number): THREE.Texture {
  const tex = new THREE.CanvasTexture(atlasCanvas ??= drawDecalAtlas());
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(16, maxAnisotropy);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function drawDecalAtlas(): HTMLCanvasElement {
  const C = DECAL_CELL, cw = C * DECAL_COLS, ch = C * DECAL_ROWS;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  // CPU-backed canvas: getImageData on a GPU canvas forces a slow readback
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.clearRect(0, 0, cw, ch);
  const paint = '#eceee8';
  const cell = (i: number) => ({ x: (i % DECAL_COLS) * C, y: Math.floor(i / DECAL_COLS) * C });
  const M = 12; // margin

  // 0 road_line: one dash of a dashed centre line (cell u spans one dash period, v spans the stripe width)
  { const o = cell(0); g.fillStyle = paint; g.fillRect(o.x + M, o.y + M, C * 0.58, C - 2 * M); }
  // 1 crosswalk: one zebra stripe (u = one stripe period across the road, v = crossing width)
  { const o = cell(1); g.fillStyle = paint; g.fillRect(o.x + C * 0.12, o.y + M, C * 0.5, C - 2 * M); }
  // 2 parking_lines: one stall; half a line on each u edge so neighbouring stalls form full lines (v = depth)
  {
    const o = cell(2), lw = C * 0.05;
    g.fillStyle = paint;
    g.fillRect(o.x, o.y + M, lw, C - 2 * M);
    g.fillRect(o.x + C - lw, o.y + M, lw, C - 2 * M);
  }
  // 3 helipad: ring + bold H (legs along v)
  {
    const o = cell(3), cx = o.x + C / 2, cy = o.y + C / 2;
    g.strokeStyle = paint; g.lineWidth = C * 0.06;
    g.beginPath(); g.arc(cx, cy, C * 0.42, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#28c7b8'; g.lineWidth = C * 0.018;
    g.beginPath(); g.arc(cx, cy, C * 0.36, 0, Math.PI * 2); g.stroke();
    g.fillStyle = paint;
    const hw = C * 0.3, hh = C * 0.44, bar = C * 0.085;
    g.fillRect(cx - hw / 2, cy - hh / 2, bar, hh);
    g.fillRect(cx + hw / 2 - bar, cy - hh / 2, bar, hh);
    g.fillRect(cx - hw / 2, cy - bar / 2, hw, bar);
  }
  // 4 medical cross: white plus on a teal disc (never a red cross — protected emblem)
  {
    const o = cell(4), cx = o.x + C / 2, cy = o.y + C / 2;
    g.fillStyle = '#e9f3f1'; g.beginPath(); g.arc(cx, cy, C * 0.44, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#139e92'; g.beginPath(); g.arc(cx, cy, C * 0.4, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f4faf9';
    const a = C * 0.5, b = C * 0.17, r = C * 0.03;
    const rr = (x: number, y: number, w: number, h: number) => { g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); };
    rr(cx - b / 2, cy - a / 2, b, a); rr(cx - a / 2, cy - b / 2, a, b);
  }
  // 5 arrow pointing +u
  {
    const o = cell(5), cy = o.y + C / 2;
    g.fillStyle = paint; g.beginPath();
    g.moveTo(o.x + M, cy - C * 0.07); g.lineTo(o.x + C * 0.6, cy - C * 0.07); g.lineTo(o.x + C * 0.6, cy - C * 0.22);
    g.lineTo(o.x + C - M, cy); g.lineTo(o.x + C * 0.6, cy + C * 0.22); g.lineTo(o.x + C * 0.6, cy + C * 0.07);
    g.lineTo(o.x + M, cy + C * 0.07); g.closePath(); g.fill();
  }
  // 6 manhole: cast-iron cover
  {
    const o = cell(6), cx = o.x + C / 2, cy = o.y + C / 2;
    g.fillStyle = '#3a3b3d'; g.beginPath(); g.arc(cx, cy, C * 0.44, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#222325'; g.beginPath(); g.arc(cx, cy, C * 0.38, 0, Math.PI * 2); g.fill();
    g.save(); g.beginPath(); g.arc(cx, cy, C * 0.34, 0, Math.PI * 2); g.clip();
    g.strokeStyle = '#4a4b4e'; g.lineWidth = C * 0.022;
    for (let k = -8; k <= 8; k++) {
      const d = k * C * 0.05;
      g.beginPath(); g.moveTo(cx + d - C, cy - C); g.lineTo(cx + d + C, cy + C); g.stroke();
      g.beginPath(); g.moveTo(cx + d + C, cy - C); g.lineTo(cx + d - C, cy + C); g.stroke();
    }
    g.restore();
    g.strokeStyle = '#55524d'; g.lineWidth = C * 0.02; g.beginPath(); g.arc(cx, cy, C * 0.41, 0, Math.PI * 2); g.stroke();
  }
  // 7 stain: soft oily blotch
  {
    const o = cell(7), cx = o.x + C / 2, cy = o.y + C / 2, rnd = new Rand(707);
    for (let k = 0; k < 14; k++) {
      const a = rnd.next() * Math.PI * 2, d = rnd.next() * C * 0.18, r = C * (0.1 + rnd.next() * 0.16);
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(20,17,14,0.32)'); grd.addColorStop(1, 'rgba(20,17,14,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  }

  // wear: modulate paint alpha with noise (not the manhole/stain cells)
  const img = g.getImageData(0, 0, cw, ch), d = img.data;
  const wear = new Field(128, (u, v) => fbm(u, v, 8, 3, 909));
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const ci = Math.floor(x / C) + Math.floor(y / C) * DECAL_COLS;
    if (ci === 6 || ci === 7) continue;
    const i = (y * cw + x) * 4;
    if (d[i + 3] === 0) continue;
    const n = wear.at(x / cw * 4, y / ch * 2) * 0.5 + 0.5;
    const speck = hash01(x, y, 911);
    let k = 0.72 + 0.28 * smoothstep(0.25, 0.6, n);
    if (speck < 0.05) k *= 0.4;
    d[i + 3] = d[i + 3]! * k;
  }
  g.putImageData(img, 0, 0);
  return canvas;
}
