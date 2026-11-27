/**
 * Mission save/restore: the restored script must continue exactly like the original (objectives, dialogue,
 * hints, timer, waves) without spawning anything. World-level determinism is covered by tests/save.
 */
import { describe, expect, it } from 'vitest';
import type { ScriptedMission } from '../../src/campaign/script';
import { createHeadlessMatch, loadHeadlessMatch, saveHeadlessMatch, type HeadlessMatch } from '../../src/game/headless';
import type { SaveGame } from '../../src/sim/save';
import { M1_TUNING } from '../../src/campaign/missions/m1';
import { M3_TUNING } from '../../src/campaign/missions/m3';
import { fingerprint, RecordingUi } from './helpers';

const SLOW = process.env.SLOW === '1';
const script = (m: HeadlessMatch) => (m.mission as unknown as ScriptedMission).script;
const roundTrip = (s: SaveGame): SaveGame => JSON.parse(JSON.stringify(s)) as SaveGame;

function scriptView(m: HeadlessMatch) {
  const s = script(m);
  return {
    objectives: m.mission!.objectives(),
    dialogue: s.dialogue.history.map((h) => `${h.time.toFixed(2)} ${h.line.text}`),
    hints: s.hintLog.map((h) => `${h.time.toFixed(2)} ${h.text}`),
    timer: s.timer ? [s.timer.label, s.timer.remaining.toFixed(3)] : null,
    waves: s.waves.map((w) => `${w.name}:${w.ids.join(',')}`),
    state: s.state,
  };
}

function check(missionId: string, saveAt: number, after: number, prep?: (m: HeadlessMatch) => void): void {
  const a = createHeadlessMatch({ mode: 'campaign', missionId, mapId: 'test', seed: 9 });
  prep?.(a);
  a.runFor(saveAt - a.world.time); // save at absolute mission time `saveAt`
  const save = roundTrip(saveHeadlessMatch(a, `t-${missionId}`));
  const b = loadHeadlessMatch(save);
  expect(b.world.list.length, 'restore must not spawn').toBe(a.world.list.length);
  expect(scriptView(b)).toEqual(scriptView(a));
  for (let i = 0; i < Math.round(after / a.world.dt); i++) { a.step(); b.step(); }
  expect(fingerprint(b.world)).toBe(fingerprint(a.world));
  expect(scriptView(b)).toEqual(scriptView(a));
  expect(script(b).errors).toBe(0);
}

describe('mission save/restore', () => {
  it('m1: a save with wave 1 on the march and a pending objective reveal continues identically', () => {
    check('m1', M1_TUNING.waveTimes[0]! + 1, 40, (m) => {
      for (const e of m.world.entitiesOf(1, (x) => x.defId === 'hosp_hq')) e.invulnerable = true;
      // gather objective completes at ~150.5 s → its 'revealBuild' action is still pending at save time
      m.runFor(M1_TUNING.waveTimes[0]! - 0.5);
      m.world.player(1).resources.matter = M1_TUNING.gatherGoal;
    });
  });

  it('m2: the contamination countdown and shield state survive a save', () => {
    check('m2', 30, 30);
  });

  it('attach(…, { restored }) re-shows objectives and timer without replaying the intro', () => {
    const a = createHeadlessMatch({ mode: 'campaign', missionId: 'm2', mapId: 'test', seed: 9 });
    a.runFor(60);
    const b = loadHeadlessMatch(roundTrip(saveHeadlessMatch(a)));
    const ui = new RecordingUi();
    b.mission!.attach(ui, null, { restored: true });
    b.step();
    expect(ui.lastObjectives).toEqual(a.mission!.objectives());
    expect(ui.timers.at(-1)?.label).toBe('Contamination');
    expect(ui.dialogue.length).toBe(0); // intro lines already seen
  });

  it.skipIf(!SLOW)('[slow] m3: a save after Strain Omega emerged continues identically', () => {
    check('m3', M3_TUNING.omegaAt + 5, 40, (m) => {
      for (const e of m.world.entitiesOf(1, (x) => x.defId === 'hosp_hq' || x.defId === 'obj_childrens_hospital')) e.invulnerable = true;
    });
  });
});
