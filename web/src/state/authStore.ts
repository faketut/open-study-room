// P1-B login session state (zustand, same style as state/syncleStore.ts).
// Contract: docs/contracts.md "Identity & login (P1-B: lightweight login)".
//
// Holds the bearer token, the account profile from GET /v1/auth/me, and the
// provider availability from GET /v1/auth/config. Anonymous users never touch
// this store beyond the (no-op) bootstrap.

import { create } from "zustand";
import {
  consumeAuthFragment,
  clearAuthToken,
  deleteAuthSession,
  getAuthConfig,
  getAuthToken,
  getMe,
  setAuthToken,
  type AuthConfig,
  type AuthMe,
} from "../data/auth";

export interface AuthBootstrapResult {
  /** `#error=` code carried by the startup fragment, if any. The caller
   *  turns it into human text; the store doesn't keep it. */
  errorCode: string | null;
  /** Account resolved from the stored/fragment token, if any. */
  account: AuthMe | null;
}

interface AuthState {
  /** Raw login-session bearer, or null when logged out / anonymous. */
  token: string | null;
  /** Account profile from GET /v1/auth/me, or null when anonymous. */
  account: AuthMe | null;
  /** Provider availability from GET /v1/auth/config (null = not loaded). */
  config: AuthConfig | null;
  /** True once the first bootstrap finished (account + config attempted). */
  ready: boolean;
  /** Startup: consume `#token=` / `#error=`, restore the stored session,
   *  fetch config. Guarded against double-run (React StrictMode mounts
   *  effects twice in dev; the fragment consume is safe to repeat). */
  bootstrap: (backendUrl: string) => Promise<AuthBootstrapResult>;
  /** Re-resolve the stored token against /v1/auth/me. */
  refreshAccount: (backendUrl: string) => Promise<void>;
  /** DELETE /v1/auth/session and drop the stored token (contract §5). */
  logout: (backendUrl: string) => Promise<void>;
}

// Module-level: bootstrap runs once per page load even if the component
// re-mounts (e.g. StrictMode). The fragment was already consumed by the
// first run, so a second run would find an empty hash and a stored token —
let bootstrapStarted = false;

export const useAuth = create<AuthState>()((set, get) => ({
  token: null,
  account: null,
  config: null,
  ready: false,

  bootstrap: async (backendUrl) => {
    if (bootstrapStarted) {
      return { errorCode: null, account: get().account };
    }
    bootstrapStarted = true;

    // `#token=` → store; `#error=` → hand the code back for UI text.
    // consumeAuthFragment strips the fragment via history.replaceState.
    const { token: fragToken, error: fragError } = consumeAuthFragment();
    if (fragToken != null) setAuthToken(fragToken);

    let account: AuthMe | null = null;
    const token = getAuthToken();
    if (token != null) {
      try {
        account = await getMe(backendUrl, token);
        set({ token, account });
      } catch (err) {
        // Stale / revoked / unknown token — drop it so the anonymous flow
        // is untouched instead of retrying a dead session forever.
        console.warn("auth token rejected, dropping it", err);
        clearAuthToken();
        set({ token: null, account: null });
      }
    }

    try {
      const config = await getAuthConfig(backendUrl);
      set({ config });
    } catch (err) {
      // Config fetch failing must not break joining: the login entries
      // stay hidden and everything works anonymously.
      console.warn("getAuthConfig failed", err);
    }
    set({ ready: true });
    return { errorCode: fragError ?? null, account };
  },

  refreshAccount: async (backendUrl) => {
    const token = getAuthToken();
    if (token == null) {
      set({ token: null, account: null });
      return;
    }
    try {
      const account = await getMe(backendUrl, token);
      set({ token, account });
    } catch {
      clearAuthToken();
      set({ token: null, account: null });
    }
  },

  logout: async (backendUrl) => {
    const token = getAuthToken();
    if (token != null) {
      try {
        await deleteAuthSession(backendUrl, token);
      } catch (err) {
        // Best-effort revoke; the local token is dropped either way.
        console.warn("deleteAuthSession failed", err);
      }
      clearAuthToken();
    }
    set({ token: null, account: null });
  },
}));
