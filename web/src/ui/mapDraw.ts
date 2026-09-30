import type { MapObject, MapObjectType } from "../types/mapConfig";

/** Default visual extrusion per type, in world units. Renderer draws solid
 *  objects as fake-3D boxes (top + visible south + west side faces). Set
 *  `elevation` on the MapObject to override. 0 = flat. */
export const DEFAULT_ELEVATIONS: Partial<Record<MapObjectType, number>> = {
  wall:    12,
  cabinet: 14,
  table:    6,
  desk:     5,
  chair:    3,
  // plant intentionally flat — the round leaf canopy already implies depth.
  // rug / door / zone / note / portal / board stay flat.
};

/** Type-driven 2D renderer for procedural map objects. Shared between
 *  SpatialCanvas (in-game) and MapEditorScreen (authoring).
 *
 *  `scale` is the viewport pixels-per-world-unit factor; used to convert
 *  the per-object `elevation` (in world units) into screen pixels for the
 *  oblique projection. Defaults to 1 for callers that don't have a vp. */
export function drawObject(
  ctx: CanvasRenderingContext2D,
  obj: MapObject,
  x: number,
  y: number,
  w: number,
  h: number,
  occupantCount: number,
  isHighlighted: boolean,
  scale: number = 1,
  /** Painted-background mode: the bitmap already shows the zone's look —
   *  draw only the label chip, no tint fill or dashed border. */
  paintedBg: boolean = false,
): void {
  const elevPx =
    (obj.elevation ?? DEFAULT_ELEVATIONS[obj.type] ?? 0) * scale;
  ctx.save();
  switch (obj.type) {
    case "wall": {
      const wallTop = obj.color ?? "#1f242d";
      const { topX, topY } = drawExtrudedSides(ctx, x, y, w, h, elevPx, wallTop);
      // Wall body with vertical gradient — slightly lighter at the top to
      // suggest a beveled cap.
      const grad = ctx.createLinearGradient(topX, topY, topX, topY + h);
      grad.addColorStop(0, lighten(wallTop, 0.10));
      grad.addColorStop(0.18, wallTop);
      grad.addColorStop(1, darken(wallTop, 0.18));
      ctx.fillStyle = grad;
      ctx.fillRect(topX, topY, w, h);
      // Inner top-edge highlight (1px) to catch the eye like baseboard trim.
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.fillRect(topX, topY, w, 1);
      // Outer hairline.
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(topX + 0.5, topY + 0.5, w - 1, h - 1);
      break;
    }
    case "table":
    case "desk": {
      const baseFill = obj.color ?? "#8a6a45";
      const fill = occupantCount > 0 ? "#a87a3a" : baseFill;
      const { topX, topY } = drawExtrudedSides(ctx, x, y, w, h, elevPx, fill);
      // Body with a top-light vertical gradient (wood-grain feel) on the
      // top face.
      const grad = ctx.createLinearGradient(topX, topY, topX, topY + h);
      grad.addColorStop(0, lighten(fill, 0.14));
      grad.addColorStop(0.5, fill);
      grad.addColorStop(1, darken(fill, 0.16));
      ctx.fillStyle = grad;
      roundRect(ctx, topX, topY, w, h, 6);
      ctx.fill();
      // Specular highlight strip near the top edge.
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      roundRect(ctx, topX + 2, topY + 2, w - 4, Math.max(2, h * 0.08), 3);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 1.25;
      roundRect(ctx, topX + 0.5, topY + 0.5, w - 1, h - 1, 6);
      ctx.stroke();

      if (isHighlighted) {
        const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 250);
        ctx.strokeStyle = `rgba(255, 220, 80, ${pulse.toFixed(3)})`;
        ctx.lineWidth = 3;
        roundRect(ctx, topX - 4, topY - 4, w + 8, h + 8, 8);
        ctx.stroke();
      } else if (occupantCount > 0) {
        ctx.strokeStyle = "rgba(255, 170, 60, 0.85)";
        ctx.lineWidth = 2;
        roundRect(ctx, topX - 2, topY - 2, w + 4, h + 4, 7);
        ctx.stroke();
      }

      if (obj.label) {
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.font = `${Math.max(11, Math.min(16, h * 0.28))}px system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const label = occupantCount > 0
          ? `${obj.label}  (${occupantCount})`
          : obj.label;
        ctx.fillText(label, topX + w / 2, topY + h / 2);
      }
      break;
    }
    case "chair": {
      const fill = obj.color ?? "#5d4632";
      const { topX, topY } = drawExtrudedSides(ctx, x, y, w, h, elevPx, fill);
      const grad = ctx.createLinearGradient(topX, topY, topX, topY + h);
      grad.addColorStop(0, lighten(fill, 0.12));
      grad.addColorStop(1, darken(fill, 0.14));
      ctx.fillStyle = grad;
      roundRect(ctx, topX, topY, w, h, 4);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
      break;
    }
    case "plant": {
      ctx.fillStyle = obj.color ?? "#5a3a1e";
      const potH = h * 0.35;
      ctx.fillRect(x + w * 0.2, y + h - potH, w * 0.6, potH);
      ctx.fillStyle = "#5db86b";
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h * 0.4, Math.min(w, h) * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.lineWidth = 1;
      ctx.stroke();
      break;
    }
    case "cabinet": {
      const fill = obj.color ?? "#4a4030";
      const { topX, topY } = drawExtrudedSides(ctx, x, y, w, h, elevPx, fill);
      // Body.
      const grad = ctx.createLinearGradient(topX, topY, topX, topY + h);
      grad.addColorStop(0, lighten(fill, 0.10));
      grad.addColorStop(1, darken(fill, 0.12));
      ctx.fillStyle = grad;
      ctx.fillRect(topX, topY, w, h);
      // Door split + inset shadow lines.
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(topX + 0.5, topY + 0.5, w / 2 - 0.5, h - 1);
      ctx.strokeRect(topX + w / 2 + 0.5, topY + 0.5, w / 2 - 1, h - 1);
      // Tiny knobs.
      ctx.fillStyle = "rgba(220,210,180,0.85)";
      ctx.beginPath();
      ctx.arc(topX + w / 2 - 4, topY + h / 2, 1.6, 0, Math.PI * 2);
      ctx.arc(topX + w / 2 + 4, topY + h / 2, 1.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "rug": {
      const fill = obj.color ?? "#3a4250";
      // Soft outer shadow so the rug feels woven onto the floor.
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(x + 1, y + 2, w, h);
      // Body with subtle radial darkening to suggest pile texture.
      const cx = x + w / 2;
      const cy = y + h / 2;
      const grad = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.1, cx, cy, Math.max(w, h) * 0.7);
      grad.addColorStop(0, lighten(fill, 0.10));
      grad.addColorStop(1, darken(fill, 0.10));
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);
      // Inner border ribbon.
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 3.5, y + 3.5, w - 7, h - 7);
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      break;
    }
    case "door": {
      ctx.fillStyle = obj.color ?? "rgba(212,166,74,0.5)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(212,166,74,0.9)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x, y, w, h);
      break;
    }
    case "zone": {
      // Non-solid named area. Soft tint + dashed border so it visually
      // recedes behind solid objects. Label rendered as a chip at the top-
      // left corner — easy to read regardless of zoom. In painted-background
      // mode the artwork already communicates the zone, so only the chip
      // is drawn.
      if (!paintedBg) {
        const tint = obj.color ?? "rgba(0, 122, 255, 0.10)";
        ctx.fillStyle = tint;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "rgba(0, 122, 255, 0.55)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        ctx.setLineDash([]);
      }
      if (obj.label && obj.label.length > 0) {
        const fontSize = 12;
        ctx.font = `600 ${fontSize}px system-ui`;
        const padX = 6;
        const padY = 3;
        const text = obj.label;
        const tw = ctx.measureText(text).width;
        const chipH = fontSize + padY * 2;
        const chipW = tw + padX * 2;
        const cx = x + 6;
        const cy = y + 6;
        ctx.fillStyle = "rgba(14, 17, 22, 0.78)";
        roundRect(ctx, cx, cy, chipW, chipH, 4);
        ctx.fill();
        ctx.fillStyle = "rgba(230, 240, 255, 0.95)";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(text, cx + padX, cy + chipH / 2);
      }
      break;
    }
    case "note": {
      // Sticky-note look: warm yellow fill, slight tilt suggestion via inner
      // border, "📝" glyph + label/preview centered.
      const fill = obj.color ?? "#f7e08a";
      ctx.fillStyle = fill;
      roundRect(ctx, x, y, w, h, 4);
      ctx.fill();
      ctx.strokeStyle = "rgba(120, 90, 0, 0.45)";
      ctx.lineWidth = 1;
      ctx.stroke();
      // Highlight ring when avatar is nearby so it visually invites "press F".
      if (isHighlighted) {
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
        ctx.strokeStyle = `rgba(255, 200, 0, ${pulse.toFixed(3)})`;
        ctx.lineWidth = 3;
        roundRect(ctx, x - 4, y - 4, w + 8, h + 8, 7);
        ctx.stroke();
      }
      // Glyph + preview text (clamped to ~14 chars to avoid overflow).
      const preview = obj.label && obj.label.length > 0
        ? obj.label
        : (obj.text ?? "Note").slice(0, 14);
      ctx.fillStyle = "rgba(60, 40, 0, 0.92)";
      ctx.font = `${Math.max(10, Math.min(14, h * 0.3))}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`📝 ${preview}`, x + w / 2, y + h / 2);
      break;
    }
    default: {
      ctx.fillStyle = obj.color ?? "#666";
      ctx.fillRect(x, y, w, h);
      break;
    }
    case "board": {
      // Notice-board sprite: cork-textured fill with two "tacks" + a label
      // chip indicating the repo. Walkable. F-to-interact when nearby.
      // In painted-background mode the artwork already shows the board —
      // draw only the label chip and the proximity highlight ring.
      if (!paintedBg) {
        const fill = obj.color ?? "#8a5a2b";
        ctx.fillStyle = fill;
        roundRect(ctx, x, y, w, h, 4);
        ctx.fill();
        ctx.strokeStyle = "rgba(40, 24, 8, 0.9)";
        ctx.lineWidth = 2;
        ctx.stroke();
        // Tacks
        for (const tx of [x + 8, x + w - 8]) {
          ctx.beginPath();
          ctx.arc(tx, y + 8, 3, 0, Math.PI * 2);
          ctx.fillStyle = "#d63a3a";
          ctx.fill();
        }
      }
      if (isHighlighted) {
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
        ctx.strokeStyle = `rgba(255, 200, 0, ${pulse.toFixed(3)})`;
        ctx.lineWidth = 3;
        roundRect(ctx, x - 4, y - 4, w + 8, h + 8, 7);
        ctx.stroke();
      }
      // Repo / label chip
      const text = obj.label && obj.label.length > 0
        ? obj.label
        : (obj.repo ?? "Connect GitHub");
      const fontSize = Math.max(10, Math.min(13, h * 0.22));
      ctx.font = `600 ${fontSize}px system-ui`;
      const tw = ctx.measureText(text).width;
      const chipW = Math.min(w - 12, tw + 12);
      const chipH = fontSize + 6;
      const chipX = x + (w - chipW) / 2;
      const chipY = y + h / 2 - chipH / 2;
      ctx.fillStyle = "rgba(14, 17, 22, 0.85)";
      roundRect(ctx, chipX, chipY, chipW, chipH, 4);
      ctx.fill();
      ctx.fillStyle = "rgba(230, 240, 255, 0.95)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // Clip to chip width
      ctx.save();
      ctx.beginPath();
      ctx.rect(chipX, chipY, chipW, chipH);
      ctx.clip();
      ctx.fillText(text, x + w / 2, chipY + chipH / 2);
      ctx.restore();
      break;
    }
    case "portal": {
      // Animated swirl: two rotating dashed rings + radial gradient core.
      // Walkable (not in SOLID_TYPES). Label shows destination, when set.
      const cx = x + w / 2;
      const cy = y + h / 2;
      const r = Math.max(6, Math.min(w, h) / 2 - 4);
      const t = performance.now() / 1000;

      const grad = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
      grad.addColorStop(0, obj.color ?? "rgba(170, 120, 255, 0.85)");
      grad.addColorStop(1, "rgba(80, 40, 160, 0.05)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.8);
      ctx.strokeStyle = "rgba(220, 200, 255, 0.7)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-t * 1.4);
      ctx.strokeStyle = "rgba(170, 120, 255, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 8]);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      ctx.setLineDash([]);

      const label = obj.label
        ?? obj.destination?.label
        ?? (obj.destination?.mapUrl ? "Portal" : "Portal (no destination)");
      const fontSize = Math.max(11, Math.min(13, w * 0.12));
      ctx.font = `600 ${fontSize}px system-ui`;
      const tw = ctx.measureText(label).width;
      const padX = 6;
      const padY = 3;
      const chipW = tw + padX * 2;
      const chipH = fontSize + padY * 2;
      const chipX = cx - chipW / 2;
      const chipY = y + h + 4;
      ctx.fillStyle = "rgba(14, 17, 22, 0.82)";
      roundRect(ctx, chipX, chipY, chipW, chipH, 4);
      ctx.fill();
      ctx.fillStyle = "rgba(230, 220, 255, 0.95)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, chipY + chipH / 2);
      break;
    }
  }
  ctx.restore();
}

/** Draw the floor shadow + visible south/west side faces for an oblique
 *  "fake-3D" extrusion of a footprint at (x, y, w, h) raised by `elevPx`
 *  screen pixels. The caller is responsible for drawing the top face
 *  (with whatever per-type decoration it wants) at the returned
 *  (topX, topY, w, h). The shadow is drawn even when `elevPx === 0` so
 *  flat objects still feel grounded.
 *
 *  Projection: elevating by 1 world-unit moves the screen point by
 *  (+0.4, -0.6) pixels. Top face shifts up-and-to-the-right; the south
 *  and west faces are visible. East/north faces are hidden behind the
 *  top. This matches a camera in the lower-left (Gather-like). */
function drawExtrudedSides(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  elevPx: number,
  topFill: string,
): { topX: number; topY: number } {
  // Footprint shadow — sells the object as sitting ON the floor.
  ctx.fillStyle = "rgba(0,0,0,0.30)";
  ctx.fillRect(x + 2, y + 4, w, h);
  if (elevPx <= 0) {
    return { topX: x, topY: y };
  }
  const dx = elevPx * 0.4;
  const dy = -elevPx * 0.6;
  // South face (between bottom of top and bottom of footprint).
  ctx.fillStyle = darken(topFill, 0.42);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w + dx, y + h + dy);
  ctx.lineTo(x + dx, y + h + dy);
  ctx.closePath();
  ctx.fill();
  // West face (between left of top and left of footprint).
  ctx.fillStyle = darken(topFill, 0.28);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x + dx, y + h + dy);
  ctx.lineTo(x + dx, y + dy);
  ctx.closePath();
  ctx.fill();
  return { topX: x + dx, topY: y + dy };
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Parse a CSS hex color (#rgb, #rrggbb) or rgb(a) string into [r,g,b]
 *  in 0..1. Falls back to medium grey if the input is unrecognised. The
 *  alpha channel is intentionally dropped — the gradient helpers below
 *  apply their own alpha. */
function parseColor(c: string): [number, number, number] {
  const s = c.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return [r / 255, g / 255, b / 255];
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return [r / 255, g / 255, b / 255];
    }
  }
  const m = s.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
  if (m) {
    return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  }
  return [0.5, 0.5, 0.5];
}

function toHex(c: [number, number, number]): string {
  const r = Math.max(0, Math.min(255, Math.round(c[0] * 255)));
  const g = Math.max(0, Math.min(255, Math.round(c[1] * 255)));
  const b = Math.max(0, Math.min(255, Math.round(c[2] * 255)));
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Lighten a CSS color by `amt` (0..1) toward white. */
export function lighten(color: string, amt: number): string {
  const [r, g, b] = parseColor(color);
  return toHex([
    r + (1 - r) * amt,
    g + (1 - g) * amt,
    b + (1 - b) * amt,
  ]);
}

/** Darken a CSS color by `amt` (0..1) toward black. */
export function darken(color: string, amt: number): string {
  const [r, g, b] = parseColor(color);
  return toHex([r * (1 - amt), g * (1 - amt), b * (1 - amt)]);
}
