import { describe, it, expect } from "vitest";
import {
  ChatSendThrottler,
  CHAT_QUEUE_MAX,
  CHAT_SEND_MIN_INTERVAL_MS,
} from "../chatThrottle";

/** Fake clock + manual scheduler. */
function harness() {
  let now = 0;
  const scheduled: Array<{ fn: () => void; at: number }> = [];
  const throttler = new ChatSendThrottler(
    () => now,
    (fn, ms) => {
      scheduled.push({ fn, at: now + ms });
    },
  );
  const fired: string[] = [];
  const attempt = (label: string) =>
    throttler.attempt(() => {
      fired.push(label);
    });
  /** Fire all scheduled drains in time order, advancing the clock. */
  const runAll = () => {
    scheduled.sort((a, b) => a.at - b.at);
    while (scheduled.length > 0) {
      const next = scheduled.shift()!;
      now = Math.max(now, next.at);
      next.fn();
      scheduled.sort((a, b) => a.at - b.at);
    }
  };
  const setNow = (t: number) => {
    now = t;
  };
  return { throttler, attempt, fired, runAll, setNow, getNow: () => now };
}

describe("chat send throttle", () => {
  it("sends the first message immediately", () => {
    const h = harness();
    expect(h.attempt("a")).toBe("sent");
    expect(h.fired).toEqual(["a"]);
    expect(h.throttler.pendingCount).toBe(0);
  });

  it("queues sends inside the interval and drains one per interval", () => {
    const h = harness();
    expect(h.attempt("a")).toBe("sent");
    h.setNow(100);
    expect(h.attempt("b")).toBe("queued");
    expect(h.throttler.pendingCount).toBe(1);
    h.runAll();
    expect(h.fired).toEqual(["a", "b"]);
    expect(h.throttler.pendingCount).toBe(0);
    // The queued message fired exactly one interval after the first.
    expect(h.getNow()).toBe(CHAT_SEND_MIN_INTERVAL_MS);
  });

  it("drains the queue in FIFO order", () => {
    const h = harness();
    expect(h.attempt("a")).toBe("sent");
    h.setNow(100);
    expect(h.attempt("b")).toBe("queued");
    h.setNow(200);
    expect(h.attempt("c")).toBe("queued");
    expect(h.throttler.pendingCount).toBe(2);
    h.runAll();
    expect(h.fired).toEqual(["a", "b", "c"]);
  });

  it("drops sends past the queue cap and never executes them", () => {
    const h = harness();
    expect(h.attempt("a")).toBe("sent");
    h.setNow(100);
    for (let i = 0; i < CHAT_QUEUE_MAX; i++) {
      expect(h.attempt(`q${i}`)).toBe("queued");
    }
    expect(h.throttler.pendingCount).toBe(CHAT_QUEUE_MAX);
    expect(h.attempt("overflow")).toBe("dropped");
    h.runAll();
    expect(h.fired).toContain("a");
    expect(h.fired).not.toContain("overflow");
    expect(h.fired.length).toBe(1 + CHAT_QUEUE_MAX);
  });

  it("allows a new immediate send after the interval elapses", () => {
    const h = harness();
    expect(h.attempt("a")).toBe("sent");
    h.setNow(CHAT_SEND_MIN_INTERVAL_MS);
    expect(h.attempt("b")).toBe("sent");
    expect(h.fired).toEqual(["a", "b"]);
  });

  it("reports ms until the next slot", () => {
    const h = harness();
    h.attempt("a");
    h.setNow(500);
    expect(h.throttler.msUntilNextSlot()).toBe(
      CHAT_SEND_MIN_INTERVAL_MS - 500,
    );
    h.setNow(CHAT_SEND_MIN_INTERVAL_MS);
    expect(h.throttler.msUntilNextSlot()).toBe(0);
  });
});
