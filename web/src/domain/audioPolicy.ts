// M1 audio policy: pure, testable logic for zone-scoped microphone behavior
// (T3 spatial audio gating + T4 push-to-talk state machine).
//
// SyncleScreen wires these functions to LiveKit; this module stays free of
// React and LiveKit imports so it remains unit-testable. `zoneAllowsAudio`
// is injected as a parameter (not imported) so this module has no runtime
// dependency on ../domain/zones beyond the erased `ZoneKind` type.

import type { ZoneKind } from "./zones";

/** Logical mic states from docs/contracts.md §"Microphone state machine". */
export type MicLogicalState = "MUTED" | "LIVE" | "PTT";

export interface MicPolicyInput {
  zoneKind: ZoneKind;
  /** Seated at a table. */
  seated: boolean;
  /** User's mic intent (HUD toggle / `M` key): true = wants mic on. */
  intendedMicOn: boolean;
  /** Space held while in a silent zone (T4 push-to-talk). */
  pttHeld: boolean;
}

/** Logical mic state per the contract's microphone state machine:
 *  - `silent`: forced `MUTED`, except holding Space enters `PTT` (mic-only,
 *    temporary). PTT has no effect in other zones.
 *  - `discussion` / `rest` / `none`: the user toggle decides `MUTED`/`LIVE`.
 */
export function micLogicalState(input: MicPolicyInput): MicLogicalState {
  if (input.zoneKind === "silent") {
    return input.pttHeld ? "PTT" : "MUTED";
  }
  return input.intendedMicOn ? "LIVE" : "MUTED";
}

/** Publish gate per the contract's "Quiet by default" publish principle.
 *  Mic MAY be published when ANY of:
 *  (a) seated at a table AND zone is `discussion`/`rest`/`none`;
 *  (b) PTT held in a `silent` zone (mic only);
 *  (c) user manually enables mic in `discussion`/`rest` (seated or not).
 *  Note (c) deliberately excludes `none`: standing outside any zone with
 *  the mic toggled on does not publish.
 */
export function micMayPublish(input: MicPolicyInput): boolean {
  if (input.zoneKind === "silent") return input.pttHeld; // (b)
  if (!input.intendedMicOn) return false;
  if (input.seated) return true; // (a)
  return input.zoneKind === "discussion" || input.zoneKind === "rest"; // (c)
}

export interface ZoneMicTrack {
  kind: ZoneKind;
  /** User's mic intent (`intendedMicOn`) remembered at silent entry. */
  intendedMicOn: boolean;
}

export interface ZoneCrossingResult {
  kind: ZoneKind;
  intendedMicOn: boolean;
  /** The `userMuted` value the UI should apply after the crossing. */
  userMuted: boolean;
}

/** Zone-boundary mic transitions per the contract:
 *  - `enter(silent)` → `forceMute()`: remember pre-entry user intent
 *    (`intendedMicOn`), then mute.
 *  - `leave(silent)` → if `intendedMicOn` was true AND the new zone allows
 *    audio, restore `LIVE`; otherwise stay `MUTED`.
 *  `nextZoneAllowsAudio` is the caller's `zoneAllowsAudio(nextKind)` so this
 *  function stays independent of the zones.ts value exports.
 */
export function reduceZoneCrossing(
  prev: ZoneMicTrack,
  nextKind: ZoneKind,
  currentUserMuted: boolean,
  nextZoneAllowsAudio: boolean,
): ZoneCrossingResult {
  if (nextKind === "silent" && prev.kind !== "silent") {
    return {
      kind: nextKind,
      intendedMicOn: !currentUserMuted,
      userMuted: true,
    };
  }
  if (prev.kind === "silent" && nextKind !== "silent") {
    const restore = prev.intendedMicOn && nextZoneAllowsAudio;
    return {
      kind: nextKind,
      intendedMicOn: prev.intendedMicOn,
      userMuted: restore ? false : currentUserMuted,
    };
  }
  return {
    kind: nextKind,
    intendedMicOn: prev.intendedMicOn,
    userMuted: currentUserMuted,
  };
}

/** Volume-change gate mirroring Android
 *  `SpatialAudioEngine.shouldApplyVolume` (epsilon 0.02): skip redundant
 *  `setVolume` calls for sub-audible deltas. Returns true when the volume
 *  was applied (changed beyond epsilon) and records it in the cache. */
const VOLUME_EPSILON = 0.02;
export function shouldApplyVolume(
  lastVolumeByPeer: Map<string, number>,
  identity: string,
  volume: number,
): boolean {
  const prev = lastVolumeByPeer.get(identity);
  if (prev !== undefined && Math.abs(prev - volume) < VOLUME_EPSILON) {
    return false;
  }
  lastVolumeByPeer.set(identity, volume);
  return true;
}
