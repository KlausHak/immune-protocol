/**
 * [vfx] Feedback effects:
 *  - entityDamaged → small "material response" hit sparks (metal sparks on machines & hospital
 *    structures, goo droplets on pathogens, a white suit-flash on staff), throttled per target;
 *  - entityHealed → medic heal beam (thin teal strip with flowing motes) + rising "+" on the patient,
 *    or orderly repair welding (arc + sparks) on machines/structures;
 *  - construction started/complete, production complete, resource delivered;
 *  - persistent emitters polled every 0.25 s from world.list: smoke (< 50 %) / fire (< 25 %) on hospital
 *    buildings, ooze on damaged pathogen structures, weld sparks / bio-bubbling on foundations under
 *    construction, smoke on badly damaged hospital machines.
 */
import * as THREE from 'three';
import type { BuildingDef, Entity, EntityId, GameEvents } from '../../core/types';
import { SPR } from './atlas';
import type { VfxCore } from './core';
import { PM_GROUND, PM_STRETCH } from './particles';
import type { WeaponFx } from './weapons';

export type HitMaterial = 'metal' | 'building' | 'goo' | 'staff' | 'dust';

const M_NONE = 0, M_SMOKE = 1, M_FIRE = 2, M_OOZE = 3, M_OOZE2 = 4, M_BUILD_H = 5, M_BUILD_P = 6, M_UNIT_SMOKE = 7;

class Tracked {
  e!: Entity;
  mode = M_NONE;
  stamp = 0;
  visible = true;
  lastProgress = -1;
  building = false;
  w = 1; d = 1; h = 1;
  acc = new Float32Array(4);
  next = 0;          // next burst time (weld sparks, ooze spurts)
  pts = new Float32Array(9); // up to 3 emit points (local dx, height fraction, dz)
  nPts = 1;
}

class HealBeam {
  src: Entity | null = null;
  tgt: Entity | null = null;
  until = 0;
  t0 = 0;
  seed = 0;
  acc = 0;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const col = new THREE.Color();

export class FeedbackFx {
  private tracked = new Map<EntityId, Tracked>();
  private list: Tracked[] = [];
  private freeTracked: Tracked[] = [];
  private pollAt = 0;
  private stamp = 0;
  private lastHit = new Map<EntityId, number>();
  private lastPlus = new Map<EntityId, number>();
  private lastRepair = new Map<EntityId, number>();
  private beams: HealBeam[] = [];
  private freeBeams: HealBeam[] = [];

  constructor(private readonly c: VfxCore, private readonly weapons: WeaponFx) {}

  get trackedCount(): number { return this.list.length; }

  // ───────────────────────── events ─────────────────────────
  onDamaged = (ev: GameEvents['entityDamaged']): void => {
    const c = this.c, t = ev.entity;
    if (c.hitBudget <= 0) return;
    const last = this.lastHit.get(t.id) ?? -1;
    if (c.world.time - last < 0.1) return;
    c.stampEvent();
    let fx = t.pos.x, fz = t.pos.y;
    if (ev.source) { fx = ev.source.pos.x; fz = ev.source.pos.y; }
    const p = c.hitPoint(t, fx, fz, tmpA);
    if (!c.canSee(p.x, p.y, p.z, 1)) return;
    this.lastHit.set(t.id, c.world.time);
    c.hitBudget--;
    const k = Math.min(2, Math.max(0.6, ev.amount / 10));
    let dx = fx - p.x, dz = fz - p.z;
    const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    this.hitSparks(t, p.x, p.y, p.z, dx, dz, k, ev.type === 'uv');
  };

  /** Material response at a hit point on entity t. (dx, dz) points back toward the attacker. */
  hitSparks(t: Entity, x: number, y: number, z: number, dx: number, dz: number, k: number, uv: boolean): void {
    const def = t.def;
    const mat: HitMaterial = def.kind === 'resource' ? 'dust'
      : def.faction === 'pathogen' ? 'goo'
        : def.kind === 'building' ? 'building'
          : t.tags.has('mech') ? 'metal' : 'staff';
    this.hitSparksOf(mat, t.owner, x, y, z, dx, dz, k, uv);
  }

  hitSparksOf(mat: HitMaterial, owner: number, x: number, y: number, z: number, dx: number, dz: number, k: number, uv: boolean): void {
    const c = this.c, P = c.particles;
    const g = c.heightAt(x, z);
    if (mat === 'dust') {
      P.begin(SPR.SMOKE).at(x, y, z).jitter(0.1).sphere(0.3, 0.8).life(0.4, 0.7).size(0.2, 0.3, 2).color(0.55, 0.5, 0.42, 0.4).fade(0.1).emit(2 * k);
      return;
    }
    if (mat === 'goo') {
      c.playerColor(owner, col);
      P.begin(SPR.GOO).at(x, y, z).jitter(0.06).cone(dx, 0.9, dz, 1.1, 1, 2.6).gravity(-10).floor(g + 0.02).life(0.3, 0.5).size(0.06, 0.11, 0.7)
        .color(col.r * 1.5, col.g * 1.5, col.b * 1.5, 1).endAlpha(0.5).alt(0.45, 1.3, 0.09, 0.4).additive(0.15).emit(4 * k);
      P.begin(SPR.GLOW).at(x, y, z).life(0.1).size(0.4, 0.4, 1.3).color(col.r * 1.8, col.g * 1.8 + 0.3, col.b * 1.8, 0.6).additive(1).emitExact(1);
      if (uv) {
        P.begin(SPR.SPARK).at(x, y, z).jitter(0.15).up(0.4, 1).life(0.25, 0.45).size(0.05, 0.08, 0.3).color(1.1, 0.5, 2.4, 1).additive(1).emit(3);
      }
      return;
    }
    if (mat === 'metal' || mat === 'building') {
      P.begin(SPR.SPARK, PM_STRETCH).at(x, y, z).cone(dx, 0.6, dz, 1.2, 2.5, 6).gravity(-11).drag(1).floor(g + 0.02).life(0.15, 0.35)
        .size(0.035, 0.06, 0.4).color(3.0, 1.9, 0.75, 1).stretch(0.03).additive(1).emit(5 * k);
      P.begin(SPR.GLOW).at(x, y, z).life(0.08).size(0.38, 0.38, 1.2).color(2.4, 1.4, 0.5, 0.75).additive(1).emitExact(1);
      if (mat === 'building') {
        P.begin(SPR.DEBRIS).at(x, y, z).cone(dx, 0.8, dz, 0.9, 1, 2.5).gravity(-14).floor(g + 0.03).life(0.4, 0.7).size(0.05, 0.09)
          .color(0.7, 0.7, 0.68, 1).spin(10).fade(0, 3).emit(2 * k);
      }
      return;
    }
    // hospital staff: hazmat suit flash (no blood)
    P.begin(SPR.SPARKLE).at(x, y, z).jitter(0.08).life(0.12, 0.18).size(0.22, 0.3, 0.6).color(1.8, 2.0, 2.0, 0.9).additive(1).emit(1 + k);
    P.begin(SPR.DROPLET).at(x, y, z).cone(dx, 0.7, dz, 1, 0.8, 1.8).gravity(-8).life(0.2, 0.35).size(0.03, 0.05).color(1.5, 1.7, 1.7, 0.8).additive(0.6).emit(2 * k);
  }

  onHealed = (ev: GameEvents['entityHealed']): void => {
    const c = this.c, t = ev.entity, src = ev.source;
    if (!c.entityVisible(t) || !c.fogVisible(t.pos.x, t.pos.y)) return;
    c.stampEvent();
    const time = c.world.time;
    const isRepair = !!src && (!!src.gatherer || src.tags.has('worker')) && !src.tags.has('healer');
    if (isRepair && src) {
      const last = this.lastRepair.get(t.id) ?? -1;
      if (time - last < 0.22) return;
      this.lastRepair.set(t.id, time);
      const p = c.hitPoint(t, src.pos.x, src.pos.y, tmpA);
      if (!c.onScreen(p.x, p.y, p.z, 1)) return;
      this.repairSparks(p.x, p.y, p.z, src.pos.x - p.x, src.pos.y - p.z);
      if (c.rng.next() < 0.6) this.weapons.spawnArc(src, t, 0.8, 1.2, 2.6, 0.12);
      return;
    }
    if (src && src !== t) this.refreshBeam(src, t);
    const last = this.lastPlus.get(t.id) ?? -1;
    if (time - last < 0.38) return;
    this.lastPlus.set(t.id, time);
    const p = c.entityBase(t, tmpA);
    const h = c.modelHeight(t);
    if (!c.onScreen(p.x, p.y + h, p.z, 1)) return;
    this.healPlus(p.x, p.y + h * 0.75, p.z, t.radius);
  };

  healPlus(x: number, y: number, z: number, r: number): void {
    const P = this.c.particles;
    P.begin(SPR.PLUS).at(x, y, z).jitter(Math.max(0.15, r * 0.6)).up(0.7, 1.15).drag(0.6).life(0.85, 1.15).size(0.26, 0.34, 0.8).rot(0)
      .color(0.7, 2.3, 1.95, 1).fade(0.15, 1.6).additive(0.85).emit(1.6);
    P.begin(SPR.SPARKLE).at(x, y, z).jitter(Math.max(0.2, r * 0.7)).up(0.3, 0.8).drag(0.8).life(0.4, 0.7).size(0.1, 0.15, 0.4)
      .color(0.9, 2.4, 2.1, 1).additive(1).emit(2);
  }

  repairSparks(x: number, y: number, z: number, dx: number, dz: number): void {
    const c = this.c, P = c.particles;
    const g = c.heightAt(x, z);
    P.begin(SPR.SPARK, PM_STRETCH).at(x, y, z).cone(dx, 0.8, dz, 1.3, 1.5, 3.8).gravity(-12).floor(g + 0.02).life(0.2, 0.45)
      .size(0.03, 0.05, 0.4).color(3.0, 2.2, 1.1, 1).stretch(0.03).additive(1).emit(6);
    P.begin(SPR.FLARE).at(x, y, z).life(0.08).size(0.5, 0.5, 1.2, 0.5).color(1.8, 2.3, 3.2, 1).additive(1).emitExact(1);
  }

  private refreshBeam(src: Entity, tgt: Entity): void {
    const c = this.c;
    for (const b of this.beams) if (b.src === src) { b.tgt = tgt; b.until = c.now + 0.7; return; }
    if (this.beams.length >= 64) return;
    const b = this.freeBeams.pop() ?? new HealBeam();
    b.src = src; b.tgt = tgt; b.t0 = c.now; b.until = c.now + 0.7; b.seed = c.rng.next() * 100; b.acc = 0;
    this.beams.push(b);
  }

  onConstructionStarted = (ev: GameEvents['constructionStarted']): void => {
    const c = this.c, b = ev.building;
    c.stampEvent();
    const fp = (b.def as BuildingDef).footprint;
    const x = b.pos.x, z = b.pos.y, g = c.heightAt(x, z);
    if (!c.canSee(x, g, z, Math.max(fp.w, fp.h))) return;
    const P = c.particles;
    const s = Math.max(fp.w, fp.h);
    const hosp = (b.def as BuildingDef).faction === 'hospital';
    P.begin(SPR.SMOKE).at(x, g + 0.2, z).disc(s * 0.5, s * 0.3).radial(0.5, 1.4).up(0.1, 0.5).drag(2).life(0.7, 1.2).size(0.45, 0.7, 2.2)
      .color(hosp ? 0.55 : 0.32, hosp ? 0.53 : 0.4, hosp ? 0.5 : 0.18, 0.45).fade(0.1).spin(0.6).emit(8 * Math.sqrt(s));
    c.playerColor(b.owner, col);
    P.begin(SPR.RING, PM_GROUND).at(x, g + 0.08, z).life(0.6).size(s * 1.5, s * 1.5, 0.8, 0.6).rot(0).color(col.r * 1.6, col.g * 1.6, col.b * 1.6, 0.9).additive(1).emitExact(1);
  };

  onConstructionComplete = (ev: GameEvents['constructionComplete']): void => {
    const c = this.c, b = ev.building;
    c.stampEvent();
    const fp = (b.def as BuildingDef).footprint;
    const x = b.pos.x, z = b.pos.y, g = c.heightAt(x, z);
    const h = c.modelHeight(b);
    if (!c.canSee(x, g + h * 0.5, z, Math.max(fp.w, fp.h))) return;
    this.completeFlash(b.owner, x, g, z, Math.max(fp.w, fp.h), h, (b.def as BuildingDef).faction === 'hospital');
  };

  completeFlash(owner: number, x: number, g: number, z: number, s: number, h: number, hospital: boolean): void {
    const P = this.c.particles;
    this.c.playerColor(owner, col);
    const r = col.r * 1.8 + 0.15, gg = col.g * 1.8 + 0.15, b = col.b * 1.8 + 0.15;
    P.begin(SPR.GLOW).at(x, g + h * 0.6, z).life(0.4).size(s * 1.4, s * 1.4, 1.2).color(r, gg, b, 0.55).additive(1).emitExact(1);
    P.begin(SPR.RING, PM_GROUND).at(x, g + 0.08, z).life(0.7).size(s * 0.8, s * 0.8, 2.4, 0.45).color(r, gg, b, 0.95).additive(1).emitExact(1);
    P.begin(SPR.RING, PM_GROUND).at(x, g + 0.1, z).vel(0, h * 1.6, 0).life(0.6).size(s * 1.2, s * 1.2, 1).color(r, gg, b, 0.75).fade(0.1, 1.4).additive(1).emitExact(1);
    P.begin(hospital ? SPR.SPARKLE : SPR.GLOW).at(x, g + h * 0.5, z).box(s * 0.45, h * 0.45, s * 0.45).up(0.8, 2).drag(0.8).life(0.6, 1.2).size(0.14, 0.22, 0.4)
      .color(r, gg, b, 1).wobble(hospital ? 0 : 0.15, 2.5).additive(1).emit(18 * Math.sqrt(s / 2));
  }

  onProductionComplete = (ev: GameEvents['productionComplete']): void => {
    const c = this.c, u = ev.unit;
    c.stampEvent();
    const p = c.entityBase(u, tmpA);
    if (!c.canSee(p.x, p.y, p.z, 1.5) || !c.entityVisible(u)) return;
    const P = c.particles;
    c.playerColor(u.owner, col);
    const r = col.r * 1.8 + 0.2, g = col.g * 1.8 + 0.2, b = col.b * 1.8 + 0.2;
    const s = Math.max(0.8, u.radius * 2);
    const h = c.modelHeight(u);
    P.begin(SPR.RING, PM_GROUND).at(p.x, p.y + 0.06, p.z).life(0.5).size(0.4 * s, 0.4 * s, 4, 0.45).color(r, g, b, 0.95).additive(1).emitExact(1);
    P.begin(SPR.GLOW).at(p.x, p.y + h * 0.5, p.z).life(0.3).size(1.4 * s, 1.4 * s, 1.1).color(r, g, b, 0.6).additive(1).emitExact(1);
    if ((u.def.kind === 'unit' && u.def.faction === 'pathogen')) {
      P.begin(SPR.GOO).at(p.x, p.y + h * 0.3, p.z).jitter(0.2).hemi(1, 2.2).up(0.5, 1.5).gravity(-9).floor(p.y + 0.02).life(0.4, 0.7).size(0.07, 0.12, 0.7)
        .color(r * 0.8, g * 0.8, b * 0.8, 1).endAlpha(0.5).alt(0.45, 1.3, 0.09, 0.4).additive(0.15).emit(8);
    } else {
      P.begin(SPR.SPARKLE).at(p.x, p.y + h * 0.5, p.z).box(0.35 * s, h * 0.5, 0.35 * s).up(0.6, 1.6).drag(0.8).life(0.5, 0.9).size(0.12, 0.18, 0.4)
        .color(r, g, b, 1).additive(1).emit(8);
    }
  };

  onDelivered = (ev: GameEvents['resourceDelivered']): void => {
    const c = this.c, w = ev.worker;
    c.stampEvent();
    const p = c.entityBase(w, tmpA);
    const h = c.modelHeight(w);
    if (!c.canSee(p.x, p.y + h, p.z, 1) || !c.entityVisible(w)) return;
    const hosp = w.def.kind === 'unit' && w.def.faction === 'hospital';
    const P = c.particles;
    P.begin(SPR.PLUS).at(p.x, p.y + h + 0.25, p.z).vel(0, 0.9, 0).drag(0.8).life(0.75).size(0.3, 0.3, 0.8).rot(0)
      .color(hosp ? 0.8 : 0.9, hosp ? 2.2 : 2.0, hosp ? 1.9 : 0.25, 1).fade(0.1, 1.5).additive(0.85).emitExact(1);
    P.begin(SPR.SPARKLE).at(p.x, p.y + h + 0.2, p.z).jitter(0.25).up(0.3, 0.7).life(0.35, 0.55).size(0.1, 0.14)
      .color(hosp ? 1.2 : 1.0, hosp ? 2.2 : 2.0, hosp ? 2.0 : 0.3, 1).additive(1).emit(3);
  };

  onEntityRemoved(e: Entity): void {
    this.lastHit.delete(e.id); this.lastPlus.delete(e.id); this.lastRepair.delete(e.id);
    const t = this.tracked.get(e.id);
    if (t) this.untrack(t);
    for (const b of this.beams) { if (b.src === e || b.tgt === e) b.until = 0; }
  }

  // ───────────────────────── per frame ─────────────────────────
  update(): void {
    const c = this.c;
    c.stampFrame();
    if (c.now >= this.pollAt) { this.pollAt = c.now + 0.25; this.poll(); }
    for (let i = this.list.length - 1; i >= 0; i--) this.emitTracked(this.list[i]!);
    this.updateBeams();
  }

  private poll(): void {
    const c = this.c, w = c.world;
    const stamp = ++this.stamp;
    for (const e of w.list) {
      if (!e.alive || e.kind === 'resource') continue;
      const def = e.def;
      if (def.kind === 'resource') continue;
      let mode = M_NONE;
      const f = e.hp / Math.max(1, e.stats.maxHp);
      if (e.kind === 'building') {
        if (e.construction) {
          const prev = this.tracked.get(e.id)?.lastProgress ?? -1;
          const progressing = prev < 0 || e.construction.progress > prev + 1e-4;
          if (progressing) mode = def.faction === 'pathogen' ? M_BUILD_P : M_BUILD_H;
          else { const t = this.tracked.get(e.id); if (t) t.lastProgress = e.construction.progress; }
        } else if (def.faction === 'pathogen') {
          if (f < 0.3) mode = M_OOZE2; else if (f < 0.6) mode = M_OOZE;
        } else if (f < 0.25) mode = M_FIRE;
        else if (f < 0.5 && c.q.lightDamageSmoke) mode = M_SMOKE;
      } else if (def.faction === 'hospital' && e.tags.has('mech') && f < 0.3) {
        mode = M_UNIT_SMOKE;
      }
      if (mode === M_NONE) continue;
      let t = this.tracked.get(e.id);
      if (!t) t = this.track(e);
      t.mode = mode;
      t.stamp = stamp;
      if (e.construction) t.lastProgress = e.construction.progress;
      t.visible = c.fogVisible(e.pos.x, e.pos.y) && c.entityVisible(e);
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i]!;
      if (t.stamp !== stamp) {
        // keep a stalled foundation's progress memory so a resumed build is detected next poll
        if (t.e.alive && t.e.construction) { t.mode = M_NONE; t.stamp = stamp; continue; }
        this.untrack(t);
      }
    }
  }

  private track(e: Entity): Tracked {
    const t = this.freeTracked.pop() ?? new Tracked();
    t.e = e; t.mode = M_NONE; t.stamp = 0; t.lastProgress = -1; t.acc.fill(0); t.next = 0;
    t.building = e.kind === 'building';
    if (t.building) {
      const fp = (e.def as BuildingDef).footprint;
      t.w = fp.w; t.d = fp.h;
    } else { t.w = t.d = e.radius * 2; }
    t.h = this.c.modelHeight(e);
    // deterministic emit points on the roof/body from the entity id
    let s = (e.id * 2654435761) >>> 0;
    const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0; return s / 4294967296; };
    t.nPts = t.building ? (Math.max(t.w, t.d) >= 4 ? 3 : Math.max(t.w, t.d) >= 3 ? 2 : 1) : 1;
    for (let i = 0; i < 3; i++) {
      t.pts[i * 3] = (rnd() - 0.5) * t.w * 0.6;
      t.pts[i * 3 + 1] = 0.65 + rnd() * 0.3;
      t.pts[i * 3 + 2] = (rnd() - 0.5) * t.d * 0.6;
    }
    this.tracked.set(e.id, t);
    this.list.push(t);
    return t;
  }

  private untrack(t: Tracked): void {
    this.tracked.delete(t.e.id);
    const i = this.list.indexOf(t);
    if (i >= 0) { const last = this.list.pop()!; if (i < this.list.length) this.list[i] = last; }
    this.freeTracked.push(t);
  }

  /** Accumulated per-emitter rate → integer count for this frame. */
  private rate(t: Tracked, slot: number, perSec: number): number {
    const v = t.acc[slot]! + perSec * this.c.fdt * this.c.particles.mul;
    const n = Math.floor(v);
    t.acc[slot] = v - n;
    return n;
  }

  private emitTracked(t: Tracked): void {
    const c = this.c;
    if (t.mode === M_NONE || !t.visible) return;
    const e = t.e;
    const base = c.entityBase(e, tmpA);
    t.h = c.modelHeight(e);
    if (!c.onScreen(base.x, base.y + t.h * 0.5, base.z, Math.max(t.w, t.d) + 2)) return;
    const P = c.particles;
    switch (t.mode) {
      case M_SMOKE: case M_FIRE: {
        const fire = t.mode === M_FIRE;
        for (let i = 0; i < t.nPts; i++) {
          const x = base.x + t.pts[i * 3]!, y = base.y + t.h * t.pts[i * 3 + 1]!, z = base.z + t.pts[i * 3 + 2]!;
          const slot = Math.min(1, i);
          let n = this.rate(t, slot, fire ? 3.2 : 2.0);
          if (n > 0) {
            if (fire) P.begin(SPR.SMOKE).at(x, y + 0.3, z).jitter(0.25).up(1.2, 2.2).drag(0.6).life(2.2, 3.4).size(0.55, 0.75, 3.2, 0.7)
              .color(0.065, 0.065, 0.075, 0.58).fade(0.12, 1.2).spin(0.6).wobble(0.15, 1.1).emitExact(n);
            else P.begin(i % 2 ? SPR.SMOKE2 : SPR.SMOKE).at(x, y + 0.1, z).jitter(0.2).up(0.9, 1.7).drag(0.6).life(2, 3).size(0.5, 0.7, 3.6, 0.7)
              .color(0.2, 0.2, 0.21, 0.6).fade(0.12, 1.2).spin(0.5).wobble(0.12, 1).emitExact(n);
          }
          if (fire) {
            // steady flickering fire glow (one billboard per point — cheap, reads at RTS distance)
            const fl = 0.8 + 0.2 * Math.sin(c.now * 23 + i * 2.1) * Math.sin(c.now * 7.3 + i);
            c.sprites.add(x, y + 0.25, z, 1.5 * fl, SPR.GLOW, 2.6, 1.0, 0.25, 0.75);
            n = this.rate(t, 2, 14);
            if (n > 0) P.begin(SPR.GLOW).at(x, y, z).jitter(0.25).up(0.9, 1.7).gravity(1.2).drag(1).life(0.4, 0.65).size(0.6, 0.8, 0.3)
              .color(3.2, 1.35, 0.32, 1).end(0.9, 0.18, 0.02, 0).fade(0.15).additive(1).emitExact(n);
            n = this.rate(t, 3, 3);
            if (n > 0) P.begin(SPR.SPARK, PM_STRETCH).at(x, y + 0.2, z).jitter(0.25).up(1.4, 3).sphere(0.2, 0.6).drag(0.5).life(0.8, 1.4)
              .size(0.03, 0.04, 0.5).color(3.2, 1.6, 0.4, 1).wobble(0.2, 4).stretch(0.04).additive(1).emitExact(n);
          }
        }
        if (!fire && c.now >= t.next) {
          // the occasional electrical spark from a damaged machine
          t.next = c.now + 0.9 + c.rng.next() * 1.6;
          const i = c.rng.int(t.nPts);
          this.repairSparks(base.x + t.pts[i * 3]!, base.y + t.h * t.pts[i * 3 + 1]!, base.z + t.pts[i * 3 + 2]!, 0, 0);
        }
        break;
      }
      case M_OOZE: case M_OOZE2: {
        const heavy = t.mode === M_OOZE2;
        c.playerColor(e.owner, col);
        const r = col.r * 1.4, g = col.g * 1.4, b = col.b * 1.4;
        let n = this.rate(t, 0, heavy ? 10 : 5);
        if (n > 0) {
          const ang = c.rng.next() * Math.PI * 2;
          const x = base.x + Math.cos(ang) * t.w * 0.42, z = base.z + Math.sin(ang) * t.d * 0.42;
          P.begin(SPR.GOO).at(x, base.y + t.h * (0.35 + c.rng.next() * 0.4), z).jitter(0.12).vel(Math.cos(ang) * 0.4, 0, Math.sin(ang) * 0.4)
            .gravity(-5).floor(base.y + 0.03).drag(1.5).life(0.8, 1.2).size(0.08, 0.13, 0.75).color(r, g, b, 1).endAlpha(0.4)
            .alt(0.42, 1.25, 0.09, 0.45).fade(0.1, 2).additive(0.15).emitExact(n);
        }
        n = this.rate(t, 1, heavy ? 8 : 4);
        if (n > 0) P.begin(SPR.GLOW).at(base.x, base.y + t.h * 0.5, base.z).box(t.w * 0.35, t.h * 0.35, t.d * 0.35).up(0.4, 1.1).drag(1)
          .life(0.7, 1.2).size(0.08, 0.13, 0.5).color(0.55, 1.8, 0.2, 0.9).wobble(0.12, 3).additive(1).emitExact(n);
        if (heavy && c.now >= t.next) {
          t.next = c.now + 0.5 + c.rng.next() * 0.7;
          const i = c.rng.int(t.nPts);
          const x = base.x + t.pts[i * 3]!, y = base.y + t.h * t.pts[i * 3 + 1]!, z = base.z + t.pts[i * 3 + 2]!;
          P.begin(SPR.GOO).at(x, y, z).jitter(0.1).hemi(0.8, 1.8).up(1.5, 3).gravity(-11).floor(base.y + 0.03).life(0.5, 0.8).size(0.08, 0.14, 0.7)
            .color(r, g, b, 1).endAlpha(0.5).alt(0.42, 1.25, 0.09, 0.4).additive(0.15).emit(6);
          P.begin(SPR.SMOKE).at(x, y, z).sphere(0.2, 0.5).up(0.3, 0.7).drag(1.5).life(0.8, 1.2).size(0.3, 0.45, 2.2).color(col.r * 0.3, col.g * 0.25 + 0.05, col.b * 0.3, 0.4).fade(0.1).emit(2);
        }
        break;
      }
      case M_BUILD_H: {
        const prog = e.construction ? e.construction.progress / Math.max(0.01, e.construction.total) : 1;
        if (c.now >= t.next) {
          t.next = c.now + 0.22 + c.rng.next() * 0.4;
          // weld point on the rising structure's outline
          const side = c.rng.int(4), u = c.rng.next() - 0.5;
          const hx = side < 2 ? u * t.w : (side === 2 ? -0.5 : 0.5) * t.w;
          const hz = side < 2 ? (side === 0 ? -0.5 : 0.5) * t.d : u * t.d;
          const x = base.x + hx * 0.92, z = base.z + hz * 0.92;
          const y = base.y + Math.max(0.25, t.h * (0.15 + 0.85 * prog) * (0.35 + 0.65 * c.rng.next()));
          P.begin(SPR.SPARK, PM_STRETCH).at(x, y, z).hemi(1.4, 3.8).gravity(-12).floor(base.y + 0.02).life(0.3, 0.6).size(0.03, 0.05, 0.4)
            .color(3.0, 2.2, 1.2, 1).stretch(0.03).additive(1).emit(8);
          P.begin(SPR.FLARE).at(x, y, z).life(0.09).size(0.55, 0.55, 1.2, 0.5).color(1.8, 2.3, 3.2, 1).additive(1).emitExact(1);
        }
        const n = this.rate(t, 0, 1.6);
        if (n > 0) P.begin(SPR.SMOKE).at(base.x, base.y + 0.2, base.z).box(t.w * 0.5, 0.05, t.d * 0.5).up(0.2, 0.6).drag(1.5).life(1, 1.6).size(0.35, 0.5, 2.2)
          .color(0.55, 0.53, 0.5, 0.32).fade(0.15).spin(0.5).emitExact(n);
        break;
      }
      case M_BUILD_P: {
        c.playerColor(e.owner, col);
        let n = this.rate(t, 0, 7);
        if (n > 0) P.begin(SPR.GLOW).at(base.x, base.y + 0.3, base.z).box(t.w * 0.42, 0.2, t.d * 0.42).up(0.5, 1.2).drag(0.8).life(0.8, 1.3)
          .size(0.09, 0.15, 0.5).color(0.5, 1.7, 0.2, 0.9).alt(col.r * 1.6, col.g * 1.6, col.b * 1.6, 0.35).wobble(0.12, 3).additive(1).emitExact(n);
        n = this.rate(t, 1, 1.2);
        if (n > 0) P.begin(SPR.SMOKE2).at(base.x, base.y + 0.25, base.z).box(t.w * 0.4, 0.05, t.d * 0.4).up(0.15, 0.45).drag(1.5).life(1.2, 1.8)
          .size(0.45, 0.6, 2).color(0.22, 0.32, 0.1, 0.35).fade(0.15).spin(0.4).emitExact(n);
        if (c.now >= t.next) {
          t.next = c.now + 0.45 + c.rng.next() * 0.6;
          const x = base.x + (c.rng.next() - 0.5) * t.w * 0.8, z = base.z + (c.rng.next() - 0.5) * t.d * 0.8;
          P.begin(SPR.RING).at(x, base.y + 0.25, z).life(0.2).size(0.25, 0.25, 2.2, 0.5).color(0.6, 1.8, 0.25, 0.8).additive(1).emitExact(1);
          P.begin(SPR.GOO).at(x, base.y + 0.25, z).hemi(0.8, 1.8).up(0.5, 1).gravity(-9).floor(base.y + 0.02).life(0.35, 0.55).size(0.05, 0.08)
            .color(0.45, 1.3, 0.1, 1).endAlpha(0.4).additive(0.2).emit(5);
        }
        break;
      }
      case M_UNIT_SMOKE: {
        const n = this.rate(t, 0, 4);
        if (n > 0) P.begin(SPR.SMOKE).at(base.x, base.y + t.h * 0.85, base.z).jitter(0.12).up(0.6, 1.1).drag(0.8).life(0.8, 1.4).size(0.2, 0.28, 3)
          .color(0.1, 0.1, 0.11, 0.45).fade(0.15).spin(0.8).emitExact(n);
        if (c.now >= t.next) {
          t.next = c.now + 0.6 + c.rng.next() * 1.4;
          this.repairSparks(base.x, base.y + t.h * 0.7, base.z, 0, 0);
        }
        break;
      }
      default: break;
    }
  }

  private updateBeams(): void {
    const c = this.c, P = c.particles;
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i]!;
      if (c.now >= b.until || !b.src || !b.tgt || !b.src.alive || !b.tgt.alive) {
        b.src = b.tgt = null;
        const last = this.beams.pop()!;
        if (i < this.beams.length) this.beams[i] = last;
        this.freeBeams.push(b);
        continue;
      }
      const a = c.muzzle(b.src, tmpA);
      const e = c.entityCenter(b.tgt, tmpB);
      if (!c.fogVisible(a.x, a.z) && !c.fogVisible(e.x, e.z)) continue;
      const mx = (a.x + e.x) / 2, my = (a.y + e.y) / 2, mz = (a.z + e.z) / 2;
      if (!c.onScreen(mx, my, mz, a.distanceTo(e) * 0.5 + 1)) continue;
      const fadeIn = Math.min(1, (c.now - b.t0) / 0.12), fadeOut = Math.min(1, (b.until - c.now) / 0.15);
      const env = fadeIn * fadeOut;
      const pulse = 0.8 + 0.2 * Math.sin(c.now * 11 + b.seed);
      if (c.strips.start(0.25, 1.35, 1.15, 0.85 * env, 0.6, 0.35, b.seed)) {
        for (let k = 0; k <= 6; k++) {
          const t = k / 6;
          c.strips.point(a.x + (e.x - a.x) * t, a.y + (e.y - a.y) * t + Math.sin(t * Math.PI) * 0.18, a.z + (e.z - a.z) * t, 0.1 * pulse, 1);
        }
        c.strips.end();
      }
      c.sprites.add(a.x, a.y, a.z, 0.32 * env, SPR.GLOW, 0.4, 1.8, 1.5, 0.8);
      c.sprites.add(e.x, e.y, e.z, 0.62 * env * pulse, SPR.GLOW, 0.3, 1.5, 1.25, 0.6);
      // motes flowing from the medic to the patient
      b.acc += 12 * c.fdt * P.mul;
      const n = Math.floor(b.acc); b.acc -= n;
      if (n > 0) {
        const T = 0.32;
        P.begin(SPR.GLOW).at(a.x, a.y, a.z).vel((e.x - a.x) / T, (e.y - a.y) / T + 0.25, (e.z - a.z) / T).life(T).size(0.1, 0.13, 0.6)
          .color(0.6, 2.2, 1.9, 1).additive(1).emitExact(n);
      }
    }
  }

  dispose(): void {
    this.tracked.clear(); this.list.length = 0; this.beams.length = 0;
    this.lastHit.clear(); this.lastPlus.clear(); this.lastRepair.clear();
  }
}
