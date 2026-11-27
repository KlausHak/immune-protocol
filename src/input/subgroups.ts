/**
 * [input] Selection subgroups: a selection is split into groups of the same definition id, ordered by a
 * "sensible" priority (heroes → combat units by tier → workers → HQs → production/research → defences →
 * other structures → resource nodes). The first subgroup is the active one by default; Tab cycles.
 * Pure & headless-safe (no DOM / three.js) so it can be unit-tested in Node.
 */
import type { AnyDef, Entity, EntityId } from '../core/types';

export interface Subgroup {
  defId: string;
  ids: EntityId[];
}

/** Resource value used to rank tiers (energy is the scarcer resource). */
const costValue = (def: AnyDef): number => (def.kind === 'resource' ? 0 : (def.cost.matter ?? 0) + 2 * (def.cost.energy ?? 0));

/**
 * Higher = earlier. Bands: heroes 3500+, combat/support units 3000–3199, workers 2700–2899,
 * buildings 1000–2199 (HQ > producers/researchers > armed defences > other), resources 0.
 */
export function subgroupPriority(def: AnyDef): number {
  if (def.kind === 'resource') return 0;
  const tier = Math.min(199, costValue(def) / 5);
  if (def.kind === 'unit') {
    let p = 3000 + tier;
    if (def.tags.includes('hero')) p += 500;
    if (def.gather) p -= 300;
    return p;
  }
  let p = 1000 + tier;
  if (def.hq) p += 600;
  if (def.trains.length > 0 || def.researches.length > 0) p += 400;
  if (def.weapons.length > 0) p += 200;
  return p;
}

/** Comparator for subgroup defs: priority desc, then def id for determinism. */
export function compareDefs(a: AnyDef, b: AnyDef): number {
  const d = subgroupPriority(b) - subgroupPriority(a);
  return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Group entities by defId, ordered by priority. Ids inside a subgroup keep the input order.
 */
export function orderSubgroups(entities: readonly Entity[]): Subgroup[] {
  const byDef = new Map<string, { def: AnyDef; ids: EntityId[] }>();
  for (const e of entities) {
    let g = byDef.get(e.defId);
    if (!g) { g = { def: e.def, ids: [] }; byDef.set(e.defId, g); }
    g.ids.push(e.id);
  }
  return [...byDef.values()].sort((a, b) => compareDefs(a.def, b.def)).map((g) => ({ defId: g.def.id, ids: g.ids }));
}

/** Sort entities so that subgroups are contiguous and in priority order (stable within a subgroup). */
export function sortBySubgroup(entities: readonly Entity[]): Entity[] {
  const order = new Map<string, number>();
  orderSubgroups(entities).forEach((g, i) => order.set(g.defId, i));
  return entities
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (order.get(a.e.defId)! - order.get(b.e.defId)!) || a.i - b.i)
    .map((x) => x.e);
}
