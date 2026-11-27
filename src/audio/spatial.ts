/**
 * [audio] Pure spatialisation math (Node-testable): stereo pan + distance attenuation of a world-space
 * sound relative to the camera target. The "listener" is the point the RTS camera looks at; its right
 * vector follows the camera yaw so a sound on the right of the screen pans right even when rotated.
 */
import type { Vec2 } from '../core/types';
import { clamp } from './dsp';

export interface Listener {
  /** camera ground target (sim coords) */
  x: number;
  y: number;
  /** unit vector pointing to the screen's right, in sim coords */
  rx: number;
  ry: number;
  /** camera distance / default distance (1 = default zoom; > 1 zoomed out) */
  zoom: number;
}

export const DEFAULT_LISTENER: Readonly<Listener> = { x: 0, y: 0, rx: 1, ry: 0, zoom: 1 };

/** Full volume inside this radius (world units at default zoom). */
export const INNER_RADIUS = 9;
/** Silent beyond this radius (world units at default zoom). */
export const OUTER_RADIUS = 48;
/** Lateral distance (world units at default zoom) that maps to a hard pan. */
export const PAN_HALF_WIDTH = 17;

export interface Spatial { gain: number; pan: number; distance: number }

export function spatialize(l: Listener, p: Vec2): Spatial {
  const dx = p.x - l.x, dy = p.y - l.y;
  const d = Math.hypot(dx, dy);
  const z = clamp(l.zoom, 0.3, 3);
  const inner = INNER_RADIUS * z, outer = OUTER_RADIUS * z;
  let g = d <= inner ? 1 : d >= outer ? 0 : 1 - (d - inner) / (outer - inner);
  g *= g; // perceptually smoother roll-off than linear
  // zoomed in → a little louder, zoomed out → a little quieter overall
  const zoomGain = clamp(1 / (0.55 + 0.45 * z), 0.6, 1.2);
  const side = dx * l.rx + dy * l.ry;
  const pan = clamp(side / (PAN_HALF_WIDTH * z), -1, 1) * 0.85;
  return { gain: g * zoomGain, pan, distance: d };
}

/** Pan for a direction vector (e.g. towards the sea) relative to the listener's right vector. */
export function panForDirection(l: Listener, dx: number, dy: number): number {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return 0;
  return clamp((dx * l.rx + dy * l.ry) / len, -1, 1) * 0.8;
}
