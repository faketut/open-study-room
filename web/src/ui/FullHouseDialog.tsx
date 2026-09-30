// Full-house dialog (contracts.md "Pixel-art tilemap" §5).
//
// Shown when the user tries to sit in the reading hall while it is full.
// Three English-only actions: join the per-client FIFO queue, overflow to
// the lounge (toast + highlight free lounge tables), or cancel.

export interface FullHouseDialogProps {
  /** 1-based queue position, shown after the user joins the queue. */
  queuePosition: number;
  /** True once the user has joined the queue (dialog switches to status). */
  queued: boolean;
  onQueue: () => void;
  onOverflow: () => void;
  onCancel: () => void;
}

export function FullHouseDialog({
  queuePosition,
  queued,
  onQueue,
  onOverflow,
  onCancel,
}: FullHouseDialogProps) {
  return (
    <div className="fullhouse-overlay" role="dialog" aria-modal="true" aria-label="Reading hall is full">
      <div className="fullhouse-card">
        <div className="fullhouse-title">📚 Reading hall is full.</div>
        {queued ? (
          <div className="fullhouse-body">
            You are <strong>#{queuePosition}</strong> in line. We&apos;ll let
            you know as soon as a seat opens up.
          </div>
        ) : (
          <div className="fullhouse-body">
            Every seat is taken right now. You can queue for the next free
            seat, or head to the lounge — there are open seats there.
          </div>
        )}
        <div className="fullhouse-actions">
          {!queued && (
            <button type="button" className="fullhouse-btn primary" onClick={onQueue}>
              Queue for a seat
            </button>
          )}
          {!queued && (
            <button type="button" className="fullhouse-btn" onClick={onOverflow}>
              Sit in lounge instead
            </button>
          )}
          <button type="button" className="fullhouse-btn ghost" onClick={onCancel}>
            {queued ? "Leave queue" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
