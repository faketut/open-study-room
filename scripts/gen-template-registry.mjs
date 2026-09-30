#!/usr/bin/env node
// Generates `assets/templates/registry.json` from the template files in
// `assets/templates/*.json` (contracts.md "Map templates" §4.2).
//
// This script is the ONLY writer of registry.json — never hand-edit that
// file; re-run this script instead. Idempotent and safe to re-run: entries
// are sorted by id and re-derived from scratch every run, so a re-run after
// template authors add/remove/fix files always converges on the correct
// registry.
//
// Test hook: `node scripts/gen-template-registry.mjs --dir <path>` scans an
// arbitrary directory instead of `assets/templates/` (used by tests).

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const dirFlag = process.argv.indexOf("--dir");
const templatesDir =
  dirFlag >= 0 && process.argv[dirFlag + 1]
    ? resolve(process.argv[dirFlag + 1])
    : join(repoRoot, "assets", "templates");

const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isLangMap(v) {
  return (
    v != null &&
    typeof v === "object" &&
    typeof v.en === "string" &&
    v.en.length > 0 &&
    typeof v.zh === "string" &&
    v.zh.length > 0
  );
}

if (!existsSync(templatesDir)) {
  console.log("[gen-template-registry] no templates dir, nothing to do");
  process.exit(0);
}

const files = (await readdir(templatesDir))
  .filter((f) => f.endsWith(".json") && f !== "registry.json")
  .sort();

const entries = [];
for (const file of files) {
  const full = join(templatesDir, file);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(full, "utf8"));
  } catch (e) {
    console.warn(`[gen-template-registry] skip ${file}: invalid JSON (${e.message})`);
    continue;
  }
  const t = parsed != null && typeof parsed === "object" ? parsed.template : undefined;
  if (t == null || typeof t !== "object") {
    console.warn(`[gen-template-registry] skip ${file}: missing "template" block`);
    continue;
  }
  // Contract §2: id is kebab-case AND must equal the file name (<id>.json),
  // so the registry url can be frozen as /templates/<id>.json.
  if (typeof t.id !== "string" || !KEBAB_CASE_RE.test(t.id) || `${t.id}.json` !== file) {
    console.warn(
      `[gen-template-registry] skip ${file}: id "${t.id}" must be kebab-case and match the file name (<id>.json)`,
    );
    continue;
  }
  if (!isLangMap(t.name) || !isLangMap(t.description)) {
    console.warn(
      `[gen-template-registry] skip ${file}: "template.name"/"template.description" must be { en, zh } non-empty strings`,
    );
    continue;
  }
  const entry = {
    id: t.id,
    name: { en: t.name.en, zh: t.name.zh },
    description: { en: t.description.en, zh: t.description.zh },
  };
  if (typeof t.thumbnail === "string" && t.thumbnail.length > 0) {
    entry.thumbnail = t.thumbnail;
  }
  entry.url = `/templates/${t.id}.json`;
  entries.push(entry);
}

// Sort by id for a deterministic, diff-friendly file.
entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const out = join(templatesDir, "registry.json");
await writeFile(out, `${JSON.stringify({ templates: entries }, null, 2)}\n`);
console.log(`[gen-template-registry] wrote ${out} (${entries.length} template(s))`);
