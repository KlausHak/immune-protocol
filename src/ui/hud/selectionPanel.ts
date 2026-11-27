/**
 * [ui] Selection panel (bottom centre). Three modes, one fixed-size box (no layout shift):
 *   empty  — idle monitor trace + hint
 *   single — icon, name, role, owner, hp bar, status line, and one bottom row:
 *            stats (armour/damage/range/cooldown/speed/sight) | production queue (click = cancel) |
 *            construction progress (+ cancel) — resources show remaining/gatherers
 *   multi  — up to 30 unit icons tinted by hp (click = select one, Shift = remove, Ctrl = that type)
 * DOM is built when the selection changes; per-frame work only diffs numbers.
 */
import type { BuildingDef, Entity, FactionId, ProductionItem, UnitDef, WeaponDef } from '../../core/types';
import { FACTIONS, UNIT_DEFS, UPGRADE_DEFS, tryGetDef } from '../../data';
import type { GameContext } from '../../game/contracts';
import { sortBySubgroup } from '../../input/subgroups';
import { el, esc, HtmlSlot, setClass, setStyle, TextSlot } from '../dom';
import { costHtml, fmt1, fmtClock, fmtInt } from '../format';
import { glyphHtml, iconHtml } from '../icons';
import type { Tooltip } from '../tooltip';

const MAX_GRID = 30;
type Mode = 'empty' | 'single' | 'multi';

interface StatCell { root: HTMLDivElement; ico: HtmlSlot; label: TextSlot; val: HtmlSlot }
interface Cell { el: HTMLDivElement; id: number; fill: HTMLElement; last: number }

export function hpColor(frac: number): string {
  return frac > 0.6 ? '#4ee6a0' : frac > 0.3 ? '#ffb648' : '#ff5a6b';
}

function itemName(it: ProductionItem): string {
  return it.kind === 'unit' ? UNIT_DEFS[it.defId]?.name ?? it.defId : UPGRADE_DEFS[it.defId]?.name ?? it.defId;
}

export class SelectionPanel {
  readonly el: HTMLDivElement;
  private mode: Mode | null = null;
  // single
  private curId: number | null = null;
  private portraitBox: HTMLDivElement;
  private portrait: HtmlSlot;
  private name: TextSlot;
  private owner: HTMLSpanElement;
  private ownerTxt: TextSlot;
  private role: TextSlot;
  private hpBar: HTMLDivElement;
  private hpFill: HTMLDivElement;
  private hpTxt: TextSlot;
  private hpKey = '';
  private statusDot: HTMLSpanElement;
  private statusTxt: TextSlot;
  private statusExtra: TextSlot;
  private rowStats: HTMLDivElement;
  private rowQueue: HTMLDivElement;
  private rowBuild: HTMLDivElement;
  private activeRow: HTMLDivElement | null = null;
  private stats: StatCell[] = [];
  private statsKey = '';
  private qCur: { slot: HTMLDivElement; icon: HtmlSlot; name: TextSlot; time: TextSlot; fill: HTMLDivElement };
  private qRest: Array<{ slot: HTMLDivElement; icon: HtmlSlot }> = [];
  private qKey = '';
  private qProg = -1;
  private bLabel: TextSlot;
  private bTime: TextSlot;
  private bFill: HTMLDivElement;
  private bCancel: HTMLButtonElement;
  private bProg = -1;
  // multi
  private grid: HTMLDivElement;
  private cells: Cell[] = [];
  private multiKey = '';

  constructor(parent: HTMLElement, private game: GameContext, private tip: Tooltip) {
    this.el = el('div', 'ip-panel ip-ecg ip-sel', parent);
    this.el.dataset.testid = 'selection';

    // empty
    const empty = el('section', 'ip-sel-empty', this.el);
    const ei = el('div', 'ip-sel-empty-inner', empty);
    el('div', 'ip-sel-empty-ecg', ei);
    el('div', 'ip-sel-empty-txt', ei, 'No selection');
    el('div', 'ip-sel-empty-sub', ei, 'Click a unit or structure · drag to box-select');

    // single
    const single = el('section', 'ip-sel-single', this.el);
    const top = el('div', 'ip-sel-top', single);
    this.portraitBox = el('div', 'ip-sel-portrait', top);
    this.portrait = new HtmlSlot(this.portraitBox);
    const main = el('div', 'ip-sel-main', top);
    const head = el('div', 'ip-sel-head', main);
    this.name = new TextSlot(el('span', 'ip-sel-name', head));
    this.owner = el('span', 'ip-sel-owner', head);
    this.ownerTxt = new TextSlot(this.owner);
    this.role = new TextSlot(el('div', 'ip-sel-role', main));
    this.hpBar = el('div', 'ip-bar ip-sel-hp', main);
    this.hpFill = el('div', 'ip-bar-fill', this.hpBar);
    this.hpTxt = new TextSlot(el('span', 'ip-bar-txt', this.hpBar));
    const st = el('div', 'ip-sel-status', main);
    this.statusDot = el('span', 'ip-dot', st);
    this.statusTxt = new TextSlot(el('span', '', st));
    this.statusExtra = new TextSlot(el('span', 'ip-sel-extra', st));

    const bottom = el('div', 'ip-sel-bottom', single);
    this.rowStats = el('div', 'ip-stats', bottom);
    for (let i = 0; i < 6; i++) {
      const root = el('div', 'ip-stat', this.rowStats);
      const ico = new HtmlSlot(el('span', '', root));
      const label = new TextSlot(el('span', 'ip-stat-l', root));
      const val = new HtmlSlot(el('span', 'ip-stat-v', root));
      this.stats.push({ root, ico, label, val });
    }

    this.rowQueue = el('div', 'ip-queue', bottom);
    const cur = el('div', 'ip-q-cur', this.rowQueue);
    const curSlot = el('div', 'ip-q-slot', cur);
    const qinfo = el('div', 'ip-q-info', cur);
    const qname = el('div', 'ip-q-name', qinfo);
    const qn = el('span', '', qname);
    const qt = el('span', '', qname);
    const qbar = el('div', 'ip-bar ip-q-bar', qinfo);
    this.qCur = { slot: curSlot, icon: new HtmlSlot(curSlot), name: new TextSlot(qn), time: new TextSlot(qt), fill: el('div', 'ip-bar-fill', qbar) };
    this.bindQueueSlot(curSlot, 0);
    const rest = el('div', 'ip-q-rest', this.rowQueue);
    for (let i = 1; i < 5; i++) {
      const slot = el('div', 'ip-q-slot is-small', rest);
      this.qRest.push({ slot, icon: new HtmlSlot(slot) });
      this.bindQueueSlot(slot, i);
    }

    this.rowBuild = el('div', 'ip-build', bottom);
    const binfo = el('div', 'ip-build-info', this.rowBuild);
    const blab = el('div', 'ip-build-label', binfo);
    this.bLabel = new TextSlot(el('span', '', blab));
    this.bTime = new TextSlot(el('span', '', blab));
    const bbar = el('div', 'ip-bar ip-build-bar', binfo);
    this.bFill = el('div', 'ip-bar-fill', bbar);
    this.bCancel = el('button', 'ip-btn ip-btn-danger', this.rowBuild);
    this.bCancel.type = 'button';
    this.bCancel.innerHTML = `${glyphHtml('ui.cross')}<span>Cancel</span>`;
    this.bCancel.addEventListener('click', () => {
      const e = this.single();
      if (!e || !e.construction || e.owner !== this.game.localPlayerId) return;
      this.game.issue({ type: 'cancelConstruction', playerId: this.game.localPlayerId, buildingId: e.id });
      this.sound('click');
    });
    this.bCancel.addEventListener('mouseenter', () => this.tip.show('<div class="ip-tip-title">Cancel construction</div><div class="ip-tip-body">Demolish the foundation and recover 75% of its cost.</div>', { rect: this.bCancel.getBoundingClientRect(), place: 'above' }, this.bCancel));
    this.bCancel.addEventListener('mouseleave', () => this.tip.hide(this.bCancel));

    // multi
    const multi = el('section', 'ip-sel-multi', this.el);
    this.grid = el('div', 'ip-sel-multi-grid', multi);
  }

  private sound(k: 'click' | 'select' | 'error'): void { try { this.game.app.audio.playUi(k); } catch { /* optional */ } }

  private single(): Entity | undefined {
    return this.curId != null ? this.game.world.getAlive(this.curId) : undefined;
  }

  private setMode(m: Mode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.el.classList.remove('m-empty', 'm-single', 'm-multi');
    this.el.classList.add(`m-${m}`);
    if (m !== 'single') this.curId = null;
    if (m !== 'multi') this.multiKey = '';
    this.tip.hide();
  }

  update(): void {
    const sel = this.game.controls?.selection;
    const ents = sel ? sel.entities() : [];
    if (ents.length === 0) { this.setMode('empty'); return; }
    if (ents.length === 1) { this.setMode('single'); this.updateSingle(ents[0]!); return; }
    this.setMode('multi');
    let primary: Entity | undefined;
    try { primary = sel?.primary(); } catch { primary = undefined; }
    this.updateMulti(ents, primary);
  }

  // ───────────────────────── single ─────────────────────────
  private updateSingle(e: Entity): void {
    const g = this.game;
    if (e.id !== this.curId) {
      this.curId = e.id;
      this.portrait.set(iconHtml(e.defId));
      this.name.set(e.def.name);
      const def = e.def;
      const fac: FactionId = def.kind === 'resource' ? 'neutral' : def.faction;
      this.role.set(def.kind === 'resource' ? `Neutral resource node · ${FACTIONS[this.localFaction()].resourceNames.matter}` : def.role);
      const enemy = g.world.isEnemy(g.localPlayerId, e.owner);
      const neutral = e.owner === 0;
      setClass(this.portraitBox, 'is-enemy', enemy);
      setClass(this.portraitBox, 'is-neutral', neutral);
      this.ownerTxt.set(neutral ? 'Neutral' : e.owner === g.localPlayerId ? FACTIONS[fac].short : enemy ? FACTIONS[fac].short : 'Allied');
      const oc = neutral ? '#ffc94d' : enemy ? '#ff6b9a' : `#${(g.world.players.get(e.owner)?.color ?? 0x2fd6c6).toString(16).padStart(6, '0')}`;
      this.owner.style.setProperty('--oc', oc);
      this.hpKey = ''; this.statsKey = ''; this.qKey = ''; this.qProg = -1; this.bProg = -1;
    }
    // hp / remaining
    let frac: number, txt: string;
    if (e.resource) {
      frac = e.resource.amount / Math.max(1, e.resource.initial);
      txt = `${fmtInt(e.resource.amount)} / ${fmtInt(e.resource.initial)}`;
    } else {
      frac = e.hp / Math.max(1, e.stats.maxHp);
      txt = `${Math.ceil(e.hp)} / ${Math.round(e.stats.maxHp)}`;
    }
    frac = Math.max(0, Math.min(1, frac));
    const key = `${txt}|${frac.toFixed(3)}`;
    if (key !== this.hpKey) {
      this.hpKey = key;
      setStyle(this.hpFill, 'transform', `scaleX(${frac.toFixed(4)})`);
      setStyle(this.hpBar, '--bar', e.resource ? '#ffc94d' : hpColor(frac));
      this.hpTxt.set(txt);
    }
    const s = this.statusOf(e);
    this.statusTxt.set(s.text);
    this.statusExtra.set(s.extra ?? '');
    setStyle(this.statusDot, '--sc', s.color);

    // bottom row
    const own = e.owner === g.localPlayerId;
    let row: HTMLDivElement = this.rowStats;
    if (e.construction) row = this.rowBuild;
    else if (own && e.production && e.production.queue.length > 0) row = this.rowQueue;
    if (row !== this.activeRow) {
      this.activeRow?.classList.remove('is-on');
      row.classList.add('is-on');
      this.activeRow = row;
    }
    if (row === this.rowStats) this.updateStats(e);
    else if (row === this.rowQueue) this.updateQueue(e);
    else this.updateBuild(e, own);
  }

  private localFaction(): FactionId { return this.game.world.player(this.game.localPlayerId).faction; }

  private statusOf(e: Entity): { text: string; color: string; extra?: string } {
    const g = this.game, w = g.world;
    const f = FACTIONS[this.localFaction()];
    const order = e.orders[0];
    const regen = e.stats.hpRegen > 0 && e.kind !== 'resource' ? `Regenerates ${fmt1(e.stats.hpRegen)} hp/s` : undefined;
    if (e.kind === 'resource') {
      const n = e.resource?.activeGatherers ?? 0;
      return { text: n > 0 ? `${n} worker${n === 1 ? '' : 's'} gathering` : 'Untapped', color: '#ffc94d' };
    }
    if (e.construction) return { text: 'Under construction', color: '#ffb648' };
    const enemy = w.isEnemy(g.localPlayerId, e.owner);
    if (e.kind === 'building') {
      const it = e.production?.queue[0];
      if (it && !enemy) return { text: `${it.kind === 'unit' ? 'Training' : 'Researching'} ${itemName(it)}`, color: '#35e2d0', extra: e.rally ? 'Rally point set' : regen };
      if (enemy) return { text: 'Hostile structure', color: '#ff5a6b', extra: regen };
      const prov = (e.def as BuildingDef).provides;
      return { text: (e.def as BuildingDef).weapons.length ? 'Guarding' : prov.pop || prov.energyPerSec ? 'Operational' : 'Ready', color: '#4ee6a0', extra: e.rally ? 'Rally point set' : regen };
    }
    const named = (id: number | null | undefined) => { const t = w.getAlive(id ?? null); return t ? t.def.name : ''; };
    const carrying = e.gatherer?.carrying ?? 0;
    const carryTxt = carrying > 0 ? `Carrying ${Math.round(carrying)} ${f.resourceNames.matter}` : regen;
    switch (e.activity) {
      case 'gathering': return { text: `Gathering ${f.resourceNames.matter}`, color: '#ffc94d', extra: carryTxt };
      case 'carrying': return { text: `Returning ${f.resourceNames.matter}`, color: '#63f0da', extra: carryTxt };
      case 'building': {
        const id = order?.type === 'build' ? order.defId : order?.type === 'construct' ? w.getAlive(order.targetId)?.defId : undefined;
        return { text: `Constructing ${id ? tryGetDef(id)?.name ?? 'structure' : 'structure'}`, color: '#ffb648', extra: carryTxt };
      }
      case 'attacking': {
        const t = named(e.combat?.targetId ?? (order?.type === 'attack' ? order.targetId : null));
        return { text: t ? `Engaging ${t}` : 'Engaging', color: '#ff5a6b', extra: carryTxt };
      }
      case 'healing': return { text: 'Treating the wounded', color: '#4ee6a0', extra: carryTxt };
      case 'casting': return { text: 'Using ability', color: '#b48cff', extra: carryTxt };
      case 'producing': return { text: 'Working', color: '#35e2d0', extra: carryTxt };
      case 'moving': {
        let t = 'Moving';
        switch (order?.type) {
          case 'attackMove': t = 'Attack-moving'; break;
          case 'patrol': t = 'Patrolling'; break;
          case 'follow': t = `Following ${named(order.targetId) || 'ally'}`; break;
          case 'gather': t = carrying > 0 ? `Returning ${f.resourceNames.matter}` : 'Heading to Supply Cache'; break;
          case 'returnCargo': t = `Returning ${f.resourceNames.matter}`; break;
          case 'build': t = `Heading to build ${tryGetDef(order.defId)?.name ?? 'site'}`; break;
          case 'construct': t = 'Heading to construction site'; break;
          case 'repair': t = `Moving to repair ${named(order.targetId)}`; break;
          case 'attack': t = `Pursuing ${named(order.targetId) || 'target'}`; break;
          case 'heal': t = 'Moving to treat'; break;
          default: break;
        }
        return { text: t, color: '#6fd3ff', extra: carryTxt };
      }
      default: {
        if (order?.type === 'hold') return { text: 'Holding position', color: '#97b8b5', extra: carryTxt };
        if (order?.type === 'repair') return { text: `Repairing ${named(order.targetId)}`, color: '#ffb648', extra: carryTxt };
        if (enemy) return { text: 'Hostile', color: '#ff5a6b', extra: carryTxt };
        return { text: e.gatherer ? 'Idle — awaiting orders' : 'Idle', color: '#62837f', extra: carryTxt };
      }
    }
  }

  private updateStats(e: Entity): void {
    const st = e.stats, def = e.def;
    const key = `${e.id}|${st.armor}|${st.damageMul}|${st.damageAdd}|${st.rangeAdd}|${st.cooldownMul}|${st.speed}|${st.sight}|${st.healRateMul}|${st.gatherCapacityAdd}|${e.resource ? Math.floor(e.resource.amount) + ':' + e.resource.activeGatherers : ''}`;
    if (key === this.statsKey) return;
    this.statsKey = key;
    type Chip = [glyph: string, label: string, value: string] | null;
    const chips: Chip[] = [];
    const up = (v: number, base: number) => (v > base + 1e-6 ? ` style="color:#7dffc0"` : '');
    const num = (v: number, base: number, suffix = '') => `<span${up(v, base)}>${fmt1(v)}${suffix}</span>`;
    const weaponChips = (w: WeaponDef | undefined) => {
      if (!w) return;
      const dmg = (w.damage + st.damageAdd) * st.damageMul;
      const bonus = Object.entries(w.bonus ?? {})[0];
      const bonusTxt = bonus ? `<em>+${fmt1((bonus[1] ?? 0) * st.damageMul)} vs ${esc(bonus[0])}</em>` : '';
      chips.push(['ui.damage', 'Damage', `${num(dmg, w.damage)}${bonusTxt}`]);
      const rng = w.range + st.rangeAdd;
      chips.push(['ui.range', 'Range', w.minRange ? `${fmt1(w.minRange)}–${num(rng, w.range)}` : num(rng, w.range)]);
      chips.push(['ui.cooldown', 'Cooldown', `${num(w.cooldown * st.cooldownMul, w.cooldown * 1.0001)}s`]);
    };
    if (def.kind === 'resource') {
      const f = FACTIONS[this.localFaction()];
      chips.push(['ui.supplies', 'Remaining', fmtInt(e.resource?.amount ?? 0)]);
      chips.push(['ui.worker', 'Gatherers', String(e.resource?.activeGatherers ?? 0)]);
      chips.push(['ui.info', 'Resource', esc(f.resourceNames.matter)]);
    } else if (def.kind === 'unit') {
      chips.push(['ui.armor', 'Armour', num(st.armor, def.armor)]);
      if (def.heal) {
        chips.push(['ui.heal', 'Heals', `${num(def.heal.rate * st.healRateMul, def.heal.rate)} hp/s`]);
        chips.push(['ui.range', 'Range', fmt1(def.heal.range)]);
        chips.push(null);
      } else if (def.weapons[0]) weaponChips(def.weapons[0]);
      else chips.push(['ui.damage', 'Damage', '—'], null, null);
      chips.push(['ui.speed', 'Speed', num(st.speed, def.speed)]);
      if (def.gather) chips.push(['ui.supplies', 'Carry', num(def.gather.capacity + st.gatherCapacityAdd, def.gather.capacity)]);
      else chips.push(['ui.sight', 'Sight', fmt1(st.sight)]);
    } else {
      chips.push(['ui.armor', 'Armour', num(st.armor, def.armor)]);
      const p = def.provides;
      const fac = FACTIONS[def.faction] ?? FACTIONS.hospital;
      const prov = [p.pop ? `+${p.pop} ${fac.popName}` : '', p.energyPerSec ? `+${fmt1(p.energyPerSec)}/s` : ''].filter(Boolean).join(' · ');
      if (def.weapons[0]) weaponChips(def.weapons[0]);
      chips.push(['ui.plus', 'Provides', prov || '—']);
      chips.push(['ui.sight', 'Sight', fmt1(st.sight)]);
    }
    for (let i = 0; i < this.stats.length; i++) {
      const c = chips[i] ?? null, cell = this.stats[i]!;
      setClass(cell.root, 'is-blank', !c);
      if (!c) continue;
      cell.ico.set(glyphHtml(c[0]));
      cell.label.set(c[1]);
      cell.val.set(c[2]);
    }
  }

  private bindQueueSlot(slot: HTMLDivElement, index: number): void {
    slot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const e = this.single();
      const q = e?.production?.queue;
      if (!e || !q || !q[index] || e.owner !== this.game.localPlayerId) return;
      const it = q[index]!;
      const pid = this.game.localPlayerId;
      if (it.kind === 'upgrade' && q.findIndex((x) => x.kind === 'upgrade') === index) this.game.issue({ type: 'cancelResearch', playerId: pid, buildingId: e.id });
      else this.game.issue({ type: 'cancelTrain', playerId: pid, buildingId: e.id, index });
      this.sound('click');
      this.tip.hide(slot);
    });
    slot.addEventListener('mouseenter', () => {
      const it = this.single()?.production?.queue[index];
      if (!it) return;
      const fac = this.localFaction();
      this.tip.show(`<div class="ip-tip-title">${esc(itemName(it))}</div><div class="ip-tip-cost">${costHtml(it.cost, fac)}</div><div class="ip-tip-body">${index === 0 ? `${Math.round((it.progress / Math.max(0.001, it.total)) * 100)}% complete. ` : ''}Click to cancel — full refund.</div>`,
        { rect: slot.getBoundingClientRect(), place: 'above' }, slot);
    });
    slot.addEventListener('mouseleave', () => this.tip.hide(slot));
  }

  private updateQueue(e: Entity): void {
    const q = e.production!.queue;
    const key = q.map((it) => it.defId).join(',');
    if (key !== this.qKey) {
      this.qKey = key;
      this.qProg = -1;
      const first = q[0];
      this.qCur.icon.set(first ? iconHtml(first.defId) : '');
      setClass(this.qCur.slot, 'is-filled', !!first);
      this.qCur.name.set(first ? `${first.kind === 'unit' ? '' : 'Research: '}${itemName(first)}` : '');
      this.qRest.forEach((r, i) => {
        const it = q[i + 1];
        r.icon.set(it ? iconHtml(it.defId) : '');
        setClass(r.slot, 'is-filled', !!it);
      });
    }
    const first = q[0];
    if (!first) return;
    const p = Math.max(0, Math.min(1, first.progress / Math.max(0.001, first.total)));
    if (Math.abs(p - this.qProg) > 0.002) {
      this.qProg = p;
      setStyle(this.qCur.fill, 'transform', `scaleX(${p.toFixed(4)})`);
    }
    this.qCur.time.set(fmtClock(Math.max(0, first.total - first.progress)));
  }

  private updateBuild(e: Entity, own: boolean): void {
    const c = e.construction;
    if (!c) return;
    const p = Math.max(0, Math.min(1, c.progress / Math.max(0.001, c.total)));
    if (Math.abs(p - this.bProg) > 0.002) {
      this.bProg = p;
      setStyle(this.bFill, 'transform', `scaleX(${p.toFixed(4)})`);
    }
    const builder = this.game.world.getAlive(c.builderId);
    this.bLabel.set(`${builder ? 'Constructing' : 'Awaiting builder'} · ${Math.floor(p * 100)}%`);
    this.bTime.set(`${fmtClock(Math.max(0, c.total - c.progress))} left`);
    this.bCancel.style.display = own ? '' : 'none';
  }

  // ───────────────────────── multi ─────────────────────────
  private updateMulti(ents: Entity[], primary: Entity | undefined): void {
    const sorted = sortBySubgroup(ents);
    const shown = sorted.slice(0, sorted.length > MAX_GRID ? MAX_GRID - 1 : MAX_GRID);
    const activeDef = primary?.defId ?? sorted[0]?.defId;
    const key = `${shown.map((e) => e.id).join(',')}|${sorted.length}|${activeDef}`;
    if (key !== this.multiKey) {
      this.multiKey = key;
      this.grid.textContent = '';
      this.cells = shown.map((e) => this.makeCell(e, e.defId === activeDef));
      if (sorted.length > shown.length) {
        const more = el('div', 'ip-mu is-more', this.grid, `+${sorted.length - shown.length}`);
        more.title = `${sorted.length} selected`;
      }
    }
    for (const c of this.cells) {
      const e = this.game.world.getAlive(c.id);
      const frac = e ? Math.max(0, Math.min(1, e.hp / Math.max(1, e.stats.maxHp))) : 0;
      const q = Math.round(frac * 50) / 50;
      if (q === c.last) continue;
      c.last = q;
      setStyle(c.fill, 'transform', `scaleX(${q})`);
      setStyle(c.el, '--bar', hpColor(q));
      setStyle(c.el, '--hurt', q > 0.6 ? '0' : ((0.6 - q) * 0.9).toFixed(2));
    }
  }

  private makeCell(e: Entity, active: boolean): Cell {
    const cell = el('div', `ip-mu${active ? ' is-active' : ''}`, this.grid);
    cell.innerHTML = iconHtml(e.defId);
    const hp = el('div', 'ip-mu-hp', cell);
    const fill = el('i', '', hp);
    const id = e.id, defId = e.defId;
    cell.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const sel = this.game.controls?.selection;
      if (!sel) return;
      if (ev.shiftKey) sel.remove([id]);
      else if (ev.ctrlKey || ev.metaKey) sel.set(sel.entities().filter((x) => x.defId === defId).map((x) => x.id));
      else {
        sel.set([id]);
        if (ev.detail >= 2) { const t = this.game.world.getAlive(id); if (t) this.game.renderer?.cameraCtl?.lookAt(t.pos); }
      }
      this.sound('select');
      this.tip.hide(cell);
    });
    cell.addEventListener('mouseenter', () => {
      const t = this.game.world.getAlive(id);
      if (!t) return;
      const role = t.def.kind === 'resource' ? '' : (t.def as UnitDef | BuildingDef).role;
      this.tip.show(`<div class="ip-tip-title">${esc(t.def.name)}</div><div class="ip-tip-role">${esc(role)}</div><div class="ip-tip-body">${Math.ceil(t.hp)} / ${Math.round(t.stats.maxHp)} hp<br>Click: select · Shift: deselect · Ctrl: select all of this type</div>`,
        { rect: cell.getBoundingClientRect(), place: 'above' }, cell);
    });
    cell.addEventListener('mouseleave', () => this.tip.hide(cell));
    return { el: cell, id, fill, last: -1 };
  }

  dispose(): void { this.el.remove(); }
}
