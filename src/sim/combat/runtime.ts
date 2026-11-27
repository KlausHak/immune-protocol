/**
 * [combat] Per-world runtime: the installed service instances plus module state that is not per-entity
 * (projectile metadata, delayed ability effects, ally help calls, scratch buffers).
 */
import type { Entity, EntityId, PlayerId } from '../../core/types';
import { NEUTRAL_PLAYER } from '../../core/types';
import type { World } from '../World';
import { AbilityServiceImpl } from './abilities';
import { HELP_CELL, HELP_WINDOW } from './constants';
import { CombatServiceImpl } from './service';
import { helpKey } from './state';
import { getDef } from '../../data';

export interface CombatSave {
  proj: Array<{ id: number; sourceId: EntityId; ghost: Record<string, unknown> | null; damageAdd: number; damageMul: number; traveled: number; launchedAt: number }>;
  delayed: DelayedEffect[];
  helpCalls: Array<[number, HelpCall]>;
}

/** Entity fields minus def/tags (same shape the core save uses). */
function ghostFields(e: Entity): Record<string, unknown> {
  const { def: _d, tags: _t, ...rest } = e as unknown as Record<string, unknown>;
  return rest;
}
/** A detached (dead, unregistered) entity used only as damage credit for in-flight shots. */
function rebuildGhost(f: Record<string, unknown>): Entity {
  const def = getDef(f.defId as string);
  return { ...f, def, tags: new Set(def.kind === 'resource' ? [] : def.tags) } as unknown as Entity;
}

/** Launch-time snapshot of a projectile's source (it may die before impact). */
export interface ProjectileMeta {
  source: Entity;
  damageAdd: number;
  damageMul: number;
  /** homing shots: distance flown so far (for the 0..1 travel fraction) */
  traveled: number;
  /** world.time at launch (shots older than MAX_FLIGHT fizzle) */
  launchedAt: number;
}

/** Delayed ability effect — plain data so it survives save/load. */
export interface DelayedEffect { at: number; kind: 'supplyDrop'; casterId: EntityId; owner: number; amount: number }

const PRESENCE_CELL = 8;
/** building half-extent (≤ 3 for the 6×6 objective) + a tick of movement */
const PRESENCE_SLACK = 3.5;

/** "A friend of player P was hit at cell C by attacker A at time T" — idle allies nearby respond. */
export interface HelpCall { attackerId: EntityId; time: number }

export class CombatRuntime {
  readonly service: CombatServiceImpl;
  readonly abilities: AbilityServiceImpl;
  readonly projMeta = new Map<number, ProjectileMeta>();
  readonly delayed: DelayedEffect[] = [];
  readonly helpCalls = new Map<number, HelpCall>();
  /** reusable buffer for acquisition scans (never used re-entrantly: scans don't deal damage) */
  readonly scratch: Entity[] = [];
  readonly unsubs: Array<() => void> = [];
  /** unit def ids that own a ticking passive ability (e.g. omega_spawn) */
  readonly tickPassiveDefs = new Set<string>();

  // ── coarse enemy-presence grid (rebuilt lazily once per tick): lets scans skip spatial queries when
  //    no enemy is anywhere near (travelling armies, quiet bases) ──
  private presTick = -1;
  private readonly presCols: number;
  private readonly presRows: number;
  private presTotal: Uint16Array;
  private readonly presTeam = new Map<number, Uint16Array>();

  constructor(readonly world: World) {
    this.service = new CombatServiceImpl(this);
    this.abilities = new AbilityServiceImpl(this);
    this.presCols = Math.ceil(world.map.width / PRESENCE_CELL) + 1;
    this.presRows = Math.ceil(world.map.height / PRESENCE_CELL) + 1;
    this.presTotal = new Uint16Array(this.presCols * this.presRows);
  }

  private presCell(x: number, y: number): number {
    const cx = Math.min(this.presCols - 1, Math.max(0, Math.floor(x / PRESENCE_CELL)));
    const cy = Math.min(this.presRows - 1, Math.max(0, Math.floor(y / PRESENCE_CELL)));
    return cy * this.presCols + cx;
  }

  private buildPresence(): void {
    const w = this.world;
    this.presTick = w.tick;
    this.presTotal.fill(0);
    for (const arr of this.presTeam.values()) arr.fill(0);
    for (const e of w.list) {
      if (!e.alive || e.owner === NEUTRAL_PLAYER || e.kind === 'resource') continue;
      const team = w.players.get(e.owner)?.team ?? -1;
      let arr = this.presTeam.get(team);
      if (!arr) { arr = new Uint16Array(this.presTotal.length); this.presTeam.set(team, arr); }
      const c = this.presCell(e.pos.x, e.pos.y);
      if (this.presTotal[c]! < 65535) { this.presTotal[c]!++; arr[c]!++; }
    }
  }

  /**
   * Conservative test: could an enemy of `owner` be within `r` of `p`? (false = certainly none).
   * Includes slack for building half-extents and one tick of movement since the grid was built.
   */
  enemiesMaybeNear(owner: PlayerId, p: { x: number; y: number }, r: number): boolean {
    if (this.presTick !== this.world.tick) this.buildPresence();
    const team = this.world.players.get(owner)?.team ?? -1;
    const mine = this.presTeam.get(team);
    const m = r + PRESENCE_SLACK;
    const c0 = this.presCell(p.x - m, p.y - m), c1 = this.presCell(p.x + m, p.y + m);
    const x0 = c0 % this.presCols, y0 = (c0 / this.presCols) | 0, x1 = c1 % this.presCols, y1 = (c1 / this.presCols) | 0;
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const c = cy * this.presCols + cx;
      if (this.presTotal[c]! - (mine ? mine[c]! : 0) > 0) return true;
    }
    return false;
  }

  /** True while this runtime's services are the ones installed on the world. */
  get active(): boolean { return this.world.combat === this.service; }

  noteHelpCall(target: Entity, source: Entity): void {
    if (target.owner === NEUTRAL_PLAYER || source.owner === target.owner || target.kind === 'resource') return;
    const k = helpKey(target.owner, Math.floor(target.pos.x / HELP_CELL), Math.floor(target.pos.y / HELP_CELL));
    const h = this.helpCalls.get(k);
    if (h) { h.attackerId = source.id; h.time = this.world.time; } else this.helpCalls.set(k, { attackerId: source.id, time: this.world.time });
  }

  pruneHelpCalls(): void {
    const now = this.world.time;
    for (const [k, h] of this.helpCalls) if (now - h.time > HELP_WINDOW) this.helpCalls.delete(k);
  }

  schedule(delay: number, fx: Omit<DelayedEffect, 'at'>): void { this.delayed.push({ at: this.world.time + delay, ...fx }); }

  private runEffect(d: DelayedEffect): void {
    if (d.kind === 'supplyDrop') {
      const caster = this.world.getAlive(d.casterId);
      if (!this.active || !caster || caster.owner !== d.owner) return; // HQ lost before the drop
      this.world.economy.addResources(d.owner, { matter: d.amount });
    }
  }

  runDelayed(): void {
    if (this.delayed.length === 0) return;
    const now = this.world.time;
    const due = this.delayed.filter((d) => d.at <= now + 1e-9);
    if (due.length === 0) return;
    const keep = this.delayed.filter((d) => d.at > now + 1e-9);
    this.delayed.length = 0;
    this.delayed.push(...keep);
    for (const d of due) {
      try { this.runEffect(d); } catch (err) { console.error('[combat] delayed effect threw', err); }
    }
  }

  /** Drop metadata of projectiles no longer in world.projectiles (someone replaced/cleared the list). */
  pruneProjMeta(): void {
    if (this.projMeta.size <= this.world.projectiles.length) return;
    const live = new Set(this.world.projectiles.map((p) => p.id));
    for (const id of this.projMeta.keys()) if (!live.has(id)) this.projMeta.delete(id);
  }

  // ───────────── save / load (SaveParticipant 'combat') ─────────────
  /** Everything here that affects future ticks, as codec-safe data. Per-entity state is in entity.ext.combat. */
  saveState(): CombatSave {
    const w = this.world;
    const proj: CombatSave['proj'] = [];
    for (const [id, m] of this.projMeta) {
      // the shooter may already be removed from the world (died) yet still gets kill credit: keep a ghost
      const ghost = w.get(m.source.id) === m.source ? null : ghostFields(m.source);
      proj.push({ id, sourceId: m.source.id, ghost, damageAdd: m.damageAdd, damageMul: m.damageMul, traveled: m.traveled, launchedAt: m.launchedAt });
    }
    return { proj, delayed: this.delayed.map((d) => ({ ...d })), helpCalls: [...this.helpCalls.entries()].map(([k, h]) => [k, { ...h }]) };
  }

  loadState(data: CombatSave): void {
    this.projMeta.clear();
    this.delayed.length = 0;
    this.helpCalls.clear();
    if (!data) return;
    const ghosts = new Map<number, Entity>();
    for (const m of data.proj ?? []) {
      let src = this.world.get(m.sourceId) ?? ghosts.get(m.sourceId);
      if (!src && m.ghost) { src = rebuildGhost(m.ghost); ghosts.set(m.sourceId, src); }
      if (!src) continue; // stepProjectile falls back to world.get(sourceId)
      this.projMeta.set(m.id, { source: src, damageAdd: m.damageAdd, damageMul: m.damageMul, traveled: m.traveled, launchedAt: m.launchedAt });
    }
    for (const d of data.delayed ?? []) this.delayed.push({ ...d });
    for (const [k, h] of data.helpCalls ?? []) this.helpCalls.set(k, { ...h });
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.delayed.length = 0;
    this.projMeta.clear();
    this.helpCalls.clear();
  }
}
