/**
 * [qa] Simulation invariant checker used by runMatch() (tests/helpers/match.ts) and usable standalone:
 *
 *   const checker = new InvariantChecker({ every: 20 });
 *   ... after each world.step(): if (world.tick % checker.opts.every === 0) checker.check(world);
 *   checker.finalCheck(world, 'skirmish');
 *   expect(checker.errors()).toEqual([]);
 *
 * Every check reads public state only (World, Entity, PlayerState, MapData, world.projectiles) so it
 * works with the architect's stubs and with the real modules. Each (check, entity) pair is recorded once
 * (with full context) while `counts` keeps the total number of hits per check name.
 *
 * Severity: 'error' = a contract/rule is broken (tests fail); 'warn' = suspicious, reported in the
 * summary / QA_LOG but tolerated by the default assertions.
 */
import { MAX_POP } from '../../src/config';
import { Terrain, type Entity, type EntityId, type PlayerId } from '../../src/core/types';
import { UNIT_DEFS } from '../../src/data';
import type { World } from '../../src/sim/World';

export type Severity = 'error' | 'warn';

export interface Violation {
  check: string;
  severity: Severity;
  tick: number;
  time: number;
  message: string;
  entityId?: EntityId;
  defId?: string;
  owner?: PlayerId;
}

export interface InvariantOptions {
  /** Ticks between checks inside runMatch (20 = once per simulated second). */
  every: number;
  /** A ground unit may overlap a statically blocked tile by this many tiles before it counts as "inside". */
  blockedTolerance: number;
  /** ...and must stay inside for at least this long (s) before it is flagged (tolerates collision pushes). */
  stuckSeconds: number;
  /** Extra pop allowed above the highest cap seen (alive + queued units). */
  popSlack: number;
  /** Which players get the pop-cap check. Campaign waves spawn free units, so campaigns use 'hospital'. */
  popCheck: 'all' | 'hospital' | 'none';
  /** Campaigns: pre-placed starting forces may exceed the cap — the limit becomes max(cap, pop at the first tick). */
  popBaselineFromStart: boolean;
  /** A projectile alive longer than this (s) is a leak. */
  maxProjectileAge: number;
  /** More simultaneous projectiles than this is suspicious (warn). */
  maxProjectiles: number;
  /** Throw InvariantViolationError at the first 'error' (default: collect). */
  throwOnViolation: boolean;
  /** Cap on stored violation records (counts are always complete). */
  maxRecorded: number;
  /** Check names to skip entirely. */
  ignore: string[];
}

export const DEFAULT_INVARIANTS: InvariantOptions = {
  every: 20,
  blockedTolerance: 0.3,
  stuckSeconds: 1.5,
  popSlack: 2,
  popCheck: 'all',
  popBaselineFromStart: false,
  maxProjectileAge: 30,
  maxProjectiles: 3000,
  throwOnViolation: false,
  maxRecorded: 300,
  ignore: [],
};

export class InvariantViolationError extends Error {
  constructor(readonly violation: Violation) {
    super(`[invariant:${violation.check}] ${violation.message} (tick ${violation.tick}, t=${violation.time}s)`);
    this.name = 'InvariantViolationError';
  }
}

const EPS = 1e-6;
const fin = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);
const finV = (v: { x: number; y: number } | null | undefined): boolean => !!v && fin(v.x) && fin(v.y);
const fmt = (n: number): string => (Number.isFinite(n) ? (Math.round(n * 100) / 100).toString() : String(n));
const fmtV = (v: { x: number; y: number }): string => `(${fmt(v.x)}, ${fmt(v.y)})`;

/** Short human label for an entity: "hosp_sanitizer#42(p1)". */
export function entityLabel(e: Entity): string { return `${e.defId}#${e.id}(p${e.owner})`; }

function isBlockedAt(world: World, x: number, y: number): boolean {
  const m = world.map;
  const tx = Math.floor(x), ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= m.width || ty >= m.height) return true;
  return m.blocked[ty * m.width + tx] === 1;
}

export class InvariantChecker {
  readonly opts: InvariantOptions;
  readonly violations: Violation[] = [];
  readonly counts: Record<string, number> = {};
  checksRun = 0;
  private recordedKeys = new Set<string>();
  private capHigh = new Map<PlayerId, number>();
  private popMismatch = new Map<PlayerId, number>();
  private startPop = new Map<PlayerId, number>();
  private blockedSince = new Map<EntityId, number>();
  private insideSince = new Map<EntityId, number>();
  private deadSeen = new Map<EntityId, number>();
  private projSeen = new Map<number, number>();

  constructor(opts: Partial<InvariantOptions> = {}) {
    this.opts = { ...DEFAULT_INVARIANTS, ...opts, ignore: [...(opts.ignore ?? DEFAULT_INVARIANTS.ignore)] };
  }

  errors(): Violation[] { return this.violations.filter((v) => v.severity === 'error'); }
  warnings(): Violation[] { return this.violations.filter((v) => v.severity === 'warn'); }

  /** Record a violation (deduplicated per check+entity; counts keep every hit). */
  flag(world: World, check: string, severity: Severity, message: string, e?: Entity, dedupeKey?: string): void {
    if (this.opts.ignore.includes(check)) return;
    this.counts[check] = (this.counts[check] ?? 0) + 1;
    const key = `${check}:${dedupeKey ?? e?.id ?? '-'}`;
    if (this.recordedKeys.has(key)) return;
    this.recordedKeys.add(key);
    const v: Violation = { check, severity, tick: world.tick, time: Math.round(world.time * 100) / 100, message };
    if (e) { v.entityId = e.id; v.defId = e.defId; v.owner = e.owner; }
    if (this.violations.length < this.opts.maxRecorded) this.violations.push(v);
    if (severity === 'error' && this.opts.throwOnViolation) throw new InvariantViolationError(v);
  }

  /** Run every per-tick invariant against the current world state (call after world.step()). */
  check(w: World): void {
    this.checksRun++;
    this.checkClock(w);
    this.checkStore(w);
    this.checkPlayers(w);
    this.checkEntities(w);
    this.checkProjectiles(w);
  }

  private checkClock(w: World): void {
    if (!fin(w.time) || Math.abs(w.time - w.tick * w.dt) > 1e-6 * Math.max(1, w.tick)) {
      this.flag(w, 'clock', 'warn', `world.time ${w.time} does not match tick ${w.tick} × dt ${w.dt}`);
    }
  }

  private checkStore(w: World): void {
    if (w.list.length !== w.entities.size) {
      this.flag(w, 'store-consistency', 'error', `world.list has ${w.list.length} entries but world.entities has ${w.entities.size}`, undefined, `size@${Math.floor(w.tick / 200)}`);
    }
    const ids = new Set<EntityId>();
    for (const e of w.list) {
      if (ids.has(e.id)) this.flag(w, 'store-consistency', 'error', `duplicate entity id ${e.id} in world.list (${entityLabel(e)})`, e);
      ids.add(e.id);
      if (w.entities.get(e.id) !== e) this.flag(w, 'store-consistency', 'error', `${entityLabel(e)} is in world.list but not in world.entities`, e);
    }
    // Dead entities must be gone after the cleanup system (order 100) of the tick they died in.
    // We tolerate one extra tick (something may kill during cleanup's entityRemoved handlers).
    const present = new Set<EntityId>();
    for (const e of w.entities.values()) {
      if (e.alive) continue;
      present.add(e.id);
      const first = this.deadSeen.get(e.id);
      if (first === undefined) { this.deadSeen.set(e.id, w.tick); continue; }
      if (w.tick - first >= 2) {
        this.flag(w, 'dead-lingering', 'error',
          `${entityLabel(e)} has alive=false but is still in world.entities ${w.tick - first} ticks after it was first seen dead (hp=${fmt(e.hp)}) — it was never queued for removal (set alive=false without world.killEntity/removeEntity?)`, e);
      }
    }
    for (const id of [...this.deadSeen.keys()]) if (!present.has(id)) this.deadSeen.delete(id);
  }

  private checkPlayers(w: World): void {
    const alivePop = new Map<PlayerId, number>();
    const queuedPop = new Map<PlayerId, number>();
    for (const e of w.list) {
      if (!e.alive) continue;
      if (e.kind === 'unit' && e.def.kind === 'unit') alivePop.set(e.owner, (alivePop.get(e.owner) ?? 0) + e.def.pop);
      for (const it of e.production?.queue ?? []) {
        if (it.kind === 'unit') queuedPop.set(e.owner, (queuedPop.get(e.owner) ?? 0) + (UNIT_DEFS[it.defId]?.pop ?? 0));
      }
    }
    for (const p of w.players.values()) {
      const r = p.resources;
      if (!fin(r.matter) || !fin(r.energy)) this.flag(w, 'resources-finite', 'error', `player ${p.id} resources not finite: matter=${r.matter} energy=${r.energy}`, undefined, `p${p.id}`);
      else if (r.matter < -EPS || r.energy < -EPS) this.flag(w, 'resources-negative', 'error', `player ${p.id} has negative resources: matter=${fmt(r.matter)} energy=${fmt(r.energy)}`, undefined, `p${p.id}`);
      if (p.id === 0 || w.tick === 0) continue; // economy computes pop on the first tick
      if (!fin(p.popCap) || !fin(p.popUsed) || p.popCap < 0 || p.popUsed < 0) {
        this.flag(w, 'pop-finite', 'error', `player ${p.id} pop not sane: used=${p.popUsed} cap=${p.popCap}`, undefined, `p${p.id}`);
        continue;
      }
      if (p.popCap > MAX_POP) this.flag(w, 'pop-cap-max', 'error', `player ${p.id} popCap ${p.popCap} exceeds MAX_POP ${MAX_POP}`, undefined, `p${p.id}`);
      const high = Math.max(this.capHigh.get(p.id) ?? 0, p.popCap);
      this.capHigh.set(p.id, high);
      const mode = this.opts.popCheck;
      if (mode === 'none' || (mode === 'hospital' && p.faction !== 'hospital')) continue;
      const a = alivePop.get(p.id) ?? 0, q = queuedPop.get(p.id) ?? 0;
      if (!this.startPop.has(p.id)) this.startPop.set(p.id, a);
      const limit = this.opts.popBaselineFromStart ? Math.max(high, this.startPop.get(p.id) ?? 0) : high;
      if (a + q > limit + this.opts.popSlack) {
        this.flag(w, 'pop-over-cap', 'error',
          `player ${p.id} (${p.faction}) has ${a} pop alive + ${q} queued = ${a + q} > limit ${limit} (highest cap seen ${high}, starting pop ${this.startPop.get(p.id)}; current cap ${p.popCap}, popUsed ${p.popUsed}) + slack ${this.opts.popSlack}`, undefined, `p${p.id}`);
      }
      // popUsed is "recomputed by economy each tick (includes queued units)". Flag only persistent mismatches.
      if (p.popUsed !== a + q) {
        const n = (this.popMismatch.get(p.id) ?? 0) + 1;
        this.popMismatch.set(p.id, n);
        if (n >= 3) this.flag(w, 'pop-accounting', 'warn', `player ${p.id} popUsed=${p.popUsed} but alive units use ${a} + queued ${q} = ${a + q} (3+ consecutive checks)`, undefined, `p${p.id}`);
      } else this.popMismatch.set(p.id, 0);
    }
  }

  private checkEntities(w: World): void {
    const map = w.map;
    const tol = this.opts.blockedTolerance;
    const liveIds = new Set<EntityId>();
    for (const e of w.list) {
      if (!e.alive) continue;
      liveIds.add(e.id);
      const L = entityLabel(e);
      if (!w.players.has(e.owner)) this.flag(w, 'owner-valid', 'error', `${L} owned by unknown player ${e.owner}`, e);
      // positions
      if (!finV(e.pos) || !finV(e.prevPos) || !fin(e.facing)) {
        this.flag(w, 'position-finite', 'error', `${L} has non-finite pos ${fmtV(e.pos)} prevPos ${fmtV(e.prevPos)} facing ${e.facing}`, e);
        continue; // the rest would cascade
      }
      if (e.pos.x < -EPS || e.pos.y < -EPS || e.pos.x > map.width + EPS || e.pos.y > map.height + EPS) {
        this.flag(w, 'position-bounds', 'error', `${L} at ${fmtV(e.pos)} is outside the ${map.width}×${map.height} map`, e);
      }
      // hp / stats
      if (!fin(e.hp)) this.flag(w, 'hp-finite', 'error', `${L} hp is ${e.hp}`, e);
      else {
        if (e.hp > e.stats.maxHp + 1e-6) this.flag(w, 'hp-over-max', 'error', `${L} hp ${fmt(e.hp)} > maxHp ${fmt(e.stats.maxHp)}`, e);
        if (e.hp <= 0) this.flag(w, 'zombie', 'error', `${L} is alive with hp ${fmt(e.hp)} (should have been killed via world.killEntity)`, e);
      }
      const st = e.stats;
      if (!(st.maxHp > 0) || !fin(st.maxHp) || !fin(st.armor) || !fin(st.speed) || st.speed < 0 || !fin(st.damageMul) || !fin(st.cooldownMul) || !fin(st.sight)) {
        this.flag(w, 'stats-sane', 'error', `${L} has insane stats ${JSON.stringify({ maxHp: st.maxHp, armor: st.armor, speed: st.speed, damageMul: st.damageMul, cooldownMul: st.cooldownMul, sight: st.sight })}`, e);
      }
      // mover
      const m = e.mover;
      if (m) {
        if (!finV(m.vel)) this.flag(w, 'velocity-finite', 'error', `${L} velocity not finite ${fmtV(m.vel)}`, e);
        if (m.goal && !finV(m.goal)) this.flag(w, 'goal-finite', 'error', `${L} movement goal not finite ${fmtV(m.goal)}`, e);
        if (m.path.some((p) => !finV(p))) this.flag(w, 'path-finite', 'error', `${L} path contains non-finite waypoints`, e);
        if (!m.flying && e.kind === 'unit') this.checkGroundPlacement(w, e, tol);
      }
      // combat
      if (e.combat && (!fin(e.combat.cooldown) || !fin(e.combat.windupLeft))) this.flag(w, 'combat-finite', 'error', `${L} combat cooldown=${e.combat.cooldown} windupLeft=${e.combat.windupLeft}`, e);
      // production
      const pr = e.production;
      if (pr) {
        if (pr.queue.length > pr.maxQueue) this.flag(w, 'queue-overflow', 'error', `${L} production queue has ${pr.queue.length} > max ${pr.maxQueue} items`, e);
        for (const it of pr.queue) {
          if (!fin(it.progress) || !fin(it.total) || it.progress < -EPS || it.progress > it.total + 1) {
            this.flag(w, 'queue-progress', 'error', `${L} queue item ${it.defId} progress ${it.progress}/${it.total}`, e);
          }
        }
      }
      // construction
      const c = e.construction;
      if (c && (!fin(c.progress) || !fin(c.total) || c.progress < -EPS || c.progress > c.total + 1)) {
        this.flag(w, 'construction-progress', 'error', `${L} construction progress ${c.progress}/${c.total}`, e);
      }
      // resource nodes
      const r = e.resource;
      if (r && (!fin(r.amount) || r.amount < -EPS || r.amount > r.initial + EPS)) {
        this.flag(w, 'resource-amount', 'error', `${L} resource amount ${r.amount} (initial ${r.initial})`, e);
      }
      // workers
      const g = e.gatherer;
      if (g) {
        const cap = (e.def.kind === 'unit' ? e.def.gather?.capacity ?? 5 : 5) + (st.gatherCapacityAdd ?? 0);
        if (!fin(g.carrying) || g.carrying < -EPS || g.carrying > cap + 1e-6) this.flag(w, 'carry-capacity', 'error', `${L} carries ${g.carrying} (capacity ${cap})`, e);
      }
    }
    for (const id of [...this.blockedSince.keys()]) if (!liveIds.has(id)) this.blockedSince.delete(id);
    for (const id of [...this.insideSince.keys()]) if (!liveIds.has(id)) this.insideSince.delete(id);
    this.checkUnitsInsideFootprints(w, tol, liveIds);
  }

  /** Ground unit centre deep inside statically blocked terrain (water, cliffs, doodads, border) for too long. */
  private checkGroundPlacement(w: World, e: Entity, tol: number): void {
    const { x, y } = e.pos;
    const inside = isBlockedAt(w, x, y) && isBlockedAt(w, x + tol, y) && isBlockedAt(w, x - tol, y) && isBlockedAt(w, x, y + tol) && isBlockedAt(w, x, y - tol);
    if (!inside) { this.blockedSince.delete(e.id); return; }
    const since = this.blockedSince.get(e.id);
    if (since === undefined) { this.blockedSince.set(e.id, w.time); if (this.opts.stuckSeconds > 0) return; }
    const dur = w.time - (since ?? w.time);
    if (dur + EPS >= this.opts.stuckSeconds) {
      const tx = Math.floor(x), ty = Math.floor(y);
      const ti = ty * w.map.width + tx;
      const terr = tx >= 0 && ty >= 0 && tx < w.map.width && ty < w.map.height ? Terrain[w.map.terrain[ti]!] ?? String(w.map.terrain[ti]) : 'out-of-bounds';
      this.flag(w, 'unit-in-blocked-tile', 'error',
        `${entityLabel(e)} at ${fmtV(e.pos)} has been inside statically blocked tile (${tx},${ty}) [${terr}] for ${fmt(dur)}s (born t=${fmt(e.bornAt)}, activity=${e.activity}, order=${e.orders[0]?.type ?? 'none'})`, e);
    }
  }

  /** Ground units whose centre sits inside a building/resource footprint (shrunk by tol) for too long. */
  private checkUnitsInsideFootprints(w: World, tol: number, liveIds: Set<EntityId>): void {
    const insideNow = new Set<EntityId>();
    for (const b of w.list) {
      if (!b.alive || !b.tile || b.kind === 'unit') continue;
      const r = w.footRect(b);
      if (!r) continue;
      const x0 = r.x + tol, y0 = r.y + tol, x1 = r.x + r.w - tol, y1 = r.y + r.h - tol;
      if (x1 <= x0 || y1 <= y0) continue;
      for (const u of w.spatial.queryRect(x0, y0, x1, y1, (o) => o.kind === 'unit' && !!o.mover && !o.mover.flying)) {
        if (u.pos.x <= x0 || u.pos.x >= x1 || u.pos.y <= y0 || u.pos.y >= y1) continue;
        insideNow.add(u.id);
        const since = this.insideSince.get(u.id);
        if (since === undefined) { this.insideSince.set(u.id, w.time); continue; }
        if (w.time - since + EPS >= this.opts.stuckSeconds) {
          this.flag(w, 'unit-in-footprint', 'warn',
            `${entityLabel(u)} at ${fmtV(u.pos)} has been inside the footprint of ${entityLabel(b)} (tiles ${r.x},${r.y} ${r.w}×${r.h}${b.construction ? ', under construction' : ''}) for ${fmt(w.time - since)}s (order=${u.orders[0]?.type ?? 'none'})`, u);
        }
      }
    }
    for (const id of [...this.insideSince.keys()]) if (!insideNow.has(id) || !liveIds.has(id)) this.insideSince.delete(id);
  }

  private checkProjectiles(w: World): void {
    if (w.projectiles.length > this.opts.maxProjectiles) {
      this.flag(w, 'projectile-count', 'warn', `${w.projectiles.length} live projectiles (> ${this.opts.maxProjectiles})`, undefined, `count@${Math.floor(w.tick / 1200)}`);
    }
    const present = new Set<number>();
    const ids = new Set<number>();
    for (const p of w.projectiles) {
      if (ids.has(p.id)) this.flag(w, 'projectile-id', 'error', `duplicate projectile id ${p.id}`, undefined, `proj${p.id}`);
      ids.add(p.id);
      present.add(p.id);
      const ok = finV(p.pos) && finV(p.prevPos) && finV(p.start) && finV(p.targetPos) && fin(p.t) && fin(p.prevT) && fin(p.speed) && fin(p.damage) && fin(p.splashRadius) && fin(p.startHeight) && fin(p.endHeight);
      if (!ok) {
        this.flag(w, 'projectile-finite', 'error', `projectile ${p.id} (${p.vfx} from #${p.sourceId}, p${p.ownerPlayer}) has non-finite fields: pos ${fmtV(p.pos)} target ${fmtV(p.targetPos)} t=${p.t} speed=${p.speed} damage=${p.damage}`, undefined, `proj${p.id}`);
      } else if (p.t < -1e-3 || p.t > 1.5) {
        this.flag(w, 'projectile-t', 'warn', `projectile ${p.id} (${p.vfx}) travel fraction t=${fmt(p.t)} outside [0,1]`, undefined, `proj${p.id}`);
      }
      if (!w.players.has(p.ownerPlayer)) this.flag(w, 'projectile-owner', 'error', `projectile ${p.id} owned by unknown player ${p.ownerPlayer}`, undefined, `proj${p.id}`);
      const first = this.projSeen.get(p.id);
      if (first === undefined) this.projSeen.set(p.id, w.time);
      else if (w.time - first > this.opts.maxProjectileAge) {
        this.flag(w, 'projectile-leak', 'error', `projectile ${p.id} (${p.vfx} from #${p.sourceId}) alive for ${fmt(w.time - first)}s (pos ${fmtV(p.pos)}, t=${fmt(p.t)}, speed ${fmt(p.speed)})`, undefined, `proj${p.id}`);
      }
    }
    for (const id of [...this.projSeen.keys()]) if (!present.has(id)) this.projSeen.delete(id);
  }

  /** End-of-match consistency: defeat rules and game-over bookkeeping. */
  finalCheck(w: World, mode: 'skirmish' | 'campaign'): void {
    this.check(w);
    const active = w.activePlayers();
    if (w.rules.gameOver) {
      const wt = w.rules.winnerTeam;
      if (wt != null) {
        if (!active.some((p) => p.team === wt && !p.defeated)) this.flag(w, 'game-over-consistency', 'error', `winnerTeam ${wt} has no undefeated player`);
        if (mode === 'skirmish') for (const p of active) if (p.team !== wt && !p.defeated) this.flag(w, 'game-over-consistency', 'warn', `skirmish ended (winner team ${wt}) but player ${p.id} (team ${p.team}) is not marked defeated`, undefined, `p${p.id}`);
      }
    }
    if (mode === 'skirmish' && w.rules.autoDefeat && !w.rules.gameOver) {
      for (const p of active) {
        const hasBuilding = w.list.some((e) => e.alive && e.owner === p.id && e.kind === 'building');
        if (!hasBuilding && !p.defeated) this.flag(w, 'defeat-missing', 'error', `player ${p.id} has no buildings but is not defeated`, undefined, `p${p.id}`);
      }
    }
  }
}
