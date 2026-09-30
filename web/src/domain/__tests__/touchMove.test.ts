import { describe, expect, it } from "vitest";
import {
  hasArrived,
  joystickVector,
  screenToWorld,
  stepToward,
} from "../touchMove";
import { worldToScreen, type CameraViewport } from "../camera";

const RADIUS = 56; // 112px diameter / 2
const DEAD_ZONE = 8; // §2 spec
const TRAVEL = RADIUS - DEAD_ZONE; // 48

describe("joystickVector", () => {
  it("returns {0,0} for zero offset", () => {
    expect(joystickVector(0, 0, RADIUS, DEAD_ZONE)).toEqual({ x: 0, y: 0 });
  });

  it("returns {0,0} inside the dead zone", () => {
    expect(joystickVector(5, 0, RADIUS, DEAD_ZONE)).toEqual({ x: 0, y: 0 });
    expect(joystickVector(0, -7, RADIUS, DEAD_ZONE)).toEqual({ x: 0, y: 0 });
    expect(joystickVector(4, 4, RADIUS, DEAD_ZONE)).toEqual({ x: 0, y: 0 }); // |off| ≈ 5.66 < 8
  });

  it("emits a proportional vector just outside the dead zone", () => {
    const v = joystickVector(DEAD_ZONE, 0, RADIUS, DEAD_ZONE);
    expect(v.x).toBeCloseTo(DEAD_ZONE / TRAVEL, 10);
    expect(v.y).toBeCloseTo(0, 10);
  });

  it("clamps large offsets to the unit circle, preserving direction", () => {
    const v = joystickVector(200, 0, RADIUS, DEAD_ZONE);
    expect(v.x).toBeCloseTo(1, 10);
    expect(v.y).toBeCloseTo(0, 10);

    const d = joystickVector(100, 100, RADIUS, DEAD_ZONE);
    const invSqrt2 = 1 / Math.sqrt(2);
    expect(d.x).toBeCloseTo(invSqrt2, 10);
    expect(d.y).toBeCloseTo(invSqrt2, 10);
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 10);
  });

  it("treats y as down-positive", () => {
    const down = joystickVector(0, 20, RADIUS, DEAD_ZONE);
    const up = joystickVector(0, -20, RADIUS, DEAD_ZONE);
    expect(down.y).toBeGreaterThan(0);
    expect(up.y).toBeLessThan(0);
    expect(down.y).toBeCloseTo(-up.y, 10);
  });

  it("returns {0,0} for degenerate geometry (radius <= dead zone)", () => {
    expect(joystickVector(10, 10, 8, 8)).toEqual({ x: 0, y: 0 });
    expect(joystickVector(10, 10, 4, 8)).toEqual({ x: 0, y: 0 });
  });
});

describe("hasArrived", () => {
  it("is true for identical points", () => {
    expect(hasArrived({ x: 10, y: 20 }, { x: 10, y: 20 })).toBe(true);
  });

  it("uses a strict < epsilon threshold (spec: distance < 6px)", () => {
    expect(hasArrived({ x: 0, y: 0 }, { x: 5.99, y: 0 })).toBe(true);
    expect(hasArrived({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(false);
    expect(hasArrived({ x: 0, y: 0 }, { x: 6.01, y: 0 })).toBe(false);
  });

  it("honors a custom epsilon", () => {
    expect(hasArrived({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toBe(false); // dist = 5
    expect(hasArrived({ x: 0, y: 0 }, { x: 3, y: 4 }, 5.1)).toBe(true);
  });
});

describe("stepToward", () => {
  it("never overshoots: snaps exactly to a nearer target", () => {
    expect(stepToward({ x: 0, y: 0 }, { x: 3, y: 4 }, 10)).toEqual({
      x: 3,
      y: 4,
    });
  });

  it("advances exactly maxStep along the line", () => {
    const p = stepToward({ x: 0, y: 0 }, { x: 3, y: 4 }, 2.5);
    expect(p.x).toBeCloseTo(1.5, 10);
    expect(p.y).toBeCloseTo(2, 10);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(2.5, 10);
  });

  it("stays put when already at the target", () => {
    expect(stepToward({ x: 7, y: 7 }, { x: 7, y: 7 }, 5)).toEqual({
      x: 7,
      y: 7,
    });
  });

  it("stays put when maxStep is 0", () => {
    expect(stepToward({ x: 0, y: 0 }, { x: 10, y: 0 }, 0)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("screenToWorld", () => {
  const camera: CameraViewport = {
    scale: 2,
    offsetX: 10,
    offsetY: -5,
    viewportW: 800,
    viewportH: 600,
  };

  it("is the inverse of worldToScreen from camera.ts", () => {
    const screen = worldToScreen(100, 200, camera);
    const world = screenToWorld(screen.x, screen.y, camera);
    expect(world.x).toBeCloseTo(100, 10);
    expect(world.y).toBeCloseTo(200, 10);
  });

  it("applies the documented formula screen = world * scale + offset", () => {
    const world = screenToWorld(210, 395, camera);
    expect(world.x).toBeCloseTo((210 - 10) / 2, 10);
    expect(world.y).toBeCloseTo((395 - -5) / 2, 10);
  });
});
