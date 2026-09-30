import { describe, it, expect } from "vitest";
import {
  containsProfanity,
  maskProfanity,
  patternForWord,
  SENSITIVE_WORDS,
} from "../profanityFilter";

// Fixture mirrors the contract's match-rule examples: Latin entries match
// on word boundaries, CJK entries match as substrings.
const WORDS = ["ass", "damn", "垃圾", "f-word"];

describe("profanity filter match rule", () => {
  it("matches Latin entries case-insensitively", () => {
    expect(containsProfanity("you are an ASS", WORDS)).toBe(true);
    expect(containsProfanity("DaMn it", WORDS)).toBe(true);
  });

  it("matches Latin entries only on word boundaries (no false positives)", () => {
    // Contract's canonical example: `class` must not trip on `ass`.
    expect(containsProfanity("this is a class", WORDS)).toBe(false);
    expect(containsProfanity("dumbass move", WORDS)).toBe(false);
    expect(containsProfanity("assassin", WORDS)).toBe(false);
    expect(containsProfanity("damnation", WORDS)).toBe(false);
    // But standalone hits still fire.
    expect(containsProfanity("what an ass", WORDS)).toBe(true);
    expect(containsProfanity("ass!", WORDS)).toBe(true);
    expect(containsProfanity("(damn)", WORDS)).toBe(true);
  });

  it("matches CJK entries as substrings", () => {
    expect(containsProfanity("这是垃圾信息", WORDS)).toBe(true);
    expect(containsProfanity("别发垃圾", WORDS)).toBe(true);
    expect(containsProfanity("这是正常发言", WORDS)).toBe(false);
  });

  it("returns false for clean text and empty lists", () => {
    expect(containsProfanity("hello world", WORDS)).toBe(false);
    expect(containsProfanity("", WORDS)).toBe(false);
    expect(containsProfanity("you ass", [])).toBe(false);
  });

  it("ignores empty entries in the list", () => {
    expect(containsProfanity("hello", ["", "  "])).toBe(false);
  });

  it("builds anchored patterns for Latin and substring patterns for CJK", () => {
    expect(patternForWord("ass").source).toContain("(?<![A-Za-z0-9_])");
    expect(patternForWord("垃圾").source).toBe("垃圾");
  });
});

describe("real wordlist (generated copy of the server source)", () => {
  it("is populated from the synced source", () => {
    expect(SENSITIVE_WORDS.length).toBeGreaterThan(0);
  });

  it("matches the contract's canonical boundary examples", () => {
    // "class" must not trip on "ass" (contract §4).
    expect(containsProfanity("this is a class", SENSITIVE_WORDS)).toBe(false);
    expect(containsProfanity("you ass", SENSITIVE_WORDS)).toBe(true);
    expect(containsProfanity("FUCK", SENSITIVE_WORDS)).toBe(true);
  });

  it("catches CJK entries as substrings", () => {
    const cjkHit = SENSITIVE_WORDS.some((w) => /[\u2e80-\u9fff]/.test(w));
    expect(cjkHit).toBe(true);
    const cjkWord = SENSITIVE_WORDS.find((w) => /[\u2e80-\u9fff]/.test(w))!;
    expect(containsProfanity(`前缀${cjkWord}后缀`, SENSITIVE_WORDS)).toBe(true);
    expect(maskProfanity(`前缀${cjkWord}后缀`, SENSITIVE_WORDS)).toBe(
      `前缀${"*".repeat(cjkWord.length)}后缀`,
    );
  });
});
describe("profanity mask", () => {
  it("replaces each hit with * repeated to the word's length", () => {
    expect(maskProfanity("you ass", WORDS)).toBe("you ***");
    expect(maskProfanity("DAMN it", WORDS)).toBe("**** it");
    expect(maskProfanity("这是垃圾信息", WORDS)).toBe("这是**信息");
  });

  it("masks multiple hits in one pass", () => {
    expect(maskProfanity("ass and damn", WORDS)).toBe("*** and ****");
  });

  it("leaves clean text untouched", () => {
    const clean = "this is a class about brass";
    expect(maskProfanity(clean, WORDS)).toBe(clean);
  });

  it("is a no-op with an empty word list", () => {
    expect(maskProfanity("you ass", [])).toBe("you ass");
  });
});
