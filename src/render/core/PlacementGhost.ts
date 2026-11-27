/**
 * [render-core] Building placement preview: a translucent copy of the real building model
 * (createEntityModel, cached per def while placing) tinted by validity, a per-tile footprint grid
 * (buildable + movement.isFootprintFree on 1×1 tiles) and, for defensive buildings, the weapon range ring.
 */
import * as THREE from 'three';
import { inBounds, sampleHeight, tileIndex } from '../../core/terrain';
import type { BuildingDef, EntityId, PlayerId, TilePos } from '../../core/types';
import { tryGetDef } from '../../data';
import type { World } from '../../sim/World';
import { createEntityModel, placeholderModel, type EntityModel, type ModelAnimState, type ModelBuildContext } from '../models';
import { DecalKind, type GroundDecals } from './GroundDecals';
import { PLACEMENT_COLORS } from './palette';

export interface PlacementGhost { defId: string; tile: TilePos; valid: boolean }

const GHOST_STATE: ModelAnimState = {
  moving: false, speed: 0, activity: 'idle', sinceAttack: Infinity, construction: 1, hpFrac: 1, carrying: false,
  producing: false, selected: false, death: 0, aimAngle: null, facing: 0, resourceFrac: 1,
};

type Tintable = THREE.Material & { opacity: number; emissive?: THREE.Color; emissiveIntensity?: number };

export class PlacementGhostView {
  private defId: string | null = null;
  private def: BuildingDef | null = null;
  private model: EntityModel | null = null;
  private clones: Tintable[] = [];
  private tile: TilePos = { x: 0, y: 0 };
  private valid = true;
  private active = false;
  /** per-tile validity (1 = ok), row-major w×h */
  private tileOk = new Uint8Array(64);
  private lastCheck = -1;
  private checkedTile = { x: NaN, y: NaN };
  private readonly validColor = new THREE.Color(PLACEMENT_COLORS.valid);
  private readonly invalidColor = new THREE.Color(PLACEMENT_COLORS.invalid);
  private readonly rangeColor = new THREE.Color(PLACEMENT_COLORS.range);
  private readonly tintValid = new THREE.Color(0x1d6a48);
  private readonly tintInvalid = new THREE.Color(0x8a1414);

  constructor(private readonly scene: THREE.Scene, private readonly world: World, private readonly local: PlayerId,
    /** ids ignored by the per-tile unit check (e.g. the selected builders) */
    private readonly ignoreIds: () => readonly EntityId[]) {}

  set(g: PlacementGhost | null): void {
    if (!g) { this.active = false; if (this.model) this.model.root.visible = false; return; }
    const def = tryGetDef(g.defId);
    if (!def || def.kind !== 'building') { this.set(null); return; }
    if (g.defId !== this.defId) this.build(def);
    if (g.tile.x !== this.tile.x || g.tile.y !== this.tile.y) this.lastCheck = -1;
    this.tile.x = g.tile.x; this.tile.y = g.tile.y;
    this.valid = g.valid;
    this.active = true;
  }

  get isActive(): boolean { return this.active; }

  private build(def: BuildingDef): void {
    this.disposeModel();
    this.defId = def.id;
    this.def = def;
    const p = this.world.players.get(this.local);
    const ctx: ModelBuildContext = {
      defId: def.id, faction: def.faction, teamColor: new THREE.Color(p?.color ?? 0x2fd6c6),
      radius: Math.max(def.footprint.w, def.footprint.h) / 2, footprint: { w: def.footprint.w, h: def.footprint.h }, seed: 1,
    };
    let model: EntityModel;
    try { model = createEntityModel(ctx); if (!model?.root) throw new Error('no root'); } catch { model = placeholderModel(ctx); }
    // translucent per-ghost material copies (the originals are shared with live buildings)
    const cloneMap = new Map<THREE.Material, THREE.Material>();
    model.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = false; m.receiveShadow = false;
      m.renderOrder = 5;
      const swap = (src: THREE.Material): THREE.Material => {
        let c = cloneMap.get(src);
        if (!c) {
          c = src.clone();
          c.transparent = true;
          c.depthWrite = true;
          (c as Tintable).opacity = Math.min((src as Tintable).opacity ?? 1, 0.55);
          cloneMap.set(src, c);
          this.clones.push(c as Tintable);
        }
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
    });
    model.root.rotation.order = 'YXZ';
    model.root.visible = false;
    this.model = model;
    this.scene.add(model.root);
  }

  /** Per-tile check: buildable & free of static/dynamic blockers and ground units (except ignored ids). */
  private refreshTiles(time: number): void {
    const def = this.def;
    if (!def) return;
    const { w, h } = def.footprint;
    if (this.tileOk.length < w * h) this.tileOk = new Uint8Array(w * h);
    if (this.lastCheck >= 0 && time - this.lastCheck < 0.12 && this.checkedTile.x === this.tile.x && this.checkedTile.y === this.tile.y) return;
    this.lastCheck = time;
    this.checkedTile.x = this.tile.x; this.checkedTile.y = this.tile.y;
    const map = this.world.map, mv = this.world.movement;
    const ignore = this.ignoreIds() as EntityId[];
    const one = { x: 0, y: 0 };
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const tx = this.tile.x + i, ty = this.tile.y + j;
      let ok = inBounds(map, tx, ty) && map.buildable[tileIndex(map, tx, ty)] === 1;
      if (ok) {
        one.x = tx; one.y = ty;
        try { ok = mv.isFootprintFree(one, 1, 1, ignore); } catch { ok = true; }
      }
      this.tileOk[j * w + i] = ok ? 1 : 0;
    }
  }

  update(dt: number, time: number, decals: GroundDecals): void {
    const model = this.model, def = this.def;
    if (!this.active || !model || !def) { if (model) model.root.visible = false; return; }
    this.refreshTiles(time);
    const { w, h } = def.footprint;
    const cx = this.tile.x + w / 2, cy = this.tile.y + h / 2;
    const map = this.world.map;
    // ── model ──
    let ground = sampleHeight(map, cx, cy);
    for (let j = 0; j <= 1; j++) for (let i = 0; i <= 1; i++) ground = Math.max(ground, sampleHeight(map, this.tile.x + i * w, this.tile.y + j * h));
    model.root.visible = true;
    model.root.position.set(cx, ground + 0.02, cy);
    model.root.rotation.set(0, 0, 0);
    const pulse = 0.5 + 0.5 * Math.sin(time * 4.5);
    const tint = this.valid ? this.tintValid : this.tintInvalid;
    for (const m of this.clones) {
      m.opacity = 0.42 + 0.1 * pulse;
      if (m.emissive) { m.emissive.copy(tint); m.emissiveIntensity = 0.7 + 0.4 * pulse; }
    }
    try { model.update(GHOST_STATE, dt, time); } catch { /* preview only */ }

    // ── footprint tiles ──
    let anyBad = false;
    for (let k = 0; k < w * h; k++) if (!this.tileOk[k]) { anyBad = true; break; }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const ok = this.valid || (anyBad && this.tileOk[j * w + i] === 1);
      decals.quad(this.tile.x + i + 0.5, this.tile.y + j + 0.5, 0.44, 0.44, 0.04, 0, 0.1, 0.05,
        ok ? this.validColor : this.invalidColor, 1.25, 0.85, DecalKind.Tile, 0, ok ? 0.22 : 0.34, 0, 0.045);
    }
    // ── weapon range ring for defensive buildings ──
    let range = 0;
    for (const wp of def.weapons) range = Math.max(range, wp.range);
    if (range > 0) {
      const R = range + Math.max(w, h) / 2;
      decals.quad(cx, cy, R, R, 0.1, 0, R, 0.06, this.rangeColor, 1.1, 0.55, DecalKind.DashRing, 0, 0.035,
        Math.max(12, Math.round(R * 2.2)), 0.07, Math.min(10, Math.ceil(R / 2)));
    }
  }

  private disposeModel(): void {
    if (this.model) {
      this.scene.remove(this.model.root);
      try { this.model.dispose(); } catch { /* ignore */ }
    }
    for (const c of this.clones) c.dispose();
    this.clones = [];
    this.model = null;
    this.defId = null;
    this.def = null;
  }

  dispose(): void { this.disposeModel(); this.active = false; }
}
