import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type { Db, FocusSessionRow } from "../db.js";
import {
  startFocusSession,
  endFocusSession,
  getActiveFocusSession,
  getFocusStats,
  FocusSessionNotFoundError,
  FocusSessionForbiddenError,
} from "../db.js";
import { extractBearer, verifyJoinToken } from "../auth.js";

export interface FocusRateLimits {
  /** POST /v1/rooms/:room/focus/sessions — contract §4: 30/min per caller
   *  (follows the moderation `moderate` default). */
  start?: number;
  /** POST /v1/rooms/:room/focus/sessions/:id/end — 30/min. */
  end?: number;
  /** GET /v1/rooms/:room/focus/active — 30/min. */
  active?: number;
  /** GET /v1/users/:userId/focus/stats — 30/min. */
  stats?: number;
}

export interface FocusDeps {
  db: Db;
  apiSecret: string;
  rateLimits?: FocusRateLimits;
}

type RoomParams = { Params: { room: string } };
type RoomSessionParams = { Params: { room: string; id: string } };
type UserParams = { Params: { userId: string } };

/** Common auth chain for the room-scoped focus endpoints (mirrors
 *  routes/moderation.ts `authenticate`): bearer → verifyJoinToken →
 *  room match. Returns the caller's user id (payload.sub). */
async function authenticateRoom(
  req: FastifyRequest<RoomParams> | FastifyRequest<RoomSessionParams>,
  reply: FastifyReply,
  deps: FocusDeps,
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

/** Auth for the stats endpoint (contract §4): `:userId` MUST equal the caller
 *  (payload.sub), else 403 { error: "forbidden" } — stats are private in M3. */
async function authenticateStats(
  req: FastifyRequest<UserParams>,
  reply: FastifyReply,
  deps: FocusDeps,
): Promise<string | null> {
  const { userId } = req.params;
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
  if (payload.sub !== userId) {
    await reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return payload.sub;
}

function invalidBody(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "invalid_body", details: issues });
}

function sessionJson(row: FocusSessionRow) {
  return {
    id: row.id,
    kind: row.kind,
    plannedMinutes: row.planned_minutes,
    startedAt: row.started_at,
    endsAt: row.ends_at,
  };
}

export async function registerFocusRoutes(
  app: FastifyInstance,
  deps: FocusDeps,
): Promise<void> {
  const limits = {
    start: deps.rateLimits?.start ?? 30,
    end: deps.rateLimits?.end ?? 30,
    active: deps.rateLimits?.active ?? 30,
    stats: deps.rateLimits?.stats ?? 30,
  };
  const window = 60_000;

  // ---- POST /v1/rooms/:room/focus/sessions — start ----
  await app.register(async (scope) => {
    await scope.register(rateLimit, { max: limits.start, timeWindow: window });

    const Body = z.object({
      kind: z.enum(["focus", "break"]),
      plannedMinutes: z.number().int().min(1).max(180),
    });

    scope.post<RoomParams>(
      "/v1/rooms/:room/focus/sessions",
      async (req, reply) => {
        const { room } = req.params;
        const userId = await authenticateRoom(req, reply, deps);
        if (!userId) return;

        const parsed = Body.safeParse(req.body);
        if (!parsed.success) return invalidBody(reply, parsed.error.issues);

        const now = Date.now();
        const row = startFocusSession(deps.db, {
          userId,
          room,
          kind: parsed.data.kind,
          plannedMinutes: parsed.data.plannedMinutes,
          now,
        });
        return reply.code(201).send(sessionJson(row));
      },
    );
  });

  // ---- POST /v1/rooms/:room/focus/sessions/:id/end — end ----
  await app.register(async (scope) => {
    await scope.register(rateLimit, { max: limits.end, timeWindow: window });

    // The body is empty by contract; the server decides `completed` from its
    // own clock. Extra keys are accepted but ignored (a client-supplied
    // `completed` hint is never trusted).
    const Body = z.object({}).passthrough();

    scope.post<RoomSessionParams>(
      "/v1/rooms/:room/focus/sessions/:id/end",
      async (req, reply) => {
        const userId = await authenticateRoom(req, reply, deps);
        if (!userId) return;

        const parsed = Body.safeParse(req.body ?? {});
        if (!parsed.success) return invalidBody(reply, parsed.error.issues);

        try {
          const row = endFocusSession(
            deps.db,
            req.params.id,
            userId,
            Date.now(),
          );
          return reply.send({
            id: row.id,
            completed: row.completed,
            durationSec: Math.floor(
              ((row.ended_at ?? row.started_at) - row.started_at) / 1000,
            ),
          });
        } catch (err) {
          if (err instanceof FocusSessionNotFoundError) {
            return reply.code(404).send({ error: "session_not_found" });
          }
          if (err instanceof FocusSessionForbiddenError) {
            return reply.code(403).send({ error: "forbidden" });
          }
          throw err;
        }
      },
    );
  });

  // ---- GET /v1/rooms/:room/focus/active — resume on (re)join ----
  await app.register(async (scope) => {
    await scope.register(rateLimit, { max: limits.active, timeWindow: window });

    scope.get<RoomParams>(
      "/v1/rooms/:room/focus/active",
      async (req, reply) => {
        const userId = await authenticateRoom(req, reply, deps);
        if (!userId) return;

        const row = getActiveFocusSession(deps.db, userId, Date.now());
        return reply.send({ session: row ? sessionJson(row) : null });
      },
    );
  });

  // ---- GET /v1/users/:userId/focus/stats — stats/streak ----
  await app.register(async (scope) => {
    await scope.register(rateLimit, { max: limits.stats, timeWindow: window });

    const Query = z.object({
      tzOffsetMin: z.coerce.number().int().min(-720).max(840).default(0),
    });

    scope.get<UserParams>(
      "/v1/users/:userId/focus/stats",
      async (req, reply) => {
        const userId = await authenticateStats(req, reply, deps);
        if (!userId) return;

        const parsed = Query.safeParse(req.query);
        if (!parsed.success) return invalidBody(reply, parsed.error.issues);

        return reply.send(
          getFocusStats(deps.db, userId, parsed.data.tzOffsetMin, Date.now()),
        );
      },
    );
  });
}
