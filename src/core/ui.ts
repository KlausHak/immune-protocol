/**
 * UI-facing contracts that headless code (campaign scripts) may call. Pure TS — no DOM / three.js.
 * Implemented by the HUD (GameUi) and the render core camera (CameraApi). OWNER: architect.
 */
import type { Vec2 } from './types';

export type PortraitId = 'cmo' | 'sisu' | 'paramedic' | 'engineer' | 'nurse' | 'omega' | 'pathogen';
export interface DialogueLine {
  speaker: string;          // "Dr. Aino Virtanen, Chief Medical Officer"
  text: string;
  portrait?: PortraitId;
  /** seconds to keep on screen (default: based on text length) */
  duration?: number;
}
export type ObjectiveState = 'active' | 'done' | 'failed';
export interface ObjectiveView { id: string; text: string; state: ObjectiveState; primary: boolean; progress?: string }
export type NotifyKind = 'info' | 'warning' | 'alert' | 'success';

export interface EndScreenResult {
  victory: boolean;
  title: string;                 // "VICTORY" / "DEFEAT"
  subtitle?: string;             // mission name or reason
  stats: Array<{ label: string; you: string | number; enemy?: string | number }>;
  missionId?: string;
  nextMissionId?: string | null;
  timeSeconds: number;
}

export interface GameUi {
  /** Queue a dialogue line (portrait + speaker + text). Lines play in order. */
  showDialogue(line: DialogueLine): void;
  setObjectives(objs: ObjectiveView[]): void;
  /** Transient toast/notification. */
  notify(text: string, kind?: NotifyKind): void;
  /** Countdown/elapsed timer for missions; null hides it. */
  setMissionTimer(label: string | null, seconds?: number): void;
  pingMinimap(pos: Vec2, color?: number): void;
  showEndScreen(result: EndScreenResult): void;
  openPauseMenu(): void;
  update(dtReal: number): void;
  dispose(): void;
}

export interface CameraApi {
  lookAt(p: Vec2, immediate?: boolean): void;
  panTo(p: Vec2, seconds: number): void;
  getTarget(): Vec2;
  /** Ground-plane quad (4 points, world coords) visible on screen — for the minimap. */
  getViewPolygon(): Vec2[];
  shake(intensity: number, seconds: number): void;
}
