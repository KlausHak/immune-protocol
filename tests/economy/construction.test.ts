import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/core/types';
import { activeBuilders } from '../../src/sim/economy';
import { hqOf, idleAll, newMatch, record, runUntil, spawnDone, workersOf } from './util';

const SITE = { x: 25, y: 69 }; // open ground north-east of the test-map hospital HQ

function foundationOf(w: import('../../src/sim/World').World, defId: string): Entity | undefined {
  return w.entitiesOf(1, (e) => e.defId === defId)[0];
}

describe('construction', () => {
  it('build: walk, pay on placement, construct (hp 10%→100%), complete, return to mining', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    m.runFor(4);
    const [builder, ...others] = workersOf(w);
    w.issue({ type: 'stop', playerId: 1, unitIds: others.map((u) => u.id) }); // no deliveries muddying the books
    const cache = builder!.gatherer!.nodeId;
    expect(cache).not.toBeNull();
    const started = record(w, 'constructionStarted');
    const completed = record(w, 'constructionComplete');
    w.issue({ type: 'build', playerId: 1, unitIds: [builder!.id], defId: 'hosp_ward', tile: SITE });
    m.step();
    expect(builder!.orders[0]?.type).toBe('build');
    expect(builder!.gatherer!.phase).toBe('idle');
    const matterAtCommand = p.resources.matter; // nothing paid yet
    let beforePlacement = matterAtCommand;
    expect(runUntil(m, () => { if (!started.length) beforePlacement = p.resources.matter; return started.length > 0; }, 15)).toBeGreaterThanOrEqual(0);
    const ward = started[0]!.building;
    expect(started[0]!.builder).toBe(builder);
    expect(ward.construction).toBeDefined();
    expect(ward.tile).toEqual(SITE);
    expect(beforePlacement).toBe(matterAtCommand);
    expect(p.resources.matter).toBe(beforePlacement - 100); // paid when the foundation is placed
    expect(ward.hp / ward.stats.maxHp).toBeCloseTo(0.1, 1);
    m.runFor(12);
    const c = ward.construction!;
    expect(builder!.activity).toBe('building');
    const frac = c.progress / c.total;
    expect(frac).toBeGreaterThan(0.35);
    expect(ward.hp / ward.stats.maxHp).toBeCloseTo(0.1 + 0.9 * frac, 2);
    expect(runUntil(m, () => completed.length > 0, 20)).toBeGreaterThanOrEqual(0);
    expect(ward.construction).toBeUndefined();
    expect(ward.hp).toBe(ward.stats.maxHp);
    expect(p.stats.buildingsBuilt).toBe(1);
    m.step();
    expect(p.popCap).toBe(18);
    expect(builder!.orders[0]?.type).toBe('gather');
    expect(builder!.gatherer!.nodeId).toBe(cache);
  });

  it('extra builders speed construction up (max 3) and a lone builder leaving pauses it', () => {
    const timeWith = (helpers: number): number => {
      const m = newMatch();
      const w = m.world;
      idleAll(m);
      const ws = workersOf(w);
      const started = record(w, 'constructionStarted');
      const done = record(w, 'constructionComplete');
      w.issue({ type: 'build', playerId: 1, unitIds: [ws[0]!.id], defId: 'hosp_ward', tile: SITE });
      runUntil(m, () => started.length > 0, 15);
      const b = started[0]!.building;
      if (helpers > 0) w.issue({ type: 'smart', playerId: 1, unitIds: ws.slice(1, 1 + helpers).map((u) => u.id), target: b.pos, targetId: b.id });
      const t0 = w.time;
      let maxBuilders = 0;
      runUntil(m, () => { maxBuilders = Math.max(maxBuilders, activeBuilders(w, b)); return done.length > 0; }, 60);
      expect(maxBuilders).toBe(Math.min(3, helpers + 1));
      return w.time - t0;
    };
    const t1 = timeWith(0), t2 = timeWith(1), t3 = timeWith(2), t4 = timeWith(3);
    expect(t1).toBeGreaterThan(24);
    expect(t1).toBeLessThan(27);
    expect(t2).toBeLessThan(t1 * 0.72);
    expect(t3).toBeLessThan(t2 * 0.85);
    expect(Math.abs(t4 - t3)).toBeLessThan(1.5); // a 4th helper doesn't add speed

    // pause & resume
    const m = newMatch();
    const w = m.world;
    idleAll(m);
    const u = workersOf(w)[0]!;
    const started = record(w, 'constructionStarted');
    w.issue({ type: 'build', playerId: 1, unitIds: [u.id], defId: 'hosp_ward', tile: SITE });
    runUntil(m, () => started.length > 0, 15);
    const b = started[0]!.building;
    m.runFor(5);
    w.issue({ type: 'move', playerId: 1, unitIds: [u.id], target: { x: SITE.x + 10, y: SITE.y - 8 } });
    m.runFor(1);
    const prog = b.construction!.progress;
    m.runFor(5);
    expect(b.construction!.progress).toBeCloseTo(prog, 5);
    w.issue({ type: 'smart', playerId: 1, unitIds: [u.id], target: b.pos, targetId: b.id });
    m.step();
    expect(u.orders[0]?.type).toBe('construct');
    expect(runUntil(m, () => !b.construction, 40)).toBeGreaterThan(0);
  });

  it('cancelling a foundation refunds 75% and frees the builder', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    m.runFor(3);
    const u = workersOf(w)[0]!;
    const started = record(w, 'constructionStarted');
    const cancelled = record(w, 'constructionCancelled');
    w.issue({ type: 'build', playerId: 1, unitIds: [u.id], defId: 'hosp_pharmacy', tile: SITE });
    runUntil(m, () => started.length > 0, 15);
    const b = started[0]!.building;
    m.runFor(3);
    p.resources.matter = 0;
    w.issue({ type: 'cancelConstruction', playerId: 1, buildingId: b.id });
    m.step();
    expect(cancelled.length).toBe(1);
    expect(b.alive).toBe(false);
    expect(p.resources.matter).toBeCloseTo(150 * 0.75, 5);
    m.step();
    expect(w.get(b.id)).toBeUndefined();
    expect(u.orders[0]?.type).toBe('gather'); // it came from mining
  });

  it('shift-queued builds are done in order, then the worker returns to its cache', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    p.resources.matter = 400;
    m.runFor(3);
    const u = workersOf(w)[0]!;
    const cache = u.gatherer!.nodeId;
    const done = record(w, 'constructionComplete');
    w.issue({ type: 'build', playerId: 1, unitIds: [u.id], defId: 'hosp_ward', tile: SITE, queue: true });
    w.issue({ type: 'build', playerId: 1, unitIds: [u.id], defId: 'hosp_generator', tile: { x: SITE.x + 4, y: SITE.y }, queue: true });
    m.step();
    expect(u.orders.map((o) => o.type)).toEqual(['build', 'build']);
    expect(runUntil(m, () => done.length >= 2, 90)).toBeGreaterThan(0);
    expect(done.map((d) => d.building.defId)).toEqual(['hosp_ward', 'hosp_generator']);
    m.step();
    expect(u.orders[0]?.type).toBe('gather');
    expect(u.gatherer!.nodeId).toBe(cache);
  });

  it('reports why a build cannot start (resources, requirements, placement)', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    idleAll(m);
    const u = workersOf(w)[0]!;
    const msgs = record(w, 'notEnough');
    p.resources.matter = 20;
    w.issue({ type: 'build', playerId: 1, unitIds: [u.id], defId: 'hosp_ward', tile: SITE });
    m.runFor(0.5);
    expect(msgs.at(-1)).toEqual({ playerId: 1, kind: 'matter', message: 'Not enough Supplies' });
    expect(u.orders.length).toBe(0);
    p.resources.matter = 500;
    w.issue({ type: 'build', playerId: 1, unitIds: [u.id], defId: 'hosp_lab', tile: SITE });
    m.runFor(0.5);
    expect(msgs.at(-1)).toEqual({ playerId: 1, kind: 'requirement', message: 'Requires Pharmacy' });
    p.resources.energy = 100;
    w.issue({ type: 'build', playerId: 1, unitIds: [u.id], defId: 'hosp_ward', tile: { x: 20, y: 46 } }); // the pond
    m.runFor(0.5);
    expect(msgs.at(-1)?.kind).toBe('placement');
    expect(w.entitiesOf(1, (e) => e.kind === 'building').length).toBe(1);
    expect(p.resources.matter).toBe(500);
  });

  it('canPlaceBuilding enforces the placement rules', () => {
    const m = newMatch();
    const w = m.world;
    const eco = w.economy;
    // fog: the far side of the map starts unexplored
    expect(eco.canPlaceBuilding(1, 'hosp_ward', { x: 50, y: 30 })).toMatchObject({ ok: false, reason: "Can't build in unexplored territory" });
    w.vision.revealAll(1, true);
    m.step();
    const hq = hqOf(w);
    expect(eco.canPlaceBuilding(1, 'hosp_ward', SITE).ok).toBe(true);
    expect(eco.canPlaceBuilding(1, 'hosp_ward', { x: -1, y: 10 }).ok).toBe(false); // out of bounds
    expect(eco.canPlaceBuilding(1, 'hosp_ward', { x: 94, y: 10 }).ok).toBe(false); // map border (unbuildable)
    expect(eco.canPlaceBuilding(1, 'hosp_ward', { x: 21, y: 47 }).ok).toBe(false); // pond
    expect(eco.canPlaceBuilding(1, 'hosp_ward', { x: 62, y: 50 }).ok).toBe(false); // granite
    expect(eco.canPlaceBuilding(1, 'hosp_ward', { x: hq.tile!.x + 1, y: hq.tile!.y + 1 }).ok).toBe(false); // on the HQ
    const cache = w.list.find((e) => e.kind === 'resource' && Math.abs(e.pos.x - 44) < 0.1 && Math.abs(e.pos.y - 44) < 0.1)!;
    const onCache = eco.canPlaceBuilding(1, 'hosp_ward', { x: cache.tile!.x, y: cache.tile!.y });
    expect(onCache.ok).toBe(false);
    expect(onCache.reason).toMatch(/Supply Cache/);
    // HQ needs 3 tiles of clearance from every cache footprint (cache at 43..45 x 43..45)
    const tooClose = eco.canPlaceBuilding(1, 'hosp_hq', { x: 46, y: 36 }); // 2 tiles above the (52,44) cache
    expect(tooClose).toMatchObject({ ok: false, reason: 'Too close to a Supply Cache' });
    expect(eco.canPlaceBuilding(1, 'hosp_hq', { x: 46, y: 34 }).ok).toBe(true); // 4 tiles clearance
    // requirements
    expect(eco.canPlaceBuilding(1, 'hosp_lab', SITE)).toMatchObject({ ok: false, reason: 'Requires Pharmacy' });
    // objective buildings are never constructible
    expect(eco.canPlaceBuilding(1, 'obj_childrens_hospital', { x: 30, y: 60 }).ok).toBe(false);
    // friendly units on the site are pushed away (not blocking); enemy units block
    const friend = w.spawnUnit('hosp_sanitizer', 1, { x: SITE.x + 1, y: SITE.y + 1 });
    w.spatial.rebuild();
    expect(eco.canPlaceBuilding(1, 'hosp_ward', SITE).ok).toBe(true);
    w.removeEntity(friend);
    m.step();
    w.spawnUnit('path_phage', 2, { x: SITE.x + 1, y: SITE.y + 1 });
    w.spatial.rebuild();
    expect(eco.canPlaceBuilding(1, 'hosp_ward', SITE)).toMatchObject({ ok: false, reason: 'Something is in the way' });
    // unexplored ground
    const vision = w.vision;
    const orig = vision.isExplored.bind(vision);
    vision.isExplored = (pid, pt) => (pt.x > 60 ? false : orig(pid, pt));
    expect(eco.canPlaceBuilding(1, 'hosp_ward', { x: 70, y: 70 })).toMatchObject({ ok: false, reason: "Can't build in unexplored territory" });
    expect(eco.canPlaceBuilding(1, 'hosp_ward', { x: 50, y: 70 }).ok).toBe(true);
    vision.isExplored = orig;
  });

  it('placeFoundation spends, spawns at 10% hp and emits constructionStarted (no builder needed)', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    const started = record(w, 'constructionStarted');
    const b = w.economy.placeFoundation(1, 'hosp_generator', SITE, null)!;
    expect(b).toBeTruthy();
    expect(p.resources.matter).toBe(50);
    expect(b.construction).toMatchObject({ progress: 0, builderId: null, costPaid: { matter: 100 } });
    expect(started[0]).toEqual({ building: b, builder: null });
    m.runFor(5);
    expect(b.construction!.progress).toBe(0); // nobody builds it
    expect(w.economy.placeFoundation(1, 'hosp_generator', SITE, null)).toBeNull(); // occupied now
    p.resources.matter = 0;
    const msgs = record(w, 'notEnough');
    expect(w.economy.placeFoundation(1, 'hosp_generator', { x: SITE.x + 4, y: SITE.y }, null)).toBeNull();
    expect(msgs[0]).toEqual({ playerId: 1, kind: 'matter', message: 'Not enough Supplies' });
    // completed buildings count for requirements; foundations don't
    spawnDone(w, 'hosp_pharmacy', 1, { x: 30, y: 60 });
    expect(w.economy.meetsRequirements(1, ['hosp_pharmacy'])).toBe(true);
    expect(w.economy.meetsRequirements(1, ['hosp_generator'])).toBe(false);
  });
});

describe('construction (shared sites)', () => {
  it('a second worker sent to build the same structure on the same site helps instead of failing', () => {
    const m = newMatch();
    const w = m.world;
    const p = w.player(1);
    p.resources.matter = 400;
    idleAll(m);
    const [a, b] = workersOf(w);
    const msgs = record(w, 'notEnough');
    w.issue({ type: 'build', playerId: 1, unitIds: [a!.id], defId: 'hosp_ward', tile: SITE });
    w.issue({ type: 'build', playerId: 1, unitIds: [b!.id], defId: 'hosp_ward', tile: SITE });
    const done = record(w, 'constructionComplete');
    expect(runUntil(m, () => done.length > 0, 30)).toBeGreaterThan(0);
    expect(w.entitiesOf(1, (e) => e.defId === 'hosp_ward').length).toBe(1);
    expect(p.resources.matter).toBe(300); // paid once
    expect(msgs.filter((x) => x.playerId === 1).length).toBe(0);
  });
});
