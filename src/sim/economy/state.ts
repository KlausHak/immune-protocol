/**
 * [economy] Module-private per-entity state (entity.ext.economy) and per-world runtime data.
 */
import type { Entity, EntityId, PlayerId, ResourceKind, Vec2 } from '../../core/types';
import type { World } from '../World';
import type { Failure } from './messages';

/** Worker bookkeeping (ext.economy on units with a gatherer). */
export interface WorkerEco {
  /** Spread plan from a group gather command: go to `node` instead of the clicked `target`. */
  plan: { target: EntityId; node: EntityId } | null;
  /** Position of the last cache worked (auto-switch target area after depletion). */
  lastNodePos: Vec2 | null;
  /** Cache this worker currently holds the (single) gathering slot of. */
  occupying: EntityId | null;
  /** Current movement leg (entity id, or -1 for a point leg) — a new leg issues a fresh move request. */
  legTarget: number | null;
  legPoint: Vec2 | null;
  legRetries: number;
  legIssuedTick: number;
  /** world.time when the worker started waiting at a busy cache (FIFO). */
  waitSince: number;
  waitCheck: number;
  bounces: number;
  /** >0 while handing cargo over at the drop-off. */
  dwell: number;
  /** Resource kind of the carried load. */
  cargo: ResourceKind;
  /** Set by gather.start when the order targets a building: 'return' = deliver there, 'invalid' = reject. */
  gatherInvalid: 'return' | 'invalid' | null;
  /** Tick a gather order last ended (a build/repair started the same tick returns the worker to mining after). */
  gatherStopTick: number;
  /** Cache to return to once the current build/repair chain ends. */
  resumeNodeId: EntityId | null;
  /** Last tick a build/construct/repair order ended (chains shift-queued builds). */
  workEndTick: number;
  /** Building this worker is actively constructing this tick (read by the economy system). */
  constructing: EntityId | null;
  /** Build-order bookkeeping: a failure found when the order started (reported on its first update). */
  buildError: Failure | null;
  blockedTime: number;
  /** Repair bookkeeping: healed hp not yet reported via entityHealed. */
  healPending: number;
  healTimer: number;
}

export function workerEco(e: Entity): WorkerEco {
  let x = e.ext.economy as WorkerEco | undefined;
  if (!x) {
    x = {
      plan: null, lastNodePos: null, occupying: null,
      legTarget: null, legPoint: null, legRetries: 0, legIssuedTick: -1,
      waitSince: 0, waitCheck: 0, bounces: 0, dwell: 0, cargo: 'matter', gatherInvalid: null,
      gatherStopTick: -100, resumeNodeId: null, workEndTick: -100, constructing: null,
      buildError: null, blockedTime: 0, healPending: 0, healTimer: 0,
    };
    e.ext.economy = x;
  }
  return x;
}

/** Resource node bookkeeping (ext.economy on Supply Caches). */
export interface NodeEco {
  /** Worker holding the single gathering slot. */
  occupant: EntityId | null;
  /** world.time until which the slot is still clearing after the last gatherer left. */
  busyUntil: number;
}

export function nodeEco(node: Entity): NodeEco {
  let x = node.ext.economy as NodeEco | undefined;
  if (!x) { x = { occupant: null, busyUntil: -1 }; node.ext.economy = x; }
  return x;
}

/** Cumulative-counter samples per player for incomeRate(). */
export interface IncomeSamples { t: number[]; matter: number[]; energy: number[] }

export interface EconomyRuntime {
  samples: Map<PlayerId, IncomeSamples>;
  nextSampleAt: number;
  /** Current per-player energy income (per second) from completed buildings (fallback for short windows). */
  energyPerSec: Map<PlayerId, number>;
  /** Tick / entity-list length at the last population recompute (see ensurePopulation). */
  popTick: number;
  popListLen: number;
}

const RUNTIME = new WeakMap<World, EconomyRuntime>();

export function getRuntime(world: World): EconomyRuntime | undefined { return RUNTIME.get(world); }

export function initRuntime(world: World): EconomyRuntime {
  const rt: EconomyRuntime = { samples: new Map(), nextSampleAt: 0, energyPerSec: new Map(), popTick: -1, popListLen: -1 };
  RUNTIME.set(world, rt);
  return rt;
}
