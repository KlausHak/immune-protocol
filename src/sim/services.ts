/**
 * Service interfaces the World exposes. Each simulation module installs its implementation onto the
 * world in its install*(world) function (see src/sim/install.ts). Stubs live in src/sim/stubs.ts.
 * OWNER: architect. Signatures are a contract — extend only by adding OPTIONAL members.
 */
import type {
  Cost, DamageType, Entity, EntityId, MapData, OrderOf, OrderStatus, OrderType, PlayerId, TilePos, Vec2, WeaponDef,
} from '../core/types';
import type { World } from './World';

export interface SimSystem {
  name: string;
  /** Lower runs first. Built-ins: 0 snapshot, 5 cooldowns, 10 commands, 20 orders, 25 spatial rebuild,
   *  30 movement, 40 combat, 50 economy, 60 vision, 80 regen, 90 rules, 100 cleanup. */
  order: number;
  update(world: World, dt: number): void;
}

/** Per-order-type behaviour. Registered in world.orderHandlers[type]. */
export interface OrderHandler<T extends OrderType = OrderType> {
  /** Called once when the order becomes current. */
  start?(world: World, e: Entity, order: OrderOf<T>): void;
  /** Called every tick while current. Return 'done'/'failed' to advance to the next queued order. */
  update(world: World, e: Entity, order: OrderOf<T>, dt: number): OrderStatus;
  /** Called when the order ends for any reason (finished, failed, replaced, entity died). */
  stop?(world: World, e: Entity, order: OrderOf<T>): void;
}
export type OrderHandlerMap = { [K in OrderType]?: OrderHandler<K> };

/** [movement] Pathfinding, steering, collision. Owner: movement module. */
export interface MovementService {
  /** Move toward a point. Repeated calls with ~the same target must be cheap (no re-path every tick). */
  moveTo(e: Entity, target: Vec2, opts?: { arriveDistance?: number }): void;
  /** Approach until world.edgeDistance(e, target) <= range; tracks a moving target. */
  moveToEntity(e: Entity, target: Entity, range: number): void;
  stop(e: Entity): void;
  /** True when the most recent move request has completed (arrived, or gave up when unreachable). */
  hasArrived(e: Entity): boolean;
  /** Per-unit destinations for a group move (formation / spread). Default: same target for all. */
  groupTargets(units: Entity[], target: Vec2): Vec2[];
  /** Ground path (world-space waypoints) or null if unreachable. Air units fly straight. */
  findPath(from: Vec2, to: Vec2, radius: number): Vec2[] | null;
  /** Static + dynamic (building) walkability for ground units at a world point. */
  isWalkable(p: Vec2): boolean;
  /** Nearest walkable world point to p (for clicks on blocked terrain). */
  nearestWalkable(p: Vec2, maxRadius?: number): Vec2 | null;
  /** Mark building/resource footprints (called by World on spawn/removal of buildings & resources). */
  setFootprintBlocked(tile: TilePos, w: number, h: number, blocked: boolean): void;
  /** True if every footprint tile is in-bounds, not statically/dynamically blocked, and no ground unit (except `ignore`) overlaps it. */
  isFootprintFree(tile: TilePos, w: number, h: number, ignore?: EntityId[]): boolean;
  /** Push ground units out of a footprint (when a foundation is placed on top of them). */
  clearFootprint?(tile: TilePos, w: number, h: number, ignore?: EntityId[]): void;
}

/** [movement] Fog of war. Owner: movement module (vision). */
export interface VisionService {
  /** Per-tile fog for a player: 0 = unexplored, 1 = explored (not visible now), 2 = visible. Length map.width*map.height. */
  fogGrid(playerId: PlayerId): Uint8Array;
  /** Increments whenever any fog grid changes (renderer re-uploads textures when it changes). */
  readonly version: number;
  isVisible(playerId: PlayerId, p: Vec2): boolean;
  isExplored(playerId: PlayerId, p: Vec2): boolean;
  /** Own/allied entities: always true. Enemy units: visible tile under them (air: same). Buildings: visible OR remembered (explored) after first sighting. */
  isEntityVisible(playerId: PlayerId, e: Entity): boolean;
  /** Campaign/debug helpers */
  revealAll(playerId: PlayerId, on: boolean): void;
  revealArea(playerId: PlayerId, p: Vec2, radius: number, seconds: number): void;
}

/** [combat] Damage, healing & targeting rules. Owner: combat module. */
export interface CombatService {
  /** Applies armour/resist/bonus already folded in by the caller? NO: pass raw damage; this applies armour & resist.
   *  Returns damage actually dealt. Kills via world.killEntity when hp <= 0. Respects e.invulnerable. */
  applyDamage(target: Entity, rawDamage: number, type: DamageType, source: Entity | null): number;
  heal(target: Entity, amount: number, source: Entity | null): number;
  /** Raw damage of `weapon` from `attacker` vs `target` (base + bonus vs tags, × attacker damageMul). */
  rawDamage(attacker: Entity, weapon: WeaponDef, target: Entity): number;
  /** Best weapon of attacker able to hit target (ground/air), or null. */
  weaponFor(attacker: Entity, target: Entity): WeaponDef | null;
  /** Effective weapon range incl. upgrades. */
  weaponRange(attacker: Entity, weapon: WeaponDef): number;
  /** Whether attacker may target `target` at all (enemy, alive, targetable, visible to attacker's owner). */
  canTarget(attacker: Entity, target: Entity): boolean;
}

/** [combat] Abilities (active & passive). Owner: combat module. */
export interface AbilityService {
  canCast(caster: Entity, abilityId: string, target?: Vec2, targetEntity?: Entity | null): { ok: boolean; reason?: string };
  /** Casts immediately (caller is responsible for range — use the 'ability' order for walk-then-cast). */
  cast(caster: Entity, abilityId: string, target?: Vec2, targetEntity?: Entity | null): boolean;
}

/** [economy] Resources, construction, production, research, population. Owner: economy module. */
export interface EconomyService {
  canAfford(playerId: PlayerId, cost: Cost): boolean;
  /** Deducts if affordable; otherwise emits notEnough and returns false. */
  spend(playerId: PlayerId, cost: Cost): boolean;
  refund(playerId: PlayerId, cost: Cost, fraction?: number): void;
  addResources(playerId: PlayerId, bag: Cost): void;
  /** Completed buildings of `requires` (building ids) / completed upgrades (upgrade ids) present? */
  meetsRequirements(playerId: PlayerId, requires: string[]): boolean;
  missingRequirements(playerId: PlayerId, requires: string[]): string[];
  canPlaceBuilding(playerId: PlayerId, defId: string, tile: TilePos, builderId?: EntityId): { ok: boolean; reason?: string };
  /** Spends and creates an under-construction building. Returns null (and emits notEnough) on failure. */
  placeFoundation(playerId: PlayerId, defId: string, tile: TilePos, builder: Entity | null): Entity | null;
  cancelConstruction(building: Entity): void;
  canTrain(building: Entity, unitDefId: string): { ok: boolean; reason?: string };
  queueTrain(building: Entity, unitDefId: string): boolean;
  cancelTrain(building: Entity, index?: number): void;
  canResearch(building: Entity, upgradeId: string): { ok: boolean; reason?: string };
  queueResearch(building: Entity, upgradeId: string): boolean;
  cancelResearch(building: Entity): void;
  /** Nearest completed friendly drop-off for a worker. */
  nearestDropoff(worker: Entity): Entity | null;
}

/** Spatial queries. Default uniform-grid implementation in World; movement may replace with a faster one. */
export interface SpatialIndex {
  /** Alive entities whose circle overlaps the query circle: dist(p, e.pos) <= r + e.radius. */
  queryRadius(p: Vec2, r: number, filter?: (e: Entity) => boolean, out?: Entity[]): Entity[];
  /** Nearest matching alive entity (by edge distance) within r, or null. */
  nearest(p: Vec2, r: number, filter: (e: Entity) => boolean): Entity | null;
  /** Alive entities whose centre lies in the world rect. */
  queryRect(x0: number, y0: number, x1: number, y1: number, filter?: (e: Entity) => boolean): Entity[];
  rebuild(): void;
}

export type { MapData };
