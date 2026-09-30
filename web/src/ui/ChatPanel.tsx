import { useEffect, useMemo, useRef, useState } from "react";
import type { Room } from "livekit-client";
import {
  useSyncle,
  LOCAL_CHAT_IDENTITY,
  type ChatMessage,
  type RemotePeer,
} from "../state/syncleStore";
import {
  encodeChat,
  sanitizeChatText,
  CHAT_TEXT_MAX_LEN,
  dmConversationKey,
  type ChatScope,
} from "../domain/chatPacket";
import { publishReliable } from "../data/liveKitService";
import { findZoneAt, zonesOf } from "../domain/zones";
import { createChannel } from "../data/sessionApi";
import {
  ChatSendThrottler,
  CHAT_QUEUE_MAX,
  CHAT_SEND_MIN_INTERVAL_MS,
} from "../domain/chatThrottle";
import {
  maskProfanity,
  SENSITIVE_WORDS,
} from "../domain/profanityFilter";

/** Top-level chat tab. */
export type ChatTab = "global" | "zone" | "channels" | "dms";

export interface ChatPanelProps {
  room: Room;
  open: boolean;
  onClose: () => void;
  /** Notifies the parent when the input gains/loses focus so it can suppress
   *  game keybinds (WASD / M) while the user is typing. */
  onTypingChange?: (typing: boolean) => void;
  /** Backend base URL — needed to create channels. */
  backendUrl: string;
  /** Room name (used in channel REST paths). */
  roomName: string;
  /** Returns the latest session JWT. ConnectionController rotates it on
   *  refresh, so we read it lazily inside handlers. */
  getToken: () => string;
}

export function ChatPanel({
  room,
  open,
  onClose,
  onTypingChange,
  backendUrl,
  roomName,
  getToken,
}: ChatPanelProps) {
  const messages = useSyncle((s) => s.chatMessages);
  const self = useSyncle((s) => s.self);
  const map = useSyncle((s) => s.map);
  const peers = useSyncle((s) => s.peers);
  const channels = useSyncle((s) => s.channels);
  const joinedChannelIds = useSyncle((s) => s.joinedChannelIds);
  const appendChatMessage = useSyncle((s) => s.appendChatMessage);
  const addChannel = useSyncle((s) => s.addChannel);
  const joinChannel = useSyncle((s) => s.joinChannel);
  const setJoinedChannelIds = useSyncle((s) => s.setJoinedChannelIds);

  const [tab, setTab] = useState<ChatTab>("global");
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const [channelId, setChannelId] = useState<string | null>(null);
  const [dmTarget, setDmTarget] = useState<string | null>(null);
  const [channelDraft, setChannelDraft] = useState("");
  const [channelError, setChannelError] = useState<string | null>(null);
  // M2 §4: client-side send throttle (1 msg / 2s, FIFO depth 3, overflow
  // dropped). Best-effort — the server never sees chat bytes, so the
  // moderation loop is the backstop for hostile clients.
  const throttlerRef = useRef<ChatSendThrottler | null>(null);
  if (!throttlerRef.current) {
    throttlerRef.current = new ChatSendThrottler();
  }
  const [throttleNotice, setThrottleNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!throttleNotice) return;
    const id = window.setTimeout(() => setThrottleNotice(null), 4000);
    return () => window.clearTimeout(id);
  }, [throttleNotice]);

  const myZone = self && map ? findZoneAt(self.x, self.y, map) : null;
  const zoneAvailable = !!myZone;

  // Persist channel subscriptions per-room.
  useEffect(() => {
    if (!roomName) return;
    try {
      localStorage.setItem(
        `syncle.joinedChannels:${roomName}`,
        JSON.stringify(Array.from(joinedChannelIds)),
      );
    } catch {
      /* ignore */
    }
  }, [roomName, joinedChannelIds]);

  // Keep channel/DM selectors valid when their backing lists change.
  const joinedChannels = useMemo(
    () => channels.filter((c) => joinedChannelIds.has(c.id)),
    [channels, joinedChannelIds],
  );
  useEffect(() => {
    if (channelId && !joinedChannels.some((c) => c.id === channelId)) {
      setChannelId(joinedChannels[0]?.id ?? null);
    } else if (!channelId && joinedChannels.length > 0) {
      setChannelId(joinedChannels[0].id);
    }
  }, [joinedChannels, channelId]);

  const dmPartners = useMemo(
    () => collectDmPartners(messages, peers, self?.userId ?? ""),
    [messages, peers, self?.userId],
  );
  useEffect(() => {
    if (dmTarget && !dmPartners.some((p) => p.identity === dmTarget)) {
      setDmTarget(dmPartners[0]?.identity ?? null);
    } else if (!dmTarget && dmPartners.length > 0) {
      setDmTarget(dmPartners[0].identity);
    }
  }, [dmPartners, dmTarget]);

  // Auto-fall-back to Global if the active tab's prerequisites disappear.
  useEffect(() => {
    if (tab === "zone" && !zoneAvailable) setTab("global");
  }, [tab, zoneAvailable]);

  // Auto-focus when opened.
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Auto-scroll log to the bottom on new messages.
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, open, tab, channelId, dmTarget]);

  const filtered = useMemo(
    () =>
      filterByTab({
        messages,
        tab,
        myZoneKey: myZone?.key ?? null,
        myIdentity: self?.userId ?? "",
        channelId,
        dmTarget,
      }),
    [messages, tab, myZone?.key, self?.userId, channelId, dmTarget],
  );

  const sendDisabled =
    sanitizeChatText(draft).length === 0 ||
    (tab === "zone" && !zoneAvailable) ||
    (tab === "channels" && !channelId) ||
    (tab === "dms" && !dmTarget);

  async function handleSend() {
    const raw = sanitizeChatText(draft);
    if (!raw || !self) return;
    // M2 §4: mask sensitive words pre-send with the same rule the server
    // enforces on nicknames. The word list is a build-time copy of
    // `server/src/moderation/words.ts`.
    const text = maskProfanity(raw, SENSITIVE_WORDS);

    const ts = Date.now();
    let scope: ChatScope;
    let zoneKey: string | undefined;
    let cId: string | undefined;
    let to: string | undefined;
    if (tab === "global") {
      scope = "global";
    } else if (tab === "zone") {
      if (!myZone) return;
      scope = "zone";
      zoneKey = myZone.key;
    } else if (tab === "channels") {
      if (!channelId) return;
      scope = "channel";
      cId = channelId;
    } else {
      if (!dmTarget) return;
      scope = "dm";
      to = dmTarget;
    }

    // The whole send (network publish + optimistic echo) is one throttled
    // unit so ordering stays trivially correct.
    const doSend = () => {
      void publishReliable(
        room,
        encodeChat({ scope, zoneKey, channelId: cId, to, text, ts }),
      ).catch((err) => console.warn("chat publish failed", err));
      appendChatMessage({
        fromIdentity: LOCAL_CHAT_IDENTITY,
        fromName: self.nickname,
        fromColor: self.color,
        scope,
        zoneKey,
        channelId: cId,
        to,
        text,
        ts,
        mentionsMe: false,
      });
    };
    const throttler = throttlerRef.current;
    const result = throttler ? throttler.attempt(doSend) : "sent";
    if (result === "sent") {
      setThrottleNotice(null);
    } else if (result === "queued") {
      setThrottleNotice(
        `Sending too fast, queued (${throttler?.pendingCount ?? 0}/${CHAT_QUEUE_MAX}, one every ${CHAT_SEND_MIN_INTERVAL_MS / 1000}s)`,
      );
    } else {
      setThrottleNotice("Sending too fast, message dropped. Try again later.");
    }
    setDraft("");
  }

  async function handleCreateChannel() {
    const name = channelDraft.trim().toLowerCase();
    setChannelError(null);
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
      setChannelError("Use a-z, 0-9, _, - (1–32 chars)");
      return;
    }
    try {
      const created = await createChannel(backendUrl, roomName, getToken(), name);
      addChannel(created);
      joinChannel(created.id);
      setChannelId(created.id);
      setChannelDraft("");
    } catch (err) {
      setChannelError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Stop game keybinds from firing while typing.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSend();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  if (!open) return null;

  const channelName = channelId ? channels.find((c) => c.id === channelId)?.name : undefined;
  const partner = dmTarget ? peers.get(dmTarget) : undefined;

  return (
    <div className="chat-panel" role="dialog" aria-label="Chat">
      <div className="chat-header">
        <div className="chat-tabs" role="tablist">
          <TabButton tab="global" active={tab} onSelect={setTab} label="Global" />
          <TabButton
            tab="zone"
            active={tab}
            onSelect={setTab}
            label={myZone ? `Zone · ${myZone.label}` : "Zone"}
            disabled={!zoneAvailable}
            disabledTitle={
              map && zonesOf(map).length === 0
                ? "This map has no zones"
                : "Walk into a zone to chat"
            }
          />
          <TabButton tab="channels" active={tab} onSelect={setTab} label="Channels" />
          <TabButton tab="dms" active={tab} onSelect={setTab} label="DMs" />
        </div>
        <button className="chat-close" onClick={onClose} aria-label="Close chat">
          <CloseIcon />
        </button>
      </div>

      {tab === "channels" && (
        <ChannelSelector
          channels={channels}
          joinedIds={joinedChannelIds}
          channelId={channelId}
          onSelect={setChannelId}
          onJoin={(id) => {
            joinChannel(id);
            setChannelId(id);
          }}
          onLeave={(id) => {
            const next = new Set(joinedChannelIds);
            next.delete(id);
            setJoinedChannelIds(next);
            if (channelId === id) setChannelId(null);
          }}
          draft={channelDraft}
          onDraftChange={setChannelDraft}
          onCreate={handleCreateChannel}
          error={channelError}
        />
      )}

      {tab === "dms" && (
        <DmSelector
          peers={peers}
          partners={dmPartners}
          target={dmTarget}
          onSelect={setDmTarget}
          myIdentity={self?.userId ?? ""}
        />
      )}

      <div ref={logRef} className="chat-log">
        {filtered.length === 0 ? (
          <div className="chat-empty">
            {emptyHint(tab, zoneAvailable, channelId, dmTarget)}
          </div>
        ) : (
          filtered.map((m) => <ChatLine key={m.id} msg={m} />)
        )}
      </div>

      <div className="chat-input-row">
        <input
          ref={inputRef}
          className="chat-input"
          value={draft}
          maxLength={CHAT_TEXT_MAX_LEN}
          placeholder={placeholderFor(tab, myZone?.label, channelName, partner?.name)}
          aria-label={`Message ${tab === "dms" ? (partner?.name ?? "direct message") : tab === "channels" ? `#${channelName ?? "channel"}` : tab === "zone" ? (myZone?.label ?? "zone") : "global"}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => onTypingChange?.(true)}
          onBlur={() => onTypingChange?.(false)}
          disabled={
            (tab === "zone" && !zoneAvailable) ||
            (tab === "channels" && !channelId) ||
            (tab === "dms" && !dmTarget)
          }
        />
        <button
          className="chat-send"
          onClick={() => void handleSend()}
          disabled={sendDisabled}
        >
          Send
        </button>
      </div>
      {throttleNotice && (
        <div className="chat-throttle-notice" role="status">
          {throttleNotice}
        </div>
      )}
    </div>
  );
}

function TabButton({
  tab,
  active,
  onSelect,
  label,
  disabled,
  disabledTitle,
}: {
  tab: ChatTab;
  active: ChatTab;
  onSelect: (t: ChatTab) => void;
  label: string;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  return (
    <button
      role="tab"
      aria-selected={active === tab}
      className={`chat-tab${active === tab ? " active" : ""}`}
      onClick={() => !disabled && onSelect(tab)}
      disabled={disabled}
      title={disabled ? disabledTitle : undefined}
    >
      {label}
    </button>
  );
}

function ChatLine({ msg }: { msg: ChatMessage }) {
  const isMine = msg.fromIdentity === LOCAL_CHAT_IDENTITY;
  return (
    <div
      className={`chat-msg${isMine ? " mine" : ""}${msg.mentionsMe ? " mention" : ""}`}
    >
      <span className="chat-msg-name" style={{ color: msg.fromColor }}>
        {msg.fromName}
      </span>
      {msg.scope === "table" && (
        <span className="chat-msg-badge">@{msg.tableId}</span>
      )}
      {msg.scope === "zone" && (
        <span className="chat-msg-badge">zone:{msg.zoneKey}</span>
      )}
      {msg.scope === "channel" && (
        <span className="chat-msg-badge">#chan</span>
      )}
      {msg.scope === "dm" && (
        <span className="chat-msg-badge">{isMine ? "→ DM" : "to me"}</span>
      )}
      <span className="chat-msg-text">{msg.text}</span>
    </div>
  );
}

interface ChannelSelectorProps {
  channels: { id: string; name: string }[];
  joinedIds: Set<string>;
  channelId: string | null;
  onSelect: (id: string) => void;
  onJoin: (id: string) => void;
  onLeave: (id: string) => void;
  draft: string;
  onDraftChange: (v: string) => void;
  onCreate: () => void;
  error: string | null;
}

function ChannelSelector(props: ChannelSelectorProps) {
  const { channels, joinedIds, channelId, onSelect, onJoin, onLeave, draft, onDraftChange, onCreate, error } = props;
  const joined = channels.filter((c) => joinedIds.has(c.id));
  const browse = channels.filter((c) => !joinedIds.has(c.id));
  return (
    <div className="chat-subnav">
      <select
        className="chat-picker"
        value={channelId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        disabled={joined.length === 0}
        aria-label="Active channel"
      >
        {joined.length === 0 ? (
          <option value="">No joined channels</option>
        ) : (
          joined.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))
        )}
      </select>
      {channelId && (
        <button
          type="button"
          className="chat-subnav-action"
          onClick={() => onLeave(channelId)}
          title="Leave this channel"
        >
          Leave
        </button>
      )}
      <details className="chat-subnav-more">
        <summary>More</summary>
        <div className="chat-subnav-list">
          {browse.length === 0 && (
            <div className="chat-empty" style={{ padding: "4px 0" }}>
              No other channels in this room.
            </div>
          )}
          {browse.map((c) => (
            <div key={c.id} className="chat-subnav-row">
              <span>#{c.name}</span>
              <button type="button" onClick={() => onJoin(c.id)}>
                Join
              </button>
            </div>
          ))}
          <div className="chat-subnav-create">
            <input
              type="text"
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              placeholder="new-channel-name"
              maxLength={32}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={onCreate}
              disabled={draft.trim().length === 0}
            >
              Create
            </button>
          </div>
          {error && (
            <div className="error" style={{ fontSize: 12 }}>
              {error}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

interface DmSelectorProps {
  peers: Map<string, RemotePeer>;
  partners: { identity: string; name: string; color: string }[];
  target: string | null;
  onSelect: (id: string) => void;
  myIdentity: string;
}

function DmSelector({ peers, partners, target, onSelect, myIdentity }: DmSelectorProps) {
  const partnerIds = new Set(partners.map((p) => p.identity));
  const composeOptions: { identity: string; name: string; color: string }[] = [];
  for (const [id, p] of peers) {
    if (id === myIdentity) continue;
    if (partnerIds.has(id)) continue;
    composeOptions.push({
      identity: id,
      name: p.name ?? id,
      color: p.color ?? "#5AC8FA",
    });
  }
  const empty = partners.length === 0 && composeOptions.length === 0;
  return (
    <div className="chat-subnav">
      <select
        className="chat-picker"
        value={target ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        disabled={empty}
        aria-label="Direct message partner"
      >
        {empty ? (
          <option value="">No peers online</option>
        ) : (
          <>
            {partners.length > 0 && (
              <optgroup label="Conversations">
                {partners.map((p) => (
                  <option key={p.identity} value={p.identity}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
            {composeOptions.length > 0 && (
              <optgroup label="Start a new DM">
                {composeOptions.map((p) => (
                  <option key={p.identity} value={p.identity}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </>
        )}
      </select>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path
        d="M2 2 L12 12 M12 2 L2 12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function emptyHint(
  tab: ChatTab,
  zoneAvailable: boolean,
  channelId: string | null,
  dmTarget: string | null,
): string {
  if (tab === "zone") {
    return zoneAvailable
      ? "No zone chatter yet."
      : "Walk into a zone to chat with people there.";
  }
  if (tab === "channels") {
    return channelId ? "No messages in this channel yet." : "Join a channel to start chatting.";
  }
  if (tab === "dms") {
    return dmTarget ? "No DMs with this peer yet." : "Pick a peer to start a DM.";
  }
  return "No messages yet. Say hi.";
}

function placeholderFor(
  tab: ChatTab,
  zoneLabel: string | undefined,
  channelName: string | undefined,
  partnerName: string | undefined,
): string {
  if (tab === "zone") return `Message zone${zoneLabel ? ` (${zoneLabel})` : ""}`;
  if (tab === "channels") return channelName ? `Message #${channelName}` : "Join a channel";
  if (tab === "dms") return partnerName ? `Message ${partnerName}` : "Pick a peer";
  return "Message everyone";
}

/** Walk message log and return distinct DM conversation partners (the
 *  "other side" of each DM the local user is part of), most-recent first.
 *  Exported for tests. */
export function collectDmPartners(
  messages: ChatMessage[],
  peers: Map<string, RemotePeer>,
  myIdentity: string,
): { identity: string; name: string; color: string }[] {
  const seen = new Map<string, { identity: string; name: string; color: string; ts: number }>();
  for (const m of messages) {
    if (m.scope !== "dm") continue;
    let partner: string | null = null;
    if (m.fromIdentity === LOCAL_CHAT_IDENTITY && m.to) partner = m.to;
    else if (m.to === myIdentity) partner = m.fromIdentity;
    else if (m.fromIdentity !== LOCAL_CHAT_IDENTITY && m.fromIdentity !== myIdentity) {
      partner = m.fromIdentity;
    }
    if (!partner) continue;
    const prev = seen.get(partner);
    if (!prev || prev.ts < m.ts) {
      const peer = peers.get(partner);
      seen.set(partner, {
        identity: partner,
        name: peer?.name ?? partner,
        color: peer?.color ?? "#5AC8FA",
        ts: m.ts,
      });
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.ts - a.ts);
}

interface FilterArgs {
  messages: ChatMessage[];
  tab: ChatTab;
  myZoneKey: string | null;
  myIdentity: string;
  channelId: string | null;
  dmTarget: string | null;
}

/** Pure — exported for tests. */
export function filterByTab(args: FilterArgs): ChatMessage[] {
  const { messages, tab, myZoneKey, channelId, dmTarget, myIdentity } = args;
  if (tab === "global") return messages.filter((m) => m.scope === "global");
  if (tab === "zone") {
    if (!myZoneKey) return [];
    return messages.filter((m) => m.scope === "zone" && m.zoneKey === myZoneKey);
  }
  if (tab === "channels") {
    if (!channelId) return [];
    return messages.filter((m) => m.scope === "channel" && m.channelId === channelId);
  }
  if (!dmTarget) return [];
  return messages.filter((m) => {
    if (m.scope !== "dm") return false;
    const conv = dmConversationKey(
      m.fromIdentity === LOCAL_CHAT_IDENTITY ? myIdentity : m.fromIdentity,
      m.to ?? "",
    );
    const want = dmConversationKey(myIdentity, dmTarget);
    return conv === want;
  });
}

/** Legacy export kept so the existing chatPacket-era tests keep compiling. */
export function filterByScope(
  messages: ChatMessage[],
  scope: ChatScope,
  myTableId: string | null | undefined,
): ChatMessage[] {
  if (scope === "global") return messages.filter((m) => m.scope === "global");
  if (scope === "table") {
    if (!myTableId) return [];
    return messages.filter((m) => m.scope === "table" && m.tableId === myTableId);
  }
  return [];
}

/** Per-tab unread count derived from last-seen ids. Counts only inbound
 *  (non-self) messages. Pure for tests. */
export function unreadByTab(
  messages: ChatMessage[],
  lastSeenIds: Record<ChatTab, number>,
  args: Omit<FilterArgs, "messages" | "tab">,
): Record<ChatTab, number> {
  const out: Record<ChatTab, number> = { global: 0, zone: 0, channels: 0, dms: 0 };
  for (const tab of ["global", "zone", "channels", "dms"] as ChatTab[]) {
    const visible = filterByTab({ messages, tab, ...args });
    const seen = lastSeenIds[tab];
    for (const m of visible) {
      if (m.id > seen && m.fromIdentity !== LOCAL_CHAT_IDENTITY) out[tab]++;
    }
  }
  return out;
}
