// Mirrors assets/map_config.json shape exactly. The web client consumes
// this file (copied into web/public/ at dev/build by scripts/sync-assets.mjs).
//
// Two authoring styles are supported (both go through the same MapConfig):
//
//   (A) Painted-background mode (legacy room1): provide background_image +
//       walkable_areas. Collision = avatar circle must fit inside one
//       walkable rect. Renderer draws the bitmap and overlays table outlines.
//
//   (B) Procedural / RPG mode (new): provide width/height + an `objects`
//       array of typed entities (wall, table, plant, chair, door...). Solid
//       types block movement; the renderer draws them with type-specific
//       styles so no background image is needed. This is the path you use to
//       hand-author levels in code without painting a bitmap.
export interface RawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawTable extends RawRect {
  id: string;
}

/** Tilemap visual layer (contracts.md "Pixel-art tilemap" §2). Row-major
 *  `grid` of tile indices into the 8-column Tilation sheet
 *  (`index = row*8+col`); `-1` = transparent. One tile = 16×16 world
 *  units, so `cols*16` must equal the map `width` and `rows*16` the map
 *  `height` (validator-enforced). Visual only — collision/sit-targets/
 *  zones stay in `objects`. */
export interface RawTileGrid {
  cols: number;
  rows: number;
  grid: number[];
  /** Optional overlay layer (same dims): furniture tiles with transparency
   *  (chairs, plants). Drawn after `grid` so the floor shows through. */
  deco?: number[];
}

export interface RawMapObject extends RawRect {
  id?: string;
  type: MapObjectType;
  label?: string;
  color?: string;
  /** For `zone` type: acoustic policy (see `ZoneKind`). Optional in the JSON
   *  so old maps keep parsing — the parser defaults a missing/invalid kind
   *  to `"discussion"` (backward compatibility, contracts.md "Zones (M1)"). */
  kind?: ZoneKind;
  /** For `note` type: the body text shown when a user reads the note. */
  text?: string;
  /** For `portal` type: the map URL to teleport to when the local avatar
   *  walks into the portal AABB. Optional spawn override; when omitted the
   *  destination map's default spawn is used. */
  destination?: {
    mapUrl: string;
    /** Friendly label rendered above the swirl. */
    label?: string;
    spawn?: { x: number; y: number };
  };
  /** For `board` type: GitHub repository in `owner/name` form. The board
   *  modal fetches open PRs from this repo via the unauthenticated REST
   *  API. Optional — without it the board renders an empty/connect state. */
  repo?: string;
  /** Visual extrusion elevation in world units. Renderer draws solid
   *  objects as fake-3D boxes (top + side faces). Defaults per type when
   *  omitted; set explicitly to override (0 = flat, no extrusion). */
  elevation?: number;
  /** Named sprite key from `ui/spriteAtlas.ts` SPRITES catalog. When set,
   *  the renderer draws this sprite cell instead of the per-type default
   *  (FURNITURE[type]). Lets authors pick `bed_blue` / `bookshelf` /
   *  `stove` etc. without adding a new MapObjectType for each. */
  sprite?: string;
}

export interface RawMapConfig {
  map_name: string;
  background_image?: string;
  background_color?: string;
  width?: number;
  height?: number;
  walkable_areas?: RawRect[];
  tables?: RawTable[];
  objects?: RawMapObject[];
  /** Tilemap visual layer. When present with `tileVisual: true`, the
   *  renderer draws this grid instead of procedural wall/table/chair/
   *  cabinet/plant/rug bodies. */
  tilegrid?: RawTileGrid;
  /** Opt-in flag for the tilemap visual layer (§2). */
  tileVisual?: boolean;
  collision_settings?: {
    type: string;
    strict_mode: boolean;
  };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Table extends Rect {
  id: string;
  label?: string;
}

// Object types. SOLID_TYPES (defined in domain/mapConfig.ts) block movement.
// Add new types by extending this union AND updating SOLID_TYPES + the
// renderer's style switch. Keep this string-based (not enum) for JSON brevity.
//
// `zone` is non-solid: a named rect that's used for the "Who's where" sidebar
// (occupancy by avatar AABB hit-test). Authors use it to label areas of the
// map (e.g. "Lounge", "Engineering") that aren't tables.
// `portal` is non-solid: walking into it teleports the local avatar to the
// `destination` map. Other peers don't experience the teleport.
// `board` is non-solid: interactive sprite that opens a modal listing recent
// open PRs from a configurable GitHub repository. Press F when nearby.
export type MapObjectType =
  | "wall"
  | "table"
  | "desk"
  | "plant"
  | "cabinet"
  | "chair"
  | "door"
  | "rug"
  | "note"
  | "zone"
  | "portal"
  | "board";

/** Acoustic policy of a `zone` object (contracts.md "Zones (M1): quiet
 *  semantics"). `silent` forces mute on entry; `discussion`/`rest` allow
 *  proximity voice (rest exists for map semantics/stats only); `none` is a
 *  domain-level value meaning "outside every zone" and is never authored —
 *  it is treated as `discussion` (pre-M1 behavior). */
export type ZoneKind = "silent" | "discussion" | "rest" | "none";

export interface MapObject extends Rect {
  id?: string;
  type: MapObjectType;
  label?: string;
  color?: string;
  /** Acoustic policy for `zone` objects. Required by the contract on every
   *  zone object; the parser guarantees it is populated (old maps default
   *  to `"discussion"`). Other object types leave it unset. */
  kind?: ZoneKind;
  /** For `note` type: the body text shown when a user reads the note. */
  text?: string;
  /** For `portal` type. See RawMapObject.destination. */
  destination?: {
    mapUrl: string;
    label?: string;
    spawn?: { x: number; y: number };
  };
  /** For `board` type. See RawMapObject.repo. */
  repo?: string;
  /** Visual extrusion elevation in world units. Defaults per type. */
  elevation?: number;
  /** Named sprite key from `ui/spriteAtlas.ts` SPRITES. See RawMapObject.sprite. */
  sprite?: string;
}

export interface TileGrid {
  cols: number;
  rows: number;
  /** Row-major, `rows*cols` entries; `-1` = transparent, else an index
   *  into the 8-column Tilation sheet (`row*8+col`). */
  grid: number[];
  /** Optional overlay layer (same dims, `-1` = empty). Drawn after `grid`. */
  deco: number[] | null;
}

export interface MapConfig {
  name: string;
  /** null when authored procedurally (no painted background). */
  backgroundImage: string | null;
  /** Floor color used when there is no background image. */
  backgroundColor: string;
  /** Legacy walkable AABB list. Empty when authoring procedurally. */
  walkable: Rect[];
  /** Surfaced for table-join logic; populated from either `tables` or
   *  objects.filter(type === "table"). */
  tables: Table[];
  /** Renderable + collidable entities (procedural mode). Empty in legacy. */
  objects: MapObject[];
  /** Tilemap visual layer; null when the template doesn't author one. */
  tilegrid: TileGrid | null;
  /** When true, the tile grid is the visual layer: the renderer skips
   *  procedural bodies for wall/table/desk/chair/cabinet/plant/rug but
   *  keeps them for collision/logic. */
  tileVisual: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}
