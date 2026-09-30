import { describe, expect, it } from "vitest";
import {
  deriveStatus,
  isAvatarStatus,
  statusMeta,
  IDLE_AWAY_MS,
} from "../avatarStatus";

describe("deriveStatus", () => {
  it("returns busy when manualBusy regardless of other signals", () => {
    expect(
      deriveStatus({ seated: true, muted: false, idleMs: 0, manualBusy: true }),
    ).toBe("busy");
    expect(
      deriveStatus({ seated: false, muted: true, idleMs: 9_999_999, manualBusy: true }),
    ).toBe("busy");
  });

  it("returns meeting when seated and unmuted", () => {
    expect(
      deriveStatus({ seated: true, muted: false, idleMs: 0, manualBusy: false }),
    ).toBe("meeting");
  });

  it("returns focus when seated and muted", () => {
    expect(
      deriveStatus({ seated: true, muted: true, idleMs: 0, manualBusy: false }),
    ).toBe("focus");
  });

  it("returns away when idle past threshold and not seated", () => {
    expect(
      deriveStatus({
        seated: false,
        muted: false,
        idleMs: IDLE_AWAY_MS,
        manualBusy: false,
      }),
    ).toBe("away");
    expect(
      deriveStatus({
        seated: false,
        muted: false,
        idleMs: IDLE_AWAY_MS - 1,
        manualBusy: false,
      }),
    ).toBe("available");
  });

  it("defaults to available", () => {
    expect(
      deriveStatus({ seated: false, muted: false, idleMs: 0, manualBusy: false }),
    ).toBe("available");
  });

  it("seated takes precedence over idle", () => {
    // Long-seated meetings shouldn't flip to away.
    expect(
      deriveStatus({
        seated: true,
        muted: false,
        idleMs: IDLE_AWAY_MS * 2,
        manualBusy: false,
      }),
    ).toBe("meeting");
  });

  // M3 focus loop: an active pomodoro overrides the seated/mute derivation.
  it("returns focus when focusing, even if the mic logic says meeting", () => {
    expect(
      deriveStatus({
        seated: true,
        muted: false,
        idleMs: 0,
        manualBusy: false,
        focusing: true,
      }),
    ).toBe("focus");
  });

  it("returns focus when focusing while standing or idle", () => {
    expect(
      deriveStatus({
        seated: false,
        muted: true,
        idleMs: 0,
        manualBusy: false,
        focusing: true,
      }),
    ).toBe("focus");
    expect(
      deriveStatus({
        seated: false,
        muted: false,
        idleMs: IDLE_AWAY_MS * 2,
        manualBusy: false,
        focusing: true,
      }),
    ).toBe("focus");
  });

  it("manualBusy still wins over an active pomodoro", () => {
    expect(
      deriveStatus({
        seated: true,
        muted: false,
        idleMs: 0,
        manualBusy: true,
        focusing: true,
      }),
    ).toBe("busy");
  });
});

describe("isAvatarStatus", () => {
  it("accepts known statuses and rejects others", () => {
    expect(isAvatarStatus("available")).toBe(true);
    expect(isAvatarStatus("meeting")).toBe(true);
    expect(isAvatarStatus("offline")).toBe(false);
    expect(isAvatarStatus("")).toBe(false);
    expect(isAvatarStatus(undefined)).toBe(false);
  });
});

describe("statusMeta", () => {
  it("returns a non-empty label and hex ringColor for every status", () => {
    for (const s of ["available", "busy", "focus", "meeting", "away"] as const) {
      const m = statusMeta(s);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.ringColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(m.pillBackground).toMatch(/^rgba\(/);
    }
  });
});
