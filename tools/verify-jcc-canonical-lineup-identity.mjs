import assert from "node:assert/strict";
import { buildCanonicalLineupIdentity } from "./jcc_canonical_lineup_identity.mjs";
import { compareAtomicVariants } from "./jcc_atomic_variant_comparator.mjs";

const champions = new Map([
  ["shen", { id: "shen", traits: [{ id: "fire", name: "地狱火" }, { id: "guard", name: "护卫" }] }],
  ["kennen", { id: "kennen", traits: [{ id: "fire", name: "地狱火" }, { id: "exec", name: "裁决使" }] }],
  ["azir", { id: "azir", traits: [{ id: "summon", name: "召唤师" }, { id: "exec", name: "裁决使" }] }],
  ["zyra", { id: "zyra", traits: [{ id: "summon", name: "召唤师" }] }],
  ["yorick", { id: "yorick", traits: [{ id: "summon", name: "召唤师" }] }],
  ["soraka", { id: "soraka", traits: [{ id: "exec", name: "裁决使" }] }],
  ["amumu", { id: "amumu", traits: [{ id: "fire", name: "地狱火" }] }],
]);
const traits = new Map([
  ["fire", { id: "fire", name: "地狱火", num_list: [2, 3] }],
  ["exec", { id: "exec", name: "裁决使", num_list: [2, 3] }],
  ["summon", { id: "summon", name: "召唤师", num_list: [2, 3] }],
  ["guard", { id: "guard", name: "护卫", num_list: [2, 4] }],
]);
const identity = buildCanonicalLineupIdentity({
  championIds: ["shen", "kennen", "azir", "zyra", "yorick", "soraka", "amumu"],
  champions,
  traits,
});
assert.deepEqual(new Map(identity.active_traits.map((row) => [row.trait_name, row.count])), new Map([
  ["召唤师", 3],
  ["地狱火", 3],
  ["裁决使", 3],
]));
assert(!identity.key.includes("839101"), "source family ids must not enter canonical semantic identity");

const comparison = compareAtomicVariants([
  {
    variant_id: "base",
    population: 9,
    lineup_ids: ["shen", "kennen"],
    lineup_names: ["Shen", "Kennen"],
    atomic_roster_statistics: { use_num: 2408, top4_rate: 0.9327, top1_rate: 0.4 },
  },
  {
    variant_id: "without-shen",
    population: 8,
    lineup_ids: ["kennen"],
    lineup_names: ["Kennen"],
    atomic_roster_statistics: { use_num: 889, top4_rate: 0.7672, top1_rate: 0.2 },
  },
  {
    variant_id: "without-kennen",
    population: 8,
    lineup_ids: ["shen"],
    lineup_names: ["Shen"],
    atomic_roster_statistics: { use_num: 165, top4_rate: 0.303, top1_rate: 0.05 },
  },
], { groupIdentity: "summoner-fire-family" });
assert.equal(comparison.variants[1].variant_type, "lower_population_variant");
const rawSignatureOnlyComparison = compareAtomicVariants([
  {
    variant_id: "same-roster-a",
    lineup_ids: ["1", "2"],
    population: 2,
    canonical_lineup_identity: { key: "351:2" },
    source_trait_signature: { key: "839101:2" },
  },
  {
    variant_id: "same-roster-b",
    lineup_ids: ["1", "2"],
    population: 2,
    canonical_lineup_identity: { key: "351:2" },
    source_trait_signature: { key: "847001:2" },
  },
], { groupIdentity: "same-roster-source-audit" });
assert.equal(rawSignatureOnlyComparison.variants[1].same_roster_different_trait_state, false,
  "raw source family differences must not imply an emblem or special trait state");
assert.equal(rawSignatureOnlyComparison.variants[1].variant_type, "same_roster_statistical_state",
  "same members without a proven semantic state change must not be described as replacements");
assert.equal(rawSignatureOnlyComparison.variants[1].source_signature_differs, true,
  "raw signature differences remain auditable without becoming semantic authority");
assert.deepEqual(comparison.variants[1].removed_units, ["shen"]);
assert.deepEqual(comparison.variants[2].removed_units, ["kennen"]);
assert.deepEqual(comparison.variants[1].removed_unit_ids, ["shen"]);
assert.deepEqual(comparison.variants[2].removed_unit_ids, ["kennen"]);
assert.deepEqual(comparison.variants[1].removed_unit_names, ["Shen"]);
assert.deepEqual(comparison.variants[2].removed_unit_names, ["Kennen"]);
assert(comparison.variants[2].top4_delta_vs_baseline < comparison.variants[1].top4_delta_vs_baseline);

const missingStatistics = compareAtomicVariants([{
  variant_id: "missing-statistics",
  lineup_ids: ["shen"],
  atomic_roster_statistics: { use_num: null, top4_rate: null, top1_rate: "" },
}], { groupIdentity: "missing-statistics" });
assert.equal(missingStatistics.variants[0].sample_count, null);
assert.equal(missingStatistics.variants[0].top4_rate, null);
assert.equal(missingStatistics.variants[0].top1_rate, null);

const externalPopulationReplacement = compareAtomicVariants([
  {
    variant_id: "external-a",
    population: 2,
    atomic_roster_members: [
      { source_unit_id: "shen", champion_id: "shen", champion_name: "Shen", occupies_population: true },
      { source_unit_id: "external-a", source_unit_name: "External A", occupies_population: true },
    ],
  },
  {
    variant_id: "external-b",
    population: 2,
    atomic_roster_members: [
      { source_unit_id: "shen", champion_id: "shen", champion_name: "Shen", occupies_population: true },
      { source_unit_id: "external-b", source_unit_name: "External B", occupies_population: true },
    ],
  },
], { groupIdentity: "external-population" });
assert.deepEqual(externalPopulationReplacement.variants[1].removed_unit_names, ["External A"]);
assert.deepEqual(externalPopulationReplacement.variants[1].added_unit_names, ["External B"]);
assert.deepEqual(externalPopulationReplacement.variants[1].replaced_unit_names, {
  removed: ["External A"],
  added: ["External B"],
});

const cardinalityChange = compareAtomicVariants([
  {
    variant_id: "cardinality-a",
    population: 3,
    lineup_ids: ["z", "a", "b"],
    lineup_names: ["Zed", "Ahri", "Braum"],
    atomic_roster_statistics: { use_num: 100 },
  },
  {
    variant_id: "cardinality-b",
    population: 3,
    lineup_ids: ["z", "c", "d", "e"],
    lineup_names: ["Zed", "Caitlyn", "Diana", "Ezreal"],
    atomic_roster_statistics: { use_num: 60 },
  },
], { groupIdentity: "cardinality-family" });
assert.equal(cardinalityChange.variants[1].variant_type, "roster_cardinality_change");
assert.equal(cardinalityChange.variants[1].replaced_units, null);
assert.deepEqual(cardinalityChange.variants[1].removed_unit_names, ["Ahri", "Braum"]);
assert.deepEqual(cardinalityChange.variants[1].added_unit_names, ["Caitlyn", "Diana", "Ezreal"]);
assert.equal(cardinalityChange.variants[1].sample_count_delta_vs_baseline, -40);

assert.throws(() => compareAtomicVariants([
  { variant_id: "a", candidate_id: "group-a", lineup_ids: ["a"] },
  { variant_id: "b", candidate_id: "group-b", lineup_ids: ["b"] },
], { groupIdentity: "group-a" }), /cannot cross lineup groups/);

console.log(JSON.stringify({ ok: true, schema: "jcc-canonical-lineup-identity-verification-v1" }, null, 2));
