import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { TokenSigner, createRoomMutator } from "./livekit.js";
import { ZoneMutePolicy } from "./zones.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSnapshotRoutes } from "./routes/snapshot.js";
import { registerStateRoutes } from "./routes/state.js";
import { registerChannelRoutes } from "./routes/channels.js";

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
  const zonePolicy = new ZoneMutePolicy(
    createRoomMutator(cfg.LIVEKIT_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET),
  );
  registerStateRoutes(app, { db, apiSecret: cfg.LIVEKIT_API_SECRET, zonePolicy });
  registerChannelRoutes(app, { db, apiSecret: cfg.LIVEKIT_API_SECRET });

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
