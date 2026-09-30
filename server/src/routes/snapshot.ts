import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { getRoomSnapshot } from "../db.js";

/** Freshness window shared by the snapshot and by host-transfer member
 *  checks (contract §6: the transfer target must be a current room member). */
export const FRESH_WINDOW_MS = 60_000;

export function registerSnapshotRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { room: string } }>(
    "/v1/rooms/:room/snapshot",
    async (req, reply) => {
      const { room } = req.params;
      if (!room || room.length > 64) {
        return reply.code(400).send({ error: "invalid_room" });
      }
      const peers = getRoomSnapshot(db, room, FRESH_WINDOW_MS);
      return reply.send({ room, peers });
    },
  );
}
