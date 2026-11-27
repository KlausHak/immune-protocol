import { describe, expect, it } from 'vitest';
import { addWorkers, hqOf, idleAll, newMatch, record, runUntil } from './util';

describe('repair', () => {
  it('a hospital worker repairs a damaged structure for ~25% of its cost per full repair', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    const hq = hqOf(w);
    idleAll(m);
    const [u] = addWorkers(w, 1, { x: hq.pos.x + 4, y: hq.pos.y - 4 });
    hq.hp = hq.stats.maxHp - 600;
    p.resources.matter = 500;
    const healed = record(w, 'entityHealed');
    w.issue({ type: 'smart', playerId: 1, unitIds: [u!.id], target: hq.pos, targetId: hq.id });
    m.step();
    expect(u!.orders[0]?.type).toBe('repair');
    m.runFor(5);
    expect(u!.activity).toBe('building');
    expect(hq.hp).toBeGreaterThan(hq.stats.maxHp - 600);
    expect(runUntil(m, () => hq.hp >= hq.stats.maxHp, 60)).toBeGreaterThan(0);
    m.step();
    expect(u!.orders.length).toBe(0);
    const spent = 500 - p.resources.matter;
    const expected = 0.25 * 400 * (600 / hq.stats.maxHp); // 40
    expect(spent).toBeCloseTo(expected, 0);
    const total = healed.filter((h) => h.entity === hq && h.source === u).reduce((a, h) => a + h.amount, 0);
    expect(total).toBeCloseTo(600, 0);
    expect(healed.length).toBeLessThan(80); // batched, not one event per tick
  });

  it('repairs mech units, refuses bio units and stops when out of Supplies', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    const hq = hqOf(w);
    idleAll(m);
    const [u] = addWorkers(w, 1, { x: hq.pos.x + 4, y: hq.pos.y - 4 });
    const mech = w.spawnUnit('hosp_macrophage', 1, { x: hq.pos.x + 7, y: hq.pos.y - 4 });
    mech.hp = 280;
    p.resources.matter = 1000;
    w.issue({ type: 'repair', playerId: 1, unitIds: [u!.id], targetId: mech.id });
    expect(runUntil(m, () => mech.hp >= mech.stats.maxHp, 60)).toBeGreaterThan(0);
    expect(1000 - p.resources.matter).toBeCloseTo(0.25 * 250 * (200 / 480), 0);
    // bio units can't be repaired
    const msgs = record(w, 'notEnough');
    const san = w.spawnUnit('hosp_sanitizer', 1, { x: hq.pos.x + 6, y: hq.pos.y - 6 });
    san.hp = 10;
    w.issue({ type: 'repair', playerId: 1, unitIds: [u!.id], targetId: san.id });
    m.runFor(0.5);
    expect(msgs.at(-1)).toMatchObject({ playerId: 1, kind: 'invalidTarget', message: 'Can only repair mechanical units' });
    expect(san.hp).toBe(10);
    // running out of matter stops the repair
    mech.hp = 100;
    p.resources.matter = 3;
    w.issue({ type: 'repair', playerId: 1, unitIds: [u!.id], targetId: mech.id });
    m.step();
    expect(u!.orders[0]?.type).toBe('repair');
    expect(runUntil(m, () => u!.orders.length === 0, 30)).toBeGreaterThan(0);
    expect(msgs.at(-1)).toMatchObject({ kind: 'matter', message: 'Not enough Supplies' });
    expect(p.resources.matter).toBeLessThan(0.05);
    expect(mech.hp).toBeGreaterThan(100);
    expect(mech.hp).toBeLessThan(180);
  });

  it('pathogen workers cannot repair; "repairing" a foundation helps build it', () => {
    const m = newMatch();
    const w = m.world;
    const hive = hqOf(w, 2);
    hive.hp -= 300;
    const drone = w.entitiesOf(2, (e) => !!e.gatherer)[0]!;
    const msgs = record(w, 'notEnough');
    w.issue({ type: 'repair', playerId: 2, unitIds: [drone.id], targetId: hive.id });
    m.runFor(0.5);
    expect(msgs.at(-1)).toMatchObject({ playerId: 2, kind: 'invalidTarget' });
    expect(drone.orders[0]?.type).not.toBe('repair');
    // foundation
    idleAll(m);
    const site = w.economy.placeFoundation(1, 'hosp_ward', { x: 25, y: 69 }, null)!;
    const u = w.entitiesOf(1, (e) => !!e.gatherer)[0]!;
    w.issue({ type: 'repair', playerId: 1, unitIds: [u.id], targetId: site.id });
    m.step(); m.step();
    expect(u.orders[0]?.type).toBe('construct');
    expect(runUntil(m, () => !site.construction, 40)).toBeGreaterThan(0);
  });
});
