#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { attachSameIconGroups, enrichItemTemplate } from "./jcc_item_icon_catalog.mjs";
import { activeHardDataPath } from "./jcc_hard_data_target.mjs";

const DEFAULT_CATALOG = "data/runtime/jcc/mumu-catalog-overlay.json";
const DEFAULT_OUT_DIR = "data/runtime/jcc/visual-icons";
const repoRoot = path.resolve(import.meta.dirname, "..");
const DEFAULT_HARD_DATA_AUGMENTS = activeHardDataPath(repoRoot, "normalized", "augments.json");
const DEFAULT_HARD_DATA_ITEMS = activeHardDataPath(repoRoot, "normalized", "items.json");

function usage() {
  return [
    "Usage:",
    "  node tools/ensure-jcc-visual-icon-assets.mjs [--catalog-overlay <json>] [--out-dir <dir>] [--kind item|augment|champion|all] [--download] [--limit <n>]",
    "",
    "Builds a local manifest for item/augment/champion icon templates from the MuMu catalog overlay.",
    "Downloads only when --download is explicit.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { catalogOverlay: DEFAULT_CATALOG, outDir: DEFAULT_OUT_DIR, kind: "all", download: false, limit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--catalog-overlay") options.catalogOverlay = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--kind") options.kind = argv[++index];
    else if (arg === "--download") options.download = true;
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["item", "augment", "champion", "all"].includes(options.kind)) throw new Error(`Invalid --kind: ${options.kind}`);
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 0)) throw new Error("--limit must be a non-negative integer");
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function toRepoRelativePath(file) {
  return path.relative(process.cwd(), file).replaceAll(path.sep, "/");
}

function tierColor(tier) {
  const normalized = String(tier ?? "").trim().toLowerCase();
  if (["1", "silver", "white"].includes(normalized)) return "silver";
  if (["2", "gold", "golden"].includes(normalized)) return "gold";
  if (["3", "prismatic", "colorful", "rainbow"].includes(normalized)) return "prismatic";
  return null;
}

function augmentTierColorByHardData(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.id) continue;
    map.set(String(row.id), tierColor(row.tier));
  }
  return map;
}

function hardDataById(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.id) continue;
    map.set(String(row.id), row);
  }
  return map;
}

function entriesByKind(catalog, kind, augmentTierColors = new Map()) {
  const kinds = kind === "all" ? ["item", "augment", "champion"] : [kind];
  const rows = [];
  for (const currentKind of kinds) {
    const map = currentKind === "item"
      ? catalog.items_by_id
      : currentKind === "augment"
        ? catalog.augments_by_id
        : catalog.champions_by_id;
    for (const entry of Object.values(map || {})) {
      if (!entry?.id || !entry?.icon_url) continue;
      rows.push({
        kind: currentKind,
        id: String(entry.id),
        name: entry.name,
        icon_url: entry.icon_url,
        round_hints: Array.isArray(entry.round_hints) ? entry.round_hints : [],
        hard_data_tier_color: currentKind === "augment" ? (augmentTierColors.get(String(entry.id)) || null) : null,
        source: entry.source || "mumu_catalog_overlay",
      });
    }
  }
  return rows;
}

function curlDownload(url, out) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "http://127.0.0.1:10808";
  const args = ["-L", "--retry", "2", "--retry-delay", "1", "-sS", "-o", out, url];
  if (proxy) args.splice(1, 0, "--proxy", proxy);
  return spawnSync("curl.exe", args, { encoding: "utf8" });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const catalog = await readJson(path.resolve(options.catalogOverlay));
  let augmentTierColors = new Map();
  try {
    augmentTierColors = augmentTierColorByHardData(await readJson(path.resolve(DEFAULT_HARD_DATA_AUGMENTS)));
  } catch {
    augmentTierColors = new Map();
  }
  let hardItems = new Map();
  try {
    hardItems = hardDataById(await readJson(path.resolve(DEFAULT_HARD_DATA_ITEMS)));
  } catch {
    hardItems = new Map();
  }
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  let rows = entriesByKind(catalog, options.kind, augmentTierColors);
  if (options.limit !== null) rows = rows.slice(0, options.limit);
  let existing = 0;
  let downloaded = 0;
  let failed = 0;
  const manifest = [];
  for (const row of rows) {
    const dir = path.join(outDir, row.kind);
    await mkdir(dir, { recursive: true });
    const localPath = path.join(dir, `${row.id}.png`);
    if (existsSync(localPath)) existing += 1;
    else if (options.download) {
      const result = curlDownload(row.icon_url, localPath);
      if (result.status === 0 && existsSync(localPath)) downloaded += 1;
      else failed += 1;
    }
    const manifestRow = {
      ...row,
      local_path: toRepoRelativePath(localPath),
      local_exists: existsSync(localPath),
      template_status: existsSync(localPath) ? "available" : "missing_not_downloaded",
    };
    manifest.push(row.kind === "item"
      ? enrichItemTemplate(manifestRow, hardItems.get(String(row.id)) || null)
      : manifestRow);
  }
  const enrichedManifest = attachSameIconGroups(manifest);
  const manifestFile = path.join(outDir, "manifest.json");
  await writeFile(manifestFile, `${JSON.stringify({
    schema: "jcc-visual-icon-template-manifest-v1",
    generated_at: new Date().toISOString(),
    catalog_overlay: toRepoRelativePath(path.resolve(options.catalogOverlay)),
    download_enabled: options.download,
    counts: {
      total: enrichedManifest.length,
      available: enrichedManifest.filter((entry) => entry.local_exists).length,
      existing,
      downloaded,
      failed,
    },
    templates: enrichedManifest,
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: failed === 0,
    out_dir: outDir,
    manifest: manifestFile,
    download_enabled: options.download,
    total: enrichedManifest.length,
    available: enrichedManifest.filter((entry) => entry.local_exists).length,
    existing,
    downloaded,
    failed,
  }, null, 2));
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
