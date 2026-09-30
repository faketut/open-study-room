import { jwtVerify } from "jose";
import type { Db, UserRow } from "./db.js";
import { getLoginSessionByToken } from "./db.js";

export interface JoinTokenPayload {
  sub: string; // user id (identity)
  video: { room?: string; roomJoin?: boolean };
  exp: number;
}

export async function verifyJoinToken(
  token: string,
  apiSecret: string,
): Promise<JoinTokenPayload> {
  const key = new TextEncoder().encode(apiSecret);
  const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
  const sub = payload.sub;
  const video = (payload as Record<string, unknown>).video as
    | JoinTokenPayload["video"]
    | undefined;
  if (typeof sub !== "string" || !video || typeof video !== "object") {
    throw new Error("token missing sub or video grants");
  }
  return { sub, video, exp: payload.exp ?? 0 };
}

export function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1].trim() : null;
}

// ---------- P1-B login sessions ----------
// Distinct from the LiveKit JWT above: the login session proves account
// identity to the REST API (docs/contracts.md "Identity & login" §5).

export interface LoginSession {
  /** login_sessions.id */
  id: string;
  /** The account row the bearer resolves to. */
  user: UserRow;
}

/** bearer → account row via the sha256 lookup. Returns null when the token
 *  is unknown, revoked, or expired. The raw token value never appears in
 *  any DB row. */
export function verifyLoginSession(
  db: Db,
  token: string,
  now: number = Date.now(),
): LoginSession | null {
  if (!token) return null;
  const session = getLoginSessionByToken(db, token, now);
  if (!session) return null;
  const user = db
    .prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?")
    .get(session.user_id);
  if (!user) return null; // unreachable (FK), defensive
  return { id: session.id, user };
}
