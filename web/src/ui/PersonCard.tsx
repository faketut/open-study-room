import { useEffect, useState } from "react";
import {
  blockIdentity,
  isBlockedIdentity,
  unblockIdentity,
} from "../domain/blockList";
import { fileReport } from "../data/moderationApi";
import type { ReportReason } from "../domain/moderation";
import {
  describeReportError,
  ReportDialog,
} from "./WhosWherePanel";

export interface PersonCardProps {
  /** LiveKit identity of the nearby peer. */
  identity: string;
  /** Display name (falls back to an identity prefix upstream). */
  name: string;
  /** Avatar dot color advertised by the peer. */
  color?: string;
  /** Room name — keys the per-room block list (`syncle.blocked.<room>`). */
  roomName: string;
  /** Backend base URL for the report endpoint. */
  backendUrl: string;
  /** Returns the latest session JWT. */
  getToken: () => string;
}

/** Person suite card (contracts.md "Layout & contextual UI" §2, suite 4).
 *  Small pointer-agnostic card: peer name + 屏蔽/举报 buttons. Block and
 *  report reuse the exact M2 logic of WhosWherePanel's action menu —
 *  `domain/blockList` for the local block, the shared `ReportDialog` and
 *  error wording for reports. */
export function PersonCard({
  identity,
  name,
  color,
  roomName,
  backendUrl,
  getToken,
}: PersonCardProps) {
  const [reportOpen, setReportOpen] = useState(false);
  const [arming, setArming] = useState<"block" | "unblock" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // The block list lives in localStorage (not reactive); bump this to
  // re-render after block/unblock (same pattern as WhosWherePanel).
  const [blockVersion, setBlockVersion] = useState(0);
  void blockVersion;

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);
  // Reset the two-step confirm / dialog when the card switches to another peer.
  useEffect(() => {
    setArming(null);
    setReportOpen(false);
  }, [identity]);

  const moderationReady = roomName !== "" && backendUrl !== "";
  if (!moderationReady) return null;

  const blocked = isBlockedIdentity(roomName, identity);

  function handleBlock() {
    blockIdentity(roomName, identity);
    setArming(null);
    setBlockVersion((v) => v + 1);
    setToast(`Blocked ${name} (local only; they will not be notified)`);
  }

  function handleUnblock() {
    unblockIdentity(roomName, identity);
    setArming(null);
    setBlockVersion((v) => v + 1);
    setToast(`Unblocked ${name}`);
  }

  async function submitReport(reason: ReportReason, detail: string) {
    try {
      await fileReport(backendUrl, roomName, getToken(), {
        targetId: identity,
        reason,
        detail: detail.trim().length > 0 ? detail.trim() : undefined,
      });
      setToast("Report submitted. The host will review it.");
    } catch (err) {
      setToast(`Report failed: ${describeReportError(err)}`);
    }
    setReportOpen(false);
  }

  return (
    <div className="person-card" role="group" aria-label={`Nearby person: ${name}`}>
      <span
        className="person-card-dot"
        style={{ background: color ?? "#5AC8FA" }}
        aria-hidden="true"
      />
      <span className="person-card-name">{name}</span>
      {blocked ? (
        <button
          type="button"
          className={`person-card-btn${arming === "unblock" ? " armed" : ""}`}
          onClick={() => {
            if (arming === "unblock") handleUnblock();
            else setArming("unblock");
          }}
        >
          {arming === "unblock" ? "Confirm unblock?" : "Unblock"}
        </button>
      ) : (
        <button
          type="button"
          className={`person-card-btn${arming === "block" ? " armed" : ""}`}
          onClick={() => {
            if (arming === "block") handleBlock();
            else setArming("block");
          }}
        >
          {arming === "block" ? "Confirm block?" : "Block"}
        </button>
      )}
      <button
        type="button"
        className="person-card-btn"
        onClick={() => setReportOpen(true)}
      >
        Report
      </button>
      {toast && (
        <span className="person-card-toast" role="status">
          {toast}
        </span>
      )}
      {reportOpen && (
        <ReportDialog
          targetName={name}
          onSubmit={(reason, detail) => void submitReport(reason, detail)}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  );
}
