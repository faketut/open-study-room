/**
 * Seating domain (contracts.md "Painted background" §4).
 *
 * Pure logic for click/tap-to-sit and the full-house policy. The client-side
 * seat source of truth is presence-based: occupancy = self + peers whose
 * `tableId` matches. v1 has no server arbitration (see the honest
 * limitation in contracts.md §5).
 */
import type { MapConfig, MapObject, Table } from "../types/mapConfig";

/** Click/tap slop around a chair hit-box (world units). */
export const CHAIR_HIT_PADDING = 6;

function rectDistSq(px: number, py: number, r: { x: number; y: number; width: number; height: number }): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.width));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.height));
  return dx * dx + dy * dy;
}

/** The table a chair belongs to: nearest table by AABB distance; ties break
 *  by table id order (stable). Returns null when the map has no tables. */
export function chairTableId(chair: MapObject, tables: Table[]): string | null {
  let best: Table | null = null;
  let bestD = Infinity;
  for (const t of tables) {
    const d = rectDistSq(
      chair.x + chair.width / 2, chair.y + chair.height / 2, t,
    );
    if (d < bestD || (d === bestD && best !== null && t.id < best.id)) {
      best = t;
      bestD = d;
    }
  }
  return best ? best.id : null;
}

/** All chairs assigned to a table. */
export function chairsForTable(chairs: MapObject[], tableId: string, tables: Table[]): MapObject[] {
  return chairs.filter((c) => chairTableId(c, tables) === tableId);
}

/** Table capacity = number of chairs assigned to it. */
export function tableCapacity(map: MapConfig, tableId: string): number {
  const chairs = map.objects.filter((o) => o.type === "chair");
  return chairsForTable(chairs, tableId, map.tables).length;
}

/** Presence-based occupancy: how many of (self + peers) sit at the table. */
export function tableOccupancy(
  tableId: string,
  selfTableId: string | null,
  peerTableIds: Iterable<string | null>,
): number {
  let n = selfTableId === tableId ? 1 : 0;
  for (const tid of peerTableIds) if (tid === tableId) n++;
  return n;
}

/** True when occupancy has reached capacity. */
export function isTableFull(
  map: MapConfig,
  tableId: string,
  selfTableId: string | null,
  peerTableIds: Iterable<string | null>,
): boolean {
  return tableOccupancy(tableId, selfTableId, peerTableIds) >= tableCapacity(map, tableId);
}

/** True when every table in `zoneKind` zones is full. Used for the
 *  reading-hall full-house trigger. */
export function isZoneFull(
  map: MapConfig,
  zoneKind: string,
  selfTableId: string | null,
  peerTableIds: Iterable<string | null>,
): boolean {
  const zoneRects = map.objects.filter((o) => o.type === "zone" && o.kind === zoneKind);
  if (zoneRects.length === 0) return false;
  const tablesInZone = map.tables.filter((t) =>
    zoneRects.some(
      (z) =>
        t.x + t.width / 2 >= z.x && t.x + t.width / 2 <= z.x + z.width &&
        t.y + t.height / 2 >= z.y && t.y + t.height / 2 <= z.y + z.height,
    ),
  );
  if (tablesInZone.length === 0) return false;
  return tablesInZone.every((t) => isTableFull(map, t.id, selfTableId, peerTableIds));
}

/** Hit-test a world point against chairs (with touch slop). Returns the
 *  chair object or null. */
export function findChairAt(map: MapConfig, wx: number, wy: number): MapObject | null {
  const p = CHAIR_HIT_PADDING;
  for (const o of map.objects) {
    if (o.type !== "chair") continue;
    if (
      wx >= o.x - p && wx <= o.x + o.width + p &&
      wy >= o.y - p && wy <= o.y + o.height + p
    ) {
      return o;
    }
  }
  return null;
}

/** Tables in `zoneKind` zones that currently have a free seat. Used for the
 *  lounge-overflow highlight. */
export function tablesWithFreeSeats(
  map: MapConfig,
  zoneKind: string,
  selfTableId: string | null,
  peerTableIds: Iterable<string | null>,
): Table[] {
  const zoneRects = map.objects.filter((o) => o.type === "zone" && o.kind === zoneKind);
  return map.tables.filter(
    (t) =>
      zoneRects.some(
        (z) =>
          t.x + t.width / 2 >= z.x && t.x + t.width / 2 <= z.x + z.width &&
          t.y + t.height / 2 >= z.y && t.y + t.height / 2 <= z.y + z.height,
      ) && !isTableFull(map, t.id, selfTableId, peerTableIds),
  );
}
