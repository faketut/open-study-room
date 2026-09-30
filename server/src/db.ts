import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";

export type Db = Database.Database;

/** sha256 hex of a token/state value. Raw tokens are never stored — only
 *  their hash (P1-B contract §5/§7). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface UserRow {
  id: string;
  device_id: string;
  nickname: string;
  color: string;
  created_at: number;
  last_seen: number;
  // P1-B identity columns (docs/contracts.md "Identity & login" §1).
  provider: string; // 'device' | 'github' | 'email'
  provider_sub: string | null;
  provider_handle: string | null;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

export interface RoomStateRow {
  room: string;
  user_id: string;
  table_id: string | null;
  zone: string | null;
  zone_kind: string | null;
  x: number;
  y: number;
  updated_at: number;
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL UNIQUE,
      nickname TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_state (
      room TEXT NOT NULL,
      user_id TEXT NOT NULL,
      table_id TEXT,
      zone TEXT,
      zone_kind TEXT,
      x REAL NOT NULL,
      y REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (room, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_room_state_room_updated
      ON room_state(room, updated_at);
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(room, name)
    );
    CREATE INDEX IF NOT EXISTS idx_channels_room
      ON channels(room, name);
    -- M2 moderation (docs/contracts.md "Moderation (M2: stranger safety)").
    -- Table/column names are frozen by the contract; do not rename.
    CREATE TABLE IF NOT EXISTS room_roles (
      room       TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('host', 'admin')),
      granted_by TEXT,
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (room, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_room_roles_room
      ON room_roles(room);
    CREATE TABLE IF NOT EXISTS reports (
      id          TEXT PRIMARY KEY,
      room        TEXT NOT NULL,
      reporter_id TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      reason      TEXT NOT NULL CHECK (reason IN ('spam', 'harassment', 'nsfw', 'other')),
      detail      TEXT,
      created_at  INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
      handled_by  TEXT,
      handled_at  INTEGER,
      FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id)   REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_reports_room_status
      ON reports(room, status, created_at);
    CREATE TABLE IF NOT EXISTS mutes (
      room      TEXT NOT NULL,
      user_id   TEXT NOT NULL,
      muted_by  TEXT NOT NULL,
      muted_at  INTEGER NOT NULL,
      PRIMARY KEY (room, user_id),
      FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (muted_by) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS kicks (
      room      TEXT NOT NULL,
      user_id   TEXT NOT NULL,
      kicked_by TEXT NOT NULL,
      kicked_at INTEGER NOT NULL,
      day       TEXT NOT NULL,
      reason    TEXT,
      PRIMARY KEY (room, user_id),
      FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (kicked_by) REFERENCES users(id) ON DELETE CASCADE
    );
    -- M3 focus loop (docs/contracts.md "Focus loop (M3)").
    -- Table/column names are frozen by the contract; do not rename.
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
    -- P1-B lightweight login (docs/contracts.md "Identity & login").
    -- Table/column names are frozen by the contract; do not rename.
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
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY,   -- sha256 hex of the raw state
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,   -- created_at + 10 min (frozen)
      used INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
    CREATE TABLE IF NOT EXISTS magic_tokens (
      token_hash TEXT PRIMARY KEY,   -- sha256 hex of the raw token
      email TEXT NOT NULL,           -- normalized (lowercase, trimmed)
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,   -- created_at + 15 min (frozen)
      used_at INTEGER                 -- NULL = unused; single-use
    );
    CREATE INDEX IF NOT EXISTS idx_magic_tokens_expires ON magic_tokens(expires_at);
    -- P1-C whiteboard (docs/contracts.md "Whiteboard (P1-C: discussion-zone
    -- shared board)" §7). One row per (room, zone_id); the row's presence IS
    -- the board (lazy creation on first successful PUT). Table/column names
    -- are frozen by the contract; do not rename.
    CREATE TABLE IF NOT EXISTS whiteboards (
      room       TEXT NOT NULL,
      zone_id    TEXT NOT NULL,
      scene_json TEXT NOT NULL,          -- Excalidraw scene JSON string (opaque)
      updated_at INTEGER NOT NULL,      -- epoch ms; LWW arbiter
      updated_by TEXT NOT NULL,         -- users.id of the last writer (audit)
      PRIMARY KEY (room, zone_id),
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_whiteboards_room ON whiteboards(room);
  `);
  ensureRoomStateZoneColumns(db);
  ensureIdentityColumns(db);
}

/** M1 zone columns. Kept as a separate step (and exported for tests) so that
 *  databases created before the M1 contract landed gain `zone` / `zone_kind`
 *  without a full rebuild. */
export function ensureRoomStateZoneColumns(db: Db): void {
  const cols = db
    .prepare<[], { name: string }>("PRAGMA table_info(room_state)")
    .all()
    .map((c) => c.name);
  if (!cols.includes("zone")) {
    db.exec("ALTER TABLE room_state ADD COLUMN zone TEXT");
  }
  if (!cols.includes("zone_kind")) {
    db.exec("ALTER TABLE room_state ADD COLUMN zone_kind TEXT");
  }
}

/** P1-B identity columns on `users`. Kept as a separate additive step (same
 *  pattern as the M1 zone columns) so databases created before P1-B gain the
 *  columns without a rebuild. Existing rows default to `provider='device'`
 *  with NULL provider columns — the anonymous flow is untouched. The partial
 *  unique index excludes NULL `provider_sub` rows, so anonymous rows are
 *  never matched by account lookup. */
export function ensureIdentityColumns(db: Db): void {
  const cols = db
    .prepare<[], { name: string }>("PRAGMA table_info(users)")
    .all()
    .map((c) => c.name);
  if (!cols.includes("provider")) {
    db.exec(
      `ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'device'
         CHECK (provider IN ('device','github','email'))`,
    );
  }
  if (!cols.includes("provider_sub")) {
    db.exec("ALTER TABLE users ADD COLUMN provider_sub TEXT");
  }
  if (!cols.includes("provider_handle")) {
    db.exec("ALTER TABLE users ADD COLUMN provider_handle TEXT");
  }
  if (!cols.includes("email")) {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT");
  }
  if (!cols.includes("display_name")) {
    db.exec("ALTER TABLE users ADD COLUMN display_name TEXT");
  }
  if (!cols.includes("avatar_url")) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT");
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider_sub
       ON users(provider, provider_sub) WHERE provider_sub IS NOT NULL`,
  );
}

export function upsertUser(
  db: Db,
  deviceId: string,
  nickname: string,
  color: string,
  now: number = Date.now(),
): UserRow {
  const existing = db
    .prepare<[string], UserRow>("SELECT * FROM users WHERE device_id = ?")
    .get(deviceId);
  if (existing) {
    db.prepare(
      "UPDATE users SET nickname = ?, color = ?, last_seen = ? WHERE id = ?",
    ).run(nickname, color, now, existing.id);
    return { ...existing, nickname, color, last_seen: now };
  }
  const row: UserRow = {
    id: randomUUID(),
    device_id: deviceId,
    nickname,
    color,
    created_at: now,
    last_seen: now,
    provider: "device",
    provider_sub: null,
    provider_handle: null,
    email: null,
    display_name: null,
    avatar_url: null,
  };
  db.prepare(
    "INSERT INTO users (id, device_id, nickname, color, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.device_id, row.nickname, row.color, row.created_at, row.last_seen);
  return row;
}

export function upsertRoomState(
  db: Db,
  room: string,
  userId: string,
  tableId: string | null,
  x: number,
  y: number,
  now: number = Date.now(),
  zone: string | null = null,
  zoneKind: string | null = null,
): void {
  db.prepare(
    `INSERT INTO room_state (room, user_id, table_id, zone, zone_kind, x, y, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(room, user_id) DO UPDATE SET
       table_id = excluded.table_id,
       zone = excluded.zone,
       zone_kind = excluded.zone_kind,
       x = excluded.x,
       y = excluded.y,
       updated_at = excluded.updated_at`,
  ).run(room, userId, tableId, zone, zoneKind, x, y, now);
}

/** Returns the latest stored state for one participant, if any. Used by the
 *  zone edge detector to compare the incoming `zone_kind` against the last one. */
export function getRoomState(
  db: Db,
  room: string,
  userId: string,
): RoomStateRow | undefined {
  return db
    .prepare<[string, string], RoomStateRow>(
      "SELECT * FROM room_state WHERE room = ? AND user_id = ?",
    )
    .get(room, userId);
}

export interface SnapshotEntry {
  userId: string;
  nickname: string;
  color: string;
  tableId: string | null;
  /** Zone id the peer last reported, or null when in no zone. */
  zone: string | null;
  /** Zone kind the peer last reported (null when never reported). */
  zone_kind: string | null;
  x: number;
  y: number;
  lastSeen: number;
}

export function getRoomSnapshot(
  db: Db,
  room: string,
  freshWindowMs: number,
  now: number = Date.now(),
): SnapshotEntry[] {
  const cutoff = now - freshWindowMs;
  const rows = db
    .prepare<
      [string, number],
      RoomStateRow & { nickname: string; color: string }
    >(
      `SELECT rs.*, u.nickname, u.color
         FROM room_state rs
         JOIN users u ON u.id = rs.user_id
        WHERE rs.room = ? AND rs.updated_at >= ?
        ORDER BY rs.updated_at DESC`,
    )
    .all(room, cutoff);
  return rows.map((r) => ({
    userId: r.user_id,
    nickname: r.nickname,
    color: r.color,
    tableId: r.table_id,
    zone: r.zone,
    zone_kind: r.zone_kind,
    x: r.x,
    y: r.y,
    lastSeen: r.updated_at,
  }));
}

// ---------- Moderation (M2: stranger safety) ----------
// Schemas frozen by docs/contracts.md "Moderation (M2: stranger safety)".

/** Roles stored in `room_roles`. No row ⇒ plain `user`. */
export type StoredRoomRole = "host" | "admin";
export type RoomRole = StoredRoomRole | "user";

export interface RoomRoleRow {
  room: string;
  user_id: string;
  role: StoredRoomRole;
  granted_by: string | null;
  granted_at: number;
}

export const REPORT_REASONS = ["spam", "harassment", "nsfw", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ["open", "actioned", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface ReportRow {
  id: string;
  room: string;
  reporter_id: string;
  target_id: string;
  reason: ReportReason;
  detail: string | null;
  created_at: number;
  status: ReportStatus;
  handled_by: string | null;
  handled_at: number | null;
}

export interface ReportListEntry extends ReportRow {
  reporter_nickname: string;
  target_nickname: string;
}

export interface MuteRow {
  room: string;
  user_id: string;
  muted_by: string;
  muted_at: number;
}

export interface KickRow {
  room: string;
  user_id: string;
  kicked_by: string;
  kicked_at: number;
  /** UTC date 'YYYY-MM-DD' — the kick block expires at the next UTC day. */
  day: string;
  reason: string | null;
}

export class ReportNotFoundError extends Error {
  constructor(id: string) {
    super(`report not found: ${id}`);
    this.name = "ReportNotFoundError";
  }
}

export class ReportAlreadyHandledError extends Error {
  constructor(id: string) {
    super(`report already handled: ${id}`);
    this.name = "ReportAlreadyHandledError";
  }
}

export function userExists(db: Db, userId: string): boolean {
  return (
    db
      .prepare<[string], { id: string }>("SELECT id FROM users WHERE id = ?")
      .get(userId) !== undefined
  );
}

/** The caller's role in a room. Only `host`/`admin` rows are stored; no row
 *  means a plain `user`. This is the ONLY source of truth for roles — the
 *  LiveKit participant attribute `role` is a display hint and is never
 *  trusted here. */
export function getRoomRole(db: Db, room: string, userId: string): RoomRole {
  const row = db
    .prepare<[string, string], { role: StoredRoomRole }>(
      "SELECT role FROM room_roles WHERE room = ? AND user_id = ?",
    )
    .get(room, userId);
  return row ? row.role : "user";
}

export function setRoomRole(
  db: Db,
  room: string,
  userId: string,
  role: StoredRoomRole,
  grantedBy: string | null,
  now: number = Date.now(),
): void {
  db.prepare(
    `INSERT INTO room_roles (room, user_id, role, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room, user_id) DO UPDATE SET
       role = excluded.role,
       granted_by = excluded.granted_by,
       granted_at = excluded.granted_at`,
  ).run(room, userId, role, grantedBy, now);
}

export function deleteRoomRole(db: Db, room: string, userId: string): void {
  db.prepare("DELETE FROM room_roles WHERE room = ? AND user_id = ?").run(
    room,
    userId,
  );
}

/** True when the room already has any host/admin row. The first successful
 *  `POST /v1/sessions` for a room (no row yet) makes the caller the host. */
export function roomHasRoleRow(db: Db, room: string): boolean {
  return (
    db
      .prepare<[string], { room: string }>(
        "SELECT room FROM room_roles WHERE room = ? LIMIT 1",
      )
      .get(room) !== undefined
  );
}

/** Host transfer, atomic: the old host's row is deleted and the new host's
 *  row inserted in one transaction. */
export function transferHost(
  db: Db,
  room: string,
  fromUserId: string,
  toUserId: string,
  now: number = Date.now(),
): void {
  const tx = db.transaction(() => {
    deleteRoomRole(db, room, fromUserId);
    setRoomRole(db, room, toUserId, "host", fromUserId, now);
  });
  tx();
}

// ---------- Reports ----------

export function createReport(
  db: Db,
  args: {
    room: string;
    reporterId: string;
    targetId: string;
    reason: ReportReason;
    detail?: string | null;
    now?: number;
  },
): ReportRow {
  const now = args.now ?? Date.now();
  const row: ReportRow = {
    id: randomUUID(),
    room: args.room,
    reporter_id: args.reporterId,
    target_id: args.targetId,
    reason: args.reason,
    detail: args.detail ?? null,
    created_at: now,
    status: "open",
    handled_by: null,
    handled_at: null,
  };
  db.prepare(
    `INSERT INTO reports
       (id, room, reporter_id, target_id, reason, detail, created_at, status, handled_by, handled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.room,
    row.reporter_id,
    row.target_id,
    row.reason,
    row.detail,
    row.created_at,
    row.status,
    row.handled_by,
    row.handled_at,
  );
  return row;
}

export function getReport(db: Db, id: string): ReportRow | undefined {
  return db
    .prepare<[string], ReportRow>("SELECT * FROM reports WHERE id = ?")
    .get(id);
}

/** Lists reports for a room ordered by `created_at ASC`, with reporter and
 *  target nicknames joined. `status` is `"open"` (default) or `"all"`. */
export function listReports(
  db: Db,
  room: string,
  status: "open" | "all" = "open",
): ReportListEntry[] {
  return db
    .prepare<[string, string], ReportListEntry>(
      `SELECT r.*, ru.nickname AS reporter_nickname, tu.nickname AS target_nickname
         FROM reports r
         JOIN users ru ON ru.id = r.reporter_id
         JOIN users tu ON tu.id = r.target_id
        WHERE r.room = ? AND (? = 'all' OR r.status = 'open')
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(room, status);
}

/** Closes an `open` report. Throws `ReportNotFoundError` when the id is
 *  unknown and `ReportAlreadyHandledError` when its status is not `open`
 *  (both end states are terminal) — the route maps these to 404 / 409. */
export function closeReport(
  db: Db,
  id: string,
  decision: "actioned" | "dismissed",
  handledBy: string,
  now: number = Date.now(),
): ReportRow {
  const row = getReport(db, id);
  if (!row) throw new ReportNotFoundError(id);
  if (row.status !== "open") throw new ReportAlreadyHandledError(id);
  db.prepare(
    "UPDATE reports SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?",
  ).run(decision, handledBy, now, id);
  return { ...row, status: decision, handled_by: handledBy, handled_at: now };
}

// ---------- Mutes (Layer M) ----------

/** Moderation mute. Idempotent: re-muting an already-muted user is a no-op. */
export function addMute(
  db: Db,
  room: string,
  userId: string,
  mutedBy: string,
  now: number = Date.now(),
): void {
  db.prepare(
    `INSERT OR IGNORE INTO mutes (room, user_id, muted_by, muted_at)
     VALUES (?, ?, ?, ?)`,
  ).run(room, userId, mutedBy, now);
}

export function removeMute(db: Db, room: string, userId: string): void {
  db.prepare("DELETE FROM mutes WHERE room = ? AND user_id = ?").run(
    room,
    userId,
  );
}

export function isMuted(db: Db, room: string, userId: string): boolean {
  return (
    db
      .prepare<[string, string], { room: string }>(
        "SELECT room FROM mutes WHERE room = ? AND user_id = ?",
      )
      .get(room, userId) !== undefined
  );
}

// ---------- Kicks ----------

/** UTC date 'YYYY-MM-DD' for the same-day kick block. */
export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Records a kick. A same-day re-kick refreshes `kicked_at`/`reason`
 *  (and `day`) on the existing (room, user_id) row. */
export function addKick(
  db: Db,
  room: string,
  userId: string,
  kickedBy: string,
  reason: string | null,
  now: number = Date.now(),
): void {
  const day = utcDay(now);
  db.prepare(
    `INSERT INTO kicks (room, user_id, kicked_by, kicked_at, day, reason)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(room, user_id) DO UPDATE SET
       kicked_by = excluded.kicked_by,
       kicked_at = excluded.kicked_at,
       day = excluded.day,
       reason = excluded.reason`,
  ).run(room, userId, kickedBy, now, day, reason);
}

/** True when the user was kicked from the room earlier the same UTC day —
 *  `POST /v1/sessions` must then refuse token issuance (403 `kicked`). */
export function isKickedToday(
  db: Db,
  room: string,
  userId: string,
  now: number = Date.now(),
): boolean {
  const row = db
    .prepare<[string, string], KickRow>(
      "SELECT * FROM kicks WHERE room = ? AND user_id = ?",
    )
    .get(room, userId);
  return !!row && row.day === utcDay(now);
}

// ---------- Channels (M3 rich chat) ----------

export interface ChannelRow {
  id: string;
  room: string;
  name: string;
  created_at: number;
}

export function listChannels(db: Db, room: string): ChannelRow[] {
  return db
    .prepare<[string], ChannelRow>(
      "SELECT * FROM channels WHERE room = ? ORDER BY name ASC",
    )
    .all(room);
}

/** Returns the row for the (room, name) pair, creating one if missing.
 *  Idempotent: two callers racing to create the same name end up with the
 *  same row. */
export function upsertChannel(
  db: Db,
  room: string,
  name: string,
  now: number = Date.now(),
): ChannelRow {
  const existing = db
    .prepare<[string, string], ChannelRow>(
      "SELECT * FROM channels WHERE room = ? AND name = ?",
    )
    .get(room, name);
  if (existing) return existing;
  const row: ChannelRow = {
    id: randomUUID(),
    room,
    name,
    created_at: now,
  };
  db.prepare(
    "INSERT INTO channels (id, room, name, created_at) VALUES (?, ?, ?, ?)",
  ).run(row.id, row.room, row.name, row.created_at);
  return row;
}

// ---------- Focus sessions (M3 focus loop) ----------
// Contract: docs/contracts.md "Focus loop (M3)" §1. Server time is
// authoritative for everything completion/streak-related.

export type FocusSessionKind = "focus" | "break";

export interface FocusSessionRow {
  id: string;
  user_id: string;
  room: string;
  kind: FocusSessionKind;
  planned_minutes: number;
  started_at: number;
  ends_at: number;
  ended_at: number | null;
  completed: number; // 0 | 1 — server-decided via the completion rule
  created_at: number;
}

export class FocusSessionNotFoundError extends Error {
  constructor(id: string) {
    super(`focus session not found: ${id}`);
    this.name = "FocusSessionNotFoundError";
  }
}

export class FocusSessionForbiddenError extends Error {
  constructor(id: string) {
    super(`focus session belongs to another user: ${id}`);
    this.name = "FocusSessionForbiddenError";
  }
}

/** Abandoned-session grace: sessions past their end are only settled once
 *  `ends_at < now - FOCUS_STALE_MS` (covers reconnects and clock skew). */
const FOCUS_STALE_MS = 300_000;
/** "Finished a bit early" grace: completed = 1 iff ended_at >= ends_at - 60 s. */
const FOCUS_GRACE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Lazy settle of abandoned sessions (contract §1): every still-active
 *  session of this user with `ends_at < now - 300_000` is closed as
 *  `ended_at = ends_at, completed = 0`. No background job — callers settle
 *  before reading (start / active / stats). Returns the number settled. */
export function settleStaleFocusSessions(
  db: Db,
  userId: string,
  now: number,
): number {
  const res = db
    .prepare(
      `UPDATE focus_sessions
         SET ended_at = ends_at, completed = 0
       WHERE user_id = ? AND ended_at IS NULL AND ends_at < ?`,
    )
    .run(userId, now - FOCUS_STALE_MS);
  return Number(res.changes);
}

export interface StartFocusSessionParams {
  userId: string;
  room: string;
  kind: FocusSessionKind;
  plannedMinutes: number;
  now: number;
}

/** Start a session. First lazy-settles stale actives, then interrupts any
 *  remaining active session of this user (`ended_at = now, completed = 0`
 *  — at most one active per user), then inserts the new row. */
export function startFocusSession(
  db: Db,
  params: StartFocusSessionParams,
): FocusSessionRow {
  const { userId, room, kind, plannedMinutes, now } = params;
  settleStaleFocusSessions(db, userId, now);
  db.prepare(
    `UPDATE focus_sessions
       SET ended_at = ?, completed = 0
     WHERE user_id = ? AND ended_at IS NULL`,
  ).run(now, userId);
  const row: FocusSessionRow = {
    id: randomUUID(),
    user_id: userId,
    room,
    kind,
    planned_minutes: plannedMinutes,
    started_at: now,
    ends_at: now + plannedMinutes * 60_000,
    ended_at: null,
    completed: 0,
    created_at: now,
  };
  db.prepare(
    `INSERT INTO focus_sessions
       (id, user_id, room, kind, planned_minutes, started_at, ends_at, ended_at, completed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.user_id,
    row.room,
    row.kind,
    row.planned_minutes,
    row.started_at,
    row.ends_at,
    row.ended_at,
    row.completed,
    row.created_at,
  );
  return row;
}

export function getFocusSession(
  db: Db,
  id: string,
): FocusSessionRow | undefined {
  return db
    .prepare<[string], FocusSessionRow>(
      "SELECT * FROM focus_sessions WHERE id = ?",
    )
    .get(id);
}

/** End a session. Idempotent: an already-ended session returns its stored
 *  result. The completion rule is server-decided — `completed = 1` iff
 *  `ended_at (= now) >= ends_at - 60_000`; any client hint is ignored.
 *  Throws FocusSessionNotFoundError / FocusSessionForbiddenError (the route
 *  maps these to 404 / 403). */
export function endFocusSession(
  db: Db,
  id: string,
  userId: string,
  now: number,
): FocusSessionRow {
  const existing = getFocusSession(db, id);
  if (!existing) throw new FocusSessionNotFoundError(id);
  if (existing.user_id !== userId) throw new FocusSessionForbiddenError(id);
  if (existing.ended_at !== null) return existing; // idempotent
  const completed = now >= existing.ends_at - FOCUS_GRACE_MS ? 1 : 0;
  db.prepare(
    `UPDATE focus_sessions
       SET ended_at = ?, completed = ?
     WHERE id = ? AND ended_at IS NULL`,
  ).run(now, completed, id);
  const updated = getFocusSession(db, id);
  if (!updated) throw new FocusSessionNotFoundError(id); // unreachable
  return updated;
}

/** The user's currently active session, if any. Lazy-settles stale actives
 *  first (contract §1), so a returned row is genuinely live. */
export function getActiveFocusSession(
  db: Db,
  userId: string,
  now: number,
): FocusSessionRow | null {
  settleStaleFocusSessions(db, userId, now);
  const row = db
    .prepare<[string], FocusSessionRow>(
      `SELECT * FROM focus_sessions
       WHERE user_id = ? AND ended_at IS NULL
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(userId);
  return row ?? null;
}

export interface FocusDayStat {
  /** Calendar day in the caller's tz, YYYY-MM-DD. */
  day: string;
  seconds: number;
}

export interface FocusStats {
  todaySec: number;
  /** Rolling 7-day window ending today (same days as last7Days). */
  weekSec: number;
  streakDays: number;
  totalCompletedSessions: number;
  last7Days: FocusDayStat[];
}

/** Local day index for an instant: floor((ts + tzOffsetMs) / DAY_MS), where
 *  tzOffsetMin is minutes east of UTC (client sends
 *  `-new Date().getTimezoneOffset()`). */
function tzDayIndex(ts: number, tzOffsetMin: number): number {
  return Math.floor((ts + tzOffsetMin * 60_000) / DAY_MS);
}

/** YYYY-MM-DD label of a local day index: the UTC instant
 *  dayIndex * DAY_MS is exactly local midnight, so its ISO date is the
 *  caller's calendar date. */
function tzDayLabel(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

/** Stats/streak over **completed focus sessions only** (kind = 'focus',
 *  completed = 1; breaks are recorded but excluded). A session is attributed
 *  to the caller's local day of its `started_at`. Streak: consecutive counted
 *  days ending today, with the standard one-day grace (today uncounted but
 *  yesterday counted → the streak runs through yesterday). */
export function getFocusStats(
  db: Db,
  userId: string,
  tzOffsetMin: number,
  now: number,
): FocusStats {
  settleStaleFocusSessions(db, userId, now);
  const rows = db
    .prepare<[string], Pick<FocusSessionRow, "started_at" | "ended_at">>(
      `SELECT started_at, ended_at FROM focus_sessions
       WHERE user_id = ? AND kind = 'focus' AND completed = 1`,
    )
    .all(userId);

  const perDay = new Map<number, number>(); // local dayIndex -> seconds
  for (const r of rows) {
    const secs = Math.floor(((r.ended_at ?? r.started_at) - r.started_at) / 1000);
    if (secs <= 0) continue;
    const d = tzDayIndex(r.started_at, tzOffsetMin);
    perDay.set(d, (perDay.get(d) ?? 0) + secs);
  }

  const todayIdx = tzDayIndex(now, tzOffsetMin);
  const last7Days: FocusDayStat[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = todayIdx - i;
    last7Days.push({ day: tzDayLabel(d), seconds: perDay.get(d) ?? 0 });
  }
  const todaySec = perDay.get(todayIdx) ?? 0;
  const weekSec = last7Days.reduce((sum, x) => sum + x.seconds, 0);

  let d = todayIdx;
  if (!perDay.has(d)) d -= 1; // grace: streak runs through yesterday
  let streakDays = 0;
  while (perDay.has(d)) {
    streakDays += 1;
    d -= 1;
  }

  return {
    todaySec,
    weekSec,
    streakDays,
    totalCompletedSessions: rows.length,
    last7Days,
  };
}

// ---------- Identity & login (P1-B: lightweight login) ----------
// Contract: docs/contracts.md "Identity & login (P1-B: lightweight login)".
// Schemas frozen by the contract; do not rename tables/columns.

export type IdentityProvider = "github" | "email";

export interface UpsertAccountParams {
  provider: IdentityProvider;
  /** Provider-unique subject: GitHub numeric id as text, or the normalized
   *  (lowercased, trimmed) email. */
  providerSub: string;
  providerHandle?: string | null;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  nickname?: string | null;
  now?: number;
}

/** Upsert an account row on the frozen matching key `(provider, provider_sub)`
 *  — a second OAuth login with the same provider account returns the SAME
 *  `users.id`, so streak, roles, and moderation history follow automatically.
 *  Account rows get a non-lookup `device_id` placeholder (`'acct:' || id`)
 *  solely to satisfy the existing NOT NULL UNIQUE constraint; no flow may
 *  match on it. */
export function upsertAccount(db: Db, params: UpsertAccountParams): UserRow {
  const now = params.now ?? Date.now();
  const existing = db
    .prepare<[string, string], UserRow>(
      "SELECT * FROM users WHERE provider = ? AND provider_sub = ?",
    )
    .get(params.provider, params.providerSub);
  if (existing) {
    const providerHandle = params.providerHandle ?? existing.provider_handle;
    const email = params.email ?? existing.email;
    const displayName = params.displayName ?? existing.display_name;
    const avatarUrl = params.avatarUrl ?? existing.avatar_url;
    const nickname = params.nickname ?? existing.nickname;
    db.prepare(
      `UPDATE users
         SET provider_handle = ?, email = ?, display_name = ?,
             avatar_url = ?, nickname = ?, last_seen = ?
       WHERE id = ?`,
    ).run(providerHandle, email, displayName, avatarUrl, nickname, now, existing.id);
    return {
      ...existing,
      provider_handle: providerHandle,
      email,
      display_name: displayName,
      avatar_url: avatarUrl,
      nickname,
      last_seen: now,
    };
  }
  const id = randomUUID();
  const nickname =
    params.nickname ??
    params.displayName ??
    params.providerHandle ??
    params.providerSub;
  const row: UserRow = {
    id,
    device_id: `acct:${id}`,
    nickname,
    color: "#4F8EF7",
    created_at: now,
    last_seen: now,
    provider: params.provider,
    provider_sub: params.providerSub,
    provider_handle: params.providerHandle ?? null,
    email: params.email ?? null,
    display_name: params.displayName ?? null,
    avatar_url: params.avatarUrl ?? null,
  };
  db.prepare(
    `INSERT INTO users
       (id, device_id, nickname, color, created_at, last_seen,
        provider, provider_sub, provider_handle, email, display_name, avatar_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.device_id,
    row.nickname,
    row.color,
    row.created_at,
    row.last_seen,
    row.provider,
    row.provider_sub,
    row.provider_handle,
    row.email,
    row.display_name,
    row.avatar_url,
  );
  return row;
}

/** Device → account merge (frozen, contract §6): in ONE transaction, every FK
 *  row pointing at the device's anonymous row is re-pointed to the account
 *  row, then the anonymous row is deleted. Idempotent: a missing device row
 *  (already merged) is a no-op. Frozen conflict rules:
 *  - `room_state` (room, user_id) collision → keep the account row's position.
 *  - `kicks` (room, user_id) collision → keep the EARLIER `kicked_at`
 *    (the longer-standing sanction wins).
 *  Unspecified PK collisions (`room_roles`, `mutes`) keep the account row. */
export function mergeDeviceIntoAccount(
  db: Db,
  deviceUserId: string,
  accountUserId: string,
  now: number = Date.now(),
): void {
  if (deviceUserId === accountUserId) return;
  const tx = db.transaction(() => {
    const device = db
      .prepare<[string], { id: string }>("SELECT id FROM users WHERE id = ?")
      .get(deviceUserId);
    if (!device) return; // already merged — idempotent no-op
    const account = db
      .prepare<[string], { id: string }>("SELECT id FROM users WHERE id = ?")
      .get(accountUserId);
    if (!account) {
      throw new Error(`merge target account not found: ${accountUserId}`);
    }
    const dev = deviceUserId;
    const acct = accountUserId;

    // room_state: account's position wins on (room, user_id) collision.
    db.prepare(
      `DELETE FROM room_state WHERE user_id = ? AND room IN
         (SELECT room FROM room_state WHERE user_id = ?)`,
    ).run(dev, acct);
    db.prepare("UPDATE room_state SET user_id = ? WHERE user_id = ?").run(acct, dev);

    // room_roles: account's row wins on collision; granted_by follows the person.
    db.prepare(
      `DELETE FROM room_roles WHERE user_id = ? AND room IN
         (SELECT room FROM room_roles WHERE user_id = ?)`,
    ).run(dev, acct);
    db.prepare("UPDATE room_roles SET user_id = ? WHERE user_id = ?").run(acct, dev);
    db.prepare("UPDATE room_roles SET granted_by = ? WHERE granted_by = ?").run(acct, dev);

    // reports: reporter, target, and handler history all follow the person.
    for (const col of ["reporter_id", "target_id", "handled_by"] as const) {
      db.prepare(`UPDATE reports SET ${col} = ? WHERE ${col} = ?`).run(acct, dev);
    }

    // mutes: account's row wins on collision; muted_by follows the person.
    db.prepare(
      `DELETE FROM mutes WHERE user_id = ? AND room IN
         (SELECT room FROM mutes WHERE user_id = ?)`,
    ).run(dev, acct);
    db.prepare("UPDATE mutes SET user_id = ? WHERE user_id = ?").run(acct, dev);
    db.prepare("UPDATE mutes SET muted_by = ? WHERE muted_by = ?").run(acct, dev);

    // kicks: keep the EARLIER kicked_at (longer-standing sanction wins).
    // Drop the device's row where the account's kick is earlier-or-equal…
    db.prepare(
      `DELETE FROM kicks WHERE user_id = ? AND EXISTS (
         SELECT 1 FROM kicks a
          WHERE a.user_id = ? AND a.room = kicks.room
            AND a.kicked_at <= kicks.kicked_at
       )`,
    ).run(dev, acct);
    // …drop the account's row where the device's kick is strictly earlier,
    // then re-point whatever device rows survive.
    db.prepare(
      `DELETE FROM kicks WHERE user_id = ? AND EXISTS (
         SELECT 1 FROM kicks d
          WHERE d.user_id = ? AND d.room = kicks.room
            AND d.kicked_at < kicks.kicked_at
       )`,
    ).run(acct, dev);
    db.prepare("UPDATE kicks SET user_id = ? WHERE user_id = ?").run(acct, dev);
    db.prepare("UPDATE kicks SET kicked_by = ? WHERE kicked_by = ?").run(acct, dev);

    // focus_sessions: streak follows the account.
    db.prepare("UPDATE focus_sessions SET user_id = ? WHERE user_id = ?").run(acct, dev);

    // The anonymous row must have no references left; delete it.
    db.prepare("DELETE FROM users WHERE id = ?").run(dev);
    db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(now, acct);
  });
  tx();
}

/** Site-level admin allowlist, normalized at parse time. */
export interface AdminAllowlist {
  /** Lowercased GitHub login names (ADMIN_GITHUB_USERS). */
  githubUsers: string[];
  /** Lowercased emails (ADMIN_EMAILS). */
  emails: string[];
}

/** Parse a comma-separated env allowlist: trim, lowercase, drop empties. */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Allowlist-admin predicate (site-level, not room-scoped). Only
 *  authenticated accounts can match — device rows carry NULL handle/email
 *  and never match, and `provider='device'` is excluded explicitly. */
export function isAllowlistAdmin(
  db: Db,
  userId: string,
  allowlist: AdminAllowlist,
): boolean {
  const u = db
    .prepare<[string], Pick<UserRow, "provider" | "provider_handle" | "email">>(
      "SELECT provider, provider_handle, email FROM users WHERE id = ?",
    )
    .get(userId);
  if (!u || u.provider === "device") return false;
  const handle = (u.provider_handle ?? "").toLowerCase();
  const email = (u.email ?? "").toLowerCase();
  if (
    u.provider === "github" &&
    handle !== "" &&
    allowlist.githubUsers.includes(handle)
  ) {
    return true;
  }
  return email !== "" && allowlist.emails.includes(email);
}

/** Effective role — the ONLY role value the server acts on (contract §2).
 *  Resolution order per request: `room_roles` host row → allowlist admin →
 *  user. A host who is also in the allowlist shows as `host`. */
export function getEffectiveRole(
  db: Db,
  room: string,
  userId: string,
  allowlist: AdminAllowlist,
): RoomRole {
  if (getRoomRole(db, room, userId) === "host") return "host";
  return isAllowlistAdmin(db, userId, allowlist) ? "admin" : "user";
}

// ---------- Login sessions / OAuth states / magic tokens ----------
// All raw token values are 32 random bytes, base64url; the server stores
// only their sha256 (contract §7 "No secret/PII echo").

export const OAUTH_STATE_TTL_MS = 10 * 60_000; // frozen by contract §3
export const MAGIC_TOKEN_TTL_MS = 15 * 60_000; // frozen by contract §4

export interface LoginSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  device_id: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_seen: number;
}

/** Issues a login session and returns the id + the RAW token. The raw value
 *  is handed to the client exactly once (the `#token=` fragment); only the
 *  sha256 is stored. */
export function createLoginSession(
  db: Db,
  userId: string,
  ttlDays: number,
  now: number = Date.now(),
): { id: string; token: string } {
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  db.prepare(
    `INSERT INTO login_sessions
       (id, user_id, token_hash, device_id, created_at, expires_at, revoked_at, last_seen)
     VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)`,
  ).run(id, userId, sha256Hex(token), now, now + ttlDays * 86_400_000, now);
  return { id, token };
}

/** Revokes a login session (`DELETE /v1/auth/session`). */
export function revokeLoginSession(
  db: Db,
  sessionId: string,
  now: number = Date.now(),
): void {
  db.prepare("UPDATE login_sessions SET revoked_at = ? WHERE id = ?").run(
    now,
    sessionId,
  );
}

/** Looks up a login session by its raw bearer token (sha256). Returns the
 *  session row, or undefined when unknown / revoked / expired. */
export function getLoginSessionByToken(
  db: Db,
  token: string,
  now: number = Date.now(),
): LoginSessionRow | undefined {
  const row = db
    .prepare<[string, number], LoginSessionRow>(
      `SELECT * FROM login_sessions
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(sha256Hex(token), now);
  if (row) {
    db.prepare("UPDATE login_sessions SET last_seen = ? WHERE id = ?").run(
      now,
      row.id,
    );
  }
  return row;
}

/** Creates an OAuth `state` (10-minute TTL, single-use) and returns the raw
 *  value to embed in the authorize URL. Only the sha256 is stored. */
export function createOAuthState(db: Db, now: number = Date.now()): string {
  const state = randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO oauth_states (state_hash, created_at, expires_at, used)
     VALUES (?, ?, ?, 0)`,
  ).run(sha256Hex(state), now, now + OAUTH_STATE_TTL_MS);
  return state;
}

/** Single-use consume of an OAuth `state`: marks it used iff it exists,
 *  is unused, and is unexpired. Returns false on reuse/expiry/unknown —
 *  the route maps that to `#error=invalid_state`. */
export function consumeOAuthState(
  db: Db,
  state: string,
  now: number = Date.now(),
): boolean {
  const res = db
    .prepare(
      `UPDATE oauth_states SET used = 1
        WHERE state_hash = ? AND used = 0 AND expires_at > ?`,
    )
    .run(sha256Hex(state), now);
  return res.changes === 1;
}

/** Creates an email magic token (15-minute TTL, single-use) bound to the
 *  normalized email. Returns the raw token for the sign-in link. */
export function createMagicToken(
  db: Db,
  email: string,
  now: number = Date.now(),
): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO magic_tokens (token_hash, email, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, NULL)`,
  ).run(sha256Hex(token), email, now, now + MAGIC_TOKEN_TTL_MS);
  return token;
}

export type ConsumeMagicTokenResult =
  | { ok: true; email: string }
  | { ok: false; reason: "invalid" | "expired" };

/** Single-use consume of a magic token. Unknown or already-used →
 *  `invalid`; past TTL → `expired`. */
export function consumeMagicToken(
  db: Db,
  token: string,
  now: number = Date.now(),
): ConsumeMagicTokenResult {
  const row = db
    .prepare<
      [string],
      { token_hash: string; email: string; expires_at: number; used_at: number | null }
    >(
      `SELECT token_hash, email, expires_at, used_at FROM magic_tokens
        WHERE token_hash = ?`,
    )
    .get(sha256Hex(token));
  if (!row || row.used_at !== null) return { ok: false, reason: "invalid" };
  if (row.expires_at <= now) return { ok: false, reason: "expired" };
  db.prepare("UPDATE magic_tokens SET used_at = ? WHERE token_hash = ?").run(
    now,
    row.token_hash,
  );
  return { ok: true, email: row.email };
}

/** Normalized email for magic-link identity: lowercase + trim. Two
 *  differently-cased addresses are one account (contract §1). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------- Whiteboard (P1-C: discussion-zone shared board) ----------
// Contract: docs/contracts.md "Whiteboard (P1-C: discussion-zone shared
// board)" §7. Helpers: getWhiteboard / putWhiteboard (LWW) / clearWhiteboard.

export interface WhiteboardRow {
  room: string;
  zone_id: string;
  scene_json: string;
  /** Epoch ms; the LWW arbiter (strictly greater wins). */
  updated_at: number;
  /** users.id of the last writer (audit). */
  updated_by: string;
}

export interface PutWhiteboardResult {
  /** True when this write won LWW and was stored. */
  applied: boolean;
  /** The stored `updated_at` after the write (the winner's timestamp). */
  updatedAt: number;
}

/** Latest stored snapshot for a board, or undefined when nothing has been
 *  drawn in this zone yet (contract §6: `404 no_whiteboard`). */
export function getWhiteboard(
  db: Db,
  room: string,
  zoneId: string,
): WhiteboardRow | undefined {
  return db
    .prepare<[string, string], WhiteboardRow>(
      "SELECT * FROM whiteboards WHERE room = ? AND zone_id = ?",
    )
    .get(room, zoneId);
}

/** LWW store (contract §2c, §6 check 4): stores iff there is no row, or
 *  `updatedAt > stored.updated_at` (strictly greater wins; ties are no-ops
 *  — same content re-saved). Returns whether the write was applied and the
 *  stored timestamp afterwards. The future-timestamp guard lives in the
 *  route, not here (it runs before this helper is reached). */
export function putWhiteboard(
  db: Db,
  room: string,
  zoneId: string,
  sceneJson: string,
  updatedAt: number,
  updatedBy: string,
): PutWhiteboardResult {
  const stored = getWhiteboard(db, room, zoneId);
  if (stored && updatedAt <= stored.updated_at) {
    return { applied: false, updatedAt: stored.updated_at };
  }
  db.prepare(
    `INSERT INTO whiteboards (room, zone_id, scene_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room, zone_id) DO UPDATE SET
       scene_json = excluded.scene_json,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(room, zoneId, sceneJson, updatedAt, updatedBy);
  return { applied: true, updatedAt };
}

/** Deletes a board (host clear, contract §6). Idempotent: returns whether a
 *  row existed, but the route answers 204 either way. */
export function clearWhiteboard(
  db: Db,
  room: string,
  zoneId: string,
): boolean {
  const res = db
    .prepare<[string, string]>("DELETE FROM whiteboards WHERE room = ? AND zone_id = ?")
    .run(room, zoneId);
  return res.changes > 0;
}
