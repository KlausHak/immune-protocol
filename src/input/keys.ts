/**
 * [input] Keyboard helpers. Pure & headless-safe (works on any { key, code } object).
 */

export interface KeyLike { key: string; code?: string }

/**
 * Normalised key used to match command-card hotkeys: Latin letters upper-case ('a' / 'A' → 'A'),
 * Escape → 'Esc'. Non-Latin layouts fall back to the physical key code (KeyA → 'A').
 */
export function normalizeKey(e: KeyLike): string {
  if (e.key === 'Escape' || e.key === 'Esc') return 'Esc';
  if (e.key.length === 1 && /[a-z]/i.test(e.key)) return e.key.toUpperCase();
  if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/** Control-group digit 0–9 from a key event (uses the physical code so Shift+1 still reads as 1). */
export function groupDigit(e: KeyLike): number | null {
  const m = e.code ? /^(?:Digit|Numpad)([0-9])$/.exec(e.code) : null;
  if (m) return Number(m[1]);
  return /^[0-9]$/.test(e.key) ? Number(e.key) : null;
}

export const isSpeedUpKey = (e: KeyLike): boolean => e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
export const isSpeedDownKey = (e: KeyLike): boolean => e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract';

/** Game-speed steps for +/− (skirmish only). */
export const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

/** Next speed step above/below `cur` (clamped to the table). */
export function stepSpeed(cur: number, dir: 1 | -1): number {
  if (dir > 0) return SPEED_STEPS.find((s) => s > cur + 1e-6) ?? SPEED_STEPS[SPEED_STEPS.length - 1]!;
  for (let i = SPEED_STEPS.length - 1; i >= 0; i--) if (SPEED_STEPS[i]! < cur - 1e-6) return SPEED_STEPS[i]!;
  return SPEED_STEPS[0];
}

/** Human-readable label for a hotkey ('Esc', 'A', ...). */
export const hotkeyLabel = (k: string): string => (k === 'Escape' ? 'Esc' : k);
