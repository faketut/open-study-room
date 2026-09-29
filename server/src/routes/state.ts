import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { getRoomState, upsertRoomState } from "../db.js";
import { extractBearer, verifyJoinToken } from "../auth.js";
import { DEFAULT_ZONE_KIND, ZoneMutePolicy } from "../zones.js";
import type { ZoneKind } from "../zones.js";

const Body = z.object({
  userId: z.string().min(8).max(64),
  tableId: z.string().min(1).max(64).nullable().optional(),
  x: z.number().finite(),
  y: z.number().finite(),
  // M1 quiet semantics (docs/contracts.md "Zones"): zone id, null when in no
  // zone; zone_kind is client-computed and trusted for mute decisions.
  zone: z.string().min(1).max(64).nullable().optional(),
  zone_kind: z.enum(["silent", "discussion", "rest", "none"]).optional(),
});

export interface StateDeps {
  db: Db;
  apiSecret: string;
  /** Silent-zone mute policy. Defaults to a no-op policy (no LiveKit client). */
  zonePolicy?: ZoneMutePolicy;
}

export function registerStateRoutes(app: FastifyInstance, deps: StateDeps): void {
  const zonePolicy = deps.zonePolicy ?? new ZoneMutePolicy(null);

  app.post<{ Params: { room: string } }>(
    "/v1/rooms/:room/state",
    async (req, reply) => {
      const { room } = req.params;
      const token = extractBearer(req.headers.authorization);
      if (!token) return reply.code(401).send({ error: "missing_bearer" });

      let payload;
      try {
        payload = await verifyJoinToken(token, deps.apiSecret);
      } catch {
        return reply.code(401).send({ error: "invalid_token" });
      }
      if (payload.video.room && payload.video.room !== room) {
        return reply.code(403).send({ error: "room_mismatch" });
      }

      const parsed = Body.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", details: parsed.error.issues });
      }
      const { userId, tableId, x, y } = parsed.data;
      if (userId !== payload.sub) {
        return reply.code(403).send({ error: "identity_mismatch" });
      }

      const zoneKind: ZoneKind = parsed.data.zone_kind ?? DEFAULT_ZONE_KIND;
      const zone: string | null = parsed.data.zone ?? null;

      // Read the previous zone_kind BEFORE upserting so the edge detector
      // compares against the participant's last reported kind.
      const prev = getRoomState(deps.db, room, userId);
      const prevZoneKind = (prev?.zone_kind ?? null) as ZoneKind | null;

      upsertRoomState(
        deps.db,
        room,
        userId,
        tableId ?? null,
        x,
        y,
        Date.now(),
        zone,
        zoneKind,
      );

      // Silent-zone edge detection. A failed LiveKit mute RPC must never fail
      // the state report itself.
      try {
        await zonePolicy.onZoneReport({
          room,
          identity: userId,
          prevZoneKind,
          zoneKind,
        });
      } catch (err) {
        req.log.warn({ err, room, userId }, "zone mute edge failed");
      }

      return reply.send({ ok: true });
    },
  );
}
