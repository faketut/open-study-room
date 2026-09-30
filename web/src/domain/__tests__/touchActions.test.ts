import { describe, expect, it } from "vitest";
import { interactActionFor } from "../touchActions";

describe("interactActionFor", () => {
  it("board 优先于 note（与 F 键一致），即使三者都在附近", () => {
    expect(
      interactActionFor({
        nearbyBoardIndex: 3,
        nearbyNoteIndex: 5,
        nearbyTable: "t1",
        seated: false,
      }),
    ).toBe("board");
  });

  it("只有 note 时返回 note", () => {
    expect(
      interactActionFor({
        nearbyBoardIndex: null,
        nearbyNoteIndex: 5,
        nearbyTable: null,
        seated: false,
      }),
    ).toBe("note");
  });

  it("只有 board 时返回 board", () => {
    expect(
      interactActionFor({
        nearbyBoardIndex: 0,
        nearbyNoteIndex: null,
        nearbyTable: null,
        seated: false,
      }),
    ).toBe("board");
  });

  it("note 和桌子都在附近时 note 优先（F 语义先于 E 语义）", () => {
    expect(
      interactActionFor({
        nearbyBoardIndex: null,
        nearbyNoteIndex: 5,
        nearbyTable: "t1",
        seated: false,
      }),
    ).toBe("note");
  });

  it("只有桌子在附近时返回 sit", () => {
    expect(
      interactActionFor({
        nearbyBoardIndex: null,
        nearbyNoteIndex: null,
        nearbyTable: "t1",
        seated: false,
      }),
    ).toBe("sit");
  });

  it("什么都不在附近时返回 null（按钮隐藏）", () => {
    expect(
      interactActionFor({
        nearbyBoardIndex: null,
        nearbyNoteIndex: null,
        nearbyTable: null,
        seated: false,
      }),
    ).toBeNull();
  });

  it("已坐下时返回 stand（与 E 键 toggle 语义一致）", () => {
    expect(
      interactActionFor({
        nearbyBoardIndex: null,
        nearbyNoteIndex: null,
        nearbyTable: "t1",
        seated: true,
      }),
    ).toBe("stand");
  });

  it("已坐下时即使 board/note 在附近也只返回 stand", () => {
    expect(
      interactActionFor({
        nearbyBoardIndex: 3,
        nearbyNoteIndex: 5,
        nearbyTable: "t1",
        seated: true,
      }),
    ).toBe("stand");
  });
});
