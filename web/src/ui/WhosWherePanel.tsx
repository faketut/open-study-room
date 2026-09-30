import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { bucketByZone, zoneAllowsAudio, zonesOf, ZONE_KIND_LABELS } from "../domain/zones";
import type { ZoneKind } from "../domain/zones";
import { LOCAL_CHAT_IDENTITY, useSyncle } from "../state/syncleStore";
import {
  blockIdentity,
  isBlockedIdentity,
  unblockIdentity,
} from "../domain/blockList";
import { fileReport } from "../data/moderationApi";
import {
  REPORT_DETAIL_MAX_LEN,
  REPORT_REASON_LABELS,
  REPORT_REASONS,
  isReportReason,
  moderationErrorCode,
  moderationErrorMessage,
  type ReportReason,
} from "../domain/moderation";
import { SessionApiError } from "../data/sessionApi";

/** "Who's where" sidebar. Lists every zone in the current map with the
 *  avatars currently inside it. Collapsed state persists in localStorage so
 *  reloads remember the user's preference. Hidden entirely when the map has
 *  no zones.
 *
 *  M2: peer chips open an action menu (block/unblock with a two-step
 *  confirm, report with a reason dialog). Hosts get a 房主 badge from the
 *  display-only `role` LiveKit attribute. */
const COLLAPSED_KEY = "syncle.whosWhereCollapsed";

function readCollapsed(): boolean {
  try {
    // Collapsed by default (contracts.md "UI refinements" §1). An explicit
    // "0" means the user expanded it before; absence of the key (or any
    // other value) means collapsed.
    return localStorage.getItem(COLLAPSED_KEY) !== "0";
  } catch {
    return true;
  }
}

// Exported for unit tests (collapsed-by-default contract).
export { readCollapsed };

export interface WhosWherePanelProps {
  /** Room name — keys the per-room block list (`syncle.blocked.<room>`). */
  roomName?: string;
  /** Backend base URL for the report endpoint. */
  backendUrl?: string;
  /** Returns the latest session JWT. */
  getToken?: () => string;
}

interface ReportTarget {
  identity: string;
  name: string;
}

export function WhosWherePanel({ roomName = "", backendUrl = "", getToken }: WhosWherePanelProps) {
  const map = useSyncle((s) => s.map);
  const self = useSyncle((s) => s.self);
  const peerCount = useSyncle((s) => s.peers.size);
  // Re-subscribe to peer positions cheaply: only re-render when the count or
  // the joined position signature changes. (rAF on the canvas drives smooth
  // motion; this panel only needs to update when a bucket changes.)
  const positionSig = useSyncle((s) => {
    let sig = `${self?.x ?? 0},${self?.y ?? 0}|`;
    for (const [k, p] of s.peers) sig += `${k}:${Math.round(p.x / 16)},${Math.round(p.y / 16)};`;
    return sig;
  });
  // Reference positionSig so the linter doesn't strip it; the subscription
  // itself triggers the re-render.
  void positionSig;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // M2 peer actions.
  const [menuIdentity, setMenuIdentity] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // The block list lives in localStorage (not reactive); bump this to
  // re-render after block/unblock.
  const [blockVersion, setBlockVersion] = useState(0);
  void blockVersion;

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  if (!map || !self) return null;
  const zones = zonesOf(map);
  if (zones.length === 0) return null;

  const peers = useSyncle.getState().peers;
  const moderationReady = roomName !== "" && backendUrl !== "" && !!getToken;

  function showToast(msg: string) {
    setToast(msg);
  }

  function handleBlock(identity: string, name: string) {
    blockIdentity(roomName, identity);
    setMenuIdentity(null);
    setBlockVersion((v) => v + 1);
    showToast(`Blocked ${name} (local only; they will not be notified)`);
  }

  function handleUnblock(identity: string, name: string) {
    unblockIdentity(roomName, identity);
    setMenuIdentity(null);
    setBlockVersion((v) => v + 1);
    showToast(`Unblocked ${name}`);
  }

  async function submitReport(reason: ReportReason, detail: string) {
    const target = reportTarget;
    if (!target || !getToken) return;
    try {
      await fileReport(backendUrl, roomName, getToken(), {
        targetId: target.identity,
        reason,
        detail: detail.trim().length > 0 ? detail.trim() : undefined,
      });
      showToast("Report submitted. The host will review it.");
    } catch (err) {
      showToast(`Report failed: ${describeReportError(err)}`);
    }
    setReportTarget(null);
    setMenuIdentity(null);
  }

  const avatars = [
    {
      identity: LOCAL_CHAT_IDENTITY,
      name: self.nickname,
      color: self.color,
      x: self.x,
      y: self.y,
      isSelf: true,
    },
    ...Array.from(peers.values()).map((p) => ({
      identity: p.identity,
      name: p.name ?? p.identity.slice(0, 6),
      color: p.color ?? "#5AC8FA",
      x: p.x,
      y: p.y,
      isSelf: false,
    })),
  ];
  const buckets = bucketByZone(map, avatars);
  // bucketByZone returns ZoneOccupant ({identity,name,color}); look up our
  // richer records (isSelf) by identity for the action menu / badges.
  const avatarById = new Map(avatars.map((a) => [a.identity, a] as const));
  const totalKnown = avatars.length; // self + peers
  const inAnyZone = Array.from(buckets.values()).reduce(
    (s, list) => s + list.length,
    0,
  );
  const unzoned = Math.max(0, totalKnown - inAnyZone);

  // Group zones by acoustic kind (contracts.md "Zones (M1)"). Each group
  // shows its semantic label — e.g. "自习区 · 12 人" — plus the zones and
  // avatars inside it. Only kinds that have authored zones are shown.
  const KIND_ORDER: ZoneKind[] = ["silent", "discussion", "rest"];
  const zoneGroups = KIND_ORDER.map((kind) => {
    const groupZones = zones.filter((z) => z.kind === kind);
    const total = groupZones.reduce(
      (s, z) => s + (buckets.get(z.key) ?? []).length,
      0,
    );
    return { kind, zones: groupZones, total };
  }).filter((g) => g.zones.length > 0);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <aside
      className={`whos-where${collapsed ? " collapsed" : ""}`}
      aria-label="Who's where"
    >
      <button
        type="button"
        className="whos-where-toggle"
        onClick={toggle}
        aria-expanded={!collapsed}
        title={collapsed ? "Show who's where" : "Hide who's where"}
      >
        {collapsed ? (
          <>
            <Users size={14} aria-hidden="true" focusable="false" />
            <span className="whos-where-count">{peerCount + 1}</span>
          </>
        ) : (
          <>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
              style={{
                transition: "transform 200ms ease",
              }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span className="whos-where-title">Who's where</span>
            <span className="whos-where-count">{peerCount + 1}</span>
          </>
        )}
      </button>
      {toast && (
        <div className="whos-where-toast" role="status">
          {toast}
        </div>
      )}
      {!collapsed && (
        <ul className="whos-where-list" role="list">
          {zoneGroups.map((g) => (
            <li key={g.kind} className={`whos-where-kind whos-where-kind--${g.kind}`}>
              <div
                className="whos-where-kind-header"
                title={zoneAllowsAudio(g.kind) ? "Talking allowed" : "Quiet — mic forced off"}
              >
                <span className="whos-where-kind-name">{ZONE_KIND_LABELS[g.kind]}</span>
                <span className="whos-where-kind-count">{g.total}</span>
              </div>
              {g.zones.map((z) => {
                const occupants = buckets.get(z.key) ?? [];
                return (
                  <div key={z.key} className="whos-where-zone">
                    <div className="whos-where-zone-header">
                      <span className="whos-where-zone-name">{z.label}</span>
                      <span className="whos-where-zone-count">{occupants.length}</span>
                    </div>
                    {occupants.length > 0 ? (
                      <div className="whos-where-avatars">
                        {occupants.slice(0, 5).map((o) => {
                          const full = avatarById.get(o.identity);
                          const isSelf = full?.isSelf ?? o.identity === LOCAL_CHAT_IDENTITY;
                          const blocked =
                            !isSelf &&
                            roomName !== "" &&
                            isBlockedIdentity(roomName, o.identity);
                          const role = isSelf
                            ? self.role
                            : peers.get(o.identity)?.role;
                          const isHost = role === "host" || role === "admin";
                          return (
                            <span
                              key={o.identity}
                              className="whos-where-avatar-wrap"
                            >
                              <button
                                type="button"
                                className={`whos-where-avatar${blocked ? " blocked" : ""}${isHost ? " is-host" : ""}`}
                                style={{ background: o.color }}
                                title={
                                  isSelf
                                    ? `${o.name} (you)`
                                    : `${o.name}${isHost ? " · Host" : ""}${blocked ? " · Blocked" : ""}`
                                }
                                aria-label={isSelf ? `${o.name} (you)` : o.name}
                                aria-haspopup={!isSelf && moderationReady ? "menu" : undefined}
                                onClick={() => {
                                  if (isSelf || !moderationReady) return;
                                  setMenuIdentity((cur) =>
                                    cur === o.identity ? null : o.identity,
                                  );
                                }}
                              >
                                {initials(o.name)}
                                {isHost && (
                                  <span className="host-badge" aria-label="Room host">
                                    Host
                                  </span>
                                )}
                              </button>
                              {menuIdentity === o.identity && !isSelf && (
                                <PeerMenu
                                  name={o.name}
                                  blocked={blocked}
                                  onBlock={() => handleBlock(o.identity, o.name)}
                                  onUnblock={() => handleUnblock(o.identity, o.name)}
                                  onReport={() => {
                                    setReportTarget({
                                      identity: o.identity,
                                      name: o.name,
                                    });
                                    setMenuIdentity(null);
                                  }}
                                  onClose={() => setMenuIdentity(null)}
                                />
                              )}
                            </span>
                          );
                        })}
                        {occupants.length > 5 && (
                          <span className="whos-where-overflow">
                            +{occupants.length - 5}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="whos-where-empty">Empty</div>
                    )}
                  </div>
                );
              })}
            </li>
          ))}
          {unzoned > 0 && (
            <li className="whos-where-zone whos-where-zone--ghost">
              <div className="whos-where-zone-header">
                <span className="whos-where-zone-name">Roaming</span>
                <span className="whos-where-zone-count">{unzoned}</span>
              </div>
            </li>
          )}
        </ul>
      )}
      {reportTarget && (
        <ReportDialog
          targetName={reportTarget.name}
          onSubmit={(reason, detail) => void submitReport(reason, detail)}
          onClose={() => setReportTarget(null)}
        />
      )}
    </aside>
  );
}

/** Per-peer action menu: block/unblock (two-step confirm) + report. */
function PeerMenu({
  name,
  blocked,
  onBlock,
  onUnblock,
  onReport,
  onClose,
}: {
  name: string;
  blocked: boolean;
  onBlock: () => void;
  onUnblock: () => void;
  onReport: () => void;
  onClose: () => void;
}) {
  const [arming, setArming] = useState<"block" | "unblock" | null>(null);
  return (
    <div className="peer-menu" role="menu" aria-label={`Actions for ${name}`}>
      <div className="peer-menu-name">{name}</div>
      {blocked ? (
        <button
          type="button"
          role="menuitem"
          className={`peer-menu-item${arming === "unblock" ? " armed" : ""}`}
          onClick={() => {
            if (arming === "unblock") onUnblock();
            else setArming("unblock");
          }}
        >
          {arming === "unblock" ? "Confirm unblock?" : "Unblock"}
        </button>
      ) : (
        <button
          type="button"
          role="menuitem"
          className={`peer-menu-item${arming === "block" ? " armed" : ""}`}
          onClick={() => {
            if (arming === "block") onBlock();
            else setArming("block");
          }}
        >
          {arming === "block" ? "Confirm block?" : "Block"}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className="peer-menu-item"
        onClick={onReport}
      >
        Report
      </button>
      <button
        type="button"
        role="menuitem"
        className="peer-menu-item peer-menu-cancel"
        onClick={onClose}
      >
        Cancel
      </button>
    </div>
  );
}

/** Report dialog: reason (4 options per contract) + optional detail
 *  (≤500 chars) → POST /v1/rooms/:room/reports.
 *  Exported for reuse by the person suite card (PersonCard). */
export function ReportDialog({
  targetName,
  onSubmit,
  onClose,
}: {
  targetName: string;
  onSubmit: (reason: ReportReason, detail: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason>("spam");
  const [detail, setDetail] = useState("");
  const detailLen = detail.length;
  return (
    <div
      className="report-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Report ${targetName}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="report-dialog">
        <div className="report-dialog-title">Report {targetName}</div>
        <div className="report-reasons" role="radiogroup" aria-label="Report reason">
          {REPORT_REASONS.map((r) => (
            <label key={r} className="report-reason">
              <input
                type="radio"
                name="report-reason"
                checked={reason === r}
                onChange={() => setReason(r)}
              />
              {REPORT_REASON_LABELS[r]}
            </label>
          ))}
        </div>
        <textarea
          className="report-detail"
          value={detail}
          maxLength={REPORT_DETAIL_MAX_LEN}
          placeholder="Additional details (optional, max 500 characters)"
          rows={3}
          onChange={(e) => setDetail(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="Report detail"
        />
        <div className="report-detail-count">
          {detailLen}/{REPORT_DETAIL_MAX_LEN}
        </div>
        <div className="report-dialog-actions">
          <button
            type="button"
            className="peer-menu-item"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="peer-menu-item danger"
            onClick={() => {
              if (isReportReason(reason)) onSubmit(reason, detail);
            }}
          >
            Submit report
          </button>
        </div>
        <div className="report-dialog-note">
          Reports are only visible to the host. Blocking is local; the other person will not be notified.
        </div>
      </div>
    </div>
  );
}

function initials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Map a report-submission failure to a user-facing string. Exported so
 *  PersonCard reuses the exact same error wording as WhosWherePanel. */
export function describeReportError(err: unknown): string {
  if (err instanceof SessionApiError) {
    const code = moderationErrorCode(err.details);
    if (code) return moderationErrorMessage(code);
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
