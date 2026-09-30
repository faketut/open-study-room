/** Sprite atlas: maps semantic asset names to (sheet, sx, sy, sw, sh)
 *  pixel rects on the shared sheets in `web/public/sprites/`.
 *
 *  Source pack (16×16 pixel art):
 *  - `walls-floor-doors.png` (128×80) — interior wall/floor/door brick.
 *  - `furniture.png` (128×64) — 8×4 grid of 16×16 furniture cells.
 *    The full cell map (row,col → label) is exported as `SPRITES` below.
 *  - `carpets.png` (128×288) — orange / blue / pink carpets, 18 rows.
 *  - `chars/char_NN.png` (16×16 each, NN = 01..50) — 50 single-frame
 *    character portraits, all facing south. NO walk cycle in this pack.
 *
 *  Authoring:
 *  - Map JSON can set `sprite` (string key into `SPRITES`) on any object
 *    to pick an explicit sprite (e.g. `{ "type": "cabinet",
 *    "sprite": "bed_blue", ... }`). This is the recommended way to use
 *    the catalog because it avoids growing the `MapObjectType` union for
 *    each new piece of furniture.
 *  - When `sprite` is omitted the renderer falls back to `FURNITURE[type]`,
 *    a per-type default for legacy maps (chair/table/desk/cabinet/plant).
 *  - Open `/tile-picker.html` while `npm run dev` is up to click cells
 *    and copy fresh SpriteRect entries. */
import type { MapObjectType } from "../types/mapConfig";

export interface SpriteRect {
  sheet: SpriteSheetKey;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export type SpriteSheetKey = "walls" | "furniture" | "carpets";

export const SHEET_URLS: Record<SpriteSheetKey, string> = {
  walls:     "/sprites/walls-floor-doors.png",
  furniture: "/sprites/furniture.png",
  carpets:   "/sprites/carpets.png",
};

/** Tile used to repeat-fill the floor. Brick interior; (16,16) is the
 *  clean wall-middle cell. */
export const FLOOR_TILE: SpriteRect = {
  sheet: "walls",
  sx: 16, sy: 16, sw: 16, sh: 16,
};

/** Number of character sprites available in `/sprites/chars/`. */
export const CHAR_COUNT = 50;
export const CHAR_TILE_SIZE = 16;

/** Resolve a 1-based index to a character sprite URL. Out-of-range
 *  values wrap into [1, CHAR_COUNT]. */
export function charUrlFromIndex(n: number): string {
  const safe = ((((n - 1) % CHAR_COUNT) + CHAR_COUNT) % CHAR_COUNT) + 1;
  return `/sprites/chars/char_${String(safe).padStart(2, "0")}.png`;
}

/** Stable FNV-1a hash → char_01..char_50 URL for an identity. Used as a
 *  fallback when a peer hasn't broadcast a `character` attribute (e.g.
 *  older Android clients that don't know about the picker yet). */
export function charUrlForIdentity(identity: string): string {
  let h = 2166136261;
  for (let i = 0; i < identity.length; i++) {
    h = (h ^ identity.charCodeAt(i)) * 16777619;
    h = h >>> 0;
  }
  return charUrlFromIndex((h % CHAR_COUNT) + 1);
}

/** Named furniture catalog. Keys are stable IDs that map JSON can put in
 *  the `sprite` field. Coordinates verified against the 8×4 grid of the
 *  furniture sheet (each cell 16×16; sx = col*16, sy = row*16). */
export const SPRITES: Record<string, SpriteRect> = {
  // Row 0 — beds, shelves, tables.
  bed_blue:        f(0, 0), // (r=0, c=0)
  bed_red:         f(0, 1),
  bed_purple:      f(0, 2),
  bookshelf:       f(0, 3), // shelf w/ colorful books
  shelf:           f(0, 4), // empty wood shelf
  stool:           f(0, 5), // round wooden stool
  side_table:      f(0, 6), // small side table
  wood_table:      f(0, 7), // larger wood table
  // Row 1 — appliances, planters, chest.
  stove:           f(1, 0), // gray stove w/ flames
  drawer:          f(1, 1), // dresser / drawer
  toilet:          f(1, 2),
  sink:            f(1, 3),
  plant_leafy:     f(1, 4), // green leafy
  plant_pink:      f(1, 5), // pink-flowered
  plant_red:       f(1, 6), // red-flowered
  chest_closed:    f(1, 7),
  // Row 2 — open chest, armchair color variants, barrels, dishware.
  chest_open:      f(2, 0),
  armchair_blue:   f(2, 1),
  armchair_red:    f(2, 2),
  armchair_purple: f(2, 3),
  barrel:          f(2, 4),
  barrel_alt:      f(2, 5),
  bowl:            f(2, 6),
  mushrooms:       f(2, 7),
  // Row 3 — accent rocks, red carpet variants, kitchen counter.
  rock:            f(3, 0),
  rug_red_a:       f(3, 1),
  rug_red_b:       f(3, 2),
  rug_red_c:       f(3, 3),
  counter:         f(3, 4),
};

/** Shorthand for an (r, c) cell on the furniture sheet. Used only inside
 *  `SPRITES`; the runtime never sees this helper. */
function f(row: number, col: number): SpriteRect {
  return { sheet: "furniture", sx: col * 16, sy: row * 16, sw: 16, sh: 16 };
}

/** Legacy per-type defaults. Used when a map object doesn't set an
 *  explicit `sprite`. Pick the most natural-looking sprite for each
 *  type; map authors can override via `sprite` when they want variety. */
export const FURNITURE: Partial<Record<MapObjectType, SpriteRect>> = {
  chair:   SPRITES.stool,        // round stool reads as "chair" from above
  table:   SPRITES.wood_table,   // big wood table
  desk:    SPRITES.side_table,   // smaller side table
  cabinet: SPRITES.shelf,        // empty wood shelf
  plant:   SPRITES.plant_leafy,  // green leafy
};

/** Resolve the sprite for an object: explicit `sprite` field wins, else
 *  fall back to the per-type default. Returns null when neither hits. */
export function resolveSprite(
  type: MapObjectType,
  spriteKey?: string,
): SpriteRect | null {
  if (spriteKey && SPRITES[spriteKey]) return SPRITES[spriteKey];
  return FURNITURE[type] ?? null;
}

/** Carpet pick used by the `rug` MapObjectType when an explicit
 *  `sprite` isn't set. Cells in carpets.png tile cleanly through their
 *  center. */
export const RUG_TILE: SpriteRect = {
  sheet: "carpets",
  sx: 16, sy: 16, sw: 16, sh: 16,
};

