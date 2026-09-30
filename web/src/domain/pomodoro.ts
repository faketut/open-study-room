// Pomodoro / focus-loop domain: pure helpers shared by the web timer, the
// LiveKit `focus` attribute wire format, and the peer countdown UI.
// Contract: docs/contracts.md "Focus loop (M3: pomodoro + stats + sit
// ritual)" §2 (client state machine) / §3 (focus presence attribute).

/** Client-side pomodoro phases. `focusing` and `on_break` never transition
 *  into each other directly — a finished session always returns to `idle`
 *  first; the client may then auto-offer a break (UI choice, not a
 *  transition). */
export type PomodoroPhase = "idle" | "focusing" | "on_break";

/** Server session kind: `focus` sessions count toward stats/streak,
 *  `break` sessions are recorded but excluded from every aggregate. */
export type FocusKind = "focus" | "break";

/** LiveKit participant attribute key for focus presence — verbatim per
 *  contract §3 (the server never reads it; peers render the countdown from
 *  it). The web client MUST use this exact string. */
export const FOCUS_ATTRIBUTE_KEY = "focus";

/** Local UI tick interval (ms) for the countdown recomputation. */
export const FOCUS_TICK_MS = 1_000;

/** Interval (ms) between `focus` attribute re-publishes while a session is
 *  active. Receivers tick the countdown down locally every second from the
 *  last published value, so 30 s is plenty and keeps us off the hot path. */
export const FOCUS_HEARTBEAT_MS = 30_000;

// ---------------------------------------------------------------- wire format

/** Serialize to the `focus` attribute value: `focusing:<sec>` /
 *  `break:<sec>`; idle returns `""` (cleared), per contract §3. Seconds are
 *  floored and clamped at 0. */
export function serializeFocusAttribute(
  phase: PomodoroPhase,
  remainingSec: number,
): string {
  if (phase === "idle") return "";
  const sec = Math.max(0, Math.floor(remainingSec));
  return `${phase === "focusing" ? "focusing" : "break"}:${sec}`;
}

export interface ParsedFocusAttribute {
  phase: PomodoroPhase;
  /** Remaining seconds at publish time. Always 0 for idle. */
  remainingSec: number;
}

/** Parse a `focus` attribute value. `""` (cleared) means idle; anything that
 *  does not match the contract wire format (`focusing:<sec>` /
 *  `break:<sec>` with a non-negative integer) is illegal and returns null. */
export function parseFocusAttribute(s: string): ParsedFocusAttribute | null {
  if (s === "") return { phase: "idle", remainingSec: 0 };
  const m = /^(focusing|break):(\d+)$/.exec(s);
  if (!m) return null;
  return {
    phase: m[1] === "focusing" ? "focusing" : "on_break",
    remainingSec: Number(m[2]),
  };
}

// ---------------------------------------------------------------- display

/** Countdown label `"mm:ss"`. Minutes are unbounded (`75:05`), seconds are
 *  always two digits. Negative input is clamped to 0; fractional input is
 *  floored. */
export function formatRemaining(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- session resume

/** Minimal server session reference needed to resume the local ticker. */
export interface FocusSessionRef {
  kind: FocusKind;
  /** Server-clock epoch ms when the session is scheduled to end. */
  endsAt: number;
}

/** Remaining whole seconds until `endsAt` (server clock) from `nowMs`,
 *  rounded up and floored at 0. The client recomputes this every second
 *  from the last known server `endsAt` (server lazy-settle covers skew). */
export function remainingSecFromEndsAt(endsAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000));
}

/** Derive the phase from a server session row (null when none is active).
 *  Used on reconnect: `GET active` → if the session is still live, resume
 *  the ticker from the server `ends_at`; otherwise fall back to `idle`. */
export function derivePhaseFromSession(
  session: FocusSessionRef | null,
  nowMs: number,
): { phase: PomodoroPhase; kind: FocusKind | null; endsAt: number | null } {
  if (!session || session.endsAt <= nowMs) {
    return { phase: "idle", kind: null, endsAt: null };
  }
  return {
    phase: session.kind === "focus" ? "focusing" : "on_break",
    kind: session.kind,
    endsAt: session.endsAt,
  };
}

// ---------------------------------------------------------------- state machine

/** §2 client state machine, as a transition guard. Every active phase
 *  returns through `idle`; `focusing` ↔ `on_break` is never direct. */
const ALLOWED_TRANSITIONS: Record<PomodoroPhase, readonly PomodoroPhase[]> = {
  idle: ["focusing", "on_break"],
  focusing: ["idle"],
  on_break: ["idle"],
};

export function canTransition(from: PomodoroPhase, to: PomodoroPhase): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
