import type { ReactNode } from "react";
import {
  contextSuiteFor,
  desktopHintFor,
  type ContextState,
} from "../domain/contextUi";
import type { TouchAction } from "../domain/touchActions";
import { TouchActionBar } from "./TouchActionBar";

export interface ContextActionBarProps {
  /** Raw context; the suite is derived here via `contextSuiteFor`. */
  state: ContextState;
  /** Coarse-pointer (touch) device flag, owned by the coordinator. */
  isTouch: boolean;
  /** Touch contextual action (`interactActionFor` result). */
  touchAction: TouchAction | null;
  /** Routes to the same handlers as the desktop F/E keys. */
  onTouchAction: (a: TouchAction) => void;
  /** Show the one-time movement hint (until the player's first move). */
  showMoveHint: boolean;
  /** Suite 1 (meeting): mic / cam / share / meeting-view / leave buttons. */
  meetingControls: ReactNode;
  /** Suite 2 (object): desktop whiteboard entry (discussion zones only);
   *  touch uses the TouchActionBar "打开" button instead. */
  objectControls: ReactNode;
  /** Suite 4 (person): the PersonCard, or null when no peer qualifies. */
  personCard: ReactNode;
}

/** Bottom contextual action bar (contracts.md "Layout & contextual UI" §2).
 *  Renders exactly one suite per `contextSuiteFor` — empty when idle.
 *  The PTT Space hint is orthogonal and may co-render with any suite
 *  (the PttButton itself stays mounted by the coordinator, unchanged). */
export function ContextActionBar({
  state,
  isTouch,
  touchAction,
  onTouchAction,
  showMoveHint,
  meetingControls,
  objectControls,
  personCard,
}: ContextActionBarProps) {
  const suite = contextSuiteFor(state);
  const hint = desktopHintFor(suite);
  // Desktop Space hint in silent zones (touch gets the PttButton instead).
  const pttHint = state.silentZone && !isTouch;
  const hintRow =
    showMoveHint || (hint != null && !isTouch) || pttHint;

  if (suite === "idle" && !hintRow) return null;

  return (
    <div className="context-action-bar">
      {suite === "meeting" && (
        <div className="ctx-controls">{meetingControls}</div>
      )}
      {suite === "object" && objectControls != null && (
        <div className="ctx-controls">{objectControls}</div>
      )}
      {suite === "person" && personCard}
      {/* TouchActionBar semantics unchanged (`interactActionFor`-driven);
          it only renders on coarse pointers and hides itself when the
          action is null (person/idle suites). */}
      <TouchActionBar action={touchAction} onAction={onTouchAction} />
      {hintRow && (
        <div className="ctx-hints">
          {showMoveHint ? (
            <span className="ctx-hint">
              {isTouch ? "拖动左下摇杆移动" : "WASD / 方向键移动"}
            </span>
          ) : (
            hint != null &&
            !isTouch && (
              <span className="ctx-hint">
                <span className="key">{hint.key}</span>
                {hint.label}
              </span>
            )
          )}
          {pttHint && (
            <span className="ctx-hint">
              <span className="key">Space</span>说话
            </span>
          )}
        </div>
      )}
    </div>
  );
}
