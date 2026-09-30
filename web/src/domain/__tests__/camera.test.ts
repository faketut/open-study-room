import { describe, expect, it } from "vitest";
import { computeViewport, computeZoomedViewport } from "../camera";
import type { MapConfig } from "../../types/mapConfig";

function testMap(): MapConfig {
  return {
    name: "test",
    backgroundImage: null,
    backgroundColor: "#000",
    walkable: [],
    tables: [],
    objects: [],
    bounds: { x: 0, y: 0, width: 880, height: 640 },
  };
}

describe("computeViewport", () => {
  it("cover-scales the map into the viewport", () => {
    const vp = computeViewport(880, 640, { x: 440, y: 320 }, testMap());
    expect(vp.scale).toBeCloseTo(1, 6);
  });
});

describe("computeZoomedViewport (focus cocoon)", () => {
  it("scales the base viewport by the zoom factor", () => {
    const map = testMap();
    const base = computeViewport(880, 640, { x: 440, y: 320 }, map);
    const zoomed = computeZoomedViewport(880, 640, { x: 440, y: 320 }, map, 1.7);
    expect(zoomed.scale).toBeCloseTo(base.scale * 1.7, 6);
  });

  it("centers on the focus point", () => {
    const map = testMap();
    // Wide viewport + focus near the center so edge clamping doesn't kick in.
    const vp = computeZoomedViewport(1760, 1280, { x: 440, y: 320 }, map, 1.7);
    // Focus point maps to the viewport center.
    const sx = 440 * vp.scale + vp.offsetX;
    const sy = 320 * vp.scale + vp.offsetY;
    expect(sx).toBeCloseTo(880, 6);
    expect(sy).toBeCloseTo(640, 6);
  });

  it("clamps at map edges instead of revealing void", () => {
    const map = testMap();
    const vp = computeZoomedViewport(880, 640, { x: 10, y: 10 }, map, 1.7);
    // Top-left world corner must not map to positive screen coords
    // (that would reveal void past the edge).
    expect(0 * vp.scale + vp.offsetX).toBeLessThanOrEqual(0.001);
    expect(0 * vp.scale + vp.offsetY).toBeLessThanOrEqual(0.001);
    // Bottom-right corner must not map inside the viewport either.
    expect(880 * vp.scale + vp.offsetX).toBeGreaterThanOrEqual(880 - 0.001);
    expect(640 * vp.scale + vp.offsetY).toBeGreaterThanOrEqual(640 - 0.001);
  });

  it("zoom 1 matches the base viewport", () => {
    const map = testMap();
    const base = computeViewport(880, 640, { x: 300, y: 200 }, map);
    const zoomed = computeZoomedViewport(880, 640, { x: 300, y: 200 }, map, 1);
    expect(zoomed.scale).toBeCloseTo(base.scale, 9);
    expect(zoomed.offsetX).toBeCloseTo(base.offsetX, 9);
    expect(zoomed.offsetY).toBeCloseTo(base.offsetY, 9);
  });
});
