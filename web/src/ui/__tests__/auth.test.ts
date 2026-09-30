// P1-B login UI — unit tests for the pure login helpers in
// web/src/data/auth.ts. Pure functions; no DOM needed.
// Contract: docs/contracts.md "Identity & login (P1-B: lightweight login)".

import { describe, expect, it } from "vitest";
import {
  AUTH_STRINGS,
  authErrorText,
  parseAuthFragment,
  visibleLoginEntries,
} from "../../data/auth";
import { localizeText } from "../../domain/templateRegistry";

describe("parseAuthFragment", () => {
  it("parses #token=", () => {
    expect(parseAuthFragment("#token=abc123")).toEqual({ token: "abc123" });
  });

  it("parses #error=", () => {
    expect(parseAuthFragment("#error=invalid_state")).toEqual({
      error: "invalid_state",
    });
  });

  it("returns empty for no fragment", () => {
    expect(parseAuthFragment("")).toEqual({});
    expect(parseAuthFragment("#")).toEqual({});
  });

  it("ignores unrelated hashes", () => {
    expect(parseAuthFragment("#foo=bar")).toEqual({});
    expect(parseAuthFragment("#map")).toEqual({});
  });

  it("accepts a hash without the leading #", () => {
    expect(parseAuthFragment("token=xyz")).toEqual({ token: "xyz" });
  });

  it("decodes percent-encoded values", () => {
    expect(parseAuthFragment("#token=a%20b")).toEqual({ token: "a b" });
  });

  it("ignores empty values and keeps the first of duplicates", () => {
    expect(parseAuthFragment("#token=&token=second")).toEqual({
      token: "second",
    });
    expect(parseAuthFragment("#error=")).toEqual({});
  });

  it("parses both when both are present (server never sends both)", () => {
    expect(parseAuthFragment("#token=t&error=invalid_state")).toEqual({
      token: "t",
      error: "invalid_state",
    });
  });
});

describe("visibleLoginEntries", () => {
  it("shows nothing when config is unknown (loading or fetch failed)", () => {
    expect(visibleLoginEntries(null)).toEqual({
      github: false,
      email: false,
    });
  });

  it("shows only github when email is not configured", () => {
    expect(visibleLoginEntries({ github: true, email: false })).toEqual({
      github: true,
      email: false,
    });
  });

  it("shows only email when github is not configured", () => {
    expect(visibleLoginEntries({ github: false, email: true })).toEqual({
      github: false,
      email: true,
    });
  });

  it("shows both when both are configured", () => {
    expect(visibleLoginEntries({ github: true, email: true })).toEqual({
      github: true,
      email: true,
    });
  });

  it("hides both when neither is configured", () => {
    expect(visibleLoginEntries({ github: false, email: false })).toEqual({
      github: false,
      email: false,
    });
  });
});

describe("authErrorText", () => {
  it("maps every contract error code to human text, no raw code leaks", () => {
    const codes = [
      "invalid_state",
      "invalid_token",
      "expired_token",
      "github_not_configured",
      "email_not_configured",
      "rate_limited",
    ];
    for (const code of codes) {
      const en = authErrorText(code, "en");
      const zh = authErrorText(code, "zh");
      expect(en.length).toBeGreaterThan(0);
      expect(zh.length).toBeGreaterThan(0);
      // The raw code must not leak into the user-facing message.
      expect(en).not.toContain(code);
      expect(zh).not.toContain(code);
    }
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(authErrorText("something_new", "en")).toBe(
      "Sign-in failed — please try again.",
    );
    expect(authErrorText("something_new", "zh")).toBe("登录失败，请重试。");
    expect(authErrorText(undefined, "en")).toBe(
      "Sign-in failed — please try again.",
    );
  });

  it("distinguishes the two human-readable cases for expired vs invalid", () => {
    expect(authErrorText("expired_token", "en")).not.toBe(
      authErrorText("invalid_token", "en"),
    );
  });
});

describe("AUTH_STRINGS", () => {
  it("has en+zh for every key used by the login UI", () => {
    const keys = [
      "signIn",
      "signInWithGithub",
      "signInWithEmail",
      "sendSignInLink",
      "checkEmail",
      "signOut",
      "admin",
      "host",
    ];
    for (const key of keys) {
      const s = AUTH_STRINGS[key];
      expect(s, key).toBeDefined();
      expect(localizeText(s, "en").length, `${key}/en`).toBeGreaterThan(0);
      expect(localizeText(s, "zh").length, `${key}/zh`).toBeGreaterThan(0);
    }
  });
});
