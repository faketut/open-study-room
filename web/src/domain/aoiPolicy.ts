// M4 position broadcast AOI (docs/contracts.md "Position broadcast AOI (M4)").
//
// Sender-side publish-rate tiering by distance to the nearest known peer.
// LiveKit data channels are room-broadcast (the SFU fans every publish out
// to all N-1 peers), so the cost lever is publish *rate*, not selective
// delivery. Tiers:
//
//   NEAR < AOI_NEAR_PX              -> AOI_NEAR_HZ (20 Hz)
//   MID  AOI_NEAR_PX..AOI_MID_PX    -> AOI_MID_HZ  (5 Hz)
//   FAR  > AOI_MID_PX / no peers   -> AOI_FAR_HZ  (1 Hz heartbeat)
//
// Idle suppression (stationary -> 0 Hz, resume on first movement) and the
// teleport/spawn immediate-publish bypass live in the caller; this module
// is pure policy. AOI changes only the rate of position packets -- never
// who may speak (M1 zones) or who is filtered (M2 blocks).

export const AOI_NEAR_PX = 1600;
export const AOI_MID_PX = 4000;

export const AOI_NEAR_HZ = 20;
export const AOI_MID_HZ = 5;
export const AOI_FAR_HZ = 1;

export type AoiTier = "NEAR" | "MID" | "FAR";

/**
 * Tier for a distance (px) to the nearest known peer. Negative distances are
 * clamped to 0; Infinity / NaN (no known peers) maps to FAR. Boundaries:
 * 1600 and 4000 belong to MID (NEAR is strictly < 1600, FAR is strictly >
 * 4000).
 */
export function tierForDistance(distPx: number): AoiTier {
  const d = Number.isFinite(distPx) ? Math.max(0, distPx) : Infinity;
  if (d < AOI_NEAR_PX) return "NEAR";
  if (d <= AOI_MID_PX) return "MID";
  return "FAR";
}

/** Publish rate (Hz) for a tier. */
export function hzForTier(tier: AoiTier): number {
  switch (tier) {
    case "NEAR":
      return AOI_NEAR_HZ;
    case "MID":
      return AOI_MID_HZ;
    case "FAR":
      return AOI_FAR_HZ;
  }
}

export interface PeerPosition {
  x: number;
  y: number;
}

/**
 * Distance to the nearest peer in `peers` from `self`. Empty peer list (no
 * known peers) -> Infinity, which tiers as FAR (1 Hz heartbeat).
 */
export function nearestPeerDistance(
  self: PeerPosition,
  peers: readonly PeerPosition[],
): number {
  let best = Infinity;
  for (const p of peers) {
    const d = Math.hypot(p.x - self.x, p.y - self.y);
    if (d < best) best = d;
  }
  return best;
}
