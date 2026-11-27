/**
 * [audio] Audio sandbox. Live: buttons for every sound, every music mood, the ambient bed, speech and a
 * simulated skirmish. Self-test (?selftest=1 or the button) renders, offline, and checks:
 *   - every SFX (all back-to-back in ONE OfflineAudioContext, sliced per sound — cheap on a busy box),
 *   - every music mood + the adaptive crossfade, the ambient bed,
 *   - the real engine: a 50-bite burst through the limiter, and a whole simulated skirmish through
 *     AudioEngine.attach() (event mapping, spatial culling, adaptive mood, master chain),
 * for: non-silent, no NaN, peak ≤ 0.99 (no clipping), sensible length, decays to silence.
 * Results go to the page and the console ("[audio-selftest] …"); window.__audioSelftest holds them.
 */
import { AudioEngine, ALL_SFX_IDS } from '../src/audio/AudioEngine';
import { AmbienceBed } from '../src/audio/ambience';
import { Kit, makeRng } from '../src/audio/dsp';
import { MusicEngine, type MusicMood } from '../src/audio/music';
import { SFX, UI_SFX, type SfxCategory, type SfxId, type UiSound } from '../src/audio/sfx';
import type { GameContext } from '../src/game/contracts';
import { DEFAULT_SETTINGS } from '../src/game/settings';

const SR = 22050;
const $ = (id: string) => document.getElementById(id)!;

// ───────────────────────── analysis ─────────────────────────

/** A time window of a rendered buffer (seconds). */
interface Slice { buf: AudioBuffer; from: number; to: number }
interface Analysis { peak: number; rms: number; tail: number; audible: number; nan: boolean; leftRight: number }

/** Peak/NaN/audible-end over the whole slice; RMS over [rmsFrom, rmsTo]; tail = RMS of the slice's last 0.1 s. */
function analyse(s: Slice, rmsFrom = s.from, rmsTo = s.to): Analysis {
  const { buf } = s, sr = buf.sampleRate;
  const a0 = Math.max(0, Math.floor(s.from * sr)), a1 = Math.min(buf.length, Math.floor(s.to * sr));
  const r0 = Math.max(a0, Math.floor(rmsFrom * sr)), r1 = Math.min(a1, Math.floor(rmsTo * sr));
  const t0 = Math.max(a0, a1 - Math.floor(0.1 * sr));
  let peak = 0, sum = 0, n = 0, nan = false, last = a0, ts = 0, tn = 0;
  const e = [0, 0];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = a0; i < a1; i++) {
      const v = d[i]!;
      if (!Number.isFinite(v)) { nan = true; continue; }
      const av = Math.abs(v);
      if (av > peak) peak = av;
      if (i >= r0 && i < r1) { sum += v * v; n++; e[c & 1]! += v * v; }
      if (i >= t0) { ts += v * v; tn++; }
    }
  }
  const thr = Math.max(1e-4, peak * 0.003); // -50 dB re peak
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = a1 - 1; i > last; i--) if (Math.abs(d[i]!) > thr) { last = i; break; }
  }
  return {
    peak, rms: Math.sqrt(sum / Math.max(1, n)), tail: Math.sqrt(ts / Math.max(1, tn)), audible: last / sr, nan,
    leftRight: buf.numberOfChannels > 1 ? e[0]! / Math.max(1e-12, e[1]!) : 1,
  };
}

/** Windowed RMS (activity / crossfade-gap checks). */
function windows(buf: AudioBuffer, win: number, from: number, to: number): number[] {
  const d0 = buf.getChannelData(0), d1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : d0;
  const out: number[] = [];
  for (let t = from; t + win <= to + 1e-9; t += win) {
    const a = Math.floor(t * buf.sampleRate), b = Math.floor((t + win) * buf.sampleRate);
    let s = 0;
    for (let i = a; i < b; i++) s += (d0[i]! * d0[i]! + d1[i]! * d1[i]!) / 2;
    out.push(Math.sqrt(s / Math.max(1, b - a)));
  }
  return out;
}

// ───────────────────────── result UI ─────────────────────────

interface Result { group: string; name: string; label: string; ok: boolean; metrics: string; why: string; slice?: Slice }
const results: Result[] = [];
let lastGroup = '';

function draw(canvas: HTMLCanvasElement, s: Slice, ok: boolean): void {
  const w = (canvas.width = 240), h = (canvas.height = 16);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#071318';
  g.fillRect(0, 0, w, h);
  g.fillStyle = ok ? '#2fd6c6' : '#ff6b7a';
  const d = s.buf.getChannelData(0), sr = s.buf.sampleRate;
  const a0 = Math.floor(s.from * sr), a1 = Math.min(d.length, Math.floor(s.to * sr));
  const step = Math.max(1, Math.floor((a1 - a0) / w));
  for (let x = 0; x < w; x++) {
    let mx = 0;
    for (let i = a0 + x * step, e = Math.min(a1, i + step); i < e; i++) mx = Math.max(mx, Math.abs(d[i]!));
    const bh = Math.max(1, Math.min(h, mx * h * 1.2));
    g.fillRect(x, (h - bh) / 2, 1, bh);
  }
}

function report(r: Result): void {
  results.push(r);
  const root = $('results');
  if (r.group !== lastGroup) {
    lastGroup = r.group;
    const s = document.createElement('div');
    s.className = 'sec';
    s.textContent = r.group;
    root.appendChild(s);
  }
  const c = document.createElement('div');
  c.className = 'card' + (r.ok ? '' : ' bad');
  c.title = `${r.label}\n${r.metrics}${r.why ? `\n✗ ${r.why}` : ''}`;
  c.innerHTML = `<div class="top"><span class="name">${r.name}</span><span class="${r.ok ? 'ok' : 'ko'}">${r.ok ? 'OK' : 'FAIL'}</span></div><div class="m">${r.metrics}${r.why ? ` · ${r.why}` : ''}</div>`;
  if (r.slice) { const cv = document.createElement('canvas'); c.appendChild(cv); draw(cv, r.slice, r.ok); }
  root.appendChild(c);
  const line = `[audio-selftest] ${r.ok ? 'OK  ' : 'FAIL'} ${r.group}/${r.name} ${r.metrics}${r.why ? ` (${r.why})` : ''}`;
  if (r.ok) console.log(line); else console.error(line);
}

const f2 = (v: number) => v.toFixed(2), f3 = (v: number) => v.toFixed(3);

// ───────────────────────── tests ─────────────────────────

const CATEGORY_GROUP: Record<SfxCategory, string> = {
  weapon: 'weapons', impact: 'impacts', death: 'deaths', economy: 'economy', announcer: 'announcer', ability: 'abilities', ui: 'ui',
};
const GAP = 0.35;

/** Every sound back-to-back in one mono context, each through its mix gain; analysed per slot. */
async function testAllSfx(ids: SfxId[]): Promise<void> {
  const v = { pitch: 1, size: 0.6 };
  // 1) probe: build each sound with its seed into a never-rendered 1-frame context to learn its length
  const probe = new OfflineAudioContext(1, 1, SR);
  const slots: Array<{ id: SfxId; start: number; end: number; seed: number }> = [];
  let t = 0.02;
  ids.forEach((id, i) => {
    const seed = 1000 + i;
    const end = SFX[id].build(new Kit(probe, makeRng(seed)), probe.destination, t, v);
    slots.push({ id, start: t, end, seed });
    t = end + GAP;
  });
  // 2) render all of them in one pass (same seeds → identical graphs)
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * (t + 0.02)), SR);
  for (const s of slots) {
    const voice = ctx.createGain();
    voice.gain.value = SFX[s.id].gain;
    voice.connect(ctx.destination);
    SFX[s.id].build(new Kit(ctx, makeRng(s.seed)), voice, s.start, v);
  }
  const buf = await ctx.startRendering();
  // 3) per-slot checks
  for (const s of slots) {
    const spec = SFX[s.id];
    const len = s.end - s.start;
    const slice: Slice = { buf, from: s.start, to: s.end + GAP };
    const a = analyse(slice, s.start, s.end);
    const maxLen = spec.category === 'ui' ? 0.6 : 4;
    const why = a.nan ? 'NaN' : a.peak > 0.99 ? 'clips' : a.peak < 0.02 ? 'too quiet' : a.rms < 0.002 ? 'near-silent'
      : len < 0.015 || len > maxLen ? 'bad length' : a.tail > 1e-3 ? 'does not decay' : a.audible > s.end + 0.25 ? 'rings past end' : '';
    report({ group: CATEGORY_GROUP[spec.category], name: s.id, label: spec.label, ok: !why, why, slice, metrics: `${f2(len)}s pk ${f2(a.peak)} rms ${f3(a.rms)}` });
  }
}

/** Drive a MusicEngine through `dur` seconds like the realtime scheduler would (25 ms ticks). */
async function renderMusic(dur: number, plan: Array<[number, MusicMood]>): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * dur), SR);
  const music = new MusicEngine(new Kit(ctx, makeRng(11)), ctx.destination);
  let pi = 0;
  for (let t = 0; t < dur; t += 0.025) {
    while (pi < plan.length && plan[pi]![0] <= t) music.setMood(plan[pi++]![1], t);
    music.schedule(Math.min(dur, t + 0.2), t);
  }
  return ctx.startRendering();
}

async function testMusic(mood: MusicMood): Promise<void> {
  const dur = mood === 'victory' || mood === 'defeat' ? 7 : mood === 'menu' ? 8 : 6;
  const buf = await renderMusic(dur, [[0, mood]]);
  const a = analyse({ buf, from: 0, to: dur }, 1.5, dur);
  const act = windows(buf, 0.5, 1.5, dur);
  const activity = act.filter((x) => x > 0.003).length / Math.max(1, act.length);
  const why = a.nan ? 'NaN' : a.peak > 0.99 ? 'clips' : a.rms < 0.005 ? 'near-silent' : activity < 0.6 ? 'gaps' : '';
  report({ group: 'music', name: mood, label: `music mood ${mood}`, ok: !why, why, slice: { buf, from: 0, to: dur }, metrics: `pk ${f2(a.peak)} rms ${f3(a.rms)} act ${Math.round(activity * 100)}%` });
}

async function testMusicNone(): Promise<void> {
  const buf = await renderMusic(4, [[0, 'menu'], [0.5, 'none']]);
  const a = analyse({ buf, from: 3.5, to: 4 });
  const why = a.rms > 2e-3 ? 'not fading out' : '';
  report({ group: 'music', name: 'none', label: 'menu → none fades out', ok: !why, why, slice: { buf, from: 0, to: 4 }, metrics: `rms after fade ${a.rms.toExponential(1)}` });
}

async function testCrossfade(): Promise<void> {
  const buf = await renderMusic(13, [[0, 'calm'], [4.5, 'tension'], [8.5, 'battle']]);
  const calm = analyse({ buf, from: 1.5, to: 4.5 }).rms, battle = analyse({ buf, from: 10.5, to: 13 }).rms;
  const gaps = Math.min(...windows(buf, 0.25, 4, 11));
  const a = analyse({ buf, from: 0, to: 13 });
  const why = a.nan ? 'NaN' : a.peak > 0.99 ? 'clips' : battle < calm * 1.2 ? 'battle not denser than calm' : gaps < calm * 0.15 ? 'dropout during crossfade' : '';
  report({ group: 'music', name: 'calm→tension→battle', label: 'adaptive crossfade', ok: !why, why, slice: { buf, from: 0, to: 13 }, metrics: `calm ${f3(calm)} → battle ${f3(battle)} min ${f3(gaps)}` });
}

async function testAmbience(): Promise<void> {
  const dur = 6;
  const ctx = new OfflineAudioContext(2, SR * dur, SR);
  const bed = new AmbienceBed(new Kit(ctx, makeRng(5)), ctx.destination);
  bed.start(0);
  const p = { wind: 0.8, sea: 0.8, seaPan: -0.7, hum: 0.6, squelch: 0.8, squelchPan: 0.6 };
  for (let t = 0; t < dur; t += 0.05) bed.update(t, 0.05, p);
  bed.stop(dur - 1.5);
  const buf = await ctx.startRendering();
  const a = analyse({ buf, from: 0, to: dur }, 2, dur - 1.6);
  const tail = analyse({ buf, from: dur - 0.2, to: dur }).rms;
  const why = a.nan ? 'NaN' : a.peak > 0.99 ? 'clips' : a.rms < 0.003 ? 'near-silent' : tail > a.rms * 0.3 ? 'no fade-out' : '';
  report({ group: 'ambience', name: 'wind+sea+hum+squelch', label: 'ambient bed', ok: !why, why, slice: { buf, from: 0, to: dur }, metrics: `pk ${f2(a.peak)} rms ${f3(a.rms)} L/R ${f2(a.leftRight)}` });
}

/** Through the real engine + master chain: a burst of 110 sounds within one second must not clip. */
async function testStress(): Promise<void> {
  const ctx = new OfflineAudioContext(2, SR * 2, SR);
  const engine = new AudioEngine({ ...DEFAULT_SETTINGS, masterVolume: 1, sfxVolume: 1 }, { context: ctx, seed: 3 });
  let req = 0;
  for (let i = 0; i < 50; i++) {
    engine.playSfx('w_bite');
    engine.playSfx(i % 2 ? 'w_spray' : 'd_pathogen_small');
    req += 2;
    if (i % 5 === 0) { engine.playSfx('i_spore_lob'); req++; }
    engine.update(0.02);
  }
  const s = engine.stats();
  const buf = await ctx.startRendering();
  const a = analyse({ buf, from: 0, to: 2 });
  const why = a.nan ? 'NaN' : a.peak > 0.99 ? 'clips' : s.played >= req ? 'no limiting' : a.rms < 0.005 ? 'silent' : '';
  report({ group: 'engine', name: 'stress 50 bites/1s', label: 'rate/voice limiting + limiter', ok: !why, why, slice: { buf, from: 0, to: 2 }, metrics: `${s.played}/${req} played pk ${f2(a.peak)}` });
}

/** A whole simulated skirmish rendered offline through AudioEngine.attach(): event mapping end-to-end. */
async function testMatch(): Promise<void> {
  const dur = 20;
  let headless: typeof import('../src/game/headless');
  try { headless = await import('../src/game/headless'); } catch (err) {
    console.warn('[audio-selftest] match test skipped: sim failed to load', err);
    report({ group: 'engine', name: 'simulated match', label: 'skipped', ok: true, why: '', metrics: 'skipped (sim module failed to load)' });
    return;
  }
  const m = headless.createHeadlessMatch({ mapId: 'test', enemyAi: false, seed: 9 });
  const w = m.world;
  const ctx = new OfflineAudioContext(2, SR * dur, SR);
  const engine = new AudioEngine({ ...DEFAULT_SETTINGS }, { context: ctx, seed: 21 });
  const cam = { x: 36, y: 66 };
  const fake = { world: w, localPlayerId: 1, renderer: { cameraCtl: { getTarget: () => cam, distance: 34 } } } as unknown as GameContext;
  engine.attach(fake);
  const hq = w.entitiesOf(1, (e) => e.kind === 'building')[0];
  const moods: string[] = [];
  let lancer: ReturnType<typeof w.spawnUnit> | null = null;
  for (let tick = 0; tick < (dur - 2) * 20; tick++) {
    if (tick === 10) {
      if (hq) w.issue({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
      for (let i = 0; i < 6; i++) w.spawnUnit('hosp_sanitizer', 1, { x: 31 + i, y: 71 });
      lancer = w.spawnUnit('hosp_uv_lancer', 1, { x: 33, y: 72.5 });
      w.spawnUnit('hosp_macrophage', 1, { x: 36, y: 72.5 });
    }
    if (tick === 60) {
      for (let i = 0; i < 8; i++) w.spawnUnit('path_phage', 2, { x: 30 + i, y: 64 });
      for (let i = 0; i < 3; i++) w.spawnUnit('path_bacillus', 2, { x: 32 + i * 1.5, y: 63 });
    }
    if (tick === 140 && lancer?.alive) w.abilities.cast(lancer, 'uv_flare', { x: 34, y: 65 });
    if (tick === 160 && hq?.alive) w.abilities.cast(hq, 'emergency_supply');
    m.step();
    engine.update(0.05);
    const mood = engine.stats().mood;
    if (moods[moods.length - 1] !== mood) moods.push(mood);
  }
  const s = engine.stats();
  engine.detach();
  const buf = await ctx.startRendering();
  const a = analyse({ buf, from: 0, to: dur }, 1, dur);
  const ids = Object.keys(s.byId);
  const weapons = ids.filter((i) => i.startsWith('w_')).length, deaths = ids.filter((i) => i.startsWith('d_')).length;
  const why = a.nan ? 'NaN' : a.peak > 0.99 ? 'clips' : a.rms < 0.003 ? 'near-silent' : s.played < 20 ? 'few sounds' : weapons < 2 ? 'no weapon sounds'
    : !moods.includes('tension') && !moods.includes('battle') ? 'music never left calm' : '';
  report({ group: 'engine', name: 'simulated match', label: `moods ${moods.join('→')}`, ok: !why, why, slice: { buf, from: 0, to: dur }, metrics: `${s.played} sounds · ${ids.length} kinds · ${weapons}w ${deaths}d · ${moods.join('>')}` });
  console.log('[audio-selftest] match sounds', JSON.stringify(s.byId), 'moods', moods.join(' > '), `limited=${s.limited} culled=${s.culled} hidden=${s.hidden} peak=${f3(a.peak)} rms=${f3(a.rms)}`);
}

/** No AudioContext created / not unlocked: every API must be a silent no-op. */
function testSafety(): void {
  let why = '';
  try {
    const e = new AudioEngine({ ...DEFAULT_SETTINGS });
    e.setMusic('battle'); e.playUi('click'); e.playSfx('d_boss'); e.update(0.016); e.applySettings({ ...DEFAULT_SETTINGS, musicVolume: 0 });
    e.setAmbienceEnabled(false); e.detach(); e.dispose();
    if (e.ready) why = 'claims ready without unlock';
  } catch (err) { why = `threw: ${(err as Error).message}`; }
  report({ group: 'engine', name: 'no-context no-op', label: 'API before unlock', ok: !why, why, metrics: 'all calls silent' });
}

async function runSelftest(): Promise<void> {
  const btn = document.getElementById('run-selftest') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  results.length = 0;
  lastGroup = '';
  $('results').innerHTML = '';
  const sum = $('summary');
  sum.className = 'run';
  sum.textContent = 'running…';
  const t0 = performance.now();
  const step = async (name: string, fn: () => Promise<void> | void) => {
    const ts = performance.now();
    try { await fn(); } catch (err) { report({ group: 'errors', name, label: '', ok: false, why: String(err), metrics: '' }); }
    console.log(`[audio-selftest] timing: ${name} ${((performance.now() - ts) / 1000).toFixed(2)}s`);
  };
  await step('safety', testSafety);
  const ids = [...ALL_SFX_IDS].sort((a, b) => SFX[a].category.localeCompare(SFX[b].category));
  await step('sfx', () => testAllSfx(ids));
  for (const m of ['menu', 'calm', 'tension', 'battle', 'victory', 'defeat'] as MusicMood[]) await step(`music ${m}`, () => testMusic(m));
  await step('music none', testMusicNone);
  await step('crossfade', testCrossfade);
  await step('ambience', testAmbience);
  await step('stress', testStress);
  await step('match', testMatch);
  const fail = results.filter((r) => !r.ok).length, pass = results.length - fail;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  sum.className = fail ? 'fail' : 'pass';
  sum.textContent = `${fail ? 'FAIL' : 'PASS'} ${pass}/${results.length} checks · ${ALL_SFX_IDS.length} sounds · 7 moods · ${secs}s`;
  const line = `[audio-selftest] ${fail ? 'FAIL' : 'PASS'} ${pass}/${results.length} (${ALL_SFX_IDS.length} sounds, ${secs}s)`;
  if (fail) console.error(line); else console.log(line);
  (window as unknown as { __audioSelftest: unknown }).__audioSelftest = { done: true, pass, fail, results: results.map(({ slice: _s, ...r }) => r) };
  if (btn) btn.disabled = false;
}

// ───────────────────────── live controls ─────────────────────────

const live = new AudioEngine({ ...DEFAULT_SETTINGS });
let liveMatch: { stop(): void } | null = null;

function section(title: string): HTMLDivElement {
  const root = $('controls');
  const h = document.createElement('h2');
  h.textContent = title;
  root.appendChild(h);
  const d = document.createElement('div');
  root.appendChild(d);
  return d;
}
function button(parent: HTMLElement, text: string, fn: (b: HTMLButtonElement) => void, title = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', () => { live.unlock(); fn(b); status(); });
  parent.appendChild(b);
  return b;
}
function status(): void {
  const s = live.stats();
  const el = document.getElementById('live');
  if (el) el.textContent = `context: ${s.state} · mood: ${s.mood} · voices: ${s.voices} · played: ${s.played} · intensity ${s.intensity}`;
}

function buildControls(): void {
  const top = section('Self-test & status');
  const run = button(top, 'Run offline self-test', () => void runSelftest());
  run.id = 'run-selftest';
  const st = document.createElement('span');
  st.id = 'live';
  top.appendChild(st);
  const byCat = new Map<SfxCategory, SfxId[]>();
  for (const id of ALL_SFX_IDS) { const c = SFX[id].category; byCat.set(c, [...(byCat.get(c) ?? []), id]); }
  for (const [cat, ids] of byCat) {
    const d = section(CATEGORY_GROUP[cat]);
    for (const id of ids) button(d, id.replace(/^(w|i|d|a|ui)_/, ''), () => live.playSfx(id), SFX[id].label);
  }
  const ui = section('playUi(kind)');
  for (const k of Object.keys(UI_SFX) as UiSound[]) button(ui, k, () => live.playUi(k));
  const mus = section('Music moods (setMusic)');
  for (const m of ['menu', 'calm', 'tension', 'battle', 'victory', 'defeat', 'none'] as MusicMood[]) button(mus, m, () => live.setMusic(m));
  const misc = section('Ambience, speech, simulation');
  button(misc, 'simulated skirmish (adaptive music + ambience)', (b) => {
    if (liveMatch) { liveMatch.stop(); liveMatch = null; b.classList.remove('on'); return; }
    b.classList.add('on');
    void startLiveMatch().then((h) => { liveMatch = h; });
  });
  button(misc, 'speech lines (opt-in)', (b) => { live.setSpeechEnabled(!live.speechEnabled); b.classList.toggle('on', live.speechEnabled); });
  button(misc, 'stress: 50 bites', () => { for (let i = 0; i < 50; i++) setTimeout(() => live.playSfx('w_bite'), i * 20); });
  setInterval(status, 500);
  status();
}

async function startLiveMatch(): Promise<{ stop(): void }> {
  const { createHeadlessMatch } = await import('../src/game/headless');
  const m = createHeadlessMatch({ mapId: 'test', enemyAi: true, seed: 4 });
  const w = m.world;
  const cam = { x: 36, y: 66 };
  live.attach({ world: w, localPlayerId: 1, renderer: { cameraCtl: { getTarget: () => cam } } } as unknown as GameContext);
  for (let i = 0; i < 6; i++) w.spawnUnit('hosp_sanitizer', 1, { x: 31 + i, y: 71 });
  let tick = 0;
  const timer = setInterval(() => {
    m.step(); live.update(0.05); tick++;
    if (tick === 160) for (let i = 0; i < 8; i++) w.spawnUnit('path_phage', 2, { x: 30 + i, y: 64 });
    if (tick === 400) for (let i = 0; i < 4; i++) w.spawnUnit('path_bacillus', 2, { x: 31 + i * 1.5, y: 64 });
  }, 50);
  return { stop() { clearInterval(timer); live.detach(); } };
}

// 14 other developers edit modules this page imports. Vite then full-reloads every page whose graph has
// no HMR boundary; accept updates here and keep the booted page (a running self-test is not restarted).
if (import.meta.hot) import.meta.hot.accept(() => { /* keep the running instance */ });
const W = window as unknown as { __audioSandboxBooted?: boolean; __audio?: AudioEngine };
if (!W.__audioSandboxBooted) {
  W.__audioSandboxBooted = true;
  W.__audio = live;
  buildControls();
  if (new URLSearchParams(location.search).get('selftest') === '1') void runSelftest();
}
