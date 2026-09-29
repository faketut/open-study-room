import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import type { ParticipantInfo } from "livekit-server-sdk";

export interface SignedToken {
  token: string;
  expiresAt: number;
}

export interface TokenSignerOptions {
  apiKey: string;
  apiSecret: string;
  ttlSeconds: number;
}

export class TokenSigner {
  constructor(private readonly opts: TokenSignerOptions) {}

  async sign(userId: string, room: string, name: string): Promise<SignedToken> {
    const at = new AccessToken(this.opts.apiKey, this.opts.apiSecret, {
      identity: userId,
      name,
      ttl: this.opts.ttlSeconds,
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      // Needed so clients can update their own attributes (e.g. `table_id`
      // when sitting at a table). Without this LiveKit returns
      // "does not have permission to update own metadata".
      canUpdateOwnMetadata: true,
    });
    return {
      token: await at.toJwt(),
      expiresAt: Date.now() + this.opts.ttlSeconds * 1000,
    };
  }
}

/**
 * Server-side media isolation for M1 quiet semantics
 * (docs/contracts.md, "Zones (M1: quiet semantics)" / "Server-side media isolation").
 *
 * When a participant enters a `silent` zone the server force-mutes their
 * microphone track; server-side mute wins even if the client misbehaves.
 * When they leave a `silent` zone the mute is lifted (subject to the
 * remembered mic intent, see src/zones.ts).
 */

/**
 * Server-side media isolation for M1 quiet semantics
 * (docs/contracts.md, "Zones (M1: quiet semantics)" / "Server-side media isolation").
 *
 * When a participant enters a `silent` zone the server force-mutes their
 * microphone track; server-side mute wins even if the client misbehaves.
 * When they leave a `silent` zone the mute is lifted (subject to the
 * remembered mic intent, see src/zones.ts).
 *
 * The LiveKit `MutePublishedTrack` RPC addresses tracks by **track SID**,
 * so we resolve the participant's published microphone track via
 * `listParticipants` first — passing a source name like `"microphone"`
 * as the SID is not honored by the server.
 */

/** Minimal surface we need from the LiveKit server SDK. Keeping it an
 *  interface (instead of the concrete client) lets tests inject a spy. */
export interface RoomMuteClient {
  listParticipants(room: string): Promise<ParticipantInfo[]>;
  mutePublishedTrack(
    room: string,
    identity: string,
    trackSid: string,
    muted: boolean,
  ): Promise<unknown>;
}

export class RoomMutator {
  constructor(private readonly client: RoomMuteClient) {}

  /** SID of the participant's published microphone track, or null when they
   *  have none (e.g. joined under the "quiet by default" principle). */
  private async micTrackSid(
    room: string,
    identity: string,
  ): Promise<string | null> {
    const participants = await this.client.listParticipants(room);
    const tracks =
      participants.find((p) => p.identity === identity)?.tracks ?? [];
    return tracks.find((t) => t.source === TrackSource.MICROPHONE)?.sid ?? null;
  }

  /**
   * Server-enforced mute of the participant's microphone track.
   * Returns false when there is no published mic track (nothing to mute).
   */
  async muteMicrophone(room: string, identity: string): Promise<boolean> {
    const sid = await this.micTrackSid(room, identity);
    if (!sid) return false;
    await this.client.mutePublishedTrack(room, identity, sid, true);
    return true;
  }

  /**
   * Lift a server-enforced mute of the participant's microphone track.
   * Returns false when there is no published mic track.
   */
  async unmuteMicrophone(room: string, identity: string): Promise<boolean> {
    const sid = await this.micTrackSid(room, identity);
    if (!sid) return false;
    await this.client.mutePublishedTrack(room, identity, sid, false);
    return true;
  }
}

/** Build a RoomMutator backed by a real LiveKit RoomServiceClient.
 *  `host` may be the same ws(s):// URL as LIVEKIT_URL — the SDK's TwirpRpc
 *  rewrites ws:// to http:// internally. */
export function createRoomMutator(
  host: string,
  apiKey: string,
  apiSecret: string,
): RoomMutator {
  return new RoomMutator(new RoomServiceClient(host, apiKey, apiSecret));
}
