/**
 * [ui] Save / Load panels shared by the pause menu and the main menu, plus a small confirm modal.
 *   createSavePanel — 8 manual slots (thumbnail, name, mission/map, difficulty, game clock, real date),
 *                     editable name, overwrite confirmation, delete, export per save.
 *   createLoadPanel — every save (Quicksave/Autosave included) newest first, load confirmation,
 *                     export/delete, "Import file…" (validated by SaveStore.importFile → stored in a free
 *                     manual slot or, if all are used, over the oldest after confirmation → offer to load).
 * Every failure is shown in the panel's error bar and as a toast — never console-only.
 */
import type { NotifyKind } from '../core/ui';
import type { UiSound } from '../audio/AudioEngine';
import type { AppApi, GameContext } from '../game/contracts';
import { MANUAL_SLOTS } from '../game/saves';
import type { SaveMeta } from '../sim/save';
import { el, esc } from './dom';
import { fmtClock } from './format';
import { glyphHtml } from './icons';

export interface SaveUiCtx {
  app: AppApi;
  /** running match (null in the main menu) */
  game: GameContext | null;
  toast(text: string, kind: NotifyKind): void;
  sound(k: UiSound): void;
}

export interface Panel { el: HTMLElement; dispose(): void }

export const slotLabel = (slot: string): string =>
  slot === 'quick' ? 'Quicksave' : slot === 'auto' ? 'Autosave' : /^slot(\d+)$/.test(slot) ? `Slot ${slot.slice(4)}` : slot;

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Toast that survives screen changes: the visible HUD / main menu listens for this window event. */
export const UI_TOAST_EVENT = 'ip:toast';
export function globalToast(text: string, kind: NotifyKind = 'warning'): void {
  window.dispatchEvent(new CustomEvent(UI_TOAST_EVENT, { detail: { text, kind } }));
}

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err ?? 'Unknown error'));

/** One-line summary for "Continue" etc. */
export function saveSummary(m: SaveMeta): string {
  return `${m.name} · ${fmtClock(m.gameTime)} · ${fmtDate(m.savedAt)}`;
}

/** Default save name: mission (or map) + game clock. */
export function defaultSaveName(game: GameContext): string {
  return `${game.mission?.info.title ?? game.map.name} · ${fmtClock(game.world.time)}`;
}

// ───────────────────────── confirm ─────────────────────────
/**
 * Inline confirmation overlay inside `host` (position:relative container). Resolves true/false.
 * Enter confirms, Escape cancels (handled by the overlay's own key listener; propagation stopped).
 */
export function confirmIn(host: HTMLElement, title: string, text: string, ok: string, danger = false): Promise<boolean> {
  host.querySelector(':scope > .ip-confirm-ov')?.remove();
  return new Promise((resolve) => {
    const ov = el('div', 'ip-confirm-ov', host);
    ov.dataset.testid = 'confirm';
    const box = el('div', 'ip-confirm-box', ov);
    el('div', 'ip-confirm-title', box, title);
    el('div', 'ip-confirm-txt', box, text);
    const row = el('div', 'ip-confirm-row', box);
    const yes = el('button', `ip-btn ${danger ? 'ip-btn-danger' : 'ip-btn-primary'}`, row, ok);
    const no = el('button', 'ip-btn', row, 'Cancel');
    yes.type = no.type = 'button';
    const done = (v: boolean) => { window.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(false); }
      else if (e.key === 'Enter' && document.activeElement !== no) { e.preventDefault(); e.stopImmediatePropagation(); done(true); }
    };
    window.addEventListener('keydown', onKey, true);
    yes.addEventListener('click', (e) => { e.stopPropagation(); done(true); });
    no.addEventListener('click', (e) => { e.stopPropagation(); done(false); });
    yes.focus();
  });
}

/** Full-screen modal confirm (F9 quickload in-game). */
export function confirmModal(parent: HTMLElement, title: string, text: string, ok: string, danger = false): Promise<boolean> {
  const m = el('div', 'ip-modal ip-confirm-modal', parent);
  m.dataset.testid = 'confirm-modal';
  const card = el('div', 'ip-panel ip-ecg ip-confirm-card', m);
  return confirmIn(card, title, text, ok, danger).finally(() => m.remove());
}

// ───────────────────────── slot card ─────────────────────────
function slotCard(parent: HTMLElement, slot: string, meta: SaveMeta | null, testid: string): { card: HTMLDivElement; actions: HTMLDivElement } {
  const card = el('div', `ip-slot${meta ? '' : ' is-empty'}`, parent);
  card.dataset.testid = testid;
  card.dataset.slot = slot;
  card.tabIndex = 0;
  const th = el('div', 'ip-slot-thumb', card);
  if (meta?.thumbnail) { const img = el('img', '', th); img.src = meta.thumbnail; img.alt = ''; }
  else th.innerHTML = glyphHtml(meta ? 'ui.flag' : 'ui.plus');
  const info = el('div', 'ip-slot-info', card);
  el('div', 'ip-slot-label', info, slotLabel(slot));
  if (meta) {
    el('div', 'ip-slot-name', info, meta.name);
    const where = meta.mode === 'campaign' ? (meta.missionTitle ?? meta.missionId ?? 'Campaign') : `Skirmish · ${meta.mapName}`;
    el('div', 'ip-slot-sub', info, `${where} · ${meta.difficulty[0]!.toUpperCase()}${meta.difficulty.slice(1)}`);
    el('div', 'ip-slot-time', info, `${fmtClock(meta.gameTime)} played · ${fmtDate(meta.savedAt)}`);
  } else {
    el('div', 'ip-slot-name is-dim', info, 'Empty slot');
    el('div', 'ip-slot-sub', info, 'Click to save here');
  }
  const actions = el('div', 'ip-slot-actions', card);
  return { card, actions };
}

function iconBtn(parent: HTMLElement, glyph: string, title: string, danger = false): HTMLButtonElement {
  const b = el('button', `ip-icon-btn${danger ? ' is-danger' : ''}`, parent);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = glyphHtml(glyph);
  return b;
}

async function exportSlot(ctx: SaveUiCtx, slot: string, setErr: (m: string) => void): Promise<void> {
  try {
    const s = await ctx.app.saves.get(slot);
    if (!s) throw new Error(`${slotLabel(slot)} is empty.`);
    ctx.app.saves.exportFile(s);
    ctx.toast(`Exported “${s.meta.name}”`, 'info');
  } catch (err) { const m = `Export failed: ${errText(err)}`; setErr(m); ctx.toast(m, 'warning'); }
}

function errBar(parent: HTMLElement): (msg: string) => void {
  const bar = el('div', 'ip-err', parent);
  bar.setAttribute('role', 'alert');
  bar.style.display = 'none';
  return (msg: string) => {
    bar.style.display = msg ? '' : 'none';
    bar.innerHTML = msg ? `${glyphHtml('ui.alert')}<span>${esc(msg)}</span>` : '';
  };
}

// ───────────────────────── save panel ─────────────────────────
export function createSavePanel(ctx: SaveUiCtx): Panel {
  const g = ctx.game;
  const root = el('div', 'ip-saveload');
  root.dataset.testid = 'save-panel';
  const can = !!g && g.canSave();
  const nameRow = el('div', 'ip-save-name', root);
  el('label', 'ip-caps', nameRow, 'Save name');
  const input = el('input', 'ip-input', nameRow);
  input.type = 'text';
  input.maxLength = 48;
  input.value = g ? defaultSaveName(g) : '';
  input.disabled = !can;
  input.addEventListener('keydown', (e) => e.stopPropagation()); // typing must not trigger game hotkeys
  const setErr = errBar(root);
  if (!can) setErr('Saving is not possible right now — the match has ended.');
  const grid = el('div', 'ip-slots', root);
  let disposed = false;
  let busy = false;

  const doSave = async (slot: string, existing: SaveMeta | null) => {
    if (!g || busy || !g.canSave()) return;
    if (existing && !(await confirmIn(root, 'Overwrite save?', `“${existing.name}” in ${slotLabel(slot)} will be replaced.`, 'Overwrite', true))) return;
    busy = true;
    root.classList.add('is-busy');
    setErr('');
    try {
      const meta = await g.saveGame(slot, input.value.trim() || undefined);
      ctx.sound('confirm');
      ctx.toast(`Game saved — ${meta.name}`, 'success');
    } catch (err) {
      const m = `Save failed: ${errText(err)}`;
      setErr(m); ctx.toast(m, 'warning'); ctx.sound('error');
    } finally {
      busy = false;
      root.classList.remove('is-busy');
      if (!disposed) void render();
    }
  };

  const render = async () => {
    let metas: SaveMeta[] = [];
    try { metas = await ctx.app.saves.list(); } catch (err) { setErr(`Could not read saves: ${errText(err)}`); }
    if (disposed) return;
    const bySlot = new Map(metas.map((m) => [m.slot, m]));
    grid.textContent = '';
    for (const slot of MANUAL_SLOTS) {
      const meta = bySlot.get(slot) ?? null;
      const { card, actions } = slotCard(grid, slot, meta, 'save-slot');
      if (!can) card.classList.add('is-disabled');
      const go = () => { ctx.sound('click'); void doSave(slot, meta); };
      card.addEventListener('click', go);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) { e.preventDefault(); go(); } });
      if (meta) {
        iconBtn(actions, 'ui.download', 'Export file').addEventListener('click', (e) => { e.stopPropagation(); void exportSlot(ctx, slot, setErr); });
        iconBtn(actions, 'ui.cross', 'Delete save', true).addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!(await confirmIn(root, 'Delete save?', `“${meta.name}” will be permanently removed.`, 'Delete', true))) return;
          try { await ctx.app.saves.delete(slot); ctx.toast(`Deleted “${meta.name}”`, 'info'); } catch (err) { const m = `Delete failed: ${errText(err)}`; setErr(m); ctx.toast(m, 'warning'); }
          if (!disposed) void render();
        });
      }
    }
  };
  void render();
  return { el: root, dispose: () => { disposed = true; root.remove(); } };
}

// ───────────────────────── load panel ─────────────────────────
export function createLoadPanel(ctx: SaveUiCtx): Panel {
  const root = el('div', 'ip-saveload');
  root.dataset.testid = 'load-panel';
  const bar = el('div', 'ip-load-bar', root);
  el('div', 'ip-set-hint', bar, ctx.game ? 'Loading replaces the current match — unsaved progress is lost.' : 'Quicksave (F5) and Autosave (every 3 minutes) appear here too.');
  const imp = el('button', 'ip-btn', bar);
  imp.type = 'button';
  imp.innerHTML = `${glyphHtml('ui.upload')}<span>Import file…</span>`;
  const file = el('input', '', root);
  file.type = 'file';
  file.accept = '.json,application/json';
  file.style.display = 'none';
  file.dataset.testid = 'import-input';
  const setErr = errBar(root);
  const list = el('div', 'ip-slots ip-slots-load', root);
  let disposed = false;

  const load = async (slotOrMeta: string, name: string) => {
    if (ctx.game && !(await confirmIn(root, 'Load this save?', `Load “${name}”? Unsaved progress in the current match will be lost.`, 'Load', true))) return;
    ctx.sound('confirm');
    setErr('');
    try {
      await ctx.app.loadGame(slotOrMeta);
    } catch (err) {
      const m = `Could not load “${name}”: ${errText(err)}`;
      if (!disposed) setErr(m);
      ctx.toast(m, 'warning');
      ctx.sound('error');
    }
  };

  imp.addEventListener('click', () => { ctx.sound('click'); file.value = ''; file.click(); });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    setErr('');
    try {
      const save = await ctx.app.saves.importFile(f);
      let slot = await ctx.app.saves.freeManualSlot();
      if (!slot) {
        const manual = (await ctx.app.saves.list()).filter((m) => (MANUAL_SLOTS as readonly string[]).includes(m.slot));
        const oldest = manual[manual.length - 1];
        if (!oldest) throw new Error('No manual slot available.');
        if (!(await confirmIn(root, 'All slots are full', `Overwrite “${oldest.name}” (${slotLabel(oldest.slot)}) with the imported save?`, 'Overwrite', true))) return;
        slot = oldest.slot;
      }
      save.meta = { ...save.meta, slot };
      await ctx.app.saves.put(save);
      ctx.toast(`Imported “${save.meta.name}” into ${slotLabel(slot)}`, 'success');
      if (!disposed) await render();
      if (!disposed && (await confirmIn(root, 'Save imported', `Load “${save.meta.name}” now?`, 'Load now'))) {
        try { await ctx.app.loadGame(slot); } catch (err) { const m = `Could not load “${save.meta.name}”: ${errText(err)}`; if (!disposed) setErr(m); ctx.toast(m, 'warning'); }
      }
    } catch (err) {
      const m = `Import failed: ${errText(err)}`;
      if (!disposed) setErr(m);
      ctx.toast(m, 'warning');
      ctx.sound('error');
    }
  });

  const render = async () => {
    let metas: SaveMeta[] = [];
    try { metas = await ctx.app.saves.list(); } catch (err) { setErr(`Could not read saves: ${errText(err)}`); }
    if (disposed) return;
    list.textContent = '';
    if (!metas.length) { el('div', 'ip-slots-empty', list, 'No saved games yet. Save from the in-game menu, or press F5 for a quicksave.'); return; }
    for (const meta of metas) {
      const { card, actions } = slotCard(list, meta.slot, meta, 'load-slot');
      const go = () => { ctx.sound('click'); void load(meta.slot, meta.name); };
      card.addEventListener('click', go);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) { e.preventDefault(); go(); } });
      iconBtn(actions, 'ui.download', 'Export file').addEventListener('click', (e) => { e.stopPropagation(); void exportSlot(ctx, meta.slot, setErr); });
      iconBtn(actions, 'ui.cross', 'Delete save', true).addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await confirmIn(root, 'Delete save?', `“${meta.name}” will be permanently removed.`, 'Delete', true))) return;
        try { await ctx.app.saves.delete(meta.slot); ctx.toast(`Deleted “${meta.name}”`, 'info'); } catch (err) { const m = `Delete failed: ${errText(err)}`; setErr(m); ctx.toast(m, 'warning'); }
        if (!disposed) void render();
      });
    }
  };
  void render();
  return { el: root, dispose: () => { disposed = true; root.remove(); } };
}
