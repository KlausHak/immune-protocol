/**
 * [map] OWNER: map agent. Map registry. getMap(id) returns a FRESH MapData each call.
 * Required ids: 'test' (tests; keep stable) and 'meilahti' (the HUS campus campaign/skirmish map).
 */
import type { MapData } from '../core/types';
import { createTestMap } from './testMap';

export interface MapInfo { id: string; name: string; description: string; players: number; skirmish: boolean; build: () => MapData }

export const MAPS: MapInfo[] = [
  { id: 'test', name: 'Test Grounds', description: 'Flat proving ground.', players: 2, skirmish: true, build: createTestMap },
];

export function getMap(id: string): MapData {
  const m = MAPS.find((x) => x.id === id) ?? MAPS.find((x) => x.id === 'meilahti') ?? MAPS[0]!;
  return m.build();
}
export const listMaps = (): MapInfo[] => MAPS;
export const DEFAULT_MAP_ID = (): string => (MAPS.some((m) => m.id === 'meilahti') ? 'meilahti' : 'test');
export { createTestMap };
