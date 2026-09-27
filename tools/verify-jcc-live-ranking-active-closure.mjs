import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveActiveRankingClosureSync } from "./jcc_live_rankings_active_closure.mjs";
import { readRankingRecipeGenerationSync } from "./jcc_live_rankings_recipe_store.mjs";
import { resolveRankingTarget } from "./jcc_ranking_target.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const rankingsRoot = path.join(repoRoot, "data", "live-rankings", "jcc");
const target = await resolveRankingTarget({ repoRoot, argv: ["--profile", "active"] });
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
assert.equal(closure.closure_status, "available");
assert(closure.ranking?.generation_dir, "active Ranking generation from closure must resolve");
assert(closure.recipe?.generation_file, "active recipe generation from closure must resolve");
const snapshot = JSON.parse(await readFile(path.join(closure.ranking.generation_dir, "snapshot.json"), "utf8"));
const tier = snapshot.tiers?.["0"];
assert(tier, "active Ranking snapshot must contain the Master+ tier");
const loaded = readRankingRecipeGenerationSync({
  rootDir: rankingsRoot,
  generationId: closure.recipe_generation_id,
  expectedIdentity: target,
});
const recipes = loaded.document.recipes || [];
const countByRole = (role) => recipes.filter((recipe) => recipe?.source_role === role).length;
const winningCount = tier.recipe_sources?.winning?.recipes?.length || 0;
const popularCount = tier.recipe_sources?.popular?.recipes?.length || 0;

assert.equal(countByRole("winning_recipe"), winningCount, "active recipe winning count must match active Ranking snapshot");
assert.equal(countByRole("popular_recipe"), popularCount, "active recipe popular count must match active Ranking snapshot");
assert.equal(closure.recipe.generation_id, closure.recipe_generation_id);
assert.equal(closure.recipe.generation_file, loaded.generation_file);
assert.equal(closure.ranking_generation_id, closure.ranking.generation_id);
assert.equal(closure.stat_date, snapshot.stat_date);
assert.equal(closure.recipe.stat_date, snapshot.stat_date);
assert.equal(closure.pointer.ranking_generation_id, closure.ranking_generation_id);
assert.equal(closure.pointer.recipe_generation_id, closure.recipe_generation_id);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-live-ranking-active-closure-verifier-v1",
  active_ranking_generation_id: closure.ranking_generation_id,
  active_recipe_generation_id: closure.recipe_generation_id,
  stat_date: snapshot.stat_date,
  source_counts: {
    winning_recipe: winningCount,
    popular_recipe: popularCount,
    combined: recipes.length,
  },
  verified: [
    "active_ranking_generation_resolves",
    "active_closure_resolves_for_same_core_identity",
    "active_closure_binds_same_stat_date",
    "active_recipe_winning_count_matches_active_snapshot",
    "active_recipe_popular_count_matches_active_snapshot",
    "active_closure_pointer_ids_match_resolved_generations",
  ],
}, null, 2));
