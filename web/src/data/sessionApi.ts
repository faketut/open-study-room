// Talks to the Syncle backend (server/) — same protocol as the Android client.
// See ../docs/contracts.md (#/v1/sessions request) for the canonical shape.

export interface SessionRequest {
  deviceId: string;
  nickname: string;
  color: string;
  room: string;
}

export interface SessionResponse {
  serverUrl: string;
  token: string;
  userId: string;
  nickname: string;
  color: string;
  expiresAt: number;
}

export class SessionApiError extends Error {
  constructor(message: string, readonly status?: number, readonly details?: unknown) {
    super(message);
    this.name = "SessionApiError";
  }
}

export async function createSession(
  backendUrl: string,
  body: SessionRequest,
): Promise<SessionResponse> {
  const res = await fetch(`${backendUrl.replace(/\/$/, "")}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = await res.text().catch(() => undefined);
    }
    throw new SessionApiError(`POST /v1/sessions ${res.status}`, res.status, details);
  }
  return (await res.json()) as SessionResponse;
}

// Stable per-browser identity, persisted in localStorage. Mirrors the Android
// DeviceIdStore so the backend's deviceId -> userId upsert is idempotent across
// reloads (same install = same userId).
const DEVICE_ID_KEY = "syncle.deviceId";

export function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing && existing.length >= 8) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

// ---------- State report (M1 quiet semantics) ----------
// Tells the server (x, y, table, zone) so it can enforce the silent-zone
// media policy server-side and serve late joiners from the snapshot.
// See docs/contracts.md "Zones".

export interface StateReportBody {
  userId: string;
  tableId?: string | null;
  x: number;
  y: number;
  zone?: string | null;
  zone_kind?: "silent" | "discussion" | "rest" | "none";
}

export async function reportState(
  backendUrl: string,
  room: string,
  token: string,
  body: StateReportBody,
): Promise<void> {
  const url = `${backendUrl.replace(/\/$/, "")}/v1/rooms/${encodeURIComponent(room)}/state`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = await res.text().catch(() => undefined);
    }
    throw new SessionApiError(`POST state ${res.status}`, res.status, details);
  }
}

// ---------- Channels (M3 rich chat) ----------

export interface ChannelDto {
  id: string;
  name: string;
}

export async function listChannels(
  backendUrl: string,
  room: string,
): Promise<ChannelDto[]> {
  const url = `${backendUrl.replace(/\/$/, "")}/v1/rooms/${encodeURIComponent(room)}/channels`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new SessionApiError(`GET channels ${res.status}`, res.status);
  }
  const json = (await res.json()) as { channels: ChannelDto[] };
  return json.channels;
}

export async function createChannel(
  backendUrl: string,
  room: string,
  token: string,
  name: string,
): Promise<ChannelDto> {
  const url = `${backendUrl.replace(/\/$/, "")}/v1/rooms/${encodeURIComponent(room)}/channels`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = await res.text().catch(() => undefined);
    }
    throw new SessionApiError(`POST channels ${res.status}`, res.status, details);
  }
  const json = (await res.json()) as { channel: ChannelDto };
  return json.channel;
}
