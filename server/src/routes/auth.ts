import type { FastifyInstance, FastifyReply } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import nodemailer from "nodemailer";
import type { Config } from "../config.js";
import type { Db, AdminAllowlist, UserRow } from "../db.js";
import {
  isAllowlistAdmin,
  upsertAccount,
  normalizeEmail,
  sha256Hex,
  createLoginSession,
  revokeLoginSession,
  createOAuthState,
  consumeOAuthState,
  createMagicToken,
  consumeMagicToken,
} from "../db.js";
import { extractBearer, verifyLoginSession } from "../auth.js";

// ---------- P1-B lightweight login ----------
// Contract: docs/contracts.md "Identity & login (P1-B: lightweight login)".
// Eight endpoints under /v1/auth/ (plus the authToken extension to
// POST /v1/sessions, which lives in routes/sessions.ts).

export interface GitHubUserProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  /** Primary verified email, null when the account has none. */
  email: string | null;
}

/** Server-to-server GitHub calls. Injectable so tests can stub the OAuth
 *  exchange without touching the network. */
export interface GitHubClient {
  /** Exchange the authorization code for an access token (server-side; the
   *  client secret never leaves the server). */
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  /** Fetch the profile + primary verified email for an access token. */
  getUser(accessToken: string): Promise<GitHubUserProfile>;
}

export interface Mailer {
  sendSignInLink(to: string, url: string): Promise<void>;
}

export interface AuthDeps {
  db: Db;
  cfg: Config;
  allowlist: AdminAllowlist;
  /** Defaults to the live GitHub API client. */
  github?: GitHubClient;
  /** Defaults to the SMTP mailer when email is configured. */
  mailer?: Mailer;
}

export function githubConfigured(cfg: Config): boolean {
  return !!cfg.GITHUB_CLIENT_ID && !!cfg.GITHUB_CLIENT_SECRET && !!cfg.BASE_URL;
}

export function emailConfigured(cfg: Config): boolean {
  return !!cfg.SMTP_HOST && !!cfg.SMTP_FROM && !!cfg.BASE_URL;
}

function createGitHubClient(cfg: Config): GitHubClient {
  const headers = (accessToken: string) => ({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "open-study-room",
  });
  return {
    async exchangeCode(code, redirectUri) {
      const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: cfg.GITHUB_CLIENT_ID,
          client_secret: cfg.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!res.ok) throw new Error(`token exchange HTTP ${res.status}`);
      const data = (await res.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!data.access_token) {
        throw new Error(`token exchange failed: ${data.error ?? "unknown"}`);
      }
      return data.access_token;
    },
    async getUser(accessToken) {
      const uRes = await fetch("https://api.github.com/user", {
        headers: headers(accessToken),
      });
      if (!uRes.ok) throw new Error(`user fetch HTTP ${uRes.status}`);
      const u = (await uRes.json()) as {
        id: number;
        login: string;
        name: string | null;
        avatar_url: string | null;
      };
      let email: string | null = null;
      const eRes = await fetch("https://api.github.com/user/emails", {
        headers: headers(accessToken),
      });
      if (eRes.ok) {
        const emails = (await eRes.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        email = emails.find((e) => e.primary && e.verified)?.email ?? null;
      }
      return {
        id: u.id,
        login: u.login,
        name: u.name,
        avatar_url: u.avatar_url,
        email,
      };
    },
  };
}

function createSmtpMailer(cfg: Config): Mailer {
  const transport = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_PORT === 465,
    auth: cfg.SMTP_USER
      ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS ?? "" }
      : undefined,
  });
  return {
    async sendSignInLink(to, url) {
      await transport.sendMail({
        from: cfg.SMTP_FROM,
        to,
        subject: "Sign in to Open Study Room",
        text:
          `Click this link to sign in (expires in 15 minutes):\n\n` +
          `${url}\n\nIf you didn't request this, you can ignore this email.`,
      });
    },
  };
}

/** The raw login token travels to the browser ONLY in the URL fragment
 *  (#token=), which browsers never send to the web server. */
function tokenRedirect(reply: FastifyReply, webBaseUrl: string, token: string) {
  return reply.redirect(`${webBaseUrl}/#token=${token}`);
}

/** Error redirects carry a code only — never PII, never the raw token. */
function errorRedirect(reply: FastifyReply, webBaseUrl: string, code: string) {
  return reply.redirect(`${webBaseUrl}/#error=${code}`);
}

function invalidBody(reply: FastifyReply, issues: unknown) {
  return reply.code(400).send({ error: "invalid_body", details: issues });
}

/** Per-email throttle for POST /v1/auth/email/request (contract §7: 10/hour
 *  per normalized email, bounding mail-bombing a single address). In-memory,
 *  per process — the per-IP limiter below is the durable layer. */
const EMAIL_REQUEST_LIMIT = 10;
const EMAIL_REQUEST_WINDOW_MS = 3_600_000;
const emailRequestTimes = new Map<string, number[]>();

export function emailRequestAllowed(email: string, now: number): boolean {
  const recent = (emailRequestTimes.get(email) ?? []).filter(
    (t) => now - t < EMAIL_REQUEST_WINDOW_MS,
  );
  if (recent.length >= EMAIL_REQUEST_LIMIT) {
    emailRequestTimes.set(email, recent);
    return false;
  }
  recent.push(now);
  emailRequestTimes.set(email, recent);
  return true;
}

/** Test hook: reset the in-memory per-email throttle. */
export function resetEmailRequestThrottle(): void {
  emailRequestTimes.clear();
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthDeps,
): Promise<void> {
  const { db, cfg, allowlist } = deps;
  const github: GitHubClient =
    deps.github ?? createGitHubClient(cfg);
  const mailer: Mailer | undefined =
    deps.mailer ?? (emailConfigured(cfg) ? createSmtpMailer(cfg) : undefined);

  // Per-IP throttle for /v1/auth/*, separate from the sessions limiter
  // (contract §7). Scoped to this plugin via encapsulation. Exceeding the
  // cap → 429 { error: "rate_limited" } via the scope-local error handler.
  await app.register(async (scope) => {
    await scope.register(rateLimit, {
      max: cfg.AUTH_RATE_LIMIT_MAX,
      timeWindow: cfg.AUTH_RATE_LIMIT_WINDOW_MS,
    });
    scope.setErrorHandler((error, _req, reply) => {
      if ((error as { statusCode?: number }).statusCode === 429) {
        return reply.code(429).send({ error: "rate_limited" });
      }
      return reply.send(error);
    });

    const issueSession = (reply: FastifyReply, account: UserRow) => {
      const { token } = createLoginSession(
        db,
        account.id,
        cfg.LOGIN_SESSION_TTL_DAYS,
      );
      return tokenRedirect(reply, cfg.WEB_BASE_URL, token);
    };

    // ---- GET /v1/auth/github — start the OAuth flow ----
    scope.get("/v1/auth/github", async (_req, reply) => {
      if (!githubConfigured(cfg)) {
        return reply.code(503).send({ error: "github_not_configured" });
      }
      const state = createOAuthState(db);
      const params = new URLSearchParams({
        client_id: cfg.GITHUB_CLIENT_ID!,
        redirect_uri: `${cfg.BASE_URL}/v1/auth/github/callback`,
        scope: "read:user user:email",
        state,
      });
      return reply.redirect(
        `https://github.com/login/oauth/authorize?${params.toString()}`,
      );
    });

    // ---- GET /v1/auth/github/callback — finish the OAuth flow ----
    const GitHubCallbackQuery = z.object({
      code: z.string().min(1),
      state: z.string().min(1),
    });
    scope.get("/v1/auth/github/callback", async (req, reply) => {
      const parsed = GitHubCallbackQuery.safeParse(req.query);
      if (!parsed.success || !githubConfigured(cfg)) {
        return errorRedirect(reply, cfg.WEB_BASE_URL, "invalid_state");
      }
      const { code, state } = parsed.data;
      // Single-use: a replayed state fails here → #error=invalid_state.
      if (!consumeOAuthState(db, state)) {
        return errorRedirect(reply, cfg.WEB_BASE_URL, "invalid_state");
      }
      try {
        const accessToken = await github.exchangeCode(
          code,
          `${cfg.BASE_URL}/v1/auth/github/callback`,
        );
        const profile = await github.getUser(accessToken);
        if (!profile.email) {
          return errorRedirect(reply, cfg.WEB_BASE_URL, "no_verified_email");
        }
        const account = upsertAccount(db, {
          provider: "github",
          providerSub: String(profile.id),
          providerHandle: profile.login,
          email: normalizeEmail(profile.email),
          displayName: profile.name,
          avatarUrl: profile.avatar_url,
        });
        return issueSession(reply, account);
      } catch {
        // Code only in the redirect; the error detail stays server-side.
        // Log at most a truncated hash prefix for correlation (contract §7).
        req.log.warn(
          { stateHash: sha256Hex(state).slice(0, 8) },
          "github oauth callback failed",
        );
        return errorRedirect(reply, cfg.WEB_BASE_URL, "oauth_failed");
      }
    });

    // ---- POST /v1/auth/email/request — send a magic link ----
    const EmailRequestBody = z.object({
      email: z.string().min(1).max(254),
    });
    const EmailShape = z.string().email();
    scope.post("/v1/auth/email/request", async (req, reply) => {
      const parsed = EmailRequestBody.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      const email = normalizeEmail(parsed.data.email);
      if (!EmailShape.safeParse(email).success) {
        return invalidBody(reply, [
          { path: ["email"], message: "invalid email" },
        ]);
      }
      if (!emailConfigured(cfg) || !mailer) {
        return reply.code(501).send({ error: "email_not_configured" });
      }
      if (!emailRequestAllowed(email, Date.now())) {
        return reply.code(429).send({ error: "rate_limited" });
      }
      const token = createMagicToken(db, email);
      const url = `${cfg.BASE_URL}/v1/auth/email/callback?token=${token}`;
      try {
        await mailer.sendSignInLink(email, url);
      } catch {
        req.log.warn("magic link send failed");
        return reply.code(502).send({ error: "email_send_failed" });
      }
      // Fixed generic response — reveals nothing about account existence.
      return reply.code(202).send({ status: "sent" });
    });

    // ---- GET /v1/auth/email/callback — redeem a magic link ----
    const EmailCallbackQuery = z.object({
      token: z.string().min(1),
    });
    scope.get("/v1/auth/email/callback", async (req, reply) => {
      const parsed = EmailCallbackQuery.safeParse(req.query);
      if (!parsed.success) {
        return errorRedirect(reply, cfg.WEB_BASE_URL, "invalid_token");
      }
      const res = consumeMagicToken(db, parsed.data.token);
      if (!res.ok) {
        return errorRedirect(
          reply,
          cfg.WEB_BASE_URL,
          res.reason === "expired" ? "expired_token" : "invalid_token",
        );
      }
      const account = upsertAccount(db, {
        provider: "email",
        providerSub: res.email,
        providerHandle: res.email,
        email: res.email,
      });
      return issueSession(reply, account);
    });

    // ---- GET /v1/auth/me — who am I (login-session bearer) ----
    scope.get("/v1/auth/me", async (req, reply) => {
      const token = extractBearer(req.headers.authorization);
      const session = token ? verifyLoginSession(db, token) : null;
      if (!session) {
        return reply.code(401).send({ error: "invalid_session" });
      }
      const u = session.user;
      return reply.send({
        userId: u.id,
        provider: u.provider,
        displayName: u.display_name,
        avatarUrl: u.avatar_url,
        email: u.email,
        isAdmin: isAllowlistAdmin(db, u.id, allowlist),
      });
    });

    // ---- DELETE /v1/auth/session — log out (revoke the bearer) ----
    scope.delete("/v1/auth/session", async (req, reply) => {
      const token = extractBearer(req.headers.authorization);
      const session = token ? verifyLoginSession(db, token) : null;
      if (!session) {
        return reply.code(401).send({ error: "invalid_session" });
      }
      revokeLoginSession(db, session.id);
      return reply.code(204).send();
    });

    // ---- GET /v1/auth/config — which providers are actually on ----
    scope.get("/v1/auth/config", async (_req, reply) => {
      return reply.send({
        github: githubConfigured(cfg),
        email: emailConfigured(cfg),
      });
    });
  });
}
