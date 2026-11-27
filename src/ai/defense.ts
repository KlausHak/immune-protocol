/**
 * [ai] Base defence. Watches every base (and outlying buildings) for visible enemies and underAttack
 * alerts; after the difficulty's reaction delay it sends enough home units to beat each threat, recalls
 * the attack squad when home is in real trouble, pulls workers to fight only in emergencies (a small raid
 * with no army around) and cancels doomed foundations for the 75% refund.
 */
import { clone, dist } from '../core/math';
import type { Entity, EntityId, Vec2 } from '../core/types';
import type { Base, Brain } from './brain';
import { SPITTER } from './personality';
import { centroid, combatValue, hasWeapons, hpFrac, isAir } from './util';

interface Zone { key: string; center: Vec2; radius: number; isMain: boolean; base: Base | null }
interface Threat { zone: Zone; pos: Vec2; value: number; units: Entity[]; since: number; lastSeen: number }

export class DefenseManager {
  /** total value of the threats currently being answered (0 = peace) */
  threatValue = 0;
  /** number of distinct threats answered so far (telemetry) */
  responses = 0;
  private threats = new Map<string, Threat>();
  private sent = new Map<EntityId, { t: number; pos: Vec2 }>();

  constructor(private b: Brain) {}

  saveState(): Record<string, unknown> {
    const threats = [...this.threats].map(([k, th]) => [k, {
      zone: { key: th.zone.key, center: th.zone.center, radius: th.zone.radius, isMain: th.zone.isMain, base: th.zone.base?.hive.id ?? null },
      pos: th.pos, value: th.value, units: th.units.map((e) => e.id), since: th.since, lastSeen: th.lastSeen,
    }]);
    return { threatValue: this.threatValue, responses: this.responses, threats, sent: this.sent };
  }

  loadState(data: unknown): void {
    type Saved = { zone: { key: string; center: Vec2; radius: number; isMain: boolean; base: EntityId | null }; pos: Vec2; value: number; units: EntityId[]; since: number; lastSeen: number };
    const d = (data ?? {}) as { threatValue?: number; responses?: number; threats?: Array<[string, Saved]>; sent?: Map<EntityId, { t: number; pos: Vec2 }> };
    this.threatValue = d.threatValue ?? 0;
    this.responses = d.responses ?? 0;
    this.sent = d.sent ?? new Map();
    this.threats.clear();
    for (const [k, th] of d.threats ?? []) {
      const base = th.zone.base == null ? null : this.b.bases.find((b) => b.hive.id === th.zone.base) ?? null;
      const units = th.units.map((id) => this.b.world.get(id)).filter((e): e is Entity => !!e);
      this.threats.set(k, { zone: { ...th.zone, base }, pos: th.pos, value: th.value, units, since: th.since, lastSeen: th.lastSeen });
    }
  }

  think(): void {
    const b = this.b;
    if (!b.flags.defend) { this.standDown(); this.threats.clear(); this.threatValue = 0; return; }
    b.refreshBases();
    const t = b.world.time;
    const seen = new Set<string>();
    for (const z of this.zones()) {
      const enemies = b.enemiesNear(z.center, z.radius, (e) => e.kind === 'unit' || (hasWeapons(e) && !e.construction));
      const hits = b.attacks.filter((a) => t - a.t < 5 && dist(a.pos, z.center) <= z.radius + 2);
      if (!enemies.length && !hits.length) continue;
      let value = 0;
      for (const e of enemies) value += combatValue(e);
      // attacked by something we can't see (out-ranged / high ground): go and look
      if (!enemies.length) value = 60;
      const pos = enemies.length ? centroid(enemies) : clone(hits[hits.length - 1]!.pos);
      seen.add(z.key);
      const th = this.threats.get(z.key);
      if (th) { th.zone = z; th.pos = pos; th.value = value; th.units = enemies; th.lastSeen = t; }
      else { this.threats.set(z.key, { zone: z, pos, value, units: enemies, since: t, lastSeen: t }); }
    }
    for (const [k, th] of this.threats) if (!seen.has(k) && t - th.lastSeen > 4) this.threats.delete(k);
    const active = [...this.threats.values()].filter((th) => t - th.since >= b.prof.reactionSec).sort((x, y) => y.value - x.value);
    const was = this.threatValue;
    this.threatValue = active.reduce((a, th) => a + th.value, 0);
    if (!active.length) { if (was > 0) this.standDown(); return; }
    if (was === 0) this.responses++;
    this.respond(active);
    if (b.prof.cancelDoomed) this.cancelDoomed();
  }

  private zones(): Zone[] {
    const b = this.b, s = b.snap(), main = b.main;
    const zones: Zone[] = b.bases.map((base) => ({ key: `h${base.hive.id}`, center: base.pos, radius: 16, isMain: base === main, base }));
    for (const bld of s.buildings) {
      if (zones.some((z) => dist(z.center, bld.pos) <= z.radius)) continue;
      zones.push({ key: `b${bld.id}`, center: clone(bld.pos), radius: 10, isMain: false, base: null });
    }
    return zones;
  }

  private spitterValue(z: Zone): number {
    let v = 0;
    for (const sp of this.b.snap().doneOf(SPITTER)) if (dist(sp.pos, z.center) <= z.radius) v += combatValue(sp);
    return v;
  }

  private respond(active: Threat[]): void {
    const b = this.b, army = b.army;
    const pool = (): Entity[] => b.snap().army.filter((u) => { const r = b.roles.get(u.id); return !r || r === 'defender'; });
    let units = pool();
    let have = 0;
    for (const u of units) have += combatValue(u);
    for (const th of active) have += this.spitterValue(th.zone);
    // Home is in real trouble → bring the attack squad back.
    const sq = army.squad;
    if (sq && b.prof.recallSquad && this.threatValue >= 120 && have < this.threatValue * 1.1) {
      const mainHit = active.some((th) => th.zone.isMain);
      if (sq.state === 'advance' || this.threatValue > army.squadValue() * 0.5 || (mainHit && this.threatValue > have)) {
        army.disband('recall');
        units = pool();
      }
    }
    const assigned = new Set<EntityId>();
    for (const th of active) {
      const need = th.value * 1.4 + 1;
      const cands = units.filter((u) => !assigned.has(u.id)).sort((x, y) => dist(x.pos, th.pos) - dist(y.pos, th.pos) || x.id - y.id);
      let got = 0;
      const chosen: Entity[] = [];
      for (const u of cands) {
        if (got >= need) break;
        chosen.push(u);
        got += combatValue(u);
        assigned.add(u.id);
      }
      this.dispatch(chosen, th);
      if (b.prof.militia && th.zone.base && got + this.spitterValue(th.zone) < th.value * 0.6) this.militia(th);
    }
    for (const u of units) if (b.roles.get(u.id) === 'defender' && !assigned.has(u.id)) b.roles.delete(u.id);
    this.releaseHurtMilitia();
  }

  private dispatch(units: Entity[], th: Threat): void {
    const b = this.b, t = b.world.time;
    const go: EntityId[] = [];
    for (const u of units) {
      b.roles.set(u.id, 'defender');
      const last = this.sent.get(u.id);
      if (last && u.orders.length > 0 && dist(last.pos, th.pos) < 5) continue; // already on its way
      if (last && t - last.t < 1.5) continue;
      go.push(u.id);
      this.sent.set(u.id, { t, pos: clone(th.pos) });
    }
    if (go.length) b.issue({ type: 'attackMove', playerId: b.me, unitIds: go, target: clone(th.pos) }, true);
  }

  /** Emergency only: a small raid inside the base and no army to stop it → the nearby drones fight. */
  private militia(th: Threat): void {
    const b = this.b, s = b.snap(), t = b.world.time;
    const raiders = th.units.filter((e) => e.kind === 'unit' && !isAir(e));
    if (!raiders.length || th.value > 600 || !raiders.some((e) => dist(e.pos, th.zone.center) < 12)) return;
    const cands = s.workers
      .filter((w) => { const r = b.roles.get(w.id); return (!r || r === 'militia') && dist(w.pos, th.pos) < 14 && hpFrac(w) > 0.4; })
      .sort((x, y) => dist(x.pos, th.pos) - dist(y.pos, th.pos) || x.id - y.id);
    const want = Math.min(cands.length, Math.max(4, raiders.length * 3));
    const go: EntityId[] = [];
    for (const w of cands.slice(0, want)) {
      const last = this.sent.get(w.id);
      b.roles.set(w.id, 'militia');
      if (last && w.orders.length > 0 && dist(last.pos, th.pos) < 5) continue;
      if (last && t - last.t < 1.5) continue;
      go.push(w.id);
      this.sent.set(w.id, { t, pos: clone(th.pos) });
    }
    if (go.length) b.issue({ type: 'attackMove', playerId: b.me, unitIds: go, target: clone(th.pos) }, true);
  }

  private releaseHurtMilitia(): void {
    const b = this.b;
    const back: EntityId[] = [];
    for (const w of b.snap().workers) if (b.roles.get(w.id) === 'militia' && hpFrac(w) <= 0.35) { b.roles.delete(w.id); back.push(w.id); }
    this.backToWork(back);
  }

  /** Threats over: defenders become home units again, militia goes back to mining. */
  private standDown(): void {
    const b = this.b;
    const back: EntityId[] = [];
    for (const [id, r] of b.roles) {
      if (r === 'defender') b.roles.delete(id);
      else if (r === 'militia') { b.roles.delete(id); back.push(id); }
    }
    this.backToWork(back);
    this.sent.clear();
    this.threatValue = 0;
  }

  private backToWork(ids: EntityId[]): void {
    if (!ids.length) return;
    const b = this.b;
    const base = b.main;
    if (!base || !base.caches.length) { b.issue({ type: 'stop', playerId: b.me, unitIds: ids }, true); return; }
    const load = b.cacheLoad();
    let best = base.caches[0]!, bl = Infinity;
    for (const c of base.caches) { const l = load.get(c.id) ?? 0; if (l < bl) { bl = l; best = c; } }
    b.issue({ type: 'gather', playerId: b.me, unitIds: ids, targetId: best.id }, true);
  }

  /** A foundation that is being torn down early is cancelled (75% refund) instead of lost. */
  private cancelDoomed(): void {
    const b = this.b, s = b.snap(), t = b.world.time;
    for (const list of s.wip.values()) {
      for (const bld of list) {
        const c = bld.construction;
        if (!c || t - bld.lastDamagedAt > 1.5) continue;
        const frac = Math.min(1, c.progress / Math.max(1e-6, c.total));
        if (frac > 0.85) continue;
        const expected = bld.stats.maxHp * (0.1 + 0.9 * frac);
        if (bld.hp > expected * 0.35) continue;
        if (!b.enemiesNear(bld.pos, 9, hasWeapons).length) continue;
        b.issue({ type: 'cancelConstruction', playerId: b.me, buildingId: bld.id }, true);
      }
    }
  }
}
