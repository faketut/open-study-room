import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type { Db, AdminAllowlist, RoomRole } from "../db.js";
import {
  upsertUser,
  isKickedToday,
  roomHasRoleRow,
  setRoomRole,
  getRoomRole,
  getEffectiveRole,
  mergeDeviceIntoAccount,
} from "../db.js";
import { verifyLoginSession } from "../auth.js";
import { containsProfanity } from "../moderation/words.js";
import type { TokenSigner } from "../livekit.js";

const Body = z.object({
  deviceId: z.string().min(8).max(128),
  // M2 nickname validation (docs/contracts.md §4): trim().length in 1–32,
  // matching web NICKNAME_MAX_LEN. The explicit trim + sensitive-word check
  // below rejects with `nickname_rejected`.
  nickname: z.string().min(1).max(32),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#4F8EF7"),
  // #40: keep the JWT `video.room` claim sane. Lowercase + digits + dash, 3-64.
  room: z.string().regex(/^[a-z0-9-]{3,64}$/, "room must match ^[a-z0-9-]{3,64}$"),
  // P1-B lightweight login (docs/contracts.md "Identity & login" §6):
  // optional login-session bearer binding this device to an account.
  // Absent ⇒ the anonymous flow below is byte-for-byte unchanged.
  authToken: z.string().min(1).max(512).optional(),
});

export interface SessionsDeps {
  db: Db;
  signer: TokenSigner;
  livekitUrl: string;
  /** Site-level admin allowlist (P1-B contract §2); used for the
   *  `authToken` (logged-in) flow only. */
  allowlist: AdminAllowlist;
  rateLimit?: {
    max: number;
    timeWindowMs: number;
  };
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  deps: SessionsDeps,
): Promise<void> {
  // Per-IP throttle so a single client can't burn through JWTs (each call
  // also performs a SQLite upsert + JWT sign). Scoped to this plugin via
  // encapsulation so other routes (e.g. /healthz, /v1/snapshot) are unaffected.
  await app.register(async (scope) => {
    await scope.register(rateLimit, {
      max: deps.rateLimit?.max ?? 30,
      timeWindow: deps.rateLimit?.timeWindowMs ?? 60_000,
    });

    scope.post("/v1/sessions", async (req, reply) => {
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.issues });
      }
      const { deviceId, nickname, color, room, authToken } = parsed.data;

      // M2 nickname validation: trim().length in 1–32 + sensitive-word
      // check against server/src/moderation/words.ts. Violation →
      // 400 { error: "nickname_rejected" } (no matched word echoed back).
      const trimmed = nickname.trim();
      if (
        trimmed.length < 1 ||
        trimmed.length > 32 ||
        containsProfanity(nickname)
      ) {
        return reply.code(400).send({ error: "nickname_rejected" });
      }

      // P1-B §6: when a login-session bearer is presented, resolve it to the
      // account row. An invalid/expired/revoked token is a 401 here.
      let accountId: string | null = null;
      if (authToken !== undefined) {
        const session = verifyLoginSession(deps.db, authToken);
        if (!session) {
          return reply.code(401).send({ error: "invalid_session" });
        }
        accountId = session.user.id;
      }

      const user = upsertUser(deps.db, deviceId, nickname, color);

      // The effective identity: the account row after the device→account
      // merge, or the device row for the anonymous flow.
      let userId = user.id;
      let responseNickname = user.nickname;
      let responseColor = user.color;
      if (accountId !== null) {
        // P1-B §6 merge (frozen): one transaction re-points every FK row
        // from the anonymous device row to the account row, then deletes
        // the device row. Idempotent — an already-bound device is a no-op.
        mergeDeviceIntoAccount(deps.db, user.id, accountId);
        // The account adopts the per-session chosen name, exactly like
        // upsertUser does for anonymous device rows.
        deps.db
          .prepare("UPDATE users SET nickname = ?, color = ?, last_seen = ? WHERE id = ?")
          .run(nickname, color, Date.now(), accountId);
        userId = accountId;
        responseNickname = nickname;
        responseColor = color;
      }

      // M2 §3b: check kicks BEFORE issuing a token — a user kicked earlier
      // the same UTC day is refused with 403 { error: "kicked" }.
      // P1-B §6: the check runs against the MERGED id, so a kicked account
      // cannot re-enter by re-binding on a new device.
      if (isKickedToday(deps.db, room, userId)) {
        return reply.code(403).send({ error: "kicked" });
      }

      // M2 §1: the first user to join a room (first successful sessions
      // call for it) becomes the host, recorded in `room_roles`.
      if (!roomHasRoleRow(deps.db, room)) {
        setRoomRole(deps.db, room, userId, "host", null);
      }
      // P1-B §6: the response `role` enum extends to "host" | "admin" | "user"
      // for the logged-in flow (effective role: host row → allowlist admin →
      // user). The anonymous flow keeps the frozen "host" | "user" mapping.
      const role: RoomRole =
        accountId !== null
          ? getEffectiveRole(deps.db, room, userId, deps.allowlist)
          : getRoomRole(deps.db, room, userId);

      const signed = await deps.signer.sign(userId, room, responseNickname);
      return reply.send({
        userId,
        nickname: responseNickname,
        color: responseColor,
        serverUrl: deps.livekitUrl,
        token: signed.token,
        expiresAt: signed.expiresAt,
        role,
      });
    });
  });
}
