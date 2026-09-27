import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { validateGameKnowledgeRuntimeIdentity } from "./jcc_game_knowledge_profile_store.mjs";
import { resolveLiveRankingGenerationPathSync } from "./jcc_live_rankings_generation_store.mjs";
import { readRankingRecipeGenerationSync } from "./jcc_live_rankings_recipe_store.mjs";
import { buildRankingRecipeFreshnessProfile } from "./jcc_ranking_recipe_freshness.mjs";
import {
  collectRuntimeChoiceModeContracts,
  loadActiveRulesBundle,
  resolveRuntimeModeAlias,
} from "./jcc_active_rules_contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const runtimePaths = createRuntimePaths(repoRoot);
const DEFAULT_OUT_DIR = path.join(runtimePaths.runtimeEvidenceDir, "host-agent-context", "current");
const SESSION_CONTRACT = "data/runtime/jcc/runtime-session-contract.json";
const MODE_CONTRACT = "data/runtime/jcc/runtime-ui-mode-contract.json";
const VISUAL_CONTRACT = "data/runtime/jcc/visual-live-state-contract.json";
const OUTPUT_LOOP_CONTRACT = "data/runtime/jcc/cruise-agent-output-loop-contract.json";
const USER_SETTINGS_CONTRACT = "data/runtime/jcc/runtime-user-settings-and-review-contract.json";
const WORKER_ORCHESTRATOR_CONTRACT = "data/runtime/jcc/runtime-worker-orchestrator-contract.json";
const SEASON_MODULE_CONTRACT = "data/runtime/jcc/runtime-season-module-contract.json";
const SESSION_RETENTION_CONTRACT = "data/runtime/jcc/match-session-retention-budget-contract.json";
const STRATEGY_WIKI_CONTRACT = "data/runtime/jcc/runtime-strategy-wiki-contract.json";
const COACH_SIGNATURE_CONTRACT = "data/runtime/jcc/host-coach-signature-contract.json";
const STRATEGY_TABLES_TOOL = "tools/build-jcc-strategy-tables.mjs";
const COMBAT_CAP_ESTIMATOR_TOOL = "tools/build-jcc-combat-cap-estimator-context.mjs";
const LEVELING_ECONOMY_TOOL = "tools/build-jcc-leveling-economy-context.mjs";
const CRUISE_PIPELINE_TOOL = "tools/run-jcc-cruise-runtime-pipeline.mjs";
const AGENTS_PATH = "AGENTS.md";
const SKILL_PATH = ".codex/skills/jcc-runtime-agent/SKILL.md";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseSnapshotOption(value) {
  if (!value) return null;
  if (typeof value === "object") return structuredClone(value);
  try {
    return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid --season-snapshot-base64url: ${error.message || String(error)}`);
  }
}

function readValidatedSnapshotArtifact({
  repoRoot: root,
  knowledgeRoot,
  generatedRoot,
  pointer,
  artifactPath,
  pathField,
  hashField,
  sizeField,
  label,
}) {
  const pointerPath = String(pointer?.[pathField] || "").trim();
  const expectedHash = String(pointer?.[hashField] || "").trim();
  const expectedBytes = Number(pointer?.[sizeField]);
  if (!pointerPath || !/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new Error(`${label} pointer metadata is incomplete`);
  }
  const pointerFile = path.resolve(knowledgeRoot, pointerPath);
  const snapshotFile = path.resolve(root, String(artifactPath || pointerFile));
  if (pointerFile !== snapshotFile) throw new Error(`${label} snapshot path does not match Core Profile pointer`);
  if (!contained(generatedRoot, snapshotFile)) throw new Error(`${label} path escapes immutable generated root`);
  const generationRoot = path.join(generatedRoot, String(pointer.core_profile_id || ""));
  if (path.dirname(snapshotFile) !== generationRoot) throw new Error(`${label} is not stored under its Core Profile generation`);
  const bytes = readFileSync(snapshotFile, "utf8");
  if (Buffer.byteLength(bytes, "utf8") !== expectedBytes) throw new Error(`${label} byte size mismatch`);
  if (sha256(bytes) !== expectedHash) throw new Error(`${label} hash mismatch`);
  return { file: snapshotFile, bytes, value: JSON.parse(bytes.replace(/^\uFEFF/, "")) };
}

function sameIdentity(left, right) {
  return isDeepStrictEqual(left || null, right || null);
}

function validateHardDataManifest(root, runtimeIdentity) {
  const manifestFile = path.resolve(root, runtimeIdentity.hard_data_manifest);
  if (!contained(root, manifestFile)) throw new Error("Match Core Profile hard-data manifest escapes repository root");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8").replace(/^\uFEFF/, ""));
  const hasSeparatedSourceIdentity = Boolean(manifest?.source_package_id && manifest?.upstream_provenance);
  const upstream = hasSeparatedSourceIdentity ? manifest.upstream_provenance : manifest;
  const expectedManifest = {
    packageId: hasSeparatedSourceIdentity ? runtimeIdentity.package_id : runtimeIdentity.source_package_id,
    ...(hasSeparatedSourceIdentity ? { source_package_id: runtimeIdentity.source_package_id } : {}),
    runtime_patch_id: runtimeIdentity.patch_id,
  };
  for (const [field, value] of Object.entries(expectedManifest)) {
    if (String(manifest?.[field] || "") !== String(value)) {
      throw new Error(`Match Core Profile hard-data manifest ${field} mismatch`);
    }
  }
  const expectedUpstream = {
    mode: runtimeIdentity.upstream_identity.mode,
    season: runtimeIdentity.upstream_identity.season,
    version: runtimeIdentity.upstream_identity.version,
    framework_name: runtimeIdentity.upstream_identity.framework_name,
  };
  const actualUpstream = {
    mode: upstream?.mode,
    season: upstream?.season || upstream?.season_id,
    version: upstream?.version || upstream?.data_version,
    framework_name: upstream?.framework_name || upstream?.modeName,
  };
  for (const [field, value] of Object.entries(expectedUpstream)) {
    if (String(actualUpstream[field] || "") !== String(value)) {
      throw new Error(`Match Core Profile hard-data upstream ${field} mismatch`);
    }
  }
  return manifestFile;
}

function resolveMatchRankingRuntimePaths({ base, snapshot, coreProfileId, runtimeIdentity, sourceIdentity }) {
  if (snapshot?.knowledge_lifecycle?.ranking_overlay !== "fixed_for_match") {
    throw new Error("Match season snapshot must declare fixed_for_match Ranking Overlay lifecycle");
  }
  const identity = snapshot?.ranking_overlay_identity || {};
  const overlayId = String(snapshot?.ranking_overlay_id || "").trim();
  const liveRankingsRoot = path.resolve(base.liveRankingsRoot);
  const unavailableDir = path.join(liveRankingsRoot, "unavailable", coreProfileId);
  const unavailablePaths = {
    liveRankingsCurrentDir: unavailableDir,
    activeRankingGenerationId: null,
    activeRankingGenerationFingerprint: null,
    activeRankingGenerationStatDate: null,
    activeRankingGenerationPointer: null,
    liveRankingsManifestFile: path.join(unavailableDir, "manifest.json"),
    liveRankingsAuditFile: path.join(unavailableDir, "audit.json"),
    liveRankingsRankSignalFile: path.join(unavailableDir, "rank-signal.json"),
    liveRankingsStrategyIndexFile: path.join(unavailableDir, "lineup-strategy-index.json"),
    liveRankingsLatestDiffFile: path.join(unavailableDir, "latest-diff.json"),
    activeRankingClosure: {
      availability: "unavailable",
      closure_status: "fixed_for_match_unavailable",
      reason: "match_snapshot_ranking_and_recipe_unavailable",
      core_profile_id: coreProfileId,
      season_id: runtimeIdentity.season_id,
      patch_id: runtimeIdentity.patch_id,
      stat_date: null,
      ranking_generation_id: null,
      recipe_generation_id: null,
      legacy_fallback: false,
    },
  };
  if (identity.availability === "unavailable") {
    if (overlayId || identity.ranking_overlay_id) throw new Error("Unavailable Match Ranking Overlay must not carry a generation id");
    if (snapshot?.recipe_catalog_identity?.availability !== "unavailable"
      || snapshot?.recipe_catalog_generation_id
      || snapshot?.recipe_catalog_identity?.generation_id) {
      throw new Error("Unavailable Match Ranking Overlay requires an unavailable recipe catalog in the same snapshot");
    }
    if (
      identity.core_profile_id !== coreProfileId
      || identity.season_id !== runtimeIdentity.season_id
      || identity.patch_id !== runtimeIdentity.patch_id
    ) throw new Error("Unavailable Match Ranking Overlay identity does not match the pinned Core Profile");
    return unavailablePaths;
  }
  if (identity.availability !== "available" || !/^\d{8}-[a-f0-9]{24}$/.test(overlayId) || identity.ranking_overlay_id !== overlayId) {
    throw new Error("Available Match Ranking Overlay identity is incomplete");
  }
  const resolved = resolveLiveRankingGenerationPathSync({ rootDir: liveRankingsRoot, generationId: overlayId });
  if (!resolved) throw new Error(`Match Ranking Overlay generation is missing: ${overlayId}`);
  const metadata = resolved.metadata || {};
  const expectedCatalogFingerprint = String(sourceIdentity?.catalog_source_fingerprint || "");
  const expectedManifestFingerprint = String(sourceIdentity?.hard_data_manifest_fingerprint || "");
  if (
    metadata.core_profile_id !== coreProfileId
    || metadata.season_id !== runtimeIdentity.season_id
    || metadata.patch_id !== runtimeIdentity.patch_id
    || metadata.catalog_fingerprint !== expectedCatalogFingerprint
    || metadata.hard_data_manifest_fingerprint !== expectedManifestFingerprint
    || identity.core_profile_id !== coreProfileId
    || identity.season_id !== runtimeIdentity.season_id
    || identity.patch_id !== runtimeIdentity.patch_id
    || identity.catalog_fingerprint !== expectedCatalogFingerprint
    || identity.ranking_overlay_fingerprint !== metadata.content_sha256
    || identity.ranking_stat_date !== metadata.stat_date
  ) throw new Error("Match Ranking Overlay binding does not match the pinned Core Profile");
  const pointer = Object.freeze({
    schema: "jcc-live-ranking-active-generation-v1",
    generation_id: overlayId,
    stat_date: metadata.stat_date,
    content_sha256: metadata.content_sha256,
    core_profile_id: metadata.core_profile_id,
    season_id: metadata.season_id,
    patch_id: metadata.patch_id,
    catalog_fingerprint: metadata.catalog_fingerprint,
    hard_data_manifest_fingerprint: metadata.hard_data_manifest_fingerprint,
    binding: Object.freeze({
      core_profile_id: metadata.core_profile_id,
      season_id: metadata.season_id,
      patch_id: metadata.patch_id,
      catalog_fingerprint: metadata.catalog_fingerprint,
      hard_data_manifest_fingerprint: metadata.hard_data_manifest_fingerprint,
    }),
  });
  const recipeIdentity = snapshot?.recipe_catalog_identity || {};
  const recipeGenerationId = String(snapshot?.recipe_catalog_generation_id || "").trim();
  if (
    recipeIdentity.availability !== "available"
    || !/^[a-f0-9]{64}$/u.test(recipeGenerationId)
    || recipeIdentity.generation_id !== recipeGenerationId
    || recipeIdentity.core_profile_id !== coreProfileId
    || recipeIdentity.season_id !== runtimeIdentity.season_id
    || recipeIdentity.patch_id !== runtimeIdentity.patch_id
    || recipeIdentity.closure_ranking_generation_id !== overlayId
    || recipeIdentity.stat_date !== metadata.stat_date
  ) throw new Error("Match recipe catalog does not belong to the pinned Ranking publication closure");
  const recipe = readRankingRecipeGenerationSync({
    rootDir: liveRankingsRoot,
    generationId: recipeGenerationId,
    expectedIdentity: {
      core_profile_id: coreProfileId,
      season_id: runtimeIdentity.season_id,
      patch_id: runtimeIdentity.patch_id,
    },
  });
  const recipeFreshness = buildRankingRecipeFreshnessProfile({
    rankingStatDate: metadata.stat_date,
    sourceCapabilities: recipe.document?.capability?.source_capabilities || {},
    identityCompatible: true,
  });
  if (recipeFreshness.status === "unavailable") {
    throw new Error("Match recipe catalog has no usable source for the pinned Ranking generation");
  }
  if (Number(recipeIdentity.accepted_recipe_count) !== (recipe.document?.recipes || []).length) {
    throw new Error("Match recipe catalog count does not match the pinned recipe generation");
  }
  return {
    liveRankingsCurrentDir: resolved.generation_dir,
    activeRankingGenerationId: overlayId,
    activeRankingGenerationFingerprint: metadata.content_sha256,
    activeRankingGenerationStatDate: metadata.stat_date,
    activeRankingGenerationPointer: pointer,
    liveRankingsManifestFile: path.join(resolved.generation_dir, "manifest.json"),
    liveRankingsAuditFile: path.join(resolved.generation_dir, "audit.json"),
    liveRankingsRankSignalFile: path.join(resolved.generation_dir, "rank-signal.json"),
    liveRankingsStrategyIndexFile: path.join(resolved.generation_dir, "lineup-strategy-index.json"),
    liveRankingsLatestDiffFile: path.join(resolved.generation_dir, "latest-diff.json"),
    activeRankingClosure: {
      availability: "available",
      closure_status: "fixed_for_match",
      reason: null,
      recipe_freshness: recipeFreshness,
      core_profile_id: coreProfileId,
      season_id: runtimeIdentity.season_id,
      patch_id: runtimeIdentity.patch_id,
      stat_date: metadata.stat_date,
      ranking_generation_id: overlayId,
      recipe_generation_id: recipeGenerationId,
      legacy_fallback: false,
    },
  };
}

export function resolveMatchCoreProfileRuntimePaths({
  repoRoot: requestedRepoRoot = repoRoot,
  baseRuntimePaths = null,
  seasonVersionSnapshot,
  expectedCoreProfileId,
} = {}) {
  const root = path.resolve(requestedRepoRoot);
  const snapshot = parseSnapshotOption(seasonVersionSnapshot);
  const coreProfileId = String(expectedCoreProfileId || snapshot?.core_profile_id || "").trim();
  const pointer = snapshot?.core_profile_ref;
  if (snapshot?.schema !== "jcc-match-season-version-snapshot-v1") throw new Error("Match season version snapshot is missing or invalid");
  if (!/^[a-f0-9]{64}$/.test(coreProfileId)) throw new Error("Match Core Profile id is missing or invalid");
  if (snapshot.core_profile_id !== coreProfileId || pointer?.core_profile_id !== coreProfileId) {
    throw new Error("Match season snapshot Core Profile identity mismatch");
  }
  if (snapshot.knowledge_lifecycle?.core_profile !== "fixed_for_match") {
    throw new Error("Match season snapshot must declare fixed_for_match Core Profile lifecycle");
  }
  const base = baseRuntimePaths || createRuntimePaths(root);
  const knowledgeRoot = path.resolve(base.gameKnowledgeRoot || path.join(root, "data", "game-knowledge", "jcc"));
  const generatedRoot = path.join(knowledgeRoot, "generated");
  const artifacts = snapshot.core_profile_artifacts || {};
  const bundle = readValidatedSnapshotArtifact({
    repoRoot: root, knowledgeRoot, generatedRoot, pointer,
    artifactPath: artifacts.bundle, pathField: "bundle_path", hashField: "bundle_sha256",
    sizeField: "bundle_byte_size", label: "Match Core Profile bundle",
  });
  const decisionCatalog = readValidatedSnapshotArtifact({
    repoRoot: root, knowledgeRoot, generatedRoot, pointer,
    artifactPath: artifacts.decision_input_catalog, pathField: "decision_input_catalog_path",
    hashField: "decision_input_catalog_sha256", sizeField: "decision_input_catalog_byte_size",
    label: "Match Core Profile decision-input catalog",
  });
  const stageAuthority = readValidatedSnapshotArtifact({
    repoRoot: root, knowledgeRoot, generatedRoot, pointer,
    artifactPath: artifacts.augment_stage_authority || pointer.augment_stage_authority_path,
    pathField: "augment_stage_authority_path", hashField: "augment_stage_authority_sha256",
    sizeField: "augment_stage_authority_byte_size", label: "Match Core Profile augment-stage authority",
  });
  const catalogOverlay = readValidatedSnapshotArtifact({
    repoRoot: root, knowledgeRoot, generatedRoot, pointer,
    artifactPath: artifacts.runtime_catalog_overlay, pathField: "runtime_catalog_overlay_path",
    hashField: "runtime_catalog_overlay_sha256", sizeField: "runtime_catalog_overlay_byte_size",
    label: "Match Core Profile runtime catalog overlay",
  });
  const hasSemanticFeatureArtifact = Boolean(
    pointer.semantic_feature_index_path
    && pointer.semantic_feature_index_sha256
    && pointer.semantic_feature_index_byte_size,
  );
  const semanticFeatureIndex = hasSemanticFeatureArtifact
    ? readValidatedSnapshotArtifact({
        repoRoot: root, knowledgeRoot, generatedRoot, pointer,
        artifactPath: artifacts.semantic_feature_index || pointer.semantic_feature_index_path,
        pathField: "semantic_feature_index_path", hashField: "semantic_feature_index_sha256",
        sizeField: "semantic_feature_index_byte_size", label: "Match Core Profile semantic feature index",
      })
    : null;
  if (bundle.value?.schema !== "jcc-game-knowledge-bundle-v1" || bundle.value.combined_fingerprint !== coreProfileId) {
    throw new Error("Match Core Profile bundle identity mismatch");
  }
  if (!hasSemanticFeatureArtifact && bundle.value?.semantic_feature_index) {
    throw new Error("Match Core Profile semantic feature artifact pointer is missing");
  }
  const runtimeIdentity = validateGameKnowledgeRuntimeIdentity(pointer.runtime_identity || bundle.value.runtime_identity, {
    label: "Match Core Profile runtime identity",
  });
  if (!sameIdentity(runtimeIdentity, validateGameKnowledgeRuntimeIdentity(bundle.value.runtime_identity, {
    label: "Match Core Profile bundle runtime identity",
  }))) throw new Error("Match Core Profile pointer and bundle runtime identity mismatch");
  if (runtimeIdentity.season_id !== pointer.season_id || runtimeIdentity.patch_id !== pointer.patch_id) {
    throw new Error("Match Core Profile runtime identity does not match pointer season or patch");
  }
  if (String(artifacts.hard_data_manifest || runtimeIdentity.hard_data_manifest) !== runtimeIdentity.hard_data_manifest) {
    throw new Error("Match Core Profile hard-data manifest path mismatch");
  }
  validateHardDataManifest(root, runtimeIdentity);
  const sourceIdentity = decisionCatalog.value?.source_identity;
  if (
    decisionCatalog.value?.schema !== "jcc-decision-input-catalog-v1"
    || sourceIdentity?.core_profile_id !== coreProfileId
    || sourceIdentity?.season_id !== runtimeIdentity.season_id
    || sourceIdentity?.active_patch_id !== runtimeIdentity.patch_id
    || !sameIdentity(stageAuthority.value?.source_identity, sourceIdentity)
    || !sameIdentity(catalogOverlay.value?.source_identity, sourceIdentity)
    || (semanticFeatureIndex && semanticFeatureIndex.value?.schema !== "jcc-semantic-feature-index-v1")
    || (semanticFeatureIndex && semanticFeatureIndex.value?.identity?.core_profile_id !== coreProfileId)
    || (semanticFeatureIndex && semanticFeatureIndex.value?.identity?.season_id !== runtimeIdentity.season_id)
    || (semanticFeatureIndex && semanticFeatureIndex.value?.identity?.patch_id !== runtimeIdentity.patch_id)
    || (snapshot.core_source_identity && !sameIdentity(snapshot.core_source_identity, sourceIdentity))
  ) throw new Error("Match Core Profile compiled artifact source identity mismatch");
  const seasonPatchDir = path.dirname(path.resolve(root, runtimeIdentity.hard_data_manifest));
  const seasonKnowledgeDir = path.join(root, "data", "game-knowledge", "jcc", "seasons", runtimeIdentity.season_id);
  const activePatchRulesDir = path.join(seasonKnowledgeDir, "patches", runtimeIdentity.patch_id);
  const promotionTuple = {
    season_id: runtimeIdentity.season_id,
    active_patch_id: runtimeIdentity.patch_id,
    game_mode_id: runtimeIdentity.game_mode_id,
    package_id: runtimeIdentity.package_id,
    source_package_id: runtimeIdentity.source_package_id,
    hard_data_manifest: runtimeIdentity.hard_data_manifest,
    core_profile_id: coreProfileId,
    upstream_identity: runtimeIdentity.upstream_identity,
  };
  if (snapshot.promotion_tuple && !sameIdentity(snapshot.promotion_tuple, promotionTuple)) {
    throw new Error("Match Core Profile promotion tuple mismatch");
  }
  const rankingPaths = resolveMatchRankingRuntimePaths({
    base,
    snapshot,
    coreProfileId,
    runtimeIdentity,
    sourceIdentity,
  });
  return {
    ...base,
    ...rankingPaths,
    mumuCatalogOverlayFile: catalogOverlay.file,
    activeHardDataManifest: runtimeIdentity.hard_data_manifest,
    activeCoreProfileBundleFile: bundle.file,
    activeDecisionInputCatalogFile: decisionCatalog.file,
    activeDecisionInputCatalogSourceIdentity: sourceIdentity,
    activeDecisionInputAugmentStageAuthorityFile: stageAuthority.file,
    activeRuntimeCatalogOverlayFile: catalogOverlay.file,
    activeSemanticFeatureIndexFile: semanticFeatureIndex?.file || null,
    activeCoreProfileId: coreProfileId,
    activeCoreProfile: Object.freeze(structuredClone(pointer)),
    activeCoreKnowledgeBundle: Object.freeze(bundle.value),
    activeRuntimeIdentity: runtimeIdentity,
    activeRuntimeIdentityAuthority: "match_season_version_snapshot",
    activePromotionTuple: promotionTuple,
    activeSeasonId: runtimeIdentity.season_id,
    activePatchId: runtimeIdentity.patch_id,
    activeGameModeId: runtimeIdentity.game_mode_id,
    activePackageId: runtimeIdentity.package_id,
    activeSourcePackageId: runtimeIdentity.source_package_id,
    upstreamVersionIdentity: runtimeIdentity.upstream_identity,
    seasonPatchStrategyFile: path.join(activePatchRulesDir, "strategy-overrides.json"),
    seasonPatchRuleOverridesFile: path.join(activePatchRulesDir, "rule-overrides.json"),
    seasonDataDir: path.join(seasonPatchDir, "normalized"),
    perMatchVariablesFile: path.join(seasonPatchDir, "normalized", "per_match_variables.json"),
  };
}

const INVARIANT_MODE_SUMMARIES = {
  daily_chat: {
    purpose: "Daily strategy chat outside an active match.",
    allowed_sources: ["user_memory", "recent_20_match_summaries", "hard_data", "daily_big_data"],
    allowed_writes: ["user_memory_suggestions"],
    must_not_write: ["current_match.live_state"],
    response_expectation: "Treat this as the lobby: discuss current version/meta and general strategy directly; ask before saving durable memory.",
  },
  postgame_review: {
    purpose: "Review recent structured match summaries outside an active match.",
    allowed_sources: ["recent_20_match_summaries", "user_memory", "hard_data", "daily_big_data"],
    allowed_writes: ["postgame_review_notes", "user_memory_suggestions"],
    must_not_write: ["current_match.live_state"],
    response_expectation: "Treat this as the lobby reviewing a finished match; summarize decisions and suggest one or two improvements without presenting history as current state.",
  },
  user_preferences: {
    purpose: "Edit long-term user settings and approved preferences.",
    allowed_sources: ["runtime_user_settings", "user_memory"],
    allowed_writes: ["runtime_settings", "user_approved_strategy_memory"],
    must_not_write: ["current_match.live_state"],
    response_expectation: "Confirm durable preference changes and surface conflicts.",
  },
  strategy_wiki: {
    purpose: "Add or inspect user strategy lines.",
    allowed_sources: ["user_strategy_memory", "hard_data", "daily_big_data"],
    allowed_writes: ["user_approved_strategy_memory", "wiki_curation_request"],
    must_not_write: ["current_match.live_state"],
    response_expectation: "Clean and restate strategy proposals, write only after explicit user confirmation, report conflicts, and use one-click wiki curation for broader knowledge updates.",
  },
  cruise: {
    purpose: "Default active match coaching mode.",
    allowed_sources: ["live_state", "self_state_roi_ocr_phase_economy", "gated_own_board_items_traits_after_4354_shop_anchor", "hard_data", "daily_big_data", "user_memory"],
    allowed_writes: ["advice_task", "response_request"],
    must_not_write: ["previous_match_facts_into_live_state", "current_view_units_as_own_board_without_4354_shop_anchor"],
    response_expectation: "Speak only when advice value is high; keep output short and actionable.",
  },
  lineup_card: {
    purpose: "Generate or update the pinned lineup card for target comp, transition board, or carry-specific lineup requests.",
    allowed_sources: ["live_state", "gated_own_board_items_traits_after_4354_shop_anchor", "season_catalog", "hard_data", "daily_big_data", "match_variables", "user_intent"],
    allowed_writes: ["lineup_display_slots.lineup", "lineup_handoff"],
    must_not_write: ["current_match.live_state"],
    response_expectation: "Return player-visible advice plus the minimal lineup_handoff identity and semantic adjustments. Runtime materializes the canonical card and Renderer owns layout.",
  },
  refresh_self_state: {
    purpose: "Force refresh own status.",
    allowed_sources: ["self_state_roi_ocr_phase_economy", "mumu_4354_shop_self_anchor", "mumu_4353_current_view_after_shop_anchor", "left_item_rail_icon_matcher", "host_visual_economy_items_augments"],
    allowed_writes: ["economy", "items", "augments_candidates", "board_candidates_after_shop_anchor"],
    must_not_write: ["low_confidence_visual_as_verified", "current_view_units_as_own_board_without_4354_shop_anchor"],
    response_expectation: "Report concise refreshed facts and missing/low-confidence fields.",
  },
  manual_match_variables: {
    purpose: "Set current-match variables declared by the active major-season rules and the user's target direction.",
    allowed_sources: ["user_confirmed_inputs", "catalog_candidates"],
    allowed_writes: ["manual_match_variables"],
    must_not_write: ["inferred_variables_without_confirmation"],
    response_expectation: "Normalize user selections and ask only for missing critical variables.",
  },
};

function buildModeSummaries(rulesBundle) {
  const summaries = { ...INVARIANT_MODE_SUMMARIES };
  for (const contract of collectRuntimeChoiceModeContracts(rulesBundle)) {
    summaries[contract.mode] = {
      ...contract.host_mode_context,
      choice_contract: {
        mode: contract.mode,
        kind: contract.kind,
        phase: contract.phase,
        label: contract.label,
        source_layer: contract.source_layer || "base_game_rules",
        candidate_paths: contract.candidate_paths,
        host_context_choice_field: contract.host_context_choice_field || null,
      },
    };
  }
  for (const alias of Object.keys(rulesBundle?.season_special_rules?.host_mode_aliases || {})) {
    const canonicalMode = resolveRuntimeModeAlias(alias, rulesBundle);
    if (summaries[canonicalMode]) summaries[alias] = { ...summaries[canonicalMode], alias_of: canonicalMode };
  }
  return Object.fromEntries(Object.entries(summaries).map(([modeId, summary]) => [modeId, {
    mode_id: modeId,
    required_inputs: summary.choice_contract?.candidate_paths || [],
    source_layer: summary.choice_contract
      ? summary.choice_contract.source_layer
      : "runtime_invariant",
    rules_source_fingerprint: rulesBundle?.source_fingerprint || null,
    ...summary,
  }]));
}

const DAILY_MODE_IDS = new Set(["daily_chat", "postgame_review", "user_preferences", "strategy_wiki"]);

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-host-agent-context-pack.mjs --scope startup|match|mode [--mode <mode_id>] [--match-session-id <id>] [--season-snapshot-base64url <value>] [--expected-core-profile-id <sha256>] [--out-dir <dir>]",
    "",
    "Builds compact context packs for the host CLI model. Does not start MuMu discovery or watcher.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { outDir: DEFAULT_OUT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--scope") options.scope = argv[++index];
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else if (arg === "--season-snapshot-base64url") options.seasonVersionSnapshot = argv[++index];
    else if (arg === "--expected-core-profile-id") options.expectedCoreProfileId = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(path.resolve(file), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function fileStatus(file) {
  const resolved = path.resolve(file);
  try {
    const raw = await readFile(resolved, "utf8");
    return { path: file, exists: true, bytes: Buffer.byteLength(raw, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") return { path: file, exists: false };
    throw error;
  }
}

function summarizeRankManifest(manifest, signal) {
  return {
    manifest_status: manifest ? "present" : "missing",
    stat_date: manifest?.stat_date || signal?.stat_date || null,
    current: manifest?.current ?? null,
    signal_status: signal ? "present" : "missing",
  };
}

async function buildStrategyDataSources(_seasonContract, rankManifest, rankSignal, selectedRuntimePaths = runtimePaths) {
  const hardDataManifest = selectedRuntimePaths.activeHardDataManifest;
  return {
    schema: "jcc-strategy-data-sources-v1",
    policy: "Runtime workers consume full hard-data and daily ranking JSON; the host model receives compact computed context and should not re-derive patch truth from memory.",
    hard_data: {
      active_season: selectedRuntimePaths.activeSeasonId || null,
      active_patch_id: selectedRuntimePaths.activePatchId || null,
      package_id: selectedRuntimePaths.activePackageId || null,
      manifest: await fileStatus(hardDataManifest),
    },
    daily_big_data: {
      manifest: await fileStatus(selectedRuntimePaths.liveRankingsManifestFile),
      rank_signal: await fileStatus(selectedRuntimePaths.liveRankingsRankSignalFile),
      stat_date: rankManifest?.stat_date || rankSignal?.stat_date || null,
      battle_type: rankSignal?.battle_type || rankManifest?.battle_type || null,
    },
    catalog_overlay: await fileStatus(selectedRuntimePaths.activeRuntimeCatalogOverlayFile),
    runtime_estimators: [
      STRATEGY_TABLES_TOOL,
      COMBAT_CAP_ESTIMATOR_TOOL,
      LEVELING_ECONOMY_TOOL,
      CRUISE_PIPELINE_TOOL,
    ],
  };
}

function buildMarkdown(pack) {
  const lines = [
    "# JCC Host Agent Context Pack",
    "",
    `- scope: ${pack.scope}`,
    `- generated_at: ${pack.generated_at}`,
    `- root_skill: ${pack.root_skill_path}`,
  ];
  if (pack.match_session_id) lines.push(`- match_session_id: ${pack.match_session_id}`);
  if (pack.mode_id) lines.push(`- mode_id: ${pack.mode_id}`);
  lines.push("", "## Non-Negotiables", ...pack.non_negotiables.map((item) => `- ${item}`));
  if (pack.worker_orchestration) {
    lines.push(
      "",
      "## Worker Orchestration",
      `- visible voice: ${pack.worker_orchestration.visible_voice}`,
      `- final text source: ${pack.worker_orchestration.final_user_text_source}`,
      `- plan tool: ${pack.worker_orchestration.plan_tool}`,
      `- optional specialists: ${pack.worker_orchestration.optional_specialist_agents.policy || "none"}`,
    );
  }
  if (pack.mode_context) {
    lines.push(
      "",
      "## Mode Context",
      `- purpose: ${pack.mode_context.purpose}`,
      `- response: ${pack.mode_context.response_expectation}`,
      `- allowed sources: ${pack.mode_context.allowed_sources.join(", ")}`,
      `- allowed writes: ${pack.mode_context.allowed_writes.join(", ")}`,
      `- must not write: ${pack.mode_context.must_not_write.join(", ")}`,
    );
  }
  if (pack.strategy_data_sources) {
    lines.push(
      "",
      "## Strategy Data Sources",
      `- hard data: ${pack.strategy_data_sources.hard_data.manifest.path} (${pack.strategy_data_sources.hard_data.manifest.exists ? "present" : "missing"})`,
      `- daily big data: ${pack.strategy_data_sources.daily_big_data.rank_signal.path} (${pack.strategy_data_sources.daily_big_data.stat_date || "unknown date"})`,
      `- catalog overlay: ${pack.strategy_data_sources.catalog_overlay.path} (${pack.strategy_data_sources.catalog_overlay.exists ? "present" : "missing"})`,
      `- policy: ${pack.strategy_data_sources.policy}`,
    );
  }
  if (pack.active_rules_bundle) {
    lines.push(
      "",
      "## Active Rules Bundle",
      `- base: ${pack.active_rules_bundle.source_files.base_game_rules}`,
      `- season normal: ${pack.active_rules_bundle.source_files.season_normal_rules}`,
      `- season special: ${pack.active_rules_bundle.source_files.season_special_rules}`,
      `- patch strategy: ${pack.active_rules_bundle.source_files.patch_strategy_overrides || "none"}`,
      `- exceptional patch rule override: ${pack.active_rules_bundle.source_files.patch_rule_overrides || "none"}`,
      `- rules fingerprint: ${pack.active_rules_bundle.source_fingerprint || "unknown"}`,
      `- choice mechanics: ${(pack.active_rules_bundle.coach_rules_brief?.timing?.choice_mechanics || [])
        .map((entry) => `${entry.mechanic_id}=${(entry.stages || []).join(",")}`)
        .join(" | ") || "none"}`,
    );
    if (pack.active_rules_bundle.coach_rules_brief) {
      lines.push(
        `- coach brief schema: ${pack.active_rules_bundle.coach_rules_brief.schema}`,
        `- coach brief must: ${(pack.active_rules_bundle.coach_rules_brief.model_must || []).join(" | ")}`,
      );
    }
  }
  if (pack.coach_signature_contract) {
    lines.push(
      "",
      "## Coach Signature Contract",
      `- schema: ${pack.coach_signature_contract.schema}`,
      `- signatures: ${Object.keys(pack.coach_signature_contract.signatures || {}).join(", ")}`,
      `- metrics: ${Object.keys(pack.coach_signature_contract.metrics || {}).join(", ")}`,
      `- dependency policy: ${pack.coach_signature_contract.dependency_policy?.dspy_runtime_dependency || "unknown"}`,
    );
  }
  lines.push("", "## Tool Hints", ...pack.tool_hints.map((item) => `- ${item}`), "");
  return `${lines.join("\n")}\n`;
}

async function buildPack(options) {
  if (!["startup", "match", "mode"].includes(options.scope)) {
    throw new Error(`--scope must be startup, match, or mode\n${usage()}`);
  }
  if (options.scope === "mode" && !options.mode) throw new Error("--mode is required for mode context");
  const dailyMode = options.scope === "mode" && DAILY_MODE_IDS.has(options.mode);
  const matchScoped = options.scope === "match" || (options.scope === "mode" && !dailyMode);
  const baseRuntimePaths = options.runtimePaths || createRuntimePaths(options.repoRoot || repoRoot);
  if (matchScoped && !options.matchSessionId) {
    const currentSession = await readJsonIfExists(runtimePaths.currentSessionFile);
    options.matchSessionId = currentSession?.match_session_id;
  }
  if (matchScoped && !options.matchSessionId) {
    throw new Error("--match-session-id is required for match/mode context when no current session state exists");
  }
  if (matchScoped && (!options.seasonVersionSnapshot || !options.expectedCoreProfileId)) {
    throw new Error("match/mode context requires --season-snapshot-base64url and --expected-core-profile-id");
  }
  const selectedRuntimePaths = matchScoped
    ? resolveMatchCoreProfileRuntimePaths({
        repoRoot: options.repoRoot || repoRoot,
        baseRuntimePaths,
        seasonVersionSnapshot: options.seasonVersionSnapshot,
        expectedCoreProfileId: options.expectedCoreProfileId,
      })
    : baseRuntimePaths;

  const [sessionContract, modeContract, visualContract, outputLoop, userSettings, workerContract, seasonContract, retentionContract, rankManifest, rankSignal] = await Promise.all([
    readJsonIfExists(SESSION_CONTRACT),
    readJsonIfExists(MODE_CONTRACT),
    readJsonIfExists(VISUAL_CONTRACT),
    readJsonIfExists(OUTPUT_LOOP_CONTRACT),
    readJsonIfExists(USER_SETTINGS_CONTRACT),
    readJsonIfExists(WORKER_ORCHESTRATOR_CONTRACT),
    readJsonIfExists(SEASON_MODULE_CONTRACT),
    readJsonIfExists(SESSION_RETENTION_CONTRACT),
    readJsonIfExists(selectedRuntimePaths.liveRankingsManifestFile),
    readJsonIfExists(selectedRuntimePaths.liveRankingsRankSignalFile),
  ]);
  const strategyWikiContract = await readJsonIfExists(STRATEGY_WIKI_CONTRACT);
  const coachSignatureContract = await readJsonIfExists(COACH_SIGNATURE_CONTRACT);
  const activeRulesBundle = loadActiveRulesBundle({ repoRoot: options.repoRoot || repoRoot, runtimePaths: selectedRuntimePaths });
  if (matchScoped && activeRulesBundle.source_fingerprint !== parseSnapshotOption(options.seasonVersionSnapshot)?.rules_source_fingerprint) {
    throw new Error("Match Core Profile rules fingerprint does not match persisted season snapshot");
  }
  const modeSummaries = buildModeSummaries(activeRulesBundle);

  const readiness = {
    project_agents: (await fileStatus(AGENTS_PATH)).exists ? "present" : "missing",
    session_contract: sessionContract ? "present" : "missing",
    mode_contract: modeContract ? "present" : "missing",
    visual_contract: visualContract ? "present" : "missing",
    output_loop_contract: outputLoop ? "present" : "missing",
    user_settings_contract: userSettings ? "present" : "missing",
    worker_orchestrator_contract: workerContract ? "present" : "missing",
    season_module_contract: seasonContract ? "present" : "missing",
    retention_budget_contract: retentionContract ? "present" : "missing",
    rank_data: summarizeRankManifest(rankManifest, rankSignal),
    catalog: await fileStatus(selectedRuntimePaths.activeRuntimeCatalogOverlayFile),
  };
  const workerOrchestration = workerContract
    ? {
        visible_voice: workerContract.product_shape?.visible_voice || null,
        final_user_text_source: workerContract.product_shape?.final_user_text_source || null,
        plan_tool: "node tools/build-jcc-runtime-worker-plan.mjs --mode <mode_id> --match-session-id <id> --season-snapshot-base64url <snapshot> --expected-core-profile-id <id>",
        policy: workerContract.hot_path_llm_policy || null,
        optional_specialist_agents: {
          policy: workerContract.hot_path_llm_policy?.optional_specialist_agents?.dispatch_policy || null,
          max_parallel: workerContract.hot_path_llm_policy?.optional_specialist_agents?.max_parallel_specialists || null,
          model_policy: workerContract.hot_path_llm_policy?.optional_specialist_agents?.must_default_to_inherit_host_cli_model
            ? "inherit host CLI default unless user overrides"
            : null,
          lanes: Object.fromEntries(Object.entries(workerContract.specialist_agent_lanes || {}).map(([id, lane]) => [id, {
            default_agent_type: lane.default_agent_type,
            allowed_modes: lane.allowed_modes || [],
            latency_class: lane.latency_class,
            trigger_event_ids: lane.trigger_event_ids || [],
            join_policy: lane.join_policy || null,
            deadline_ms: lane.deadline_ms || null,
            fallback_behavior: lane.fallback_behavior || null,
            outputs: lane.outputs || [],
            must_not_write: lane.must_not_write || [],
          }])),
        },
      }
    : null;
  const availableRuntimeTools = [
    "node tools/build-jcc-host-agent-context-pack.mjs --scope startup|match|mode",
    "node tools/start-jcc-new-match-session.mjs",
    "node tools/build-jcc-runtime-worker-plan.mjs --mode <mode_id> --match-session-id <id>",
    "node tools/write-jcc-host-agent-json.mjs --out <file>",
    "node tools/discover-jcc-mumu-adb-target.mjs  # only from Connect/Re-scan MuMu UI action",
  ];

  const pack = {
    schema: "jcc-host-agent-context-pack-v1",
    scope: options.scope,
    generated_at: new Date().toISOString(),
    root_skill_path: SKILL_PATH,
    match_session_id: options.matchSessionId || null,
    core_profile_id: selectedRuntimePaths.activeCoreProfileId || null,
    mode_id: options.mode || null,
    non_negotiables: [
      "The current CLI agent is the host model; final coaching text must be AI-native host-model output.",
      "The runtime contract is host-CLI neutral: Codex is the first adapter, but Claude/Kimi-style adapters must implement the same session/context/response JSON contract.",
      "device_connection may stay alive across Stop Match; Stop Match returns to daily_session.",
      "Start Match creates a new match_session_id and clears only match-scoped state.",
      "The input-box square Stop cancels only the current response_task.",
      "Use Node UTF-8 JSON read/write paths; do not use PowerShell Set-Content for runtime JSON.",
      "Do not auto-discover MuMu on every startup; discovery is a menu/settings action.",
      "Do not copy previous-match concrete state into a new match live_state.",
      "Use deterministic runtime workers for parallel sensing/scoring, but expose only one host CLI coach voice.",
      "Use optional CLI-native specialist subagents only for complex/background analysis packets; final user text still comes from the main host model.",
      "Treat AGENTS.md plus .codex/skills/jcc-runtime-agent/SKILL.md as the project-local host-agent authoring standard; production host calls must receive the distilled rules through selected context, not through provider-local skills.",
      "Keep season data swappable; do not bake retired-season mechanics into runtime-invariant code paths.",
      "Keep match artifacts compact; full live_state/raw frames are debug-only, explicit retention paths.",
    ],
    readiness,
    worker_orchestration: workerOrchestration,
    active_season_module: selectedRuntimePaths.activePromotionTuple || null,
    active_rules_bundle: activeRulesBundle,
    coach_signature_contract: coachSignatureContract,
    strategy_data_sources: await buildStrategyDataSources(seasonContract, rankManifest, rankSignal, selectedRuntimePaths),
    retention_budget: retentionContract?.budgets || null,
    strategy_wiki: strategyWikiContract
      ? {
          schema: strategyWikiContract.schema,
          purpose: strategyWikiContract.purpose,
          categories: strategyWikiContract.categories,
          one_click_flow: strategyWikiContract.one_click_curation_flow,
          host_model_rules: strategyWikiContract.host_model_rules,
          ui_entry: strategyWikiContract.ui_entry,
        }
      : null,
    session_summary: {
      device_connection: sessionContract?.sessions?.device_connection || null,
      daily_session: sessionContract?.sessions?.daily_session || null,
      match_session: sessionContract?.sessions?.match_session || null,
      response_task: sessionContract?.sessions?.response_task || null,
    },
    session_contract_summary: {
      device_connection: sessionContract?.sessions?.device_connection || null,
      daily_session: sessionContract?.sessions?.daily_session || null,
      match_session: sessionContract?.sessions?.match_session || null,
      response_task: sessionContract?.sessions?.response_task || null,
    },
    required_node_json_rule: {
      rule: "Runtime JSON read/write must use Node UTF-8 no-BOM tooling.",
      writer: "tools/write-jcc-host-agent-json.mjs",
      forbidden: ["PowerShell Set-Content for runtime JSON", "ad hoc shell redirects for host response JSON"],
    },
    data_readiness: readiness,
    available_runtime_tools: availableRuntimeTools,
    worker_orchestrator_summary: workerOrchestration,
    daily_session_entry: {
      status: "enter_daily_session_after_startup",
      must_not_write: ["current_match.live_state", "match_session"],
      allowed_uses: ["daily_chat", "postgame_review", "user_preferences", "strategy_wiki"],
    },
    startup_policy: {
      required: [
        "check hard-data/catalog presence",
        "check live rankings status",
        "load user memory entry points",
        "generate startup context pack",
        "enter daily_session",
      ],
      redundant_or_forbidden: [
        "auto-discover MuMu every startup",
        "start watcher before Start Match",
        "create match_session before Start Match",
        "write current-match live_state from daily_session",
      ],
    },
    start_match_policy: {
      command: "node tools/start-jcc-new-match-session.mjs",
      then: [
        "start watcher with match_session_id",
        "generate match context pack",
        "enter cruise mode",
      ],
    },
    mode_context: options.mode ? modeSummaries[options.mode] || null : null,
    available_mode_ids: Object.keys(modeSummaries),
    tool_hints: [
      "AGENTS.md and .codex/skills/jcc-runtime-agent/SKILL.md are the host-agent authoring standard; generated selected context is the runtime delivery surface.",
      "node tools/build-jcc-host-agent-context-pack.mjs --scope startup",
      "node tools/start-jcc-new-match-session.mjs",
      "node tools/build-jcc-host-agent-context-pack.mjs --scope match --match-session-id <id>",
      "node tools/build-jcc-host-agent-context-pack.mjs --scope mode --mode <mode_id> --match-session-id <id>",
      "node tools/build-jcc-runtime-worker-plan.mjs --mode <mode_id> --match-session-id <id>",
      "node tools/build-jcc-wiki-curation-request.mjs  # one-click strategy wiki curation request; host model drafts, runtime validates",
      "Optional specialist subagents inherit the host CLI model and must return structured packets, not final user text.",
      "node tools/write-jcc-host-agent-json.mjs --out <file>",
      "node tools/discover-jcc-mumu-adb-target.mjs  # only from Connect/Re-scan MuMu UI action",
    ],
    source_contracts: {
      agents: AGENTS_PATH,
      root_skill: SKILL_PATH,
      session: SESSION_CONTRACT,
      modes: MODE_CONTRACT,
      visual: VISUAL_CONTRACT,
      output_loop: OUTPUT_LOOP_CONTRACT,
      user_settings: USER_SETTINGS_CONTRACT,
      worker_orchestrator: WORKER_ORCHESTRATOR_CONTRACT,
      season_module: SEASON_MODULE_CONTRACT,
      retention_budget: SESSION_RETENTION_CONTRACT,
      strategy_wiki: STRATEGY_WIKI_CONTRACT,
      coach_signature_contract: COACH_SIGNATURE_CONTRACT,
    },
  };

  if (options.scope === "mode" && !pack.mode_context) throw new Error(`Unknown mode: ${options.mode}`);
  pack.data_readiness = pack.readiness;
  pack.available_runtime_tools = pack.tool_hints;
  pack.worker_orchestrator_summary = pack.worker_orchestration;
  return pack;
}

async function writePack(pack, outDir) {
  const dir = path.resolve(outDir);
  await mkdir(dir, { recursive: true });
  const basename = `${pack.scope}${pack.mode_id ? `-${pack.mode_id}` : ""}-context-pack`;
  const jsonPath = path.join(dir, `${basename}.json`);
  const mdPath = path.join(dir, `${basename}.md`);
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(mdPath, buildMarkdown(pack), "utf8");
  return { jsonPath, mdPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const pack = await buildPack(options);
  const written = await writePack(pack, options.outDir);
  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-host-agent-context-pack-build-result-v1",
    scope: pack.scope,
    mode_id: pack.mode_id,
    match_session_id: pack.match_session_id,
    out: written,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export { INVARIANT_MODE_SUMMARIES, buildModeSummaries, buildPack, buildMarkdown, writePack };
