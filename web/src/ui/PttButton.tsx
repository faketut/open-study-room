import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";

/** 触屏存在判定：与 web/docs/touch-controls-spec.md §1 挂载条件一致。 */
function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches) ||
    "ontouchstart" in window
  );
}

export interface PttButtonProps {
  /** 可见性：coordinator 传入 `zoneKind === "silent"`（touch-controls-spec.md §4）。 */
  visible: boolean;
  /** 按住开始：coordinator 接 `pttHeldRef.current = true; setPttHeld(true)`，
   *  复用 M1 的 `pttHeld` 状态机（见 `micLogicalState`）。 */
  onHoldStart: () => void;
  /** 松开结束：coordinator 接"若 `pttHeldRef.current` 则清零"，
   *  与空格键 keyup 分支相同的幂等写法。 */
  onHoldEnd: () => void;
}

/** 触屏按住发言按钮：空格 PTT 的触屏等价（touch-controls-spec.md §4）。
 *
 *  - `onPointerDown` → start：`setPointerCapture` + `preventDefault`；
 *  - `onPointerUp` / `onPointerCancel` / `lostpointercapture` → end；
 *  - `touch-action: none` 防止触摸滚动抢夺手势；
 *  - pointer capture 保证手指滑出按钮后的 pointerup 仍能收到并正确释放。
 *
 *  end 回调本身是幂等的（lostpointercapture 会在 pointerup 之后再触发一次），
 *  coordinator 侧用 `pttHeldRef.current` 守卫即可。 */
export function PttButton({ visible, onHoldStart, onHoldEnd }: PttButtonProps) {
  // §1 挂载条件：桌面端（pointer: fine）不渲染。`visible` 仍只表达
  // §4 的 silent 区语义；触屏门是组件自己加的，桌面零回归。
  const [touch] = useState(() => isTouchDevice());
  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      onHoldStart();
    },
    [onHoldStart],
  );
  const handleEnd = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      onHoldEnd();
    },
    [onHoldEnd],
  );
  const handleLostPointerCapture = useCallback(() => {
    onHoldEnd();
  }, [onHoldEnd]);

  if (!touch || !visible) return null;
  return (
    <button
      type="button"
      className="ptt-button"
      style={{ touchAction: "none" }}
      onPointerDown={handlePointerDown}
      onPointerUp={handleEnd}
      onPointerCancel={handleEnd}
      onLostPointerCapture={handleLostPointerCapture}
      aria-label="按住发言"
      title="按住发言"
    >
      按住发言
    </button>
  );
}
