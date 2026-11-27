import { describe, expect, it } from 'vitest';
import { incomeRate } from '../../src/sim/economy';
import { cachesNear, hqOf, idleAll, newMatch, record, runUntil, spawnDone, workersOf } from './util';

describe('production', () => {
  it('pays on queue, counts queued units in pop, cancels with a full refund', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    const hq = hqOf(w);
    idleAll(m);
    const queued = record(w, 'productionQueued');
    for (let i = 0; i < 3; i++) w.issue({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
    m.step();
    expect(queued.length).toBe(3);
    expect(hq.production!.queue.length).toBe(3);
    expect(p.resources.matter).toBe(0);
    expect(p.popUsed).toBe(8);
    expect(hq.activity).toBe('producing');
    w.issue({ type: 'cancelTrain', playerId: 1, buildingId: hq.id });
    m.step();
    expect(hq.production!.queue.length).toBe(2);
    expect(p.resources.matter).toBe(50);
    expect(p.popUsed).toBe(7);
    w.issue({ type: 'cancelTrain', playerId: 1, buildingId: hq.id, index: 0 }); // the one in progress
    m.step();
    expect(p.resources.matter).toBe(100);
    expect(hq.production!.queue.length).toBe(1);
    expect(hq.production!.queue[0]!.progress).toBeLessThan(0.2);
    const done = record(w, 'productionComplete');
    expect(runUntil(m, () => done.length > 0, 15)).toBeGreaterThan(11);
    expect(done[0]!.unit.defId).toBe('hosp_orderly');
    expect(p.stats.unitsTrained).toBe(1);
    expect(p.popUsed).toBe(6);
    m.step();
    expect(hq.activity).toBe('idle');
  });

  it('limits the queue to 5 and blocks on population with faction-aware messages', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    const hq = hqOf(w);
    const eco = w.economy;
    const msgs = record(w, 'notEnough');
    p.resources.matter = 1000;
    for (let i = 0; i < 5; i++) expect(eco.queueTrain(hq, 'hosp_orderly')).toBe(true);
    expect(eco.queueTrain(hq, 'hosp_orderly')).toBe(false);
    expect(msgs.at(-1)).toEqual({ playerId: 1, kind: 'queueFull', message: 'Production queue is full' });
    expect(p.popUsed).toBe(10);
    // pop: 5 workers + 5 queued = 10 = cap
    const pharmacy = spawnDone(w, 'hosp_pharmacy', 1, { x: 26, y: 68 });
    expect(eco.canTrain(pharmacy, 'hosp_sanitizer')).toMatchObject({ ok: false, reason: 'Not enough Beds — build a Patient Ward' });
    expect(eco.queueTrain(pharmacy, 'hosp_sanitizer')).toBe(false);
    expect(msgs.at(-1)).toEqual({ playerId: 1, kind: 'pop', message: 'Not enough Beds — build a Patient Ward' });
    spawnDone(w, 'hosp_ward', 1, { x: 31, y: 68 });
    expect(eco.canTrain(pharmacy, 'hosp_sanitizer').ok).toBe(true);
    // resources
    p.resources.matter = 10;
    expect(eco.canTrain(pharmacy, 'hosp_sanitizer')).toMatchObject({ ok: false, reason: 'Not enough Supplies' });
    p.resources.matter = 500;
    expect(eco.canTrain(pharmacy, 'hosp_medic')).toMatchObject({ ok: false, reason: 'Not enough Power' });
    // global cap
    for (let i = 0; i < 20; i++) spawnDone(w, 'hosp_ward', 1, { x: 40 + (i % 10) * 3, y: 80 + Math.floor(i / 10) * 3 });
    m.step();
    expect(p.popCap).toBe(150);
    for (let i = 0; i < 140; i++) w.spawnUnit('hosp_sanitizer', 1, { x: 60 + (i % 20) * 0.9, y: 60 + Math.floor(i / 20) * 0.9 });
    expect(eco.canTrain(pharmacy, 'hosp_sanitizer')).toMatchObject({ ok: false, reason: 'Beds limit reached (150)' });
    // pathogen wording
    const hive = hqOf(w, 2);
    w.player(2).resources.matter = 0;
    expect(eco.canTrain(hive, 'path_spore_drone')).toMatchObject({ ok: false, reason: 'Not enough Biomass' });
    w.player(2).resources.matter = 1000;
    for (let i = 0; i < 5; i++) w.spawnUnit('path_phage', 2, { x: 70 + i, y: 30 });
    expect(eco.canTrain(hive, 'path_spore_drone')).toMatchObject({ ok: false, reason: 'Not enough Colony — build a Spore Nest' });
  });

  it('gates on requirements and never trains while under construction', () => {
    const m = newMatch();
    const w = m.world;
    w.vision.revealAll(1, true);
    const p = w.player(1);
    const eco = w.economy;
    p.resources.matter = 1000; p.resources.energy = 1000;
    const pharmacy = spawnDone(w, 'hosp_pharmacy', 1, { x: 26, y: 68 });
    expect(eco.canTrain(pharmacy, 'hosp_uv_lancer')).toMatchObject({ ok: false, reason: 'Requires Research Lab' });
    const msgs = record(w, 'notEnough');
    w.issue({ type: 'train', playerId: 1, buildingId: pharmacy.id, defId: 'hosp_uv_lancer' });
    m.step();
    expect(msgs.at(-1)).toEqual({ playerId: 1, kind: 'requirement', message: 'Requires Research Lab' });
    const lab = eco.placeFoundation(1, 'hosp_lab', { x: 31, y: 68 }, null)!;
    expect(lab.construction).toBeDefined();
    expect(eco.canTrain(pharmacy, 'hosp_uv_lancer').ok).toBe(false); // foundations don't satisfy requirements
    expect(eco.canResearch(lab, 'up_hosp_weapons_1')).toMatchObject({ ok: false, reason: 'Under construction' });
    lab.construction!.progress = lab.construction!.total; // finishes during the next economy pass
    expect(w.economy.queueTrain(pharmacy, 'hosp_uv_lancer')).toBe(false);
    m.step();
    expect(lab.construction).toBeUndefined();
    expect(eco.canTrain(pharmacy, 'hosp_uv_lancer').ok).toBe(true);
    const mp = eco.placeFoundation(1, 'hosp_pharmacy', { x: 36, y: 68 }, null)!;
    expect(eco.canTrain(mp, 'hosp_sanitizer')).toMatchObject({ ok: false, reason: 'Under construction' });
    expect(eco.canTrain(pharmacy, 'hosp_orderly')).toMatchObject({ ok: false });
    expect(eco.canTrain(pharmacy, 'path_phage').ok).toBe(false);
  });

  it('spawns units on the edge facing the rally point and applies the rally', () => {
    const m = newMatch();
    const w = m.world;
    const hq = hqOf(w);
    const p = w.player(1);
    idleAll(m);
    p.resources.matter = 1000;
    const rect = w.footRect(hq)!;
    const done = record(w, 'productionComplete');
    const spawnedAt: Array<{ x: number; y: number }> = [];
    w.events.on('productionComplete', ({ unit }) => spawnedAt.push({ x: unit.pos.x, y: unit.pos.y }));
    w.issue({ type: 'setRally', playerId: 1, buildingIds: [hq.id], target: { x: hq.pos.x + 12, y: hq.pos.y } });
    w.issue({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
    expect(runUntil(m, () => done.length > 0, 15)).toBeGreaterThan(0);
    const u = done[0]!.unit;
    expect(u.pos.x).toBeGreaterThan(rect.x + rect.w); // east edge
    expect(u.pos.x - (rect.x + rect.w)).toBeLessThan(1.2);
    expect(u.orders[0]).toMatchObject({ type: 'move' });
    // rally on a cache: the new worker goes mining
    const cache = cachesNear(w, hq.pos, 1)[0]!;
    w.issue({ type: 'setRally', playerId: 1, buildingIds: [hq.id], target: cache.pos, targetId: cache.id });
    w.issue({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
    expect(runUntil(m, () => done.length > 1, 15)).toBeGreaterThan(0);
    const v = done[1]!.unit;
    expect(v.orders[0]?.type).toBe('gather');
    const deliveries = record(w, 'resourceDelivered');
    expect(runUntil(m, () => deliveries.some((d) => d.worker === v), 15)).toBeGreaterThan(0);
    // it appeared on the HQ side facing the cache
    const s1 = spawnedAt[1]!;
    const dot = (s1.x - hq.pos.x) * (cache.pos.x - hq.pos.x) + (s1.y - hq.pos.y) * (cache.pos.y - hq.pos.y);
    expect(dot).toBeGreaterThan(0);
    expect(Math.hypot(s1.x - cache.pos.x, s1.y - cache.pos.y)).toBeLessThan(Math.hypot(hq.pos.x - cache.pos.x, hq.pos.y - cache.pos.y));
  });

  it('a new worker rallied to a busy cache is spread to a less busy one', () => {
    const m = newMatch();
    const w = m.world;
    const hq = hqOf(w);
    m.runFor(1);
    const cache = cachesNear(w, hq.pos, 1)[0]!;
    // two workers already on the rally cache
    const ws = workersOf(w);
    for (const u of ws.slice(0, 2)) w.issue({ type: 'gather', playerId: 1, unitIds: [u.id], targetId: cache.id });
    m.step();
    w.issue({ type: 'setRally', playerId: 1, buildingIds: [hq.id], target: cache.pos, targetId: cache.id });
    w.issue({ type: 'train', playerId: 1, buildingId: hq.id, defId: 'hosp_orderly' });
    const done = record(w, 'productionComplete');
    runUntil(m, () => done.length > 0, 15);
    m.step();
    const v = done[0]!.unit;
    expect(v.orders[0]?.type).toBe('gather');
    expect(v.gatherer!.nodeId).not.toBe(cache.id);
  });

  it('research: pay, in-progress gating, completion updates existing and new units', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    const eco = w.economy;
    p.resources.matter = 2000; p.resources.energy = 2000;
    spawnDone(w, 'hosp_pharmacy', 1, { x: 26, y: 68 });
    const lab = spawnDone(w, 'hosp_lab', 1, { x: 31, y: 68 });
    const lab2 = spawnDone(w, 'hosp_lab', 1, { x: 36, y: 68 });
    const san = w.spawnUnit('hosp_sanitizer', 1, { x: 30, y: 74 });
    const worker = workersOf(w)[0]!;
    expect(eco.canResearch(lab, 'up_hosp_weapons_2')).toMatchObject({ ok: false, reason: 'Requires Concentrated Disinfectants' });
    expect(eco.queueResearch(lab, 'up_hosp_weapons_1')).toBe(true);
    expect(p.resources).toEqual({ matter: 1900, energy: 1900 });
    expect(p.researching.has('up_hosp_weapons_1')).toBe(true);
    expect(eco.canResearch(lab, 'up_hosp_weapons_1')).toMatchObject({ ok: false, reason: 'Already being researched' });
    expect(eco.canResearch(lab2, 'up_hosp_weapons_1')).toMatchObject({ ok: false, reason: 'Already being researched' });
    expect(eco.queueResearch(lab2, 'up_hosp_armor_1')).toBe(true);
    const done = record(w, 'researchComplete');
    expect(runUntil(m, () => done.length >= 2, 70)).toBeGreaterThan(55);
    expect(p.upgrades.has('up_hosp_weapons_1') && p.upgrades.has('up_hosp_armor_1')).toBe(true);
    expect(p.researching.size).toBe(0);
    expect(p.stats.upgradesResearched).toBe(2);
    expect(san.stats.damageMul).toBeCloseTo(1.12, 5);
    expect(san.stats.armor).toBe(1);
    expect(worker.stats.damageMul).toBe(1); // workers are excluded from weapon upgrades
    expect(worker.stats.armor).toBe(1);     // but get unit armour
    const fresh = w.spawnUnit('hosp_sanitizer', 1, { x: 31, y: 74 });
    expect(fresh.stats.damageMul).toBeCloseTo(1.12, 5);
    expect(fresh.stats.armor).toBe(1);
    expect(eco.canResearch(lab, 'up_hosp_weapons_1')).toMatchObject({ ok: false, reason: 'Already researched' });
    expect(eco.canResearch(lab, 'up_hosp_weapons_2').ok).toBe(true);
    // cancel research: full refund, no longer in progress
    const before = { ...p.resources };
    eco.queueResearch(lab, 'up_hosp_weapons_2');
    w.issue({ type: 'cancelResearch', playerId: 1, buildingId: lab.id });
    m.step();
    expect(p.resources.matter).toBeCloseTo(before.matter + 0, 5);
    expect(p.researching.has('up_hosp_weapons_2')).toBe(false);
    // a destroyed lab drops its research
    eco.queueResearch(lab, 'up_hosp_weapons_2');
    w.killEntity(lab);
    m.step();
    expect(p.researching.has('up_hosp_weapons_2')).toBe(false);
    expect(eco.canResearch(lab2, 'up_hosp_weapons_2').ok).toBe(true);
  });

  it('energy income and incomeRate', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    idleAll(m);
    spawnDone(w, 'hosp_generator', 1, { x: 26, y: 68 });
    m.runFor(20);
    expect(p.resources.energy).toBeCloseTo(0.85 * 20, 0);
    expect(p.stats.energyGenerated).toBeCloseTo(p.resources.energy, 5);
    const generator = w.economy.placeFoundation(1, 'hosp_generator', { x: 30, y: 68 }, null);
    expect(generator).toBeTruthy();
    m.runFor(10);
    const { energyPerMin } = incomeRate(w, 1);
    expect(energyPerMin).toBeCloseTo(51, 0); // HQ 0.25/s + generator 0.6/s; a foundation generates nothing
  });
});
