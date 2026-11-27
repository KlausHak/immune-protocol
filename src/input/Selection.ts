/**
 * [input] The local player's selection. Implements the SelectionApi contract used by the HUD.
 *
 * Invariants (enforced on every change):
 *  - ids are unique, refer to alive entities, and are ordered by subgroup priority (see subgroups.ts);
 *  - either every entity is owned by the local player, or the selection is a single non-owned entity
 *    (inspecting an enemy / neutral cache).
 * The active subgroup (defId) is kept across add/remove/prune when still present; set() resets it.
 *
 * Headless-safe: no DOM / three.js. The renderer is reached through the injected `sink`.
 */
import type { Entity, EntityId, PlayerId } from '../core/types';
import type { SelectionApi } from '../game/contracts';
import type { World } from '../sim/World';
import { orderSubgroups, sortBySubgroup, type Subgroup } from './subgroups';

export interface SelectionSink {
  /** Mirror the selection into the renderer (selection rings). */
  setSelection(ids: readonly EntityId[]): void;
}

export type SelectionChangeReason = 'user' | 'prune' | 'subgroup';

export class Selection implements SelectionApi {
  private _ids: EntityId[] = [];
  private active: string | null = null;
  private listeners = new Set<(ids: readonly EntityId[]) => void>();
  private reasonListeners = new Set<(reason: SelectionChangeReason) => void>();
  /** Increments on every change (ids or active subgroup) — cheap cache key for derived UI. */
  version = 0;

  constructor(private readonly world: World, private readonly playerId: PlayerId, private readonly sink: SelectionSink | null = null) {}

  get ids(): readonly EntityId[] { return this._ids; }

  set(ids: EntityId[]): void { this.apply(ids, null, 'user'); }
  /** Adds keep the currently shown subgroup active (a higher-priority type joining doesn't steal the card). */
  add(ids: EntityId[]): void { this.apply([...this._ids, ...ids], this.activeSubgroup(), 'user'); }
  remove(ids: EntityId[]): void {
    const r = new Set(ids);
    this.apply(this._ids.filter((i) => !r.has(i)), this.activeSubgroup(), 'user');
  }
  /** Shift-click behaviour: remove the ids if they are all selected, otherwise add them. */
  toggle(ids: EntityId[]): void {
    const cur = new Set(this._ids);
    if (ids.length > 0 && ids.every((i) => cur.has(i))) this.remove(ids); else this.add(ids);
  }
  clear(): void { this.apply([], null, 'user'); }
  has(id: EntityId): boolean { return this._ids.includes(id); }

  /** Alive entities in selection order (live lookup — never stale). */
  entities(): Entity[] {
    const out: Entity[] = [];
    for (const id of this._ids) { const e = this.world.getAlive(id); if (e) out.push(e); }
    return out;
  }
  /** Selected entities owned by the local player. */
  owned(): Entity[] { return this.entities().filter((e) => e.owner === this.playerId); }
  /** True when the selection is (non-empty and) owned by the local player. */
  isOwn(): boolean { const f = this.world.getAlive(this._ids[0]); return !!f && f.owner === this.playerId; }

  subgroups(): Subgroup[] { return orderSubgroups(this.entities()); }
  /** defId of the active subgroup (null when empty): the Tab choice if still present, else the top one. */
  activeSubgroup(): string | null {
    const groups = this.subgroups();
    if (groups.length === 0) return null;
    return groups.some((g) => g.defId === this.active) ? this.active : groups[0]!.defId;
  }
  /** Entities of the active subgroup. */
  activeEntities(): Entity[] {
    const a = this.activeSubgroup();
    return a ? this.entities().filter((e) => e.defId === a) : [];
  }
  /** First entity of the active subgroup (info panel / command card owner). */
  primary(): Entity | undefined {
    const a = this.activeSubgroup();
    return a ? this.entities().find((e) => e.defId === a) : undefined;
  }
  setActiveSubgroup(defId: string | null): void {
    if (defId === this.active) return;
    if (defId !== null && !this.subgroups().some((g) => g.defId === defId)) return;
    this.active = defId;
    this.emit('subgroup');
  }
  /** Tab / Shift+Tab: advance the active subgroup. Returns true if it changed. */
  cycleSubgroup(dir: 1 | -1 = 1): boolean {
    const groups = this.subgroups();
    if (groups.length < 2) return false;
    const cur = Math.max(0, groups.findIndex((g) => g.defId === this.activeSubgroup()));
    this.active = groups[(cur + dir + groups.length) % groups.length]!.defId;
    this.emit('subgroup');
    return true;
  }

  /**
   * Drop dead/removed entities and non-owned entities the local player can no longer see.
   * Returns true if the selection changed.
   */
  prune(isVisible: (e: Entity) => boolean): boolean {
    let changed = false;
    const keep: EntityId[] = [];
    for (const id of this._ids) {
      const e = this.world.getAlive(id);
      if (!e || (e.owner !== this.playerId && !safeVisible(isVisible, e))) { changed = true; continue; }
      keep.push(id);
    }
    if (changed) this.apply(keep, this.active, 'prune');
    return changed;
  }

  onChange(fn: (ids: readonly EntityId[]) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  /** Like onChange, but tells the listener why the selection changed (Controls resets modes on 'user'). */
  onChangeReason(fn: (reason: SelectionChangeReason) => void): () => void {
    this.reasonListeners.add(fn);
    return () => { this.reasonListeners.delete(fn); };
  }
  dispose(): void { this.listeners.clear(); this.reasonListeners.clear(); }

  // ───────────────────────── internals ─────────────────────────
  private apply(ids: EntityId[], keepActive: string | null, reason: SelectionChangeReason): void {
    const seen = new Set<EntityId>();
    let ents: Entity[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = this.world.getAlive(id);
      if (e) ents.push(e);
    }
    const own = ents.filter((e) => e.owner === this.playerId);
    ents = own.length > 0 ? own : ents.slice(0, 1);
    const next = sortBySubgroup(ents).map((e) => e.id);
    const nextActive = keepActive !== null && ents.some((e) => e.defId === keepActive) ? keepActive : null;
    const same = next.length === this._ids.length && next.every((id, i) => id === this._ids[i]);
    if (same && nextActive === this.active) return;
    this._ids = next;
    this.active = nextActive;
    this.emit(reason);
  }

  private emit(reason: SelectionChangeReason): void {
    this.version++;
    try { this.sink?.setSelection(this._ids); } catch (err) { console.error('[input] renderer.setSelection threw', err); }
    for (const fn of [...this.listeners]) {
      try { fn(this._ids); } catch (err) { console.error('[input] selection listener threw', err); }
    }
    for (const fn of [...this.reasonListeners]) {
      try { fn(reason); } catch (err) { console.error('[input] selection listener threw', err); }
    }
  }
}

function safeVisible(isVisible: (e: Entity) => boolean, e: Entity): boolean {
  try { return isVisible(e); } catch { return true; }
}
