/**
 * [economy] EconomyService implementation: resources, requirements, placement, foundations, training & research
 * queues. Every rejecting call that performs an action (spend / placeFoundation / queueTrain / queueResearch)
 * emits a `notEnough` event with a faction-aware message ("Not enough Supplies", "Not enough Beds — build a
 * Patient Ward", "Requires Research Lab", ...). The can*() checks return the same reason without emitting.
 */
import { MAX_POP, TICK_DT } from '../../config';
import type { BuildingDef, Cost, Entity, EntityId, PlayerId, ProductionItem, TilePos } from '../../core/types';
import { BUILDING_DEFS, UNIT_DEFS, UPGRADE_DEFS } from '../../data';
import type { EconomyService } from '../services';
import type { World } from '../World';
import { CANCEL_REFUND } from './constants';
import { isOwnDropoff } from './gather';
import { fail, notEnoughPop, notEnoughResource, notifyFailure, OK, requiresMessage, type CheckResult } from './messages';
import { checkPlacement, normTile } from './placement';
import { meetsRequirements, missingRequirements } from './requirements';
import { getRuntime } from './state';

const num = (v: number | undefined): number => (v != null && Number.isFinite(v) ? v : 0);

/** Recompute popUsed (alive units + queued units) and popCap (completed buildings, ≤ MAX_POP) for every player. */
export function recomputePopulation(world: World): void {
  const used = new Map<PlayerId, number>(), cap = new Map<PlayerId, number>();
  for (const e of world.list) {
    if (!e.alive) continue;
    if (e.kind === 'unit') {
      used.set(e.owner, (used.get(e.owner) ?? 0) + num((e.def as { pop?: number }).pop));
    } else if (e.kind === 'building') {
      if (!e.construction) cap.set(e.owner, (cap.get(e.owner) ?? 0) + num((e.def as BuildingDef).provides.pop));
      const q = e.production?.queue;
      if (q) for (const it of q) if (it.kind === 'unit') used.set(e.owner, (used.get(e.owner) ?? 0) + num(UNIT_DEFS[it.defId]?.pop));
    }
  }
  for (const p of world.players.values()) {
    p.popUsed = used.get(p.id) ?? 0;
    p.popCap = Math.min(MAX_POP, cap.get(p.id) ?? 0);
  }
  const rt = getRuntime(world);
  if (rt) { rt.popTick = world.tick; rt.popListLen = world.list.length; }
}

/** Make sure popUsed/popCap reflect this tick (cheap when already fresh). */
export function ensurePopulation(world: World): void {
  const rt = getRuntime(world);
  if (!rt || rt.popTick !== world.tick || rt.popListLen !== world.list.length) recomputePopulation(world);
}

export class EconomyServiceImpl implements EconomyService {
  constructor(private readonly w: World) {}

  // ── resources ──
  canAfford(playerId: PlayerId, cost: Cost): boolean {
    const p = this.w.players.get(playerId);
    if (!p) return false;
    return p.resources.matter >= num(cost.matter) - 1e-9 && p.resources.energy >= num(cost.energy) - 1e-9;
  }

  /** First failing resource of `cost`, as a check result (no event). */
  affordCheck(playerId: PlayerId, cost: Cost): CheckResult {
    const p = this.w.players.get(playerId);
    if (!p) return fail('invalidTarget', 'Unknown player');
    if (p.resources.matter < num(cost.matter) - 1e-9) return fail('matter', notEnoughResource(this.w, playerId, 'matter'));
    if (p.resources.energy < num(cost.energy) - 1e-9) return fail('energy', notEnoughResource(this.w, playerId, 'energy'));
    return OK;
  }

  spend(playerId: PlayerId, cost: Cost): boolean {
    const chk = this.affordCheck(playerId, cost);
    if (!chk.ok) { notifyFailure(this.w, playerId, chk); return false; }
    const r = this.w.player(playerId).resources;
    r.matter = Math.max(0, r.matter - num(cost.matter));
    r.energy = Math.max(0, r.energy - num(cost.energy));
    return true;
  }

  refund(playerId: PlayerId, cost: Cost, fraction = 1): void {
    const p = this.w.players.get(playerId);
    if (!p) return;
    const f = Number.isFinite(fraction) ? Math.max(0, fraction) : 1;
    p.resources.matter += num(cost.matter) * f;
    p.resources.energy += num(cost.energy) * f;
  }

  addResources(playerId: PlayerId, bag: Cost): void {
    const p = this.w.players.get(playerId);
    if (!p) return;
    p.resources.matter = Math.max(0, p.resources.matter + num(bag.matter));
    p.resources.energy = Math.max(0, p.resources.energy + num(bag.energy));
  }

  // ── requirements ──
  meetsRequirements(playerId: PlayerId, requires: string[]): boolean { return meetsRequirements(this.w, playerId, requires); }
  missingRequirements(playerId: PlayerId, requires: string[]): string[] { return missingRequirements(this.w, playerId, requires); }

  // ── construction ──
  canPlaceBuilding(playerId: PlayerId, defId: string, tile: TilePos, builderId?: EntityId): { ok: boolean; reason?: string } {
    return checkPlacement(this.w, playerId, defId, tile, builderId);
  }

  placeFoundation(playerId: PlayerId, defId: string, tileIn: TilePos, builder: Entity | null): Entity | null {
    const tile = normTile(tileIn);
    const chk = checkPlacement(this.w, playerId, defId, tile, builder?.id);
    if (!chk.ok) { notifyFailure(this.w, playerId, chk); return null; }
    const def = BUILDING_DEFS[defId]!;
    if (!this.spend(playerId, def.cost)) return null;
    this.w.movement.clearFootprint?.(tile, def.footprint.w, def.footprint.h);
    const b = this.w.spawnBuilding(defId, playerId, tile, { complete: false });
    if (b.construction) {
      b.construction.builderId = builder?.alive ? builder.id : null;
      b.construction.costPaid = { ...def.cost };
    }
    this.w.events.emit('constructionStarted', { building: b, builder: builder?.alive ? builder : null });
    return b;
  }

  cancelConstruction(b: Entity): void {
    const c = b.construction;
    if (!c || !b.alive) return;
    this.refund(b.owner, c.costPaid, CANCEL_REFUND);
    this.w.events.emit('constructionCancelled', { building: b });
    this.w.removeEntity(b);
  }

  // ── training ──
  canTrain(b: Entity, unitDefId: string): { ok: boolean; reason?: string } { return this.trainCheck(b, unitDefId); }

  trainCheck(b: Entity, unitDefId: string): CheckResult {
    if (!b.alive || b.kind !== 'building' || !this.w.players.has(b.owner)) return fail('invalidTarget', "Can't train there");
    const def = b.def as BuildingDef;
    const u = UNIT_DEFS[unitDefId];
    if (!u || !def.trains.includes(unitDefId) || u.trainable === false || !b.production) return fail('invalidTarget', `Can't train that here`);
    if (b.construction) return fail('invalidTarget', 'Under construction');
    if (b.production.queue.length >= b.production.maxQueue) return fail('queueFull', 'Production queue is full');
    const missing = missingRequirements(this.w, b.owner, u.requires);
    if (missing.length) return fail('requirement', requiresMessage(missing));
    const afford = this.affordCheck(b.owner, u.cost);
    if (!afford.ok) return afford;
    if (u.pop > 0) {
      ensurePopulation(this.w);
      const p = this.w.player(b.owner);
      if (p.popUsed + u.pop > p.popCap) return fail('pop', notEnoughPop(this.w, b.owner));
    }
    return OK;
  }

  queueTrain(b: Entity, unitDefId: string): boolean {
    const chk = this.trainCheck(b, unitDefId);
    if (!chk.ok) { notifyFailure(this.w, b.owner, chk); return false; }
    const u = UNIT_DEFS[unitDefId]!;
    if (!this.spend(b.owner, u.cost)) return false;
    const item: ProductionItem = { kind: 'unit', defId: unitDefId, progress: 0, total: Math.max(TICK_DT, u.buildTime), cost: { ...u.cost } };
    b.production!.queue.push(item);
    this.w.player(b.owner).popUsed += u.pop;
    this.w.events.emit('productionQueued', { building: b, item });
    return true;
  }

  /** Cancel a queue item (default: the last one) with a full refund. Works for units and research. */
  cancelTrain(b: Entity, index?: number): void {
    const q = b.production?.queue;
    if (!q || q.length === 0) return;
    const i = index == null || !Number.isFinite(index) ? q.length - 1 : Math.floor(index);
    if (i < 0 || i >= q.length) return;
    const [item] = q.splice(i, 1);
    if (!item) return;
    this.refund(b.owner, item.cost, 1);
    const p = this.w.players.get(b.owner);
    if (p) {
      if (item.kind === 'unit') p.popUsed = Math.max(0, p.popUsed - num(UNIT_DEFS[item.defId]?.pop));
      else p.researching.delete(item.defId);
    }
    if (q.length === 0 && b.activity === 'producing') b.activity = 'idle';
  }

  // ── research ──
  canResearch(b: Entity, upgradeId: string): { ok: boolean; reason?: string } { return this.researchCheck(b, upgradeId); }

  researchCheck(b: Entity, upgradeId: string): CheckResult {
    if (!b.alive || b.kind !== 'building' || !this.w.players.has(b.owner)) return fail('invalidTarget', "Can't research there");
    const def = b.def as BuildingDef;
    const up = UPGRADE_DEFS[upgradeId];
    if (!up || !def.researches.includes(upgradeId) || !b.production) return fail('invalidTarget', "Can't research that here");
    if (b.construction) return fail('invalidTarget', 'Under construction');
    const p = this.w.player(b.owner);
    if (p.upgrades.has(upgradeId)) return fail('invalidTarget', 'Already researched');
    if (p.researching.has(upgradeId) || this.inAnyQueue(b.owner, upgradeId)) return fail('invalidTarget', 'Already being researched');
    if (b.production.queue.length >= b.production.maxQueue) return fail('queueFull', 'Production queue is full');
    const missing = missingRequirements(this.w, b.owner, up.requires);
    if (missing.length) return fail('requirement', requiresMessage(missing));
    return this.affordCheck(b.owner, up.cost);
  }

  private inAnyQueue(playerId: PlayerId, upgradeId: string): boolean {
    for (const e of this.w.list) {
      if (!e.alive || e.owner !== playerId || !e.production) continue;
      if (e.production.queue.some((it) => it.kind === 'upgrade' && it.defId === upgradeId)) return true;
    }
    return false;
  }

  queueResearch(b: Entity, upgradeId: string): boolean {
    const chk = this.researchCheck(b, upgradeId);
    if (!chk.ok) { notifyFailure(this.w, b.owner, chk); return false; }
    const up = UPGRADE_DEFS[upgradeId]!;
    if (!this.spend(b.owner, up.cost)) return false;
    const item: ProductionItem = { kind: 'upgrade', defId: upgradeId, progress: 0, total: Math.max(TICK_DT, up.researchTime), cost: { ...up.cost } };
    b.production!.queue.push(item);
    this.w.player(b.owner).researching.add(upgradeId);
    this.w.events.emit('productionQueued', { building: b, item });
    return true;
  }

  /** Cancel the most recently queued research of the building (full refund). */
  cancelResearch(b: Entity): void {
    const q = b.production?.queue;
    if (!q) return;
    for (let i = q.length - 1; i >= 0; i--) if (q[i]!.kind === 'upgrade') { this.cancelTrain(b, i); return; }
  }

  // ── workers ──
  nearestDropoff(worker: Entity): Entity | null {
    let best: Entity | null = null, bd = Infinity;
    for (const e of this.w.list) {
      if (!isOwnDropoff(e, worker)) continue;
      const d = this.w.edgeDistanceToPoint(e, worker.pos);
      if (d < bd - 1e-9) { bd = d; best = e; }
    }
    return best;
  }

}
