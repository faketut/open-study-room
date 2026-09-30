import { create } from "zustand";
import type { MapConfig } from "../types/mapConfig";
import { CUSTOM_MAP_URL, hasCustomMap } from "../domain/mapAuthoring";
import type { ChatScope } from "../domain/chatPacket";
import type { AvatarStatus } from "../domain/avatarStatus";
import { DEFAULT_STATUS } from "../domain/avatarStatus";
import {
  readMiniMode,
  readTheme,
  writeMiniMode,
  writeTheme,
  type ThemeMode,
} from "../domain/viewPrefs";

export interface ChatMessage {
  /** Monotonic per-session id, used as React key. */
  id: number;
  /** Sender LiveKit identity, or "__self__" for the local user. */
  fromIdentity: string;
  /** Display name resolved at receive time. */
  fromName: string;
  /** Display color resolved at receive time (sender's avatar color). */
  fromColor: string;
  scope: ChatScope;
  /** Required for table-scoped messages. */
  tableId?: string;
  /** Required for zone-scoped messages (see domain/zones.ts). */
  zoneKey?: string;
  /** Required for channel-scoped messages. Server-issued id. */
  channelId?: string;
  /** Required for DM. Recipient LiveKit identity. */
  to?: string;
  text: string;
  /** Receive time (ms epoch); used for display + ordering. */
  ts: number;
  /** True when the text @-mentions the local user. Precomputed at
   *  append time so the UI doesn't re-scan every render. */
  mentionsMe?: boolean;
}

/** Server-side channel record (lean: id + name). */
export interface Channel {
  id: string;
  name: string;
}

/** Cap to avoid unbounded growth in long sessions. */
const CHAT_LOG_CAP = 200;

export const LOCAL_CHAT_IDENTITY = "__self__" as const;

export interface RemotePeer {
  identity: string;
  name?: string;
  /** Display color advertised via the `color` LiveKit attribute (Android
   *  contract). Falls back to a default when peer hasn't published one. */
  color?: string;
  x: number;
  y: number;
  lastSeq: bigint;
  lastUpdate: number;
  /** Currently seated at this table id, or null if walking. */
  tableId: string | null;
  /** Presence status published by the peer as the `status` LiveKit attribute.
   *  Defaults to `available` until the peer publishes its real value. */
  status: AvatarStatus;
  /** Optional `now_playing` LiveKit attribute. Empty string => clear. */
  nowPlaying?: string;
  /** Character sprite index in [1, CHARACTER_COUNT]. Published as the
   *  `character` LiveKit attribute (web-only). When missing, renderer falls
   *  back to a stable hash of the identity so old clients still get a sprite. */
  characterIndex?: number;
}

export interface LocalSelf {
  userId: string;
  nickname: string;
  color: string;
  x: number;
  y: number;
  /** Currently seated at this table id, or null if walking. */
  tableId: string | null;
  /** Currently broadcast presence status. Auto-derived in SyncleScreen from
   *  (seated, muted, idleMs, manualBusy) and pushed to the room as a LiveKit
   *  attribute so peers see it via the same replay path as table_id. */
  status: AvatarStatus;
  /** When true, status is locked to `busy` regardless of activity. Toggle
   *  from the HUD status pill menu. */
  manualBusy: boolean;
  /** Optional "now playing" string (M7). Empty/undefined => not set. */
  nowPlaying?: string;
  /** Character sprite index in [1, CHARACTER_COUNT], chosen on the join
   *  screen and persisted to localStorage under `syncle.charIndex`.
   *  Broadcast as the `character` LiveKit attribute. */
  characterIndex?: number;
}

export interface JoinDraft {
  nickname: string;
  color: string;
  room: string;
  mapUrl: string;
  /** 1..50 character picker selection. Persisted to localStorage
   *  `syncle.charIndex` so the next visit pre-selects it. */
  characterIndex: number;
}

export interface MapChoice {
  id: string;
  label: string;
  url: string;
  /** World-space spawn inside this map's walkable area. */
  spawn: { x: number; y: number };
}

// Authored maps the user can pick on the join screen. Add to this list to
// expose a new layout; each entry points at a JSON file under web/public/.
// Procedural maps live under /maps/, the legacy room1 lives at the root.
const STATIC_MAP_CHOICES: MapChoice[] = [
  {
    id: "procedural",
    label: "Office (Procedural)",
    url: "/maps/office-procedural.json",
    spawn: { x: 200, y: 330 },
  },
  {
    id: "lounge",
    label: "Lounge",
    url: "/maps/lounge.json",
    spawn: { x: 100, y: 250 },
  },
  {
    id: "room1",
    label: "Office Alpha (room1 bitmap)",
    url: "/map_config.json",
    spawn: { x: 150, y: 200 },
  },
];

const CUSTOM_MAP_CHOICE: MapChoice = {
  id: "custom",
  label: "Custom (your edits)",
  url: CUSTOM_MAP_URL,
  // Generic center-of-map spawn; works for any user-authored layout.
  spawn: { x: 100, y: 100 },
};

/** Returns the choice list, including the "Custom" entry when localStorage
 *  has a saved map. Call this each time the JoinScreen renders so saving in
 *  the editor and bouncing back picks up the new entry. */
export function getMapChoices(): MapChoice[] {
  return hasCustomMap()
    ? [...STATIC_MAP_CHOICES, CUSTOM_MAP_CHOICE]
    : STATIC_MAP_CHOICES;
}

export const MAP_CHOICES = STATIC_MAP_CHOICES;

export const DEFAULT_MAP = MAP_CHOICES[0];

export type ConnState = "idle" | "connecting" | "connected" | "error";

interface SyncleState {
  conn: ConnState;
  error: string | null;
  joinDraft: JoinDraft;
  map: MapConfig | null;
  self: LocalSelf | null;
  peers: Map<string, RemotePeer>;
  setJoinDraft: (patch: Partial<JoinDraft>) => void;
  setConn: (c: ConnState, err?: string | null) => void;
  setMap: (m: MapConfig) => void;
  setSelf: (s: LocalSelf) => void;
  setSelfPosition: (x: number, y: number) => void;
  setSelfTable: (tableId: string | null) => void;
  setSelfStatus: (status: AvatarStatus) => void;
  setManualBusy: (busy: boolean) => void;
  setSelfNowPlaying: (text: string) => void;
  setPeerNowPlaying: (identity: string, text: string) => void;
  upsertPeer: (p: RemotePeer) => void;
  updatePeerPosition: (identity: string, x: number, y: number, seq: bigint) => void;
  setPeerTable: (identity: string, tableId: string | null) => void;
  setPeerProfile: (
    identity: string,
    patch: { name?: string; color?: string; characterIndex?: number },
  ) => void;
  setPeerStatus: (identity: string, status: AvatarStatus) => void;
  removePeer: (identity: string) => void;
  /** Drop the entire peer map. Used during a reconnect so we don't show
   *  stale ghosts; remote participants re-announce themselves on rejoin. */
  clearPeers: () => void;
  /** LiveKit identities currently producing audio above the active-speaker
   *  threshold. Includes the local participant when they speak. Updated
   *  from `RoomEvent.ActiveSpeakersChanged` in SyncleScreen. */
  speakingIdentities: Set<string>;
  setSpeakingIdentities: (ids: Set<string>) => void;
  /** Non-null while a reconnect attempt is scheduled or in flight. Drives
   *  the SyncleScreen "Reconnecting…" overlay. */
  reconnect: { attempt: number; reason: string | null } | null;
  setReconnect: (r: { attempt: number; reason: string | null } | null) => void;
  chatMessages: ChatMessage[];
  appendChatMessage: (msg: Omit<ChatMessage, "id">) => void;
  /** Active floating reaction bubbles, keyed by sender identity. Each entry
   *  lives until `until` (ms epoch); SyncleScreen schedules cleanup. The
   *  local user's own bubble is keyed by LOCAL_CHAT_IDENTITY. */
  reactions: Map<string, { glyph: string; until: number }>;
  pushReaction: (identity: string, glyph: string, durationMs?: number) => void;
  clearExpiredReactions: (now?: number) => void;
  /** Channels for the current room, loaded from the server on join and
   *  refreshed after a successful create. Empty when offline / no room. */
  channels: Channel[];
  setChannels: (cs: Channel[]) => void;
  addChannel: (c: Channel) => void;
  /** Channel ids the local user has joined (subscribed to). Persisted in
   *  localStorage under `syncle.joinedChannels` keyed by room. */
  joinedChannelIds: Set<string>;
  setJoinedChannelIds: (ids: Set<string>) => void;
  joinChannel: (id: string) => void;
  leaveChannel: (id: string) => void;
  /** UI theme. Persisted in localStorage under `syncle.theme`. Applied to
   *  `document.documentElement.dataset.theme` by SyncleScreen so CSS can
   *  use `[data-theme="dark"]` overrides. */
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  /** Mini-mode HUD. When true the spatial canvas + chat are hidden and a
   *  compact floating panel is shown instead. Persisted under
   *  `syncle.miniMode`. */
  miniMode: boolean;
  setMiniMode: (on: boolean) => void;
  reset: () => void;
}

const DEFAULT_DRAFT: JoinDraft = {
  nickname: defaultNickname(),
  color: "#4F8EF7",
  room: "syncle-office",
  mapUrl: DEFAULT_MAP.url,
  characterIndex: defaultCharacterIndex(),
};

function defaultNickname(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `Syncle-${s}`;
}

/** Total number of character sprites in `web/public/sprites/chars/`. Kept
 *  in sync with spriteAtlas.ts CHAR_COUNT. */
export const CHARACTER_COUNT = 50;
const CHAR_INDEX_STORAGE_KEY = "syncle.charIndex";

/** Read the persisted picker selection, or pick a random sprite so first-
 *  time visitors don't all look identical. Touches localStorage directly
 *  (DEFAULT_DRAFT is evaluated before `safeStorage` is initialized; and
 *  CHARACTER_COUNT is in TDZ at module init, hence the magic 50). */
function defaultCharacterIndex(): number {
  const COUNT = 50;
  try {
    const raw =
      typeof localStorage === "undefined"
        ? null
        : localStorage.getItem(CHAR_INDEX_STORAGE_KEY);
    const n = raw == null ? NaN : Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= COUNT) return n;
  } catch {
    /* fall through to random */
  }
  return 1 + Math.floor(Math.random() * COUNT);
}

/** Persist the user's chosen character index. Safe in SSR/tests. */
export function persistCharacterIndex(n: number): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CHAR_INDEX_STORAGE_KEY, String(n));
    }
  } catch {
    /* ignore */
  }
}

/** Browser-or-test-safe wrapper around `localStorage`. SSR builds and Node
 *  test environments won't have it. */
const safeStorage = {
  getItem(k: string): string | null {
    try {
      return typeof localStorage === "undefined" ? null : localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem(k: string, v: string): void {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

export const useSyncle = create<SyncleState>((set) => ({
  conn: "idle",
  error: null,
  joinDraft: DEFAULT_DRAFT,
  map: null,
  self: null,
  peers: new Map(),
  speakingIdentities: new Set(),
  reconnect: null,
  chatMessages: [],
  reactions: new Map(),
  channels: [],
  joinedChannelIds: new Set(),
  theme: readTheme(safeStorage),
  miniMode: readMiniMode(safeStorage),
  setJoinDraft: (patch) =>
    set((s) => ({ joinDraft: { ...s.joinDraft, ...patch } })),
  setConn: (conn, err = null) => set({ conn, error: err }),
  setMap: (map) => set({ map }),
  setSelf: (self) => set({ self }),
  setSelfPosition: (x, y) =>
    set((s) => (s.self ? { self: { ...s.self, x, y } } : {})),
  setSelfTable: (tableId) =>
    set((s) => (s.self ? { self: { ...s.self, tableId } } : {})),
  setSelfStatus: (status) =>
    set((s) => {
      if (!s.self) return {};
      if (s.self.status === status) return {};
      return { self: { ...s.self, status } };
    }),
  setManualBusy: (manualBusy) =>
    set((s) => {
      if (!s.self) return {};
      if (s.self.manualBusy === manualBusy) return {};
      return { self: { ...s.self, manualBusy } };
    }),
  setSelfNowPlaying: (text) =>
    set((s) => {
      if (!s.self) return {};
      const next = text.length > 0 ? text : undefined;
      if (s.self.nowPlaying === next) return {};
      return { self: { ...s.self, nowPlaying: next } };
    }),
  setPeerNowPlaying: (identity, text) =>
    set((s) => {
      const existing = s.peers.get(identity);
      if (!existing) return {};
      const next = text.length > 0 ? text : undefined;
      if (existing.nowPlaying === next) return {};
      const map = new Map(s.peers);
      map.set(identity, { ...existing, nowPlaying: next });
      return { peers: map };
    }),
  upsertPeer: (p) => {
    set((s) => {
      const next = new Map(s.peers);
      const existing = next.get(p.identity);
      next.set(p.identity, existing ? { ...existing, ...p } : p);
      return { peers: next };
    });
  },
  updatePeerPosition: (identity, x, y, seq) => {
    set((s) => {
      const existing = s.peers.get(identity);
      // Drop out-of-order or duplicate packets (seq monotonic per sender).
      if (existing && seq <= existing.lastSeq) return {};
      const next = new Map(s.peers);
      next.set(identity, {
        identity,
        name: existing?.name,
        color: existing?.color,
        x,
        y,
        lastSeq: seq,
        lastUpdate: Date.now(),
        tableId: existing?.tableId ?? null,
        status: existing?.status ?? DEFAULT_STATUS,
      });
      return { peers: next };
    });
  },
  setPeerTable: (identity, tableId) =>
    set((s) => {
      const existing = s.peers.get(identity);
      if (!existing) return {};
      if (existing.tableId === tableId) return {};
      const next = new Map(s.peers);
      next.set(identity, { ...existing, tableId });
      return { peers: next };
    }),
  setPeerProfile: (identity, patch) =>
    set((s) => {
      const existing = s.peers.get(identity);
      if (!existing) return {};
      const merged = { ...existing, ...patch };
      if (
        existing.name === merged.name &&
        existing.color === merged.color &&
        existing.characterIndex === merged.characterIndex
      ) {
        return {};
      }
      const next = new Map(s.peers);
      next.set(identity, merged);
      return { peers: next };
    }),
  setPeerStatus: (identity, status) =>
    set((s) => {
      const existing = s.peers.get(identity);
      if (!existing || existing.status === status) return {};
      const next = new Map(s.peers);
      next.set(identity, { ...existing, status });
      return { peers: next };
    }),
  removePeer: (identity) =>
    set((s) => {
      const next = new Map(s.peers);
      next.delete(identity);
      return { peers: next };
    }),
  clearPeers: () => set({ peers: new Map() }),
  setSpeakingIdentities: (ids) =>
    set((s) => {
      // Cheap equality check so we don't re-render on identical sets.
      if (s.speakingIdentities.size === ids.size) {
        let same = true;
        for (const id of ids) {
          if (!s.speakingIdentities.has(id)) {
            same = false;
            break;
          }
        }
        if (same) return {};
      }
      return { speakingIdentities: ids };
    }),
  setReconnect: (reconnect) => set({ reconnect }),
  appendChatMessage: (msg) =>
    set((s) => {
      const id = (s.chatMessages.at(-1)?.id ?? 0) + 1;
      const next = s.chatMessages.concat({ ...msg, id });
      // Drop oldest when over cap.
      if (next.length > CHAT_LOG_CAP) next.splice(0, next.length - CHAT_LOG_CAP);
      return { chatMessages: next };
    }),
  pushReaction: (identity, glyph, durationMs = 2000) =>
    set((s) => {
      const next = new Map(s.reactions);
      next.set(identity, { glyph, until: Date.now() + durationMs });
      return { reactions: next };
    }),
  clearExpiredReactions: (now = Date.now()) =>
    set((s) => {
      let changed = false;
      const next = new Map(s.reactions);
      for (const [id, r] of next) {
        if (r.until <= now) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? { reactions: next } : {};
    }),
  setChannels: (channels) => set({ channels }),
  addChannel: (c) =>
    set((s) =>
      s.channels.some((x) => x.id === c.id)
        ? {}
        : { channels: s.channels.concat(c) },
    ),
  setJoinedChannelIds: (joinedChannelIds) => set({ joinedChannelIds }),
  joinChannel: (id) =>
    set((s) => {
      if (s.joinedChannelIds.has(id)) return {};
      const next = new Set(s.joinedChannelIds);
      next.add(id);
      return { joinedChannelIds: next };
    }),
  leaveChannel: (id) =>
    set((s) => {
      if (!s.joinedChannelIds.has(id)) return {};
      const next = new Set(s.joinedChannelIds);
      next.delete(id);
      return { joinedChannelIds: next };
    }),
  setTheme: (theme) => {
    writeTheme(safeStorage, theme);
    set({ theme });
  },
  setMiniMode: (miniMode) => {
    writeMiniMode(safeStorage, miniMode);
    set({ miniMode });
  },
  reset: () =>
    set({
      conn: "idle",
      error: null,
      self: null,
      peers: new Map(),
      speakingIdentities: new Set(),
      reconnect: null,
      chatMessages: [],
      reactions: new Map(),
      channels: [],
      joinedChannelIds: new Set(),
    }),
}));

// Contract values mirrored in docs/contracts.md.
export const ROOM_REGEX = /^[a-z0-9-]{3,64}$/;
export const NICKNAME_MAX_LEN = 32;
export const PALETTE = [
  "#4F8EF7",
  "#F7766D",
  "#34C759",
  "#FFCC00",
  "#AF52DE",
  "#FF9500",
  "#5AC8FA",
  "#FF2D55",
];

export function isValidRoom(s: string): boolean {
  return ROOM_REGEX.test(s);
}

export function isValidNickname(s: string): boolean {
  const t = s.trim();
  return t.length >= 1 && t.length <= NICKNAME_MAX_LEN;
}

export const AVATAR_RADIUS = 20;
export const SPAWN = { x: 150, y: 200 };
export const POSITION_BROADCAST_HZ = 20;
export const MOVE_SPEED_PER_SEC = 220; // map-space units per second
