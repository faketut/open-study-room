// Zone occupancy + acoustic semantics (contracts.md "Zones (M1): quiet
// semantics"). Syncle is a virtual *study room*: quiet by default, and each
// zone carries a `kind` that overrides the table conversation behavior.
// Zone policy > table policy — sitting at a table inside a `silent` zone
// still forces mute.
//
// Used by the WhosWherePanel sidebar and the in-world zone label chip.

import type { MapConfig, MapObject, ZoneKind } from "../types/mapConfig";

/** Re-exported here so other modules import the zone contract surface from
 *  one place (`domain/zones`). */
export type { ZoneKind };

/** Sidebar/grouping label per kind. `none` only occurs for avatars outside
 *  every zone (e.g. the "Roaming" row), never for authored zones. */
export const ZONE_KIND_LABELS: Record<ZoneKind, string> = {
  silent: "自习区",
  discussion: "讨论区",
  rest: "休息区",
  none: "漫游",
};

/** Authored zone kinds — the values a map JSON or the editor may assign.
 *  `none` is domain-level (see `zoneKindAt`) and never authored. */
const AUTHORED_KINDS: ReadonlySet<string> = new Set([
  "silent",
  "discussion",
  "rest",
]);

/** Normalize a raw `kind` value into a `ZoneKind`. Missing or invalid kinds
 *  (old maps, hand-edited JSON) fall back to `"discussion"`, preserving the
 *  pre-M1 behavior where talking was unrestricted. */
export function normalizeZoneKind(value: unknown): ZoneKind {
  return AUTHORED_KINDS.has(value as string)
    ? (value as "silent" | "discussion" | "rest")
    : "discussion";
}

/** Per contracts.md: only `silent` zones forbid audio. `discussion`,
 *  `rest`, and `none` all allow it. */
export function zoneAllowsAudio(kind: ZoneKind): boolean {
  return kind !== "silent";
}

export interface Zone {
  /** Editor uid or generated id, used as React key. */
  key: string;
  label: string;
  /** Acoustic policy of this zone. */
  kind: ZoneKind;
  rect: { x: number; y: number; width: number; height: number };
}

export interface ZoneOccupant {
  identity: string;
  name: string;
  color: string;
}

export function zonesOf(map: MapConfig): Zone[] {
  const out: Zone[] = [];
  for (let i = 0; i < map.objects.length; i++) {
    const o = map.objects[i];
    if (o.type !== "zone") continue;
    out.push({
      key: o.id ?? `zone-${i}`,
      label: o.label && o.label.length > 0 ? o.label : `Zone ${i + 1}`,
      // Defensive default: the parser already normalizes, but hand-built
      // MapObjects (e.g. in tests) may omit kind.
      kind: normalizeZoneKind(o.kind),
      rect: { x: o.x, y: o.y, width: o.width, height: o.height },
    });
  }
  return out;
}

function pointInRect(
  px: number,
  py: number,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    px >= rect.x &&
    px <= rect.x + rect.width &&
    py >= rect.y &&
    py <= rect.y + rect.height
  );
}

/** Locate which zone the given point sits in. Returns the first match (zones
 *  rendered later in the objects array win on overlap, matching draw order). */
export function findZoneAt(
  x: number,
  y: number,
  map: MapConfig,
): Zone | null {
  const zones = zonesOf(map);
  for (let i = zones.length - 1; i >= 0; i--) {
    if (pointInRect(x, y, zones[i].rect)) return zones[i];
  }
  return null;
}

/** Acoustic kind of the zone containing (x, y). Last-defined zone wins on
 *  overlap (same draw-order rule as `findZoneAt`). Returns `"none"` when
 *  the point is inside no zone — treated as `discussion` per the contract. */
export function zoneKindAt(
  zones: ReadonlyArray<Zone>,
  x: number,
  y: number,
): ZoneKind {
  for (let i = zones.length - 1; i >= 0; i--) {
    if (pointInRect(x, y, zones[i].rect)) return zones[i].kind;
  }
  return "none";
}

export interface AvatarPoint {
  identity: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

/** Bucket avatars by zone. Avatars not inside any zone are dropped; if you
 *  need the unzoned count, compute `total - sum(map.values().length)`. */
export function bucketByZone(
  map: MapConfig,
  avatars: ReadonlyArray<AvatarPoint>,
): Map<string, ZoneOccupant[]> {
  const zones = zonesOf(map);
  const out = new Map<string, ZoneOccupant[]>();
  for (const z of zones) out.set(z.key, []);
  if (zones.length === 0) return out;
  for (const a of avatars) {
    // Match draw-order (last-wins) so overlapping zones don't double-count.
    for (let i = zones.length - 1; i >= 0; i--) {
      const z = zones[i];
      if (pointInRect(a.x, a.y, z.rect)) {
        out.get(z.key)!.push({
          identity: a.identity,
          name: a.name,
          color: a.color,
        });
        break;
      }
    }
  }
  return out;
}

/** Convenience: convert a zone MapObject back into a Zone (for the editor
 *  preview chip). */
export function zoneFromObject(obj: MapObject, key: string): Zone {
  return {
    key,
    label: obj.label && obj.label.length > 0 ? obj.label : "Zone",
    kind: normalizeZoneKind(obj.kind),
    rect: { x: obj.x, y: obj.y, width: obj.width, height: obj.height },
  };
}
