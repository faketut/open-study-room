# Open Study Room shared contracts

> **Changelog — 2026-09-29**: project renamed from **Syncle** to **Open Study Room**
> (repo `faketut/Syncle` → `faketut/open-study-room`). Only user-facing names
> changed; internal identifiers (file names, store/hook names, CSS classes,
> storage keys) intentionally keep the old naming to avoid churn.

Authoritative definitions for values that MUST be kept in sync between the
**Web client** (`web/`) and the **Node backend** (`server/`). If you change
one side, change the other in the same PR.

> **Changelog — 2026-09-29**: the Kotlin Android client (`app/`) was removed.
> Open Study Room is now web + server only. Mobile goes through phone browsers
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

## Position broadcast AOI (M4)

Wire format unchanged: 17-byte position packet (`type=1 | x:f32 | y:f32 | seq:i64`,
see [web/src/domain/positionPacket.ts](../web/src/domain/positionPacket.ts)).

Rationale: LiveKit data channels are room-broadcast — the SFU fans every
publish out to all N−1 peers. There is no per-peer targeting, so the cost
lever is **publish rate**, not selective delivery. AOI is therefore
**sender-side tiering** by relevance. (Render-side culling of offscreen
avatars is a separate client concern and changes no wire behavior.)

### Tiers (by distance to nearest known peer)

| Tier | Condition | Rate |
| --- | --- | --- |
| `NEAR` | nearest known peer < 1600 px | 20 Hz (`POSITION_BROADCAST_HZ`) |
| `MID` | 1600–4000 px | 5 Hz |
| `FAR` | > 4000 px, or no known peers | 1 Hz heartbeat |

"Known peers" = positions from received data packets + `GET
/v1/rooms/:room/snapshot`. The 1600 px NEAR radius covers the viewport
(~1100 px half-diagonal at 1080p) + ~400 px margin.

Constants (frozen): `AOI_NEAR_PX = 1600`, `AOI_MID_PX = 4000`,
`AOI_NEAR_HZ = 20`, `AOI_MID_HZ = 5`, `AOI_FAR_HZ = 1`.

### Idle suppression

Stationary (position unchanged since last publish) → 0 Hz; resume immediately
on the first changed tick. Pre-existing behavior, now contract.

### Bypasses (publish immediately, ignore tier)

- Portal teleport / spawn position (peers must not see the avatar slide).
- Zone-boundary `zone` / `zone_kind` attribute updates (M1) ride attributes,
  not the position hot path.

### Orthogonality

- M1 zone mute policy and M2 block filtering are unaffected: AOI changes only
  the *rate* of position packets, never who may speak or who is filtered.
- M2 local block stays receiver-side ignore (localStorage); AOI never reveals
  or hides anyone.

### Where it lives

| Side | File | Symbol |
| --- | --- | --- |
| Web | [web/src/domain/aoiPolicy.ts](../web/src/domain/aoiPolicy.ts) | `tierForDistance`, `hzForTier`, `AOI_*` constants (pure, unit-tested) |
| Web | [web/src/ui/SyncleScreen.tsx](../web/src/ui/SyncleScreen.tsx) | tiered publish loop (replaces fixed 20 Hz) |

## Zones (M1: quiet semantics)

Open Study Room is a **virtual study room**: the default assumption is quiet, not
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

## Moderation (M2: stranger safety)

Open Study Room is a public room: strangers walk in. M2 adds the minimum
viable safety loop — **report → review → act** — while staying honest about
the architecture: chat travels peer-to-peer over the LiveKit data channel, so
the server can never see, filter, or throttle chat content. Everything the
server *can* do (REST, JWT issuance, LiveKit Server API) is specified below;
everything else is client-side, and the contract says so explicitly.

### 1. Role model

Roles: `host` > `admin` > `user`.

| Rule | Value |
| --- | --- |
| Who is host | The **first** user to join a room (first successful `POST /v1/sessions` for that room). The server records it in the DB at session issuance. |
| Host transfer | The current host may transfer host to another room member (`POST /v1/rooms/:room/host`). The old host becomes `user`. |
| admin | **Placeholder only.** M2 has no login; sessions are device-based. `admin` carries no permissions in M2 and cannot be granted until the P1 identity system lands. |

#### The single security rule that everything else depends on

> **The DB is the only source of truth for roles.** The LiveKit participant
> attribute `role` (below) is a UI display hint. The server MUST resolve the
> caller's role from `room_roles` on every moderation request and MUST NEVER
> trust a client-supplied role — the client holds `canUpdateOwnMetadata` and
> can forge any attribute.

#### `room_roles` table

```sql
CREATE TABLE IF NOT EXISTS room_roles (
  room       TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('host', 'admin')),
  granted_by TEXT,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (room, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_room_roles_room ON room_roles(room);
```

- Only `host` / `admin` rows are stored. **No row ⇒ the user is a plain `user`.**
- `granted_by`: userId of the host who granted the role (`NULL` for the
  first-joiner host, which nobody granted); `granted_at`: epoch ms.
- `POST /v1/sessions` response gains `role: "host" | "user"` (the caller now
  knows their own role for UI).
- **LiveKit participant attribute `role`** (values `host` / `admin` / `user`,
  default `user`): the client publishes it from the sessions response via
  `setAttributes` for peer badges only. The server never reads it.

#### Where it lives (M2 implementation targets)

| Side | File | Symbol |
| --- | --- | --- |
| Server | `server/src/db.ts` | `room_roles` schema + `getRoomRole` / `setRoomRole` helpers |
| Server | `server/src/routes/sessions.ts` | first-joiner host assignment |
| Web | `web/src/data/liveKitService.ts` | publish `role` attribute (display only) |

### 2. Reports data model

```sql
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,          -- uuid
  room        TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('spam','harassment','nsfw','other')),
  detail      TEXT,                      -- optional free text, max 500 chars
  created_at  INTEGER NOT NULL,          -- epoch ms
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  handled_by  TEXT,                      -- host userId who closed it
  handled_at  INTEGER,                  -- epoch ms
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id)   REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reports_room_status ON reports(room, status, created_at);
```

- `reason` enum: `spam` | `harassment` | `nsfw` | `other`.
- **State machine**: `open → actioned` or `open → dismissed`. Both end states
  are terminal; no transition back to `open`, no transitions between the end
  states. Closing a non-`open` report is a `409 already_handled`.
- `detail` is optional, max 500 chars (server enforces, mirrors `CHAT_TEXT_MAX_LEN`).
- Any joined room member may file a report. Report creation is rate-limited
  (see §4); the host lists and closes reports via REST (§6).

### 3. Enforcement actions

#### 3a. Mute (moderation mute) vs zone mute — two layers, never leaking into each other

There are **two independent mute layers**. Their union decides whether a mic
track is server-muted:

- **Layer Z (zone mute)** — transient, from the M1 zone edge detector
  (silent zone entry/exit). Never persisted.
- **Layer M (moderation mute)** — persisted in the `mutes` table:

```sql
CREATE TABLE IF NOT EXISTS mutes (
  room      TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  muted_by  TEXT NOT NULL,               -- host userId (audit: who)
  muted_at  INTEGER NOT NULL,            -- epoch ms (audit: when)
  PRIMARY KEY (room, user_id),
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (muted_by) REFERENCES users(id)  ON DELETE CASCADE
);
```

Mechanics: server calls `RoomMutator.muteMicrophone` /
`RoomMutator.unmuteMicrophone` (LiveKit `mutePublishedTrack` by resolved mic
track SID, as in M1).

**Composition rules (normative):**

1. Effective state = muted iff (row in `mutes`) OR (zone policy says mute).
2. Zone **enter**(`silent`): mute the track. Does NOT touch `mutes`.
3. Zone **leave**(`silent`): unmute the track **only if there is no row in
   `mutes` for that user** — the moderation mute survives zone movement.
   (The M1 "restore on leave" logic gains this one guard clause.)
4. Moderation **mute**: insert into `mutes`, then `muteMicrophone` (if a mic
   track is published).
5. Moderation **unmute**: delete the `mutes` row, then re-apply the zone
   policy — if the user's current `zone_kind` (from `room_state`) is
   `silent`, the track stays muted under Layer Z; otherwise unmute.
6. A muted user who rejoins keeps Layer M (the row is keyed by `user_id`,
   which is stable per device). The server re-applies it when it next sees
   their mic track; clients SHOULD also self-enforce from the sessions
   response until then.

#### 3b. Kick

- Server sends a reliable data-channel notice to the target's LiveKit
  identity, then calls `removeParticipant(room, identity)` (available on
  `RoomServiceClient`).
- **Kick notice wire format** (JSON over `RoomServiceClient.sendData`,
  reliable, destination = target identity):
  `{"type":"kick_notice","reason":"..."}` — `reason` is the host-supplied
  reason (max 140 chars) or empty string. The client MUST render an explicit
  "You were removed by the host" screen with this reason, not a generic
  connection error. (If the disconnect lands before the notice, the client
  falls back to a generic "removed from room" message.)
- **Same-UTC-day rejoin refusal** — `kicks` table:

```sql
CREATE TABLE IF NOT EXISTS kicks (
  room      TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  kicked_by TEXT NOT NULL,               -- host userId (audit: who)
  kicked_at INTEGER NOT NULL,            -- epoch ms (audit: when)
  day       TEXT NOT NULL,               -- UTC date 'YYYY-MM-DD' (audit + expiry)
  reason    TEXT,                        -- host-supplied reason, max 140 chars
  PRIMARY KEY (room, user_id),
  FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (kicked_by) REFERENCES users(id) ON DELETE CASCADE
);
```

- `POST /v1/sessions` MUST check `kicks` **before** issuing a token: if a row
  exists for (room, user_id) whose `day` equals today's UTC date → `403
  { error: "kicked" }`. The block expires automatically at the next UTC day
  boundary (no cleanup job needed; stale rows are inert).

#### 3c. Ban

**Not in M2.** Explicitly deferred to P1. The `moderate` endpoint accepts only
`mute | unmute | kick`; `action: "ban"` returns `400 { error:
"invalid_action" }`. No ban table, no ban endpoint.

#### 3d. Protection against mistakes

- **UI double-confirm**: the host client MUST show a destructive-action
  confirm dialog before calling `moderate` with `mute` or `kick`
  (dialog shows target nickname + action + reason field). This is a client
  requirement; the server does not second-guess.
- **Audit trail**: every action writes who/when — `mutes.muted_by/at`,
  `kicks.kicked_by/at/day`, `reports.handled_by/at`, `room_roles.granted_by/at`.
- **The kicked/muted user sees a clear reason**: kick notice packet (§3b);
  for mutes the client shows a "muted by host" indicator.

### 4. Rate limiting and filtering (architecture-honest)

#### What the server cannot do

Chat travels **peer-to-peer** over the LiveKit data channel
(`publishReliable` in `web/src/data/liveKitService.ts`; wire format in
`web/src/domain/chatPacket.ts`). The server never sees chat bytes, so it
**cannot rate-limit, filter, or censor chat**. The contract does not pretend
otherwise:

- **Client-side chat send throttle (normative):** at most **1 message per
  2 seconds** (`CHAT_SEND_MIN_INTERVAL_MS = 2000`). Faster sends go into a
  FIFO of max 3 (`CHAT_QUEUE_MAX = 3`); overflow is dropped and the UI shows
  a "sending too fast" toast. This is per client, best-effort — a hostile
  client can bypass it, and the moderation loop (§2–3) is the backstop.
- **Server rate limits cover REST only.** Follow the `sessions.ts` pattern:
  `@fastify/rate-limit` registered in a scoped plugin. Suggested defaults
  (server config may tune):
  - `POST /v1/rooms/:room/reports` — 10/min per caller
  - `POST /v1/rooms/:room/moderate` — 30/min per caller
  - `POST /v1/rooms/:room/host` — 10/min per caller
  - `GET /v1/rooms/:room/reports` — 60/min per caller

#### Nickname validation (server-side, new in M2)

Supersedes the Nickname section's "server accepts whatever the client sends"
row. `POST /v1/sessions` MUST validate the nickname:

1. `trim().length` in **1–32** (tightens the current server-side 40 to match
   web `NICKNAME_MAX_LEN`; update the zod schema).
2. **Sensitive-word check** against `server/src/moderation/words.ts`
   (minimal CN+EN list). Match rule: case-insensitive; Latin entries match
   on word boundaries (so `class` does not trip on `ass`); CJK entries match
   as substrings. Violation → `400 { error: "nickname_rejected" }`
   (no matched word echoed back).
3. The web client pre-validates locally with the same rule before sending.
4. Tests MUST cover both hits and false-positive boundaries (e.g. a word
   containing a Latin entry as a substring must NOT be rejected).

#### Chat content filter (client-side, pre-send)

- The sender replaces each matched word with `*` repeated to the word's
  length, using the same `words.ts` source and the same match rule as
  nicknames, **before** `encodeChat`.
- **Source sync (normative):** `server/src/moderation/words.ts` is the single
  source of truth. The web build copies it to `web/src/data/moderationWords.ts`
  at build time (prebuild step); a repo-level test asserts the copy is
  byte-identical to the source so the two filters can never drift.

### 5. Local block (T5) — client-only

Blocking is purely local: the blocked user is never notified, and the server
knows nothing about it.

- **Storage key:** `syncle.blocked.<room>` (keeps the legacy `syncle` prefix
  per the naming freeze at the top of this document). Value: JSON array of
  blocked `userId` strings. Unblocking removes the id; the change takes
  effect immediately.
- **Filter points** (all on the receiving client, keyed by the sender's
  LiveKit identity / `userId`):
  - **Audio:** `setSubscribed(identity, false)` (saves bandwidth) **and**
    `setVolume(identity, 0)` as a belt-and-braces guard — see
    `web/src/data/liveKitService.ts`.
  - **Chat:** drop `decodeChat` payloads from blocked senders before they
    reach the chat store/render path (all scopes, including `dm`).
  - **Reactions:** reactions ride the chat packet — dropped at the same
    filter point as chat.

### 6. REST endpoint shapes

Common auth for every endpoint below: `Authorization: Bearer <LiveKit JWT>`
→ `extractBearer` → `verifyJoinToken(apiSecret)` → caller `userId =
payload.sub`. Then: if `payload.video.room` is set and ≠ `:room` →
`403 { error: "room_mismatch" }`. Then the role check reads **`room_roles`
from the DB** (§1 rule). Shared error codes: `401 { error:
"missing_bearer" }`, `401 { error: "invalid_token" }`, `403 { error:
"not_host" }` (caller is not host/admin), `400 { error: "invalid_body" }`.

#### `POST /v1/rooms/:room/reports` — file a report

- Auth: any joined member (valid token, room matches). Rate-limited (§4).
- Body: `{ "targetId": string, "reason": "spam"|"harassment"|"nsfw"|"other", "detail"?: string }`
  (`detail` max 500 chars; `targetId` must be a known user → else
  `404 { error: "target_not_found" }`).
- Errors: `400 { error: "invalid_reason" }`.
- Success: `201 { "id": "<uuid>", "status": "open" }`.

#### `GET /v1/rooms/:room/reports` — list reports

- Auth: host/admin only (DB role check).
- Query: `?status=open` (default) | `all`.
- Success: `200 { "reports": [ { "id", "reporterId", "reporterNickname", "targetId", "targetNickname", "reason", "detail", "createdAt", "status", "handledBy", "handledAt" } ] }`
  ordered by `created_at ASC`.

#### `POST /v1/rooms/:room/reports/:id/action` — close a report

- Auth: host/admin only.
- Body: `{ "decision": "actioned" | "dismissed" }`.
- Effects: sets `status`, `handled_by = caller`, `handled_at = now`. Closing
  does NOT itself mute/kick — the host then calls `moderate` separately.
- Errors: `404 { error: "report_not_found" }`, `409 { error:
  "already_handled" }` (status ≠ `open`).
- Success: `200 { "id", "status": "actioned"|"dismissed" }`.

#### `POST /v1/rooms/:room/moderate` — mute / unmute / kick

- Auth: host/admin only (DB role check). Rate-limited (§4).
- Body: `{ "targetUserId": string, "action": "mute" | "unmute" | "kick", "reason"?: string }`
  (`reason` max 140 chars; used for the kick notice and the `kicks` row).
- Rules:
  - `targetUserId` ≠ caller → else `400 { error: "cannot_target_self" }`.
  - Target must hold no `host` row → else `400 { error: "target_is_host" }`
    (transfer host first).
  - `action: "ban"` (or anything else) → `400 { error: "invalid_action" }`.
  - `mute`: idempotent — inserting an existing `(room, user_id)` is a
    no-op success; calls `muteMicrophone`.
  - `unmute`: deletes the `mutes` row (no-op if absent), then re-applies
    the zone policy per §3a rule 5.
  - `kick`: sends `kick_notice` (reliable data) then `removeParticipant`,
    then inserts/refreshes the `kicks` row (same-day re-kick refreshes
    `kicked_at`/`reason`).
- Success: `200 { "action": "<action>", "targetUserId": "<id>" }`.

#### `POST /v1/rooms/:room/host` — transfer host

- Auth: current host only (caller must hold the `host` row; an `admin`
  placeholder cannot transfer).
- Body: `{ "toUserId": string }`.
- Rules: `toUserId` must be a current room member — i.e. a fresh row in
  `room_state` for this room (reuse the snapshot freshness window) — else
  `404 { error: "member_not_found" }`. Cannot transfer to self
  (`400 { error: "invalid_body" }`).
- Effects (atomic): delete caller's `room_roles` row; insert
  `(room, toUserId, 'host', granted_by = caller, granted_at = now)`.
- Success: `200 { "host": "<toUserId>" }`.

### Self-consistency checklist (for the M2 implementer)

Tables: `room_roles`, `reports`, `mutes`, `kicks` — each referenced exactly
where used above, no other tables. Endpoints: five, all under
`/v1/rooms/:room/`, all bearer-authenticated against the DB role. State
machine: `open → actioned/dismissed` only. Layers: zone mute and moderation
mute compose by union and are lifted independently (§3a rules 1–6).
Ban: absent by design. Wordlist: one source file, one build-time copy, one
drift test. Block list: one localStorage key, three filter points, zero
server knowledge.

## Focus loop (M3: pomodoro + stats + sit ritual)

The core retention loop of a study room: sit down → focus (pomodoro) →
peers see "focusing 18:32" → stats/streak. **Server time is authoritative**
for everything streak-related (clients can lie; the DB cannot).

### 1. `focus_sessions` table (frozen)

```sql
CREATE TABLE IF NOT EXISTS focus_sessions (
  id             TEXT PRIMARY KEY,   -- uuid
  user_id        TEXT NOT NULL,
  room           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('focus', 'break')),
  planned_minutes INTEGER NOT NULL CHECK (planned_minutes BETWEEN 1 AND 180),
  started_at     INTEGER NOT NULL,   -- epoch ms, server clock
  ends_at        INTEGER NOT NULL,   -- started_at + planned_minutes * 60000, server clock
  ended_at       INTEGER,            -- epoch ms, NULL while active
  completed      INTEGER NOT NULL DEFAULT 0,  -- 1 only via the completion rule below
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_started
  ON focus_sessions(user_id, started_at);
```

- **At most one active session per user** (`ended_at IS NULL`). Starting a
  new session first settles any existing active one as interrupted
  (`ended_at = now`, `completed = 0`).
- **Completion rule (server-decided, normative):** on end, `completed = 1`
  iff `ended_at >= ends_at - 60_000` (60 s grace for "finished a bit early").
  Manual early end → `completed = 0`. The client's `completed` hint is
  ignored; the server recomputes from its own clock.
- **Lazy settle of abandoned sessions:** whenever the server reads a user's
  active session (start / active / stats), it first settles any session with
  `ends_at < now - 300_000` as `ended_at = ends_at, completed = 0`
  (5 min grace covers reconnects and clock skew). No background job.
- Only `kind = 'focus'` sessions count toward stats/streak. Breaks are
  recorded for honesty but excluded from every aggregate.

### 2. Pomodoro state machine (client)

Phases: `idle → focusing → idle`, and `idle → on_break → idle`.
`focusing` and `on_break` never transition into each other directly —
finishing a focus session returns to `idle`; the client may auto-offer a
break (UI choice, not a state transition).

| Event | From | To | Side effects |
|---|---|---|---|
| `start(kind, minutes)` | `idle` | `focusing` / `on_break` | REST start; publish `focus` attribute; start local 1 s ticker |
| `timer_reached_end` | `focusing` / `on_break` | `idle` | REST end; clear attribute; local notification |
| `user_end_early` | `focusing` / `on_break` | `idle` | REST end (server marks `completed = 0`); clear attribute |
| `stand_up` (table_id cleared) | `focusing` | `idle` | Same as `user_end_early` (interrupted) |
| `disconnect` | any active | — | No client action; server lazy-settles (§1) |
| `reconnect` | — | resume | `GET active` → if a session is still live, resume ticker from server `ends_at` |

### 3. Focus presence attribute

LiveKit participant attribute **`focus`** (new key; no conflict with M1's
`status` / `zone_kind` / `table_id`):

| Value | Meaning |
|---|---|
| `""` (empty / cleared) | idle — not focusing |
| `focusing:<sec>` | focusing, `<sec>` = remaining seconds at publish time |
| `break:<sec>` | on break, `<sec>` = remaining seconds at publish time |

- The client publishes on start/end and on a **30 s heartbeat** while
  active. Receivers tick the countdown down locally every second from the
  last published value (no per-second broadcast).
- Display: peers render `专注中 18:32` / `休息中 04:12` from
  `parseFocusAttribute`.
- `web/src/data/liveKitService.ts` gains `setFocusAttribute(room, value)`.
- `avatarStatus.ts`: `StatusInputs` gains optional `focusing?: boolean`;
  `deriveStatus` returns `"focus"` when `focusing` is true (checked after
  `manualBusy`, before `meeting`) so an active pomodoro always shows the
  focus pill even when the mic logic would say otherwise.

### 4. REST endpoint shapes

Common auth: `Authorization: Bearer <LiveKit JWT>` → `extractBearer` →
`verifyJoinToken(apiSecret)` → `payload.sub` is the caller. For
`/v1/rooms/:room/...`, `payload.video.room` must equal `:room` else
`403 { error: "room_mismatch" }`. Rate limit: 30/min per caller (follows the
moderation `moderate` default).

#### `POST /v1/rooms/:room/focus/sessions` — start

- Body: `{ "kind": "focus" | "break", "plannedMinutes": number }`
  (`plannedMinutes` 1–180 else `400 { error: "invalid_body" }`).
- Server: lazy-settles stale actives, inserts the row with server `now`,
  returns `201 { "id", "kind", "plannedMinutes", "startedAt", "endsAt" }`.

#### `POST /v1/rooms/:room/focus/sessions/:id/end` — end

- Body: `{}` (empty; the server decides `completed` via §1).
- Rules: unknown id → `404`; id belongs to another user → `403`;
  already ended → `200` with the stored result (idempotent).
- Success: `200 { "id", "completed": 0|1, "durationSec": number }`.

#### `GET /v1/rooms/:room/focus/active` — resume on (re)join

- Success: `200 { "session": null | { "id", "kind", "plannedMinutes", "startedAt", "endsAt" } }`.
- The client calls this after LiveKit connect; a live session resumes the
  local ticker and the `focus` attribute.

#### `GET /v1/users/:userId/focus/stats?tzOffsetMin=<int>` — stats

- Auth: bearer; `:userId` MUST equal the caller (`payload.sub`), else
  `403 { error: "forbidden" }` (stats are private in M3).
- `tzOffsetMin`: minutes east of UTC, e.g. Beijing `480`
  (client sends `-new Date().getTimezoneOffset()`); defaults to `0`.
  Day boundaries are computed as UTC midnight shifted by this offset.
- Success: `200 { "todaySec", "weekSec", "streakDays",
  "totalCompletedSessions", "last7Days": [{ "day": "YYYY-MM-DD", "seconds" }] }`
  where `todaySec`/`weekSec`/`last7Days` sum **completed** focus sessions
  only, and `day` strings are in the caller's tz.

#### Streak rule (normative)

- A calendar day (in the caller's tz) counts iff it contains ≥ 1 completed
  focus session.
- `streakDays` = number of consecutive counted days ending today; if today
  is uncounted but yesterday is counted, the streak runs through yesterday
  (standard grace — the streak is not yet broken).

### 5. Sit ritual (T11)

- Sitting down (`table_id` set, non-empty): the client shows a one-tap
  **"开始专注"** entry (prompt/button near the HUD, touch-friendly per
  MW1). **No auto-start** — the user taps to begin.
- Standing up (`table_id` cleared) while `focusing`: the client ends the
  session immediately (`completed = 0`, interrupted).
- Leaving the room / closing the tab: best-effort `end` on `beforeunload`;
  the server lazy-settle (§1) is the backstop.

### 6. Notifications

On `timer_reached_end` the client fires a local notification:
`Notification` API when permission is granted (desktop + Android Chrome),
always accompanied by an in-app toast/banner (covers iOS Safari and denied
permission). No server push in M3.

### Where it lives (M3 implementation targets)

| Side | File | Symbol |
|---|---|---|
| Server | `server/src/db.ts` | `focus_sessions` schema + `startFocusSession` / `endFocusSession` / `getActiveFocusSession` / `settleStaleFocusSessions` / `getFocusStats` (+ `FocusSessionRow`) |
| Server | `server/src/routes/focus.ts` | four endpoints above |
| Server | `server/src/server.ts` | `registerFocusRoutes` |
| Web | `web/src/domain/pomodoro.ts` | `PomodoroPhase`, `createPomodoro`, `parseFocusAttribute` / `serializeFocusAttribute`, `formatRemaining` |
| Web | `web/src/data/focusApi.ts` | `startFocusSession` / `endFocusSession` / `getActiveFocusSession` / `getFocusStats` |
| Web | `web/src/state/pomodoroStore.ts` | zustand store: phase, endsAt, 1 s ticker, attribute publish |
| Web | `web/src/data/liveKitService.ts` | `setFocusAttribute` |
| Web | `web/src/domain/avatarStatus.ts` | `StatusInputs.focusing` |
| Web | `web/src/ui/FocusStatsPanel.tsx` | 今日/本周/连续 streak panel |
| Web | `web/src/ui/SyncleScreen.tsx` | sit prompt wiring + stats entry point |

## Map templates (P1-A: official template pack)

A curated set of ready-to-use study-room maps. Users pick one on the
JoinScreen; template authors add new ones by dropping a JSON file. P1-A
freezes the **file format, metadata schema, selection flow, and quality
gates** below. Building the actual template files and the JoinScreen
picker UI is follow-up work by template-author workers — this section is
the contract they build against.

### 1. Format decision (frozen)

Templates reuse the **objects-style procedural JSON** already consumed by
`loadMapConfig` (`web/src/domain/mapConfig.ts`, style (B) in
`web/src/types/mapConfig.ts`). Rationale: no new parser, no new renderer
path, and the existing `MapObjectType` / `SOLID_TYPES` / zone-kind
machinery applies unchanged.

**No Tiled / WAM compatibility.** Templates are hand-authored in our own
schema. We do not parse Tiled exports (`.tmx` / Tiled JSON) or
WorkAdventure WAM files, and P1 adds no converter. A template file that
is not valid per §2–§3 is rejected by the validator (§5).

A template file is a single JSON object: **RawMapConfig-shaped, plus two
top-level additions** — a `template` metadata block and a `spawn_points`
array. Because the additions are unknown keys to `loadMapConfig`, the
existing loader works on template URLs unchanged.

```jsonc
{
  // --- (a) template metadata (required) ---
  "template": {
    "id": "library",
    "name": { "en": "Library", "zh": "图书馆" },
    "description": {
      "en": "A quiet reading hall with long shared desks.",
      "zh": "安静的阅读大厅，长条共享书桌。"
    },
    "thumbnail": "thumbnails/library.png"   // optional, see §2
  },

  // --- (b) map body: RawMapConfig procedural subset (required) ---
  "map_name": "Library",
  "width": 1000,
  "height": 800,
  "background_color": "#2b2f3a",
  // ...or "background_image": "library.jpg" (procedural preferred)

  "objects": [
    { "type": "zone", "id": "zone-reading", "label": "Reading Hall",
      "kind": "silent", "x": 40, "y": 40, "width": 920, "height": 560 },
    { "type": "zone", "id": "zone-lounge", "label": "Lounge",
      "kind": "rest", "x": 40, "y": 620, "width": 920, "height": 140 },
    { "type": "wall", "x": 0, "y": 0, "width": 1000, "height": 24 },
    { "type": "table", "id": "table-a1", "label": "A1",
      "x": 120, "y": 120, "width": 160, "height": 80 },
    { "type": "plant", "x": 60, "y": 60, "width": 36, "height": 36 },
    { "type": "rug", "x": 80, "y": 80, "width": 840, "height": 480,
      "color": "#35324a" }
  ],

  // --- (c) spawn points (required, ≥1) ---
  "spawn_points": [{ "x": 500, "y": 740 }]
}
```

### 2. Metadata (`template` block)

| Field | Type | Required | Rule |
|---|---|---|---|
| `id` | string | yes | kebab-case: `^[a-z0-9]+(-[a-z0-9]+)*$`. MUST equal the file name (`<id>.json`). |
| `name` | `{ en: string, zh: string }` | yes | Bilingual display name; both strings non-empty. |
| `description` | `{ en: string, zh: string }` | yes | One sentence per language; both non-empty. Shown on the picker card. |
| `thumbnail` | string | no | Relative path **inside** `/templates/` (e.g. `thumbnails/library.png`). When **missing**, the picker renders a placeholder color block (hue derived from the id), **never** a broken `<img>`. Absolute URLs are a validator warning (§5). |

### 3. Map body (procedural subset)

Minimal field table for template authors:

| Field | Required | Notes |
|---|---|---|
| `map_name` | yes | Non-empty; display fallback. |
| `width`, `height` | yes | Numbers, finite, > 0 (world px). |
| `background_color` | yes, unless `background_image` | CSS color string, non-empty. At least one of the two MUST be present. |
| `background_image` | no | Painted-bitmap alternative; templates SHOULD prefer procedural (no image) so they render with zero assets. |
| `objects` | yes | Typed entities, see below. |
| `spawn_points` | yes | Array of `{ x, y }`, length ≥ 1. |

Object rules for templates:

- `type` MUST be one of the frozen `MapObjectType` union (`wall`,
  `table`, `desk`, `plant`, `cabinet`, `chair`, `door`, `rug`, `note`,
  `zone`, `portal`, `board`). Unknown types are a validation error.
- `zone` objects MUST carry an explicit `kind` of `silent`,
  `discussion`, or `rest`. **Templates do not inherit the legacy
  kind-missing default** (contracts.md "Zones (M1)" normalizes missing
  kinds to `discussion` for old maps); a template zone without a valid
  `kind` fails validation. `none` is never authored.
- `table` / `desk` objects MUST carry a unique non-empty `id`
  (table-join key; `loadMapConfig` drops id-less object tables).
- Any object MAY set `sprite` (key into `ui/spriteAtlas.ts` `SPRITES`).
  The validator cannot check catalog membership from JSON, so it emits a
  **warning** reminding the author to verify the key exists.
- Solid types blocking movement are exactly `SOLID_TYPES`
  (`wall`, `table`, `desk`, `plant`, `cabinet`) — same set the renderer
  and `isWalkable` use.
- Legacy fields (`walkable_areas`, top-level `tables`,
  `collision_settings`) are ignored for templates; authors use
  `objects` + `spawn_points`.

### 4. Selection flow (frozen)

1. **Authoring location (source of truth):** `assets/templates/<id>.json`
   (+ optional `assets/templates/thumbnails/`). `web/scripts/sync-assets.mjs`
   copies `assets/templates/` → `web/public/templates/` on `predev` /
   `prebuild`, so dev and build serve identical files at
   `/templates/<id>.json`. **If `assets/templates/` does not exist the
   script skips it without error** (template-author workers create the
   directory later).
2. **Registry:** `assets/templates/registry.json` (hand-maintained by
   template authors, synced to `/templates/registry.json`):
   `{ "templates": [{ "id", "name", "description", "thumbnail?", "url" }] }`
   with `url` frozen as `/templates/<id>.json`. Registry entries MUST
   match the `template` block inside the corresponding file (CI check
   deferred past P1-A).
3. **JoinScreen** fetches `/templates/registry.json` at mount and renders
   one card per template: thumbnail image when `thumbnail` is present,
   otherwise the placeholder color block; name in the UI locale;
   description below. (Migrating the current hard-coded `MapChoice` list
   in `web/src/state/syncleStore.ts` to be registry-driven is P1-A
   implementer work, not part of this contract.)
4. **On select:** fetch `template.url`, run `validateTemplate` (see §5);
   on validation errors, log and fall back to the default map (never join
   into a broken map). On success, `loadMapConfig(template.url)` loads
   the world (unknown top-level keys are ignored by the loader) and the
   join spawn is `spawn_points[0]`.

### 5. Quality gates (normative — enforced by the validator)

`web/src/domain/mapTemplate.ts` exports the pure function
`validateTemplate(raw: unknown): { errors: string[]; warnings: string[] }`.
`errors` empty ⇔ the template is legal. `warnings` are non-blocking
authoring nudges. The JoinScreen flow (§4.4) treats any error as fatal.

| # | Rule | Severity |
|---|---|---|
| Q1 | `template` block present; `id` kebab-case; `name`/`description` both `{ en, zh }` non-empty | error |
| Q2 | `map_name` non-empty; `width`/`height` finite > 0; `background_color` or `background_image` present | error |
| Q3 | ≥ 1 `zone` object; every zone has explicit `kind` ∈ `silent\|discussion\|rest`; **≥ 1 zone with `kind: "silent"`** (a study-room template needs a quiet main area) | error |
| Q4 | **No dead zones:** every walkable cell is inside ≥ 1 zone (AABB point-in-rect). Walkable = 40 px sampling grid over `[0,width)×[0,height)`, excluding `SOLID_TYPES` AABBs. The error lists sample coordinates of unzoned cells. | error |
| Q5 | `spawn_points` length ≥ 1; each point finite, inside `[0,width]×[0,height]`, and NOT inside any solid-object AABB | error |
| Q6 | Every `table`/`desk` object has a non-empty `id`; ids unique across object tables/desks and top-level `tables[]`; table AABBs pairwise non-overlapping (edge-touching is allowed) | error |
| Q7 | Every object rect has finite `x/y/width/height` with `width > 0`, `height > 0`; `type` is a known `MapObjectType` | error |
| Q8 | Any object with `sprite` set → "verify the key exists in `ui/spriteAtlas.ts` SPRITES" | warning |
| Q9 | `thumbnail` present but absolute (leading `/` or `scheme://`) → prefer a `/templates/`-relative path | warning |
| Q10 | Zero tables, or floor-area-per-table < 20 000 px² (overcrowded) | warning |

### Where it lives (P1-A targets)

| Side | File | Symbol |
|---|---|---|
| Web | `web/src/domain/mapTemplate.ts` | `validateTemplate`, `TemplateValidation` (pure, unit-tested) |
| Web | `web/src/domain/__tests__/mapTemplate.test.ts` | ≥ 15 cases covering every Q-rule above, positive and negative |
| Web | `web/scripts/sync-assets.mjs` | `assets/templates/` → `web/public/templates/` (skip-if-missing) |
| Repo | `assets/templates/<id>.json` | template files (authored by template workers, not P1-A) |
| Repo | `assets/templates/registry.json` | picker registry (hand-maintained) |
