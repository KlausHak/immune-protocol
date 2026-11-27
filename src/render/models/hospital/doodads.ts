/**
 * [models-hospital] Campus doodads (static props). Each doodad is ONE mesh (merged geometry per kind ×
 * seed-variant bucket, shared fog-patched atlas material) so the environment can instance them by
 * geometry. Sizes match DESIGN §6 nominal footprints at scale 1 (forward = +X = w, depth = Z = h).
 */
import * as THREE from 'three';
import type { DoodadKind } from '../../../core/types';
import type { DoodadBuilder } from '../types';
import { band, fins, floors, hvac, parapet, roof, supplyCrate, windows, type Rect } from './arch';
import { childrensHospitalGeo, pinwheelGeoForDoodad } from './buildings';
import { BRAND_TEAL, Kit, atlasMat, bucket, makeMesh, memo, rng, teamPal, type Sw } from './kit';

type Geo = THREE.BufferGeometry;
type Build = (k: Kit, v: number, rnd: () => number) => void;

function hashStr(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

/** Wrap a kit-builder into a DoodadBuilder with `variants` cached seed buckets. */
function doodad(kind: DoodadKind, variants: number, build: Build, shadow = true): DoodadBuilder {
  return ({ seed, scale }) => {
    const v = bucket(seed, variants);
    const geo: Geo = memo(`dd:${kind}:${v}`, () => { const k = new Kit(teamPal(BRAND_TEAL)); build(k, v, rng(hashStr(kind) + v * 7919)); return k.merge(); });
    const g = new THREE.Group(); g.name = `doodad:${kind}`;
    const m = makeMesh(geo, atlasMat('struct'), kind);
    m.castShadow = shadow; m.receiveShadow = true;
    g.add(m);
    g.scale.setScalar(scale > 0 && Number.isFinite(scale) ? scale : 1);
    return g;
  };
}

const wheels = (k: Kit, xs: number[], z: number, r: number, w: number, y = r): void => {
  for (const x of xs) for (const s of [-1, 1]) {
    k.cyl('rubber', r, r, w, 12, [x, y, z * s], [Math.PI / 2, 0, 0]);
    k.cyl('steel', r * 0.5, r * 0.5, w + 0.01, 8, [x, y, z * s], [Math.PI / 2, 0, 0]);
  }
};

// ───────────────────────────── architecture ─────────────────────────────

const hospitalTower: Build = (k, _v, rnd) => {
  k.block('concrete', [14, 0.15, 10], [0, 0, 0]);
  const pod: Rect = { cx: 0, cz: 0, sx: 13.6, sz: 9.6 };
  k.block('ivory', [pod.sx, 3.0, pod.sz], [0, 0.15, 0]);
  windows(k, pod, '+z', 0.4, { h: 1.1, pane: 0.8, lit: 0.55, cool: 0.2, glass: 'winCyan' }, rnd);
  floors(k, pod, ['-z', '+x', '-x'], [0.6], { h: 0.8, pane: 0.8, lit: 0.4 }, rnd);
  floors(k, pod, ['+z', '-z', '+x', '-x'], [2.0], { h: 0.7, pane: 0.8, lit: 0.4 }, rnd);
  band(k, pod, 1.75, 0.12, 'teal', 0.03);
  roof(k, pod, 3.15, 'roofDark');
  const T: Rect = { cx: -1.2, cz: -0.8, sx: 9.5, sz: 6.4 };
  k.block('ivory', [T.sx, 10.7, T.sz], [T.cx, 3.15, T.cz]);
  for (let f = 0; f < 10; f++) {
    const y = 3.4 + f * 1.05;
    floors(k, T, ['-z', '+x', '-x'], [y], { h: 0.62, pane: 0.7, lit: 0.38, cool: 0.18 }, rnd);
    windows(k, T, '+z', y, { h: 0.62, pane: 0.7, lit: 0.38, cool: 0.18, to: f >= 7 ? 0.7 : 1 }, rnd);
  }
  fins(k, T, '+z', 3.15, 10.6, 1.4, 'white', 0.14, 0.08, 0.3);
  fins(k, T, '-z', 3.15, 10.6, 1.4, 'white', 0.14, 0.08, 0.3);
  band(k, T, 13.55, 0.3, 'teal', 0.04);
  parapet(k, T, 13.85, 0.2, 0.15, 'offwhite');
  roof(k, T, 13.85);
  // hospital "+" lightboxes near the top
  k.box('white', [2.0, 2.0, 0.12], [2.35, 11.6, T.cz + T.sz / 2 + 0.2]);
  k.plus('tealGlow', 1.6, 0.52, 0.08, [2.35, 11.6, T.cz + T.sz / 2 + 0.3], '+z');
  k.box('white', [0.12, 2.0, 2.0], [T.cx + T.sx / 2 + 0.2, 11.6, T.cz]);
  k.plus('tealGlow', 1.6, 0.52, 0.08, [T.cx + T.sx / 2 + 0.3, 11.6, T.cz], '+x');
  // rooftop plant
  k.block('panel', [3.6, 1.3, 2.6], [-3.0, 13.85, -1.2]);
  k.box('graphite', [3.62, 0.5, 1.6], [-3.0, 14.6, -1.2]);
  for (const x of [0.4, 2.0]) hvac(k, x, 13.85, -2.4, 1.0, 1.2, 0.6, 0.38);
  for (const [x, z] of [[T.cx - T.sx / 2 + 0.2, T.cz - T.sz / 2 + 0.2], [T.cx + T.sx / 2 - 0.2, T.cz + T.sz / 2 - 0.2], [T.cx - T.sx / 2 + 0.2, T.cz + T.sz / 2 - 0.2], [T.cx + T.sx / 2 - 0.2, T.cz - T.sz / 2 + 0.2]] as const) {
    k.post('redGlow', 0.08, 0.15, [x, 14.05, z], 6);
  }
  // entrance canopy on the podium front
  k.box('white', [4.5, 0.16, 1.4], [3.2, 1.4, 5.0 - 0.7]);
  k.box('teal', [4.52, 0.16, 0.06], [3.2, 1.4, 4.97]);
};

const hospitalWing: Build = (k, v, rnd) => {
  const accent: Sw = (['teal', 'copper', 'grey'] as const)[v % 3]!;
  const body: Sw = v === 2 ? 'offwhite' : 'ivory';
  k.block('concrete', [12, 0.12, 6], [0, 0, 0]);
  const b: Rect = { cx: -0.4, cz: 0, sx: 10.8, sz: 5.6 };
  k.block(body, [b.sx, 5.5, b.sz], [b.cx, 0.12, 0]);
  floors(k, b, ['+z', '-z', '-x'], [0.4, 1.45, 2.5, 3.55, 4.6], { h: 0.6, pane: 0.75, lit: 0.38, cool: 0.16 }, rnd);
  band(k, b, 5.35, 0.22, accent, 0.03);
  parapet(k, b, 5.62, 0.16, 0.12, 'offwhite');
  roof(k, b, 5.62);
  hvac(k, -3.5, 5.62, -1.2, 1.2, 1.0, 0.55, 0.32);
  hvac(k, -1.6, 5.62, -1.2, 1.2, 1.0, 0.55, 0.32);
  k.block('panel', [1.6, 0.8, 1.8], [2.6, 5.62, 0.6]);
  // glazed stair core at the +X end
  const s: Rect = { cx: 5.3, cz: 0.6, sx: 1.4, sz: 2.4 };
  k.block('glass', [s.sx, 6.0, s.sz], [s.cx, 0.12, s.cz]);
  for (let i = 0; i < 6; i++) k.box('steel', [1.44, 0.06, 2.44], [s.cx, 1.1 + i * 1.0, s.cz]);
  k.block('white', [1.5, 0.12, 2.5], [s.cx, 6.1, s.cz]);
};

const childrensHospitalDoodad: Build = (k) => {
  const g = memo('ddsrc:children', () => childrensHospitalGeo(teamPal(BRAND_TEAL)));
  k.addPainted(g.geo);
  k.post('steel', 0.025, 0.42, [g.pinwheel[0], 3.13, g.pinwheel[2]], 6);
  k.addPainted(pinwheelGeoForDoodad(), g.pinwheel, [0.4, 0, 0]);
};

const researchLab: Build = (k, _v, rnd) => {
  k.block('concrete', [10, 0.12, 8], [0, 0, 0]);
  const n: Rect = { cx: 0, cz: -2.45, sx: 9.6, sz: 3.0 };
  const s: Rect = { cx: 0, cz: 2.45, sx: 9.6, sz: 3.0 };
  k.block('offwhite', [n.sx, 6.6, n.sz], [0, 0.12, n.cz]);
  k.block('offwhite', [s.sx, 5.4, s.sz], [0, 0.12, s.cz]);
  floors(k, n, ['-z', '+x', '-x'], [0.5, 1.75, 3.0, 4.25, 5.5], { h: 0.75, pane: 0.5, lit: 0.3, cool: 0.35, coolSw: 'winCyan' }, rnd);
  floors(k, s, ['+z', '+x', '-x'], [0.5, 1.75, 3.0, 4.25], { h: 0.75, pane: 0.5, lit: 0.3, cool: 0.35, coolSw: 'winCyan' }, rnd);
  fins(k, s, '+z', 0.12, 5.3, 0.6, 'copper', 0.25, 0.1);
  fins(k, n, '-z', 0.12, 6.5, 0.6, 'copper', 0.25, 0.1);
  band(k, n, 6.45, 0.2, 'teal'); band(k, s, 5.25, 0.2, 'teal');
  roof(k, n, 6.72); roof(k, s, 5.52);
  parapet(k, n, 6.72, 0.15, 0.1, 'offwhite'); parapet(k, s, 5.52, 0.15, 0.1, 'offwhite');
  // glass atrium between the blocks
  k.block('glass', [9.2, 6.0, 1.9], [0, 0.12, 0]);
  for (let i = 0; i <= 12; i++) k.box('steel', [0.06, 0.1, 1.92], [-4.6 + i * (9.2 / 12), 6.15, 0]);
  for (const x of [-4.62, 4.62]) for (let i = 0; i <= 3; i++) k.block('steel', [0.05, 6.0, 0.05], [x, 0.12, -0.95 + i * 0.633]);
  for (const y of [2.1, 4.1]) for (const x of [-4.62, 4.62]) k.box('steel', [0.05, 0.06, 1.92], [x, y, 0]);
  k.quad('winWarm', 1.4, 1.6, [4.63, 0.95, 0], '+x');
  // rooftop: fume stacks + plant
  for (let i = 0; i < 6; i++) { k.post('steel', 0.12, 1.6, [-3.5 + i * 1.1, 6.72, -3.3], 8); k.cyl('steelDark', 0.16, 0.16, 0.08, 8, [-3.5 + i * 1.1, 8.36, -3.3]); }
  hvac(k, 2.5, 6.72, -2.2, 1.6, 1.0, 0.6, 0.35);
  hvac(k, -2.0, 5.52, 2.4, 1.4, 1.0, 0.55, 0.32);
  k.post('white', 0.7, 1.2, [2.6, 5.52, 2.4], 16);
  k.dome('white', 0.7, [2.6, 6.72, 2.4], [1, 0.4, 1], 16, 4);
};

const parkingGarage: Build = (k, v, rnd) => {
  const CARS: Sw[] = ['carRed', 'carBlue', 'carSilver', 'carBlack', 'carWhite', 'carGreen', 'carYellow'];
  const decks = [0.0, 1.3, 2.6, 3.7];
  k.block('concrete', [12, 0.1, 10], [0, 0, 0]);
  for (let d = 1; d < decks.length; d++) {
    const y = decks[d]!;
    k.block('concrete', [11.8, 0.22, 9.8], [0, y - 0.22, 0]);
    // parapets with a steel rail
    parapet(k, { cx: 0, cz: 0, sx: 11.8, sz: 9.8 }, y, 0.5, 0.15, 'concreteLight');
    if (d === decks.length - 1) k.box('asphalt', [11.4, 0.02, 9.4], [0, y + 0.01, 0]);
  }
  for (let ix = 0; ix <= 4; ix++) for (let iz = 0; iz <= 3; iz++) k.block('concreteDark', [0.3, 3.5, 0.3], [-5.6 + ix * 2.8, 0.1, -4.6 + iz * 3.07]);
  // ramp along the -Z side
  k.beam('concreteDark', [-5.0, 0.15, -3.9], [0.5, 1.15, -3.9], 1.6, 0.18);
  // parked cars on decks and roof
  const car = (x: number, y: number, z: number, sw: Sw, rot: number) => k.group([x, y, z], [0, rot, 0], () => {
    k.block(sw, [0.8, 0.28, 1.65], [0, 0.08, 0]);
    k.block('glassDark', [0.7, 0.22, 0.9], [0, 0.36, -0.05]);
    k.block(sw, [0.72, 0.04, 0.85], [0, 0.58, -0.05]);
  });
  for (let d = 0; d < decks.length; d++) for (let i = 0; i < 9; i++) {
    if (rnd() < (d === decks.length - 1 ? 0.45 : 0.6)) car(-4.6 + i * 1.15, decks[d]! + 0.12, d % 2 ? 3.4 : 3.5, CARS[Math.floor(rnd() * CARS.length)]!, rnd() * 0.1);
    if (d === decks.length - 1 && rnd() < 0.45) car(-4.6 + i * 1.15, decks[d]! + 0.02, -1.0, CARS[Math.floor(rnd() * CARS.length)]!, Math.PI + rnd() * 0.1);
  }
  // roof parking lines + lamps
  for (let i = 0; i <= 9; i++) for (const z of [2.6, -1.8]) k.box('white', [0.05, 0.012, 1.6], [-5.15 + i * 1.15, decks[3]! + 0.03, z + (z > 0 ? 0.8 : 0.8)]);
  for (const x of [-4, 0, 4]) { k.post('steelDark', 0.05, 1.8, [x, decks[3]!, 0.9], 6); k.box('lamp', [0.4, 0.08, 0.18], [x, decks[3]! + 1.8, 0.9]); }
  // stair tower with the blue "P"
  k.block('concrete', [1.8, 5.0, 1.8], [5.0, 0.1, 4.0]);
  k.block('glass', [0.1, 4.4, 1.2], [5.92, 0.3, 4.0]);
  k.box('signBlue', [1.2, 1.2, 0.08], [5.0, 4.2, 4.93]);
  k.text('white', 'P', 0.18, 0.04, [5.05, 4.2, 4.99], '+z');
  if (v === 1) k.box('signBlue', [0.08, 1.2, 1.2], [5.93, 4.2, 4.0]);
};

const oldLaundry: Build = (k, v, rnd) => {
  k.block('concreteDark', [10, 0.12, 8], [0, 0, 0]);
  const h: Rect = { cx: -0.7, cz: 0, sx: 8.2, sz: 7.4 };
  k.block('brick', [h.sx, 4.4, h.sz], [h.cx, 0.12, 0]);
  band(k, h, 0.3, 0.36, 'brickDark', 0.03);
  band(k, h, 4.3, 0.2, 'brickLight', 0.04);
  // tall arched windows with lintels
  for (const face of ['+z', '-z'] as const) {
    const z = face === '+z' ? h.sz / 2 : -h.sz / 2;
    for (let i = 0; i < 6; i++) {
      const x = h.cx - 3.4 + i * 1.36;
      const lit = rnd() < 0.35;
      k.quad(lit ? 'winWarm' : 'glassDark', 0.8, 2.2, [x, 2.0, z + (face === '+z' ? 0.01 : -0.01)], face);
      k.add(new THREE.CircleGeometry(0.4, 10, 0, Math.PI), lit ? 'winWarm' : 'glassDark', [x, 3.1, z + (face === '+z' ? 0.01 : -0.01)], [0, face === '+z' ? 0 : Math.PI, 0]);
      k.box('brickLight', [0.95, 0.12, 0.08], [x, 0.85, z]);
    }
  }
  windows(k, h, '-x', 1.0, { h: 1.6, pane: 0.9, lit: 0.3, glass: 'glassDark', frame: 'brickDark' }, rnd);
  // saw-tooth roof (gables along X) in dark sheet metal with glazed strips
  for (let i = 0; i < 3; i++) {
    const z = -2.47 + i * 2.47;
    k.prism('roofDark', h.sx, 2.47, 1.1, [h.cx, 4.52, z]);
    k.box('glassDark', [h.sx - 0.4, 0.04, 0.4], [h.cx, 5.08, z + 0.2], [0.75, 0, 0]);
  }
  // boiler house + chimney
  k.block('brickDark', [1.6, 3.2, 3.0], [4.2, 0.12, 1.6]);
  k.box('roofDark', [1.7, 0.12, 3.1], [4.2, 3.36, 1.6]);
  k.post('brick', 0.6, 9.6, [4.2, 0.12, -2.6], 12, 0.38);
  for (const y of [3.2, 6.4, 9.3]) k.post('brickDark', 0.6 - (y / 9.6) * 0.22 + 0.03, 0.25, [4.2, y, -2.6], 12);
  k.post('charcoal', 0.4, 0.15, [4.2, 9.72, -2.6], 12);
  k.post('redGlow', 0.06, 0.1, [4.2, 9.87, -2.6], 6);
  if (v === 1) { k.block('woodDark', [1.2, 1.0, 1.2], [-5.2 + 0.6, 0.12, 3.0]); k.block('steelDark', [0.9, 1.6, 0.9], [-4.6, 0.12, -3.2]); }
  k.quad('darkGrey', 1.8, 2.2, [-4.805, 1.23, 1.0], '-x');
};

const waterTower: Build = (k) => {
  k.block('concrete', [3, 0.15, 3], [0, 0, 0]);
  k.post('concreteLight', 0.55, 6.0, [0, 0.15, 0], 16, 0.5);
  k.cyl('concreteLight', 1.45, 0.5, 1.4, 20, [0, 6.85, 0]);
  k.post('white', 1.45, 2.3, [0, 7.55, 0], 24);
  k.post('teal', 1.47, 0.25, [0, 8.9, 0], 24);
  k.cyl('offwhite', 0.25, 1.5, 0.45, 24, [0, 10.07, 0]);
  k.torus('steel', 1.48, 0.03, [0, 9.95, 0], [Math.PI / 2, 0, 0]);
  k.post('steel', 0.03, 0.6, [0.1, 10.3, 0], 5);
  k.post('redGlow', 0.06, 0.1, [0.1, 10.9, 0], 6);
  k.quad('darkGrey', 0.6, 1.4, [0, 0.85, 0.545], '+z');
};

const skybridge: Build = (k) => {
  k.box('concrete', [8, 0.32, 1.8], [0, 2.45, 0]);
  k.box('winCyan', [7.9, 1.25, 1.62], [0, 3.22, 0]);
  for (let i = 0; i <= 10; i++) k.box('steel', [0.06, 1.28, 1.66], [-3.95 + i * 0.79, 3.22, 0]);
  k.box('steel', [8, 0.06, 1.66], [0, 2.63, 0]);
  k.box('white', [8.1, 0.18, 1.95], [0, 3.94, 0]);
  k.box('teal', [8.12, 0.08, 1.97], [0, 3.88, 0]);
  for (const x of [-3.7, 3.7]) k.post('steel', 0.14, 2.3, [x, 0, 0], 10);
  for (const x of [-2, 0, 2]) k.box('lamp', [0.3, 0.03, 0.3], [x, 2.28, 0]);
};

// ───────────────────────────── vehicles & street props ─────────────────────────────

const ambulance: Build = (k, v) => {
  const lower: Sw = v === 0 ? 'ambYellow' : 'teal';
  k.block('graphite', [1.85, 0.12, 0.8], [0, 0.16, 0]);
  k.block('white', [1.25, 0.82, 0.9], [-0.28, 0.24, 0]);
  k.block(lower, [1.27, 0.28, 0.92], [-0.28, 0.26, 0]);
  k.block('white', [0.6, 0.48, 0.86], [0.62, 0.24, 0]);
  k.block(lower, [0.62, 0.28, 0.88], [0.62, 0.26, 0]);
  k.frustum('white', 0.4, 0.84, 0.28, 0.82, 0.24, [0.6, 0.72, 0]);
  k.quad('glassDark', 0.8, 0.2, [0.745, 0.84, 0], '+x');
  for (const s of [-1, 1]) {
    k.quad('glassDark', 0.3, 0.18, [0.6, 0.85, 0.43 * s], s > 0 ? '+z' : '-z');
    k.box('teal', [0.34, 0.34, 0.01], [-0.3, 0.72, 0.455 * s]);
    k.plus('white', 0.24, 0.08, 0.01, [-0.3, 0.72, 0.462 * s], s > 0 ? '+z' : '-z');
  }
  k.box('teal', [0.36, 0.01, 0.5], [-0.3, 1.065, 0]);
  k.plus('white', 0.3, 0.1, 0.01, [-0.3, 1.075, 0], '+y');
  k.box('blueGlow', [0.12, 0.08, 0.7], [0.55, 1.0, 0]);
  k.box('blueGlow', [0.06, 0.08, 0.7], [-0.88, 1.02, 0]);
  for (const z of [-0.3, 0.3]) { k.box('headlight', [0.02, 0.07, 0.14], [0.925, 0.42, z]); k.box('tailLight', [0.02, 0.1, 0.08], [-0.915, 0.42, z]); }
  wheels(k, [0.55, -0.55], 0.4, 0.16, 0.12);
};

const CAR_COLS: Sw[] = ['carRed', 'carBlue', 'carSilver', 'carBlack', 'carWhite', 'carGreen', 'carYellow'];
const car: Build = (k, v) => {
  const c = CAR_COLS[v % CAR_COLS.length]!;
  k.block(c, [1.8, 0.32, 0.8], [0, 0.16, 0]);
  k.frustum(c, 1.05, 0.76, 0.72, 0.66, 0.3, [-0.1, 0.48, 0]);
  k.quad('glassDark', 0.6, 0.2, [0.32, 0.62, 0], '+x');
  k.quad('glassDark', 0.6, 0.18, [-0.6, 0.62, 0], '-x');
  for (const s of [-1, 1]) k.quad('glassDark', 0.8, 0.17, [-0.1, 0.63, 0.365 * s], s > 0 ? '+z' : '-z');
  for (const z of [-0.27, 0.27]) { k.box('headlight', [0.02, 0.06, 0.14], [0.905, 0.38, z]); k.box('tailLight', [0.02, 0.06, 0.12], [-0.905, 0.38, z]); }
  k.box('charcoal', [1.84, 0.08, 0.82], [0, 0.2, 0]);
  wheels(k, [0.58, -0.58], 0.37, 0.15, 0.1);
};

const bus: Build = (k, v) => {
  const main: Sw = v === 0 ? 'busBlue' : 'pharmGreen';
  k.block(main, [3.9, 0.55, 0.92], [0, 0.2, 0]);
  k.block('white', [3.9, 0.55, 0.92], [0, 0.75, 0]);
  k.block('white', [3.85, 0.06, 0.88], [0, 1.3, 0]);
  for (const s of [-1, 1]) k.quad('glassDark', 3.2, 0.42, [-0.25, 1.02, 0.462 * s], s > 0 ? '+z' : '-z');
  k.quad('glassDark', 0.84, 0.6, [1.952, 0.95, 0], '+x');
  k.box('amberGlow', [0.02, 0.12, 0.6], [1.955, 1.22, 0]);
  k.block('panel', [1.2, 0.18, 0.7], [-0.6, 1.36, 0]);
  for (const z of [-0.32, 0.32]) { k.box('headlight', [0.02, 0.08, 0.14], [1.955, 0.4, z]); k.box('tailLight', [0.02, 0.12, 0.1], [-1.955, 0.45, z]); }
  wheels(k, [1.3, -1.1], 0.42, 0.2, 0.12);
};

const helipad: Build = (k) => {
  k.box('concrete', [3.9, 0.04, 3.9], [0, 0.02, 0]);
  k.disc('charcoal', 1.85, [0, 0.042, 0], 32);
  k.ring('white', 1.5, 1.65, [0, 0.046, 0], 40);
  k.text('white', 'H', 0.2, 0.01, [0, 0.05, 0], '+y');
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; k.box(i % 3 ? 'whiteGlow' : 'greenGlow', [0.08, 0.03, 0.08], [Math.cos(a) * 1.8, 0.055, Math.sin(a) * 1.8]); }
};

const streetLamp: Build = (k, v) => {
  k.post('graphite', 0.09, 0.3, [0, 0, 0], 8);
  k.post('steelDark', 0.045, 3.2, [0, 0.3, 0], 8, 0.035);
  const arms = v === 1 ? [1, -1] : [1];
  for (const s of arms) {
    k.beam('steelDark', [0, 3.35, 0], [0.55 * s, 3.45, 0], 0.05, 0.05);
    k.box('graphite', [0.4, 0.09, 0.2], [0.65 * s, 3.45, 0]);
    k.box('lamp', [0.32, 0.03, 0.14], [0.65 * s, 3.395, 0]);
  }
};

const bench: Build = (k) => {
  for (const x of [-0.35, 0.35]) { k.block('steelDark', [0.06, 0.4, 0.4], [x, 0, 0]); k.beam('steelDark', [x, 0.4, -0.15], [x, 0.8, -0.24], 0.06, 0.05); }
  for (let i = 0; i < 3; i++) k.box('wood', [0.9, 0.04, 0.11], [0, 0.42, -0.12 + i * 0.13]);
  for (let i = 0; i < 2; i++) k.box('wood', [0.9, 0.1, 0.03], [0, 0.6 + i * 0.14, -0.2 - i * 0.025], [-0.22, 0, 0]);
};

const busStop: Build = (k) => {
  for (const x of [-0.9, 0.9]) k.block('steel', [0.06, 1.35, 0.06], [x, 0, -0.3]);
  k.block('glassBlue', [1.8, 1.1, 0.04], [0, 0.15, -0.35]);
  k.box('white', [1.95, 0.07, 0.85], [0, 1.4, 0]);
  k.box('teal', [1.97, 0.06, 0.04], [0, 1.4, 0.42]);
  k.block('winCool', [0.04, 1.0, 0.6], [0.92, 0.25, 0]);
  for (let i = 0; i < 3; i++) k.box('wood', [1.2, 0.04, 0.1], [-0.2, 0.45, -0.2 + i * 0.11]);
  k.block('steelDark', [0.05, 0.42, 0.3], [-0.75, 0, -0.1]);
  k.block('steelDark', [0.05, 0.42, 0.3], [0.35, 0, -0.1]);
};

const trafficCone: Build = (k) => {
  k.box('coneOrange', [0.3, 0.03, 0.3], [0, 0.015, 0]);
  k.cone('coneOrange', 0.12, 0.34, 10, [0, 0.2, 0]);
  k.cyl('white', 0.085, 0.1, 0.06, 10, [0, 0.16, 0]);
};

const barrier: Build = (k, v) => {
  if (v === 0) {
    k.frustum('concreteLight', 1.9, 0.55, 1.9, 0.22, 0.65, [0, 0, 0]);
    k.box('hazYellow', [1.8, 0.06, 0.02], [0, 0.5, 0.15], [0.18, 0, 0]);
    k.box('hazYellow', [1.8, 0.06, 0.02], [0, 0.5, -0.15], [-0.18, 0, 0]);
  } else {
    for (const x of [-0.85, 0.85]) { k.block('steelDark', [0.06, 0.9, 0.06], [x, 0, 0]); k.block('steelDark', [0.06, 0.04, 0.5], [x, 0, 0]); }
    for (const y of [0.5, 0.8]) for (let i = 0; i < 6; i++) k.box(i % 2 ? 'white' : 'signRed', [0.29, 0.14, 0.03], [-0.73 + i * 0.29, y, 0]);
    k.post('amberGlow', 0.05, 0.08, [0.85, 0.9, 0], 6);
  }
};

const fence: Build = (k) => {
  for (const x of [-0.97, 0, 0.97]) k.post('steelDark', 0.03, 1.25, [x, 0, 0], 6);
  for (const y of [0.1, 1.18]) k.rod('steel', [-0.97, y, 0], [0.97, y, 0], 0.018, 5);
  for (let i = 0; i < 24; i++) k.block('steel', [0.012, 1.06, 0.012], [-0.92 + i * 0.08, 0.11, 0]);
};

const signEr: Build = (k) => {
  k.block('concrete', [0.5, 0.15, 0.9], [0, 0, 0]);
  k.block('white', [0.22, 1.5, 0.8], [0, 0.15, 0]);
  k.block('signRed', [0.26, 0.55, 0.84], [0, 1.65, 0]);
  for (const f of ['+z', '-z'] as const) k.text('whiteGlow', 'ER', 0.075, 0.02, [0, 1.92, f === '+z' ? 0.43 : -0.43], f);
  k.text('whiteGlow', 'ER', 0.075, 0.02, [0.14, 1.92, 0], '+x');
  k.text('whiteGlow', 'ER', 0.075, 0.02, [-0.14, 1.92, 0], '-x');
  k.box('teal', [0.24, 0.5, 0.5], [0, 1.05, 0]);
  k.plus('white', 0.36, 0.12, 0.02, [0.13, 1.05, 0], '+x');
  k.plus('white', 0.36, 0.12, 0.02, [-0.13, 1.05, 0], '-x');
};

const DUMP: Sw[] = ['pharmGreen', 'binBlue', 'grey'];
const dumpster: Build = (k, v) => {
  const c = DUMP[v % DUMP.length]!;
  k.frustum(c, 1.55, 0.75, 1.75, 0.88, 0.92, [0, 0.12, 0]);
  k.box('steelDark', [1.8, 0.06, 0.92], [0, 1.0, 0]);
  k.box(c, [0.86, 0.05, 0.9], [-0.44, 1.06, 0]);
  k.box(c, [0.86, 0.05, 0.9], [0.44, 1.12, -0.05], [-0.2, 0, 0]);
  for (const x of [-0.6, 0.6]) for (const z of [-0.3, 0.3]) k.cyl('rubber', 0.06, 0.06, 0.05, 8, [x, 0.06, z], [Math.PI / 2, 0, 0]);
  k.rod('steel', [-0.88, 0.75, -0.3], [-0.88, 0.75, 0.3], 0.02, 5);
};

/** Flag as wavy vertical strips coloured by pattern(u, v) (u = 0 hoist → 1 fly, v = 0 bottom → 1 top). */
function flag(k: Kit, x0: number, y0: number, w: number, h: number, cols: number, rows: number, pattern: (u: number, v: number) => Sw): void {
  const sw = w / cols;
  let x = x0, ang = 0;
  for (let c = 0; c < cols; c++) {
    const next = 0.16 * Math.sin((c + 1) * 0.9);
    const a = (ang + next) / 2; ang = next;
    const cx = x + (Math.cos(a) * sw) / 2;
    const cz = (Math.sin(a) * sw) / 2 + Math.sin(c * 0.9) * 0.03;
    k.group([cx, y0, cz], [0, -a, 0], () => {
      let r = 0;
      while (r < rows) {
        const s = pattern((c + 0.5) / cols, (r + 0.5) / rows);
        let e = r + 1; while (e < rows && pattern((c + 0.5) / cols, (e + 0.5) / rows) === s) e++;
        k.box(s, [sw * 1.02, ((e - r) * h) / rows, 0.02], [0, ((r + e) / 2) * (h / rows), 0]);
        r = e;
      }
    });
    x += Math.cos(a) * sw;
  }
}

const flagPole: Build = (k, v) => {
  k.block('concrete', [0.5, 0.15, 0.5], [0, 0, 0]);
  k.post('white', 0.045, 5.85, [0, 0.15, 0], 8, 0.03);
  k.sphere('chrome', 0.06, [0, 6.03, 0], 1, 8, 5);
  if (v === 0) {
    // Finnish flag (white, blue Nordic cross 18:11)
    flag(k, 0.04, 4.9, 1.1, 0.67, 18, 11, (u, vv) => ((u > 5 / 18 && u < 8 / 18) || (vv > 4 / 11 && vv < 7 / 11) ? 'finBlue' : 'white'));
  } else {
    // hospital flag: white "+" on teal
    flag(k, 0.04, 4.9, 1.1, 0.67, 18, 11, (u, vv) => {
      const cu = Math.abs(u - 0.5) * 18, cv = Math.abs(vv - 0.5) * 11;
      return (cu < 1.2 && cv < 3.5) || (cv < 1.2 && cu < 3.5) ? 'white' : 'teal';
    });
  }
};

// ───────────────────────────── nature ─────────────────────────────

const treeBirch: Build = (k, v, rnd) => {
  const lean = (rnd() - 0.5) * 0.12;
  const H = 3.4 + rnd() * 0.5;
  k.group([0, 0, 0], [lean, 0, lean * 0.7], () => {
    k.post('birchMark', 0.11, 0.3, [0, 0, 0], 8, 0.095);
    k.post('birch', 0.095, H, [0, 0.3, 0], 8, 0.045);
    for (let i = 0; i < 12; i++) {
      const y = 0.5 + rnd() * (H - 0.6), a = rnd() * Math.PI * 2, r = 0.095 - (y / H) * 0.05;
      k.box('birchMark', [0.03, 0.03 + rnd() * 0.04, 0.07 + rnd() * 0.05], [Math.cos(a) * r, y, Math.sin(a) * r], [0, -a, 0]);
    }
    const nb = v === 2 ? 9 : 6;
    for (let i = 0; i < nb; i++) {
      const y = H * (0.45 + rnd() * 0.5), a = rnd() * Math.PI * 2, L = 0.5 + rnd() * 0.6;
      k.rod('birch', [0, y, 0], [Math.cos(a) * L, y + L * 0.9, Math.sin(a) * L], 0.025, 4, 0.01);
    }
    if (v === 2) return; // bare
    const leaves: Sw[] = v === 0 ? ['leafGold', 'leafGold', 'leafAmber'] : v === 1 ? ['leafAmber', 'leafGold', 'leafAmber'] : ['leafLime', 'leafGold', 'leafGreen'];
    const blobs = v === 3 ? 4 : 7;
    for (let i = 0; i < blobs; i++) {
      const a = rnd() * Math.PI * 2, r = 0.25 + rnd() * 0.35, y = H * 0.62 + rnd() * H * 0.45;
      k.ico(leaves[i % leaves.length]!, 0.42 + rnd() * 0.3, [Math.cos(a) * r, y, Math.sin(a) * r], 1, [1, 1.25, 1]);
    }
  });
};

const treePine: Build = (k, v, rnd) => {
  const tall = v === 2 ? 1.15 : 1;
  k.post('trunk', 0.13, 1.3, [0, 0, 0], 7, 0.1);
  const tiers = 5;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = (1.0 - t * 0.7) * (v === 2 ? 0.8 : 1);
    const y = (0.9 + i * 1.0) * tall;
    k.cone(i % 2 ? 'pineDark' : 'pine', r, 1.6 * tall, 8, [0, y + 0.8 * tall, 0], [0, rnd() * 1.5, 0]);
    if (v === 1) k.cone('snow', r * 0.55, 0.5, 8, [0, y + 1.38 * tall, 0], [0, rnd(), 0]);
  }
};

const bush: Build = (k, v, rnd) => {
  const cols: Sw[] = v === 2 ? ['bushAutumn', 'leafAmber'] : v === 1 ? ['bushDark', 'bush'] : ['bush', 'leafGreen'];
  const n = 4 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, r = rnd() * 0.3, s = 0.22 + rnd() * 0.18;
    k.ico(cols[i % 2]!, s, [Math.cos(a) * r, s * 0.8, Math.sin(a) * r], 0, [1, 0.85, 1]);
  }
};

function rockGeo(r: number, detail: number, rnd: () => number): Geo {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  const seed = rnd() * 1000;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = Math.sin(x * 3.1 + seed) * Math.cos(z * 2.7 - seed) + Math.sin(y * 4.3 + seed * 0.5) * 0.5;
    const f = 1 + n * 0.16;
    p.setXYZ(i, x * f, Math.max(y * f, -r * 0.2), z * f);
  }
  return g;
}

const rockGranite: Build = (k, v, rnd) => {
  const main: Sw = v % 2 ? 'granitePink' : 'granite';
  k.add(rockGeo(0.95, 1, rnd), main, [0, 0.3, 0], [0, rnd() * 3, 0], [1, 0.62, 0.85], true);
  k.add(rockGeo(0.45, 1, rnd), 'graniteDark', [0.6, 0.12, 0.45], [0, rnd() * 3, 0], [1, 0.7, 1], true);
  k.add(rockGeo(0.3, 0, rnd), main, [-0.65, 0.08, -0.4], undefined, [1, 0.7, 1], true);
  k.add(rockGeo(0.35, 0, rnd), 'lichen', [-0.1, 0.78, 0.1], undefined, [1.2, 0.15, 1], true);
  if (v >= 2) k.add(rockGeo(0.62, 1, rnd), 'snow', [0.05, 0.82, 0], undefined, [1.1, 0.2, 0.95], true);
};

const snowPile: Build = (k, v, rnd) => {
  const n = 2 + v;
  for (let i = 0; i < n; i++) k.add(rockGeo(0.45 + rnd() * 0.25, 1, rnd), 'snow', [(rnd() - 0.5) * 0.7, 0, (rnd() - 0.5) * 0.7], undefined, [1, 0.45, 1], true);
};

const reeds: Build = (k, v, rnd) => {
  const n = 22 + v * 4;
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.45;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, h = 0.7 + rnd() * 0.6;
    const tx = x + (rnd() - 0.5) * 0.3, tz = z + (rnd() - 0.5) * 0.3;
    k.rod(rnd() < 0.5 ? 'reed' : 'reedDark', [x, 0, z], [tx, h, tz], 0.018, 3, 0.004);
    if (rnd() < 0.15) k.cyl('cattail', 0.03, 0.03, 0.14, 5, [x + (tx - x) * 0.85, h * 0.85, z + (tz - z) * 0.85]);
  }
};

const pier: Build = (k, v) => {
  for (let i = 0; i < 24; i++) k.box(i % 3 === 1 ? 'woodLight' : 'wood', [1.9, 0.06, 0.22], [0, 0.32, -2.88 + i * 0.25]);
  for (const x of [-0.75, 0.75]) k.box('woodDark', [0.12, 0.14, 6], [x, 0.22, 0]);
  for (let i = 0; i < 5; i++) for (const x of [-0.9, 0.9]) k.post('woodDark', 0.08, 1.6, [x, -1.25, -2.8 + i * 1.4], 6);
  for (const z of [-1.5, 1.5]) k.post('graphite', 0.08, 0.2, [0.82, 0.35, z], 8);
  if (v === 1) {
    for (let i = 0; i < 5; i++) k.block('woodDark', [0.06, 0.7, 0.06], [-0.9, 0.35, -2.8 + i * 1.4]);
    k.box('wood', [0.06, 0.06, 5.7], [-0.9, 1.05, 0]);
  }
  k.post('steelDark', 0.04, 2.4, [0.82, 0.35, 2.85], 6);
  k.box('lamp', [0.18, 0.12, 0.18], [0.82, 2.8, 2.85]);
  supplyCrate(k, -0.5, 0.35, 2.4, 0.4, 'cardboard', 0.3);
};

export const CAMPUS_DOODAD_BUILDERS: Partial<Record<DoodadKind, DoodadBuilder>> = {
  hospital_tower: doodad('hospital_tower', 1, hospitalTower),
  hospital_wing: doodad('hospital_wing', 3, hospitalWing),
  childrens_hospital: doodad('childrens_hospital', 1, childrensHospitalDoodad),
  research_lab: doodad('research_lab', 1, researchLab),
  parking_garage: doodad('parking_garage', 2, parkingGarage),
  old_laundry: doodad('old_laundry', 2, oldLaundry),
  water_tower: doodad('water_tower', 1, waterTower),
  skybridge: doodad('skybridge', 1, skybridge),
  ambulance: doodad('ambulance', 2, ambulance),
  car: doodad('car', CAR_COLS.length, car),
  bus: doodad('bus', 2, bus),
  helicopter_pad: doodad('helicopter_pad', 1, helipad, false),
  street_lamp: doodad('street_lamp', 2, streetLamp),
  bench: doodad('bench', 1, bench),
  bus_stop: doodad('bus_stop', 1, busStop),
  traffic_cone: doodad('traffic_cone', 1, trafficCone),
  barrier: doodad('barrier', 2, barrier),
  fence: doodad('fence', 1, fence),
  sign_er: doodad('sign_er', 1, signEr),
  dumpster: doodad('dumpster', DUMP.length, dumpster),
  flag_pole: doodad('flag_pole', 2, flagPole),
  tree_birch: doodad('tree_birch', 4, treeBirch),
  tree_pine: doodad('tree_pine', 3, treePine),
  bush: doodad('bush', 3, bush),
  rock_granite: doodad('rock_granite', 4, rockGranite),
  snow_pile: doodad('snow_pile', 3, snowPile, false),
  reeds: doodad('reeds', 3, reeds),
  pier: doodad('pier', 2, pier),
};

