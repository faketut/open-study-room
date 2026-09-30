import { describe, expect, it } from "vitest";
import { validateTemplate } from "../mapTemplate";
// Static JSON imports (tsconfig has resolveJsonModule; this keeps the test
// free of node: builtins, which web/tsconfig.json does not type).
import examSprint from "../../../../assets/templates/exam-sprint.json";
import welcome from "../../../../assets/templates/welcome.json";

/** Worker C (P1-A): exam-sprint + welcome templates.
 *
 * Asserts each authored template validates with zero errors (warnings are
 * non-blocking authoring nudges and are allowed).
 */
describe("p1a-templates-c", () => {
  const cases = { "exam-sprint": examSprint, welcome } as const;
  for (const [id, raw] of Object.entries(cases)) {
    it(`${id}: validates with zero errors`, () => {
      const { errors, warnings } = validateTemplate(raw);
      if (warnings.length > 0) {
        // surfaced for visibility only; non-blocking per the contract
        console.log(`${id} warnings:`, warnings);
      }
      expect(errors).toEqual([]);
    });
  }
});
