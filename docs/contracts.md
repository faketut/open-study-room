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


## Identity & login (P1-B: lightweight login)

Lightweight login gives the room an identity layer without breaking the
anonymous flow that M1–M4 are built on. It fills the hole the Moderation (M2)
contract left open: M2 §1 §6 froze `admin` as a placeholder that "cannot be
granted until the P1 identity system lands". **This is that system.** The
roadmap's two stated goals are the design's two goals: (1) raise the cost of
abuse (kicks/mutes/reports bind to an *account*, not a device), and (2) bind
the focus streak to an account. Everything else is out of scope (§9).

Guiding rule, extending M2's single security rule:

> **Identity is asserted by the server, never by the client.** Admin comes
> from the env allowlist evaluated server-side (§2); the OAuth state, the
> magic token, and the login session are server-issued and single-use or
> revocable (§7). No endpoint trusts a client-supplied identity.

### 1. Identity model — one `users` row per account

`users.id` stays the stable primary key and the FK target of
`room_roles` / `reports` / `mutes` / `kicks` / `focus_sessions` / `room_state`.
Login does **not** introduce a parallel identity table: a GitHub or email
account is just a `users` row whose provider columns are filled in. OAuth
login matches an existing row on `(provider, provider_sub)` → streak, roles,
and moderation history follow the account automatically.

New columns on `users`:

| Column | Type | Rule |
|---|---|---|
| `provider` | TEXT NOT NULL DEFAULT `'device'` | `CHECK (provider IN ('device','github','email'))` |
| `provider_sub` | TEXT | Provider-unique subject. GitHub → the numeric user id as text; email → the normalized (lowercased, trimmed) address. NULL for `provider='device'` rows. |
| `provider_handle` | TEXT | Human-readable handle used for the admin allowlist: GitHub login name; email → same as `provider_sub`; NULL for device rows. |
| `email` | TEXT | Best-known contact email (GitHub primary verified email, or the magic-link address). NULL for anonymous rows. |
| `display_name` | TEXT | Provider profile name (GitHub `name`); NULL for anonymous rows. Room presence still uses `nickname` (the per-session chosen name), unchanged. |
| `avatar_url` | TEXT | Provider avatar; NULL for anonymous rows. |

```sql
ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'device'
  CHECK (provider IN ('device','github','email'));
ALTER TABLE users ADD COLUMN provider_sub TEXT;
ALTER TABLE users ADD COLUMN provider_handle TEXT;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN avatar_url TEXT;
-- Account lookup key. Partial index: NULL provider_sub rows (all anonymous
-- rows) are excluded, so the anonymous device_id flow is untouched.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider_sub
  ON users(provider, provider_sub) WHERE provider_sub IS NOT NULL;
```

Frozen rules:

- **Anonymous flow is zero-change.** `upsertUser(deviceId, …)` keeps matching
  on `device_id` (still `NOT NULL UNIQUE`). Anonymous rows always have
  `provider='device'` and NULL provider columns. A device that never logs in
  behaves exactly as in M1–M4.
- **Account rows are not looked up by `device_id`.** Their `device_id`
  column keeps a non-lookup placeholder value (`'acct:' || id`) solely to
  satisfy the existing `NOT NULL UNIQUE` constraint; no flow may match on it.
  (SQLite cannot cheaply drop the NOT NULL; the placeholder keeps the
  migration additive.)
- **Matching rule (normative):** OAuth/email callbacks upsert on
  `(provider, provider_sub)`. The DB partial index makes double-registration
  impossible; a second OAuth login with the same provider account returns the
  *same* `users.id` — streak and roles follow automatically.
- **Email normalization:** lowercase + trim, applied at request time and at
  callback time; two differently-cased addresses are one account.
- **No password column, no password flow** (see §9).

### 2. Role model — host is per-room, admin is site-level

Roles: `host` > `admin` > `user`, unchanged from M2.

| Rule | Value |
|---|---|
| Who is host | Unchanged from M2 §1: the **first** user to join a room (first successful `POST /v1/sessions`). The host **may be anonymous**; anonymous host flow is untouched. |
| Who is admin | **Site-level, from the env allowlist evaluated server-side at auth time.** `ADMIN_GITHUB_USERS`: comma-separated GitHub login names (case-insensitive), matched against `users.provider_handle` where `provider='github'`. `ADMIN_EMAILS`: comma-separated emails (lowercased), matched against `users.email`. Either match ⇒ the user is admin. There is **no grant endpoint**: hosts cannot grant admin (M2 §6 "an `admin` placeholder cannot transfer" is preserved — a site admin cannot transfer host unless they hold the host row). |
| Effective role | Resolution order per request: `room_roles` row `host` → allowlist `admin` → `user`. A host who is also in the allowlist shows as `host`. |
| Anonymous admins | An allowlist entry only takes effect on an **authenticated** session. The same person entering anonymously is a plain `user` (their device row has NULL email/handle). |

`room_roles` keeps its frozen M2 semantics (only `host` rows are written by
first-joiner assignment and transfer; the `admin` CHECK value stays in the
schema but is not written — admin is computed, not stored).

The moderation gate in `server/src/routes/moderation.ts` changes from
`role !== "host" && role !== "admin"` (placeholder, never true) to the
effective role above. `getRoomRole` keeps returning the stored row; a new
`getEffectiveRole(db, room, userId)` adds the allowlist check and is the
**only** role value the server acts on.

### 3. GitHub OAuth — authorization code flow, server-side token exchange

Scopes requested: `read:user user:email` (identity + primary verified email;
nothing else).

1. `GET /v1/auth/github` — server generates a 32-byte random `state`,
   stores its **sha256** in `oauth_states` (10-minute TTL), and responds
   `302` to `https://github.com/login/oauth/authorize` with
   `client_id`, `redirect_uri={BASE_URL}/v1/auth/github/callback`,
   `scope=read:user user:email`, `state`. If GitHub is not configured
   (`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` unset) → `503
   { error: "github_not_configured" }`.
2. `GET /v1/auth/github/callback?code=&state=` — server:
   - validates `state`: exists, unused, unexpired; **consumes it
     (single-use, mark used)**. Failure → 302 to
     `${WEB_BASE_URL}/#error=invalid_state`.
   - exchanges `code` for an access token **server-side**
     (`POST https://github.com/login/oauth/access_token` with the client
     secret; the secret never leaves the server).
   - fetches `GET https://api.github.com/user` (id, login, name,
     avatar_url) and `GET https://api.github.com/user/emails` (primary
     verified email).
   - upserts the account row on `(provider='github', provider_sub=<id>)`,
     filling `provider_handle=login`, `email`, `display_name=name`,
     `avatar_url`.
   - issues a login session (§5) and 302s to
     `${WEB_BASE_URL}/#token=<raw-token>`. The token travels **only in the
     URL fragment**, which browsers never send to the web server. Errors
     (exchange failure, no verified email) → `#error=<code>` with a
     code only, no PII.
3. The web client (on mount) reads the fragment once, stores the token in
   `localStorage` (`syncle.auth_token`), strips the fragment from the URL,
   then calls `POST /v1/sessions` with `authToken` (§6) to bind the device.

```sql
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,   -- sha256 hex of the raw state
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,   -- created_at + 10 min (frozen)
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
```

### 4. Email magic link — SMTP-backed, honestly gated

- `POST /v1/auth/email/request` — body `{ "email": string }`. Server:
  normalizes the email, validates shape (zod email), rate-limits strictly
  (§7), creates a 32-byte random token, stores its **sha256** in
  `magic_tokens` (15-minute TTL, single-use), and sends a sign-in link
  `{BASE_URL}/v1/auth/email/callback?token=<raw>` via SMTP. **If SMTP is
  not configured (`SMTP_HOST` or `SMTP_FROM` unset) → `501
  { error: "email_not_configured" }`** and the web client hides the email
  entry (driven by `GET /v1/auth/config`, below) — the contract is honest
  instead of pretending email works. Success response is always a generic
  `202 { "status": "sent" }`; it does not say whether an account existed
  (any address can receive a link, so there is no oracle, but the response
  shape is fixed anyway).
- `GET /v1/auth/email/callback?token=` — server: looks up the sha256,
  checks unused + unexpired, **marks used (single-use)**; failure →
  `#error=invalid_token` or `#error=expired_token` redirect. Success →
  upsert on `(provider='email', provider_sub=<normalized email>)`, issue a
  login session (§5), 302 to `${WEB_BASE_URL}/#token=<raw-token>` exactly
  like the GitHub flow.

```sql
CREATE TABLE IF NOT EXISTS magic_tokens (
  token_hash TEXT PRIMARY KEY,   -- sha256 hex of the raw token
  email TEXT NOT NULL,           -- normalized (lowercase, trimmed)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,   -- created_at + 15 min (frozen)
  used_at INTEGER                 -- NULL = unused; single-use
);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_expires ON magic_tokens(expires_at);
```

### 5. Login session — distinct from the LiveKit JWT

Two different tokens exist and the contract keeps them separate:

| | LiveKit JWT (existing) | Login session (new) |
|---|---|---|
| Purpose | join one LiveKit room | prove account identity to the REST API |
| Issuer | `POST /v1/sessions` (livekit signer) | auth callbacks (§3/§4) |
| Lifetime | `TOKEN_TTL_SECONDS` (1 h) | `LOGIN_SESSION_TTL_DAYS` (default 30 d) |
| Verifies | `verifyJoinToken` (HS256) | `login_sessions.token_hash` lookup (sha256) |

- Raw token: 32 random bytes, base64url. The **raw value is given to the
  client exactly once** (the `#token=` fragment); the server stores only
  its sha256. Verifying a request = sha256 the presented bearer and look up
  the row (must exist, `revoked_at IS NULL`, `expires_at > now`).
- Client storage: `localStorage` (`syncle.auth_token`), sent as
  `Authorization: Bearer <token>`. (Cookies across the `:8080`/`:8787`
  dev ports fight SameSite; bearer is simpler. This is a deliberate
  tradeoff, recorded here.)
- `GET /v1/auth/me` (Bearer) → `200 { "userId", "provider",
  "displayName", "avatarUrl", "email", "isAdmin" }`. Used by the web client
  to render the logged-in badge.
- `DELETE /v1/auth/session` (Bearer) → revokes the presented token
  (`revoked_at = now`) → `204`. The client discards its stored token.
- `GET /v1/auth/config` (public, light rate limit) →
  `200 { "github": bool, "email": bool }`: which providers are actually
  configured. The web client hides unavailable entries from JoinScreen.

```sql
CREATE TABLE IF NOT EXISTS login_sessions (
  id TEXT PRIMARY KEY,            -- uuid
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, -- sha256 hex of the raw token
  device_id TEXT,                 -- device that last presented it (info only)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,    -- created_at + LOGIN_SESSION_TTL_DAYS
  revoked_at INTEGER,             -- NULL = live
  last_seen INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_login_sessions_user ON login_sessions(user_id);
```

### 6. Binding: `POST /v1/sessions` accepts an optional login token

`POST /v1/sessions` body gains one optional field: `authToken` (string).
Anonymous flow (field absent) is **byte-for-byte unchanged**.

When `authToken` is present and valid:

1. The server resolves it to the **account** row.
2. **Merge (frozen):** in one transaction, every FK row pointing at the
   device's anonymous row (`room_state`, `room_roles`, `reports`,
   `mutes`, `kicks`, `focus_sessions`) is re-pointed to the account row;
   the anonymous row is then deleted. Idempotent: if the device is already
   bound, nothing happens. Conflict handling is frozen:
   - `room_state` (room, user_id) collision → keep the account row's
     position, drop the device's.
   - `kicks` (room, user_id) collision → keep the **earlier** `kicked_at`
     (the longer-standing sanction wins).
3. The response is issued for the **account** row: `userId` = account id,
   the LiveKit JWT is signed with the account id, and `role` is the
   effective role — the response's `role` enum extends to
   `"host" | "admin" | "user"` (was `"host" | "user"`; the web client must
   accept the new value). The client also publishes the `admin` value into
   the LiveKit participant attribute for peer badges (display only, as in
   M2 §1).

Effects on the frozen FK consumers (deliberate, each recorded):

- **streak (§8)** — `focus_sessions` re-pointed to the account row;
  subsequent sessions land there too (the JWT now carries the account id).
- **roles** — a device's `host` row follows the account; the host keeps
  their room when they log in.
- **moderation** — `reports` history follows the reporter/target; `mutes`
  follow the muted account; `kicks` follow the kicked account, so **a
  logged-in account stays kicked for the day even on a new device** —
  this is the "raise the cost of abuse" half of the roadmap goal.
- **Kick check in `sessions.ts` runs against the merged id**, i.e. after
  step 2 — a kicked account cannot re-enter by re-binding.

Known honest limitations (recorded, not hidden):

- A kicked user can still evade by staying anonymous on a fresh device —
  device rows are unlinkable by design. Login raises the cost of abuse;
  it does not make evasion impossible.
- The reverse merge edge: an anonymous device row that was kicked, then
  logs in, transfers its kick to the account (intended: the account is the
  same person). An *innocent shared device* behind one device_id is
  indistinguishable from that person — shared-device operators accept
  this by running login.

### 7. Rate limits and security (normative)

| Rule | Value |
|---|---|
| Auth endpoints rate limit | Per-IP, `AUTH_RATE_LIMIT_MAX` per `AUTH_RATE_LIMIT_WINDOW_MS` (defaults 10/min) on `/v1/auth/*`, separate from the sessions limiter. `POST /v1/auth/email/request` additionally counts per normalized email (10/hour) to bound mail-bombing one address. Exceeding → `429 { error: "rate_limited" }`. |
| OAuth `state` | Random 32 bytes, **single-use** (marked used on first callback), 10-minute expiry. Reused/expired → `#error=invalid_state`. |
| Magic token | **Single-use** (`used_at` set on first callback), 15-minute expiry. Never in query strings except the one inbound link the user clicked. |
| No secret/PII echo | Raw tokens, token hashes, and full emails MUST NOT appear in server logs or error bodies. Error bodies carry **codes only** (`invalid_state`, `invalid_token`, `expired_token`, `github_not_configured`, `email_not_configured`). Log at most a truncated hash prefix (≤ 8 hex chars) for correlation. |
| Secrets | `GITHUB_CLIENT_SECRET` and SMTP credentials travel only in env vars (§8); they are never logged, never returned, and the GitHub token exchange is server-to-server. |
| Client secret storage | The web client stores only the login-session bearer; it never sees the GitHub OAuth access token. |

### 8. Environment variables (zod schema additions in `server/src/config.ts`)

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | — | Both set ⇒ GitHub login on; either missing ⇒ off (`503 github_not_configured`, hidden in `auth/config`). |
| `BASE_URL` | yes when any login on | — | Public server origin, e.g. `https://study.example.com`. Used to build `redirect_uri` and magic-link URLs. |
| `WEB_BASE_URL` | no | `http://localhost:8080` | Where auth callbacks 302 the browser (token in `#token=` fragment). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | no | — | `SMTP_HOST` + `SMTP_FROM` set ⇒ email login on; otherwise `501 email_not_configured` (web hides the entry). `SMTP_PORT` default 587. |
| `ADMIN_GITHUB_USERS` | no | — | Comma-separated GitHub logins, case-insensitive. |
| `ADMIN_EMAILS` | no | — | Comma-separated emails, lowercased before compare. |
| `LOGIN_SESSION_TTL_DAYS` | no | `30` | Login-session lifetime. |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | no | `10` / `60000` | Per-IP limit for `/v1/auth/*` (cf. `SESSION_RATE_LIMIT_*` for sessions). |

### 9. Explicitly out of scope

- **Enterprise SSO** (SAML / generic OIDC provider config): the roadmap
  says no; the `provider` CHECK enum admits only `device | github |
  email`. Adding a provider is a contract change.
- **Password login**: no password column, no password endpoints.
- **Unlink / delete account**: no endpoint detaches an OAuth identity
  from a row or deletes an account row in P1. (FK cascades would orphan
  moderation history; this needs its own contract.)
- **Multi-account switching UI beyond logout**: login is one active
  session token per browser; `DELETE /v1/auth/session` is the switch.

### Where it lives (P1-B implementation targets)

| Side | File | Symbol |
|---|---|---|
| Server | `server/src/db.ts` | identity columns + `idx_users_provider_sub` + `login_sessions` / `oauth_states` / `magic_tokens` schemas + `upsertAccount`, `mergeDeviceIntoAccount`, `getEffectiveRole`, `UserRow` identity fields |
| Server | `server/src/routes/auth.ts` | `/v1/auth/github`, `/v1/auth/github/callback`, `/v1/auth/email/request`, `/v1/auth/email/callback`, `/v1/auth/me`, `/v1/auth/session`, `/v1/auth/config` |
| Server | `server/src/routes/sessions.ts` | optional `authToken` body field → merge; `role` response `"host"\|"admin"\|"user"` |
| Server | `server/src/routes/moderation.ts` | host/admin gate switches to `getEffectiveRole` |
| Server | `server/src/config.ts` | §8 env vars (zod) |
| Server | `server/src/auth.ts` | `verifyLoginSession` (bearer → user row via sha256 lookup) |
| Web | `web/src/data/sessionApi.ts` | `authToken` param on `createSession`; `getAuthConfig`, `requestEmailLink`, `getMe`, `logout` |
| Web | `web/src/ui/JoinScreen.tsx` | login buttons driven by `/v1/auth/config`; `localStorage` token store; `#token=`/`#error=` fragment handling; all new strings via `pickUiLang`/`localizeText` (no i18n framework, as existing) |

### Test coverage (P1-B targets)

- Account upsert is idempotent on `(provider, provider_sub)`; a second
  OAuth login returns the same `users.id`.
- Merge: device row's `focus_sessions`/`room_roles`/`kicks` re-point to the
  account row; device row deleted; re-running merge is a no-op; kick
  collision keeps the earlier `kicked_at`.
- `getEffectiveRole`: host row beats allowlist; allowlist beat plain user;
  anonymous caller with allowlisted email is `user` until logged in.
- OAuth state: reuse → `invalid_state`; expired → `invalid_state`.
- Magic token: reuse → `invalid_token`; expired → `expired_token`; SMTP
  unconfigured → `501 email_not_configured`.
- `verifyLoginSession`: revoked/expired/unknown token → reject; the raw
  token value never appears in any DB row or log fixture.
- `GET /v1/auth/config` reflects exactly which env sets are present.
- Anonymous `POST /v1/sessions` (no `authToken`) behaves as before
  (regression on the M1–M4 suite).

### Self-consistency checklist (for the P1-B implementer)

Tables: `users` (identity columns), `login_sessions`, `oauth_states`,
`magic_tokens` — each referenced exactly where used above, no other new
tables. Endpoints: eight, all under `/v1/auth/` except the `authToken`
extension to `/v1/sessions`. Merges: one transaction, one direction
(device → account), idempotent. Secrets: two (GitHub client secret,
SMTP creds), both env-only. Fragments: `#token=` / `#error=` are the only
places a raw token crosses the wire to the browser. Anonymous flow:
unchanged by construction (partial index + optional field + unchanged
`upsertUser`).

## Whiteboard (P1-C: discussion-zone shared board)

Each `discussion` zone gets one shared whiteboard (a讲题scratch surface:
diagrams, formulas, sketches). It is the persistent analog of the M1
"screen share is allowed only in `discussion` zones" rule. It is **not** a
collaborative editor — see §2 on conflict policy.

### 1. Ownership — one board per discussion zone

| Rule | Value |
|---|---|
| Board id | `wb:<room>:<zoneId>` (built by a shared helper, e.g. `whiteboardId(room, zoneId)`; room and zoneId both appear in the state's zone contract, max 64 chars each) |
| Board ↔ zone | 1:1. A zone has at most one board; a board belongs to exactly one zone. The board is created lazily: the `whiteboards` row appears on the first successful `PUT` for that `(room, zone_id)`. |
| `rest` zones | **No board.** Per M1, `rest` is a lounge/break area; the whiteboard is a focused co-work surface for讲题, not a break-room toy. |
| `none` (no zone) | **No board.** Zone-less area has no bounded audience, so the "same-zone" filter in §2 is undefined — updates would fan out to the whole room. |
| `silent` zones | **No board, ever.** Silent is study-only (M1); a drawing surface is the opposite of quiet. |

The audience of a board is exactly the set of participants currently inside
its discussion zone. Zone membership is decided by the same
`zone`/`zone_kind` client reports the M1 mute policy trusts (server does not
load map files; lying about your zone to draw is covered by the M2
moderation loop — same honesty stance as M1).

### 2. Sync mechanism — debounce + reliable broadcast + REST snapshots + LWW

Three paths, one winner rule.

**(a) Realtime broadcast (peer-to-peer, LiveKit data channel).**

- The sender runs the Excalidraw `onChange(elements, appState, files)`
  handler; the scene is serialized to JSON (`{elements, appState, files}`).
- Send only while the board panel is **open** and the sender is inside that
  board's discussion zone.
- **Debounce + rate cap (frozen):** `WB_DEBOUNCE_MS = 500`,
  `WB_MAX_BROADCAST_HZ = 2` — the client batches `onChange` events and
  publishes at most one scene per 500 ms. This is one publish per 500 ms by
  construction (debounce floor == rate-cap interval), so no token bucket is
  needed: if another edit lands within 500 ms of the last publish, the timer
  restarts and the *latest* scene is sent.
- Transport: **reliable** data channel (`publishReliable`, same as chat in
  `web/src/data/liveKitService.ts`) — position uses unreliable, board
  updates must not silently drop.
- Wire format (JSON over the data channel), keys verbatim:

```json
{"type":"wb_update","board":"wb:<room>:<zoneId>","zone_id":"<zoneId>","updated_at":<epoch ms>,"scene":{...excalidraw scene...}}
```

**(b) REST snapshot (server persistence).**

- **On entering a discussion zone** (panel opens), on **room rejoin**, and on
  **data-channel reconnect**, the client pulls
  `GET /v1/rooms/:room/whiteboards/:zoneId` (§6) and applies the snapshot if
  it is newer than the local scene (`updated_at` comparison).
- **On broadcast**, the sender SHOULD also `PUT` the same scene to the
  server, at most as often as it broadcasts (i.e. PUT rides the same
  debounce timer). This is best-effort persistence for late joiners; it is
  not the realtime path.

**(c) Conflict policy — last-write-wins (LWW).**

- The arbiter is `updated_at` (epoch ms).
- **Data-channel path:** the receiver applies the incoming scene iff
  `msg.zone_id === receiver's current zone_id` **and**
  `msg.board === whiteboardId(room, msg.zone_id)` **and**
  `msg.updated_at > local.updated_at` for that board. Equal or older →
  ignore (rebroadcasts are idempotent).
- **REST path:** `PUT` stores iff `body.updated_at > stored.updated_at`
  (ties are no-ops — same content re-saved). Otherwise the server returns
  `200 {ok:true, applied:false, updated_at:<stored>}` and the client MUST
  `GET` to converge (§6).
- **Honest limitation (frozen, not hidden):** there is no OT/CRDT and no
  locking. Two people drawing within the same debounce window produce two
  competing full-scene writes; the later one wins and the earlier one's
  strokes are lost. The whiteboard is positioned as a讲题draft surface,
  not a collaborative editor. This is a contract-level decision, not a bug
  to fix later.

### 3. Visibility — zone-gated, M1 semantics win

| Rule | Value |
|---|---|
| Open | The board panel can be opened only while the user is inside a `discussion` zone. The open button is hidden elsewhere. |
| Auto-close | Crossing into a `silent` or `rest` zone (or leaving zones entirely → `none`) **closes the panel immediately**. M1's quiet/break semantics take precedence over keeping a drawing surface open; this is also the anti-disturbance rule — no whiteboard notifications, previews, or sounds may fire while the user is in `silent`/`rest`. |
| Broadcast gating | §2(a) already stops publishing when the panel closes; the sender MUST also stop the debounce timer on zone exit (a delayed timer must not fire after the user left the zone). |
| Re-entry | Re-entering the same discussion zone re-opens at the latest known scene (pull §2(b)); unsaved local strokes made before the zone exit were already broadcast under the debounce timer and are not lost unless a newer LWW write won. |

### 4. Permissions

- **Draw:** anyone currently inside the board's `discussion` zone may
  draw — no per-user grant. The sender-side gate is the zone check in §2(a);
  the server-side gate for persistence is the `not_in_zone` check in §6.
- **Clear:** the **host only** may clear a board
  (`DELETE /v1/rooms/:room/whiteboards/:zoneId`, §6). Rationale: the board
  is per-room shared state and the host owns the room; the site-level
  `admin` (P1-B) does **not** own the room and gets no clear right.
  Server-side the call is gated by `getEffectiveRole` == `"host"` (never the
  client-published `role` attribute — M2's single security rule applies).
- **Clear propagation:** on successful clear the server SHOULD fan out
  `{"type":"wb_clear","board":"wb:<room>:<zoneId>","zone_id":"<zoneId>","updated_at":<now>}`
  via `RoomServiceClient.sendData` (broadcast, reliable) — the same server→
  client push the M2 kick notice uses. Receivers in that zone with
  `msg.updated_at > local.updated_at` clear their local scene. The clearing
  host's own client clears optimistically without waiting.
- **M2 blockList (receiver-side):** a receiver MUST ignore `wb_update` /
  `wb_clear` messages whose LiveKit sender identity is in the local block
  list (`syncle.blocked.<room>`, `web/src/domain/blockList.ts`). This is
  local ignore only — the server cannot filter P2P data (M2 honesty rule).
  Known limitation: `GET` snapshots still show the latest scene regardless
  of the block list, because the block list lives in the blocker's
  localStorage and the server cannot know it; the receiver applies the
  block-list check to the *update stream*, not to persisted history.

### 5. Performance constraints (frozen)

| Constant | Value | Notes |
|---|---|---|
| `WB_DEBOUNCE_MS` | `500` | §2(a): at most one broadcast per 500 ms |
| `WB_MAX_BROADCAST_HZ` | `2` | Same number restated; debounce floor enforces it |
| `WHITEBOARD_MAX_SNAPSHOT_BYTES` | `262144` (256 KiB) | Applies to the serialized `scene_json` bytes on `PUT`; over → `413 {error:"too_large"}`. Client SHOULD refuse to broadcast scenes over the cap too (no point pushing what the server will reject). |
| Lazy load | mandatory | `@excalidraw/excalidraw` MUST NOT be in the first-screen bundle. The panel mounts via dynamic `import()` (`React.lazy`) and loads only when first opened. The bundle budget keeps JoinScreen → room entry fast. |
| Snapshot pull budget | 1 per zone entry | No polling. Pulls happen on the three triggers in §2(b) only. |

`WHITEBOARD_MAX_SNAPSHOT_BYTES` is a zod-validated env var in
`server/src/config.ts` (default `262144`); changing it is a config change,
not a contract change.

### 6. REST endpoints

Auth for all three: the **LiveKit join token** as bearer (same as M1 state
reports in `server/src/routes/state.ts`): `401 missing_bearer` /
`401 invalid_token`, `403 room_mismatch` when `payload.video.room !== room`,
`403 identity_mismatch` when the body `userId !== payload.sub`. The P1-B
login-session token is NOT accepted here — the join token is the room-scoped
credential, consistent with M1–M4 REST.

**`GET /v1/rooms/:room/whiteboards/:zoneId`** — pull snapshot.

- Any joined room member may read (the board is shared room content, like
  the position snapshot); no zone check on read.
- `200 { "scene_json": string, "updated_at": number, "updated_by": string }`
  (`scene_json` is the JSON *string* of the Excalidraw scene; the client
  parses it).
- `404 { "error": "no_whiteboard" }` — nothing has been drawn in this zone
  yet; the client starts with an empty scene. (Not an error state in the
  UI.)

**`PUT /v1/rooms/:room/whiteboards/:zoneId`** — store snapshot.

- Body: `{ "userId": string, "scene_json": string, "updated_at": number }`
  (zod; `scene_json` non-empty, `updated_at` integer ms).
- Checks, in order:
  1. `400 { error: "invalid_body" }` on schema failure.
  2. Byte length of `scene_json` (UTF-8) `> WHITEBOARD_MAX_SNAPSHOT_BYTES`
     → `413 { "error": "too_large" }`.
  3. Caller-zone check: the server reads the caller's `room_state` row for
     `(room, userId)`; requires `row.zone === zoneId` AND
     `row.zone_kind === "discussion"`. Else `403 { "error": "not_in_zone" }`.
     (The server trusts the client-reported zone, exactly as the M1 mute
     policy does — same honesty stance.)
  4. LWW: if a row exists and `body.updated_at <= stored.updated_at` →
     `200 { "ok": true, "applied": false, "updated_at": <stored> }` and the
     client MUST `GET` to converge. If no row, or
     `body.updated_at > stored.updated_at` → store
     (`scene_json`, `updated_at = body.updated_at`, `updated_by = userId`)
     and return `200 { "ok": true, "applied": true }`.
  5. Future-dated guard: `body.updated_at > Date.now() + 60_000` → `400
     { error: "invalid_body" }`.
- Rate limit: per-user-per-board `WHITEBOARD_PUT_RATE_LIMIT_MAX` per
  `WHITEBOARD_PUT_RATE_LIMIT_WINDOW_MS` (defaults 30/hour — snapshots are
  rare; debounce timers already throttle). Exceeding →
  `429 { error: "rate_limited" }`.

**`DELETE /v1/rooms/:room/whiteboards/:zoneId`** — clear board (host only).

- Body: `{ "userId": string }`.
- `getEffectiveRole(db, room, userId) !== "host"` →
  `403 { "error": "not_host" }`.
- Success: delete the row → `204`. Then the server SHOULD broadcast the
  `wb_clear` notice (§4) via `RoomServiceClient.sendData` (reliable,
  room-wide); a failed fan-out must not fail the `204` (log and continue,
  same stance as the M1 mute edge).
- Clearing a non-existent board is a no-op `204` (idempotent).

### 7. Server table

```sql
CREATE TABLE IF NOT EXISTS whiteboards (
  room       TEXT NOT NULL,
  zone_id    TEXT NOT NULL,
  scene_json TEXT NOT NULL,          -- Excalidraw scene JSON string (elements + appState + files)
  updated_at INTEGER NOT NULL,      -- epoch ms; LWW arbiter (§2c)
  updated_by TEXT NOT NULL,         -- users.id of the last writer (audit)
  PRIMARY KEY (room, zone_id),
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_whiteboards_room ON whiteboards(room);
```

Frozen rules:

- One row per `(room, zone_id)` by construction; no second table tracks
  "which zones have boards" — the row's presence is the board.
- `updated_by` FK is `ON DELETE CASCADE` (same as the M2 tables): deleting
  the account row deletes the board — recorded, accepted.
- No server-side scene validation beyond the byte cap. The server stores
  the JSON string opaquely; Excalidraw scene semantics are client-side.
  (A corrupt scene is a client bug; the LWW overwrite path recovers it.)
- The server never pushes board updates over the data channel except the
  `wb_clear` fan-out in §6. There is no server-side "who is drawing" state.

### 8. Explicitly out of scope

- **Undo/redo across clients, cursors, presence on the canvas** — local
  Excalidraw undo only; no remote cursor protocol.
- **Board history / versions** — LWW keeps one scene. A "restore earlier
  version" UI needs its own contract.
- **Image/file uploads beyond embedded Excalidraw `files`** — embedded
  images count toward the 256 KiB cap; there is no separate asset endpoint.
- **Boards in `rest`/`silent`/`none`** (§1) and **per-table boards** —
  the board is per discussion *zone*, not per table.
- **Export (PNG/SVG)** — client-local feature, no contract impact.

### Where it lives (P1-C implementation targets)

| Side | File | Symbol |
|---|---|---|
| Server | `server/src/db.ts` | `whiteboards` schema + `getWhiteboard` / `putWhiteboard` (LWW) / `clearWhiteboard` helpers |
| Server | `server/src/routes/whiteboard.ts` | `GET` / `PUT` / `DELETE /v1/rooms/:room/whiteboards/:zoneId` + `not_in_zone` / `too_large` / `not_host` gates |
| Server | `server/src/config.ts` | `WHITEBOARD_MAX_SNAPSHOT_BYTES`, `WHITEBOARD_PUT_RATE_LIMIT_*` (zod) |
| Web | `web/src/domain/whiteboard.ts` | `whiteboardId(room, zoneId)`, `WB_DEBOUNCE_MS`, `WB_MAX_BROADCAST_HZ`, `WB_UPDATE_TYPE`/`WB_CLEAR_TYPE`, zone/visibility predicates (pure, unit-tested) |
| Web | `web/src/data/whiteboardApi.ts` | `getSnapshot`, `putSnapshot`, `clearBoard` (join-token bearer, like `sessionApi.ts`) |
| Web | `web/src/ui/WhiteboardPanel.tsx` | lazy-loaded (`React.lazy` + dynamic `import()` of `@excalidraw/excalidraw`); `onChange` debounce → `publishReliable` + `PUT`; applies `wb_update`/`wb_clear` with LWW + blockList ignore; auto-closes on zone exit |

### Test coverage (P1-C targets)

- `whiteboardId` format `wb:<room>:<zoneId>`; receiver drops messages for a
  different `zone_id` or a malformed `board`.
- LWW receiver: older/duplicate `updated_at` ignored; newer applied.
- LWW `PUT`: older body → `200 applied:false`; client converges via `GET`.
- `PUT` from a caller whose `room_state` is a different zone / `rest` /
  `silent` → `403 not_in_zone`.
- `PUT` over 256 KiB → `413 too_large` (boundary: exactly 262144 bytes OK).
- `DELETE` by a non-host (incl. a site-level admin without the host row) →
  `403 not_host`; by the host → `204` and row gone.
- Debounce: rapid `onChange` bursts publish at most 1 per 500 ms and the
  published scene is the latest.
- Excalidraw import is lazy: the first-screen bundle contains no
  `@excalidraw/excalidraw` (build assertion on chunk contents).
- Blocked sender's `wb_update` ignored locally; snapshot `GET` still works
  (honest limitation).
- Zone exit closes the panel and stops the pending debounce timer (no
  broadcast after leaving).

### Self-consistency checklist (for the P1-C implementer)

Tables: one (`whiteboards`), no companion state. Endpoints: three, all under
`/v1/rooms/:room/whiteboards/:zoneId`. Wire types: two (`wb_update`,
`wb_clear`), both JSON over the reliable data channel. Clocks: `updated_at`
is epoch ms everywhere; the only arbiter is "strictly greater wins".
Auth: join-token bearer + `userId == sub`, never the `role` attribute, never
the login-session token. Roles: draw = anyone in the zone; clear = host
only. Zones: board exists only for `discussion`; panel auto-closes on
leaving. Perf: 500 ms debounce, 2/s cap, 256 KiB snapshot cap, lazy-loaded
editor. Anonymous flow: untouched (no identity columns involved).

## Layout & contextual UI (layout revamp, 2026-09-30)

Study-room maps are redesigned around two axes — **sound zoning** and
**function zoning** — and the in-room UI follows an RPG rule: **no buttons
by default; UI appears only when contextually relevant**. This section
freezes the layout principles every template must follow, the contextual
UI state machine, and the implementation targets. Only the `library`
template is redrawn in this change; the other four templates adopt these
principles in follow-up work.

Reference takeaways (researched 2026-09-30, not deep-dived):
- WorkAdventure: size spawn areas for crowds (never stack spawns on one
  point); trigger actions on area enter/exit.
- Gather: private sub-spaces read as floor-color-delimited areas; a
  single interact key (`x`) for all objects instead of per-object buttons.
- RPG map craft: spatial rhythm (tight passages ↔ open chambers), region
  distinction (each area feels different), one landmark per area for
  orientation.

### 1. Layout principles (normative for template authors)

**Sound zoning.** The silent main hall is the product's core (M1 quiet
semantics). It is buffered from the discussion zone by a physical
divider (wall / bookshelf cabinets) with a single doorway, and it never
shares a wall-less edge with `discussion`. `rest` zones (lobby, lounge)
may sit adjacent to `silent` — they are transit / quiet-talk areas.

**Function zoning.** Entrance at the south: door → lobby (rest). The
lobby is the circulation hub fanning out to three areas: silent reading
hall (north), discussion corner (east), lounge (west/south). A newcomer
spawning in the lobby sees all three destinations.

**Circulation.** Main openings ≥ 120 px; aisles between adjacent tables
≥ 64 px. Avatar sprites are ~16–24 px, so 64 px ≈ 3 avatar widths —
comfortable to walk without pixel-hunting. Every table cluster must be
reachable from the lobby without crossing another table's AABB.

**Proportion rules.**
- Room footprint ≤ 880×640. Rationale: larger rooms feel hollow with
  < 20 occupants and waste camera travel; the old 1000×800 library did.
- Standard table is a 4-person table ≈ 180×72 with 6 chairs (3 per long
  side). At most **one** long table (> 300 px) per room.
- Spawn: ≥ 2 spawn points in the lobby, spread ≥ 120 px apart
  (WorkAdventure lesson — no stacked spawns).
- Landmark per zone (rug color, bookshelf run, plant cluster) so each
  area reads differently at a glance (RPG region distinction).

These are authoring guidelines, not validator rules — Q1–Q10 stay the
mechanical gates. A template that violates §1 should fail review, not
the validator.

### 2. Contextual UI contract (RPG-style, normative)

**Core rule: no buttons by default.** The canvas is the interface.
Interface elements appear only when the player's context makes them
relevant, and disappear when it doesn't.

**Context state machine** (client-side, pure function
`contextSuiteFor(state)` in `web/src/domain/contextUi.ts`):

| Priority | Context | Suite shown |
|---|---|---|
| 1 | `seated` (self.tableId != null) | Meeting suite: mic / cam / share / meeting-view / leave-table. The only state where media buttons exist. |
| 2 | `nearbyBoard` / `nearbyNote` | Object suite: single contextual prompt — desktop key hint (`F 打开`), touch `TouchActionBar` ("打开"). Board wins over note (matches today's F-key order). |
| 3 | `nearbyTable` (standing) | Sit suite: desktop `E 坐下` hint, touch "坐下" button. |
| 4 | `nearbyPerson` (a peer within interaction radius, and no suite 1–3 active) | Person suite: small card with peer name + 屏蔽 / 举报 buttons. Reuses M2 `blockList` / report logic (the same handlers as `WhosWherePanel`'s action menu). |
| 5 | `silentZone` | PTT suite: today's `PttButton` + Space hint, unchanged. Orthogonal — may co-render with suites 1–4. |
| 6 | idle | Nothing. Empty canvas, empty bottom bar. |

While seated, E / "起身" leaves the table (today's toggle semantics,
unchanged). `interactActionFor` (touch) and the desktop key hints are
driven by the **same** context state — touch/desktop parity is a
contract requirement, not a nice-to-have.

**Zone pill.** Top-left. Appears on zone change (RPG "area name banner",
cf. WorkAdventure enter-area triggers), auto-fades after 2.5 s. Never
persists, never stacks with other UI.

**Top-left persistent row** is identity only: nickname + status pill +
(P1-B) account chip. All panel toggles (theme, mini mode, now playing,
perf, focus stats, moderation) collapse into a single top-right `⋯`
overflow menu. Chat keeps its dedicated entry (button + `T` key + unread
badge) — it is the primary social channel, not a contextual action.

**Key hints.** The static WASD legend is removed. Movement hint shows
once until the player's first move, then never again (RPG tutorial
toast). Afterwards only the contextual hint for the active suite shows
(e.g. `E 坐下`, `F 打开`, `Space 说话`).

**Mobile.** `TouchActionBar` semantics unchanged (`board`/`note`/
`sit`/`stand` via `interactActionFor`); it renders inside the bottom
`ContextActionBar` instead of standalone. The person suite and zone pill
are pointer-agnostic. No MW1 regression: joystick, drawers, safe-area,
and PTT behavior are untouched.

### 3. Explicitly out of scope

- Redrawing the other four templates (`cafe`, `night-owl`,
  `exam-sprint`, `welcome`) — they keep their current JSON until
  follow-up work applies §1.
- Walk-cycle character animation (chars remain single-frame).
- Changing zone semantics, AOI, moderation, focus, or whiteboard
  contracts — this section only re-arranges pixels and UI chrome.

### Where it lives

| Side | File | Symbol |
|---|---|---|
| Web | `web/src/domain/contextUi.ts` (new) | `contextSuiteFor`, `ContextState`, `ContextSuite` (pure, unit-tested) |
| Web | `web/src/ui/ContextActionBar.tsx` (new) | bottom-bar renderer; empty when suite is `idle` |
| Web | `web/src/ui/SyncleScreen.tsx` | remove always-visible mic/cam/share/meeting-view buttons → meeting suite; wire `ContextActionBar`; zone pill; `⋯` menu |
| Web | `web/src/ui/PersonCard.tsx` (new) | person suite card; reuses `domain/blockList` + report flow |
| Repo | `assets/templates/library.json` | redrawn per §1 (880×640, lobby hub, divider-buffered silent hall) |

### Test coverage

- `web/src/domain/__tests__/contextUi.test.ts`: priority order of
  `contextSuiteFor` (seated > board > note > table > person > idle),
  touch/desktop parity cases, PTT orthogonality.
- `web/src/domain/__tests__/mapTemplate.test.ts`: library.json still
  validates with zero errors under Q1–Q10 (existing suite, extended with
  the new file's expectations).
- All 407 existing web tests stay green; no server changes.

### Self-consistency checklist (for the implementer)

Layout: one template redrawn (`library`); footprint ≤ 880×640; silent
hall divider-buffered from discussion; lobby hub with spread spawns;
aisles ≥ 64 px; ≤ 1 long table. UI: no buttons by default; suites are
seated / board-note / table / person / PTT / idle with the priority
above; media buttons exist only in the meeting suite; zone pill is
transient (2.5 s); `⋯` menu holds the six panel toggles; chat keeps its
entry; WASD legend removed; touch parity via `interactActionFor`.
Tests: new `contextUi` suite + template validation green + all existing
green. Out of scope: other four templates, walk cycles, any semantic
contract change.

## UI refinements + English strings (2026-09-30)

Follow-up to the Layout revamp. Normative for the web client.

### 1. Who's where: collapsed by default

- The panel renders collapsed on first load. The collapsed state shows a
  compact badge button with the total occupant count (self + peers); clicking
  expands the full per-zone list.
- The collapsed/expanded preference persists in
  `localStorage["syncle.whosWhereCollapsed"]` ("1" collapsed / "0"
  expanded). Absence of the key means collapsed (new default).
- Rationale: aligns with the contextual-UI principle (no UI by default);
  the social-presence function is kept, the screen space is not.

### 2. Mic-blocked warning: contextual, not persistent

- The top-left HUD shows only the minimal status pill by default
  (nickname + presence dot).
- The "Mic blocked or no input device" banner appears ONLY when all of:
  - `micDenied` is latched (getUserMedia failed / no input device), AND
  - at least one of:
    - (a) the user is in a `discussion` or `rest` zone (where the mic
      actually matters), or
    - (b) the user attempted to unmute/enable the mic (mic toggle button
      or `M` key while denied — the attempt sets a sticky flag so the
      retry feedback is visible).
- In `silent` zones while just studying, the banner stays hidden.
- The banner keeps its Retry action (clears the latch, unmutes, re-prompts).

### 3. English-only UI strings

- All user-visible web UI strings are English. Direct hardcoded
  English replacement; no i18n framework (consistent with codebase style).
- Scope: `web/src/ui/**` (buttons, labels, prompts, tooltips, panel
  titles, zone kind labels, user-facing errors), `web/src/domain/contextUi.ts`
  hint labels, `web/src/domain/zones.ts` `ZONE_KIND_LABELS`,
  `web/src/ui/TouchActionBar.tsx` action labels.
- Out of scope (unchanged): code comments, `docs/`, server log messages,
  test names/descriptions (unless a test asserts on a UI string — then the
  assertion is updated). The pre-existing bilingual `LocalizedText`
  pattern (`auth.ts`, template registry/metadata) is left as-is; it
  already serves English.

### Self-consistency checklist

UI: who's-where collapsed default with count badge; mic banner gated by
(denied && (discussion|rest || attempted)); status pill minimal otherwise.
Strings: no CJK in user-visible UI strings (grep `[\u4e00-\u9fff]`
over `web/src/ui/**` + the two domain files, excluding comments).
Tests: new behavior tests (collapsed default, mic warning visibility
rules) + full suite green + `tsc -b` + production build.

## Seating flow + focus cocoon (2026-09-30)

Follow-up to the Layout revamp: seating becomes click/tap-first, and
sitting triggers a client-side "focus cocoon". Normative for the web
client and for template authors.

> **Note (2026-09-30):** The pixel-art tilemap (Tilation 16×16) that
> originally shipped with this change has been **removed**. The project
> committed to the AI hand-painted background direction; no template uses
> `tilegrid`/`tileVisual` anymore, and the renderer, validator, and asset
> have been deleted. See "Painted background" below. §§1–2 below are
> retained for the seating/cocoon contract only.

### 1. ~~Tilemap asset (license)~~ — removed 2026-09-30

### 2. ~~Tilemap template format~~ — removed 2026-09-30

### 3. ~~Library layout (tilemap)~~ — superseded by "Painted background" §3 below

### 4. Click/tap-to-sit

- Clicking (desktop) or tapping (touch) a **chair** resolves to its nearest
  table and attempts the same sit path as `E` (`setSelfTable` +
  `setTableAttribute`). Chair hit-test: point in chair AABB expanded by
  6 px (touch slop). If already seated, clicks do nothing (stand via `E` /
  the stand control, unchanged).
- A chair belongs to its nearest table (pure function
  `chairTableId(chair, tables)`); ties break by table id order. Chairs are
  walkable-through (not in `SOLID_TYPES`) — unchanged.
- `E`-key proximity sit and the touch `TouchActionBar` sit action are
  unchanged and share the same `attemptSit(tableId)` entry point, so
  full-house handling (§5) applies to all three.
- Tap-to-move keeps precedence on empty floor: a tap is tested against
  chairs first; only when no chair is hit does it become a move target.

### 5. Full-house queue + overflow

- **Seat model.** Table capacity = number of chairs assigned to it (§4).
  Occupancy = presence-based: self + peers with that `tableId`
  (client-side, from the existing presence broadcast). A table is *full*
  when occupancy ≥ capacity.
- **Trigger.** `attemptSit` on a full table — or on any reading-hall table
  while every reading-hall table is full — opens the full-house dialog
  instead of sitting.
- **Dialog (English-only UI).** "Reading hall is full."
  - `Queue for a seat` — joins the FIFO queue for the reading hall.
  - `Sit in lounge instead` — closes the dialog, toasts
    "Lounge seats are open — follow the highlight", and pulse-highlights
    lounge tables with free seats for 6 s.
  - `Cancel`.
- **Queue semantics** (`web/src/domain/seatingQueue.ts`, pure +
  unit-tested): per-client FIFO; position shown as "You are #N in line";
  when any reading-hall seat frees (presence update) the head of the queue
  gets a toast "A seat opened up in the reading hall!" and the freed table
  pulse-highlights for 6 s; leaving the map or sitting anywhere dequeues;
  5-minute timeout auto-dequeues with a toast.
- **Honest limitation (v1).** Occupancy is presence-based with no server
  arbitration: two clients can race for the last seat and both will
  appear seated (last-writer-wins on the `table` attribute). The queue is
  per-client, not global — with N queuers, all N get notified. This is
  documented, not fixed, in v1.

### 6. Focus cocoon (Option A: visual)

- On sit (`self.tableId` set): the camera smoothly zooms toward ~1.7×
  centered on the seated table and a radial vignette dims everything
  outside ~140 px of the avatar. Pure client-side — other clients still
  see the seated avatar on the un-zoomed map.
- On stand: the camera animates back to 1× and the vignette fades.
- Zoom is implemented as a multiplier on `computeViewport`
  (`computeZoomedViewport`, pure + unit-tested); the render loop lerps the
  live multiplier toward its target each frame (~0.6 s ease).
- `prefers-reduced-motion`: no animation, no vignette (instant 1×).
- Must not break: whiteboard (`B`), zone pill, PTT, mobile touch bar,
  meeting suite — all DOM, all above the canvas.

### Where it lives

| Side | File | Symbol |
|---|---|---|
| Web | `web/src/ui/SpatialCanvas.tsx` | painted-background layer; cocoon zoom + vignette |
| Web | `web/src/domain/camera.ts` | `computeZoomedViewport` |
| Web | `web/src/domain/seating.ts` (new) | `chairTableId`, `tableCapacity`, `tableOccupancy`, `attemptSit` target resolution |
| Web | `web/src/domain/seatingQueue.ts` (new) | queue state machine (pure) |
| Web | `web/src/ui/FullHouseDialog.tsx` (new) | queue / lounge-overflow / cancel |
| Web | `web/src/ui/SyncleScreen.tsx` | canvas click/tap chair hit-test → `attemptSit`; queue toasts; dialog wiring |
| Repo | `assets/templates/library.json` | painted background + logic-layer objects |

> The tilemap files (`tilation-16x16.png`, `TILATION` catalog,
> `tilegrid`/`tileVisual` types, tilemap renderer/validator) were removed
> 2026-09-30 — see the note under the section header.

### Test coverage

- `web/src/domain/__tests__/mapTemplate.test.ts`: library.json validates
  with zero errors.
- `web/src/domain/__tests__/seating.test.ts` (new): chair→table
  assignment, capacity/occupancy, full-table detection, click hit-test
  padding.
- `web/src/domain/__tests__/seatingQueue.test.ts` (new): FIFO order,
  notify-on-free, timeout, dequeue-on-sit/leave.
- `web/src/domain/__tests__/camera.test.ts` (extended):
  `computeZoomedViewport` centers on the focus point and clamps at edges.
- Full web suite green + `tsc -b` + production build.

### Self-consistency checklist

Seating: click / tap / E share `attemptSit`; full → dialog (queue / lounge / cancel).
Cocoon: zoom + vignette on sit, restore on stand, reduced-motion safe.
Tests: seating/queue/camera suites + template validation green + all
existing green. Out of scope: other four templates, `demo.mp4` re-record,
server-side seat arbitration.

## Painted background replaces tilemap for `library` (2026-09-30)

Supersedes the tilemap for the `library` template. The tilemap (Tilation)
was removed from the repo entirely on 2026-09-30 (see note above); `library`
uses a single AI-generated hand-painted background image.

### 1. Painted background asset

- File: `assets/backgrounds/library-painted.jpg` (JPEG, quality 88,
  619,375 bytes). Generated 2026-09-30 from a 1760×1280 (2×) PNG master
  (SHA-256 `0aafec57f10976192c3337692d2c853c65b9f77cb5cc2534b8fada1bee9ed5c2`).
- The 1760×1280 image maps 1:1 onto the 880×640 world (2× resolution).
- Original AI-generation snapshot: `e5318e92-c279-4c8d-bb71-21947ce8b26f:3z0hjn`.
- Served at `/backgrounds/library-painted.jpg` (copied by
  `web/scripts/sync-assets.mjs` from `assets/backgrounds/`).

### 2. Template format (painted mode)

A template opts into painted-background rendering with:

```json
"background_image": "backgrounds/library-painted.jpg",
"tileVisual": false
```

- `background_image`: path relative to `/` (served from `web/public/`).
  When present and loaded, the renderer draws it with `drawImage` as the
  base layer (with `imageSmoothingEnabled = true` for the blit only).
- `tileVisual: false` + **no `tilegrid`**: the visual layer is the painted
  image; the JSON `objects` array is the *logic* layer only (collision,
  zones, sit targets, interaction).
- **Layer separation (normative).** Positions of logical objects must match
  the artwork beneath them (authoring rule, verified by visual review +
  flood-fill reachability check). The validator (Q1–Q10) and all gameplay
  logic are unchanged.
- Renderer skips procedural drawing for
  `wall | table | desk | chair | cabinet | plant | rug` (the painting shows
  them) but keeps them for collision/logic. `zone` draws label chip only
  (no tint/border). `board` draws label chip + proximity highlight only
  (no cork body — the painting has the whiteboard). `door` draws the
  dashed marker only. Table highlight/occupancy rings still draw.

### 3. Library layout (painted, replaces §3 tile numbers)

880×640 world. Five zones, nine tables, 33 chairs (measured from the
artwork, not the old tilemap):

| Zone | Kind | World rect |
|---|---|---|
| Reading Hall (north) | silent | x 16–864, y 16–256 |
| Corridor | rest | x 16–864, y 272–320 |
| Lounge (southwest) | rest | x 16–400, y 320–624 |
| Lobby (southeast-center) | rest | x 400–608, y 320–624 |
| Discussion Corner (east) | discussion | x 608–864, y 320–624 |

- **Reading hall**: 6 tables / 21 chairs (three 2×1 north incl. one 4×2
  long, three south). Bookshelf dividers with central passage.
- **Discussion corner**: whiteboard (`board` at x 803, y 422, 52×98) on
  the east wall, one round table + 4 chairs.
- **Lounge**: two square tables + 8 chairs, plants, daybeds.
- **Lobby**: entrance door gap in the south wall (x 420–500), 2 spawn
  points at (420,560) and (500,560).
- **Circulation**: all chairs/whiteboard/door/zones reachable (flood-fill
  verified). Chair→table assignment by nearest table.

### 4. Unchanged from tilemap section

Click/tap-to-sit (§4), full-house queue + overflow (§5), focus cocoon (§6),
and test coverage all carry over unchanged. The `mapTemplate.test.ts`
library assertion now expects 9 tables / 33 chairs, `tileVisual: false`,
`background_image` set, and no `tilegrid`.

### Self-consistency checklist

Asset: JPEG in `assets/backgrounds/` + copied to `web/public/backgrounds/`.
Template: `library.json` has `background_image`, no `tilegrid`, 84 objects
(5 zones, 5 walls, 9 tables, 33 chairs, 20 cabinets, 10 plants, 1 board,
1 door). Renderer: bg `drawImage` + skip covered bodies + chip-only
zones/boards. Tests: 463/463 green. Visual: browser screenshot verified
(bg, whiteboard chip, click-to-sit). Out of scope: other four templates,
`demo.mp4` re-record, server-side seat arbitration.
