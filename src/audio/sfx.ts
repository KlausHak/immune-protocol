/**
 * [audio] Procedural sound-effect catalogue. Every sound is a tiny Web Audio graph built on demand from
 * noise buffers, oscillators, filters and envelopes (no audio files). Recipes receive a `Kit` bound to
 * the target context, the voice input node, a start time and a per-play variation; they return the
 * absolute end time so the voice manager can recycle the voice.
 *
 * Levels: each recipe peaks around 0.3–0.9 on its own; `gain` is the per-sound mix level.
 * `voices` / `interval` are the per-sound voice limit and minimum spacing between starts, so 50 phages
 * biting at once produce a handful of clicks rather than a clipped wall of noise.
 */
import type { WeaponVfx } from '../core/types';
import { crackle, EPS, fmBell, hiss, metal, midiHz, tone, type Kit } from './dsp';

export type SfxBus = 'sfx' | 'ui' | 'voice';
export type SfxCategory = 'weapon' | 'impact' | 'death' | 'economy' | 'announcer' | 'ability' | 'ui';

export interface Variation {
  /** pitch multiplier (per-play jitter already folded in) */
  pitch: number;
  /** 0..1 size/intensity of the source (unit radius, building footprint) */
  size: number;
}

export interface SfxSpec {
  label: string;
  category: SfxCategory;
  bus: SfxBus;
  /** mix level of the voice */
  gain: number;
  /** max simultaneous voices of this sound */
  voices: number;
  /** min seconds between two starts of this sound */
  interval: number;
  /** per-play pitch jitter (fraction), default 0.05 */
  jitter?: number;
  /** 0..3 — higher survives global voice stealing */
  priority?: number;
  build: (k: Kit, out: AudioNode, t: number, v: Variation) => number;
}

/** UI sound kinds. click/hover/error/confirm/open/close/select are the original contract; the rest are
 *  optional extras for the controls/HUD (command acknowledgements, toasts). */
export type UiSound =
  | 'click' | 'hover' | 'error' | 'confirm' | 'open' | 'close' | 'select'
  | 'command' | 'attack' | 'place' | 'notify' | 'warning';

const max = Math.max;

// ───────────────────────── shared recipe parts ─────────────────────────

function buzz(k: Kit, out: AudioNode, t: number, level: number, pulses: number): number {
  const lp = k.filter(out, 'lowpass', 1400, 0.9);
  let end = t;
  for (let i = 0; i < pulses; i++) {
    const ti = t + i * 0.11;
    const g = k.gain(lp, 0);
    g.gain.setValueAtTime(0, ti);
    g.gain.linearRampToValueAtTime(level, ti + 0.004);
    g.gain.setValueAtTime(level, ti + 0.068);
    g.gain.linearRampToValueAtTime(0, ti + 0.08);
    // root + tritone: unmistakably "no"
    k.osc(g, 'square', 155, ti, ti + 0.085);
    k.osc(g, 'square', 219, ti, ti + 0.085, 6);
    end = ti + 0.095;
  }
  return end;
}

function bubbles(k: Kit, out: AudioNode, t: number, span: number, n: number, peak: number, lo = 180, hi = 420): number {
  let end = t;
  for (let i = 0; i < n; i++) {
    const ti = t + k.r() * span;
    const f = k.range(lo, hi);
    end = max(end, tone(k, out, { f, to: f * 2.3, glide: 0.05, t: ti, a: 0.004, d: 0.06, peak: peak * k.range(0.6, 1) }));
  }
  return end;
}

/** Resonant noise "gloop": band-pass whose centre sweeps through `path` (Hz) over `dur`. */
function gloop(k: Kit, out: AudioNode, t: number, dur: number, peak: number, path: number[], q: number, kind: 'pink' | 'brown' = 'pink'): number {
  const g = k.perc(out, t, peak, 0.012, dur);
  const bp = k.filter(g, 'bandpass', path[0]!, q);
  bp.frequency.setValueAtTime(path[0]!, t);
  path.slice(1).forEach((f, i) => bp.frequency.exponentialRampToValueAtTime(f, t + (dur * (i + 1)) / (path.length - 1)));
  k.noise(bp, kind, t, dur + 0.02);
  return t + dur + 0.012;
}

// ───────────────────────── the catalogue ─────────────────────────

export const SFX = {
  // ── weapons (fire) — keyed by WeaponVfx below ──
  w_spray: {
    label: 'Disinfectant spray', category: 'weapon', bus: 'sfx', gain: 0.34, voices: 4, interval: 0.05, jitter: 0.08, priority: 1,
    build: (k, out, t, v) => {
      const d = 0.2 * k.jit(0.15), p = v.pitch;
      return max(
        hiss(k, out, { f: 5200 * p, to: 2800 * p, q: 0.9, t, a: 0.012, d, peak: 0.95 }),
        hiss(k, out, { type: 'highpass', f: 7000, q: 0.5, t, a: 0.006, d: d * 0.5, peak: 0.25 }),
        hiss(k, out, { kind: 'pink', f: 1700 * p, q: 1.4, t, a: 0.001, d: 0.03, peak: 0.6 }), // nozzle tick
      );
    },
  },
  w_uv_beam: {
    label: 'UV hum-zap', category: 'weapon', bus: 'sfx', gain: 0.42, voices: 3, interval: 0.06, priority: 1,
    build: (k, out, t, v) => {
      const p = v.pitch;
      const lp = k.filter(out, 'lowpass', 1100, 1.5);
      const e1 = tone(k, lp, { type: 'sawtooth', f: 98 * p, to: 92 * p, t, a: 0.015, d: 0.34, peak: 0.26, detune: -9 });
      tone(k, lp, { type: 'sawtooth', f: 98 * p, to: 92 * p, t, a: 0.015, d: 0.34, peak: 0.26, detune: 9 });
      const e2 = tone(k, out, { f: 2900 * p, to: 650 * p, glide: 0.16, t, a: 0.002, d: 0.2, peak: 0.26 });
      tone(k, out, { type: 'triangle', f: 1460 * p, to: 330 * p, glide: 0.16, t, a: 0.002, d: 0.16, peak: 0.12 });
      return max(e1, e2, crackle(k, out, t, 0.12, 9, 0.3, 6500, 1.2));
    },
  },
  w_antibiotic_capsule: {
    label: 'Antibiotic capsule thunk', category: 'weapon', bus: 'sfx', gain: 0.6, voices: 3, interval: 0.08, priority: 2,
    build: (k, out, t, v) => {
      const p = v.pitch;
      return max(
        tone(k, out, { f: 150 * p, to: 52 * p, glide: 0.12, t, a: 0.002, d: 0.26, peak: 0.72 }),
        hiss(k, out, { kind: 'brown', type: 'lowpass', f: 900, q: 0.7, t, a: 0.001, d: 0.09, peak: 0.5 }),
        hiss(k, out, { f: 2400 * p, to: 900, q: 1.1, t: t + 0.005, a: 0.004, d: 0.13, peak: 0.35 }), // pneumatic pfft
        tone(k, out, { type: 'triangle', f: 520 * p, to: 380 * p, t, a: 0.001, d: 0.06, peak: 0.12 }), // tube knock
      );
    },
  },
  w_laser: {
    label: 'Laser pew', category: 'weapon', bus: 'sfx', gain: 0.42, voices: 3, interval: 0.05, priority: 1,
    build: (k, out, t, v) => {
      const p = v.pitch;
      const lp = k.filter(out, 'lowpass', 3800, 0.9);
      return max(
        tone(k, lp, { type: 'square', f: 1900 * p, to: 290 * p, glide: 0.13, t, a: 0.001, d: 0.16, peak: 0.24 }),
        tone(k, out, { f: 3800 * p, to: 580 * p, glide: 0.12, t, a: 0.001, d: 0.12, peak: 0.16 }),
      );
    },
  },
  w_engulf: {
    label: 'Macrophage engulf gulp', category: 'weapon', bus: 'sfx', gain: 0.6, voices: 3, interval: 0.08, priority: 1,
    build: (k, out, t, v) => {
      const p = v.pitch;
      const e0 = gloop(k, out, t, 0.36, 0.9, [320 * p, 1150 * p, 380 * p], 5);
      const e1 = tone(k, out, { f: 170 * p, to: 85 * p, glide: 0.28, t: t + 0.02, a: 0.02, d: 0.3, peak: 0.42 });
      const sv = k.filter(out, 'lowpass', 1400, 0.8); // servo whine (it is a mech)
      tone(k, sv, { type: 'sawtooth', f: 210 * p, to: 330 * p, glide: 0.25, t, a: 0.03, d: 0.25, peak: 0.08 });
      return max(e0, e1);
    },
  },
  w_zap: {
    label: 'Shock-probe zap crackle', category: 'weapon', bus: 'sfx', gain: 0.38, voices: 3, interval: 0.06, priority: 1,
    build: (k, out, t, v) => {
      const p = v.pitch;
      const e1 = crackle(k, out, t, 0.14, 10, 0.85, 3200 * p, 0.8);
      const lp = k.filter(out, 'lowpass', 1800, 1);
      const e2 = tone(k, lp, { type: 'square', f: 120 * p, t, a: 0.002, d: 0.12, peak: 0.15 });
      const e3 = tone(k, out, { f: 1800 * p, to: 2400 * p, t, a: 0.001, d: 0.05, peak: 0.08 });
      return max(e1, e2, e3);
    },
  },
  w_acid_spit: {
    label: 'Acid spit squelch', category: 'weapon', bus: 'sfx', gain: 0.5, voices: 4, interval: 0.05, priority: 1,
    build: (k, out, t, v) => {
      const p = v.pitch;
      return max(
        hiss(k, out, { kind: 'pink', f: 380 * p, to: 1700 * p, glide: 0.09, q: 6, t, a: 0.003, d: 0.15, peak: 0.95 }),
        tone(k, out, { f: 290 * p, to: 640 * p, glide: 0.05, t, a: 0.002, d: 0.08, peak: 0.24 }),
        hiss(k, out, { type: 'highpass', f: 2500, q: 0.7, t: t + 0.01, a: 0.002, d: 0.06, peak: 0.16 }),
      );
    },
  },
  w_spore_lob: {
    label: 'Spore lob whoomp', category: 'weapon', bus: 'sfx', gain: 0.6, voices: 3, interval: 0.08, priority: 2,
    build: (k, out, t, v) => {
      const p = v.pitch;
      return max(
        tone(k, out, { f: 100 * p, to: 42 * p, glide: 0.2, t, a: 0.006, d: 0.34, peak: 0.7 }),
        hiss(k, out, { kind: 'pink', type: 'lowpass', f: 1900, to: 280, glide: 0.28, q: 1.2, t, a: 0.012, d: 0.3, peak: 0.5 }),
        tone(k, out, { type: 'triangle', f: 72 * p, t, a: 0.01, d: 0.14, peak: 0.18 }),
      );
    },
  },
  w_toxin_bolt: {
    label: 'Toxin bolt whoosh', category: 'weapon', bus: 'sfx', gain: 0.5, voices: 3, interval: 0.06, priority: 1,
    build: (k, out, t, v) => {
      const p = v.pitch;
      const e = gloop(k, out, t, 0.3, 0.8, [600 * p, 2600 * p, 800 * p], 1.6, 'pink');
      const lp = k.filter(out, 'lowpass', 1600, 1);
      tone(k, lp, { type: 'sawtooth', f: 340 * p, to: 210 * p, glide: 0.25, t, a: 0.03, d: 0.25, peak: 0.1, detune: -12 });
      tone(k, lp, { type: 'sawtooth', f: 340 * p, to: 210 * p, glide: 0.25, t, a: 0.03, d: 0.25, peak: 0.1, detune: 12 });
      return max(e, t + 0.29);
    },
  },
  w_bite: {
    label: 'Phage bite click', category: 'weapon', bus: 'sfx', gain: 0.3, voices: 3, interval: 0.06, jitter: 0.12, priority: 0,
    build: (k, out, t, v) => max(
      hiss(k, out, { type: 'highpass', f: 2600 * v.pitch, q: 0.8, t, a: 0.0005, d: 0.025, peak: 0.65 }),
      tone(k, out, { f: 1900 * v.pitch, to: 950 * v.pitch, glide: 0.03, t, a: 0.0005, d: 0.03, peak: 0.2 }),
    ),
  },
  w_whip: {
    label: 'Spirochete whip crack', category: 'weapon', bus: 'sfx', gain: 0.42, voices: 3, interval: 0.06, priority: 1,
    build: (k, out, t, v) => {
      const p = v.pitch;
      const g = k.gain(out, 0); // swish build-up
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.4, t + 0.075);
      g.gain.linearRampToValueAtTime(0, t + 0.085);
      const bp = k.filter(g, 'bandpass', 900 * p, 1.1);
      bp.frequency.setValueAtTime(900 * p, t);
      bp.frequency.exponentialRampToValueAtTime(5200 * p, t + 0.08);
      k.noise(bp, 'white', t, 0.09);
      const tc = t + 0.075; // the crack
      return max(
        hiss(k, out, { type: 'highpass', f: 1900, q: 0.7, t: tc, a: 0.0005, d: 0.045, peak: 0.85 }),
        tone(k, out, { f: 2600 * p, to: 700 * p, glide: 0.03, t: tc, a: 0.0005, d: 0.035, peak: 0.22 }),
      );
    },
  },
  w_slam: {
    label: 'Superbug slam thud', category: 'weapon', bus: 'sfx', gain: 0.62, voices: 3, interval: 0.08, priority: 2,
    build: (k, out, t, v) => {
      const p = v.pitch;
      return max(
        tone(k, out, { f: 90 * p, to: 32 * p, glide: 0.25, t, a: 0.002, d: 0.45, peak: 0.8 }),
        hiss(k, out, { kind: 'brown', type: 'lowpass', f: 520, q: 0.8, t, a: 0.002, d: 0.3, peak: 0.55 }),
        hiss(k, out, { f: 1500, q: 1, t, a: 0.001, d: 0.06, peak: 0.3 }), // crunch
      );
    },
  },

  // ── projectile impacts ──
  i_antibiotic_capsule: {
    label: 'Capsule impact glass pop', category: 'impact', bus: 'sfx', gain: 0.55, voices: 4, interval: 0.05, priority: 2,
    build: (k, out, t, v) => {
      const p = v.pitch;
      let end = tone(k, out, { f: 950 * p, to: 260 * p, glide: 0.04, t, a: 0.001, d: 0.07, peak: 0.45 }); // pop
      end = max(end, hiss(k, out, { type: 'highpass', f: 3800, q: 0.7, t, a: 0.001, d: 0.07, peak: 0.45 })); // shatter
      const f0 = 2050 * p * k.jit(0.06);
      [1, 2.32, 3.86, 5.41].forEach((r, i) => { // glass tinkle (inharmonic partials, staggered)
        end = max(end, tone(k, out, { f: f0 * r * k.jit(0.015), t: t + 0.004 + i * 0.011 + k.r() * 0.02, a: 0.001, d: 0.25 - i * 0.04, peak: 0.13 - i * 0.02 }));
      });
      return max(end, hiss(k, out, { f: 1300, to: 700, q: 1.3, t: t + 0.02, a: 0.01, d: 0.3, peak: 0.2 })); // fizz
    },
  },
  i_laser: {
    label: 'Laser spark', category: 'impact', bus: 'sfx', gain: 0.32, voices: 3, interval: 0.05, priority: 0,
    build: (k, out, t, v) => max(
      hiss(k, out, { type: 'highpass', f: 5000, q: 0.7, t, a: 0.001, d: 0.045, peak: 0.5 }),
      tone(k, out, { f: 3100 * v.pitch, to: 1500 * v.pitch, t, a: 0.001, d: 0.035, peak: 0.12 }),
    ),
  },
  i_acid_spit: {
    label: 'Acid sizzle', category: 'impact', bus: 'sfx', gain: 0.42, voices: 3, interval: 0.06, priority: 1,
    build: (k, out, t, v) => {
      let end = hiss(k, out, { kind: 'pink', type: 'lowpass', f: 900 * v.pitch, q: 0.8, t, a: 0.001, d: 0.07, peak: 0.5 }); // splat
      end = max(end, hiss(k, out, { type: 'highpass', f: 3200, q: 0.7, t: t + 0.01, a: 0.02, d: 0.55, peak: 0.3 }));
      return max(end, crackle(k, out, t + 0.02, 0.45, 14, 0.4, 5200, 1.4));
    },
  },
  i_spore_lob: {
    label: 'Spore puff', category: 'impact', bus: 'sfx', gain: 0.6, voices: 3, interval: 0.06, priority: 2,
    build: (k, out, t, v) => {
      let end = hiss(k, out, { kind: 'pink', type: 'lowpass', f: 1300 * v.pitch, to: 500, q: 0.7, t, a: 0.015, d: 0.45, peak: 0.6 });
      end = max(end, tone(k, out, { f: 72, to: 40, glide: 0.14, t, a: 0.004, d: 0.16, peak: 0.45 }));
      return max(end, crackle(k, out, t + 0.03, 0.25, 7, 0.2, 2800, 2)); // spores scattering
    },
  },
  i_toxin_bolt: {
    label: 'Toxin splat', category: 'impact', bus: 'sfx', gain: 0.45, voices: 3, interval: 0.05, priority: 1,
    build: (k, out, t, v) => max(
      hiss(k, out, { kind: 'pink', f: 950 * v.pitch, to: 500, q: 1.3, t, a: 0.002, d: 0.13, peak: 0.8 }),
      tone(k, out, { f: 230 * v.pitch, to: 90, glide: 0.08, t, a: 0.002, d: 0.09, peak: 0.32 }),
    ),
  },
  i_generic: {
    label: 'Generic impact', category: 'impact', bus: 'sfx', gain: 0.4, voices: 3, interval: 0.05, priority: 1,
    build: (k, out, t, v) => max(
      hiss(k, out, { kind: 'pink', f: 1200 * v.pitch, q: 1, t, a: 0.001, d: 0.08, peak: 0.65 }),
      tone(k, out, { f: 180 * v.pitch, to: 80, t, a: 0.001, d: 0.07, peak: 0.3 }),
    ),
  },

  // ── deaths ──
  d_pathogen_small: {
    label: 'Pathogen pop/splat', category: 'death', bus: 'sfx', gain: 0.55, voices: 4, interval: 0.04, jitter: 0.1, priority: 2,
    build: (k, out, t, v) => {
      const p = v.pitch * (1.25 - 0.5 * v.size);
      let end = tone(k, out, { f: 680 * p, to: 140 * p, glide: 0.07, t, a: 0.001, d: 0.09, peak: 0.45 });
      end = max(end, hiss(k, out, { kind: 'pink', f: 1150 * p, to: 600 * p, q: 1.5, t, a: 0.002, d: 0.2 + 0.1 * v.size, peak: 0.8 }));
      return max(end, tone(k, out, { f: 1300 * p, to: 2500 * p, glide: 0.04, t: t + 0.07 + k.r() * 0.05, a: 0.001, d: 0.05, peak: 0.07 })); // drip
    },
  },
  d_pathogen_large: {
    label: 'Large pathogen squelch', category: 'death', bus: 'sfx', gain: 0.68, voices: 3, interval: 0.06, priority: 2,
    build: (k, out, t, v) => {
      const p = v.pitch * (1.15 - 0.3 * v.size);
      const d = 0.55 + 0.25 * v.size;
      let end = gloop(k, out, t, d, 0.95, [1500 * p, 240 * p], 3, 'brown');
      end = max(end, tone(k, out, { f: 230 * p, to: 48 * p, glide: d * 0.7, t, a: 0.003, d: d * 0.75, peak: 0.5 }));
      const gg = k.perc(out, t + 0.05, 0.4, 0.03, d * 0.8); // gurgle: wobbling resonant band
      const bp = k.filter(gg, 'bandpass', 520 * p, 6);
      k.osc(k.gain(bp.frequency, 260 * p), 'sine', 17 * k.jit(0.2), t, t + d);
      k.noise(bp, 'pink', t + 0.05, d);
      return max(end, t + 0.05 + d * 0.8 + 0.03);
    },
  },
  d_boss: {
    label: 'Strain Omega dissolves', category: 'death', bus: 'sfx', gain: 0.8, voices: 1, interval: 0.5, priority: 3,
    build: (k, out, t) => {
      let end = tone(k, out, { f: 62, to: 24, glide: 1.4, t, a: 0.01, d: 1.6, peak: 0.7 });
      end = max(end, gloop(k, out, t, 1.4, 0.9, [1300, 160], 2.5, 'brown'));
      for (let i = 0; i < 6; i++) end = max(end, fmBell(k, out, midiHz(86 - i * 3 - (i % 2) * 2), t + 0.25 + i * 0.16, 0.6, 0.07, 2.01, 0.8));
      return max(end, crackle(k, out, t + 0.1, 1.1, 30, 0.3, 2400, 1.5));
    },
  },
  d_mech_small: {
    label: 'Small mech explosion', category: 'death', bus: 'sfx', gain: 0.6, voices: 3, interval: 0.05, priority: 2,
    build: (k, out, t, v) => {
      const p = v.pitch;
      return max(
        hiss(k, out, { type: 'lowpass', f: 2600, to: 500, glide: 0.35, q: 0.8, t, a: 0.002, d: 0.38, peak: 0.6 }),
        tone(k, out, { f: 125 * p, to: 45 * p, glide: 0.25, t, a: 0.002, d: 0.3, peak: 0.55 }),
        metal(k, out, 540 * p * k.jit(0.08), t + 0.01, 0.3, 0.12),
        crackle(k, out, t + 0.04, 0.3, 8, 0.25, 3000, 1.2),
      );
    },
  },
  d_mech_large: {
    label: 'Heavy mech explosion', category: 'death', bus: 'sfx', gain: 0.72, voices: 2, interval: 0.1, priority: 3,
    build: (k, out, t, v) => {
      const p = v.pitch;
      let end = hiss(k, out, { kind: 'brown', type: 'lowpass', f: 1800, to: 240, glide: 1.0, q: 0.7, t, a: 0.003, d: 1.1, peak: 0.8 });
      end = max(end, hiss(k, out, { type: 'lowpass', f: 4500, to: 800, glide: 0.5, q: 0.7, t, a: 0.002, d: 0.5, peak: 0.4 }));
      end = max(end, tone(k, out, { f: 78 * p, to: 27 * p, glide: 0.7, t, a: 0.003, d: 0.85, peak: 0.7 }));
      for (let i = 0; i < 4; i++) end = max(end, metal(k, out, k.range(380, 900) * p, t + 0.12 + k.r() * 0.7, 0.22, 0.09)); // debris
      return max(end, crackle(k, out, t + 0.05, 0.8, 18, 0.25, 2200, 1));
    },
  },
  d_staff: {
    label: 'Staff evacuation shimmer', category: 'death', bus: 'sfx', gain: 0.45, voices: 2, interval: 0.1, priority: 2,
    build: (k, out, t, v) => {
      let end = t;
      [86, 90, 93, 98].forEach((m, i) => { end = max(end, fmBell(k, out, midiHz(m) * v.pitch, t + i * 0.06, 0.45, 0.18, 2, 0.6)); });
      return max(end, hiss(k, out, { f: 700, to: 4200, glide: 0.45, q: 1.2, t, a: 0.2, d: 0.35, peak: 0.2 })); // evac whoosh
    },
  },
  d_building_hospital: {
    label: 'Hospital structure collapse', category: 'death', bus: 'sfx', gain: 0.72, voices: 2, interval: 0.15, priority: 3,
    build: (k, out, t, v) => {
      const s = 0.7 + 0.6 * v.size;
      let end = hiss(k, out, { kind: 'brown', type: 'lowpass', f: 900, to: 300, glide: 1.6 * s, q: 0.7, t, a: 0.06, d: 1.6 * s, peak: 0.75 });
      end = max(end, tone(k, out, { f: 58, to: 28, glide: 0.8, t, a: 0.01, d: 0.9, peak: 0.65 }));
      end = max(end, crackle(k, out, t + 0.1, 1.2 * s, Math.round(30 * s), 0.45, 1700, 0.9)); // crumbling
      for (let i = 0; i < 4; i++) end = max(end, tone(k, out, { f: k.range(2800, 5200), t: t + 0.05 + k.r() * 0.5, a: 0.001, d: 0.12, peak: 0.08 })); // glass
      return max(end, metal(k, out, 300 * k.jit(0.1), t + 0.3 + k.r() * 0.3, 0.5, 0.1));
    },
  },
  d_building_pathogen: {
    label: 'Pathogen structure bursts', category: 'death', bus: 'sfx', gain: 0.72, voices: 2, interval: 0.15, priority: 3,
    build: (k, out, t, v) => {
      const s = 0.7 + 0.6 * v.size;
      let end = hiss(k, out, { kind: 'pink', f: 900, to: 300, q: 1.5, t, a: 0.003, d: 0.25, peak: 0.75 }); // burst
      end = max(end, tone(k, out, { f: 120, to: 34, glide: 1.0 * s, t, a: 0.005, d: 1.1 * s, peak: 0.65 }));
      end = max(end, gloop(k, out, t + 0.05, 1.3 * s, 0.7, [2100, 260], 2)); // deflating hiss
      return max(end, bubbles(k, out, t + 0.1, 1.0 * s, 7, 0.18));
    },
  },

  // ── economy / production ──
  construct_start_hospital: {
    label: 'Construction ratchet', category: 'economy', bus: 'sfx', gain: 0.5, voices: 2, interval: 0.1, priority: 1,
    build: (k, out, t) => {
      let end = t;
      for (let i = 0; i < 6; i++) {
        const ti = t + i * (0.055 - i * 0.004);
        end = max(end, hiss(k, out, { type: 'highpass', f: 3000, q: 0.7, t: ti, a: 0.0005, d: 0.012, peak: 0.5 }));
        end = max(end, tone(k, out, { type: 'square', f: 1150 + i * 70, t: ti, a: 0.0005, d: 0.01, peak: 0.07 }));
      }
      const tc = t + 0.3; // clunk
      end = max(end, tone(k, out, { f: 190, to: 90, glide: 0.1, t: tc, a: 0.001, d: 0.14, peak: 0.55 }));
      return max(end, metal(k, out, 680, tc, 0.18, 0.08));
    },
  },
  construct_start_pathogen: {
    label: 'Colony growth bloop', category: 'economy', bus: 'sfx', gain: 0.5, voices: 2, interval: 0.1, priority: 1,
    build: (k, out, t) => {
      let end = hiss(k, out, { kind: 'brown', f: 420, q: 2.5, t, a: 0.05, d: 0.35, peak: 0.8 });
      for (let i = 0; i < 3; i++) {
        const f = 190 + i * 60 + k.r() * 30;
        end = max(end, tone(k, out, { f, to: f * 2.4, glide: 0.07, t: t + 0.04 + i * 0.09 + k.r() * 0.02, a: 0.004, d: 0.08, peak: 0.3 }));
      }
      return end;
    },
  },
  construct_done_hospital: {
    label: 'Construction complete chime', category: 'economy', bus: 'voice', gain: 0.5, voices: 1, interval: 0.3, priority: 2,
    build: (k, out, t) => {
      let end = fmBell(k, out, midiHz(81), t, 0.5, 0.3, 2, 0.5); // A5
      end = max(end, fmBell(k, out, midiHz(88), t + 0.11, 0.8, 0.28, 2, 0.5)); // E6
      end = max(end, tone(k, out, { type: 'triangle', f: midiHz(69), t: t + 0.11, a: 0.01, d: 0.6, peak: 0.12 }));
      for (let i = 0; i < 2; i++) end = max(end, hiss(k, out, { type: 'highpass', f: 3000, q: 0.7, t: t + i * 0.05, a: 0.0005, d: 0.012, peak: 0.25 }));
      return end;
    },
  },
  construct_done_pathogen: {
    label: 'Colony structure blooms', category: 'economy', bus: 'voice', gain: 0.5, voices: 1, interval: 0.3, priority: 2,
    build: (k, out, t) => {
      const lp = k.filter(out, 'lowpass', 400, 1.2);
      lp.frequency.setValueAtTime(400, t);
      lp.frequency.linearRampToValueAtTime(1600, t + 0.35);
      lp.frequency.exponentialRampToValueAtTime(500, t + 1.0);
      const g = k.gain(lp, 0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.2, t + 0.2);
      g.gain.exponentialRampToValueAtTime(EPS, t + 1.05);
      for (const m of [50, 57, 62, 63]) k.osc(g, 'sawtooth', midiHz(m), t, t + 1.05, (k.r() - 0.5) * 16); // eerie minor-second rub
      return max(t + 1.05, bubbles(k, out, t + 0.1, 0.6, 4, 0.2, 200, 380));
    },
  },
  construct_cancel: {
    label: 'Construction cancelled', category: 'economy', bus: 'ui', gain: 0.45, voices: 1, interval: 0.15, priority: 1,
    build: (k, out, t) => max(
      tone(k, out, { type: 'triangle', f: midiHz(76), to: midiHz(64), glide: 0.18, t, a: 0.003, d: 0.2, peak: 0.32 }),
      hiss(k, out, { kind: 'brown', type: 'lowpass', f: 700, q: 0.7, t: t + 0.05, a: 0.01, d: 0.3, peak: 0.45 }),
    ),
  },
  unit_ready_hospital: {
    label: 'Unit ready (Hospital)', category: 'economy', bus: 'voice', gain: 0.55, voices: 1, interval: 0.25, priority: 2,
    build: (k, out, t) => {
      let end = tone(k, out, { wave: k.bank.glass, f: midiHz(86), t, a: 0.002, d: 0.12, peak: 0.35 }); // D6
      end = max(end, tone(k, out, { wave: k.bank.glass, f: midiHz(93), t: t + 0.08, a: 0.002, d: 0.3, peak: 0.32 })); // A6
      end = max(end, tone(k, out, { type: 'triangle', f: midiHz(74), t: t + 0.08, a: 0.04, d: 0.5, peak: 0.14 }));
      return max(end, tone(k, out, { type: 'triangle', f: midiHz(81), t: t + 0.08, a: 0.04, d: 0.5, peak: 0.1 }));
    },
  },
  unit_ready_pathogen: {
    label: 'Unit ready (Contagion)', category: 'economy', bus: 'voice', gain: 0.55, voices: 1, interval: 0.25, priority: 2,
    build: (k, out, t) => {
      let end = hiss(k, out, { kind: 'pink', f: 300, to: 1500, glide: 0.18, q: 5, t, a: 0.02, d: 0.2, peak: 0.95 }); // rising squelch
      end = max(end, tone(k, out, { wave: k.bank.glass, f: midiHz(74), t: t + 0.12, a: 0.01, d: 0.45, peak: 0.22 }));
      end = max(end, tone(k, out, { wave: k.bank.glass, f: midiHz(80), t: t + 0.2, a: 0.01, d: 0.45, peak: 0.18 })); // tritone
      return max(end, tone(k, out, { f: 110, to: 70, glide: 0.2, t, a: 0.01, d: 0.25, peak: 0.3 }));
    },
  },
  research_done: {
    label: 'Research complete', category: 'economy', bus: 'voice', gain: 0.5, voices: 1, interval: 0.3, priority: 2,
    build: (k, out, t) => {
      let end = t;
      [86, 90, 93, 98].forEach((m, i) => { end = max(end, fmBell(k, out, midiHz(m), t + i * 0.09, 0.7 - i * 0.05, 0.2, 2, 0.45)); });
      end = max(end, tone(k, out, { type: 'triangle', f: midiHz(62), t, a: 0.08, d: 0.8, peak: 0.15 }));
      return max(end, hiss(k, out, { f: 6000, q: 2, t: t + 0.25, a: 0.05, d: 0.5, peak: 0.08 })); // shimmer
    },
  },
  resource_tick: {
    label: 'Supplies delivered tick', category: 'economy', bus: 'sfx', gain: 0.2, voices: 1, interval: 0.35, jitter: 0.04, priority: 0,
    build: (k, out, t, v) => max(
      tone(k, out, { f: 1560 * v.pitch, t, a: 0.002, d: 0.045, peak: 0.42 }),
      tone(k, out, { f: 3120 * v.pitch, t, a: 0.001, d: 0.02, peak: 0.08 }),
    ),
  },
  error_buzz: {
    label: 'Not enough / error buzz', category: 'economy', bus: 'ui', gain: 0.45, voices: 1, interval: 0.25, jitter: 0, priority: 2,
    build: (k, out, t) => buzz(k, out, t, 0.3, 2),
  },

  // ── announcer stingers (voice bus) ──
  alarm: {
    label: 'Under-attack alarm chime', category: 'announcer', bus: 'voice', gain: 0.55, voices: 1, interval: 1, jitter: 0, priority: 3,
    build: (k, out, t) => {
      let end = t;
      for (const [m, dt] of [[81, 0], [77, 0.16], [81, 0.32], [77, 0.48]] as const) {
        end = max(end, tone(k, out, { type: 'triangle', f: midiHz(m), t: t + dt, a: 0.004, d: 0.2, peak: 0.32 }));
        end = max(end, tone(k, out, { f: midiHz(m + 12), t: t + dt, a: 0.002, d: 0.12, peak: 0.12 }));
      }
      return end;
    },
  },
  infection_detected: {
    label: 'Infection detected', category: 'announcer', bus: 'voice', gain: 0.55, voices: 1, interval: 1, jitter: 0, priority: 3,
    build: (k, out, t) => {
      const lp = k.filter(out, 'lowpass', 300, 2);
      lp.frequency.setValueAtTime(300, t);
      lp.frequency.linearRampToValueAtTime(1100, t + 0.5);
      lp.frequency.exponentialRampToValueAtTime(300, t + 1.2);
      const g = k.gain(lp, 0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.25, t + 0.25);
      g.gain.exponentialRampToValueAtTime(EPS, t + 1.2);
      k.osc(g, 'sawtooth', midiHz(50), t, t + 1.2, -6); // D3 + Eb3 rub
      k.osc(g, 'sawtooth', midiHz(51), t, t + 1.2, 6);
      let end = t + 1.2;
      for (let i = 0; i < 6; i++) end = max(end, tone(k, out, { type: 'square', f: k.range(900, 2600), t: t + 0.05 + i * 0.05 + k.r() * 0.02, a: 0.001, d: 0.025, peak: 0.07 })); // glitch
      return end;
    },
  },

  // ── abilities ──
  a_uv_flare: {
    label: 'UV Flare burst', category: 'ability', bus: 'sfx', gain: 0.65, voices: 2, interval: 0.1, priority: 3,
    build: (k, out, t) => {
      let end = tone(k, out, { f: 420, to: 3300, glide: 0.3, t, a: 0.25, d: 0.06, peak: 0.2 }); // charge whine
      const tb = t + 0.3;
      end = max(end, hiss(k, out, { type: 'highpass', f: 2200, q: 0.6, t: tb, a: 0.003, d: 0.55, peak: 0.55 }));
      end = max(end, tone(k, out, { f: 130, to: 55, glide: 0.3, t: tb, a: 0.003, d: 0.4, peak: 0.5 }));
      for (const m of [86, 93, 100]) end = max(end, fmBell(k, out, midiHz(m), tb + 0.02, 1.0, 0.1, 1.5, 0.6));
      return end;
    },
  },
  a_helicopter: {
    label: 'Emergency helicopter', category: 'ability', bus: 'sfx', gain: 0.6, voices: 1, interval: 1, jitter: 0.03, priority: 3,
    build: (k, out, t) => {
      const d = 3.4;
      const env = k.gain(out, 0); // approach → hover → depart
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.8, t + 1.3);
      env.gain.setValueAtTime(0.8, t + 2.0);
      env.gain.linearRampToValueAtTime(0, t + d);
      const lp = k.filter(env, 'lowpass', 500, 0.8);
      lp.frequency.setValueAtTime(500, t);
      lp.frequency.linearRampToValueAtTime(1300, t + 1.6);
      lp.frequency.linearRampToValueAtTime(450, t + d);
      const chop = k.gain(lp, 0.45); // rotor chop: noise amplitude-modulated at blade-pass rate
      const depth = k.gain(chop.gain, -0.45); // inverted saw → sharp blade slap, then decay
      const lfo = k.osc(depth, 'sawtooth', 15, t, t + d);
      lfo.frequency.linearRampToValueAtTime(12.5, t + d); // doppler-ish slowdown
      k.noise(chop, 'pink', t, d);
      const wl = k.filter(env, 'bandpass', 1600, 3); // turbine whine
      const w = k.osc(k.gain(wl, 0.06), 'sawtooth', 860, t, t + d);
      w.frequency.linearRampToValueAtTime(760, t + d);
      return t + d;
    },
  },
  a_supply_drop: {
    label: 'Supply crate drop', category: 'ability', bus: 'sfx', gain: 0.6, voices: 1, interval: 0.5, priority: 3,
    build: (k, out, t) => {
      let end = tone(k, out, { f: 95, to: 40, glide: 0.2, t, a: 0.002, d: 0.32, peak: 0.7 }); // crate lands
      end = max(end, hiss(k, out, { kind: 'brown', type: 'lowpass', f: 800, q: 0.7, t, a: 0.003, d: 0.35, peak: 0.45 })); // dust
      end = max(end, metal(k, out, 430, t + 0.01, 0.3, 0.12)); // clank
      end = max(end, fmBell(k, out, midiHz(84), t + 0.25, 0.35, 0.2, 2, 0.4)); // C6
      return max(end, fmBell(k, out, midiHz(91), t + 0.36, 0.5, 0.2, 2, 0.4)); // G6: supplies in
    },
  },
  a_viral_burst: {
    label: 'Viral burst', category: 'ability', bus: 'sfx', gain: 0.45, voices: 3, interval: 0.05, priority: 1,
    build: (k, out, t, v) => max(
      hiss(k, out, { kind: 'pink', f: 1800 * v.pitch, to: 900, q: 1.2, t, a: 0.002, d: 0.2, peak: 0.75 }),
      tone(k, out, { f: 480 * v.pitch, to: 1250, glide: 0.04, t, a: 0.001, d: 0.05, peak: 0.25 }),
      tone(k, out, { f: 900 * v.pitch, to: 260, glide: 0.08, t: t + 0.04, a: 0.001, d: 0.1, peak: 0.2 }),
    ),
  },
  a_omega_spawn: {
    label: 'Mitotic spawn', category: 'ability', bus: 'sfx', gain: 0.6, voices: 1, interval: 0.5, priority: 3,
    build: (k, out, t) => {
      let end = tone(k, out, { f: 68, to: 112, glide: 0.6, t, a: 0.15, d: 0.6, peak: 0.55 }); // swelling
      const g = k.perc(out, t, 0.55, 0.1, 0.9);
      const bp = k.filter(g, 'bandpass', 450, 5);
      k.osc(k.gain(bp.frequency, 200), 'sine', 6, t, t + 1);
      k.noise(bp, 'brown', t, 1.0);
      for (let i = 0; i < 3; i++) end = max(end, tone(k, out, { f: 420, to: 150, glide: 0.08, t: t + 0.35 + i * 0.15, a: 0.001, d: 0.12, peak: 0.35 })); // 3 phages
      return max(end, t + 1.01);
    },
  },
  a_generic: {
    label: 'Ability cast', category: 'ability', bus: 'sfx', gain: 0.45, voices: 2, interval: 0.1, priority: 2,
    build: (k, out, t) => max(
      hiss(k, out, { f: 800, to: 3000, glide: 0.2, q: 1.5, t, a: 0.05, d: 0.2, peak: 0.5 }),
      tone(k, out, { type: 'triangle', f: 660, to: 990, t, a: 0.01, d: 0.25, peak: 0.15 }),
    ),
  },
  repair_tick: {
    label: 'Orderly repair ratchet', category: 'economy', bus: 'sfx', gain: 0.22, voices: 1, interval: 0.6, jitter: 0.06, priority: 0,
    build: (k, out, t, v) => {
      let end = t;
      for (let i = 0; i < 2; i++) {
        end = max(end, hiss(k, out, { type: 'highpass', f: 2800 * v.pitch, q: 0.7, t: t + i * 0.07, a: 0.0005, d: 0.014, peak: 0.5 }));
        end = max(end, tone(k, out, { type: 'square', f: (1050 + i * 120) * v.pitch, t: t + i * 0.07, a: 0.0005, d: 0.012, peak: 0.08 }));
      }
      return end;
    },
  },
  heal: {
    label: 'Field-medic heal shimmer', category: 'ability', bus: 'sfx', gain: 0.18, voices: 1, interval: 0.7, priority: 0,
    build: (k, out, t, v) => max(
      tone(k, out, { wave: k.bank.glass, f: midiHz(88) * v.pitch, t, a: 0.02, d: 0.25, peak: 0.22 }),
      tone(k, out, { wave: k.bank.glass, f: midiHz(95) * v.pitch, t: t + 0.07, a: 0.02, d: 0.3, peak: 0.18 }),
    ),
  },

  // ── UI (crisp medical-tech blips) ──
  ui_click: {
    label: 'UI click', category: 'ui', bus: 'ui', gain: 0.4, voices: 2, interval: 0.025, jitter: 0.02, priority: 1,
    build: (k, out, t) => max(
      tone(k, out, { f: 1350, t, a: 0.001, d: 0.035, peak: 0.5 }),
      tone(k, out, { type: 'triangle', f: 2700, t, a: 0.001, d: 0.015, peak: 0.12 }),
      hiss(k, out, { type: 'highpass', f: 6000, q: 0.7, t, a: 0.0005, d: 0.006, peak: 0.2 }),
    ),
  },
  ui_hover: {
    label: 'UI hover', category: 'ui', bus: 'ui', gain: 0.16, voices: 1, interval: 0.045, jitter: 0.02, priority: 0,
    build: (k, out, t) => tone(k, out, { f: 2250, t, a: 0.002, d: 0.022, peak: 0.32 }),
  },
  ui_error: {
    label: 'UI error', category: 'ui', bus: 'ui', gain: 0.4, voices: 1, interval: 0.2, jitter: 0, priority: 2,
    build: (k, out, t) => buzz(k, out, t, 0.28, 1),
  },
  ui_confirm: {
    label: 'UI confirm', category: 'ui', bus: 'ui', gain: 0.42, voices: 2, interval: 0.04, jitter: 0, priority: 1,
    build: (k, out, t) => max(
      tone(k, out, { wave: k.bank.glass, f: midiHz(88), t, a: 0.002, d: 0.1, peak: 0.35 }),
      tone(k, out, { wave: k.bank.glass, f: midiHz(93), t: t + 0.065, a: 0.002, d: 0.18, peak: 0.32 }),
    ),
  },
  ui_open: {
    label: 'UI open', category: 'ui', bus: 'ui', gain: 0.36, voices: 1, interval: 0.06, jitter: 0, priority: 1,
    build: (k, out, t) => max(
      tone(k, out, { f: 620, to: 1450, glide: 0.1, t, a: 0.004, d: 0.14, peak: 0.32 }),
      hiss(k, out, { f: 1500, to: 4000, glide: 0.1, q: 1.2, t, a: 0.03, d: 0.08, peak: 0.15 }),
    ),
  },
  ui_close: {
    label: 'UI close', category: 'ui', bus: 'ui', gain: 0.36, voices: 1, interval: 0.06, jitter: 0, priority: 1,
    build: (k, out, t) => max(
      tone(k, out, { f: 1450, to: 620, glide: 0.1, t, a: 0.004, d: 0.14, peak: 0.32 }),
      hiss(k, out, { f: 4000, to: 1500, glide: 0.1, q: 1.2, t, a: 0.03, d: 0.08, peak: 0.15 }),
    ),
  },
  ui_select: {
    label: 'UI select', category: 'ui', bus: 'ui', gain: 0.36, voices: 2, interval: 0.03, jitter: 0.02, priority: 1,
    build: (k, out, t) => max(
      tone(k, out, { type: 'triangle', f: 1600, t, a: 0.001, d: 0.03, peak: 0.32 }),
      tone(k, out, { type: 'triangle', f: 2130, t: t + 0.04, a: 0.001, d: 0.04, peak: 0.28 }),
    ),
  },
  ui_command: {
    label: 'Command acknowledged', category: 'ui', bus: 'ui', gain: 0.3, voices: 1, interval: 0.05, jitter: 0.02, priority: 1,
    build: (k, out, t) => max(
      tone(k, out, { f: 990, t, a: 0.001, d: 0.04, peak: 0.4 }),
      tone(k, out, { f: 1320, t: t + 0.035, a: 0.001, d: 0.05, peak: 0.34 }),
    ),
  },
  ui_attack: {
    label: 'Attack order acknowledged', category: 'ui', bus: 'ui', gain: 0.32, voices: 1, interval: 0.05, jitter: 0.02, priority: 1,
    build: (k, out, t) => {
      const lp = k.filter(out, 'lowpass', 2200, 1);
      return max(
        tone(k, lp, { type: 'square', f: 740, t, a: 0.001, d: 0.045, peak: 0.25 }),
        tone(k, lp, { type: 'square', f: 555, t: t + 0.045, a: 0.001, d: 0.06, peak: 0.25 }),
      );
    },
  },
  ui_place: {
    label: 'Building placed', category: 'ui', bus: 'ui', gain: 0.4, voices: 1, interval: 0.08, jitter: 0.03, priority: 1,
    build: (k, out, t) => max(
      tone(k, out, { f: 160, to: 90, glide: 0.08, t, a: 0.001, d: 0.1, peak: 0.55 }),
      hiss(k, out, { type: 'highpass', f: 3000, q: 0.7, t, a: 0.0005, d: 0.012, peak: 0.3 }),
      tone(k, out, { wave: k.bank.glass, f: midiHz(86), t: t + 0.03, a: 0.002, d: 0.12, peak: 0.15 }),
    ),
  },
  ui_notify: {
    label: 'Notification', category: 'ui', bus: 'ui', gain: 0.36, voices: 1, interval: 0.15, jitter: 0, priority: 1,
    build: (k, out, t) => max(
      fmBell(k, out, midiHz(86), t, 0.3, 0.25, 2, 0.4),
      fmBell(k, out, midiHz(91), t + 0.08, 0.4, 0.22, 2, 0.4),
    ),
  },
  ui_warning: {
    label: 'Warning', category: 'ui', bus: 'ui', gain: 0.4, voices: 1, interval: 0.2, jitter: 0, priority: 2,
    build: (k, out, t) => max(
      tone(k, out, { type: 'triangle', f: midiHz(77), t, a: 0.003, d: 0.16, peak: 0.34 }),
      tone(k, out, { type: 'triangle', f: midiHz(74), t: t + 0.14, a: 0.003, d: 0.22, peak: 0.34 }),
    ),
  },
} satisfies Record<string, SfxSpec>;

export type SfxId = keyof typeof SFX;
export const SFX_IDS = Object.keys(SFX) as SfxId[];
export const getSfx = (id: SfxId): SfxSpec => SFX[id];

/** Weapon release sound per vfx key (complete — the compiler enforces every WeaponVfx is mapped). */
export const WEAPON_FIRE_SFX: Record<WeaponVfx, SfxId> = {
  spray: 'w_spray',
  uv_beam: 'w_uv_beam',
  antibiotic_capsule: 'w_antibiotic_capsule',
  laser: 'w_laser',
  engulf: 'w_engulf',
  zap: 'w_zap',
  acid_spit: 'w_acid_spit',
  spore_lob: 'w_spore_lob',
  toxin_bolt: 'w_toxin_bolt',
  bite: 'w_bite',
  whip: 'w_whip',
  slam: 'w_slam',
};

/** Projectile impact sound per vfx key (instant weapons have none: their release sound is the hit). */
export const WEAPON_IMPACT_SFX: Partial<Record<WeaponVfx, SfxId>> = {
  antibiotic_capsule: 'i_antibiotic_capsule',
  laser: 'i_laser',
  acid_spit: 'i_acid_spit',
  spore_lob: 'i_spore_lob',
  toxin_bolt: 'i_toxin_bolt',
};

export const UI_SFX: Record<UiSound, SfxId> = {
  click: 'ui_click', hover: 'ui_hover', error: 'ui_error', confirm: 'ui_confirm', open: 'ui_open', close: 'ui_close',
  select: 'ui_select', command: 'ui_command', attack: 'ui_attack', place: 'ui_place', notify: 'ui_notify', warning: 'ui_warning',
};
