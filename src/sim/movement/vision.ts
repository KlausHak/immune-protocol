/**
 * [movement] Fog of war (VisionService) and the 'vision' system (order 60).
 *
 * One Uint8Array per player (0 unexplored · 1 explored · 2 visible), recomputed every VISION_INTERVAL
 * ticks (players staggered) into a scratch buffer from precomputed circle stamps (row spans keyed by
 * quarter-tile sight radius and half-tile centre offset), then committed only if something changed
 * (`version` increments). Own and allied units/buildings share vision.
 *
 * High ground: a ground source on level L only marks tiles with level ≤ L (ramps carry their high side's
 * level, so a unit on a ramp sees the plateau). Air units and timed reveals see every level.
 *
 * Enemy buildings / caches: visible while any footprint tile is visible; once seen (tracked per player in
 * `entity.ext.vision.seen`) they stay visible as remembered while their tiles are explored.
 */
import { NEUTRAL_PLAYER, type Entity, type PlayerId, type Vec2 } from '../../core/types';
import type { VisionService } from '../services';
import type { World } from '../World';
import { VISION_INTERVAL } from './constants';

interface Reveal { player: PlayerId; x: number; y: number; r: number; until: number }

/** entity.ext.vision */
export interface VisionExt {
  /** Bit (1 << playerId) set once that player has seen this structure. */
  seen: number;
  cacheVer: number;
  cachePid: number;
  cacheVal: boolean;
}

export class FogOfWar implements VisionService {
  private ver = 1;
  get version(): number { return this.ver; }

  private readonly W: number;
  private readonly H: number;
  private readonly N: number;
  private readonly levels: Uint8Array;
  private readonly grids = new Map<PlayerId, Uint8Array>();
  private readonly scratch: Uint8Array;
  private readonly revealed = new Set<PlayerId>();
  private reveals: Reveal[] = [];
  private readonly stamps = new Map<number, Int16Array>();
  private readonly dirty = new Set<PlayerId>();

  constructor(private readonly world: World) {
    this.W = world.map.width;
    this.H = world.map.height;
    this.N = this.W * this.H;
    this.levels = world.map.levels;
    this.scratch = new Uint8Array(this.N);
  }

  // ───────────────────────── VisionService ─────────────────────────

  fogGrid(playerId: PlayerId): Uint8Array {
    let g = this.grids.get(playerId);
    if (!g) {
      g = this.grid(playerId);
      if (playerId !== NEUTRAL_PLAYER && this.world.players.has(playerId) && !this.revealed.has(playerId)) this.recompute(playerId);
    }
    return g;
  }

  isVisible(playerId: PlayerId, p: Vec2): boolean {
    if (this.revealed.has(playerId)) return true;
    const i = this.tileOf(p.x, p.y);
    return i >= 0 && this.fogGrid(playerId)[i] === 2;
  }

  isExplored(playerId: PlayerId, p: Vec2): boolean {
    if (this.revealed.has(playerId)) return true;
    const i = this.tileOf(p.x, p.y);
    return i >= 0 && this.fogGrid(playerId)[i]! >= 1;
  }

  isEntityVisible(playerId: PlayerId, e: Entity): boolean {
    if (e.owner === playerId || this.allied(playerId, e.owner)) return true;
    if (this.revealed.has(playerId) || playerId === NEUTRAL_PLAYER || !this.world.players.has(playerId)) return true;
    const g = this.fogGrid(playerId);
    if (e.kind === 'unit' || !e.tile) {
      if (this.valAt(g, e.pos.x, e.pos.y) === 2) return true;
      if (e.radius > 1) {
        const k = e.radius * 0.7;
        return this.valAt(g, e.pos.x + k, e.pos.y) === 2 || this.valAt(g, e.pos.x - k, e.pos.y) === 2
          || this.valAt(g, e.pos.x, e.pos.y + k) === 2 || this.valAt(g, e.pos.x, e.pos.y - k) === 2;
      }
      return false;
    }
    const v = visionExt(e);
    if (v.cacheVer === this.ver && v.cachePid === playerId) return v.cacheVal;
    const bit = 1 << (playerId & 31);
    let vis: boolean;
    if (this.footprintAny(g, e, 2)) { v.seen |= bit; vis = true; }
    else vis = (v.seen & bit) !== 0 && this.footprintAny(g, e, 1);
    v.cacheVer = this.ver; v.cachePid = playerId; v.cacheVal = vis;
    return vis;
  }

  revealAll(playerId: PlayerId, on: boolean): void {
    if (on) {
      if (this.revealed.has(playerId)) return;
      this.revealed.add(playerId);
      this.grid(playerId).fill(2);
      this.ver++;
      this.recordSightings(playerId, this.grid(playerId));
    } else if (this.revealed.delete(playerId)) {
      this.grid(playerId).fill(1); // everything was on display: all of it is explored now
      this.ver++;
      if (playerId !== NEUTRAL_PLAYER && this.world.players.has(playerId)) this.recompute(playerId);
    }
  }

  revealArea(playerId: PlayerId, p: Vec2, radius: number, seconds: number): void {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !(radius > 0)) return;
    this.reveals.push({ player: playerId, x: p.x, y: p.y, r: radius, until: this.world.time + Math.max(0, seconds) });
    if (!this.revealed.has(playerId) && this.world.players.has(playerId) && playerId !== NEUTRAL_PLAYER) this.recompute(playerId);
  }

  // ───────────────────────── system ─────────────────────────

  /** The 'vision' system (order 60). */
  update(): void {
    const tick = this.world.tick, now = this.world.time;
    if (this.reveals.length > 0) {
      const keep: Reveal[] = [];
      for (const r of this.reveals) { if (r.until > now) keep.push(r); else this.dirty.add(r.player); }
      if (keep.length !== this.reveals.length) this.reveals = keep;
    }
    for (const p of this.world.players.values()) {
      if (p.id === NEUTRAL_PLAYER) continue;
      const due = (tick + p.id) % VISION_INTERVAL === 0;
      if (this.revealed.has(p.id)) { if (due) this.recordSightings(p.id, this.grid(p.id)); continue; }
      if (due || this.dirty.has(p.id)) { this.dirty.delete(p.id); this.recompute(p.id); }
    }
  }

  // ───────────────────────── internals ─────────────────────────

  private grid(pid: PlayerId): Uint8Array {
    let g = this.grids.get(pid);
    if (!g) {
      g = new Uint8Array(this.N);
      if (pid === NEUTRAL_PLAYER || !this.world.players.has(pid) || this.revealed.has(pid)) g.fill(2);
      this.grids.set(pid, g);
    }
    return g;
  }

  private allied(a: PlayerId, b: PlayerId): boolean {
    if (a === b) return true;
    if (a === NEUTRAL_PLAYER || b === NEUTRAL_PLAYER) return false;
    const pa = this.world.players.get(a), pb = this.world.players.get(b);
    return !!pa && !!pb && pa.team === pb.team;
  }

  private tileOf(x: number, y: number): number {
    const tx = Math.floor(x), ty = Math.floor(y);
    return tx < 0 || ty < 0 || tx >= this.W || ty >= this.H ? -1 : ty * this.W + tx;
  }

  private valAt(g: Uint8Array, x: number, y: number): number {
    const i = this.tileOf(x, y);
    return i < 0 ? 0 : g[i]!;
  }

  private footprintAny(g: Uint8Array, e: Entity, min: number): boolean {
    const t = e.tile!;
    const fp = e.def.kind === 'unit' ? { w: 1, h: 1 } : e.def.footprint;
    const x0 = Math.max(0, t.x), y0 = Math.max(0, t.y);
    const x1 = Math.min(this.W, t.x + fp.w), y1 = Math.min(this.H, t.y + fp.h);
    for (let y = y0; y < y1; y++) {
      const base = y * this.W;
      for (let x = x0; x < x1; x++) if (g[base + x]! >= min) return true;
    }
    return false;
  }

  private recompute(pid: PlayerId): void {
    const g = this.grid(pid), s = this.scratch, N = this.N;
    for (let i = 0; i < N; i++) s[i] = g[i] === 0 ? 0 : 1;
    const list = this.world.list;
    for (let k = 0; k < list.length; k++) {
      const e = list[k]!;
      if (!e.alive || e.kind === 'resource') continue;
      if (e.owner !== pid && !this.allied(pid, e.owner)) continue;
      const sight = e.stats.sight;
      if (!(sight > 0)) continue;
      const lvl = e.mover?.flying ? 255 : this.levelAt(e.pos.x, e.pos.y);
      this.stamp(s, e.pos.x, e.pos.y, sight, lvl);
    }
    for (const r of this.reveals) if (r.player === pid || this.allied(pid, r.player)) this.stamp(s, r.x, r.y, r.r, 255);
    let changed = false;
    for (let i = 0; i < N; i++) if (s[i] !== g[i]) { changed = true; break; }
    if (changed) { g.set(s); this.ver++; }
    this.recordSightings(pid, g);
  }

  private levelAt(x: number, y: number): number {
    const i = this.tileOf(x, y);
    return i < 0 ? 0 : this.levels[i]!;
  }

  /** Mark tiles within `R` of (px, py) visible (respecting the level cap `lvl`; 255 = sees all levels). */
  private stamp(s: Uint8Array, px: number, py: number, R: number, lvl: number): void {
    const qx = Math.round(px * 2) / 2, qy = Math.round(py * 2) / 2;
    const cx = Math.floor(qx), cy = Math.floor(qy);
    const fx = qx - cx, fy = qy - cy;
    const rq = Math.min(400, Math.round(R * 4));
    const key = rq * 4 + (fx ? 2 : 0) + (fy ? 1 : 0);
    let st = this.stamps.get(key);
    if (!st) { st = buildStamp(rq / 4, fx, fy); this.stamps.set(key, st); }
    const W = this.W, H = this.H, levels = this.levels, rows = st[0]!;
    for (let k = 0; k < rows; k++) {
      const y = cy + st[1 + k * 3]!;
      if (y < 0 || y >= H) continue;
      let xa = cx + st[2 + k * 3]!, xb = cx + st[3 + k * 3]!;
      if (xa < 0) xa = 0;
      if (xb > W - 1) xb = W - 1;
      const base = y * W;
      if (lvl >= 255) for (let x = xa; x <= xb; x++) s[base + x] = 2;
      else for (let x = xa; x <= xb; x++) if (levels[base + x]! <= lvl) s[base + x] = 2;
    }
  }

  /** Remember enemy structures / caches the player can currently see. */
  private recordSightings(pid: PlayerId, g: Uint8Array): void {
    const bit = 1 << (pid & 31);
    const list = this.world.list;
    for (let k = 0; k < list.length; k++) {
      const e = list[k]!;
      if (!e.alive || e.kind === 'unit' || !e.tile) continue;
      if (e.owner === pid || this.allied(pid, e.owner)) continue;
      const v = visionExt(e);
      if ((v.seen & bit) === 0 && this.footprintAny(g, e, 2)) v.seen |= bit;
    }
  }
}

function visionExt(e: Entity): VisionExt {
  let v = e.ext.vision as VisionExt | undefined;
  if (!v) { v = { seen: 0, cacheVer: -1, cachePid: -1, cacheVal: false }; e.ext.vision = v; }
  return v;
}

/** Row spans [count, dy, x0, x1, …] of tiles whose centres lie within R of (cx + fx, cy + fy). */
function buildStamp(R: number, fx: number, fy: number): Int16Array {
  const K = Math.ceil(R) + 1;
  const rows: number[] = [];
  for (let dy = -K; dy <= K; dy++) {
    const oy = dy + 0.5 - fy;
    const rem = R * R - oy * oy;
    if (rem < 0) continue;
    const half = Math.sqrt(rem);
    const x0 = Math.ceil(fx - half - 0.5), x1 = Math.floor(fx + half - 0.5);
    if (x1 >= x0) rows.push(dy, x0, x1);
  }
  const out = new Int16Array(1 + rows.length);
  out[0] = rows.length / 3;
  out.set(rows, 1);
  return out;
}
