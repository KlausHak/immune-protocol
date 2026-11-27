/**
 * [ui] OWNER: HUD agent. Title screen, campaign mission select + briefing, skirmish setup, settings, credits.
 */
import { GAME_SUBTITLE, GAME_TITLE } from '../config';
import { CAMPAIGN } from '../campaign';
import type { AppApi } from '../game/contracts';

export class MainMenu {
  private el: HTMLDivElement;
  constructor(private root: HTMLElement, private app: AppApi) {
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;pointer-events:auto;background:radial-gradient(#0b2a33,#020608)';
    const h = document.createElement('h1'); h.textContent = GAME_TITLE; h.style.cssText = 'font:800 56px system-ui;letter-spacing:6px;color:#7ff5e6;margin:0';
    const s = document.createElement('div'); s.textContent = GAME_SUBTITLE; s.style.cssText = 'opacity:.8;margin-bottom:20px';
    this.el.append(h, s);
    const btn = (label: string, fn: () => void) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'width:260px;padding:10px;font:600 16px system-ui;cursor:pointer'; b.onclick = fn; this.el.appendChild(b); };
    for (const m of CAMPAIGN) btn(`${m.subtitle}: ${m.title}`, () => this.app.startGame({ mode: 'campaign', missionId: m.id, difficulty: 'normal' }));
    btn('Skirmish (Normal)', () => this.app.startGame({ mode: 'skirmish', difficulty: 'normal' }));
  }
  show(): void { if (!this.el.isConnected) this.root.appendChild(this.el); }
  hide(): void { this.el.remove(); }
  dispose(): void { this.el.remove(); }
}
