/**
 * [ui] OWNER: HUD agent. In-game DOM overlay implementing GameUi.
 *
 * Layout (DESIGN §4): top-right vital-signs bar · centre-top mission timer + toasts · top-left objectives
 * and alert log · bottom: minimap (left, idle-worker button above it), selection panel (centre), command
 * card (right) · dialogue comm-link above the selection panel · modal pause/settings/end screens.
 *
 * Panels are pointer-events:auto; everything else is click-through so canvas input keeps working.
 * Per-frame cost: each module diffs its values and only writes the DOM on change; the minimap base layer
 * redraws at ~10 Hz. Each module's update is isolated (one failing panel never stops the others).
 *
 * Extra public API (beyond GameUi) for other client modules:
 *   hud.lastAlertPos   — position of the most recent located alert (controls: Space = jump to alert)
 *   hud.isModalOpen    — true while the pause menu / end screen captures input
 */
import type { BuildingDef, Entity, UnitDef, Vec2 } from '../core/types';
import type { DialogueLine, EndScreenResult, GameUi, NotifyKind, ObjectiveView } from '../core/ui';
import { FACTIONS, UPGRADE_DEFS } from '../data';
import type { GameContext } from '../game/contracts';
import type { UiSound } from '../audio/AudioEngine';
import { el, setClass, TextSlot } from './dom';
import { notEnoughText } from './format';
import { iconHtml } from './icons';
import { ensureUiStyles } from './styles';
import { Tooltip } from './tooltip';
import { confirmModal, errText, fmtDate, globalToast } from './saveLoad';
import { fmtClock } from './format';
import { CommandCard } from './hud/commandCard';
import { DialogueBox } from './hud/dialogue';
import { Minimap } from './hud/minimap';
import { Notifications } from './hud/notifications';
import { ObjectivesPanel } from './hud/objectives';
import { EndScreen, PauseMenu } from './hud/overlays';
import { SelectionPanel } from './hud/selectionPanel';
import { FpsMeter, MissionTimer, TopBar } from './hud/topBar';
import { MultiplayerHud } from './hud/multiplayer';


/** Units worth a "ready" toast when they roll out. */
function isKeyUnit(e: Entity): boolean {
  if (e.kind !== 'unit') return false;
  const d = e.def as UnitDef;
  return d.pop >= 3 || e.tags.has('massive') || e.tags.has('hero') || e.tags.has('air');
}

export class Hud implements GameUi {
  private el: HTMLDivElement;
  private tip: Tooltip;
  private top: TopBar;
  private timer: MissionTimer;
  private fps: FpsMeter;
  private objectives: ObjectivesPanel;
  private notes: Notifications;
  private minimap: Minimap;
  private idleBtn: HTMLDivElement;
  private idleCount: TextSlot;
  private idleIds: number[] = [];
  private idleIdx = 0;
  private idleT = 1;
  private sel: SelectionPanel;
  private card: CommandCard;
  private dialogue: DialogueBox;
  private pause: PauseMenu;
  private end: EndScreen;
  private unsub: Array<() => void> = [];
  private errors = new Map<string, number>();
  private lastAttackToast = -999;
  private disposed = false;
  private savingEl: HTMLDivElement;
  private quickBusy = false;
  private confirmOpen = false;
  /** LAN multiplayer layer (null in single-player) */
  readonly mp: MultiplayerHud | null = null;

  constructor(private root: HTMLElement, private game: GameContext) {
    ensureUiStyles();
    const me = game.world.player(game.localPlayerId);
    this.el = el('div', `ip-root ip-hud ip-faction-${me.faction}${game.settings.quality === 'low' ? ' ip-lowfx' : ''}`, root);
    this.el.addEventListener('contextmenu', (e) => { if (e.target !== this.el) e.preventDefault(); });
    this.tip = new Tooltip(this.el);

    // top / left
    this.top = new TopBar(this.el, game, this.tip, () => this.openPauseMenu());
    this.timer = new MissionTimer(this.el);
    this.fps = new FpsMeter(this.el);
    const left = el('div', 'ip-leftcol', this.el);
    this.objectives = new ObjectivesPanel(left);
    this.notes = new Notifications(this.el, left, (p) => this.game.renderer?.cameraCtl?.lookAt(p));

    // bottom
    this.minimap = new Minimap(this.el, game);
    this.idleBtn = el('div', 'ip-panel ip-idle is-none', this.el);
    this.idleBtn.dataset.testid = 'idle-workers';
    this.idleBtn.innerHTML = iconHtml(FACTIONS[me.faction]?.worker || 'hosp_orderly');
    this.idleCount = new TextSlot(el('span', 'ip-idle-count', this.idleBtn));
    this.idleBtn.addEventListener('click', (e) => { e.stopPropagation(); this.selectIdle(e.shiftKey || e.ctrlKey || e.metaKey); });
    this.idleBtn.addEventListener('mouseenter', () => this.tip.show(
      `<div class="ip-tip-title">Idle workers<span class="ip-key">F1</span></div><div class="ip-tip-body">${this.idleIds.length} idle. Click to select the next one · Ctrl/Shift-click selects them all.</div>`,
      { rect: this.idleBtn.getBoundingClientRect(), place: 'right' }, this.idleBtn));
    this.idleBtn.addEventListener('mouseleave', () => this.tip.hide(this.idleBtn));
    this.sel = new SelectionPanel(this.el, game, this.tip);
    this.card = new CommandCard(this.el, game, this.tip);
    this.card.onDisabled = (reason) => this.notes.toast(reason, 'warning');
    this.dialogue = new DialogueBox(this.el);
    this.dialogue.onLine = () => this.sound('open');
    this.objectives.onChange = (o) => {
      if (o.state === 'done') this.sound('confirm');
      if (o.state === 'failed') this.sound('error');
    };

    // overlays
    this.pause = new PauseMenu(this.el, game, (k) => this.sound(k), (t, k) => (this.disposed ? globalToast(t, k) : this.notes.toast(t, k)));
    this.savingEl = el('div', 'ip-saving', this.el, 'Saving…');
    this.savingEl.dataset.testid = 'saving';
    this.savingEl.style.display = 'none';
    this.end = new EndScreen(this.el, game, (k) => this.sound(k));
    if (game.net) {
      this.mp = new MultiplayerHud(this.el, this.top.el, game, (k) => this.sound(k), (t, k) => this.notes.toast(t, k));
      this.pause.onLeaveMatch = () => this.mp?.leaveMatch(true);
    }

    window.addEventListener('keydown', this.onKeyCapture, true);
    this.subscribe();
  }

  // ───────────────────────── GameUi ─────────────────────────
  showDialogue(line: DialogueLine): void { this.safe('dialogue', () => this.dialogue.push(line)); }
  setObjectives(objs: ObjectiveView[]): void { this.safe('objectives', () => this.objectives.set(objs)); }
  notify(text: string, kind: NotifyKind = 'info'): void {
    this.safe('notify', () => {
      this.notes.toast(text, kind);
      this.sound(kind === 'warning' || kind === 'alert' ? 'warning' : 'notify');
      if (kind === 'alert' || kind === 'success') this.notes.alert(text, kind, this.game.world.time);
    });
  }
  setMissionTimer(label: string | null, seconds?: number): void { this.safe('timer', () => this.timer.set(label, seconds)); }
  pingMinimap(pos: Vec2, color?: number): void { this.safe('ping', () => this.minimap.ping(pos, color)); }
  showEndScreen(result: EndScreenResult): void {
    this.safe('end', () => {
      if (this.pause.isOpen) this.pause.dispose();
      this.dialogue.clear();
      this.tip.hide();
      this.end.show(result);
    });
  }
  openPauseMenu(): void {
    if (this.disposed || this.end.isOpen || this.game.world.rules.gameOver) return;
    this.safe('pause', () => { this.tip.hide(); this.pause.open(); });
  }

  /** Most recent located alert (for "jump to last alert"). */
  get lastAlertPos(): Vec2 | null { return this.notes.lastAlertPos; }
  get isModalOpen(): boolean { return this.pause.isOpen || this.end.isOpen || this.confirmOpen || !!this.mp?.isDialogOpen; }

  update(dtReal: number): void {
    if (this.disposed) return;
    const g = this.game;
    this.safe('top', () => this.top.update(dtReal));
    this.safe('fps', () => this.fps.update(dtReal, !!g.settings.showFps));
    this.safe('minimap', () => this.minimap.update(dtReal));
    this.safe('selection', () => this.sel.update());
    this.safe('card', () => this.card.update());
    this.safe('notes', () => this.notes.update(dtReal));
    this.safe('dialogue', () => this.dialogue.update(dtReal, g.paused));
    this.safe('idle', () => this.updateIdle(dtReal));
    if (this.mp) this.safe('mp', () => this.mp!.update(dtReal));
    setClass(this.el, 'ip-paused', g.paused);
    // saving indicator (manual saves, quicksaves and the Game's silent autosave all set game.saving)
    const saving = !!(g as unknown as { saving?: boolean }).saving || this.quickBusy;
    const shown = this.savingEl.style.display !== 'none';
    if (saving !== shown) this.savingEl.style.display = saving ? '' : 'none';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyCapture, true);
    for (const u of this.unsub) { try { u(); } catch { /* ignore */ } }
    this.unsub = [];
    this.mp?.dispose();
    this.pause.dispose();
    this.end.dispose();
    this.card.dispose();
    this.minimap.dispose();
    this.el.remove();
  }

  // ───────────────────────── internals ─────────────────────────
  private safe(name: string, fn: () => void): void {
    try { fn(); } catch (err) {
      const n = (this.errors.get(name) ?? 0) + 1;
      this.errors.set(name, n);
      if (n <= 2) console.error(`[ui] ${name} failed`, err);
    }
  }

  private sound(k: UiSound): void { try { this.game.app.audio.playUi(k); } catch { /* audio optional */ } }

  /** Capture-phase keys: modal screens swallow game hotkeys; F10 opens the menu as a fallback. */
  private onKeyCapture = (e: KeyboardEvent): void => {
    // an inline/modal confirmation owns the keyboard (it has its own Enter/Escape handling)
    if (this.confirmOpen || document.querySelector('.ip-confirm-ov')) { e.stopPropagation(); return; }
    if (e.key === 'F5' || e.key === 'F9') {
      e.preventDefault(); // never reload the page / open devtools shortcuts
      const t = e.target as HTMLElement | null;
      if (e.repeat || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return;
      e.stopPropagation();
      if (this.game.net) { if (!this.pause.isOpen && !this.end.isOpen) this.notes.toast('Saving and loading are disabled in multiplayer', 'warning'); return; }
      if (e.key === 'F5') void this.quickSave(); else void this.quickLoad();
      return;
    }
    // stopPropagation keeps game hotkeys from firing behind a modal; native defaults (Enter/Space on the
    // focused button, Tab focus, slider keys) still apply because we only preventDefault what we handle.
    if (this.pause.isOpen) {
      if (this.pause.handleKey(e)) e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (this.end.isOpen) {
      if (this.end.handleKey(e)) e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (this.mp?.isDialogOpen) { e.stopPropagation(); return; } // opponent-left dialog owns the keyboard
    if (e.key === 'F10') { e.preventDefault(); this.openPauseMenu(); }
  };

  /** F5: save to the Quicksave slot. */
  private async quickSave(): Promise<void> {
    const g = this.game;
    if (this.quickBusy || this.disposed) return;
    if (!g.canSave()) { this.notes.toast('Cannot save — the match has ended', 'warning'); this.sound('error'); return; }
    this.quickBusy = true;
    try {
      const meta = await g.saveGame('quick', `Quicksave · ${g.mission?.info.title ?? g.map.name}`);
      if (!this.disposed) { this.notes.toast(`Game saved — Quicksave ${fmtClock(meta.gameTime)}`, 'success'); this.sound('confirm'); }
    } catch (err) {
      if (!this.disposed) { this.notes.toast(`Save failed: ${errText(err)}`, 'warning'); this.sound('error'); }
    } finally { this.quickBusy = false; }
  }

  /** F9: load the Quicksave after confirmation (game paused while asking). */
  private async quickLoad(): Promise<void> {
    const g = this.game;
    if (this.confirmOpen || this.disposed) return;
    let meta = null;
    try { meta = (await g.app.saves.list()).find((m) => m.slot === 'quick') ?? null; } catch (err) { this.notes.toast(`Could not read saves: ${errText(err)}`, 'warning'); return; }
    if (!meta) { this.notes.toast('No quicksave yet — press F5 to quicksave', 'warning'); this.sound('error'); return; }
    if (this.end.isOpen || this.pause.isOpen) { this.pause.openPanel('load'); return; }
    const wasPaused = g.paused;
    g.pause();
    this.confirmOpen = true;
    this.tip.hide();
    const ok = await confirmModal(this.el, 'Quickload?', `Load “${meta.name}” (${fmtClock(meta.gameTime)} played, saved ${fmtDate(meta.savedAt)})? Unsaved progress will be lost.`, 'Load', true);
    this.confirmOpen = false;
    if (!ok) { if (!wasPaused && !this.disposed) g.resume(); return; }
    this.sound('confirm');
    try { await g.app.loadGame('quick'); }
    catch (err) {
      // the App falls back to the menu if the new match can't start; toast where we can
      if (!this.disposed) { this.notes.toast(`Quickload failed: ${errText(err)}`, 'warning'); if (!wasPaused) g.resume(); }
      else globalToast(`Quickload failed: ${errText(err)}`, 'warning');
    }
  }

  private subscribe(): void {
    const g = this.game, ev = g.world.events, local = g.localPlayerId;
    const me = g.world.player(local);
    this.unsub.push(
      ev.on('notEnough', ({ playerId, kind, message }) => {
        if (playerId !== local) return;
        if (kind === 'matter') this.top.flash('matter');
        else if (kind === 'energy') this.top.flash('energy');
        else if (kind === 'pop' || /capacity|supply|population/i.test(message)) this.top.flash('pop');
        this.notes.toast(notEnoughText(kind, message, me.faction), 'warning');
      }),
      ev.on('underAttack', ({ playerId, entity, pos }) => {
        if (playerId !== local) return;
        this.minimap.ping(pos, 0xff4d5e);
        const t = g.world.time;
        if (t - this.lastAttackToast < 6) return;
        this.lastAttackToast = t;
        const text = entity.kind === 'building' ? 'Our base is under attack' : entity.gatherer ? `Our ${(entity.def as UnitDef).name}s are under attack` : 'Our forces are under attack';
        this.notes.toast(text, 'alert');
        this.notes.alert(text, 'alert', t, pos, 'ui.alert');
      }),
      ev.on('researchComplete', ({ playerId, upgradeId, building }) => {
        if (playerId !== local) return;
        const name = UPGRADE_DEFS[upgradeId]?.name ?? upgradeId;
        this.notes.toast(`Research complete: ${name}`, 'success');
        this.sound('notify');
        this.notes.alert(`${name} researched`, 'success', g.world.time, building ? { ...building.pos } : null, 'ui.check');
      }),
      ev.on('productionComplete', ({ building, unit }) => {
        if (building.owner !== local || !isKeyUnit(unit)) return;
        this.notes.toast(`${unit.def.name} ready`, 'success');
        this.sound('notify');
        this.notes.alert(`${unit.def.name} ready`, 'success', g.world.time, { ...unit.pos }, 'ui.star');
      }),
      ev.on('constructionComplete', ({ building }) => {
        if (building.owner !== local) return;
        this.notes.toast(`${building.def.name} complete`, 'info');
        this.notes.alert(`${building.def.name} complete`, 'info', g.world.time, { ...building.pos }, 'ui.check');
      }),
      ev.on('resourceDepleted', ({ node }) => {
        const nearBase = g.world.list.some((e) => e.alive && e.owner === local && e.kind === 'building' && (e.def as BuildingDef).dropoff && Math.hypot(e.pos.x - node.pos.x, e.pos.y - node.pos.y) < 22);
        if (nearBase) this.notes.toast(`A Supply Cache near your base is exhausted`, 'info');
      }),
      ev.on('playerDefeated', ({ playerId }) => {
        if (playerId === local) return;
        const p = g.world.players.get(playerId);
        if (p && g.world.isEnemy(local, playerId)) this.notes.toast(`${FACTIONS[p.faction]?.name ?? p.name} has been eradicated`, 'success');
      }),
    );
  }

  private updateIdle(dt: number): void {
    this.idleT += dt;
    if (this.idleT < 0.25) return;
    this.idleT = 0;
    const g = this.game;
    const ids: number[] = [];
    for (const e of g.world.list) {
      if (e.alive && e.owner === g.localPlayerId && e.gatherer && e.orders.length === 0 && e.activity === 'idle') ids.push(e.id);
    }
    this.idleIds = ids;
    setClass(this.idleBtn, 'is-none', ids.length === 0);
    this.idleCount.set(String(ids.length));
  }

  private selectIdle(all: boolean): void {
    const g = this.game, sel = g.controls?.selection;
    const ids = this.idleIds.filter((id) => g.world.getAlive(id));
    if (!sel || ids.length === 0) return;
    this.sound('select');
    const ctl = g.controls as unknown as { selectIdleWorker?: (all?: boolean) => void } | undefined;
    if (typeof ctl?.selectIdleWorker === 'function') { ctl.selectIdleWorker(all); return; }
    if (all) { sel.set(ids); return; }
    this.idleIdx = (this.idleIdx + 1) % ids.length;
    const id = ids[this.idleIdx]!;
    sel.set([id]);
    const e = g.world.getAlive(id);
    if (e) g.renderer?.cameraCtl?.lookAt(e.pos);
  }
}
