/**
 * [ui] Minimap: terrain + fog + visible entities on a base canvas redrawn at ~10 Hz, and an overlay canvas
 * (camera view polygon + alert pings) redrawn per frame only while something changes.
 * Left click/drag → camera.lookAt · right click → smart command (units) / rally (buildings).
 */
import type { Entity, Vec2 } from '../../core/types';
import type { GameContext } from '../../game/contracts';
import { el } from '../dom';
import { layoutFor, renderTerrain, type MapLayout } from '../mapRender';

interface Ping { x: number; y: number; color: string; t: number; dur: number }

/** Optional hook the controls module may expose so minimap clicks complete a targeted command (A-click etc). */
interface MinimapTargeting { mode?: string; minimapCommand?(pos: Vec2, button: number, shift: boolean): boolean }

const BASE_HZ = 10;

export class Minimap {
  readonly el: HTMLDivElement;
  private wrap: HTMLDivElement;
  private base: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement | null = null;
  private layout: MapLayout;
  private fog: HTMLCanvasElement;
  private fogCtx: CanvasRenderingContext2D;
  private fogImg: ImageData;
  private fogVersion = -1;
  private fogPoll = 0;
  private size = 0;
  private acc = 1;
  private pings: Ping[] = [];
  private lastPoly = '';
  private dragging = false;
  private ro: ResizeObserver | null = null;
  private dirtySize = true;
  private hadPings = false;

  constructor(parent: HTMLElement, private game: GameContext) {
    this.el = el('div', 'ip-panel ip-minimap', parent);
    this.el.dataset.testid = 'minimap';
    this.wrap = el('div', 'ip-mm-wrap', this.el);
    this.base = el('canvas', 'ip-mm-base', this.wrap);
    this.over = el('canvas', 'ip-mm-over', this.wrap);
    el('div', 'ip-mm-corners', this.el);
    el('div', 'ip-mm-label', this.el, game.map.name);
    this.bctx = this.base.getContext('2d')!;
    this.octx = this.over.getContext('2d')!;
    const { width: W, height: H } = game.map;
    this.fog = document.createElement('canvas');
    this.fog.width = W; this.fog.height = H;
    this.fogCtx = this.fog.getContext('2d')!;
    this.fogImg = this.fogCtx.createImageData(W, H);
    this.layout = layoutFor(game.map, 1);

    this.over.addEventListener('pointerdown', this.onDown);
    this.over.addEventListener('pointermove', this.onMove);
    this.over.addEventListener('pointerup', this.onUp);
    this.over.addEventListener('pointercancel', this.onUp);
    this.over.addEventListener('contextmenu', (e) => e.preventDefault());
    this.over.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => { this.dirtySize = true; });
      this.ro.observe(this.wrap);
    }
  }

  /** Red (or custom) pulsing ping at a world position. */
  ping(pos: Vec2, color = 0xff4d5e): void {
    // merge with a live ping nearby instead of stacking rings
    for (const p of this.pings) if (Math.hypot(p.x - pos.x, p.y - pos.y) < 6 && p.t < p.dur * 0.5) { p.t = 0; return; }
    this.pings.push({ x: pos.x, y: pos.y, color: `#${(color & 0xffffff).toString(16).padStart(6, '0')}`, t: 0, dur: 3.2 });
    if (this.pings.length > 12) this.pings.shift();
  }

  update(dt: number): void {
    if (this.dirtySize) this.resize();
    if (this.size <= 0) return;
    this.acc += dt;
    if (this.acc >= 1 / BASE_HZ) { this.acc = 0; this.drawBase(); }
    this.drawOverlay(dt);
  }

  private resize(): void {
    this.dirtySize = false;
    const cssW = this.wrap.clientWidth;
    if (cssW <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = Math.round(cssW * dpr);
    if (s === this.size) return;
    this.size = s;
    for (const c of [this.base, this.over]) { c.width = s; c.height = s; }
    const r = renderTerrain(this.game.map, s);
    this.terrain = r.canvas;
    this.layout = r.layout;
    this.lastPoly = '';
    this.acc = 1;
  }

  private rebuildFog(): void {
    const vision = this.game.world.vision;
    const grid = vision.fogGrid(this.game.localPlayerId);
    const d = this.fogImg.data;
    const n = Math.min(grid.length, d.length / 4);
    for (let i = 0; i < n; i++) {
      const v = grid[i]!;
      d[i * 4] = 2; d[i * 4 + 1] = 6; d[i * 4 + 2] = 10;
      d[i * 4 + 3] = v === 2 ? 0 : v === 1 ? 135 : 255;
    }
    this.fogCtx.putImageData(this.fogImg, 0, 0);
  }

  private drawBase(): void {
    const ctx = this.bctx, L = this.layout, S = this.size;
    const g = this.game, w = g.world, local = g.localPlayerId;
    ctx.clearRect(0, 0, S, S);
    if (this.terrain) ctx.drawImage(this.terrain, 0, 0);

    // fog of war (soft edges via bilinear upscaling of the 1px-per-tile mask)
    const vision = w.vision;
    const ver = vision.version;
    this.fogPoll++;
    if (ver !== this.fogVersion || this.fogPoll >= 10) { this.fogVersion = ver; this.fogPoll = 0; this.rebuildFog(); }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fog, L.ox, L.oy, g.map.width * L.scale, g.map.height * L.scale);

    // entities: resources → buildings → units (units on top)
    const sel = new Set(g.controls?.selection?.ids ?? []);
    const dpr = S / Math.max(1, this.wrap.clientWidth);
    const units: Entity[] = [];
    for (const e of w.list) {
      if (!e.alive) continue;
      const mine = e.owner === local;
      if (!mine && !w.isAlly(local, e.owner) && !vision.isEntityVisible(local, e)) continue;
      if (e.kind === 'unit') { units.push(e); continue; }
      const r = w.footRect(e);
      if (!r) continue;
      const x = L.ox + r.x * L.scale, y = L.oy + r.y * L.scale, ww = Math.max(2, r.w * L.scale), hh = Math.max(2, r.h * L.scale);
      if (e.kind === 'resource') {
        ctx.fillStyle = '#ffc94d';
        ctx.fillRect(x + ww * 0.15, y + hh * 0.15, ww * 0.7, hh * 0.7);
        continue;
      }
      const col = this.colorOf(e.owner, mine);
      ctx.globalAlpha = e.construction ? 0.55 : 1;
      ctx.fillStyle = '#05090c';
      ctx.fillRect(x - dpr, y - dpr, ww + dpr * 2, hh + dpr * 2);
      ctx.fillStyle = sel.has(e.id) ? '#ffffff' : col;
      ctx.fillRect(x, y, ww, hh);
      ctx.globalAlpha = 1;
    }
    for (const e of units) {
      const x = L.ox + e.pos.x * L.scale, y = L.oy + e.pos.y * L.scale;
      const r = Math.max(1.5 * dpr, e.radius * L.scale * 1.1);
      ctx.fillStyle = '#05090c';
      ctx.fillRect(x - r - dpr * 0.6, y - r - dpr * 0.6, (r + dpr * 0.6) * 2, (r + dpr * 0.6) * 2);
      ctx.fillStyle = sel.has(e.id) ? '#ffffff' : this.colorOf(e.owner, e.owner === local);
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  private colorOf(owner: number, mine: boolean): string {
    if (mine) return '#3dfbe4';
    const p = this.game.world.players.get(owner);
    const c = p?.color ?? 0xc8c8c8;
    if (!this.game.world.isEnemy(this.game.localPlayerId, owner)) return `#${c.toString(16).padStart(6, '0')}`;
    return owner === this.game.enemyPlayerId ? '#ff4fd8' : `#${c.toString(16).padStart(6, '0')}`;
  }

  private drawOverlay(dt: number): void {
    const cam = this.game.renderer?.cameraCtl;
    let polyKey = '';
    let poly: Vec2[] = [];
    try { poly = cam ? cam.getViewPolygon() : []; } catch { poly = []; }
    const L = this.layout;
    const pts = poly.map((p) => ({ x: L.ox + p.x * L.scale, y: L.oy + p.y * L.scale }));
    for (const p of pts) polyKey += `${p.x.toFixed(1)},${p.y.toFixed(1)};`;
    for (const p of this.pings) p.t += dt;
    this.pings = this.pings.filter((p) => p.t < p.dur);
    if (polyKey === this.lastPoly && this.pings.length === 0 && !this.hadPings) return;
    this.hadPings = this.pings.length > 0;
    this.lastPoly = polyKey;

    const ctx = this.octx, S = this.size;
    ctx.clearRect(0, 0, S, S);
    const dpr = S / Math.max(1, this.wrap.clientWidth);
    if (pts.length >= 3) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.ox, L.oy, this.game.map.width * L.scale, this.game.map.height * L.scale);
      ctx.clip();
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fill();
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 3 * dpr;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(236,255,252,0.95)';
      ctx.lineWidth = 1.25 * dpr;
      ctx.stroke();
      ctx.restore();
    }
    for (const p of this.pings) {
      const x = L.ox + p.x * L.scale, y = L.oy + p.y * L.scale;
      const cycle = (p.t % 1) / 1;
      const fade = 1 - p.t / p.dur;
      for (const k of [0, 0.5]) {
        const c = (cycle + k) % 1;
        ctx.beginPath();
        ctx.arc(x, y, (3 + c * 15) * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = Math.max(0, (1 - c) * fade);
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();
      }
      ctx.globalAlpha = Math.min(1, fade * 1.5);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(x, y, 2.4 * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  private toWorld(e: PointerEvent): Vec2 {
    const r = this.over.getBoundingClientRect();
    const px = ((e.clientX - r.left) / Math.max(1, r.width)) * this.size;
    const py = ((e.clientY - r.top) / Math.max(1, r.height)) * this.size;
    const L = this.layout, m = this.game.map;
    return {
      x: Math.max(0, Math.min(m.width, (px - L.ox) / L.scale)),
      y: Math.max(0, Math.min(m.height, (py - L.oy) / L.scale)),
    };
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const g = this.game;
    const pos = this.toWorld(e);
    const ctl = g.controls as unknown as MinimapTargeting | undefined;
    // Targeted commands (A-click etc.) and ALL right-clicks go through the controls module so smart /
    // attack / rally logic lives in one place; local fallbacks only when that hook is missing.
    if (typeof ctl?.minimapCommand === 'function' && (e.button === 2 || (ctl.mode && ctl.mode !== 'normal'))) {
      try { if (ctl.minimapCommand(pos, e.button, e.shiftKey)) return; } catch (err) { console.error('[ui] minimapCommand failed', err); }
    }
    if (e.button === 0) {
      this.dragging = true;
      try { this.over.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      g.renderer?.cameraCtl?.lookAt(pos, true);
    } else if (e.button === 2) {
      this.smartCommand(pos, e.shiftKey);
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.game.renderer?.cameraCtl?.lookAt(this.toWorld(e), true);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    try { this.over.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  /** Right-click on the minimap: own units get a smart command, own buildings a rally point. */
  private smartCommand(pos: Vec2, queue: boolean): void {
    const g = this.game;
    const sel = g.controls?.selection?.entities() ?? [];
    const own = sel.filter((s) => s.owner === g.localPlayerId);
    const units = own.filter((s) => s.kind === 'unit').map((s) => s.id);
    const buildings = own.filter((s) => s.kind === 'building').map((s) => s.id);
    if (units.length) {
      g.issue({ type: 'smart', playerId: g.localPlayerId, unitIds: units, target: pos, queue });
      try { g.renderer?.showCommandMarker?.(pos, 'move'); } catch { /* optional */ }
    } else if (buildings.length) {
      g.issue({ type: 'setRally', playerId: g.localPlayerId, buildingIds: buildings, target: pos });
      try { g.renderer?.showCommandMarker?.(pos, 'rally'); } catch { /* optional */ }
    }
  }

  dispose(): void {
    this.ro?.disconnect();
    this.el.remove();
  }
}
