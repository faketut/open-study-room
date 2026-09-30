import { useMemo, useState } from "react";
import {
  getMapChoices,
  isValidNickname,
  isValidRoom,
  useSyncle,
  CHARACTER_COUNT,
  persistCharacterIndex,
} from "../state/syncleStore";
import { createSession, getOrCreateDeviceId, listChannels } from "../data/sessionApi";
import { loadMapConfig } from "../domain/mapConfig";
import {
  connectLiveKit,
  publishProfileAttributes,
  setRoleAttribute,
  type PeerEvents,
} from "../data/liveKitService";
import type { ConnectCache } from "../data/connectionController";
import { decodePosition, resetSeq } from "../domain/positionPacket";
import {
  decodeChat,
  mentionsNickname,
  PACKET_TYPE_CHAT,
} from "../domain/chatPacket";
import {
  decodeReaction,
  PACKET_TYPE_REACTION,
  REACTIONS,
} from "../domain/reactionPacket";
import { isAvatarStatus } from "../domain/avatarStatus";
import { findZoneAt } from "../domain/zones";
import { isBlockedIdentity } from "../domain/blockList";
import { decodeKickNotice, moderationErrorCode, moderationErrorMessage } from "../domain/moderation";
import {
  containsProfanity,
  SENSITIVE_WORDS,
} from "../domain/profanityFilter";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8787";

export interface JoinScreenProps {
  onConnected: (
    room: import("livekit-client").Room,
    cache: ConnectCache,
  ) => void;
  onOpenEditor: () => void;
}

export function JoinScreen({ onConnected, onOpenEditor }: JoinScreenProps) {
  const { joinDraft, setJoinDraft, conn, error, setConn, setMap, setSelf, upsertPeer, updatePeerPosition, removePeer, setPeerTable, setPeerProfile, setPeerStatus, setPeerRole, setPeerNowPlaying, pushReaction, appendChatMessage, clearPeers, setChannels, setJoinedChannelIds } = useSyncle();
  const kicked = useSyncle((s) => s.kicked);
  const setKicked = useSyncle((s) => s.setKicked);
  const [localError, setLocalError] = useState<string | null>(null);
  // Computed at mount time; the user only comes back here after editing, so
  // a freshly-mounted JoinScreen picks up "Custom (your edits)" if saved.
  const mapChoices = useMemo(() => getMapChoices(), []);

  const nicknameOk = isValidNickname(joinDraft.nickname);
  const roomOk = isValidRoom(joinDraft.room);
  const canSubmit = nicknameOk && roomOk && conn !== "connecting";
  // M2: local pre-validation of the nickname with the same rule the server
  // enforces. Instant hint only — the server is the final arbiter.
  const nicknameHasSensitiveWord = containsProfanity(
    joinDraft.nickname,
    SENSITIVE_WORDS,
  );

  async function handleJoin() {
    setLocalError(null);
    setKicked(null);
    setConn("connecting");
    try {
      const choice =
        mapChoices.find((c) => c.url === joinDraft.mapUrl) ?? mapChoices[0];
      const map = await loadMapConfig(choice.url);
      setMap(map);

      const deviceId = getOrCreateDeviceId();
      const session = await createSession(BACKEND_URL, {
        deviceId,
        nickname: joinDraft.nickname.trim(),
        color: joinDraft.color,
        room: joinDraft.room,
      });
      // M2: the sessions response carries our moderation role (first
      // joiner = host). Display-only locally; the server DB decides.
      const myRole = session.role === "host" ? "host" : "user";

      setSelf({
        userId: session.userId,
        nickname: session.nickname,
        color: session.color,
        x: choice.spawn.x,
        y: choice.spawn.y,
        tableId: null,
        status: "available",
        manualBusy: false,
        characterIndex: joinDraft.characterIndex,
        role: myRole,
      });

      resetSeq();
      // Build the handler bundle once; the reconnect controller re-uses
      // this same object on every retry so we don't lose data callbacks.
      const spawn = choice.spawn;
      const roomName = joinDraft.room;
      const events: PeerEvents = {
        onPeerJoined: (identity, name) =>
          upsertPeer({
            identity,
            name,
            x: spawn.x,
            y: spawn.y,
            lastSeq: -1n,
            lastUpdate: 0,
            tableId: null,
            status: "available",
          }),
        onPeerLeft: (identity) => removePeer(identity),
        onData: (identity, payload) => {
          // M2: kick notice (contract §3b). Reliable JSON `{"type":
          // "kick_notice","reason":"..."}` — starts with `{`, never one of
          // the binary type tags. Recorded in the store; SyncleScreen
          // disconnects and App routes back to the join screen.
          if (payload.length > 0 && payload[0] === 0x7b) {
            const reason = decodeKickNotice(payload);
            if (reason != null) {
              setKicked({ reason });
              return;
            }
          }
          // Dispatch by type tag (byte 0). Position=1, chat=2, reaction=3.
          if (payload.length > 0 && payload[0] === PACKET_TYPE_CHAT) {
            const chat = decodeChat(payload);
            if (!chat) return;
            // M2 T5 local block: drop chat from blocked senders (all
            // scopes, including dm) before it reaches the chat store.
            if (isBlockedIdentity(roomName, identity)) return;
            // Receiver-side scope enforcement. Each branch decides whether
            // *this* client should display the message.
            const state = useSyncle.getState();
            const self = state.self;
            if (chat.scope === "table" && chat.tableId !== self?.tableId) {
              return;
            }
            if (chat.scope === "dm" && chat.to !== self?.userId) {
              // DMs include the sender's own echo via local optimistic
              // append in ChatPanel, so we only deliver inbound here when
              // we're the recipient.
              return;
            }
            if (chat.scope === "zone") {
              const map = state.map;
              if (!map || !self) return;
              const myZone = findZoneAt(self.x, self.y, map);
              if (!myZone || myZone.key !== chat.zoneKey) return;
            }
            if (chat.scope === "channel") {
              if (!chat.channelId || !state.joinedChannelIds.has(chat.channelId)) {
                return;
              }
            }
            const peer = state.peers.get(identity);
            appendChatMessage({
              fromIdentity: identity,
              fromName: peer?.name ?? identity,
              fromColor: peer?.color ?? "#5AC8FA",
              scope: chat.scope,
              tableId: chat.tableId,
              zoneKey: chat.zoneKey,
              channelId: chat.channelId,
              to: chat.to,
              text: chat.text,
              ts: Date.now(),
              mentionsMe: mentionsNickname(
                chat.text,
                self?.nickname ?? "",
              ),
            });
            return;
          }
          if (payload.length > 0 && payload[0] === PACKET_TYPE_REACTION) {
            const r = decodeReaction(payload);
            if (!r) return;
            // M2 T5 local block: reactions ride the chat packet — dropped at
            // the same filter point as chat.
            if (isBlockedIdentity(roomName, identity)) return;
            pushReaction(identity, REACTIONS[r.index].glyph);
            return;
          }
          const pkt = decodePosition(payload);
          if (!pkt) return;
          updatePeerPosition(identity, pkt.x, pkt.y, pkt.seq);
        },
        onAttributes: (identity, attrs) => {
          // table_id is the table-meeting key (same as Android).
          const t = attrs.table_id ?? "";
          setPeerTable(identity, t.length > 0 ? t : null);
          // Optional profile attrs published by Android peers (and now web).
          // Empty strings mean "not set" — preserve existing value.
          const nick = attrs.nickname;
          const color = attrs.color;
          const charRaw = attrs.character;
          const charIdx = charRaw ? Number.parseInt(charRaw, 10) : NaN;
          const charValid = Number.isInteger(charIdx) && charIdx >= 1 && charIdx <= 50;
          if (
            (nick && nick.length > 0) ||
            (color && color.length > 0) ||
            charValid
          ) {
            setPeerProfile(identity, {
              name: nick && nick.length > 0 ? nick : undefined,
              color: color && color.length > 0 ? color : undefined,
              characterIndex: charValid ? charIdx : undefined,
            });
          }
          // Presence status (web-only for now).
          const st = attrs.status;
          if (st && isAvatarStatus(st)) {
            setPeerStatus(identity, st);
          }
          // Now-playing string (M7). Always pass through; the store treats
          // empty as "clear".
          if (typeof attrs.now_playing === "string") {
            setPeerNowPlaying(identity, attrs.now_playing);
          }
          // M2 moderation role (display-only; contract §1). Empty means
          // "not published" — keep the existing value.
          const roleAttr = attrs.role;
          if (roleAttr === "host" || roleAttr === "admin" || roleAttr === "user") {
            setPeerRole(identity, roleAttr);
          }
        },
        onDisconnected: () => {
          // ConnectionController overrides this; for the initial connect we
          // just clear peers so they don't ghost across the reconnect.
          clearPeers();
        },
      };
      const { room } = await connectLiveKit(
        session.serverUrl,
        session.token,
        events,
      );

      // Publish our own profile so Android peers see our nickname/color
      // instead of falling back to the LiveKit identity. `character` is a
      // web-only addition the picker sets; Android ignores unknown attrs.
      void publishProfileAttributes(room, {
        nickname: session.nickname,
        color: session.color,
        characterIndex: joinDraft.characterIndex,
      });
      // M2: publish our moderation role as the display-only `role`
      // attribute (contract §1). Peers show the host badge from this.
      void setRoleAttribute(room, myRole);

      const cache: ConnectCache = {
        backendUrl: BACKEND_URL,
        deviceId,
        room: joinDraft.room,
        nickname: session.nickname,
        color: session.color,
        characterIndex: joinDraft.characterIndex,
        session,
        events,
      };

      setConn("connected");
      onConnected(room, cache);

      // Background-load channels for the room. Fire-and-forget: the chat
      // panel renders fine with an empty list, and joining channels is
      // optional. Restore the user's prior subscriptions from localStorage.
      void listChannels(BACKEND_URL, joinDraft.room)
        .then((cs) => setChannels(cs))
        .catch((err) => console.warn("listChannels failed", err));
      try {
        const key = `syncle.joinedChannels:${joinDraft.room}`;
        const raw = localStorage.getItem(key);
        if (raw) {
          const arr = JSON.parse(raw) as unknown;
          if (Array.isArray(arr)) {
            setJoinedChannelIds(new Set(arr.filter((x): x is string => typeof x === "string")));
          }
        }
      } catch {
        /* ignore corrupt storage */
      }
    } catch (e) {
      console.error(e);
      // M2: translate contract error codes (e.g. the server's nickname
      // sensitive-word rejection) into human-readable hints.
      let msg = e instanceof Error ? e.message : String(e);
      const details = (e as { details?: unknown } | null)?.details;
      const code = moderationErrorCode(details);
      if (code) {
        msg = `${moderationErrorMessage(code)} [${msg}]`;
      }
      setConn("error", msg);
      setLocalError(msg);
    }
  }

  return (
    <div className="join-screen">
      <div className="join-card">
        <h1>Open Study Room</h1>

        {kicked && (
          <div className="kicked-banner" role="alert" aria-live="assertive">
            <span>
              您已被房主请出房间{kicked.reason ? `（${kicked.reason}）` : "。"}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setKicked(null)}
              aria-label="Dismiss"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        <label>
          Nickname
          <input
            value={joinDraft.nickname}
            maxLength={32}
            onChange={(e) => setJoinDraft({ nickname: e.target.value })}
          />
          {nicknameHasSensitiveWord && (
            <span className="hint warn">
              该昵称可能包含敏感词，服务器可能拒绝入场（最终以服务器裁决为准）。
            </span>
          )}
        </label>

        <label>
          Room
          <input
            value={joinDraft.room}
            placeholder="open-study-room"
            onChange={(e) => setJoinDraft({ room: e.target.value })}
          />
          {!roomOk && joinDraft.room.length > 0 && (
            <span className="error">Room must match ^[a-z0-9-]{"{3,64}"}$</span>
          )}
        </label>

        <label>
          Map
          <select
            value={joinDraft.mapUrl}
            onChange={(e) => setJoinDraft({ mapUrl: e.target.value })}
          >
            {mapChoices.map((c) => (
              <option key={c.id} value={c.url}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="char-fieldset">
          <legend>Character (#{String(joinDraft.characterIndex).padStart(2, "0")})</legend>
          <div className="char-grid">
            {Array.from({ length: CHARACTER_COUNT }, (_, i) => i + 1).map((n) => {
              const padded = String(n).padStart(2, "0");
              const selected = n === joinDraft.characterIndex;
              return (
                <button
                  key={n}
                  type="button"
                  className={`char-tile${selected ? " selected" : ""}`}
                  aria-label={`Character ${padded}`}
                  aria-pressed={selected}
                  title={`#${padded}`}
                  onClick={() => {
                    setJoinDraft({ characterIndex: n });
                    persistCharacterIndex(n);
                  }}
                  style={{
                    backgroundImage: `url(/sprites/chars/char_${padded}.png)`,
                  }}
                />
              );
            })}
          </div>
        </fieldset>

        <button
          className="primary"
          disabled={!canSubmit}
          onClick={handleJoin}
        >
          {conn === "connecting" ? "Joining…" : "Join room"}
        </button>

        <button
          type="button"
          className="secondary"
          onClick={onOpenEditor}
          style={{ marginTop: 8 }}
        >
          Open map editor
        </button>

        {(localError || error) && (
          <div className="error" role="alert" aria-live="assertive">{localError ?? error}</div>
        )}

        <small style={{ color: "#7d8696" }}>
          Backend: {BACKEND_URL}
        </small>
      </div>
    </div>
  );
}
