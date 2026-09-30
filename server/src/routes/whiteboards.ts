import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type { AdminAllowlist, Db } from "../db.js";
import {
  getWhiteboard,
  putWhiteboard,
  clearWhiteboard,
  getRoomState,
  getEffectiveRole,
} from "../db.js";
import { extractBearer, verifyJoinToken } from "../auth.js";
import type { RoomBroadcastClient } from "../livekit.js";

// docs/contracts.md "Whiteboard (P1-C: discussion-zone shared board)" §6.
// REST endpoints for the per-discussion-zone shared board. Auth for all
// three: the LiveKit join token as bearer (same as M1 state reports) +
// `userId == payload.sub`. The P1-B login-session token is NOT accepted.

/** Frozen contract constants (§5): the snapshot byte cap. Overridable via
 *  deps for tests; server.ts wires the config value. */
export const WHITEBOARD_MAX_SNAPSHOT_BYTES = 262144;
/** Frozen contract defaults (§6): PUT rate limit, per user per board. */
export const WHITEBOARD_PUT_RATE_LIMIT = { max: 30, windowMs: 3_600_000 };
/** Clock-skew tolerance for the future-timestamp guard (§6 check 5). */
export const WHITEBOARD_FUTURE_SKEW_MS = 60_000;

/** Board id shared with the data-channel wire format (§2a, §4):
 *  `wb:<room>:<zoneId>` (contract §1). */
export function whiteboardId(room: string, zoneId: string): string {
  return `wb:${room}:${zoneId}`;
}

export interface WhiteboardDeps {
  db: Db;
  apiSecret: string;
  /** Site-level admin allowlist (P1-B contract §2); needed only to prove a
   *  site admin is NOT a host for the clear gate. */
  allowlist: AdminAllowlist;
  /** Room-wide `wb_clear` fan-out (§4). Null skips the LiveKit call (the
   *  DB clear still applies); tests inject a spy. */
  clearFanout: RoomBroadcastClient | null;
  /** Snapshot byte cap. Defaults to the frozen contract constant. */
  maxSnapshotBytes?: number;
  /** PUT rate limit (per user per board). Defaults to 30/hour. */
  putRateLimit?: { max: number; windowMs: number };
}

type RoomBoardParams = { Params: { room: string; zoneId: string } };

/** Bearer join-token auth (contract §6): 401 missing_bearer /
 *  401 invalid_token / 403 room_mismatch. Returns the caller userId. */
async function authenticate(
  req: FastifyRequest<RoomBoardParams>,
  reply: FastifyReply,
  deps: WhiteboardDeps,
): Promise<string | null> {
  const { room } = req.params;
  const token = extractBearer(req.headers.authorization);
  if (!token) {
    await reply.code(401).send({ error: "missing_bearer" });
    return null;
  }
  let payload;
  try {
    payload = await verifyJoinToken(token, deps.apiSecret);
  } catch {
    await reply.code(401).send({ error: "invalid_token" });
    return null;
  }
  if (payload.video.room && payload.video.room !== room) {
    await reply.code(403).send({ error: "room_mismatch" });
    return null;
  }
  return payload.sub;
}

function invalidBody(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "invalid_body", details: issues });
}

const UserIdBody = z.object({ userId: z.string().min(8).max(64) });
const PutBody = UserIdBody.extend({
  scene_json: z.string().min(1),
  updated_at: z.number().int(),
});

export async function registerWhiteboardRoutes(
  app: FastifyInstance,
  deps: WhiteboardDeps,
): Promise<void> {
  const maxSnapshotBytes = deps.maxSnapshotBytes ?? WHITEBOARD_MAX_SNAPSHOT_BYTES;
  const putLimit = deps.putRateLimit ?? WHITEBOARD_PUT_RATE_LIMIT;

  // ---- GET /v1/rooms/:room/whiteboards/:zoneId — pull snapshot ----
  // Any joined room member may read (shared room content); no zone check
  // on read. 404 no_whiteboard when nothing has been drawn yet.
  app.get<RoomBoardParams>(
    "/v1/rooms/:room/whiteboards/:zoneId",
    async (req, reply) => {
      const caller = await authenticate(req, reply, deps);
      if (!caller) return;
      const { room, zoneId } = req.params;
      const row = getWhiteboard(deps.db, room, zoneId);
      if (!row) return reply.code(404).send({ error: "no_whiteboard" });
      return reply.send({
        scene_json: row.scene_json,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      });
    },
  );

  // ---- PUT — store snapshot (rate-limited, per user per board) ----
  await app.register(async (scope) => {
    // Contract §6: exceeding the PUT quota answers 429 {error:"rate_limited"}.
    // The limiter throws whatever errorResponseBuilder returns; Fastify
    // turns a thrown plain object into a 500, so the builder returns a
    // marked Error (statusCode 429) and the scoped error handler below
    // renders the exact contract shape.
    scope.setErrorHandler((error, _req, reply) => {
      if (error && (error as { rateLimited?: boolean }).rateLimited === true) {
        return reply.code(429).send({ error: "rate_limited" });
      }
      return reply.send(error);
    });
    await scope.register(rateLimit, {
      max: putLimit.max,
      timeWindow: putLimit.windowMs,
      keyGenerator: async (req: FastifyRequest) => {
        // Per-user-per-board key from the verified join token. Unverifiable
        // tokens fall back to the IP — auth rejects them anyway.
        const token = extractBearer(req.headers.authorization);
        if (!token) return `wb:${req.ip}`;
        try {
          const payload = await verifyJoinToken(token, deps.apiSecret);
          const p = req.params as { room: string; zoneId: string };
          return `wb:${payload.sub}:${p.room}:${p.zoneId}`;
        } catch {
          return `wb:${req.ip}`;
        }
      },
      errorResponseBuilder: () => {
        const err = new Error("rate_limited") as Error & {
          statusCode: number;
          rateLimited: boolean;
        };
        // The runtime context carries statusCode 429, but the typings omit
        // it — hardcode: this scope never uses `ban` (which would be 403).
        err.statusCode = 429;
        err.rateLimited = true;
        return err;
      },
    });

    scope.put<RoomBoardParams>(
      "/v1/rooms/:room/whiteboards/:zoneId",
      async (req, reply) => {
        const caller = await authenticate(req, reply, deps);
        if (!caller) return;
        const { room, zoneId } = req.params;

        // Check 1: schema.
        const parsed = PutBody.safeParse(req.body);
        if (!parsed.success) return invalidBody(reply, parsed.error.issues);
        if (parsed.data.userId !== caller) {
          return reply.code(403).send({ error: "identity_mismatch" });
        }
        const { scene_json, updated_at } = parsed.data;

        // Check 2: snapshot byte cap (UTF-8).
        if (Buffer.byteLength(scene_json, "utf8") > maxSnapshotBytes) {
          return reply.code(413).send({ error: "too_large" });
        }

        // Check 3: the caller must be inside this discussion zone. The
        // server trusts the client-reported zone, exactly as the M1 mute
        // policy does (same honesty stance — abuse is covered by M2).
        const state = getRoomState(deps.db, room, caller);
        if (!state || state.zone !== zoneId || state.zone_kind !== "discussion") {
          return reply.code(403).send({ error: "not_in_zone" });
        }

        // Check 4: LWW (§2c) — stale or tied writes are no-ops; the client
        // MUST GET to converge.
        const stored = getWhiteboard(deps.db, room, zoneId);
        if (stored && updated_at <= stored.updated_at) {
          return reply.send({
            ok: true,
            applied: false,
            updated_at: stored.updated_at,
          });
        }

        // Check 5: future-dated guard — must not be persisted.
        if (updated_at > Date.now() + WHITEBOARD_FUTURE_SKEW_MS) {
          return reply.code(400).send({ error: "invalid_body" });
        }

        putWhiteboard(deps.db, room, zoneId, scene_json, updated_at, caller);
        return reply.send({ ok: true, applied: true });
      },
    );
  });

  // ---- DELETE — clear board (host only) ----
  app.delete<RoomBoardParams>(
    "/v1/rooms/:room/whiteboards/:zoneId",
    async (req, reply) => {
      const caller = await authenticate(req, reply, deps);
      if (!caller) return;
      const { room, zoneId } = req.params;

      const parsed = UserIdBody.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      if (parsed.data.userId !== caller) {
        return reply.code(403).send({ error: "identity_mismatch" });
      }

      // Clear is HOST ONLY. The site-level admin (P1-B) does not own the
      // room and gets no clear right — hence the strict `=== "host"` check
      // instead of the moderation gate's host/admin allowance (contract §4).
      if (getEffectiveRole(deps.db, room, caller, deps.allowlist) !== "host") {
        return reply.code(403).send({ error: "not_host" });
      }

      // Idempotent: clearing a non-existent board is a no-op 204.
      clearWhiteboard(deps.db, room, zoneId);

      // Best-effort `wb_clear` fan-out (§4, contract wire format verbatim).
      // A failed broadcast must not fail the 204 (same stance as the M2
      // kick notice).
      if (deps.clearFanout) {
        const payload = JSON.stringify({
          type: "wb_clear",
          board: whiteboardId(room, zoneId),
          zone_id: zoneId,
          updated_at: Date.now(),
        });
        try {
          await deps.clearFanout.broadcast(room, payload);
        } catch (err) {
          req.log.warn({ err, room, zoneId }, "whiteboard clear fan-out failed");
        }
      }

      return reply.code(204).send();
    },
  );
}
