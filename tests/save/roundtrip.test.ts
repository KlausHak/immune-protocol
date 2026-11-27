/**
 * Save/load round-trip determinism. A save is correct iff the restored match evolves EXACTLY like the original.
 * Each scenario plays a varied match (economy, construction, production, combat with live projectiles, AI),
 * saves mid-action, round-trips through JSON, then steps both copies and compares full state every tick.
 * On divergence the failure names the first differing field — the module owning that state is missing a save hook.
 */
import { describe, expect, it } from 'vitest';
import { createHeadlessMatch, loadHeadlessMatch, saveHeadlessMatch, type HeadlessMatch } from '../../src/game/headless';
import { decode, encode, firstDifference, stateHash, type SaveGame } from '../../src/sim/save';
import { findBuildSpot } from '../../src/sim/economy';

/** Deterministic scripted inputs for player 1 (tick → action). Uses only world.issue + test spawns. */
function script(m: HeadlessMatch): void {
  const w = m.world, t = w.tick, me = 1;
  const hq = w.entitiesOf(me, (e) => e.defId === 'hosp_hq')[0];
  const workers = w.entitiesOf(me, (e) => !!e.gatherer);
  if (t === 20 && hq) { w.issue({ type: 'train', playerId: me, buildingId: hq.id, defId: 'hosp_orderly' }); w.issue({ type: 'train', playerId: me, buildingId: hq.id, defId: 'hosp_orderly' }); }
  if (t === 200 && hq && workers[0]) {
    w.player(me).resources.matter += 400; // test grant so construction happens early
    const tile = findBuildSpot(w, me, 'hosp_ward', hq.pos);
    if (tile) w.issue({ type: 'build', playerId: me, unitIds: [workers[0].id], defId: 'hosp_ward', tile });
  }
  if (t === 400 && hq && workers[1]) {
    const tile = findBuildSpot(w, me, 'hosp_pharmacy', hq.pos);
    if (tile) w.issue({ type: 'build', playerId: me, unitIds: [workers[1].id], defId: 'hosp_pharmacy', tile });
  }
  if (t === 1400 && hq) {
    // a skirmish force with ranged, healer and artillery units, marching on the enemy start
    const ids: number[] = [];
    const defs = ['hosp_sanitizer', 'hosp_sanitizer', 'hosp_sanitizer', 'hosp_sanitizer', 'hosp_medic', 'hosp_uv_lancer', 'hosp_antibiotic_launcher', 'hosp_sterilizer_drone'];
    defs.forEach((d, i) => { const p = w.movement.nearestWalkable({ x: hq.pos.x + 4 + (i % 4), y: hq.pos.y - 5 - Math.floor(i / 4) }); if (p) ids.push(w.spawnUnit(d, me, p).id); });
    const foe = w.player(2).startPos;
    w.issue({ type: 'attackMove', playerId: me, unitIds: ids, target: foe });
    // and some enemies meeting them halfway, so a fight (and projectiles) is in progress at save time
    // ~14 tiles from the squad toward the enemy, so the fight is under way at the 75 s save on every map size
    const dx = foe.x - hq.pos.x, dy = foe.y - hq.pos.y, len = Math.hypot(dx, dy) || 1;
    const mid = { x: hq.pos.x + (dx / len) * 18, y: hq.pos.y + (dy / len) * 18 };
    const foes: number[] = [];
    ['path_bacillus', 'path_bacillus', 'path_phage', 'path_phage', 'path_phage', 'path_fungal_mortar'].forEach((d, i) => { const p = w.movement.nearestWalkable({ x: mid.x + i, y: mid.y }); if (p) { const u = w.spawnUnit(d, 2, p); u.scriptTags.add('scripted'); foes.push(u.id); } });
    w.issue({ type: 'attackMove', playerId: 2, unitIds: foes, target: hq.pos });
  }
}

function roundTrip(save: SaveGame): SaveGame {
  return JSON.parse(JSON.stringify(save)) as SaveGame;
}

function expectIdenticalEvolution(a: HeadlessMatch, b: HeadlessMatch, seconds: number): void {
  expect(stateHash(b.world), 'state right after load').toBe(stateHash(a.world));
  const n = Math.round(seconds / a.world.dt);
  for (let i = 0; i < n; i++) {
    a.step(); b.step();
    if (stateHash(a.world) !== stateHash(b.world)) {
      throw new Error(`diverged ${i + 1} ticks after load (tick ${a.world.tick}): ${firstDifference(a.world, b.world)}`);
    }
    if (a.world.rules.gameOver) break;
  }
}

describe('save codec', () => {
  it('round-trips Maps, Sets, typed arrays and special numbers through JSON', () => {
    const v = { m: new Map<unknown, unknown>([[1, 'a'], ['k', { s: new Set([1, 2]) }]]), u8: new Uint8Array([0, 2, 255]), f32: new Float32Array([1.5, -2]), inf: Infinity, nan: NaN, nz: -0, arr: [1, undefined, 3] };
    const back = decode(JSON.parse(JSON.stringify(encode(v)))) as typeof v;
    expect(back.m.get(1)).toBe('a');
    expect((back.m.get('k') as { s: Set<number> }).s.has(2)).toBe(true);
    expect([...back.u8]).toEqual([0, 2, 255]);
    expect([...back.f32]).toEqual([1.5, -2]);
    expect(back.inf).toBe(Infinity);
    expect(Number.isNaN(back.nan)).toBe(true);
    expect(Object.is(back.nz, -0)).toBe(true);
    expect(back.arr).toEqual([1, undefined, 3]);
  });
  it('rejects class instances with a path', () => {
    class Foo { x = 1; }
    expect(() => encode({ a: { b: new Foo() } })).toThrow(/\$\.a\.b/);
  });
});

describe('save/load round-trip determinism', () => {
  for (const mapId of ['test', 'meilahti']) {
    it(`skirmish on ${mapId}: a mid-battle save evolves identically for 60 s`, () => {
      const a = createHeadlessMatch({ mapId, seed: 11, difficulty: 'normal' });
      a.runFor(75, script); // through the scripted battle start at 60 s
      const save = roundTrip(saveHeadlessMatch(a, `rt-${mapId}`));
      const fighting = a.world.list.filter((e) => e.alive && e.activity === 'attacking').length;
      console.log(`[rt ${mapId}] t=${a.world.time.toFixed(1)} projectiles=${a.world.projectiles.length} attacking=${fighting} p1=${a.world.entitiesOf(1).length} p2=${a.world.entitiesOf(2).length} saveKB=${Math.round(JSON.stringify(save).length / 1024)}`);
      expect(a.world.projectiles.length + a.world.list.filter((e) => e.activity === 'attacking').length, 'combat in progress at save time').toBeGreaterThan(0);
      const b = loadHeadlessMatch(save);
      expect(b.world.list.length).toBe(a.world.list.length);
      expectIdenticalEvolution(a, b, 60);
    });
  }

  for (const missionId of ['m1', 'm2', 'm3']) {
    it(`campaign ${missionId}: a save after 3:20 evolves identically for 60 s`, () => {
      const a = createHeadlessMatch({ mode: 'campaign', missionId, seed: 5, difficulty: 'normal' });
      a.runFor(200);
      const save = roundTrip(saveHeadlessMatch(a, `rt-${missionId}`));
      const b = loadHeadlessMatch(save);
      expect(b.mission?.objectives()).toEqual(a.mission?.objectives());
      expectIdenticalEvolution(a, b, 60);
      expect(b.mission?.objectives()).toEqual(a.mission?.objectives());
    });
  }
});
