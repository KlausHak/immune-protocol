/**
 * A scripted "competent player" for campaign balance probes (headless). Plays the hospital through
 * world.issue like a human: keeps Orderlies mining, adds Wards before capping, builds Pharmacies, a
 * Generator, a Lab and a couple of UV Turrets, trains a Sanitizer/Medic/UV Lancer mix, defends alerts and
 * attacks once the army is big enough. Deliberately simple — no micro, no upgrades.
 */
import { angleOf, dist, sub } from '../../src/core/math';
import type { Entity, Vec2 } from '../../src/core/types';
import { getBuildingDef } from '../../src/data';
import type { HeadlessMatch } from '../../src/game/headless';
import { findBuildSpot, workersOnNode } from '../../src/sim/economy';

export interface BotPlan {
  /** where the army waits between attacks (default: 9 tiles from the HQ towards the enemy) */
  muster?: () => Vec2 | null;
  /** current attack objective, or null to stay home */
  target: () => Vec2 | null;
  /** attack once the army has at least this many units… */
  attackSize: number;
  /** …and not before this mission time */
  attackAfter: number;
  /** per-second mission-specific hook */
  extra?: (bot: PlayerBot) => void;
  maxWorkers?: number;
  turrets?: number;
}

export class PlayerBot {
  attacking = false;
  attacks = 0;
  private next = 0;
  private nextOrder = 0;
  private alert: { pos: Vec2; time: number } | null = null;

  constructor(readonly m: HeadlessMatch, readonly plan: BotPlan) {
    m.world.events.on('underAttack', ({ playerId, pos }) => {
      if (playerId === 1) this.alert = { pos: { ...pos }, time: m.world.time };
    });
  }

  get w() { return this.m.world; }
  hq(): Entity | undefined { return this.w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]; }
  army(): Entity[] { return this.w.entitiesOf(1, (e) => e.kind === 'unit' && !e.gatherer && (!!e.combat || !!(e.def.kind === 'unit' && e.def.heal))); }
  workers(): Entity[] { return this.w.entitiesOf(1, (e) => e.kind === 'unit' && !!e.gatherer); }

  muster(): Vec2 {
    const custom = this.plan.muster?.();
    if (custom) return custom;
    const hq = this.hq();
    const home = hq?.pos ?? this.w.player(1).startPos;
    const enemy = this.w.player(2).startPos;
    const a = angleOf(sub(enemy, home));
    return { x: home.x + Math.cos(a) * 9, y: home.y + Math.sin(a) * 9 };
  }

  tick(): void {
    if (this.w.time < this.next) return;
    this.next = this.w.time + 1;
    this.economy();
    this.construct();
    this.train();
    this.command();
    this.plan.extra?.(this);
  }

  private economy(): void {
    const w = this.w, hq = this.hq();
    if (!hq) return;
    const caches = w.list.filter((e) => e.alive && e.kind === 'resource' && (e.resource?.amount ?? 0) > 0 && dist(e.pos, hq.pos) < 26)
      .sort((a, b) => dist(a.pos, hq.pos) - dist(b.pos, hq.pos));
    for (const wk of this.workers()) {
      if (wk.orders.length > 0 || !caches.length) continue;
      const node = caches.find((c) => workersOnNode(w, c.id, 1) < 2) ?? caches[0]!;
      w.issue({ type: 'gather', playerId: 1, unitIds: [wk.id], targetId: node.id });
    }
    const p = w.player(1);
    if (this.workers().length < (this.plan.maxWorkers ?? 14) && (hq.production?.queue.length ?? 0) === 0 && p.resources.matter >= 50 && p.popUsed < p.popCap) {
      w.issue({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
    }
  }

  private construct(): void {
    const w = this.w, p = w.player(1), hq = this.hq();
    if (!hq) return;
    if (w.list.some((e) => e.alive && e.owner === 1 && e.kind === 'building' && e.construction)) return; // one at a time
    const have = (id: string) => w.countOf(1, id, false);
    let want: string | null = null;
    if (p.popCap - p.popUsed <= 4 && p.popCap < 150) want = 'hosp_ward';
    else if (have('hosp_pharmacy') < 1) want = 'hosp_pharmacy';
    else if (have('hosp_generator') < 1) want = 'hosp_generator';
    else if (have('hosp_pharmacy') < 2) want = 'hosp_pharmacy';
    else if (have('hosp_lab') < 1) want = 'hosp_lab';
    else if (have('hosp_uv_turret') < (this.plan.turrets ?? 2)) want = 'hosp_uv_turret';
    else if (have('hosp_generator') < 2) want = 'hosp_generator';
    else if (have('hosp_pharmacy') < 3 && p.resources.matter > 400) want = 'hosp_pharmacy';
    if (!want || !w.economy.canAfford(1, getBuildingDef(want).cost)) return;
    const near = want === 'hosp_uv_turret' ? this.muster() : hq.pos;
    const tile = findBuildSpot(w, 1, want, near, { maxRadius: 14 });
    if (!tile) return;
    const builder = this.workers().sort((a, b) => dist(a.pos, hq.pos) - dist(b.pos, hq.pos))[0];
    if (builder) w.issue({ type: 'build', playerId: 1, unitIds: [builder.id], defId: want, tile });
  }

  private train(): void {
    const w = this.w, p = w.player(1);
    const army = this.army();
    const count = (id: string) => army.filter((u) => u.defId === id).length;
    for (const b of w.entitiesOf(1, (e) => e.defId === 'hosp_pharmacy' && !e.construction)) {
      if ((b.production?.queue.length ?? 0) >= 2 || p.popUsed + 2 > p.popCap) continue;
      let unit = 'hosp_sanitizer';
      if (w.countOf(1, 'hosp_lab', false) > 0 && p.resources.energy >= 50 && p.resources.matter >= 100 && count('hosp_uv_lancer') * 3 < count('hosp_sanitizer')) unit = 'hosp_uv_lancer';
      else if (p.resources.energy >= 25 && p.resources.matter >= 75 && count('hosp_medic') * 6 < army.length) unit = 'hosp_medic';
      if (unit === 'hosp_sanitizer' && p.resources.matter < 50) continue;
      w.issue({ type: 'train', playerId: 1, buildingId: b.id, defId: unit });
    }
  }

  private command(): void {
    const w = this.w, army = this.army();
    if (!army.length) return;
    const target = this.plan.target();
    if (!this.attacking && target && army.length >= this.plan.attackSize && w.time >= this.plan.attackAfter) { this.attacking = true; this.attacks++; this.nextOrder = 0; }
    if (this.attacking && (!target || army.length < Math.max(4, this.plan.attackSize * 0.35))) { this.attacking = false; this.nextOrder = 0; }
    if (w.time < this.nextOrder) return;
    this.nextOrder = w.time + 4;
    const ids = (us: Entity[]) => us.map((u) => u.id);
    if (this.attacking && target) {
      const go = army.filter((u) => {
        const o = u.orders[0];
        return !o || (o.type === 'attackMove' && dist(o.target, target) > 6) || o.type === 'move';
      });
      if (go.length) w.issue({ type: 'attackMove', playerId: 1, unitIds: ids(go), target });
      return;
    }
    if (this.alert && w.time - this.alert.time < 8) {
      w.issue({ type: 'attackMove', playerId: 1, unitIds: ids(army), target: this.alert.pos });
      return;
    }
    const muster = this.muster();
    const stray = army.filter((u) => u.orders.length === 0 && dist(u.pos, muster) > 6);
    if (stray.length) w.issue({ type: 'attackMove', playerId: 1, unitIds: ids(stray), target: muster });
  }
}
