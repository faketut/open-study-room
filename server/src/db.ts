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
