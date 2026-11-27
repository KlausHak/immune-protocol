/**
 * [qa] Scripted HOSPITAL player for headless matches.
 *
 * Plays by the same rules as a human: every action goes through `world.issue(cmd)` and decisions only use
 * public services (`world.economy.canPlaceBuilding/canTrain/canResearch/meetsRequirements`,
 * `world.abilities.canCast`, `world.vision.isEntityVisible`, `world.spatial`, `world.movement.nearestWalkable`).
 * It never spawns, edits or teleports entities and only reacts to enemies its owner can see.
 * Deterministic: iteration follows `world.list` order, randomness comes from `world.rng.fork()` (which does
 * not advance the world's stream) — the same seed always produces the same match.
 *
 *   const bot = createHospitalBot(world, { strength: 'medium' });
 *   match.runFor(600, () => bot.update());          // call once per tick BEFORE world.step()
 *
 * Behaviour: trains Orderlies to the preset target and keeps them gathering (≤ 3 per cache, nearest drop-off),
 * builds Wards ahead of the pop cap, Generators, Pharmacy, Research Lab, Ambulance Depot and UV Turrets near the
 * base (own spiral search + `canPlaceBuilding`), trains a mixed army by composition weights, researches
 * weapons/armour, defends anything attacked inside its base radius (and pulls workers in emergencies),
 * attack-moves the enemy start once the army reaches `attackArmySize`, then hunts remaining known buildings and
 * scouts resource sites, retreats when the attack force is depleted, expands when local caches run dry,
 * repairs damaged structures and uses Emergency Supply / UV Flare.
 */
import { MAX_POP } from '../../src/config';
import { dist, normalize, sub } from '../../src/core/math';
import type { Rng } from '../../src/core/rng';
import { footprintCenter } from '../../src/core/terrain';
import type { BuildingDef, Command, Cost, Entity, EntityId, PlayerId, PlayerState, TilePos, UnitDef, Vec2 } from '../../src/core/types';
import { BUILDING_DEFS, UNIT_DEFS, UPGRADE_DEFS } from '../../src/data';
import type { World } from '../../src/sim/World';

export type BotStrength = 'weak' | 'medium' | 'strong';

export interface BotConfig {
  /** Orderlies to keep (+4 per extra completed HQ). */
  workerTarget: number;
  /** Seconds between decisions — the bot's "APM". */
  thinkInterval: number;
  /** Army units (combat units + medics) required before an attack is launched. */
  attackArmySize: number;
  /** No attack before this game time (s). */
  minAttackTime: number;
  /** Retreat when an attacking army falls below attackArmySize × this (0 = never retreat). */
  retreatFraction: number;
  /** Max queued items per production building. */
  queueDepth: number;
  /** Pharmacies in the fixed build order / maximum when production is the bottleneck. */
  pharmacies: number;
  maxPharmacies: number;
  depots: number;
  /** Generators in the fixed build order / maximum when Power is the bottleneck. */
  generators: number;
  maxGenerators: number;
  turrets: number;
  /** Upgrade ids in priority order. */
  research: string[];
  /** Composition weights for the army (unit id → weight). */
  mix: Record<string, number>;
  /** Take a new resource cluster when local caches run low. */
  expand: boolean;
  useAbilities: boolean;
  repair: boolean;
  /** Pull workers to fight when the base is hit and the army can't cope. */
  workerDefense: boolean;
  /** A second worker assists big constructions. */
  assistConstruction: boolean;
  /** Enemy units within this distance of any own building count as an attack on the base. */
  defenseRadius: number;
  /** Re-issue the same army order at most this often (s) — avoids resetting unit AI every think. */
  reorderInterval: number;
}

const ALL_HOSP_RESEARCH = [
  'up_hosp_weapons_1', 'up_hosp_armor_1', 'up_hosp_logistics', 'up_hosp_uv_overcharge', 'up_hosp_weapons_2',
  'up_hosp_armor_2', 'up_hosp_broad_spectrum', 'up_hosp_rapid_response',
];

export const BOT_PRESETS: Record<BotStrength, BotConfig> = {
  weak: {
    workerTarget: 10, thinkInterval: 2, attackArmySize: 10, minAttackTime: 420, retreatFraction: 0, queueDepth: 1,
    pharmacies: 1, maxPharmacies: 1, depots: 0, generators: 1, maxGenerators: 1, turrets: 1, research: [],
    mix: { hosp_sanitizer: 6, hosp_medic: 1 },
    expand: false, useAbilities: false, repair: false, workerDefense: false, assistConstruction: false,
    defenseRadius: 12, reorderInterval: 4,
  },
  medium: {
    workerTarget: 16, thinkInterval: 1, attackArmySize: 18, minAttackTime: 300, retreatFraction: 0.35, queueDepth: 2,
    pharmacies: 1, maxPharmacies: 3, depots: 1, generators: 3, maxGenerators: 5, turrets: 2,
    research: ['up_hosp_weapons_1', 'up_hosp_armor_1', 'up_hosp_logistics', 'up_hosp_uv_overcharge'],
    mix: { hosp_sanitizer: 5, hosp_medic: 1, hosp_uv_lancer: 2, hosp_antibiotic_launcher: 1, hosp_macrophage: 1 },
    expand: true, useAbilities: true, repair: true, workerDefense: true, assistConstruction: false,
    defenseRadius: 16, reorderInterval: 3,
  },
  strong: {
    workerTarget: 20, thinkInterval: 0.5, attackArmySize: 24, minAttackTime: 270, retreatFraction: 0.4, queueDepth: 2,
    pharmacies: 2, maxPharmacies: 4, depots: 1, generators: 4, maxGenerators: 7, turrets: 3, research: ALL_HOSP_RESEARCH,
    mix: { hosp_sanitizer: 5, hosp_medic: 1, hosp_uv_lancer: 3, hosp_antibiotic_launcher: 2, hosp_macrophage: 2 },
    expand: true, useAbilities: true, repair: true, workerDefense: true, assistConstruction: true,
    defenseRadius: 18, reorderInterval: 2,
  },
};

export interface HospitalBotOptions {
  playerId?: PlayerId;
  /** Enemy whose start location is attacked (default: first active enemy player). */
  enemyId?: PlayerId;
  strength?: BotStrength;
  /** Override individual preset fields, e.g. { attackArmySize: 30 }. */
  overrides?: Partial<BotConfig>;
  /** Salt for the bot's private RNG (forked from world.rng without advancing it). */
  seed?: number;
  /** Keep a decision log (bot.log) for debugging. */
  log?: boolean;
}

export interface BotStats {
  thinks: number;
  commands: number;
  buildsIssued: number;
  buildsPlaced: number;
  buildsFailed: number;
  placementFailures: number;
  unitsQueued: number;
  researchQueued: number;
  attacksLaunched: number;
  retreats: number;
  defenses: number;
  workerDefenses: number;
  abilitiesCast: number;
  repairsIssued: number;
  expansions: number;
  assists: number;
}

type ArmyMode = 'rally' | 'attack' | 'defend';
export type BuildKind = 'base' | 'turret' | 'expansion';

interface BuildIntent { defId: string; tile: TilePos; workerId: EntityId; issuedAt: number; deadline: number; cost: Cost; kind: BuildKind }

interface Budget { matter: number; energy: number }

interface Snapshot {
  me: PlayerState;
  time: number;
  hqs: Entity[];               // completed own drop-offs
  mainHq: Entity | null;
  base: Vec2;                  // main base anchor
  buildings: Entity[];         // all own alive buildings (incl. foundations)
  count: Map<string, number>;  // per building def: alive incl. foundations + pending intents
  done: Map<string, number>;   // per building def: completed
  workers: Entity[];
  army: Entity[];
  queuedUnits: Map<string, number>;
  nodes: Entity[];             // alive resource nodes with matter left
  visibleEnemies: Entity[];    // alive, visible enemy units + buildings
  threats: Entity[];           // visible enemy units near own buildings
}

const HQ = 'hosp_hq', WARD = 'hosp_ward', GEN = 'hosp_generator', PHARM = 'hosp_pharmacy', LAB = 'hosp_lab', DEPOT = 'hosp_vehicle_bay', TURRET = 'hosp_uv_turret';
const WORKER = 'hosp_orderly';
const LOCAL_NODE_RANGE = 14;

const costOf = (c: Cost): Budget => ({ matter: c.matter ?? 0, energy: c.energy ?? 0 });
/** Only the components the cost actually needs are compared (a negative energy budget must not block matter-only units). */
const affordable = (b: Budget, c: Cost): boolean => ((c.matter ?? 0) <= 0 || b.matter >= (c.matter ?? 0)) && ((c.energy ?? 0) <= 0 || b.energy >= (c.energy ?? 0));
const deduct = (b: Budget, c: Cost): void => { b.matter -= c.matter ?? 0; b.energy -= c.energy ?? 0; };
const centroid = (es: Entity[]): Vec2 => {
  let x = 0, y = 0;
  for (const e of es) { x += e.pos.x; y += e.pos.y; }
  return es.length ? { x: x / es.length, y: y / es.length } : { x: 0, y: 0 };
};
function segPointDist(a: Vec2, b: Vec2, p: Vec2): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2)) : 0;
  return Math.hypot(a.x + abx * t - p.x, a.y + aby * t - p.y);
}
function rectGap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

export class HospitalBot {
  readonly playerId: PlayerId;
  readonly enemyId: PlayerId;
  readonly strength: BotStrength;
  readonly config: BotConfig;
  readonly stats: BotStats = {
    thinks: 0, commands: 0, buildsIssued: 0, buildsPlaced: 0, buildsFailed: 0, placementFailures: 0, unitsQueued: 0,
    researchQueued: 0, attacksLaunched: 0, retreats: 0, defenses: 0, workerDefenses: 0, abilitiesCast: 0,
    repairsIssued: 0, expansions: 0, assists: 0,
  };
  readonly log: string[] = [];
  mode: ArmyMode = 'rally';
  attackTarget: Vec2 | null = null;

  private readonly rng: Rng;
  private readonly keepLog: boolean;
  private nextThinkTick = 1; // tick 0: economy has not computed pop/income yet
  private intents: BuildIntent[] = [];
  private badTiles = new Map<string, number>();         // "defId:x,y" → game time until which the spot is avoided
  private unitOrders = new Map<EntityId, { key: string; time: number }>();
  private rallyKey = new Map<EntityId, string>();
  private workerDefenders = new Set<EntityId>();
  private scoutPoints: Vec2[] = [];
  private scoutIdx = 0;
  private lastAlert: { pos: Vec2; time: number } | null = null;
  private modeBeforeDefense: ArmyMode = 'rally';
  private expansionScout: { workerId: EntityId; target: Vec2; until: number } | null = null;
  private unsub: Array<() => void> = [];

  constructor(private readonly world: World, opts: HospitalBotOptions = {}) {
    this.playerId = opts.playerId ?? 1;
    const me = world.player(this.playerId);
    const enemy = opts.enemyId ?? world.activePlayers().find((p) => world.isEnemy(me.id, p.id))?.id;
    if (enemy == null) throw new Error(`HospitalBot: no enemy player for player ${this.playerId}`);
    this.enemyId = enemy;
    this.strength = opts.strength ?? 'medium';
    this.config = { ...BOT_PRESETS[this.strength], ...(opts.overrides ?? {}) };
    this.rng = world.rng.fork(0xb07 + this.playerId * 131 + (opts.seed ?? 0));
    this.keepLog = !!opts.log;
    this.unsub.push(world.events.on('underAttack', (ev) => {
      if (ev.playerId === this.playerId) this.lastAlert = { pos: { x: ev.pos.x, y: ev.pos.y }, time: world.time };
    }));
    this.buildScoutPoints();
  }

  /** Call once per simulation tick, before world.step(). Thinks every `thinkInterval` seconds. */
  update(): void {
    const w = this.world;
    if (w.rules.gameOver) return;
    const me = w.players.get(this.playerId);
    if (!me || me.defeated) return;
    if (w.tick < this.nextThinkTick) return;
    this.nextThinkTick = w.tick + Math.max(1, Math.round(this.config.thinkInterval / w.dt));
    this.think();
  }

  dispose(): void { for (const u of this.unsub) u(); this.unsub = []; }

  describe(): string {
    const s = this.stats;
    return `bot[${this.strength}] mode=${this.mode} attacks=${s.attacksLaunched} retreats=${s.retreats} defenses=${s.defenses} builds=${s.buildsPlaced}/${s.buildsIssued} (failed ${s.buildsFailed}, no-spot ${s.placementFailures}) units=${s.unitsQueued} research=${s.researchQueued} abilities=${s.abilitiesCast} repairs=${s.repairsIssued} expansions=${s.expansions}`;
  }

  // ───────────────────────────── main loop ─────────────────────────────
  private think(): void {
    this.stats.thinks++;
    const s = this.snapshot();
    this.updateIntents(s);
    const budget = this.budget(s);
    if (this.config.useAbilities) this.useAbilities(s);
    this.manageWorkers(s);
    this.trainWorkers(s, budget);
    this.manageSupply(s, budget);
    this.manageExpansion(s, budget);
    this.buildOrder(s, budget);
    this.manageResearch(s, budget);
    this.trainArmy(s, budget);
    this.setRallies(s);
    this.manageArmy(s);
  }

  private issue(cmd: Command): void { this.stats.commands++; this.world.issue(cmd); }
  private note(msg: string): void {
    if (!this.keepLog) return;
    this.log.push(`[${this.world.time.toFixed(1)}] ${msg}`);
    if (this.log.length > 400) this.log.splice(0, 100);
  }

  private snapshot(): Snapshot {
    const w = this.world, pid = this.playerId;
    const me = w.player(pid);
    const buildings: Entity[] = [], workers: Entity[] = [], army: Entity[] = [], hqs: Entity[] = [], nodes: Entity[] = [];
    const visibleEnemies: Entity[] = [];
    const count = new Map<string, number>(), done = new Map<string, number>(), queuedUnits = new Map<string, number>();
    for (const e of w.list) {
      if (!e.alive) continue;
      if (e.kind === 'resource') { if (e.resource && e.resource.amount > 0) nodes.push(e); continue; }
      if (e.owner === pid) {
        if (e.kind === 'building') {
          buildings.push(e);
          count.set(e.defId, (count.get(e.defId) ?? 0) + 1);
          if (!e.construction) {
            done.set(e.defId, (done.get(e.defId) ?? 0) + 1);
            if ((e.def as BuildingDef).dropoff) hqs.push(e);
          }
          for (const it of e.production?.queue ?? []) if (it.kind === 'unit') queuedUnits.set(it.defId, (queuedUnits.get(it.defId) ?? 0) + 1);
        } else if (e.gatherer) workers.push(e);
        else army.push(e);
      } else if (w.isEnemy(pid, e.owner) && w.vision.isEntityVisible(pid, e)) visibleEnemies.push(e);
    }
    for (const it of this.intents) count.set(it.defId, (count.get(it.defId) ?? 0) + 1);
    const mainHq = hqs[0] ?? buildings.find((b) => b.defId === HQ) ?? null;
    const base = mainHq ? { x: mainHq.pos.x, y: mainHq.pos.y } : buildings[0] ? { ...buildings[0].pos } : { ...me.startPos };
    const threats: Entity[] = [];
    const R = this.config.defenseRadius;
    for (const e of visibleEnemies) {
      if (e.kind !== 'unit') continue;
      for (const b of buildings) if (w.edgeDistance(e, b) <= R) { threats.push(e); break; }
    }
    return { me, time: w.time, hqs, mainHq, base, buildings, count, done, workers, army, queuedUnits, nodes, visibleEnemies, threats };
  }

  private budget(s: Snapshot): Budget {
    const b: Budget = { matter: s.me.resources.matter, energy: s.me.resources.energy };
    for (const it of this.intents) deduct(b, it.cost); // cost is paid when the foundation is placed
    return b;
  }

  // ───────────────────────────── construction bookkeeping ─────────────────────────────
  private updateIntents(s: Snapshot): void {
    const w = this.world;
    for (const [k, until] of [...this.badTiles]) if (until <= s.time) this.badTiles.delete(k);
    this.intents = this.intents.filter((it) => {
      const placed = s.buildings.find((b) => b.defId === it.defId && b.tile && b.tile.x === it.tile.x && b.tile.y === it.tile.y);
      if (placed) {
        this.stats.buildsPlaced++;
        this.note(`placed ${it.defId} at ${it.tile.x},${it.tile.y}`);
        if (this.config.assistConstruction && placed.construction && [HQ, DEPOT, LAB, PHARM].includes(it.defId)) this.assist(s, placed, it.workerId);
        return false;
      }
      const worker = w.getAlive(it.workerId);
      const o = worker?.orders[0];
      const stillGoing = !!o && o.type === 'build' && o.defId === it.defId && o.tile.x === it.tile.x && o.tile.y === it.tile.y;
      const age = s.time - it.issuedAt;
      if (age < 1) return true; // command not processed yet / grace
      if (!stillGoing || s.time > it.deadline) {
        this.stats.buildsFailed++;
        this.badTiles.set(`${it.defId}:${it.tile.x},${it.tile.y}`, s.time + 45);
        this.note(`build ${it.defId} at ${it.tile.x},${it.tile.y} failed (${!worker ? 'worker dead' : stillGoing ? 'timeout' : `order=${o?.type ?? 'none'}`})`);
        if (worker && stillGoing) this.issue({ type: 'stop', playerId: this.playerId, unitIds: [worker.id] }); // free the stuck builder
        return false;
      }
      return true;
    });
    // Foundations without an active builder (builder died / wandered off) get a fresh worker.
    for (const b of s.buildings) {
      if (!b.construction) continue;
      if (this.builderOf(s, b)) continue;
      if (s.threats.some((t) => dist(t.pos, b.pos) < 8)) continue;
      const wk = this.pickWorker(s, b.pos, new Set());
      if (wk) { this.issue({ type: 'smart', playerId: this.playerId, unitIds: [wk.id], target: { ...b.pos }, targetId: b.id }); this.note(`resume construction of ${b.defId}#${b.id} with #${wk.id}`); }
    }
  }

  private builderOf(s: Snapshot, b: Entity): Entity | null {
    for (const wk of s.workers) {
      const o = wk.orders[0];
      if (!o) continue;
      if (o.type === 'construct' && o.targetId === b.id) return wk;
      if (o.type === 'build' && (o.buildingId === b.id || (b.tile && o.defId === b.defId && o.tile.x === b.tile.x && o.tile.y === b.tile.y))) return wk;
      if (o.type === 'repair' && o.targetId === b.id) return wk;
    }
    return null;
  }

  private assist(s: Snapshot, b: Entity, builderId: EntityId): void {
    const wk = this.pickWorker(s, b.pos, new Set([builderId]));
    if (!wk) return;
    this.issue({ type: 'smart', playerId: this.playerId, unitIds: [wk.id], target: { ...b.pos }, targetId: b.id });
    this.stats.assists++;
  }

  /** A worker that is free to leave its job: gathering (prefer empty-handed) or idle, nearest to `near`. */
  private pickWorker(s: Snapshot, near: Vec2, exclude: Set<EntityId>): Entity | null {
    const busy = new Set<EntityId>(this.intents.map((i) => i.workerId));
    let best: Entity | null = null, bestScore = Infinity;
    for (const wk of s.workers) {
      if (exclude.has(wk.id) || busy.has(wk.id) || this.workerDefenders.has(wk.id)) continue;
      const o = wk.orders[0];
      if (o && o.type !== 'gather' && o.type !== 'move' && o.type !== 'returnCargo') continue;
      const carrying = wk.gatherer?.carrying ?? 0;
      const score = dist(wk.pos, near) + (carrying > 0 ? 6 : 0) + (o ? 0 : -3);
      if (score < bestScore) { bestScore = score; best = wk; }
    }
    return best;
  }

  /** Issue a build command for `defId`, choosing a spot with the spiral search. Returns true on success. */
  private tryBuild(s: Snapshot, budget: Budget, defId: string, kind: BuildKind, anchor: Vec2, maxRadius = 16): boolean {
    const def = BUILDING_DEFS[defId];
    if (!def || !affordable(budget, def.cost)) return false;
    if (!this.world.economy.meetsRequirements(this.playerId, def.requires)) return false;
    const worker = this.pickWorker(s, anchor, new Set());
    if (!worker) return false;
    const tile = this.findSpotIn(s, defId, anchor, worker.id, kind, maxRadius);
    if (!tile) { this.stats.placementFailures++; this.note(`no spot for ${defId} near ${anchor.x.toFixed(0)},${anchor.y.toFixed(0)}`); return false; }
    this.issue({ type: 'build', playerId: this.playerId, unitIds: [worker.id], defId, tile });
    const travel = dist(worker.pos, footprintCenter(tile, def.footprint.w, def.footprint.h)) / Math.max(0.5, worker.stats.speed);
    this.intents.push({ defId, tile, workerId: worker.id, issuedAt: s.time, deadline: s.time + 15 + travel * 1.8, cost: { ...def.cost }, kind });
    s.count.set(defId, (s.count.get(defId) ?? 0) + 1);
    deduct(budget, def.cost);
    this.stats.buildsIssued++;
    this.note(`build ${defId} at ${tile.x},${tile.y} with #${worker.id}`);
    return true;
  }

  // ───────────────────────────── placement (spiral search) ─────────────────────────────
  /**
   * Spiral outward (rings of growing Chebyshev radius) from `anchor`; in the first ring with any valid tile,
   * return the candidate closest to the anchor. Validity = economy.canPlaceBuilding(...).ok + our own layout
   * rules: no overlap with pending build intents, a 1-tile walkable margin, and (except expansions) staying
   * out of the worker paths between drop-offs and their caches. Falls back to relaxed rules.
   */
  findSpot(defId: string, anchor: Vec2, kind: BuildKind = 'base', builderId?: EntityId, maxRadius = 16): TilePos | null {
    return this.findSpotIn(this.snapshot(), defId, anchor, builderId, kind, maxRadius);
  }

  private findSpotIn(snap: Snapshot, defId: string, anchor: Vec2, builderId: EntityId | undefined, kind: BuildKind, maxRadius: number): TilePos | null {
    const def = BUILDING_DEFS[defId];
    if (!def) return null;
    for (const strict of [true, false]) {
      const t = this.spiral(snap, def, anchor, builderId, kind, maxRadius, strict);
      if (t) return t;
    }
    return null;
  }

  private spiral(s: Snapshot, def: BuildingDef, anchor: Vec2, builderId: EntityId | undefined, kind: BuildKind, maxRadius: number, strict: boolean): TilePos | null {
    const { w, h } = def.footprint;
    const ax = Math.round(anchor.x - w / 2), ay = Math.round(anchor.y - h / 2);
    const lines = kind === 'expansion' ? [] : this.workerLines(s);
    for (let r = 0; r <= maxRadius; r++) {
      let best: TilePos | null = null, bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tile = { x: ax + dx, y: ay + dy };
        const c = footprintCenter(tile, w, h);
        const d = dist(c, anchor);
        if (d >= bestD) continue;
        if (this.badTiles.has(`${def.id}:${tile.x},${tile.y}`)) continue;
        if (!this.spotOk(s, def, tile, builderId, kind, lines, strict)) continue;
        best = tile; bestD = d;
      }
      if (best) return best;
    }
    return null;
  }

  /** Segments drop-off → cache that workers walk; buildings must not sit on them. */
  private workerLines(s: Snapshot): Array<[Vec2, Vec2]> {
    const out: Array<[Vec2, Vec2]> = [];
    const drops = s.buildings.filter((b) => b.defId === HQ);
    for (const d of drops) for (const n of s.nodes) if (dist(d.pos, n.pos) <= LOCAL_NODE_RANGE + 2) out.push([d.pos, n.pos]);
    return out;
  }

  private spotOk(s: Snapshot, def: BuildingDef, tile: TilePos, builderId: EntityId | undefined, kind: BuildKind, lines: Array<[Vec2, Vec2]>, strict: boolean): boolean {
    const w = this.world, map = w.map;
    const { w: fw, h: fh } = def.footprint;
    if (tile.x < 1 || tile.y < 1 || tile.x + fw > map.width - 1 || tile.y + fh > map.height - 1) return false;
    const rect = { x: tile.x, y: tile.y, w: fw, h: fh };
    const margin = strict ? 1 : 0;
    // pending intents (foundations not placed yet are invisible to canPlaceBuilding)
    for (const it of this.intents) {
      const od = BUILDING_DEFS[it.defId];
      if (od && rectsOverlapOrTouch(rect, it.tile, od.footprint, Math.max(margin, 0))) return false;
    }
    const center = footprintCenter(tile, fw, fh);
    const half = Math.max(fw, fh) / 2;
    if (kind !== 'expansion') {
      for (const [a, b] of lines) if (segPointDist(a, b, center) < half + (strict ? 1.6 : 0.9)) return false;
      for (const n of s.nodes) {
        const nr = w.footRect(n);
        if (nr && rectGap(rect, nr) < (strict ? 2 : 1)) return false;
      }
    } else {
      for (const n of s.nodes) {
        const nr = w.footRect(n);
        if (nr && rectGap(rect, nr) < 2.5) return false;
      }
    }
    if (!w.economy.canPlaceBuilding(this.playerId, def.id, tile, builderId).ok) return false;
    if (strict) {
      // keep a walkable 1-tile ring so units never get boxed in between buildings
      for (let y = tile.y - 1; y <= tile.y + fh; y++) for (let x = tile.x - 1; x <= tile.x + fw; x++) {
        if (x >= tile.x && x < tile.x + fw && y >= tile.y && y < tile.y + fh) continue;
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
        if (map.blocked[y * map.width + x]) return false;
        if (!w.movement.isWalkable({ x: x + 0.5, y: y + 0.5 })) return false;
      }
    }
    return true;
  }

  // ───────────────────────────── workers & economy ─────────────────────────────
  private localNodes(s: Snapshot): Entity[] {
    return s.nodes.filter((n) => s.hqs.some((h) => dist(h.pos, n.pos) <= LOCAL_NODE_RANGE));
  }

  private manageWorkers(s: Snapshot): void {
    const w = this.world;
    // release worker defenders once the base is safe
    if (this.workerDefenders.size) {
      const hot = s.threats.some((t) => s.hqs.some((h) => dist(h.pos, t.pos) < 14));
      for (const id of [...this.workerDefenders]) {
        const wk = w.getAlive(id);
        if (!wk) { this.workerDefenders.delete(id); continue; }
        if (!hot || wk.hp < wk.stats.maxHp * 0.35) { this.workerDefenders.delete(id); this.issue({ type: 'stop', playerId: this.playerId, unitIds: [id] }); }
      }
    }
    // gather assignment: ≤ 3 per cache, nodes near completed drop-offs first
    const assigned = new Map<EntityId, number>();
    for (const wk of s.workers) {
      const nid = wk.orders[0]?.type === 'gather' ? (wk.gatherer?.nodeId ?? (wk.orders[0] as { targetId: EntityId }).targetId) : null;
      if (nid != null) assigned.set(nid, (assigned.get(nid) ?? 0) + 1);
    }
    const local = this.localNodes(s);
    const pool = local.length ? local : s.nodes;
    const busy = new Set(this.intents.map((i) => i.workerId));
    for (const wk of s.workers) {
      if (wk.orders.length || busy.has(wk.id) || this.workerDefenders.has(wk.id)) continue;
      // idle worker
      if ((wk.gatherer?.carrying ?? 0) > 0 && s.hqs.length) { this.issue({ type: 'returnCargo', playerId: this.playerId, unitIds: [wk.id] }); continue; }
      let best: Entity | null = null, bestScore = Infinity;
      for (const n of pool) {
        const a = assigned.get(n.id) ?? 0;
        const dropD = s.hqs.length ? Math.min(...s.hqs.map((h) => dist(h.pos, n.pos))) : 0;
        const score = (a >= 3 ? 1000 : a * 30) + dropD + dist(wk.pos, n.pos) * 0.25;
        if (score < bestScore) { bestScore = score; best = n; }
      }
      if (!best) continue;
      assigned.set(best.id, (assigned.get(best.id) ?? 0) + 1);
      this.issue({ type: 'gather', playerId: this.playerId, unitIds: [wk.id], targetId: best.id });
    }
    // repairs (only when the base is calm)
    if (this.config.repair && s.threats.length === 0) {
      let repairing = s.workers.filter((wk) => wk.orders[0]?.type === 'repair').length;
      for (const b of s.buildings) {
        if (repairing >= 2) break;
        if (b.construction || b.hp >= b.stats.maxHp * 0.6) continue;
        if (s.workers.some((wk) => wk.orders[0]?.type === 'repair' && (wk.orders[0] as { targetId: EntityId }).targetId === b.id)) continue;
        const wk = this.pickWorker(s, b.pos, new Set());
        if (!wk) break;
        this.issue({ type: 'repair', playerId: this.playerId, unitIds: [wk.id], targetId: b.id });
        this.stats.repairsIssued++;
        repairing++;
      }
    }
    // emergency worker defence
    if (this.config.workerDefense && s.hqs.length) {
      const near = s.threats.filter((t) => !t.tags.has('air') && s.hqs.some((h) => dist(h.pos, t.pos) < 10));
      const armyNear = s.army.filter((u) => dist(u.pos, s.base) < 18).length;
      if (near.length && armyNear < near.length) {
        const want = Math.min(s.workers.length - 2, near.length * 2) - this.workerDefenders.size;
        if (want > 0) {
          const center = centroid(near);
          const cands = s.workers.filter((wk) => !this.workerDefenders.has(wk.id) && !busy.has(wk.id) && wk.orders[0]?.type !== 'build' && wk.hp > wk.stats.maxHp * 0.5)
            .sort((a, b) => dist(a.pos, center) - dist(b.pos, center) || a.id - b.id).slice(0, want);
          if (cands.length) {
            for (const c of cands) this.workerDefenders.add(c.id);
            const target = near.slice().sort((a, b) => dist(a.pos, center) - dist(b.pos, center) || a.id - b.id)[0]!;
            this.issue({ type: 'attack', playerId: this.playerId, unitIds: cands.map((c) => c.id), targetId: target.id });
            this.stats.workerDefenses++;
          }
        }
      }
    }
  }

  private trainWorkers(s: Snapshot, budget: Budget): void {
    const extraHqs = Math.max(0, s.hqs.length - 1);
    const target = this.config.workerTarget + extraHqs * 4;
    const have = s.workers.length + (s.queuedUnits.get(WORKER) ?? 0);
    if (have >= target) return;
    const cost = UNIT_DEFS[WORKER]!.cost;
    const maxQ = this.strength === 'weak' ? 1 : 2;
    let missing = target - have;
    for (const hq of s.hqs) {
      if (missing <= 0) break;
      const q = hq.production?.queue.length ?? 0;
      if (q >= maxQ || !affordable(budget, cost)) continue;
      if (!this.world.economy.canTrain(hq, WORKER).ok) continue;
      this.issue({ type: 'train', playerId: this.playerId, buildingId: hq.id, defId: WORKER });
      deduct(budget, cost);
      this.stats.unitsQueued++;
      missing--;
    }
  }

  private manageSupply(s: Snapshot, budget: Budget): void {
    const me = s.me;
    if (me.popCap >= MAX_POP) return;
    const producers = s.buildings.filter((b) => !b.construction && b.production && (b.def as BuildingDef).trains.length).length;
    const pendingWards = (s.count.get(WARD) ?? 0) - (s.done.get(WARD) ?? 0);
    const margin = 2 + producers * 2 + (this.strength === 'strong' ? 2 : 0);
    const free = me.popCap - me.popUsed + pendingWards * 8;
    if (free > margin || me.popCap + pendingWards * 8 >= MAX_POP) return;
    if (pendingWards >= (me.popCap >= 60 ? 2 : 1)) return;
    const cost = BUILDING_DEFS[WARD]!.cost;
    if (!affordable(budget, cost)) { deduct(budget, cost); return; } // save for it: being supply-blocked is worse
    this.tryBuild(s, budget, WARD, 'base', this.buildAnchor(s, 0));
  }

  /** Where regular buildings go: away from the caches, slightly toward the enemy, ~7 tiles from the HQ. */
  private buildAnchor(s: Snapshot, salt: number): Vec2 {
    const enemy = this.world.player(this.enemyId).startPos;
    const toEnemy = normalize(sub(enemy, s.base));
    const local = this.localNodes(s);
    const mineral = local.length ? normalize(sub(centroid(local), s.base)) : { x: 0, y: 0 };
    let dir = normalize({ x: toEnemy.x * 0.6 - mineral.x, y: toEnemy.y * 0.6 - mineral.y });
    if (dir.x === 0 && dir.y === 0) dir = toEnemy.x || toEnemy.y ? toEnemy : { x: 1, y: 0 };
    // alternate sides as the base grows so it doesn't become one long line
    const ang = Math.atan2(dir.y, dir.x) + (salt % 3 === 1 ? 0.6 : salt % 3 === 2 ? -0.6 : 0);
    const d = 7 + Math.min(6, salt * 0.5);
    return this.clampToMap({ x: s.base.x + Math.cos(ang) * d, y: s.base.y + Math.sin(ang) * d });
  }

  private clampToMap(p: Vec2): Vec2 {
    const m = this.world.map;
    return { x: Math.min(m.width - 3, Math.max(3, p.x)), y: Math.min(m.height - 3, Math.max(3, p.y)) };
  }

  private buildOrder(s: Snapshot, budget: Budget): void {
    const c = this.config;
    const have = (id: string) => s.count.get(id) ?? 0;
    const done = (id: string) => s.done.get(id) ?? 0;
    const t = s.time;
    const workers = s.workers.length;
    const needLab = c.depots > 0 || c.research.length > 0 || (c.mix.hosp_uv_lancer ?? 0) > 0;
    const goals: Array<{ id: string; want: number; when: boolean; kind?: BuildKind }> = [
      { id: PHARM, want: 1, when: workers >= Math.min(8, c.workerTarget - 1) || t > 100 },
      { id: GEN, want: Math.min(1, c.generators), when: have(PHARM) > 0 },
      { id: LAB, want: needLab ? 1 : 0, when: done(PHARM) > 0 },
      { id: GEN, want: Math.min(2, c.generators), when: have(LAB) > 0 || t > 300 },
      { id: TURRET, want: Math.min(1, c.turrets), when: done(PHARM) > 0 && t > 150, kind: 'turret' },
      { id: DEPOT, want: c.depots, when: done(LAB) > 0 },
      { id: GEN, want: c.generators, when: have(DEPOT) > 0 || (c.depots === 0 && t > 360) },
      { id: TURRET, want: c.turrets, when: (have(DEPOT) > 0 || c.depots === 0) && t > 300, kind: 'turret' },
      { id: PHARM, want: c.pharmacies, when: (have(DEPOT) > 0 || c.depots === 0) && t > 360 },
    ];
    // dynamic scaling once the opening is done: more Pharmacies when matter floats and production is
    // saturated, more Generators when Power is the bottleneck.
    const producers = s.buildings.filter((b) => !b.construction && b.production && b.defId !== HQ && (b.def as BuildingDef).trains.length);
    const saturated = producers.length > 0 && producers.every((b) => (b.production?.queue.length ?? 0) >= this.config.queueDepth);
    const openingDone = have(PHARM) >= c.pharmacies && have(GEN) >= c.generators && (c.depots === 0 || have(DEPOT) >= c.depots);
    if (openingDone && t > 240) {
      goals.push({ id: GEN, want: have(GEN) + 1 <= c.maxGenerators && s.me.resources.energy < 60 && budget.matter > 300 ? have(GEN) + 1 : 0, when: true });
      goals.push({ id: PHARM, want: have(PHARM) + 1 <= c.maxPharmacies && saturated && budget.matter > 450 ? have(PHARM) + 1 : 0, when: true });
    }
    const defending = this.mode === 'defend';
    for (const g of goals) {
      if (!g.when || have(g.id) >= g.want) continue;
      const def = BUILDING_DEFS[g.id]!;
      if (!this.world.economy.meetsRequirements(this.playerId, def.requires)) continue;
      const kind = g.kind ?? 'base';
      const anchor = kind === 'turret' ? this.turretAnchor(s, have(g.id)) : this.buildAnchor(s, s.buildings.length);
      if (affordable(budget, def.cost)) {
        if (this.tryBuild(s, budget, g.id, kind, anchor)) return; // one structure per think
        continue; // no spot / no worker: try the next goal
      }
      // save up for the next structure unless we're busy defending
      if (!defending) deduct(budget, def.cost);
      return;
    }
  }

  private turretAnchor(s: Snapshot, index: number): Vec2 {
    const enemy = this.world.player(this.enemyId).startPos;
    const base = Math.atan2(enemy.y - s.base.y, enemy.x - s.base.x);
    const offsets = [0, 0.75, -0.75, 1.5, -1.5];
    const a = base + (offsets[index % offsets.length] ?? 0);
    return this.clampToMap({ x: s.base.x + Math.cos(a) * 8, y: s.base.y + Math.sin(a) * 8 });
  }

  private manageExpansion(s: Snapshot, budget: Budget): void {
    const pendingHq = this.intents.some((i) => i.defId === HQ) || s.buildings.some((b) => b.defId === HQ && b.construction);
    if (pendingHq) return;
    const noDropoff = s.hqs.length === 0 && !s.buildings.some((b) => b.defId === HQ);
    if (!noDropoff) {
      if (!this.config.expand || s.time < 300) return;
      const local = this.localNodes(s);
      const left = local.reduce((a, n) => a + (n.resource?.amount ?? 0), 0);
      if (local.length > 2 && left > 2500) return;
    }
    if (s.workers.length === 0) return;
    const hqCost = BUILDING_DEFS[HQ]!.cost;
    if (!affordable(budget, hqCost)) { if (!noDropoff && this.mode !== 'defend') deduct(budget, hqCost); return; }
    // clusters of caches not already served by one of our drop-offs and not next to known enemy buildings
    const free = s.nodes.filter((n) => !s.hqs.some((h) => dist(h.pos, n.pos) <= LOCAL_NODE_RANGE));
    const enemyBuildings = s.visibleEnemies.filter((e) => e.kind === 'building');
    const clusters: Entity[][] = [];
    for (const n of free) {
      const cl = clusters.find((c) => c.some((m) => dist(m.pos, n.pos) <= 10));
      if (cl) cl.push(n); else clusters.push([n]);
    }
    let best: { c: Vec2; score: number } | null = null;
    for (const cl of clusters) {
      const c = centroid(cl);
      if (enemyBuildings.some((e) => dist(e.pos, c) < 18)) continue;
      const amount = cl.reduce((a, n) => a + (n.resource?.amount ?? 0), 0);
      if (amount < 1200) continue;
      const score = dist(c, s.base) - Math.min(30, amount / 200);
      if (!best || score < best.score) best = { c, score };
    }
    if (!best) return;
    // Placement needs explored ground: walk a worker over first (a human would scout too).
    const site = best.c;
    if (!this.world.vision.isExplored(this.playerId, site)) {
      const sc = this.expansionScout;
      const scout = sc ? this.world.getAlive(sc.workerId) : undefined;
      if (scout && sc && s.time < sc.until && dist(sc.target, site) < 4) return; // on its way
      const wk = this.pickWorker(s, site, new Set());
      if (!wk) return;
      const travel = dist(wk.pos, site) / Math.max(0.5, wk.stats.speed);
      this.expansionScout = { workerId: wk.id, target: { ...site }, until: s.time + 20 + travel * 2 };
      this.issue({ type: 'move', playerId: this.playerId, unitIds: [wk.id], target: { ...site } });
      this.note(`scouting expansion site ${site.x.toFixed(0)},${site.y.toFixed(0)} with #${wk.id}`);
      return;
    }
    this.expansionScout = null;
    if (this.tryBuild(s, budget, HQ, 'expansion', site, 10)) { this.stats.expansions++; this.note(`expanding near ${site.x.toFixed(0)},${site.y.toFixed(0)}`); }
  }

  private manageResearch(s: Snapshot, budget: Budget): void {
    const w = this.world, me = s.me;
    for (const up of this.config.research) {
      const def = UPGRADE_DEFS[up];
      if (!def || me.upgrades.has(up) || me.researching.has(up)) continue;
      if (!w.economy.meetsRequirements(this.playerId, def.requires)) continue;
      const lab = s.buildings.find((b) => !b.construction && (b.def as BuildingDef).researches.includes(up) && (b.production?.queue.length ?? 0) === 0);
      if (!lab) continue;
      if (lab.defId === HQ && s.workers.length < this.config.workerTarget) continue; // don't block worker production
      if (!affordable(budget, def.cost)) { if (this.mode !== 'defend' && s.army.length >= 6) deduct(budget, def.cost); return; }
      if (!w.economy.canResearch(lab, up).ok) continue;
      this.issue({ type: 'research', playerId: this.playerId, buildingId: lab.id, upgradeId: up });
      deduct(budget, def.cost);
      this.stats.researchQueued++;
      this.note(`research ${up}`);
      return;
    }
  }

  private trainArmy(s: Snapshot, budget: Budget): void {
    const w = this.world;
    const producers = s.buildings
      .filter((b) => !b.construction && b.production && b.defId !== HQ && (b.def as BuildingDef).trains.length)
      .sort((a, b) => (BUILDING_DEFS[b.defId]?.footprint.w ?? 0) - (BUILDING_DEFS[a.defId]?.footprint.w ?? 0) || a.id - b.id); // depot first
    if (!producers.length) return;
    const mix = { ...this.config.mix };
    if (s.visibleEnemies.filter((e) => e.tags.has('air')).length >= 2) mix.hosp_sterilizer_drone = Math.max(mix.hosp_sterilizer_drone ?? 0, 2);
    const counts = new Map<string, number>();
    for (const u of s.army) counts.set(u.defId, (counts.get(u.defId) ?? 0) + 1);
    for (const [id, n] of s.queuedUnits) if (id !== WORKER) counts.set(id, (counts.get(id) ?? 0) + n);
    for (const b of producers) {
      const q = b.production!.queue.length;
      if (q >= this.config.queueDepth) continue;
      const trains = (b.def as BuildingDef).trains.filter((id) => (mix[id] ?? 0) > 0 && w.economy.meetsRequirements(this.playerId, UNIT_DEFS[id]?.requires ?? []));
      if (!trains.length) continue;
      const wsum = trains.reduce((a, id) => a + (mix[id] ?? 0), 0) || 1;
      const local = trains.reduce((a, id) => a + (counts.get(id) ?? 0), 0);
      let pick: string | null = null, bestDef = -Infinity;
      for (const id of trains) {
        const deficit = ((mix[id] ?? 0) / wsum) * (local + 1) - (counts.get(id) ?? 0);
        if (deficit > bestDef) { bestDef = deficit; pick = id; }
      }
      if (!pick) continue;
      const def = UNIT_DEFS[pick]!;
      if (!affordable(budget, def.cost)) {
        // cheaper fallback when only the energy is missing, otherwise save for it
        const cheap = trains.filter((id) => id !== pick && affordable(budget, UNIT_DEFS[id]!.cost) && !(UNIT_DEFS[id]!.cost.energy))
          .sort((a, b2) => (counts.get(a) ?? 0) - (counts.get(b2) ?? 0))[0];
        if (cheap && budget.matter >= (def.cost.matter ?? 0) + (UNIT_DEFS[cheap]!.cost.matter ?? 0) * 0.5 && budget.energy < (def.cost.energy ?? 0)) {
          pick = cheap;
        } else { if (q === 0) deduct(budget, def.cost); continue; }
      }
      const unit = UNIT_DEFS[pick]!;
      if (!w.economy.canTrain(b, pick).ok) continue;
      this.issue({ type: 'train', playerId: this.playerId, buildingId: b.id, defId: pick });
      deduct(budget, unit.cost);
      counts.set(pick, (counts.get(pick) ?? 0) + 1);
      this.stats.unitsQueued++;
    }
  }

  private stagingPoint(s: Snapshot): Vec2 {
    const enemy = this.world.player(this.enemyId).startPos;
    const dir = normalize(sub(enemy, s.base));
    const p = this.clampToMap({ x: s.base.x + dir.x * 10, y: s.base.y + dir.y * 10 });
    return this.world.movement.nearestWalkable(p, 8) ?? p;
  }

  private setRallies(s: Snapshot): void {
    const staging = this.stagingPoint(s);
    const key = `${Math.round(staging.x)},${Math.round(staging.y)}`;
    const ids = s.buildings.filter((b) => !b.construction && b.defId !== HQ && (b.def as BuildingDef).trains.length && this.rallyKey.get(b.id) !== key).map((b) => b.id);
    if (!ids.length) return;
    this.issue({ type: 'setRally', playerId: this.playerId, buildingIds: ids, target: staging });
    for (const id of ids) this.rallyKey.set(id, key);
  }

  // ───────────────────────────── abilities ─────────────────────────────
  private useAbilities(s: Snapshot): void {
    const w = this.world;
    for (const hq of s.hqs) {
      if (!(hq.def as BuildingDef).abilities.includes('emergency_supply')) continue;
      if ((hq.cooldowns['emergency_supply'] ?? 0) > 0) continue;
      if (!w.abilities.canCast(hq, 'emergency_supply').ok) continue;
      this.issue({ type: 'buildingAbility', playerId: this.playerId, buildingId: hq.id, abilityId: 'emergency_supply' });
      this.stats.abilitiesCast++;
      break;
    }
    const enemiesUnits = s.visibleEnemies.filter((e) => e.kind === 'unit');
    if (enemiesUnits.length < 3) return;
    for (const u of s.army) {
      const unitDef = u.def as UnitDef;
      if (!unitDef.abilities.includes('uv_flare') || (u.cooldowns['uv_flare'] ?? 0) > 0) continue;
      const inRange = enemiesUnits.filter((e) => dist(e.pos, u.pos) <= 7 + u.radius);
      if (inRange.length < 3) continue;
      let best: Entity | null = null, bestN = 0;
      for (const e of inRange) {
        const n = inRange.filter((o) => dist(o.pos, e.pos) <= 2.5).length;
        if (n > bestN) { bestN = n; best = e; }
      }
      if (best && bestN >= 3) {
        this.issue({ type: 'ability', playerId: this.playerId, unitIds: [u.id], abilityId: 'uv_flare', target: { ...best.pos } });
        this.unitOrders.delete(u.id);
        this.stats.abilitiesCast++;
      }
    }
  }

  // ───────────────────────────── army ─────────────────────────────
  private buildScoutPoints(): void {
    const w = this.world;
    const enemyStart = w.player(this.enemyId).startPos;
    const pts: Vec2[] = [];
    const push = (p: Vec2) => { if (!pts.some((q) => dist(q, p) < 8)) pts.push({ x: p.x, y: p.y }); };
    push(enemyStart);
    for (const sl of w.map.slots) if (sl.id !== this.playerId) push(sl.start);
    for (const r of w.map.resources) push(r.pos);
    const mine = w.player(this.playerId).startPos;
    pts.sort((a, b) => dist(a, enemyStart) - dist(b, enemyStart) || dist(b, mine) - dist(a, mine));
    // light shuffle of everything after the enemy start so different seeds scout differently
    for (let i = pts.length - 1; i > 1; i--) { const j = 1 + Math.floor(this.rng.next() * i); [pts[i], pts[j]] = [pts[j]!, pts[i]!]; }
    this.scoutPoints = pts;
  }

  private orderArmy(units: Entity[], type: 'attackMove' | 'move', target: Vec2, force = false): void {
    const now = this.world.time;
    const key = `${type}:${Math.round(target.x)},${Math.round(target.y)}`;
    const ids: EntityId[] = [];
    for (const u of units) {
      const prev = this.unitOrders.get(u.id);
      const idle = u.orders.length === 0;
      const cur = u.orders[0];
      if (!force && cur?.type === 'attack' && this.world.getAlive(cur.targetId)) continue; // busy with an explicit target
      if (!force && prev && prev.key === key && !idle) continue;
      if (!force && prev && prev.key === key && idle && dist(u.pos, target) < 6) continue; // already there
      if (!force && prev && prev.key !== key && now - prev.time < this.config.reorderInterval && !idle) continue;
      ids.push(u.id);
      this.unitOrders.set(u.id, { key, time: now });
    }
    if (ids.length) this.issue({ type, playerId: this.playerId, unitIds: ids, target: { x: target.x, y: target.y } });
  }

  private manageArmy(s: Snapshot): void {
    const w = this.world, c = this.config;
    for (const id of [...this.unitOrders.keys()]) if (!w.getAlive(id)) this.unitOrders.delete(id);
    const army = s.army;
    const staging = this.stagingPoint(s);

    // defend: anything hitting the base pulls the whole army home
    const recentAlert = this.lastAlert && s.time - this.lastAlert.time < 6 ? this.lastAlert : null;
    if (s.threats.length) {
      if (this.mode !== 'defend') { this.modeBeforeDefense = this.mode; this.mode = 'defend'; this.stats.defenses++; this.note(`defending vs ${s.threats.length} threats`); }
      const hqPos = s.base;
      const focus = s.threats.slice().sort((a, b) => dist(a.pos, hqPos) - dist(b.pos, hqPos) || a.id - b.id)[0]!;
      const target = { x: Math.round(focus.pos.x), y: Math.round(focus.pos.y) };
      // units already fighting near the threat keep their current target
      const free = army.filter((u) => !(u.combat?.targetId != null && dist(u.pos, focus.pos) < 12));
      this.orderArmy(free, 'attackMove', target);
      return;
    }
    if (this.mode === 'defend') {
      this.mode = this.modeBeforeDefense === 'attack' && army.length >= c.attackArmySize * Math.max(0.5, c.retreatFraction) ? 'attack' : 'rally';
      if (this.mode === 'rally') this.orderArmy(army, 'attackMove', staging, true);
    }
    if (recentAlert && this.mode === 'rally' && dist(recentAlert.pos, s.base) < c.defenseRadius + 10) {
      // attacked by something we can't see (e.g. artillery): move up to the alert position
      this.orderArmy(army, 'attackMove', recentAlert.pos);
      return;
    }

    if (this.mode === 'rally') {
      const ready = army.length >= c.attackArmySize && s.time >= c.minAttackTime;
      const maxed = s.me.popUsed >= MAX_POP - 10;
      if (ready || maxed) {
        this.mode = 'attack';
        this.attackTarget = this.chooseTarget(s, army);
        this.stats.attacksLaunched++;
        this.note(`attack #${this.stats.attacksLaunched} with ${army.length} units → ${this.attackTarget.x.toFixed(0)},${this.attackTarget.y.toFixed(0)}`);
        this.orderArmy(army, 'attackMove', this.attackTarget, true);
        return;
      }
      // idle units wander home to the staging point
      const strays = army.filter((u) => u.orders.length === 0 && dist(u.pos, staging) > 7);
      if (strays.length) this.orderArmy(strays, 'attackMove', staging);
      return;
    }

    // attack mode
    const minArmy = c.attackArmySize * c.retreatFraction;
    if (c.retreatFraction > 0 && army.length < minArmy && s.me.popUsed < MAX_POP - 30) {
      this.mode = 'rally';
      this.stats.retreats++;
      this.note(`retreat with ${army.length} units`);
      this.orderArmy(army, 'move', staging, true);
      this.attackTarget = null;
      return;
    }
    let target = this.attackTarget ?? this.chooseTarget(s, army);
    const near = army.filter((u) => dist(u.pos, target) < 7);
    const enemyThere = s.visibleEnemies.some((e) => e.kind === 'building' && dist(e.pos, target) < 10);
    if (near.length > 0 && !enemyThere) {
      // target area clear → mark scouted, pick the next one
      this.markScouted(target);
      target = this.chooseTarget(s, army);
    }
    this.attackTarget = target;
    // Units that arrived and went idle next to a building they don't auto-acquire get an explicit attack order.
    const idleNear = army.filter((u) => u.orders.length === 0 && u.combat && u.combat.targetId == null && dist(u.pos, target) < 12);
    if (idleNear.length) {
      const c = centroid(idleNear);
      const b = s.visibleEnemies.filter((e) => e.kind === 'building' && dist(e.pos, c) < 14).sort((x, y) => dist(x.pos, c) - dist(y.pos, c) || x.id - y.id)[0];
      if (b) {
        this.issue({ type: 'attack', playerId: this.playerId, unitIds: idleNear.map((u) => u.id), targetId: b.id });
        for (const u of idleNear) this.unitOrders.set(u.id, { key: `attack:${b.id}`, time: s.time });
      }
    }
    this.orderArmy(army, 'attackMove', target);
  }

  private markScouted(p: Vec2): void {
    const i = this.scoutPoints.findIndex((q) => dist(q, p) < 8);
    if (i >= 0 && i === this.scoutIdx % this.scoutPoints.length) this.scoutIdx++;
  }

  /** Nearest known enemy building to the army; else the next scouting point (enemy start first). */
  private chooseTarget(s: Snapshot, army: Entity[]): Vec2 {
    const from = army.length ? centroid(army) : s.base;
    const buildings = s.visibleEnemies.filter((e) => e.kind === 'building')
      .sort((a, b) => dist(a.pos, from) - dist(b.pos, from) || a.id - b.id);
    if (buildings[0]) return { x: buildings[0].pos.x, y: buildings[0].pos.y };
    if (!this.scoutPoints.length) return { ...this.world.player(this.enemyId).startPos };
    const p = this.scoutPoints[this.scoutIdx % this.scoutPoints.length]!;
    const q = this.world.movement.nearestWalkable(p, 6) ?? p;
    return { x: q.x, y: q.y };
  }
}

function rectsOverlapOrTouch(a: { x: number; y: number; w: number; h: number }, t: TilePos, fp: { w: number; h: number }, margin: number): boolean {
  return a.x < t.x + fp.w + margin && t.x < a.x + a.w + margin && a.y < t.y + fp.h + margin && t.y < a.y + a.h + margin;
}

export function createHospitalBot(world: World, opts: HospitalBotOptions = {}): HospitalBot {
  return new HospitalBot(world, opts);
}
