import type { RoomMutator } from "./livekit.js";

/** Zone kinds, per docs/contracts.md "Zones (M1: quiet semantics)". */
export const ZONE_KINDS = ["silent", "discussion", "rest", "none"] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

/** Kind assumed when a state report carries no zone_kind (old clients). */
export const DEFAULT_ZONE_KIND: ZoneKind = "none";

export function isSilentKind(kind: ZoneKind | null | undefined): boolean {
  return kind === "silent";
}

export type ZoneMuteAction = "muted" | "unmuted" | "none";

export interface ZoneMutePolicyOptions {
  /**
   * M2 §3a: when set, the zone policy composes with the persisted
   * moderation-mute layer (the `mutes` table) by union:
   * - rule 3: leaving a silent zone never lifts a moderation mute;
   * - rule 6: a moderation-muted user keeps Layer M across rejoins — the
   *   server re-applies it whenever it sees their state report.
   */
  isModerationMuted?: (room: string, identity: string) => boolean;
}

/**
 * Server-side silent-zone mic policy.
 *
 * Edge detection compares each incoming `zone_kind` against the participant's
 * previously stored kind (the state route reads it from `room_state` before
 * upserting, so edges survive process restarts):
 *   - entering `silent` -> force-mute the mic track via RoomMutator;
 *   - leaving `silent`  -> lift the mute, but only when `intendedMicOn`
 *                          records that the participant wanted the mic on
 *                          before entering, AND (M2 §3a rule 3) there is no
 *                          moderation-mute row for the user.
 *
 * `intendedMicOn` lives only in process memory, keyed `${room}\0${identity}`.
 * A restart drops it (accepted: participants re-report their zone on the next
 * heartbeat and the mute edges re-fire; the conservative default is to stay
 * muted rather than accidentally unmute someone). The state-report schema
 * currently carries no mic-intent field, so nothing sets it to `true` yet
 * except `setIntendedMicOn` — a test hook and the future seam for a
 * client-reported mic toggle or a LiveKit track-published webhook.
 */
export class ZoneMutePolicy {
  private readonly intendedMicOn = new Map<string, boolean>();
  private readonly isModerationMuted?: (
    room: string,
    identity: string,
  ) => boolean;

  constructor(
    private readonly muter: Pick<
      RoomMutator,
      "muteMicrophone" | "unmuteMicrophone"
    > | null,
    opts?: ZoneMutePolicyOptions,
  ) {
    this.isModerationMuted = opts?.isModerationMuted;
  }

  private key(room: string, identity: string): string {
    return `${room}\0${identity}`;
  }

  /** Record whether the participant intended the mic on (test hook / future
   *  wiring; see class comment). */
  setIntendedMicOn(room: string, identity: string, on: boolean): void {
    this.intendedMicOn.set(this.key(room, identity), on);
  }

  /** Apply the policy for one state report. Returns what it did. */
  async onZoneReport(args: {
    room: string;
    identity: string;
    prevZoneKind: ZoneKind | null;
    zoneKind: ZoneKind;
  }): Promise<ZoneMuteAction> {
    if (!this.muter) return "none";
    const { room, identity, prevZoneKind, zoneKind } = args;
    const wasSilent = isSilentKind(prevZoneKind);
    const nowSilent = isSilentKind(zoneKind);
    // M2 §3a rule 1: effective state = muted iff (row in `mutes`) OR
    // (zone policy says mute). The layers lift independently.
    const moderationMuted = this.isModerationMuted?.(room, identity) ?? false;

    if (!wasSilent && nowSilent) {
      // Rule 2: zone enter(silent) mutes the track, never touches `mutes`.
      await this.muter.muteMicrophone(room, identity);
      return "muted";
    }
    if (wasSilent && !nowSilent) {
      // Rule 3: zone leave(silent) unmutes ONLY when there is no
      // moderation-mute row — the moderation mute survives zone movement.
      if (moderationMuted) return "none";
      if (this.intendedMicOn.get(this.key(room, identity)) === true) {
        await this.muter.unmuteMicrophone(room, identity);
        return "unmuted";
      }
      return "none";
    }
    // Rule 6: a moderation-muted user who rejoins keeps Layer M (the row is
    // keyed by stable user_id). Re-apply it whenever the server sees their
    // state report; clients also self-enforce from the sessions response.
    if (moderationMuted) {
      await this.muter.muteMicrophone(room, identity);
      return "muted";
    }
    return "none";
  }

  /**
   * M2 §3a rule 5: after a moderation unmute (the `mutes` row is deleted),
   * re-apply the zone policy — a user whose current `zone_kind` is `silent`
   * stays muted under Layer Z, otherwise the track is unmuted.
   */
  async reapplyAfterModerationUnmute(args: {
    room: string;
    identity: string;
    zoneKind: ZoneKind | null;
  }): Promise<ZoneMuteAction> {
    if (!this.muter) return "none";
    if (isSilentKind(args.zoneKind)) {
      await this.muter.muteMicrophone(args.room, args.identity);
      return "muted";
    }
    await this.muter.unmuteMicrophone(args.room, args.identity);
    return "unmuted";
  }
}
