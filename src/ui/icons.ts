/**
 * [ui] OWNER: HUD agent. Procedural inline-SVG icon set for every unit, building, upgrade, ability and
 * command-card key, in one consistent style: a 64×64 rounded "glass tile" tinted by faction
 * (hospital = deep teal + ivory/teal glyphs, pathogen = deep violet + magenta/acid-green glyphs,
 * commands = slate) with a 3.2-unit round-capped line glyph.
 *
 *   iconHtml(key)   → tile icon (command card, selection, queues). Unknown keys → tasteful fallback.
 *   glyphHtml(key)  → small monochrome UI glyph (20×20, uses currentColor) for resources, stats, menus.
 *
 * Gradient/clip ids are made unique per call (§ placeholder) so many icons can live in one document.
 */
import { ABILITY_DEFS, BUILDING_DEFS, UNIT_DEFS, UPGRADE_DEFS, tryGetDef } from '../data';
import type { FactionId } from '../core/types';

interface Pal { t: string; b: string; glow: string; rim: string; f: string; a: string; c: string; d: string }

const PAL: Record<'hospital' | 'pathogen' | 'command' | 'resource', Pal> = {
  hospital: { t: '#13575b', b: '#072327', glow: '#45f0dc', rim: '#7ff7ea', f: '#effcfd', a: '#3fe6d4', c: '#b48cff', d: '#0b3236' },
  pathogen: { t: '#4a1458', b: '#17061d', glow: '#d65bff', rim: '#e690ff', f: '#f6e2ff', a: '#a8ff4f', c: '#ff5fd2', d: '#25092e' },
  command: { t: '#1e3440', b: '#0a151b', glow: '#7fd9ff', rim: '#8fc3cf', f: '#eaf6fb', a: '#46e4d2', c: '#ff6b78', d: '#0e1c23' },
  resource: { t: '#544114', b: '#1f1805', glow: '#ffc94d', rim: '#ffdc8a', f: '#fff4d8', a: '#ffc94d', c: '#ffffff', d: '#2a2008' },
};
/** Fixed semantic colours usable from any palette: {p} power amber, {g} pharmacy green. */
const FIXED: Record<string, string> = { p: '#ffc94d', g: '#38d47a' };

// ───────────────────────── procedural shape helpers ─────────────────────────
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Star polygon points (n tips). */
function star(cx: number, cy: number, ro: number, ri: number, n: number, rot = -Math.PI / 2): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? ro : ri, a = rot + (i * Math.PI) / n;
    pts.push(`${r1(cx + Math.cos(a) * r)},${r1(cy + Math.sin(a) * r)}`);
  }
  return pts.join(' ');
}

/** Spiky virion: body circle + n spikes with knobs. */
function virion(cx: number, cy: number, r: number, spike: number, n: number, knob: number, body: string, spikeCol: string, knobCol: string, phase = 0): string {
  let d = '';
  let knobs = '';
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const x0 = cx + Math.cos(a) * (r + 0.8), y0 = cy + Math.sin(a) * (r + 0.8);
    const x1 = cx + Math.cos(a) * (r + spike), y1 = cy + Math.sin(a) * (r + spike);
    d += `M${r1(x0)} ${r1(y0)} L${r1(x1)} ${r1(y1)} `;
    knobs += `<circle cx="${r1(x1)}" cy="${r1(y1)}" r="${knob}" fill="${knobCol}" stroke="none"/>`;
  }
  return `<path d="${d}" stroke="${spikeCol}" stroke-width="2.2"/>${knobs}`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${body}" fill-opacity=".26" stroke="{f}" stroke-width="2.6"/>`;
}

/** DNA double helix between y0 and y1. */
function helix(cx: number, y0: number, y1: number, amp: number): string {
  const N = 28;
  let a = '', b = '', rungs = '';
  for (let i = 0; i <= N; i++) {
    const t = i / N, y = y0 + (y1 - y0) * t, ph = t * Math.PI * 2.2;
    const xa = cx + Math.sin(ph) * amp, xb = cx - Math.sin(ph) * amp;
    a += `${i ? 'L' : 'M'}${r1(xa)} ${r1(y)} `;
    b += `${i ? 'L' : 'M'}${r1(xb)} ${r1(y)} `;
    if (i % 4 === 2) rungs += `M${r1(xa)} ${r1(y)} L${r1(xb)} ${r1(y)} `;
  }
  return `<path d="${rungs}" stroke="{f}" stroke-width="1.8" stroke-opacity=".55"/><path d="${a}" stroke="{a}" stroke-width="3.2"/><path d="${b}" stroke="{c}" stroke-width="3.2"/>`;
}

/** Upgrade level pips (bottom-left corner). */
const pips = (n: number): string => Array.from({ length: n }, (_, i) => `<rect x="${8 + i * 7}" y="50" width="5" height="5" rx="1.4" fill="{f}" stroke="none"/>`).join('');

// ───────────────────────── tile glyphs (64×64; stroke = {f} by default) ─────────────────────────
const DROPLET_UP = (fill: string, stroke: string, chevron: string) =>
  `<path d="M32 10 C40 21 46 28.5 46 37 A14 14 0 0 1 18 37 C18 28.5 24 21 32 10 Z" fill="${fill}" fill-opacity=".24" stroke="${stroke}"/><path d="M25.5 40.5 L32 34 L38.5 40.5" stroke="${chevron}" stroke-width="3.4"/>`;
const PLATING = `<path d="M32 11 L48 17 V29 C48 40.5 41 47.5 32 51.5 C23 47.5 16 40.5 16 29 V17 Z" fill="{a}" fill-opacity=".14"/><path d="M22.5 25 H41.5 M22.5 32 H41.5 M25 39 H39" stroke="{a}" stroke-width="2.8"/>`;
const HEXSHELL = `<polygon points="32,10 50,20.5 50,41.5 32,52 14,41.5 14,20.5" fill="{c}" fill-opacity=".16"/><polygon points="32,19.5 41.5,25 41.5,37 32,42.5 22.5,37 22.5,25" stroke="{a}" stroke-width="2.4"/>`;
const PILL = (x: number, y: number, w: number, h: number, rot: number, cx: number, cy: number, c1: string, c2: string) =>
  `<g transform="rotate(${rot} ${cx} ${cy})"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${c1}" stroke="none"/><path d="M${x + w / 2} ${y} H${x + w - h / 2} A${h / 2} ${h / 2} 0 0 1 ${x + w - h / 2} ${y + h} H${x + w / 2} Z" fill="${c2}" stroke="none"/></g>`;

const G: Record<string, string> = {
  // ── commands ──
  'cmd.move': `<path d="M19 45 L43 21"/><path d="M28 20 H44 V36"/><ellipse cx="18" cy="47" rx="7" ry="2.6" stroke="{a}" stroke-width="2.4"/>`,
  'cmd.stop': `<polygon points="25.8,16.5 38.2,16.5 47.5,25.8 47.5,38.2 38.2,47.5 25.8,47.5 16.5,38.2 16.5,25.8" fill="{c}" fill-opacity=".16" stroke="{c}"/><path d="M25 32 H39" stroke-width="4"/>`,
  'cmd.hold': `<path d="M32 12 L47 17.5 V29 C47 39.5 40.5 46.5 32 50.5 C23.5 46.5 17 39.5 17 29 V17.5 Z" fill="{a}" fill-opacity=".12"/><path d="M28 24.5 V38.5 M36 24.5 V38.5" stroke="{a}" stroke-width="3.6"/>`,
  'cmd.patrol': `<path d="M15 24 H45"/><path d="M39 18 L45 24 L39 30"/><path d="M49 40 H19" stroke="{a}"/><path d="M25 34 L19 40 L25 46" stroke="{a}"/>`,
  'cmd.attack': `<circle cx="32" cy="32" r="13" stroke="{c}"/><path d="M32 11 V21 M32 43 V53 M11 32 H21 M43 32 H53"/><circle cx="32" cy="32" r="3.2" fill="{c}" stroke="none"/>`,
  'cmd.gather': `<path d="M32 10 V24.5 M26 19 L32 25 L38 19" stroke="{a}"/><rect x="16" y="30" width="32" height="19" rx="3.5" fill="{d}"/><path d="M16 37.5 H48 M32 37.5 V49" stroke-width="2.4"/>`,
  'cmd.return': `<rect x="12" y="31" width="25" height="18" rx="3.5" fill="{d}"/><path d="M12 38 H37" stroke-width="2.4"/><path d="M50 45 V28 C50 22 46 18 40 18 H27" stroke="{a}"/><path d="M32.5 12.5 L27 18 L32.5 23.5" stroke="{a}"/>`,
  'cmd.repair': `<path d="M17 47 L33 31" stroke-width="7"/><circle cx="39.5" cy="24.5" r="8.5" stroke-width="5.5"/><path d="M41 23 L50 14" stroke="{t}" stroke-width="7" stroke-linecap="butt"/>`,
  'cmd.rally': `<path d="M21 51 V13"/><path d="M21.5 15 H45 L38.5 22.5 L45 30 H21.5" fill="{a}" fill-opacity=".85" stroke="{a}" stroke-width="2.4"/><ellipse cx="21" cy="51" rx="7" ry="2.4" stroke-width="2.2"/>`,
  'cmd.cancel': `<circle cx="32" cy="32" r="16" stroke="{c}"/><path d="M25 25 L39 39 M39 25 L25 39" stroke="{c}" stroke-width="3.6"/>`,
  'cmd.heal': `<circle cx="32" cy="32" r="16" fill="{a}" fill-opacity=".16" stroke="{a}"/><path d="M32 23 V41 M23 32 H41" stroke-width="4.4"/>`,
  'cmd.follow': `<circle cx="22" cy="24" r="6"/><path d="M12 46 C12 37 17 33 22 33 C27 33 32 37 32 46"/><path d="M38 32 H53 M47 26 L53 32 L47 38" stroke="{a}"/>`,
  'menu.build': `<path d="M12 51 V33 L23.5 25.5 L35 33 V51" fill="{d}"/><path d="M8 51 H56"/><path d="M20.5 51 V42.5 H26.5 V51" stroke-width="2.4"/><g transform="rotate(42 43 25)"><rect x="35.5" y="13.5" width="15" height="7.5" rx="2" fill="{a}" stroke="{a}" stroke-width="1.4"/><path d="M43 21 V40" stroke-width="3.8"/></g>`,
  'menu.build2': `<path d="M14 51 V19 H32 V51" fill="{d}"/><path d="M32 31 H45 V51" fill="{d}"/><path d="M9 51 H55"/><path d="M20 26 H26 M20 33 H26 M20 40 H26 M37 38 H40 M37 44 H40" stroke-width="2.4" stroke="{a}"/><path d="M47 8.5 L49.2 14.8 L55.5 17 L49.2 19.2 L47 25.5 L44.8 19.2 L38.5 17 L44.8 14.8 Z" fill="{a}" stroke="none"/>`,
  'menu.back': `<circle cx="32" cy="32" r="17.5" stroke-width="2.2" stroke-opacity=".45"/><path d="M34.5 21.5 L24 32 L34.5 42.5" stroke-width="4"/><path d="M25.5 32 H42" stroke-width="3.4"/>`,

  // ── hospital units ──
  hosp_orderly: `<path d="M32 19 V12.5"/><circle cx="32" cy="10.5" r="3" fill="{a}" stroke="none"/><rect x="18" y="19" width="28" height="24" rx="7" fill="{d}"/><rect x="22.5" y="25" width="19" height="8.5" rx="4.2" fill="{a}" stroke="none"/><circle cx="27.6" cy="29.2" r="1.7" fill="{d}" stroke="none"/><circle cx="36.4" cy="29.2" r="1.7" fill="{d}" stroke="none"/><path d="M13.5 29 V37 M50.5 29 V37"/><circle cx="24" cy="48.5" r="4" fill="{d}"/><circle cx="40" cy="48.5" r="4" fill="{d}"/><path d="M28 48.5 H36" stroke-width="2.4"/>`,
  hosp_sanitizer: `<path d="M11 54 C11 43 17 36.5 25.5 36.5 C31 36.5 35 39 37.5 43" fill="{d}"/><circle cx="25.5" cy="23" r="9.5" fill="{d}"/><rect x="19.5" y="19.5" width="13" height="7.5" rx="3.7" fill="{a}" stroke="none"/><path d="M29 46 L45 37.5" stroke-width="4.4"/><path d="M45 37.5 L48.5 35.6" stroke="{a}" stroke-width="4.4"/><circle cx="52.5" cy="31" r="2" fill="{a}" stroke="none"/><circle cx="55.5" cy="37" r="1.6" fill="{a}" stroke="none"/><circle cx="51.5" cy="25" r="1.4" fill="{a}" stroke="none"/><circle cx="57" cy="28.5" r="1.1" fill="{a}" stroke="none"/>`,
  hosp_medic: `<circle cx="32" cy="20.5" r="8.5" fill="{d}"/><path d="M14 53 C14 41 22 35 32 35 C42 35 50 41 50 53" fill="{d}"/><circle cx="32" cy="45" r="7.5" fill="{a}" stroke="none"/><path d="M32 40.8 V49.2 M27.8 45 H36.2" stroke-width="2.8"/>`,
  hosp_uv_lancer: `<circle cx="21" cy="22" r="7.5" fill="{d}"/><path d="M7 54 C7 43.5 13 37 21 37 C25.5 37 28.5 38.5 31 41" fill="{d}"/><path d="M21 48 L43.5 25.5" stroke-width="4.2"/><circle cx="45.5" cy="23.5" r="4" fill="{c}" stroke="none"/><path d="M49 20 L56.5 12.5" stroke="{c}" stroke-width="3"/><path d="M51 26 L57 27 M43 18 L42 11.5" stroke="{c}" stroke-width="2"/>`,
  hosp_antibiotic_launcher: `<path d="M8 45 V31 H35 V45" fill="{d}"/><path d="M35 34 H45 L52 41 V45 H35" fill="{d}"/><path d="M6 45 H57" stroke-width="2.6"/><circle cx="18" cy="47" r="4.5" fill="{d}"/><circle cx="44" cy="47" r="4.5" fill="{d}"/><path d="M39.5 37 H45 L48 40" stroke="{a}" stroke-width="2.2"/>${PILL(12, 15.5, 24, 9, -28, 24, 20, '{f}', '{a}')}<path d="M7 21 H12 M9 26.5 H14" stroke="{a}" stroke-width="2"/>`,
  hosp_macrophage: `<path d="M21 14 H43 L50 27 L43 39 H21 L14 27 Z" fill="{d}"/><rect x="24" y="21.5" width="16" height="7" rx="3.5" fill="{a}" stroke="none"/><path d="M24 39 L19.5 51.5 M40 39 L44.5 51.5 M15 51.5 H24 M40 51.5 H49"/><path d="M14 27 C7 28 6 36.5 10.5 40.5 M50 27 C57 28 58 36.5 53.5 40.5" stroke="{a}" stroke-width="3.6"/>`,
  hosp_sterilizer_drone: `<path d="M20 20 L44 44 M44 20 L20 44" stroke-width="3"/><ellipse cx="18" cy="18" rx="8.5" ry="3.2" fill="{a}" fill-opacity=".22" stroke="{a}" stroke-width="2.2"/><ellipse cx="46" cy="18" rx="8.5" ry="3.2" fill="{a}" fill-opacity=".22" stroke="{a}" stroke-width="2.2"/><ellipse cx="18" cy="46" rx="8.5" ry="3.2" fill="{a}" fill-opacity=".22" stroke="{a}" stroke-width="2.2"/><ellipse cx="46" cy="46" rx="8.5" ry="3.2" fill="{a}" fill-opacity=".22" stroke="{a}" stroke-width="2.2"/><circle cx="32" cy="32" r="7" fill="{d}"/><circle cx="32" cy="32" r="2.8" fill="{c}" stroke="none"/>`,

  // ── hospital buildings ──
  hosp_hq: `<path d="M24 22 V12 H40 V22" fill="{d}"/><rect x="12" y="22" width="40" height="29" rx="2.5" fill="{d}"/><path d="M7 51 H57"/><rect x="25" y="27" width="14" height="14" rx="3.5" fill="{a}" stroke="none"/><path d="M32 30 V38 M28 34 H36" stroke-width="2.8"/><path d="M17 45.5 H22 M42 45.5 H47 M17 30 H21 M43 30 H47" stroke-width="2.2" stroke-opacity=".65"/>`,
  hosp_ward: `<path d="M12 17 V50"/><path d="M12 39.5 H52 V50"/><rect x="17" y="29.5" width="33" height="10" rx="3" fill="{d}"/><rect x="17" y="23" width="11" height="6.8" rx="3" fill="{a}" stroke="none"/><path d="M45.5 13 V24 M40 18.5 H51" stroke="{a}" stroke-width="3"/>`,
  hosp_generator: `<rect x="11" y="21" width="42" height="27" rx="4" fill="{d}"/><path d="M16 48 V53 M48 48 V53"/><path d="M16 28 H21.5 M16 34 H21.5 M16 40 H21.5" stroke-width="2" stroke-opacity=".6"/><path d="M38 12 L26 33.5 H33.5 L29.5 51.5 L44.5 28 H36.5 Z" fill="{p}" stroke="{p}" stroke-width="1.6"/>`,
  hosp_pharmacy: `<path d="M25 11.5 H39 V25 H52.5 V39 H39 V52.5 H25 V39 H11.5 V25 H25 Z" fill="{g}" stroke="{f}" stroke-width="2.6"/><path d="M28.5 15.5 V28.5 H15.5" stroke="{f}" stroke-width="1.6" stroke-opacity=".55"/>`,
  hosp_lab: `<path d="M25.5 12 H38.5"/><path d="M28.5 12 V26 L16.5 46 C15 49 17 52 20.5 52 H43.5 C47 52 49 49 47.5 46 L35.5 26 V12" fill="{d}"/><path d="M20.4 41 H43.6 L46.3 46.2 C47.2 48.2 46 50 43.5 50 H20.5 C18 50 16.8 48.2 17.7 46.2 Z" fill="{a}" stroke="none"/><circle cx="29" cy="35" r="2" fill="{a}" stroke="none"/><circle cx="34.5" cy="30" r="1.5" fill="{a}" stroke="none"/>`,
  hosp_vehicle_bay: `<rect x="7" y="22" width="31" height="22" rx="2.5" fill="{d}"/><path d="M38 28 H46.5 L54.5 36 V44 H38 Z" fill="{d}"/><path d="M41 31 H46 L50 35.5 H41 Z" fill="{a}" fill-opacity=".55" stroke="none"/><circle cx="18" cy="46" r="4.6" fill="{d}"/><circle cx="45.5" cy="46" r="4.6" fill="{d}"/><path d="M22.5 27 V39 M16.5 33 H28.5" stroke="{a}" stroke-width="3.6"/><rect x="13" y="15.5" width="10" height="4.5" rx="2.2" fill="{a}" stroke="none"/>`,
  hosp_uv_turret: `<path d="M21 52 H43 L39 44 H25 Z" fill="{d}"/><path d="M32 44 V30" stroke-width="4"/><circle cx="32" cy="23" r="8" fill="{d}"/><circle cx="32" cy="23" r="3.5" fill="{c}" stroke="none"/><path d="M43 13 L47.5 8.5 M45.5 23 H52 M43 33 L47.5 37.5 M21 13 L16.5 8.5 M18.5 23 H12 M21 33 L16.5 37.5" stroke="{c}" stroke-width="2.6"/>`,
  hosp_barricade: `<defs><clipPath id="ipk§"><rect x="9" y="20" width="46" height="19" rx="3"/></clipPath></defs><rect x="9" y="20" width="46" height="19" rx="3" fill="{d}" stroke="none"/><g clip-path="url(#ipk§)" stroke="{a}" stroke-width="5.5"><path d="M8 46 L21 14 M22 46 L35 14 M36 46 L49 14 M50 46 L63 14"/></g><rect x="9" y="20" width="46" height="19" rx="3"/><path d="M15 39 V51 M49 39 V51 M11 51 H19 M45 51 H53"/>`,
  obj_childrens_hospital: `<path d="M10 51 V27 L32 13 L54 27 V51 Z" fill="{d}"/><path d="M6 51 H58"/><path d="M32 46 C21.5 39 21 30.5 26.5 29 C29.5 28.3 31.4 30 32 32.4 C32.6 30 34.5 28.3 37.5 29 C43 30.5 42.5 39 32 46 Z" fill="{a}" stroke="none"/>`,

  // ── hospital upgrades ──
  up_hosp_weapons_1: DROPLET_UP('{a}', '{a}', '{f}') + pips(1),
  up_hosp_weapons_2: DROPLET_UP('{a}', '{a}', '{f}') + pips(2),
  up_hosp_armor_1: PLATING + pips(1),
  up_hosp_armor_2: PLATING + pips(2),
  up_hosp_rapid_response: `<path d="M13 20 L25 32 L13 44" stroke-width="4"/><path d="M27 20 L39 32 L27 44" stroke="{a}" stroke-width="4"/><path d="M41 24 L49 32 L41 40" stroke="{a}" stroke-opacity=".5" stroke-width="4"/>`,
  up_hosp_uv_overcharge: `<circle cx="29" cy="35" r="8.5" fill="{c}" stroke="none"/><path d="M29 18.5 V22.5 M29 47.5 V51.5 M12.5 35 H16.5 M41.5 35 H45.5 M17.3 23.3 L20.1 26.1 M37.9 43.9 L40.7 46.7 M17.3 46.7 L20.1 43.9 M37.9 26.1 L40.7 23.3" stroke="{c}" stroke-width="2.8"/><path d="M48 9 V20 M42.5 14.5 H53.5" stroke-width="3.2"/>`,
  up_hosp_broad_spectrum: `<path d="M12 42 A20 20 0 0 1 52 42" stroke="{c}" stroke-width="2.6"/><path d="M17.5 42 A14.5 14.5 0 0 1 46.5 42" stroke="{a}" stroke-width="2.6"/><path d="M23 42 A9 9 0 0 1 41 42" stroke="{p}" stroke-width="2.6"/>${PILL(19, 38, 26, 10, -35, 32, 43, '{f}', '{a}')}`,
  up_hosp_logistics: `<rect x="11" y="25" width="31" height="24" rx="3.5" fill="{d}"/><path d="M11 33 H42 M26.5 33 V49" stroke-width="2.4"/><path d="M48 11 V25 M41 18 H55" stroke="{a}" stroke-width="3.6"/>`,

  // ── abilities ──
  uv_flare: `<polygon points="${star(32, 32, 21, 8, 8)}" fill="{c}" fill-opacity=".35" stroke="{c}" stroke-width="2"/><circle cx="32" cy="32" r="6.5" fill="{f}" stroke="none"/>`,
  emergency_supply: `<path d="M13 27 C13 14 51 14 51 27 C45 23.5 38.5 23.5 32 27 C25.5 23.5 19 23.5 13 27 Z" fill="{a}" fill-opacity=".3" stroke="{a}" stroke-width="2.6"/><path d="M14 27.5 L27 40 M50 27.5 L37 40 M32 27 V40" stroke-width="1.8"/><rect x="25" y="40" width="14" height="12" rx="2.5" fill="{d}"/><path d="M32 43 V49 M29 46 H35" stroke="{a}" stroke-width="2.2"/>`,
  viral_burst: `<polygon points="${star(32, 32, 21, 10, 10, 0.2)}" fill="{c}" fill-opacity=".28" stroke="{c}" stroke-width="2"/><circle cx="32" cy="32" r="7" fill="{a}" stroke="none"/><circle cx="12" cy="14" r="2.2" fill="{a}" stroke="none"/><circle cx="53" cy="49" r="2.4" fill="{a}" stroke="none"/><circle cx="51" cy="12" r="1.6" fill="{a}" stroke="none"/>`,
  omega_spawn: `<path d="M17 47 H26 V43 C19 39.5 16.5 34 16.5 29.5 A15.5 15.5 0 0 1 47.5 29.5 C47.5 34 45 39.5 38 43 V47 H47" stroke="{a}" stroke-width="3.6"/><circle cx="51" cy="13.5" r="3" fill="{c}" stroke="none"/><circle cx="13" cy="14" r="2.4" fill="{c}" stroke="none"/><circle cx="32" cy="8.5" r="2" fill="{c}" stroke="none"/>`,

  // ── pathogen units ──
  path_spore_drone: `<ellipse cx="17.5" cy="25" rx="8.5" ry="4.5" transform="rotate(-28 17.5 25)" fill="{c}" fill-opacity=".22" stroke="{c}" stroke-width="2"/><ellipse cx="46.5" cy="25" rx="8.5" ry="4.5" transform="rotate(28 46.5 25)" fill="{c}" fill-opacity=".22" stroke="{c}" stroke-width="2"/><circle cx="32" cy="33" r="11.5" fill="{a}" fill-opacity=".2" stroke="{a}"/><circle cx="28" cy="30" r="2.3" fill="{a}" stroke="none"/><circle cx="35.5" cy="36.5" r="1.9" fill="{a}" stroke="none"/><circle cx="35" cy="27.5" r="1.3" fill="{a}" stroke="none"/><path d="M26.5 44 C24.5 48 26.5 51 23.5 54.5 M37.5 44 C39.5 48 37.5 51 40.5 54.5" stroke-width="2"/>`,
  path_phage: `<polygon points="32,8.5 41,13.7 41,24.3 32,29.5 23,24.3 23,13.7" fill="{c}" fill-opacity=".28"/><path d="M32 8.5 V29.5 M23 13.7 L41 24.3 M41 13.7 L23 24.3" stroke="{c}" stroke-width="1.4" stroke-opacity=".7"/><path d="M32 29.5 V40.5" stroke-width="4"/><rect x="26.5" y="40" width="11" height="4.2" rx="1.6" fill="{f}" stroke="none"/><path d="M28 44 L19 49 L16 55 M36 44 L45 49 L48 55 M30 44.5 L26 50 L24.5 55.5 M34 44.5 L38 50 L39.5 55.5" stroke="{a}" stroke-width="2.2"/>`,
  path_bacillus: `<g transform="rotate(-30 32 32)"><rect x="11" y="22" width="42" height="20" rx="10" fill="{a}" fill-opacity=".22" stroke="{a}"/><circle cx="23" cy="31" r="2.7" fill="{a}" stroke="none"/><circle cx="33" cy="34" r="2" fill="{a}" stroke="none"/><circle cx="42" cy="29.5" r="2.3" fill="{a}" stroke="none"/><path d="M16 22.5 L13 17.5 M26 21.5 L25 16 M38 21.5 L40 16 M48.5 23.5 L52.5 19.5 M17.5 41.5 L14.5 46.5 M30 42.5 L30 48 M43.5 42 L46.5 46.5" stroke-width="1.8"/></g>`,
  path_spirochete: `<path d="M8.5 39 C14 20.5 21 20.5 25.5 31 C30 41.5 36 41.5 40.5 31 C45 20.5 51 21.5 55.5 29.5" stroke="{c}" stroke-width="8" stroke-opacity=".22"/><path d="M8.5 39 C14 20.5 21 20.5 25.5 31 C30 41.5 36 41.5 40.5 31 C45 20.5 51 21.5 55.5 29.5" stroke="{a}" stroke-width="3.6"/><circle cx="55.8" cy="29.8" r="2.6" fill="{f}" stroke="none"/>`,
  path_fungal_mortar: `<path d="M11 35 C11 17 53 17 53 35 Z" fill="{c}" fill-opacity=".3"/><circle cx="22" cy="28.5" r="2.6" fill="{f}" fill-opacity=".75" stroke="none"/><circle cx="33" cy="24" r="2.2" fill="{f}" fill-opacity=".75" stroke="none"/><circle cx="43" cy="29" r="2.4" fill="{f}" fill-opacity=".75" stroke="none"/><path d="M25 35 V49 C25 51 27 52 32 52 C37 52 39 51 39 49 V35" fill="{d}"/><circle cx="48" cy="11" r="2.8" fill="{a}" stroke="none"/><circle cx="54.5" cy="17" r="2" fill="{a}" stroke="none"/><circle cx="41.5" cy="8.5" r="1.5" fill="{a}" stroke="none"/>`,
  path_superbug: `<ellipse cx="32" cy="35" rx="24" ry="18.5" stroke="{a}" stroke-width="1.6" stroke-dasharray="3 4"/><ellipse cx="32" cy="35" rx="18.5" ry="14" fill="{c}" fill-opacity=".24"/><path d="M19.5 28 C24.5 23.5 39.5 23.5 44.5 28 M16 35.5 C22 31 42 31 48 35.5 M19.5 43 C25 39.5 39 39.5 44.5 43" stroke="{c}" stroke-width="2.4"/><path d="M22.5 22 L19.5 13.5 M32 20.5 V11 M41.5 22 L44.5 13.5" stroke="{a}" stroke-width="3.2"/>`,
  path_flu_drifter: virion(32, 32, 12, 6.5, 12, 2.1, '{c}', '{f}', '{a}') + `<circle cx="28" cy="29" r="2.6" fill="{a}" stroke="none"/><circle cx="36" cy="35" r="2" fill="{a}" stroke="none"/>`,
  path_strain_omega: virion(32, 32, 14, 8, 16, 2.4, '{c}', '{c}', '{a}', 0.1) + `<ellipse cx="32" cy="32" rx="6.5" ry="8.5" fill="{a}" stroke="none"/><ellipse cx="32" cy="32" rx="1.9" ry="6" fill="{d}" stroke="none"/>`,

  // ── pathogen buildings ──
  path_hive: `<path d="M8 51 C10 31 20 19 32 19 C44 19 54 31 56 51 Z" fill="{c}" fill-opacity=".22"/><circle cx="32" cy="37" r="11" stroke="{a}" stroke-width="1.6" stroke-opacity=".6"/><circle cx="32" cy="37" r="7" fill="{a}" stroke="none"/><path d="M24.5 31.5 C20 28 17 30 14 27 M39.5 31.5 C44 28 47 30 50 27 M26.5 44.5 C24 48 20 47 17 50 M37.5 44.5 C40 48 44 47 47 50" stroke="{a}" stroke-width="1.8"/><path d="M4 51 H60" stroke-width="2.4"/>`,
  path_nest: `<circle cx="22" cy="39" r="10" fill="{c}" fill-opacity=".2"/><circle cx="42" cy="39" r="10" fill="{c}" fill-opacity=".2"/><circle cx="32" cy="22.5" r="10" fill="{c}" fill-opacity=".2"/><circle cx="22" cy="39" r="3.2" fill="{a}" stroke="none"/><circle cx="42" cy="39" r="3.2" fill="{a}" stroke="none"/><circle cx="32" cy="22.5" r="3.2" fill="{a}" stroke="none"/>`,
  path_fermenter: `<path d="M15 23 H49 L45.5 51 H18.5 Z" fill="{d}"/><path d="M16.3 33 H47.7 L45.6 50.2 H18.4 Z" fill="{a}" fill-opacity=".42" stroke="none"/><path d="M12.5 23 H51.5" stroke-width="3.4"/><circle cx="27" cy="16" r="2.8" fill="{a}" stroke="none"/><circle cx="36" cy="10.5" r="2.2" fill="{a}" stroke="none"/><circle cx="34" cy="17.5" r="1.6" fill="{a}" stroke="none"/><circle cx="25" cy="41" r="2" fill="{f}" fill-opacity=".6" stroke="none"/><circle cx="37" cy="45" r="1.6" fill="{f}" fill-opacity=".6" stroke="none"/>`,
  path_replicator: `<path d="M32 20 C28 13.5 11.5 14 11 32 C11.5 50 28 50.5 32 44 C36 50.5 52.5 50 53 32 C52.5 14 36 13.5 32 20 Z" fill="{c}" fill-opacity=".22"/><path d="M32 21 V43" stroke-width="1.6" stroke-dasharray="2.5 3"/><circle cx="22" cy="32" r="4.8" fill="{a}" stroke="none"/><circle cx="42" cy="32" r="4.8" fill="{a}" stroke="none"/>`,
  path_mutation_pit: helix(32, 9, 55, 11),
  path_biofilm_spire: `<path d="M32 8 C35 22 44 30 43 52 H21 C20 30 29 22 32 8 Z" fill="{c}" fill-opacity=".22"/><path d="M24.5 42 C29 40 35 40 39.5 42 M26.5 32 C29.5 30.5 34.5 30.5 37.5 32 M28.5 23 C30.5 22 33.5 22 35.5 23" stroke="{c}" stroke-width="2.2"/><circle cx="32" cy="9.5" r="3.2" fill="{a}" stroke="none"/><path d="M13 52 H51" stroke-width="2.4"/>`,
  path_toxin_spitter: `<path d="M27 52 C27 42 23 35 27 27.5" stroke-width="4"/><ellipse cx="31" cy="22" rx="10.5" ry="8" fill="{c}" fill-opacity=".3"/><path d="M36 18 C40 20 40 24 36 26" stroke="{a}" stroke-width="2.6"/><circle cx="46.5" cy="20" r="3.2" fill="{a}" stroke="none"/><circle cx="53" cy="16.5" r="2.2" fill="{a}" stroke="none"/><circle cx="57" cy="22" r="1.4" fill="{a}" stroke="none"/><path d="M17 52 H39" stroke-width="2.4"/>`,

  // ── pathogen upgrades ──
  up_path_toxins_1: DROPLET_UP('{c}', '{c}', '{a}') + pips(1),
  up_path_toxins_2: DROPLET_UP('{c}', '{c}', '{a}') + pips(2),
  up_path_carapace_1: HEXSHELL + pips(1),
  up_path_carapace_2: HEXSHELL + pips(2),
  up_path_flagella: `<circle cx="43" cy="32" r="8.5" fill="{a}" fill-opacity=".25" stroke="{a}"/><path d="M34.5 27 C28.5 22 24.5 30 18.5 25 C14.5 22 12.5 24 9 22 M34.5 32 C28.5 28 24.5 36 18.5 32 C14.5 29 12.5 31 9 30 M34.5 37 C28.5 34 24.5 42 18.5 39 C14.5 36 12.5 38 9 38" stroke-width="2.2"/>`,
  up_path_resistance: `${PILL(16, 26, 32, 12, -35, 32, 32, '{f}', '{c}')}<circle cx="32" cy="32" r="19" stroke="{a}" stroke-width="3"/><path d="M18.6 45.4 L45.4 18.6" stroke="{a}" stroke-width="3.4"/>`,
  up_path_virulence: virion(27, 36, 9.5, 5, 10, 1.7, '{c}', '{f}', '{a}') + `<path d="M48 10 V22 M42 16 H54" stroke="{a}" stroke-width="3.4"/>`,
  up_path_metabolism: `<circle cx="27" cy="37" r="12" fill="{a}" fill-opacity=".2" stroke="{a}"/><circle cx="23" cy="34" r="2.4" fill="{a}" stroke="none"/><circle cx="31" cy="40" r="2" fill="{a}" stroke="none"/><path d="M48 10 V23 M41.5 16.5 H54.5" stroke="{c}" stroke-width="3.4"/>`,

  // ── neutral ──
  res_supply_cache: `<path d="M14 22 L18 14.5 H46 L50 22" fill="{d}"/><rect x="10" y="22" width="44" height="28" rx="3.5" fill="{d}"/><path d="M10 31 H54 M23.5 31 V50 M40.5 31 V50" stroke-width="2.2"/><path d="M32 35.5 V46.5 M26.5 41 H37.5" stroke="{a}" stroke-width="3"/>`,
};

/** Alternate keys the controls module may use for the same picture. */
const ALIAS: Record<string, string> = {
  'cmd.attackMove': 'cmd.attack', 'cmd.attack_move': 'cmd.attack', 'cmd.returnCargo': 'cmd.return', 'cmd.return_cargo': 'cmd.return',
  'cmd.setRally': 'cmd.rally', 'cmd.set_rally': 'cmd.rally', 'cmd.build': 'menu.build', 'cmd.construct': 'menu.build',
  'cmd.build2': 'menu.build2', 'cmd.advanced': 'menu.build2', 'cmd.back': 'menu.back', 'cmd.cancelConstruction': 'cmd.cancel',
  'cmd.cancelTrain': 'cmd.cancel', 'cmd.cancelResearch': 'cmd.cancel', 'cmd.cancel_build': 'cmd.cancel', 'cmd.holdPosition': 'cmd.hold',
  'menu.cancel': 'cmd.cancel', 'menu.advanced': 'menu.build2', 'cmd.harvest': 'cmd.gather',
};
const PREFIXES = ['train.', 'build.', 'research.', 'ability.', 'upgrade.', 'unit.', 'def.', 'icon.'];

function normalizeKey(key: string): string {
  if (G[key]) return key;
  if (ALIAS[key]) return ALIAS[key]!;
  for (const p of PREFIXES) if (key.startsWith(p)) { const k = key.slice(p.length); if (G[k] || ALIAS[k]) return ALIAS[k] ?? k; }
  return key;
}

function abilityFaction(id: string): FactionId | null {
  for (const u of Object.values(UNIT_DEFS)) if (u.abilities.includes(id)) return u.faction;
  for (const b of Object.values(BUILDING_DEFS)) if (b.abilities.includes(id)) return b.faction;
  return null;
}

function paletteFor(k: string): Pal {
  if (k.startsWith('cmd.') || k.startsWith('menu.') || k.startsWith('ui.')) return PAL.command;
  if (k.startsWith('res_')) return PAL.resource;
  const def = tryGetDef(k);
  if (def) return def.kind === 'resource' ? PAL.resource : def.faction === 'pathogen' ? PAL.pathogen : PAL.hospital;
  const up = UPGRADE_DEFS[k];
  if (up) return up.faction === 'pathogen' ? PAL.pathogen : PAL.hospital;
  if (ABILITY_DEFS[k]) return abilityFaction(k) === 'pathogen' ? PAL.pathogen : PAL.hospital;
  for (const p of PREFIXES) if (k.startsWith(p)) return paletteFor(k.slice(p.length));
  if (/^(path_|up_path)/.test(k)) return PAL.pathogen;
  if (/^(hosp_|up_hosp|obj_)/.test(k)) return PAL.hospital;
  return PAL.command;
}

function applyPal(svg: string, pal: Pal): string {
  return svg.replace(/\{([a-z])\}/g, (m, k: string) => (pal as unknown as Record<string, string>)[k] ?? FIXED[k] ?? m);
}

function tile(pal: Pal, glyph: string): string {
  return `<svg class="ip-ico" viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">`
    + `<defs><linearGradient id="ipg§" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.t}"/><stop offset="1" stop-color="${pal.b}"/></linearGradient>`
    + `<radialGradient id="ipr§" cx=".5" cy=".42" r=".62"><stop offset="0" stop-color="${pal.glow}" stop-opacity=".38"/><stop offset="1" stop-color="${pal.glow}" stop-opacity="0"/></radialGradient></defs>`
    + `<rect x="1" y="1" width="62" height="62" rx="12" fill="url(#ipg§)"/><rect x="1" y="1" width="62" height="62" rx="12" fill="url(#ipr§)"/>`
    + `<rect x="1.5" y="1.5" width="61" height="61" rx="11.5" fill="none" stroke="${pal.rim}" stroke-opacity=".32"/>`
    + `<path d="M14 1.6 H50" stroke="${pal.rim}" stroke-opacity=".75" stroke-width="1.2" stroke-linecap="round"/>`
    + `<g fill="none" stroke="${pal.f}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">${applyPal(glyph, pal)}</g></svg>`;
}

function initials(k: string): string {
  const base = k.replace(/^[a-z]+\./, '').replace(/^(hosp|path|up|obj|res)_/, '').replace(/^(hosp|path)_/, '');
  const parts = base.split(/[_\-.\s]+/).filter(Boolean);
  const s = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? '?').slice(0, 2);
  return s.toUpperCase().replace(/[^A-Z0-9?]/g, '') || '?';
}

function fallbackGlyph(k: string): string {
  return `<polygon points="32,11 50,21.5 50,42.5 32,53 14,42.5 14,21.5" fill="{a}" fill-opacity=".12" stroke="{a}" stroke-width="2.4"/>`
    + `<text x="32" y="38.5" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="16" letter-spacing="0.5" fill="{f}" stroke="none">${initials(k)}</text>`;
}

const cache = new Map<string, string>();
let uid = 0;

/** Tile icon HTML (inline SVG) for a def / upgrade / ability id or a cmd.* / menu.* key. */
export function iconHtml(key: string): string {
  const k = normalizeKey(key || '?');
  let tpl = cache.get(k);
  if (!tpl) {
    tpl = tile(paletteFor(k), G[k] ?? fallbackGlyph(k));
    cache.set(k, tpl);
  }
  const id = (++uid).toString(36);
  return tpl.replace(/§/g, id);
}

/** True if the key has a dedicated (non-fallback) icon. */
export function hasIcon(key: string): boolean { return !!G[normalizeKey(key)]; }

/** All keys with a dedicated icon (sandbox gallery / tests). */
export function iconKeys(): string[] { return Object.keys(G); }

// ───────────────────────── small UI glyphs (20×20, currentColor) ─────────────────────────
const UI: Record<string, string> = {
  'ui.supplies': `<rect x="3" y="6.5" width="14" height="10.5" rx="2"/><path d="M3 10 H17"/><path d="M10 11.8 V15.6 M8.1 13.7 H11.9" stroke-width="1.6"/><path d="M5 6.5 L6.5 3.5 H13.5 L15 6.5"/>`,
  'ui.power': `<path d="M11.8 1.8 L4.6 11.4 H9.4 L7.9 18.2 L15.4 8.2 H10.6 Z" fill="currentColor" stroke="none"/>`,
  'ui.beds': `<path d="M2.5 4.5 V16 M2.5 12.5 H17.5 V16"/><rect x="5.5" y="8.6" width="12" height="3.9" rx="1.4"/><rect x="5.5" y="5.6" width="4" height="3" rx="1.2" fill="currentColor" stroke="none"/>`,
  'ui.biomass': `<path d="M10 2.8 C15 2.8 17.6 6.8 16.6 11 C15.7 15.4 12.2 17.6 8.6 16.7 C4.2 15.6 2.5 12.2 3.4 8.2 C4.2 5 6.6 2.8 10 2.8 Z" fill="currentColor" fill-opacity=".3"/><circle cx="8" cy="9" r="1.6" fill="currentColor" stroke="none"/><circle cx="12.2" cy="12.1" r="1.2" fill="currentColor" stroke="none"/>`,
  'ui.toxin': `<path d="M10 2.2 C13.6 6.8 15.6 9.4 15.6 12.4 A5.6 5.6 0 0 1 4.4 12.4 C4.4 9.4 6.4 6.8 10 2.2 Z" fill="currentColor" fill-opacity=".3"/><path d="M7.6 12.8 A2.6 2.6 0 0 0 10 15"/>`,
  'ui.colony': `<circle cx="7" cy="12.5" r="3.8" fill="currentColor" fill-opacity=".25"/><circle cx="13.2" cy="12.5" r="3.8" fill="currentColor" fill-opacity=".25"/><circle cx="10.1" cy="6.6" r="3.8" fill="currentColor" fill-opacity=".25"/>`,
  'ui.time': `<circle cx="10" cy="10" r="7.2"/><path d="M10 5.8 V10 L13 12"/>`,
  'ui.armor': `<path d="M10 2.3 L16.2 4.8 V9.6 C16.2 13.6 13.6 16.2 10 17.7 C6.4 16.2 3.8 13.6 3.8 9.6 V4.8 Z"/>`,
  'ui.damage': `<circle cx="10" cy="10" r="5.4"/><path d="M10 1.6 V5 M10 15 V18.4 M1.6 10 H5 M15 10 H18.4"/><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none"/>`,
  'ui.range': `<path d="M2.8 10 H17.2 M6 6.8 L2.8 10 L6 13.2 M14 6.8 L17.2 10 L14 13.2"/>`,
  'ui.cooldown': `<path d="M5.2 2.6 H14.8 M5.2 17.4 H14.8"/><path d="M6.4 2.6 C6.4 7 13.6 7.6 13.6 10 C13.6 12.4 6.4 13 6.4 17.4 M13.6 2.6 C13.6 7 6.4 7.6 6.4 10 C6.4 12.4 13.6 13 13.6 17.4"/>`,
  'ui.speed': `<path d="M3.5 5 L8.5 10 L3.5 15 M10 5 L15 10 L10 15"/>`,
  'ui.sight': `<path d="M1.8 10 C4.5 5.6 7 4 10 4 C13 4 15.5 5.6 18.2 10 C15.5 14.4 13 16 10 16 C7 16 4.5 14.4 1.8 10 Z"/><circle cx="10" cy="10" r="2.6" fill="currentColor" stroke="none"/>`,
  'ui.heal': `<path d="M10 3.6 V16.4 M3.6 10 H16.4" stroke-width="2.8"/>`,
  'ui.menu': `<path d="M3.5 5.5 H16.5 M3.5 10 H16.5 M3.5 14.5 H16.5"/>`,
  'ui.alert': `<path d="M10 2.6 L18 16.6 H2 Z"/><path d="M10 7.6 V11.4"/><circle cx="10" cy="14" r="1" fill="currentColor" stroke="none"/>`,
  'ui.info': `<circle cx="10" cy="10" r="7.4"/><path d="M10 9 V14"/><circle cx="10" cy="6.2" r="1" fill="currentColor" stroke="none"/>`,
  'ui.check': `<path d="M4 10.4 L8.2 14.4 L16 5.6"/>`,
  'ui.cross': `<path d="M5.2 5.2 L14.8 14.8 M14.8 5.2 L5.2 14.8"/>`,
  'ui.lock': `<rect x="4" y="9" width="12" height="8.6" rx="2"/><path d="M6.6 9 V6.6 A3.4 3.4 0 0 1 13.4 6.6 V9"/>`,
  'ui.star': `<polygon points="${star(10, 10.4, 7.6, 3.3, 5)}" fill="currentColor" stroke="none"/>`,
  'ui.ring': `<circle cx="10" cy="10" r="5.6"/>`,
  'ui.worker': `<rect x="4.5" y="5.5" width="11" height="9" rx="2.8"/><rect x="6.6" y="8" width="6.8" height="3" rx="1.5" fill="currentColor" stroke="none"/><path d="M10 5.5 V2.8 M6.5 17 H13.5"/>`,
  'ui.pulse': `<path d="M1 10.5 H5.4 L7.4 6.2 L10 15 L12.6 3.6 L14.6 10.5 H19"/>`,
  'ui.target': `<circle cx="10" cy="10" r="6.6"/><circle cx="10" cy="10" r="2.4"/>`,
  'ui.play': `<path d="M6.5 4 L15.5 10 L6.5 16 Z" fill="currentColor" stroke="none"/>`,
  'ui.pause': `<path d="M7 4.5 V15.5 M13 4.5 V15.5" stroke-width="2.4"/>`,
  'ui.sliders': `<path d="M3 6 H17 M3 14 H17"/><circle cx="7.5" cy="6" r="2.2" fill="currentColor"/><circle cx="12.5" cy="14" r="2.2" fill="currentColor"/>`,
  'ui.book': `<path d="M10 5 C8 3.6 5 3.4 2.6 4 V16 C5 15.4 8 15.6 10 17 C12 15.6 15 15.4 17.4 16 V4 C15 3.4 12 3.6 10 5 Z M10 5 V17"/>`,
  'ui.people': `<circle cx="7" cy="7" r="2.8"/><path d="M2 16.5 C2 12.8 4.2 11 7 11 C9.8 11 12 12.8 12 16.5"/><circle cx="14" cy="7.6" r="2.3"/><path d="M13 11.3 C15.6 11.2 18 12.8 18 16.2"/>`,
  'ui.flag': `<path d="M4.5 18 V2.5"/><path d="M4.8 3.5 H15.5 L12.8 7 L15.5 10.5 H4.8" fill="currentColor" fill-opacity=".35"/>`,
  'ui.swords': `<path d="M3.5 3.5 L13 13 M16.5 3.5 L7 13 M11.5 14.5 L14.5 11.5 M8.5 14.5 L5.5 11.5 M13 16.5 L16.5 13 M7 16.5 L3.5 13"/>`,
  'ui.exit': `<path d="M8 3.5 H4 V16.5 H8 M12 6 L16 10 L12 14 M16 10 H7.5"/>`,
  'ui.restart': `<path d="M4.2 10 A5.8 5.8 0 1 0 6 5.8"/><path d="M5.6 2.4 V6.2 H9.4"/>`,
  'ui.next': `<path d="M5 4.5 L11 10 L5 15.5 M11 4.5 L17 10 L11 15.5"/>`,
  'ui.home': `<path d="M3 9.5 L10 3.5 L17 9.5 M5 8 V16.5 H15 V8"/>`,
  'ui.download': `<path d="M10 3 V12.5 M6 8.8 L10 12.8 L14 8.8 M3.5 13.5 V16.5 H16.5 V13.5"/>`,
  'ui.upload': `<path d="M10 13 V3.5 M6 7.2 L10 3.2 L14 7.2 M3.5 13.5 V16.5 H16.5 V13.5"/>`,
  'ui.plus': `<path d="M10 4 V16 M4 10 H16"/>`,
  'ui.minus': `<path d="M4 10 H16"/>`,
  'ui.trophy': `<path d="M6 3.5 H14 V8 A4 4 0 0 1 6 8 Z M6 5 H3.2 C3.2 8 4.5 9 6.3 9.2 M14 5 H16.8 C16.8 8 15.5 9 13.7 9.2 M10 12 V15 M6.5 16.5 H13.5"/>`,
  'ui.skull': `<path d="M10 3 C6 3 3.6 5.6 3.6 9 C3.6 11.2 4.8 12.6 6 13.3 V16 H14 V13.3 C15.2 12.6 16.4 11.2 16.4 9 C16.4 5.6 14 3 10 3 Z"/><circle cx="7.6" cy="9.2" r="1.4" fill="currentColor" stroke="none"/><circle cx="12.4" cy="9.2" r="1.4" fill="currentColor" stroke="none"/>`,
};

/** Small monochrome glyph (inherits `color`). Unknown keys → a small ring. */
export function glyphHtml(key: string, cls = ''): string {
  const body = UI[key] ?? UI['ui.ring']!;
  return `<svg class="ip-glyph${cls ? ` ${cls}` : ''}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/** Glyph key for a faction's resource / pop display. */
export function resourceGlyphKey(faction: FactionId, kind: 'matter' | 'energy' | 'pop'): string {
  if (faction === 'pathogen') return kind === 'matter' ? 'ui.biomass' : kind === 'energy' ? 'ui.toxin' : 'ui.colony';
  return kind === 'matter' ? 'ui.supplies' : kind === 'energy' ? 'ui.power' : 'ui.beds';
}
