import type { UpgradeDef } from '../core/types';

/** Upgrades apply only to the researching player's entities. damageMul/speed mul compound per level. */
const ARMY = { excludeTags: ['worker' as const] };
const UNITS_ONLY = { excludeTags: ['structure' as const] };

export const UPGRADES: UpgradeDef[] = [
  // ─── Hospital: Research Lab ───
  { kind: 'upgrade', id: 'up_hosp_weapons_1', name: 'Concentrated Disinfectants', faction: 'hospital', description: '+12% damage for all hospital combat units and turrets.', cost: { matter: 100, energy: 100 }, researchTime: 60, requires: ['hosp_lab'], hotkey: 'W', effects: [{ stat: 'damageMul', mul: 1.12, appliesTo: ARMY }] },
  { kind: 'upgrade', id: 'up_hosp_weapons_2', name: 'Clinical-Grade Formulas', faction: 'hospital', description: 'A further +12% damage for all hospital combat units and turrets.', cost: { matter: 175, energy: 175 }, researchTime: 75, requires: ['hosp_lab', 'up_hosp_weapons_1'], hotkey: 'E', effects: [{ stat: 'damageMul', mul: 1.12, appliesTo: ARMY }] },
  { kind: 'upgrade', id: 'up_hosp_armor_1', name: 'Hazmat Plating', faction: 'hospital', description: '+1 armour for all hospital units.', cost: { matter: 100, energy: 100 }, researchTime: 60, requires: ['hosp_lab'], hotkey: 'A', effects: [{ stat: 'armor', add: 1, appliesTo: UNITS_ONLY }] },
  { kind: 'upgrade', id: 'up_hosp_armor_2', name: 'Reinforced Hazmat', faction: 'hospital', description: 'A further +1 armour for all hospital units.', cost: { matter: 175, energy: 175 }, researchTime: 75, requires: ['hosp_lab', 'up_hosp_armor_1'], hotkey: 'S', effects: [{ stat: 'armor', add: 1, appliesTo: UNITS_ONLY }] },
  { kind: 'upgrade', id: 'up_hosp_rapid_response', name: 'Rapid Response', faction: 'hospital', description: '+15% movement speed for biological units (staff).', cost: { matter: 100, energy: 100 }, researchTime: 60, requires: ['hosp_lab'], hotkey: 'R', effects: [{ stat: 'speed', mul: 1.15, appliesTo: { tags: ['bio'] } }] },
  { kind: 'upgrade', id: 'up_hosp_uv_overcharge', name: 'UV Overcharge', faction: 'hospital', description: 'UV Lancers and UV Turrets: +1 range and +20% damage.', cost: { matter: 150, energy: 150 }, researchTime: 70, requires: ['hosp_lab'], hotkey: 'U', effects: [{ stat: 'rangeAdd', add: 1, appliesTo: { ids: ['hosp_uv_lancer', 'hosp_uv_turret'] } }, { stat: 'damageMul', mul: 1.2, appliesTo: { ids: ['hosp_uv_lancer', 'hosp_uv_turret'] } }] },
  // ─── Hospital: Ambulance Depot ───
  { kind: 'upgrade', id: 'up_hosp_broad_spectrum', name: 'Broad-Spectrum Antibiotics', faction: 'hospital', description: 'Antibiotic Launchers: +25% damage and +1 range.', cost: { matter: 150, energy: 150 }, researchTime: 70, requires: ['hosp_vehicle_bay'], hotkey: 'B', effects: [{ stat: 'damageMul', mul: 1.25, appliesTo: { ids: ['hosp_antibiotic_launcher'] } }, { stat: 'rangeAdd', add: 1, appliesTo: { ids: ['hosp_antibiotic_launcher'] } }] },
  // ─── Hospital: Central Hospital ───
  { kind: 'upgrade', id: 'up_hosp_logistics', name: 'Logistics Optimisation', faction: 'hospital', description: 'Orderly Bots carry +1 Supplies per trip.', cost: { matter: 100 }, researchTime: 45, requires: ['hosp_hq'], hotkey: 'L', effects: [{ stat: 'gatherCapacityAdd', add: 1, appliesTo: { tags: ['worker'] } }] },

  // ─── Pathogen: Mutation Pit ───
  { kind: 'upgrade', id: 'up_path_toxins_1', name: 'Potent Toxins', faction: 'pathogen', description: '+12% damage for all pathogen combat strains and spitters.', cost: { matter: 100, energy: 100 }, researchTime: 60, requires: ['path_mutation_pit'], hotkey: 'T', effects: [{ stat: 'damageMul', mul: 1.12, appliesTo: ARMY }] },
  { kind: 'upgrade', id: 'up_path_toxins_2', name: 'Lethal Toxins', faction: 'pathogen', description: 'A further +12% damage for all pathogen combat strains.', cost: { matter: 175, energy: 175 }, researchTime: 75, requires: ['path_mutation_pit', 'up_path_toxins_1'], hotkey: 'Y', effects: [{ stat: 'damageMul', mul: 1.12, appliesTo: ARMY }] },
  { kind: 'upgrade', id: 'up_path_carapace_1', name: 'Mucus Membrane', faction: 'pathogen', description: '+1 armour for all pathogen strains.', cost: { matter: 100, energy: 100 }, researchTime: 60, requires: ['path_mutation_pit'], hotkey: 'C', effects: [{ stat: 'armor', add: 1, appliesTo: UNITS_ONLY }] },
  { kind: 'upgrade', id: 'up_path_carapace_2', name: 'Hardened Capsule', faction: 'pathogen', description: 'A further +1 armour for all pathogen strains.', cost: { matter: 175, energy: 175 }, researchTime: 75, requires: ['path_mutation_pit', 'up_path_carapace_1'], hotkey: 'V', effects: [{ stat: 'armor', add: 1, appliesTo: UNITS_ONLY }] },
  { kind: 'upgrade', id: 'up_path_flagella', name: 'Flagellar Motors', faction: 'pathogen', description: '+15% movement speed for all pathogen strains.', cost: { matter: 100, energy: 100 }, researchTime: 60, requires: ['path_mutation_pit'], hotkey: 'F', effects: [{ stat: 'speed', mul: 1.15, appliesTo: UNITS_ONLY }] },
  { kind: 'upgrade', id: 'up_path_resistance', name: 'Antibiotic Resistance', faction: 'pathogen', description: 'Bacterial strains take 30% less damage from antibiotics.', cost: { matter: 150, energy: 150 }, researchTime: 70, requires: ['path_mutation_pit'], hotkey: 'R', effects: [{ stat: 'resist', damageType: 'antibiotic', mul: 0.7, appliesTo: { tags: ['bacterial'] } }] },
  // ─── Pathogen: Biofilm Spire ───
  { kind: 'upgrade', id: 'up_path_virulence', name: 'Virulence', faction: 'pathogen', description: 'Viral strains gain +15% maximum health.', cost: { matter: 150, energy: 150 }, researchTime: 70, requires: ['path_biofilm_spire'], hotkey: 'V', effects: [{ stat: 'maxHp', mul: 1.15, appliesTo: { tags: ['viral'] } }] },
  // ─── Pathogen: Infection Core ───
  { kind: 'upgrade', id: 'up_path_metabolism', name: 'Hypermetabolism', faction: 'pathogen', description: 'Spore Drones carry +1 Biomass per trip.', cost: { matter: 100 }, researchTime: 45, requires: ['path_hive'], hotkey: 'M', effects: [{ stat: 'gatherCapacityAdd', add: 1, appliesTo: { tags: ['worker'] } }] },
];
