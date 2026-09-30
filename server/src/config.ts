import { z } from "zod";

const Schema = z.object({
  LIVEKIT_URL: z.string().min(1),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8787),
  DB_PATH: z.string().min(1).default("./data/syncle.db"),
  TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  LOG_LEVEL: z.string().default("info"),
  // Per-IP rate limit for POST /v1/sessions. Override in production.
  SESSION_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  SESSION_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // ---- P1-B lightweight login (docs/contracts.md "Identity & login") ----
  // GitHub OAuth. Both set => GitHub login on; either missing => off.
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  // Public server origin, e.g. https://study.example.com. Required when any
  // login provider is on (builds redirect_uri + magic-link URLs).
  BASE_URL: z.string().min(1).optional(),
  // Where auth callbacks 302 the browser (token in the #token= fragment).
  WEB_BASE_URL: z.string().min(1).default("http://localhost:8080"),
  // SMTP for email magic links. SMTP_HOST + SMTP_FROM set => email login on;
  // otherwise 501 email_not_configured (web hides the entry).
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().min(1).optional(),
  // Site-level admin allowlist (comma-separated; github logins
  // case-insensitive, emails lowercased before compare). Evaluated
  // server-side at auth time; only applies to authenticated accounts.
  ADMIN_GITHUB_USERS: z.string().default(""),
  ADMIN_EMAILS: z.string().default(""),
  // Login-session lifetime (the bearer in #token=), distinct from the
  // LiveKit JWT TTL.
  LOGIN_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Per-IP rate limit for /v1/auth/*, separate from the sessions limiter.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // ---- P1-C whiteboard (docs/contracts.md "Whiteboard") ----
  // Snapshot byte cap enforced on PUT (frozen contract constant).
  WHITEBOARD_MAX_SNAPSHOT_BYTES: z.coerce.number().int().positive().default(262144),
  // PUT rate limit: per user per board (frozen contract defaults 30/hour).
  WHITEBOARD_PUT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  WHITEBOARD_PUT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Schema.parse(env);
}
