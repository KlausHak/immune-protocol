import type { AbilityDef, AnyDef, BuildingDef, FactionId, ResourceNodeDef, UnitDef, UpgradeDef } from '../core/types';
import { UNITS } from './units';
import { BUILDINGS, RESOURCE_NODES } from './buildings';
import { UPGRADES } from './upgrades';
import { ABILITIES } from './abilities';

export { FACTIONS } from './factions';
export type { FactionInfo } from './factions';

const byId = <T extends { id: string }>(list: T[]): Record<string, T> => Object.fromEntries(list.map((d) => [d.id, d]));

export const UNIT_DEFS: Record<string, UnitDef> = byId(UNITS);
export const BUILDING_DEFS: Record<string, BuildingDef> = byId(BUILDINGS);
export const RESOURCE_DEFS: Record<string, ResourceNodeDef> = byId(RESOURCE_NODES);
export const UPGRADE_DEFS: Record<string, UpgradeDef> = byId(UPGRADES);
export const ABILITY_DEFS: Record<string, AbilityDef> = byId(ABILITIES);

export const SUPPLY_CACHE_ID = 'res_supply_cache';

export function getDef(id: string): AnyDef {
  const d = UNIT_DEFS[id] ?? BUILDING_DEFS[id] ?? RESOURCE_DEFS[id];
  if (!d) throw new Error(`Unknown def id "${id}"`);
  return d;
}
export const tryGetDef = (id: string): AnyDef | undefined => UNIT_DEFS[id] ?? BUILDING_DEFS[id] ?? RESOURCE_DEFS[id];
export const getUnitDef = (id: string): UnitDef => { const d = UNIT_DEFS[id]; if (!d) throw new Error(`Unknown unit "${id}"`); return d; };
export const getBuildingDef = (id: string): BuildingDef => { const d = BUILDING_DEFS[id]; if (!d) throw new Error(`Unknown building "${id}"`); return d; };
export const getUpgradeDef = (id: string): UpgradeDef => { const d = UPGRADE_DEFS[id]; if (!d) throw new Error(`Unknown upgrade "${id}"`); return d; };
export const getAbilityDef = (id: string): AbilityDef => { const d = ABILITY_DEFS[id]; if (!d) throw new Error(`Unknown ability "${id}"`); return d; };

export const unitsOfFaction = (f: FactionId): UnitDef[] => UNITS.filter((u) => u.faction === f);
export const buildingsOfFaction = (f: FactionId): BuildingDef[] => BUILDINGS.filter((b) => b.faction === f);
export const upgradesOfFaction = (f: FactionId): UpgradeDef[] => UPGRADES.filter((u) => u.faction === f);

/** Buildings that can train the given unit id. */
export const producersOf = (unitId: string): BuildingDef[] => BUILDINGS.filter((b) => b.trains.includes(unitId));
/** Buildings that can research the given upgrade id. */
export const researchersOf = (upgradeId: string): BuildingDef[] => BUILDINGS.filter((b) => b.researches.includes(upgradeId));

export const ALL_UNITS = UNITS;
export const ALL_BUILDINGS = BUILDINGS;
export const ALL_UPGRADES = UPGRADES;
export const ALL_ABILITIES = ABILITIES;
