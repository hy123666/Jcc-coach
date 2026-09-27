#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveActiveRankingClosureSync } from "./jcc_live_rankings_active_closure.mjs";
import { readRankingRecipeGenerationSync } from "./jcc_live_rankings_recipe_store.mjs";
import { resolveRankingTarget } from "./jcc_ranking_target.mjs";

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
  return process.argv[index + 1];
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

const root = path.resolve(argumentValue("--root"));
const expectedDate = argumentValue("--expected-stat-date");
if (!/^\d{8}$/.test(expectedDate)) throw new Error("--expected-stat-date must be YYYYMMDD");

const rankingsRoot = path.join(root, "data", "live-rankings", "jcc");
const target = await resolveRankingTarget({ repoRoot: root, argv: ["--profile", "active"] });
const expectedIdentity = {
  core_profile_id: target.core_profile_id,
  season_id: target.season_id,
  patch_id: target.patch_id,
  catalog_fingerprint: target.catalog_source_fingerprint,
  hard_data_manifest_fingerprint: target.hard_data_manifest_fingerprint,
};
const closure = resolveActiveRankingClosureSync({ rootDir: rankingsRoot, expectedIdentity });
assert.equal(closure.availability, "available", `Ranking closure unavailable: ${closure.reason || "unknown"}`);
assert.equal(closure.stat_date, expectedDate, "active Ranking has an unexpected statistics date");

const pointer = await readJson(path.join(rankingsRoot, "active-generation.json"));
const manifest = await readJson(path.join(rankingsRoot, "current", "manifest.json"));
const snapshot = await readJson(path.join(closure.ranking.generation_dir, "snapshot.json"));
assert.equal(pointer.generation_id, closure.ranking_generation_id);
assert.equal(pointer.stat_date, expectedDate);
assert.equal(manifest.current?.stat_date, expectedDate);
assert.equal(snapshot.stat_date, expectedDate);
assert.equal(pointer.core_profile_id, target.core_profile_id);
assert.equal(closure.recipe.stat_date, expectedDate);
assert.equal(closure.recipe_generation_id, closure.recipe.generation_id);
assert.equal(manifest.semantic_maintenance?.status, "ready", "semantic maintenance is not ready");

const recipe = readRankingRecipeGenerationSync({
  rootDir: rankingsRoot,
  generationId: closure.recipe_generation_id,
  expectedIdentity: target,
});
assert.equal(recipe.document.capability?.freshness?.ranking_stat_date, expectedDate);

console.log(JSON.stringify({
  ok: true,
  core_profile_id: target.core_profile_id,
  stat_date: expectedDate,
  ranking_generation_id: closure.ranking_generation_id,
  recipe_generation_id: closure.recipe_generation_id,
  semantic_maintenance: manifest.semantic_maintenance.status,
}));
