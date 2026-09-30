// Touch-move helpers (MW1-1). Pure functions — no React/LiveKit dependencies.
//
// Implements §2 (virtual joystick) and the tap-to-move math of §3 of
// web/docs/touch-controls-spec.md. Collision is intentionally NOT handled
// here: the caller feeds results through applyMove (domain/mapConfig.ts) in
// the game-loop tick, which owns collision + sliding.
import type { CameraViewport } from "./camera";

/** 2D vector; in world units or screen px depending on context. */
export interface Vec2 {
  x: number;
  y: number;
}

/** World position (same shape as Vec2; named alias for readability). */
export type Point = Vec2;

/**
 * Map a raw knob offset (px from the joystick center) to a unit-bounded
 * direction vector. y is down-positive (screen coordinates), matching the
 * tick's `dy += v.y` convention.
 *
 * - Inside the dead zone (|offset| < deadZonePx) → {0, 0}.
 * - Otherwise v = offset / (radiusPx − deadZonePx), clamped to the unit
 *   circle (|v| > 1 → v / |v|), per the spec's `clamp(offset/(radius−deadZone))`.
 */
export function joystickVector(
  offsetX: number,
  offsetY: number,
  radiusPx: number,
  deadZonePx: number,
): Vec2 {
  const travel = radiusPx - deadZonePx;
  if (travel <= 0) return { x: 0, y: 0 };
  const dist = Math.hypot(offsetX, offsetY);
  if (dist < deadZonePx) return { x: 0, y: 0 };
  let x = offsetX / travel;
  let y = offsetY / travel;
  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  return { x, y };
}

/** True when cur is strictly within epsilon (world units) of target. */
export function hasArrived(cur: Point, target: Point, epsilon = 6): boolean {
  const dx = target.x - cur.x;
  const dy = target.y - cur.y;
  return dx * dx + dy * dy < epsilon * epsilon;
}

/**
 * Advance from cur toward target by at most maxStep (world units) along the
 * straight line. Never overshoots: if the target is closer than maxStep,
 * returns the target exactly. No collision handling — the caller's
 * applyMove owns that (it may slide/stop, which tap-to-move treats as
 * "blocked" after 10 near-zero frames).
 */
export function stepToward(cur: Point, target: Point, maxStep: number): Point {
  const dx = target.x - cur.x;
  const dy = target.y - cur.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0 || dist <= maxStep) {
    return { x: target.x, y: target.y };
  }
  const t = maxStep / dist;
  return { x: cur.x + dx * t, y: cur.y + dy * t };
}

/**
 * Screen → world inverse of worldToScreen() in domain/camera.ts.
 *
 * NOTE (per the MW1-1 task): camera.ts exports only the forward transform
 * (worldToScreen); it has no inverse function, so the inverse is implemented
 * here, reusing the exported CameraViewport type.
 */
export function screenToWorld(
  sx: number,
  sy: number,
  camera: CameraViewport,
): Point {
  return {
    x: (sx - camera.offsetX) / camera.scale,
    y: (sy - camera.offsetY) / camera.scale,
  };
}
