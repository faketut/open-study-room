import { describe, it, expect } from "vitest";
// Raw-text imports: the drift check compares file *bytes*, not modules.
// `vite/client` types declare `*?raw`. If the server source is ever
// deleted, this import fails and the test fails loudly — correct, since
// the contract names `server/src/moderation/words.ts` the single source
// of truth.
import generatedRaw from "../moderationWords.generated.ts?raw";
import sourceRaw from "../../../../server/src/moderation/words.ts?raw";

// Drift test (contract M2 §4 "Source sync (normative)"):
// `web/src/domain/moderationWords.generated.ts` must be byte-identical to
// `server/src/moderation/words.ts` so the web client's pre-send chat mask
// and join-screen nickname hint use exactly the same list as the server's
// nickname validation. `web/scripts/sync-moderation-words.mjs` produces
// the copy at build time.

describe("moderation wordlist drift", () => {
  it("generated copy is byte-identical to the server source", () => {
    expect(generatedRaw).toBe(sourceRaw);
  });
});
