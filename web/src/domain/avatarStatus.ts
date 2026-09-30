// Presence status for an avatar. Mirrors Gather's "available / busy / focus /
// in-meeting" pill. We publish this as a LiveKit participant attribute
// (`status`) so the existing onAttributes replay-on-join path handles it for
// free — same pattern as `table_id` and `nickname`.

export type AvatarStatus = "available" | "busy" | "focus" | "meeting" | "away";

export const AVATAR_STATUSES: readonly AvatarStatus[] = [
  "available",
  "busy",
  "focus",
  "meeting",
  "away",
] as const;

export const DEFAULT_STATUS: AvatarStatus = "available";

/** Idle threshold after which an `available` peer flips to `away`. */
export const IDLE_AWAY_MS = 5 * 60 * 1000;

export function isAvatarStatus(s: unknown): s is AvatarStatus {
  return typeof s === "string" && (AVATAR_STATUSES as readonly string[]).includes(s);
}

export interface StatusInputs {
  /** Currently seated at a table (drives `meeting`). */
  seated: boolean;
  /** Local mic is in user-muted state (drives `focus` when also seated). */
  muted: boolean;
  /** ms since last input (keyboard, mouse, movement). */
  idleMs: number;
  /** User explicitly set Do-Not-Disturb / Busy from the HUD. Takes precedence
   *  over auto-derivation so people can opt-out of being marked as available
   *  when their cam is idle but they're heads-down. */
  manualBusy: boolean;
  /** M3: a pomodoro focus session is active. Takes precedence over the
   *  seated meeting/mute derivation so an active session always shows the
   *  focus pill, even when the mic logic would say otherwise. */
  focusing?: boolean;
}

/** Derive the status the local user should currently broadcast. Order matters:
 *  manual Busy is always honored; then an active pomodoro forces focus;
 *  otherwise meeting > focus > away > available.
 *  Pure function for test-ability. */
export function deriveStatus(inputs: StatusInputs): AvatarStatus {
  if (inputs.manualBusy) return "busy";
  if (inputs.focusing) return "focus";
  if (inputs.seated) {
    return inputs.muted ? "focus" : "meeting";
  }
  if (inputs.idleMs >= IDLE_AWAY_MS) return "away";
  return "available";
}

/** Display metadata for HUD pill + canvas ring. Keep colors close to the
 *  MASTER design-system semantic intent: green=available, blue=meeting,
 *  yellow=focus, red=busy, gray=away. Hex values chosen from the existing
 *  PALETTE so we don't introduce a third color source. */
export interface StatusMeta {
  label: string;
  ringColor: string;
  /** Used by the HUD pill background — 18% alpha of ringColor. */
  pillBackground: string;
}

const STATUS_META: Record<AvatarStatus, StatusMeta> = {
  available: {
    label: "Available",
    ringColor: "#34C759",
    pillBackground: "rgba(52, 199, 89, 0.18)",
  },
  busy: {
    label: "Do not disturb",
    ringColor: "#FF3B30",
    pillBackground: "rgba(255, 59, 48, 0.18)",
  },
  focus: {
    label: "Focusing",
    ringColor: "#FFCC00",
    pillBackground: "rgba(255, 204, 0, 0.18)",
  },
  meeting: {
    label: "In meeting",
    ringColor: "#007AFF",
    pillBackground: "rgba(0, 122, 255, 0.18)",
  },
  away: {
    label: "Away",
    ringColor: "#8E8E93",
    pillBackground: "rgba(142, 142, 147, 0.18)",
  },
};

export function statusMeta(s: AvatarStatus): StatusMeta {
  return STATUS_META[s];
}
