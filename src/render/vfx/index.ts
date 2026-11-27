/**
 * [vfx] OWNER: VFX agent. Projectiles (reads world.projectiles every frame), instant-hit weapon effects
 * (weaponFired with projectile=null), impacts, deaths, construction/production sparkle, heals, abilities.
 *
 * Contract (used by the render core): `new VfxSystem(opts)`, `update(dt, time, alpha)` once per frame
 * after entity models are placed, `dispose()`. Optional extras: `spawnEffect(kind, pos, opts)` for
 * scripts/sandboxes, `setQuality(q)`, `stats()`, and `VfxOptions.onShake` (camera shake hook for big
 * explosions — wire it to RtsCamera.shake).
 *
 * Architecture (all GPU-friendly, pooled, no per-frame allocations in hot paths):
 *   core.ts       clock (sim-synced), camera/frustum, fog visibility, quality & load throttle, timers, anchors
 *   particles.ts  stateless GPU particles (ring buffer, analytic motion) — one draw call (alpha + additive)
 *   sprites.ts    per-frame billboards (projectile heads, glows) — one draw call
 *   strips.ts     camera-facing strips (beams, arcs, slashes, ribbon trails) — one draw call
 *   decals.ts     fading ground splats/scorches — one draw call
 *   meshes.ts     instanced projectile bodies, UV domes, supply helicopter
 *   weapons.ts / deaths.ts / feedback.ts / abilities.ts   the effect recipes
 */
import * as THREE from 'three';
import type { Entity, EntityId, PlayerId, Vec2, WeaponVfx } from '../../core/types';
import type { World } from '../../sim/World';
import type { EntityModel } from '../models';
import type { Quality } from '../../game/settings';
import { AbilityFx } from './abilities';
import { SPR } from './atlas';
import { VfxCore } from './core';
import { DeathFx } from './deaths';
import { FeedbackFx } from './feedback';
import { WeaponFx } from './weapons';

export { QUALITY_PROFILES } from './core';
export type { QualityProfile } from './core';

export interface VfxOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: World;
  localPlayerId: PlayerId;
  quality: Quality;
  /** live model for an entity (muzzle positions etc.), if it has one */
  getEntityModel: (id: EntityId) => EntityModel | undefined;
  /** terrain height at world (x, y) */
  heightAt: (x: number, y: number) => number;
  /** [vfx] optional: camera shake for big explosions (intensity ≈ world units, seconds) */
  onShake?: (intensity: number, seconds: number) => void;
  /** [vfx] optional: seed for visual variation (deterministic screenshots) */
  seed?: number;
}

/** Effects that can be triggered directly (scripts, cinematics, sandboxes). */
export type VfxEffectKind =
  | WeaponVfx                 // the weapon's look: instant keys play from opts.from to pos, projectile keys fly and impact
  | 'impact'                  // only the impact of opts.weapon at pos
  | 'death_pathogen' | 'death_pathogen_massive' | 'death_machine' | 'death_drone' | 'death_staff'
  | 'death_hospital_building' | 'death_pathogen_building'
  | 'explosion' | 'hit_metal' | 'hit_goo' | 'hit_staff'
  | 'heal' | 'repair' | 'construction_complete' | 'production_complete' | 'delivery'
  | 'uv_flare' | 'emergency_supply' | 'viral_burst' | 'omega_spawn';

export interface SpawnEffectOptions {
  /** height above the ground at pos (default depends on the effect) */
  height?: number;
  /** size multiplier (unit deaths ≈ radius / 0.42) */
  scale?: number;
  /** owner for team-coloured effects (default: local player) */
  owner?: PlayerId;
  /** source point for weapon looks (default: 4 tiles west of pos) */
  from?: Vec2;
  /** source height above ground for weapon looks (default 0.8) */
  fromHeight?: number;
  /** weapon key for 'impact' */
  weapon?: WeaponVfx;
  /** splash / ability radius */
  radius?: number;
  /** footprint for building deaths (default 3×3) */
  footprint?: { w: number; h: number };
  /** show even where the local player has no vision (scripted cinematics) */
  ignoreFog?: boolean;
}

export interface VfxStats {
  particlesAlive: number;
  particleCapacity: number;
  pressure: number;
  strips: number;
  sprites: number;
  decals: number;
  projectiles: number;
  shots: number;
  emitters: number;
  helicopters: number;
}

const WEAPON_KEYS: ReadonlySet<string> = new Set<WeaponVfx>(['spray', 'uv_beam', 'antibiotic_capsule', 'laser', 'engulf', 'zap', 'acid_spit', 'spore_lob', 'toxin_bolt', 'bite', 'whip', 'slam']);

const tmpV = new THREE.Vector3();

export class VfxSystem {
  private readonly core: VfxCore;
  private readonly weapons: WeaponFx;
  private readonly deaths: DeathFx;
  private readonly feedback: FeedbackFx;
  private readonly abilities: AbilityFx;
  private readonly unsub: Array<() => void> = [];
  private errors = 0;
  private disposed = false;

  constructor(private readonly opts: VfxOptions) {
    this.core = new VfxCore({
      scene: opts.scene, camera: opts.camera, world: opts.world, localPlayerId: opts.localPlayerId, quality: opts.quality,
      getEntityModel: opts.getEntityModel, heightAt: opts.heightAt, seed: opts.seed,
    });
    this.weapons = new WeaponFx(this.core);
    this.deaths = new DeathFx(this.core);
    this.feedback = new FeedbackFx(this.core, this.weapons);
    this.abilities = new AbilityFx(this.core, this.weapons);
    const ev = opts.world.events;
    this.unsub.push(
      ev.on('weaponFired', (e) => this.guard(this.weapons.onFired, e)),
      ev.on('projectileImpact', (e) => this.guard(this.weapons.onImpact, e)),
      ev.on('entityDied', (e) => this.guard(this.onDied, e.entity)),
      ev.on('entityDamaged', (e) => this.guard(this.feedback.onDamaged, e)),
      ev.on('entityHealed', (e) => this.guard(this.feedback.onHealed, e)),
      ev.on('abilityUsed', (e) => this.guard(this.abilities.onUsed, e)),
      ev.on('constructionStarted', (e) => this.guard(this.feedback.onConstructionStarted, e)),
      ev.on('constructionComplete', (e) => this.guard(this.feedback.onConstructionComplete, e)),
      ev.on('productionComplete', (e) => this.guard(this.feedback.onProductionComplete, e)),
      ev.on('resourceDelivered', (e) => this.guard(this.feedback.onDelivered, e)),
      ev.on('entityRemoved', (e) => this.guard(this.onRemoved, e.entity)),
    );
  }

  /** Called every frame. alpha = interpolation factor between the previous and current sim tick. */
  update(_dt: number, _time: number, alpha: number): void {
    if (this.disposed) return;
    try {
      this.core.beginFrame(alpha);
      this.weapons.update();
      this.abilities.update();
      this.feedback.update();
      this.core.endFrame();
    } catch (err) {
      if (this.errors++ < 3) console.error('[vfx] update failed', err);
    }
  }

  /** Switch emission/hit budgets for a new quality tier (pool capacities stay as allocated). */
  setQuality(q: Quality): void { this.core.setQuality(q); }

  /** Debug counters (particle count is O(capacity) — don't call every frame in production). */
  stats(): VfxStats {
    const c = this.core;
    return {
      particlesAlive: c.particles.countAlive(), particleCapacity: c.particles.capacity, pressure: c.pressure,
      strips: c.strips.count, sprites: c.sprites.count, decals: c.decals.liveSlots,
      projectiles: this.weapons.activeProjectiles, shots: this.weapons.activeShots,
      emitters: this.feedback.trackedCount, helicopters: this.abilities.activeHelis,
    };
  }

  /**
   * Trigger an effect directly at a ground position (world x/y). Visual only — never touches the sim.
   * Weapon keys play the full weapon look from `opts.from` (default 4 tiles west) to `pos`.
   */
  spawnEffect(kind: VfxEffectKind, pos: Vec2, opts: SpawnEffectOptions = {}): void {
    if (this.disposed) return;
    const c = this.core;
    c.fogOverride = !!opts.ignoreFog;
    c.stampEvent();
    try {
      const x = pos.x, z = pos.y, g = c.heightAt(x, z);
      const s = opts.scale ?? 1;
      const owner = opts.owner ?? c.local;
      const y = g + (opts.height ?? 0.6);
      if (WEAPON_KEYS.has(kind)) {
        const from = opts.from ?? { x: x - 4, y: z };
        const fy = c.heightAt(from.x, from.y) + (opts.fromHeight ?? 0.8);
        this.weapons.playInstant(kind as WeaponVfx, from.x, fy, from.y, x, y, z, opts.radius ?? 0);
        return;
      }
      switch (kind) {
        case 'impact': this.weapons.impact(opts.weapon ?? 'laser', x, y, z, 1, 0, opts.radius ?? 0, s, null); break;
        case 'death_pathogen': this.deaths.gooDeath(null, x, y, z, s, false, false, owner); break;
        case 'death_pathogen_massive': this.deaths.gooDeath(null, x, y, z, Math.max(2, s), true, false, owner); break;
        case 'death_machine': this.deaths.machineDeath(null, x, y, z, s, false); break;
        case 'death_drone': this.deaths.machineDeath(null, x, g + (opts.height ?? 3.2), z, s, true); break;
        case 'death_staff': this.deaths.evac(null, x, g, z, opts.height ?? 1.2, s); break;
        case 'death_hospital_building': case 'death_pathogen_building': {
          const fp = opts.footprint ?? { w: 3, h: 3 };
          const h = opts.height ?? 1 + Math.min(fp.w, fp.h) * 0.45;
          if (kind === 'death_hospital_building') this.deaths.collapse(owner, x, g, z, fp.w, fp.h, h);
          else this.deaths.gooEruption(owner, x, g, z, fp.w, fp.h, h);
          this.shake(x, g, z, 0.35 + Math.max(fp.w, fp.h) * 0.06, 0.45);
          break;
        }
        case 'explosion': this.deaths.explosion(x, y, z, s, false); break;
        case 'hit_metal': this.feedback.hitSparksOf('metal', owner, x, y, z, -1, 0, s, false); break;
        case 'hit_goo': this.feedback.hitSparksOf('goo', owner, x, y, z, -1, 0, s, false); break;
        case 'hit_staff': this.feedback.hitSparksOf('staff', owner, x, y, z, -1, 0, s, false); break;
        case 'heal': this.feedback.healPlus(x, g + (opts.height ?? 1.0), z, 0.4 * s); break;
        case 'repair': this.feedback.repairSparks(x, y, z, -1, 0); break;
        case 'construction_complete':
          this.feedback.completeFlash(owner, x, g, z, (opts.footprint?.w ?? 3) * s, opts.height ?? 2.2, c.world.players.get(owner)?.faction !== 'pathogen');
          break;
        case 'production_complete':
          this.feedback.completeFlash(owner, x, g, z, 1.2 * s, opts.height ?? 1.2, c.world.players.get(owner)?.faction !== 'pathogen');
          break;
        case 'delivery':
          c.particles.begin(SPR.PLUS).at(x, g + (opts.height ?? 1.4), z).vel(0, 0.9, 0).drag(0.8).life(0.75).size(0.3, 0.3, 0.8).rot(0)
            .color(0.8, 2.2, 1.9, 1).fade(0.1, 1.5).additive(0.85).emitExact(1);
          break;
        case 'uv_flare': this.abilities.uvFlare(x, z, opts.radius ?? 2.5); break;
        case 'emergency_supply': this.abilities.emergencySupplyAt(x, z, owner); break;
        case 'viral_burst': this.abilities.viralBurst(x, g + (opts.height ?? 0.35), z, opts.radius ?? 1.3); break;
        case 'omega_spawn': this.abilities.omegaSpawnAt(x, g, z, opts.radius ?? 2, opts.height ?? 3.2, owner); break;
        default: break;
      }
    } catch (err) {
      if (this.errors++ < 3) console.error('[vfx] spawnEffect failed', kind, err);
    } finally {
      c.fogOverride = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    this.abilities.dispose();
    this.feedback.dispose();
    this.weapons.dispose();
    this.core.dispose();
  }

  // ───────────────────────── internals ─────────────────────────
  private guard<T>(fn: (e: T) => void, e: T): void {
    if (this.disposed) return;
    try { fn(e); } catch (err) { if (this.errors++ < 3) console.error('[vfx] event handler failed', err); }
  }

  private onDied = (e: Entity): void => {
    this.deaths.onDied(e);
    this.abilities.onDied(e);
    if (e.kind === 'building' || e.tags.has('massive')) {
      const c = this.core;
      const b = c.entityBase(e, tmpV);
      if (c.fogVisible(b.x, b.z) || e.owner === c.local) {
        const big = e.def.kind === 'building' ? Math.max(e.def.footprint.w, e.def.footprint.h) : e.radius * 2;
        this.shake(b.x, b.y, b.z, 0.25 + big * 0.07, e.kind === 'building' ? 0.5 : 0.35);
      }
    }
  };

  private onRemoved = (e: Entity): void => {
    this.weapons.onEntityRemoved(e);
    this.feedback.onEntityRemoved(e);
    this.abilities.onEntityRemoved(e);
  };

  /** Shake scaled by proximity to the camera. */
  private shake(x: number, y: number, z: number, intensity: number, seconds: number): void {
    const fn = this.opts.onShake;
    if (!fn) return;
    const c = this.core;
    if (!c.onScreen(x, y, z, 2)) return;
    const d = c.camPos.distanceTo(tmpV.set(x, y, z));
    const k = Math.max(0, 1 - Math.max(0, d - 25) / 40);
    if (k > 0.05) fn(intensity * k, seconds);
  }
}
