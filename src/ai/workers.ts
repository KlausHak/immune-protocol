/**
 * [ai] Worker management: every free drone is kept mining (idle ones are re-assigned), drones are spread
 * ~evenly over the caches of all bases (≈2 per cache), caches with enemies on them are avoided, and
 * surplus drones drift to under-used caches/bases (e.g. a fresh expansion).
 */
import { dist } from '../core/math';
import type { Entity, EntityId } from '../core/types';
import type { Brain, Snapshot } from './brain';
import { hasWeapons, isWorkerUnit } from './util';

export class WorkerManager {
  private lastRebalance = -999;

  constructor(private b: Brain) {}

  saveState(): Record<string, unknown> { return { lastRebalance: this.lastRebalance }; }
  loadState(d: unknown): void { const v = (d as { lastRebalance?: number } | null)?.lastRebalance; if (typeof v === 'number') this.lastRebalance = v; }

  think(): void {
    const b = this.b;
    if (!b.flags.economy) return;
    b.refreshBases();
    const s = b.snap();
    const caches: Entity[] = [];
    for (const base of b.bases) if (base.complete) for (const c of base.caches) if (c.alive) caches.push(c);
    const idle: Entity[] = [];
    for (const w of s.workers) if (!b.roles.has(w.id) && w.orders.length === 0) idle.push(w);
    const load = new Map(b.cacheLoad());
    const unsafe = new Set<EntityId>();
    for (const c of caches) {
      if (b.enemiesNear(c.pos, 8, (e) => e.kind === 'unit' && hasWeapons(e) && !isWorkerUnit(e)).length) unsafe.add(c.id);
    }
    if (idle.length) {
      if (caches.length) this.assign(idle, caches, load, unsafe);
      else this.longDistance(idle);
    }
    if (caches.length > 1 && b.prof.workersPerCache >= 2 && b.world.time - this.lastRebalance >= 4) this.rebalance(s, caches, load, unsafe);
  }

  private assign(idle: Entity[], caches: Entity[], load: Map<EntityId, number>, unsafe: Set<EntityId>): void {
    const groups = new Map<EntityId, EntityId[]>();
    for (const w of idle) {
      let best: Entity | null = null, bs = Infinity;
      for (const c of caches) {
        const sc = (load.get(c.id) ?? 0) * 12 + dist(w.pos, c.pos) * 0.5 + (unsafe.has(c.id) ? 200 : 0);
        if (sc < bs) { bs = sc; best = c; }
      }
      if (!best) continue;
      load.set(best.id, (load.get(best.id) ?? 0) + 1);
      let g = groups.get(best.id);
      if (!g) { g = []; groups.set(best.id, g); }
      g.push(w.id);
    }
    for (const [cid, ids] of groups) if (!this.b.issue({ type: 'gather', playerId: this.b.me, unitIds: ids, targetId: cid })) break;
  }

  /** No cache at any base: mine the nearest node that isn't next to a known enemy structure. */
  private longDistance(idle: Entity[]): void {
    const b = this.b;
    const nodes = b.world.list.filter((e) => e.alive && e.kind === 'resource' && (e.resource?.amount ?? 0) > 0 && b.memory.structuresNear(e.pos, 12).length === 0);
    if (!nodes.length) return;
    const groups = new Map<EntityId, EntityId[]>();
    for (const w of idle) {
      let best = nodes[0]!, bd = Infinity;
      for (const n of nodes) { const d = dist(n.pos, w.pos); if (d < bd) { bd = d; best = n; } }
      let g = groups.get(best.id);
      if (!g) { g = []; groups.set(best.id, g); }
      g.push(w.id);
    }
    for (const [nid, ids] of groups) if (!b.issue({ type: 'gather', playerId: b.me, unitIds: ids, targetId: nid })) break;
  }

  /** Move one drone from the most to the least crowded cache when the gap is ≥ 2. */
  private rebalance(s: Snapshot, caches: Entity[], load: Map<EntityId, number>, unsafe: Set<EntityId>): void {
    const b = this.b;
    let over: Entity | null = null, overN = 2, under: Entity | null = null, underN = Infinity;
    for (const c of caches) {
      const n = load.get(c.id) ?? 0;
      if (n > overN) { overN = n; over = c; }
      if (!unsafe.has(c.id) && n < underN) { underN = n; under = c; }
    }
    if (!over || !under || overN - underN < 2) return;
    let pick: Entity | null = null, bd = Infinity;
    for (const w of s.workers) {
      if (b.roles.has(w.id) || b.gatherNode(w) !== over.id || (w.gatherer?.carrying ?? 0) > 0) continue;
      const d = dist(w.pos, under.pos);
      if (d < bd) { bd = d; pick = w; }
    }
    if (!pick) return;
    if (b.issue({ type: 'gather', playerId: b.me, unitIds: [pick.id], targetId: under.id })) this.lastRebalance = b.world.time;
  }
}
