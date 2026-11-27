/**
 * [render-core] OWNER: render-core agent. WebGL renderer, post-processing, RTS camera, entity view sync
 * (interpolation, visibility, animation state), selection/hover visuals, health bars, placement ghost,
 * command markers and picking. The PUBLIC API below is a contract used by Controls, HUD, Game and VFX.
 */
import * as THREE from 'three';
import { DEFAULT_FLY_HEIGHT } from '../../config';
import { lerp, lerpAngle } from '../../core/math';
import { sampleHeight } from '../../core/terrain';
import type { BuildingDef, Entity, EntityId, PlayerId, TilePos, UnitDef, Vec2 } from '../../core/types';
import type { CameraApi } from '../../core/ui';
import { FACTIONS, getDef } from '../../data';
import type { Settings } from '../../game/settings';
import type { World } from '../../sim/World';
import { EnvironmentView } from '../environment';
import { createEntityModel, type EntityModel, type ModelAnimState } from '../models';
import { VfxSystem } from '../vfx';

export interface GameRendererOptions {
  canvas: HTMLCanvasElement;
  world: World;
  localPlayerId: PlayerId;
  settings: Settings;
}

export type CommandMarkerKind = 'move' | 'attack' | 'rally' | 'gather' | 'build';
export interface PlacementGhost { defId: string; tile: TilePos; valid: boolean }

interface EntityView { entity: Entity; model: EntityModel; deathT: number; dying: boolean }

/** Minimal RTS camera (render-core agent replaces with the full controller). */
export class RtsCamera implements CameraApi {
  target: Vec2;
  distance = 34;
  pitch = THREE.MathUtils.degToRad(56);
  yaw = 0;
  private keys = new Set<string>();
  private mouse = { x: -1, y: -1, inside: false };
  private pan: { from: Vec2; to: Vec2; t: number; dur: number } | null = null;
  private shakeT = 0; private shakeI = 0;
  constructor(private cam: THREE.PerspectiveCamera, private canvas: HTMLCanvasElement, private world: World, private settings: Settings) {
    this.target = { x: world.map.width / 2, y: world.map.height / 2 };
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('mousemove', this.onMove);
  }
  private onKey = (e: KeyboardEvent) => { if (e.key.startsWith('Arrow')) { if (e.type === 'keydown') this.keys.add(e.key); else this.keys.delete(e.key); } };
  private onWheel = (e: WheelEvent) => { e.preventDefault(); this.distance = THREE.MathUtils.clamp(this.distance * (e.deltaY > 0 ? 1.1 : 0.9), 14, 70); };
  private onMove = (e: MouseEvent) => { const r = this.canvas.getBoundingClientRect(); this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top, inside: true }; };
  lookAt(p: Vec2): void { this.target = { x: p.x, y: p.y }; this.pan = null; }
  panTo(p: Vec2, seconds: number): void { this.pan = { from: { ...this.target }, to: { ...p }, t: 0, dur: Math.max(0.01, seconds) }; }
  getTarget(): Vec2 { return { ...this.target }; }
  shake(intensity: number, seconds: number): void { this.shakeI = intensity; this.shakeT = seconds; }
  getViewPolygon(): Vec2[] {
    const pts: Vec2[] = [];
    const ray = new THREE.Raycaster(); const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); const hit = new THREE.Vector3();
    for (const [x, y] of [[-1, 1], [1, 1], [1, -1], [-1, -1]] as const) {
      ray.setFromCamera(new THREE.Vector2(x, y), this.cam);
      if (ray.ray.intersectPlane(plane, hit)) pts.push({ x: hit.x, y: hit.z }); else pts.push({ ...this.target });
    }
    return pts;
  }
  update(dt: number): void {
    const speed = 28 * this.settings.scrollSpeed * (this.distance / 34) * dt;
    let dx = 0, dy = 0;
    if (this.keys.has('ArrowLeft')) dx -= 1; if (this.keys.has('ArrowRight')) dx += 1;
    if (this.keys.has('ArrowUp')) dy -= 1; if (this.keys.has('ArrowDown')) dy += 1;
    if (this.settings.edgeScroll && this.mouse.inside && document.hasFocus()) {
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight, m = 6;
      if (this.mouse.x >= 0 && this.mouse.x < m) dx -= 1; if (this.mouse.x > w - m && this.mouse.x <= w) dx += 1;
      if (this.mouse.y >= 0 && this.mouse.y < m) dy -= 1; if (this.mouse.y > h - m && this.mouse.y <= h) dy += 1;
    }
    if (dx || dy) { this.pan = null; this.target.x += dx * speed; this.target.y += dy * speed; }
    if (this.pan) {
      this.pan.t += dt; const k = Math.min(1, this.pan.t / this.pan.dur), s = k * k * (3 - 2 * k);
      this.target = { x: lerp(this.pan.from.x, this.pan.to.x, s), y: lerp(this.pan.from.y, this.pan.to.y, s) };
      if (k >= 1) this.pan = null;
    }
    const map = this.world.map;
    this.target.x = THREE.MathUtils.clamp(this.target.x, 0, map.width);
    this.target.y = THREE.MathUtils.clamp(this.target.y, 0, map.height);
    const gh = sampleHeight(map, this.target.x, this.target.y);
    const off = new THREE.Vector3(0, Math.sin(this.pitch) * this.distance, Math.cos(this.pitch) * this.distance);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    let sx = 0, sy = 0;
    if (this.shakeT > 0) { this.shakeT -= dt; sx = (Math.random() - 0.5) * this.shakeI; sy = (Math.random() - 0.5) * this.shakeI; }
    this.cam.position.set(this.target.x + off.x + sx, gh + off.y + sy, this.target.y + off.z);
    this.cam.lookAt(this.target.x + sx, gh, this.target.y);
  }
  dispose(): void {
    window.removeEventListener('keydown', this.onKey); window.removeEventListener('keyup', this.onKey);
    this.canvas.removeEventListener('wheel', this.onWheel); window.removeEventListener('mousemove', this.onMove);
  }
}

export class GameRenderer {
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly cameraCtl: RtsCamera;
  readonly environment: EnvironmentView;
  readonly vfx: VfxSystem;
  private views = new Map<EntityId, EntityView>();
  private selection = new Set<EntityId>();
  private rings = new Map<EntityId, THREE.Mesh>();
  private ringGeo = new THREE.RingGeometry(0.85, 1, 32).rotateX(-Math.PI / 2);
  private ghost: THREE.Mesh | null = null;
  private markers: Array<{ mesh: THREE.Mesh; t: number }> = [];
  private unsub: Array<() => void> = [];
  private time = 0;
  private readonly world: World;
  private readonly local: PlayerId;

  constructor(private opts: GameRendererOptions) {
    this.world = opts.world; this.local = opts.localPlayerId;
    this.three = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, powerPreference: 'high-performance' });
    this.three.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.three.shadowMap.enabled = true;
    this.three.shadowMap.type = THREE.PCFSoftShadowMap;
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 400);
    this.cameraCtl = new RtsCamera(this.camera, opts.canvas, this.world, opts.settings);
    const quality = opts.settings.quality;
    this.environment = new EnvironmentView({ scene: this.scene, renderer: this.three, camera: this.camera, world: this.world, map: this.world.map, localPlayerId: this.local, quality });
    this.vfx = new VfxSystem({ scene: this.scene, camera: this.camera, world: this.world, localPlayerId: this.local, quality, getEntityModel: (id) => this.views.get(id)?.model, heightAt: (x, y) => sampleHeight(this.world.map, x, y) });
    const me = this.world.players.get(this.local);
    if (me) this.cameraCtl.lookAt(me.startPos);
    for (const e of this.world.list) if (e.alive) this.addView(e);
    this.unsub.push(
      this.world.events.on('entitySpawned', ({ entity }) => this.addView(entity)),
      this.world.events.on('entityDied', ({ entity }) => { const v = this.views.get(entity.id); if (v) v.dying = true; }),
      this.world.events.on('entityRemoved', ({ entity, reason }) => { if (reason === 'removed') this.removeView(entity.id); }),
    );
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  private addView(e: Entity): void {
    if (this.views.has(e.id)) return;
    const p = this.world.players.get(e.owner);
    const def = e.def;
    const model = createEntityModel({
      defId: e.defId, faction: def.kind === 'resource' ? 'neutral' : def.faction, teamColor: new THREE.Color(p?.color ?? 0xcccccc),
      radius: e.radius, footprint: def.kind === 'unit' ? undefined : (def as BuildingDef).footprint, seed: e.id,
    });
    model.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.scene.add(model.root);
    this.views.set(e.id, { entity: e, model, deathT: 0, dying: false });
  }
  private removeView(id: EntityId): void {
    const v = this.views.get(id); if (!v) return;
    this.scene.remove(v.model.root); v.model.dispose(); this.views.delete(id);
    const r = this.rings.get(id); if (r) { this.scene.remove(r); this.rings.delete(id); }
  }

  render(alpha: number, dtReal: number): void {
    this.time += dtReal;
    this.cameraCtl.update(dtReal);
    const map = this.world.map;
    for (const [id, v] of this.views) {
      const e = v.entity;
      if (v.dying) { v.deathT += dtReal / 1.2; if (v.deathT >= 1) { this.removeView(id); continue; } }
      const x = lerp(e.prevPos.x, e.pos.x, alpha), y = lerp(e.prevPos.y, e.pos.y, alpha);
      const fly = e.mover?.flying ? (e.def as UnitDef).flyHeight ?? DEFAULT_FLY_HEIGHT : 0;
      const root = v.model.root;
      root.position.set(x, sampleHeight(map, x, y) + fly - (v.dying && !v.model.handlesDeath ? v.deathT * 1.5 : 0), y);
      root.rotation.y = -lerpAngle(e.prevFacing, e.facing, alpha);
      root.visible = e.owner === this.local || this.world.vision.isEntityVisible(this.local, e) || v.dying;
      const target = e.combat?.targetId != null ? this.world.getAlive(e.combat.targetId) : undefined;
      const st: ModelAnimState = {
        moving: !!e.mover?.moving, speed: e.mover ? Math.hypot(e.mover.vel.x, e.mover.vel.y) : 0, activity: e.activity,
        sinceAttack: e.combat && e.combat.lastAttackTime >= 0 ? this.world.time - e.combat.lastAttackTime : Infinity,
        construction: e.construction ? e.construction.progress / e.construction.total : 1,
        hpFrac: e.hp / Math.max(1, e.stats.maxHp), carrying: (e.gatherer?.carrying ?? 0) > 0,
        producing: (e.production?.queue.length ?? 0) > 0 && !e.construction, selected: this.selection.has(id),
        death: v.dying ? v.deathT : 0, aimAngle: target ? Math.atan2(target.pos.y - e.pos.y, target.pos.x - e.pos.x) : null, facing: e.facing,
      };
      v.model.update(st, dtReal, this.time);
      const ring = this.rings.get(id);
      if (ring) { ring.position.set(x, root.position.y - fly + 0.05, y); ring.visible = root.visible && !v.dying; }
    }
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i]!; m.t += dtReal; m.mesh.scale.setScalar(1 - m.t * 0.8);
      if (m.t > 0.8) { this.scene.remove(m.mesh); this.markers.splice(i, 1); }
    }
    this.environment.update(dtReal, this.time, this.cameraCtl.getTarget());
    this.vfx.update(dtReal, this.time, alpha);
    this.three.render(this.scene, this.camera);
  }

  resize = (): void => {
    const c = this.opts.canvas;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    this.three.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  };

  /** Canvas-relative pixel → ground point (or null if off-map/sky). */
  screenToGround(sx: number, sy: number): Vec2 | null {
    const c = this.opts.canvas;
    const ndc = new THREE.Vector2((sx / c.clientWidth) * 2 - 1, -(sy / c.clientHeight) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    if (hit.x < 0 || hit.z < 0 || hit.x > this.world.map.width || hit.z > this.world.map.height) return null;
    return { x: hit.x, y: hit.z };
  }
  worldToScreen(p: Vec2, height = 0): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(p.x, sampleHeight(this.world.map, p.x, p.y) + height, p.y).project(this.camera);
    const c = this.opts.canvas;
    return { x: (v.x + 1) / 2 * c.clientWidth, y: (1 - v.y) / 2 * c.clientHeight, visible: v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05 };
  }
  /** Entity under a canvas-relative pixel (visible to the local player). */
  pickEntity(sx: number, sy: number): Entity | null {
    let best: Entity | null = null, bd = Infinity;
    for (const v of this.views.values()) {
      const e = v.entity;
      if (!e.alive || !v.model.root.visible) continue;
      const s = this.worldToScreen(e.pos, v.model.height * 0.5);
      const rpx = Math.max(14, (e.radius / this.cameraCtl.distance) * this.opts.canvas.clientHeight * 1.6);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < rpx && d < bd) { bd = d; best = e; }
    }
    return best;
  }
  entitiesInScreenRect(x0: number, y0: number, x1: number, y1: number): Entity[] {
    const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1);
    const out: Entity[] = [];
    for (const v of this.views.values()) {
      const e = v.entity;
      if (!e.alive || !v.model.root.visible) continue;
      const s = this.worldToScreen(e.pos, v.model.height * 0.4);
      if (s.x >= lx && s.x <= hx && s.y >= ly && s.y <= hy) out.push(e);
    }
    return out;
  }
  setSelection(ids: readonly EntityId[]): void {
    this.selection = new Set(ids);
    for (const [id, r] of this.rings) if (!this.selection.has(id)) { this.scene.remove(r); this.rings.delete(id); }
    for (const id of ids) {
      if (this.rings.has(id)) continue;
      const e = this.world.get(id); if (!e) continue;
      const own = e.owner === this.local, enemy = this.world.isEnemy(this.local, e.owner);
      const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: own ? 0x46ff9a : enemy ? 0xff4b4b : 0xffe066, transparent: true, opacity: 0.9, depthWrite: false }));
      ring.scale.setScalar(e.radius * 1.15 + 0.1);
      this.scene.add(ring); this.rings.set(id, ring);
    }
  }
  setHover(_id: EntityId | null): void {}
  setPlacementGhost(g: PlacementGhost | null): void {
    if (!g) { if (this.ghost) { this.scene.remove(this.ghost); this.ghost = null; } return; }
    const def = getDef(g.defId) as BuildingDef;
    if (!this.ghost) {
      this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false }));
      this.scene.add(this.ghost);
    }
    const { w, h } = def.footprint;
    this.ghost.scale.set(w, 1.2, h);
    const cx = g.tile.x + w / 2, cy = g.tile.y + h / 2;
    this.ghost.position.set(cx, sampleHeight(this.world.map, cx, cy) + 0.6, cy);
    (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(g.valid ? 0x3dff8a : 0xff3d3d);
  }
  showCommandMarker(pos: Vec2, kind: CommandMarkerKind): void {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: kind === 'attack' ? 0xff4040 : kind === 'gather' ? 0xffd040 : 0x40ff90, transparent: true, depthWrite: false }));
    m.position.set(pos.x, sampleHeight(this.world.map, pos.x, pos.y) + 0.06, pos.y);
    this.scene.add(m); this.markers.push({ mesh: m, t: 0 });
  }
  getEntityModel(id: EntityId): EntityModel | undefined { return this.views.get(id)?.model; }
  /** Team colour helper for UI */
  factionColor(owner: PlayerId): number { const p = this.world.players.get(owner); return p?.color ?? FACTIONS.neutral.color; }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    for (const u of this.unsub) u();
    for (const id of [...this.views.keys()]) this.removeView(id);
    this.cameraCtl.dispose(); this.environment.dispose(); this.vfx.dispose();
    this.three.dispose();
  }
}
