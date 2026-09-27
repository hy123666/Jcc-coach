import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { nextAugmentTierForecast } from "../ui/electron/augment-tier-probability.js";

const common = JSON.parse(await readFile(
  new URL("../data/game-knowledge/jcc/common/standard-game-baseline.json", import.meta.url),
  "utf8",
));
const table = common.entries.find((fact) => fact.id === "standard.augment_tier_probabilities");

const opening = nextAugmentTierForecast(table, []);
assert.equal(opening.next_choice_round, "2-1");
assert.deepEqual(opening.tiers.map((entry) => entry.tier), ["silver", "gold", "prismatic"]);
assert.deepEqual(opening.tiers.map((entry) => entry.probability_pct), [33, 33, 33]);

const afterSilver = nextAugmentTierForecast(table, [{ stage_round: "2-1", tier: "银色" }]);
assert.equal(afterSilver.next_choice_round, "3-2");
assert.deepEqual(afterSilver.conditioned_on, [{ stage_round: "2-1", tier: "silver" }]);
assert.deepEqual(afterSilver.tiers, [
  { tier: "silver", probability_pct: 36 },
  { tier: "gold", probability_pct: 61 },
  { tier: "prismatic", probability_pct: 3 },
]);

const afterSilverGold = nextAugmentTierForecast(table, [
  { stage_round: "2-1", rarity: "silver" },
  { stage_round: "3-2", selected_tier: "金色" },
]);
assert.equal(afterSilverGold.next_choice_round, "4-2");
assert.deepEqual(afterSilverGold.tiers, [
  { tier: "gold", probability_pct: 71 },
  { tier: "prismatic", probability_pct: 29 },
]);

assert.equal(nextAugmentTierForecast(table, [{ stage_round: "2-1", tier: "unknown" }]), null);
assert.equal(nextAugmentTierForecast(table, [{ stage_round: "3-2", tier: "gold" }]), null,
  "a missing first-choice fact must not be reinterpreted as the first choice");
assert.equal(nextAugmentTierForecast(table, [
  { kind: "equipment", stage_round: "2-5", selected: "Item" },
  { kind: "augment", stage_round: "2-1", tier: "silver" },
])?.next_choice_round, "3-2", "unrelated confirmed facts must not invalidate an augment forecast");
assert.equal(nextAugmentTierForecast(table, [
  { stage_round: "2-1", tier: "silver" },
  { stage_round: "3-2", tier: "gold" },
  { stage_round: "4-2", tier: "gold" },
]), null);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "opening_distribution",
    "second_choice_conditional_distribution",
    "third_choice_conditional_distribution",
    "unknown_and_complete_sequences_do_not_guess",
    "missing_prefix_and_unrelated_facts_fail_safely",
  ],
}, null, 2));
