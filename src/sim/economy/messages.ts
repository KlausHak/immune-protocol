/**
 * [economy] Player-facing feedback texts (faction resource names from data/factions.ts) and the notEnough emitter.
 */
import { MAX_POP } from '../../config';
import type { NotEnoughKind, PlayerId } from '../../core/types';
import { NEUTRAL_PLAYER } from '../../core/types';
import { BUILDING_DEFS, FACTIONS, UNIT_DEFS, UPGRADE_DEFS, buildingsOfFaction } from '../../data';
import type { World } from '../World';

/** A failed check: the reason text plus the notEnough kind to report it with. */
export interface Failure { kind: NotEnoughKind; reason: string; /** may clear up by itself (e.g. an enemy unit standing on a site) */ transient?: boolean }
export type CheckResult = { ok: true } | ({ ok: false } & Failure);

export const OK: CheckResult = { ok: true };
export const fail = (kind: NotEnoughKind, reason: string, transient = false): CheckResult =>
  (transient ? { ok: false, kind, reason, transient } : { ok: false, kind, reason });

function factionOf(world: World, playerId: PlayerId) {
  const p = world.players.get(playerId);
  return FACTIONS[p?.faction ?? 'neutral'] ?? FACTIONS.neutral;
}

/** "Supplies" / "Biomass" (matter), "Power" / "Toxin" (energy). */
export function resourceName(world: World, playerId: PlayerId, kind: 'matter' | 'energy'): string {
  return factionOf(world, playerId).resourceNames[kind];
}

export function notEnoughResource(world: World, playerId: PlayerId, kind: 'matter' | 'energy'): string {
  return `Not enough ${resourceName(world, playerId, kind)}`;
}

/** Cheapest non-HQ building of the player's faction that provides population (Patient Ward / Spore Nest). */
function popBuildingName(world: World, playerId: PlayerId): string | null {
  const p = world.players.get(playerId);
  if (!p) return null;
  const options = buildingsOfFaction(p.faction).filter((b) => !b.hq && (b.provides.pop ?? 0) > 0 && b.buildable !== false);
  options.sort((a, b) => (a.cost.matter ?? 0) - (b.cost.matter ?? 0));
  return options[0]?.name ?? null;
}

/** "Not enough Beds — build a Patient Ward" (or "Beds limit reached (150)" at the global cap). */
export function notEnoughPop(world: World, playerId: PlayerId): string {
  const f = factionOf(world, playerId);
  const p = world.players.get(playerId);
  if (p && p.popCap >= MAX_POP) return `${f.popName} limit reached (${MAX_POP})`;
  const b = popBuildingName(world, playerId);
  return b ? `Not enough ${f.popName} — build a ${b}` : `Not enough ${f.popName}`;
}

/** Display name of a requirement id (building / upgrade / unit). */
export function requirementName(id: string): string {
  return BUILDING_DEFS[id]?.name ?? UPGRADE_DEFS[id]?.name ?? UNIT_DEFS[id]?.name ?? id;
}

/** "Requires Research Lab" / "Requires Ambulance Depot and Research Lab". */
export function requiresMessage(missing: string[]): string {
  const names = missing.map(requirementName);
  if (names.length <= 1) return `Requires ${names[0] ?? 'more technology'}`;
  return `Requires ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Emit player feedback (UI toast + audio). Neutral / unknown players are ignored. */
export function notify(world: World, playerId: PlayerId, kind: NotEnoughKind, message: string): void {
  if (playerId === NEUTRAL_PLAYER || !world.players.has(playerId)) return;
  world.events.emit('notEnough', { playerId, kind, message });
}

export function notifyFailure(world: World, playerId: PlayerId, f: Failure): void {
  notify(world, playerId, f.kind, f.reason);
}
