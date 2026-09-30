import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type { Db, RoomRole, ReportReason } from "../db.js";
import {
  REPORT_REASONS,
  getRoomRole,
  userExists,
  createReport,
  listReports,
  closeReport,
  ReportNotFoundError,
  ReportAlreadyHandledError,
  addMute,
  removeMute,
  addKick,
  getRoomState,
  transferHost,
} from "../db.js";
import { extractBearer, verifyJoinToken } from "../auth.js";
import type { RoomMutator, RoomAdminClient } from "../livekit.js";
import type { ZoneMutePolicy, ZoneKind } from "../zones.js";

export interface ModerationRateLimits {
  /** POST /v1/rooms/:room/reports — contract §4 default 10/min. */
  reports?: number;
  /** GET /v1/rooms/:room/reports — contract §4 default 60/min. */
  listReports?: number;
  /** POST /v1/rooms/:room/reports/:id/action — contract §4 lists no
   *  default; uses the moderate write-action default (30/min). */
  reportAction?: number;
  /** POST /v1/rooms/:room/moderate — contract §4 default 30/min. */
  moderate?: number;
  /** POST /v1/rooms/:room/host — contract §4 default 10/min. */
  host?: number;
}

export interface ModerationDeps {
  db: Db;
  apiSecret: string;
  /** Zone mute policy (carries the RoomMutator + M2 §3a composition). */
  zonePolicy: ZoneMutePolicy;
  /** LiveKit helpers. Null skips the remote calls (DB writes still apply);
   *  tests inject spies here. */
  muter: Pick<RoomMutator, "muteMicrophone" | "unmuteMicrophone"> | null;
  admin: RoomAdminClient | null;
  /** Freshness window for "current room member" (host transfer reuses the
   *  snapshot window). */
  freshWindowMs: number;
  rateLimits?: ModerationRateLimits;
}

interface Caller {
  userId: string;
  role: RoomRole;
}

type RoomParams = { Params: { room: string } };
type RoomReportParams = { Params: { room: string; id: string } };

/** Common auth chain for every moderation endpoint (contract §6):
 *  bearer → verifyJoinToken → room match → DB role. The role ALWAYS comes
 *  from `room_roles`; a client-supplied role is never trusted. */
async function authenticate(
  req: FastifyRequest<RoomParams> | FastifyRequest<RoomReportParams>,
  reply: FastifyReply,
  deps: ModerationDeps,
): Promise<Caller | null> {
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
  return { userId: payload.sub, role: getRoomRole(deps.db, room, payload.sub) };
}

/** Host/admin gate. `admin` is a placeholder in M2 (cannot be granted). */
async function requireHost(
  reply: FastifyReply,
  role: RoomRole,
): Promise<boolean> {
  if (role !== "host" && role !== "admin") {
    await reply.code(403).send({ error: "not_host" });
    return false;
  }
  return true;
}

function invalidBody(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "invalid_body", details: issues });
}

export async function registerModerationRoutes(
  app: FastifyInstance,
  deps: ModerationDeps,
): Promise<void> {
  const limits = {
    reports: deps.rateLimits?.reports ?? 10,
    listReports: deps.rateLimits?.listReports ?? 60,
    reportAction: deps.rateLimits?.reportAction ?? 30,
    moderate: deps.rateLimits?.moderate ?? 30,
    host: deps.rateLimits?.host ?? 10,
  };
  const window = 60_000;

  // ---- POST /v1/rooms/:room/reports — file a report (any joined member) ----
  await app.register(async (scope) => {
    await scope.register(rateLimit, { max: limits.reports, timeWindow: window });

    const Body = z.object({
      targetId: z.string().min(1).max(64),
      reason: z.string().min(1).max(32),
      detail: z.string().max(500).optional(),
    });

    scope.post<RoomParams>("/v1/rooms/:room/reports", async (req, reply) => {
      const { room } = req.params;
      const caller = await authenticate(req, reply, deps);
      if (!caller) return;

      const parsed = Body.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      const { targetId, reason, detail } = parsed.data;
      if (!(REPORT_REASONS as readonly string[]).includes(reason)) {
        return reply.code(400).send({ error: "invalid_reason" });
      }
      if (!userExists(deps.db, targetId)) {
        return reply.code(404).send({ error: "target_not_found" });
      }

      const report = createReport(deps.db, {
        room,
        reporterId: caller.userId,
        targetId,
        reason: reason as ReportReason,
        detail: detail ?? null,
      });
      return reply.code(201).send({ id: report.id, status: report.status });
    });
  });

  // ---- GET /v1/rooms/:room/reports — list reports (host/admin) ----
  await app.register(async (scope) => {
    await scope.register(rateLimit, {
      max: limits.listReports,
      timeWindow: window,
    });

    const Query = z.object({
      status: z.enum(["open", "all"]).default("open"),
    });

    scope.get<RoomParams>("/v1/rooms/:room/reports", async (req, reply) => {
      const { room } = req.params;
      const caller = await authenticate(req, reply, deps);
      if (!caller) return;
      if (!(await requireHost(reply, caller.role))) return;

      const parsed = Query.safeParse(req.query);
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);

      const reports = listReports(deps.db, room, parsed.data.status);
      return reply.send({
        reports: reports.map((r) => ({
          id: r.id,
          reporterId: r.reporter_id,
          reporterNickname: r.reporter_nickname,
          targetId: r.target_id,
          targetNickname: r.target_nickname,
          reason: r.reason,
          detail: r.detail,
          createdAt: r.created_at,
          status: r.status,
          handledBy: r.handled_by,
          handledAt: r.handled_at,
        })),
      });
    });
  });

  // ---- POST /v1/rooms/:room/reports/:id/action — close a report (host/admin) ----
  await app.register(async (scope) => {
    await scope.register(rateLimit, {
      max: limits.reportAction,
      timeWindow: window,
    });

    const Body = z.object({
      decision: z.enum(["actioned", "dismissed"]),
    });

    scope.post<RoomReportParams>(
      "/v1/rooms/:room/reports/:id/action",
      async (req, reply) => {
        const { id } = req.params;
        const caller = await authenticate(req, reply, deps);
        if (!caller) return;
        if (!(await requireHost(reply, caller.role))) return;

        const parsed = Body.safeParse(req.body);
        if (!parsed.success) return invalidBody(reply, parsed.error.issues);

        try {
          const closed = closeReport(
            deps.db,
            id,
            parsed.data.decision,
            caller.userId,
          );
          return reply.send({ id: closed.id, status: closed.status });
        } catch (err) {
          if (err instanceof ReportNotFoundError) {
            return reply.code(404).send({ error: "report_not_found" });
          }
          if (err instanceof ReportAlreadyHandledError) {
            return reply.code(409).send({ error: "already_handled" });
          }
          throw err;
        }
      },
    );
  });

  // ---- POST /v1/rooms/:room/moderate — mute / unmute / kick (host/admin) ----
  await app.register(async (scope) => {
    await scope.register(rateLimit, { max: limits.moderate, timeWindow: window });

    const Body = z.object({
      targetUserId: z.string().min(1).max(64),
      action: z.string().min(1).max(16),
      reason: z.string().max(140).optional(),
    });

    scope.post<RoomParams>("/v1/rooms/:room/moderate", async (req, reply) => {
      const { room } = req.params;
      const caller = await authenticate(req, reply, deps);
      if (!caller) return;
      if (!(await requireHost(reply, caller.role))) return;

      const parsed = Body.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      const { targetUserId, action, reason } = parsed.data;

      if (targetUserId === caller.userId) {
        return reply.code(400).send({ error: "cannot_target_self" });
      }
      if (getRoomRole(deps.db, room, targetUserId) === "host") {
        return reply.code(400).send({ error: "target_is_host" });
      }
      if (action !== "mute" && action !== "unmute" && action !== "kick") {
        // `ban` is explicitly absent in M2 (§3c).
        return reply.code(400).send({ error: "invalid_action" });
      }

      const now = Date.now();
      if (action === "mute") {
        // M2 §3a rule 4: insert into `mutes` (idempotent), then mute the
        // mic track. A failed LiveKit RPC must not fail the moderation
        // action itself.
        addMute(deps.db, room, targetUserId, caller.userId, now);
        if (deps.muter) {
          try {
            await deps.muter.muteMicrophone(room, targetUserId);
          } catch (err) {
            req.log.warn({ err, room, targetUserId }, "moderation mute RPC failed");
          }
        }
      } else if (action === "unmute") {
        // M2 §3a rule 5: delete the `mutes` row, then re-apply the zone
        // policy (a user in a silent zone stays muted under Layer Z).
        removeMute(deps.db, room, targetUserId);
        try {
          const st = getRoomState(deps.db, room, targetUserId);
          await deps.zonePolicy.reapplyAfterModerationUnmute({
            room,
            identity: targetUserId,
            zoneKind: (st?.zone_kind ?? null) as ZoneKind | null,
          });
        } catch (err) {
          req.log.warn({ err, room, targetUserId }, "moderation unmute RPC failed");
        }
      } else {
        // M2 §3b: reliable kick notice → removeParticipant → record the
        // kick row (same-day re-kick refreshes kicked_at/reason).
        const notice = JSON.stringify({
          type: "kick_notice",
          reason: reason ?? "",
        });
        if (deps.admin) {
          try {
            await deps.admin.sendData(room, targetUserId, notice);
          } catch (err) {
            // Best-effort: the kick itself must still take effect even if
            // the notice is lost (the client falls back to a generic
            // "removed from room" message).
            req.log.warn({ err, room, targetUserId }, "kick notice failed");
          }
          try {
            await deps.admin.removeParticipant(room, targetUserId);
          } catch (err) {
            req.log.warn({ err, room, targetUserId }, "removeParticipant failed");
          }
        }
        addKick(deps.db, room, targetUserId, caller.userId, reason ?? null, now);
      }

      return reply.send({ action, targetUserId });
    });
  });

  // ---- POST /v1/rooms/:room/host — transfer host (current host only) ----
  await app.register(async (scope) => {
    await scope.register(rateLimit, { max: limits.host, timeWindow: window });

    const Body = z.object({
      toUserId: z.string().min(1).max(64),
    });

    scope.post<RoomParams>("/v1/rooms/:room/host", async (req, reply) => {
      const { room } = req.params;
      const caller = await authenticate(req, reply, deps);
      if (!caller) return;
      // Current host only — the `admin` placeholder cannot transfer.
      if (caller.role !== "host") {
        return reply.code(403).send({ error: "not_host" });
      }

      const parsed = Body.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      const { toUserId } = parsed.data;
      if (toUserId === caller.userId) {
        return reply.code(400).send({ error: "invalid_body" });
      }

      // The target must be a current room member: a fresh row in
      // `room_state` (same freshness window as the snapshot).
      const member = getRoomState(deps.db, room, toUserId);
      if (!member || member.updated_at < Date.now() - deps.freshWindowMs) {
        return reply.code(404).send({ error: "member_not_found" });
      }

      transferHost(deps.db, room, caller.userId, toUserId);
      return reply.send({ host: toUserId });
    });
  });
}
