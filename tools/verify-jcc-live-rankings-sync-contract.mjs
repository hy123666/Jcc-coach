import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildLiveRankingCoverageMinimums } from "./jcc_live_rankings_coverage_policy.mjs";
import { auditLiveRankingCatalogCompatibility } from "./jcc_live_rankings_catalog_compatibility.mjs";

const source = await readFile("tools/sync-jcc-live-rankings.mjs", "utf8");
const ensureSource = await readFile("tools/ensure-jcc-live-rankings.mjs", "utf8");
const strategyIndexBuilderSource = await readFile("tools/build-jcc-live-ranking-strategy-index.mjs", "utf8");
const finalizeSource = await readFile("tools/finalize-jcc-ranking-maintenance.mjs", "utf8");
const publicationClosureSource = await readFile("tools/jcc_live_rankings_active_closure.mjs", "utf8");
const patchManifest = JSON.parse(await readFile("data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-manifest.json", "utf8"));
const hardDataManifestPath = patchManifest.source_artifacts.find((entry) => entry.role === "hard_data_manifest")?.path;
assert.match(hardDataManifestPath || "", /^data\/core-patches\/jcc\/generations\/[a-f0-9]{64}\/manifest\.json$/);
const hardDataPackageDir = path.dirname(hardDataManifestPath);
const s18Catalogs = await Promise.all([
  readFile(path.join(hardDataPackageDir, "normalized/traits.json"), "utf8").then((text) => JSON.parse(text)),
  readFile(path.join(hardDataPackageDir, "normalized/champions.json"), "utf8").then((text) => JSON.parse(text)),
  readFile(path.join(hardDataPackageDir, "normalized/items.json"), "utf8").then((text) => JSON.parse(text)),
]);
const s18Minimums = buildLiveRankingCoverageMinimums({
  traits: s18Catalogs[0],
  champions: s18Catalogs[1],
  items: s18Catalogs[2],
});

function firstIdentity(rows, fields) {
  for (const row of rows) {
    for (const field of fields) {
      const value = row?.[field];
      if (String(value || "").trim()) return String(value);
    }
  }
  throw new Error(`Fixture catalog has no identity in fields: ${fields.join(", ")}`);
}

function compatibilityFixture({ championId, itemId }) {
  return {
    tiers: {
      master_plus: {
        hero_strength: { node1: [{ hero_id: championId }] },
        lineup_group: {
          main_traits_data: [{
            info: {
              main_c_chess_id: championId,
              list: [{
                lineup: [championId],
                core_chess: [championId],
                free_chess: [],
                assist_chess: [],
                main_c_chess_equip: [itemId],
                assist_chess_equip: [itemId],
              }],
            },
          }],
        },
        equip_rank: { list: [{ equip_id: itemId }] },
        hero_equip_rankings: {
          by_hero_id: {
            [championId]: {
              single_itemid: [itemId],
              combine_itemid_details: [{ equips: [itemId] }],
            },
          },
        },
      },
    },
  };
}

const s18ChampionId = firstIdentity(s18Catalogs[1], ["id", "champion_id", "canonical_id", "mumu_base_id"]);
const s18ItemId = firstIdentity(s18Catalogs[2], ["id", "equip_id", "icon_key"]);
const matchingCatalogAudit = auditLiveRankingCatalogCompatibility(
  compatibilityFixture({ championId: s18ChampionId, itemId: s18ItemId }),
  { champions: s18Catalogs[1], items: s18Catalogs[2] },
);
const foreignCatalogAudit = auditLiveRankingCatalogCompatibility(
  compatibilityFixture({ championId: "retired-season-champion", itemId: "retired-season-item" }),
  { champions: s18Catalogs[1], items: s18Catalogs[2] },
);

const findLatestStart = source.indexOf("async function findLatestStatDate");
assert(findLatestStart >= 0, "sync must define findLatestStatDate");
const findLatestEnd = source.indexOf("async function fetchTierData", findLatestStart);
assert(findLatestEnd > findLatestStart, "sync must keep findLatestStatDate before fetchTierData");
const findLatestBody = source.slice(findLatestStart, findLatestEnd);

assert(source.includes('const MASTER_PLUS_TIER_ID = "0"'), "sync must define one Master+ tier identity");
assert(findLatestBody.includes("tier_part: MASTER_PLUS_TIER_ID"), "trait and hero date probes must use Master+ tier 0");
assert(!source.includes('tier_part: "255"'), "sync must never query the all-tier ranking partition");
assert(ensureSource.includes('const MASTER_PLUS_TIER_ID = "0"'), "freshness guard must define the same Master+ tier identity");
assert(ensureSource.includes("tier_part: MASTER_PLUS_TIER_ID"), "freshness guard must probe Master+ tier 0");
assert(!ensureSource.includes('tier_part: "255"'), "freshness guard must never query the all-tier ranking partition");

assert(
  findLatestBody.includes('"/go/jgame/get_main_trait_strength_trend"')
    && findLatestBody.includes('"/go/jgame/get_hero_strength_trend"'),
  "latest stat_date probe must require both trait and hero endpoints, not trait-only availability",
);
assert(
  findLatestBody.includes("const heroCount")
    && findLatestBody.includes("heroCount > 0")
    && findLatestBody.includes("heroProbeCount"),
  "latest stat_date probe must skip dates whose hero-strength payload is empty",
);
assert(
  source.includes("hero_probe_count: latest.heroProbeCount"),
  "snapshot must record hero_probe_count so data freshness failures are diagnosable",
);
assert(
  findLatestBody.includes("traitProbeFingerprint")
    && findLatestBody.includes("heroProbeFingerprint")
    && findLatestBody.includes("adjacentTraitProbeFingerprint")
    && findLatestBody.includes("adjacentHeroProbeFingerprint")
    && findLatestBody.includes("dateBindingVerified")
    && source.includes("master_plus_probe_response_drift")
    && source.includes("master_plus_request_identity_mismatch"),
  "date probes and fetched Master+ payloads must be bound by request identity and response fingerprints",
);
assert(
  source.includes("winningSourceEligible")
    && source.includes("evaluateRecipeSourceFreshness")
    && source.includes("recipeFreshnessAllowsAutomaticPairing")
    && source.includes("winningFreshness.status")
    && source.includes("publishableWinningRecipes")
    && source.includes("master_plus_audit_failed_before_winning_recipe_publication"),
  "winning recipes must follow the shared freshness contract: recent lag is structural evidence, expired or undated sources are quarantined",
);
assert(
  source.includes("winningRecipeCount")
    && source.includes('warnings.push({ reason: "winning_recipe_count_below_minimum"')
    && !source.includes("minimums.lineupGroupCount")
    && !source.includes('winning_recipe_group_below_minimum')
    && source.includes("winningRecipes?.recipes")
    && source.includes('warnings.push({ reason: "master_plus_canonical_roster_partial"'),
  "winning recipe coverage must use normalized recipes rather than upstream grouping count and remain diagnostic",
);
assert(
  source.includes("winningSourceGroupCount")
    && source.includes("winningSourceVariantCount")
    && source.includes("popularSourceRowCount")
    && source.includes("popularRecipeCount"),
  "ranking coverage must retain raw source counts separately from normalized recipe counts",
);
assert(
  source.includes('import { rankingCapabilityWarnings } from "./jcc_live_rankings_capability_status.mjs"')
    && source.includes("const capabilityStatus = rankingCapabilityWarnings(audit, strategyIndex)")
    && source.includes("capability_status: capabilityStatus")
    && source.includes("full_ranking_overlay_available: capabilityStatus.full_ranking_overlay_available")
    && source.includes("ranking_strength_available: strengthSnapshotAvailable"),
  "sync output must expose layered capability status instead of deriving publication from audit.status alone",
);
assert(
  !source.includes("full_ranking_overlay_available: audit.status === \"pass\"")
    && !source.includes("candidate_verification: audit.status === \"pass\" || audit.status === \"partial\""),
  "sync output must not collapse non-blocking partial domains into a globally unavailable overlay",
);
assert(
  source.includes("async function readActiveSignal")
    && source.includes("activeClosure.ranking.generation_dir")
    && source.includes("readActiveSignal(activeClosureBeforeUpdate)")
    && source.indexOf("activeClosureBeforeUpdate") < source.indexOf("const existingCurrentSignal"),
  "same-date comparison must read the authoritative active Ranking generation rather than a stale current mirror",
);
assert(
  source.includes('const activeClosureBeforeUpdate = rankingTarget.publication_scope === "active"')
    && source.includes('if (rankingTarget.publication_scope === "active" && activeClosureBeforeUpdate.closure_status === "invalid")'),
  "candidate Ranking refresh must not be blocked by an incompatible production Active closure; only an active-target refresh validates that closure",
);
assert(
  source.includes("resolveRankingRefreshBaselineClosureSync")
    && source.includes("activeClosureBeforeUpdate.target_compatible === true"),
  "an active refresh may replace a complete previous-Core closure but must not use it as the new Core's current-day comparison baseline",
);
assert(
  source.indexOf("const audit = buildAudit") < source.indexOf("const combinedRecipeCandidate = await publishRankingRecipeCandidate"),
  "Master+ audit must complete before any combined winning/popular recipe candidate is published",
);
assert(
  source.includes("stat_date: strengthSnapshotAvailable ? snapshot.stat_date : null")
    && source.includes("attempted_stat_date: strengthSnapshotAvailable ? null : snapshot.stat_date")
    && source.includes("winning: publishableWinningRecipes.capability"),
  "sync output must expose the stat date only when the strength capability is available",
);
assert(
  source.includes("No non-empty trait+hero ranking data found"),
  "failure message must identify trait+hero freshness, not generic ranking data",
);
assert(
  source.includes("[\"ready\", \"ready_with_source_lag\"].includes(capabilityStatus.overall_status)")
    && source.includes("verifyRankingCandidate(stagingDir")
    && source.includes("last_known_good_current"),
  "ranking refresh must prepare an immutable staged candidate only after audit and full candidate verification pass",
);
assert(
  ensureSource.includes('import { classifyRankingCapabilityStatus } from "./jcc_live_rankings_capability_status.mjs"')
    && ensureSource.includes("const capabilityStatus = classifyRankingCapabilityStatus(audit)")
    && ensureSource.includes('["ready", "ready_with_source_lag"].includes(capabilityStatus.overall_status)')
    && ensureSource.includes('capabilityStatus.strength_status !== "available"'),
  "freshness guard must share layered capability classification with the update and Runtime consumers",
);
assert(
  source.includes('import { resolveRankingTarget } from "./jcc_ranking_target.mjs"')
    && source.includes("await resolveRankingTarget")
    && source.includes('rankingTarget.publication_scope === "active"'),
  "ranking refresh must resolve one explicit Core Profile target and separate active from candidate publication",
);
assert(
  source.includes("activatePointer: false")
    && source.includes('schema: "jcc-live-ranking-candidate-pointer-v1"')
    && source.includes("rankingTarget.candidate_pointer_file"),
  "candidate ranking refresh must publish an immutable generation without replacing the production pointer",
);
assert(
  source.includes("acquireLiveRankingRefreshLease")
    && source.includes('const semanticMaintenancePrepared = rankingTarget.publication_scope === "active" || args.deferActivation')
    && !source.includes("activateRankingClosure")
    && !source.includes("promoteRankingsCandidate"),
  "source synchronization must prepare Active candidates but never bypass semantic maintenance or the unified publication transaction",
);
assert(
  source.includes("active_generation: null")
    && source.includes("active_closure: null")
    && source.includes('candidate_generation: rankingTarget.publication_scope === "candidate"'),
  "source synchronization must never label a prepared or candidate-only generation as active",
);
assert(
  !source.includes("runtimePaths.activeSeasonModuleContract")
    && !source.includes("runtimePaths.activeGameKnowledgeProfile"),
  "candidate ranking identity must not be completed from the active season profile",
);
assert(
  source.includes("rankingTarget.ranking_set_id")
    && !source.includes("fetchTierData(tier.id, latest.statDate, hardDataManifest.mode)"),
  "season-specific ranking set identity must come from the resolved Core Profile target",
);
assert(
  source.includes("buildLiveRankingCoverageMinimums(staticData)")
    && !source.includes("equipCount: 178"),
  "ranking completeness thresholds must derive from the selected version catalogs rather than S17 counts",
);
assert(s18Minimums.equipCount <= s18Catalogs[2].length);
assert(s18Minimums.heroCount <= s18Catalogs[1].length);
assert(s18Minimums.traitCount <= s18Catalogs[0].length);
assert.equal(matchingCatalogAudit.status, "pass");
assert.equal(foreignCatalogAudit.status, "fail", "Foreign-season ranking rows must not be relabeled as the selected Ranking Overlay");
assert(foreignCatalogAudit.failures.every((failure) => failure.reason === "ranking_catalog_identity_mismatch"));
assert(
  !source.includes("rotateCurrentToPrevious"),
  "ranking refresh must not move current before the replacement candidate is validated",
);
assert(
  source.includes("buildLiveRankingStrategyIndex")
    && source.includes('"lineup-strategy-index.json"'),
  "ranking refresh must compile the typed lineup strategy index before promotion",
);
assert(
  strategyIndexBuilderSource.includes("buildOfficialSourceDictionary")
    && strategyIndexBuilderSource.includes("officialSourceDictionary")
    && strategyIndexBuilderSource.includes("official_source_dictionary"),
  "standalone Ranking strategy-index rebuilds must use the same official source-ID dictionary as the daily sync",
);
assert(
  ensureSource.includes("cachedComplete")
    && ensureSource.includes("legacy_manifest_missing_strategy_index")
    && ensureSource.includes("legacy_strategy_index_schema"),
  "ranking freshness guard must rebuild legacy caches that lack the typed strategy index contract",
);
assert(
  source.includes("archiveLiveRankingSignal(previousSignal")
    && source.indexOf("archiveLiveRankingSignal(previousSignal") < source.indexOf("buildLiveRankingTrendSummaryIncludingSignal(signal")
    && finalizeSource.lastIndexOf("archiveLiveRankingSignal(signal") > finalizeSource.lastIndexOf("completeCoreRankingPublicationTransaction"),
  "trend compilation must archive only the already committed previous baseline before compilation and archive the new signal only after unified publication commits",
);
assert(
  ensureSource.includes('status: "live_rankings_refresh_required"')
    && !ensureSource.includes('tools/update-jcc-live-rankings.mjs'),
  "freshness inspection must not create an unmaintained candidate or pretend that a source-only refresh activated production data",
);
assert(
  source.includes('source_role: "national_master_plus_strength_anchor"')
    && source.includes("metrics_authority: true"),
  "rank signals must expose only the national Master+ strength anchor as statistical authority",
);
assert(
  source.includes("fetchAndPublishRankingRecipeCandidate")
    && source.includes('"ranking_strength_unavailable_recipes_cached"'),
  "popular recipes must cache independently when the Master+ strength overlay is unavailable",
);
assert(
  !source.includes('"/go/jgame/get_lineup_recomm"')
    && !source.includes('"/go/jgame/get_lineup_detail"'),
  "ranking refresh must not fetch player/smart-lineup endpoints",
);
assert(
  source.includes('"/go/jgame/get_hero_equip_ranking"')
    && source.includes("HERO_EQUIP_FETCH_CONCURRENCY")
    && source.includes("hero_equip_rankings"),
  "ranking refresh must prefetch bounded per-hero equipment packages before promotion",
);
assert(
  source.includes('row?.[`node1_${prefix}`]')
    && !source.includes('for (const node of ["node1", "node2", "node3", "node4", "node5"])'),
  "current-day ranking metrics must use node1 only; older trend nodes must never backfill the current day",
);
assert(
  source.includes("--defer-activation")
    && source.includes("prepared_for_semantic_maintenance")
    && source.includes("expected_active_generation_id"),
  "Runtime ranking refresh must prepare a complete immutable generation before semantic maintenance without activating it",
);
assert(
  finalizeSource.includes('jcc_live_rankings_recipe_store.mjs')
    && finalizeSource.includes("readPreparedRecipeCandidate")
    && finalizeSource.includes("jcc_live_rankings_active_closure.mjs")
    && finalizeSource.includes("resolveRankingRefreshBaselineClosureSync")
    && finalizeSource.includes("completeCoreRankingPublicationTransaction")
    && !finalizeSource.includes("synchronizeAdditionalMirrors")
    && publicationClosureSource.includes("synchronizeRankingClosureCompatibilityMirrors")
    && publicationClosureSource.includes("synchronizeCurrentRankingMirror")
    && publicationClosureSource.includes('mirror: "current-directory"')
    && finalizeSource.includes('publicationStatus === "committed"')
    && finalizeSource.includes("repair_required")
    && finalizeSource.includes("active_recipe_generation")
    && finalizeSource.includes("buildRankingRecipeFreshnessProfile")
    && finalizeSource.includes("active_closure")
    && !finalizeSource.includes("restoreRecipePointer")
    && !finalizeSource.includes("previousRecipePointerText"),
  "semantic maintenance finalization must validate freshness and activate one paired Ranking/recipe closure before legacy mirrors",
);
assert(
  source.includes("hero_equip_ranking_stat_date_mismatch")
    && source.includes("hero_equip_ranking_below_minimum")
    && source.includes("heroEquipDateMissingCount"),
  "hero equipment evidence must be audited for coverage and stat-date identity",
);
assert(
  source.includes("equip_stat_date_missing")
    && source.includes("equip_date_differs_from_snapshot")
    && source.includes("winning_recipe_stat_date_missing")
    && source.includes("lineup_date_differs_from_snapshot"),
  "equipment and winning-lineup observations must preserve independent dates and surface source lag without changing strength authority",
);
assert(
  source.includes("rejected the Tencent/JCC adapter request")
    && source.includes("request version, Master+ tier, battle type, and request body"),
  "Tencent business rejections must diagnose an adapter contract mismatch instead of publishing empty data",
);
assert.equal(matchingCatalogAudit.sections.ranked_items.status, undefined);
assert(matchingCatalogAudit.sections.ranked_items.match_ratio >= 0.8, "current ranking item ids must match the selected Core catalog");

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-live-rankings-sync-contract-v1",
  verified: [
    "latest_stat_date_requires_trait_and_hero_data",
    "all_ranking_date_probes_use_master_plus_only",
    "empty_hero_payload_skips_candidate_date",
    "hero_probe_count_recorded",
    "date_probe_and_fetch_response_fingerprints_bound",
    "adjacent_date_probe_proves_stat_date_parameter_is_effective",
    "stale_winning_recipes_excluded_before_combined_publication",
    "candidate_promoted_only_after_audit",
    "candidate_fully_verified_before_promotion",
    "legacy_cache_triggers_candidate_rebuild",
    "ranking_target_resolved_from_core_profile",
    "candidate_generation_does_not_replace_active_pointer",
    "candidate_generation_is_not_mislabeled_as_active",
    "active_closure_commits_before_compatibility_mirrors",
    "candidate_identity_never_inherits_active_season_fields",
    "ranking_set_id_comes_from_selected_core_profile",
    "coverage_thresholds_derive_from_selected_version_catalogs",
    "foreign_major_season_payload_fails_catalog_compatibility",
    "last_known_good_current_preserved_on_failure",
    "typed_lineup_strategy_index_compiled_before_promotion",
    "compact_history_archived_after_promotion",
    "post_promotion_history_failure_is_degraded_not_false_refresh_failure",
    "national_master_plus_is_the_only_lineup_metrics_authority",
    "popular_recipes_cache_independently_without_strength_publication",
    "player_and_smart_lineup_endpoints_are_excluded",
    "hero_equipment_packages_prefetched_with_bounded_concurrency",
    "current_stat_date_uses_node1_without_historical_backfill",
    "semantic_maintenance_preparation_defers_activation",
    "hero_equipment_coverage_and_date_audited",
    "missing_or_mismatched_equipment_and_lineup_dates_fail_closed",
    "tencent_business_rejection_reports_adapter_contract_mismatch",
    "ranked_and_lineup_item_ids_match_current_core_catalog",
  ],
}, null, 2)}\n`);
