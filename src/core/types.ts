/**
 * IMMUNE PROTOCOL — shared simulation contracts.
 *
 * OWNER: architect (orchestrator). Do NOT restructure this file. If a public field is genuinely
 * missing you may ADD an OPTIONAL field with a `// [your-module]` comment (re-read the file right
 * before editing; keep the edit tiny) and mention it in your report. Module-private per-entity data
 * belongs in `entity.ext.<module>` instead.
 *
 * This file must stay free of three.js / DOM imports: the simulation runs headless in Node tests.
 *
 * Coordinates: the sim is 2D on the ground plane. `Vec2 {x, y}` is in world units where
 * 1 world unit == 1 map tile. three.js mapping: position.set(p.x, height, p.y) (sim y -> three z).
 * Facing: radians, 0 = +x, increasing toward +y (sim) / +z (three). three.js: rotation.y = -facing.
 * Tile (tx, ty) covers world [tx, tx+1) x [ty, ty+1); its centre is (tx + 0.5, ty + 0.5).
 */

export type EntityId = number;
export type PlayerId = number; // 0 = neutral (resources, critters); 1..N = players
export const NEUTRAL_PLAYER: PlayerId = 0;

export type FactionId = 'hospital' | 'pathogen' | 'neutral';
export type Difficulty = 'easy' | 'normal' | 'hard' | 'brutal';

export interface Vec2 { x: number; y: number }
export interface TilePos { x: number; y: number } // integer tile coords (top-left tile of a footprint)

// ───────────────────────────── Resources ─────────────────────────────
/**
 * Two resources, faction-neutral keys in the sim; display names are per faction (see data/factions.ts):
 *   matter → Hospital "Supplies", Pathogen "Biomass"   (gathered by workers from Supply Cache nodes)
 *   energy → Hospital "Power",    Pathogen "Toxin"     (generated passively by Generator / Fermentation Vat)
 * Population ("pop") is a cap, not a resource: Hospital "Beds", Pathogen "Colony".
 */
export type ResourceKind = 'matter' | 'energy';
export interface ResourceBag { matter: number; energy: number }
export interface Cost { matter?: number; energy?: number }

// ───────────────────────────── Tags & damage ─────────────────────────────
export type UnitTag =
  | 'ground' | 'air'
  | 'worker' | 'structure' | 'hero'
  | 'bio' | 'mech'
  | 'light' | 'armored' | 'massive'
  | 'viral' | 'bacterial' | 'fungal'
  | 'healer' | 'detector';

export type DamageType = 'normal' | 'uv' | 'antibiotic' | 'acid' | 'toxin' | 'melee' | 'explosive';

/** Visual key for a weapon's shot; the VFX module renders each key. */
export type WeaponVfx =
  | 'spray'               // short disinfectant mist cone (Sanitizer)
  | 'uv_beam'             // instant violet-white beam (UV Lancer, UV Turret)
  | 'antibiotic_capsule'  // lobbed glowing capsule, splash (Antibiotic Launcher)
  | 'laser'               // thin cyan bolt (Sterilizer Drone)
  | 'engulf'              // melee: macrophage pseudopod grab
  | 'zap'                 // worker tool zap / weak melee
  | 'acid_spit'           // green glob projectile (Bacillus, Toxin Spitter)
  | 'spore_lob'           // arcing spore cluster, splash (Fungal Mortar)
  | 'toxin_bolt'          // magenta bolt (Flu Drifter, Strain Omega)
  | 'bite'                // melee: phage stab
  | 'whip'                // melee: spirochete lash
  | 'slam';               // melee splash: superbug slam

export interface WeaponDef {
  name: string;
  damage: number;
  damageType: DamageType;
  /** Edge-to-edge range in world units (distance between centres minus both radii). Melee ≈ 0.25. */
  range: number;
  minRange?: number;
  /** Seconds between attacks. */
  cooldown: number;
  targets: Array<'ground' | 'air'>;
  vfx: WeaponVfx;
  /** null/undefined = instant hit (beams, sprays, melee). Otherwise a projectile entity in world.projectiles. */
  projectileSpeed?: number;
  /** Lobbed (ballistic arc) projectile — can't miss, hits ground at target position. */
  arc?: boolean;
  splashRadius?: number;
  /** Extra flat damage vs targets having the tag, e.g. { viral: 10 }. */
  bonus?: Partial<Record<UnitTag, number>>;
  /** Seconds between starting the attack animation and the damage/projectile release. */
  windup?: number;
}

// ───────────────────────────── Definitions (data) ─────────────────────────────
export interface HealDef { rate: number; range: number; } // hp/sec to friendly non-structure units
export interface GatherDef { capacity: number; gatherTime: number } // matter per trip, seconds at node

export interface UnitDef {
  kind: 'unit';
  id: string;
  name: string;
  faction: FactionId;
  role: string;          // short role line for tooltips, e.g. "Basic infantry"
  description: string;
  cost: Cost;
  buildTime: number;     // seconds
  pop: number;
  hp: number;
  armor: number;
  speed: number;         // world units / second
  radius: number;        // collision radius, world units
  sight: number;         // vision radius, world units
  tags: UnitTag[];
  weapons: WeaponDef[];  // 0..2 (e.g. separate air/ground weapons)
  abilities: string[];   // ability ids (data/abilities.ts)
  requires: string[];    // building ids that must exist (completed) for the owner
  hotkey: string;        // single uppercase letter on the producer's command card
  gather?: GatherDef;    // workers only
  builds?: string[];     // building ids this worker can construct
  heal?: HealDef;        // healers
  resist?: Partial<Record<DamageType, number>>; // damage multiplier per type (0.5 = takes half)
  hpRegen?: number;      // hp/sec (pathogens regenerate)
  flyHeight?: number;    // render altitude for air units (world units)
  modelScale?: number;
  trainable?: boolean;   // false = campaign-only (e.g. bosses). Default true.
}

export interface BuildingDef {
  kind: 'building';
  id: string;
  name: string;
  faction: FactionId;
  role: string;
  description: string;
  cost: Cost;
  buildTime: number;
  hp: number;
  armor: number;
  sight: number;
  footprint: { w: number; h: number }; // tiles
  tags: UnitTag[];                     // always includes 'structure' and 'ground'
  provides: { pop?: number; energyPerSec?: number };
  trains: string[];                    // unit ids
  researches: string[];                // upgrade ids
  requires: string[];                  // building ids required to construct this
  weapons: WeaponDef[];
  abilities: string[];
  dropoff?: boolean;                   // workers return matter here
  hq?: boolean;                        // headquarters (start building)
  hotkey: string;                      // on the worker's build card
  hpRegen?: number;
  buildable?: boolean;                 // false = cannot be constructed by players (objective buildings)
}

export interface ResourceNodeDef {
  kind: 'resource';
  id: string;            // 'res_supply_cache'
  name: string;
  resource: ResourceKind;
  defaultAmount: number;
  radius: number;
  footprint: { w: number; h: number };
}

export type StatKey = 'maxHp' | 'armor' | 'speed' | 'sight' | 'hpRegen' | 'damageAdd' | 'damageMul' | 'rangeAdd' | 'cooldownMul' | 'gatherCapacityAdd' | 'healRateMul';

export interface UpgradeEffect {
  stat: StatKey | 'resist';
  add?: number;
  mul?: number;
  damageType?: DamageType;        // for stat === 'resist' (multiplies resist[damageType])
  appliesTo: { tags?: UnitTag[]; ids?: string[]; excludeTags?: UnitTag[] };
}

export interface UpgradeDef {
  kind: 'upgrade';
  id: string;
  name: string;
  faction: FactionId;
  description: string;
  cost: Cost;
  researchTime: number;
  requires: string[];             // building ids and/or upgrade ids
  hotkey: string;
  effects: UpgradeEffect[];
}

export interface AbilityDef {
  id: string;
  name: string;
  description: string;
  hotkey: string;
  target: 'none' | 'point' | 'unit' | 'passive';
  cooldown: number;               // seconds
  cost?: Cost;
  range?: number;
  radius?: number;
  damage?: number;
  damageType?: DamageType;
  bonus?: Partial<Record<UnitTag, number>>;
  amount?: number;                // generic magnitude (e.g. matter granted, units spawned)
  autocast?: boolean;
}

export type AnyDef = UnitDef | BuildingDef | ResourceNodeDef;

// ───────────────────────────── Entity & components ─────────────────────────────
export type EntityKind = 'unit' | 'building' | 'resource';

/** What the entity is doing right now — set by order handlers / idle behaviour; read by renderer & audio. */
export type Activity = 'idle' | 'moving' | 'attacking' | 'gathering' | 'carrying' | 'building' | 'healing' | 'casting' | 'producing';

/** Effective (upgrade-modified) stats. Systems MUST read these, not def values. Recomputed by economy on research. */
export interface EntityStats {
  maxHp: number;
  armor: number;
  speed: number;
  sight: number;
  hpRegen: number;
  damageAdd: number;
  damageMul: number;
  rangeAdd: number;
  cooldownMul: number;
  gatherCapacityAdd: number;
  healRateMul: number;
  resist: Partial<Record<DamageType, number>>;
}

/** Movement component (units). Public fields read by renderer/AI; internals go in ext.movement. [movement] */
export interface MoverState {
  flying: boolean;
  moving: boolean;          // true while actively travelling
  vel: Vec2;                // current velocity (world units/sec) — renderer uses for walk cycles
  goal: Vec2 | null;        // current movement goal (final destination)
  path: Vec2[];             // remaining waypoints (world coords), may be empty
  arrived: boolean;         // set true when the last move request has finished (arrived or gave up)
  blockedTime: number;      // seconds unable to make progress (for give-up logic)
}

/** Combat component (anything with weapons). [combat] */
export interface CombatState {
  targetId: EntityId | null;  // current attack target
  cooldown: number;           // seconds until the weapon may fire again
  lastAttackTime: number;     // world.time of last attack release (-1 = never) → renderer attack pulses
  windupLeft: number;         // >0 while an attack is winding up
  holdPosition: boolean;      // hold: never chase
}

export type GatherPhase = 'toNode' | 'waiting' | 'gathering' | 'toDropoff' | 'idle';
/** Worker component. [economy] */
export interface GathererState {
  carrying: number;           // matter carried
  nodeId: EntityId | null;    // resource node assigned
  dropoffId: EntityId | null;
  phase: GatherPhase;
  timer: number;
}

export interface ProductionItem {
  kind: 'unit' | 'upgrade';
  defId: string;              // unit id or upgrade id
  progress: number;           // seconds elapsed
  total: number;              // seconds required
  cost: Cost;                 // paid cost (refunded on cancel)
}
/** Production component (buildings that train/research). [economy] */
export interface ProductionState { queue: ProductionItem[]; maxQueue: number }

/** Present while a building is under construction. [economy] */
export interface ConstructionState { progress: number; total: number; builderId: EntityId | null; costPaid: Cost }

/** Resource node component. [economy] */
export interface ResourceState { kind: ResourceKind; amount: number; initial: number; activeGatherers: number }

export interface RallyPoint { pos: Vec2; targetId?: EntityId }

export interface Entity {
  readonly id: EntityId;
  readonly kind: EntityKind;
  readonly defId: string;
  readonly def: AnyDef;
  owner: PlayerId;
  pos: Vec2;
  /** position at the start of the current tick — renderer interpolates prevPos → pos. */
  prevPos: Vec2;
  facing: number;
  prevFacing: number;
  radius: number;
  hp: number;
  /** current energy-like ability mana is not used; ability cooldowns live in `cooldowns`. */
  alive: boolean;
  /** world.time when spawned */
  bornAt: number;
  activity: Activity;
  stats: EntityStats;
  tags: ReadonlySet<UnitTag>;
  /** order queue; orders[0] is current. Units only (buildings use production/rally). */
  orders: Order[];
  /** ability id -> seconds of cooldown remaining */
  cooldowns: Record<string, number>;
  /** building footprint top-left tile (buildings/resources) */
  tile?: TilePos;
  mover?: MoverState;
  combat?: CombatState;
  gatherer?: GathererState;
  production?: ProductionState;
  construction?: ConstructionState;
  resource?: ResourceState;
  rally?: RallyPoint;
  /** last time (world.time) this entity took damage, and from whom — for alerts, AI, retaliation */
  lastDamagedAt: number;
  lastAttackerId: EntityId | null;
  /** campaign scripts can tag entities: e.g. 'objective', 'boss', 'scripted' */
  scriptTags: Set<string>;
  /** invulnerable entities ignore damage (campaign) */
  invulnerable?: boolean;
  /** module-private storage: ext.movement, ext.combat, ext.economy, ext.ai, ... */
  ext: Record<string, unknown>;
}

// ───────────────────────────── Orders (per-unit) ─────────────────────────────
export type Order =
  | { type: 'move'; target: Vec2 }
  | { type: 'attackMove'; target: Vec2 }
  | { type: 'attack'; targetId: EntityId }
  | { type: 'patrol'; from: Vec2; to: Vec2 }
  | { type: 'hold' }
  | { type: 'follow'; targetId: EntityId }
  | { type: 'gather'; targetId: EntityId }
  | { type: 'returnCargo'; targetId?: EntityId }
  | { type: 'build'; defId: string; tile: TilePos; buildingId?: EntityId }
  | { type: 'construct'; targetId: EntityId }        // continue/assist construction of an existing foundation
  | { type: 'repair'; targetId: EntityId }           // mech units & structures (workers)
  | { type: 'heal'; targetId: EntityId }
  | { type: 'ability'; abilityId: string; target?: Vec2; targetId?: EntityId };

export type OrderType = Order['type'];
export type OrderOf<T extends OrderType> = Extract<Order, { type: T }>;
export type OrderStatus = 'running' | 'done' | 'failed';

// ───────────────────────────── Commands (player/AI intent) ─────────────────────────────
interface CmdBase { playerId: PlayerId }
interface UnitCmd extends CmdBase { unitIds: EntityId[]; queue?: boolean }
export type Command =
  | (UnitCmd & { type: 'smart'; target: Vec2; targetId?: EntityId })   // right-click
  | (UnitCmd & { type: 'move'; target: Vec2 })
  | (UnitCmd & { type: 'attackMove'; target: Vec2 })
  | (UnitCmd & { type: 'attack'; targetId: EntityId })
  | (UnitCmd & { type: 'patrol'; target: Vec2 })
  | (UnitCmd & { type: 'hold' })
  | (UnitCmd & { type: 'stop' })
  | (UnitCmd & { type: 'follow'; targetId: EntityId })
  | (UnitCmd & { type: 'gather'; targetId: EntityId })
  | (UnitCmd & { type: 'returnCargo' })
  | (UnitCmd & { type: 'build'; defId: string; tile: TilePos })
  | (UnitCmd & { type: 'repair'; targetId: EntityId })
  | (UnitCmd & { type: 'ability'; abilityId: string; target?: Vec2; targetId?: EntityId })
  | (CmdBase & { type: 'train'; buildingId: EntityId; defId: string })
  | (CmdBase & { type: 'cancelTrain'; buildingId: EntityId; index?: number })
  | (CmdBase & { type: 'research'; buildingId: EntityId; upgradeId: string })
  | (CmdBase & { type: 'cancelResearch'; buildingId: EntityId })
  | (CmdBase & { type: 'setRally'; buildingIds: EntityId[]; target: Vec2; targetId?: EntityId })
  | (CmdBase & { type: 'buildingAbility'; buildingId: EntityId; abilityId: string; target?: Vec2; targetId?: EntityId })
  | (CmdBase & { type: 'cancelConstruction'; buildingId: EntityId });

export type CommandType = Command['type'];

// ───────────────────────────── Projectiles ─────────────────────────────
export interface Projectile {
  id: number;
  ownerPlayer: PlayerId;
  sourceId: EntityId;
  targetId: EntityId | null;   // homing target (null for arc/ground shots)
  weapon: WeaponDef;
  vfx: WeaponVfx;
  pos: Vec2;
  prevPos: Vec2;
  start: Vec2;
  targetPos: Vec2;
  /** 0..1 travel fraction (arc shots use it for the parabola). */
  t: number;
  prevT: number;
  speed: number;
  arc: boolean;
  damage: number;              // pre-armor damage computed at launch
  splashRadius: number;
  /** heights above ground at launch/impact (renderer uses with arc) */
  startHeight: number;
  endHeight: number;
}

// ───────────────────────────── Players ─────────────────────────────
export interface PlayerStats {
  unitsTrained: number; unitsLost: number; unitsKilled: number;
  buildingsBuilt: number; buildingsLost: number; buildingsKilled: number;
  matterGathered: number; energyGenerated: number; upgradesResearched: number;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  faction: FactionId;
  team: number;                // players with the same team are allies
  color: number;               // 0xRRGGBB team colour
  controller: 'human' | 'ai' | 'none';
  resources: ResourceBag;
  popUsed: number;             // recomputed by economy each tick (includes queued units)
  popCap: number;              // recomputed by economy each tick (capped at MAX_POP)
  upgrades: Set<string>;       // completed upgrade ids
  researching: Set<string>;    // in-progress upgrade ids
  defeated: boolean;
  startPos: Vec2;
  stats: PlayerStats;
  /** gather-rate multiplier (AI difficulty handicap / campaign) */
  gatherMul: number;
}

// ───────────────────────────── Map ─────────────────────────────
export enum Terrain {
  Grass = 0,
  Asphalt = 1,
  Concrete = 2,
  Plaza = 3,        // paved stone tiles
  Sand = 4,
  Water = 5,
  Dirt = 6,
  Snow = 7,
  Contaminated = 8, // infected ground (cosmetic)
  Rock = 9,         // granite outcrop (usually blocked)
}

/** Decorative/blocking props. Implemented by the model artists (render/models). */
export type DoodadKind =
  // campus architecture (large, non-playable)
  | 'hospital_tower' | 'hospital_wing' | 'childrens_hospital' | 'research_lab' | 'parking_garage'
  | 'old_laundry' | 'water_tower' | 'skybridge'
  // vehicles & street props
  | 'ambulance' | 'car' | 'bus' | 'helicopter_pad' | 'street_lamp' | 'bench' | 'bus_stop'
  | 'traffic_cone' | 'barrier' | 'fence' | 'sign_er' | 'dumpster' | 'flag_pole'
  // nature
  | 'tree_birch' | 'tree_pine' | 'bush' | 'rock_granite' | 'snow_pile' | 'reeds' | 'pier'
  // infection props (pathogen artist)
  | 'biohazard_barrel' | 'goo_puddle' | 'sewer_grate' | 'infected_growth' | 'spore_vent' | 'waste_container';

export interface Doodad {
  kind: DoodadKind;
  pos: Vec2;            // world position (centre)
  rot: number;          // radians (facing convention)
  scale: number;
  /** blocked footprint already baked into MapData.blocked; listed for reference */
  footprint?: { w: number; h: number };
  seed: number;         // variation seed
}

export type DecalKind = 'road_line' | 'crosswalk' | 'parking_lines' | 'helipad_h' | 'medical_cross' | 'arrow' | 'manhole' | 'stain';
export interface Decal { kind: DecalKind; pos: Vec2; rot: number; size: Vec2 }

export interface MapRegion { x: number; y: number; w: number; h: number } // world rect

export type LightingPreset = 'day' | 'nordic_dusk' | 'night';

export interface MapData {
  id: string;
  name: string;
  description: string;
  width: number;            // tiles
  height: number;           // tiles
  /** per tile: Terrain */
  terrain: Uint8Array;
  /** per tile: elevation level 0..3 (for vision/high ground); ramps have the level of their high side */
  levels: Uint8Array;
  /** per tile: 1 = ramp tile */
  ramps: Uint8Array;
  /** per tile: 1 = statically blocked for ground units (water, cliffs, doodad footprints, map border) */
  blocked: Uint8Array;
  /** per tile: 1 = buildable (walkable & flat & not road-critical); building placement also needs !blocked */
  buildable: Uint8Array;
  /** (width+1)*(height+1) vertex heights in world units; use core/terrain.ts sampleHeight() */
  heights: Float32Array;
  doodads: Doodad[];
  decals: Decal[];
  resources: Array<{ pos: Vec2; amount: number }>;
  /** player slots; skirmish puts each player's HQ at `start` (HQ centre) plus 5 workers. Campaign missions spawn their own. */
  slots: Array<{ id: PlayerId; faction: FactionId; start: Vec2 }>;
  /** named world rects for triggers, e.g. 'player_base', 'enemy_core' */
  regions: Record<string, MapRegion>;
  /** named points (waypoints, spawn points) */
  points: Record<string, Vec2>;
  lighting: LightingPreset;
  /** optional sea level for water rendering */
  waterLevel: number;
}

// ───────────────────────────── Events ─────────────────────────────
export type RemoveReason = 'died' | 'removed';
export type NotEnoughKind = 'matter' | 'energy' | 'pop' | 'requirement' | 'placement' | 'queueFull' | 'cooldown' | 'invalidTarget';

export interface GameEvents {
  entitySpawned: { entity: Entity };
  entityDied: { entity: Entity; killer: Entity | null };
  entityRemoved: { entity: Entity; reason: RemoveReason };
  entityDamaged: { entity: Entity; amount: number; type: DamageType; source: Entity | null };
  entityHealed: { entity: Entity; amount: number; source: Entity | null };
  weaponFired: { source: Entity; target: Entity | null; targetPos: Vec2; weapon: WeaponDef; projectile: Projectile | null };
  projectileImpact: { projectile: Projectile; pos: Vec2; target: Entity | null };
  constructionStarted: { building: Entity; builder: Entity | null };
  constructionComplete: { building: Entity };
  constructionCancelled: { building: Entity };
  productionQueued: { building: Entity; item: ProductionItem };
  productionComplete: { building: Entity; unit: Entity };
  researchComplete: { playerId: PlayerId; upgradeId: string; building: Entity | null };
  resourceDelivered: { worker: Entity; playerId: PlayerId; kind: ResourceKind; amount: number };
  resourceDepleted: { node: Entity };
  abilityUsed: { source: Entity; abilityId: string; target: Vec2 | null; targetEntity: Entity | null };
  commandIssued: { command: Command };
  /** throttled alert (≤ 1 per ~8 s per player per area) */
  underAttack: { playerId: PlayerId; entity: Entity; pos: Vec2 };
  /** feedback for the issuing player (UI toast + audio): "Not enough Supplies" */
  notEnough: { playerId: PlayerId; kind: NotEnoughKind; message: string };
  playerDefeated: { playerId: PlayerId };
  gameOver: { winnerTeam: number | null; reason: string };
}
export type GameEventType = keyof GameEvents;
