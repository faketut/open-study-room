import { useState } from "react";
import type { TouchAction } from "../domain/touchActions";

/** 触屏存在判定：与 web/docs/touch-controls-spec.md §1 挂载条件一致。 */
function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches) ||
    "ontouchstart" in window
  );
}

export interface TouchActionBarProps {
  /** 当前上下文操作：`interactActionFor(...)` 的结果；null 时按钮隐藏。 */
  action: TouchAction | null;
  /** 触发操作。coordinator 把它映射到与桌面 F/E 键相同的处理函数
   * （board/note → `setViewingBoardIndex`/`setReadingNoteIndex`；
   *   sit/stand → E 键分支的坐下/起身逻辑）。 */
  onAction: (a: TouchAction) => void;
}

/** 按钮文案：与 touch-controls-spec.md §4 按钮映射表一致
 *  （board/note 都是"打开"，sit 是"坐下"，stand 是"起身"）。 */
const ACTION_LABELS: Record<TouchAction, string> = {
  board: "Open",
  note: "Open",
  sit: "Sit down",
  stand: "Stand up",
};

/** 触屏上下文操作按钮。只在触屏设备（pointer: coarse 或 touch 事件可用）
 * 渲染，桌面端不渲染；画布右下显示单个大按钮，具体位置由 CSS 类
 * `touch-action-bar` 控制。 */
export function TouchActionBar({ action, onAction }: TouchActionBarProps) {
  const [touch] = useState(() => isTouchDevice());

  if (!touch || action == null) return null;
  const label = ACTION_LABELS[action];
  return (
    <button
      type="button"
      className="touch-action-bar"
      onClick={() => onAction(action)}
      aria-label={label}
      title={label}
    >
      {label}
    </button>
  );
}
