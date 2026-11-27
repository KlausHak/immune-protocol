/**
 * [ui] OWNER: HUD agent. Title screen: animated dusk-campus backdrop, logo, and pages for Campaign
 * (mission list with locked/completed state + briefing + difficulty), Skirmish (map list with previews +
 * difficulty), Settings, How to Play (DESIGN §3 cheat sheet + field manual) and Credits.
 * Keyboard: ↑/↓ move focus, Enter activates, Esc goes back. UI sounds via app.audio.playUi.
 */
import { CAMPAIGN_NAME, GAME_SUBTITLE, GAME_TITLE, MAX_POP } from '../config';
import type { Difficulty, MapData } from '../core/types';
import { CAMPAIGN, type MissionInfo } from '../campaign';
import { MAPS, type MapInfo } from '../map';
import { FACTIONS } from '../data';
import type { AppApi } from '../game/contracts';
import type { UiSound } from '../audio/AudioEngine';
import { el, esc } from './dom';
import { glyphHtml, iconHtml } from './icons';
import { mapPreview } from './mapRender';
import { MenuBackground } from './menu/background';
import { createSettingsPanel, type SettingsPanel } from './settingsPanel';
import { ensureUiStyles } from './styles';

type Screen = 'home' | 'campaign' | 'skirmish' | 'settings' | 'howto' | 'credits';

const PREF_KEY = 'immune-protocol.menu.v1';
const DIFFS: Array<[Difficulty, string, string]> = [
  ['easy', 'Easy', 'A slower, forgiving outbreak.'],
  ['normal', 'Normal', 'The intended challenge.'],
  ['hard', 'Hard', 'Faster mutations, larger waves.'],
  ['brutal', 'Brutal', 'The Contagion gathers faster and never rests.'],
];

const KEYS: Array<[string[][], string]> = [
  [[['LMB']], 'Select · drag to box-select (units before buildings)'],
  [[['Shift', 'LMB'], ['Ctrl', 'LMB']], 'Add / remove · select all of that type on screen (or double-click)'],
  [[['Tab']], 'Cycle the active subgroup'],
  [[['RMB']], 'Smart command — move, attack, gather, return, construct, repair, follow; sets rally for buildings. Shift queues'],
  [[['A'], ['M'], ['S'], ['H'], ['P']], 'Attack-move (then click) · Move · Stop · Hold · Patrol'],
  [[['G'], ['C'], ['R']], 'Gather · Return cargo · Repair'],
  [[['B'], ['V']], 'Build menu · Advanced build menu'],
  [[['Esc'], ['F10']], 'Cancel / back / pause menu · Menu'],
  [[['Ctrl', '1–9'], ['1–9']], 'Assign control group · select it (double-tap centres the camera)'],
  [[['F1'], ['Backspace'], ['Space']], 'Idle worker · cycle bases · jump to last alert'],
  [[['Arrows'], ['MMB']], 'Scroll the camera (or touch the screen edge) · middle-drag to pan'],
  [[['Wheel'], ['Alt', 'Wheel']], 'Zoom · rotate (or Alt + middle-drag)'],
  [[['Minimap']], 'Click / drag to look · right-click to send selected units'],
  [[['+'], ['−']], 'Game speed (skirmish)'],
];

const TEAM: Array<[string, string]> = [
  ['Architect', 'Poured the foundations, guards the contracts and merges everyone’s dreams.'],
  ['Movement & Vision', 'Taught two hundred units to share one corridor. Mostly politely.'],
  ['Combat', 'Balances UV against capsids, one decimal at a time.'],
  ['Economy', 'Counts every crate of Supplies. Twice. Then audits the Orderlies.'],
  ['Opponent AI', 'Plays The Contagion. Please do not invite it to parties.'],
  ['Map Maker', 'Rebuilt the Meilahti campus tile by (fictional) tile.'],
  ['Campaign Writer', 'Wrote Dr. Virtanen’s orders and Strain Omega’s threats.'],
  ['Render Core', 'Camera, light and picking — keeps the lens on the action.'],
  ['Environment Artist', 'Nordic dusk, birches, granite and that very cold sea.'],
  ['Hospital Artist', 'Ivory panels, teal stripes and suspiciously clean robots.'],
  ['Pathogen Artist', 'Made translucent goo look this good. We apologise.'],
  ['VFX Artist', 'Sprays, beams and the occasional glorious splat.'],
  ['Controls Engineer', 'Every click, drag and hotkey — including the one you just pressed.'],
  ['Audio Engineer', 'Synthesised every blip, hum and heartbeat from pure maths.'],
  ['UI / HUD Designer', 'Panels, portraits, icons — and the screen you are reading.'],
];

interface Prefs { difficulty: Difficulty; missionId?: string; mapId?: string }

function loadPrefs(): Prefs {
  try { return { difficulty: 'normal', ...(JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Partial<Prefs>) }; } catch { return { difficulty: 'normal' }; }
}

const mapCache = new Map<string, MapData>();
function mapData(m: MapInfo): MapData | null {
  let d = mapCache.get(m.id);
  if (!d) {
    try { d = m.build(); } catch (err) { console.error('[ui] map preview failed', m.id, err); return null; }
    mapCache.set(m.id, d);
  }
  return d;
}

export class MainMenu {
  private el: HTMLDivElement;
  private bg: MenuBackground;
  private nav: HTMLDivElement;
  private navBtns = new Map<Screen, HTMLButtonElement>();
  private right: HTMLDivElement;
  private ticker: HTMLDivElement;
  private screen: Screen = 'home';
  private prefs: Prefs = loadPrefs();
  private settings: SettingsPanel | null = null;
  private lastHover: Element | null = null;
  private lastHoverT = 0;
  private timers: number[] = [];

  constructor(private root: HTMLElement, private app: AppApi) {
    ensureUiStyles();
    this.el = el('div', 'ip-root ip-menu');
    this.el.dataset.testid = 'main-menu';
    this.bg = new MenuBackground(this.el);
    el('div', 'ip-menu-vignette', this.el);
    const shell = el('div', 'ip-menu-shell', this.el);
    const left = el('div', 'ip-menu-left', shell);
    this.buildLogo(left);
    this.nav = el('div', 'ip-nav', left);
    this.nav.setAttribute('role', 'menu');
    const item = (s: Screen, glyph: string, label: string, desc: string) => {
      const b = el('button', 'ip-nav-btn', this.nav);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.innerHTML = `${glyphHtml(glyph)}<span class="ip-nav-txt"><span class="ip-nav-label">${esc(label)}</span><span class="ip-nav-desc">${esc(desc)}</span></span>`;
      b.addEventListener('click', () => { this.sound('click'); this.open(s); });
      this.navBtns.set(s, b);
    };
    item('campaign', 'ui.flag', 'Campaign', `${CAMPAIGN_NAME} · ${CAMPAIGN.length} mission${CAMPAIGN.length === 1 ? '' : 's'}`);
    item('skirmish', 'ui.swords', 'Skirmish', 'Free battle against The Contagion AI');
    item('settings', 'ui.sliders', 'Settings', 'Audio, controls and display');
    item('howto', 'ui.book', 'How to Play', 'Controls cheat sheet & field manual');
    item('credits', 'ui.people', 'Credits', 'The fifteen-agent team');
    const foot = el('div', 'ip-menu-foot', left);
    foot.innerHTML = `<b>A fictionalised HUS Meilahti hospital campus.</b> Not affiliated with or endorsed by HUS Helsinki University Hospital. `
      + `Medical symbols used: the white plus on teal and the green pharmacy cross.<br>v0.1 · three.js · WebAudio · 2026`;
    this.right = el('div', 'ip-menu-right', shell);
    this.ticker = el('div', 'ip-panel ip-ecg ip-ticker');
    this.ticker.innerHTML = `<span class="ip-ticker-dot"></span><span><b>CODE RED</b> · Unknown pathogen detected — Old Laundry, North Campus</span><span class="ip-ticker-time">Meilahti · −3 °C · Dusk</span>`;

    this.el.addEventListener('pointerover', this.onHover);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.renderRight();
  }

  show(): void {
    ensureUiStyles();
    if (!this.el.isConnected) this.root.appendChild(this.el);
    window.addEventListener('keydown', this.onKey);
    this.bg.start();
    this.screen = this.screen === 'campaign' || this.screen === 'skirmish' ? this.screen : 'home';
    this.renderRight();
    this.focusFirst();
  }

  hide(): void {
    window.removeEventListener('keydown', this.onKey);
    this.bg.stop();
    this.settings?.dispose();
    this.settings = null;
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    this.el.remove();
  }

  dispose(): void { this.hide(); this.bg.dispose(); }

  /** Open a page directly ('campaign' | 'skirmish' | 'settings' | 'howto' | 'credits' | 'home'). */
  openScreen(screen: string): void {
    const ok: Screen[] = ['home', 'campaign', 'skirmish', 'settings', 'howto', 'credits'];
    if ((ok as string[]).includes(screen)) this.open(screen as Screen);
  }

  // ───────────────────────── helpers ─────────────────────────
  private sound(k: UiSound): void { try { this.app.audio.playUi(k); } catch { /* optional */ } }

  private savePrefs(): void { try { localStorage.setItem(PREF_KEY, JSON.stringify(this.prefs)); } catch { /* ignore */ } }

  private onHover = (e: PointerEvent): void => {
    const t = (e.target as Element | null)?.closest('button, .ip-mission, .ip-map-card');
    if (!t || t === this.lastHover) return;
    this.lastHover = t;
    const now = performance.now();
    if (now - this.lastHoverT < 45 || (t as HTMLButtonElement).disabled) return;
    this.lastHoverT = now;
    this.sound('hover');
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (this.screen !== 'home') { e.preventDefault(); this.sound('close'); this.open('home'); }
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.tagName === 'INPUT') return; // sliders use arrows
    const scope: HTMLElement = this.screen === 'home' || !active || this.nav.contains(active) ? this.nav : this.right;
    const items = [...scope.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')].filter((b) => b.offsetParent !== null);
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(active as HTMLElement);
    const n = i < 0 ? 0 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[n]!.focus();
  };

  private focusFirst(): void {
    const b = this.screen === 'home' ? this.nav.querySelector<HTMLElement>('button') : this.right.querySelector<HTMLElement>('.ip-btn-primary:not([disabled]), button');
    try { b?.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  private open(s: Screen): void {
    if (s !== this.screen) this.sound(s === 'home' ? 'close' : 'open');
    this.screen = s;
    this.renderRight();
    this.focusFirst();
  }

  private buildLogo(parent: HTMLElement): void {
    const logo = el('div', 'ip-logo', parent);
    const [w1, ...rest] = GAME_TITLE.split(' ');
    const [s1, ...srest] = GAME_SUBTITLE.split(' ');
    logo.innerHTML = `
      <div class="ip-logo-mark">
        <div class="ip-logo-badge"><svg viewBox="0 0 20 20"><path d="M7.4 2.5 H12.6 V7.4 H17.5 V12.6 H12.6 V17.5 H7.4 V12.6 H2.5 V7.4 H7.4 Z" fill="#f4fffd"/></svg></div>
        <div class="ip-logo-org">HUS · Meilahti<span>Campus Defence Network</span></div>
      </div>
      <h1 class="ip-logo-title">${esc(w1 ?? GAME_TITLE)}<span class="ip-logo-p">${esc(rest.join(' '))}</span></h1>
      <svg class="ip-logo-ecg" viewBox="0 0 400 34" preserveAspectRatio="none" aria-hidden="true">
        <path class="ip-ecg-glow" d="M0 20 H150 L158 15 L164 20 H172 L180 3 L188 31 L195 11 L201 20 H214 Q222 12 230 20 H400"/>
        <path class="ip-ecg-main" d="M0 20 H150 L158 15 L164 20 H172 L180 3 L188 31 L195 11 L201 20 H214 Q222 12 230 20 H400"/>
      </svg>
      <div class="ip-logo-sub"><b>${esc(s1 ?? '')}</b> ${esc(srest.join(' '))}</div>`;
  }

  private renderRight(): void {
    this.settings?.dispose();
    this.settings = null;
    for (const [s, b] of this.navBtns) b.classList.toggle('is-current', s === this.screen);
    this.right.textContent = '';
    if (this.screen === 'home') { this.right.appendChild(this.ticker); return; }
    const page = el('div', 'ip-panel ip-ecg ip-page', this.right);
    const head = el('div', 'ip-page-head', page);
    const titles: Record<Exclude<Screen, 'home'>, [string, string]> = {
      campaign: ['Campaign', CAMPAIGN_NAME],
      skirmish: ['Skirmish', 'Choose your battleground'],
      settings: ['Options', 'Settings'],
      howto: ['Field manual', 'How to Play'],
      credits: ['Made by', 'Credits'],
    };
    const [kicker, title] = titles[this.screen];
    const ht = el('div', '', head);
    el('div', 'ip-page-kicker', ht, kicker);
    el('h2', 'ip-page-title', ht, title);
    const back = el('button', 'ip-btn', head);
    back.type = 'button';
    back.innerHTML = `<span>Back</span><span class="ip-key">Esc</span>`;
    back.addEventListener('click', () => { this.sound('close'); this.open('home'); });
    const body = el('div', 'ip-page-body', page);
    switch (this.screen) {
      case 'campaign': this.renderCampaign(body); break;
      case 'skirmish': this.renderSkirmish(body); break;
      case 'settings': this.settings = createSettingsPanel(this.app); body.appendChild(this.settings.el); break;
      case 'howto': this.renderHowTo(body); break;
      case 'credits': this.renderCredits(body); break;
    }
  }

  private difficultyField(parent: HTMLElement): void {
    const f = el('div', 'ip-field', parent);
    el('div', 'ip-caps', f, 'Difficulty');
    const seg = el('div', 'ip-seg', f);
    seg.setAttribute('role', 'group');
    const hint = el('div', 'ip-set-hint', f);
    const paint = () => {
      for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.d === this.prefs.difficulty));
      hint.textContent = DIFFS.find((d) => d[0] === this.prefs.difficulty)?.[2] ?? '';
    };
    for (const [d, label] of DIFFS) {
      const b = el('button', '', seg, label);
      b.type = 'button';
      b.dataset.d = d;
      b.addEventListener('click', () => { this.prefs.difficulty = d; this.savePrefs(); paint(); this.sound('click'); });
    }
    paint();
  }

  // ───────────────────────── campaign ─────────────────────────
  private missions(): Array<MissionInfo & { unlocked: boolean; done: boolean }> {
    const done = new Set(this.app.progress.completed);
    const list = [...CAMPAIGN].sort((a, b) => a.order - b.order);
    return list.map((m, i) => ({ ...m, done: done.has(m.id), unlocked: i === 0 || done.has(list[i - 1]!.id) }));
  }

  private renderCampaign(body: HTMLElement): void {
    const ms = this.missions();
    if (!ms.length) { el('div', 'ip-set-hint', body, 'No missions available.'); return; }
    let sel = ms.find((m) => m.id === this.prefs.missionId && m.unlocked) ?? ms.find((m) => m.unlocked && !m.done) ?? [...ms].reverse().find((m) => m.unlocked) ?? ms[0]!;
    const grid = el('div', 'ip-camp', body);
    const list = el('div', 'ip-mlist', grid);
    const brief = el('div', 'ip-brief', grid);
    const items = new Map<string, HTMLButtonElement>();
    const paintBrief = () => {
      for (const [id, b] of items) b.classList.toggle('is-sel', id === sel.id);
      brief.textContent = '';
      el('div', 'ip-brief-kicker', brief, `${sel.subtitle} · Briefing`);
      el('div', 'ip-brief-title', brief, sel.title);
      for (const p of sel.briefing) el('p', '', brief, p);
      if (sel.objectivesPreview.length) {
        const o = el('div', 'ip-brief-obj', brief);
        el('div', 'ip-caps', o, 'Objectives');
        const ul = el('ul', '', o);
        for (const t of sel.objectivesPreview) { const li = el('li', '', ul); li.innerHTML = `${glyphHtml('ui.target')}<span>${esc(t)}</span>`; }
      }
      if (!sel.unlocked) {
        const prev = ms[ms.indexOf(sel) - 1];
        const lock = el('div', 'ip-brief-lock', brief);
        lock.innerHTML = `${glyphHtml('ui.lock')}<span>Complete ${esc(prev ? `${prev.subtitle}: ${prev.title}` : 'the previous mission')} to unlock.</span>`;
      }
      const foot = el('div', 'ip-brief-foot', brief);
      this.difficultyField(foot);
      const start = el('button', 'ip-btn ip-btn-primary', foot);
      start.type = 'button';
      start.innerHTML = `${glyphHtml('ui.play')}<span>${sel.done ? 'Replay mission' : 'Start mission'}</span>`;
      start.disabled = !sel.unlocked;
      start.addEventListener('click', () => {
        if (!sel.unlocked) return;
        this.sound('confirm');
        this.prefs.missionId = sel.id; this.savePrefs();
        this.app.startGame({ mode: 'campaign', missionId: sel.id, difficulty: this.prefs.difficulty });
      });
    };
    ms.forEach((m, i) => {
      const b = el('button', `ip-mission${m.done ? ' is-done' : ''}${m.unlocked ? '' : ' is-locked'}`, list);
      b.type = 'button';
      b.innerHTML = `<span class="ip-mission-num">${String(i + 1).padStart(2, '0')}</span><span class="ip-mission-txt"><span class="ip-mission-sub">${esc(m.subtitle)}</span><span class="ip-mission-title">${esc(m.title)}</span></span>`
        + `<span class="ip-mission-state">${glyphHtml(m.done ? 'ui.check' : m.unlocked ? 'ui.play' : 'ui.lock')}</span>`;
      b.title = m.done ? 'Completed' : m.unlocked ? 'Available' : 'Locked';
      b.addEventListener('click', () => {
        sel = m;
        if (!m.unlocked) { this.sound('error'); b.classList.remove('is-shake'); void b.offsetWidth; b.classList.add('is-shake'); }
        else { this.sound('select'); this.prefs.missionId = m.id; this.savePrefs(); }
        paintBrief();
      });
      items.set(m.id, b);
    });
    paintBrief();
  }

  // ───────────────────────── skirmish ─────────────────────────
  private renderSkirmish(body: HTMLElement): void {
    const maps = MAPS.filter((m) => m.skirmish);
    if (!maps.length) { el('div', 'ip-set-hint', body, 'No skirmish maps available.'); return; }
    let sel = maps.find((m) => m.id === this.prefs.mapId) ?? maps.find((m) => m.id === 'meilahti') ?? maps[0]!;
    const grid = el('div', 'ip-skirm', body);
    const list = el('div', 'ip-mlist', grid);
    const detail = el('div', 'ip-brief', grid);
    const cards = new Map<string, { b: HTMLButtonElement; thumb: HTMLDivElement }>();
    const paint = () => {
      for (const [id, c] of cards) c.b.classList.toggle('is-sel', id === sel.id);
      detail.textContent = '';
      el('div', 'ip-brief-kicker', detail, 'Skirmish · Battleground');
      el('div', 'ip-brief-title', detail, sel.name);
      const row = el('div', '', detail);
      row.style.cssText = 'display:flex;gap:calc(20 * var(--ip-u));align-items:flex-start';
      const prev = el('div', 'ip-map-preview', row);
      prev.style.flex = '0 0 calc(220 * var(--ip-u))';
      const info = el('div', '', row);
      info.style.flex = '1';
      el('p', '', info, sel.description);
      const md = mapCache.get(sel.id);
      const meta = el('div', 'ip-map-meta', info);
      meta.innerHTML = `<div><b>Size</b>${md ? `${md.width} × ${md.height}` : '—'}</div><div><b>Players</b>${sel.players}</div><div><b>Caches</b>${md ? md.resources.length : '—'}</div>`;
      const vs = el('div', 'ip-vs', info);
      vs.innerHTML = `<span class="ip-vs-side" style="--c:#2fd6c6"><i></i>${esc(FACTIONS.hospital.name)}</span><b>VS</b><span class="ip-vs-side" style="--c:#d64bff"><i></i>${esc(FACTIONS.pathogen.name)} (AI)</span>`;
      el('p', '', info, `Standard start: your Central Hospital and five Orderly Bots. Destroy every enemy structure to win. Population cap ${MAX_POP}.`);
      this.fillPreview(prev, sel, 440);
      const foot = el('div', 'ip-brief-foot', detail);
      this.difficultyField(foot);
      const start = el('button', 'ip-btn ip-btn-primary', foot);
      start.type = 'button';
      start.innerHTML = `${glyphHtml('ui.play')}<span>Start skirmish</span>`;
      start.addEventListener('click', () => {
        this.sound('confirm');
        this.prefs.mapId = sel.id; this.savePrefs();
        this.app.startGame({ mode: 'skirmish', mapId: sel.id, difficulty: this.prefs.difficulty });
      });
    };
    for (const m of maps) {
      const b = el('button', 'ip-mission ip-map-card', list);
      b.type = 'button';
      const thumb = el('div', 'ip-map-thumb', b);
      const txt = el('span', 'ip-mission-txt', b);
      el('span', 'ip-mission-sub', txt, `${m.players} players`);
      el('span', 'ip-mission-title', txt, m.name);
      b.addEventListener('click', () => { sel = m; this.prefs.mapId = m.id; this.savePrefs(); this.sound('select'); paint(); });
      cards.set(m.id, { b, thumb });
    }
    paint();
    // thumbnails are generated after the page is on screen (map generation can take a moment)
    this.timers.push(window.setTimeout(() => { for (const m of maps) { const c = cards.get(m.id); if (c) this.fillPreview(c.thumb, m, 108); } }, 30));
  }

  private fillPreview(box: HTMLElement, m: MapInfo, px: number): void {
    const draw = () => {
      if (!box.isConnected) return;
      const md = mapData(m);
      if (!md) return;
      const src = mapPreview(md, px, m.id);
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      c.getContext('2d')!.drawImage(src, 0, 0);
      box.textContent = '';
      box.appendChild(c);
    };
    if (mapCache.has(m.id)) draw(); else this.timers.push(window.setTimeout(draw, 16));
  }

  // ───────────────────────── how to play / credits ─────────────────────────
  private renderHowTo(body: HTMLElement): void {
    const g = el('div', 'ip-howto', body);
    const left = el('div', '', g);
    el('h3', '', left, 'Controls');
    const t = el('table', 'ip-keys', left);
    t.innerHTML = KEYS.map(([combos, desc]) => `<tr><td>${combos.map((c) => c.map((k) => `<span class="ip-key">${esc(k)}</span>`).join('+')).join(' ')}</td><td>${esc(desc)}</td></tr>`).join('');
    const right = el('div', '', g);
    el('h3', '', right, 'Field manual');
    const tips = el('div', 'ip-tips', right);
    const tip = (icon: string, title: string, text: string) => {
      const c = el('div', 'ip-tip-card', tips);
      c.innerHTML = `<div class="ip-tip-ico">${iconHtml(icon)}</div><div><b>${esc(title)}</b><span>${esc(text)}</span></div>`;
    };
    tip('hosp_orderly', 'Supplies & Power', 'Orderly Bots haul Supplies from Supply Caches to the Central Hospital — about two per cache is efficient. Power trickles in from the HQ and Backup Generators.');
    tip('hosp_ward', 'Beds', `Every unit occupies Beds. Build Patient Wards (+8 each, up to ${MAX_POP}) before you run out.`);
    tip('hosp_uv_lancer', 'Counter the strain', 'UV (Lancers, Turrets) shreds viruses; antibiotics (Launchers) crush bacteria — but Superbugs resist them.');
    tip('hosp_medic', 'Support', 'Field Medics heal biological and mechanical units. Orderlies repair machines and structures.');
    tip('path_phage', 'Know your enemy', 'Pathogens are cheap, fast and regenerate. Trade decisively, focus fire, and don’t let wounded strains escape.');
    tip('hosp_uv_turret', 'Fog of war', 'Black is unexplored, dim is explored. Units below a cliff cannot see up it without a spotter on the high ground.');
  }

  private renderCredits(body: HTMLElement): void {
    const g = el('div', 'ip-credits', body);
    TEAM.forEach(([role, line], i) => {
      const c = el('div', 'ip-credit', g);
      c.innerHTML = `<span class="ip-credit-n">${String(i + 1).padStart(2, '0')}</span><div><b>${esc(role)}</b><span>${esc(line)}</span></div>`;
    });
    const f = el('div', 'ip-credits-foot', body);
    f.innerHTML = 'Built by fifteen cooperating AI agents, one shared checkout and a great deal of hand sanitizer.<br>No real pathogens were harmed. The campus, the outbreak and everyone in it are fictional.';
  }
}
