/**
 * [qa] Self-tests for the QA harness: the invariant checker must catch planted bugs, the bot must play only
 * through world.issue(), its spiral placement must produce placeable tiles, and with no opponent AI it must
 * build the full hospital tech tree and an army (this doubles as an economy/production integration test).
 */
import { describe, expect, it } from 'vitest';
import { createHeadlessMatch } from '../../src/game/headless';
import type { Projectile } from '../../src/core/types';
import { BUILDING_DEFS } from '../../src/data';
import { createHospitalBot } from '../helpers/hospitalBot';
import { describeSummary, errorViolations, formatExceptions, formatTimeline, formatViolations, InvariantChecker, runMatch, saveSummary } from '../helpers/match';

const quiet = () => createHeadlessMatch({ mapId: 'test', enemyAi: false, seed: 1 });

describe('invariant checker catches planted bugs', () => {
  it('a clean world has no violations', () => {
    const m = quiet();
    m.runFor(2);
    const c = new InvariantChecker();
    c.check(m.world);
    expect(c.violations, JSON.stringify(c.violations)).toEqual([]);
  });

  it('flags NaN positions, hp > maxHp, alive-with-0-hp and negative resources', () => {
    const m = quiet();
    m.runFor(1);
    const w = m.world;
    const [a, b, c2] = w.entitiesOf(1, (e) => e.kind === 'unit');
    a!.pos.x = NaN;
    b!.hp = b!.stats.maxHp + 50;
    c2!.hp = 0;
    w.player(2).resources.matter = -5;
    const c = new InvariantChecker();
    c.check(w);
    const checks = new Set(c.violations.map((v) => v.check));
    expect([...checks].sort()).toEqual(expect.arrayContaining(['position-finite', 'hp-over-max', 'zombie', 'resources-negative']));
    expect(c.violations.find((v) => v.check === 'position-finite')!.entityId).toBe(a!.id);
  });

  it('flags dead entities that are never removed, ground units stuck in water, and broken projectiles', () => {
    const m = quiet();
    m.runFor(1);
    const w = m.world;
    const units = w.entitiesOf(1, (e) => e.kind === 'unit');
    const ghost = units[0]!;
    ghost.alive = false; // bypassing world.killEntity → never queued for removal
    const swimmer = units[1]!;
    const c = new InvariantChecker({ stuckSeconds: 0, every: 1 });
    c.check(w);
    w.step(); w.step();
    swimmer.pos = { x: 22.5, y: 48.5 }; swimmer.prevPos = { x: 22.5, y: 48.5 }; // centre of the test-map pond
    const src = w.entitiesOf(1, (e) => e.kind === 'building')[0]!;
    const bad: Projectile = {
      id: 999_999, ownerPlayer: 1, sourceId: src.id, targetId: null, weapon: { name: 'x', damage: 1, damageType: 'normal', range: 1, cooldown: 1, targets: ['ground'], vfx: 'laser' },
      vfx: 'laser', pos: { x: Infinity, y: 0 }, prevPos: { x: 0, y: 0 }, start: { x: 0, y: 0 }, targetPos: { x: 1, y: 1 }, t: 0, prevT: 0, speed: 5, arc: false, damage: 1, splashRadius: 0, startHeight: 0, endHeight: 0,
    };
    w.projectiles.push(bad);
    c.check(w);
    w.projectiles.splice(w.projectiles.indexOf(bad), 1);
    const checks = new Set(c.violations.map((v) => v.check));
    expect(checks.has('dead-lingering'), JSON.stringify(c.violations)).toBe(true);
    expect(checks.has('unit-in-blocked-tile'), JSON.stringify(c.violations)).toBe(true);
    expect(checks.has('projectile-finite'), JSON.stringify(c.violations)).toBe(true);
  });

  it('throwOnViolation throws with context', () => {
    const m = quiet();
    m.runFor(1);
    m.world.entitiesOf(1, (e) => e.kind === 'unit')[0]!.pos.y = NaN;
    const c = new InvariantChecker({ throwOnViolation: true });
    expect(() => c.check(m.world)).toThrow(/position-finite/);
  });
});

describe('hospital bot', () => {
  it('only acts through world.issue() (never spawns, kills or edits entities directly)', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: true, seed: 2 });
    const w = m.world;
    const bot = createHospitalBot(w, { strength: 'strong' });
    let inBot = false;
    const direct: string[] = [];
    for (const name of ['spawnUnit', 'spawnBuilding', 'spawnResource', 'killEntity', 'removeEntity', 'setOrders', 'clearOrders'] as const) {
      const orig = (w[name] as (...a: unknown[]) => unknown).bind(w);
      (w as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => { if (inBot) direct.push(name); return orig(...args); };
    }
    const spend = w.economy.spend.bind(w.economy);
    w.economy.spend = (pid, cost) => { if (inBot) direct.push('economy.spend'); return spend(pid, cost); };
    let issued = 0;
    const issue = w.issue.bind(w);
    w.issue = (cmd) => { if (inBot) { issued++; expect(cmd.playerId).toBe(1); } issue(cmd); };
    m.runFor(150, () => { inBot = true; try { bot.update(); } finally { inBot = false; } });
    bot.dispose();
    expect(direct).toEqual([]);
    expect(issued).toBeGreaterThan(20);
  });

  it('spiral placement returns tiles that economy.canPlaceBuilding accepts', () => {
    const m = quiet();
    m.runFor(1);
    const bot = createHospitalBot(m.world, { strength: 'medium' });
    const hq = m.world.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    for (const defId of ['hosp_ward', 'hosp_generator', 'hosp_barricade']) {
      const t = bot.findSpot(defId, { x: hq.pos.x + 7, y: hq.pos.y - 7 });
      expect(t, `${defId} spot`).not.toBeNull();
      expect(m.world.economy.canPlaceBuilding(1, defId, t!).ok, `${defId} at ${t!.x},${t!.y}`).toBe(true);
      const def = BUILDING_DEFS[defId]!;
      // never on the HQ itself
      const overlapsHq = t!.x < hq.tile!.x + 5 && hq.tile!.x < t!.x + def.footprint.w && t!.y < hq.tile!.y + 5 && hq.tile!.y < t!.y + def.footprint.h;
      expect(overlapsHq).toBe(false);
    }
    bot.dispose();
  });

  it('with no opponent AI it builds the tech tree, researches and fields a mixed army (economy/production integration)', () => {
    const s = runMatch({ mapId: 'test', seed: 4, minutes: 6.5, bot: 'medium', enemyAi: false });
    console.log(`${describeSummary(s)}\n${formatTimeline(s)}`);
    saveSummary('harness-bot-medium-vs-idle', s);
    expect(s.exceptions, formatExceptions(s)).toEqual([]);
    expect(s.consoleErrors, formatExceptions(s)).toEqual([]);
    expect(errorViolations(s), formatViolations(s)).toEqual([]);
    const p1 = s.players[1]!;
    const built = (id: string) => p1.buildingsByType[id] ?? 0;
    // snapshot at the end (or at victory, if the bot already won)
    const peakWorkers = Math.max(...s.timeline.map((t) => t.players[1]?.workers ?? 0));
    const peakArmy = Math.max(...s.timeline.map((t) => t.players[1]?.army ?? 0), p1.army);
    expect(peakWorkers, 'orderlies trained').toBeGreaterThanOrEqual(12);
    expect(built('hosp_ward'), 'wards').toBeGreaterThanOrEqual(1);
    expect(built('hosp_pharmacy'), 'pharmacy').toBeGreaterThanOrEqual(1);
    expect(built('hosp_lab'), 'research lab').toBeGreaterThanOrEqual(1);
    expect(built('hosp_generator'), 'generators').toBeGreaterThanOrEqual(2);
    expect(p1.stats.upgradesResearched, 'upgrades researched').toBeGreaterThanOrEqual(1);
    expect(peakArmy, 'army size').toBeGreaterThanOrEqual(8);
    expect(s.botStats!.buildsPlaced).toBeGreaterThanOrEqual(8);
  });
});
