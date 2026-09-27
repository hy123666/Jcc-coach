import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";

export function createActiveCoreProfileSnapshot(repoRoot, {
  capturedAt = "2026-08-21T00:00:00.000Z",
  runtimePaths = createRuntimePaths(repoRoot),
} = {}) {
  const activeRules = loadActiveRulesBundle({ repoRoot, runtimePaths });
  return {
    schema: "jcc-match-season-version-snapshot-v1",
    captured_at: capturedAt,
    activation_policy: "new_match_only",
    promotion_tuple: structuredClone(runtimePaths.activePromotionTuple),
    rules_source_fingerprint: activeRules.source_fingerprint,
    core_profile_id: runtimePaths.activeCoreProfileId,
    core_profile_ref: structuredClone(runtimePaths.activeCoreProfile),
    core_profile_artifacts: {
      hard_data_manifest: runtimePaths.activeHardDataManifest,
      decision_input_catalog: runtimePaths.activeDecisionInputCatalogFile,
      augment_stage_authority: runtimePaths.activeDecisionInputAugmentStageAuthorityFile,
      runtime_catalog_overlay: runtimePaths.activeRuntimeCatalogOverlayFile,
      semantic_feature_index: runtimePaths.activeSemanticFeatureIndexFile,
      bundle: runtimePaths.activeCoreProfileBundleFile,
    },
    core_source_identity: structuredClone(runtimePaths.activeDecisionInputCatalogSourceIdentity),
    ranking_overlay_id: null,
    ranking_overlay_identity: {
      schema: "jcc-live-ranking-overlay-identity-v1",
      availability: "unavailable",
      ranking_overlay_id: null,
      core_profile_id: runtimePaths.activeCoreProfileId,
      season_id: runtimePaths.activeSeasonId,
      patch_id: runtimePaths.activePatchId,
      catalog_fingerprint: null,
      ranking_overlay_fingerprint: null,
      ranking_stat_date: null,
    },
    recipe_catalog_generation_id: null,
    recipe_catalog_identity: {
      schema: "jcc-live-ranking-recipe-generation-identity-v1",
      availability: "unavailable",
      reason: "test_fixture_has_no_recipe_generation",
      generation_id: null,
      generation_path: null,
      core_profile_id: runtimePaths.activeCoreProfileId,
      season_id: runtimePaths.activeSeasonId,
      patch_id: runtimePaths.activePatchId,
    },
    knowledge_lifecycle: {
      core_profile: "fixed_for_match",
      ranking_overlay: "fixed_for_match",
      recipe_catalog: "fixed_for_match",
    },
  };
}
