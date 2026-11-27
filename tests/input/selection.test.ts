import { describe, expect, it } from 'vitest';
import type { EntityId } from '../../src/core/types';
import { createHeadlessMatch } from '../../src/game/headless';
import { ControlGroups, DOUBLE_TAP_SECONDS } from '../../src/input/controlGroups';
import { groupDigit, normalizeKey, stepSpeed } from '../../src/input/keys';
import { Selection } from '../../src/input/Selection';
import { orderSubgroups, subgroupPriority } from '../../src/input/subgroups';
import { BUILDING_DEFS, UNIT_DEFS } from '../../src/data';

function setup() {
  const m = createHeadlessMatch({ mapId: 'test', enemyAi: false, seed: 9 });
  m.step();
  const w = m.world;
  const worker = w.entitiesOf(1, (e) => !!e.gatherer)[0]!;
  const hq = w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
  const san = w.spawnUnit('hosp_sanitizer', 1, { x: 26, y: 72 });
  const med = w.spawnUnit('hosp_medic', 1, { x: 27, y: 72 });
  const lan = w.spawnUnit('hosp_uv_lancer', 1, { x: 28, y: 72 });
  const enemy = w.entitiesOf(2, (e) => !!e.gatherer)[0]!;
  return { m, w, worker, hq, san, med, lan, enemy };
}

describe('subgroup priority', () => {
  it('orders heroes/tiers before workers, units before buildings, HQ before other structures', () => {
    const { w, worker, hq, san, med, lan } = setup();
    const groups = orderSubgroups([worker, hq, san, med, lan].map((e) => w.get(e.id)!));
    expect(groups.map((g) => g.defId)).toEqual(['hosp_uv_lancer', 'hosp_medic', 'hosp_sanitizer', 'hosp_orderly', 'hosp_hq']);
    expect(subgroupPriority(UNIT_DEFS.path_strain_omega!)).toBeGreaterThan(subgroupPriority(UNIT_DEFS.hosp_macrophage!));
    expect(subgroupPriority(UNIT_DEFS.hosp_orderly!)).toBeGreaterThan(subgroupPriority(BUILDING_DEFS.hosp_hq!));
    expect(subgroupPriority(BUILDING_DEFS.hosp_hq!)).toBeGreaterThan(subgroupPriority(BUILDING_DEFS.hosp_vehicle_bay!));
    expect(subgroupPriority(BUILDING_DEFS.hosp_pharmacy!)).toBeGreaterThan(subgroupPriority(BUILDING_DEFS.hosp_uv_turret!));
    expect(subgroupPriority(BUILDING_DEFS.hosp_uv_turret!)).toBeGreaterThan(subgroupPriority(BUILDING_DEFS.hosp_ward!));
  });
});

describe('Selection', () => {
  it('sorts by subgroup, keeps the invariants and notifies listeners + renderer', () => {
    const { w, worker, hq, san, med, lan, enemy } = setup();
    const rendered: Array<readonly EntityId[]> = [];
    const sel = new Selection(w, 1, { setSelection: (ids) => rendered.push([...ids]) });
    const seen: Array<readonly EntityId[]> = [];
    const off = sel.onChange((ids) => seen.push([...ids]));
    sel.set([worker.id, san.id, worker.id, med.id, lan.id]);
    expect(sel.ids).toEqual([lan.id, med.id, san.id, worker.id]);
    expect(sel.primary()!.id).toBe(lan.id);
    expect(sel.entities().map((e) => e.id)).toEqual([lan.id, med.id, san.id, worker.id]);
    expect(rendered.at(-1)).toEqual([lan.id, med.id, san.id, worker.id]);
    expect(seen.length).toBe(1);

    // Tab cycling
    expect(sel.cycleSubgroup()).toBe(true);
    expect(sel.activeSubgroup()).toBe('hosp_medic');
    expect(sel.primary()!.id).toBe(med.id);
    sel.cycleSubgroup(-1);
    sel.cycleSubgroup(-1);
    expect(sel.activeSubgroup()).toBe('hosp_orderly');
    expect(sel.activeEntities().map((e) => e.id)).toEqual([worker.id]);

    // foreign entities never mix into an own selection; a lone foreign entity is allowed
    sel.add([enemy.id]);
    expect(sel.ids).not.toContain(enemy.id);
    sel.set([enemy.id, hq.id]);
    expect(sel.ids).toEqual([hq.id]);
    sel.set([enemy.id]);
    expect(sel.ids).toEqual([enemy.id]);
    expect(sel.isOwn()).toBe(false);

    // shift-adding a higher-priority type keeps the shown subgroup; a fresh set() starts at the top
    sel.set([san.id]);
    sel.add([lan.id]);
    expect(sel.ids).toEqual([lan.id, san.id]);
    expect(sel.activeSubgroup()).toBe('hosp_sanitizer');
    sel.set([san.id, lan.id]);
    expect(sel.activeSubgroup()).toBe('hosp_uv_lancer');

    // toggle
    sel.set([san.id, med.id]);
    sel.toggle([san.id]);
    expect(sel.ids).toEqual([med.id]);
    sel.toggle([san.id]);
    expect(sel.ids).toEqual([med.id, san.id]);
    off();
    const n = seen.length;
    sel.clear();
    expect(seen.length).toBe(n);
    expect(sel.primary()).toBeUndefined();
    expect(sel.entities()).toEqual([]);
  });

  it('prunes dead entities and enemies that went out of sight, keeping the active subgroup', () => {
    const { w, san, med, lan, enemy } = setup();
    const sel = new Selection(w, 1, null);
    const reasons: string[] = [];
    sel.onChangeReason((r) => reasons.push(r));
    sel.set([san.id, med.id, lan.id]);
    sel.setActiveSubgroup('hosp_sanitizer');
    w.killEntity(lan);
    expect(sel.prune(() => true)).toBe(true);
    expect(sel.ids).toEqual([med.id, san.id]);
    expect(sel.activeSubgroup()).toBe('hosp_sanitizer');
    expect(reasons.at(-1)).toBe('prune');
    w.killEntity(san);
    sel.prune(() => true);
    expect(sel.activeSubgroup()).toBe('hosp_medic');
    expect(sel.prune(() => true)).toBe(false);

    sel.set([enemy.id]);
    expect(sel.prune(() => true)).toBe(false);
    expect(sel.prune((e) => e.owner !== 2)).toBe(true);
    expect(sel.ids).toEqual([]);
  });
});

describe('ControlGroups', () => {
  it('assign / add / recall with double-tap / centroid / pruning', () => {
    const { w, worker, san, med, enemy } = setup();
    const g = new ControlGroups(w, 1);
    expect(g.assign(1, [enemy.id])).toBe(false);
    expect(g.get(1)).toEqual([]);
    g.assign(1, [san.id, enemy.id]);
    expect(g.get(1)).toEqual([san.id]);
    g.add(1, [med.id, san.id]);
    expect(g.get(1)).toEqual([san.id, med.id]);
    g.assign(2, [worker.id]);
    expect(g.summary().map((s) => [s.index, s.count])).toEqual([[1, 2], [2, 1]]);
    const c = g.centroid(1)!;
    expect(c.x).toBeCloseTo((san.pos.x + med.pos.x) / 2, 5);
    expect(g.recall(1, 10)).toBe(false);
    expect(g.recall(1, 10 + DOUBLE_TAP_SECONDS - 0.05)).toBe(true);
    expect(g.recall(1, 10.5)).toBe(false); // a double-tap consumes the press
    expect(g.recall(2, 10.6)).toBe(false);
    expect(g.recall(1, 10.7)).toBe(false); // different group in between
    expect(g.recall(1, 11.5)).toBe(false); // too slow
    w.killEntity(san);
    expect(g.get(1)).toEqual([med.id]);
    w.killEntity(med);
    expect(g.get(1)).toEqual([]);
    expect(g.centroid(1)).toBeNull();
  });
});

describe('keys', () => {
  it('normalises hotkeys, digits and speed steps', () => {
    expect(normalizeKey({ key: 'a', code: 'KeyA' })).toBe('A');
    expect(normalizeKey({ key: 'A', code: 'KeyA' })).toBe('A');
    expect(normalizeKey({ key: 'Escape', code: 'Escape' })).toBe('Esc');
    expect(normalizeKey({ key: 'ф', code: 'KeyA' })).toBe('A');
    expect(groupDigit({ key: '!', code: 'Digit1' })).toBe(1);
    expect(groupDigit({ key: '0', code: 'Numpad0' })).toBe(0);
    expect(groupDigit({ key: 'a', code: 'KeyA' })).toBeNull();
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(1, -1)).toBe(0.75);
    expect(stepSpeed(4, 1)).toBe(4);
    expect(stepSpeed(0.5, -1)).toBe(0.5);
    expect(stepSpeed(1.1, -1)).toBe(1);
  });
});
