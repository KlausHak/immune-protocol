/**
 * [environment] Lighting presets (map.lighting): sun/moon, ambient, sky gradient, fog, water tint and
 * the atmospheric extras (stars, aurora, lamp glow, snowfall). All colours are sRGB hex.
 *
 * Azimuth convention: degrees clockwise from map north (north = −y sim = −z three), east = +x.
 */
import * as THREE from 'three';
import type { LightingPreset } from '../../core/types';

export interface PresetDef {
  id: LightingPreset;
  /** the shadow-casting key light (sun, or the moon at night) */
  sun: { azimuth: number; elevation: number; color: number; intensity: number };
  hemi: { sky: number; ground: number; intensity: number };
  /** scene.environmentIntensity for the sky PMREM (soft PBR reflections / ambient on Standard materials) */
  envIntensity: number;
  sky: {
    zenith: number; horizon: number;
    /** horizon tint toward the sun's azimuth (sunset band) */
    glow: number; glowPower: number; glowStrength: number;
    /** haze below the horizon (only seen past the far plane) */
    ground: number;
    /** halo around the sun/moon disc */
    halo: number; haloStrength: number;
    discColor: number; discSize: number; discIntensity: number;
  };
  fogDensity: number;
  water: { deep: number; shallow: number; foam: number; glint: number };
  stars: number;
  aurora: number;
  /** street-lamp glow sprites + light pools, 0..1 */
  lamps: number;
  /** snowfall particle density, 0..1 */
  snow: number;
  /** contaminated-ground vein glow multiplier */
  veinGlow: number;
  /** snow sparkle strength */
  sparkle: number;
  /** wind strength for vegetation sway / snow drift */
  wind: number;
  /** shadow darkness (DirectionalLight.shadow.intensity) */
  shadowIntensity: number;
}

export const PRESETS: Record<LightingPreset, PresetDef> = {
  day: {
    id: 'day',
    sun: { azimuth: 200, elevation: 46, color: 0xfff3e2, intensity: 3.0 },
    hemi: { sky: 0xcfe2ff, ground: 0x5f5848, intensity: 0.85 },
    envIntensity: 0.55,
    sky: {
      zenith: 0x3d78c4, horizon: 0xbcd3e8, glow: 0xf3ead8, glowPower: 3, glowStrength: 0.35, ground: 0x93a6b4,
      halo: 0xfff2d6, haloStrength: 0.5, discColor: 0xfffbf0, discSize: 0.028, discIntensity: 18,
    },
    fogDensity: 0.0034,
    water: { deep: 0x0b3346, shallow: 0x2b7a80, foam: 0xf2f6f8, glint: 1.0 },
    stars: 0, aurora: 0, lamps: 0, snow: 0, veinGlow: 0.55, sparkle: 0.7, wind: 1.0, shadowIntensity: 0.85,
  },
  nordic_dusk: {
    id: 'nordic_dusk',
    sun: { azimuth: 236, elevation: 22, color: 0xffb27e, intensity: 3.6 },
    hemi: { sky: 0x8ea8dc, ground: 0x544a4c, intensity: 1.75 },
    envIntensity: 0.8,
    sky: {
      zenith: 0x1a2d58, horizon: 0x8c94bd, glow: 0xf59a63, glowPower: 3.2, glowStrength: 0.95, ground: 0x4a4e66,
      halo: 0xffb27a, haloStrength: 0.9, discColor: 0xffd2a0, discSize: 0.034, discIntensity: 14,
    },
    fogDensity: 0.0042,
    water: { deep: 0x0a2232, shallow: 0x22505a, foam: 0xe9e4ec, glint: 1.25 },
    stars: 0.12, aurora: 0, lamps: 0.7, snow: 0.35, veinGlow: 0.85, sparkle: 1.0, wind: 1.2, shadowIntensity: 0.8,
  },
  night: {
    id: 'night',
    sun: { azimuth: 152, elevation: 34, color: 0xa9c0ff, intensity: 1.25 },
    hemi: { sky: 0x425c94, ground: 0x1e2129, intensity: 1.35 },
    envIntensity: 0.55,
    sky: {
      zenith: 0x040916, horizon: 0x16243f, glow: 0x24375c, glowPower: 2.5, glowStrength: 0.45, ground: 0x0b1222,
      halo: 0x8aa2d8, haloStrength: 0.5, discColor: 0xe6eeff, discSize: 0.024, discIntensity: 6,
    },
    fogDensity: 0.0048,
    water: { deep: 0x040b14, shallow: 0x0c2430, foam: 0x9fb1c8, glint: 0.9 },
    stars: 1, aurora: 0.85, lamps: 1, snow: 0.2, veinGlow: 1.25, sparkle: 0.8, wind: 0.8, shadowIntensity: 0.7,
  },
};

export function getPreset(id: string | null | undefined): PresetDef {
  return (id && (PRESETS as Record<string, PresetDef>)[id]) || PRESETS.nordic_dusk;
}

export const isPreset = (id: string | null | undefined): id is LightingPreset => !!id && id in PRESETS;

/** Unit vector toward the sun/moon (three.js world space). */
export function sunDirection(p: PresetDef, out = new THREE.Vector3()): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(p.sun.azimuth), el = THREE.MathUtils.degToRad(p.sun.elevation);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}

const _c1 = new THREE.Color(), _c2 = new THREE.Color();
/**
 * CPU replica of the GLSL horizon colour (envHorizon in sky.ts) in LINEAR space for a horizontal view
 * direction — used to tint scene.fog toward the camera's heading so built-in materials fade into the
 * same colour as the sky behind them.
 */
export function horizonColor(p: PresetDef, dirX: number, dirZ: number, sun: THREE.Vector3, out = new THREE.Color()): THREE.Color {
  const l = Math.hypot(dirX, dirZ) || 1, sl = Math.hypot(sun.x, sun.z) || 1;
  const cosAz = (dirX * sun.x + dirZ * sun.z) / (l * sl);
  const g = Math.pow(0.5 + 0.5 * cosAz, p.sky.glowPower) * p.sky.glowStrength;
  _c1.setHex(p.sky.horizon); _c2.setHex(p.sky.glow);
  out.copy(_c1).lerp(_c2, Math.min(1, g));
  return out;
}
