import type { MapConfig } from "../types/mapConfig";

export interface CameraViewport {
  scale: number;
  // World -> screen offset, applied as: screenX = worldX * scale + offsetX
  offsetX: number;
  offsetY: number;
  viewportW: number;
  viewportH: number;
}

// Computes a "cover" scale + camera offset that follows the local avatar while
// clamping at map edges. Kept intentionally simple (no spring smoothing yet).
export function computeViewport(
  viewportW: number,
  viewportH: number,
  followPos: { x: number; y: number },
  map: MapConfig,
): CameraViewport {
  const scale = Math.max(
    viewportW / map.bounds.width,
    viewportH / map.bounds.height,
  );
  const worldW = map.bounds.width * scale;
  const worldH = map.bounds.height * scale;

  // Center on player, clamp so we never reveal void past the map edge.
  let offsetX = viewportW / 2 - followPos.x * scale;
  let offsetY = viewportH / 2 - followPos.y * scale;
  const minOffsetX = viewportW - worldW - map.bounds.x * scale;
  const minOffsetY = viewportH - worldH - map.bounds.y * scale;
  const maxOffsetX = -map.bounds.x * scale;
  const maxOffsetY = -map.bounds.y * scale;
  offsetX = clamp(offsetX, Math.min(minOffsetX, maxOffsetX), Math.max(minOffsetX, maxOffsetX));
  offsetY = clamp(offsetY, Math.min(minOffsetY, maxOffsetY), Math.max(minOffsetY, maxOffsetY));

  return { scale, offsetX, offsetY, viewportW, viewportH };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Focus cocoon (contracts.md "Pixel-art tilemap" §6): a zoomed variant of
 *  `computeViewport` that pushes the camera toward `zoom`× centered on
 *  `focusPos` (the seated table), clamped at map edges like the base
 *  viewport. Pure — the render loop lerps a live multiplier toward the
 *  target and calls this each frame. */
export function computeZoomedViewport(
  viewportW: number,
  viewportH: number,
  focusPos: { x: number; y: number },
  map: MapConfig,
  zoom: number,
): CameraViewport {
  const base = computeViewport(viewportW, viewportH, focusPos, map);
  const scale = base.scale * zoom;
  const worldW = map.bounds.width * scale;
  const worldH = map.bounds.height * scale;
  let offsetX = viewportW / 2 - focusPos.x * scale;
  let offsetY = viewportH / 2 - focusPos.y * scale;
  const minOffsetX = viewportW - worldW - map.bounds.x * scale;
  const minOffsetY = viewportH - worldH - map.bounds.y * scale;
  const maxOffsetX = -map.bounds.x * scale;
  const maxOffsetY = -map.bounds.y * scale;
  offsetX = clamp(offsetX, Math.min(minOffsetX, maxOffsetX), Math.max(minOffsetX, maxOffsetX));
  offsetY = clamp(offsetY, Math.min(minOffsetY, maxOffsetY), Math.max(minOffsetY, maxOffsetY));
  return { scale, offsetX, offsetY, viewportW, viewportH };
}

export function worldToScreen(
  x: number,
  y: number,
  vp: CameraViewport,
): { x: number; y: number } {
  return { x: x * vp.scale + vp.offsetX, y: y * vp.scale + vp.offsetY };
}
