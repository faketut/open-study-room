import { describe, expect, it } from "vitest";
import { applyMove, findNearestBoard, findNearestNote, findNearestTable, findPortalAt, isWalkable } from "../mapConfig";
import type { MapConfig } from "../../types/mapConfig";

function proceduralMap(): MapConfig {
  // 200x200 floor with a single 40x40 wall at (80,80) and a 40x40 table at (140,80).
  return {
    name: "test",
    backgroundImage: null,
    backgroundColor: "#000",
    walkable: [],
    tables: [
      { id: "table-eng", x: 140, y: 80, width: 40, height: 40 },
    ],
    objects: [
      { type: "wall", x: 80, y: 80, width: 40, height: 40 },
      { id: "table-eng", type: "table", x: 140, y: 80, width: 40, height: 40 },
    ],
    bounds: { x: 0, y: 0, width: 200, height: 200 },
  };
}

function legacyMap(): MapConfig {
  // No objects → walkable-list mode. Two non-overlapping rooms.
  return {
    name: "legacy",
    backgroundImage: "room1.png",
    backgroundColor: "#000",
    walkable: [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 200, y: 0, width: 100, height: 100 },
    ],
    tables: [],
    objects: [],
    bounds: { x: 0, y: 0, width: 300, height: 100 },
  };
}

describe("isWalkable (procedural mode)", () => {
  const m = proceduralMap();

  it("allows movement inside bounds and away from obstacles", () => {
    expect(isWalkable(50, 50, 10, m)).toBe(true);
  });

  it("blocks movement when avatar circle overlaps a wall", () => {
    // wall is (80,80)-(120,120). center (75, 100) with r=10 just barely touches.
    expect(isWalkable(75, 100, 10, m)).toBe(false);
  });

  it("blocks movement when avatar circle overlaps a table", () => {
    expect(isWalkable(150, 100, 10, m)).toBe(false);
  });

  it("blocks movement when avatar would leave the map bounds", () => {
    expect(isWalkable(5, 100, 10, m)).toBe(false); // off the left edge
    expect(isWalkable(195, 100, 10, m)).toBe(false); // off the right edge
  });
});

describe("isWalkable (legacy/walkable-rect mode)", () => {
  const m = legacyMap();

  it("allows positions fully inside a walkable rect", () => {
    expect(isWalkable(50, 50, 10, m)).toBe(true);
  });

  it("rejects positions in the gap between two rooms", () => {
    expect(isWalkable(150, 50, 10, m)).toBe(false);
  });

  it("rejects positions whose circle pokes out of any walkable rect", () => {
    expect(isWalkable(95, 50, 10, m)).toBe(false);
  });
});

describe("applyMove", () => {
  const m = proceduralMap();

  it("returns the full delta when the destination is walkable", () => {
    const res = applyMove({ x: 50, y: 50 }, { x: 10, y: 0 }, 10, m);
    expect(res).toEqual({ x: 60, y: 50 });
  });

  it("slides along X when only Y is blocked", () => {
    // Custom map with a wide horizontal wall band so Y-blocked-but-X-clear
    // is geometrically guaranteed.
    const m: MapConfig = {
      name: "slide",
      backgroundImage: null,
      backgroundColor: "#000",
      walkable: [],
      tables: [],
      objects: [
        // 200-wide horizontal wall band at y=80..100
        { type: "wall", x: 0, y: 80, width: 200, height: 20 },
      ],
      bounds: { x: 0, y: 0, width: 200, height: 200 },
    };
    // Start above the wall (y=65 with r=10 → top circle edge=55, bottom=75 — clear).
    // Delta (10, 10) would land at (60, 75): bottom=85 → overlaps wall band.
    // X-only (60, 65): still above the wall — clear.
    // Y-only (50, 75): also overlaps wall band — blocked.
    const res = applyMove({ x: 50, y: 65 }, { x: 10, y: 10 }, 10, m);
    expect(res.x).toBe(60);
    expect(res.y).toBe(65);
  });

  it("returns the original position when no axis can move", () => {
    // Squeezed into a corner with a delta that pushes into the wall and out of bounds.
    const res = applyMove({ x: 5, y: 100 }, { x: -10, y: 0 }, 10, m);
    expect(res).toEqual({ x: 5, y: 100 });
  });
});

describe("findNearestTable", () => {
  const m = proceduralMap();

  it("returns null when no table is within the radius", () => {
    expect(findNearestTable(0, 0, m, 40)).toBeNull();
  });

  it("returns the table with the closest edge", () => {
    const near = findNearestTable(135, 100, m, 50);
    expect(near?.id).toBe("table-eng");
    // Distance from (135, 100) to the AABB at (140,80)-(180,120) edge x=140 is 5.
    expect(near?.distance).toBeCloseTo(5, 5);
  });

  it("returns distance 0 when the point is inside the table", () => {
    const near = findNearestTable(160, 100, m, 10);
    expect(near?.id).toBe("table-eng");
    expect(near?.distance).toBe(0);
  });
});

describe("findNearestNote", () => {
  function mapWithNotes(): MapConfig {
    return {
      name: "notes",
      backgroundImage: null,
      backgroundColor: "#000",
      walkable: [],
      tables: [],
      objects: [
        { type: "wall", x: 0, y: 0, width: 10, height: 10 }, // not a note
        { type: "note", x: 100, y: 100, width: 20, height: 20, text: "A" },
        { type: "note", x: 200, y: 100, width: 20, height: 20, text: "B" },
      ],
      bounds: { x: 0, y: 0, width: 400, height: 400 },
    };
  }

  it("returns null when no note is within the radius", () => {
    expect(findNearestNote(0, 0, mapWithNotes(), 30)).toBeNull();
  });

  it("returns the closest note by edge distance with index into objects", () => {
    const m = mapWithNotes();
    // (115, 110) is inside note A → distance 0.
    const near = findNearestNote(115, 110, m, 40);
    // Note A is at index 1 (wall is index 0).
    expect(near?.index).toBe(1);
    expect(near?.distance).toBe(0);
  });

  it("skips non-note objects even if they're closer", () => {
    const m = mapWithNotes();
    // (5, 5) is inside the wall but no notes within 30 units.
    expect(findNearestNote(5, 5, m, 30)).toBeNull();
  });
});

describe("findPortalAt", () => {
  function mapWithPortals(): MapConfig {
    return {
      name: "portals",
      backgroundImage: null,
      backgroundColor: "#000",
      walkable: [],
      tables: [],
      objects: [
        // Portal A: in the top-left, has a destination
        {
          type: "portal",
          x: 100,
          y: 100,
          width: 40,
          height: 40,
          destination: { mapUrl: "/maps/other.json", label: "Garden" },
        },
        // Portal B with NO destination (should be ignored)
        { type: "portal", x: 300, y: 300, width: 40, height: 40 },
        // A non-portal that overlaps the same AABB as portal A
        { type: "rug", x: 100, y: 100, width: 40, height: 40 },
      ],
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    };
  }

  it("returns the portal when the point is inside", () => {
    const portal = findPortalAt(120, 120, mapWithPortals());
    expect(portal).not.toBeNull();
    expect(portal!.destination?.mapUrl).toBe("/maps/other.json");
  });

  it("returns null when the point is outside any portal", () => {
    expect(findPortalAt(0, 0, mapWithPortals())).toBeNull();
    expect(findPortalAt(500, 500, mapWithPortals())).toBeNull();
  });

  it("ignores portals with no destination", () => {
    expect(findPortalAt(320, 320, mapWithPortals())).toBeNull();
  });

  it("ignores non-portal objects at the same coords", () => {
    // Point is inside both the rug (object index 2) and portal A (index 0).
    const portal = findPortalAt(120, 120, mapWithPortals());
    expect(portal?.type).toBe("portal");
  });
});

describe("findNearestBoard", () => {
  function mapWithBoards(): MapConfig {
    return {
      name: "boards",
      backgroundImage: null,
      backgroundColor: "#000",
      walkable: [],
      tables: [],
      objects: [
        { type: "wall", x: 0, y: 0, width: 10, height: 10 },
        { type: "board", x: 100, y: 100, width: 40, height: 20, repo: "a/b" },
        { type: "board", x: 300, y: 100, width: 40, height: 20 }, // no repo
        { type: "note", x: 105, y: 105, width: 10, height: 10 },
      ],
      bounds: { x: 0, y: 0, width: 400, height: 400 },
    };
  }

  it("returns null when no board is within the radius", () => {
    expect(findNearestBoard(0, 0, mapWithBoards(), 30)).toBeNull();
  });

  it("returns the closest board by edge distance with index into objects", () => {
    const near = findNearestBoard(110, 105, mapWithBoards(), 40);
    expect(near?.index).toBe(1);
    expect(near?.distance).toBe(0);
  });

  it("includes boards without a repo (renderer shows connect state)", () => {
    const near = findNearestBoard(310, 105, mapWithBoards(), 40);
    expect(near?.index).toBe(2);
  });

  it("ignores non-board objects even if closer", () => {
    const m = mapWithBoards();
    // Point at (5,5) is on the wall (index 0); no board within 30.
    expect(findNearestBoard(5, 5, m, 30)).toBeNull();
  });
});
