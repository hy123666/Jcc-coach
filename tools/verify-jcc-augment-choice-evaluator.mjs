import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { compileCoreSemanticFeatureIndex } from "../ui/electron/semantic-feature-layer.js";
import { evaluateAugmentChoiceCandidate } from "../ui/electron/augment-choice-evaluator.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const commonSemanticDocument = JSON.parse(await readFile(
  path.join(repoRoot, "data/game-knowledge/jcc/common/semantic-features.json"),
  "utf8",
));
const activeProfile = JSON.parse(await readFile(
  path.join(repoRoot, "data/game-knowledge/jcc/active-profile.json"),
  "utf8",
));
const hardDataManifestPath = activeProfile.runtime_identity?.hard_data_manifest;
assert(hardDataManifestPath, "active Core Profile must bind one immutable hard-data manifest");
const hardDataManifest = JSON.parse(await readFile(path.resolve(repoRoot, hardDataManifestPath), "utf8"));
const augments = JSON.parse(await readFile(
  path.join(path.dirname(path.resolve(repoRoot, hardDataManifestPath)), "normalized/augments.json"),
  "utf8",
));

const selectedNames = new Set(["存心失利", "潘朵拉的装备", "金蛋", "强化之能量", "升级咯！"]);
const selectedAugments = augments.filter((augment) => selectedNames.has(augment.name));
assert.equal(selectedAugments.length, selectedNames.size, "active Core source must contain every evaluator fixture augment");

const index = compileCoreSemanticFeatureIndex({
  commonSemanticDocument,
  augments: selectedAugments,
  identity: {
    season_id: activeProfile.season_id,
    patch_id: activeProfile.patch_id,
    core_profile_id: activeProfile.core_profile_id,
    hard_data_generation_id: hardDataManifest.generation_id || null,
  },
});

function profile(name) {
  const row = index.entities.find((entry) => entry.entity_kind === "augment" && entry.name === name);
  assert(row?.augment_profile, `compiled augment profile missing: ${name}`);
  return row.augment_profile;
}

const lossEconomy = profile("存心失利");
assert(lossEconomy.features.includes("trigger.loss"));
assert(lossEconomy.features.includes("effect.shop_access"));
assert(lossEconomy.features.includes("reliability.conditional"));

const pandora = profile("潘朵拉的装备");
assert(pandora.features.includes("effect.item_conversion"));
assert(pandora.features.includes("reliability.random"));
assert(pandora.features.includes("delivery.recurring"));

const egg = profile("金蛋");
assert(egg.features.includes("delivery.delayed"));
assert(egg.features.includes("risk.delayed_payout"));
assert(egg.features.includes("trigger.win"));
assert(egg.required_context_fields.includes("hp"));

const highHpEgg = evaluateAugmentChoiceCandidate({
  candidate: { id: "3137", name: "金蛋" },
  profile: egg,
  match: { stage_round: "4-2", hp: 96, gold: 45, board_power_score: 0.75, selected_augment_count: 2 },
  decision: { goal: "win_first", target_context_authority: "none" },
});
const lowHpEgg = evaluateAugmentChoiceCandidate({
  candidate: { id: "3137", name: "金蛋" },
  profile: egg,
  match: { stage_round: "4-2", hp: 32, gold: 12, board_power_score: 0.3, selected_augment_count: 2 },
  decision: { goal: "safe_top_four", target_context_authority: "none" },
});
assert(highHpEgg.objective_scores.first_objective_fit > lowHpEgg.objective_scores.first_objective_fit);
assert(highHpEgg.objective_scores.top4_objective_fit > lowHpEgg.objective_scores.top4_objective_fit);
assert(lowHpEgg.axis_scores.risk_score > highHpEgg.axis_scores.risk_score);

const energy = profile("强化之能量");
const earlyEnergy = evaluateAugmentChoiceCandidate({
  candidate: { id: "20224", name: "强化之能量" },
  profile: energy,
  match: { stage_round: "3-2", hp: 80, gold: 30, selected_augment_count: 1 },
  decision: { goal: "balanced", target_context_authority: "none" },
});
const lateEnergy = evaluateAugmentChoiceCandidate({
  candidate: { id: "20224", name: "强化之能量" },
  profile: energy,
  match: { stage_round: "4-2", hp: 80, gold: 30, selected_augment_count: 2 },
  decision: { goal: "balanced", target_context_authority: "none" },
});
assert(earlyEnergy.axis_scores.realization_score > lateEnergy.axis_scores.realization_score);
assert(earlyEnergy.recommendation_score > lateEnergy.recommendation_score);

const durableFit = evaluateAugmentChoiceCandidate({
  candidate: { id: "3008", name: "升级咯！" },
  profile: profile("升级咯！"),
  match: { stage_round: "2-1", hp: 90, gold: 24, level: 4, selected_augment_count: 0 },
  decision: { goal: "balanced", target_context_authority: "durable_target_plan", lineup_fit: 0.9 },
});
const noTarget = evaluateAugmentChoiceCandidate({
  candidate: { id: "3008", name: "升级咯！" },
  profile: profile("升级咯！"),
  match: { stage_round: "2-1", hp: 90, gold: 24, level: 4, selected_augment_count: 0 },
  decision: { goal: "balanced", target_context_authority: "none", lineup_fit: 0.9 },
});
assert(durableFit.axis_scores.lineup_fit_score > noTarget.axis_scores.lineup_fit_score);

const unresolved = evaluateAugmentChoiceCandidate({
  candidate: { id: "legacy-only", name: "幸存者" },
  profile: null,
  match: { stage_round: "2-1", hp: 100, gold: 50, selected_augment_count: 0 },
  decision: { goal: "balanced", target_context_authority: "none" },
});
assert.equal(unresolved.resolution_status, "unresolved_active_core_profile");
assert.equal(unresolved.category_source, "unresolved");
assert(unresolved.missing_fields.includes("active_core_augment_profile"));

const duplicateAssociation = evaluateAugmentChoiceCandidate({
  candidate: { id: "3008", name: "升级咯！" },
  profile: profile("升级咯！"),
  match: { stage_round: "2-1", hp: 90, gold: 24, level: 4, selected_augment_count: 0 },
  decision: {
    goal: "balanced",
    target_context_authority: "durable_target_plan",
    lineup_fit: 0.9,
    candidate_coverage: 0.8,
    duplicate_ranking_associations: ["line-a", "line-a", "line-a"],
  },
});
assert.equal(duplicateAssociation.recommendation_score, evaluateAugmentChoiceCandidate({
  candidate: { id: "3008", name: "升级咯！" },
  profile: profile("升级咯！"),
  match: { stage_round: "2-1", hp: 90, gold: 24, level: 4, selected_augment_count: 0 },
  decision: {
    goal: "balanced",
    target_context_authority: "durable_target_plan",
    lineup_fit: 0.9,
    candidate_coverage: 0.8,
    duplicate_ranking_associations: ["line-a"],
  },
}).recommendation_score, "duplicate ranking associations must not double count lineup compatibility");

assert.equal(index.audit.augment_profile_count, selectedAugments.length);
assert.equal(index.audit.unclassified_augment_ids.length, 0);

console.log(JSON.stringify({
  status: "pass",
  augment_profile_count: index.audit.augment_profile_count,
  checked: [...selectedNames],
  high_hp_egg: highHpEgg.objective_scores,
  low_hp_egg: lowHpEgg.objective_scores,
}, null, 2));
