import { useEffect, useRef } from "react";
import { useSyncle, LOCAL_CHAT_IDENTITY } from "../state/syncleStore";
import { computeViewport, worldToScreen } from "../domain/camera";
import type { MapConfig, MapObject } from "../types/mapConfig";
import { drawObject } from "./mapDraw";
import { statusMeta, type AvatarStatus } from "../domain/avatarStatus";
import {
  SHEET_URLS,
  FLOOR_TILE,
  resolveSprite,
  charUrlForIdentity,
  charUrlFromIndex,
  type SpriteSheetKey,
} from "./spriteAtlas";

export interface SpatialCanvasProps {
  /** Table id the local avatar is close enough to join; drawn with a halo. */
  highlightTable?: string | null;
  /** Index (into map.objects) of the note the avatar can interact with. */
  highlightNoteIndex?: number | null;
  /** MW1-4: cap for devicePixelRatio (battery tier saves GPU). Defaults to 4
   *  (effectively uncapped on real devices). */
  dprCap?: number;
}

export function SpatialCanvas({
  highlightTable = null,
  highlightNoteIndex = null,
  dprCap = 4,
}: SpatialCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLImageElement | null>(null);
  // Sprite sheets preloaded once and reused across frames. `null` means
  // the sheet hasn't loaded yet (or failed) — renderer falls back to
  // procedural drawing in that case.
  const sheetsRef = useRef<Record<SpriteSheetKey, HTMLImageElement | null>>({
    walls: null, furniture: null, carpets: null,
  });
  // Character portraits are 50 separate tiny PNGs (~300 B each). We load
  // each on first request, keyed by URL, and reuse from this cache for
  // subsequent frames. Map miss = sprite not yet loaded, render falls
  // back to the colored disc.
  const charCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  // Cached pattern for the floor tile (built lazily once the walls sheet
  // has loaded). Pattern is in screen pixels so it must rebuild when
  // viewport scale changes.
  const floorPatternRef = useRef<{ pattern: CanvasPattern; scale: number } | null>(null);
  const map = useSyncle((s) => s.map);
  const highlightRef = useRef<string | null>(highlightTable);
  const highlightNoteRef = useRef<number | null>(highlightNoteIndex);
  useEffect(() => {
    highlightRef.current = highlightTable;
  }, [highlightTable]);
  useEffect(() => {
    highlightNoteRef.current = highlightNoteIndex;
  }, [highlightNoteIndex]);

  // Preload the background image only when the map declares one. Procedural
  // maps render from object data alone.
  useEffect(() => {
    bgRef.current = null;
    if (!map || !map.backgroundImage) return;
    const img = new Image();
    img.src = `/${map.backgroundImage}`;
    img.onload = () => {
      bgRef.current = img;
    };
  }, [map]);

  // Preload pixel-art sprite sheets once on mount. Each load just flips a
  // slot in `sheetsRef`; the render loop reads that imperatively next
  // frame, no re-render needed.
  useEffect(() => {
    let cancelled = false;
    (Object.keys(SHEET_URLS) as SpriteSheetKey[]).forEach((key) => {
      const img = new Image();
      img.src = SHEET_URLS[key];
      img.onload = () => {
        if (!cancelled) sheetsRef.current[key] = img;
      };
      img.onerror = () => {
        // Quiet: missing sheet just falls back to procedural rendering.
        if (!cancelled) sheetsRef.current[key] = null;
      };
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Render loop. Reading from the zustand store via getState() in raf keeps
  // the canvas redrawing every frame without subscribing this component to
  // every peer update.
  useEffect(() => {
    if (!map) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // MW1-4: DPR capped by the performance tier (battery → 1.5).
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);

    function resize() {
      if (!canvas) return;
      const { clientWidth, clientHeight } = canvas;
      canvas.width = Math.floor(clientWidth * dpr);
      canvas.height = Math.floor(clientHeight * dpr);
    }
    resize();
    window.addEventListener("resize", resize);

    let frame = 0;
    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        frame = requestAnimationFrame(draw);
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;

      const state = useSyncle.getState();
      const self = state.self;
      if (!self || !map) {
        frame = requestAnimationFrame(draw);
        return;
      }

      const vp = computeViewport(w, h, { x: self.x, y: self.y }, map);

      // Out-of-bounds void: subtle radial dark gradient instead of flat
      // black. The center holds the floor; edges fade darker so attention
      // stays on the playable area without a hard frame.
      const voidGrad = ctx.createRadialGradient(
        w / 2, h / 2, Math.min(w, h) * 0.2,
        w / 2, h / 2, Math.max(w, h) * 0.75,
      );
      voidGrad.addColorStop(0, "#11151c");
      voidGrad.addColorStop(1, "#05070a");
      ctx.fillStyle = voidGrad;
      ctx.fillRect(0, 0, w, h);

      // Floor: pixel-art tile pattern if the walls sheet has loaded, else
      // a bitmap background image if the map declares one, else solid
      // color + procedural grid.
      const bg = bgRef.current;
      const wallsSheet = sheetsRef.current.walls;
      const floorX = map.bounds.x * vp.scale + vp.offsetX;
      const floorY = map.bounds.y * vp.scale + vp.offsetY;
      const floorW = map.bounds.width * vp.scale;
      const floorH = map.bounds.height * vp.scale;
      ctx.imageSmoothingEnabled = false;
      if (wallsSheet) {
        // Build the pattern lazily and rebuild when scale changes. We blit
        // the FLOOR_TILE rect onto a small offscreen canvas at the
        // current screen-pixel tile size, then turn that into a repeating
        // pattern.
        const tilePx = Math.max(1, Math.round(FLOOR_TILE.sw * vp.scale));
        const cached = floorPatternRef.current;
        if (!cached || cached.scale !== tilePx) {
          const off = document.createElement("canvas");
          off.width = tilePx;
          off.height = tilePx;
          const octx = off.getContext("2d");
          if (octx) {
            octx.imageSmoothingEnabled = false;
            octx.drawImage(
              wallsSheet,
              FLOOR_TILE.sx, FLOOR_TILE.sy, FLOOR_TILE.sw, FLOOR_TILE.sh,
              0, 0, tilePx, tilePx,
            );
            const pat = ctx.createPattern(off, "repeat");
            if (pat) floorPatternRef.current = { pattern: pat, scale: tilePx };
          }
        }
        const pat = floorPatternRef.current?.pattern;
        if (pat) {
          ctx.save();
          // Align pattern origin to the floor's top-left so the seams sit
          // on world tile boundaries instead of screen pixel 0,0.
          ctx.translate(floorX, floorY);
          ctx.fillStyle = pat;
          ctx.fillRect(0, 0, floorW, floorH);
          ctx.restore();
        } else {
          ctx.fillStyle = map.backgroundColor;
          ctx.fillRect(floorX, floorY, floorW, floorH);
        }
      } else if (bg) {
        ctx.drawImage(bg, floorX, floorY, floorW, floorH);
      } else {
        ctx.fillStyle = map.backgroundColor;
        ctx.fillRect(floorX, floorY, floorW, floorH);
        // Subtle 32-world-unit grid in floor color +/- 6% lightness.
        // Aligned to world coordinates so the grid pans with the camera.
        drawFloorGrid(ctx, vp, map, floorX, floorY, floorW, floorH);
        // Soft inner vignette: darkens the floor edges by ~20% so the
        // playable area visually recedes toward the walls.
        const vg = ctx.createRadialGradient(
          floorX + floorW / 2, floorY + floorH / 2, Math.min(floorW, floorH) * 0.25,
          floorX + floorW / 2, floorY + floorH / 2, Math.max(floorW, floorH) * 0.65,
        );
        vg.addColorStop(0, "rgba(0,0,0,0)");
        vg.addColorStop(1, "rgba(0,0,0,0.32)");
        ctx.fillStyle = vg;
        ctx.fillRect(floorX, floorY, floorW, floorH);
      }

      // Procedural objects (walls, tables, chairs, plants, ...) — only when
      // the map authored them. Legacy painted maps fall back to the debug
      // walkable outlines so authors can still see the collision rects.
      const occupancy = computeOccupancy(state);
      if (map.objects.length > 0) {
        drawObjects(ctx, map, vp, occupancy, highlightRef.current, highlightNoteRef.current, sheetsRef.current);
      } else {
        drawDebugWalkable(ctx, map, vp);
        // Legacy table outlines (procedural path draws them in drawObjects).
        ctx.strokeStyle = "rgba(255,200,80,0.7)";
        ctx.lineWidth = 2;
        ctx.font = "12px system-ui";
        for (const t of map.tables) {
          const tl = worldToScreen(t.x, t.y, vp);
          const wPx = t.width * vp.scale;
          const hPx = t.height * vp.scale;
          ctx.strokeRect(tl.x, tl.y, wPx, hPx);
          ctx.fillStyle = "rgba(255,200,80,0.85)";
          ctx.fillText(t.id, tl.x + 4, tl.y + 14);
        }
      }

      // Remote peers
      const charCache = charCacheRef.current;
      const speakers = state.speakingIdentities;
      const reactions = state.reactions;
      for (const peer of state.peers.values()) {
        const p = worldToScreen(peer.x, peer.y, vp);
        drawAvatar(
          ctx,
          p.x,
          p.y,
          18,
          // Use the color the peer broadcast (Android publishes this; web now
          // does too). Fall back to the legacy hardcoded blue when missing.
          peer.color ?? "#5AC8FA",
          peer.name ?? peer.identity.slice(0, 6),
          peer.tableId != null,
          speakers.has(peer.identity),
          peer.status,
          reactions.get(peer.identity)?.glyph ?? null,
          peer.nowPlaying ?? null,
          charCache,
          peer.identity,
          peer.characterIndex,
        );
      }

      // Local avatar (drawn last = on top)
      const me = worldToScreen(self.x, self.y, vp);
      drawAvatar(
        ctx,
        me.x,
        me.y,
        20,
        self.color,
        self.nickname,
        self.tableId != null,
        speakers.has(self.userId),
        self.status,
        reactions.get(LOCAL_CHAT_IDENTITY)?.glyph ?? null,
        self.nowPlaying ?? null,
        charCache,
        self.userId,
        self.characterIndex,
      );

      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(frame);
    };
  }, [map, dprCap]);

  return <canvas ref={canvasRef} tabIndex={0} />;
}

function drawDebugWalkable(
  ctx: CanvasRenderingContext2D,
  map: MapConfig,
  vp: { scale: number; offsetX: number; offsetY: number },
) {
  ctx.save();
  ctx.strokeStyle = "rgba(80,200,120,0.25)";
  ctx.lineWidth = 1;
  for (const r of map.walkable) {
    ctx.strokeRect(
      r.x * vp.scale + vp.offsetX,
      r.y * vp.scale + vp.offsetY,
      r.width * vp.scale,
      r.height * vp.scale,
    );
  }
  ctx.restore();
}

/** Subtle 32-world-unit grid drawn on top of a solid floor color.
 *  Aligned to world coordinates so the grid pans/zooms with the camera.
 *  Skipped when a bitmap floor is in use. */
function drawFloorGrid(
  ctx: CanvasRenderingContext2D,
  vp: { scale: number; offsetX: number; offsetY: number },
  map: MapConfig,
  floorX: number,
  floorY: number,
  floorW: number,
  floorH: number,
) {
  const step = 32 * vp.scale;
  if (step < 6) return; // would just look like noise at extreme zoom-out
  ctx.save();
  ctx.beginPath();
  ctx.rect(floorX, floorY, floorW, floorH);
  ctx.clip();

  // Grid offset so the lines align to map.bounds origin in world space.
  const startX =
    floorX + (((-map.bounds.x * vp.scale) % step) + step) % step;
  const startY =
    floorY + (((-map.bounds.y * vp.scale) % step) + step) % step;

  ctx.strokeStyle = "rgba(255,255,255,0.035)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x < floorX + floorW; x += step) {
    ctx.moveTo(Math.round(x) + 0.5, floorY);
    ctx.lineTo(Math.round(x) + 0.5, floorY + floorH);
  }
  for (let y = startY; y < floorY + floorH; y += step) {
    ctx.moveTo(floorX, Math.round(y) + 0.5);
    ctx.lineTo(floorX + floorW, Math.round(y) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

// Type-driven object rendering. Each branch is intentionally small —
// extending the visual style for a new type means adding a case here plus
// a SOLID_TYPES entry in domain/mapConfig.ts. Draw order matches the JSON
// order so authors can stack things (e.g. rug before chair).
function drawObjects(
  ctx: CanvasRenderingContext2D,
  map: MapConfig,
  vp: { scale: number; offsetX: number; offsetY: number },
  occupancy: Map<string, number>,
  highlightTable: string | null,
  highlightNoteIndex: number | null,
  sheets: Record<SpriteSheetKey, HTMLImageElement | null>,
) {
  // Two-pass: zones first (so dashed borders sit under solid objects), then
  // everything else in author order. Index is preserved so the note-highlight
  // index still matches map.objects[i].
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < map.objects.length; i++) {
      const obj = map.objects[i];
      const isZone = obj.type === "zone";
      if (pass === 0 ? !isZone : isZone) continue;
      const x = obj.x * vp.scale + vp.offsetX;
      const y = obj.y * vp.scale + vp.offsetY;
      const w = obj.width * vp.scale;
      const h = obj.height * vp.scale;
      const count = obj.type === "table" && obj.id ? occupancy.get(obj.id) ?? 0 : 0;
      const isHighlighted =
        (obj.type === "table" && obj.id != null && obj.id === highlightTable) ||
        (obj.type === "note" && i === highlightNoteIndex);
      // Per-object sprite resolution: explicit `obj.sprite` wins over the
      // per-type FURNITURE default. If a sprite is mapped AND its sheet is
      // loaded, draw it; otherwise fall through to the procedural fake-3D
      // renderer in mapDraw.ts.
      const rect = resolveSprite(obj.type, obj.sprite);
      const sheet = rect ? sheets[rect.sheet] : null;
      if (rect && sheet && sheet.complete && sheet.naturalWidth > 0) {
        drawSpriteObject(ctx, obj, x, y, w, h, count, isHighlighted, rect, sheet);
      } else {
        drawObject(ctx, obj, x, y, w, h, count, isHighlighted, vp.scale);
      }
    }
  }
}

/** Draw a furniture object as a pixel-art sprite scaled into its rect.
 *  Footprint shadow + label + highlight ring are preserved so the
 *  behavior matches the procedural path (occupancy ring on tables,
 *  pulse on highlighted tables, label text).
 *
 *  Special case: `rug` objects TILE the sprite cell instead of stretching
 *  it. A 320×240 carpet rect with a 16×16 source cell should repeat the
 *  cell ~20×15 times — stretching would produce one giant blurry pixel. */
function drawSpriteObject(
  ctx: CanvasRenderingContext2D,
  obj: MapObject,
  x: number,
  y: number,
  w: number,
  h: number,
  occupantCount: number,
  isHighlighted: boolean,
  rect: { sx: number; sy: number; sw: number; sh: number },
  sheet: HTMLImageElement,
) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (obj.type === "rug") {
    // Tile via an offscreen 1-cell canvas → CanvasPattern. No drop shadow
    // (rugs sit on the floor; a shadow would imply elevation).
    const tilePx = Math.max(1, Math.round(rect.sw));
    const off = document.createElement("canvas");
    off.width = tilePx;
    off.height = tilePx;
    const octx = off.getContext("2d");
    if (octx) {
      octx.imageSmoothingEnabled = false;
      octx.drawImage(sheet, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, tilePx, tilePx);
      const pat = ctx.createPattern(off, "repeat");
      if (pat) {
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    }
  } else {
    // Drop shadow so the sprite lifts off the floor.
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(x + 2, y + 4, w, h);
    // Sprite scaled to the object's rect, nearest-neighbor.
    ctx.drawImage(sheet, rect.sx, rect.sy, rect.sw, rect.sh, x, y, w, h);
  }
  // Highlights stack the same way as the procedural table path.
  if (isHighlighted) {
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 250);
    ctx.strokeStyle = `rgba(255, 220, 80, ${pulse.toFixed(3)})`;
    ctx.lineWidth = 3;
    ctx.strokeRect(x - 4, y - 4, w + 8, h + 8);
  } else if (occupantCount > 0) {
    ctx.strokeStyle = "rgba(255, 170, 60, 0.85)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
  }
  if (obj.label) {
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.font = "11px system-ui";
    const text = occupantCount > 0 ? `${obj.label} (${occupantCount})` : obj.label;
    const tw = ctx.measureText(text).width + 8;
    ctx.fillRect(x + w / 2 - tw / 2, y + h + 2, tw, 14);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + w / 2, y + h + 9);
  }
  ctx.restore();
}

/** Lazy character image loader. Returns the cached HTMLImageElement for
 *  an identity, kicking off a fetch on first call. When `characterIndex`
 *  is provided (peer/self picked a sprite), it overrides the
 *  identity-hash fallback so old clients still get a stable sprite while
 *  picker-aware clients use the explicit choice. */
function getOrLoadChar(
  cache: Map<string, HTMLImageElement> | null,
  identity: string,
  characterIndex?: number,
): HTMLImageElement | null {
  if (!cache) return null;
  const url =
    typeof characterIndex === "number"
      ? charUrlFromIndex(characterIndex)
      : charUrlForIdentity(identity);
  let img = cache.get(url) ?? null;
  if (!img) {
    img = new Image();
    img.src = url;
    cache.set(url, img);
  }
  return img;
}

function drawAvatar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  label: string,
  seated: boolean,
  speaking: boolean = false,
  status: AvatarStatus = "available",
  reactionGlyph: string | null = null,
  nowPlaying: string | null = null,
  charCache: Map<string, HTMLImageElement> | null = null,
  identity: string = "",
  characterIndex: number | undefined = undefined,
) {
  ctx.save();
  // Presence status ring: thin colored ring tight to the avatar. Drawn
  // before the seated marker so seated/speaking rings stack outside it.
  const meta = statusMeta(status);
  ctx.strokeStyle = meta.ringColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.stroke();
  // Seated marker: a small chair-back ring behind the avatar.
  if (seated) {
    ctx.strokeStyle = "rgba(255, 200, 80, 0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, r + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Active-speaker ring: pulsing green halo outside the seated marker.
  // Pulse period ≈1s; alpha 0.45..0.95.
  if (speaking) {
    const t = performance.now() / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI);
    const alpha = 0.45 + 0.5 * pulse;
    const extra = 10 + 2 * pulse;
    ctx.strokeStyle = `rgba(80, 220, 120, ${alpha.toFixed(3)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, r + extra, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Avatar body: pixel-art character sprite if cached; load on first
  // request, fall back to the colored disc until it arrives. Picker-aware
  // peers publish `characterIndex` and get the explicit sprite; older
  // peers fall back to the identity-hash sprite.
  const charImg = identity
    ? getOrLoadChar(charCache, identity, characterIndex)
    : null;
  if (charImg && charImg.complete && charImg.naturalWidth > 0) {
    // Pixel chars are 16×16; draw 2.4× the legacy disc radius tall to
    // keep similar visual weight, then anchor so the feet sit near +r.
    const drawSize = Math.round(r * 2.4);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      charImg,
      Math.round(x - drawSize / 2),
      Math.round(y - drawSize * 0.65),
      drawSize,
      drawSize,
    );
  } else {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.font = "12px system-ui";
  const text = label;
  const metrics = ctx.measureText(text);
  const pad = 4;
  const tw = metrics.width + pad * 2;
  ctx.fillRect(x - tw / 2, y - r - 18, tw, 16);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y - r - 10);

  // Floating reaction glyph: a small bubble above the nameplate, fades over
  // its 2s lifetime. The store cleans up expired entries so this just paints
  // whatever is live this frame.
  if (reactionGlyph) {
    ctx.font = "22px system-ui, 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif";
    ctx.fillStyle = "#fff";
    ctx.fillText(reactionGlyph, x, y - r - 36);
  }

  // Now-playing chip below the avatar (M7). Truncated to fit visually.
  if (nowPlaying && nowPlaying.length > 0) {
    const trimmed = nowPlaying.length > 28 ? nowPlaying.slice(0, 27) + "…" : nowPlaying;
    const displayText = `♪ ${trimmed}`;
    ctx.font = "11px system-ui";
    const m = ctx.measureText(displayText);
    const padX = 5;
    const padY = 2;
    const chipW = m.width + padX * 2;
    const chipH = 12 + padY * 2;
    const cx = x - chipW / 2;
    const cy = y + r + 8;
    ctx.fillStyle = "rgba(40, 70, 110, 0.85)";
    ctx.fillRect(cx, cy, chipW, chipH);
    ctx.fillStyle = "rgba(220, 235, 255, 0.95)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(displayText, x, cy + chipH / 2);
  }
  ctx.restore();
}

/** Count seated participants per table id, across local self + remote peers.
 *  Used by the table renderer to recolor and label "(N)". */
function computeOccupancy(state: {
  self: { tableId: string | null } | null;
  peers: Map<string, { tableId: string | null }>;
}): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (id: string | null) => {
    if (!id) return;
    out.set(id, (out.get(id) ?? 0) + 1);
  };
  bump(state.self?.tableId ?? null);
  for (const p of state.peers.values()) bump(p.tableId);
  return out;
}
