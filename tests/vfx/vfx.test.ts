/**
 * [vfx] Headless checks for the VFX system: three.js core classes (geometry, materials, DataTexture) work in
 * Node without a WebGL context, so we can drive the full event → effect pipeline against a real World.
 */
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleHeight } from '../../src/core/terrain';
import type { Entity, Projectile } from '../../src/core/types';
import { getUnitDef } from '../../src/data';
import { createHeadlessMatch } from '../../src/game/headless';
import { VfxSystem } from '../../src/render/vfx';
import type { World } from '../../src/sim/World';

function makeVfx(world: World, quality: 'low' | 'medium' | 'high' = 'high', seed = 99) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.5, 400);
  camera.position.set(44, 28, 72);
  camera.lookAt(44, 0, 53);
  camera.updateMatrixWorld();
  const vfx = new VfxSystem({
    scene, camera, world, localPlayerId: 1, quality, seed,
    getEntityModel: () => undefined,
    heightAt: (x, y) => sampleHeight(world.map, x, y),
  });
  return { scene, camera, vfx };
}

function lineUp(world: World): Entity[] {
  const out: Entity[] = [];
  const hosp = ['hosp_sanitizer', 'hosp_uv_lancer', 'hosp_antibiotic_launcher', 'hosp_macrophage', 'hosp_sterilizer_drone', 'hosp_orderly'];
  const path = ['path_phage', 'path_bacillus', 'path_fungal_mortar', 'path_superbug', 'path_flu_drifter', 'path_spirochete'];
  hosp.forEach((id, i) => out.push(world.spawnUnit(id, 1, { x: 40 + i * 1.3, y: 50 }, { facing: Math.PI / 2 })));
  path.forEach((id, i) => out.push(world.spawnUnit(id, 2, { x: 40 + i * 1.3, y: 55 }, { facing: -Math.PI / 2 })));
  return out;
}

/** step the sim and render-side VFX like the browser loop (3 frames per tick) */
function run(world: World, vfx: VfxSystem, seconds: number): void {
  const ticks = Math.round(seconds / world.dt);
  for (let i = 0; i < ticks; i++) {
    world.step();
    for (let f = 1; f <= 3; f++) vfx.update(1 / 60, world.time, f / 3);
  }
}

describe('VfxSystem (headless)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, 'error'); });
  afterEach(() => { errSpy.mockRestore(); });

  it('survives a real skirmish fight without errors and stays within its caps', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: false, seed: 3 });
    const { vfx, scene } = makeVfx(m.world);
    expect(scene.getObjectByName('vfx')).toBeTruthy();
    lineUp(m.world);
    run(m.world, vfx, 20);
    const s = vfx.stats();
    expect(s.particlesAlive).toBeLessThanOrEqual(s.particleCapacity);
    expect(s.pressure).toBeGreaterThan(0);
    expect(s.pressure).toBeLessThanOrEqual(1);
    expect(errSpy).not.toHaveBeenCalled();
    vfx.dispose();
    expect(scene.getObjectByName('vfx')).toBeUndefined();
  });

  it('tracks sim projectiles every frame and releases them when they leave world.projectiles', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: false });
    const w = m.world;
    const { vfx } = makeVfx(w);
    const src = w.spawnUnit('hosp_antibiotic_launcher', 1, { x: 40, y: 50 });
    const weapon = getUnitDef('hosp_antibiotic_launcher').weapons[0]!;
    const p: Projectile = {
      id: w.nextProjectileId++, ownerPlayer: 1, sourceId: src.id, targetId: null, weapon, vfx: weapon.vfx,
      pos: { x: 40, y: 50 }, prevPos: { x: 40, y: 50 }, start: { x: 40, y: 50 }, targetPos: { x: 46, y: 50 },
      t: 0, prevT: 0, speed: 9, arc: true, damage: 28, splashRadius: 1.8, startHeight: 0.8, endHeight: 0.1,
    };
    w.projectiles.push(p);
    w.events.emit('weaponFired', { source: src, target: null, targetPos: { x: 46, y: 50 }, weapon, projectile: p });
    vfx.update(1 / 60, 0, 0.5);
    expect(vfx.stats().projectiles).toBe(1);
    p.t = 0.5; p.pos.x = 43;
    vfx.update(1 / 60, 0, 1);
    expect(vfx.stats().projectiles).toBe(1);
    w.projectiles.length = 0;
    w.events.emit('projectileImpact', { projectile: p, pos: { x: 46, y: 50 }, target: null });
    vfx.update(1 / 60, 0, 1);
    expect(vfx.stats().projectiles).toBe(0);
    expect(vfx.stats().decals).toBeGreaterThan(0); // teal splash stain
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('gives instant-hit projectile weapons (stub combat) a visual flight that completes', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: false });
    const w = m.world;
    const { vfx } = makeVfx(w);
    const src = w.spawnUnit('path_bacillus', 2, { x: 42, y: 55 });
    const tgt = w.spawnUnit('hosp_orderly', 1, { x: 42, y: 51 });
    const weapon = getUnitDef('path_bacillus').weapons[0]!;
    w.events.emit('weaponFired', { source: src, target: tgt, targetPos: { ...tgt.pos }, weapon, projectile: null });
    vfx.update(1 / 60, 0, 1);
    expect(vfx.stats().projectiles).toBe(1);
    run(w, vfx, 1);
    expect(vfx.stats().projectiles).toBe(0);
  });

  it('plays every death / ability / feedback path without throwing', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: false });
    const w = m.world;
    const { vfx } = makeVfx(w);
    const ents = lineUp(w);
    const hq = w.entitiesOf(1, (e) => e.defId === 'hosp_hq')[0]!;
    const lancer = ents.find((e) => e.defId === 'hosp_uv_lancer')!;
    w.events.emit('abilityUsed', { source: lancer, abilityId: 'uv_flare', target: { x: 44, y: 54 }, targetEntity: null });
    w.events.emit('abilityUsed', { source: hq, abilityId: 'emergency_supply', target: null, targetEntity: null });
    const omega = w.spawnUnit('path_strain_omega', 2, { x: 48, y: 58 });
    w.events.emit('abilityUsed', { source: omega, abilityId: 'omega_spawn', target: null, targetEntity: null });
    w.events.emit('entityHealed', { entity: lancer, amount: 1, source: ents.find((e) => e.defId === 'hosp_sanitizer')! });
    const ward = w.spawnBuilding('hosp_ward', 1, { x: 30, y: 60 }, { complete: false });
    w.events.emit('constructionStarted', { building: ward, builder: null });
    for (const e of ents) w.killEntity(e, null);
    w.killEntity(ward, null);
    run(w, vfx, 6);
    for (const k of ['spray', 'uv_beam', 'engulf', 'zap', 'bite', 'whip', 'slam', 'antibiotic_capsule', 'laser', 'acid_spit', 'spore_lob', 'toxin_bolt',
      'impact', 'death_pathogen', 'death_pathogen_massive', 'death_machine', 'death_drone', 'death_staff', 'death_hospital_building',
      'death_pathogen_building', 'explosion', 'hit_metal', 'hit_goo', 'hit_staff', 'heal', 'repair', 'construction_complete',
      'production_complete', 'delivery', 'uv_flare', 'emergency_supply', 'viral_burst', 'omega_spawn'] as const) {
      vfx.spawnEffect(k, { x: 44, y: 53 });
    }
    run(w, vfx, 6);
    expect(vfx.stats().helicopters).toBe(0); // the supply runs finished
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('throttles under overload instead of growing (pressure < 1) and recovers', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: false });
    const w = m.world;
    const { vfx } = makeVfx(w, 'low');
    for (let i = 0; i < 30; i++) {
      for (let k = 0; k < 20; k++) vfx.spawnEffect('death_pathogen_massive', { x: 40 + (k % 5), y: 50 + Math.floor(k / 5) }, { scale: 3 });
      vfx.update(1 / 60, 0, 1);
    }
    const s = vfx.stats();
    expect(s.pressure).toBeLessThan(1);
    expect(s.particlesAlive).toBeLessThanOrEqual(s.particleCapacity);
    run(w, vfx, 8);
    expect(vfx.stats().pressure).toBeGreaterThan(0.9);
  });

  it('respects fog of war: nothing spawns where the local player has no vision', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: false });
    const w = m.world;
    w.vision.isVisible = () => false;
    w.vision.isEntityVisible = (_p, e) => e.owner === 1;
    const { vfx } = makeVfx(w);
    const a = w.spawnUnit('path_bacillus', 2, { x: 42, y: 55 });
    const b = w.spawnUnit('path_phage', 2, { x: 43, y: 55 });
    w.killEntity(b, a);
    vfx.update(1 / 60, 0, 1);
    expect(vfx.stats().particlesAlive).toBe(0);
    expect(vfx.stats().decals).toBe(0);
    vfx.spawnEffect('death_pathogen', { x: 44, y: 55 }, { ignoreFog: true });
    vfx.update(1 / 60, 0, 1);
    expect(vfx.stats().particlesAlive).toBeGreaterThan(0);
  });

  it('is deterministic for a given seed', () => {
    const snap = () => {
      const m = createHeadlessMatch({ mapId: 'test', enemyAi: false, seed: 5 });
      const { vfx } = makeVfx(m.world, 'high', 42);
      lineUp(m.world);
      run(m.world, vfx, 5);
      return vfx.stats();
    };
    expect(snap()).toEqual(snap());
  });

  it('dispose() unsubscribes from world events', () => {
    const m = createHeadlessMatch({ mapId: 'test', enemyAi: false });
    const w = m.world;
    const { vfx } = makeVfx(w);
    vfx.dispose();
    const u = w.spawnUnit('path_phage', 2, { x: 44, y: 55 });
    expect(() => { w.killEntity(u, null); w.step(); vfx.update(1 / 60, 0, 1); }).not.toThrow();
    expect(errSpy).not.toHaveBeenCalled();
  });
});
