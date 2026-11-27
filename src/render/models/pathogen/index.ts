/**
 * [models-pathogen] OWNER: pathogen model artist. Procedural models for all pathogen units/buildings,
 * the Strain Omega boss and infection doodads. Keys = def ids / DoodadKind.
 *
 *   shader.ts     shared organic material system (one onBeforeCompile'd MeshStandardMaterial family)
 *   geom.ts       procedural geometry toolkit + per-vertex paint
 *   rig.ts        model rig (root → base → body) + shared poses (death pop, construction growth, breathing)
 *   units.ts      the seven pathogen strains
 *   omega.ts      Strain Omega (boss)
 *   structures.ts the seven colony structures
 *   doodads.ts    infection props
 */
import type { DoodadKind } from '../../../core/types';
import type { DoodadBuilder, ModelBuilder } from '../types';
import { DOODAD_BUILDERS } from './doodads';
import { buildStrainOmega } from './omega';
import { STRUCTURE_MODELS } from './structures';
import { UNIT_MODELS } from './units';

export const PATHOGEN_MODELS: Record<string, ModelBuilder> = {
  ...UNIT_MODELS,
  ...STRUCTURE_MODELS,
  path_strain_omega: buildStrainOmega,
};
export const INFECTION_DOODADS: Partial<Record<DoodadKind, DoodadBuilder>> = { ...DOODAD_BUILDERS };
