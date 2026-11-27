/**
 * [render-core] Feedback colours (sRGB hex). Selection/hover relation colours, command marker colours and
 * health bar colours live here so the HUD can match them (e.g. minimap dots, portraits).
 */
import type { PlayerId } from '../../core/types';
import { NEUTRAL_PLAYER } from '../../core/types';
import type { World } from '../../sim/World';

export type Relation = 'own' | 'ally' | 'enemy' | 'neutral';

export const RELATION_COLORS: Readonly<Record<Relation, number>> = {
  own: 0x3dffa8,     // teal-green
  ally: 0xffd84a,    // yellow
  enemy: 0xff4646,   // red
  neutral: 0xf2f4f5, // white
};

export const MARKER_COLORS = {
  move: 0x46ff8c,
  attack: 0xff3b3b,
  rally: 0xffd23f,
  gather: 0xffc233,
  build: 0x3fe6ff,
  patrol: 0x63b6ff,
  repair: 0x7dffd2,
} as const;

export const BAR_COLORS = {
  high: 0x48e35a,
  mid: 0xffd23a,
  low: 0xff3a2e,
  construction: 0x5fe3ff,
  production: 0xffc43d,
  research: 0xb98cff,
  resource: 0xffc94a,
  cargo: 0xffc233,
  trail: 0xfff1e0,
} as const;

export const PLACEMENT_COLORS = { valid: 0x3dff8a, invalid: 0xff3d3d, range: 0xe8f6ff } as const;

/** Relation of `owner` as seen by `local`. Never throws for unknown players. */
export function relationOf(world: World, local: PlayerId, owner: PlayerId): Relation {
  if (owner === local) return 'own';
  if (owner === NEUTRAL_PLAYER || !world.players.has(owner) || !world.players.has(local)) return 'neutral';
  if (world.isEnemy(local, owner)) return 'enemy';
  if (world.isAlly(local, owner)) return 'ally';
  return 'neutral';
}
