/**
 * [vfx] Procedural sprite atlas — 4×4 cells of 128 px generated once per VfxSystem (no image files).
 * RGB carries shading (white for pure glows), A carries coverage. Every cell fades to zero alpha
 * before its border, so trilinear mipmapping never bleeds one sprite into its neighbour.
 *
 * Cell (cx, cy) of sprite s: cx = s % 4, cy = floor(s / 4); data rows grow upward (v = 0 at the bottom),
 * matching the shaders' `uv = (cell + corner + 0.5) / 4` with corner.y = +0.5 at the top of a billboard.
 */
import * as THREE from 'three';

export const SPR = {
  GLOW: 0,     // soft radial bell
  SPARK: 1,    // tight hot dot — stretched into streaks
  FLARE: 2,    // star flare with rays (flashes)
  RING: 3,     // thin ring
  SHOCK: 4,    // thick shockwave ring with inner gradient
  SMOKE: 5,    // noisy puff
  SMOKE2: 6,   // second puff variant
  PLUS: 7,     // rounded medical "+" with halo
  GOO: 8,      // glossy blob (shaded)
  DROPLET: 9,  // small soft droplet / mist bead
  DEBRIS: 10,  // angular chunk (faceted shading)
  SPLAT: 11,   // splatter with satellite drops (decal)
  SCORCH: 12,  // scorch / soot mark (decal)
  SPORES: 13,  // cluster of tiny spores
  BOLT: 14,    // elongated capsule streak
  SPARKLE: 15, // crisp 4-point twinkle
} as const;

const CELL = 128;
const GRID = 4;
const SIZE = CELL * GRID;

// ───────────── tiny noise helpers (deterministic) ─────────────
function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
function fbm(x: number, y: number, seed: number, oct = 4): number {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f, seed + i * 17); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, x: number) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
function sdBox(px: number, py: number, bx: number, by: number): number {
  const qx = Math.abs(px) - bx, qy = Math.abs(py) - by;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1));
  return Math.hypot(px - ax - vx * t, py - ay - vy * t);
}

/** Painter: (u, v) in [-1, 1] (v up) → writes rgba (0..1) into out. */
type Painter = (u: number, v: number, out: number[]) => void;

function seeded(n: number, seed: number): number[] { const r: number[] = []; for (let i = 0; i < n; i++) r.push(hash2(i, 7, seed)); return r; }

const debrisR = seeded(7, 31).map((h) => 0.5 + h * 0.38);
const sporeDots = seeded(24, 77);
const splatDrops = seeded(36, 101);

const PAINTERS: Painter[] = [];
PAINTERS[SPR.GLOW] = (u, v, o) => {
  const r2 = u * u + v * v;
  const a = r2 < 1 ? (1 - r2) ** 3 : 0;
  o[0] = o[1] = o[2] = 1; o[3] = a;
};
PAINTERS[SPR.SPARK] = (u, v, o) => {
  const r = Math.hypot(u, v);
  const a = r < 1 ? Math.min(1, (1 - r) ** 4 * 1.1 + Math.exp(-r * r * 40) * 0.7) : 0;
  o[0] = o[1] = o[2] = 1; o[3] = a;
};
PAINTERS[SPR.FLARE] = (u, v, o) => {
  const r = Math.hypot(u, v);
  const core = Math.exp(-r * r * 14);
  const au = Math.abs(u), av = Math.abs(v);
  const rays = Math.exp(-av * 34) * Math.max(0, 1 - au) ** 2 + Math.exp(-au * 34) * Math.max(0, 1 - av) ** 2;
  const p = Math.abs(u + v) * 0.7071, q = Math.abs(u - v) * 0.7071;
  const diag = (Math.exp(-q * 50) * Math.max(0, 1 - p * 1.25) ** 3 + Math.exp(-p * 50) * Math.max(0, 1 - q * 1.25) ** 3) * 0.45;
  const halo = r < 1 ? (1 - r * r) ** 3 * 0.32 : 0;
  o[0] = o[1] = o[2] = 1; o[3] = clamp01(core + rays * 0.9 + diag + halo);
};
PAINTERS[SPR.RING] = (u, v, o) => {
  const r = Math.hypot(u, v);
  const a = Math.exp(-(((r - 0.8) / 0.075) ** 2)) + (r < 0.8 ? 0.06 * (r / 0.8) ** 2 : 0);
  o[0] = o[1] = o[2] = 1; o[3] = clamp01(a);
};
PAINTERS[SPR.SHOCK] = (u, v, o) => {
  const r = Math.hypot(u, v);
  const inner = smooth(0.15, 0.86, r) ** 2;
  const outer = 1 - smooth(0.85, 0.97, r);
  o[0] = o[1] = o[2] = 1; o[3] = clamp01(inner * outer * 1.1);
};
const smokePainter = (seed: number): Painter => (u, v, o) => {
  const r = Math.hypot(u, v);
  const n = fbm(u * 2.3 + 11.3, v * 2.3 + 5.1, seed, 5);
  const d = r + (n - 0.5) * 0.62;
  const a = smooth(0.96, 0.22, d) * (0.55 + 0.7 * n);
  const shade = 0.66 + 0.24 * (v * 0.5 + 0.5) + (n - 0.5) * 0.35;
  o[0] = o[1] = o[2] = clamp01(shade); o[3] = clamp01(a);
};
PAINTERS[SPR.SMOKE] = smokePainter(3);
PAINTERS[SPR.SMOKE2] = smokePainter(9);
PAINTERS[SPR.PLUS] = (u, v, o) => {
  const sd = Math.min(sdBox(u, v, 0.58, 0.17), sdBox(u, v, 0.17, 0.58)) - 0.07;
  const shape = smooth(0.035, -0.035, sd);
  const glow = Math.exp(-Math.max(sd, 0) * 10) * 0.42 * (1 - smooth(0.6, 1, Math.hypot(u, v)));
  o[0] = o[1] = o[2] = 1; o[3] = clamp01(Math.max(shape, glow));
};
PAINTERS[SPR.GOO] = (u, v, o) => {
  const r = Math.hypot(u, v), th = Math.atan2(v, u);
  const R = 0.78 + 0.07 * Math.sin(3 * th + 1) + 0.05 * Math.sin(5 * th + 2.3);
  const a = smooth(R, R - 0.07, r);
  const base = 0.5 + 0.35 * (1 - (r / R) ** 2);
  const spec = Math.exp(-((u + 0.3) ** 2 + (v - 0.33) ** 2) * 24) * 0.95;
  const rim = smooth(R - 0.24, R - 0.02, r) * 0.22;
  o[0] = o[1] = o[2] = clamp01(base + spec + rim); o[3] = a;
};
PAINTERS[SPR.DROPLET] = (u, v, o) => {
  const r = Math.hypot(u, v);
  const a = r < 1 ? smooth(0.72, 0.38, r) * 0.85 + (1 - r * r) ** 3 * 0.3 : 0;
  o[0] = o[1] = o[2] = clamp01(0.78 + 0.22 * (1 - r)); o[3] = clamp01(a);
};
PAINTERS[SPR.DEBRIS] = (u, v, o) => {
  const r = Math.hypot(u, v), th = Math.atan2(v, u) + Math.PI;
  const n = debrisR.length, seg = (th / (Math.PI * 2)) * n;
  const i0 = Math.floor(seg) % n, i1 = (i0 + 1) % n, f = seg - Math.floor(seg);
  const R = debrisR[i0]! * (1 - f) + debrisR[i1]! * f;
  const a = smooth(R, R - 0.05, r);
  const facet = hash2(i0, 3, 55);
  const shade = 0.5 + 0.38 * facet + 0.14 * v - 0.12 * smooth(R - 0.2, R, r);
  o[0] = o[1] = o[2] = clamp01(shade); o[3] = a;
};
PAINTERS[SPR.SPLAT] = (u, v, o) => {
  const r = Math.hypot(u, v), th = Math.atan2(v, u);
  const R = 0.4 + 0.1 * (vnoise(Math.cos(th) * 2.2 + 3, Math.sin(th) * 2.2 + 3, 41) - 0.5) * 2 + 0.04 * Math.sin(7 * th);
  let a = smooth(R + 0.03, R - 0.03, r);
  for (let k = 0; k < 9; k++) {
    const ang = splatDrops[k * 4]! * Math.PI * 2, dd = 0.5 + splatDrops[k * 4 + 1]! * 0.38, rr = 0.035 + splatDrops[k * 4 + 2]! * 0.08;
    const cx = Math.cos(ang) * dd, cy = Math.sin(ang) * dd;
    a = Math.max(a, smooth(rr + 0.02, rr - 0.02, Math.hypot(u - cx, v - cy)));
    if (splatDrops[k * 4 + 3]! > 0.45) {
      const w = 0.025 + rr * 0.25;
      a = Math.max(a, smooth(w + 0.015, w - 0.015, segDist(u, v, cx * 0.45, cy * 0.45, cx, cy)));
    }
  }
  const n = fbm(u * 4 + 2, v * 4 + 9, 13, 3);
  o[0] = o[1] = o[2] = clamp01(0.62 + 0.38 * n + 0.15 * (1 - r)); o[3] = a * (0.82 + 0.18 * n);
};
PAINTERS[SPR.SCORCH] = (u, v, o) => {
  const r = Math.hypot(u, v), th = Math.atan2(v, u);
  const n = fbm(u * 3 + 4, v * 3 + 1, 21, 4);
  const streak = vnoise(th * 3.2 + 10, 0.5, 23);
  const d = r + (n - 0.5) * 0.34 - (streak - 0.5) * 0.22;
  const a = smooth(0.95, 0.12, d) * 0.95;
  o[0] = o[1] = o[2] = clamp01(0.2 + 0.65 * smooth(0.05, 0.95, d) + (n - 0.5) * 0.2); o[3] = clamp01(a);
};
PAINTERS[SPR.SPORES] = (u, v, o) => {
  let a = 0;
  for (let k = 0; k < 8; k++) {
    const ang = sporeDots[k * 3]! * Math.PI * 2, dd = Math.sqrt(sporeDots[k * 3 + 1]!) * 0.58, rr = 0.08 + sporeDots[k * 3 + 2]! * 0.1;
    const d = Math.hypot(u - Math.cos(ang) * dd, v - Math.sin(ang) * dd);
    a = Math.max(a, smooth(rr, rr * 0.35, d));
  }
  const r2 = u * u + v * v;
  a = Math.max(a, r2 < 1 ? (1 - r2) ** 3 * 0.22 : 0);
  o[0] = o[1] = o[2] = 1; o[3] = clamp01(a);
};
PAINTERS[SPR.BOLT] = (u, v, o) => {
  const d = segDist(u, v, -0.55, 0, 0.55, 0);
  const a = Math.exp(-d * d * 55) + Math.exp(-d * d * 7) * 0.35;
  o[0] = o[1] = o[2] = 1; o[3] = clamp01(a * (1 - smooth(0.85, 1, Math.abs(u))));
};
PAINTERS[SPR.SPARKLE] = (u, v, o) => {
  const au = Math.abs(u), av = Math.abs(v), r = Math.hypot(u, v);
  const rays = Math.exp(-av * 24) * Math.max(0, 1 - au) ** 4 + Math.exp(-au * 24) * Math.max(0, 1 - av) ** 4;
  const core = Math.exp(-r * r * 30);
  o[0] = o[1] = o[2] = 1; o[3] = clamp01(rays + core);
};

/** Builds the RGBA8 atlas texture (≈ 10 ms). Caller owns disposal. */
export function createSpriteAtlas(): THREE.DataTexture {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const px = [0, 0, 0, 0];
  for (let s = 0; s < GRID * GRID; s++) {
    const paint = PAINTERS[s];
    if (!paint) continue;
    const cx = s % GRID, cy = Math.floor(s / GRID);
    for (let j = 0; j < CELL; j++) {
      const v = ((j + 0.5) / CELL) * 2 - 1;
      for (let i = 0; i < CELL; i++) {
        const u = ((i + 0.5) / CELL) * 2 - 1;
        px[0] = px[1] = px[2] = 1; px[3] = 0;
        paint(u, v, px);
        const edge = smooth(1.0, 0.93, Math.max(Math.abs(u), Math.abs(v)));
        const o = ((cy * CELL + j) * SIZE + (cx * CELL + i)) * 4;
        data[o] = Math.round(clamp01(px[0]!) * 255);
        data[o + 1] = Math.round(clamp01(px[1]!) * 255);
        data[o + 2] = Math.round(clamp01(px[2]!) * 255);
        data[o + 3] = Math.round(clamp01(px[3]! * edge) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 1;
  tex.needsUpdate = true;
  return tex;
}

/** GLSL snippet: atlas UV for sprite index `s` and quad corner in [-0.5, 0.5]². */
export const ATLAS_UV_GLSL = /* glsl */`
vec2 atlasUv(float s, vec2 corner) {
  float cx = mod(s, 4.0);
  float cy = floor(s / 4.0 + 0.001);
  return (vec2(cx, cy) + corner + 0.5) * 0.25;
}
`;

/** Shared fog + premultiplied-output fragment tail. Expects `col` (linear rgb), `a` (coverage), `add` (0 alpha .. 1 additive). */
export const FOG_PREMUL_GLSL = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float fogF = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  col = mix(col, fogColor, fogF * (1.0 - add));
  a *= 1.0 - fogF * add;
#endif
gl_FragColor = vec4(col, 1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
gl_FragColor = vec4(gl_FragColor.rgb * a, a * (1.0 - add));
`;

/** Fog uniforms (cloned so materials don't share uniform objects). */
export function fogUniforms(): Record<string, THREE.IUniform> {
  return THREE.UniformsUtils.clone(THREE.UniformsLib.fog) as Record<string, THREE.IUniform>;
}

/** Premultiplied-alpha blending: alpha particles (a>0) and additive glows (a=0) share one pass. */
export function applyPremulBlending(m: THREE.Material): void {
  m.transparent = true;
  m.depthWrite = false;
  m.depthTest = true;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
}
