/**
 * [vfx] Death effects (entityDied), scaled by size:
 *  - pathogen units: goo splat burst + membrane pop + drifting motes + ground splat (massive = shockwave,
 *    chunks and secondary pops; air units rain goo down to a delayed splat);
 *  - hospital machines: explosion flash, fireball, sparks, smoke, debris, scorch (drones fall and crash);
 *  - hospital staff (bio): a tasteful teal "evac" shimmer — light column, rising rings, a "+" (no gore);
 *  - buildings: hospital = collapse dust + debris + staggered explosions + smoke column + scorch;
 *    pathogen = gooey eruption + toxic cloud + popping sacs + large goo stain.
 */
import * as THREE from 'three';
import type { BuildingDef, Entity } from '../../core/types';
import { SPR } from './atlas';
import type { VfxCore } from './core';
import { PM_GROUND, PM_STRETCH } from './particles';

// timer kinds owned by this module
export const T_GOO_POP = 10, T_EXPLOSION = 11, T_FIRE_BURST = 12, T_CRASH = 13;

const tmpA = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const col = new THREE.Color();

export class DeathFx {
  constructor(private readonly c: VfxCore) {
    c.registerTimer(T_GOO_POP, (x, y, z, s, aux) => this.gooPop(x, y, z, s, aux));
    c.registerTimer(T_EXPLOSION, (x, y, z, s) => this.explosion(x, y, z, s, true));
    c.registerTimer(T_FIRE_BURST, (x, y, z, s) => this.fireBurst(x, y, z, s));
    c.registerTimer(T_CRASH, (x, y, z, s) => { this.explosion(x, y, z, s, true); this.scorch(x, z, s * 1.3); });
  }

  onDied(e: Entity): void {
    const c = this.c;
    c.stampEvent();
    const base = c.entityBase(e, tmpA);
    const x = base.x, y = base.y, z = base.z;
    if (!c.fogVisible(x, z) && e.owner !== c.local) return;
    const def = e.def;
    if (def.kind === 'building') {
      const fp = (def as BuildingDef).footprint;
      const prog = e.construction ? Math.max(0.25, e.construction.progress / Math.max(0.01, e.construction.total)) : 1;
      if (!c.onScreen(x, y, z, Math.max(fp.w, fp.h) + 2)) { this.decalOnly(e, x, z, fp.w, fp.h); return; }
      if (def.faction === 'pathogen') this.gooEruption(e.owner, x, y, z, fp.w, fp.h, c.modelHeight(e) * prog);
      else this.collapse(e.owner, x, y, z, fp.w, fp.h, c.modelHeight(e) * prog);
      return;
    }
    if (def.kind === 'resource') {
      if (c.onScreen(x, y, z, 2)) this.dust(x, c.heightAt(x, z), z, 1);
      return;
    }
    const h = c.modelHeight(e);
    const s = Math.max(0.6, e.radius / 0.42);
    const cy = y + h * 0.45;
    const flying = !!e.mover?.flying;
    if (!c.onScreen(x, cy, z, s * 2 + 1)) { if (def.faction === 'pathogen' || e.tags.has('mech')) this.decalOnly(e, x, z, 0, 0); return; }
    if (def.faction === 'pathogen') this.gooDeath(e, x, cy, z, s, e.tags.has('massive'), flying);
    else if (e.tags.has('mech')) this.machineDeath(e, x, cy, z, s, flying);
    else this.evac(e, x, y, z, h, s);
  }

  /** Off-screen but visible deaths still leave their mark on the ground. */
  private decalOnly(e: Entity, x: number, z: number, w: number, h: number): void {
    const def = e.def;
    if (def.kind === 'resource') return;
    const size = w > 0 ? Math.max(w, h) * 1.5 : Math.max(0.6, e.radius / 0.42) * 1.2;
    if (def.faction === 'pathogen') this.splat(e.owner, x, z, size);
    else this.scorch(x, z, size * 0.9);
  }

  // ───────────────────────── pathogen units ─────────────────────────
  gooDeath(e: Entity | null, x: number, y: number, z: number, s: number, massive: boolean, flying: boolean, owner = e?.owner ?? 2): void {
    const c = this.c, P = c.particles;
    const g = c.heightAt(x, z);
    c.playerColor(owner, col);
    const r = col.r * 1.5, gg = col.g * 1.5, b = col.b * 1.5;
    const rs = Math.sqrt(s);
    P.begin(SPR.GLOW).at(x, y, z).life(0.16).size(1.3 * s, 1.3 * s, 1.4).color(r * 1.2, gg * 1.2 + 0.3, b * 1.2, 0.85).additive(1).emitExact(1);
    P.begin(SPR.RING).at(x, y, z).life(0.24).size(0.45 * s, 0.45 * s, 3.4, 0.45).color(r * 1.4, gg * 1.4, b * 1.4, 0.9).additive(1).emitExact(1);
    // goo burst (alpha, glossy) — team colour with acid-green accents
    P.begin(SPR.GOO).at(x, y, z).jitter(0.2 * s).sphere(1.6 * rs, 4.2 * rs).up(1, 2.6).gravity(-12).floor(g + 0.03).drag(0.7)
      .life(0.55, 0.95).size(0.1 * rs, 0.2 * rs, 0.7).color(r, gg, b, 1).endAlpha(0.65).alt(0.42, 1.25, 0.09, 0.35).fade(0, 2.5).additive(0.15).spin(4)
      .emit(14 * s);
    // spatter droplets
    P.begin(SPR.DROPLET).at(x, y, z).jitter(0.1 * s).sphere(2.5 * rs, 5.5 * rs).up(0.5, 2).gravity(-11).floor(g + 0.02)
      .life(0.35, 0.6).size(0.05, 0.09).color(r, gg, b, 0.95).alt(0.5, 1.4, 0.1, 0.4).additive(0.3).emit(10 * s);
    // drifting glowing motes
    P.begin(SPR.GLOW).at(x, y, z).jitter(0.35 * s).sphere(0.2, 0.8).up(0.4, 1.1).drag(1.2).gravity(0.25).life(1.1, 2.1)
      .size(0.07, 0.12, 0.5).color(r * 1.6, gg * 1.6, b * 1.6, 0.9).alt(0.7, 2.0, 0.25, 0.45).wobble(0.22, 2.6).additive(1).emit(9 * s);
    // spore gas
    P.begin(SPR.SMOKE).at(x, y, z).jitter(0.25 * s).sphere(0.3, 1.0).up(0.2, 0.6).drag(1.6).life(0.8, 1.3).size(0.35 * s, 0.5 * s, 2.4, 0.6)
      .color(col.r * 0.35, col.g * 0.25 + 0.04, col.b * 0.35, 0.42).fade(0.1).spin(0.8).emit(5 * s);
    if (massive) {
      P.begin(SPR.SHOCK, PM_GROUND).at(x, g + 0.08, z).life(0.5).size(0.6, 0.6, (2.6 * s) / 0.6, 0.45).color(r, gg, b, 0.85).additive(0.6).emitExact(1);
      P.begin(SPR.GOO).at(x, y, z).jitter(0.3 * s).hemi(2, 5).up(3, 6).gravity(-14).floor(g + 0.04).life(0.9, 1.4).size(0.22, 0.38, 0.75)
        .color(r, gg, b, 1).endAlpha(0.6).alt(0.42, 1.25, 0.09, 0.4).fade(0, 3).spin(5).additive(0.1).emit(10 * rs);
      for (let i = 0; i < 3; i++) {
        const a = c.rng.next() * Math.PI * 2, d = s * (0.25 + c.rng.next() * 0.35);
        c.schedule(c.now + 0.12 + i * 0.14, T_GOO_POP, x + Math.cos(a) * d, y + (c.rng.next() - 0.3) * s * 0.4, z + Math.sin(a) * d, s * 0.45, owner);
      }
    }
    const splatDelay = flying ? Math.sqrt(Math.max(0.1, (y - g)) / 6) : 0;
    this.splat(owner, x, z, 1.25 * s, splatDelay);
  }

  /** Small secondary goo pop (massive deaths, building eruptions). aux = owner id. */
  private gooPop(x: number, y: number, z: number, s: number, owner: number): void {
    const c = this.c, P = c.particles;
    if (!c.canSee(x, y, z, 2)) return;
    c.playerColor(owner, col);
    const g = c.heightAt(x, z);
    P.begin(SPR.FLARE).at(x, y, z).life(0.12).size(1.1 * s, 1.1 * s, 1.3, 0.5).color(col.r * 2, col.g * 2 + 0.4, col.b * 2, 1).additive(1).emitExact(1);
    P.begin(SPR.GOO).at(x, y, z).jitter(0.15 * s).hemi(1.5, 3.5).up(1.5, 3).gravity(-12).floor(g + 0.03).life(0.5, 0.8).size(0.1, 0.2, 0.7)
      .color(col.r * 1.5, col.g * 1.5, col.b * 1.5, 1).endAlpha(0.6).alt(0.42, 1.25, 0.09, 0.4).fade(0, 2.5).additive(0.15).emit(8 * Math.max(1, s));
    P.begin(SPR.SMOKE).at(x, y, z).jitter(0.2).sphere(0.2, 0.6).drag(1.5).life(0.6, 1).size(0.4 * s, 0.6 * s, 2).color(0.22, 0.1, 0.22, 0.4).fade(0.1).emit(3);
  }

  splat(owner: number, x: number, z: number, size: number, delay = 0): void {
    const c = this.c;
    if (!c.fogVisible(x, z)) return;
    c.playerColor(owner, col);
    const g = c.heightAt(x, z);
    c.groundNormal(x, z, tmpN);
    c.decals.add(c.spawnTime + delay, x, g, z, tmpN.x, tmpN.y, tmpN.z, size, c.rng.next() * 6.28, SPR.SPLAT,
      col.r * 0.55 + 0.03, col.g * 0.5 + 0.05, col.b * 0.55, 0.78, c.q.decalLife, 0.28);
    // acid-green core stain
    c.decals.add(c.spawnTime + delay, x, g, z, tmpN.x, tmpN.y, tmpN.z, size * 0.5, c.rng.next() * 6.28, SPR.SPLAT,
      0.22, 0.6, 0.05, 0.55, c.q.decalLife * 0.7, 0.35);
  }

  scorch(x: number, z: number, size: number): void {
    const c = this.c;
    if (!c.fogVisible(x, z)) return;
    const g = c.heightAt(x, z);
    c.groundNormal(x, z, tmpN);
    c.decals.add(c.spawnTime, x, g, z, tmpN.x, tmpN.y, tmpN.z, size, c.rng.next() * 6.28, SPR.SCORCH, 0.13, 0.11, 0.1, 0.85, c.q.decalLife, 0, 0.7);
  }

  // ───────────────────────── hospital machines ─────────────────────────
  machineDeath(e: Entity | null, x: number, y: number, z: number, s: number, flying: boolean): void {
    const c = this.c, P = c.particles;
    const g = c.heightAt(x, z);
    this.explosion(x, y, z, s, false);
    // debris — hull panels (ivory) + team-coloured trim
    c.playerColor(e?.owner ?? c.local, col);
    P.begin(SPR.DEBRIS).at(x, y, z).jitter(0.2 * s).sphere(2, 5).up(2, 5).gravity(-15).floor(g + 0.04).drag(0.5).life(1.2, 2)
      .size(0.09 * Math.sqrt(s), 0.18 * Math.sqrt(s), 0.9).color(0.62, 0.64, 0.66, 1).alt(col.r, col.g, col.b, 0.3).fade(0, 4).spin(12).emit(9 * s);
    // lingering smoke
    P.begin(SPR.SMOKE).at(x, y, z).jitter(0.3 * s).up(0.7, 1.5).sphere(0.2, 0.5).drag(1.1).life(1.4, 2.4).size(0.45 * s, 0.6 * s, 3, 0.7)
      .color(0.09, 0.09, 0.1, 0.62).fade(0.1, 1.2).spin(0.8).wobble(0.1, 1.5).emit(8 * s);
    if (flying) {
      // the wreck falls and crashes
      const fall = Math.sqrt(Math.max(0.2, y - g) / 7);
      P.begin(SPR.SMOKE2).at(x, y, z).line(x, g + 0.3, z).sphere(0.1, 0.3).life(0.8, 1.3).size(0.3, 0.45, 2.4).color(0.1, 0.1, 0.11, 0.55).fade(0.1).spin(1).emit(8);
      c.schedule(c.now + fall, T_CRASH, x, g + 0.3, z, s * 0.8);
    } else {
      this.scorch(x, z, 1.5 * s);
    }
  }

  /** Fireball + flash + sparks. secondary=true for staggered building/crash blasts. */
  explosion(x: number, y: number, z: number, s: number, secondary: boolean): void {
    const c = this.c, P = c.particles;
    if (secondary && !c.canSee(x, y, z, 2 * s)) return;
    const g = c.heightAt(x, z);
    P.begin(SPR.FLARE).at(x, y, z).life(0.16).size(1.6 * s, 1.6 * s, 1.4, 0.5).color(3.4, 2.2, 1.1, 1).additive(1).emitExact(1);
    P.begin(SPR.GLOW).at(x, y, z).life(0.26).size(2.4 * s, 2.4 * s, 1.2).color(2.4, 1.0, 0.3, 0.8).additive(1).emitExact(1);
    P.begin(SPR.SMOKE).at(x, y, z).jitter(0.15 * s).sphere(0.6, 1.8).up(0.4, 1.1).drag(2.6).life(0.32, 0.55).size(0.38 * s, 0.5 * s, 2.3, 0.6)
      .color(3.2, 1.35, 0.35, 1).end(0.5, 0.1, 0.02, 0).additive(1).spin(2).emit(7 * s);
    P.begin(SPR.SPARK, PM_STRETCH).at(x, y, z).sphere(3, 8).up(1, 3).gravity(-12).drag(0.8).floor(g + 0.02).life(0.4, 0.9)
      .size(0.04, 0.065, 0.4).color(3.2, 2.0, 0.8, 1).stretch(0.035).additive(1).emit(16 * s);
    P.begin(SPR.SHOCK, PM_GROUND).at(x, g + 0.07, z).life(0.35).size(0.5, 0.5, (2.2 * s) / 0.5, 0.45).color(1.6, 0.9, 0.4, 0.7).additive(0.8).emitExact(1);
  }

  private fireBurst(x: number, y: number, z: number, s: number): void {
    const c = this.c, P = c.particles;
    if (!c.canSee(x, y, z, 2)) return;
    P.begin(SPR.GLOW).at(x, y, z).jitter(0.3 * s).up(0.8, 1.8).gravity(1).drag(1).life(0.35, 0.6).size(0.5 * s, 0.7 * s, 0.35)
      .color(3.0, 1.25, 0.3, 0.9).end(0.8, 0.15, 0.02, 0).fade(0.12).additive(1).emit(8);
    P.begin(SPR.SMOKE).at(x, y + 0.4, z).jitter(0.3 * s).up(1.2, 2.2).drag(0.7).life(1.8, 2.8).size(0.6 * s, 0.8 * s, 3, 0.7)
      .color(0.07, 0.07, 0.08, 0.55).fade(0.12).spin(0.6).wobble(0.12, 1.2).emit(4);
  }

  // ───────────────────────── hospital staff (no gore) ─────────────────────────
  evac(e: Entity | null, x: number, y: number, z: number, h: number, s: number): void {
    const c = this.c, P = c.particles;
    c.playerColor(e?.owner ?? c.local, col);
    const tr = col.r * 1.6 + 0.1, tg = col.g * 1.6 + 0.2, tb = col.b * 1.6 + 0.2;
    const r = 0.35 * s;
    P.begin(SPR.GLOW).at(x, y + h * 0.5, z).life(0.45).size(2.0 * s, 2.0 * s, 1.3).color(tr, tg, tb, 0.85).additive(1).emitExact(1);
    // light column: vertical streaks + twinkles rising out of the body
    P.begin(SPR.SPARK, PM_STRETCH).at(x, y + h * 0.45, z).box(r, h * 0.45, r).up(1.6, 3.6).drag(0.4).life(0.5, 0.95).size(0.07, 0.1, 0.4)
      .color(tr * 1.4, tg * 1.4, tb * 1.4, 1).stretch(0.12).additive(1).emit(24);
    P.begin(SPR.SPARKLE).at(x, y + h * 0.5, z).box(r * 1.2, h * 0.5, r * 1.2).up(0.6, 1.6).drag(0.6).life(0.6, 1.1).size(0.12, 0.2, 0.3)
      .color(tr * 1.4, tg * 1.4, tb * 1.4, 1).additive(1).emit(10);
    // holographic rings: one at the feet, two scanning up
    P.begin(SPR.RING, PM_GROUND).at(x, y + 0.06, z).life(0.55).size(0.6, 0.6, 3.4, 0.5).color(tr, tg, tb, 0.9).additive(1).emitExact(1);
    P.begin(SPR.RING, PM_GROUND).at(x, y + 0.1, z).vel(0, 2.4, 0).life(0.6).size(1.1 * s, 1.1 * s, 0.6).color(tr, tg, tb, 0.85).fade(0.1, 1.5).additive(1).emitExact(1);
    P.begin(SPR.RING, PM_GROUND).at(x, y + 0.1, z).vel(0, 1.5, 0).life(0.7).size(0.9 * s, 0.9 * s, 0.5).color(tr, tg, tb, 0.7).fade(0.25, 1.5).additive(1).emitExact(1);
    // the medical "+" rises and fades
    P.begin(SPR.PLUS).at(x, y + h + 0.2, z).vel(0, 0.9, 0).drag(0.6).life(1.1).size(0.55, 0.55, 0.85).rot(0).color(1.2, 2.2, 2.0, 1).fade(0.12, 1.6).additive(0.9).emitExact(1);
  }

  // ───────────────────────── buildings ─────────────────────────
  collapse(owner: number, x: number, y: number, z: number, w: number, d: number, h: number): void {
    const c = this.c, P = c.particles, rng = c.rng;
    const g = y;
    const size = Math.max(w, d), area = (w * d) / 9;
    const sc = Math.sqrt(area);
    this.explosion(x, g + h * 0.6, z, 0.8 + sc * 0.5, false);
    // rolling collapse dust (low, wide)
    P.begin(SPR.SMOKE).at(x, g + 0.4, z).disc(size * 0.5).radial(0.8, 2.6).up(0.2, 1.1).drag(1.5).life(1.6, 2.9).size(0.9, 1.3, 2.8, 0.6)
      .color(0.5, 0.48, 0.45, 0.6).alt(0.38, 0.36, 0.34, 0.4).fade(0.06, 1.2).spin(0.5).emit(18 * sc);
    // debris
    c.playerColor(owner, col);
    P.begin(SPR.DEBRIS).at(x, g + h * 0.5, z).box(w * 0.4, h * 0.4, d * 0.4).sphere(2, 6).up(3, 7).gravity(-16).floor(g + 0.04).drag(0.4).life(1.5, 2.6)
      .size(0.14, 0.3, 0.9).color(0.78, 0.76, 0.72, 1).alt(col.r, col.g, col.b, 0.22).fade(0, 4).spin(9).emit(22 * sc);
    // glass shards (cyan glints)
    P.begin(SPR.SPARK, PM_STRETCH).at(x, g + h * 0.6, z).box(w * 0.4, h * 0.3, d * 0.4).sphere(3, 7).up(1, 3).gravity(-14).floor(g + 0.02)
      .life(0.5, 1.0).size(0.04, 0.06, 0.4).color(1.4, 2.4, 2.8, 1).stretch(0.03).additive(1).emit(14 * sc);
    // black smoke column
    P.begin(SPR.SMOKE2).at(x, g + h * 0.7, z).box(w * 0.35, 0.3, d * 0.35).up(1.4, 2.8).drag(0.5).life(2.6, 4).size(0.9, 1.3, 3.2, 0.7)
      .color(0.07, 0.07, 0.08, 0.6).fade(0.1, 1.3).spin(0.4).wobble(0.2, 0.9).emit(8 * sc);
    // staggered secondary explosions + fires across the footprint
    const n = 3 + Math.round(sc * 2);
    for (let i = 0; i < n; i++) {
      const px = x + (rng.next() - 0.5) * w * 0.8, pz = z + (rng.next() - 0.5) * d * 0.8;
      c.schedule(c.now + 0.18 + i * (1.2 / n) + rng.next() * 0.1, T_EXPLOSION, px, g + h * (0.3 + rng.next() * 0.5), pz, 0.6 + sc * 0.25);
    }
    for (let i = 0; i < 6; i++) {
      const px = x + (rng.next() - 0.5) * w * 0.7, pz = z + (rng.next() - 0.5) * d * 0.7;
      c.schedule(c.now + 0.3 + i * 0.3, T_FIRE_BURST, px, g + 0.3, pz, 0.8 + sc * 0.3);
    }
    this.scorch(x, z, size * 1.45);
  }

  gooEruption(owner: number, x: number, y: number, z: number, w: number, d: number, h: number): void {
    const c = this.c, P = c.particles, rng = c.rng;
    const g = y;
    const size = Math.max(w, d), sc = Math.sqrt((w * d) / 9);
    c.playerColor(owner, col);
    const r = col.r * 1.5, gg = col.g * 1.5, b = col.b * 1.5;
    P.begin(SPR.GLOW).at(x, g + h * 0.5, z).life(0.28).size(size * 1.3, size * 1.3, 1.25).color(r, gg + 0.5, b, 0.8).additive(1).emitExact(1);
    P.begin(SPR.SHOCK, PM_GROUND).at(x, g + 0.08, z).life(0.55).size(1, 1, size * 1.9, 0.45).color(r, gg, b, 0.8).additive(0.6).emitExact(1);
    P.begin(SPR.GOO).at(x, g + h * 0.4, z).box(w * 0.35, h * 0.3, d * 0.35).hemi(1, 3).up(3, 8).gravity(-14).floor(g + 0.04).drag(0.4).life(1, 1.6)
      .size(0.18, 0.36, 0.7).color(r, gg, b, 1).endAlpha(0.55).alt(0.42, 1.25, 0.09, 0.4).fade(0, 3).spin(4).additive(0.15).emit(28 * sc);
    P.begin(SPR.DROPLET).at(x, g + h * 0.5, z).box(w * 0.3, h * 0.3, d * 0.3).sphere(2, 5).up(2, 4).gravity(-12).floor(g + 0.02).life(0.5, 0.9)
      .size(0.06, 0.1).color(r, gg, b, 0.95).alt(0.5, 1.4, 0.1, 0.45).additive(0.35).emit(20 * sc);
    P.begin(SPR.SMOKE).at(x, g + 0.5, z).disc(size * 0.4).radial(0.4, 1.4).up(0.3, 1).drag(1.4).life(1.5, 2.6).size(0.8, 1.2, 2.6, 0.6)
      .color(col.r * 0.3 + 0.04, col.g * 0.25 + 0.1, col.b * 0.3, 0.5).alt(0.12, 0.25, 0.05, 0.4).fade(0.08, 1.2).spin(0.6).emit(16 * sc);
    P.begin(SPR.SPARKLE).at(x, g + h * 0.5, z).box(w * 0.4, h * 0.4, d * 0.4).sphere(0.2, 0.8).up(0.5, 1.5).drag(1).gravity(0.3).life(1.2, 2.2)
      .size(0.12, 0.2, 0.4).color(0.7, 2.0, 0.25, 1).alt(r * 1.3, gg * 1.3, b * 1.3, 0.5).wobble(0.25, 2.2).additive(1).emit(26 * sc);
    const n = 3 + Math.round(sc * 2);
    for (let i = 0; i < n; i++) {
      const px = x + (rng.next() - 0.5) * w * 0.8, pz = z + (rng.next() - 0.5) * d * 0.8;
      c.schedule(c.now + 0.15 + i * (1.1 / n) + rng.next() * 0.1, T_GOO_POP, px, g + h * (0.2 + rng.next() * 0.5), pz, 0.7 + sc * 0.3, owner);
    }
    this.splat(owner, x, z, size * 1.55);
  }

  dust(x: number, g: number, z: number, s: number): void {
    this.c.particles.begin(SPR.SMOKE).at(x, g + 0.3, z).disc(0.6 * s).radial(0.5, 1.5).up(0.2, 0.8).drag(2).life(0.8, 1.3).size(0.4 * s, 0.6 * s, 2.4)
      .color(0.5, 0.47, 0.42, 0.5).fade(0.1).spin(0.6).emit(8 * s);
  }
}
