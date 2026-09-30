import { describe, it, expect } from "vitest";
import {
  decodeKickNotice,
  isReportReason,
  moderationErrorMessage,
  REPORT_DETAIL_MAX_LEN,
  REPORT_REASON_LABELS,
  REPORT_REASONS,
} from "../moderation";

describe("kick notice decode", () => {
  const notice = (reason: string) =>
    new TextEncoder().encode(
      JSON.stringify({ type: "kick_notice", reason }),
    );

  it("decodes the contract's JSON notice", () => {
    expect(decodeKickNotice(notice("反复刷屏"))).toBe("反复刷屏");
    expect(decodeKickNotice(notice(""))).toBe("");
  });

  it("rejects non-notice payloads", () => {
    const enc = new TextEncoder();
    // Chat binary tag.
    expect(decodeKickNotice(enc.encode("2:hi"))).toBeNull();
    // JSON but not a kick notice.
    expect(decodeKickNotice(enc.encode('{"type":"other"}'))).toBeNull();
    // Corrupt bytes.
    expect(decodeKickNotice(new Uint8Array([0x7b, 0xff, 0xff]))).toBeNull();
    expect(decodeKickNotice(new Uint8Array([]))).toBeNull();
  });
});

describe("report reasons", () => {
  it("matches the reports table contract enum", () => {
    expect(REPORT_REASONS).toEqual(["spam", "harassment", "nsfw", "other"]);
    expect(Object.keys(REPORT_REASON_LABELS)).toHaveLength(4);
    expect(isReportReason("spam")).toBe(true);
    expect(isReportReason("abuse")).toBe(false);
  });

  it("caps detail at 500 chars", () => {
    expect(REPORT_DETAIL_MAX_LEN).toBe(500);
  });
});

describe("moderation error messages", () => {
  it("maps known error codes to human text that names the code", () => {
    expect(moderationErrorMessage("not_host")).toContain("host");
    expect(moderationErrorMessage("not_host")).toContain("(not_host)");
    expect(moderationErrorMessage("member_not_found")).toContain("member");
    expect(moderationErrorMessage("kicked")).toContain("removed");
  });

  it("falls back to a generic message naming the code", () => {
    expect(moderationErrorMessage("weird_code")).toBe(
      "Request failed. (weird_code)",
    );
    expect(moderationErrorMessage("")).toBe("Request failed.");
  });
});
