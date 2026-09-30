// Copies shared world assets from the repo-root `assets/` folder into web/public/
// so Vite can serve them at `/map_config.json`, `/room1.jpg`, and `/sprites/*`.
// Keeping a single source of truth (the top-level assets dir) avoids drift.
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, "..");
const assetsDir = resolve(webDir, "..", "assets");
const publicDir = resolve(webDir, "public");
const spritesSrc = resolve(assetsDir, "sprites");
const spritesDst = resolve(publicDir, "sprites");
const templatesSrc = resolve(assetsDir, "templates");
const templatesDst = resolve(publicDir, "templates");

// Top-level public files (served at `/<name>`).
const topLevel = ["map_config.json", "room1.jpg"];

await mkdir(publicDir, { recursive: true });
for (const name of topLevel) {
  const src = resolve(assetsDir, name);
  const dst = resolve(publicDir, name);
  if (!existsSync(src)) {
    console.error(`[sync-assets] missing source: ${src}`);
    process.exit(1);
  }
  await cp(src, dst);
  console.log(`[sync-assets] ${name}`);
}

// Pixel-art sprite tree (mirrors `assets/sprites/` 1:1 so
// `chars/char_07.png` resolves under `/sprites/chars/char_07.png`).
if (!existsSync(spritesSrc)) {
  console.error(`[sync-assets] missing sprites dir: ${spritesSrc}`);
  process.exit(1);
}
await cp(spritesSrc, spritesDst, { recursive: true });
console.log(`[sync-assets] sprites/ -> public/sprites/`);

// Painted map backgrounds (mirrors `assets/backgrounds/` 1:1 so
// `library-painted.jpg` resolves under `/backgrounds/library-painted.jpg`).
// Optional like templates/: a missing dir is a skip, not an error.
const backgroundsSrc = resolve(assetsDir, "backgrounds");
const backgroundsDst = resolve(publicDir, "backgrounds");
if (!existsSync(backgroundsSrc)) {
  console.log(`[sync-assets] no backgrounds dir, skipping`);
} else {
  await cp(backgroundsSrc, backgroundsDst, { recursive: true });
  console.log(`[sync-assets] backgrounds/ -> public/backgrounds/`);
}

// P1-A map templates (contracts.md "Map templates"). Optional: template
// authors create assets/templates/ later, so a missing dir is a skip, not
// an error (unlike map_config.json / sprites above).
if (!existsSync(templatesSrc)) {
  console.log(`[sync-assets] no templates dir, skipping`);
} else {
  await cp(templatesSrc, templatesDst, { recursive: true });
  console.log(`[sync-assets] templates/ -> public/templates/`);
}
