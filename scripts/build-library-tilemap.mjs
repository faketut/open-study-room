#!/usr/bin/env node
/**
 * Builds assets/templates/library.json — the pixel-art tilemap library.
 *
 * Source of truth for the 55×40 tile grid + the logical object layer.
 * Run: `node scripts/build-library-tilemap.mjs` (from the repo root).
 *
 * Tile indices are into the Tilation 16×16 sheet (8 cols × 27 rows):
 *   index = row*8 + col.  -1 = transparent (nothing drawn).
 * One tile = 16×16 world units → 55×40 tiles = 880×640 exactly.
 *
 * Layer separation (contracts.md "Pixel-art tilemap" §2):
 *   - the grid is VISUAL only (floors, walls, furniture);
 *   - `objects` carries collision (wall/cabinet/table/plant), sit targets
 *     (table/chair), zones, board, door, spawns.
 *   Positions of logical objects match the tiles beneath them.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "..", "assets", "templates", "library.json");

const COLS = 55;
const ROWS = 40;
const T = (r, c) => r * 8 + c;
const EMPTY = -1;

// ---- Tile palette (verified against tilation-16x16.png, 2026-09-30) ----
// Carpets + walls (rows 0-19) were verified first; furniture (rows 20-26)
// re-verified tile-by-tile after catching a one-row offset.
const BLUE = T(7, 7), BLUE_S = T(7, 1);   // reading hall floor
const PINK = T(13, 7), PINK_S = T(13, 1); // rest areas floor
const RED = T(1, 7), RED_S = T(1, 1);     // discussion floor
const WALL_H = T(18, 5);                  // horizontal wall band
const WALL_V = T(18, 0);                  // vertical wall band
const SHELF = T(23, 3);                   // bookshelf (dividers)
const CHAIR_T = T(24, 3);                 // wooden chair (sit targets)
const WTABLE = T(23, 7);                  // wood table cell
const PLANT = T(24, 4), PLANT_P = T(24, 5), PLANT_R = T(24, 6);
const FIRE = T(25, 0);
const ARM_R = T(25, 2), ARM_B = T(25, 1), ARM_P = T(25, 3);
const BED_B = T(23, 0), BED_R = T(23, 1);
const DOOR_T = T(20, 2);
const CANDLE = T(26, 1);
const CHEST = T(24, 7), BARREL = T(25, 4);
const RUG = T(26, 2);                     // small red carpet cell

// ---- Grid (two layers) ----
// `grid`: base layer (floors, walls, opaque furniture). `deco`: overlay for
// furniture tiles with transparency (chairs, plants, ...). The renderer
// draws base first, then deco, so transparent pixels show the floor.
const grid = new Array(COLS * ROWS).fill(EMPTY);
const deco = new Array(COLS * ROWS).fill(EMPTY);
const set = (c, r, v) => { grid[r * COLS + c] = v; };
const setDeco = (c, r, v) => { deco[r * COLS + c] = v; };
const fill = (c0, r0, c1, r1, v) => {
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) set(c, r, v);
};
/** Floor fill with a sparse sparkle variant for texture. */
const floorFill = (c0, r0, c1, r1, base, spark) => {
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++)
      set(c, r, (c * 7 + r * 13) % 11 === 0 ? spark : base);
};

// Floors by zone.
floorFill(1, 1, 53, 15, BLUE, BLUE_S);    // reading hall (silent)
floorFill(1, 17, 53, 18, PINK, PINK_S);   // corridor (rest)
floorFill(1, 20, 24, 38, PINK, PINK_S);   // lounge (rest)
floorFill(25, 20, 37, 38, PINK, PINK_S);  // lobby (rest)
floorFill(38, 20, 53, 38, RED, RED_S);    // discussion

// Outer walls.
fill(0, 0, 54, 0, WALL_H);
for (let c = 0; c <= 54; c++) {
  if (c === 30 || c === 31) continue; // entrance door gap
  set(c, 39, WALL_H);
}
for (let r = 0; r <= 39; r++) { set(0, r, WALL_V); set(54, r, WALL_V); }

// Interior horizontal walls (row 16: reading|corridor, row 19: corridor|south)
// with door gaps at cols 12-13, 30-31, 44-45.
const gaps = new Set([12, 13, 30, 31, 44, 45]);
for (const r of [16, 19])
  for (let c = 1; c <= 53; c++) if (!gaps.has(c)) set(c, r, WALL_H);

// Bookshelf dividers (also the logical `cabinet` solids).
for (let c = 1; c <= 53; c++) {
  if (c >= 26 && c <= 28) continue; // central passage
  set(c, 8, SHELF);
}
for (const c of [25, 37])
  for (let r = 20; r <= 38; r++) {
    if (r === 27 || r === 28) continue; // doorway
    set(c, r, SHELF);
  }

// ---- Furniture tiles + logical tables/chairs ----
// WTABLE/CHAIR_T tiles are visual; the objects below carry ids/collision.
const tables = []; // {id,label,c0,r0,c1,r1}
const chairs = []; // {c,r}
const table = (id, label, c0, r0, c1, r1) => {
  fill(c0, r0, c1, r1, WTABLE);
  tables.push({ id, label, c0, r0, c1, r1 });
  for (let c = c0; c <= c1; c++) { chairs.push({ c, r: r0 - 1 }); chairs.push({ c, r: r1 + 1 }); }
  for (const { c, r } of chairs.slice(-2 * (c1 - c0 + 1))) setDeco(c, r, CHAIR_T);
};

// Reading hall: 5 tables.
table("table-read-nw", "Reading Table NW", 8, 4, 10, 5);
table("table-read-ne", "Reading Table NE", 44, 4, 46, 5);
table("table-read-n", "Reading Table N", 25, 4, 28, 5);
table("table-read-sw", "Reading Table SW", 8, 11, 10, 12);
table("table-read-se", "Reading Table SE", 44, 11, 46, 12);
// Lounge: 2 tables.
table("table-lounge-a", "Lounge Table A", 8, 25, 9, 26);
table("table-lounge-b", "Lounge Table B", 16, 30, 17, 31);
// Discussion: 1 table.
table("table-discuss", "Discussion Table", 43, 27, 44, 28);

// Decor (visual tiles; solid ones also get logical objects below).
// Transparent furniture goes on the deco layer so the floor shows through.
const decorSolid = []; // {c,r,w,h} → cabinet solids
const put = (c, r, v, solid = false, w = 1, h = 1) => {
  set(c, r, v);
  if (solid) decorSolid.push({ c, r, w, h });
};
const putDeco = (c, r, v, solid = false) => {
  setDeco(c, r, v);
  if (solid) decorSolid.push({ c, r, w: 1, h: 1 });
};
// Reading hall corners.
putDeco(2, 2, PLANT); putDeco(51, 2, PLANT); putDeco(2, 14, PLANT); putDeco(51, 14, PLANT);
setDeco(7, 4, CANDLE); setDeco(47, 4, CANDLE); setDeco(7, 12, CANDLE); setDeco(47, 12, CANDLE);
// Lounge: fireplace corner + armchairs + daybeds + clutter.
putDeco(2, 21, FIRE, true);
setDeco(2, 23, ARM_R); setDeco(4, 23, ARM_B); setDeco(6, 23, ARM_P);
put(2, 33, BED_B, true); put(2, 34, BED_R, true);
putDeco(22, 21, PLANT); putDeco(22, 36, PLANT_P); putDeco(12, 37, PLANT_R);
putDeco(5, 37, CHEST, true); putDeco(23, 37, BARREL, true);
// Lobby: rug + plant + door tile in the gap.
fill(29, 33, 31, 34, RUG);
putDeco(36, 21, PLANT);
set(30, 39, DOOR_T);
// Discussion: bookshelf run + plants.
for (let c = 40; c <= 52; c++) set(c, 20, SHELF);
putDeco(39, 21, PLANT); putDeco(52, 36, PLANT_P);
setDeco(39, 37, CANDLE);

// ---- Logical objects ----
const px = (c) => c * 16;
const objects = [];
const wall = (c0, r0, c1, r1) =>
  objects.push({ type: "wall", x: px(c0), y: px(r0), width: px(c1 + 1) - px(c0), height: px(r1 + 1) - px(r0) });

// Outer walls (south split at the door gap).
wall(0, 0, 54, 0);
wall(0, 0, 0, 39);
wall(54, 0, 54, 39);
wall(0, 39, 29, 39);
wall(32, 39, 54, 39);
// Interior walls with door gaps.
for (const seg of [[1, 11], [14, 29], [32, 43], [46, 53]]) {
  wall(seg[0], 16, seg[1], 16);
  wall(seg[0], 19, seg[1], 19);
}
// Bookshelf dividers → cabinet solids.
objects.push({ type: "cabinet", x: px(1), y: px(8), width: px(26) - px(1), height: 16 });
objects.push({ type: "cabinet", x: px(29), y: px(8), width: px(54) - px(29), height: 16 });
for (const c of [25, 37]) {
  objects.push({ type: "cabinet", x: px(c), y: px(20), width: 16, height: px(27) - px(20) });
  objects.push({ type: "cabinet", x: px(c), y: px(29), width: 16, height: px(39) - px(29) });
}
// Discussion bookshelf run.
objects.push({ type: "cabinet", x: px(40), y: px(20), width: px(53) - px(40), height: 16 });
// Solid decor.
for (const d of decorSolid)
  objects.push({ type: "cabinet", x: px(d.c), y: px(d.r), width: 16 * d.w, height: 16 * d.h });
// Plants (visual tiles) → plant solids.
for (const [c, r] of [[2, 2], [51, 2], [2, 14], [51, 14], [22, 21], [22, 36], [12, 37], [36, 21], [39, 21], [52, 36]])
  objects.push({ type: "plant", x: px(c), y: px(r), width: 16, height: 16 });
// Tables + chairs.
for (const t of tables)
  objects.push({
    type: "table", id: t.id, label: t.label,
    x: px(t.c0), y: px(t.r0),
    width: px(t.c1 + 1) - px(t.c0), height: px(t.r1 + 1) - px(t.r0),
  });
chairs.forEach((ch, i) =>
  objects.push({ type: "chair", x: px(ch.c), y: px(ch.r), width: 16, height: 16 }),
);
// Zones (wall rows folded into adjacent zones so Q4 passes at door gaps).
objects.push(
  { type: "zone", kind: "silent", label: "Reading Hall", x: 16, y: 16, width: 848, height: 256 },
  { type: "zone", kind: "rest", label: "Corridor", x: 16, y: 272, width: 848, height: 48 },
  { type: "zone", kind: "rest", label: "Lounge", x: 16, y: 320, width: 384, height: 304 },
  { type: "zone", kind: "rest", label: "Lobby", x: 400, y: 320, width: 208, height: 304 },
  { type: "zone", kind: "discussion", label: "Discussion Corner", x: 608, y: 320, width: 256, height: 304 },
);
// Whiteboard (unchanged behavior) + entrance door marker.
objects.push(
  { type: "board", label: "Whiteboard", repo: "faketut/open-study-room", x: 816, y: 400, width: 40, height: 64 },
  { type: "door", x: 480, y: 624, width: 32, height: 16 },
);

const doc = {
  template: {
    id: "library",
    name: { en: "Library", zh: "图书馆" },
    description: {
      en: "Pixel-art library: silent reading hall with bookshelf aisles, discussion corner with whiteboard, lounge, and lobby.",
      zh: "像素风图书馆：书架环绕的静音阅览厅、带白板的讨论角、休息区与门厅。",
    },
  },
  map_name: "Library",
  width: 880,
  height: 640,
  background_color: "#20242e",
  tileVisual: true,
  tilegrid: { cols: COLS, rows: ROWS, grid, deco },
  spawn_points: [
    { x: 440, y: 560 },
    { x: 560, y: 560 },
  ],
  objects,
};

writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${outPath}`);
console.log(`tables=${tables.length} chairs=${chairs.length} objects=${objects.length} grid=${grid.length}`);
