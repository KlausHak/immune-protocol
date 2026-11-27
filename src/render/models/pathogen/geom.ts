/**
 * [models-pathogen] Procedural geometry toolkit: seeded RNG/noise, organic primitives (lumpy blobs,
 * variable-radius sweeps, spikes, lathes), per-vertex "paint" for the pathogen shader (see shader.ts)
 * and merging of static parts into one BufferGeometry.
 *
 * Every geometry produced here carries exactly: position, normal, color, aFx, aMat (+ index), so any
 * of them can be merged together with BufferGeometryUtils.mergeGeometries.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ───────────────────────────── RNG & noise ─────────────────────────────

/** mulberry32 — small, fast, deterministic. */
export function rng(seed: number): () => number {
  let a = (Math.floor(seed) >>> 0) ^ 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Noise3 = (x: number, y: number, z: number) => number;

/**
 * Smooth seeded pseudo-noise, roughly in [-1, 1]: a sum of random-direction sine waves. Cheap and
 * isotropic enough for organic lumps and colour mottling.
 */
export function noise3(seed: number, waves = 7, freq = 1): Noise3 {
  const r = rng(seed * 131 + 7);
  const w: number[] = [];
  let norm = 0;
  for (let i = 0; i < waves; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    const f = freq * (1 + i * 0.55) * (0.8 + r() * 0.4);
    const amp = 1 / (1 + i * 0.75);
    w.push(s * Math.cos(th) * f, u * f, s * Math.sin(th) * f, r() * Math.PI * 2, amp);
    norm += amp;
  }
  const k = 1.7 / norm;
  return (x, y, z) => {
    let v = 0;
    for (let i = 0; i < w.length; i += 5) v += Math.sin(x * w[i]! + y * w[i + 1]! + z * w[i + 2]! + w[i + 3]!) * w[i + 4]!;
    return Math.max(-1, Math.min(1, v * k));
  };
}

// ───────────────────────────── paint ─────────────────────────────

export interface Paint {
  /** albedo (team parts: shade multiplier applied to the team colour) */
  color?: THREE.ColorRepresentation;
  /** 0..1 team-tint weight (default 1) */
  team?: number;
  /** acid-green emissive weight */
  accent?: number;
  /** nucleus (team colour) glow weight */
  glow?: number;
  /** membrane wobble weight (smooth parts only) */
  wobble?: number;
  rough?: number;
  metal?: number;
  /** fresnel rim weight (default 1) */
  rim?: number;
  /** flagellum wave: + = wave travelling along X (lateral Z), − = along Y (hanging tendrils) */
  whip?: number;
}
export type PaintFn = (p: THREE.Vector3, n: THREE.Vector3) => Paint;
export type PaintSpec = Paint | PaintFn;

const DEF = { team: 1, accent: 0, glow: 0, wobble: 0, rough: 0.55, metal: 0, rim: 1, whip: 0 };
const _col = new THREE.Color();

export function paint(geo: THREE.BufferGeometry, spec: PaintSpec, base: Paint = {}): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const n = pos.count;
  const col = new Float32Array(n * 3), fx = new Float32Array(n * 4), mt = new Float32Array(n * 4);
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  const fn = typeof spec === 'function' ? spec : null;
  let s: Paint = fn ? base : { ...base, ...(spec as Paint) };
  for (let i = 0; i < n; i++) {
    if (fn) { p.fromBufferAttribute(pos, i); q.fromBufferAttribute(nor, i); s = { ...base, ...fn(p, q) }; }
    _col.set(s.color ?? 0xffffff);
    col[i * 3] = _col.r; col[i * 3 + 1] = _col.g; col[i * 3 + 2] = _col.b;
    fx[i * 4] = s.team ?? DEF.team; fx[i * 4 + 1] = s.accent ?? DEF.accent; fx[i * 4 + 2] = s.glow ?? DEF.glow; fx[i * 4 + 3] = s.wobble ?? DEF.wobble;
    mt[i * 4] = s.rough ?? DEF.rough; mt[i * 4 + 1] = s.metal ?? DEF.metal; mt[i * 4 + 2] = s.rim ?? DEF.rim; mt[i * 4 + 3] = s.whip ?? DEF.whip;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aFx', new THREE.BufferAttribute(fx, 4));
  geo.setAttribute('aMat', new THREE.BufferAttribute(mt, 4));
  return geo;
}

// ───────────────────────────── preparation / transforms ─────────────────────────────

/** Strip uv/tangent attributes, ensure normals and an index (so everything merges together). */
export function prep(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'color' && name !== 'aFx' && name !== 'aMat') geo.deleteAttribute(name);
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  if (!geo.index) {
    const count = geo.getAttribute('position').count;
    const idx = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}

/** Flat-shaded (faceted) version of a geometry — for capsids and plates. */
export function facet(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return prep(g);
}

export type V3 = THREE.Vector3 | readonly [number, number, number];
export interface Xf {
  p?: V3;
  /** Euler XYZ radians, or a quaternion */
  r?: V3 | THREE.Quaternion;
  s?: number | V3;
}
const toV = (v: V3, out = new THREE.Vector3()): THREE.Vector3 => (v instanceof THREE.Vector3 ? out.copy(v) : out.set(v[0], v[1], v[2]));
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _vp = new THREE.Vector3(), _vs = new THREE.Vector3();

export function xfMatrix(xf: Xf, out = new THREE.Matrix4()): THREE.Matrix4 {
  toV(xf.p ?? [0, 0, 0], _vp);
  if (xf.r instanceof THREE.Quaternion) _q.copy(xf.r);
  else if (xf.r) { const r = toV(xf.r); _q.setFromEuler(_e.set(r.x, r.y, r.z)); }
  else _q.identity();
  if (typeof xf.s === 'number') _vs.setScalar(xf.s); else if (xf.s) toV(xf.s, _vs); else _vs.setScalar(1);
  return out.compose(_vp, _q, _vs);
}

export function xform(geo: THREE.BufferGeometry, xf?: Xf): THREE.BufferGeometry {
  if (xf) geo.applyMatrix4(xfMatrix(xf, _m));
  return geo;
}

/** Quaternion rotating +Y onto `dir`. */
export function alignY(dir: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
}

// ───────────────────────────── builder ─────────────────────────────

/** Collects painted parts and merges them into one geometry. */
export class GeoBuilder {
  private parts: THREE.BufferGeometry[] = [];
  /**
   * Add a part. By default it is transformed first (paint functions see model-space positions);
   * `local: true` paints in the part's own space before transforming it.
   */
  add(geo: THREE.BufferGeometry, spec: PaintSpec, xf?: Xf, opts: { base?: Paint; local?: boolean } = {}): this {
    prep(geo);
    if (opts.local) { paint(geo, spec, opts.base); xform(geo, xf); }
    else { xform(geo, xf); paint(geo, spec, opts.base); }
    this.parts.push(geo);
    return this;
  }
  /** add an already painted geometry (copied) */
  addPainted(geo: THREE.BufferGeometry, xf?: Xf): this {
    const g = geo.clone();
    xform(g, xf);
    this.parts.push(g);
    return this;
  }
  get empty(): boolean { return this.parts.length === 0; }
  build(): THREE.BufferGeometry {
    const g = this.parts.length === 1 ? this.parts[0]! : mergeGeometries(this.parts, false);
    if (!g) throw new Error('[models-pathogen] mergeGeometries failed');
    if (this.parts.length > 1) for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ───────────────────────────── primitives ─────────────────────────────

/** Smooth lumpy sphere. `amp` = relative radial noise, `freq` = noise frequency (per unit of radius). */
export function blob(radius: number, detail: number, amp = 0.1, freq = 1.6, seed = 1, scale?: V3): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const nz = noise3(seed, 6, freq);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const sc = scale ? toV(scale) : new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const d = radius * (1 + amp * nz(v.x, v.y, v.z));
    pos.setXYZ(i, v.x * d * sc.x, v.y * d * sc.y, v.z * d * sc.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Plain smooth sphere with few segments (cheap knobs, pustules). */
export function ball(radius: number, w = 10, h = 7): THREE.BufferGeometry {
  return new THREE.SphereGeometry(radius, w, h);
}

/** Flat-shaded icosahedral capsid. */
export function capsid(radius: number, detail = 0): THREE.BufferGeometry {
  return facet(new THREE.IcosahedronGeometry(radius, detail));
}

/**
 * Tube swept along a polyline / curve with a variable radius (parallel-transport frames).
 * `radius(t)` with t = 0..1 along the path. Ends are capped with a fan.
 */
export function sweep(path: THREE.Vector3[] | THREE.Curve<THREE.Vector3>, radius: number | ((t: number) => number), radial = 8, segments = 16, caps = true): THREE.BufferGeometry {
  const pts = Array.isArray(path) ? path : path.getPoints(segments);
  const n = pts.length;
  const rf = typeof radius === 'number' ? () => radius : radius;
  const T: THREE.Vector3[] = [], N: THREE.Vector3[] = [], B: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(n - 1, i + 1)]!;
    T.push(b.clone().sub(a).normalize());
  }
  // initial normal: any vector perpendicular to T0
  const t0 = T[0]!;
  const helper = Math.abs(t0.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  N.push(new THREE.Vector3().crossVectors(t0, helper).normalize());
  for (let i = 1; i < n; i++) {
    const prev = N[i - 1]!, t = T[i]!;
    const nn = prev.clone().sub(t.clone().multiplyScalar(t.dot(prev)));
    if (nn.lengthSq() < 1e-8) nn.copy(prev);
    N.push(nn.normalize());
  }
  for (let i = 0; i < n; i++) B.push(new THREE.Vector3().crossVectors(T[i]!, N[i]!).normalize());

  const verts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = rf(n === 1 ? 0 : i / (n - 1));
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const p = pts[i]!, nn = N[i]!, bb = B[i]!;
      verts.push(p.x + r * (c * nn.x + s * bb.x), p.y + r * (c * nn.y + s * bb.y), p.z + r * (c * nn.z + s * bb.z));
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j, b = i * radial + ((j + 1) % radial), c = (i + 1) * radial + j, d = (i + 1) * radial + ((j + 1) % radial);
      idx.push(a, b, c, b, d, c);
    }
  }
  if (caps) {
    const s0 = verts.length / 3;
    const p0 = pts[0]!, p1 = pts[n - 1]!;
    verts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    for (let j = 0; j < radial; j++) {
      const j1 = (j + 1) % radial;
      idx.push(s0, j1, j);
      idx.push(s0 + 1, (n - 1) * radial + j, (n - 1) * radial + j1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Smooth curve through control points. */
export function curve(points: Array<readonly [number, number, number]>, tension = 0.5): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])), false, 'catmullrom', tension);
}

/** Tapered cone spike, base at origin, pointing +Y. */
export function cone(baseR: number, height: number, radial = 6, tipR = 0): THREE.BufferGeometry {
  const g = tipR > 0 ? new THREE.CylinderGeometry(tipR, baseR, height, radial, 1) : new THREE.ConeGeometry(baseR, height, radial, 1);
  g.translate(0, height / 2, 0);
  return g;
}

/** Cylinder, base at origin, pointing +Y. */
export function cyl(rTop: number, rBottom: number, height: number, radial = 8, hSeg = 1, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, height, radial, hSeg, open);
  g.translate(0, height / 2, 0);
  return g;
}

/** Lathe around +Y from [radius, y] pairs. */
export function lathe(profile: Array<readonly [number, number]>, segments = 16): THREE.BufferGeometry {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y)), segments);
}

export function torus(radius: number, tube: number, radial = 6, tubular = 18, arc = Math.PI * 2): THREE.BufferGeometry {
  return new THREE.TorusGeometry(radius, tube, radial, tubular, arc);
}

/** Even-ish point distribution on a unit sphere. */
export function fibonacciSphere(n: number, jitter = 0, seed = 1): THREE.Vector3[] {
  const r = rng(seed);
  const out: THREE.Vector3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const rad = Math.sqrt(1 - y * y);
    const th = ga * i + (r() - 0.5) * jitter;
    out.push(new THREE.Vector3(Math.cos(th) * rad, y + (r() - 0.5) * jitter * 0.3, Math.sin(th) * rad).normalize());
  }
  return out;
}

/** Flat irregular splat (ground creep, puddles) in the XZ plane, facing +Y. */
export function splat(radiusX: number, radiusZ: number, segments: number, roughness: number, seed: number, rings = 3): THREE.BufferGeometry {
  const nz = noise3(seed, 5, 2.2);
  const verts: number[] = [0, 0, 0];
  const idx: number[] = [];
  for (let k = 1; k <= rings; k++) {
    const f = k / rings;
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const edge = 1 + roughness * nz(c * 1.3, 0.5, s * 1.3) * Math.pow(f, 1.5);
      verts.push(c * radiusX * f * edge, 0, s * radiusZ * f * edge);
    }
  }
  for (let j = 0; j < segments; j++) idx.push(0, 1 + ((j + 1) % segments), 1 + j);
  for (let k = 1; k < rings; k++) {
    const a0 = 1 + (k - 1) * segments, b0 = 1 + k * segments;
    for (let j = 0; j < segments; j++) {
      const j1 = (j + 1) % segments;
      idx.push(a0 + j, a0 + j1, b0 + j, a0 + j1, b0 + j1, b0 + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Clamp vertices below `y` up to `y` (flattens the underside of blobs that sit on the ground). */
export function flattenBelow(geo: THREE.BufferGeometry, y: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < y) pos.setY(i, y + (pos.getY(i) - y) * 0.08);
  geo.computeVertexNormals();
  return geo;
}

/** Simple geometry cache keyed by string; builders run once. */
const geoCache = new Map<string, THREE.BufferGeometry>();
export function cached(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) { g = build(); geoCache.set(key, g); }
  return g;
}
