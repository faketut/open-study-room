import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export type MobileDrawerSide = "bottom" | "right";

export interface MobileDrawerProps {
  /** Controls open state. On desktop this also drives the wrapped panel's
   *  own `open` prop (e.g. ChatPanel), so the two stay in sync. */
  open: boolean;
  onClose: () => void;
  /** Drawer edge on touch layouts. Defaults to "bottom". */
  side?: MobileDrawerSide;
  /** Title shown in the mobile drawer header (also used for aria-label). */
  title: string;
  children: ReactNode;
}

const DRAG_DISMISS_PX = 90;

/** Generic mobile drawer (MW1-2).
 *
 *  The DOM is identical on desktop and mobile — no JS branch. On
 *  `pointer: fine` layouts the CSS collapses the wrapper to
 *  `display: contents` and hides scrim/handle/header, so children render
 *  inline exactly as before (zero desktop regression). On
 *  `pointer: coarse` the CSS turns the same DOM into a fixed bottom/right
 *  drawer with scrim, rounded corners, swipe-to-dismiss handle, ESC and
 *  scrim-click close.
 */
export function MobileDrawer({
  open,
  onClose,
  side = "bottom",
  title,
  children,
}: MobileDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number } | null>(null);

  // ESC closes the drawer while it is open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Lock body scroll while a drawer is open on touch layouts so the canvas
  // behind doesn't pan under the drawer. Desktop renders the children
  // inline (display: contents), where locking the body would be a
  // regression, so the lock only applies under the coarse-pointer query.
  useEffect(() => {
    if (!open) return;
    if (
      typeof window === "undefined" ||
      !window.matchMedia("(pointer: coarse)").matches
    ) {
      return;
    }
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open ]);

  // Swipe-to-dismiss on the grab handle (Pointer Events). During the drag
  // the panel follows the finger; releasing past the threshold closes it.
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || !panel) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const offset = side === "bottom" ? dy : dx;
    if (offset > 0) {
      panel.style.transform =
        side === "bottom" ? `translateY(${offset}px)` : `translateX(${offset}px)`;
    } else {
      panel.style.transform = "";
    }
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const panel = panelRef.current;
    if (panel) panel.style.transform = "";
    if (!drag) return;
    const offset =
      side === "bottom" ? e.clientY - drag.startY : e.clientX - drag.startX;
    if (offset > DRAG_DISMISS_PX) onClose();
  };

  return (
    <div
      className={`mobile-drawer mobile-drawer--${side}${open ? " open" : ""}`}
    >
      <div
        className="mobile-drawer-scrim"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className="mobile-drawer-panel"
        role="dialog"
        aria-modal="false"
        aria-label={title}
      >
        <div
          className="mobile-drawer-handle"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-hidden="true"
        />
        <div className="mobile-drawer-header">
          <span className="mobile-drawer-title">{title}</span>
          <button
            type="button"
            className="mobile-drawer-close"
            onClick={onClose}
            aria-label={`Close ${title}`}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M3 3 L13 13 M13 3 L3 13"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="mobile-drawer-body">{children}</div>
      </div>
    </div>
  );
}
