/**
 * [vfx] OWNER: VFX agent. Projectiles (reads world.projectiles every frame), instant-hit weapon effects
 * (weaponFired with projectile=null), impacts, deaths, construction/production sparkle, heals, abilities.
 */
import * as THREE from 'three';
import type { EntityId, PlayerId } from '../../core/types';
import type { World } from '../../sim/World';
import type { EntityModel } from '../models';
import type { Quality } from '../../game/settings';

export interface VfxOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: World;
  localPlayerId: PlayerId;
  quality: Quality;
  /** live model for an entity (muzzle positions etc.), if it has one */
  getEntityModel: (id: EntityId) => EntityModel | undefined;
  /** terrain height at world (x, y) */
  heightAt: (x: number, y: number) => number;
}

export class VfxSystem {
  private group = new THREE.Group();
  private projMeshes = new Map<number, THREE.Mesh>();
  private geo = new THREE.SphereGeometry(0.12, 8, 6);
  private mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  constructor(private opts: VfxOptions) { opts.scene.add(this.group); }

  /** Called every frame. alpha = interpolation factor between the previous and current sim tick. */
  update(_dt: number, _time: number, alpha: number): void {
    const { world, heightAt } = this.opts;
    const live = new Set<number>();
    for (const p of world.projectiles) {
      live.add(p.id);
      let m = this.projMeshes.get(p.id);
      if (!m) { m = new THREE.Mesh(this.geo, this.mat); this.group.add(m); this.projMeshes.set(p.id, m); }
      const x = p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha, y = p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha;
      const t = p.prevT + (p.t - p.prevT) * alpha;
      const h = p.startHeight + (p.endHeight - p.startHeight) * t + (p.arc ? Math.sin(Math.PI * t) * 3 : 0);
      m.position.set(x, heightAt(x, y) + h, y);
    }
    for (const [id, m] of this.projMeshes) if (!live.has(id)) { this.group.remove(m); this.projMeshes.delete(id); }
  }

  dispose(): void { this.opts.scene.remove(this.group); this.geo.dispose(); this.mat.dispose(); }
}
