/**
 * [input] Command-card model — a PURE function of (world, player, selection, menu state, hooks) that returns
 * the 3×5 grid of CommandButtons the HUD renders (`slot = row * 5 + col`). Headless-safe (no DOM / three.js),
 * unit-tested in tests/input. Buttons never touch the DOM: `activate()` calls back into `hooks`
 * (Controls implements them: issue commands, enter targeting / placement modes, open sub-menus, feedback).
 *
 * Slot conventions (stable — computed from data, never from what is currently visible):
 *   Units  row 0  0 Move M · 1 Stop S · 2 Hold H · 3 Patrol P · 4 Attack A      → ALL selected own units
 *   Workers row 1 5 Gather G · 6 Return C · 7 Repair R (hospital) · 8 Build B · 9 Advanced V
 *   Units  row 2  10–14 abilities of the active subgroup (data order; cooldown overlay, canCast)
 *   Build menus   0.. structures in the worker's `builds` order · 14 Back (Esc)
 *                 B = basic (HQ, capacity, power, defences, walls) · V = advanced (production / research / tier 2)
 *   Buildings     0–4 train (data order) · next free row: research chains (level 2 takes level 1's slot once
 *                 level 1 is done; researched upgrades disappear) · 10–12 building abilities ·
 *                 13 Set Rally (R, or Y if R is taken) · 14 Cancel (X): last queued item
 *   Foundations   14 Cancel construction (X)
 * Button ids / icon keys: cmd.move cmd.stop cmd.hold cmd.patrol cmd.attack cmd.gather cmd.return cmd.repair
 *   cmd.rally cmd.cancel · menu.build menu.advanced menu.back · train.<unitId> research.<upgradeId>
 *   build.<buildingId> ability.<abilityId>  (icon = the def/upgrade/ability id for the last four, else the id).
 * Fields: `tooltip` is BODY text only (description / details); label, hotkey, cost (+pop), time and
 *   disabledReason ("Requires Research Lab", "Not enough Supplies", ...) are separate fields. `cooldown` is the
 *   remaining fraction 0..1, `active` marks the armed targeting/placement button or research in progress.
 *   Disabled buttons still have a safe activate(): it emits the matching 'notEnough' feedback instead.
 */
import { MAX_POP } from '../config';
import type {
  AbilityDef, BuildingDef, Command, Cost, Entity, EntityId, NotEnoughKind, PlayerId, ProductionItem, UnitDef, UpgradeDef,
} from '../core/types';
import type { CommandButton } from '../game/contracts';
import type { World } from '../sim/World';
import { ABILITY_DEFS, BUILDING_DEFS, FACTIONS, UNIT_DEFS, UPGRADE_DEFS, buildingsOfFaction, type FactionInfo } from '../data';
import { orderSubgroups } from './subgroups';

// ───────────────────────── public types ─────────────────────────
export type CardMenu = 'root' | 'build' | 'advanced';

export interface CardMenuState {
  menu: CardMenu;
  /** defId of the active subgroup (Tab). Missing / not in the selection → highest-priority subgroup. */
  subgroup?: string | null;
  /** id of the button whose targeting / placement mode is currently active (rendered with active=true). */
  activeButtonId?: string | null;
}

export type TargetKind = 'attack' | 'move' | 'patrol' | 'gather' | 'repair' | 'ability' | 'rally' | 'buildingAbility';

/** A "click the map next" request produced by a card button. */
export interface TargetingRequest {
  kind: TargetKind;
  buttonId: string;
  /** units that receive the order (unit kinds) */
  unitIds: EntityId[];
  /** buildings that receive the order (rally / buildingAbility) */
  buildingIds: EntityId[];
  abilityId?: string;
  /** 'point': ground or entity is fine · 'unit': a valid entity must be under the cursor */
  target: 'point' | 'unit';
}

export interface CardHooks {
  /** Issue a command for the local player (Controls adds `queue` while Shift is held). */
  issue(cmd: Command): void;
  beginTargeting(req: TargetingRequest): void;
  beginPlacement(defId: string, builderIds: EntityId[], buttonId: string): void;
  openMenu(menu: CardMenu): void;
  /** Instant negative feedback ("Not enough Supplies", "Requires Pharmacy", ...). */
  feedback(kind: NotEnoughKind, message: string): void;
  /** Train commands issued but not processed yet for a building (spreads rapid clicks over producers). */
  queued?(buildingId: EntityId): number;
}

export const SLOTS = {
  move: 0, stop: 1, hold: 2, patrol: 3, attack: 4,
  gather: 5, returnCargo: 6, repair: 7, build: 8, advanced: 9,
  unitAbilities: 10, buildingAbilities: 10, rally: 13, cancel: 14, back: 14,
} as const;

export const CARD_SLOTS = 15;

// ───────────────────────── entry point ─────────────────────────
let lastError = '';

/**
 * Build the command card for `selectionIds` (any order; dead / foreign ids are ignored).
 * Returns buttons sorted by slot. Never throws.
 */
export function buildCommandCard(world: World, playerId: PlayerId, selectionIds: readonly EntityId[], menuState: CardMenuState, hooks: CardHooks): CommandButton[] {
  try {
    return buildCard(world, playerId, selectionIds, menuState, hooks).sort((a, b) => a.slot - b.slot);
  } catch (err) {
    const msg = String(err);
    if (msg !== lastError) { lastError = msg; console.error('[input] command card failed', err); }
    return [];
  }
}

/** First button whose hotkey matches a normalised key ('A', 'Esc', ...). */
export function findByHotkey(card: readonly CommandButton[], key: string): CommandButton | undefined {
  const k = key.toUpperCase();
  return card.find((b) => b.hotkey !== '' && b.hotkey.toUpperCase() === k);
}

/** Display name of a unit / building / upgrade / ability id. */
export function defName(id: string): string {
  return UNIT_DEFS[id]?.name ?? BUILDING_DEFS[id]?.name ?? UPGRADE_DEFS[id]?.name ?? ABILITY_DEFS[id]?.name ?? id;
}

/** Advanced build menu (V): production / research / tier-2 structures. Everything else is basic (B). */
export function isAdvancedStructure(def: BuildingDef): boolean {
  return !def.hq && (def.trains.length > 0 || def.researches.length > 0);
}

/** Structures listed in a worker's basic (`build`) or advanced menu, in data order. */
export function buildMenuList(worker: UnitDef, menu: 'build' | 'advanced'): string[] {
  return (worker.builds ?? []).filter((id) => {
    const d = BUILDING_DEFS[id];
    return !!d && d.buildable !== false && (menu === 'advanced') === isAdvancedStructure(d);
  });
}

/** Group a building's researches into linear chains (level 2 requires level 1 → same slot). */
export function researchChains(researches: readonly string[]): string[][] {
  const chains: string[][] = [];
  const chainOf = new Map<string, string[]>();
  for (const id of researches) {
    const u = UPGRADE_DEFS[id];
    if (!u) continue;
    const prev = u.requires.find((r) => { const c = chainOf.get(r); return !!c && c[c.length - 1] === r; });
    if (prev) { const c = chainOf.get(prev)!; c.push(id); chainOf.set(id, c); continue; }
    const c = [id];
    chains.push(c);
    chainOf.set(id, c);
  }
  return chains;
}

// ───────────────────────── internals ─────────────────────────
interface Ctx {
  world: World;
  playerId: PlayerId;
  f: FactionInfo;
  hooks: CardHooks;
  state: CardMenuState;
}
interface Block { kind: NotEnoughKind; message: string }
type Check = { ok: boolean; reason?: string };

function buildCard(world: World, playerId: PlayerId, selectionIds: readonly EntityId[], state: CardMenuState, hooks: CardHooks): CommandButton[] {
  const player = world.players.get(playerId);
  if (!player || player.defeated) return [];
  const own: Entity[] = [];
  for (const id of selectionIds) { const e = world.getAlive(id); if (e && e.owner === playerId && !own.includes(e)) own.push(e); }
  if (own.length === 0) return [];
  const groups = orderSubgroups(own);
  const activeDef = groups.find((g) => g.defId === state.subgroup)?.defId ?? groups[0]!.defId;
  const sub = own.filter((e) => e.defId === activeDef);
  const ctx: Ctx = { world, playerId, f: FACTIONS[player.faction] ?? FACTIONS.neutral, hooks, state };
  const lead = sub[0]!;
  if (lead.kind === 'unit') {
    const def = lead.def as UnitDef;
    if ((state.menu === 'build' || state.menu === 'advanced') && buildMenuList(def, state.menu).length > 0) {
      return buildMenuCard(ctx, own.filter((e) => e.kind === 'unit'), def, state.menu);
    }
    return unitCard(ctx, own.filter((e) => e.kind === 'unit'), sub);
  }
  if (lead.kind === 'building') return buildingCard(ctx, sub);
  return [];
}

// ── small helpers ──
const liveOwn = (ctx: Ctx, ids: readonly EntityId[]): Entity[] => {
  const out: Entity[] = [];
  for (const id of ids) { const e = ctx.world.getAlive(id); if (e && e.owner === ctx.playerId) out.push(e); }
  return out;
};
const idsOf = (es: readonly Entity[]): EntityId[] => es.map((e) => e.id);
/**
 * Tooltip BODY: complete sentences joined with '\n' (also reads fine when collapsed to one paragraph). The HUD
 * renders label + hotkey, role, cost / time / pop and disabledReason from the structured fields, so those are
 * not repeated here.
 */
const tip = (...lines: Array<string | null | undefined | false>): string => lines.filter((l): l is string => !!l).join('\n');

function safeCheck(fn: () => Check | undefined | null): Check {
  try { return fn() ?? { ok: false, reason: 'Unavailable' }; } catch { return { ok: false, reason: 'Unavailable' }; }
}

function listNames(ids: readonly string[]): string {
  const names = ids.map(defName);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function requirementBlock(ctx: Ctx, requires: readonly string[]): Block | null {
  if (requires.length === 0) return null;
  let missing: string[] = [];
  try { missing = ctx.world.economy.missingRequirements(ctx.playerId, [...requires]) ?? []; } catch { missing = []; }
  return missing.length ? { kind: 'requirement', message: `Requires ${listNames(missing)}` } : null;
}

function costBlock(ctx: Ctx, cost: Cost): Block | null {
  const can = (c: Cost): boolean => { try { return ctx.world.economy.canAfford(ctx.playerId, c); } catch { return true; } };
  if ((cost.matter ?? 0) > 0 && !can({ matter: cost.matter })) return { kind: 'matter', message: `Not enough ${ctx.f.resourceNames.matter}` };
  if ((cost.energy ?? 0) > 0 && !can({ energy: cost.energy })) return { kind: 'energy', message: `Not enough ${ctx.f.resourceNames.energy}` };
  return null;
}

function popBlock(ctx: Ctx, pop: number): Block | null {
  const p = ctx.world.players.get(ctx.playerId);
  if (!p || pop <= 0 || p.popUsed + pop <= p.popCap) return null;
  if (p.popCap >= MAX_POP) return { kind: 'pop', message: `${ctx.f.popName} limit reached` };
  const popBuilding = buildingsOfFaction(p.faction).find((b) => !b.hq && (b.provides.pop ?? 0) > 0 && b.buildable !== false);
  return { kind: 'pop', message: `Not enough ${ctx.f.popName}${popBuilding ? ` — build a ${popBuilding.name}` : ''}` };
}

const queueOf = (b: Entity): ProductionItem[] => b.production?.queue ?? [];
const queueFull = (b: Entity): boolean => !!b.production && b.production.queue.length >= b.production.maxQueue;

function button(ctx: Ctx, b: Omit<CommandButton, 'active'> & { active?: boolean }): CommandButton {
  return { ...b, active: b.active || ctx.state.activeButtonId === b.id };
}

/** Kind for a free-text disabled reason we did not compute ourselves. */
function kindFromReason(reason: string | undefined): NotEnoughKind {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('queue')) return 'queueFull';
  if (r.includes('cooldown') || r.includes('cooling')) return 'cooldown';
  if (r.includes('capacity') || r.includes('pop') || r.includes('bed') || r.includes('colony')) return 'pop';
  if (r.includes('energy') || r.includes('power') || r.includes('toxin')) return 'energy';
  if (r.includes('matter') || r.includes('suppl') || r.includes('biomass') || r.includes('resource')) return 'matter';
  if (r.includes('target') || r.includes('range')) return 'invalidTarget';
  return 'requirement';
}

// ───────────────────────── units ─────────────────────────
function unitCard(ctx: Ctx, units: Entity[], sub: Entity[]): CommandButton[] {
  const { hooks, playerId } = ctx;
  const out: CommandButton[] = [];
  const allIds = idsOf(units);
  const live = (): EntityId[] => idsOf(liveOwn(ctx, allIds).filter((e) => e.kind === 'unit'));
  const target = (kind: TargetKind, buttonId: string, ids: () => EntityId[], t: 'point' | 'unit' = 'point') => () => {
    const unitIds = ids();
    if (unitIds.length) hooks.beginTargeting({ kind, buttonId, unitIds, buildingIds: [], target: t });
  };

  out.push(button(ctx, {
    id: 'cmd.move', label: 'Move', hotkey: 'M', icon: 'cmd.move', slot: SLOTS.move, enabled: true,
    tooltip: tip('Move to the target point. Target a unit to follow it.', 'Shift-click to queue.'),
    activate: target('move', 'cmd.move', live),
  }));
  out.push(button(ctx, {
    id: 'cmd.stop', label: 'Stop', hotkey: 'S', icon: 'cmd.stop', slot: SLOTS.stop, enabled: true,
    tooltip: tip('Cancel all orders.'),
    activate: () => { const unitIds = live(); if (unitIds.length) hooks.issue({ type: 'stop', playerId, unitIds }); },
  }));
  out.push(button(ctx, {
    id: 'cmd.hold', label: 'Hold Position', hotkey: 'H', icon: 'cmd.hold', slot: SLOTS.hold, enabled: true,
    tooltip: tip('Stay in place and attack enemies in range without chasing them.'),
    activate: () => { const unitIds = live(); if (unitIds.length) hooks.issue({ type: 'hold', playerId, unitIds }); },
  }));
  out.push(button(ctx, {
    id: 'cmd.patrol', label: 'Patrol', hotkey: 'P', icon: 'cmd.patrol', slot: SLOTS.patrol, enabled: true,
    tooltip: tip('Patrol between the current position and the target point, engaging enemies on the way.', 'Shift-click to queue.'),
    activate: target('patrol', 'cmd.patrol', live),
  }));
  if (units.some((u) => !!u.combat || !!(u.def as UnitDef).heal)) {
    out.push(button(ctx, {
      id: 'cmd.attack', label: 'Attack', hotkey: 'A', icon: 'cmd.attack', slot: SLOTS.attack, enabled: true,
      tooltip: tip('Attack-move to the target point, engaging every enemy on the way. Target an enemy to attack it.', 'Shift-click to queue.'),
      activate: target('attack', 'cmd.attack', () => idsOf(liveOwn(ctx, allIds).filter((e) => e.kind === 'unit' && (!!e.combat || !!(e.def as UnitDef).heal)))),
    }));
  }

  const lead = sub[0]!;
  const leadDef = lead.def as UnitDef;
  if (leadDef.gather) {
    const workerIds = idsOf(units.filter((u) => !!u.gatherer));
    const liveWorkers = (): EntityId[] => idsOf(liveOwn(ctx, workerIds).filter((e) => !!e.gatherer));
    const res = ctx.f.resourceNames.matter;
    const dropoff = BUILDING_DEFS[ctx.f.hq]?.name ?? 'a drop-off';
    out.push(button(ctx, {
      id: 'cmd.gather', label: 'Gather', hotkey: 'G', icon: 'cmd.gather', slot: SLOTS.gather, enabled: true,
      tooltip: tip(`Harvest ${res} from a Supply Cache and haul it to the nearest ${dropoff}.`),
      activate: target('gather', 'cmd.gather', liveWorkers, 'unit'),
    }));
    const carrying = units.some((u) => (u.gatherer?.carrying ?? 0) > 0);
    out.push(button(ctx, {
      id: 'cmd.return', label: 'Return Cargo', hotkey: 'C', icon: 'cmd.return', slot: SLOTS.returnCargo, enabled: carrying,
      disabledReason: carrying ? undefined : `Not carrying ${res}`,
      tooltip: tip(`Deliver carried ${res} to the nearest ${dropoff}.`),
      activate: () => {
        const unitIds = idsOf(liveOwn(ctx, workerIds).filter((e) => (e.gatherer?.carrying ?? 0) > 0));
        if (unitIds.length) hooks.issue({ type: 'returnCargo', playerId, unitIds });
        else hooks.feedback('invalidTarget', `Not carrying ${res}`);
      },
    }));
    if (leadDef.faction === 'hospital') {
      out.push(button(ctx, {
        id: 'cmd.repair', label: 'Repair', hotkey: 'R', icon: 'cmd.repair', slot: SLOTS.repair, enabled: true,
        tooltip: tip('Repair a damaged friendly structure or mechanical unit.'),
        activate: target('repair', 'cmd.repair', liveWorkers, 'unit'),
      }));
    }
    if (buildMenuList(leadDef, 'build').length) {
      out.push(button(ctx, {
        id: 'menu.build', label: 'Build', hotkey: 'B', icon: 'menu.build', slot: SLOTS.build, enabled: true,
        tooltip: tip(`Basic structures: ${buildMenuList(leadDef, 'build').map(defName).join(', ')}.`),
        activate: () => hooks.openMenu('build'),
      }));
    }
    if (buildMenuList(leadDef, 'advanced').length) {
      out.push(button(ctx, {
        id: 'menu.advanced', label: 'Advanced Build', hotkey: 'V', icon: 'menu.advanced', slot: SLOTS.advanced, enabled: true,
        tooltip: tip(`Production, research and advanced structures: ${buildMenuList(leadDef, 'advanced').map(defName).join(', ')}.`),
        activate: () => hooks.openMenu('advanced'),
      }));
    }
  }

  // abilities of the active subgroup (row 2)
  const used = new Set(out.map((b) => b.slot));
  let next = SLOTS.unitAbilities;
  for (const abilityId of leadDef.abilities) {
    while (used.has(next) && next < CARD_SLOTS) next++;
    if (next >= CARD_SLOTS) break;
    const b = abilityButton(ctx, sub, abilityId, next, false);
    if (b) { out.push(b); used.add(next); next++; }
  }
  return out;
}

function buildMenuCard(ctx: Ctx, units: Entity[], workerDef: UnitDef, menu: 'build' | 'advanced'): CommandButton[] {
  const { hooks } = ctx;
  const out: CommandButton[] = [];
  const list = buildMenuList(workerDef, menu);
  let slot = 0;
  for (const bId of list) {
    if (slot === SLOTS.back) slot++;
    if (slot >= CARD_SLOTS) break;
    const def = BUILDING_DEFS[bId]!;
    const builderIds = idsOf(units.filter((u) => (u.def as UnitDef).builds?.includes(bId)));
    const block = requirementBlock(ctx, def.requires) ?? costBlock(ctx, def.cost);
    const id = `build.${bId}`;
    out.push(button(ctx, {
      id, label: def.name, hotkey: def.hotkey, icon: bId, slot, enabled: !block,
      disabledReason: block?.message, cost: { ...def.cost }, time: def.buildTime,
      tooltip: tip(def.description),
      activate: () => {
        const now = requirementBlock(ctx, def.requires) ?? costBlock(ctx, def.cost);
        if (now) { hooks.feedback(now.kind, now.message); return; }
        const live = idsOf(liveOwn(ctx, builderIds));
        if (live.length) hooks.beginPlacement(bId, live, id);
      },
    }));
    slot++;
  }
  out.push(button(ctx, {
    id: 'menu.back', label: 'Back', hotkey: 'Esc', icon: 'menu.back', slot: SLOTS.back, enabled: true,
    tooltip: tip('Return to the worker commands.'),
    activate: () => hooks.openMenu('root'),
  }));
  return out;
}

// ───────────────────────── abilities ─────────────────────────
function abilityButton(ctx: Ctx, casters: Entity[], abilityId: string, slot: number, fromBuilding: boolean): CommandButton | null {
  const a: AbilityDef | undefined = ABILITY_DEFS[abilityId];
  if (!a) return null;
  const id = `ability.${abilityId}`;
  const base = { id, label: a.name, hotkey: a.hotkey, icon: abilityId, slot };
  const targetType = a.target;
  if (targetType === 'passive') {
    return button(ctx, { ...base, enabled: false, disabledReason: 'Passive ability (always active)', tooltip: tip(a.description), activate: () => {} });
  }
  const casterIds = idsOf(casters);
  let minCd = Infinity;
  for (const c of casters) minCd = Math.min(minCd, c.cooldowns[abilityId] ?? 0);
  if (!Number.isFinite(minCd)) minCd = 0;
  const cooldown = a.cooldown > 0 && minCd > 0 ? Math.min(1, minCd / a.cooldown) : 0;
  /**
   * Readiness, independent of where the player will aim: construction / cooldown / cost first, then the
   * ability service — probed at the caster's own position for point abilities (always valid & in range).
   * Unit-target validity depends on the target, so it is checked by the order when the player clicks.
   */
  const ready = (c: Entity): Check => {
    if (c.construction) return { ok: false, reason: 'Under construction' };
    if ((c.cooldowns[abilityId] ?? 0) > 0) return { ok: false, reason: `${a.name} is not ready yet` };
    const cb = a.cost ? costBlock(ctx, a.cost) : null;
    if (cb) return { ok: false, reason: cb.message };
    if (targetType === 'unit') return { ok: true };
    return safeCheck(() => ctx.world.abilities.canCast(c, abilityId, targetType === 'point' ? { x: c.pos.x, y: c.pos.y } : undefined));
  };
  const checks = casters.map(ready);
  const ok = checks.some((r) => r.ok);
  const reason = ok ? undefined : checks.find((r) => r.reason)?.reason ?? (minCd > 0 ? `${a.name} is not ready yet` : 'Cannot use now');
  const details = [
    a.range ? `Range ${a.range}` : null,
    a.radius && a.target !== 'none' ? `radius ${a.radius}` : null,
    a.cooldown ? `cooldown ${a.cooldown} s` : null,
  ].filter(Boolean).join(' · ');
  return button(ctx, {
    ...base, enabled: ok, disabledReason: reason, cooldown, cost: a.cost ? { ...a.cost } : undefined,
    tooltip: tip(a.description, details ? `${details[0]!.toUpperCase()}${details.slice(1)}.` : null, minCd > 0 && `Ready in ${Math.ceil(minCd)} s.`),
    activate: () => {
      const live = liveOwn(ctx, casterIds).filter((c) => !c.construction);
      const readyNow = live.filter((c) => ready(c).ok);
      if (readyNow.length === 0) {
        const cd = live.length ? Math.min(...live.map((c) => c.cooldowns[abilityId] ?? 0)) : 0;
        const cb = a.cost ? costBlock(ctx, a.cost) : null;
        if (cb) ctx.hooks.feedback(cb.kind, cb.message);
        else if (cd > 0) ctx.hooks.feedback('cooldown', `${a.name} is not ready yet`);
        else { const r = live.map(ready).find((x) => x.reason)?.reason ?? reason; ctx.hooks.feedback(kindFromReason(r), r ?? `${a.name} is unavailable`); }
        return;
      }
      if (targetType === 'none') {
        if (fromBuilding) ctx.hooks.issue({ type: 'buildingAbility', playerId: ctx.playerId, buildingId: readyNow[0]!.id, abilityId });
        else ctx.hooks.issue({ type: 'ability', playerId: ctx.playerId, unitIds: idsOf(readyNow), abilityId });
        return;
      }
      ctx.hooks.beginTargeting({
        kind: fromBuilding ? 'buildingAbility' : 'ability', buttonId: id, abilityId, target: targetType,
        unitIds: fromBuilding ? [] : idsOf(live), buildingIds: fromBuilding ? idsOf(readyNow) : [],
      });
    },
  });
}

// ───────────────────────── buildings ─────────────────────────
interface BuildingLayout {
  train: Array<{ unitId: string; slot: number }>;
  research: Array<{ chain: string[]; slot: number }>;
  abilities: Array<{ abilityId: string; slot: number }>;
  rally: { slot: number; hotkey: string } | null;
  cancel: number;
}
const layoutCache = new Map<string, BuildingLayout>();

/** Static (data-only) slot layout of a building's card — identical every frame. */
export function buildingLayout(def: BuildingDef): BuildingLayout {
  const cached = layoutCache.get(def.id);
  if (cached) return cached;
  const used = new Set<number>([SLOTS.cancel]);
  const take = (preferred: number): number | null => {
    for (let s = preferred; s < CARD_SLOTS; s++) if (!used.has(s)) { used.add(s); return s; }
    for (let s = 0; s < preferred; s++) if (!used.has(s)) { used.add(s); return s; }
    return null;
  };
  const trainable = def.trains.filter((u) => UNIT_DEFS[u] && UNIT_DEFS[u]!.trainable !== false);
  if (trainable.length) used.add(SLOTS.rally);
  const layout: BuildingLayout = { train: [], research: [], abilities: [], rally: null, cancel: SLOTS.cancel };
  trainable.forEach((unitId, i) => { const s = take(i); if (s !== null) layout.train.push({ unitId, slot: s }); });
  const rStart = trainable.length === 0 ? 0 : Math.ceil(trainable.length / 5) * 5;
  researchChains(def.researches).forEach((chain, i) => { const s = take(rStart + i); if (s !== null) layout.research.push({ chain, slot: s }); });
  def.abilities.forEach((abilityId, i) => { const s = take(SLOTS.buildingAbilities + i); if (s !== null) layout.abilities.push({ abilityId, slot: s }); });
  if (trainable.length) {
    const keys = new Set<string>([
      ...trainable.map((u) => UNIT_DEFS[u]!.hotkey.toUpperCase()),
      ...def.researches.map((r) => UPGRADE_DEFS[r]?.hotkey.toUpperCase() ?? ''),
      ...def.abilities.map((a) => ABILITY_DEFS[a]?.hotkey.toUpperCase() ?? ''),
    ]);
    layout.rally = { slot: SLOTS.rally, hotkey: !keys.has('R') ? 'R' : !keys.has('Y') ? 'Y' : '' };
  }
  layoutCache.set(def.id, layout);
  return layout;
}

function buildingCard(ctx: Ctx, sub: Entity[]): CommandButton[] {
  const { hooks, playerId } = ctx;
  const complete = sub.filter((b) => !b.construction);
  if (complete.length === 0) {
    // every selected building of this type is a foundation → cancel construction only
    const ids = idsOf(sub);
    return [button(ctx, {
      id: 'cmd.cancel', label: 'Cancel Construction', hotkey: 'X', icon: 'cmd.cancel', slot: SLOTS.cancel, enabled: true,
      tooltip: tip('Abandon the construction site. 75% of the cost is refunded.'),
      activate: () => {
        for (const b of liveOwn(ctx, ids)) if (b.construction) hooks.issue({ type: 'cancelConstruction', playerId, buildingId: b.id });
      },
    })];
  }
  const def = complete[0]!.def as BuildingDef;
  const layout = buildingLayout(def);
  const ids = idsOf(complete);
  const out: CommandButton[] = [];
  const pending = (b: Entity): number => { try { return hooks.queued?.(b.id) ?? 0; } catch { return 0; } };
  const byQueue = (bs: Entity[]): Entity[] => [...bs].sort((a, b) => (queueOf(a).length + pending(a)) - (queueOf(b).length + pending(b)));

  for (const { unitId, slot } of layout.train) out.push(trainButton(ctx, complete, ids, unitId, slot, byQueue));

  const player = ctx.world.player(playerId);
  for (const { chain, slot } of layout.research) {
    const upgradeId = chain.find((u) => !player.upgrades.has(u));
    if (!upgradeId) continue; // whole chain researched → hidden (slot stays empty)
    out.push(researchButton(ctx, complete, ids, UPGRADE_DEFS[upgradeId]!, slot, byQueue));
  }

  for (const { abilityId, slot } of layout.abilities) {
    const b = abilityButton(ctx, complete, abilityId, slot, true);
    if (b) out.push(b);
  }

  if (layout.rally) {
    const hk = layout.rally.hotkey;
    const rallied = complete.find((b) => b.rally);
    out.push(button(ctx, {
      id: 'cmd.rally', label: 'Set Rally Point', hotkey: hk, icon: 'cmd.rally', slot: layout.rally.slot, enabled: true,
      tooltip: tip('Newly trained units move to the rally point. Target a Supply Cache to send new workers straight to work.', rallied ? 'Tip: right-click the map with this building selected.' : null),
      activate: () => {
        const buildingIds = idsOf(liveOwn(ctx, ids));
        if (buildingIds.length) hooks.beginTargeting({ kind: 'rally', buttonId: 'cmd.rally', unitIds: [], buildingIds, target: 'point' });
      },
    }));
  }

  if (complete.some((b) => queueOf(b).length > 0)) {
    out.push(button(ctx, {
      id: 'cmd.cancel', label: 'Cancel', hotkey: 'X', icon: 'cmd.cancel', slot: layout.cancel, enabled: true,
      tooltip: tip('Cancel the last item in the production queue (full refund).'),
      activate: () => {
        let best: Entity | null = null;
        for (const b of liveOwn(ctx, ids)) if (queueOf(b).length > (best ? queueOf(best).length : 0)) best = b;
        if (!best) return;
        const q = queueOf(best);
        const last = q[q.length - 1]!;
        if (last.kind === 'upgrade') hooks.issue({ type: 'cancelResearch', playerId, buildingId: best.id });
        else hooks.issue({ type: 'cancelTrain', playerId, buildingId: best.id, index: q.length - 1 });
      },
    }));
  }
  return out;
}

/** Why a building can't train a unit, in player terms (null = no reason found). */
function explainTrain(ctx: Ctx, b: Entity, u: UnitDef): Block | null {
  if (b.construction) return { kind: 'requirement', message: 'Under construction' };
  return requirementBlock(ctx, u.requires)
    ?? (queueFull(b) ? { kind: 'queueFull', message: 'Production queue is full' } : null)
    ?? popBlock(ctx, u.pop)
    ?? costBlock(ctx, u.cost);
}

function trainButton(ctx: Ctx, buildings: Entity[], ids: EntityId[], unitId: string, slot: number, byQueue: (bs: Entity[]) => Entity[]): CommandButton {
  const u = UNIT_DEFS[unitId]!;
  const evaluate = (bs: Entity[]): { best: Entity | null; block: Block | null } => {
    const ranked = byQueue(bs);
    let firstReason: string | undefined;
    for (const b of ranked) {
      const r = safeCheck(() => ctx.world.economy.canTrain(b, unitId));
      if (r.ok) return { best: b, block: null };
      firstReason ??= r.reason;
    }
    const lead = ranked[0];
    const block = (lead && explainTrain(ctx, lead, u)) ?? { kind: kindFromReason(firstReason), message: firstReason ?? 'Cannot train now' };
    return { best: null, block };
  };
  const { block } = evaluate(buildings);
  const id = `train.${unitId}`;
  return button(ctx, {
    id, label: u.name, hotkey: u.hotkey, icon: unitId, slot, enabled: !block,
    disabledReason: block?.message, cost: { ...u.cost, pop: u.pop }, time: u.buildTime,
    tooltip: tip(u.description),
    activate: () => {
      const { best, block: now } = evaluate(liveOwn(ctx, ids).filter((b) => !b.construction));
      if (!best) { if (now) ctx.hooks.feedback(now.kind, now.message); return; }
      ctx.hooks.issue({ type: 'train', playerId: ctx.playerId, buildingId: best.id, defId: unitId });
    },
  });
}

function explainResearch(ctx: Ctx, b: Entity, u: UpgradeDef): Block | null {
  if (b.construction) return { kind: 'requirement', message: 'Under construction' };
  return requirementBlock(ctx, u.requires)
    ?? (queueFull(b) ? { kind: 'queueFull', message: 'Production queue is full' } : null)
    ?? costBlock(ctx, u.cost);
}

function researchButton(ctx: Ctx, buildings: Entity[], ids: EntityId[], u: UpgradeDef, slot: number, byQueue: (bs: Entity[]) => Entity[]): CommandButton {
  const player = ctx.world.player(ctx.playerId);
  const id = `research.${u.id}`;
  const base = { id, label: u.name, hotkey: u.hotkey, icon: u.id, slot, cost: { ...u.cost }, time: u.researchTime };
  if (player.researching.has(u.id)) {
    const here = buildings.some((b) => queueOf(b).some((it) => it.kind === 'upgrade' && it.defId === u.id));
    return button(ctx, {
      ...base, enabled: false, active: true, disabledReason: 'Research in progress',
      tooltip: tip(u.description, here ? null : 'Being researched at another building.'),
      activate: () => {},
    });
  }
  const evaluate = (bs: Entity[]): { best: Entity | null; block: Block | null } => {
    const ranked = byQueue(bs);
    let firstReason: string | undefined;
    for (const b of ranked) {
      const r = safeCheck(() => ctx.world.economy.canResearch(b, u.id));
      if (r.ok) return { best: b, block: null };
      firstReason ??= r.reason;
    }
    const lead = ranked[0];
    const block = (lead && explainResearch(ctx, lead, u)) ?? { kind: kindFromReason(firstReason), message: firstReason ?? 'Cannot research now' };
    return { best: null, block };
  };
  const { block } = evaluate(buildings);
  return button(ctx, {
    ...base, enabled: !block, disabledReason: block?.message,
    tooltip: tip(u.description),
    activate: () => {
      if (ctx.world.player(ctx.playerId).researching.has(u.id)) return;
      const { best, block: now } = evaluate(liveOwn(ctx, ids).filter((b) => !b.construction));
      if (!best) { if (now) ctx.hooks.feedback(now.kind, now.message); return; }
      ctx.hooks.issue({ type: 'research', playerId: ctx.playerId, buildingId: best.id, upgradeId: u.id });
    },
  });
}
