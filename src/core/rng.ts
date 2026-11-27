/** Deterministic seeded PRNG (mulberry32). Use world.rng in the sim — never Math.random() — so headless runs are reproducible. */
export class Rng {
  private s: number;
  constructor(seed = 1) { this.s = (seed >>> 0) || 0x9e3779b9; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  int(lo: number, hiInclusive: number): number { return lo + Math.floor(this.next() * (hiInclusive - lo + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]!; }
  chance(p: number): boolean { return this.next() < p; }
  fork(salt: number): Rng { return new Rng((Math.imul(this.s ^ salt, 2654435761) >>> 0) + 1); }
}

/** Stateless hash → [0,1) for visual variation (renderer, map decoration). */
export function hash01(n: number, salt = 0): number {
  let h = Math.imul((n | 0) ^ Math.imul(salt | 0, 0x27d4eb2d), 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
