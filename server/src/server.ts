import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig } from "./config.js";
import { openDb, isMuted } from "./db.js";
import { TokenSigner, createRoomMutator, createRoomAdmin } from "./livekit.js";
import { ZoneMutePolicy } from "./zones.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSnapshotRoutes, FRESH_WINDOW_MS } from "./routes/snapshot.js";
import { registerStateRoutes } from "./routes/state.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerModerationRoutes } from "./routes/moderation.js";

export async function buildApp(overrideEnv?: NodeJS.ProcessEnv) {
  const cfg = loadConfig(overrideEnv ?? process.env);
  const db = openDb(cfg.DB_PATH);
  const signer = new TokenSigner({
    apiKey: cfg.LIVEKIT_API_KEY,
    apiSecret: cfg.LIVEKIT_API_SECRET,
    ttlSeconds: cfg.TOKEN_TTL_SECONDS,
  });

  const app = Fastify({
    logger: cfg.LOG_LEVEL === "silent" ? false : { level: cfg.LOG_LEVEL },
  });
  await app.register(cors, { origin: true });

  app.get("/healthz", async () => ({ ok: true, ts: Date.now() }));
  await registerSessionRoutes(app, {
    db,
    signer,
    livekitUrl: cfg.LIVEKIT_URL,
    rateLimit: {
      max: cfg.SESSION_RATE_LIMIT_MAX,
      timeWindowMs: cfg.SESSION_RATE_LIMIT_WINDOW_MS,
    },
  });
  registerSnapshotRoutes(app, db);
  // M1 server-side media isolation: entering a silent zone force-mutes the
  // participant's mic track via the LiveKit RoomServiceClient.
  // M2 §3a: the zone policy composes with the persisted moderation-mute
  // layer — leaving a silent zone never lifts a moderation mute, and a
  // moderation mute is re-applied whenever the server sees the user's state.
  const roomMutator = createRoomMutator(
    cfg.LIVEKIT_URL,
    cfg.LIVEKIT_API_KEY,
    cfg.LIVEKIT_API_SECRET,
  );
  const zonePolicy = new ZoneMutePolicy(roomMutator, {
    isModerationMuted: (room, identity) => isMuted(db, room, identity),
  });
  registerStateRoutes(app, { db, apiSecret: cfg.LIVEKIT_API_SECRET, zonePolicy });
  registerChannelRoutes(app, { db, apiSecret: cfg.LIVEKIT_API_SECRET });
  // M2 stranger safety: reports, host/admin roles, mute/unmute/kick.
  await registerModerationRoutes(app, {
    db,
    apiSecret: cfg.LIVEKIT_API_SECRET,
    zonePolicy,
    muter: roomMutator,
    admin: createRoomAdmin(
      cfg.LIVEKIT_URL,
      cfg.LIVEKIT_API_KEY,
      cfg.LIVEKIT_API_SECRET,
    ),
    freshWindowMs: FRESH_WINDOW_MS,
  });

  app.addHook("onClose", async () => {
    db.close();
  });

  return { app, cfg };
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  buildApp()
    .then(async ({ app, cfg }) => {
      await app.listen({ host: "0.0.0.0", port: cfg.PORT });
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
