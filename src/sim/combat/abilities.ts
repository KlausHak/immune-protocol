/**
 * [combat] AbilityService + ability implementations (data: src/data/abilities.ts).
 *   uv_flare          point AoE (no falloff), bonus vs viral, all enemy layers
 *   emergency_supply  HQ: abilityUsed now, +amount matter EMERGENCY_SUPPLY_DELAY s later (helicopter drop)
 *   viral_burst       passive: a dying phage splashes nearby enemy ground units (abilityUsed from the corpse)
 *   omega_spawn       passive: Strain Omega sheds `amount` phages every cooldown s that attack-move with/ahead of it
 * Unknown ids with damage + radius fall back to a generic point AoE so data-only abilities still work.
 */
import { clone, fromAngle } from '../../core/math';
import type { AbilityDef, Entity, NotEnoughKind, Order, UnitDef, Vec2 } from '../../core/types';
import { ABILITY_DEFS, FACTIONS, UNIT_DEFS } from '../../data';
import type { AbilityService } from '../services';
import { EMERGENCY_SUPPLY_DELAY, OMEGA_ADVANCE, OMEGA_BROOD_UNIT, OMEGA_FIRST_DELAY, OMEGA_MAX_BROOD } from './constants';
import type { CombatRuntime } from './runtime';
import { splashDamage } from './service';
import { bonusVs, cx } from './state';

export interface CastCheck { ok: boolean; reason?: string; kind?: NotEnoughKind }

interface AbilityImpl {
  /** Active effect (after cooldown/cost were applied and abilityUsed was emitted). */
  cast?(rt: CombatRuntime, caster: Entity, a: AbilityDef, target: Vec2 | undefined, targetEntity: Entity | null): void;
  /** Passive: the owner died (entityDied). */
  onDeath?(rt: CombatRuntime, e: Entity, a: AbilityDef): void;
  /** Passive: runs every tick (combat system) for alive owners. */
  tick?(rt: CombatRuntime, e: Entity, a: AbilityDef): void;
}

/** Point AoE: full damage (+bonus vs tags) to every enemy within the radius. */
function pointBlast(rt: CombatRuntime, caster: Entity, a: AbilityDef, center: Vec2): void {
  if (!a.damage || !a.radius) return;
  splashDamage(rt, {
    center, radius: a.radius, ownerPlayer: caster.owner, source: caster, type: a.damageType ?? 'normal',
    rawFor: (o) => (a.damage ?? 0) + bonusVs(a.bonus, o), falloff: false,
  });
}

/** Where Strain Omega's brood should go: Omega's own destination / target, else straight ahead. */
function omegaDestination(rt: CombatRuntime, e: Entity): Vec2 {
  const w = rt.world;
  const o = e.orders[0];
  if (o) {
    if (o.type === 'attackMove' || o.type === 'move') return clone(o.target);
    if (o.type === 'patrol') return clone(o.to);
    if (o.type === 'attack' || o.type === 'follow') { const t = w.getAlive(o.targetId); if (t) return clone(t.pos); }
  }
  const t = w.getAlive(e.combat?.targetId ?? null);
  if (t) return clone(t.pos);
  const f = fromAngle(e.facing, OMEGA_ADVANCE);
  return { x: Math.min(w.map.width - 1, Math.max(1, e.pos.x + f.x)), y: Math.min(w.map.height - 1, Math.max(1, e.pos.y + f.y)) };
}

const IMPLS: Record<string, AbilityImpl> = {
  uv_flare: {
    cast(rt, caster, a, target) { if (target) pointBlast(rt, caster, a, target); },
  },
  emergency_supply: {
    cast(rt, caster, a) {
      rt.schedule(EMERGENCY_SUPPLY_DELAY, { kind: 'supplyDrop', casterId: caster.id, owner: caster.owner, amount: a.amount ?? 100 });
    },
  },
  viral_burst: {
    onDeath(rt, e, a) {
      if (!a.damage || !a.radius) return;
      const center = clone(e.pos);
      rt.world.events.emit('abilityUsed', { source: e, abilityId: a.id, target: clone(center), targetEntity: null });
      splashDamage(rt, {
        center, radius: a.radius, ownerPlayer: e.owner, source: e, type: a.damageType ?? 'toxin',
        rawFor: (o) => (a.damage ?? 0) + bonusVs(a.bonus, o), layers: ['ground'],
      });
    },
  },
  omega_spawn: {
    tick(rt, e, a) {
      const cd = e.cooldowns[a.id];
      if (cd === undefined) { e.cooldowns[a.id] = Math.min(OMEGA_FIRST_DELAY, a.cooldown); return; }
      if (cd > 0) return;
      e.cooldowns[a.id] = a.cooldown;
      const w = rt.world, x = cx(e);
      x.brood = x.brood.filter((id) => !!w.getAlive(id));
      const n = Math.min(a.amount ?? 3, OMEGA_MAX_BROOD - x.brood.length);
      if (n <= 0 || !UNIT_DEFS[OMEGA_BROOD_UNIT]) return;
      const dest = omegaDestination(rt, e);
      const spawned: Entity[] = [];
      for (let i = 0; i < n; i++) {
        // fan out in front of Omega (toward where it's heading)
        const ang = e.facing + (i - (n - 1) / 2) * 0.7 + w.rng.range(-0.15, 0.15);
        const r = e.radius + 0.9;
        const want = { x: e.pos.x + Math.cos(ang) * r, y: e.pos.y + Math.sin(ang) * r };
        const p = w.movement.nearestWalkable(want, 4) ?? clone(e.pos);
        const ph = w.spawnUnit(OMEGA_BROOD_UNIT, e.owner, p, { facing: ang });
        ph.scriptTags.add('omega_brood');
        spawned.push(ph);
        x.brood.push(ph.id);
      }
      const targets = spawned.length > 1 ? w.movement.groupTargets(spawned, dest) : [dest];
      spawned.forEach((ph, i) => w.setOrders(ph, [{ type: 'attackMove', target: clone(targets[i] ?? dest) } as Order]));
      w.events.emit('abilityUsed', { source: e, abilityId: a.id, target: clone(e.pos), targetEntity: null });
    },
  },
};

export class AbilityServiceImpl implements AbilityService {
  constructor(private readonly rt: CombatRuntime) {}

  /** Full validity check; range is only enforced when checkRange (cast() leaves range to the caller). */
  check(caster: Entity, abilityId: string, target: Vec2 | undefined, targetEntity: Entity | null | undefined, checkRange: boolean): CastCheck {
    const a = ABILITY_DEFS[abilityId];
    const w = this.rt.world;
    if (!a) return { ok: false, reason: 'Unknown ability', kind: 'requirement' };
    if (!caster.alive || caster.def.kind === 'resource' || !caster.def.abilities.includes(abilityId)) return { ok: false, reason: `Can't use ${a.name}`, kind: 'requirement' };
    if (a.target === 'passive') return { ok: false, reason: 'Passive ability', kind: 'requirement' };
    if (caster.construction) return { ok: false, reason: 'Under construction', kind: 'requirement' };
    if ((caster.cooldowns[abilityId] ?? 0) > 0) return { ok: false, reason: `${a.name} is not ready yet`, kind: 'cooldown' };
    if (a.cost && !w.economy.canAfford(caster.owner, a.cost)) {
      const r = w.player(caster.owner).resources;
      const kind: NotEnoughKind = r.matter < (a.cost.matter ?? 0) ? 'matter' : 'energy';
      const names = FACTIONS[w.player(caster.owner).faction]?.resourceNames;
      return { ok: false, reason: `Not enough ${names ? names[kind as 'matter' | 'energy'] : kind}`, kind };
    }
    if (a.target === 'point') {
      const p = target ?? targetEntity?.pos;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > w.map.width || p.y > w.map.height) {
        return { ok: false, reason: 'Invalid target', kind: 'invalidTarget' };
      }
      if (checkRange && a.range != null && w.edgeDistanceToPoint(caster, p) > a.range + 0.01) return { ok: false, reason: 'Target is out of range', kind: 'invalidTarget' };
    } else if (a.target === 'unit') {
      if (!targetEntity || !targetEntity.alive || targetEntity.kind === 'resource' || !w.vision.isEntityVisible(caster.owner, targetEntity)) {
        return { ok: false, reason: 'Invalid target', kind: 'invalidTarget' };
      }
      if (checkRange && a.range != null && w.edgeDistance(caster, targetEntity) > a.range + 0.01) return { ok: false, reason: 'Target is out of range', kind: 'invalidTarget' };
    }
    return { ok: true };
  }

  canCast(caster: Entity, abilityId: string, target?: Vec2, targetEntity?: Entity | null): { ok: boolean; reason?: string } {
    const r = this.check(caster, abilityId, target, targetEntity, true);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  cast(caster: Entity, abilityId: string, target?: Vec2, targetEntity?: Entity | null): boolean {
    const w = this.rt.world;
    const r = this.check(caster, abilityId, target, targetEntity, false);
    if (!r.ok) { this.notify(caster, r); return false; }
    const a = ABILITY_DEFS[abilityId]!;
    if (a.cost && !w.economy.spend(caster.owner, a.cost)) return false; // spend() emits notEnough itself
    caster.cooldowns[abilityId] = a.cooldown;
    const point = a.target === 'point' ? clone(target ?? targetEntity!.pos) : a.target === 'unit' && targetEntity ? clone(targetEntity.pos) : undefined;
    w.events.emit('abilityUsed', { source: caster, abilityId, target: point ? clone(point) : null, targetEntity: targetEntity ?? null });
    const impl = IMPLS[abilityId];
    if (impl?.cast) impl.cast(this.rt, caster, a, point, targetEntity ?? null);
    else if (point) pointBlast(this.rt, caster, a, point); // data-only fallback
    return true;
  }

  /** Emit notEnough feedback for a failed cast. */
  notify(caster: Entity, r: CastCheck): void {
    if (r.ok) return;
    this.rt.world.events.emit('notEnough', { playerId: caster.owner, kind: r.kind ?? 'requirement', message: r.reason ?? "Can't do that" });
  }

  /** entityDied hook: run on-death passives of the dead entity. */
  onDeath(e: Entity): void {
    if (e.def.kind === 'resource' || e.def.abilities.length === 0) return;
    for (const id of e.def.abilities) {
      const impl = IMPLS[id], a = ABILITY_DEFS[id];
      if (impl?.onDeath && a) impl.onDeath(this.rt, e, a);
    }
  }

  /** Combat-system hook: ticking passives of an alive entity. */
  tick(e: Entity): void {
    if (e.def.kind === 'resource') return;
    for (const id of e.def.abilities) {
      const impl = IMPLS[id], a = ABILITY_DEFS[id];
      if (impl?.tick && a) impl.tick(this.rt, e, a);
    }
  }

  /** Whether any of the def's abilities is a ticking passive (cached per def by the runtime). */
  static hasTickPassive(def: UnitDef | { abilities: string[] }): boolean {
    return def.abilities.some((id) => !!IMPLS[id]?.tick);
  }
}
