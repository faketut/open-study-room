// P1-A template picker support (contracts.md "Map templates" §4).
//
// Thin glue between the JoinScreen and the frozen pieces:
//   - registry fetch  (`assets/templates/registry.json`, synced to
//     `/templates/registry.json` by web/scripts/sync-assets.mjs)
//   - `validateTemplate` (domain/mapTemplate.ts, contract §5)
//   - `loadMapConfig`    (domain/mapConfig.ts — template files are
//     RawMapConfig-shaped plus unknown top-level keys, which the loader
//     ignores)
//
// Everything fetch/DOM-free here is pure and unit-tested (see
// __tests__/templateRegistry.test.ts). The JoinScreen keeps the network +
// React parts minimal and delegates all decisions to this module.

import { validateTemplate } from "./mapTemplate";

/** Bilingual template metadata (contract §2). */
export interface LocalizedText {
  en: string;
  zh: string;
}

/** One entry of assets/templates/registry.json (contract §4.2). */
export interface RegistryTemplateEntry {
  id: string;
  name: LocalizedText;
  description: LocalizedText;
  /** Optional; relative path inside /templates/ (contract §2). */
  thumbnail?: string;
  /** Frozen as `/templates/<id>.json` (contract §4.2). */
  url: string;
}

/** Served by web/scripts/sync-assets.mjs on predev/prebuild. */
export const REGISTRY_URL = "/templates/registry.json";

/** localStorage key for the user's selected template id.
//
// Chosen as a GLOBAL (not per-room) key: the map is a personal preference
// that travels with the user across rooms, mirroring how `syncle.charIndex`
// and `syncle.theme` are stored globally in syncleStore. */
export const TEMPLATE_STORAGE_KEY = "syncle.template";

/**
 * Deterministic placeholder hue for a template id (contract §2: the picker
 * renders a placeholder color block when `thumbnail` is missing, never a
 * broken <img>).
 *
 * FNV-1a 32-bit over the id, folded into [0, 360). Pure: same id always
 * yields the same hue on every client and every run.
 */
export function templatePlaceholderHue(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

export type UiLang = "en" | "zh";

/** Maps a browser language tag to the template-metadata language. Pure so
 *  it is unit-testable; the component passes `navigator.language`. */
export function pickUiLang(tag: string | null | undefined): UiLang {
  return typeof tag === "string" && tag.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}

/** Localizes a bilingual metadata field, falling back to the other
 *  language when the preferred one is empty/missing. */
export function localizeText(
  v: LocalizedText | null | undefined,
  lang: UiLang,
): string {
  if (v == null) return "";
  const primary = lang === "zh" ? v.zh : v.en;
  if (typeof primary === "string" && primary.length > 0) return primary;
  const other = lang === "zh" ? v.en : v.zh;
  return typeof other === "string" ? other : "";
}

/** Absolute-vs-relative check for a thumbnail path (contract §5 Q9: absolute
 *  is a validator warning, still accepted). */
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolves a registry entry's thumbnail to a web URL, or null when the
 * entry has none (caller renders the placeholder block in that case).
 */
export function thumbnailUrl(entry: RegistryTemplateEntry): string | null {
  const t = entry.thumbnail;
  if (typeof t !== "string" || t.length === 0) return null;
  return t.startsWith("/") || ABSOLUTE_URL_RE.test(t) ? t : `/templates/${t}`;
}

function isLangMap(v: unknown): v is LocalizedText {
  return (
    v != null &&
    typeof v === "object" &&
    typeof (v as LocalizedText).en === "string" &&
    typeof (v as LocalizedText).zh === "string"
  );
}

/**
 * Parses the registry JSON into entries. Returns null when the document is
 * not registry-shaped (the JoinScreen treats that as "no templates" and
 * silently falls back to the default map dropdown). Malformed individual
 * entries are skipped rather than failing the whole list.
 */
export function parseRegistry(raw: unknown): RegistryTemplateEntry[] | null {
  if (raw == null || typeof raw !== "object") return null;
  const list = (raw as { templates?: unknown }).templates;
  if (!Array.isArray(list)) return null;
  const out: RegistryTemplateEntry[] = [];
  for (const item of list) {
    if (item == null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id.length === 0) continue;
    if (typeof o.url !== "string" || o.url.length === 0) continue;
    if (!isLangMap(o.name) || !isLangMap(o.description)) continue;
    out.push({
      id: o.id,
      name: o.name,
      description: o.description,
      ...(typeof o.thumbnail === "string" && o.thumbnail.length > 0
        ? { thumbnail: o.thumbnail }
        : {}),
      url: o.url,
    });
  }
  return out;
}

/**
 * Fetches the template registry. Never throws: any failure (missing file,
 * non-200, bad shape) resolves to null and the JoinScreen silently falls
 * back to the existing default map flow — a missing template pack must
 * never break joining (contract §4.3).
 */
export async function fetchRegistry(): Promise<RegistryTemplateEntry[] | null> {
  try {
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) return null;
    return parseRegistry(await res.json());
  } catch {
    return null;
  }
}

/** Loads the persisted template selection (TEMPLATE_STORAGE_KEY). */
export function loadSelectedTemplateId(): string | null {
  try {
    const v = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Persists (or clears, with null) the template selection. */
export function saveSelectedTemplateId(id: string | null): void {
  try {
    if (id == null || id.length === 0) {
      localStorage.removeItem(TEMPLATE_STORAGE_KEY);
    } else {
      localStorage.setItem(TEMPLATE_STORAGE_KEY, id);
    }
  } catch {
    // Private mode / full storage: selection just won't persist.
  }
}

/**
 * Picks the effective template for joining: the selected one when it is
 * still in the registry, else the first entry, else null (no templates →
 * caller uses the default map flow). Pure and unit-tested.
 */
export function pickSelectedTemplate(
  templates: RegistryTemplateEntry[] | null | undefined,
  selectedId: string | null | undefined,
): RegistryTemplateEntry | null {
  if (templates == null || templates.length === 0) return null;
  if (selectedId != null && selectedId.length > 0) {
    const found = templates.find((t) => t.id === selectedId);
    if (found) return found;
  }
  return templates[0];
}

export interface JoinTemplateResolution {
  /** True ⇔ the template is legal to join into (contract §5). */
  ok: boolean;
  /** URL to pass to loadMapConfig when ok. */
  url: string;
  /** spawn_points[0] when ok (contract §4.4). */
  spawn: { x: number; y: number };
  /** Validator errors when !ok (caller logs them and falls back). */
  errors: string[];
}

/**
 * Validates a fetched template file and resolves the join map. Pure except
 * for the caller-supplied JSON: runs the contract §5 `validateTemplate`
 * and extracts `spawn_points[0]` on success. Any validation error ⇒ ok:false
 * and the caller MUST fall back to the default map (never join into a
 * broken map).
 */
export function resolveJoinTemplate(
  raw: unknown,
  url: string,
): JoinTemplateResolution {
  const failed: JoinTemplateResolution = {
    ok: false,
    url,
    spawn: { x: 0, y: 0 },
    errors: [],
  };
  const validation = validateTemplate(raw);
  if (validation.errors.length > 0) {
    failed.errors = validation.errors;
    return failed;
  }
  // Validation (Q5) guarantees spawn_points[0] is finite and in-bounds;
  // re-check defensively so a validator/template drift can never produce
  // a NaN spawn that teleports the avatar nowhere.
  const pts = (raw as { spawn_points?: unknown } | null)?.spawn_points;
  const p0 = Array.isArray(pts) ? pts[0] : null;
  const x = (p0 as { x?: unknown } | null)?.x;
  const y = (p0 as { y?: unknown } | null)?.y;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
    failed.errors = [`${url}: spawn_points[0] missing or non-finite after validation passed`];
    return failed;
  }
  return { ok: true, url, spawn: { x, y }, errors: [] };
}
