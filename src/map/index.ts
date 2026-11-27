/**
 * [map] OWNER: map agent. Map registry. getMap(id) returns a FRESH MapData each call.
 * Required ids: 'test' (tests; keep stable) and 'meilahti' (the HUS campus campaign/skirmish map).
 */
import type { MapData } from '../core/types';
import type { MapBuilder } from './builder';
import { buildMeilahti, createMeilahtiMap, MEILAHTI_DESCRIPTION } from './meilahti';
import { createTestMap } from './testMap';

export interface MapInfo {
  id: string;
  name: string;
  description: string;
  players: number;
  skirmish: boolean;
  build: () => MapData;
  /** [map] optional: the MapBuilder behind build() — used by validation tests and the sandbox debug view */
  builder?: () => MapBuilder;
}

export const MAPS: MapInfo[] = [
  { id: 'meilahti', name: 'HUS Meilahti Campus', description: MEILAHTI_DESCRIPTION, players: 2, skirmish: true, build: createMeilahtiMap, builder: buildMeilahti },
  { id: 'test', name: 'Test Grounds', description: 'Flat proving ground.', players: 2, skirmish: true, build: createTestMap },
];

export function getMap(id: string): MapData {
  const m = MAPS.find((x) => x.id === id) ?? MAPS.find((x) => x.id === 'meilahti') ?? MAPS[0]!;
  return m.build();
}
export const listMaps = (): MapInfo[] => MAPS;
export const DEFAULT_MAP_ID = (): string => (MAPS.some((m) => m.id === 'meilahti') ? 'meilahti' : 'test');
export { createTestMap, createMeilahtiMap };
