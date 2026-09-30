import type { Room } from "livekit-client";
import {
  connectLiveKit,
  publishProfileAttributes,
  setRoleAttribute,
  type PeerEvents,
} from "./liveKitService";
import { createSession, type SessionResponse } from "./sessionApi";
import { getAuthToken } from "./auth";
import { delayMsForAttempt, shouldGiveUp } from "../domain/reconnectPolicy";

/**
 * Everything needed to re-establish a LiveKit room with the same identity
 * after a disconnect. Built once by JoinScreen on initial connect and held
 * by the ConnectionController for the lifetime of the session.
 */
export interface ConnectCache {
  backendUrl: string;
  deviceId: string;
  room: string;
  nickname: string;
  color: string;
  /** 1..50 sprite index the user picked on the join screen. Re-published
   *  on every reconnect so peers don't lose the avatar mid-session. */
  characterIndex?: number;
  /** Current session token. Refreshed when the backend returns 401 or when
   *  the cached `expiresAt` is within 60s of now. */
  session: SessionResponse;
  /** Same handlers JoinScreen attached on the initial connect; we re-use
   *  them so reconnect transparently rewires data + peer callbacks. */
  events: PeerEvents;
}

/**
 * Disconnect reasons that are explicit and should NOT trigger reconnect.
 * Everything else (network drops, signal close, server restart, unknown)
 * goes through the back-off loop.
 */
const TERMINAL_REASONS = new Set<string>([
  "CLIENT_INITIATED",
  "DUPLICATE_IDENTITY",
  "PARTICIPANT_REMOVED",
  "ROOM_DELETED",
  "ROOM_CLOSED",
  "USER_REJECTED",
]);

export type ControllerState =
  | { kind: "connected"; room: Room }
  | { kind: "reconnecting"; attempt: number; reason: string | null }
  | { kind: "gaveUp"; reason: string };

export interface ConnectionController {
  /** Stop reconnecting and tear down the current room. Idempotent. */
  dispose: () => Promise<void>;
  /** Immediately attempt a reconnect (resets the back-off counter). No-op
   *  while a connect is already in flight. */
  retryNow: () => void;
  /** Current LiveKit Room reference. Stable across renders; swapped after
   *  a successful reconnect — listen to onState to learn about the swap. */
  getRoom: () => Room;
}

interface ControllerDeps {
  cache: ConnectCache;
  initialRoom: Room;
  onState: (state: ControllerState) => void;
  /** Test hook: override timers / RNG. */
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
}

/**
 * Wraps a LiveKit Room with an exponential-back-off reconnect loop.
 *
 * Lifecycle:
 *   - Constructed with an already-connected `initialRoom`.
 *   - Attaches a `Disconnected` listener (via the existing onDisconnected
 *     hook in PeerEvents — JoinScreen wires it to call back into us).
 *   - On non-terminal reasons, schedules `delayMsForAttempt(n)` and
 *     attempts `connectLiveKit` again. If that throws a 401-ish error,
 *     refreshes the session token via `createSession` first.
 *   - On success, swaps the Room ref and notifies via `onState`.
 *   - After MAX_ATTEMPTS, transitions to `{ kind: "gaveUp" }`.
 */
export function startConnectionController(
  deps: ControllerDeps,
): ConnectionController {
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  let currentRoom: Room = deps.initialRoom;
  let attempt = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let connectInFlight = false;
  let disposed = false;

  // The handlers JoinScreen built reference *us* via onDisconnected. We
  // override it here so the controller owns the post-disconnect flow.
  const userOnDisconnected = deps.cache.events.onDisconnected;
  deps.cache.events.onDisconnected = (reason: string) => {
    userOnDisconnected?.(reason);
    if (disposed) return;
    if (TERMINAL_REASONS.has(reason)) {
      // Explicit hangup. Surface a gaveUp so the UI can fall back to join.
      deps.onState({ kind: "gaveUp", reason });
      return;
    }
    schedule(reason);
  };

  function schedule(reason: string | null): void {
    if (disposed) return;
    if (pendingTimer != null) {
      clearTimeoutFn(pendingTimer);
      pendingTimer = null;
    }
    attempt += 1;
    if (shouldGiveUp(attempt)) {
      deps.onState({
        kind: "gaveUp",
        reason: reason ?? "exceeded MAX_ATTEMPTS",
      });
      return;
    }
    const delay = delayMsForAttempt(attempt);
    deps.onState({ kind: "reconnecting", attempt, reason });
    pendingTimer = setTimeoutFn(() => {
      pendingTimer = null;
      void runAttempt(reason);
    }, delay);
  }

  async function runAttempt(lastReason: string | null): Promise<void> {
    if (disposed || connectInFlight) return;
    connectInFlight = true;
    try {
      // Refresh token if expired or within 60s of expiring.
      const now = Date.now();
      const expiresAt = deps.cache.session.expiresAt;
      if (expiresAt > 0 && now >= expiresAt - 60_000) {
        await refreshSession();
      }
      let room: Room;
      try {
        room = await connect();
      } catch (err) {
        if (isUnauthorized(err)) {
          // Token rejected mid-flight — refresh once and retry the same
          // attempt without bumping the counter.
          await refreshSession();
          room = await connect();
        } else {
          throw err;
        }
      }
      // Success: clean up old room, swap, reset counter.
      try {
        await currentRoom.disconnect();
      } catch {
        /* old room already torn down */
      }
      currentRoom = room;
      attempt = 0;
      deps.onState({ kind: "connected", room });
    } catch (err) {
      console.warn("reconnect attempt failed", err);
      const reason = err instanceof Error ? err.message : String(err);
      // Schedule the next attempt; `schedule` checks shouldGiveUp.
      schedule(lastReason ?? reason);
    } finally {
      connectInFlight = false;
    }
  }

  async function connect(): Promise<Room> {
    const { serverUrl, token } = deps.cache.session;
    const { room } = await connectLiveKit(serverUrl, token, deps.cache.events);
    void publishProfileAttributes(room, {
      nickname: deps.cache.nickname,
      color: deps.cache.color,
      characterIndex: deps.cache.characterIndex,
    });
    // M2/P1-B: re-publish the display-only role attribute on reconnect so
    // the host/admin badge survives a rejoin (contract §1). The sessions
    // response role is now "host" | "admin" | "user"; pass it through.
    void setRoleAttribute(room, deps.cache.session.role ?? "user");
    return room;
  }

  async function refreshSession(): Promise<void> {
    const fresh = await createSession(deps.cache.backendUrl, {
      deviceId: deps.cache.deviceId,
      nickname: deps.cache.nickname,
      color: deps.cache.color,
      room: deps.cache.room,
      // P1-B: keep the device→account binding across session refreshes.
      // undefined when anonymous — JSON.stringify drops it, so the
      // anonymous flow is unchanged.
      authToken: getAuthToken() ?? undefined,
    });
    deps.cache.session = fresh;
  }

  return {
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (pendingTimer != null) {
        clearTimeoutFn(pendingTimer);
        pendingTimer = null;
      }
      try {
        await currentRoom.disconnect();
      } catch {
        /* ignore */
      }
    },
    retryNow: () => {
      if (disposed) return;
      if (pendingTimer != null) {
        clearTimeoutFn(pendingTimer);
        pendingTimer = null;
      }
      // Reset back-off so manual retry feels immediate.
      attempt = 0;
      schedule(null);
    },
    getRoom: () => currentRoom,
  };
}

/** Best-effort detection of "your token is bad" — covers SessionApiError 401
 *  and LiveKit's connect-time errors that wrap a 401 in the message. */
function isUnauthorized(err: unknown): boolean {
  if (err == null) return false;
  const obj = err as { status?: number; message?: string };
  if (obj.status === 401) return true;
  const msg = obj.message ?? "";
  return /\b401\b|unauthorized|invalid token/i.test(msg);
}
