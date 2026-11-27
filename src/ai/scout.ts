/**
 * [ai] Scouting. Early on a drone (or the swarm's first phage) runs to the enemy start location, circles
 * it and comes home; later, on normal+, a fast unit periodically checks the enemy main and the likely
 * expansions when no attack squad is out. Everything seen is recorded by EnemyMemory. Scouting is an
 * offensive act, so it is off while the `attack` flag is off (campaign "sitting" opponent).
 */
import { dist } from '../core/math';
import type { Entity, EntityId, Vec2 } from '../core/types';
import type { Brain } from './brain';
import { hpFrac, isAir } from './util';

export class ScoutManager {
  /** completed scouting trips (telemetry) */
  trips = 0;
  private id: EntityId | null = null;
  private route: Vec2[] = [];
  private idx = 0;
  private startedAt = 0;
  private issuedAt = 0;
  private earlyDone = false;
  private nextAt: number;

  constructor(private b: Brain) { this.nextAt = b.pers.scoutAt * b.prof.planTimeMul; }

  get scoutId(): EntityId | null { return this.id; }

  saveState(): Record<string, unknown> {
    return { trips: this.trips, id: this.id, route: this.route, idx: this.idx, startedAt: this.startedAt, issuedAt: this.issuedAt, earlyDone: this.earlyDone, nextAt: this.nextAt };
  }
  loadState(data: unknown): void {
    const d = (data ?? {}) as Partial<Record<'trips' | 'idx' | 'startedAt' | 'issuedAt' | 'nextAt', number>> & { id?: EntityId | null; route?: Vec2[]; earlyDone?: boolean };
    this.trips = d.trips ?? 0; this.id = d.id ?? null; this.route = d.route ?? []; this.idx = d.idx ?? 0;
    this.startedAt = d.startedAt ?? 0; this.issuedAt = d.issuedAt ?? 0; this.earlyDone = d.earlyDone ?? false; this.nextAt = d.nextAt ?? this.nextAt;
  }

  think(): void {
    const b = this.b, t = b.world.time;
    if (!b.flags.attack) { this.finish(); return; }
    if (this.id != null) { this.follow(); return; }
    if (t < this.nextAt) return;
    if (!this.earlyDone) {
      if (this.start(true) || t > b.pers.scoutAt * b.prof.planTimeMul + 90) {
        this.earlyDone = true;
        this.nextAt = t + Math.max(60, b.prof.rescoutSec);
      }
      return;
    }
    if (b.prof.rescoutSec <= 0) { this.nextAt = Infinity; return; }
    if (b.army.squad) { this.nextAt = t + 30; return; } // the attack squad is our eyes
    this.nextAt = t + b.prof.rescoutSec;
    this.start(false);
  }

  private start(early: boolean): boolean {
    const b = this.b, s = b.snap(), t = b.world.time;
    const targets = b.enemyStarts.filter((e) => !b.world.players.get(e.playerId)?.defeated).map((e) => e.pos);
    if (!targets.length) return false;
    const fast = b.army.homeUnits(s).filter((u) => !isAir(u)).sort((x, y) => y.stats.speed - x.stats.speed || x.id - y.id);
    let unit: Entity | null = null;
    if (early) {
      if (b.pers.scoutUnit === 'phage' && fast.length) unit = fast[0]!;
      else if (b.pers.scoutUnit === 'drone' || t > b.pers.scoutAt * b.prof.planTimeMul + 45) unit = s.workers.length >= 7 ? b.pickWorker(targets[0]!) : null;
    } else if (fast.length) unit = fast[0]!;
    if (!unit) return false;

    const route: Vec2[] = [];
    if (!early) {
      // likely enemy expansions first: unclaimed sites nearest their start
      const sites = b.sites.filter((si) => !b.ownsSite(si) && dist(si.center, targets[0]!) > 12)
        .sort((x, y) => dist(x.center, targets[0]!) - dist(y.center, targets[0]!)).slice(0, 2);
      for (const si of sites) route.push(b.walkable(si.center) ?? si.center);
    }
    for (const es of targets) {
      route.push(b.walkable(es) ?? es);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        const p = b.walkable({ x: es.x + Math.cos(a) * 9, y: es.y + Math.sin(a) * 9 }, 4);
        if (p) route.push(p);
      }
    }
    route.push(b.staging ?? b.main?.pos ?? unit.pos);
    this.id = unit.id;
    this.route = route;
    this.idx = 0;
    this.startedAt = t;
    b.roles.set(unit.id, 'scout');
    if (!this.go(unit)) this.issuedAt = t - 2;
    return true;
  }

  private go(u: Entity): boolean {
    const wp = this.route[this.idx];
    if (!wp) return false;
    if (!this.b.issue({ type: 'move', playerId: this.b.me, unitIds: [u.id], target: { x: wp.x, y: wp.y } })) return false;
    this.issuedAt = this.b.world.time;
    return true;
  }

  private follow(): void {
    const b = this.b, t = b.world.time;
    const u = b.world.getAlive(this.id);
    if (!u || b.roles.get(u.id) !== 'scout' || t - this.startedAt > 180 || this.idx >= this.route.length) { this.finish(); return; }
    const last = this.route.length - 1;
    if (hpFrac(u) < 0.45 && this.idx < last) { this.idx = last; this.go(u); return; }
    const wp = this.route[this.idx]!;
    const arrived = dist(u.pos, wp) < 3 || (u.orders.length === 0 && t - this.issuedAt > 1);
    if (!arrived) return;
    if (this.idx >= last) { this.finish(); return; }
    this.idx++;
    if (!this.go(u)) this.idx--;
  }

  private finish(): void {
    if (this.id != null) { this.b.releaseRole(this.id, 'scout'); this.trips++; }
    this.id = null;
    this.route = [];
    this.idx = 0;
  }
}
