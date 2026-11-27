import { describe, expect, it } from 'vitest';
import type { Projectile } from '../../src/core/types';
import { combatWorld, record, runUntil, spawn } from './helpers';

describe('weapons & projectiles', () => {
  it('instant weapons: windup, then weaponFired(projectile=null) and immediate damage; cooldown × cooldownMul', () => {
    const w = combatWorld();
    const lancer = spawn(w, 'hosp_uv_lancer', 1, { x: 40, y: 70 });
    const drone = spawn(w, 'path_spore_drone', 2, { x: 44, y: 70 });
    drone.stats.hpRegen = 0;
    const fired = record(w, 'weaponFired');
    w.issue({ type: 'attack', playerId: 1, unitIds: [lancer.id], targetId: drone.id });
    w.step(); // command → order → in range → windup begins next combat pass
    expect(lancer.activity).toBe('attacking');
    expect(lancer.combat!.targetId).toBe(drone.id);
    expect(lancer.combat!.windupLeft).toBeGreaterThan(0);
    expect(fired).toHaveLength(0);
    runUntil(w, () => fired.length > 0, 1);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.projectile).toBeNull();
    expect(fired[0]!.targetPos).toEqual(drone.pos);
    expect(drone.hp).toBe(40 - 11); // UV beam 11 (no viral bonus vs a fungal drone)
    expect(lancer.combat!.lastAttackTime).toBeCloseTo(w.time - w.dt, 6);
    // the cooldown runs from the start of each attack (windup included): shots are cooldown × cooldownMul
    // apart; a new multiplier applies from the next attack on (the second one hasn't started yet)
    lancer.stats.cooldownMul = 0.5;
    const first = w.time;
    runUntil(w, () => fired.length > 1, 3);
    expect(w.time - first).toBeCloseTo(1.4, 6);
    const second = w.time;
    runUntil(w, () => fired.length > 2, 3);
    expect(w.time - second).toBeCloseTo(0.7, 6);
  });

  it('turns toward the target before firing', () => {
    const w = combatWorld();
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 40, y: 70 }, Math.PI); // facing away (−x)
    const d = spawn(w, 'path_spore_drone', 2, { x: 43, y: 70 });
    const fired = record(w, 'weaponFired');
    w.issue({ type: 'attack', playerId: 1, unitIds: [s.id], targetId: d.id });
    w.step();
    expect(fired).toHaveLength(0); // still turning (12 rad/s → ~0.25 s for 180°)
    runUntil(w, () => fired.length > 0, 1);
    expect(Math.abs(s.facing)).toBeLessThan(0.36);
  });

  it('homing projectiles track a moving target and always hit; heights & interpolation fields are set', () => {
    const w = combatWorld();
    const bac = spawn(w, 'path_bacillus', 2, { x: 40, y: 70 });
    const s = spawn(w, 'hosp_orderly', 1, { x: 44.5, y: 70 }); // worker: won't fight back
    const fired = record(w, 'weaponFired');
    const impacts = record(w, 'projectileImpact');
    w.issue({ type: 'attack', playerId: 2, unitIds: [bac.id], targetId: s.id });
    runUntil(w, () => fired.length > 0, 2);
    const p = fired[0]!.projectile as Projectile;
    expect(p).toBeTruthy();
    expect(w.projectiles).toContain(p);
    expect(p.arc).toBe(false);
    expect(p.targetId).toBe(s.id);
    expect(p.ownerPlayer).toBe(2);
    expect(p.vfx).toBe('acid_spit');
    expect(p.startHeight).toBeCloseTo(0.5 + 0.75 * 0.55, 6);
    expect(p.endHeight).toBeCloseTo(0.5 + 0.75 * 0.38, 6);
    expect(p.damage).toBe(10 + 5); // acid spit + mech bonus
    // target runs sideways: the shot follows it
    w.issue({ type: 'move', playerId: 1, unitIds: [s.id], target: { x: 44.5, y: 60 } });
    w.step();
    expect(p.prevT).toBeLessThanOrEqual(p.t);
    expect(p.t).toBeGreaterThan(0);
    runUntil(w, () => impacts.length > 0, 2);
    expect(impacts[0]!.projectile).toBe(p);
    expect(impacts[0]!.target).toBe(s);
    expect(s.hp).toBeCloseTo(45 - 15, 6);
    expect(w.projectiles).not.toContain(p);
    expect(s.pos.y).toBeLessThan(69); // it really moved
  });

  it('arc shells fly a parabola to the launch-time position: they splash static targets and miss movers', () => {
    const w = combatWorld();
    const art = spawn(w, 'hosp_antibiotic_launcher', 1, { x: 40, y: 70 });
    const still = spawn(w, 'path_spore_drone', 2, { x: 48, y: 70 });
    const buddy = spawn(w, 'path_spore_drone', 2, { x: 48, y: 71.2 });
    const fired = record(w, 'weaponFired');
    const impacts = record(w, 'projectileImpact');
    w.issue({ type: 'attack', playerId: 1, unitIds: [art.id], targetId: still.id });
    runUntil(w, () => fired.length > 0, 3);
    const p = fired[0]!.projectile!;
    expect(p.arc).toBe(true);
    expect(p.targetId).toBeNull();
    expect(p.endHeight).toBe(0);
    expect(p.targetPos).toEqual({ x: 48, y: 70 });
    const ts: number[] = [];
    runUntil(w, () => { ts.push(p.t); return impacts.length > 0; }, 3);
    // t advances by speed / distance per second: ~7.6 / 9 ≈ 0.84 s of flight
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThanOrEqual(ts[i - 1]!);
    expect(impacts[0]!.target).toBeNull();
    expect(impacts[0]!.pos.x).toBeCloseTo(48, 6);
    expect(still.hp).toBeLessThan(40);
    expect(buddy.hp).toBeLessThan(40); // splash
    expect(buddy.hp).toBeGreaterThan(still.hp); // falloff

    // a mover dodges: the shell lands where it was at launch
    const runner = spawn(w, 'path_spore_drone', 2, { x: 49, y: 74 }); // worker: stands still, won't charge
    runner.stats.hpRegen = 0;
    if (still.alive) w.killEntity(still);
    if (buddy.alive) w.killEntity(buddy);
    const before = fired.length;
    w.issue({ type: 'attack', playerId: 1, unitIds: [art.id], targetId: runner.id });
    runUntil(w, () => fired.length > before, 4);
    const shell = fired[fired.length - 1]!.projectile!;
    expect(shell.arc).toBe(true);
    w.issue({ type: 'move', playerId: 2, unitIds: [runner.id], target: { x: 60, y: 88 } });
    const nImp = impacts.length;
    runUntil(w, () => impacts.length > nImp, 3);
    expect(impacts[impacts.length - 1]!.projectile).toBe(shell);
    expect(runner.hp).toBe(40);
  });

  it('minRange: artillery will not fire at point-blank targets; an attack order backs off first', () => {
    const w = combatWorld();
    const art = spawn(w, 'hosp_antibiotic_launcher', 1, { x: 40, y: 70 });
    const close = spawn(w, 'path_spore_drone', 2, { x: 41.9, y: 70 }); // edge distance ≈ 0.72 < 2.5
    const fired = record(w, 'weaponFired');
    w.issue({ type: 'hold', playerId: 1, unitIds: [art.id] });
    w.runFor(3);
    expect(fired).toHaveLength(0);
    expect(art.pos).toEqual({ x: 40, y: 70 });
    w.issue({ type: 'attack', playerId: 1, unitIds: [art.id], targetId: close.id });
    runUntil(w, () => fired.length > 0, 6);
    expect(fired).toHaveLength(1);
    expect(w.edgeDistance(art, close)).toBeGreaterThanOrEqual(2.5);
  });

  it('projectiles from a shooter that died still land and credit the kill', () => {
    const w = combatWorld();
    const art = spawn(w, 'hosp_antibiotic_launcher', 1, { x: 40, y: 70 });
    const d = spawn(w, 'path_spore_drone', 2, { x: 49, y: 70 });
    d.hp = 5;
    const fired = record(w, 'weaponFired');
    const died = record(w, 'entityDied');
    w.issue({ type: 'attack', playerId: 1, unitIds: [art.id], targetId: d.id });
    runUntil(w, () => fired.length > 0, 3);
    w.killEntity(art, null);
    runUntil(w, () => !d.alive, 3);
    expect(d.alive).toBe(false);
    expect(died.find((x) => x.entity === d)!.killer).toBe(art);
    w.runFor(0.5);
    expect(w.projectiles).toHaveLength(0);
  });
});
