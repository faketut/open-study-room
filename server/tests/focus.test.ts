import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import {
  openDb,
  upsertUser,
  startFocusSession,
  endFocusSession,
  getActiveFocusSession,
  getFocusSession,
  settleStaleFocusSessions,
  getFocusStats,
  FocusSessionNotFoundError,
  FocusSessionForbiddenError,
} from "../src/db.js";
import type { Db, UserRow } from "../src/db.js";
import { TokenSigner } from "../src/livekit.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { registerFocusRoutes } from "../src/routes/focus.js";

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Shared fixture: ONE db + ONE app for the whole file.
//
// NOTE (better-sqlite3 GC crash): opening extra better-sqlite3 dbs in the
// same file as this fixture crashes the vitest worker (native assertion in
// better-sqlite3's Statement destructor — see moderation-routes.test.ts).
// So the db-level tests below run against the fixture db and isolate through
// unique users per test. (The migration-idempotency test is the only
// exception: it briefly opens a transient file db and closes it inside the
// test.)
// ---------------------------------------------------------------------------

const API_SECRET = "secret-secret-secret-secret";

interface Fixture {
  app: FastifyInstance;
  db: Db;
  join: (
    deviceId: string,
    nickname: string,
    room: string,
  ) => Promise<{ status: number; body: any }>;
}

async function buildFixture(): Promise<Fixture> {
  const db = openDb(":memory:");
  const signer = new TokenSigner({
    apiKey: "devkey",
    apiSecret: API_SECRET,
    ttlSeconds: 3600,
  });
  const app = Fastify({ logger: false });
  await registerSessionRoutes(app, {
    db,
    signer,
    livekitUrl: "ws://test",
    rateLimit: { max: 10_000, timeWindowMs: 60_000 },
  });
  await registerFocusRoutes(app, {
    db,
    apiSecret: API_SECRET,
    rateLimits: { start: 10_000, end: 10_000, active: 10_000, stats: 10_000 },
  });
  await app.ready();

  const join = async (deviceId: string, nickname: string, room: string) => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { deviceId, nickname, room },
    });
    return { status: r.statusCode, body: r.json() };
  };
  return { app, db, join };
}

let fx: Fixture;
beforeAll(async () => {
  fx = await buildFixture();
});
afterAll(async () => {
  await fx.app.close();
  fx.db.close();
});

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

let userSeq = 0;

/** A fresh db user (unique device id) for db-level tests. */
function freshUser(nickname: string): UserRow {
  userSeq += 1;
  return upsertUser(
    fx.db,
    `device-focus-db-${userSeq}`,
    nickname,
    "#111",
    userSeq * 1_000,
  );
}

/** Insert a completed focus session starting at `startMs`. */
function completedFocus(userId: string, startMs: number, minutes = 25): void {
  const row = startFocusSession(fx.db, {
    userId,
    room: "r1",
    kind: "focus",
    plannedMinutes: minutes,
    now: startMs,
  });
  endFocusSession(fx.db, row.id, userId, row.ends_at);
}

function completedBreak(userId: string, startMs: number): void {
  const row = startFocusSession(fx.db, {
    userId,
    room: "r1",
    kind: "break",
    plannedMinutes: 5,
    now: startMs,
  });
  endFocusSession(fx.db, row.id, userId, row.ends_at);
}

/** A fresh joined user (HTTP) for route-level tests. */
async function newUser(room: string) {
  userSeq += 1;
  const r = await fx.join(`dev-focus-${userSeq}`, `FocusUser${userSeq}`, room);
  expect(r.status).toBe(200);
  return { token: r.body.token as string, userId: r.body.userId as string };
}

// ---------------------------------------------------------------------------
// db-level tests (against the fixture db; isolation via unique users).
// ---------------------------------------------------------------------------

describe("focus: db layer", () => {
  describe("db: focus_sessions migration", () => {
    it("openDb creates the focus_sessions table + index (contract §1 SQL)", () => {
      const tables = fx.db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .all()
        .map((t) => t.name);
      expect(tables).toContain("focus_sessions");
      const indexes = fx.db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index'",
        )
        .all()
        .map((t) => t.name);
      expect(indexes).toContain("idx_focus_sessions_user_started");
    });

    it("migration is idempotent: reopening an existing file db keeps rows", () => {
      const dir = mkdtempSync(pathJoin(tmpdir(), "focus-migrate-"));
      try {
        const path = pathJoin(dir, "test.db");
        const db1 = openDb(path);
        const u = upsertUser(db1, "d1", "A", "#1", 1_000);
        const s = startFocusSession(db1, {
          userId: u.id,
          room: "r",
          kind: "focus",
          plannedMinutes: 25,
          now: 1_000,
        });
        db1.close();

        const db2 = openDb(path); // migrate runs again on the existing file
        const row = getFocusSession(db2, s.id);
        expect(row).toMatchObject({ kind: "focus", planned_minutes: 25 });
        expect(getActiveFocusSession(db2, u.id, 2_000)).toMatchObject({
          id: s.id,
        });
        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("db: start / end", () => {
    it("start inserts with server-computed ends_at; end on time completes", () => {
      const alice = freshUser("Alice");
      const now = 1_000_000;
      const row = startFocusSession(fx.db, {
        userId: alice.id,
        room: "r1",
        kind: "focus",
        plannedMinutes: 25,
        now,
      });
      expect(row.started_at).toBe(now);
      expect(row.ends_at).toBe(now + 25 * 60_000);
      expect(row.ended_at).toBeNull();
      expect(row.completed).toBe(0);

      expect(getActiveFocusSession(fx.db, alice.id, now)).toMatchObject({
        id: row.id,
      });

      const ended = endFocusSession(fx.db, row.id, alice.id, row.ends_at);
      expect(ended.ended_at).toBe(row.ends_at);
      expect(ended.completed).toBe(1);
      expect(getActiveFocusSession(fx.db, alice.id, row.ends_at)).toBeNull();
    });

    it("60s grace: 59s early completes, exactly 60s early completes, 61s early does not", () => {
      const alice = freshUser("Alice");
      const mk = () =>
        startFocusSession(fx.db, {
          userId: alice.id,
          room: "r1",
          kind: "focus",
          plannedMinutes: 25,
          now: 10_000_000,
        });
      const endsAt = 10_000_000 + 25 * 60_000;

      expect(
        endFocusSession(fx.db, mk().id, alice.id, endsAt - 59_000).completed,
      ).toBe(1);
      expect(
        endFocusSession(fx.db, mk().id, alice.id, endsAt - 60_000).completed,
      ).toBe(1);
      expect(
        endFocusSession(fx.db, mk().id, alice.id, endsAt - 61_000).completed,
      ).toBe(0);
    });

    it("manual early end marks completed = 0", () => {
      const alice = freshUser("Alice");
      const row = startFocusSession(fx.db, {
        userId: alice.id,
        room: "r1",
        kind: "focus",
        plannedMinutes: 25,
        now: 5_000_000,
      });
      const ended = endFocusSession(
        fx.db,
        row.id,
        alice.id,
        row.started_at + 60_000,
      );
      expect(ended.completed).toBe(0);
      expect(ended.ended_at).toBe(row.started_at + 60_000);
    });

    it("repeated end is idempotent: returns the stored result", () => {
      const alice = freshUser("Alice");
      const row = startFocusSession(fx.db, {
        userId: alice.id,
        room: "r1",
        kind: "focus",
        plannedMinutes: 25,
        now: 7_000_000,
      });
      const first = endFocusSession(fx.db, row.id, alice.id, row.ends_at);
      // A later "end" must not overwrite ended_at/completed.
      const second = endFocusSession(
        fx.db,
        row.id,
        alice.id,
        row.ends_at + 3_600_000,
      );
      expect(second.ended_at).toBe(first.ended_at);
      expect(second.completed).toBe(first.completed);
    });

    it("unknown id throws FocusSessionNotFoundError; another user's id throws FocusSessionForbiddenError", () => {
      const alice = freshUser("Alice");
      const bob = freshUser("Bob");
      expect(() => endFocusSession(fx.db, "nope", alice.id, 1)).toThrow(
        FocusSessionNotFoundError,
      );
      const row = startFocusSession(fx.db, {
        userId: alice.id,
        room: "r1",
        kind: "focus",
        plannedMinutes: 25,
        now: 9_000_000,
      });
      expect(() => endFocusSession(fx.db, row.id, bob.id, 9_000_001)).toThrow(
        FocusSessionForbiddenError,
      );
    });
  });

  describe("db: lazy settle + single active", () => {
    it("stale actives (ends_at < now - 300_000) are settled as ended_at = ends_at, completed = 0", () => {
      const alice = freshUser("Alice");
      const t0 = 20_000_000;
      const row = startFocusSession(fx.db, {
        userId: alice.id,
        room: "r1",
        kind: "focus",
        plannedMinutes: 25,
        now: t0,
      });
      // Not stale yet: within the 5-minute grace the session stays active.
      expect(
        settleStaleFocusSessions(fx.db, alice.id, row.ends_at + 299_999),
      ).toBe(0);
      expect(
        getActiveFocusSession(fx.db, alice.id, row.ends_at + 299_999),
      ).toMatchObject({ id: row.id });
      // Past the grace: lazy-settled on read.
      const settled = getActiveFocusSession(
        fx.db,
        alice.id,
        row.ends_at + 300_001,
      );
      expect(settled).toBeNull();
      const stored = getFocusSession(fx.db, row.id);
      expect(stored).toMatchObject({ ended_at: row.ends_at, completed: 0 });
    });

    it("a new start interrupts the previous active session (ended_at = now, completed = 0)", () => {
      const alice = freshUser("Alice");
      const t0 = 30_000_000;
      const a = startFocusSession(fx.db, {
        userId: alice.id,
        room: "r1",
        kind: "focus",
        plannedMinutes: 25,
        now: t0,
      });
      const t1 = t0 + 60_000;
      const b = startFocusSession(fx.db, {
        userId: alice.id,
        room: "r1",
        kind: "break",
        plannedMinutes: 5,
        now: t1,
      });
      const storedA = getFocusSession(fx.db, a.id);
      expect(storedA).toMatchObject({ ended_at: t1, completed: 0 });
      expect(getActiveFocusSession(fx.db, alice.id, t1)).toMatchObject({
        id: b.id,
      });
    });

    it("a stale session is settled (not interrupted-as-now) when a new one starts", () => {
      const alice = freshUser("Alice");
      const t0 = 40_000_000;
      const a = startFocusSession(fx.db, {
        userId: alice.id,
        room: "r1",
        kind: "focus",
        plannedMinutes: 25,
        now: t0,
      });
      const t1 = a.ends_at + 300_001; // well past the stale line
      const b = startFocusSession(fx.db, {
        userId: alice.id,
        room: "r1",
        kind: "focus",
        plannedMinutes: 25,
        now: t1,
      });
      expect(getFocusSession(fx.db, a.id)).toMatchObject({
        ended_at: a.ends_at,
        completed: 0,
      });
      expect(getActiveFocusSession(fx.db, alice.id, t1)).toMatchObject({
        id: b.id,
      });
    });
  });

  describe("db: getFocusStats", () => {
    it("todaySec / weekSec / last7Days sum completed focus only; breaks and incomplete sessions excluded", () => {
      const alice = freshUser("Alice");
      // 2026-09-28 12:00 UTC — fixed "today" (tz 0).
      const now = Date.UTC(2026, 8, 28, 12, 0, 0);
      const dayStart = Date.UTC(2026, 8, 28, 0, 0, 0);
      completedFocus(alice.id, dayStart + 9 * 3600_000); // 09:00, 25 min
      completedFocus(alice.id, dayStart + 14 * 3600_000); // 14:00, 25 min
      completedBreak(alice.id, dayStart + 15 * 3600_000); // break: excluded
      // Incomplete focus: excluded.
      const bad = startFocusSession(fx.db, {
        userId: alice.id,
        room: "r1",
        kind: "focus",
        plannedMinutes: 25,
        now: dayStart + 16 * 3600_000,
      });
      endFocusSession(fx.db, bad.id, alice.id, bad.started_at + 60_000);
      // Yesterday's completed focus counts toward the week but not today.
      completedFocus(alice.id, dayStart - 3 * 3600_000, 10); // 21:00 prev day, 10 min

      const stats = getFocusStats(fx.db, alice.id, 0, now);
      expect(stats.todaySec).toBe(2 * 25 * 60);
      expect(stats.weekSec).toBe(2 * 25 * 60 + 10 * 60);
      expect(stats.totalCompletedSessions).toBe(3);
      expect(stats.last7Days).toHaveLength(7);
      const today = stats.last7Days[6];
      expect(today.day).toBe("2026-09-28");
      expect(today.seconds).toBe(2 * 25 * 60);
      const yesterday = stats.last7Days[5];
      expect(yesterday.day).toBe("2026-09-27");
      expect(yesterday.seconds).toBe(10 * 60);
      for (const d of stats.last7Days.slice(0, 5)) {
        expect(d.seconds).toBe(0);
      }
    });

    it("streak: consecutive counted days ending today", () => {
      const alice = freshUser("Alice");
      const now = Date.UTC(2026, 8, 28, 18, 0, 0);
      const dayStart = Date.UTC(2026, 8, 28, 0, 0, 0);
      completedFocus(alice.id, dayStart - 2 * DAY_MS + 12 * 3600_000);
      completedFocus(alice.id, dayStart - DAY_MS + 12 * 3600_000);
      completedFocus(alice.id, dayStart + 12 * 3600_000);
      const stats = getFocusStats(fx.db, alice.id, 0, now);
      expect(stats.streakDays).toBe(3);
    });

    it("streak grace: today uncounted but yesterday counted → streak runs through yesterday", () => {
      const alice = freshUser("Alice");
      const now = Date.UTC(2026, 8, 28, 18, 0, 0);
      const dayStart = Date.UTC(2026, 8, 28, 0, 0, 0);
      completedFocus(alice.id, dayStart - DAY_MS + 12 * 3600_000);
      const stats = getFocusStats(fx.db, alice.id, 0, now);
      expect(stats.streakDays).toBe(1);
    });

    it("streak is 0 when yesterday is also uncounted (grace extends only one day)", () => {
      const alice = freshUser("Alice");
      const now = Date.UTC(2026, 8, 28, 18, 0, 0);
      const dayStart = Date.UTC(2026, 8, 28, 0, 0, 0);
      completedFocus(alice.id, dayStart - 2 * DAY_MS + 12 * 3600_000);
      const stats = getFocusStats(fx.db, alice.id, 0, now);
      expect(stats.streakDays).toBe(0);
    });

    it("tzOffsetMin: with UTC+8, 23:30 and 00:30 local are two different days", () => {
      const alice = freshUser("Alice");
      // Local 2026-09-28 23:30 +08:00 == UTC 2026-09-28 15:30.
      // Local 2026-09-29 00:30 +08:00 == UTC 2026-09-28 16:30.
      const a = Date.UTC(2026, 8, 28, 15, 30, 0);
      const b = Date.UTC(2026, 8, 28, 16, 30, 0);
      const now = Date.UTC(2026, 8, 28, 17, 0, 0); // local 2026-09-29 01:00
      completedFocus(alice.id, a);
      completedFocus(alice.id, b);

      const stats = getFocusStats(fx.db, alice.id, 480, now);
      expect(stats.streakDays).toBe(2);
      expect(stats.totalCompletedSessions).toBe(2);
      const byDay = Object.fromEntries(
        stats.last7Days.map((d) => [d.day, d.seconds]),
      );
      expect(byDay["2026-09-28"]).toBe(25 * 60);
      expect(byDay["2026-09-29"]).toBe(25 * 60);

      // Same two sessions under tz 0 are both 2026-09-28 → one counted day.
      const statsUtc = getFocusStats(fx.db, alice.id, 0, now);
      expect(statsUtc.streakDays).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// route tests (same fixture; isolation via unique rooms).
// ---------------------------------------------------------------------------

describe("routes: focus auth", () => {
  it("401 missing_bearer / invalid_token; 403 room_mismatch", async () => {
    const room = "focus-auth-room";
    const me = await newUser(room);

    const noAuth = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/focus/sessions`,
      payload: { kind: "focus", plannedMinutes: 25 },
    });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json().error).toBe("missing_bearer");

    const bad = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/focus/sessions`,
      headers: auth("garbage.token.here"),
      payload: { kind: "focus", plannedMinutes: 25 },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe("invalid_token");

    const other = await fx.app.inject({
      method: "POST",
      url: "/v1/rooms/other-room/focus/sessions",
      headers: auth(me.token),
      payload: { kind: "focus", plannedMinutes: 25 },
    });
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe("room_mismatch");

    const statsNoAuth = await fx.app.inject({
      method: "GET",
      url: `/v1/users/${me.userId}/focus/stats`,
    });
    expect(statsNoAuth.statusCode).toBe(401);
  });

  it("start validates body: kind and plannedMinutes 1–180", async () => {
    const room = "focus-body-room";
    const me = await newUser(room);
    for (const payload of [
      { kind: "focus", plannedMinutes: 0 },
      { kind: "focus", plannedMinutes: 181 },
      { kind: "nap", plannedMinutes: 25 },
      { plannedMinutes: 25 },
      {},
    ]) {
      const r = await fx.app.inject({
        method: "POST",
        url: `/v1/rooms/${room}/focus/sessions`,
        headers: auth(me.token),
        payload,
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_body");
    }
  });
});

describe("routes: start → active → end", () => {
  it("full loop: 201 start, active returns it, end returns 200 with duration, active is null after", async () => {
    const room = "focus-loop-room";
    const me = await newUser(room);

    const start = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/focus/sessions`,
      headers: auth(me.token),
      payload: { kind: "focus", plannedMinutes: 25 },
    });
    expect(start.statusCode).toBe(201);
    const started = start.json();
    expect(started).toMatchObject({
      kind: "focus",
      plannedMinutes: 25,
    });
    expect(typeof started.id).toBe("string");
    expect(started.endsAt).toBe(started.startedAt + 25 * 60_000);

    const active = await fx.app.inject({
      method: "GET",
      url: `/v1/rooms/${room}/focus/active`,
      headers: auth(me.token),
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().session).toMatchObject({ id: started.id });

    const end = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/focus/sessions/${started.id}/end`,
      headers: auth(me.token),
      payload: {},
    });
    expect(end.statusCode).toBe(200);
    const ended = end.json();
    expect(ended).toMatchObject({ id: started.id, completed: 0 });
    expect(ended.durationSec).toBeGreaterThanOrEqual(0);

    const activeAfter = await fx.app.inject({
      method: "GET",
      url: `/v1/rooms/${room}/focus/active`,
      headers: auth(me.token),
    });
    expect(activeAfter.json().session).toBeNull();
  });

  it("end: unknown id → 404; another user's id → 403; double end is idempotent", async () => {
    const room = "focus-end-room";
    const me = await newUser(room);
    const other = await newUser(room);

    const missing = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/focus/sessions/does-not-exist/end`,
      headers: auth(me.token),
      payload: {},
    });
    expect(missing.statusCode).toBe(404);

    const start = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/focus/sessions`,
      headers: auth(other.token),
      payload: { kind: "focus", plannedMinutes: 25 },
    });
    const otherId = start.json().id as string;

    const othersEnd = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/focus/sessions/${otherId}/end`,
      headers: auth(me.token),
      payload: {},
    });
    expect(othersEnd.statusCode).toBe(403);

    const first = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/focus/sessions/${otherId}/end`,
      headers: auth(other.token),
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const second = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/focus/sessions/${otherId}/end`,
      headers: auth(other.token),
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it("starting a second session interrupts the first (only one active)", async () => {
    const room = "focus-interrupt-room";
    const me = await newUser(room);

    const first = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/focus/sessions`,
      headers: auth(me.token),
      payload: { kind: "focus", plannedMinutes: 25 },
    });
    const second = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/focus/sessions`,
      headers: auth(me.token),
      payload: { kind: "break", plannedMinutes: 5 },
    });
    expect(second.statusCode).toBe(201);
    const active = await fx.app.inject({
      method: "GET",
      url: `/v1/rooms/${room}/focus/active`,
      headers: auth(me.token),
    });
    expect(active.json().session.id).toBe(second.json().id);
    // The first session was interrupted as incomplete.
    const reEnd = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/focus/sessions/${first.json().id}/end`,
      headers: auth(me.token),
      payload: {},
    });
    expect(reEnd.json()).toMatchObject({ completed: 0 });
  });
});

describe("routes: stats", () => {
  it("stats reflect completed focus sessions; only the caller may read them", async () => {
    const room = "focus-stats-room";
    const me = await newUser(room);
    const stranger = await newUser(room);

    // A completed 25-min focus that started 30 minutes ago (server clock).
    const startMs = Date.now() - 30 * 60_000;
    const row = startFocusSession(fx.db, {
      userId: me.userId,
      room,
      kind: "focus",
      plannedMinutes: 25,
      now: startMs,
    });
    endFocusSession(fx.db, row.id, me.userId, row.ends_at);

    const ok = await fx.app.inject({
      method: "GET",
      url: `/v1/users/${me.userId}/focus/stats?tzOffsetMin=0`,
      headers: auth(me.token),
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.totalCompletedSessions).toBe(1);
    expect(body.streakDays).toBe(1);
    // Deterministic day attribution even across a UTC midnight boundary:
    // the session belongs to the day it started in.
    const dayOf = (ts: number) =>
      new Date(Math.floor(ts / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
    const entry = body.last7Days.find((d: any) => d.day === dayOf(startMs));
    expect(entry).toBeDefined();
    expect(entry.seconds).toBe(25 * 60);
    expect(body.todaySec).toBe(
      dayOf(startMs) === dayOf(Date.now()) ? 25 * 60 : 0,
    );
    expect(body.last7Days).toHaveLength(7);

    // Another user cannot read my stats.
    const forbidden = await fx.app.inject({
      method: "GET",
      url: `/v1/users/${me.userId}/focus/stats`,
      headers: auth(stranger.token),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toBe("forbidden");
  });

  it("stats rejects a non-integer tzOffsetMin with 400", async () => {
    const room = "focus-stats-tz-room";
    const me = await newUser(room);
    const r = await fx.app.inject({
      method: "GET",
      url: `/v1/users/${me.userId}/focus/stats?tzOffsetMin=abc`,
      headers: auth(me.token),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_body");
  });
});
