// P1-C build assertion (contract §5): `@excalidraw/excalidraw` MUST NOT
// be in the first-screen bundle. The whiteboard panel reaches Excalidraw
// only through dynamic `import()` inside `React.lazy`, so Rollup emits it
// as a separate chunk. This script fails the build if the entry chunk
// contains excalidraw code, and fails vacuously-passing builds if NO chunk
// contains it (i.e. the feature got tree-shaken away entirely).
//
// Run: `node scripts/assert-wb-lazy.mjs` (wired as `postbuild`).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const dist = resolve(process.cwd(), "dist");
const assets = join(dist, "assets");

function fail(msg) {
  console.error(`assert-wb-lazy: FAIL — ${msg}`);
  process.exit(1);
}

if (!existsSync(assets)) fail(`dist/assets not found (run vite build first)`);

const indexHtml = join(dist, "index.html");
if (!existsSync(indexHtml)) fail("dist/index.html not found");
const html = readFileSync(indexHtml, "utf8");

// Entry chunks: module scripts referenced by index.html (relative paths).
const entryFiles = [...html.matchAll(/<script[^>]*src="([^"]+\.js)"/g)]
  .map((m) => m[1].replace(/^\//, ""))
  .map((rel) => join(dist, rel));
if (entryFiles.length === 0) fail("no entry <script> found in dist/index.html");

// Library markers: export names of @excalidraw/excalidraw that survive
// minification in the chunk's export statement. A bare /excalidraw/i is
// too loose — app code legitimately mentions `excalidrawAPI` (the prop)
// and "Loading whiteboard…" while the library stays lazy.
const LIB_MARKERS = [
  "convertToExcalidrawElements",
  "LiveCollaborationTrigger",
  "restoreElements",
];
const hasLibrary = (src) => LIB_MARKERS.some((m) => src.includes(m));
const jsFiles = readdirSync(assets)
  .filter((f) => f.endsWith(".js"))
  .map((f) => join(assets, f));

let chunksWithExcalidraw = [];
for (const file of jsFiles) {
  const src = readFileSync(file, "utf8");
  if (hasLibrary(src)) chunksWithExcalidraw.push(file);
}

// 1. No entry chunk may contain the excalidraw library.
for (const entry of entryFiles) {
  const src = readFileSync(entry, "utf8");
  if (hasLibrary(src)) {
    fail(
      `@excalidraw/excalidraw is in the first-screen entry chunk ${entry}. ` +
        `The panel must load it via React.lazy + dynamic import() only.`,
    );
  }
}

// 2. Sanity: the lazy chunk must exist (feature not tree-shaken away).
if (chunksWithExcalidraw.length === 0) {
  fail(
    "no chunk contains excalidraw — the whiteboard feature may have been " +
      "tree-shaken away entirely.",
  );
}

console.log(
  `assert-wb-lazy: PASS — entry chunk has no excalidraw; ` +
    `${chunksWithExcalidraw.length} lazy chunk(s) carry it: ` +
    chunksWithExcalidraw.map((f) => f.split("/").pop()).join(", "),
);
