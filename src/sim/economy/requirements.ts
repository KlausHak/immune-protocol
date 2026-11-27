/**
 * [economy] Tech requirements: building ids need a COMPLETED building of that type, upgrade ids a finished
 * research (unit ids, if ever used, need an alive unit).
 */
import type { PlayerId } from '../../core/types';
import { UPGRADE_DEFS } from '../../data';
import type { World } from '../World';

/** Def ids of the player's completed buildings and alive units. */
export function ownedDefIds(world: World, playerId: PlayerId): Set<string> {
  const out = new Set<string>();
  for (const e of world.list) {
    if (e.alive && e.owner === playerId && e.kind !== 'resource' && !e.construction) out.add(e.defId);
  }
  return out;
}

export function missingRequirements(world: World, playerId: PlayerId, requires: readonly string[] | undefined): string[] {
  if (!requires || requires.length === 0) return [];
  const p = world.players.get(playerId);
  if (!p) return [...requires];
  let owned: Set<string> | null = null;
  const out: string[] = [];
  for (const id of requires) {
    if (UPGRADE_DEFS[id]) { if (!p.upgrades.has(id)) out.push(id); continue; }
    owned ??= ownedDefIds(world, playerId);
    if (!owned.has(id)) out.push(id);
  }
  return out;
}

export const meetsRequirements = (world: World, playerId: PlayerId, requires: readonly string[] | undefined): boolean =>
  missingRequirements(world, playerId, requires).length === 0;
