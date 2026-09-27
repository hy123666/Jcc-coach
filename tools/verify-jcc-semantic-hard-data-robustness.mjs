import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { compileCoreSemanticFeatureIndex } from "../ui/electron/semantic-feature-layer.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const commonSemanticDocument = JSON.parse(await readFile(
  path.join(repoRoot, "data/game-knowledge/jcc/common/semantic-features.json"),
  "utf8",
));
const activeProfile = JSON.parse(await readFile(
  path.join(repoRoot, "data/game-knowledge/jcc/active-profile.json"),
  "utf8",
));
const activeHardDataDirectory = path.dirname(path.join(repoRoot, activeProfile.runtime_identity.hard_data_manifest));
const activeAugments = JSON.parse(await readFile(path.join(activeHardDataDirectory, "normalized/augments.json"), "utf8"));
const activeItems = JSON.parse(await readFile(path.join(activeHardDataDirectory, "normalized/items.json"), "utf8"));
const actualJeweledLotus = activeAugments.find((entry) => String(entry.id) === "3128");
assert(actualJeweledLotus, "the Active Core hard data must contain augment 3128 珠光莲花 II");
const actualItemsById = new Map(activeItems.map((entry) => [String(entry.id), entry]));
const selectedActualItems = ["9470", "9471", "9472", "2045", "6091", "41809"].map((id) => {
  const row = actualItemsById.get(id);
  assert(row, `the Active Core hard data must contain item ${id}`);
  return row;
});

const core = compileCoreSemanticFeatureIndex({
  commonSemanticDocument,
  identity: {
    season_id: "s-test",
    patch_id: "s-test_1",
    core_profile_id: "semantic-hard-data-robustness",
  },
  augments: [actualJeweledLotus, {
    id: "random-reward",
    name: "随机奖励",
    desc: "获得1件随机神器。",
    category_ids: ["equipment"],
    effects: { parse_status: "structured", source_text: "获得1件随机神器。" },
  }, {
    id: "conditional-reward",
    name: "低血量奖励",
    desc: "当你的生命值低于35时，获得1件神器。",
    category_ids: ["equipment"],
    effects: { parse_status: "structured", source_text: "当你的生命值低于35时，获得1件神器。" },
  }],
  items: selectedActualItems,
});

const augment = (id) => core.entities.find((entry) => entry.entity_kind === "augment" && entry.entity_id === id);
const itemIds = new Set(core.entities
  .filter((entry) => entry.entity_kind === "item")
  .map((entry) => entry.entity_id));

const jeweledLotus = augment("3128");
assert(jeweledLotus, "珠光莲花 II must remain a compiled augment semantic entity");
for (const feature of ["effect.crit_chance", "target.team", "reliability.guaranteed", "delivery.immediate", "commitment.universal"]) {
  assert(jeweledLotus.features.includes(feature), `珠光莲花 II must include ${feature}`);
}
for (const feature of ["trigger.kill", "reliability.random", "reliability.conditional", "risk.random_variance", "commitment.ad", "commitment.ap"]) {
  assert(!jeweledLotus.features.includes(feature), `珠光莲花 II must not overclaim ${feature}`);
}
assert(!jeweledLotus.relations.some((row) => row.type === "relation.activates_after" && row.target_id === "trigger.kill"));

const randomReward = augment("random-reward");
assert(randomReward.features.includes("reliability.random"), "explicit random rewards must retain random reliability semantics");
assert(randomReward.features.includes("risk.random_variance"), "explicit random rewards must retain variance risk semantics");
const conditionalReward = augment("conditional-reward");
assert(conditionalReward.features.includes("reliability.conditional"), "real user-facing conditions must remain conditional");
assert(!conditionalReward.features.includes("reliability.random"), "a deterministic condition must not become random");

assert(!itemIds.has("9470"), "random component reward placeholder must not become an equippable semantic item");
assert(!itemIds.has("9471"), "random completed-item reward placeholder must not become an equippable semantic item");
assert(!itemIds.has("9472"), "random emblem reward placeholder must not become an equippable semantic item");
for (const id of ["2045", "6091", "41809"]) {
  assert(itemIds.has(id), `real equipment ${id} must remain in the semantic item index`);
}
assert.deepEqual(
  core.audit.excluded_reward_placeholder_item_ids,
  ["9470", "9471", "9472"],
  "the semantic audit must expose every excluded random-equipment reward placeholder",
);

console.log(JSON.stringify({
  status: "pass",
  schema: "jcc-semantic-hard-data-robustness-verification-v1",
  active_core_profile_id: activeProfile.core_profile_id,
  augment_id: jeweledLotus.entity_id,
  random_reward_features: randomReward.features.filter((feature) => feature.startsWith("reliability.") || feature.startsWith("risk.")),
  excluded_reward_placeholder_item_ids: core.audit.excluded_reward_placeholder_item_ids,
}, null, 2));
