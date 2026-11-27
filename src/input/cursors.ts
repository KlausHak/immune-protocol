/**
 * [input] CSS cursors (inline SVG data URIs, 32×32 with hotspots) in the game's medical-tech style:
 * teal glass for neutral/move/placement, alert red for attack/invalid. Pure strings — headless-safe.
 */
export type CursorKind = 'default' | 'attack' | 'move' | 'placement' | 'invalid';

const svg = (body: string): string =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>${body}</svg>`)}")`;

const TEAL = '#6ff7e4';
const RED = '#ff4b5c';
const SHADOW = 'rgba(0,0,0,0.55)';

const ARROW = "M4 3 L4 25 L10 19.5 L14 28.5 L18 26.8 L14.2 18 L22 18 Z";
const ticks = (r0: number, r1: number) =>
  `M16 ${16 - r1} V${16 - r0} M16 ${16 + r0} V${16 + r1} M${16 - r1} 16 H${16 - r0} M${16 + r0} 16 H${16 + r1}`;

export const CURSORS: Record<CursorKind, string> = {
  default: `${svg(
    `<path d='${ARROW}' fill='${SHADOW}' transform='translate(1.2 1.2)'/>` +
    `<path d='${ARROW}' fill='rgba(10,46,52,0.92)' stroke='${TEAL}' stroke-width='1.6' stroke-linejoin='round'/>` +
    `<path d='M6.2 8 L6.2 19.5' stroke='rgba(190,255,247,0.55)' stroke-width='1.2' stroke-linecap='round'/>`,
  )} 4 3, default`,
  attack: `${svg(
    `<circle cx='16' cy='16' r='9' fill='none' stroke='${SHADOW}' stroke-width='4'/>` +
    `<path d='${ticks(5, 14)}' stroke='${SHADOW}' stroke-width='4' stroke-linecap='round'/>` +
    `<circle cx='16' cy='16' r='9' fill='none' stroke='${RED}' stroke-width='2'/>` +
    `<path d='${ticks(5, 14)}' stroke='${RED}' stroke-width='2' stroke-linecap='round'/>` +
    `<circle cx='16' cy='16' r='1.6' fill='${RED}'/>`,
  )} 16 16, crosshair`,
  move: `${svg(
    `<circle cx='16' cy='16' r='8' fill='none' stroke='${SHADOW}' stroke-width='4'/>` +
    `<circle cx='16' cy='16' r='8' fill='rgba(47,214,198,0.12)' stroke='${TEAL}' stroke-width='2'/>` +
    `<path d='${ticks(10, 14)}' stroke='${TEAL}' stroke-width='2' stroke-linecap='round'/>` +
    `<circle cx='16' cy='16' r='2.4' fill='${TEAL}'/>`,
  )} 16 16, crosshair`,
  placement: `${svg(
    `<rect x='5' y='5' width='22' height='22' rx='3' fill='none' stroke='${SHADOW}' stroke-width='4'/>` +
    `<rect x='5' y='5' width='22' height='22' rx='3' fill='rgba(47,214,198,0.14)' stroke='${TEAL}' stroke-width='2' stroke-dasharray='5 3'/>` +
    `<path d='M16 10 V22 M10 16 H22' stroke='${TEAL}' stroke-width='2.4' stroke-linecap='round'/>`,
  )} 16 16, copy`,
  invalid: `${svg(
    `<circle cx='16' cy='16' r='10' fill='none' stroke='${SHADOW}' stroke-width='5'/>` +
    `<circle cx='16' cy='16' r='10' fill='rgba(255,75,92,0.12)' stroke='${RED}' stroke-width='2.6'/>` +
    `<path d='M9 23 L23 9' stroke='${RED}' stroke-width='2.6' stroke-linecap='round'/>`,
  )} 16 16, not-allowed`,
};
