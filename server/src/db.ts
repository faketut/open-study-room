import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type Db = Database.Database;

export interface UserRow {
  id: string;
  device_id: string;
  nickname: string;
  color: string;
  created_at: number;
  last_seen: number;
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
  `);
  ensureRoomStateZoneColumns(db);
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
