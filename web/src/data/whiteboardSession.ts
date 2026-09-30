// Whiteboard (P1-C) client session — the glue between the Excalidraw
// panel, the LiveKit data channel, and the REST snapshot endpoints.
//
// Contract: docs/contracts.md "Whiteboard (P1-C: discussion-zone shared
// board)" §2–§4. At most one board session is open at a time (the panel is
// zone-gated: only one discussion zone is visible at once). The session
// owns:
//
// - the debounce scheduler (§2a): Excalidraw `onChange` → `noteLocalEdit`
//   → at most one broadcast per 500 ms carrying the latest scene;
// - the broadcast: `publishReliable` (same as chat) + a best-effort PUT
//   riding the same debounce timer (§2b);
// - snapshot pulls on open / room rejoin / data-channel reconnect (§2b);
// - the remote-scene / remote-clear event fan-out the panel subscribes to
//   (the data-channel receive path in JoinScreen decides "apply" via the
//   pure `decideWbInbound` and calls `applyRemoteUpdate` / `applyRemoteClear`
//   here).
//
// The sender-side zone gate lives here too: `closeSession()` cancels the
// pending debounce timer, so a delayed timer can never fire after the
// user left the zone (contract §3). The caller (SyncleScreen) closes the
// session on every zone crossing out of `discussion`.

import type { Room } from "livekit-client";
import { publishReliable } from "./liveKitService";
import {
  clearBoard,
  getSnapshot,
  putSnapshot,
  type WhiteboardSnapshot,
} from "./whiteboardApi";
import {
  WHITEBOARD_MAX_SNAPSHOT_BYTES,
  createWbBroadcastScheduler,
  encodeWbUpdate,
  lwwShouldApply,
  sceneJsonOverCap,
  utf8ByteLength,
  whiteboardId,
  WB_UPDATE_TYPE,
  type WbScheduler,
  type WhiteboardScene,
} from "../domain/whiteboard";

export interface WhiteboardSessionOpen {
  /** LiveKit room (swapped by `reattachRoom` on reconnect). */
  livekitRoom: Room;
  /** Room name for board ids + REST paths. */
  room: string;
  /** Discussion zone id this board belongs to. */
  zoneId: string;
  backendUrl: string;
  /** LiveKit join token (bearer for the whiteboard REST endpoints). */
  token: string;
  userId: string;
}

interface WhiteboardSession extends WhiteboardSessionOpen {
  board: string;
  localUpdatedAt: number;
  scheduler: WbScheduler;
  /** Last scene the remote side applied (serialized) — suppresses the
   *  onChange echo that Excalidraw fires when we call `updateScene`. */
  lastRemoteSceneJson: string | null;
  /** Snapshot scene applied at open/reattach, for the panel's initialData. */
  initialScene: WhiteboardScene | null;
  disposed: boolean;
}

let session: WhiteboardSession | null = null;

type SceneListener = (scene: WhiteboardScene, updatedAt: number) => void;
type ClearListener = (updatedAt: number) => void;
const sceneListeners = new Set<SceneListener>();
const clearListeners = new Set<ClearListener>();

/** Read-only view of the open session for the data-channel receive path. */
export function getOpenWhiteboard(): {
  room: string;
  zoneId: string;
  board: string;
  localUpdatedAt: number;
} | null {
  if (!session || session.disposed) return null;
  return {
    room: session.room,
    zoneId: session.zoneId,
    board: session.board,
    localUpdatedAt: session.localUpdatedAt,
  };
}

export function subscribeWbScene(listener: SceneListener): () => void {
  sceneListeners.add(listener);
  return () => {
    sceneListeners.delete(listener);
  };
}

export function subscribeWbClear(listener: ClearListener): () => void {
  clearListeners.add(listener);
  return () => {
    clearListeners.delete(listener);
  };
}

/** Snapshot scene loaded by the open pull, for the panel's initialData
 *  (avoids a race when the GET resolves before the panel subscribes). */
export function getWbInitialScene(): {
  scene: WhiteboardScene;
  updatedAt: number;
} | null {
  if (!session || session.disposed || !session.initialScene) return null;
  return { scene: session.initialScene, updatedAt: session.localUpdatedAt };
}

/** Open a board session for a discussion zone. Closes any prior session
 *  first. Pulls the REST snapshot (contract §2b) and applies it when
 *  newer than the (empty) local scene. */
export function openWhiteboardSession(opts: WhiteboardSessionOpen): void {
  closeWhiteboardSession();
  const s: WhiteboardSession = {
    ...opts,
    board: whiteboardId(opts.room, opts.zoneId),
    localUpdatedAt: 0,
    lastRemoteSceneJson: null,
    initialScene: null,
    disposed: false,
    scheduler: createWbBroadcastScheduler((sceneJson) => {
      void fireBroadcast(s, sceneJson);
    }),
  };
  session = s;
  void refreshWhiteboardSnapshot(s);
}

/** Close the session and cancel the pending debounce timer. Idempotent. */
export function closeWhiteboardSession(): void {
  if (session) {
    session.disposed = true;
    session.scheduler.cancel();
    session = null;
  }
}

/** Re-point the session at a new LiveKit Room (reconnect / rejoin swaps
 *  the Room object in App) and re-pull the snapshot (contract §2b). */
export function reattachWhiteboardRoom(livekitRoom: Room): void {
  const s = session;
  if (!s || s.disposed) return;
  s.livekitRoom = livekitRoom;
  void refreshWhiteboardSnapshot(s);
}

/** Feed an Excalidraw `onChange` into the debounce scheduler. Silently
 *  drops edits when no session is open or when the scene is identical to
 *  the last remotely-applied one (updateScene echo guard). */
export function noteWbLocalEdit(sceneJson: string): void {
  const s = session;
  if (!s || s.disposed) return;
  if (sceneJson === s.lastRemoteSceneJson) return;
  s.scheduler.schedule(sceneJson);
}

/** Clear the board (host only). DELETEs the server row, then clears the
 *  local canvas optimistically (contract §4); the server fans out
 *  `wb_clear` to the rest of the zone. The post-clear onChange echo is
 *  suppressed so we don't immediately PUT an empty scene back. */
export async function clearWhiteboard(): Promise<void> {
  const s = session;
  if (!s || s.disposed) throw new Error("no whiteboard session open");
  await clearBoard(s.backendUrl, s.room, s.zoneId, s.token, s.userId);
  const clearedAt = Date.now();
  s.localUpdatedAt = clearedAt;
  const emptyJson = JSON.stringify({ elements: [], appState: {}, files: {} });
  s.lastRemoteSceneJson = emptyJson;
  s.initialScene = null;
  clearListeners.forEach((l) => {
    try {
      l(clearedAt);
    } catch (err) {
      console.warn("wb clear listener failed", err);
    }
  });
}

/** Apply a remote `wb_update` that already passed `decideWbInbound`. */
export function applyRemoteWbUpdate(
  scene: WhiteboardScene,
  updatedAt: number,
): void {
  const s = session;
  if (!s || s.disposed) return;
  if (!lwwShouldApply(s.localUpdatedAt, updatedAt)) return;
  s.localUpdatedAt = updatedAt;
  try {
    s.lastRemoteSceneJson = JSON.stringify(scene);
  } catch {
    s.lastRemoteSceneJson = null;
  }
  sceneListeners.forEach((l) => {
    try {
      l(scene, updatedAt);
    } catch (err) {
      console.warn("wb scene listener failed", err);
    }
  });
}

/** Apply a remote `wb_clear` that already passed `decideWbInbound`. */
export function applyRemoteWbClear(updatedAt: number): void {
  const s = session;
  if (!s || s.disposed) return;
  if (!lwwShouldApply(s.localUpdatedAt, updatedAt)) return;
  s.localUpdatedAt = updatedAt;
  s.lastRemoteSceneJson = JSON.stringify({
    elements: [],
    appState: {},
    files: {},
  });
  s.initialScene = null;
  clearListeners.forEach((l) => {
    try {
      l(updatedAt);
    } catch (err) {
      console.warn("wb clear listener failed", err);
    }
  });
}

/** Pull the REST snapshot and apply it when newer than the local scene
 *  (contract §2b / §2c). 404 → empty canvas, not an error. */
async function refreshWhiteboardSnapshot(s: WhiteboardSession): Promise<void> {
  let snapshot: WhiteboardSnapshot | null;
  try {
    snapshot = await getSnapshot(s.backendUrl, s.room, s.zoneId, s.token);
  } catch (err) {
    console.warn("whiteboard snapshot pull failed", err);
    return;
  }
  if (s.disposed || session !== s) return;
  if (!snapshot) return; // 404: nothing drawn yet; keep the empty canvas.
  if (!lwwShouldApply(s.localUpdatedAt, snapshot.updated_at)) return;
  let scene: WhiteboardScene;
  try {
    const parsed: unknown = JSON.parse(snapshot.scene_json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { elements?: unknown }).elements)
    ) {
      console.warn("whiteboard snapshot has no elements; ignoring");
      return;
    }
    scene = parsed as WhiteboardScene;
  } catch (err) {
    console.warn("whiteboard snapshot is not valid JSON", err);
    return;
  }
  s.initialScene = scene;
  applyRemoteWbUpdate(scene, snapshot.updated_at);
}

/** Debounce timer fired: broadcast the latest scene (§2a) and ride the
 *  same timer with a best-effort PUT (§2b). */
async function fireBroadcast(s: WhiteboardSession, sceneJson: string): Promise<void> {
  if (s.disposed || session !== s) return;
  if (sceneJsonOverCap(sceneJson)) {
    // Client-side cap (contract §5): no point pushing what the server
    // would 413. The local canvas keeps the scene; only the sync drops.
    console.warn(
      `whiteboard scene over ${WHITEBOARD_MAX_SNAPSHOT_BYTES}B cap; broadcast skipped`,
    );
    return;
  }
  const updatedAt = Date.now();
  let scene: WhiteboardScene;
  try {
    scene = JSON.parse(sceneJson) as WhiteboardScene;
  } catch {
    return;
  }
  s.localUpdatedAt = updatedAt;
  try {
    await publishReliable(
      s.livekitRoom,
      encodeWbUpdate({
        type: WB_UPDATE_TYPE,
        board: s.board,
        zone_id: s.zoneId,
        updated_at: updatedAt,
        scene,
      }),
    );
  } catch (err) {
    console.warn("whiteboard broadcast failed", err);
  }
  // PUT rides the same debounce timer — best-effort persistence for late
  // joiners, not the realtime path.
  try {
    const res = await putSnapshot(s.backendUrl, s.room, s.zoneId, s.token, {
      userId: s.userId,
      scene_json: sceneJson,
      updated_at: updatedAt,
    });
    if (s.disposed || session !== s) return;
    if (!res.applied && res.snapshot) {
      // Our write lost LWW (clock skew / concurrent writer): the client
      // MUST GET to converge (contract §6). `putSnapshot` already did the
      // GET; apply the converged snapshot when newer.
      const snap = res.snapshot;
      if (lwwShouldApply(s.localUpdatedAt, snap.updated_at)) {
        try {
          const converged = JSON.parse(snap.scene_json) as WhiteboardScene;
          s.initialScene = converged;
          applyRemoteWbUpdate(converged, snap.updated_at);
        } catch (err) {
          console.warn("whiteboard converged snapshot is not valid JSON", err);
        }
      }
    }
  } catch (err) {
    // Rate-limited (429), not-in-zone (403), too_large (413): all warn and
    // continue. The data-channel broadcast is the realtime path; the PUT
    // is expendable. `too_large` here means the cap grew stale between the
    // check above and the PUT — next broadcast re-checks.
    const status = (err as { status?: number } | null)?.status;
    if (status === 413) {
      console.warn(
        `whiteboard PUT rejected: scene over ${utf8ByteLength(sceneJson)}B cap`,
      );
    } else {
      console.warn("whiteboard PUT failed", err);
    }
  }
}
