import { describe, expect, it } from 'vitest';
import { createAi, type PathogenAi } from '../../src/ai';
import { dist } from '../../src/core/math';
import { createHeadlessMatch } from '../../src/game/headless';
import { aiMatch } from './helpers';

describe('AI campaign hooks & contracts', () => {
  it('attack:false builds and techs but never attacks for 10 minutes', () => {
    const { m, ai } = aiMatch({ difficulty: 'normal', personality: 'swarm', seed: 4 });
    ai.setFlags({ attack: false });
    expect(ai.getFlags()).toMatchObject({ attack: false, economy: true, build: true, army: true, expand: true, defend: true });
    const w = m.world;
    let hits = 0;
    w.events.on('entityDamaged', ({ entity }) => { if (entity.owner === 1) hits++; });
    const p1hq = w.entitiesOf(1, (e) => e.kind === 'building')[0]!;
    let closest = Infinity;
    m.runFor(600, () => {
      if (w.tick % 20) return;
      for (const u of w.entitiesOf(2, (e) => e.kind === 'unit')) closest = Math.min(closest, dist(u.pos, p1hq.pos));
    });
    const st = ai.debugState();
    expect(st.wavesLaunched).toBe(0);
    expect(hits).toBe(0);
    expect(closest, 'closest pathogen unit to the hospital HQ').toBeGreaterThan(25);
    expect(st.army).toBeGreaterThan(10);
    expect(w.countOf(2, 'path_mutation_pit')).toBeGreaterThanOrEqual(1);
    expect(w.rules.gameOver).toBe(false);
    expect(ai.describe()).toContain('next wave off');
    // attackNow launches immediately even with attack:false
    const target = { x: p1hq.pos.x, y: p1hq.pos.y };
    ai.attackNow(target);
    m.runFor(1);
    expect(ai.debugState().wavesLaunched).toBe(1);
    expect(ai.debugState().squad?.state).toBeDefined();
    const army = w.entitiesOf(2, (e) => e.kind === 'unit' && !e.gatherer && e.def.kind === 'unit' && e.def.weapons.length > 0);
    expect(army.filter((u) => u.orders[0]?.type === 'attackMove').length).toBeGreaterThan(army.length / 2);
    ai.setAttackTarget({ x: 40, y: 60 });
    m.runFor(1);
    expect(ai.debugState().squad?.target).toEqual({ x: 40, y: 60 });
    ai.setAttackTarget(null);
    expect(ai.debugState().errors).toBe(0);
  });

  it('sendWave spawns units for free near spawnAt and attack-moves them', () => {
    const { m, ai } = aiMatch({ seed: 5 });
    const w = m.world;
    const before = { ...w.player(2).resources };
    const spawnAt = { x: 48, y: 30 }, target = { x: 20, y: 76 };
    const ids = ai.sendWave({ path_phage: 4, path_bacillus: 2, bogus_unit: 3 }, spawnAt, target);
    expect(ids).toHaveLength(6);
    expect(w.player(2).resources).toEqual(before);
    m.runFor(0.2);
    for (const id of ids) {
      const u = w.getAlive(id)!;
      expect(u.owner).toBe(2);
      expect(u.orders[0]?.type).toBe('attackMove');
    }
    const start = ids.map((id) => dist(w.getAlive(id)!.pos, target));
    m.runFor(8);
    const alive = ids.map((id) => w.getAlive(id)).filter(Boolean);
    expect(alive.length).toBe(6);
    alive.forEach((u, i) => expect(dist(u!.pos, target)).toBeLessThan(start[i]! - 8));
    // wave units stay script-controlled: the AI never adds them to its own army
    expect(ai.debugState().army).toBe(0);
  });

  it('difficulty sets gatherMul (and can be changed at runtime)', () => {
    const expected = { easy: 0.8, normal: 1.0, hard: 1.2, brutal: 1.5 } as const;
    for (const [d, mul] of Object.entries(expected)) {
      const m = createHeadlessMatch({ mapId: 'test', difficulty: d as keyof typeof expected });
      expect(m.world.player(2).gatherMul).toBeCloseTo(mul);
    }
    const m = createHeadlessMatch({ mapId: 'test', difficulty: 'normal' });
    m.ais[0]!.difficulty = 'brutal';
    expect(m.world.player(2).gatherMul).toBeCloseTo(1.5);
  });

  it('is deterministic: same seed → identical match', () => {
    const run = (): string => {
      const m = createHeadlessMatch({ mapId: 'test', difficulty: 'normal', seed: 42 });
      m.runFor(200);
      const ents = m.world.list.filter((e) => e.alive).map((e) => `${e.id}:${e.defId}:${e.pos.x.toFixed(3)},${e.pos.y.toFixed(3)}:${e.hp.toFixed(2)}`);
      const r = m.world.player(2).resources;
      return `${ents.join('|')}#${r.matter.toFixed(3)},${r.energy.toFixed(3)}#${m.ais[0]!.describe()}`;
    };
    expect(run()).toBe(run());
  });

  it('personality is picked per seed (varies across seeds)', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const m = createHeadlessMatch({ mapId: 'test', seed, enemyAi: false });
      seen.add((createAi(m.world, 2, { difficulty: 'normal' }) as PathogenAi).debugState().personality);
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});
