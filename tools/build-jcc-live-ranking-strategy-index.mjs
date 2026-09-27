import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { resolveHardDataTarget, validateHardDataTarget } from "./jcc_hard_data_target.mjs";
import { buildOfficialSourceDictionary } from "./jcc_official_source_dictionary.mjs";
import { buildLiveRankingStrategyIndex } from "./jcc_live_rankings_strategy_index.mjs";

function parseArgs(argv) {
  const args = {
    rankingsDir: null,
    hardDataDir: null,
    updateManifest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--rankings-dir") args.rankingsDir = path.resolve(argv[index + 1]);
    if (argv[index] === "--hard-data-dir") args.hardDataDir = path.resolve(argv[index + 1]);
    if (argv[index] === "--update-manifest") args.updateManifest = true;
  }
  return args;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeJsonAtomic(file, value, true);
}

async function writeCompactJson(file, value) {
  await writeJsonAtomic(file, value, false);
}

async function writeJsonAtomic(file, value, pretty) {
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempFile, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, "utf8");
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(import.meta.dirname, "..");
const runtimePaths = createRuntimePaths(repoRoot);
if (!args.rankingsDir) {
  throw new Error("--rankings-dir is required and must identify a writable staging or candidate directory");
}
const publicationRoot = path.resolve(repoRoot, "data/live-rankings/jcc");
const relativePublicationPath = path.relative(publicationRoot, args.rankingsDir);
if (relativePublicationPath === "current"
  || relativePublicationPath.startsWith(`current${path.sep}`)
  || relativePublicationPath === "generations"
  || relativePublicationPath.startsWith(`generations${path.sep}`)) {
  throw new Error("Ranking strategy index builder cannot modify current/ or immutable generations; use a staging or candidate directory");
}
const snapshotFile = path.join(args.rankingsDir, "snapshot.json");
const snapshot = await readJson(snapshotFile);
const activeRankingIndex = await readJson(runtimePaths.liveRankingsStrategyIndexFile).catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
const existingManifest = await readJson(path.join(args.rankingsDir, "manifest.json")).catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
const patchPackage = String(snapshot?.static_basis?.patch_package || "").trim();
if (!patchPackage && !args.hardDataDir) throw new Error("snapshot static_basis.patch_package is required");
const hardDataDir = args.hardDataDir || path.resolve("data/core-patches/jcc", patchPackage);
const hardDataTarget = resolveHardDataTarget({
  repoRoot,
  activeManifest: runtimePaths.activeHardDataManifest,
});
const hardDataManifest = args.hardDataDir
  ? await readJson(path.join(hardDataDir, "manifest.json"))
  : await validateHardDataTarget(hardDataTarget);
if (String(hardDataManifest?.packageId || "") !== patchPackage) {
  throw new Error(`ranking snapshot package ${patchPackage} does not match hard-data package ${hardDataManifest?.packageId || "missing"}`);
}
const traits = await readJson(path.join(hardDataDir, "normalized/traits.json"));
const champions = await readJson(path.join(hardDataDir, "normalized/champions.json"));
const roleProfiles = await readJson(path.join(hardDataDir, "indexes/champion_role_profile.json"));
const items = await readJson(path.join(hardDataDir, "normalized/items.json"));
const augments = await readJson(path.join(hardDataDir, "normalized/augments.json"));
const sourceEntityMappings = await readJson(path.join(hardDataDir, "normalized/source_entity_mappings.json"));
const officialSourceDictionary = await buildOfficialSourceDictionary({
  upstream_identity: {
    mode: snapshot?.official_source_dictionary?.upstream_identity?.mode
      || activeRankingIndex?.source_identity?.upstream_mode
      || snapshot?.static_basis?.mode,
    version: snapshot?.official_source_dictionary?.upstream_identity?.version
      || activeRankingIndex?.source_identity?.upstream_version
      || snapshot?.static_basis?.version,
    season: snapshot?.official_source_dictionary?.upstream_identity?.season
      || activeRankingIndex?.source_identity?.upstream_season_id
      || snapshot?.static_basis?.season,
  },
});
const outputFile = path.join(args.rankingsDir, "lineup-strategy-index.json");
const strategyIndex = buildLiveRankingStrategyIndex(snapshot, {
  traits,
  champions,
  roleProfiles,
  items,
  augments,
  runtimeSeasonId: runtimePaths.activeSeasonId,
  upstreamSeasonId: snapshot?.source?.upstream_season_id
    || activeRankingIndex?.source_identity?.upstream_season_id
    || existingManifest?.source_identity?.upstream_season_id
    || null,
  activePatchId: hardDataManifest.runtime_patch_id || runtimePaths.activePatchId,
  gameModeId: runtimePaths.activeGameModeId,
  packageId: runtimePaths.activePackageId,
  sourcePackageId: hardDataManifest.packageId,
  coreProfileId: runtimePaths.activeCoreProfileId,
  hardDataManifestFingerprint: runtimePaths.activeDecisionInputCatalogSourceIdentity?.hard_data_manifest_fingerprint || null,
  catalogSourceFingerprint: runtimePaths.activeDecisionInputCatalogSourceIdentity?.catalog_source_fingerprint || null,
  commonSemanticDocument: runtimePaths.activeCoreKnowledgeBundle?.common?.semantic_features || null,
  officialSourceDictionary,
  sourceEntityMappings,
});
await writeCompactJson(outputFile, strategyIndex);

for (const fileName of ["rank-signal.json", "audit.json"]) {
  const file = path.join(args.rankingsDir, fileName);
  try {
    const value = await readJson(file);
    value.source_identity = strategyIndex.source_identity;
    await writeJson(file, value);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (args.updateManifest) {
  const manifestFile = path.join(args.rankingsDir, "manifest.json");
  const manifest = await readJson(manifestFile);
  manifest.current = manifest.current || {};
  manifest.current.files = [...new Set([...(manifest.current.files || []), "lineup-strategy-index.json"])];
  manifest.source_identity = strategyIndex.source_identity;
  await writeJson(manifestFile, manifest);
}

console.log(JSON.stringify({
  status: "pass",
  stat_date: strategyIndex.stat_date,
  output_file: outputFile,
  tiers: Object.fromEntries(Object.entries(strategyIndex.tiers).map(([tier, value]) => [tier, value.lineup_candidates.length])),
}, null, 2));
