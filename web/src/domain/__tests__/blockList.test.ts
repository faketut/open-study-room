import { describe, it, expect } from "vitest";
import {
  blockIdentity,
  blockStorageKey,
  isBlockedIdentity,
  readBlockedIdentities,
  unblockIdentity,
  type BlockStorage,
} from "../blockList";

function fakeStorage(): BlockStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("block list", () => {
  it("uses the contract storage key", () => {
    expect(blockStorageKey("room-1")).toBe("syncle.blocked.room-1");
  });

  it("blocks and unblocks identities", () => {
    const s = fakeStorage();
    expect(isBlockedIdentity("room-1", "u1", s)).toBe(false);
    blockIdentity("room-1", "u1", s);
    expect(isBlockedIdentity("room-1", "u1", s)).toBe(true);
    expect(isBlockedIdentity("room-1", "u2", s)).toBe(false);
    unblockIdentity("room-1", "u1", s);
    expect(isBlockedIdentity("room-1", "u1", s)).toBe(false);
  });

  it("is idempotent and scoped per room", () => {
    const s = fakeStorage();
    blockIdentity("room-a", "u1", s);
    blockIdentity("room-a", "u1", s);
    expect(Array.from(readBlockedIdentities("room-a", s))).toEqual(["u1"]);
    expect(isBlockedIdentity("room-b", "u1", s)).toBe(false);
    // Unblocking a non-member is a no-op.
    unblockIdentity("room-a", "nobody", s);
    expect(isBlockedIdentity("room-a", "u1", s)).toBe(true);
  });

  it("persists as a JSON array of userId strings", () => {
    const s = fakeStorage();
    blockIdentity("room-1", "u1", s);
    blockIdentity("room-1", "u2", s);
    const raw = s.data["syncle.blocked.room-1"];
    const parsed = JSON.parse(raw) as unknown;
    expect(parsed).toEqual(["u1", "u2"]);
    // Re-reading from storage round-trips.
    expect(readBlockedIdentities("room-1", s)).toEqual(new Set(["u1", "u2"]));
  });

  it("degrades to an empty set on corrupt payloads", () => {
    const s = fakeStorage();
    s.data["syncle.blocked.room-1"] = "not-json{{{";
    expect(readBlockedIdentities("room-1", s)).toEqual(new Set());
    s.data["syncle.blocked.room-1"] = JSON.stringify({ not: "an array" });
    expect(readBlockedIdentities("room-1", s)).toEqual(new Set());
    s.data["syncle.blocked.room-1"] = JSON.stringify(["u1", 42, null, ""]);
    expect(readBlockedIdentities("room-1", s)).toEqual(new Set(["u1"]));
  });

  it("handles missing storage and empty room gracefully", () => {
    expect(readBlockedIdentities("room-1", null)).toEqual(new Set());
    expect(isBlockedIdentity("", "u1", null)).toBe(false);
    // No-ops must not throw.
    blockIdentity("", "u1", null);
    unblockIdentity("", "u1", null);
  });
});
