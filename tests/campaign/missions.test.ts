import { describe, expect, it } from 'vitest';
import { CAMPAIGN, createMission } from '../../src/campaign';
import { createTestMap } from '../../src/map/testMap';
import { createWorld } from '../../src/sim/setup';
import { M1_HINTS, M1_LINES, M1_TUNING, M1_WAVE_GATES, M1_WAVES } from '../../src/campaign/missions/m1';
import { M2_HINTS, M2_LINES, M2_TUNING } from '../../src/campaign/missions/m2';
import { M3_HINTS, M3_LINES, M3_TUNING, type StrainOmega } from '../../src/campaign/missions/m3';
import { MAX_LINE_LENGTH, regionCenter, scaleComposition, type MissionScript, type ScriptedMission } from '../../src/campaign/script';
import type { DialogueLine } from '../../src/core/ui';
import { dist } from '../../src/core/math';
import type { Difficulty } from '../../src/core/types';
import { createHeadlessMatch, type HeadlessMatch } from '../../src/game/headless';
import { fingerprint, hasMeilahti, killAll, RecordingCamera, RecordingUi } from './helpers';

/** Long scenarios (10-minute runs, late raids, m3 determinism) only with SLOW=1 — keeps the default suite fast. */
const SLOW = process.env.SLOW === '1';
const SMOKE_SECONDS = SLOW ? 600 : 90;

interface Run { m: HeadlessMatch; s: MissionScript; mission: ScriptedMission }
function start(missionId: string, opts: { mapId?: string; seed?: number; difficulty?: Difficulty } = {}): Run {
  const m = createHeadlessMatch({ mode: 'campaign', missionId, mapId: opts.mapId ?? 'test', seed: opts.seed ?? 7, difficulty: opts.difficulty ?? 'normal' });
  const mission = m.mission as unknown as ScriptedMission;
  return { m, s: mission.script, mission };
}
/** Run until `t` mission seconds (stops early on game over). */
const runTo = (r: Run, t: number): void => r.m.runFor(Math.max(0, t - r.s.time));
/** Step until `pred()` holds (max `limit` seconds); returns whether it did. */
function waitFor(r: Run, pred: () => boolean, limit = 40): boolean {
  const n = Math.round(limit / r.m.world.dt);
  for (let i = 0; i < n; i++) { if (pred()) return true; r.m.step(); }
  return pred();
}
const gameOver = (r: Run) => (): boolean => r.m.world.rules.gameOver;
const protect = (r: Run, ...defIds: string[]): void => {
  for (const e of r.m.world.entitiesOf(1, (x) => defIds.includes(x.defId))) e.invulnerable = true;
};

// ─────────────────────────────── content ───────────────────────────────

/** Every dialogue line / hint string reachable from a LINES/HINTS table (functions are sampled). */
function collectTexts(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'function') collectTexts((v as (a: unknown) => unknown)(20), out), collectTexts((v as (a: unknown) => unknown)('wave_spawn_west'), out);
  else if (Array.isArray(v)) for (const x of v) collectTexts(x, out);
  else if (v && typeof v === 'object') {
    if ('text' in v && 'speaker' in v) out.push((v as DialogueLine).text);
    else for (const x of Object.values(v)) collectTexts(x, out);
  }
  return out;
}

describe('campaign content', () => {
  it('lists three missions with titles, subtitles, briefings and objective previews', () => {
    expect(CAMPAIGN.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(CAMPAIGN.map((m) => m.title)).toEqual(['Patient Zero', 'Containment Breach', 'Strain Omega']);
    for (const m of CAMPAIGN) {
      expect(m.mapId).toBe('meilahti');
      expect(m.subtitle).toMatch(/^Mission \d$/);
      expect(m.briefing.length).toBeGreaterThanOrEqual(2);
      expect(m.briefing.length).toBeLessThanOrEqual(4);
      expect(m.objectivesPreview.length).toBeGreaterThan(1);
    }
    expect(CAMPAIGN.map((m) => m.order)).toEqual([1, 2, 3]);
  });

  it(`keeps every dialogue line and hint within ${MAX_LINE_LENGTH} characters`, () => {
    const texts = collectTexts([M1_LINES, M1_HINTS, M2_LINES, M2_HINTS, M3_LINES, M3_HINTS]);
    expect(texts.length).toBeGreaterThan(80);
    for (const t of texts) expect(t.length, t).toBeLessThanOrEqual(MAX_LINE_LENGTH);
    for (const t of texts) expect(t.trim().length).toBeGreaterThan(5);
  });
});

// ─────────────────────────────── 10-minute smoke runs ───────────────────────────────

describe.each(['test', 'meilahti'])(`${SMOKE_SECONDS / 60} simulated minutes on map "%s"`, (mapId) => {
  it.skipIf(mapId === 'meilahti' && !hasMeilahti()).each(['m1', 'm2', 'm3'])('%s runs without errors', (missionId) => {
    const r = start(missionId, { mapId, seed: 3 });
    const w = r.m.world;
    expect(w.rules.autoDefeat).toBe(false);
    expect(w.entitiesOf(1, (e) => e.defId === 'hosp_hq').length).toBe(1);
    expect(w.entitiesOf(2, (e) => e.defId === 'path_hive').length).toBeGreaterThanOrEqual(1);
    expect(r.mission.objectives().length).toBeGreaterThan(0);
    // keep the loss conditions out of the way so all scripted beats of the first 10 minutes play
    protect(r, 'hosp_hq', 'obj_childrens_hospital');
    const p = w.player(1);
    r.m.runFor(1);
    expect(p.popCap - p.popUsed, 'free beds at the start').toBeGreaterThanOrEqual(missionId === 'm1' ? 0 : 10);
    r.m.runFor(SMOKE_SECONDS - 1);
    expect(r.s.errors).toBe(0);
    expect(w.rules.gameOver).toBe(false);
    expect(r.s.time).toBeGreaterThanOrEqual(SMOKE_SECONDS - 0.1);
    expect(r.s.dialogue.history.length).toBeGreaterThan(2);
    expect(r.mission.state).toBe('running');
  });
});

// ─────────────────────────────── Mission 1 ───────────────────────────────

describe('M1 Patient Zero', () => {
  it('starts per design: Central Hospital, 6 Orderlies, 4 Sanitizers, 200 Supplies; enemy core with nests, pod, spitters', () => {
    const { m } = start('m1');
    const w = m.world;
    expect(w.countOf(1, 'hosp_hq')).toBe(1);
    expect(w.countOf(1, 'hosp_orderly')).toBe(6);
    expect(w.countOf(1, 'hosp_sanitizer')).toBe(4);
    expect(w.player(1).resources.matter).toBe(200);
    expect(w.countOf(2, 'path_hive')).toBe(1);
    expect(w.countOf(2, 'path_nest')).toBeGreaterThanOrEqual(2);
    expect(w.countOf(2, 'path_replicator')).toBe(1);
    expect(w.countOf(2, 'path_toxin_spitter')).toBe(2);
    expect(w.countOf(0, 'hosp_medic')).toBe(2); // Mäkelä's team waits, neutral
  });

  it('intro: the camera opens on the Infection Core, then pans back to the Central Hospital', () => {
    const world = createWorld(createTestMap(), [
      { id: 1, faction: 'hospital', team: 1, controller: 'human' },
      { id: 2, faction: 'pathogen', team: 2, controller: 'ai' },
    ], 7);
    const mission = createMission('m1', { world, playerId: 1, enemyId: 2, ai: null, difficulty: 'normal' });
    mission.setup();
    const cam = new RecordingCamera();
    mission.attach(new RecordingUi(), cam); // as Game does: before the first update
    for (let i = 0; i < 15 / world.dt; i++) { mission.update(world.dt); world.step(); }
    const core = world.entitiesOf(2, (e) => e.defId === 'path_hive')[0]!;
    const hq = world.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    expect(cam.cues[0]?.kind).toBe('lookAt');
    expect(dist(cam.cues[0]!.p!, core.pos)).toBeLessThan(1);
    const last = cam.cues.at(-1)!;
    expect(last.kind).toBe('panTo');
    expect(dist(last.p!, hq.pos)).toBeLessThan(1);
  });

  it('advances the objective chain as conditions are met', () => {
    const r = start('m1');
    const { m, s } = r;
    const w = m.world, O = s.objectives;
    protect(r, 'hosp_hq');
    m.runFor(1);
    expect(r.mission.objectives().map((o) => o.id)).toEqual(['gather']);
    w.player(1).resources.matter = M1_TUNING.gatherGoal; // "gathered"
    m.runFor(1);
    expect(O.isDone('gather')).toBe(true);
    expect(waitFor(r, () => O.isActive('build'), 5)).toBe(true);
    const hq = w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    expect(s.spawnBuilding('hosp_ward', 1, { x: hq.pos.x + 7, y: hq.pos.y })).toBeTruthy();
    const pharmacy = s.spawnBuilding('hosp_pharmacy', 1, { x: hq.pos.x, y: hq.pos.y - 8 })!;
    expect(pharmacy).toBeTruthy();
    m.runFor(1);
    expect(O.isDone('build')).toBe(true);
    expect(waitFor(r, () => O.isActive('train'), 5)).toBe(true);
    // train six Sanitizers for real
    w.player(1).resources.matter = 1000;
    for (let i = 0; i < 5; i++) w.issue({ type: 'train', playerId: 1, buildingId: pharmacy.id, defId: 'hosp_sanitizer' });
    m.runFor(18 * 5 + 2);
    w.issue({ type: 'train', playerId: 1, buildingId: pharmacy.id, defId: 'hosp_sanitizer' });
    runTo(r, M1_TUNING.waveTimes[0]! - 3);
    expect(O.isDone('train')).toBe(true);
    expect(O.isActive('wave')).toBe(true); // shown with its ETA before the wave arrives
    expect(O.get('wave')?.progress).toMatch(/arrives in/);
    runTo(r, M1_TUNING.waveTimes[0]! + 1);
    expect(s.countTagged('wave1')).toBeGreaterThan(0);
    killAll(w, (e) => e.scriptTags.has('wave1'));
    m.runFor(1);
    expect(O.isDone('wave')).toBe(true);
    expect(waitFor(r, () => O.isActive('core'), 5)).toBe(true);
    killAll(w, (e) => e.owner === 2 && e.defId === 'path_hive');
    expect(waitFor(r, gameOver(r))).toBe(true);
    expect(w.rules.winnerTeam).toBe(1);
    expect(r.mission.state).toBe('won');
    expect(O.isDone('core')).toBe(true);
    expect(s.errors).toBe(0);
  });

  it('spawns the scripted waves at 2:30 / 5:00 / 7:30 from the north and east gates, scaled by difficulty', () => {
    for (const difficulty of SLOW ? (['normal', 'easy', 'hard'] as const) : (['normal'] as const)) {
      const r = start('m1', { difficulty, seed: 11 });
      protect(r, 'hosp_hq');
      M1_TUNING.waveTimes.forEach((t, i) => {
        runTo(r, t - 0.5);
        expect(r.s.countTagged(`wave${i + 1}`), `wave ${i + 1} too early`).toBe(0);
        runTo(r, t + 0.3);
        const units = r.s.tagged(`wave${i + 1}`);
        const expected = M1_WAVES[i]!.reduce((n, c) => n + Object.values(scaleComposition(c, difficulty)).reduce((a, b) => a + b, 0), 0);
        expect(units.length, `wave ${i + 1} size (${difficulty})`).toBe(expected);
        expect(units.every((u) => u.owner === 2)).toBe(true);
        const gates = M1_WAVE_GATES[i]!.map((g) => r.s.refs.point(g));
        for (const u of units) expect(Math.min(...gates.map((g) => dist(g, u.pos)))).toBeLessThan(9);
      });
      expect(r.s.errors).toBe(0);
    }
  });

  it('rescues Lt. Mäkelä\'s team when a hospital unit reaches the paramedic station', () => {
    const r = start('m1');
    const { m, s } = r;
    const w = m.world;
    m.runFor(1);
    const before = w.countOf(1, 'hosp_medic') + w.countOf(1, 'hosp_sanitizer');
    s.spawnUnits('hosp_orderly', 1, 1, regionCenter(s.refs.region('paramedic_station')));
    m.runFor(1);
    expect(s.objectives.isDone('rescue')).toBe(true);
    m.runFor(0.2);
    expect(w.countOf(0, 'hosp_medic') + w.countOf(0, 'hosp_sanitizer')).toBe(0);
    expect(w.countOf(1, 'hosp_medic') + w.countOf(1, 'hosp_sanitizer')).toBe(before + 5);
    expect(s.tagged('makela_team', 1).length).toBe(5);
    expect(waitFor(r, () => s.dialogue.history.some((h) => h.line.portrait === 'paramedic'), 20)).toBe(true);
  });

  it('losing the Central Hospital is a defeat', () => {
    const r = start('m1');
    const { m, mission } = r;
    m.runFor(2);
    killAll(m.world, (e) => e.defId === 'hosp_hq');
    m.runFor(1);
    expect(mission.state).toBe('lost');
    expect(waitFor(r, gameOver(r))).toBe(true);
    expect(m.world.rules.winnerTeam).toBe(2);
    expect(mission.state).toBe('lost');
  });

  it('destroying every Infection Core is a victory', () => {
    const r = start('m1');
    const { m, mission } = r;
    m.runFor(2);
    expect(killAll(m.world, (e) => e.defId === 'path_hive')).toBe(1);
    m.runFor(1);
    expect(mission.state).toBe('won');
    expect(waitFor(r, gameOver(r))).toBe(true);
    expect(m.world.rules.winnerTeam).toBe(1);
  });
});

// ─────────────────────────────── Mission 2 ───────────────────────────────

describe('M2 Containment Breach', () => {
  it('runs a difficulty-scaled contamination countdown; expiry is a defeat', () => {
    const r = start('m2');
    const { m, s } = r;
    expect(s.timer?.total).toBe(M2_TUNING.timer.normal);
    expect(start('m2', { difficulty: 'easy' }).s.timer?.total).toBe(M2_TUNING.timer.easy);
    m.runFor(5);
    expect(s.timer!.remaining).toBeCloseTo(M2_TUNING.timer.normal - 5, 0);
    s.timer!.setRemaining(2);
    m.runFor(2.5);
    expect(r.mission.state).toBe('lost');
    expect(s.endReason).toMatch(/Contamination/);
    expect(waitFor(r, gameOver(r))).toBe(true);
    expect(m.world.rules.winnerTeam).toBe(2);
  });

  it('shields the main core until both satellites fall, then the main core wins it', () => {
    const r = start('m2');
    const { m, s } = r;
    const w = m.world;
    const main = s.firstTagged('main_core')!;
    expect(main.invulnerable).toBe(true);
    expect(s.countTagged('satellite')).toBe(2);
    const east = s.firstTagged('sat_east')!, west = s.firstTagged('sat_west')!;
    expect(dist(east.pos, west.pos)).toBeGreaterThan(10);
    expect(s.firstTagged('lab')?.owner).toBe(1);
    m.runFor(2);
    w.killEntity(east, null);
    m.runFor(1);
    expect(s.objectives.isDone('east')).toBe(true);
    expect(main.invulnerable).toBe(true);
    w.killEntity(west, null);
    m.runFor(1);
    expect(main.invulnerable).toBe(false);
    expect(r.mission.state).toBe('running');
    w.killEntity(main, null);
    m.runFor(1);
    expect(r.mission.state).toBe('won');
    expect(s.objectives.isDone('lab')).toBe(true); // lab still standing → bonus
    expect(waitFor(r, gameOver(r))).toBe(true);
    expect(w.rules.winnerTeam).toBe(1);
  });

  it('fails the bonus when the Research Lab dies', () => {
    const { m, s } = start('m2');
    m.runFor(2);
    m.world.killEntity(s.firstTagged('lab')!, null);
    m.runFor(1);
    expect(s.objectives.isFailed('lab')).toBe(true);
    expect(s.state).toBe('running');
  });

  it.skipIf(!SLOW)('[slow] raids the Research Lab on schedule', () => {
    const { m, s } = start('m2');
    const lab = s.firstTagged('lab')!;
    // an idle player gets overrun by the real AI before the raid is due — keep the lab and HQ standing
    lab.invulnerable = true;
    for (const e of m.world.entitiesOf(1, (x) => x.defId === 'hosp_hq')) e.invulnerable = true;
    runTo({ m, s, mission: m.mission as unknown as ScriptedMission }, M2_TUNING.labRaids.normal[0]! + 0.5);
    expect(s.countTagged('lab_raid')).toBeGreaterThan(0);
    lab.invulnerable = false;
    m.world.killEntity(lab, null);
    m.runFor(1);
    expect(s.objectives.isFailed('lab')).toBe(true);
    expect(s.state).toBe('running');
  });
});

// ─────────────────────────────── Mission 3 ───────────────────────────────

describe('M3 Strain Omega', () => {
  it('places the Children\'s Hospital for the player and Strain Omega emerges on time', () => {
    const r = start('m3');
    const { s } = r;
    const ch = s.firstTagged('childrens')!;
    expect(ch.defId).toBe('obj_childrens_hospital');
    expect(ch.owner).toBe(1);
    protect(r, 'hosp_hq', 'obj_childrens_hospital');
    runTo(r, M3_TUNING.omegaAt - 1);
    expect(s.countTagged('boss')).toBe(0);
    expect(s.objectives.isHidden('omega')).toBe(true);
    runTo(r, M3_TUNING.omegaAt + 0.5);
    const boss = s.tagged('boss');
    expect(boss.length).toBe(1);
    expect(boss[0]!.defId).toBe('path_strain_omega');
    expect(dist(boss[0]!.pos, s.refs.point('omega_spawn'))).toBeLessThan(6);
    expect(s.countTagged('omega_escort')).toBeGreaterThan(5);
    expect(s.objectives.isActive('omega')).toBe(true);
    expect((r.mission as unknown as StrainOmega).boss).toBe(boss[0]);
    r.m.runFor(3);
    expect(boss[0]!.orders[0]?.type === 'attackMove' || boss[0]!.orders[0]?.type === 'attack').toBe(true);
  });

  it('losing the Children\'s Hospital is a defeat', () => {
    const r = start('m3');
    const { m, s, mission } = r;
    m.runFor(2);
    m.world.killEntity(s.firstTagged('childrens')!, null);
    m.runFor(1);
    expect(mission.state).toBe('lost');
    expect(waitFor(r, gameOver(r))).toBe(true);
    expect(m.world.rules.winnerTeam).toBe(2);
  });

  it('destroying the core early wakes Omega at once; killing both wins', () => {
    const r = start('m3');
    const { m, s, mission } = r;
    m.runFor(5);
    killAll(m.world, (e) => e.defId === 'path_hive');
    m.runFor(1);
    expect(s.objectives.isDone('core')).toBe(true);
    expect(s.countTagged('boss')).toBe(1);
    expect(mission.state).toBe('running');
    killAll(m.world, (e) => e.scriptTags.has('boss'));
    m.runFor(1);
    expect(mission.state).toBe('won');
    expect(waitFor(r, gameOver(r))).toBe(true);
    expect(m.world.rules.winnerTeam).toBe(1);
  });
});

// ─────────────────────────────── determinism ───────────────────────────────

describe('determinism', () => {
  it.each(SLOW ? ['m1', 'm3'] : ['m1'])('%s replays identically for a fixed seed', (missionId) => {
    const until = missionId === 'm3' ? M3_TUNING.omegaAt + 40 : M1_TUNING.waveTimes[0]! + 20;
    const a = start(missionId, { seed: 1234 });
    const b = start(missionId, { seed: 1234 });
    for (const r of [a, b]) { protect(r, 'hosp_hq', 'obj_childrens_hospital'); runTo(r, until); }
    expect(fingerprint(a.m.world)).toBe(fingerprint(b.m.world));
    expect(a.s.dialogue.history.map((h) => h.line.text)).toEqual(b.s.dialogue.history.map((h) => h.line.text));
    expect(a.s.hintLog).toEqual(b.s.hintLog);
  });
});
