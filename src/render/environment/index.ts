/**
 * [environment] OWNER: environment agent. Terrain mesh, water, sky, lighting presets, shadows,
 * doodad placement, decals and fog-of-war rendering. Created and driven by the render core.
 */
import * as THREE from 'three';
import { Terrain, type MapData, type PlayerId, type Vec2 } from '../../core/types';
import type { World } from '../../sim/World';
import type { Quality } from '../../game/settings';
import { createDoodad } from '../models';
import { sampleHeight } from '../../core/terrain';

export interface EnvironmentOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  world: World;
  map: MapData;
  localPlayerId: PlayerId;
  quality: Quality;
}

const TERRAIN_COLORS: Record<number, number> = {
  [Terrain.Grass]: 0x4f7a3a, [Terrain.Asphalt]: 0x3a3d42, [Terrain.Concrete]: 0x8d9096, [Terrain.Plaza]: 0xa59d8f,
  [Terrain.Sand]: 0xc9b98a, [Terrain.Water]: 0x1d4f6e, [Terrain.Dirt]: 0x6b5236, [Terrain.Snow]: 0xe8eef2,
  [Terrain.Contaminated]: 0x5d2a6b, [Terrain.Rock]: 0x77746f,
};

export class EnvironmentView {
  readonly sun: THREE.DirectionalLight;
  private terrain: THREE.Mesh;
  private group = new THREE.Group();

  constructor(private opts: EnvironmentOptions) {
    const { scene, map } = opts;
    scene.background = new THREE.Color(0x9fb8c8);
    scene.add(this.group);
    const hemi = new THREE.HemisphereLight(0xdfefff, 0x3a3020, 1.2);
    this.group.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    this.sun.position.set(map.width * 0.3, 60, map.height * 0.1);
    this.sun.target.position.set(map.width / 2, 0, map.height / 2);
    this.group.add(this.sun, this.sun.target);

    const geo = new THREE.PlaneGeometry(map.width, map.height, map.width, map.height);
    geo.rotateX(-Math.PI / 2);
    geo.translate(map.width / 2, 0, map.height / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, sampleHeight(map, x, z));
      const tx = Math.min(map.width - 1, Math.floor(x)), tz = Math.min(map.height - 1, Math.floor(z));
      c.setHex(TERRAIN_COLORS[map.terrain[tz * map.width + tx]!] ?? 0x556655);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    this.terrain.receiveShadow = true;
    this.group.add(this.terrain);

    for (const d of map.doodads) {
      const o = createDoodad(d.kind, d.seed, d.scale);
      o.position.set(d.pos.x, sampleHeight(map, d.pos.x, d.pos.y), d.pos.y);
      o.rotation.y = -d.rot;
      this.group.add(o);
    }
  }

  /** Called every frame by the render core. focus = camera ground target (for shadow-camera fitting). */
  update(_dt: number, _time: number, _focus: Vec2): void {}

  /** Terrain height at world (x, y) — convenience for other render modules. */
  heightAt(x: number, y: number): number { return sampleHeight(this.opts.map, x, y); }

  dispose(): void {
    this.opts.scene.remove(this.group);
    this.terrain.geometry.dispose();
    (this.terrain.material as THREE.Material).dispose();
  }
}
