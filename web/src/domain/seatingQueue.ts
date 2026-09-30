/**
 * Full-house queue (contracts.md "Pixel-art tilemap" §5).
 *
 * Per-client FIFO queue for the reading hall. Pure state machine —
 * the UI layer feeds it presence updates and renders toasts/dialogs.
 *
 * Semantics:
 * - `enqueue()` → position 1..N ("You are #N in line").
 * - `notifySeatFree()` → when called while the queue is non-empty, the head
 *   is "served": the caller should toast + highlight the freed table, and
 *   the head is dequeued (they either sit or forfeit by timeout).
 * - `dequeue()` on: sitting anywhere, leaving the map, timeout (5 min),
 *   or explicit cancel.
 * - Timeout is deadline-based so it survives tab sleep: `enqueue()` stamps
 *   `deadlineMs = now + QUEUE_TIMEOUT_MS`; `pruneExpired(now)` drops the
 *   expired entries and reports whether the local user was dropped.
 */
export const QUEUE_TIMEOUT_MS = 5 * 60 * 1000;

export interface QueueState {
  /** Ordered user ids (opaque strings), head first. */
  order: string[];
  /** Deadline per user id (ms epoch). */
  deadlines: Record<string, number>;
}

export function emptyQueue(): QueueState {
  return { order: [], deadlines: {} };
}

/** Join the queue. Returns the 1-based position, or -1 if already queued. */
export function enqueue(q: QueueState, userId: string, nowMs: number): number {
  if (q.order.includes(userId)) return -1;
  q.order.push(userId);
  q.deadlines[userId] = nowMs + QUEUE_TIMEOUT_MS;
  return q.order.length;
}

export function dequeue(q: QueueState, userId: string): boolean {
  const i = q.order.indexOf(userId);
  if (i < 0) return false;
  q.order.splice(i, 1);
  delete q.deadlines[userId];
  return true;
}

export function queuePosition(q: QueueState, userId: string): number {
  const i = q.order.indexOf(userId);
  return i < 0 ? 0 : i + 1;
}

export function isQueued(q: QueueState, userId: string): boolean {
  return q.order.includes(userId);
}

/** Serve the head of the queue (a seat freed). Returns the served user id,
 *  or null when the queue is empty. */
export function serveHead(q: QueueState): string | null {
  const head = q.order.shift();
  if (head === undefined) return null;
  delete q.deadlines[head];
  return head;
}

/** Drop expired entries. Returns the user ids that were dropped (so the UI
 *  can toast the local user if they timed out). */
export function pruneExpired(q: QueueState, nowMs: number): string[] {
  const dropped: string[] = [];
  q.order = q.order.filter((id) => {
    const dl = q.deadlines[id] ?? Infinity;
    if (dl <= nowMs) {
      dropped.push(id);
      delete q.deadlines[id];
      return false;
    }
    return true;
  });
  return dropped;
}
