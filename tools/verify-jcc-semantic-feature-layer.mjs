import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  compileCoreSemanticFeatureIndex,
  compileRankingSemanticFeaturePacket,
  mapMatchFactsToSemanticFeatures,
  rankTransitionOptionsForMatch,
  semanticFeatureTaxonomy,
} from "../ui/electron/semantic-feature-layer.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const commonSemanticDocument = JSON.parse(await readFile(path.join(repoRoot, "data/game-knowledge/jcc/common/semantic-features.json"), "utf8"));
const taxonomy = semanticFeatureTaxonomy(commonSemanticDocument);
assert(taxonomy.features.has("effect.mana_gain"));
assert(taxonomy.features.has("effect.wound"));
assert(taxonomy.features.has("effect.armor_shred"));
assert(taxonomy.features.has("effect.magic_resist_shred"));
assert(taxonomy.features.has("condition.requires_melee"));
assert(taxonomy.features.has("risk.effect_overlap"));
assert(taxonomy.features.has("delivery.delayed"));
assert(taxonomy.features.has("risk.random_variance"));
assert(taxonomy.features.has("rule_change.shop"));
assert(taxonomy.features.has("rule_change.stat_override"));
assert(taxonomy.features.has("failure.effect_overridden"));
assert(taxonomy.relations.has("relation.overrides"));
assert(taxonomy.relations.has("relation.transitions_to"));

const core = compileCoreSemanticFeatureIndex({
  commonSemanticDocument,
  identity: { season_id: "s-test", patch_id: "s-test_1", core_profile_id: "core-test", ranking_overlay_id: null },
  champions: [{
    id: "caster",
    name: "Caster",
    primary_role: "backline mage",
    traits: [{ id: "trait-a" }],
    skill: { text: "施法后获得法力和法术强度" },
    attributes_by_star: { "攻击距离": [4] },
  }],
  items: [{ id: "mana-item", name: "Mana Item", desc: "普攻后获得法力" }],
  augments: [{
    id: "econ-augment",
    name: "Economy",
    tier: "2",
    tier_color: "gold",
    desc: "回合开始获得金币，持续4个回合。",
    effects: { parse_status: "structured", source_text: "回合开始获得金币，持续4个回合。" },
    category_ids: ["economy"],
  }, {
    id: "trait-augment",
    name: "Trait Direction",
    desc: "Trait A弈子获得护盾。",
    category_ids: ["trait"],
  }, {
    id: "champion-augment",
    name: "Hero Direction",
    desc: "Caster的技能现在造成额外伤害。",
    category_ids: ["exclusive"],
  }, {
    id: "deadlier-caps",
    name: "更要命的帽子",
    desc: "获得1个班克斯的魔法帽。携带者每参与击败一次，就会永久获得1%法术加成。",
    effects: {
      parse_status: "conditional",
      source_text: "携带者每参与击败一次，就会永久获得1%法术加成。",
    },
    category_ids: ["equipment"],
  }],
  traits: [{ id: "trait-a", name: "Trait A", text: "全队获得护甲" }],
});
const caster = core.entities.find((entry) => entry.entity_kind === "champion" && entry.entity_id === "caster");
assert(caster.features.includes("role.backline"));
assert(caster.features.includes("output.ap"));
assert(caster.features.includes("effect.mana_gain"));
assert(caster.relations.some((row) => row.type === "relation.has_trait" && row.target_id === "trait-a"));
assert(caster.relations.some((row) => row.type === "relation.affects" && row.target_id === "effect.mana_gain"));
assert(caster.relations.some((row) => row.type === "relation.activates_after" && row.target_id === "trigger.cast"));
assert(core.relation_to_entities["relation.affects"].includes("champion:caster"));
const lockedItemCore = compileCoreSemanticFeatureIndex({
  commonSemanticDocument,
  identity: { season_id: "s-test", patch_id: "s-test_1", core_profile_id: "core-test", ranking_overlay_id: null },
  items: [{ id: "silvermere", name: "密银黎明", address: "jcc:s18:item:6072", desc: "携带者的攻击速度锁定为0.5。" }],
});
const lockedItem = lockedItemCore.entities.find((entry) => entry.entity_id === "silvermere");
assert(lockedItem.features.includes("rule_change.stat_override"));
assert(lockedItem.features.includes("failure.effect_overridden"));
assert(lockedItem.relations.some((row) => row.type === "relation.overrides" && row.target_id === "effect.attack_speed"));
const conflictItemCore = compileCoreSemanticFeatureIndex({
  commonSemanticDocument,
  identity: { season_id: "s-test", patch_id: "s-test_1", core_profile_id: "core-test", ranking_overlay_id: null },
  items: [{ id: "wound-item", name: "Wound Item", address: "jcc:s18:item:wound", desc: "攻击和技能伤害施加重伤和30%护甲削减。" }],
});
const conflictItem = conflictItemCore.entities.find((entry) => entry.entity_id === "wound-item");
assert(conflictItem.features.includes("effect.wound"));
assert(conflictItem.features.includes("effect.armor_shred"));
const economyAugment = core.entities.find((entry) => entry.entity_kind === "augment" && entry.entity_id === "econ-augment");
assert(economyAugment.augment_profile.features.includes("delivery.recurring"));
assert(economyAugment.augment_profile.features.includes("objective.economy"));
assert.equal(economyAugment.augment_profile.policy.contains_numeric_choice_score, false);
assert.equal(economyAugment.augment_profile.tier_color, "gold");
assert(economyAugment.augment_profile.feature_evidence.some((entry) => (
  entry.feature === "category.economy" && entry.source === "declared_source_category" && entry.confidence === "high"
)));
assert.equal(core.audit.unclassified_augment_ids.length, 0);
assert.equal(core.audit.uncategorized_augment_ids.length, 0);
const traitAugment = core.entities.find((entry) => entry.entity_kind === "augment" && entry.entity_id === "trait-augment");
const championAugment = core.entities.find((entry) => entry.entity_kind === "augment" && entry.entity_id === "champion-augment");
const deadlierCaps = core.entities.find((entry) => entry.entity_kind === "augment" && entry.entity_id === "deadlier-caps");
assert(traitAugment.augment_profile.features.includes("commitment.trait_locked"));
assert(!traitAugment.augment_profile.features.includes("commitment.universal"));
assert(championAugment.augment_profile.features.includes("commitment.champion_locked"));
assert(!championAugment.augment_profile.features.includes("commitment.universal"));
assert(deadlierCaps.features.includes("effect.spell_power"));
assert(deadlierCaps.features.includes("trigger.kill"));
assert(deadlierCaps.features.includes("scaling.per_kill"));
assert(deadlierCaps.features.includes("delivery.permanent"));
const rewardCore = compileCoreSemanticFeatureIndex({
  commonSemanticDocument,
  items: [{ id: "banks-hat", name: "班克斯的魔法帽", category: "神器" }],
  rewardTables: [{
    table_id: "augment:reward-artifact:rewards",
    name: "奖励强化",
    entity_ref: { kind: "augment", id: "reward-artifact", name: "奖励强化" },
    groups: [{ outcomes: [{ probability_pct: 100, rewards: [{ title: "完整原子奖励" }] }] }],
  }],
  augments: [{
    id: "reward-artifact",
    name: "奖励强化",
    description: "获得1个【班克斯的魔法帽】。3回合后获得1个随机纹章和1个金铲铲。",
    category_ids: ["equipment"],
  }],
});
const rewardAugment = rewardCore.entities.find((entry) => entry.entity_id === "reward-artifact");
assert.deepEqual(rewardAugment.augment_profile.reward_promise.reward_kinds, ["artifact", "emblem", "spatula"]);
assert(rewardAugment.augment_profile.reward_promise.delivery_timing.includes("delayed"));
assert.equal(rewardAugment.augment_profile.reward_promise.resolution, "random_unresolved_until_observed");
assert.equal(rewardAugment.augment_profile.reward_promise.craft_resource, true);
assert.equal(rewardAugment.augment_profile.reward_promise.requires_user_resolution, true,
  "a random emblem remains unresolved even when the same augment also grants craft resources");
assert.deepEqual(
  rewardAugment.augment_profile.reward_promise.reward_events.map((event) => ({ timing: event.delivery_timing, trigger: event.trigger })),
  [{ timing: "immediate", trigger: null }, { timing: "delayed", trigger: { kind: "after_rounds", rounds: 3 } }],
  "one augment must preserve separate immediate and delayed reward events",
);
assert.deepEqual(rewardAugment.augment_profile.reward_promise.reward_table_refs, ["augment:reward-artifact:rewards"],
  "semantic reward promises should reference the existing atomic reward table instead of copying its outcomes");
assert(rewardAugment.relations.some((row) => row.type === "relation.grants" && row.target_id === "banks-hat"));
assert.deepEqual(core, compileCoreSemanticFeatureIndex({
  commonSemanticDocument,
  identity: { season_id: "s-test", patch_id: "s-test_1", core_profile_id: "core-test", ranking_overlay_id: null },
  champions: [{
    id: "caster",
    name: "Caster",
    primary_role: "backline mage",
    traits: [{ id: "trait-a" }],
    skill: { text: "施法后获得法力和法术强度" },
    attributes_by_star: { "攻击距离": [4] },
  }],
  items: [{ id: "mana-item", name: "Mana Item", desc: "普攻后获得法力" }],
  augments: [{
    id: "econ-augment",
    name: "Economy",
    tier: "2",
    tier_color: "gold",
    desc: "回合开始获得金币，持续4个回合。",
    effects: { parse_status: "structured", source_text: "回合开始获得金币，持续4个回合。" },
    category_ids: ["economy"],
  }, {
    id: "trait-augment",
    name: "Trait Direction",
    desc: "Trait A弈子获得护盾。",
    category_ids: ["trait"],
  }, {
    id: "champion-augment",
    name: "Hero Direction",
    desc: "Caster的技能现在造成额外伤害。",
    category_ids: ["exclusive"],
  }, {
    id: "deadlier-caps",
    name: "更要命的帽子",
    desc: "获得1个班克斯的魔法帽。携带者每参与击败一次，就会永久获得1%法术加成。",
    effects: {
      parse_status: "conditional",
      source_text: "携带者每参与击败一次，就会永久获得1%法术加成。",
    },
    category_ids: ["equipment"],
  }],
  traits: [{ id: "trait-a", name: "Trait A", text: "全队获得护甲" }],
}), "Core semantic compilation must be byte-deterministic for equal input");

const ranking = compileRankingSemanticFeaturePacket({
  main_carry: { champion_id: "caster" },
  lifecycle_prior: { target_population: 8, archetype: "four_cost_level_eight_candidate" },
  equipment_requirements: {
    main_carry: { formation_required_items: [{ item_id: "trait-emblem", item_name: "Trait Emblem" }] },
    primary_tank: { formation_required_items: [] },
  },
  variants: [{
    lineup_ids: ["caster", "tank"],
    primary_tank: { champion_id: "tank" },
    associated_augment_ids: ["econ-augment"],
    transitions: [{ semantic_role: "published_transition" }],
  }],
}, commonSemanticDocument);
assert(ranking.features.includes("condition.requires_population"));
assert(ranking.features.includes("condition.requires_emblem"));
assert(ranking.features.includes("formation.has_published_transition"));
assert(ranking.relations.some((entry) => entry.type === "relation.has_main_carry" && entry.target_id === "caster"));
assert(ranking.relations.some((entry) => entry.type === "relation.has_main_tank" && entry.target_id === "tank"));
assert(ranking.relations.some((entry) => entry.type === "relation.contains" && entry.target_id === "caster"));
assert(ranking.relations.some((entry) => entry.type === "relation.requires_item" && entry.target_id === "trait-emblem"));
assert.equal(ranking.policy.cannot_change_strength_metrics, true);

const match = mapMatchFactsToSemanticFeatures({ stage_round: "3-2", gold: 12 }, commonSemanticDocument);
assert(match.features.includes("tempo.mid"));
assert.equal(match.policy.persist_to_common_core_or_ranking, false);

const candidate = {
  variants: [{
    variant_id: "parent-a",
    lineup_ids: ["a", "b", "c", "d", "e", "f", "g", "h"],
    transitions: [{ semantic_role: "published_transition", population: 5, lineup_ids: ["a", "b", "c", "d", "e"] }],
  }, {
    variant_id: "sibling-b",
    lineup_ids: ["x", "y", "z", "u", "v", "w", "q", "r"],
    transitions: [{ semantic_role: "published_transition", population: 6, lineup_ids: ["x", "y", "z", "u", "v", "w"] }],
  }],
};
const fit = rankTransitionOptionsForMatch(
  candidate,
  { level: 6, board_units: [{ champion_id: "a" }, { champion_id: "f" }, { champion_id: "x" }] },
  null,
  { preferredVariantId: "parent-a" },
);
assert.equal(fit.source_parent_variant_id, "parent-a");
assert.equal(fit.selected.semantic_role, "generated_transition_gap_fill");
assert.equal(fit.selected.provenance.request_local_only, true);
assert.equal(fit.selected.provenance.ranking_authority, false);
assert.deepEqual(fit.selected.lineup_ids, ["a", "b", "c", "d", "e", "f"]);
assert.equal(fit.policy.persisted_generated_nodes, 0);
assert.equal(JSON.stringify(fit).includes("sibling-b"), false, "a selected parent must not expose sibling transition variants");
assert.equal(fit.selected.runtime_fit.strength_claim, false);

const exactPublishedFit = rankTransitionOptionsForMatch({ variants: [{
  variant_id: "exact-parent",
  lineup_ids: ["a", "b", "c", "d", "e", "f", "g", "h"],
  transitions: [
    { semantic_role: "published_transition", population: 5, lineup_ids: ["a", "b", "c", "d", "e"] },
    { semantic_role: "published_transition", population: 6, lineup_ids: ["a", "b", "c", "d", "e", "f"] },
  ],
}] }, { level: 6, board_units: [{ champion_id: "z" }] }, null, { preferredVariantId: "exact-parent" });
assert.equal(exactPublishedFit.selected.semantic_role, "published_transition", "an exact-population published node must outrank local overlap");
assert.equal(exactPublishedFit.selected.population, 6);
assert.equal(exactPublishedFit.policy.request_local_gap_fill_maximum, 0);
assert.equal(rankTransitionOptionsForMatch(candidate, { level: 6 }, null, { preferredVariantId: "missing-parent" }), null);
assert.equal(rankTransitionOptionsForMatch(candidate, { level: 6 }), null, "missing explicit parent identity must fail closed");
assert.equal(rankTransitionOptionsForMatch(candidate, { level: 6 }, null, { preferredVariantId: "" }), null);
assert.equal(
  rankTransitionOptionsForMatch({ variants: [...candidate.variants].reverse() }, { level: 6 }),
  null,
  "sibling array order must not create an implicit transition parent",
);

const substitutionFit = rankTransitionOptionsForMatch({ variants: [{
  variant_id: "role-parent",
  lineup_ids: ["d", "b", "e", "f", "g", "h"],
  transitions: [{
  semantic_role: "published_transition",
  population: 6,
  lineup_ids: ["d", "b", "e", "f", "g", "h"],
  main_carry: { champion_id: "d" },
  primary_tank: { champion_id: "b" },
}] }] }, {
  level: 6,
  board_units: [{ champion_id: "a" }, { champion_id: "c" }],
  target_plan: { champion_id: "d" },
}, {
  entities: [
    { entity_kind: "champion", entity_id: "a", features: ["role.backline", "output.ap"] },
    { entity_kind: "champion", entity_id: "b", features: ["role.frontline", "output.tank"] },
    { entity_kind: "champion", entity_id: "c", features: ["role.frontline", "output.tank"] },
    { entity_kind: "champion", entity_id: "d", features: ["role.backline", "output.ap"] },
  ],
}, { preferredVariantId: "role-parent" });
assert.equal(substitutionFit.selected.runtime_fit.substitution?.role, "main_carry");
assert.deepEqual(substitutionFit.selected.runtime_fit.adapted_lineup_ids, ["a", "b", "e", "f", "g", "h"]);
assert.equal(substitutionFit.selected.runtime_fit.substitution?.ranking_authority, false);

const invalidDocument = structuredClone(commonSemanticDocument);
invalidDocument.entries.find((entry) => entry.id === "controlled_feature_ids").values.push("unknown.namespace");
assert.throws(() => compileCoreSemanticFeatureIndex({
  commonSemanticDocument: invalidDocument,
  champions: [{ id: "x", name: "X" }],
}), /Unknown controlled semantic feature|Common semantic feature registry/u);

console.log(JSON.stringify({
  status: "pass",
  core_entity_count: core.entities.length,
  ranking_feature_count: ranking.features.length,
  runtime_feature_count: match.features.length,
  transition_selected_role: fit.selected.semantic_role,
}, null, 2));
