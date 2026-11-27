/**
 * [render-core] Render quality tiers. One table drives pixel ratio, shadows and the post chain so the
 * options menu can switch tiers at runtime (GameRenderer.setQuality).
 */
import type { Quality } from '../../game/settings';

export interface QualityProfile {
  readonly quality: Quality;
  /** upper bound for the device pixel ratio */
  readonly maxPixelRatio: number;
  /** renderer.shadowMap.enabled (the environment owns the sun and its shadow camera) */
  readonly shadows: boolean;
  /** EffectComposer chain (tone map + colour grade + vignette + AA). false = direct render. */
  readonly post: boolean;
  /** UnrealBloomPass (emissive glow) */
  readonly bloom: boolean;
  /** anti-aliasing: 'msaa' = context MSAA (only used without post), otherwise a post pass */
  readonly aa: 'msaa' | 'fxaa' | 'smaa';
  /** re-render the shadow map every N drawn frames (static world; units move slowly) */
  readonly shadowInterval: number;
  /** units with a radius below this do not cast shadows (0 = all units cast) */
  readonly minCasterRadius: number;
}

export const QUALITY_PROFILES: Readonly<Record<Quality, QualityProfile>> = {
  low: { quality: 'low', maxPixelRatio: 1, shadows: false, post: false, bloom: false, aa: 'msaa', shadowInterval: 1, minCasterRadius: 99 },
  medium: { quality: 'medium', maxPixelRatio: 1.25, shadows: true, post: true, bloom: false, aa: 'fxaa', shadowInterval: 2, minCasterRadius: 0.7 },
  high: { quality: 'high', maxPixelRatio: 2, shadows: true, post: true, bloom: true, aa: 'smaa', shadowInterval: 1, minCasterRadius: 0 },
};

export function qualityProfile(q: Quality | string | undefined): QualityProfile {
  return QUALITY_PROFILES[(q ?? 'high') as Quality] ?? QUALITY_PROFILES.high;
}

/** Effective pixel ratio for a tier on this display. */
export function pixelRatioFor(profile: QualityProfile): number {
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
  return Math.max(1, Math.min(dpr, profile.maxPixelRatio));
}
