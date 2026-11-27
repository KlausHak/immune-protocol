/**
 * [ai] Macro: everything that spends resources — drones, Spore Nests, Fermentation Vats, expansions,
 * the personality's tech plan, Toxin Spitters, research and army production.
 *
 * Every think each planner emits prioritised "wants"; a single allocator funds them in priority order
 * against the budget (resources minus buildings already ordered but not yet placed). Important wants
 * that can't be afforded RESERVE their cost so less important spending can't starve them (saving up for
 * a nest, a hive or the spire), while army units fall back to cheaper alternatives instead of waiting.
 */
import { MAX_POP } from '../config';
import { clone, dist, normalize, sub } from '../core/math';
import type { BuildingDef, Cost, Entity, TilePos, UnitDef, Vec2 } from '../core/types';
import { BUILDING_DEFS, UNIT_DEFS, UPGRADE_DEFS } from '../data';
import type { Base, Brain, Site } from './brain';
import { armyGoal, type ArmyGoal } from './composition';
import { DRONE, HIVE, NEST, PIT, REPLICATOR, SPIRE, SPITTER, UP_METABOLISM, VAT, type PlanState } from './personality';
import { findBuildSpot, findHiveSpot, type Lane, type Spot } from './placement';
import { assignFields, hasWeapons, pickFields, type Rect } from './util';

type SiteSpec =
  | { kind: 'main' }
  | { kind: 'front'; base: Base }
  | { kind: 'mineral'; base: Base }
  | { kind: 'hive'; site: Site };

interface Want {
  /** higher is funded first */
  pri: number;
  kind: 'unit' | 'building' | 'upgrade';
  id: string;
  /** when unaffordable: hold its cost so lower priorities can't spend it */
  reserve: boolean;
  producer?: Entity;
  /** cheaper unit fallbacks tried when `id` is unaffordable */
  alts?: string[];
  site?: SiteSpec;
  /** cooldown key for placement failures */
  key: string;
}

const costOf = (kind: Want['kind'], id: string): Cost =>
  (kind === 'unit' ? UNIT_DEFS[id]?.cost : kind === 'upgrade' ? UPGRADE_DEFS[id]?.cost : BUILDING_DEFS[id]?.cost) ?? {};

export class MacroManager {
  /** latest army goal and building plan (telemetry / tests) */
  goal: ArmyGoal | null = null;
  plan: Record<string, number> = {};
  private placeFailUntil = new Map<string, number>();
  private extraVats = 0;
  private nextVatBoost = 0;
  private energyBlockedAt = -999;
  private slipUntil = -1;
  private slipRolledAt = -999;
  private chores = 0;

  constructor(private b: Brain) {}

  private static readonly SAVED = ['placeFailUntil', 'extraVats', 'nextVatBoost', 'energyBlockedAt', 'slipUntil', 'slipRolledAt', 'chores', 'explorer', 'plan'] as const;
  saveState(): Record<string, unknown> { return pickFields(this as unknown as Record<string, unknown>, MacroManager.SAVED as unknown as string[]); }
  loadState(d: unknown): void { assignFields(this as unknown as Record<string, unknown>, d, MacroManager.SAVED as unknown as string[]); }

  think(): void {
    const b = this.b;
    b.refreshSites();
    b.refreshBases();
    b.updatePending();
    b.refreshStaging();
    b.pruneAttacks();
    this.tendExplorer();
    if (this.chores++ % 6 === 0) { this.resumeOrphans(); this.hiveRallies(); }
    const st = this.planState();
    this.goal = armyGoal(b, st);
    this.plan = this.makePlan(st, this.goal);
    const wants: Want[] = [];
    if (b.flags.economy) this.economyWants(st, wants);
    if (b.flags.expand) this.expansionWants(st, wants);
    if (b.flags.build) { this.buildWants(st, wants); this.upgradeWants(st, wants); }
    if (b.flags.army) this.armyWants(wants);
    this.allocate(wants);
  }

  planState(): PlanState {
    const b = this.b, s = b.snap();
    return {
      t: b.world.time / b.prof.planTimeMul,
      pop: b.player.popUsed,
      workers: s.workers.length,
      bases: s.doneCount(HIVE),
      done: (id) => s.doneCount(id),
      started: (id) => b.startedCount(id),
    };
  }

  private makePlan(st: PlanState, goal: ArmyGoal): Record<string, number> {
    const plan = { ...this.b.pers.plan(st) };
    const bump = (id: string, n: number): void => { plan[id] = Math.max(plan[id] ?? 0, n); };
    // adaptive tech: the counters we want need a building we don't have
    if (goal.demandPit > 0.2 && st.t >= 150 && st.done(REPLICATOR) >= 1) bump(PIT, 1);
    if (goal.demandSpire > 0.2 && st.t >= 240 && st.done(PIT) >= 1) { bump(SPIRE, 1); bump(VAT, 3); }
    // production capacity follows income (~one pod per 300 Biomass/min)
    if (st.t >= 240) bump(REPLICATOR, Math.min(6, Math.floor((this.b.incomePerMin() - 150) / 300)));
    return plan;
  }

  // ───────────────────────── economy ─────────────────────────

  private economyWants(st: PlanState, out: Want[]): void {
    const b = this.b, s = b.snap();
    if (s.doneCount(HIVE) + s.wipCount(HIVE) + b.pendingCount(HIVE) === 0) {
      const site = s.workers.length ? b.rebuildSite() : null;
      if (site) out.push({ pri: 100, kind: 'building', id: HIVE, reserve: true, site: { kind: 'hive', site }, key: `hive${site.key}` });
      return;
    }
    const target = b.workerTarget();
    const have = s.workers.length + s.queuedCount(DRONE);
    if (have < target) {
      const rich = b.budget().matter > 400;
      for (const h of s.doneOf(HIVE)) {
        const q = h.production?.queue ?? [];
        if (q.length >= (rich ? 2 : 1) || q.some((it) => it.kind === 'upgrade')) continue;
        out.push({ pri: have < 10 ? 84 : 78, kind: 'unit', id: DRONE, reserve: false, producer: h, key: `drone${h.id}` });
      }
    }
    const nest = this.nestsNeeded(have < target);
    for (let i = 0; i < nest.count; i++) out.push({ pri: nest.critical ? 96 : 90, kind: 'building', id: NEST, reserve: true, site: { kind: 'main' }, key: 'nest' });
    const vats = Math.min(8, (this.plan[VAT] ?? 0) + this.extraVats);
    if (st.started(VAT) < vats) out.push({ pri: 72, kind: 'building', id: VAT, reserve: true, site: { kind: 'main' }, key: 'vat' });
    const p = b.player;
    if (!p.upgrades.has(UP_METABOLISM) && !p.researching.has(UP_METABOLISM) && st.t >= 150 && (have >= Math.min(14, target - 1) || s.doneCount(HIVE) >= 2)) {
      const h = s.doneOf(HIVE).find((x) => (x.production?.queue.length ?? 0) === 0);
      if (h) out.push({ pri: 62, kind: 'upgrade', id: UP_METABOLISM, reserve: false, producer: h, key: 'metabolism' });
    }
  }

  /**
   * Spore Nests ahead of the cap: start enough nests that the cap stays ahead of the expected population
   * growth over one nest build (+ walk) time.
   */
  private nestsNeeded(droning: boolean): { count: number; critical: boolean } {
    const b = this.b, s = b.snap(), p = b.player;
    const lead = (BUILDING_DEFS[NEST]?.buildTime ?? 25) + 7;
    // capacity that will exist within one nest lead time: ordered nests + foundations finishing soon
    let futureCap = p.popCap + 8 * b.pendingCount(NEST);
    for (const bld of [...s.wipOf(NEST), ...s.wipOf(HIVE)]) {
      const c = bld.construction;
      if (c && c.total - c.progress <= lead) futureCap += (bld.def as BuildingDef).provides.pop ?? 0;
    }
    if (futureCap >= MAX_POP) return { count: 0, critical: false };
    let rate = 0; // expected pop per second
    if (droning) rate += s.doneCount(HIVE) / (UNIT_DEFS[DRONE]?.buildTime ?? 12);
    if (b.flags.army) rate += (s.doneCount(REPLICATOR) + s.doneCount(SPIRE)) * 0.095 + (s.wipCount(REPLICATOR) + s.wipCount(SPIRE)) * 0.05;
    const buffer = Math.ceil(rate * lead * b.prof.supplyBuffer) + 1;
    const free = futureCap - p.popUsed;
    if (free >= buffer) return { count: 0, critical: false };
    if (b.prof.supplySlips) {
      const t = b.world.time;
      if (t < this.slipUntil) return { count: 0, critical: false };
      if (t - this.slipRolledAt > 30) {
        this.slipRolledAt = t;
        if (b.rng.chance(b.prof.mistakeRate)) { this.slipUntil = t + 12; return { count: 0, critical: false }; }
      }
    }
    return { count: Math.max(1, Math.min(3, Math.ceil((buffer - free) / 8))), critical: p.popCap - p.popUsed <= 1 };
  }

  private expansionWants(st: PlanState, out: Want[]): void {
    const b = this.b, s = b.snap();
    const hives = s.doneCount(HIVE) + s.wipCount(HIVE) + b.pendingCount(HIVE);
    if (hives === 0 || hives >= b.prof.maxBases || s.wipCount(HIVE) + b.pendingCount(HIVE) > 0) return;
    let caches = 0, remaining = 0;
    for (const base of b.bases) { caches += base.caches.length; remaining += base.remaining; }
    const expandAt = b.pers.expandAt * b.prof.expandTimeMul;
    const saturated = s.workers.length >= Math.floor(caches * b.prof.workersPerCache) && st.t >= expandAt * 0.75;
    const miningOut = caches <= 3 || remaining < 2500;
    if (!(st.t >= expandAt || saturated || miningOut)) return;
    if (b.defense.threatValue > 150) return;
    const site = b.chooseExpansionSite();
    if (!site) return;
    out.push({ pri: miningOut ? 77 : 66, kind: 'building', id: HIVE, reserve: true, site: { kind: 'hive', site }, key: `hive${site.key}` });
  }

  // ───────────────────────── build plan, defences, research ─────────────────────────

  private buildWants(st: PlanState, out: Want[]): void {
    const b = this.b, s = b.snap();
    if (s.doneCount(HIVE) === 0) return;
    const items: Array<[string, number]> = [[REPLICATOR, 76], [PIT, 74], [SPIRE, 73]];
    for (const [id, pri] of items) {
      if (st.started(id) >= (this.plan[id] ?? 0)) continue;
      if (!b.world.economy.meetsRequirements(b.me, BUILDING_DEFS[id]!.requires)) continue;
      out.push({ pri, kind: 'building', id, reserve: true, site: { kind: 'main' }, key: id });
    }
    this.spitterWants(st, out);
    // floating money → more production
    const bud = b.budget();
    const inFlight = (id: string): number => s.wipCount(id) + b.pendingCount(id);
    if (st.t >= 300 && b.player.popUsed < 140 && bud.matter > 700 && st.started(REPLICATOR) < 6 && inFlight(REPLICATOR) === 0)
      out.push({ pri: 40, kind: 'building', id: REPLICATOR, reserve: false, site: { kind: 'main' }, key: 'replicator+' });
    if (st.done(SPIRE) >= 1 && bud.energy > 450 && bud.matter > 450 && st.started(SPIRE) < 3 && inFlight(SPIRE) === 0)
      out.push({ pri: 40, kind: 'building', id: SPIRE, reserve: false, site: { kind: 'main' }, key: 'spire+' });
  }

  private spitterWants(st: PlanState, out: Want[]): void {
    const b = this.b, s = b.snap();
    if (!s.doneCount(REPLICATOR)) return;
    const intel = b.memory.intel();
    const mine = [...s.doneOf(SPITTER), ...s.wipOf(SPITTER)];
    const ordered = b.pending.filter((p) => p.defId === SPITTER && p.buildingId == null);
    const main = b.main;
    for (const base of b.bases) {
      if (!base.complete) continue;
      const isMain = base === main;
      let want = isMain ? b.prof.spittersMain : b.prof.spittersExpansion;
      if (want <= 0) continue;
      const hits = b.attacksNear(base.pos, 20, 180);
      if (isMain && st.t < 200 && b.memory.firstContact < 0 && hits === 0) continue;
      if (intel.air > 0.2 || hits >= 2) want += 1;
      const have = mine.filter((e) => dist(e.pos, base.pos) <= 13).length + ordered.filter((p) => dist(p.tile, base.pos) <= 13).length;
      if (have >= want) continue;
      out.push({ pri: 68, kind: 'building', id: SPITTER, reserve: false, site: have % 2 === 0 ? { kind: 'front', base } : { kind: 'mineral', base }, key: `spitter${base.hive.id}` });
    }
  }

  private upgradeWants(st: PlanState, out: Want[]): void {
    const b = this.b, p = b.player;
    if (st.t < 180) return;
    let count = 0;
    for (const id of p.upgrades) if (id !== UP_METABOLISM) count++;
    for (const id of p.researching) if (id !== UP_METABOLISM) count++;
    if (count >= b.prof.maxUpgrades) return;
    const intel = b.memory.intel();
    const order = [...b.pers.upgrades];
    const promote = (id: string): void => { const i = order.indexOf(id); if (i > 0) { order.splice(i, 1); order.unshift(id); } };
    if (this.viralShare() > 0.4) promote('up_path_virulence');
    if (intel.antibiotic > 0.15) promote('up_path_resistance');
    for (const id of order) {
      if (p.upgrades.has(id) || p.researching.has(id)) continue;
      const def = UPGRADE_DEFS[id];
      if (!def || !b.world.economy.meetsRequirements(b.me, def.requires)) continue;
      if (id.endsWith('_2') && st.t < 480) continue;
      const producer = this.researcher(id);
      if (!producer) continue;
      out.push({ pri: count < 2 ? 55 : 48, kind: 'upgrade', id, reserve: false, producer, key: id });
      return;
    }
  }

  /** A completed, idle building that can research `upId` (unit producers only when we have spares). */
  private researcher(upId: string): Entity | null {
    const b = this.b, s = b.snap();
    for (const bld of s.buildings) {
      if (bld.construction) continue;
      const def = bld.def as BuildingDef;
      if (!def.researches.includes(upId) || (bld.production?.queue.length ?? 0) > 0) continue;
      if (def.trains.length > 0 && !(s.doneCount(bld.defId) >= 2 || b.budget().energy > 350)) continue;
      return bld;
    }
    return null;
  }

  private viralShare(): number {
    let v = 0, tot = 0;
    for (const u of this.b.snap().army) { const pop = (u.def as UnitDef).pop; tot += pop; if (u.tags.has('viral')) v += pop; }
    return tot ? v / tot : 0;
  }

  // ───────────────────────── army production ─────────────────────────

  private armyWants(out: Want[]): void {
    const b = this.b, s = b.snap();
    if (b.player.popUsed >= MAX_POP || !this.goal) return;
    const weights = this.goal.weights;
    const pop = new Map<string, number>();
    let total = 0;
    for (const u of s.army) { const p = (u.def as UnitDef).pop; pop.set(u.defId, (pop.get(u.defId) ?? 0) + p); total += p; }
    for (const [id, n] of s.queued) {
      const d = UNIT_DEFS[id];
      if (!d || id === DRONE) continue;
      pop.set(id, (pop.get(id) ?? 0) + n * d.pop);
      total += n * d.pop;
    }
    const threat = b.defense.threatValue > 0;
    const basePri = threat ? 86 : b.army.waveSoon() ? 58 : 50;
    const rich = b.budget().matter > 500;
    let spireShare = 0;
    for (const [id, v] of weights) if (UNIT_DEFS[id]?.requires.includes(SPIRE)) spireShare += v;
    for (const prod of [...s.doneOf(REPLICATOR), ...s.doneOf(SPIRE)]) {
      const q = prod.production?.queue ?? [];
      if (q.length >= (rich ? 2 : 1) || q.some((it) => it.kind === 'upgrade')) continue;
      const opts = (prod.def as BuildingDef).trains.filter((id) => (weights.get(id) ?? 0) > 0);
      if (!opts.length) continue;
      const deficit = (id: string): number => (weights.get(id) ?? 0) - (pop.get(id) ?? 0) / Math.max(1, total);
      opts.sort((x, y) => deficit(y) - deficit(x));
      const pick = opts[0]!;
      const isSpire = prod.defId === SPIRE;
      out.push({ pri: basePri + (isSpire ? 2 : 0), kind: 'unit', id: pick, reserve: isSpire && spireShare >= 0.2 && !threat, producer: prod, alts: opts.slice(1), key: `unit${prod.id}` });
      const dp = UNIT_DEFS[pick]!.pop;
      pop.set(pick, (pop.get(pick) ?? 0) + dp);
      total += dp;
    }
  }

  // ───────────────────────── allocation & execution ─────────────────────────

  private allocate(wants: Want[]): void {
    const b = this.b, t = b.world.time;
    wants.sort((x, y) => y.pri - x.pri);
    const bud = b.budget();
    let popFree = b.player.popCap - b.player.popUsed;
    for (const w of wants) {
      if ((this.placeFailUntil.get(w.key) ?? -1) > t) continue;
      const ids = [w.id, ...(w.alts ?? [])];
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k]!;
        const cost = costOf(w.kind, id);
        const m = cost.matter ?? 0, e = cost.energy ?? 0;
        const pop = w.kind === 'unit' ? UNIT_DEFS[id]?.pop ?? 0 : 0;
        if (pop > popFree) continue;
        const okM = m <= 0 || bud.matter >= m, okE = e <= 0 || bud.energy >= e;
        if (okM && okE) {
          if (this.execute(w, id)) { bud.matter -= m; bud.energy -= e; popFree -= pop; }
          break;
        }
        if (okM && !okE) this.energyBlockedAt = t;
        if (k === 0 && w.reserve) { bud.matter -= m; bud.energy -= e; break; }
      }
    }
    // Toxin is the bottleneck while Biomass piles up → one more vat (bounded, with a cooldown).
    if (b.flags.economy && t - this.energyBlockedAt < 1 && bud.matter > 250 && t >= this.nextVatBoost && this.extraVats < 4) {
      this.extraVats++;
      this.nextVatBoost = t + 45;
    }
  }

  private execute(w: Want, id: string): boolean {
    const b = this.b;
    const econ = b.world.economy;
    if (w.kind === 'unit' || w.kind === 'upgrade') {
      if (!w.producer || !w.producer.alive) return false;
      // gate with the economy's own checks so a rejected queue attempt never spams notEnough
      if (!(w.kind === 'unit' ? econ.canTrain(w.producer, id) : econ.canResearch(w.producer, id)).ok) return false;
      return w.kind === 'unit'
        ? b.issue({ type: 'train', playerId: b.me, buildingId: w.producer.id, defId: id })
        : b.issue({ type: 'research', playerId: b.me, buildingId: w.producer.id, upgradeId: id });
    }
    if (!b.canAct() || !econ.canAfford(b.me, costOf('building', id))) return false;
    const spot = this.place(w, id);
    if (!spot) {
      this.placeFailUntil.set(w.key, b.world.time + 15);
      // placement needs explored ground: walk a drone over to an unexplored expansion site first
      if (w.site?.kind === 'hive' && !b.world.vision.isExplored(b.me, w.site.site.center)) this.explore(w.site.site.center);
      return false;
    }
    const builder = b.pickWorker(spot.center);
    if (!builder) return false;
    if (!b.issue({ type: 'build', playerId: b.me, unitIds: [builder.id], defId: id, tile: spot.tile })) return false;
    b.addPending(id, spot.tile, builder.id);
    return true;
  }

  private explorer: { id: number; until: number } | null = null;

  /** Send one free drone to look at a spot (released on arrival or after 60 s). */
  private explore(p: Vec2): void {
    const b = this.b;
    if (this.explorer && b.world.getAlive(this.explorer.id)) return;
    const wkr = b.pickWorker(p);
    const dest = b.walkable(p);
    if (!wkr || !dest || !b.issue({ type: 'move', playerId: b.me, unitIds: [wkr.id], target: dest })) return;
    b.roles.set(wkr.id, 'explorer');
    this.explorer = { id: wkr.id, until: b.world.time + 60 };
  }

  private tendExplorer(): void {
    const ex = this.explorer;
    if (!ex) return;
    const u = this.b.world.getAlive(ex.id);
    if (!u || u.orders.length === 0 || this.b.world.time > ex.until) {
      this.b.releaseRole(ex.id, 'explorer');
      this.explorer = null;
    }
  }

  private place(w: Want, id: string): Spot | null {
    const b = this.b;
    const reserved = this.reservedRects();
    const site = w.site ?? { kind: 'main' as const };
    if (site.kind === 'hive') return findHiveSpot(b.world, b.me, id, site.site, b.main?.pos ?? site.site.center, reserved);
    const base = site.kind === 'main' ? b.main : site.base;
    if (!base) return null;
    let anchor: Vec2;
    if (site.kind === 'mineral' && base.mineral) anchor = base.mineral;
    else if (site.kind === 'front') {
      const focus = b.enemyFocus(base.pos) ?? b.staging;
      const dir = focus ? normalize(sub(focus, base.pos)) : { x: 0, y: 1 };
      anchor = { x: base.pos.x + dir.x * 6, y: base.pos.y + dir.y * 6 };
    } else {
      const away = base.mineral ? normalize(sub(base.pos, base.mineral)) : { x: 0, y: 0 };
      anchor = { x: base.pos.x + away.x * 7, y: base.pos.y + away.y * 7 };
    }
    return findBuildSpot(b.world, b.me, id, {
      anchor, lanes: this.lanes(), reserved, maxRadius: 20,
      avoid: b.staging ? [{ p: b.staging, r: 5 }] : [],
      skip: (tile: TilePos) => b.isBadTile(tile),
    });
  }

  private lanes(): Lane[] {
    const out: Lane[] = [];
    for (const base of this.b.bases) for (const c of base.caches) out.push({ a: base.pos, b: c.pos });
    return out;
  }

  private reservedRects(): Rect[] {
    const out: Rect[] = [];
    for (const p of this.b.pending) {
      if (p.buildingId != null) continue;
      const d = BUILDING_DEFS[p.defId];
      if (d) out.push({ x: p.tile.x, y: p.tile.y, w: d.footprint.w, h: d.footprint.h });
    }
    return out;
  }

  /** Foundations whose builder died or wandered off get a new drone. */
  private resumeOrphans(): void {
    const b = this.b, s = b.snap();
    for (const list of s.wip.values()) {
      for (const bld of list) {
        if (!bld.tile || b.pending.some((p) => p.buildingId === bld.id)) continue;
        const cur = b.world.getAlive(bld.construction?.builderId ?? null);
        if (cur && b.isConstructing(cur, bld)) continue;
        if (s.workers.some((w) => b.isConstructing(w, bld))) continue;
        if (b.enemiesNear(bld.pos, 9, hasWeapons).length) continue;
        const w = b.pickWorker(bld.pos);
        if (!w) continue;
        if (b.issue({ type: 'smart', playerId: b.me, unitIds: [w.id], target: clone(bld.pos), targetId: bld.id })) b.addPending(bld.defId, bld.tile, w.id, bld.id);
      }
    }
  }

  /** New drones walk straight to the least-loaded cache of their hive. */
  private hiveRallies(): void {
    const b = this.b;
    const load = b.cacheLoad();
    for (const base of b.bases) {
      if (!base.complete || !base.caches.length) continue;
      let best = base.caches[0]!, bs = Infinity;
      for (const c of base.caches) {
        const sc = (load.get(c.id) ?? 0) * 10 + dist(c.pos, base.pos);
        if (sc < bs) { bs = sc; best = c; }
      }
      if (base.hive.rally?.targetId === best.id) continue;
      b.issue({ type: 'setRally', playerId: b.me, buildingIds: [base.hive.id], target: clone(best.pos), targetId: best.id });
    }
  }
}
