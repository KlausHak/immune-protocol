/**
 * [models-hospital] Shared modelling kit.
 *
 * Every hospital/campus model renders with ONE shared MeshStandardMaterial driven by a tiny 16×16
 * colour-swatch atlas (albedo + emissive + roughness/metalness). Each modelled part is painted by
 * baking the UV of its swatch into every vertex, so a whole static assembly (ivory panels, steel,
 * glowing windows, team stripes …) merges into a single BufferGeometry = a single draw call.
 * Team colours get atlas slots allocated on demand (geometry is cached per def × team colour).
 *
 * Everything here is cached and shared: never dispose geometries/materials obtained from this module.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchFogOfWar } from '../../environment/fog';

export type V3 = readonly [number, number, number];
export type Face = '+x' | '-x' | '+z' | '-z' | '+y';

interface SwatchDef { c: number; r?: number; m?: number; e?: number; ei?: number }

/** Named colour swatches (sRGB hex). r = roughness, m = metalness, e/ei = emissive colour/strength. */
const PALETTE = {
  // ── whites & greys
  ivory: { c: 0xefeadf, r: 0.55 },
  white: { c: 0xf8f8f4, r: 0.45 },
  offwhite: { c: 0xd9d5ca, r: 0.6 },
  panel: { c: 0xc2c6ca, r: 0.5, m: 0.1 },
  grey: { c: 0x8b9096, r: 0.6, m: 0.1 },
  darkGrey: { c: 0x50555c, r: 0.6, m: 0.1 },
  graphite: { c: 0x3e444c, r: 0.55, m: 0.12 },
  charcoal: { c: 0x24272c, r: 0.7, m: 0.1 },
  rubber: { c: 0x1b1d20, r: 0.92 },
  black: { c: 0x111214, r: 0.8 },
  // ── metals
  steel: { c: 0xb4bcc4, r: 0.38, m: 0.38 },
  steelDark: { c: 0x6c747d, r: 0.45, m: 0.32 },
  chrome: { c: 0xdde3e9, r: 0.22, m: 0.6 },
  alu: { c: 0xcbd0d4, r: 0.42, m: 0.3 },
  // ── glass & lights (emissive)
  glass: { c: 0x1c3a45, r: 0.12, m: 0.35, e: 0x3cc8ff, ei: 0.32 },
  glassDark: { c: 0x142229, r: 0.12, m: 0.45, e: 0x0d3442, ei: 0.25 },
  glassBlue: { c: 0x3c5d70, r: 0.1, m: 0.4, e: 0x68c4ee, ei: 0.22 },
  winWarm: { c: 0x3a3022, r: 0.3, e: 0xffc070, ei: 1.15 },
  winCool: { c: 0x26343c, r: 0.3, e: 0xcdeeff, ei: 0.85 },
  winCyan: { c: 0x163842, r: 0.2, e: 0x45dcff, ei: 0.9 },
  frame: { c: 0x2c3036, r: 0.5, m: 0.3 },
  screen: { c: 0x0f2a31, r: 0.25, e: 0x5ff4ff, ei: 2.2 },
  visor: { c: 0x123640, r: 0.15, m: 0.3, e: 0x4fe6ff, ei: 1.5 },
  visorUv: { c: 0x2a1640, r: 0.15, m: 0.3, e: 0xb46bff, ei: 1.9 },
  uvGlow: { c: 0x2c1446, r: 0.3, e: 0xa65cff, ei: 3.0 },
  greenGlow: { c: 0x123f22, r: 0.3, e: 0x2cf06a, ei: 2.6 },
  redGlow: { c: 0x3d1010, r: 0.3, e: 0xff3a2e, ei: 2.6 },
  amberGlow: { c: 0x3d2c10, r: 0.3, e: 0xffaa28, ei: 2.4 },
  blueGlow: { c: 0x101c3d, r: 0.3, e: 0x3e7bff, ei: 2.8 },
  lamp: { c: 0xfff3dc, r: 0.3, e: 0xffd49a, ei: 3.2 },
  headlight: { c: 0xf4f1e6, r: 0.2, e: 0xfff0d0, ei: 2.0 },
  tailLight: { c: 0x5a1210, r: 0.3, e: 0xff2a1a, ei: 1.4 },
  whiteGlow: { c: 0xffffff, r: 0.3, e: 0xf4fbff, ei: 2.2 },
  tealGlow: { c: 0x1f9e94, r: 0.3, e: 0x2fe8d8, ei: 2.6 },
  // ── hospital brand & equipment
  teal: { c: 0x22c4b6, r: 0.45 },
  tealDark: { c: 0x167f77, r: 0.5 },
  pharmGreen: { c: 0x1f9a4b, r: 0.45 },
  hazmat: { c: 0xe6d06a, r: 0.6 },
  hazmatDark: { c: 0xb59c40, r: 0.65 },
  hazYellow: { c: 0xf1c21f, r: 0.5 },
  hazBlack: { c: 0x1f1f1f, r: 0.6 },
  nitrile: { c: 0x5078d0, r: 0.6 },
  coneOrange: { c: 0xf06a1e, r: 0.55 },
  skin1: { c: 0xe6bb94, r: 0.7 },
  skin2: { c: 0xb98058, r: 0.7 },
  skin3: { c: 0x7b5034, r: 0.7 },
  hair: { c: 0x3b2a20, r: 0.8 },
  capsuleA: { c: 0xf6f3ea, r: 0.3 },
  capsuleB: { c: 0xf0a43a, r: 0.3 },
  cardboard: { c: 0xb89366, r: 0.85 },
  wrap: { c: 0xcfe2ea, r: 0.25, m: 0.1 },
  binBlue: { c: 0x3a7cc8, r: 0.5 },
  // ── construction
  concrete: { c: 0xa6a299, r: 0.9 },
  concreteLight: { c: 0xc2beb4, r: 0.88 },
  concreteDark: { c: 0x7a776f, r: 0.9 },
  asphalt: { c: 0x3a3c40, r: 0.95 },
  brick: { c: 0x8b4530, r: 0.85 },
  brickDark: { c: 0x683223, r: 0.88 },
  brickLight: { c: 0xa65c3e, r: 0.85 },
  copper: { c: 0x6f9c8c, r: 0.55, m: 0.35 },
  roofDark: { c: 0x3f4247, r: 0.85 },
  roofGravel: { c: 0x6e6b66, r: 0.95 },
  wood: { c: 0x8a6945, r: 0.8 },
  woodDark: { c: 0x5a4330, r: 0.85 },
  woodLight: { c: 0xb08b5c, r: 0.8 },
  scaffold: { c: 0xd9a21b, r: 0.55, m: 0.2 },
  plank: { c: 0xa07c4c, r: 0.85 },
  // ── nature
  birch: { c: 0xebe7de, r: 0.8 },
  birchMark: { c: 0x2a2724, r: 0.9 },
  leafGold: { c: 0xe9b630, r: 0.75 },
  leafAmber: { c: 0xd98a24, r: 0.75 },
  leafLime: { c: 0xb9b246, r: 0.75 },
  leafGreen: { c: 0x587638, r: 0.8 },
  pine: { c: 0x2b5137, r: 0.85 },
  pineDark: { c: 0x213f2d, r: 0.88 },
  trunk: { c: 0x5a4231, r: 0.9 },
  bush: { c: 0x4b6932, r: 0.85 },
  bushDark: { c: 0x3a532a, r: 0.88 },
  bushAutumn: { c: 0x8c5a29, r: 0.85 },
  granite: { c: 0x8d8a86, r: 0.85 },
  granitePink: { c: 0x9e8b83, r: 0.85 },
  graniteDark: { c: 0x67645f, r: 0.9 },
  lichen: { c: 0x8f9466, r: 0.95 },
  snow: { c: 0xf0f4f8, r: 0.7 },
  reed: { c: 0xb3995c, r: 0.85 },
  reedDark: { c: 0x857142, r: 0.9 },
  cattail: { c: 0x5a3a23, r: 0.9 },
  lawn: { c: 0x5b8a3c, r: 0.9 },
  soil: { c: 0x5c4532, r: 0.95 },
  // ── vehicles
  carRed: { c: 0xb3342c, r: 0.35, m: 0.25 },
  carBlue: { c: 0x2f5e9c, r: 0.35, m: 0.25 },
  carSilver: { c: 0xb7bcc2, r: 0.3, m: 0.5 },
  carBlack: { c: 0x232528, r: 0.3, m: 0.35 },
  carWhite: { c: 0xecece8, r: 0.35, m: 0.15 },
  carGreen: { c: 0x2e5a46, r: 0.35, m: 0.25 },
  carYellow: { c: 0xd7ad35, r: 0.35, m: 0.2 },
  busBlue: { c: 0x1c6cc4, r: 0.4, m: 0.15 },
  ambYellow: { c: 0xe7dc3c, r: 0.4, m: 0.1 },
  signBlue: { c: 0x1f5db6, r: 0.45 },
  signRed: { c: 0xc8352c, r: 0.45 },
  // ── playful (children's hospital)
  playRed: { c: 0xe8553b, r: 0.5 },
  playOrange: { c: 0xf39a2b, r: 0.5 },
  playYellow: { c: 0xf6cf3a, r: 0.5 },
  playGreen: { c: 0x7cc84a, r: 0.5 },
  playBlue: { c: 0x4aa8e8, r: 0.5 },
  playPurple: { c: 0x9b6ae0, r: 0.5 },
  playPink: { c: 0xf28bb3, r: 0.5 },
  finBlue: { c: 0x1f4fa0, r: 0.5 },
} satisfies Record<string, SwatchDef>;

export type BaseSw = keyof typeof PALETTE;
export type TeamSw = 'team' | 'teamDark' | 'teamLight' | 'teamGlow';
export type Sw = BaseSw | TeamSw;

/** Default hospital team colour (FACTIONS.hospital.color). */
export const BRAND_TEAL = 0x2fd6c6;
const ATLAS = 16;
/** emissive map texels are stored ÷ this, material.emissiveIntensity multiplies back (HDR glow up to 4). */
const EMISSIVE_SCALE = 4;

interface Atlas { albedo: THREE.DataTexture; emissive: THREE.DataTexture; orm: THREE.DataTexture; a: Uint8Array; e: Uint8Array; o: Uint8Array }
let atlas: Atlas | null = null;
const swatchIdx = new Map<string, number>();
let nextSlot = 0;
const _c = new THREE.Color();

function dataTex(data: Uint8Array, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, ATLAS, ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function getAtlas(): Atlas {
  if (atlas) return atlas;
  const n = ATLAS * ATLAS * 4;
  const a = new Uint8Array(n), e = new Uint8Array(n), o = new Uint8Array(n);
  atlas = { a, e, o, albedo: dataTex(a, true), emissive: dataTex(e, false), orm: dataTex(o, false) };
  for (const [name, def] of Object.entries(PALETTE) as Array<[string, SwatchDef]>) { swatchIdx.set(name, nextSlot); writeSwatch(nextSlot++, def); }
  return atlas;
}

function writeSwatch(i: number, d: SwatchDef): void {
  const A = getAtlas(), p = i * 4;
  A.a[p] = (d.c >> 16) & 255; A.a[p + 1] = (d.c >> 8) & 255; A.a[p + 2] = d.c & 255; A.a[p + 3] = 255;
  if (d.e !== undefined) {
    _c.setHex(d.e); // linear working space
    const k = (d.ei ?? 1) / EMISSIVE_SCALE;
    A.e[p] = Math.round(Math.min(1, _c.r * k) * 255); A.e[p + 1] = Math.round(Math.min(1, _c.g * k) * 255); A.e[p + 2] = Math.round(Math.min(1, _c.b * k) * 255);
  } else { A.e[p] = A.e[p + 1] = A.e[p + 2] = 0; }
  A.e[p + 3] = 255;
  A.o[p] = 255; A.o[p + 1] = Math.round((d.r ?? 0.6) * 255); A.o[p + 2] = Math.round((d.m ?? 0) * 255); A.o[p + 3] = 255;
  A.albedo.needsUpdate = true; A.emissive.needsUpdate = true; A.orm.needsUpdate = true;
}

export function swatch(name: BaseSw): number {
  getAtlas();
  return swatchIdx.get(name) ?? 0;
}

/** Atlas slots for one team colour. */
export interface TeamPal { hex: number; key: string; team: number; teamDark: number; teamLight: number; teamGlow: number }
const teamPals = new Map<number, TeamPal>();

export function teamPal(color: THREE.Color | number): TeamPal {
  const hex = typeof color === 'number' ? color : color.getHex();
  const hit = teamPals.get(hex);
  if (hit) return hit;
  getAtlas();
  if (nextSlot + 4 > ATLAS * ATLAS) return hex === BRAND_TEAL ? teamPal(0x2fd6c7) : teamPal(BRAND_TEAL); // atlas full → reuse
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const mix = (t: number, k: number) => Math.round(t + (255 - t) * k);
  const dark = (Math.round(r * 0.55) << 16) | (Math.round(g * 0.55) << 8) | Math.round(b * 0.55);
  const light = (mix(r, 0.5) << 16) | (mix(g, 0.5) << 8) | mix(b, 0.5);
  const pal: TeamPal = { hex, key: hex.toString(16), team: nextSlot, teamDark: nextSlot + 1, teamLight: nextSlot + 2, teamGlow: nextSlot + 3 };
  writeSwatch(nextSlot++, { c: hex, r: 0.42, m: 0.08 });
  writeSwatch(nextSlot++, { c: dark, r: 0.5, m: 0.1 });
  writeSwatch(nextSlot++, { c: light, r: 0.45 });
  writeSwatch(nextSlot++, { c: dark, r: 0.3, e: hex, ei: 2.4 });
  teamPals.set(hex, pal);
  return pal;
}

function uvOf(i: number): [number, number] {
  return [((i % ATLAS) + 0.5) / ATLAS, (Math.floor(i / ATLAS) + 0.5) / ATLAS];
}

// ───────────────────────────── materials ─────────────────────────────

const matCache = new Map<string, THREE.Material>();
function cachedMat<T extends THREE.Material>(key: string, make: () => T): T {
  let m = matCache.get(key) as T | undefined;
  if (!m) { m = make(); matCache.set(key, m); }
  return m;
}

export type AtlasFlavor = 'unit' | 'struct' | 'structDamaged';

/**
 * The shared atlas material. 'unit' = units (no fog patch); 'struct' = buildings, resources and doodads
 * (fog-of-war patched); 'structDamaged' = darkened/flickering variant swapped in for burning buildings.
 */
export function atlasMat(flavor: AtlasFlavor = 'struct'): THREE.MeshStandardMaterial {
  return cachedMat(`atlas:${flavor}`, () => {
    const A = getAtlas();
    const m = new THREE.MeshStandardMaterial({
      map: A.albedo, emissiveMap: A.emissive, emissive: 0xffffff, emissiveIntensity: EMISSIVE_SCALE,
      roughnessMap: A.orm, metalnessMap: A.orm, roughness: 1, metalness: 1,
    });
    m.name = `hospital-atlas-${flavor}`;
    if (flavor === 'structDamaged') { m.color.setHex(0x8d847c); m.emissiveIntensity = EMISSIVE_SCALE * 0.45; }
    if (flavor !== 'unit') patchFogOfWar(m);
    return m;
  });
}

/** A flat emissive material (for animated lights). Cached by colour/intensity/flavour. */
export function glowMat(hex: number, intensity: number, fog: boolean): THREE.MeshStandardMaterial {
  const key = `glow:${hex}:${intensity.toFixed(3)}:${fog ? 1 : 0}`;
  return cachedMat(key, () => {
    const m = new THREE.MeshStandardMaterial({ color: 0x141414, emissive: hex, emissiveIntensity: intensity, roughness: 0.4, metalness: 0 });
    m.name = key;
    if (fog) patchFogOfWar(m);
    return m;
  });
}

/** `levels` shared glow materials from dim → bright; pick one per frame to animate a light without per-instance materials. */
export function glowRamp(hex: number, min: number, max: number, fog: boolean, levels = 8): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];
  for (let i = 0; i < levels; i++) out.push(glowMat(hex, min + (max - min) * (i / (levels - 1)), fog));
  return out;
}

export function rampPick<T>(ramp: readonly T[], t: number): T {
  const i = Math.max(0, Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1))));
  return ramp[i]!;
}

/** Additive transparent flash material (muzzle flashes, sparks, spray mist). */
export function flashMat(hex: number, strength = 1.6): THREE.MeshBasicMaterial {
  return cachedMat(`flash:${hex}:${strength}`, () => {
    const m = new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    m.color.multiplyScalar(strength);
    m.name = `flash-${hex.toString(16)}`;
    return m;
  });
}

// ───────────────────────────── geometry kit ─────────────────────────────

const ORIGIN: V3 = [0, 0, 0];
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0);
const TEAM_KEYS: Record<string, true> = { team: true, teamDark: true, teamLight: true, teamGlow: true };

const FACE_ROT: Record<Face, V3> = {
  '+z': [0, 0, 0], '-z': [0, Math.PI, 0], '+x': [0, Math.PI / 2, 0], '-x': [0, -Math.PI / 2, 0], '+y': [-Math.PI / 2, 0, 0],
};

/** 5×5 pixel glyphs (rows top → bottom) for signage text. */
const GLYPHS: Record<string, string[]> = {
  H: ['X...X', 'X...X', 'XXXXX', 'X...X', 'X...X'],
  E: ['XXXX', 'X...', 'XXX.', 'X...', 'XXXX'],
  R: ['XXXX.', 'X...X', 'XXXX.', 'X..X.', 'X...X'],
  P: ['XXXX', 'X..X', 'XXXX', 'X...', 'X...'],
  S: ['.XXXX', 'X....', '.XXX.', '....X', 'XXXX.'],
  ' ': ['..', '..', '..', '..', '..'],
};

function compose(pos: V3, rot?: V3, scl?: V3 | number): THREE.Matrix4 {
  _p.set(pos[0], pos[1], pos[2]);
  if (rot) _q.setFromEuler(_e.set(rot[0], rot[1], rot[2])); else _q.identity();
  if (scl === undefined) _s.set(1, 1, 1); else if (typeof scl === 'number') _s.setScalar(scl); else _s.set(scl[0], scl[1], scl[2]);
  return _m.compose(_p, _q, _s);
}

/**
 * Collects painted parts and merges them into one geometry. All parts get position/normal + swatch UVs.
 * A transform stack (`group`) lets sub-assemblies be placed/rotated as a unit.
 */
export class Kit {
  private parts: THREE.BufferGeometry[] = [];
  private stack: THREE.Matrix4[] = [];
  constructor(readonly team: TeamPal = teamPal(BRAND_TEAL)) {}

  idx(s: Sw): number { return TEAM_KEYS[s] ? this.team[s as TeamSw] : swatch(s as BaseSw); }
  get count(): number { return this.parts.length; }

  /** Add (and consume) a geometry with an optional local matrix. flat = recompute faceted normals. */
  addM(g: THREE.BufferGeometry, s: Sw, m?: THREE.Matrix4, flat = false): this {
    let geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
    geo.morphAttributes = {};
    geo.clearGroups();
    const world = new THREE.Matrix4();
    for (const sm of this.stack) world.multiply(sm);
    if (m) world.multiply(m);
    geo.applyMatrix4(world);
    if (flat || !geo.attributes.normal) geo.computeVertexNormals();
    const [u, v] = uvOf(this.idx(s));
    const n = geo.attributes.position!.count, uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { uv[i * 2] = u; uv[i * 2 + 1] = v; }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.parts.push(geo);
    return this;
  }

  add(g: THREE.BufferGeometry, s: Sw, pos: V3 = ORIGIN, rot?: V3, scl?: V3 | number, flat = false): this {
    return this.addM(g, s, compose(pos, rot, scl).clone(), flat);
  }

  /** Add an already-painted geometry (keeps its swatch UVs); the source is cloned, not consumed. */
  addPainted(g: THREE.BufferGeometry, pos: V3 = ORIGIN, rot?: V3, scl?: V3 | number): this {
    const geo = (g.index ? g.toNonIndexed() : g.clone());
    for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    geo.morphAttributes = {}; geo.clearGroups();
    const world = new THREE.Matrix4();
    for (const sm of this.stack) world.multiply(sm);
    world.multiply(compose(pos, rot, scl).clone());
    geo.applyMatrix4(world);
    this.parts.push(geo);
    return this;
  }

  /** Run fn with an extra parent transform applied to every part it adds. */
  group(pos: V3, rot: V3 | undefined, fn: () => void, scl?: V3 | number): this {
    this.stack.push(compose(pos, rot, scl).clone());
    try { fn(); } finally { this.stack.pop(); }
    return this;
  }

  /** Box centred at c. */
  box(s: Sw, size: V3, c: V3, rot?: V3): this {
    return this.add(new THREE.BoxGeometry(size[0], size[1], size[2]), s, c, rot);
  }
  /** Box resting on base (base = bottom centre). */
  block(s: Sw, size: V3, base: V3, rot?: V3): this {
    return this.box(s, size, [base[0], base[1] + size[1] / 2, base[2]], rot);
  }
  /** Cylinder (axis Y) centred at c. */
  cyl(s: Sw, rt: number, rb: number, h: number, seg: number, c: V3, rot?: V3, scl?: V3 | number, open = false): this {
    return this.add(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), s, c, rot, scl);
  }
  /** Vertical cylinder standing on base. */
  post(s: Sw, r: number, h: number, base: V3, seg = 8, rTop = r): this {
    return this.cyl(s, rTop, r, h, seg, [base[0], base[1] + h / 2, base[2]]);
  }
  /** Cylinder from a to b. */
  rod(s: Sw, a: V3, b: V3, r: number, seg = 6, rEnd = r): this {
    _a.set(a[0], a[1], a[2]); _b.set(b[0], b[1], b[2]); _d.subVectors(_b, _a);
    const len = _d.length(); if (len < 1e-5) return this;
    _q.setFromUnitVectors(Y_AXIS, _d.normalize());
    _p.addVectors(_a, _b).multiplyScalar(0.5);
    const m = new THREE.Matrix4().compose(_p, _q, _s.set(1, 1, 1));
    return this.addM(new THREE.CylinderGeometry(rEnd, r, len, seg), s, m);
  }
  /** Box from a to b (limbs, struts): w = sideways width (local Z), t = thickness (local Y). */
  beam(s: Sw, a: V3, b: V3, w: number, t: number): this {
    _a.set(a[0], a[1], a[2]); _b.set(b[0], b[1], b[2]); _d.subVectors(_b, _a);
    const len = _d.length(); if (len < 1e-5) return this;
    _q.setFromUnitVectors(X_AXIS, _d.normalize());
    _p.addVectors(_a, _b).multiplyScalar(0.5);
    const m = new THREE.Matrix4().compose(_p, _q, _s.set(1, 1, 1));
    return this.addM(new THREE.BoxGeometry(len, t, w), s, m);
  }
  sphere(s: Sw, r: number, c: V3, scl?: V3 | number, ws = 10, hs = 7): this {
    return this.add(new THREE.SphereGeometry(r, ws, hs), s, c, undefined, scl);
  }
  /** Upper hemisphere cap (thetaLen < π/2 = shallower). */
  dome(s: Sw, r: number, c: V3, scl?: V3 | number, ws = 12, hs = 5, thetaLen = Math.PI / 2, rot?: V3): this {
    return this.add(new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, thetaLen), s, c, rot, scl);
  }
  ico(s: Sw, r: number, c: V3, detail = 0, scl?: V3 | number, rot?: V3): this {
    return this.add(new THREE.IcosahedronGeometry(r, detail), s, c, rot, scl, true);
  }
  cone(s: Sw, r: number, h: number, seg: number, c: V3, rot?: V3, scl?: V3 | number): this {
    return this.add(new THREE.ConeGeometry(r, h, seg), s, c, rot, scl);
  }
  torus(s: Sw, R: number, r: number, c: V3, rot?: V3, arc = Math.PI * 2, rs = 6, ts = 18): this {
    return this.add(new THREE.TorusGeometry(R, r, rs, ts, arc), s, c, rot);
  }
  /** Flat quad facing `face`, centred at c. */
  quad(s: Sw, w: number, h: number, c: V3, face: Face = '+z'): this {
    return this.add(new THREE.PlaneGeometry(w, h), s, c, FACE_ROT[face]);
  }
  /** Flat disc / ring lying on +Y. */
  disc(s: Sw, r: number, c: V3, seg = 24): this {
    return this.add(new THREE.CircleGeometry(r, seg), s, c, FACE_ROT['+y']);
  }
  ring(s: Sw, r0: number, r1: number, c: V3, seg = 32): this {
    return this.add(new THREE.RingGeometry(r0, r1, seg), s, c, FACE_ROT['+y']);
  }
  /** Rectangular frustum (chamfered plinths, roofs): bottom w×d, top wt×dt, height h, standing on base. */
  frustum(s: Sw, w: number, d: number, wt: number, dt: number, h: number, base: V3): this {
    const g = new THREE.CylinderGeometry(Math.SQRT1_2, Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const top = pos.getY(i) > 0;
      pos.setXYZ(i, pos.getX(i) * (top ? wt : w), pos.getY(i) * h + h / 2, pos.getZ(i) * (top ? dt : d));
    }
    return this.add(g, s, base, undefined, undefined, true);
  }
  /** Gable/prism roof along X: width w (X), depth d (Z), ridge height h, base = bottom centre. */
  prism(s: Sw, w: number, d: number, h: number, base: V3, rot?: V3): this {
    const shape = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, h)]);
    const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false }).translate(0, 0, -w / 2).rotateY(Math.PI / 2);
    return this.add(g, s, base, rot, undefined, true);
  }
  /** Extruded 2D shape (XY plane) with depth along +Z, then placed. */
  extrude(s: Sw, shape: THREE.Shape, depth: number, pos: V3, rot?: V3, scl?: V3 | number): this {
    return this.add(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 6 }), s, pos, rot, scl, true);
  }
  /** "+" emblem facing `face`: arm length `size`, bar thickness `bar`, extruded `depth`. */
  plus(s: Sw, size: number, bar: number, depth: number, c: V3, face: Face = '+z'): this {
    return this.group(c, FACE_ROT[face], () => {
      this.box(s, [size, bar, depth], [0, 0, 0]);
      const arm = (size - bar) / 2;
      this.box(s, [bar, arm, depth], [0, bar / 2 + arm / 2, 0]);
      this.box(s, [bar, arm, depth], [0, -bar / 2 - arm / 2, 0]);
    });
  }
  /** Blocky pixel text facing `face`, centred at c; px = pixel size. */
  text(s: Sw, str: string, px: number, depth: number, c: V3, face: Face = '+z'): this {
    const glyphs = [...str].map((ch) => GLYPHS[ch] ?? GLYPHS[' ']!);
    const widths = glyphs.map((g) => g[0]!.length);
    const total = widths.reduce((a, w) => a + w, 0) + (glyphs.length - 1);
    return this.group(c, FACE_ROT[face], () => {
      let cx = -total / 2;
      glyphs.forEach((g, gi) => {
        g.forEach((row, ri) => {
          let x = 0;
          while (x < row.length) {
            if (row[x] !== 'X') { x++; continue; }
            let e = x; while (e < row.length && row[e] === 'X') e++;
            const len = e - x;
            this.box(s, [len * px, px, depth], [(cx + x + len / 2) * px, (2 - ri) * px, 0]);
            x = e;
          }
        });
        cx += widths[gi]! + 1;
      });
    });
  }

  /** Merge everything added so far into one geometry (parts are consumed). */
  merge(): THREE.BufferGeometry {
    if (this.parts.length === 0) return new THREE.BufferGeometry();
    const g = this.parts.length === 1 ? this.parts[0]! : mergeGeometries(this.parts, false);
    if (!g) throw new Error('[models-hospital] mergeGeometries failed');
    for (const p of this.parts) if (p !== g) p.dispose();
    this.parts = [];
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}

/** Build-once cache for geometries (keyed by def/kind + team + variant). */
const geoCache = new Map<string, unknown>();
export function memo<T>(key: string, make: () => T): T {
  if (geoCache.has(key)) return geoCache.get(key) as T;
  const v = make();
  geoCache.set(key, v);
  return v;
}

// ───────────────────────────── small helpers ─────────────────────────────

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable variant bucket 0..n-1 for a seed (hashed so consecutive ids spread out). */
export function bucket(seed: number, n: number): number {
  let x = (seed | 0) ^ 0x5bd1e995;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) % Math.max(1, n);
}

export function makeMesh(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], name: string): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  return m;
}

/** Mark a mesh as an effect (no shadows; the render core enables shadows on everything after creation). */
export function fx<T extends THREE.Object3D>(o: T): T { o.userData.hospFx = true; o.castShadow = false; o.receiveShadow = false; return o; }

/** Re-apply fx flags (call once from the first update(), after the render core's shadow traverse). */
export function fixFx(root: THREE.Object3D): void {
  root.traverse((o) => { if (o.userData.hospFx) { o.castShadow = false; o.receiveShadow = false; } });
}
