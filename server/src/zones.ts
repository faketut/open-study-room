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

/**
 * Server-side silent-zone mic policy.
 *
 * Edge detection compares each incoming `zone_kind` against the participant's
 * previously stored kind (the state route reads it from `room_state` before
 * upserting, so edges survive process restarts):
 *   - entering `silent` -> force-mute the mic track via RoomMutator;
 *   - leaving `silent`  -> lift the mute, but only when `intendedMicOn`
 *                          records that the participant wanted the mic on
 *                          before entering.
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

  constructor(
    private readonly muter: Pick<
      RoomMutator,
      "muteMicrophone" | "unmuteMicrophone"
    > | null,
  ) {}

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

    if (!wasSilent && nowSilent) {
      await this.muter.muteMicrophone(room, identity);
      return "muted";
    }
    if (
      wasSilent &&
      !nowSilent &&
      this.intendedMicOn.get(this.key(room, identity)) === true
    ) {
      await this.muter.unmuteMicrophone(room, identity);
      return "unmuted";
    }
    return "none";
  }
}
