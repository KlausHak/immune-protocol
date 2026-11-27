/**
 * [audio] Voice management: per-sound rate limiting, per-sound voice caps, a global cap for world SFX,
 * crowd attenuation (many identical sounds in a short window get quieter) and voice recycling.
 *
 * `VoicePolicy` is pure bookkeeping (Node-testable); `VoiceManager` wires it to Web Audio nodes.
 */
import { clamp, type Kit } from './dsp';
import { SFX, type SfxBus, type SfxId, type SfxSpec } from './sfx';

export interface VoiceSlot {
  id: string;
  bus: string;
  start: number;
  end: number;
  level: number;
  priority: number;
}

export interface Admission<T extends VoiceSlot> {
  ok: boolean;
  /** number of other starts of this sound in the crowd window (0 = alone) */
  crowd: number;
  /** voices to fade out to make room */
  steal: T[];
}

export interface VoiceLimits { voices: number; interval: number }

/** Window (s) used to count recent starts of the same sound for crowd attenuation. */
export const CROWD_WINDOW = 0.3;
export const crowdGain = (crowd: number): number => 1 / (1 + 0.3 * crowd);

const rank = (priority: number, level: number): number => priority * 10 + level;

export class VoicePolicy<T extends VoiceSlot> {
  readonly active: T[] = [];
  private lastStart = new Map<string, number>();
  private recent = new Map<string, number[]>();

  /** @param maxWorld global cap for voices on the 'sfx' bus */
  constructor(readonly maxWorld = 40) {}

  /** Remove and return voices that ended before `t`. */
  reap(t: number): T[] {
    const gone: T[] = [];
    for (let i = this.active.length - 1; i >= 0; i--) {
      const v = this.active[i]!;
      if (v.end < t) { gone.push(v); this.active.splice(i, 1); }
    }
    return gone;
  }

  count(id: string, at: number): number {
    let n = 0;
    for (const v of this.active) if (v.id === id && v.end > at) n++;
    return n;
  }

  admit(id: string, bus: string, when: number, level: number, priority: number, limits: VoiceLimits): Admission<T> {
    const no: Admission<T> = { ok: false, crowd: 0, steal: [] };
    const last = this.lastStart.get(id);
    if (last !== undefined && Math.abs(when - last) < limits.interval) return no;
    const steal: T[] = [];
    // per-sound cap: replace the quietest / nearly finished voice, unless the newcomer is much quieter
    const same = this.active.filter((v) => v.id === id && v.end > when);
    if (same.length >= limits.voices) {
      const score = (v: T) => v.level * Math.max(0.05, (v.end - when) / Math.max(1e-3, v.end - v.start));
      const victim = same.reduce((a, b) => (score(a) <= score(b) ? a : b));
      if (level < victim.level * 0.6) return no;
      steal.push(victim);
    }
    // global cap for world SFX: lowest priority / quietest goes first
    if (bus === 'sfx') {
      const live = this.active.filter((v) => v.bus === 'sfx' && v.end > when && !steal.includes(v));
      if (live.length >= this.maxWorld) {
        const victim = live.reduce((a, b) => (rank(a.priority, a.level) <= rank(b.priority, b.level) ? a : b));
        if (rank(priority, level) <= rank(victim.priority, victim.level)) return no;
        steal.push(victim);
      }
    }
    const recent = (this.recent.get(id) ?? []).filter((s) => when - s < CROWD_WINDOW && when >= s);
    recent.push(when);
    this.recent.set(id, recent);
    this.lastStart.set(id, when);
    return { ok: true, crowd: recent.length - 1, steal };
  }

  add(v: T): void { this.active.push(v); }
}

export interface PlayOpts {
  /** extra gain (distance attenuation etc.) */
  gain?: number;
  /** -1..1 */
  pan?: number;
  /** pitch multiplier before jitter */
  pitch?: number;
  /** 0..1 source size */
  size?: number;
  /** absolute start time (context seconds); default now */
  when?: number;
  /** override the sound's default bus */
  bus?: SfxBus;
  priority?: number;
}

interface VoiceRec extends VoiceSlot { out: GainNode; pan: AudioNode | null }

export class VoiceManager {
  readonly policy = new VoicePolicy<VoiceRec>(40);

  constructor(private k: Kit, private buses: Record<SfxBus, AudioNode>) {}

  get activeCount(): number { return this.policy.active.length; }

  /** Schedule a sound. Returns false when culled by the limiter. Never throws for unknown ids. */
  play(id: SfxId, o: PlayOpts, now: number): boolean {
    const spec: SfxSpec | undefined = SFX[id];
    if (!spec) return false;
    const bus = o.bus ?? spec.bus;
    const when = Math.max(now, o.when ?? now);
    const level = clamp(spec.gain * (o.gain ?? 1), 0, 2);
    if (level < 0.004) return false;
    this.reap(now);
    const priority = o.priority ?? spec.priority ?? 1;
    const adm = this.policy.admit(id, bus, when, level, priority, spec);
    if (!adm.ok) return false;
    for (const v of adm.steal) this.release(v, now);
    const ctx = this.k.ctx;
    const out = ctx.createGain();
    out.gain.value = level * crowdGain(adm.crowd);
    const dest = this.buses[bus];
    let pan: AudioNode | null = null;
    if (o.pan && Math.abs(o.pan) > 0.02 && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      out.connect(p);
      p.connect(dest);
      pan = p;
    } else {
      out.connect(dest);
    }
    const pitch = clamp((o.pitch ?? 1) * this.k.jit(spec.jitter ?? 0.05), 0.25, 4);
    let end: number;
    try {
      end = spec.build(this.k, out, when, { pitch, size: clamp(o.size ?? 0.5, 0, 1) });
    } catch (err) {
      out.disconnect(); pan?.disconnect();
      throw err;
    }
    this.policy.add({ id, bus, start: when, end: Math.max(end, when + 0.01), level, priority, out, pan });
    return true;
  }

  /** Quick fade-out of a stolen voice (its sources stop on their own schedule). */
  private release(v: VoiceRec, now: number): void {
    const at = Math.max(now, v.start);
    v.out.gain.setTargetAtTime(0, at, 0.015);
    v.end = Math.min(v.end, at + 0.1);
  }

  /** Disconnect voices that finished (lets the browser collect their nodes). */
  reap(now: number): void {
    for (const v of this.policy.reap(now - 0.05)) {
      try { v.out.disconnect(); v.pan?.disconnect(); } catch { /* already disconnected */ }
    }
  }

  /** Fade out and drop everything (match end / disposal). */
  stopAll(now: number): void {
    for (const v of this.policy.active) this.release(v, now);
  }
}
