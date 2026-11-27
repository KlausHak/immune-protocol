import { describe, expect, it } from 'vitest';
import { dist } from '../../src/core/math';
import type { Entity, PlayerId } from '../../src/core/types';
import { combatWorld, record, runUntil, spawn } from './helpers';

describe('order handlers', () => {
  it('attack: walks to a far target, kills it, then the order completes', () => {
    const w = combatWorld();
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 36, y: 70 });
    const d = spawn(w, 'path_spore_drone', 2, { x: 56, y: 70 }); // well beyond sight (9)
    w.issue({ type: 'attack', playerId: 1, unitIds: [s.id], targetId: d.id });
    w.step();
    expect(s.orders[0]?.type).toBe('attack');
    expect(s.activity).toBe('moving');
    const t = runUntil(w, () => !d.alive, 30);
    expect(t).toBeLessThan(30);
    w.step();
    expect(s.orders).toHaveLength(0);
    expect(s.combat!.targetId).toBeNull();
  });

  it('attack: an unreachable / unhittable target fails the order (melee vs air)', () => {
    const w = combatWorld();
    const ph = spawn(w, 'path_phage', 2, { x: 40, y: 70 });
    const drone = spawn(w, 'hosp_sterilizer_drone', 1, { x: 60, y: 80 });
    drone.combat!.holdPosition = true;
    w.issue({ type: 'attack', playerId: 2, unitIds: [ph.id], targetId: drone.id });
    w.step(); w.step();
    expect(ph.orders).toHaveLength(0);
  });

  it('attackMove: engages an enemy seen en route, then resumes and arrives', () => {
    const w = combatWorld();
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 34, y: 70 });
    const d = spawn(w, 'path_spore_drone', 2, { x: 52, y: 72 });
    const fired = record(w, 'weaponFired');
    w.issue({ type: 'attackMove', playerId: 1, unitIds: [s.id], target: { x: 76, y: 70 } });
    runUntil(w, () => !d.alive, 30);
    expect(d.alive).toBe(false);
    expect(fired.every((f) => f.source === s && f.target === d)).toBe(true);
    expect(s.orders[0]?.type).toBe('attackMove'); // resumed
    runUntil(w, () => s.orders.length === 0, 30);
    expect(dist(s.pos, { x: 76, y: 70 })).toBeLessThan(0.5);
  });

  it('patrol: keeps attack-moving back and forth', () => {
    const w = combatWorld();
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 40, y: 70 });
    w.issue({ type: 'patrol', playerId: 1, unitIds: [s.id], target: { x: 50, y: 70 } });
    let maxX = 0, minXAfter = Infinity;
    for (let i = 0; i < 20 * 12; i++) {
      w.step();
      maxX = Math.max(maxX, s.pos.x);
      if (maxX > 49.5) minXAfter = Math.min(minXAfter, s.pos.x);
    }
    expect(maxX).toBeGreaterThan(49.5);
    expect(minXAfter).toBeLessThan(40.5);
    expect(s.orders[0]?.type).toBe('patrol');
    // and fights what comes by
    const d = spawn(w, 'path_spore_drone', 2, { x: 45, y: 73 });
    runUntil(w, () => !d.alive, 20);
    expect(d.alive).toBe(false);
    expect(s.orders[0]?.type).toBe('patrol');
  });

  it('hold: never moves, ignores enemies out of range, fires at anything in range', () => {
    const w = combatWorld();
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 40, y: 70 });
    const far = spawn(w, 'path_spore_drone', 2, { x: 47.5, y: 70 }); // in sight, out of range
    const fired = record(w, 'weaponFired');
    w.issue({ type: 'hold', playerId: 1, unitIds: [s.id] });
    w.runFor(3);
    expect(s.pos).toEqual({ x: 40, y: 70 });
    expect(fired).toHaveLength(0);
    expect(s.combat!.holdPosition).toBe(true);
    const ph = spawn(w, 'path_phage', 2, { x: 46, y: 71 }); // charges in (idle phages auto-acquire)
    runUntil(w, () => !ph.alive || !s.alive, 20);
    expect(fired.some((f) => f.source === s && f.target === ph)).toBe(true);
    expect(s.pos).toEqual({ x: 40, y: 70 });
    expect(far.alive).toBe(true);
    expect(s.orders[0]?.type).toBe('hold');
  });

  it('stop clears hold; ability orders on units without the ability are not created', () => {
    const w = combatWorld();
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 40, y: 70 });
    w.issue({ type: 'hold', playerId: 1, unitIds: [s.id] });
    w.step();
    w.issue({ type: 'stop', playerId: 1, unitIds: [s.id] });
    w.step();
    expect(s.combat!.holdPosition).toBe(false);
    expect(s.orders).toHaveLength(0);
  });
});

describe('idle behaviour', () => {
  it('auto-acquires within sight, prefers threats over workers and structures', () => {
    const w = combatWorld();
    const s = spawn(w, 'hosp_uv_lancer', 1, { x: 40, y: 70 });
    const worker = spawn(w, 'path_spore_drone', 2, { x: 44, y: 70 });
    const nest = w.spawnBuilding('path_nest', 2, { x: 42, y: 72 });
    const threat = spawn(w, 'path_bacillus', 2, { x: 46.5, y: 70 });
    threat.combat!.holdPosition = true;
    w.issue({ type: 'hold', playerId: 2, unitIds: [threat.id] });
    const fired = record(w, 'weaponFired');
    runUntil(w, () => fired.some((f) => f.source === s), 3);
    expect(fired.find((f) => f.source === s)!.target).toBe(threat);
    expect(worker.hp).toBe(40);
    expect(nest.hp).toBe(400);
  });

  it('nothing in sight → no acquisition; invisible enemies are never acquired (fog is fair)', () => {
    const w = combatWorld();
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 40, y: 70 });
    const d = spawn(w, 'path_spore_drone', 2, { x: 44, y: 70 });
    let visible = false;
    const real = w.vision;
    w.vision = { ...real, fogGrid: real.fogGrid.bind(real), isVisible: real.isVisible.bind(real), isExplored: real.isExplored.bind(real),
      revealAll: real.revealAll.bind(real), revealArea: real.revealArea.bind(real), version: real.version,
      isEntityVisible: (pid: PlayerId, e: Entity) => e.owner === pid || e !== d || visible };
    const fired = record(w, 'weaponFired');
    w.runFor(3);
    expect(fired).toHaveLength(0);
    expect(s.combat!.targetId).toBeNull();
    expect(s.pos).toEqual({ x: 40, y: 70 });
    visible = true;
    runUntil(w, () => fired.length > 0, 2);
    expect(fired[0]!.target).toBe(d);
  });

  it('workers do not auto-fight; armed units retaliate against attackers beyond sight', () => {
    const w = combatWorld();
    const worker = spawn(w, 'hosp_orderly', 1, { x: 40, y: 70 });
    const d = spawn(w, 'path_spore_drone', 2, { x: 40.9, y: 70 });
    w.runFor(3);
    expect(d.hp).toBe(40);
    expect(worker.combat!.targetId).toBeNull();
    // a mortar shelling a sanitizer from beyond its sight (9): the sanitizer charges it
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 40, y: 80 });
    const mortar = spawn(w, 'path_fungal_mortar', 2, { x: 50.2, y: 80 });
    w.issue({ type: 'attack', playerId: 2, unitIds: [mortar.id], targetId: s.id });
    runUntil(w, () => s.lastAttackerId === mortar.id, 8);
    expect(s.lastAttackerId).toBe(mortar.id);
    runUntil(w, () => s.combat!.targetId === mortar.id, 2);
    expect(s.combat!.targetId).toBe(mortar.id);
  });

  it('leash: an auto-chase gives up beyond ~1.5× sight and the unit walks back to its post', () => {
    const w = combatWorld();
    const s = spawn(w, 'hosp_sanitizer', 1, { x: 40, y: 70 });
    const bait = spawn(w, 'path_phage', 2, { x: 47, y: 70 });
    bait.stats.hpRegen = 50; // unkillable bait
    bait.stats.maxHp = 1e6; bait.hp = 1e6;
    // bait runs away at once (it is faster than the sanitizer)
    w.issue({ type: 'move', playerId: 2, unitIds: [bait.id], target: { x: 90, y: 70 } });
    let maxX = 40;
    for (let i = 0; i < 20 * 20; i++) { w.step(); maxX = Math.max(maxX, s.pos.x); }
    expect(maxX).toBeGreaterThan(44); // it did chase
    expect(maxX).toBeLessThan(40 + 9 * 1.5 + 2); // ...but not forever
    expect(dist(s.pos, { x: 40, y: 70 })).toBeLessThan(1.6); // back at its post
    expect(s.orders).toHaveLength(0);
  });

  it('allies help a friend that is under attack nearby', () => {
    const w = combatWorld();
    const victim = spawn(w, 'hosp_orderly', 1, { x: 40, y: 70 });
    const helper = spawn(w, 'hosp_sanitizer', 1, { x: 37, y: 66 });
    const art = spawn(w, 'path_fungal_mortar', 2, { x: 49.5, y: 70 }); // 13+ from the helper: out of its sight
    w.issue({ type: 'attack', playerId: 2, unitIds: [art.id], targetId: victim.id });
    runUntil(w, () => helper.combat!.targetId === art.id, 8);
    expect(helper.combat!.targetId).toBe(art.id);
  });
});

describe('turrets', () => {
  it('fire only when construction is complete', () => {
    const w = combatWorld();
    const turret = w.spawnBuilding('hosp_uv_turret', 1, { x: 40, y: 70 }, { complete: false });
    const d = spawn(w, 'path_spore_drone', 2, { x: 45, y: 71 });
    d.stats.hpRegen = 0;
    const fired = record(w, 'weaponFired');
    w.runFor(3);
    expect(fired).toHaveLength(0);
    expect(turret.combat!.targetId).toBeNull();
    turret.construction = undefined;
    runUntil(w, () => fired.length > 0, 2);
    expect(fired[0]!.source).toBe(turret);
    expect(fired[0]!.target).toBe(d);
    expect(d.hp).toBe(40 - 12);
    expect(turret.activity).toBe('attacking');
    expect(turret.facing).toBe(0); // buildings don't rotate; models aim with combat.targetId
    expect(turret.combat!.targetId).toBe(d.id);
  });

  it('projectile turret (Toxin Spitter) hits air units', () => {
    const w = combatWorld();
    const sp = w.spawnBuilding('path_toxin_spitter', 2, { x: 40, y: 70 });
    const drone = spawn(w, 'hosp_sterilizer_drone', 1, { x: 46, y: 71 });
    w.issue({ type: 'hold', playerId: 1, unitIds: [drone.id] });
    drone.stats.armor = 0;
    const fired = record(w, 'weaponFired');
    runUntil(w, () => fired.some((f) => f.source === sp), 3);
    const p = fired.find((f) => f.source === sp)!.projectile!;
    expect(p.startHeight).toBe(1.5);
    expect(p.endHeight).toBe(3.2);
    runUntil(w, () => drone.hp < 120, 2);
    expect(drone.hp).toBeLessThan(120);
  });
});
