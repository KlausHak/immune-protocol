import { describe, expect, it } from 'vitest';
import { dist } from '../../src/core/math';
import { EMERGENCY_SUPPLY_DELAY, installCombat } from '../../src/sim/combat';
import { installStubs } from '../../src/sim/stubs';
import { combatWorld, record, runUntil, spawn } from './helpers';

describe('abilities', () => {
  it('uv_flare: point AoE hits viral targets harder, spares friends, sets the cooldown', () => {
    const w = combatWorld();
    const lancer = spawn(w, 'hosp_uv_lancer', 1, { x: 40, y: 70 });
    const phage = spawn(w, 'path_phage', 2, { x: 45, y: 70 });
    const bac = spawn(w, 'path_bacillus', 2, { x: 46, y: 71 });
    const omega = spawn(w, 'path_strain_omega', 2, { x: 46, y: 67.5 });
    const friend = spawn(w, 'hosp_sanitizer', 1, { x: 45.5, y: 70.5 });
    for (const e of [lancer, phage, bac, omega, friend]) if (e.combat) e.combat.holdPosition = true;
    const dmg = record(w, 'entityDamaged');
    const used = record(w, 'abilityUsed');
    const center = { x: 45.5, y: 70 };
    expect(w.abilities.canCast(lancer, 'uv_flare', center).ok).toBe(true);
    expect(w.abilities.canCast(lancer, 'uv_flare', { x: 60, y: 70 }).ok).toBe(false); // out of range
    expect(w.abilities.cast(lancer, 'uv_flare', center)).toBe(true);
    const flares = used.filter((u) => u.abilityId === 'uv_flare');
    expect(flares).toHaveLength(1);
    expect(flares[0]!.target).toEqual(center);
    expect(used.some((u) => u.abilityId === 'viral_burst' && u.source === phage)).toBe(true); // the phage popped
    const by = (e: typeof phage) => dmg.filter((d) => d.entity === e && d.source === lancer).reduce((a, d) => a + d.amount, 0);
    expect(by(phage)).toBe(60); // 30 + 30 vs viral
    expect(phage.alive).toBe(false);
    expect(by(bac)).toBe(29); // 30 − armour 1
    expect(by(omega)).toBeCloseTo(60 * 0.6 - 3, 6); // viral but resists uv
    expect(by(friend)).toBe(0);
    expect(lancer.cooldowns.uv_flare).toBe(25);
    expect(w.abilities.canCast(lancer, 'uv_flare', center).ok).toBe(false);
    const toasts = record(w, 'notEnough');
    expect(w.abilities.cast(lancer, 'uv_flare', center)).toBe(false);
    expect(toasts[0]?.kind).toBe('cooldown');
  });

  it("ability order: walks into range, casts, shows 'casting', then completes", () => {
    const w = combatWorld();
    const lancer = spawn(w, 'hosp_uv_lancer', 1, { x: 36, y: 70 });
    const d = spawn(w, 'path_spore_drone', 2, { x: 50, y: 70 });
    d.stats.hpRegen = 0;
    const used = record(w, 'abilityUsed');
    w.issue({ type: 'ability', playerId: 1, unitIds: [lancer.id], abilityId: 'uv_flare', target: { x: 50, y: 70 } });
    runUntil(w, () => used.length > 0, 10);
    expect(used).toHaveLength(1);
    expect(w.edgeDistanceToPoint(lancer, { x: 50, y: 70 })).toBeLessThanOrEqual(7);
    expect(lancer.activity).toBe('casting');
    expect(d.hp).toBe(40 - 30);
    expect(lancer.orders[0]?.type).toBe('ability');
    runUntil(w, () => lancer.orders.length === 0 || lancer.orders[0]?.type !== 'ability', 1);
    expect(lancer.orders[0]?.type).not.toBe('ability');
  });

  it('emergency_supply: +100 matter after the helicopter delay', () => {
    const w = combatWorld();
    const hq = w.spawnBuilding('hosp_hq', 1, { x: 30, y: 60 });
    const used = record(w, 'abilityUsed');
    w.issue({ type: 'buildingAbility', playerId: 1, buildingId: hq.id, abilityId: 'emergency_supply' });
    w.step();
    expect(used).toHaveLength(1);
    expect(used[0]!.source).toBe(hq);
    expect(w.player(1).resources.matter).toBe(0);
    expect(hq.cooldowns.emergency_supply).toBeGreaterThan(119);
    w.runFor(EMERGENCY_SUPPLY_DELAY - 0.2);
    expect(w.player(1).resources.matter).toBe(0);
    w.runFor(0.3);
    expect(w.player(1).resources.matter).toBe(100);
    // second cast is on cooldown
    w.issue({ type: 'buildingAbility', playerId: 1, buildingId: hq.id, abilityId: 'emergency_supply' });
    w.runFor(3);
    expect(w.player(1).resources.matter).toBe(100);
  });

  it('viral_burst: a dying phage splashes nearby enemies only (once, even after re-install)', () => {
    const w = combatWorld();
    installStubs(w);
    installCombat(w); // re-install must not double-subscribe
    w.vision.revealAll(1, true);
    const ph = spawn(w, 'path_phage', 2, { x: 50, y: 70 });
    const near = spawn(w, 'hosp_sanitizer', 1, { x: 50.8, y: 70 });
    const far = spawn(w, 'hosp_sanitizer', 1, { x: 53, y: 70 });
    const buddy = spawn(w, 'path_phage', 2, { x: 49.4, y: 70.2 });
    for (const e of [ph, near, far, buddy]) e.combat!.holdPosition = true;
    const used = record(w, 'abilityUsed');
    const dmg = record(w, 'entityDamaged');
    w.combat.applyDamage(ph, 100, 'uv', near);
    expect(ph.alive).toBe(false);
    expect(used.filter((u) => u.abilityId === 'viral_burst')).toHaveLength(1);
    expect(used[0]!.source).toBe(ph);
    const burst = dmg.filter((d) => d.source === ph);
    expect(burst).toHaveLength(1);
    expect(burst[0]!.entity).toBe(near);
    // edge distance 0.4 of 1.3 → 6 × (1 − 0.5 × 0.4/1.3)
    expect(burst[0]!.amount).toBeCloseTo(6 * (1 - 0.5 * (0.4 / 1.3)), 6);
    expect(far.hp).toBe(55);
    expect(buddy.hp).toBe(38);
  });

  it('omega_spawn: Strain Omega sheds 3 phages that attack-move with it, every 18 s, capped', () => {
    const w = combatWorld();
    const omega = spawn(w, 'path_strain_omega', 2, { x: 40, y: 70 });
    const dest = { x: 85, y: 70 };
    w.issue({ type: 'attackMove', playerId: 2, unitIds: [omega.id], target: dest });
    const used = record(w, 'abilityUsed');
    const spawnedAt = new Map<number, number>();
    w.events.on('entitySpawned', ({ entity }) => spawnedAt.set(entity.id, dist(entity.pos, omega.pos)));
    const phages = () => w.entitiesOf(2, (e) => e.defId === 'path_phage');
    w.runFor(5);
    expect(phages()).toHaveLength(0);
    w.runFor(2);
    expect(phages()).toHaveLength(3);
    expect(used.filter((u) => u.abilityId === 'omega_spawn')).toHaveLength(1);
    for (const p of phages()) {
      expect(p.orders[0]?.type).toBe('attackMove');
      const o = p.orders[0] as { target: { x: number; y: number } };
      expect(dist(o.target, dest)).toBeLessThan(3);
      expect(spawnedAt.get(p.id)!).toBeLessThan(omega.radius + 1.5); // born right beside Omega
      expect(p.scriptTags.has('omega_brood')).toBe(true);
    }
    w.runFor(18);
    expect(phages()).toHaveLength(6);
    // phages run ahead of the slow boss
    const lead = Math.max(...phages().map((p) => p.pos.x));
    expect(lead).toBeGreaterThan(omega.pos.x);
    w.runFor(18 * 4);
    expect(phages().length).toBeLessThanOrEqual(12);
  });
});
