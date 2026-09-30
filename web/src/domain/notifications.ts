// Browser local notifications for the M3 focus loop.
// Contract: docs/contracts.md "Focus loop (M3: pomodoro + stats + sit
// ritual)" §6 — on `timer_reached_end` the client fires a local
// Notification when permission is granted, ALWAYS accompanied by an
// in-app toast/banner (covers iOS Safari and denied permission). No
// server push in M3.

/** Ask for (or re-check) notification permission. Resolves to the effective
 *  permission, or `"denied"` when the API is unavailable (e.g. iOS Safari)
 *  or the request itself throws. Never rejects. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/** Fire a local notification. Returns true when the notification was
 *  actually shown; false when permission is missing or the API is
 *  unsupported — the caller MUST degrade to an in-app toast in that case
 *  (§6 requires both). Never throws. */
export function sendLocalNotification(title: string, body: string): boolean {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission !== "granted") return false;
  try {
    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
}
