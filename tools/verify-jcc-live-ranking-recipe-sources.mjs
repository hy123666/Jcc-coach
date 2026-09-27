import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildRankingRecipeAuxiliaryRegistry,
  fetchAndPublishRankingRecipeCandidate,
  publishRankingRecipeCandidate,
  pruneRankingRecipeGenerations,
  winningRecipeGroupsFromRaw,
} from "./jcc_live_rankings_recipe_sources.mjs";
import {
  activateRankingRecipeGeneration,
  resolveActiveRankingRecipeGenerationSync,
} from "./jcc_live_rankings_recipe_store.mjs";
import { acquireLiveRankingRefreshLease } from "./jcc_live_rankings_generation_store.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "jcc-recipe-sources-"));
const target = {
  season_id: "s18",
  patch_id: "s18_1",
  core_profile_id: "a".repeat(64),
  upstream_identity: { mode: "18", season: "S19", version: "18.18.1" },
  ranking_sources: {
    popular_lineups: {
      source_role: "secondary_recipe_only",
      source_kind: "official_curated_popular_lineup",
      url: "https://game.gtimg.cn/images/lol/act/jkzlkauto/json/lineupJson/m19/11/18/lineup_detail_total.json",
      channel: "11",
      mode: "18",
      upstream_season: "19",
      max_source_age_hours: 72,
      metrics_authority: false,
      player_lineups_enabled: false,
      known_unresolved_references: [{
        kind: "augment",
        source_id: "missing-augment",
        observed_in_recipe_source_id: "official-1",
        status: "stale_hidden_source_reference",
        policy: "exclude_from_recipe_candidates_and_retain_audit_reference",
      }],
    },
  },
};
const catalogs = {
  champions: [
    { id: "h1", mumu_base_id: "rh1", name: "Carry" },
    {
      id: "h2",
      name: "Tank",
      raw_refs: { origin_hero_ids: ["source-variant-h2"] },
      source_mappings: [{
        source_id: "source-variant-h2",
        mapping_kind: "grand_elementalist_variant",
        authority: "test_fixture",
        variant_order: 2,
        variant_trait_id: "trait-2",
        variant_trait_name: "Variant Trait",
      }],
    },
    { id: "h3", name: "Transition" },
    {
      id: "h4",
      name: "Compressed Source Variant",
      source_mappings: [{
        source_id: "15462",
        mapping_kind: "grand_elementalist_variant",
        authority: "test_fixture",
        variant_order: 2,
        variant_trait_id: "trait-soul",
        variant_trait_name: "Soul Variant",
      }],
    },
  ],
  items: [{ id: "i1", name: "Sword" }, { id: "i2", name: "Armor" }],
  augments: [{ id: "a1", name: "Tempo" }],
};
const lease = await acquireLiveRankingRefreshLease({ rootDir: root });

const raw = {
  mode: "18",
  season: "19",
  channel: "11",
  status: "5",
  lineup_list: [
    {
      id: "official-1",
      top_1_rate: 0.99,
      use_num: 99999,
      detail: JSON.stringify({
        name: "Official recipe",
        hero_location: [
          { hero_id: "rh1", is_carry_hero: "1", equipment_id: "i1,missing-item", location: { x: 1, y: 2 } },
          { hero_id: "source-variant-h2", role: "primary_tank", equipment: [{ name: "Armor" }] },
          { hero_id: "pet-final-1", chess_type: "pet", location: { x: 2, y: 2 } },
          { hero_id: "external-final-1", chess_type: "hero", location: { x: 3, y: 2 } },
        ],
        hexbuff: { recomm: "a1,missing-augment", replace: "" },
        summary: "Keep the published roster together.",
        early_game: "Use a cheap holder.",
        levelMap: {
          5: {
            lineup: [
              "h3",
              { hero_id: "pet-transition-1", chess_type: "pet", location: "2,4" },
              { hero_id: "summon-transition-1", chess_type: "summon", location: "3,4" },
            ],
            text: "Transition board",
          },
        },
        shareCode: "JCC-CODE-1",
        avg_rank: 1.1,
        play_rate: 0.8,
      }),
    },
    {
      id: "player-1",
      is_ugc: true,
      detail: { hero_location: ["h1"] },
    },
    {
      id: "nested-player-1",
      detail: JSON.stringify({ pid: "12345", hero_location: ["h1"] }),
    },
    {
      id: "unknown-hero",
      detail: { hero_location: ["missing-hero"] },
    },
    {
      id: "identity-mismatch",
      channel: "12",
      detail: { hero_location: ["h1"] },
    },
  ],
};

let fetchCount = 0;
let fetchedUrl = null;
const fetchImpl = async (url, options) => {
  fetchCount += 1;
  fetchedUrl = url;
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "error");
  return {
    ok: true,
    status: 200,
    url,
    headers: new Map([
      ["etag", "test-etag"],
      ["last-modified", "Sat, 22 Aug 2026 03:30:09 GMT"],
    ]),
    json: async () => structuredClone(raw),
  };
};

function assertNoStatistics(value) {
  const serialized = JSON.stringify(value);
  for (const field of ["top_1_rate", "top_4_rate", "avg_rank", "use_num", "use_rate", "play_rate", "lineup_rank", "rank", "sample_size", "score", "metrics"]) {
    assert.equal(serialized.includes(`\"${field}\"`), false, `normalized recipes must omit ${field}`);
  }
}

try {
  const adapterSource = await readFile(new URL("./jcc_live_rankings_recipe_sources.mjs", import.meta.url), "utf8");
  assert.equal(adapterSource.includes("get_lineup_recomm"), false);
  assert.equal(adapterSource.includes("get_lineup_detail"), false);

  await assert.rejects(
    fetchAndPublishRankingRecipeCandidate({
      target: {
        ...target,
        ranking_sources: { popular_lineups: { ...target.ranking_sources.popular_lineups, url: "https://game.gtimg.cn/go/jgame/get_lineup_recomm" } },
      },
      catalogs,
      rootDir: root,
      fetchImpl,
      lease,
    }),
    /allowlisted Tencent official curated HTTPS URL/,
  );
  await assert.rejects(
    fetchAndPublishRankingRecipeCandidate({
      target,
      catalogs,
      rootDir: root,
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        url,
        headers: new Map([
          ["etag", "stale-etag"],
          ["last-modified", "Sat, 01 Aug 2026 03:30:09 GMT"],
        ]),
        json: async () => structuredClone(raw),
      }),
      lease,
      now: Date.parse("2026-08-23T00:00:00Z"),
    }),
    /outside the configured freshness window/,
  );
  const first = await fetchAndPublishRankingRecipeCandidate({ target, catalogs, rootDir: root, fetchImpl, lease, now: Date.parse("2026-08-23T00:00:00Z") });
  assert.equal(fetchCount, 1, "adapter must fetch exactly one configured curated URL");
  assert.equal(first.capability.source_row_count, raw.lineup_list.length, "popular capability must retain the raw source row count separately from accepted recipes");
  assert.equal(fetchedUrl, target.ranking_sources.popular_lineups.url);
  assert.equal(first.capability.status, "available", JSON.stringify(first.quarantine));
  assert.equal(first.capability.source_role, "popular_recipe");
  assert.equal(first.capability.metrics_authority, false);
  assert.equal(first.capability.source_receipt.etag, "test-etag");
  assert.equal(first.capability.source_receipt.version_binding, "official_mode_endpoint_plus_current_core_catalog");
  assert.equal(first.recipes.length, 1);
  assert.deepEqual(first.quarantine.map((row) => row.reason).sort(), [
    "player_or_ugc_lineup",
    "player_or_ugc_lineup",
    "source_identity_mismatch",
    "unknown_final_champion",
  ]);

  const recipe = first.recipes[0];
  assert.equal(recipe.source_kind, "official_curated_popular_lineup");
  assert.deepEqual(recipe.final_roster.map((hero) => hero.champion_id), ["h1", "h2"]);
  assert.deepEqual(recipe.final_auxiliary_units, [
    {
      source_unit_id: "pet-final-1",
      source_unit_name: null,
      unit_type: "pet",
      position: { x: 2, y: 2 },
      items: [],
      occupies_population: false,
    },
    {
      source_unit_id: "external-final-1",
      source_unit_name: null,
      unit_type: "external_roster_unit",
      position: { x: 3, y: 2 },
      items: [],
      occupies_population: true,
      catalog_resolution: "unresolved_current_core_catalog",
      source_declared_unit_type: "hero",
    },
  ]);
  assert.equal(recipe.final_roster[0].role, "main_carry");
  assert.deepEqual(recipe.final_roster[0].items.map((item) => item.id), ["i1"]);
  assert.deepEqual(recipe.final_roster[0].unresolved_item_references, [{ id: "missing-item", name: "missing-item" }]);
  assert.deepEqual(recipe.augments.map((augment) => augment.id), ["a1"]);
  assert.equal(recipe.unresolved_catalog_references, undefined);
  assert.deepEqual(recipe.ignored_source_references, [{
    kind: "augment",
    reference: { id: "missing-augment", name: "missing-augment" },
    status: "stale_hidden_source_reference",
  }]);
  assert.deepEqual(recipe.final_roster[1].source_variant, {
    source_id: "source-variant-h2",
    order: 2,
    trait_id: "trait-2",
    trait_name: "Variant Trait",
  });
  assert.deepEqual(recipe.level_map[0].roster.map((hero) => hero.champion_id), ["h3"]);
  assert.deepEqual(recipe.level_map[0].auxiliary_units.map((unit) => [unit.unit_type, unit.source_unit_id]), [
    ["pet", "pet-transition-1"],
    ["summon", "summon-transition-1"],
  ]);
  assert.equal(recipe.level_map[0].population, 5);
  assert.equal(recipe.lineup_code, "JCC-CODE-1");
  assertNoStatistics(first.recipes);

  const restoredOfficialAugment = await fetchAndPublishRankingRecipeCandidate({
    target,
    catalogs: { ...catalogs, augments: [...catalogs.augments, { id: "missing-augment", name: "Restored Official Augment" }] },
    rootDir: root,
    fetchImpl,
    lease,
    now: Date.parse("2026-08-23T00:00:00Z"),
  });
  assert.equal(restoredOfficialAugment.recipes[0].ignored_source_references, undefined);
  assert.deepEqual(restoredOfficialAugment.recipes[0].augments.map((augment) => augment.id), ["a1", "missing-augment"]);

  const second = await fetchAndPublishRankingRecipeCandidate({ target, catalogs, rootDir: root, fetchImpl, lease, now: Date.parse("2026-08-23T00:00:00Z") });
  assert.equal(second.generation.generation_id, first.generation.generation_id, "identical input must publish the same content hash");
  assert.equal(await readFile(first.generation.generation_file, "utf8"), await readFile(second.generation.generation_file, "utf8"));
  const pointer = JSON.parse(await readFile(second.generation.candidate_pointer_file, "utf8"));
  assert.equal(pointer.generation_id, first.generation.generation_id);
  assert.equal(pointer.core_profile_id, target.core_profile_id);
  const activated = await activateRankingRecipeGeneration({ rootDir: root, target, generation: second.generation, lease });
  assert.equal(activated.pointer.generation_id, second.generation.generation_id);
  const resolvedActive = resolveActiveRankingRecipeGenerationSync({ rootDir: root, expectedIdentity: target });
  assert.equal(resolvedActive.availability, "available");
  assert.equal(resolvedActive.generation_id, second.generation.generation_id);
  assert.equal(resolveActiveRankingRecipeGenerationSync({
    rootDir: root,
    expectedIdentity: { ...target, core_profile_id: "c".repeat(64) },
  }).availability, "unavailable", "a recipe pointer from another Core Profile must fail closed");

  const winning = winningRecipeGroupsFromRaw({
    main_traits_data: [{
      id: "winning-group",
      info: {
        main_c_chess_id: "h1",
        list: [{
          lineup_rank: 1,
          lineup: ["h1", "h2", "pet-final-1"],
          assist_chess: ["h2"],
          main_c_chess_equip: ["i1"],
          assist_chess_equip: ["i2"],
          rune_id_group: ["a1"],
          top_1_rate: 0.8,
          top_4_rate: 0.9,
          avg_rank: 1.4,
          use_num: 321,
        }],
      },
    }],
  }, catalogs, {
    auxiliaryRegistry: buildRankingRecipeAuxiliaryRegistry(first.recipes),
  });
  assert.equal(winning.recipes.length, 1);
  assert.equal(winning.recipes[0].source_role, "winning_recipe");
  assert.deepEqual(winning.recipes[0].final_roster.map((hero) => hero.champion_id), ["h1", "h2"]);
  assert.deepEqual(winning.recipes[0].final_auxiliary_units.map((unit) => ({
    source_unit_id: unit.source_unit_id,
    unit_type: unit.unit_type,
    occupies_population: unit.occupies_population,
  })), [{
    source_unit_id: "pet-final-1",
    unit_type: "pet",
    occupies_population: false,
  }]);
  assertNoStatistics(winning.recipes);

  const winningCompressedVariant = winningRecipeGroupsFromRaw({
    main_traits_data: [{
      id: "winning-compressed-source-variant",
      info: {
        main_c_chess_id: "5462",
        list: [{ lineup_rank: 1, lineup: ["5462"] }],
      },
    }],
  }, catalogs);
  assert.equal(winningCompressedVariant.quarantine.length, 0);
  assert.deepEqual(winningCompressedVariant.recipes[0].final_roster.map((hero) => hero.champion_id), ["h4"]);
  assert.deepEqual(winningCompressedVariant.recipes[0].final_roster[0].source_variant, {
    source_id: "15462",
    order: 2,
    trait_id: "trait-soul",
    trait_name: "Soul Variant",
  });

  const combined = await publishRankingRecipeCandidate({
    target,
    rootDir: root,
    sourceCapabilities: {
      winning: { status: "available", metrics_authority: false },
      popular: first.capability,
    },
    recipes: [...winning.recipes, ...first.recipes],
    quarantine: [
      ...winning.quarantine.map((row) => ({ ...row, source_role: "winning_recipe" })),
      ...first.quarantine.map((row) => ({ ...row, source_role: "popular_recipe" })),
    ],
    lease,
  });
  assert.equal(combined.capability.status, "available");
  assert.equal(combined.capability.metrics_authority, false);
  assert.deepEqual(combined.generation ? combined.recipes.map((entry) => entry.source_role).sort() : [], ["popular_recipe", "winning_recipe"]);
  const combinedPointer = JSON.parse(await readFile(combined.generation.candidate_pointer_file, "utf8"));
  assert.deepEqual(combinedPointer.source_roles, ["popular_recipe", "winning_recipe"]);
  assertNoStatistics(combined.recipes);

  const staleTarget = { ...target, core_profile_id: "b".repeat(64) };
  const stale = await publishRankingRecipeCandidate({
    target: staleTarget,
    rootDir: root,
    sourceCapabilities: { popular: first.capability },
    recipes: first.recipes,
    quarantine: [],
    lease,
  });
  const pruned = await pruneRankingRecipeGenerations({
    rootDir: root,
    protectedCoreProfileIds: [target.core_profile_id],
    protectedGenerationIds: [stale.generation.generation_id],
    keepPrevious: 0,
    lease,
  });
  assert.deepEqual(pruned.removed_candidate_core_profile_ids, [staleTarget.core_profile_id]);
  assert(!pruned.deleted_generation_ids.includes(stale.generation.generation_id), "an active Match lease must protect its pinned recipe generation even after its candidate pointer is removed");
  assert(!pruned.deleted_generation_ids.includes(resolvedActive.generation_id), "pruning must retain the independently active recipe generation even after the candidate pointer advances");
  await readFile(path.join(root, resolvedActive.generation_path), "utf8");
  const retainedPointer = JSON.parse(await readFile(combined.generation.candidate_pointer_file, "utf8"));
  assert.equal(retainedPointer.core_profile_id, target.core_profile_id);
  const prunedAfterLeaseRelease = await pruneRankingRecipeGenerations({
    rootDir: root,
    protectedCoreProfileIds: [target.core_profile_id],
    keepPrevious: 10,
    lease,
  });
  assert(prunedAfterLeaseRelease.deleted_generation_ids.includes(stale.generation.generation_id), "the old recipe generation may be pruned after the Match lease is released");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-live-ranking-recipe-sources-verifier-v1",
    checked: [
      "configured_official_curated_url_only",
      "player_lineup_endpoints_absent",
      "curated_endpoint_path_and_redirect_policy_locked",
      "player_rows_quarantined",
      "mode_season_channel_status_validated",
      "http_freshness_receipt_bound_to_current_mode_and_catalog",
      "stale_curated_snapshot_rejected",
      "nested_player_metadata_quarantined",
      "unknown_final_champions_quarantined",
      "statistics_absent_from_normalized_recipes",
      "atomic_final_roster_preserved",
      "typed_auxiliary_units_preserved_without_champion_population_or_catalog_pollution",
      "explicit_unmapped_source_heroes_preserved_as_population_occupying_external_roster_units",
      "unknown_supplementary_recipe_references_do_not_drop_atomic_roster",
      "patch_source_champion_variants_resolve_to_one_canonical_champion_with_typed_form_metadata",
      "declared_stale_hidden_augment_references_are_audited_but_not_recommended",
      "current_official_catalog_resolution_overrides_a_stale_hidden-reference_exception",
      "match_pinned_recipe_generation_is_retained_until_its_lease_is_released",
      "detail_json_string_and_level_map_preserved",
      "deterministic_catalog_resolution",
      "winning_recipe_conversion_without_statistics",
      "winning_recipe_reuses_current_source_auxiliary_registry",
      "winning_and_popular_recipe_candidate_combined_atomically",
      "duplicate_input_same_generation_hash",
      "atomic_core_profile_candidate_pointer",
      "independent_active_recipe_generation_pointer_with_core_identity_closure",
      "recipe_generation_pruning_shares_ranking_lifecycle_lease",
    ],
  }, null, 2)}\n`);
} finally {
  await lease.release();
  await rm(root, { recursive: true, force: true });
}
