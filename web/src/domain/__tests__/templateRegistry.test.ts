import { describe, expect, it, afterEach } from "vitest";
import {
  fetchRegistry,
  loadSelectedTemplateId,
  localizeText,
  parseRegistry,
  pickSelectedTemplate,
  pickUiLang,
  resolveJoinTemplate,
  saveSelectedTemplateId,
  templatePlaceholderHue,
  thumbnailUrl,
  TEMPLATE_STORAGE_KEY,
  type RegistryTemplateEntry,
} from "../templateRegistry";

/** Minimal legal template (mirrors mapTemplate.test.ts): 400x300 floor,
 *  one full-map silent zone (so Q4 dead-zone passes), one table, one
 *  walkable spawn, no thumbnail. Must resolve ok. */
function validTemplate(): Record<string, unknown> {
  return {
    template: {
      id: "library",
      name: { en: "Library", zh: "图书馆" },
      description: { en: "A quiet reading hall.", zh: "安静的阅读大厅。" },
    },
    map_name: "Library",
    width: 400,
    height: 300,
    background_color: "#2b2f3a",
    objects: [
      {
        type: "zone", id: "zone-main", label: "Main", kind: "silent",
        x: 0, y: 0, width: 400, height: 300,
      },
      {
        type: "table", id: "table-a1", label: "A1",
        x: 100, y: 100, width: 80, height: 60,
      },
    ],
    spawn_points: [{ x: 200, y: 250 }],
  };
}

function registryEntry(over: Partial<RegistryTemplateEntry> = {}): RegistryTemplateEntry {
  return {
    id: "welcome",
    name: { en: "Welcome Hall", zh: "开学迎新" },
    description: { en: "An open welcome hall.", zh: "开放式迎新大厅。" },
    url: "/templates/welcome.json",
    ...over,
  };
}

describe("templatePlaceholderHue", () => {
  it("is deterministic: same id always yields the same hue", () => {
    expect(templatePlaceholderHue("welcome")).toBe(107);
    expect(templatePlaceholderHue("exam-sprint")).toBe(101);
    expect(templatePlaceholderHue("welcome")).toBe(templatePlaceholderHue("welcome"));
  });

  it("always returns a hue in [0, 360)", () => {
    const ids = ["", "a", "welcome", "exam-sprint", "cafe-loft", "x".repeat(64)];
    for (let i = 0; i < 200; i++) ids.push(`tpl-${i}`);
    for (const id of ids) {
      const h = templatePlaceholderHue(id);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it("spreads ids across the range (not degenerate)", () => {
    const hues = new Set<string>();
    for (let i = 0; i < 200; i++) hues.add(String(templatePlaceholderHue(`tpl-${i}`)));
    expect(hues.size).toBeGreaterThan(100);
  });
});

describe("pickUiLang", () => {
  it("maps zh tags to zh, everything else to en", () => {
    expect(pickUiLang("zh-CN")).toBe("zh");
    expect(pickUiLang("zh")).toBe("zh");
    expect(pickUiLang("ZH-TW")).toBe("zh");
    expect(pickUiLang("en-US")).toBe("en");
    expect(pickUiLang("ja")).toBe("en");
    expect(pickUiLang("")).toBe("en");
    expect(pickUiLang(undefined)).toBe("en");
    expect(pickUiLang(null)).toBe("en");
  });
});

describe("localizeText", () => {
  const v = { en: "Library", zh: "图书馆" };
  it("picks the requested language", () => {
    expect(localizeText(v, "en")).toBe("Library");
    expect(localizeText(v, "zh")).toBe("图书馆");
  });
  it("falls back to the other language when preferred is empty", () => {
    expect(localizeText({ en: "Library", zh: "" }, "zh")).toBe("Library");
    expect(localizeText({ en: "", zh: "图书馆" }, "en")).toBe("图书馆");
  });
  it("returns empty string for missing metadata", () => {
    expect(localizeText(null, "en")).toBe("");
    expect(localizeText(undefined, "zh")).toBe("");
  });
});

describe("thumbnailUrl", () => {
  it("resolves relative thumbnails under /templates/", () => {
    expect(thumbnailUrl(registryEntry({ thumbnail: "thumbnails/welcome.png" }))).toBe(
      "/templates/thumbnails/welcome.png",
    );
  });
  it("passes absolute URLs through unchanged (Q9 warning, not error)", () => {
    expect(thumbnailUrl(registryEntry({ thumbnail: "https://cdn/x.png" }))).toBe(
      "https://cdn/x.png",
    );
    expect(thumbnailUrl(registryEntry({ thumbnail: "/abs/x.png" }))).toBe("/abs/x.png");
  });
  it("returns null when thumbnail is missing or empty", () => {
    expect(thumbnailUrl(registryEntry())).toBeNull();
    expect(thumbnailUrl(registryEntry({ thumbnail: "" }))).toBeNull();
  });
});

describe("parseRegistry", () => {
  it("parses a well-formed registry", () => {
    const raw = {
      templates: [
        registryEntry(),
        registryEntry({ id: "exam-sprint", url: "/templates/exam-sprint.json", thumbnail: "thumbnails/exam-sprint.png" }),
      ],
    };
    const list = parseRegistry(raw);
    expect(list).toHaveLength(2);
    expect(list![1].thumbnail).toBe("thumbnails/exam-sprint.png");
    expect(list![1].url).toBe("/templates/exam-sprint.json");
  });

  it("returns null for non-registry documents", () => {
    expect(parseRegistry(null)).toBeNull();
    expect(parseRegistry(42)).toBeNull();
    expect(parseRegistry({})).toBeNull();
    expect(parseRegistry({ templates: "nope" })).toBeNull();
  });

  it("skips malformed entries instead of failing the whole list", () => {
    const list = parseRegistry({
      templates: [
        null,
        "junk",
        { id: "", url: "/templates/x.json", name: { en: "a", zh: "b" }, description: { en: "a", zh: "b" } },
        { id: "no-url", name: { en: "a", zh: "b" }, description: { en: "a", zh: "b" } },
        { id: "no-name", url: "/templates/no-name.json", description: { en: "a", zh: "b" } },
        { id: "ok", url: "/templates/ok.json", name: { en: "a", zh: "b" }, description: { en: "a", zh: "b" }, thumbnail: 7 },
      ],
    });
    expect(list).toHaveLength(1);
    expect(list![0].id).toBe("ok");
    expect(list![0].thumbnail).toBeUndefined();
  });

  it("returns an empty array for a registry with zero templates", () => {
    expect(parseRegistry({ templates: [] })).toEqual([]);
  });
});

describe("pickSelectedTemplate", () => {
  const list = [
    registryEntry(),
    registryEntry({ id: "exam-sprint", url: "/templates/exam-sprint.json" }),
  ];
  it("picks the selected id when present", () => {
    expect(pickSelectedTemplate(list, "exam-sprint")!.id).toBe("exam-sprint");
  });
  it("falls back to the first entry when the selection is gone", () => {
    expect(pickSelectedTemplate(list, "removed")!.id).toBe("welcome");
    expect(pickSelectedTemplate(list, null)!.id).toBe("welcome");
    expect(pickSelectedTemplate(list, undefined)!.id).toBe("welcome");
  });
  it("returns null with no templates", () => {
    expect(pickSelectedTemplate([], "welcome")).toBeNull();
    expect(pickSelectedTemplate(null, "welcome")).toBeNull();
  });
});

describe("resolveJoinTemplate", () => {
  it("resolves a legal template to its url and spawn_points[0]", () => {
    const r = resolveJoinTemplate(validTemplate(), "/templates/library.json");
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.url).toBe("/templates/library.json");
    expect(r.spawn).toEqual({ x: 200, y: 250 });
  });

  it("rejects a template with validation errors (caller must fall back)", () => {
    // Q3: no silent zone — fatal per contract §5.
    const broken = validTemplate();
    const objects = broken.objects as Array<Record<string, unknown>>;
    objects[0] = { ...objects[0], kind: "discussion" };
    const r = resolveJoinTemplate(broken, "/templates/library.json");
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects a template with no spawn points", () => {
    const broken = validTemplate();
    broken.spawn_points = [];
    const r = resolveJoinTemplate(broken, "/templates/library.json");
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects garbage input without throwing", () => {
    for (const raw of [null, undefined, 42, "junk", {}, []]) {
      const r = resolveJoinTemplate(raw, "/templates/x.json");
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("template selection persistence", () => {
  const store = new Map<string, string>();
  const origLocalStorage = (globalThis as Record<string, unknown>).localStorage;
  const origFetch = (globalThis as Record<string, unknown>).fetch;

  function stubLocalStorage() {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
  }

  afterEach(() => {
    store.clear();
    (globalThis as Record<string, unknown>).localStorage = origLocalStorage;
    (globalThis as Record<string, unknown>).fetch = origFetch;
  });

  it("round-trips the selection under the global key", () => {
    stubLocalStorage();
    expect(TEMPLATE_STORAGE_KEY).toBe("syncle.template");
    expect(loadSelectedTemplateId()).toBeNull();
    saveSelectedTemplateId("welcome");
    expect(store.get(TEMPLATE_STORAGE_KEY)).toBe("welcome");
    expect(loadSelectedTemplateId()).toBe("welcome");
    saveSelectedTemplateId(null);
    expect(store.has(TEMPLATE_STORAGE_KEY)).toBe(false);
    expect(loadSelectedTemplateId()).toBeNull();
  });

  it("never throws when localStorage is unavailable (private mode)", () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    expect(() => saveSelectedTemplateId("welcome")).not.toThrow();
    expect(loadSelectedTemplateId()).toBeNull();
  });

  it("fetchRegistry resolves null on non-200 without throwing", async () => {
    (globalThis as Record<string, unknown>).fetch = async () => ({ ok: false, status: 404 });
    await expect(fetchRegistry()).resolves.toBeNull();
  });

  it("fetchRegistry resolves null on network failure without throwing", async () => {
    (globalThis as Record<string, unknown>).fetch = async () => {
      throw new Error("boom");
    };
    await expect(fetchRegistry()).resolves.toBeNull();
  });

  it("fetchRegistry parses a good registry", async () => {
    (globalThis as Record<string, unknown>).fetch = async () => ({
      ok: true,
      json: async () => ({ templates: [registryEntry()] }),
    });
    const list = await fetchRegistry();
    expect(list).toHaveLength(1);
    expect(list![0].id).toBe("welcome");
  });

  it("fetchRegistry resolves null on a malformed document", async () => {
    (globalThis as Record<string, unknown>).fetch = async () => ({
      ok: true,
      json: async () => ({ nope: true }),
    });
    await expect(fetchRegistry()).resolves.toBeNull();
  });
});
