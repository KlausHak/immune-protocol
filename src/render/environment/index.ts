/**
 * [environment] OWNER: environment agent. Terrain mesh, water, sky, lighting presets, shadows,
 * doodad placement, decals and fog-of-war rendering. Created and driven by the render core.
 *
 * Public API (stable): new EnvironmentView(opts), .sun, .update(dt, time, focus), .heightAt(x, y), .dispose().
 * Additions: optional EnvironmentOptions.preset / fogOfWar / particles, setPreset(), preset, setFogOfWarEnabled(),
 * getStats(). Draw-call budget: sky 1 · terrain ≈6–12 visible chunks · water 1 · decals 1 · lamp glow 2 ·
 * cliff rocks ≤3 · snow 1 · doodads = one InstancedMesh per prototype mesh + merged static cells.
 */
import * as THREE from 'three';
import type { LightingPreset, MapData, PlayerId, Vec2 } from '../../core/types';
import { sampleHeight } from '../../core/terrain';
import type { Quality } from '../../game/settings';
import type { World } from '../../sim/World';
import { CliffRocks } from './cliffs';
import { DecalLayer } from './decals';
import { DoodadLayer, type DoodadStats } from './doodads';
import { FogOfWarTexture, fogUniforms } from './fog';
import { ExtendedTerrain } from './heightfield';
import { LampGlows } from './lamps';
import { Snowfall } from './particles';
import { getPreset, horizonColor, isPreset, type PresetDef } from './presets';
import { SunShadowFitter } from './shadows';
import { SkyDome, applyPresetUniforms, envUniforms } from './sky';
import { TerrainView } from './terrain';
import { WaterView } from './water';

export { fogUniforms, patchFogOfWar } from './fog';
export { PRESETS, type PresetDef } from './presets';

export interface EnvironmentOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  world: World;
  map: MapData;
  localPlayerId: PlayerId;
  quality: Quality;
  /** [environment] override map.lighting (sandbox / debugging / campaign) */
  preset?: LightingPreset;
  /** [environment] render the fog of war from world.vision (default true) */
  fogOfWar?: boolean;
  /** [environment] ambient particles such as snowfall (default: on unless quality is 'low') */
  particles?: boolean;
}

export interface EnvironmentStats {
  preset: LightingPreset;
  terrainChunks: number;
  doodads: DoodadStats;
  decals: number;
  cliffRocks: number;
  lamps: number;
  shadowMapSize: number;
  snowFlakes: number;
  timings: Record<string, number>;
}

const QUALITY = {
  high: { shadow: 2048, snow: 1600, cliff: 1, aniso: 8 },
  medium: { shadow: 1024, snow: 800, cliff: 0.8, aniso: 4 },
  low: { shadow: 0, snow: 0, cliff: 0.6, aniso: 2 },
} as const;

export class EnvironmentView {
  readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly group = new THREE.Group();
  private readonly ext: ExtendedTerrain;
  private readonly terrain: TerrainView;
  private readonly water: WaterView;
  private readonly decals: DecalLayer;
  private readonly doodads: DoodadLayer;
  private readonly cliffs: CliffRocks;
  private readonly lamps: LampGlows;
  private readonly sky: SkyDome;
  private readonly snow: Snowfall | null;
  private readonly fow: FogOfWarTexture;
  private readonly fitter = new SunShadowFitter();
  private readonly fog: THREE.FogExp2;
  private readonly q: (typeof QUALITY)[Quality];
  private readonly saved: Pick<THREE.Scene, 'background' | 'fog' | 'environment' | 'environmentIntensity'>;
  private def: PresetDef;
  private fowVersion = -1;
  private fowEnabled: boolean;
  private envTex: THREE.Texture | null = null;
  private readonly focus3 = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly sunDir = new THREE.Vector3();
  private readonly dbSize = new THREE.Vector2();
  private disposed = false;
  /** build time per stage (ms) — see getStats() */
  readonly timings: Record<string, number> = {};

  constructor(private opts: EnvironmentOptions) {
    const { scene, map, renderer } = opts;
    this.q = QUALITY[opts.quality] ?? QUALITY.high;
    this.def = getPreset(isPreset(opts.preset) ? opts.preset : map.lighting);
    this.saved = { background: scene.background, fog: scene.fog, environment: scene.environment, environmentIntensity: scene.environmentIntensity };
    this.group.name = 'environment';
    scene.add(this.group);
    const shadows = this.q.shadow > 0;
    const aniso = Math.min(this.q.aniso, renderer.capabilities.getMaxAnisotropy());

    let t = performance.now();
    const lap = (k: string) => { const n = performance.now(); this.timings[k] = Math.round(n - t); t = n; };
    this.ext = new ExtendedTerrain(map); lap('heightfield');
    this.doodads = new DoodadLayer(map.doodads ?? [], this.ext, { shadows }); lap('doodads');
    this.terrain = new TerrainView(this.ext, { anisotropy: aniso, occluders: this.doodads.occluders, castShadow: shadows, fast: opts.quality === 'low' }); lap('terrain');
    this.water = new WaterView(this.ext, this.terrain.noiseTexture); lap('water');
    this.decals = new DecalLayer(map.decals ?? [], this.ext, renderer.capabilities.getMaxAnisotropy()); lap('decals');
    this.cliffs = new CliffRocks(this.ext, { shadows: shadows && opts.quality === 'high', density: this.q.cliff }); lap('cliffs');
    this.lamps = new LampGlows(this.doodads.lampHeads, this.ext); lap('lamps');
    this.sky = new SkyDome();
    const wantSnow = (opts.particles ?? true) && this.q.snow > 0;
    this.snow = wantSnow ? new Snowfall(this.q.snow) : null;

    this.group.add(this.sky.mesh, this.terrain.group, this.water.mesh, this.doodads.group, this.cliffs.group, this.lamps.group);
    if (this.decals.mesh) this.group.add(this.decals.mesh);
    if (this.snow) this.group.add(this.snow.points);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.hemi.name = 'env:hemi';
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.name = 'env:sun';
    this.sun.castShadow = shadows;
    if (shadows) {
      this.sun.shadow.mapSize.set(this.q.shadow, this.q.shadow);
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.045;
      this.sun.shadow.radius = 1.5;
    }
    this.group.add(this.hemi, this.sun, this.sun.target);

    this.fog = new THREE.FogExp2(0x8890b0, 0.004);
    scene.fog = this.fog;
    scene.background = new THREE.Color(0x0b0f16);

    this.fow = new FogOfWarTexture(map.width, map.height, 0.3);
    this.fowEnabled = opts.fogOfWar ?? true;
    fogUniforms.uFogTex.value = this.fow.texture;
    fogUniforms.uFogWorldSize.value.set(map.width, map.height);
    fogUniforms.uFogEnabled.value = this.fowEnabled ? 1 : 0;

    t = performance.now();
    this.applyPreset(this.def); lap('preset+pmrem');
    // initial placement so the first frame (and the shadow map) is correct even before update()
    const start = opts.world?.players?.get(opts.localPlayerId)?.startPos;
    this.update(0, 0, start ?? { x: map.width / 2, y: map.height / 2 });
  }

  /** Current lighting preset id. */
  get preset(): LightingPreset { return this.def.id; }

  /** Switch lighting at runtime (rebuilds the sky environment map). */
  setPreset(preset: LightingPreset): void {
    if (this.disposed || !isPreset(preset) || preset === this.def.id) return;
    this.applyPreset(getPreset(preset));
  }

  /** Show/hide the fog of war (e.g. replays, debug reveal). */
  setFogOfWarEnabled(on: boolean): void {
    this.fowEnabled = on;
    fogUniforms.uFogEnabled.value = on ? 1 : 0;
    if (on) this.fowVersion = -1;
  }

  private applyPreset(p: PresetDef): void {
    this.def = p;
    applyPresetUniforms(p);
    this.sunDir.copy(envUniforms.uSunDirW.value);
    this.fitter.setSunDirection(this.sunDir);
    this.sun.color.setHex(p.sun.color);
    this.sun.intensity = p.sun.intensity;
    this.sun.shadow.intensity = p.shadowIntensity;
    this.hemi.color.setHex(p.hemi.sky);
    this.hemi.groundColor.setHex(p.hemi.ground);
    this.hemi.intensity = p.hemi.intensity;
    this.fog.density = p.fogDensity;
    this.water.applyPreset(p);
    this.terrain.setPresetParams(p.veinGlow, p.sparkle);
    this.lamps.setStrength(p.lamps);
    if (this.snow) {
      this.snow.setDensity(p.snow);
      this.snow.setLook(p.id === 'night' ? 0x9fb0d8 : p.id === 'day' ? 0xffffff : 0xe4e2f0, p.id === 'night' ? 0.55 : 0.8);
    }
    const { scene, renderer } = this.opts;
    const env = this.sky.buildEnvironment(renderer);
    if (env) { this.envTex = env; scene.environment = env; }
    scene.environmentIntensity = p.envIntensity;
    const bg = scene.background as THREE.Color | null;
    if (bg && bg.isColor) bg.setHex(p.sky.horizon);
  }

  /** Called every frame by the render core. focus = camera ground target (for shadow-camera fitting). */
  update(dt: number, time: number, focus: Vec2): void {
    if (this.disposed) return;
    const { camera, world, localPlayerId, map } = this.opts;
    envUniforms.uEnvTime.value = time;

    // fog of war: re-read the grid when vision changes, then ease toward it
    if (this.fowEnabled && world?.vision) {
      const v = world.vision.version;
      if (v !== this.fowVersion) {
        this.fowVersion = v;
        const grid = world.vision.fogGrid(localPlayerId);
        if (grid && grid.length >= map.width * map.height) this.fow.setGrid(grid);
      }
      this.fow.update(Math.max(0, dt));
    }

    const fx = Number.isFinite(focus?.x) ? focus.x : map.width / 2, fy = Number.isFinite(focus?.y) ? focus.y : map.height / 2;
    this.focus3.set(fx, this.ext.sample(fx, fy), fy);
    if (this.sun.castShadow) this.fitter.fit(this.sun, camera, this.focus3);
    else {
      this.sun.position.copy(this.focus3).addScaledVector(this.sunDir, 100);
      this.sun.target.position.copy(this.focus3);
    }
    this.sky.update(camera);

    // tint the built-in fog toward the horizon colour behind the camera's heading
    camera.getWorldDirection(this.tmpDir);
    horizonColor(this.def, this.tmpDir.x, this.tmpDir.z, this.sunDir, this.fog.color);

    if (this.snow?.points.visible) {
      this.opts.renderer.getDrawingBufferSize(this.dbSize);
      this.snow.update(this.focus3, camera, this.dbSize.y);
    }
  }

  /** Terrain height at world (x, y) — convenience for other render modules. */
  heightAt(x: number, y: number): number { return sampleHeight(this.opts.map, x, y); }

  getStats(): EnvironmentStats {
    return {
      preset: this.def.id,
      terrainChunks: this.terrain.group.children.length,
      doodads: { ...this.doodads.stats },
      decals: this.decals.count,
      cliffRocks: this.cliffs.count,
      lamps: this.doodads.lampHeads.length,
      shadowMapSize: this.sun.castShadow ? this.sun.shadow.mapSize.x : 0,
      snowFlakes: this.snow ? this.snow.points.geometry.drawRange.count : 0,
      timings: { ...this.timings },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const { scene } = this.opts;
    scene.remove(this.group);
    this.terrain.dispose(); this.water.dispose(); this.decals.dispose(); this.doodads.dispose();
    this.cliffs.dispose(); this.lamps.dispose(); this.sky.dispose(); this.snow?.dispose(); this.fow.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose(); this.hemi.dispose();
    if (scene.environment === this.envTex) scene.environment = this.saved.environment;
    scene.environmentIntensity = this.saved.environmentIntensity;
    if (scene.fog === this.fog) scene.fog = this.saved.fog;
    scene.background = this.saved.background;
    if (fogUniforms.uFogTex.value === this.fow.texture) { fogUniforms.uFogTex.value = null; fogUniforms.uFogEnabled.value = 0; }
  }
}
