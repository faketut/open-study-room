# Syncle shared contracts

Authoritative definitions for values that MUST be kept in sync between the
**Web client** (`web/`) and the **Node backend** (`server/`). If you change
one side, change the other in the same PR.

> **Changelog — 2026-09-29**: the Kotlin Android client (`app/`) was removed.
> Syncle is now web + server only. Mobile goes through phone browsers
> (touch-friendly web client); a Capacitor shell around the web client remains
> an option if native push / background audio is ever needed. Android-only
> contract entries below were rewritten or dropped accordingly.

For the binary position packet (17-byte little-endian: `type=1 | x:f32 | y:f32 | seq:i64`),
see [web/src/domain/positionPacket.ts](../web/src/domain/positionPacket.ts) —
the single implementation of the wire format.

## Room name

| Property | Value |
| --- | --- |
| Regex | `^[a-z0-9-]{3,64}$` |
| Allowed chars | lowercase letters, digits, hyphen |
| Min length | 3 |
| Max length | 64 |
| Default | `syncle-office` |

Why constrained: room names appear in URLs, log lines, and LiveKit identifiers;
keeping them ASCII-safe avoids encoding bugs across the stack.

### Where it lives

| Side | File | Symbol |
| --- | --- | --- |
| Server | [server/src/routes/sessions.ts](../server/src/routes/sessions.ts) | `z.string().regex(/^[a-z0-9-]{3,64}$/, ...)` |
| Web | [web/src/state/syncleStore.ts](../web/src/state/syncleStore.ts) | `ROOM_REGEX` |

### Test coverage

- Server: [server/tests/routes.test.ts](../server/tests/routes.test.ts) — `it.each` covers `"ab"`, `"UPPER"`, `"bad room"`, `"bad/slash"`, 65-char input, plus the positive `team-alpha-42`.
- Web: covered by `isValidRoom` unit tests; the UI surfaces validation errors inline on the join screen.

## Nickname

| Property | Value |
| --- | --- |
| Min length | 1 (after trim) |
| Max length | 32 |
| Allowed chars | unrestricted (UTF-8) |

| Side | File | Symbol |
| --- | --- | --- |
| Web | [web/src/state/syncleStore.ts](../web/src/state/syncleStore.ts) | `NICKNAME_MAX_LEN`, `isValidNickname` |
| Server | not currently enforced — server accepts whatever the client sends |

If the server adds nickname validation later, mirror these bounds.

## Color (accent)

| Property | Value |
| --- | --- |
| Format | CSS hex string, e.g. `#4F8EF7` |
| Palette | 8 fixed swatches |

| Side | File | Symbol |
| --- | --- | --- |
| Web | [web/src/state/syncleStore.ts](../web/src/state/syncleStore.ts) | `PALETTE` |
| Server | passes the value through — no validation |

## /v1/sessions request

```
POST /v1/sessions
Content-Type: application/json

{
  "deviceId":  string,        // stable per-device UUID
  "nickname":  string,        // display name
  "color":     string,        // "#RRGGBB"
  "room":      string         // matches room regex above
}
```

Response (200):

```
{
  "serverUrl": "ws://...",
  "token":     string,         // LiveKit JWT
  "userId":    string,         // server-assigned identity
  "nickname":  string,
  "color":     string,
  "expiresAt": number          // epoch ms when the token expires
}
```

Client behavior on token expiry: the reconnect loop refreshes the JWT when
`expiresAt - now < 60_000` ms before the next LiveKit connect attempt
(see `web/src/data/connectionController.ts`).

## LiveKit participant attributes

Per-participant key/value strings published via
`LocalParticipant.setAttributes(...)` and observed by remotes via
`RoomEvent.ParticipantAttributesChanged`. The web client MUST use the keys
below verbatim; the server does not validate them.

| Key | Type | Purpose | Empty-string meaning |
| --- | --- | --- | --- |
| `table_id` | string | Currently seated table id. Drives the sit-at-table meeting feature. | "explicitly stood up" (cleared) |
| `nickname` | string | Display name. Falls back to LiveKit identity when missing. | "not published" — keep existing |
| `color`    | string | `#RRGGBB` accent color for avatar. Falls back to a default. | "not published" — keep existing |
| `character`| string | Sprite character id (pixel-art avatar). | "not published" — keep existing |

### Where it lives

| Side | File | Symbol |
| --- | --- | --- |
| Web | [web/src/data/liveKitService.ts](../web/src/data/liveKitService.ts) | `setTableAttribute`, `publishProfileAttributes` |

### Required server grant

The JWT must include `canUpdateOwnMetadata: true` for clients to be allowed
to call `setAttributes`. Without it, LiveKit responds with
`SignalRequestError: does not have permission to update own metadata`.
See [server/src/livekit.ts](../server/src/livekit.ts).

## Zones (M1: quiet semantics)

Syncle is a **virtual study room**: the default assumption is quiet, not
"walk up and talk". Zones carry an acoustic policy (`kind`) that overrides
the table conversation behavior. `meeting` semantics are folded into
`discussion`; `restricted` is reserved for P1.

### Zone kind

| Kind | Meaning | Audio policy |
| --- | --- | --- |
| `silent` | Study area. Quiet by default. | Forced mute on entry; server does not forward this participant's audio. Exception: push-to-talk (below). |
| `discussion` | Discussion area. Talking allowed. | Distance-attenuated proximity voice (see below). |
| `rest` | Lounge/break area. Talking allowed. | Same audio policy as `discussion` (distinct kind for map semantics and stats). |
| `none` | Not inside any zone. | Treated as `discussion` (preserves pre-M1 behavior). |

Map config: every zone object gains a **required** `kind` field. Zones without
`kind` (old maps) parse as `discussion` for backward compatibility. The map
editor MUST allow annotating `kind`.

**Precedence: zone policy > table policy.** Sitting at a table (`table_id`
non-empty) inside a `silent` zone still forces mute. The table remains the
conversation *unit* (who is grouped together); the zone is the outer
*acoustic* semantic.

### Microphone state machine (client-side)

Logical mic states: `MUTED`, `LIVE` (published and audible), `PTT`
(push-to-talk, temporary).

| Current zone | Policy |
| --- | --- |
| `silent` | Forced `MUTED`. Exception: holding **Space** enters `PTT` (mic-only, temporary publish); releasing Space returns to `MUTED`. PTT has no effect in other zones. |
| `discussion` / `rest` / `none` | User toggle decides `MUTED` / `LIVE`. |

Transitions the client MUST implement:

- `enter(silent)` → `forceMute()`: remember pre-entry user intent
  (`intendedMicOn: boolean`), then mute.
- `leave(silent)` → if `intendedMicOn` was true AND the new zone allows
  audio, restore `LIVE`; otherwise stay `MUTED`.

### Distance attenuation (discussion / rest / none)

Ported from the former Android `SpatialAudioEngine` (removed 2026-09-29);
web and server use identical constants. This **replaces** the old web binary gate
(`audible = sameTable ? 1 : 0`); table membership no longer decides
audibility.

| Constant | Value |
| --- | --- |
| `maxDistance` | `300` (map px) |
| Volume | `v = clamp(1 - dist / maxDistance, 0, 1)` (linear) |
| Beyond max | `v = 0` → not audible (client SHOULD unsubscribe / set volume 0) |

### Server-side media isolation

The server derives each participant's zone kind from the `zone_kind`
it receives in state reports (see below):

- On entering `silent`: resolve the participant's published microphone
  track SID via `listParticipants` (track source `MICROPHONE`), then call
  LiveKit Server API `mutePublishedTrack(room, identity, trackSid, true)`.
  Server-side mute wins even if the client misbehaves. No mic track
  published (quiet-by-default join) → nothing to mute.
- On leaving `silent`: `mutePublishedTrack(..., false)` to restore, but only
  if the participant's remembered intent was mic-on (server keeps
  `intendedMicOn` in memory per participant).
- PTT windows are not server-muted (short-lived; abuse is covered by the M2
  moderation loop).

### Transport

- **Position packet (17 bytes) is UNCHANGED**: `type=1 | x:f32 | y:f32 | seq:i64`.
  Zone changes are low-frequency; they do not belong on the 20 Hz hot path.
- **Participant attributes** (realtime, via `setAttributes`; keys verbatim):

| Key | Type | Purpose | Empty-string meaning |
| --- | --- | --- | --- |
| `zone` | string | Id of the zone the participant is currently inside | "not inside any zone" |
| `zone_kind` | string | `silent` \| `discussion` \| `rest` \| `none` | "not published" — keep existing |

Clients MUST update `zone` / `zone_kind` when crossing a zone boundary
(debounced: do not rewrite attributes for movement inside the same zone).

- **State report** `POST /v1/rooms/:room/state` body gains:
  `zone: string | null` (zone id; `null` when in no zone) and
  `zone_kind: "silent" | "discussion" | "rest" | "none"` (client-computed;
  the server trusts it for mute decisions — the server does not load map
  files, and abuse is covered by the M2 moderation loop).
- **Snapshot** `GET /v1/rooms/:room/snapshot` peer entries gain
  `zone` / `zone_kind` (same semantics as the attributes above).

### "Quiet by default" publish principle

- On room join, clients publish **no** microphone/camera tracks.
- Mic MAY be published when ANY of: (a) seated at a table AND zone is
  `discussion`/`rest`/`none`; (b) PTT held in a `silent` zone (mic only);
  (c) user manually enables mic in `discussion`/`rest`.
- Camera MAY be published only in (a)/(c) with explicit user opt-in; never
  in `silent` zones.
- Screen share is allowed only in `discussion` zones.

### Where it lives

| Side | File | Symbol |
| --- | --- | --- |
| Web | `web/src/domain/zones.ts` | `ZoneKind`, `kind` field, policy helpers |
| Web | `web/src/data/liveKitService.ts` | `setZoneAttributes`, distance attenuation |
| Web | `web/src/data/sessionApi.ts` | `reportState` (zone-bearing state reports: on boundary crossing + 30s heartbeat) |
| Server | `server/src/routes/state.ts` | `zone` field ingestion |
| Server | `server/src/livekit.ts` | server-side mute helper |
