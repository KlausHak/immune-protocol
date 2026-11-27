/**
 * [combat] CombatService: damage, healing and targeting rules (DESIGN §2), plus the splash helper.
 *   dealt = max(0.5, raw × resist[type] − armor)
 *   raw   = (weapon.damage + Σ bonus[tag] + stats.damageAdd) × stats.damageMul
 */
import { clamp } from '../../core/math';
import type { DamageType, Entity, PlayerId, Vec2, WeaponDef } from '../../core/types';
import type { CombatService } from '../services';
import { BUILDING_QUERY_PAD } from './constants';
import type { CombatRuntime } from './runtime';
import { bonusVs, layerOf } from './state';

export interface SplashSpec {
  center: Vec2;
  radius: number;
  /** Friendly fire is off: only enemies of this player are hit. */
  ownerPlayer: PlayerId;
  /** Damage credit (kills, alerts, retaliation). May be a dead entity (projectile from a dead shooter). */
  source: Entity | null;
  type: DamageType;
  /** Raw (pre-armour, pre-falloff) damage against a given target. */
  rawFor: (target: Entity) => number;
  /** Linear falloff to 50% at the edge (default true). */
  falloff?: boolean;
  /** Entity already hit at full damage (primary target of a splash weapon). */
  exclude?: Entity | null;
  /** Layers affected (default: both). Ground-only weapons don't splash air units. */
  layers?: ReadonlyArray<'ground' | 'air'>;
}

/**
 * Area damage: every enemy (of spec.ownerPlayer) whose edge is within `radius` of `center` takes
 * rawFor(target) × falloff, where falloff goes linearly from 100% at the centre to 50% at the edge.
 * Never hits allies, neutrals or resources. Returns total damage dealt.
 */
export function splashDamage(rt: CombatRuntime, s: SplashSpec): number {
  if (!(s.radius > 0)) return 0;
  const w = rt.world;
  // fresh buffer: applyDamage → death → viral burst can re-enter splashDamage
  const hits = w.spatial.queryRadius(s.center, s.radius + BUILDING_QUERY_PAD, undefined, []);
  let total = 0;
  for (let i = 0; i < hits.length; i++) {
    const o = hits[i]!;
    if (!o.alive || o === s.exclude || o.kind === 'resource') continue;
    if (!w.isEnemy(s.ownerPlayer, o.owner)) continue;
    if (s.layers && !s.layers.includes(layerOf(o))) continue;
    const d = w.edgeDistanceToPoint(o, s.center);
    if (d > s.radius) continue;
    const f = s.falloff === false ? 1 : 1 - 0.5 * clamp(d / s.radius, 0, 1);
    total += rt.service.applyDamage(o, s.rawFor(o) * f, s.type, s.source);
  }
  return total;
}

export class CombatServiceImpl implements CombatService {
  constructor(private readonly rt: CombatRuntime) {}

  applyDamage(target: Entity, rawDamage: number, type: DamageType, source: Entity | null): number {
    if (!target.alive || target.kind === 'resource' || target.invulnerable) return 0;
    if (!(rawDamage > 0)) return 0; // also rejects NaN
    const resist = target.stats.resist[type] ?? 1;
    const dealt = Math.max(0.5, rawDamage * resist - target.stats.armor);
    target.hp -= dealt;
    const w = this.rt.world;
    w.reportDamage(target, dealt, type, source);
    if (source && source !== target) this.rt.noteHelpCall(target, source);
    if (target.hp <= 0 && target.alive) w.killEntity(target, source);
    return dealt;
  }

  heal(target: Entity, amount: number, source: Entity | null): number {
    if (!target.alive || target.kind === 'resource' || !(amount > 0)) return 0;
    const h = Math.min(amount, target.stats.maxHp - target.hp);
    if (h <= 0) return 0;
    target.hp += h;
    this.rt.world.events.emit('entityHealed', { entity: target, amount: h, source });
    return h;
  }

  rawDamage(attacker: Entity, weapon: WeaponDef, target: Entity): number {
    return (weapon.damage + bonusVs(weapon.bonus, target) + attacker.stats.damageAdd) * attacker.stats.damageMul;
  }

  weaponFor(attacker: Entity, target: Entity): WeaponDef | null {
    if (attacker.def.kind === 'resource' || attacker.construction) return null;
    const weapons = attacker.def.weapons;
    if (weapons.length === 0) return null;
    const layer = layerOf(target);
    if (weapons.length === 1) return weapons[0]!.targets.includes(layer) ? weapons[0]! : null;
    let best: WeaponDef | null = null, bestDps = -1;
    for (const wp of weapons) {
      if (!wp.targets.includes(layer)) continue;
      const dps = this.rawDamage(attacker, wp, target) / Math.max(0.05, wp.cooldown);
      if (dps > bestDps) { bestDps = dps; best = wp; }
    }
    return best;
  }

  weaponRange(attacker: Entity, weapon: WeaponDef): number {
    return weapon.range + attacker.stats.rangeAdd;
  }

  canTarget(attacker: Entity, target: Entity): boolean {
    if (!target.alive || target === attacker || target.kind === 'resource') return false;
    const w = this.rt.world;
    if (!w.isEnemy(attacker.owner, target.owner)) return false;
    if (!this.weaponFor(attacker, target)) return false;
    return w.vision.isEntityVisible(attacker.owner, target);
  }

  /** Convenience wrapper around splashDamage (other modules: world.combat as CombatServiceImpl). */
  splash(spec: SplashSpec): number { return splashDamage(this.rt, spec); }
}
