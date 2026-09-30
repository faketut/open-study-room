// REST client for the M3 focus loop (pomodoro sessions + stats).
// Contract: docs/contracts.md "Focus loop (M3: pomodoro + stats + sit
// ritual)" §1 (focus_sessions) / §4 (endpoint shapes).
// Error handling follows sessionApi.ts's SessionApiError pattern.

import { SessionApiError } from "./sessionApi";

export type FocusSessionKind = "focus" | "break";

/** Session row as returned by start/active. `startedAt`/`endsAt` are
 *  server-clock epoch ms; the client resumes its local ticker from
 *  `endsAt`. */
export interface FocusSessionDto {
  id: string;
  kind: FocusSessionKind;
  plannedMinutes: number;
  startedAt: number;
  endsAt: number;
}

/** Result of ending a session. `completed` is server-decided (§1
 *  completion rule); the client's hint is ignored. */
export interface FocusEndResult {
  id: string;
  completed: 0 | 1;
  durationSec: number;
}

/** Private per-user aggregates. `day` strings are in the caller's tz
 *  (see `tzOffsetMin`); sums cover completed focus sessions only. */
export interface FocusStats {
  todaySec: number;
  weekSec: number;
  streakDays: number;
  totalCompletedSessions: number;
  last7Days: { day: string; seconds: number }[];
}

function baseUrl(backendUrl: string): string {
  return backendUrl.replace(/\/$/, "");
}

function authHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

async function throwIfBad(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = await res.text().catch(() => undefined);
    }
    throw new SessionApiError(`${label} ${res.status}`, res.status, details);
  }
}

/** Start a focus/break session. The server first settles any existing
 *  active session as interrupted (§1). */
export async function startFocusSession(
  backendUrl: string,
  room: string,
  token: string,
  opts: { kind: FocusSessionKind; plannedMinutes: number },
): Promise<FocusSessionDto> {
  const url = `${baseUrl(backendUrl)}/v1/rooms/${encodeURIComponent(room)}/focus/sessions`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      kind: opts.kind,
      plannedMinutes: opts.plannedMinutes,
    }),
  });
  await throwIfBad(res, "POST focus/sessions");
  return (await res.json()) as FocusSessionDto;
}

/** End a session. Idempotent: ending an already-ended session returns the
 *  stored result (200). */
export async function endFocusSession(
  backendUrl: string,
  room: string,
  token: string,
  id: string,
): Promise<FocusEndResult> {
  const url = `${baseUrl(backendUrl)}/v1/rooms/${encodeURIComponent(room)}/focus/sessions/${encodeURIComponent(id)}/end`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({}),
  });
  await throwIfBad(res, "POST focus/sessions/:id/end");
  return (await res.json()) as FocusEndResult;
}

/** Resume on (re)join: the server's currently active session, or null. */
export async function getActiveFocusSession(
  backendUrl: string,
  room: string,
  token: string,
): Promise<{ session: FocusSessionDto | null }> {
  const url = `${baseUrl(backendUrl)}/v1/rooms/${encodeURIComponent(room)}/focus/active`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  await throwIfBad(res, "GET focus/active");
  return (await res.json()) as { session: FocusSessionDto | null };
}

/** Private stats for one user. `:userId` MUST equal the caller's own id
 *  (server returns 403 otherwise). `tzOffsetMin` is minutes east of UTC
 *  (client sends `-new Date().getTimezoneOffset()`). */
export async function getFocusStats(
  backendUrl: string,
  userId: string,
  token: string,
  tzOffsetMin: number,
): Promise<FocusStats> {
  const url = `${baseUrl(backendUrl)}/v1/users/${encodeURIComponent(userId)}/focus/stats?tzOffsetMin=${encodeURIComponent(String(tzOffsetMin))}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  await throwIfBad(res, "GET focus/stats");
  return (await res.json()) as FocusStats;
}
