/**
 * [ai] What The Contagion knows about its enemies — strictly through its own fog of war
 * (world.vision.isEntityVisible / isVisible). Remembers structures until it sees them gone, keeps a
 * rolling picture of the enemy army composition, and tracks when points of interest (start locations,
 * resource sites) were last looked at.
 */
import { clone, dist } from '../core/math';
import type { BuildingDef, Entity, EntityId, PlayerId, Vec2 } from '../core/types';
import type { Brain } from './brain';
import { canHitAir, costValue, hasWeapons, isAir, isWorkerUnit, weaponsOf } from './util';

export interface SeenStructure {
  id: EntityId;
  owner: PlayerId;
  defId: string;
  pos: Vec2;
  /** half of the larger footprint side */
  radius: number;
  armed: boolean;
  hitsAir: boolean;
  uv: boolean;
  hq: boolean;
  producer: boolean;
  wall: boolean;
  value: number;
  lastSeen: number;
}

export interface SeenUnit {
  id: EntityId;
  defId: string;
  pos: Vec2;
  lastSeen: number;
  value: number;
  worker: boolean;
  combat: boolean;
  light: boolean;
  mech: boolean;
  air: boolean;
  hitsAir: boolean;
  uv: boolean;
  antibiotic: boolean;
}

/** Composition summary of the recently seen enemy (value shares 0..1). */
export interface Intel {
  /** enemy combat units seen recently */
  seen: number;
  armyValue: number;
  light: number;
  mech: number;
  air: number;
  antiAir: number;
  uv: number;
  antibiotic: number;
  /** known armed enemy structures */
  turrets: number;
  walls: number;
}

const keyOf = (p: Vec2): string => `${Math.round(p.x)},${Math.round(p.y)}`;

export class EnemyMemory {
  readonly structures = new Map<EntityId, SeenStructure>();
  readonly units = new Map<EntityId, SeenUnit>();
  /** world.time of the first sighting of any enemy combat unit (-1 = none yet) */
  firstContact = -1;
  private looked = new Map<string, number>();
  private points: Vec2[] = [];
  private intelCache: { tick: number; v: Intel } | null = null;

  constructor(private b: Brain) {}

  setInterestPoints(points: Vec2[]): void { this.points = points.map(clone); }

  /** Last time we had eyes on p (-1 = never). Only tracked for interest points. */
  lastLooked(p: Vec2): number { return this.looked.get(keyOf(p)) ?? -1; }

  forgetUnit(id: EntityId): void { this.units.delete(id); }

  scan(): void {
    const { world, me } = this.b;
    const t = world.time;
    for (const e of world.list) {
      if (!e.alive || e.kind === 'resource' || !world.isEnemy(me, e.owner)) continue;
      if (!world.vision.isEntityVisible(me, e)) continue;
      if (e.kind === 'building') this.seeStructure(e, t);
      else this.seeUnit(e, t);
    }
    // A remembered structure is only forgotten once we can see its spot and it is gone.
    for (const [id, s] of this.structures) {
      if (world.getAlive(id)) continue;
      if (world.vision.isVisible(me, s.pos)) this.structures.delete(id);
    }
    for (const [id, u] of this.units) if (t - u.lastSeen > 240) this.units.delete(id);
    for (const p of this.points) if (world.vision.isVisible(me, p)) this.looked.set(keyOf(p), t);
  }

  private seeStructure(e: Entity, t: number): void {
    const def = e.def as BuildingDef;
    const prev = this.structures.get(e.id);
    if (prev) { prev.lastSeen = t; return; }
    const armed = def.weapons.length > 0;
    this.structures.set(e.id, {
      id: e.id, owner: e.owner, defId: e.defId, pos: clone(e.pos), radius: Math.max(def.footprint.w, def.footprint.h) / 2,
      armed, hitsAir: armed && def.weapons.some((w) => w.targets.includes('air')), uv: def.weapons.some((w) => w.damageType === 'uv'),
      hq: !!def.hq, producer: def.trains.length > 0, wall: !armed && def.trains.length === 0 && def.researches.length === 0 && !def.provides.pop && !def.provides.energyPerSec && def.armor >= 3,
      value: costValue(def.cost), lastSeen: t,
    });
  }

  private seeUnit(e: Entity, t: number): void {
    const u = this.units.get(e.id);
    if (u) { u.lastSeen = t; u.pos.x = e.pos.x; u.pos.y = e.pos.y; return; }
    const worker = isWorkerUnit(e);
    const combat = !worker && (hasWeapons(e) || e.tags.has('healer'));
    if (combat && this.firstContact < 0) this.firstContact = t;
    const ws = weaponsOf(e);
    this.units.set(e.id, {
      id: e.id, defId: e.defId, pos: clone(e.pos), lastSeen: t, value: costValue(e.def.kind === 'resource' ? undefined : e.def.cost),
      worker, combat, light: e.tags.has('light') && !isAir(e), mech: e.tags.has('mech'), air: isAir(e), hitsAir: canHitAir(e),
      uv: ws.some((w) => w.damageType === 'uv'), antibiotic: ws.some((w) => w.damageType === 'antibiotic'),
    });
  }

  /** Recently seen enemy composition (cached per tick). */
  intel(window = 150): Intel {
    const tick = this.b.world.tick;
    if (this.intelCache && this.intelCache.tick === tick) return this.intelCache.v;
    const t = this.b.world.time;
    let total = 0, light = 0, mech = 0, air = 0, aa = 0, uv = 0, ab = 0, seen = 0;
    for (const u of this.units.values()) {
      if (!u.combat || t - u.lastSeen > window) continue;
      seen++;
      total += u.value;
      if (u.light) light += u.value;
      if (u.mech) mech += u.value;
      if (u.air) air += u.value;
      if (u.hitsAir) aa += u.value;
      if (u.uv) uv += u.value;
      if (u.antibiotic) ab += u.value;
    }
    let turrets = 0, walls = 0, turretValue = 0, turretAA = 0, turretUV = 0;
    for (const s of this.structures.values()) {
      if (s.armed) { turrets++; turretValue += s.value; if (s.hitsAir) turretAA += s.value; if (s.uv) turretUV += s.value; }
      if (s.wall) walls++;
    }
    const share = (x: number): number => (total > 0 ? x / total : 0);
    const all = total + turretValue;
    const v: Intel = {
      seen, armyValue: total, light: share(light), mech: share(mech), air: share(air),
      antiAir: all > 0 ? (aa + turretAA) / all : 0, uv: all > 0 ? (uv + turretUV) / all : 0, antibiotic: share(ab),
      turrets, walls,
    };
    this.intelCache = { tick, v };
    return v;
  }

  /** Value of enemy combat units seen within the last `window` seconds. */
  recentArmyValue(window = 90): number {
    const t = this.b.world.time;
    let v = 0;
    for (const u of this.units.values()) if (u.combat && t - u.lastSeen <= window) v += u.value;
    return v;
  }

  enemyUnitsNear(p: Vec2, r: number, window: number): number {
    const t = this.b.world.time;
    let n = 0;
    for (const u of this.units.values()) if (u.combat && t - u.lastSeen <= window && dist(u.pos, p) <= r) n++;
    return n;
  }

  structuresNear(p: Vec2, r: number): SeenStructure[] {
    const out: SeenStructure[] = [];
    for (const s of this.structures.values()) if (dist(s.pos, p) <= r + s.radius) out.push(s);
    return out;
  }

  armedNear(p: Vec2, r: number): number {
    let n = 0;
    for (const s of this.structures.values()) if (s.armed && dist(s.pos, p) <= r) n++;
    return n;
  }

  nearestStructure(from: Vec2, filter?: (s: SeenStructure) => boolean): SeenStructure | null {
    let best: SeenStructure | null = null, bd = Infinity;
    for (const s of this.structures.values()) {
      if (filter && !filter(s)) continue;
      const d = dist(s.pos, from);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
}
