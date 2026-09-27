import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const runtimePaths = createRuntimePaths(repoRoot);

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8").replace(/^\uFEFF/, ""));
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
}

function firstChampionWithAllItemTypes() {
  const fits = JSON.parse(fs.readFileSync(
    path.join(path.dirname(runtimePaths.activeHardDataManifest), "indexes/champion_item_fit.json"),
    "utf8",
  ).replace(/^\uFEFF/, ""));
  const fit = fits.find((entry) => {
    const candidates = entry.item_candidates || [];
    return candidates.some((candidate) => candidate.item_tags?.includes("artifact"))
      && candidates.some((candidate) => candidate.item_tags?.includes("radiant"))
      && candidates.some((candidate) => String(candidate.item_type || "").includes("特殊"));
  });
  assert.ok(fit, "expected at least one champion with artifact/radiant/special candidates");
  return fit.champion_name;
}

const contract = readJson("data/runtime/jcc/itemization-decision-contract.json");
assert.equal(contract.schema, "jcc-itemization-decision-contract-v1");
assert.equal(contract.source_precedence[0], "trusted_mumu_4357_item_bench_and_4356_to_4353_assignment");
assert.equal(contract.source_precedence[1], "current_match_explicit_user_confirmation");
assert.equal(contract.source_precedence[2], "explicit_visual_or_icon_candidate_fallback");
assert.ok(contract.decision_actions.includes("slam_now"));
assert.ok(contract.decision_actions.includes("wait_component"));
assert.ok(contract.decision_actions.includes("hold_for_artifact_or_choice"));
assert.ok(contract.wait_vs_slam_policy.wait_component_when.length >= 4);
assert.ok(contract.wait_vs_slam_policy.slam_now_when.length >= 4);
assert.ok(contract.wait_vs_slam_policy.forbidden_wording.some((line) => line.includes("无脑")));
assert.equal(contract.craft_recipe_authority.exact_match_required, true);
assert.equal(contract.craft_recipe_authority.desired_trait_is_not_recipe_evidence, true);

const champion = firstChampionWithAllItemTypes();
const context = runNode(["tools/build-jcc-itemization-context.mjs", "--champion", champion, "--max-per-group", "4"]);
assert.equal(context.schema, "jcc-itemization-context-v1");
assert.equal(context.active_season, runtimePaths.activeSeasonId);
assert.equal(context.active_patch_id, runtimePaths.activePatchId);
assert.equal(context.contract.source_precedence[0], "trusted_mumu_4357_item_bench_and_4356_to_4353_assignment");
assert.ok(context.wait_cost_summary.some((entry) => entry.component_name === "暴风之剑"));
assert.ok(context.champion_context, "expected champion_context");
assert.ok(context.champion_context.artifact_candidates.length > 0, "expected artifact candidates");
assert.ok(context.champion_context.radiant_candidates.length > 0, "expected radiant candidates");
assert.ok(context.champion_context.special_candidates.length > 0, "expected special item candidates");
assert.equal(context.candidate_scope.ranking_evidence, "available_as_soft_prior");
assert.ok(context.host_model_instruction.some((line) => line.includes("Daily rank hero_item_signal is a prior")));

const summary = runNode(["tools/build-jcc-itemization-context.mjs", "--summary-only"]);
assert.equal(summary.schema, "jcc-itemization-context-v1");
assert.equal(summary.active_season, runtimePaths.activeSeasonId);
assert.equal(summary.active_patch_id, runtimePaths.activePatchId);
assert.ok(summary.item_data_summary.champions_with_artifact_candidates > 0);
assert.ok(summary.champion_context === null);

const panRecipes = runNode([
  "tools/build-jcc-itemization-context.mjs",
  "--summary-only",
  "--query-text",
  "金锅锅能合成什么纹章",
]);
const panContext = panRecipes.component_recipe_contexts.find((entry) => entry.component_name === "金锅锅");
assert.ok(panContext, "an exact component mention must attach its current-patch recipe context");
const activeItems = JSON.parse(fs.readFileSync(
  path.join(path.dirname(runtimePaths.activeHardDataManifest), "normalized/items.json"),
  "utf8",
).replace(/^\uFEFF/, ""));
const pan = activeItems.find((item) => item.name === "金锅锅");
assert.ok(pan, "the active catalog must contain 金锅锅");
const expectedPanCraftNames = activeItems
  .filter((item) => item.recipe?.component_ids?.map(String).includes(String(pan.id)))
  .map((item) => item.name)
  .sort((left, right) => left.localeCompare(right, "zh-CN"));
const panCraftNames = panContext.craft_candidates.map((entry) => entry.item_name).sort((left, right) => left.localeCompare(right, "zh-CN"));
assert.ok(expectedPanCraftNames.length > 0, "the active catalog must publish current-patch 金锅锅 recipes");
assert.deepEqual(panCraftNames, expectedPanCraftNames, "component advice must exactly match the active patch's official recipes");
assert.ok(!panCraftNames.includes("不存在的纹章"), "an unlisted desired-trait emblem must never appear as craftable");
assert.ok(panRecipes.host_model_instruction.some((line) => line.includes("Never invent an unlisted emblem")));

const hardDefault = runNode([
  "tools/build-jcc-itemization-context.mjs",
  "--champion", champion,
  "--hard-data-only",
  "--query-text", "主C理论最优装备",
]);
assert.equal(hardDefault.candidate_scope.evidence_policy, "active_core_profile_only");
assert.deepEqual(hardDefault.candidate_scope.requested_categories, ["completed"]);
assert.equal(hardDefault.candidate_scope.ranking_evidence, "forbidden");
assert.equal(hardDefault.champion_context.daily_rank_prior, null);
assert.ok(hardDefault.champion_context.completed_candidates.length > 0);
assert.deepEqual(hardDefault.champion_context.artifact_candidates, []);
assert.deepEqual(hardDefault.champion_context.radiant_candidates, []);
assert.deepEqual(hardDefault.champion_context.special_candidates, []);
assert.deepEqual(hardDefault.champion_context.emblem_candidates, []);

const hardArtifact = runNode([
  "tools/build-jcc-itemization-context.mjs",
  "--champion", champion,
  "--hard-data-only",
  "--query-text", "只比较神器",
]);
assert.deepEqual(hardArtifact.candidate_scope.requested_categories, ["artifact"]);
assert.ok(hardArtifact.champion_context.artifact_candidates.length > 0);
assert.deepEqual(hardArtifact.champion_context.completed_candidates, []);
assert.ok(hardArtifact.champion_context.artifact_candidates.every((entry) => Object.hasOwn(entry, "artifact_subtype")));

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-itemization-decision-context-verification-v1",
  checked: {
    contract: "live_state_first_wait_vs_slam_policy",
    context_builder: "artifact_radiant_special_candidates",
    champion,
    wait_cost_components: summary.wait_cost_summary.length,
    pan_recipe_candidates: panCraftNames.length,
    hard_data_default_category: hardDefault.candidate_scope.requested_categories,
    hard_data_artifact_candidates: hardArtifact.champion_context.artifact_candidates.length,
  },
}, null, 2)}\n`);
