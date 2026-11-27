/**
 * [models-pathogen] Headless checks for the pathogen models: every unit/building def has a builder,
 * mesh budgets hold, update() is robust across all animation states, geometry/material caches are
 * shared between instances, and dispose() never frees shared resources.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ALL_BUILDINGS, ALL_UNITS } from '../../src/data';
import type { BuildingDef, UnitDef } from '../../src/core/types';
import { INFECTION_DOODADS, PATHOGEN_MODELS } from '../../src/render/models/pathogen';
import type { ModelAnimState } from '../../src/render/models/types';

const TEAM = new THREE.Color(0xd64bff);
const pathUnits = ALL_UNITS.filter((u) => u.faction === 'pathogen');
const pathBuildings = ALL_BUILDINGS.filter((b) => b.faction === 'pathogen');

function baseState(over: Partial<ModelAnimState> = {}): ModelAnimState {
  return {
    moving: false, speed: 0, activity: 'idle', sinceAttack: Infinity, construction: 1, hpFrac: 1, carrying: false,
    producing: false, selected: false, death: 0, aimAngle: null, facing: 0, resourceFrac: 1, ...over,
  };
}
const STATES: Array<Partial<ModelAnimState>> = [
  {}, { moving: true, speed: 3, activity: 'moving', carrying: true }, { sinceAttack: 0.05, aimAngle: 1.2 }, { sinceAttack: 0.5, aimAngle: -2 },
  { construction: 0 }, { construction: 0.5 }, { producing: true }, { hpFrac: 0.2 }, { death: 0.01 }, { death: 0.5 }, { death: 1 },
];

function meshes(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh); });
  return out;
}

describe('pathogen models', () => {
  it('has a builder for every pathogen unit and building', () => {
    for (const d of [...pathUnits, ...pathBuildings]) expect(PATHOGEN_MODELS[d.id], d.id).toBeTypeOf('function');
  });

  for (const def of [...pathUnits, ...pathBuildings] as Array<UnitDef | BuildingDef>) {
    it(`${def.id}: budget, animation states, shared caches`, () => {
      const isUnit = def.kind === 'unit';
      const ctx = { defId: def.id, faction: 'pathogen' as const, teamColor: TEAM, radius: isUnit ? (def as UnitDef).radius : 1, footprint: isUnit ? undefined : (def as BuildingDef).footprint };
      const t0 = performance.now();
      const a = PATHOGEN_MODELS[def.id]!({ ...ctx, seed: 1 });
      const buildMs = performance.now() - t0;
      const b = PATHOGEN_MODELS[def.id]!({ ...ctx, seed: 1 });
      const ma = meshes(a.root), mb = meshes(b.root);
      const budget = def.id === 'path_strain_omega' ? 20 : isUnit ? 6 : 20;
      expect(ma.length, `${def.id} mesh count`).toBeLessThanOrEqual(budget);
      expect(ma.length).toBeGreaterThan(0);
      expect(a.height).toBeGreaterThan(0.3);
      expect(a.handlesDeath).toBe(true);
      // same seed → identical shared geometry & materials, never per-instance copies
      ma.forEach((m, i) => { expect(mb[i]!.geometry).toBe(m.geometry); expect(mb[i]!.material).toBe(m.material); });
      let dt = 0.016, time = 0;
      for (const s of STATES) for (let f = 0; f < 3; f++) { time += dt; a.update(baseState(s), dt, time); }
      a.update(baseState(), 0, time); // zero dt
      a.update(baseState({ moving: true, speed: 50 }), 5, time + 5); // huge dt / speed
      for (const m of meshes(a.root)) {
        const e = m.matrixWorld.elements; // matrices must stay finite
        a.root.updateMatrixWorld(true);
        expect(e.every(Number.isFinite), `${def.id} finite matrix`).toBe(true);
      }
      if (a.muzzle) expect([a.muzzle.x, a.muzzle.y, a.muzzle.z].every(Number.isFinite)).toBe(true);
      // geometry fits roughly inside the footprint / radius (bounding box of the static pose)
      a.update(baseState(), 0.016, 100);
      a.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(a.root);
      const size = box.getSize(new THREE.Vector3());
      if (!isUnit) {
        const fp = (def as BuildingDef).footprint;
        expect(size.x, `${def.id} width`).toBeLessThanOrEqual(fp.w * 1.45);
        expect(size.z, `${def.id} depth`).toBeLessThanOrEqual(fp.h * 1.45);
      }
      // dispose must not free shared geometry
      let disposed = false;
      ma[0]!.geometry.addEventListener('dispose', () => { disposed = true; });
      a.dispose();
      expect(disposed).toBe(false);
      b.dispose();
      expect(buildMs, `${def.id} first build time`).toBeLessThan(4000);
    });
  }

  it('doodad builders return static objects at scale', () => {
    for (const [kind, build] of Object.entries(INFECTION_DOODADS)) {
      const o = build!({ seed: 3, scale: 1 });
      const o2 = build!({ seed: 3, scale: 2 });
      expect(meshes(o).length, kind).toBeGreaterThan(0);
      const s1 = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
      const s2 = new THREE.Box3().setFromObject(o2).getSize(new THREE.Vector3());
      expect(s2.x / s1.x, `${kind} scales`).toBeCloseTo(2, 1);
    }
  });
});
