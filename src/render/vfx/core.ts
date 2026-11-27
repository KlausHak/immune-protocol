/**
 * [vfx] VfxCore — shared state for all effect modules: the GPU pools, the sim-synced clock, camera &
 * frustum, fog-of-war visibility, quality profile + load throttle, a pooled timer queue, and entity
 * anchor helpers (interpolated position, muzzle point, surface hit point).
 *
 * CLOCK: effects run on *simulation* time, interpolated exactly like the render core interpolates
 * entities: now = world.time − dt·(1 − alpha). Events (fired inside world.step at world.time) are
 * stamped with world.time, so multi-tick frames, pause (frozen effects) and game speed all stay in
 * sync with the units on screen, and sandbox screenshots are deterministic.
 */
import * as THREE from 'three';
import { DEFAULT_FLY_HEIGHT } from '../../config';
import type { BuildingDef, Entity, EntityId, PlayerId, ResourceNodeDef, UnitDef, Vec2 } from '../../core/types';
import type { Quality } from '../../game/settings';
import type { World } from '../../sim/World';
import type { EntityModel } from '../models';
import { createSpriteAtlas } from './atlas';
import { DecalPool } from './decals';
import { DomePool, ProjectileMeshes } from './meshes';
import { ParticlePool } from './particles';
import { VfxRng } from './rng';
import { SpriteBatch } from './sprites';
import { StripBatch } from './strips';

export interface QualityProfile {
  particles: number;
  strips: number;
  sprites: number;
  decals: number;
  projMeshes: number;
  /** emission multiplier applied to every non-essential burst */
  emission: number;
  /** ground decal lifetime (s) */
  decalLife: number;
  /** persistent building smoke at < 50 % hp (fire at < 25 % is always on) */
  lightDamageSmoke: boolean;
  /** max hit-spark bursts per frame (entityDamaged) */
  hitBudget: number;
}

export const QUALITY_PROFILES: Record<Quality, QualityProfile> = {
  high: { particles: 10000, strips: 224, sprites: 1280, decals: 160, projMeshes: 192, emission: 0.9, decalLife: 20, lightDamageSmoke: true, hitBudget: 48 },
  medium: { particles: 5000, strips: 160, sprites: 896, decals: 96, projMeshes: 128, emission: 0.6, decalLife: 16, lightDamageSmoke: true, hitBudget: 28 },
  low: { particles: 2500, strips: 96, sprites: 512, decals: 48, projMeshes: 96, emission: 0.35, decalLife: 12, lightDamageSmoke: false, hitBudget: 14 },
};

export interface CoreOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: World;
  localPlayerId: PlayerId;
  quality: Quality;
  getEntityModel: (id: EntityId) => EntityModel | undefined;
  heightAt: (x: number, y: number) => number;
  seed?: number;
}

/** Timer handler: (x, y, z, scale, aux, ref) — no closures allocated per scheduled call. */
export type TimerFn = (x: number, y: number, z: number, s: number, aux: number, ref: Entity | null) => void;

const TIMER_CAP = 384;

export class VfxCore {
  readonly world: World;
  readonly local: PlayerId;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly group = new THREE.Group();
  readonly rng: VfxRng;
  readonly atlas: THREE.DataTexture;
  readonly particles: ParticlePool;
  readonly sprites: SpriteBatch;
  readonly strips: StripBatch;
  readonly decals: DecalPool;
  readonly meshes: ProjectileMeshes;
  readonly domes: DomePool;
  q: QualityProfile;
  quality: Quality;

  /** sim-synced render time (s) and the delta since the previous frame */
  now = 0;
  fdt = 0;
  alpha = 1;
  frame = 0;
  /** load throttle 0.3..1 (drops when the particle pool overwrites live particles) */
  pressure = 1;
  /** remaining entityDamaged spark bursts this frame */
  hitBudget = 0;
  /** true while a scripted spawnEffect({ ignoreFog }) runs: fog checks pass */
  fogOverride = false;
  readonly camPos = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly v2: Vec2 = { x: 0, y: 0 };
  private decalSweepAt = 0;

  // timers (struct of arrays)
  private readonly tAt = new Float64Array(TIMER_CAP);
  private readonly tKind = new Int32Array(TIMER_CAP);
  private readonly tNum = new Float32Array(TIMER_CAP * 5);
  private readonly tRef: Array<Entity | null> = new Array<Entity | null>(TIMER_CAP).fill(null);
  private tCount = 0;
  private readonly timerFns: TimerFn[] = [];

  readonly getModel: (id: EntityId) => EntityModel | undefined;
  readonly heightAt: (x: number, y: number) => number;

  constructor(opts: CoreOptions) {
    this.world = opts.world;
    this.local = opts.localPlayerId;
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.getModel = opts.getEntityModel;
    this.heightAt = opts.heightAt;
    this.quality = opts.quality;
    this.q = QUALITY_PROFILES[opts.quality] ?? QUALITY_PROFILES.high;
    this.rng = new VfxRng(opts.seed ?? 0x51f15e);
    this.atlas = createSpriteAtlas();
    this.particles = new ParticlePool(this.q.particles, this.atlas, this.rng);
    this.sprites = new SpriteBatch(this.q.sprites, this.atlas);
    this.strips = new StripBatch(this.q.strips);
    this.decals = new DecalPool(this.q.decals, this.atlas);
    this.meshes = new ProjectileMeshes(this.q.projMeshes);
    this.domes = new DomePool(4);
    this.group.name = 'vfx';
    this.group.add(this.decals.mesh, this.meshes.group, this.domes.group, this.particles.mesh, this.strips.mesh, this.sprites.mesh);
    this.scene.add(this.group);
    this.now = this.world.time;
    this.updateCamera();
  }

  /** Soft quality change: emission/hit budgets switch immediately; pool capacities stay as allocated. */
  setQuality(q: Quality): void {
    this.quality = q;
    const p = QUALITY_PROFILES[q] ?? QUALITY_PROFILES.high;
    this.q = { ...p, particles: this.particles.capacity, strips: this.strips.slots, sprites: this.sprites.capacity, decals: this.decals.capacity, projMeshes: this.meshes.capacity };
  }

  // ───────────────────────── frame ─────────────────────────
  beginFrame(alpha: number): void {
    const w = this.world;
    this.alpha = Math.min(1, Math.max(0, alpha));
    const t = w.time - w.dt * (1 - this.alpha);
    const now = Math.max(this.now, t);
    this.fdt = Math.min(0.25, now - this.now);
    this.now = now;
    this.frame++;
    this.updateCamera();
    // load throttle: live overwrites last frame → back off; recover over ~2 s
    if (this.particles.overwrites > 0) this.pressure = Math.max(0.3, this.pressure * 0.85);
    else this.pressure = Math.min(1, this.pressure + this.fdt * 0.4);
    this.particles.beginFrame(now);
    this.particles.mul = this.q.emission * this.pressure;
    this.particles.t0 = now;
    this.hitBudget = this.q.hitBudget;
    this.sprites.begin();
    this.strips.begin(this.camera, now);
    this.meshes.begin(now);
    this.runTimers();
  }

  endFrame(): void {
    if (this.now >= this.decalSweepAt) { this.decalSweepAt = this.now + 0.5; this.sweepDecals(); }
    this.particles.flush(this.now);
    this.sprites.flush();
    this.strips.flush();
    this.meshes.flush();
    this.decals.flush(this.now);
  }

  /** Spawn time for event-driven effects: the sim time the event happened at (≥ render clock). */
  stampEvent(): void { this.particles.t0 = Math.max(this.now, this.world.time); }
  /** Spawn time for per-frame emission. */
  stampFrame(): void { this.particles.t0 = this.now; }
  get spawnTime(): number { return this.particles.t0; }

  private updateCamera(): void {
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.camPos.setFromMatrixPosition(cam.matrixWorld);
  }

  // ───────────────────────── visibility ─────────────────────────
  /** Fog of war: is the ground point visible to the local player right now? */
  fogVisible(x: number, z: number): boolean {
    if (this.fogOverride) return true;
    this.v2.x = x; this.v2.y = z;
    try { return this.world.vision.isVisible(this.local, this.v2); } catch { return true; }
  }
  /** Inside the camera frustum (with margin)? */
  onScreen(x: number, y: number, z: number, r = 1): boolean {
    this.sphere.center.set(x, y, z);
    this.sphere.radius = r + 2;
    return this.frustum.intersectsSphere(this.sphere);
  }
  /** Both fog-visible and on screen: worth spawning particles. */
  canSee(x: number, y: number, z: number, r = 1): boolean { return this.onScreen(x, y, z, r) && this.fogVisible(x, z); }
  /** Entity-based visibility (own entities always). */
  entityVisible(e: Entity): boolean {
    if (e.owner === this.local || this.fogOverride) return true;
    try { return this.world.vision.isEntityVisible(this.local, e); } catch { return true; }
  }

  private sweepDecals(): void {
    const d = this.decals, n = d.liveSlots;
    for (let i = 0; i < n; i++) if (d.endT[i]! > this.now) d.setVisible(i, this.fogVisible(d.posX[i]!, d.posZ[i]!));
  }

  // ───────────────────────── timers ─────────────────────────
  registerTimer(kind: number, fn: TimerFn): void { this.timerFns[kind] = fn; }

  /** Schedules timer `kind` at absolute sim time `at`. Silently drops when the queue is full. */
  schedule(at: number, kind: number, x: number, y: number, z: number, s = 1, aux = 0, ref: Entity | null = null): void {
    if (this.tCount >= TIMER_CAP) return;
    const i = this.tCount++;
    this.tAt[i] = at; this.tKind[i] = kind; this.tRef[i] = ref;
    const o = i * 5, n = this.tNum;
    n[o] = x; n[o + 1] = y; n[o + 2] = z; n[o + 3] = s; n[o + 4] = aux;
  }

  private runTimers(): void {
    let i = 0;
    while (i < this.tCount) {
      if (this.tAt[i]! > this.now) { i++; continue; }
      const fn = this.timerFns[this.tKind[i]!];
      const o = i * 5, n = this.tNum, ref = this.tRef[i]!;
      const x = n[o]!, y = n[o + 1]!, z = n[o + 2]!, s = n[o + 3]!, aux = n[o + 4]!;
      // swap-remove before running (handlers may schedule more)
      const last = --this.tCount;
      if (i !== last) {
        this.tAt[i] = this.tAt[last]!; this.tKind[i] = this.tKind[last]!; this.tRef[i] = this.tRef[last]!;
        for (let k = 0; k < 5; k++) n[o + k] = n[last * 5 + k]!;
      }
      this.tRef[last] = null;
      this.particles.t0 = this.now;
      if (fn) { try { fn(x, y, z, s, aux, ref); } catch (err) { console.error('[vfx] timer failed', err); } }
    }
  }

  // ───────────────────────── entity anchors ─────────────────────────
  flyHeight(e: Entity): number {
    if (e.kind !== 'unit' || !e.mover?.flying) return 0;
    return (e.def as UnitDef).flyHeight ?? DEFAULT_FLY_HEIGHT;
  }

  /** Model top height (health-bar anchor) or a size-based fallback. */
  modelHeight(e: Entity): number {
    const m = this.getModel(e.id);
    if (m && m.height > 0) return m.height;
    if (e.def.kind === 'unit') return e.radius * 2.2;
    if (e.def.kind === 'building') { const fp = e.def.footprint; return 1 + Math.min(fp.w, fp.h) * 0.45; }
    return 0.9;
  }

  /** Interpolated ground position (+ flight altitude) — matches the render core's placement. */
  entityBase(e: Entity, out: THREE.Vector3): THREE.Vector3 {
    const a = this.alpha;
    const x = e.prevPos.x + (e.pos.x - e.prevPos.x) * a;
    const z = e.prevPos.y + (e.pos.y - e.prevPos.y) * a;
    return out.set(x, this.heightAt(x, z) + this.flyHeight(e), z);
  }

  /** Visual centre of an entity (base + ~45 % of its height). */
  entityCenter(e: Entity, out: THREE.Vector3): THREE.Vector3 {
    this.entityBase(e, out);
    out.y += this.modelHeight(e) * (e.kind === 'unit' ? 0.45 : 0.35);
    return out;
  }

  /**
   * World-space muzzle: the model's local `muzzle` transformed by the model root's transform
   * (position/rotation/scale as placed by the render core; we use the entity's current facing so a unit
   * that snapped to its target this tick fires from the right side). Fallback: front-chest of the unit,
   * top of a building.
   */
  muzzle(e: Entity, out: THREE.Vector3): THREE.Vector3 {
    this.entityBase(e, out);
    const m = this.getModel(e.id);
    const f = e.facing, c = Math.cos(f), s = Math.sin(f);
    if (m?.muzzle) {
      const sc = m.root.scale;
      const mx = m.muzzle.x * sc.x, my = m.muzzle.y * sc.y, mz = m.muzzle.z * sc.z;
      out.x += mx * c - mz * s; out.y += my; out.z += mx * s + mz * c;
      if (m.root.parent && m.root.parent !== this.scene) out.applyMatrix4(m.root.parent.matrixWorld);
      return out;
    }
    const h = this.modelHeight(e);
    if (e.kind === 'unit') {
      const fwd = e.radius * 0.75;
      out.x += c * fwd; out.z += s * fwd; out.y += h * (e.mover?.flying ? 0.3 : 0.58);
    } else {
      out.y += h * 0.85;
    }
    return out;
  }

  /** Point on the target's surface facing (fromX, fromZ): footprint edge for buildings, body for units. */
  hitPoint(t: Entity, fromX: number, fromZ: number, out: THREE.Vector3): THREE.Vector3 {
    if (t.kind !== 'unit' && t.tile) {
      const fp = (t.def as BuildingDef | ResourceNodeDef).footprint;
      const inset = Math.min(0.3, Math.min(fp.w, fp.h) * 0.15);
      const x0 = t.tile.x + inset, x1 = t.tile.x + fp.w - inset, z0 = t.tile.y + inset, z1 = t.tile.y + fp.h - inset;
      let hx = Math.min(x1, Math.max(x0, fromX)), hz = Math.min(z1, Math.max(z0, fromZ));
      if (fromX > x0 && fromX < x1 && fromZ > z0 && fromZ < z1) { hx = t.pos.x; hz = t.pos.y; }
      const h = this.modelHeight(t);
      return out.set(hx, this.heightAt(hx, hz) + Math.min(h * 0.45, 1.8), hz);
    }
    this.entityBase(t, out);
    const dx = fromX - out.x, dz = fromZ - out.z, d = Math.hypot(dx, dz);
    if (d > 1e-3) { const k = Math.min(t.radius * 0.6, d * 0.5) / d; out.x += dx * k; out.z += dz * k; }
    out.y += this.modelHeight(t) * 0.48;
    return out;
  }

  /** Terrain normal at (x, z) into out (unit). */
  groundNormal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 0.5;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** Player colour as linear RGB (team-coloured effects). */
  playerColor(owner: PlayerId, out: THREE.Color): THREE.Color {
    const p = this.world.players.get(owner);
    return out.setHex(p?.color ?? 0xc8c8c8);
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.particles.dispose(); this.sprites.dispose(); this.strips.dispose(); this.decals.dispose();
    this.meshes.dispose(); this.domes.dispose();
    this.atlas.dispose();
    this.tRef.fill(null);
  }
}
