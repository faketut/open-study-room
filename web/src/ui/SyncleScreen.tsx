import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type Participant } from "livekit-client";
import {
  Mic, MicOff, Video, VideoOff, Monitor, MonitorOff,
  MessageSquare, StickyNote, X, Settings, Shield, Timer,
} from "lucide-react";
import { SpatialCanvas } from "./SpatialCanvas";
import { TouchJoystick } from "./TouchJoystick";
import { TouchActionBar } from "./TouchActionBar";
import { PttButton } from "./PttButton";
import { MobileDrawer } from "./MobileDrawer";
import { PerfSettings } from "./PerfSettings";
import {
  AVATAR_RADIUS,
  LOCAL_CHAT_IDENTITY,
  MOVE_SPEED_PER_SEC,
  useSyncle,
} from "../state/syncleStore";
import {
  applyMove,
  findNearestBoard,
  findNearestNote,
  findNearestTable,
  findPortalAt,
  loadMapConfig,
} from "../domain/mapConfig";
import { encodePosition, nextSeq } from "../domain/positionPacket";
import { hzForTier, nearestPeerDistance, tierForDistance } from "../domain/aoiPolicy";
import {
  publishPosition,
  publishReliable,
  setCameraEnabled,
  setMicEnabled,
  setPeerVideoSubscribed,
  setPeerAudioSubscribed,
  setPeerVolume,
  setScreenShareEnabled,
  setStatusAttribute,
  setTableAttribute,
  setNowPlayingAttribute,
  setZoneAttributes,
  attenuationFor,
} from "../data/liveKitService";
import { isBlockedIdentity } from "../domain/blockList";
import {
  zoneKindAt,
  zoneAllowsAudio,
  zonesOf,
  findZoneAt,
  type ZoneKind,
} from "../domain/zones";
import {
  micMayPublish,
  reduceZoneCrossing,
  shouldApplyVolume,
} from "../domain/audioPolicy";
import {
  hasArrived,
  screenToWorld,
  stepToward,
  type Point,
} from "../domain/touchMove";
import {
  interactActionFor,
  type TouchAction,
} from "../domain/touchActions";
import { computeViewport } from "../domain/camera";
import {
  readPerfTier,
  writePerfTier,
  environmentFromNavigator,
  type PerfTier,
} from "../domain/perfPrefs";
import { reportState } from "../data/sessionApi";
import { ChatPanel } from "./ChatPanel";
import { VideoTiles } from "./VideoTiles";
import { WhosWherePanel } from "./WhosWherePanel";
import { ModerationPanel } from "./ModerationPanel";
import { FocusStatsPanel } from "./FocusStatsPanel";
import { SitFocusPrompt } from "./SitFocusPrompt";
import { usePomodoroStore } from "../state/pomodoroStore";
import { useAuth } from "../state/authStore";
// P1-B account chip strings (contracts.md "Identity & login"). Bilingual
// via the existing pickUiLang/localizeText pattern (no i18n framework).
import { AUTH_STRINGS } from "../data/auth";
import { localizeText, pickUiLang } from "../domain/templateRegistry";
import { MeetingView } from "./MeetingView";
import { MiniPanel } from "./MiniPanel";
import { BoardModal } from "./BoardModal";
import type { ConnectCache } from "../data/connectionController";
import {
  deriveStatus,
  statusMeta,
  type AvatarStatus,
} from "../domain/avatarStatus";
import {
  DEFAULT_REACTION_INDEX,
  encodeReaction,
  REACTIONS,
} from "../domain/reactionPacket";

/** Pick up a table when the avatar center is within this many world units of
 *  the table edge. Same idea as TableMeetingController on Android. */
const TABLE_JOIN_RADIUS = 40;
/** Show the "press F to read" hint when the avatar is within this radius of
 *  a sticky-note object. */
const NOTE_READ_RADIUS = 36;
/** MW1: coarse-pointer (touch) detection. Touch controls mount only when
 *  true, so desktop keeps zero touch listeners (spec §1). */
const isCoarsePointer =
  typeof window !== "undefined" &&
  (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window);
/** Minimum interval between two portal teleports. Prevents instant bounce
 *  through an inverse portal at the destination. */
const PORTAL_COOLDOWN_MS = 1500;
/** localStorage key for the persisted mute preference. */
const MUTE_PREF_KEY = "syncle.userMuted";

function readPersistedMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export interface SyncleScreenProps {
  room: Room;
  /** Connect cache. Always set in production; nullable for backwards-compat
   *  with the prior signature. Used to read the latest session token (which
   *  ConnectionController mutates in place on refresh) and to look up the
   *  backend URL / room name for REST calls. */
  cache?: ConnectCache | null;
  onLeave: () => void;
  /** Triggers an immediate reconnect attempt while the overlay is up. */
  onRetryReconnect?: () => void;
}

export function SyncleScreen({ room, cache, onLeave, onRetryReconnect }: SyncleScreenProps) {
  const map = useSyncle((s) => s.map);
  const self = useSyncle((s) => s.self);
  // P1-B login (contracts.md "Identity & login"): `account` is null for
  // anonymous users — the account chip and everything auth stays hidden.
  const account = useAuth((s) => s.account);
  const logoutAuth = useAuth((s) => s.logout);
  const uiLang = pickUiLang(
    typeof navigator !== "undefined" ? navigator.language : undefined,
  );
  // Moderation powers: M2 host, plus P1-B site-level admin (server-computed
  // from the env allowlist — the client never asserts it; the server DB is
  // the final arbiter for every moderation call).
  const isModerator = self?.role === "host" || self?.role === "admin";
  const peerCount = useSyncle((s) => s.peers.size);
  const setSelfPosition = useSyncle((s) => s.setSelfPosition);
  const setSelfTable = useSyncle((s) => s.setSelfTable);
  // Stable signature that only changes when some peer's tableId changes (not
  // on every position packet). Drives the audio-scoping effect without
  // re-running 20Hz.
  const peerTableSig = useSyncle((s) => {
    let sig = "";
    for (const [k, v] of s.peers) sig += `${k}:${v.tableId ?? ""};`;
    return sig;
  });

  const keysRef = useRef<Set<string>>(new Set());
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(performance.now());
  const lastPublishRef = useRef<number>(0);
  const lastPublishedRef = useRef<{ x: number; y: number } | null>(null);
  /** Set while a portal teleport is in flight so we don't fire concurrent
   *  map fetches. */
  const portalLoadingRef = useRef(false);
  // M3: the connection controller swaps the Room object on reconnect (App
  // handleConnected swaps it in); the pomodoro store reads the current
  // Room through a getter, so mirror the prop into a ref.
  const roomRef = useRef(room);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);
  /** ms epoch of the last portal teleport (or 0). Used with PORTAL_COOLDOWN_MS
   *  to keep the player from instantly bouncing back through the inverse
   *  portal on the destination side. */
  const lastPortalAtRef = useRef<number>(0);
  const [nearbyTable, setNearbyTable] = useState<string | null>(null);
  const [nearbyNoteIndex, setNearbyNoteIndex] = useState<number | null>(null);
  /** When set, render the NoteModal showing this note's text. */
  const [readingNoteIndex, setReadingNoteIndex] = useState<number | null>(null);
  /** Index of the nearest board, if any — drives the "press F" hint. */
  const [nearbyBoardIndex, setNearbyBoardIndex] = useState<number | null>(null);
  /** When set, render the BoardModal for this board. */
  const [viewingBoardIndex, setViewingBoardIndex] = useState<number | null>(null);
  // Refs so the keydown closure (which is registered once) can read current
  // values without re-binding on every state change.
  const nearbyNoteIndexRef = useRef<number | null>(null);
  const readingNoteIndexRef = useRef<number | null>(null);
  useEffect(() => { nearbyNoteIndexRef.current = nearbyNoteIndex; }, [nearbyNoteIndex]);
  useEffect(() => { readingNoteIndexRef.current = readingNoteIndex; }, [readingNoteIndex]);
  const nearbyBoardIndexRef = useRef<number | null>(null);
  const viewingBoardIndexRef = useRef<number | null>(null);
  useEffect(() => { nearbyBoardIndexRef.current = nearbyBoardIndex; }, [nearbyBoardIndex]);
  useEffect(() => { viewingBoardIndexRef.current = viewingBoardIndex; }, [viewingBoardIndex]);
  /** User-controlled push-to-mute. Only meaningful while seated (we always
   *  publish silence while walking). Toggle with the HUD button or `M` key.
   *  Persisted to localStorage so a reload doesn't unmute mid-meeting. */
  const [userMuted, setUserMuted] = useState<boolean>(readPersistedMuted);
  useEffect(() => {
    try {
      localStorage.setItem(MUTE_PREF_KEY, userMuted ? "1" : "0");
    } catch {
      /* storage unavailable; ignore */
    }
  }, [userMuted]);
  /** Set to true after a mic permission denial / no-device. We then stop
   *  re-publishing on every render and show an inline banner. Cleared when
   *  the user clicks "Retry" or toggles unmute (which re-prompts). */
  const [micDenied, setMicDenied] = useState(false);
  // Ref so the keydown closure (registered once) can read the current value.
  const micDeniedRef = useRef(false);
  useEffect(() => { micDeniedRef.current = micDenied; }, [micDenied]);
  /** M1: zone kind of the local avatar ("none" outside any zone). Updated
   *  by the game loop only on boundary crossings; drives the mic state
   *  machine, PTT, publish gates, and spatial-audio scoping. */
  const [zoneKind, setZoneKind] = useState<ZoneKind>("none");
  const zoneKindRef = useRef<ZoneKind>("none");
  useEffect(() => { zoneKindRef.current = zoneKind; }, [zoneKind]);
  /** T4 push-to-talk: Space held while in a silent zone. Mic-only. */
  const [pttHeld, setPttHeld] = useState(false);
  const pttHeldRef = useRef(false);
  /** Last published zone (id + kind). Debounces attribute writes: we only
   *  call setZoneAttributes on boundary crossings, never for movement
   *  inside the same zone. */
  const lastZoneRef = useRef<{ id: string; kind: ZoneKind } | null>(null);
  /** Mic intent remembered at silent entry (contract: `intendedMicOn`). */
  const intendedMicOnRef = useRef(true);
  /** Ref mirror of `userMuted` so the once-bound keydown handler and the
   *  game-loop tick can toggle/read it without re-binding. */
  const userMutedRef = useRef<boolean>(readPersistedMuted());
  useEffect(() => { userMutedRef.current = userMuted; }, [userMuted]);
  /** Single toggle path for the HUD button and the `M` key. While inside a
   *  silent zone the mic stays forced-mute, but the toggle still updates
   *  the remembered intent so leaving the zone restores what the user last
   *  asked for. */
  const toggleUserMuted = () => {
    if (micDeniedRef.current) {
      setMicDenied(false);
      setUserMuted(false);
      if (zoneKindRef.current === "silent") intendedMicOnRef.current = true;
      return;
    }
    const next = !userMutedRef.current;
    userMutedRef.current = next;
    setUserMuted(next);
    if (zoneKindRef.current === "silent") intendedMicOnRef.current = next;
  };
  /** Camera opt-in. Defaults to OFF — users explicitly turn it on so we
   *  don't auto-prompt for permission on first sit. */
  const [userCamOff, setUserCamOff] = useState(true);
  /** Set to true after a camera permission denial so we stop retrying and
   *  can show an inline hint instead. Cleared when the user toggles off. */
  const [camDenied, setCamDenied] = useState(false);
  /** Screen-share state. Unlike mic/cam this is event-driven: clicking the
   *  button triggers the browser picker. We mirror the actual publication
   *  state so that "Stop sharing" from the browser toolbar flips the button
   *  back to inactive automatically. */
  const [sharingScreen, setSharingScreen] = useState(false);
  /** Reaction picker popover visibility. Press R for a quick wave; click the
   *  Reactions HUD button to open this for a different glyph. */
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  /** Fullscreen meeting view (M4). Only meaningful while seated; auto-closes
   *  when the user stands up so we don't show an empty grid. */
  const [meetingViewOpen, setMeetingViewOpen] = useState(false);
  /** Latest input timestamp, used to derive `away` status after idle. Bumped
   *  on any keypress / mousemove. */
  const lastInputAtRef = useRef(performance.now());
  /** Ref-bridged pushReaction so the once-bound keydown handler can fire it
   *  without re-binding on every store change. */
  const pushReaction = useSyncle((s) => s.pushReaction);
  const clearExpiredReactions = useSyncle((s) => s.clearExpiredReactions);
  const setSelfStatus = useSyncle((s) => s.setSelfStatus);
  const setManualBusy = useSyncle((s) => s.setManualBusy);
  const theme = useSyncle((s) => s.theme);
  const setTheme = useSyncle((s) => s.setTheme);
  const miniMode = useSyncle((s) => s.miniMode);
  const setMiniMode = useSyncle((s) => s.setMiniMode);
  const setSelfNowPlaying = useSyncle((s) => s.setSelfNowPlaying);
  const selfNowPlaying = useSyncle((s) => s.self?.nowPlaying ?? "");
  /** Edit-state for the HUD now-playing input. Committed on Enter/blur. */
  const [nowPlayingDraft, setNowPlayingDraft] = useState("");
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  useEffect(() => { setNowPlayingDraft(selfNowPlaying); }, [selfNowPlaying]);
  const pushReactionRef = useRef(pushReaction);
  useEffect(() => { pushReactionRef.current = pushReaction; }, [pushReaction]);
  useEffect(() => {
    const sync = () => {
      let live = false;
      for (const pub of room.localParticipant.trackPublications.values()) {
        if (pub.source === Track.Source.ScreenShare && !pub.isMuted) {
          live = true;
          break;
        }
      }
      setSharingScreen(live);
    };
    sync();
    room
      .on(RoomEvent.LocalTrackPublished, sync)
      .on(RoomEvent.LocalTrackUnpublished, sync)
      .on(RoomEvent.TrackMuted, sync)
      .on(RoomEvent.TrackUnmuted, sync);
    return () => {
      room
        .off(RoomEvent.LocalTrackPublished, sync)
        .off(RoomEvent.LocalTrackUnpublished, sync)
        .off(RoomEvent.TrackMuted, sync)
        .off(RoomEvent.TrackUnmuted, sync);
    };
  }, [room]);
  // If the user stands up while sharing, stop the share so we don't leak
  // a screen to the room when they leave the table.
  useEffect(() => {
    if (self?.tableId == null && sharingScreen) {
      void setScreenShareEnabled(room, false);
    }
  }, [room, self?.tableId, sharingScreen]);

  // Auto-close meeting view if the user stands up. The view requires being
  // seated to source tiles, and Gather mirrors this dismissal.
  useEffect(() => {
    if (self?.tableId == null && meetingViewOpen) {
      setMeetingViewOpen(false);
    }
  }, [self?.tableId, meetingViewOpen]);
  // Active speaker tracking: push the current speaker identities into the
  // store so SpatialCanvas can draw a ring on whoever is talking. LiveKit
  // emits this whenever the speaking set changes (typically every ~100ms
  // while audio is active). Includes the local participant.
  const setSpeakingIdentities = useSyncle((s) => s.setSpeakingIdentities);
  useEffect(() => {
    const handler = (speakers: Participant[]) => {
      const ids = new Set<string>();
      for (const p of speakers) ids.add(p.identity);
      setSpeakingIdentities(ids);
    };
    room.on(RoomEvent.ActiveSpeakersChanged, handler);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, handler);
      // Clear on unmount so a re-join starts with a clean set.
      setSpeakingIdentities(new Set());
    };
  }, [room, setSpeakingIdentities]);

  // Presence status auto-derivation. Runs on (seated, muted, manualBusy)
  // changes and every 30s so the idle->away transition fires without input.
  // We publish via setStatusAttribute → LiveKit attributes, which replays on
  // peer (re)join just like table_id.
  const selfStatus = useSyncle((s) => s.self?.status);
  const selfManualBusy = useSyncle((s) => s.self?.manualBusy ?? false);
  // M3: pomodoro phase drives the `focusing` status input (T11).
  const pomodoroPhase = usePomodoroStore((s) => s.phase);
  const pomodoroKind = usePomodoroStore((s) => s.kind);
  /** Set before a programmatic endEarly()/disconnect() so the resulting
   *  non-idle → idle transition doesn't show the completion toast (§6). */
  const suppressFocusToastRef = useRef(false);
  /** M3 T10: in-app toast for the completion banner. */
  const [focusToast, setFocusToast] = useState<{
    title: string;
    body: string;
  } | null>(null);
  useEffect(() => {
    if (!self) return;
    const recompute = () => {
      const idleMs = performance.now() - lastInputAtRef.current;
      const next = deriveStatus({
        seated: self.tableId != null,
        muted: userMuted,
        idleMs,
        manualBusy: selfManualBusy,
        focusing: pomodoroPhase !== "idle",
      });
      if (next !== selfStatus) {
        setSelfStatus(next);
        void setStatusAttribute(room, next).catch((err) =>
          console.warn("setStatusAttribute failed", err),
        );
      }
    };
    recompute();
    const id = window.setInterval(recompute, 30_000);
    return () => window.clearInterval(id);
  }, [
    room,
    self,
    self?.tableId,
    userMuted,
    selfManualBusy,
    selfStatus,
    setSelfStatus,
    pomodoroPhase,
  ]);

  // M3 T11: standing up (table_id goes from non-empty to empty) while a
  // focus session is active ends it immediately as interrupted
  // (completed = 0, per the contract's stand_up row). Does not fire for
  // on_break, which the user ends explicitly.
  const prevTableIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevTableIdRef.current;
    const cur = self?.tableId ?? null;
    prevTableIdRef.current = cur;
    if (prev != null && cur == null) {
      const st = usePomodoroStore.getState();
      if (st.phase === "focusing") {
        suppressFocusToastRef.current = true;
        void st.endEarly().catch((err) =>
          console.warn("endEarly on stand-up failed", err),
        );
      }
    }
  }, [self?.tableId]);

  // M3 §5: best-effort session end when the tab closes or the user leaves
  // the room. navigator.sendBeacon can't do authenticated JSON REST, so a
  // plain fetch is the best-effort fallback and failures are ignored; the
  // server's lazy-settle of abandoned sessions (§1) is the real backstop.
  useEffect(() => {
    const onBeforeUnload = () => {
      try {
        const st = usePomodoroStore.getState();
        if (st.phase !== "idle") {
          suppressFocusToastRef.current = true;
          void st.endEarly().catch(() => {});
        }
      } catch {
        /* best-effort only */
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // M3: inject connection info into the pomodoro store. The store's actions
  // no-op until connect() runs, so this is what makes SitFocusPrompt,
  // the stand-up interrupt, and the beforeunload end actually reach the
  // server. Values come from the same `cache` prop as reportState
  // (ConnectCache: backendUrl, room, session.token, session.userId); the
  // token and room go through getters because the ConnectionController
  // mutates/refreshes them in place. resume() restores a live server
  // session after (re)join (contract §2 reconnect row).
  useEffect(() => {
    if (
      !cache?.backendUrl ||
      !cache?.room ||
      !cache?.session?.token ||
      !cache?.session?.userId
    ) {
      return;
    }
    const st = usePomodoroStore.getState();
    st.connect({
      backendUrl: cache.backendUrl,
      room: cache.room,
      getToken: () => cache.session?.token ?? "",
      userId: cache.session.userId,
      getRoom: () => roomRef.current,
    });
    void st.resume().catch((err) => console.warn("pomodoro resume failed", err));
    return () => {
      // Leaving the room (or swapping Room on reconnect): the store's
      // disconnect resets to idle without ending the session server-side
      // (contract §2: server lazy-settles) — not a completion, no toast.
      // Only arm the flag when a session is actually active, otherwise a
      // stale flag would swallow a later real completion's toast.
      const cur = usePomodoroStore.getState();
      if (cur.phase !== "idle") suppressFocusToastRef.current = true;
      cur.disconnect();
    };
  }, [room, cache]);

  // M3 §6: in-app completion toast. The store fires the Notification API
  // internally on natural timer end and ignores its result, so the UI
  // always shows the toast alongside it — this covers iOS Safari and
  // denied permission, where the Notification API can't fire. A
  // non-idle → idle transition caused by our own endEarly()/disconnect()
  // (stand-up, unload, reconnect swap) is suppressed via the flag above.
  const prevPomodoroRef = useRef<{ phase: string; kind: string | null }>({
    phase: "idle",
    kind: null,
  });
  useEffect(() => {
    const prev = prevPomodoroRef.current;
    prevPomodoroRef.current = { phase: pomodoroPhase, kind: pomodoroKind };
    if (prev.phase !== "idle" && pomodoroPhase === "idle") {
      if (suppressFocusToastRef.current) {
        suppressFocusToastRef.current = false;
        return;
      }
      const wasBreak = prev.kind === "break";
      setFocusToast(
        wasBreak
          ? { title: "休息结束", body: "休息时间到，回来继续专注吧" }
          : { title: "专注完成", body: "本次专注完成，要不要休息一下？" },
      );
    }
  }, [pomodoroPhase, pomodoroKind]);

  // Auto-dismiss the completion toast.
  useEffect(() => {
    if (!focusToast) return;
    const id = window.setTimeout(() => setFocusToast(null), 8000);
    return () => window.clearTimeout(id);
  }, [focusToast]);

  // M1: state-report heartbeat. Zone-crossing reports above are the
  // primary path, but a lost report (e.g. expired token at the crossing
  // moment) would leave the server blind to our zone. 30s cadence.
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = useSyncle.getState().self;
      const z = lastZoneRef.current;
      if (!s || !cache?.backendUrl || !cache?.session?.token) return;
      void reportState(cache.backendUrl, cache.room, cache.session.token, {
        userId: cache.session.userId,
        tableId: s.tableId ?? null,
        x: s.x,
        y: s.y,
        zone: z && z.id !== "" ? z.id : null,
        zone_kind: z?.kind ?? "none",
      }).catch((err) => console.warn("reportState heartbeat failed", err));
    }, 30_000);
    return () => window.clearInterval(id);
  }, [cache]);

  // Track user activity so deriveStatus can flip to `away`. Listens on
  // window so we capture both game input and HUD interaction.
  useEffect(() => {
    const bump = () => {
      lastInputAtRef.current = performance.now();
    };
    window.addEventListener("keydown", bump);
    window.addEventListener("mousemove", bump);
    return () => {
      window.removeEventListener("keydown", bump);
      window.removeEventListener("mousemove", bump);
    };
  }, []);

  // Reaction expiry tick. Reactions live ~2s; this trims the map so the
  // canvas stops painting them. 250ms cadence is invisible to users and
  // far cheaper than a per-reaction setTimeout.
  useEffect(() => {
    const id = window.setInterval(() => clearExpiredReactions(), 250);
    return () => window.clearInterval(id);
  }, [clearExpiredReactions]);
  /** Chat panel visibility + typing guard so WASD/M/E don't fire while the
   *  user is composing a message. */
  const [chatOpen, setChatOpen] = useState(false);
  // MW1-2: drawer state for the responsive panels (desktop renders inline
  // via CSS `display: contents`, so these only matter on coarse pointers).
  const [whosWhereOpen, setWhosWhereOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  // M2 moderation panel (host-only). Entry button renders only when
  // `self.role === "host"`.
  const [moderationOpen, setModerationOpen] = useState(false);
  // M3 T10: focus stats panel. Opened from the HUD Timer button.
  const [statsOpen, setStatsOpen] = useState(false);
  // M2: set by the kick_notice data packet (see JoinScreen). Disconnects
  // and routes back to JoinScreen, which shows the reason.
  const kicked = useSyncle((s) => s.kicked);
  // Room name, for the per-room block list key (`syncle.blocked.<room>`).
  // Stable for the session; captured by the volume effect below.
  const roomName = cache?.room ?? "";
  // MW1-4: performance tier (persisted). Drives frame throttle + DPR cap.
  const [perfOpen, setPerfOpen] = useState(false);
  const [perfTier, setPerfTier] = useState<PerfTier>(() =>
    readPerfTier(
      localStorage,
      typeof navigator !== "undefined"
        ? environmentFromNavigator(navigator)
        : undefined,
    ),
  );
  const perfTierRef = useRef(perfTier);
  useEffect(() => {
    perfTierRef.current = perfTier;
  }, [perfTier]);
  // MW1-1: touch movement refs. Joystick writes touchVecRef; tap-to-move
  // writes tapTargetRef. Both are consumed by the game-loop tick.
  const touchVecRef = useRef({ x: 0, y: 0 });
  const tapTargetRef = useRef<Point | null>(null);
  const stalledFramesRef = useRef(0);
  const tapDownRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const [typingInChat, setTypingInChat] = useState(false);
  const typingRef = useRef(false);
  useEffect(() => { typingRef.current = typingInChat; }, [typingInChat]);
  // Tracks unread count while panel is closed. Reset on open.
  const chatMessagesLen = useSyncle((s) => s.chatMessages.length);
  const [seenChatLen, setSeenChatLen] = useState(chatMessagesLen);
  const unread = Math.max(0, chatMessagesLen - seenChatLen);
  useEffect(() => {
    if (chatOpen) setSeenChatLen(chatMessagesLen);
  }, [chatOpen, chatMessagesLen]);
  // When chat opens, drop any held movement keys so the avatar doesn't drift.
  // Also release PTT: typing in chat must never leave the mic hot.
  useEffect(() => {
    if (chatOpen) {
      keysRef.current.clear();
      if (pttHeldRef.current) {
        pttHeldRef.current = false;
        setPttHeld(false);
      }
    }
  }, [chatOpen]);

  // MW1-3: sit/stand toggle shared by the E key and the touch action bar.
  const toggleSit = useCallback(() => {
    tapTargetRef.current = null; // sitting/standing cancels tap-to-move
    const state = useSyncle.getState();
    const selfNow = state.self;
    const mapNow = state.map;
    if (!selfNow || !mapNow) return;
    if (selfNow.tableId) {
      setSelfTable(null);
      void setTableAttribute(room, null).catch((err) =>
        console.warn("setTableAttribute(null) failed", err),
      );
    } else {
      const near = findNearestTable(
        selfNow.x,
        selfNow.y,
        mapNow,
        TABLE_JOIN_RADIUS,
      );
      if (near) {
        setSelfTable(near.id);
        void setTableAttribute(room, near.id).catch((err) =>
          console.warn("setTableAttribute failed", err),
        );
      }
    }
  }, [room, setSelfTable]);

  // MW1-3: open nearest board (precedence, same as F) or note; shared by
  // the F key and the touch action bar.
  const openNearbyInteract = useCallback(() => {
    const bIdx = nearbyBoardIndexRef.current;
    if (bIdx != null) {
      setViewingBoardIndex(bIdx);
    } else {
      const idx = nearbyNoteIndexRef.current;
      if (idx != null) setReadingNoteIndex(idx);
    }
  }, []);

  // Keyboard input. WASD/arrows move; E toggles "sit at nearest table".
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Suppress all game keybinds while the user is typing in chat. The
      // chat input itself handles Enter/Esc and stops propagation, so those
      // never reach here.
      if (typingRef.current) return;
      if (isMoveKey(e.key)) {
        e.preventDefault();
        keysRef.current.add(e.key.toLowerCase());
      } else if (e.key === " ") {
        // T4 push-to-talk: hold Space to talk in silent zones (mic only).
        // Space has no PTT semantics in discussion/rest/none zones, and is
        // ignored while typing in chat.
        if (typingRef.current) return;
        if (e.repeat) return;
        if (zoneKindRef.current === "silent" && !pttHeldRef.current) {
          e.preventDefault();
          pttHeldRef.current = true;
          setPttHeld(true);
        }
      } else if (e.key.toLowerCase() === "e") {
        e.preventDefault();
        // Toggle: if seated -> stand; else try to sit at nearest table.
        toggleSit();
      } else if (e.key.toLowerCase() === "m") {
        // Manual mute toggle. Routes through toggleUserMuted so the
        // silent-zone intent bookkeeping stays consistent. When mic is in
        // the "denied" latch, pressing M acts as a retry.
        e.preventDefault();
        toggleUserMuted();
      } else if (e.key.toLowerCase() === "t") {
        // Open chat. (Closing is handled by the input's Esc handler so it
        // doesn't compete with typed 't' characters.)
        e.preventDefault();
        setChatOpen(true);
      } else if (e.key.toLowerCase() === "f") {
        // Open the nearest interactive object. Boards take precedence over
        // notes when both are within reach, since boards are larger and the
        // intent is usually "open the PR list" when standing in front of one.
        e.preventDefault();
        openNearbyInteract();
      } else if (e.key.toLowerCase() === "r") {
        // Quick reaction (default = wave). The reaction picker UI lives in
        // the HUD; this hotkey is the one-shot wave shortcut.
        e.preventDefault();
        const glyph = REACTIONS[DEFAULT_REACTION_INDEX].glyph;
        pushReactionRef.current?.(LOCAL_CHAT_IDENTITY, glyph);
        void publishReliable(room, encodeReaction(DEFAULT_REACTION_INDEX)).catch(
          (err) => console.warn("publish reaction failed", err),
        );
      } else if (e.key === "Escape") {
        // Close any note or board modal.
        if (readingNoteIndexRef.current != null) {
          e.preventDefault();
          setReadingNoteIndex(null);
        } else if (viewingBoardIndexRef.current != null) {
          e.preventDefault();
          setViewingBoardIndex(null);
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (typingRef.current) return;
      if (isMoveKey(e.key)) {
        e.preventDefault();
        keysRef.current.delete(e.key.toLowerCase());
      } else if (e.key === " ") {
        // T4: releasing Space ends the push-to-talk window.
        if (pttHeldRef.current) {
          e.preventDefault();
          pttHeldRef.current = false;
          setPttHeld(false);
        }
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [room, setSelfTable, toggleSit, openNearbyInteract]);

  // Safety: if the window loses focus mid-PTT (alt-tab while holding
  // Space), the keyup never fires — release PTT on blur so the mic can't
  // get stuck open in a silent zone.
  useEffect(() => {
    const release = () => {
      if (pttHeldRef.current) {
        pttHeldRef.current = false;
        setPttHeld(false);
      }
    };
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, []);

  // Game loop: move local avatar + AOI-tiered position broadcast (M4).
  // The publish rate follows the nearest known peer's distance tier
  // (NEAR 20 Hz / MID 5 Hz / FAR 1 Hz); stationary clients publish nothing.
  useEffect(() => {
    if (!map) return;

    const tick = (now: number) => {
      // MW1-4 battery tier: cap the game loop at ~30fps. lastTickRef is
      // only updated on executed frames so dt stays correct on resume.
      if (
        perfTierRef.current === "battery" &&
        now - lastTickRef.current < 1000 / 30
      ) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const dtMs = now - lastTickRef.current;
      lastTickRef.current = now;
      const dt = dtMs / 1000;

      const keys = keysRef.current;
      let dx = 0;
      let dy = 0;
      if (keys.has("w") || keys.has("arrowup")) dy -= 1;
      if (keys.has("s") || keys.has("arrowdown")) dy += 1;
      if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
      if (keys.has("d") || keys.has("arrowright")) dx += 1;
      // MW1-1: touch joystick vector merges with keyboard input (the two
      // are mutually exclusive in practice; summed then normalized).
      const joy = touchVecRef.current;
      if (joy.x !== 0 || joy.y !== 0) {
        dx += joy.x;
        dy += joy.y;
      }
      if (dx !== 0 || dy !== 0) {
        // Any keyboard/joystick input cancels tap-to-move.
        tapTargetRef.current = null;
        stalledFramesRef.current = 0;
        const len = Math.hypot(dx, dy);
        dx /= len;
        dy /= len;
        const stepX = dx * MOVE_SPEED_PER_SEC * dt;
        const stepY = dy * MOVE_SPEED_PER_SEC * dt;
        const current = useSyncle.getState().self;
        if (current) {
          const moved = applyMove(
            { x: current.x, y: current.y },
            { x: stepX, y: stepY },
            AVATAR_RADIUS,
            map,
          );
          if (moved.x !== current.x || moved.y !== current.y) {
            setSelfPosition(moved.x, moved.y);
          }
        }
      } else {
        // MW1-1: tap-to-move — straight-line move toward the tap target.
        // Cancelled on arrival, stall (tapped inside a wall), sit, or map
        // change. applyMove handles wall sliding; stall detection avoids
        // jitter against obstacles.
        const tapTarget = tapTargetRef.current;
        if (tapTarget) {
          const current = useSyncle.getState().self;
          if (current && !current.tableId) {
            if (hasArrived({ x: current.x, y: current.y }, tapTarget)) {
              tapTargetRef.current = null;
            } else {
              const next = stepToward(
                { x: current.x, y: current.y },
                tapTarget,
                MOVE_SPEED_PER_SEC * dt,
              );
              const moved = applyMove(
                { x: current.x, y: current.y },
                { x: next.x - current.x, y: next.y - current.y },
                AVATAR_RADIUS,
                map,
              );
              if (
                Math.hypot(moved.x - current.x, moved.y - current.y) < 0.5
              ) {
                stalledFramesRef.current += 1;
                if (stalledFramesRef.current >= 10) {
                  tapTargetRef.current = null;
                  stalledFramesRef.current = 0;
                }
              } else {
                stalledFramesRef.current = 0;
                setSelfPosition(moved.x, moved.y);
              }
            }
          } else {
            tapTargetRef.current = null;
          }
        }
      }

      // Portal teleport. Triggers when the avatar center enters a portal's
      // AABB. Cooldown guards against immediate re-entry on the destination
      // side. While loading we mark `portalLoadingRef.current` true so we
      // don't fire concurrent fetches.
      const portalSelf = useSyncle.getState().self;
      if (
        portalSelf &&
        !portalLoadingRef.current &&
        now - lastPortalAtRef.current > PORTAL_COOLDOWN_MS
      ) {
        const portal = findPortalAt(portalSelf.x, portalSelf.y, map);
        if (portal && portal.destination) {
          portalLoadingRef.current = true;
          lastPortalAtRef.current = now;
          const dest = portal.destination;
          void loadMapConfig(dest.mapUrl)
            .then((newMap) => {
              const spawn = dest.spawn ?? { x: newMap.bounds.x + 40, y: newMap.bounds.y + 40 };
              const st = useSyncle.getState();
              st.setMap(newMap);
              // Stand the user up: tables don't carry across maps.
              st.setSelfTable(null);
              st.setSelfPosition(spawn.x, spawn.y);
              // MW1-1: map change cancels tap-to-move.
              tapTargetRef.current = null;
              // Push the spawn position to peers so the avatar doesn't appear
              // to slide across the old map briefly.
              const packet = encodePosition(spawn.x, spawn.y, nextSeq());
              void publishPosition(room, packet).catch((err) =>
                console.warn("portal publish failed", err),
              );
              // Teleport bypass: not tiered. Record the publish so the AOI
              // loop below doesn't immediately re-send the same position.
              lastPublishedRef.current = { x: spawn.x, y: spawn.y };
              lastPublishRef.current = performance.now();
            })
            .catch((err) => {
              console.warn("portal load failed", err);
            })
            .finally(() => {
              portalLoadingRef.current = false;
            });
        }
      }

      // M4 AOI: publish rate follows the nearest known peer's distance
      // tier (NEAR 20Hz / MID 5Hz / FAR 1Hz heartbeat), but only when the
      // position changed since the last publish -- stationary clients stay
      // at 0Hz, and resume immediately on the first changed tick because
      // lastPublishRef is only advanced on an actual publish. AOI only
      // changes the *rate*; zone policy (M1) and block filtering (M2) are
      // untouched. Portal teleports publish immediately below (bypass).
      const aoiState = useSyncle.getState();
      const aoiSelf = aoiState.self;
      const publishIntervalMs =
        1000 /
        hzForTier(
          tierForDistance(
            aoiSelf ? nearestPeerDistance(aoiSelf, [...aoiState.peers.values()]) : Infinity,
          ),
        );
      if (now - lastPublishRef.current >= publishIntervalMs) {
        const current = useSyncle.getState().self;
        if (current) {
          const last = lastPublishedRef.current;
          if (!last || last.x !== current.x || last.y !== current.y) {
            const packet = encodePosition(current.x, current.y, nextSeq());
            void publishPosition(room, packet).catch((err) =>
              console.warn("publishPosition failed", err),
            );
            lastPublishedRef.current = { x: current.x, y: current.y };
            lastPublishRef.current = now;
          }
        }
      }

      // M1 zone tracking. Zone changes are low-frequency, so they stay off
      // the 20 Hz hot path: we only publish `zone` / `zone_kind` attributes
      // when crossing a boundary (debounced via lastZoneRef), and run the
      // mic state machine transitions (enter/leave silent). Zone policy
      // beats table policy: entering silent force-mutes even while seated.
      const zoneSelf = useSyncle.getState().self;
      if (zoneSelf) {
        const kind: ZoneKind = zoneKindAt(
          zonesOf(map),
          zoneSelf.x,
          zoneSelf.y,
        );
        const zoneObj = findZoneAt(zoneSelf.x, zoneSelf.y, map);
        const zoneId = zoneObj?.key ?? "";
        const prevZone = lastZoneRef.current;
        if (
          !prevZone ||
          prevZone.kind !== kind ||
          prevZone.id !== zoneId
        ) {
          const prevKind: ZoneKind = prevZone?.kind ?? "none";
          lastZoneRef.current = { id: zoneId, kind };
          setZoneKind(kind);
          zoneKindRef.current = kind;
          void setZoneAttributes(room, zoneId, kind).catch((err) =>
            console.warn("setZoneAttributes failed", err),
          );
          // M1: report (x, y, table, zone) to the server so it can enforce
          // the silent-zone media policy server-side and serve late joiners
          // from the snapshot (docs/contracts.md "Zones"). A 401 here just
          // warns; the 30s heartbeat below retries.
          if (cache?.backendUrl && cache.session?.token) {
            void reportState(
              cache.backendUrl,
              cache.room,
              cache.session.token,
              {
                userId: cache.session.userId,
                tableId: zoneSelf.tableId ?? null,
                x: zoneSelf.x,
                y: zoneSelf.y,
                zone: zoneId === "" ? null : zoneId,
                zone_kind: kind,
              },
            ).catch((err) => console.warn("reportState failed", err));
          }
          const crossed = reduceZoneCrossing(
            { kind: prevKind, intendedMicOn: intendedMicOnRef.current },
            kind,
            userMutedRef.current,
            zoneAllowsAudio(kind),
          );
          intendedMicOnRef.current = crossed.intendedMicOn;
          if (crossed.userMuted !== userMutedRef.current) {
            userMutedRef.current = crossed.userMuted;
            setUserMuted(crossed.userMuted);
          }
        }
      }

      // Update "nearest table" hint for HUD + canvas highlight. Cheap; runs
      // every frame against the small table list. Skipped when seated.
      const liveSelf = useSyncle.getState().self;
      if (liveSelf) {
        if (liveSelf.tableId) {
          if (nearbyTable !== null) setNearbyTable(null);
        } else {
          const near = findNearestTable(
            liveSelf.x,
            liveSelf.y,
            map,
            TABLE_JOIN_RADIUS,
          );
          const id = near?.id ?? null;
          if (id !== nearbyTable) setNearbyTable(id);
        }
        // Nearest note hint runs regardless of seated state — sitting doesn't
        // stop you from reading sticky notes on the wall next to your table.
        const nearNote = findNearestNote(
          liveSelf.x,
          liveSelf.y,
          map,
          NOTE_READ_RADIUS,
        );
        const idx = nearNote?.index ?? null;
        if (idx !== nearbyNoteIndex) setNearbyNoteIndex(idx);
        // Nearest board (re-uses the note interaction radius).
        const nearBoard = findNearestBoard(
          liveSelf.x,
          liveSelf.y,
          map,
          NOTE_READ_RADIUS,
        );
        const bIdx = nearBoard?.index ?? null;
        if (bIdx !== nearbyBoardIndex) setNearbyBoardIndex(bIdx);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    lastTickRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [map, room, setSelfPosition, nearbyTable, nearbyNoteIndex, nearbyBoardIndex]);

  // M1 mic publish gate ("quiet by default"). No tracks are published on
  // room join; mic MAY publish when (a) seated at a table in a
  // discussion/rest/none zone, (b) PTT held in a silent zone (mic only),
  // or (c) the user manually enables mic in discussion/rest. Zone policy
  // beats table policy: seated inside a silent zone stays muted.
  useEffect(() => {
    if (!self) return;
    const shouldPublish =
      !micDenied &&
      micMayPublish({
        zoneKind,
        seated: self.tableId != null,
        intendedMicOn: !userMuted,
        pttHeld,
      });
    void setMicEnabled(room, shouldPublish).then((res) => {
      if (res === "denied") {
        setMicDenied(true);
        setUserMuted(true);
      }
    });
  }, [room, self?.tableId, zoneKind, userMuted, pttHeld, micDenied]);

  // Camera publish gate. Mirrors mic: on only while seated and the user has
  // opted in. M1: camera never publishes in silent zones, even with opt-in.
  // Permission denial latches `camDenied` and forces userCamOff back to
  // true so we don't re-prompt every render.
  useEffect(() => {
    if (!self) return;
    const shouldPublish =
      self.tableId != null &&
      !userCamOff &&
      !camDenied &&
      zoneAllowsAudio(zoneKind);
    void setCameraEnabled(room, shouldPublish).then((res) => {
      if (res === "denied") {
        setCamDenied(true);
        setUserCamOff(true);
      }
    });
  }, [room, self?.tableId, userCamOff, camDenied, zoneKind]);

  // Screen share is allowed only in discussion zones (contract). Stop an
  // active share when leaving discussion. (Standing up stops it separately.)
  useEffect(() => {
    if (zoneKind !== "discussion" && sharingScreen) {
      void setScreenShareEnabled(room, false);
    }
  }, [room, zoneKind, sharingScreen]);

  // Same-table scoping for video subscriptions (unchanged by M1): we don't
  // pay bandwidth for cameras we'd never render anyway.
  useEffect(() => {
    if (!self) return;
    const myTable = self.tableId;
    const peers = useSyncle.getState().peers;
    for (const identity of room.remoteParticipants.keys()) {
      const peerTable = peers.get(identity)?.tableId ?? null;
      const sameTable = myTable != null && peerTable === myTable;
      setPeerVideoSubscribed(room, identity, sameTable);
    }
    // peerTableSig deliberately included so this re-runs when *any* peer
    // changes table, without subscribing to 20Hz position updates.
  }, [room, self?.tableId, peerTableSig]);

  // T3 spatial audio. Replaces the pre-M1 binary `audible = sameTable` gate:
  // in discussion/rest/none zones every peer is audible with linear distance
  // attenuation (ported from Android SpatialAudioEngine); in silent zones
  // peers are inaudible unless PTT is held. M5 DND (manualBusy) still mutes
  // all incoming audio. Runs on a 250ms cadence reading the store directly
  // (not the 20Hz position stream); an epsilon cache skips redundant
  // setVolume calls, mirroring Android's shouldApplyVolume.
  //
  // M2 T5 local block (contract §5) is enforced here too: a blocked peer's
  // audio is unsubscribed (saves bandwidth) and forced to volume 0
  // (belt-and-braces). The block list is read fresh every tick so
  // block/unblock takes effect within the 250ms cadence; unblocking
  // re-subscribes.
  useEffect(() => {
    const lastVolume = new Map<string, number>();
    const blockedUnsub = new Set<string>();
    const applyVolumes = () => {
      const st = useSyncle.getState();
      const me = st.self;
      if (!me) return;
      const myKind = zoneKindRef.current;
      const ptt = pttHeldRef.current;
      const alive = new Set<string>();
      for (const identity of room.remoteParticipants.keys()) {
        alive.add(identity);
        const blocked =
          roomName !== "" && isBlockedIdentity(roomName, identity);
        if (blocked && !blockedUnsub.has(identity)) {
          blockedUnsub.add(identity);
          setPeerAudioSubscribed(room, identity, false);
        } else if (!blocked && blockedUnsub.has(identity)) {
          blockedUnsub.delete(identity);
          setPeerAudioSubscribed(room, identity, true);
        }
        const peer = st.peers.get(identity);
        let volume: number;
        if (blocked) {
          volume = 0;
        } else if (me.manualBusy) {
          volume = 0;
        } else if (myKind === "silent" && !ptt) {
          volume = 0;
        } else if (!peer) {
          volume = 0;
        } else {
          volume = attenuationFor(Math.hypot(peer.x - me.x, peer.y - me.y));
        }
        if (shouldApplyVolume(lastVolume, identity, volume)) {
          setPeerVolume(room, identity, volume);
        }
      }
      // Prune departed peers so a rejoin starts with a cold cache.
      for (const id of lastVolume.keys()) {
        if (!alive.has(id)) lastVolume.delete(id);
      }
      for (const id of blockedUnsub) {
        if (!alive.has(id)) blockedUnsub.delete(id);
      }
    };
    applyVolumes();
    const id = window.setInterval(applyVolumes, 250);
    return () => window.clearInterval(id);
  }, [room, roomName]);

  // M5 theme: apply to the document root so CSS `[data-theme="dark"]`
  // overrides take effect. Persistence is handled by the store setter.
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  // M7 now-playing: publish the local user's string as a LiveKit attribute
  // whenever it changes. Empty string clears.
  useEffect(() => {
    void setNowPlayingAttribute(room, selfNowPlaying).catch((err) =>
      console.warn("setNowPlayingAttribute failed", err),
    );
  }, [room, selfNowPlaying]);

  // M2: the host removed us (kick_notice packet). Disconnect actively and
  // route back to JoinScreen, which renders the kick reason from the
  // store. `room.disconnect()` fires Disconnected with CLIENT_INITIATED —
  // a terminal reason — so this can never loop into the reconnect cycle.
  useEffect(() => {
    if (kicked) {
      void room.disconnect().finally(onLeave);
    }
  }, [room, kicked, onLeave]);

  if (!map || !self) return null;

  const seated = self.tableId != null;

  // MW1-3: touch contextual action (the F/E-key equivalent on touch).
  // Priority matches the keyboard branches: stand > board > note > sit.
  const touchAction: TouchAction | null = interactActionFor({
    nearbyNoteIndex,
    nearbyBoardIndex,
    nearbyTable,
    seated,
  });
  const handleTouchAction = (a: TouchAction) => {
    if (a === "sit" || a === "stand") toggleSit();
    else openNearbyInteract();
  };

  // MW1-3: touch push-to-talk. Writes the same pttHeldRef/setPttHeld the
  // Space key uses, so the existing release guards (chat open, blur) apply.
  const pttHoldStart = () => {
    pttHeldRef.current = true;
    setPttHeld(true);
  };
  const pttHoldEnd = () => {
    if (pttHeldRef.current) {
      pttHeldRef.current = false;
      setPttHeld(false);
    }
  };

  // MW1-1: tap-to-move gesture handlers, attached to the canvas wrapper.
  // Only active on coarse pointers; desktop mouse clicks are unaffected.
  const onCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isCoarsePointer) return;
    tapDownRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onCanvasPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const down = tapDownRef.current;
    tapDownRef.current = null;
    if (!down || !isCoarsePointer) return;
    if (performance.now() - down.t >= 300) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) >= 10) return;
    const canvas = e.currentTarget.querySelector("canvas");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const st = useSyncle.getState();
    const s = st.self;
    const m = st.map;
    if (!s || !m || s.tableId) return; // no tap-move while seated
    const vp = computeViewport(rect.width, rect.height, { x: s.x, y: s.y }, m);
    tapTargetRef.current = screenToWorld(
      e.clientX - rect.left,
      e.clientY - rect.top,
      vp,
    );
    stalledFramesRef.current = 0;
  };

  // MW1-4: DPR cap derived from the performance tier. `high` caps at 4,
  // effectively uncapped on real devices (desktop zero-regression).
  const dprCap = perfTier === "battery" ? 1.5 : perfTier === "balanced" ? 2 : 4;
  // Actual mic liveness under the M1 publish gate (a/b/c). In silent zones
  // this is true only while PTT is held.
  const micActive =
    !micDenied &&
    micMayPublish({
      zoneKind,
      seated,
      intendedMicOn: !userMuted,
      pttHeld,
    });
  const camActive = seated && !userCamOff && !camDenied;

  return (
    <div
      className={`syncle-screen${miniMode ? " mini" : ""}${perfTier === "battery" ? " perf-battery" : ""}`}
    >
      {!miniMode && (
        <>
          <div
            className="canvas-wrap"
            onPointerDown={onCanvasPointerDown}
            onPointerUp={onCanvasPointerUp}
          >
            <SpatialCanvas
              highlightTable={nearbyTable}
              highlightNoteIndex={nearbyNoteIndex}
              dprCap={dprCap}
            />
          </div>
          <MobileDrawer
            open={whosWhereOpen}
            onClose={() => setWhosWhereOpen(false)}
            side="right"
            title="Who's where"
          >
            <WhosWherePanel
              roomName={roomName}
              backendUrl={cache?.backendUrl ?? ""}
              getToken={() => cache?.session.token ?? ""}
            />
          </MobileDrawer>
        </>
      )}
      {miniMode && <MiniPanel onExit={() => setMiniMode(false)} />}
      <div className="hud">
        <div className="hud-row">
          <strong style={{ color: self.color }}>{self.nickname}</strong>
          <StatusPill
            status={self.status}
            manualBusy={self.manualBusy}
            onToggleBusy={() => setManualBusy(!self.manualBusy)}
          />
          {/* P1-B account chip (contracts.md "Identity & login"): account
              display name + role badge + logout. Anonymous users never see
              it — their flow is untouched. */}
          {account && (
            <span className="account-chip" title={account.email ?? undefined}>
              {account.avatarUrl && (
                <img
                  src={account.avatarUrl}
                  alt=""
                  className="account-avatar"
                  loading="lazy"
                  onError={(e) => e.currentTarget.remove()}
                />
              )}
              <span className="account-name">
                {account.displayName ?? account.email ?? "…"}
              </span>
              {self?.role === "admin" && (
                <span className="role-badge role-badge-admin">
                  {localizeText(AUTH_STRINGS.admin, uiLang)}
                </span>
              )}
              {self?.role === "host" && (
                <span className="role-badge role-badge-host">
                  {localizeText(AUTH_STRINGS.host, uiLang)}
                </span>
              )}
              <button
                type="button"
                className="account-logout"
                onClick={() => {
                  if (cache?.backendUrl) void logoutAuth(cache.backendUrl);
                }}
                title={localizeText(AUTH_STRINGS.signOut, uiLang)}
                aria-label={localizeText(AUTH_STRINGS.signOut, uiLang)}
              >
                {localizeText(AUTH_STRINGS.signOut, uiLang)}
              </button>
            </span>
          )}
          <button
            type="button"
            className="view-toggle"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-pressed={theme === "dark"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            type="button"
            className="view-toggle"
            onClick={() => setMiniMode(!miniMode)}
            title={miniMode ? "Exit mini mode" : "Enter mini mode"}
            aria-label={miniMode ? "Exit mini mode" : "Enter mini mode"}
            aria-pressed={miniMode}
          >
            {miniMode ? <ExpandIcon /> : <MinimizeIcon />}
          </button>
          <button
            type="button"
            className="view-toggle"
            onClick={() => setNowPlayingOpen((v) => !v)}
            title="Set 'now playing' status (visible to peers)"
            aria-label="Now playing"
            aria-pressed={nowPlayingOpen}
          >
            <MusicIcon />
          </button>
          <button
            type="button"
            className="view-toggle"
            onClick={() => setPerfOpen((v) => !v)}
            title="Performance settings"
            aria-label="Performance settings"
            aria-pressed={perfOpen}
          >
            <Settings size={14} aria-hidden="true" />
          </button>
          {isModerator && (
            <button
              type="button"
              className="view-toggle"
              onClick={() => setModerationOpen(true)}
              title="Moderation panel (host / admin)"
              aria-label="Moderation panel"
            >
              <Shield size={14} aria-hidden="true" />
            </button>
          )}
          {/* M3 T10: focus stats entry. */}
          <button
            type="button"
            className="view-toggle"
            onClick={() => setStatsOpen(true)}
            title="专注统计 (focus stats)"
            aria-label="专注统计"
            aria-pressed={statsOpen}
          >
            <Timer size={14} aria-hidden="true" />
          </button>
        </div>
        {perfOpen && (
          <div className="perf-panel" role="dialog" aria-label="Performance settings">
            <PerfSettings
              tier={perfTier}
              onChange={(t) => {
                setPerfTier(t);
                writePerfTier(localStorage, t);
              }}
            />
          </div>
        )}
        {nowPlayingOpen && (
          <div className="now-playing-row">
            <input
              type="text"
              className="now-playing-input"
              placeholder="Now playing… (e.g. Daft Punk — One More Time)"
              value={nowPlayingDraft}
              maxLength={64}
              onChange={(e) => setNowPlayingDraft(e.target.value)}
              onFocus={() => { typingRef.current = true; }}
              onBlur={() => {
                typingRef.current = false;
                setSelfNowPlaying(nowPlayingDraft.trim());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setSelfNowPlaying(nowPlayingDraft.trim());
                  setNowPlayingOpen(false);
                } else if (e.key === "Escape") {
                  setNowPlayingDraft(selfNowPlaying);
                  setNowPlayingOpen(false);
                }
                e.stopPropagation();
              }}
              aria-label="Now playing"
              autoFocus
            />
            {selfNowPlaying.length > 0 && (
              <button
                type="button"
                className="now-playing-clear"
                onClick={() => {
                  setNowPlayingDraft("");
                  setSelfNowPlaying("");
                }}
                title="Clear now playing"
                aria-label="Clear now playing"
              >Clear</button>
            )}
          </div>
        )}
        <div className="peers">Peers: {peerCount}</div>
        {/* MW1: key hints are desktop-only; touch uses TouchActionBar/PttButton. */}
        {!isCoarsePointer && (
          <>
            {seated ? (
              <div className="peers">
                Seated at <strong>{self.tableId}</strong> — press{" "}
                <span className="key">E</span> to leave
              </div>
            ) : nearbyTable ? (
              <div className="peers">
                Press <span className="key">E</span> to join{" "}
                <strong>{nearbyTable}</strong>
              </div>
            ) : (
              <div className="peers">
                Move: <span className="key">W</span><span className="key">A</span>
                <span className="key">S</span><span className="key">D</span> /
                arrow keys
              </div>
            )}
            {nearbyNoteIndex != null && (
              <div className="peers">
                Press <span className="key">F</span> to read note
              </div>
            )}
            {nearbyBoardIndex != null && (
              <div className="peers">
                Press <span className="key">F</span> to open board
              </div>
            )}
          </>
        )}
        {zoneKind === "silent" && (
          <div className="peers">
            Silent zone —{" "}
            {isCoarsePointer ? (
              <>hold the talk button to speak</>
            ) : (
              <>hold <span className="key">Space</span> to talk</>
            )}
          </div>
        )}
        {micDenied && (
          <div className="perm-banner" role="alert">
            <MicOff size={14} aria-hidden="true" />
            <span>Mic blocked or no input device.</span>{" "}
            <button
              type="button"
              className="perm-banner-action"
              onClick={() => {
                // Clear latch + unmute so the publish effect re-prompts.
                setMicDenied(false);
                setUserMuted(false);
              }}
            >
              Retry
            </button>
          </div>
        )}
        {/* MW1-3: touch contextual action (F/E equivalent) + hold-to-talk.
            Both render only on coarse pointers (internal mount gate). */}
        <TouchActionBar action={touchAction} onAction={handleTouchAction} />
        <PttButton
          visible={zoneKind === "silent"}
          onHoldStart={pttHoldStart}
          onHoldEnd={pttHoldEnd}
        />
        {/* M3 T11: sit ritual. One-tap focus entry while seated and the
            pomodoro is idle. Fixed-position card, touch-friendly buttons. */}
        {seated && pomodoroPhase === "idle" && <SitFocusPrompt />}
      </div>
      <button
        type="button"
        className={`mic-toggle${micActive ? " on" : " off"}`}
        onClick={() => {
          // Clicking the button when blocked acts as "retry": clear the
          // latch and un-mute so the next render re-attempts permission.
          if (micDenied) {
            setMicDenied(false);
            setUserMuted(false);
            if (zoneKindRef.current === "silent") intendedMicOnRef.current = true;
            return;
          }
          toggleUserMuted();
        }}
        title={
          micDenied
            ? "Mic blocked — click to retry"
            : zoneKind === "silent"
              ? pttHeld
                ? "Talking (push-to-talk) — release Space to mute"
                : "Muted — silent zone (hold Space to talk)"
              : userMuted
                ? "Unmute (M)"
                : "Mute (M)"
        }
        aria-pressed={!micActive}
      >
        {micActive ? <Mic size={14} aria-hidden="true" /> : <MicOff size={14} aria-hidden="true" />}
        <span>
          {micActive ? "Mic on" : micDenied ? "Mic blocked" : "Muted"}
        </span>
        <span className="key" style={{ marginLeft: 6 }}>M</span>
      </button>
      <button
        type="button"
        className={`cam-toggle${camActive ? " on" : " off"}`}
        onClick={() => {
          // Toggling off always clears the latched permission flag so the
          // next "on" click will re-prompt the browser.
          if (camDenied) setCamDenied(false);
          setUserCamOff((v) => !v);
        }}
        title={
          !seated
            ? "Sit at a table to enable camera"
            : zoneKind === "silent"
              ? "Camera unavailable in silent zones"
              : camDenied
                ? "Camera blocked — check browser permissions"
                : userCamOff
                  ? "Turn on camera"
                  : "Turn off camera"
        }
        disabled={!seated}
        aria-pressed={!camActive}
      >
        {camActive ? <Video size={14} aria-hidden="true" /> : <VideoOff size={14} aria-hidden="true" />}
        <span>{camActive ? "Cam on" : camDenied ? "Cam blocked" : "Cam off"}</span>
      </button>
      <button
        type="button"
        className={`screen-toggle${sharingScreen ? " on" : " off"}`}
        onClick={() => {
          void setScreenShareEnabled(room, !sharingScreen);
        }}
        title={
          !seated
            ? "Sit at a table to share your screen"
            : zoneKind !== "discussion"
              ? "Screen share is only available in discussion zones"
              : sharingScreen
                ? "Stop sharing your screen"
                : "Share your screen with the table"
        }
        disabled={!seated || zoneKind !== "discussion"}
        aria-pressed={sharingScreen}
      >
        {sharingScreen ? <MonitorOff size={14} aria-hidden="true" /> : <Monitor size={14} aria-hidden="true" />}
        <span>{sharingScreen ? "Stop share" : "Share screen"}</span>
      </button>
      <MobileDrawer
        open={videoOpen}
        onClose={() => setVideoOpen(false)}
        side="bottom"
        title="Video"
      >
        <VideoTiles room={room} />
      </MobileDrawer>
      <button
        type="button"
        className="meeting-toggle"
        onClick={() => setMeetingViewOpen(true)}
        disabled={!seated}
        title={
          seated
            ? "Open the fullscreen meeting view"
            : "Sit at a table to open the meeting view"
        }
      >
        <MeetingIcon />
        Meeting view
      </button>
      <button
        className="disconnect"
        onClick={() => {
          void room.disconnect().finally(onLeave);
        }}
      >
        Leave
      </button>
      <button
        type="button"
        className={`chat-toggle${chatOpen ? " open" : ""}`}
        onClick={() => setChatOpen((v) => !v)}
        aria-pressed={chatOpen}
        title={chatOpen ? "Close chat (Esc)" : "Open chat (T)"}
      >
        <MessageSquare size={14} aria-hidden="true" />
        <span>Chat</span>
        {unread > 0 && !chatOpen && (
          <span className="chat-badge">{unread > 99 ? "99+" : unread}</span>
        )}
        <span className="key" style={{ marginLeft: 6 }}>T</span>
      </button>
      <ReactionLauncher
        open={reactionPickerOpen}
        onToggle={() => setReactionPickerOpen((v) => !v)}
        onPick={(index) => {
          setReactionPickerOpen(false);
          pushReaction(LOCAL_CHAT_IDENTITY, REACTIONS[index].glyph);
          void publishReliable(room, encodeReaction(index)).catch((err) =>
            console.warn("publish reaction failed", err),
          );
        }}
      />
      <MobileDrawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        side="bottom"
        title="Chat"
      >
        <ChatPanel
          room={room}
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          onTypingChange={setTypingInChat}
          backendUrl={cache?.backendUrl ?? ""}
          roomName={cache?.room ?? ""}
          getToken={() => cache?.session.token ?? ""}
        />
      </MobileDrawer>
      {/* MW1-2: panel FABs (CSS shows these only on coarse pointers). */}
      <div className="fab-stack" aria-label="Panels">
        <button
          type="button"
          className="fab"
          onClick={() => setChatOpen((v) => !v)}
          aria-label="Chat"
        >
          💬
          {unread > 0 && !chatOpen && (
            <span className="fab-badge">{unread > 99 ? "99+" : unread}</span>
          )}
        </button>
        <button
          type="button"
          className="fab"
          onClick={() => setWhosWhereOpen((v) => !v)}
          aria-label="Who's where"
        >
          👥
        </button>
        {seated && (
          <button
            type="button"
            className="fab"
            onClick={() => setVideoOpen((v) => !v)}
            aria-label="Video"
          >
            📹
          </button>
        )}
      </div>
      {meetingViewOpen && (
        <MeetingView room={room} onLeave={() => setMeetingViewOpen(false)} />
      )}
      {readingNoteIndex != null && map.objects[readingNoteIndex]?.type === "note" && (
        <NoteModal
          title={map.objects[readingNoteIndex].label}
          text={map.objects[readingNoteIndex].text ?? ""}
          onClose={() => setReadingNoteIndex(null)}
        />
      )}
      {viewingBoardIndex != null && map.objects[viewingBoardIndex]?.type === "board" && (
        <BoardModal
          title={map.objects[viewingBoardIndex].label}
          repo={map.objects[viewingBoardIndex].repo}
          onClose={() => setViewingBoardIndex(null)}
        />
      )}
      {/* MW1-1: touch joystick (coarse pointers only; internal mount gate). */}
      {isCoarsePointer && (
        <TouchJoystick
          onVector={(v) => {
            touchVecRef.current = v;
          }}
        />
      )}
      {/* M2 moderation panel — host or P1-B admin (contract §2: the server
          applies the effective role; this gate only controls visibility). */}
      {moderationOpen && isModerator && (
        <ModerationPanel
          room={room}
          backendUrl={cache?.backendUrl ?? ""}
          roomName={roomName}
          getToken={() => cache?.session.token ?? ""}
          onClose={() => setModerationOpen(false)}
        />
      )}
      {/* M3 T10: focus stats. MobileDrawer turns it into a bottom sheet
          (swipe-to-dismiss, scrim, ESC) on coarse pointers; on desktop the
          drawer's CSS collapses to display:contents and the .focus-stats
          card is a centered modal via its own fixed positioning. */}
      {statsOpen && (
        <MobileDrawer
          open={statsOpen}
          onClose={() => setStatsOpen(false)}
          side="bottom"
          title="专注统计"
        >
          <FocusStatsPanel
            backendUrl={cache?.backendUrl ?? ""}
            userId={cache?.session?.userId ?? ""}
            getToken={() => cache?.session.token ?? ""}
            onClose={() => setStatsOpen(false)}
          />
        </MobileDrawer>
      )}
      <ReconnectOverlay onRetry={onRetryReconnect} />
      {/* M3 §6: in-app completion toast (always shown alongside the
          Notification API fire; the fallback for iOS/denied). */}
      {focusToast && (
        <div className="focus-toast" role="status" aria-live="polite">
          <div className="focus-toast-text">
            <div className="focus-toast-title">{focusToast.title}</div>
            <div className="focus-toast-body">{focusToast.body}</div>
          </div>
          <button
            type="button"
            className="focus-toast-close"
            onClick={() => setFocusToast(null)}
            aria-label="关闭通知"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function ReconnectOverlay({ onRetry }: { onRetry?: () => void }) {
  const reconnect = useSyncle((s) => s.reconnect);
  if (!reconnect) return null;
  return (
    <div className="reconnect-overlay" role="alert" aria-live="polite">
      <div className="reconnect-card">
        <div className="reconnect-spinner" />
        <div className="reconnect-title">Reconnecting…</div>
        <div className="reconnect-sub">
          Attempt {reconnect.attempt} of 10
          {reconnect.reason ? ` · ${reconnect.reason.toLowerCase()}` : ""}
        </div>
        {onRetry && (
          <button
            type="button"
            className="reconnect-action"
            onClick={onRetry}
          >
            Retry now
          </button>
        )}
      </div>
    </div>
  );
}

function NoteModal({
  title,
  text,
  onClose,
}: {
  title?: string;
  text: string;
  onClose: () => void;
}) {
  return (
    <div className="note-modal-backdrop" onClick={onClose}>
      <div
        className="note-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Sticky note"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="note-modal-header">
          <span className="note-modal-title">
            <StickyNote size={14} aria-hidden="true" />
            {title && title.length > 0 ? title : "Note"}
          </span>
          <button onClick={onClose} aria-label="Close note" className="icon-btn">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="note-modal-body">
          {text.length > 0 ? text : <em>(empty)</em>}
        </div>
        <div className="note-modal-footer">
          <span className="key">Esc</span> to close
        </div>
      </div>
    </div>
  );
}

function isMoveKey(k: string): boolean {
  const lk = k.toLowerCase();
  return (
    lk === "w" ||
    lk === "a" ||
    lk === "s" ||
    lk === "d" ||
    lk === "arrowup" ||
    lk === "arrowdown" ||
    lk === "arrowleft" ||
    lk === "arrowright"
  );
}

/** Presence status pill (top-right of HUD). Click toggles manual Busy/DND
 *  which overrides auto-derivation. Icon is an inline SVG dot — design
 *  system rule: no emoji as icons. */
function StatusPill({
  status,
  manualBusy,
  onToggleBusy,
}: {
  status: AvatarStatus;
  manualBusy: boolean;
  onToggleBusy: () => void;
}) {
  const meta = statusMeta(status);
  return (
    <button
      type="button"
      className="status-pill"
      onClick={onToggleBusy}
      aria-pressed={manualBusy}
      aria-label={`Status: ${meta.label}. Click to ${manualBusy ? "clear Do Not Disturb" : "set Do Not Disturb"}.`}
      title={manualBusy ? "Clear Do Not Disturb" : "Set Do Not Disturb"}
      style={{ background: meta.pillBackground }}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="5" cy="5" r="4" fill={meta.ringColor} />
      </svg>
      <span className="status-pill-label">{meta.label}</span>
    </button>
  );
}

/** Reaction picker. Closed by default; clicking the button opens a small
 *  popover with the catalog. Keyboard `R` sends the default (wave) without
 *  opening the picker. */
function ReactionLauncher({
  open,
  onToggle,
  onPick,
}: {
  open: boolean;
  onToggle: () => void;
  onPick: (index: number) => void;
}) {
  return (
    <div className="reaction-launcher">
      {open && (
        <div className="reaction-popover" role="menu">
          {REACTIONS.map((r, i) => (
            <button
              key={r.label}
              type="button"
              className="reaction-option"
              role="menuitem"
              onClick={() => onPick(i)}
              aria-label={r.label}
              title={r.label}
            >
              <span aria-hidden="true">{r.glyph}</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className={`reaction-toggle${open ? " open" : ""}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="menu"
        title="React (R for wave)"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M18 11V6a2 2 0 0 0-4 0v5" />
          <path d="M14 10V4a2 2 0 0 0-4 0v6" />
          <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
          <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-7.4-5L2 13" />
        </svg>
        React
        <span className="key" style={{ marginLeft: 6 }}>R</span>
      </button>
    </div>
  );
}

/** Small video-camera glyph for the meeting-view HUD button. Lucide-style
 *  outlined SVG (design system rule: no emoji-as-icon). */
function MeetingIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

/** Sun glyph for the dark→light theme toggle. Lucide-style. */
function SunIcon() {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

/** Moon glyph for the light→dark theme toggle. Lucide-style. */
function MoonIcon() {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/** Two-arrow inward "minimize" glyph used to enter mini mode. */
function MinimizeIcon() {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

/** Two-arrow outward "expand" glyph used to exit mini mode. */
function ExpandIcon() {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

/** Music note glyph used for the now-playing HUD toggle. Lucide-style. */
function MusicIcon() {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <path d="M9 17V5l12-2v12" />
      <circle cx="6" cy="17" r="3" />
      <circle cx="18" cy="15" r="3" />
    </svg>
  );
}
