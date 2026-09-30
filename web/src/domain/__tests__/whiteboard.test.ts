// P1-C whiteboard domain tests.
//
// Contract: docs/contracts.md "Whiteboard (P1-C: discussion-zone shared
// board)" — "Test coverage (P1-C targets)". Covers: `whiteboardId` format,
// codec round-trip + malformed rejection, LWW boundaries, receiver zone /
// board filters, blockList filtering, debounce behavior, and the 256 KiB
// snapshot cap. (PUT LWW / not_in_zone / too_large / not_host are
// server-side targets — another worker's scope.)

import { describe, it, expect } from "vitest";
import {
  WB_UPDATE_TYPE,
  WB_CLEAR_TYPE,
  WB_DEBOUNCE_MS,
  WB_MAX_BROADCAST_HZ,
  WHITEBOARD_MAX_SNAPSHOT_BYTES,
  whiteboardId,
  isWellFormedBoardId,
  whiteboardAllowedIn,
  encodeWbUpdate,
  decodeWbMessage,
  lwwShouldApply,
  decideWbInbound,
  sceneJsonOverCap,
  createWbBroadcastScheduler,
  type WbUpdateMessage,
  type WbClearMessage,
} from "../whiteboard";

const SCENE = { elements: [{ id: "a", type: "rectangle" }], appState: {}, files: {} };

function updateMsg(overrides: Partial<WbUpdateMessage> = {}): WbUpdateMessage {
  return {
    type: WB_UPDATE_TYPE,
    board: whiteboardId("room1", "zoneA"),
    zone_id: "zoneA",
    updated_at: 1000,
    scene: SCENE,
    ...overrides,
  };
}

function clearMsg(overrides: Partial<WbClearMessage> = {}): WbClearMessage {
  return {
    type: WB_CLEAR_TYPE,
    board: whiteboardId("room1", "zoneA"),
    zone_id: "zoneA",
    updated_at: 1000,
    ...overrides,
  };
}

describe("whiteboardId", () => {
  it("formats as wb:<room>:<zoneId>", () => {
    expect(whiteboardId("room1", "zoneA")).toBe("wb:room1:zoneA");
  });

  it("isWellFormedBoardId accepts only the exact id", () => {
    expect(isWellFormedBoardId("wb:room1:zoneA", "room1", "zoneA")).toBe(true);
    // Different zone / room / prefix / suffix all fail.
    expect(isWellFormedBoardId("wb:room1:zoneB", "room1", "zoneA")).toBe(false);
    expect(isWellFormedBoardId("wb:room2:zoneA", "room1", "zoneA")).toBe(false);
    expect(isWellFormedBoardId("wb:room1:zoneA:evil", "room1", "zoneA")).toBe(false);
    expect(isWellFormedBoardId("wb:room1", "room1", "zoneA")).toBe(false);
    expect(isWellFormedBoardId("", "room1", "zoneA")).toBe(false);
    expect(isWellFormedBoardId(null, "room1", "zoneA")).toBe(false);
  });
});

describe("zone visibility", () => {
  it("allows boards only in discussion zones (contract §1)", () => {
    expect(whiteboardAllowedIn("discussion")).toBe(true);
    expect(whiteboardAllowedIn("silent")).toBe(false);
    expect(whiteboardAllowedIn("rest")).toBe(false);
    expect(whiteboardAllowedIn("none")).toBe(false);
  });
});

describe("wb_update codec", () => {
  it("round-trips a wb_update", () => {
    const msg = updateMsg();
    const bytes = encodeWbUpdate(msg);
    expect(bytes[0]).toBe(0x7b); // raw JSON, like the M2 kick notice
    const dec = decodeWbMessage(bytes);
    expect(dec).toEqual({
      type: WB_UPDATE_TYPE,
      board: "wb:room1:zoneA",
      zone_id: "zoneA",
      updated_at: 1000,
      scene: SCENE,
    });
  });

  it("round-trips a wb_clear", () => {
    const msg = clearMsg();
    const dec = decodeWbMessage(encodeWbUpdate(msg));
    expect(dec).toEqual({
      type: WB_CLEAR_TYPE,
      board: "wb:room1:zoneA",
      zone_id: "zoneA",
      updated_at: 1000,
    });
  });

  it("rejects non-whiteboard JSON (kick notice, chat-shaped, garbage)", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(decodeWbMessage(enc(JSON.stringify({ type: "kick_notice", reason: "x" })))).toBeNull();
    expect(decodeWbMessage(enc(JSON.stringify({ type: "wb_update" })))).toBeNull(); // missing fields
    expect(decodeWbMessage(enc("{not json"))).toBeNull();
    expect(decodeWbMessage(new Uint8Array([2, 3, 4]))).toBeNull(); // binary tag
    expect(decodeWbMessage(new Uint8Array([]))).toBeNull();
  });

  it("rejects bad updated_at and bad scenes", () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    const base = {
      type: WB_UPDATE_TYPE,
      board: "wb:room1:zoneA",
      zone_id: "zoneA",
      scene: SCENE,
    };
    expect(decodeWbMessage(enc({ ...base, updated_at: -1 }))).toBeNull();
    expect(decodeWbMessage(enc({ ...base, updated_at: 1.5 }))).toBeNull();
    expect(decodeWbMessage(enc({ ...base, updated_at: "1000" }))).toBeNull();
    expect(decodeWbMessage(enc({ ...base, updated_at: 1000, scene: null }))).toBeNull();
    expect(decodeWbMessage(enc({ ...base, updated_at: 1000, scene: { elements: "nope" } }))).toBeNull();
    expect(decodeWbMessage(enc({ ...base, updated_at: 1000, board: "" }))).toBeNull();
  });
});

describe("LWW", () => {
  it("strictly-greater-wins; ties and older are ignored", () => {
    expect(lwwShouldApply(1000, 1001)).toBe(true);
    expect(lwwShouldApply(1000, 1000)).toBe(false); // tie → no-op
    expect(lwwShouldApply(1000, 999)).toBe(false);
    expect(lwwShouldApply(0, 1)).toBe(true); // fresh session
  });

  it("decideWbInbound ignores stale and duplicate timestamps", () => {
    const ctx = { room: "room1", myZoneId: "zoneA", localUpdatedAt: 1000, fromBlocked: false };
    expect(decideWbInbound(updateMsg({ updated_at: 1000 }), ctx)).toBe("ignore-stale");
    expect(decideWbInbound(updateMsg({ updated_at: 999 }), ctx)).toBe("ignore-stale");
    expect(decideWbInbound(updateMsg({ updated_at: 1001 }), ctx)).toBe("apply");
    expect(decideWbInbound(clearMsg({ updated_at: 1001 }), ctx)).toBe("apply");
    expect(decideWbInbound(clearMsg({ updated_at: 1000 }), ctx)).toBe("ignore-stale");
  });
});

describe("receiver filters", () => {
  const ctx = { room: "room1", myZoneId: "zoneA", localUpdatedAt: 0, fromBlocked: false };

  it("drops messages for a different zone_id", () => {
    expect(
      decideWbInbound(updateMsg({ zone_id: "zoneB", updated_at: 5 }), ctx),
    ).toBe("ignore-zone");
    // Zone-less receiver ("none") ignores everything.
    expect(
      decideWbInbound(updateMsg({ updated_at: 5 }), { ...ctx, myZoneId: "" }),
    ).toBe("ignore-zone");
  });

  it("drops malformed board ids even when zone_id matches", () => {
    expect(
      decideWbInbound(
        updateMsg({ board: "wb:room1:zoneA:evil", updated_at: 5 }),
        ctx,
      ),
    ).toBe("ignore-malformed");
    expect(decideWbInbound(null, ctx)).toBe("ignore-malformed");
  });

  it("ignores updates from block-listed senders (M2, contract §4)", () => {
    expect(
      decideWbInbound(updateMsg({ updated_at: 5 }), { ...ctx, fromBlocked: true }),
    ).toBe("ignore-blocked");
    expect(
      decideWbInbound(clearMsg({ updated_at: 5 }), { ...ctx, fromBlocked: true }),
    ).toBe("ignore-blocked");
  });

  it("block filter wins over the zone filter (checked first)", () => {
    expect(
      decideWbInbound(
        updateMsg({ zone_id: "zoneB", updated_at: 5 }),
        { ...ctx, fromBlocked: true },
      ),
    ).toBe("ignore-blocked");
  });

  it("applies a well-formed newer message", () => {
    expect(decideWbInbound(updateMsg({ updated_at: 5 }), ctx)).toBe("apply");
  });
});

describe("snapshot cap", () => {
  it("is 256 KiB; exactly the cap is OK, one byte over is refused", () => {
    expect(WHITEBOARD_MAX_SNAPSHOT_BYTES).toBe(262144);
    expect(sceneJsonOverCap("a".repeat(262144))).toBe(false);
    expect(sceneJsonOverCap("a".repeat(262145))).toBe(true);
    expect(sceneJsonOverCap("")).toBe(false);
  });

  it("measures UTF-8 bytes, not JS string length", () => {
    // "€" is 3 UTF-8 bytes: 100k chars = 300k bytes > cap.
    expect(sceneJsonOverCap("€".repeat(100_000))).toBe(true);
    expect(sceneJsonOverCap("€".repeat(10_000))).toBe(false);
  });
});

describe("broadcast scheduler (debounce + 2 Hz cap)", () => {
  /** Manual clock so the debounce is deterministic in tests. */
  function manualClock() {
    let now = 0;
    const timers = new Map<number, { cb: () => void; deadline: number }>();
    let nextId = 1;
    return {
      now: () => now,
      setTimeoutFn: (cb: () => void, _ms: number) => {
        const id = nextId++;
        timers.set(id, { cb, deadline: now + _ms });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: (id: ReturnType<typeof setTimeout>) => {
        timers.delete(id as unknown as number);
      },
      advance(ms: number) {
        now += ms;
        // Fire timers whose deadline passed, in deadline order.
        const due = [...timers.entries()]
          .filter(([, t]) => t.deadline <= now)
          .sort((a, b) => a[1].deadline - b[1].deadline || a[0] - b[0]);
        for (const [id, t] of due) {
          if (timers.delete(id)) t.cb();
        }
      },
      pendingCount: () => timers.size,
    };
  }

  it("debounce constant is 500 ms and equals the 2 Hz cap interval", () => {
    expect(WB_DEBOUNCE_MS).toBe(500);
    expect(WB_MAX_BROADCAST_HZ).toBe(2);
    expect(1000 / WB_MAX_BROADCAST_HZ).toBe(WB_DEBOUNCE_MS);
  });

  it("bursts publish at most once, carrying the latest scene", () => {
    const clock = manualClock();
    const fired: string[] = [];
    const sched = createWbBroadcastScheduler((s) => fired.push(s), WB_DEBOUNCE_MS, clock);
    sched.schedule("scene-1");
    sched.schedule("scene-2");
    sched.schedule("scene-3");
    expect(sched.pending).toBe(true);
    expect(clock.pendingCount()).toBe(1); // one timer, not three
    clock.advance(500);
    expect(fired).toEqual(["scene-3"]);
    expect(sched.pending).toBe(false);
  });

  it("a second burst after the window fires again (rate ≤ 2 Hz)", () => {
    const clock = manualClock();
    const fired: string[] = [];
    const sched = createWbBroadcastScheduler((s) => fired.push(s), WB_DEBOUNCE_MS, clock);
    sched.schedule("a");
    clock.advance(500);
    sched.schedule("b");
    clock.advance(499);
    expect(fired).toEqual(["a"]); // not yet — window restarted
    clock.advance(1);
    expect(fired).toEqual(["a", "b"]);
  });

  it("cancel() drops the pending broadcast (zone exit)", () => {
    const clock = manualClock();
    const fired: string[] = [];
    const sched = createWbBroadcastScheduler((s) => fired.push(s), WB_DEBOUNCE_MS, clock);
    sched.schedule("scene-1");
    expect(sched.pending).toBe(true);
    sched.cancel();
    expect(sched.pending).toBe(false);
    clock.advance(10_000);
    expect(fired).toEqual([]);
  });

  it("cancel() on an idle scheduler is a no-op", () => {
    const clock = manualClock();
    const sched = createWbBroadcastScheduler(() => {}, WB_DEBOUNCE_MS, clock);
    expect(() => sched.cancel()).not.toThrow();
    expect(sched.pending).toBe(false);
  });
});
