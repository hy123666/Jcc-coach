import assert from "node:assert/strict";
import {
  materializeRankingCandidateRecipes,
  normalizeRankingRecipeStorage,
  validateNormalizedRankingRecipeStorage,
} from "./jcc_ranking_recipe_storage.mjs";

const sharedExactRecipe = {
  recipe_id: "recipe-exact",
  display_name: "Exact recipe",
  source_role: "winning_recipe",
  classification: "exact",
  removed_from_standard: [],
  added_by_recipe: [],
  removed_from_standard_names: [],
  added_by_recipe_names: [],
  canonical_trait_coverage: 1,
  roster_coverage: 1,
  recipe_coverage: 1,
  freshness: { status: "fresh", source_stat_date: "20990101" },
  main_carry_id: "champion-a",
  main_carry_name: "Champion A",
  primary_tank_id: "champion-b",
  primary_tank_name: "Champion B",
  item_assignments: [{ holder_id: "champion-a", item_ids: ["item-a"] }],
  may_replace_standard_roster: false,
  evidence_boundary: "recipe_does_not_replace_roster",
  augment_ids: ["augment-a"],
  transitions: [{ population: 6, lineup_ids: ["champion-a", "champion-b"] }],
  positioning_template: null,
  lineup_code: "CODE",
  playbook: { summary: "Play from the exact recipe." },
  formation_requirements: null,
  use_as: "same_roster_recipe_enrichment",
};

const analogousRecipe = {
  recipe_id: "recipe-analogous",
  display_name: "Analogous recipe",
  source_role: "popular_recipe",
  classification: "analogous",
  removed_from_standard: ["champion-b"],
  added_by_recipe: ["champion-c"],
  removed_from_standard_names: ["Champion B"],
  added_by_recipe_names: ["Champion C"],
  canonical_trait_coverage: 0.5,
  roster_coverage: 0.5,
  recipe_coverage: 0.5,
  freshness: { status: "fresh", source_stat_date: "20990101" },
  main_carry_id: "champion-c",
  main_carry_name: "Champion C",
  primary_tank_id: null,
  primary_tank_name: null,
  item_assignments: [],
  may_replace_standard_roster: false,
  evidence_boundary: "analogous_role_reference_only",
  use_as: "bounded_role_and_item_reference_only",
  operational_fields_withheld: true,
};

function candidate(id, variantId, recipes) {
  return {
    lineup_group_id: id,
    candidate_evidence_id: `evidence:${id}`,
    mature_recipe_variants: structuredClone(recipes),
    mature_recipe_variant_receipt: {
      schema: "jcc-mature-recipe-variant-set-v1",
      source_count: recipes.length,
      retained_count: recipes.length,
      truncated: false,
    },
    variants: [{
      variant_id: variantId,
      atomic_roster_id: `atomic:${id}`,
      candidate_evidence_id: `evidence:${id}:${variantId}`,
      roster_is_atomic: true,
      lineup_ids: ["champion-a", "champion-b"],
      lineup_names: ["Champion A", "Champion B"],
      mature_recipe_variants: structuredClone(recipes),
      mature_recipe_variant_receipt: {
        schema: "jcc-mature-recipe-variant-set-v1",
        source_count: recipes.length,
        retained_count: recipes.length,
        truncated: false,
      },
    }],
  };
}

const expanded = {
  schema: "jcc-live-ranking-strategy-index-v3",
  generated_at: "2099-01-01T00:00:00.000Z",
  stat_date: "20990101",
  source_identity: { core_profile_id: "core-a" },
  tiers: {
    "0": {
      label: "master_plus",
      lineup_candidates: [
        candidate("candidate-a", "variant-a", [sharedExactRecipe, analogousRecipe]),
        candidate("candidate-b", "variant-b", [sharedExactRecipe]),
      ],
    },
  },
};

const originalCandidates = structuredClone(expanded.tiers["0"].lineup_candidates);
const normalized = normalizeRankingRecipeStorage(expanded);

assert.equal(normalized.schema, "jcc-live-ranking-strategy-index-v4");
assert.equal(Object.keys(normalized.tiers["0"].recipe_catalog).length, 2,
  "each recipe payload must be stored once per tier");
assert.equal(Object.keys(normalized.tiers["0"].recipe_relation_catalog).length, 2,
  "identical recipe relations must be content-addressed once");
assert.ok(normalized.tiers["0"].recipe_relation_field_catalog.length > 0,
  "relation field names must be interned once per tier");
assert.ok(normalized.tiers["0"].recipe_relation_value_catalog.length > 0,
  "repeated relation values must be interned once per tier");
assert.ok(Object.values(normalized.tiers["0"].recipe_relation_catalog).every((relation) => (
  Array.isArray(relation) && relation.length === 3
)), "content-addressed relation records must use the compact encoded form");
assert.equal(normalized.tiers["0"].lineup_candidates[0].mature_recipe_variants, undefined);
assert.equal(normalized.tiers["0"].lineup_candidates[0].variants[0].mature_recipe_variants, undefined);
assert.deepEqual(
  normalized.tiers["0"].lineup_candidates.map((entry) => materializeRankingCandidateRecipes(
    entry,
    normalized.tiers["0"],
  )),
  originalCandidates,
  "normalization followed by materialization must reproduce every expanded recipe fact",
);

const receipt = validateNormalizedRankingRecipeStorage(normalized);
assert.equal(receipt.recipe_count, 2);
assert.equal(receipt.unique_relation_count, 2);
assert.equal(receipt.relation_reference_count, 6);
assert.equal(receipt.expanded_relation_count, 6);
assert.equal(receipt.equivalent, true);

const dangling = structuredClone(normalized);
dangling.tiers["0"].lineup_candidates[0].variants[0].mature_recipe_relation_ids[0] = "relation:missing";
assert.throws(
  () => validateNormalizedRankingRecipeStorage(dangling),
  /missing recipe relation/u,
  "a dangling relation must block publication",
);

const corrupted = structuredClone(normalized);
corrupted.tiers["0"].recipe_relation_value_catalog[0] = "corrupted";
assert.throws(
  () => validateNormalizedRankingRecipeStorage(corrupted),
  /content hash mismatch|not losslessly materializable/u,
  "changing an interned relation value must block publication",
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-ranking-recipe-storage-normalization-verifier-v1",
  receipt,
}, null, 2)}\n`);
