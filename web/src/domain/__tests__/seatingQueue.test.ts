import { describe, expect, it } from "vitest";
import {
  dequeue,
  emptyQueue,
  enqueue,
  isQueued,
  pruneExpired,
  queuePosition,
  serveHead,
  QUEUE_TIMEOUT_MS,
} from "../seatingQueue";

describe("seatingQueue", () => {
  it("enqueues in FIFO order and reports positions", () => {
    const q = emptyQueue();
    expect(enqueue(q, "u1", 1000)).toBe(1);
    expect(enqueue(q, "u2", 1000)).toBe(2);
    expect(queuePosition(q, "u1")).toBe(1);
    expect(queuePosition(q, "u2")).toBe(2);
    expect(isQueued(q, "u1")).toBe(true);
  });

  it("rejects double-enqueue", () => {
    const q = emptyQueue();
    expect(enqueue(q, "u1", 1000)).toBe(1);
    expect(enqueue(q, "u1", 2000)).toBe(-1);
    expect(q.order.length).toBe(1);
  });

  it("serveHead dequeues the head", () => {
    const q = emptyQueue();
    enqueue(q, "u1", 1000);
    enqueue(q, "u2", 1000);
    expect(serveHead(q)).toBe("u1");
    expect(queuePosition(q, "u2")).toBe(1);
    expect(serveHead(q)).toBe("u2");
    expect(serveHead(q)).toBeNull();
  });

  it("dequeue removes a specific user", () => {
    const q = emptyQueue();
    enqueue(q, "u1", 1000);
    expect(dequeue(q, "u1")).toBe(true);
    expect(dequeue(q, "u1")).toBe(false);
    expect(isQueued(q, "u1")).toBe(false);
  });

  it("pruneExpired drops entries past the 5-minute deadline", () => {
    const q = emptyQueue();
    enqueue(q, "u1", 1000);
    enqueue(q, "u2", 1000);
    // u1 expires at 1000 + 5min; prune just before → nothing dropped.
    expect(pruneExpired(q, 1000 + QUEUE_TIMEOUT_MS - 1)).toEqual([]);
    expect(isQueued(q, "u1")).toBe(true);
    // Prune after → both dropped, reported.
    expect(pruneExpired(q, 1000 + QUEUE_TIMEOUT_MS + 1).sort()).toEqual(["u1", "u2"]);
    expect(q.order).toEqual([]);
  });

  it("queuePosition returns 0 for non-members", () => {
    expect(queuePosition(emptyQueue(), "nobody")).toBe(0);
  });
});
