import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_MAP,
  getMapChoices,
  isValidNickname,
  isValidRoom,
  useSyncle,
  CHARACTER_COUNT,
  persistCharacterIndex,
} from "../state/syncleStore";
import { createSession, getOrCreateDeviceId, listChannels } from "../data/sessionApi";
import { useAuth } from "../state/authStore";
// P1-B lightweight login (contracts.md "Identity & login"): fragment
// handling, /v1/auth/* clients, bilingual strings via the existing
// pickUiLang/localizeText pattern (no i18n framework).
import {
  AUTH_STRINGS,
  authErrorText,
  getAuthToken,
  githubLoginUrl,
  requestEmailLink,
  visibleLoginEntries,
  type AuthApiError,
} from "../data/auth";
import { loadMapConfig } from "../domain/mapConfig";
// P1-A template picker (contracts.md "Map templates" §4): registry-driven
// cards replace the Map dropdown when templates are published; every
// failure path falls back to the existing default map flow, never a blank
// screen or a broken map.
import {
  fetchRegistry,
  loadSelectedTemplateId,
  localizeText,
  pickSelectedTemplate,
  pickUiLang,
  resolveJoinTemplate,
  saveSelectedTemplateId,
  templatePlaceholderHue,
  thumbnailUrl,
  type RegistryTemplateEntry,
} from "../domain/templateRegistry";
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
  WB_CLEAR_TYPE,
  WB_UPDATE_TYPE,
  decideWbInbound,
  decodeWbMessage,
} from "../domain/whiteboard";
import {
  applyRemoteWbClear,
  applyRemoteWbUpdate,
  getOpenWhiteboard,
} from "../data/whiteboardSession";
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
  // P1-A: template registry. null = still loading or unavailable; an empty
  // array = registry fetched but no templates. Both states silently fall
  // back to the legacy Map dropdown below (never a white screen).
  const [templates, setTemplates] = useState<RegistryTemplateEntry[] | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    () => loadSelectedTemplateId(),
  );
  const uiLang = useMemo(
    () =>
      pickUiLang(typeof navigator !== "undefined" ? navigator.language : undefined),
    [],
  );
  useEffect(() => {
    let alive = true;
    void fetchRegistry().then((list) => {
      if (!alive) return;
      setTemplates(list ?? []);
      if (list != null && list.length > 0) {
        // Pre-select the persisted choice; if it is gone (template removed),
        // fall back to the first template so cards always reflect the join.
        const saved = loadSelectedTemplateId();
        const valid =
          saved != null && list.some((t) => t.id === saved)
            ? saved
            : list[0].id;
        setSelectedTemplateId(valid);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const useTemplatePicker = templates != null && templates.length > 0;

  // P1-B lightweight login (contracts.md "Identity & login"). bootstrap()
  // consumes `#token=`/`#error=` once at startup (stripping the fragment
  // via history.replaceState), restores the stored session, and loads
  // GET /v1/auth/config. Anonymous users are unaffected: the entries stay
  // hidden until config arrives and the flow below is a no-op.
  const bootstrapAuth = useAuth((s) => s.bootstrap);
  const authReady = useAuth((s) => s.ready);
  const authConfig = useAuth((s) => s.config);
  const account = useAuth((s) => s.account);
  const logoutAuth = useAuth((s) => s.logout);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const loginEntries = useMemo(
    () => visibleLoginEntries(authConfig),
    [authConfig],
  );

  useEffect(() => {
    void bootstrapAuth(BACKEND_URL).then(({ errorCode, account: acc }) => {
      if (errorCode != null) {
        setAuthNotice(authErrorText(errorCode, uiLang));
      }
      // Suggest the account's display_name as the join nickname when the
      // draft still holds the auto-generated `Syncle-XXXX` placeholder.
      // Presence nickname stays per-session (contract §1); this only
      // changes the default text in the field, never a chosen nickname.
      if (acc?.displayName) {
        const draft = useSyncle.getState().joinDraft;
        if (/^Syncle-[A-Z0-9]{4}$/.test(draft.nickname.trim())) {
          setJoinDraft({ nickname: acc.displayName });
        }
      }
    });
  }, [bootstrapAuth, uiLang, setJoinDraft]);

  async function handleEmailRequest() {
    const addr = email.trim();
    if (addr.length === 0 || emailBusy) return;
    setEmailBusy(true);
    setAuthNotice(null);
    try {
      // 202 = generic "sent" (contract §4); failures carry a code only.
      await requestEmailLink(BACKEND_URL, addr);
      setEmailSent(true);
    } catch (e) {
      const code = (e as Partial<AuthApiError>)?.code;
      setAuthNotice(authErrorText(code, uiLang));
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleLogout() {
    setEmail("");
    setEmailSent(false);
    await logoutAuth(BACKEND_URL);
  }

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
      // Map resolution (contracts.md §4.4): prefer the registry template when
      // the picker is active; fetch it, run validateTemplate, and fall back
      // to DEFAULT_MAP on ANY failure (bad JSON, validator errors, fetch
      // failure) — never join into a broken map. Without a registry the
      // legacy Map dropdown choice is used unchanged.
      let mapUrl = DEFAULT_MAP.url;
      let spawn = DEFAULT_MAP.spawn;
      const template = useTemplatePicker
        ? pickSelectedTemplate(templates, selectedTemplateId)
        : null;
      if (template != null) {
        try {
          const tplRes = await fetch(template.url);
          if (!tplRes.ok) throw new Error(`template fetch failed: ${tplRes.status}`);
          const rawTemplate: unknown = await tplRes.json();
          const resolved = resolveJoinTemplate(rawTemplate, template.url);
          if (resolved.ok) {
            mapUrl = resolved.url;
            spawn = resolved.spawn;
            saveSelectedTemplateId(template.id);
          } else {
            console.error(
              `[P1-A] template "${template.id}" failed validation, falling back to default map:`,
              resolved.errors,
            );
          }
        } catch (e) {
          console.error(
            `[P1-A] failed to load template "${template.id}", falling back to default map:`,
            e,
          );
        }
      } else {
        const choice =
          mapChoices.find((c) => c.url === joinDraft.mapUrl) ?? mapChoices[0];
        mapUrl = choice.url;
        spawn = choice.spawn;
      }
      const map = await loadMapConfig(mapUrl);
      setMap(map);

      const deviceId = getOrCreateDeviceId();
      const session = await createSession(BACKEND_URL, {
        deviceId,
        nickname: joinDraft.nickname.trim(),
        color: joinDraft.color,
        room: joinDraft.room,
        // P1-B: bind this device's anonymous row to the logged-in account
        // (contract §6 merge). undefined when anonymous — JSON.stringify
        // drops it, so the anonymous flow is unchanged.
        authToken: getAuthToken() ?? undefined,
      });
      // M2/P1-B: the sessions response carries our moderation role (first
      // joiner = host; P1-B adds server-computed `admin`). Display-only
      // locally; the server DB decides.
      const myRole =
        session.role === "host" ? "host" : session.role === "admin" ? "admin" : "user";

      setSelf({
        userId: session.userId,
        nickname: session.nickname,
        color: session.color,
        x: spawn.x,
        y: spawn.y,
        tableId: null,
        status: "available",
        manualBusy: false,
        characterIndex: joinDraft.characterIndex,
        role: myRole,
      });

      resetSeq();
      // Build the handler bundle once; the reconnect controller re-uses
      // this same object on every retry so we don't lose data callbacks.
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
            // P1-C: whiteboard messages (`wb_update` / `wb_clear`) are JSON
            // too (contract "Whiteboard" §2a/§4) — same `{` dispatch as the
            // kick notice. The receiver applies the scene only when the
            // message is for the zone it currently stands in, the board id
            // is well-formed, the sender is not block-listed, and LWW says
            // it is newer (pure `decideWbInbound` in domain/whiteboard.ts).
            const wbMsg = decodeWbMessage(payload);
            if (wbMsg != null) {
              const wbSession = getOpenWhiteboard();
              const wbState = useSyncle.getState();
              const wbSelf = wbState.self;
              const wbMap = wbState.map;
              const myZoneId =
                wbSelf && wbMap
                  ? (findZoneAt(wbSelf.x, wbSelf.y, wbMap)?.key ?? "")
                  : "";
              const verdict = decideWbInbound(wbMsg, {
                room: roomName,
                myZoneId,
                localUpdatedAt: wbSession?.localUpdatedAt ?? 0,
                // M2 T5 local block: drop whiteboard updates from blocked
                // senders before they reach the canvas. Local ignore only —
                // GET snapshots still show the latest scene (contract §4,
                // honest limitation).
                fromBlocked: isBlockedIdentity(roomName, identity),
              });
              if (verdict === "apply" && wbSession) {
                if (wbMsg.type === WB_UPDATE_TYPE) {
                  applyRemoteWbUpdate(wbMsg.scene, wbMsg.updated_at);
                } else if (wbMsg.type === WB_CLEAR_TYPE) {
                  applyRemoteWbClear(wbMsg.updated_at);
                }
              }
              return;
            }
          }
          // Participant-originated packets below (position/chat/reaction)
          // require a sender identity. Server-originated packets
          // (kick_notice, wb_clear) arrive with identity "" and were
          // already dispatched in the JSON branch above; dropping "" here
          // also avoids creating a ghost "" peer in updatePeerPosition.
          if (identity === "") return;
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
      // M2/P1-B: publish our moderation role as the display-only `role`
      // attribute (contract "Identity & login" §6: the `admin` value is
      // published too, for peer badges). Peers show the host/admin badge
      // from this.
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

        {/* P1-B: OAuth/email callback feedback (`#error=` fragment, code
            only — contract §7). Human text in the user's language. */}
        {authNotice && (
          <div className="error auth-error" role="alert" aria-live="assertive">
            <span>{authNotice}</span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setAuthNotice(null)}
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

        {useTemplatePicker ? (
          <fieldset className="template-fieldset">
            <legend>Map template</legend>
            <div className="template-grid">
              {templates!.map((t) => {
                const selected = t.id === selectedTemplateId;
                const thumb = thumbnailUrl(t);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`template-card${selected ? " selected" : ""}`}
                    aria-pressed={selected}
                    onClick={() => {
                      setSelectedTemplateId(t.id);
                      saveSelectedTemplateId(t.id);
                    }}
                  >
                    <span
                      className="template-thumb"
                      aria-hidden="true"
                      style={{
                        background: `hsl(${templatePlaceholderHue(t.id)} 45% 32%)`,
                      }}
                    >
                      {thumb != null && (
                        <img
                          src={thumb}
                          alt=""
                          loading="lazy"
                          // Contract §2: never show a broken <img>; drop it
                          // and reveal the placeholder color block beneath.
                          onError={(e) => e.currentTarget.remove()}
                        />
                      )}
                    </span>
                    <span className="template-name">
                      {localizeText(t.name, uiLang)}
                    </span>
                    <span className="template-desc">
                      {localizeText(t.description, uiLang)}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : (
          <label>
            Map
            <select
              value={joinDraft.mapUrl}
              onChange={(e) => setJoinDraft({ mapUrl: e.target.value })}
              disabled={templates === null}
            >
              {templates === null ? (
                <option>Loading map templates…</option>
              ) : (
                mapChoices.map((c) => (
                  <option key={c.id} value={c.url}>
                    {c.label}
                  </option>
                ))
              )}
            </select>
          </label>
        )}

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

        {/* P1-B login entry (contracts.md "Identity & login"). Rendered only
            when GET /v1/auth/config has arrived and reports a provider
            available — email shows only when `email: true` (contract §4).
            Logged in → the account chip with an admin badge + logout. */}
        {authReady && account == null && (loginEntries.github || loginEntries.email) && (
          <fieldset className="auth-fieldset">
            <legend>{localizeText(AUTH_STRINGS.signIn, uiLang)}</legend>
            {loginEntries.github && (
              <button
                type="button"
                className="secondary auth-provider-btn"
                onClick={() => {
                  // Contract §3: GitHub login = full-page 302 via the
                  // server — simplest and most reliable.
                  window.location.href = githubLoginUrl(BACKEND_URL);
                }}
              >
                {localizeText(AUTH_STRINGS.signInWithGithub, uiLang)}
              </button>
            )}
            {loginEntries.email && (
              emailSent ? (
                <p className="hint">
                  {localizeText(AUTH_STRINGS.checkEmail, uiLang)}
                </p>
              ) : (
                <div className="email-login-row">
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={email}
                    placeholder={localizeText(AUTH_STRINGS.emailPlaceholder, uiLang)}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleEmailRequest();
                    }}
                    aria-label={localizeText(AUTH_STRINGS.signInWithEmail, uiLang)}
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={emailBusy || email.trim().length === 0}
                    onClick={() => void handleEmailRequest()}
                  >
                    {localizeText(AUTH_STRINGS.sendSignInLink, uiLang)}
                  </button>
                </div>
              )
            )}
          </fieldset>
        )}

        {authReady && account != null && (
          <div className="account-chip" role="status">
            {account.avatarUrl && (
              <img
                src={account.avatarUrl}
                alt=""
                className="account-avatar"
                loading="lazy"
                // Never show a broken avatar (same rule as template thumbs).
                onError={(e) => e.currentTarget.remove()}
              />
            )}
            <span className="account-name">
              {account.displayName ?? account.email ?? account.userId}
            </span>
            {account.isAdmin && (
              <span className="role-badge role-badge-admin">
                {localizeText(AUTH_STRINGS.admin, uiLang)}
              </span>
            )}
            <button
              type="button"
              className="secondary account-logout"
              onClick={() => void handleLogout()}
            >
              {localizeText(AUTH_STRINGS.signOut, uiLang)}
            </button>
          </div>
        )}

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
