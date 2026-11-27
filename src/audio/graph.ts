/**
 * [audio] The mix graph:
 *
 *   music ─┐        ┌─ reverb send (music/sfx/voice) → convolver ─┐
 *   sfx  ──┼─ buses ┤                                             ├→ master → glue compressor → trim
 *   ui   ──┤        └─────────────────── dry ─────────────────────┘     → limiter → soft clip → out
 *   voice ─┘   (ambience feeds the sfx bus)
 *
 * Bus gains follow the settings (music/sfx/voice volume; UI rides on the sfx volume), the master gain
 * follows masterVolume, so the effective level of every bus is setting × master. Changes are smoothed.
 * The soft clipper is a last-resort ceiling (≈ 0.95) so nothing can exceed full scale.
 */
import type { Settings } from '../game/settings';
import { clamp, makeRng, type Kit } from './dsp';
import type { SfxBus } from './sfx';

export type BusId = SfxBus | 'music';

export interface MixGraph {
  readonly master: GainNode;
  readonly buses: Record<BusId, GainNode>;
  /** ambient bed input (→ sfx bus) */
  readonly ambience: GainNode;
  /** final node (already connected to the destination) */
  readonly output: AudioNode;
  setLevels(s: Settings, now: number, smooth?: number): void;
  disconnect(): void;
}

/** Internal trims so default settings give a sensible balance (music sits under the action). */
const TRIM: Record<BusId, number> = { music: 0.8, sfx: 1, ui: 0.85, voice: 1 };
const REVERB_SEND: Record<BusId, number> = { music: 0.3, sfx: 0.08, ui: 0, voice: 0.12 };

const vol = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : 0);

export function createMixGraph(k: Kit, dest: AudioNode = k.ctx.destination, opts: { reverb?: boolean } = {}): MixGraph {
  const ctx = k.ctx;
  const nodes: AudioNode[] = [];
  const track = <N extends AudioNode>(n: N): N => { nodes.push(n); return n; };

  // ── output chain ──
  const clip = track(ctx.createWaveShaper());
  clip.curve = softClipCurve();
  clip.oversample = 'none';
  clip.connect(dest);

  const limiter = track(ctx.createDynamicsCompressor());
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.001; limiter.release.value = 0.08;
  limiter.connect(clip);

  const trim = track(ctx.createGain());
  trim.gain.value = 0.6; // compensates the compressor's automatic make-up gain
  trim.connect(limiter);

  const glue = track(ctx.createDynamicsCompressor());
  glue.threshold.value = -16; glue.knee.value = 12; glue.ratio.value = 3.5;
  glue.attack.value = 0.005; glue.release.value = 0.22;
  glue.connect(trim);

  const master = track(ctx.createGain());
  master.gain.value = 0;
  master.connect(glue);

  // ── reverb ──
  let reverbIn: GainNode | null = null;
  if (opts.reverb !== false) {
    const conv = track(ctx.createConvolver());
    conv.buffer = makeImpulse(ctx);
    const ret = track(ctx.createGain());
    ret.gain.value = 0.9;
    conv.connect(ret);
    ret.connect(master);
    reverbIn = track(ctx.createGain());
    reverbIn.connect(conv);
  }

  // ── buses ──
  const mkBus = (id: BusId): GainNode => {
    const g = track(ctx.createGain());
    g.gain.value = 0;
    g.connect(master);
    if (reverbIn && REVERB_SEND[id] > 0) {
      const s = track(ctx.createGain());
      s.gain.value = REVERB_SEND[id];
      g.connect(s);
      s.connect(reverbIn);
    }
    return g;
  };
  const buses: Record<BusId, GainNode> = { music: mkBus('music'), sfx: mkBus('sfx'), ui: mkBus('ui'), voice: mkBus('voice') };
  const ambience = track(ctx.createGain());
  ambience.gain.value = 1;
  ambience.connect(buses.sfx);

  return {
    master, buses, ambience, output: clip,
    setLevels(s: Settings, now: number, smooth = 0.06): void {
      const set = (p: AudioParam, v: number) => {
        if (smooth <= 0) { p.cancelScheduledValues(0); p.value = v; p.setValueAtTime(v, now); } else p.setTargetAtTime(v, now, smooth);
      };
      set(master.gain, vol(s.masterVolume));
      set(buses.music.gain, vol(s.musicVolume) * TRIM.music);
      set(buses.sfx.gain, vol(s.sfxVolume) * TRIM.sfx);
      set(buses.ui.gain, vol(s.sfxVolume) * TRIM.ui);
      set(buses.voice.gain, vol(s.voiceVolume) * TRIM.voice);
    },
    disconnect(): void { for (const n of nodes) { try { n.disconnect(); } catch { /* ignore */ } } },
  };
}

/** Transparent below 0.8, smooth knee, hard ceiling ≈ 0.95 (inputs beyond ±1 clamp to the curve ends). */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax < 0.8 ? ax : 0.8 + 0.19 * Math.tanh((ax - 0.8) / 0.19);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/** Procedural stereo room: decaying noise that darkens over time (air absorption), ~2.4 s. */
function makeImpulse(ctx: BaseAudioContext, seconds = 2.4, decay = 3.2): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const pre = Math.floor(rate * 0.012);
  const buf = ctx.createBuffer(2, len, rate);
  const rng = makeRng(0xbee5);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = i / len;
      const a = 0.1 + 0.85 * t; // one-pole smoothing grows with time → darker tail
      lp = lp * a + (rng() * 2 - 1) * (1 - a);
      d[i] = lp * Math.pow(1 - t, decay) * (1 + 1.5 * t); // compensate the smoothing's level loss
    }
  }
  return buf;
}
