/**
 * Save / load of a running match (headless-safe). OWNER: architect.
 *   captureMatch(...)  → SaveGame (JSON-serialisable)
 *   restoreMatch(...)  → applies a SaveGame to a FRESH world created with createWorld() for the same map/players
 * Plus stateProbe/stateHash/firstDifference used by the round-trip determinism tests.
 */
import type { Entity, PlayerState, Projectile } from '../../core/types';
import type { AiController } from '../../ai';
import type { MissionRunner } from '../../campaign';
import type { World } from '../World';
import { decode, encode } from './codec';
import { SAVE_VERSION, type SaveGame, type SaveLaunch, type SaveMeta, type WorldCoreState } from './types';

export * from './types';
export { encode, decode } from './codec';

interface WorldSnapshot {
  core: WorldCoreState;
  players: PlayerState[];
  entities: Array<Record<string, unknown>>;
  projectiles: Projectile[];
}

function entityFields(e: Entity): Record<string, unknown> {
  const { def: _def, tags: _tags, ...rest } = e as unknown as Record<string, unknown> & { def: unknown; tags: unknown };
  return rest;
}

export function captureWorld(world: World): WorldSnapshot {
  return {
    core: world.exportCore(),
    players: [...world.players.values()],
    entities: world.list.map(entityFields),
    projectiles: world.projectiles,
  };
}

/** Restore into a fresh world (same map & players, modules installed, nothing spawned). */
export function restoreWorld(world: World, snapshot: WorldSnapshot, modules: Record<string, unknown>): void {
  if (world.list.length) throw new Error('restoreWorld: world must be fresh (no entities)');
  world.restoring = true;
  try {
    for (const p of snapshot.players) {
      const cur = world.players.get(p.id);
      if (cur) Object.assign(cur, p); else world.players.set(p.id, p);
    }
    for (const fields of snapshot.entities) world.restoreEntity(fields);
    world.projectiles = snapshot.projectiles;
    world.importCore(snapshot.core);
    world.spatial.rebuild();
    for (const part of world.getSaveParticipants()) {
      if (part.key in modules) part.load(world, decode(modules[part.key]));
    }
    world.spatial.rebuild();
  } finally {
    world.restoring = false;
  }
}

export interface CaptureOptions {
  world: World;
  ais: AiController[];
  mission: MissionRunner | null;
  launch: SaveLaunch;
  meta: Omit<SaveMeta, 'version' | 'gameTime' | 'mode' | 'missionId' | 'mapId' | 'difficulty'>;
}

export function captureMatch(o: CaptureOptions): SaveGame {
  const { world } = o;
  const modules: Record<string, unknown> = {};
  for (const part of world.getSaveParticipants()) modules[part.key] = encode(part.save(world), `modules.${part.key}`);
  const ai: Record<string, unknown> = {};
  for (const a of o.ais) if (a.save) ai[String(a.playerId)] = encode(a.save(), `ai.${a.playerId}`);
  return {
    version: SAVE_VERSION,
    meta: {
      ...o.meta, version: SAVE_VERSION, gameTime: world.time, mode: o.launch.mode, missionId: o.launch.missionId,
      mapId: o.launch.mapId, difficulty: o.launch.difficulty,
    },
    launch: { ...o.launch },
    world: encode(captureWorld(world), 'world'),
    modules,
    ai,
    mission: o.mission?.save ? encode(o.mission.save(), 'mission') : null,
  };
}

/** Apply a save to a fresh world + freshly created AIs / mission (mission.restore replaces mission.setup). */
export function restoreMatch(save: SaveGame, world: World, ais: AiController[], mission: MissionRunner | null): void {
  if (save.version !== SAVE_VERSION) throw new Error(`Unsupported save version ${save.version} (expected ${SAVE_VERSION})`);
  restoreWorld(world, decode(save.world) as WorldSnapshot, save.modules);
  world.restoring = true;
  try {
    for (const a of ais) {
      const data = save.ai[String(a.playerId)];
      if (data !== undefined && a.load) a.load(decode(data));
    }
    if (mission) {
      if (!mission.restore) throw new Error(`Mission ${mission.info.id} does not support save/restore`);
      mission.restore(save.mission === null ? null : decode(save.mission));
    }
  } finally {
    world.restoring = false;
  }
}

// ───────────────────────── determinism probes (tests) ─────────────────────────
/** A deterministic, comparable digest-source of the observable simulation state. */
export function stateProbe(world: World): Record<string, unknown> {
  return {
    tick: world.tick, time: world.time, rng: world.rng.getState(), rules: world.rules,
    players: [...world.players.values()].map((p) => ({ id: p.id, res: p.resources, popUsed: p.popUsed, popCap: p.popCap, up: [...p.upgrades].sort(), rs: [...p.researching].sort(), defeated: p.defeated, stats: p.stats })),
    entities: world.list.map((e) => ({
      id: e.id, d: e.defId, o: e.owner, a: e.alive, x: e.pos.x, y: e.pos.y, f: e.facing, hp: e.hp, act: e.activity,
      ord: e.orders, cd: e.cooldowns, mv: e.mover && { m: e.mover.moving, g: e.mover.goal, v: e.mover.vel },
      cb: e.combat, ga: e.gatherer, pr: e.production?.queue, cs: e.construction, rs: e.resource, ra: e.rally,
    })),
    projectiles: world.projectiles.map((p) => ({ id: p.id, x: p.pos.x, y: p.pos.y, t: p.t, tg: p.targetId })),
  };
}

export function stateHash(world: World): string {
  const s = JSON.stringify(stateProbe(world));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Path + values of the first difference between two worlds' probes (null if identical). */
export function firstDifference(a: World, b: World): string | null {
  const walk = (x: unknown, y: unknown, path: string): string | null => {
    if (Object.is(x, y)) return null;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return `${path}: ${JSON.stringify(x)} ≠ ${JSON.stringify(y)}`;
    if (Array.isArray(x) !== Array.isArray(y)) return `${path}: array vs object`;
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) {
      const d = walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  };
  const pa = stateProbe(a), pb = stateProbe(b);
  // Label entity diffs with id/defId for readable failures
  const ea = pa.entities as Array<{ id: number; d: string }>, eb = pb.entities as Array<{ id: number; d: string }>;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) {
    const d = walk(ea[i], eb[i], `entity#${ea[i]?.id ?? eb[i]?.id}(${ea[i]?.d ?? eb[i]?.d})`);
    if (d) return d;
  }
  return walk({ ...pa, entities: 0 }, { ...pb, entities: 0 }, 'world');
}
