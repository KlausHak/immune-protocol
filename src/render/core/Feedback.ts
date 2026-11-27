/**
 * [render-core] Visual feedback pushed into the ground-decal batch each frame: selection rings (units) and
 * rounded footprint rectangles (buildings/resources) in relation colours, hover highlight, animated command
 * markers (move / attack / rally / gather / build / patrol / repair), target flashes, and rally flags with an
 * animated dashed line for selected own buildings.
 */
import * as THREE from 'three';
import { sampleHeight } from '../../core/terrain';
import type { BuildingDef, EntityId, PlayerId, Vec2 } from '../../core/types';
import type { World } from '../../sim/World';
import type { EntityView, EntityViews } from './EntityViews';
import { DecalKind, type GroundDecals } from './GroundDecals';
import { MARKER_COLORS, RELATION_COLORS, relationOf, type Relation } from './palette';

export type CommandMarkerKind = 'move' | 'attack' | 'rally' | 'gather' | 'build' | 'patrol' | 'repair';

interface Marker { x: number; y: number; kind: CommandMarkerKind; t: number; dur: number; targetId: EntityId | null; seq: number }

const MARKER_DECAL: Record<CommandMarkerKind, number> = {
  move: DecalKind.Move, attack: DecalKind.Attack, rally: DecalKind.Pulse, gather: DecalKind.Pulse,
  build: DecalKind.Build, patrol: DecalKind.Patrol, repair: DecalKind.Plus,
};
const MARKER_DURATION: Record<CommandMarkerKind, number> = {
  move: 0.65, attack: 0.7, rally: 0.9, gather: 0.75, build: 0.8, patrol: 0.8, repair: 0.8,
};
const MAX_MARKERS = 24;

export class Feedback {
  private readonly markers: Marker[] = [];
  private seq = 0;
  private readonly relColor: Record<Relation, THREE.Color>;
  private readonly markerColor: Record<CommandMarkerKind, THREE.Color>;
  // rally flags
  private readonly flagGroup = new THREE.Group();
  private readonly flags: THREE.Group[] = [];
  private flagsUsed = 0;
  private readonly poleGeo: THREE.BufferGeometry;
  private readonly knobGeo: THREE.BufferGeometry;
  private readonly clothGeo: THREE.BufferGeometry;
  private readonly poleMat: THREE.MeshStandardMaterial;
  private readonly clothMat: THREE.MeshStandardMaterial;
  private readonly flagTime = { value: 0 };

  constructor(private readonly scene: THREE.Scene, private readonly world: World, private readonly local: PlayerId,
    private readonly views: EntityViews, private readonly decals: GroundDecals) {
    this.relColor = {
      own: new THREE.Color(RELATION_COLORS.own), ally: new THREE.Color(RELATION_COLORS.ally),
      enemy: new THREE.Color(RELATION_COLORS.enemy), neutral: new THREE.Color(RELATION_COLORS.neutral),
    };
    this.markerColor = {
      move: new THREE.Color(MARKER_COLORS.move), attack: new THREE.Color(MARKER_COLORS.attack), rally: new THREE.Color(MARKER_COLORS.rally),
      gather: new THREE.Color(MARKER_COLORS.gather), build: new THREE.Color(MARKER_COLORS.build), patrol: new THREE.Color(MARKER_COLORS.patrol),
      repair: new THREE.Color(MARKER_COLORS.repair),
    };
    // ── rally flag parts (shared by all pooled flags) ──
    this.poleGeo = new THREE.CylinderGeometry(0.035, 0.05, 1.9, 6).translate(0, 0.95, 0);
    this.knobGeo = new THREE.SphereGeometry(0.08, 10, 6).translate(0, 1.93, 0);
    const cloth = new THREE.PlaneGeometry(0.8, 0.46, 8, 1).translate(0.4, 1.6, 0);
    this.clothGeo = cloth;
    this.poleMat = new THREE.MeshStandardMaterial({ color: 0xe3e9ec, metalness: 0.55, roughness: 0.35 });
    const team = new THREE.Color(world.players.get(local)?.color ?? 0x2fd6c6);
    this.clothMat = new THREE.MeshStandardMaterial({ color: team, emissive: team, emissiveIntensity: 0.55, roughness: 0.75, side: THREE.DoubleSide });
    const flagTime = this.flagTime;
    this.clothMat.onBeforeCompile = (shader) => {
      shader.uniforms.uFlagTime = flagTime;
      shader.vertexShader = 'uniform float uFlagTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        float flagK = clamp(position.x / 0.8, 0.0, 1.0);
        transformed.z += sin(position.x * 7.5 - uFlagTime * 6.5) * 0.085 * flagK;
        transformed.y += sin(position.x * 5.0 - uFlagTime * 4.0) * 0.025 * flagK;`);
    };
    this.flagGroup.name = 'render-core:rally-flags';
    scene.add(this.flagGroup);
  }

  addMarker(pos: Vec2, kind: CommandMarkerKind, targetId: EntityId | null = null): void {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    if (!(kind in MARKER_DECAL)) kind = 'move';
    let m: Marker;
    if (this.markers.length >= MAX_MARKERS) {
      // recycle the oldest
      let oldest = 0;
      for (let i = 1; i < this.markers.length; i++) if (this.markers[i]!.seq < this.markers[oldest]!.seq) oldest = i;
      m = this.markers[oldest]!;
    } else {
      m = { x: 0, y: 0, kind, t: 0, dur: 1, targetId: null, seq: 0 };
      this.markers.push(m);
    }
    m.x = pos.x; m.y = pos.y; m.kind = kind; m.t = 0; m.dur = MARKER_DURATION[kind]; m.targetId = targetId; m.seq = ++this.seq;
  }

  relationColor(owner: PlayerId): THREE.Color { return this.relColor[relationOf(this.world, this.local, owner)]; }

  /** Push this frame's selection/hover/marker/rally decals. markerScale grows markers when zoomed out. */
  update(dt: number, time: number, selection: ReadonlySet<EntityId>, selectionList: readonly EntityId[], hoverId: EntityId | null, markerScale: number): void {
    const decals = this.decals;
    // ── selection ──
    for (let i = 0; i < selectionList.length; i++) {
      const id = selectionList[i]!;
      const v = this.views.get(id);
      if (!v || v.dying || !v.visible) continue;
      this.pushRing(v, id === hoverId ? 'selectedHover' : 'selected', time);
    }
    if (hoverId != null && !selection.has(hoverId)) {
      const v = this.views.get(hoverId);
      if (v && !v.dying && v.visible) this.pushRing(v, 'hover', time);
    }
    // ── markers ──
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i]!;
      m.t += dt / m.dur;
      if (m.t >= 1) { this.markers[i] = this.markers[this.markers.length - 1]!; this.markers.pop(); continue; }
      const col = this.markerColor[m.kind];
      const tv = m.targetId != null ? this.views.get(m.targetId) : undefined;
      if (tv && tv.visible && !tv.dying) {
        // flash a ring around the commanded target instead of a ground marker
        const blink = Math.cos(m.t * Math.PI * 6) * 0.5 + 0.5;
        this.pushEntityShape(tv, col, 1.7, (0.35 + 0.65 * blink) * (1 - m.t * m.t), 0.09, 0.3, 0);
        continue;
      }
      const R = (m.kind === 'build' ? 0.8 : 0.95) * markerScale;
      decals.quad(m.x, m.y, R, R, R * 0.45, 0, R, 0, col, 1.6, 1, MARKER_DECAL[m.kind], m.t, 0, 0, 0.06);
    }
    // ── rally points of selected own buildings ──
    this.flagsUsed = 0;
    this.flagTime.value = time;
    for (let i = 0; i < selectionList.length; i++) {
      const id = selectionList[i]!;
      const v = this.views.get(id);
      if (!v || v.dying || v.entity.kind !== 'building' || v.entity.owner !== this.local) continue;
      const rally = v.entity.rally;
      if (!rally) continue;
      let rx = rally.pos.x, ry = rally.pos.y;
      const tv = rally.targetId != null ? this.views.get(rally.targetId) : undefined;
      if (tv && tv.visible && !tv.dying) { rx = tv.x; ry = tv.y; }
      this.pushRallyLine(v, rx, ry, tv && tv.entity.kind === 'resource' ? this.markerColor.gather : this.markerColor.rally);
      if (!tv || tv.entity.kind === 'building' || tv.entity.kind === 'resource') this.placeFlag(rx, ry, time);
      decals.quad(rx, ry, 0.55, 0.55, 0.25, 0, 0.55, 0, this.markerColor.rally, 1.4, 0.7, DecalKind.Pulse, (time * 0.7) % 1, 0, 0, 0.06);
    }
    for (let i = this.flagsUsed; i < this.flags.length; i++) this.flags[i]!.visible = false;
  }

  /** Selection/hover outline sized to the entity (circle for units, footprint rectangle otherwise). */
  private pushRing(v: EntityView, mode: 'selected' | 'hover' | 'selectedHover', time: number): void {
    const col = this.relationColor(v.entity.owner);
    if (mode === 'hover') {
      const a = 0.55 + 0.15 * Math.sin(time * 6);
      this.pushEntityShape(v, col, 1.3, a, 0.05, 0, 1);
    } else {
      this.pushEntityShape(v, col, mode === 'selectedHover' ? 1.75 : 1.3, 1, 0, 0.32, 0);
    }
  }

  /** dashed: 0 = solid; 1 = auto dash count. thicknessAdd widens the stroke. */
  private pushEntityShape(v: EntityView, col: THREE.Color, boost: number, alpha: number, thicknessAdd: number, rim: number, dashed: number): void {
    const e = v.entity;
    if (e.kind === 'unit') {
      const r = e.radius * 1.12 + 0.14;
      const th = 0.07 + thicknessAdd * 0.6;
      const dashes = dashed ? Math.max(8, Math.round(r * 9)) : 0;
      this.decals.quad(v.x, v.y, r, r, 0.12, 0, r, th, col, boost, alpha, DecalKind.Ring, 0, rim, dashes, 0.05);
    } else {
      const fp = (e.def as BuildingDef).footprint ?? { w: 2, h: 2 };
      const hw = fp.w / 2 + 0.28, hh = fp.h / 2 + 0.28;
      const th = 0.085 + thicknessAdd * 0.6;
      const dashes = dashed ? Math.max(12, Math.round((hw + hh) * 4)) : 0;
      const sub = Math.max(1, Math.min(6, Math.ceil(Math.max(hw, hh) / 2.5)));
      this.decals.quad(e.pos.x, e.pos.y, hw, hh, 0.14, 0, Math.min(0.6, Math.min(hw, hh) * 0.5), th, col, boost, alpha, DecalKind.Ring, 0, rim * 0.6, dashes, 0.05, sub);
    }
  }

  private pushRallyLine(v: EntityView, rx: number, ry: number, col: THREE.Color): void {
    const e = v.entity;
    const fp = (e.def as BuildingDef).footprint ?? { w: 2, h: 2 };
    let dx = rx - e.pos.x, dy = ry - e.pos.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return;
    dx /= len; dy /= len;
    // start at the footprint edge
    const tExit = Math.min(Math.abs(dx) > 1e-4 ? fp.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-4 ? fp.h / 2 / Math.abs(dy) : Infinity);
    const start = Math.min(len, tExit + 0.15);
    const end = len - 0.25;
    if (end <= start) return;
    const n = Math.max(1, Math.ceil((end - start) / 0.9));
    const step = (end - start) / n;
    for (let i = 0; i < n; i++) {
      const s0 = start + step * i, s1 = s0 + step;
      this.decals.segment(e.pos.x + dx * s0, e.pos.y + dy * s0, e.pos.x + dx * s1, e.pos.y + dy * s1, 0.07, s0, 0.6, 1.4, col, 1.5, 0.9);
    }
  }

  private placeFlag(x: number, y: number, time: number): void {
    let f = this.flags[this.flagsUsed];
    if (!f) {
      f = new THREE.Group();
      const pole = new THREE.Mesh(this.poleGeo, this.poleMat);
      const knob = new THREE.Mesh(this.knobGeo, this.poleMat);
      const cloth = new THREE.Mesh(this.clothGeo, this.clothMat);
      pole.castShadow = knob.castShadow = cloth.castShadow = true;
      f.add(pole, knob, cloth);
      this.flags.push(f);
      this.flagGroup.add(f);
    }
    this.flagsUsed++;
    f.visible = true;
    f.position.set(x, sampleHeight(this.world.map, x, y), y);
    f.rotation.y = 0.6 + Math.sin(time * 0.7 + x) * 0.15;
  }

  dispose(): void {
    this.scene.remove(this.flagGroup);
    this.poleGeo.dispose(); this.knobGeo.dispose(); this.clothGeo.dispose();
    this.poleMat.dispose(); this.clothMat.dispose();
  }
}
