/**
 * [ui] Command card (5×3) rendering game.controls.getCommandCard(): icon, hotkey badge, disabled/active
 * state, cooldown sweep, rich tooltip (cost with affordability, time, pop, description, disabledReason).
 * Slots are created once; each frame only changed slots touch the DOM. Clicks call the CURRENT button's
 * activate() (looked up by slot at click time, never a stale closure).
 */
import type { FactionId } from '../../core/types';
import { tryGetDef, UPGRADE_DEFS, ABILITY_DEFS } from '../../data';
import type { CommandButton, GameContext } from '../../game/contracts';
import { el, esc, HtmlSlot, retrigger, setClass, setStyle, TextSlot } from '../dom';
import { fmt1 } from '../format';
import { glyphHtml, iconHtml, resourceGlyphKey } from '../icons';
import { FACTIONS } from '../../data';
import type { Tooltip } from '../tooltip';

const SLOTS = 15;

interface SlotView {
  btn: HTMLButtonElement;
  icon: HtmlSlot;
  iconKey: string;
  key: TextSlot;
  cd: HTMLDivElement;
  cdTxt: TextSlot;
  sig: string;
}

export class CommandCard {
  readonly el: HTMLDivElement;
  private slots: SlotView[] = [];
  private buttons: Array<CommandButton | undefined> = [];
  private hover = -1;
  private frame = 0;
  private faction: FactionId;
  /** Called when a disabled button is clicked (HUD shows the reason as a toast). */
  onDisabled: ((reason: string) => void) | null = null;

  constructor(parent: HTMLElement, private game: GameContext, private tip: Tooltip) {
    this.faction = game.world.player(game.localPlayerId).faction;
    this.el = el('div', 'ip-panel ip-ecg ip-card', parent);
    this.el.dataset.testid = 'command-card';
    for (let i = 0; i < SLOTS; i++) {
      const btn = el('button', 'ip-cmd is-empty', this.el);
      btn.type = 'button';
      btn.tabIndex = -1;
      const ico = el('div', 'ip-cmd-ico', btn);
      const cd = el('div', 'ip-cmd-cd', btn);
      const cdTxt = el('div', 'ip-cmd-cdtxt', btn);
      const key = el('span', 'ip-cmd-key', btn);
      const view: SlotView = { btn, icon: new HtmlSlot(ico), iconKey: '', key: new TextSlot(key), cd, cdTxt: new TextSlot(cdTxt), sig: '' };
      this.slots.push(view);
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.press(i); });
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      btn.addEventListener('mouseenter', () => { this.hover = i; this.showTip(); });
      btn.addEventListener('mouseleave', () => { if (this.hover === i) { this.hover = -1; this.tip.hide(this.el); } });
    }
    window.addEventListener('keydown', this.onKey);
  }

  private press(i: number): void {
    const b = this.buttons[i];
    if (!b) return;
    if (!b.enabled) {
      try { this.game.app.audio.playUi('error'); } catch { /* optional */ }
      if (b.disabledReason) this.onDisabled?.(b.disabledReason);
      return;
    }
    try { this.game.app.audio.playUi('click'); } catch { /* optional */ }
    try { b.activate(); } catch (err) { console.error('[ui] command activate failed', b.id, err); }
    retrigger(this.slots[i]!.btn, 'is-pressed');
    window.setTimeout(() => this.slots[i]?.btn.classList.remove('is-pressed'), 140);
  }

  /** Visual feedback when the player uses the hotkey (Controls performs the action). */
  private onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.repeat || e.key.length !== 1) return;
    const k = e.key.toUpperCase();
    const i = this.buttons.findIndex((b) => b && b.enabled && b.hotkey.toUpperCase() === k);
    if (i < 0) return;
    const btn = this.slots[i]!.btn;
    retrigger(btn, 'is-pressed');
    window.setTimeout(() => btn.classList.remove('is-pressed'), 140);
  };

  update(): void {
    // The card model is cheap but not free: refresh at ~30 Hz (every other frame).
    if ((this.frame++ & 1) === 1) return;
    let card: CommandButton[] = [];
    try { card = this.game.controls?.getCommandCard() ?? []; } catch (err) { if (this.frame < 4) console.error('[ui] getCommandCard failed', err); }
    const next: Array<CommandButton | undefined> = new Array(SLOTS).fill(undefined);
    for (const b of card) if (b && b.slot >= 0 && b.slot < SLOTS && !next[b.slot]) next[b.slot] = b;
    this.buttons = next;
    for (let i = 0; i < SLOTS; i++) this.paint(i, next[i]);
    if (this.hover >= 0) this.showTip(true);
  }

  private paint(i: number, b: CommandButton | undefined): void {
    const v = this.slots[i]!;
    const cd = b?.cooldown && b.cooldown > 0 ? Math.min(1, b.cooldown) : 0;
    const sig = b ? `${b.id}|${b.icon}|${b.hotkey}|${b.enabled ? 1 : 0}|${b.active ? 1 : 0}|${cd.toFixed(3)}` : '';
    if (sig === v.sig) return;
    v.sig = sig;
    setClass(v.btn, 'is-empty', !b);
    if (!b) { v.btn.removeAttribute('aria-label'); return; }
    if (b.icon !== v.iconKey) { v.iconKey = b.icon; v.icon.set(iconHtml(b.icon || b.id)); }
    v.key.set((b.hotkey || '').toUpperCase());
    setClass(v.btn, 'is-disabled', !b.enabled);
    setClass(v.btn, 'is-active', !!b.active);
    setClass(v.btn, 'is-cd', cd > 0);
    if (cd > 0) {
      setStyle(v.cd, '--cd', `${(cd * 100).toFixed(1)}%`);
      v.cdTxt.set(this.cooldownText(b, cd));
    }
    v.btn.setAttribute('aria-label', `${b.label}${b.hotkey ? ` (${b.hotkey})` : ''}`);
  }

  private cooldownText(b: CommandButton, frac: number): string {
    const abilityId = b.id.startsWith('ability.') ? b.id.slice(8) : b.icon;
    const a = ABILITY_DEFS[abilityId];
    return a ? String(Math.ceil(frac * a.cooldown)) : '';
  }

  private showTip(refresh = false): void {
    const b = this.buttons[this.hover];
    if (!b) { this.tip.hide(this.el); return; }
    const html = this.tipHtml(b);
    if (refresh && this.tip.currentOwner === this.el) { this.tip.update(html, this.el); return; }
    const r = this.el.getBoundingClientRect();
    this.tip.show(html, { rect: r, place: 'above', align: 'end' }, this.el);
  }

  private tipHtml(b: CommandButton): string {
    const fac = FACTIONS[this.faction] ?? FACTIONS.hospital;
    const me = this.game.world.player(this.game.localPlayerId);
    const cost = b.cost;
    const parts: string[] = [];
    if (cost?.matter) parts.push(`<span class="ip-cost ip-cost-m${me.resources.matter < cost.matter ? ' is-short' : ''}" title="${esc(fac.resourceNames.matter)}">${glyphHtml(resourceGlyphKey(this.faction, 'matter'))}${Math.round(cost.matter)}</span>`);
    if (cost?.energy) parts.push(`<span class="ip-cost ip-cost-e${me.resources.energy < cost.energy ? ' is-short' : ''}" title="${esc(fac.resourceNames.energy)}">${glyphHtml(resourceGlyphKey(this.faction, 'energy'))}${Math.round(cost.energy)}</span>`);
    if (cost?.pop) parts.push(`<span class="ip-cost ip-cost-p${me.popUsed + cost.pop > me.popCap ? ' is-short' : ''}" title="${esc(fac.popName)}">${glyphHtml(resourceGlyphKey(this.faction, 'pop'))}${cost.pop}</span>`);
    if (b.time) parts.push(`<span class="ip-cost ip-cost-t" title="Time">${glyphHtml('ui.time')}${fmt1(b.time)}s</span>`);
    const ref = this.refInfo(b);
    const body = b.tooltip || ref.description;
    return `<div class="ip-tip-title">${esc(b.label)}${b.hotkey ? `<span class="ip-key">${esc(b.hotkey.toUpperCase())}</span>` : ''}</div>`
      + (ref.role ? `<div class="ip-tip-role">${esc(ref.role)}</div>` : '')
      + (parts.length ? `<div class="ip-tip-cost">${parts.join('')}</div>` : '')
      + (body ? `<div class="ip-tip-body">${esc(body)}</div>` : '')
      + (!b.enabled && b.disabledReason ? `<div class="ip-tip-warn">${glyphHtml('ui.alert')}${esc(b.disabledReason)}</div>` : '');
  }

  /** Role/description from data for train/build/research/ability buttons (complements b.tooltip). */
  private refInfo(b: CommandButton): { role?: string; description?: string } {
    const id = b.id.includes('.') ? b.id.slice(b.id.indexOf('.') + 1) : b.id;
    const def = tryGetDef(id) ?? tryGetDef(b.icon);
    if (def && def.kind !== 'resource') return { role: def.role, description: def.description };
    const up = UPGRADE_DEFS[id] ?? UPGRADE_DEFS[b.icon];
    if (up) return { role: 'Research', description: up.description };
    const ab = ABILITY_DEFS[id] ?? ABILITY_DEFS[b.icon];
    if (ab) return { role: `Ability · ${ab.cooldown}s cooldown`, description: ab.description };
    return {};
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.el.remove();
  }
}
