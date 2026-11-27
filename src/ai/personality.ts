/**
 * [ai] Strategic personalities of The Contagion. One is picked per match (seeded through world.rng,
 * weighted by difficulty) and shapes the default build order, army mix, expansion timing and the
 * first-wave timing. Adaptive counter-play against what the AI has SEEN of the enemy is layered on
 * top in composition.ts, so a personality only describes the "plan A".
 *
 * All times are on the *plan clock* (game seconds divided by the difficulty's planTimeMul).
 */
import type { Rng } from '../core/rng';

export type Personality = 'swarm' | 'balanced' | 'tech';
export const PERSONALITIES: readonly Personality[] = ['swarm', 'balanced', 'tech'];

// Pathogen roster ids used by the AI (single place to touch if data ids change).
export const HIVE = 'path_hive';
export const NEST = 'path_nest';
export const VAT = 'path_fermenter';
export const REPLICATOR = 'path_replicator';
export const PIT = 'path_mutation_pit';
export const SPIRE = 'path_biofilm_spire';
export const SPITTER = 'path_toxin_spitter';
export const DRONE = 'path_spore_drone';
export const PHAGE = 'path_phage';
export const BACILLUS = 'path_bacillus';
export const SPIROCHETE = 'path_spirochete';
export const MORTAR = 'path_fungal_mortar';
export const SUPERBUG = 'path_superbug';
export const DRIFTER = 'path_flu_drifter';
export const ARMY_UNITS = [PHAGE, BACILLUS, SPIROCHETE, MORTAR, SUPERBUG, DRIFTER] as const;
export const UP_METABOLISM = 'up_path_metabolism';

/** Read-only view of the AI's own state handed to personality plans. */
export interface PlanState {
  /** plan clock, seconds */
  t: number;
  pop: number;
  workers: number;
  /** completed hives */
  bases: number;
  /** completed buildings of a type */
  done(id: string): number;
  /** completed + under construction + ordered */
  started(id: string): number;
}

export interface WaveSpec {
  /** earliest launch (plan seconds, scaled by difficulty) */
  earliest: number;
  /** launch with ~60% of the wanted size after this */
  latest: number;
  minSize: number;
  maxSize: number;
  /** minimum army value (matter + toxin) */
  minValue: number;
}

export interface PersonalityDef {
  id: Personality;
  firstWave: WaveSpec;
  /** default timing of the first expansion (plan seconds) */
  expandAt: number;
  scoutUnit: 'drone' | 'phage';
  scoutAt: number;
  /** Target counts of replicators / mutation pit / spire / vats (nests, spitters and hives are managed elsewhere). */
  plan(s: PlanState): Record<string, number>;
  /** Default army composition as pop-share weights (unavailable units are fine — they create tech demand). */
  mix(s: PlanState): Record<string, number>;
  /** research preference (the Core's Hypermetabolism is handled by the economy). */
  upgrades: string[];
}

const step = (cond: boolean, n: number, cur: number): number => (cond ? Math.max(cur, n) : cur);

/** Early phage pressure: double pod, fast first wave, flagella first, late tech. */
const swarm: PersonalityDef = {
  id: 'swarm',
  firstWave: { earliest: 240, latest: 300, minSize: 12, maxSize: 16, minValue: 0 },
  expandAt: 390,
  scoutUnit: 'phage',
  scoutAt: 70,
  plan(s): Record<string, number> {
    let rep = step(s.pop >= 9 || s.t >= 65, 1, 0);
    rep = step(rep >= 1 && (s.done(REPLICATOR) >= 1 || s.t >= 140), 2, rep);
    rep = step(s.t >= 360 || s.bases >= 2, 3, rep);
    rep = step(s.t >= 600 && s.bases >= 2, 4, rep);
    let vat = step(s.started(REPLICATOR) >= 2, 1, 0);
    vat = step(s.t >= 270, 2, vat);
    vat = step(s.started(SPIRE) >= 1, 3, vat);
    vat = step(s.t >= 720, 4, vat);
    return {
      [REPLICATOR]: rep,
      [PIT]: s.t >= 220 && s.done(REPLICATOR) >= 1 ? 1 : 0,
      [SPIRE]: s.t >= 480 && s.done(PIT) >= 1 ? 1 : 0,
      [VAT]: vat,
    };
  },
  mix(s): Record<string, number> {
    if (s.done(SPIRE)) return { [PHAGE]: 0.4, [BACILLUS]: 0.15, [SPIROCHETE]: 0.25, [MORTAR]: 0.1, [DRIFTER]: 0.1 };
    if (s.done(PIT)) return { [PHAGE]: 0.5, [BACILLUS]: 0.2, [SPIROCHETE]: 0.3 };
    return { [PHAGE]: 0.7, [BACILLUS]: 0.3 };
  },
  upgrades: ['up_path_flagella', 'up_path_toxins_1', 'up_path_carapace_1', 'up_path_virulence', 'up_path_toxins_2', 'up_path_carapace_2', 'up_path_resistance'],
};

/** Standard play: one pod, pit at ~3:00, second pod, first push ~5:00–6:00, spire mid-game. */
const balanced: PersonalityDef = {
  id: 'balanced',
  firstWave: { earliest: 300, latest: 360, minSize: 10, maxSize: 14, minValue: 0 },
  expandAt: 330,
  scoutUnit: 'drone',
  scoutAt: 60,
  plan(s): Record<string, number> {
    let rep = step(s.pop >= 11 || s.t >= 80, 1, 0);
    rep = step(s.t >= 195, 2, rep);
    rep = step((s.bases >= 2 && s.t >= 420) || s.t >= 540, 3, rep);
    rep = step(s.t >= 720, 4, rep);
    let spire = step(s.done(PIT) >= 1 && s.t >= 360, 1, 0);
    spire = step(spire >= 1 && s.t >= 780, 2, spire);
    let vat = step(s.started(REPLICATOR) >= 1, 1, 0);
    vat = step(s.started(PIT) >= 1, 2, vat);
    vat = step(s.started(SPIRE) >= 1, 3, vat);
    vat = step(s.t >= 600, 4, vat);
    return { [REPLICATOR]: rep, [PIT]: s.done(REPLICATOR) >= 1 && s.t >= 165 ? 1 : 0, [SPIRE]: spire, [VAT]: vat };
  },
  mix(s): Record<string, number> {
    if (s.done(SPIRE)) return { [PHAGE]: 0.2, [BACILLUS]: 0.35, [SPIROCHETE]: 0.2, [MORTAR]: 0.12, [SUPERBUG]: 0.08, [DRIFTER]: 0.05 };
    if (s.done(PIT)) return { [PHAGE]: 0.3, [BACILLUS]: 0.45, [SPIROCHETE]: 0.25 };
    return { [PHAGE]: 0.4, [BACILLUS]: 0.6 };
  },
  upgrades: ['up_path_toxins_1', 'up_path_carapace_1', 'up_path_flagella', 'up_path_toxins_2', 'up_path_carapace_2', 'up_path_resistance', 'up_path_virulence'],
};

/** Fast tech: pit straight after the pod, spire by ~4:00, many vats; mortars, superbugs and drifters. */
const tech: PersonalityDef = {
  id: 'tech',
  firstWave: { earliest: 390, latest: 450, minSize: 8, maxSize: 11, minValue: 1100 },
  expandAt: 280,
  scoutUnit: 'drone',
  scoutAt: 55,
  plan(s): Record<string, number> {
    let rep = step(s.pop >= 11 || s.t >= 85, 1, 0);
    rep = step(s.t >= 330, 2, rep);
    rep = step(s.t >= 510, 3, rep);
    rep = step(s.t >= 780, 4, rep);
    let spire = step(s.done(PIT) >= 1, 1, 0);
    spire = step(spire >= 1 && s.t >= 600, 2, spire);
    let vat = step(s.started(REPLICATOR) >= 1, 1, 0);
    vat = step(s.t >= 110, 2, vat);
    vat = step(s.started(SPIRE) >= 1, 3, vat);
    vat = step(s.done(SPIRE) >= 1, 4, vat);
    vat = step(s.t >= 540, 5, vat);
    return { [REPLICATOR]: rep, [PIT]: s.done(REPLICATOR) >= 1 ? 1 : 0, [SPIRE]: spire, [VAT]: vat };
  },
  mix(s): Record<string, number> {
    if (s.done(SPIRE)) return { [BACILLUS]: 0.25, [PHAGE]: 0.05, [SPIROCHETE]: 0.05, [MORTAR]: 0.25, [SUPERBUG]: 0.25, [DRIFTER]: 0.15 };
    if (s.done(PIT)) return { [BACILLUS]: 0.65, [PHAGE]: 0.2, [SPIROCHETE]: 0.15 };
    return { [BACILLUS]: 0.7, [PHAGE]: 0.3 };
  },
  upgrades: ['up_path_carapace_1', 'up_path_toxins_1', 'up_path_resistance', 'up_path_carapace_2', 'up_path_toxins_2', 'up_path_virulence', 'up_path_flagella'],
};

export const PERSONALITY_DEFS: Record<Personality, PersonalityDef> = { swarm, balanced, tech };

export function pickPersonality(rng: Rng, weights: Record<Personality, number>): Personality {
  const total = PERSONALITIES.reduce((a, p) => a + Math.max(0, weights[p]), 0);
  let r = rng.next() * (total || 1);
  for (const p of PERSONALITIES) { r -= Math.max(0, weights[p]); if (r < 0) return p; }
  return 'balanced';
}
