import { describe, expect, it } from "vitest";
import {
  bucketByZone,
  findZoneAt,
  normalizeZoneKind,
  zoneAllowsAudio,
  zoneKindAt,
  zonesOf,
} from "../zones";
import type { MapConfig, MapObject } from "../../types/mapConfig";

function makeMap(objects: MapObject[]): MapConfig {
  return {
    name: "test",
    backgroundImage: null,
    backgroundColor: "#000",
    walkable: [],
    tables: [],
    objects,
    tilegrid: null,
    tileVisual: false,
    bounds: { x: 0, y: 0, width: 1000, height: 1000 },
  };
}

const lounge: MapObject = {
  type: "zone",
  id: "lounge",
  label: "Lounge",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
};

const eng: MapObject = {
  type: "zone",
  id: "eng",
  label: "Engineering",
  x: 200,
  y: 0,
  width: 100,
  height: 100,
};

const overlap: MapObject = {
  type: "zone",
  id: "overlap",
  label: "Overlap",
  x: 50,
  y: 50,
  width: 100,
  height: 100,
};

describe("zonesOf", () => {
  it("extracts only zone-typed objects with labels and ids", () => {
    const map = makeMap([
      { type: "wall", x: 0, y: 0, width: 10, height: 10 },
      lounge,
      eng,
    ]);
    const zones = zonesOf(map);
    expect(zones.map((z) => z.key)).toEqual(["lounge", "eng"]);
    expect(zones[0].label).toBe("Lounge");
  });

  it("falls back to a synthetic label when none is provided", () => {
    const map = makeMap([{ type: "zone", x: 0, y: 0, width: 1, height: 1 }]);
    expect(zonesOf(map)[0].label).toBe("Zone 1");
  });
});

describe("findZoneAt", () => {
  it("returns the zone containing the point", () => {
    const map = makeMap([lounge, eng]);
    expect(findZoneAt(50, 50, map)?.key).toBe("lounge");
    expect(findZoneAt(250, 50, map)?.key).toBe("eng");
    expect(findZoneAt(150, 150, map)).toBeNull();
  });

  it("last-defined zone wins on overlap (matches draw order)", () => {
    const map = makeMap([lounge, overlap]);
    expect(findZoneAt(75, 75, map)?.key).toBe("overlap");
  });
});

describe("bucketByZone", () => {
  const avatars = [
    { identity: "a", name: "Alice", color: "#f00", x: 10, y: 10 }, // lounge
    { identity: "b", name: "Bob", color: "#0f0", x: 250, y: 50 }, // eng
    { identity: "c", name: "Cara", color: "#00f", x: 500, y: 500 }, // nowhere
    { identity: "d", name: "Dan", color: "#ff0", x: 99, y: 99 }, // lounge edge
  ];

  it("buckets avatars by their containing zone", () => {
    const map = makeMap([lounge, eng]);
    const buckets = bucketByZone(map, avatars);
    expect(buckets.get("lounge")!.map((o) => o.identity)).toEqual(["a", "d"]);
    expect(buckets.get("eng")!.map((o) => o.identity)).toEqual(["b"]);
  });

  it("returns an empty Map when there are no zones", () => {
    const map = makeMap([{ type: "wall", x: 0, y: 0, width: 10, height: 10 }]);
    const buckets = bucketByZone(map, avatars);
    expect(buckets.size).toBe(0);
  });

  it("each avatar lands in at most one bucket even on overlap", () => {
    const map = makeMap([lounge, overlap]);
    const buckets = bucketByZone(map, [
      { identity: "x", name: "X", color: "#fff", x: 75, y: 75 },
    ]);
    expect(buckets.get("overlap")!.length).toBe(1);
    expect(buckets.get("lounge")!.length).toBe(0);
  });
});

describe("normalizeZoneKind", () => {
  it("keeps authored kinds", () => {
    expect(normalizeZoneKind("silent")).toBe("silent");
    expect(normalizeZoneKind("discussion")).toBe("discussion");
    expect(normalizeZoneKind("rest")).toBe("rest");
  });

  it("defaults missing kinds to discussion (backward compat)", () => {
    expect(normalizeZoneKind(undefined)).toBe("discussion");
    expect(normalizeZoneKind(null)).toBe("discussion");
    expect(normalizeZoneKind("")).toBe("discussion");
  });

  it("defaults invalid kinds to discussion", () => {
    expect(normalizeZoneKind("meeting")).toBe("discussion");
    expect(normalizeZoneKind("SILENT")).toBe("discussion");
    expect(normalizeZoneKind(42)).toBe("discussion");
    // "none" is domain-level (outside every zone), never authored.
    expect(normalizeZoneKind("none")).toBe("discussion");
  });
});

describe("zonesOf kind parsing", () => {
  it("carries the authored kind onto the Zone", () => {
    const map = makeMap([
      { type: "zone", id: "s", x: 0, y: 0, width: 10, height: 10, kind: "silent" },
    ]);
    expect(zonesOf(map)[0].kind).toBe("silent");
  });

  it("defaults a missing kind to discussion (old maps)", () => {
    const map = makeMap([{ type: "zone", id: "o", x: 0, y: 0, width: 10, height: 10 }]);
    expect(zonesOf(map)[0].kind).toBe("discussion");
  });
});

describe("zoneAllowsAudio", () => {
  it.each([
    ["silent", false],
    ["discussion", true],
    ["rest", true],
    ["none", true],
  ] as const)("kind=%s allows audio: %s", (kind, expected) => {
    expect(zoneAllowsAudio(kind)).toBe(expected);
  });
});

describe("zoneKindAt", () => {
  const silentZone: MapObject = {
    type: "zone",
    id: "silent-zone",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    kind: "silent",
  };
  const restZone: MapObject = {
    type: "zone",
    id: "rest-zone",
    x: 200,
    y: 0,
    width: 100,
    height: 100,
    kind: "rest",
  };

  it("returns the kind of the containing zone", () => {
    const zones = zonesOf(makeMap([silentZone, restZone]));
    expect(zoneKindAt(zones, 50, 50)).toBe("silent");
    expect(zoneKindAt(zones, 250, 50)).toBe("rest");
  });

  it('returns "none" outside every zone', () => {
    const zones = zonesOf(makeMap([silentZone, restZone]));
    expect(zoneKindAt(zones, 150, 150)).toBe("none");
  });

  it("treats boundary edges as inside", () => {
    const zones = zonesOf(makeMap([silentZone]));
    // x=100 is the right edge of the rect; y=100 the bottom edge.
    expect(zoneKindAt(zones, 100, 100)).toBe("silent");
    expect(zoneKindAt(zones, 0, 0)).toBe("silent");
    // Just past the edge is outside.
    expect(zoneKindAt(zones, 100.5, 50)).toBe("none");
  });

  it("last-defined zone wins on overlap (matches findZoneAt)", () => {
    const zones = zonesOf(makeMap([silentZone, overlap]));
    expect(zoneKindAt(zones, 75, 75)).toBe(
      normalizeZoneKind(overlap.kind),
    );
  });

  it("returns none for an empty zone list", () => {
    expect(zoneKindAt([], 10, 10)).toBe("none");
  });

  it("agrees with findZoneAt on the winning zone", () => {
    const map = makeMap([silentZone, restZone, overlap]);
    const zones = zonesOf(map);
    for (const [x, y] of [
      [10, 10],
      [210, 10],
      [75, 75],
      [500, 500],
    ] as const) {
      const found = findZoneAt(x, y, map);
      expect(zoneKindAt(zones, x, y)).toBe(found ? found.kind : "none");
    }
  });
});
