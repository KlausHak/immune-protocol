/**
 * [audio] OWNER: audio agent. Procedural WebAudio SFX + adaptive music + ambient bed + announcer.
 * One instance per app (created by App before any user gesture); attach(game) subscribes to a match's
 * world events, detach() when it ends. No audio files: everything is synthesised (see sfx.ts, music.ts).
 *
 * Lifecycle / safety:
 *  - The AudioContext is created lazily in unlock() (App calls it on the first pointerdown/keydown), so
 *    no autoplay warnings. Until it is running (headless, autoplay-blocked, suspended, no Web Audio at
 *    all, Node tests) every call is a silent no-op — nothing ever throws to the caller.
 *  - Requested music mood / attached match are remembered and applied once the context runs.
 *  - Sounds are only scheduled while the context is running (a suspended context would otherwise queue
 *    everything and play it at once on resume).
 *
 * World sounds are spatialised relative to the camera target (pan + distance attenuation, camera yaw
 * and zoom aware) and only play if their position is visible to the local player.
 *
 * Testing: pass `{ context: new OfflineAudioContext(...) }` to render a whole match offline; offline
 * contexts use a virtual clock advanced by update(dt) (see sandbox/audio.ts).
 */
import type { BuildingDef, Entity, GameEvents, UnitDef, Vec2 } from '../core/types';
import { Terrain } from '../core/types';
import type { GameContext } from '../game/contracts';
import type { Settings } from '../game/settings';
import { AmbienceBed, QUIET_AMBIENCE, type AmbienceParams } from './ambience';
import { Announcer, loadSpeechPref, saveSpeechPref } from './announcer';
import { clamp, Kit, makeRng, type Rand } from './dsp';
import { createMixGraph, type MixGraph } from './graph';
import { MoodDirector } from './mood';
import { isMatchMood, MusicEngine, type MusicMood } from './music';
import { SFX, UI_SFX, WEAPON_FIRE_SFX, WEAPON_IMPACT_SFX, type SfxBus, type SfxId, type UiSound } from './sfx';
import { DEFAULT_LISTENER, panForDirection, spatialize, type Listener } from './spatial';
import { VoiceManager, type PlayOpts } from './voices';

export type { UiSound, SfxId } from './sfx';
export type { MusicMood } from './music';

export interface AudioEngineOptions {
  /** Use this context instead of creating one on unlock() (e.g. an OfflineAudioContext for tests). */
  context?: BaseAudioContext;
  /** Seed per-play variation (default: Math.random). */
  seed?: number;
}

export interface AudioStats {
  state: string;
  offline: boolean;
  mood: MusicMood;
  autoMood: boolean;
  intensity: number;
  threat: number;
  voices: number;
  played: number;
  limited: number;
  culled: number;
  hidden: number;
  byId: Record<string, number>;
  ambience: AmbienceParams;
  speech: boolean;
}

/** Spatial options for world sounds. */
export interface WorldSoundOpts { size?: number; priority?: number; delay?: number; gain?: number }

type Ctor = new (opts?: AudioContextOptions) => AudioContext;
function audioContextCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}
const isOffline = (ctx: BaseAudioContext): boolean =>
  typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;

const factionOf = (e: Entity): string => (e.def as UnitDef | BuildingDef).faction ?? 'neutral';
/** Real seconds (monotonic) for cooldowns that must also tick in menus. */
const wallClock = (): number => (typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000);

export class AudioEngine {
  private settings: Settings;
  private ctx: BaseAudioContext | null = null;
  private offline = false;
  private vtime = 0;
  private kit: Kit | null = null;
  private graph: MixGraph | null = null;
  private voices: VoiceManager | null = null;
  private music: MusicEngine | null = null;
  private ambience: AmbienceBed | null = null;
  private readonly announcer: Announcer;
  private readonly director = new MoodDirector();
  private readonly rng: Rand;
  private game: GameContext | null = null;
  private unsubs: Array<() => void> = [];
  private mood: MusicMood = 'none';
  private autoMood = false;
  private pinnedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listener: Listener = { ...DEFAULT_LISTENER };
  private scanAcc = 0;
  /** seconds of match time seen by update() (drives alarm spacing / pins) */
  private elapsed = 0;
  private ambienceOn = true;
  private amb: AmbienceParams = { ...QUIET_AMBIENCE };
  private lastAlarm = -1e9;
  private lastInfection = -1e9;
  private noThreatFor = 999;
  private warned = new Set<string>();
  private counters = { played: 0, limited: 0, culled: 0, hidden: 0 };
  private byId: Record<string, number> = {};
  private onVisibility: (() => void) | null = null;

  constructor(settings: Settings, opts: AudioEngineOptions = {}) {
    this.settings = settings;
    this.rng = opts.seed !== undefined ? makeRng(opts.seed) : Math.random;
    this.announcer = new Announcer(loadSpeechPref());
    if (opts.context) {
      try { this.adopt(opts.context); } catch (err) { this.warnOnce('adopt', err); }
    }
  }

  // ───────────────────────── public API ─────────────────────────

  /** Create/resume the AudioContext. Call from a user gesture (App does, on pointerdown/keydown). Cheap when already running. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const C = audioContextCtor();
        if (!C) return;
        const ctx = new C({ latencyHint: 'interactive' });
        this.adopt(ctx);
        // iOS/Safari: starting any source inside the gesture unlocks output
        try { const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); s.connect(ctx.destination); s.start(); } catch { /* ignore */ }
      }
      const ctx = this.ctx;
      if (ctx && !this.offline && ctx.state !== 'running' && ctx.state !== 'closed') {
        (ctx as AudioContext).resume().then(() => this.onState(), () => { /* still blocked */ });
      }
    } catch (err) { this.warnOnce('unlock', err); }
  }

  applySettings(s: Settings): void {
    this.settings = s;
    try { this.graph?.setLevels(s, this.now()); } catch (err) { this.warnOnce('settings', err); }
  }

  attach(game: GameContext): void {
    try {
      if (this.game) this.detach();
      this.game = game;
      this.director.reset();
      this.autoMood = true;
      this.pinnedUntil = 0;
      this.elapsed = 0;
      this.lastAlarm = this.lastInfection = -1e9;
      this.noThreatFor = 999;
      this.scanAcc = 1; // scan on the first update
      const ev = game.world.events;
      const on = <K extends keyof GameEvents>(type: K, fn: (p: GameEvents[K]) => void): void => {
        this.unsubs.push(ev.on(type, (p) => { try { fn(p); } catch (err) { this.warnOnce(String(type), err); } }));
      };
      on('weaponFired', (p) => this.onWeaponFired(p));
      on('projectileImpact', (p) => this.onImpact(p));
      on('entityDamaged', (p) => this.onDamaged(p));
      on('entityDied', (p) => this.onDied(p));
      on('entityHealed', (p) => this.onHealed(p));
      on('constructionStarted', (p) => this.playWorld(factionOf(p.building) === 'pathogen' ? 'construct_start_pathogen' : 'construct_start_hospital', p.building.pos));
      on('constructionComplete', (p) => this.onConstructionComplete(p.building));
      on('constructionCancelled', (p) => { if (p.building.owner === this.local) this.playLocal('construct_cancel'); });
      on('productionComplete', (p) => this.onProductionComplete(p.unit));
      on('researchComplete', (p) => this.onResearchComplete(p.playerId));
      on('resourceDelivered', (p) => { if (p.playerId === this.local) this.playWorld('resource_tick', p.worker.pos); });
      on('abilityUsed', (p) => this.onAbility(p));
      on('underAttack', (p) => this.onUnderAttack(p));
      on('notEnough', (p) => { if (p.playerId === this.local) this.playLocal('error_buzz'); });
      on('gameOver', (p) => this.onGameOver(p.winnerTeam));
      this.updateListener(game);
      this.applyMood('calm');
      if (this.live() && this.ambienceOn) this.ambience?.start(this.now());
    } catch (err) { this.warnOnce('attach', err); }
  }

  detach(): void {
    for (const u of this.unsubs.splice(0)) { try { u(); } catch { /* ignore */ } }
    const wasAttached = this.game !== null;
    this.game = null;
    this.autoMood = false;
    try {
      if (this.live()) { this.ambience?.stop(this.now()); this.voices?.stopAll(this.now()); }
      if (wasAttached && isMatchMood(this.mood)) this.applyMood('none');
      this.announcer.cancel();
    } catch (err) { this.warnOnce('detach', err); }
  }

  /** Per-frame update (called by Game). Cheap: listener copy, a 2 Hz scan, mood director, ambience. */
  update(dtReal: number): void {
    try {
      const dt = Number.isFinite(dtReal) ? clamp(dtReal, 0, 0.25) : 0;
      if (this.offline) this.vtime += dt;
      const g = this.game;
      if (g) {
        this.elapsed += dt;
        this.updateListener(g);
        this.scanAcc += dt;
        if (this.scanAcc >= 0.5) { this.scanAcc = 0; this.scan(g); }
        const m = this.director.update(dt);
        if (this.autoMood && this.elapsed >= this.pinnedUntil && isMatchMood(this.mood) && m !== this.mood) this.applyMood(m);
      }
      if (!this.live()) return;
      if (this.offline) this.pump();
      if (g && this.ambienceOn) this.ambience?.update(this.now(), dt, this.amb);
    } catch (err) { this.warnOnce('update', err); }
  }

  playUi(kind: UiSound): void {
    try { this.playLocal(UI_SFX[kind] ?? 'ui_click', 'ui'); } catch (err) { this.warnOnce('playUi', err); }
  }

  /**
   * Request a music mood. Outside matches it simply plays. During a match the score is adaptive;
   * an explicit calm/tension/battle request pins that mood for 45 s, anything else (victory, defeat,
   * menu, none) pins it until the match ends.
   */
  setMusic(mood: MusicMood): void {
    try {
      if (this.game && this.autoMood) this.pinnedUntil = isMatchMood(mood) ? this.elapsed + 45 : Infinity;
      this.applyMood(mood);
    } catch (err) { this.warnOnce('setMusic', err); }
  }

  /** Re-enable the adaptive match score after an explicit setMusic(). */
  resumeAdaptiveMusic(): void { this.pinnedUntil = 0; if (this.game) this.autoMood = true; }

  /** Play any catalogue sound: spatialised at `pos` during a match, otherwise centred. */
  playSfx(id: SfxId, opts: WorldSoundOpts & { pos?: Vec2; bus?: SfxBus } = {}): void {
    try {
      if (opts.pos && this.game) this.playWorld(id, opts.pos, opts);
      else this.playLocal(id, opts.bus, { gain: opts.gain, size: opts.size, priority: opts.priority, when: opts.delay ? this.now() + opts.delay : undefined });
    } catch (err) { this.warnOnce('playSfx', err); }
  }

  /** Opt-in spoken announcer lines (speechSynthesis). Default off; persisted locally. */
  setSpeechEnabled(on: boolean): void {
    this.announcer.enabled = on;
    saveSpeechPref(on);
    if (!on) this.announcer.cancel();
  }
  get speechEnabled(): boolean { return this.announcer.enabled; }
  static get speechSupported(): boolean { return Announcer.supported; }

  /** Ambient bed on/off during matches (default on). */
  setAmbienceEnabled(on: boolean): void {
    this.ambienceOn = on;
    try {
      if (!this.live()) return;
      if (on && this.game) this.ambience?.start(this.now());
      if (!on) this.ambience?.stop(this.now());
    } catch (err) { this.warnOnce('ambience', err); }
  }

  /** True when sound can actually be heard (context created and running). */
  get ready(): boolean { return this.live(); }
  get currentMood(): MusicMood { return this.mood; }

  /** Debug/telemetry snapshot (window.__app.audio.stats()). */
  stats(): AudioStats {
    return {
      state: this.ctx ? this.ctx.state : 'none', offline: this.offline, mood: this.mood, autoMood: this.autoMood,
      intensity: Math.round(this.director.intensity * 100) / 100, threat: this.director.threat,
      voices: this.voices?.activeCount ?? 0, ...this.counters, byId: { ...this.byId }, ambience: { ...this.amb },
      speech: this.announcer.enabled,
    };
  }

  /** Close the context and release everything (sandbox/tests; the game keeps one engine forever). */
  dispose(): void {
    this.detach();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.onVisibility && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    try { this.music?.dispose(); this.graph?.disconnect(); } catch { /* ignore */ }
    const ctx = this.ctx;
    this.ctx = null; this.graph = null; this.voices = null; this.music = null; this.ambience = null; this.kit = null;
    if (ctx && !this.offline) { try { void (ctx as AudioContext).close(); } catch { /* ignore */ } }
  }

  // ───────────────────────── context & scheduling ─────────────────────────

  private adopt(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    this.offline = isOffline(ctx);
    const kit = new Kit(ctx, this.rng);
    this.kit = kit;
    this.graph = createMixGraph(kit);
    this.graph.setLevels(this.settings, ctx.currentTime, 0);
    this.voices = new VoiceManager(kit, this.graph.buses);
    this.music = new MusicEngine(kit, this.graph.buses.music);
    this.ambience = new AmbienceBed(kit, this.graph.ambience);
    if (!this.offline) {
      ctx.onstatechange = () => this.onState();
      if (typeof document !== 'undefined') {
        this.onVisibility = () => { if (!document.hidden) this.pump(); };
        document.addEventListener('visibilitychange', this.onVisibility);
      }
    }
    this.onState();
  }

  /** Context became running (or changed state): apply pending mood/ambience, (re)start the scheduler. */
  private onState(): void {
    try {
      if (!this.live()) {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        return;
      }
      const now = this.now();
      this.music?.setMood(this.mood, now);
      if (this.game && this.ambienceOn) this.ambience?.start(now);
      if (!this.offline && !this.timer) this.timer = setTimeout(this.loop, 0);
    } catch (err) { this.warnOnce('state', err); }
  }

  private loop = (): void => {
    this.timer = null;
    if (!this.live()) return;
    this.pump();
    this.timer = setTimeout(this.loop, 25);
  };

  /** Lookahead scheduling: ~0.2 s normally, 1.6 s when the tab is hidden (timers throttled to ~1 Hz). */
  private pump(): void {
    if (!this.live()) return;
    try {
      const now = this.now();
      const hidden = typeof document !== 'undefined' && document.hidden;
      this.music?.schedule(now + (hidden ? 1.6 : 0.2), now);
      this.voices?.reap(now);
    } catch (err) { this.warnOnce('pump', err); }
  }

  private live(): boolean {
    const c = this.ctx;
    return !!c && (this.offline || c.state === 'running');
  }

  private now(): number {
    if (this.offline) return this.vtime;
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private applyMood(m: MusicMood): void {
    this.mood = m;
    if (this.live()) this.music?.setMood(m, this.now());
  }

  private get local(): number { return this.game ? this.game.localPlayerId : -1; }

  // ───────────────────────── playback helpers ─────────────────────────

  /** Spatialised world sound: culled if inaudible or not visible to the local player. */
  private playWorld(id: SfxId, pos: Vec2, o: WorldSoundOpts = {}): void {
    const g = this.game;
    if (!g || !this.live() || !this.voices) return;
    const s = spatialize(this.listener, pos);
    const gain = s.gain * (o.gain ?? 1);
    if (gain < 0.03) { this.counters.culled++; return; }
    if (!this.visible(g, pos)) { this.counters.hidden++; return; }
    const now = this.now();
    this.count(id, this.voices.play(id, { gain, pan: s.pan, size: o.size, priority: o.priority, when: now + 0.004 + (o.delay ?? 0) }, now));
  }

  /** Non-spatial sound (UI, announcer stingers, local-player feedback). */
  private playLocal(id: SfxId, bus?: SfxBus, o: PlayOpts = {}): void {
    if (!this.live() || !this.voices) return;
    const now = this.now();
    this.count(id, this.voices.play(id, { ...o, bus: bus ?? o.bus, when: o.when ?? now + 0.004 }, now));
  }

  private count(id: SfxId, ok: boolean): void {
    if (ok) { this.counters.played++; this.byId[id] = (this.byId[id] ?? 0) + 1; } else this.counters.limited++;
  }

  private visible(g: GameContext, p: Vec2): boolean {
    try { return g.world.vision.isVisible(g.localPlayerId, p); } catch { return true; }
  }

  private isFriendly(owner: number): boolean {
    const g = this.game;
    if (!g) return false;
    if (owner === g.localPlayerId) return true;
    const ps = g.world.players;
    const me = ps.get(g.localPlayerId), them = ps.get(owner);
    return !!me && !!them && owner !== 0 && them.team === me.team;
  }

  private isHostile(owner: number): boolean {
    const g = this.game;
    if (!g || owner === 0 || owner === g.localPlayerId) return false;
    const ps = g.world.players;
    const me = ps.get(g.localPlayerId), them = ps.get(owner);
    return !!me && !!them && them.team !== me.team;
  }

  private say(line: string, cooldown: number): void {
    const v = clamp(this.settings.masterVolume, 0, 1) * clamp(this.settings.voiceVolume, 0, 1);
    if (v <= 0 || !this.live()) return;
    this.announcer.say(line, v, wallClock(), cooldown);
  }

  // ───────────────────────── event mapping ─────────────────────────

  private onWeaponFired(p: GameEvents['weaponFired']): void {
    if (this.isFriendly(p.source.owner) || (p.target && this.isFriendly(p.target.owner))) this.director.addCombat(0.08);
    const id = WEAPON_FIRE_SFX[p.weapon.vfx];
    if (id) this.playWorld(id, p.source.pos, { size: clamp(p.source.radius / 1.2, 0, 1) });
  }

  private onImpact(p: GameEvents['projectileImpact']): void {
    this.playWorld(WEAPON_IMPACT_SFX[p.projectile.vfx] ?? 'i_generic', p.pos, { size: clamp(p.projectile.splashRadius / 2.5, 0, 1) });
  }

  private onDamaged(p: GameEvents['entityDamaged']): void {
    const victim = this.isFriendly(p.entity.owner);
    if (victim || (p.source && this.isFriendly(p.source.owner))) this.director.addCombat(Math.min(1, p.amount / 25) * (victim ? 0.25 : 0.12));
  }

  private onDied(p: GameEvents['entityDied']): void {
    const e = p.entity;
    if (this.isFriendly(e.owner)) this.director.addCombat(e.kind === 'building' ? 1.2 : 0.45);
    else if (p.killer && this.isFriendly(p.killer.owner)) this.director.addCombat(0.25);
    const d = deathSound(e);
    if (d) this.playWorld(d.id, e.pos, { size: d.size, priority: d.priority });
  }

  private onHealed(p: GameEvents['entityHealed']): void {
    if (p.entity.owner !== this.local || !(p.amount > 0)) return;
    // orderlies repairing (worker source) ratchet; field medics shimmer
    const repair = !!p.source?.gatherer || p.entity.kind === 'building';
    this.playWorld(repair ? 'repair_tick' : 'heal', p.entity.pos, { gain: 0.8 });
  }

  private onConstructionComplete(b: Entity): void {
    const id: SfxId = factionOf(b) === 'pathogen' ? 'construct_done_pathogen' : 'construct_done_hospital';
    if (b.owner === this.local) this.playLocal(id, 'voice');
    else this.playWorld(id, b.pos, { gain: 0.8 });
  }

  private onProductionComplete(unit: Entity): void {
    if (unit.owner !== this.local) return;
    this.playLocal(factionOf(unit) === 'pathogen' ? 'unit_ready_pathogen' : 'unit_ready_hospital', 'voice');
    this.say('Unit ready', 12);
  }

  private onResearchComplete(playerId: number): void {
    if (playerId !== this.local) return;
    this.playLocal('research_done', 'voice');
    this.say('Research complete', 4);
  }

  private onAbility(p: GameEvents['abilityUsed']): void {
    const src = p.source;
    const at = p.target ?? p.targetEntity?.pos ?? src.pos;
    switch (p.abilityId) {
      case 'uv_flare': this.playWorld('a_uv_flare', at, { priority: 3 }); break;
      case 'emergency_supply':
        if (src.owner === this.local) { // always audible to the caller, panned toward the HQ
          const pan = spatialize(this.listener, src.pos).pan;
          this.playLocal('a_helicopter', 'sfx', { pan, priority: 3 });
          this.playLocal('a_supply_drop', 'sfx', { pan, priority: 3, when: this.now() + 1.75 });
        } else {
          this.playWorld('a_helicopter', src.pos, { priority: 3 });
          this.playWorld('a_supply_drop', src.pos, { priority: 3, delay: 1.75 });
        }
        break;
      case 'viral_burst': this.playWorld('a_viral_burst', src.pos); break;
      case 'omega_spawn': this.playWorld('a_omega_spawn', src.pos, { priority: 3 }); break;
      default: this.playWorld('a_generic', at); break;
    }
  }

  private onUnderAttack(p: GameEvents['underAttack']): void {
    if (p.playerId !== this.local) return;
    if (this.elapsed - this.lastAlarm < 8) return;
    const building = p.entity.kind === 'building';
    // units fighting right where the player is looking don't need an alarm; the base always does
    if (!building && spatialize(this.listener, p.pos).distance < 14 * this.listener.zoom) return;
    this.lastAlarm = this.elapsed;
    this.playLocal('alarm', 'voice', { pan: spatialize(this.listener, p.pos).pan * 0.5 });
    if (building) this.say('Our base is under attack', 20);
  }

  private onGameOver(winnerTeam: number | null): void {
    const g = this.game;
    if (!g) return;
    const team = g.world.players.get(g.localPlayerId)?.team;
    this.autoMood = false;
    this.applyMood(winnerTeam !== null && winnerTeam === team ? 'victory' : 'defeat');
  }

  // ───────────────────────── periodic scan (2 Hz) ─────────────────────────

  private updateListener(g: GameContext): void {
    const r = g.renderer as unknown as {
      cameraCtl?: { getTarget?: () => Vec2; distance?: number };
      camera?: { matrixWorld?: { elements: ArrayLike<number> } };
    } | undefined;
    const t = r?.cameraCtl?.getTarget?.();
    if (t && Number.isFinite(t.x) && Number.isFinite(t.y)) { this.listener.x = t.x; this.listener.y = t.y; }
    const el = r?.camera?.matrixWorld?.elements;
    if (el && el.length >= 3) { // camera local +X (screen right) in world space → sim (x, z)
      const rx = el[0]!, rz = el[2]!;
      const len = Math.hypot(rx, rz);
      if (len > 1e-3) { this.listener.rx = rx / len; this.listener.ry = rz / len; }
    }
    const d = r?.cameraCtl?.distance;
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) this.listener.zoom = clamp(d / 34, 0.4, 2.5);
  }

  /** Threat estimate (visible enemy combat units near our entities), "infection detected", ambience params. */
  private scan(g: GameContext): void {
    const w = g.world, local = g.localPlayerId;
    let threat = 0;
    for (const e of w.list) {
      if (!e.alive || e.kind !== 'unit' || !e.combat || e.tags.has('worker') || !this.isHostile(e.owner)) continue;
      let seen = true;
      try { seen = w.vision.isEntityVisible(local, e); } catch { /* assume visible */ }
      if (!seen) continue;
      if (w.spatial.nearest(e.pos, 14, (o) => o.alive && o.kind !== 'resource' && this.isFriendly(o.owner))) threat++;
    }
    this.director.setThreat(threat);
    if (threat > 0) {
      if (this.noThreatFor >= 20 && this.elapsed - this.lastInfection >= 60) {
        this.lastInfection = this.elapsed;
        this.playLocal('infection_detected', 'voice');
        this.say('Infection detected', 45);
      }
      this.noThreatFor = 0;
    } else {
      this.noThreatFor += 0.5;
    }
    this.computeAmbience(g);
  }

  private computeAmbience(g: GameContext): void {
    const w = g.world, map = w.map, l = this.listener;
    // sea: sample a 7×7 grid of tiles around the camera (6-tile spacing), weighted toward the centre
    let water = 0, wx = 0, wy = 0;
    for (let j = -3; j <= 3; j++) {
      for (let i = -3; i <= 3; i++) {
        const tx = Math.floor(l.x + i * 6), ty = Math.floor(l.y + j * 6);
        if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) continue;
        if (map.terrain[ty * map.width + tx] !== Terrain.Water) continue;
        const wgt = 1 / (1 + Math.hypot(i, j));
        water += wgt; wx += i * wgt; wy += j * wgt;
      }
    }
    // buildings near the camera: own → campus hum, visible pathogen structures → squelch
    let hum = 0, squelch = 0, sx = 0, sy = 0;
    const radius = 24 * Math.max(0.8, l.zoom);
    for (const b of w.spatial.queryRadius({ x: l.x, y: l.y }, radius, (e) => e.kind === 'building')) {
      const d = Math.hypot(b.pos.x - l.x, b.pos.y - l.y);
      const near = clamp(1 - d / radius, 0, 1);
      if (this.isFriendly(b.owner)) hum += 0.2 + 0.3 * near;
      else if (factionOf(b) === 'pathogen') {
        let seen = true;
        try { seen = w.vision.isEntityVisible(g.localPlayerId, b); } catch { /* assume visible */ }
        if (seen && near > squelch) { squelch = near; sx = b.pos.x - l.x; sy = b.pos.y - l.y; }
      }
    }
    const night = map.lighting === 'night';
    this.amb = {
      wind: clamp((night ? 0.45 : 0.55) + 0.45 * clamp((l.zoom - 0.6) / 1.4, 0, 1), 0, 1),
      sea: clamp(water / 2.2, 0, 1),
      seaPan: water > 0 ? panForDirection(l, wx, wy) : 0,
      hum: clamp(0.15 + hum, 0, 1),
      squelch: clamp(squelch * 1.3, 0, 1),
      squelchPan: squelch > 0 ? panForDirection(l, sx, sy) : 0,
    };
  }

  private warnOnce(where: string, err: unknown): void {
    if (this.warned.has(where)) return;
    this.warned.add(where);
    if (typeof console !== 'undefined') console.warn(`[audio] ${where} failed (audio continues without it):`, err);
  }
}

/** Which death sound an entity makes (null = silent, e.g. depleted resources). */
export function deathSound(e: Entity): { id: SfxId; size: number; priority: number } | null {
  if (e.kind === 'resource') return null;
  const faction = factionOf(e);
  if (e.kind === 'building') {
    const fp = (e.def as BuildingDef).footprint ?? { w: 2, h: 2 };
    const size = clamp((fp.w * fp.h) / 25, 0, 1) * (e.construction ? 0.5 : 1);
    return { id: faction === 'pathogen' ? 'd_building_pathogen' : 'd_building_hospital', size, priority: 3 };
  }
  const size = clamp(e.radius / 1.1, 0, 1);
  if (e.tags.has('hero')) return { id: 'd_boss', size: 1, priority: 3 };
  if (faction === 'pathogen') {
    return e.tags.has('massive') || e.radius >= 0.75 ? { id: 'd_pathogen_large', size, priority: 2 } : { id: 'd_pathogen_small', size, priority: 2 };
  }
  if (e.tags.has('mech')) {
    return e.tags.has('massive') || e.tags.has('armored') ? { id: 'd_mech_large', size, priority: 3 } : { id: 'd_mech_small', size, priority: 2 };
  }
  return { id: 'd_staff', size, priority: 2 }; // hospital staff are evacuated, not killed
}

/** Every sound id in the catalogue (sandbox / tests). */
export const ALL_SFX_IDS = Object.keys(SFX) as SfxId[];
