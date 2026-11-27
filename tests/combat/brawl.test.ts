import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerId } from '../../src/core/types';
import type { World } from '../../src/sim/World';
import { combatWorld, spawn } from './helpers';

const HOSP: Record<string, number> = {
  hosp_sanitizer: 16, hosp_medic: 6, hosp_uv_lancer: 6, hosp_antibiotic_launcher: 4, hosp_macrophage: 4, hosp_sterilizer_drone: 4,
};
const PATH: Record<string, number> = {
  path_phage: 14, path_bacillus: 10, path_spirochete: 6, path_fungal_mortar: 4, path_superbug: 3, path_flu_drifter: 3,
};

function army(w: World, owner: PlayerId, comp: Record<string, number>, x0: number, y0: number, scale = 1): number[] {
  const ids: number[] = [];
  let i = 0;
  for (const [defId, n] of Object.entries(comp)) for (let k = 0; k < n * scale; k++, i++) {
    const col = i % 10, row = Math.floor(i / 10);
    ids.push(spawn(w, defId, owner, { x: x0 + (owner === 1 ? -row * 1.3 : row * 1.3), y: y0 + col * 1.7 }).id);
  }
  return ids;
}

const alive = (w: World, owner: PlayerId) => w.entitiesOf(owner, (e) => e.kind === 'unit').length;

function checkInvariants(w: World): string[] {
  const bad: string[] = [];
  for (const e of w.list) {
    if (!e.alive) continue;
    if (!(e.hp > 0) || e.hp > e.stats.maxHp + 1e-6) bad.push(`hp ${e.defId}#${e.id}=${e.hp}`);
    if (!Number.isFinite(e.pos.x) || !Number.isFinite(e.pos.y) || !Number.isFinite(e.facing)) bad.push(`pos ${e.defId}#${e.id}`);
    if (e.combat && (!Number.isFinite(e.combat.cooldown) || !Number.isFinite(e.combat.windupLeft))) bad.push(`combat ${e.defId}#${e.id}`);
    if (e.combat?.targetId != null && !w.getAlive(e.combat.targetId) && w.get(e.combat.targetId)?.alive) bad.push(`target ${e.id}`);
  }
  for (const p of w.projectiles) if (!Number.isFinite(p.pos.x) || !Number.isFinite(p.t) || p.t < 0 || p.t > 1) bad.push(`proj ${p.id}`);
  return bad;
}

describe('battles', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errors = vi.spyOn(console, 'error'); });
  afterEach(() => { errors.mockRestore(); });

  it('a 40-vs-40 brawl finishes with a winner and no exceptions', () => {
    const w = combatWorld(3);
    const h = army(w, 1, HOSP, 44, 62);
    const p = army(w, 2, PATH, 70, 62);
    expect(h).toHaveLength(40);
    expect(p).toHaveLength(40);
    w.issue({ type: 'attackMove', playerId: 1, unitIds: h, target: { x: 80, y: 70 } });
    w.issue({ type: 'attackMove', playerId: 2, unitIds: p, target: { x: 36, y: 70 } });
    const bad: string[] = [];
    let t = 0;
    for (; t < 20 * 240; t++) {
      w.step();
      if (t % 20 === 0) bad.push(...checkInvariants(w));
      if (alive(w, 1) === 0 || alive(w, 2) === 0) break;
    }
    const hl = alive(w, 1), pl = alive(w, 2);
    console.log(`[brawl] ${(t / 20).toFixed(1)} s → hospital ${hl} left, pathogen ${pl} left`);
    expect(hl === 0 || pl === 0).toBe(true);
    expect(hl + pl).toBeGreaterThan(0);
    expect(bad).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    w.runFor(5);
    expect(w.projectiles).toHaveLength(0);
  });

  it('performance: 300 units fighting — bounded acquisition work and per-tick time', () => {
    const w = combatWorld(5);
    const h = army(w, 1, HOSP, 44, 52, 3.75); // ~150
    const p = army(w, 2, PATH, 72, 52, 3.75); // ~150
    expect(h.length + p.length).toBeGreaterThanOrEqual(300);
    w.issue({ type: 'attackMove', playerId: 1, unitIds: h, target: { x: 85, y: 70 } });
    w.issue({ type: 'attackMove', playerId: 2, unitIds: p, target: { x: 30, y: 70 } });
    w.runFor(3); // close in
    // deterministic work proxy: spatial queries per tick (scans are staggered / near-first / skipped when alone)
    let queries = 0;
    const sp = w.spatial, q = sp.queryRadius.bind(sp);
    sp.queryRadius = (a, b, c, d) => { queries++; return q(a, b, c, d); };
    const ticks = 200;
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    for (let i = 0; i < ticks; i++) w.step();
    const avg = (performance.now() - t0) / ticks;
    const cpu = process.cpuUsage(c0);
    const fighting = w.list.filter((e) => e.alive && e.activity === 'attacking').length;
    console.log(`[perf] ${(queries / ticks).toFixed(1)} queries/tick · world.step avg ${avg.toFixed(2)} ms wall, ${((cpu.user + cpu.system) / 1000 / ticks).toFixed(2)} ms cpu (whole tick incl. stub movement & default spatial index) · ${fighting} attacking, ${alive(w, 1) + alive(w, 2)} alive`);
    expect(fighting).toBeGreaterThan(40);
    expect(queries / ticks).toBeLessThan(60); // ~0.2 per unit per tick at most
    expect(avg).toBeLessThan(40); // sanity only — this box is shared by many processes; typical ≈ 3–5 ms
    expect(errors).not.toHaveBeenCalled();
  });
});
