import { describe, expect, it } from 'vitest';
import { HEAL_PULSE } from '../../src/sim/combat';
import { combatWorld, record, runUntil, spawn } from './helpers';

describe('healers', () => {
  it('idle medic walks over and heals the most damaged friendly unit within sight (in pulses)', () => {
    const w = combatWorld();
    const medic = spawn(w, 'hosp_medic', 1, { x: 40, y: 70 });
    const a = spawn(w, 'hosp_sanitizer', 1, { x: 47, y: 70 });
    const b = spawn(w, 'hosp_macrophage', 1, { x: 46, y: 74 }); // mech units are healed too
    const healthy = spawn(w, 'hosp_sanitizer', 1, { x: 42, y: 70 });
    a.hp = 40; // 73%
    b.hp = 200; // 42% → most damaged
    const healed = record(w, 'entityHealed');
    runUntil(w, () => healed.length > 0, 5);
    expect(healed[0]!.entity).toBe(b);
    expect(healed[0]!.source).toBe(medic);
    expect(healed[0]!.amount).toBeCloseTo(10 * HEAL_PULSE, 6);
    expect(medic.activity).toBe('healing');
    expect(w.edgeDistance(medic, b)).toBeLessThanOrEqual(4.1);
    runUntil(w, () => a.hp >= 55 && b.hp >= 480, 60);
    expect(b.hp).toBe(480);
    expect(a.hp).toBe(55);
    expect(healthy.hp).toBe(55);
    expect(healed.every((h) => h.entity !== healthy && h.entity !== medic)).toBe(true);
    w.runFor(1);
    expect(medic.activity).not.toBe('healing');
  });

  it('heal rate × healRateMul; never heals enemies or structures', () => {
    const w = combatWorld();
    const medic = spawn(w, 'hosp_medic', 1, { x: 40, y: 70 });
    medic.stats.healRateMul = 2;
    const friend = spawn(w, 'hosp_orderly', 1, { x: 42, y: 70 }); // workers don't auto-fight the enemy below
    const enemy = spawn(w, 'path_spore_drone', 2, { x: 41, y: 72 });
    const ward = w.spawnBuilding('hosp_ward', 1, { x: 38, y: 72 });
    friend.hp = 4; enemy.hp = 10; enemy.stats.hpRegen = 0; ward.hp = 100;
    w.runFor(2.0);
    // 2 s → pulses at 0, 0.5, 1.0, 1.5 = 4 × (10 × 2 × 0.5)
    expect(friend.hp).toBeCloseTo(4 + 4 * 10, 6);
    expect(enemy.hp).toBe(10);
    expect(ward.hp).toBe(100);
  });

  it('medic told to follow a friend keeps up with it and heals it on the way', () => {
    const w = combatWorld();
    const medic = spawn(w, 'hosp_medic', 1, { x: 40, y: 70 });
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 42, y: 70 });
    s.hp = 10;
    s.stats.hpRegen = 0;
    w.issue({ type: 'smart', playerId: 1, unitIds: [medic.id], target: { ...s.pos }, targetId: s.id });
    w.step();
    expect(medic.orders[0]?.type).toBe('follow');
    w.issue({ type: 'move', playerId: 1, unitIds: [s.id], target: { x: 70, y: 70 } });
    const healed = record(w, 'entityHealed');
    let maxGap = 0;
    for (let i = 0; i < 20 * 14; i++) { w.step(); maxGap = Math.max(maxGap, w.edgeDistance(medic, s)); }
    expect(s.pos.x).toBeGreaterThan(69);
    expect(medic.pos.x).toBeGreaterThan(64);
    expect(maxGap).toBeLessThan(4);
    expect(healed.length).toBeGreaterThan(4);
    expect(s.hp).toBe(55);
    expect(medic.orders[0]?.type).toBe('follow');
  });

  it("explicit 'heal' order: walks to the patient and completes when it is full", () => {
    const w = combatWorld();
    const medic = spawn(w, 'hosp_medic', 1, { x: 40, y: 70 });
    const p = spawn(w, 'hosp_sanitizer', 1, { x: 60, y: 70 }); // beyond sight
    p.hp = 45;
    w.setOrders(medic, [{ type: 'heal', targetId: p.id }]);
    runUntil(w, () => medic.orders.length === 0, 20);
    expect(p.hp).toBe(55);
    expect(medic.orders).toHaveLength(0);
  });

  it('medics on hold heal only what is in range; on attack-move they heal along the way', () => {
    const w = combatWorld();
    const medic = spawn(w, 'hosp_medic', 1, { x: 40, y: 70 });
    const far = spawn(w, 'hosp_sanitizer', 1, { x: 47, y: 70 });
    far.hp = 20; far.stats.hpRegen = 0;
    w.issue({ type: 'hold', playerId: 1, unitIds: [medic.id] });
    w.runFor(2);
    expect(far.hp).toBe(20);
    expect(medic.pos).toEqual({ x: 40, y: 70 });
    w.issue({ type: 'attackMove', playerId: 1, unitIds: [medic.id], target: { x: 75, y: 70 } });
    runUntil(w, () => far.hp >= 55, 15);
    expect(far.hp).toBe(55);
    runUntil(w, () => medic.orders.length === 0, 20);
    expect(medic.pos.x).toBeGreaterThan(74);
  });
});
