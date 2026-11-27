/**
 * [input] Control groups (Ctrl+# assign, Shift+# add, # recall, double-tap # → centre camera).
 * Pure & headless-safe: time is passed in (seconds), entities are resolved through the world.
 */
import type { Entity, EntityId, PlayerId, Vec2 } from '../core/types';
import type { World } from '../sim/World';

/** Max seconds between two presses of the same group key to count as a double-tap. */
export const DOUBLE_TAP_SECONDS = 0.35;

export class ControlGroups {
  private groups = new Map<number, EntityId[]>();
  private lastRecall: { index: number; time: number } = { index: -1, time: -Infinity };

  constructor(private readonly world: World, private readonly playerId: PlayerId) {}

  /** Replace group `index` with the owned entities among `ids`. Ignored when none are owned. */
  assign(index: number, ids: readonly EntityId[]): boolean {
    const own = this.ownAlive(ids);
    if (own.length === 0) return false;
    this.groups.set(index, own);
    return true;
  }

  /** Append owned entities to group `index` (creating it if needed). */
  add(index: number, ids: readonly EntityId[]): boolean {
    const own = this.ownAlive(ids);
    if (own.length === 0) return false;
    const cur = this.get(index);
    this.groups.set(index, [...new Set([...cur, ...own])]);
    return true;
  }

  /** Alive, still-owned members of a group (prunes the stored list as a side effect). */
  get(index: number): EntityId[] {
    const ids = this.groups.get(index);
    if (!ids) return [];
    const alive = this.ownAlive(ids);
    if (alive.length !== ids.length) {
      if (alive.length) this.groups.set(index, alive); else this.groups.delete(index);
    }
    return alive;
  }

  entities(index: number): Entity[] {
    return this.get(index).map((id) => this.world.getAlive(id)).filter((e): e is Entity => !!e);
  }

  /**
   * Register a recall press. Returns true when it is the second press of a double-tap (same group within
   * DOUBLE_TAP_SECONDS); a double-tap consumes the press so a third tap starts over.
   */
  recall(index: number, now: number): boolean {
    const dbl = this.lastRecall.index === index && now - this.lastRecall.time <= DOUBLE_TAP_SECONDS;
    this.lastRecall = dbl ? { index: -1, time: -Infinity } : { index, time: now };
    return dbl;
  }

  /** Average position of the group's alive members (null if empty). */
  centroid(index: number): Vec2 | null {
    const es = this.entities(index);
    if (es.length === 0) return null;
    let x = 0, y = 0;
    for (const e of es) { x += e.pos.x; y += e.pos.y; }
    return { x: x / es.length, y: y / es.length };
  }

  /** Non-empty groups (for a HUD strip): index, member count and the most common defId. */
  summary(): Array<{ index: number; count: number; defId: string | null }> {
    const out: Array<{ index: number; count: number; defId: string | null }> = [];
    for (const index of [...this.groups.keys()].sort((a, b) => a - b)) {
      const es = this.entities(index);
      if (es.length === 0) continue;
      const counts = new Map<string, number>();
      for (const e of es) counts.set(e.defId, (counts.get(e.defId) ?? 0) + 1);
      let defId: string | null = null, best = 0;
      for (const [d, n] of counts) if (n > best) { best = n; defId = d; }
      out.push({ index, count: es.length, defId });
    }
    return out;
  }

  clear(): void { this.groups.clear(); }

  private ownAlive(ids: readonly EntityId[]): EntityId[] {
    const out: EntityId[] = [];
    for (const id of ids) {
      const e = this.world.getAlive(id);
      if (e && e.owner === this.playerId && !out.includes(id)) out.push(id);
    }
    return out;
  }
}
