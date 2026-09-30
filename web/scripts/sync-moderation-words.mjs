// M2 moderation wordlist sync.
//
// `server/src/moderation/words.ts` is the single source of truth for the
// sensitive-word list (docs/contracts.md, M2 §4 "Source sync (normative)").
// This script copies it byte-identical to
// `web/src/domain/moderationWords.generated.ts` so the web client's
// pre-send chat mask and join-screen nickname hint use exactly the same
// list as the server's nickname validation.
//
// A repo-level drift test (`web/src/domain/__tests__/moderationWords.drift.test.ts`)
// asserts the generated copy stays byte-identical to the source.
//
// While the server M2 has not landed `server/src/moderation/words.ts`, the
// script warns and leaves the generated stub in place (exit 0) so
// `prebuild` stays green; the web filters are inert until the list lands.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// web/scripts -> repo root
const repoRoot = join(here, "..", "..");
const source = join(repoRoot, "server", "src", "moderation", "words.ts");
const dest = join(here, "..", "src", "domain", "moderationWords.generated.ts");

if (!existsSync(source)) {
  console.warn(
    `[sync-moderation-words] source not found: ${source}\n` +
      "  The server M2 has not landed the wordlist yet; leaving the generated stub in place.",
  );
  process.exit(0);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(source, dest);
console.log(`[sync-moderation-words] synced ${source} -> ${dest}`);
