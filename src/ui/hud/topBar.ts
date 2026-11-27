/**
 * [ui] Top bar ("vital signs" strip): faction-named resources with icons, Beds/Colony, game clock with an
 * ECG pulse, speed/pause indicator, menu button. Also the centre-top mission timer and the FPS readout.
 */
import { MAX_POP } from '../../config';
import type { BuildingDef, FactionId } from '../../core/types';
import { FACTIONS } from '../../data';
import type { GameContext } from '../../game/contracts';
import { el, esc, retrigger, setClass, TextSlot } from '../dom';
import { fmt1, fmtClock, popBuildingName } from '../format';
import { glyphHtml, resourceGlyphKey } from '../icons';
import type { Tooltip } from '../tooltip';

type ResKey = 'matter' | 'energy' | 'pop';

interface ResView { root: HTMLDivElement; val: HTMLSpanElement; rate: TextSlot | null; last: string }

const CHANNEL: Record<FactionId, Record<ResKey, string>> = {
  hospital: { matter: '#63f0da', energy: '#ffc94d', pop: '#d6e8ff' },
  pathogen: { matter: '#a8ff4f', energy: '#e889ff', pop: '#ffc4ee' },
  neutral: { matter: '#e0e0e0', energy: '#e0e0e0', pop: '#e0e0e0' },
};

export class TopBar {
  readonly el: HTMLDivElement;
  private res: Record<ResKey, ResView>;
  private clock: TextSlot;
  private speed: HTMLDivElement;
  private speedTxt: TextSlot;
  private income = 0;
  private incomeT = 1;
  private faction: FactionId;

  constructor(parent: HTMLElement, private game: GameContext, private tip: Tooltip, onMenu: () => void) {
    const me = game.world.player(game.localPlayerId);
    this.faction = me.faction;
    const f = FACTIONS[me.faction] ?? FACTIONS.hospital;
    this.el = el('div', 'ip-panel ip-ecg ip-topbar', parent);
    this.el.dataset.testid = 'resources';
    const mk = (k: ResKey, label: string, withRate: boolean): ResView => {
      const root = el('div', 'ip-res', this.el);
      root.style.setProperty('--c', CHANNEL[this.faction][k]);
      const ico = el('span', 'ip-res-ico', root);
      ico.innerHTML = glyphHtml(resourceGlyphKey(this.faction, k));
      const txt = el('span', 'ip-res-txt', root);
      const lab = el('span', 'ip-res-label', txt, label);
      let rate: TextSlot | null = null;
      if (withRate) rate = new TextSlot(el('span', 'ip-res-rate', lab));
      const val = el('span', 'ip-res-val', txt, '0');
      root.addEventListener('mouseenter', () => this.tip.show(this.resTip(k), { rect: root.getBoundingClientRect(), place: 'below', align: 'center' }, root));
      root.addEventListener('mouseleave', () => this.tip.hide(root));
      return { root, val, rate, last: '' };
    };
    this.res = {
      matter: mk('matter', f.resourceNames.matter, false),
      energy: mk('energy', f.resourceNames.energy, true),
      pop: mk('pop', f.popName, false),
    };
    const grp = el('div', 'ip-tb-group', this.el);
    const clk = el('div', 'ip-clock', grp);
    clk.innerHTML = glyphHtml('ui.pulse');
    this.clock = new TextSlot(el('span', '', clk, '00:00'));
    clk.title = 'Elapsed game time';
    this.speed = el('div', 'ip-speed', grp);
    this.speedTxt = new TextSlot(this.speed);
    this.speed.title = 'Game speed ( + / − )';
    const menu = el('button', 'ip-tb-btn', grp);
    menu.type = 'button';
    menu.innerHTML = `${glyphHtml('ui.menu')}<span>Menu</span><span class="ip-key">F10</span>`;
    menu.addEventListener('click', (e) => { e.stopPropagation(); onMenu(); });
  }

  /** Red flash on a resource readout (not-enough feedback). */
  flash(k: ResKey): void { retrigger(this.res[k].root, 'is-flash'); }

  private resTip(k: ResKey): string {
    const f = FACTIONS[this.faction] ?? FACTIONS.hospital;
    const me = this.game.world.player(this.game.localPlayerId);
    const worker = this.faction === 'pathogen' ? 'Spore Drones' : 'Orderly Bots';
    if (k === 'matter') {
      return `<div class="ip-tip-title">${glyphHtml(resourceGlyphKey(this.faction, 'matter'))}${esc(f.resourceNames.matter)}</div>`
        + `<div class="ip-tip-body">Gathered by ${worker} from Supply Caches and returned to your HQ. Spent on every unit and structure.</div>`;
    }
    if (k === 'energy') {
      return `<div class="ip-tip-title">${glyphHtml(resourceGlyphKey(this.faction, 'energy'))}${esc(f.resourceNames.energy)}</div>`
        + `<div class="ip-tip-body">Generated passively by your HQ and ${this.faction === 'pathogen' ? 'Fermentation Vats' : 'Backup Generators'}. Required for advanced units and research.</div>`
        + `<div class="ip-tip-role" style="margin:6px 0 0">Income: +${fmt1(this.income)} per second</div>`;
    }
    return `<div class="ip-tip-title">${glyphHtml(resourceGlyphKey(this.faction, 'pop'))}${esc(f.popName)} ${me.popUsed} / ${me.popCap}</div>`
      + `<div class="ip-tip-body">Every unit occupies ${esc(f.popName)}. Build a ${esc(popBuildingName(this.faction))} for +8 (maximum ${MAX_POP}).</div>`;
  }

  update(dt: number): void {
    const g = this.game;
    const me = g.world.player(g.localPlayerId);
    this.setVal('matter', String(Math.floor(me.resources.matter)));
    this.setVal('energy', String(Math.floor(me.resources.energy)));
    this.setVal('pop', `${me.popUsed}<small>/${me.popCap}</small>`, true);
    setClass(this.res.pop.root, 'is-capped', me.popCap > 0 && me.popUsed >= me.popCap);
    this.incomeT += dt;
    if (this.incomeT >= 1) {
      this.incomeT = 0;
      let inc = 0;
      for (const e of g.world.list) {
        if (e.alive && e.owner === g.localPlayerId && e.kind === 'building' && !e.construction) inc += (e.def as BuildingDef).provides.energyPerSec ?? 0;
      }
      this.income = inc;
      this.res.energy.rate?.set(inc > 0 ? ` +${fmt1(inc)}/s` : '');
    }
    this.clock.set(fmtClock(g.world.time));
    const paused = g.paused;
    this.speedTxt.set(paused ? 'PAUSED' : `${fmt1(g.speed)}×`);
    setClass(this.speed, 'is-paused', paused);
    setClass(this.speed, 'is-fast', !paused && Math.abs(g.speed - 1) > 1e-3);
  }

  private setVal(k: ResKey, v: string, html = false): void {
    const r = this.res[k];
    if (r.last === v) return;
    r.last = v;
    if (html) r.val.innerHTML = v; else r.val.textContent = v;
  }

  dispose(): void { this.el.remove(); }
}

/** Centre-top mission timer. Shows exactly what the mission sets; pulses red when a countdown is low. */
export class MissionTimer {
  readonly el: HTMLDivElement;
  private label: TextSlot;
  private val: TextSlot;
  private prev: number | null = null;
  private counting = false;

  constructor(parent: HTMLElement) {
    this.el = el('div', 'ip-panel ip-ecg ip-mtimer', parent);
    this.el.dataset.testid = 'mission-timer';
    this.label = new TextSlot(el('div', 'ip-mtimer-label', this.el));
    this.val = new TextSlot(el('div', 'ip-mtimer-val', this.el));
    this.el.style.display = 'none';
  }

  set(label: string | null, seconds?: number): void {
    if (label == null) { this.el.style.display = 'none'; this.prev = null; return; }
    this.el.style.display = '';
    this.label.set(label);
    const s = seconds ?? 0;
    if (this.prev != null && s !== this.prev) this.counting = s < this.prev;
    this.prev = s;
    this.val.set(fmtClock(Math.ceil(s)));
    setClass(this.el, 'is-urgent', this.counting && s <= 60);
  }

  dispose(): void { this.el.remove(); }
}

/** Optional FPS readout (settings.showFps). */
export class FpsMeter {
  readonly el: HTMLDivElement;
  private txt: TextSlot;
  private acc = 0;
  private frames = 0;

  constructor(parent: HTMLElement) {
    this.el = el('div', 'ip-fps', parent);
    this.txt = new TextSlot(this.el);
    this.el.style.display = 'none';
  }

  update(dt: number, visible: boolean): void {
    const shown = this.el.style.display !== 'none';
    if (visible !== shown) this.el.style.display = visible ? '' : 'none';
    if (!visible) { this.acc = 0; this.frames = 0; return; }
    this.acc += dt; this.frames++;
    if (this.acc >= 0.5) {
      const fps = this.frames / this.acc;
      this.txt.set(`${Math.round(fps)} FPS · ${(1000 / Math.max(1, fps)).toFixed(1)} ms`);
      setClass(this.el, 'is-low', fps < 45);
      this.acc = 0; this.frames = 0;
    }
  }

  dispose(): void { this.el.remove(); }
}
