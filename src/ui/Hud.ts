/**
 * [ui] OWNER: HUD agent. In-game DOM overlay implementing GameUi: resources bar, minimap, selection panel,
 * command card (renders game.controls.getCommandCard()), notifications, dialogue, objectives, timers,
 * pause menu and end screen.
 */
import type { Vec2 } from '../core/types';
import type { DialogueLine, EndScreenResult, GameUi, NotifyKind, ObjectiveView } from '../core/ui';
import type { GameContext } from '../game/contracts';

export class Hud implements GameUi {
  private el: HTMLDivElement;
  private bar: HTMLDivElement;
  private log: HTMLDivElement;
  constructor(private root: HTMLElement, private game: GameContext) {
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:absolute;inset:0;pointer-events:none;font:14px system-ui;color:#e6f4f1';
    this.bar = document.createElement('div');
    this.bar.style.cssText = 'position:absolute;top:8px;right:12px;padding:6px 10px;background:rgba(0,20,30,.7);border-radius:6px';
    this.log = document.createElement('div');
    this.log.style.cssText = 'position:absolute;left:12px;bottom:12px;max-width:40%;';
    this.el.append(this.bar, this.log);
    this.root.appendChild(this.el);
  }
  showDialogue(line: DialogueLine): void { this.notify(`${line.speaker}: ${line.text}`); }
  setObjectives(_objs: ObjectiveView[]): void {}
  notify(text: string, _kind: NotifyKind = 'info'): void {
    const d = document.createElement('div'); d.textContent = text; d.style.cssText = 'background:rgba(0,20,30,.7);margin-top:4px;padding:4px 8px;border-radius:4px';
    this.log.appendChild(d); setTimeout(() => d.remove(), 6000);
  }
  setMissionTimer(_label: string | null, _seconds?: number): void {}
  pingMinimap(_pos: Vec2, _color?: number): void {}
  showEndScreen(result: EndScreenResult): void { this.notify(`${result.title} — ${result.subtitle ?? ''}`); }
  openPauseMenu(): void { this.game.paused ? this.game.resume() : this.game.pause(); }
  update(_dtReal: number): void {
    const p = this.game.world.player(this.game.localPlayerId);
    this.bar.textContent = `Supplies ${Math.floor(p.resources.matter)}   Power ${Math.floor(p.resources.energy)}   Beds ${p.popUsed}/${p.popCap}`;
  }
  dispose(): void { this.el.remove(); }
}
