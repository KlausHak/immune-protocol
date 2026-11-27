/**
 * Model registry/dispatcher. OWNER: architect. Artists register builders in ./hospital and ./pathogen.
 * Missing ids fall back to readable placeholders so the game always renders.
 */
import * as THREE from 'three';
import type { DoodadKind } from '../../core/types';
import { tryGetDef } from '../../data';
import { HOSPITAL_MODELS, CAMPUS_DOODADS } from './hospital';
import { PATHOGEN_MODELS, INFECTION_DOODADS } from './pathogen';
import type { DoodadBuilder, EntityModel, ModelAnimState, ModelBuildContext, ModelBuilder } from './types';

export type { EntityModel, ModelAnimState, ModelBuildContext, ModelBuilder, DoodadBuilder } from './types';

export function getModelBuilder(defId: string): ModelBuilder | undefined {
  return HOSPITAL_MODELS[defId] ?? PATHOGEN_MODELS[defId];
}

export function createEntityModel(ctx: ModelBuildContext): EntityModel {
  const b = getModelBuilder(ctx.defId);
  if (b) {
    try { return b(ctx); } catch (err) { console.error(`[models] builder for ${ctx.defId} threw`, err); }
  }
  return placeholderModel(ctx);
}

export function createDoodad(kind: DoodadKind, seed: number, scale = 1): THREE.Object3D {
  const b: DoodadBuilder | undefined = CAMPUS_DOODADS[kind] ?? INFECTION_DOODADS[kind];
  if (b) {
    try { return b({ seed, scale }); } catch (err) { console.error(`[models] doodad ${kind} threw`, err); }
  }
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.9 }));
  m.position.y = 0.5; m.scale.setScalar(scale);
  const g = new THREE.Group(); g.add(m); g.name = `doodad:${kind}`;
  return g;
}

const placeholderGeo = { box: new THREE.BoxGeometry(1, 1, 1), sphere: new THREE.SphereGeometry(0.5, 16, 12), cone: new THREE.ConeGeometry(0.25, 0.5, 8) };

export function placeholderModel(ctx: ModelBuildContext): EntityModel {
  const def = tryGetDef(ctx.defId);
  const root = new THREE.Group();
  root.name = `model:${ctx.defId}`;
  const body = new THREE.Group();
  root.add(body);
  const color = ctx.faction === 'neutral' ? new THREE.Color(0xd8b25a) : ctx.teamColor;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 });
  let height = 1;
  if (def?.kind === 'building' || def?.kind === 'resource') {
    const fp = ctx.footprint ?? { w: 2, h: 2 };
    height = def.kind === 'resource' ? 0.9 : 1 + Math.min(fp.w, fp.h) * 0.45;
    const m = new THREE.Mesh(placeholderGeo.box, mat);
    m.scale.set(fp.w * 0.92, height, fp.h * 0.92); m.position.y = height / 2;
    m.castShadow = m.receiveShadow = true; body.add(m);
  } else {
    const r = ctx.radius; height = r * 2.2;
    const m = new THREE.Mesh(placeholderGeo.sphere, mat);
    m.scale.set(r * 2, r * 2.2, r * 2); m.position.y = r * 1.1; m.castShadow = true; body.add(m);
    const nose = new THREE.Mesh(placeholderGeo.cone, new THREE.MeshStandardMaterial({ color: 0xffffff }));
    nose.rotation.z = -Math.PI / 2; nose.position.set(r, r * 1.1, 0); body.add(nose);
  }
  return {
    root, height,
    update(state: ModelAnimState, _dt: number, time: number) {
      // animate children only — the render core owns root's transform
      if (def?.kind === 'building') body.scale.y = 0.2 + 0.8 * state.construction;
      else body.position.y = state.moving ? Math.abs(Math.sin(time * 10)) * 0.05 : 0;
    },
    dispose() { mat.dispose(); },
  };
}
