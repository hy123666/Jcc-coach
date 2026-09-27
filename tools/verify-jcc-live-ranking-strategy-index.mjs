import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildLiveRankingStrategyIndex } from "./jcc_live_rankings_strategy_index.mjs";
import { materializeRankingCandidateRecipes } from "./jcc_ranking_recipe_storage.mjs";
import { validateNormalizedRankingRecipeStorage } from "./jcc_ranking_recipe_storage.mjs";
import { projectRankingToolCandidate } from "../ui/electron/ranking-tool-projection.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const commonSemanticDocument = JSON.parse(await readFile(
  path.join(repoRoot, "data/game-knowledge/jcc/common/semantic-features.json"),
  "utf8",
));

const catalogs = {
  champions: [
    { id: "c1", name: "Carry One", cost: 4, role: "backline carry", traits: [{ id: "t-alpha", name: "Alpha" }] },
    { id: "c2", name: "Tank Two", cost: 4, role: "frontline tank", traits: [{ id: "t-alpha", name: "Alpha" }] },
    { id: "c3", name: "Flex Three", cost: 2, role: "support", traits: [{ id: "t-beta", name: "Beta" }] },
    { id: "c4", name: "Flex Four", cost: 1, role: "frontline", traits: [{ id: "t-beta", name: "Beta" }] },
    { id: "c5", name: "Carry Five", cost: 3, role: "backline carry", traits: [{ id: "t-beta", name: "Beta" }] },
    { id: "c6", name: "Foreign Six", cost: 5, role: "backline carry", traits: [{ id: "t-beta", name: "Beta" }] },
  ],
  items: [
    { id: "i-top1", name: "Top One Package Item", tags: ["completed"] },
    { id: "i-popular", name: "Popular Package Item", tags: ["completed"] },
    { id: "i-recipe", name: "Recipe Item", tags: ["completed"] },
    { id: "i-tank", name: "Tank Item", tags: ["completed"] },
  ],
  augments: [{ id: "a1", name: "Augment One" }],
  traits: [{ id: "t-alpha", name: "Alpha", num_list: [2] }, { id: "t-beta", name: "Beta", num_list: [2, 4] }],
};

const alphaTrait = [{
  trait_id: "10000102",
  hero_num: 2,
  canonical_trait_id: "t-alpha",
  source_trait_text: "Alpha",
  source_dictionary_status: "resolved_official_frontend_dictionary",
}];
const betaTrait = [{
  trait_id: "10000202",
  hero_num: 2,
  canonical_trait_id: "t-beta",
  source_trait_text: "Beta",
  source_dictionary_status: "resolved_official_frontend_dictionary",
}];

function winningGroup({ id = "winning-alpha", lineup = ["c1", "c2", "c3", "c4"], carry = "c1", tank = "c2", metrics = {} } = {}) {
  return {
    id,
    info: {
      main_c_chess_id: carry,
      info: { sum: { top_1_rate: 0.99, top_4_rate: 0.99, use_num: 999999, ...metrics } },
      list: [{
        lineup_rank: 1,
        lineup,
        assist_chess: [tank],
        main_c_chess_equip: ["i-recipe"],
        assist_chess_equip: ["i-tank"],
        rune_id_group: ["a1"],
        top_1_rate: 0.99,
        top_4_rate: 0.99,
        avg_rank: 1.01,
        use_rate: 0.99,
        use_num: 999999,
        ...metrics,
      }],
    },
  };
}

function winningGroupForTrait({ id, traitRows, lineup, carry = "c1", tank = "c2" }) {
  const group = winningGroup({ id, lineup, carry, tank });
  group.main_trait_list = traitRows;
  group.main_trait_list2 = traitRows.map((row) => row.trait_id);
  group.info.list[0].main_trait_group = traitRows;
  return group;
}

function popularRecipe({ recipeId = "popular-beta", roster = ["c3", "c4", "c5", "c6"], carry = "c5", tank = "c4" } = {}) {
  return {
    recipe_id: recipeId,
    source_role: "popular_recipe",
    source_kind: "official_curated_popular_lineup",
    final_roster: roster.map((championId) => ({
      champion_id: championId,
      champion_name: catalogs.champions.find((row) => row.id === championId)?.name || championId,
      role: championId === carry ? "main_carry" : championId === tank ? "primary_tank" : null,
      items: championId === carry ? [{ id: "i-recipe", name: "Recipe Item" }] : championId === tank ? [{ id: "i-tank", name: "Tank Item" }] : [],
      position: null,
    })),
    roles: { main_carry: carry, primary_tank: tank },
    final_auxiliary_units: [{
      source_unit_id: "pet-beta",
      source_unit_name: "Beta Pet",
      unit_type: "pet",
      position: null,
      occupies_population: false,
    }],
    augments: [{ id: "a1", name: "Augment One" }],
    gameplay: { summary: "Popular recipe gameplay only." },
    level_map: [],
    lineup_code: "JCC-POPULAR-CODE",
    formation_requirements: {
      required_star_targets: [{ champion_id: carry, star: 3 }],
    },
    top_1_rate: 1,
    top_4_rate: 1,
    use_num: 999999,
  };
}

function snapshot() {
  return {
    stat_date: "20990101",
    source: { battle_type: "31", lineup_version_id: "v6", set_id: "18" },
    static_basis: { patch_package: "synthetic", version: "s18_1", season: "s18" },
    tiers: {
      "0": {
        main_trait_strength: [
          { main_traits: alphaTrait, node1_top1_rate: 0.12, node1_top4_rate: 0.64, node1_use_rate: 0.08, node1_use_num: 1000 },
          { main_traits: betaTrait, node1_top1_rate: 0.22, node1_top4_rate: 0.59, node1_use_rate: 0.04, node1_use_num: 700 },
        ],
        trait_details: [],
        trait_groups: [
          { main_traits: alphaTrait, data: { minor_traits_datas: [{ hero_list: ["c1", "c2", "c3", "c4"], trait_list: alphaTrait, use_num: 500 }] } },
          { main_traits: betaTrait, data: { minor_traits_datas: [{ hero_list: ["c3", "c4", "c5", "c6", "pet-beta"], trait_list: betaTrait, use_num: 350 }] } },
        ],
        hero_strength: { "255": [] },
        hero_equip_rankings: { by_hero_id: { c1: {
          single_itemid: [],
          combine_itemid_details: [
            { equips: ["i-top1"], top1_rate: 0.55, top4_rate: 0.68, playrate: 0.01 },
            { equips: ["i-popular"], top1_rate: 0.2, top4_rate: 0.7, playrate: 0.5 },
          ],
        } } },
        equip_rank: { list: [] },
        lineup_group: { main_traits_data: [winningGroup()] },
        recipe_sources: {
          winning: {
            capability: { status: "available", source_stat_date: "20990101", accepted_recipe_count: 1 },
            recipes: [],
          },
          popular: {
            capability: { status: "available", source_stat_date: "20990101", accepted_recipe_count: 1 },
            recipes: [popularRecipe()],
          },
        },
      },
      "1": {
        main_trait_strength: [{ main_traits: alphaTrait, node1_top1_rate: 1, node1_top4_rate: 1, node1_use_num: 999999 }],
        trait_groups: [{ main_traits: alphaTrait, data: { minor_traits_datas: [{ hero_list: ["c1", "c2", "c3", "c4"] }] } }],
      },
    },
  };
}

const options = {
  ...catalogs,
  roleProfiles: [
    { champion_id: "c1", role: "backline carry", tags: ["physical_damage"] },
    { champion_id: "c2", role: "frontline tank", tags: ["shield"] },
    { champion_id: "c3", role: "support", tags: ["utility"] },
    { champion_id: "c4", role: "frontline", tags: ["frontline"] },
    { champion_id: "c5", role: "backline carry", tags: ["physical_damage"] },
    { champion_id: "c6", role: "backline carry", tags: ["magic_damage"] },
  ],
  generatedAt: "2099-01-01T00:00:00.000Z",
  runtimeSeasonId: "s18",
  activePatchId: "s18_1",
  gameModeId: "mode18",
  packageId: "synthetic",
  sourcePackageId: "synthetic",
  coreProfileId: "a".repeat(64),
  commonSemanticDocument,
};

function materializedCandidate(index, predicate) {
  const tier = index.tiers["0"];
  const candidate = tier.lineup_candidates.find(predicate);
  return candidate ? materializeRankingCandidateRecipes(candidate, tier) : undefined;
}

const baseSnapshot = snapshot();
const index = buildLiveRankingStrategyIndex(baseSnapshot, options);
assert.equal(index.schema, "jcc-live-ranking-strategy-index-v4");
assert.equal(validateNormalizedRankingRecipeStorage(index).equivalent, true);
assert.deepEqual(Object.keys(index.tiers), ["0"], "only Master+ may be compiled");
const tier = index.tiers["0"];
assert.equal(tier.lineup_candidates.length, 2);

const alpha = materializedCandidate(index, (row) => row.provenance?.source_anchor_id === "national:100001:2");
const beta = materializedCandidate(index, (row) => row.provenance?.source_anchor_id === "national:100002:2");
assert(alpha && beta);
assert.deepEqual(alpha.core_unit_ids, ["c1", "c2", "c3", "c4"]);
assert.deepEqual(alpha.variants[0].lineup_ids, ["c1", "c2", "c3", "c4"]);
assert.equal(alpha.provenance.canonical_roster_source, "snapshot.tiers[].trait_groups[].data.minor_traits_datas[].hero_list");
assert.equal(alpha.recipe_match.source_role, "winning_recipe");
assert.equal(alpha.recipe_match.classification, "exact");
assert.equal(alpha.recipe_match.may_replace_roster, false);
assert.equal(alpha.recipe_match.may_merge_variants, false);
assert.equal(alpha.recipe_match.may_inherit_strength, false);
assert.deepEqual(alpha.mature_recipe_variants[0].removed_from_standard_names, []);
assert.deepEqual(alpha.mature_recipe_variants[0].added_by_recipe_names, []);
assert.equal(alpha.mature_recipe_variants[0].display_name, "胜率变种：标准阵容同构配方");
assert.equal(alpha.mature_recipe_variants[0].main_carry_name, "Carry One");
assert.equal(alpha.recipe_evidence.metrics, undefined);
assert.equal(alpha.main_carry.champion_id, "c1");
assert.deepEqual(alpha.variants[0].main_carry.item_ids, ["i-recipe"]);
assert.equal(alpha.strength_anchor.metrics.top1_rate, 0.12);
assert.equal(alpha.variants[0].atomic_roster_statistics.use_num, 500);
assert.equal(alpha.variants[0].atomic_roster_statistics.stat_date, "20990101");
assert.equal(alpha.atomic_variant_comparison.variants[0].variant_type, "baseline_complete");
assert.deepEqual(alpha.atomic_variant_comparison.variants[0].added_unit_names, []);
assert.deepEqual(alpha.atomic_variant_comparison.variants[0].removed_unit_names, []);
assert.match(alpha.variants[0].atomic_roster_id, /^atomic:[a-f0-9]{24}$/u);
assert.equal(alpha.strength_anchor.quality.sample_band, "large");
assert.equal(alpha.strength_anchor.quality.currentness.authority.does_not_change_current_day_strength, true);

const missingSampleSnapshot = snapshot();
delete missingSampleSnapshot.tiers["0"].main_trait_strength[0].node1_use_num;
const missingSampleIndex = buildLiveRankingStrategyIndex(missingSampleSnapshot, options);
assert.equal(
  missingSampleIndex.tiers["0"].strength_anchors.find((anchor) => anchor.source_anchor_id === "national:100001:2").quality.sample_band,
  "unknown",
  "missing national sample counts must remain unknown rather than being mislabeled as small",
);
assert.equal(alpha.variants[0].formation_profile.shared_feasibility.schema, "jcc-lineup-formation-profile-v2");
assert.equal(alpha.variants[0].formation_profile.shared_feasibility.target_population, 4);
assert.equal(alpha.variants[0].formation_profile.shared_feasibility.authority,
  "shared_common_method_with_core_and_optional_ranking_inputs");
assert.equal(alpha.variants[0].formation_profile.formation_economy_profile.star_target_purchase_cost, 36,
  "the shared lifecycle prior must apply the four-cost carry target cost when the recipe has no explicit star record");
assert.equal(alpha.primary_tank.champion_id, "c2",
  "the normalized recipe primary tank must remain available to the shared formation solver");

const conflictingRoleOptions = {
  ...options,
  items: options.items.map((item) => item.id === "i-recipe"
    ? { ...item, primary_role: "frontline_tank" }
    : item),
  roleProfiles: options.roleProfiles.map((profile) => profile.champion_id === "c1"
    ? { ...profile, role: "frontline", tags: ["frontline", "shield"] }
    : profile.champion_id === "c3"
      ? { ...profile, role: "backline carry", tags: ["physical_damage"] }
      : profile),
};
const conflictingRoleIndex = buildLiveRankingStrategyIndex(snapshot(), conflictingRoleOptions);
const conflictingRoleAlpha = materializedCandidate(conflictingRoleIndex,
  (row) => row.provenance?.source_anchor_id === "national:100001:2");
assert.equal(conflictingRoleAlpha.main_carry.champion_id, "c3",
  "a recipe carry that conflicts with frontline role and tank item evidence must yield to a compatible roster carry");
assert.equal(conflictingRoleAlpha.primary_tank.champion_id, "c2",
  "the role resolver should keep the strongest independent frontline candidate as the tank");
assert.equal(conflictingRoleAlpha.role_resolution.main_carry.overridden, true,
  "role conflicts must remain inspectable as a soft deterministic override");
assert.equal(conflictingRoleAlpha.role_resolution.source, "recipe_cross_checked_with_core_role_and_item_evidence");

assert.equal(beta.recipe_match.source_role, "popular_recipe");
assert.equal(beta.recipe_match.classification, "exact");
assert.deepEqual(beta.core_unit_ids, ["c3", "c4", "c5", "c6"]);
assert.equal(beta.variants[0].population, 4);
assert.deepEqual(beta.variants[0].auxiliary_units.map((unit) => ({
  source_unit_id: unit.source_unit_id,
  unit_type: unit.unit_type,
  occupies_population: unit.occupies_population,
})), [{
  source_unit_id: "pet-beta",
  unit_type: "pet",
  occupies_population: false,
}]);
assert.equal(beta.main_carry.champion_id, "c5");
assert.equal(beta.variants[0].lineup_code, "JCC-POPULAR-CODE");
assert.equal(beta.variants[0].formation_profile.formation_economy_profile.star_target_purchase_cost, 27,
  "an explicit three-star three-cost recipe target must reach the shared formation economy profile");
assert.equal(beta.variants[0].formation_profile.formation_economy_profile.target_unit_costs
  .find((unit) => unit.id === "c5")?.purchase_cost, 27);

const specialForestTrait = [{
  trait_id: "91000109",
  hero_num: 9,
  canonical_trait_id: "forest",
  source_trait_text: "Forest",
  source_dictionary_status: "resolved_official_frontend_dictionary",
}];
const specialRiftTrait = [{
  trait_id: "91000210",
  hero_num: 10,
  canonical_trait_id: "rift",
  source_trait_text: "Rift",
  source_dictionary_status: "resolved_official_frontend_dictionary",
}];
const specialChampions = [
  ...Array.from({ length: 7 }, (_, index) => ({
    id: `forest-${index + 1}`,
    name: `Forest ${index + 1}`,
    cost: index < 4 ? 2 : 4,
    role: index === 0 ? "frontline tank" : "support",
    traits: [{ id: "forest", name: "Forest" }],
  })),
  {
    id: "lux",
    name: "Lux",
    cost: 5,
    role: "support",
    traits: [{ id: "elementalist", name: "Elementalist" }],
    runtime_semantics: {
      population_cost: 1,
      variant_trait_contribution: 2,
    },
  },
  { id: "forest-carry", name: "Forest Carry", cost: 4, role: "backline carry", traits: [{ id: "other", name: "Other" }] },
  ...Array.from({ length: 8 }, (_, index) => ({
    id: `rift-${index + 1}`,
    name: `Rift ${index + 1}`,
    cost: index < 4 ? 2 : 4,
    role: index === 0 ? "frontline tank" : "support",
    traits: [{ id: "rift", name: "Rift" }],
  })),
  {
    id: "dragon",
    name: "Dragon",
    cost: 5,
    role: "backline carry",
    traits: [{ id: "predator", name: "Predator" }, { id: "rift", name: "Rift" }],
    runtime_semantics: {
      population_cost: 2,
      trait_contributions: [{ trait_id: "rift", trait_name: "Rift", value: 2 }],
    },
  },
  { id: "cap-one", name: "Cap One", cost: 5, role: "support", traits: [{ id: "cap", name: "Cap" }] },
  { id: "cap-two", name: "Cap Two", cost: 5, role: "support", traits: [{ id: "cap", name: "Cap" }] },
];
const specialTraits = [
  { id: "forest", name: "Forest", num_list: [3, 5, 7, 9] },
  { id: "elementalist", name: "Elementalist", num_list: [1] },
  { id: "other", name: "Other", num_list: [1] },
  {
    id: "rift",
    name: "Rift",
    num_list: [3, 5, 7, 10],
    breakpoints: [{
      count: 10,
      effect: "自然之力！！！+2最大队伍规模",
      levelDesc: "同一结构化效果：+2最大队伍规模",
    }],
  },
  { id: "predator", name: "Predator", num_list: [1] },
  { id: "cap", name: "Cap", num_list: [2] },
];
const specialSnapshot = {
  stat_date: "20990101",
  source: { battle_type: "31", lineup_version_id: "v6", set_id: "99" },
  static_basis: { patch_package: "synthetic", version: "s99_1", season: "s99" },
  tiers: {
    "0": {
      main_trait_strength: [
        { main_traits: specialForestTrait, node1_top1_rate: 0.2, node1_top4_rate: 0.7, node1_use_rate: 0.03 },
        { main_traits: specialRiftTrait, node1_top1_rate: 0.3, node1_top4_rate: 0.6, node1_use_rate: 0.02 },
      ],
      trait_details: [],
      trait_groups: [
        {
          main_traits: specialForestTrait,
          data: {
            minor_traits_datas: Array.from({ length: 9 }, (_, index) => `lux-form-${index + 1}`).map((luxSourceId, index) => ({
              hero_list: [
                ...Array.from({ length: 7 }, (_, unitIndex) => `forest-${unitIndex + 1}`),
                "forest-carry",
                luxSourceId,
              ],
              trait_list: specialForestTrait,
              use_num: 100 - index,
            })),
          },
        },
        {
          main_traits: specialRiftTrait,
          data: {
            minor_traits_datas: [{
              hero_list: [
                ...Array.from({ length: 8 }, (_, index) => `rift-${index + 1}`),
                "dragon",
                "cap-one",
                "cap-two",
              ],
              trait_list: specialRiftTrait,
              use_num: 80,
            }],
          },
        },
      ],
      hero_strength: { "255": [] },
      hero_equip_rankings: { by_hero_id: {} },
      equip_rank: { list: [] },
      lineup_group: { main_traits_data: [] },
      recipe_sources: {
        winning: { capability: { status: "unavailable" }, recipes: [] },
        popular: { capability: { status: "unavailable" }, recipes: [] },
      },
    },
  },
};
const specialIndex = buildLiveRankingStrategyIndex(specialSnapshot, {
  ...options,
  champions: specialChampions,
  traits: specialTraits,
  sourceEntityMappings: {
    champion_mappings: Array.from({ length: 9 }, (_, index) => `lux-form-${index + 1}`).map((sourceId) => ({
      source_id: sourceId,
      canonical_champion_id: "lux",
      variant_trait_id: "forest",
      mapping_kind: "synthetic_variant",
    })),
  },
});
const specialForestCandidate = materializedCandidate(specialIndex,
  (row) => row.provenance?.source_anchor_id === "national:910001:9");
assert(specialForestCandidate, "the special-form lineup must remain addressable by its source strength anchor");
assert.equal(specialForestCandidate.main_trait_list.find((trait) => trait.trait_id === "forest")?.count, 9,
  "every mapped form must use the Core-declared variant trait contribution instead of a hardcoded one");
assert(specialForestCandidate.variants.every((variant) => (
  variant.canonical_lineup_identity.active_traits.find((trait) => trait.trait_id === "forest")?.count === 9
)), "all source forms of the same canonical unit must preserve the declared variant contribution");
assert(specialForestCandidate.variants.every((variant) => (
  variant.atomic_roster_members.find((unit) => unit.champion_id === "lux")?.population_cost === 1
)), "a special-form unit must retain its Core-declared population cost");
assert(specialForestCandidate.variants.every((variant) => (
  variant.atomic_roster_members.find((unit) => unit.champion_id === "lux")
    ?.special_trait_contributions?.[0]?.trait_name === "Forest"
)), "special trait contribution evidence must remain readable without another catalog lookup");

const sourceDeclaredForest = structuredClone(specialSnapshot);
sourceDeclaredForest.tiers["0"].trait_groups[0].data.minor_traits_datas = [{
  hero_list: [
    ...Array.from({ length: 4 }, (_, index) => `forest-${index + 1}`),
    "forest-carry",
    "lux-form-1",
  ],
  trait_list: specialForestTrait,
  use_num: 100,
}];
const sourceDeclaredForestIndex = buildLiveRankingStrategyIndex(sourceDeclaredForest, {
  ...options,
  champions: specialChampions,
  traits: specialTraits,
  sourceEntityMappings: {
    champion_mappings: [{
      source_id: "lux-form-1",
      canonical_champion_id: "lux",
      variant_trait_id: "forest",
      mapping_kind: "synthetic_variant",
    }],
  },
});
const sourceDeclaredForestCandidate = materializedCandidate(sourceDeclaredForestIndex,
  (row) => row.provenance?.source_anchor_id === "national:910001:9");
const sourceDeclaredForestVariant = sourceDeclaredForestCandidate.variants[0];
assert.equal(sourceDeclaredForestCandidate.main_trait_list.find((trait) => trait.trait_id === "forest")?.count, 9,
  "the player-visible candidate trait must preserve the source-declared Ranking breakpoint");
assert.equal(sourceDeclaredForestCandidate.strength_anchor.traits.find((trait) => trait.canonical_trait_id === "forest")?.breakpoint, 9,
  "the strength anchor must not be overwritten by a lower roster-derived count");
assert.equal(sourceDeclaredForestCandidate.strength_anchor.semantic_identity_authority,
  "current_ranking_strength_anchor_with_current_core_roster_audit",
  "the strength anchor authority must distinguish Ranking strength from Core roster audit semantics");
assert.equal(sourceDeclaredForestVariant.canonical_lineup_identity.observed_traits
  .find((trait) => trait.trait_id === "forest")?.count, 6,
  "the current-Core roster derivation must remain available independently of the source declaration");
assert.deepEqual(sourceDeclaredForestVariant.trait_state_reconciliation?.unresolved_contribution_gaps, [{
  trait_id: "forest",
  trait_name: "Forest",
  source_declared_count: 9,
  roster_derived_count: 6,
  missing_contribution: 3,
}], "an unexplained source breakpoint must be explicit instead of silently relabeled as the derived count");
assert.equal(sourceDeclaredForestVariant.trait_signature.traits
  .find((trait) => trait.canonical_trait_id === "forest")?.count, 9,
  "typed Ranking retrieval must match the source-declared trait state");

const emblemTrait = [{
  trait_id: "10000103",
  hero_num: 3,
  canonical_trait_id: "t-alpha",
  source_trait_text: "Alpha",
  source_dictionary_status: "resolved_official_frontend_dictionary",
}];
const emblemSnapshot = snapshot();
emblemSnapshot.tiers["0"].main_trait_strength[0].main_traits = emblemTrait;
emblemSnapshot.tiers["0"].trait_groups[0].main_traits = emblemTrait;
emblemSnapshot.tiers["0"].trait_groups[0].data.minor_traits_datas[0].trait_list = emblemTrait;
emblemSnapshot.tiers["0"].lineup_group.main_traits_data = [];
emblemSnapshot.tiers["0"].recipe_sources.winning = {
  capability: { status: "available", source_stat_date: "20990101" },
  recipes: [{
    recipe_id: "alpha-emblem",
    source_main_traits: emblemTrait,
    final_roster: ["c1", "c2", "c3", "c4"].map((championId) => ({
      champion_id: championId,
      items: championId === "c3" ? [{ id: "i-alpha-emblem" }] : [],
    })),
    roles: { main_carry: "c1", primary_tank: "c2" },
  }],
};
const emblemOptions = {
  ...options,
  traits: options.traits.map((trait) => trait.id === "t-alpha" ? { ...trait, num_list: [2, 3] } : trait),
  items: [...options.items, { id: "i-alpha-emblem", name: "Alpha Emblem", tags: ["emblem"], desc: "Grants the Alpha trait" }],
};
const emblemCandidate = materializedCandidate(buildLiveRankingStrategyIndex(emblemSnapshot, emblemOptions),
  (row) => row.provenance?.source_anchor_id === "national:100001:3");
const emblemVariant = emblemCandidate.variants[0];
assert.equal(emblemVariant.canonical_lineup_identity.observed_traits.find((trait) => trait.trait_id === "t-alpha")?.count, 2);
assert.equal(emblemVariant.trait_state_reconciliation.status, "source_declaration_explained_by_recipe_emblems");
assert.equal(emblemVariant.trait_state_reconciliation.unresolved_contribution_gaps.length, 0);
assert.deepEqual(emblemVariant.formation_profile.trait_completion_evidence.explained_contribution_gaps[0].evidence
  .map((entry) => [entry.item_id, entry.holder_id, entry.granted_trait_id]), [["i-alpha-emblem", "c3", "t-alpha"]]);
const projectedEmblem = projectRankingToolCandidate({
  candidate_id: emblemCandidate.lineup_group_id,
  strategy_profile: { canonical_variant: emblemVariant, formation_profile: emblemVariant.formation_profile },
});
assert.equal(projectedEmblem.strategy_profile.canonical_variant.formation_profile
  .trait_completion_evidence.explained_contribution_gaps[0].evidence[0].item_name, "Alpha Emblem");

const popularEmblemSnapshot = structuredClone(emblemSnapshot);
popularEmblemSnapshot.tiers["0"].recipe_sources.winning.capability.status = "unavailable";
popularEmblemSnapshot.tiers["0"].recipe_sources.popular = {
  capability: { status: "available", source_stat_date: "20990101" },
  recipes: popularEmblemSnapshot.tiers["0"].recipe_sources.winning.recipes,
};
const popularEmblem = materializedCandidate(buildLiveRankingStrategyIndex(popularEmblemSnapshot, emblemOptions),
  (row) => row.provenance?.source_anchor_id === "national:100001:3");
assert.equal(popularEmblem.variants[0].trait_state_reconciliation.explained_contribution_gaps[0]
  .evidence[0].source_role, "popular_recipe",
  "an exact official popular recipe may explain a trait gap without inheriting its strength");

const unsupportedEmblemSnapshot = structuredClone(emblemSnapshot);
unsupportedEmblemSnapshot.tiers["0"].recipe_sources.winning.capability.status = "unavailable";
const unsupportedEmblem = materializedCandidate(buildLiveRankingStrategyIndex(unsupportedEmblemSnapshot, emblemOptions),
  (row) => row.provenance?.source_anchor_id === "national:100001:3");
assert.equal(unsupportedEmblem.variants[0].trait_state_reconciliation.status,
  "source_declaration_requires_unmodeled_contribution",
  "a source breakpoint without an exact published emblem must stay unresolved");

const naturalHolderSnapshot = structuredClone(emblemSnapshot);
naturalHolderSnapshot.tiers["0"].recipe_sources.winning.recipes[0].final_roster[2].items = [];
naturalHolderSnapshot.tiers["0"].recipe_sources.winning.recipes[0].final_roster[0].items = [{ id: "i-alpha-emblem" }];
const naturalHolder = materializedCandidate(buildLiveRankingStrategyIndex(naturalHolderSnapshot, emblemOptions),
  (row) => row.provenance?.source_anchor_id === "national:100001:3");
assert.equal(naturalHolder.variants[0].trait_state_reconciliation.status,
  "source_declaration_requires_unmodeled_contribution",
  "an emblem on a natural holder cannot explain an additional trait contribution");

const specialRiftCandidate = materializedCandidate(specialIndex,
  (row) => row.provenance?.source_anchor_id === "national:910002:10");
assert(specialRiftCandidate, "the team-size lineup must remain addressable by its source strength anchor");
const specialRiftVariant = specialRiftCandidate.variants[0];
assert.equal(specialRiftVariant.canonical_lineup_identity.active_traits
  .find((trait) => trait.trait_id === "rift")?.count, 10,
  "a multi-population unit must retain its Core-declared trait contribution");
assert.equal(specialRiftVariant.atomic_roster_members.find((unit) => unit.champion_id === "dragon")?.population_cost, 2,
  "a multi-population unit must retain its Core-declared population cost");
assert.equal(specialRiftVariant.roster_unit_count, 11);
assert.equal(specialRiftVariant.occupied_population, 12);
assert.equal(specialRiftVariant.base_team_size, 10);
assert.equal(specialRiftVariant.team_size_bonus, 2);
assert.equal(specialRiftVariant.effective_team_size, 12);
assert.equal(specialRiftVariant.population, 10,
  "the Ranking population field must represent the base level required to field the legal roster");
assert.equal(specialRiftVariant.population_legal, true);
assert.equal(specialRiftVariant.team_size_modifiers[0]?.activation_occupied_population, 10,
  "a trait-granted team-size bonus must prove that its activating units fit before the bonus applies");
assert.equal(specialRiftVariant.team_size_modifiers[0]?.source_effect, "+2最大队伍规模",
  "team-size evidence must exclude unrelated dynamic text from the active breakpoint description");
assert.equal(specialRiftVariant.formation_profile.shared_feasibility.target_population, 10);

const heroProfile = tier.hero_profiles.find((row) => row.champion_id === "c1");
assert.deepEqual(heroProfile.selected_item_packages.highest_top1.item_ids, ["i-top1"]);
assert.deepEqual(heroProfile.selected_item_packages.most_popular.item_ids, ["i-popular"]);
assert.equal(alpha.equipment_requirements.main_carry.hero_ranking_item_evidence.precedence, "hero_ranking_highest_top1_then_most_popular");

const hostileRosterSnapshot = snapshot();
hostileRosterSnapshot.tiers["0"].lineup_group.main_traits_data = [winningGroup({ lineup: ["c1", "c2", "c3", "c4", "c6"] })];
const hostileIndex = buildLiveRankingStrategyIndex(hostileRosterSnapshot, options);
const hostileAlpha = materializedCandidate(hostileIndex,
  (row) => row.provenance?.source_anchor_id === "national:100001:2");
assert.deepEqual(hostileAlpha.core_unit_ids, ["c1", "c2", "c3", "c4"]);
assert.equal(hostileAlpha.core_unit_ids.includes("c6"), false);

const metricMutation = snapshot();
const winningVariant = metricMutation.tiers["0"].lineup_group.main_traits_data[0].info.list[0];
Object.assign(winningVariant, { top_1_rate: -999, top_4_rate: -999, avg_rank: 999, use_rate: 999, use_num: 1 });
Object.assign(metricMutation.tiers["0"].lineup_group.main_traits_data[0].info.info.sum, { top_1_rate: -999, top_4_rate: -999, avg_rank: 999, use_rate: 999, use_num: 1 });
Object.assign(metricMutation.tiers["0"].recipe_sources.popular.recipes[0], { top_1_rate: -999, top_4_rate: -999, avg_rank: 999, use_rate: 999, use_num: 1 });
assert.deepEqual(buildLiveRankingStrategyIndex(metricMutation, options), index);

const noRoster = snapshot();
noRoster.tiers["0"].trait_groups = [];
assert.equal(buildLiveRankingStrategyIndex(noRoster, options).tiers["0"].lineup_candidates.length, 0);

const unresolvedOfficialSourceUnit = snapshot();
unresolvedOfficialSourceUnit.tiers["0"].trait_groups[0].data.minor_traits_datas = [{
  hero_list: ["c1", "c2", "c3", "external-99"],
  trait_list: alphaTrait,
  use_num: 123,
}];
unresolvedOfficialSourceUnit.tiers["0"].lineup_group.main_traits_data = [];
unresolvedOfficialSourceUnit.tiers["0"].recipe_sources = { popular: { recipes: [] }, winning: { recipes: [] } };
const unresolvedIndex = buildLiveRankingStrategyIndex(unresolvedOfficialSourceUnit, options);
const unresolvedAlpha = materializedCandidate(unresolvedIndex,
  (row) => row.provenance?.source_anchor_id === "national:100001:2");
assert.equal(unresolvedAlpha, undefined,
  "a population-bearing source unit without a canonical name or identity must quarantine the candidate instead of exposing a raw id to the Agent");

const crossFamilyOverlap = snapshot();
crossFamilyOverlap.tiers["0"].lineup_group.main_traits_data = [winningGroupForTrait({
  id: "winning-beta-overlap",
  traitRows: betaTrait,
  lineup: ["c1", "c2", "c3", "c6"],
})];
crossFamilyOverlap.tiers["0"].recipe_sources.popular.recipes = [];
const guardedIndex = buildLiveRankingStrategyIndex(crossFamilyOverlap, options);
const guardedAlpha = materializedCandidate(guardedIndex,
  (row) => row.provenance?.source_anchor_id === "national:100001:2");
assert.equal(guardedAlpha.recipe_match.classification, "compatible",
  "raw family ids must not block a structurally compatible recipe when current Core derives the same semantic trait set");
assert.deepEqual(guardedAlpha.variants[0].transitions, [],
  "a compatible recipe must remain a named alternative and cannot inject transitions into the standard atomic roster");
assert.equal(guardedAlpha.variants[0].positioning_template, null,
  "a compatible recipe must not inject positioning into the standard atomic roster");
assert.equal(guardedAlpha.variants[0].playbook, null,
  "a compatible recipe must not inject its playbook into the standard atomic roster");
assert.deepEqual(guardedAlpha.main_trait_list.map((trait) => trait.canonical_trait_id).sort(), ["t-alpha", "t-beta"]);
assert.equal(guardedAlpha.main_trait_list.some((trait) => trait.family_id), false,
  "source family ids must not enter production trait semantics");
assert.ok(tier.reverse_indexes.trait["t-alpha"].includes(alpha.lineup_group_id));
assert.ok(tier.reverse_indexes.champion.c1.includes(alpha.lineup_group_id));
assert.ok(tier.reverse_indexes.item["i-recipe"].includes(alpha.lineup_group_id));
assert.ok(tier.reverse_indexes.augment.a1.includes(alpha.lineup_group_id));
assert.equal(tier.data_quality.recipe_metrics_authority, false);
assert.equal(tier.data_quality.canonical_roster_authority, "national_master_plus_trait_group_minor_traits_datas_hero_list");

const rawIdentityMutation = snapshot();
rawIdentityMutation.tiers["0"].main_trait_strength[0].main_traits[0].trait_id = "99999102";
rawIdentityMutation.tiers["0"].trait_groups[0].main_traits[0].trait_id = "99999102";
rawIdentityMutation.tiers["0"].trait_groups[0].data.minor_traits_datas[0].trait_list[0].trait_id = "99999102";
const rawIdentityIndex = buildLiveRankingStrategyIndex(rawIdentityMutation, options);
const rawIdentityAlpha = materializedCandidate(rawIdentityIndex,
  (row) => row.provenance?.source_anchor_id === "national:999991:2");
alphaTrait[0].trait_id = "10000102";
assert(rawIdentityAlpha);
assert.equal(rawIdentityAlpha.lineup_group_id, alpha.lineup_group_id,
  "raw source family ids must not change the canonical candidate identity when official text/Core identity and roster are unchanged");
assert.equal(rawIdentityAlpha.candidate_evidence_id, alpha.candidate_evidence_id,
  "raw source family ids must not change candidate evidence identity");

const recentLagSnapshot = snapshot();
recentLagSnapshot.stat_date = "20990102";
recentLagSnapshot.tiers["0"].recipe_sources.winning.capability.source_stat_date = "20990101";
recentLagSnapshot.tiers["0"].recipe_sources.popular.capability.source_stat_date = "20990101";
const recentLagIndex = buildLiveRankingStrategyIndex(recentLagSnapshot, options);
const recentLagAlpha = materializedCandidate(recentLagIndex,
  (row) => row.provenance?.source_anchor_id === "national:100001:2");
assert.equal(recentLagAlpha.recipe_match.source_role, "winning_recipe");
assert.equal(recentLagAlpha.recipe_match.freshness.status, "recent_lag");

const expiredRecipeSnapshot = snapshot();
expiredRecipeSnapshot.stat_date = "20990110";
expiredRecipeSnapshot.tiers["0"].recipe_sources.winning.capability.source_stat_date = "20990101";
expiredRecipeSnapshot.tiers["0"].recipe_sources.popular.capability.source_stat_date = "20990101";
const expiredIndex = buildLiveRankingStrategyIndex(expiredRecipeSnapshot, options);
const expiredAlpha = materializedCandidate(expiredIndex,
  (row) => row.provenance?.source_anchor_id === "national:100001:2");
assert.equal(expiredAlpha.recipe_match.source_role, null);
assert.equal(expiredAlpha.recipe_match.classification, "unmatched");

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-live-ranking-strategy-index-verifier-v2",
  checked: [
    "master_plus_only",
    "national_canonical_roster_required",
    "national_roster_immutable",
    "winning_recipe_primary_enrichment",
    "popular_recipe_secondary_enrichment",
    "unresolved_population_unit_quarantines_candidate_instead_of_exposing_raw_id",
    "recipe_metrics_metamorphic_invariance",
    "recipe_strength_inheritance_forbidden",
    "compatible_recipe_cannot_inject_transition_positioning_or_playbook",
    "raw_source_family_id_metamorphic_invariance",
    "core_declared_variant_trait_contribution_for_all_source_forms",
    "source_declared_trait_state_reconciled_with_core_roster_derivation",
    "exact_recipe_emblem_explains_only_proven_trait_completion_gap",
    "core_declared_unit_population_cost",
    "active_trait_granted_team_size_and_activation_population",
    "highest_top1_then_most_popular_item_precedence",
    "reverse_indexes_use_national_candidate_identity",
    "recent_lag_recipe_remains_structural_evidence",
    "expired_recipe_cannot_pair_automatically",
  ],
}, null, 2)}\n`);
