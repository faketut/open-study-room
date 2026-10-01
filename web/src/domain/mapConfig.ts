import type {
  MapConfig,
  MapObject,
  MapObjectType,
  RawMapConfig,
  Rect,
  Table,
} from "../types/mapConfig";
import { normalizeZoneKind } from "./zones";
import { CUSTOM_MAP_STORAGE_KEY, CUSTOM_MAP_URL } from "./mapAuthoring";

// Object types that block avatar movement. Anything not in this set is
// purely decorative (rug, door opening, etc.) and does not contribute to
// collision.
export const SOLID_TYPES: ReadonlySet<MapObjectType> = new Set<MapObjectType>([
  "wall",
  "table",
  "desk",
  "plant",
  "cabinet",
]);

export async function loadMapConfig(url: string): Promise<MapConfig> {
  let raw: RawMapConfig;
  if (url === CUSTOM_MAP_URL) {
    const s = localStorage.getItem(CUSTOM_MAP_STORAGE_KEY);
    if (!s) throw new Error("No custom map saved");
    raw = JSON.parse(s) as RawMapConfig;
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`map_config fetch failed: ${res.status}`);
    raw = (await res.json()) as RawMapConfig;
  }

  const walkable: Rect[] = (raw.walkable_areas ?? []).map((r) => ({
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  }));

  const objects: MapObject[] = (raw.objects ?? []).map((o) => ({
    id: o.id,
    type: o.type,
    label: o.label,
    color: o.color,
    // Zone acoustic policy (contracts.md "Zones (M1)"). Old maps were
    // authored without `kind` — normalizeZoneKind defaults those to
    // "discussion", preserving pre-M1 unrestricted-audio behavior.
    kind: normalizeZoneKind(o.kind),
    text: o.text,
    destination: o.destination,
    repo: o.repo,
    elevation: o.elevation,
    sprite: o.sprite,
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
  }));

  // Tables can be authored either as the top-level `tables` array (legacy) or
  // as objects with type === "table" (procedural). Surface both in `tables`
  // for the table-join logic.
  const explicitTables: Table[] = (raw.tables ?? []).map((t) => ({
    id: t.id,
    x: t.x,
    y: t.y,
    width: t.width,
    height: t.height,
  }));
  const objectTables: Table[] = objects
    .filter((o): o is MapObject & { id: string } => o.type === "table" && !!o.id)
    .map((o) => ({
      id: o.id,
      label: o.label,
      x: o.x,
      y: o.y,
      width: o.width,
      height: o.height,
    }));
  const tables = [...explicitTables, ...objectTables];

  // Bounds priority: explicit width/height > walkable bounds > object bounds.
  let bounds: MapConfig["bounds"];
  if (typeof raw.width === "number" && typeof raw.height === "number") {
    bounds = { x: 0, y: 0, width: raw.width, height: raw.height };
  } else if (walkable.length > 0) {
    bounds = computeBounds(walkable);
  } else {
    bounds = computeBounds(objects);
  }

  return {
    name: raw.map_name,
    backgroundImage: raw.background_image && raw.background_image.length > 0
      ? raw.background_image
      : null,
    backgroundColor: raw.background_color ?? "#2a313c",
    walkable,
    tables,
    objects,
    bounds,
  };
}

function computeBounds(rects: Rect[]): MapConfig["bounds"] {
  if (rects.length === 0) return { x: 0, y: 0, width: 1000, height: 1000 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Circle-vs-AABB: true iff the closest point on `rect` to the circle center
// is strictly inside the circle. Cheap and exact for axis-aligned colliders.
function circleHitsRect(
  cx: number,
  cy: number,
  r: number,
  rect: Rect,
): boolean {
  const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.width));
  const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.height));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy < r * r;
}

// Movement gate. Two modes, picked by what the map authored:
//
//   (procedural)  has any object   → avatar circle must be inside the map
//                                    bounds AND not collide with any solid
//                                    object (walls, tables, plants, ...).
//   (legacy)      no objects       → avatar circle must fit entirely inside
//                                    at least one walkable rect.
//
// The legacy branch matches AvatarState.tryMoveTo on Android so the two
// clients still feel identical on the painted room1 map.
export function isWalkable(
  x: number,
  y: number,
  radius: number,
  config: MapConfig,
): boolean {
  if (config.objects.length > 0) {
    const b = config.bounds;
    if (x - radius < b.x || x + radius > b.x + b.width) return false;
    if (y - radius < b.y || y + radius > b.y + b.height) return false;
    for (const obj of config.objects) {
      if (!SOLID_TYPES.has(obj.type)) continue;
      if (circleHitsRect(x, y, radius, obj)) return false;
    }
    return true;
  }

  for (const r of config.walkable) {
    if (
      x - radius >= r.x &&
      x + radius <= r.x + r.width &&
      y - radius >= r.y &&
      y + radius <= r.y + r.height
    ) {
      return true;
    }
  }
  return false;
}

// Sliding move: try full delta, then X-only, then Y-only. Same priority order
// as AvatarState.move(...) so the two clients feel identical along walls.
export function applyMove(
  pos: { x: number; y: number },
  delta: { x: number; y: number },
  radius: number,
  config: MapConfig,
): { x: number; y: number } {
  const cand = { x: pos.x + delta.x, y: pos.y + delta.y };
  if (isWalkable(cand.x, cand.y, radius, config)) return cand;
  if (delta.x !== 0) {
    const xOnly = { x: pos.x + delta.x, y: pos.y };
    if (isWalkable(xOnly.x, xOnly.y, radius, config)) return xOnly;
  }
  if (delta.y !== 0) {
    const yOnly = { x: pos.x, y: pos.y + delta.y };
    if (isWalkable(yOnly.x, yOnly.y, radius, config)) return yOnly;
  }
  return pos;
}

/**
 * Returns the table whose edge is closest to (x, y) within `maxDistance` (in
 * world units), or null. Distance is from the point to the table AABB, so a
 * point inside the table returns distance 0. Used by SyncleScreen to decide
 * which table to highlight as "press E to join".
 */
export function findNearestTable(
  x: number,
  y: number,
  config: MapConfig,
  maxDistance: number,
): { id: string; distance: number } | null {
  let best: { id: string; distance: number } | null = null;
  for (const t of config.tables) {
    const cx = Math.max(t.x, Math.min(x, t.x + t.width));
    const cy = Math.max(t.y, Math.min(y, t.y + t.height));
    const d = Math.hypot(x - cx, y - cy);
    if (d > maxDistance) continue;
    if (!best || d < best.distance) best = { id: t.id, distance: d };
  }
  return best;
}

/** Closest note to the point within `maxDistance`. Returns the index into
 *  `config.objects` (notes don't require stable ids) so callers can pull
 *  text/label off the underlying object. */
export function findNearestNote(
  x: number,
  y: number,
  config: MapConfig,
  maxDistance: number,
): { index: number; distance: number } | null {
  let best: { index: number; distance: number } | null = null;
  for (let i = 0; i < config.objects.length; i++) {
    const o = config.objects[i];
    if (o.type !== "note") continue;
    const cx = Math.max(o.x, Math.min(x, o.x + o.width));
    const cy = Math.max(o.y, Math.min(y, o.y + o.height));
    const d = Math.hypot(x - cx, y - cy);
    if (d > maxDistance) continue;
    if (!best || d < best.distance) best = { index: i, distance: d };
  }
  return best;
}

/** Find a portal whose AABB the point (x,y) falls inside. Returns the
 *  matching `MapObject` (with `type === "portal"` and a `destination`) or
 *  null. Used by SyncleScreen to teleport on enter. */
export function findPortalAt(
  x: number,
  y: number,
  config: MapConfig,
): MapObject | null {
  for (const o of config.objects) {
    if (o.type !== "portal" || !o.destination) continue;
    if (
      x >= o.x &&
      x <= o.x + o.width &&
      y >= o.y &&
      y <= o.y + o.height
    ) {
      return o;
    }
  }
  return null;
}

/** Closest board to the point within `maxDistance`. Mirrors `findNearestNote`
 *  but filters on `type === "board"`. Used so SyncleScreen can route F to the
 *  closest interactive object (note OR board). */
export function findNearestBoard(
  x: number,
  y: number,
  config: MapConfig,
  maxDistance: number,
): { index: number; distance: number } | null {
  let best: { index: number; distance: number } | null = null;
  for (let i = 0; i < config.objects.length; i++) {
    const o = config.objects[i];
    if (o.type !== "board") continue;
    const cx = Math.max(o.x, Math.min(x, o.x + o.width));
    const cy = Math.max(o.y, Math.min(y, o.y + o.height));
    const d = Math.hypot(x - cx, y - cy);
    if (d > maxDistance) continue;
    if (!best || d < best.distance) best = { index: i, distance: d };
  }
  return best;
}
