import {
  Room,
  RoomEvent,
  DisconnectReason,
  type RemoteParticipant,
  type Participant,
  DataPacket_Kind,
} from "livekit-client";

export interface LiveKitConnection {
  room: Room;
  disconnect: () => Promise<void>;
}

export interface PeerEvents {
  onPeerJoined: (identity: string, name?: string) => void;
  onPeerLeft: (identity: string) => void;
  onData: (identity: string, payload: Uint8Array) => void;
  /** Per-participant attribute change, e.g. `table_id`. Replayed on join. */
  onAttributes?: (identity: string, attrs: Record<string, string>) => void;
  /** Fires when the Room transitions to Disconnected. `reason` is the
   *  uppercased DisconnectReason name (e.g. "SIGNAL_CLOSE") or "UNKNOWN". */
  onDisconnected?: (reason: string) => void;
}

export async function connectLiveKit(
  serverUrl: string,
  token: string,
  events: PeerEvents,
): Promise<LiveKitConnection> {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
  });

  room
    .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      events.onPeerJoined(p.identity, p.name);
      events.onAttributes?.(p.identity, p.attributes ?? {});
    })
    .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      events.onPeerLeft(p.identity);
    })
    .on(
      RoomEvent.ParticipantAttributesChanged,
      (changed: Record<string, string>, p: Participant) => {
        events.onAttributes?.(p.identity, { ...p.attributes, ...changed });
      },
    )
    .on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: Participant) => {
        if (!participant) return;
        events.onData(participant.identity, payload);
      },
    )
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      const name =
        reason != null ? DisconnectReason[reason] ?? "UNKNOWN" : "UNKNOWN";
      events.onDisconnected?.(name);
    });

  await room.connect(serverUrl, token);

  // Replay peers already in the room so the snapshot is consistent on join.
  room.remoteParticipants.forEach((p) => {
    events.onPeerJoined(p.identity, p.name);
    events.onAttributes?.(p.identity, p.attributes ?? {});
  });

  return {
    room,
    disconnect: async () => {
      await room.disconnect();
    },
  };
}

// Lossy data publish for 20 Hz position broadcasts. Matches the Android client
// which uses DataPublishReliability.LOSSY for the same channel.
export async function publishPosition(room: Room, data: Uint8Array): Promise<void> {
  await room.localParticipant.publishData(data, {
    reliable: false,
  });
}

// Reliable data publish for low-rate, must-deliver payloads (e.g. chat).
export async function publishReliable(room: Room, data: Uint8Array): Promise<void> {
  await room.localParticipant.publishData(data, {
    reliable: true,
  });
}

// Kept for forward use (table_id sync); same attribute key as Android.
export async function setTableAttribute(
  room: Room,
  tableId: string | null,
): Promise<void> {
  await room.localParticipant.setAttributes({ table_id: tableId ?? "" });
}

/** Publish the local user's presence status (`available|busy|focus|meeting
 *  |away`) as a LiveKit attribute so peers see it via the same replay-on-
 *  join path as `table_id`. Web-only for now; Android peers ignore unknown
 *  attributes. */
export async function setStatusAttribute(
  room: Room,
  status: string,
): Promise<void> {
  await room.localParticipant.setAttributes({ status });
}

/** Publish profile attributes once on join. `nickname`/`color` match the
 *  contract (`docs/contracts.md` — LiveKit participant attributes).
 *  `character` is a 1..50 sprite index string that peers parse to render
 *  the user's chosen avatar. */
export async function publishProfileAttributes(
  room: Room,
  profile: { nickname: string; color: string; characterIndex?: number },
): Promise<void> {
  try {
    const attrs: Record<string, string> = {
      nickname: profile.nickname,
      color: profile.color,
    };
    if (typeof profile.characterIndex === "number") {
      attrs.character = String(profile.characterIndex);
    }
    await room.localParticipant.setAttributes(attrs);
  } catch (err) {
    console.warn("publishProfileAttributes failed", err);
  }
}

/** Toggle mic publish. First `true` call may prompt for browser permission.
 *  Returns `"ok"`, `"denied"` (NotAllowedError / no device), or `"error"` so
 *  the caller can latch a banner and stop re-prompting. */
export async function setMicEnabled(
  room: Room,
  enabled: boolean,
): Promise<CameraToggleResult> {
  try {
    await room.localParticipant.setMicrophoneEnabled(enabled);
    return "ok";
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (
      name === "NotAllowedError" ||
      name === "PermissionDeniedError" ||
      name === "NotFoundError" ||
      name === "DevicesNotFoundError"
    ) {
      console.warn("setMicrophoneEnabled denied or no device");
      return "denied";
    }
    console.warn("setMicrophoneEnabled failed", err);
    return "error";
  }
}

/** Toggle camera publish. Returns `"ok"`, `"denied"` (NotAllowedError), or
 *  `"error"` so the caller can render an inline permission banner instead of
 *  silently retrying every render. */
export type CameraToggleResult = "ok" | "denied" | "error";
export async function setCameraEnabled(
  room: Room,
  enabled: boolean,
): Promise<CameraToggleResult> {
  try {
    await room.localParticipant.setCameraEnabled(enabled);
    return "ok";
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      console.warn("setCameraEnabled denied by user");
      return "denied";
    }
    console.warn("setCameraEnabled failed", err);
    return "error";
  }
}

/** Per-remote-peer video subscription toggle. Use to scope camera bandwidth
 *  to same-table peers (mirrors `setPeerVolume` for audio). */
export function setPeerVideoSubscribed(
  room: Room,
  identity: string,
  subscribed: boolean,
): void {
  const rp = room.remoteParticipants.get(identity);
  if (!rp) return;
  rp.videoTrackPublications.forEach((pub) => {
    try {
      pub.setSubscribed(subscribed);
    } catch (err) {
      console.warn("setSubscribed failed", identity, err);
    }
  });
}

/** Per-remote-peer audio subscription toggle. Used by the M2 local block
 *  path (docs/contracts.md §5): unsubscribing a blocked peer's audio saves
 *  bandwidth; `setPeerVolume(…, 0)` is the belt-and-braces guard. Re-
 *  subscribing on unblock restores audio. Mirrors
 *  `setPeerVideoSubscribed`. */
export function setPeerAudioSubscribed(
  room: Room,
  identity: string,
  subscribed: boolean,
): void {
  const rp = room.remoteParticipants.get(identity);
  if (!rp) return;
  rp.audioTrackPublications.forEach((pub) => {
    try {
      pub.setSubscribed(subscribed);
    } catch (err) {
      console.warn("setSubscribed(audio) failed", identity, err);
    }
  });
}

/** Toggle screen share publish. Same return contract as `setCameraEnabled`
 *  so the UI can latch on denial and stop re-prompting. The browser's screen
 *  picker dialog is what fires on the `true` call. */
export async function setScreenShareEnabled(
  room: Room,
  enabled: boolean,
): Promise<CameraToggleResult> {
  try {
    await room.localParticipant.setScreenShareEnabled(enabled);
    return "ok";
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      // User dismissed the picker. Not a hard error — let them try again.
      console.warn("setScreenShareEnabled cancelled by user");
      return "denied";
    }
    console.warn("setScreenShareEnabled failed", err);
    return "error";
  }
}

/** Per-remote-peer audio gain (0..1). Used to scope hearing to same table. */
export function setPeerVolume(
  room: Room,
  identity: string,
  volume: number,
): void {
  const rp = room.remoteParticipants.get(identity);
  if (!rp) return;
  try {
    rp.setVolume(volume);
  } catch (err) {
    console.warn("setVolume failed", identity, err);
  }
}

export { DataPacket_Kind };

/** Publish the local user's "now playing" string as a LiveKit attribute.
 *  Pass an empty string to clear. Web-only for now; Android peers ignore
 *  unknown attributes. */
export async function setNowPlayingAttribute(
  room: Room,
  nowPlaying: string,
): Promise<void> {
  await room.localParticipant.setAttributes({ now_playing: nowPlaying });
}

/** Publish the local participant's current zone as LiveKit attributes.
 *  Keys are verbatim per docs/contracts.md §"Zones (M1: quiet semantics)":
 *  `zone` is the zone id (empty string = not inside any zone),
 *  `zone_kind` is `silent` | `discussion` | `rest` | `none`.
 *  Call only on zone-boundary crossings — zone changes are low-frequency
 *  and must stay off the 20 Hz position hot path. */
export async function setZoneAttributes(
  room: Room,
  zoneId: string,
  zoneKind: string,
): Promise<void> {
  await room.localParticipant.setAttributes({
    zone: zoneId,
    zone_kind: zoneKind,
  });
}

/** Publish the local participant's moderation role (`host` | `user`) as a
 *  LiveKit attribute. Display-only: the server never reads it (the DB is
 *  the only source of truth for roles) — peers use it for the host badge.
 *  Contract: docs/contracts.md "Moderation (M2)" §1. */
export async function setRoleAttribute(
  room: Room,
  role: string,
): Promise<void> {
  try {
    await room.localParticipant.setAttributes({ role });
  } catch (err) {
    console.warn("setRoleAttribute failed", err);
  }
}

/** Spatial-audio distance falloff (M1 T3). Ported from Android
 *  `SpatialAudioEngine`: linear, `maxDistance = 300` map px (same unit as
 *  Android), clamped to [0, 1]. Beyond max distance the peer is inaudible
 *  (caller should set volume 0). Replaces the pre-M1 binary same-table
 *  gate (`audible = sameTable ? 1 : 0`); table membership no longer decides
 *  audibility. */
export const SPATIAL_AUDIO_MAX_DISTANCE = 300;
export function attenuationFor(distPx: number): number {
  const v = 1 - distPx / SPATIAL_AUDIO_MAX_DISTANCE;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}
