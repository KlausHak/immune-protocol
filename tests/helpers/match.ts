/**
 * [qa] Headless match runner for integration tests.
 *
 *   const s = runMatch({ mapId: 'test', difficulty: 'normal', seed: 3, minutes: 5, bot: 'medium' });
 *   expect(s.exceptions).toEqual([]);
 *   expect(errorViolations(s)).toEqual([]);
 *   console.log(describeSummary(s));
 *
 * Mirrors Game.stepOnce(): (bot) → AI.update → mission.update → world.step(), each phase wrapped in try/catch
 * so a throwing module is reported (with phase + tick) instead of killing the run. console.error/warn output
 * produced during the match (World and EventBus swallow exceptions into console.error) is captured too.
 * Invariants (tests/helpers/invariants.ts) run every `invariants.every` ticks.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Difficulty, Entity, MapData, PlayerId } from '../../src/core/types';
import { CAMPAIGN } from '../../src/campaign';
import { createHeadlessMatch, type HeadlessMatch } from '../../src/game/headless';
import { listMaps } from '../../src/map';
import type { World } from '../../src/sim/World';
import { createHospitalBot, type BotStrength, type HospitalBot, type HospitalBotOptions } from './hospitalBot';
import { InvariantChecker, type InvariantOptions, type Violation } from './invariants';

export { InvariantChecker, DEFAULT_INVARIANTS, InvariantViolationError, entityLabel } from './invariants';
export type { InvariantOptions, Violation, Severity } from './invariants';

export interface RunMatchOptions {
  mode?: 'skirmish' | 'campaign';
  mapId?: string;
  map?: MapData;
  missionId?: string;
  difficulty?: Difficulty;
  seed?: number;
  /** Simulated minutes to run (stops earlier on game over unless stopOnGameOver=false). */
  minutes: number;
  /** Scripted hospital player (player 1): a preset, full options, or null/undefined for none. */
  bot?: BotStrength | HospitalBotOptions | null;
  /** Create the pathogen AI (default true). */
  enemyAi?: boolean;
  /** Invariant options, or false to disable checks. Campaign defaults to popCheck 'hospital' + more slack. */
  invariants?: Partial<InvariantOptions> | false;
  stopOnGameOver?: boolean;
  /** Seconds between timeline samples (default 60). */
  timelineEvery?: number;
  /** Capture console.error / console.warn during the match (default true). */
  captureConsole?: boolean;
  /** Forward captured console output to the real console (default: first 10 errors). */
  echoConsole?: number;
  /** Abort after this many exceptions (default 25). */
  maxExceptions?: number;
  /** Called after setup (before the first tick) — e.g. to tweak the world for a scenario. */
  onSetup?: (ctx: MatchContext) => void;
  /** Called before every tick (after the bot). */
  onTick?: (ctx: MatchContext) => void;
  /** Time every sim system + bot/AI/mission/invariants (adds ~2 % overhead). Result in summary.profile. */
  profile?: boolean;
}

export interface MatchProfile {
  /** total ms spent per phase/system over the whole match ('system:movement', 'ai', 'bot', ...) */
  totalMs: Record<string, number>;
  /** average ms per tick per phase/system */
  perTickMs: Record<string, number>;
  ticks: number;
}

export interface MatchContext { match: HeadlessMatch; world: World; bot: HospitalBot | null; checker: InvariantChecker | null }

export interface CaughtException { phase: 'setup' | 'bot' | 'ai' | 'mission' | 'world' | 'hook' | 'invariants'; tick: number; time: number; message: string; stack: string }

export interface PlayerSample { workers: number; army: number; armyPop: number; buildings: number; foundations: number; matter: number; energy: number; popUsed: number; popCap: number }
export interface TimelineSample { t: number; players: Record<number, PlayerSample> }

export interface PlayerSummary {
  id: PlayerId; name: string; faction: string; team: number; controller: string; defeated: boolean;
  stats: Record<string, number>;
  resources: { matter: number; energy: number };
  popUsed: number; popCap: number;
  units: number; workers: number; army: number; buildings: number;
  upgrades: string[];
  unitsByType: Record<string, number>;
  buildingsByType: Record<string, number>;
}

export interface MatchSummary {
  mode: 'skirmish' | 'campaign';
  mapId: string;
  missionId: string | null;
  difficulty: Difficulty;
  seed: number;
  bot: string | null;
  minutes: number;
  /** true when the requested map/mission was not actually available (fallback was used). */
  fallback: string | null;
  gameOver: boolean;
  winnerTeam: number | null;
  /** 'hospital' | 'pathogen' | 'draw' (game over, no winner) | 'timeout' (still running at the end) */
  winner: 'hospital' | 'pathogen' | 'draw' | 'timeout';
  reason: string | null;
  endTime: number;
  ticks: number;
  aborted: boolean;
  players: Record<number, PlayerSummary>;
  timeline: TimelineSample[];
  exceptions: CaughtException[];
  consoleErrors: string[];
  consoleErrorCount: number;
  consoleWarnCount: number;
  violations: Violation[];
  violationCounts: Record<string, number>;
  events: Record<string, number>;
  mission: { id: string; state: string; objectives: Array<{ id: string; text: string; state: string; primary: boolean }> } | null;
  ai: string | null;
  botReport: string | null;
  botStats: Record<string, number> | null;
  /** last decision-log lines when the bot was created with { log: true } */
  botLog: string[] | null;
  /** FNV-1a hash of the final world state (entities, players, projectiles) — determinism fingerprint. */
  stateHash: string;
  /** wall-clock — excluded from fingerprint() */
  wallMs: number;
  msPerTick: number;
  /** only with { profile: true } — excluded from fingerprint() */
  profile?: MatchProfile;
}

const firstLines = (s: string | undefined, n = 6): string => (s ?? '').split('\n').slice(0, n).join('\n');

function errText(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) return { message: `${err.name}: ${err.message}`, stack: firstLines(err.stack, 8) };
  return { message: String(err), stack: '' };
}

function fmtArg(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}\n${firstLines(a.stack, 5)}`;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a, (_k, v) => (typeof v === 'object' && v && 'def' in v && 'id' in v ? `[entity ${(v as Entity).defId}#${(v as Entity).id}]` : v))?.slice(0, 400) ?? String(a); } catch { return String(a); }
}

export function mapRegistered(id: string): boolean { return listMaps().some((m) => m.id === id); }
export function missionRegistered(id: string): boolean { return CAMPAIGN.some((m) => m.id === id); }

/** Counts of the player's alive entities by category. */
export function samplePlayer(world: World, id: PlayerId): PlayerSample {
  const p = world.player(id);
  const s: PlayerSample = { workers: 0, army: 0, armyPop: 0, buildings: 0, foundations: 0, matter: Math.floor(p.resources.matter), energy: Math.floor(p.resources.energy), popUsed: p.popUsed, popCap: p.popCap };
  for (const e of world.list) {
    if (!e.alive || e.owner !== id) continue;
    if (e.kind === 'building') { if (e.construction) s.foundations++; else s.buildings++; }
    else if (e.kind === 'unit') {
      if (e.gatherer) s.workers++;
      else { s.army++; s.armyPop += e.def.kind === 'unit' ? e.def.pop : 0; }
    }
  }
  return s;
}

function summarizePlayer(world: World, id: PlayerId): PlayerSummary {
  const p = world.player(id);
  const smp = samplePlayer(world, id);
  const unitsByType: Record<string, number> = {}, buildingsByType: Record<string, number> = {};
  for (const e of world.list) {
    if (!e.alive || e.owner !== id) continue;
    if (e.kind === 'unit') unitsByType[e.defId] = (unitsByType[e.defId] ?? 0) + 1;
    else if (e.kind === 'building') buildingsByType[e.defId] = (buildingsByType[e.defId] ?? 0) + 1;
  }
  return {
    id, name: p.name, faction: p.faction, team: p.team, controller: p.controller, defeated: p.defeated,
    stats: Object.fromEntries(Object.entries(p.stats).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    resources: { matter: Math.floor(p.resources.matter), energy: Math.floor(p.resources.energy) },
    popUsed: p.popUsed, popCap: p.popCap,
    units: smp.workers + smp.army, workers: smp.workers, army: smp.army, buildings: smp.buildings + smp.foundations,
    upgrades: [...p.upgrades].sort(), unitsByType, buildingsByType,
  };
}

// ── determinism fingerprint ──
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
class Fnv {
  h = 0x811c9dc5;
  int(n: number): void { this.h = Math.imul(this.h ^ (n | 0), 0x01000193) >>> 0; }
  num(n: number): void { f64[0] = Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : -1; this.int(u32[0]!); this.int(u32[1]!); }
  str(s: string): void { for (let i = 0; i < s.length; i++) this.int(s.charCodeAt(i)); this.int(0xff); }
}

/** Hash of the full simulation state that matters for determinism. */
export function worldStateHash(world: World): string {
  const h = new Fnv();
  h.int(world.tick);
  for (const e of [...world.list].sort((a, b) => a.id - b.id)) {
    h.int(e.id); h.str(e.defId); h.int(e.owner); h.int(e.alive ? 1 : 0);
    h.num(e.pos.x); h.num(e.pos.y); h.num(e.hp); h.num(e.facing);
    h.int(e.orders.length); if (e.orders[0]) h.str(e.orders[0].type);
    if (e.resource) h.num(e.resource.amount);
    if (e.gatherer) h.num(e.gatherer.carrying);
    if (e.construction) h.num(e.construction.progress);
    for (const it of e.production?.queue ?? []) { h.str(it.defId); h.num(it.progress); }
  }
  for (const p of [...world.players.values()].sort((a, b) => a.id - b.id)) {
    h.int(p.id); h.num(p.resources.matter); h.num(p.resources.energy); h.int(p.popUsed); h.int(p.popCap); h.int(p.defeated ? 1 : 0);
    for (const u of [...p.upgrades].sort()) h.str(u);
  }
  h.int(world.projectiles.length);
  for (const pr of world.projectiles) { h.int(pr.id); h.num(pr.pos.x); h.num(pr.pos.y); h.num(pr.t); }
  return h.h.toString(16).padStart(8, '0');
}

/** The summary minus wall-clock fields — equal for equal seeds if the sim is deterministic. */
export function fingerprint(s: MatchSummary): string {
  const { wallMs: _w, msPerTick: _m, profile: _p, ...rest } = s;
  return JSON.stringify(rest);
}

/** Wrap every system's update() with a timer (World.systems is private in TS but a plain array at runtime). */
function instrumentSystems(world: World, totals: Record<string, number>): void {
  const systems = (world as unknown as { systems?: Array<{ name: string; update: (w: World, dt: number) => void }> }).systems;
  if (!Array.isArray(systems)) return;
  for (const sys of systems) {
    const orig = sys.update;
    const key = `system:${sys.name}`;
    sys.update = (w: World, dt: number) => { const t = performance.now(); try { orig.call(sys, w, dt); } finally { totals[key] = (totals[key] ?? 0) + performance.now() - t; } };
  }
}

export function runMatch(opts: RunMatchOptions): MatchSummary {
  const t0 = Date.now();
  const mode = opts.mode ?? 'skirmish';
  const difficulty = opts.difficulty ?? 'normal';
  const seed = opts.seed ?? 1;
  const exceptions: CaughtException[] = [];
  const consoleErrors: string[] = [];
  let consoleErrorCount = 0, consoleWarnCount = 0;
  const maxEx = opts.maxExceptions ?? 25;
  const echo = opts.echoConsole ?? 10;
  const capture = opts.captureConsole !== false;
  const origError = console.error, origWarn = console.warn;
  let world: World | null = null;
  const tickOf = () => (world ? world.tick : -1);
  const timeOf = () => (world ? Math.round(world.time * 100) / 100 : 0);
  if (capture) {
    console.error = (...args: unknown[]) => {
      consoleErrorCount++;
      const msg = `[t=${timeOf()}s tick ${tickOf()}] ${args.map(fmtArg).join(' ')}`;
      if (consoleErrors.length < 50) consoleErrors.push(msg.slice(0, 1500));
      if (consoleErrorCount <= echo) origError.call(console, '[captured console.error]', ...args);
    };
    console.warn = (...args: unknown[]) => {
      consoleWarnCount++;
      if (consoleWarnCount <= 5) origWarn.call(console, '[captured console.warn]', ...args);
    };
  }
  const guard = (phase: CaughtException['phase'], fn: () => void): boolean => {
    try { fn(); return true; } catch (err) {
      const { message, stack } = errText(err);
      exceptions.push({ phase, tick: tickOf(), time: timeOf(), message, stack });
      return false;
    }
  };

  let match: HeadlessMatch | null = null;
  let bot: HospitalBot | null = null;
  let checker: InvariantChecker | null = null;
  let fallback: string | null = null;
  const events: Record<string, number> = {};
  const timeline: TimelineSample[] = [];
  let aborted = false;
  let ticksRun = 0;
  let gameOverReason: string | null = null;
  const prof: Record<string, number> = {};
  const timed = (key: string, fn: () => void): void => {
    if (!opts.profile) { fn(); return; }
    const t = performance.now();
    try { fn(); } finally { prof[key] = (prof[key] ?? 0) + performance.now() - t; }
  };
  const requestedMap = opts.mapId ?? (mode === 'campaign' ? CAMPAIGN.find((m) => m.id === opts.missionId)?.mapId ?? 'meilahti' : 'test');
  try {
    if (!opts.map && !mapRegistered(requestedMap)) fallback = `map "${requestedMap}" not registered`;
    if (mode === 'campaign' && !missionRegistered(opts.missionId ?? 'm1')) fallback = `mission "${opts.missionId}" not registered`;
    guard('setup', () => {
      match = createHeadlessMatch({ mode, mapId: opts.mapId, map: opts.map, missionId: opts.missionId, difficulty, seed, enemyAi: opts.enemyAi !== false });
    });
    const m = match as HeadlessMatch | null;
    if (!m) {
      aborted = true;
      return finish();
    }
    world = m.world;
    const w = world;
    if (opts.bot) {
      const bo: HospitalBotOptions = typeof opts.bot === 'string' ? { strength: opts.bot } : opts.bot;
      guard('setup', () => { bot = createHospitalBot(w, { playerId: m.playerId, enemyId: m.enemyId, ...bo }); });
    }
    if (opts.invariants !== false) {
      const base: Partial<InvariantOptions> = mode === 'campaign' ? { popCheck: 'hospital', popSlack: 8, popBaselineFromStart: true } : {};
      checker = new InvariantChecker({ ...base, ...(opts.invariants ?? {}) });
    }
    for (const type of ['entityDied', 'entitySpawned', 'constructionComplete', 'productionComplete', 'researchComplete', 'weaponFired', 'projectileImpact', 'abilityUsed', 'underAttack', 'notEnough', 'resourceDepleted', 'playerDefeated', 'gameOver'] as const) {
      w.events.on(type, () => { events[type] = (events[type] ?? 0) + 1; });
    }
    w.events.on('gameOver', (ev) => { gameOverReason = ev.reason; });
    const ctx: MatchContext = { match: m, world: w, bot, checker };
    if (opts.profile) instrumentSystems(w, prof);
    if (opts.onSetup) guard('hook', () => opts.onSetup!(ctx));
    if (checker) guard('invariants', () => checker!.check(w));
    const every = Math.max(1, checker?.opts.every ?? 20);
    const tlEvery = opts.timelineEvery ?? 60;
    const sample = () => {
      const players: Record<number, PlayerSample> = {};
      for (const p of w.activePlayers()) players[p.id] = samplePlayer(w, p.id);
      timeline.push({ t: Math.round(w.time), players });
    };
    sample();
    let nextSample = tlEvery;
    const total = Math.round((opts.minutes * 60) / w.dt);
    const stopOnGameOver = opts.stopOnGameOver !== false;
    for (let i = 0; i < total; i++) {
      if (stopOnGameOver && w.rules.gameOver) break;
      const b = bot as HospitalBot | null;
      if (b) timed('bot', () => guard('bot', () => b.update()));
      if (opts.onTick) guard('hook', () => opts.onTick!(ctx));
      for (const ai of m.ais) timed('ai', () => guard('ai', () => ai.update(w.dt)));
      if (m.mission) { const mi = m.mission; timed('mission', () => guard('mission', () => mi.update(w.dt))); }
      timed('world.step', () => guard('world', () => w.step()));
      ticksRun++;
      if (checker && w.tick % every === 0) {
        const c = checker;
        let ok = true;
        timed('invariants', () => { ok = guard('invariants', () => c.check(w)); });
        if (!ok && c.opts.throwOnViolation) { aborted = true; break; }
      }
      if (w.time + 1e-9 >= nextSample) { sample(); nextSample += tlEvery; }
      if (exceptions.length >= maxEx) { aborted = true; break; }
    }
    if (checker) { const c = checker; guard('invariants', () => c.finalCheck(w, mode)); }
    if (!timeline.length || timeline[timeline.length - 1]!.t !== Math.round(w.time)) sample();
    return finish();
  } finally {
    if (capture) { console.error = origError; console.warn = origWarn; }
    (bot as HospitalBot | null)?.dispose();
  }

  function finish(): MatchSummary {
    const w = world;
    const m = match as HeadlessMatch | null;
    const players: Record<number, PlayerSummary> = {};
    if (w) for (const p of w.activePlayers()) players[p.id] = summarizePlayer(w, p.id);
    let winner: MatchSummary['winner'] = 'timeout';
    const wt = w?.rules.winnerTeam ?? null;
    if (w?.rules.gameOver) {
      const team = w.activePlayers().find((p) => p.team === wt);
      winner = wt == null || !team ? 'draw' : team.faction === 'hospital' ? 'hospital' : 'pathogen';
    }
    let mission: MatchSummary['mission'] = null;
    if (m?.mission) {
      const mi = m.mission;
      let objectives: Array<{ id: string; text: string; state: string; primary: boolean }> = [];
      guard('mission', () => { objectives = mi.objectives().map((o) => ({ id: o.id, text: o.text, state: o.state, primary: o.primary })); });
      mission = { id: mi.info.id, state: mi.state, objectives };
    }
    let ai: string | null = null;
    if (m?.ais[0]) { const a = m.ais[0]; guard('ai', () => { ai = a.describe(); }); }
    const b = bot as HospitalBot | null;
    const wall = Date.now() - t0;
    return {
      mode, mapId: w?.map.id ?? requestedMap, missionId: mode === 'campaign' ? (m?.mission?.info.id ?? opts.missionId ?? null) : null,
      difficulty, seed, bot: b ? b.strength : null, minutes: opts.minutes, fallback,
      gameOver: !!w?.rules.gameOver, winnerTeam: wt, winner, reason: w?.rules.gameOver ? gameOverReason ?? 'unknown' : null,
      endTime: w ? Math.round(w.time * 100) / 100 : 0, ticks: w?.tick ?? 0, aborted,
      players, timeline, exceptions, consoleErrors, consoleErrorCount, consoleWarnCount,
      violations: checker?.violations ?? [], violationCounts: { ...(checker?.counts ?? {}) },
      events, mission, ai, botReport: b ? b.describe() : null, botStats: b ? { ...b.stats } : null, botLog: b && b.log.length ? b.log.slice(-200) : null,
      stateHash: w ? worldStateHash(w) : '00000000',
      wallMs: wall, msPerTick: ticksRun ? Math.round((wall / ticksRun) * 1000) / 1000 : 0,
      ...(opts.profile ? { profile: {
        ticks: ticksRun,
        totalMs: Object.fromEntries(Object.entries(prof).map(([k, v]): [string, number] => [k, Math.round(v)]).sort((a, b) => b[1] - a[1])),
        perTickMs: Object.fromEntries(Object.entries(prof).map(([k, v]): [string, number] => [k, ticksRun ? Math.round((v / ticksRun) * 1000) / 1000 : 0]).sort((a, b) => b[1] - a[1])),
      } } : {}),
    };
  }
}

// ───────────────────────────── reporting helpers ─────────────────────────────
export function errorViolations(s: MatchSummary): Violation[] { return s.violations.filter((v) => v.severity === 'error'); }
export function warnViolations(s: MatchSummary): Violation[] { return s.violations.filter((v) => v.severity === 'warn'); }

const mmss = (t: number): string => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function formatViolations(s: MatchSummary, max = 12): string {
  const list = s.violations.slice(0, max).map((v) => `  [${v.severity}] ${v.check} @${mmss(v.time)} (tick ${v.tick}): ${v.message}`);
  const counts = Object.entries(s.violationCounts).map(([k, n]) => `${k}×${n}`).join(', ');
  return `${s.violations.length} violation record(s) [${counts || 'none'}]\n${list.join('\n')}`;
}

export function formatExceptions(s: MatchSummary, max = 8): string {
  const ex = s.exceptions.slice(0, max).map((e) => `  [${e.phase}] @${mmss(e.time)} tick ${e.tick}: ${e.message}\n${e.stack.split('\n').slice(1, 5).map((l) => `      ${l.trim()}`).join('\n')}`);
  const ce = s.consoleErrors.slice(0, max).map((c) => `  [console.error] ${c.split('\n').slice(0, 4).join('\n      ')}`);
  return [`${s.exceptions.length} exception(s), ${s.consoleErrorCount} console.error(s)`, ...ex, ...ce].join('\n');
}

/** One-line outcome + compact per-player state. */
export function describeSummary(s: MatchSummary): string {
  const where = s.mode === 'campaign' ? `campaign ${s.missionId} on ${s.mapId}` : `skirmish ${s.mapId}`;
  const outcome = s.gameOver ? `${s.winner.toUpperCase()} wins at ${mmss(s.endTime)} (${s.reason ?? '?'})` : `no result after ${mmss(s.endTime)}`;
  const ps = Object.values(s.players).map((p) => `p${p.id} ${p.faction}${p.defeated ? ' [defeated]' : ''}: W${p.workers} A${p.army} B${p.buildings} pop ${p.popUsed}/${p.popCap} killed ${p.stats.unitsKilled}u/${p.stats.buildingsKilled}b lost ${p.stats.unitsLost}u/${p.stats.buildingsLost}b gathered ${Math.round(p.stats.matterGathered ?? 0)}`).join(' | ');
  const errs = errorViolations(s).length, warns = warnViolations(s).length;
  return `${where} ${s.difficulty} seed=${s.seed} bot=${s.bot ?? '-'}: ${outcome}${s.fallback ? ` [FALLBACK: ${s.fallback}]` : ''}\n  ${ps}\n  exceptions=${s.exceptions.length} console.errors=${s.consoleErrorCount} violations: ${errs} error / ${warns} warn ${JSON.stringify(s.violationCounts)} | ${s.wallMs} ms wall, ${s.msPerTick} ms/tick${s.botReport ? `\n  ${s.botReport}` : ''}${s.ai ? `\n  ai: ${s.ai}` : ''}`;
}

/** "world.step 1.2 ms/tick (movement 0.6, combat 0.3, ...), ai 0.4, bot 0.05" — from a profiled summary. */
export function formatProfile(s: MatchSummary): string {
  const p = s.profile;
  if (!p) return '(no profile — run with { profile: true })';
  const sys = Object.entries(p.perTickMs).filter(([k]) => k.startsWith('system:')).map(([k, v]) => `${k.slice(7)} ${v}`).join(', ');
  const top = Object.entries(p.perTickMs).filter(([k]) => !k.startsWith('system:')).map(([k, v]) => `${k} ${v}`).join(', ');
  return `profile ms/tick over ${p.ticks} ticks: ${top} | systems: ${sys}`;
}

/** Army/worker timeline as a compact table (one line per sample). */
export function formatTimeline(s: MatchSummary): string {
  return s.timeline.map((t) => `  ${mmss(t.t).padStart(5)} ` + Object.entries(t.players).map(([id, p]) => `p${id}: W${p.workers} A${p.army}(${p.armyPop}) B${p.buildings}+${p.foundations} $${p.matter}/${p.energy} pop ${p.popUsed}/${p.popCap}`).join(' | ')).join('\n');
}

// ───────────────────────────── persistence ─────────────────────────────
/** Directory for JSON match reports (override with QA_OUT). */
export const QA_OUT = process.env.QA_OUT ?? '/tmp/immune-qa';

/** Write a summary to $QA_OUT/<name>.json (best effort) and return the path. */
export function saveSummary(name: string, s: MatchSummary | unknown): string {
  const file = join(QA_OUT, `${name.replace(/[^\w.-]+/g, '_')}.json`);
  try { mkdirSync(QA_OUT, { recursive: true }); writeFileSync(file, JSON.stringify(s, null, 2)); } catch { /* ignore */ }
  return file;
}
