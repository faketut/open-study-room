import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { openDb, upsertRoomState, setRoomRole, getRoomRole, isMuted } from "../src/db.js";
import type { Db } from "../src/db.js";
import { TokenSigner } from "../src/livekit.js";
import { ZoneMutePolicy } from "../src/zones.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { registerStateRoutes } from "../src/routes/state.js";
import { registerModerationRoutes } from "../src/routes/moderation.js";

const API_SECRET = "secret-secret-secret-secret";
const HUGE = {
  reports: 10_000,
  listReports: 10_000,
  reportAction: 10_000,
  moderate: 10_000,
  host: 10_000,
};

interface MuteCall { op: "mute" | "unmute"; room: string; identity: string }
interface AdminCall { op: "sendData" | "removeParticipant"; room: string; identity: string; payload?: string }

interface Fixture {
  app: FastifyInstance;
  db: Db;
  muteCalls: MuteCall[];
  adminCalls: AdminCall[];
  zonePolicy: ZoneMutePolicy;
  join: (deviceId: string, nickname: string, room: string) => Promise<{ status: number; body: any }>;
}

async function buildFixture(): Promise<Fixture> {
  const db = openDb(":memory:");
  const muteCalls: MuteCall[] = [];
  const adminCalls: AdminCall[] = [];
  const muter = {
    muteMicrophone: async (room: string, identity: string) => {
      muteCalls.push({ op: "mute", room, identity });
      return true;
    },
    unmuteMicrophone: async (room: string, identity: string) => {
      muteCalls.push({ op: "unmute", room, identity });
      return true;
    },
  };
  const admin = {
    sendData: async (room: string, identity: string, payload: string) => {
      adminCalls.push({ op: "sendData", room, identity, payload });
      return { ok: true };
    },
    removeParticipant: async (room: string, identity: string) => {
      adminCalls.push({ op: "removeParticipant", room, identity });
      return { ok: true };
    },
  };
  const zonePolicy = new ZoneMutePolicy(muter, {
    isModerationMuted: (room, identity) => isMuted(db, room, identity),
  });
  const signer = new TokenSigner({
    apiKey: "devkey",
    apiSecret: API_SECRET,
    ttlSeconds: 60,
  });
  const app = Fastify({ logger: false });
  await registerSessionRoutes(app, {
    db,
    signer,
    livekitUrl: "ws://test",
    allowlist: { githubUsers: [], emails: [] },
    rateLimit: { max: 10_000, timeWindowMs: 60_000 },
  });
  registerStateRoutes(app, { db, apiSecret: API_SECRET, zonePolicy });
  await registerModerationRoutes(app, {
    db,
    apiSecret: API_SECRET,
    allowlist: { githubUsers: [], emails: [] },
    zonePolicy,
    muter,
    admin,
    freshWindowMs: 60_000,
    rateLimits: HUGE,
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
  return { app, db, muteCalls, adminCalls, zonePolicy, join };
}

// One shared fixture for the whole file (mirrors routes.test.ts). Rebuilding
// a Fastify app + better-sqlite3 db per test crashes the vitest worker
// (native assertion in better-sqlite3's Statement destructor — GC timing).
// Tests stay isolated through unique room names: every moderation table and
// role lookup is keyed by room.
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

describe("sessions: M2 nickname validation + roles", () => {
  it.each(["fuck you", "you are a BITCH", "傻逼用户", "草泥马"])(
    "rejects profane nickname %p with 400 nickname_rejected",
    async (nickname) => {
      const r = await fx.join("dev-profane-1", nickname, "nick-room");
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("nickname_rejected");
      // The matched word is never echoed back.
      expect(JSON.stringify(r.body)).not.toContain(nickname);
    },
  );

  it.each(["class", "Classic Rock", "grass field", "Assassin"])(
    "accepts %p (word-boundary false positives)",
    async (nickname) => {
      const r = await fx.join(`dev-fp-${nickname.length}`, nickname, "nick-room");
      expect(r.status).toBe(200);
    },
  );

  it("rejects whitespace-only nickname", async () => {
    const r = await fx.join("dev-ws-1", "   ", "nick-room");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("nickname_rejected");
  });

  it("rejects nickname longer than 32 chars", async () => {
    const r = await fx.join("dev-long-1", "a".repeat(33), "nick-room");
    expect(r.status).toBe(400);
  });

  it("first joiner is host, later joiners are users, rejoin keeps host", async () => {
    const a = await fx.join("dev-host-1", "Host", "role-room");
    expect(a.status).toBe(200);
    expect(a.body.role).toBe("host");

    const b = await fx.join("dev-host-2", "User", "role-room");
    expect(b.body.role).toBe("user");

    const a2 = await fx.join("dev-host-1", "Host", "role-room");
    expect(a2.body.userId).toBe(a.body.userId);
    expect(a2.body.role).toBe("host");
  });

  it("refuses token issuance to a user kicked earlier the same UTC day", async () => {
    const host = await fx.join("dev-kickh-1", "Host", "kick-room");
    const victim = await fx.join("dev-kickv-1", "Victim", "kick-room");

    const kick = await fx.app.inject({
      method: "POST",
      url: "/v1/rooms/kick-room/moderate",
      headers: auth(host.body.token),
      payload: { targetUserId: victim.body.userId, action: "kick", reason: "spam" },
    });
    expect(kick.statusCode).toBe(200);

    const rejoin = await fx.join("dev-kickv-1", "Victim", "kick-room");
    expect(rejoin.status).toBe(403);
    expect(rejoin.body.error).toBe("kicked");
  });
});

describe("POST /v1/rooms/:room/reports", () => {
  const ROOM = "rep-room";
  let host: any;
  let user: any;

  beforeEach(async () => {
    host = (await fx.join("dev-reph-1", "Host", ROOM)).body;
    user = (await fx.join("dev-repu-1", "User", ROOM)).body;
  });

  it("files a report → 201 { id, status: open }", async () => {
    const r = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports`,
      headers: auth(user.token),
      payload: { targetId: host.userId, reason: "harassment", detail: "rude" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: "open" });
    expect(r.json().id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("401 missing_bearer / invalid_token; 403 room_mismatch", async () => {
    const noAuth = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports`,
      payload: { targetId: host.userId, reason: "spam" },
    });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json().error).toBe("missing_bearer");

    const bad = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports`,
      headers: auth("garbage.token.here"),
      payload: { targetId: host.userId, reason: "spam" },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe("invalid_token");

    const other = await fx.join("dev-repm-1", "Mismatch", "other-room");
    const mismatch = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports`,
      headers: auth(other.body.token),
      payload: { targetId: host.userId, reason: "spam" },
    });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json().error).toBe("room_mismatch");
  });

  it("400 invalid_reason; 404 target_not_found; 400 invalid_body on long detail", async () => {
    const badReason = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports`,
      headers: auth(user.token),
      payload: { targetId: host.userId, reason: "rude" },
    });
    expect(badReason.statusCode).toBe(400);
    expect(badReason.json().error).toBe("invalid_reason");

    const noTarget = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports`,
      headers: auth(user.token),
      payload: { targetId: "no-such-user", reason: "spam" },
    });
    expect(noTarget.statusCode).toBe(404);
    expect(noTarget.json().error).toBe("target_not_found");

    const longDetail = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports`,
      headers: auth(user.token),
      payload: { targetId: host.userId, reason: "spam", detail: "x".repeat(501) },
    });
    expect(longDetail.statusCode).toBe(400);
    expect(longDetail.json().error).toBe("invalid_body");
  });
});

describe("GET /v1/rooms/:room/reports", () => {
  const ROOM = "list-room";
  let host: any;
  let user: any;

  beforeEach(async () => {
    // Reports accumulate on the shared fixture — reset per test.
    fx.db.prepare("DELETE FROM reports WHERE room = ?").run(ROOM);
    host = (await fx.join("dev-listh-1", "Host", ROOM)).body;
    user = (await fx.join("dev-listu-1", "User", ROOM)).body;
  });

  async function fileReport(reporter: any, targetId: string, reason = "spam") {
    const r = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports`,
      headers: auth(reporter.token),
      payload: { targetId, reason },
    });
    return r.json().id as string;
  }

  it("403 not_host for plain users; 200 ordered list for host", async () => {
    const id1 = await fileReport(user, host.userId, "spam");
    const id2 = await fileReport(host, user.userId, "nsfw");

    const denied = await fx.app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM}/reports`,
      headers: auth(user.token),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("not_host");

    const ok = await fx.app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM}/reports`,
      headers: auth(host.token),
    });
    expect(ok.statusCode).toBe(200);
    const reports = ok.json().reports;
    expect(reports.map((r: any) => r.id)).toEqual([id1, id2]); // created_at ASC
    expect(reports[0]).toMatchObject({
      reporterId: user.userId,
      reporterNickname: "User",
      targetId: host.userId,
      targetNickname: "Host",
      reason: "spam",
      status: "open",
      handledBy: null,
      handledAt: null,
    });
    expect(typeof reports[0].createdAt).toBe("number");
  });

  it("?status=all includes closed reports; default is open", async () => {
    const id1 = await fileReport(user, host.userId, "spam");
    await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports/${id1}/action`,
      headers: auth(host.token),
      payload: { decision: "dismissed" },
    });
    const id2 = await fileReport(user, host.userId, "other");

    const openOnly = await fx.app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM}/reports`,
      headers: auth(host.token),
    });
    expect(openOnly.json().reports.map((r: any) => r.id)).toEqual([id2]);

    const all = await fx.app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM}/reports?status=all`,
      headers: auth(host.token),
    });
    expect(all.json().reports.map((r: any) => r.id)).toEqual([id1, id2]);
    expect(all.json().reports[0]).toMatchObject({
      status: "dismissed",
      handledBy: host.userId,
    });
  });

  it("400 invalid_body on bad status query", async () => {
    const r = await fx.app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM}/reports?status=bogus`,
      headers: auth(host.token),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_body");
  });
});

describe("POST /v1/rooms/:room/reports/:id/action", () => {
  const ROOM = "act-room";
  let host: any;
  let user: any;
  let reportId: string;

  beforeEach(async () => {
    host = (await fx.join("dev-acth-1", "Host", ROOM)).body;
    user = (await fx.join("dev-actu-1", "User", ROOM)).body;
    const r = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports`,
      headers: auth(user.token),
      payload: { targetId: host.userId, reason: "spam" },
    });
    reportId = r.json().id;
  });

  it("closes a report → 200 { id, status }; repeat → 409 already_handled", async () => {
    const ok = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports/${reportId}/action`,
      headers: auth(host.token),
      payload: { decision: "actioned" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: reportId, status: "actioned" });

    const again = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports/${reportId}/action`,
      headers: auth(host.token),
      payload: { decision: "dismissed" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_handled");
  });

  it("404 report_not_found; 400 invalid_body on bad decision; 403 not_host", async () => {
    const missing = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports/no-such-id/action`,
      headers: auth(host.token),
      payload: { decision: "actioned" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("report_not_found");

    const badDecision = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports/${reportId}/action`,
      headers: auth(host.token),
      payload: { decision: "escalated" },
    });
    expect(badDecision.statusCode).toBe(400);
    expect(badDecision.json().error).toBe("invalid_body");

    const denied = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/reports/${reportId}/action`,
      headers: auth(user.token),
      payload: { decision: "dismissed" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("not_host");
  });
});

describe("POST /v1/rooms/:room/moderate", () => {
  const ROOM = "mod-room";
  let host: any;
  let user: any;

  beforeEach(async () => {
    // Spy call logs accumulate on the shared fixture — reset per test.
    fx.muteCalls.length = 0;
    fx.adminCalls.length = 0;
    host = (await fx.join("dev-modh-1", "Host", ROOM)).body;
    user = (await fx.join("dev-modu-1", "User", ROOM)).body;
  });

  const moderate = (token: string, payload: unknown) =>
    fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/moderate`,
      headers: auth(token),
      payload,
    });

  /** A fresh victim per kick test — a kicked device cannot rejoin the same
   *  UTC day, so kick targets must not be reused across tests. */
  let victimSeq = 0;
  const freshVictim = async () => {
    victimSeq += 1;
    const v = await fx.join(`dev-modv-${victimSeq}`, `Victim${victimSeq}`, ROOM);
    expect(v.status).toBe(200);
    return v.body;
  };

  it("403 not_host for plain users; 401 without bearer", async () => {
    const denied = await moderate(user.token, {
      targetUserId: host.userId,
      action: "mute",
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("not_host");

    const noAuth = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/moderate`,
      payload: { targetUserId: user.userId, action: "mute" },
    });
    expect(noAuth.statusCode).toBe(401);
  });

  it("400 cannot_target_self / target_is_host / invalid_action", async () => {
    const self = await moderate(host.token, {
      targetUserId: host.userId,
      action: "mute",
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().error).toBe("cannot_target_self");

    // Second host row planted directly (single-host invariant can't
    // produce this via the API in M2; the guard must still hold).
    const other = (await fx.join("dev-modh-2", "Host2", "host2-room")).body;
    setRoomRole(fx.db, ROOM, other.userId, "host", host.userId);
    const isHost = await moderate(host.token, {
      targetUserId: other.userId,
      action: "mute",
    });
    expect(isHost.statusCode).toBe(400);
    expect(isHost.json().error).toBe("target_is_host");

    const ban = await moderate(host.token, {
      targetUserId: user.userId,
      action: "ban",
    });
    expect(ban.statusCode).toBe(400);
    expect(ban.json().error).toBe("invalid_action");
  });

  it("mute inserts the mutes row and calls muteMicrophone; idempotent", async () => {
    const r1 = await moderate(host.token, {
      targetUserId: user.userId,
      action: "mute",
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ action: "mute", targetUserId: user.userId });
    expect(isMuted(fx.db, ROOM, user.userId)).toBe(true);
    expect(fx.muteCalls).toEqual([
      { op: "mute", room: ROOM, identity: user.userId },
    ]);

    const r2 = await moderate(host.token, {
      targetUserId: user.userId,
      action: "mute",
    });
    expect(r2.statusCode).toBe(200);
    expect(isMuted(fx.db, ROOM, user.userId)).toBe(true);
  });

  it("unmute deletes the row and unmutes the track (zone policy: not silent)", async () => {
    await moderate(host.token, { targetUserId: user.userId, action: "mute" });
    fx.muteCalls.length = 0;

    const r = await moderate(host.token, {
      targetUserId: user.userId,
      action: "unmute",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ action: "unmute", targetUserId: user.userId });
    expect(isMuted(fx.db, ROOM, user.userId)).toBe(false);
    expect(fx.muteCalls).toEqual([
      { op: "unmute", room: ROOM, identity: user.userId },
    ]);
  });

  it("unmute while the target is in a silent zone keeps the track muted (rule 5)", async () => {
    upsertRoomState(fx.db, ROOM, user.userId, null, 0, 0, Date.now(), "z1", "silent");
    await moderate(host.token, { targetUserId: user.userId, action: "mute" });
    fx.muteCalls.length = 0;

    await moderate(host.token, { targetUserId: user.userId, action: "unmute" });
    expect(isMuted(fx.db, ROOM, user.userId)).toBe(false);
    expect(fx.muteCalls).toEqual([
      { op: "mute", room: ROOM, identity: user.userId },
    ]);
  });

  it("kick sends the notice, removes the participant, records the kick row", async () => {
    const victim = await freshVictim();
    const r = await moderate(host.token, {
      targetUserId: victim.userId,
      action: "kick",
      reason: "spamming chat",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ action: "kick", targetUserId: victim.userId });

    const notice = fx.adminCalls.find((c) => c.op === "sendData");
    expect(notice).toMatchObject({ room: ROOM, identity: victim.userId });
    expect(JSON.parse(notice!.payload!)).toEqual({
      type: "kick_notice",
      reason: "spamming chat",
    });
    // Notice goes out before the removal.
    const removal = fx.adminCalls.find((c) => c.op === "removeParticipant");
    expect(removal).toMatchObject({ room: ROOM, identity: victim.userId });
    expect(fx.adminCalls.indexOf(notice!)).toBeLessThan(
      fx.adminCalls.indexOf(removal!),
    );

    const row = fx.db
      .prepare<[string, string], { kicked_by: string; reason: string }>(
        "SELECT kicked_by, reason FROM kicks WHERE room = ? AND user_id = ?",
      )
      .get(ROOM, victim.userId);
    expect(row).toMatchObject({ kicked_by: host.userId, reason: "spamming chat" });
  });

  it("kick without reason sends an empty-string reason", async () => {
    const victim = await freshVictim();
    const kr = await moderate(host.token, { targetUserId: victim.userId, action: "kick" });
    expect(kr.statusCode).toBe(200);
    const notice = fx.adminCalls.find((c) => c.op === "sendData");
    expect(JSON.parse(notice!.payload!)).toEqual({
      type: "kick_notice",
      reason: "",
    });
  });

  it("400 invalid_body on reason longer than 140 chars", async () => {
    const r = await moderate(host.token, {
      targetUserId: user.userId,
      action: "kick",
      reason: "x".repeat(141),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_body");
  });
});

describe("POST /v1/rooms/:room/host", () => {
  const ROOM = "host-room";
  let host: any;
  let user: any;

  beforeEach(async () => {
    host = (await fx.join("dev-hsth-1", "Host", ROOM)).body;
    user = (await fx.join("dev-hstu-1", "User", ROOM)).body;
    // Both are current room members (fresh room_state rows).
    upsertRoomState(fx.db, ROOM, host.userId, null, 0, 0);
    upsertRoomState(fx.db, ROOM, user.userId, null, 10, 10);
  });

  const transfer = (token: string, payload: unknown) =>
    fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/host`,
      headers: auth(token),
      payload,
    });

  it("403 not_host for non-hosts; 400 invalid_body when transferring to self", async () => {
    const denied = await transfer(user.token, { toUserId: host.userId });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("not_host");

    const self = await transfer(host.token, { toUserId: host.userId });
    expect(self.statusCode).toBe(400);
    expect(self.json().error).toBe("invalid_body");
  });

  it("404 member_not_found for unknown or stale members", async () => {
    const unknown = await transfer(host.token, { toUserId: "no-such-user" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("member_not_found");

    const stale = (await fx.join("dev-hsts-1", "Stale", ROOM)).body;
    upsertRoomState(fx.db, ROOM, stale.userId, null, 0, 0, Date.now() - 120_000);
    const gone = await transfer(host.token, { toUserId: stale.userId });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe("member_not_found");
  });

  it("transfers host atomically: old host becomes user, new host can moderate", async () => {
    const ok = await transfer(host.token, { toUserId: user.userId });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ host: user.userId });
    expect(getRoomRole(fx.db, ROOM, host.userId)).toBe("user");
    expect(getRoomRole(fx.db, ROOM, user.userId)).toBe("host");

    // Old host can no longer moderate…
    const denied = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/moderate`,
      headers: auth(host.token),
      payload: { targetUserId: user.userId, action: "mute" },
    });
    expect(denied.statusCode).toBe(403);

    // …but the new host can.
    const allowed = await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/moderate`,
      headers: auth(user.token),
      payload: { targetUserId: host.userId, action: "mute" },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe("zone/moderation mute composition through the state route", () => {
  const ROOM = "zone-room";

  it("leaving silent never lifts a moderation mute (rule 3, end to end)", async () => {
    fx.muteCalls.length = 0;
    const host = (await fx.join("dev-zh-1", "Host", ROOM)).body;
    const user = (await fx.join("dev-zu-1", "User", ROOM)).body;
    const state = (zoneKind: string) =>
      fx.app.inject({
        method: "POST",
        url: `/v1/rooms/${ROOM}/state`,
        headers: auth(user.token),
        payload: { userId: user.userId, x: 0, y: 0, zone: "z1", zone_kind: zoneKind },
      });

    // Enter silent → zone layer mutes.
    await state("silent");
    expect(fx.muteCalls).toEqual([
      { op: "mute", room: ROOM, identity: user.userId },
    ]);

    // Host moderation-mutes the user.
    await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/moderate`,
      headers: auth(host.token),
      payload: { targetUserId: user.userId, action: "mute" },
    });
    expect(isMuted(fx.db, ROOM, user.userId)).toBe(true);
    fx.muteCalls.length = 0;
    fx.zonePolicy.setIntendedMicOn(ROOM, user.userId, true);

    // Leave silent → NO unmute call (moderation mute survives).
    await state("discussion");
    expect(fx.muteCalls).toEqual([]);

    // Host unmutes → row gone, zone policy re-applied (discussion → unmute).
    await fx.app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM}/moderate`,
      headers: auth(host.token),
      payload: { targetUserId: user.userId, action: "unmute" },
    });
    expect(isMuted(fx.db, ROOM, user.userId)).toBe(false);
    expect(fx.muteCalls).toEqual([
      { op: "unmute", room: ROOM, identity: user.userId },
    ]);
  });
});
