import { describe, expect, it } from 'vitest';
import { splashDamage, combatRuntime } from '../../src/sim/combat';
import { UNIT_DEFS } from '../../src/data';
import { combatWorld, record, spawn } from './helpers';

const weapon = (id: string) => UNIT_DEFS[id]!.weapons[0]!;

describe('damage formula: dealt = max(0.5, raw × resist − armor)', () => {
  it('applies armour, bonus vs tags, resistances and the 0.5 minimum', () => {
    const w = combatWorld();
    const lancer = spawn(w, 'hosp_uv_lancer', 1, { x: 40, y: 70 });
    const launcher = spawn(w, 'hosp_antibiotic_launcher', 1, { x: 40, y: 74 });
    const phage = spawn(w, 'path_phage', 2, { x: 60, y: 70 });
    const omega = spawn(w, 'path_strain_omega', 2, { x: 70, y: 80 });
    const superbug = spawn(w, 'path_superbug', 2, { x: 60, y: 80 });
    const mech = spawn(w, 'hosp_macrophage', 1, { x: 40, y: 80 });

    // raw = base + bonus vs tags (UV-C beam: 11 +10 vs viral)
    expect(w.combat.rawDamage(lancer, weapon('hosp_uv_lancer'), phage)).toBe(21);
    expect(w.combat.rawDamage(lancer, weapon('hosp_uv_lancer'), superbug)).toBe(11);
    // phage: armour 0, no resist
    expect(w.combat.applyDamage(phage, 21, 'uv', lancer)).toBe(21);
    // Strain Omega: uv resist 0.6, armour 3 → 21 × 0.6 − 3
    expect(w.combat.applyDamage(omega, 21, 'uv', lancer)).toBeCloseTo(9.6, 6);
    expect(omega.hp).toBeCloseTo(4500 - 9.6, 6);
    // Superbug resists antibiotics (0.5), armour 2: shell 28 + 18 vs bacterial = 46 → 21
    const raw = w.combat.rawDamage(launcher, weapon('hosp_antibiotic_launcher'), superbug);
    expect(raw).toBe(46);
    expect(w.combat.applyDamage(superbug, raw, 'antibiotic', launcher)).toBeCloseTo(21, 6);
    // minimum 0.5 (macrophage armour 3)
    expect(w.combat.applyDamage(mech, 1, 'acid', phage)).toBe(0.5);
    expect(mech.hp).toBe(480 - 0.5);
  });

  it('uses effective stats: damageMul, damageAdd, upgraded armour/resist', () => {
    const w = combatWorld();
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 40, y: 70 });
    const b = spawn(w, 'path_bacillus', 2, { x: 50, y: 70 });
    s.stats.damageMul = 1.12;
    s.stats.damageAdd = 1;
    expect(w.combat.rawDamage(s, weapon('hosp_sanitizer'), b)).toBeCloseTo((6 + 1) * 1.12, 9);
    b.stats.armor = 2;
    b.stats.resist.normal = 0.5;
    expect(w.combat.applyDamage(b, 10, 'normal', s)).toBe(3);
    s.stats.rangeAdd = 1;
    expect(w.combat.weaponRange(s, weapon('hosp_sanitizer'))).toBe(5.5);
  });

  it('respects invulnerability, never damages resources, reports damage and kills with credit', () => {
    const w = combatWorld();
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 40, y: 70 });
    const d = spawn(w, 'path_spore_drone', 2, { x: 45, y: 70 });
    const node = w.spawnResource({ x: 60, y: 80 });
    const damaged = record(w, 'entityDamaged');
    const died = record(w, 'entityDied');
    expect(w.combat.applyDamage(node, 50, 'normal', s)).toBe(0);
    expect(node.resource!.amount).toBe(1500);
    d.invulnerable = true;
    expect(w.combat.applyDamage(d, 50, 'normal', s)).toBe(0);
    expect(d.hp).toBe(40);
    d.invulnerable = false;
    expect(w.combat.applyDamage(d, 0, 'normal', s)).toBe(0); // no-op hits don't count
    expect(w.combat.applyDamage(d, 15, 'normal', s)).toBe(15);
    expect(d.lastAttackerId).toBe(s.id);
    expect(damaged.map((x) => x.amount)).toEqual([15]);
    w.combat.applyDamage(d, 100, 'normal', s);
    expect(d.alive).toBe(false);
    expect(died).toHaveLength(1);
    expect(died[0]!.killer).toBe(s);
    expect(w.player(1).stats.unitsKilled).toBe(1);
    expect(w.combat.applyDamage(d, 100, 'normal', s)).toBe(0); // dead stays dead, no second event
    expect(died).toHaveLength(1);
  });

  it('heal() caps at max hp and emits entityHealed', () => {
    const w = combatWorld();
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 40, y: 70 });
    const healed = record(w, 'entityHealed');
    expect(w.combat.heal(s, 10, null)).toBe(0);
    s.hp = 50;
    expect(w.combat.heal(s, 10, null)).toBe(5);
    expect(s.hp).toBe(55);
    expect(healed).toHaveLength(1);
    expect(healed[0]!.amount).toBe(5);
  });

  it('weaponFor picks the layer weapon; canTarget needs an enemy, a weapon and visibility', () => {
    const w = combatWorld();
    const phage = spawn(w, 'path_phage', 2, { x: 40, y: 70 });
    const drone = spawn(w, 'hosp_sterilizer_drone', 1, { x: 41, y: 70 });
    const san = spawn(w, 'hosp_sanitizer', 1, { x: 42, y: 70 });
    const medic = spawn(w, 'hosp_medic', 1, { x: 43, y: 70 });
    expect(w.combat.weaponFor(phage, drone)).toBeNull(); // melee can't hit air
    expect(w.combat.canTarget(phage, drone)).toBe(false);
    expect(w.combat.weaponFor(san, drone)?.name).toBe('Disinfectant Spray'); // the spray hits air (layer only)
    expect(w.combat.canTarget(san, drone)).toBe(false); // ...but never friends
    expect(w.combat.canTarget(phage, san)).toBe(true);
    expect(w.combat.canTarget(medic, phage)).toBe(false); // unarmed
    const turret = w.spawnBuilding('hosp_uv_turret', 1, { x: 50, y: 66 }, { complete: false });
    expect(w.combat.weaponFor(turret, phage)).toBeNull(); // under construction
    turret.construction = undefined;
    expect(w.combat.weaponFor(turret, phage)!.name).toBe('UV Emitter');
  });
});

describe('splash', () => {
  it('falls off linearly to 50% at the edge and never hits friends or neutrals', () => {
    const w = combatWorld();
    const rt = combatRuntime(w)!;
    const src = spawn(w, 'hosp_antibiotic_launcher', 1, { x: 34, y: 70 });
    const c = { x: 50, y: 70 };
    const r = 0.32; // phage radius → edge distance = centre distance − 0.32
    const center = spawn(w, 'path_phage', 2, { x: c.x, y: c.y });
    const mid = spawn(w, 'path_phage', 2, { x: c.x + 1 + r, y: c.y });
    const edge = spawn(w, 'path_phage', 2, { x: c.x, y: c.y + 2 + r - 1e-6 });
    const outside = spawn(w, 'path_phage', 2, { x: c.x - 2.5 - r, y: c.y });
    const friend = spawn(w, 'hosp_sanitizer', 1, { x: c.x + 0.5, y: c.y - 0.5 });
    const res = w.spawnResource({ x: c.x - 1, y: c.y + 1 });
    const total = splashDamage(rt, { center: c, radius: 2, ownerPlayer: 1, source: src, type: 'antibiotic', rawFor: () => 20 });
    expect(38 - center.hp).toBeCloseTo(20, 6);
    expect(38 - mid.hp).toBeCloseTo(15, 6);
    expect(38 - edge.hp).toBeCloseTo(10, 4);
    expect(outside.hp).toBe(38);
    expect(friend.hp).toBe(55);
    expect(res.resource!.amount).toBe(1500);
    expect(total).toBeCloseTo(45, 4);
  });

  it('melee splash (Superbug slam) hits the primary fully and neighbours with falloff, not allies', () => {
    const w = combatWorld();
    const bug = spawn(w, 'path_superbug', 2, { x: 50, y: 70 });
    const ally = spawn(w, 'path_spore_drone', 2, { x: 52.3, y: 70.5 }); // workers don't auto-fight
    const target = spawn(w, 'hosp_macrophage', 1, { x: 52.2, y: 70 });
    const near = spawn(w, 'hosp_medic', 1, { x: 53.0, y: 70.9 }); // edge distance 0.8 from the slam centre // unarmed bystander, armour 1
    w.issue({ type: 'attack', playerId: 2, unitIds: [bug.id], targetId: target.id });
    const fired = record(w, 'weaponFired');
    const dmg = record(w, 'entityDamaged');
    for (let i = 0; i < 40 && !fired.some((f) => f.source === bug); i++) w.step();
    const slam = fired.find((f) => f.source === bug)!;
    expect(slam.target).toBe(target);
    expect(slam.projectile).toBeNull();
    const byBug = dmg.filter((d) => d.source === bug);
    const onTarget = byBug.find((d) => d.entity === target)!;
    expect(onTarget.amount).toBeCloseTo(30 - 3, 6); // full damage − armour 3
    const onNear = byBug.find((d) => d.entity === near)!;
    expect(onNear.amount).toBeGreaterThanOrEqual(30 * 0.5 - 1 - 1e-6); // falloff ≥ 50%, armour 1
    expect(onNear.amount).toBeLessThan(30 - 1);
    expect(byBug.some((d) => d.entity === ally)).toBe(false);
    expect(ally.hp).toBe(40);
  });
});
