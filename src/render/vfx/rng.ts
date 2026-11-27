/**
 * [vfx] Tiny deterministic PRNG (mulberry32) used for all visual variation. It never touches the
 * simulation RNG (world.rng), so effects can't desync the sim, and sandbox screenshots are repeatable.
 */
export class VfxRng {
  private s: number;
  constructor(seed = 0x2f6b3a1d) { this.s = seed >>> 0; }

  reseed(seed: number): void { this.s = seed >>> 0; }

  /** Uniform [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform [a, b). */
  range(a: number, b: number): number { return a + (b - a) * this.next(); }

  /** -1 or +1. */
  sign(): number { return this.next() < 0.5 ? -1 : 1; }

  /** Integer in [0, n). */
  int(n: number): number { return Math.floor(this.next() * n) % Math.max(1, n); }

  /** Stochastic rounding: 2.3 → 2 (70 %) or 3 (30 %). Keeps scaled emission counts unbiased. */
  round(v: number): number {
    const f = Math.floor(v);
    return f + (this.next() < v - f ? 1 : 0);
  }
}
