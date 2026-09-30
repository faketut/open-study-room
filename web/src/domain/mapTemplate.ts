// P1-A map template validator (contracts.md "Map templates").
//
// Pure JSON-level checks over a template file (RawMapConfig-shaped plus a
// top-level `template` metadata block and `spawn_points`). No DOM, no fetch,
// no renderer — safe to run in tests, in the JoinScreen load flow, and in CI.
//
// API: validateTemplate(raw) -> { errors, warnings }.
//   errors   — blocking; empty means the template is legal.
//   warnings — non-blocking authoring nudges (sprite refs, thumbnail shape,
//              table density). The JoinScreen flow treats any error as fatal
//              and falls back to the default map.

import { SOLID_TYPES } from "./mapConfig";
import type { MapObjectType } from "../types/mapConfig";

/** Result of validating one template file. */
export interface TemplateValidation {
  /** Blocking problems. Empty ⇔ the template is legal. */
  errors: string[];
  /** Non-blocking authoring nudges. */
  warnings: string[];
}

/** Template ids are kebab-case and double as file names (`<id>.json`). */
const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Object types a template may author. Mirrors the `MapObjectType` union in
 *  `types/mapConfig.ts` — keep in sync when that union grows. */
const KNOWN_OBJECT_TYPES: ReadonlySet<string> = new Set([
  "wall",
  "table",
  "desk",
  "plant",
  "cabinet",
  "chair",
  "door",
  "rug",
  "note",
  "zone",
  "portal",
  "board",
]);

/** Zone kinds a template may author. `none` is domain-level (avatars outside
 *  every zone) and is never authored. Templates do NOT inherit the legacy
 *  kind-missing → discussion default: `kind` is required on every zone. */
const AUTHORED_ZONE_KINDS: ReadonlySet<string> = new Set([
  "silent",
  "discussion",
  "rest",
]);

/** Dead-zone detection samples walkability on this grid (contracts.md Q4). */
const COVERAGE_GRID_PX = 40;
/** How many unzoned sample coordinates to include in the Q4 error. */
const MAX_UNZONED_SAMPLES = 8;
/** Q10: warn when the floor area per table drops below this (overcrowded). */
const MIN_AREA_PER_TABLE_PX2 = 20_000;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ObjectEntry {
  index: number;
  type: string;
  rect: Rect | null;
  id?: string;
  kind?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Validate a rect-like value; returns the rect or null (error recorded). */
function checkRect(
  v: Record<string, unknown>,
  label: string,
  errors: string[],
): Rect | null {
  const { x, y, width, height } = v;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    errors.push(
      `${label}: x/y/width/height must all be finite numbers`,
    );
    return null;
  }
  if (width <= 0 || height <= 0) {
    errors.push(
      `${label}: width and height must be > 0 (got ${width}x${height})`,
    );
    return null;
  }
  return { x, y, width, height };
}

/** AABB point test, edges inclusive. */
function pointInRect(px: number, py: number, r: Rect): boolean {
  return (
    px >= r.x &&
    px <= r.x + r.width &&
    py >= r.y &&
    py <= r.y + r.height
  );
}

/** Strict AABB overlap: edge-touching counts as NOT overlapping. */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** `{ en, zh }` bilingual string map, both non-empty. */
function checkLangMap(
  v: unknown,
  label: string,
  errors: string[],
): void {
  if (!isRecord(v)) {
    errors.push(`${label}: required object with "en" and "zh" strings`);
    return;
  }
  for (const lang of ["en", "zh"] as const) {
    if (!nonEmptyString(v[lang])) {
      errors.push(`${label}.${lang}: required non-empty string`);
    }
  }
}

export function validateTemplate(raw: unknown): TemplateValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(raw)) {
    errors.push("template: root must be a JSON object");
    return { errors, warnings };
  }

  // ---- Q1: metadata block ----
  const meta = raw["template"];
  if (!isRecord(meta)) {
    errors.push('template: missing required "template" metadata block');
  } else {
    const id = meta["id"];
    if (!nonEmptyString(id)) {
      errors.push("template.id: required non-empty string");
    } else if (!KEBAB_CASE_RE.test(id)) {
      errors.push(
        `template.id: "${id}" must be kebab-case matching /^[a-z0-9]+(-[a-z0-9]+)*$/`,
      );
    }
    checkLangMap(meta["name"], "template.name", errors);
    checkLangMap(meta["description"], "template.description", errors);
    const thumbnail = meta["thumbnail"];
    if (thumbnail !== undefined) {
      if (!nonEmptyString(thumbnail)) {
        errors.push(
          'template.thumbnail: must be a non-empty string when present (omit it for the placeholder block)',
        );
      } else if (
        thumbnail.startsWith("/") ||
        /^[a-z][a-z0-9+.-]*:\/\//i.test(thumbnail)
      ) {
        warnings.push(
          `template.thumbnail: "${thumbnail}" looks absolute; prefer a path relative to /templates/`,
        );
      }
    }
  }

  // ---- Q2: map basics ----
  if (!nonEmptyString(raw["map_name"])) {
    errors.push("map.map_name: required non-empty string");
  }
  const width = raw["width"];
  const height = raw["height"];
  const widthOk = isFiniteNumber(width) && width > 0;
  const heightOk = isFiniteNumber(height) && height > 0;
  if (!widthOk) errors.push("map.width: required finite number > 0");
  if (!heightOk) errors.push("map.height: required finite number > 0");
  const hasBgColor = nonEmptyString(raw["background_color"]);
  const hasBgImage = nonEmptyString(raw["background_image"]);
  if (!hasBgColor && !hasBgImage) {
    errors.push(
      'map: either "background_color" or "background_image" is required',
    );
  }

  // ---- objects: per-object checks (Q7 + type/kind/id rules) ----
  const objectsRaw = raw["objects"];
  const objects: ObjectEntry[] = [];
  if (!Array.isArray(objectsRaw)) {
    errors.push("map.objects: required array of typed entities");
  } else {
    objectsRaw.forEach((o: unknown, i: number) => {
      const label = `objects[${i}]`;
      if (!isRecord(o)) {
        errors.push(`${label}: must be an object`);
        return;
      }
      const type = o["type"];
      if (!nonEmptyString(type) || !KNOWN_OBJECT_TYPES.has(type)) {
        errors.push(
          `${label}: unknown type ${JSON.stringify(type)}; must be one of ${[...KNOWN_OBJECT_TYPES].join(", ")}`,
        );
      }
      const rect = checkRect(o, label, errors);
      const entry: ObjectEntry = {
        index: i,
        type: nonEmptyString(type) ? type : "?",
        rect,
      };
      if (type === "zone") {
        const kind = o["kind"];
        if (!nonEmptyString(kind) || !AUTHORED_ZONE_KINDS.has(kind)) {
          errors.push(
            `${label}: zone "kind" is required and must be one of silent|discussion|rest ` +
              `(got ${JSON.stringify(kind)}; templates do not inherit the legacy discussion default)`,
          );
        } else {
          entry.kind = kind;
        }
      }
      if (type === "table" || type === "desk") {
        if (!nonEmptyString(o["id"])) {
          errors.push(`${label}: table/desk objects require a non-empty "id"`);
        } else {
          entry.id = o["id"];
        }
      }
      const sprite = o["sprite"];
      if (sprite !== undefined) {
        if (!nonEmptyString(sprite)) {
          errors.push(`${label}: "sprite" must be a non-empty string when present`);
        } else {
          // Q8: the JSON cannot prove catalog membership; nudge the author.
          warnings.push(
            `${label}: references sprite "${sprite}" — verify the key exists in web/src/ui/spriteAtlas.ts SPRITES`,
          );
        }
      }
      objects.push(entry);
    });
  }

  const zones = objects.filter((e) => e.type === "zone" && e.rect !== null);
  const solids: Array<{ type: string; rect: Rect }> = objects
    .filter((e) => SOLID_TYPES.has(e.type as MapObjectType) && e.rect !== null)
    .map((e) => ({ type: e.type, rect: e.rect as Rect }));

  // ---- Q3: zone presence + a silent main area ----
  if (zones.length === 0) {
    errors.push("zones: template must define at least one zone object");
  } else if (!zones.some((z) => z.kind === "silent")) {
    errors.push(
      'zones: at least one zone with kind "silent" is required (study-room quiet main area)',
    );
  }

  // ---- Q4: no dead zones (walkable grid coverage) ----
  if (widthOk && heightOk) {
    const w = width as number;
    const h = height as number;
    const unzoned: string[] = [];
    for (let cy = COVERAGE_GRID_PX / 2; cy < h; cy += COVERAGE_GRID_PX) {
      for (let cx = COVERAGE_GRID_PX / 2; cx < w; cx += COVERAGE_GRID_PX) {
        if (solids.some((s) => pointInRect(cx, cy, s.rect))) continue;
        if (!zones.some((z) => pointInRect(cx, cy, z.rect as Rect))) {
          unzoned.push(`(${cx},${cy})`);
        }
      }
    }
    if (unzoned.length > 0) {
      errors.push(
        `zones: ${unzoned.length} walkable sample point(s) are not inside any zone ` +
          `(dead zones), e.g. ${unzoned.slice(0, MAX_UNZONED_SAMPLES).join(", ")}`,
      );
    }
  }

  // ---- Q5: spawn points ----
  const spawns = raw["spawn_points"];
  if (!Array.isArray(spawns) || spawns.length === 0) {
    errors.push("map.spawn_points: required non-empty array of { x, y }");
  } else {
    spawns.forEach((s: unknown, i: number) => {
      const label = `spawn_points[${i}]`;
      if (!isRecord(s)) {
        errors.push(`${label}: must be an object with x/y`);
        return;
      }
      const { x, y } = s;
      if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
        errors.push(`${label}: x and y must be finite numbers`);
        return;
      }
      if (
        widthOk &&
        heightOk &&
        (x < 0 || x > (width as number) || y < 0 || y > (height as number))
      ) {
        errors.push(
          `${label}: (${x},${y}) is outside the map bounds [0,${width}]x[0,${height}]`,
        );
      }
      const hit = solids.find((sd) => pointInRect(x, y, sd.rect));
      if (hit) {
        errors.push(
          `${label}: (${x},${y}) is inside a solid "${hit.type}" object — spawn must be walkable`,
        );
      }
    });
  }

  // ---- Q6: tables — ids unique, AABBs non-overlapping ----
  const tables: Array<{ id: string; rect: Rect | null; label: string }> = [];
  for (const e of objects) {
    if ((e.type === "table" || e.type === "desk") && e.id !== undefined) {
      tables.push({ id: e.id, rect: e.rect, label: `objects[${e.index}]` });
    }
  }
  const topTables = raw["tables"];
  if (topTables !== undefined) {
    if (!Array.isArray(topTables)) {
      errors.push("map.tables: must be an array when present");
    } else {
      topTables.forEach((t: unknown, i: number) => {
        const label = `tables[${i}]`;
        if (!isRecord(t)) {
          errors.push(`${label}: must be an object`);
          return;
        }
        if (!nonEmptyString(t["id"])) {
          errors.push(`${label}: table objects require a non-empty "id"`);
          return;
        }
        tables.push({
          id: t["id"],
          rect: checkRect(t, label, errors),
          label,
        });
      });
    }
  }
  const seenIds = new Map<string, string>();
  for (const t of tables) {
    const prev = seenIds.get(t.id);
    if (prev !== undefined) {
      errors.push(
        `tables: duplicate id "${t.id}" (${prev} and ${t.label})`,
      );
    } else {
      seenIds.set(t.id, t.label);
    }
  }
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tables[i];
      const b = tables[j];
      if (a.rect && b.rect && rectsOverlap(a.rect, b.rect)) {
        errors.push(
          `tables: "${a.id}" (${a.label}) overlaps "${b.id}" (${b.label})`,
        );
      }
    }
  }

  // ---- Q10: table density nudges (warnings only) ----
  if (tables.length === 0) {
    warnings.push(
      "tables: template defines no tables; a study-room template usually has at least one",
    );
  } else if (widthOk && heightOk) {
    const perTable =
      ((width as number) * (height as number)) / tables.length;
    if (perTable < MIN_AREA_PER_TABLE_PX2) {
      warnings.push(
        `tables: floor area per table is ${Math.round(perTable)} px² ` +
          `(< ${MIN_AREA_PER_TABLE_PX2}); the map may feel overcrowded`,
      );
    }
  }

  return { errors, warnings };
}
