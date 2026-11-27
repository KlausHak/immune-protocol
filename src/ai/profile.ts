/**
 * [ai] Difficulty profiles. Difficulty never bends the rules: it changes how quickly and how well the
 * AI plays (think rate, command budget, reaction time, micro, planning slips) plus the one sanctioned
 * economic bonus, PlayerState.gatherMul.
 */
import type { Difficulty } from '../core/types';
import type { Personality } from './personality';

export interface DifficultyProfile {
  id: Difficulty;
  /** Gather multiplier applied to the AI player (the only resource bonus). */
  gatherMul: number;
  /** Strategic think period (macro spending, army control), seconds. */
  thinkSec: number;
  /** Tactical period (threat scan / defence), seconds — also the base think cadence (other periods are multiples). */
  tacticSec: number;
  /** Worker-management period: idle workers wait up to this long. */
  workerSec: number;
  /** Command budget in commands per second (bursts up to 2 s worth). */
  apm: number;
  /** A threat must persist this long before the AI reacts. */
  reactionSec: number;
  /** Chance to fumble a decision (random wave target, ...). */
  mistakeRate: number;
  /** May "forget" supply for a few seconds (easy). */
  supplySlips: boolean;
  workersPerCache: number;
  maxWorkers: number;
  maxBases: number;
  /** Multiplier on the computed supply lead buffer. */
  supplyBuffer: number;
  /** >1 = slower build-order clock. */
  planTimeMul: number;
  expandTimeMul: number;
  waveTimeMul: number;
  waveSizeMul: number;
  waveIntervalSec: number;
  /** Retreat when local strength (mine / theirs) falls below this. */
  retreatRatio: number;
  focusFire: boolean;
  kiteMortars: boolean;
  pullHurt: boolean;
  /** Recall an attacking squad when the home base is in trouble. */
  recallSquad: boolean;
  /** Pull workers to fight in emergencies. */
  militia: boolean;
  /** Cancel doomed foundations (75% refund). */
  cancelDoomed: boolean;
  spittersMain: number;
  spittersExpansion: number;
  /** Seconds between re-scouting trips (0 = never). */
  rescoutSec: number;
  maxUpgrades: number;
  /** Minimum reinforcement group (1 = trickle units in one by one). */
  reinforceMin: number;
  /** Weigh targets by defences/value instead of just distance. */
  smartTargets: boolean;
  /** Hold a wave while a clearly bigger enemy army has been seen recently. */
  respectEnemyArmy: boolean;
  personalityWeights: Record<Personality, number>;
}

export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  easy: {
    id: 'easy', gatherMul: 0.8,
    thinkSec: 1.0, tacticSec: 0.5, workerSec: 3, apm: 2, reactionSec: 3, mistakeRate: 0.25, supplySlips: true,
    workersPerCache: 1.6, maxWorkers: 22, maxBases: 2, supplyBuffer: 0.5,
    planTimeMul: 1.3, expandTimeMul: 1.6, waveTimeMul: 1.4, waveSizeMul: 0.6, waveIntervalSec: 150,
    retreatRatio: 0.25, focusFire: false, kiteMortars: false, pullHurt: false, recallSquad: false, militia: false, cancelDoomed: false,
    spittersMain: 0, spittersExpansion: 0, rescoutSec: 0, maxUpgrades: 2, reinforceMin: 1, smartTargets: false, respectEnemyArmy: false,
    personalityWeights: { swarm: 0.45, balanced: 0.45, tech: 0.1 },
  },
  normal: {
    id: 'normal', gatherMul: 1.0,
    thinkSec: 0.5, tacticSec: 0.25, workerSec: 1, apm: 5, reactionSec: 1.2, mistakeRate: 0.04, supplySlips: false,
    workersPerCache: 2.0, maxWorkers: 40, maxBases: 3, supplyBuffer: 1.0,
    planTimeMul: 1.0, expandTimeMul: 1.0, waveTimeMul: 1.0, waveSizeMul: 1.0, waveIntervalSec: 100,
    retreatRatio: 0.55, focusFire: true, kiteMortars: true, pullHurt: true, recallSquad: true, militia: true, cancelDoomed: true,
    spittersMain: 1, spittersExpansion: 1, rescoutSec: 150, maxUpgrades: 6, reinforceMin: 6, smartTargets: true, respectEnemyArmy: false,
    personalityWeights: { swarm: 0.3, balanced: 0.45, tech: 0.25 },
  },
  hard: {
    id: 'hard', gatherMul: 1.2,
    thinkSec: 0.4, tacticSec: 0.2, workerSec: 0.8, apm: 8, reactionSec: 0.6, mistakeRate: 0, supplySlips: false,
    workersPerCache: 2.2, maxWorkers: 50, maxBases: 4, supplyBuffer: 1.15,
    planTimeMul: 0.92, expandTimeMul: 0.9, waveTimeMul: 0.85, waveSizeMul: 1.2, waveIntervalSec: 85,
    retreatRatio: 0.65, focusFire: true, kiteMortars: true, pullHurt: true, recallSquad: true, militia: true, cancelDoomed: true,
    spittersMain: 2, spittersExpansion: 1, rescoutSec: 110, maxUpgrades: 9, reinforceMin: 5, smartTargets: true, respectEnemyArmy: true,
    personalityWeights: { swarm: 0.3, balanced: 0.35, tech: 0.35 },
  },
  brutal: {
    id: 'brutal', gatherMul: 1.5,
    thinkSec: 0.3, tacticSec: 0.15, workerSec: 0.6, apm: 12, reactionSec: 0.3, mistakeRate: 0, supplySlips: false,
    workersPerCache: 2.3, maxWorkers: 60, maxBases: 5, supplyBuffer: 1.25,
    planTimeMul: 0.88, expandTimeMul: 0.8, waveTimeMul: 0.75, waveSizeMul: 1.35, waveIntervalSec: 70,
    retreatRatio: 0.7, focusFire: true, kiteMortars: true, pullHurt: true, recallSquad: true, militia: true, cancelDoomed: true,
    spittersMain: 2, spittersExpansion: 2, rescoutSec: 90, maxUpgrades: 9, reinforceMin: 5, smartTargets: true, respectEnemyArmy: true,
    personalityWeights: { swarm: 0.35, balanced: 0.3, tech: 0.35 },
  },
};

export function profileFor(d: Difficulty): DifficultyProfile {
  return DIFFICULTY_PROFILES[d] ?? DIFFICULTY_PROFILES.normal;
}
