// MW1-1: virtual joystick for coarse-pointer devices (§2 of
// web/docs/touch-controls-spec.md).
//
// Left-bottom fixed overlay, 112px CSS diameter. Uses Pointer Events +
// setPointerCapture and `touch-action: none` so dragging never scrolls.
// Emits the normalized vector from joystickVector (domain/touchMove.ts);
// on release the knob recenters and onVector({x:0,y:0}) fires.
import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { joystickVector, type Vec2 } from "../domain/touchMove";

const DIAMETER_PX = 112; // §2 spec
const RADIUS_PX = DIAMETER_PX / 2;
const DEAD_ZONE_PX = 8; // §2 spec
const KNOB_DIAMETER_PX = 48;

export interface TouchJoystickProps {
  onVector: (v: Vec2) => void;
  disabled?: boolean;
}

export function TouchJoystick({ onVector, disabled = false }: TouchJoystickProps) {
  const baseRef = useRef<HTMLDivElement | null>(null);
  const activePointerId = useRef<number | null>(null);
  const onVectorRef = useRef(onVector);
  onVectorRef.current = onVector;

  // Knob offset in px from center (visual only).
  const [knob, setKnob] = useState<Vec2>({ x: 0, y: 0 });

  const emit = (offsetX: number, offsetY: number) => {
    const v = joystickVector(offsetX, offsetY, RADIUS_PX, DEAD_ZONE_PX);
    // Re-project the unit-bounded vector onto the travel ring so the knob
    // never visually leaves the base circle.
    setKnob({
      x: v.x * (RADIUS_PX - DEAD_ZONE_PX),
      y: v.y * (RADIUS_PX - DEAD_ZONE_PX),
    });
    onVectorRef.current(v);
  };

  const offsetFromCenter = (clientX: number, clientY: number): Vec2 => {
    const rect = baseRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clientX - (rect.left + rect.width / 2),
      y: clientY - (rect.top + rect.height / 2),
    };
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || activePointerId.current !== null) return;
    activePointerId.current = e.pointerId;
    try {
      baseRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // Pointer already gone; the subsequent up/cancel will release state.
    }
    const off = offsetFromCenter(e.clientX, e.clientY);
    emit(off.x, off.y);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== e.pointerId) return;
    const off = offsetFromCenter(e.clientX, e.clientY);
    emit(off.x, off.y);
  };

  const release = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== e.pointerId) return;
    activePointerId.current = null;
    if (baseRef.current) {
      try {
        if (baseRef.current.hasPointerCapture(e.pointerId)) {
          baseRef.current.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Already released; nothing to do.
      }
    }
    setKnob({ x: 0, y: 0 });
    onVectorRef.current({ x: 0, y: 0 });
  };

  return (
    <div
      ref={baseRef}
      aria-label="Move joystick"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      style={{
        position: "fixed",
        left: "calc(env(safe-area-inset-left, 0px) + 16px)",
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
        width: DIAMETER_PX,
        height: DIAMETER_PX,
        borderRadius: "50%",
        background: "rgba(255, 255, 255, 0.08)",
        border: "1px solid rgba(255, 255, 255, 0.25)",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        zIndex: 30, // above the canvas, below modals
        opacity: disabled ? 0.4 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: KNOB_DIAMETER_PX,
          height: KNOB_DIAMETER_PX,
          borderRadius: "50%",
          background: "rgba(255, 255, 255, 0.35)",
          border: "1px solid rgba(255, 255, 255, 0.5)",
          transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))`,
        }}
      />
    </div>
  );
}
