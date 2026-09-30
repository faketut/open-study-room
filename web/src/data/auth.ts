// P1-B lightweight login — client-side auth helpers.
// Contract: docs/contracts.md "Identity & login (P1-B: lightweight login)".
//
// The login-session bearer is delivered exactly once in the URL fragment
// (`#token=`) after an OAuth/email callback; fragments are never sent to the
// web server. It is stored in localStorage and presented as
// `Authorization: Bearer <token>` on the auth REST endpoints. Callback
// errors travel as `#error=<code>` (code only, no PII).

import type { LocalizedText, UiLang } from "../domain/templateRegistry";

export const AUTH_TOKEN_KEY = "syncle.auth_token";

/** What the server advertises via GET /v1/auth/config (contract §5). */
export interface AuthConfig {
  github: boolean;
  email: boolean;
}

/** GET /v1/auth/me response shape (contract §5). */
export interface AuthMe {
  userId: string;
  provider: "device" | "github" | "email";
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
  isAdmin: boolean;
}

export class AuthApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Server error code (e.g. `email_not_configured`), or undefined. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

// ---------- Token storage ----------

export function getAuthToken(): string | null {
  try {
    const v = localStorage.getItem(AUTH_TOKEN_KEY);
    return v != null && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function setAuthToken(token: string): void {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    /* storage unavailable — stay anonymous */
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- Fragment handling ----------

export interface AuthFragment {
  token?: string;
  error?: string;
}

/** Parse a `location.hash` value (with or without the leading `#`).
 *  Pure, so it is unit-testable. When both `#token=` and `#error=` are
 *  present (the server never sends both), token wins — callers treat a
 *  stored token as authoritative. */
export function parseAuthFragment(hash: string): AuthFragment {
  const out: AuthFragment = {};
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (body.length === 0) return out;
  for (const part of body.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      value = part.slice(eq + 1);
    }
    if (key === "token" && value.length > 0 && out.token == null) {
      out.token = value;
    } else if (key === "error" && value.length > 0 && out.error == null) {
      out.error = value;
    }
  }
  return out;
}

/** Read the startup fragment once, return what it carried, and strip it
 *  from the address bar via history.replaceState (no reload, and the token
 *  never lingers in a copy-pasteable URL). Impure wrapper around
 *  parseAuthFragment; safe to call when no auth fragment is present. */
export function consumeAuthFragment(): AuthFragment {
  const parsed = parseAuthFragment(window.location.hash);
  if (parsed.token != null || parsed.error != null) {
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  return parsed;
}

// ---------- Login-entry visibility ----------

/** Which login entries JoinScreen renders. Pure, unit-testable: the email
 *  entry shows only when the server reports it configured (contract §4 —
 *  the entry is hidden, never shown-but-broken). Unknown config (still
 *  loading, or the fetch failed) shows nothing so the anonymous flow stays
 *  untouched. */
export function visibleLoginEntries(
  config: AuthConfig | null,
): { github: boolean; email: boolean } {
  return {
    github: config?.github === true,
    email: config?.email === true,
  };
}

// ---------- UI strings (bilingual, via the existing localizeText pattern) ----------

export const AUTH_STRINGS: Record<string, LocalizedText> = {
  signIn: { en: "Sign in", zh: "登录" },
  signInWithGithub: { en: "Sign in with GitHub", zh: "使用 GitHub 登录" },
  signInWithEmail: { en: "Sign in with email", zh: "使用邮箱登录" },
  emailPlaceholder: { en: "you@example.com", zh: "you@example.com" },
  sendSignInLink: { en: "Send sign-in link", zh: "发送登录链接" },
  checkEmail: {
    en: "Check your email for the sign-in link.",
    zh: "请查收邮件中的登录链接。",
  },
  signOut: { en: "Sign out", zh: "退出登录" },
  admin: { en: "ADMIN", zh: "管理员" },
  host: { en: "HOST", zh: "房主" },
};

/** Contract `#error=` codes → human text (code only, no PII — contract §7).
 *  Unknown codes fall back to a generic message instead of surfacing the
 *  raw code. */
const AUTH_ERROR_TEXT: Record<string, LocalizedText> = {
  invalid_state: {
    en: "Login session expired or already used — please try again.",
    zh: "登录会话已过期或已被使用，请重试。",
  },
  invalid_token: {
    en: "This sign-in link is invalid.",
    zh: "登录链接无效。",
  },
  expired_token: {
    en: "This sign-in link has expired — request a new one.",
    zh: "登录链接已过期，请重新获取。",
  },
  github_not_configured: {
    en: "GitHub login is not available on this server.",
    zh: "此服务器未配置 GitHub 登录。",
  },
  email_not_configured: {
    en: "Email login is not available on this server.",
    zh: "此服务器未配置邮箱登录。",
  },
  rate_limited: {
    en: "Too many attempts — please wait a moment and try again.",
    zh: "尝试过于频繁，请稍后再试。",
  },
};

export function authErrorText(code: string | undefined, lang: UiLang): string {
  const entry = code != null ? AUTH_ERROR_TEXT[code] : undefined;
  if (entry == null) {
    return lang === "zh" ? "登录失败，请重试。" : "Sign-in failed — please try again.";
  }
  return lang === "zh" ? entry.zh : entry.en;
}

// ---------- REST clients ----------

function base(backendUrl: string): string {
  return backendUrl.replace(/\/$/, "");
}

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const json = (await res.json()) as { error?: unknown };
    return typeof json.error === "string" ? json.error : undefined;
  } catch {
    return undefined;
  }
}

/** Public: which login providers are actually configured (contract §5). */
export async function getAuthConfig(backendUrl: string): Promise<AuthConfig> {
  const res = await fetch(`${base(backendUrl)}/v1/auth/config`);
  if (!res.ok) {
    throw new AuthApiError(`GET /v1/auth/config ${res.status}`, res.status);
  }
  const json = (await res.json()) as { github?: unknown; email?: unknown };
  return { github: json.github === true, email: json.email === true };
}

/** GitHub login = full-page 302 via the server (contract §3). The client
 *  navigates here with `window.location.href`. */
export function githubLoginUrl(backendUrl: string): string {
  return `${base(backendUrl)}/v1/auth/github`;
}

/** Request an email magic link. Success is always a generic 202 (contract
 *  §4); failures carry a code (e.g. `email_not_configured`). */
export async function requestEmailLink(
  backendUrl: string,
  email: string,
): Promise<void> {
  const res = await fetch(`${base(backendUrl)}/v1/auth/email/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    throw new AuthApiError(
      `POST /v1/auth/email/request ${res.status}`,
      res.status,
      await readErrorCode(res),
    );
  }
}

/** Bearer → account profile (contract §5). Used to render the logged-in
 *  badge. */
export async function getMe(
  backendUrl: string,
  token: string,
): Promise<AuthMe> {
  const res = await fetch(`${base(backendUrl)}/v1/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new AuthApiError(
      `GET /v1/auth/me ${res.status}`,
      res.status,
      await readErrorCode(res),
    );
  }
  return (await res.json()) as AuthMe;
}

/** Revoke the presented login session (contract §5). The caller discards
 *  its stored token regardless of the outcome. */
export async function deleteAuthSession(
  backendUrl: string,
  token: string,
): Promise<void> {
  const res = await fetch(`${base(backendUrl)}/v1/auth/session`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new AuthApiError(
      `DELETE /v1/auth/session ${res.status}`,
      res.status,
      await readErrorCode(res),
    );
  }
}
