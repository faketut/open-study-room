// Client-side chat send throttle (M2 §4 — architecture-honest).
//
// Chat travels peer-to-peer over the LiveKit data channel; the server can
// never see chat bytes, so rate limiting is client-side and best-effort.
// Normative constants verbatim from docs/contracts.md:
//
//   CHAT_SEND_MIN_INTERVAL_MS = 2000 — at most 1 message per 2 seconds.
//   CHAT_QUEUE_MAX = 3 — faster sends go into a FIFO of max 3; overflow
//   is dropped and the UI shows a "sending too fast" notice.
//
// The moderation loop (report → review → act) is the backstop for hostile
// clients that bypass this.

/** At most 1 message per 2 seconds (contract §4). */
export const CHAT_SEND_MIN_INTERVAL_MS = 2000 as const;
/** FIFO depth for sends that arrive faster than the interval (contract §4). */
export const CHAT_QUEUE_MAX = 3 as const;

/** Outcome of `ChatSendThrottler.attempt`. */
export type ThrottleResult = "sent" | "queued" | "dropped";

/**
 * Gate for chat sends. The first send goes out immediately; sends that
 * arrive within the interval join a bounded FIFO that drains one message
 * per interval. Anything past the FIFO cap is dropped (the caller is told
 * to show the "sending too fast" notice).
 *
 * `now` / `schedule` are injectable so tests can drive the clock.
 */
export class ChatSendThrottler {
  private lastSentAt: number;
  private queue: Array<() => void> = [];
  private drainScheduled = false;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly schedule: (fn: () => void, ms: number) => void = (
      fn,
      ms,
    ) => {
      setTimeout(fn, ms);
    },
  ) {
    // First send of the session goes immediately.
    this.lastSentAt = this.now() - CHAT_SEND_MIN_INTERVAL_MS;
  }

  /** Number of sends currently waiting in the FIFO. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Attempt a send. `send` is executed synchronously on "sent", or later
   * (once per interval, FIFO order) on "queued". Never executed on
   * "dropped".
   */
  attempt(send: () => void): ThrottleResult {
    const t = this.now();
    if (this.queue.length === 0 && t - this.lastSentAt >= CHAT_SEND_MIN_INTERVAL_MS) {
      this.lastSentAt = t;
      send();
      return "sent";
    }
    if (this.queue.length >= CHAT_QUEUE_MAX) return "dropped";
    this.queue.push(send);
    this.scheduleDrain();
    return "queued";
  }

  /** ms until the next queued send may fire (for UI countdowns). */
  msUntilNextSlot(): number {
    const remaining =
      this.lastSentAt + CHAT_SEND_MIN_INTERVAL_MS - this.now();
    return Math.max(0, remaining);
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    this.schedule(() => this.drain(), this.msUntilNextSlot());
  }

  private drain(): void {
    this.drainScheduled = false;
    const next = this.queue.shift();
    if (!next) return;
    this.lastSentAt = this.now();
    next();
    if (this.queue.length > 0) this.scheduleDrain();
  }
}
