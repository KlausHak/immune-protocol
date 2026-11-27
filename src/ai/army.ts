/**
 * [ai] Army control. Fresh units rally at a staging point in front of the base. Attack waves launch on a
 * personality × difficulty timing and march as one squad along the ground path toward known enemy
 * structures (the enemy start location counts as known, like any human knows the start spots of a
 * 2-player map). The squad regroups when strung out, retreats when the visible fight turns bad,
 * receives reinforcements in groups, and micro-manages fights: ranged units focus-fire low-health
 * targets, Fungal Mortars are kept behind the melee line, badly hurt units go home to regenerate.
 */
import { clone, dist, normalize, sub } from '../core/math';
import type { Entity, EntityId, UnitDef, Vec2 } from '../core/types';
import type { Brain, Site, Snapshot } from './brain';
import { REPLICATOR, SPIRE } from './personality';
import {
  canHitGround, centroid, closestIndex, combatValue, costValue, hasWeapons, hpFrac, indexAhead, indexBehind, isAir, isRanged, isWorkerUnit, minRangeOf,
} from './util';

type SquadState = 'advance' | 'engage' | 'siege' | 'retreat' | 'return';
export type WaveOutcome = 'wiped' | 'retreat' | 'cleared' | 'recall';

export interface TargetChoice { pos: Vec2; id: EntityId | null; radius: number }

export interface Squad {
  units: Set<EntityId>;
  /** reinforcements still walking up (excluded from cohesion checks) */
  joining: Set<EntityId>;
  state: SquadState;
  stateAt: number;
  target: TargetChoice;
  /** walkable approach point next to the target */
  goal: Vec2;
  /** densified ground path toward the goal */
  path: Vec2[];
  idx: number;
  wpIdx: number;
  regroup: { idx: number; at: number } | null;
  regroupCooldown: number;
  /** last order key the squad gave each unit (avoids re-issuing the same order) */
  issued: Map<EntityId, string>;
  launchedAt: number;
  peakValue: number;
  progressAt: number;
  bestGoalDist: number;
  stuck: number;
  scripted: boolean;
  outcome: WaveOutcome;
}

/** Enemy things that fight back. */
const isThreat = (e: Entity): boolean =>
  e.kind === 'unit' ? !isWorkerUnit(e) && (hasWeapons(e) || e.tags.has('healer')) : hasWeapons(e) && !e.construction;

/** Wave timing & size: first wave from the personality (scaled by difficulty), then growing waves. */
export class WavePlanner {
  launched = 0;
  earliest: number;
  latest: number;
  size: number;
  minValue: number;
  lastOutcome: WaveOutcome | null = null;

  constructor(private b: Brain) {
    const fw = b.pers.firstWave, p = b.prof;
    this.earliest = fw.earliest * p.waveTimeMul;
    this.latest = fw.latest * p.waveTimeMul;
    this.size = Math.max(3, Math.round(b.rng.int(fw.minSize, fw.maxSize) * p.waveSizeMul));
    this.minValue = fw.minValue * p.waveSizeMul;
  }

  due(t: number, count: number, value: number, popUsed: number, enemyValue: number): boolean {
    if (count === 0) return false;
    if (popUsed >= 140 && count >= 8) return true; // maxed out: use it
    if (t < this.earliest) return false;
    if (count >= this.size && value >= this.minValue) {
      // hard+: don't walk a fresh wave into a clearly bigger army we have just seen
      if (this.b.prof.respectEnemyArmy && enemyValue > value * 1.4 && t < this.latest + 90) return false;
      return true;
    }
    return t >= this.latest && count >= Math.ceil(this.size * 0.6) && value >= this.minValue * 0.6;
  }

  onLaunched(): void { this.launched++; }

  onEnded(t: number, outcome: WaveOutcome): void {
    this.lastOutcome = outcome;
    const back = outcome === 'retreat' || outcome === 'recall';
    this.earliest = t + this.b.prof.waveIntervalSec * (back ? 0.7 : 1);
    this.latest = this.earliest + 75;
    this.size = Math.min(60, Math.max(this.size + 3, Math.round(this.size * 1.25)));
    this.minValue = this.minValue * 1.2 + 150;
  }
}

export class ArmyManager {
  squad: Squad | null = null;
  readonly waves: WavePlanner;
  private homeSent = new Map<EntityId, number>();
  private regenSent = new Map<EntityId, number>();
  private kiting = new Map<EntityId, number>();

  constructor(private b: Brain) { this.waves = new WavePlanner(b); }

  /** Home army: controlled combat units with no role (not attacking, defending, scouting or healing up). */
  homeUnits(s: Snapshot = this.b.snap()): Entity[] { return s.army.filter((u) => !this.b.roles.has(u.id)); }

  squadValue(): number {
    let v = 0;
    if (this.squad) for (const id of this.squad.units) { const u = this.b.world.getAlive(id); if (u) v += combatValue(u); }
    return v;
  }

  /** A wave is due within ~40 s (macro bumps army production). */
  waveSoon(): boolean { return !this.squad && this.b.flags.attack && this.b.world.time >= this.waves.earliest - 40; }

  think(): void {
    const b = this.b, s = b.snap(), t = b.world.time;
    this.tidy(s);
    this.updateRallies(s);
    if (this.squad && !b.flags.attack && !this.squad.scripted && this.squad.state !== 'retreat' && this.squad.state !== 'return') {
      this.goHome(this.squad, this.squadUnits(this.squad), 'recall');
    }
    if (this.squad) this.runSquad(this.squad);
    if (!this.squad && b.flags.attack) {
      const home = this.homeUnits(s);
      if (home.length) {
        let value = 0;
        for (const u of home) value += combatValue(u);
        if (this.waves.due(t, home.length, value, b.player.popUsed, b.memory.recentArmyValue(90))) this.launch(home, null, false);
      }
    }
    if (this.squad && this.squad.state !== 'retreat' && this.squad.state !== 'return') this.reinforce(s);
    this.manageHome(s);
    this.manageRegen(s);
  }

  // ───────────────────────── campaign hooks ─────────────────────────

  /** Launch every army unit now (campaign attackNow), merging into an active squad if there is one. */
  attackNow(target: Vec2 | null): void {
    const b = this.b, s = b.snap();
    const units = s.army.filter((u) => { const r = b.roles.get(u.id); return r !== 'scout' && r !== 'squad'; });
    const sq = this.squad;
    if (sq) {
      for (const u of units) { sq.units.add(u.id); sq.joining.add(u.id); b.roles.set(u.id, 'squad'); }
      sq.scripted = true;
      const all = this.squadUnits(sq);
      if (!all.length) return;
      const c = centroid(all);
      const tgt = target ? { pos: clone(target), id: null, radius: 0 } : sq.state === 'retreat' || sq.state === 'return' ? this.chooseTarget(c) : null;
      if (tgt) this.retarget(sq, tgt, c);
      return;
    }
    for (const u of units) b.roles.delete(u.id);
    this.launch(units, target, true);
  }

  /** Campaign setAttackTarget: redirect an active squad right away. */
  redirect(target: Vec2): void {
    const sq = this.squad;
    if (!sq || sq.state === 'retreat') return;
    const units = this.squadUnits(sq);
    if (units.length) this.retarget(sq, { pos: clone(target), id: null, radius: 0 }, centroid(units));
  }

  /** End the current squad (defence recall etc.). Its units become home units. */
  disband(outcome: WaveOutcome): void { this.end(outcome); }

  // ───────────────────────── squads ─────────────────────────

  private squadUnits(sq: Squad): Entity[] {
    const out: Entity[] = [];
    for (const id of sq.units) {
      const u = this.b.world.getAlive(id);
      if (u && this.b.isControlled(u)) out.push(u);
      else { sq.units.delete(id); sq.joining.delete(id); }
    }
    return out;
  }

  private launch(units: Entity[], forced: Vec2 | null, scripted: boolean): boolean {
    const b = this.b, t = b.world.time;
    const list = units.filter((u) => u.alive);
    if (!list.length) return false;
    const ground = list.filter((u) => !isAir(u));
    const c = centroid(ground.length ? ground : list);
    const target = forced ? { pos: clone(forced), id: null, radius: 0 } : this.chooseTarget(c);
    if (!target) return false;
    let value = 0;
    for (const u of list) value += combatValue(u);
    const goal = this.goalFor(target, c);
    const sq: Squad = {
      units: new Set(list.map((u) => u.id)), joining: new Set(), state: 'advance', stateAt: t, target, goal,
      path: b.pathPoints(c, goal), idx: 0, wpIdx: 0, regroup: null, regroupCooldown: 0, issued: new Map(), launchedAt: t, peakValue: value,
      progressAt: t, bestGoalDist: Infinity, stuck: 0, scripted, outcome: 'cleared',
    };
    for (const u of list) b.roles.set(u.id, 'squad');
    this.squad = sq;
    this.waves.onLaunched();
    this.advance(sq, list, list, c);
    return true;
  }

  private end(outcome: WaveOutcome): void {
    const sq = this.squad;
    if (!sq) return;
    for (const id of sq.units) this.b.releaseRole(id, 'squad');
    this.squad = null;
    this.waves.onEnded(this.b.world.time, outcome);
  }

  private setState(sq: Squad, st: SquadState): void {
    if (sq.state !== st) { sq.state = st; sq.stateAt = this.b.world.time; }
  }

  private goalFor(target: TargetChoice, from: Vec2): Vec2 {
    const dir = normalize(sub(from, target.pos));
    const off = target.radius + 2;
    const p = { x: target.pos.x + dir.x * off, y: target.pos.y + dir.y * off };
    return this.b.walkable(p) ?? this.b.walkable(target.pos) ?? clone(target.pos);
  }

  private retarget(sq: Squad, target: TargetChoice, c: Vec2): void {
    sq.target = target;
    sq.goal = this.goalFor(target, c);
    sq.path = this.b.pathPoints(c, sq.goal);
    sq.idx = 0;
    sq.wpIdx = 0;
    sq.regroup = null;
    sq.issued.clear();
    sq.bestGoalDist = Infinity;
    sq.progressAt = this.b.world.time;
    sq.stuck = 0;
    this.setState(sq, 'advance');
  }

  private runSquad(sq: Squad): void {
    const b = this.b;
    const units = this.squadUnits(sq);
    if (!units.length) { this.end('wiped'); return; }
    const core0 = units.filter((u) => !sq.joining.has(u.id));
    const core = core0.length ? core0 : units;
    const ground = core.filter((u) => !isAir(u));
    const c = centroid(ground.length ? ground : core);
    for (const u of units) if (sq.joining.has(u.id) && dist(u.pos, c) < 10) sq.joining.delete(u.id);
    let value = 0;
    for (const u of units) value += combatValue(u);
    sq.peakValue = Math.max(sq.peakValue, value);

    if (sq.state === 'retreat' || sq.state === 'return') { this.runReturn(sq, units); return; }

    const threats = b.enemiesNear(c, 13, isThreat);
    if (threats.length) {
      let mine = 0, theirs = 0;
      for (const u of core) if (dist(u.pos, c) <= 15) mine += combatValue(u);
      for (const e of threats) theirs += combatValue(e);
      const lost = 1 - value / Math.max(1, sq.peakValue);
      const ratio = mine / Math.max(1, theirs);
      const rr = b.prof.retreatRatio;
      if (ratio < rr && (lost > 0.2 || ratio < rr * 0.6)) { this.retreat(sq, units); return; }
      this.setState(sq, 'engage');
      this.engage(sq, units, threats, c);
      return;
    }
    if (sq.state === 'siege' || dist(c, sq.goal) < 9) { this.siege(sq, units, c); return; }
    this.setState(sq, 'advance');
    this.advance(sq, units, core, c);
  }

  /** Follow the path with cohesion: hold the front while the tail catches up; mortars march at the rear. */
  private advance(sq: Squad, units: Entity[], core: Entity[], c: Vec2): void {
    const b = this.b, t = b.world.time;
    const dGoal = dist(c, sq.goal);
    if (dGoal < sq.bestGoalDist - 1.5) { sq.bestGoalDist = dGoal; sq.progressAt = t; }
    else if (t - sq.progressAt > 25) {
      // stuck: re-path from here; after repeated failures pick another target or go home
      sq.stuck++;
      if (sq.stuck >= 3) {
        const next = b.flags.attack || sq.scripted ? this.chooseTarget(c, sq.target) : null;
        if (next) this.retarget(sq, next, c);
        else this.goHome(sq, units, 'cleared');
        return;
      }
      sq.path = b.pathPoints(c, sq.goal);
      sq.idx = 0; sq.wpIdx = 0; sq.regroup = null; sq.issued.clear(); sq.progressAt = t; sq.bestGoalDist = dGoal;
    }
    if (!sq.path.length) sq.path = [clone(sq.goal)];
    const path = sq.path;
    sq.idx = closestIndex(path, c, Math.max(0, sq.idx - 3), 60);

    const ground = core.filter((u) => !isAir(u));
    const group = ground.length >= 3 ? ground : core;
    let far = 0;
    for (const u of group) if (dist(u.pos, c) > 9) far++;
    if (group.length >= 4) {
      // regroup when strung out; give up after 8 s (stragglers stuck behind something) and don't retry for 15 s
      if (!sq.regroup && far > group.length * 0.3 && t >= sq.regroupCooldown) sq.regroup = { idx: sq.idx, at: t };
      else if (sq.regroup && (far <= group.length * 0.15 || t - sq.regroup.at > 8)) { sq.regroup = null; sq.regroupCooldown = t + 15; }
    } else sq.regroup = null;

    let wpIdx: number, key: string;
    if (sq.regroup) { wpIdx = sq.regroup.idx; key = `rg${wpIdx}`; }
    else {
      wpIdx = sq.wpIdx;
      // Lead the waypoint before the group stops: advance once the centroid is close, or once most of the
      // group has arrived (formation slots can leave the centroid a few tiles short of the point).
      const cur = path[wpIdx]!;
      let arrived = 0;
      for (const u of group) if (u.orders.length === 0 || dist(u.pos, cur) < 6) arrived++;
      if (wpIdx <= sq.idx || dist(c, cur) < 6 || arrived >= group.length * 0.6 || sq.issued.size === 0) wpIdx = indexAhead(path, sq.idx, 12);
      sq.wpIdx = wpIdx;
      key = `wp${wpIdx}`;
    }
    const wp = path[wpIdx]!;
    const rear = path[indexBehind(path, wpIdx, 3.5)]!;
    const front: EntityId[] = [], back: EntityId[] = [];
    for (const u of units) {
      if ((this.kiting.get(u.id) ?? -1) >= t) continue;
      const isRear = minRangeOf(u) > 0;
      const dest = isRear ? rear : wp;
      if (sq.issued.get(u.id) === key && (u.orders.length > 0 || dist(u.pos, dest) < 5)) continue;
      (isRear ? back : front).push(u.id);
    }
    if (front.length && b.issue({ type: 'attackMove', playerId: b.me, unitIds: front, target: clone(wp) })) for (const id of front) sq.issued.set(id, key);
    if (back.length && b.issue({ type: 'attackMove', playerId: b.me, unitIds: back, target: clone(rear) })) for (const id of back) sq.issued.set(id, key);
  }

  private engage(sq: Squad, units: Entity[], threats: Entity[], c: Vec2): void {
    const b = this.b, t = b.world.time;
    sq.progressAt = t;
    sq.bestGoalDist = Math.min(sq.bestGoalDist, dist(c, sq.goal) + 3);
    if (b.prof.pullHurt) this.pullHurt(sq, units);
    if (b.prof.kiteMortars) this.kite(sq, units, threats);
    if (b.prof.focusFire) this.focusFire(sq, units, threats);
    const idle = units.filter((u) => u.alive && sq.units.has(u.id) && u.orders.length === 0 && (this.kiting.get(u.id) ?? -1) < t);
    if (!idle.length) return;
    let best = threats[0]!, bd = Infinity;
    for (const e of threats) { const d = dist(e.pos, c); if (d < bd) { bd = d; best = e; } }
    if (b.issue({ type: 'attackMove', playerId: b.me, unitIds: idle.map((u) => u.id), target: clone(best.pos) })) for (const u of idle) sq.issued.set(u.id, 'fight');
  }

  /** At the target: knock down every structure around it, then move on (or go home). */
  private siege(sq: Squad, units: Entity[], c: Vec2): void {
    const b = this.b, t = b.world.time;
    this.setState(sq, 'siege');
    const vis = b.enemiesNear(c, 14, (e) => e.kind === 'building');
    const remembered = b.memory.structuresNear(sq.target.pos, 14);
    if ((vis.length || remembered.length) && t - sq.stateAt < 150) {
      const idle = units.filter((u) => u.orders.length === 0 && (this.kiting.get(u.id) ?? -1) < t);
      if (!idle.length) return;
      let pos: Vec2 | null = null, rad = 1, bd = Infinity;
      for (const e of vis) { const d = dist(e.pos, c); if (d < bd) { bd = d; pos = e.pos; rad = e.radius; } }
      if (!pos) for (const st of remembered) { const d = dist(st.pos, c); if (d < bd) { bd = d; pos = st.pos; rad = st.radius; } }
      if (!pos) return;
      const g = this.goalFor({ pos, id: null, radius: rad }, c);
      if (b.issue({ type: 'attackMove', playerId: b.me, unitIds: idle.map((u) => u.id), target: g })) for (const u of idle) sq.issued.set(u.id, 'siege');
      return;
    }
    const next = b.flags.attack ? this.chooseTarget(c, sq.target) : null;
    if (next && dist(next.pos, sq.target.pos) > 4) { this.retarget(sq, next, c); return; }
    this.goHome(sq, units, 'cleared');
  }

  private retreat(sq: Squad, units: Entity[]): void {
    const b = this.b;
    const dest = b.staging ?? b.main?.pos;
    if (!dest) { this.end('retreat'); return; }
    this.setState(sq, 'retreat');
    sq.outcome = 'retreat';
    b.issue({ type: 'move', playerId: b.me, unitIds: units.map((u) => u.id), target: clone(dest) }, true);
    for (const u of units) sq.issued.set(u.id, 'retreat');
  }

  private goHome(sq: Squad, units: Entity[], outcome: WaveOutcome): void {
    const b = this.b;
    const dest = b.staging ?? b.main?.pos;
    if (!dest || !units.length) { this.end(outcome); return; }
    this.setState(sq, 'return');
    sq.outcome = outcome;
    b.issue({ type: 'attackMove', playerId: b.me, unitIds: units.map((u) => u.id), target: clone(dest) }, true);
    for (const u of units) sq.issued.set(u.id, 'return');
  }

  private runReturn(sq: Squad, units: Entity[]): void {
    const b = this.b, t = b.world.time;
    const dest = b.staging ?? b.main?.pos;
    if (!dest) { this.end(sq.outcome); return; }
    let home = 0;
    for (const u of units) if (dist(u.pos, dest) < 10) home++;
    if (home >= units.length * 0.7 || t - sq.stateAt > 45) { this.end(sq.outcome); return; }
    const idle = units.filter((u) => u.orders.length === 0 && dist(u.pos, dest) >= 10);
    if (idle.length) b.issue({ type: sq.state === 'retreat' ? 'move' : 'attackMove', playerId: b.me, unitIds: idle.map((u) => u.id), target: clone(dest) }, sq.state === 'retreat');
  }

  private reinforce(s: Snapshot): void {
    const b = this.b, sq = this.squad, st = b.staging;
    if (!sq || !st || b.defense.threatValue > 0) return;
    const ready = this.homeUnits(s).filter((u) => dist(u.pos, st) < 14);
    if (ready.length < b.prof.reinforceMin) return;
    for (const u of ready) { sq.units.add(u.id); sq.joining.add(u.id); b.roles.set(u.id, 'squad'); }
  }

  // ───────────────────────── micro ─────────────────────────

  /** Badly hurt, valuable units walk home to regenerate (pathogens heal over time). */
  private pullHurt(sq: Squad, units: Entity[]): void {
    const b = this.b, t = b.world.time, st = b.staging;
    if (!st) return;
    const hurt = units.filter((u) => costValue((u.def as UnitDef).cost) >= 75 && hpFrac(u) < 0.3 && t - u.lastDamagedAt < 2);
    if (!hurt.length || units.length - hurt.length < 3) return;
    if (!b.issue({ type: 'move', playerId: b.me, unitIds: hurt.map((u) => u.id), target: clone(st) })) return;
    for (const u of hurt) {
      sq.units.delete(u.id);
      sq.joining.delete(u.id);
      b.roles.set(u.id, 'regen');
      this.regenSent.set(u.id, t);
    }
  }

  /** Mortars (min range) step back when a ground attacker gets inside their dead zone. */
  private kite(sq: Squad, units: Entity[], threats: Entity[]): void {
    const b = this.b, w = b.world, t = w.time;
    let n = 0;
    for (const m of units) {
      const minR = minRangeOf(m);
      if (minR <= 0 || (this.kiting.get(m.id) ?? -1) >= t || !sq.units.has(m.id)) continue;
      let near: Entity | null = null, nd = Infinity;
      for (const e of threats) {
        if (e.kind !== 'unit' || isAir(e) || !canHitGround(e)) continue;
        const d = w.edgeDistance(m, e);
        if (d < nd) { nd = d; near = e; }
      }
      if (!near || nd > minR + 1.2) continue;
      let dir = normalize(sub(m.pos, near.pos));
      if (dir.x === 0 && dir.y === 0 && b.staging) dir = normalize(sub(b.staging, m.pos));
      const dest = b.walkable({ x: m.pos.x + dir.x * 4, y: m.pos.y + dir.y * 4 }, 4);
      if (!dest) continue;
      if (!b.issue({ type: 'move', playerId: b.me, unitIds: [m.id], target: dest })) break;
      this.kiting.set(m.id, t + 1.6);
      sq.issued.set(m.id, 'kite');
      if (++n >= 3) break;
    }
  }

  private currentTargetId(u: Entity): EntityId | null {
    const o = u.orders[0];
    if (o?.type === 'attack') return o.targetId;
    return u.combat?.targetId ?? null;
  }

  /** Ranged units gang up on the weakest threats in reach, enough damage per target and no more. */
  private focusFire(sq: Squad, units: Entity[], threats: Entity[]): void {
    const b = this.b, w = b.world, t = w.time;
    const free = units.filter((u) => isRanged(u) && sq.units.has(u.id) && (this.kiting.get(u.id) ?? -1) < t);
    if (free.length < 2) return;
    const targets = threats
      .filter((e) => e.alive)
      .sort((x, y) => (x.kind === 'unit' ? 0 : 1) - (y.kind === 'unit' ? 0 : 1) || x.hp + x.stats.armor * 6 - (y.hp + y.stats.armor * 6) || x.id - y.id);
    const plan: Array<{ target: Entity; ids: EntityId[] }> = [];
    for (const tg of targets) {
      if (!free.length) break;
      let dmg = 0;
      const ids: EntityId[] = [];
      for (let i = 0; i < free.length; ) {
        const u = free[i]!;
        const wpn = w.combat.weaponFor(u, tg);
        const d = wpn ? w.edgeDistance(u, tg) : Infinity;
        if (!wpn || d > w.combat.weaponRange(u, wpn) + 1.5 || d < (wpn.minRange ?? 0)) { i++; continue; }
        // keep a reasonable current target (avoids target dancing)
        const curId = this.currentTargetId(u);
        const cur = curId != null && curId !== tg.id ? w.getAlive(curId) : undefined;
        if (cur && w.combat.canTarget(u, cur) && w.edgeDistance(u, cur) <= w.combat.weaponRange(u, wpn) + 0.5 && cur.hp <= tg.hp * 1.6) { free.splice(i, 1); continue; }
        free.splice(i, 1);
        ids.push(u.id);
        dmg += Math.max(0.5, w.combat.rawDamage(u, wpn, tg) * (tg.stats.resist[wpn.damageType] ?? 1) - tg.stats.armor);
        if (dmg >= tg.hp * 1.15) break;
      }
      if (ids.length) plan.push({ target: tg, ids });
    }
    let cmds = 0;
    for (const { target, ids } of plan) {
      const change = ids.filter((id) => { const u = w.getAlive(id); return !!u && this.currentTargetId(u) !== target.id; });
      if (!change.length) continue;
      if (cmds >= 3 || !b.issue({ type: 'attack', playerId: b.me, unitIds: change, targetId: target.id })) break;
      cmds++;
      for (const id of change) sq.issued.set(id, 'focus');
    }
  }

  // ───────────────────────── home army ─────────────────────────

  private tidy(s: Snapshot): void {
    const sq = this.squad;
    for (const u of s.army) if (this.b.roles.get(u.id) === 'squad' && (!sq || !sq.units.has(u.id))) this.b.roles.delete(u.id);
    if (this.homeSent.size > 300) for (const id of [...this.homeSent.keys()]) if (!this.b.world.getAlive(id)) this.homeSent.delete(id);
    if (this.kiting.size > 100) for (const [id, until] of [...this.kiting]) if (until < this.b.world.time) this.kiting.delete(id);
    if (this.regenSent.size > 100) for (const id of [...this.regenSent.keys()]) if (!this.b.world.getAlive(id)) this.regenSent.delete(id);
  }

  private updateRallies(s: Snapshot): void {
    const st = this.b.staging;
    if (!st) return;
    const need: EntityId[] = [];
    for (const p of [...s.doneOf(REPLICATOR), ...s.doneOf(SPIRE)]) if (!p.rally || dist(p.rally.pos, st) > 2) need.push(p.id);
    if (need.length) this.b.issue({ type: 'setRally', playerId: this.b.me, buildingIds: need, target: clone(st) });
  }

  private manageHome(s: Snapshot): void {
    const b = this.b, st = b.staging, t = b.world.time;
    if (!st) return;
    const send: EntityId[] = [];
    for (const u of this.homeUnits(s)) {
      if (u.orders.length || dist(u.pos, st) < 7 || t - (this.homeSent.get(u.id) ?? -99) < 8) continue;
      this.homeSent.set(u.id, t);
      send.push(u.id);
    }
    if (send.length) b.issue({ type: 'attackMove', playerId: b.me, unitIds: send, target: clone(st) });
  }

  private manageRegen(s: Snapshot): void {
    const b = this.b, st = b.staging, t = b.world.time;
    for (const u of s.army) {
      if (b.roles.get(u.id) !== 'regen') continue;
      if (hpFrac(u) >= 0.8) { b.roles.delete(u.id); continue; }
      if (st && u.orders.length === 0 && dist(u.pos, st) > 8 && t - (this.regenSent.get(u.id) ?? -99) > 6) {
        this.regenSent.set(u.id, t);
        b.issue({ type: 'move', playerId: b.me, unitIds: [u.id], target: clone(st) });
      }
    }
  }

  // ───────────────────────── targeting ─────────────────────────

  /**
   * Next attack target from what we know: the override, else the best remembered enemy structure
   * (closest, adjusted for defences / value on smarter difficulties), else the enemy start location,
   * else the resource site we haven't looked at for the longest (hunting hidden expansions).
   */
  chooseTarget(from: Vec2, avoid?: TargetChoice): TargetChoice | null {
    const b = this.b, mem = b.memory, t = b.world.time;
    if (b.attackOverride) return { pos: clone(b.attackOverride), id: null, radius: 0 };
    const structs = [...mem.structures.values()].filter((s) => !avoid || dist(s.pos, avoid.pos) > 4);
    if (structs.length) {
      let best = structs[0]!, bs = Infinity;
      for (const s of structs) {
        let score = dist(from, s.pos);
        if (b.prof.smartTargets) score += 18 * mem.armedNear(s.pos, 9) - (s.hq ? 12 : 0) - (s.producer ? 6 : 0) + (s.wall ? 10 : 0);
        if (score < bs) { bs = score; best = s; }
      }
      if (b.prof.mistakeRate > 0 && b.rng.chance(b.prof.mistakeRate)) best = structs[b.rng.int(0, structs.length - 1)]!;
      return { pos: clone(best.pos), id: best.id, radius: best.radius };
    }
    for (const es of b.enemyStarts) {
      if (b.world.players.get(es.playerId)?.defeated || (avoid && dist(es.pos, avoid.pos) < 4)) continue;
      const l = mem.lastLooked(es.pos);
      if (l < 0 || t - l > 90) return { pos: clone(es.pos), id: null, radius: 2.5 };
    }
    let best: Site | null = null, oldest = Infinity;
    for (const site of b.sites) {
      if (b.ownsSite(site) || (avoid && dist(site.center, avoid.pos) < 4)) continue;
      const l = mem.lastLooked(site.center);
      if (l < oldest) { oldest = l; best = site; }
    }
    if (best && (oldest < 0 || t - oldest > 45)) return { pos: clone(best.center), id: null, radius: 1.5 };
    return null;
  }
}
