/**
 * [ai] Adaptive army composition. Starts from the personality's default mix and bends it toward
 * counters for what the AI has actually SEEN of the enemy:
 *   light infantry → Spirochete Lashers · mechs → Bacillus Brutes (acid bonus) · enemy air → anti-air
 *   (Bacillus, Drifters) · no enemy anti-air → Influenza Drifters · turrets/walls → Fungal Mortars ·
 *   UV → fewer viral strains · antibiotics → viral strains + Superbugs · late game → Superbugs.
 * Units whose requirements are missing turn into tech demand for the build planner.
 */
import type { UnitDef } from '../core/types';
import { UNIT_DEFS } from '../data';
import type { Brain } from './brain';
import { ARMY_UNITS, BACILLUS, DRIFTER, MORTAR, PHAGE, PIT, SPIRE, SPIROCHETE, SUPERBUG, type PlanState } from './personality';

export interface ArmyGoal {
  /** normalised pop-share weights over units we can build right now */
  weights: Map<string, number>;
  /** share of the wanted army that needs a Mutation Pit / Biofilm Spire we don't have */
  demandPit: number;
  demandSpire: number;
}

export function armyGoal(b: Brain, st: PlanState): ArmyGoal {
  const base = b.pers.mix(st);
  const w = new Map<string, number>();
  for (const id of ARMY_UNITS) w.set(id, base[id] ?? 0);
  const add = (id: string, v: number): void => { w.set(id, Math.max(0, (w.get(id) ?? 0) + v)); };
  const mul = (id: string, v: number): void => { w.set(id, (w.get(id) ?? 0) * v); };

  const intel = b.memory.intel();
  if (intel.seen >= 3 || intel.turrets > 0) {
    add(SPIROCHETE, 0.45 * intel.light);
    add(BACILLUS, 0.4 * intel.mech);
    if (intel.air > 0.15) {
      add(BACILLUS, 0.35 * intel.air);
      add(DRIFTER, 0.25 * intel.air);
      for (const id of [PHAGE, SPIROCHETE, SUPERBUG, MORTAR]) mul(id, 1 - 0.4 * intel.air);
    }
    if (intel.antiAir < 0.25 && st.t >= 240) add(DRIFTER, 0.22 * (1 - intel.antiAir / 0.25));
    const turtle = intel.turrets + intel.walls * 0.5;
    if (turtle >= 2) add(MORTAR, Math.min(0.35, 0.08 * turtle));
    if (intel.uv > 0.2) { mul(PHAGE, 0.6); mul(DRIFTER, 0.7); add(BACILLUS, 0.1); add(SUPERBUG, 0.08); }
    if (intel.antibiotic > 0.15) { mul(BACILLUS, 0.75); mul(SPIROCHETE, 0.8); add(PHAGE, 0.12); add(SUPERBUG, 0.15); add(DRIFTER, 0.08); }
  }
  if (st.t >= 600) add(SUPERBUG, 0.08);

  const weights = new Map<string, number>();
  let total = 0, demandPit = 0, demandSpire = 0, all = 0;
  for (const [id, v] of w) {
    if (v <= 0) continue;
    all += v;
    const def = UNIT_DEFS[id] as UnitDef | undefined;
    if (!def) continue;
    if (b.world.economy.meetsRequirements(b.me, def.requires)) { weights.set(id, v); total += v; continue; }
    if (def.requires.includes(SPIRE)) demandSpire += v;
    else if (def.requires.includes(PIT)) demandPit += v;
  }
  if (total <= 0) { weights.clear(); weights.set(PHAGE, 0.5); weights.set(BACILLUS, 0.5); total = 1; }
  for (const [id, v] of weights) weights.set(id, v / total);
  return { weights, demandPit: all > 0 ? demandPit / all : 0, demandSpire: all > 0 ? demandSpire / all : 0 };
}
