import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function exists(relativePath) {
  try {
    await access(path.join(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function text(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

const retiredDailyDataTftPaths = [
  "data/daily-intelligence/jcc/sources/datatft-source-contract.json",
  "data/daily-intelligence/jcc/sources/datatft-discovery-manifest.json",
  "tools/daily-intelligence/datatft-api-source-adapter.mjs",
  "tools/daily-intelligence/datatft-source-adapter.mjs",
  "tools/daily-intelligence/datatft-browser-transport.mjs",
  "tools/daily-intelligence/datatft-electron-transport.cjs",
  "tools/daily-intelligence/datatft-source-circuit-breaker.mjs",
  "tools/update-jcc-daily-intelligence.mjs",
  "tools/sync-jcc-datatft-database-source.mjs",
  "tools/sync-jcc-datatft-rate-source.mjs",
  "tools/sync-jcc-datatft-trait-tracker-source.mjs",
  "ui/electron/daily-intelligence-retrieval.js",
];

for (const relativePath of retiredDailyDataTftPaths) {
  assert.equal(await exists(relativePath), false, `retired DataTFT daily path must stay absent: ${relativePath}`);
}

for (const relativePath of [
  "tools/sync-jcc-live-rankings.mjs",
  "tools/update-jcc-live-rankings.mjs",
  "tools/verify-jcc-live-rankings.mjs",
  "ui/electron/ranking-query-retrieval.js",
  "data/live-rankings/jcc/runtime-agent-refresh-contract.json",
  "data/live-rankings/jcc/runtime-strategy-signal-contract.json",
]) {
  assert.equal(await exists(relativePath), true, `Tencent ranking production path must exist: ${relativePath}`);
}

const pipeline = await text("tools/run-jcc-version-pipeline.mjs");
assert.match(pipeline, /update-jcc-live-rankings\.mjs/u, "version pipeline must invoke the Tencent ranking updater");
assert.doesNotMatch(pipeline, /update-jcc-daily-intelligence\.mjs/u, "version pipeline must not invoke the retired DataTFT daily updater");

const harness = JSON.parse(await text("data/runtime/jcc/harness-entrypoint-contract.json"));
const serializedHarness = JSON.stringify(harness);
assert.match(serializedHarness, /data\/live-rankings\/jcc/u, "harness must expose the Tencent ranking module");
assert.doesNotMatch(serializedHarness, /datatft-api-source-adapter|datatft-source-contract|datatft-discovery-manifest/iu, "harness must not expose DataTFT as a daily ranking source");

const runtimeSource = await text("ui/electron/runtime-service.js");
assert.doesNotMatch(runtimeSource, /createDailyIntelligenceRetrieval|datatft_grandmaster_one_day|primary:\s*["']DataTFT["']/u, "Runtime must not consume DataTFT daily evidence");
assert.match(runtimeSource, /"--profile",\s*"active"/u, "desktop rankings refresh must bind to the active Core Profile");
assert.match(runtimeSource, /"--expected-core-profile-id",\s*runtimePaths\.activeCoreProfileId/u, "desktop rankings refresh must pass the exact active Core Profile id");

const refreshContract = JSON.parse(await text("data/live-rankings/jcc/runtime-agent-refresh-contract.json"));
assert.match(String(refreshContract.purpose || ""), /Tencent\/JCC/u, "ranking refresh authority must identify Tencent/JCC");
assert.equal(refreshContract.source_identity?.ranking_tier_label, "master_plus", "ranking source must remain Master+");
assert.match(
  String(refreshContract.data_contract?.production_locator || ""),
  /active-ranking-closure\.json.*immutable.*Ranking.*recipe/u,
  "production ranking locator must resolve one immutable Ranking generation and its exact-Core recipe generation",
);
assert.match(String(refreshContract.data_contract?.compatibility_mirrors || ""), /non-authoritative/u, "current/previous mirrors must be explicitly non-authoritative");

const strategyContract = JSON.parse(await text("data/live-rankings/jcc/runtime-strategy-signal-contract.json"));
for (const field of ["rank_signal", "audit", "manifest", "strategy_index"]) {
  assert.match(String(strategyContract.data_sources?.[field] || ""), /^active_generation:/u, `${field} must resolve through the immutable active generation`);
}

const patchManifest = JSON.parse(await text("data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-manifest.json"));
assert.equal(patchManifest.daily_intelligence_sources, undefined, "current patch manifest must not declare retired Daily Intelligence sources");
const offlineSupplement = patchManifest.offline_core_supplement_sources?.datatft_s18_frozen;
assert.equal(offlineSupplement?.historical_source_evidence_only, false);
assert.equal(offlineSupplement?.production_core_input, true);
assert.deepEqual(offlineSupplement?.retained_roles, [
  "database_hard_data_enrichment",
  "reward_rate_tables",
  "trait_tracking",
  "champion_item_sprite_expansions",
]);
assert.equal(offlineSupplement?.patch_policy, "retain_as_current_core_baseline_input_then_apply_explicit_patch_delta");
assert.equal(offlineSupplement?.network_refresh, false);
assert.equal(offlineSupplement?.runtime_retrieval, false);
assert.equal(offlineSupplement?.ranking_authority, false);

const runbook = await text("docs/requirements/jcc-season-version-governance-runbook.md");
assert.doesNotMatch(runbook, /mode18_mumu_runtime_mapping_not_live_verified/u, "current runbook must not preserve a cleared S18 activation blocker");
assert.match(runbook, /ranking failure[\s\S]*?never rolls back a valid Core promotion/u, "runbook must keep Ranking Overlay failure independent from Core promotion");
assert.match(runbook, /Both identities stay fixed for the entire Match/u, "runbook must pin Core and Ranking Overlay for the entire Match");

process.stdout.write(`${JSON.stringify({
  schema: "jcc-tencent-primary-ranking-source-verifier-v1",
  status: "pass",
  retired_daily_datatft_paths: retiredDailyDataTftPaths.length,
  primary_source: "tencent_jcc_master_plus",
})}\n`);
