import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import {
  openDb,
  upsertUser,
  upsertRoomState,
  getRoomState,
  getRoomSnapshot,
  ensureRoomStateZoneColumns,
} from "../src/db.js";
import type { Db } from "../src/db.js";
import { TokenSigner, RoomMutator } from "../src/livekit.js";
import type { ParticipantInfo } from "livekit-server-sdk";
import { ZoneMutePolicy } from "../src/zones.js";
import { registerStateRoutes } from "../src/routes/state.js";

const API_SECRET = "secret-secret-secret-secret";

function makeToken(userId: string, room: string): Promise<string> {
  const signer = new TokenSigner({
    apiKey: "devkey",
    apiSecret: API_SECRET,
    ttlSeconds: 60,
  });
  return signer.sign(userId, room, "Tester").then((s) => s.token);
}

/** Spy standing in for LiveKit's RoomServiceClient — no network calls.
 *  listParticipants resolves every listed identity to one published
 *  microphone track (source 2 = TrackSource.MICROPHONE), mirroring the
 *  real server; RoomMutator must pass that track's SID (not the string
 *  "microphone") to mutePublishedTrack. */
function makeMuteSpy(identities: string[] = ["user-1", "u"]) {
  const calls: Array<{
    room: string;
    identity: string;
    trackSid: string;
    muted: boolean;
  }> = [];
  const client = {
    listParticipants: async (_room: string): Promise<ParticipantInfo[]> =>
      identities.map(
        (identity) =>
          ({
            identity,
            tracks: [{ sid: `TR_mic_${identity}`, source: 2 }],
          }) as unknown as ParticipantInfo,
      ),
    mutePublishedTrack: async (
      room: string,
      identity: string,
      trackSid: string,
      muted: boolean,
    ) => {
      calls.push({ room, identity, trackSid, muted });
      return { sid: "track-spy" };
    },
  };
  return { calls, client };
}

describe("db: room_state zone columns", () => {
  it("openDb creates zone / zone_kind columns", () => {
    const db = openDb(":memory:");
    const cols = db
      .prepare<[], { name: string }>("PRAGMA table_info(room_state)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("zone");
    expect(cols).toContain("zone_kind");
    db.close();
  });

  it("ensureRoomStateZoneColumns backfills an old-schema table", () => {
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE room_state (
      room TEXT NOT NULL, user_id TEXT NOT NULL, table_id TEXT,
      x REAL NOT NULL, y REAL NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (room, user_id))`);
    ensureRoomStateZoneColumns(raw);
    const cols = raw
      .prepare<[], { name: string }>("PRAGMA table_info(room_state)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("zone");
    expect(cols).toContain("zone_kind");
    // Idempotent: second run must not throw.
    ensureRoomStateZoneColumns(raw);
    raw.close();
  });

  it("upsertRoomState persists zone fields and getRoomSnapshot returns them", () => {
    const db = openDb(":memory:");
    const u = upsertUser(db, "dev-zone-1", "Zoe", "#FFFFFF", 1000);
    upsertRoomState(db, "r1", u.id, null, 1, 2, 2000, "study-hall", "silent");
    const stored = getRoomState(db, "r1", u.id);
    expect(stored?.zone).toBe("study-hall");
    expect(stored?.zone_kind).toBe("silent");

    // Update clears zone back to null.
    upsertRoomState(db, "r1", u.id, null, 3, 4, 3000, null, "none");
    const stored2 = getRoomState(db, "r1", u.id);
    expect(stored2?.zone).toBeNull();
    expect(stored2?.zone_kind).toBe("none");

    const snap = getRoomSnapshot(db, "r1", 60_000, 60_000);
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ zone: null, zone_kind: "none" });
    db.close();
  });

  it("snapshot peers without any zone report carry zone_kind null", () => {
    const db = openDb(":memory:");
    const u = upsertUser(db, "dev-zone-2", "Yan", "#000000", 1000);
    upsertRoomState(db, "r2", u.id, null, 0, 0, 2000);
    const snap = getRoomSnapshot(db, "r2", 60_000, 60_000);
    expect(snap[0]).toMatchObject({ zone: null, zone_kind: null });
    db.close();
  });
});

describe("RoomMutator", () => {
  it("mutes/unmutes the resolved microphone track SID via mutePublishedTrack", async () => {
    const { calls, client } = makeMuteSpy();
    const muter = new RoomMutator(client);
    await muter.muteMicrophone("room-a", "user-1");
    await muter.unmuteMicrophone("room-a", "user-1");
    expect(calls).toEqual([
      { room: "room-a", identity: "user-1", trackSid: "TR_mic_user-1", muted: true },
      { room: "room-a", identity: "user-1", trackSid: "TR_mic_user-1", muted: false },
    ]);
  });

  it("makes no mute call when the participant has no published mic track", async () => {
    const { calls, client } = makeMuteSpy(["quiet-user"]);
    // Strip the mic track: quiet-user joined under "quiet by default".
    client.listParticipants = async () => [] as unknown as ParticipantInfo[];
    const muter = new RoomMutator(client);
    expect(await muter.muteMicrophone("room-a", "quiet-user")).toBe(false);
    expect(await muter.unmuteMicrophone("room-a", "quiet-user")).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("ZoneMutePolicy", () => {
  it("is a no-op without a muter", async () => {
    const policy = new ZoneMutePolicy(null);
    expect(
      await policy.onZoneReport({
        room: "r",
        identity: "u",
        prevZoneKind: "discussion",
        zoneKind: "silent",
      }),
    ).toBe("none");
  });

  it("mutes once on entering silent, not on repeated reports", async () => {
    const { calls, client } = makeMuteSpy();
    const policy = new ZoneMutePolicy(new RoomMutator(client));
    const args = (prev: "discussion" | "silent", next: "silent") => ({
      room: "r",
      identity: "u",
      prevZoneKind: prev as "discussion" | "silent",
      zoneKind: next,
    });
    expect(await policy.onZoneReport(args("discussion", "silent"))).toBe("muted");
    expect(await policy.onZoneReport(args("silent", "silent"))).toBe("none");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ trackSid: "TR_mic_u", muted: true });
  });

  it("unmutes on leaving silent only when intendedMicOn is true", async () => {
    const { calls, client } = makeMuteSpy();
    const policy = new ZoneMutePolicy(new RoomMutator(client));
    // Enter silent first.
    await policy.onZoneReport({
      room: "r",
      identity: "u",
      prevZoneKind: "discussion",
      zoneKind: "silent",
    });
    expect(calls).toHaveLength(1);
    // Leave without intent: no unmute.
    expect(
      await policy.onZoneReport({
        room: "r",
        identity: "u",
        prevZoneKind: "silent",
        zoneKind: "discussion",
      }),
    ).toBe("none");
    expect(calls).toHaveLength(1);
    // Re-enter, then leave with intent: unmute.
    await policy.onZoneReport({
      room: "r",
      identity: "u",
      prevZoneKind: "discussion",
      zoneKind: "silent",
    });
    policy.setIntendedMicOn("r", "u", true);
    expect(
      await policy.onZoneReport({
        room: "r",
        identity: "u",
        prevZoneKind: "silent",
        zoneKind: "rest",
      }),
    ).toBe("unmuted");
    expect(calls.at(-1)).toMatchObject({
      trackSid: "TR_mic_u",
      muted: false,
    });
  });

  it("does nothing for non-silent transitions", async () => {
    const { calls, client } = makeMuteSpy();
    const policy = new ZoneMutePolicy(new RoomMutator(client));
    expect(
      await policy.onZoneReport({
        room: "r",
        identity: "u",
        prevZoneKind: "discussion",
        zoneKind: "rest",
      }),
    ).toBe("none");
    expect(calls).toHaveLength(0);
  });
});

describe("POST /v1/rooms/:room/state zone fields", () => {
  let app: FastifyInstance;
  let db: Db;
  let calls: Array<{
    room: string;
    identity: string;
    trackSid: string;
    muted: boolean;
  }>;
  let policy: ZoneMutePolicy;
  let userId: string;
  let token: string;
  const room = "zone-room-1";

  beforeEach(async () => {
    db = openDb(":memory:");
    const u0 = upsertUser(db, "dev-state-zone-1", "Zed", "#112233");
    userId = u0.id;
    const spy = makeMuteSpy([userId]);
    calls = spy.calls;
    policy = new ZoneMutePolicy(new RoomMutator(spy.client));
    app = Fastify({ logger: false });
    registerStateRoutes(app, { db, apiSecret: API_SECRET, zonePolicy: policy });
    await app.ready();

    token = await makeToken(userId, room);
  });

  const postState = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/v1/rooms/${room}/state`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  it("rejects an invalid zone_kind", async () => {
    const r = await postState({ userId, x: 0, y: 0, zone: "z1", zone_kind: "loud" });
    expect(r.statusCode).toBe(400);
  });

  it("accepts zone fields and surfaces them in snapshot", async () => {
    const r = await postState({
      userId,
      x: 10,
      y: 20,
      zone: "study-hall",
      zone_kind: "silent",
    });
    expect(r.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      room,
      identity: userId,
      trackSid: `TR_mic_${userId}`,
      muted: true,
    });

    // Late joiners see zone info via snapshot peers.
    const snap = getRoomSnapshot(db, room, 60_000);
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      zone: "study-hall",
      zone_kind: "silent",
    });
  });

  it("defaults missing zone fields to null / none", async () => {
    const r = await postState({ userId, x: 0, y: 0 });
    expect(r.statusCode).toBe(200);
    const stored = getRoomState(db, room, userId);
    expect(stored?.zone).toBeNull();
    expect(stored?.zone_kind).toBe("none");
    expect(calls).toHaveLength(0);
  });

  it("mutes on silent entry and unmutes on leave only with mic intent", async () => {
    await postState({ userId, x: 0, y: 0, zone_kind: "discussion" });
    expect(calls).toHaveLength(0);

    await postState({ userId, x: 0, y: 0, zone: "quiet", zone_kind: "silent" });
    expect(calls).toHaveLength(1);
    expect(calls[0].muted).toBe(true);

    // Repeated silent reports must not re-mute.
    await postState({ userId, x: 1, y: 1, zone: "quiet", zone_kind: "silent" });
    expect(calls).toHaveLength(1);

    // Leaving silent without remembered intent: stay muted.
    await postState({ userId, x: 2, y: 2, zone: "lobby", zone_kind: "rest" });
    expect(calls).toHaveLength(1);

    // Re-enter, record intent, then leave: unmute fires.
    await postState({ userId, x: 3, y: 3, zone: "quiet", zone_kind: "silent" });
    policy.setIntendedMicOn(room, userId, true);
    await postState({ userId, x: 4, y: 4, zone: null, zone_kind: "discussion" });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({
      room,
      identity: userId,
      trackSid: `TR_mic_${userId}`,
      muted: false,
    });
  });

  it("a failed mute RPC does not fail the state report", async () => {
    const failing = new ZoneMutePolicy(
      new RoomMutator({
        listParticipants: async () =>
          [
            {
              identity: userId,
              tracks: [{ sid: "TR_mic_x", source: 2 }],
            },
          ] as unknown as ParticipantInfo[],
        mutePublishedTrack: async () => {
          throw new Error("livekit down");
        },
      }),
    );
    const app2 = Fastify({ logger: false });
    registerStateRoutes(app2, { db, apiSecret: API_SECRET, zonePolicy: failing });
    await app2.ready();
    const r = await app2.inject({
      method: "POST",
      url: `/v1/rooms/${room}/state`,
      headers: { authorization: `Bearer ${token}` },
      payload: { userId, x: 0, y: 0, zone_kind: "silent" },
    });
    expect(r.statusCode).toBe(200);
    await app2.close();
  });
});
