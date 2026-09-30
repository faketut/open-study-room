import { AccessToken, RoomServiceClient, TrackSource, DataPacket_Kind } from "livekit-server-sdk";
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

// ---------- M2 moderation enforcement (kick) ----------
// docs/contracts.md "Moderation (M2: stranger safety)" §3b: the server sends
// a reliable data-channel kick notice to the target's identity, then calls
// removeParticipant, then records the kick row.

/** Minimal surface we need for kick enforcement. Kept an interface (instead
 *  of the concrete RoomServiceClient) so tests can inject a spy. */
export interface RoomAdminClient {
  /** Reliable data-channel payload to one participant identity. */
  sendData(room: string, identity: string, payload: string): Promise<unknown>;
  /** Remove a participant from the room. */
  removeParticipant(room: string, identity: string): Promise<unknown>;
}

export class LiveKitRoomAdmin implements RoomAdminClient {
  constructor(private readonly client: RoomServiceClient) {}

  async sendData(
    room: string,
    identity: string,
    payload: string,
  ): Promise<unknown> {
    return this.client.sendData(
      room,
      new TextEncoder().encode(payload),
      DataPacket_Kind.RELIABLE,
      { destinationIdentities: [identity] },
    );
  }

  async removeParticipant(room: string, identity: string): Promise<unknown> {
    return this.client.removeParticipant(room, identity);
  }
}

/** Build a RoomAdminClient backed by a real LiveKit RoomServiceClient. */
export function createRoomAdmin(
  host: string,
  apiKey: string,
  apiSecret: string,
): RoomAdminClient {
  return new LiveKitRoomAdmin(new RoomServiceClient(host, apiKey, apiSecret));
}

// ---------- P1-C whiteboard clear fan-out ----------
// docs/contracts.md "Whiteboard (P1-C: discussion-zone shared board)" §4:
// on a successful host clear the server fans out a reliable `wb_clear`
// payload room-wide — the same RoomServiceClient.sendData transport the M2
// kick notice uses, but with no destination identities so the SFU
// broadcasts to every participant. Kept an interface (instead of the
// concrete client) so tests can inject a spy.

/** Minimal surface for the whiteboard clear fan-out. */
export interface RoomBroadcastClient {
  /** Reliable room-wide broadcast of a JSON payload. */
  broadcast(room: string, payload: string): Promise<unknown>;
}

export class LiveKitRoomBroadcaster implements RoomBroadcastClient {
  constructor(private readonly client: RoomServiceClient) {}

  async broadcast(room: string, payload: string): Promise<unknown> {
    return this.client.sendData(
      room,
      new TextEncoder().encode(payload),
      DataPacket_Kind.RELIABLE,
    );
  }
}

/** Build a RoomBroadcastClient backed by a real LiveKit RoomServiceClient. */
export function createRoomBroadcaster(
  host: string,
  apiKey: string,
  apiSecret: string,
): RoomBroadcastClient {
  return new LiveKitRoomBroadcaster(new RoomServiceClient(host, apiKey, apiSecret));
}
