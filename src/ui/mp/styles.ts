/**
 * [ui] Stylesheet for the multiplayer screens (menu page, lobby) and the in-game multiplayer HUD layer
 * (opponent badge, ping, chat, waiting / opponent-left / desync overlays). Same "clinical glass" language and
 * design-unit scaling (u(n) → calc(n * var(--ip-u))) as src/ui/styles.ts; injected once, after it.
 */
import { ensureUiStyles } from '../styles';

const u = (n: number): string => `calc(${n} * var(--ip-u, 1px))`;

const CSS = /* css */ `
/* ───────────── menu page ───────────── */
.ip-mp { display: flex; flex-direction: column; gap: ${u(14)}; min-height: ${u(470)}; }
.ip-mp-conn { display: flex; align-items: flex-end; gap: ${u(14)}; flex-wrap: wrap; padding: ${u(12)} ${u(14)}; border-radius: ${u(12)}; background: rgba(0, 0, 0, .22); border: 1px solid var(--ip-line); }
.ip-mp-conn .ip-field { min-width: ${u(220)}; }
.ip-mp-conn .ip-input { flex: none; width: 100%; }
.ip-mp-adv { display: flex; flex-direction: column; gap: ${u(6)}; flex: 1; min-width: ${u(260)}; }
.ip-mp-adv summary { cursor: pointer; font-size: ${u(9)}; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--ip-faint); list-style: none; pointer-events: auto; }
.ip-mp-adv summary::before { content: "▸ "; }
.ip-mp-adv[open] summary::before { content: "▾ "; }
.ip-mp-adv-row { display: flex; gap: ${u(8)}; margin-top: ${u(6)}; align-items: center; }
.ip-mp-adv-row .ip-btn { height: ${u(34)}; padding: 0 ${u(12)}; font-size: ${u(12)}; }
.ip-mp-status { display: inline-flex; align-items: center; gap: ${u(8)}; height: ${u(34)}; padding: 0 ${u(12)}; border-radius: ${u(999)}; font-size: ${u(12)}; font-weight: 700; letter-spacing: .04em;
  background: rgba(0, 0, 0, .3); border: 1px solid var(--ip-line); color: var(--ip-dim); white-space: nowrap; --sc: var(--ip-faint); }
.ip-mp-status i { width: ${u(9)}; height: ${u(9)}; border-radius: 50%; background: var(--sc); box-shadow: 0 0 ${u(8)} var(--sc); }
.ip-mp-status.is-ok { --sc: var(--ip-ok); color: var(--ip-text); }
.ip-mp-status.is-busy { --sc: var(--ip-warn); }
.ip-mp-status.is-busy i { animation: ip-mp-blink 1s ease-in-out infinite; }
.ip-mp-status.is-off { --sc: var(--ip-alert); color: #ffc2c9; }
@keyframes ip-mp-blink { 50% { opacity: .25; } }
.ip-mp-conn > .ip-btn { height: ${u(34)}; }
.ip-mp-err { display: flex; align-items: center; gap: ${u(10)}; padding: ${u(9)} ${u(14)}; border-radius: ${u(10)}; font-size: ${u(12.5)}; color: #ffd1d6;
  background: rgba(255, 90, 107, .1); border: 1px solid rgba(255, 90, 107, .38); }
.ip-mp-err .ip-glyph { color: var(--ip-alert); font-size: ${u(16)}; }
.ip-mp-err button { margin-left: auto; background: none; border: 0; cursor: pointer; color: var(--ip-dim); font-size: ${u(14)}; pointer-events: auto; }
.ip-mp-grid { display: grid; grid-template-columns: 1fr ${u(400)}; gap: ${u(16)}; min-height: 0; flex: 1; }
.ip-mp-box { display: flex; flex-direction: column; gap: ${u(10)}; padding: ${u(14)} ${u(16)}; border-radius: ${u(14)}; background: rgba(0, 0, 0, .25); border: 1px solid var(--ip-line); min-height: 0; }
.ip-mp-box-head { display: flex; align-items: center; gap: ${u(10)}; }
.ip-mp-box-head h3 { margin: 0; font-size: ${u(11)}; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; color: var(--ip-accent-2); }
.ip-mp-box-head .ip-btn { margin-left: auto; height: ${u(30)}; padding: 0 ${u(12)}; font-size: ${u(12)}; }
.ip-mp-rooms { display: flex; flex-direction: column; gap: ${u(6)}; overflow: auto; min-height: ${u(120)}; max-height: ${u(330)}; }
.ip-mp-room { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: ${u(12)}; padding: ${u(9)} ${u(12)}; border-radius: ${u(10)}; cursor: pointer; text-align: left;
  background: rgba(255, 255, 255, .03); border: 1px solid rgba(255, 255, 255, .06); color: var(--ip-text); pointer-events: auto; }
.ip-mp-room:hover:not([disabled]), .ip-mp-room:focus-visible { outline: none; border-color: var(--ip-accent); background: rgba(var(--ip-accent-rgb), .08); }
.ip-mp-room[disabled] { opacity: .5; cursor: default; }
.ip-mp-room b { display: block; font-size: ${u(14)}; font-weight: 750; }
.ip-mp-room small { display: block; font-size: ${u(11)}; color: var(--ip-faint); margin-top: ${u(1)}; }
.ip-mp-room-n { font-size: ${u(12)}; font-weight: 750; color: var(--ip-dim); font-variant-numeric: tabular-nums; }
.ip-mp-room-tag { font-size: ${u(9.5)}; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; padding: ${u(4)} ${u(8)}; border-radius: ${u(6)}; background: rgba(var(--ip-accent-rgb), .16); color: var(--ip-accent-2); }
.ip-mp-room-tag.is-busy { background: rgba(255, 255, 255, .06); color: var(--ip-faint); }
.ip-mp-empty { padding: ${u(26)} ${u(12)}; text-align: center; color: var(--ip-faint); font-size: ${u(12.5)}; line-height: 1.6; }
.ip-mp-maps { display: flex; flex-direction: column; gap: ${u(6)}; }
.ip-mp-map { display: flex; align-items: center; gap: ${u(10)}; padding: ${u(6)} ${u(8)}; border-radius: ${u(10)}; cursor: pointer; text-align: left; pointer-events: auto;
  background: rgba(255, 255, 255, .03); border: 1px solid rgba(255, 255, 255, .06); color: var(--ip-text); }
.ip-mp-map:hover, .ip-mp-map:focus-visible { outline: none; border-color: var(--ip-line-2); }
.ip-mp-map.is-sel { border-color: var(--ip-accent); background: rgba(var(--ip-accent-rgb), .12); box-shadow: inset ${u(3)} 0 0 var(--ip-accent); }
.ip-mp-map .ip-map-thumb { width: ${u(40)}; height: ${u(40)}; }
.ip-mp-map b { font-size: ${u(13)}; font-weight: 720; }
.ip-mp-facs { display: grid; grid-template-columns: 1fr 1fr; gap: ${u(8)}; }
.ip-mp-fac { position: relative; display: flex; flex-direction: column; gap: ${u(4)}; padding: ${u(9)} ${u(10)} ${u(9)} ${u(44)}; min-height: ${u(70)}; border-radius: ${u(10)}; cursor: pointer; text-align: left; pointer-events: auto;
  background: rgba(255, 255, 255, .03); border: 1px solid rgba(255, 255, 255, .07); color: var(--ip-text); --fc: #2fd6c6; }
.ip-mp-fac .ip-mp-fac-ico { position: absolute; left: ${u(8)}; top: ${u(10)}; width: ${u(28)}; height: ${u(28)}; }
.ip-mp-fac b { font-size: ${u(12.5)}; font-weight: 760; color: var(--fc); }
.ip-mp-fac span { font-size: ${u(10.5)}; line-height: 1.4; color: var(--ip-dim); }
.ip-mp-fac:hover, .ip-mp-fac:focus-visible { outline: none; border-color: color-mix(in srgb, var(--fc) 60%, transparent); }
.ip-mp-fac[aria-pressed="true"] { border-color: var(--fc); background: color-mix(in srgb, var(--fc) 13%, transparent); box-shadow: 0 0 ${u(14)} color-mix(in srgb, var(--fc) 25%, transparent); }
.ip-mp-fac[disabled] { cursor: default; }
.ip-mp-host-foot { margin-top: auto; display: flex; justify-content: flex-end; }
.ip-mp-host-foot .ip-btn-primary { height: ${u(44)}; padding: 0 ${u(24)}; font-size: ${u(14.5)}; }
.ip-mp .ip-set-hint b { color: var(--ip-dim); }

/* lobby */
.ip-mp-lobby { display: grid; grid-template-columns: 1fr ${u(330)}; gap: ${u(16)}; flex: 1; min-height: 0; }
.ip-mp-lobby-l { display: flex; flex-direction: column; gap: ${u(10)}; min-height: 0; }
.ip-mp-slots { display: grid; grid-template-columns: 1fr ${u(36)} 1fr; align-items: stretch; gap: ${u(8)}; }
.ip-mp-vs { display: flex; align-items: center; justify-content: center; font-size: ${u(12)}; font-weight: 850; letter-spacing: .2em; color: var(--ip-faint); }
.ip-mp-slot { position: relative; display: flex; flex-direction: column; gap: ${u(8)}; padding: ${u(12)} ${u(14)}; border-radius: ${u(12)}; --fc: #2fd6c6;
  background: color-mix(in srgb, var(--fc) 10%, rgba(4, 10, 14, .55)); border: 1px solid color-mix(in srgb, var(--fc) 40%, transparent); min-height: ${u(150)}; }
.ip-mp-slot.is-empty { --fc: #62837f; background: rgba(0, 0, 0, .2); border-style: dashed; align-items: center; justify-content: center; color: var(--ip-faint); font-size: ${u(12.5)}; text-align: center; }
.ip-mp-slot-top { display: flex; align-items: center; gap: ${u(10)}; }
.ip-mp-slot-ico { width: ${u(42)}; height: ${u(42)}; flex: none; }
.ip-mp-slot-name { font-size: ${u(17)}; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-mp-slot-role { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: ${u(9)}; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; color: var(--ip-faint); }
.ip-mp-slot-role em { font-style: normal; color: var(--ip-accent-2); }
.ip-mp-badge { white-space: nowrap; max-width: 100%; overflow: hidden; display: inline-flex; align-items: center; gap: ${u(6)}; align-self: flex-start; padding: ${u(4)} ${u(9)}; border-radius: ${u(999)}; font-size: ${u(11)}; font-weight: 750;
  color: var(--fc); background: rgba(0, 0, 0, .35); border: 1px solid color-mix(in srgb, var(--fc) 45%, transparent); }
.ip-mp-badge i { width: ${u(8)}; height: ${u(8)}; border-radius: 50%; background: var(--fc); box-shadow: 0 0 ${u(6)} var(--fc); }
.ip-mp-ready { margin-top: auto; display: flex; align-items: center; gap: ${u(8)}; font-size: ${u(11)}; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--ip-faint); }
.ip-mp-ready i { width: ${u(10)}; height: ${u(10)}; border-radius: 50%; border: 2px solid currentColor; }
.ip-mp-ready.is-on { color: var(--ip-ok); }
.ip-mp-ready.is-on i { background: currentColor; box-shadow: 0 0 ${u(8)} currentColor; }
.ip-mp-ready.is-lost { color: var(--ip-warn); }
.ip-mp-slot .ip-seg { margin-top: ${u(2)}; }
.ip-mp-chat { display: flex; flex-direction: column; gap: ${u(6)}; flex: 1; min-height: ${u(130)}; }
.ip-mp-chat-log { flex: 1; overflow: auto; min-height: ${u(90)}; max-height: ${u(170)}; padding: ${u(8)} ${u(10)}; border-radius: ${u(10)}; background: rgba(0, 0, 0, .3); border: 1px solid var(--ip-line);
  font-size: ${u(12.5)}; line-height: 1.5; user-select: text; -webkit-user-select: text; }
.ip-mp-chat-log p { margin: 0; overflow-wrap: anywhere; }
.ip-mp-chat-log p b { color: var(--nc, var(--ip-accent-2)); font-weight: 750; margin-right: ${u(6)}; }
.ip-mp-chat-log p.is-sys { color: var(--ip-faint); font-style: italic; }
.ip-mp-chat-row { display: flex; gap: ${u(8)}; }
.ip-mp-chat-row .ip-btn { height: ${u(34)}; padding: 0 ${u(14)}; }
.ip-mp-lobby-r { display: flex; flex-direction: column; gap: ${u(10)}; min-height: 0; }
.ip-mp-lobby-r .ip-map-preview { width: ${u(210)}; max-width: 100%; align-self: center; margin: 0; flex: none; }
.ip-mp-lobby-r .ip-seg { flex-wrap: wrap; }
.ip-mp-mapname { font-size: ${u(16)}; font-weight: 800; }
.ip-mp-mapdesc { font-size: ${u(11.5)}; line-height: 1.5; color: var(--ip-dim); }
.ip-mp-actions { margin-top: auto; display: flex; gap: ${u(8)}; flex-wrap: wrap; }
.ip-mp-actions .ip-btn { flex: 1 1 0; height: ${u(42)}; padding: 0 ${u(12)}; white-space: nowrap; }
.ip-mp-actions .ip-btn[data-testid="mp-leave"] { flex-basis: 100%; height: ${u(34)}; }
.ip-mp-actions .ip-btn.is-ready { border-color: var(--ip-ok); color: var(--ip-ok); box-shadow: 0 0 ${u(12)} rgba(78, 230, 160, .25); }
.ip-mp-actions .ip-btn.is-ready .ip-glyph { color: var(--ip-ok); }
.ip-mp-count { position: fixed; inset: 0; z-index: 80; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${u(10)}; pointer-events: auto;
  background: radial-gradient(ellipse at center, rgba(4, 16, 20, .93), rgba(1, 4, 6, .97)); }
.ip-mp-count-k { font-size: ${u(12)}; font-weight: 800; letter-spacing: .3em; text-transform: uppercase; color: var(--ip-accent); }
.ip-mp-count-n { font-size: ${u(120)}; font-weight: 900; line-height: 1; color: var(--ip-text); text-shadow: 0 0 ${u(40)} rgba(var(--ip-accent-rgb), .6); font-variant-numeric: tabular-nums; animation: ip-mp-tick 1s ease-out infinite; }
.ip-mp-count-vs { font-size: ${u(15)}; color: var(--ip-dim); }
.ip-mp-count-vs b { color: var(--ip-text); }
@keyframes ip-mp-tick { 0% { transform: scale(1.25); opacity: .2; } 25% { transform: scale(1); opacity: 1; } 100% { opacity: .9; } }

/* ───────────── in-game multiplayer layer ───────────── */
.ip-tb-opp { position: relative; display: flex; align-items: center; gap: ${u(9)}; padding: 0 ${u(14)} 0 ${u(10)}; --fc: #d64bff; }
.ip-tb-opp::after { content: ""; position: absolute; right: 0; top: ${u(10)}; bottom: ${u(10)}; width: 1px; background: var(--ip-line); }
.ip-tb-opp-ico { width: ${u(26)}; height: ${u(26)}; flex: none; }
.ip-tb-opp-txt { display: flex; flex-direction: column; justify-content: center; min-width: 0; }
.ip-tb-opp-k { font-size: ${u(8.5)}; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--ip-faint); line-height: 1; margin-bottom: ${u(3)}; white-space: nowrap; }
.ip-tb-opp-k em { font-style: normal; color: var(--fc); }
.ip-tb-opp-name { font-size: ${u(14)}; font-weight: 760; line-height: 1; max-width: ${u(130)}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-ping { display: flex; align-items: flex-end; gap: ${u(2)}; height: ${u(14)}; margin-left: ${u(4)}; --pc: var(--ip-faint); }
.ip-ping i { width: ${u(3)}; border-radius: 1px; background: rgba(255, 255, 255, .14); }
.ip-ping i:nth-child(1) { height: 35%; } .ip-ping i:nth-child(2) { height: 65%; } .ip-ping i:nth-child(3) { height: 100%; }
.ip-ping[data-q="3"] i, .ip-ping[data-q="2"] i:nth-child(-n+2), .ip-ping[data-q="1"] i:nth-child(1) { background: var(--pc); }
.ip-ping[data-q="3"] { --pc: var(--ip-ok); } .ip-ping[data-q="2"] { --pc: var(--ip-warn); } .ip-ping[data-q="1"] { --pc: var(--ip-alert); }
.ip-ping-ms { font-size: ${u(10)}; font-weight: 700; color: var(--ip-dim); font-variant-numeric: tabular-nums; min-width: ${u(38)}; }
.ip-mpchat { position: absolute; left: ${u(12)}; bottom: ${u(300)}; width: ${u(420)}; display: flex; flex-direction: column; gap: ${u(4)}; pointer-events: none; z-index: 12; }
.ip-mpchat-log { display: flex; flex-direction: column; gap: ${u(3)}; }
.ip-mpchat-msg { align-self: flex-start; max-width: 100%; padding: ${u(4)} ${u(10)}; border-radius: ${u(8)}; font-size: ${u(13)}; line-height: 1.4; color: var(--ip-text);
  background: rgba(3, 10, 14, .62); text-shadow: 0 1px 2px rgba(0, 0, 0, .8); overflow-wrap: anywhere; transition: opacity .6s; }
.ip-mpchat-msg b { color: var(--nc, var(--ip-accent-2)); margin-right: ${u(6)}; }
.ip-mpchat-msg.is-sys { color: var(--ip-dim); font-style: italic; }
.ip-mpchat-msg.is-old { opacity: 0; }
.ip-mpchat.is-typing .ip-mpchat-msg.is-old { opacity: .85; }
.ip-mpchat-in { display: none; align-items: center; gap: ${u(8)}; padding: ${u(4)} ${u(6)} ${u(4)} ${u(10)}; border-radius: ${u(10)}; pointer-events: auto;
  background: rgba(3, 10, 14, .88); border: 1px solid var(--ip-line-2); }
.ip-mpchat.is-typing .ip-mpchat-in { display: flex; }
.ip-mpchat-in .ip-caps { color: var(--ip-accent-2); }
.ip-mpchat-in .ip-input { height: ${u(30)}; border: 0; background: transparent; box-shadow: none !important; }
.ip-mpchat-hint { font-size: ${u(10)}; color: var(--ip-faint); white-space: nowrap; }
.ip-mpwait { position: absolute; left: 50%; top: 34%; transform: translate(-50%, -50%); z-index: 30; display: flex; align-items: center; gap: ${u(14)}; padding: ${u(16)} ${u(22)}; pointer-events: none; }
.ip-mpwait-spin { width: ${u(26)}; height: ${u(26)}; border-radius: 50%; border: 3px solid rgba(var(--ip-accent-rgb), .25); border-top-color: var(--ip-accent); animation: ip-spin .8s linear infinite; }
.ip-mpwait b { display: block; font-size: ${u(16)}; font-weight: 780; }
.ip-mpwait span { display: block; font-size: ${u(11.5)}; color: var(--ip-dim); margin-top: ${u(2)}; }
.ip-mpdesync { position: absolute; left: 50%; top: ${u(64)}; transform: translateX(-50%); z-index: 31; display: flex; align-items: center; gap: ${u(10)}; padding: ${u(8)} ${u(16)}; border-radius: ${u(999)};
  font-size: ${u(12.5)}; font-weight: 700; color: #1a1204; background: var(--ip-warn); box-shadow: 0 0 ${u(18)} rgba(255, 182, 72, .45); pointer-events: none; }
.ip-mpdesync::before { content: ""; width: ${u(11)}; height: ${u(11)}; border-radius: 50%; border: 2px solid rgba(26, 18, 4, .3); border-top-color: #1a1204; animation: ip-spin .8s linear infinite; }
.ip-mpleft-card { width: ${u(420)}; padding: ${u(24)} ${u(26)} ${u(22)}; display: flex; flex-direction: column; gap: ${u(10)}; text-align: center; animation: ip-pop .22s ease-out; }
.ip-mpleft-title { font-size: ${u(20)}; font-weight: 850; letter-spacing: .14em; text-transform: uppercase; }
.ip-mpleft-txt { font-size: ${u(13)}; color: var(--ip-dim); line-height: 1.5; }
.ip-mpleft-n { font-size: ${u(46)}; font-weight: 900; color: var(--ip-accent-2); font-variant-numeric: tabular-nums; line-height: 1.1; }
.ip-mpleft-row { display: flex; gap: ${u(8)}; margin-top: ${u(6)}; }
.ip-mpleft-row .ip-btn { flex: 1; }
.ip-hud.ip-mp .ip-speed { display: none; }
`;

const STYLE_ID = 'ip-mp-style';

export function ensureMpStyles(): void {
  ensureUiStyles();
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}
