/**
 * [campaign] Mission scripting toolkit for "Code Red: Meilahti". OWNER: campaign agent.
 *
 * Headless-safe (no DOM / three.js): missions run in Node tests with ui = camera = null, and every
 * random choice goes through world.rng, so a fixed seed replays identically.
 *
 *   MissionScript ─┬─ refs        named map points/regions with sensible fallbacks (warns once per name)
 *                  ├─ triggers    after / at / every / when / onEvent / onEnterRegion / onDeath / onAllDead …
 *                  ├─ objectives  primary & bonus objectives, progress text → ui.setObjectives
 *                  ├─ dialogue    paced dialogue queue → ui.showDialogue (history kept for tests)
 *                  ├─ hints, camera cues, fog reveal, minimap pings
 *                  ├─ spawn helpers (units/buildings at named points, tagged with scriptTags)
 *                  ├─ AI control + difficulty-scaled scripted waves, kept marching by a "shepherd"
 *                  └─ mission countdown timer, victory / defeat → world.endGame (Game shows the end screen)
 *
 *   ScriptedMission  base class implementing MissionRunner on top of a MissionScript; a mission only
 *                    writes build() (spawns + triggers, runs in setup()) and intro() (dialogue/camera, attach()).
 *
 * Event-driven triggers are *deferred*: the event handler only records the payload and the callback runs
 * at the start of the next mission update (before world.step), so scripts never spawn/kill entities in
 * the middle of a simulation system.
 */
import { clamp, dist, pointInRect } from '../core/math';
import { footprintCenter, footprintTileAt, inBounds, tileIndex } from '../core/terrain';
import type {
  Difficulty, Entity, EntityId, GameEvents, GameEventType, LightingPreset, MapRegion, PlayerId, TilePos, Vec2,
} from '../core/types';
import type { CameraApi, DialogueLine, GameUi, NotifyKind, ObjectiveState, ObjectiveView, PortraitId } from '../core/ui';
import { tryGetDef } from '../data';
import type { AiController, AiFlags } from '../ai';
import { spawnMapResources } from '../sim/setup';
import type { World } from '../sim/World';
import type { MissionContext, MissionInfo, MissionRunner, MissionState } from './index';

// ═════════════════════════════════════════ small helpers ═════════════════════════════════════════

/** Point at `angle` (radians, sim convention) and distance `r` from `c`. */
export const polar = (c: Vec2, angle: number, r: number): Vec2 => ({ x: c.x + Math.cos(angle) * r, y: c.y + Math.sin(angle) * r });
export const lerpPoint = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const regionCenter = (r: MapRegion): Vec2 => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const squareRegion = (c: Vec2, size: number): MapRegion => ({ x: c.x - size / 2, y: c.y - size / 2, w: size, h: size });

/** "12:05" style clock. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ═════════════════════════════════════════ difficulty ═════════════════════════════════════════

/** Multiplier applied to scripted enemy counts. Missions are authored at the 'normal' baseline. */
export const DIFFICULTY_SCALE: Record<Difficulty, number> = { easy: 0.6, normal: 1, hard: 1.35, brutal: 1.7 };

export interface PerDifficulty<T> { easy: T; normal: T; hard: T; brutal?: T }
/** Pick a per-difficulty value ('brutal' falls back to 'hard'). */
export function byDifficulty<T>(d: Difficulty, table: PerDifficulty<T>): T {
  if (d === 'brutal') return table.brutal !== undefined ? table.brutal : table.hard;
  return table[d];
}
/** Scale an enemy count by difficulty; any non-zero count stays ≥ `min`. */
export function scaleCount(n: number, d: Difficulty, min = 1): number {
  if (n <= 0) return 0;
  return Math.max(min, Math.round(n * DIFFICULTY_SCALE[d]));
}

/** unit def id → count */
export type Composition = Record<string, number>;
export function scaleComposition(comp: Composition, d: Difficulty): Composition {
  const out: Composition = {};
  for (const [id, n] of Object.entries(comp)) { const k = scaleCount(n, d); if (k > 0) out[id] = k; }
  return out;
}
export function mergeComposition(...comps: Array<Composition | null | undefined>): Composition {
  const out: Composition = {};
  for (const c of comps) if (c) for (const [id, n] of Object.entries(c)) out[id] = (out[id] ?? 0) + n;
  return out;
}
export const compositionSize = (comp: Composition): number => Object.values(comp).reduce((a, b) => a + b, 0);

// ═════════════════════════════════════════ cast ═════════════════════════════════════════

export type CastId = 'cmo' | 'sisu' | 'paramedic' | 'engineer' | 'omega';
export const CAST: Record<CastId, { speaker: string; portrait: PortraitId }> = {
  cmo: { speaker: 'Dr. Aino Virtanen, Chief Medical Officer', portrait: 'cmo' },
  sisu: { speaker: 'SISU, Campus Defence AI', portrait: 'sisu' },
  paramedic: { speaker: 'Lt. Joonas Mäkelä, Paramedics', portrait: 'paramedic' },
  engineer: { speaker: 'Leena Korhonen, Chief Engineer', portrait: 'engineer' },
  omega: { speaker: '▒ STRAIN OMEGA ▒', portrait: 'omega' },
};
/** Longest allowed dialogue line (the dialogue box is sized for it). */
export const MAX_LINE_LENGTH = 160;
/** Build a dialogue line for a cast member. */
export function line(who: CastId, text: string, duration?: number): DialogueLine {
  const c = CAST[who];
  return duration != null ? { speaker: c.speaker, portrait: c.portrait, text, duration } : { speaker: c.speaker, portrait: c.portrait, text };
}

// ═════════════════════════════════════════ map references ═════════════════════════════════════════

const warnedRefs = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warnedRefs.has(key)) return;
  warnedRefs.add(key);
  console.warn(msg);
}

/** Frame used to derive fallbacks on maps that lack a name: P = player start, E = enemy start. */
interface RefFrame { P: Vec2; E: Vec2; u: Vec2; v: Vec2; D: number; C: Vec2 }
/** P + a·D along P→E + b·D along the perpendicular (+b = "east" side when the enemy is to the north). */
const along = (f: RefFrame, a: number, b: number): Vec2 => ({
  x: f.P.x + f.u.x * a * f.D + f.v.x * b * f.D,
  y: f.P.y + f.u.y * a * f.D + f.v.y * b * f.D,
});

/** Other names (points first, then regions → centre) tried before computing a fallback. */
const POINT_ALIASES: Record<string, string[]> = {
  player_start: ['player_base'],
  enemy_start: ['enemy_core', 'enemy_base'],
  rally_center: ['center'],
  center: ['rally_center'],
  east_nest_core: ['enemy_east_nest'],
  west_nest_core: ['enemy_west_nest'],
  childrens_hospital_center: ['childrens_hospital'],
  wave_spawn_north: ['north_gate'],
  wave_spawn_east: ['east_gate'],
};
const REGION_ALIASES: Record<string, string[]> = { enemy_core: ['enemy_base'], enemy_base: ['enemy_core'] };

type PointRecipe = (f: RefFrame, refs: MapRefs) => Vec2;
type RegionRecipe = (f: RefFrame, refs: MapRefs) => MapRegion;
const POINT_FALLBACKS: Record<string, PointRecipe> = {
  player_start: (f) => f.P,
  enemy_start: (f) => f.E,
  rally_center: (f) => f.C,
  center: (f) => f.C,
  helipad: (f) => along(f, -0.04, 0.09),
  wave_spawn_north: (f) => along(f, 0.58, -0.17),
  wave_spawn_east: (f) => along(f, 0.58, 0.17),
  wave_spawn_west: (f) => along(f, 0.36, -0.3),
  omega_spawn: (f) => along(f, 0.8, -0.1),
  east_nest_core: (f) => along(f, 0.62, 0.28),
  west_nest_core: (f) => along(f, 0.7, -0.3),
  childrens_hospital_center: (f) => along(f, 0.33, -0.15),
};
const REGION_FALLBACKS: Record<string, RegionRecipe> = {
  player_base: (f) => squareRegion(f.P, 26),
  player_natural: (f) => squareRegion(along(f, 0.2, 0.2), 14),
  enemy_core: (_f, r) => squareRegion(r.point('enemy_start'), 22),
  enemy_base: (_f, r) => squareRegion(r.point('enemy_start'), 22),
  enemy_natural: (f) => squareRegion(along(f, 0.8, 0.2), 14),
  enemy_east_nest: (_f, r) => squareRegion(r.point('east_nest_core'), 14),
  enemy_west_nest: (_f, r) => squareRegion(r.point('west_nest_core'), 14),
  childrens_hospital: (_f, r) => squareRegion(r.point('childrens_hospital_center'), 12),
  paramedic_station: (f) => squareRegion(along(f, 0.12, -0.26), 8),
  center: (f) => squareRegion(f.C, 16),
  north_gate: (_f, r) => squareRegion(r.point('wave_spawn_north'), 10),
  east_gate: (_f, r) => squareRegion(r.point('wave_spawn_east'), 10),
};

/**
 * Named point/region lookup that never fails: real map data first, then aliases, then a fallback
 * computed from the player/enemy slots and the map size (console.warn once per map + name).
 */
export class MapRefs {
  private frame: RefFrame;
  private pointCache = new Map<string, Vec2>();
  private regionCache = new Map<string, MapRegion>();

  constructor(private world: World, playerId: PlayerId, enemyId: PlayerId) {
    const map = world.map;
    const slotStart = (id: PlayerId) => map.slots.find((s) => s.id === id)?.start;
    const P = slotStart(playerId) ?? map.points.player_start ?? { x: map.width * 0.25, y: map.height * 0.75 };
    const E = slotStart(enemyId) ?? map.points.enemy_start ?? { x: map.width * 0.75, y: map.height * 0.25 };
    const D = Math.max(1, dist(P, E));
    const u = { x: (E.x - P.x) / D, y: (E.y - P.y) / D };
    this.frame = { P: { ...P }, E: { ...E }, u, v: { x: -u.y, y: u.x }, D, C: { x: map.width / 2, y: map.height / 2 } };
  }

  hasPoint(name: string): boolean { return !!this.world.map.points[name]; }
  hasRegion(name: string): boolean { return !!this.world.map.regions[name]; }

  /** World position of a named point (or the centre of a same-named region). Always returns a fresh copy. */
  point(name: string): Vec2 {
    let p = this.pointCache.get(name);
    if (!p) {
      p = this.resolvePoint(name);
      this.pointCache.set(name, p);
    }
    return { x: p.x, y: p.y };
  }

  /** World rect of a named region. Always returns a fresh copy. */
  region(name: string): MapRegion {
    let r = this.regionCache.get(name);
    if (!r) {
      r = this.resolveRegion(name);
      this.regionCache.set(name, r);
    }
    return { ...r };
  }

  private resolvePoint(name: string): Vec2 {
    const { points, regions } = this.world.map;
    const direct = points[name];
    if (direct) return { ...direct };
    for (const alias of POINT_ALIASES[name] ?? []) {
      const ap = points[alias];
      if (ap) return { ...ap };
      const ar = regions[alias];
      if (ar) return regionCenter(ar);
    }
    if (regions[name]) return regionCenter(regions[name]!);
    const recipe = POINT_FALLBACKS[name];
    const p = this.clampPoint(recipe ? recipe(this.frame, this) : this.frame.C);
    warnOnce(`${this.world.map.id}:p:${name}`,
      `[campaign] map "${this.world.map.id}" has no point "${name}" — using fallback (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
    return p;
  }

  private resolveRegion(name: string): MapRegion {
    const { regions } = this.world.map;
    const direct = regions[name];
    if (direct) return { ...direct };
    for (const alias of REGION_ALIASES[name] ?? []) { const ar = regions[alias]; if (ar) return { ...ar }; }
    const recipe = REGION_FALLBACKS[name];
    const r = recipe ? recipe(this.frame, this) : squareRegion(this.hasPoint(name) ? this.point(name) : this.frame.C, 12);
    const map = this.world.map;
    const x = clamp(r.x, 1, map.width - 2), y = clamp(r.y, 1, map.height - 2);
    const out = { x, y, w: Math.min(r.w, map.width - 1 - x), h: Math.min(r.h, map.height - 1 - y) };
    warnOnce(`${map.id}:r:${name}`,
      `[campaign] map "${map.id}" has no region "${name}" — using fallback {x:${out.x.toFixed(1)}, y:${out.y.toFixed(1)}, w:${out.w.toFixed(1)}, h:${out.h.toFixed(1)}}`);
    return out;
  }

  private clampPoint(p: Vec2): Vec2 {
    const m = 4, map = this.world.map;
    return { x: clamp(p.x, m, map.width - m), y: clamp(p.y, m, map.height - m) };
  }
}

// ═════════════════════════════════════════ triggers ═════════════════════════════════════════

export interface Trigger {
  readonly id: number;
  readonly name: string;
  /** false once a one-shot trigger has fired or the trigger was cancelled */
  readonly active: boolean;
  readonly fired: number;
  cancel(): void;
}

interface TimeSpec { kind: 'time'; next: number; period: number; remaining: number }
interface WhenSpec { kind: 'when'; pred: () => boolean; interval: number; next: number; repeat: boolean; cooldown: number }
interface EventSpec { kind: 'event'; repeat: boolean; off: () => void }

class TriggerImpl implements Trigger {
  status: 'armed' | 'consumed' | 'cancelled' = 'armed';
  fired = 0;
  constructor(readonly id: number, readonly name: string, readonly spec: TimeSpec | WhenSpec | EventSpec, readonly fn: () => void) {}
  get active(): boolean { return this.status === 'armed'; }
  cancel(): void {
    if (this.status === 'cancelled') return;
    this.status = 'cancelled';
    if (this.spec.kind === 'event') this.spec.off();
  }
}

export interface WhenOptions {
  /** keep firing every time the predicate holds (default false = one-shot) */
  repeat?: boolean;
  /** seconds between predicate polls (default 0 = every tick) */
  interval?: number;
  /** minimum seconds between two firings of a repeating trigger */
  cooldown?: number;
  name?: string;
}

/** Time-, predicate- and event-driven triggers. Driven by MissionScript.update() with mission time. */
export class TriggerEngine {
  /** current mission time (seconds since the mission started) */
  time = 0;
  errors = 0;
  private list: TriggerImpl[] = [];
  private deferred: Array<{ trig: TriggerImpl; run: () => void }> = [];
  private nextId = 1;
  private pruneCounter = 0;

  constructor(private world: World) {}

  /** One-shot at absolute mission time `t`. */
  at(t: number, fn: () => void, name = 'at'): Trigger {
    return this.add(name, { kind: 'time', next: t, period: 0, remaining: 1 }, fn);
  }
  /** One-shot `seconds` from now. */
  after(seconds: number, fn: () => void, name = 'after'): Trigger {
    return this.at(this.time + Math.max(0, seconds), fn, name);
  }
  /** Repeating every `seconds` (first firing after `start` seconds, default = `seconds`), optionally `times` times. */
  every(seconds: number, fn: () => void, opts: { start?: number; times?: number; name?: string } = {}): Trigger {
    const period = Math.max(this.world.dt, seconds);
    return this.add(opts.name ?? 'every', { kind: 'time', next: this.time + (opts.start ?? period), period, remaining: opts.times ?? Infinity }, fn);
  }
  /** Fires when `pred()` becomes true (polled). */
  when(pred: () => boolean, fn: () => void, opts: WhenOptions = {}): Trigger {
    return this.add(opts.name ?? 'when', {
      kind: 'when', pred, interval: Math.max(0, opts.interval ?? 0), next: this.time, repeat: !!opts.repeat, cooldown: Math.max(0, opts.cooldown ?? 0),
    }, fn);
  }
  /** Fires on a world event whose payload passes `filter` (callback deferred to the next mission update). */
  onEvent<K extends GameEventType>(
    type: K, filter: ((p: GameEvents[K]) => boolean) | null, fn: (p: GameEvents[K]) => void,
    opts: { repeat?: boolean; name?: string } = {},
  ): Trigger {
    const repeat = !!opts.repeat;
    let trig: TriggerImpl | null = null;
    const handler = (p: GameEvents[K]): void => {
      if (!trig || trig.status !== 'armed') return;
      let ok = true;
      if (filter) {
        try { ok = filter(p); } catch (err) { this.fail(trig.name, err); ok = false; }
      }
      if (!ok) return;
      if (!repeat) { trig.status = 'consumed'; spec.off(); }
      const t = trig;
      this.deferred.push({ trig: t, run: () => fn(p) });
    };
    const spec: EventSpec = { kind: 'event', repeat, off: () => {} };
    trig = this.add(opts.name ?? `on:${String(type)}`, spec, () => {}) as TriggerImpl;
    spec.off = this.world.events.on(type, handler);
    return trig;
  }

  update(time: number): void {
    this.time = time;
    // 1) deferred event callbacks, in arrival order
    if (this.deferred.length) {
      const q = this.deferred;
      this.deferred = [];
      for (const { trig, run } of q) {
        if (trig.status === 'cancelled') continue;
        trig.fired++;
        this.safe(trig.name, run);
      }
    }
    // 2) polled triggers in creation order (triggers added during this pass start next update)
    const n = this.list.length;
    for (let i = 0; i < n; i++) {
      const t = this.list[i]!;
      if (t.status !== 'armed') continue;
      const s = t.spec;
      if (s.kind === 'time') {
        if (time + 1e-9 < s.next) continue;
        s.remaining--;
        if (s.remaining <= 0 || s.period <= 0) t.status = 'consumed';
        else s.next += s.period;
        t.fired++;
        this.safe(t.name, t.fn);
      } else if (s.kind === 'when') {
        if (time + 1e-9 < s.next) continue;
        s.next = time + s.interval;
        let hit = false;
        try { hit = s.pred(); } catch (err) { this.fail(t.name, err); hit = false; }
        if (!hit) continue;
        if (!s.repeat) t.status = 'consumed';
        else s.next = time + Math.max(s.interval, s.cooldown);
        t.fired++;
        this.safe(t.name, t.fn);
      }
    }
    if (++this.pruneCounter >= 100) { this.pruneCounter = 0; this.list = this.list.filter((t) => t.status === 'armed'); }
  }

  /** Cancel everything (unsubscribes event listeners). */
  dispose(): void {
    for (const t of this.list) t.cancel();
    this.list = [];
    this.deferred = [];
  }

  /** Number of armed triggers (debug/tests). */
  get armed(): number { return this.list.filter((t) => t.status === 'armed').length; }

  private add(name: string, spec: TimeSpec | WhenSpec | EventSpec, fn: () => void): Trigger {
    const t = new TriggerImpl(this.nextId++, name, spec, fn);
    this.list.push(t);
    return t;
  }
  private safe(name: string, fn: () => void): void {
    try { fn(); } catch (err) { this.fail(name, err); }
  }
  private fail(name: string, err: unknown): void {
    this.errors++;
    console.error(`[campaign] trigger "${name}" threw`, err);
  }
}

// ═════════════════════════════════════════ objectives ═════════════════════════════════════════

export type ObjectiveStatus = 'hidden' | ObjectiveState;
export interface ObjectiveSpec { id: string; text: string; primary?: boolean; hidden?: boolean; progress?: string }
export interface Objective { readonly id: string; text: string; primary: boolean; status: ObjectiveStatus; progress?: string }
export type ObjectiveChange = 'added' | 'revealed' | 'done' | 'failed' | 'progress' | 'text';

/**
 * Primary & bonus objectives. Hidden objectives are planned but not shown yet (they still count for
 * allPrimaryDone(), so a chain declared up-front can't produce a premature victory).
 */
export class ObjectiveManager {
  /** bumps on every visible change — MissionScript pushes ui.setObjectives when it changes */
  version = 0;
  private list: Objective[] = [];
  private listeners: Array<(o: Objective, change: ObjectiveChange) => void> = [];

  add(spec: ObjectiveSpec): Objective {
    const existing = this.get(spec.id);
    if (existing) return existing;
    const o: Objective = { id: spec.id, text: spec.text, primary: spec.primary ?? true, status: spec.hidden ? 'hidden' : 'active', progress: spec.progress };
    this.list.push(o);
    this.changed(o, 'added');
    return o;
  }
  get(id: string): Objective | undefined { return this.list.find((o) => o.id === id); }
  status(id: string): ObjectiveStatus | undefined { return this.get(id)?.status; }
  isActive(id: string): boolean { return this.status(id) === 'active'; }
  isDone(id: string): boolean { return this.status(id) === 'done'; }
  isFailed(id: string): boolean { return this.status(id) === 'failed'; }
  isHidden(id: string): boolean { return this.status(id) === 'hidden'; }

  /** hidden → active. Returns true if it changed. */
  reveal(id: string): boolean {
    const o = this.get(id);
    if (!o || o.status !== 'hidden') return false;
    o.status = 'active';
    this.changed(o, 'revealed');
    return true;
  }
  /** hidden/active → done. Returns true if it changed. */
  complete(id: string): boolean {
    const o = this.get(id);
    if (!o || o.status === 'done' || o.status === 'failed') return false;
    o.status = 'done';
    this.changed(o, 'done');
    return true;
  }
  /** hidden/active → failed. Returns true if it changed. */
  fail(id: string): boolean {
    const o = this.get(id);
    if (!o || o.status === 'done' || o.status === 'failed') return false;
    o.status = 'failed';
    this.changed(o, 'failed');
    return true;
  }
  setProgress(id: string, progress: string | undefined): void {
    const o = this.get(id);
    if (!o || o.progress === progress) return;
    o.progress = progress;
    this.changed(o, 'progress');
  }
  setText(id: string, text: string): void {
    const o = this.get(id);
    if (!o || o.text === text) return;
    o.text = text;
    this.changed(o, 'text');
  }

  /** Visible objectives, primaries first (in declaration order), then bonus objectives. */
  views(): ObjectiveView[] {
    const vis = this.list.filter((o) => o.status !== 'hidden');
    const toView = (o: Objective): ObjectiveView => {
      const v: ObjectiveView = { id: o.id, text: o.text, state: o.status as ObjectiveState, primary: o.primary };
      if (o.progress) v.progress = o.progress;
      return v;
    };
    return [...vis.filter((o) => o.primary), ...vis.filter((o) => !o.primary)].map(toView);
  }
  all(): readonly Objective[] { return this.list; }
  /** Every primary objective (hidden ones included) is done — and there is at least one. */
  allPrimaryDone(): boolean {
    const prim = this.list.filter((o) => o.primary);
    return prim.length > 0 && prim.every((o) => o.status === 'done');
  }
  activePrimaries(): Objective[] { return this.list.filter((o) => o.primary && o.status === 'active'); }
  onChange(fn: (o: Objective, change: ObjectiveChange) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }

  private changed(o: Objective, change: ObjectiveChange): void {
    if (o.status !== 'hidden' || change === 'revealed') this.version++;
    for (const l of this.listeners) {
      try { l(o, change); } catch (err) { console.error('[campaign] objective listener threw', err); }
    }
  }
}

// ═════════════════════════════════════════ dialogue ═════════════════════════════════════════

export interface SayOptions {
  /** play before anything already queued (after the line currently on screen) */
  urgent?: boolean;
  /** drop the line(s) if they could not start within this many seconds (time-sensitive barks) */
  expires?: number;
  /** runs when the last line of this batch has finished (or was dropped) */
  then?: () => void;
}
interface QueuedLine { line: DialogueLine; duration: number; queuedAt: number; expiresAt: number; then?: () => void }

/**
 * Paced dialogue queue. Lines are handed to ui.showDialogue one at a time with an explicit duration,
 * so the script knows exactly when a conversation ends (camera cues, `then` callbacks). Without a UI
 * (headless) lines still "play" on the same clock and are recorded in `history`.
 */
export class DialogueQueue {
  static readonly GAP = 0.4;
  /** Seconds a line stays up: base + reading time, clamped. */
  static durationOf(l: DialogueLine): number {
    return l.duration ?? clamp(2.2 + l.text.length / 17, 3.2, 9);
  }

  ui: GameUi | null = null;
  time = 0;
  errors = 0;
  readonly history: Array<{ time: number; line: DialogueLine }> = [];
  private queue: QueuedLine[] = [];
  private current: QueuedLine | null = null;
  private freeAt = 0;

  /** Queue line(s). Returns the estimated seconds from now until they have finished playing. */
  say(lines: DialogueLine | DialogueLine[], opts: SayOptions = {}): number {
    const arr = Array.isArray(lines) ? lines : [lines];
    const expiresAt = opts.expires != null ? this.time + opts.expires : Infinity;
    const entries: QueuedLine[] = arr.map((l) => {
      const duration = DialogueQueue.durationOf(l);
      return { line: { ...l, duration }, duration, queuedAt: this.time, expiresAt };
    });
    if (entries.length === 0) {
      if (opts.then) this.queue.push({ line: { speaker: '', text: '' }, duration: 0, queuedAt: this.time, expiresAt: -1, then: opts.then });
      return 0;
    }
    entries[entries.length - 1]!.then = opts.then;
    if (opts.urgent) this.queue.unshift(...entries); else this.queue.push(...entries);
    // ETA: what has to play before the last of these entries, plus the entries themselves
    const ahead = opts.urgent ? [] : this.queue.slice(0, this.queue.length - entries.length);
    const curLeft = this.current ? Math.max(0, this.freeAt - this.time) : 0;
    const sum = (q: QueuedLine[]) => q.reduce((a, e) => a + (e.expiresAt < 0 ? 0 : e.duration + DialogueQueue.GAP), 0);
    return curLeft + sum(ahead) + sum(entries);
  }

  update(time: number): void {
    this.time = time;
    if (this.current && time + 1e-9 >= this.freeAt) {
      const done = this.current;
      this.current = null;
      if (done.then) this.safe(done.then);
    }
    while (!this.current && this.queue.length) {
      const next = this.queue.shift()!;
      if (next.expiresAt < 0 || time > next.expiresAt) { if (next.then) this.safe(next.then); continue; } // marker / stale
      this.current = next;
      this.freeAt = time + next.duration + DialogueQueue.GAP;
      this.history.push({ time, line: next.line });
      if (this.ui) {
        try { this.ui.showDialogue(next.line); } catch (err) { this.errors++; console.error('[campaign] showDialogue threw', err); }
      }
    }
  }

  /** True while a line is on screen or waiting. */
  get busy(): boolean { return !!this.current || this.queue.length > 0; }
  /** Drop everything queued (the line on screen finishes normally). */
  clear(): void { this.queue = []; }

  private safe(fn: () => void): void {
    try { fn(); } catch (err) { this.errors++; console.error('[campaign] dialogue callback threw', err); }
  }
}

// ═════════════════════════════════════════ mission timer ═════════════════════════════════════════

/** Countdown shown via ui.setMissionTimer. Cues fire when `remaining` drops to their `at` (seconds left). */
export class MissionTimer {
  remaining: number;
  expired = false;
  private cues: Array<{ at: number; fn: () => void; done: boolean }>;
  constructor(readonly label: string, readonly total: number, private onExpire: (() => void) | null, cues: Array<{ at: number; fn: () => void }> = []) {
    this.remaining = total;
    this.cues = cues.map((c) => ({ ...c, done: c.at >= total }));
  }
  /** Skip ahead (tests / scripted events). Cues above the new value are considered passed silently. */
  setRemaining(seconds: number): void {
    this.remaining = Math.max(0, seconds);
    for (const c of this.cues) if (c.at > this.remaining + 1e-9) c.done = true;
  }
  /** Advance by dt; runs cues/expiry through `safe`. */
  tick(dt: number, safe: (name: string, fn: () => void) => void): void {
    if (this.expired) return;
    this.remaining = Math.max(0, this.remaining - dt);
    for (const c of this.cues) {
      if (!c.done && this.remaining <= c.at + 1e-9) { c.done = true; safe(`timer:${this.label}@${c.at}`, c.fn); }
    }
    if (this.remaining <= 1e-9) {
      this.expired = true;
      if (this.onExpire) safe(`timer:${this.label}`, this.onExpire);
    }
  }
}

// ═════════════════════════════════════════ waves & guards ═════════════════════════════════════════

export type TargetSpec = Vec2 | string | Entity | (() => Vec2 | null);

export interface WaveOptions {
  /** wave name → tags 'wave' + 'wave:<name>' (default 'wave<N>') */
  name?: string;
  /** extra scriptTags for every unit */
  tags?: string[];
  /** where to attack-move (point name, position, entity or resolver). Default: the player's base. */
  target?: TargetSpec;
  /** apply DIFFICULTY_SCALE to the composition (default true) */
  scale?: boolean;
  /** spawn through ai.sendWave when an AI exists (default true); otherwise spawned by the script */
  viaAi?: boolean;
  /** minimap ping at the spawn point (default true) */
  ping?: boolean;
  /** keep idle units of the wave marching on the target (default true) */
  shepherd?: boolean;
  /** shepherd re-issues the march even when the unit has some other non-combat order (bosses) */
  assertive?: boolean;
}
export interface WaveRecord {
  name: string;
  spawnedAt: number;
  from: Vec2;
  ids: EntityId[];
  target: () => Vec2 | null;
  shepherd: boolean;
  assertive: boolean;
}
interface GuardRecord { ids: EntityId[]; post: Vec2; leash: number }

// ═════════════════════════════════════════ spawn options ═════════════════════════════════════════

export interface SpawnUnitOptions {
  tags?: string[];
  /** distance between units in the formation (default from the unit radius) */
  spacing?: number;
  facing?: number;
  /** send workers to the nearest Supply Caches (≈2 per cache) */
  gather?: boolean;
  invulnerable?: boolean;
}
export interface SpawnBuildingOptions {
  /** false = foundation at 0 % (default true) */
  complete?: boolean;
  tags?: string[];
  /** try the footprint centred exactly on the point before searching with a 1-tile gap (default false) */
  exact?: boolean;
  /** ring-search radius in tiles (default 10) */
  search?: number;
  /** keep the footprint centre inside this region */
  within?: MapRegion | string;
  /** if no valid spot is found, spawn on the exact tile anyway (HQs/objectives) — default false */
  force?: boolean;
  invulnerable?: boolean;
}

const ringCache: TilePos[][] = [];
/** Tile offsets at Chebyshev distance r, ordered by Euclidean distance then angle (deterministic). */
function ringOffsets(r: number): TilePos[] {
  const cached = ringCache[r];
  if (cached) return cached;
  const out: TilePos[] = [];
  if (r === 0) out.push({ x: 0, y: 0 });
  else for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) out.push({ x: dx, y: dy });
  out.sort((a, b) => (a.x * a.x + a.y * a.y) - (b.x * b.x + b.y * b.y) || Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
  ringCache[r] = out;
  return out;
}

/** Sunflower-ish ring formation offsets for n units. */
function formation(n: number, spacing: number): Vec2[] {
  const out: Vec2[] = [{ x: 0, y: 0 }];
  for (let ring = 1; out.length < n; ring++) {
    const r = ring * spacing;
    const k = Math.max(1, Math.floor((2 * Math.PI * r) / spacing));
    for (let i = 0; i < k && out.length < n; i++) {
      const a = (i / k) * Math.PI * 2 + ring * 0.7;
      out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
  }
  return out.slice(0, n);
}

// ═════════════════════════════════════════ MissionScript ═════════════════════════════════════════

/** The toolkit a mission script works with. One instance per mission run. */
export class MissionScript {
  readonly world: World;
  readonly playerId: PlayerId;
  readonly enemyId: PlayerId;
  readonly ai: AiController | null;
  readonly difficulty: Difficulty;
  readonly refs: MapRefs;
  readonly triggers: TriggerEngine;
  readonly objectives = new ObjectiveManager();
  readonly dialogue = new DialogueQueue();
  /** every hint/notification shown (tests & debugging) */
  readonly hintLog: Array<{ time: number; text: string; kind: NotifyKind }> = [];
  readonly waves: WaveRecord[] = [];
  /** AI flags requested by the script (kept even when there is no AI) */
  readonly aiFlags: Partial<AiFlags> = {};
  ui: GameUi | null = null;
  camera: CameraApi | null = null;
  state: MissionState = 'running';
  endReason: string | null = null;
  timer: MissionTimer | null = null;
  /** complete → victory automatically when every primary objective (hidden included) is done */
  victoryWhenPrimariesDone = false;

  private t0 = 0;
  private started = false;
  private attached = false;
  private ownErrors = 0;
  private ending: { at: number } | null = null;
  private finishHooks: Array<(won: boolean) => void> = [];
  private pushedObjectives = -1;
  /** last value pushed to ui.setMissionTimer ('' = hidden, null = never pushed) */
  private shownTimerKey: string | null = null;
  private hintShownAt = new Map<string, number>();
  private guards: GuardRecord[] = [];
  private nextShepherd = 0;
  private waveCounter = 0;
  private lastReissue = new Map<EntityId, { x: number; y: number; t: number }>();
  /** seconds before a stuck (idle, unmoved) wave/guard unit is re-commanded again */
  static REISSUE_BACKOFF = 10;

  constructor(ctx: MissionContext) {
    this.world = ctx.world;
    this.playerId = ctx.playerId;
    this.enemyId = ctx.enemyId;
    this.ai = ctx.ai;
    this.difficulty = ctx.difficulty;
    this.refs = new MapRefs(ctx.world, ctx.playerId, ctx.enemyId);
    this.triggers = new TriggerEngine(ctx.world);
    this.objectives.onChange((o, change) => this.onObjectiveChange(o, change));
  }

  /** Mission time: seconds since setup(). */
  get time(): number { return this.world.time - this.t0; }
  /** Errors caught in triggers/callbacks/UI calls (tests assert 0). */
  get errors(): number { return this.triggers.errors + this.dialogue.errors + this.ownErrors; }
  get finished(): boolean { return this.state !== 'running'; }

  // ───────────────────────── lifecycle ─────────────────────────

  /** Called from setup(): campaign rules (no skirmish auto-defeat) and the mission clock. */
  begin(): void {
    if (this.started) return;
    this.started = true;
    this.t0 = this.world.time;
    this.world.rules.autoDefeat = false;
    // Someone else ended the match (debug, another module): mirror it in our state.
    this.world.events.on('gameOver', ({ winnerTeam, reason }) => {
      if (this.state !== 'running') return;
      this.state = winnerTeam != null && winnerTeam === this.world.player(this.playerId).team ? 'won' : 'lost';
      this.endReason = reason;
      this.ending = null;
    });
  }

  attach(ui: GameUi | null, camera: CameraApi | null): void {
    this.ui = ui;
    this.camera = camera;
    this.dialogue.ui = ui;
    this.attached = true;
    this.pushedObjectives = -1;
    this.flushObjectives();
    this.shownTimerKey = null;
    this.flushTimer();
  }

  update(dt: number): void {
    if (!this.started) this.begin();
    const t = this.time;
    if (this.state === 'running') {
      this.triggers.update(t);
      if (this.timer && this.state === 'running') {
        this.timer.tick(dt, (name, fn) => this.safe(name, fn));
      }
      if (this.state === 'running') {
        if (t >= this.nextShepherd) { this.nextShepherd = t + 1.5; this.shepherd(); this.updateGuards(); }
        if (this.victoryWhenPrimariesDone && this.objectives.allPrimaryDone()) this.victory('All objectives complete');
      }
    }
    this.dialogue.update(t);
    if (this.ending && t + 1e-9 >= this.ending.at) { this.ending = null; this.endNow(); }
    this.flushObjectives();
    this.flushTimer();
  }

  // ───────────────────────── triggers (sugar over TriggerEngine) ─────────────────────────

  at(t: number, fn: () => void, name?: string): Trigger { return this.triggers.at(t, fn, name); }
  after(seconds: number, fn: () => void, name?: string): Trigger { return this.triggers.after(seconds, fn, name); }
  every(seconds: number, fn: () => void, opts?: { start?: number; times?: number; name?: string }): Trigger { return this.triggers.every(seconds, fn, opts); }
  when(pred: () => boolean, fn: () => void, opts?: WhenOptions): Trigger { return this.triggers.when(pred, fn, opts); }
  onEvent<K extends GameEventType>(type: K, filter: ((p: GameEvents[K]) => boolean) | null, fn: (p: GameEvents[K]) => void, opts?: { repeat?: boolean; name?: string }): Trigger {
    return this.triggers.onEvent(type, filter, fn, opts);
  }

  /** Fires when any unit of `owner` (optionally filtered) is inside the region. Polled 4×/s. */
  onEnterRegion(region: MapRegion | string, owner: PlayerId, fn: (units: Entity[]) => void, opts: { filter?: (e: Entity) => boolean; repeat?: boolean; cooldown?: number; name?: string } = {}): Trigger {
    const rect = typeof region === 'string' ? this.refs.region(region) : { ...region };
    let found: Entity[] = [];
    return this.when(() => { found = this.unitsInRegion(rect, owner, opts.filter); return found.length > 0; }, () => fn(found), {
      interval: 0.25, repeat: opts.repeat, cooldown: opts.cooldown, name: opts.name ?? `enter:${typeof region === 'string' ? region : 'rect'}`,
    });
  }

  /** Entity death by entity / id / scriptTag. */
  onDeath(target: Entity | EntityId | { tag: string }, fn: (dead: Entity, killer: Entity | null) => void, opts: { repeat?: boolean; name?: string } = {}): Trigger {
    const match = this.matcher(target);
    return this.onEvent('entityDied', (p) => match(p.entity), (p) => fn(p.entity, p.killer), { repeat: opts.repeat, name: opts.name ?? 'death' });
  }

  /** Fires once every entity carrying `tag` is gone — only after at least one has existed. Polled 4×/s. */
  onAllDead(tag: string, fn: () => void, opts: { name?: string } = {}): Trigger {
    let seen = false;
    return this.when(() => {
      const n = this.countTagged(tag);
      if (n > 0) seen = true;
      return seen && n === 0;
    }, fn, { interval: 0.25, name: opts.name ?? `allDead:${tag}` });
  }

  /** Damage to an entity / tag, throttled per trigger. */
  onDamaged(target: Entity | EntityId | { tag: string }, fn: (p: GameEvents['entityDamaged']) => void, opts: { cooldown?: number; byOwner?: PlayerId; name?: string } = {}): Trigger {
    const match = this.matcher(target);
    const cd = opts.cooldown ?? 20;
    let last = -Infinity;
    return this.onEvent('entityDamaged', (p) => {
      if (!match(p.entity) || p.amount <= 0) return false;
      if (opts.byOwner != null && p.source?.owner !== opts.byOwner) return false;
      if (this.world.time - last < cd) return false;
      last = this.world.time;
      return true;
    }, fn, { repeat: true, name: opts.name ?? 'damaged' });
  }

  /** One-shot when an alive entity's hp drops to ≤ fraction × maxHp. */
  onHpBelow(e: Entity, fraction: number, fn: () => void, name = 'hpBelow'): Trigger {
    return this.when(() => e.alive && e.hp <= e.stats.maxHp * fraction, fn, { interval: 0.25, name });
  }

  // ───────────────────────── objectives ─────────────────────────

  addObjective(spec: ObjectiveSpec): Objective { return this.objectives.add(spec); }
  revealObjective(id: string): boolean { return this.objectives.reveal(id); }
  completeObjective(id: string): boolean { return this.objectives.complete(id); }
  failObjective(id: string): boolean { return this.objectives.fail(id); }
  setProgress(id: string, progress: string | undefined): void { this.objectives.setProgress(id, progress); }

  // ───────────────────────── dialogue, hints, camera, fog ─────────────────────────

  /** Queue dialogue; returns the estimated seconds until it has finished. */
  say(lines: DialogueLine | DialogueLine[], opts?: SayOptions): number {
    for (const l of Array.isArray(lines) ? lines : [lines]) {
      if (l.text.length > MAX_LINE_LENGTH) console.warn(`[campaign] dialogue line over ${MAX_LINE_LENGTH} chars: "${l.text.slice(0, 40)}…"`);
    }
    return this.dialogue.say(lines, opts);
  }
  /** A short, time-sensitive line: dropped if it can't start within `expires` seconds. */
  bark(l: DialogueLine, expires = 12): number { return this.dialogue.say(l, { expires }); }

  /** Transient toast. */
  notify(text: string, kind: NotifyKind = 'info'): void {
    this.hintLog.push({ time: this.time, text, kind });
    if (!this.ui) return;
    try { this.ui.notify(text, kind); } catch (err) { this.reportError('ui.notify', err); }
  }
  /**
   * Tutorial/tactical hint. With an `id` it shows once (or again after `cooldown` seconds).
   * Returns true if it was shown.
   */
  hint(text: string, opts: { id?: string; cooldown?: number; kind?: NotifyKind } = {}): boolean {
    const key = opts.id ?? text;
    const last = this.hintShownAt.get(key);
    if (last != null && (opts.cooldown == null || this.time - last < opts.cooldown)) return false;
    this.hintShownAt.set(key, this.time);
    this.notify(text, opts.kind ?? 'info');
    return true;
  }
  hintShown(id: string): boolean { return this.hintShownAt.has(id); }

  panTo(p: Vec2 | string, seconds = 2.5): void {
    const q = this.resolvePoint(p);
    if (this.camera) { try { this.camera.panTo(q, seconds); } catch (err) { this.reportError('camera.panTo', err); } }
  }
  lookAt(p: Vec2 | string, immediate = true): void {
    const q = this.resolvePoint(p);
    if (this.camera) { try { this.camera.lookAt(q, immediate); } catch (err) { this.reportError('camera.lookAt', err); } }
  }
  shake(intensity: number, seconds: number): void {
    if (this.camera) { try { this.camera.shake(intensity, seconds); } catch (err) { this.reportError('camera.shake', err); } }
  }
  /** Temporarily lift the fog for the player. */
  reveal(p: Vec2 | string, radius: number, seconds: number, playerId: PlayerId = this.playerId): void {
    try { this.world.vision.revealArea(playerId, this.resolvePoint(p), radius, seconds); } catch (err) { this.reportError('vision.revealArea', err); }
  }
  ping(p: Vec2 | string, color = 0xff3b6b): void {
    if (!this.ui) return;
    try { this.ui.pingMinimap(this.resolvePoint(p), color); } catch (err) { this.reportError('ui.pingMinimap', err); }
  }

  // ───────────────────────── map & world helpers ─────────────────────────

  /** Override the map's lighting preset (call in setup(), before the renderer reads it). */
  setLighting(preset: LightingPreset): void { this.world.map.lighting = preset; }
  /** Neutral Supply Caches from the map. */
  spawnMapResources(): Entity[] { return spawnMapResources(this.world); }

  resolvePoint(p: Vec2 | string): Vec2 { return typeof p === 'string' ? this.refs.point(p) : { x: p.x, y: p.y }; }
  /** Nearest ground-walkable point (falls back to the input). */
  walkableNear(p: Vec2, maxRadius = 10): Vec2 {
    const map = this.world.map;
    const q = { x: clamp(p.x, 1.5, map.width - 1.5), y: clamp(p.y, 1.5, map.height - 1.5) };
    try { return this.world.movement.nearestWalkable(q, maxRadius) ?? q; } catch { return q; }
  }

  /** Alive entities carrying a scriptTag. */
  tagged(tag: string, owner?: PlayerId): Entity[] {
    const out: Entity[] = [];
    for (const e of this.world.list) if (e.alive && e.scriptTags.has(tag) && (owner == null || e.owner === owner)) out.push(e);
    return out;
  }
  countTagged(tag: string): number {
    let n = 0;
    for (const e of this.world.list) if (e.alive && e.scriptTags.has(tag)) n++;
    return n;
  }
  firstTagged(tag: string): Entity | undefined {
    for (const e of this.world.list) if (e.alive && e.scriptTags.has(tag)) return e;
    return undefined;
  }
  tag(entities: Entity | Entity[], ...tags: string[]): void {
    for (const e of Array.isArray(entities) ? entities : [entities]) for (const t of tags) e.scriptTags.add(t);
  }
  /** Alive units of `owner` whose centre is inside the region. */
  unitsInRegion(region: MapRegion | string, owner: PlayerId, filter?: (e: Entity) => boolean): Entity[] {
    const r = typeof region === 'string' ? this.refs.region(region) : region;
    return this.world.spatial.queryRect(r.x, r.y, r.x + r.w, r.y + r.h, (e) => e.alive && e.kind === 'unit' && e.owner === owner && (!filter || filter(e)));
  }
  /** Completed buildings / alive units of a def. */
  completed(owner: PlayerId, defId: string): number { return this.world.countOf(owner, defId, false); }
  /** Alive count incl. foundations. */
  count(owner: PlayerId, defId: string): number { return this.world.countOf(owner, defId, true); }

  // ───────────────────────── spawning ─────────────────────────

  /** Spawn `count` units of a def in a loose formation around a point (each nudged onto walkable ground). */
  spawnUnits(defId: string, count: number, owner: PlayerId, at: Vec2 | string, opts: SpawnUnitOptions = {}): Entity[] {
    const def = tryGetDef(defId);
    if (!def || def.kind !== 'unit') { this.reportError('spawnUnits', new Error(`"${defId}" is not a unit`)); return []; }
    if (count <= 0) return [];
    const centre = this.resolvePoint(at);
    const air = def.tags.includes('air');
    const spacing = opts.spacing ?? Math.max(1.0, def.radius * 2.3);
    const map = this.world.map;
    const out: Entity[] = [];
    for (const off of formation(count, spacing)) {
      let p: Vec2 = { x: clamp(centre.x + off.x, 1.5, map.width - 1.5), y: clamp(centre.y + off.y, 1.5, map.height - 1.5) };
      if (!air) {
        let ok = false;
        try { ok = this.world.movement.isWalkable(p); } catch { ok = false; }
        if (!ok) {
          let q: Vec2 | null = null;
          try { q = this.world.movement.nearestWalkable(p, 4) ?? this.world.movement.nearestWalkable(centre, 12); } catch { q = null; }
          p = q ?? p;
        }
      }
      try {
        const e = this.world.spawnUnit(defId, owner, p, { facing: opts.facing ?? 0 });
        for (const t of opts.tags ?? []) e.scriptTags.add(t);
        if (opts.invulnerable) e.invulnerable = true;
        out.push(e);
      } catch (err) { this.reportError('spawnUnit', err); }
    }
    if (opts.gather) this.assignGather(out, centre);
    return out;
  }

  /** Spawn a building near a point on a valid footprint (1-tile gap preferred). Null if nowhere fits (unless force). */
  spawnBuilding(defId: string, owner: PlayerId, at: Vec2 | string, opts: SpawnBuildingOptions = {}): Entity | null {
    const def = tryGetDef(defId);
    if (!def || def.kind !== 'building') { this.reportError('spawnBuilding', new Error(`"${defId}" is not a building`)); return null; }
    const p = this.resolvePoint(at);
    let tile = this.findBuildingSpot(defId, p, opts);
    if (!tile && opts.force) {
      tile = footprintTileAt(p, def.footprint.w, def.footprint.h);
      tile = { x: clamp(tile.x, 1, this.world.map.width - def.footprint.w - 1), y: clamp(tile.y, 1, this.world.map.height - def.footprint.h - 1) };
      warnOnce(`${this.world.map.id}:force:${defId}:${tile.x},${tile.y}`, `[campaign] no free footprint for ${defId} near (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) — forcing it`);
    }
    if (!tile) {
      warnOnce(`${this.world.map.id}:nospot:${defId}:${Math.round(p.x)},${Math.round(p.y)}`, `[campaign] no free footprint for ${defId} near (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) — skipped`);
      return null;
    }
    try {
      const b = this.world.spawnBuilding(defId, owner, tile, { complete: opts.complete !== false });
      for (const t of opts.tags ?? []) b.scriptTags.add(t);
      if (opts.invulnerable) b.invulnerable = true;
      return b;
    } catch (err) { this.reportError('spawnBuilding', err); return null; }
  }

  /** Top-left tile of a free footprint for `defId` near `at`, or null. */
  findBuildingSpot(defId: string, at: Vec2, opts: { exact?: boolean; search?: number; within?: MapRegion | string } = {}): TilePos | null {
    const def = tryGetDef(defId);
    if (!def || def.kind !== 'building') return null;
    const { w, h } = def.footprint;
    const base = footprintTileAt(at, w, h);
    const within = typeof opts.within === 'string' ? this.refs.region(opts.within) : opts.within;
    const maxR = opts.search ?? 10;
    if (opts.exact && this.isSpotFree(base, w, h, 0, within, true)) return base;
    const passes: Array<[number, boolean]> = [[1, true], [0, true], [0, false]];
    for (const [margin, buildable] of passes) {
      for (let r = 0; r <= maxR; r++) {
        for (const o of ringOffsets(r)) {
          const t = { x: base.x + o.x, y: base.y + o.y };
          if (this.isSpotFree(t, w, h, margin, within, buildable)) return t;
        }
      }
    }
    return null;
  }

  private isSpotFree(t: TilePos, w: number, h: number, margin: number, within: MapRegion | undefined, needBuildable: boolean): boolean {
    const map = this.world.map;
    for (let y = t.y; y < t.y + h; y++) for (let x = t.x; x < t.x + w; x++) {
      if (!inBounds(map, x, y)) return false;
      const i = tileIndex(map, x, y);
      if (map.blocked[i]) return false;
      if (needBuildable && !map.buildable[i]) return false;
    }
    if (within && !pointInRect(footprintCenter(t, w, h), within)) return false;
    try {
      if (!this.world.movement.isFootprintFree(t, w, h)) return false;
      if (margin > 0 && !this.world.movement.isFootprintFree({ x: t.x - margin, y: t.y - margin }, w + margin * 2, h + margin * 2)) return false;
    } catch { return false; }
    return true;
  }

  /** Send workers to gather from the caches nearest `near` (≈2 per cache, deterministic). */
  assignGather(workers: Entity[], near?: Vec2): void {
    const ws = workers.filter((w) => w.alive && !!w.gatherer);
    if (!ws.length) return;
    const c = near ?? ws[0]!.pos;
    const nodes = this.world.spatial.queryRadius(c, 22, (e) => e.kind === 'resource' && !!e.resource && e.resource.amount > 0)
      .sort((a, b) => dist(a.pos, c) - dist(b.pos, c) || a.id - b.id);
    if (!nodes.length) return;
    ws.forEach((wk, i) => {
      const node = nodes[Math.floor(i / 2) % nodes.length]!;
      this.world.issue({ type: 'gather', playerId: wk.owner, unitIds: [wk.id], targetId: node.id });
    });
  }

  /**
   * Make sure the player starts with at least `spare` free beds: spawns completed Patient Wards (or the
   * faction's pop building) near `near` until the population cap covers the starting units + spare.
   */
  ensureBeds(playerId: PlayerId, spare: number, near: Vec2 | string, popDefId = 'hosp_ward'): Entity[] {
    const def = tryGetDef(popDefId);
    if (!def || def.kind !== 'building' || !def.provides.pop) return [];
    let used = 0, cap = 0;
    for (const e of this.world.list) {
      if (!e.alive || e.owner !== playerId) continue;
      if (e.def.kind === 'unit') used += e.def.pop;
      else if (e.def.kind === 'building' && !e.construction) cap += e.def.provides.pop ?? 0;
    }
    const out: Entity[] = [];
    while (cap < Math.min(150, used + spare) && out.length < 12) {
      const b = this.spawnBuilding(popDefId, playerId, near, { search: 14 });
      if (!b) break;
      out.push(b);
      cap += def.provides.pop;
    }
    return out;
  }

  // ───────────────────────── resources ─────────────────────────

  grant(bag: { matter?: number; energy?: number }, playerId: PlayerId = this.playerId): void {
    try { this.world.economy.addResources(playerId, bag); } catch (err) { this.reportError('economy.addResources', err); }
  }
  setResources(playerId: PlayerId, bag: { matter: number; energy: number }): void {
    const p = this.world.players.get(playerId);
    if (!p) return;
    p.resources.matter = bag.matter;
    p.resources.energy = bag.energy;
  }

  // ───────────────────────── AI & waves ─────────────────────────

  setAiFlags(flags: Partial<AiFlags>): void {
    Object.assign(this.aiFlags, flags);
    if (!this.ai) return;
    try { this.ai.setFlags(flags); } catch (err) { this.reportError('ai.setFlags', err); }
  }
  setAiAttackTarget(p: Vec2 | string | null): void {
    if (!this.ai) return;
    try { this.ai.setAttackTarget(p == null ? null : this.resolvePoint(p)); } catch (err) { this.reportError('ai.setAttackTarget', err); }
  }

  /** Resolve a TargetSpec into a position resolver. Default: the player's HQ, else their nearest structure. */
  targetResolver(spec: TargetSpec | undefined, from?: Vec2): () => Vec2 | null {
    if (spec == null) return () => this.playerBaseTarget(from);
    if (typeof spec === 'function') return spec;
    if (typeof spec === 'string') { const p = this.refs.point(spec); return () => p; }
    if ('kind' in spec) {
      const ent = spec;
      return () => (ent.alive ? { x: ent.pos.x, y: ent.pos.y } : this.playerBaseTarget(from));
    }
    const p = { x: spec.x, y: spec.y };
    return () => p;
  }

  /** The player's Central Hospital, else the player's structure nearest `from`, else their start. */
  playerBaseTarget(from?: Vec2): Vec2 | null {
    const hq = this.world.entitiesOf(this.playerId, (e) => e.defId === 'hosp_hq')[0];
    if (hq) return { x: hq.pos.x, y: hq.pos.y };
    const ref = from ?? this.refs.point('player_start');
    let best: Entity | null = null, bd = Infinity;
    for (const e of this.world.list) {
      if (!e.alive || e.owner !== this.playerId || e.kind !== 'building') continue;
      const d = dist(e.pos, ref);
      if (d < bd) { bd = d; best = e; }
    }
    return best ? { x: best.pos.x, y: best.pos.y } : null;
  }

  /**
   * Spawn a scripted wave for the enemy (free units) and attack-move it on a target. Uses ai.sendWave
   * when an AI exists (so the AI knows about the units), otherwise spawns/commands them directly.
   */
  sendWave(comp: Composition, from: Vec2 | string, opts: WaveOptions = {}): Entity[] {
    const name = opts.name ?? `wave${++this.waveCounter}`;
    const spawnAt = this.walkableNear(this.resolvePoint(from));
    const c = opts.scale === false ? { ...comp } : scaleComposition(comp, this.difficulty);
    const target = this.targetResolver(opts.target, spawnAt);
    const tp = target() ?? this.refs.point('player_start');
    let ids: EntityId[] = [];
    if (this.ai && opts.viaAi !== false) {
      try { ids = this.ai.sendWave(c, spawnAt, tp) ?? []; } catch (err) { this.reportError('ai.sendWave', err); ids = []; }
    }
    let units = ids.map((id) => this.world.getAlive(id)).filter((e): e is Entity => !!e);
    if (units.length === 0) {
      for (const [defId, n] of Object.entries(c)) units.push(...this.spawnUnits(defId, n, this.enemyId, spawnAt));
      if (units.length) this.world.issue({ type: 'attackMove', playerId: this.enemyId, unitIds: units.map((u) => u.id), target: tp });
    }
    this.tag(units, 'wave', `wave:${name}`, ...(opts.tags ?? []));
    this.waves.push({ name, spawnedAt: this.time, from: spawnAt, ids: units.map((u) => u.id), target, shepherd: opts.shepherd !== false, assertive: !!opts.assertive });
    if (opts.ping !== false) this.ping(spawnAt);
    return units;
  }

  /** Command already-spawned enemy units to march on a target and keep them marching (bosses, escorts). */
  march(units: Entity[], target: TargetSpec, opts: { name?: string; assertive?: boolean } = {}): void {
    const alive = units.filter((u) => u.alive);
    if (!alive.length) return;
    const owner = alive[0]!.owner;
    const resolver = this.targetResolver(target, alive[0]!.pos);
    const tp = resolver();
    if (tp) this.world.issue({ type: 'attackMove', playerId: owner, unitIds: alive.map((u) => u.id), target: tp });
    this.waves.push({ name: opts.name ?? `march${++this.waveCounter}`, spawnedAt: this.time, from: { ...alive[0]!.pos }, ids: alive.map((u) => u.id), target: resolver, shepherd: true, assertive: !!opts.assertive });
  }

  /** Keep units near a post: idle ones that wandered beyond `leash` attack-move back. */
  guard(units: Entity[], post: Vec2 | string, leash = 9): void {
    const ids = units.filter((u) => u.alive).map((u) => u.id);
    if (ids.length) this.guards.push({ ids, post: this.resolvePoint(post), leash });
  }

  /** A unit with nothing to do (no orders and not fighting). */
  isIdle(u: Entity): boolean {
    if (u.orders.length > 0) return false;
    const tid = u.combat?.targetId;
    return !(tid != null && this.world.getAlive(tid));
  }

  /** Re-issue the march for wave units that went idle (or, for assertive waves, got distracted). */
  private shepherd(): void {
    if (!this.waves.length) return;
    let prune = false;
    for (const w of this.waves) {
      const alive = w.ids.map((id) => this.world.getAlive(id)).filter((e): e is Entity => !!e);
      if (alive.length !== w.ids.length) { w.ids = alive.map((e) => e.id); if (!alive.length) prune = true; }
      if (!w.shepherd || !alive.length) continue;
      if (this.time - w.spawnedAt < 1) continue; // its initial march command is still queued
      const tp = w.target();
      if (!tp) continue;
      const byOwner = new Map<PlayerId, EntityId[]>();
      for (const u of alive) {
        let needs = this.isIdle(u);
        if (!needs && w.assertive) {
          const o = u.orders[0];
          const fighting = o?.type === 'attack' || (u.combat?.targetId != null && !!this.world.getAlive(u.combat.targetId));
          needs = !fighting && !(o?.type === 'attackMove' && dist(o.target, tp) < 8);
        }
        if (!needs) continue;
        if (dist(u.pos, tp) < 2.5 && !w.assertive) continue; // already there; let idle behaviour handle it
        if (!this.mayReissue(u)) continue;
        let list = byOwner.get(u.owner);
        if (!list) { list = []; byOwner.set(u.owner, list); }
        list.push(u.id);
      }
      for (const [owner, ids] of byOwner) this.world.issue({ type: 'attackMove', playerId: owner, unitIds: ids, target: { x: tp.x, y: tp.y } });
    }
    if (prune) for (let i = this.waves.length - 1; i >= 0; i--) if (this.waves[i]!.ids.length === 0) this.waves.splice(i, 1);
  }

  /**
   * Back-off for units that keep going idle without getting anywhere (unreachable target): a unit is
   * re-commanded at most once per REISSUE_BACKOFF seconds unless it moved since the last order.
   */
  private mayReissue(u: Entity): boolean {
    const now = this.time;
    const last = this.lastReissue.get(u.id);
    if (last && now - last.t < MissionScript.REISSUE_BACKOFF && Math.hypot(u.pos.x - last.x, u.pos.y - last.y) < 1.5) return false;
    this.lastReissue.set(u.id, { x: u.pos.x, y: u.pos.y, t: now });
    if (this.lastReissue.size > 512) {
      for (const id of [...this.lastReissue.keys()]) if (!this.world.getAlive(id)) this.lastReissue.delete(id);
    }
    return true;
  }

  private updateGuards(): void {
    for (const g of this.guards) {
      const back: Entity[] = [];
      g.ids = g.ids.filter((id) => {
        const u = this.world.getAlive(id);
        if (!u) return false;
        if (this.isIdle(u) && dist(u.pos, g.post) > g.leash && this.mayReissue(u)) back.push(u);
        return true;
      });
      if (back.length) this.world.issue({ type: 'attackMove', playerId: back[0]!.owner, unitIds: back.map((u) => u.id), target: { ...g.post } });
    }
    this.guards = this.guards.filter((g) => g.ids.length > 0);
  }

  // ───────────────────────── timer ─────────────────────────

  /** Start (or replace) the mission countdown. `cues` fire at the given seconds remaining. */
  startTimer(label: string, seconds: number, onExpire: (() => void) | null, cues: Array<{ at: number; fn: () => void }> = []): MissionTimer {
    this.timer = new MissionTimer(label, seconds, onExpire, cues);
    this.flushTimer();
    return this.timer;
  }
  stopTimer(): void {
    this.timer = null;
    this.flushTimer();
  }

  // ───────────────────────── victory / defeat ─────────────────────────

  /** Win the mission; the end screen appears after `delay` seconds (lets the last line play). */
  victory(reason: string, opts: { delay?: number } = {}): void { this.finish('won', reason, opts.delay ?? 4); }
  /** Lose the mission; the end screen appears after `delay` seconds. */
  defeat(reason: string, opts: { delay?: number } = {}): void { this.finish('lost', reason, opts.delay ?? 3); }
  /** Called once when the outcome is decided (before the end screen). */
  onFinish(fn: (won: boolean) => void): void { this.finishHooks.push(fn); }

  private finish(state: 'won' | 'lost', reason: string, delay: number): void {
    if (this.state !== 'running' || this.world.rules.gameOver) return;
    this.state = state;
    this.endReason = reason;
    const won = state === 'won';
    for (const o of this.objectives.activePrimaries()) { if (won) this.objectives.complete(o.id); else this.objectives.fail(o.id); }
    for (const h of this.finishHooks) this.safe('onFinish', () => h(won));
    this.timer = null;
    this.ending = { at: this.time + Math.max(0, delay) };
    if (delay <= 0) { this.ending = null; this.endNow(); }
    this.flushObjectives();
    this.flushTimer();
  }

  private endNow(): void {
    if (this.world.rules.gameOver) return;
    const me = this.world.player(this.playerId), foe = this.world.player(this.enemyId);
    const reason = this.endReason ?? (this.state === 'won' ? 'victory' : 'defeat');
    if (this.state === 'won') { this.world.defeatPlayer(this.enemyId); this.world.endGame(me.team, reason); }
    else { this.world.defeatPlayer(this.playerId); this.world.endGame(foe.team, reason); }
  }

  // ───────────────────────── internals ─────────────────────────

  reportError(where: string, err: unknown): void {
    this.ownErrors++;
    console.error(`[campaign] ${where} failed`, err);
  }
  private safe(name: string, fn: () => void): void {
    try { fn(); } catch (err) { this.reportError(name, err); }
  }

  private matcher(target: Entity | EntityId | { tag: string }): (e: Entity) => boolean {
    if (typeof target === 'number') return (e) => e.id === target;
    if ('tag' in target) { const tag = target.tag; return (e) => e.scriptTags.has(tag); }
    const id = target.id;
    return (e) => e.id === id;
  }

  private onObjectiveChange(o: Objective, change: ObjectiveChange): void {
    if (!this.attached || this.state !== 'running') return;
    if (change === 'revealed' || (change === 'added' && o.status === 'active')) this.notify(`${o.primary ? 'New objective' : 'Bonus objective'}: ${o.text}`, 'info');
    else if (change === 'done') this.notify(`${o.primary ? 'Objective complete' : 'Bonus complete'}: ${o.text}`, 'success');
    else if (change === 'failed') this.notify(`${o.primary ? 'Objective failed' : 'Bonus failed'}: ${o.text}`, 'warning');
  }

  private flushObjectives(): void {
    if (this.pushedObjectives === this.objectives.version) return;
    this.pushedObjectives = this.objectives.version;
    if (!this.ui) return;
    try { this.ui.setObjectives(this.objectives.views()); } catch (err) { this.reportError('ui.setObjectives', err); }
  }

  private flushTimer(): void {
    const t = this.timer && !this.timer.expired ? this.timer : null;
    const value = t ? Math.ceil(t.remaining - 1e-9) : -1;
    const key = t ? `${t.label}|${value}` : '';
    if (this.shownTimerKey === key) return;
    this.shownTimerKey = key;
    if (!this.ui) return;
    try { this.ui.setMissionTimer(t ? t.label : null, t ? value : undefined); } catch (err) { this.reportError('ui.setMissionTimer', err); }
  }
}

// ═════════════════════════════════════════ ScriptedMission ═════════════════════════════════════════

/**
 * MissionRunner on top of a MissionScript. Subclasses implement:
 *   build() — runs in setup(): spawns, starting resources, AI flags, objectives and all triggers;
 *   intro() — runs in attach(): opening dialogue and camera work (works headless too, ui/camera null).
 */
export abstract class ScriptedMission implements MissionRunner {
  readonly script: MissionScript;
  private didSetup = false;
  private didAttach = false;

  constructor(readonly info: MissionInfo, protected readonly ctx: MissionContext) {
    this.script = new MissionScript(ctx);
  }

  get state(): MissionState { return this.script.state; }

  setup(): void {
    if (this.didSetup) return;
    this.didSetup = true;
    this.script.begin();
    try { this.build(); } catch (err) { this.script.reportError(`${this.info.id}.build`, err); }
  }

  attach(ui: GameUi | null, camera: CameraApi | null): void {
    if (!this.didSetup) this.setup();
    this.script.attach(ui, camera);
    if (this.didAttach) return;
    this.didAttach = true;
    try { this.intro(); } catch (err) { this.script.reportError(`${this.info.id}.intro`, err); }
  }

  update(dt: number): void {
    if (!this.didSetup) this.setup();
    if (!this.didAttach) this.attach(null, null);
    this.script.update(dt);
  }

  objectives(): ObjectiveView[] { return this.script.objectives.views(); }

  protected abstract build(): void;
  protected abstract intro(): void;
}
