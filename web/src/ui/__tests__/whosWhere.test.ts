// UI refinements §1 — Who's where is collapsed by default.
// Tests the exported readCollapsed() persistence helper.

import { afterEach, describe, expect, it } from "vitest";
import { readCollapsed } from "../WhosWherePanel";

describe("readCollapsed (collapsed by default)", () => {
  const store = new Map<string, string>();
  const origLocalStorage = (globalThis as Record<string, unknown>).localStorage;

  function stubLocalStorage() {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
  }

  stubLocalStorage();
  afterEach(() => {
    store.clear();
    (globalThis as Record<string, unknown>).localStorage = origLocalStorage;
    stubLocalStorage();
  });

  it("defaults to collapsed when no preference is stored", () => {
    expect(readCollapsed()).toBe(true);
  });

  it("stays collapsed for unexpected stored values", () => {
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      "syncle.whosWhereCollapsed",
      "yes",
    );
    expect(readCollapsed()).toBe(true);
  });

  it("respects an explicit expanded preference (\"0\")", () => {
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      "syncle.whosWhereCollapsed",
      "0",
    );
    expect(readCollapsed()).toBe(false);
  });

  it("respects an explicit collapsed preference (\"1\")", () => {
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      "syncle.whosWhereCollapsed",
      "1",
    );
    expect(readCollapsed()).toBe(true);
  });
});
