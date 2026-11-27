/**
 * [audio] Ambient bed for matches: late-autumn wind (two gusting bands + a faint whistle), the distant
 * sea (slow wave swells, panned toward the water), a campus hum (mains + ventilation, louder near the
 * hospital's own buildings) and a squelchy organic layer with random bubbles near pathogen structures.
 *
 * ~6 looping noise/oscillator sources run for the whole match; JS only nudges a few gain/pan targets
 * ~4×/s (smoothed with setTargetAtTime), so the CPU cost is tiny.
 */
import { clamp, tone, type Kit } from './dsp';

export interface AmbienceParams {
  /** 0..1 wind strength (more when zoomed out) */
  wind: number;
  /** 0..1 sea proximity, pan -1..1 toward the water */
  sea: number;
  seaPan: number;
  /** 0..1 campus hum (near own buildings) */
  hum: number;
  /** 0..1 proximity of pathogen structures, pan toward them */
  squelch: number;
  squelchPan: number;
}

export const QUIET_AMBIENCE: AmbienceParams = { wind: 0.6, sea: 0, seaPan: 0, hum: 0.2, squelch: 0, squelchPan: 0 };

interface Running {
  sources: AudioScheduledSourceNode[];
  windL: GainNode; windR: GainNode; whistle: GainNode; whistleBp: BiquadFilterNode;
  sea: GainNode; seaHiss: GainNode; seaPan: AudioNode;
  hum: GainNode;
  squelch: GainNode; squelchPan: AudioNode;
}

export class AmbienceBed {
  private readonly out: GainNode;
  private run: Running | null = null;
  private acc = 1;
  private gustL = 0.6; private gustR = 0.6;
  private wave = 0;
  private nextBubble = 0;

  constructor(private readonly k: Kit, dest: AudioNode) {
    this.out = k.gain(dest, 0);
  }

  get running(): boolean { return this.run !== null; }

  start(now: number): void {
    if (this.run) { this.out.gain.setTargetAtTime(1, now, 0.8); return; }
    const k = this.k;
    const sources: AudioScheduledSourceNode[] = [];
    const loopNoise = (dest: AudioNode, kind: 'white' | 'pink' | 'brown', rate = 1): void => {
      const s = k.ctx.createBufferSource();
      s.buffer = k.bank[kind];
      s.loop = true;
      s.playbackRate.value = rate;
      s.connect(dest);
      s.start(now, k.r() * 1.5);
      sources.push(s);
    };
    const lfo = (param: AudioParam, freq: number, depth: number): void => {
      const o = k.ctx.createOscillator();
      o.frequency.value = freq;
      o.connect(k.gain(param, depth));
      o.start(now);
      sources.push(o);
    };

    // wind: two band-passed pink-noise bands, panned apart, gusting independently
    const windL = k.gain(k.panner(this.out, -0.6), 0);
    loopNoise(k.filter(windL, 'bandpass', 430, 0.5), 'pink');
    const windR = k.gain(k.panner(this.out, 0.6), 0);
    loopNoise(k.filter(windR, 'bandpass', 640, 0.5), 'pink', 0.93);
    const whistle = k.gain(this.out, 0);
    const whistleBp = k.filter(whistle, 'bandpass', 2300, 9);
    loopNoise(whistleBp, 'white', 0.97);

    // distant sea: low rumble + foam hiss, slow swells (driven from update)
    const seaPan = k.panner(this.out, 0);
    const sea = k.gain(seaPan, 0);
    loopNoise(k.filter(sea, 'lowpass', 520, 0.7), 'brown', 0.9);
    const seaHiss = k.gain(seaPan, 0);
    loopNoise(k.filter(seaHiss, 'highpass', 2600, 0.6), 'pink', 1.1);

    // campus hum: 50 Hz mains + harmonic + ventilation band
    const hum = k.gain(this.out, 0);
    const mains = k.ctx.createOscillator();
    mains.frequency.value = 50;
    mains.connect(k.gain(hum, 0.5));
    mains.start(now);
    sources.push(mains);
    const h2 = k.ctx.createOscillator();
    h2.frequency.value = 100;
    h2.connect(k.gain(hum, 0.25));
    h2.start(now);
    sources.push(h2);
    loopNoise(k.filter(k.gain(hum, 0.6), 'bandpass', 230, 1.4), 'pink', 0.8);

    // organic squelch: resonant brown noise with a wandering centre frequency
    const squelchPan = k.panner(this.out, 0);
    const squelch = k.gain(squelchPan, 0);
    const sqBp = k.filter(squelch, 'bandpass', 380, 2.5);
    lfo(sqBp.frequency, 0.35, 150);
    loopNoise(sqBp, 'brown', 0.85);

    this.run = { sources, windL, windR, whistle, whistleBp, sea, seaHiss, seaPan, hum, squelch, squelchPan };
    this.acc = 1; // apply params on the next update
    this.out.gain.setTargetAtTime(1, now, 1.0); // from wherever a previous run's fade-out left it
  }

  stop(now: number): void {
    const r = this.run;
    if (!r) return;
    this.run = null;
    this.out.gain.setTargetAtTime(0, now, 0.35);
    for (const s of r.sources) { try { s.stop(now + 2.5); } catch { /* already stopped */ } }
    // drop the per-run nodes once silent (the output gain node itself is reused)
    if (typeof setTimeout === 'function') {
      setTimeout(() => {
        for (const n of [r.windL, r.windR, r.whistle, r.sea, r.seaHiss, r.hum, r.squelch]) { try { n.disconnect(); } catch { /* ignore */ } }
      }, 3000);
    }
  }

  /** Call every frame (or from the offline driver). Parameter changes are applied ~4×/s. */
  update(now: number, dt: number, p: AmbienceParams): void {
    const r = this.run;
    if (!r) return;
    this.acc += dt;
    this.wave += dt * ((Math.PI * 2) / 9.5);
    if (this.acc >= 0.25) {
      this.acc = 0;
      const k = this.k;
      // gusts: random-walk targets per band
      this.gustL = clamp(this.gustL + (k.r() - 0.5) * 0.35, 0.3, 1);
      this.gustR = clamp(this.gustR + (k.r() - 0.5) * 0.35, 0.3, 1);
      const wind = clamp(p.wind, 0, 1);
      r.windL.gain.setTargetAtTime(0.16 * wind * this.gustL, now, 0.9);
      r.windR.gain.setTargetAtTime(0.16 * wind * this.gustR, now, 0.9);
      r.whistle.gain.setTargetAtTime(0.035 * wind * Math.max(0, this.gustL + this.gustR - 1.2), now, 1.2);
      r.whistleBp.frequency.setTargetAtTime(1900 + 900 * this.gustR, now, 1.5);
      // sea swell: irregular slow sine
      const swell = 0.55 + 0.45 * Math.sin(this.wave + 0.6 * Math.sin(this.wave * 0.37));
      const sea = clamp(p.sea, 0, 1);
      r.sea.gain.setTargetAtTime(0.32 * sea * swell, now, 0.6);
      r.seaHiss.gain.setTargetAtTime(0.05 * sea * swell * swell, now, 0.6);
      setPan(r.seaPan, p.seaPan, now);
      r.hum.gain.setTargetAtTime(0.045 * clamp(p.hum, 0, 1), now, 1.0);
      const sq = clamp(p.squelch, 0, 1);
      r.squelch.gain.setTargetAtTime(0.28 * sq, now, 0.8);
      setPan(r.squelchPan, p.squelchPan, now);
    }
    // bubbles near pathogen structures
    if (p.squelch > 0.05 && now >= this.nextBubble) {
      const k = this.k;
      const f = k.range(170, 460);
      tone(k, r.squelchPan, { f, to: f * k.range(2, 2.8), glide: 0.05, t: now + 0.02, a: 0.003, d: k.range(0.04, 0.09), peak: 0.22 * clamp(p.squelch, 0, 1) });
      this.nextBubble = now + 0.12 + (k.r() * 0.9) / (0.3 + p.squelch);
    }
  }
}

function setPan(node: AudioNode, pan: number, now: number): void {
  const p = (node as StereoPannerNode).pan;
  if (p) p.setTargetAtTime(clamp(pan, -1, 1), now, 0.8);
}
