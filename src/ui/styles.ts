/**
 * [ui] The one injected stylesheet for every screen (HUD, overlays, main menu) + responsive UI scale.
 *
 * Visual identity — "clinical glass": floating dark translucent modules with hairline teal rims, a tiny
 * ECG blip on the top edge of every major panel, vital-sign style readouts (small caps label above a big
 * tabular number, one colour per channel), crisp sans-serif. Hospital = teal, pathogen = magenta/acid.
 *
 * Sizes are written in design units at 1600×900 via u(n) → calc(n * var(--ip-u)); installUiScale() keeps
 * --ip-u in sync with the viewport (0.8 at 1280×720 … 1.6 at 2560×1440) so nothing reflows on resize.
 */

const u = (n: number): string => `calc(${n} * var(--ip-u, 1px))`;

const svgUri = (svg: string): string => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
/** ECG blip used as a CSS mask (coloured by background-color). */
const ECG_MASK = svgUri(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 14' preserveAspectRatio='none'><path d='M0 9 H36 L39 6.6 L41.5 9 H44 L47 1.6 L50.5 12.8 L53 5 L55 9 H60 Q63 5.6 66 9 H96' fill='none' stroke='black' stroke-width='1.5' stroke-linejoin='round' stroke-linecap='round'/></svg>`);
/** Long repeating trace for decorative separators. */
const ECG_LINE = svgUri(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 20' preserveAspectRatio='none'><path d='M0 12 H58 L62 9 L65 12 H70 L74 2 L78.5 18 L82 7 L85 12 H94 Q98 7.5 102 12 H160' fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round' stroke-linecap='round'/></svg>`);
const NOISE = svgUri(`<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .05 0'/></filter><rect width='120' height='120' filter='url(#n)'/></svg>`);

const CSS = /* css */ `
:root { --ip-u: 1px; }
.ip-root {
  --ip-font: "Inter", "Segoe UI", "Roboto", "Helvetica Neue", Arial, "Liberation Sans", system-ui, sans-serif;
  --ip-mono: "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace;
  --ip-accent: #35e2d0; --ip-accent-rgb: 53, 226, 208; --ip-accent-2: #a6fff3;
  --ip-text: #e3f4f2; --ip-dim: #97b8b5; --ip-faint: #62837f;
  --ip-ok: #4ee6a0; --ip-warn: #ffb648; --ip-alert: #ff5a6b; --ip-info: #6fd3ff; --ip-power: #ffc94d; --ip-uv: #b48cff;
  --ip-glass: linear-gradient(180deg, rgba(17, 38, 46, .80) 0%, rgba(7, 16, 22, .86) 100%);
  --ip-line: rgba(130, 240, 226, .16); --ip-line-2: rgba(130, 240, 226, .32);
  --ip-shadow: 0 ${u(10)} ${u(28)} rgba(0, 0, 0, .38), inset 0 1px 0 rgba(255, 255, 255, .06);
  font-family: var(--ip-font); color: var(--ip-text);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  font-size: ${u(13)}; line-height: 1.35; user-select: none; -webkit-user-select: none;
}
.ip-root.ip-faction-pathogen { --ip-accent: #d36bff; --ip-accent-rgb: 211, 107, 255; --ip-accent-2: #f1cbff; --ip-line: rgba(211, 107, 255, .18); --ip-line-2: rgba(211, 107, 255, .36); }
/* NOTE: no universal ::before/::after selectors — over thousands of inline-SVG nodes they stall Chrome's style/paint. */
.ip-root div, .ip-root span, .ip-root button, .ip-root section, .ip-root canvas, .ip-root input, .ip-root table, .ip-root td, .ip-root th, .ip-root h1, .ip-root h2, .ip-root h3, .ip-root p, .ip-root ul, .ip-root li { box-sizing: border-box; }
.ip-root button { font-family: inherit; color: inherit; }
.ip-glyph { width: 1em; height: 1em; display: inline-block; vertical-align: -0.14em; flex: none; }
.ip-ico { display: block; }

/* ───────────── shared: glass panels with an ECG blip ───────────── */
.ip-panel {
  position: absolute; pointer-events: auto;
  background: var(--ip-glass);
  border: 1px solid var(--ip-line); border-radius: ${u(14)};
  box-shadow: var(--ip-shadow);
  backdrop-filter: blur(8px) saturate(1.2); -webkit-backdrop-filter: blur(8px) saturate(1.2);
}
.ip-lowfx .ip-panel, .ip-softgpu .ip-panel { backdrop-filter: none; -webkit-backdrop-filter: none; background: linear-gradient(180deg, rgba(14, 32, 40, .93), rgba(6, 14, 20, .95)); }
.ip-panel.ip-ecg::before {
  content: ""; position: absolute; top: ${u(-7)}; left: 50%; width: ${u(84)}; height: ${u(13)}; transform: translateX(-50%);
  background: var(--ip-accent); -webkit-mask: ${ECG_MASK} center / 100% 100% no-repeat; mask: ${ECG_MASK} center / 100% 100% no-repeat;
  opacity: .8; pointer-events: none; filter: drop-shadow(0 0 ${u(4)} rgba(var(--ip-accent-rgb), .6));
}
.ip-panel.ip-ecg::after {
  content: ""; position: absolute; top: -1px; left: 14%; right: 14%; height: 1px; pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(var(--ip-accent-rgb), .55), transparent);
}
.ip-caps { font-size: ${u(9)}; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--ip-faint); }
.ip-num { font-variant-numeric: tabular-nums; }

.ip-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: ${u(8)};
  height: ${u(38)}; padding: 0 ${u(18)}; border-radius: ${u(10)}; cursor: pointer; pointer-events: auto;
  font-size: ${u(13)}; font-weight: 650; letter-spacing: .04em;
  background: linear-gradient(180deg, rgba(30, 62, 72, .85), rgba(14, 32, 40, .9));
  border: 1px solid var(--ip-line-2); color: var(--ip-text);
  transition: border-color .12s, box-shadow .12s, background .12s, transform .08s;
}
.ip-btn:hover, .ip-btn:focus-visible { border-color: var(--ip-accent); box-shadow: 0 0 0 1px rgba(var(--ip-accent-rgb), .5), 0 0 ${u(16)} rgba(var(--ip-accent-rgb), .25); outline: none; }
.ip-btn:active { transform: translateY(1px); }
.ip-btn .ip-glyph { font-size: ${u(16)}; color: var(--ip-accent-2); }
.ip-btn-primary { background: linear-gradient(180deg, rgba(var(--ip-accent-rgb), .95), rgba(var(--ip-accent-rgb), .72)); color: #03181a; border-color: rgba(255, 255, 255, .35); text-shadow: 0 1px 0 rgba(255, 255, 255, .25); }
.ip-btn-primary .ip-glyph { color: #03181a; }
.ip-btn-primary:hover, .ip-btn-primary:focus-visible { box-shadow: 0 0 0 1px rgba(255, 255, 255, .45), 0 0 ${u(22)} rgba(var(--ip-accent-rgb), .55); }
.ip-btn-danger:hover, .ip-btn-danger:focus-visible { border-color: var(--ip-alert); box-shadow: 0 0 0 1px rgba(255, 90, 107, .5), 0 0 ${u(16)} rgba(255, 90, 107, .25); }
.ip-btn[disabled] { opacity: .4; cursor: default; pointer-events: none; }

.ip-bar { position: relative; height: ${u(14)}; border-radius: ${u(7)}; background: rgba(0, 0, 0, .45); border: 1px solid rgba(255, 255, 255, .08); overflow: hidden; }
.ip-bar-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; transform-origin: left center; border-radius: inherit;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bar, #4ee6a0) 100%, white 18%), var(--bar, #4ee6a0)); transition: transform .18s linear; }
.ip-bar-fill::after { content: ""; position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0 ${u(9)}, rgba(0, 0, 0, .18) ${u(9)} ${u(10)}); }
.ip-bar-txt { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: ${u(10.5)}; font-weight: 700; letter-spacing: .03em; color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, .9); font-variant-numeric: tabular-nums; }

.ip-cost { display: inline-flex; align-items: center; gap: ${u(3)}; font-weight: 700; font-variant-numeric: tabular-nums; margin-right: ${u(10)}; white-space: nowrap; }
.ip-cost .ip-glyph { font-size: ${u(13)}; }
.ip-cost-m { color: #63f0da; } .ip-cost-e { color: var(--ip-power); } .ip-cost-p { color: #cfe3ff; } .ip-cost-t { color: var(--ip-dim); }
.ip-faction-pathogen .ip-cost-m, .ip-cost-m.is-path { color: #a8ff4f; }
.ip-faction-pathogen .ip-cost-e { color: #e889ff; }
.ip-cost.is-short { color: var(--ip-alert) !important; }

/* tooltip */
.ip-tip { position: absolute; z-index: 60; left: 0; top: 0; width: max-content; max-width: ${u(310)}; padding: ${u(10)} ${u(12)} ${u(11)};
  background: linear-gradient(180deg, rgba(10, 24, 30, .97), rgba(4, 11, 15, .97)); border: 1px solid var(--ip-line-2); border-radius: ${u(10)};
  box-shadow: 0 ${u(12)} ${u(30)} rgba(0, 0, 0, .5); pointer-events: none; opacity: 0; transition: opacity .1s; font-size: ${u(12)}; color: var(--ip-text); }
.ip-tip.is-on { opacity: 1; }
.ip-tip-title { display: flex; align-items: center; gap: ${u(8)}; font-size: ${u(14)}; font-weight: 750; margin-bottom: ${u(2)}; }
.ip-tip-title .ip-key { margin-left: auto; }
.ip-tip-role { color: var(--ip-accent-2); font-size: ${u(11)}; margin-bottom: ${u(6)}; opacity: .9; }
.ip-tip-cost { display: flex; flex-wrap: wrap; margin: ${u(4)} 0 ${u(6)}; font-size: ${u(12)}; }
.ip-tip-body { color: var(--ip-dim); line-height: 1.45; white-space: pre-line; }
.ip-tip-warn { margin-top: ${u(7)}; color: var(--ip-alert); font-weight: 650; display: flex; gap: ${u(6)}; align-items: center; }
.ip-key { display: inline-flex; align-items: center; justify-content: center; min-width: ${u(18)}; height: ${u(18)}; padding: 0 ${u(5)}; border-radius: ${u(5)};
  font: 700 ${u(10.5)}/1 var(--ip-font); color: var(--ip-accent-2); background: rgba(0, 0, 0, .5); border: 1px solid var(--ip-line-2); }

/* ───────────── HUD root ───────────── */
.ip-hud { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }

/* top bar: vital-sign readouts */
.ip-topbar { top: ${u(10)}; right: ${u(10)}; height: ${u(46)}; display: flex; align-items: stretch; padding: 0 ${u(6)} 0 ${u(4)}; border-radius: ${u(13)}; }
.ip-res { position: relative; display: flex; align-items: center; gap: ${u(9)}; padding: 0 ${u(14)}; --c: #63f0da; cursor: default; }
.ip-res + .ip-res::before, .ip-tb-group::before { content: ""; position: absolute; left: 0; top: ${u(10)}; bottom: ${u(10)}; width: 1px; background: var(--ip-line); }
.ip-res-ico { font-size: ${u(20)}; color: var(--c); display: flex; filter: drop-shadow(0 0 ${u(5)} color-mix(in srgb, var(--c) 45%, transparent)); }
.ip-res-txt { display: flex; flex-direction: column; justify-content: center; }
.ip-res-label { font-size: ${u(8.5)}; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--ip-faint); line-height: 1; margin-bottom: ${u(3)}; white-space: nowrap; }
.ip-res-val { font-size: ${u(18)}; font-weight: 750; line-height: 1; color: var(--c); font-variant-numeric: tabular-nums; min-width: ${u(46)}; white-space: nowrap; }
.ip-res-val small { font-size: ${u(12)}; font-weight: 650; opacity: .65; }
.ip-res-rate { font-size: ${u(9.5)}; color: var(--ip-faint); margin-left: ${u(4)}; font-weight: 600; }
.ip-res.is-capped .ip-res-val { color: var(--ip-warn); }
.ip-res.is-flash .ip-res-val { animation: ip-flash 1s ease-out; }
.ip-res.is-flash .ip-res-ico { animation: ip-flash-ico 1s ease-out; }
@keyframes ip-flash { 0%, 35% { color: var(--ip-alert); text-shadow: 0 0 ${u(12)} rgba(255, 90, 107, .9); } 100% { color: var(--c); text-shadow: none; } }
@keyframes ip-flash-ico { 0%, 35% { color: var(--ip-alert); transform: scale(1.18); } 100% { color: var(--c); transform: none; } }
.ip-tb-group { position: relative; display: flex; align-items: center; gap: ${u(8)}; padding: 0 ${u(8)} 0 ${u(14)}; }
.ip-clock { display: flex; align-items: center; gap: ${u(7)}; font-size: ${u(16)}; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--ip-text); min-width: ${u(84)}; }
.ip-clock .ip-glyph { font-size: ${u(18)}; color: var(--ip-accent); animation: ip-beat 1.1s ease-out infinite; }
@keyframes ip-beat { 0%, 100% { opacity: .55; } 12% { opacity: 1; filter: drop-shadow(0 0 3px rgba(var(--ip-accent-rgb), .9)); } }
.ip-paused .ip-clock .ip-glyph { animation: none; color: var(--ip-warn); }
.ip-speed { font-size: ${u(11)}; font-weight: 750; padding: ${u(3)} ${u(7)}; border-radius: ${u(6)}; color: var(--ip-dim); background: rgba(0, 0, 0, .3); border: 1px solid var(--ip-line); font-variant-numeric: tabular-nums; min-width: ${u(40)}; text-align: center; }
.ip-speed.is-fast { color: var(--ip-accent-2); border-color: var(--ip-line-2); }
.ip-speed.is-paused { color: #1a1204; background: var(--ip-warn); border-color: transparent; }
.ip-tb-btn { display: flex; align-items: center; gap: ${u(6)}; height: ${u(30)}; padding: 0 ${u(11)}; margin-left: ${u(2)}; border-radius: ${u(8)}; cursor: pointer;
  background: rgba(255, 255, 255, .04); border: 1px solid var(--ip-line); font-size: ${u(12)}; font-weight: 650; letter-spacing: .03em; }
.ip-tb-btn .ip-glyph { font-size: ${u(15)}; color: var(--ip-accent); }
.ip-tb-btn:hover { border-color: var(--ip-accent); background: rgba(var(--ip-accent-rgb), .12); }
.ip-tb-btn .ip-key { height: ${u(16)}; font-size: ${u(9)}; }
.ip-fps { position: absolute; top: ${u(62)}; right: ${u(14)}; font: 700 ${u(10.5)}/1 var(--ip-mono); color: var(--ip-dim); background: rgba(0, 0, 0, .45); padding: ${u(4)} ${u(7)}; border-radius: ${u(5)}; pointer-events: none; }
.ip-fps.is-low { color: var(--ip-warn); }

/* mission timer (centre top) */
.ip-mtimer { top: ${u(10)}; left: 50%; transform: translateX(-50%); min-width: ${u(176)}; height: ${u(46)}; padding: ${u(6)} ${u(18)}; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; }
.ip-mtimer-label { font-size: ${u(8.5)}; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: var(--ip-dim); line-height: 1; margin-bottom: ${u(4)}; white-space: nowrap; }
.ip-mtimer-val { font-size: ${u(20)}; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: .04em; }
.ip-mtimer.is-urgent { border-color: rgba(255, 90, 107, .55); }
.ip-mtimer.is-urgent .ip-mtimer-val { color: var(--ip-alert); animation: ip-pulse-red 1s ease-in-out infinite; }
@keyframes ip-pulse-red { 50% { text-shadow: 0 0 ${u(14)} rgba(255, 90, 107, .9); } }

/* left column: objectives + alerts */
.ip-leftcol { position: absolute; top: ${u(10)}; left: ${u(10)}; width: ${u(300)}; display: flex; flex-direction: column; gap: ${u(8)}; pointer-events: none; }
.ip-obj { position: relative; padding: ${u(10)} ${u(12)} ${u(10)}; }
.ip-obj-head { display: flex; align-items: center; gap: ${u(7)}; cursor: pointer; }
.ip-obj-head .ip-glyph { font-size: ${u(15)}; color: var(--ip-accent); }
.ip-obj-title { font-size: ${u(10)}; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; color: var(--ip-accent-2); }
.ip-obj-toggle { margin-left: auto; font-size: ${u(10)}; color: var(--ip-faint); }
.ip-obj-list { margin-top: ${u(8)}; display: flex; flex-direction: column; gap: ${u(5)}; }
.ip-obj.is-collapsed .ip-obj-list { display: none; }
.ip-obj-sub { margin-top: ${u(4)}; font-size: ${u(8.5)}; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: #ffd27a; opacity: .8; }
.ip-obj-item { display: flex; align-items: flex-start; gap: ${u(8)}; font-size: ${u(12.5)}; line-height: 1.3; color: var(--ip-text); border-radius: ${u(6)}; padding: ${u(2)} ${u(3)}; }
.ip-obj-mark { flex: none; width: ${u(16)}; height: ${u(16)}; margin-top: ${u(1)}; display: flex; align-items: center; justify-content: center; border-radius: 50%;
  border: 1.5px solid var(--ip-accent); color: transparent; font-size: ${u(11)}; }
.ip-obj-item.is-bonus .ip-obj-mark { border-color: #ffd27a; border-radius: ${u(4)}; transform: rotate(45deg) scale(.85); }
.ip-obj-item.is-bonus .ip-obj-mark .ip-glyph { transform: rotate(-45deg); }
.ip-obj-text { flex: 1; }
.ip-obj-prog { flex: none; font-size: ${u(11)}; font-weight: 700; color: var(--ip-accent-2); font-variant-numeric: tabular-nums; }
.ip-obj-item.is-done { color: var(--ip-dim); }
.ip-obj-item.is-done .ip-obj-text { text-decoration: line-through; text-decoration-color: rgba(var(--ip-accent-rgb), .6); }
.ip-obj-item.is-done .ip-obj-mark { background: var(--ip-accent); border-color: var(--ip-accent); color: #03181a; }
.ip-obj-item.is-bonus.is-done .ip-obj-mark { background: #ffd27a; border-color: #ffd27a; color: #2a1c02; }
.ip-obj-item.is-failed { color: #ff9aa5; }
.ip-obj-item.is-failed .ip-obj-text { text-decoration: line-through; text-decoration-color: rgba(255, 90, 107, .7); }
.ip-obj-item.is-failed .ip-obj-mark { border-color: var(--ip-alert); background: rgba(255, 90, 107, .2); color: var(--ip-alert); }
.ip-obj-item.is-new { animation: ip-obj-new 2.4s ease-out; }
.ip-obj-item.just-done { animation: ip-obj-done 1.8s ease-out; }
@keyframes ip-obj-new { 0% { background: rgba(var(--ip-accent-rgb), .35); transform: translateX(${u(-8)}); } 25% { transform: none; } 100% { background: transparent; } }
@keyframes ip-obj-done { 0% { background: rgba(78, 230, 160, .4); } 100% { background: transparent; } }

.ip-alerts { display: flex; flex-direction: column; gap: ${u(5)}; }
.ip-alert { pointer-events: auto; display: flex; align-items: center; gap: ${u(8)}; height: ${u(28)}; padding: 0 ${u(10)} 0 ${u(8)}; border-radius: ${u(8)};
  background: linear-gradient(90deg, rgba(8, 20, 26, .86), rgba(8, 20, 26, .55)); border: 1px solid var(--ip-line); border-left: ${u(3)} solid var(--k, var(--ip-accent));
  font-size: ${u(12)}; cursor: pointer; animation: ip-slide-in .25s ease-out; transition: opacity .6s, transform .6s; width: max-content; max-width: 100%; }
.ip-alert .ip-glyph { font-size: ${u(14)}; color: var(--k, var(--ip-accent)); }
.ip-alert-time { font-size: ${u(10)}; color: var(--ip-faint); font-variant-numeric: tabular-nums; margin-left: ${u(4)}; }
.ip-alert:hover { border-color: var(--ip-line-2); background: rgba(14, 34, 42, .92); }
.ip-alert.is-out { opacity: 0; transform: translateX(${u(-10)}); }
.ip-alert.k-alert { --k: var(--ip-alert); } .ip-alert.k-warning { --k: var(--ip-warn); } .ip-alert.k-success { --k: var(--ip-ok); } .ip-alert.k-info { --k: var(--ip-info); }
@keyframes ip-slide-in { from { opacity: 0; transform: translateX(${u(-14)}); } to { opacity: 1; transform: none; } }

/* toasts (centre) */
.ip-toasts { position: absolute; top: ${u(68)}; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: ${u(6)}; pointer-events: none; width: ${u(640)}; }
.ip-toast { display: flex; align-items: center; gap: ${u(9)}; min-height: ${u(32)}; padding: ${u(6)} ${u(16)} ${u(6)} ${u(12)}; border-radius: ${u(999)};
  background: rgba(6, 16, 22, .84); border: 1px solid var(--ip-line); box-shadow: 0 ${u(6)} ${u(18)} rgba(0, 0, 0, .35);
  font-size: ${u(13.5)}; font-weight: 650; letter-spacing: .01em; color: var(--ip-text); animation: ip-toast-in .22s ease-out; transition: opacity .45s, transform .45s; }
.ip-toast .ip-glyph { font-size: ${u(16)}; color: var(--k, var(--ip-accent)); }
.ip-toast.k-warning { --k: var(--ip-warn); border-color: rgba(255, 182, 72, .35); }
.ip-toast.k-alert { --k: var(--ip-alert); border-color: rgba(255, 90, 107, .5); background: linear-gradient(90deg, rgba(60, 8, 16, .88), rgba(20, 6, 10, .88)); }
.ip-toast.k-success { --k: var(--ip-ok); border-color: rgba(78, 230, 160, .35); }
.ip-toast.k-info { --k: var(--ip-info); }
.ip-toast-count { font-size: ${u(11)}; font-weight: 800; color: var(--k, var(--ip-accent)); opacity: .9; }
.ip-toast.is-out { opacity: 0; transform: translateY(${u(-6)}); }
.ip-toast.is-bump { animation: ip-toast-bump .3s ease-out; }
@keyframes ip-toast-in { from { opacity: 0; transform: translateY(${u(-8)}) scale(.97); } to { opacity: 1; transform: none; } }
@keyframes ip-toast-bump { 40% { transform: scale(1.05); } }

/* minimap */
.ip-minimap { left: ${u(10)}; bottom: ${u(10)}; width: ${u(206)}; height: ${u(206)}; padding: ${u(8)}; border-radius: ${u(14)}; }
.ip-mm-wrap { position: absolute; inset: ${u(8)}; border-radius: ${u(8)}; overflow: hidden; background: #020507; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .05); }
.ip-mm-wrap canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.ip-mm-over { cursor: crosshair; }
.ip-mm-corners { position: absolute; inset: ${u(4)}; pointer-events: none;
  background:
    linear-gradient(var(--ip-accent), var(--ip-accent)) left top / ${u(10)} 1.5px no-repeat, linear-gradient(var(--ip-accent), var(--ip-accent)) left top / 1.5px ${u(10)} no-repeat,
    linear-gradient(var(--ip-accent), var(--ip-accent)) right top / ${u(10)} 1.5px no-repeat, linear-gradient(var(--ip-accent), var(--ip-accent)) right top / 1.5px ${u(10)} no-repeat,
    linear-gradient(var(--ip-accent), var(--ip-accent)) left bottom / ${u(10)} 1.5px no-repeat, linear-gradient(var(--ip-accent), var(--ip-accent)) left bottom / 1.5px ${u(10)} no-repeat,
    linear-gradient(var(--ip-accent), var(--ip-accent)) right bottom / ${u(10)} 1.5px no-repeat, linear-gradient(var(--ip-accent), var(--ip-accent)) right bottom / 1.5px ${u(10)} no-repeat;
  opacity: .75; }
.ip-mm-label { position: absolute; left: ${u(15)}; top: ${u(13)}; font-size: ${u(8)}; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; color: rgba(230, 255, 251, .72); text-shadow: 0 1px 2px #000; pointer-events: none; }

/* idle workers */
.ip-idle { left: ${u(10)}; bottom: ${u(226)}; width: ${u(52)}; height: ${u(52)}; padding: ${u(4)}; border-radius: ${u(12)}; cursor: pointer; transition: opacity .2s, transform .2s, border-color .12s; }
.ip-idle .ip-ico { border-radius: ${u(9)}; }
.ip-idle:hover { border-color: var(--ip-accent); }
.ip-idle-count { position: absolute; right: ${u(-6)}; top: ${u(-6)}; min-width: ${u(20)}; height: ${u(20)}; padding: 0 ${u(5)}; border-radius: ${u(10)}; display: flex; align-items: center; justify-content: center;
  font-size: ${u(11)}; font-weight: 800; color: #1b1203; background: var(--ip-warn); box-shadow: 0 0 0 2px rgba(6, 16, 22, .9); font-variant-numeric: tabular-nums; }
.ip-idle.is-none { opacity: 0; transform: translateY(${u(6)}); pointer-events: none; }

/* selection panel */
.ip-sel { left: 50%; transform: translateX(-50%); bottom: ${u(10)}; width: ${u(560)}; height: ${u(170)}; padding: ${u(12)} ${u(14)}; overflow: hidden; }
.ip-sel > section { position: absolute; inset: ${u(12)} ${u(14)}; display: none; }
.ip-sel.m-empty .ip-sel-empty, .ip-sel.m-single .ip-sel-single, .ip-sel.m-multi .ip-sel-multi { display: block; }
.ip-sel-empty { display: flex; }
.ip-sel-empty-inner { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${u(8)}; color: var(--ip-faint); }
.ip-sel-empty-ecg { width: 70%; height: ${u(34)}; background: rgba(var(--ip-accent-rgb), .55); -webkit-mask: ${ECG_LINE} center / 100% 100% no-repeat; mask: ${ECG_LINE} center / 100% 100% no-repeat; opacity: .55; animation: ip-breathe 2.6s ease-in-out infinite; }
@keyframes ip-breathe { 50% { opacity: .9; } }
.ip-sel-empty-txt { font-size: ${u(11)}; letter-spacing: .14em; text-transform: uppercase; font-weight: 700; }
.ip-sel-empty-sub { font-size: ${u(11.5)}; color: var(--ip-faint); opacity: .8; }

.ip-sel-top { display: flex; gap: ${u(14)}; height: ${u(88)}; }
.ip-sel-portrait { position: relative; flex: none; width: ${u(88)}; height: ${u(88)}; border-radius: ${u(14)}; padding: ${u(3)};
  background: linear-gradient(180deg, rgba(var(--ip-accent-rgb), .35), rgba(var(--ip-accent-rgb), .05)); box-shadow: 0 0 ${u(18)} rgba(var(--ip-accent-rgb), .18); }
.ip-sel-portrait.is-enemy { background: linear-gradient(180deg, rgba(255, 90, 107, .5), rgba(255, 90, 107, .06)); box-shadow: 0 0 ${u(18)} rgba(255, 90, 107, .2); }
.ip-sel-portrait.is-neutral { background: linear-gradient(180deg, rgba(255, 201, 77, .45), rgba(255, 201, 77, .05)); }
.ip-sel-portrait .ip-ico { border-radius: ${u(11)}; }
.ip-sel-portrait::after { content: ""; position: absolute; inset: ${u(3)}; border-radius: ${u(11)}; pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(255, 255, 255, .035) 0 1px, transparent 1px 3px); }
.ip-sel-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ip-sel-head { display: flex; align-items: baseline; gap: ${u(10)}; }
.ip-sel-name { font-size: ${u(17)}; font-weight: 780; letter-spacing: .01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-sel-owner { margin-left: auto; flex: none; font-size: ${u(9)}; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; padding: ${u(3)} ${u(7)}; border-radius: ${u(5)};
  color: var(--oc, var(--ip-accent)); border: 1px solid color-mix(in srgb, var(--oc, var(--ip-accent)) 45%, transparent); background: color-mix(in srgb, var(--oc, var(--ip-accent)) 12%, transparent); }
.ip-sel-role { font-size: ${u(11.5)}; color: var(--ip-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: ${u(2)} 0 ${u(8)}; }
.ip-sel-hp { height: ${u(17)}; border-radius: ${u(6)}; }
.ip-sel-status { margin-top: ${u(8)}; display: flex; align-items: center; gap: ${u(7)}; font-size: ${u(12)}; color: var(--ip-text); white-space: nowrap; overflow: hidden; }
.ip-sel-status .ip-dot { width: ${u(7)}; height: ${u(7)}; border-radius: 50%; background: var(--sc, var(--ip-faint)); box-shadow: 0 0 ${u(6)} var(--sc, transparent); flex: none; }
.ip-sel-status .ip-sel-extra { margin-left: auto; color: var(--ip-faint); font-size: ${u(11)}; font-variant-numeric: tabular-nums; }
.ip-sel-bottom { position: relative; height: ${u(48)}; margin-top: ${u(10)}; }
.ip-sel-bottom > div { position: absolute; inset: 0; display: none; }
.ip-sel-bottom > div.is-on { display: flex; }

.ip-stats { display: grid !important; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, 1fr); gap: ${u(4)} ${u(8)}; }
.ip-stats:not(.is-on) { display: none !important; }
.ip-stat { display: flex; align-items: center; gap: ${u(7)}; padding: 0 ${u(8)}; border-radius: ${u(6)}; background: rgba(255, 255, 255, .035); border: 1px solid rgba(255, 255, 255, .04); min-width: 0; }
.ip-stat .ip-glyph { font-size: ${u(13)}; color: var(--ip-accent); flex: none; }
.ip-stat-l { font-size: ${u(8.5)}; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; color: var(--ip-faint); flex: none; }
.ip-stat-v { margin-left: auto; font-size: ${u(12)}; font-weight: 720; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-stat-v em { font-style: normal; color: var(--ip-ok); font-size: ${u(10.5)}; margin-left: ${u(3)}; }
.ip-stat.is-blank { opacity: 0; }

.ip-queue { gap: ${u(8)}; align-items: center; }
.ip-q-cur { position: relative; flex: 1; display: flex; align-items: center; gap: ${u(10)}; height: 100%; padding-right: ${u(4)}; min-width: 0; }
.ip-q-slot { position: relative; flex: none; width: ${u(44)}; height: ${u(44)}; border-radius: ${u(9)}; cursor: pointer; background: rgba(0, 0, 0, .3); border: 1px dashed rgba(255, 255, 255, .12); }
.ip-q-slot .ip-ico { border-radius: ${u(8)}; }
.ip-q-slot.is-filled { border: 1px solid transparent; }
.ip-q-slot.is-filled:hover::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: rgba(255, 60, 80, .35) ${svgUri(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'><path d='M6 6 L14 14 M14 6 L6 14' stroke='white' stroke-width='2.4' stroke-linecap='round'/></svg>`)} center / 55% no-repeat; box-shadow: inset 0 0 0 1px rgba(255, 120, 130, .9); }
.ip-q-slot.is-small { width: ${u(36)}; height: ${u(36)}; }
.ip-q-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: ${u(5)}; }
.ip-q-name { font-size: ${u(12)}; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; gap: ${u(8)}; }
.ip-q-name span:last-child { margin-left: auto; color: var(--ip-faint); font-weight: 600; font-variant-numeric: tabular-nums; }
.ip-q-bar { height: ${u(9)}; --bar: var(--ip-accent); }
.ip-q-rest { display: flex; gap: ${u(6)}; flex: none; }
.ip-q-empty { color: var(--ip-faint); font-size: ${u(11.5)}; }

.ip-build { align-items: center; gap: ${u(12)}; }
.ip-build-info { flex: 1; display: flex; flex-direction: column; gap: ${u(5)}; }
.ip-build-label { display: flex; font-size: ${u(11.5)}; font-weight: 700; color: var(--ip-text); }
.ip-build-label span:last-child { margin-left: auto; color: var(--ip-faint); font-variant-numeric: tabular-nums; }
.ip-build-bar { height: ${u(12)}; --bar: var(--ip-warn); }
.ip-build .ip-btn { height: ${u(34)}; padding: 0 ${u(12)}; font-size: ${u(12)}; }

.ip-sel-multi-grid { display: grid; grid-template-columns: repeat(10, ${u(44)}); grid-auto-rows: ${u(44)}; gap: ${u(5)}; justify-content: center; }
.ip-mu { position: relative; border-radius: ${u(9)}; cursor: pointer; transition: transform .08s; }
.ip-mu .ip-ico { border-radius: ${u(9)}; }
.ip-mu::before { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; background: linear-gradient(0deg, rgba(255, 60, 70, var(--hurt, 0)), transparent 70%); }
.ip-mu-hp { position: absolute; left: ${u(4)}; right: ${u(4)}; bottom: ${u(3)}; height: ${u(4)}; border-radius: ${u(2)}; background: rgba(0, 0, 0, .65); overflow: hidden; }
.ip-mu-hp i { position: absolute; inset: 0; transform-origin: left; background: var(--bar, var(--ip-ok)); }
.ip-mu:hover { transform: translateY(-1px); box-shadow: 0 0 0 1.5px var(--ip-accent); }
.ip-mu.is-active { box-shadow: 0 0 0 1.5px rgba(var(--ip-accent-rgb), .9), 0 0 ${u(10)} rgba(var(--ip-accent-rgb), .35); }
.ip-mu.is-more { display: flex; align-items: center; justify-content: center; font-size: ${u(12)}; font-weight: 800; color: var(--ip-accent-2); background: rgba(var(--ip-accent-rgb), .12); border: 1px solid var(--ip-line-2); cursor: default; }
.ip-sel-count { position: absolute; right: 0; top: ${u(-4)}; font-size: ${u(9)}; font-weight: 800; letter-spacing: .14em; color: var(--ip-faint); text-transform: uppercase; }

/* command card */
.ip-card { right: ${u(10)}; bottom: ${u(10)}; padding: ${u(10)}; display: grid; grid-template-columns: repeat(5, ${u(58)}); grid-auto-rows: ${u(58)}; gap: ${u(6)}; }
.ip-cmd { position: relative; padding: 0; border: 0; border-radius: ${u(11)}; background: rgba(0, 0, 0, .28); cursor: pointer; outline: none;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .05); transition: transform .07s, box-shadow .12s, filter .12s; }
.ip-cmd .ip-cmd-ico { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; }
.ip-cmd .ip-ico { border-radius: ${u(11)}; }
.ip-cmd-key { position: absolute; top: ${u(3)}; right: ${u(3)}; min-width: ${u(15)}; height: ${u(15)}; padding: 0 ${u(3)}; border-radius: ${u(4)}; display: flex; align-items: center; justify-content: center;
  font: 800 ${u(9.5)}/1 var(--ip-font); color: #eafffb; background: rgba(0, 0, 0, .62); box-shadow: inset 0 0 0 1px rgba(var(--ip-accent-rgb), .45); pointer-events: none; }
.ip-cmd-cd { position: absolute; inset: 0; border-radius: inherit; pointer-events: none; display: none; background: conic-gradient(rgba(2, 8, 12, .78) var(--cd, 0%), transparent 0); }
.ip-cmd-cdtxt { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; font-size: ${u(15)}; font-weight: 800; color: #fff; text-shadow: 0 1px 3px #000; pointer-events: none; font-variant-numeric: tabular-nums; }
.ip-cmd.is-cd .ip-cmd-cd { display: block; } .ip-cmd.is-cd .ip-cmd-cdtxt { display: flex; }
.ip-cmd:hover:not(.is-empty), .ip-cmd:focus-visible:not(.is-empty) { box-shadow: 0 0 0 1.5px var(--ip-accent), 0 0 ${u(14)} rgba(var(--ip-accent-rgb), .45); transform: translateY(-1px); }
.ip-cmd:active:not(.is-empty), .ip-cmd.is-pressed { transform: translateY(1px) scale(.97); }
.ip-cmd.is-pressed { box-shadow: 0 0 0 2px #fff, 0 0 ${u(16)} rgba(var(--ip-accent-rgb), .8); }
.ip-cmd.is-disabled .ip-cmd-ico { filter: grayscale(.9) brightness(.5) contrast(.9); }
.ip-cmd.is-disabled .ip-cmd-key { opacity: .45; }
.ip-cmd.is-active { box-shadow: 0 0 0 2px var(--ip-accent), 0 0 ${u(16)} rgba(var(--ip-accent-rgb), .6); }
.ip-cmd.is-active::after { content: ""; position: absolute; inset: ${u(-4)}; border-radius: ${u(14)}; border: 1px solid rgba(var(--ip-accent-rgb), .6); animation: ip-cmd-ring 1.2s ease-out infinite; pointer-events: none; }
@keyframes ip-cmd-ring { from { opacity: 1; transform: scale(.96); } to { opacity: 0; transform: scale(1.08); } }
.ip-cmd.is-empty { cursor: default; background: rgba(255, 255, 255, .02); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .035); }
.ip-cmd.is-empty .ip-cmd-key, .ip-cmd.is-empty .ip-cmd-ico { display: none; }

/* dialogue (comm link) */
.ip-dlg-box { left: 50%; bottom: ${u(192)}; width: ${u(620)}; min-height: ${u(104)}; transform: translateX(-50%); padding: ${u(12)} ${u(16)} ${u(12)} ${u(12)}; display: flex; gap: ${u(14)}; cursor: pointer;
  transition: opacity .22s, transform .22s; border-color: var(--ip-line-2); }
.ip-dlg-box.is-hidden { opacity: 0; transform: translate(-50%, ${u(10)}); pointer-events: none; }
.ip-dlg-portrait { position: relative; flex: none; width: ${u(80)}; height: ${u(80)}; border-radius: ${u(12)}; overflow: hidden; box-shadow: 0 0 0 1.5px var(--pa, var(--ip-accent)), 0 0 ${u(18)} color-mix(in srgb, var(--pa, var(--ip-accent)) 40%, transparent); }
.ip-dlg-portrait::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: repeating-linear-gradient(0deg, rgba(0, 0, 0, .14) 0 1px, transparent 1px 3px), linear-gradient(180deg, rgba(255, 255, 255, .08), transparent 40%); }
.ip-dlg-portrait.is-talking { animation: ip-talk 0.9s ease-in-out infinite; }
@keyframes ip-talk { 50% { box-shadow: 0 0 0 1.5px var(--pa, var(--ip-accent)), 0 0 ${u(26)} color-mix(in srgb, var(--pa, var(--ip-accent)) 65%, transparent); } }
.ip-dlg-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ip-dlg-head { display: flex; align-items: center; gap: ${u(8)}; margin-bottom: ${u(5)}; }
.ip-dlg-name { font-size: ${u(13)}; font-weight: 800; color: var(--pa, var(--ip-accent-2)); letter-spacing: .02em; }
.ip-dlg-role { font-size: ${u(10.5)}; color: var(--ip-faint); font-weight: 600; }
.ip-dlg-live { margin-left: auto; display: flex; align-items: center; gap: ${u(5)}; font-size: ${u(8.5)}; font-weight: 800; letter-spacing: .18em; color: var(--ip-faint); }
.ip-dlg-live::before { content: ""; width: ${u(6)}; height: ${u(6)}; border-radius: 50%; background: var(--ip-alert); box-shadow: 0 0 ${u(6)} var(--ip-alert); animation: ip-breathe 1.2s ease-in-out infinite; }
.ip-dlg-text { font-size: ${u(14)}; line-height: 1.45; color: var(--ip-text); min-height: ${u(40)}; }
.ip-dlg-text .ip-caret { display: inline-block; width: ${u(7)}; height: ${u(13)}; margin-left: 1px; vertical-align: -1px; background: var(--pa, var(--ip-accent)); animation: ip-caret .8s steps(1) infinite; }
@keyframes ip-caret { 50% { opacity: 0; } }
.ip-dlg-foot { margin-top: auto; display: flex; align-items: center; gap: ${u(8)}; font-size: ${u(9.5)}; color: var(--ip-faint); letter-spacing: .08em; }
.ip-dlg-prog { flex: 1; height: 2px; background: rgba(255, 255, 255, .08); border-radius: 1px; overflow: hidden; }
.ip-dlg-prog i { display: block; height: 100%; width: 100%; transform-origin: left; background: var(--pa, var(--ip-accent)); opacity: .7; }
.ip-dlg-box.is-omega { --pa: #d36bff; border-color: rgba(211, 107, 255, .45); background: linear-gradient(180deg, rgba(40, 8, 48, .85), rgba(12, 3, 16, .9)); }
.ip-dlg-box.is-omega .ip-dlg-text { font-family: var(--ip-mono); font-size: ${u(13.5)}; color: #f3d4ff; text-shadow: ${u(1.5)} 0 rgba(255, 60, 200, .55), ${u(-1.5)} 0 rgba(168, 255, 79, .45); animation: ip-glitch 2.2s steps(1) infinite; }
@keyframes ip-glitch { 0%, 100% { transform: none; } 7% { transform: translateX(${u(2)}) skewX(-6deg); } 8% { transform: translateX(${u(-2)}); } 9% { transform: none; } 51% { transform: translateX(${u(-1.5)}) skewX(4deg); } 52% { transform: none; } }

/* modal overlays */
.ip-modal { position: absolute; inset: 0; z-index: 40; pointer-events: auto; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, rgba(2, 10, 14, .45), rgba(1, 4, 6, .78)); backdrop-filter: blur(3px) saturate(.8); -webkit-backdrop-filter: blur(3px) saturate(.8); animation: ip-fade .2s ease-out; }
.ip-lowfx .ip-modal, .ip-softgpu .ip-modal { backdrop-filter: none; -webkit-backdrop-filter: none; background: rgba(1, 5, 8, .8); }
@keyframes ip-fade { from { opacity: 0; } to { opacity: 1; } }
.ip-modal .ip-panel { position: relative; }
.ip-pause-card { width: ${u(340)}; padding: ${u(26)} ${u(28)} ${u(24)}; display: flex; flex-direction: column; gap: ${u(9)}; animation: ip-pop .22s ease-out; }
@keyframes ip-pop { from { opacity: 0; transform: translateY(${u(10)}) scale(.98); } to { opacity: 1; transform: none; } }
.ip-pause-title { font-size: ${u(26)}; font-weight: 850; letter-spacing: .22em; text-align: center; color: var(--ip-text); }
.ip-pause-sub { font-size: ${u(11)}; text-align: center; color: var(--ip-dim); letter-spacing: .12em; text-transform: uppercase; margin-top: ${u(-4)}; }
.ip-flatline { height: ${u(30)}; margin: ${u(4)} 0 ${u(10)}; background: rgba(var(--ip-accent-rgb), .8); -webkit-mask: ${ECG_LINE} center / 100% 100% no-repeat; mask: ${ECG_LINE} center / 100% 100% no-repeat; animation: ip-breathe 2s ease-in-out infinite; }
.ip-pause-card .ip-btn { width: 100%; height: ${u(42)}; justify-content: flex-start; padding: 0 ${u(16)}; font-size: ${u(14)}; }
.ip-pause-card .ip-btn .ip-key { margin-left: auto; }
.ip-confirm { display: flex; flex-direction: column; gap: ${u(8)}; padding: ${u(12)}; border-radius: ${u(10)}; background: rgba(255, 90, 107, .08); border: 1px solid rgba(255, 90, 107, .3); }
.ip-confirm-txt { font-size: ${u(12.5)}; color: #ffd1d6; text-align: center; }
.ip-confirm-row { display: flex; gap: ${u(8)}; } .ip-confirm-row .ip-btn { flex: 1; justify-content: center !important; }

.ip-set-card { width: ${u(560)}; max-height: 86vh; padding: ${u(22)} ${u(26)} ${u(20)}; display: flex; flex-direction: column; gap: ${u(12)}; animation: ip-pop .22s ease-out; }
.ip-card-head { display: flex; align-items: center; gap: ${u(10)}; }
.ip-card-head h2 { margin: 0; font-size: ${u(19)}; font-weight: 820; letter-spacing: .12em; text-transform: uppercase; }
.ip-card-head .ip-glyph { font-size: ${u(20)}; color: var(--ip-accent); }
.ip-card-head .ip-btn { margin-left: auto; height: ${u(32)}; }

/* settings panel (shared HUD/menu) */
.ip-settings { display: flex; flex-direction: column; gap: ${u(14)}; overflow: auto; padding-right: ${u(4)}; }
.ip-set-group { display: flex; flex-direction: column; gap: ${u(6)}; }
.ip-set-title { display: flex; align-items: center; gap: ${u(10)}; font-size: ${u(9.5)}; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; color: var(--ip-accent-2); margin-bottom: ${u(2)}; }
.ip-set-title::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, var(--ip-line-2), transparent); }
.ip-set-row { display: grid; grid-template-columns: ${u(150)} 1fr ${u(52)}; align-items: center; gap: ${u(12)}; min-height: ${u(34)}; padding: 0 ${u(10)}; border-radius: ${u(8)}; background: rgba(255, 255, 255, .025); }
.ip-set-row:hover { background: rgba(255, 255, 255, .05); }
.ip-set-label { font-size: ${u(13)}; color: var(--ip-text); }
.ip-set-hint { font-size: ${u(10.5)}; color: var(--ip-faint); }
.ip-set-val { font-size: ${u(12)}; font-weight: 700; text-align: right; color: var(--ip-accent-2); font-variant-numeric: tabular-nums; }
.ip-range { -webkit-appearance: none; appearance: none; width: 100%; height: ${u(6)}; border-radius: ${u(3)}; outline: none; cursor: pointer; pointer-events: auto;
  background: linear-gradient(90deg, var(--ip-accent) var(--p, 50%), rgba(255, 255, 255, .12) var(--p, 50%)); }
.ip-range::-webkit-slider-thumb { -webkit-appearance: none; width: ${u(16)}; height: ${u(16)}; border-radius: 50%; background: #eafffb; border: ${u(3)} solid var(--ip-accent); box-shadow: 0 0 ${u(8)} rgba(var(--ip-accent-rgb), .6); }
.ip-range::-moz-range-thumb { width: ${u(12)}; height: ${u(12)}; border-radius: 50%; background: #eafffb; border: ${u(3)} solid var(--ip-accent); }
.ip-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 ${u(4)} rgba(var(--ip-accent-rgb), .35); }
.ip-switch { justify-self: start; position: relative; width: ${u(42)}; height: ${u(22)}; border-radius: ${u(11)}; border: 1px solid var(--ip-line-2); background: rgba(0, 0, 0, .35); cursor: pointer; padding: 0; pointer-events: auto; transition: background .15s; }
.ip-switch::after { content: ""; position: absolute; top: ${u(2)}; left: ${u(2)}; width: ${u(16)}; height: ${u(16)}; border-radius: 50%; background: var(--ip-dim); transition: transform .15s, background .15s; }
.ip-switch[aria-checked="true"] { background: rgba(var(--ip-accent-rgb), .3); border-color: var(--ip-accent); }
.ip-switch[aria-checked="true"]::after { transform: translateX(${u(20)}); background: var(--ip-accent); box-shadow: 0 0 ${u(8)} rgba(var(--ip-accent-rgb), .7); }
.ip-switch:focus-visible { outline: 2px solid rgba(var(--ip-accent-rgb), .6); outline-offset: 2px; }
.ip-seg { display: inline-flex; justify-self: start; padding: ${u(2)}; border-radius: ${u(9)}; background: rgba(0, 0, 0, .35); border: 1px solid var(--ip-line); gap: ${u(2)}; }
.ip-seg button { height: ${u(26)}; padding: 0 ${u(12)}; border: 0; border-radius: ${u(7)}; background: transparent; cursor: pointer; font-size: ${u(12)}; font-weight: 650; color: var(--ip-dim); pointer-events: auto; }
.ip-seg button:hover { color: var(--ip-text); background: rgba(255, 255, 255, .05); }
.ip-seg button[aria-pressed="true"] { color: #03181a; background: var(--ip-accent); box-shadow: 0 0 ${u(10)} rgba(var(--ip-accent-rgb), .45); }
.ip-seg button:focus-visible { outline: 2px solid rgba(var(--ip-accent-rgb), .6); }
.ip-set-foot { display: flex; align-items: center; gap: ${u(10)}; margin-top: ${u(2)}; }
.ip-set-foot .ip-set-hint { flex: 1; }

/* save / load */
.ip-save-card { width: ${u(800)}; }
.ip-saveload { position: relative; display: flex; flex-direction: column; gap: ${u(10)}; min-height: ${u(200)}; overflow: auto; }
.ip-saveload.is-busy { cursor: progress; }
.ip-saveload.is-busy .ip-slot { pointer-events: none; opacity: .6; }
.ip-save-name { display: flex; align-items: center; gap: ${u(12)}; }
.ip-input { flex: 1; height: ${u(34)}; padding: 0 ${u(12)}; border-radius: ${u(8)}; border: 1px solid var(--ip-line-2); background: rgba(0, 0, 0, .35); color: var(--ip-text);
  font: 600 ${u(13)} var(--ip-font); outline: none; pointer-events: auto; user-select: text; -webkit-user-select: text; }
.ip-input:focus { border-color: var(--ip-accent); box-shadow: 0 0 0 ${u(3)} rgba(var(--ip-accent-rgb), .2); }
.ip-input:disabled { opacity: .45; }
.ip-load-bar { display: flex; align-items: center; gap: ${u(12)}; }
.ip-load-bar .ip-set-hint { flex: 1; }
.ip-slots { display: grid; grid-template-columns: 1fr 1fr; gap: ${u(8)}; }
.ip-slots-empty { grid-column: 1 / -1; padding: ${u(30)} 0; text-align: center; color: var(--ip-faint); font-size: ${u(13)}; }
.ip-slot { position: relative; display: flex; gap: ${u(12)}; align-items: center; padding: ${u(8)}; border-radius: ${u(12)}; cursor: pointer; outline: none;
  background: rgba(255, 255, 255, .03); border: 1px solid rgba(255, 255, 255, .07); transition: border-color .12s, background .12s; min-width: 0; }
.ip-slot:hover, .ip-slot:focus-visible { border-color: var(--ip-accent); background: rgba(var(--ip-accent-rgb), .08); }
.ip-slot.is-empty { border-style: dashed; }
.ip-slot.is-disabled { pointer-events: none; opacity: .5; }
.ip-slot-thumb { flex: none; width: ${u(112)}; height: ${u(63)}; border-radius: ${u(8)}; overflow: hidden; background: #061015; border: 1px solid rgba(255, 255, 255, .08);
  display: flex; align-items: center; justify-content: center; color: var(--ip-faint); font-size: ${u(22)}; }
.ip-slot-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ip-slot-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: ${u(1)}; }
.ip-slot-label { font-size: ${u(8.5)}; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--ip-accent); }
.ip-slot-name { font-size: ${u(13.5)}; font-weight: 720; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-slot-name.is-dim { color: var(--ip-faint); font-weight: 600; }
.ip-slot-sub, .ip-slot-time { font-size: ${u(11)}; color: var(--ip-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-slot-time { color: var(--ip-faint); font-variant-numeric: tabular-nums; }
.ip-slot-actions { display: flex; flex-direction: column; gap: ${u(4)}; }
.ip-icon-btn { width: ${u(26)}; height: ${u(26)}; border-radius: ${u(7)}; display: flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; pointer-events: auto;
  background: rgba(0, 0, 0, .3); border: 1px solid var(--ip-line); color: var(--ip-dim); font-size: ${u(13)}; }
.ip-icon-btn:hover { color: var(--ip-accent-2); border-color: var(--ip-accent); }
.ip-icon-btn.is-danger:hover { color: var(--ip-alert); border-color: var(--ip-alert); }
.ip-err { display: flex; align-items: center; gap: ${u(8)}; padding: ${u(8)} ${u(12)}; border-radius: ${u(8)}; font-size: ${u(12.5)}; color: #ffd1d6; background: rgba(255, 90, 107, .1); border: 1px solid rgba(255, 90, 107, .35); }
.ip-err .ip-glyph { color: var(--ip-alert); font-size: ${u(15)}; }
.ip-confirm-ov { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; border-radius: inherit; background: rgba(2, 8, 12, .72); }
.ip-confirm-box { width: min(92%, ${u(400)}); padding: ${u(16)} ${u(18)}; border-radius: ${u(12)}; background: linear-gradient(180deg, rgba(18, 38, 46, .98), rgba(7, 16, 22, .98)); border: 1px solid var(--ip-line-2); box-shadow: 0 ${u(12)} ${u(30)} rgba(0, 0, 0, .5); display: flex; flex-direction: column; gap: ${u(8)}; }
.ip-confirm-title { font-size: ${u(15)}; font-weight: 800; letter-spacing: .04em; }
.ip-confirm-box .ip-confirm-txt { color: var(--ip-dim); text-align: left; }
.ip-confirm-box .ip-confirm-row { margin-top: ${u(6)}; justify-content: flex-end; }
.ip-confirm-box .ip-confirm-row .ip-btn { flex: 0 0 auto; min-width: ${u(110)}; }
.ip-confirm-card { width: ${u(440)}; min-height: ${u(170)}; }
.ip-saving { position: absolute; top: ${u(62)}; right: ${u(120)}; display: flex; align-items: center; gap: ${u(7)}; padding: ${u(4)} ${u(10)}; border-radius: ${u(999)};
  font-size: ${u(11)}; font-weight: 700; letter-spacing: .08em; color: var(--ip-accent-2); background: rgba(6, 16, 22, .85); border: 1px solid var(--ip-line-2); pointer-events: none; }
.ip-saving::before { content: ""; width: ${u(10)}; height: ${u(10)}; border-radius: 50%; border: 2px solid rgba(var(--ip-accent-rgb), .3); border-top-color: var(--ip-accent); animation: ip-spin .8s linear infinite; }
@keyframes ip-spin { to { transform: rotate(360deg); } }
.ip-menu-toast { position: absolute; left: 50%; bottom: ${u(28)}; transform: translateX(-50%); z-index: 30; }
.ip-nav-btn.is-continue { border-color: rgba(var(--ip-accent-rgb), .45); background: linear-gradient(90deg, rgba(var(--ip-accent-rgb), .22), rgba(var(--ip-accent-rgb), .04)); }

/* end screen */
.ip-end { background: radial-gradient(ellipse at center, rgba(2, 18, 20, .55), rgba(0, 3, 5, .9)); }
.ip-end.is-defeat { background: radial-gradient(ellipse at center, rgba(30, 4, 8, .55), rgba(5, 0, 1, .92)); }
.ip-end-card { width: ${u(700)}; padding: ${u(26)} ${u(34)} ${u(26)}; display: flex; flex-direction: column; align-items: center; animation: ip-pop .5s ease-out; }
.ip-end.is-defeat .ip-end-card { --ip-accent: #ff5a6b; --ip-accent-rgb: 255, 90, 107; --ip-accent-2: #ffc1c8; --ip-line: rgba(255, 90, 107, .2); --ip-line-2: rgba(255, 90, 107, .4); }
.ip-end-ecg { width: 100%; height: ${u(54)}; margin-bottom: ${u(4)}; }
.ip-end-ecg path { fill: none; stroke: var(--ip-accent); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 0 4px rgba(var(--ip-accent-rgb), .8)); stroke-dasharray: 900; stroke-dashoffset: 900; animation: ip-end-draw 2.4s ease-out forwards; }
@keyframes ip-end-draw { to { stroke-dashoffset: 0; } }
.ip-end-kicker { font-size: ${u(10.5)}; font-weight: 800; letter-spacing: .32em; text-transform: uppercase; color: var(--ip-accent-2); opacity: .9; }
.ip-end-title { margin: ${u(6)} 0 ${u(4)}; font-size: ${u(40)}; font-weight: 900; letter-spacing: .1em; text-align: center; line-height: 1.05;
  background: linear-gradient(180deg, #ffffff 10%, var(--ip-accent) 95%); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 0 ${u(16)} rgba(var(--ip-accent-rgb), .35)); }
.ip-end-sub { font-size: ${u(14)}; color: var(--ip-dim); text-align: center; }
.ip-end-time { margin-top: ${u(8)}; font-size: ${u(11)}; letter-spacing: .14em; text-transform: uppercase; color: var(--ip-faint); font-variant-numeric: tabular-nums; }
.ip-end-stats { width: 100%; margin: ${u(16)} 0 ${u(20)}; border-collapse: separate; border-spacing: 0 ${u(3)}; font-size: ${u(13)}; }
.ip-end-stats th { font-size: ${u(9)}; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--ip-faint); padding: 0 ${u(12)} ${u(4)}; text-align: right; }
.ip-end-stats th:first-child { text-align: left; }
.ip-end-stats td { padding: ${u(7)} ${u(12)}; background: rgba(255, 255, 255, .035); text-align: right; font-weight: 720; font-variant-numeric: tabular-nums; }
.ip-end-stats td:first-child { text-align: left; font-weight: 500; color: var(--ip-dim); border-radius: ${u(7)} 0 0 ${u(7)}; }
.ip-end-stats td:last-child { border-radius: 0 ${u(7)} ${u(7)} 0; color: #e8a8f7; }
.ip-end-stats td.is-you { color: var(--ip-accent-2); }
.ip-end-stats td.is-best { position: relative; }
.ip-end-stats td.is-best::before { content: "▲"; font-size: ${u(8)}; margin-right: ${u(6)}; color: var(--ip-ok); vertical-align: 1px; }
.ip-end-btns { display: flex; gap: ${u(10)}; }
.ip-end-btns .ip-btn { min-width: ${u(150)}; height: ${u(44)}; font-size: ${u(14)}; white-space: nowrap; }
/* software rasterisers: entrance animations crawl and screenshots catch them half-faded → show final state */
.ip-softgpu .ip-modal, .ip-softgpu .ip-end-card, .ip-softgpu .ip-pause-card, .ip-softgpu .ip-set-card, .ip-softgpu .ip-page, .ip-softgpu .ip-toast, .ip-softgpu .ip-alert { animation: none; }
.ip-softgpu .ip-end-ecg path { animation: none; stroke-dashoffset: 0; }

/* ───────────── main menu ───────────── */
.ip-menu { position: absolute; inset: 0; pointer-events: auto; overflow: hidden; background: #03070c; }
.ip-menu-bg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.ip-menu-vignette { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse 80% 75% at 62% 45%, transparent 40%, rgba(1, 3, 6, .72) 100%), linear-gradient(90deg, rgba(2, 6, 10, .78) 0%, rgba(2, 6, 10, .35) 34%, transparent 55%), ${NOISE}; }
.ip-menu-shell { position: absolute; inset: 0; display: grid; grid-template-columns: ${u(440)} 1fr; padding: ${u(56)} ${u(64)} ${u(40)}; gap: ${u(40)}; }
.ip-menu-left { display: flex; flex-direction: column; min-height: 0; }
.ip-logo { position: relative; margin-bottom: ${u(40)}; }
.ip-logo-mark { display: flex; align-items: center; gap: ${u(14)}; margin-bottom: ${u(14)}; }
.ip-logo-badge { width: ${u(44)}; height: ${u(44)}; border-radius: ${u(12)}; background: linear-gradient(160deg, #3ff0dc, #12948a); display: flex; align-items: center; justify-content: center; box-shadow: 0 0 ${u(24)} rgba(53, 226, 208, .45), inset 0 1px 0 rgba(255, 255, 255, .5); }
.ip-logo-badge svg { width: 62%; height: 62%; }
.ip-logo-org { font-size: ${u(10.5)}; font-weight: 800; letter-spacing: .3em; text-transform: uppercase; color: var(--ip-accent-2); line-height: 1.5; }
.ip-logo-org span { display: block; color: var(--ip-faint); letter-spacing: .22em; font-size: ${u(9.5)}; }
.ip-logo-title { margin: 0; font-size: ${u(58)}; line-height: .92; font-weight: 900; letter-spacing: .02em; color: #effffd; text-transform: uppercase;
  text-shadow: 0 0 ${u(30)} rgba(53, 226, 208, .25); }
.ip-logo-title .ip-logo-p { display: block; background: linear-gradient(90deg, #35e2d0, #a6fff3 60%, #35e2d0); -webkit-background-clip: text; background-clip: text; color: transparent; letter-spacing: .07em; }
.ip-logo-ecg { display: block; width: 100%; height: ${u(34)}; margin: ${u(10)} 0 ${u(8)}; overflow: visible; }
.ip-logo-ecg path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.ip-logo-ecg .ip-ecg-glow { stroke: rgba(53, 226, 208, .35); stroke-width: 6; filter: blur(3px); }
.ip-logo-ecg .ip-ecg-main { stroke: #7ff5e6; stroke-width: 2; stroke-dasharray: 520; animation: ip-logo-ecg 3.2s ease-in-out infinite; }
@keyframes ip-logo-ecg { 0% { stroke-dashoffset: 520; } 45%, 70% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -520; } }
.ip-logo-sub { font-size: ${u(15)}; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: #cfe9e6; }
.ip-logo-sub b { color: #ff7ae0; font-weight: 800; }
.ip-nav { display: flex; flex-direction: column; gap: ${u(6)}; }
.ip-nav-btn { position: relative; display: flex; align-items: center; gap: ${u(14)}; width: ${u(360)}; height: ${u(58)}; padding: 0 ${u(18)}; border-radius: ${u(12)}; cursor: pointer; text-align: left;
  background: linear-gradient(90deg, rgba(10, 26, 32, .7), rgba(10, 26, 32, .15)); border: 1px solid rgba(130, 240, 226, .1); color: var(--ip-text); transition: background .15s, border-color .15s, transform .15s; overflow: hidden; }
.ip-nav-btn .ip-glyph { font-size: ${u(20)}; color: var(--ip-accent); flex: none; }
.ip-nav-txt { display: flex; flex-direction: column; }
.ip-nav-label { font-size: ${u(17)}; font-weight: 760; letter-spacing: .06em; }
.ip-nav-desc { font-size: ${u(11)}; color: var(--ip-faint); margin-top: ${u(1)}; }
.ip-nav-btn::after { content: ""; position: absolute; left: ${u(52)}; right: ${u(14)}; bottom: ${u(7)}; height: ${u(10)}; opacity: 0; background: var(--ip-accent); -webkit-mask: ${ECG_LINE} center / 100% 100% no-repeat; mask: ${ECG_LINE} center / 100% 100% no-repeat; transition: opacity .2s; }
.ip-nav-btn:hover, .ip-nav-btn:focus-visible, .ip-nav-btn.is-current { outline: none; border-color: rgba(var(--ip-accent-rgb), .55); background: linear-gradient(90deg, rgba(var(--ip-accent-rgb), .2), rgba(var(--ip-accent-rgb), .03)); transform: translateX(${u(4)}); }
.ip-nav-btn:hover::after, .ip-nav-btn:focus-visible::after, .ip-nav-btn.is-current::after { opacity: .35; }
.ip-nav-btn.is-current .ip-nav-label { color: var(--ip-accent-2); }
.ip-menu-foot { margin-top: auto; font-size: ${u(10.5)}; color: var(--ip-faint); line-height: 1.6; max-width: ${u(400)}; }
.ip-menu-foot b { color: var(--ip-dim); font-weight: 700; }
.ip-menu-right { position: relative; min-height: 0; display: flex; align-items: center; justify-content: center; }
.ip-page { position: relative; width: min(100%, ${u(980)}); max-height: 100%; display: flex; flex-direction: column; padding: ${u(26)} ${u(30)} ${u(24)}; animation: ip-page-in .28s ease-out; }
@keyframes ip-page-in { from { opacity: 0; transform: translateX(${u(16)}); } to { opacity: 1; transform: none; } }
.ip-page-head { display: flex; align-items: flex-end; gap: ${u(14)}; margin-bottom: ${u(18)}; }
.ip-page-kicker { font-size: ${u(10)}; font-weight: 800; letter-spacing: .26em; text-transform: uppercase; color: var(--ip-accent); }
.ip-page-title { margin: ${u(3)} 0 0; font-size: ${u(28)}; font-weight: 850; letter-spacing: .04em; }
.ip-page-head .ip-btn { margin-left: auto; }
.ip-page-body { min-height: 0; overflow: auto; }

.ip-camp { display: grid; grid-template-columns: ${u(300)} 1fr; gap: ${u(20)}; min-height: ${u(420)}; }
.ip-mlist { display: flex; flex-direction: column; gap: ${u(8)}; }
.ip-mission { position: relative; display: flex; align-items: center; gap: ${u(12)}; padding: ${u(12)} ${u(14)}; border-radius: ${u(12)}; cursor: pointer; text-align: left;
  background: rgba(255, 255, 255, .03); border: 1px solid rgba(255, 255, 255, .06); color: var(--ip-text); transition: border-color .15s, background .15s; }
.ip-mission:hover, .ip-mission:focus-visible { outline: none; border-color: var(--ip-line-2); background: rgba(var(--ip-accent-rgb), .07); }
.ip-mission.is-sel { border-color: var(--ip-accent); background: rgba(var(--ip-accent-rgb), .13); box-shadow: inset ${u(3)} 0 0 var(--ip-accent); }
.ip-mission-num { flex: none; width: ${u(38)}; height: ${u(38)}; border-radius: ${u(10)}; display: flex; align-items: center; justify-content: center; font-size: ${u(15)}; font-weight: 850; font-variant-numeric: tabular-nums;
  background: rgba(var(--ip-accent-rgb), .14); color: var(--ip-accent-2); border: 1px solid var(--ip-line-2); }
.ip-mission-txt { display: flex; flex-direction: column; min-width: 0; }
.ip-mission-sub { font-size: ${u(9.5)}; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--ip-faint); }
.ip-mission-title { font-size: ${u(15)}; font-weight: 750; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-mission-state { margin-left: auto; flex: none; font-size: ${u(16)}; color: var(--ip-faint); }
.ip-mission.is-done .ip-mission-state { color: var(--ip-ok); }
.ip-mission.is-locked { opacity: .5; cursor: not-allowed; }
.ip-mission.is-locked .ip-mission-num { background: rgba(255, 255, 255, .04); color: var(--ip-faint); border-color: rgba(255, 255, 255, .08); }
.ip-mission.is-shake { animation: ip-shake .35s; }
@keyframes ip-shake { 20%, 60% { transform: translateX(${u(-5)}); } 40%, 80% { transform: translateX(${u(5)}); } }
.ip-brief { display: flex; flex-direction: column; padding: ${u(18)} ${u(20)}; border-radius: ${u(14)}; background: rgba(0, 0, 0, .25); border: 1px solid var(--ip-line); min-height: 0; }
.ip-brief-kicker { font-size: ${u(10)}; font-weight: 800; letter-spacing: .22em; text-transform: uppercase; color: var(--ip-accent); }
.ip-brief-title { margin: ${u(4)} 0 ${u(12)}; font-size: ${u(24)}; font-weight: 850; }
.ip-brief p { margin: 0 0 ${u(10)}; font-size: ${u(13.5)}; line-height: 1.6; color: #c6dedb; }
.ip-brief-obj { margin: ${u(6)} 0 ${u(16)}; padding: ${u(10)} ${u(12)}; border-radius: ${u(10)}; background: rgba(var(--ip-accent-rgb), .06); border: 1px solid var(--ip-line); }
.ip-brief-obj ul { margin: ${u(6)} 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: ${u(5)}; }
.ip-brief-obj li { display: flex; gap: ${u(8)}; align-items: flex-start; font-size: ${u(13)}; }
.ip-brief-obj li .ip-glyph { color: var(--ip-accent); margin-top: ${u(2)}; }
.ip-brief-lock { display: flex; align-items: center; gap: ${u(8)}; color: var(--ip-warn); font-size: ${u(13)}; margin: ${u(4)} 0 ${u(14)}; }
.ip-brief-foot { margin-top: auto; display: flex; align-items: center; gap: ${u(14)}; flex-wrap: wrap; }
.ip-brief-foot .ip-btn-primary { margin-left: auto; height: ${u(46)}; padding: 0 ${u(26)}; font-size: ${u(15)}; }
.ip-field { display: flex; flex-direction: column; gap: ${u(6)}; }

.ip-skirm { display: grid; grid-template-columns: ${u(300)} 1fr; gap: ${u(20)}; min-height: ${u(420)}; }
.ip-map-card { display: flex; align-items: center; gap: ${u(12)}; padding: ${u(10)}; }
.ip-map-thumb { flex: none; width: ${u(54)}; height: ${u(54)}; border-radius: ${u(8)}; background: #061015; border: 1px solid rgba(255, 255, 255, .1); overflow: hidden; }
.ip-map-thumb canvas, .ip-map-preview canvas { width: 100%; height: 100%; display: block; image-rendering: auto; }
.ip-map-preview { position: relative; width: 100%; max-width: ${u(300)}; aspect-ratio: 1; border-radius: ${u(12)}; overflow: hidden; background: #061015; border: 1px solid var(--ip-line-2); margin-bottom: ${u(14)}; box-shadow: 0 0 ${u(24)} rgba(var(--ip-accent-rgb), .12); }
.ip-map-meta { display: flex; gap: ${u(18)}; margin-bottom: ${u(14)}; font-size: ${u(12)}; color: var(--ip-dim); }
.ip-map-meta b { display: block; font-size: ${u(9)}; letter-spacing: .16em; text-transform: uppercase; color: var(--ip-faint); margin-bottom: ${u(2)}; }
.ip-vs { display: flex; align-items: center; gap: ${u(10)}; font-size: ${u(13)}; margin-bottom: ${u(14)}; }
.ip-vs-side { display: flex; align-items: center; gap: ${u(8)}; padding: ${u(7)} ${u(12)}; border-radius: ${u(9)}; background: rgba(255, 255, 255, .03); border: 1px solid rgba(255, 255, 255, .06); }
.ip-vs-side i { width: ${u(10)}; height: ${u(10)}; border-radius: 50%; background: var(--c); box-shadow: 0 0 ${u(8)} var(--c); }
.ip-vs b { color: var(--ip-faint); font-size: ${u(11)}; letter-spacing: .2em; }

.ip-howto { display: grid; grid-template-columns: 1.1fr 1fr; gap: ${u(22)}; }
.ip-howto h3 { margin: 0 0 ${u(10)}; font-size: ${u(10)}; font-weight: 800; letter-spacing: .22em; text-transform: uppercase; color: var(--ip-accent-2); display: flex; align-items: center; gap: ${u(10)}; }
.ip-howto h3::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, var(--ip-line-2), transparent); }
.ip-keys { width: 100%; border-collapse: collapse; font-size: ${u(12.5)}; margin-bottom: ${u(16)}; }
.ip-keys td { padding: ${u(5)} 0; border-bottom: 1px solid rgba(255, 255, 255, .05); vertical-align: top; }
.ip-keys td:first-child { width: 46%; padding-right: ${u(10)}; }
.ip-keys td:last-child { color: #c6dedb; }
.ip-keys .ip-key { margin: 0 ${u(2)} ${u(2)} 0; }
.ip-tips { display: flex; flex-direction: column; gap: ${u(10)}; }
.ip-tip-card { display: flex; gap: ${u(12)}; padding: ${u(10)} ${u(12)}; border-radius: ${u(12)}; background: rgba(255, 255, 255, .03); border: 1px solid rgba(255, 255, 255, .05); }
.ip-tip-card .ip-tip-ico { flex: none; width: ${u(40)}; height: ${u(40)}; }
.ip-tip-card b { display: block; font-size: ${u(13)}; margin-bottom: ${u(2)}; }
.ip-tip-card span { font-size: ${u(12)}; color: var(--ip-dim); line-height: 1.5; }

.ip-credits { display: grid; grid-template-columns: repeat(3, 1fr); gap: ${u(10)}; }
.ip-credit { padding: ${u(12)} ${u(14)}; border-radius: ${u(12)}; background: rgba(255, 255, 255, .03); border: 1px solid rgba(255, 255, 255, .05); display: flex; gap: ${u(11)}; align-items: flex-start; }
.ip-credit-n { flex: none; width: ${u(28)}; height: ${u(28)}; border-radius: ${u(8)}; display: flex; align-items: center; justify-content: center; font-size: ${u(11)}; font-weight: 850; color: var(--ip-accent-2); background: rgba(var(--ip-accent-rgb), .12); border: 1px solid var(--ip-line-2); font-variant-numeric: tabular-nums; }
.ip-credit b { display: block; font-size: ${u(13)}; margin-bottom: ${u(2)}; }
.ip-credit span { font-size: ${u(11.5)}; color: var(--ip-dim); line-height: 1.45; }
.ip-credits-foot { margin-top: ${u(16)}; font-size: ${u(12)}; color: var(--ip-faint); text-align: center; line-height: 1.6; }
.ip-ticker { right: 0; bottom: 0; display: flex; align-items: center; gap: ${u(12)}; padding: ${u(12)} ${u(18)}; font-size: ${u(12)}; color: var(--ip-dim); white-space: nowrap; }
.ip-ticker b { color: #ff7a8a; letter-spacing: .14em; }
.ip-ticker-dot { width: ${u(8)}; height: ${u(8)}; border-radius: 50%; background: var(--ip-alert); box-shadow: 0 0 ${u(10)} var(--ip-alert); animation: ip-breathe 1.1s ease-in-out infinite; }
.ip-ticker-time { color: var(--ip-faint); font-size: ${u(11)}; padding-left: ${u(12)}; border-left: 1px solid var(--ip-line); }

@media (prefers-reduced-motion: reduce) {
  .ip-root div, .ip-root span, .ip-root button { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
`;

const STYLE_ID = 'ip-ui-style';

/** Inject the UI stylesheet once (idempotent). */
export function ensureUiStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
  installUiScale();
  if (isSoftwareGpu()) document.documentElement.classList.add('ip-softgpu');
}

let softGpu: boolean | null = null;
/**
 * True on software rasterisers (SwiftShader / llvmpipe — headless CI, no GPU). backdrop-filter blur is
 * composited per frame and drops such machines to ~1 fps, so the glass falls back to opaque panels.
 */
export function isSoftwareGpu(): boolean {
  if (softGpu !== null) return softGpu;
  softGpu = false;
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl') ?? c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      softGpu = /swiftshader|llvmpipe|software|softpipe/i.test(name);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { softGpu = false; }
  return softGpu;
}

let scaleInstalled = false;
/** Keep --ip-u (1 design px) proportional to the viewport: 1.0 at 1600×900, clamped 0.8…1.6. */
export function installUiScale(): void {
  if (scaleInstalled || typeof window === 'undefined') return;
  scaleInstalled = true;
  const apply = () => {
    const k = Math.min(window.innerWidth / 1600, window.innerHeight / 900);
    const s = Math.max(0.8, Math.min(1.6, k));
    document.documentElement.style.setProperty('--ip-u', `${s.toFixed(4)}px`);
  };
  apply();
  window.addEventListener('resize', apply);
}

/** Current UI scale factor (CSS px per design unit). */
export function uiScale(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ip-u'));
  return Number.isFinite(v) && v > 0 ? v : 1;
}
