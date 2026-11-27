/**
 * [models-hospital] OWNER: hospital model artist. Procedural models for all hospital units/buildings,
 * the Supply Cache resource node and campus doodads. Keys = def ids / DoodadKind.
 *
 * Performance notes: geometry is built once per def × team colour (doodads: per kind × seed bucket) and
 * cached; every mesh shares one atlas MeshStandardMaterial (see kit.ts), so models are 1–6 draw calls
 * and doodads are a single mesh each (instancing-friendly). dispose() never frees shared resources.
 */
import type { DoodadKind } from '../../../core/types';
import type { DoodadBuilder, ModelBuilder } from '../types';
import { HOSPITAL_BUILDING_MODELS } from './buildings';
import { CAMPUS_DOODAD_BUILDERS } from './doodads';
import { HOSPITAL_UNIT_MODELS } from './units';

export const HOSPITAL_MODELS: Record<string, ModelBuilder> = {
  ...HOSPITAL_UNIT_MODELS,
  ...HOSPITAL_BUILDING_MODELS,
};
export const CAMPUS_DOODADS: Partial<Record<DoodadKind, DoodadBuilder>> = { ...CAMPUS_DOODAD_BUILDERS };
