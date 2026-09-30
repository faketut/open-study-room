// M2 T8 — host moderation panel.
//
// Rendered only when the sessions response says `role === "host"`
// (gated in SyncleScreen). Talks to the five contract §6 endpoints:
//
//   GET  /v1/rooms/:room/reports          (open|all)
//   POST /v1/rooms/:room/reports/:id/action
//   POST /v1/rooms/:room/moderate          (mute|unmute|kick)
//   POST /v1/rooms/:room/host              (transfer)
//
// The server resolves the caller's role from its DB on every request —
// the client-side `role` attribute is display-only. Destructive actions
// (mute / kick / transfer) require an inline two-step confirm, per the
// contract's "UI double-confirm" rule. Server error codes are translated
// to human-readable hints via `moderationErrorMessage`.

import { useCallback, useEffect, useState } from "react";
import type { Room } from "livekit-client";
import { useSyncle } from "../state/syncleStore";
import { setRoleAttribute } from "../data/liveKitService";
import {
  closeReport,
  listReports,
  moderateUser,
  transferHost,
  type ReportDto,
  type ReportStatusFilter,
} from "../data/moderationApi";
import {
  KICK_REASON_MAX_LEN,
  MODERATE_ACTION_LABELS,
  REPORT_REASON_LABELS,
  moderationErrorCode,
  moderationErrorMessage,
  type ModerateAction,
} from "../domain/moderation";
import type { ReportDecision } from "../data/moderationApi";
import { SessionApiError } from "../data/sessionApi";

export interface ModerationPanelProps {
  room: Room;
  backendUrl: string;
  roomName: string;
  getToken: () => string;
  onClose: () => void;
}

type PendingAction =
  | { kind: "moderate"; report: ReportDto; action: ModerateAction }
  | { kind: "close"; report: ReportDto; decision: ReportDecision }
  | { kind: "transfer"; toUserId: string; toName: string }
  | null;

export function ModerationPanel({
  room,
  backendUrl,
  roomName,
  getToken,
  onClose,
}: ModerationPanelProps) {
  const peers = useSyncle((s) => s.peers);
  const self = useSyncle((s) => s.self);
  const [filter, setFilter] = useState<ReportStatusFilter>("open");
  const [reports, setReports] = useState<ReportDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [kickReason, setKickReason] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listReports(backendUrl, roomName, getToken(), filter);
      setReports(list);
    } catch (err) {
      setNotice(`Failed to load reports: ${describeError(err)}`);
    } finally {
      setLoading(false);
    }
  }, [backendUrl, roomName, getToken, filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function failNotice(err: unknown, what: string): void {
    setNotice(`${what}: ${describeError(err)}`);
  }

  async function doModerate(report: ReportDto, action: ModerateAction) {
    try {
      const body =
        action === "kick" && kickReason.trim().length > 0
          ? {
              targetUserId: report.targetId,
              action,
              reason: kickReason.trim().slice(0, KICK_REASON_MAX_LEN),
            }
          : { targetUserId: report.targetId, action };
      const res = await moderateUser(backendUrl, roomName, getToken(), body);
      setNotice(
        `${MODERATE_ACTION_LABELS[action]} applied to ${report.targetNickname} (${res.action}).`,
      );
      setPending(null);
      void refresh();
    } catch (err) {
      failNotice(err, `Failed to ${action}`);
      setPending(null);
    }
  }

  async function doClose(report: ReportDto, decision: ReportDecision) {
    try {
      await closeReport(backendUrl, roomName, getToken(), report.id, decision);
      setNotice(`Report ${decision}.`);
      setPending(null);
      void refresh();
    } catch (err) {
      failNotice(err, "Failed to close report");
      setPending(null);
    }
  }

  async function doTransfer(toUserId: string) {
    try {
      const res = await transferHost(backendUrl, roomName, getToken(), toUserId);
      setNotice(`Host transferred to ${peerName(res.host)}.`);
      // We are no longer host: drop our own role locally and republish
      // the display attribute, then close the panel (it is host-only).
      const st = useSyncle.getState();
      if (st.self) st.setSelf({ ...st.self, role: "user" });
      void setRoleAttribute(room, "user");
      setPending(null);
      onClose();
    } catch (err) {
      failNotice(err, "Failed to transfer host");
      setPending(null);
    }
  }

  function peerName(identity: string): string {
    if (self && identity === self.userId) return `${self.nickname} (you)`;
    return peers.get(identity)?.name ?? identity.slice(0, 8);
  }

  const openCount = reports.filter((r) => r.status === "open").length;

  return (
    <div
      className="moderation-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Moderation panel"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="moderation-panel">
        <div className="moderation-header">
          <strong>Moderation</strong>
          <span className="moderation-room">{roomName}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close moderation panel"
          >
            ✕
          </button>
        </div>

        {notice && (
          <div className="moderation-notice" role="status">
            {notice}
            <button
              type="button"
              className="icon-btn"
              onClick={() => setNotice(null)}
              aria-label="Dismiss notice"
            >
              ✕
            </button>
          </div>
        )}

        <div className="moderation-tabs" role="tablist">
          {(["open", "all"] as ReportStatusFilter[]).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              className={`chat-tab${filter === f ? " active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "open" ? `Open${openCount > 0 ? ` (${openCount})` : ""}` : "All"}
            </button>
          ))}
          <button
            type="button"
            className="moderation-refresh"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? "…" : "Refresh"}
          </button>
        </div>

        <div className="moderation-reports">
          {reports.length === 0 && !loading && (
            <div className="chat-empty">No reports.</div>
          )}
          {reports.map((r) => (
            <ReportCard
              key={r.id}
              report={r}
              pending={pending}
              kickReason={kickReason}
              onKickReason={setKickReason}
              onModerate={(action) => {
                const p: PendingAction = {
                  kind: "moderate",
                  report: r,
                  action,
                };
                if (isPending(pending, p)) void doModerate(r, action);
                else setPending(p);
              }}
              onClose={(decision) => {
                const p: PendingAction = { kind: "close", report: r, decision };
                if (isPending(pending, p)) void doClose(r, decision);
                else setPending(p);
              }}
              onCancelPending={() => setPending(null)}
            />
          ))}
        </div>

        <div className="moderation-transfer">
          <div className="moderation-transfer-title">Transfer host</div>
          <div className="moderation-transfer-row">
            <select
              className="chat-picker"
              value={transferTo}
              onChange={(e) => setTransferTo(e.target.value)}
              aria-label="New host"
            >
              <option value="">Select a peer…</option>
              {Array.from(peers.values()).map((p) => (
                <option key={p.identity} value={p.identity}>
                  {p.name ?? p.identity.slice(0, 8)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="moderation-action danger"
              disabled={transferTo.length === 0}
              onClick={() => {
                const p: PendingAction = {
                  kind: "transfer",
                  toUserId: transferTo,
                  toName: peerName(transferTo),
                };
                if (isPending(pending, p)) void doTransfer(transferTo);
                else setPending(p);
              }}
            >
              {pending?.kind === "transfer" && pending.toUserId === transferTo
                ? "Confirm transfer?"
                : "Transfer"}
            </button>
            {pending?.kind === "transfer" && (
              <button
                type="button"
                className="moderation-action"
                onClick={() => setPending(null)}
              >
                Cancel
              </button>
            )}
          </div>
          {pending?.kind === "transfer" && (
            <div className="moderation-confirm-hint">
              Transfer host to <strong>{pending.toName}</strong>? You will
              become a regular user.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReportCard({
  report,
  pending,
  kickReason,
  onKickReason,
  onModerate,
  onClose,
  onCancelPending,
}: {
  report: ReportDto;
  pending: PendingAction;
  kickReason: string;
  onKickReason: (v: string) => void;
  onModerate: (action: ModerateAction) => void;
  onClose: (decision: ReportDecision) => void;
  onCancelPending: () => void;
}) {
  const r = report;
  const isOpen = r.status === "open";
  return (
    <div className={`moderation-report moderation-report--${r.status}`}>
      <div className="moderation-report-head">
        <span className="moderation-reason">{REPORT_REASON_LABELS[r.reason]}</span>
        <span className={`moderation-status moderation-status--${r.status}`}>
          {r.status}
        </span>
      </div>
      <div className="moderation-report-meta">
        {r.reporterNickname} → <strong>{r.targetNickname}</strong>
        <span className="moderation-ts">
          {" "}
          · {new Date(r.createdAt).toLocaleString()}
        </span>
      </div>
      {r.detail && <div className="moderation-detail">{r.detail}</div>}
      {!isOpen && r.handledBy && (
        <div className="moderation-handled">
          Handled by {r.handledBy.slice(0, 8)}
          {r.handledAt ? ` · ${new Date(r.handledAt).toLocaleString()}` : ""}
        </div>
      )}
      {isOpen && (
        <div className="moderation-actions">
          {(["mute", "unmute", "kick"] as ModerateAction[]).map((a) => {
            const armed =
              pending?.kind === "moderate" &&
              pending.report.id === r.id &&
              pending.action === a;
            return (
              <button
                key={a}
                type="button"
                className={`moderation-action${a === "kick" ? " danger" : ""}${armed ? " armed" : ""}`}
                onClick={() => onModerate(a)}
                title={
                  a === "mute"
                    ? "Server-mute this user's mic"
                    : a === "unmute"
                      ? "Lift the moderation mute"
                      : "Remove this user from the room (same-day rejoin blocked)"
                }
              >
                {armed ? `Confirm ${a}?` : MODERATE_ACTION_LABELS[a]}
              </button>
            );
          })}
          <button
            type="button"
            className={`moderation-action${pending?.kind === "close" && pending.report.id === r.id && pending.decision === "actioned" ? " armed" : ""}`}
            onClick={() => onClose("actioned")}
          >
            {pending?.kind === "close" &&
            pending.report.id === r.id &&
            pending.decision === "actioned"
              ? "Confirm actioned?"
              : "Mark actioned"}
          </button>
          <button
            type="button"
            className={`moderation-action${pending?.kind === "close" && pending.report.id === r.id && pending.decision === "dismissed" ? " armed" : ""}`}
            onClick={() => onClose("dismissed")}
          >
            {pending?.kind === "close" &&
            pending.report.id === r.id &&
            pending.decision === "dismissed"
              ? "Confirm dismissed?"
              : "Dismiss"}
          </button>
          {pending && pending.kind !== "transfer" && pending.report.id === r.id && (
            <button
              type="button"
              className="moderation-action"
              onClick={onCancelPending}
            >
              Cancel
            </button>
          )}
        </div>
      )}
      {isOpen && (
        <input
          className="moderation-reason-input"
          value={kickReason}
          maxLength={KICK_REASON_MAX_LEN}
          placeholder="Kick reason (optional, shown to the kicked user)"
          onChange={(e) => onKickReason(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="Kick reason"
        />
      )}
    </div>
  );
}

/** True when the user just clicked the same armed action twice. */
function isPending(a: PendingAction, b: PendingAction): boolean {
  if (a == null || b == null) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "transfer" && b.kind === "transfer") {
    return a.toUserId === b.toUserId;
  }
  if (
    (a.kind === "moderate" || a.kind === "close") &&
    (b.kind === "moderate" || b.kind === "close")
  ) {
    const ra = (a as { report: ReportDto }).report.id;
    const rb = (b as { report: ReportDto }).report.id;
    const da =
      a.kind === "moderate"
        ? (a as { action: ModerateAction }).action
        : (a as { decision: ReportDecision }).decision;
    const db =
      b.kind === "moderate"
        ? (b as { action: ModerateAction }).action
        : (b as { decision: ReportDecision }).decision;
    return ra === rb && da === db;
  }
  return false;
}

/** Human-readable one-liner for a REST failure. */
function describeError(err: unknown): string {
  if (err instanceof SessionApiError) {
    const code = moderationErrorCode(err.details);
    if (code) return moderationErrorMessage(code);
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
