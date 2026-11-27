/**
 * [vfx] Ability effects (abilityUsed):
 *  - uv_flare: lance from the caster, expanding violet-white sterilisation dome, flash, ground rings,
 *    UV sparkles and a short-lived ground glow;
 *  - emergency_supply: a white/teal medical helicopter crosses over the HQ and drops a parachuting
 *    supply crate that lands with a teal flash, ring, dust and a "+" pop;
 *  - viral_burst (passive, on Phage death): green toxic burst + ring + gas (deduplicated whether combat
 *    reports it via abilityUsed or not — we also trigger it from entityDied);
 *  - omega_spawn: Strain Omega's pustules erupt (staggered) as it sheds Phages.
 */
import * as THREE from 'three';
import type { Entity, EntityId, GameEvents, UnitDef } from '../../core/types';
import { ABILITY_DEFS } from '../../data';
import { SPR } from './atlas';
import type { VfxCore } from './core';
import type { Dome, CrateRig, HeliRig } from './meshes';
import { HeliParts } from './meshes';
import { PM_GROUND, PM_STRETCH } from './particles';
import type { WeaponFx } from './weapons';

export const T_PUSTULE = 20;

interface HeliRun {
  rig: HeliRig;
  crate: CrateRig;
  active: boolean;
  t0: number;
  hx: number; hz: number; hg: number;
  dx: number; dz: number;
  dropped: boolean;
  landed: boolean;
  landT: number;
  crateX: number; crateZ: number;
  /** caster's owner: the local player's own aircraft is always shown (like own units) */
  owner: number;
}

const HELI_SPEED = 11;
const HELI_HALF_PATH = 26;
const HELI_ALT = 7.5;
const CRATE_FALL = 1.7;

const tmpA = new THREE.Vector3();
const col = new THREE.Color();

export class AbilityFx {
  private heliParts: HeliParts | null = null;
  private helis: HeliRun[] = [];
  private recentBursts = new Map<EntityId, number>();
  private domeR = new Map<Dome, number>();

  constructor(private readonly c: VfxCore, private readonly weapons: WeaponFx) {
    c.registerTimer(T_PUSTULE, (x, y, z, s, aux) => this.pustule(x, y, z, s, aux));
  }

  onUsed = (ev: GameEvents['abilityUsed']): void => {
    const c = this.c;
    c.stampEvent();
    const src = ev.source;
    switch (ev.abilityId) {
      case 'uv_flare': {
        const tp = ev.target ?? ev.targetEntity?.pos ?? src.pos;
        const r = ABILITY_DEFS.uv_flare?.radius ?? 2.5;
        const g = c.heightAt(tp.x, tp.y);
        if (!c.fogVisible(tp.x, tp.y) && src.owner !== c.local) return;
        this.weapons.spawnLance(src, tp.x, g + 0.4, tp.y);
        this.uvFlare(tp.x, tp.y, r);
        break;
      }
      case 'emergency_supply': this.emergencySupply(src); break;
      case 'viral_burst': {
        const p = ev.target ?? src.pos;
        this.viralBurstOnce(src, p.x, p.y);
        break;
      }
      case 'omega_spawn': this.omegaSpawn(src); break;
      default: {
        // unknown/new ability: a neutral readable cast flash at the caster
        const b = c.entityCenter(src, tmpA);
        if (c.canSee(b.x, b.y, b.z, 2)) c.particles.begin(SPR.FLARE).at(b.x, b.y, b.z).life(0.2).size(1.2, 1.2, 1.5, 0.5).color(2, 2, 2.2, 1).additive(1).emitExact(1);
      }
    }
  };

  /** Passive bursts on death (entityDied) — only if combat didn't already report it. */
  onDied(e: Entity): void {
    if (e.kind !== 'unit') return;
    const abilities = (e.def as UnitDef).abilities;
    if (!abilities || !abilities.includes('viral_burst')) return;
    this.viralBurstOnce(e, e.pos.x, e.pos.y);
  }

  private viralBurstOnce(src: Entity, x: number, z: number): void {
    const c = this.c;
    const last = this.recentBursts.get(src.id);
    if (last !== undefined && c.world.time - last < 1) return;
    this.recentBursts.set(src.id, c.world.time);
    if (this.recentBursts.size > 256) {
      for (const [id, t] of this.recentBursts) if (c.world.time - t > 2) this.recentBursts.delete(id);
    }
    const g = c.heightAt(x, z);
    const y = g + c.flyHeight(src) + 0.35;
    if (!c.canSee(x, y, z, 2)) return;
    this.viralBurst(x, y, z, ABILITY_DEFS.viral_burst?.radius ?? 1.3);
  }

  onEntityRemoved(e: Entity): void { if (this.recentBursts.has(e.id) && this.c.world.time - (this.recentBursts.get(e.id) ?? 0) > 1.5) this.recentBursts.delete(e.id); }

  // ───────────────────────── effects ─────────────────────────
  uvFlare(x: number, z: number, R: number): void {
    const c = this.c, P = c.particles;
    const g = c.heightAt(x, z);
    if (!c.canSee(x, g + 1, z, R + 1)) return;
    const d = c.domes.acquire();
    d.active = true; d.t0 = c.now; d.dur = 0.75; d.radius = R;
    d.mesh.position.set(x, g, z);
    (d.mat.uniforms.uColor!.value as THREE.Vector3).set(0.9, 0.45, 2.2);
    this.domeR.set(d, R);
    P.begin(SPR.FLARE).at(x, g + 1, z).life(0.14).size(R * 1.5, R * 1.5, 1.3, 0.5).color(1.7, 1.3, 2.6, 1).additive(1).emitExact(1);
    P.begin(SPR.GLOW).at(x, g + 0.8, z).life(0.3).size(R * 2.2, R * 2.2, 1.1).color(0.7, 0.3, 1.8, 0.4).additive(1).emitExact(1);
    P.begin(SPR.SHOCK, PM_GROUND).at(x, g + 0.08, z).life(0.55).size(0.6, 0.6, ((2 * R) / 0.9) / 0.6, 0.4).color(1.0, 0.55, 2.4, 0.95).additive(0.85).emitExact(1);
    P.begin(SPR.RING, PM_GROUND).at(x, g + 0.1, z).life(0.32).size(0.5, 0.5, ((2 * R) / 0.8) / 0.5, 0.35).color(2.4, 2.1, 3.2, 1).additive(1).emitExact(1);
    P.begin(SPR.SPARKLE).at(x, g + 0.3, z).disc(R * 0.95).up(0.6, 2.8).drag(1).life(0.6, 1.1).size(0.1, 0.18, 0.3).color(1.8, 1.4, 3.2, 1).additive(1).emit(30);
    P.begin(SPR.SPARK, PM_STRETCH).at(x, g + 0.9, z).sphere(3, 7).up(0, 2).drag(1.5).gravity(-3).life(0.3, 0.6).size(0.045, 0.065, 0.4)
      .color(1.6, 1.0, 3.0, 1).stretch(0.04).additive(1).emit(24);
    c.decals.add(c.spawnTime, x, g, z, 0, 1, 0, R * 2.3, 0, SPR.GLOW, 0.6, 0.3, 1.5, 0.6, 2.2, 1, 0.9, 0.8);
  }

  viralBurst(x: number, y: number, z: number, R: number): void {
    const c = this.c, P = c.particles;
    const g = c.heightAt(x, z);
    P.begin(SPR.GLOW).at(x, y, z).life(0.2).size(R * 1.8, R * 1.8, 1.3).color(0.7, 2.2, 0.25, 0.85).additive(1).emitExact(1);
    P.begin(SPR.RING, PM_GROUND).at(x, g + 0.08, z).life(0.38).size(0.4, 0.4, ((2 * R) / 0.8) / 0.4, 0.4).color(0.6, 2.2, 0.2, 1).additive(1).emitExact(1);
    P.begin(SPR.DROPLET).at(x, y, z).jitter(0.1).sphere(2, 4.2).up(0.5, 1.5).gravity(-7).floor(g + 0.02).life(0.35, 0.6).size(0.05, 0.08)
      .color(0.5, 1.6, 0.12, 1).additive(0.4).emit(18);
    P.begin(SPR.SMOKE).at(x, y, z).jitter(0.2).sphere(1, 2.2).drag(2.5).life(0.6, 1.0).size(0.35, 0.5, 2.6, 0.6).color(0.32, 0.62, 0.1, 0.42).fade(0.1).spin(1).emit(8);
    P.begin(SPR.SPARKLE).at(x, y, z).jitter(R * 0.5).sphere(0.3, 1).up(0.3, 0.9).drag(1).life(0.5, 0.9).size(0.1, 0.15).color(0.8, 2.4, 0.3, 1).additive(1).emit(8);
  }

  omegaSpawn(src: Entity): void {
    const b = this.c.entityBase(src, tmpA);
    this.omegaSpawnAt(b.x, b.y, b.z, src.radius, this.c.modelHeight(src), src.owner);
  }

  /** Pustule eruption around a body of radius r and height h standing at (x, gy, z). */
  omegaSpawnAt(x0: number, gy: number, z0: number, r: number, h: number, owner: number): void {
    const c = this.c;
    if (!c.canSee(x0, gy + h * 0.5, z0, r + 2)) return;
    for (let i = 0; i < 4; i++) {
      const a = c.rng.next() * Math.PI * 2;
      const x = x0 + Math.cos(a) * r * 0.75, z = z0 + Math.sin(a) * r * 0.75, y = gy + h * (0.35 + c.rng.next() * 0.4);
      c.schedule(c.now + i * 0.16, T_PUSTULE, x, y, z, 1 + c.rng.next() * 0.4, owner);
    }
    // a heave of the whole colony
    c.playerColor(owner, col);
    c.particles.begin(SPR.SHOCK, PM_GROUND).at(x0, gy + 0.08, z0).life(0.6).size(r, r, 3.2, 0.45).color(col.r * 1.5, col.g * 1.5, col.b * 1.5, 0.8).additive(0.6).emitExact(1);
  }

  private pustule(x: number, y: number, z: number, s: number, owner: number): void {
    const c = this.c, P = c.particles;
    if (!c.canSee(x, y, z, 2)) return;
    c.playerColor(owner, col);
    const r = col.r * 1.6, g = col.g * 1.6, b = col.b * 1.6;
    const gy = c.heightAt(x, z);
    P.begin(SPR.FLARE).at(x, y, z).life(0.14).size(1.3 * s, 1.3 * s, 1.4, 0.5).color(r * 1.2, g * 1.2 + 0.4, b * 1.2, 1).additive(1).emitExact(1);
    P.begin(SPR.GOO).at(x, y, z).jitter(0.15).hemi(1.5, 3.5).up(2.5, 5.5).gravity(-13).floor(gy + 0.04).drag(0.5).life(0.8, 1.2).size(0.14, 0.26, 0.7)
      .color(r, g, b, 1).endAlpha(0.55).alt(0.45, 1.35, 0.1, 0.45).fade(0, 3).spin(4).additive(0.15).emit(14 * s);
    P.begin(SPR.SMOKE).at(x, y, z).jitter(0.2).sphere(0.4, 1.2).up(0.4, 1).drag(1.5).life(0.8, 1.3).size(0.4 * s, 0.6 * s, 2.4).color(col.r * 0.3, col.g * 0.25 + 0.08, col.b * 0.3, 0.45).fade(0.1).spin(0.8).emit(5);
    P.begin(SPR.RING).at(x, y, z).life(0.22).size(0.4 * s, 0.4 * s, 4, 0.45).color(r, g, b, 0.9).additive(1).emitExact(1);
    const a = c.rng.next() * Math.PI * 2, d = 0.8 + c.rng.next() * 1.4;
    const sx = x + Math.cos(a) * d, sz = z + Math.sin(a) * d;
    if (c.fogVisible(sx, sz)) {
      c.decals.add(c.spawnTime + 0.5, sx, c.heightAt(sx, sz), sz, 0, 1, 0, 1.1 * s, c.rng.next() * 6.28, SPR.SPLAT, col.r * 0.55, col.g * 0.5 + 0.05, col.b * 0.55, 0.75, c.q.decalLife, 0.3);
    }
  }

  emergencySupply(hq: Entity): void { this.emergencySupplyAt(hq.pos.x, hq.pos.y, hq.owner); }

  /** Helicopter pass + parachute crate drop over (hx, hz). */
  emergencySupplyAt(hx: number, hz: number, owner: number): void {
    const c = this.c;
    if (!c.fogVisible(hx, hz) && owner !== c.local) return;
    if (!this.heliParts) {
      c.playerColor(owner, col);
      this.heliParts = new HeliParts(col.clone());
    }
    let run: HeliRun | undefined = this.helis.find((h) => !h.active);
    if (!run) {
      if (this.helis.length >= 2) run = this.helis.reduce((a, b) => (a.t0 < b.t0 ? a : b));
      else {
        run = { rig: this.heliParts.buildHeli(), crate: this.heliParts.buildCrate(), active: false, t0: 0, hx: 0, hz: 0, hg: 0, dx: 1, dz: 0, dropped: false, landed: false, landT: 0, crateX: 0, crateZ: 0, owner };
        c.group.add(run.rig.root, run.crate.root);
        this.helis.push(run);
      }
    }
    // approach from the map edge behind the HQ (away from the map centre), fly on toward the centre
    const map = c.world.map;
    let dx = hx - map.width / 2, dz = hz - map.height / 2;
    const l = Math.hypot(dx, dz);
    if (l < 1e-3) { dx = 1; dz = 0; } else { dx /= l; dz /= l; }
    run.active = true; run.t0 = c.now; run.hx = hx; run.hz = hz; run.hg = c.heightAt(hx, hz); run.owner = owner;
    run.dx = -dx; run.dz = -dz; // travel direction
    run.dropped = false; run.landed = false; run.landT = 0;
    run.rig.root.visible = false; run.crate.root.visible = false;
  }

  // ───────────────────────── per frame ─────────────────────────
  update(): void {
    const c = this.c;
    c.stampFrame();
    for (const d of c.domes.domes) {
      if (!d.active) continue;
      const k = (c.now - d.t0) / d.dur;
      if (k >= 1 || k < 0) { d.active = false; d.mesh.visible = false; continue; }
      const R = this.domeR.get(d) ?? d.radius;
      const s = R * (1 - (1 - k) ** 3);
      d.mesh.scale.set(s, s * 0.9, s);
      d.mesh.visible = c.fogVisible(d.mesh.position.x, d.mesh.position.z);
      d.mat.uniforms.uAlpha!.value = (1 - k) ** 1.4 * 0.85;
      d.mat.uniforms.uTime!.value = c.now;
    }
    for (const h of this.helis) if (h.active) this.updateHeli(h);
  }

  private updateHeli(h: HeliRun): void {
    const c = this.c, P = c.particles;
    const t = c.now - h.t0;
    const total = (HELI_HALF_PATH * 2) / HELI_SPEED;
    const tMid = HELI_HALF_PATH / HELI_SPEED;
    const along = -HELI_HALF_PATH + t * HELI_SPEED; // distance past the HQ
    const rig = h.rig.root;
    if (t <= total) {
      const x = h.hx + h.dx * along, z = h.hz + h.dz * along;
      const dip = Math.exp(-((along / 9) ** 2)) * 1.2; // dips a little over the drop zone
      const y = h.hg + HELI_ALT - dip;
      rig.position.set(x, y, z);
      rig.rotation.set(0, -Math.atan2(h.dz, h.dx), 0);
      rig.rotateZ(-0.12 + dip * 0.08); // nose-down cruise, flaring over the drop
      rig.rotateX(Math.sin(t * 1.3) * 0.04);
      h.rig.rotor.rotation.y += c.fdt * 42;
      h.rig.tailRotor.rotation.z += c.fdt * 60;
      const vis = h.owner === c.local || c.fogVisible(x, z);
      rig.visible = vis;
      if (vis && c.onScreen(x, y, z, 3)) {
        // nav lights + strobe
        const blink = Math.sin(c.now * 6) > 0.2 ? 1 : 0.15;
        const cs = Math.cos(-Math.atan2(h.dz, h.dx)), sn = Math.sin(-Math.atan2(h.dz, h.dx));
        const sideX = sn, sideZ = cs; // local +Z in world
        c.sprites.add(x + sideX * 0.45, y - 0.05, z + sideZ * 0.45, 0.35, SPR.GLOW, 0.3, 2.4, 0.4, 0.9 * blink);
        c.sprites.add(x - sideX * 0.45, y - 0.05, z - sideZ * 0.45, 0.35, SPR.GLOW, 2.6, 0.3, 0.25, 0.9 * blink);
        if (Math.sin(c.now * 9) > 0.85) c.sprites.add(x - h.dx * 1.9, y + 0.4, z - h.dz * 1.9, 0.6, SPR.FLARE, 3, 3, 3, 1);
        c.sprites.add(x + h.dx * 0.9, y - 0.2, z + h.dz * 0.9, 0.5, SPR.GLOW, 1.8, 1.8, 1.6, 0.35); // searchlight glow
      }
    } else {
      rig.visible = false;
    }
    // the crate
    const crate = h.crate.root;
    if (!h.dropped && t >= tMid) {
      h.dropped = true;
      h.crateX = h.hx + h.dx * 0.4; h.crateZ = h.hz + h.dz * 0.4;
    }
    if (h.dropped) {
      const ft = t - tMid;
      const startY = h.hg + HELI_ALT - 1.6, endY = c.heightAt(h.crateX, h.crateZ) + 0.24;
      const k = Math.min(1, ft / CRATE_FALL);
      const fall = 0.7 * k + 0.3 * k * k * (3 - 2 * k); // chute opens at once: near-constant descent
      crate.position.set(h.crateX + Math.sin(ft * 2.2) * 0.25 * (1 - k), startY + (endY - startY) * fall, h.crateZ + Math.cos(ft * 1.7) * 0.2 * (1 - k));
      crate.rotation.set(Math.sin(ft * 2.2) * 0.12 * (1 - k), ft * 0.6, Math.cos(ft * 1.9) * 0.1 * (1 - k));
      h.crate.chute.visible = k < 1;
      h.crate.chute.scale.setScalar(Math.min(1, ft / 0.25));
      crate.visible = h.owner === c.local || c.fogVisible(h.crateX, h.crateZ);
      if (k >= 1 && !h.landed) {
        h.landed = true; h.landT = c.now;
        if (crate.visible) {
          const gy = endY - 0.24;
          P.begin(SPR.FLARE).at(h.crateX, gy + 0.5, h.crateZ).life(0.2).size(2.2, 2.2, 1.3, 0.5).color(1.2, 2.8, 2.5, 1).additive(1).emitExact(1);
          P.begin(SPR.RING, PM_GROUND).at(h.crateX, gy + 0.08, h.crateZ).life(0.6).size(0.6, 0.6, 7, 0.4).color(0.4, 2.2, 1.9, 1).additive(1).emitExact(1);
          P.begin(SPR.SMOKE).at(h.crateX, gy + 0.2, h.crateZ).disc(0.5).radial(1.2, 2.6).up(0.1, 0.5).drag(2.4).life(0.7, 1.1).size(0.4, 0.55, 2.4)
            .color(0.6, 0.6, 0.58, 0.45).fade(0.1).spin(0.6).emit(12);
          P.begin(SPR.PLUS).at(h.crateX, gy + 1.2, h.crateZ).vel(0, 1.2, 0).drag(0.8).life(1.2).size(0.75, 0.75, 1).rot(0).color(1.0, 2.6, 2.3, 1).fade(0.1, 1.6).additive(0.9).emitExact(1);
          P.begin(SPR.SPARKLE).at(h.crateX, gy + 0.6, h.crateZ).jitter(0.7).up(0.5, 1.5).drag(0.8).life(0.6, 1.1).size(0.12, 0.2).color(1.2, 2.6, 2.3, 1).additive(1).emit(14);
        }
      }
      if (h.landed) {
        const since = c.now - h.landT;
        crate.scale.setScalar(Math.max(0.01, 1 - Math.max(0, since - 1.4) / 0.4));
        if (since > 1.8) crate.visible = false;
      } else crate.scale.setScalar(1);
    }
    if (t > total && (!h.dropped || (h.landed && c.now - h.landT > 1.8))) {
      h.active = false; rig.visible = false; crate.visible = false;
    }
  }

  get activeHelis(): number { let n = 0; for (const h of this.helis) if (h.active) n++; return n; }

  dispose(): void {
    for (const h of this.helis) { h.rig.root.removeFromParent(); h.crate.root.removeFromParent(); }
    this.helis.length = 0;
    this.heliParts?.dispose();
    this.heliParts = null;
    this.recentBursts.clear();
    this.domeR.clear();
  }
}
