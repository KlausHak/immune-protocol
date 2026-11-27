/**
 * [input] OWNER: controls agent. Mouse/keyboard → selection & commands. Builds the command card model
 * (CommandButton[]) the HUD renders. Camera movement keys (arrows/edge/wheel) belong to the render-core camera.
 *
 * Mouse  · left click select (own preferred; enemies/neutrals are inspected) · drag box (own units > own
 *          buildings > one enemy) · Shift add/toggle · Ctrl-click / double-click = all of that type on screen
 *        · right click = smart command (or rally for selected producers) · Shift queues
 * Modes  · targeting (A/M/P/R/G, targeted abilities, rally): next left click issues, right click / Esc cancels,
 *          Shift keeps the mode · placing (worker B/V menus): ghost snapped with footprintTileAt, validity via
 *          economy.canPlaceBuilding, left click builds, Shift keeps placing
 * Keys   · card hotkeys · Ctrl/Shift/plain 0–9 control groups (double-tap centres) · F1 idle worker (Ctrl: all)
 *        · Backspace bases · Space last alert · Tab / Shift+Tab subgroups · Esc cancel → back → pause menu
 *        · F10 pause menu · + / − game speed (skirmish)
 * Keyboard events already handled by someone else (`defaultPrevented`) are ignored.
 */
import { clone, dist } from '../core/math';
import { footprintCenter, footprintTileAt } from '../core/terrain';
import type { BuildingDef, Command, Entity, EntityId, NotEnoughKind, TilePos, Vec2 } from '../core/types';
import { ABILITY_DEFS, BUILDING_DEFS, FACTIONS, RESOURCE_DEFS, SUPPLY_CACHE_ID } from '../data';
import type { CommandButton, ControlMode, GameContext } from '../game/contracts';
import type { CommandMarkerKind } from '../render/core/GameRenderer';
import { buildCommandCard, findByHotkey, type CardHooks, type CardMenu, type TargetingRequest } from './commandCard';
import { ControlGroups } from './controlGroups';
import { CURSORS, type CursorKind } from './cursors';
import { groupDigit, isSpeedDownKey, isSpeedUpKey, normalizeKey, stepSpeed } from './keys';
import { Selection } from './Selection';
import { SelectionBox } from './SelectionBox';

export type { CardMenu, TargetingRequest } from './commandCard';

/** Pixels a left press must travel before it becomes a box drag. */
const DRAG_THRESHOLD = 5;
/** Seconds between two clicks on the same type to count as a double-click. */
const DOUBLE_CLICK = 0.3;
const MAX_ALERTS = 6;

export interface PlacementState {
  defId: string;
  builderIds: EntityId[];
  buttonId: string;
  /** last ghost tile under the cursor (null when hidden) */
  tile: TilePos | null;
  valid: boolean;
  reason?: string;
}

interface DragState { x0: number; y0: number; x1: number; y1: number; shift: boolean; ctrl: boolean; active: boolean }
type Check = { ok: boolean; reason?: string };

export class Controls {
  readonly selection: Selection;
  mode: ControlMode = 'normal';
  /** Command-card sub-menu (worker build menus). */
  menu: CardMenu = 'root';
  /** Active "click the map" request while mode === 'targeting'. */
  targeting: TargetingRequest | null = null;
  /** Active building placement while mode === 'placing'. */
  placement: PlacementState | null = null;
  readonly groups: ControlGroups;

  private readonly canvas: HTMLCanvasElement;
  private readonly box: SelectionBox;
  private readonly hooks: CardHooks;
  private mouse = { x: 0, y: 0, inside: false };
  private drag: DragState | null = null;
  /** swallow the mouseup that follows a mousedown consumed by targeting / placement */
  private swallowUp = false;
  private hoverId: EntityId | null = null;
  private cursor: CursorKind | null = null;
  private ghostKey = '';
  private lastClick: { t: number; defId: string; x: number; y: number } | null = null;
  private shiftDown = false;
  /** the current mode survived a Shift+click: releasing Shift ends it (SC2-style queued orders / placements) */
  private keptByShift = false;
  private alerts: Vec2[] = [];
  private alertIdx = 0;
  private idleCursor = -1;
  private baseCursor = -1;
  private pendingTick = -1;
  private pendingTrains = new Map<EntityId, number>();
  private pendingBuilds: Array<{ defId: string; tile: TilePos }> = [];
  private cardCache: { key: string; card: CommandButton[] } | null = null;
  private stateVersion = 0;
  private unsub: Array<() => void> = [];
  private disposed = false;
  private errors = 0;

  constructor(private readonly game: GameContext) {
    this.canvas = game.renderer.three.domElement;
    const local = game.localPlayerId;
    this.selection = new Selection(game.world, local, { setSelection: (ids) => this.game.renderer.setSelection(ids) });
    this.groups = new ControlGroups(game.world, local);
    this.box = new SelectionBox(this.canvas, game.world.players.get(local)?.faction);
    this.hooks = {
      issue: (cmd) => this.issue(cmd, true),
      beginTargeting: (req) => this.beginTargeting(req),
      beginPlacement: (defId, builderIds, buttonId) => this.beginPlacement(defId, builderIds, buttonId),
      openMenu: (m) => this.setMenu(m),
      feedback: (kind, message) => this.feedback(kind, message),
      queued: (id) => { this.syncPending(); return this.pendingTrains.get(id) ?? 0; },
    };

    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.addEventListener('mouseleave', this.onMouseLeave);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    this.unsub.push(
      game.world.events.on('underAttack', ({ playerId, pos }) => {
        if (playerId !== local) return;
        this.alerts.unshift({ x: pos.x, y: pos.y });
        if (this.alerts.length > MAX_ALERTS) this.alerts.length = MAX_ALERTS;
        this.alertIdx = 0;
      }),
      game.world.events.on('gameOver', () => this.cancelInteraction()),
      this.selection.onChangeReason((reason) => {
        this.bump();
        if (reason === 'prune') return; // modes are re-validated in update()
        this.cancelMode();
        this.menu = 'root';
      }),
    );
    this.setCursor('default');
  }

  // ───────────────────────── public API ─────────────────────────
  /** Current command card (cached per sim tick + controls state). Safe to call every frame. */
  getCommandCard(): CommandButton[] {
    if (this.disposed) return [];
    const w = this.game.world;
    const key = `${w.tick}|${this.selection.version}|${this.stateVersion}`;
    if (this.cardCache && this.cardCache.key === key) return this.cardCache.card;
    const card = buildCommandCard(w, this.game.localPlayerId, this.selection.ids, {
      menu: this.menu, subgroup: this.selection.activeSubgroup(), activeButtonId: this.targeting?.buttonId ?? this.placement?.buttonId ?? null,
    }, this.hooks);
    // the builder falls back to the root card when a sub-menu no longer applies → keep our state in sync
    if (this.menu !== 'root' && !card.some((b) => b.id === 'menu.back')) { this.menu = 'root'; this.stateVersion++; }
    this.cardCache = { key: `${w.tick}|${this.selection.version}|${this.stateVersion}`, card };
    return card;
  }

  /** Tab / Shift+Tab. */
  cycleSubgroup(dir: 1 | -1 = 1): void { this.selection.cycleSubgroup(dir); }
  activeSubgroup(): string | null { return this.selection.activeSubgroup(); }

  /**
   * Minimap (HUD) → command at a world point. Left click while targeting issues the pending command there;
   * right click issues a smart move / rally (or cancels a mode). Returns true if consumed (the HUD should
   * not pan the camera then).
   */
  commandAtPoint(pos: Vec2, button: number, shift = false): boolean {
    if (this.inputBlocked()) return false;
    let used = false;
    this.guard('minimap', () => {
      if (button === 0 && this.mode === 'targeting') { this.targetAt(clone(pos), null, shift); used = true; }
      else if (button === 2) {
        if (this.mode !== 'normal') this.cancelMode(); else this.smartAt(clone(pos), null, shift);
        used = true;
      }
    });
    return used;
  }

  /** Name used by the HUD minimap (src/ui/hud/minimap.ts) — same as commandAtPoint. */
  minimapCommand(pos: Vec2, button: number, shift = false): boolean { return this.commandAtPoint(pos, button, shift); }

  /** Leave targeting / placement mode (no-op in normal mode). */
  cancelMode(): void {
    this.keptByShift = false;
    if (this.mode === 'normal' && !this.targeting && !this.placement) return;
    this.targeting = null;
    this.clearPlacement();
    this.mode = 'normal';
    this.bump();
    this.updateCursor();
  }

  update(_dtReal: number): void {
    if (this.disposed) return;
    this.guard('update', () => {
      const g = this.game;
      if (g.world.rules.gameOver) this.cancelInteraction();
      else if (g.paused && this.drag) { this.drag = null; this.box.hide(); }
      this.selection.prune((e) => this.visibleToLocal(e));
      this.validateMode();
      this.updatePlacement();
      this.updateHover();
      this.updateCursor();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('mouseleave', this.onMouseLeave);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    for (const u of this.unsub) u();
    this.unsub = [];
    this.box.dispose();
    this.selection.dispose();
    this.groups.clear();
    const r = this.game.renderer;
    try { r.setPlacementGhost(null); } catch { /* renderer already gone */ }
    try { r.setHover(null); } catch { /* renderer already gone */ }
    this.canvas.style.cursor = '';
    this.cardCache = null;
  }

  // ───────────────────────── mouse ─────────────────────────
  private onContextMenu = (e: MouseEvent): void => { e.preventDefault(); };

  private onMouseLeave = (): void => { this.mouse.inside = false; };

  private onMouseDown = (e: MouseEvent): void => {
    this.guard('mousedown', () => {
      const p = this.canvasPoint(e);
      this.mouse = { x: p.x, y: p.y, inside: true };
      this.shiftDown = e.shiftKey;
      if (e.button === 2) e.preventDefault();
      if (this.inputBlocked()) return;
      if (e.button === 0) {
        if (this.mode === 'targeting') { this.swallowUp = true; this.targetAt(this.ground(p.x, p.y), this.pick(p.x, p.y), e.shiftKey); return; }
        if (this.mode === 'placing') { this.swallowUp = true; this.placeAt(p.x, p.y, e.shiftKey); return; }
        this.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, active: false };
      } else if (e.button === 2) {
        if (this.drag?.active) return; // ignore right clicks while box-dragging
        this.drag = null;
        if (this.mode !== 'normal') { this.cancelMode(); return; }
        this.smartAt(this.ground(p.x, p.y), this.pick(p.x, p.y), e.shiftKey);
      }
    });
  };

  private onMouseMove = (e: MouseEvent): void => {
    const p = this.canvasPoint(e);
    this.mouse.x = p.x; this.mouse.y = p.y;
    this.mouse.inside = e.target === this.canvas;
    this.shiftDown = e.shiftKey;
    const d = this.drag;
    if (!d) return;
    d.x1 = p.x; d.y1 = p.y;
    if (!d.active && Math.hypot(p.x - d.x0, p.y - d.y0) > DRAG_THRESHOLD) d.active = true;
    if (d.active) this.box.show(d.x0, d.y0, d.x1, d.y1);
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    this.guard('mouseup', () => {
      if (this.swallowUp) { this.swallowUp = false; this.drag = null; return; }
      const d = this.drag;
      this.drag = null;
      this.box.hide();
      if (!d || this.inputBlocked()) return;
      const p = this.canvasPoint(e);
      const shift = d.shift || e.shiftKey;
      if (d.active) this.boxSelect(d.x0, d.y0, p.x, p.y, shift);
      else this.clickSelect(d.x0, d.y0, shift, d.ctrl || e.ctrlKey || e.metaKey);
    });
  };

  private clickSelect(x: number, y: number, shift: boolean, ctrl: boolean): void {
    const local = this.game.localPlayerId;
    const hit = this.pick(x, y);
    const now = performance.now() / 1000;
    if (!hit) { if (!shift) this.selection.clear(); this.lastClick = null; return; }
    const own = hit.owner === local;
    const lc = this.lastClick;
    const dbl = !!lc && now - lc.t <= DOUBLE_CLICK && lc.defId === hit.defId && Math.hypot(x - lc.x, y - lc.y) < 24;
    this.lastClick = dbl ? null : { t: now, defId: hit.defId, x, y };
    if (own && (ctrl || dbl)) {
      const same = this.onScreen().filter((e) => e.owner === local && e.defId === hit.defId).map((e) => e.id);
      if (!same.includes(hit.id)) same.unshift(hit.id);
      if (shift && this.selection.isOwn()) this.selection.add(same); else this.selection.set(same);
      this.selection.setActiveSubgroup(hit.defId);
      return;
    }
    if (own) {
      if (shift && this.selection.isOwn()) this.selection.toggle([hit.id]); else this.selection.set([hit.id]);
      return;
    }
    if (shift && this.selection.isOwn()) return; // never mix foreign entities into an own selection
    this.selection.set([hit.id]);
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, shift: boolean): void {
    const g = this.game, local = g.localPlayerId;
    let inBox: Entity[] = [];
    try { inBox = g.renderer.entitiesInScreenRect(x0, y0, x1, y1).filter((e) => e.alive); } catch { inBox = []; }
    let pick = inBox.filter((e) => e.owner === local && e.kind === 'unit');
    if (pick.length === 0) pick = inBox.filter((e) => e.owner === local && e.kind === 'building');
    if (pick.length === 0) {
      // a single enemy: the one nearest the box centre
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      let best: Entity | null = null, bd = Infinity;
      for (const e of inBox) {
        if (!g.world.isEnemy(local, e.owner)) continue;
        const s = this.toScreen(e.pos);
        const d = s ? Math.hypot(s.x - cx, s.y - cy) : Infinity;
        if (!best || d < bd) { best = e; bd = d; }
      }
      pick = best ? [best] : [];
    }
    const ids = pick.map((e) => e.id);
    if (!shift) { this.selection.set(ids); return; }
    if (ids.length === 0) return;
    const ownPick = pick[0]!.owner === local;
    if (ownPick && (this.selection.isOwn() || this.selection.ids.length === 0)) this.selection.add(ids);
    else if (!this.selection.isOwn()) this.selection.set(ids);
  }

  // ───────────────────────── commands ─────────────────────────
  /** Right click: smart command for selected units, rally for selected producers. */
  private smartAt(ground: Vec2 | null, hit: Entity | null, shift: boolean): void {
    const g = this.game, w = g.world, local = g.localPlayerId;
    const own = this.selection.owned();
    if (own.length === 0) return;
    const target = ground ?? (hit ? clone(hit.pos) : null);
    if (!target) return;
    const units = own.filter((e) => e.kind === 'unit');
    const producers = own.filter((e) => e.kind === 'building' && !e.construction && (e.def as BuildingDef).trains.length > 0);
    const targetId = hit?.id;
    if (units.length > 0) {
      this.issue({ type: 'smart', playerId: local, unitIds: units.map((u) => u.id), target, targetId, queue: shift });
      const workers = units.some((u) => !!u.gatherer);
      let kind: CommandMarkerKind = 'move';
      if (hit && w.isEnemy(local, hit.owner)) kind = 'attack';
      else if (hit && hit.kind === 'resource' && workers) kind = 'gather';
      else if (hit && hit.owner === local && hit.kind === 'building' && workers && (hit.construction || hit.hp < hit.stats.maxHp)) kind = 'build';
      this.marker(kind === 'move' || !hit ? target : hit.pos, kind);
    }
    if (producers.length > 0) {
      this.issue({ type: 'setRally', playerId: local, buildingIds: producers.map((b) => b.id), target, targetId });
      if (units.length === 0) this.marker(hit ? hit.pos : target, 'rally');
    }
  }

  /** Execute the pending targeting request at a ground point / entity. */
  private targetAt(ground: Vec2 | null, hit: Entity | null, shift: boolean): void {
    const req = this.targeting;
    if (!req) { this.cancelMode(); return; }
    const g = this.game, w = g.world, local = g.localPlayerId;
    const pos = ground ?? (hit ? clone(hit.pos) : null);
    const unitIds = this.liveOwnIds(req.unitIds);
    const buildingIds = this.liveOwnIds(req.buildingIds);
    let done = false;
    const issue = (cmd: Command, at: Vec2, kind: CommandMarkerKind) => { this.issue(cmd); this.marker(at, kind); done = true; };
    switch (req.kind) {
      case 'attack':
        if (hit && w.isEnemy(local, hit.owner)) {
          // units able to hit the target attack it; the rest (e.g. medics, ground-only vs air) attack-move there
          const able = unitIds.filter((id) => { const u = w.getAlive(id); return !!u?.combat && this.check(() => ({ ok: w.combat.canTarget(u, hit) })).ok; });
          if (able.length === 0 && unitIds.some((id) => !!w.getAlive(id)?.combat)) { this.feedback('invalidTarget', "Can't attack that target"); break; }
          const rest = unitIds.filter((id) => !able.includes(id));
          if (able.length) issue({ type: 'attack', playerId: local, unitIds: able, targetId: hit.id, queue: shift }, hit.pos, 'attack');
          if (rest.length) issue({ type: 'attackMove', playerId: local, unitIds: rest, target: clone(hit.pos), queue: shift }, hit.pos, 'attack');
        } else if (pos) issue({ type: 'attackMove', playerId: local, unitIds, target: pos, queue: shift }, pos, 'attack');
        break;
      case 'move':
        if (hit && hit.kind === 'unit' && !(unitIds.length === 1 && unitIds[0] === hit.id)) issue({ type: 'follow', playerId: local, unitIds, targetId: hit.id, queue: shift }, hit.pos, 'move');
        else if (pos) issue({ type: 'move', playerId: local, unitIds, target: pos, queue: shift }, pos, 'move');
        break;
      case 'patrol':
        if (pos) issue({ type: 'patrol', playerId: local, unitIds, target: pos, queue: shift }, pos, 'move');
        break;
      case 'gather':
        if (hit && hit.kind === 'resource') issue({ type: 'gather', playerId: local, unitIds, targetId: hit.id, queue: shift }, hit.pos, 'gather');
        else if (hit && hit.owner === local && hit.kind === 'building' && !hit.construction && (hit.def as BuildingDef).dropoff) issue({ type: 'returnCargo', playerId: local, unitIds, queue: shift }, hit.pos, 'gather');
        else this.feedback('invalidTarget', `Must target a ${RESOURCE_DEFS[SUPPLY_CACHE_ID]?.name ?? 'resource'}`);
        break;
      case 'repair':
        if (hit && this.repairable(hit)) {
          if (hit.construction) issue({ type: 'smart', playerId: local, unitIds, target: clone(hit.pos), targetId: hit.id, queue: shift }, hit.pos, 'build');
          else issue({ type: 'repair', playerId: local, unitIds, targetId: hit.id, queue: shift }, hit.pos, 'build');
        } else this.feedback('invalidTarget', 'Must target a friendly structure or mechanical unit');
        break;
      case 'ability': {
        const a = req.abilityId ? ABILITY_DEFS[req.abilityId] : undefined;
        if (!a) break;
        const kind: CommandMarkerKind = a.damage ? 'attack' : 'move';
        if (req.target === 'unit') {
          if (!hit || hit.kind === 'resource') { this.feedback('invalidTarget', `${a.name} needs a unit target`); break; }
          issue({ type: 'ability', playerId: local, unitIds, abilityId: a.id, targetId: hit.id, target: clone(hit.pos), queue: shift }, hit.pos, kind);
        } else if (pos) issue({ type: 'ability', playerId: local, unitIds, abilityId: a.id, target: pos, queue: shift }, pos, kind);
        break;
      }
      case 'buildingAbility': {
        const a = req.abilityId ? ABILITY_DEFS[req.abilityId] : undefined;
        if (!a) break;
        if (req.target === 'unit' && (!hit || hit.kind === 'resource')) { this.feedback('invalidTarget', `${a.name} needs a unit target`); break; }
        const at = req.target === 'unit' ? clone(hit!.pos) : pos;
        if (!at) break;
        const targetEntity = req.target === 'unit' ? hit : null;
        // buildings can't walk into range: validate with the real target (range included)
        const checks = buildingIds.map((id) => ({ b: w.getAlive(id)!, r: this.check(() => w.abilities.canCast(w.getAlive(id)!, a.id, at, targetEntity)) }));
        const ready = checks.find((c) => c.r.ok);
        if (!ready) {
          const reason = checks.find((c) => c.r.reason)?.r.reason ?? `${a.name} is not ready yet`;
          this.feedback(/ready|cooldown/i.test(reason) ? 'cooldown' : 'invalidTarget', reason);
          break;
        }
        issue({ type: 'buildingAbility', playerId: local, buildingId: ready.b.id, abilityId: a.id, target: at, targetId: targetEntity?.id }, at, a.damage ? 'attack' : 'move');
        break;
      }
      case 'rally':
        if (pos) issue({ type: 'setRally', playerId: local, buildingIds, target: pos, targetId: hit?.id }, hit ? hit.pos : pos, 'rally');
        break;
    }
    if (done && !shift) this.cancelMode();
    else if (done) this.keptByShift = true;
  }

  /** Placement click at canvas point: validate, check affordability (instant feedback), issue 'build'. */
  private placeAt(x: number, y: number, shift: boolean): void {
    const pl = this.placement;
    const def = pl ? BUILDING_DEFS[pl.defId] : undefined;
    if (!pl || !def) { this.cancelMode(); return; }
    const ground = this.ground(x, y);
    if (!ground) { this.feedback('placement', "Can't build there"); return; }
    const tile = footprintTileAt(ground, def.footprint.w, def.footprint.h);
    const res = this.placementCheck(pl, def, tile);
    if (!res.ok) { this.feedback('placement', res.reason ?? "Can't build there"); return; }
    const short = this.shortfall(def.cost);
    if (short) { this.feedback(short.kind, short.message); return; }
    const unitIds = this.liveOwnIds(pl.builderIds);
    if (unitIds.length === 0) { this.cancelMode(); return; }
    this.issue({ type: 'build', playerId: this.game.localPlayerId, unitIds, defId: def.id, tile, queue: shift });
    this.marker(footprintCenter(tile, def.footprint.w, def.footprint.h), 'build');
    if (shift) { this.ghostKey = ''; this.keptByShift = true; return; } // keep placing (ghost turns red over the planned site)
    this.cancelMode();
    this.setMenu('root');
  }

  private issue(cmd: Command, fromCard = false): void {
    // Shift while activating a card button / hotkey queues unit orders
    if (fromCard && this.shiftDown && 'unitIds' in cmd && cmd.type !== 'stop') cmd.queue = true;
    this.syncPending();
    if (cmd.type === 'train') { this.pendingTrains.set(cmd.buildingId, (this.pendingTrains.get(cmd.buildingId) ?? 0) + 1); this.bump(); }
    if (cmd.type === 'build') this.pendingBuilds.push({ defId: cmd.defId, tile: { x: cmd.tile.x, y: cmd.tile.y } });
    try { this.game.issue(cmd); } catch (err) { console.error('[input] issue failed', err); }
  }

  /** Commands issued at tick T are processed by the next step: forget pending counters once the tick moves. */
  private syncPending(): void {
    const t = this.game.world.tick;
    if (t === this.pendingTick) return;
    this.pendingTick = t;
    this.pendingTrains.clear();
    this.pendingBuilds = [];
  }

  private feedback(kind: NotEnoughKind, message: string): void {
    try { this.game.world.events.emit('notEnough', { playerId: this.game.localPlayerId, kind, message }); } catch { /* ignore */ }
  }

  // ───────────────────────── modes ─────────────────────────
  private beginTargeting(req: TargetingRequest): void {
    if (this.inputBlocked()) return;
    this.clearPlacement();
    this.keptByShift = false;
    this.targeting = { ...req, unitIds: [...req.unitIds], buildingIds: [...req.buildingIds] };
    this.mode = 'targeting';
    this.bump();
    this.updateCursor();
  }

  private beginPlacement(defId: string, builderIds: EntityId[], buttonId: string): void {
    if (this.inputBlocked() || !BUILDING_DEFS[defId]) return;
    this.targeting = null;
    this.clearPlacement();
    this.keptByShift = false;
    this.placement = { defId, builderIds: [...builderIds], buttonId, tile: null, valid: false };
    this.mode = 'placing';
    this.bump();
    this.updatePlacement();
    this.updateCursor();
  }

  private clearPlacement(): void {
    if (!this.placement && !this.ghostKey) return;
    this.placement = null;
    this.ghostKey = '';
    try { this.game.renderer.setPlacementGhost(null); } catch { /* ignore */ }
  }

  private setMenu(m: CardMenu): void {
    if (this.menu === m) return;
    this.menu = m;
    this.bump();
  }

  /** Drop modes whose units/buildings are gone. */
  private validateMode(): void {
    const t = this.targeting;
    if (t) {
      t.unitIds = this.liveOwnIds(t.unitIds);
      t.buildingIds = this.liveOwnIds(t.buildingIds);
      const usesBuildings = t.kind === 'rally' || t.kind === 'buildingAbility';
      if ((usesBuildings ? t.buildingIds : t.unitIds).length === 0) this.cancelMode();
    }
    const p = this.placement;
    if (p) {
      p.builderIds = this.liveOwnIds(p.builderIds);
      if (p.builderIds.length === 0) this.cancelMode();
    }
  }

  /** Ghost follows the cursor (hidden while the pointer is over the HUD). */
  private updatePlacement(): void {
    const pl = this.placement;
    if (!pl) return;
    const def = BUILDING_DEFS[pl.defId];
    const ground = def && this.mouse.inside ? this.ground(this.mouse.x, this.mouse.y) : null;
    if (!def || !ground) {
      pl.tile = null; pl.valid = false;
      if (this.ghostKey !== 'hidden') { this.ghostKey = 'hidden'; try { this.game.renderer.setPlacementGhost(null); } catch { /* ignore */ } }
      return;
    }
    const tile = footprintTileAt(ground, def.footprint.w, def.footprint.h);
    const res = this.placementCheck(pl, def, tile);
    pl.tile = tile; pl.valid = res.ok; pl.reason = res.reason;
    const key = `${def.id}:${tile.x},${tile.y}:${res.ok ? 1 : 0}`;
    if (key !== this.ghostKey) {
      this.ghostKey = key;
      try { this.game.renderer.setPlacementGhost({ defId: def.id, tile, valid: res.ok }); } catch (err) { this.logOnce('setPlacementGhost', err); }
    }
  }

  /** economy.canPlaceBuilding + overlap with sites already planned by queued build orders. */
  private placementCheck(pl: PlacementState, def: BuildingDef, tile: TilePos): Check {
    const w = this.game.world, local = this.game.localPlayerId;
    const c = footprintCenter(tile, def.footprint.w, def.footprint.h);
    let builder: Entity | null = null, bd = Infinity;
    for (const id of pl.builderIds) {
      const e = w.getAlive(id);
      if (e && dist(e.pos, c) < bd) { bd = dist(e.pos, c); builder = e; }
    }
    const res = this.check(() => w.economy.canPlaceBuilding(local, def.id, tile, builder?.id));
    if (!res.ok) return res;
    for (const s of this.plannedSites()) {
      const sd = BUILDING_DEFS[s.defId];
      if (sd && rectsOverlap(tile, def.footprint, s.tile, sd.footprint)) return { ok: false, reason: 'A structure is already planned there' };
    }
    return res;
  }

  /** Build orders not yet turned into foundations (queued in units + issued this tick). */
  private plannedSites(): Array<{ defId: string; tile: TilePos }> {
    this.syncPending();
    const out = [...this.pendingBuilds];
    for (const e of this.game.world.entitiesOf(this.game.localPlayerId, (x) => x.kind === 'unit' && !!x.gatherer)) {
      for (const o of e.orders) if (o.type === 'build' && o.buildingId == null) out.push({ defId: o.defId, tile: o.tile });
    }
    return out;
  }

  // ───────────────────────── keyboard ─────────────────────────
  private onKeyUp = (e: KeyboardEvent): void => {
    this.shiftDown = e.shiftKey;
    if (e.key !== 'Shift' || !this.keptByShift || this.disposed) return;
    // releasing Shift after Shift-queued clicks ends the mode
    this.guard('keyup', () => {
      const wasPlacing = this.mode === 'placing';
      this.cancelMode();
      if (wasPlacing) this.setMenu('root');
    });
  };

  private onBlur = (): void => {
    this.shiftDown = false;
    if (this.keptByShift) this.cancelMode();
    this.mouse.inside = false;
    if (this.drag) { this.drag = null; this.box.hide(); }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    this.shiftDown = e.shiftKey;
    if (this.disposed || e.defaultPrevented) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (e.key.startsWith('Arrow')) return; // camera keys belong to render-core
    this.guard('keydown', () => {
      const g = this.game;
      const key = normalizeKey(e);
      if (key === 'Esc') { e.preventDefault(); if (!e.repeat) this.onEscape(); return; }
      if (e.key === 'F10') { e.preventDefault(); if (!e.repeat) { this.cancelMode(); this.openPauseMenu(); } return; }
      if (g.paused || g.world.rules.gameOver || e.altKey) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const digit = groupDigit(e);
      if (digit !== null) {
        e.preventDefault();
        if (!e.repeat) this.onGroupKey(digit, ctrl, e.shiftKey);
        return;
      }
      if (e.key === 'F1') { e.preventDefault(); if (!e.repeat) this.selectIdleWorker(ctrl); return; }
      if (ctrl) return; // leave other Ctrl/Cmd shortcuts to the browser
      if (e.key === 'Backspace') { e.preventDefault(); if (!e.repeat) this.cycleBase(); return; }
      if (e.key === 'Tab') { e.preventDefault(); if (!e.repeat) this.cycleSubgroup(e.shiftKey ? -1 : 1); return; }
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); if (!e.repeat) this.jumpToAlert(); return; }
      if (isSpeedUpKey(e) || isSpeedDownKey(e)) {
        if (g.config.mode !== 'skirmish') return;
        e.preventDefault();
        this.changeSpeed(isSpeedUpKey(e) ? 1 : -1);
        return;
      }
      const btn = findByHotkey(this.getCommandCard(), key);
      if (!btn) return;
      e.preventDefault();
      // holding a train hotkey keeps queueing (key repeat); everything else fires once per press
      if (e.repeat && !btn.id.startsWith('train.')) return;
      btn.activate();
    });
  };

  /** Esc: cancel drag/mode → close sub-menu → pause menu. While paused it goes straight to the pause menu. */
  private onEscape(): void {
    if (this.game.paused) { this.openPauseMenu(); return; }
    if (this.game.world.rules.gameOver) return;
    if (this.drag) { this.drag = null; this.box.hide(); return; }
    if (this.mode !== 'normal') { this.cancelMode(); return; }
    if (this.menu !== 'root') { this.setMenu('root'); return; }
    this.openPauseMenu();
  }

  private openPauseMenu(): void {
    try { this.game.ui?.openPauseMenu(); } catch (err) { console.error('[input] openPauseMenu failed', err); }
  }

  private onGroupKey(n: number, ctrl: boolean, shift: boolean): void {
    if (ctrl) { this.groups.assign(n, [...this.selection.ids]); return; }
    if (shift) { this.groups.add(n, [...this.selection.ids]); return; }
    const members = this.groups.get(n);
    if (members.length === 0) return;
    const dbl = this.groups.recall(n, performance.now() / 1000);
    this.selection.set(members);
    if (dbl) { const c = this.groups.centroid(n); if (c) this.lookAt(c); }
  }

  /** F1: next idle worker (selected + camera). Ctrl+F1: all idle workers. (Same "idle" as the HUD's counter.) */
  selectIdleWorker(all = false): void {
    const idle = this.game.world.entitiesOf(this.game.localPlayerId, (e) => e.kind === 'unit' && !!e.gatherer && e.orders.length === 0 && e.activity === 'idle')
      .sort((a, b) => a.id - b.id);
    if (idle.length === 0) return;
    if (all) { this.selection.set(idle.map((e) => e.id)); return; }
    const next = idle.find((e) => e.id > this.idleCursor) ?? idle[0]!;
    this.idleCursor = next.id;
    this.selection.set([next.id]);
    this.lookAt(next.pos);
  }

  /** Backspace: cycle through own headquarters. */
  cycleBase(): void {
    const bases = this.game.world.entitiesOf(this.game.localPlayerId, (e) => e.kind === 'building' && !!(e.def as BuildingDef).hq)
      .sort((a, b) => a.id - b.id);
    if (bases.length === 0) return;
    const next = bases.find((b) => b.id > this.baseCursor) ?? bases[0]!;
    this.baseCursor = next.id;
    this.selection.set([next.id]);
    this.lookAt(next.pos);
  }

  /** Space: jump to the latest under-attack alert; repeated presses step back through recent ones. */
  jumpToAlert(): void {
    if (this.alerts.length === 0) return;
    const p = this.alerts[this.alertIdx % this.alerts.length]!;
    this.alertIdx = (this.alertIdx + 1) % this.alerts.length;
    this.lookAt(p);
  }

  private changeSpeed(dir: 1 | -1): void {
    const s = stepSpeed(this.game.speed, dir);
    if (s === this.game.speed) return;
    this.game.setSpeed(s);
    try { this.game.ui?.notify(`Game speed ×${s}`, 'info'); } catch { /* HUD optional */ }
  }

  // ───────────────────────── per-frame feedback ─────────────────────────
  private updateHover(): void {
    let id: EntityId | null = null;
    if (this.mouse.inside && !this.drag?.active && this.mode !== 'placing' && !this.inputBlocked()) id = this.pick(this.mouse.x, this.mouse.y)?.id ?? null;
    if (id === this.hoverId) return;
    this.hoverId = id;
    try { this.game.renderer.setHover(id); } catch (err) { this.logOnce('setHover', err); }
  }

  private updateCursor(): void {
    let c: CursorKind = 'default';
    if (this.mode === 'placing') c = this.placement?.valid || !this.placement?.tile ? 'placement' : 'invalid';
    else if (this.mode === 'targeting' && this.targeting) c = this.targetCursor(this.targeting, this.game.world.getAlive(this.hoverId) ?? null);
    this.setCursor(c);
  }

  private targetCursor(req: TargetingRequest, hover: Entity | null): CursorKind {
    switch (req.kind) {
      case 'attack': return 'attack';
      case 'gather': return hover && (hover.kind === 'resource' || (hover.owner === this.game.localPlayerId && !!(hover.def as BuildingDef).dropoff)) ? 'move' : 'invalid';
      case 'repair': return hover && this.repairable(hover) ? 'move' : 'invalid';
      case 'ability': case 'buildingAbility': {
        const a = req.abilityId ? ABILITY_DEFS[req.abilityId] : undefined;
        if (req.target === 'unit') return hover && hover.kind !== 'resource' ? 'attack' : 'invalid';
        return a?.damage ? 'attack' : 'move';
      }
      default: return 'move';
    }
  }

  private setCursor(c: CursorKind): void {
    if (c === this.cursor) return;
    this.cursor = c;
    this.canvas.style.cursor = CURSORS[c];
  }

  // ───────────────────────── helpers ─────────────────────────
  private inputBlocked(): boolean { return this.disposed || this.game.paused || this.game.world.rules.gameOver; }

  private cancelInteraction(): void {
    if (this.drag) { this.drag = null; this.box.hide(); }
    this.swallowUp = false;
    this.cancelMode();
  }

  private bump(): void { this.stateVersion++; }

  private canvasPoint(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private ground(x: number, y: number): Vec2 | null {
    try { return this.game.renderer.screenToGround(x, y); } catch (err) { this.logOnce('screenToGround', err); return null; }
  }

  private pick(x: number, y: number): Entity | null {
    try { const e = this.game.renderer.pickEntity(x, y); return e && e.alive ? e : null; } catch (err) { this.logOnce('pickEntity', err); return null; }
  }

  private toScreen(p: Vec2): { x: number; y: number } | null {
    try { return this.game.renderer.worldToScreen(p); } catch { return null; }
  }

  private onScreen(): Entity[] {
    try { return this.game.renderer.entitiesInScreenRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight).filter((e) => e.alive); } catch { return []; }
  }

  private lookAt(p: Vec2): void {
    try { this.game.renderer.cameraCtl.lookAt({ x: p.x, y: p.y }); } catch (err) { this.logOnce('lookAt', err); }
  }

  private marker(p: Vec2, kind: CommandMarkerKind): void {
    try { this.game.renderer.showCommandMarker({ x: p.x, y: p.y }, kind); } catch (err) { this.logOnce('showCommandMarker', err); }
  }

  private visibleToLocal(e: Entity): boolean {
    if (e.owner === this.game.localPlayerId) return true;
    try { return this.game.world.vision.isEntityVisible(this.game.localPlayerId, e); } catch { return true; }
  }

  private liveOwnIds(ids: readonly EntityId[]): EntityId[] {
    const w = this.game.world, local = this.game.localPlayerId;
    return ids.filter((id) => { const e = w.getAlive(id); return !!e && e.owner === local; });
  }

  /** Friendly structure or mechanical unit (hospital workers repair those). */
  private repairable(e: Entity): boolean {
    if (e.kind === 'resource' || !this.game.world.isAlly(this.game.localPlayerId, e.owner)) return false;
    return e.kind === 'building' || e.tags.has('mech');
  }

  private shortfall(cost: { matter?: number; energy?: number }): { kind: NotEnoughKind; message: string } | null {
    const w = this.game.world, local = this.game.localPlayerId;
    const f = FACTIONS[w.players.get(local)?.faction ?? 'neutral'];
    const can = (c: { matter?: number; energy?: number }) => { try { return w.economy.canAfford(local, c); } catch { return true; } };
    if ((cost.matter ?? 0) > 0 && !can({ matter: cost.matter })) return { kind: 'matter', message: `Not enough ${f.resourceNames.matter}` };
    if ((cost.energy ?? 0) > 0 && !can({ energy: cost.energy })) return { kind: 'energy', message: `Not enough ${f.resourceNames.energy}` };
    return null;
  }

  private check(fn: () => Check | undefined | null): Check {
    try { return fn() ?? { ok: false, reason: 'Unavailable' }; } catch { return { ok: false, reason: 'Unavailable' }; }
  }

  private guard(where: string, fn: () => void): void {
    try { fn(); } catch (err) { if (this.errors++ < 10) console.error(`[input] ${where} failed`, err); }
  }

  private logged = new Set<string>();
  private logOnce(what: string, err: unknown): void {
    if (this.logged.has(what)) return;
    this.logged.add(what);
    console.error(`[input] renderer.${what} threw`, err);
  }
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable;
}

function rectsOverlap(a: TilePos, af: { w: number; h: number }, b: TilePos, bf: { w: number; h: number }): boolean {
  return a.x < b.x + bf.w && b.x < a.x + af.w && a.y < b.y + bf.h && b.y < a.y + af.h;
}

