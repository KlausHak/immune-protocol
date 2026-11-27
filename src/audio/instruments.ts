/**
 * [audio] Synth instruments for the generative score: pads, bells, the ECG monitor beep + heartbeat
 * (the score's signature motif), bass, a pedal drone, plucks and a small drum kit. Each call schedules
 * one short-lived note graph (or, for the drone, one long-running voice with a stop handle).
 */
import { EPS, fmBell, hiss, midiHz, tone, type Kit } from './dsp';

export interface PadOpts {
  level: number;
  cutoff: number;
  attack?: number;
  release?: number;
  wave?: PeriodicWave;
  /** cents (±) between the two oscillators of each note */
  detune?: number;
}

export interface DroneVoice { stop(at: number): void }

export class Instruments {
  constructor(readonly k: Kit) {}

  /** Sustained chord: two detuned soft-saw oscillators per note through one slowly opening low-pass. */
  pad(dest: AudioNode, notes: readonly number[], t: number, dur: number, o: PadOpts): number {
    const k = this.k;
    const attack = o.attack ?? 1.2, release = o.release ?? 1.6;
    const hold = t + Math.max(attack, dur);
    const end = hold + release;
    const env = k.gain(dest, 0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(o.level, t + attack);
    env.gain.setValueAtTime(o.level, hold);
    env.gain.linearRampToValueAtTime(0, end);
    const lp = k.filter(env, 'lowpass', o.cutoff, 0.6);
    lp.frequency.setValueAtTime(o.cutoff * 0.55, t);
    lp.frequency.linearRampToValueAtTime(o.cutoff, t + attack * 1.3);
    const vg = k.gain(lp, 1 / Math.sqrt(Math.max(1, notes.length * 2)));
    const det = o.detune ?? 7;
    const w = o.wave ?? k.bank.warm;
    for (const m of notes) {
      k.wave(vg, w, midiHz(m), t, end, -det);
      k.wave(vg, w, midiHz(m), t, end, det);
    }
    return end;
  }

  /** Soft sine sub-bass under a chord. */
  sub(dest: AudioNode, midi: number, t: number, dur: number, level: number): number {
    const k = this.k;
    const end = t + dur + 0.8;
    const g = k.gain(dest, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.6);
    g.gain.setValueAtTime(level, t + dur);
    g.gain.linearRampToValueAtTime(0, end);
    k.osc(g, 'sine', midiHz(midi), t, end);
    return end;
  }

  /** Mellow FM bell (harmonic ratio → tonal); optional send into the delay. */
  bell(dest: AudioNode, midi: number, t: number, vel: number, decay = 1.6, send?: AudioNode): number {
    const g = this.k.gain(dest, 1);
    if (send) g.connect(send);
    return fmBell(this.k, g, midiHz(midi), t, decay, 0.2 * vel, 2, 1.1);
  }

  /** Bright glassy note (high shimmer). */
  glass(dest: AudioNode, midi: number, t: number, vel: number, decay = 1.2, send?: AudioNode): number {
    const g = this.k.gain(dest, 1);
    if (send) g.connect(send);
    return tone(this.k, g, { wave: this.k.bank.glass, f: midiHz(midi), t, a: 0.01, d: decay, peak: 0.12 * vel });
  }

  /** Patient-monitor beep (flat-topped sine with a hint of 2nd harmonic). */
  ecg(dest: AudioNode, t: number, vel: number, send?: AudioNode, freq = 880, len = 0.075): number {
    const k = this.k;
    const g = k.gain(dest, 1);
    if (send) g.connect(send);
    const e = k.gain(g, 0);
    const lvl = 0.12 * vel;
    e.gain.setValueAtTime(0, t);
    e.gain.linearRampToValueAtTime(lvl, t + 0.004);
    e.gain.setValueAtTime(lvl, t + len);
    e.gain.linearRampToValueAtTime(0, t + len + 0.02);
    k.osc(e, 'sine', freq, t, t + len + 0.025);
    k.osc(k.gain(e, 0.12), 'sine', freq * 2, t, t + len + 0.025);
    return t + len + 0.025;
  }

  /**
   * The ECG motif: a musical P–QRS–T complex — soft lead-in, the main monitor beep, then a lower,
   * rounder tail note. `notes` = [P, QRS, T] as MIDI.
   */
  ecgMotif(dest: AudioNode, t: number, vel: number, send: AudioNode | undefined, notes: readonly [number, number, number]): number {
    this.ecg(dest, t, 0.35 * vel, send, midiHz(notes[0]), 0.035);
    this.ecg(dest, t + 0.11, vel, send, midiHz(notes[1]), 0.08);
    return this.ecg(dest, t + 0.34, 0.5 * vel, send, midiHz(notes[2]), 0.13);
  }

  /** Steady tone that fades out — the monitor "flatline" of the defeat stinger. */
  flatline(dest: AudioNode, t: number, dur: number, vel: number): number {
    const k = this.k;
    const e = k.gain(dest, 0);
    e.gain.setValueAtTime(0, t);
    e.gain.linearRampToValueAtTime(0.1 * vel, t + 0.01);
    e.gain.linearRampToValueAtTime(0, t + dur);
    k.osc(e, 'sine', 880, t, t + dur);
    return t + dur;
  }

  /** "Lub-dub": two soft low thumps. */
  heart(dest: AudioNode, t: number, vel: number): number {
    const k = this.k;
    tone(k, dest, { f: 62, to: 38, glide: 0.1, t, a: 0.004, d: 0.18, peak: 0.3 * vel });
    hiss(k, dest, { kind: 'brown', type: 'lowpass', f: 220, q: 0.7, t, a: 0.003, d: 0.08, peak: 0.12 * vel });
    tone(k, dest, { f: 55, to: 35, glide: 0.1, t: t + 0.16, a: 0.004, d: 0.2, peak: 0.2 * vel });
    return hiss(k, dest, { kind: 'brown', type: 'lowpass', f: 200, q: 0.7, t: t + 0.16, a: 0.003, d: 0.08, peak: 0.09 * vel });
  }

  /** Saw + sub bass with a filter "pluck" envelope. */
  bass(dest: AudioNode, midi: number, t: number, dur: number, vel: number, cutoff = 900): number {
    const k = this.k;
    const f = midiHz(midi);
    const end = t + dur;
    const env = k.gain(dest, 0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.16 * vel, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.09 * vel, t + Math.max(0.02, dur * 0.6));
    env.gain.linearRampToValueAtTime(0, end + 0.03);
    const lp = k.filter(env, 'lowpass', cutoff, 4);
    lp.frequency.setValueAtTime(cutoff * 2.2, t);
    lp.frequency.exponentialRampToValueAtTime(cutoff * 0.45, t + Math.min(0.2, dur));
    k.osc(lp, 'sawtooth', f, t, end + 0.04);
    k.osc(k.gain(env, 0.9), 'sine', f / 2, t, end + 0.04);
    return end + 0.04;
  }

  /** Pedal drone (saw + square through a slowly breathing low-pass, plus a faint beating high pair). */
  drone(dest: AudioNode, midi: number, t: number): DroneVoice {
    const k = this.k;
    const ctx = k.ctx;
    const g = k.gain(dest, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 1.5);
    const lp = k.filter(g, 'lowpass', 280, 1.5);
    const oscs: OscillatorNode[] = [];
    const add = (o: OscillatorNode) => { oscs.push(o); return o; };
    const lfo = add(ctx.createOscillator());
    lfo.frequency.value = 0.07;
    lfo.connect(k.gain(lp.frequency, 150));
    const o1 = add(ctx.createOscillator()); o1.type = 'sawtooth'; o1.frequency.value = midiHz(midi); o1.connect(k.gain(lp, 0.1));
    const o2 = add(ctx.createOscillator()); o2.type = 'square'; o2.frequency.value = midiHz(midi + 12); o2.detune.value = 5; o2.connect(k.gain(lp, 0.04));
    const hi = k.gain(g, 0.01);
    const o3 = add(ctx.createOscillator()); o3.frequency.value = midiHz(midi + 48); o3.connect(hi);
    const o4 = add(ctx.createOscillator()); o4.frequency.value = midiHz(midi + 48); o4.detune.value = 7; o4.connect(hi);
    for (const o of oscs) o.start(t);
    let stopped = false;
    return {
      stop(at: number) {
        if (stopped) return;
        stopped = true;
        // called once the layer is already silent; fade anyway, then free the oscillators
        g.gain.setTargetAtTime(0, at, 0.2);
        for (const o of oscs) o.stop(at + 1.2);
      },
    };
  }

  /** Square/triangle pluck for arpeggios. */
  pluck(dest: AudioNode, midi: number, t: number, vel: number, decay = 0.2, cutoff = 2600): number {
    const k = this.k;
    const lp = k.filter(dest, 'lowpass', cutoff, 1.5);
    const end = tone(k, lp, { type: 'square', f: midiHz(midi), t, a: 0.002, d: decay, peak: 0.07 * vel });
    tone(k, lp, { type: 'triangle', f: midiHz(midi) * 2, t, a: 0.002, d: decay * 0.6, peak: 0.05 * vel });
    return end;
  }

  kick(dest: AudioNode, t: number, vel: number): number {
    const end = tone(this.k, dest, { f: 155, to: 44, glide: 0.09, t, a: 0.002, d: 0.32, peak: 0.5 * vel });
    hiss(this.k, dest, { type: 'highpass', f: 3000, q: 0.7, t, a: 0.0005, d: 0.008, peak: 0.16 * vel });
    return end;
  }

  snare(dest: AudioNode, t: number, vel: number): number {
    hiss(this.k, dest, { f: 1900, q: 0.7, t, a: 0.001, d: 0.17, peak: 0.38 * vel });
    hiss(this.k, dest, { type: 'highpass', f: 5000, q: 0.7, t, a: 0.001, d: 0.09, peak: 0.16 * vel });
    return tone(this.k, dest, { type: 'triangle', f: 195, to: 155, glide: 0.08, t, a: 0.001, d: 0.1, peak: 0.28 * vel });
  }

  hat(dest: AudioNode, t: number, vel: number, open = false): number {
    return hiss(this.k, dest, { type: 'highpass', f: 7500, q: 0.8, t, a: 0.0008, d: open ? 0.2 : 0.035, peak: 0.16 * vel });
  }

  tom(dest: AudioNode, t: number, vel: number, f = 140): number {
    return tone(this.k, dest, { f: f * 1.5, to: f, glide: 0.1, t, a: 0.002, d: 0.3, peak: 0.35 * vel });
  }

  crash(dest: AudioNode, t: number, vel: number, len = 1.4): number {
    hiss(this.k, dest, { type: 'highpass', f: 4200, q: 0.5, t, a: 0.002, d: len, peak: 0.14 * vel });
    return hiss(this.k, dest, { f: 6500, q: 0.9, t, a: 0.002, d: len * 0.6, peak: 0.08 * vel });
  }

  /** Rising filtered-noise swell (transition riser). */
  swell(dest: AudioNode, t: number, dur: number, vel: number): number {
    const k = this.k;
    const g = k.gain(dest, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12 * vel, t + dur);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur + 0.05);
    const bp = k.filter(g, 'bandpass', 400, 1.2);
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(5000, t + dur);
    k.noise(bp, 'pink', t, dur + 0.06);
    return t + dur + 0.06;
  }
}
