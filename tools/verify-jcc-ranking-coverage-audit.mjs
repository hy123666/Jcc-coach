import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildLiveRankingCoverageMinimums } from "./jcc_live_rankings_coverage_policy.mjs";
import { resolveActiveRankingClosureSync } from "./jcc_live_rankings_active_closure.mjs";
import { resolveRankingTarget } from "./jcc_ranking_target.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const target = await resolveRankingTarget({ repoRoot, argv: ["--profile", "active"] });
const rankingsRoot = path.join(repoRoot, "data", "live-rankings", "jcc");
const closure = resolveActiveRankingClosureSync({
  rootDir: rankingsRoot,
  expectedIdentity: {
    core_profile_id: target.core_profile_id,
    season_id: target.season_id,
    patch_id: target.patch_id,
    catalog_fingerprint: target.catalog_source_fingerprint,
    hard_data_manifest_fingerprint: target.hard_data_manifest_fingerprint,
  },
});
assert.equal(closure.availability, "available", `active Ranking closure unavailable: ${closure.reason || "unknown reason"}`);
const generation = closure.ranking;
assert(generation?.generation_dir, "an active Ranking generation is required");

const [snapshot, audit, traits, champions, items] = await Promise.all([
  readFile(path.join(generation.generation_dir, "snapshot.json"), "utf8").then(JSON.parse),
  readFile(path.join(generation.generation_dir, "audit.json"), "utf8").then(JSON.parse),
  readFile(path.join(target.hard_data_package_dir, "normalized", "traits.json"), "utf8").then(JSON.parse),
  readFile(path.join(target.hard_data_package_dir, "normalized", "champions.json"), "utf8").then(JSON.parse),
  readFile(path.join(target.hard_data_package_dir, "normalized", "items.json"), "utf8").then(JSON.parse),
]);
const minimums = buildLiveRankingCoverageMinimums({ traits, champions, items });
const tier = snapshot.tiers?.["0"];
const winning = tier?.recipe_sources?.winning;
const coverage = audit.coverage?.tiers?.["0"];
const winningRecipeCount = Array.isArray(winning?.recipes) ? winning.recipes.length : 0;

assert.equal(coverage?.winningRecipeCount, winningRecipeCount,
  "audit coverage must count normalized winning recipes, not upstream grouping rows");
assert.equal(coverage?.lineupGroupCount, tier?.lineup_group?.main_traits_data?.length || 0,
  "upstream lineup grouping count must remain a separate diagnostic field");
if (winning?.capability?.status === "available" && winningRecipeCount >= minimums.winningRecipeCount) {
  assert.equal(audit.warnings?.some((warning) => warning.reason === "winning_recipe_count_below_minimum"), false,
    "sufficient normalized winning recipes must not produce a coverage warning");
  assert.equal(audit.recipe_status, "available",
    "sufficient normalized winning recipes must keep recipe capability available");
  if (!(audit.warnings || []).length && !(audit.errors || []).length) {
    assert.equal(audit.status, "pass",
      "complete coverage without any other audit issue must pass");
  }
}
assert.equal(audit.warnings?.some((warning) => warning.reason === "winning_recipe_group_below_minimum"), false,
  "the obsolete upstream grouping warning must never be emitted");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-ranking-coverage-audit-verification-v1",
  generation_id: generation.generation_id,
  stat_date: snapshot.stat_date,
  upstream_lineup_group_count: coverage.lineupGroupCount,
  winning_recipe_count: winningRecipeCount,
  winning_recipe_minimum: minimums.winningRecipeCount,
  audit_status: audit.status,
  recipe_status: audit.recipe_status,
}, null, 2));
