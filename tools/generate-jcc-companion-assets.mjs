#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const gameKnowledgeRoot = join(repoRoot, "data", "game-knowledge", "jcc");
const activeProfilePath = join(gameKnowledgeRoot, "active-profile.json");
const roiPath = join(repoRoot, "data", "runtime", "jcc", "visual-roi-layout.json");
const assetsDir = join(repoRoot, "android-companion", "app", "src", "main", "assets");

function uniqueById(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (!seen.has(row.id)) seen.set(row.id, row);
  }
  return Array.from(seen.values()).sort((a, b) => Number(a.id) - Number(b.id));
}

async function main() {
  if (!existsSync(activeProfilePath)) throw new Error(`missing active Core Profile: ${activeProfilePath}`);
  const activeProfile = JSON.parse(await readFile(activeProfilePath, "utf8"));
  const catalogOverlayPath = resolve(gameKnowledgeRoot, activeProfile.runtime_catalog_overlay_path || "");
  const relativeOverlayPath = relative(gameKnowledgeRoot, catalogOverlayPath);
  if (!relativeOverlayPath || relativeOverlayPath.startsWith("..") || isAbsolute(relativeOverlayPath) || !activeProfile.runtime_catalog_overlay_path) {
    throw new Error("active Core Profile runtime catalog overlay escapes the game-knowledge root");
  }
  if (!existsSync(catalogOverlayPath)) throw new Error(`missing active runtime catalog overlay: ${catalogOverlayPath}`);
  if (!existsSync(roiPath)) throw new Error(`missing ROI layout: ${roiPath}`);
  const overlayBytes = await readFile(catalogOverlayPath);
  const overlayStats = await stat(catalogOverlayPath);
  const overlaySha256 = createHash("sha256").update(overlayBytes).digest("hex");
  if (overlayStats.size !== activeProfile.runtime_catalog_overlay_byte_size
    || overlaySha256 !== activeProfile.runtime_catalog_overlay_sha256) {
    throw new Error("active runtime catalog overlay does not match the promoted Core Profile receipt");
  }
  const overlay = JSON.parse(overlayBytes.toString("utf8"));
  if (overlay.schema !== "jcc-runtime-catalog-overlay-v1") {
    throw new Error(`unexpected active runtime catalog schema: ${overlay.schema || "missing"}`);
  }
  if (overlay.source_identity?.core_profile_id !== activeProfile.core_profile_id) {
    throw new Error("active runtime catalog overlay Core Profile identity mismatch");
  }
  const coreIdentity = overlay.identity || {};
  const heroes = Object.values(overlay.champions_by_id || {}).map((hero) => ({
    id: String(hero.id),
    name: String(hero.name),
    cost: Number(hero.cost ?? 0),
    icon_url: hero.icon_url ? String(hero.icon_url) : null,
    canonical_id: hero.canonical_id ? String(hero.canonical_id) : null,
    star: hero.star ?? null,
  }));
  const augments = Object.values(overlay.augments_by_id || {}).map((augment) => ({
    id: String(augment.id),
    name: String(augment.name),
    tier: augment.tier != null ? String(augment.tier) : null,
    icon_url: augment.icon_url ? String(augment.icon_url) : null,
  }));
  const roi = JSON.parse(await readFile(roiPath, "utf8"));
  await mkdir(assetsDir, { recursive: true });
  const catalog = {
    schema: "jcc-companion-catalog-v1",
    generated_from: "active_core_runtime_catalog_overlay",
    core_profile_id: activeProfile.core_profile_id,
    season_id: activeProfile.season_id,
    patch_id: activeProfile.patch_id,
    heroes: uniqueById(heroes),
    augments: uniqueById(augments),
  };
  await writeFile(join(assetsDir, "jcc_catalog.json"), JSON.stringify(catalog, null, 2), "utf8");
  await writeFile(join(assetsDir, "jcc_roi_layout.json"), JSON.stringify(roi, null, 2), "utf8");
  console.log(JSON.stringify({
    ok: true,
    assets_dir: assetsDir,
    core_profile_id: catalog.core_profile_id,
    heroes: catalog.heroes.length,
    augments: catalog.augments.length,
    roi_layout: roi.layout_id,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
