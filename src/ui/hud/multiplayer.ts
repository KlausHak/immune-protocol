/**
 * [ui] In-game multiplayer layer (created by the Hud only when game.net is set):
 *   · opponent badge (name + faction) and ping bars, prepended to the top bar
 *   · chat — Enter opens the input, Enter sends, Esc cancels; messages fade out over the HUD
 *   · "Waiting for <opponent>…" overlay while lockstep.waitingReason is non-null
 *   · opponent-left dialog: countdown (lockstep.opponentGone.forfeitAt) to victory by forfeit — the lockstep
 *     driver ends the match itself when it expires — keep waiting, or leave now
 *   · desync notice ("Resynchronising…")
 * Controls ignore keys while a text input has focus (src/input/Controls isTypingTarget), so typing is safe.
 */
import type { GameContext } from '../../game/contracts';
import type { UiSound } from '../../audio/AudioEngine';
import type { ChatMessage, NetMatch, NetSession } from '../../net/types';
import { FACTIONS } from '../../data';
import { cssHex, el, esc, setClass, TextSlot } from '../dom';
import { glyphHtml, iconHtml } from '../icons';
import { ensureMpStyles } from '../mp/styles';
import { sessionAlive, setMenuReturn } from '../mp/state';

const CHAT_LIFE = 9;          // seconds a message stays fully visible
const CHAT_MAX = 7;
const WAIT_GRACE = 0.35;      // don't flash the overlay for one-frame stalls

interface ChatLine { el: HTMLDivElement; age: number; mine: boolean; text: string }

/** Recent in-game chat per session: a resync rebuilds the Game + HUD, the conversation should survive it. */
const history = new WeakMap<NetSession, Array<ChatMessage | string>>();

export class MultiplayerHud {
  private net: NetMatch;
  private offs: Array<() => void> = [];
  private opp: HTMLDivElement;
  private ping: HTMLDivElement;
  private pingMs: TextSlot;
  private pingT = 1;
  private chat: HTMLDivElement;
  private chatLog: HTMLDivElement;
  private input: HTMLInputElement;
  private lines: ChatLine[] = [];
  private wait: HTMLDivElement;
  private waitTxt: TextSlot;
  private waitT = 0;
  private desync: HTMLDivElement;
  private desyncT = 0;
  private left: { el: HTMLDivElement; n: HTMLDivElement } | null = null;
  /** the current disconnect episode already showed the dialog ("Keep waiting" hides it for good) */
  private leftSeen = false;
  private disposed = false;

  constructor(private root: HTMLElement, topBar: HTMLElement, private game: GameContext, private sound: (k: UiSound) => void,
    private toast: (text: string, kind: 'info' | 'warning' | 'alert' | 'success') => void) {
    ensureMpStyles();
    this.net = game.net!;
    root.classList.add('ip-mp');
    const foeId = game.enemyPlayerId;
    const foeStart = this.net.start.players.find((p) => p.id === foeId);
    const foe = game.world.players.get(foeId);
    const foeFaction = foeStart?.faction ?? foe?.faction ?? 'pathogen';
    const foeName = this.opponentName();

    // opponent badge + ping (first segment of the top bar)
    this.opp = el('div', 'ip-tb-opp');
    this.opp.dataset.testid = 'mp-opponent';
    this.opp.style.setProperty('--fc', cssHex(FACTIONS[foeFaction]?.color ?? 0xd64bff));
    this.opp.innerHTML = `<div class="ip-tb-opp-ico">${iconHtml(FACTIONS[foeFaction]?.hq ?? 'path_hive')}</div>`
      + `<div class="ip-tb-opp-txt"><span class="ip-tb-opp-k">vs · <em>${esc(FACTIONS[foeFaction]?.short ?? foeFaction)}</em></span><span class="ip-tb-opp-name">${esc(foeName)}</span></div>`;
    this.ping = el('div', 'ip-ping', this.opp);
    this.ping.innerHTML = '<i></i><i></i><i></i>';
    this.ping.dataset.testid = 'mp-ping';
    this.pingMs = new TextSlot(el('span', 'ip-ping-ms', this.opp, '— ms'));
    this.opp.title = `Opponent: ${foeName} (${FACTIONS[foeFaction]?.name ?? foeFaction}) · round-trip ping`;
    topBar.insertBefore(this.opp, topBar.firstChild);

    // chat
    this.chat = el('div', 'ip-mpchat', root);
    this.chat.dataset.testid = 'mp-chat';
    this.chatLog = el('div', 'ip-mpchat-log', this.chat);
    const inRow = el('div', 'ip-mpchat-in', this.chat);
    el('span', 'ip-caps', inRow, 'Say');
    this.input = el('input', 'ip-input', inRow);
    this.input.maxLength = 200;
    this.input.dataset.testid = 'mp-chat-input';
    el('span', 'ip-mpchat-hint', inRow, 'Enter send · Esc cancel');
    this.input.addEventListener('keydown', this.onInputKey);
    this.input.addEventListener('blur', () => { if (!this.input.value.trim()) this.closeInput(); });

    // overlays
    this.wait = el('div', 'ip-panel ip-ecg ip-mpwait', root);
    this.wait.dataset.testid = 'mp-waiting';
    el('div', 'ip-mpwait-spin', this.wait);
    const wt = el('div', '', this.wait);
    this.waitTxt = new TextSlot(el('b', '', wt));
    el('span', '', wt, 'The match continues as soon as both sides are in sync.');
    this.wait.style.display = 'none';
    this.desync = el('div', 'ip-mpdesync', root, 'Resynchronising…');
    this.desync.dataset.testid = 'mp-desync';
    this.desync.style.display = 'none';

    const s = this.net.session;
    this.offs.push(
      s.on('chat', (m) => this.onChat(m)),
      s.on('opponentLeft', (e) => { if (!this.leftSeen) { this.leftSeen = true; this.onOpponentLeft(e.name, e.reason); } }),
      s.on('desync', (e) => {
        this.desyncT = e.resyncing ? 6 : 4;
        this.desync.textContent = e.resyncing ? 'Resynchronising…' : `Simulation mismatch at tick ${e.tick}`;
        this.desync.style.display = '';
        if (!e.resyncing) this.toast('The two simulations disagreed — the host will resynchronise', 'warning');
      }),
      s.on('error', (e) => this.sysLine(e.message)),
      s.on('opponentReturned', (e) => { if (this.left) { this.closeLeft(true); this.sysLine(`${e.name || this.opponentName()} is back.`); } else this.leftSeen = false; }),
      s.on('status', (st) => {
        if (st === 'reconnecting') this.sysLine('Connection unstable — reconnecting…');
        else if ((st === 'disconnected' || st === 'closed') && !this.game.world.rules.gameOver) this.sysLine('Disconnected from the relay.');
      }),
    );
    window.addEventListener('keydown', this.onWindowKey);
    const past = history.get(s);
    if (past?.length) {
      for (const m of past) { if (typeof m === 'string') this.sysLine(m, false); else this.onChat(m, false); }
      for (const l of this.lines) l.age = CHAT_LIFE; // already read: show again only while typing
    } else this.sysLine(`Match started vs ${foeName}. Press Enter to chat.`);
  }

  opponentName(): string {
    const id = this.game.enemyPlayerId;
    return this.net.start.players.find((p) => p.id === id)?.name ?? this.game.world.players.get(id)?.name ?? 'Opponent';
  }

  get isTyping(): boolean { return setClassHas(this.chat, 'is-typing'); }
  get isDialogOpen(): boolean { return this.left !== null; }

  update(dt: number): void {
    if (this.disposed) return;
    // ping (cheap, but no need for every frame)
    this.pingT += dt;
    if (this.pingT >= 0.5) {
      this.pingT = 0;
      const ms = this.net.lockstep.pingMs ?? this.net.session.pingMs;
      const ok = Number.isFinite(ms);
      this.pingMs.set(ok ? `${Math.round(ms)} ms` : '— ms');
      this.ping.dataset.q = !ok ? '0' : ms < 80 ? '3' : ms < 200 ? '2' : '1';
    }
    // waiting overlay
    let reason: string | null = null;
    try { reason = this.net.lockstep.waitingReason; } catch { reason = null; }
    if (reason && !this.game.world.rules.gameOver && !this.left) {
      this.waitT += dt;
      this.waitTxt.set(reason || `Waiting for ${this.opponentName()}…`);
    } else this.waitT = 0;
    const showWait = this.waitT >= WAIT_GRACE;
    if (showWait !== (this.wait.style.display !== 'none')) this.wait.style.display = showWait ? '' : 'none';
    // desync notice: visible while resyncing stalls the sim, then a short tail
    if (this.desyncT > 0) {
      this.desyncT -= reason ? 0 : dt;
      if (this.desyncT <= 0) this.desync.style.display = 'none';
    }
    this.updateLeft();
    // chat fade
    const typing = this.isTyping;
    for (const l of this.lines) {
      l.age += dt;
      setClass(l.el, 'is-old', l.age > CHAT_LIFE);
    }
    if (!typing && this.lines.length && this.lines.every((l) => l.age > CHAT_LIFE + 2) && this.lines.length > 3) {
      // keep the DOM small: once everything has faded, drop all but the last few (shown again while typing)
      while (this.lines.length > 3) this.lines.shift()!.el.remove();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onWindowKey);
    for (const o of this.offs) { try { o(); } catch { /* ignore */ } }
    this.offs = [];
    this.left?.el.remove();
    this.left = null;
    this.opp.remove();
    this.chat.remove();
    this.wait.remove();
    this.desync.remove();
  }

  // ───────────────────────── chat ─────────────────────────
  private onWindowKey = (e: KeyboardEvent): void => {
    if (this.disposed || e.key !== 'Enter' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return;
    if (this.root.querySelector('.ip-modal, .ip-confirm-ov')) return; // pause menu / end screen / dialogs own the keyboard
    e.preventDefault();
    this.openInput();
  };

  openInput(): void {
    if (this.disposed) return;
    this.chat.classList.add('is-typing');
    this.input.focus();
  }

  private closeInput(): void {
    this.input.value = '';
    this.chat.classList.remove('is-typing');
    if (document.activeElement === this.input) this.input.blur();
    try { (this.game.renderer?.three?.domElement as HTMLCanvasElement | undefined)?.focus(); } catch { /* optional */ }
  }

  private onInputKey = (e: KeyboardEvent): void => {
    // keep chat keys away from the HUD / Controls hotkeys (they also ignore focused inputs)
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      const text = this.input.value.trim();
      if (text) {
        try { this.net.session.sendChat(text); } catch (err) { this.sysLine(`Could not send: ${err instanceof Error ? err.message : String(err)}`); }
      }
      this.closeInput();
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      this.closeInput();
    } else {
      e.stopPropagation();
    }
  };

  private remember(m: ChatMessage | string): void {
    const s = this.net.session;
    const h = history.get(s) ?? [];
    h.push(m);
    while (h.length > CHAT_MAX) h.shift();
    history.set(s, h);
  }

  private onChat(m: ChatMessage, live = true): void {
    if (m.slot === 0) { this.sysLine(m.text, live); return; }
    if (live) this.remember(m);
    const line = el('div', 'ip-mpchat-msg');
    const p = this.game.world.players.get(m.slot);
    const mine = m.slot === this.game.localPlayerId;
    line.style.setProperty('--nc', mine ? 'var(--ip-accent-2)' : cssHex(p ? (FACTIONS[p.faction]?.color ?? 0xffffff) : 0xffffff));
    line.innerHTML = `<b>${esc(m.from || p?.name || 'Player')}:</b>${esc(m.text)}`;
    this.push({ el: line, age: 0, mine, text: m.text });
    if (!mine && live) this.sound('notify');
  }

  private sysLine(text: string, live = true): void {
    if (live) this.remember(text);
    const line = el('div', 'ip-mpchat-msg is-sys', null, text);
    this.push({ el: line, age: 0, mine: false, text });
  }

  private push(l: ChatLine): void {
    this.chatLog.appendChild(l.el);
    this.lines.push(l);
    while (this.lines.length > CHAT_MAX) this.lines.shift()!.el.remove();
  }

  // ───────────────────────── opponent left ─────────────────────────
  /** Lockstep's view of a vanished opponent (it ends the match by forfeit itself, deterministically). */
  private gone(): { name: string; reason: string; forfeitAt: number } | null {
    try { return this.net.lockstep.opponentGone ?? null; } catch { return null; }
  }

  private onOpponentLeft(name: string, reason: string): void {
    if (this.disposed || this.left || this.game.world.rules.gameOver) return;
    const who = name || this.opponentName();
    this.sysLine(`${who} ${reason === 'left' ? 'left the match' : 'lost the connection'}.`);
    this.sound('warning');
    const m = el('div', 'ip-modal ip-mpleft', this.root);
    m.dataset.testid = 'mp-opponent-left';
    m.addEventListener('contextmenu', (e) => e.preventDefault());
    const c = el('div', 'ip-panel ip-ecg ip-mpleft-card', m);
    el('div', 'ip-mpleft-title', c, reason === 'left' ? 'Opponent left' : 'Opponent disconnected');
    el('div', 'ip-mpleft-txt', c, reason === 'left'
      ? `${who} has left the match. Unless they return, you win by forfeit in`
      : `${who} lost the connection. Waiting for them to reconnect — otherwise you win by forfeit in`);
    const n = el('div', 'ip-mpleft-n', c, '…');
    const row = el('div', 'ip-mpleft-row', c);
    const wait = el('button', 'ip-btn ip-btn-primary', row);
    wait.type = 'button';
    wait.innerHTML = `${glyphHtml('ui.time')}<span>Keep waiting</span>`;
    wait.addEventListener('click', () => { this.sound('click'); this.closeLeft(false); });
    const leave = el('button', 'ip-btn ip-btn-danger', row);
    leave.type = 'button';
    leave.innerHTML = `${glyphHtml('ui.exit')}<span>Leave match</span>`;
    leave.addEventListener('click', () => { this.sound('click'); this.leaveMatch(true); });
    this.left = { el: m, n };
    this.paintLeft();
    wait.focus();
  }

  /** Per frame: countdown from lockstep.opponentGone; close when they return or the forfeit lands. */
  private updateLeft(): void {
    const g = this.gone();
    if (!this.left) {
      // missed the event (or the HUD was rebuilt after a resync): open from the lockstep state
      if (g && !this.leftSeen && !this.game.world.rules.gameOver) { this.leftSeen = true; this.onOpponentLeft(g.name, g.reason); }
      if (!g) this.leftSeen = false;
      return;
    }
    if (this.game.world.rules.gameOver || (!g && this.hasGoneApi())) {
      let solo = false;
      try { solo = !!this.net.lockstep.debug?.().solo; } catch { solo = false; }
      const back = !this.game.world.rules.gameOver && !solo; // solo = forfeit decided, the end screen follows
      this.closeLeft(true);
      if (back) this.sysLine(`${this.opponentName()} is back.`);
      return;
    }
    this.paintLeft();
  }

  private hasGoneApi(): boolean { return 'opponentGone' in this.net.lockstep; }

  private paintLeft(): void {
    const l = this.left;
    if (!l) return;
    const g = this.gone();
    const secs = g ? Math.max(0, Math.ceil((g.forfeitAt - performance.now()) / 1000)) : NaN;
    const txt = Number.isFinite(secs) ? `${secs}s` : '…';
    if (l.n.textContent !== txt) l.n.textContent = txt;
  }

  /** remove the dialog; `forget` = the episode is over (a later disconnect opens it again) */
  private closeLeft(forget: boolean): void {
    if (!this.left) return;
    this.left.el.remove();
    this.left = null;
    if (forget) this.leftSeen = false;
    try { (this.game.renderer?.three?.domElement as HTMLCanvasElement | undefined)?.focus(); } catch { /* optional */ }
  }

  /** Leave the match: surrender (if still running), leave the room, back to the menu. */
  leaveMatch(surrender = true): void {
    const g = this.game;
    if (surrender && !g.world.rules.gameOver) {
      try { g.issue({ type: 'surrender', playerId: g.localPlayerId }); } catch { /* ignore */ }
    }
    try { this.net.session.leave(); } catch { /* ignore */ }
    setMenuReturn(sessionAlive(this.net.session) ? 'lobby' : 'home');
    g.quitToMenu();
  }
}

function setClassHas(e: Element, cls: string): boolean { return e.classList.contains(cls); }
