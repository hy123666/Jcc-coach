#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createDecisionMathService } from "../ui/electron/decision-math-service.js";
import { theorycraftDecisionInputs } from "../ui/electron/runtime-service.js";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { buildSemanticSeed } from "./jcc-semantic-seed.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const patchManifest = JSON.parse(await readFile(path.join(repoRoot, "data/game-knowledge/jcc/seasons/s18/patches/s18_2/source-manifest.json"), "utf8"));
const packageManifestPath = patchManifest.source_artifacts.find((entry) => entry.role === "hard_data_manifest")?.path;
assert.match(packageManifestPath || "", /^data\/core-patches\/jcc\/generations\/[a-f0-9]{64}\/manifest\.json$/);
const packageDir = path.dirname(path.join(repoRoot, packageManifestPath));
const knowledgeRoot = path.join(repoRoot, "data", "game-knowledge", "jcc");
const candidateProfileFile = path.join(knowledgeRoot, "candidates", "candidate-profile.json");
const candidateProfile = JSON.parse(await readFile(candidateProfileFile, "utf8"));
const candidateCatalogFile = path.join(knowledgeRoot, candidateProfile.decision_input_catalog_path);
const candidateCatalog = JSON.parse(await readFile(candidateCatalogFile, "utf8"));
const candidateIdentity = candidateCatalog.source_identity;

const theorySeed = buildSemanticSeed({ query: "给我一套三费主C赌狗阵容，说明装备和神器" });
const continuedTheorySeed = buildSemanticSeed({
  query: "神器呢",
  context: { semantic_seed: theorySeed },
});
assert.equal(theorySeed.archetype, "three_cost_reroll");
assert.equal(continuedTheorySeed.seed_id, theorySeed.seed_id, "short follow-ups must retain the open semantic seed");
assert.ok(continuedTheorySeed.domains.includes("lineup"));
assert.ok(continuedTheorySeed.domains.includes("itemization"));

function stableJson(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize(input[key])]));
  };
  return JSON.stringify(normalize(value));
}

const sourceManifest = JSON.parse(await readFile(path.join(packageDir, "manifest.json"), "utf8"));
const hardDataManifestFingerprint = createHash("sha256").update(stableJson(sourceManifest)).digest("hex");

const service = await createDecisionMathService({
  hardDataPackageDir: packageDir,
  coreProfileFile: candidateProfileFile,
  decisionInputCatalogFile: candidateCatalogFile,
  expectedIdentity: candidateIdentity,
});
assert.equal(service.profile.season_id, "s18");
assert.equal(service.profile.patch_id, "s18_2");
assert.equal(service.profile.core_profile_id, candidateProfile.combined_fingerprint);
assert.equal(service.profile.hard_data_manifest_fingerprint, hardDataManifestFingerprint);

for (const catalog of ["champions", "traits"]) {
  const rows = JSON.parse(await readFile(path.join(packageDir, "normalized", `${catalog}.json`), "utf8"));
  for (const row of rows.filter((entry) => entry.balance_overrides)) {
    const detail = service.resolveMentionedFacts(row.name)?.entities.find((entry) => entry.id === row.id);
    assert.deepEqual(detail?.balance_overrides, row.balance_overrides, `${row.name}: Host must retain patch overrides`);
  }
}

const runtimePaths = createRuntimePaths(repoRoot);
const activeProfile = JSON.parse(await readFile(runtimePaths.activeCoreProfileFile, "utf8"));
const activeCatalogFile = runtimePaths.activeDecisionInputCatalogFile;
const activeCatalog = JSON.parse(await readFile(activeCatalogFile, "utf8"));
const activeService = await createDecisionMathService({
  hardDataPackageDir: path.dirname(path.join(repoRoot, runtimePaths.activeHardDataManifest)),
  coreProfileFile: runtimePaths.activeCoreProfileFile,
  decisionInputCatalogFile: activeCatalogFile,
  expectedIdentity: activeCatalog.source_identity,
});

const artifactTheoryFollowup = await activeService.calculateQuestion("神器呢", {
  force_theorycraft: true,
  champion: "阿兹尔",
  semantic_seed: theorySeed,
});
assert.equal(artifactTheoryFollowup.operation, "optimize_item_loadouts");
assert.equal(artifactTheoryFollowup.executable, true);
assert.equal(artifactTheoryFollowup.semantic_seed?.seed_id, theorySeed.seed_id);
assert.equal(artifactTheoryFollowup.selection_owner, "agent");
assert.equal(artifactTheoryFollowup.expansion_owner, "runtime_deterministic");
assert.ok(artifactTheoryFollowup.candidate_frontier?.length > 0);
assert.equal(activeService.profile.season_id, activeProfile.season_id);
assert.equal(activeService.profile.patch_id, activeProfile.patch_id);
assert.equal(activeService.profile.core_profile_id, activeProfile.core_profile_id);

const activeSpecialPool = await activeService.optimizeItemLoadouts({
  champion: "奥恩",
  allowed_item_categories: ["special"],
  slot_count: 1,
});
assert.equal(activeSpecialPool.executable, true);
const activeSpecialRecommendationNames = JSON.stringify(activeSpecialPool.recommendations);
for (const name of ["幸运装备宝箱", "光明版幸运装备宝箱", "特攻队员选择器"]) {
  assert.ok(!activeSpecialRecommendationNames.includes(name), `${name} must not enter the optimizer candidate pool`);
}
const rejectedNonEquippableLock = await activeService.optimizeItemLoadouts({
  champion: "奥恩",
  allowed_item_categories: ["special"],
  slot_count: 1,
  locked_items: ["幸运装备宝箱"],
});
assert.equal(rejectedNonEquippableLock.executable, false);
assert.equal(rejectedNonEquippableLock.reason, "locked_item_resolution_failed");

const stats = await service.composeUnitStats({ champion: "奥恩", star: 1, items: ["无用大棒"] });
assert.equal(stats.executable, true);
assert.equal(stats.base_stats.ability_power, 100);
assert.equal(stats.composed_stats.ability_power, 110);
assert.deepEqual(stats.resolution_issues, []);

const overriddenAttackSpeed = await service.composeUnitStats({
  champion: "奥恩",
  items: ["密银黎明", "连指手套"],
});
assert.equal(overriddenAttackSpeed.executable, true);
assert.equal(overriddenAttackSpeed.composed_stats.attack_speed, 0.5);
assert.equal(overriddenAttackSpeed.item_conflicts.has_high_severity_conflict, true);
assert.equal(overriddenAttackSpeed.item_conflicts.effective_conflicts[0].conflict_type, "stat_override");
assert.deepEqual(overriddenAttackSpeed.item_conflicts.effective_conflicts[0].wasted_effects, [
  { item: "连指手套", effect: "attack_speed" },
]);
assert.deepEqual([...overriddenAttackSpeed.item_conflicts.effective_conflicts[0].preserved_effects].sort(), [
  "armor",
  "attack_damage",
  "control",
  "magic_resist",
  "omnivamp",
  "status_immunity",
]);
assert.equal(overriddenAttackSpeed.item_conflicts.compatibility_evidence.items.length, 2);
assert.ok(overriddenAttackSpeed.item_conflicts.compatibility_evidence.items.some((row) => (
  row.item === "连指手套" && row.effects.includes("attack_speed")
)));

const skillWoundOverlap = await service.composeUnitStats({
  champion: "绯红树怪",
  items: ["莫雷洛秘典"],
});
assert.ok(skillWoundOverlap.item_conflicts.semantic_conflicts.some((row) => (
  row.conflict_type === "effect_overlap"
  && row.effect === "wound"
  && row.source === "绯红树怪"
)));

const skillArmorShredOverlap = await service.composeUnitStats({
  champion: "纳尔",
  items: ["薄暮法袍"],
});
assert.ok(skillArmorShredOverlap.item_conflicts.semantic_conflicts.some((row) => (
  row.conflict_type === "effect_overlap"
  && row.effect === "armor_shred"
  && row.source === "纳尔"
)));

const itemShredOverlap = await service.composeUnitStats({
  champion: "纳尔",
  items: ["薄暮法袍", "最后的轻语"],
});
assert.ok(itemShredOverlap.item_conflicts.semantic_conflicts.some((row) => (
  row.conflict_type === "item_effect_overlap"
  && row.effect === "armor_shred"
)));

const uniqueItemViolation = await service.composeUnitStats({
  champion: "奥恩",
  items: ["大亨之铠", "大亨之铠"],
});
assert.ok(uniqueItemViolation.item_conflicts.semantic_conflicts.some((row) => (
  row.conflict_type === "unique_item_violation"
  && row.severity === "high"
)));

const conditionalItemEffect = await service.composeUnitStats({
  champion: "奥恩",
  items: ["正义之手"],
});
assert.ok(conditionalItemEffect.item_conflicts.semantic_conflicts.some((row) => (
  row.conflict_type === "conditional_effect_unverified"
  && row.item === "正义之手"
  && row.missing_facts.includes("current_unit_hp")
)));

const doubleStartup = await service.composeUnitStats({
  champion: "奥恩",
  items: ["朔极之矛", "蓝霸符"],
});
assert.ok(doubleStartup.item_conflicts.semantic_conflicts.some((row) => (
  row.conflict_type === "item_effect_overlap"
  && row.effect === "mana_gain"
  && row.severity === "low"
)));
assert.equal(doubleStartup.item_conflicts.has_high_severity_conflict, false);

const meleeDistanceEffect = await service.composeUnitStats({
  champion: "奥恩",
  items: ["顽强不屈"],
});
assert.equal(meleeDistanceEffect.item_conflicts.semantic_conflicts.some((row) => (
  row.conflict_type === "condition_mismatch"
)), false, "an effect mentioning melee distance is not a melee-holder restriction");

const augmentedStats = await service.composeUnitStats({ champion: "奥恩", augments: ["2705"] });
assert.equal(augmentedStats.composed_stats.ability_power, 104);
assert.ok(augmentedStats.applied_modifiers.some((row) => row.source_kind === "augment" && row.source_id === "2705"));

const unknownItem = await service.composeUnitStats({ champion: "奥恩", items: ["不存在的装备"] });
assert.equal(unknownItem.executable, false);
assert.equal(unknownItem.reason, "explicit_entity_resolution_failed");

const delayedItem = await service.composeUnitStats({ champion: "奥恩", items: ["海妖之怒"] });
assert.equal(delayedItem.composed_stats.attack_speed, delayedItem.base_stats.attack_speed * 1.1);
assert.ok(delayedItem.conditional_modifiers.some((row) => row.source_name === "海妖之怒" && row.metric === "attack_speed"));

const shieldExpiryItem = await service.composeUnitStats({ champion: "奥恩", items: ["冕卫"] });
assert.equal(shieldExpiryItem.composed_stats.ability_power, 120);
assert.equal(shieldExpiryItem.composed_stats.hp, shieldExpiryItem.base_stats.hp + 100);
assert.ok(shieldExpiryItem.conditional_modifiers.some((row) => row.source_name === "冕卫" && row.metric === "ability_power"));

const attackDamageItem = await service.composeUnitStats({ champion: "奥恩", items: ["朔极之矛"] });
assert.equal(attackDamageItem.composed_stats.attack_damage, attackDamageItem.base_stats.attack_damage * 1.15);

const roleConditionalItem = await service.composeUnitStats({ champion: "奥恩", items: ["适应性头盔"] });
assert.equal(roleConditionalItem.composed_stats.armor, 70);
assert.ok(roleConditionalItem.conditional_modifiers.some((row) => row.source_name === "适应性头盔"));

const traitCondition = await service.composeUnitStats({ champion: "奥恩", traits: [{ name: "重装战士", count: 2 }] });
assert.equal(traitCondition.composed_stats.hp, traitCondition.base_stats.hp);
assert.ok(traitCondition.conditional_modifiers.some((row) => row.source_name === "重装战士"));

const cast = await service.attacksToCast({ champion: "奥恩", items: ["朔极之矛"] });
assert.equal(cast.executable, true);
assert.equal(cast.formula_address, "jcc:common:formula:attacks_to_cast");
assert.equal(cast.output.mana_per_attack, 15);
assert.equal(cast.output.minimum_basic_attacks_to_first_cast, 4);

const stars = await service.calculate({ operation: "star_upgrade_copies", target_star: 3 });
assert.equal(stars.executable, true);
assert.equal(stars.output.base_copy_cost, 9);

const playerDamage = await service.calculateQuestion("五阶段失败，对面还剩3个棋子会扣多少血", { stage: 5 });
assert.equal(playerDamage.executable, true);
assert.equal(playerDamage.output.stage_base_damage, 10);
assert.equal(playerDamage.output.total_player_damage, 13);

const economy = await service.calculateQuestion("这回合收入和利息是多少", { round: "1-4", gold: 7, streak: 0, pvp_result: "none" });
assert.equal(economy.executable, true);
assert.equal(economy.output.base_income, 3);
assert.equal(economy.output.next_gold, 10);

const levelTiming = await service.calculateQuestion("我从7级升8级还需要多少经验和金币", { level: 7, xp: 0, gold: 60 });
assert.equal(levelTiming.executable, true);
assert.equal(levelTiming.output.xp_needed, 56);
assert.equal(levelTiming.output.gold_needed, 56);

const combatDamage = await service.calculateQuestion("按这些数据算单次伤害和击杀次数", {
  damage_type: "true", base_damage: 100, damage_amp_pct: 15,
  critical_chance: 80, critical_damage_multiplier: 140,
  durability_pct: 10, health: 3000, shield: 0,
});
assert.equal(combatDamage.executable, true);
assert.equal(combatDamage.output.hits_to_kill, 22);

const shop = await service.shopOdds({ champion: "奥恩", level: 8 });
assert.equal(shop.executable, true);
assert.equal(shop.output.per_slot_cost_odds, 0.15);
assert.equal(shop.profile.parameter_authority, "common_user_confirmed_standard");
assert.equal(shop.confidence, "exact_if_current_shop_parameters_and_pool_state_are_known");
assert.ok(shop.assumptions.some((row) => row.includes("authoritative Common standard")));
assert.ok(shop.output.estimated_specific_unit_hit_odds > 0);
const levelSevenFiveCostShop = await service.shopOdds({ champion: "拉露恩", level: 7 });
assert.equal(levelSevenFiveCostShop.executable, true);
assert.equal(levelSevenFiveCostShop.output.per_slot_cost_odds, 0.01,
  "the one-percent level-seven five-cost rate must remain one percent, not one hundred percent");

const depletedWithoutPool = await service.shopOdds({ champion: "奥恩", level: 8, remaining_copies: 1 });
assert.equal(depletedWithoutPool.executable, false);
assert.equal(depletedWithoutPool.reason, "pool_total_required_for_depleted_target_estimate");

for (const invalidPoolTotal of ["unknown", -1, 0, 1.5]) {
  const invalidPool = await service.shopOdds({ champion: "奥恩", level: 8, remaining_copies: 1, pool_total_for_cost: invalidPoolTotal });
  assert.equal(invalidPool.executable, false);
  assert.equal(invalidPool.reason, "invalid_pool_total_for_cost");
}

const impossiblePool = await service.shopOdds({ champion: "奥恩", level: 8, remaining_copies: 5, pool_total_for_cost: 4 });
assert.equal(impossiblePool.executable, false);
assert.equal(impossiblePool.reason, "remaining_copies_exceed_pool_total");

const unsupportedLevel = await service.shopOdds({ champion: "奥恩", level: 11 });
assert.equal(unsupportedLevel.executable, false);
assert.equal(unsupportedLevel.reason, "shop_level_not_in_active_parameter_table");

const sprite = await service.composeUnitStats({ champion: "奥恩", season_mechanics: ["181074"] });
assert.equal(sprite.executable, true);
assert.ok(sprite.conditional_modifiers.some((row) => row.source_kind === "season_mechanic" && row.source_id === "181074"));

const theoreticalItems = await service.optimizeItemLoadouts({ champion: "奥恩" });
assert.equal(theoreticalItems.executable, true);
assert.equal(theoreticalItems.evidence_policy, "active_core_profile_only_no_rankings");
assert.ok(theoreticalItems.source_audit.used_source_kinds.includes("common_formula_kernel"));
assert.ok(theoreticalItems.source_audit.used_source_kinds.includes("captured_core_profile_item_catalog"));
assert.ok(theoreticalItems.source_audit.excluded_source_kinds.includes("daily_rankings"));
assert.ok(theoreticalItems.source_audit.excluded_source_kinds.includes("strategy_wiki"));
assert.deepEqual(theoreticalItems.candidate_scope.categories, ["completed"]);
assert.ok(theoreticalItems.evaluated_loadout_count > 1000);
for (const recommendation of [
  theoreticalItems.recommendations.max_auto_attack_damage_proxy,
  theoreticalItems.recommendations.max_spell_power_proxy,
  theoreticalItems.recommendations.fastest_first_cast_proxy,
  theoreticalItems.recommendations.balanced_equal_weight_proxy,
]) {
  assert.ok(recommendation?.items?.length === 3);
  assert.ok(recommendation.items.every((item) => item.category === "completed"));
}

const theoreticalArtifact = await service.optimizeItemLoadouts({
  champion: "奥恩",
  allowed_item_categories: ["artifact"],
});
assert.equal(theoreticalArtifact.executable, true);
assert.deepEqual(theoreticalArtifact.candidate_scope.categories, ["artifact"]);
assert.ok(theoreticalArtifact.recommendations.balanced_equal_weight_proxy.items.every((item) => item.category === "artifact"));

const theoreticalWithCurrentItems = await service.optimizeItemLoadouts({
  champion: "奥恩",
  current_items: ["无用大棒"],
});
assert.deepEqual(theoreticalWithCurrentItems.current_loadout_baseline.items.map((item) => item.name), ["无用大棒"]);
assert.equal(theoreticalWithCurrentItems.current_loadout_baseline.metrics.ability_power, 110);
assert.equal(theoreticalWithCurrentItems.candidate_scope.current_items_locked, true);
assert.ok(Object.values(theoreticalWithCurrentItems.recommendations)
  .flatMap((entry) => Array.isArray(entry) ? entry : [entry])
  .filter(Boolean)
  .every((entry) => entry.items.some((item) => item.name === "无用大棒")));

const fullCurrentLoadout = await service.optimizeItemLoadouts({
  champion: "奥恩",
  current_items: ["无用大棒", "暴风之剑", "反曲之弓"],
});
assert.equal(fullCurrentLoadout.evaluated_loadout_count, 1);
assert.deepEqual(fullCurrentLoadout.recommendations.balanced_equal_weight_proxy.items.map((item) => item.name), [
  "无用大棒",
  "暴风之剑",
  "反曲之弓",
]);

const replaceCurrentLoadout = await service.optimizeItemLoadouts({
  champion: "奥恩",
  current_items: ["无用大棒", "暴风之剑", "反曲之弓"],
  replace_current_items: true,
});
assert.equal(replaceCurrentLoadout.candidate_scope.current_items_locked, false);
assert.ok(replaceCurrentLoadout.evaluated_loadout_count > 1000);

const ownedSpecialItem = await service.optimizeItemLoadouts({
  champion: "奥恩",
  current_items: ["大亨之铠"],
});
assert.equal(ownedSpecialItem.executable, true);
assert.deepEqual(ownedSpecialItem.candidate_scope.categories, ["completed"]);
assert.ok(ownedSpecialItem.recommendations.balanced_equal_weight_proxy.items.some((item) => (
  item.name === "大亨之铠" && item.category === "artifact"
)));

const explicitSupportPool = await service.optimizeItemLoadouts({
  champion: "奥恩",
  allowed_item_categories: ["support"],
});
assert.equal(explicitSupportPool.executable, false);
assert.equal(explicitSupportPool.reason, "no_legal_item_loadouts");
assert.deepEqual(explicitSupportPool.details.categories, ["support"]);

const duplicateCurrentItems = await service.optimizeItemLoadouts({
  champion: "奥恩",
  current_items: ["无用大棒", "无用大棒"],
});
assert.equal(duplicateCurrentItems.executable, true);
assert.equal(duplicateCurrentItems.candidate_scope.locked_items.length, 2);
assert.deepEqual(duplicateCurrentItems.candidate_scope.locked_items.map((item) => item.name), ["无用大棒", "无用大棒"]);
assert.ok(Object.values(duplicateCurrentItems.recommendations)
  .flatMap((entry) => Array.isArray(entry) ? entry : [entry])
  .filter(Boolean)
  .every((entry) => entry.items.filter((item) => item.name === "无用大棒").length === 2));

const duplicatedSlotInputs = theorycraftDecisionInputs({
  match_session_id: "adapter-item-copies",
  own_board: {
    units: [{ name: "奥恩", star: 2, items: ["无用大棒", "无用大棒"] }],
  },
}, {
  target_plan: { primary_carry: "奥恩" },
  user_confirmed_equipment: {
    match_session_id: "adapter-item-copies",
    equipped_items: [
      { name: "无用大棒", owner_unit: "奥恩", slot: 1 },
      { name: "无用大棒", owner_unit: "奥恩", slot: 2 },
    ],
    confirmed_fields: { equipped_items: true },
  },
});
assert.deepEqual(
  duplicatedSlotInputs.current_items,
  ["无用大棒", "无用大棒"],
  "the Runtime adapter must preserve physical copies while coalescing duplicate observations across board and equipment sources",
);
const duplicatedSlotOptimization = await service.optimizeItemLoadouts(duplicatedSlotInputs);
assert.equal(duplicatedSlotOptimization.executable, true, JSON.stringify(duplicatedSlotOptimization));
assert.equal(duplicatedSlotOptimization.candidate_scope.locked_items.length, 2, "adapter-to-solver flow must lock both physical item copies");

const augmentChoices = await service.evaluateAugmentEffectChoices({
  candidates: ["存心失利", "花到上头"],
  current_facts: { gold: 20, expected_future_player_combats: 4 },
  rule_modifiers: [{
    candidate: "花到上头",
    dimensions: { economy: 2, risk: 1 },
    reason: "Current economy can absorb the lost-interest tradeoff.",
  }],
});
assert.equal(augmentChoices.executable, true);
assert.equal(augmentChoices.evidence_policy, "active_core_profile_only_no_rankings");
assert.equal(augmentChoices.candidates.length, 2);
assert.ok(augmentChoices.candidates.every((row) => [
  "immediate", "economy", "growth", "conditional", "risk",
].every((dimension) => Number.isFinite(row.dimensions[dimension]))));
assert.ok(augmentChoices.candidates.find((row) => row.name === "花到上头").effect_blocks.length >= 2);
assert.ok(augmentChoices.pareto_frontier.length >= 1);
assert.ok(augmentChoices.source_audit.excluded_source_kinds.includes("daily_rankings"));

const legalSilverAugmentSet = await service.evaluateAugmentEffectChoices({ tier: "silver" });
assert.equal(legalSilverAugmentSet.executable, true);
assert.equal(legalSilverAugmentSet.candidate_source, "active_decision_catalog_legal_set");
assert.ok(legalSilverAugmentSet.candidates.length > 1);
assert.ok(legalSilverAugmentSet.candidates.every((row) => row.tier === "1"));

const invalidAugmentChoice = await service.evaluateAugmentEffectChoices({
  candidates: ["不存在的强化"],
});
assert.equal(invalidAugmentChoice.executable, false);
assert.equal(invalidAugmentChoice.reason, "augment_candidate_resolution_failed");

const rosterSkeleton = await service.solveTraitRosterRoleCoverage({
  population: 6,
  main_carry: "洛",
  main_tank: "奥恩",
  owned_units: ["蕾欧娜"],
  emblems: [{ trait: "永恒之森", holder: "洛" }],
  target_traits: [{ trait: "永恒之森", count: 4 }],
});
assert.equal(rosterSkeleton.executable, true);
assert.equal(rosterSkeleton.evidence_policy, "active_core_profile_only_no_rankings");
assert.equal(rosterSkeleton.roster.length, 6);
assert.equal(new Set(rosterSkeleton.roster.map((unit) => unit.id)).size, 6);
assert.ok(rosterSkeleton.roster.some((unit) => unit.name === "洛" && unit.roles.includes("main_carry")));
assert.ok(rosterSkeleton.roster.some((unit) => unit.name === "奥恩" && unit.roles.includes("main_tank")));
assert.equal(rosterSkeleton.role_coverage.main_carry, true);
assert.equal(rosterSkeleton.role_coverage.main_tank, true);
assert.ok(rosterSkeleton.trait_coverage.some((trait) => trait.name === "永恒之森" && trait.emblem_count === 1));
assert.equal(rosterSkeleton.claim_boundaries.strength_estimate, false);
assert.equal(rosterSkeleton.claim_boundaries.combat_simulation, false);
assert.ok(Number.isFinite(rosterSkeleton.cost.total_shop_cost));
assert.equal(rosterSkeleton.cost.star_target_costs_included, true);
assert.equal(rosterSkeleton.cost.target_roster_purchase_cost,
  rosterSkeleton.cost.roster_purchase_cost,
  "default two-star/three-star targets are only applied when the archetype declares them");

const routedAugmentChoices = await service.calculateQuestion("这三个强化怎么选", {
  force_theorycraft: true,
  candidates: ["存心失利", "花到上头"],
});
assert.equal(routedAugmentChoices.operation, "evaluate_augment_effect_choices");

const routedRosterSkeleton = await service.calculateQuestion("围绕永恒之森构造一个合法阵容骨架", {
  force_theorycraft: true,
  population: 4,
  main_carry: "洛",
  main_tank: "奥恩",
});
assert.equal(routedRosterSkeleton.operation, "solve_trait_roster_role_coverage");
assert.ok(routedRosterSkeleton.trait_coverage.some((trait) => trait.name === "永恒之森" && trait.target_count === 3));

const routedRosterWithIncidentalEmblemToken = await service.calculateQuestion("我有永恒之森纹章，围绕永恒之森羁绊构造一个合法阵容骨架", {
  force_theorycraft: true,
  population: 4,
  main_carry: "洛",
  main_tank: "奥恩",
});
assert.equal(routedRosterWithIncidentalEmblemToken.operation, "solve_trait_roster_role_coverage");
assert.ok(routedRosterWithIncidentalEmblemToken.emblems.some((entry) => entry.trait.name === "永恒之森" && entry.count === 1));
assert.ok(routedRosterWithIncidentalEmblemToken.trait_coverage.some((trait) => (
  trait.name === "永恒之森" && trait.emblem_count === 1 && trait.target_count === 3
)));

const routedRosterWithPrefixEmblemToken = await service.calculateQuestion("用纹章永恒之森搭一个永恒之森羁绊阵容", {
  force_theorycraft: true,
  population: 4,
  main_carry: "洛",
  main_tank: "奥恩",
});
assert.equal(routedRosterWithPrefixEmblemToken.operation, "solve_trait_roster_role_coverage");
assert.ok(routedRosterWithPrefixEmblemToken.emblems.some((entry) => entry.trait.name === "永恒之森"));

const openHighCapRoster = await service.calculateQuestion(
  "按照当前版本硬数据，给我一套有羁绊的最高上限95阵容，并给出6人口和8人口过渡",
  { force_theorycraft: true },
);
assert.equal(openHighCapRoster.operation, "solve_trait_roster_role_coverage");
assert.equal(openHighCapRoster.executable, true);
assert.equal(openHighCapRoster.population, 9);
assert.equal(openHighCapRoster.occupied_population, 9);
assert.equal(openHighCapRoster.core_selection.mode, "deterministic_auto_selection");
assert.equal(openHighCapRoster.core_selection.selection_owner, "agent");
assert.equal(openHighCapRoster.core_selection.selection_status, "deterministic_fallback_until_agent_comparison");
assert.equal(openHighCapRoster.semantic_seed?.schema, "jcc-semantic-seed-v1");
assert.equal(openHighCapRoster.mechanical_expansion_plan?.schema, "jcc-mechanical-expansion-plan-v1");
assert.ok(openHighCapRoster.candidate_frontier?.length >= 2);
assert.equal(openHighCapRoster.candidate_frontier_contract?.requested_count, 1,
  "the Chinese one-set request must preserve the final display count");
assert.ok(openHighCapRoster.candidate_frontier_contract?.frontier_requested_count >= 8,
  "the internal frontier must remain broader than the final display request");
assert.ok(openHighCapRoster.candidate_frontier.every((candidate) => (
  candidate.seed_id === openHighCapRoster.semantic_seed.seed_id
  && candidate.selection_owner === "agent"
  && candidate.expansion_owner === "runtime_deterministic"
)));
assert.ok(openHighCapRoster.roster.length <= openHighCapRoster.population);
assert.equal(openHighCapRoster.roster.reduce((sum, unit) => sum + (unit.population_cost || 1), 0), 9);
assert.ok(openHighCapRoster.roster.some((unit) => unit.cost === 5 && unit.roles.includes("main_carry")));
assert.ok(openHighCapRoster.roster.some((unit) => unit.cost >= 4 && unit.roles.includes("main_tank")));
assert.ok(openHighCapRoster.roster.every((unit) => unit.traits.length > 0));
assert.ok(openHighCapRoster.roster.every((unit) => unit.skill?.name && unit.skill?.summary));
assert.ok(openHighCapRoster.roster.filter((unit) => unit.cost >= 4).length >= 3,
  "the final high-cap board must prefer high-cost support after satisfying legal trait coverage");
assert.ok(openHighCapRoster.roster.some((unit) => unit.cost < 5),
  "a 95 board must not mechanically become nine unrelated five-cost champions");
assert.ok(openHighCapRoster.trait_coverage.some((trait) => trait.achieved_breakpoint));
assert.ok(openHighCapRoster.candidate_rosters.length >= 2);
assert.deepEqual(openHighCapRoster.transitions.map((transition) => transition.population), [6, 8]);
assert.ok(openHighCapRoster.transitions.every((transition) => (
  transition.occupied_population === transition.population
  && transition.roster.reduce((sum, unit) => sum + (unit.population_cost || 1), 0) === transition.population
  && transition.temporary_main_carry
  && transition.temporary_main_tank
  && transition.equipment_continuity
)));

const fiveRequestedHighCapRosters = await service.calculateQuestion(
  "按照当前版本硬数据，给我5套有羁绊的最高上限95阵容",
  { force_theorycraft: true },
);
assert.equal(fiveRequestedHighCapRosters.candidate_frontier_contract?.requested_count, 5,
  "an explicit lineup count must be preserved as the display request");
assert.ok(fiveRequestedHighCapRosters.candidate_frontier_contract?.frontier_requested_count >= 8,
  "an explicit display count must not shrink the internal frontier below its bounded default");

const explicitHighCapAtLevelSeven = await activeService.calculateQuestion(
  "别吃大数据，按九五目标给我一套有羁绊的最终阵容",
  { force_theorycraft: true, level: 7 },
);
assert.equal(explicitHighCapAtLevelSeven.operation, "solve_trait_roster_role_coverage");
assert.equal(explicitHighCapAtLevelSeven.population, 9,
  "an explicit 95 target must not be truncated to the current level");
assert.equal(explicitHighCapAtLevelSeven.occupied_population, 9);

const threeCostTheorycraft = await activeService.calculateQuestion(
  "别吃大数据，给我一套三费主C的赌狗阵容，说明满质量和后期补位",
  { force_theorycraft: true },
);
assert.equal(threeCostTheorycraft.operation, "solve_trait_roster_role_coverage");
assert.equal(threeCostTheorycraft.executable, true);
assert.equal(threeCostTheorycraft.archetype?.id, "three_cost_reroll");
assert.equal(threeCostTheorycraft.semantic_seed?.archetype, "three_cost_reroll");
assert.ok(threeCostTheorycraft.mechanical_expansion_plan?.required_expansions.includes("formation_burden"));
assert.equal(threeCostTheorycraft.roster.find((unit) => unit.roles.includes("main_carry"))?.cost, 3,
  "three-cost carry intent must constrain automatic core selection");
assert.equal(threeCostTheorycraft.economy_profile?.star_target_purchase_cost, 27,
  "a declared three-star three-cost carry must consume 27 gold in the target roster cost");
assert.ok(threeCostTheorycraft.economy_profile?.target_roster_purchase_cost >= 27);
assert.equal(threeCostTheorycraft.occupied_population, threeCostTheorycraft.population);
assert.equal(threeCostTheorycraft.formation_profile?.schema, "jcc-lineup-formation-profile-v2");
assert.deepEqual(
  threeCostTheorycraft.phase_plans?.map((phase) => phase.population),
  [7, 8],
  "three-cost reroll theory must expose a level-seven stabilize phase and a level-eight upgrade phase",
);
const threeCostStagePlan = threeCostTheorycraft.phase_plans.find((phase) => phase.population === 7);
assert.equal(threeCostStagePlan.stage_status, "concrete_stage_roster");
assert.equal(threeCostStagePlan.roster.reduce((sum, unit) => sum + (unit.population_cost || 1), 0), 7,
  "the reported level-seven stage roster must occupy the full requested population");
assert.ok(threeCostStagePlan.roster.every((unit) => unit.cost <= 3),
  "the reported level-seven stage roster must not contain the future four-cost tank");
assert.ok(threeCostStagePlan.temporary_main_tank?.cost <= 3);
assert.ok(threeCostStagePlan.future_main_tank == null || threeCostStagePlan.future_main_tank.cost >= 4);

const threeCostLevelSeven = await activeService.solveTraitRosterRoleCoverage({
  population: 7,
  archetype: { id: "three_cost_reroll", carry_cost: 3 },
  auto_select_cores: true,
});
assert.equal(threeCostLevelSeven.executable, true);
assert.ok(threeCostLevelSeven.roster.every((unit) => unit.cost <= 3),
  "a level-seven three-cost reroll core must not require four- or five-cost units");
assert.equal(threeCostLevelSeven.formation_profile.max_core_unit_cost, 3);
assert.equal(threeCostLevelSeven.feasibility.status, "conditional");

const invalidThreeCostLevelSeven = await activeService.solveTraitRosterRoleCoverage({
  population: 7,
  archetype: { id: "three_cost_reroll", carry_cost: 3 },
  main_carry: "克格莫",
  main_tank: "塔里克",
  auto_select_cores: false,
});
assert.equal(invalidThreeCostLevelSeven.executable, false);
assert.equal(invalidThreeCostLevelSeven.reason, "lineup_stage_feasibility_blocked");
assert.ok(invalidThreeCostLevelSeven.details.rejection_reasons.some((reason) => (
  reason.code === "required_stage_core_contains_unavailable_high_cost_units"
)));

const threeCostLevelEightSupport = await activeService.solveTraitRosterRoleCoverage({
  population: 8,
  archetype: { id: "three_cost_reroll", carry_cost: 3 },
  main_carry: "克格莫",
  main_tank: "苍蓝雕纹魔像",
  auto_select_cores: false,
});
assert.equal(threeCostLevelEightSupport.executable, true,
  "a three-cost core may legitimately add a four-cost key tank at level eight");
assert.equal(threeCostLevelEightSupport.formation_profile.max_core_unit_cost, 4);

const twoCostLifecycle = await activeService.calculateQuestion(
  "别吃大数据，给我一套二费主C赌狗，说明6级D和8级补强",
  { force_theorycraft: true },
);
assert.equal(twoCostLifecycle.operation, "solve_trait_roster_role_coverage");
assert.deepEqual(twoCostLifecycle.phase_plans?.map((phase) => phase.population), [6, 8]);
assert.ok(twoCostLifecycle.phase_plans.find((phase) => phase.population === 6).roster
  .every((unit) => unit.cost <= 2));

const delayedLegendaryPlan = await activeService.solveTraitRosterRoleCoverage({
  population: 9,
  archetype: { id: "legendary_cap", carry_cost: 5 },
  auto_select_cores: true,
});
assert.equal(delayedLegendaryPlan.executable, true);
assert.ok(delayedLegendaryPlan.phase_plans.some((phase) => phase.phase === "level_8_startup"),
  "95 must expose an eight-population startup decision before the nine-population cap");
assert.ok(delayedLegendaryPlan.phase_plans.some((phase) => phase.phase === "level_9_upgrade"),
  "95 must expose the nine-population cap phase");

const fourCostRerollTheorycraft = await activeService.calculateQuestion(
  "别吃大数据，盗宗怎么运营，三星四费前不上九",
  { force_theorycraft: true },
);
assert.equal(fourCostRerollTheorycraft.operation, "solve_trait_roster_role_coverage");
assert.equal(fourCostRerollTheorycraft.executable, true);
assert.equal(fourCostRerollTheorycraft.archetype?.id, "four_cost_carry");
assert.equal(fourCostRerollTheorycraft.population, 8);
assert.equal(fourCostRerollTheorycraft.roster.find((unit) => unit.roles.includes("main_carry"))?.cost, 4);

const eightFourTheorycraft = await activeService.calculateQuestion(
  "给我一套84阵容，不要把它理解成八张四费卡",
  { force_theorycraft: true },
);
assert.equal(eightFourTheorycraft.operation, "solve_trait_roster_role_coverage");
assert.equal(eightFourTheorycraft.executable, true);
assert.equal(eightFourTheorycraft.population, 8);
assert.equal(eightFourTheorycraft.archetype?.id, "four_cost_carry");
assert.equal(eightFourTheorycraft.roster.find((unit) => unit.roles.includes("main_carry"))?.cost, 4);

const topPredatorSemantics = await activeService.solveTraitRosterRoleCoverage({
  population: 3,
  main_carry: "远古巨龙",
  main_tank: "拉克丝",
  target_traits: [{ trait: "峡谷野怪", count: 2 }],
});
assert.equal(topPredatorSemantics.executable, true);
const dragonUnit = topPredatorSemantics.roster.find((unit) => unit.name === "远古巨龙");
assert.equal(dragonUnit?.population_cost, 2);
assert.ok(topPredatorSemantics.trait_coverage.some((trait) => (
  trait.name === "峡谷野怪" && trait.count >= 2
)), "远古巨龙必须占两人口并贡献两层峡谷野怪");
assert.equal(topPredatorSemantics.occupied_population, 3);

const grandElementalistSemantics = await activeService.solveTraitRosterRoleCoverage({
  population: 3,
  main_carry: "拉克丝",
  main_tank: "奥恩",
  selected_variants: { "5459": "451" },
  target_traits: [{ trait: "黑荆棘", count: 2 }],
});
assert.equal(grandElementalistSemantics.executable, true);
const luxUnit = grandElementalistSemantics.roster.find((unit) => unit.name === "拉克丝");
assert.equal(luxUnit?.population_cost, 1);
assert.ok(grandElementalistSemantics.trait_coverage.some((trait) => (
  trait.name === "黑荆棘" && trait.count >= 2
)), "大元素使选定形态必须为黑荆棘贡献两层羁绊");
assert.ok(grandElementalistSemantics.trait_coverage.some((trait) => (
  trait.name === "大元素使" && trait.count >= 1
)));
assert.equal(openHighCapRoster.claim_boundaries.ranking_recommendation, false);
assert.equal(openHighCapRoster.claim_boundaries.theoretical_high_cap_proxy_only, true);

const completeTheorycraftRequest = await service.calculateQuestion(
  "别吃大数据，给我一套有羁绊的95阵容，说明6人口和8人口过渡、装备通用和强化选择",
  { force_theorycraft: true },
);
assert.equal(completeTheorycraftRequest.operation, "compose_theorycraft_decision");
assert.equal(completeTheorycraftRequest.executable, true);
assert.equal(completeTheorycraftRequest.components.lineup?.population, 9);
assert.deepEqual(completeTheorycraftRequest.components.lineup?.transitions?.map((row) => row.population), [6, 8]);
assert.ok(completeTheorycraftRequest.components.lineup?.roster?.length >= 1);
assert.equal(
  completeTheorycraftRequest.components.lineup.roster.reduce((sum, unit) => sum + Number(unit.population_cost || 0), 0),
  completeTheorycraftRequest.components.lineup.population,
  "theorycraft roster must account for every occupied population slot",
);
assert.equal(
  new Set(completeTheorycraftRequest.components.lineup.roster.map((unit) => String(unit.id))).size,
  completeTheorycraftRequest.components.lineup.roster.length,
  "theorycraft roster must remain an atomic list of unique units",
);
assert.ok(completeTheorycraftRequest.components.lineup.roster.some((unit) => (
  Array.isArray(unit.roles) && unit.roles.includes("main_carry")
)));
assert.equal(completeTheorycraftRequest.components.itemization?.executable, true);
assert.ok(completeTheorycraftRequest.components.itemization?.recommendations?.balanced_equal_weight_proxy);
assert.equal(completeTheorycraftRequest.components.augments?.executable, true);
assert.ok(completeTheorycraftRequest.components.augments?.candidate_count_before_compaction > 12);
assert.ok(completeTheorycraftRequest.components.augments?.candidates.length <= 12);
assert.equal(completeTheorycraftRequest.claim_boundaries.ranking_strength, false);
assert.ok(Buffer.byteLength(JSON.stringify(completeTheorycraftRequest), "utf8") <= 512 * 1024,
  "complete multi-domain Core evidence must fit the current-turn delta ceiling");

const threeCostTheorycraftWithArtifacts = await service.calculateQuestion(
  "别吃大数据，给我一套3费主C赌狗阵容，同时推荐理论装备和理论神器以及上限",
  { force_theorycraft: true },
);
assert.equal(threeCostTheorycraftWithArtifacts.operation, "compose_theorycraft_decision");
assert.equal(threeCostTheorycraftWithArtifacts.components.lineup?.archetype?.id, "three_cost_reroll");
assert.equal(threeCostTheorycraftWithArtifacts.components.itemization?.executable, true);
assert.ok(threeCostTheorycraftWithArtifacts.components.itemization?.candidate_scope?.categories.includes("artifact"));
assert.ok(threeCostTheorycraftWithArtifacts.components.itemization?.recommendations?.balanced_equal_weight_proxy?.items
  .every((item) => ["completed", "artifact"].includes(item.category)));

const mathWordMultiDomainRequest = await service.calculateQuestion(
  "给我一套伤害上限高的95阵容，同时推荐装备和强化",
  { force_theorycraft: true },
);
assert.equal(mathWordMultiDomainRequest.operation, "compose_theorycraft_decision");
assert.equal(mathWordMultiDomainRequest.components.lineup?.executable, true);
assert.equal(mathWordMultiDomainRequest.components.itemization?.executable, true);
assert.equal(mathWordMultiDomainRequest.components.augments?.executable, true);

const championDetailAndItemRequest = await service.calculateQuestion(
  "奥恩的技能和装备怎么配？",
  { force_theorycraft: true },
);
assert.equal(championDetailAndItemRequest.operation, "compose_theorycraft_decision");
assert.ok(championDetailAndItemRequest.components.entity_details?.entities
  .some((entity) => entity.kind === "champion" && entity.name === "奥恩"));
assert.equal(championDetailAndItemRequest.components.itemization?.executable, true);
assert.equal(championDetailAndItemRequest.components.lineup, null);

const championDetailItemAugmentRequest = await service.calculateQuestion(
  "拉露恩的属性、装备和强化怎么选？",
  { force_theorycraft: true },
);
assert.equal(championDetailItemAugmentRequest.operation, "compose_theorycraft_decision");
assert.ok(championDetailItemAugmentRequest.components.entity_details?.entities
  .some((entity) => entity.kind === "champion" && entity.name === "拉露恩"));
assert.equal(championDetailItemAugmentRequest.components.itemization?.executable, true);
assert.equal(championDetailItemAugmentRequest.components.augments?.executable, true);

const incidentalPrefixAliasRequest = await service.calculateQuestion(
  "奥恩的羁绊是什么，顺便推荐装备",
  { force_theorycraft: true },
);
assert.equal(incidentalPrefixAliasRequest.operation, "compose_theorycraft_decision");
assert.equal(incidentalPrefixAliasRequest.components.augments, null,
  "derived first-character aliases must not create an unrequested augment domain");

const championPrefixPollution = await service.calculateQuestion("这套阵容费用高吗？", {
  force_theorycraft: true,
});
assert.equal(championPrefixPollution.entities?.some((entity) => entity.name === "费德提克") || false, false);
assert.notEqual(championPrefixPollution.operation, "query_core_entities");

const lineupCorrectionFollowup = await service.calculateQuestion(
  "你这不就是九张五费卡吗？一点羁绊都没有啊",
  { force_theorycraft: true },
);
assert.equal(lineupCorrectionFollowup.operation, "solve_trait_roster_role_coverage");
assert.equal(lineupCorrectionFollowup.executable, true);
assert.equal(lineupCorrectionFollowup.population, 9);
assert.ok(lineupCorrectionFollowup.trait_coverage.some((trait) => trait.achieved_breakpoint));
assert.ok(lineupCorrectionFollowup.roster.some((unit) => unit.cost < 5));

const championDetail = await service.calculateQuestion("拉露恩的技能、羁绊和属性是什么？", {
  force_theorycraft: true,
});
assert.equal(championDetail.operation, "query_core_entities");
assert.equal(championDetail.executable, true);
const laruneDetail = championDetail.entities.find((entity) => entity.kind === "champion" && entity.name === "拉露恩");
assert.ok(laruneDetail?.skill?.summary);
assert.ok(laruneDetail?.traits?.length >= 2);
assert.ok(laruneDetail?.attributes_by_star?.生命?.length >= 1);

const championAliasDetail = await activeService.calculateQuestion("小鸡的技能和羁绊是什么？", {
  force_theorycraft: true,
});
assert.equal(championAliasDetail.operation, "query_core_entities");
assert.ok(championAliasDetail.entities.some((entity) => entity.kind === "champion" && entity.name === "深红锋喙鸟"));

const perStarSkillDetail = await activeService.calculateQuestion("纳尔每个星级的技能是什么？", {
  force_theorycraft: true,
});
const gnarSkill = perStarSkillDetail.entities.find((entity) => entity.kind === "champion" && entity.name === "纳尔")?.skill;
assert.match(gnarSkill?.descriptions_by_star?.["3"] || "", /每次攻击提供20怒气/u);
assert.match(gnarSkill?.descriptions_by_star?.["3"] || "", /15000/u);
assert.ok(Object.keys(gnarSkill?.values_by_star || {}).length >= 3);

const attributeAliasCollision = await activeService.calculateQuestion("这个英雄的攻速属性怎么算？", {
  force_theorycraft: true,
});
assert.notEqual(attributeAliasCollision.operation, "query_core_entities");
assert.equal(attributeAliasCollision.entities?.some((entity) => entity.name === "反曲之弓") || false, false);

const overlappingAliasDetail = await activeService.calculateQuestion("龙牙这个装备是什么效果？", {
  force_theorycraft: true,
});
assert.equal(overlappingAliasDetail.operation, "query_core_entities");
assert.ok(overlappingAliasDetail.entities.some((entity) => entity.kind === "item" && entity.name === "巨龙之爪"));
assert.equal(overlappingAliasDetail.entities.some((entity) => entity.kind === "champion" && entity.name === "远古巨龙"), false);

const tooManyMissingInputs = await service.optimizeItemLoadouts({
  champion: "奥恩",
  missing_material_inputs: ["main_carry_star", "selected_augments", "active_traits_and_breakpoints"],
});
assert.equal(tooManyMissingInputs.executable, false);
assert.equal(tooManyMissingInputs.reason, "material_inputs_required_before_optimization");

const missingOptimizerChampion = await service.optimizeItemLoadouts({});
assert.equal(missingOptimizerChampion.executable, false);
assert.equal(missingOptimizerChampion.reason, "champion_required_for_item_optimizer");

const missing = await service.calculateQuestion("这个棋子大概几下能施法？");
assert.equal(missing.executable, false);
assert.equal(missing.reason, "champion_resolution_failed");

await assert.rejects(
  () => createDecisionMathService({
    hardDataPackageDir: packageDir,
    coreProfileFile: candidateProfileFile,
    decisionInputCatalogFile: candidateCatalogFile,
    expectedIdentity: { ...candidateIdentity, season_id: "s17" },
  }),
  /decision_math_identity_mismatch:season_id/,
);

await assert.rejects(
  () => createDecisionMathService({
    hardDataPackageDir: packageDir,
    coreProfileFile: candidateProfileFile,
    decisionInputCatalogFile: candidateCatalogFile,
    expectedIdentity: { ...candidateIdentity, core_profile_id: "forged-core-profile" },
  }),
  /decision_math_identity_mismatch:core_profile_id/,
);

await assert.rejects(
  () => createDecisionMathService({ hardDataPackageDir: packageDir, expectedIdentity: candidateIdentity }),
  /decision_math_identity_artifacts_required/,
);

const profiledFailure = await service.composeUnitStats({ champion: "不存在的英雄" });
assert.equal(profiledFailure.executable, false);
assert.equal(profiledFailure.profile.core_profile_id, candidateProfile.combined_fingerprint);


const evaluatorSource = await readFile(path.join(repoRoot, "tools", "jcc-formula-evaluator.mjs"), "utf8");
assert.equal(evaluatorSource.includes("activeHardDataPackageDir"), false);
assert.match(evaluatorSource, /COMMON_KNOWLEDGE_DIR/);

const runtimeSource = await readFile(path.join(repoRoot, "ui", "electron", "runtime-service.js"), "utf8");
assert.match(runtimeSource, /createDecisionMathService/);
assert.match(runtimeSource, /decision_math_intent/);
assert.match(runtimeSource, /decision_math_context/);
assert.match(runtimeSource, /expectedIdentity/);
assert.match(runtimeSource, /activeDecisionInputCatalogSourceIdentity/);

process.stdout.write(`${JSON.stringify({
  ok: true,
  assertions: [
    "Common formula kernel",
    "S18 version parameters",
    "item stat composition",
    "unconditional augment composition",
    "explicit unresolved entity fails closed",
    "conditional item effects remain conditional",
    "trait prose does not mutate permanent stats",
    "attack-to-cast baseline",
    "star-up copy rule",
    "PVP player-damage routing",
    "economy and income routing",
    "level and XP routing",
    "single-hit combat-damage routing",
    "shop odds",
    "depleted-pool estimate requires total pool state",
    "invalid and impossible pool state fails closed",
    "unsupported shop level fails closed",
    "season-mechanic composition",
    "rank-free normal-item loadout optimization",
    "special item categories require explicit scope",
    "current items occupy slots unless replacement is explicit",
    "owned special equipment remains a legal locked item",
    "support equipment requires explicit or owned scope",
    "duplicate current items preserve duplicate occupied slots",
    "rank-free augment effect choice evaluator",
    "rank-free trait roster role coverage solver",
    "material-input threshold with delegated open-core selection",
    "multi-domain theorycraft composition",
    "multi-domain evidence stays within the 2 MiB absolute turn ceiling",
    "ordinary lineup correction follow-up re-enters the Core solver",
    "entity alias type scoping",
    "missing-entity fail closed",
    "captured identity mismatch fails closed",
    "artifact-backed Core Profile and catalog identity",
    "failure results preserve validated identity",
    "Runtime demand-loaded integration",
    "Core Profile-scoped service cache",
  ],
})}\n`);
