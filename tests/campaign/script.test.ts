import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissionContext } from '../../src/campaign';
import {
  byDifficulty, DialogueQueue, line, MissionScript, MissionTimer, ObjectiveManager, scaleComposition, scaleCount,
} from '../../src/campaign/script';
import type { Difficulty } from '../../src/core/types';
import { createTestMap } from '../../src/map/testMap';
import { createWorld } from '../../src/sim/setup';
import type { World } from '../../src/sim/World';
import { RecordingCamera, RecordingUi } from './helpers';

function makeWorld(seed = 1): World {
  return createWorld(createTestMap(), [
    { id: 1, faction: 'hospital', team: 1, controller: 'human' },
    { id: 2, faction: 'pathogen', team: 2, controller: 'ai' },
  ], seed);
}
function makeScript(difficulty: Difficulty = 'normal', world = makeWorld()): MissionScript {
  const ctx: MissionContext = { world, playerId: 1, enemyId: 2, ai: null, difficulty };
  const s = new MissionScript(ctx);
  s.begin();
  return s;
}
/** Mission update + world step, like Game.stepOnce (no AI). */
function run(s: MissionScript, seconds: number): void {
  const n = Math.round(seconds / s.world.dt);
  for (let i = 0; i < n; i++) { s.update(s.world.dt); s.world.step(); }
}

afterEach(() => { vi.restoreAllMocks(); });

describe('difficulty helpers', () => {
  it('scales counts and compositions, never dropping a unit type below 1', () => {
    expect(scaleCount(4, 'easy')).toBe(2);
    expect(scaleCount(4, 'normal')).toBe(4);
    expect(scaleCount(4, 'hard')).toBe(5);
    expect(scaleCount(1, 'easy')).toBe(1);
    expect(scaleCount(0, 'brutal')).toBe(0);
    expect(scaleComposition({ path_phage: 5, path_bacillus: 1 }, 'easy')).toEqual({ path_phage: 3, path_bacillus: 1 });
    expect(byDifficulty('brutal', { easy: 1, normal: 2, hard: 3 })).toBe(3);
    expect(byDifficulty('brutal', { easy: 1, normal: 2, hard: 3, brutal: 4 })).toBe(4);
  });
});

describe('TriggerEngine', () => {
  it('runs after / at / every / when on mission time', () => {
    const s = makeScript();
    const log: string[] = [];
    s.after(1, () => log.push(`after@${s.time.toFixed(2)}`));
    s.at(2.5, () => log.push(`at@${s.time.toFixed(2)}`));
    const ev = s.every(1, () => log.push(`every@${s.time.toFixed(2)}`), { times: 3 });
    let flag = false;
    s.after(3.2, () => { flag = true; });
    const w = s.when(() => flag, () => log.push(`when@${s.time.toFixed(2)}`));
    run(s, 5);
    expect(log).toEqual(['after@1.00', 'every@1.00', 'every@2.00', 'at@2.50', 'every@3.00', 'when@3.20']);
    expect(ev.active).toBe(false);
    expect(w.fired).toBe(1);
  });

  it('repeating when() honours cooldown; cancel() stops a trigger', () => {
    const s = makeScript();
    let n = 0, m = 0;
    s.when(() => true, () => n++, { repeat: true, cooldown: 1 });
    const t = s.every(0.5, () => m++);
    run(s, 2.06); // updates at t = 0 … 2.0
    expect(n).toBe(3); // t = 0, 1, 2
    t.cancel();
    run(s, 2);
    expect(m).toBe(4);
    expect(t.active).toBe(false);
  });

  it('defers event callbacks to the next mission update, filters, and supports once/repeat', () => {
    const s = makeScript();
    const w = s.world;
    const u = w.spawnUnit('path_phage', 2, { x: 50, y: 50 });
    const v = w.spawnUnit('path_phage', 2, { x: 52, y: 50 });
    u.scriptTags.add('pack'); v.scriptTags.add('pack');
    const deaths: number[] = [];
    let allDead = 0, once = 0;
    s.onDeath({ tag: 'pack' }, (e) => deaths.push(e.id), { repeat: true });
    s.onDeath(u, () => once++);
    s.onAllDead('pack', () => allDead++);
    run(s, 0.5);
    w.killEntity(u, null);
    expect(deaths).toEqual([]); // deferred: nothing ran inside the event
    s.update(w.dt);
    expect(deaths).toEqual([u.id]);
    expect(once).toBe(1);
    w.killEntity(v, null);
    run(s, 0.6);
    expect(deaths).toEqual([u.id, v.id]);
    expect(once).toBe(1);
    expect(allDead).toBe(1);
  });

  it('onAllDead waits until the tag has existed; onEnterRegion fires for the right owner only', () => {
    const s = makeScript();
    const w = s.world;
    let fired = 0, entered = 0;
    s.onAllDead('later', () => fired++);
    run(s, 1);
    expect(fired).toBe(0);
    const e = w.spawnUnit('path_phage', 2, { x: 30, y: 30 });
    e.scriptTags.add('later');
    run(s, 0.5);
    w.killEntity(e, null);
    run(s, 0.6);
    expect(fired).toBe(1);

    s.onEnterRegion({ x: 40, y: 40, w: 8, h: 8 }, 1, () => entered++);
    w.spawnUnit('path_phage', 2, { x: 44, y: 44 }); // enemy unit: ignored
    run(s, 0.6);
    expect(entered).toBe(0);
    w.spawnUnit('hosp_sanitizer', 1, { x: 44, y: 44 });
    run(s, 0.6);
    expect(entered).toBe(1);
  });

  it('counts (and survives) a throwing trigger', () => {
    const s = makeScript();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let after = 0;
    s.after(0.1, () => { throw new Error('boom'); });
    s.after(0.2, () => after++);
    run(s, 0.5);
    expect(after).toBe(1);
    expect(s.errors).toBe(1);
    expect(spy).toHaveBeenCalled();
  });
});

describe('ObjectiveManager', () => {
  it('tracks hidden → active → done/failed, progress, ordering and allPrimaryDone', () => {
    const o = new ObjectiveManager();
    o.add({ id: 'bonus', text: 'Bonus', primary: false });
    o.add({ id: 'a', text: 'A' });
    o.add({ id: 'b', text: 'B', hidden: true });
    expect(o.views().map((v) => v.id)).toEqual(['a', 'bonus']);
    const v0 = o.version;
    o.setProgress('b', '1/2'); // hidden: no visible change
    expect(o.version).toBe(v0);
    o.complete('a');
    expect(o.allPrimaryDone()).toBe(false); // hidden 'b' still pending
    o.reveal('b');
    o.setProgress('b', '2/2');
    expect(o.views().find((v) => v.id === 'b')).toMatchObject({ state: 'active', progress: '2/2', primary: true });
    o.complete('b');
    o.fail('bonus');
    expect(o.allPrimaryDone()).toBe(true);
    expect(o.views().map((v) => `${v.id}:${v.state}`)).toEqual(['a:done', 'b:done', 'bonus:failed']);
    expect(o.complete('bonus')).toBe(false); // failed stays failed
  });
});

describe('DialogueQueue', () => {
  it('paces lines one at a time with explicit durations, runs then() and drops expired barks', () => {
    const q = new DialogueQueue();
    const ui = new RecordingUi();
    q.ui = ui;
    const a = line('cmo', 'First line.'), b = line('sisu', 'Second line.'), c = line('engineer', 'Stale bark.');
    let done = 0;
    const eta = q.say([a, b], { then: () => done++ });
    const da = DialogueQueue.durationOf(a), db = DialogueQueue.durationOf(b);
    expect(eta).toBeCloseTo(da + db + 2 * DialogueQueue.GAP, 5);
    q.say(c, { expires: 1 });
    q.update(0);
    expect(ui.dialogue.map((l) => l.text)).toEqual(['First line.']);
    expect(ui.dialogue[0]!.duration).toBeCloseTo(da, 5);
    q.update(da + DialogueQueue.GAP + 0.01);
    expect(ui.dialogue.map((l) => l.text)).toEqual(['First line.', 'Second line.']);
    q.update(eta + 0.1);
    expect(done).toBe(1);
    expect(ui.dialogue.length).toBe(2); // the bark expired while waiting
    expect(q.busy).toBe(false);
  });

  it('urgent lines jump the queue', () => {
    const q = new DialogueQueue();
    q.say([line('cmo', 'one'), line('cmo', 'two')]);
    q.update(0);
    q.say(line('sisu', 'NOW'), { urgent: true });
    q.update(20);
    q.update(40);
    expect(q.history.map((h) => h.line.text)).toEqual(['one', 'NOW', 'two']);
  });
});

describe('MissionTimer', () => {
  it('counts down, fires cues once and expires; setRemaining skips passed cues', () => {
    const fired: string[] = [];
    const t = new MissionTimer('Test', 10, () => fired.push('expire'), [{ at: 5, fn: () => fired.push('5') }, { at: 2, fn: () => fired.push('2') }]);
    const safe = (_: string, fn: () => void) => fn();
    for (let i = 0; i < 60; i++) t.tick(0.1, safe);
    expect(fired).toEqual(['5']);
    t.setRemaining(1);
    for (let i = 0; i < 30; i++) t.tick(0.1, safe);
    expect(fired).toEqual(['5', 'expire']);
    expect(t.expired).toBe(true);
  });
});

describe('MapRefs', () => {
  it('returns real names, falls back sensibly (in bounds, warned once) for missing ones', () => {
    const s = makeScript();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(s.refs.point('player_start')).toEqual({ x: 20, y: 76 });
    expect(s.refs.region('player_base')).toEqual({ x: 8, y: 64, w: 24, h: 24 });
    const names = ['wave_spawn_north', 'wave_spawn_east', 'wave_spawn_west', 'omega_spawn', 'east_nest_core', 'west_nest_core', 'childrens_hospital_center', 'helipad'];
    const pts = names.map((n) => s.refs.point(n));
    for (const p of pts) {
      expect(p.x).toBeGreaterThan(2); expect(p.x).toBeLessThan(94);
      expect(p.y).toBeGreaterThan(2); expect(p.y).toBeLessThan(94);
    }
    expect(new Set(pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)).size).toBe(names.length);
    const st = s.refs.region('paramedic_station');
    expect(st.w).toBeGreaterThan(4);
    // aliases: point from region, region from point
    expect(s.refs.point('center')).toEqual({ x: 48, y: 48 });
    const enemyCore = s.refs.region('enemy_core');
    expect(enemyCore).toEqual({ x: 64, y: 8, w: 24, h: 24 }); // alias of the test map's enemy_base
    s.refs.point('wave_spawn_north');
    const warnedNorth = warn.mock.calls.filter((c) => String(c[0]).includes('"wave_spawn_north"')).length;
    expect(warnedNorth).toBeLessThanOrEqual(1);
  });
});

describe('MissionScript helpers', () => {
  it('spawns buildings on free, non-overlapping footprints and units on walkable ground', () => {
    const s = makeScript();
    const w = s.world;
    s.spawnMapResources();
    const blds = [0, 1, 2, 3, 4, 5].map(() => s.spawnBuilding('path_nest', 2, { x: 76, y: 20 }, { tags: ['t'] }));
    expect(blds.every((b) => !!b)).toBe(true);
    const rects = blds.map((b) => w.footRect(b!)!);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!, b = rects[j]!;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlap).toBe(false);
    }
    expect(s.countTagged('t')).toBe(6);
    const units = s.spawnUnits('hosp_sanitizer', 9, 1, { x: 22, y: 48 }, { tags: ['squad'] }); // centre of the pond
    expect(units.length).toBe(9);
    for (const u of units) expect(w.movement.isWalkable(u.pos)).toBe(true);
    expect(s.tagged('squad', 1).length).toBe(9);
  });

  it('sends difficulty-scaled waves without an AI, tags them and shepherds idle units back on target', () => {
    const s = makeScript('hard');
    const w = s.world;
    const hq = s.spawnBuilding('hosp_hq', 1, 'player_start', { exact: true, force: true })!;
    const units = s.sendWave({ path_phage: 4 }, 'wave_spawn_north', { name: 'w', tags: ['x'] });
    expect(units.length).toBe(5); // 4 × 1.35 → 5
    expect(units.every((u) => u.scriptTags.has('wave') && u.scriptTags.has('wave:w') && u.scriptTags.has('x'))).toBe(true);
    run(s, 0.2);
    expect(units.every((u) => u.orders[0]?.type === 'attackMove')).toBe(true);
    // stop them; the shepherd re-issues the march within ~1.5 s
    w.issue({ type: 'stop', playerId: 2, unitIds: units.map((u) => u.id) });
    run(s, 0.2);
    expect(units.some((u) => u.orders.length === 0)).toBe(true);
    run(s, 2);
    const t = units[0]!.orders[0];
    expect(t?.type).toBe('attackMove');
    if (t?.type === 'attackMove') expect(Math.hypot(t.target.x - hq.pos.x, t.target.y - hq.pos.y)).toBeLessThan(7); // group moves spread into a formation
  });

  it('pushes objectives, dialogue, notifications and the timer to the UI; ends via world.endGame', () => {
    const s = makeScript();
    const ui = new RecordingUi(), cam = new RecordingCamera();
    s.addObjective({ id: 'a', text: 'Do the thing' });
    s.attach(ui, cam);
    expect(ui.lastObjectives).toEqual([{ id: 'a', text: 'Do the thing', state: 'active', primary: true }]);
    s.say(line('sisu', 'Hello.'));
    s.startTimer('Clock', 3, null);
    s.panTo({ x: 10, y: 10 }, 1);
    s.hint('A hint', { id: 'h' });
    expect(s.hint('A hint again', { id: 'h' })).toBe(false);
    run(s, 0.1);
    expect(ui.dialogue[0]?.text).toBe('Hello.');
    expect(ui.timers.at(-1)).toEqual({ label: 'Clock', seconds: 3 });
    expect(cam.cues.at(-1)).toEqual({ kind: 'panTo', p: { x: 10, y: 10 } });
    expect(ui.notes.map((n) => n.text)).toEqual(['A hint']);
    s.completeObjective('a');
    run(s, 0.1);
    expect(ui.lastObjectives[0]?.state).toBe('done');
    expect(ui.notes.at(-1)?.kind).toBe('success');
    s.victory('test win', { delay: 1 });
    expect(s.state).toBe('won');
    expect(s.world.rules.gameOver).toBe(false); // end screen after the delay
    expect(ui.timers.at(-1)).toEqual({ label: null, seconds: undefined }); // timer hidden on finish
    run(s, 1.1);
    expect(s.world.rules.gameOver).toBe(true);
    expect(s.world.rules.winnerTeam).toBe(1);
    s.defeat('too late'); // ignored once decided
    expect(s.state).toBe('won');
  });

  it('defeat ends the game for the enemy team', () => {
    const s = makeScript();
    s.defeat('lost', { delay: 0 });
    expect(s.world.rules.gameOver).toBe(true);
    expect(s.world.rules.winnerTeam).toBe(2);
    expect(s.world.player(1).defeated).toBe(true);
  });
});
