import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import {
  openDb,
  upsertUser,
  upsertAccount,
  mergeDeviceIntoAccount,
  getEffectiveRole,
  isAllowlistAdmin,
  parseAllowlist,
  sha256Hex,
  normalizeEmail,
  createLoginSession,
  revokeLoginSession,
  createOAuthState,
  consumeOAuthState,
  createMagicToken,
  consumeMagicToken,
  addKick,
  addMute,
  createReport,
  setRoomRole,
  upsertRoomState,
  startFocusSession,
} from "../src/db.js";
import type { Db, AdminAllowlist } from "../src/db.js";
import { verifyLoginSession } from "../src/auth.js";
import { TokenSigner } from "../src/livekit.js";
import { ZoneMutePolicy } from "../src/zones.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import {
  registerAuthRoutes,
  resetEmailRequestThrottle,
  emailRequestAllowed,
  githubConfigured,
  emailConfigured,
} from "../src/routes/auth.js";
import type { GitHubClient, Mailer } from "../src/routes/auth.js";
import { registerModerationRoutes } from "../src/routes/moderation.js";

const API_SECRET = "secret-secret-secret-secret";
const EMPTY_ALLOWLIST: AdminAllowlist = { githubUsers: [], emails: [] };

function baseEnv(extra: Record<string, string> = {}) {
  return {
    LIVEKIT_URL: "ws://test",
    LIVEKIT_API_KEY: "devkey",
    LIVEKIT_API_SECRET: API_SECRET,
    DB_PATH: ":memory:",
    TOKEN_TTL_SECONDS: "60",
    LOG_LEVEL: "silent",
    PORT: "8787",
    SESSION_RATE_LIMIT_MAX: "10000",
    SESSION_RATE_LIMIT_WINDOW_MS: "60000",
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

const stubGitHub: GitHubClient = {
  async exchangeCode() {
    return "stub-access-token";
  },
  async getUser() {
    return {
      id: 12345,
      login: "OctoCat",
      name: "Octo",
      avatar_url: "https://example.com/octo.png",
      email: "Octo@Example.COM",
    };
  },
};

interface MailCapture {
  to: string;
  url: string;
}

function stubMailer(captured: MailCapture[]): Mailer {
  return {
    async sendSignInLink(to, url) {
      captured.push({ to, url });
    },
  };
}

interface Fixture {
  app: FastifyInstance;
  db: Db;
  cfg: ReturnType<typeof loadConfig>;
  mail: MailCapture[];
  join: (
    deviceId: string,
    nickname: string,
    room: string,
    extra?: Record<string, unknown>,
  ) => Promise<{ status: number; body: any }>;
}

/** Full fixture: sessions + auth (+ moderation for the gate test) on one
 *  in-memory DB. */
async function buildFixture(
  envExtra: Record<string, string> = {},
  opts: {
    github?: GitHubClient;
    mailer?: Mailer | null;
    allowlist?: AdminAllowlist;
    withModeration?: boolean;
  } = {},
): Promise<Fixture> {
  const db = openDb(":memory:");
  const cfg = loadConfig(baseEnv(envExtra));
  const allowlist = opts.allowlist ?? EMPTY_ALLOWLIST;
  const mail: MailCapture[] = [];
  const signer = new TokenSigner({
    apiKey: "devkey",
    apiSecret: API_SECRET,
    ttlSeconds: 60,
  });
  const app = Fastify({ logger: false });
  // Tie the in-memory Database to the app's lifecycle. If a db handle is
  // still open when the vitest worker tears down, better-sqlite3's
  // ~Database() runs with a dead V8 env and hard-crashes the worker
  // (node::RemoveEnvironmentCleanupHook assertion). Every test below ends
  // with `await fx.app.close()`, so this one hook fixes them all.
  app.addHook("onClose", async () => {
    db.close();
  });
  await registerSessionRoutes(app, {
    db,
    signer,
    livekitUrl: "ws://test",
    allowlist,
    rateLimit: { max: 10_000, timeWindowMs: 60_000 },
  });
  await registerAuthRoutes(app, {
    db,
    cfg,
    allowlist,
    github: opts.github,
    mailer: opts.mailer === null ? undefined : (opts.mailer ?? stubMailer(mail)),
  });
  if (opts.withModeration) {
    const muter = {
      muteMicrophone: async () => true,
      unmuteMicrophone: async () => true,
    };
    const zonePolicy = new ZoneMutePolicy(muter, {
      isModerationMuted: () => false,
    });
    await registerModerationRoutes(app, {
      db,
      apiSecret: API_SECRET,
      allowlist,
      zonePolicy,
      muter,
      admin: null,
      freshWindowMs: 60_000,
      rateLimits: {
        reports: 10_000,
        listReports: 10_000,
        reportAction: 10_000,
        moderate: 10_000,
        host: 10_000,
      },
    });
  }
  await app.ready();

  const join = async (
    deviceId: string,
    nickname: string,
    room: string,
    extra: Record<string, unknown> = {},
  ) => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { deviceId, nickname, room, ...extra },
    });
    return { statusCode: r.statusCode, body: r.json() };
  };
  return { app, db, cfg, mail, join };
}

function fragmentParam(location: string, name: "token" | "error"): string | null {
  const hash = new URL(location).hash; // "#token=..." / "#error=..."
  const m = new RegExp(`^#${name}=([^&]*)$`).exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}

beforeEach(() => {
  resetEmailRequestThrottle();
});

// ---------------------------------------------------------------------------
// Identity model: upsertAccount
// ---------------------------------------------------------------------------

describe("upsertAccount", () => {
  it("is idempotent on (provider, provider_sub): same provider account → same users.id", () => {
    const db = openDb(":memory:");
    const a1 = upsertAccount(db, {
      provider: "github",
      providerSub: "12345",
      providerHandle: "octocat",
      email: "octo@example.com",
      displayName: "Octo",
      avatarUrl: "https://example.com/octo.png",
    });
    const a2 = upsertAccount(db, {
      provider: "github",
      providerSub: "12345",
      providerHandle: "octocat-renamed",
      email: "octo@example.com",
      displayName: "Octo New",
      avatarUrl: "https://example.com/octo2.png",
    });
    expect(a2.id).toBe(a1.id);
    expect(a2.provider).toBe("github");
    expect(a2.provider_sub).toBe("12345");
    expect(a2.provider_handle).toBe("octocat-renamed");
    expect(a2.display_name).toBe("Octo New");
    // Account rows carry the non-lookup device_id placeholder.
    expect(a1.device_id).toBe(`acct:${a1.id}`);
    // A different provider_sub is a different account.
    const a3 = upsertAccount(db, {
      provider: "github",
      providerSub: "99999",
      providerHandle: "other",
    });
    expect(a3.id).not.toBe(a1.id);
    // Email normalization is the caller's job; the stored key is exact.
    const e1 = upsertAccount(db, {
      provider: "email",
      providerSub: normalizeEmail("  User@Example.COM "),
      providerHandle: "user@example.com",
      email: "user@example.com",
    });
    expect(e1.provider_sub).toBe("user@example.com");
    db.close();
  });

  it("partial unique index rejects duplicate (provider, provider_sub)", () => {
    const db = openDb(":memory:");
    upsertAccount(db, { provider: "github", providerSub: "42" });
    expect(() =>
      db
        .prepare(
          "INSERT INTO users (id, device_id, nickname, color, created_at, last_seen, provider, provider_sub) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run("x", "acct:x", "n", "#000000", 1, 1, "github", "42"),
    ).toThrow();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Merge: mergeDeviceIntoAccount
// ---------------------------------------------------------------------------

describe("mergeDeviceIntoAccount", () => {
  function seed(): { db: Db; dev: string; acct: string } {
    const db = openDb(":memory:");
    const dev = upsertUser(db, "device-merge-1", "Anon", "#111111").id;
    const acct = upsertAccount(db, {
      provider: "github",
      providerSub: "777",
      providerHandle: "merger",
    }).id;
    // FK rows on the device row, spread across every merged table.
    upsertRoomState(db, "room1", dev, null, 1, 2);
    setRoomRole(db, "room1", dev, "host", null);
    const reporter = upsertUser(db, "device-reporter", "Rep", "#222222").id;
    const target = upsertUser(db, "device-target", "Tgt", "#333333").id;
    createReport(db, { room: "room1", reporterId: dev, targetId: target, reason: "spam" });
    createReport(db, { room: "room1", reporterId: reporter, targetId: dev, reason: "other" });
    addMute(db, "room1", target, dev);
    addMute(db, "room1", dev, reporter);
    addKick(db, "room1", dev, reporter, "troll", 1000);
    startFocusSession(db, { userId: dev, room: "room1", kind: "focus", plannedMinutes: 25, now: 2000 });
    return { db, dev, acct };
  }

  it("re-points every FK row to the account and deletes the device row", () => {
    const { db, dev, acct } = seed();
    mergeDeviceIntoAccount(db, dev, acct);
    const tables: Array<[string, string]> = [
      ["room_state", "user_id"],
      ["room_roles", "user_id"],
      ["reports", "reporter_id"],
      ["reports", "target_id"],
      ["mutes", "user_id"],
      ["kicks", "user_id"],
      ["focus_sessions", "user_id"],
    ];
    for (const [table, col] of tables) {
      const leftovers = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`)
        .get(dev) as { n: number };
      expect(leftovers.n, `${table}.${col}`).toBe(0);
    }
    // Actor columns follow the person too.
    const mutesBy = db
      .prepare("SELECT COUNT(*) AS n FROM mutes WHERE muted_by = ?")
      .get(acct) as { n: number };
    expect(mutesBy.n).toBe(1);
    const reportsBy = db
      .prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ?")
      .get(acct) as { n: number };
    expect(reportsBy.n).toBe(1);
    // The host row followed the account; position and streak did too.
    expect(
      db.prepare("SELECT role FROM room_roles WHERE room='room1' AND user_id=?").get(acct),
    ).toMatchObject({ role: "host" });
    expect(
      db.prepare("SELECT x, y FROM room_state WHERE room='room1' AND user_id=?").get(acct),
    ).toMatchObject({ x: 1, y: 2 });
    // The anonymous row is gone.
    expect(db.prepare("SELECT id FROM users WHERE id=?").get(dev)).toBeUndefined();
    db.close();
  });

  it("is idempotent: re-running is a no-op", () => {
    const { db, dev, acct } = seed();
    mergeDeviceIntoAccount(db, dev, acct);
    const count = (t: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = ["room_state", "room_roles", "reports", "mutes", "kicks", "focus_sessions", "users"].map(count);
    mergeDeviceIntoAccount(db, dev, acct); // device row no longer exists
    mergeDeviceIntoAccount(db, acct, acct); // self-merge
    const after = ["room_state", "room_roles", "reports", "mutes", "kicks", "focus_sessions", "users"].map(count);
    expect(after).toEqual(before);
    db.close();
  });

  it("room_state collision keeps the account row's position", () => {
    const db = openDb(":memory:");
    const dev = upsertUser(db, "device-rs", "Anon", "#111111").id;
    const acct = upsertAccount(db, { provider: "email", providerSub: "a@b.c" }).id;
    upsertRoomState(db, "room1", dev, null, 9, 9);
    upsertRoomState(db, "room1", acct, null, 1, 1);
    mergeDeviceIntoAccount(db, dev, acct);
    expect(
      db.prepare("SELECT x, y FROM room_state WHERE room='room1' AND user_id=?").get(acct),
    ).toMatchObject({ x: 1, y: 1 });
    db.close();
  });

  it("kicks collision keeps the earlier kicked_at (longer sanction wins)", () => {
    const db = openDb(":memory:");
    const by = upsertUser(db, "device-mod", "Mod", "#111111").id;
    // Case A: the account's kick is earlier → account's row survives.
    {
      const dev = upsertUser(db, "device-ka", "Anon", "#111111").id;
      const acct = upsertAccount(db, { provider: "github", providerSub: "ka" }).id;
      addKick(db, "room1", acct, by, "old", 1000);
      addKick(db, "room1", dev, by, "new", 5000);
      mergeDeviceIntoAccount(db, dev, acct);
      const row = db.prepare("SELECT kicked_at, reason FROM kicks WHERE room='room1' AND user_id=?").get(acct) as { kicked_at: number; reason: string };
      expect(row.kicked_at).toBe(1000);
      expect(row.reason).toBe("old");
    }
    // Case B: the device's kick is earlier → it moves to the account row.
    {
      const dev = upsertUser(db, "device-kb", "Anon", "#111111").id;
      const acct = upsertAccount(db, { provider: "github", providerSub: "kb" }).id;
      addKick(db, "room1", acct, by, "new", 5000);
      addKick(db, "room1", dev, by, "old", 1000);
      mergeDeviceIntoAccount(db, dev, acct);
      const row = db.prepare("SELECT kicked_at, reason FROM kicks WHERE room='room1' AND user_id=?").get(acct) as { kicked_at: number; reason: string };
      expect(row.kicked_at).toBe(1000);
      expect(row.reason).toBe("old");
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM kicks WHERE room='room1'").get() as { n: number }).n,
      ).toBe(2); // one per account row total in this room
    }
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Roles: getEffectiveRole / isAllowlistAdmin
// ---------------------------------------------------------------------------

describe("getEffectiveRole", () => {
  function seed() {
    const db = openDb(":memory:");
    const allowlist: AdminAllowlist = {
      githubUsers: parseAllowlist("OctoCat, someone-else"),
      emails: parseAllowlist("Admin@Example.com"),
    };
    const hostAcct = upsertAccount(db, {
      provider: "github",
      providerSub: "1",
      providerHandle: "octocat", // also in the allowlist
      email: "host@example.com",
    }).id;
    const adminAcct = upsertAccount(db, {
      provider: "github",
      providerSub: "2",
      providerHandle: "OCTOCAT", // case-insensitive match
    }).id;
    const emailAdmin = upsertAccount(db, {
      provider: "email",
      providerSub: "admin@example.com",
      providerHandle: "admin@example.com",
      email: "ADMIN@EXAMPLE.COM",
    }).id;
    const plainAcct = upsertAccount(db, {
      provider: "github",
      providerSub: "3",
      providerHandle: "nobody",
    }).id;
    const anon = upsertUser(db, "device-anon-1", "Anon", "#111111").id;
    setRoomRole(db, "room1", hostAcct, "host", null);
    return { db, allowlist, hostAcct, adminAcct, emailAdmin, plainAcct, anon };
  }

  it("host row beats allowlist; allowlist beats plain user", () => {
    const { db, allowlist, hostAcct, adminAcct, emailAdmin, plainAcct, anon } = seed();
    expect(getEffectiveRole(db, "room1", hostAcct, allowlist)).toBe("host");
    expect(getEffectiveRole(db, "room1", adminAcct, allowlist)).toBe("admin");
    expect(getEffectiveRole(db, "room1", emailAdmin, allowlist)).toBe("admin");
    expect(getEffectiveRole(db, "room1", plainAcct, allowlist)).toBe("user");
    // The allowlist never applies to anonymous device rows.
    expect(getEffectiveRole(db, "room1", anon, allowlist)).toBe("user");
    expect(isAllowlistAdmin(db, anon, allowlist)).toBe(false);
    db.close();
  });

  it("github handle match is scoped to provider='github'", () => {
    const db = openDb(":memory:");
    const allowlist: AdminAllowlist = { githubUsers: ["octocat"], emails: [] };
    // An email-provider row whose handle happens to equal a github login is
    // NOT a github admin (email allowlist is the path for email accounts).
    const emailAcct = upsertAccount(db, {
      provider: "email",
      providerSub: "x@y.z",
      providerHandle: "octocat",
      email: "x@y.z",
    }).id;
    expect(isAllowlistAdmin(db, emailAcct, allowlist)).toBe(false);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Login sessions: verifyLoginSession
// ---------------------------------------------------------------------------

describe("verifyLoginSession", () => {
  it("accepts a live token; rejects revoked/expired/unknown", () => {
    const db = openDb(":memory:");
    const acct = upsertAccount(db, { provider: "github", providerSub: "9" }).id;
    const { token, id } = createLoginSession(db, acct, 30);
    expect(verifyLoginSession(db, token)?.user.id).toBe(acct);
    expect(verifyLoginSession(db, "bogus")).toBeNull();
    revokeLoginSession(db, id);
    expect(verifyLoginSession(db, token)).toBeNull();
    const { token: expired } = createLoginSession(db, acct, 30, Date.now() - 31 * 86_400_000);
    expect(verifyLoginSession(db, expired)).toBeNull();
    db.close();
  });

  it("the raw token value never appears in any DB row", () => {
    const db = openDb(":memory:");
    const acct = upsertAccount(db, { provider: "email", providerSub: "t@t.t" }).id;
    const { token } = createLoginSession(db, acct, 30);
    expect(token.length).toBeGreaterThan(30);
    const rows = db.prepare("SELECT * FROM login_sessions").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(sha256Hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// OAuth state / magic token single-use + expiry
// ---------------------------------------------------------------------------

describe("consumeOAuthState", () => {
  it("single-use: second consume fails; expired fails", () => {
    const db = openDb(":memory:");
    const s = createOAuthState(db);
    expect(consumeOAuthState(db, s)).toBe(true);
    expect(consumeOAuthState(db, s)).toBe(false);
    expect(consumeOAuthState(db, "nope")).toBe(false);
    const old = createOAuthState(db, Date.now() - 11 * 60_000);
    expect(consumeOAuthState(db, old)).toBe(false);
    db.close();
  });
});

describe("consumeMagicToken", () => {
  it("single-use and TTL: reuse → invalid, expired → expired", () => {
    const db = openDb(":memory:");
    const t = createMagicToken(db, "a@b.c");
    const ok = consumeMagicToken(db, t);
    expect(ok).toEqual({ ok: true, email: "a@b.c" });
    expect(consumeMagicToken(db, t)).toEqual({ ok: false, reason: "invalid" });
    expect(consumeMagicToken(db, "nope")).toEqual({ ok: false, reason: "invalid" });
    const old = createMagicToken(db, "b@c.d", Date.now() - 16 * 60_000);
    expect(consumeMagicToken(db, old)).toEqual({ ok: false, reason: "expired" });
    db.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP: /v1/auth/config reflects exactly which env sets are present
// ---------------------------------------------------------------------------

describe("GET /v1/auth/config", () => {
  it("reports false/false when nothing is configured", async () => {
    const fx = await buildFixture();
    const r = await fx.app.inject({ method: "GET", url: "/v1/auth/config" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ github: false, email: false });
    expect(githubConfigured(fx.cfg)).toBe(false);
    expect(emailConfigured(fx.cfg)).toBe(false);
    await fx.app.close();
  });

  it("reports true when the env sets are present", async () => {
    const fx = await buildFixture({
      GITHUB_CLIENT_ID: "cid",
      GITHUB_CLIENT_SECRET: "csecret",
      BASE_URL: "https://study.example.com",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "noreply@example.com",
    });
    const r = await fx.app.inject({ method: "GET", url: "/v1/auth/config" });
    expect(r.json()).toEqual({ github: true, email: true });
    await fx.app.close();
  });

  it("github stays off when BASE_URL is missing (redirect_uri cannot be built)", async () => {
    const fx = await buildFixture({
      GITHUB_CLIENT_ID: "cid",
      GITHUB_CLIENT_SECRET: "csecret",
    });
    expect(fx.cfg ? githubConfigured(fx.cfg) : false).toBe(false);
    const r = await fx.app.inject({ method: "GET", url: "/v1/auth/config" });
    expect(r.json()).toEqual({ github: false, email: false });
    await fx.app.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP: GitHub OAuth flow (stubbed server-to-server calls)
// ---------------------------------------------------------------------------

describe("GitHub OAuth", () => {
  const env = {
    GITHUB_CLIENT_ID: "cid",
    GITHUB_CLIENT_SECRET: "csecret",
    BASE_URL: "https://study.example.com",
    WEB_BASE_URL: "https://web.example.com",
  };

  async function startFlow(fx: Fixture) {
    const r = await fx.app.inject({ method: "GET", url: "/v1/auth/github" });
    expect(r.statusCode).toBe(302);
    const loc = r.headers.location!;
    expect(loc).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    const q = new URL(loc).searchParams;
    expect(q.get("client_id")).toBe("cid");
    expect(q.get("redirect_uri")).toBe("https://study.example.com/v1/auth/github/callback");
    expect(q.get("scope")).toBe("read:user user:email");
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    return q.get("state")!;
  }

  it("503 github_not_configured when GitHub is not set up", async () => {
    const fx = await buildFixture();
    const r = await fx.app.inject({ method: "GET", url: "/v1/auth/github" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "github_not_configured" });
    await fx.app.close();
  });

  it("full flow: authorize → callback → #token=; state is single-use", async () => {
    const fx = await buildFixture(env, { github: stubGitHub });
    const state = await startFlow(fx);

    const cb = await fx.app.inject({
      method: "GET",
      url: `/v1/auth/github/callback?code=authcode123&state=${state}`,
    });
    expect(cb.statusCode).toBe(302);
    const token = fragmentParam(cb.headers.location!, "token");
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    // Account row upserted on (provider, provider_sub); email normalized.
    const row = fx.db
      .prepare("SELECT * FROM users WHERE provider='github' AND provider_sub='12345'")
      .get() as Record<string, unknown>;
    expect(row.provider_handle).toBe("OctoCat");
    expect(row.email).toBe("octo@example.com");
    expect(row.display_name).toBe("Octo");

    // The token authenticates /v1/auth/me.
    const me = await fx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      userId: row.id,
      provider: "github",
      displayName: "Octo",
      avatarUrl: "https://example.com/octo.png",
      email: "octo@example.com",
      isAdmin: false,
    });

    // Replaying the state fails → #error=invalid_state.
    const replay = await fx.app.inject({
      method: "GET",
      url: `/v1/auth/github/callback?code=authcode123&state=${state}`,
    });
    expect(replay.statusCode).toBe(302);
    expect(fragmentParam(replay.headers.location!, "error")).toBe("invalid_state");
    await fx.app.close();
  });

  it("second OAuth login with the same provider account returns the same users.id", async () => {
    const fx = await buildFixture(env, { github: stubGitHub });
    const login = async () => {
      const state = await startFlow(fx);
      const cb = await fx.app.inject({
        method: "GET",
        url: `/v1/auth/github/callback?code=c&state=${state}`,
      });
      const token = fragmentParam(cb.headers.location!, "token")!;
      const me = await fx.app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      return me.json().userId as string;
    };
    const id1 = await login();
    const id2 = await login();
    expect(id2).toBe(id1);
    await fx.app.close();
  });

  it("expired state → #error=invalid_state; missing params → invalid_state", async () => {
    const fx = await buildFixture(env, { github: stubGitHub });
    const old = createOAuthState(fx.db, Date.now() - 11 * 60_000);
    const r = await fx.app.inject({
      method: "GET",
      url: `/v1/auth/github/callback?code=c&state=${old}`,
    });
    expect(r.statusCode).toBe(302);
    expect(fragmentParam(r.headers.location!, "error")).toBe("invalid_state");
    const missing = await fx.app.inject({
      method: "GET",
      url: "/v1/auth/github/callback",
    });
    expect(fragmentParam(missing.headers.location!, "error")).toBe("invalid_state");
    await fx.app.close();
  });

  it("exchange failure → #error=oauth_failed (code only, no PII)", async () => {
    const failing: GitHubClient = {
      async exchangeCode() {
        throw new Error("bad_verification_code");
      },
      async getUser() {
        throw new Error("unreachable");
      },
    };
    const fx = await buildFixture(env, { github: failing });
    const state = await startFlow(fx);
    const r = await fx.app.inject({
      method: "GET",
      url: `/v1/auth/github/callback?code=bad&state=${state}`,
    });
    expect(r.statusCode).toBe(302);
    expect(fragmentParam(r.headers.location!, "error")).toBe("oauth_failed");
    expect(r.headers.location).not.toContain("bad_verification_code");
    await fx.app.close();
  });

  it("no verified email → #error=no_verified_email", async () => {
    const noEmail: GitHubClient = {
      ...stubGitHub,
      async getUser() {
        return { ...(await stubGitHub.getUser()), email: null };
      },
    };
    const fx = await buildFixture(env, { github: noEmail });
    const state = await startFlow(fx);
    const r = await fx.app.inject({
      method: "GET",
      url: `/v1/auth/github/callback?code=c&state=${state}`,
    });
    expect(fragmentParam(r.headers.location!, "error")).toBe("no_verified_email");
    await fx.app.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP: email magic link (stubbed SMTP)
// ---------------------------------------------------------------------------

describe("email magic link", () => {
  const env = {
    BASE_URL: "https://study.example.com",
    WEB_BASE_URL: "https://web.example.com",
    SMTP_HOST: "smtp.example.com",
    SMTP_FROM: "noreply@example.com",
  };

  async function requestLink(fx: Fixture, email: string) {
    return fx.app.inject({
      method: "POST",
      url: "/v1/auth/email/request",
      payload: { email },
    });
  }

  it("501 email_not_configured when SMTP is not set up", async () => {
    const fx = await buildFixture({}, { mailer: null });
    const r = await requestLink(fx, "someone@example.com");
    expect(r.statusCode).toBe(501);
    expect(r.json()).toEqual({ error: "email_not_configured" });
    await fx.app.close();
  });

  it("202 generic response; token is single-use; account upsert on normalized email", async () => {
    const fx = await buildFixture(env);
    const r = await requestLink(fx, "  New@Example.COM ");
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ status: "sent" });
    expect(fx.mail).toHaveLength(1);
    expect(fx.mail[0].to).toBe("new@example.com");
    expect(fx.mail[0].url).toMatch(
      /^https:\/\/study\.example\.com\/v1\/auth\/email\/callback\?token=/,
    );
    const token = new URL(fx.mail[0].url).searchParams.get("token")!;

    const cb = await fx.app.inject({
      method: "GET",
      url: `/v1/auth/email/callback?token=${token}`,
    });
    expect(cb.statusCode).toBe(302);
    const loginToken = fragmentParam(cb.headers.location!, "token");
    expect(loginToken).toBeTruthy();

    // Reuse → #error=invalid_token.
    const reuse = await fx.app.inject({
      method: "GET",
      url: `/v1/auth/email/callback?token=${token}`,
    });
    expect(fragmentParam(reuse.headers.location!, "error")).toBe("invalid_token");

    // Account row: provider email, sub = normalized address.
    const row = fx.db
      .prepare("SELECT * FROM users WHERE provider='email' AND provider_sub='new@example.com'")
      .get() as Record<string, unknown>;
    expect(row.email).toBe("new@example.com");
    expect(row.provider_handle).toBe("new@example.com");

    const me = await fx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${loginToken}` },
    });
    expect(me.json()).toMatchObject({ provider: "email", email: "new@example.com" });
    await fx.app.close();
  });

  it("unknown token → invalid_token; expired token → expired_token", async () => {
    const fx = await buildFixture(env);
    const bad = await fx.app.inject({
      method: "GET",
      url: "/v1/auth/email/callback?token=doesnotexist",
    });
    expect(fragmentParam(bad.headers.location!, "error")).toBe("invalid_token");
    const old = createMagicToken(fx.db, "old@example.com", Date.now() - 16 * 60_000);
    const exp = await fx.app.inject({
      method: "GET",
      url: `/v1/auth/email/callback?token=${old}`,
    });
    expect(fragmentParam(exp.headers.location!, "error")).toBe("expired_token");
    await fx.app.close();
  });

  it("rejects malformed email with 400", async () => {
    const fx = await buildFixture(env);
    const r = await requestLink(fx, "not-an-email");
    expect(r.statusCode).toBe(400);
    await fx.app.close();
  });

  it("per-email throttle: 10/hour per address → 429 rate_limited", async () => {
    const fx = await buildFixture(
      { ...env, AUTH_RATE_LIMIT_MAX: "1000" },
    );
    for (let i = 0; i < 10; i++) {
      const r = await requestLink(fx, "throttle@example.com");
      expect(r.statusCode, `request ${i + 1}`).toBe(202);
    }
    const over = await requestLink(fx, "throttle@example.com");
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ error: "rate_limited" });
    // A different address is unaffected by the per-email throttle.
    const other = await requestLink(fx, "other@example.com");
    expect(other.statusCode).toBe(202);
    await fx.app.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP: login session lifecycle (me / revoke)
// ---------------------------------------------------------------------------

describe("login session lifecycle", () => {
  const env = {
    BASE_URL: "https://study.example.com",
    SMTP_HOST: "smtp.example.com",
    SMTP_FROM: "noreply@example.com",
  };

  async function loginToken(fx: Fixture, email = "me@example.com") {
    await fx.app.inject({
      method: "POST",
      url: "/v1/auth/email/request",
      payload: { email },
    });
    const token = new URL(fx.mail[fx.mail.length - 1].url).searchParams.get("token")!;
    const cb = await fx.app.inject({
      method: "GET",
      url: `/v1/auth/email/callback?token=${token}`,
    });
    return fragmentParam(cb.headers.location!, "token")!;
  }

  it("me → 401 without/unknown bearer; revoke → 204 then 401", async () => {
    const fx = await buildFixture(env);
    const noAuth = await fx.app.inject({ method: "GET", url: "/v1/auth/me" });
    expect(noAuth.statusCode).toBe(401);
    const unknown = await fx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: "Bearer nope" },
    });
    expect(unknown.statusCode).toBe(401);

    const token = await loginToken(fx);
    const me = await fx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);

    const del = await fx.app.inject({
      method: "DELETE",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    const after = await fx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: "invalid_session" });

    // Revoking with a dead token is a 401, not a silent no-op.
    const del2 = await fx.app.inject({
      method: "DELETE",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del2.statusCode).toBe(401);
    await fx.app.close();
  });

  it("isAdmin reflects the env allowlist for the logged-in account", async () => {
    const allowlist: AdminAllowlist = { githubUsers: [], emails: ["me@example.com"] };
    const fx = await buildFixture(env, { allowlist });
    const token = await loginToken(fx);
    const me = await fx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json().isAdmin).toBe(true);
    await fx.app.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP: auth endpoint rate limit (per-IP)
// ---------------------------------------------------------------------------

describe("auth rate limit", () => {
  it("429 { error: rate_limited } once the per-IP cap is exceeded", async () => {
    const fx = await buildFixture({ AUTH_RATE_LIMIT_MAX: "2" });
    for (let i = 0; i < 2; i++) {
      const ok = await fx.app.inject({ method: "GET", url: "/v1/auth/config" });
      expect(ok.statusCode).toBe(200);
    }
    const over = await fx.app.inject({ method: "GET", url: "/v1/auth/config" });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ error: "rate_limited" });
    await fx.app.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP: POST /v1/sessions with authToken (device → account merge)
// ---------------------------------------------------------------------------

describe("POST /v1/sessions authToken merge", () => {
  const env = {
    BASE_URL: "https://study.example.com",
    WEB_BASE_URL: "https://web.example.com",
    SMTP_HOST: "smtp.example.com",
    SMTP_FROM: "noreply@example.com",
  };

  async function loginToken(fx: Fixture, email = "merge@example.com") {
    await fx.app.inject({
      method: "POST",
      url: "/v1/auth/email/request",
      payload: { email },
    });
    const token = new URL(fx.mail[fx.mail.length - 1].url).searchParams.get("token")!;
    const cb = await fx.app.inject({
      method: "GET",
      url: `/v1/auth/email/callback?token=${token}`,
    });
    return fragmentParam(cb.headers.location!, "token")!;
  }

  it("binds the device to the account: userId becomes the account id, host row follows", async () => {
    const fx = await buildFixture(env);
    // Anonymous first join → host of the room.
    const anon = await fx.join("device-bind-1", "Anon", "bindroom");
    expect(anon.statusCode).toBe(200);
    const deviceUserId = anon.body.userId as string;
    expect(anon.body.role).toBe("host");

    const token = await loginToken(fx);
    const bound = await fx.join("device-bind-1", "Anon", "bindroom", { authToken: token });
    expect(bound.statusCode).toBe(200);
    const accountId = bound.body.userId as string;
    expect(accountId).not.toBe(deviceUserId);
    // The device's host row followed the account.
    expect(bound.body.role).toBe("host");
    expect(
      fx.db.prepare("SELECT role FROM room_roles WHERE room='bindroom' AND user_id=?").get(accountId),
    ).toMatchObject({ role: "host" });
    // The anonymous row is deleted.
    expect(fx.db.prepare("SELECT id FROM users WHERE id=?").get(deviceUserId)).toBeUndefined();

    // Re-binding the same device is a no-op returning the same account.
    const again = await fx.join("device-bind-1", "Anon2", "bindroom", { authToken: token });
    expect(again.statusCode).toBe(200);
    expect(again.body.userId).toBe(accountId);
    expect(again.body.nickname).toBe("Anon2");
    await fx.app.close();
  });

  it("invalid authToken → 401 invalid_session", async () => {
    const fx = await buildFixture(env);
    const r = await fx.join("device-bad-1", "Anon", "bindroom", { authToken: "bogus" });
    expect(r.statusCode).toBe(401);
    expect(r.body).toEqual({ error: "invalid_session" });
    await fx.app.close();
  });

  it("a kicked account stays kicked: kick check runs against the merged id", async () => {
    const fx = await buildFixture(env);
    const token = await loginToken(fx, "kicked@example.com");
    // Resolve the account id via /me, then kick it in kickroom.
    const me = await fx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    const accountId = me.json().userId as string;
    addKick(fx.db, "kickroom", accountId, accountId, "test", Date.now());

    const r = await fx.join("device-kick-1", "Anon", "kickroom", { authToken: token });
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({ error: "kicked" });
    await fx.app.close();
  });

  it("anonymous flow (no authToken) is unchanged: role stays host|user", async () => {
    const fx = await buildFixture(env);
    const r1 = await fx.join("device-plain-1", "Anon", "plainroom");
    expect(r1.body.role).toBe("host");
    const r2 = await fx.join("device-plain-2", "Anon", "plainroom");
    expect(r2.body.role).toBe("user");
    expect(r2.body.userId).not.toBe(r1.body.userId);
    await fx.app.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP: moderation gate uses the effective role (allowlist admin)
// ---------------------------------------------------------------------------

describe("moderation gate with allowlist admin", () => {
  const env = {
    BASE_URL: "https://study.example.com",
    SMTP_HOST: "smtp.example.com",
    SMTP_FROM: "noreply@example.com",
  };

  it("an allowlisted (non-host) account passes the host/admin gate; a plain user does not", async () => {
    const allowlist: AdminAllowlist = { githubUsers: [], emails: ["admin@example.com"] };
    const fx = await buildFixture(env, { allowlist, withModeration: true });

    // Host joins anonymously and files a report to have something to list.
    const host = await fx.join("device-host-9", "Host", "adminroom");
    const target = await fx.join("device-target-9", "Tgt", "adminroom");
    const rep = await fx.app.inject({
      method: "POST",
      url: "/v1/rooms/adminroom/reports",
      headers: { authorization: `Bearer ${host.body.token}` },
      payload: { targetId: target.body.userId, reason: "spam" },
    });
    expect(rep.statusCode).toBe(201);

    // Allowlisted account logs in via magic link → site admin (not host).
    await fx.app.inject({
      method: "POST",
      url: "/v1/auth/email/request",
      payload: { email: "admin@example.com" },
    });
    const magic = new URL(fx.mail[0].url).searchParams.get("token")!;
    const cb = await fx.app.inject({
      method: "GET",
      url: `/v1/auth/email/callback?token=${magic}`,
    });
    const loginToken = fragmentParam(cb.headers.location!, "token")!;
    const me = await fx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${loginToken}` },
    });
    const adminId = me.json().userId as string;

    // The admin needs a room JWT: join with authToken (becomes a plain member,
    // NOT the host — the host row already exists).
    const adminJoin = await fx.join("device-admin-9", "Admin", "adminroom", {
      authToken: loginToken,
    });
    expect(adminJoin.body.role).toBe("admin");
    expect(adminJoin.body.userId).toBe(adminId);

    const list = await fx.app.inject({
      method: "GET",
      url: "/v1/rooms/adminroom/reports",
      headers: { authorization: `Bearer ${adminJoin.body.token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().reports).toHaveLength(1);

    // A plain member is still refused.
    const plainList = await fx.app.inject({
      method: "GET",
      url: "/v1/rooms/adminroom/reports",
      headers: { authorization: `Bearer ${target.body.token}` },
    });
    expect(plainList.statusCode).toBe(403);
    expect(plainList.json()).toEqual({ error: "not_host" });

    // The site admin cannot transfer host (M2 §6 preserved).
    const transfer = await fx.app.inject({
      method: "POST",
      url: "/v1/rooms/adminroom/host",
      headers: { authorization: `Bearer ${adminJoin.body.token}` },
      payload: { toUserId: target.body.userId },
    });
    expect(transfer.statusCode).toBe(403);
    await fx.app.close();
  });
});

// ---------------------------------------------------------------------------
// emailRequestAllowed unit behavior
// ---------------------------------------------------------------------------

describe("emailRequestAllowed", () => {
  it("10/hour per address, independent per address", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) expect(emailRequestAllowed("x@y.z", now + i)).toBe(true);
    expect(emailRequestAllowed("x@y.z", now + 11)).toBe(false);
    expect(emailRequestAllowed("other@y.z", now + 11)).toBe(true);
    // Window slides: after an hour the budget resets.
    expect(emailRequestAllowed("x@y.z", now + 3_600_001)).toBe(true);
  });
});
