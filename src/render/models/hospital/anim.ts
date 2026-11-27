/** [models-hospital] Small animation helpers shared by unit and building models. */
import type * as THREE from 'three';

export const TAU = Math.PI * 2;
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeInCubic = (t: number): number => t * t * t;
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
export const smoothstep = (t: number): number => { const x = clamp01(t); return x * x * (3 - 2 * x); };

/** Frame-rate independent exponential approach. */
export function damp(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

export function wrapAngle(a: number): number {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/** Damped approach along the shortest arc. */
export function dampAngle(cur: number, target: number, rate: number, dt: number): number {
  return cur + wrapAngle(target - cur) * (1 - Math.exp(-rate * dt));
}

/** Clamp the frame dt (tab switches, first frame). */
export const safeDt = (dt: number): number => (Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0);

/** 0..1 recoil/flash envelope after an attack release. */
export function attackPulse(sinceAttack: number, window = 0.15): number {
  return Number.isFinite(sinceAttack) && sinceAttack >= 0 && sinceAttack < window ? 1 - sinceAttack / window : 0;
}

/** Infantry/biped death: topple backwards then sink. Pivot = body group origin (feet). */
export function toppleDeath(body: THREE.Object3D, death: number, sink = 0.9): void {
  const f = easeInCubic(clamp01(death * 1.8));
  body.rotation.set(0, 0, f * 1.45);
  body.position.set(-f * 0.1, -Math.max(0, death - 0.55) * sink * 2.2, 0);
}

/** Vehicle / heavy death: lurch, tilt and sink into the ground. */
export function wreckDeath(body: THREE.Object3D, death: number, depth: number): void {
  const f = easeOutCubic(clamp01(death * 2));
  body.rotation.set(f * 0.18, 0, -f * 0.12);
  body.position.set(0, -easeInCubic(clamp01((death - 0.25) / 0.75)) * depth, 0);
}

/** Cheap deterministic flicker 0..1 (welding sparks, damaged lights). */
export function flicker(time: number, seed: number): number {
  const s = Math.sin(time * 37.3 + seed * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}
