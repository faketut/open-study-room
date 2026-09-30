// M3 T10 — unit tests for the focus stats formatting helpers
// (web/src/ui/focusStatsFormat.ts). Pure functions; no DOM needed.

import { describe, expect, it } from "vitest";
import {
  barHeights,
  formatBarDayLabel,
  formatDurationZh,
} from "../focusStatsFormat";

describe("formatDurationZh", () => {
  it("formats minutes under an hour", () => {
    expect(formatDurationZh(1500)).toBe("25分");
    expect(formatDurationZh(59)).toBe("0分");
    expect(formatDurationZh(60)).toBe("1分");
  });

  it("formats hours without trailing zero minutes", () => {
    expect(formatDurationZh(3600)).toBe("1小时");
    expect(formatDurationZh(7200)).toBe("2小时");
  });

  it("formats hours with leftover minutes", () => {
    expect(formatDurationZh(3661)).toBe("1小时1分");
    expect(formatDurationZh(2 * 3600 + 15 * 60)).toBe("2小时15分");
  });

  it("rounds down and clamps negatives", () => {
    expect(formatDurationZh(90.9)).toBe("1分");
    expect(formatDurationZh(0)).toBe("0分");
    expect(formatDurationZh(-100)).toBe("0分");
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
