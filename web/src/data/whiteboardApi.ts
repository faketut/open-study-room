// Whiteboard (P1-C) REST client.
//
// Contract: docs/contracts.md "Whiteboard (P1-C: discussion-zone shared
// board)" §6. Auth for all three endpoints is the LiveKit join token as a
// bearer (same as M1 state reports in `sessionApi.ts`) — never the P1-B
// login-session token. Anonymous flow is untouched: the client passes the
// join token it already holds and the server's `userId == sub` check is
// what the other M1–M4 REST calls already do.

export interface WhiteboardSnapshot {
  /** JSON *string* of the Excalidraw scene; the client parses it. */
  scene_json: string;
  /** Epoch ms; the LWW arbiter. */
  updated_at: number;
  updated_by: string;
}

export class WhiteboardApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WhiteboardApiError";
  }
}

function baseUrl(backendUrl: string): string {
  return backendUrl.replace(/\/$/, "");
}

function boardUrl(backendUrl: string, room: string, zoneId: string): string {
  return `${baseUrl(backendUrl)}/v1/rooms/${encodeURIComponent(room)}/whiteboards/${encodeURIComponent(zoneId)}`;
}

function authHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

async function readErrorDetails(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      return await res.text();
    } catch {
      return undefined;
    }
  }
}

/** GET the board snapshot. `404 no_whiteboard` is NOT an error — it means
 *  "empty canvas" (contract §6). */
export async function getSnapshot(
  backendUrl: string,
  room: string,
  zoneId: string,
  token: string,
): Promise<WhiteboardSnapshot | null> {
  const res = await fetch(boardUrl(backendUrl, room, zoneId), {
    method: "GET",
    headers: authHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new WhiteboardApiError(
      `GET whiteboard ${res.status}`,
      res.status,
      await readErrorDetails(res),
    );
  }
  return (await res.json()) as WhiteboardSnapshot;
}

export interface PutSnapshotBody {
  userId: string;
  scene_json: string;
  updated_at: number;
}

export type PutSnapshotResult =
  | { applied: true }
  | { applied: false; snapshot: WhiteboardSnapshot | null };

/** PUT the scene snapshot. On `{applied:false}` (our write lost LWW) the
 *  client MUST `GET` to converge (contract §6) — this helper does that
 *  inline and returns the converged snapshot. */
export async function putSnapshot(
  backendUrl: string,
  room: string,
  zoneId: string,
  token: string,
  body: PutSnapshotBody,
): Promise<PutSnapshotResult> {
  const res = await fetch(boardUrl(backendUrl, room, zoneId), {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new WhiteboardApiError(
      `PUT whiteboard ${res.status}`,
      res.status,
      await readErrorDetails(res),
    );
  }
  const parsed = (await res.json()) as {
    ok?: boolean;
    applied?: boolean;
    updated_at?: number;
  };
  if (parsed.applied) return { applied: true };
  // LWW lost (or tie): converge via GET.
  const snapshot = await getSnapshot(backendUrl, room, zoneId, token);
  return { applied: false, snapshot };
}

/** DELETE the board (host only; server gates `getEffectiveRole == "host"`).
 *  Clearing a non-existent board is a no-op 204 (contract §6). */
export async function clearBoard(
  backendUrl: string,
  room: string,
  zoneId: string,
  token: string,
  userId: string,
): Promise<void> {
  const res = await fetch(boardUrl(backendUrl, room, zoneId), {
    method: "DELETE",
    headers: authHeaders(token),
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    throw new WhiteboardApiError(
      `DELETE whiteboard ${res.status}`,
      res.status,
      await readErrorDetails(res),
    );
  }
}
