import type { BuildingDef, ResourceNodeDef } from '../core/types';

const S = ['ground', 'structure', 'armored'] as BuildingDef['tags'];

export const BUILDINGS: BuildingDef[] = [
  // ─────────────── HOSPITAL DEFENSE CORPS ───────────────
  {
    kind: 'building', id: 'hosp_hq', name: 'Central Hospital', faction: 'hospital',
    role: 'Headquarters — trains Orderly Bots, receives Supplies',
    description: 'The command hub of the campus defence. Provides beds and a trickle of Power, and can call in emergency supply drops.',
    cost: { matter: 400 }, buildTime: 80, hp: 1500, armor: 1, sight: 11, footprint: { w: 5, h: 5 }, tags: S,
    provides: { pop: 10, energyPerSec: 0.25 }, trains: ['hosp_orderly'], researches: ['up_hosp_logistics'],
    requires: [], weapons: [], abilities: ['emergency_supply'], dropoff: true, hq: true, hotkey: 'H',
  },
  {
    kind: 'building', id: 'hosp_ward', name: 'Patient Ward', faction: 'hospital',
    role: 'Capacity — +8 Beds',
    description: 'Prefabricated ward modules. Each one adds beds for more defenders.',
    cost: { matter: 100 }, buildTime: 25, hp: 400, armor: 1, sight: 7, footprint: { w: 2, h: 2 }, tags: S,
    provides: { pop: 8 }, trains: [], researches: [], requires: [], weapons: [], abilities: [], hotkey: 'W',
  },
  {
    kind: 'building', id: 'hosp_generator', name: 'Backup Generator', faction: 'hospital',
    role: 'Power — generates +0.6 Power / sec',
    description: 'Diesel-electric backup generator. Advanced units, research and structures need Power.',
    cost: { matter: 100 }, buildTime: 30, hp: 350, armor: 1, sight: 7, footprint: { w: 2, h: 2 }, tags: S,
    provides: { energyPerSec: 0.6 }, trains: [], researches: [], requires: [], weapons: [], abilities: [], hotkey: 'G',
  },
  {
    kind: 'building', id: 'hosp_pharmacy', name: 'Pharmacy', faction: 'hospital',
    role: 'Infantry production — Sanitizers, Field Medics, UV Lancers',
    description: 'Equips and dispatches the hospital\'s front-line personnel.',
    cost: { matter: 150 }, buildTime: 45, hp: 1000, armor: 1, sight: 9, footprint: { w: 3, h: 3 }, tags: S,
    provides: {}, trains: ['hosp_sanitizer', 'hosp_medic', 'hosp_uv_lancer'], researches: [],
    requires: ['hosp_hq'], weapons: [], abilities: [], hotkey: 'P',
  },
  {
    kind: 'building', id: 'hosp_lab', name: 'Research Lab', faction: 'hospital',
    role: 'Research — weapon, armour and specialist upgrades',
    description: 'A biomedical research facility. Unlocks UV Lancers and develops upgrades for all hospital forces.',
    cost: { matter: 150, energy: 50 }, buildTime: 50, hp: 850, armor: 1, sight: 9, footprint: { w: 3, h: 3 }, tags: S,
    provides: {}, trains: [],
    researches: ['up_hosp_weapons_1', 'up_hosp_weapons_2', 'up_hosp_armor_1', 'up_hosp_armor_2', 'up_hosp_rapid_response', 'up_hosp_uv_overcharge'],
    requires: ['hosp_pharmacy'], weapons: [], abilities: [], hotkey: 'L',
  },
  {
    kind: 'building', id: 'hosp_vehicle_bay', name: 'Ambulance Depot', faction: 'hospital',
    role: 'Vehicle production — Antibiotic Launchers, Macrophage Mechs, Sterilizer Drones',
    description: 'The ambulance garage, retooled into a vehicle and drone workshop.',
    cost: { matter: 200, energy: 100 }, buildTime: 60, hp: 1250, armor: 1, sight: 9, footprint: { w: 4, h: 4 }, tags: S,
    provides: {}, trains: ['hosp_antibiotic_launcher', 'hosp_macrophage', 'hosp_sterilizer_drone'], researches: ['up_hosp_broad_spectrum'],
    requires: ['hosp_lab'], weapons: [], abilities: [], hotkey: 'V',
  },
  {
    kind: 'building', id: 'hosp_uv_turret', name: 'UV Turret', faction: 'hospital',
    role: 'Defence — UV emitter tower, hits ground and air',
    description: 'A fixed UV-C emitter on a mast. Strong against viruses.',
    cost: { matter: 125 }, buildTime: 30, hp: 450, armor: 1, sight: 10, footprint: { w: 2, h: 2 }, tags: S,
    provides: {}, trains: [], researches: [], requires: ['hosp_pharmacy'],
    weapons: [{ name: 'UV Emitter', damage: 12, damageType: 'uv', range: 7, cooldown: 1.2, targets: ['ground', 'air'], vfx: 'uv_beam', bonus: { viral: 8 } }],
    abilities: [], hotkey: 'T',
  },
  {
    kind: 'building', id: 'hosp_barricade', name: 'Quarantine Barricade', faction: 'hospital',
    role: 'Wall — cheap, very tough blocker',
    description: 'Sealed quarantine panels. Use them to funnel the infection into kill zones.',
    cost: { matter: 50 }, buildTime: 15, hp: 700, armor: 3, sight: 3, footprint: { w: 2, h: 2 }, tags: S,
    provides: {}, trains: [], researches: [], requires: [], weapons: [], abilities: [], hotkey: 'B',
  },
  {
    kind: 'building', id: 'obj_childrens_hospital', name: "Children's Hospital", faction: 'hospital',
    role: 'Objective — must be protected',
    description: 'Hundreds of young patients are sheltering inside. It must not fall.',
    cost: {}, buildTime: 1, hp: 3000, armor: 2, sight: 10, footprint: { w: 6, h: 6 }, tags: S,
    provides: {}, trains: [], researches: [], requires: [], weapons: [], abilities: [], hotkey: '', buildable: false,
  },

  // ─────────────── THE CONTAGION ───────────────
  {
    kind: 'building', id: 'path_hive', name: 'Infection Core', faction: 'pathogen',
    role: 'Hive — spawns Spore Drones, digests Biomass',
    description: 'A pulsating colony mass that anchors the infection. Regenerates and must be destroyed to end the outbreak.',
    cost: { matter: 400 }, buildTime: 80, hp: 1600, armor: 1, sight: 11, footprint: { w: 5, h: 5 }, tags: S,
    provides: { pop: 10, energyPerSec: 0.25 }, trains: ['path_spore_drone'], researches: ['up_path_metabolism'],
    requires: [], weapons: [], abilities: [], dropoff: true, hq: true, hotkey: 'H', hpRegen: 1.5,
  },
  {
    kind: 'building', id: 'path_nest', name: 'Spore Nest', faction: 'pathogen',
    role: 'Capacity — +8 Colony',
    description: 'A clutch of incubating sacs that lets the colony sustain more strains.',
    cost: { matter: 100 }, buildTime: 25, hp: 400, armor: 0, sight: 7, footprint: { w: 2, h: 2 }, tags: S,
    provides: { pop: 8 }, trains: [], researches: [], requires: [], weapons: [], abilities: [], hotkey: 'N', hpRegen: 0.5,
  },
  {
    kind: 'building', id: 'path_fermenter', name: 'Fermentation Vat', faction: 'pathogen',
    role: 'Toxin — generates +0.6 Toxin / sec',
    description: 'A bubbling vat of fermenting waste that distils Toxin for advanced strains.',
    cost: { matter: 100 }, buildTime: 30, hp: 350, armor: 0, sight: 7, footprint: { w: 2, h: 2 }, tags: S,
    provides: { energyPerSec: 0.6 }, trains: [], researches: [], requires: [], weapons: [], abilities: [], hotkey: 'V', hpRegen: 0.5,
  },
  {
    kind: 'building', id: 'path_replicator', name: 'Replication Pod', faction: 'pathogen',
    role: 'Strain production — Phages, Bacillus Brutes, Spirochete Lashers',
    description: 'A throbbing pod where pathogens copy themselves by the thousand.',
    cost: { matter: 150 }, buildTime: 45, hp: 1000, armor: 1, sight: 9, footprint: { w: 3, h: 3 }, tags: S,
    provides: {}, trains: ['path_phage', 'path_bacillus', 'path_spirochete'], researches: [],
    requires: ['path_hive'], weapons: [], abilities: [], hotkey: 'R', hpRegen: 1,
  },
  {
    kind: 'building', id: 'path_mutation_pit', name: 'Mutation Pit', faction: 'pathogen',
    role: 'Evolution — toxin, membrane and resistance mutations',
    description: 'A churning pit of genetic material where the colony evolves new defences against medicine.',
    cost: { matter: 150, energy: 50 }, buildTime: 50, hp: 850, armor: 1, sight: 9, footprint: { w: 3, h: 3 }, tags: S,
    provides: {}, trains: [],
    researches: ['up_path_toxins_1', 'up_path_toxins_2', 'up_path_carapace_1', 'up_path_carapace_2', 'up_path_flagella', 'up_path_resistance'],
    requires: ['path_replicator'], weapons: [], abilities: [], hotkey: 'M', hpRegen: 1,
  },
  {
    kind: 'building', id: 'path_biofilm_spire', name: 'Biofilm Spire', faction: 'pathogen',
    role: 'Advanced strains — Fungal Mortars, Superbugs, Influenza Drifters',
    description: 'A towering biofilm structure that cultivates the deadliest strains.',
    cost: { matter: 200, energy: 100 }, buildTime: 60, hp: 1250, armor: 1, sight: 9, footprint: { w: 4, h: 4 }, tags: S,
    provides: {}, trains: ['path_fungal_mortar', 'path_superbug', 'path_flu_drifter'], researches: ['up_path_virulence'],
    requires: ['path_mutation_pit'], weapons: [], abilities: [], hotkey: 'S', hpRegen: 1,
  },
  {
    kind: 'building', id: 'path_toxin_spitter', name: 'Toxin Spitter', faction: 'pathogen',
    role: 'Defence — acid-spitting growth, hits ground and air',
    description: 'A rooted fungal turret that spits corrosive acid at intruders.',
    cost: { matter: 125 }, buildTime: 30, hp: 450, armor: 1, sight: 10, footprint: { w: 2, h: 2 }, tags: S,
    provides: {}, trains: [], researches: [], requires: ['path_replicator'],
    weapons: [{ name: 'Toxin Spit', damage: 14, damageType: 'acid', range: 7, cooldown: 1.25, targets: ['ground', 'air'], vfx: 'acid_spit', projectileSpeed: 12, bonus: { mech: 4 } }],
    abilities: [], hotkey: 'T', hpRegen: 0.5,
  },
];

export const RESOURCE_NODES: ResourceNodeDef[] = [
  {
    kind: 'resource', id: 'res_supply_cache', name: 'Supply Cache', resource: 'matter', defaultAmount: 1500,
    radius: 1.0, footprint: { w: 2, h: 2 },
  },
];
