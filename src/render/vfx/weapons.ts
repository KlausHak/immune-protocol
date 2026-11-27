/**
 * [vfx] Weapon effects for every WeaponVfx key.
 *
 *  - weaponFired (projectile === null): instant weapons become short pooled "shots" whose endpoints
 *    track the shooter's muzzle and the target's surface every frame (beams, sprays, arcs, slashes,
 *    pseudopods). Projectile-type weapons fired without a sim projectile (e.g. the stub combat) get a
 *    purely visual local flight so they still read correctly.
 *  - world.projectiles: read every frame, interpolated prevPos→pos / prevT→t with alpha, height =
 *    ground lerp + lerp(startHeight, endHeight, t) + parabola for arcs; the launch point is pulled onto
 *    the model muzzle and blended back to the sim path over the flight. Each has a body (instanced mesh
 *    or sprite), optional ribbon trail and emitted particles (drips, spores, smoke).
 *  - projectileImpact: per-key impact (glassy pop + teal ring, sizzle, spore puff, ...).
 */
import * as THREE from 'three';
import type { Entity, GameEvents, Projectile, WeaponDef, WeaponVfx } from '../../core/types';
import { SPR } from './atlas';
import type { VfxCore } from './core';
import { PM_BILLBOARD, PM_GROUND, PM_STRETCH } from './particles';

// shot kinds (instant weapons)
const S_SPRAY = 1, S_UV = 2, S_ENGULF = 3, S_ZAP = 4, S_WHIP = 5, S_FLARE_LANCE = 6;

class Shot {
  kind = 0;
  src: Entity | null = null;
  tgt: Entity | null = null;
  t0 = 0; dur = 0.3; seed = 0; acc = 0; acc2 = 0; scale = 1; flag = 0;
  sx = 0; sy = 0; sz = 0; ex = 0; ey = 0; ez = 0;
  // colour override (zap/repair arcs)
  r = 0; g = 0; b = 0;
}

class Trail {
  readonly pts = new Float32Array(16 * 4); // x y z t, newest first
  n = 0;
  attached = false;
  life = 0.3; width = 0.2;
  r = 1; g = 1; b = 1; a = 1;
  active = false;
}

class ProjVis {
  simId = -1;
  vfx: WeaponVfx = 'laser';
  src: Entity | null = null;
  tgt: Entity | null = null;
  stamp = 0;
  x = 0; y = 0; z = 0;
  dx = 1; dy = 0; dz = 0;
  ox = 0; oy = 0; oz = 0;
  // local flight
  sx = 0; sy = 0; sz = 0; ex = 0; ey = 0; ez = 0;
  t = 0; t0 = 0; dur = 1; arc = false; peak = 0; splash = 0;
  /** sim projectiles: false until the first placement (direction comes from start→target then) */
  placed = false;
  trail: Trail | null = null;
  acc = 0; acc2 = 0; seed = 0; scale = 1;
  visible = true;
  weapon: WeaponDef | null = null;
}

const TRAIL_STYLE: Partial<Record<WeaponVfx, [number, number, number, number, number, number]>> = {
  // r g b a width life
  antibiotic_capsule: [0.15, 1.1, 0.85, 0.85, 0.2, 0.34],
  laser: [0.3, 0.95, 1.6, 0.9, 0.1, 0.1],
  acid_spit: [0.35, 1.2, 0.08, 0.6, 0.13, 0.15],
  spore_lob: [0.7, 0.8, 0.22, 0.45, 0.12, 0.3],
  toxin_bolt: [1.3, 0.18, 0.95, 0.85, 0.18, 0.22],
};

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpCol = new THREE.Color();

export class WeaponFx {
  private shots: Shot[] = [];
  private freeShots: Shot[] = [];
  private projs: ProjVis[] = [];
  private freeProjs: ProjVis[] = [];
  private bySim = new Map<number, ProjVis>();
  private trails: Trail[] = [];
  private readonly maxShots = 420;
  private readonly maxProjs: number;

  constructor(private readonly c: VfxCore) {
    const nTrails = Math.max(32, Math.floor(c.strips.slots * 0.6));
    for (let i = 0; i < nTrails; i++) this.trails.push(new Trail());
    this.maxProjs = c.q.projMeshes * 2;
  }

  get activeShots(): number { return this.shots.length; }
  get activeProjectiles(): number { return this.projs.length; }

  // ───────────────────────── events ─────────────────────────
  onFired = (ev: GameEvents['weaponFired']): void => {
    const c = this.c;
    c.stampEvent();
    const { source, target, weapon, projectile } = ev;
    const vfx = weapon.vfx;
    const muzzle = c.muzzle(source, tmpA);
    const end = target ? c.hitPoint(target, muzzle.x, muzzle.z, tmpB) : tmpB.set(ev.targetPos.x, c.heightAt(ev.targetPos.x, ev.targetPos.y) + 0.4, ev.targetPos.y);
    const visible = c.fogVisible(muzzle.x, muzzle.z) || c.fogVisible(end.x, end.z) || source.owner === c.local;
    if (!visible) return;
    const mx = (muzzle.x + end.x) * 0.5, my = (muzzle.y + end.y) * 0.5, mz = (muzzle.z + end.z) * 0.5;
    const halfLen = muzzle.distanceTo(end) * 0.5;
    const onScreen = c.onScreen(mx, my, mz, halfLen + 1);
    const isProjectileWeapon = weapon.projectileSpeed != null && weapon.projectileSpeed > 0;
    if (isProjectileWeapon || projectile) {
      if (onScreen) this.muzzleFlash(vfx, muzzle.x, muzzle.y, muzzle.z, end.x - muzzle.x, end.y - muzzle.y, end.z - muzzle.z, weaponScale(weapon));
      if (!projectile) this.launchLocal(source, target, weapon, muzzle, end);
      return;
    }
    if (!onScreen) return;
    switch (vfx) {
      case 'spray': this.addShot(S_SPRAY, source, target, muzzle, end, 0.32); this.muzzleFlash('spray', muzzle.x, muzzle.y, muzzle.z, end.x - muzzle.x, end.y - muzzle.y, end.z - muzzle.z, 1); break;
      case 'uv_beam': this.addShot(S_UV, source, target, muzzle, end, 0.32); this.uvImpactBurst(end.x, end.y, end.z, muzzle.x - end.x, muzzle.z - end.z); break;
      case 'engulf': this.addShot(S_ENGULF, source, target, muzzle, end, 0.46); break;
      case 'zap': this.addShot(S_ZAP, source, target, muzzle, end, 0.16); this.zapBurst(end.x, end.y, end.z); break;
      case 'whip': this.addShot(S_WHIP, source, target, muzzle, end, 0.22); break;
      case 'bite': this.bite(muzzle, end); break;
      case 'slam': this.slam(end.x, end.z, weapon.splashRadius ?? 1.2, muzzle.x - end.x, muzzle.z - end.z); break;
      default:
        // projectile-type key on an instant weapon: show it as a fast local flight
        this.launchLocal(source, target, weapon, muzzle, end);
        break;
    }
  };

  onImpact = (ev: GameEvents['projectileImpact']): void => {
    const c = this.c;
    c.stampEvent();
    const p = ev.projectile;
    const vis = this.bySim.get(p.id);
    let x = ev.pos.x, z = ev.pos.y, y: number;
    if (p.arc || !ev.target) {
      // lobbed shells burst on the ground; unhomed shots at their impact height
      y = c.heightAt(x, z) + (p.arc ? 0.15 : Math.max(0.15, p.endHeight));
    } else {
      // homing shots splash on the target's surface facing the incoming shot
      const from = vis ? tmpC.set(vis.x - vis.dx * 2, 0, vis.z - vis.dz * 2) : tmpC.set(p.start.x, 0, p.start.y);
      c.hitPoint(ev.target, from.x, from.z, tmpA);
      x = tmpA.x; y = tmpA.y; z = tmpA.z;
    }
    if (vis) this.releaseProj(vis);
    if (!c.fogVisible(x, z)) return;
    if (!c.onScreen(x, y, z, Math.max(2, p.splashRadius))) return;
    const dx = vis ? vis.dx : p.pos.x - p.prevPos.x, dz = vis ? vis.dz : p.pos.y - p.prevPos.y;
    this.impact(p.vfx, x, y, z, dx, dz, p.splashRadius, weaponScale(p.weapon), ev.target);
  };

  /** Forget references to a removed entity (shots keep working off cached endpoints). */
  onEntityRemoved(e: Entity): void {
    for (const s of this.shots) { if (s.src === e) s.src = null; if (s.tgt === e) s.tgt = null; }
    for (const p of this.projs) { if (p.src === e) p.src = null; if (p.tgt === e) p.tgt = null; }
  }

  // ───────────────────────── per frame ─────────────────────────
  update(): void {
    this.c.stampFrame();
    this.updateSimProjectiles();
    for (let i = this.projs.length - 1; i >= 0; i--) {
      const p = this.projs[i]!;
      if (p.simId < 0) this.updateLocalProj(p);
    }
    for (let i = this.projs.length - 1; i >= 0; i--) this.renderProj(this.projs[i]!);
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]!;
      const age = this.c.now - s.t0;
      if (age >= s.dur) { this.recycleShot(i); continue; }
      this.updateShot(s, age);
    }
    this.renderTrails();
  }

  // ───────────────────────── shots ─────────────────────────
  private addShot(kind: number, src: Entity | null, tgt: Entity | null, a: THREE.Vector3, b: THREE.Vector3, dur: number): Shot | null {
    if (this.shots.length >= this.maxShots) return null;
    const s = this.freeShots.pop() ?? new Shot();
    s.kind = kind; s.src = src; s.tgt = tgt; s.t0 = this.c.spawnTime; s.dur = dur;
    s.seed = this.c.rng.next() * 100; s.acc = 0; s.acc2 = 0; s.scale = 1; s.flag = 0;
    s.sx = a.x; s.sy = a.y; s.sz = a.z; s.ex = b.x; s.ey = b.y; s.ez = b.z;
    s.r = s.g = s.b = 0;
    this.shots.push(s);
    return s;
  }

  /** Short electric arc between two entities (also used for orderly repair welding). */
  spawnArc(src: Entity, tgt: Entity, r: number, g: number, b: number, dur = 0.14): void {
    const c = this.c;
    const a = c.muzzle(src, tmpA), e = c.hitPoint(tgt, a.x, a.z, tmpB);
    const s = this.addShot(S_ZAP, src, tgt, a, e, dur);
    if (s) { s.r = r; s.g = g; s.b = b; }
  }

  /** UV-flare "lance" from a caster to a ground point (cast flourish). */
  spawnLance(src: Entity, x: number, y: number, z: number): void {
    const a = this.c.muzzle(src, tmpA);
    this.addShot(S_FLARE_LANCE, src, null, a, tmpB.set(x, y, z), 0.2);
  }

  private recycleShot(i: number): void {
    const s = this.shots[i]!;
    s.src = s.tgt = null;
    const last = this.shots.pop()!;
    if (i < this.shots.length) this.shots[i] = last;
    this.freeShots.push(s);
  }

  /** Refresh shot endpoints from live entities. */
  private shotEnds(s: Shot): void {
    const c = this.c;
    if (s.src) { c.muzzle(s.src, tmpA); s.sx = tmpA.x; s.sy = tmpA.y; s.sz = tmpA.z; }
    if (s.tgt) { c.hitPoint(s.tgt, s.sx, s.sz, tmpB); s.ex = tmpB.x; s.ey = tmpB.y; s.ez = tmpB.z; }
  }

  private updateShot(s: Shot, age: number): void {
    this.shotEnds(s);
    switch (s.kind) {
      case S_SPRAY: this.drawSpray(s, age); break;
      case S_UV: this.drawUv(s, age, 1); break;
      case S_FLARE_LANCE: this.drawUv(s, age, 0.7); break;
      case S_ENGULF: this.drawEngulf(s, age); break;
      case S_ZAP: this.drawZap(s, age); break;
      case S_WHIP: this.drawWhip(s, age); break;
      default: break;
    }
  }

  private drawSpray(s: Shot, age: number): void {
    const c = this.c, P = c.particles, dt = c.fdt;
    const dx = s.ex - s.sx, dy = s.ey - s.sy, dz = s.ez - s.sz;
    const dist = Math.max(0.5, Math.hypot(dx, dy, dz));
    if (age < 0.24) {
      s.acc += 105 * dt * P.mul;
      let n = Math.floor(s.acc); s.acc -= n;
      if (n > 0) {
        P.begin(SPR.DROPLET).at(s.sx, s.sy, s.sz).jitter(0.04).cone(dx, dy, dz, 0.11, dist / 0.3 * 0.85, dist / 0.3 * 1.15)
          .life(0.26, 0.36).size(0.07, 0.1, 2.4).color(0.9, 1.35, 1.3, 0.9).end(0.6, 1.0, 0.95, 0).drag(1.0).gravity(-2)
          .additive(0.35).emitExact(n);
      }
      s.acc2 += 26 * dt * P.mul;
      n = Math.floor(s.acc2); s.acc2 -= n;
      if (n > 0) {
        P.begin(SPR.SMOKE).at(s.sx, s.sy, s.sz).jitter(0.05).cone(dx, dy, dz, 0.2, dist / 0.5 * 0.7, dist / 0.5)
          .life(0.4, 0.6).size(0.18, 0.24, 4.2, 0.6).color(0.8, 1.0, 0.97, 0.4).drag(2.2).spin(1.6).fade(0.1).additive(0.12).emitExact(n);
      }
    }
    if (s.flag === 0 && age >= 0.2 && c.canSee(s.ex, s.ey, s.ez, 1)) {
      s.flag = 1;
      const g = c.heightAt(s.ex, s.ez);
      P.begin(SPR.DROPLET).at(s.ex, s.ey, s.ez).jitter(0.1).hemi(1, 2.6).life(0.25, 0.42).size(0.05, 0.08, 0.6)
        .color(0.8, 1.2, 1.15, 0.85).gravity(-9).floor(g + 0.02).additive(0.35).emit(7);
      P.begin(SPR.GLOW).at(s.ex, s.ey, s.ez).life(0.16).size(0.7, 0.7, 1.3, 0.5).color(0.6, 1.4, 1.3, 0.55).additive(1).emitExact(1);
    }
    // nozzle glow
    c.sprites.add(s.sx, s.sy, s.sz, 0.28, SPR.GLOW, 0.8, 1.5, 1.4, 0.6 * (1 - age / s.dur));
  }

  private drawUv(s: Shot, age: number, widthMul: number): void {
    const c = this.c, P = c.particles;
    const env = smooth01(age / 0.035) * (1 - smooth01((age - 0.1) / (s.dur - 0.1)));
    if (env <= 0.001) return;
    const flick = 0.85 + 0.15 * Math.sin(c.now * 90 + s.seed);
    const w = env * widthMul * flick;
    const dx = s.ex - s.sx, dy = s.ey - s.sy, dz = s.ez - s.sz;
    const len = Math.hypot(dx, dy, dz) || 1;
    // glow body (violet) — slight shimmer wobble along the length
    if (c.strips.start(0.62, 0.22, 1.9, 0.95 * env, 0, 0.6, s.seed)) {
      for (let i = 0; i <= 6; i++) {
        const t = i / 6, wob = Math.sin(t * 9 + c.now * 40 + s.seed) * 0.03 * Math.sin(t * Math.PI);
        c.strips.point(s.sx + dx * t, s.sy + dy * t + wob, s.sz + dz * t, 0.56 * w * (0.75 + 0.25 * Math.sin(t * Math.PI)), 1);
      }
      c.strips.end();
    }
    // white-hot core
    if (c.strips.start(1.2, 0.95, 1.6, env, 1.4, 0.25, s.seed + 3)) {
      c.strips.point(s.sx, s.sy, s.sz, 0.12 * w, 0.8);
      c.strips.point(s.sx + dx * 0.5, s.sy + dy * 0.5, s.sz + dz * 0.5, 0.15 * w, 1);
      c.strips.point(s.ex, s.ey, s.ez, 0.13 * w, 1);
      c.strips.end();
    }
    const sp = c.sprites;
    sp.add(s.sx, s.sy, s.sz, 0.7 * w, SPR.GLOW, 1.0, 0.45, 2.4, 0.9);
    sp.add(s.ex, s.ey, s.ez, 1.05 * w, SPR.FLARE, 1.4, 0.8, 2.6, 0.9, 1, c.now * 3 + s.seed);
    sp.add(s.ex, s.ey, s.ez, 0.42 * w, SPR.GLOW, 2.5, 2.2, 3.0, 1);
    if (widthMul >= 1 && age < 0.22) {
      // UV photons shedding off the beam + sizzle at the hit point
      s.acc += 34 * c.fdt * P.mul;
      const n = Math.floor(s.acc); s.acc -= n;
      if (n > 0) {
        P.begin(SPR.SPARK).at(s.sx, s.sy, s.sz).line(s.ex, s.ey, s.ez).sphere(0.2, 0.7).life(0.18, 0.32).size(0.05, 0.08, 0.3)
          .color(1.1, 0.55, 2.4, 0.9).additive(1).emitExact(n);
        P.begin(SPR.SPARK, PM_STRETCH).at(s.ex, s.ey, s.ez).jitter(0.08).cone(-dx / len, 0.6, -dz / len, 1.0, 1.2, 3.2)
          .life(0.15, 0.3).size(0.035, 0.05, 0.5).color(1.6, 1.1, 2.8, 1).gravity(-4).stretch(0.04).additive(1).emitExact(Math.max(0, n - 1));
      }
    }
  }

  private drawEngulf(s: Shot, age: number): void {
    const c = this.c, P = c.particles;
    const ext = smooth01(age / 0.15);
    const retract = smooth01((age - 0.28) / 0.18);
    const reach = ext * (1 - retract);
    const dx = s.ex - s.sx, dz = s.ez - s.sz;
    const len = Math.hypot(dx, dz) || 1;
    const sideX = -dz / len, sideZ = dx / len;
    for (let k = 0; k < 3; k++) {
      const off = (k - 1) * 0.32, lift = (k === 1 ? 0.18 : -0.05);
      if (!c.strips.start(0.42, 1.25, 1.05, 0.85 * (1 - retract * 0.6), 0.35, 0.15, s.seed + k)) break;
      const n = 8;
      for (let i = 0; i < n; i++) {
        const t = (i / (n - 1)) * reach;
        const bulge = Math.sin(t * Math.PI) * (0.25 + k * 0.05) * (k === 1 ? 0.2 : 1);
        const wig = Math.sin(t * 8 + c.now * 14 + k * 2) * 0.05;
        const x = s.sx + sideX * off * (1 - t) + dx * t + sideX * (bulge * Math.sign(off || 1) + wig);
        const z = s.sz + sideZ * off * (1 - t) + dz * t + sideZ * (bulge * Math.sign(off || 1) + wig);
        const y = s.sy + lift * (1 - t) + (s.ey - s.sy) * t + Math.sin(t * Math.PI) * 0.22;
        c.strips.point(x, y, z, (0.24 - 0.14 * (i / (n - 1))) * (0.6 + 0.4 * ext), 1);
      }
      c.strips.end();
    }
    if (s.flag === 0 && age >= 0.15) {
      s.flag = 1;
      if (c.canSee(s.ex, s.ey, s.ez, 1.5)) {
        const tf = s.tgt && s.tgt.def.kind !== 'resource' ? s.tgt.def.faction : 'neutral';
        P.begin(SPR.RING).at(s.ex, s.ey, s.ez).life(0.28).size(1.6, 1.6, 0.16, 0.6).color(0.6, 1.6, 1.4, 0.9).additive(1).emitExact(1);
        P.begin(SPR.GLOW).at(s.ex, s.ey, s.ez).life(0.18).size(1.3, 1.3, 0.6).color(0.5, 1.4, 1.2, 0.7).additive(1).emitExact(1);
        if (tf === 'pathogen') {
          c.playerColor(s.tgt!.owner, tmpCol);
          P.begin(SPR.GOO).at(s.ex, s.ey, s.ez).jitter(0.15).sphere(1.5, 3.4).up(0.5, 1.5).life(0.3, 0.5).size(0.08, 0.14, 0.6)
            .color(tmpCol.r * 1.4, tmpCol.g * 1.4, tmpCol.b * 1.4, 1).endAlpha(0.6).alt(0.45, 1.3, 0.08, 0.35).gravity(-8).additive(0.15).emit(12);
        }
        P.begin(SPR.DROPLET).at(s.ex, s.ey, s.ez).jitter(0.3).up(0.6, 1.4).life(0.5, 0.8).size(0.06, 0.1, 1.3)
          .color(0.55, 1.5, 1.3, 0.8).drag(1.5).wobble(0.06, 9).additive(0.7).emit(7);
      }
    }
    c.sprites.add(s.ex, s.ey, s.ez, 0.7 * reach, SPR.GLOW, 0.4, 1.2, 1.0, 0.5 * reach);
  }

  private drawZap(s: Shot, age: number): void {
    const c = this.c, rng = c.rng;
    const env = 1 - smooth01((age - s.dur * 0.4) / (s.dur * 0.6));
    const r = s.r || 0.55, g = s.g || 0.8, b = s.b || 2.0;
    const dx = s.ex - s.sx, dy = s.ey - s.sy, dz = s.ez - s.sz;
    const len = Math.hypot(dx, dy, dz) || 1;
    // perpendicular basis (side in XZ, plus up)
    const px = -dz / len, pz = dx / len;
    for (let branch = 0; branch < 2; branch++) {
      if (!c.strips.start(r, g, b, env * (branch ? 0.6 : 1), branch ? 0.5 : 1.0, 0.5, s.seed + branch)) break;
      const n = branch ? 5 : 7;
      const amp = Math.min(0.16, 0.06 + len * 0.08) * (branch ? 1.4 : 1);
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const j = i === 0 || i === n - 1 ? 0 : 1;
        const o1 = (rng.next() * 2 - 1) * amp * j, o2 = (rng.next() * 2 - 1) * amp * j;
        c.strips.point(s.sx + dx * t + px * o1, s.sy + dy * t + o2, s.sz + dz * t + pz * o1, branch ? 0.05 : 0.085, 1);
      }
      c.strips.end();
    }
    c.sprites.add(s.ex, s.ey, s.ez, 0.4 * env, SPR.GLOW, r * 1.5, g * 1.5, b * 1.2, 0.9);
    c.sprites.add(s.sx, s.sy, s.sz, 0.25 * env, SPR.GLOW, r * 1.5, g * 1.5, b * 1.2, 0.8);
  }

  private drawWhip(s: Shot, age: number): void {
    const c = this.c, P = c.particles;
    const k = age / s.dur;
    const dx = s.ex - s.sx, dz = s.ez - s.sz;
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len, sideX = -fz, sideZ = fx;
    const R = 0.55 + (s.tgt ? Math.min(0.6, s.tgt.radius * 0.4) : 0);
    const dirSign = s.seed % 2 < 1 ? 1 : -1;
    const a0 = 2.5, sweep = 2.9;
    const head = a0 - sweep * easeOut(k);
    const tailLen = 1.4;
    if (c.strips.start(1.5, 0.35, 1.15, 1 - smooth01((k - 0.65) / 0.35), 0.55, 0.2, s.seed)) {
      const n = 10;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const ang = head + tailLen * t;
        const ca = Math.cos(ang) * dirSign, sa = Math.sin(ang);
        const x = s.ex + sideX * ca * R - fx * 0.15, z = s.ez + sideZ * ca * R - fz * 0.15;
        const y = s.ey + sa * R * 0.7;
        c.strips.point(x, y, z, 0.25 * (1 - t * 0.8), (1 - t) * (1 - t));
      }
      c.strips.end();
    }
    if (s.flag === 0 && k > 0.45) {
      s.flag = 1;
      if (c.canSee(s.ex, s.ey, s.ez, 1)) {
        P.begin(SPR.FLARE).at(s.ex, s.ey, s.ez).life(0.1).size(0.55, 0.55, 1.4, 0.5).color(1.6, 0.6, 1.4, 1).additive(1).emitExact(1);
        P.begin(SPR.SPARK, PM_STRETCH).at(s.ex, s.ey, s.ez).cone(sideX * dirSign, -0.3, sideZ * dirSign, 0.8, 2, 4.5).life(0.12, 0.26)
          .size(0.035, 0.055, 0.4).color(1.8, 0.5, 1.3, 1).alt(0.6, 1.6, 0.2, 0.3).gravity(-6).stretch(0.04).additive(1).emit(6);
      }
    }
  }

  // ───────────────────────── instant bursts ─────────────────────────
  private uvImpactBurst(x: number, y: number, z: number, bx: number, bz: number): void {
    const P = this.c.particles;
    P.begin(SPR.SPARK, PM_STRETCH).at(x, y, z).cone(bx, 0.7, bz, 1.15, 2.2, 6).life(0.16, 0.34).size(0.04, 0.06, 0.4)
      .color(1.8, 1.3, 3.2, 1).alt(1.0, 0.4, 2.6, 0.5).gravity(-6).drag(1.5).stretch(0.035).additive(1).emit(10);
    P.begin(SPR.RING).at(x, y, z).life(0.22).size(0.3, 0.3, 4.2, 0.45).color(0.9, 0.5, 2.2, 0.9).additive(1).emitExact(1);
  }

  private zapBurst(x: number, y: number, z: number): void {
    const P = this.c.particles;
    P.begin(SPR.SPARK, PM_STRETCH).at(x, y, z).hemi(1.2, 3).life(0.12, 0.25).size(0.03, 0.045, 0.4).color(1.4, 1.8, 3.0, 1)
      .gravity(-8).stretch(0.04).additive(1).emit(5);
    P.begin(SPR.GLOW).at(x, y, z).life(0.1).size(0.5, 0.5, 1.2).color(0.9, 1.3, 2.6, 0.9).additive(1).emitExact(1);
  }

  private bite(a: THREE.Vector3, b: THREE.Vector3): void {
    const P = this.c.particles;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    // the stab: one fast streak from the mandibles into the target
    P.begin(SPR.SPARK, PM_STRETCH).at(a.x, a.y, a.z).vel(dx / 0.08, dy / 0.08, dz / 0.08).life(0.08).size(0.07, 0.07, 0.7)
      .color(2.2, 0.8, 1.9, 1).stretch(0.025).additive(1).emitExact(1);
    P.begin(SPR.FLARE).at(b.x, b.y, b.z).life(0.12).size(0.85, 0.85, 1.3, 0.5).color(2.4, 0.8, 2.1, 1).additive(1).emitExact(1);
    P.begin(SPR.SPARK, PM_STRETCH).at(b.x, b.y, b.z).cone(dx, dy + 0.3, dz, 0.9, 1.8, 4.2).life(0.12, 0.28).size(0.03, 0.05, 0.4)
      .color(2.0, 0.5, 1.7, 1).alt(0.6, 1.8, 0.25, 0.35).gravity(-7).stretch(0.035).additive(1).emit(6);
    P.begin(SPR.DROPLET).at(b.x, b.y, b.z).jitter(0.05).cone(dx, dy + 0.5, dz, 0.9, 0.8, 2).life(0.25, 0.4).size(0.04, 0.07)
      .color(0.9, 0.25, 0.85, 0.9).gravity(-9).additive(0.3).emit(3);
  }

  private slam(x: number, z: number, splash: number, bx: number, bz: number): void {
    const c = this.c, P = c.particles;
    const g = c.heightAt(x, z);
    const R = splash + 0.45;
    P.begin(SPR.SHOCK, PM_GROUND).at(x, g + 0.08, z).life(0.42).size(0.5, 0.5, (2 * R / 0.9) / 0.5, 0.45)
      .color(1.5, 1.0, 1.8, 1).additive(0.75).emitExact(1);
    P.begin(SPR.RING, PM_GROUND).at(x, g + 0.1, z).life(0.25).size(0.4, 0.4, (2 * R * 0.7 / 0.8) / 0.4, 0.4)
      .color(1.6, 1.3, 1.8, 0.9).additive(1).emitExact(1);
    P.begin(SPR.GLOW).at(x, g + 0.4, z).life(0.12).size(1.8, 1.8, 1.3).color(1.6, 1.0, 1.6, 0.8).additive(1).emitExact(1);
    P.begin(SPR.SMOKE).at(x, g + 0.15, z).disc(0.6).radial(2.4, 4.5).up(0.3, 1.1).drag(3).life(0.6, 0.95).size(0.35, 0.55, 2.8, 0.6)
      .color(0.42, 0.38, 0.35, 0.55).fade(0.1).spin(1.2).emit(14);
    P.begin(SPR.DEBRIS).at(x, g + 0.1, z).disc(0.4).radial(1.8, 4).up(3, 6).gravity(-17).floor(g + 0.05).drag(0.4).life(0.7, 1.1)
      .size(0.1, 0.2, 0.9).color(0.45, 0.42, 0.4, 1).fade(0, 3).spin(12).emit(10);
    c.decals.add(c.spawnTime, x, g, z, 0, 1, 0, R * 1.7, c.rng.next() * 6.28, SPR.SCORCH, 0.2, 0.16, 0.15, 0.6, c.q.decalLife * 0.6, 0, 0.4, 0.5);
    void bx; void bz;
  }

  // ───────────────────────── muzzle flashes ─────────────────────────
  private muzzleFlash(vfx: WeaponVfx, x: number, y: number, z: number, dx: number, dy: number, dz: number, scale: number): void {
    const P = this.c.particles;
    switch (vfx) {
      case 'spray':
        P.begin(SPR.GLOW).at(x, y, z).life(0.1).size(0.32, 0.32, 1.5).color(0.9, 1.4, 1.35, 0.6).additive(0.8).emitExact(1);
        break;
      case 'antibiotic_capsule':
        P.begin(SPR.GLOW).at(x, y, z).life(0.13).size(0.9, 0.9, 1.4).color(0.3, 1.6, 1.3, 0.9).additive(1).emitExact(1);
        P.begin(SPR.SMOKE).at(x, y, z).cone(dx, dy + 0.5, dz, 0.6, 0.4, 1.4).life(0.55, 0.85).size(0.25, 0.35, 3, 0.6)
          .color(0.75, 0.82, 0.82, 0.38).drag(1.8).spin(1).fade(0.1).emit(4);
        break;
      case 'laser':
        P.begin(SPR.GLOW).at(x, y, z).life(0.08).size(0.5, 0.5, 1.2).color(0.4, 1.3, 2.4, 0.9).additive(1).emitExact(1);
        break;
      case 'acid_spit':
        P.begin(SPR.GLOW).at(x, y, z).life(0.1).size(0.55, 0.55, 1.3).color(0.5, 1.5, 0.15, 0.8).additive(1).emitExact(1);
        P.begin(SPR.DROPLET).at(x, y, z).cone(dx, dy, dz, 0.45, 1.5, 3.5).life(0.18, 0.32).size(0.04, 0.07).gravity(-7)
          .color(0.4, 1.2, 0.08, 0.9).additive(0.3).emit(6);
        break;
      case 'spore_lob':
        P.begin(SPR.SMOKE).at(x, y, z).cone(dx, dy + 1.2, dz, 0.6, 0.8, 2.2).life(0.6, 0.95).size(0.3, 0.42, 2.6, 0.6)
          .color(0.42, 0.4, 0.17, 0.55).drag(2).spin(1).fade(0.08).emit(6);
        P.begin(SPR.SPORES).at(x, y, z).jitter(0.15).sphere(0.4, 1.2).up(0.3, 0.8).life(0.6, 1).size(0.12, 0.18)
          .color(1.1, 1.3, 0.3, 0.9).drag(1.5).additive(1).emit(5);
        break;
      case 'toxin_bolt':
        P.begin(SPR.GLOW).at(x, y, z).life(0.11).size(0.65 * scale, 0.65 * scale, 1.3).color(1.6, 0.25, 1.25, 0.9).additive(1).emitExact(1);
        P.begin(SPR.SMOKE).at(x, y, z).jitter(0.1).sphere(0.2, 0.6).life(0.45, 0.7).size(0.2 * scale, 0.3 * scale, 2.5)
          .color(0.16, 0.05, 0.16, 0.45).drag(1.5).spin(1.2).fade(0.1).emit(3);
        break;
      default: break;
    }
  }

  // ───────────────────────── projectiles ─────────────────────────
  private acquireProj(): ProjVis | null {
    if (this.projs.length >= this.maxProjs) return null;
    const p = this.freeProjs.pop() ?? new ProjVis();
    p.simId = -1; p.src = p.tgt = null; p.trail = null; p.acc = p.acc2 = 0; p.t = 0; p.visible = true; p.weapon = null; p.placed = false;
    p.ox = p.oy = p.oz = 0; p.peak = 0; p.splash = 0; p.scale = 1; p.arc = false;
    p.seed = this.c.rng.next() * 100;
    this.projs.push(p);
    return p;
  }

  private releaseProj(p: ProjVis): void {
    const i = this.projs.indexOf(p);
    if (i < 0) return;
    if (p.trail) {
      // let the ribbon fade out on its own
      p.trail.attached = false;
      p.trail = null;
    }
    if (p.simId >= 0) this.bySim.delete(p.simId);
    p.src = p.tgt = null; p.weapon = null;
    const last = this.projs.pop()!;
    if (i < this.projs.length) this.projs[i] = last;
    this.freeProjs.push(p);
  }

  private attachTrail(p: ProjVis): void {
    const st = TRAIL_STYLE[p.vfx];
    if (!st) return;
    let t: Trail | null = null;
    for (const tr of this.trails) if (!tr.active) { t = tr; break; }
    if (!t) return;
    t.active = true; t.attached = true; t.n = 0;
    t.r = st[0]; t.g = st[1]; t.b = st[2]; t.a = st[3]; t.width = st[4] * p.scale; t.life = st[5];
    p.trail = t;
  }

  private launchLocal(src: Entity, tgt: Entity | null, weapon: WeaponDef, a: THREE.Vector3, b: THREE.Vector3): void {
    const p = this.acquireProj();
    if (!p) return;
    p.vfx = weapon.vfx; p.src = src; p.tgt = tgt; p.weapon = weapon;
    p.sx = p.x = a.x; p.sy = p.y = a.y; p.sz = p.z = a.z;
    p.ex = b.x; p.ey = b.y; p.ez = b.z;
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const speed = weapon.projectileSpeed && weapon.projectileSpeed > 0 ? weapon.projectileSpeed : 16;
    p.dur = Math.max(0.06, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / speed);
    p.arc = !!weapon.arc;
    p.peak = p.arc ? Math.min(4.5, Math.max(1.2, dist * 0.32)) : 0;
    p.splash = weapon.splashRadius ?? 0;
    p.scale = weaponScale(weapon);
    p.t0 = this.c.spawnTime;
    const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
    p.dx = (b.x - a.x) / l; p.dy = (b.y - a.y) / l + (p.arc ? 0.8 : 0); p.dz = (b.z - a.z) / l;
    this.attachTrail(p);
  }

  private updateLocalProj(p: ProjVis): void {
    const c = this.c;
    const k = Math.min(1, (c.now - p.t0) / p.dur);
    if (p.tgt && p.tgt.alive && !p.arc) { c.hitPoint(p.tgt, p.x, p.z, tmpB); p.ex = tmpB.x; p.ey = tmpB.y; p.ez = tmpB.z; }
    const px = p.x, py = p.y, pz = p.z;
    p.x = p.sx + (p.ex - p.sx) * k;
    p.z = p.sz + (p.ez - p.sz) * k;
    p.y = p.sy + (p.ey - p.sy) * k + p.peak * 4 * k * (1 - k);
    setDir(p, p.x - px, p.y - py, p.z - pz);
    p.t = k;
    if (k >= 1) {
      const x = p.ex, y = p.arc ? c.heightAt(p.ex, p.ez) + 0.15 : p.ey, z = p.ez;
      const vfx = p.vfx, splash = p.splash, scale = p.scale, tgt = p.tgt;
      const dx = p.dx, dz = p.dz;
      this.releaseProj(p);
      if (c.fogVisible(x, z) && c.onScreen(x, y, z, Math.max(2, splash))) {
        c.stampFrame();
        this.impact(vfx, x, y, z, dx, dz, splash, scale, tgt);
      }
    }
  }

  private updateSimProjectiles(): void {
    const c = this.c, w = c.world, a = c.alpha, frame = c.frame;
    const list = w.projectiles;
    for (let i = 0; i < list.length; i++) {
      const sp = list[i]!;
      let p = this.bySim.get(sp.id);
      if (!p) {
        p = this.acquireProj() ?? undefined;
        if (!p) continue;
        this.initSimProj(p, sp);
      }
      p.stamp = frame;
      this.placeSimProj(p, sp, a);
    }
    // sim projectiles that vanished without an impact event (fizzled / target died)
    for (let i = this.projs.length - 1; i >= 0; i--) {
      const p = this.projs[i]!;
      if (p.simId >= 0 && p.stamp !== frame) this.releaseProj(p);
    }
  }

  private initSimProj(p: ProjVis, sp: Projectile): void {
    const c = this.c;
    p.simId = sp.id; p.vfx = sp.vfx; p.weapon = sp.weapon; p.arc = sp.arc; p.splash = sp.splashRadius;
    p.scale = weaponScale(sp.weapon);
    p.src = c.world.get(sp.sourceId) ?? null;
    p.tgt = sp.targetId != null ? c.world.get(sp.targetId) ?? null : null;
    const dist = Math.hypot(sp.targetPos.x - sp.start.x, sp.targetPos.y - sp.start.y);
    p.peak = sp.arc ? Math.min(4.5, Math.max(1.2, dist * 0.32)) : 0;
    // offset from the sim launch point to the model muzzle; blended out over the flight
    p.ox = p.oy = p.oz = 0;
    if (p.src) {
      const m = c.muzzle(p.src, tmpA);
      const g0 = c.heightAt(sp.start.x, sp.start.y);
      p.ox = m.x - sp.start.x; p.oy = m.y - (g0 + sp.startHeight); p.oz = m.z - sp.start.y;
      const ol = Math.hypot(p.ox, p.oy, p.oz);
      if (ol > 3) { p.ox = p.oy = p.oz = 0; } // model far from the sim source (teleport?) — ignore
    }
    this.bySim.set(sp.id, p);
    this.attachTrail(p);
  }

  private placeSimProj(p: ProjVis, sp: Projectile, a: number): void {
    const c = this.c;
    const x = sp.prevPos.x + (sp.pos.x - sp.prevPos.x) * a;
    const z = sp.prevPos.y + (sp.pos.y - sp.prevPos.y) * a;
    let t = sp.prevT + (sp.t - sp.prevT) * a;
    if (!sp.arc) {
      const d0 = Math.hypot(sp.targetPos.x - sp.start.x, sp.targetPos.y - sp.start.y);
      if (d0 > 1e-3) t = Math.max(t, 1 - Math.hypot(sp.targetPos.x - x, sp.targetPos.y - z) / d0);
    }
    t = Math.min(1, Math.max(0, t));
    const g0 = c.heightAt(sp.start.x, sp.start.y), g1 = c.heightAt(sp.targetPos.x, sp.targetPos.y);
    let y = g0 + (g1 - g0) * t + sp.startHeight + (sp.endHeight - sp.startHeight) * t;
    if (sp.arc) y += p.peak * 4 * t * (1 - t);
    const k = 1 - t;
    const nx = x + p.ox * k, ny = y + p.oy * k, nz = z + p.oz * k;
    if (p.placed) setDir(p, nx - p.x, ny - p.y, nz - p.z);
    else { p.placed = true; setDir(p, sp.targetPos.x - sp.start.x, sp.arc ? 1 : 0, sp.targetPos.y - sp.start.y); }
    p.x = nx; p.y = ny; p.z = nz; p.t = t;
  }

  private renderProj(p: ProjVis): void {
    const c = this.c;
    p.visible = c.fogVisible(p.x, p.z);
    if (p.trail) pushTrail(p.trail, p.x, p.y, p.z, c.now, p.visible);
    if (!p.visible || !c.onScreen(p.x, p.y, p.z, 1)) return;
    const P = c.particles, sp = c.sprites, s = p.scale, dt = c.fdt;
    switch (p.vfx) {
      case 'antibiotic_capsule': {
        c.meshes.addCapsule(p.x, p.y, p.z, p.dx, p.dy, p.dz, c.now * 9 + p.seed, s);
        sp.add(p.x, p.y, p.z, 0.75 * s, SPR.GLOW, 0.25, 1.4, 1.15, 0.7);
        p.acc += 16 * dt * P.mul;
        const n = Math.floor(p.acc); p.acc -= n;
        if (n > 0) P.begin(SPR.DROPLET).at(p.x, p.y, p.z).jitter(0.06).sphere(0.1, 0.4).life(0.3, 0.45).size(0.05, 0.07, 0.5)
          .color(0.3, 1.5, 1.2, 0.9).gravity(-5).additive(0.6).emitExact(n);
        break;
      }
      case 'laser': {
        sp.streak(p.x, p.y, p.z, 0.17 * s, p.dx, p.dy, p.dz, 0.95, SPR.BOLT, 0.35, 1.1, 2.6, 1);
        sp.streak(p.x, p.y, p.z, 0.07 * s, p.dx, p.dy, p.dz, 0.7, SPR.BOLT, 1.6, 2.4, 3.0, 1);
        break;
      }
      case 'acid_spit': {
        c.meshes.addGlob(p.x, p.y, p.z, p.dx, p.dy, p.dz, c.now + p.seed, s);
        sp.add(p.x, p.y, p.z, 0.6 * s, SPR.GLOW, 0.45, 1.4, 0.1, 0.65);
        p.acc += 30 * dt * P.mul;
        const n = Math.floor(p.acc); p.acc -= n;
        if (n > 0) P.begin(SPR.DROPLET).at(p.x, p.y - 0.05, p.z).jitter(0.07).vel(p.dx * 1.2, 0, p.dz * 1.2).life(0.35, 0.5).size(0.045, 0.075)
          .color(0.42, 1.25, 0.08, 0.9).gravity(-9).floor(c.heightAt(p.x, p.z) + 0.02).additive(0.3).emitExact(n);
        break;
      }
      case 'spore_lob': {
        c.meshes.addSpores(p.x, p.y, p.z, c.now * 5 + p.seed, 1.15 * s);
        sp.add(p.x, p.y, p.z, 0.65 * s, SPR.GLOW, 0.8, 1.0, 0.2, 0.45);
        p.acc += 26 * dt * P.mul;
        let n = Math.floor(p.acc); p.acc -= n;
        if (n > 0) P.begin(SPR.SPORES).at(p.x, p.y, p.z).jitter(0.12).sphere(0.05, 0.35).life(0.6, 0.95).size(0.14, 0.2, 1.8)
          .color(0.55, 0.62, 0.2, 0.6).drag(1.5).gravity(-0.3).wobble(0.12, 3).spin(2).fade(0.1).emitExact(n);
        p.acc2 += 10 * dt * P.mul;
        n = Math.floor(p.acc2); p.acc2 -= n;
        if (n > 0) P.begin(SPR.SPARKLE).at(p.x, p.y, p.z).jitter(0.15).sphere(0.1, 0.4).life(0.4, 0.7).size(0.1, 0.14, 0.4)
          .color(1.4, 1.6, 0.35, 0.9).additive(1).emitExact(n);
        break;
      }
      case 'toxin_bolt': {
        sp.add(p.x, p.y, p.z, 0.62 * s, SPR.GLOW, 1.4, 0.2, 1.1, 0.85);
        sp.streak(p.x, p.y, p.z, 0.2 * s, p.dx, p.dy, p.dz, 0.45 * s, SPR.BOLT, 2.2, 0.45, 1.8, 1);
        sp.add(p.x, p.y, p.z, 0.2 * s, SPR.SPARK, 2.6, 1.6, 2.4, 1);
        p.acc += 28 * dt * P.mul;
        let n = Math.floor(p.acc); p.acc -= n;
        if (n > 0) P.begin(SPR.SMOKE).at(p.x, p.y, p.z).jitter(0.06 * s).sphere(0.05, 0.25).up(0.15, 0.35).life(0.45, 0.75)
          .size(0.16 * s, 0.22 * s, 3).color(0.17, 0.05, 0.17, 0.5).drag(1.4).spin(1.5).fade(0.12).emitExact(n);
        p.acc2 += 14 * dt * P.mul;
        n = Math.floor(p.acc2); p.acc2 -= n;
        if (n > 0) P.begin(SPR.SPARK).at(p.x, p.y, p.z).jitter(0.1).sphere(0.2, 0.6).life(0.25, 0.4).size(0.05, 0.08, 0.3)
          .color(1.8, 0.3, 1.4, 1).additive(1).emitExact(n);
        break;
      }
      default: {
        // unknown key on a projectile — readable neutral bolt
        sp.add(p.x, p.y, p.z, 0.35 * s, SPR.GLOW, 1.5, 1.5, 1.5, 0.8);
        break;
      }
    }
  }

  private renderTrails(): void {
    const c = this.c, now = c.now;
    for (const t of this.trails) {
      if (!t.active) continue;
      // expire old points
      while (t.n > 0 && now - t.pts[(t.n - 1) * 4 + 3]! > t.life) t.n--;
      if (t.n === 0 && !t.attached) { t.active = false; continue; }
      if (t.n < 2) continue;
      const head = t.pts;
      if (!c.onScreen(head[0]!, head[1]!, head[2]!, 3)) continue;
      if (!c.strips.start(t.r, t.g, t.b, t.a, 0, 0, 0)) break;
      for (let i = 0; i < t.n; i++) {
        const o = i * 4;
        const age = (now - head[o + 3]!) / t.life;
        const f = Math.max(0, 1 - age);
        c.strips.point(head[o]!, head[o + 1]!, head[o + 2]!, t.width * (0.35 + 0.65 * f), f * f);
      }
      c.strips.end();
    }
  }

  // ───────────────────────── impacts ─────────────────────────
  /** Impact effect for a weapon key at a world point. (dx, dz) = incoming travel direction. */
  impact(vfx: WeaponVfx, x: number, y: number, z: number, dx: number, dz: number, splash: number, scale: number, target: Entity | null): void {
    const c = this.c, P = c.particles;
    const g = c.heightAt(x, z);
    const dl = Math.hypot(dx, dz) || 1;
    const bx = -dx / dl, bz = -dz / dl; // back toward the shooter
    const life = c.q.decalLife;
    switch (vfx) {
      case 'antibiotic_capsule': {
        const R = Math.max(1, splash);
        P.begin(SPR.FLARE).at(x, y + 0.15, z).life(0.13).size(1.5, 1.5, 1.4, 0.5).color(1.4, 2.6, 2.4, 1).additive(1).emitExact(1);
        P.begin(SPR.GLOW).at(x, y + 0.2, z).life(0.25).size(2.2 * R / 1.8, 2.2 * R / 1.8, 1.3).color(0.2, 1.2, 0.95, 0.7).additive(1).emitExact(1);
        // glass shards
        P.begin(SPR.SPARK, PM_STRETCH).at(x, y + 0.15, z).hemi(3, 7).life(0.25, 0.5).size(0.045, 0.07, 0.5).color(1.8, 2.8, 2.8, 1)
          .gravity(-12).drag(0.9).floor(g + 0.02).stretch(0.03).additive(1).emit(14);
        // teal splash ring + droplets + mist
        P.begin(SPR.RING, PM_GROUND).at(x, g + 0.07, z).life(0.45).size(0.5, 0.5, (2 * R / 0.8) / 0.5, 0.4).color(0.25, 1.8, 1.45, 1).additive(1).emitExact(1);
        P.begin(SPR.SHOCK, PM_GROUND).at(x, g + 0.06, z).life(0.32).size(0.4, 0.4, (1.6 * R / 0.9) / 0.4, 0.5).color(0.2, 1.2, 1.0, 0.55).additive(0.7).emitExact(1);
        P.begin(SPR.DROPLET).at(x, y + 0.1, z).jitter(0.2).hemi(2, 4.5).up(0.5, 1.5).life(0.4, 0.7).size(0.07, 0.11, 0.6)
          .color(0.3, 1.6, 1.3, 0.95).gravity(-10).floor(g + 0.03).additive(0.45).emit(18);
        P.begin(SPR.SMOKE).at(x, g + 0.3, z).disc(R * 0.45).radial(0.3, 0.9).up(0.2, 0.6).drag(2).life(0.8, 1.2).size(0.5, 0.7, 2.6, 0.6)
          .color(0.55, 0.95, 0.9, 0.28).fade(0.12).spin(0.8).emit(6);
        c.decals.add(c.spawnTime, x, g, z, 0, 1, 0, R * 1.3, c.rng.next() * 6.28, SPR.SPLAT, 0.12, 0.62, 0.52, 0.5, life * 0.5, 0.35);
        break;
      }
      case 'laser': {
        P.begin(SPR.FLARE).at(x, y, z).life(0.09).size(0.75, 0.75, 1.3, 0.5).color(1.0, 2.2, 3.2, 1).additive(1).emitExact(1);
        P.begin(SPR.SPARK, PM_STRETCH).at(x, y, z).cone(bx, 0.5, bz, 1.2, 2, 5.5).life(0.12, 0.28).size(0.035, 0.05, 0.4)
          .color(1.2, 2.4, 3.4, 1).gravity(-6).stretch(0.035).additive(1).emit(8);
        P.begin(SPR.RING).at(x, y, z).life(0.16).size(0.25, 0.25, 3.6, 0.45).color(0.5, 1.4, 2.4, 0.9).additive(1).emitExact(1);
        break;
      }
      case 'acid_spit': {
        P.begin(SPR.GLOW).at(x, y, z).life(0.13).size(0.9, 0.9, 1.3).color(0.55, 1.6, 0.15, 0.8).additive(1).emitExact(1);
        P.begin(SPR.DROPLET).at(x, y, z).jitter(0.08).cone(bx, 0.9, bz, 1.2, 1.4, 3.4).life(0.3, 0.5).size(0.05, 0.085, 0.7)
          .color(0.45, 1.3, 0.1, 0.95).gravity(-9).floor(g + 0.02).additive(0.3).emit(10);
        // sizzle: steam + popping sparks
        P.begin(SPR.SMOKE2).at(x, y, z).jitter(0.12).up(0.6, 1.3).sphere(0.1, 0.3).drag(1.5).life(0.6, 1.0).size(0.18, 0.26, 3.2, 0.7)
          .color(0.7, 0.95, 0.55, 0.35).fade(0.15).wobble(0.06, 5).spin(1.4).emit(6);
        P.begin(SPR.SPARK, PM_STRETCH).at(x, y, z).jitter(0.15).hemi(0.4, 1.4).up(0.4, 1.2).life(0.2, 0.5).size(0.025, 0.04, 0.4)
          .color(1.6, 2.2, 0.35, 1).gravity(-2).stretch(0.03).additive(1).emit(8);
        if (!target || target.kind !== 'unit' || !target.mover?.flying) {
          c.decals.add(c.spawnTime, x, g, z, 0, 1, 0, 0.9, c.rng.next() * 6.28, SPR.SPLAT, 0.22, 0.6, 0.05, 0.55, life * 0.45, 0.3);
        }
        break;
      }
      case 'spore_lob': {
        const R = Math.max(1, splash);
        P.begin(SPR.GLOW).at(x, g + 0.4, z).life(0.16).size(2 * R * 0.9, 2 * R * 0.9, 1.3).color(1.0, 1.15, 0.25, 0.75).additive(1).emitExact(1);
        P.begin(SPR.SMOKE).at(x, g + 0.3, z).disc(R * 0.45).radial(1, 2.6).up(0.3, 1.2).drag(2.4).life(0.9, 1.5).size(0.55, 0.8, 2.6, 0.55)
          .color(0.42, 0.45, 0.16, 0.6).alt(0.3, 0.27, 0.12, 0.35).fade(0.08).spin(1).emit(14);
        P.begin(SPR.SPORES).at(x, g + 0.5, z).jitter(R * 0.3).sphere(1, 3).up(0.2, 1).drag(1.8).gravity(-0.5).life(0.8, 1.4).size(0.14, 0.22)
          .color(1.2, 1.4, 0.3, 0.9).wobble(0.18, 3).spin(2).additive(1).emit(22);
        P.begin(SPR.RING, PM_GROUND).at(x, g + 0.07, z).life(0.5).size(0.5, 0.5, (2 * R / 0.8) / 0.5, 0.4).color(0.9, 1.1, 0.25, 0.9).additive(0.9).emitExact(1);
        P.begin(SPR.DEBRIS).at(x, g + 0.1, z).disc(0.3).radial(1.5, 3).up(2.5, 5).gravity(-15).floor(g + 0.04).life(0.6, 1).size(0.08, 0.15)
          .color(0.36, 0.3, 0.16, 1).spin(10).fade(0, 3).emit(6);
        c.decals.add(c.spawnTime, x, g, z, 0, 1, 0, R * 1.8, c.rng.next() * 6.28, SPR.SPLAT, 0.24, 0.27, 0.08, 0.7, life * 0.8, 0.12);
        break;
      }
      case 'toxin_bolt': {
        const big = splash >= 1;
        P.begin(SPR.FLARE).at(x, y, z).life(0.13).size(1.0 * scale, 1.0 * scale, 1.4, 0.5).color(2.2, 0.5, 1.9, 1).additive(1).emitExact(1);
        P.begin(SPR.SPARK, PM_STRETCH).at(x, y, z).sphere(2, 5 * Math.sqrt(scale)).life(0.25, 0.45).size(0.04, 0.06, 0.4).color(2.0, 0.35, 1.6, 1)
          .drag(2).gravity(-3).stretch(0.04).additive(1).emit(12 * scale);
        P.begin(SPR.SMOKE).at(x, y, z).jitter(0.15 * scale).sphere(0.5, 1.4).up(0.3, 0.6).drag(1.8).life(0.6, 1).size(0.3 * scale, 0.45 * scale, 2.8, 0.6)
          .color(0.2, 0.05, 0.2, 0.5).fade(0.1).spin(1.2).emit(6 * scale);
        if (big) {
          P.begin(SPR.RING, PM_GROUND).at(x, g + 0.07, z).life(0.45).size(0.5, 0.5, (2 * splash / 0.8) / 0.5, 0.4).color(1.5, 0.25, 1.3, 0.9).additive(1).emitExact(1);
          P.begin(SPR.GOO).at(x, y, z).jitter(0.2).hemi(2, 4.5).up(1, 2.5).gravity(-12).floor(g + 0.03).life(0.5, 0.8).size(0.1, 0.18, 0.7)
            .color(1.2, 0.2, 1.0, 1).endAlpha(0.5).alt(0.5, 1.4, 0.15, 0.3).additive(0.2).emit(12);
          c.decals.add(c.spawnTime, x, g, z, 0, 1, 0, splash * 1.5, c.rng.next() * 6.28, SPR.SPLAT, 0.35, 0.05, 0.3, 0.6, life * 0.6, 0.3);
        }
        break;
      }
      default: {
        // generic hit (instant weapons routed here by spawnEffect)
        P.begin(SPR.FLARE).at(x, y, z).life(0.1).size(0.6, 0.6, 1.3, 0.5).color(2, 2, 2, 1).additive(1).emitExact(1);
        P.begin(SPR.SPARK, PM_STRETCH).at(x, y, z).hemi(2, 4).life(0.12, 0.28).size(0.03, 0.05, 0.4).color(2.2, 2, 1.6, 1).gravity(-8).stretch(0.04).additive(1).emit(6);
        break;
      }
    }
  }

  /** Public trigger used by VfxSystem.spawnEffect for instant-weapon looks without entities. */
  playInstant(vfx: WeaponVfx, ax: number, ay: number, az: number, bx: number, by: number, bz: number, splash: number): void {
    const c = this.c;
    tmpA.set(ax, ay, az); tmpB.set(bx, by, bz);
    switch (vfx) {
      case 'spray': this.addShot(S_SPRAY, null, null, tmpA, tmpB, 0.32); this.muzzleFlash('spray', ax, ay, az, bx - ax, by - ay, bz - az, 1); break;
      case 'uv_beam': this.addShot(S_UV, null, null, tmpA, tmpB, 0.32); this.uvImpactBurst(bx, by, bz, ax - bx, az - bz); break;
      case 'engulf': this.addShot(S_ENGULF, null, null, tmpA, tmpB, 0.46); break;
      case 'zap': this.addShot(S_ZAP, null, null, tmpA, tmpB, 0.16); this.zapBurst(bx, by, bz); break;
      case 'whip': this.addShot(S_WHIP, null, null, tmpA, tmpB, 0.22); break;
      case 'bite': this.bite(tmpA, tmpB); break;
      case 'slam': this.slam(bx, bz, splash || 1.2, ax - bx, az - bz); break;
      default: {
        const p = this.acquireProj();
        if (!p) return;
        p.vfx = vfx; p.sx = p.x = ax; p.sy = p.y = ay; p.sz = p.z = az; p.ex = bx; p.ey = by; p.ez = bz;
        const arc = vfx === 'antibiotic_capsule' || vfx === 'spore_lob';
        const dist = Math.hypot(bx - ax, bz - az);
        const speed = vfx === 'laser' ? 22 : vfx === 'antibiotic_capsule' ? 9 : vfx === 'spore_lob' ? 8 : vfx === 'acid_spit' ? 11 : 14;
        p.dur = Math.max(0.06, Math.hypot(bx - ax, by - ay, bz - az) / speed);
        p.arc = arc; p.peak = arc ? Math.min(4.5, Math.max(1.2, dist * 0.32)) : 0;
        p.splash = splash || (arc ? 1.9 : 0); p.scale = splash >= 2.4 ? 1.6 : 1; p.t0 = c.spawnTime;
        setDir(p, bx - ax, (by - ay) + (arc ? 1 : 0), bz - az);
        this.attachTrail(p);
        this.muzzleFlash(vfx, ax, ay, az, bx - ax, by - ay, bz - az, p.scale);
      }
    }
  }

  dispose(): void {
    this.shots.length = 0; this.projs.length = 0; this.bySim.clear();
  }
}

// ───────────────────────── helpers ─────────────────────────
function smooth01(x: number): number { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); }
function easeOut(x: number): number { const t = x < 0 ? 0 : x > 1 ? 1 : x; return 1 - (1 - t) * (1 - t) * (1 - t); }

function setDir(p: ProjVis, dx: number, dy: number, dz: number): void {
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-6) return;
  p.dx = dx / l; p.dy = dy / l; p.dz = dz / l;
}

/** Newest-first ribbon sampling: add a point when the head moved ≥ 0.18, otherwise drag the head point. */
function pushTrail(t: Trail, x: number, y: number, z: number, now: number, visible: boolean): void {
  if (!t.attached) return;
  const p = t.pts;
  if (!visible) { t.n = 0; return; }
  if (t.n > 0) {
    const dx = x - p[0]!, dy = y - p[1]!, dz = z - p[2]!;
    if (dx * dx + dy * dy + dz * dz < 0.18 * 0.18 && t.n > 1) { p[0] = x; p[1] = y; p[2] = z; p[3] = now; return; }
  }
  const n = Math.min(t.n, 15);
  p.copyWithin(4, 0, n * 4);
  p[0] = x; p[1] = y; p[2] = z; p[3] = now;
  t.n = n + 1;
}

/** Bigger/heavier weapons get bigger effects (Strain Omega's Plague Torrent ≈ 1.6×). */
function weaponScale(w: WeaponDef): number {
  const bySplash = 1 + Math.max(0, (w.splashRadius ?? 0) - 2) * 0.4;
  const byDamage = 1 + Math.max(0, w.damage - 28) / 20;
  return Math.min(1.8, Math.max(1, bySplash, byDamage));
}
