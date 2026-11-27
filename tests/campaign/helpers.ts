/** Shared helpers for campaign tests (not a test file itself). */
import type { Vec2 } from '../../src/core/types';
import type { CameraApi, DialogueLine, EndScreenResult, GameUi, NotifyKind, ObjectiveView } from '../../src/core/ui';
import { listMaps } from '../../src/map';
import type { World } from '../../src/sim/World';

/** GameUi double that records every call. */
export class RecordingUi implements GameUi {
  dialogue: DialogueLine[] = [];
  objectives: ObjectiveView[][] = [];
  notes: Array<{ text: string; kind?: NotifyKind }> = [];
  timers: Array<{ label: string | null; seconds?: number }> = [];
  pings: Vec2[] = [];
  ends: EndScreenResult[] = [];
  showDialogue(line: DialogueLine): void { this.dialogue.push(line); }
  setObjectives(objs: ObjectiveView[]): void { this.objectives.push(objs.map((o) => ({ ...o }))); }
  notify(text: string, kind?: NotifyKind): void { this.notes.push({ text, kind }); }
  setMissionTimer(label: string | null, seconds?: number): void { this.timers.push({ label, seconds }); }
  pingMinimap(pos: Vec2): void { this.pings.push({ ...pos }); }
  showEndScreen(result: EndScreenResult): void { this.ends.push(result); }
  openPauseMenu(): void {}
  update(): void {}
  dispose(): void {}
  get lastObjectives(): ObjectiveView[] { return this.objectives[this.objectives.length - 1] ?? []; }
}

/** CameraApi double that records cues. */
export class RecordingCamera implements CameraApi {
  target: Vec2 = { x: 0, y: 0 };
  cues: Array<{ kind: 'lookAt' | 'panTo' | 'shake'; p?: Vec2 }> = [];
  lookAt(p: Vec2): void { this.target = { ...p }; this.cues.push({ kind: 'lookAt', p: { ...p } }); }
  panTo(p: Vec2): void { this.target = { ...p }; this.cues.push({ kind: 'panTo', p: { ...p } }); }
  getTarget(): Vec2 { return { ...this.target }; }
  getViewPolygon(): Vec2[] { return [this.target, this.target, this.target, this.target]; }
  shake(): void { this.cues.push({ kind: 'shake' }); }
}

export const hasMeilahti = (): boolean => listMaps().some((m) => m.id === 'meilahti');

/** Kill every alive entity matching the filter (as if destroyed in combat). */
export function killAll(world: World, filter: (e: World['list'][number]) => boolean): number {
  let n = 0;
  for (const e of [...world.list]) if (e.alive && filter(e)) { world.killEntity(e, null); n++; }
  return n;
}

/** Compact, order-stable fingerprint of the simulation state (determinism checks). */
export function fingerprint(world: World): string {
  const parts: string[] = [`t=${world.tick}`];
  for (const p of world.activePlayers()) parts.push(`p${p.id}:${p.resources.matter.toFixed(3)}/${p.resources.energy.toFixed(3)}/${p.popUsed}/${p.popCap}`);
  for (const e of world.list) {
    if (!e.alive) continue;
    parts.push(`${e.id}:${e.defId}:${e.owner}:${e.pos.x.toFixed(4)},${e.pos.y.toFixed(4)}:${e.hp.toFixed(3)}:${[...e.scriptTags].join('|')}`);
  }
  return parts.join(';');
}
