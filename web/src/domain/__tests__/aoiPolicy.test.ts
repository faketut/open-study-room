import { describe, expect, it } from "vitest";
import {
  AOI_FAR_HZ,
  AOI_MID_HZ,
  AOI_MID_PX,
  AOI_NEAR_HZ,
  AOI_NEAR_PX,
  hzForTier,
  nearestPeerDistance,
  tierForDistance,
} from "../aoiPolicy";

describe("tierForDistance", () => {
  it("NEAR strictly below 1600", () => {
    expect(tierForDistance(0)).toBe("NEAR");
    expect(tierForDistance(1599)).toBe("NEAR");
    expect(tierForDistance(1599.999)).toBe("NEAR");
  });

  it("MID owns the 1600 and 4000 boundaries", () => {
    expect(tierForDistance(1600)).toBe("MID");
    expect(tierForDistance(2000)).toBe("MID");
    expect(tierForDistance(4000)).toBe("MID");
  });

  it("FAR strictly above 4000", () => {
    expect(tierForDistance(4001)).toBe("FAR");
    expect(tierForDistance(10_000)).toBe("FAR");
  });

  it("Infinity / NaN (no known peers) map to FAR", () => {
    expect(tierForDistance(Infinity)).toBe("FAR");
    expect(tierForDistance(NaN)).toBe("FAR");
  });

  it("negative distance is clamped to NEAR", () => {
    expect(tierForDistance(-1)).toBe("NEAR");
    expect(tierForDistance(-10_000)).toBe("NEAR");
  });

  it("frozen constants", () => {
    expect(AOI_NEAR_PX).toBe(1600);
    expect(AOI_MID_PX).toBe(4000);
    expect(AOI_NEAR_HZ).toBe(20);
    expect(AOI_MID_HZ).toBe(5);
    expect(AOI_FAR_HZ).toBe(1);
  });
});

describe("hzForTier", () => {
  it("maps tiers to frozen rates", () => {
    expect(hzForTier("NEAR")).toBe(20);
    expect(hzForTier("MID")).toBe(5);
    expect(hzForTier("FAR")).toBe(1);
  });
});

describe("nearestPeerDistance", () => {
  const self = { x: 100, y: 100 };

  it("returns Infinity for an empty peer list (no known peers)", () => {
    expect(nearestPeerDistance(self, [])).toBe(Infinity);
  });

  it("returns the distance to the nearest peer", () => {
    const peers = [
      { x: 900, y: 900 }, // ~1131
      { x: 100, y: 110 }, // 10
    ];
    expect(nearestPeerDistance(self, peers)).toBeCloseTo(10, 9);
  });

  it("works with a single peer", () => {
    expect(nearestPeerDistance(self, [{ x: 103, y: 104 }])).toBeCloseTo(
      5,
      9,
    );
  });

  it("0 when co-located with a peer", () => {
    expect(nearestPeerDistance(self, [{ x: 100, y: 100 }])).toBe(0);
  });
});
