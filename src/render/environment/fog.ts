/**
 * [environment] Fog-of-war material hook. OWNER: environment agent.
 * Any module can call patchFogOfWar(material) on materials of objects that sit on the ground
 * (terrain, doodads, buildings, resource nodes) so unexplored/explored areas are darkened consistently.
 * The environment view updates fogUniforms every frame. Must be idempotent per material.
 */
import * as THREE from 'three';

export const fogUniforms = {
  uFogTex: { value: null as THREE.Texture | null },
  uFogWorldSize: { value: new THREE.Vector2(1, 1) },
  uFogEnabled: { value: 0 },
};

export function patchFogOfWar(_material: THREE.Material): void {
  // TODO(environment agent): onBeforeCompile injection that darkens by fog texture (world xz → uv).
}
