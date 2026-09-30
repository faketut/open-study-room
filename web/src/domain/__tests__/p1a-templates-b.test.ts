// P1-A template pack, worker B: self-validation of the three authored
// template files (library, night-owl, cafe). Reads the JSON files from
// assets/templates/ and asserts validateTemplate returns zero errors.
import { describe, expect, it } from "vitest";
// NOTE: @types/node is not installed in this repo, so the node: builtin
// imports below cannot resolve types (TS2307). They are correct at runtime
// (vitest runs on node); the directives below keep `tsc -b` clean without
// touching shared tsconfig or adding dependencies.
// @ts-expect-error node:fs has no type declarations here (@types/node absent)
import { existsSync, readFileSync } from "node:fs";
// @ts-expect-error node:path has no type declarations here (@types/node absent)
import { dirname, join } from "node:path";
// @ts-expect-error node:url has no type declarations here (@types/node absent)
import { fileURLToPath } from "node:url";
import { validateTemplate } from "../mapTemplate";

// web/src/domain/__tests__/ -> up 4 = repo root -> assets/templates/
const TEMPLATES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "assets",
  "templates",
);

const TEMPLATE_IDS = ["library", "night-owl", "cafe"] as const;

describe("P1-A template pack (worker B)", () => {
  for (const id of TEMPLATE_IDS) {
    it(`${id}.json validates with zero errors`, () => {
      const file = join(TEMPLATES_DIR, `${id}.json`);
      expect(existsSync(file)).toBe(true);
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      // id must match the file name (contracts.md §2)
      expect(
        (raw as { template?: { id?: unknown } }).template?.id,
      ).toBe(id);
      const { errors, warnings } = validateTemplate(raw);
      if (errors.length > 0) {
        console.log(`${id} errors:`, errors);
      }
      expect(errors).toEqual([]);
      // warnings are non-blocking; surface them for the author
      if (warnings.length > 0) {
        console.log(`${id} warnings:`, warnings);
      }
    });
  }
});
