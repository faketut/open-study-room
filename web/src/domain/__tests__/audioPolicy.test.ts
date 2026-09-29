import { describe, expect, it } from "vitest";
import {
  attenuationFor,
  SPATIAL_AUDIO_MAX_DISTANCE,
} from "../../data/liveKitService";
import {
  micLogicalState,
  micMayPublish,
  reduceZoneCrossing,
  shouldApplyVolume,
} from "../audioPolicy";

describe("attenuationFor", () => {
  it("matches the Android SpatialAudioEngine constants (maxDistance=300)", () => {
    expect(SPATIAL_AUDIO_MAX_DISTANCE).toBe(300);
  });

  it("is 1 at zero distance", () => {
    expect(attenuationFor(0)).toBe(1);
  });

  it("falls off linearly: half volume at half max distance", () => {
    expect(attenuationFor(150)).toBeCloseTo(0.5, 10);
    expect(attenuationFor(75)).toBeCloseTo(0.75, 10);
  });

  it("is 0 at and beyond max distance", () => {
    expect(attenuationFor(300)).toBe(0);
    expect(attenuationFor(301)).toBe(0);
    expect(attenuationFor(10_000)).toBe(0);
  });

  it("clamps negative distances to 1", () => {
    expect(attenuationFor(-50)).toBe(1);
  });
});

describe("micLogicalState", () => {
  it("forces MUTED in silent zones", () => {
    expect(
      micLogicalState({
        zoneKind: "silent",
        seated: true,
        intendedMicOn: true,
        pttHeld: false,
      }),
    ).toBe("MUTED");
  });

  it("enters PTT while Space is held in a silent zone", () => {
    expect(
      micLogicalState({
        zoneKind: "silent",
        seated: false,
        intendedMicOn: false,
        pttHeld: true,
      }),
    ).toBe("PTT");
  });

  it("user toggle decides in discussion/rest/none", () => {
    for (const zoneKind of ["discussion", "rest", "none"] as const) {
      expect(
        micLogicalState({ zoneKind, seated: true, intendedMicOn: true, pttHeld: false }),
      ).toBe("LIVE");
      expect(
        micLogicalState({ zoneKind, seated: true, intendedMicOn: false, pttHeld: false }),
      ).toBe("MUTED");
    }
  });

  it("PTT has no effect outside silent zones", () => {
    expect(
      micLogicalState({
        zoneKind: "discussion",
        seated: true,
        intendedMicOn: false,
        pttHeld: true,
      }),
    ).toBe("MUTED");
    expect(
      micLogicalState({
        zoneKind: "rest",
        seated: false,
        intendedMicOn: true,
        pttHeld: true,
      }),
    ).toBe("LIVE");
  });
});

describe("micMayPublish (quiet-by-default publish principle)", () => {
  it("(a) seated at a table in discussion/rest/none may publish", () => {
    for (const zoneKind of ["discussion", "rest", "none"] as const) {
      expect(
        micMayPublish({ zoneKind, seated: true, intendedMicOn: true, pttHeld: false }),
      ).toBe(true);
    }
  });

  it("(a) seated but user-muted may not publish", () => {
    expect(
      micMayPublish({
        zoneKind: "discussion",
        seated: true,
        intendedMicOn: false,
        pttHeld: false,
      }),
    ).toBe(false);
  });

  it("(b) PTT held in silent may publish even unseated and muted", () => {
    expect(
      micMayPublish({
        zoneKind: "silent",
        seated: false,
        intendedMicOn: false,
        pttHeld: true,
      }),
    ).toBe(true);
  });

  it("silent without PTT never publishes, even seated and unmuted", () => {
    expect(
      micMayPublish({
        zoneKind: "silent",
        seated: true,
        intendedMicOn: true,
        pttHeld: false,
      }),
    ).toBe(false);
  });

  it("(c) manually enabled mic in discussion/rest publishes while standing", () => {
    expect(
      micMayPublish({
        zoneKind: "discussion",
        seated: false,
        intendedMicOn: true,
        pttHeld: false,
      }),
    ).toBe(true);
    expect(
      micMayPublish({
        zoneKind: "rest",
        seated: false,
        intendedMicOn: true,
        pttHeld: false,
      }),
    ).toBe(true);
  });

  it("standing in 'none' with mic on does not publish", () => {
    expect(
      micMayPublish({
        zoneKind: "none",
        seated: false,
        intendedMicOn: true,
        pttHeld: false,
      }),
    ).toBe(false);
  });
});

describe("reduceZoneCrossing", () => {
  it("enter(silent) remembers intent and force-mutes", () => {
    const res = reduceZoneCrossing(
      { kind: "discussion", intendedMicOn: true },
      "silent",
      false,
      false,
    );
    expect(res).toEqual({ kind: "silent", intendedMicOn: true, userMuted: true });
  });

  it("enter(silent) captures a pre-muted intent as off", () => {
    const res = reduceZoneCrossing(
      { kind: "none", intendedMicOn: false },
      "silent",
      true,
      false,
    );
    expect(res.intendedMicOn).toBe(false);
    expect(res.userMuted).toBe(true);
  });

  it("leave(silent) restores LIVE when intent was on and audio allowed", () => {
    const res = reduceZoneCrossing(
      { kind: "silent", intendedMicOn: true },
      "discussion",
      true,
      true,
    );
    expect(res.userMuted).toBe(false);
    expect(res.intendedMicOn).toBe(true);
  });

  it("leave(silent) stays muted when intent was off", () => {
    const res = reduceZoneCrossing(
      { kind: "silent", intendedMicOn: false },
      "rest",
      true,
      true,
    );
    expect(res.userMuted).toBe(true);
  });

  it("leave(silent) stays muted when the new zone disallows audio", () => {
    const res = reduceZoneCrossing(
      { kind: "silent", intendedMicOn: true },
      "silent",
      true,
      false,
    );
    // silent -> silent is not a leave; no transition at all.
    expect(res.userMuted).toBe(true);
  });

  it("crossing between non-silent zones leaves mute state alone", () => {
    const res = reduceZoneCrossing(
      { kind: "discussion", intendedMicOn: true },
      "rest",
      false,
      true,
    );
    expect(res).toEqual({ kind: "rest", intendedMicOn: true, userMuted: false });
  });
});

describe("shouldApplyVolume", () => {
  it("applies the first volume for a peer", () => {
    const cache = new Map<string, number>();
    expect(shouldApplyVolume(cache, "a", 0.5)).toBe(true);
  });

  it("skips sub-epsilon changes", () => {
    const cache = new Map<string, number>();
    shouldApplyVolume(cache, "a", 0.5);
    expect(shouldApplyVolume(cache, "a", 0.51)).toBe(false);
    expect(shouldApplyVolume(cache, "a", 0.49)).toBe(false);
  });

  it("applies changes beyond epsilon", () => {
    const cache = new Map<string, number>();
    shouldApplyVolume(cache, "a", 0.5);
    expect(shouldApplyVolume(cache, "a", 0.6)).toBe(true);
  });

  it("tracks peers independently", () => {
    const cache = new Map<string, number>();
    shouldApplyVolume(cache, "a", 0.5);
    expect(shouldApplyVolume(cache, "b", 0.5)).toBe(true);
    expect(shouldApplyVolume(cache, "b", 0.5)).toBe(false);
  });
});
