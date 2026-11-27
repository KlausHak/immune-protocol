/**
 * [qa] FAST cross-module contract checks (map ↔ setup ↔ campaign ↔ movement), cheap and structural:
 * every registered map is well-formed and skirmish-startable, starts are mutually reachable by ground,
 * getMap() returns fresh data, meilahti has the regions/points DESIGN §6 requires, campaign missions point
 * at registered maps.
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGN } from '../../src/campaign';
import { createHeadlessMatch } from '../../src/game/headless';
import { getMap, listMaps } from '../../src/map';
import { createWorld } from '../../src/sim/setup';
import { BUILDING_DEFS, FACTIONS } from '../../src/data';
import { mapRegistered } from '../helpers/match';

const MEILAHTI_REGIONS = ['player_base', 'player_natural', 'enemy_core', 'enemy_natural', 'enemy_east_nest', 'enemy_west_nest', 'childrens_hospital', 'paramedic_station', 'center', 'north_gate', 'east_gate'];
const MEILAHTI_POINTS = ['player_start', 'enemy_start', 'wave_spawn_north', 'wave_spawn_east', 'wave_spawn_west', 'omega_spawn', 'rally_center', 'helipad', 'east_nest_core', 'west_nest_core', 'childrens_hospital_center'];

describe('map contracts', () => {
  for (const info of listMaps()) {
    describe(`map "${info.id}"`, () => {
      it('is well-formed and getMap() returns fresh data', () => {
        const a = getMap(info.id), b = getMap(info.id);
        expect(a.id).toBe(info.id);
        const n = a.width * a.height;
        for (const k of ['terrain', 'levels', 'ramps', 'blocked', 'buildable'] as const) expect(a[k].length, k).toBe(n);
        expect(a.heights.length).toBe((a.width + 1) * (a.height + 1));
        expect([...a.heights].every(Number.isFinite), 'heights finite').toBe(true);
        expect(a).not.toBe(b);
        a.blocked[0] = a.blocked[0] ? 0 : 1;
        expect(b.blocked[0], 'getMap() must not share typed arrays between calls').not.toBe(a.blocked[0]);
        for (const r of a.resources) {
          expect(r.pos.x > 1 && r.pos.y > 1 && r.pos.x < a.width - 1 && r.pos.y < a.height - 1, `resource at ${r.pos.x},${r.pos.y} in bounds`).toBe(true);
        }
        for (const [name, p] of Object.entries(a.points)) expect(p.x >= 0 && p.y >= 0 && p.x <= a.width && p.y <= a.height, `point ${name}`).toBe(true);
        for (const [name, r] of Object.entries(a.regions)) expect(r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= a.width && r.y + r.h <= a.height, `region ${name}`).toBe(true);
      });

      it('has hospital slot 1 + pathogen slot 2 whose HQ footprints are buildable', () => {
        const map = getMap(info.id);
        for (const [id, faction] of [[1, 'hospital'], [2, 'pathogen']] as const) {
          const slot = map.slots.find((s) => s.id === id);
          expect(slot, `slot ${id}`).toBeTruthy();
          expect(slot!.faction).toBe(faction);
          const fp = BUILDING_DEFS[FACTIONS[faction].hq]!.footprint;
          const tx = Math.round(slot!.start.x - fp.w / 2), ty = Math.round(slot!.start.y - fp.h / 2);
          const bad: string[] = [];
          for (let y = ty; y < ty + fp.h; y++) for (let x = tx; x < tx + fp.w; x++) {
            const i = y * map.width + x;
            if (x < 0 || y < 0 || x >= map.width || y >= map.height || map.blocked[i] || !map.buildable[i]) bad.push(`${x},${y}`);
          }
          expect(bad, `slot ${id} HQ footprint tiles blocked/unbuildable`).toEqual([]);
        }
      });

      it.skipIf(!info.skirmish)('skirmish start spawns HQ + workers on walkable ground, and starts are reachable by ground', () => {
        const m = createHeadlessMatch({ mapId: info.id, enemyAi: false, seed: 1 });
        const w = m.world;
        for (const pid of [1, 2]) {
          const hq = w.entitiesOf(pid, (e) => e.kind === 'building');
          expect(hq.length, `p${pid} HQ`).toBe(1);
          const workers = w.entitiesOf(pid, (e) => !!e.gatherer);
          expect(workers.length, `p${pid} workers`).toBe(5);
          for (const u of workers) expect(w.map.blocked[Math.floor(u.pos.y) * w.map.width + Math.floor(u.pos.x)], `worker #${u.id} spawned on a blocked tile`).toBe(0);
          expect(workers.filter((u) => u.orders[0]?.type === 'gather').length, `p${pid} workers start gathering (cache within 20 tiles)`).toBeGreaterThan(0);
        }
        // ground reachability between starts on an empty world (no buildings yet)
        const empty = createWorld(getMap(info.id), [
          { id: 1, faction: 'hospital', team: 1, controller: 'human' },
          { id: 2, faction: 'pathogen', team: 2, controller: 'ai' },
        ]);
        const s1 = empty.player(1).startPos, s2 = empty.player(2).startPos;
        const path = empty.movement.findPath(s1, s2, 0.5);
        expect(path, `no ground path between starts ${s1.x},${s1.y} → ${s2.x},${s2.y}`).not.toBeNull();
      });
    });
  }
});

describe('meilahti contract (DESIGN §6)', () => {
  it.skipIf(!mapRegistered('meilahti'))('has every required region and point, expansions reachable by ground', () => {
    const map = getMap('meilahti');
    expect(MEILAHTI_REGIONS.filter((r) => !map.regions[r]), 'missing regions').toEqual([]);
    expect(MEILAHTI_POINTS.filter((p) => !map.points[p]), 'missing points').toEqual([]);
    const w = createWorld(map, [
      { id: 1, faction: 'hospital', team: 1, controller: 'human' },
      { id: 2, faction: 'pathogen', team: 2, controller: 'ai' },
    ]);
    const from = w.movement.nearestWalkable(map.points.player_start!, 6)!;
    expect(from, 'walkable ground near player_start').toBeTruthy();
    const unreachable: string[] = [];
    for (const name of ['enemy_start', 'rally_center', 'wave_spawn_north', 'wave_spawn_east', 'omega_spawn', 'east_nest_core', 'west_nest_core', 'childrens_hospital_center']) {
      const p = map.points[name];
      if (!p) continue;
      const to = w.movement.nearestWalkable(p, 6);
      if (!to || !w.movement.findPath(from, to, 0.5)) unreachable.push(name);
    }
    for (const name of ['player_natural', 'enemy_natural', 'enemy_east_nest', 'enemy_west_nest', 'paramedic_station', 'center']) {
      const r = map.regions[name];
      if (!r) continue;
      const to = w.movement.nearestWalkable({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, Math.max(r.w, r.h));
      if (!to || !w.movement.findPath(from, to, 0.5)) unreachable.push(name);
    }
    expect(unreachable, 'points/regions unreachable by ground from player_start').toEqual([]);
  });
});

describe('campaign ↔ map contract', () => {
  it('mission ids are unique and ordered', () => {
    expect(new Set(CAMPAIGN.map((m) => m.id)).size).toBe(CAMPAIGN.length);
    const orders = CAMPAIGN.map((m) => m.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });
  it.skipIf(!mapRegistered('meilahti'))('every mission references a registered map', () => {
    expect(CAMPAIGN.filter((m) => !mapRegistered(m.mapId)).map((m) => `${m.id}→${m.mapId}`)).toEqual([]);
  });
});
