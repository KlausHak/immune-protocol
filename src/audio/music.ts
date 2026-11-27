/**
 * [audio] Adaptive generative score — an original composition for IMMUNE PROTOCOL.
 *
 * Two "themes", each a step sequencer driven by a lookahead scheduler:
 *  - MENU (66 bpm, D major/Lydian colour): hopeful warm pads, a slow bell melody with per-loop
 *    generative variations, and the score's signature ECG motif — a musical P–QRS–T complex (soft
 *    lead-in, monitor beep, rounder tail) once per bar over a quiet "lub-dub" heartbeat.
 *  - MATCH (116 bpm, D minor): vertical layering. The same clock and 16-bar progression drive every
 *    layer; moods only change which layers are faded in and which patterns they play:
 *      calm    → pads, sparse glassy bells, a resting monitor beep every two beats (58 bpm)
 *      tension → darker pads, monitor + heartbeat racing on every beat, 8th-note bass pulse, low drone
 *      battle  → driving drums, 16th-note bass ostinato, arpeggio, pads open up
 *    Layer gains crossfade on the next beat; patterns switch on the same beat, so transitions stay in
 *    time. Victory/defeat are one-shot stingers, then a quiet outro.
 *
 * Scheduler: the engine calls schedule(now + lookahead, now) from a ~25 ms timer (and per frame).
 * If timers were throttled (background tab) and the clock ran past unscheduled steps, those steps are
 * skipped instead of being played in a burst (see skipAhead); long notes re-sync mid-span.
 * CPU: only audible layers schedule notes; pads are long notes; percussion voices are 2–4 nodes.
 */
import { makeRng, type Kit, type Rand } from './dsp';
import { Instruments, type DroneVoice } from './instruments';

export type MusicMood = 'menu' | 'calm' | 'tension' | 'battle' | 'victory' | 'defeat' | 'none';
export const MUSIC_MOODS: readonly MusicMood[] = ['menu', 'calm', 'tension', 'battle', 'victory', 'defeat', 'none'];
export const isMatchMood = (m: MusicMood): m is 'calm' | 'tension' | 'battle' => m === 'calm' || m === 'tension' || m === 'battle';

/** Late wake-up handling (pure): how many grid steps to skip so we never schedule in the past. */
export function skipAhead(nextTime: number, now: number, stepDur: number, tolerance = 0.02): number {
  if (!(stepDur > 0) || nextTime >= now - tolerance) return 0;
  return Math.ceil((now - nextTime) / stepDur);
}

type LayerId = 'pad' | 'bells' | 'ecg' | 'heart' | 'drone' | 'bass' | 'drums' | 'arp' | 'melody' | 'shimmer';

/** Stereo ping-pong delay with a darkening feedback loop. Returns its input. */
function pingPong(k: Kit, dest: AudioNode, time: number, feedback: number): GainNode {
  const ctx = k.ctx;
  const input = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 2800;
  const dl = ctx.createDelay(2), dr = ctx.createDelay(2);
  dl.delayTime.value = time;
  dr.delayTime.value = time;
  const fb = ctx.createGain();
  fb.gain.value = feedback;
  const wet = ctx.createGain();
  wet.gain.value = 0.55;
  input.connect(tone);
  tone.connect(dl);
  dl.connect(dr);
  dr.connect(fb);
  fb.connect(tone);
  dl.connect(k.panner(wet, -0.7));
  dr.connect(k.panner(wet, 0.7));
  wet.connect(dest);
  return input;
}

/** A fader for one instrument layer (+ optional post-fader send into the theme's delay). */
class Layer {
  readonly gain: GainNode;
  target = 0;
  private silentAt = 0;
  constructor(k: Kit, dest: AudioNode, delay: AudioNode, send: number) {
    this.gain = k.gain(dest, 0);
    if (send > 0) this.gain.connect(k.gain(delay, send));
  }
  set(v: number, at: number, tau: number): void {
    this.gain.gain.setTargetAtTime(v, at, tau);
    this.target = v;
    this.silentAt = v > 1e-3 ? Infinity : at + tau * 6;
  }
  /** Worth scheduling notes for at time t (fading layers keep playing until silent). */
  audible(t: number): boolean { return this.target > 1e-3 || t < this.silentAt; }
}

abstract class Theme {
  readonly out: GainNode;
  protected readonly layers = new Map<LayerId, Layer>();
  protected readonly rng: Rand;
  step = 0;
  nextTime = 0;
  active = false;
  private stopAt = Infinity;

  constructor(protected readonly ins: Instruments, dest: AudioNode, readonly bpm: number, ids: LayerId[], sends: Partial<Record<LayerId, number>>, seed: number) {
    const k = ins.k;
    this.out = k.gain(dest, 0);
    const delay = pingPong(k, this.out, (0.75 * 60) / bpm, 0.36);
    for (const id of ids) this.layers.set(id, new Layer(k, this.out, delay, sends[id] ?? 0));
    this.rng = makeRng(seed);
  }

  get stepDur(): number { return 60 / this.bpm / 4; }
  protected L(id: LayerId): Layer { return this.layers.get(id)!; }

  start(at: number, level: number, fade: number): void {
    if (!this.active) {
      this.active = true;
      this.step = 0;
      this.nextTime = at + 0.05;
      this.onStart(at);
    }
    this.stopAt = Infinity;
    this.out.gain.setTargetAtTime(level, at, Math.max(0.05, fade / 3));
  }

  stop(at: number, fade: number): void {
    if (!this.active || this.stopAt !== Infinity) return;
    this.out.gain.setTargetAtTime(0, at, Math.max(0.05, fade / 3));
    this.stopAt = at + fade * 2;
  }

  /** Time of the next not-yet-scheduled beat. */
  nextBeatTime(): number {
    const toBeat = (4 - (this.step % 4)) % 4;
    return this.nextTime + toBeat * this.stepDur;
  }

  schedule(until: number, now: number): void {
    if (!this.active) return;
    if (now >= this.stopAt) { this.active = false; this.stopAt = Infinity; this.onStop(now); return; }
    const missed = skipAhead(this.nextTime, now, this.stepDur);
    if (missed > 0) { this.step += missed; this.nextTime += missed * this.stepDur; }
    let guard = 0;
    while (this.nextTime < until && guard++ < 256) {
      this.onStep(this.step, this.nextTime);
      this.step++;
      this.nextTime += this.stepDur;
    }
  }

  protected onStart(_t: number): void { /* optional */ }
  protected onStop(_t: number): void { /* optional */ }
  protected abstract onStep(step: number, t: number): void;
}

// ───────────────────────── match theme (D minor, 116 bpm) ─────────────────────────

interface Chord { pad: number[]; root: number; tones: number[]; resolve?: number[] }

/** One chord per two bars → a 16-bar loop (≈ 33 s). MIDI note numbers. */
const MATCH_PROG: Chord[] = [
  { pad: [62, 65, 69, 76], root: 38, tones: [62, 65, 69, 72, 76] }, // Dm(add9)
  { pad: [58, 62, 65, 69], root: 34, tones: [58, 62, 65, 69, 74] }, // Bbmaj7
  { pad: [57, 60, 65, 67], root: 41, tones: [60, 65, 67, 69, 72] }, // F(add9)/A
  { pad: [55, 60, 62, 67], root: 36, tones: [60, 62, 67, 72, 74] }, // Csus2
  { pad: [57, 62, 65, 69], root: 38, tones: [62, 65, 69, 74, 77] }, // Dm
  { pad: [55, 58, 62, 65], root: 43, tones: [55, 58, 62, 65, 70] }, // Gm7
  { pad: [58, 62, 65, 72], root: 34, tones: [58, 62, 65, 70, 72] }, // Bb(add9)
  { pad: [57, 62, 64, 69], root: 33, tones: [57, 61, 64, 69, 73], resolve: [57, 61, 64, 69] }, // Asus4 → A
];

type MatchMix = 'calm' | 'tension' | 'battle' | 'defeat';
const MATCH_MIX: Record<MatchMix, Partial<Record<LayerId, number>>> = {
  calm: { pad: 1, bells: 1, ecg: 0.5 },
  tension: { pad: 0.85, bells: 0.35, ecg: 0.9, heart: 0.6, drone: 0.8, bass: 0.5 },
  battle: { pad: 0.8, ecg: 0.5, drone: 0.4, bass: 1, drums: 1, arp: 0.75 },
  defeat: { pad: 0.7, bells: 0.6 },
};
const MATCH_LAYERS: LayerId[] = ['pad', 'bells', 'ecg', 'heart', 'drone', 'bass', 'drums', 'arp'];
/** Root-relative semitones (only root / fifth / octave → fits every chord); null = rest. */
const BASS_OSTINATO: Array<number | null> = [0, null, 0, 12, null, 0, 7, null, 0, 0, 12, null, 7, null, 12, 7];
const KICK = [1, 0, 0, 0, 0, 0, 0.7, 0, 0.95, 0, 0.55, 0, 0, 0, 0, 0];
const SNARE = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0.3];
const FILL_TOMS = [196, 165, 147, 110];

class MatchTheme extends Theme {
  mood: MatchMix = 'calm';
  private pmood: MatchMix = 'calm';
  private padUntil = 0;
  private drone: DroneVoice | null = null;
  private lastBell = -99;

  constructor(ins: Instruments, dest: AudioNode) {
    super(ins, dest, 116, MATCH_LAYERS, { ecg: 0.35, bells: 0.45, arp: 0.15 }, 0x5eed);
  }

  /** Crossfade the layers to a mood on the next beat. */
  setMix(mood: MatchMix, now: number): void {
    this.mood = mood;
    const at = this.active ? Math.max(now, this.nextBeatTime()) : now;
    for (const [id, layer] of this.layers) {
      const target = MATCH_MIX[mood][id] ?? 0;
      const fast = mood === 'battle' && (id === 'drums' || id === 'bass' || id === 'arp');
      layer.set(target, at, target > layer.target ? (fast ? 0.25 : 0.9) : 1.6);
    }
  }

  protected override onStart(): void { this.padUntil = 0; this.pmood = this.mood; this.lastBell = -99; }
  protected override onStop(t: number): void { this.drone?.stop(t); this.drone = null; }

  protected onStep(step: number, t: number): void {
    const s16 = step % 16;
    if (s16 % 4 === 0) this.pmood = this.mood; // patterns follow the mood on the beat
    const m = this.pmood;
    const ch = MATCH_PROG[Math.floor(step / 32) % MATCH_PROG.length]!;
    const inSpan = step % 32;
    const bar = Math.floor(step / 16);
    const sd = this.stepDur;
    const ins = this.ins;

    const pad = this.L('pad');
    if (pad.audible(t) && t >= this.padUntil - 1e-3) {
      const half = ch.resolve ? 16 : 32;
      const remain = (half - (inSpan % half)) * sd;
      const notes = ch.resolve && inSpan >= 16 ? ch.resolve : ch.pad;
      const cutoff = m === 'battle' ? 1800 : m === 'tension' ? 850 : m === 'defeat' ? 700 : 1200;
      ins.pad(pad.gain, notes, t, remain, { level: 0.1, cutoff, attack: Math.min(1.4, remain * 0.5), release: 1.4 });
      ins.sub(pad.gain, ch.root + 12, t, remain, 0.05);
      this.padUntil = t + remain;
    }

    const ecg = this.L('ecg');
    if (ecg.audible(t)) {
      const every = m === 'calm' || m === 'defeat' ? 8 : 4; // resting 58 bpm vs racing 116 bpm
      if (step % every === 0) ins.ecg(ecg.gain, t, s16 === 0 ? 1 : 0.8);
    }

    const heart = this.L('heart');
    if (heart.audible(t) && s16 % 4 === 0) ins.heart(heart.gain, t, s16 === 0 ? 1 : 0.8);

    const drone = this.L('drone');
    if (drone.target > 1e-3 && !this.drone) this.drone = ins.drone(drone.gain, 26, t); // D1 pedal
    else if (this.drone && !drone.audible(t)) { this.drone.stop(t); this.drone = null; }

    const bass = this.L('bass');
    if (bass.audible(t)) {
      if (m === 'battle') {
        const iv = BASS_OSTINATO[s16];
        if (iv !== null && iv !== undefined) ins.bass(bass.gain, ch.root + 12 + iv, t, sd * 0.9, s16 % 4 === 0 ? 1 : 0.72, 650);
      } else if (step % 2 === 0) {
        ins.bass(bass.gain, ch.root + 12, t, sd * 1.4, s16 % 8 === 0 ? 0.9 : 0.55, 360);
      }
    }

    const drums = this.L('drums');
    if (drums.audible(t) && m === 'battle') {
      if (bar % 8 === 7 && s16 >= 12) {
        ins.tom(drums.gain, t, 0.85, FILL_TOMS[s16 - 12]!);
      } else {
        const kv = KICK[s16]!;
        if (kv) ins.kick(drums.gain, t, kv);
        const sv = SNARE[s16]!;
        if (sv) ins.snare(drums.gain, t, sv);
      }
      ins.hat(drums.gain, t, s16 % 2 === 0 ? 0.75 : 0.4, s16 === 14 && bar % 2 === 1);
      if (s16 === 0 && bar % 8 === 0) ins.crash(drums.gain, t, 0.7);
    }

    const arp = this.L('arp');
    if (arp.audible(t) && m === 'battle') {
      const tones = ch.tones;
      const cycle = tones.length * 2 - 2; // up-down
      const idx = step % cycle;
      const i = idx < tones.length ? idx : cycle - idx;
      ins.pluck(arp.gain, tones[i]! + 12, t, s16 % 4 === 0 ? 1 : 0.65, 0.16, 2400);
    }

    const bells = this.L('bells');
    if (bells.audible(t) && step - this.lastBell >= 3) {
      const p = m === 'calm' ? 0.07 : m === 'defeat' ? 0.05 : 0.035;
      if (this.rng() < p) {
        const n = ch.tones[Math.floor(this.rng() * ch.tones.length)]! + (this.rng() < 0.3 ? 24 : 12);
        ins.bell(bells.gain, n, t, 0.35 + 0.45 * this.rng(), 1.8);
        this.lastBell = step;
      }
    }
  }
}

// ───────────────────────── menu theme (D major, 66 bpm) ─────────────────────────

/** One chord per bar → an 8-bar loop (≈ 29 s). */
const MENU_PROG: Array<{ pad: number[]; root: number }> = [
  { pad: [62, 66, 73, 76], root: 38 }, // Dmaj9
  { pad: [59, 62, 66, 76], root: 35 }, // Bm(add11)
  { pad: [59, 62, 66, 69], root: 31 }, // Gmaj9 (over G)
  { pad: [57, 62, 64, 71], root: 33 }, // Asus4(add9)
  { pad: [62, 66, 69, 73], root: 42 }, // Dmaj7/F#
  { pad: [55, 59, 62, 66], root: 40 }, // Em9 (over E)
  { pad: [55, 62, 66, 71], root: 43 }, // Gmaj7
  { pad: [57, 61, 64, 69], root: 45 }, // A
];
/** Original bell melody: per bar, [step, midi, length in steps]. */
const MENU_MELODY: Array<Array<[number, number, number]>> = [
  [[0, 81, 6], [6, 78, 2], [8, 76, 8]],
  [[0, 74, 4], [4, 78, 4], [8, 83, 8]],
  [[0, 81, 6], [6, 79, 2], [8, 74, 8]],
  [[0, 76, 12]],
  [[0, 78, 4], [4, 81, 4], [8, 86, 8]],
  [[0, 83, 6], [6, 81, 2], [8, 78, 8]],
  [[0, 79, 4], [4, 78, 4], [8, 76, 8]],
  [[0, 76, 8], [8, 73, 8]],
];
const MENU_LAYERS: LayerId[] = ['pad', 'melody', 'ecg', 'heart', 'shimmer'];
const MENU_MIX: Partial<Record<LayerId, number>> = { pad: 1, melody: 0.9, ecg: 0.8, heart: 0.55, shimmer: 0.8 };

class MenuTheme extends Theme {
  private variant = 0;
  private loop = 0;
  private padUntil = 0;

  constructor(ins: Instruments, dest: AudioNode) {
    super(ins, dest, 66, MENU_LAYERS, { melody: 0.4, ecg: 0.45, shimmer: 0.5 }, 0xa11ce);
  }

  protected override onStart(t: number): void {
    this.padUntil = 0;
    this.variant = 0;
    for (const [id, l] of this.layers) l.set(MENU_MIX[id] ?? 0, t, 0.05);
  }

  protected onStep(step: number, t: number): void {
    const s16 = step % 16;
    const bar = Math.floor(step / 16);
    const barInLoop = bar % MENU_PROG.length;
    if (step % 128 === 0) {
      this.loop = Math.floor(step / 128);
      this.variant = this.loop === 0 ? 0 : Math.floor(this.rng() * 3);
    }
    const ch = MENU_PROG[barInLoop]!;
    const sd = this.stepDur;
    const ins = this.ins;

    const pad = this.L('pad');
    if (pad.audible(t) && t >= this.padUntil - 1e-3) {
      const remain = (16 - s16) * sd;
      ins.pad(pad.gain, ch.pad, t, remain, { level: 0.1, cutoff: 2200, attack: Math.min(1.6, remain * 0.5), release: 1.8 });
      ins.sub(pad.gain, ch.root + 12, t, remain, 0.06);
      this.padUntil = t + remain;
    }

    if (s16 === 0 && this.L('ecg').audible(t)) ins.ecgMotif(this.L('ecg').gain, t, 1, undefined, [76, 81, 78]);
    if ((s16 === 0 || s16 === 8) && this.L('heart').audible(t)) ins.heart(this.L('heart').gain, t, s16 === 0 ? 0.8 : 0.6);

    const mel = this.L('melody');
    if (mel.audible(t) && !(this.loop === 0 && bar < 2)) { // intro: pads + pulse only
      for (const [st, midi, len] of MENU_MELODY[barInLoop]!) {
        if (st !== s16) continue;
        let note = midi;
        let vel = 0.75 + 0.2 * this.rng();
        if (this.variant === 1) { // skeleton, lifted an octave in the bridge
          if (st !== 0 && st !== 8) continue;
          if (barInLoop === 4 || barInLoop === 5) note += 12;
        } else if (this.variant === 2 && barInLoop % 2 === 1 && barInLoop !== 7) {
          continue; // call & response with the ECG motif
        }
        if (this.variant === 2 && barInLoop % 2 === 0) vel *= 0.9;
        const humanize = (this.rng() - 0.5) * 0.012;
        ins.bell(mel.gain, note, Math.max(t, t + humanize), vel, Math.min(3, Math.max(0.6, len * sd * 1.4)));
      }
    }

    const sh = this.L('shimmer');
    if (sh.audible(t) && this.rng() < 0.035) {
      ins.glass(sh.gain, ch.pad[Math.floor(this.rng() * ch.pad.length)]! + 24, t, 0.4 + 0.4 * this.rng(), 1.6);
    }
  }
}

// ───────────────────────── stingers ─────────────────────────

function victoryStinger(ins: Instruments, dest: AudioNode, send: AudioNode, t0: number): number {
  ins.pad(dest, [62, 66, 69, 74], t0, 1.5, { level: 0.12, cutoff: 2600, attack: 0.08, release: 0.8 });
  ins.kick(dest, t0, 0.9);
  ins.crash(dest, t0, 0.7, 1.6);
  const seq: Array<[number, number, number]> = [[0, 81, 0.9], [0.17, 86, 0.9], [0.34, 90, 0.95], [0.51, 93, 1], [1.0, 91, 0.8], [1.17, 90, 0.8], [1.34, 88, 0.85]];
  for (const [dt, m, v] of seq) ins.bell(dest, m, t0 + dt, v, 1.3, send);
  const tf = t0 + 1.7;
  ins.pad(dest, [62, 66, 69, 73, 76], tf, 2.2, { level: 0.14, cutoff: 3000, attack: 0.05, release: 2.0 });
  ins.sub(dest, 50, tf, 2.2, 0.08);
  ins.kick(dest, tf, 1);
  ins.crash(dest, tf, 0.9, 2.2);
  for (const m of [86, 90, 93]) ins.bell(dest, m, tf, 0.75, 2.6, send);
  return tf + 4.2 - t0;
}

function defeatStinger(ins: Instruments, dest: AudioNode, send: AudioNode, t0: number): number {
  ins.pad(dest, [50, 57, 62, 65], t0, 3.2, { level: 0.12, cutoff: 900, attack: 0.6, release: 2.2 });
  ins.sub(dest, 38, t0, 3.2, 0.08);
  const seq: Array<[number, number]> = [[0, 81], [0.5, 79], [1.0, 77], [1.5, 76], [2.1, 74]];
  for (const [dt, m] of seq) ins.bell(dest, m, t0 + dt, 0.65, 1.8, send);
  ins.ecg(dest, t0 + 0.3, 0.6); // the monitor slows… and flatlines (softly)
  ins.ecg(dest, t0 + 1.5, 0.5);
  ins.ecg(dest, t0 + 2.9, 0.4);
  ins.flatline(dest, t0 + 3.9, 1.8, 0.4);
  return 6;
}

// ───────────────────────── engine ─────────────────────────

export class MusicEngine {
  readonly out: GainNode;
  private readonly ins: Instruments;
  private readonly menu: MenuTheme;
  private readonly match: MatchTheme;
  private readonly sting: GainNode;
  private readonly stingDelay: GainNode;
  private mood: MusicMood = 'none';
  private after: { at: number; run: (at: number) => void } | null = null;

  constructor(k: Kit, dest: AudioNode) {
    this.out = k.gain(dest, 1);
    this.ins = new Instruments(k);
    this.menu = new MenuTheme(this.ins, this.out);
    this.match = new MatchTheme(this.ins, this.out);
    this.sting = k.gain(this.out, 1);
    this.stingDelay = pingPong(k, this.sting, 0.33, 0.3);
  }

  get current(): MusicMood { return this.mood; }
  /** Which themes are currently scheduling notes (debug/tests). */
  get activeThemes(): string[] { return [this.menu.active ? 'menu' : '', this.match.active ? 'match' : ''].filter(Boolean); }

  setMood(mood: MusicMood, now: number): void {
    if (mood === this.mood) return;
    const prev = this.mood;
    this.mood = mood;
    this.after = null;
    switch (mood) {
      case 'menu':
        this.match.stop(now, 2.5);
        this.menu.start(now, 1, prev === 'none' ? 2 : 3);
        break;
      case 'calm': case 'tension': case 'battle':
        this.menu.stop(now, 2.5);
        this.match.setMix(mood, now);
        this.match.start(now, 1, isMatchMood(prev) ? 1 : 3);
        break;
      case 'victory': {
        this.menu.stop(now, 0.6);
        this.match.stop(now, 0.8);
        const t0 = now + 0.25;
        const d = victoryStinger(this.ins, this.sting, this.stingDelay, t0);
        this.after = { at: t0 + d - 1.5, run: (at) => this.menu.start(at, 0.7, 5) };
        break;
      }
      case 'defeat': {
        this.menu.stop(now, 0.6);
        this.match.stop(now, 0.8);
        const t0 = now + 0.25;
        const d = defeatStinger(this.ins, this.sting, this.stingDelay, t0);
        this.after = { at: t0 + d - 0.5, run: (at) => { this.match.setMix('defeat', at); this.match.start(at, 0.6, 5); } };
        break;
      }
      case 'none':
        this.menu.stop(now, 2);
        this.match.stop(now, 2);
        break;
    }
  }

  /** Schedule every active theme up to `until` (context seconds). Safe to call often. */
  schedule(until: number, now: number): void {
    if (this.after && now >= this.after.at - 0.3) {
      const a = this.after;
      this.after = null;
      a.run(Math.max(now, a.at));
    }
    this.menu.schedule(until, now);
    this.match.schedule(until, now);
  }

  dispose(): void { try { this.out.disconnect(); } catch { /* ignore */ } }
}
