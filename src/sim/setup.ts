import { STARTING_RESOURCES, STARTING_WORKERS, PLAYER_COLORS } from '../config';
import type { Difficulty, Entity, FactionId, MapData, PlayerId } from '../core/types';
import { FACTIONS, getBuildingDef } from '../data';
import { installSimModules } from './install';
import { World, type PlayerInit } from './World';

export interface MatchPlayer { id: PlayerId; faction: FactionId; team: number; controller: 'human' | 'ai'; name?: string; difficulty?: Difficulty }

/** Create a world for a map + players with all real sim modules installed. Does not spawn anything. */
export function createWorld(map: MapData, players: MatchPlayer[], seed = 1): World {
  const inits: PlayerInit[] = players.map((p) => {
    const slot = map.slots.find((s) => s.id === p.id);
    return {
      id: p.id, name: p.name ?? FACTIONS[p.faction].name, faction: p.faction, team: p.team,
      color: PLAYER_COLORS[p.id] ?? FACTIONS[p.faction].color, controller: p.controller,
      startPos: slot?.start, resources: { ...STARTING_RESOURCES },
    };
  });
  const world = new World({ map, players: inits, seed });
  installSimModules(world);
  return world;
}

/** Spawn map resources (neutral Supply Caches). */
export function spawnMapResources(world: World): Entity[] {
  return world.map.resources.map((r) => world.spawnResource(r.pos, r.amount));
}

/** Standard skirmish start: HQ at each slot start + STARTING_WORKERS workers sent to gather. */
export function spawnSkirmishStart(world: World): void {
  for (const p of world.activePlayers()) {
    const f = FACTIONS[p.faction];
    if (!f.hq) continue;
    const hqDef = getBuildingDef(f.hq);
    const tile = { x: Math.round(p.startPos.x - hqDef.footprint.w / 2), y: Math.round(p.startPos.y - hqDef.footprint.h / 2) };
    const hq = world.spawnBuilding(f.hq, p.id, tile, { complete: true });
    for (let i = 0; i < STARTING_WORKERS; i++) {
      const a = (i / STARTING_WORKERS) * Math.PI * 2;
      const pos = world.movement.nearestWalkable({ x: hq.pos.x + Math.cos(a) * 4, y: hq.pos.y + Math.sin(a) * 4 }) ?? { x: hq.pos.x, y: hq.pos.y + 4 };
      const wkr = world.spawnUnit(f.worker, p.id, pos);
      const node = world.spatial.nearest(wkr.pos, 20, (e) => e.kind === 'resource');
      if (node) world.setOrders(wkr, [{ type: 'gather', targetId: node.id }]);
    }
  }
}
