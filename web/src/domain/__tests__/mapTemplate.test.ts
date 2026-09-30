import { describe, expect, it } from "vitest";
import { validateTemplate } from "../mapTemplate";

/** A minimal legal template: 400x300 floor, one full-map silent zone, one
 *  table, one walkable spawn, no thumbnail. Must validate clean. */
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

function errorsOf(raw: unknown): string[] {
  return validateTemplate(raw).errors;
}

describe("validateTemplate: happy path", () => {
  it("accepts a minimal legal template with no errors and no warnings", () => {
    const { errors, warnings } = validateTemplate(validTemplate());
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("accepts background_image as an alternative to background_color", () => {
    const t = validTemplate();
    delete t["background_color"];
    t["background_image"] = "library.jpg";
    expect(errorsOf(t)).toEqual([]);
  });

  it("accepts edge-touching tables as non-overlapping", () => {
    const t = validTemplate();
    (t["objects"] as Array<Record<string, unknown>>).push({
      type: "table", id: "table-a2", label: "A2",
      x: 180, y: 100, width: 80, height: 60, // touches table-a1's right edge
    });
    expect(errorsOf(t)).toEqual([]);
  });
});

describe("validateTemplate: metadata (Q1)", () => {
  it("rejects a non-object root", () => {
    expect(errorsOf(null)).not.toEqual([]);
    expect(errorsOf("library")).not.toEqual([]);
  });

  it("rejects a missing template block", () => {
    const t = validTemplate();
    delete t["template"];
    expect(errorsOf(t).join("\n")).toMatch(/template.*metadata block/);
  });

  it("rejects a non-kebab-case id", () => {
    const t = validTemplate();
    (t["template"] as Record<string, unknown>)["id"] = "Library_01";
    expect(errorsOf(t).join("\n")).toMatch(/template\.id.*kebab-case/);
  });

  it("rejects a missing id", () => {
    const t = validTemplate();
    delete (t["template"] as Record<string, unknown>)["id"];
    expect(errorsOf(t).join("\n")).toMatch(/template\.id/);
  });

  it("rejects name missing the zh string", () => {
    const t = validTemplate();
    (t["template"] as Record<string, unknown>)["name"] = { en: "Library" };
    expect(errorsOf(t).join("\n")).toMatch(/template\.name\.zh/);
  });

  it("rejects an empty description.en", () => {
    const t = validTemplate();
    (t["template"] as Record<string, unknown>)["description"] = {
      en: "",
      zh: "安静的阅读大厅。",
    };
    expect(errorsOf(t).join("\n")).toMatch(/template\.description\.en/);
  });

  it("rejects an empty thumbnail string but allows a missing one", () => {
    const t = validTemplate();
    (t["template"] as Record<string, unknown>)["thumbnail"] = "";
    expect(errorsOf(t).join("\n")).toMatch(/template\.thumbnail/);
    const t2 = validTemplate();
    expect(errorsOf(t2)).toEqual([]);
  });
});

describe("validateTemplate: map basics (Q2)", () => {
  it("rejects a missing map_name", () => {
    const t = validTemplate();
    delete t["map_name"];
    expect(errorsOf(t).join("\n")).toMatch(/map_name/);
  });

  it("rejects non-positive width/height", () => {
    const t = validTemplate();
    t["width"] = 0;
    t["height"] = -5;
    const joined = errorsOf(t).join("\n");
    expect(joined).toMatch(/map\.width/);
    expect(joined).toMatch(/map\.height/);
  });

  it("rejects a missing background", () => {
    const t = validTemplate();
    delete t["background_color"];
    expect(errorsOf(t).join("\n")).toMatch(/background_color.*background_image/);
  });
});

describe("validateTemplate: zones (Q3)", () => {
  it("rejects a template with no zone objects", () => {
    const t = validTemplate();
    t["objects"] = [
      { type: "table", id: "table-a1", x: 100, y: 100, width: 80, height: 60 },
    ];
    expect(errorsOf(t).join("\n")).toMatch(/at least one zone/);
  });

  it("rejects a zone with a missing kind (no legacy default for templates)", () => {
    const t = validTemplate();
    const zone = (t["objects"] as Array<Record<string, unknown>>)[0];
    delete zone["kind"];
    expect(errorsOf(t).join("\n")).toMatch(/kind.*required/);
  });

  it("rejects a zone with an invalid kind", () => {
    const t = validTemplate();
    (t["objects"] as Array<Record<string, unknown>>)[0]["kind"] = "meeting";
    expect(errorsOf(t).join("\n")).toMatch(/silent\|discussion\|rest/);
  });

  it("rejects kind=none (never authored)", () => {
    const t = validTemplate();
    (t["objects"] as Array<Record<string, unknown>>)[0]["kind"] = "none";
    expect(errorsOf(t).join("\n")).toMatch(/silent\|discussion\|rest/);
  });

  it("rejects a template with no silent zone", () => {
    const t = validTemplate();
    (t["objects"] as Array<Record<string, unknown>>)[0]["kind"] = "discussion";
    expect(errorsOf(t).join("\n")).toMatch(/at least one zone with kind "silent"/);
  });

  it("accepts silent + discussion/rest zone mixes", () => {
    const t = validTemplate();
    (t["objects"] as Array<Record<string, unknown>>).push({
      type: "zone", id: "zone-lounge", label: "Lounge", kind: "rest",
      x: 0, y: 240, width: 400, height: 60,
    });
    expect(errorsOf(t)).toEqual([]);
  });
});

describe("validateTemplate: dead zones (Q4)", () => {
  it("rejects walkable areas not covered by any zone", () => {
    const t = validTemplate();
    // Shrink the silent zone to the left half; the right half is walkable
    // floor with no zone → dead zone.
    (t["objects"] as Array<Record<string, unknown>>)[0] = {
      type: "zone", id: "zone-main", label: "Main", kind: "silent",
      x: 0, y: 0, width: 100, height: 300,
    };
    const joined = errorsOf(t).join("\n");
    expect(joined).toMatch(/not inside any zone/);
    expect(joined).toMatch(/dead zones/);
  });

  it("does not require zones to cover solid objects", () => {
    // The valid fixture's zone covers everything including the table; the
    // table cells are skipped by the coverage grid (solids excluded).
    expect(errorsOf(validTemplate())).toEqual([]);
  });
});

describe("validateTemplate: spawn points (Q5)", () => {
  it("rejects a missing spawn_points array", () => {
    const t = validTemplate();
    delete t["spawn_points"];
    expect(errorsOf(t).join("\n")).toMatch(/spawn_points/);
  });

  it("rejects an empty spawn_points array", () => {
    const t = validTemplate();
    t["spawn_points"] = [];
    expect(errorsOf(t).join("\n")).toMatch(/spawn_points/);
  });

  it("rejects a spawn outside the map bounds", () => {
    const t = validTemplate();
    t["spawn_points"] = [{ x: 500, y: 100 }];
    expect(errorsOf(t).join("\n")).toMatch(/outside the map bounds/);
  });

  it("rejects a spawn inside a solid object", () => {
    const t = validTemplate();
    t["spawn_points"] = [{ x: 110, y: 110 }]; // inside table-a1
    expect(errorsOf(t).join("\n")).toMatch(/inside a solid/);
  });

  it("accepts spawns on the exact map edge", () => {
    const t = validTemplate();
    t["spawn_points"] = [{ x: 400, y: 300 }];
    expect(errorsOf(t)).toEqual([]);
  });
});

describe("validateTemplate: tables (Q6)", () => {
  it("rejects a table without an id", () => {
    const t = validTemplate();
    delete (t["objects"] as Array<Record<string, unknown>>)[1]["id"];
    expect(errorsOf(t).join("\n")).toMatch(/require a non-empty "id"/);
  });

  it("rejects duplicate table ids", () => {
    const t = validTemplate();
    (t["objects"] as Array<Record<string, unknown>>).push({
      type: "table", id: "table-a1", label: "A1 copy",
      x: 300, y: 100, width: 80, height: 60,
    });
    expect(errorsOf(t).join("\n")).toMatch(/duplicate id "table-a1"/);
  });

  it("rejects overlapping table AABBs", () => {
    const t = validTemplate();
    (t["objects"] as Array<Record<string, unknown>>).push({
      type: "table", id: "table-a2", label: "A2",
      x: 150, y: 120, width: 80, height: 60, // overlaps table-a1
    });
    expect(errorsOf(t).join("\n")).toMatch(/overlaps/);
  });

  it("checks ids across object tables and top-level tables[]", () => {
    const t = validTemplate();
    t["tables"] = [
      { id: "table-a1", x: 300, y: 200, width: 40, height: 40 },
    ];
    expect(errorsOf(t).join("\n")).toMatch(/duplicate id "table-a1"/);
  });
});

describe("validateTemplate: object sanity (Q7)", () => {
  it("rejects an unknown object type", () => {
    const t = validTemplate();
    (t["objects"] as Array<Record<string, unknown>>).push({
      type: "sofa", x: 10, y: 10, width: 40, height: 40,
    });
    expect(errorsOf(t).join("\n")).toMatch(/unknown type "sofa"/);
  });

  it("rejects a degenerate rect", () => {
    const t = validTemplate();
    (t["objects"] as Array<Record<string, unknown>>).push({
      type: "rug", x: 10, y: 10, width: 0, height: 40,
    });
    expect(errorsOf(t).join("\n")).toMatch(/width and height must be > 0/);
  });

  it("rejects non-finite coordinates", () => {
    const t = validTemplate();
    (t["objects"] as Array<Record<string, unknown>>).push({
      type: "rug", x: Number.NaN, y: 10, width: 40, height: 40,
    });
    expect(errorsOf(t).join("\n")).toMatch(/finite numbers/);
  });
});

describe("validateTemplate: warnings (Q8-Q10)", () => {
  it("warns on sprite references without failing validation", () => {
    const t = validTemplate();
    (t["objects"] as Array<Record<string, unknown>>).push({
      type: "plant", x: 10, y: 10, width: 36, height: 36, sprite: "plant_tall",
    });
    const { errors, warnings } = validateTemplate(t);
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/sprite "plant_tall"/);
  });

  it("warns on an absolute thumbnail URL", () => {
    const t = validTemplate();
    (t["template"] as Record<string, unknown>)["thumbnail"] =
      "https://example.com/library.png";
    const { errors, warnings } = validateTemplate(t);
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/thumbnail.*absolute/);
  });

  it("warns on a leading-slash thumbnail path", () => {
    const t = validTemplate();
    (t["template"] as Record<string, unknown>)["thumbnail"] =
      "/templates/thumbnails/library.png";
    const { errors, warnings } = validateTemplate(t);
    expect(errors).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("accepts a relative thumbnail with no warnings", () => {
    const t = validTemplate();
    (t["template"] as Record<string, unknown>)["thumbnail"] =
      "thumbnails/library.png";
    const { errors, warnings } = validateTemplate(t);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("warns when the template has no tables at all", () => {
    const t = validTemplate();
    t["objects"] = [
      {
        type: "zone", id: "zone-main", label: "Main", kind: "silent",
        x: 0, y: 0, width: 400, height: 300,
      },
    ];
    const { errors, warnings } = validateTemplate(t);
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/no tables/);
  });

  it("warns on overcrowded table density", () => {
    const t = validTemplate();
    const objects = t["objects"] as Array<Record<string, unknown>>;
    objects.length = 1; // keep only the zone
    for (let i = 0; i < 10; i++) {
      objects.push({
        type: "table", id: `table-${i}`, x: i * 40, y: 10, width: 36, height: 30,
      });
    }
    // 400*300/10 = 12000 px² per table < 20000 → warning, still legal.
    const { errors, warnings } = validateTemplate(t);
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/overcrowded/);
  });
});

describe("validateTemplate: tilegrid (contracts.md Pixel-art tilemap §2)", () => {
  it("accepts a well-formed tilegrid matching the map footprint", () => {
    const t = validTemplate();
    // 400x300 is not a multiple of 16 in height; use a 32x32 map instead.
    t["width"] = 32; t["height"] = 32;
    t["spawn_points"] = [{ x: 16, y: 16 }];
    t["tileVisual"] = true;
    t["tilegrid"] = { cols: 2, rows: 2, grid: [15, -1, 63, 111] };
    const { errors } = validateTemplate(t);
    expect(errors).toEqual([]);
  });

  it("rejects a tilegrid whose dims do not match width/height", () => {
    const t = validTemplate();
    t["tileVisual"] = true;
    t["tilegrid"] = { cols: 25, rows: 18, grid: new Array(25 * 18).fill(-1) };
    // 25*16=400 ok, 18*16=288 ≠ 300
    const { errors } = validateTemplate(t);
    expect(errors.join("\n")).toMatch(/rows\*16/);
  });

  it("rejects grid length ≠ cols*rows and out-of-range indices", () => {
    const t = validTemplate();
    t["width"] = 32; t["height"] = 32;
    t["tileVisual"] = true;
    t["tilegrid"] = { cols: 2, rows: 2, grid: [0, 1, 2] };
    expect(validateTemplate(t).errors.join("\n")).toMatch(/cols\*rows/);

    const t2 = validTemplate();
    t2["width"] = 32; t2["height"] = 32;
    t2["tileVisual"] = true;
    t2["tilegrid"] = { cols: 2, rows: 2, grid: [0, 216, -1, -2] };
    expect(validateTemplate(t2).errors.join("\n")).toMatch(/grid\[1\]/);
  });

  it("rejects tileVisual:true without a valid tilegrid", () => {
    const t = validTemplate();
    t["tileVisual"] = true;
    expect(validateTemplate(t).errors.join("\n")).toMatch(/tileVisual/);
  });

  it("validates the optional deco overlay when present", () => {
    const t = validTemplate();
    t["width"] = 32; t["height"] = 32;
    t["spawn_points"] = [{ x: 16, y: 16 }];
    t["tileVisual"] = true;
    t["tilegrid"] = { cols: 2, rows: 2, grid: [15, -1, 63, 111], deco: [-1, 195, -1, -1] };
    expect(validateTemplate(t).errors).toEqual([]);

    const bad = validTemplate();
    bad["width"] = 32; bad["height"] = 32;
    bad["spawn_points"] = [{ x: 16, y: 16 }];
    bad["tileVisual"] = true;
    bad["tilegrid"] = { cols: 2, rows: 2, grid: [15, -1, 63, 111], deco: [-1, 999] };
    expect(validateTemplate(bad).errors.join("\n")).toMatch(/deco/);
  });

  it("validates the real library.json tilemap with zero errors", async () => {
    // @ts-expect-error node:fs has no type declarations here (@types/node absent)
    const { readFileSync } = await import("node:fs");
    // @ts-expect-error node:path has no type declarations here (@types/node absent)
    const { resolve, dirname } = await import("node:path");
    // @ts-expect-error node:url has no type declarations here (@types/node absent)
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = JSON.parse(
      readFileSync(resolve(here, "..", "..", "..", "..", "assets", "templates", "library.json"), "utf8"),
    );
    const { errors, warnings } = validateTemplate(raw);
    expect(errors).toEqual([]);
    // Sanity on the authoring: 8 tables / 44 chairs, 55×40 grid.
    const objs = raw.objects as Array<{ type: string }>;
    expect(objs.filter((o) => o.type === "table").length).toBe(8);
    expect(objs.filter((o) => o.type === "chair").length).toBe(44);
    expect(raw.tilegrid.cols).toBe(55);
    expect(raw.tilegrid.rows).toBe(40);
    expect(raw.tilegrid.grid.length).toBe(2200);
    expect(warnings.join("\n")).not.toMatch(/overcrowded/);
  });
});
