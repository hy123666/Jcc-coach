import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseTypedAugmentEffect } from "./jcc_typed_effect_parser.mjs";

const source = JSON.parse(readFileSync(
  "data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/official-s18-augments.json",
  "utf8",
));
const augmentRows = Array.isArray(source) ? source : source.augments;
const row = augmentRows.find((entry) => String(entry.id) === "3128");
assert(row, "珠光莲花 II must exist in the active official augment source");
assert.match(row.description, /25%暴击几率/);
assert.match(row.description, /技能暴击/);

const activeProfile = JSON.parse(readFileSync("data/game-knowledge/jcc/active-profile.json", "utf8"));
const catalogPath = path.resolve(
  "data/game-knowledge/jcc",
  activeProfile.decision_input_catalog_path.replace(/\\/g, "/"),
);
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const catalogRow = (catalog.entities || []).find((entry) => entry.kind === "augment" && String(entry.id) === "3128");
assert(catalogRow, "珠光莲花 II must exist in the active decision-input catalog");
assert(
  String(catalogRow.desc || catalogRow.description || "").includes("技能暴击")
    || String(catalogRow.basic_desc || "").includes("技能暴击"),
  "珠光莲花 II effect must reach the active decision-input catalog",
);

const hardDataManifestPath = path.resolve(
  activeProfile.runtime_identity.hard_data_manifest.replace(/\\/g, "/"),
);
const normalizedAugmentsPath = path.join(path.dirname(hardDataManifestPath), "normalized", "augments.json");
const normalizedAugments = JSON.parse(readFileSync(normalizedAugmentsPath, "utf8"));
const compiledRow = (Array.isArray(normalizedAugments) ? normalizedAugments : normalizedAugments.augments)
  .find((entry) => String(entry.id) === "3128");
assert(compiledRow, "珠光莲花 II must exist in the active hard-data augment catalog");
const typedMetrics = (compiledRow.effects?.structured_terms || [])
  .flatMap((term) => term.metrics || []);
assert(typedMetrics.some((metric) => metric.metric === "critical_damage" && metric.value === 10),
  "珠光莲花 II must expose typed critical damage");
assert(typedMetrics.some((metric) => metric.metric === "critical_strike" && metric.value === 25),
  "珠光莲花 II must expose typed critical strike chance");
assert(typedMetrics.some((metric) => metric.metric === "skill_crit" && metric.value === true),
  "珠光莲花 II must expose typed skill critical mechanic");

const lateGameSpecialist = augmentRows.find((entry) => String(entry.id) === "1147");
assert(lateGameSpecialist, "后期专家 must exist in the official augment source");
const lateGameEffect = parseTypedAugmentEffect(lateGameSpecialist.description);
const lateGameGoldTerm = lateGameEffect.effect_terms.find((term) => (
  term.rewards.some((reward) => reward.kind === "gold" && reward.amount === 27)
));
assert(lateGameGoldTerm, "后期专家 must expose its 27 gold reward");
assert.equal(lateGameGoldTerm.trigger.kind, "level_reached");
assert.equal(lateGameGoldTerm.trigger.level, 9);
assert.deepEqual(lateGameGoldTerm.repeat_policy, { kind: "once" });
assert.equal(lateGameGoldTerm.rewards[0].delivery, "condition_met");
assert.equal(
  lateGameEffect.effect_terms.some((term) => term.trigger.kind === "passive"
    && term.rewards.some((reward) => reward.kind === "gold" && reward.amount === 27)),
  false,
  "后期专家 must not expose level-gated gold as an immediate passive reward",
);

const expectedRewardKinds = new Map([
  ["1134", ["free_shop_refresh"]],
  ["1093", ["artifact_anvil"]],
  ["1158", ["emblem"]],
  ["2184", ["component_item", "gold", "item_reforger"]],
  ["3896", ["experience", "free_shop_refresh"]],
  ["30705", ["unit", "emblem"]],
]);
for (const [id, kinds] of expectedRewardKinds) {
  const sourceRow = augmentRows.find((entry) => String(entry.id) === id);
  assert(sourceRow, `augment ${id} must exist in the official source`);
  const effect = parseTypedAugmentEffect(sourceRow.description);
  const actualKinds = new Set(effect.rewards.map((reward) => reward.kind));
  for (const kind of kinds) assert(actualKinds.has(kind), `augment ${id} must expose typed reward ${kind}`);
}

const unknownEffect = parseTypedAugmentEffect("每当月相翻转时，使相邻弈子进入星辉共鸣。");
assert.equal(unknownEffect.parse_status, "partial");
assert.equal(unknownEffect.effect_terms[0].trigger.kind, "unmapped_condition");
assert.equal(unknownEffect.effect_terms[0].activation, "condition_required");
assert.deepEqual(unknownEffect.unmapped_audit.fragments.map((entry) => entry.reason), ["unmapped_effect_semantics"]);

const compoundDefense = parseTypedAugmentEffect("战斗开始时：弈子为其他邻格弈子提供8护甲和魔法抗性。此效果可叠加。");
assert(compoundDefense.metrics.some((metric) => metric.metric === "armor" && metric.value === 8));
assert(compoundDefense.metrics.some((metric) => metric.metric === "magic_resist" && metric.value === 8));
assert(compoundDefense.stacking_limits.some((entry) => entry.kind === "stacking_policy" && entry.stackable === true));
assert(compoundDefense.relations.some((entry) => entry.verb === "provide" && entry.recipient.kind === "other_adjacent_units"));

const deathHealing = parseTypedAugmentEffect("在一名敌人倒下时，相距最近的那个己方弈子获得250治疗效果。");
assert.equal(deathHealing.effect_terms[0].trigger.kind, "enemy_death");
assert.equal(deathHealing.effect_terms[0].activation, "condition_required");
assert(deathHealing.metrics.some((metric) => metric.metric === "healing" && metric.value === 250));

const persistentRefresh = parseTypedAugmentEffect("每回合获得1次免费的商店刷新，持续至本局游戏结束。");
assert(persistentRefresh.durations.some((entry) => entry.kind === "duration_scope" && entry.scope === "game"));
assert.equal(persistentRefresh.unmapped_audit.status, "complete");

const chineseQuantityReward = parseTypedAugmentEffect("获得一个随机基础装备。");
assert(chineseQuantityReward.rewards.some((reward) => reward.kind === "component_item" && reward.amount === 1 && reward.random === true));

const jeweledEffect = parseTypedAugmentEffect(row.description);
assert.equal(jeweledEffect.effect_terms.filter((term) => term.clause_role === "definition").every((term) => term.metrics.length === 0), true);
assert(jeweledEffect.effect_terms.some((term) => term.clause_role === "conditional_interaction"));

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-augment-effect-closure-verification-v2",
  ids: ["3128", "1147", ...expectedRewardKinds.keys()],
}, null, 2));
