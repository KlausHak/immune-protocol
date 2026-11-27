/**
 * [environment] Deterministic, tileable CPU noise used to generate the procedural terrain / decal /
 * water textures once at load time. Never used per frame. (Rendering may be non-deterministic, but
 * stable seeds keep screenshots comparable between runs.)
 */

/** Positive modulo. */
export const mod = (a: number, n: number): number => ((a % n) + n) % n;
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Integer hash → uint32. */
export function hashInt(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
/** Integer hash → [0, 1). */
export const hash01 = (x: number, y: number, seed: number): number => hashInt(x, y, seed) / 4294967296;

/** Small seeded PRNG (mulberry32). */
export class Rand {
  private s: number;
  constructor(seed: number) { this.s = (seed | 0) ^ 0x5bd1e995; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  int(n: number): number { return Math.floor(this.next() * n); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]!; }
}

const GRAD_N = 16;
const GX = new Float32Array(GRAD_N), GY = new Float32Array(GRAD_N);
for (let i = 0; i < GRAD_N; i++) { GX[i] = Math.cos((i / GRAD_N) * Math.PI * 2); GY[i] = Math.sin((i / GRAD_N) * Math.PI * 2); }

/** Periodic 2D gradient (Perlin) noise. x, y in lattice units; repeats every `period` cells. ≈[-1, 1]. */
export function perlin(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const x0 = mod(xi, period), y0 = mod(yi, period), x1 = mod(xi + 1, period), y1 = mod(yi + 1, period);
  const g00 = hashInt(x0, y0, seed) & 15, g10 = hashInt(x1, y0, seed) & 15;
  const g01 = hashInt(x0, y1, seed) & 15, g11 = hashInt(x1, y1, seed) & 15;
  const n00 = GX[g00]! * xf + GY[g00]! * yf;
  const n10 = GX[g10]! * (xf - 1) + GY[g10]! * yf;
  const n01 = GX[g01]! * xf + GY[g01]! * (yf - 1);
  const n11 = GX[g11]! * (xf - 1) + GY[g11]! * (yf - 1);
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = n00 + (n10 - n00) * u, b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.41;
}

/** Tileable fBm on the unit square: u, v ∈ [0, 1), base lattice `period`, doubling each octave. ≈[-1, 1]. */
export function fbm(u: number, v: number, period: number, octaves: number, seed: number, gain = 0.5): number {
  let sum = 0, amp = 1, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * perlin(u * p, v * p, p, seed + o * 131);
    norm += amp; amp *= gain; p *= 2;
  }
  return sum / norm;
}

export interface WorleyResult { f1: number; f2: number; id: number }
/** Periodic Worley (cellular) noise. x, y in cell units; one jittered feature point per cell. */
export function worley(x: number, y: number, period: number, seed: number, out: WorleyResult, jitter = 0.9): WorleyResult {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = xi + dx, cy = yi + dy;
    const wx = mod(cx, period), wy = mod(cy, period);
    const h = hashInt(wx, wy, seed);
    const px = cx + 0.5 + ((h & 0xffff) / 65535 - 0.5) * jitter;
    const py = cy + 0.5 + ((h >>> 16) / 65535 - 0.5) * jitter;
    const d = Math.sqrt((px - x) * (px - x) + (py - y) * (py - y));
    if (d < f1) { f2 = f1; f1 = d; id = h; } else if (d < f2) f2 = d;
  }
  out.f1 = f1; out.f2 = f2; out.id = id;
  return out;
}

/**
 * A square, tileable scalar field (power-of-two size) with wrapped bilinear lookup, used as a cheap
 * pre-computed noise source when generating many texture layers.
 */
export class Field {
  readonly data: Float32Array;
  constructor(readonly size: number, fn: (u: number, v: number) => number) {
    this.data = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) this.data[y * size + x] = fn(x / size, y / size);
  }
  /** Wrapped bilinear sample in unit coordinates (u, v may be any real number; field tiles). */
  at(u: number, v: number): number {
    const s = this.size;
    const x = u * s - 0.5, y = v * s - 0.5;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const m = s - 1;
    const x0 = xi & m, y0 = yi & m, x1 = (xi + 1) & m, y1 = (yi + 1) & m;
    const d = this.data;
    const a = d[y0 * s + x0]!, b = d[y0 * s + x1]!, c = d[y1 * s + x0]!, e = d[y1 * s + x1]!;
    return (a + (b - a) * fx) * (1 - fy) + (c + (e - c) * fx) * fy;
  }
}
