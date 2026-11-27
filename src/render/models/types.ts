import type * as THREE from 'three';
import type { Activity, FactionId } from '../../core/types';

/** Per-frame animation inputs computed by the render core from the entity. */
export interface ModelAnimState {
  moving: boolean;
  /** current ground speed (world units / s) */
  speed: number;
  activity: Activity;
  /** seconds since the entity's last attack release (Infinity if never) — drive recoil / flashes */
  sinceAttack: number;
  /** 0..1 construction progress (1 = complete). Buildings only. */
  construction: number;
  hpFrac: number;
  carrying: boolean;
  producing: boolean;
  selected: boolean;
  /** 0 while alive; 0..1 during the death animation (after entityDied) */
  death: number;
  /** world-space aim angle (sim facing convention) toward the current target, or null */
  aimAngle: number | null;
  /** entity facing (sim convention); root rotation is already applied by the render core */
  facing: number;
  /** resource nodes: remaining amount / initial (1 = full). Others: 1. */
  resourceFrac: number;
}

/**
 * A live model instance. The render core owns placement: root.position = (x, groundHeight [+ flyHeight], y),
 * root.rotation.y = -facing. Model space: origin at ground centre, +X forward, +Y up, 1 unit = 1 tile.
 * Units should roughly fill their collision radius; buildings fill their footprint (w × h tiles).
 */
export interface EntityModel {
  root: THREE.Object3D;
  /** height of the model's top (health-bar anchor), world units */
  height: number;
  /** local-space point where shots originate (optional) */
  muzzle?: THREE.Vector3;
  /** true if update() animates death itself (otherwise the render core sinks & fades it) */
  handlesDeath?: boolean;
  update(state: ModelAnimState, dt: number, time: number): void;
  dispose(): void;
}

export interface ModelBuildContext {
  defId: string;
  faction: FactionId;
  teamColor: THREE.Color;
  /** collision radius (units) */
  radius: number;
  /** footprint in tiles (buildings/resources) */
  footprint?: { w: number; h: number };
  /** stable per-entity variation seed */
  seed: number;
}

export type ModelBuilder = (ctx: ModelBuildContext) => EntityModel;
/** Static doodad builder. Origin at ground centre; should fit its footprint (if any) at scale 1. */
export type DoodadBuilder = (ctx: { seed: number; scale: number }) => THREE.Object3D;
