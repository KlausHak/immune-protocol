/**
 * [map] MapBuilder — paints a MapData from high-level features and bakes the derived layers.
 *
 * Painting API (all deterministic; randomness only from the builder's seeded Rng / hash01):
 *   paint / fill            terrain in a Shape (rect, circle, ellipse, polygon, polyline, blob — see shapes.ts)
 *   road                    polyline road with width, kerbs (sidewalks), dashed centre line, street lamps
 *   elevate                 set an elevation level (plateau); its outer tile ring becomes a cliff face
 *   ramp                    rectangular ramp between two levels (tiles flagged in map.ramps, smooth heights)
 *   water / rock / block    sea & ponds (below waterLevel, blocked) · granite outcrops · explicit blocking
 *   doodad / scatter / row / fenceLine   props; blocking kinds bake their (rotated) footprint into `blocked`
 *   decal                   road_line, crosswalk, parking_lines, helipad_h, medical_cross, arrow, manhole, stain
 *   cache / cacheArc        2×2 Supply Caches (tiles stay UNBLOCKED in map.blocked — World blocks them when the
 *                           node spawns — but are never buildable)
 *   site                    reserved flat, clear, buildable building site (HQs, objectives); validated
 *   region / point / slot   named rects, named points, player slots
 *   finalize() → MapData    validate() → ValidationReport (see validate.ts)
 *
 * Baking rules (finalize):
 *  • heights: (W+1)×(H+1) vertices. A vertex takes LEVEL_HEIGHT × the LOWEST level among the land tiles touching
 *    it, so a plateau's outer tile ring slopes down one full level within one tile (the cliff face). Vertices on a
 *    ramp interpolate linearly between its low and high level. Vertices touching only water sink below waterLevel
 *    (deeper away from the shore). Gentle value noise is added to natural ground (grass/snow/dirt/sand/
 *    contaminated) and faded out near roads, plazas, sites, caches, cliffs and ramps, which stay exactly flat.
 *  • blocked: border, water, cliff tiles (land, non-ramp tiles whose base heights are not flat — this includes the
 *    walls beside ramps), explicit blocks and blocking-doodad footprints. Small walkable pockets cut off from the
 *    main ground area are blocked too.
 *  • buildable: walkable, flat, not ramp/water/rock, not under any doodad (walkable ones included), not a cache
 *    tile, not explicitly no-build.
 *
 * Conventions: tile (tx, ty) covers world [tx, tx+1) × [ty, ty+1); shapes are tested at tile centres. Doodad
 * footprints follow the model convention "forward = +X = w" and `rot` uses the sim facing convention
 * (0 = +x, increasing toward +y). Decal size.x runs along `rot` (local +X), size.y across it.
 */
import { LEVEL_HEIGHT } from '../config';
import { hash01, Rng } from '../core/rng';
import {
  Terrain, type Decal, type DecalKind, type Doodad, type DoodadKind, type FactionId, type LightingPreset,
  type MapData, type MapRegion, type PlayerId, type Vec2,
} from '../core/types';
import { shape, toV, type P, type Shape } from './shapes';
import { validateMap, type CorridorSpec, type LaneSpec, type MapRequirements, type SiteSpec, type ValidationReport } from './validate';

export { shape, type Shape, type P } from './shapes';

// ───────────────────────────── doodad catalogue ─────────────────────────────
export interface DoodadSpec {
  /** nominal footprint at scale 1 (tiles); model forward = +X = w */
  w: number;
  h: number;
  /** blocks ground movement (footprint baked into MapData.blocked) */
  blocks: boolean;
  /** rotation does not change the blocking footprint (trees, rocks, poles, round props) */
  round?: boolean;
}

/** DESIGN §6 nominal sizes. Walkable kinds never block; every doodad makes its tiles non-buildable. */
export const DOODAD_SPECS: Record<DoodadKind, DoodadSpec> = {
  hospital_tower: { w: 14, h: 10, blocks: true },
  hospital_wing: { w: 12, h: 6, blocks: true },
  childrens_hospital: { w: 6, h: 6, blocks: true },
  research_lab: { w: 10, h: 8, blocks: true },
  parking_garage: { w: 12, h: 10, blocks: true },
  old_laundry: { w: 10, h: 8, blocks: true },
  water_tower: { w: 3, h: 3, blocks: true, round: true },
  skybridge: { w: 8, h: 2, blocks: true },
  ambulance: { w: 2, h: 1, blocks: true },
  car: { w: 2, h: 1, blocks: true },
  bus: { w: 4, h: 1, blocks: true },
  helicopter_pad: { w: 4, h: 4, blocks: false },
  street_lamp: { w: 1, h: 1, blocks: true, round: true },
  bench: { w: 1, h: 1, blocks: true },
  bus_stop: { w: 2, h: 1, blocks: true },
  traffic_cone: { w: 0.4, h: 0.4, blocks: false, round: true },
  barrier: { w: 2, h: 1, blocks: true },
  fence: { w: 2, h: 0.3, blocks: true },
  sign_er: { w: 1, h: 1, blocks: true },
  dumpster: { w: 2, h: 1, blocks: true },
  flag_pole: { w: 1, h: 1, blocks: true, round: true },
  tree_birch: { w: 1, h: 1, blocks: true, round: true },
  tree_pine: { w: 1, h: 1, blocks: true, round: true },
  bush: { w: 1, h: 1, blocks: false, round: true },
  rock_granite: { w: 2, h: 2, blocks: true, round: true },
  snow_pile: { w: 1, h: 1, blocks: false, round: true },
  reeds: { w: 1, h: 1, blocks: false, round: true },
  pier: { w: 2, h: 6, blocks: true },
  biohazard_barrel: { w: 1, h: 1, blocks: true, round: true },
  goo_puddle: { w: 1, h: 1, blocks: false, round: true },
  sewer_grate: { w: 1, h: 1, blocks: false, round: true },
  infected_growth: { w: 2, h: 2, blocks: true, round: true },
  spore_vent: { w: 1, h: 1, blocks: true, round: true },
  waste_container: { w: 2, h: 1, blocks: true },
};

/** Terrains that get gentle height noise and may be overpainted by kerbs/patches. */
export const NATURAL_TERRAIN: readonly Terrain[] = [Terrain.Grass, Terrain.Snow, Terrain.Dirt, Terrain.Sand, Terrain.Contaminated];

/** Direction of ASCENT (toward the high side). North = −y. */
export type RampDir = 'n' | 's' | 'e' | 'w';

interface RampDef { x: number; y: number; w: number; h: number; dir: RampDir; low: number; high: number }

export interface MapBuilderOptions {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  seed: number;
  lighting: LightingPreset;
  /** sea level (world units). Default −0.35. */
  waterLevel?: number;
  /** starting terrain. Default Grass. */
  baseTerrain?: Terrain;
  /** blocked border thickness in tiles. Default 1. */
  border?: number;
  /** amplitude (world units) of the gentle noise on natural ground. Default 0.2. */
  noise?: number;
}

export interface RoadOptions {
  /** asphalt width in tiles (tile centres strictly within width/2 of the line). Odd widths → put the line on .5 */
  width: number;
  terrain?: Terrain;
  /** sidewalk/kerb width on each side (default 1; 0 = none). Kerbs only overpaint natural ground. */
  kerb?: number;
  kerbTerrain?: Terrain;
  /** dashed road_line decals along the centre (default: width ≥ 4) */
  centerLine?: boolean;
  /** street-lamp spacing along the road in tiles (lamps stand on the kerb; skipped where they'd hit a road/site) */
  lamps?: number;
  lampSides?: 'both' | 'left' | 'right' | 'alternate';
}

export interface DoodadOptions {
  rot?: number;
  scale?: number;
  seed?: number;
  /** snap the centre so a right-angle footprint aligns with tiles (default true) */
  snap?: boolean;
  /** skip the placement instead of recording a problem if it conflicts with sites/caches/ramps/other doodads */
  optional?: boolean;
  /** allow overlapping other doodads (e.g. cars inside a garage deck, bridge ends inside buildings) */
  overlap?: boolean;
}

export interface ScatterOptions {
  count: number;
  /** minimum distance between props placed by this call (default 1.5) */
  minDist?: number;
  /** uniform scale range (default [0.85, 1.15]) */
  scale?: [number, number];
  /** fixed rotation or 'random' (default random) */
  rot?: number | 'random';
  /** random sub-tile offset of the visual centre (default true for 1×1 round props) */
  jitter?: boolean;
  allowRoads?: boolean;
  allowPaved?: boolean;
  /** tiles inside this shape are skipped (e.g. lanes that must stay open) */
  avoid?: Shape;
  /** keep this many tiles away from caches/sites/ramps (default 1) */
  margin?: number;
  /** allow explicitly blocked tiles (decorative trees inside forest walls, map border) */
  allowBlocked?: boolean;
}

const EPS = 1e-4;
const NONE = 255;

export class MapBuilder {
  readonly W: number;
  readonly H: number;
  readonly seed: number;
  readonly rng: Rng;
  readonly waterLevel: number;

  private readonly opts: MapBuilderOptions;
  private readonly N: number;
  private readonly terrain: Uint8Array;
  private readonly levels: Uint8Array;
  private readonly rampMask: Uint8Array;
  private readonly explicitBlock: Uint8Array;
  private readonly noBuildMask: Uint8Array;
  private readonly flatMask: Uint8Array;
  private readonly cliffTerrain: Uint8Array;
  private readonly roadCount: Uint8Array;
  /** 0 = none, 1 = walkable doodad, 2 = blocking doodad */
  private readonly cover: Uint8Array;
  private readonly cacheMask: Uint8Array;
  private readonly siteMask: Uint8Array;
  private readonly pierMask: Uint8Array;

  private readonly rampList: RampDef[] = [];
  private readonly doodads: Doodad[] = [];
  private readonly decals: Decal[] = [];
  private readonly resources: MapData['resources'] = [];
  private readonly regions: Record<string, MapRegion> = {};
  private readonly points: Record<string, Vec2> = {};
  private readonly slots: MapData['slots'] = [];
  private readonly sites: SiteSpec[] = [];
  private readonly lampRequests: Array<{ x: number; y: number; rot: number }> = [];
  private readonly dashRequests: Array<{ x: number; y: number; rot: number }> = [];
  private readonly requirements: { regions: string[]; points: string[]; corridors: CorridorSpec[]; lanes: LaneSpec[] } =
    { regions: [], points: [], corridors: [], lanes: [] };
  /** design mistakes found while painting (reported by validate()) */
  readonly problems: string[] = [];
  /** problems found by the last finalize() */
  private finalizeProblems: string[] = [];
  /** number of walkable pocket tiles sealed by the last finalize() */
  sealedPocketTiles = 0;

  constructor(opts: MapBuilderOptions) {
    this.opts = opts;
    this.W = opts.width;
    this.H = opts.height;
    this.N = this.W * this.H;
    this.seed = opts.seed;
    this.rng = new Rng(opts.seed);
    this.waterLevel = opts.waterLevel ?? -0.35;
    this.terrain = new Uint8Array(this.N).fill(opts.baseTerrain ?? Terrain.Grass);
    this.levels = new Uint8Array(this.N);
    this.rampMask = new Uint8Array(this.N);
    this.explicitBlock = new Uint8Array(this.N);
    this.noBuildMask = new Uint8Array(this.N);
    this.flatMask = new Uint8Array(this.N);
    this.cliffTerrain = new Uint8Array(this.N).fill(NONE);
    this.roadCount = new Uint8Array(this.N);
    this.cover = new Uint8Array(this.N);
    this.cacheMask = new Uint8Array(this.N);
    this.siteMask = new Uint8Array(this.N);
    this.pierMask = new Uint8Array(this.N);
    const b = opts.border ?? 1;
    for (let ty = 0; ty < this.H; ty++) for (let tx = 0; tx < this.W; tx++) {
      if (tx < b || ty < b || tx >= this.W - b || ty >= this.H - b) { const i = ty * this.W + tx; this.explicitBlock[i] = 1; this.noBuildMask[i] = 1; }
    }
  }

  // ───────────────────────────── tile helpers ─────────────────────────────
  inside(tx: number, ty: number): boolean { return tx >= 0 && ty >= 0 && tx < this.W && ty < this.H; }
  idx(tx: number, ty: number): number { return ty * this.W + tx; }
  terrainAt(tx: number, ty: number): Terrain { return this.terrain[this.idx(tx, ty)] as Terrain; }
  levelAt(tx: number, ty: number): number { return this.levels[this.idx(tx, ty)]!; }

  /** Calls fn for every in-bounds tile whose centre lies inside the shape. */
  forTiles(s: Shape, fn: (tx: number, ty: number, i: number) => void): void {
    const x0 = Math.max(0, Math.floor(s.x0) - 1), y0 = Math.max(0, Math.floor(s.y0) - 1);
    const x1 = Math.min(this.W - 1, Math.ceil(s.x1) + 1), y1 = Math.min(this.H - 1, Math.ceil(s.y1) + 1);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      if (s.has(tx + 0.5, ty + 0.5)) fn(tx, ty, ty * this.W + tx);
    }
  }

  /** True if a scattered prop could stand on this tile (nothing important there). */
  isFreeTile(tx: number, ty: number, allowRoads = false, allowPaved = false, allowBlocked = false): boolean {
    if (!this.inside(tx, ty)) return false;
    const i = this.idx(tx, ty), t = this.terrain[i] as Terrain;
    if ((this.explicitBlock[i] && !allowBlocked) || this.cover[i] || this.cacheMask[i] || this.siteMask[i] || this.rampMask[i]) return false;
    if (t === Terrain.Water || t === Terrain.Rock) return false;
    if (!allowRoads && t === Terrain.Asphalt) return false;
    if (!allowPaved && (t === Terrain.Plaza || t === Terrain.Concrete)) return false;
    return true;
  }

  // ───────────────────────────── terrain ─────────────────────────────
  fill(t: Terrain): this { this.terrain.fill(t); return this; }

  /** Paint terrain. `over` restricts painting to those terrains; `notOver` protects terrains. Water is never overpainted unless listed in `over`. */
  paint(s: Shape, t: Terrain, opts: { over?: readonly Terrain[]; notOver?: readonly Terrain[] } = {}): this {
    this.forTiles(s, (_x, _y, i) => {
      const cur = this.terrain[i] as Terrain;
      if (opts.over && !opts.over.includes(cur)) return;
      if (!opts.over && cur === Terrain.Water && t !== Terrain.Water) return;
      if (opts.notOver?.includes(cur)) return;
      this.terrain[i] = t;
    });
    return this;
  }

  /** Raise (or lower) tiles to an elevation level. The outer ring of the area becomes a cliff (blocked). */
  elevate(s: Shape, level: number, opts: { terrain?: Terrain; cliff?: Terrain } = {}): this {
    this.forTiles(s, (_x, _y, i) => {
      if (this.terrain[i] === Terrain.Water) return;
      this.levels[i] = level;
      if (opts.terrain !== undefined) this.terrain[i] = opts.terrain;
      this.cliffTerrain[i] = opts.cliff ?? NONE;
    });
    return this;
  }

  /**
   * Rectangular ramp (tiles x..x+w-1 × y..y+h-1) ascending toward `dir` from level `low` to `high`.
   * Place it so its low end touches flat ground at `low` and its high end touches the plateau at `high`.
   * Ramp tiles get level `high` (map.ramps = 1) and are never buildable; the tiles flanking its sides become
   * cliff walls automatically.
   */
  ramp(x: number, y: number, w: number, h: number, dir: RampDir, low: number, high: number, opts: { terrain?: Terrain } = {}): this {
    this.rampList.push({ x, y, w, h, dir, low, high });
    this.forTiles(shape.rect(x, y, w, h), (_tx, _ty, i) => {
      this.rampMask[i] = 1;
      this.levels[i] = high;
      if (opts.terrain !== undefined) this.terrain[i] = opts.terrain;
    });
    return this;
  }

  /** Sea / pond: Water terrain at level 0 (blocked, heights below waterLevel). */
  water(s: Shape): this {
    this.forTiles(s, (_x, _y, i) => { this.terrain[i] = Terrain.Water; this.levels[i] = 0; });
    return this;
  }

  /** Granite outcrop: Rock terrain + blocked; optional boulder doodads on top (forced overlap). */
  rock(s: Shape, boulders = 0): this {
    const tiles: number[] = [];
    this.forTiles(s, (_x, _y, i) => {
      if (this.terrain[i] === Terrain.Water || this.rampMask[i]) return;
      this.terrain[i] = Terrain.Rock; this.explicitBlock[i] = 1; tiles.push(i);
    });
    for (let k = 0; k < boulders && tiles.length; k++) {
      const i = tiles[Math.floor(this.rng.next() * tiles.length)]!;
      const tx = i % this.W, ty = Math.floor(i / this.W);
      this.doodad('rock_granite', tx + 0.5 + this.rng.range(-0.3, 0.3), ty + 0.5 + this.rng.range(-0.3, 0.3),
        { rot: this.rng.next() * Math.PI * 2, scale: this.rng.range(0.8, 1.3), snap: false, overlap: true, optional: true });
    }
    return this;
  }

  block(s: Shape): this { this.forTiles(s, (_x, _y, i) => { this.explicitBlock[i] = 1; }); return this; }
  noBuild(s: Shape): this { this.forTiles(s, (_x, _y, i) => { this.noBuildMask[i] = 1; }); return this; }
  /** suppress height noise (keeps the ground perfectly flat) */
  flatten(s: Shape): this { this.forTiles(s, (_x, _y, i) => { this.flatMask[i] = 1; }); return this; }

  /** Polyline road: asphalt core, kerbs on natural ground, dashed centre line and optional lamps. */
  road(points: readonly P[], o: RoadOptions): this {
    const pts = points.map(toV);
    const kerb = o.kerb ?? 1;
    if (kerb > 0) this.paint(shape.line(pts, o.width + kerb * 2), o.kerbTerrain ?? Terrain.Concrete, { over: NATURAL_TERRAIN });
    this.forTiles(shape.line(pts, o.width + kerb * 2), (_x, _y, i) => { this.flatMask[i] = 1; });
    this.forTiles(shape.line(pts, o.width), (_x, _y, i) => {
      if (this.terrain[i] === Terrain.Water) return;
      this.terrain[i] = o.terrain ?? Terrain.Asphalt;
      this.roadCount[i] = Math.min(250, this.roadCount[i]! + 1);
    });
    const centre = o.centerLine ?? o.width >= 4;
    const off = o.width / 2 + Math.max(kerb, 1) / 2;
    let acc = 0, nextLamp = (o.lamps ?? 0) / 2, side = 1;
    for (let s = 0; s + 1 < pts.length; s++) {
      const a = pts[s]!, b = pts[s + 1]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len, rot = Math.atan2(dy, dx);
      if (centre) for (let d = 2; d < len - 1; d += 4) this.dashRequests.push({ x: a.x + dx * d, y: a.y + dy * d, rot });
      if (o.lamps && o.lamps > 0) {
        while (nextLamp <= acc + len) {
          const d = nextLamp - acc, cx = a.x + dx * d, cy = a.y + dy * d;
          const sides = o.lampSides === 'both' ? [1, -1] : o.lampSides === 'left' ? [-1] : o.lampSides === 'right' ? [1] : [side];
          // right-hand side of the travel direction (sim y down): normal = (-dy, dx)
          for (const sd of sides) this.lampRequests.push({ x: cx - dy * off * sd, y: cy + dx * off * sd, rot: rot - (Math.PI / 2) * sd });
          side = -side;
          nextLamp += o.lamps;
        }
      }
      acc += len;
    }
    return this;
  }

  // ───────────────────────────── sites, caches, names ─────────────────────────────
  /** Reserve a flat, clear, buildable site (top-left tile x,y; w×h tiles). Returns its world centre. */
  site(name: string, x: number, y: number, w: number, h: number, opts: { minCacheGap?: number; terrain?: Terrain } = {}): Vec2 {
    this.forTiles(shape.rect(x, y, w, h), (_tx, _ty, i) => {
      if (this.cover[i]) this.problems.push(`site ${name}: tile ${i % this.W},${Math.floor(i / this.W)} already has a doodad`);
      this.siteMask[i] = 1; this.flatMask[i] = 1;
      if (opts.terrain !== undefined) this.terrain[i] = opts.terrain;
    });
    this.sites.push({ name, x, y, w, h, minCacheGap: opts.minCacheGap });
    return { x: x + w / 2, y: y + h / 2 };
  }

  /** Supply Cache (2×2) centred on integer world point (x, y): tiles x-1..x × y-1..y. */
  cache(x: number, y: number, amount = 1500): this {
    const cx = Math.round(x), cy = Math.round(y);
    for (let ty = cy - 1; ty <= cy; ty++) for (let tx = cx - 1; tx <= cx; tx++) {
      if (!this.inside(tx, ty)) { this.problems.push(`cache (${cx},${cy}) out of bounds`); return this; }
      const i = this.idx(tx, ty);
      if (this.cacheMask[i]) this.problems.push(`cache (${cx},${cy}) overlaps another cache`);
      if (this.cover[i] === 2 || this.explicitBlock[i] || this.siteMask[i] || this.rampMask[i]) this.problems.push(`cache (${cx},${cy}) overlaps a blocker/site/ramp at ${tx},${ty}`);
    }
    for (let ty = cy - 1; ty <= cy; ty++) for (let tx = cx - 1; tx <= cx; tx++) this.cacheMask[this.idx(tx, ty)] = 1;
    this.flatten(shape.rect(cx - 2, cy - 2, 4, 4));
    this.resources.push({ pos: { x: cx, y: cy }, amount });
    return this;
  }

  /**
   * Caches on an arc around (cx, cy). Angles in degrees, sim convention (0 = east, 90 = south). Positions are
   * rounded to integer centres; `n` caches are spread evenly from a0 to a1.
   */
  cacheArc(cx: number, cy: number, r: number, a0: number, a1: number, n: number, amount = 1500): Vec2[] {
    const out: Vec2[] = [];
    for (let k = 0; k < n; k++) {
      const a = ((n === 1 ? (a0 + a1) / 2 : a0 + ((a1 - a0) * k) / (n - 1)) * Math.PI) / 180;
      const p = { x: Math.round(cx + Math.cos(a) * r), y: Math.round(cy + Math.sin(a) * r) };
      this.cache(p.x, p.y, amount);
      out.push(p);
    }
    return out;
  }

  region(name: string, x: number, y: number, w: number, h: number): this { this.regions[name] = { x, y, w, h }; return this; }
  point(name: string, x: number, y: number): this { this.points[name] = { x, y }; return this; }
  slot(id: PlayerId, faction: FactionId, x: number, y: number): this { this.slots.push({ id, faction, start: { x, y } }); return this; }
  getPoint(name: string): Vec2 | undefined { const p = this.points[name]; return p ? { ...p } : undefined; }

  /** Lanes declared via require() (copies). */
  lanes(): LaneSpec[] { return this.requirements.lanes.map((l) => ({ ...l, via: [...l.via] })); }

  /** Declare names/corridors/lanes that validate() must check. */
  require(r: { regions?: string[]; points?: string[]; corridors?: CorridorSpec[]; lanes?: LaneSpec[] }): this {
    this.requirements.regions.push(...(r.regions ?? []));
    this.requirements.points.push(...(r.points ?? []));
    this.requirements.corridors.push(...(r.corridors ?? []));
    this.requirements.lanes.push(...(r.lanes ?? []));
    return this;
  }

  // ───────────────────────────── doodads & decals ─────────────────────────────
  /** Tiles covered by a doodad placed at (x, y). Thin dimensions still cover one full tile row. */
  footprintTiles(kind: DoodadKind, x: number, y: number, rot = 0, scale = 1): number[] {
    const spec = DOODAD_SPECS[kind];
    const ang = spec.round ? 0 : rot;
    const c = Math.cos(ang), s = Math.sin(ang);
    const hw = Math.max(1, Math.round(spec.w * scale)) / 2, hh = Math.max(1, Math.round(spec.h * scale)) / 2;
    const ex = Math.abs(c) * hw + Math.abs(s) * hh, ey = Math.abs(s) * hw + Math.abs(c) * hh;
    const out: number[] = [];
    for (let ty = Math.floor(y - ey); ty <= Math.ceil(y + ey); ty++) for (let tx = Math.floor(x - ex); tx <= Math.ceil(x + ex); tx++) {
      if (!this.inside(tx, ty)) continue;
      const px = tx + 0.5 - x, py = ty + 0.5 - y;
      const u = px * c + py * s, v = -px * s + py * c;
      if (Math.abs(u) < hw - EPS && Math.abs(v) < hh - EPS) out.push(this.idx(tx, ty));
    }
    if (out.length === 0 && this.inside(Math.floor(x), Math.floor(y))) out.push(this.idx(Math.floor(x), Math.floor(y)));
    return out;
  }

  /** Snap a right-angle footprint so its edges land on tile boundaries. */
  private snapped(kind: DoodadKind, x: number, y: number, rot: number, scale: number): Vec2 {
    const spec = DOODAD_SPECS[kind];
    const ang = spec.round ? 0 : rot;
    const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang));
    const right = c < 1e-3 || s < 1e-3;
    if (!right) return { x, y };
    const w = Math.max(1, Math.round(spec.w * scale)), h = Math.max(1, Math.round(spec.h * scale));
    const W = c > 0.5 ? w : h, H = c > 0.5 ? h : w;
    const sx = W % 2 === 0 ? Math.round(x) : Math.floor(x) + 0.5;
    const sy = H % 2 === 0 ? Math.round(y) : Math.floor(y) + 0.5;
    return { x: sx, y: sy };
  }

  /**
   * Place a doodad (visual centre x, y). Blocking kinds block their footprint; all kinds make it non-buildable.
   * Conflicts with sites, caches, ramps or other doodads are recorded as problems (or skipped if `optional`).
   */
  doodad(kind: DoodadKind, x: number, y: number, o: DoodadOptions = {}): Doodad | null {
    const spec = DOODAD_SPECS[kind];
    const rot = o.rot ?? 0, scale = o.scale ?? 1;
    const p = o.snap === false ? { x, y } : this.snapped(kind, x, y, rot, scale);
    const tiles = this.footprintTiles(kind, p.x, p.y, rot, scale);
    const small = spec.w * scale < 1.5 && spec.h * scale < 1.5;
    for (const i of tiles) {
      const bad = this.siteMask[i] ? 'site' : this.cacheMask[i] ? 'cache' : (this.rampMask[i] && (spec.blocks || !small)) ? 'ramp'
        : (!o.overlap && this.cover[i] === 2) ? 'doodad' : (!o.overlap && spec.blocks && this.cover[i]) ? 'doodad' : null;
      if (bad) {
        if (!o.optional) this.problems.push(`${kind} at (${p.x.toFixed(1)},${p.y.toFixed(1)}) overlaps a ${bad} at tile ${i % this.W},${Math.floor(i / this.W)}`);
        return null;
      }
    }
    const flattenUnder = spec.blocks && spec.w * scale >= 3 && spec.h * scale >= 3;
    for (const i of tiles) {
      this.cover[i] = Math.max(this.cover[i]!, spec.blocks ? 2 : 1);
      if (kind === 'pier') this.pierMask[i] = 1;
      if (flattenUnder) this.flatten(shape.rect(i % this.W - 1, Math.floor(i / this.W) - 1, 3, 3));
    }
    const d: Doodad = {
      kind, pos: p, rot, scale,
      seed: o.seed ?? Math.floor(hash01(this.doodads.length + 1, this.seed * 31 + 7) * 0x7fffffff),
    };
    if (spec.blocks) d.footprint = { w: spec.w * scale, h: spec.h * scale };
    this.doodads.push(d);
    return d;
  }

  /** Scatter props inside a shape (deterministic). Returns how many were placed. */
  scatter(kinds: DoodadKind | readonly DoodadKind[], area: Shape, o: ScatterOptions): number {
    const list: readonly DoodadKind[] = typeof kinds === 'string' ? [kinds] : kinds;
    const minD = o.minDist ?? 1.5, margin = o.margin ?? 1;
    const placed: Vec2[] = [];
    const span = { x: area.x1 - area.x0, y: area.y1 - area.y0 };
    for (let attempt = 0; attempt < o.count * 40 && placed.length < o.count; attempt++) {
      const kind = list[Math.floor(this.rng.next() * list.length)]!;
      const spec = DOODAD_SPECS[kind];
      const px = area.x0 + this.rng.next() * span.x, py = area.y0 + this.rng.next() * span.y;
      const tx = Math.floor(px), ty = Math.floor(py);
      if (!area.has(tx + 0.5, ty + 0.5) || (o.avoid && o.avoid.has(tx + 0.5, ty + 0.5))) continue;
      if (!this.isFreeTile(tx, ty, o.allowRoads, o.allowPaved, o.allowBlocked)) continue;
      if (this.nearReserved(tx, ty, margin)) continue;
      if (this.nearLevelChange(tx, ty)) continue;
      const big = spec.w > 1.5 || spec.h > 1.5;
      const jitter = o.jitter ?? (!big && !!spec.round);
      const cx = big ? tx + (spec.w % 2 === 0 ? 0 : 0.5) : tx + 0.5 + (jitter ? this.rng.range(-0.22, 0.22) : 0);
      const cy = big ? ty + (spec.h % 2 === 0 ? 0 : 0.5) : ty + 0.5 + (jitter ? this.rng.range(-0.22, 0.22) : 0);
      if (placed.some((q) => Math.hypot(q.x - cx, q.y - cy) < minD)) continue;
      const scale = o.scale ? this.rng.range(o.scale[0], o.scale[1]) : this.rng.range(0.85, 1.15);
      const rot = o.rot === undefined || o.rot === 'random' ? this.rng.next() * Math.PI * 2 : o.rot;
      if (big) {
        const tiles = this.footprintTiles(kind, cx, cy, rot, scale);
        if (tiles.some((i) => !this.isFreeTile(i % this.W, Math.floor(i / this.W), o.allowRoads, o.allowPaved, o.allowBlocked) || this.nearReserved(i % this.W, Math.floor(i / this.W), margin) || (o.avoid && o.avoid.has(i % this.W + 0.5, Math.floor(i / this.W) + 0.5)))) continue;
      }
      const d = this.doodad(kind, cx, cy, { rot, scale, snap: big ? undefined : false, optional: true });
      if (d) placed.push(d.pos);
    }
    return placed.length;
  }

  /** Props in a row from a to b every `spacing` tiles (fences, hedges, tree avenues, cones). */
  row(kind: DoodadKind, a: P, b: P, spacing: number, o: DoodadOptions = {}): number {
    const A = toV(a), B = toV(b);
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    const n = Math.max(1, Math.floor(len / spacing + 1e-6) + 1);
    const rot = o.rot ?? Math.atan2(B.y - A.y, B.x - A.x);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const d = this.doodad(kind, A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t, { ...o, rot, optional: o.optional ?? true });
      if (d) k++;
    }
    return k;
  }

  /** Fence segments (2 tiles each) along a polyline; `skip(x, y)` leaves gaps (gates). */
  fenceLine(points: readonly P[], o: { skip?: (x: number, y: number) => boolean } = {}): number {
    const pts = points.map(toV);
    let placed = 0;
    for (let s = 0; s + 1 < pts.length; s++) {
      const a = pts[s]!, b = pts[s + 1]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len, rot = Math.atan2(dy, dx);
      for (let d = 1; d <= len - 1 + 1e-6; d += 2) {
        const x = a.x + dx * d, y = a.y + dy * d;
        if (o.skip?.(x, y)) continue;
        if (this.doodad('fence', x, y, { rot, optional: true })) placed++;
      }
    }
    return placed;
  }

  decal(kind: DecalKind, x: number, y: number, w: number, h: number, rot = 0): this {
    this.decals.push({ kind, pos: { x, y }, rot, size: { x: w, y: h } });
    return this;
  }

  private nearReserved(tx: number, ty: number, margin: number): boolean {
    for (let y = ty - margin; y <= ty + margin; y++) for (let x = tx - margin; x <= tx + margin; x++) {
      if (!this.inside(x, y)) continue;
      const i = this.idx(x, y);
      if (this.cacheMask[i] || this.siteMask[i] || this.rampMask[i]) return true;
    }
    return false;
  }

  private nearLevelChange(tx: number, ty: number): boolean {
    const l = this.levels[this.idx(tx, ty)];
    for (let y = ty - 1; y <= ty + 1; y++) for (let x = tx - 1; x <= tx + 1; x++) {
      if (this.inside(x, y) && this.levels[this.idx(x, y)] !== l) return true;
    }
    return false;
  }

  // ───────────────────────────── finalize ─────────────────────────────
  private rampVertexHeight(vx: number, vy: number): number | null {
    for (const r of this.rampList) {
      if (vx < r.x || vx > r.x + r.w || vy < r.y || vy > r.y + r.h) continue;
      const t = r.dir === 'n' ? (r.y + r.h - vy) / r.h : r.dir === 's' ? (vy - r.y) / r.h
        : r.dir === 'e' ? (vx - r.x) / r.w : (r.x + r.w - vx) / r.w;
      return LEVEL_HEIGHT * (r.low + (r.high - r.low) * t);
    }
    return null;
  }

  /** Bake everything into a fresh MapData. Idempotent: may be called repeatedly. */
  finalize(): MapData {
    const { W, H, N } = this;
    const VW = W + 1, VH = H + 1;
    const problems: string[] = [];
    const terrain = this.terrain.slice();
    const levels = this.levels.slice();
    const ramps = this.rampMask.slice();
    for (const r of this.rampList) this.forTiles(shape.rect(r.x, r.y, r.w, r.h), (_x, _y, i) => { levels[i] = r.high; ramps[i] = 1; });
    const isWater = (i: number) => terrain[i] === Terrain.Water;

    // water distance to land (tiles, 4-neighbour BFS) → seabed depth
    const wdist = new Int16Array(N).fill(-1);
    const q: number[] = [];
    for (let i = 0; i < N; i++) if (!isWater(i)) { wdist[i] = 0; q.push(i); }
    for (let h = 0; h < q.length; h++) {
      const i = q[h]!, tx = i % W, ty = (i - tx) / W;
      for (const [nx, ny] of [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]] as const) {
        if (!this.inside(nx, ny)) continue;
        const j = ny * W + nx;
        if (wdist[j] === -1) { wdist[j] = wdist[i]! + 1; q.push(j); }
      }
    }

    // base vertex heights
    const base = new Float32Array(VW * VH);
    const pierVertex = new Uint8Array(VW * VH);
    for (let vy = 0; vy <= H; vy++) for (let vx = 0; vx <= W; vx++) {
      const vi = vy * VW + vx;
      const rh = this.rampVertexHeight(vx, vy);
      if (rh !== null) { base[vi] = rh; continue; }
      let minLevel = Infinity, minWd = Infinity, n = 0, piers = 0;
      for (let ty = vy - 1; ty <= vy; ty++) for (let tx = vx - 1; tx <= vx; tx++) {
        if (!this.inside(tx, ty)) continue;
        const i = ty * W + tx; n++;
        if (isWater(i)) { minWd = Math.min(minWd, wdist[i]!); if (this.pierMask[i]) piers++; }
        else minLevel = Math.min(minLevel, levels[i]!);
      }
      if (minLevel !== Infinity) base[vi] = minLevel * LEVEL_HEIGHT;
      else if (piers === n) { base[vi] = this.waterLevel - 0.12; pierVertex[vi] = 1; }
      else base[vi] = this.waterLevel - 0.45 - 0.24 * Math.min(Math.max(minWd - 1, 0), 6);
    }
    const vh = (vx: number, vy: number) => base[vy * VW + vx]!;

    // flatness & cliffs
    const flat = new Uint8Array(N), cliff = new Uint8Array(N);
    for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      const a = vh(tx, ty), b = vh(tx + 1, ty), c = vh(tx, ty + 1), d = vh(tx + 1, ty + 1);
      const isFlat = Math.abs(a - b) < EPS && Math.abs(a - c) < EPS && Math.abs(a - d) < EPS;
      flat[i] = isFlat ? 1 : 0;
      if (!isFlat && !ramps[i] && !isWater(i)) {
        cliff[i] = 1;
        if (this.cliffTerrain[i] !== NONE) terrain[i] = this.cliffTerrain[i]!;
      }
    }
    for (const r of this.rampList) this.checkRamp(r, levels, flat, ramps, problems);

    // deferred street lamps & centre-line dashes
    const cover = this.cover.slice();
    const doodads: Doodad[] = this.doodads.map((d) => {
      const c: Doodad = { kind: d.kind, pos: { ...d.pos }, rot: d.rot, scale: d.scale, seed: d.seed };
      if (d.footprint) c.footprint = { ...d.footprint };
      return c;
    });
    for (const l of this.lampRequests) {
      const tx = Math.floor(l.x), ty = Math.floor(l.y);
      if (!this.inside(tx, ty)) continue;
      const i = ty * W + tx;
      const t = terrain[i] as Terrain;
      if (t === Terrain.Asphalt || t === Terrain.Water || t === Terrain.Rock || cliff[i] || ramps[i] || this.siteMask[i] || this.cacheMask[i] || cover[i] || this.explicitBlock[i]) continue;
      if (this.nearReservedIn(tx, ty, ramps)) continue;
      if (Object.values(this.points).some((p) => Math.abs(p.x - (tx + 0.5)) < 1.6 && Math.abs(p.y - (ty + 0.5)) < 1.6)) continue;
      cover[i] = 2;
      doodads.push({ kind: 'street_lamp', pos: { x: tx + 0.5, y: ty + 0.5 }, rot: l.rot, scale: 1, footprint: { w: 1, h: 1 }, seed: Math.floor(hash01(doodads.length + 1, this.seed * 31 + 7) * 0x7fffffff) });
    }
    const decals = this.decals.map((d) => ({ ...d, pos: { ...d.pos }, size: { ...d.size } }));
    for (const dsh of this.dashRequests) {
      const tx = Math.floor(dsh.x), ty = Math.floor(dsh.y);
      let ok = this.inside(tx, ty) && terrain[ty * W + tx] === Terrain.Asphalt;
      for (let y = ty - 2; ok && y <= ty + 2; y++) for (let x = tx - 2; ok && x <= tx + 2; x++) {
        if (this.inside(x, y) && this.roadCount[y * W + x]! > 1) ok = false;
      }
      if (ok) decals.push({ kind: 'road_line', pos: { x: dsh.x, y: dsh.y }, rot: dsh.rot, size: { x: 1.8, y: 0.18 } });
    }

    // blocked
    const blocked = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (this.explicitBlock[i] || isWater(i) || cliff[i] || cover[i] === 2) blocked[i] = 1;
      if (ramps[i] && cover[i] === 2) problems.push(`ramp tile ${i % W},${Math.floor(i / W)} is covered by a blocking doodad`);
    }

    // seal small walkable pockets that are cut off from the main ground area (caches count as walkable here)
    this.sealedPocketTiles = 0;
    {
      const comp = new Int32Array(N).fill(-1);
      const sizes: number[] = [];
      for (let s = 0; s < N; s++) {
        if (blocked[s] || comp[s] !== -1) continue;
        const id = sizes.length; let size = 0; const st = [s]; comp[s] = id;
        while (st.length) {
          const i = st.pop()!; size++;
          const tx = i % W, ty = (i - tx) / W;
          if (tx > 0 && !blocked[i - 1] && comp[i - 1] === -1) { comp[i - 1] = id; st.push(i - 1); }
          if (tx < W - 1 && !blocked[i + 1] && comp[i + 1] === -1) { comp[i + 1] = id; st.push(i + 1); }
          if (ty > 0 && !blocked[i - W] && comp[i - W] === -1) { comp[i - W] = id; st.push(i - W); }
          if (ty < H - 1 && !blocked[i + W] && comp[i + W] === -1) { comp[i + W] = id; st.push(i + W); }
        }
        sizes.push(size);
      }
      let main = 0;
      for (let k = 1; k < sizes.length; k++) if (sizes[k]! > sizes[main]!) main = k;
      for (let i = 0; i < N; i++) {
        const c = comp[i]!;
        if (c >= 0 && c !== main && sizes[c]! < 400) {
          if (this.cacheMask[i] || this.siteMask[i]) problems.push(`tile ${i % W},${Math.floor(i / W)} (cache/site) is in a sealed-off pocket`);
          blocked[i] = 1; this.sealedPocketTiles++;
        }
      }
    }

    // buildable
    const buildable = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      buildable[i] = !blocked[i] && flat[i] && !ramps[i] && !isWater(i) && terrain[i] !== Terrain.Rock && !this.noBuildMask[i] && !cover[i] && !this.cacheMask[i] ? 1 : 0;
    }
    for (const s of this.sites) {
      for (let ty = s.y; ty < s.y + s.h; ty++) for (let tx = s.x; tx < s.x + s.w; tx++) {
        if (!this.inside(tx, ty) || !buildable[ty * W + tx]) { problems.push(`site ${s.name}: tile ${tx},${ty} is not buildable`); ty = s.y + s.h; break; }
      }
    }

    // final heights: base + faded gentle noise on natural ground + bumps on granite outcrops
    const amp = this.opts.noise ?? 0.2;
    const natural = (i: number) => NATURAL_TERRAIN.includes(terrain[i] as Terrain) && !this.flatMask[i] && !this.siteMask[i] && !this.cacheMask[i]
      && !ramps[i] && flat[i] && !cliff[i] && !isWater(i);
    const vdist = new Int16Array(VW * VH).fill(-1);
    const vq: number[] = [];
    for (let vy = 0; vy <= H; vy++) for (let vx = 0; vx <= W; vx++) {
      let ok = true;
      for (let ty = vy - 1; ty <= vy && ok; ty++) for (let tx = vx - 1; tx <= vx && ok; tx++) {
        if (this.inside(tx, ty) && !natural(ty * W + tx)) ok = false;
      }
      if (!ok) { vdist[vy * VW + vx] = 0; vq.push(vy * VW + vx); }
    }
    for (let h = 0; h < vq.length; h++) {
      const vi = vq[h]!, vx = vi % VW, vy = (vi - vx) / VW;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = vx + dx, ny = vy + dy;
        if (nx < 0 || ny < 0 || nx > W || ny > H) continue;
        const nj = ny * VW + nx;
        if (vdist[nj] === -1) { vdist[nj] = vdist[vi]! + 1; vq.push(nj); }
      }
    }
    const heights = new Float32Array(VW * VH);
    for (let vy = 0; vy <= H; vy++) for (let vx = 0; vx <= W; vx++) {
      const vi = vy * VW + vx;
      let hgt = base[vi]!;
      const d = vdist[vi]!;
      if (d > 0) hgt += amp * Math.min(1, d / 3) * fbm(vx, vy, this.seed);
      // granite outcrops (all four touching tiles blocked rock) bulge upward
      let rocks = 0, n = 0;
      for (let ty = vy - 1; ty <= vy; ty++) for (let tx = vx - 1; tx <= vx; tx++) {
        if (!this.inside(tx, ty)) continue;
        n++; const i = ty * W + tx;
        if (terrain[i] === Terrain.Rock && blocked[i] && !ramps[i]) rocks++;
      }
      if (n > 0 && rocks === n) hgt += 0.25 + 0.35 * hash01(vi, this.seed + 101);
      if (!pierVertex[vi] && base[vi]! < this.waterLevel) hgt += 0.08 * fbm(vx * 1.7, vy * 1.7, this.seed + 5);
      heights[vi] = hgt;
    }

    this.finalizeProblems = problems;
    return {
      id: this.opts.id, name: this.opts.name, description: this.opts.description,
      width: W, height: H, terrain, levels, ramps, blocked, buildable, heights,
      doodads, decals,
      resources: this.resources.map((r) => ({ pos: { ...r.pos }, amount: r.amount })),
      slots: this.slots.map((s) => ({ id: s.id, faction: s.faction, start: { ...s.start } })),
      regions: Object.fromEntries(Object.entries(this.regions).map(([k, v]) => [k, { ...v }])),
      points: Object.fromEntries(Object.entries(this.points).map(([k, v]) => [k, { ...v }])),
      lighting: this.opts.lighting,
      waterLevel: this.waterLevel,
    };
  }

  private nearReservedIn(tx: number, ty: number, ramps: Uint8Array): boolean {
    for (let y = ty - 1; y <= ty + 1; y++) for (let x = tx - 1; x <= tx + 1; x++) {
      if (this.inside(x, y) && (ramps[this.idx(x, y)] || this.cacheMask[this.idx(x, y)])) return true;
    }
    return false;
  }

  /** The tiles just past each end of a ramp must be flat ground at the matching level. */
  private checkRamp(r: RampDef, levels: Uint8Array, flat: Uint8Array, ramps: Uint8Array, problems: string[]): void {
    const lowSide: Array<[number, number]> = [], highSide: Array<[number, number]> = [];
    if (r.dir === 'n' || r.dir === 's') {
      const yl = r.dir === 'n' ? r.y + r.h : r.y - 1, yh = r.dir === 'n' ? r.y - 1 : r.y + r.h;
      for (let x = r.x; x < r.x + r.w; x++) { lowSide.push([x, yl]); highSide.push([x, yh]); }
    } else {
      const xl = r.dir === 'e' ? r.x - 1 : r.x + r.w, xh = r.dir === 'e' ? r.x + r.w : r.x - 1;
      for (let y = r.y; y < r.y + r.h; y++) { lowSide.push([xl, y]); highSide.push([xh, y]); }
    }
    const check = (cells: Array<[number, number]>, level: number, end: string) => {
      for (const [x, y] of cells) {
        if (!this.inside(x, y)) { problems.push(`ramp at ${r.x},${r.y}: ${end} end leaves the map`); return; }
        const i = this.idx(x, y);
        if (ramps[i]) continue;
        if (levels[i] !== level || !flat[i]) { problems.push(`ramp at ${r.x},${r.y}: ${end} end tile ${x},${y} is not flat level-${level} ground`); return; }
      }
    };
    check(lowSide, r.low, 'low');
    check(highSide, r.high, 'high');
  }

  // ───────────────────────────── validation ─────────────────────────────
  /** Validate a finalized map against this builder's sites and declared requirements. */
  validate(map: MapData = this.finalize(), extra: MapRequirements = {}): ValidationReport {
    const report = validateMap(map, {
      regions: [...this.requirements.regions, ...(extra.regions ?? [])],
      points: [...this.requirements.points, ...(extra.points ?? [])],
      sites: [...this.sites, ...(extra.sites ?? [])],
      corridors: [...this.requirements.corridors, ...(extra.corridors ?? [])],
      lanes: [...this.requirements.lanes, ...(extra.lanes ?? [])],
    });
    const pre = [...this.problems, ...this.finalizeProblems];
    if (pre.length) { report.errors.unshift(...pre); report.ok = false; }
    return report;
  }
}

// ───────────────────────────── noise ─────────────────────────────
function valueNoise(x: number, y: number, cell: number, salt: number): number {
  const gx = x / cell, gy = y / cell, ix = Math.floor(gx), iy = Math.floor(gy);
  const fx = gx - ix, fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h = (a: number, b: number) => hash01(Math.imul(a, 73856093) ^ Math.imul(b, 19349663), salt) * 2 - 1;
  const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/** Smooth fractal value noise in roughly [−1, 1]. */
export function fbm(x: number, y: number, salt: number): number {
  return 0.6 * valueNoise(x, y, 11, salt) + 0.3 * valueNoise(x, y, 5, salt + 1) + 0.1 * valueNoise(x, y, 2.5, salt + 2);
}
