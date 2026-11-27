/**
 * [environment] Doodad placement & batching.
 *
 * Every map doodad is built once with createDoodad(kind, seed, scale) and placed on the terrain. Its meshes
 * are then re-batched for few draw calls:
 *  - identical (geometry, material) pairs — by identity OR by content (geometry hash / material signature,
 *    so builders that don't cache still batch) — become one InstancedMesh per prototype child mesh;
 *  - one-off meshes are merged per material into static meshes per 32×32-tile cell (still frustum-culled);
 *  - vegetation (trees, bushes, reeds) gets a vertex-shader wind sway; everything gets patchFogOfWar;
 *  - lights inside doodads are dropped (lamps get cheap glow sprites instead — see lamps.ts).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Doodad, DoodadKind } from '../../core/types';
import { createDoodad } from '../models';
import { patchFogOfWar } from './fog';
import type { ExtendedTerrain } from './heightfield';
import { Rand } from './noise';
import { envUniforms } from './sky';
import type { AoOccluder } from './terrain';

export interface DoodadInfo { w: number; h: number; height: number; flat?: boolean; sway?: number; building?: boolean; lamp?: boolean }

/** Nominal sizes from DESIGN.md §6 (footprint w × h tiles at scale 1, height in units). */
export const DOODAD_INFO: Record<DoodadKind, DoodadInfo> = {
  hospital_tower: { w: 14, h: 10, height: 14, building: true },
  hospital_wing: { w: 12, h: 6, height: 6, building: true },
  childrens_hospital: { w: 6, h: 6, height: 5, building: true },
  research_lab: { w: 10, h: 8, height: 7, building: true },
  parking_garage: { w: 12, h: 10, height: 4, building: true },
  old_laundry: { w: 10, h: 8, height: 6, building: true },
  water_tower: { w: 3, h: 3, height: 10 },
  skybridge: { w: 8, h: 2, height: 4 },
  ambulance: { w: 2, h: 1, height: 1.3 },
  car: { w: 2, h: 1, height: 0.9 },
  bus: { w: 4, h: 1, height: 1.6 },
  helicopter_pad: { w: 4, h: 4, height: 0.15, flat: true },
  street_lamp: { w: 1, h: 1, height: 3.5, lamp: true },
  bench: { w: 1, h: 1, height: 0.5 },
  bus_stop: { w: 2, h: 1, height: 1.6 },
  traffic_cone: { w: 0.4, h: 0.4, height: 0.4 },
  barrier: { w: 2, h: 1, height: 0.6 },
  fence: { w: 2, h: 0.3, height: 1 },
  sign_er: { w: 1, h: 1, height: 1.6 },
  dumpster: { w: 2, h: 1, height: 1 },
  flag_pole: { w: 1, h: 1, height: 6 },
  tree_birch: { w: 1, h: 1, height: 5, sway: 0.09 },
  tree_pine: { w: 1, h: 1, height: 6, sway: 0.05 },
  bush: { w: 1, h: 1, height: 0.8, sway: 0.035 },
  rock_granite: { w: 2, h: 2, height: 1.2 },
  snow_pile: { w: 1, h: 1, height: 0.5, flat: true },
  reeds: { w: 1, h: 1, height: 1.2, sway: 0.12 },
  pier: { w: 2, h: 6, height: 0.6 },
  biohazard_barrel: { w: 1, h: 1, height: 1 },
  goo_puddle: { w: 1, h: 1, height: 0.05, flat: true },
  sewer_grate: { w: 1, h: 1, height: 0.05, flat: true },
  infected_growth: { w: 2, h: 2, height: 1.5 },
  spore_vent: { w: 1, h: 1, height: 1 },
  waste_container: { w: 2, h: 1, height: 1.2 },
};

const CELL = 32;

interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  matrix: THREE.Matrix4;
  /** [groundY, phase, amplitude/height²] for vegetation, else null */
  sway: [number, number, number] | null;
  cast: boolean;
  cell: string;
}

export interface DoodadStats { doodads: number; instanced: number; merged: number; standalone: number; drawables: number; lightsRemoved: number }

export class DoodadLayer {
  readonly group = new THREE.Group();
  /** world positions of lamp heads (for glow sprites / light pools) */
  readonly lampHeads: THREE.Vector3[] = [];
  /** footprints for baked terrain AO */
  readonly occluders: AoOccluder[] = [];
  readonly stats: DoodadStats = { doodads: 0, instanced: 0, merged: 0, standalone: 0, drawables: 0, lightsRemoved: 0 };
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly instanced: THREE.InstancedMesh[] = [];
  private readonly geoKeys = new WeakMap<THREE.BufferGeometry, string>();
  private readonly canonGeo = new Map<string, THREE.BufferGeometry>();
  private readonly canonMat = new Map<string, THREE.Material>();
  private readonly matKeys = new WeakMap<THREE.Material, string>();
  private readonly swayMats = new Map<THREE.Material, THREE.Material>();

  constructor(doodads: readonly Doodad[], private readonly ext: ExtendedTerrain, opts: { shadows: boolean }) {
    this.group.name = 'env:doodads';
    const parts: Part[] = [];
    const extras: THREE.Object3D[] = [];
    const rnd = new Rand(4242);
    for (const d of doodads) {
      if (!d || !d.pos || !Number.isFinite(d.pos.x) || !Number.isFinite(d.pos.y)) continue;
      const info = DOODAD_INFO[d.kind] ?? { w: 1, h: 1, height: 1 };
      const scale = d.scale > 0 ? d.scale : 1;
      let root: THREE.Object3D;
      try { root = createDoodad(d.kind, d.seed, scale); } catch (err) { console.warn('[environment] doodad failed', d.kind, err); continue; }
      this.stats.doodads++;
      const ground = this.placementHeight(d, info, scale);
      root.position.set(d.pos.x, ground, d.pos.y);
      root.rotation.y = -d.rot;
      root.updateMatrixWorld(true);
      const fw = (d.footprint?.w ?? info.w) * (d.footprint ? 1 : scale), fh = (d.footprint?.h ?? info.h) * (d.footprint ? 1 : scale);
      if (info.building) this.occluders.push({ x: d.pos.x, y: d.pos.y, w: fw, h: fh, rot: d.rot, height: info.height * scale });
      const cell = `${Math.floor(d.pos.x / CELL)},${Math.floor(d.pos.y / CELL)}`;
      const swayAmp = info.sway ? (info.sway / (info.height * info.height * scale)) : 0;
      const phase = rnd.next() * Math.PI * 2;
      // small props (cones, benches, puddles…) don't cast: saves shadow-pass draws for invisible shadows
      const cast = opts.shadows && !info.flat && info.height * scale >= 0.75;
      let lampLight: THREE.Vector3 | null = null;
      const leftovers: THREE.Object3D[] = [];
      root.traverseVisible((o) => {
        if ((o as THREE.Light).isLight) {
          this.stats.lightsRemoved++;
          if (info.lamp) lampLight = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
          return;
        }
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh && !(o as THREE.InstancedMesh).isInstancedMesh && !(o as THREE.BatchedMesh).isBatchedMesh) {
          if (!mesh.geometry?.attributes?.position) return;
          parts.push({ geometry: mesh.geometry, material: mesh.material, matrix: mesh.matrixWorld.clone(), sway: swayAmp ? [ground, phase, swayAmp] : null, cast, cell });
        } else if ((o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite || mesh.isMesh) {
          leftovers.push(o);
        }
      });
      if (info.lamp) this.lampHeads.push(lampLight ?? lampHead(root, d.pos.x, d.pos.y, ground + info.height * scale - 0.2));
      for (const o of leftovers) { this.group.attach(o); extras.push(o); }
    }
    this.stats.standalone += extras.length;
    for (const o of extras) o.traverse((c) => { const m = (c as THREE.Mesh).material; if (m) patchFogOfWar(m as THREE.Material | THREE.Material[]); });
    this.batch(parts);
  }

  /** Ground height for a doodad: big footprints sit on the lowest corner (never float on slopes). */
  private placementHeight(d: Doodad, info: DoodadInfo, scale: number): number {
    const ext = this.ext;
    let y = ext.sample(d.pos.x, d.pos.y);
    if (info.building || info.w * info.h >= 4) {
      const c = Math.cos(d.rot), s = Math.sin(d.rot);
      const hw = (d.footprint?.w ?? info.w * scale) / 2 * 0.9, hh = (d.footprint?.h ?? info.h * scale) / 2 * 0.9;
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const x = d.pos.x + a * hw * c - b * hh * s, z = d.pos.y + a * hw * s + b * hh * c;
        y = Math.min(y, ext.sample(x, z));
      }
    } else if (info.sway) y -= 0.04; // sink trunks a touch so they never hover
    if (d.kind === 'pier') y = Math.max(y, ext.waterLevel - 0.05);
    return y;
  }

  private batch(parts: Part[]): void {
    // canonicalise by content so builders that don't cache still instance
    for (const p of parts) {
      p.geometry = this.canonicalGeometry(p.geometry);
      p.material = Array.isArray(p.material) ? p.material.map((m) => this.canonicalMaterial(m)) : this.canonicalMaterial(p.material);
    }
    const groups = new Map<string, Part[]>();
    for (const p of parts) {
      const mk = Array.isArray(p.material) ? p.material.map((m) => m.uuid).join(',') : p.material.uuid;
      const key = `${p.geometry.uuid}#${mk}#${p.cast ? 1 : 0}#${p.sway ? 1 : 0}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(p);
    }
    const singles: Part[] = [];
    for (const list of groups.values()) {
      if (list.length >= 2) this.makeInstanced(list);
      else singles.push(list[0]!);
    }
    this.mergeSingles(singles);
    this.stats.drawables = this.group.children.length;
  }

  private makeInstanced(list: Part[]): void {
    const first = list[0]!;
    let geometry = first.geometry;
    let material = first.material;
    if (first.sway) {
      geometry = shallowGeometry(geometry);
      const sway = new Float32Array(list.length * 3);
      list.forEach((p, i) => sway.set(p.sway!, i * 3));
      geometry.setAttribute('aSway', new THREE.InstancedBufferAttribute(sway, 3));
      this.ownedGeometries.push(geometry);
      material = Array.isArray(material) ? material.map((m) => this.swayMaterial(m)) : this.swayMaterial(material);
    }
    const im = new THREE.InstancedMesh(geometry, material, list.length);
    list.forEach((p, i) => im.setMatrixAt(i, p.matrix));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = first.cast;
    im.receiveShadow = true;
    im.matrixAutoUpdate = false;
    im.name = `env:doodad-inst:${geometry.name || geometry.type}`;
    patchFogOfWar(material);
    this.group.add(im);
    this.instanced.push(im);
    this.stats.instanced++;
  }

  private mergeSingles(singles: Part[]): void {
    const buckets = new Map<string, Part[]>();
    for (const p of singles) {
      const mirrored = p.matrix.determinant() < 0;
      const mergeable = !Array.isArray(p.material) && !mirrored && !p.geometry.morphAttributes.position && p.geometry.groups.length <= 1
        && !hasInterleaved(p.geometry);
      if (!mergeable) { this.addStandalone(p); continue; }
      const key = `${(p.material as THREE.Material).uuid}#${layoutKey(p.geometry)}#${p.cast ? 1 : 0}#${p.sway ? 1 : 0}#${p.cell}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(p);
    }
    for (const list of buckets.values()) {
      if (list.length === 1) { this.addStandalone(list[0]!); continue; }
      const geos = list.map((p) => {
        const g = p.geometry.clone();
        g.applyMatrix4(p.matrix);
        if (!g.index) g.setIndex(sequentialIndex(g.attributes.position!.count));
        g.morphAttributes = {};
        g.morphTargetsRelative = false;
        g.clearGroups();
        if (p.sway) {
          const n = g.attributes.position!.count, a = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) a.set(p.sway, i * 3);
          g.setAttribute('aSway', new THREE.BufferAttribute(a, 3));
        }
        return g;
      });
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) { for (const p of list) this.addStandalone(p); continue; }
      merged.computeBoundingSphere();
      let material = list[0]!.material as THREE.Material;
      if (list[0]!.sway) material = this.swayMaterial(material);
      patchFogOfWar(material);
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = list[0]!.cast;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = 'env:doodad-merged';
      this.group.add(mesh);
      this.ownedGeometries.push(merged);
      this.stats.merged++;
    }
  }

  private addStandalone(p: Part): void {
    let geometry = p.geometry;
    let material = p.material;
    if (p.sway) {
      geometry = shallowGeometry(geometry);
      const n = geometry.attributes.position!.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) a.set(p.sway, i * 3);
      geometry.setAttribute('aSway', new THREE.BufferAttribute(a, 3));
      this.ownedGeometries.push(geometry);
      material = Array.isArray(material) ? material.map((m) => this.swayMaterial(m)) : this.swayMaterial(material);
    }
    const mesh = new THREE.Mesh(geometry, material);
    p.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = p.cast;
    mesh.receiveShadow = true;
    patchFogOfWar(material);
    this.group.add(mesh);
    this.stats.standalone++;
  }

  private canonicalGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
    let key = this.geoKeys.get(g);
    if (key === undefined) { key = geometryKey(g); this.geoKeys.set(g, key); }
    const c = this.canonGeo.get(key);
    if (c) return c;
    this.canonGeo.set(key, g);
    return g;
  }

  private canonicalMaterial(m: THREE.Material): THREE.Material {
    let key = this.matKeys.get(m);
    if (key === undefined) { key = materialSignature(m) ?? `uuid:${m.uuid}`; this.matKeys.set(m, key); }
    const c = this.canonMat.get(key);
    if (c) return c;
    this.canonMat.set(key, m);
    return m;
  }

  /** Clone of `src` with the wind-sway vertex injection (requires the `aSway` attribute). */
  private swayMaterial(src: THREE.Material): THREE.Material {
    const cached = this.swayMats.get(src);
    if (cached) return cached;
    const m = src.clone();
    m.name = `${src.name || src.type}+sway`;
    const prev = src.onBeforeCompile;
    const prevKey = src.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey ? prev.toString() : src.customProgramCacheKey();
    m.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
      prev.call(this, shader, renderer);
      if (!shader.vertexShader.includes('#include <project_vertex>') || shader.vertexShader.includes('aSway')) return;
      shader.uniforms.uEnvTime = envUniforms.uEnvTime;
      shader.uniforms.uEnvMisc = envUniforms.uEnvMisc;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aSway;\nuniform float uEnvTime;\nuniform vec4 uEnvMisc;')
        .replace('#include <project_vertex>', `#include <project_vertex>\n${SWAY_VERTEX}`);
    };
    m.customProgramCacheKey = () => `${prevKey}|sway1`;
    this.swayMats.set(src, m);
    this.ownedMaterials.push(m);
    return m;
  }

  dispose(): void {
    for (const im of this.instanced) im.dispose();
    for (const g of this.ownedGeometries) g.dispose();
    for (const m of this.ownedMaterials) m.dispose();
    this.group.clear();
  }
}

const SWAY_VERTEX = /* glsl */ `
{
  vec4 swW = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    swW = instanceMatrix * swW;
  #endif
  swW = modelMatrix * swW;
  float swH = max( swW.y - aSway.x, 0.0 );
  float swK = swH * swH * aSway.z * uEnvMisc.w;
  float swP = aSway.y + uEnvTime * 1.25;
  vec2 swO = vec2( sin( swP ) + 0.35 * sin( swP * 2.7 + 1.3 ), 0.45 * cos( swP * 0.8 + 0.6 ) + 0.2 * sin( swP * 3.3 ) );
  swO *= swK * ( 0.65 + 0.35 * sin( uEnvTime * 0.37 + swW.x * 0.06 + swW.z * 0.035 ) );
  swW.xz += swO;
  mvPosition = viewMatrix * swW;
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * Lamp head = average of the model's top-most vertices (world space) — works for single-mesh atlas models
 * where the bulb can't be told apart by material. Falls back to the nominal height above the base.
 */
function lampHead(root: THREE.Object3D, x: number, z: number, fallbackY: number): THREE.Vector3 {
  const v = new THREE.Vector3();
  let maxY = -Infinity;
  const pts: THREE.Vector3[] = [];
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    const p = m.isMesh ? m.geometry?.attributes?.position : undefined;
    if (!p) return;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      pts.push(v.clone());
      if (v.y > maxY) maxY = v.y;
    }
  });
  if (!pts.length) return new THREE.Vector3(x, fallbackY, z);
  const head = new THREE.Vector3();
  let n = 0;
  for (const p of pts) if (p.y > maxY - 0.45) { head.add(p); n++; }
  head.divideScalar(n);
  head.y = maxY - 0.2;
  return head;
}

function shallowGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr);
  if (src.index) g.setIndex(src.index);
  for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  g.morphAttributes = src.morphAttributes;
  g.morphTargetsRelative = src.morphTargetsRelative;
  g.drawRange = { ...src.drawRange };
  if (src.boundingSphere) g.boundingSphere = src.boundingSphere.clone();
  if (src.boundingBox) g.boundingBox = src.boundingBox.clone();
  g.name = src.name;
  return g;
}

function sequentialIndex(n: number): THREE.BufferAttribute {
  const a = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return new THREE.BufferAttribute(a, 1);
}

function hasInterleaved(g: THREE.BufferGeometry): boolean {
  return Object.values(g.attributes).some((a) => (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute);
}

function layoutKey(g: THREE.BufferGeometry): string {
  return Object.keys(g.attributes).sort().map((n) => {
    const a = g.attributes[n] as THREE.BufferAttribute;
    return `${n}:${a.itemSize}:${a.normalized ? 1 : 0}:${a.array.constructor.name}`;
  }).join(',');
}

/** Content hash of a geometry (attributes + index + groups). Interleaved/morphed geometry → identity. */
function geometryKey(g: THREE.BufferGeometry): string {
  if (hasInterleaved(g) || Object.keys(g.morphAttributes).length) return `uuid:${g.uuid}`;
  const parts: string[] = [];
  for (const name of Object.keys(g.attributes).sort()) {
    const a = g.attributes[name] as THREE.BufferAttribute;
    parts.push(`${name}:${a.itemSize}:${a.normalized ? 1 : 0}:${a.count}:${hashArray(a.array)}`);
  }
  if (g.index) parts.push(`i:${g.index.count}:${hashArray(g.index.array)}`);
  parts.push(`g:${g.groups.map((x) => `${x.start},${x.count},${x.materialIndex}`).join(';')}`);
  parts.push(`d:${g.drawRange.start},${g.drawRange.count}`);
  return parts.join('|');
}

function hashArray(arr: ArrayLike<number> & { buffer?: ArrayBufferLike; byteOffset?: number; byteLength?: number }): string {
  let h = 0x811c9dc5 | 0;
  const typed = arr as unknown as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
  if (typed.buffer && typed.byteLength % 4 === 0) {
    const u = new Uint32Array(typed.buffer, typed.byteOffset, typed.byteLength / 4);
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i]!, 16777619);
    return `${(h >>> 0).toString(36)}:${u.length}`;
  }
  for (let i = 0; i < arr.length; i++) h = Math.imul(h ^ (arr[i]! * 1000 | 0), 16777619);
  return `${(h >>> 0).toString(36)}:${arr.length}`;
}

const SIG_SKIP = new Set(['uuid', 'id', 'name', 'version', '_listeners', 'userData', 'isMaterial']);
/** Value signature for built-in materials without custom shader hooks; null = only identity-equal. */
function materialSignature(m: THREE.Material): string | null {
  if (m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return null;
  if (m.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey) return null;
  if ((m as THREE.ShaderMaterial).isShaderMaterial) return null;
  const out: string[] = [m.type];
  const rec = m as unknown as Record<string, unknown>;
  for (const k of Object.keys(rec).sort()) {
    if (SIG_SKIP.has(k)) continue;
    const v = rec[k];
    if (v === null || v === undefined) { out.push(`${k}:-`); continue; }
    const t = typeof v;
    if (t === 'function') continue;
    if (t === 'number' || t === 'boolean' || t === 'string') { out.push(`${k}:${String(v)}`); continue; }
    const o = v as { isColor?: boolean; isTexture?: boolean; isVector2?: boolean; isVector3?: boolean; isEuler?: boolean; uuid?: string; r?: number; g?: number; b?: number; toArray?: () => number[] };
    if (o.isColor) out.push(`${k}:${o.r},${o.g},${o.b}`);
    else if (o.isTexture) out.push(`${k}:${o.uuid}`);
    else if ((o.isVector2 || o.isVector3 || o.isEuler) && o.toArray) out.push(`${k}:${o.toArray().join(',')}`);
    else {
      try { out.push(`${k}:${JSON.stringify(v)}`); } catch { return null; }
    }
  }
  try { out.push(`ud:${JSON.stringify(m.userData)}`); } catch { return null; }
  return out.join('|');
}
