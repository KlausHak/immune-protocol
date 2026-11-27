/**
 * [render-core] OWNER: render-core agent. WebGL renderer, post-processing, RTS camera, entity view sync
 * (interpolation, visibility, animation state), selection/hover visuals, health bars, placement ghost,
 * command markers and picking. The PUBLIC API below is a contract used by Controls, HUD, Game and VFX.
 *
 * Frame: camera → entity views → ground decals (selection, markers, ghost tiles, rally) → environment →
 * VFX → scene (through PostFx) → screen-space bar overlay.
 */
import * as THREE from 'three';
import { clamp } from '../../core/math';
import { sampleHeight } from '../../core/terrain';
import type { BuildingDef, Entity, EntityId, PlayerId, Vec2 } from '../../core/types';
import { FACTIONS } from '../../data';
import type { Quality, Settings } from '../../game/settings';
import type { World } from '../../sim/World';
import { EnvironmentView } from '../environment';
import type { EntityModel } from '../models';
import { VfxSystem } from '../vfx';
import { EntityViews, type EntityView } from './EntityViews';
import { Feedback, type CommandMarkerKind } from './Feedback';
import { GroundDecals } from './GroundDecals';
import { BarKind, HealthBars } from './HealthBars';
import { BAR_COLORS, relationOf, RELATION_COLORS } from './palette';
import { intersectTerrain, rayAabb, screenRay } from './picking';
import { PlacementGhostView, type PlacementGhost } from './PlacementGhost';
import { PostFx } from './PostFx';
import { pixelRatioFor, qualityProfile, type QualityProfile } from './quality';
import { RtsCamera } from './RtsCamera';

export { RtsCamera } from './RtsCamera';
export type { CommandMarkerKind } from './Feedback';
export type { PlacementGhost } from './PlacementGhost';
export { RELATION_COLORS, MARKER_COLORS, BAR_COLORS } from './palette';

export interface GameRendererOptions {
  canvas: HTMLCanvasElement;
  world: World;
  localPlayerId: PlayerId;
  settings: Settings;
}

export interface PhaseTimes { views: number; feedback: number; environment: number; vfx: number; draw: number; bars: number }
export interface ScreenPoint { x: number; y: number; visible: boolean }
export interface RenderStats { calls: number; triangles: number; views: number; bars: number; decals: number; pixelRatio: number; quality: Quality }

const DEG = Math.PI / 180;
const warned = new Set<string>();
function warnOnce(key: string, msg: string, err: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[render-core] ${msg}`, err);
}

function explicitQualityParam(): boolean {
  try { return new URLSearchParams(location.search).has('quality'); } catch { return false; }
}

/** Context MSAA is skipped under automation (headless SwiftShader: 4× fill cost for screenshots). */
function wantContextMsaa(): boolean {
  return !(typeof navigator !== 'undefined' && navigator.webdriver);
}

/** SwiftShader / llvmpipe / other CPU rasterizers. */
function detectSoftwareRenderer(r: THREE.WebGLRenderer): boolean {
  try {
    const gl = r.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|softpipe|software/i.test(name);
  } catch { return false; }
}

/** Hit-points per health-bar segment: readable ticks, at least ~4 px apart. */
function segmentHp(maxHp: number, widthPx: number): number {
  const steps = [10, 25, 50, 100, 200, 250, 500, 1000];
  for (const s of steps) { const n = maxHp / s; if (n <= 20 && widthPx / n >= 4) return s; }
  return maxHp;
}

export class GameRenderer {
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly cameraCtl: RtsCamera;
  readonly environment: EnvironmentView;
  readonly vfx: VfxSystem;
  /** post-processing chain (bloom / grade parameters are tweakable by lighting presets) */
  readonly post: PostFx;
  /** active render quality (follows settings.quality; see setQuality) */
  quality: Quality;
  /** true on software rasterizers (SwiftShader/llvmpipe): defaults to the low tier unless ?quality= is given */
  readonly softwareRendering: boolean;

  private profile: QualityProfile;
  private readonly world: World;
  private readonly local: PlayerId;
  private readonly settings: Settings;
  private readonly views: EntityViews;
  private readonly decals: GroundDecals;
  private readonly bars: HealthBars;
  private readonly feedback: Feedback;
  private readonly ghost: PlacementGhostView;
  private readonly selection = new Set<EntityId>();
  private selectionIds: EntityId[] = [];
  private hoverId: EntityId | null = null;
  private readonly unsub: Array<() => void> = [];
  private time = 0;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private seenSettingsQuality: Quality;
  private seenDpr = 1;
  private shadowFrame = 0;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private readonly focus: Vec2 = { x: 0, y: 0 };
  // scratch (allocation-free hot paths)
  private readonly v3a = new THREE.Vector3();
  private readonly v3b = new THREE.Vector3();
  private readonly rayO = new THREE.Vector3();
  private readonly rayD = new THREE.Vector3();
  private readonly sp: ScreenPoint = { x: 0, y: 0, visible: false };
  private readonly barColor = new THREE.Color();
  private readonly cHigh = new THREE.Color(BAR_COLORS.high);
  private readonly cMid = new THREE.Color(BAR_COLORS.mid);
  private readonly cLow = new THREE.Color(BAR_COLORS.low);
  private readonly cCons = new THREE.Color(BAR_COLORS.construction);
  private readonly cProd = new THREE.Color(BAR_COLORS.production);
  private readonly cResearch = new THREE.Color(BAR_COLORS.research);
  private readonly cRes = new THREE.Color(BAR_COLORS.resource);
  private readonly cCargo = new THREE.Color(BAR_COLORS.cargo);

  constructor(private readonly opts: GameRendererOptions) {
    this.world = opts.world;
    this.local = opts.localPlayerId;
    this.settings = opts.settings;
    this.profile = qualityProfile(opts.settings.quality);
    this.quality = this.profile.quality;
    this.seenSettingsQuality = opts.settings.quality;

    this.three = new THREE.WebGLRenderer({
      canvas: opts.canvas, antialias: this.profile.aa === 'msaa' && wantContextMsaa(), powerPreference: 'high-performance', stencil: false,
    });
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.toneMappingExposure = 1;
    // PCFSoftShadowMap was folded into PCFShadowMap in three r180+ (Vogel-disk soft PCF; softness = light.shadow.radius)
    this.three.shadowMap.type = THREE.PCFShadowMap;
    this.three.shadowMap.enabled = this.profile.shadows;
    this.three.shadowMap.autoUpdate = false; // re-rendered every profile.shadowInterval drawn frames (see render)
    this.three.shadowMap.needsUpdate = true;
    this.three.info.autoReset = false;
    this.pixelRatio = pixelRatioFor(this.profile);
    this.seenDpr = window.devicePixelRatio || 1;
    this.three.setPixelRatio(this.pixelRatio);
    this.softwareRendering = detectSoftwareRenderer(this.three);
    if (this.softwareRendering && this.profile.quality !== 'low' && !explicitQualityParam()) {
      // CPU rasterizer (headless test browser / no GPU): default to the cheap tier; ?quality=… overrides
      this.profile = qualityProfile('low');
      this.quality = 'low';
      this.three.shadowMap.enabled = false;
      this.pixelRatio = 1;
      this.three.setPixelRatio(1);
    }

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 600);
    this.cameraCtl = new RtsCamera(this.camera, opts.canvas, this.world, opts.settings);

    const quality = this.quality;
    this.environment = new EnvironmentView({ scene: this.scene, renderer: this.three, camera: this.camera, world: this.world, map: this.world.map, localPlayerId: this.local, quality });
    this.vfx = new VfxSystem({
      scene: this.scene, camera: this.camera, world: this.world, localPlayerId: this.local, quality,
      getEntityModel: (id) => this.views.get(id)?.model,
      heightAt: (x, y) => sampleHeight(this.world.map, x, y),
    });

    this.decals = new GroundDecals(this.world.map);
    this.scene.add(this.decals.mesh);
    this.views = new EntityViews(this.scene, this.world, this.local);
    this.views.setMinCasterRadius(this.profile.minCasterRadius);
    this.feedback = new Feedback(this.scene, this.world, this.local, this.views, this.decals);
    this.ghost = new PlacementGhostView(this.scene, this.world, this.local, () => this.selectionIds);
    this.bars = new HealthBars();
    this.post = new PostFx(this.three, this.scene, this.camera);

    const me = this.world.players.get(this.local);
    if (me) this.cameraCtl.lookAt(me.startPos);
    for (const e of this.world.list) if (e.alive) this.views.add(e);
    this.unsub.push(
      this.world.events.on('entitySpawned', ({ entity }) => { this.views.add(entity); }),
      this.world.events.on('entityDied', ({ entity }) => { this.views.startDeath(entity); }),
      this.world.events.on('entityRemoved', ({ entity, reason }) => {
        if (reason === 'removed') this.views.remove(entity.id); else this.views.startDeath(entity);
        if (this.hoverId === entity.id) this.hoverId = null;
      }),
    );

    this.resize();
    this.post.configure(this.profile, this.width, this.height, this.pixelRatio);
    this.warmUpShaders();
    window.addEventListener('resize', this.resize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(opts.canvas);
    }
  }

  /**
   * Compile every program the match is likely to need up front (all live views + one hidden instance of
   * each model variant per team colour) so first appearances / attack flashes don't hitch mid-game.
   */
  private warmUpShaders(): void {
    let set: { group: THREE.Group; dispose: () => void } | null = null;
    try {
      // software rasterizers compile lazily: warming every variant costs more than it saves there
      if (!this.softwareRendering) set = this.views.buildWarmUpSet();
      if (set) {
        set.group.position.set(this.cameraCtl.target.x, -200, this.cameraCtl.target.y);
        this.scene.add(set.group);
      }
      this.scene.updateMatrixWorld();
      this.three.compile(this.scene, this.camera);
    } catch (err) {
      warnOnce('warmup', 'shader warm-up failed', err);
    } finally {
      set?.dispose();
    }
  }

  // ───────────────────────── frame ─────────────────────────
  render(alpha: number, dtReal: number): void {
    if (this.disposed) return;
    const dt = clamp(Number.isFinite(dtReal) ? dtReal : 0, 0, 0.25);
    alpha = clamp(Number.isFinite(alpha) ? alpha : 1, 0, 1);
    this.time += dt;
    if (this.settings.quality !== this.seenSettingsQuality) {
      this.seenSettingsQuality = this.settings.quality;
      this.setQuality(this.settings.quality);
    }
    if ((window.devicePixelRatio || 1) !== this.seenDpr) {
      this.seenDpr = window.devicePixelRatio || 1;
      this.pixelRatio = pixelRatioFor(this.profile);
      this.resize();
    }
    const prof = this.prof;
    let t0 = performance.now(), t1 = t0;
    const lap = (k: keyof PhaseTimes): void => { t1 = performance.now(); prof[k] += (t1 - t0 - prof[k]) * 0.1; t0 = t1; };
    this.cameraCtl.update(dt);
    this.views.update(alpha, dt, this.time, this.selection);
    lap('views');

    this.decals.begin();
    const markerScale = clamp(this.cameraCtl.distance / 34, 0.75, 1.7);
    this.feedback.update(dt, this.time, this.selection, this.selectionIds, this.hoverId, markerScale);
    this.ghost.update(dt, this.time, this.decals);
    this.decals.end(this.time);
    lap('feedback');

    this.focus.x = this.cameraCtl.target.x; this.focus.y = this.cameraCtl.target.y;
    try { this.environment.update(dt, this.time, this.focus); } catch (err) { warnOnce('env', 'environment.update threw', err); }
    lap('environment');
    try { this.vfx.update(dt, this.time, alpha); } catch (err) { warnOnce('vfx', 'vfx.update threw', err); }
    lap('vfx');

    // NOTE: never skip drawing inside a rAF callback — headless Chromium stops scheduling frames when a
    // callback produces no canvas damage (observed: the whole game loop froze). Cheapness comes from tiers.
    this.three.info.reset();
    if (this.three.shadowMap.enabled) {
      const interval = this.profile.shadowInterval * (this.softwareRendering ? 2 : 1);
      this.three.shadowMap.needsUpdate = ++this.shadowFrame % interval === 0 || interval <= 1;
    }
    this.post.render(dt);
    if (this.profileSync) this.three.getContext().finish();
    lap('draw');
    this.buildBars();
    this.bars.render(this.three);
    if (this.profileSync) this.three.getContext().finish();
    lap('bars');
  }

  /** Smoothed per-phase CPU ms of the last frames (with profileSync=true the GPU wait is included in draw/bars). */
  readonly prof: PhaseTimes = { views: 0, feedback: 0, environment: 0, vfx: 0, draw: 0, bars: 0 };
  /** Debug: gl.finish() after drawing so `prof.draw` measures GPU time too (slows the frame; profiling only). */
  profileSync = false;

  /**
   * Debug breakdown of what the scene draws, grouped by top-level scene child (≈ module): visible
   * meshes (≈ draw calls before culling), shadow casters, instances and triangles.
   */
  profileScene(): Array<{ module: string; meshes: number; casters: number; instances: number; triangles: number }> {
    const out: Array<{ module: string; meshes: number; casters: number; instances: number; triangles: number }> = [];
    for (const child of this.scene.children) {
      const row = { module: child.name || child.type, meshes: 0, casters: 0, instances: 0, triangles: 0 };
      const visit = (o: THREE.Object3D): void => {
        if (!o.visible) return;
        const m = o as THREE.Mesh;
        if (m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) {
          row.meshes++;
          if (m.castShadow) row.casters++;
          const g = m.geometry as THREE.BufferGeometry | undefined;
          const count = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
          row.instances += count;
          if (g) {
            const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
            row.triangles += Math.min(n, g.drawRange.count) / 3 * count;
          }
        }
        for (const c of o.children) visit(c);
      };
      visit(child);
      out.push(row);
    }
    // collapse per-entity roots into one row
    const merged = new Map<string, { module: string; meshes: number; casters: number; instances: number; triangles: number }>();
    for (const r of out) {
      const key = r.module.startsWith('entity:') || r.module.startsWith('model:') ? 'entities' : r.module;
      const m = merged.get(key) ?? { module: key, meshes: 0, casters: 0, instances: 0, triangles: 0 };
      m.meshes += r.meshes; m.casters += r.casters; m.instances += r.instances; m.triangles += Math.round(r.triangles);
      merged.set(key, m);
    }
    return [...merged.values()].sort((a, b) => b.meshes - a.meshes);
  }

  resize = (): void => {
    if (this.disposed) return;
    const c = this.opts.canvas;
    const w = Math.max(1, Math.floor(c.clientWidth || window.innerWidth || 1));
    const h = Math.max(1, Math.floor(c.clientHeight || window.innerHeight || 1));
    this.width = w; this.height = h;
    this.three.setPixelRatio(this.pixelRatio);
    this.three.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h, this.pixelRatio);
    this.cameraCtl.onResize();
  };

  /** Switch render tier at runtime (pixel ratio, shadows, post chain). Environment/VFX keep their build-time tier. */
  setQuality(q: Quality): void {
    const profile = qualityProfile(q);
    this.profile = profile;
    this.quality = profile.quality;
    if (this.three.shadowMap.enabled !== profile.shadows) {
      this.three.shadowMap.enabled = profile.shadows;
      // shadow defines are baked into programs → recompile
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        if (Array.isArray(m)) for (const x of m) x.needsUpdate = true; else m.needsUpdate = true;
      });
    }
    this.views.setMinCasterRadius(profile.minCasterRadius);
    this.three.shadowMap.needsUpdate = true;
    this.pixelRatio = pixelRatioFor(profile);
    this.resize();
    this.post.configure(profile, this.width, this.height, this.pixelRatio);
  }

  // ───────────────────────── health bars ─────────────────────────
  private buildBars(): void {
    const bars = this.bars, cam = this.camera, W = this.width, H = this.height;
    bars.begin(W, H, this.pixelRatio);
    const mode = this.settings.healthBars;
    const pxAtUnitDepth = H / (2 * Math.tan((cam.fov * DEG) / 2));
    const list = this.views.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i]!;
      if (!v.visible || v.dying) continue;
      const e = v.entity;
      if (!e.alive) continue;
      const sel = this.selection.has(v.id), hov = this.hoverId === v.id;
      const isRes = e.kind === 'resource';
      const friendly = e.owner === this.local || relationOf(this.world, this.local, e.owner) === 'ally';
      const maxHp = Math.max(1, e.stats.maxHp);
      const damaged = e.hp < maxHp - 0.01;
      const showHp = !isRes && (mode === 'always' || sel || hov || (mode === 'damaged' && damaged));
      const cons = e.construction;
      const showCons = !!cons && friendly;
      const item = !cons && e.owner === this.local ? e.production?.queue[0] : undefined;
      const showProd = !!item && (mode !== 'selected' || sel || hov);
      const showRes = isRes && !!e.resource && (sel || hov);
      if (!showHp && !showCons && !showProd && !showRes) continue;

      // anchor above the model top
      this.v3a.set(v.x, v.rootY + Math.max(0.4, v.model.height) + 0.28, v.y);
      this.v3b.copy(this.v3a).applyMatrix4(cam.matrixWorldInverse);
      const depth = -this.v3b.z;
      if (depth <= cam.near) continue;
      this.v3a.project(cam);
      if (this.v3a.x < -1.1 || this.v3a.x > 1.1 || this.v3a.y < -1.1 || this.v3a.y > 1.15) continue;
      const sx = (this.v3a.x + 1) * 0.5 * W, sy = (1 - this.v3a.y) * 0.5 * H;
      const ppw = pxAtUnitDepth / depth;
      let worldW: number, minW: number, maxW: number, barH: number;
      if (e.kind === 'unit') { worldW = Math.max(0.9, e.radius * 2.3); minW = 24; maxW = 100; barH = 5; }
      else { const fp = (e.def as BuildingDef).footprint ?? { w: 2, h: 2 }; worldW = fp.w * 0.8; minW = 40; maxW = 170; barH = 6; }
      const w = Math.round(clamp(worldW * ppw, minW, maxW));
      const x = Math.round(sx - w / 2);
      let y = Math.round(sy - barH - 2);
      if (showHp) {
        const f = clamp(e.hp / maxHp, 0, 1);
        if (f >= 0.66) this.barColor.copy(this.cHigh);
        else if (f >= 0.33) this.barColor.lerpColors(this.cMid, this.cHigh, (f - 0.33) / 0.33);
        else this.barColor.lerpColors(this.cLow, this.cMid, f / 0.33);
        const seg = segmentHp(maxHp, w);
        bars.push(BarKind.Health, x, y, w, barH, f, maxHp / seg, Math.max(f, v.trail), this.barColor, 1);
        if ((e.gatherer?.carrying ?? 0) > 0) bars.push(BarKind.Cargo, x - 11, y - 3, 9, 11, 1, 0, 0, this.cCargo, 1);
        y += barH + 1;
      }
      if (showCons) {
        bars.push(BarKind.Progress, x, y, w, 4, clamp(cons!.progress / Math.max(1e-6, cons!.total), 0, 1), 0, 1, this.cCons, 0.95);
        y += 5;
      } else if (showProd) {
        bars.push(BarKind.Progress, x, y, w, 4, clamp(item!.progress / Math.max(1e-6, item!.total), 0, 1), 0, 1,
          item!.kind === 'upgrade' ? this.cResearch : this.cProd, 0.95);
        y += 5;
      }
      if (showRes) {
        const r = e.resource!;
        bars.push(BarKind.Progress, x, y, w, 4, clamp(r.amount / Math.max(1, r.initial), 0, 1), 0, 0, this.cRes, 0.95);
      }
    }
    bars.end(this.time);
  }

  // ───────────────────────── picking ─────────────────────────
  /** Canvas-relative pixel → terrain point (or null if off-map/sky). Pass `out` to avoid allocating. */
  screenToGround(sx: number, sy: number, out?: Vec2): Vec2 | null {
    screenRay(this.camera, sx, sy, this.width, this.height, this.rayO, this.rayD);
    const t = intersectTerrain(this.world.map, this.rayO, this.rayD, this.v3a);
    if (t < 0) return null;
    const p = this.v3a, map = this.world.map;
    if (p.x < 0 || p.z < 0 || p.x > map.width || p.z > map.height) return null;
    const res = out ?? { x: 0, y: 0 };
    res.x = p.x; res.y = p.z;
    return res;
  }

  /** World ground point (+ height above terrain) → canvas pixel. Pass `out` to avoid allocating. */
  worldToScreen(p: Vec2, height = 0, out?: ScreenPoint): ScreenPoint {
    return this.projectPoint(p.x, sampleHeight(this.world.map, p.x, p.y) + height, p.y, out ?? { x: 0, y: 0, visible: false });
  }

  /** Interpolated on-screen position of an entity (at `heightFrac` of its model height), or null if unknown. */
  entityToScreen(id: EntityId, heightFrac = 0.5, out?: ScreenPoint): ScreenPoint | null {
    const v = this.views.get(id);
    if (!v) return null;
    const r = this.projectPoint(v.x, v.rootY + v.model.height * heightFrac, v.y, out ?? { x: 0, y: 0, visible: false });
    r.visible = r.visible && v.visible && !v.dying;
    return r;
  }

  private projectPoint(x: number, y: number, z: number, out: ScreenPoint): ScreenPoint {
    const cam = this.camera;
    this.v3b.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
    const behind = -this.v3b.z <= cam.near;
    this.v3a.set(x, y, z).project(cam);
    out.x = (this.v3a.x + 1) / 2 * this.width;
    out.y = (1 - this.v3a.y) / 2 * this.height;
    out.visible = !behind && Math.abs(this.v3a.x) <= 1.05 && Math.abs(this.v3a.y) <= 1.05;
    return out;
  }

  /**
   * Entity under a canvas-relative pixel (visible to the local player). Ray vs. each entity's world box
   * (units padded to a minimum on-screen size); units win over buildings/resources, nearest hit wins
   * within a class; falls back to the closest unit centre within ~14 px.
   */
  pickEntity(sx: number, sy: number): Entity | null {
    screenRay(this.camera, sx, sy, this.width, this.height, this.rayO, this.rayD);
    const o = this.rayO, d = this.rayD;
    const ix = 1 / d.x, iy = 1 / d.y, iz = 1 / d.z;
    const tanHalf = Math.tan((this.camera.fov * DEG) / 2);
    const H = this.height;
    let bestUnit: EntityView | null = null, bestUnitT = Infinity;
    let bestOther: EntityView | null = null, bestOtherT = Infinity;
    const list = this.views.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i]!;
      if (!v.visible || v.dying || !v.entity.alive) continue;
      const e = v.entity;
      const h = Math.max(0.5, v.model.height);
      if (e.kind === 'unit') {
        const dist = Math.hypot(v.x - o.x, v.rootY - o.y, v.y - o.z);
        const worldPerPx = (2 * dist * tanHalf) / Math.max(1, H);
        const r = Math.max(e.radius * 1.05, 8 * worldPerPx);
        const t = rayAabb(o.x, o.y, o.z, ix, iy, iz, v.x - r, v.rootY - 0.1, v.y - r, v.x + r, v.rootY + h, v.y + r);
        if (t < bestUnitT) { bestUnitT = t; bestUnit = v; }
      } else {
        const fp = (e.def as BuildingDef).footprint ?? { w: 2, h: 2 };
        const x0 = e.tile ? e.tile.x : e.pos.x - fp.w / 2, z0 = e.tile ? e.tile.y : e.pos.y - fp.h / 2;
        const t = rayAabb(o.x, o.y, o.z, ix, iy, iz, x0 + 0.05, v.ground - 0.1, z0 + 0.05, x0 + fp.w - 0.05, v.ground + h, z0 + fp.h - 0.05);
        if (t < bestOtherT) { bestOtherT = t; bestOther = v; }
      }
    }
    if (bestUnit) return bestUnit.entity;
    if (bestOther) return bestOther.entity;
    // proximity fallback (thin silhouettes, fast movers)
    let best: EntityView | null = null, bd = 14 * 14;
    const sp = this.sp;
    for (let i = 0; i < list.length; i++) {
      const v = list[i]!;
      if (!v.visible || v.dying || !v.entity.alive || v.entity.kind !== 'unit') continue;
      this.projectPoint(v.x, v.rootY + v.model.height * 0.5, v.y, sp);
      if (!sp.visible) continue;
      const dd = (sp.x - sx) ** 2 + (sp.y - sy) ** 2;
      if (dd < bd) { bd = dd; best = v; }
    }
    return best ? best.entity : null;
  }

  /** Visible entities inside a canvas-relative rectangle (units count when their body touches it). */
  entitiesInScreenRect(x0: number, y0: number, x1: number, y1: number): Entity[] {
    const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1);
    const out: Entity[] = [];
    const cam = this.camera;
    const pxAtUnitDepth = this.height / (2 * Math.tan((cam.fov * DEG) / 2));
    const sp = this.sp;
    const list = this.views.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i]!;
      if (!v.visible || v.dying || !v.entity.alive) continue;
      const e = v.entity;
      const cy = v.rootY + Math.max(0.4, v.model.height) * 0.45;
      this.projectPoint(v.x, cy, v.y, sp);
      const depth = -this.v3b.z; // projectPoint left the view-space point in v3b
      if (depth <= cam.near) continue;
      const pad = e.kind === 'unit' ? clamp(e.radius * (pxAtUnitDepth / depth), 4, 60) * 0.6 : 0;
      if (sp.x >= lx - pad && sp.x <= hx + pad && sp.y >= ly - pad && sp.y <= hy + pad) out.push(e);
    }
    return out;
  }

  // ───────────────────────── feedback API ─────────────────────────
  setSelection(ids: readonly EntityId[]): void {
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.selectionIds = [...this.selection];
  }
  setHover(id: EntityId | null): void { this.hoverId = id ?? null; }
  setPlacementGhost(g: PlacementGhost | null): void { this.ghost.set(g); }
  /** Animated ground marker; with targetId the commanded entity flashes instead (e.g. attack target). */
  showCommandMarker(pos: Vec2, kind: CommandMarkerKind, targetId?: EntityId | null): void {
    this.feedback.addMarker(pos, kind, targetId ?? null);
  }
  getEntityModel(id: EntityId): EntityModel | undefined { return this.views.get(id)?.model; }
  /** Team colour helper for UI */
  factionColor(owner: PlayerId): number { const p = this.world.players.get(owner); return p?.color ?? FACTIONS.neutral.color; }
  /** Selection-ring colour (own / ally / enemy / neutral) for an owner, as 0xRRGGBB. */
  relationColor(owner: PlayerId): number { return RELATION_COLORS[relationOf(this.world, this.local, owner)]; }
  /** Draw-call / triangle counts of the last frame (for the FPS overlay). */
  getStats(): RenderStats {
    const r = this.three.info.render;
    return { calls: r.calls, triangles: r.triangles, views: this.views.size, bars: this.bars.barCount, decals: this.decals.quadCount, pixelRatio: this.pixelRatio, quality: this.quality };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.resize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    this.views.dispose();
    this.feedback.dispose();
    this.ghost.dispose();
    this.scene.remove(this.decals.mesh);
    this.decals.dispose();
    this.bars.dispose();
    this.cameraCtl.dispose();
    try { this.environment.dispose(); } catch (err) { warnOnce('env-dispose', 'environment.dispose threw', err); }
    try { this.vfx.dispose(); } catch (err) { warnOnce('vfx-dispose', 'vfx.dispose threw', err); }
    this.post.dispose();
    this.three.dispose();
  }
}
