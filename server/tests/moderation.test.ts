import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openDb,
  upsertUser,
  upsertRoomState,
  getRoomRole,
  setRoomRole,
  roomHasRoleRow,
  transferHost,
  userExists,
  createReport,
  getReport,
  listReports,
  closeReport,
  ReportNotFoundError,
  ReportAlreadyHandledError,
  addMute,
  removeMute,
  isMuted,
  addKick,
  isKickedToday,
  utcDay,
} from "../src/db.js";
import type { Db, UserRow } from "../src/db.js";
import { containsProfanity } from "../src/moderation/words.js";
import { ZoneMutePolicy } from "../src/zones.js";

let db: Db;
let alice: UserRow;
let bob: UserRow;

beforeEach(() => {
  db = openDb(":memory:");
  alice = upsertUser(db, "device-alice", "Alice", "#111", 1_000);
  bob = upsertUser(db, "device-bob", "Bob", "#222", 2_000);
});
afterEach(() => {
  db.close();
});

describe("db: moderation tables", () => {
  it("openDb creates room_roles / reports / mutes / kicks", () => {
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .all()
      .map((t) => t.name);
    for (const t of ["room_roles", "reports", "mutes", "kicks"]) {
      expect(tables).toContain(t);
    }
  });

  it("userExists", () => {
    expect(userExists(db, alice.id)).toBe(true);
    expect(userExists(db, "no-such-user")).toBe(false);
  });
});

describe("db: room roles", () => {
  it("no row means plain user", () => {
    expect(getRoomRole(db, "r1", alice.id)).toBe("user");
    expect(roomHasRoleRow(db, "r1")).toBe(false);
  });

  it("setRoomRole / getRoomRole round-trip, per-room", () => {
    setRoomRole(db, "r1", alice.id, "host", null, 5_000);
    expect(getRoomRole(db, "r1", alice.id)).toBe("host");
    expect(getRoomRole(db, "r1", bob.id)).toBe("user");
    // Roles are scoped to the room.
    expect(getRoomRole(db, "r2", alice.id)).toBe("user");
    expect(roomHasRoleRow(db, "r1")).toBe(true);
    expect(roomHasRoleRow(db, "r2")).toBe(false);
  });

  it("transferHost atomically swaps the host row", () => {
    setRoomRole(db, "r1", alice.id, "host", null, 5_000);
    transferHost(db, "r1", alice.id, bob.id, 6_000);
    expect(getRoomRole(db, "r1", alice.id)).toBe("user");
    expect(getRoomRole(db, "r1", bob.id)).toBe("host");
    const row = db
      .prepare<[string, string], { granted_by: string; granted_at: number }>(
        "SELECT granted_by, granted_at FROM room_roles WHERE room = ? AND user_id = ?",
      )
      .get("r1", bob.id);
    expect(row?.granted_by).toBe(alice.id);
    expect(row?.granted_at).toBe(6_000);
  });
});

describe("db: reports state machine", () => {
  it("createReport → getReport, defaults to open", () => {
    const r = createReport(db, {
      room: "r1",
      reporterId: alice.id,
      targetId: bob.id,
      reason: "spam",
      detail: "hello",
      now: 10_000,
    });
    expect(r.status).toBe("open");
    expect(r.detail).toBe("hello");
    expect(r.created_at).toBe(10_000);
    expect(getReport(db, r.id)).toMatchObject({ id: r.id, status: "open" });
  });

  it("listReports filters by status and orders by created_at ASC", () => {
    const r1 = createReport(db, {
      room: "r1", reporterId: alice.id, targetId: bob.id, reason: "spam", now: 3_000,
    });
    const r2 = createReport(db, {
      room: "r1", reporterId: bob.id, targetId: alice.id, reason: "nsfw", now: 1_000,
    });
    closeReport(db, r2.id, "dismissed", alice.id, 4_000);

    const open = listReports(db, "r1", "open");
    expect(open.map((r) => r.id)).toEqual([r1.id]);
    expect(open[0]).toMatchObject({
      reporter_nickname: "Alice",
      target_nickname: "Bob",
    });

    const all = listReports(db, "r1", "all");
    expect(all.map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(all[0]).toMatchObject({
      status: "dismissed",
      handled_by: alice.id,
      handled_at: 4_000,
      reporter_nickname: "Bob",
      target_nickname: "Alice",
    });
  });

  it("closeReport records handled_by/at; end states are terminal", () => {
    const r = createReport(db, {
      room: "r1", reporterId: alice.id, targetId: bob.id, reason: "other",
    });
    const closed = closeReport(db, r.id, "actioned", alice.id, 9_000);
    expect(closed).toMatchObject({
      status: "actioned",
      handled_by: alice.id,
      handled_at: 9_000,
    });
    // No transition out of an end state, and none between end states.
    expect(() => closeReport(db, r.id, "dismissed", alice.id)).toThrow(
      ReportAlreadyHandledError,
    );
    expect(() => closeReport(db, r.id, "actioned", alice.id)).toThrow(
      ReportAlreadyHandledError,
    );
  });

  it("closeReport on unknown id throws ReportNotFoundError", () => {
    expect(() => closeReport(db, "nope", "actioned", alice.id)).toThrow(
      ReportNotFoundError,
    );
  });
});

describe("db: mutes", () => {
  it("addMute is idempotent; removeMute / isMuted", () => {
    expect(isMuted(db, "r1", bob.id)).toBe(false);
    addMute(db, "r1", bob.id, alice.id, 1_000);
    expect(isMuted(db, "r1", bob.id)).toBe(true);
    // Re-mute keeps the first audit row (no-op).
    addMute(db, "r1", bob.id, alice.id, 2_000);
    const rows = db
      .prepare<[string, string], { muted_at: number }>(
        "SELECT muted_at FROM mutes WHERE room = ? AND user_id = ?",
      )
      .all("r1", bob.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].muted_at).toBe(1_000);
    // Mutes are per-room.
    expect(isMuted(db, "r2", bob.id)).toBe(false);

    removeMute(db, "r1", bob.id);
    expect(isMuted(db, "r1", bob.id)).toBe(false);
    // Removing an absent row is a no-op.
    expect(() => removeMute(db, "r1", bob.id)).not.toThrow();
  });
});

describe("db: kicks (same-UTC-day block)", () => {
  it("isKickedToday true only on the kick's UTC day", () => {
    const tuesday = Date.UTC(2026, 8, 29, 12, 0, 0); // 2026-09-29
    expect(utcDay(tuesday)).toBe("2026-09-29");
    addKick(db, "r1", bob.id, alice.id, "spam", tuesday);
    expect(isKickedToday(db, "r1", bob.id, tuesday)).toBe(true);
    // Next UTC day: block expired, no cleanup needed.
    expect(
      isKickedToday(db, "r1", bob.id, tuesday + 24 * 3_600_000),
    ).toBe(false);
    // Other room unaffected.
    expect(isKickedToday(db, "r2", bob.id, tuesday)).toBe(false);
  });

  it("same-day re-kick refreshes kicked_at/reason", () => {
    const t0 = Date.UTC(2026, 8, 29, 10, 0, 0);
    addKick(db, "r1", bob.id, alice.id, "first", t0);
    addKick(db, "r1", bob.id, alice.id, "second", t0 + 3_600_000);
    const row = db
      .prepare<[string, string], { kicked_at: number; reason: string; day: string }>(
        "SELECT kicked_at, reason, day FROM kicks WHERE room = ? AND user_id = ?",
      )
      .get("r1", bob.id);
    expect(row?.kicked_at).toBe(t0 + 3_600_000);
    expect(row?.reason).toBe("second");
    expect(row?.day).toBe("2026-09-29");
  });
});

describe("words: containsProfanity", () => {
  it.each([
    ["fuck", true],
    ["What the Fuck", true], // case-insensitive
    ["you are a bitch!", true],
    ["shit happens", true],
    ["傻逼", true],
    ["你是个傻逼吧", true], // CJK substring
    ["操你妈", true],
  ])("detects %p", (text, expected) => {
    expect(containsProfanity(text)).toBe(expected);
  });

  it.each([
    ["class", "ass as substring must not trip"],
    ["classic", "ass as substring must not trip"],
    ["grass", "ass as substring must not trip"],
    ["Assassin", "ass at word start must not trip"],
    ["fucker", "fuck inside a longer word must not trip (word boundary)"],
    ["shell", "hell is not in the list"],
    ["Hello world", "clean text"],
    ["", "empty text"],
    ["操场", "single CJK char not in list"],
    ["abc123", "alphanumeric"],
  ])("does not flag %p (%s)", (text) => {
    expect(containsProfanity(text)).toBe(false);
  });
});

/** Spy standing in for RoomMutator — records mute/unmute calls. */
function makeMuteSpy() {
  const calls: Array<{ op: "mute" | "unmute"; room: string; identity: string }> = [];
  const muter = {
    muteMicrophone: async (room: string, identity: string) => {
      calls.push({ op: "mute", room, identity });
      return true;
    },
    unmuteMicrophone: async (room: string, identity: string) => {
      calls.push({ op: "unmute", room, identity });
      return true;
    },
  };
  return { calls, muter };
}

describe("zones: M2 §3a mute composition rules", () => {
  // The `mutes` table has FKs into `users`, so identities below are real
  // user ids (identity === userId, as the LiveKit token uses).
  let uid: string;
  let hostId: string;
  beforeEach(() => {
    uid = upsertUser(db, "device-u1", "U1", "#333", 3_000).id;
    hostId = upsertUser(db, "device-host1", "Host1", "#444", 4_000).id;
  });
  it("rule 2: entering silent mutes the track without touching mutes", () => {
    const { calls, muter } = makeMuteSpy();
    const policy = new ZoneMutePolicy(muter, {
      isModerationMuted: () => false,
    });
    return policy
      .onZoneReport({
        room: "r1",
        identity: uid,
        prevZoneKind: "none",
        zoneKind: "silent",
      })
      .then((action) => {
        expect(action).toBe("muted");
        expect(calls).toEqual([{ op: "mute", room: "r1", identity: uid }]);
        expect(isMuted(db, "r1", uid)).toBe(false);
      });
  });

  it("rule 3: leaving silent does NOT unmute when a moderation mute exists", async () => {
    const { calls, muter } = makeMuteSpy();
    const policy = new ZoneMutePolicy(muter, {
      isModerationMuted: (room, identity) => isMuted(db, room, identity),
    });
    policy.setIntendedMicOn("r1", uid, true);
    addMute(db, "r1", uid, hostId);
    const action = await policy.onZoneReport({
      room: "r1",
      identity: uid,
      prevZoneKind: "silent",
      zoneKind: "discussion",
    });
    expect(action).toBe("none");
    expect(calls).toEqual([]);
  });

  it("leaving silent unmutes when there is no moderation mute", async () => {
    const { calls, muter } = makeMuteSpy();
    const policy = new ZoneMutePolicy(muter, {
      isModerationMuted: (room, identity) => isMuted(db, room, identity),
    });
    policy.setIntendedMicOn("r1", uid, true);
    const action = await policy.onZoneReport({
      room: "r1",
      identity: uid,
      prevZoneKind: "silent",
      zoneKind: "discussion",
    });
    expect(action).toBe("unmuted");
    expect(calls).toEqual([{ op: "unmute", room: "r1", identity: uid }]);
  });

  it("rule 6: steady-state report from a moderation-muted user re-applies the mute", async () => {
    const { calls, muter } = makeMuteSpy();
    const policy = new ZoneMutePolicy(muter, {
      isModerationMuted: (room, identity) => isMuted(db, room, identity),
    });
    addMute(db, "r1", uid, hostId);
    // Rejoin heartbeat: zone unchanged (none → none), still muted.
    const action = await policy.onZoneReport({
      room: "r1",
      identity: uid,
      prevZoneKind: "none",
      zoneKind: "none",
    });
    expect(action).toBe("muted");
    expect(calls).toEqual([{ op: "mute", room: "r1", identity: uid }]);
  });

  it("rule 6: no re-apply for users without a moderation mute", async () => {
    const { calls, muter } = makeMuteSpy();
    const policy = new ZoneMutePolicy(muter, {
      isModerationMuted: (room, identity) => isMuted(db, room, identity),
    });
    const action = await policy.onZoneReport({
      room: "r1",
      identity: uid,
      prevZoneKind: "none",
      zoneKind: "none",
    });
    expect(action).toBe("none");
    expect(calls).toEqual([]);
  });

  it("rule 5: reapplyAfterModerationUnmute keeps the mute in a silent zone", async () => {
    const { calls, muter } = makeMuteSpy();
    const policy = new ZoneMutePolicy(muter);
    const action = await policy.reapplyAfterModerationUnmute({
      room: "r1",
      identity: uid,
      zoneKind: "silent",
    });
    expect(action).toBe("muted");
    expect(calls).toEqual([{ op: "mute", room: "r1", identity: uid }]);
  });

  it("rule 5: reapplyAfterModerationUnmute unmutes outside silent zones", async () => {
    const { calls, muter } = makeMuteSpy();
    const policy = new ZoneMutePolicy(muter);
    for (const kind of ["none", "discussion", "rest", null] as const) {
      calls.length = 0;
      const action = await policy.reapplyAfterModerationUnmute({
        room: "r1",
        identity: uid,
        zoneKind: kind,
      });
      expect(action).toBe("unmuted");
      expect(calls).toEqual([{ op: "unmute", room: "r1", identity: uid }]);
    }
  });

  it("end-to-end via room_state: unmute re-applies the target's stored zone policy", async () => {
    const { calls, muter } = makeMuteSpy();
    const policy = new ZoneMutePolicy(muter, {
      isModerationMuted: (room, identity) => isMuted(db, room, identity),
    });
    // Target's last reported zone_kind is silent (stored in room_state).
    upsertRoomState(db, "r1", bob.id, null, 0, 0, 1_000, "zone-s", "silent");
    addMute(db, "r1", bob.id, alice.id);
    // Moderation unmute: delete the row, then re-apply the zone policy.
    removeMute(db, "r1", bob.id);
    const st = db
      .prepare<[string, string], { zone_kind: string | null }>(
        "SELECT zone_kind FROM room_state WHERE room = ? AND user_id = ?",
      )
      .get("r1", bob.id);
    await policy.reapplyAfterModerationUnmute({
      room: "r1",
      identity: bob.id,
      zoneKind: (st?.zone_kind ?? null) as "silent" | null,
    });
    expect(calls).toEqual([{ op: "mute", room: "r1", identity: bob.id }]);
  });
});
