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
  bounds: { x: number; y: number; width: number; height: number };
}
