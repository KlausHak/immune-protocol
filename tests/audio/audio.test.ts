import { describe, expect, it } from 'vitest';
import { AudioEngine, deathSound } from '../../src/audio/AudioEngine';
import { MoodDirector } from '../../src/audio/mood';
import { MUSIC_MOODS, skipAhead } from '../../src/audio/music';
import { SFX, SFX_IDS, UI_SFX, WEAPON_FIRE_SFX, WEAPON_IMPACT_SFX } from '../../src/audio/sfx';
import { panForDirection, spatialize, type Listener } from '../../src/audio/spatial';
import { CROWD_WINDOW, crowdGain, VoicePolicy, type VoiceSlot } from '../../src/audio/voices';
import type { WeaponVfx } from '../../src/core/types';
import { UNITS } from '../../src/data/units';
import { BUILDINGS } from '../../src/data/buildings';
import type { GameContext } from '../../src/game/contracts';
import { createHeadlessMatch } from '../../src/game/headless';
import { DEFAULT_SETTINGS } from '../../src/game/settings';

const L: Listener = { x: 50, y: 50, rx: 1, ry: 0, zoom: 1 };

describe('audio: spatialisation', () => {
  it('is full volume and centred at the camera target', () => {
    const s = spatialize(L, { x: 50, y: 50 });
    expect(s.gain).toBeGreaterThan(0.9);
    expect(s.pan).toBe(0);
  });
  it('pans with the screen-right vector and attenuates with distance', () => {
    expect(spatialize(L, { x: 60, y: 50 }).pan).toBeGreaterThan(0.3);
    expect(spatialize(L, { x: 40, y: 50 }).pan).toBeLessThan(-0.3);
    const rotated: Listener = { ...L, rx: 0, ry: -1 }; // camera yawed 90°: screen right = −y
    expect(spatialize(rotated, { x: 50, y: 40 }).pan).toBeGreaterThan(0.3);
    const near = spatialize(L, { x: 55, y: 50 }).gain, mid = spatialize(L, { x: 75, y: 50 }).gain, far = spatialize(L, { x: 120, y: 50 }).gain;
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBe(0);
    for (let d = 0; d < 80; d += 3) {
      const s = spatialize(L, { x: 50 + d, y: 50 });
      expect(Math.abs(s.pan)).toBeLessThanOrEqual(1);
      expect(s.gain).toBeGreaterThanOrEqual(0);
    }
  });
  it('zooming out widens the audible area', () => {
    expect(spatialize({ ...L, zoom: 2 }, { x: 95, y: 50 }).gain).toBeGreaterThan(spatialize(L, { x: 95, y: 50 }).gain);
  });
  it('direction pan helper', () => {
    expect(panForDirection(L, -1, 0)).toBeLessThan(0);
    expect(panForDirection(L, 0, 0)).toBe(0);
  });
});

describe('audio: combat-intensity mood director', () => {
  it('calm → tension on threat, → battle on heavy combat, then steps down through tension to calm', () => {
    const d = new MoodDirector();
    expect(d.update(0.1)).toBe('calm');
    d.setThreat(3);
    expect(d.update(0.1)).toBe('tension');
    for (let i = 0; i < 40; i++) { d.addCombat(0.3); d.update(0.1); } // a big fight
    expect(d.mood).toBe('battle');
    d.setThreat(0);
    const seen: string[] = [];
    for (let i = 0; i < 900; i++) { const m = d.update(0.1); if (seen[seen.length - 1] !== m) seen.push(m); }
    expect(seen).toEqual(['battle', 'tension', 'calm']);
  });
  it('a single skirmish shot does not trigger battle; hysteresis prevents flapping', () => {
    const d = new MoodDirector();
    d.addCombat(0.08);
    expect(d.update(0.1)).toBe('calm');
    d.addCombat(0.5);
    expect(d.update(0.1)).toBe('tension');
    let changes = 0, last = d.mood;
    for (let i = 0; i < 200; i++) { if (i % 10 === 0) d.addCombat(0.1); const m = d.update(0.1); if (m !== last) { changes++; last = m; } }
    expect(changes).toBe(0);
  });
});

describe('audio: voice policy (rate + voice limiting)', () => {
  const lim = { voices: 3, interval: 0.06 };
  const slot = (id: string, start: number, end: number, level = 1, bus = 'sfx', priority = 1): VoiceSlot => ({ id, bus, start, end, level, priority });

  it('50 simultaneous bites become a handful of voices', () => {
    const p = new VoicePolicy<VoiceSlot>(40);
    let admitted = 0;
    for (let i = 0; i < 50; i++) {
      const when = i * 0.02; // 50 bites within one second
      p.reap(when);
      const a = p.admit('bite', 'sfx', when, 0.3, 0, lim);
      if (a.ok) { admitted++; for (const s of a.steal) s.end = when; p.add(slot('bite', when, when + 0.05, 0.3)); }
    }
    expect(admitted).toBeLessThanOrEqual(17); // ≥ 0.06 s spacing → ≤ ~17/s
    expect(admitted).toBeGreaterThan(5);
    expect(p.count('bite', 0.5)).toBeLessThanOrEqual(3);
  });

  it('enforces the minimum interval and reports crowding', () => {
    const p = new VoicePolicy<VoiceSlot>(40);
    expect(p.admit('a', 'sfx', 1, 1, 1, lim).ok).toBe(true);
    expect(p.admit('a', 'sfx', 1.03, 1, 1, lim).ok).toBe(false);
    const b = p.admit('a', 'sfx', 1.1, 1, 1, lim);
    expect(b.ok).toBe(true);
    expect(b.crowd).toBe(1);
    expect(p.admit('a', 'sfx', 1.1 + CROWD_WINDOW + 0.2, 1, 1, lim).crowd).toBe(0);
    expect(crowdGain(0)).toBe(1);
    expect(crowdGain(5)).toBeLessThan(0.5);
  });

  it('steals the weakest voice when the per-sound cap is reached, rejects much quieter newcomers', () => {
    const p = new VoicePolicy<VoiceSlot>(40);
    for (let i = 0; i < 3; i++) p.add(slot('x', 0, 5, 0.5 + i * 0.1));
    const loud = p.admit('x', 'sfx', 1, 0.9, 1, lim);
    expect(loud.ok).toBe(true);
    expect(loud.steal.length).toBe(1);
    expect(loud.steal[0]!.level).toBeCloseTo(0.5);
    expect(p.admit('x', 'sfx', 2, 0.05, 1, lim).ok).toBe(false);
  });

  it('global cap keeps high-priority sounds', () => {
    const p = new VoicePolicy<VoiceSlot>(4);
    for (let i = 0; i < 4; i++) p.add(slot(`s${i}`, 0, 5, 0.5, 'sfx', 0));
    expect(p.admit('boom', 'sfx', 1, 0.5, 3, lim).steal.length).toBe(1);
    expect(p.admit('tick', 'sfx', 1, 0.1, 0, lim).ok).toBe(false);
    expect(p.admit('ui', 'ui', 1, 0.1, 0, lim).ok).toBe(true); // UI is exempt from the world cap
    expect(p.reap(10).length).toBe(4);
  });
});

describe('audio: catalogue and event mapping', () => {
  it('every WeaponVfx used by the data has a fire sound; projectile weapons have impacts', () => {
    const weapons = [...UNITS.flatMap((u) => u.weapons), ...BUILDINGS.flatMap((b) => b.weapons)];
    expect(weapons.length).toBeGreaterThan(5);
    for (const w of weapons) {
      expect(SFX[WEAPON_FIRE_SFX[w.vfx]], w.vfx).toBeTruthy();
      if (w.projectileSpeed) expect(WEAPON_IMPACT_SFX[w.vfx as WeaponVfx], `impact for ${w.vfx}`).toBeTruthy();
    }
  });
  it('every sound has sane limits and every UI kind maps to a UI sound', () => {
    for (const id of SFX_IDS) {
      const s = SFX[id];
      expect(s.voices, id).toBeGreaterThanOrEqual(1);
      expect(s.interval, id).toBeGreaterThan(0);
      expect(s.gain, id).toBeGreaterThan(0);
      expect(s.gain, id).toBeLessThanOrEqual(1);
    }
    for (const id of Object.values(UI_SFX)) expect(SFX[id].bus).toBe('ui');
    expect(MUSIC_MOODS).toContain('battle');
  });
  it('death sounds: pathogens splat by size, mechs explode, staff evacuate, buildings collapse', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: false, seed: 2 });
    const w = m.world;
    const at = { x: 48, y: 48 };
    expect(deathSound(w.spawnUnit('path_phage', 2, at))!.id).toBe('d_pathogen_small');
    expect(deathSound(w.spawnUnit('path_superbug', 2, at))!.id).toBe('d_pathogen_large');
    expect(deathSound(w.spawnUnit('path_strain_omega', 2, at))!.id).toBe('d_boss');
    expect(deathSound(w.spawnUnit('hosp_orderly', 1, at))!.id).toBe('d_mech_small');
    expect(deathSound(w.spawnUnit('hosp_macrophage', 1, at))!.id).toBe('d_mech_large');
    expect(deathSound(w.spawnUnit('hosp_sanitizer', 1, at))!.id).toBe('d_staff');
    const hq = w.entitiesOf(1, (e) => e.kind === 'building')[0]!;
    expect(deathSound(hq)!.id).toBe('d_building_hospital');
    expect(deathSound(w.list.find((e) => e.kind === 'resource')!)).toBeNull();
  });
  it('lookahead scheduler skips missed steps instead of bursting them', () => {
    expect(skipAhead(10, 10, 0.1)).toBe(0);
    expect(skipAhead(10, 10.01, 0.1)).toBe(0); // within tolerance
    expect(skipAhead(10, 12.05, 0.1)).toBe(21); // a throttled ~2 s gap
    expect(skipAhead(10, 12, 0)).toBe(0);
  });
});

describe('audio: engine is a silent no-op without Web Audio (Node)', () => {
  it('survives a whole match lifecycle with no AudioContext', () => {
    const m = createHeadlessMatch({ mapId: 'test', seed: 5 });
    const engine = new AudioEngine({ ...DEFAULT_SETTINGS });
    engine.setMusic('menu');
    engine.playUi('click');
    engine.unlock(); // no window/AudioContext in Node → stays silent
    expect(engine.ready).toBe(false);
    const fake = { world: m.world, localPlayerId: 1, renderer: { cameraCtl: { getTarget: () => ({ x: 20, y: 76 }) } } } as unknown as GameContext;
    engine.attach(fake);
    const w = m.world;
    // provoke a fight near the player's base so combat events flow through the handlers
    for (let i = 0; i < 4; i++) w.spawnUnit('hosp_sanitizer', 1, { x: 30 + i, y: 70 });
    for (let i = 0; i < 4; i++) w.spawnUnit('path_bacillus', 2, { x: 30 + i, y: 66 });
    for (let i = 0; i < 400; i++) { m.step(); engine.update(0.05); }
    engine.playSfx('w_spray', { pos: { x: 30, y: 70 } });
    engine.applySettings({ ...DEFAULT_SETTINGS, masterVolume: 0.2 });
    engine.setMusic('battle');
    engine.setSpeechEnabled(false);
    w.endGame(1, 'test');
    engine.detach();
    engine.update(0.05);
    engine.dispose();
    const s = engine.stats();
    expect(s.state).toBe('none');
    expect(s.played).toBe(0);
  });
});
