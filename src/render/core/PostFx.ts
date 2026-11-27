/**
 * [render-core] Post-processing chain per quality tier.
 *   high:   RenderPass → UnrealBloomPass (high threshold: mostly emissives) → SMAA → OutputGrade
 *   medium: RenderPass → OutputGrade → FXAA (FXAA wants display-referred input)
 *   low:    no composer — direct render with renderer tone mapping (+ context MSAA when available)
 * OutputGradePass fuses OutputPass (tone mapping + sRGB) with a subtle Nordic-dusk grade, vignette and
 * dithering so the grade costs no extra full-screen pass.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { QualityProfile } from './quality';

/** Tunables exposed for art direction (environment presets may tweak them via GameRenderer.post). */
export interface GradeParams {
  vignette: number;      // 0..1 corner darkening
  contrast: number;      // around display mid-grey
  saturation: number;
  lift: THREE.Vector3;   // added to shadows (display space)
  gain: THREE.Vector3;   // multiplies highlights
}

const GRADE_VERTEX = /* glsl */`
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GRADE_FRAGMENT = /* glsl */`
precision highp float;
uniform sampler2D tDiffuse;
uniform float uVignette;
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uAspect;
#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  #if defined( LINEAR_TONE_MAPPING )
    c.rgb = LinearToneMapping(c.rgb);
  #elif defined( REINHARD_TONE_MAPPING )
    c.rgb = ReinhardToneMapping(c.rgb);
  #elif defined( CINEON_TONE_MAPPING )
    c.rgb = CineonToneMapping(c.rgb);
  #elif defined( ACES_FILMIC_TONE_MAPPING )
    c.rgb = ACESFilmicToneMapping(c.rgb);
  #elif defined( AGX_TONE_MAPPING )
    c.rgb = AgXToneMapping(c.rgb);
  #elif defined( NEUTRAL_TONE_MAPPING )
    c.rgb = NeutralToneMapping(c.rgb);
  #endif
  #ifdef SRGB_TRANSFER
    c = sRGBTransferOETF(c);
  #endif
  // ── display-referred grade ──
  vec3 g = clamp(c.rgb, 0.0, 1.0);
  g = (g - 0.5) * uContrast + 0.5;
  g = g * uGain + uLift * (1.0 - g);
  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = mix(vec3(l), g, uSaturation);
  // ── vignette (aspect-corrected, very soft) ──
  vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(d) / length(vec2(uAspect, 1.0) * 0.5);
  g *= 1.0 - uVignette * smoothstep(0.45, 1.05, r);
  // ── dither against banding in dark gradients ──
  g += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(g, 0.0, 1.0), c.a);
}`;

/** OutputPass + colour grade + vignette + dither in one full-screen pass. */
export class OutputGradePass extends Pass {
  readonly uniforms = {
    tDiffuse: { value: null as THREE.Texture | null },
    toneMappingExposure: { value: 1 },
    uVignette: { value: 0.2 },
    uContrast: { value: 1.05 },
    uSaturation: { value: 1.07 },
    uLift: { value: new THREE.Vector3(0.0, 0.006, 0.018) },
    uGain: { value: new THREE.Vector3(1.02, 1.0, 0.975) },
    uAspect: { value: 1 },
  };
  private readonly material: THREE.RawShaderMaterial;
  private readonly quad: FullScreenQuad;
  private colorSpace: string | null = null;
  private toneMapping: THREE.ToneMapping | null = null;

  constructor() {
    super();
    this.material = new THREE.RawShaderMaterial({
      name: 'OutputGradeShader', uniforms: this.uniforms, vertexShader: GRADE_VERTEX, fragmentShader: GRADE_FRAGMENT,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setParams(p: Partial<GradeParams>): void {
    const u = this.uniforms;
    if (p.vignette !== undefined) u.uVignette.value = p.vignette;
    if (p.contrast !== undefined) u.uContrast.value = p.contrast;
    if (p.saturation !== undefined) u.uSaturation.value = p.saturation;
    if (p.lift) u.uLift.value.copy(p.lift);
    if (p.gain) u.uGain.value.copy(p.gain);
  }

  override setSize(width: number, height: number): void { this.uniforms.uAspect.value = width / Math.max(1, height); }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    if (this.colorSpace !== renderer.outputColorSpace || this.toneMapping !== renderer.toneMapping) {
      this.colorSpace = renderer.outputColorSpace;
      this.toneMapping = renderer.toneMapping;
      const defines: Record<string, string> = {};
      if (THREE.ColorManagement.getTransfer(this.colorSpace as THREE.ColorSpace) === THREE.SRGBTransfer) defines.SRGB_TRANSFER = '';
      const tm = this.toneMapping;
      if (tm === THREE.LinearToneMapping) defines.LINEAR_TONE_MAPPING = '';
      else if (tm === THREE.ReinhardToneMapping) defines.REINHARD_TONE_MAPPING = '';
      else if (tm === THREE.CineonToneMapping) defines.CINEON_TONE_MAPPING = '';
      else if (tm === THREE.ACESFilmicToneMapping) defines.ACES_FILMIC_TONE_MAPPING = '';
      else if (tm === THREE.AgXToneMapping) defines.AGX_TONE_MAPPING = '';
      else if (tm === THREE.NeutralToneMapping) defines.NEUTRAL_TONE_MAPPING = '';
      this.material.defines = defines;
      this.material.needsUpdate = true;
    }
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
    }
    this.quad.render(renderer);
  }

  override dispose(): void { this.material.dispose(); this.quad.dispose(); }
}

/** UnrealBloomPass that runs its mip chain at a reduced internal resolution on high-DPI targets. */
class ScaledBloomPass extends UnrealBloomPass {
  scale = 1;
  override setSize(width: number, height: number): void {
    super.setSize(Math.max(2, Math.round(width * this.scale)), Math.max(2, Math.round(height * this.scale)));
  }
}

/** Keep the bloom mip chain's base (half of the input) around ≤ 960 px wide: bloom is soft anyway. */
function bloomScale(widthPx: number): number { return Math.min(1, 1920 / Math.max(1, widthPx)); }

export const BLOOM_DEFAULTS = { strength: 0.55, radius: 0.5, threshold: 1.15 } as const;

export class PostFx {
  private composer: EffectComposer | null = null;
  private passes: Pass[] = [];
  /** null when the tier renders without bloom */
  bloom: UnrealBloomPass | null = null;
  /** null when the tier renders without post */
  grade: OutputGradePass | null = null;
  private profile: QualityProfile | null = null;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene, private readonly camera: THREE.Camera) {}

  get enabled(): boolean { return this.composer !== null; }

  /** (Re)build the chain for a tier. width/height in CSS px; pixelRatio already applied to the renderer. */
  configure(profile: QualityProfile, width: number, height: number, pixelRatio: number): void {
    const prevGrade = this.grade;
    const keep = prevGrade ? {
      vignette: prevGrade.uniforms.uVignette.value, contrast: prevGrade.uniforms.uContrast.value,
      saturation: prevGrade.uniforms.uSaturation.value, lift: prevGrade.uniforms.uLift.value.clone(), gain: prevGrade.uniforms.uGain.value.clone(),
    } : null;
    const bloomKeep = this.bloom ? { strength: this.bloom.strength, radius: this.bloom.radius, threshold: this.bloom.threshold } : null;
    this.disposeChain();
    this.profile = profile;
    if (!profile.post) return;

    const composer = new EffectComposer(this.renderer);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    const add = (p: Pass) => { composer.addPass(p); this.passes.push(p); };
    add(new RenderPass(this.scene, this.camera));
    if (profile.bloom) {
      const b = new ScaledBloomPass(new THREE.Vector2(width * pixelRatio, height * pixelRatio),
        bloomKeep?.strength ?? BLOOM_DEFAULTS.strength, bloomKeep?.radius ?? BLOOM_DEFAULTS.radius, bloomKeep?.threshold ?? BLOOM_DEFAULTS.threshold);
      b.scale = bloomScale(width * pixelRatio);
      b.setSize(width * pixelRatio, height * pixelRatio);
      add(b);
      this.bloom = b;
    }
    const grade = new OutputGradePass();
    if (keep) grade.setParams(keep);
    if (profile.aa === 'smaa') { add(new SMAAPass()); add(grade); }
    else if (profile.aa === 'fxaa') { add(grade); add(new FXAAPass()); }
    else add(grade);
    this.grade = grade;
    this.composer = composer;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    if (!this.composer) return;
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    if (this.bloom instanceof ScaledBloomPass) {
      this.bloom.scale = bloomScale(width * pixelRatio);
      this.bloom.setSize(width * pixelRatio, height * pixelRatio);
    }
  }

  /** Render the scene to the canvas (through the chain when enabled). */
  render(dt: number): void {
    if (this.composer) this.composer.render(dt);
    else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    }
  }

  get quality(): QualityProfile | null { return this.profile; }

  private disposeChain(): void {
    for (const p of this.passes) p.dispose();
    this.passes = [];
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    this.grade = null;
  }

  dispose(): void { this.disposeChain(); }
}
