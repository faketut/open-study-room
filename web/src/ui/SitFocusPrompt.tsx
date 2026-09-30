// M3 T11 — sit ritual entry prompt.
//
// Shown when the user is seated (`tableId != null`) and the pomodoro is
// idle. No auto-start: one tap begins a 25-minute focus session, with an
// optional 5-minute break (the contract's post-focus break offer). Session
// lifecycle (REST start, focus attribute, ticker) lives in the timer
// worker's frozen `usePomodoroStore`; this component only calls `start()`.
//
// Touch-friendly: big ≥56px buttons styled like MW1's `touch-action-bar`.

import { useState } from "react";
import { usePomodoroStore } from "../state/pomodoroStore";

export function SitFocusPrompt() {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(kind: "focus" | "break", minutes: number) {
    setError(null);
    setStarting(true);
    try {
      await usePomodoroStore.getState().start(kind, minutes);
      // The store's start() resolves silently when the REST call fails
      // (it only logs), so detect the failure via the phase: still idle
      // means the session never started.
      if (usePomodoroStore.getState().phase === "idle") {
        setError("开始失败，请检查网络后重试。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="sit-focus-prompt" role="group" aria-label="开始专注">
      <div className="sit-focus-prompt-title">已入座 · 来段专注？</div>
      <div className="sit-focus-prompt-actions">
        <button
          type="button"
          className="sit-focus-btn primary"
          disabled={starting}
          onClick={() => void start("focus", 25)}
          aria-label="开始 25 分钟专注"
        >
          🍅 开始专注 25′
        </button>
        <button
          type="button"
          className="sit-focus-btn"
          disabled={starting}
          onClick={() => void start("break", 5)}
          aria-label="开始 5 分钟休息"
        >
          ☕ 休息 5′
        </button>
      </div>
      {error != null && (
        <div className="sit-focus-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
