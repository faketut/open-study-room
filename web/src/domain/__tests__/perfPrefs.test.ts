import { describe, expect, it } from "vitest";
import {
  autoTier,
  parsePerfTier,
  readPerfTier,
  writePerfTier,
  type PerfStorage,
  type PerfTier,
} from "../perfPrefs";

function fakeStorage(initial: Record<string, string> = {}): PerfStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
  };
}

describe("parsePerfTier", () => {
  it("accepts the three known tiers", () => {
    expect(parsePerfTier("high")).toBe("high");
    expect(parsePerfTier("balanced")).toBe("balanced");
    expect(parsePerfTier("battery")).toBe("battery");
  });
  it("defaults unknown/null to balanced", () => {
    expect(parsePerfTier(null)).toBe("balanced");
    expect(parsePerfTier("ultra")).toBe("balanced");
    expect(parsePerfTier("")).toBe("balanced");
  });
});

describe("autoTier", () => {
  it("returns balanced with no environment (SSR)", () => {
    expect(autoTier(undefined)).toBe("balanced");
    expect(autoTier()).toBe("balanced");
  });
  it("picks high when cores >= 6 and memory >= 4", () => {
    expect(autoTier({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe("high");
    expect(autoTier({ hardwareConcurrency: 6, deviceMemory: 4 })).toBe("high");
    // deviceMemory missing → default 4
    expect(autoTier({ hardwareConcurrency: 6 })).toBe("high");
  });
  it("picks balanced when below either threshold", () => {
    expect(autoTier({ hardwareConcurrency: 4, deviceMemory: 8 })).toBe(
      "balanced",
    );
    expect(autoTier({ hardwareConcurrency: 8, deviceMemory: 2 })).toBe(
      "balanced",
    );
    expect(autoTier({ hardwareConcurrency: 2 })).toBe("balanced");
  });
  it("picks battery when Save-Data is on", () => {
    expect(autoTier({ hardwareConcurrency: 8, deviceMemory: 8, saveData: true })).toBe(
      "battery",
    );
    expect(autoTier({ saveData: true })).toBe("battery");
  });
});

describe("readPerfTier / writePerfTier", () => {
  it("returns the stored value when present", () => {
    const s = fakeStorage({ "syncle.perf": "battery" });
    expect(readPerfTier(s, { hardwareConcurrency: 16 })).toBe("battery");
  });
  it("falls back to auto tier when nothing is stored", () => {
    const s = fakeStorage();
    expect(readPerfTier(s, { hardwareConcurrency: 8, deviceMemory: 8 })).toBe(
      "high",
    );
    expect(readPerfTier(s)).toBe("balanced");
  });
  it("falls back to auto tier on storage errors", () => {
    const broken: PerfStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readPerfTier(broken, { saveData: true })).toBe("battery");
  });
  it("round-trips all tiers", () => {
    const s = fakeStorage();
    const tiers: PerfTier[] = ["high", "balanced", "battery"];
    for (const t of tiers) {
      writePerfTier(s, t);
      expect(readPerfTier(s)).toBe(t);
    }
  });
  it("does not throw when write fails", () => {
    const broken: PerfStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => writePerfTier(broken, "high")).not.toThrow();
  });
});
