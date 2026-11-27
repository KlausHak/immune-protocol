/**
 * [render-core] Entity → model views: creation for existing/spawned entities, prevPos→pos interpolation,
 * smoothed facing, flyer altitude + bob, fog-of-war visibility, ModelAnimState, generic death animation
 * (tilt / fall / sink) unless the model handles death itself, owner-change rebuilds, removal & disposal.
 * Hot loop is allocation-free (state objects are reused per view).
 */
import * as THREE from 'three';
import { DEFAULT_FLY_HEIGHT } from '../../config';
import { angleDiff, lerp, lerpAngle } from '../../core/math';
import { sampleHeight } from '../../core/terrain';
import type { Entity, EntityId, PlayerId, UnitDef } from '../../core/types';
import { ALL_BUILDINGS, ALL_UNITS, RESOURCE_DEFS } from '../../data';
import type { World } from '../../sim/World';
import { patchFogOfWar } from '../environment/fog';
import { createEntityModel, placeholderModel, type EntityModel, type ModelAnimState, type ModelBuildContext } from '../models';

export interface EntityView {
  readonly id: EntityId;
  readonly entity: Entity;
  model: EntityModel;
  /** reused every frame */
  readonly state: ModelAnimState;
  /** owner the model was built for (team colour) */
  owner: PlayerId;
  /** visible to the local player this frame (frozen while dying) */
  visible: boolean;
  dying: boolean;
  /** 0..1 death animation progress */
  death: number;
  deathDuration: number;
  /** interpolated ground position (sim coords) and terrain height under it */
  x: number;
  y: number;
  ground: number;
  /** world-space y of the model root (ground + altitude − death sink) */
  rootY: number;
  /** displayed facing (sim convention) */
  facing: number;
  /** flyers: cruise altitude (0 = ground unit), smoothed ground reference, bob phase */
  flyHeight: number;
  flyBase: number;
  phase: number;
  /** generic death tilt: 0 = roll about the forward axis, 1 = pitch forward; sign ±1 */
  tiltAxis: number;
  tiltSign: number;
  /** health-bar damage trail (lags behind hp) */
  trail: number;
  trailHold: number;
  /** model.update threw once → stop animating this view (placement still works) */
  broken: boolean;
  index: number;
}

/** Materials already passed through patchFogOfWar (shared across renderer instances / matches). */
const fogPatched = new WeakSet<THREE.Material>();
const warned = new Set<string>();
function warnOnce(key: string, msg: string, err?: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[render-core] ${msg}`, err ?? '');
}

const WARM_BASE: ModelAnimState = {
  moving: false, speed: 0, activity: 'idle', sinceAttack: Infinity, construction: 1, hpFrac: 1, carrying: false,
  producing: false, selected: false, death: 0, aimAngle: null, facing: 0, resourceFrac: 1,
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export class EntityViews {
  readonly list: EntityView[] = [];
  private readonly byId = new Map<EntityId, EntityView>();

  constructor(private readonly scene: THREE.Scene, private readonly world: World, private readonly local: PlayerId) {}

  get(id: EntityId | null | undefined): EntityView | undefined { return id == null ? undefined : this.byId.get(id); }
  get size(): number { return this.list.length; }

  /** Units below this radius skip shadow casting (quality tier policy). */
  private minCasterRadius = 0;
  setMinCasterRadius(r: number): void {
    if (r === this.minCasterRadius) return;
    this.minCasterRadius = r;
    for (const v of this.list) applyCasterPolicy(v.model.root, v.entity.kind === 'unit' && v.entity.radius < r);
  }

  add(e: Entity): EntityView | undefined {
    if (this.byId.has(e.id) || !e.alive) return undefined;
    const model = this.buildModel(e);
    const map = this.world.map;
    const flyHeight = e.mover?.flying ? ((e.def as UnitDef).flyHeight ?? DEFAULT_FLY_HEIGHT) : 0;
    const ground = sampleHeight(map, e.pos.x, e.pos.y);
    const v: EntityView = {
      id: e.id, entity: e, model, owner: e.owner, visible: false, dying: false, death: 0, deathDuration: 1.5,
      x: e.pos.x, y: e.pos.y, ground, rootY: ground + flyHeight, facing: e.facing, flyHeight, flyBase: ground,
      phase: (e.id * 2.399) % (Math.PI * 2), tiltAxis: e.id % 3 === 0 ? 1 : 0, tiltSign: e.id % 2 === 0 ? 1 : -1,
      trail: 1, trailHold: 0, broken: false, index: this.list.length,
      state: {
        moving: false, speed: 0, activity: e.activity, sinceAttack: Infinity, construction: 1, hpFrac: 1, carrying: false,
        producing: false, selected: false, death: 0, aimAngle: null, facing: e.facing, resourceFrac: 1,
      },
    };
    v.visible = this.isVisible(e);
    v.trail = clamp01(e.hp / Math.max(1, e.stats.maxHp));
    model.root.position.set(e.pos.x, v.rootY, e.pos.y);
    model.root.rotation.set(0, -e.facing, 0);
    model.root.visible = v.visible;
    this.scene.add(model.root);
    this.byId.set(e.id, v);
    this.list.push(v);
    return v;
  }

  /** Begin the death animation (entities that die unseen vanish immediately — no free intel). */
  startDeath(e: Entity): void {
    const v = this.byId.get(e.id);
    if (!v || v.dying) return;
    if (!v.visible) { this.remove(e.id); return; }
    v.dying = true;
    v.death = 0;
    v.deathDuration = e.kind === 'building' ? 2.2 : v.flyHeight > 0 ? 1.9 : 1.5;
  }

  remove(id: EntityId): void {
    const v = this.byId.get(id);
    if (!v) return;
    this.byId.delete(id);
    this.scene.remove(v.model.root);
    this.disposeModel(v.model, v.entity.defId);
    const last = this.list.pop()!;
    if (last !== v) { this.list[v.index] = last; last.index = v.index; }
  }

  /**
   * Per-frame sync. alpha = interpolation factor between the previous and the current tick, dt = real
   * seconds, time = render clock (seconds).
   */
  update(alpha: number, dt: number, time: number, selection: ReadonlySet<EntityId>): void {
    const world = this.world, map = world.map;
    const renderTime = world.time - world.dt * (1 - alpha);
    const kFace = 1 - Math.exp(-dt * 20);
    const kFly = 1 - Math.exp(-dt * 3);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const v = this.list[i]!;
      const e = v.entity;
      if (v.dying) {
        v.death += dt / v.deathDuration;
        if (v.death >= 1) { this.remove(v.id); continue; }
      } else {
        if (v.owner !== e.owner) this.rebuild(v);
        v.visible = this.isVisible(e);
      }
      const model = v.model, root = model.root;
      root.visible = v.visible;

      // ── placement ──
      const x = e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha;
      const y = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha;
      v.x = x; v.y = y;
      const ground = sampleHeight(map, x, y);
      v.ground = ground;
      if (e.kind === 'unit') {
        const target = lerpAngle(e.prevFacing, e.facing, alpha);
        v.facing += angleDiff(v.facing, target) * kFace;
      } else {
        v.facing = e.facing;
      }
      let rootY = ground, px = x, pz = y, rx = 0, rz = 0;
      if (v.flyHeight > 0) {
        v.flyBase += (ground - v.flyBase) * kFly;
        let alt = v.flyHeight + Math.sin(time * 1.7 + v.phase) * 0.12;
        let base = v.flyBase;
        if (v.dying && !model.handlesDeath) {
          const f = Math.min(1, v.death / 0.5);
          alt *= 1 - f * f;
          base = lerp(v.flyBase, ground, f);
        }
        rootY = base + alt;
      }
      if (v.dying && !model.handlesDeath) {
        const d = v.death;
        if (e.kind === 'unit') {
          const f1 = Math.min(1, d / 0.35), tilt = (1 - Math.pow(1 - f1, 3)) * 1.2 * v.tiltSign;
          if (v.tiltAxis === 0) rx = tilt; else rz = -Math.abs(tilt);
          const f2 = clamp01((d - 0.4) / 0.6);
          rootY -= f2 * f2 * (model.height + 0.3);
        } else {
          const shake = (1 - d) * 0.06;
          px += Math.sin(time * 43 + v.phase) * shake;
          pz += Math.cos(time * 37 + v.phase) * shake;
          rx = d * 0.05 * v.tiltSign; rz = d * 0.04;
          rootY -= Math.pow(d, 1.6) * (model.height * 0.9 + 0.2);
        }
      }
      v.rootY = rootY;
      root.position.set(px, rootY, pz);
      root.rotation.set(rx, -v.facing, rz);

      // ── damage trail for health bars ──
      const hpFrac = clamp01(e.hp / Math.max(1, e.stats.maxHp));
      if (hpFrac >= v.trail) { v.trail = hpFrac; v.trailHold = 0; }
      else if (v.trailHold < 0.4) v.trailHold += dt;
      else v.trail = Math.max(hpFrac, v.trail - dt * 0.9);

      // ── animation state ──
      if (!v.visible || v.broken) continue;
      const st = v.state;
      const alive = !v.dying;
      st.moving = alive && !!e.mover?.moving;
      st.speed = alive && e.mover ? Math.hypot(e.mover.vel.x, e.mover.vel.y) : 0;
      st.activity = e.activity;
      st.sinceAttack = e.combat && e.combat.lastAttackTime >= 0 ? Math.max(0, renderTime - e.combat.lastAttackTime) : Infinity;
      st.construction = e.construction ? clamp01(e.construction.progress / Math.max(1e-6, e.construction.total)) : 1;
      st.hpFrac = hpFrac;
      st.carrying = (e.gatherer?.carrying ?? 0) > 0;
      st.producing = alive && !!e.production && e.production.queue.length > 0 && !e.construction;
      st.selected = alive && selection.has(v.id);
      st.death = v.dying ? Math.min(1, v.death) : 0;
      const tgt = alive && e.combat && e.combat.targetId != null ? world.getAlive(e.combat.targetId) : undefined;
      st.aimAngle = tgt ? Math.atan2(tgt.pos.y - e.pos.y, tgt.pos.x - e.pos.x) : null;
      st.facing = v.facing;
      st.resourceFrac = e.resource ? clamp01(e.resource.amount / Math.max(1, e.resource.initial)) : 1;
      try {
        model.update(st, dt, time);
      } catch (err) {
        v.broken = true;
        warnOnce(`update:${e.defId}`, `model.update for ${e.defId} threw; animation disabled for this entity`, err);
      }
    }
  }

  dispose(): void {
    for (let i = this.list.length - 1; i >= 0; i--) this.remove(this.list[i]!.id);
  }

  /**
   * Shader warm-up: builds one hidden instance of every unit/building model each active player can own
   * (in that player's team colour) plus the resource node, and drives each through the attack / producing /
   * construction / death states so lazily-created material variants exist. Returns the instances so the
   * caller can compile them; call the returned dispose() afterwards.
   */
  buildWarmUpSet(): { group: THREE.Group; dispose: () => void } {
    const group = new THREE.Group();
    group.name = 'render-core:warm-up';
    const models: EntityModel[] = [];
    const seen = new Set<string>();
    const states: Array<Partial<ModelAnimState>> = [
      {}, { sinceAttack: 0, activity: 'attacking', aimAngle: 0 }, { producing: true, activity: 'producing' },
      { construction: 0.5 }, { moving: true, speed: 2, carrying: true }, { death: 0.5 }, { selected: true, hpFrac: 0.3 },
    ];
    const add = (defId: string, faction: ModelBuildContext['faction'], color: number, radius: number, footprint?: { w: number; h: number }) => {
      const key = `${defId}:${color}`;
      if (seen.has(key)) return;
      seen.add(key);
      const ctx: ModelBuildContext = { defId, faction, teamColor: new THREE.Color(color), radius, footprint, seed: 1 };
      let m: EntityModel;
      try { m = createEntityModel(ctx); if (!m?.root) return; } catch { return; }
      prepareModel(m.root, footprint !== undefined);
      models.push(m);
      group.add(m.root);
      for (const st of states) {
        try { m.update({ ...WARM_BASE, ...st }, 0.016, 1); } catch { break; }
      }
      // leave the model in its neutral pose so compile() sees the default variant too
      try { m.update(WARM_BASE, 0.016, 1); } catch { /* ignore */ }
    };
    for (const p of this.world.players.values()) {
      if (p.faction === 'neutral') continue;
      for (const d of ALL_UNITS) if (d.faction === p.faction) add(d.id, d.faction, p.color, d.radius);
      for (const d of ALL_BUILDINGS) if (d.faction === p.faction) add(d.id, d.faction, p.color, Math.max(d.footprint.w, d.footprint.h) / 2, d.footprint);
    }
    for (const d of Object.values(RESOURCE_DEFS)) add(d.id, 'neutral', 0xcccccc, d.radius, d.footprint);
    return {
      group,
      dispose: () => {
        group.removeFromParent();
        for (const m of models) this.disposeModel(m, 'warm-up');
      },
    };
  }

  // ───────────────────────── internals ─────────────────────────
  private isVisible(e: Entity): boolean {
    if (e.owner === this.local) return true;
    try { return this.world.vision.isEntityVisible(this.local, e); } catch { return true; }
  }

  private rebuild(v: EntityView): void {
    const old = v.model;
    this.scene.remove(old.root);
    this.disposeModel(old, v.entity.defId);
    v.model = this.buildModel(v.entity);
    v.owner = v.entity.owner;
    v.broken = false;
    this.scene.add(v.model.root);
  }

  private disposeModel(m: EntityModel, defId: string): void {
    try { m.dispose(); } catch (err) { warnOnce(`dispose:${defId}`, `model.dispose for ${defId} threw`, err); }
  }

  buildContext(e: Entity): ModelBuildContext {
    const def = e.def;
    const p = this.world.players.get(e.owner);
    return {
      defId: e.defId,
      faction: def.kind === 'resource' ? 'neutral' : def.faction,
      teamColor: new THREE.Color(p?.color ?? 0xcccccc),
      radius: e.radius,
      footprint: def.kind === 'unit' ? undefined : { w: def.footprint.w, h: def.footprint.h },
      seed: e.id,
    };
  }

  private buildModel(e: Entity): EntityModel {
    const ctx = this.buildContext(e);
    let model: EntityModel | undefined;
    try {
      model = createEntityModel(ctx);
      if (!model || !model.root) throw new Error('builder returned no root');
    } catch (err) {
      warnOnce(`build:${e.defId}`, `model for ${e.defId} failed; using placeholder`, err);
      model = placeholderModel(ctx);
    }
    prepareModel(model.root, e.kind !== 'unit');
    tagCasters(model.root);
    applyCasterPolicy(model.root, e.kind === 'unit' && e.radius < this.minCasterRadius);
    model.root.rotation.order = 'YXZ';
    model.root.userData.entityId = e.id;
    if (!model.root.name) model.root.name = `entity:${e.id}:${e.defId}`;
    return model;
  }
}

/**
 * Shadow defaults + fog-of-war patch. The artist's shadow flags win; if a model sets none we cast/receive
 * on all opaque meshes. Ground-anchored entities (buildings/resources) get the fog-of-war material patch.
 */
export function prepareModel(root: THREE.Object3D, fog: boolean): void {
  let anyCast = false, anyRecv = false;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.castShadow) anyCast = true;
    if (m.receiveShadow) anyRecv = true;
  });
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material;
    if (!anyCast || !anyRecv) {
      const first = Array.isArray(mat) ? mat[0] : mat;
      const seeThrough = !!first && first.transparent && first.opacity < 0.5;
      if (!anyCast && !seeThrough) m.castShadow = true;
      if (!anyRecv) m.receiveShadow = true;
    }
    if (fog && mat) {
      if (Array.isArray(mat)) for (const x of mat) patchOnce(x);
      else patchOnce(mat);
    }
  });
}

/** Remember which meshes the model wanted to cast shadows, so tier changes can restore them. */
function tagCasters(root: THREE.Object3D): void {
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.userData.rcCaster === undefined) o.userData.rcCaster = o.castShadow; });
}
function applyCasterPolicy(root: THREE.Object3D, suppress: boolean): void {
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = !suppress && o.userData.rcCaster === true; });
}

function patchOnce(m: THREE.Material): void {
  if (fogPatched.has(m)) return;
  fogPatched.add(m);
  try { patchFogOfWar(m); } catch (err) { warnOnce(`fog:${m.type}`, 'patchFogOfWar threw', err); }
}
