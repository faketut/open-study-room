import { describe, expect, it } from "vitest";
// NOTE: @types/node is not installed in this repo (same convention as
// p1a-templates-b.test.ts), so the node: builtin imports below cannot
// resolve types (TS2307). They are correct at runtime (vitest runs on
// node); the directives below keep `tsc -b` clean without touching shared
// tsconfig or adding dependencies.
// @ts-expect-error node:child_process has no type declarations here (@types/node absent)
import { spawnSync } from "node:child_process";
// @ts-expect-error node:fs has no type declarations here (@types/node absent)
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
// @ts-expect-error node:os has no type declarations here (@types/node absent)
import { tmpdir } from "node:os";
// @ts-expect-error node:path has no type declarations here (@types/node absent)
import { dirname, join, resolve } from "node:path";
// @ts-expect-error node:url has no type declarations here (@types/node absent)
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ -> domain -> src -> web -> repo root, then scripts/.
const repoRoot = resolve(here, "..", "..", "..", "..");
const script = join(repoRoot, "scripts", "gen-template-registry.mjs");

function templateFile(id: string, withThumbnail: boolean): string {
  return JSON.stringify(
    {
      template: {
        id,
        name: { en: `${id} en`, zh: `${id} 中文` },
        description: { en: `${id} desc en.`, zh: `${id} 描述。` },
        ...(withThumbnail ? { thumbnail: `thumbnails/${id}.png` } : {}),
      },
      map_name: id,
      width: 400,
      height: 300,
      background_color: "#2b2f3a",
      objects: [],
      spawn_points: [{ x: 10, y: 10 }],
    },
    null,
    2,
  );
}

function runScript(dir: string): { code: number; stderr: string } {
  const r = spawnSync("node", [script, "--dir", dir], { encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stderr: r.stderr ?? "" };
}

describe("scripts/gen-template-registry.mjs", () => {
  it("generates a correctly-shaped registry.json, skips bad files, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "templates-"));
    try {
      writeFileSync(join(dir, "library.json"), templateFile("library", true));
      writeFileSync(join(dir, "cafe.json"), templateFile("cafe", false));
      // Bad files the script must skip (with a warning), not die on.
      writeFileSync(join(dir, "broken.json"), "{ not json");
      writeFileSync(join(dir, "no-block.json"), JSON.stringify({ map_name: "x" }));
      writeFileSync(join(dir, "mismatch.json"), templateFile("different-id", false));
      writeFileSync(join(dir, "bad-name.json"), JSON.stringify({
        template: { id: "bad-name", name: { en: "x" }, description: { en: "d", zh: "描" } },
      }));
      // A stale registry.json from a previous hand-edit must be regenerated.
      writeFileSync(join(dir, "registry.json"), JSON.stringify({ templates: [{ id: "stale" }] }));

      const first = runScript(dir);
      expect(first.code).toBe(0);
      expect(first.stderr).toContain("broken.json");

      const registry = JSON.parse(readFileSync(join(dir, "registry.json"), "utf8"));
      expect(Object.keys(registry)).toEqual(["templates"]);
      expect(registry.templates).toHaveLength(2);
      // Sorted by id for determinism.
      expect(registry.templates.map((t: { id: string }) => t.id)).toEqual(["cafe", "library"]);
      // Exact entry shape: { id, name, description, thumbnail?, url }.
      expect(registry.templates[0]).toEqual({
        id: "cafe",
        name: { en: "cafe en", zh: "cafe 中文" },
        description: { en: "cafe desc en.", zh: "cafe 描述。" },
        url: "/templates/cafe.json",
      });
      expect(registry.templates[1]).toEqual({
        id: "library",
        name: { en: "library en", zh: "library 中文" },
        description: { en: "library desc en.", zh: "library 描述。" },
        thumbnail: "thumbnails/library.png",
        url: "/templates/library.json",
      });
      // Stale content is gone, not merged.
      expect(registry.templates.some((t: { id: string }) => t.id === "stale")).toBe(false);

      // Idempotent: a second run produces byte-identical output.
      const before = readFileSync(join(dir, "registry.json"), "utf8");
      const second = runScript(dir);
      expect(second.code).toBe(0);
      expect(readFileSync(join(dir, "registry.json"), "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 without writing when the templates dir does not exist", () => {
    const missing = join(tmpdir(), `templates-missing-${Date.now()}`);
    const r = runScript(missing);
    expect(r.code).toBe(0);
  });

  it("writes an empty registry when the dir exists but has no template files", () => {
    const dir = mkdtempSync(join(tmpdir(), "templates-empty-"));
    try {
      const r = runScript(dir);
      expect(r.code).toBe(0);
      const registry = JSON.parse(readFileSync(join(dir, "registry.json"), "utf8"));
      expect(registry).toEqual({ templates: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
