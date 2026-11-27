import type { UnitDef } from '../core/types';

/**
 * Unit roster. OWNER: architect (Phase 1) → balance pass (Phase 3). Systems read effective values from
 * entity.stats (upgrade-modified), never mutate these objects.
 */
const HOSPITAL_BUILDS = [
  'hosp_hq', 'hosp_ward', 'hosp_generator', 'hosp_pharmacy', 'hosp_lab', 'hosp_vehicle_bay', 'hosp_uv_turret', 'hosp_barricade',
];
const PATHOGEN_BUILDS = [
  'path_hive', 'path_nest', 'path_fermenter', 'path_replicator', 'path_mutation_pit', 'path_biofilm_spire', 'path_toxin_spitter',
];

export const UNITS: UnitDef[] = [
  // ─────────────── HOSPITAL DEFENSE CORPS ───────────────
  {
    kind: 'unit', id: 'hosp_orderly', name: 'Orderly Bot', faction: 'hospital',
    role: 'Worker — gathers Supplies, constructs and repairs',
    description: 'A tireless logistics robot from the hospital basement. Hauls supply crates, raises field structures and patches up damaged machines.',
    cost: { matter: 50 }, buildTime: 12, pop: 1, hp: 45, armor: 0, speed: 2.9, radius: 0.38, sight: 7,
    tags: ['ground', 'mech', 'light', 'worker'],
    weapons: [{ name: 'Shock Probe', damage: 5, damageType: 'normal', range: 0.25, cooldown: 1.5, targets: ['ground'], vfx: 'zap' }],
    abilities: [], requires: [], hotkey: 'O',
    gather: { capacity: 5, gatherTime: 2.2 }, builds: HOSPITAL_BUILDS,
  },
  {
    kind: 'unit', id: 'hosp_sanitizer', name: 'Sanitizer', faction: 'hospital',
    role: 'Infantry — rapid-fire disinfectant spray',
    description: 'Hazmat-suited staff armed with pressurised disinfectant sprayers. Cheap, quick to train, effective in numbers.',
    cost: { matter: 50 }, buildTime: 18, pop: 1, hp: 55, armor: 0, speed: 2.7, radius: 0.4, sight: 9,
    tags: ['ground', 'bio', 'light'],
    weapons: [{ name: 'Disinfectant Spray', damage: 6, damageType: 'normal', range: 4.5, cooldown: 0.8, targets: ['ground', 'air'], vfx: 'spray' }],
    abilities: [], requires: [], hotkey: 'S',
  },
  {
    kind: 'unit', id: 'hosp_medic', name: 'Field Medic', faction: 'hospital',
    role: 'Support — heals nearby friendly units',
    description: 'Emergency-ward veterans who keep the line standing. Automatically treats wounded friendly units (biological and mechanical) in range.',
    cost: { matter: 75, energy: 25 }, buildTime: 22, pop: 1, hp: 60, armor: 1, speed: 2.7, radius: 0.4, sight: 9,
    tags: ['ground', 'bio', 'light', 'healer'],
    weapons: [], abilities: [], requires: [], hotkey: 'M',
    heal: { rate: 10, range: 4 },
  },
  {
    kind: 'unit', id: 'hosp_uv_lancer', name: 'UV Lancer', faction: 'hospital',
    role: 'Specialist — ultraviolet beam, devastating against viruses',
    description: 'Carries a backpack UV-C emitter that shreds viral capsids. Can unleash a UV Flare that sterilises an area.',
    cost: { matter: 100, energy: 50 }, buildTime: 25, pop: 2, hp: 95, armor: 1, speed: 2.5, radius: 0.45, sight: 10,
    tags: ['ground', 'bio'],
    weapons: [{ name: 'UV-C Beam', damage: 11, damageType: 'uv', range: 6, cooldown: 1.4, targets: ['ground', 'air'], vfx: 'uv_beam', bonus: { viral: 10 }, windup: 0.15 }],
    abilities: ['uv_flare'], requires: ['hosp_lab'], hotkey: 'U',
  },
  {
    kind: 'unit', id: 'hosp_antibiotic_launcher', name: 'Antibiotic Launcher', faction: 'hospital',
    role: 'Artillery — long-range antibiotic shells, splash damage vs bacteria',
    description: 'A converted pharmacy truck that lobs concentrated antibiotic capsules over obstacles. Cannot fire at point-blank range.',
    cost: { matter: 150, energy: 100 }, buildTime: 35, pop: 3, hp: 150, armor: 1, speed: 2.1, radius: 0.8, sight: 11,
    tags: ['ground', 'mech', 'armored'],
    weapons: [{ name: 'Antibiotic Shell', damage: 28, damageType: 'antibiotic', range: 10, minRange: 2.5, cooldown: 3, targets: ['ground'], vfx: 'antibiotic_capsule', projectileSpeed: 9, arc: true, splashRadius: 1.8, bonus: { bacterial: 18 }, windup: 0.3 }],
    abilities: [], requires: ['hosp_vehicle_bay'], hotkey: 'L',
  },
  {
    kind: 'unit', id: 'hosp_macrophage', name: 'Macrophage Mech', faction: 'hospital',
    role: 'Heavy assault walker — engulfs and digests pathogens',
    description: 'Inspired by the immune system\'s big eaters: a heavily armoured walker that grabs pathogens with pseudopod arms and dissolves them.',
    cost: { matter: 250, energy: 150 }, buildTime: 45, pop: 4, hp: 480, armor: 3, speed: 2.0, radius: 1.0, sight: 9,
    tags: ['ground', 'mech', 'armored', 'massive'],
    weapons: [{ name: 'Engulf', damage: 32, damageType: 'melee', range: 0.6, cooldown: 1.4, targets: ['ground'], vfx: 'engulf', bonus: { armored: 12 }, windup: 0.25 }],
    abilities: [], requires: ['hosp_vehicle_bay', 'hosp_lab'], hotkey: 'M', modelScale: 1,
  },
  {
    kind: 'unit', id: 'hosp_sterilizer_drone', name: 'Sterilizer Drone', faction: 'hospital',
    role: 'Air support — fast drone with sterilising lasers, hunts airborne pathogens',
    description: 'A quad-rotor drone fitted with a UV laser. Flies over buildings and water; strong against air units.',
    cost: { matter: 125, energy: 75 }, buildTime: 30, pop: 2, hp: 120, armor: 0, speed: 4.2, radius: 0.6, sight: 11,
    tags: ['air', 'mech', 'light'],
    weapons: [{ name: 'Sterilising Laser', damage: 9, damageType: 'uv', range: 5.5, cooldown: 0.9, targets: ['ground', 'air'], vfx: 'laser', projectileSpeed: 22, bonus: { air: 7 } }],
    abilities: [], requires: ['hosp_vehicle_bay'], hotkey: 'D', flyHeight: 3.2,
  },

  // ─────────────── THE CONTAGION ───────────────
  {
    kind: 'unit', id: 'path_spore_drone', name: 'Spore Drone', faction: 'pathogen',
    role: 'Worker — harvests Biomass and grows structures',
    description: 'A drifting fungal spore that digests organic stockpiles into Biomass and secretes new colony structures.',
    cost: { matter: 50 }, buildTime: 12, pop: 1, hp: 40, armor: 0, speed: 2.9, radius: 0.38, sight: 7,
    tags: ['ground', 'bio', 'light', 'worker', 'fungal'],
    weapons: [{ name: 'Spore Prick', damage: 5, damageType: 'melee', range: 0.25, cooldown: 1.5, targets: ['ground'], vfx: 'bite' }],
    abilities: [], requires: [], hotkey: 'D', hpRegen: 0.3,
    gather: { capacity: 5, gatherTime: 2.2 }, builds: PATHOGEN_BUILDS,
  },
  {
    kind: 'unit', id: 'path_phage', name: 'Phage', faction: 'pathogen',
    role: 'Swarm melee — fast and cheap, bursts on death',
    description: 'A bacteriophage-like virus on spindly legs that rushes targets and injects corrosive payloads. Bursts in a toxic spray when destroyed.',
    cost: { matter: 35 }, buildTime: 12, pop: 1, hp: 38, armor: 0, speed: 3.7, radius: 0.32, sight: 8,
    tags: ['ground', 'bio', 'light', 'viral'],
    weapons: [{ name: 'Injector Stab', damage: 5, damageType: 'melee', range: 0.25, cooldown: 0.6, targets: ['ground'], vfx: 'bite' }],
    abilities: ['viral_burst'], requires: [], hotkey: 'P', hpRegen: 0.4,
  },
  {
    kind: 'unit', id: 'path_bacillus', name: 'Bacillus Brute', faction: 'pathogen',
    role: 'Line infantry — tough, spits corrosive acid (bonus vs machines)',
    description: 'A rod-shaped bacterium the size of a car. Slow but resilient; its acid eats through robot plating.',
    cost: { matter: 75 }, buildTime: 20, pop: 2, hp: 145, armor: 1, speed: 2.3, radius: 0.55, sight: 8,
    tags: ['ground', 'bio', 'armored', 'bacterial'],
    weapons: [{ name: 'Acid Spit', damage: 10, damageType: 'acid', range: 4.5, cooldown: 1.25, targets: ['ground', 'air'], vfx: 'acid_spit', projectileSpeed: 11, bonus: { mech: 5 }, windup: 0.2 }],
    abilities: [], requires: [], hotkey: 'B', hpRegen: 0.6,
  },
  {
    kind: 'unit', id: 'path_spirochete', name: 'Spirochete Lasher', faction: 'pathogen',
    role: 'Fast melee raider — whips light units apart',
    description: 'A corkscrew-shaped bacterium that drills through crowds at high speed. Excellent against light infantry and workers.',
    cost: { matter: 75, energy: 25 }, buildTime: 20, pop: 2, hp: 95, armor: 0, speed: 3.5, radius: 0.42, sight: 8,
    tags: ['ground', 'bio', 'light', 'bacterial'],
    weapons: [{ name: 'Corkscrew Lash', damage: 9, damageType: 'melee', range: 0.7, cooldown: 0.8, targets: ['ground'], vfx: 'whip', bonus: { light: 6 } }],
    abilities: [], requires: ['path_mutation_pit'], hotkey: 'S', hpRegen: 0.5,
  },
  {
    kind: 'unit', id: 'path_fungal_mortar', name: 'Fungal Mortar', faction: 'pathogen',
    role: 'Siege — lobs spore clusters, bonus vs structures',
    description: 'A lumbering fungal growth that hurls explosive spore pods across the battlefield. Deadly to buildings, helpless up close.',
    cost: { matter: 150, energy: 100 }, buildTime: 35, pop: 3, hp: 125, armor: 0, speed: 1.8, radius: 0.75, sight: 11,
    tags: ['ground', 'bio', 'armored', 'fungal'],
    weapons: [{ name: 'Spore Barrage', damage: 24, damageType: 'toxin', range: 10, minRange: 2.5, cooldown: 3.2, targets: ['ground'], vfx: 'spore_lob', projectileSpeed: 8, arc: true, splashRadius: 2, bonus: { structure: 14 }, windup: 0.35 }],
    abilities: [], requires: ['path_biofilm_spire'], hotkey: 'F', hpRegen: 0.5,
  },
  {
    kind: 'unit', id: 'path_superbug', name: 'Superbug', faction: 'pathogen',
    role: 'Elite brute — massive, regenerates, resists antibiotics',
    description: 'A multi-drug-resistant monstrosity. Shrugs off antibiotics, regenerates quickly and flattens anything in front of it.',
    cost: { matter: 275, energy: 150 }, buildTime: 45, pop: 4, hp: 520, armor: 2, speed: 1.9, radius: 1.05, sight: 9,
    tags: ['ground', 'bio', 'armored', 'massive', 'bacterial'],
    weapons: [{ name: 'Crushing Slam', damage: 30, damageType: 'melee', range: 0.7, cooldown: 1.5, targets: ['ground'], vfx: 'slam', splashRadius: 1.2, windup: 0.3 }],
    abilities: [], requires: ['path_biofilm_spire', 'path_mutation_pit'], hotkey: 'U', hpRegen: 2, resist: { antibiotic: 0.5 },
  },
  {
    kind: 'unit', id: 'path_flu_drifter', name: 'Influenza Drifter', faction: 'pathogen',
    role: 'Air — floating virus cloud, attacks air and ground',
    description: 'An airborne viral cloud that drifts over walls and water, raining toxin bolts on anything below.',
    cost: { matter: 125, energy: 75 }, buildTime: 30, pop: 2, hp: 115, armor: 0, speed: 3.3, radius: 0.6, sight: 10,
    tags: ['air', 'bio', 'light', 'viral'],
    weapons: [{ name: 'Toxin Bolt', damage: 10, damageType: 'toxin', range: 5, cooldown: 1.0, targets: ['ground', 'air'], vfx: 'toxin_bolt', projectileSpeed: 14 }],
    abilities: [], requires: ['path_biofilm_spire'], hotkey: 'I', flyHeight: 3.0, hpRegen: 0.5,
  },
  {
    kind: 'unit', id: 'path_strain_omega', name: 'Strain Omega', faction: 'pathogen',
    role: 'BOSS — the mutating patient-zero super-strain',
    description: 'The source of the outbreak: a colossal, constantly mutating viral colony. Spawns Phages, regenerates rapidly and resists UV and antibiotics.',
    cost: {}, buildTime: 1, pop: 0, hp: 4500, armor: 3, speed: 1.5, radius: 2.0, sight: 12,
    tags: ['ground', 'bio', 'armored', 'massive', 'viral', 'hero'],
    weapons: [{ name: 'Plague Torrent', damage: 40, damageType: 'toxin', range: 6, cooldown: 2.2, targets: ['ground', 'air'], vfx: 'toxin_bolt', projectileSpeed: 10, splashRadius: 2.5, windup: 0.4 }],
    abilities: ['omega_spawn'], requires: [], hotkey: '', hpRegen: 6, resist: { uv: 0.6, antibiotic: 0.7 }, trainable: false, modelScale: 1,
  },
];
