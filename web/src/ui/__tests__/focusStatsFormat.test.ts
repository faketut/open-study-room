// M3 T10 — unit tests for the focus stats formatting helpers
// (web/src/ui/focusStatsFormat.ts). Pure functions; no DOM needed.

import { describe, expect, it } from "vitest";
import {
  barHeights,
  formatBarDayLabel,
  formatDuration,
} from "../focusStatsFormat";

describe("formatDuration", () => {
  it("formats minutes under an hour", () => {
    expect(formatDuration(1500)).toBe("25m");
    expect(formatDuration(59)).toBe("0m");
    expect(formatDuration(60)).toBe("1m");
  });

  it("formats hours without trailing zero minutes", () => {
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(7200)).toBe("2h");
  });

  it("formats hours with leftover minutes", () => {
    expect(formatDuration(3661)).toBe("1h 1m");
    expect(formatDuration(2 * 3600 + 15 * 60)).toBe("2h 15m");
  });

  it("rounds down and clamps negatives", () => {
    expect(formatDuration(90.9)).toBe("1m");
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(-100)).toBe("0m");
  });
});

describe("formatBarDayLabel", () => {
  it("shortens YYYY-MM-DD to M/D", () => {
    expect(formatBarDayLabel("2026-09-29")).toBe("9/29");
    expect(formatBarDayLabel("2026-01-05")).toBe("1/5");
  });

  it("passes through unexpected shapes", () => {
    expect(formatBarDayLabel("today")).toBe("today");
    expect(formatBarDayLabel("")).toBe("");
  });
});

describe("barHeights", () => {
  it("scales relative to the tallest bar", () => {
    expect(barHeights([3600, 1800, 0])).toEqual([100, 50, 2]);
  });

  it("returns all zeros when nothing was focused", () => {
    expect(barHeights([0, 0, 0])).toEqual([0, 0, 0]);
    expect(barHeights([])).toEqual([]);
  });

  it("gives tiny-but-nonzero days a visible floor", () => {
    expect(barHeights([3600, 30])).toEqual([100, 2]);
  });
});
