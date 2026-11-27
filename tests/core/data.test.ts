import { describe, expect, it } from 'vitest';
import { ABILITY_DEFS, ALL_BUILDINGS, ALL_UNITS, ALL_UPGRADES, BUILDING_DEFS, UNIT_DEFS, UPGRADE_DEFS, FACTIONS } from '../../src/data';

describe('data integrity', () => {
  it('every referenced id exists', () => {
    const exists = (id: string) => !!(UNIT_DEFS[id] || BUILDING_DEFS[id] || UPGRADE_DEFS[id]);
    for (const u of ALL_UNITS) {
      for (const r of u.requires) expect(exists(r), `${u.id} requires ${r}`).toBe(true);
      for (const b of u.builds ?? []) expect(BUILDING_DEFS[b], `${u.id} builds ${b}`).toBeTruthy();
      for (const a of u.abilities) expect(ABILITY_DEFS[a], `${u.id} ability ${a}`).toBeTruthy();
    }
    for (const b of ALL_BUILDINGS) {
      for (const t of b.trains) expect(UNIT_DEFS[t], `${b.id} trains ${t}`).toBeTruthy();
      for (const r of b.researches) expect(UPGRADE_DEFS[r], `${b.id} researches ${r}`).toBeTruthy();
      for (const r of b.requires) expect(exists(r), `${b.id} requires ${r}`).toBe(true);
      for (const a of b.abilities) expect(ABILITY_DEFS[a], `${b.id} ability ${a}`).toBeTruthy();
      expect(b.tags).toContain('structure');
    }
    for (const u of ALL_UPGRADES) for (const r of u.requires) expect(exists(r), `${u.id} requires ${r}`).toBe(true);
  });
  it('every trainable unit has a producer of its faction and hotkeys are unique per producer card', () => {
    for (const u of ALL_UNITS.filter((x) => x.trainable !== false)) {
      const producers = ALL_BUILDINGS.filter((b) => b.trains.includes(u.id));
      expect(producers.length, `${u.id} has no producer`).toBeGreaterThan(0);
      for (const p of producers) expect(p.faction).toBe(u.faction);
    }
    for (const b of ALL_BUILDINGS) {
      const keys = [...b.trains.map((t) => UNIT_DEFS[t]!.hotkey), ...b.researches.map((r) => UPGRADE_DEFS[r]!.hotkey)];
      expect(new Set(keys).size, `${b.id} duplicate hotkeys ${keys}`).toBe(keys.length);
    }
    for (const f of ['hospital', 'pathogen'] as const) {
      const worker = UNIT_DEFS[FACTIONS[f].worker]!;
      const keys = (worker.builds ?? []).map((b) => BUILDING_DEFS[b]!.hotkey);
      expect(new Set(keys).size, `${f} build card duplicate hotkeys`).toBe(keys.length);
    }
  });
});
