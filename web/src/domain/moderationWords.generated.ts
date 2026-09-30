/**
 * Minimal sensitive-word list (M2).
 *
 * This file is the SINGLE source of truth for the sensitive-word filter.
 * The web build copies it byte-identically to
 * `web/src/data/moderationWords.ts` at build time (prebuild step), and a
 * repo-level test asserts the copy never drifts.
 *
 * Match rule (normative, docs/contracts.md §4):
 * - Latin entries match case-insensitively on WORD BOUNDARIES, so e.g.
 *   "class" does NOT trip on "ass".
 * - CJK entries match as substrings.
 *
 * `containsProfanity` is used server-side to reject nicknames
 * (`400 { error: "nickname_rejected" }`, no matched word echoed back) and
 * client-side (pre-send) to mask chat content.
 */

/** Latin entries: matched case-insensitively on word boundaries. */
export const LATIN_WORDS = [
  "ass",
  "asshole",
  "bastard",
  "bitch",
  "cunt",
  "dick",
  "fuck",
  "shit",
  "slut",
  "whore",
];

/** CJK entries: matched as substrings. */
export const CJK_WORDS = [
  "傻逼",
  "操你妈",
  "草你妈",
  "草泥马",
  "贱人",
  "王八蛋",
  "狗日的",
  "滚犊子",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const latinPattern = new RegExp(
  `\\b(?:${LATIN_WORDS.map(escapeRegExp).join("|")})\\b`,
  "i",
);

/** True when `text` contains any sensitive word per the match rule above. */
export function containsProfanity(text: string): boolean {
  if (latinPattern.test(text)) return true;
  return CJK_WORDS.some((w) => text.includes(w));
}
