import { describe, expect, it } from "vitest";
import {
  canTransition,
  derivePhaseFromSession,
  formatRemaining,
  parseFocusAttribute,
  remainingSecFromEndsAt,
  serializeFocusAttribute,
  type PomodoroPhase,
} from "../pomodoro";

describe("serializeFocusAttribute / parseFocusAttribute round-trip", () => {
  const cases: { phase: PomodoroPhase; sec: number }[] = [
    { phase: "idle", sec: 0 },
    { phase: "idle", sec: 999 },
    { phase: "focusing", sec: 0 },
    { phase: "focusing", sec: 1500 },
    { phase: "focusing", sec: 59 },
    { phase: "on_break", sec: 300 },
    { phase: "on_break", sec: 1 },
  ];
  for (const { phase, sec } of cases) {
    it(`round-trips ${phase} ${sec}s`, () => {
      const wire = serializeFocusAttribute(phase, sec);
      const parsed = parseFocusAttribute(wire);
      expect(parsed).not.toBeNull();
      if (phase === "idle") {
        expect(wire).toBe("");
        expect(parsed).toEqual({ phase: "idle", remainingSec: 0 });
      } else {
        expect(parsed!.phase).toBe(phase);
        expect(parsed!.remainingSec).toBe(sec);
      }
    });
  }

  it("serializes the exact contract wire values", () => {
    expect(serializeFocusAttribute("focusing", 1112)).toBe("focusing:1112");
    expect(serializeFocusAttribute("on_break", 252)).toBe("break:252");
    expect(serializeFocusAttribute("idle", 0)).toBe("");
  });

  it("floors fractional and clamps negative seconds on serialize", () => {
    expect(serializeFocusAttribute("focusing", 59.9)).toBe("focusing:59");
    expect(serializeFocusAttribute("focusing", -5)).toBe("focusing:0");
  });
});

describe("parseFocusAttribute illegal inputs", () => {
  const illegal = [
    "focusing", // missing seconds
    "break",
    "focusing:", // empty seconds
    "focusing:abc",
    "focusing:-5", // negative
    "break:1.5", // fractional
    "focusing:1:2", // extra colon
    "FOCUSING:5", // case-sensitive prefix
    "focus:5", // wrong prefix
    "idle",
    "  ", // whitespace-only is NOT idle
    "focusing: 5",
    "focusing:0x10",
  ];
  for (const s of illegal) {
    it(`rejects ${JSON.stringify(s)}`, () => {
      expect(parseFocusAttribute(s)).toBeNull();
    });
  }

  it("accepts zero remaining", () => {
    expect(parseFocusAttribute("focusing:0")).toEqual({
      phase: "focusing",
      remainingSec: 0,
    });
    expect(parseFocusAttribute("break:0")).toEqual({
      phase: "on_break",
      remainingSec: 0,
    });
  });
});

describe("formatRemaining", () => {
  it("formats boundaries", () => {
    expect(formatRemaining(0)).toBe("00:00");
    expect(formatRemaining(59)).toBe("00:59");
    expect(formatRemaining(60)).toBe("01:00");
    expect(formatRemaining(61)).toBe("01:01");
  });

  it("does not wrap hours — minutes are unbounded", () => {
    expect(formatRemaining(3600)).toBe("60:00");
    expect(formatRemaining(3661)).toBe("61:01");
    expect(formatRemaining(5999)).toBe("99:59");
  });

  it("clamps negatives and floors fractions", () => {
    expect(formatRemaining(-1)).toBe("00:00");
    expect(formatRemaining(-999)).toBe("00:00");
    expect(formatRemaining(1.9)).toBe("00:01");
    expect(formatRemaining(59.999)).toBe("00:59");
  });
});

describe("canTransition (pomodoro state machine)", () => {
  it("allows start from idle to either active phase", () => {
    expect(canTransition("idle", "focusing")).toBe(true);
    expect(canTransition("idle", "on_break")).toBe(true);
  });

  it("allows every active phase back to idle", () => {
    expect(canTransition("focusing", "idle")).toBe(true);
    expect(canTransition("on_break", "idle")).toBe(true);
  });

  it("forbids direct focusing <-> on_break", () => {
    expect(canTransition("focusing", "on_break")).toBe(false);
    expect(canTransition("on_break", "focusing")).toBe(false);
  });

  it("forbids self-transitions", () => {
    expect(canTransition("idle", "idle")).toBe(false);
    expect(canTransition("focusing", "focusing")).toBe(false);
    expect(canTransition("on_break", "on_break")).toBe(false);
  });
});

describe("derivePhaseFromSession", () => {
  const now = 1_700_000_000_000;

  it("returns idle when no session is active", () => {
    expect(derivePhaseFromSession(null, now)).toEqual({
      phase: "idle",
      kind: null,
      endsAt: null,
    });
  });

  it("returns idle when the session already ended server-side", () => {
    expect(
      derivePhaseFromSession({ kind: "focus", endsAt: now }, now),
    ).toMatchObject({ phase: "idle" });
    expect(
      derivePhaseFromSession({ kind: "focus", endsAt: now - 1 }, now),
    ).toMatchObject({ phase: "idle" });
  });

  it("resumes a live focus session as focusing", () => {
    expect(
      derivePhaseFromSession({ kind: "focus", endsAt: now + 60_000 }, now),
    ).toEqual({ phase: "focusing", kind: "focus", endsAt: now + 60_000 });
  });

  it("resumes a live break session as on_break", () => {
    expect(
      derivePhaseFromSession({ kind: "break", endsAt: now + 60_000 }, now),
    ).toEqual({ phase: "on_break", kind: "break", endsAt: now + 60_000 });
  });
});

describe("remainingSecFromEndsAt", () => {
  it("rounds up partial seconds and floors at 0", () => {
    expect(remainingSecFromEndsAt(1_001, 0)).toBe(2);
    expect(remainingSecFromEndsAt(1_000, 0)).toBe(1);
    expect(remainingSecFromEndsAt(1_000, 1_000)).toBe(0);
    expect(remainingSecFromEndsAt(500, 1_000)).toBe(0);
  });
});
