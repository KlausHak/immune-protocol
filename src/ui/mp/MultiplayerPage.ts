/**
 * [ui] Main menu → "Multiplayer (LAN)" page.
 *
 *   connection strip — player name (persisted), relay status, "Advanced: relay address" (default = same origin)
 *   no room yet      — room browser (listRooms / refresh / join) | host form (map, your + opponent faction)
 *   in a room        — lobby: both players (faction badge, ready), host-only map/faction pickers, map preview,
 *                      lobby chat, Ready / Start (host, both ready) / Leave
 *   'start' event    — createNetMatch immediately (so no turn data is missed), 3-2-1 countdown, app.startGame.
 *
 * The session lives in ./state (it survives this page and the match, for "Back to lobby").
 */
import type { FactionId, MapData } from '../../core/types';
import { FACTIONS } from '../../data';
import { MAPS, type MapInfo } from '../../map';
import type { AppApi } from '../../game/contracts';
import type { UiSound } from '../../audio/AudioEngine';
import type { NotifyKind } from '../../core/ui';
import { defaultRelayUrl, NET_PROTOCOL_VERSION, type ChatMessage, type LobbyState, type MatchStart, type NetPlayerInfo, type NetSession, type NetStatus, type RoomSummary } from '../../net/types';
import { cssHex, el, esc } from '../dom';
import { glyphHtml, iconHtml } from '../icons';
import { mapPreview } from '../mapRender';
import { currentSession, friendlyNetError, loadMpPrefs, mpFactories, saveMpPrefs, sessionAlive, setCurrentSession, type MpPrefs } from './state';
import { ensureMpStyles } from './styles';

type Side = Exclude<FactionId, 'neutral'>;
const SIDES: Side[] = ['hospital', 'pathogen'];

/** One-paragraph faction pitches for the pickers (both are playable by humans in LAN matches). */
export const FACTION_BLURB: Record<Side, string> = {
  hospital: 'Long range, healing and repair. Counter strains with UV (viruses) and antibiotics (bacteria). Wins by holding ground.',
  pathogen: 'Cheap, fast, regenerating swarms that grow their own structures. Wins by overwhelming before the counters arrive.',
};

const STATUS_TEXT: Record<NetStatus, [string, 'ok' | 'busy' | 'off']> = {
  connecting: ['Connecting…', 'busy'], connected: ['Connected', 'ok'], lobby: ['In a room', 'ok'], 'in-game': ['In a match', 'ok'],
  reconnecting: ['Reconnecting…', 'busy'], disconnected: ['Offline', 'off'], closed: ['Offline', 'off'],
};

export function mapName(id: string): string { return MAPS.find((m) => m.id === id)?.name ?? id; }
const factionColor = (f: FactionId): string => cssHex(FACTIONS[f]?.color ?? 0xc8c8c8);

const mapCache = new Map<string, MapData | null>();
function mapData(m: MapInfo): MapData | null {
  if (!mapCache.has(m.id)) {
    try { mapCache.set(m.id, m.build()); } catch (err) { console.error('[ui] map preview failed', m.id, err); mapCache.set(m.id, null); }
  }
  return mapCache.get(m.id) ?? null;
}

export interface MultiplayerPageCtx {
  app: AppApi;
  sound: (k: UiSound) => void;
  toast: (text: string, kind?: NotifyKind) => void;
}

const LOBBY_CHAT_MAX = 80;
/** Lobby chat survives page re-renders and the match (shown again on "Back to lobby"). */
const lobbyChat: Array<ChatMessage & { sys?: boolean }> = [];

export class MultiplayerPage {
  readonly el: HTMLDivElement;
  private prefs: MpPrefs = loadMpPrefs();
  private session: NetSession | null = null;
  private offs: Array<() => void> = [];
  private rooms: RoomSummary[] = [];
  private roomsAsked = false;
  private error: string | null = null;
  private everConnected = false;
  private timers: number[] = [];
  private refreshTimer = 0;
  private countdown: { el: HTMLDivElement; timer: number } | null = null;
  private disposed = false;
  // regions
  private connBox: HTMLDivElement;
  private statusEl: HTMLSpanElement;
  private errEl: HTMLDivElement;
  private main: HTMLDivElement;
  private mainKind: 'browse' | 'lobby' | null = null;
  private chatLog: HTMLDivElement | null = null;
  private lobbyKey = '';

  constructor(private ctx: MultiplayerPageCtx) {
    ensureMpStyles();
    if (!this.prefs.name) { this.prefs.name = `Medic-${Math.floor(100 + Math.random() * 900)}`; saveMpPrefs(this.prefs); }
    this.el = el('div', 'ip-mp');
    this.el.dataset.testid = 'mp-menu';
    this.connBox = el('div', 'ip-mp-conn', this.el);
    this.statusEl = el('span', 'ip-mp-status');
    this.errEl = el('div', 'ip-mp-err', this.el);
    this.errEl.style.display = 'none';
    this.main = el('div', '', this.el);
    this.main.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0';
    this.buildConn();
    const existing = currentSession();
    if (sessionAlive(existing)) this.attach(existing);
    else this.connect();
    this.render();
  }

  /** Esc from the menu: leave the room (if any). Returns true if it handled the key (stay on the page). */
  handleEscape(): boolean {
    if (this.countdown) return true;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && this.el.contains(ae) && (ae.tagName === 'INPUT')) { ae.blur(); return true; }
    if (this.session?.lobby) { this.leaveRoom(); return true; }
    return false;
  }

  /** Leaving the page by navigation (Back): leave the room so the other player isn't left waiting. */
  leaveRoomOnExit(): void { if (!this.countdown && this.session?.lobby) this.session.leave(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const o of this.offs) { try { o(); } catch { /* ignore */ } }
    this.offs = [];
    for (const t of this.timers) window.clearTimeout(t);
    window.clearInterval(this.refreshTimer);
    if (this.countdown) { window.clearInterval(this.countdown.timer); this.countdown.el.remove(); this.countdown = null; }
    this.el.remove();
  }

  // ───────────────────────── connection ─────────────────────────
  private relayUrl(): string {
    const custom = this.prefs.relayUrl.trim();
    if (custom) return custom;
    try { return defaultRelayUrl(); } catch { return ''; }
  }

  private connect(): void {
    const old = this.session ?? currentSession();
    for (const o of this.offs) { try { o(); } catch { /* ignore */ } }
    this.offs = [];
    if (old) { try { if (old.close) old.close(); else old.leave(); } catch { /* ignore */ } }
    setCurrentSession(null);
    this.session = null;
    this.rooms = []; this.roomsAsked = false; this.everConnected = false;
    const name = this.prefs.name.trim() || 'Player';
    let s: NetSession;
    try {
      const custom = this.prefs.relayUrl.trim();
      s = mpFactories().createSession(custom ? { url: custom, name } : { name });
    } catch (err) {
      this.setError(friendlyNetError(err instanceof Error ? err.message : String(err), this.relayUrl()));
      this.render();
      return;
    }
    setCurrentSession(s);
    this.attach(s);
  }

  private attach(s: NetSession): void {
    this.session = s;
    if (s.status !== 'connecting' && s.status !== 'disconnected' && s.status !== 'closed') this.everConnected = true;
    this.offs.push(
      s.on('status', (st) => {
        if (st === 'connected' || st === 'lobby' || st === 'in-game') {
          if (!this.everConnected) this.setError(null);
          this.everConnected = true;
          if (st === 'connected' && !s.lobby) this.askRooms();
        }
        if ((st === 'disconnected' || st === 'closed') && !this.error) {
          this.setError(this.everConnected ? 'Lost the connection to the relay.' : friendlyNetError('unreachable', this.relayUrl()));
        }
        this.render();
      }),
      s.on('lobby', () => this.render()),
      s.on('rooms', (r) => { this.rooms = [...r].sort((a, b) => Number(a.inGame) - Number(b.inGame) || a.players - b.players || b.createdAt - a.createdAt); this.render(); }),
      s.on('chat', (m) => { this.pushChat(m); }),
      s.on('error', (e) => { this.ctx.sound('error'); this.setError(friendlyNetError(e.message, this.relayUrl())); this.render(); }),
      s.on('start', (st) => this.onStart(st)),
      s.on('roomClosed', (e) => {
        if (this.countdown) return;
        this.ctx.sound('warning');
        this.setError(/host/i.test(e.reason) ? 'The host closed the room.' : `The room was closed${e.reason ? ` (${e.reason})` : ''}.`);
        this.mainKind = null;
        this.askRooms();
        this.render();
      }),
    );
    window.clearInterval(this.refreshTimer);
    this.refreshTimer = window.setInterval(() => { if (!s.lobby && this.isOnline()) s.listRooms(); }, 5000);
    if (this.isOnline() && !s.lobby) this.askRooms();
  }

  private isOnline(): boolean {
    const st = this.session?.status;
    return st === 'connected' || st === 'lobby' || st === 'in-game';
  }

  private askRooms(): void {
    if (!this.session) return;
    this.roomsAsked = true;
    try { this.session.listRooms(); } catch (err) { console.warn('[ui] listRooms failed', err); }
  }

  private setError(msg: string | null): void {
    this.error = msg;
    this.errEl.style.display = msg ? '' : 'none';
    if (!msg) return;
    this.errEl.innerHTML = `${glyphHtml('ui.alert')}<span>${esc(msg)}</span>`;
    const x = el('button', '', this.errEl, '✕');
    x.type = 'button';
    x.title = 'Dismiss';
    x.addEventListener('click', () => this.setError(null));
  }

  private buildConn(): void {
    const c = this.connBox;
    const nameF = el('div', 'ip-field', c);
    el('div', 'ip-caps', nameF, 'Your name');
    const name = el('input', 'ip-input', nameF);
    name.dataset.testid = 'mp-name';
    name.maxLength = 24;
    name.value = this.prefs.name;
    name.placeholder = 'Commander name';
    name.spellcheck = false;
    const commitName = () => {
      const v = name.value.trim().slice(0, 24);
      if (!v) { name.value = this.prefs.name; return; }
      if (v === this.prefs.name) return;
      this.prefs.name = v; saveMpPrefs(this.prefs);
      // the relay knows us by name: reconnect (only outside a room, so a lobby isn't torn down)
      if (!this.session?.lobby) { this.connect(); this.render(); }
      else this.ctx.toast('Name saved — it applies after you leave this room', 'info');
    };
    name.addEventListener('change', commitName);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });

    const stF = el('div', 'ip-field', c);
    stF.style.minWidth = '0';
    el('div', 'ip-caps', stF, 'Relay');
    stF.appendChild(this.statusEl);

    const adv = el('details', 'ip-mp-adv', c);
    el('summary', '', adv, 'Advanced: relay address');
    const row = el('div', 'ip-mp-adv-row', adv);
    const url = el('input', 'ip-input', row);
    url.dataset.testid = 'mp-relay';
    url.spellcheck = false;
    url.value = this.prefs.relayUrl;
    let def = '';
    try { def = defaultRelayUrl(); } catch { def = 'ws://<host>:<port>/lan'; }
    url.placeholder = `${def} (this page's server)`;
    if (this.prefs.relayUrl) adv.open = true;
    const apply = el('button', 'ip-btn', row);
    apply.type = 'button';
    apply.innerHTML = `${glyphHtml('ui.restart')}<span>Connect</span>`;
    const doApply = () => {
      const v = url.value.trim();
      if (v && !/^wss?:\/\//i.test(v)) { this.setError('The relay address must start with ws:// (or wss://), e.g. ws://192.168.1.20:5173/lan'); this.ctx.sound('error'); return; }
      this.prefs.relayUrl = v; saveMpPrefs(this.prefs);
      this.ctx.sound('click');
      this.setError(null);
      this.connect(); this.render();
    };
    apply.addEventListener('click', doApply);
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doApply(); } });
    el('div', 'ip-set-hint', adv, 'Leave empty to use the server that served this page. For a LAN host enter its address, e.g. ws://192.168.1.20:5173/lan');
  }

  private paintStatus(): void {
    const s = this.session;
    const [text, kind] = s ? STATUS_TEXT[s.status] ?? ['…', 'busy'] : ['Offline', 'off'];
    this.statusEl.className = `ip-mp-status is-${kind}`;
    this.statusEl.dataset.testid = 'mp-status';
    this.statusEl.dataset.status = s?.status ?? 'none';
    this.statusEl.innerHTML = `<i></i><span>${esc(text)}</span>`;
    this.statusEl.title = this.relayUrl();
  }

  // ───────────────────────── render ─────────────────────────
  private render(): void {
    if (this.disposed) return;
    this.paintStatus();
    const lobby = this.session?.lobby ?? null;
    if (lobby && this.session) this.renderLobby(lobby, this.session);
    else this.renderBrowse();
  }

  private renderBrowse(): void {
    // keep the host form's state across re-renders: rebuild only the room list when already browsing
    if (this.mainKind !== 'browse') {
      this.mainKind = 'browse';
      this.chatLog = null;
      this.lobbyKey = '';
      this.main.textContent = '';
      const grid = el('div', 'ip-mp-grid', this.main);
      const roomsBox = el('div', 'ip-mp-box', grid);
      roomsBox.dataset.testid = 'mp-rooms';
      const head = el('div', 'ip-mp-box-head', roomsBox);
      el('h3', '', head, 'Open rooms');
      const refresh = el('button', 'ip-btn', head);
      refresh.type = 'button';
      refresh.dataset.testid = 'mp-refresh';
      refresh.innerHTML = `${glyphHtml('ui.restart')}<span>Refresh</span>`;
      refresh.addEventListener('click', () => { this.ctx.sound('click'); this.askRooms(); this.render(); });
      el('div', 'ip-mp-rooms', roomsBox);
      el('div', 'ip-set-hint', roomsBox, `Both players need the same build (protocol v${NET_PROTOCOL_VERSION}). Rooms refresh every few seconds.`);
      this.buildHostForm(el('div', 'ip-mp-box', grid));
    }
    this.paintRooms();
  }

  private paintRooms(): void {
    const list = this.main.querySelector<HTMLDivElement>('.ip-mp-rooms');
    if (!list) return;
    const online = this.isOnline();
    for (const b of this.main.querySelectorAll<HTMLButtonElement>('[data-testid="mp-refresh"], [data-testid="mp-host-btn"]')) b.disabled = !online;
    list.textContent = '';
    if (!online) {
      const st = this.session?.status;
      el('div', 'ip-mp-empty', list, st === 'connecting' || st === 'reconnecting' ? 'Contacting the relay…' : 'Not connected to a relay. Check the address under “Advanced” and press Connect.');
      return;
    }
    if (!this.rooms.length) {
      el('div', 'ip-mp-empty', list, this.roomsAsked ? 'No rooms on this relay yet. Host one and ask your opponent to join.' : 'Looking for rooms…');
      return;
    }
    for (const r of this.rooms) {
      const full = r.players >= 2;
      const b = el('button', 'ip-mp-room', list);
      b.type = 'button';
      b.dataset.room = r.roomId;
      b.disabled = full || r.inGame;
      b.innerHTML = `<span><b>${esc(r.hostName)}</b><small>${esc(mapName(r.mapId))}</small></span>`
        + `<span class="ip-mp-room-n">${r.players}/2</span>`
        + `<span class="ip-mp-room-tag${b.disabled ? ' is-busy' : ''}">${r.inGame ? 'In game' : full ? 'Full' : 'Join'}</span>`;
      b.title = r.inGame ? 'This match is already running' : full ? 'This room is full' : `Join ${r.hostName}`;
      b.addEventListener('click', () => {
        if (!this.session || b.disabled) return;
        this.ctx.sound('confirm');
        this.setError(null);
        try { this.session.joinRoom(r.roomId); } catch (err) { this.setError(friendlyNetError(String(err))); }
      });
    }
  }

  private skirmishMaps(): MapInfo[] { return MAPS.filter((m) => m.skirmish); }

  private buildHostForm(box: HTMLDivElement): void {
    box.dataset.testid = 'mp-host';
    const head = el('div', 'ip-mp-box-head', box);
    el('h3', '', head, 'Host a game');
    const maps = this.skirmishMaps();
    let mapId = maps.find((m) => m.id === this.prefs.mapId)?.id ?? maps.find((m) => m.id === 'meilahti')?.id ?? maps[0]?.id ?? 'meilahti';
    el('div', 'ip-caps', box, 'Battleground');
    const mapList = el('div', 'ip-mp-maps', box);
    const mapBtns: Array<[string, HTMLButtonElement]> = [];
    for (const m of maps) {
      const b = el('button', 'ip-mp-map', mapList);
      b.type = 'button';
      const th = el('div', 'ip-map-thumb', b);
      el('b', '', b, m.name);
      b.addEventListener('click', () => { mapId = m.id; this.prefs.mapId = m.id; saveMpPrefs(this.prefs); this.ctx.sound('select'); paint(); });
      mapBtns.push([m.id, b]);
      this.timers.push(window.setTimeout(() => this.fillPreview(th, m, 80), 40));
    }
    el('div', 'ip-caps', box, 'You play');
    const mine = el('div', 'ip-mp-facs', box);
    el('div', 'ip-caps', box, 'Opponent plays');
    const theirs = el('div', 'ip-mp-facs', box);
    const facBtn = (parent: HTMLElement, f: Side, pick: () => void, testid: string) => {
      const b = el('button', 'ip-mp-fac', parent);
      b.type = 'button';
      b.dataset.testid = testid;
      b.dataset.faction = f;
      b.style.setProperty('--fc', factionColor(f));
      b.innerHTML = `<span class="ip-mp-fac-ico">${iconHtml(FACTIONS[f].hq)}</span><b>${esc(FACTIONS[f].name)}</b><span>${esc(FACTION_BLURB[f])}</span>`;
      b.addEventListener('click', () => { pick(); saveMpPrefs(this.prefs); this.ctx.sound('select'); paint(); });
      return b;
    };
    const mineBtns = SIDES.map((f) => facBtn(mine, f, () => { this.prefs.hostFaction = f; }, `mp-host-faction-${f}`));
    const theirBtns = SIDES.map((f) => facBtn(theirs, f, () => { this.prefs.guestFaction = f; }, `mp-guest-faction-${f}`));
    const note = el('div', 'ip-set-hint', box);
    const foot = el('div', 'ip-mp-host-foot', box);
    const go = el('button', 'ip-btn ip-btn-primary', foot);
    go.type = 'button';
    go.dataset.testid = 'mp-host-btn';
    go.innerHTML = `${glyphHtml('ui.flag')}<span>Host game</span>`;
    go.addEventListener('click', () => {
      if (!this.session || !this.isOnline()) { this.ctx.sound('error'); return; }
      this.ctx.sound('confirm');
      this.setError(null);
      try { this.session.createRoom({ mapId, hostFaction: this.prefs.hostFaction, guestFaction: this.prefs.guestFaction }); }
      catch (err) { this.setError(friendlyNetError(String(err))); }
    });
    const paint = () => {
      for (const [id, b] of mapBtns) b.classList.toggle('is-sel', id === mapId);
      SIDES.forEach((f, i) => { mineBtns[i]!.setAttribute('aria-pressed', String(this.prefs.hostFaction === f)); theirBtns[i]!.setAttribute('aria-pressed', String(this.prefs.guestFaction === f)); });
      note.innerHTML = this.prefs.hostFaction === this.prefs.guestFaction
        ? `<b>Mirror match</b> — both sides play ${esc(FACTIONS[this.prefs.hostFaction].name)}.`
        : `<b>${esc(FACTIONS[this.prefs.hostFaction].short)}</b> (you, start 1) vs <b>${esc(FACTIONS[this.prefs.guestFaction].short)}</b> (start 2).`;
    };
    paint();
  }

  private fillPreview(box: HTMLElement, m: MapInfo, px: number): void {
    if (!box.isConnected || this.disposed) return;
    const md = mapData(m);
    if (!md) return;
    const src = mapPreview(md, px, m.id);
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d')?.drawImage(src, 0, 0);
    box.textContent = '';
    box.appendChild(c);
  }

  // ───────────────────────── lobby ─────────────────────────
  private me(lobby: LobbyState, s: NetSession): NetPlayerInfo | undefined {
    const slot = s.role === 'guest' ? 2 : 1;
    return lobby.players.find((p) => p.slot === slot);
  }

  private renderLobby(lobby: LobbyState, s: NetSession): void {
    // full rebuild only when something visible changed (keeps the chat input's focus and text)
    const key = JSON.stringify([lobby, s.role, s.status]);
    if (this.mainKind === 'lobby' && key === this.lobbyKey) return;
    const chatInput = this.main.querySelector<HTMLInputElement>('.ip-mp-chat-row .ip-input');
    const draft = chatInput?.value ?? '';
    const hadFocus = !!chatInput && document.activeElement === chatInput;
    this.mainKind = 'lobby';
    this.lobbyKey = key;
    this.main.textContent = '';
    const host = s.role === 'host';
    const editable = host && (lobby.state === 'waiting' || lobby.state === 'ready');
    const wrap = el('div', 'ip-mp-lobby', this.main);
    wrap.dataset.testid = 'mp-lobby';
    wrap.dataset.state = lobby.state;
    const left = el('div', 'ip-mp-lobby-l', wrap);
    const head = el('div', 'ip-mp-box-head', left);
    el('h3', '', head, `Room · ${host ? 'you are hosting' : 'joined'}`);
    const slots = el('div', 'ip-mp-slots', left);
    const meInfo = this.me(lobby, s);
    for (const slot of [1, 2]) {
      const p = lobby.players.find((x) => x.slot === slot);
      if (slot === 2) el('div', 'ip-mp-vs', slots, 'VS');
      const card = el('div', 'ip-mp-slot', slots);
      card.dataset.slot = String(slot);
      if (!p) {
        card.classList.add('is-empty');
        card.innerHTML = `<div class="ip-mpwait-spin" style="width:calc(22*var(--ip-u));height:calc(22*var(--ip-u))"></div><div>Waiting for an opponent to join…</div>`;
        continue;
      }
      const isMe = p === meInfo;
      card.style.setProperty('--fc', factionColor(p.faction));
      card.innerHTML = `<div class="ip-mp-slot-top"><div class="ip-mp-slot-ico">${iconHtml(FACTIONS[p.faction]?.hq ?? 'hosp_hq')}</div>`
        + `<div style="min-width:0"><div class="ip-mp-slot-role">${slot === 1 ? 'Host' : 'Guest'} · start ${slot}${isMe ? ' · <em>you</em>' : ''}</div><div class="ip-mp-slot-name">${esc(p.name)}</div></div></div>`
        + `<span class="ip-mp-badge"><i></i>${esc(FACTIONS[p.faction]?.name ?? p.faction)}</span>`;
      if (editable) {
        const seg = el('div', 'ip-seg', card);
        seg.setAttribute('role', 'group');
        seg.title = 'Host: choose this player’s faction';
        for (const f of SIDES) {
          const b = el('button', '', seg, FACTIONS[f].short);
          b.type = 'button';
          b.setAttribute('aria-pressed', String(p.faction === f));
          b.addEventListener('click', () => {
            if (p.faction === f) return;
            this.ctx.sound('select');
            if (slot === 1) this.prefs.hostFaction = f; else this.prefs.guestFaction = f;
            saveMpPrefs(this.prefs);
            s.updateRoom(slot === 1 ? { hostFaction: f } : { guestFaction: f });
          });
        }
      }
      const ready = el('div', `ip-mp-ready${!p.connected ? ' is-lost' : p.ready ? ' is-on' : ''}`, card);
      ready.innerHTML = `<i></i><span>${!p.connected ? 'Connection lost' : p.ready ? 'Ready' : 'Not ready'}</span>`;
    }
    // chat
    const chat = el('div', 'ip-mp-chat', left);
    chat.dataset.testid = 'mp-chat';
    el('div', 'ip-caps', chat, 'Lobby chat');
    this.chatLog = el('div', 'ip-mp-chat-log', chat);
    for (const m of lobbyChat) this.appendChatLine(m);
    const row = el('div', 'ip-mp-chat-row', chat);
    const input = el('input', 'ip-input', row);
    input.maxLength = 200;
    input.placeholder = 'Say something…  (Enter to send)';
    input.value = draft;
    const send = el('button', 'ip-btn', row, 'Send');
    send.type = 'button';
    const doSend = () => {
      const t = input.value.trim();
      if (!t) return;
      input.value = '';
      try { s.sendChat(t); } catch (err) { this.setError(friendlyNetError(String(err))); }
    };
    send.addEventListener('click', doSend);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSend(); } });
    if (hadFocus) input.focus();

    // right: map + actions
    const right = el('div', 'ip-mp-lobby-r', wrap);
    el('div', 'ip-caps', right, 'Battleground');
    const info = MAPS.find((m) => m.id === lobby.mapId);
    if (editable) {
      const seg = el('div', 'ip-seg', right);
      for (const m of this.skirmishMaps()) {
        const b = el('button', '', seg, m.name);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(m.id === lobby.mapId));
        b.addEventListener('click', () => { if (m.id !== lobby.mapId) { this.ctx.sound('select'); this.prefs.mapId = m.id; saveMpPrefs(this.prefs); s.updateRoom({ mapId: m.id }); } });
      }
    } else {
      el('div', 'ip-mp-mapname', right, mapName(lobby.mapId));
    }
    const prev = el('div', 'ip-map-preview', right);
    if (info) {
      this.timers.push(window.setTimeout(() => this.fillPreview(prev, info, 300), 20));
      el('div', 'ip-mp-mapdesc', right, info.description);
    }
    const acts = el('div', 'ip-mp-actions', right);
    const both = lobby.players.length >= 2 && lobby.players.every((p) => p.ready && p.connected);
    const starting = lobby.state === 'starting' || lobby.state === 'in-game' || lobby.state === 'ended';
    const readyBtn = el('button', `ip-btn${meInfo?.ready ? ' is-ready' : ''}`, acts);
    readyBtn.type = 'button';
    readyBtn.dataset.testid = 'mp-ready';
    readyBtn.setAttribute('aria-pressed', String(!!meInfo?.ready));
    readyBtn.innerHTML = `${glyphHtml(meInfo?.ready ? 'ui.check' : 'ui.ring')}<span>${meInfo?.ready ? 'Ready!' : 'Ready up'}</span>`;
    readyBtn.disabled = starting || !meInfo;
    readyBtn.addEventListener('click', () => { this.ctx.sound(meInfo?.ready ? 'click' : 'confirm'); s.setReady(!meInfo?.ready); });
    if (host) {
      const start = el('button', 'ip-btn ip-btn-primary', acts);
      start.type = 'button';
      start.dataset.testid = 'mp-start';
      start.innerHTML = `${glyphHtml('ui.play')}<span>Start match</span>`;
      start.disabled = !both || starting;
      start.title = lobby.players.length < 2 ? 'Waiting for an opponent to join' : !both ? 'Both players must be ready' : 'Start the match';
      start.addEventListener('click', () => { this.ctx.sound('confirm'); s.startMatch(); });
    }
    const leave = el('button', 'ip-btn ip-btn-danger', acts);
    leave.type = 'button';
    leave.dataset.testid = 'mp-leave';
    leave.innerHTML = `${glyphHtml('ui.exit')}<span>Leave</span>`;
    leave.disabled = starting && !!this.countdown;
    leave.addEventListener('click', () => this.leaveRoom());
    el('div', 'ip-set-hint', right, lobby.state === 'ended' ? 'The match is over. Leave the room to host or join a new game.' : lobby.state === 'in-game' ? 'The match is running.' : host
      ? (lobby.players.length < 2 ? 'Share your address with the other player: they open this page and join your room.' : both ? 'Both ready — start when you like.' : 'The match can start once both players are ready.')
      : (both ? 'Both ready — waiting for the host to start.' : 'Ready up when you are set. The host starts the match.'));
  }

  private leaveRoom(): void {
    this.ctx.sound('close');
    try { this.session?.leave(); } catch { /* ignore */ }
    this.pushChat({ from: '', slot: 0, text: 'You left the room.', at: Date.now() }, true);
    this.mainKind = null;
    // leave() may close the relay connection: reconnect to keep browsing
    const s = this.session;
    if (!sessionAlive(s)) this.connect();
    this.askRooms();
    this.render();
  }

  private pushChat(m: ChatMessage, sys = false): void {
    lobbyChat.push({ ...m, sys });
    while (lobbyChat.length > LOBBY_CHAT_MAX) lobbyChat.shift();
    if (this.chatLog?.isConnected) this.appendChatLine(lobbyChat[lobbyChat.length - 1]!);
  }

  private appendChatLine(m: ChatMessage & { sys?: boolean }): void {
    const log = this.chatLog;
    if (!log) return;
    const p = el('p', m.sys || m.slot === 0 ? 'is-sys' : '', log);
    if (m.sys || m.slot === 0) p.textContent = m.text;
    else {
      const fac = this.session?.lobby?.players.find((x) => x.slot === m.slot)?.faction;
      if (fac) p.style.setProperty('--nc', factionColor(fac));
      p.innerHTML = `<b>${esc(m.from)}</b>${esc(m.text)}`;
    }
    log.scrollTop = log.scrollHeight;
  }

  // ───────────────────────── match start ─────────────────────────
  private onStart(start: MatchStart): void {
    if (this.disposed || this.countdown || !this.session) return;
    const s = this.session;
    let match;
    try { match = mpFactories().createMatch(s, start); } catch (err) {
      this.ctx.sound('error');
      this.setError(`Could not start the match: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const me = start.players.find((p) => p.id === start.localPlayerId);
    const foe = start.players.find((p) => p.id !== start.localPlayerId);
    const ov = el('div', 'ip-root ip-mp-count', document.body);
    ov.dataset.testid = 'mp-countdown';
    if (me) ov.classList.add(`ip-faction-${me.faction}`);
    el('div', 'ip-mp-count-k', ov, `${mapName(start.mapId)} · match starting`);
    const n = el('div', 'ip-mp-count-n', ov, '3');
    const vs = el('div', 'ip-mp-count-vs', ov);
    vs.innerHTML = `<b>${esc(me?.name ?? 'You')}</b> · ${esc(FACTIONS[me?.faction ?? 'hospital'].short)} &nbsp;vs&nbsp; <b>${esc(foe?.name ?? 'Opponent')}</b> · ${esc(FACTIONS[foe?.faction ?? 'pathogen'].short)}`;
    let left = 3;
    this.ctx.sound('confirm');
    const timer = window.setInterval(() => {
      left--;
      if (left > 0) { n.textContent = String(left); this.ctx.sound('click'); return; }
      window.clearInterval(timer);
      ov.remove();
      this.countdown = null;
      try { this.ctx.app.startGame({ mode: 'multiplayer', difficulty: 'normal', net: match }); }
      catch (err) {
        try { match.lockstep.dispose(); } catch { /* ignore */ }
        this.ctx.toast(`Could not start the match: ${err instanceof Error ? err.message : String(err)}`, 'warning');
      }
    }, 1000);
    this.countdown = { el: ov, timer };
  }
}
