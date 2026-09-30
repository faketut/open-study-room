import { describe, expect, it } from "vitest";
import {
  chairTableId,
  chairsForTable,
  findChairAt,
  isTableFull,
  isZoneFull,
  tableCapacity,
  tableOccupancy,
  tablesWithFreeSeats,
  CHAIR_HIT_PADDING,
} from "../seating";
import type { MapConfig, MapObject, Table } from "../../types/mapConfig";

function table(id: string, x: number, y: number, w = 48, h = 32): Table {
  return { id, x, y, width: w, height: h };
}
function chair(x: number, y: number): MapObject {
  return { type: "chair", x, y, width: 16, height: 16 };
}
function zone(kind: string, x: number, y: number, w: number, h: number): MapObject {
  return { type: "zone", kind: kind as never, x, y, width: w, height: h };
}

function testMap(): MapConfig {
  const tables = [table("t1", 100, 100), table("t2", 300, 100)];
  const objects: MapObject[] = [
    ...tables.map((t) => ({ ...t, type: "table" as const, label: t.id })),
    chair(108, 76), chair(124, 76), // t1 north
    chair(108, 140), // t1 south
    chair(308, 76), // t2 north
    zone("silent", 0, 0, 500, 300),
  ];
  return {
    name: "test",
    backgroundImage: null,
    backgroundColor: "#000",
    walkable: [],
    tables,
    objects,
    bounds: { x: 0, y: 0, width: 880, height: 640 },
  };
}

describe("chairTableId", () => {
  it("assigns each chair to its nearest table", () => {
    const m = testMap();
    const chairs = m.objects.filter((o) => o.type === "chair");
    expect(chairTableId(chairs[0], m.tables)).toBe("t1");
    expect(chairTableId(chairs[3], m.tables)).toBe("t2");
  });

  it("returns null when there are no tables", () => {
    expect(chairTableId(chair(0, 0), [])).toBeNull();
  });
});

describe("capacity and occupancy", () => {
  it("capacity = chairs assigned to the table", () => {
    const m = testMap();
    expect(tableCapacity(m, "t1")).toBe(3);
    expect(tableCapacity(m, "t2")).toBe(1);
  });

  it("occupancy counts self + peers", () => {
    expect(tableOccupancy("t1", "t1", ["t2", "t1", null])).toBe(2);
    expect(tableOccupancy("t1", null, [null])).toBe(0);
  });

  it("detects a full table", () => {
    const m = testMap();
    // t2 has capacity 1; one peer seated → full.
    expect(isTableFull(m, "t2", null, ["t2"])).toBe(true);
    expect(isTableFull(m, "t2", null, [])).toBe(false);
    // t1 capacity 3; self + 2 peers → full.
    expect(isTableFull(m, "t1", "t1", ["t1", "t1"])).toBe(true);
    expect(isTableFull(m, "t1", "t1", ["t1"])).toBe(false);
  });
});

describe("isZoneFull", () => {
  it("is true only when every table in the zone is full", () => {
    const m = testMap();
    // t1 (cap 3) full, t2 (cap 1) empty → zone not full.
    expect(isZoneFull(m, "silent", "t1", ["t1", "t1"])).toBe(false);
    // Both full → zone full.
    expect(isZoneFull(m, "silent", "t1", ["t1", "t1", "t2"])).toBe(true);
  });

  it("returns false when the zone kind has no tables", () => {
    expect(isZoneFull(testMap(), "discussion", null, [])).toBe(false);
  });
});

describe("findChairAt", () => {
  it("hit-tests chairs with padding", () => {
    const m = testMap();
    const hit = findChairAt(m, 116, 84);
    expect(hit?.type).toBe("chair");
    // Just outside the padded box → miss.
    const edge = 108 - CHAIR_HIT_PADDING - 1;
    expect(findChairAt(m, edge, 84)).toBeNull();
  });

  it("returns null on empty floor", () => {
    expect(findChairAt(testMap(), 500, 500)).toBeNull();
  });
});

describe("tablesWithFreeSeats", () => {
  it("lists non-full tables in the zone", () => {
    const m = testMap();
    const peerIds = ["t2"]; // t2 full, t1 has room
    const free = tablesWithFreeSeats(m, "silent", null, peerIds);
    expect(free.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("chairsForTable", () => {
  it("groups chairs by assignment", () => {
    const m = testMap();
    const chairs = m.objects.filter((o) => o.type === "chair");
    expect(chairsForTable(chairs, "t1", m.tables).length).toBe(3);
    expect(chairsForTable(chairs, "t2", m.tables).length).toBe(1);
  });
});
