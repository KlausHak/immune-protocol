/**
 * [models-hospital] Architectural helpers shared by player buildings and campus doodads:
 * ribbon windows, parapets, bands, rooftop HVAC units, spinning fans.
 */
import * as THREE from 'three';
import { Kit, memo, type Face, type Sw, type V3 } from './kit';

export interface Rect { cx: number; cz: number; sx: number; sz: number }

interface FaceFrame { ox: number; oz: number; ux: number; uz: number; nx: number; nz: number; len: number }
function faceFrame(r: Rect, face: Face): FaceFrame {
  switch (face) {
    case '+z': return { ox: r.cx, oz: r.cz + r.sz / 2, ux: 1, uz: 0, nx: 0, nz: 1, len: r.sx };
    case '-z': return { ox: r.cx, oz: r.cz - r.sz / 2, ux: -1, uz: 0, nx: 0, nz: -1, len: r.sx };
    case '+x': return { ox: r.cx + r.sx / 2, oz: r.cz, ux: 0, uz: -1, nx: 1, nz: 0, len: r.sz };
    default: return { ox: r.cx - r.sx / 2, oz: r.cz, ux: 0, uz: 1, nx: -1, nz: 0, len: r.sz };
  }
}

export interface WinOpts {
  /** pane height */ h: number;
  /** target pane width */ pane?: number;
  /** chance of a warm lit pane / cool lit pane (rest = glass) */ lit?: number; cool?: number;
  glass?: Sw; warm?: Sw; coolSw?: Sw;
  /** frame band behind the panes (null = none) */ frame?: Sw | null;
  margin?: number;
  /** fraction range of the facade to fill (0..1, left → right as seen from outside) */ from?: number; to?: number;
  /** gap between panes */ gap?: number;
}

/** One ribbon of window panes along a facade at sill height y. */
export function windows(k: Kit, r: Rect, face: Face, y: number, o: WinOpts, rnd: () => number): void {
  const f = faceFrame(r, face);
  const margin = o.margin ?? 0.12;
  const a = -f.len / 2 + margin + (f.len - 2 * margin) * (o.from ?? 0);
  const b = -f.len / 2 + margin + (f.len - 2 * margin) * (o.to ?? 1);
  const len = b - a;
  if (len <= 0.05) return;
  const n = Math.max(1, Math.round(len / (o.pane ?? 0.45)));
  const pw = len / n, gap = o.gap ?? Math.min(0.07, pw * 0.18);
  const yc = y + o.h / 2;
  const at = (t: number, off: number): V3 => [f.ox + f.ux * t + f.nx * off, yc, f.oz + f.uz * t + f.nz * off];
  if (o.frame !== null) k.quad(o.frame ?? 'frame', len + 0.04, o.h + 0.08, at((a + b) / 2, 0.006), face);
  const lit = o.lit ?? 0.35, cool = o.cool ?? 0.15;
  for (let i = 0; i < n; i++) {
    const r0 = rnd();
    const sw: Sw = r0 < lit ? (o.warm ?? 'winWarm') : r0 < lit + cool ? (o.coolSw ?? 'winCool') : (o.glass ?? 'glass');
    k.quad(sw, pw - gap, o.h, at(a + pw * (i + 0.5), 0.012), face);
  }
}

/** Ribbon windows on several faces and floors. */
export function floors(k: Kit, r: Rect, faces: Face[], ys: number[], o: WinOpts, rnd: () => number): void {
  for (const y of ys) for (const f of faces) windows(k, r, f, y, o, rnd);
}

/** Vertical fins along a facade (Nordic brise-soleil), evenly spaced. */
export function fins(k: Kit, r: Rect, face: Face, y0: number, h: number, step: number, s: Sw | ((i: number) => Sw), depth = 0.1, w = 0.06, margin = 0.1): void {
  const f = faceFrame(r, face);
  const n = Math.max(1, Math.floor((f.len - 2 * margin) / step));
  const start = -((n - 1) * step) / 2;
  for (let i = 0; i < n; i++) {
    const t = start + i * step;
    const sw = typeof s === 'function' ? s(i) : s;
    const size: V3 = f.nx !== 0 ? [depth, h, w] : [w, h, depth];
    k.block(sw, size, [f.ox + f.ux * t + f.nx * depth / 2, y0, f.oz + f.uz * t + f.nz * depth / 2]);
  }
}

/** Parapet ring on a roof edge. */
export function parapet(k: Kit, r: Rect, y: number, h: number, t: number, s: Sw): void {
  k.block(s, [r.sx, h, t], [r.cx, y, r.cz + r.sz / 2 - t / 2]);
  k.block(s, [r.sx, h, t], [r.cx, y, r.cz - r.sz / 2 + t / 2]);
  k.block(s, [t, h, r.sz - 2 * t], [r.cx + r.sx / 2 - t / 2, y, r.cz]);
  k.block(s, [t, h, r.sz - 2 * t], [r.cx - r.sx / 2 + t / 2, y, r.cz]);
}

/** Thin band wrapped around a block (centre height y), protruding `out`. Must not coincide with block top/bottom. */
export function band(k: Kit, r: Rect, y: number, h: number, s: Sw, out = 0.02): void {
  k.box(s, [r.sx + out * 2, h, r.sz + out * 2], [r.cx, y, r.cz]);
}

/** Flat roof surface (gravel) inset on top of a block. */
export function roof(k: Kit, r: Rect, top: number, s: Sw = 'roofGravel', inset = 0.08): void {
  k.box(s, [r.sx - inset * 2, 0.03, r.sz - inset * 2], [r.cx, top + 0.015, r.cz]);
}

/** Rooftop HVAC box with a fan shroud; returns the fan hub position (for an animated fan). */
export function hvac(k: Kit, x: number, y: number, z: number, w: number, d: number, h: number, fanR: number): V3 {
  k.block('panel', [w, h, d], [x, y, z]);
  k.box('graphite', [w + 0.01, h * 0.45, d * 0.7], [x, y + h * 0.4, z]);
  k.block('steelDark', [w * 0.96, 0.03, d * 0.96], [x, y + h, z]);
  k.cyl('steel', fanR + 0.05, fanR + 0.05, 0.08, 18, [x, y + h + 0.06, z], undefined, undefined, true);
  k.cyl('charcoal', fanR, fanR, 0.02, 18, [x, y + h + 0.035, z]);
  return [x, y + h + 0.07, z];
}

/** Shared fan rotor geometry (4 pitched blades + hub), spun around +Y. */
export function fanGeo(r: number): THREE.BufferGeometry {
  return memo(`fan:${r.toFixed(3)}`, () => {
    const k = new Kit();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      k.group([0, 0, 0], [0, a, 0], () => k.box('steelDark', [r * 0.92, 0.012, r * 0.32], [r * 0.5, 0, 0], [0.35, 0, 0]));
    }
    k.cyl('steel', r * 0.16, r * 0.16, 0.04, 10, [0, 0.005, 0]);
    return k.merge();
  });
}

/** Little roof-mounted helper: simple cubic crate with a teal "+" on top and sides. */
export function supplyCrate(k: Kit, x: number, y: number, z: number, s: number, body: Sw = 'ivory', rotY = 0): void {
  k.group([x, y, z], [0, rotY, 0], () => {
    k.block(body, [s, s * 0.8, s], [0, 0, 0]);
    k.block('teal', [s * 1.01, s * 0.1, s * 1.01], [0, s * 0.62, 0]);
    k.plus('teal', s * 0.45, s * 0.14, 0.01, [0, s * 0.805, 0], '+y');
    k.plus('teal', s * 0.4, s * 0.13, 0.01, [0, s * 0.36, s / 2 + 0.006], '+z');
    k.plus('teal', s * 0.4, s * 0.13, 0.01, [s / 2 + 0.006, s * 0.36, 0], '+x');
  });
}
