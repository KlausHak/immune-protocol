/**
 * Command validation for lockstep batches. OWNER: net. Headless-safe.
 *
 * Every command that enters the networked simulation — the local player's AND the opponent's — passes through
 * sanitizeCommand() with the slot of the player who sent the batch. It rebuilds the command from whitelisted,
 * type-checked fields only and FORCES `playerId` to that slot, so a (buggy or malicious) client can only command
 * its own player: World.processCommand then rejects entities that player does not own. Because both clients run
 * the exact same function on the exact same JSON, they accept/reject identically (determinism is preserved).
 */
import type { Command, CommandType, PlayerId, TilePos, Vec2 } from '../core/types';

/** caps keep one batch from flooding the sim (a real player issues a handful per 100 ms turn) */
export const MAX_COMMANDS_PER_TURN = 64;
const MAX_UNITS = 256;
const MAX_ID_LEN = 64;
const MAX_COORD = 4096;

const UNIT_TARGET = new Set<CommandType>(['smart', 'move', 'attackMove', 'patrol']);
const UNIT_TARGET_ID = new Set<CommandType>(['attack', 'follow', 'gather', 'repair']);
const UNIT_PLAIN = new Set<CommandType>(['hold', 'stop', 'returnCargo']);

type Rec = Record<string, unknown>;

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2 ** 31;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LEN;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
function vec(v: unknown): Vec2 | null {
  if (!v || typeof v !== 'object') return null;
  const { x, y } = v as Rec;
  return isNum(x) && isNum(y) ? { x, y } : null;
}
function tile(v: unknown): TilePos | null {
  const p = vec(v);
  return p && Number.isInteger(p.x) && Number.isInteger(p.y) ? p : null;
}
function ids(v: unknown, max = MAX_UNITS): number[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > max || !v.every(isId)) return null;
  return [...v];
}

/** Returns a clean copy of `raw` issued by `playerId`, or null if it is malformed. */
export function sanitizeCommand(raw: unknown, playerId: PlayerId): Command | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Rec;
  const type = c.type as CommandType;
  if (typeof type !== 'string') return null;

  if (UNIT_TARGET.has(type) || UNIT_TARGET_ID.has(type) || UNIT_PLAIN.has(type) || type === 'build' || type === 'ability') {
    const unitIds = ids(c.unitIds);
    if (!unitIds) return null;
    const base: Rec = { type, playerId, unitIds };
    if (c.queue === true) base.queue = true;
    if (UNIT_TARGET.has(type)) {
      const target = vec(c.target);
      if (!target) return null;
      base.target = target;
      if (type === 'smart' && c.targetId !== undefined) { if (!isId(c.targetId)) return null; base.targetId = c.targetId; }
    } else if (UNIT_TARGET_ID.has(type)) {
      if (!isId(c.targetId)) return null;
      base.targetId = c.targetId;
    } else if (type === 'build') {
      const t = tile(c.tile);
      if (!isStr(c.defId) || !t) return null;
      base.defId = c.defId; base.tile = t;
    } else if (type === 'ability') {
      if (!isStr(c.abilityId)) return null;
      base.abilityId = c.abilityId;
      if (!optTarget(c, base)) return null;
    }
    return base as unknown as Command;
  }

  switch (type) {
    case 'train':
      return isId(c.buildingId) && isStr(c.defId) ? { type, playerId, buildingId: c.buildingId, defId: c.defId } : null;
    case 'cancelTrain': {
      if (!isId(c.buildingId)) return null;
      if (c.index === undefined) return { type, playerId, buildingId: c.buildingId };
      return Number.isInteger(c.index) && (c.index as number) >= 0 && (c.index as number) < 16
        ? { type, playerId, buildingId: c.buildingId, index: c.index as number } : null;
    }
    case 'research':
      return isId(c.buildingId) && isStr(c.upgradeId) ? { type, playerId, buildingId: c.buildingId, upgradeId: c.upgradeId } : null;
    case 'cancelResearch':
    case 'cancelConstruction':
      return isId(c.buildingId) ? { type, playerId, buildingId: c.buildingId } : null;
    case 'setRally': {
      const buildingIds = ids(c.buildingIds, 64);
      const target = vec(c.target);
      if (!buildingIds || !target) return null;
      const out: Rec = { type, playerId, buildingIds, target };
      if (c.targetId !== undefined) { if (!isId(c.targetId)) return null; out.targetId = c.targetId; }
      return out as unknown as Command;
    }
    case 'buildingAbility': {
      if (!isId(c.buildingId) || !isStr(c.abilityId)) return null;
      const out: Rec = { type, playerId, buildingId: c.buildingId, abilityId: c.abilityId };
      return optTarget(c, out) ? out as unknown as Command : null;
    }
    case 'surrender':
      return { type, playerId };
    default:
      return null;
  }
}

/** optional target / targetId (abilities); false if present but malformed */
function optTarget(c: Rec, out: Rec): boolean {
  if (c.target !== undefined) { const t = vec(c.target); if (!t) return false; out.target = t; }
  if (c.targetId !== undefined && c.targetId !== null) { if (!isId(c.targetId)) return false; out.targetId = c.targetId; }
  return true;
}

/** Sanitise a whole batch (drops malformed commands, truncates to MAX_COMMANDS_PER_TURN). */
export function sanitizeBatch(raw: unknown, playerId: PlayerId): { cmds: Command[]; rejected: number } {
  if (!Array.isArray(raw)) return { cmds: [], rejected: 1 };
  const cmds: Command[] = [];
  let rejected = Math.max(0, raw.length - MAX_COMMANDS_PER_TURN);
  for (const r of raw.slice(0, MAX_COMMANDS_PER_TURN)) {
    const c = sanitizeCommand(r, playerId);
    if (c) cmds.push(c); else rejected++;
  }
  return { cmds, rejected };
}
