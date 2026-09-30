import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  openDb,
  upsertUser,
  upsertRoomState,
  setRoomRole,
  upsertAccount,
  getEffectiveRole,
  getWhiteboard,
  putWhiteboard,
  clearWhiteboard,
} from "../src/db.js";
import type { Db } from "../src/db.js";
import { TokenSigner } from "../src/livekit.js";
import {
  registerWhiteboardRoutes,
  whiteboardId,
  WHITEBOARD_MAX_SNAPSHOT_BYTES,
} from "../src/routes/whiteboards.js";

// docs/contracts.md "Whiteboard (P1-C: discussion-zone shared board)".
//
// One shared fixture for the whole file (mirrors moderation-routes.test.ts):
// rebuilding a Fastify app + better-sqlite3 db per test crashes the vitest
// worker (native assertion in better-sqlite3's Statement destructor).
// Tests stay isolated through unique room names — every whiteboard row and
// role lookup is keyed by room.

const API_SECRET = "wb-test-secret-not-a-real-credential";
const BOSS_EMAIL = "boss@example.com";

interface FanoutCall {
  room: string;
  payload: string;
}

interface Fixture {
  app: FastifyInstance;
  db: Db;
  fanoutCalls: FanoutCall[];
  failFanout: () => void;
  succeedFanout: () => void;
  /** Mint a join token for a user in a room. */
  token: (userId: string, room: string) => Promise<string>;
  /** Create a device user and mint their token. */
  user: (deviceId: string, nickname: string, room: string) => Promise<{ userId: string; token: string }>;
  /** Place a user inside a zone (writes the room_state row PUT reads). */
  place: (room: string, userId: string, zone: string, zoneKind: string) => void;
}

async function buildFixture(putRateLimit?: { max: number; windowMs: number }): Promise<Fixture> {
  const db = openDb(":memory:");
  const fanoutCalls: FanoutCall[] = [];
  let fail = false;
  const clearFanout = {
    broadcast: async (room: string, payload: string) => {
      fanoutCalls.push({ room, payload });
      if (fail) throw new Error("livekit down (test)");
      return { ok: true };
    },
  };
  const signer = new TokenSigner({
    apiKey: "test-key",
    apiSecret: API_SECRET,
    ttlSeconds: 600,
  });
  const app = Fastify({ logger: false });
  await registerWhiteboardRoutes(app, {
    db,
    apiSecret: API_SECRET,
    allowlist: { githubUsers: [], emails: [BOSS_EMAIL] },
    clearFanout,
    ...(putRateLimit ? { putRateLimit } : {}),
  });
  await app.ready();

  const token = (userId: string, room: string) => signer.sign(userId, room, "wb-tester").then((s) => s.token);
  const user = async (deviceId: string, nickname: string, room: string) => {
    const row = upsertUser(db, deviceId, nickname, "#4F8EF7");
    return { userId: row.id, token: await token(row.id, room) };
  };
  const place = (room: string, userId: string, zone: string, zoneKind: string) => {
    upsertRoomState(db, room, userId, null, 0, 0, Date.now(), zone, zoneKind);
  };
  return {
    app,
    db,
    fanoutCalls,
    failFanout: () => { fail = true; },
    succeedFanout: () => { fail = false; },
    token,
    user,
    place,
  };
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

const SCENE = JSON.stringify({ elements: [{ id: "a1", type: "rectangle" }], appState: {}, files: {} });
const putUrl = (room: string, zone: string) => `/v1/rooms/${room}/whiteboards/${zone}`;

async function put(board: { room: string; zone: string }, userId: string, token: string, body: object) {
  return fx.app.inject({
    method: "PUT",
    url: putUrl(board.room, board.zone),
    headers: auth(token),
    payload: { userId, ...body },
  });
}

describe("whiteboardId helper", () => {
  it("builds wb:<room>:<zoneId>", () => {
    expect(whiteboardId("room-a", "zone-1")).toBe("wb:room-a:zone-1");
  });
});

describe("whiteboard db helpers (LWW)", () => {
  it("stores on first write, ignores older/tied writes, replaces on newer", () => {
    const db = fx.db;
    const room = "wb-db-lww";
    // updated_by is a FK to users(id): use real rows.
    const u1 = upsertUser(db, "wb-dev-dbu1", "U1", "#4F8EF7").id;
    const u2 = upsertUser(db, "wb-dev-dbu2", "U2", "#4F8EF7").id;
    expect(getWhiteboard(db, room, "z1")).toBeUndefined();

    const w1 = putWhiteboard(db, room, "z1", "scene-1", 1000, u1);
    expect(w1).toEqual({ applied: true, updatedAt: 1000 });

    const stale = putWhiteboard(db, room, "z1", "scene-0", 999, u2);
    expect(stale).toEqual({ applied: false, updatedAt: 1000 });
    const tie = putWhiteboard(db, room, "z1", "scene-0", 1000, u2);
    expect(tie).toEqual({ applied: false, updatedAt: 1000 });

    const w2 = putWhiteboard(db, room, "z1", "scene-2", 1001, u2);
    expect(w2).toEqual({ applied: true, updatedAt: 1001 });
    const row = getWhiteboard(db, room, "z1")!;
    expect(row.scene_json).toBe("scene-2");
    expect(row.updated_by).toBe(u2);

    expect(clearWhiteboard(db, room, "z1")).toBe(true);
    expect(clearWhiteboard(db, room, "z1")).toBe(false); // idempotent
    expect(getWhiteboard(db, room, "z1")).toBeUndefined();
  });
});

describe("GET /v1/rooms/:room/whiteboards/:zoneId", () => {
  it("404 no_whiteboard when nothing was drawn yet", async () => {
    const room = "wb-get-404";
    const { token } = await fx.user("wb-dev-get404", "Reader", room);
    const r = await fx.app.inject({
      method: "GET",
      url: putUrl(room, "zone-disc"),
      headers: auth(token),
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "no_whiteboard" });
  });

  it("401 missing_bearer / invalid_token, 403 room_mismatch", async () => {
    const room = "wb-get-auth";
    const { userId, token } = await fx.user("wb-dev-getauth", "Reader", room);
    const url = putUrl(room, "zone-disc");

    const noAuth = await fx.app.inject({ method: "GET", url });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json()).toEqual({ error: "missing_bearer" });

    const bad = await fx.app.inject({ method: "GET", url, headers: auth("bogus.token.here") });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: "invalid_token" });

    const other = await fx.app.inject({
      method: "GET",
      url: putUrl("other-room", "zone-disc"),
      headers: auth(token),
    });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toEqual({ error: "room_mismatch" });
    void userId;
  });

  it("returns the stored snapshot to any joined member (no zone check on read)", async () => {
    const room = "wb-get-ok";
    const zone = "zone-disc";
    const writer = await fx.user("wb-dev-getw", "Writer", room);
    fx.place(room, writer.userId, zone, "discussion");
    const pr = await put({ room, zone }, writer.userId, writer.token, {
      scene_json: SCENE,
      updated_at: Date.now(),
    });
    expect(pr.statusCode).toBe(200);

    // A different user who is not in any zone can still read.
    const reader = await fx.user("wb-dev-getr", "Reader", room);
    const r = await fx.app.inject({
      method: "GET",
      url: putUrl(room, zone),
      headers: auth(reader.token),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.scene_json).toBe(SCENE);
    expect(body.updated_by).toBe(writer.userId);
    expect(typeof body.updated_at).toBe("number");
  });
});

describe("PUT /v1/rooms/:room/whiteboards/:zoneId", () => {
  it("stores the first snapshot and returns applied:true", async () => {
    const room = "wb-put-ok";
    const zone = "zone-disc";
    const u = await fx.user("wb-dev-putok", "Drawer", room);
    fx.place(room, u.userId, zone, "discussion");
    const now = Date.now();
    const r = await put({ room, zone }, u.userId, u.token, { scene_json: SCENE, updated_at: now });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, applied: true });

    const g = await fx.app.inject({ method: "GET", url: putUrl(room, zone), headers: auth(u.token) });
    expect(g.statusCode).toBe(200);
    expect(g.json().scene_json).toBe(SCENE);
    expect(g.json().updated_by).toBe(u.userId);
  });

  it("403 not_in_zone when the caller has no room_state row", async () => {
    const room = "wb-put-nozone";
    const u = await fx.user("wb-dev-putnz", "Drawer", room);
    const r = await put({ room, zone: "zone-disc" }, u.userId, u.token, {
      scene_json: SCENE,
      updated_at: Date.now(),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "not_in_zone" });
  });

  it.each([
    ["different zone", "zone-other", "discussion"],
    ["rest zone", "zone-disc", "rest"],
    ["silent zone", "zone-disc", "silent"],
    ["no zone (none)", "zone-disc", "none"],
  ])("403 not_in_zone: %s", async (_label, zone, zoneKind) => {
    const room = `wb-put-nz-${zoneKind}-${zone === "zone-disc" ? "same" : "diff"}`;
    const u = await fx.user(`wb-dev-nz-${room}`, "Drawer", room);
    fx.place(room, u.userId, zone, zoneKind);
    const r = await put({ room, zone: "zone-disc" }, u.userId, u.token, {
      scene_json: SCENE,
      updated_at: Date.now(),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "not_in_zone" });
  });

  it("LWW: older write -> applied:false, newer write -> applied:true", async () => {
    const room = "wb-put-lww";
    const zone = "zone-disc";
    const a = await fx.user("wb-dev-lwwa", "A", room);
    const b = await fx.user("wb-dev-lwwb", "B", room);
    fx.place(room, a.userId, zone, "discussion");
    fx.place(room, b.userId, zone, "discussion");
    const base = Date.now();

    const first = await put({ room, zone }, a.userId, a.token, { scene_json: "v1", updated_at: base });
    expect(first.json()).toEqual({ ok: true, applied: true });

    const stale = await put({ room, zone }, b.userId, b.token, { scene_json: "v0", updated_at: base - 1 });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toEqual({ ok: true, applied: false, updated_at: base });

    const tie = await put({ room, zone }, b.userId, b.token, { scene_json: "v0", updated_at: base });
    expect(tie.json()).toEqual({ ok: true, applied: false, updated_at: base });

    const newer = await put({ room, zone }, b.userId, b.token, { scene_json: "v2", updated_at: base + 1 });
    expect(newer.json()).toEqual({ ok: true, applied: true });

    const g = await fx.app.inject({ method: "GET", url: putUrl(room, zone), headers: auth(a.token) });
    expect(g.json().scene_json).toBe("v2");
    expect(g.json().updated_by).toBe(b.userId);
  });

  it("400 invalid_body on future-dated updated_at (> now + 60s); nothing is stored", async () => {
    const room = "wb-put-future";
    const zone = "zone-disc";
    const u = await fx.user("wb-dev-future", "Drawer", room);
    fx.place(room, u.userId, zone, "discussion");
    const r = await put({ room, zone }, u.userId, u.token, {
      scene_json: SCENE,
      updated_at: Date.now() + 120_000,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_body");

    const g = await fx.app.inject({ method: "GET", url: putUrl(room, zone), headers: auth(u.token) });
    expect(g.statusCode).toBe(404);
  });

  it("accepts updated_at within the +60s skew window", async () => {
    const room = "wb-put-skew";
    const zone = "zone-disc";
    const u = await fx.user("wb-dev-skew", "Drawer", room);
    fx.place(room, u.userId, zone, "discussion");
    const r = await put({ room, zone }, u.userId, u.token, {
      scene_json: SCENE,
      updated_at: Date.now() + 59_000,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, applied: true });
  });

  it("413 too_large over 256 KiB; exactly 262144 bytes is OK", async () => {
    expect(WHITEBOARD_MAX_SNAPSHOT_BYTES).toBe(262144);
    const room = "wb-put-size";
    const zone = "zone-disc";
    const u = await fx.user("wb-dev-size", "Drawer", room);
    fx.place(room, u.userId, zone, "discussion");

    const big = await put({ room, zone }, u.userId, u.token, {
      scene_json: "x".repeat(262_145),
      updated_at: Date.now(),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ error: "too_large" });

    // Over-size writes are not persisted.
    const g1 = await fx.app.inject({ method: "GET", url: putUrl(room, zone), headers: auth(u.token) });
    expect(g1.statusCode).toBe(404);

    const exact = await put({ room, zone }, u.userId, u.token, {
      scene_json: "x".repeat(262_144),
      updated_at: Date.now(),
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toEqual({ ok: true, applied: true });
  });

  it("400 invalid_body on schema failure; 403 identity_mismatch on userId != sub", async () => {
    const room = "wb-put-body";
    const zone = "zone-disc";
    const u = await fx.user("wb-dev-body", "Drawer", room);
    fx.place(room, u.userId, zone, "discussion");

    const bad = await put({ room, zone }, u.userId, u.token, { updated_at: Date.now() });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_body");

    const mismatch = await fx.app.inject({
      method: "PUT",
      url: putUrl(room, zone),
      headers: auth(u.token),
      payload: { userId: "someone-else-id", scene_json: SCENE, updated_at: Date.now() },
    });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json()).toEqual({ error: "identity_mismatch" });
  });
});

describe("DELETE /v1/rooms/:room/whiteboards/:zoneId", () => {
  async function drawBoard(room: string, zone: string) {
    const host = await fx.user(`wb-dev-delh-${room}`, "Host", room);
    setRoomRole(fx.db, room, host.userId, "host", null);
    fx.place(room, host.userId, zone, "discussion");
    const r = await put({ room, zone }, host.userId, host.token, {
      scene_json: SCENE,
      updated_at: Date.now(),
    });
    expect(r.json()).toEqual({ ok: true, applied: true });
    return host;
  }

  it("host DELETE -> 204, row gone, wb_clear broadcast", async () => {
    const room = "wb-del-host";
    const zone = "zone-disc";
    const host = await drawBoard(room, zone);
    const before = fx.fanoutCalls.length;

    const r = await fx.app.inject({
      method: "DELETE",
      url: putUrl(room, zone),
      headers: auth(host.token),
      payload: { userId: host.userId },
    });
    expect(r.statusCode).toBe(204);

    const g = await fx.app.inject({ method: "GET", url: putUrl(room, zone), headers: auth(host.token) });
    expect(g.statusCode).toBe(404);

    expect(fx.fanoutCalls.length).toBe(before + 1);
    const call = fx.fanoutCalls[fx.fanoutCalls.length - 1];
    expect(call.room).toBe(room);
    const msg = JSON.parse(call.payload);
    expect(msg.type).toBe("wb_clear");
    expect(msg.board).toBe(`wb:${room}:${zone}`);
    expect(msg.zone_id).toBe(zone);
    expect(typeof msg.updated_at).toBe("number");
    expect(Math.abs(msg.updated_at - Date.now())).toBeLessThan(60_000);
  });

  it("DELETE is idempotent: second clear and clear of a never-drawn board -> 204", async () => {
    const room = "wb-del-idem";
    const zone = "zone-disc";
    const host = await drawBoard(room, zone);

    const first = await fx.app.inject({
      method: "DELETE",
      url: putUrl(room, zone),
      headers: auth(host.token),
      payload: { userId: host.userId },
    });
    expect(first.statusCode).toBe(204);
    const second = await fx.app.inject({
      method: "DELETE",
      url: putUrl(room, zone),
      headers: auth(host.token),
      payload: { userId: host.userId },
    });
    expect(second.statusCode).toBe(204);

    const never = await fx.app.inject({
      method: "DELETE",
      url: putUrl(room, "zone-never-drawn"),
      headers: auth(host.token),
      payload: { userId: host.userId },
    });
    expect(never.statusCode).toBe(204);
  });

  it("403 not_host for a plain user", async () => {
    const room = "wb-del-user";
    const zone = "zone-disc";
    const host = await drawBoard(room, zone);
    const plain = await fx.user(`wb-dev-delp-${room}`, "Plain", room);

    const r = await fx.app.inject({
      method: "DELETE",
      url: putUrl(room, zone),
      headers: auth(plain.token),
      payload: { userId: plain.userId },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "not_host" });

    // The board survives the failed clear.
    const g = await fx.app.inject({ method: "GET", url: putUrl(room, zone), headers: auth(host.token) });
    expect(g.statusCode).toBe(200);
  });

  it("403 not_host for a site-level admin without the host row", async () => {
    const room = "wb-del-admin";
    const zone = "zone-disc";
    await drawBoard(room, zone);
    const adminRow = upsertAccount(fx.db, {
      provider: "email",
      providerSub: BOSS_EMAIL,
      email: BOSS_EMAIL,
    });
    const adminToken = await fx.token(adminRow.id, room);
    // Prove this caller really is a site admin (and not the room host).
    expect(getEffectiveRole(fx.db, room, adminRow.id, { githubUsers: [], emails: [BOSS_EMAIL] })).toBe("admin");

    const r = await fx.app.inject({
      method: "DELETE",
      url: putUrl(room, zone),
      headers: auth(adminToken),
      payload: { userId: adminRow.id },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "not_host" });
  });

  it("204 even when the wb_clear fan-out fails", async () => {
    const room = "wb-del-fail";
    const zone = "zone-disc";
    const host = await drawBoard(room, zone);
    fx.failFanout();
    try {
      const r = await fx.app.inject({
        method: "DELETE",
        url: putUrl(room, zone),
        headers: auth(host.token),
        payload: { userId: host.userId },
      });
      expect(r.statusCode).toBe(204);
    } finally {
      fx.succeedFanout();
    }
    const g = await fx.app.inject({ method: "GET", url: putUrl(room, zone), headers: auth(host.token) });
    expect(g.statusCode).toBe(404);
  });

  it("400 invalid_body / 403 identity_mismatch on DELETE body", async () => {
    const room = "wb-del-body";
    const zone = "zone-disc";
    const host = await drawBoard(room, zone);

    const bad = await fx.app.inject({
      method: "DELETE",
      url: putUrl(room, zone),
      headers: auth(host.token),
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_body");

    const mismatch = await fx.app.inject({
      method: "DELETE",
      url: putUrl(room, zone),
      headers: auth(host.token),
      payload: { userId: "someone-else-id" },
    });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json()).toEqual({ error: "identity_mismatch" });
  });
});

describe("PUT rate limit (per user per board)", () => {
  let rfx: Fixture;
  beforeAll(async () => {
    rfx = await buildFixture({ max: 3, windowMs: 60_000 });
  });
  afterAll(async () => {
    await rfx.app.close();
    rfx.db.close();
  });

  it("429 rate_limited after the quota is exhausted", async () => {
    const room = "wb-rate";
    const zone = "zone-disc";
    const u = await rfx.user("wb-dev-rate", "Drawer", room);
    rfx.place(room, u.userId, zone, "discussion");
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      const r = await rfx.app.inject({
        method: "PUT",
        url: putUrl(room, zone),
        headers: auth(u.token),
        payload: { userId: u.userId, scene_json: `v${i}`, updated_at: base + i },
      });
      expect(r.statusCode).toBe(200);
    }
    const limited = await rfx.app.inject({
      method: "PUT",
      url: putUrl(room, zone),
      headers: auth(u.token),
      payload: { userId: u.userId, scene_json: "v3", updated_at: base + 3 },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited" });
  });
});
