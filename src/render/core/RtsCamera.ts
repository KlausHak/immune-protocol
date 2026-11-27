/**
 * [render-core] RTS camera controller (implements CameraApi).
 *
 * Input: arrow keys + screen-edge scrolling (speed ∝ zoom × settings.scrollSpeed), middle-drag "grab" pan,
 * damped wheel zoom (pitch steepens slightly when zoomed out), Alt+wheel / Alt+middle-drag yaw, Home resets
 * yaw. Letter keys are never consumed (Controls owns them) and keys are ignored while a text field has
 * focus. The ground focus is clamped so the view never shows much beyond the map edge, the look-at height
 * follows the terrain smoothly, and getViewPolygon() returns the exact terrain quad for the minimap.
 */
import * as THREE from 'three';
import { clamp, lerp } from '../../core/math';
import { sampleHeight } from '../../core/terrain';
import type { Vec2 } from '../../core/types';
import type { CameraApi } from '../../core/ui';
import type { Settings } from '../../game/settings';
import type { World } from '../../sim/World';
import { intersectPlaneY, intersectTerrain, ndcRay } from './picking';

const DEG = Math.PI / 180;

/** Tunables (world units / seconds / radians). */
export const CAMERA_LIMITS = {
  minDistance: 13,
  maxDistance: 60,
  defaultDistance: 34,
  /** pitch at min distance → max distance (steeper when zoomed out) */
  pitchNear: 51 * DEG,
  pitchFar: 61 * DEG,
  fov: 45,
  /** world units the view may extend beyond the map edge */
  edgeMargin: 2.5,
  /** NDC height used as the "bottom" of the view for clamping (the bottom HUD covers the rest) */
  clampBottomNdc: -0.55,
  /** pan speed (units/s) at the default distance, × settings.scrollSpeed */
  panSpeed: 30,
  edgePx: 6,
} as const;

type DragMode = 'pan' | 'rotate';

function isTextField(el: Element | EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export class RtsCamera implements CameraApi {
  /** ground focus point (sim coords) */
  readonly target: Vec2;
  /** current (smoothed) distance from the focus */
  distance: number = CAMERA_LIMITS.defaultDistance;
  /** current pitch (radians above the horizon), derived from distance */
  pitch: number = 56 * DEG;
  /** current yaw (radians); 0 = north (−y) is screen-up */
  yaw = 0;
  /** false disables user input (cinematics); scripted pans/shakes still work */
  inputEnabled = true;

  private goalDistance: number = CAMERA_LIMITS.defaultDistance;
  private goalYaw = 0;
  private focusHeight = 0;
  private vel = { x: 0, y: 0 };
  private keys = { left: false, right: false, up: false, down: false };
  private mouse = { x: -1, y: -1, inside: false };
  private rect = { left: 0, top: 0, width: 1, height: 1 };
  private drag: { mode: DragMode; lastX: number; lastY: number; anchor: THREE.Vector3; anchorY: number; moved: boolean } | null = null;
  private pan: { fromX: number; fromY: number; toX: number; toY: number; t: number; dur: number } | null = null;
  private shakeAmp = 0;
  private shakeLeft = 0;
  private shakeDur = 1;
  private shakePhase = [0, 0, 0];
  private time = 0;
  private readonly poly: Vec2[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  // scratch
  private readonly tmpO = new THREE.Vector3();
  private readonly tmpD = new THREE.Vector3();
  private readonly tmpP = new THREE.Vector3();

  constructor(private readonly cam: THREE.PerspectiveCamera, private readonly canvas: HTMLCanvasElement,
    private readonly world: World, private readonly settings: Settings) {
    this.target = { x: world.map.width / 2, y: world.map.height / 2 };
    this.focusHeight = this.groundAt(this.target.x, this.target.y);
    this.refreshRect();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('focusin', this.onFocusIn);
    document.documentElement.addEventListener('mouseleave', this.onMouseLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('auxclick', this.onAuxClick);
    this.applyPose();
  }

  // ───────────────────────── CameraApi ─────────────────────────
  /** Centre the view on p. immediate (default true) snaps; false glides there quickly. */
  lookAt(p: Vec2, immediate = true): void {
    if (!immediate) { this.panTo(p, 0.35); return; }
    this.pan = null;
    this.vel.x = this.vel.y = 0;
    this.target.x = p.x; this.target.y = p.y;
    this.clampTarget();
    this.focusHeight = this.groundAt(this.target.x, this.target.y);
    this.applyPose();
  }
  panTo(p: Vec2, seconds: number): void {
    if (!(seconds > 0.001)) { this.lookAt(p, true); return; }
    this.pan = { fromX: this.target.x, fromY: this.target.y, toX: p.x, toY: p.y, t: 0, dur: seconds };
  }
  getTarget(): Vec2 { return { x: this.target.x, y: this.target.y }; }
  /** Terrain quad visible on screen: [top-left, top-right, bottom-right, bottom-left] in world coords. */
  getViewPolygon(): Vec2[] { return this.poly.map((p) => ({ x: p.x, y: p.y })); }
  shake(intensity: number, seconds: number): void {
    if (!(intensity > 0) || !(seconds > 0)) return;
    // stack by taking the stronger remaining shake
    const cur = this.shakeLeft > 0 ? this.shakeAmp * (this.shakeLeft / this.shakeDur) : 0;
    if (intensity < cur) return;
    this.shakeAmp = intensity; this.shakeLeft = this.shakeDur = seconds;
    this.shakePhase = [Math.random() * 100, Math.random() * 100, Math.random() * 100];
  }

  // ───────────────────────── extras ─────────────────────────
  /** 0 = fully zoomed in, 1 = fully zoomed out */
  getZoom(): number { return (this.distance - CAMERA_LIMITS.minDistance) / (CAMERA_LIMITS.maxDistance - CAMERA_LIMITS.minDistance); }
  /** Set the zoom distance (clamped). */
  setDistance(d: number, immediate = false): void {
    this.goalDistance = clamp(d, CAMERA_LIMITS.minDistance, CAMERA_LIMITS.maxDistance);
    if (immediate) { this.distance = this.goalDistance; this.applyPose(); }
  }
  setYaw(yaw: number, immediate = false): void { this.goalYaw = yaw; if (immediate) { this.yaw = yaw; this.applyPose(); } }
  /** True while a middle-mouse pan/rotate drag is in progress (Controls may suppress hover/box-select). */
  get dragging(): boolean { return this.drag !== null; }
  /** Call when the canvas is resized/moved. */
  onResize(): void { this.refreshRect(); }

  update(dt: number): void {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt;
    const L = CAMERA_LIMITS;
    // ── zoom & yaw smoothing ──
    const kz = 1 - Math.exp(-dt * 10);
    this.distance += (this.goalDistance - this.distance) * kz;
    if (Math.abs(this.goalDistance - this.distance) < 1e-3) this.distance = this.goalDistance;
    const ky = 1 - Math.exp(-dt * 12);
    this.yaw += (this.goalYaw - this.yaw) * ky;
    const zt = this.getZoom();
    this.pitch = lerp(L.pitchNear, L.pitchFar, zt * zt * (3 - 2 * zt));

    // ── keyboard / edge scrolling ──
    let sx = 0, sy = 0; // screen-space direction: +x right, +y up
    if (this.inputEnabled && !this.drag) {
      if (!isTextField(document.activeElement)) {
        if (this.keys.left) sx -= 1;
        if (this.keys.right) sx += 1;
        if (this.keys.up) sy += 1;
        if (this.keys.down) sy -= 1;
      }
      if (this.settings.edgeScroll && this.mouse.inside && document.hasFocus()) {
        const m = L.edgePx, w = this.rect.width, h = this.rect.height, x = this.mouse.x, y = this.mouse.y;
        if (x >= 0 && x <= w && y >= 0 && y <= h) {
          if (x < m) sx -= 1; else if (x > w - m) sx += 1;
          if (y < m) sy += 1; else if (y > h - m) sy -= 1;
        }
      }
    }
    const len = Math.hypot(sx, sy);
    const speed = L.panSpeed * (this.settings.scrollSpeed || 1) * (this.distance / L.defaultDistance);
    let wantX = 0, wantY = 0;
    if (len > 0) {
      sx /= len; sy /= len;
      // screen right = (cos yaw, −sin yaw); screen up (forward) = (−sin yaw, −cos yaw) in sim coords
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      wantX = (sx * c - sy * s) * speed;
      wantY = (-sx * s - sy * c) * speed;
      this.pan = null;
    }
    const kv = 1 - Math.exp(-dt * (len > 0 ? 14 : 10));
    this.vel.x += (wantX - this.vel.x) * kv;
    this.vel.y += (wantY - this.vel.y) * kv;
    if (Math.abs(this.vel.x) + Math.abs(this.vel.y) < 1e-3) this.vel.x = this.vel.y = 0;
    this.target.x += this.vel.x * dt;
    this.target.y += this.vel.y * dt;

    // ── middle-drag grab pan: keep the anchor ground point under the cursor ──
    if (this.drag && this.drag.mode === 'pan' && this.drag.moved) {
      ndcRay(this.cam, (this.mouse.x / this.rect.width) * 2 - 1, -(this.mouse.y / this.rect.height) * 2 + 1, this.tmpO, this.tmpD);
      if (intersectPlaneY(this.tmpO, this.tmpD, this.drag.anchorY, this.tmpP) > 0) {
        this.target.x += this.drag.anchor.x - this.tmpP.x;
        this.target.y += this.drag.anchor.z - this.tmpP.z;
      }
      this.pan = null;
    }

    // ── scripted pan ──
    if (this.pan) {
      const p = this.pan;
      p.t += dt;
      const k = Math.min(1, p.t / p.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // easeInOutCubic
      this.target.x = lerp(p.fromX, p.toX, e);
      this.target.y = lerp(p.fromY, p.toY, e);
      if (k >= 1) this.pan = null;
    }

    this.clampTarget();
    // ── smooth terrain-height following (average a small cross to ignore bumps) ──
    const gh = this.groundAt(this.target.x, this.target.y);
    this.focusHeight += (gh - this.focusHeight) * (1 - Math.exp(-dt * 5));
    if (this.shakeLeft > 0) this.shakeLeft = Math.max(0, this.shakeLeft - dt);
    this.applyPose();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('focusin', this.onFocusIn);
    document.documentElement.removeEventListener('mouseleave', this.onMouseLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('auxclick', this.onAuxClick);
  }

  // ───────────────────────── internals ─────────────────────────
  private groundAt(x: number, y: number): number {
    const m = this.world.map, r = 2.5;
    return sampleHeight(m, x, y) * 0.4 + (sampleHeight(m, x - r, y) + sampleHeight(m, x + r, y) + sampleHeight(m, x, y - r) + sampleHeight(m, x, y + r)) * 0.15;
  }

  /** Positions the three.js camera from target/distance/pitch/yaw (+ shake) and refreshes the view polygon. */
  private applyPose(): void {
    const c = Math.cos(this.pitch) * this.distance, h = Math.sin(this.pitch) * this.distance;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let ox = 0, oy = 0, oz = 0;
    if (this.shakeLeft > 0) {
      const k = this.shakeLeft / this.shakeDur;
      const a = this.shakeAmp * k * k * (0.6 + 0.4 * this.distance / CAMERA_LIMITS.defaultDistance);
      const t = this.time, ph = this.shakePhase;
      ox = a * (Math.sin(t * 41.3 + ph[0]!) * 0.65 + Math.sin(t * 67.1 + ph[1]!) * 0.35);
      oy = a * 0.5 * Math.sin(t * 53.7 + ph[2]!);
      oz = a * (Math.sin(t * 47.9 + ph[1]!) * 0.65 + Math.sin(t * 71.3 + ph[0]!) * 0.35);
    }
    const tx = this.target.x + ox, ty = this.focusHeight + oy, tz = this.target.y + oz;
    this.cam.position.set(tx + sy * c, ty + h, tz + cy * c);
    this.cam.lookAt(tx, ty, tz);
    this.cam.updateMatrixWorld();
    this.updatePolygon();
  }

  private updatePolygon(): void {
    const map = this.world.map;
    const corners = [-1, 1, 1, 1, 1, -1, -1, -1];
    for (let i = 0; i < 4; i++) {
      ndcRay(this.cam, corners[i * 2]!, corners[i * 2 + 1]!, this.tmpO, this.tmpD);
      let t = intersectTerrain(map, this.tmpO, this.tmpD, this.tmpP);
      if (t < 0) t = intersectPlaneY(this.tmpO, this.tmpD, this.focusHeight, this.tmpP);
      const p = this.poly[i]!;
      if (t >= 0) { p.x = this.tmpP.x; p.y = this.tmpP.z; } else { p.x = this.target.x; p.y = this.target.y; }
    }
  }

  /**
   * Clamp the focus so the (flat-ground) view footprint stays within the map + margin. The footprint
   * offsets relative to the focus depend only on distance/pitch/yaw/aspect, so they are computed
   * analytically. The bottom edge uses clampBottomNdc because the bottom HUD hides the lowest rows.
   */
  private clampTarget(): void {
    const L = CAMERA_LIMITS, map = this.world.map;
    const d = this.distance, phi = this.pitch;
    const ty = Math.tan((this.cam.fov * DEG) / 2), tx = ty * (this.cam.aspect || 1);
    const sp = Math.sin(phi), cp = Math.cos(phi), s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
      const nx = i & 1 ? 1 : -1, ny = i < 2 ? 1 : L.clampBottomNdc;
      const den = sp - ny * ty * cp;
      // top rays always hit for pitch > fov/2; guard anyway
      const k = den > 0.05 ? (d * sp) / den : (d * sp) / 0.05;
      const R = k * nx * tx;
      const F = -d * cp + k * (cp + ny * ty * sp);
      const wx = R * c - F * s, wy = -R * s - F * c;
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
    }
    const m = L.edgeMargin;
    const loX = -m - minX, hiX = map.width + m - maxX;
    const loY = -m - minY, hiY = map.height + m - maxY;
    this.target.x = loX <= hiX ? clamp(this.target.x, loX, hiX) : (loX + hiX) / 2;
    this.target.y = loY <= hiY ? clamp(this.target.y, loY, hiY) : (loY + hiY) / 2;
  }

  private refreshRect(): void {
    const r = this.canvas.getBoundingClientRect();
    this.rect.left = r.left; this.rect.top = r.top;
    this.rect.width = Math.max(1, r.width || this.canvas.clientWidth || window.innerWidth);
    this.rect.height = Math.max(1, r.height || this.canvas.clientHeight || window.innerHeight);
  }

  // ───────────────────────── event handlers ─────────────────────────
  private setArrow(key: string, down: boolean): boolean {
    switch (key) {
      case 'ArrowLeft': this.keys.left = down; return true;
      case 'ArrowRight': this.keys.right = down; return true;
      case 'ArrowUp': this.keys.up = down; return true;
      case 'ArrowDown': this.keys.down = down; return true;
      default: return false;
    }
  }
  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTextField(e.target) || !this.inputEnabled) return;
    if (this.setArrow(e.key, true)) { e.preventDefault(); return; }
    if (e.key === 'Home' && !e.repeat) {
      e.preventDefault();
      this.goalYaw = Math.round(this.yaw / (Math.PI * 2)) * Math.PI * 2; // back to north-up the short way
    }
  };
  private onKeyUp = (e: KeyboardEvent): void => { this.setArrow(e.key, false); };
  private onBlur = (): void => {
    this.keys.left = this.keys.right = this.keys.up = this.keys.down = false;
    this.mouse.inside = false;
    this.drag = null;
  };
  private onFocusIn = (e: FocusEvent): void => {
    if (isTextField(e.target)) this.keys.left = this.keys.right = this.keys.up = this.keys.down = false;
  };
  private onMouseLeave = (): void => { this.mouse.inside = false; };
  private onMouseMove = (e: MouseEvent): void => {
    const nx = e.clientX - this.rect.left, ny = e.clientY - this.rect.top;
    const d = this.drag;
    if (d) {
      if (d.mode === 'rotate') {
        this.goalYaw -= (nx - d.lastX) * 0.006;
        this.yaw = this.goalYaw;
      }
      if (nx !== d.lastX || ny !== d.lastY) d.moved = true;
      d.lastX = nx; d.lastY = ny;
    }
    this.mouse.x = nx; this.mouse.y = ny; this.mouse.inside = true;
  };
  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 1 || !this.inputEnabled) return;
    e.preventDefault(); // no autoscroll
    this.refreshRect();
    const x = e.clientX - this.rect.left, y = e.clientY - this.rect.top;
    this.mouse.x = x; this.mouse.y = y; this.mouse.inside = true;
    const anchor = new THREE.Vector3();
    ndcRay(this.cam, (x / this.rect.width) * 2 - 1, -(y / this.rect.height) * 2 + 1, this.tmpO, this.tmpD);
    const ay = this.focusHeight;
    if (intersectPlaneY(this.tmpO, this.tmpD, ay, anchor) < 0) anchor.set(this.target.x, ay, this.target.y);
    this.drag = { mode: e.altKey ? 'rotate' : 'pan', lastX: x, lastY: y, anchor, anchorY: ay, moved: false };
    this.pan = null;
  };
  private onMouseUp = (e: MouseEvent): void => { if (e.button === 1) this.drag = null; };
  private onAuxClick = (e: MouseEvent): void => { if (e.button === 1) e.preventDefault(); };
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (!this.inputEnabled) return;
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 120 : e.deltaY;
    if (px === 0) return;
    if (e.altKey) {
      // a full notch rotates 15°, trackpads rotate proportionally
      const step = clamp(px / 100, -1, 1) * 15 * DEG;
      this.goalYaw += step;
      return;
    }
    this.goalDistance = clamp(this.goalDistance * Math.exp(clamp(px, -240, 240) * 0.0012), CAMERA_LIMITS.minDistance, CAMERA_LIMITS.maxDistance);
  };
}

