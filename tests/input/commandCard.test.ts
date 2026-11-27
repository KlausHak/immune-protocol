import { describe, expect, it } from 'vitest';
import type { Command, Entity, EntityId } from '../../src/core/types';
import type { CommandButton } from '../../src/game/contracts';
import { createHeadlessMatch } from '../../src/game/headless';
import {
  buildCommandCard, buildMenuList, findByHotkey, researchChains, SLOTS,
  type CardHooks, type CardMenu, type CardMenuState, type TargetingRequest,
} from '../../src/input/commandCard';
import { UNIT_DEFS } from '../../src/data';
import type { World } from '../../src/sim/World';

function mockHooks() {
  const log = {
    issued: [] as Command[],
    targeting: [] as TargetingRequest[],
    placements: [] as Array<{ defId: string; builderIds: EntityId[]; buttonId: string }>,
    menus: [] as CardMenu[],
    feedback: [] as Array<{ kind: string; message: string }>,
  };
  const pending = new Map<EntityId, number>();
  const hooks: CardHooks = {
    issue: (c) => { log.issued.push(c); if (c.type === 'train') pending.set(c.buildingId, (pending.get(c.buildingId) ?? 0) + 1); },
    beginTargeting: (r) => { log.targeting.push(r); },
    beginPlacement: (defId, builderIds, buttonId) => { log.placements.push({ defId, builderIds, buttonId }); },
    openMenu: (m) => { log.menus.push(m); },
    feedback: (kind, message) => { log.feedback.push({ kind, message }); },
    queued: (id) => pending.get(id) ?? 0,
  };
  return { hooks, log };
}

function setup() {
  const m = createHeadlessMatch({ mapId: 'test', enemyAi: false, seed: 5 });
  m.step(); // economy computes pop cap / used
  const w = m.world;
  const worker = w.entitiesOf(1, (e) => !!e.gatherer)[0]!;
  const hq = w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
  return { m, w, worker, hq };
}

const card = (w: World, ids: EntityId[], state: Partial<CardMenuState> = {}, hooks = mockHooks().hooks, player = 1): CommandButton[] =>
  buildCommandCard(w, player, ids, { menu: 'root', ...state }, hooks);
const at = (c: CommandButton[], slot: number) => c.find((b) => b.slot === slot);
const byId = (c: CommandButton[], id: string) => c.find((b) => b.id === id);
const layout = (c: CommandButton[]) => Object.fromEntries(c.map((b) => [b.slot, b.id]));

function expectWellFormed(c: CommandButton[]) {
  const slots = c.map((b) => b.slot);
  expect(new Set(slots).size, `duplicate slots in ${JSON.stringify(layout(c))}`).toBe(slots.length);
  for (const b of c) {
    expect(b.slot).toBeGreaterThanOrEqual(0);
    expect(b.slot).toBeLessThan(15);
    expect(b.tooltip.length).toBeGreaterThan(0);
    expect(typeof b.activate).toBe('function');
    if (!b.enabled && !b.id.startsWith('ability.') && !b.id.startsWith('research.')) expect(b.disabledReason, b.id).toBeTruthy();
  }
  const keys = c.map((b) => b.hotkey).filter((k) => k !== '');
  expect(new Set(keys).size, `duplicate hotkeys ${keys}`).toBe(keys.length);
}

describe('command card — worker', () => {
  it('root card has the unit row, the worker row and opens the build menus', () => {
    const { w, worker } = setup();
    const { hooks, log } = mockHooks();
    const c = card(w, [worker.id], {}, hooks);
    expectWellFormed(c);
    expect(layout(c)).toEqual({
      0: 'cmd.move', 1: 'cmd.stop', 2: 'cmd.hold', 3: 'cmd.patrol', 4: 'cmd.attack',
      5: 'cmd.gather', 6: 'cmd.return', 7: 'cmd.repair', 8: 'menu.build', 9: 'menu.advanced',
    });
    expect(c.map((b) => b.hotkey).join('')).toBe('MSHPAGCRBV');
    // icons: cmd.* / menu.* ids
    expect(byId(c, 'cmd.move')!.icon).toBe('cmd.move');
    expect(byId(c, 'menu.build')!.icon).toBe('menu.build');
    // not carrying anything yet → Return is disabled with a reason
    expect(byId(c, 'cmd.return')!.enabled).toBe(false);
    expect(byId(c, 'cmd.return')!.disabledReason).toMatch(/Supplies/);

    findByHotkey(c, 'b')!.activate();
    findByHotkey(c, 'V')!.activate();
    expect(log.menus).toEqual(['build', 'advanced']);
    findByHotkey(c, 'G')!.activate();
    expect(log.targeting[0]).toMatchObject({ kind: 'gather', target: 'unit', unitIds: [worker.id], buttonId: 'cmd.gather' });
    findByHotkey(c, 'R')!.activate();
    expect(log.targeting[1]).toMatchObject({ kind: 'repair', unitIds: [worker.id] });
    findByHotkey(c, 'S')!.activate();
    expect(log.issued[0]).toMatchObject({ type: 'stop', playerId: 1, unitIds: [worker.id] });

    worker.gatherer!.carrying = 5;
    const c2 = card(w, [worker.id], {}, hooks);
    expect(byId(c2, 'cmd.return')!.enabled).toBe(true);
    byId(c2, 'cmd.return')!.activate();
    expect(log.issued[1]).toMatchObject({ type: 'returnCargo', unitIds: [worker.id] });
  });

  it('basic build menu: data hotkeys, affordability and requirement reasons, Back = Esc', () => {
    const { w, worker } = setup();
    const { hooks, log } = mockHooks();
    w.player(1).resources.matter = 150;
    const c = card(w, [worker.id], { menu: 'build' }, hooks);
    expectWellFormed(c);
    expect(layout(c)).toEqual({ 0: 'build.hosp_hq', 1: 'build.hosp_ward', 2: 'build.hosp_generator', 3: 'build.hosp_uv_turret', 4: 'build.hosp_barricade', 14: 'menu.back' });
    expect(byId(c, 'menu.back')!.hotkey).toBe('Esc');
    const ward = findByHotkey(c, 'W')!;
    expect(ward).toMatchObject({ id: 'build.hosp_ward', icon: 'hosp_ward', enabled: true, cost: { matter: 100 }, time: 25 });
    // tooltip = body text; label / hotkey / role / cost / disabledReason are structured fields
    expect(ward.tooltip).toMatch(/ward modules/);
    expect(ward.tooltip).not.toMatch(/Patient Ward/);
    const hq = byId(c, 'build.hosp_hq')!;
    expect(hq.enabled).toBe(false);
    expect(hq.disabledReason).toBe('Not enough Supplies');
    const turret = byId(c, 'build.hosp_uv_turret')!;
    expect(turret.enabled).toBe(false);
    expect(turret.disabledReason).toBe('Requires Pharmacy');

    ward.activate();
    expect(log.placements).toEqual([{ defId: 'hosp_ward', builderIds: [worker.id], buttonId: 'build.hosp_ward' }]);
    hq.activate(); // disabled → instant feedback, no placement
    expect(log.placements.length).toBe(1);
    expect(log.feedback.at(-1)).toEqual({ kind: 'matter', message: 'Not enough Supplies' });
    turret.activate();
    expect(log.feedback.at(-1)).toEqual({ kind: 'requirement', message: 'Requires Pharmacy' });
    byId(c, 'menu.back')!.activate();
    expect(log.menus).toEqual(['root']);

    // the active placement button is highlighted
    const c2 = card(w, [worker.id], { menu: 'build', activeButtonId: 'build.hosp_ward' }, hooks);
    expect(byId(c2, 'build.hosp_ward')!.active).toBe(true);
    expect(byId(c2, 'build.hosp_generator')!.active).toBe(false);
  });

  it('advanced build menu holds production / research / tier-2 structures', () => {
    const { w, worker } = setup();
    w.player(1).resources.matter = 150;
    const c = card(w, [worker.id], { menu: 'advanced' });
    expectWellFormed(c);
    expect(layout(c)).toEqual({ 0: 'build.hosp_pharmacy', 1: 'build.hosp_lab', 2: 'build.hosp_vehicle_bay', 14: 'menu.back' });
    expect(byId(c, 'build.hosp_pharmacy')!.enabled).toBe(true);
    expect(byId(c, 'build.hosp_lab')!.disabledReason).toBe('Requires Pharmacy');
    expect(byId(c, 'build.hosp_vehicle_bay')!.disabledReason).toBe('Requires Research Lab');
  });

  it('pathogen workers: no repair, faction menus, own resource names', () => {
    const { w } = setup();
    const drone = w.entitiesOf(2, (e) => !!e.gatherer)[0]!;
    const c = card(w, [drone.id], {}, mockHooks().hooks, 2);
    expectWellFormed(c);
    expect(at(c, SLOTS.repair)).toBeUndefined();
    expect(byId(c, 'cmd.return')!.disabledReason).toMatch(/Biomass/);
    expect(buildMenuList(UNIT_DEFS.path_spore_drone!, 'build')).toEqual(['path_hive', 'path_nest', 'path_fermenter', 'path_toxin_spitter']);
    expect(buildMenuList(UNIT_DEFS.path_spore_drone!, 'advanced')).toEqual(['path_replicator', 'path_mutation_pit', 'path_biofilm_spire']);
    // the local player never gets a card for an enemy unit
    expect(card(w, [drone.id])).toEqual([]);
  });
});

describe('command card — buildings', () => {
  it('Central Hospital: train, research, Emergency Supply (cooldown), rally, cancel', () => {
    const { m, w, hq } = setup();
    const { hooks, log } = mockHooks();
    const c = card(w, [hq.id], {}, hooks);
    expectWellFormed(c);
    expect(layout(c)).toEqual({ 0: 'train.hosp_orderly', 5: 'research.up_hosp_logistics', 10: 'ability.emergency_supply', 13: 'cmd.rally' });
    const train = byId(c, 'train.hosp_orderly')!;
    expect(train).toMatchObject({ hotkey: 'O', icon: 'hosp_orderly', enabled: true, cost: { matter: 50, pop: 1 }, time: 12 });
    expect(byId(c, 'research.up_hosp_logistics')!).toMatchObject({ hotkey: 'L', enabled: true });
    expect(byId(c, 'ability.emergency_supply')!).toMatchObject({ hotkey: 'E', enabled: true, cooldown: 0 });
    expect(byId(c, 'cmd.rally')!.hotkey).toBe('R');

    train.activate();
    expect(log.issued[0]).toEqual({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
    byId(c, 'ability.emergency_supply')!.activate();
    expect(log.issued[1]).toEqual({ type: 'buildingAbility', playerId: 1, buildingId: hq.id, abilityId: 'emergency_supply' });
    byId(c, 'cmd.rally')!.activate();
    expect(log.targeting[0]).toMatchObject({ kind: 'rally', buildingIds: [hq.id], unitIds: [], target: 'point' });

    // on cooldown → overlay fraction, disabled, feedback instead of a command
    hq.cooldowns.emergency_supply = 60;
    const c2 = card(w, [hq.id], {}, hooks);
    const es = byId(c2, 'ability.emergency_supply')!;
    expect(es.cooldown).toBeCloseTo(0.5, 5);
    expect(es.enabled).toBe(false);
    es.activate();
    expect(log.issued.length).toBe(2);
    expect(log.feedback.at(-1)!.kind).toBe('cooldown');

    // producing → Cancel (X) removes the last queued item
    w.issue({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
    m.step();
    expect(hq.production!.queue.length).toBe(1);
    const c3 = card(w, [hq.id], {}, hooks);
    expectWellFormed(c3);
    const cancel = at(c3, SLOTS.cancel)!;
    expect(cancel).toMatchObject({ id: 'cmd.cancel', hotkey: 'X', enabled: true });
    cancel.activate();
    expect(log.issued.at(-1)).toEqual({ type: 'cancelTrain', playerId: 1, buildingId: hq.id, index: 0 });
  });

  it('Pharmacy: train buttons with enabled state and disabled reasons', () => {
    const { m, w } = setup();
    const p = w.player(1);
    const ph = w.spawnBuilding('hosp_pharmacy', 1, { x: 28, y: 66 }, { complete: true });
    m.step();
    p.resources.matter = 1000; p.resources.energy = 1000;
    const { hooks, log } = mockHooks();
    let c = card(w, [ph.id], {}, hooks);
    expectWellFormed(c);
    expect(layout(c)).toEqual({ 0: 'train.hosp_sanitizer', 1: 'train.hosp_medic', 2: 'train.hosp_uv_lancer', 13: 'cmd.rally' });
    expect(c.slice(0, 3).map((b) => b.hotkey).join('')).toBe('SMU');
    expect(byId(c, 'train.hosp_sanitizer')!.enabled).toBe(true);
    expect(byId(c, 'train.hosp_medic')!).toMatchObject({ enabled: true, cost: { matter: 75, energy: 25, pop: 1 } });
    const lancer = byId(c, 'train.hosp_uv_lancer')!;
    expect(lancer.enabled).toBe(false);
    expect(lancer.disabledReason).toBe('Requires Research Lab');
    expect(lancer.tooltip).toMatch(/UV-C emitter/);
    lancer.activate();
    expect(log.issued.length).toBe(0);
    expect(log.feedback.at(-1)).toEqual({ kind: 'requirement', message: 'Requires Research Lab' });

    // resources: Supplies first, then Power
    p.resources.matter = 0;
    c = card(w, [ph.id], {}, hooks);
    expect(byId(c, 'train.hosp_sanitizer')!).toMatchObject({ enabled: false, disabledReason: 'Not enough Supplies' });
    p.resources.matter = 1000; p.resources.energy = 0;
    c = card(w, [ph.id], {}, hooks);
    expect(byId(c, 'train.hosp_sanitizer')!.enabled).toBe(true);
    expect(byId(c, 'train.hosp_medic')!).toMatchObject({ enabled: false, disabledReason: 'Not enough Power' });
    byId(c, 'train.hosp_medic')!.activate();
    expect(log.feedback.at(-1)).toEqual({ kind: 'energy', message: 'Not enough Power' });

    // population
    p.resources.energy = 1000;
    p.popUsed = p.popCap;
    c = card(w, [ph.id], {}, hooks);
    const san = byId(c, 'train.hosp_sanitizer')!;
    expect(san.enabled).toBe(false);
    expect(san.disabledReason).toMatch(/^Not enough Beds/);
    expect(san.disabledReason).toMatch(/Patient Ward/);

    // a completed Research Lab unlocks the UV Lancer
    w.spawnBuilding('hosp_lab', 1, { x: 33, y: 66 }, { complete: true });
    m.step();
    p.resources.matter = 1000; p.resources.energy = 1000;
    c = card(w, [ph.id], {}, hooks);
    expect(byId(c, 'train.hosp_uv_lancer')!.enabled).toBe(true);
    byId(c, 'train.hosp_uv_lancer')!.activate();
    expect(log.issued.at(-1)).toEqual({ type: 'train', playerId: 1, buildingId: ph.id, defId: 'hosp_uv_lancer' });
  });

  it('foundations only offer Cancel construction', () => {
    const { w } = setup();
    const f = w.spawnBuilding('hosp_pharmacy', 1, { x: 28, y: 66 }, { complete: false });
    const { hooks, log } = mockHooks();
    const c = card(w, [f.id], {}, hooks);
    expect(layout(c)).toEqual({ 14: 'cmd.cancel' });
    expect(c[0]!.hotkey).toBe('X');
    c[0]!.activate();
    expect(log.issued).toEqual([{ type: 'cancelConstruction', playerId: 1, buildingId: f.id }]);
  });

  it('several buildings of one type: training goes to the shortest queue', () => {
    const { m, w } = setup();
    const p = w.player(1);
    const a = w.spawnBuilding('hosp_pharmacy', 1, { x: 28, y: 66 }, { complete: true });
    const b = w.spawnBuilding('hosp_pharmacy', 1, { x: 33, y: 66 }, { complete: true });
    w.spawnBuilding('hosp_ward', 1, { x: 38, y: 66 }, { complete: true });
    m.step();
    p.resources.matter = 5000; p.resources.energy = 5000;
    a.production!.queue.push({ kind: 'unit', defId: 'hosp_sanitizer', progress: 0, total: 18, cost: { matter: 50 } });
    a.production!.queue.push({ kind: 'unit', defId: 'hosp_sanitizer', progress: 0, total: 18, cost: { matter: 50 } });
    const { hooks, log } = mockHooks();
    const c = card(w, [a.id, b.id], {}, hooks);
    const train = byId(c, 'train.hosp_sanitizer')!;
    train.activate(); // b: 0 queued
    train.activate(); // b: 1 pending
    train.activate(); // tie 2 vs 2 → first
    expect(log.issued.map((x) => (x as { buildingId: number }).buildingId)).toEqual([b.id, b.id, a.id]);
    // rally targets every selected producer; cancel picks the longest queue
    byId(c, 'cmd.rally')!.activate();
    expect(log.targeting[0]!.buildingIds.sort()).toEqual([a.id, b.id].sort());
    byId(c, 'cmd.cancel')!.activate();
    expect(log.issued.at(-1)).toEqual({ type: 'cancelTrain', playerId: 1, buildingId: a.id, index: 1 });
  });
});

describe('command card — mixed selections & subgroups', () => {
  it('uses the highest-priority subgroup; unit commands go to every selected unit', () => {
    const { m, w, worker } = setup();
    const san = w.spawnUnit('hosp_sanitizer', 1, { x: 26, y: 72 });
    const med = w.spawnUnit('hosp_medic', 1, { x: 27, y: 72 });
    const lan = w.spawnUnit('hosp_uv_lancer', 1, { x: 28, y: 72 });
    m.step();
    const all = [worker.id, san.id, med.id, lan.id];
    const { hooks, log } = mockHooks();
    const c = card(w, all, {}, hooks);
    expectWellFormed(c);
    // UV Lancer subgroup leads: its UV Flare is on row 2, no worker row
    expect(layout(c)).toEqual({ 0: 'cmd.move', 1: 'cmd.stop', 2: 'cmd.hold', 3: 'cmd.patrol', 4: 'cmd.attack', 10: 'ability.uv_flare' });
    const flare = byId(c, 'ability.uv_flare')!;
    expect(flare).toMatchObject({ hotkey: 'F', icon: 'uv_flare', enabled: true, cooldown: 0 });
    flare.activate();
    expect(log.targeting[0]).toMatchObject({ kind: 'ability', abilityId: 'uv_flare', target: 'point', unitIds: [lan.id] });
    byId(c, 'cmd.move')!.activate();
    expect([...log.targeting[1]!.unitIds].sort()).toEqual([...all].sort());
    byId(c, 'cmd.attack')!.activate();
    expect(log.targeting[2]!.kind).toBe('attack');

    // Tab to the workers → worker row appears, row 0 still commands everyone
    const cw = card(w, all, { subgroup: 'hosp_orderly' }, hooks);
    expect(at(cw, SLOTS.gather)!.id).toBe('cmd.gather');
    expect(at(cw, SLOTS.build)!.id).toBe('menu.build');
    expect(at(cw, 10)).toBeUndefined();
    // build menu on a mixed selection only lists builders
    const cb = card(w, all, { subgroup: 'hosp_orderly', menu: 'build' }, hooks);
    byId(cb, 'build.hosp_ward')!.activate();
    expect(log.placements[0]!.builderIds).toEqual([worker.id]);
    // a sub-menu that no longer applies falls back to the root card
    const cf = card(w, all, { menu: 'build' }, hooks);
    expect(byId(cf, 'menu.back')).toBeUndefined();
    expect(byId(cf, 'ability.uv_flare')).toBeTruthy();

    // ability cooldown overlay uses entity.cooldowns / def cooldown
    lan.cooldowns.uv_flare = 12.5;
    const cc = card(w, all, {}, hooks);
    expect(byId(cc, 'ability.uv_flare')!.cooldown).toBeCloseTo(0.5, 5);
    expect(byId(cc, 'ability.uv_flare')!.enabled).toBe(false);
  });

  it('units outrank buildings; enemy / dead / empty selections give an empty card', () => {
    const { w, hq, worker } = setup();
    const c = card(w, [hq.id, worker.id]);
    expect(at(c, 0)!.id).toBe('cmd.move');
    const cb = card(w, [hq.id, worker.id], { subgroup: 'hosp_hq' });
    expect(at(cb, 0)!.id).toBe('train.hosp_orderly');
    expect(card(w, [])).toEqual([]);
    expect(card(w, [987654])).toEqual([]);
    const enemyHive = w.entitiesOf(2, (e) => e.defId === 'path_hive')[0]!;
    expect(card(w, [enemyHive.id])).toEqual([]);
    w.killEntity(worker);
    expect(card(w, [worker.id])).toEqual([]);
  });
});

describe('command card — research', () => {
  it('in-progress research is active; completed research disappears; slots stay put', () => {
    const { w, hq } = setup();
    const p = w.player(1);
    p.resources.matter = 1000;
    const before = layout(card(w, [hq.id]));
    // in progress
    p.researching.add('up_hosp_logistics');
    hq.production!.queue.push({ kind: 'upgrade', defId: 'up_hosp_logistics', progress: 5, total: 45, cost: { matter: 100 } });
    const { hooks, log } = mockHooks();
    let c = card(w, [hq.id], {}, hooks);
    const r = byId(c, 'research.up_hosp_logistics')!;
    expect(r).toMatchObject({ active: true, enabled: false, slot: 5 });
    r.activate();
    expect(log.issued.length).toBe(0);
    byId(c, 'cmd.cancel')!.activate();
    expect(log.issued.at(-1)).toEqual({ type: 'cancelResearch', playerId: 1, buildingId: hq.id });
    // done
    hq.production!.queue.length = 0;
    p.researching.delete('up_hosp_logistics');
    p.upgrades.add('up_hosp_logistics');
    c = card(w, [hq.id]);
    expect(byId(c, 'research.up_hosp_logistics')).toBeUndefined();
    const after = layout(c);
    delete before[5];
    expect(after).toEqual(before);
  });

  it('upgrade levels share a slot: level 2 replaces level 1 once researched', () => {
    const { m, w } = setup();
    const p = w.player(1);
    const lab = w.spawnBuilding('hosp_lab', 1, { x: 28, y: 66 }, { complete: true });
    m.step();
    p.resources.matter = 1000; p.resources.energy = 1000;
    expect(researchChains(['up_hosp_weapons_1', 'up_hosp_weapons_2', 'up_hosp_armor_1'])).toEqual([['up_hosp_weapons_1', 'up_hosp_weapons_2'], ['up_hosp_armor_1']]);
    let c = card(w, [lab.id]);
    expectWellFormed(c);
    expect(layout(c)).toEqual({ 0: 'research.up_hosp_weapons_1', 1: 'research.up_hosp_armor_1', 2: 'research.up_hosp_rapid_response', 3: 'research.up_hosp_uv_overcharge' });
    expect(at(c, 0)!).toMatchObject({ hotkey: 'W', enabled: true, cost: { matter: 100, energy: 100 }, time: 60 });
    p.upgrades.add('up_hosp_weapons_1');
    c = card(w, [lab.id]);
    expect(at(c, 0)!).toMatchObject({ id: 'research.up_hosp_weapons_2', hotkey: 'E', enabled: true });
    expect(at(c, 1)!.id).toBe('research.up_hosp_armor_1');
    p.upgrades.add('up_hosp_weapons_2');
    c = card(w, [lab.id]);
    expect(at(c, 0)).toBeUndefined();
    expect(at(c, 1)!.id).toBe('research.up_hosp_armor_1');
    // no trains → no rally point
    expect(byId(c, 'cmd.rally')).toBeUndefined();
  });
});

describe('command card — robustness', () => {
  it('stays stable between frames and survives broken services', () => {
    const { w, hq, worker } = setup();
    const a = card(w, [hq.id]);
    const b = card(w, [hq.id]);
    expect(a.map((x) => [x.slot, x.id])).toEqual(b.map((x) => [x.slot, x.id]));
    w.player(1).resources.matter = 0;
    const poor = card(w, [hq.id]);
    expect(poor.map((x) => [x.slot, x.id])).toEqual(a.map((x) => [x.slot, x.id]));
    expect(byId(poor, 'train.hosp_orderly')!.enabled).toBe(false);

    const eco = w.economy, ab = w.abilities;
    (w as unknown as { economy: unknown }).economy = {};
    (w as unknown as { abilities: unknown }).abilities = {};
    try {
      const broken = card(w, [hq.id]);
      expect(byId(broken, 'train.hosp_orderly')!.enabled).toBe(false);
      expect(card(w, [worker.id], { menu: 'build' }).length).toBeGreaterThan(0);
      expect(() => byId(broken, 'train.hosp_orderly')!.activate()).not.toThrow();
    } finally {
      w.economy = eco; w.abilities = ab;
    }
  });

  it('every faction card for every trainable unit and building is well formed', () => {
    const { m, w } = setup();
    const ents: Entity[] = [];
    let x = 30;
    for (const id of ['hosp_pharmacy', 'hosp_lab', 'hosp_vehicle_bay', 'hosp_uv_turret']) { ents.push(w.spawnBuilding(id, 1, { x, y: 60 }, { complete: true })); x += 6; }
    x = 30;
    for (const id of ['path_replicator', 'path_mutation_pit', 'path_biofilm_spire', 'path_toxin_spitter']) { ents.push(w.spawnBuilding(id, 2, { x, y: 30 }, { complete: true })); x += 6; }
    for (const u of Object.values(UNIT_DEFS)) if (u.trainable !== false) ents.push(w.spawnUnit(u.id, u.faction === 'hospital' ? 1 : 2, { x: 48, y: 48 }));
    m.step();
    for (const e of ents) {
      const c = card(w, [e.id], {}, mockHooks().hooks, e.owner);
      // static defences have no commands; everything else has at least one button
      if (e.kind === 'unit' || (e.def.kind === 'building' && (e.def.trains.length || e.def.researches.length))) expect(c.length, e.defId).toBeGreaterThan(0);
      expectWellFormed(c);
    }
  });
});
