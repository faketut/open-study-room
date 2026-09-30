// Zustand store driving the M3 pomodoro timer. Owns:
//  - the client §2 state machine (idle -> focusing/on_break -> idle),
//  - the 1 s local countdown (recomputed from the server `endsAt`),
//  - the `focus` attribute publish: immediate on start/end plus a 30 s
//    heartbeat while active (contract §3),
//  - the `timer_reached_end` side effects: REST end, attribute clear, and
//    the local notification (contract §6; a false return from
//    sendLocalNotification means the UI layer must degrade to an in-app
//    toast).
//
// Connection info (backendUrl / room / token / userId) is INJECTED via
// `connect()` — the exact values SyncleScreen reads from its `cache` prop
// (ConnectCache: backendUrl, room, session.token, session.userId) when it
// calls `reportState`. The store holds no identity of its own; a fresh
// import is disconnected and every action no-ops until `connect()` runs.
// Token and Room are read through getters because the ConnectionController
// refreshes `session.token` in place and swaps the Room on reconnect
// (SyncleScreen passes `getToken` to child panels for the same reason).
// Contract: docs/contracts.md "Focus loop (M3)" §2–§3, §6.

import { create } from "zustand";
import type { Room } from "livekit-client";
import {
  derivePhaseFromSession,
  remainingSecFromEndsAt,
  serializeFocusAttribute,
  FOCUS_HEARTBEAT_MS,
  FOCUS_TICK_MS,
  type FocusKind,
  type PomodoroPhase,
} from "../domain/pomodoro";
import { sendLocalNotification } from "../domain/notifications";
import { setFocusAttribute } from "../data/liveKitService";
import {
  endFocusSession,
  getActiveFocusSession,
  startFocusSession,
  type FocusSessionDto,
} from "../data/focusApi";

/** Connection info injected by the UI layer. See module comment. */
export interface PomodoroConnection {
  backendUrl: string;
  room: string;
  /** Lazy token read — refreshed in place by the ConnectionController. */
  getToken: () => string;
  userId: string;
  /** Current LiveKit Room (swapped on reconnect); null while offline. */
  getRoom: () => Room | null;
}

export interface PomodoroStoreState {
  phase: PomodoroPhase;
  kind: FocusKind | null;
  /** Server-clock epoch ms when the session ends. */
  endsAt: number | null;
  /** Local countdown, recomputed every second from `endsAt`. */
  remainingSec: number;
  sessionId: string | null;
  /** Inject connection info (from SyncleScreen's `cache` prop). */
  connect: (conn: PomodoroConnection) => void;
  /** Leaving the room: stop the timer, forget the connection. */
  disconnect: () => void;
  start: (kind: FocusKind, minutes: number) => Promise<void>;
  endEarly: () => Promise<void>;
  /** After LiveKit (re)connect: GET active → resume the ticker when a
   *  session is still live server-side. */
  resume: () => Promise<void>;
}

// ---------------------------------------------------------------- internals

let conn: PomodoroConnection | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
/** Last wall-clock ms we published the `focus` attribute. */
let lastAttrPublishAt = 0;

const IDLE_PATCH = {
  phase: "idle" as PomodoroPhase,
  kind: null as FocusKind | null,
  endsAt: null as number | null,
  remainingSec: 0,
  sessionId: null as string | null,
};

function stopTicker(): void {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** Publish the `focus` attribute; never throws (attribute publish must not
 *  break the timer). */
function publishFocusAttribute(phase: PomodoroPhase, remainingSec: number): void {
  const room = conn?.getRoom();
  if (!room) return;
  lastAttrPublishAt = Date.now();
  void (async () => {
    try {
      await setFocusAttribute(room, serializeFocusAttribute(phase, remainingSec));
    } catch (err) {
      console.warn("pomodoro: setFocusAttribute failed", err);
    }
  })();
}

function clearFocusAttribute(): void {
  publishFocusAttribute("idle", 0);
}

/** Best-effort REST end — never throws; the server lazy-settles (§1) as
 *  the backstop when the client cannot reach it. */
async function endSessionBestEffort(sessionId: string | null): Promise<void> {
  if (!conn || !sessionId) return;
  try {
    await endFocusSession(conn.backendUrl, conn.room, conn.getToken(), sessionId);
  } catch (err) {
    console.warn("pomodoro: endFocusSession failed", err);
  }
}

/** Shared `timer_reached_end` / `user_end_early` teardown: stop the ticker,
 *  end the session server-side, clear the attribute, return to idle. */
async function teardownToIdle(notify: boolean): Promise<void> {
  stopTicker();
  const s = usePomodoroStore.getState();
  const finishedKind = s.kind;
  await endSessionBestEffort(s.sessionId);
  clearFocusAttribute();
  usePomodoroStore.setState(IDLE_PATCH);
  if (notify) {
    // §6: local notification when granted; the UI layer degrades to an
    // in-app toast when this returns false (it cannot render UI here).
    const finished = finishedKind === "break";
    sendLocalNotification(
      finished ? "休息结束" : "专注完成",
      finished ? "休息时间到，回来继续专注吧" : "本次专注完成，要不要休息一下？",
    );
  }
}

function tick(): void {
  const s = usePomodoroStore.getState();
  if (s.phase === "idle" || s.endsAt === null) {
    stopTicker();
    return;
  }
  const remaining = remainingSecFromEndsAt(s.endsAt, Date.now());
  if (remaining <= 0) {
    // timer_reached_end (§2): end, clear attribute, notify.
    void teardownToIdle(true);
    return;
  }
  usePomodoroStore.setState({ remainingSec: remaining });
  // 30 s attribute heartbeat while active (§3).
  if (Date.now() - lastAttrPublishAt >= FOCUS_HEARTBEAT_MS) {
    publishFocusAttribute(s.phase, remaining);
  }
}

function startTicker(): void {
  stopTicker();
  ticker = setInterval(tick, FOCUS_TICK_MS);
}

/** Activate the local state machine from a server session (start/resume). */
function activateFromSession(dto: FocusSessionDto): void {
  const derived = derivePhaseFromSession(dto, Date.now());
  if (derived.phase === "idle") {
    usePomodoroStore.setState(IDLE_PATCH);
    return;
  }
  const remaining = remainingSecFromEndsAt(dto.endsAt, Date.now());
  usePomodoroStore.setState({
    phase: derived.phase,
    kind: dto.kind,
    endsAt: dto.endsAt,
    remainingSec: remaining,
    sessionId: dto.id,
  });
  publishFocusAttribute(derived.phase, remaining);
  startTicker();
}

// ---------------------------------------------------------------- store

export const usePomodoroStore = create<PomodoroStoreState>()((set, get) => ({
  phase: "idle",
  kind: null,
  endsAt: null,
  remainingSec: 0,
  sessionId: null,

  connect: (c) => {
    conn = c;
  },

  disconnect: () => {
    stopTicker();
    conn = null;
    set(IDLE_PATCH);
  },

  start: async (kind, minutes) => {
    if (get().phase !== "idle") {
      console.warn("pomodoro: start() while a session is active — ignored");
      return;
    }
    if (!conn) {
      console.warn("pomodoro: start() before connect() — ignored");
      return;
    }
    // Server accepts 1–180 (§4); clamp client-side so a misbehaving UI
    // cannot send an out-of-range body.
    const plannedMinutes = Math.min(180, Math.max(1, Math.floor(minutes)));
    let dto: FocusSessionDto;
    try {
      dto = await startFocusSession(conn.backendUrl, conn.room, conn.getToken(), {
        kind,
        plannedMinutes,
      });
    } catch (err) {
      console.warn("pomodoro: startFocusSession failed", err);
      return;
    }
    activateFromSession(dto);
  },

  endEarly: async () => {
    if (get().phase === "idle") return;
    // user_end_early (§2): server marks completed = 0; no notification.
    await teardownToIdle(false);
  },

  resume: async () => {
    if (!conn) return;
    let dto: FocusSessionDto | null;
    try {
      ({ session: dto } = await getActiveFocusSession(
        conn.backendUrl,
        conn.room,
        conn.getToken(),
      ));
    } catch (err) {
      console.warn("pomodoro: getActiveFocusSession failed", err);
      return;
    }
    if (!dto) {
      stopTicker();
      set(IDLE_PATCH);
      return;
    }
    activateFromSession(dto);
  },
}));
