// M2 moderation REST client (web side).
//
// Contract: docs/contracts.md "Moderation (M2: stranger safety)" §6.
// All five endpoints live under `/v1/rooms/:room/`, bearer-authenticated
// with the LiveKit JWT. Call style mirrors `sessionApi.ts` (fetch +
// SessionApiError with the decoded `{ error }` body in `details`).

import {
  SessionApiError,
} from "./sessionApi";
import type { ModerateAction, ReportReason } from "../domain/moderation";

function baseUrl(backendUrl: string): string {
  return backendUrl.replace(/\/$/, "");
}

function authHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

async function throwForStatus(
  res: Response,
  what: string,
): Promise<never> {
  let details: unknown;
  try {
    details = await res.json();
  } catch {
    details = await res.text().catch(() => undefined);
  }
  throw new SessionApiError(`${what} ${res.status}`, res.status, details);
}

// ---------- POST /v1/rooms/:room/reports — file a report ----------

export interface FileReportBody {
  targetId: string;
  reason: ReportReason;
  detail?: string;
}

export interface FileReportResult {
  id: string;
  status: string;
}

export async function fileReport(
  backendUrl: string,
  room: string,
  token: string,
  body: FileReportBody,
): Promise<FileReportResult> {
  const url = `${baseUrl(backendUrl)}/v1/rooms/${encodeURIComponent(room)}/reports`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwForStatus(res, "POST reports");
  return (await res.json()) as FileReportResult;
}

// ---------- GET /v1/rooms/:room/reports — list reports (host) ----------

export type ReportStatusFilter = "open" | "all";

export interface ReportDto {
  id: string;
  reporterId: string;
  reporterNickname: string;
  targetId: string;
  targetNickname: string;
  reason: ReportReason;
  detail: string | null;
  createdAt: number;
  status: "open" | "actioned" | "dismissed";
  handledBy: string | null;
  handledAt: number | null;
}

export async function listReports(
  backendUrl: string,
  room: string,
  token: string,
  status: ReportStatusFilter = "open",
): Promise<ReportDto[]> {
  const url =
    `${baseUrl(backendUrl)}/v1/rooms/${encodeURIComponent(room)}/reports` +
    `?status=${encodeURIComponent(status)}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) await throwForStatus(res, "GET reports");
  const json = (await res.json()) as { reports: ReportDto[] };
  return json.reports;
}

// ---------- POST /v1/rooms/:room/reports/:id/action — close a report (host) ----------

export type ReportDecision = "actioned" | "dismissed";

export async function closeReport(
  backendUrl: string,
  room: string,
  token: string,
  reportId: string,
  decision: ReportDecision,
): Promise<{ id: string; status: string }> {
  const url =
    `${baseUrl(backendUrl)}/v1/rooms/${encodeURIComponent(room)}/reports/` +
    `${encodeURIComponent(reportId)}/action`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) await throwForStatus(res, "POST report action");
  return (await res.json()) as { id: string; status: string };
}

// ---------- POST /v1/rooms/:room/moderate — mute / unmute / kick (host) ----------

export async function moderateUser(
  backendUrl: string,
  room: string,
  token: string,
  body: { targetUserId: string; action: ModerateAction; reason?: string },
): Promise<{ action: string; targetUserId: string }> {
  const url = `${baseUrl(backendUrl)}/v1/rooms/${encodeURIComponent(room)}/moderate`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwForStatus(res, "POST moderate");
  return (await res.json()) as { action: string; targetUserId: string };
}

// ---------- POST /v1/rooms/:room/host — transfer host (host) ----------

export async function transferHost(
  backendUrl: string,
  room: string,
  token: string,
  toUserId: string,
): Promise<{ host: string }> {
  const url = `${baseUrl(backendUrl)}/v1/rooms/${encodeURIComponent(room)}/host`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ toUserId }),
  });
  if (!res.ok) await throwForStatus(res, "POST host");
  return (await res.json()) as { host: string };
}
