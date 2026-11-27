/**
 * [movement] Binary min-heap of grid node indices keyed by float priority (typed arrays, lazy deletion:
 * callers push duplicates on decrease-key and skip already-closed nodes when popping).
 */
export class NodeHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  clear(): void { this.size = 0; }

  peekKey(): number { return this.size > 0 ? this.keys[0]! : Infinity; }

  push(v: number, k: number): void {
    if (this.size === this.keys.length) this.grow();
    const keys = this.keys, vals = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pk = keys[p]!;
      if (pk <= k) break;
      keys[i] = pk; vals[i] = vals[p]!;
      i = p;
    }
    keys[i] = k; vals[i] = v;
  }

  pop(): number {
    const keys = this.keys, vals = this.vals;
    const top = vals[0]!;
    const n = --this.size;
    if (n > 0) {
      const k = keys[n]!, v = vals[n]!;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1]! < keys[c]!) c++;
        if (keys[c]! >= k) break;
        keys[i] = keys[c]!; vals[i] = vals[c]!;
        i = c;
      }
      keys[i] = k; vals[i] = v;
    }
    return top;
  }

  private grow(): void {
    const k = new Float64Array(this.keys.length * 2); k.set(this.keys); this.keys = k;
    const v = new Int32Array(this.vals.length * 2); v.set(this.vals); this.vals = v;
  }
}
