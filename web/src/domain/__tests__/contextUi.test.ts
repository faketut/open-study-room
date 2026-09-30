import { describe, expect, it } from "vitest";
import {
  NEARBY_PERSON_RADIUS,
  contextSuiteFor,
  desktopHintFor,
  nearestPeerWithinRadius,
  shouldShowMicWarning,
  touchActionFor,
  type ContextState,
} from "../contextUi";
import type { TouchAction } from "../touchActions";

/** Base idle state; each case overrides what it needs. */
function idle(): ContextState {
  return {
    seated: false,
    nearbyBoardIndex: null,
    nearbyNoteIndex: null,
    nearbyTable: null,
    nearbyPersonIdentity: null,
    silentZone: false,
  };
}

describe("contextSuiteFor — priority order", () => {
  it("seated（会议套装）优先于一切", () => {
    const s = idle();
    s.seated = true;
    s.nearbyBoardIndex = 1;
    s.nearbyNoteIndex = 2;
    s.nearbyTable = "t1";
    s.nearbyPersonIdentity = "peer-a";
    expect(contextSuiteFor(s)).toBe("meeting");
  });

  it("board 优先于 note（与 F 键一致）", () => {
    const s = idle();
    s.nearbyBoardIndex = 3;
    s.nearbyNoteIndex = 5;
    expect(contextSuiteFor(s)).toBe("object");
  });

  it("只有 note 也是对象套装", () => {
    const s = idle();
    s.nearbyNoteIndex = 5;
    expect(contextSuiteFor(s)).toBe("object");
  });

  it("对象套装优先于桌子套装", () => {
    const s = idle();
    s.nearbyNoteIndex = 5;
    s.nearbyTable = "t1";
    expect(contextSuiteFor(s)).toBe("object");
  });

  it("nearbyTable（站立）→ 入座套装", () => {
    const s = idle();
    s.nearbyTable = "t1";
    expect(contextSuiteFor(s)).toBe("sit");
  });

  it("桌子套装优先于人物套装", () => {
    const s = idle();
    s.nearbyTable = "t1";
    s.nearbyPersonIdentity = "peer-a";
    expect(contextSuiteFor(s)).toBe("sit");
  });

  it("无人无物 → 人物套装", () => {
    const s = idle();
    s.nearbyPersonIdentity = "peer-a";
    expect(contextSuiteFor(s)).toBe("person");
  });

  it("全空 → idle", () => {
    expect(contextSuiteFor(idle())).toBe("idle");
  });
});

describe("PTT 正交", () => {
  it("silentZone 不改变任何套装判定", () => {
    const suites: Array<Partial<ContextState>> = [
      { seated: true },
      { nearbyBoardIndex: 1 },
      { nearbyNoteIndex: 2 },
      { nearbyTable: "t1" },
      { nearbyPersonIdentity: "peer-a" },
      {},
    ];
    for (const patch of suites) {
      const base = contextSuiteFor({ ...idle(), ...patch });
      const withPtt = contextSuiteFor({
        ...idle(),
        ...patch,
        silentZone: true,
      });
      expect(withPtt).toBe(base);
    }
  });
});

describe("touch/desktop parity", () => {
  it("touch action 与 suite 在 1–3 套装上一致", () => {
    const cases: Array<[ContextState, TouchAction | null]> = [
      [{ ...idle(), seated: true }, "stand"],
      [{ ...idle(), nearbyBoardIndex: 1 }, "board"],
      [{ ...idle(), nearbyNoteIndex: 2 }, "note"],
      [{ ...idle(), nearbyBoardIndex: 1, nearbyNoteIndex: 2 }, "board"],
      [{ ...idle(), nearbyTable: "t1" }, "sit"],
      // 人物/idle 套装没有 touch action（人物套装用卡片按钮）
      [{ ...idle(), nearbyPersonIdentity: "peer-a" }, null],
      [idle(), null],
    ];
    for (const [state, action] of cases) {
      expect(touchActionFor(state)).toBe(action);
    }
  });

  it("desktopHintFor 只给有按键的套装返回提示", () => {
    expect(desktopHintFor("meeting")).toEqual({ key: "E", label: "Stand up" });
    expect(desktopHintFor("object")).toEqual({ key: "F", label: "Open" });
    expect(desktopHintFor("sit")).toEqual({ key: "E", label: "Sit down" });
    expect(desktopHintFor("person")).toBeNull();
    expect(desktopHintFor("idle")).toBeNull();
  });
});

describe("nearestPeerWithinRadius", () => {
  it("NEARBY_PERSON_RADIUS 为 96", () => {
    expect(NEARBY_PERSON_RADIUS).toBe(96);
  });

  it("返回半径内最近的 peer", () => {
    const peers = [
      { identity: "far", x: 80, y: 0 },
      { identity: "near", x: 30, y: 40 }, // 距离 50
      { identity: "out", x: 200, y: 0 },
    ];
    const hit = nearestPeerWithinRadius(0, 0, peers);
    expect(hit?.identity).toBe("near");
    expect(hit?.distance).toBeCloseTo(50, 5);
  });

  it("半径内无人 → null", () => {
    const peers = [{ identity: "out", x: 200, y: 0 }];
    expect(nearestPeerWithinRadius(0, 0, peers)).toBeNull();
  });

  it("空 peer 列表 → null", () => {
    expect(nearestPeerWithinRadius(0, 0, [])).toBeNull();
  });

  it("边界：恰好等于半径算在内", () => {
    const peers = [{ identity: "edge", x: NEARBY_PERSON_RADIUS, y: 0 }];
    expect(nearestPeerWithinRadius(0, 0, peers)?.identity).toBe("edge");
  });

  it("支持自定义半径", () => {
    const peers = [{ identity: "p", x: 50, y: 0 }];
    expect(nearestPeerWithinRadius(0, 0, peers, 40)).toBeNull();
    expect(nearestPeerWithinRadius(0, 0, peers, 60)?.identity).toBe("p");
  });
});

describe("shouldShowMicWarning (UI refinements §2)", () => {
  it("hidden when mic is not denied", () => {
    expect(shouldShowMicWarning(false, "discussion", false)).toBe(false);
    expect(shouldShowMicWarning(false, "silent", true)).toBe(false);
  });
  it("hidden in silent zone when just studying (denied, no attempt)", () => {
    expect(shouldShowMicWarning(true, "silent", false)).toBe(false);
  });
  it("hidden outside zones when just studying (denied, no attempt)", () => {
    expect(shouldShowMicWarning(true, "none", false)).toBe(false);
  });
  it("shown in discussion zone when denied", () => {
    expect(shouldShowMicWarning(true, "discussion", false)).toBe(true);
  });
  it("shown in rest zone when denied", () => {
    expect(shouldShowMicWarning(true, "rest", false)).toBe(true);
  });
  it("shown after an unmute attempt even in silent zone", () => {
    expect(shouldShowMicWarning(true, "silent", true)).toBe(true);
  });
  it("shown after an unmute attempt outside zones", () => {
    expect(shouldShowMicWarning(true, "none", true)).toBe(true);
  });
});
