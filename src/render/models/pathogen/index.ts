/**
 * [models-pathogen] OWNER: pathogen model artist. Procedural models for all pathogen units/buildings,
 * the Strain Omega boss and infection doodads. Keys = def ids / DoodadKind.
 */
import type { DoodadKind } from '../../../core/types';
import type { DoodadBuilder, ModelBuilder } from '../types';

export const PATHOGEN_MODELS: Record<string, ModelBuilder> = {};
export const INFECTION_DOODADS: Partial<Record<DoodadKind, DoodadBuilder>> = {};
