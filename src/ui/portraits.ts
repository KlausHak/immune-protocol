/**
 * [ui] Procedural SVG portraits for the campaign cast (DialogueLine.portrait). Flat, stylised busts with
 * soft gradients on a monitor-style backdrop — tasteful, readable at 80–120 px. Ids unique per call.
 *   cmo       Dr. Aino Virtanen — Chief Medical Officer (white coat, glasses, blonde bun)
 *   sisu      SISU — the campus defence AI (segmented lens + ECG)
 *   paramedic Lt. Joonas Mäkelä — paramedic team leader (headset, hi-vis yoke)
 *   engineer  Chief Engineer Leena Korhonen (hard hat, hi-vis vest)
 *   nurse     ward nurse (scrubs, lowered mask)
 *   omega     Strain Omega (spiked super-strain with a glitching "eye")
 *   pathogen  generic contagion feed
 */
import type { PortraitId } from '../core/ui';

let uid = 0;

const wrap = (body: string): string =>
  `<svg class="ip-portrait-svg" viewBox="0 0 100 100" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid slice">${body}</svg>`;

const grid = (col: string, op = 0.07) =>
  `<path d="M0 20 H100 M0 40 H100 M0 60 H100 M0 80 H100 M20 0 V100 M40 0 V100 M60 0 V100 M80 0 V100" stroke="${col}" stroke-opacity="${op}" stroke-width=".6"/>`;

const bg = (id: string, c0: string, c1: string) =>
  `<radialGradient id="bg${id}" cx=".5" cy=".36" r=".78"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></radialGradient>`;

const lin = (id: string, c0: string, c1: string) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></linearGradient>`;

function eyes(y: number, col = '#24323a', dx = 5.8): string {
  return `<ellipse cx="${50 - dx}" cy="${y}" rx="1.45" ry="1.75" fill="${col}"/><ellipse cx="${50 + dx}" cy="${y}" rx="1.45" ry="1.75" fill="${col}"/>`
    + `<circle cx="${50 - dx + 0.5}" cy="${y - 0.6}" r=".45" fill="#fff" fill-opacity=".8"/><circle cx="${50 + dx + 0.5}" cy="${y - 0.6}" r=".45" fill="#fff" fill-opacity=".8"/>`;
}

function cmo(i: string): string {
  return wrap(`<defs>${bg(i, '#1d6066', '#05151a')}${lin(`sk${i}`, '#f7d6bd', '#e8b694')}${lin(`hr${i}`, '#f2d894', '#c99a4b')}${lin(`ct${i}`, '#ffffff', '#c9dde1')}</defs>
<rect width="100" height="100" fill="url(#bg${i})"/>${grid('#7ff5e6')}
<circle cx="50" cy="18.5" r="8.5" fill="#c08f42"/>
<path d="M33 47 C31 28 40 21 50 21 C61 21 69 28 67 47 C66 53 64 57 62 59 L38 59 C36 57 34 53 33 47 Z" fill="url(#hr${i})"/>
<path d="M43 59 H57 V72 C54 75.5 46 75.5 43 72 Z" fill="#e1aa86"/>
<path d="M7 100 C9 80 25 71 42 69 L50 81 L58 69 C75 71 91 80 93 100 Z" fill="url(#ct${i})"/>
<path d="M42 69 L50 84 L58 69 L55.2 68 L50 77.5 L44.8 68 Z" fill="#14a394"/>
<path d="M42 69 L47.5 91 L39 100 M58 69 L52.5 91 L61 100" stroke="#a9c1c6" stroke-width="1.5" fill="none"/>
<path d="M40.5 71 C37 84 42 92.5 50 93.5 C58 92.5 63 84 59.5 71" stroke="#33454c" stroke-width="2.2" fill="none"/>
<circle cx="50" cy="93.5" r="3.1" fill="#8ea6ac" stroke="#33454c" stroke-width="1.2"/>
<rect x="64" y="82" width="12.5" height="8.5" rx="1.6" fill="#14a394"/><path d="M70.25 83.6 V88.9 M67.6 86.25 H72.9" stroke="#fff" stroke-width="1.5"/>
<ellipse cx="35.6" cy="47.5" rx="2.5" ry="4" fill="#e3ae8c"/><ellipse cx="64.4" cy="47.5" rx="2.5" ry="4" fill="#e3ae8c"/>
<ellipse cx="50" cy="45.5" rx="14.5" ry="17.5" fill="url(#sk${i})"/>
<path d="M35.4 42.5 C36 30 43 26.5 50.5 26.5 C58 26.5 64.6 31 64.6 41.5 C60 35.5 55 34 49 34 C44 34 39 37 35.4 42.5 Z" fill="url(#hr${i})"/>
<path d="M41 40.8 Q44.5 39.3 47.6 40.8 M52.4 40.8 Q55.5 39.3 59 40.8" stroke="#9a6f3e" stroke-width="1.4" fill="none" stroke-linecap="round"/>
${eyes(46.2)}
<rect x="39.4" y="42.6" width="9.8" height="7.2" rx="2.6" fill="#c8f1f6" fill-opacity=".16" stroke="#27373e" stroke-width="1.25"/>
<rect x="50.8" y="42.6" width="9.8" height="7.2" rx="2.6" fill="#c8f1f6" fill-opacity=".16" stroke="#27373e" stroke-width="1.25"/>
<path d="M49.2 45.2 H50.8" stroke="#27373e" stroke-width="1.25"/>
<path d="M50 48.5 Q48.5 53.2 50.7 53.8" stroke="#cd9573" stroke-width="1.2" fill="none" stroke-linecap="round"/>
<path d="M46.2 57.2 Q50 59.6 53.8 57.2" stroke="#b5645a" stroke-width="1.6" fill="none" stroke-linecap="round"/>`);
}

function paramedic(i: string): string {
  return wrap(`<defs>${bg(i, '#1d4c3e', '#04110d')}${lin(`sk${i}`, '#e8b996', '#d29d78')}${lin(`jk${i}`, '#2c5546', '#173329')}</defs>
<rect width="100" height="100" fill="url(#bg${i})"/>${grid('#9dffcf', 0.06)}
<path d="M43 60 H57 V73 C54 76 46 76 43 73 Z" fill="#c98f6c"/>
<path d="M6 100 C8 81 24 72 42 70 L50 76 L58 70 C76 72 92 81 94 100 Z" fill="url(#jk${i})"/>
<path d="M14 84 C20 76 30 72 42 70 L46 74 C34 76 24 80 18 88 Z M86 84 C80 76 70 72 58 70 L54 74 C66 76 76 80 82 88 Z" fill="#cfe94a"/>
<path d="M9.5 93 C30 88 70 88 90.5 93" stroke="#d9e2e6" stroke-width="3" fill="none"/>
<path d="M40 70 L44.5 76.5 L50 74 L55.5 76.5 L60 70" stroke="#10241d" stroke-width="1.6" fill="none"/>
<circle cx="72" cy="83" r="4.6" fill="#14a394"/><path d="M72 80.4 V85.6 M69.4 83 H74.6" stroke="#fff" stroke-width="1.5"/>
<ellipse cx="35.4" cy="47" rx="2.6" ry="4.2" fill="#d6a07b"/><ellipse cx="64.6" cy="47" rx="2.6" ry="4.2" fill="#d6a07b"/>
<path d="M35.6 44 C35.6 30.5 42 25 50 25 C58 25 64.4 30.5 64.4 44 C64.4 55.5 58 63.5 50 63.5 C42 63.5 35.6 55.5 35.6 44 Z" fill="url(#sk${i})"/>
<path d="M38 50 C40 58.5 45 63.5 50 63.5 C55 63.5 60 58.5 62 50 C60 55.5 56 58.5 50 58.5 C44 58.5 40 55.5 38 50 Z" fill="#3a2a1f" fill-opacity=".22"/>
<path d="M35.4 42.5 C34 29 41 22.5 50 22.5 C59 22.5 66 28 64.6 42.5 C63.5 36 60 32 55 31 C50 30 44 31 40.5 33.5 C38 35.5 36.4 38.6 35.4 42.5 Z" fill="#3a2a1f"/>
<path d="M40.8 40.6 L47.6 40 M52.4 40 L59.2 40.6" stroke="#2c1f17" stroke-width="2" stroke-linecap="round"/>
${eyes(45.6, '#1f2a30')}
<path d="M50 47.5 Q48.4 52.8 50.8 53.4" stroke="#b9845f" stroke-width="1.3" fill="none" stroke-linecap="round"/>
<path d="M46 57.4 H54" stroke="#9c5d50" stroke-width="1.6" stroke-linecap="round"/>
<path d="M33.6 41 C33.6 31 40.5 24 50 24 C59.5 24 66.4 31 66.4 41" stroke="#1b2328" stroke-width="2" fill="none"/>
<rect x="31" y="42.5" width="5.5" height="9" rx="2.4" fill="#1b2328"/>
<path d="M34.5 51 C36 57.5 40.5 60.5 45 60.8" stroke="#1b2328" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="45.6" cy="60.8" r="1.6" fill="#1b2328"/>`);
}

function engineer(i: string): string {
  return wrap(`<defs>${bg(i, '#1b4466', '#050d16')}${lin(`sk${i}`, '#f5d2b8', '#e2ad8c')}${lin(`ht${i}`, '#ffffff', '#cdd6da')}</defs>
<rect width="100" height="100" fill="url(#bg${i})"/>${grid('#8fd3ff', 0.09)}
<path d="M61 52 C68 58 70 68 66 78 C64 70 61 64 57 60 Z" fill="#a5452e"/>
<path d="M43 60 H57 V72 C54 75.5 46 75.5 43 72 Z" fill="#dca283"/>
<path d="M7 100 C9 81 25 72 42 70 L50 79 L58 70 C75 72 91 81 93 100 Z" fill="#29323a"/>
<path d="M18 100 C19 86 27 76 40 71 L45 100 Z M82 100 C81 86 73 76 60 71 L55 100 Z" fill="#ff8a2a"/>
<path d="M21.5 88 L43 85 M78.5 88 L57 85 M20 96 L44 94 M80 96 L56 94" stroke="#eef3f5" stroke-width="2.6"/>
<ellipse cx="36" cy="49" rx="2.4" ry="3.8" fill="#dfa888"/><ellipse cx="64" cy="49" rx="2.4" ry="3.8" fill="#dfa888"/>
<ellipse cx="50" cy="49.5" rx="14" ry="15.6" fill="url(#sk${i})"/>
<path d="M36.2 46 C36 40 38 37 41 36 L59 36 C62 37 64 40 63.8 46 C61.5 41.5 57 40 50 40 C43 40 38.5 41.5 36.2 46 Z" fill="#a5452e"/>
<path d="M41.6 44.6 Q45 43.4 47.8 44.6 M52.2 44.6 Q55 43.4 58.4 44.6" stroke="#8a3a27" stroke-width="1.3" fill="none" stroke-linecap="round"/>
${eyes(49.4)}
<circle cx="42" cy="53.6" r=".6" fill="#c47e60" fill-opacity=".8"/><circle cx="44.2" cy="54.6" r=".55" fill="#c47e60" fill-opacity=".8"/><circle cx="57.8" cy="53.6" r=".6" fill="#c47e60" fill-opacity=".8"/><circle cx="55.8" cy="54.6" r=".55" fill="#c47e60" fill-opacity=".8"/>
<path d="M50 51.6 Q48.6 56 50.6 56.5" stroke="#c98c6c" stroke-width="1.2" fill="none" stroke-linecap="round"/>
<path d="M45.8 59.4 Q50 62.4 54.2 59.4" stroke="#b05f54" stroke-width="1.6" fill="none" stroke-linecap="round"/>
<path d="M33.5 39 C33.5 25.5 41 18.5 50 18.5 C59 18.5 66.5 25.5 66.5 39 Z" fill="url(#ht${i})"/>
<path d="M48.3 19 H51.7 V39 H48.3 Z" fill="#20b5a7"/>
<path d="M29.5 39.2 H70.5 C70.5 41.8 69 43 66.8 43 H33.2 C31 43 29.5 41.8 29.5 39.2 Z" fill="#e6ecef"/>`);
}

function nurse(i: string): string {
  return wrap(`<defs>${bg(i, '#1a5560', '#041317')}${lin(`sk${i}`, '#e9bfa0', '#d3a07f')}</defs>
<rect width="100" height="100" fill="url(#bg${i})"/>${grid('#7ff5e6')}
<path d="M31 54 C29 36 37 24 50 24 C63 24 71 36 69 54 C67 62 63 66 60 67 L40 67 C37 66 33 62 31 54 Z" fill="#2e211c"/>
<path d="M43 60 H57 V72 C54 75.5 46 75.5 43 72 Z" fill="#c99273"/>
<path d="M7 100 C9 81 25 72 42 70 L50 82 L58 70 C75 72 91 81 93 100 Z" fill="#1aa999"/>
<path d="M42 70 L50 82 L58 70" stroke="#0f7c71" stroke-width="2" fill="none"/>
<path d="M36 72 L44 96 M64 72 L56 96" stroke="#e8f4f6" stroke-width="1.2" fill="none"/><rect x="40" y="92" width="9" height="7" rx="1.2" fill="#f1f6f7"/>
<ellipse cx="35.8" cy="47" rx="2.4" ry="3.9" fill="#d29e7e"/><ellipse cx="64.2" cy="47" rx="2.4" ry="3.9" fill="#d29e7e"/>
<ellipse cx="50" cy="46" rx="14" ry="17" fill="url(#sk${i})"/>
<path d="M36 44 C36 32 42 28 50 28 C58 28 64 32 64 44 C60 37 56 35 50 35 C44.5 35 39.5 37.5 36 44 Z" fill="#2e211c"/>
<path d="M41.6 41.4 Q45 40 47.8 41.4 M52.2 41.4 Q55 40 58.4 41.4" stroke="#24160f" stroke-width="1.3" fill="none" stroke-linecap="round"/>
${eyes(46)}
<path d="M50 48 Q48.6 52.5 50.6 53" stroke="#bf8b6b" stroke-width="1.2" fill="none" stroke-linecap="round"/>
<path d="M46.4 56.6 Q50 58.8 53.6 56.6" stroke="#a85b52" stroke-width="1.5" fill="none" stroke-linecap="round"/>
<path d="M38.5 61.5 C43 65.5 57 65.5 61.5 61.5 L60 69 C55 71.5 45 71.5 40 69 Z" fill="#bfe6f2"/><path d="M38.5 61.5 L35.8 49 M61.5 61.5 L64.2 49" stroke="#e8f6fb" stroke-width="1"/>`);
}

function sisu(i: string): string {
  const ticks = Array.from({ length: 24 }, (_, k) => {
    const a = (k / 24) * Math.PI * 2, r0 = k % 6 === 0 ? 36 : 38.5, r1 = 41;
    return `M${(50 + Math.cos(a) * r0).toFixed(1)} ${(50 + Math.sin(a) * r0).toFixed(1)} L${(50 + Math.cos(a) * r1).toFixed(1)} ${(50 + Math.sin(a) * r1).toFixed(1)}`;
  }).join(' ');
  return wrap(`<defs>${bg(i, '#0f3a48', '#02080c')}<radialGradient id="core${i}" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="#9ffcef"/><stop offset=".7" stop-color="#2fd6c6" stop-opacity=".55"/><stop offset="1" stop-color="#2fd6c6" stop-opacity="0"/></radialGradient></defs>
<rect width="100" height="100" fill="url(#bg${i})"/>${grid('#7ff5e6', 0.08)}
<path d="${ticks}" stroke="#7ff5e6" stroke-opacity=".55" stroke-width="1.1"/>
<circle cx="50" cy="50" r="30" fill="none" stroke="#35e2d0" stroke-width="4.5" stroke-dasharray="11 4.7" stroke-opacity=".9"><animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="14s" repeatCount="indefinite"/></circle>
<circle cx="50" cy="50" r="22" fill="none" stroke="#a6fff3" stroke-width="1.2" stroke-opacity=".7" stroke-dasharray="2 3"><animateTransform attributeName="transform" type="rotate" from="360 50 50" to="0 50 50" dur="9s" repeatCount="indefinite"/></circle>
<circle cx="50" cy="50" r="17" fill="url(#core${i})"><animate attributeName="r" values="15;17.5;15" dur="1.1s" repeatCount="indefinite"/></circle>
<path d="M6 50 H33 L37 43 L41.5 60 L46 33 L50.5 66 L54.5 45 L57.5 50 H94" fill="none" stroke="#2fd6c6" stroke-opacity=".35" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
<path d="M6 50 H33 L37 43 L41.5 60 L46 33 L50.5 66 L54.5 45 L57.5 50 H94" fill="none" stroke="#effffc" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`);
}

function omega(i: string): string {
  let spikes = '', knobs = '';
  for (let k = 0; k < 15; k++) {
    const a = (k / 15) * Math.PI * 2 + 0.2, wob = k % 2 ? 4 : 0;
    const x0 = 50 + Math.cos(a) * 23, y0 = 52 + Math.sin(a) * 23, x1 = 50 + Math.cos(a) * (35 + wob), y1 = 52 + Math.sin(a) * (35 + wob);
    spikes += `M${x0.toFixed(1)} ${y0.toFixed(1)} L${x1.toFixed(1)} ${y1.toFixed(1)} `;
    knobs += `<circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="${k % 2 ? 2.4 : 3.2}" fill="#a8ff4f"/>`;
  }
  return wrap(`<defs>${bg(i, '#3d0b49', '#08010b')}<radialGradient id="body${i}" cx=".42" cy=".38" r=".7"><stop offset="0" stop-color="#ff86e6"/><stop offset=".55" stop-color="#8a1aa3"/><stop offset="1" stop-color="#2a0534"/></radialGradient><radialGradient id="eye${i}" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#eaff9a"/><stop offset="1" stop-color="#58a51a"/></radialGradient></defs>
<rect width="100" height="100" fill="url(#bg${i})"/>${grid('#d36bff', 0.08)}
<circle cx="50" cy="52" r="40" fill="#a8ff4f" fill-opacity=".05"/>
<path d="${spikes}" stroke="#e06bff" stroke-width="3" stroke-linecap="round"/>${knobs}
<circle cx="50" cy="52" r="24" fill="url(#body${i})"/>
<path d="M33 44 C37 36 45 32 53 32.5" stroke="#f6c9ff" stroke-opacity=".5" stroke-width="1.6" fill="none" stroke-linecap="round"/>
<ellipse cx="50" cy="53" rx="9" ry="12" fill="url(#eye${i})"><animate attributeName="ry" values="12;12;1.5;12;12" keyTimes="0;.86;.9;.94;1" dur="4.2s" repeatCount="indefinite"/></ellipse>
<ellipse cx="50" cy="53" rx="2.3" ry="9" fill="#14020f"/>
<rect x="0" y="30" width="100" height="5" fill="#d36bff" fill-opacity=".22"><animate attributeName="x" values="0;-6;4;0;0" dur="1.9s" repeatCount="indefinite"/><animate attributeName="y" values="30;62;18;74;30" dur="3.1s" repeatCount="indefinite"/></rect>
<rect x="0" y="70" width="100" height="2.5" fill="#a8ff4f" fill-opacity=".2"><animate attributeName="x" values="0;5;-3;0" dur="1.3s" repeatCount="indefinite"/><animate attributeName="y" values="70;40;84;70" dur="2.3s" repeatCount="indefinite"/></rect>`);
}

function pathogen(i: string): string {
  return wrap(`<defs>${bg(i, '#2f0d39', '#070109')}</defs>
<rect width="100" height="100" fill="url(#bg${i})"/>${grid('#d36bff', 0.07)}
<g transform="rotate(-28 40 46)"><rect x="18" y="38" width="46" height="18" rx="9" fill="#a8ff4f" fill-opacity=".22" stroke="#a8ff4f" stroke-width="2"/><circle cx="30" cy="47" r="2.6" fill="#a8ff4f"/><circle cx="44" cy="45" r="2" fill="#a8ff4f"/></g>
<g transform="rotate(18 66 66)"><rect x="50" y="59" width="34" height="14" rx="7" fill="#e06bff" fill-opacity=".22" stroke="#e06bff" stroke-width="2"/></g>
<circle cx="70" cy="30" r="11" fill="#e06bff" fill-opacity=".2" stroke="#f3c4ff" stroke-width="1.8"/>
<path d="M70 15 V19 M70 41 V45 M55 30 H59 M81 30 H85 M59.4 19.4 L62.2 22.2 M77.8 37.8 L80.6 40.6 M59.4 40.6 L62.2 37.8 M77.8 22.2 L80.6 19.4" stroke="#a8ff4f" stroke-width="2" stroke-linecap="round"/>
<circle cx="24" cy="76" r="5" fill="#a8ff4f" fill-opacity=".25"/><circle cx="16" cy="64" r="2.6" fill="#a8ff4f" fill-opacity=".35"/>`);
}

const BUILDERS: Record<PortraitId, (id: string) => string> = { cmo, sisu, paramedic, engineer, nurse, omega, pathogen };

/** Inline SVG portrait for a cast member (unknown/undefined → SISU, the default narrator). */
export function portraitSvg(id: PortraitId | undefined): string {
  const b = (id && BUILDERS[id]) || BUILDERS.sisu;
  return b(`p${(++uid).toString(36)}`);
}

/** Portrait accent colour (frame tint). */
export function portraitAccent(id: PortraitId | undefined): string {
  switch (id) {
    case 'omega': case 'pathogen': return '#d36bff';
    case 'engineer': return '#ff9a3c';
    case 'paramedic': return '#cfe94a';
    default: return '#35e2d0';
  }
}
