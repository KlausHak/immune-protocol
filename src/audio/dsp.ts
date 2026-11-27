/**
 * [audio] Low-level Web Audio building blocks shared by the SFX recipes, the music instruments and the
 * ambient bed. Everything works on any BaseAudioContext (realtime AudioContext or OfflineAudioContext),
 * so the sandbox self-test renders exactly the graphs the game plays and measures them.
 *
 * Nothing in this file touches browser globals at import time: Node tests import the engine, which must
 * load (and silently no-op) without Web Audio.
 */

export type Rand = () => number;

/** mulberry32: tiny seeded PRNG (per-play variation; seeded by the offline self-test for repeatability). */
export function makeRng(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
/** Floor for exponential ramps (≈ -80 dB); exponential ramps can't reach 0. */
export const EPS = 1e-4;

export type NoiseKind = 'white' | 'pink' | 'brown';
/** Something a node can be connected to: another node or an AudioParam (for modulation). */
export type Dest = AudioNode | AudioParam;

/** Per-context cache of noise buffers and periodic waves (built once, shared by every voice). */
export interface Bank {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  /** soft saw-like wave (pads) */
  warm: PeriodicWave;
  /** odd-harmonic reed/organ wave */
  reed: PeriodicWave;
  /** near-sine with a few upper partials (glassy blips, medical-tech UI) */
  glass: PeriodicWave;
}

const BANKS = new WeakMap<BaseAudioContext, Bank>();

export function getBank(ctx: BaseAudioContext): Bank {
  let b = BANKS.get(ctx);
  if (!b) { b = buildBank(ctx); BANKS.set(ctx, b); }
  return b;
}

/**
 * A 2 s mono noise buffer that loops seamlessly: the head is cross-faded with the samples that would
 * follow the tail, so brown noise (strong low end) does not click at the loop point.
 */
function loopableNoise(ctx: BaseAudioContext, filter: () => (x: number) => number, seed: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * 2);
  const fade = 2048;
  const raw = new Float32Array(len + fade);
  const rng = makeRng(seed);
  const f = filter();
  for (let i = 0; i < raw.length; i++) raw[i] = f(rng() * 2 - 1);
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    let v = raw[i]!;
    if (i < fade) { const a = i / fade; v = v * a + raw[len + i]! * (1 - a); }
    d[i] = v;
    const av = Math.abs(v);
    if (av > peak) peak = av;
  }
  const s = peak > 0 ? 0.95 / peak : 1;
  for (let i = 0; i < len; i++) d[i] = d[i]! * s;
  return buf;
}

function periodic(ctx: BaseAudioContext, amps: number[]): PeriodicWave {
  const real = new Float32Array(amps.length + 1);
  const imag = new Float32Array(amps.length + 1);
  amps.forEach((a, i) => { imag[i + 1] = a; });
  return ctx.createPeriodicWave(real, imag);
}

function buildBank(ctx: BaseAudioContext): Bank {
  return {
    white: loopableNoise(ctx, () => (x) => x, 0x51f15e),
    // Paul Kellet's refined pink-noise filter
    pink: loopableNoise(ctx, () => {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      return (x) => {
        b0 = 0.99886 * b0 + x * 0.0555179; b1 = 0.99332 * b1 + x * 0.0750759; b2 = 0.969 * b2 + x * 0.153852;
        b3 = 0.8665 * b3 + x * 0.3104856; b4 = 0.55 * b4 + x * 0.5329522; b5 = -0.7616 * b5 - x * 0.016898;
        const y = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362;
        b6 = x * 0.115926;
        return y;
      };
    }, 0x9a1c3),
    // leaky integrator → brown/red noise
    brown: loopableNoise(ctx, () => { let last = 0; return (x) => (last = (last + 0.02 * x) / 1.02); }, 0x3b7d),
    warm: periodic(ctx, [1, 0.5, 0.32, 0.2, 0.13, 0.08, 0.05, 0.03, 0.02]),
    reed: periodic(ctx, [1, 0.04, 0.34, 0.03, 0.18, 0.02, 0.1, 0, 0.05]),
    glass: periodic(ctx, [1, 0.18, 0.06, 0.12, 0, 0.04]),
  };
}

const isParam = (d: Dest): d is AudioParam => typeof (d as AudioNode).connect !== 'function';
function link(n: AudioNode, d: Dest): void {
  if (isParam(d)) n.connect(d); else n.connect(d);
}

/** Node factory bound to one context + RNG. Recipes build their graphs backwards from `out`. */
export class Kit {
  readonly bank: Bank;
  constructor(readonly ctx: BaseAudioContext, public r: Rand = Math.random) { this.bank = getBank(ctx); }

  /** Clamp an oscillator frequency below Nyquist (avoids aliasing + range warnings at low sample rates). */
  hz(f: number): number { return Math.min(Math.max(1, f), this.ctx.sampleRate * 0.48); }

  /** 1 ± amount (uniform). */
  jit(amount: number): number { return 1 + (this.r() * 2 - 1) * amount; }
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.r(); }
  pick<T>(items: readonly T[]): T { return items[Math.min(items.length - 1, Math.floor(this.r() * items.length))]!; }

  gain(dest: Dest, value = 1): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    link(g, dest);
    return g;
  }

  filter(dest: Dest, type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    link(f, dest);
    return f;
  }

  /** Stereo panner (falls back to a pass-through gain where StereoPannerNode is unavailable). */
  panner(dest: Dest, pan: number): AudioNode {
    if (typeof this.ctx.createStereoPanner !== 'function') return this.gain(dest, 1);
    const p = this.ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    link(p, dest);
    return p;
  }

  osc(dest: Dest, type: OscillatorType, freq: number, t0: number, t1: number, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(this.hz(freq), t0);
    if (detune) o.detune.setValueAtTime(detune, t0);
    link(o, dest);
    o.start(t0);
    o.stop(t1 + 0.01);
    return o;
  }

  wave(dest: Dest, w: PeriodicWave, freq: number, t0: number, t1: number, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.setPeriodicWave(w);
    o.frequency.setValueAtTime(this.hz(freq), t0);
    if (detune) o.detune.setValueAtTime(detune, t0);
    link(o, dest);
    o.start(t0);
    o.stop(t1 + 0.01);
    return o;
  }

  /** Looping noise source starting at a random offset (so repeated plays differ). */
  noise(dest: Dest, kind: NoiseKind, t0: number, dur: number, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    const buf = this.bank[kind];
    s.buffer = buf;
    s.loop = true;
    if (rate !== 1) s.playbackRate.value = rate;
    link(s, dest);
    s.start(t0, this.r() * (buf.duration - 0.05));
    s.stop(t0 + dur + 0.01);
    return s;
  }

  /** Fresh gain with a percussive envelope: linear attack to `peak`, exponential decay to silence. */
  perc(dest: Dest, t: number, peak: number, attack: number, decay: number): GainNode {
    const g = this.gain(dest, 0);
    const p = g.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + attack);
    p.exponentialRampToValueAtTime(EPS, t + attack + decay);
    p.setValueAtTime(0, t + attack + decay);
    return g;
  }
}

// ───────────────────────── atoms (tiny gestures recipes are made of) ─────────────────────────

export interface ToneSpec {
  type?: OscillatorType;
  wave?: PeriodicWave;
  /** start frequency (Hz) */
  f: number;
  /** glide target (Hz), exponential */
  to?: number;
  /** glide time (s); default = whole note */
  glide?: number;
  t: number;
  /** attack (s), default 2 ms */
  a?: number;
  /** decay (s) to silence */
  d: number;
  peak: number;
  detune?: number;
}

/** Oscillator with an optional pitch glide and a percussive envelope. Returns the end time. */
export function tone(k: Kit, dest: Dest, s: ToneSpec): number {
  const a = s.a ?? 0.002;
  const end = s.t + a + s.d;
  const g = k.perc(dest, s.t, s.peak, a, s.d);
  const o = s.wave ? k.wave(g, s.wave, s.f, s.t, end, s.detune) : k.osc(g, s.type ?? 'sine', s.f, s.t, end, s.detune);
  if (s.to !== undefined && s.to !== s.f) o.frequency.exponentialRampToValueAtTime(k.hz(s.to), s.t + (s.glide ?? a + s.d));
  return end;
}

export interface HissSpec {
  kind?: NoiseKind;
  type?: BiquadFilterType;
  /** filter frequency (Hz) */
  f: number;
  /** filter sweep target (Hz), exponential */
  to?: number;
  glide?: number;
  q?: number;
  t: number;
  a?: number;
  d: number;
  peak: number;
  rate?: number;
}

/** Filtered noise burst with an optional filter sweep. Returns the end time. */
export function hiss(k: Kit, dest: Dest, s: HissSpec): number {
  const a = s.a ?? 0.002;
  const end = s.t + a + s.d;
  const g = k.perc(dest, s.t, s.peak, a, s.d);
  const f = k.filter(g, s.type ?? 'bandpass', s.f, s.q ?? 0.8);
  if (s.to !== undefined && s.to !== s.f) {
    f.frequency.setValueAtTime(s.f, s.t);
    f.frequency.exponentialRampToValueAtTime(Math.max(10, s.to), s.t + (s.glide ?? a + s.d));
  }
  k.noise(f, s.kind ?? 'white', s.t, a + s.d, s.rate);
  return end;
}

/** Random micro-bursts of band-passed noise (electric crackle, crumbling debris, sizzle). */
export function crackle(k: Kit, dest: Dest, t: number, dur: number, count: number, peak: number, freq: number, q = 0.9): number {
  const g = k.gain(dest, 0);
  const bp = k.filter(g, 'bandpass', freq, q);
  k.noise(bp, 'white', t, dur + 0.02);
  const times: number[] = [];
  for (let i = 0; i < count; i++) times.push(k.r() * dur);
  times.sort((x, y) => x - y);
  g.gain.setValueAtTime(0, t);
  let lastEnd = -1;
  for (const ti of times) {
    const st = Math.max(ti, lastEnd + 0.002);
    if (st >= dur) break;
    const len = 0.002 + k.r() * 0.012;
    const amp = peak * (0.35 + 0.65 * k.r()) * (1 - 0.6 * (st / dur));
    g.gain.setValueAtTime(amp, t + st);
    g.gain.setValueAtTime(0, t + st + len);
    lastEnd = st + len;
  }
  return t + dur + 0.02;
}

/** Inharmonic struck-metal partials (free bar modes). */
export function metal(k: Kit, dest: Dest, f0: number, t: number, d: number, peak: number): number {
  const ratios = [1, 2.76, 5.4, 8.93];
  let end = t;
  ratios.forEach((r, i) => {
    end = Math.max(end, tone(k, dest, { f: f0 * r * k.jit(0.01), t, a: 0.0015, d: d / (1 + i * 0.6), peak: peak / (1 + i * 0.8) }));
  });
  return end;
}

/** Two-operator FM bell: bright attack that mellows as the modulation index decays. */
export function fmBell(k: Kit, dest: Dest, f: number, t: number, d: number, peak: number, ratio = 2, index = 1): number {
  const end = t + 0.003 + d;
  const g = k.perc(dest, t, peak, 0.003, d);
  const car = k.osc(g, 'sine', f, t, end);
  const mg = k.gain(car.frequency, 0);
  mg.gain.setValueAtTime(f * index, t);
  mg.gain.exponentialRampToValueAtTime(Math.max(EPS, f * index * 0.02), t + d * 0.8);
  k.osc(mg, 'sine', f * ratio, t, end);
  return end;
}
