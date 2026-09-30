// Whiteboard (P1-C) panel — the discussion-zone shared drawing surface.
//
// Contract: docs/contracts.md "Whiteboard (P1-C: discussion-zone shared
// board)".
//
// LAZY LOAD (contract §5, mandatory): `@excalidraw/excalidraw` MUST NOT be
// in the first-screen bundle. The component below reaches it only through
// dynamic `import()` inside `React.lazy` — the module chunk loads the
// first time this panel mounts (i.e. the first time a user opens a
// whiteboard), never on room entry. `scripts/assert-wb-lazy.mjs` (run as
// `postbuild`) asserts the entry chunk contains no excalidraw code. Type
// imports (`import type`) are compile-time only and do not affect the
// bundle.
//
// Wiring summary:
// - mount → `openWhiteboardSession` (done by the parent BEFORE mounting,
//   so the session exists and the REST snapshot pull is already in flight);
// - Excalidraw `onChange` → `noteWbLocalEdit` → 500 ms debounce →
//   `publishReliable` broadcast + best-effort PUT (session module);
// - remote `wb_update` / `wb_clear` → session listeners →
//   `excalidrawAPI.updateScene(...)` with LWW already enforced upstream;
// - Clear button: host only (contract §4); calls DELETE, clears locally.
//   The server fans out `wb_clear` to the zone.

import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Eraser, X } from "lucide-react";
// Type-only imports (erased at compile time — they do not pull the package
// into the bundle). The package root re-exports only a subset, so the
// editor types come from the `./*` types subpaths.
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { restore as restoreFn } from "@excalidraw/excalidraw/data/restore";
import {
  clearWhiteboard,
  closeWhiteboardSession,
  getWbInitialScene,
  subscribeWbClear,
  subscribeWbScene,
  noteWbLocalEdit,
} from "../data/whiteboardSession";
import type { WhiteboardScene } from "../domain/whiteboard";

// The ONLY runtime import of the excalidraw package in the whole web app,
// and it is dynamic: webpack/rollup code-splits this into a separate chunk
// that the browser fetches on first whiteboard open. Do NOT convert this
// to a static import.
const ExcalidrawLazy = lazy(() =>
  import("@excalidraw/excalidraw").then((m) => ({ default: m.Excalidraw })),
);

export interface WhiteboardPanelProps {
  room: string;
  zoneId: string;
  /** True when the local user is the room host (`role === "host"` from the
   *  sessions response). Only the host may clear (contract §4) — the
   *  site-level P1-B `admin` does NOT own the room and gets no clear right. */
  isHost: boolean;
  onClose: () => void;
}

function serializeScene(
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): string {
  return JSON.stringify({ elements, appState, files });
}

export function WhiteboardPanel({
  room,
  zoneId,
  isHost,
  onClose,
}: WhiteboardPanelProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  /** True while inside a programmatic `api.updateScene(...)` call.
   *  Excalidraw fires `onChange` synchronously from `componentDidUpdate`
   *  after `updateScene`, so this flag reliably swallows our own paints
   *  and they never reach the broadcast scheduler. */
  const paintingRef = useRef(false);
  // `restore` from the lazily-loaded excalidraw module (same chunk as the
  // component — one dynamic import, one network fetch).
  const restoreRef = useRef<typeof restoreFn | null>(null);
  /** Newest `updated_at` already painted, so out-of-order listener events
   *  and the open snapshot can never paint an older scene. */
  const paintedUpdatedAtRef = useRef(0);
  /** Latest remote scene not yet painted (api not ready when it arrived). */
  const pendingRef = useRef<{ scene: WhiteboardScene; updatedAt: number } | null>(
    null,
  );
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const paintScene = (scene: WhiteboardScene, updatedAt: number) => {
    const api = apiRef.current;
    const restore = restoreRef.current;
    if (!api || !restore) {
      pendingRef.current = { scene, updatedAt };
      return;
    }
    if (updatedAt <= paintedUpdatedAtRef.current) return;
    paintedUpdatedAtRef.current = updatedAt;
    try {
      const restored = restore(
        scene as Parameters<typeof restoreFn>[0],
        null,
        null,
      );
      paintingRef.current = true;
      try {
        api.updateScene({
          elements: restored.elements,
          appState: restored.appState,
        });
      } finally {
        paintingRef.current = false;
      }
    } catch (err) {
      console.warn("whiteboard: failed to paint remote scene", err);
    }
  };

  const paintClear = (updatedAt: number) => {
    const api = apiRef.current;
    if (!api) {
      pendingRef.current = {
        scene: { elements: [] },
        updatedAt,
      };
      return;
    }
    if (updatedAt <= paintedUpdatedAtRef.current) return;
    paintedUpdatedAtRef.current = updatedAt;
    paintingRef.current = true;
    try {
      api.updateScene({ elements: [] });
    } catch (err) {
      console.warn("whiteboard: failed to paint clear", err);
    } finally {
      paintingRef.current = false;
    }
  };

  // Subscribe to remote updates for the life of the panel.
  useEffect(() => {
    const unsubScene = subscribeWbScene((scene, updatedAt) =>
      paintScene(scene, updatedAt),
    );
    const unsubClear = subscribeWbClear((updatedAt) => paintClear(updatedAt));
    return () => {
      unsubScene();
      unsubClear();
    };
    // paintScene/paintClear are stable by construction (refs only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load `restore` from the same lazy chunk (cached module instance — no
  // second network fetch).
  useEffect(() => {
    let cancelled = false;
    void import("@excalidraw/excalidraw").then((m) => {
      if (cancelled) return;
      restoreRef.current = m.restore;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) paintScene(pending.scene, pending.updatedAt);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleApi = (api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    // The open snapshot may have resolved before Excalidraw mounted:
    // paint it as the initial canvas (LWW against anything already
    // painted, which can only be an older remote event).
    const initial = getWbInitialScene();
    if (initial) paintScene(initial.scene, initial.updatedAt);
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) paintScene(pending.scene, pending.updatedAt);
  };

  const handleChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    // Swallow our own programmatic paints (paintScene/paintClear set the
    // flag synchronously around updateScene). Without this, every remote
    // scene we paint would be rebroadcast with a fresh timestamp.
    if (paintingRef.current) return;
    noteWbLocalEdit(serializeScene(elements, appState, files));
  };

  const handleClear = async () => {
    if (!isHost || clearing) return;
    setClearing(true);
    setClearError(null);
    try {
      // Optimistic local clear (contract §4); the clear listener inside
      // clearWhiteboard() paints the empty canvas, and the server fans out
      // `wb_clear` to the rest of the zone. No broadcast of our own: the
      // paint is flag-suppressed, and the DELETE already persisted it.
      await clearWhiteboard();
    } catch (err) {
      console.warn("whiteboard clear failed", err);
      setClearError(
        err instanceof Error ? err.message : "Clear failed — try again",
      );
    } finally {
      setClearing(false);
    }
  };

  return (
    <div
      className="whiteboard-panel"
      role="dialog"
      aria-label={`Whiteboard — zone ${zoneId}`}
    >
      <div className="whiteboard-header">
        <span className="whiteboard-title">
          Whiteboard · {room} / {zoneId}
        </span>
        <div className="whiteboard-actions">
          {isHost && (
            <button
              type="button"
              className="whiteboard-clear"
              onClick={() => void handleClear()}
              disabled={clearing}
              title="Clear the board for everyone in this zone (host only)"
              aria-label="Clear whiteboard"
            >
              <Eraser size={14} aria-hidden="true" />
              <span>{clearing ? "Clearing…" : "Clear"}</span>
            </button>
          )}
          <button
            type="button"
            className="whiteboard-close"
            onClick={() => {
              closeWhiteboardSession();
              onClose();
            }}
            title="Close whiteboard"
            aria-label="Close whiteboard"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      {clearError && (
        <div className="whiteboard-error" role="alert">
          {clearError}
        </div>
      )}
      <div className="whiteboard-canvas">
        <Suspense
          fallback={
            <div className="whiteboard-loading">Loading whiteboard…</div>
          }
        >
          <ExcalidrawLazy
            excalidrawAPI={handleApi}
            onChange={handleChange}
            // Honest limitation (contract §2c): no OT/CRDT — last write
            // wins; this is a讲题 draft surface, not a collaborative editor.
          />
        </Suspense>
      </div>
    </div>
  );
}
