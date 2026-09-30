// Sensitive-word filter shared by chat pre-send masking and the
// join-screen nickname pre-validation (M2 §4).
//
// Match rule (verbatim from docs/contracts.md): case-insensitive; Latin
// entries match on word boundaries (so `class` does not trip on `ass`);
// CJK entries match as substrings.
//
// The word list itself lives in the generated module
// `moderationWords.generated.ts` — a build-time byte-identical copy of
// `server/src/moderation/words.ts` (the single source of truth), produced
// by `web/scripts/sync-moderation-words.mjs`. The generated module exports
// `LATIN_WORDS` (word-boundary entries) and `CJK_WORDS` (substring
// entries); if the server ever renames those exports, tsc fails loudly at
// build time — an intentional second drift signal on top of the
// byte-identity test.

import { CJK_WORDS, LATIN_WORDS } from "./moderationWords.generated";

/** The active word list (generated copy of the server source). */
export const SENSITIVE_WORDS: readonly string[] = [
  ...LATIN_WORDS,
  ...CJK_WORDS,
];

/** True when `word` contains any CJK character — such entries match as
 *  substrings; everything else matches on word boundaries. */
function isCjkEntry(word: string): boolean {
  return /[\u2e80-\u9fff]/.test(word);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the match pattern for one word-list entry per the contract rule. */
export function patternForWord(word: string): RegExp {
  const escaped = escapeRegex(word);
  if (isCjkEntry(word)) {
    return new RegExp(escaped, "gi");
  }
  // ASCII word boundaries: `class` must not trip on `ass`.
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "gi");
}

/** True when `text` contains any word from the list. Pure for tests. */
export function containsProfanity(
  text: string,
  words: readonly string[] = SENSITIVE_WORDS,
): boolean {
  for (const w of words) {
    if (w.length === 0) continue;
    if (patternForWord(w).test(text)) return true;
  }
  return false;
}

/**
 * Replace every matched word with `*` repeated to the matched length
 * (contract §4: "the sender replaces each matched word with `*` repeated
 * to the word's length"). Applied pre-send in ChatPanel. Pure for tests.
 */
export function maskProfanity(
  text: string,
  words: readonly string[] = SENSITIVE_WORDS,
): string {
  let out = text;
  for (const w of words) {
    if (w.length === 0) continue;
    const re = patternForWord(w);
    out = out.replace(re, (m) => "*".repeat(m.length));
  }
  return out;
}
