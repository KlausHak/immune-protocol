/**
 * [models-hospital] OWNER: hospital model artist. Procedural models for all hospital units/buildings,
 * the Supply Cache resource node and campus doodads. Keys = def ids / DoodadKind.
 */
import type { DoodadKind } from '../../../core/types';
import type { DoodadBuilder, ModelBuilder } from '../types';

export const HOSPITAL_MODELS: Record<string, ModelBuilder> = {};
export const CAMPUS_DOODADS: Partial<Record<DoodadKind, DoodadBuilder>> = {};
