/**
 * [economy] The 'economy' system (tick order 50): construction & production progress, population, energy income,
 * research bookkeeping, cache-occupancy validation and income sampling for incomeRate().
 */
import type { BuildingDef, PlayerId } from '../../core/types';
import type { World } from '../World';
import { INCOME_HISTORY } from './constants';
import { updateConstruction } from './construction';
import { occupantOf } from './gather';
import { updateProduction } from './production';
import { recomputePopulation } from './service';
import { getRuntime } from './state';

/** Energy income, and `researching` kept equal to the upgrades queued in alive buildings (destroyed labs drop theirs). */
function updatePlayers(world: World, dt: number): void {
  const income = new Map<PlayerId, number>();
  const queued = new Map<PlayerId, Set<string>>();
  for (const e of world.list) {
    if (!e.alive || e.kind !== 'building') continue;
    if (!e.construction) {
      const eps = (e.def as BuildingDef).provides.energyPerSec ?? 0;
      if (eps > 0) income.set(e.owner, (income.get(e.owner) ?? 0) + eps);
    }
    const q = e.production?.queue;
    if (q) for (const it of q) {
      if (it.kind !== 'upgrade') continue;
      let s = queued.get(e.owner);
      if (!s) { s = new Set(); queued.set(e.owner, s); }
      s.add(it.defId);
    }
  }
  const rt = getRuntime(world);
  if (rt) rt.energyPerSec = income;
  for (const p of world.activePlayers()) {
    const inc = income.get(p.id) ?? 0;
    if (inc > 0) { p.resources.energy += inc * dt; p.stats.energyGenerated += inc * dt; }
    const live = queued.get(p.id);
    if (p.researching.size) for (const id of [...p.researching]) if (!live?.has(id)) p.researching.delete(id);
    if (live) for (const id of live) p.researching.add(id);
  }
}

function validateNodes(world: World): void {
  for (const e of world.list) if (e.alive && e.kind === 'resource' && e.resource) occupantOf(world, e);
}

function sampleIncome(world: World): void {
  const rt = getRuntime(world);
  if (!rt || world.time + 1e-9 < rt.nextSampleAt) return;
  rt.nextSampleAt = world.time + 1;
  for (const p of world.activePlayers()) {
    let s = rt.samples.get(p.id);
    if (!s) { s = { t: [], matter: [], energy: [] }; rt.samples.set(p.id, s); }
    s.t.push(world.time); s.matter.push(p.stats.matterGathered); s.energy.push(p.stats.energyGenerated);
    if (s.t.length > INCOME_HISTORY + 1) { s.t.shift(); s.matter.shift(); s.energy.shift(); }
  }
}

export function economySystem(world: World, dt: number): void {
  updateConstruction(world, dt);
  updateProduction(world, dt);
  recomputePopulation(world);
  updatePlayers(world, dt);
  validateNodes(world);
  sampleIncome(world);
}
