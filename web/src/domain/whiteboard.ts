// Whiteboard (P1-C: discussion-zone shared board) — pure domain logic.
//
// Contract: docs/contracts.md "Whiteboard (P1-C: discussion-zone shared
// board)". One board per discussion zone (`wb:<room>:<zoneId>`), sync via
// debounced reliable data-channel broadcast + REST snapshots, last-write-
// wins on `updated_at` (epoch ms, strictly greater wins).
//
// This module is framework-free so it stays in the first-screen bundle:
// NOTHING here may import `@excalidraw/excalidraw` (lazy-load mandate,
// contract §5). Scenes are plain JSON values; the panel maps them onto
// Excalidraw types at the edge.

import type { ZoneKind } from "../types/mapConfig";

/** Wire type tags, verbatim per contract §2(a) / §4. */
export const WB_UPDATE_TYPE = "wb_update" as const;
export const WB_CLEAR_TYPE = "wb_clear" as const;

/** Frozen perf constants (contract §5). Debounce floor == rate-cap
 *  interval by construction: at most one broadcast per 500 ms, and the
 *  broadcast always carries the *latest* scene, so no token bucket. */
export const WB_DEBOUNCE_MS = 500 as const;
export const WB_MAX_BROADCAST_HZ = 2 as const;

/** Frozen snapshot cap (contract §5): serialized `scene_json` UTF-8 bytes
 *  on PUT; over it the server returns 413. The client refuses to broadcast
 *  over-cap scenes too. */
export const WHITEBOARD_MAX_SNAPSHOT_BYTES = 262144 as const; // 256 KiB

/** Excalidraw scene as plain JSON: `{elements, appState, files}` per
 *  contract §2(a). Kept as `unknown` so this module never depends on
 *  Excalidraw types (see header note). */
export interface WhiteboardScene {
  elements: unknown[];
  appState?: unknown;
  files?: unknown;
}

/** `wb_update` message. `from` is the data-channel sender identity — it is
 *  NOT on the wire (contract §2(a) keys are verbatim; the channel provides
 *  the sender); it is populated by the receive path for blockList checks. */
export interface WbUpdateMessage {
  type: typeof WB_UPDATE_TYPE;
  board: string;
  zone_id: string;
  updated_at: number;
  scene: WhiteboardScene;
  from?: string;
}

/** `wb_clear` message (server fan-out, contract §4). */
export interface WbClearMessage {
  type: typeof WB_CLEAR_TYPE;
  board: string;
  zone_id: string;
  updated_at: number;
  from?: string;
}

export type WbMessage = WbUpdateMessage | WbClearMessage;

/** Board id, verbatim per contract §1: `wb:<room>:<zoneId>`. room and
 *  zoneId each max 64 chars per the zone contract. */
export function whiteboardId(room: string, zoneId: string): string {
  return `wb:${room}:${zoneId}`;
}

/** True when `board` is exactly the id expected for `(room, zoneId)`.
 *  The receiver uses this to drop malformed boards (contract §2c). */
export function isWellFormedBoardId(
  board: unknown,
  room: string,
  zoneId: string,
): boolean {
  return typeof board === "string" && board === whiteboardId(room, zoneId);
}

/** Whiteboards exist only in `discussion` zones (contract §1: never in
 *  `silent` / `rest` / `none`). */
export function whiteboardAllowedIn(kind: ZoneKind): boolean {
  return kind === "discussion";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeWbUpdate(msg: WbMessage): Uint8Array {
  // Raw JSON bytes, same as the M2 kick notice: first byte is `{` (0x7b),
  // which the receiver's dispatch uses to route JSON payloads.
  return encoder.encode(
    JSON.stringify({
      type: msg.type,
      board: msg.board,
      zone_id: msg.zone_id,
      updated_at: msg.updated_at,
      ...(msg.type === WB_UPDATE_TYPE
        ? { scene: (msg as WbUpdateMessage).scene }
        : {}),
    }),
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function validUpdatedAt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function validScene(v: unknown): v is WhiteboardScene {
  return isRecord(v) && Array.isArray(v.elements);
}

/** Decode a received payload into a whiteboard message, or null when the
 *  payload is not a well-formed `wb_update` / `wb_clear`. Never throws. */
export function decodeWbMessage(data: Uint8Array): WbMessage | null {
  if (data.length === 0 || data[0] !== 0x7b /* '{' */) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(data));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { type, board, zone_id, updated_at, scene, from } = parsed;
  if (type !== WB_UPDATE_TYPE && type !== WB_CLEAR_TYPE) return null;
  if (typeof board !== "string" || board.length === 0) return null;
  if (typeof zone_id !== "string" || zone_id.length === 0) return null;
  if (!validUpdatedAt(updated_at)) return null;
  const base = { board, zone_id, updated_at };
  if (type === WB_CLEAR_TYPE) {
    return {
      type,
      ...base,
      ...(typeof from === "string" ? { from } : {}),
    };
  }
  if (!validScene(scene)) return null;
  return {
    type,
    ...base,
    scene,
    ...(typeof from === "string" ? { from } : {}),
  };
}

/** LWW arbiter (contract §2c): strictly greater wins. Equal or older is
 *  ignored — rebroadcasts are idempotent. */
export function lwwShouldApply(
  localUpdatedAt: number,
  msgUpdatedAt: number,
): boolean {
  return msgUpdatedAt > localUpdatedAt;
}

export type WbInboundVerdict =
  | "apply"
  | "ignore-malformed"
  | "ignore-blocked"
  | "ignore-zone"
  | "ignore-stale";

export interface WbInboundContext {
  /** The room name this client joined. */
  room: string;
  /** The receiver's current zone id (`""` when zone-less). */
  myZoneId: string;
  /** `updated_at` of the scene this client currently holds. */
  localUpdatedAt: number;
  /** True when the sender identity is on the local M2 block list. */
  fromBlocked: boolean;
}

/** Receiver-side decision for one inbound whiteboard message (contract
 *  §2c + §4): zone filter, malformed-board filter, M2 blockList filter,
 *  then LWW. Pure — the caller maps the verdict to actions. */
export function decideWbInbound(
  msg: WbMessage | null,
  ctx: WbInboundContext,
): WbInboundVerdict {
  if (msg == null) return "ignore-malformed";
  if (ctx.fromBlocked) return "ignore-blocked";
  if (msg.zone_id !== ctx.myZoneId) return "ignore-zone";
  if (!isWellFormedBoardId(msg.board, ctx.room, msg.zone_id)) {
    return "ignore-malformed";
  }
  if (!lwwShouldApply(ctx.localUpdatedAt, msg.updated_at)) {
    return "ignore-stale";
  }
  return "apply";
}

/** True when the serialized scene would exceed the snapshot cap
 *  (contract §5). Measured in UTF-8 bytes, like the server. */
export function sceneJsonOverCap(sceneJson: string): boolean {
  return encoder.encode(sceneJson).byteLength > WHITEBOARD_MAX_SNAPSHOT_BYTES;
}

/** UTF-8 byte length of a string (for the snapshot cap check). */
export function utf8ByteLength(s: string): number {
  return encoder.encode(s).byteLength;
}

// ---------------------------------------------------------------------------
// Broadcast scheduler: debounce + rate cap (contract §2a).
//
// `WB_DEBOUNCE_MS = 500` is both the debounce floor and the 2 Hz rate-cap
// interval: each `schedule()` stores the latest scene and restarts the
// timer, so at most one broadcast fires per 500 ms and it always carries
// the newest scene. `cancel()` stops a pending timer — the sender MUST
// call it on zone exit so a delayed timer never fires after leaving the
// zone (contract §3).

export interface WbScheduler {
  /** Record a local edit; the latest scene is broadcast after the debounce
   *  window. Restarts the window when called again within 500 ms. */
  schedule(sceneJson: string): void;
  /** Drop the pending broadcast without firing (zone exit / panel close). */
  cancel(): void;
  /** True while a broadcast is pending. */
  readonly pending: boolean;
}

export interface WbSchedulerClock {
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
}

export function createWbBroadcastScheduler(
  onFire: (sceneJson: string) => void,
  debounceMs: number = WB_DEBOUNCE_MS,
  clock: WbSchedulerClock = {},
): WbScheduler {
  const setTimeoutFn = clock.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = clock.clearTimeoutFn ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: string | null = null;

  return {
    get pending() {
      return timer != null;
    },
    schedule(sceneJson: string) {
      latest = sceneJson;
      if (timer != null) clearTimeoutFn(timer);
      timer = setTimeoutFn(() => {
        timer = null;
        const scene = latest;
        latest = null;
        if (scene != null) onFire(scene);
      }, debounceMs);
    },
    cancel() {
      if (timer != null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      latest = null;
    },
  };
}
