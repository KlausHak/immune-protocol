/**
 * [ui] Formatting helpers: clocks, numbers, costs (with faction resource names/icons), friendly messages.
 */
import type { Cost, FactionId, NotEnoughKind } from '../core/types';
import { BUILDING_DEFS, FACTIONS } from '../data';
import { esc } from './dom';
import { glyphHtml, resourceGlyphKey } from './icons';

/** 75 → "1:15", 3725 → "1:02:05". */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const two = (n: number) => (n < 10 ? `0${n}` : String(n));
  return h > 0 ? `${h}:${two(m)}:${two(ss)}` : `${two(m)}:${two(ss)}`;
}

/** Integer with thin thousands separators. */
export function fmtInt(n: number): string {
  const v = Math.floor(n);
  return Math.abs(v) < 10000 ? String(v) : v.toLocaleString('en-US').replace(/,/g, ' ');
}

/** Up to one decimal, dropping a trailing ".0". */
export function fmt1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export function resourceName(faction: FactionId, kind: 'matter' | 'energy'): string {
  return FACTIONS[faction].resourceNames[kind];
}

/** Cost row (HTML) with faction-named resource glyphs — used in tooltips and the build/queue panels. */
export function costHtml(cost: (Cost & { pop?: number }) | undefined, faction: FactionId, time?: number): string {
  const parts: string[] = [];
  const f = FACTIONS[faction] ?? FACTIONS.hospital;
  if (cost?.matter) parts.push(`<span class="ip-cost ip-cost-m" title="${esc(f.resourceNames.matter)}">${glyphHtml(resourceGlyphKey(faction, 'matter'))}${Math.round(cost.matter)}</span>`);
  if (cost?.energy) parts.push(`<span class="ip-cost ip-cost-e" title="${esc(f.resourceNames.energy)}">${glyphHtml(resourceGlyphKey(faction, 'energy'))}${Math.round(cost.energy)}</span>`);
  if (cost?.pop) parts.push(`<span class="ip-cost ip-cost-p" title="${esc(f.popName)}">${glyphHtml(resourceGlyphKey(faction, 'pop'))}${cost.pop}</span>`);
  if (time) parts.push(`<span class="ip-cost ip-cost-t" title="Time">${glyphHtml('ui.time')}${fmt1(time)}s</span>`);
  return parts.join('');
}

/** The faction's "+pop" building name, for supply-block hints ("build a Patient Ward"). */
export function popBuildingName(faction: FactionId): string {
  const b = Object.values(BUILDING_DEFS).find((d) => d.faction === faction && !d.hq && (d.provides.pop ?? 0) > 0);
  return b?.name ?? 'more housing';
}

/**
 * Player-facing text for a notEnough event. The sim speaks in faction-neutral keys ("matter"); the HUD
 * speaks the local faction's language ("Supplies").
 */
export function notEnoughText(kind: NotEnoughKind, message: string, faction: FactionId): string {
  const f = FACTIONS[faction] ?? FACTIONS.hospital;
  switch (kind) {
    case 'matter': return `Not enough ${f.resourceNames.matter}`;
    case 'energy': return `Not enough ${f.resourceNames.energy}`;
    case 'pop': {
      // Prefer the economy's own wording (e.g. "Beds limit reached (150)"); fall back to a build hint.
      const m = (message || '').trim();
      if (m && !/^not enough (pop|population|capacity|supply)$/i.test(m)) return m;
      return `Not enough ${f.popName} — build a ${popBuildingName(faction)}`;
    }
    default: {
      const m = (message || '').trim();
      if (!m) return kind === 'placement' ? "Can't build there" : kind === 'queueFull' ? 'Queue is full' : kind === 'cooldown' ? 'Not ready yet' : 'Cannot do that';
      return m
        .replace(/\bmatter\b/gi, f.resourceNames.matter)
        .replace(/\benergy\b/gi, f.resourceNames.energy)
        .replace(/\b(capacity|supply|population|pop)\b/gi, f.popName);
    }
  }
}
