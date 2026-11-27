/**
 * [input] OWNER: controls agent. Mouse/keyboard → selection & commands. Builds the command card model
 * (CommandButton[]) the HUD renders. Camera movement keys (arrows/edge/wheel) belong to the render-core camera.
 */
import type { Entity, EntityId } from '../core/types';
import type { CommandButton, ControlMode, GameContext, SelectionApi } from '../game/contracts';

class Selection implements SelectionApi {
  ids: EntityId[] = [];
  private listeners = new Set<(ids: readonly EntityId[]) => void>();
  constructor(private game: GameContext) {}
  set(ids: EntityId[]): void { this.ids = [...new Set(ids)]; this.emit(); }
  add(ids: EntityId[]): void { this.set([...this.ids, ...ids]); }
  remove(ids: EntityId[]): void { const r = new Set(ids); this.set(this.ids.filter((i) => !r.has(i))); }
  clear(): void { this.set([]); }
  primary(): Entity | undefined { return this.entities()[0]; }
  entities(): Entity[] { return this.ids.map((id) => this.game.world.getAlive(id)).filter((e): e is Entity => !!e); }
  onChange(fn: (ids: readonly EntityId[]) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { this.game.renderer.setSelection(this.ids); for (const fn of this.listeners) fn(this.ids); }
}

export class Controls {
  readonly selection: SelectionApi;
  mode: ControlMode = 'normal';
  private canvas: HTMLCanvasElement;
  constructor(private game: GameContext) {
    this.selection = new Selection(game);
    this.canvas = game.renderer.three.domElement;
    this.canvas.addEventListener('mousedown', this.onDown);
    this.canvas.addEventListener('contextmenu', this.onContext);
  }
  private onContext = (e: MouseEvent) => e.preventDefault();
  private onDown = (e: MouseEvent) => {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const g = this.game;
    if (e.button === 0) {
      const hit = g.renderer.pickEntity(sx, sy);
      this.selection.set(hit ? [hit.id] : []);
    } else if (e.button === 2) {
      const ground = g.renderer.screenToGround(sx, sy);
      const hit = g.renderer.pickEntity(sx, sy);
      const units = this.selection.entities().filter((u) => u.owner === g.localPlayerId && u.kind === 'unit').map((u) => u.id);
      if (ground && units.length) {
        g.issue({ type: 'smart', playerId: g.localPlayerId, unitIds: units, target: ground, targetId: hit?.id, queue: e.shiftKey });
        g.renderer.showCommandMarker(ground, hit && g.world.isEnemy(g.localPlayerId, hit.owner) ? 'attack' : 'move');
      }
    }
  };
  getCommandCard(): CommandButton[] { return []; }
  update(_dtReal: number): void {}
  dispose(): void {
    this.canvas.removeEventListener('mousedown', this.onDown);
    this.canvas.removeEventListener('contextmenu', this.onContext);
  }
}
