/**
 * [ai] OWNER: AI agent. The Contagion's opponent AI. Plays through world.issue(...) exactly like a human
 * (same costs, rules and fog), except where a difficulty explicitly grants a bonus (player.gatherMul).
 *
 * Structure (src/ai/):
 *   brain.ts        shared state: flags, profile, personality, controlled units, roles, pending builds,
 *                   bases/sites, per-tick snapshot, command budget (APM), error logging
 *   memory.ts       enemy intel seen through our own fog (structures, army composition)
 *   macro.ts        all spending: drones, nests, vats, expansions, tech plan, spitters, research, army
 *   composition.ts  adaptive army mix (counters to what has been seen)
 *   workers.ts      keep drones mining, spread over caches/bases
 *   army.ts         staging, attack waves, squad path-following, retreat, reinforcements, micro
 *   defense.ts      threat response, squad recall, worker militia, doomed-foundation cancel
 *   scout.ts        early scout + periodic re-scouting
 *   placement.ts    own building-placement search (via economy.canPlaceBuilding)
 *   personality.ts  swarm / balanced / tech plans · profile.ts difficulty profiles
 *
 * Managers think on staggered ticks (~0.25–1 s depending on difficulty); each runs inside its own
 * try/catch so the AI never throws into the game loop (errors are logged once per manager).
 *
 * Units the AI controls: its starting forces and everything it trains. sendWave() units and any unit
 * carrying a scriptTag (campaign 'boss', 'scripted', ...) are left to the scripts.
 */
import { TICK_DT } from '../config';
import { clone } from '../core/math';
import type { Difficulty, PlayerId, Vec2 } from '../core/types';
import type { World } from '../sim/World';
import { ArmyManager } from './army';
import { Brain } from './brain';
import { DefenseManager } from './defense';
import { MacroManager } from './macro';
import { HIVE, PIT, REPLICATOR, SPIRE, type Personality } from './personality';
import { ScoutManager } from './scout';
import { costValue, fmtTime } from './util';
import { WorkerManager } from './workers';

export type { Personality } from './personality';

export interface AiFlags {
  economy: boolean;   // train workers, gather, build supply/energy
  build: boolean;     // construct tech/production buildings
  army: boolean;      // train combat units
  attack: boolean;    // launch attack waves on its own schedule
  expand: boolean;    // take new resource sites
  defend: boolean;    // respond to attacks on its bases
}

export interface AiController {
  readonly playerId: PlayerId;
  difficulty: Difficulty;
  /** Called once per sim tick (before world.step). Throttle internally. */
  update(dt: number): void;
  setFlags(flags: Partial<AiFlags>): void;
  getFlags(): AiFlags;
  /** Campaign hooks */
  sendWave(composition: Record<string, number>, spawnAt: Vec2, target: Vec2): number[]; // spawns units for free (scripted) and attack-moves them; returns ids
  attackNow(target?: Vec2): void;     // launch the current army immediately
  setAttackTarget(target: Vec2 | null): void;
  /** Debug/telemetry for HUD & tests */
  describe(): string;
  /** [save] AI brain state as codec-safe data (see src/sim/save/types.ts). World state is saved separately. */
  save?(): unknown;
  /** [save] Restore brain state on a freshly created controller, after the world has been restored. */
  load?(data: unknown): void;
}

export interface CreateAiOptions {
  difficulty: Difficulty;
  /** force a personality (tests / campaign); default: picked per seed, weighted by difficulty */
  personality?: Personality;
}

/** Telemetry snapshot (tests, debug overlays). */
export interface AiDebugState {
  personality: Personality;
  difficulty: Difficulty;
  phase: string;
  errors: number;
  workers: number;
  army: number;
  armyValue: number;
  wavesLaunched: number;
  squad: { units: number; state: string; target: Vec2 } | null;
  nextWaveAt: number;
  nextWaveSize: number;
  threatValue: number;
  defenseResponses: number;
  scoutTrips: number;
  pendingBuilds: number;
  bases: number;
  staging: Vec2 | null;
  knownEnemyStructures: number;
}

/** A manager on the think grid: runs every `every` cadence steps, `phase` steps out of step with the others. */
interface Slot { name: string; phase: number; every: number; sec: () => number; run: () => void }

const FLAG_KEYS: ReadonlyArray<keyof AiFlags> = ['economy', 'build', 'army', 'attack', 'expand', 'defend'];

export class PathogenAi implements AiController {
  readonly playerId: PlayerId;
  private readonly brain: Brain;
  private readonly macro: MacroManager;
  private readonly workers: WorkerManager;
  private readonly army: ArmyManager;
  private readonly defense: DefenseManager;
  private readonly scout: ScoutManager;
  private readonly slots: Slot[];
  private diff: Difficulty;
  private lastTick = -1;
  private cadence = 5;

  constructor(private readonly world: World, playerId: PlayerId, opts: CreateAiOptions) {
    this.playerId = playerId;
    this.diff = opts.difficulty;
    const b = (this.brain = new Brain(world, playerId, { difficulty: opts.difficulty, personality: opts.personality }));
    this.macro = new MacroManager(b);
    this.workers = new WorkerManager(b);
    this.army = b.army = new ArmyManager(b);
    this.defense = b.defense = new DefenseManager(b);
    this.scout = new ScoutManager(b);
    // Think grid: the AI only thinks every `cadence` ticks (the difficulty's tactical period); managers run
    // on multiples of it, phase-shifted so the expensive ones (army, macro) never share a step.
    const p = () => b.prof;
    this.slots = [
      { name: 'memory', phase: 0, every: 1, sec: () => Math.max(0.5, p().tacticSec * 2), run: () => b.memory.scan() },
      { name: 'defense', phase: 0, every: 1, sec: () => p().tacticSec, run: () => this.defense.think() },
      { name: 'army', phase: 0, every: 1, sec: () => p().thinkSec, run: () => this.army.think() },
      { name: 'macro', phase: 1, every: 1, sec: () => p().thinkSec, run: () => this.macro.think() },
      { name: 'workers', phase: 1, every: 1, sec: () => p().workerSec, run: () => this.workers.think() },
      { name: 'scout', phase: 3, every: 1, sec: () => 1, run: () => this.scout.think() },
    ];
    this.applyDifficulty();
  }

  get difficulty(): Difficulty { return this.diff; }
  set difficulty(d: Difficulty) {
    if (d === this.diff) return;
    this.diff = d;
    this.brain.setDifficulty(d);
    this.applyDifficulty();
  }

  private applyDifficulty(): void {
    try { this.world.player(this.playerId).gatherMul = this.brain.prof.gatherMul; } catch { /* unknown player: nothing to tune */ }
    this.cadence = Math.max(1, Math.round(this.brain.prof.tacticSec / TICK_DT));
    for (const s of this.slots) s.every = Math.max(1, Math.round(s.sec() / (this.cadence * TICK_DT)));
  }

  update(dt: number): void {
    const w = this.world, b = this.brain;
    try {
      if (w.tick === this.lastTick) return; // at most one think pass per sim tick
      this.lastTick = w.tick;
      const p = w.players.get(this.playerId);
      if (w.rules.gameOver || !p || p.defeated) return;
      b.refill(dt > 0 && dt < 1 ? dt : TICK_DT);
      if (!b.initialized) b.init();
      if (w.tick % this.cadence !== 0) return;
      const step = w.tick / this.cadence;
      for (const s of this.slots) {
        if ((step + s.phase) % s.every !== 0) continue;
        try { s.run(); } catch (err) { b.fail(s.name, err); }
      }
    } catch (err) {
      b.fail('update', err);
    }
  }

  /** [save] Everything that steers future decisions, as codec-safe plain data (entity refs → ids). */
  save(): unknown {
    return {
      v: 1, difficulty: this.diff, lastTick: this.lastTick,
      brain: this.brain.saveState(), macro: this.macro.saveState(), workers: this.workers.saveState(),
      army: this.army.saveState(), defense: this.defense.saveState(), scout: this.scout.saveState(),
    };
  }

  /** [save] Restore onto a freshly created controller after the world has been restored. */
  load(data: unknown): void {
    try {
      const d = (data ?? {}) as Record<string, unknown>;
      const diff = d.difficulty as Difficulty | undefined;
      if (diff && diff !== this.diff) {
        this.diff = diff;
        this.brain.setDifficulty(diff);
        // think grid only: the player's gatherMul was restored with the world (missions may override it)
        this.cadence = Math.max(1, Math.round(this.brain.prof.tacticSec / TICK_DT));
        for (const s of this.slots) s.every = Math.max(1, Math.round(s.sec() / (this.cadence * TICK_DT)));
      }
      if (typeof d.lastTick === 'number') this.lastTick = d.lastTick;
      this.brain.loadState(d.brain); // first: bases are needed by the defence state
      this.macro.loadState(d.macro);
      this.workers.loadState(d.workers);
      this.army.loadState(d.army);
      this.defense.loadState(d.defense);
      this.scout.loadState(d.scout);
    } catch (err) { this.brain.fail('load', err); }
  }

  setFlags(flags: Partial<AiFlags>): void {
    for (const k of FLAG_KEYS) if (typeof flags?.[k] === 'boolean') this.brain.flags[k] = flags[k]!;
  }

  getFlags(): AiFlags { return { ...this.brain.flags }; }

  sendWave(composition: Record<string, number>, spawnAt: Vec2, target: Vec2): number[] {
    try { return this.brain.spawnWave(composition, spawnAt, target); } catch (err) { this.brain.fail('sendWave', err); return []; }
  }

  attackNow(target?: Vec2): void {
    try {
      if (!this.brain.initialized) this.brain.init();
      this.army.attackNow(target ? clone(target) : null);
    } catch (err) { this.brain.fail('attackNow', err); }
  }

  setAttackTarget(target: Vec2 | null): void {
    try {
      this.brain.attackOverride = target ? clone(target) : null;
      if (target) this.army.redirect(target);
    } catch (err) { this.brain.fail('setAttackTarget', err); }
  }

  describe(): string {
    try {
      const b = this.brain, s = b.snap();
      let value = 0;
      for (const u of s.army) value += costValue(u.def.kind === 'resource' ? undefined : u.def.cost);
      return `phase: ${this.phase()} · army ${s.army.length} (value ${Math.round(value)}) · workers ${s.workers.length} · income ${Math.round(b.incomePerMin())}/min · next wave ${this.waveText()}`;
    } catch (err) {
      this.brain.fail('describe', err);
      return 'phase: unknown';
    }
  }

  /** Telemetry for tests / debug overlays (not part of the AiController contract). */
  debugState(): AiDebugState {
    const b = this.brain, s = b.snap(), sq = this.army.squad;
    let value = 0;
    for (const u of s.army) value += costValue(u.def.kind === 'resource' ? undefined : u.def.cost);
    return {
      personality: b.pers.id, difficulty: this.diff, phase: this.phase(), errors: b.errors,
      workers: s.workers.length, army: s.army.length, armyValue: value,
      wavesLaunched: this.army.waves.launched,
      squad: sq ? { units: sq.units.size, state: sq.state, target: clone(sq.target.pos) } : null,
      nextWaveAt: this.army.waves.earliest, nextWaveSize: this.army.waves.size,
      threatValue: this.defense.threatValue, defenseResponses: this.defense.responses, scoutTrips: this.scout.trips,
      pendingBuilds: b.pending.length, bases: b.bases.filter((x) => x.complete).length,
      staging: b.staging ? clone(b.staging) : null, knownEnemyStructures: b.memory.structures.size,
    };
  }

  private phase(): string {
    const b = this.brain, sq = this.army.squad;
    if (this.defense.threatValue > 0) return 'defend';
    if (sq) return sq.state === 'retreat' || sq.state === 'return' ? 'regroup' : 'attack';
    const s = b.snap();
    const t = this.world.time / b.prof.planTimeMul;
    if (t < 150 || s.doneCount(REPLICATOR) === 0) return 'opening';
    if (s.wipCount(HIVE) + b.pendingCount(HIVE) > 0) return 'expand';
    if (s.wipCount(PIT) + s.wipCount(SPIRE) + b.pendingCount(PIT) + b.pendingCount(SPIRE) > 0 || b.player.researching.size > 0) return 'tech';
    return 'build-up';
  }

  private waveText(): string {
    const b = this.brain, sq = this.army.squad;
    if (sq) return sq.state === 'retreat' || sq.state === 'return' ? 'regrouping' : 'attacking';
    if (!b.flags.attack) return 'off';
    const eta = this.army.waves.earliest - this.world.time;
    if (eta > 0) return fmtTime(eta);
    return `gathering ${this.army.homeUnits().length}/${this.army.waves.size}`;
  }
}

export function createAi(world: World, playerId: PlayerId, opts: CreateAiOptions): AiController {
  return new PathogenAi(world, playerId, opts);
}
