#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";

const repoRoot = resolve(import.meta.dirname, "..");
const catalogPath = join(repoRoot, "android-companion", "app", "src", "main", "assets", "jcc_catalog.json");
const iconDir = join(repoRoot, "android-companion", "app", "src", "main", "assets", "champion_icons");
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "http://127.0.0.1:10808";

async function main() {
  if (!existsSync(catalogPath)) throw new Error(`missing catalog: ${catalogPath}`);
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  await mkdir(iconDir, { recursive: true });
  let downloaded = 0;
  let existing = 0;
  let failed = 0;
  for (const hero of catalog.heroes) {
    if (!hero.icon_url) continue;
    const out = join(iconDir, `${hero.id}.png`);
    if (existsSync(out)) {
      existing += 1;
      continue;
    }
    const result = spawnSync("curl.exe", [
      "-L",
      "--proxy",
      proxy,
      "--retry",
      "2",
      "--retry-delay",
      "1",
      "-sS",
      "-o",
      out,
      hero.icon_url,
    ], { encoding: "utf8" });
    if (result.status === 0 && existsSync(out)) downloaded += 1;
    else failed += 1;
  }
  console.log(JSON.stringify({ ok: failed === 0, icon_dir: iconDir, existing, downloaded, failed }, null, 2));
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
