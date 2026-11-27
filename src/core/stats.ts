import type { AnyDef, EntityStats, UnitTag, UpgradeDef, UpgradeEffect } from './types';

/** Base stats straight from a definition (no upgrades). */
export function baseStats(def: AnyDef): EntityStats {
  if (def.kind === 'resource') {
    return { maxHp: 1, armor: 0, speed: 0, sight: 0, hpRegen: 0, damageAdd: 0, damageMul: 1, rangeAdd: 0, cooldownMul: 1, gatherCapacityAdd: 0, healRateMul: 1, resist: {} };
  }
  return {
    maxHp: def.hp,
    armor: def.armor,
    speed: def.kind === 'unit' ? def.speed : 0,
    sight: def.sight,
    hpRegen: def.hpRegen ?? 0,
    damageAdd: 0,
    damageMul: 1,
    rangeAdd: 0,
    cooldownMul: 1,
    gatherCapacityAdd: 0,
    healRateMul: 1,
    resist: { ...(def.kind === 'unit' ? def.resist ?? {} : {}) },
  };
}

export function effectApplies(effect: UpgradeEffect, defId: string, tags: ReadonlySet<UnitTag>): boolean {
  const a = effect.appliesTo;
  if (a.ids && a.ids.length && !a.ids.includes(defId)) return false;
  if (a.tags && a.tags.length && !a.tags.some((t) => tags.has(t))) return false;
  if (a.excludeTags && a.excludeTags.some((t) => tags.has(t))) return false;
  return true;
}

/** Effective stats = base stats + every completed upgrade whose effects apply to this def. */
export function computeStats(def: AnyDef, tags: ReadonlySet<UnitTag>, upgrades: Iterable<UpgradeDef>): EntityStats {
  const s = baseStats(def);
  for (const up of upgrades) {
    for (const eff of up.effects) {
      if (!effectApplies(eff, def.id, tags)) continue;
      if (eff.stat === 'resist') {
        if (!eff.damageType) continue;
        const cur = s.resist[eff.damageType] ?? 1;
        s.resist[eff.damageType] = cur * (eff.mul ?? 1);
        continue;
      }
      const k = eff.stat;
      (s[k] as number) = ((s[k] as number) + (eff.add ?? 0)) * (eff.mul ?? 1);
    }
  }
  return s;
}
