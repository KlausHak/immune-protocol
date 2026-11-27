/** [ui] OWNER: HUD agent. Icon lookup for command-card buttons and portraits. Returns an HTML string (inline SVG or <img>). */
export function iconHtml(key: string): string {
  const letter = key.split(/[._]/).pop()?.[0]?.toUpperCase() ?? '?';
  return `<svg viewBox="0 0 32 32" width="100%" height="100%"><rect width="32" height="32" rx="4" fill="#123"/><text x="16" y="22" font-size="16" text-anchor="middle" fill="#7ff5e6">${letter}</text></svg>`;
}
