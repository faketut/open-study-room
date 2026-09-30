// M2 moderation domain helpers (web side).
//
// Contract: docs/contracts.md "Moderation (M2: stranger safety)".

/** Report reasons — enum verbatim from the `reports` table contract. */
export const REPORT_REASONS = [
  "spam",
  "harassment",
  "nsfw",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: "Spam / 广告",
  harassment: "Harassment / 骚扰",
  nsfw: "NSFW / 不当内容",
  other: "Other / 其他",
};

export function isReportReason(v: unknown): v is ReportReason {
  return (
    v === "spam" || v === "harassment" || v === "nsfw" || v === "other"
  );
}

/** `detail` free text max length — mirrors the contract (500 chars). */
export const REPORT_DETAIL_MAX_LEN = 500 as const;
/** Host-supplied kick reason max length (contract §3b: 140 chars). */
export const KICK_REASON_MAX_LEN = 140 as const;

/** Moderation actions the `moderate` endpoint accepts (contract §6).
 *  Ban is absent by design in M2. */
export type ModerateAction = "mute" | "unmute" | "kick";

export const MODERATE_ACTION_LABELS: Record<ModerateAction, string> = {
  mute: "Mute / 禁言",
  unmute: "Unmute / 解除禁言",
  kick: "Kick / 请出房间",
};

/** Decode the kick-notice wire packet (contract §3b):
 *  `{"type":"kick_notice","reason":"..."}` sent as reliable JSON over the
 *  data channel (not one of the binary type tags 1/2/3 — starts with `{`).
 *  Returns the reason string, or null when the payload is not a notice. */
export function decodeKickNotice(data: Uint8Array): string | null {
  if (data.length === 0 || data[0] !== 0x7b /* '{' */) return null;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(data),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "kick_notice"
    ) {
      const reason = (parsed as { reason?: unknown }).reason;
      return typeof reason === "string" ? reason : "";
    }
  } catch {
    /* not JSON — not a kick notice */
  }
  return null;
}

/** Server error codes from the M2 moderation endpoints (contract §6),
 *  translated to human-readable hints. Unknown codes fall back to a
 *  generic message that still names the code for debugging. */
export function moderationErrorMessage(code: unknown): string {
  switch (code) {
    case "not_host":
      return "Only the room host can do this. (not_host)";
    case "already_handled":
      return "This report was already closed by the host. (already_handled)";
    case "report_not_found":
      return "Report not found — it may have been removed. (report_not_found)";
    case "target_not_found":
      return "That user is not in this room. (target_not_found)";
    case "member_not_found":
      return "That user is not a current room member. (member_not_found)";
    case "cannot_target_self":
      return "You can't moderate yourself. (cannot_target_self)";
    case "target_is_host":
      return "The target is the host — transfer host first. (target_is_host)";
    case "invalid_action":
      return "Unsupported action. M2 supports mute, unmute and kick only. (invalid_action)";
    case "invalid_reason":
      return "Invalid report reason. (invalid_reason)";
    case "invalid_body":
      return "Invalid request. (invalid_body)";
    case "missing_bearer":
      return "Not authenticated — rejoin the room. (missing_bearer)";
    case "invalid_token":
      return "Session expired — rejoin the room. (invalid_token)";
    case "room_mismatch":
      return "Token is for a different room — rejoin. (room_mismatch)";
    case "kicked":
      return "You were removed from this room earlier today. Try again tomorrow. (kicked)";
    case "nickname_rejected":
      return "Nickname contains a sensitive word — try another. (nickname_rejected)";
    default:
      return typeof code === "string" && code.length > 0
        ? `Request failed. (${code})`
        : "Request failed.";
  }
}

/** Extract the contract `{ error: "<code>" }` from a SessionApiError's
 *  `details`, when present. */
export function moderationErrorCode(details: unknown): string | null {
  if (
    typeof details === "object" &&
    details !== null &&
    typeof (details as { error?: unknown }).error === "string"
  ) {
    return (details as { error: string }).error;
  }
  return null;
}
