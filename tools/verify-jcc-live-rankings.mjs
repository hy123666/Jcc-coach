import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildLiveRankingCoverageMinimums } from "./jcc_live_rankings_coverage_policy.mjs";
import { auditLiveRankingCatalogCompatibility } from "./jcc_live_rankings_catalog_compatibility.mjs";
import { resolveActiveRankingClosureSync } from "./jcc_live_rankings_active_closure.mjs";
import { resolveRankingTarget } from "./jcc_ranking_target.mjs";
import {
  NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA,
  validateNormalizedRankingRecipeStorage,
} from "./jcc_ranking_recipe_storage.mjs";

function argumentValue(argv, name) {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be provided only once`);
  if (!indexes.length) return null;
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

const requestedLiveDir = argumentValue(process.argv.slice(2), "--dir");
const argv = process.argv.slice(2);
const repoRoot = path.resolve(import.meta.dirname, "..");
const rankingsRoot = path.join(repoRoot, "data", "live-rankings", "jcc");
const REFRESH_CONTRACT_PATH = path.resolve("data/live-rankings/jcc/runtime-agent-refresh-contract.json");

const REQUIRED_TIERS = ["0"];
const REQUIRED_HERO_LEVELS = ["1", "2", "3", "255"];
const hasExplicitTarget = ["--profile", "--season", "--patch", "--expected-core-profile-id", "--candidate-manifest"]
  .some((flag) => argv.includes(flag));
const rankingTarget = await resolveRankingTarget({
  repoRoot,
  argv: hasExplicitTarget ? argv : [...argv, "--profile", "active"],
});
const activeClosure = requestedLiveDir ? null : resolveActiveRankingClosureSync({
  rootDir: rankingsRoot,
  expectedIdentity: {
    core_profile_id: rankingTarget.core_profile_id,
    season_id: rankingTarget.season_id,
    patch_id: rankingTarget.patch_id,
    catalog_fingerprint: rankingTarget.catalog_source_fingerprint,
    hard_data_manifest_fingerprint: rankingTarget.hard_data_manifest_fingerprint,
  },
});
if (activeClosure?.closure_status === "invalid") {
  throw new Error(`active Ranking closure is invalid: ${activeClosure.reason || "unknown reason"}`);
}
if (!requestedLiveDir && activeClosure?.availability !== "available") {
  throw new Error(`active Ranking closure is unavailable: ${activeClosure?.reason || "unknown reason"}`);
}
const activeGeneration = requestedLiveDir ? null : activeClosure.ranking;
const LIVE_DIR = path.resolve(requestedLiveDir || activeGeneration?.generation_dir || "data/live-rankings/jcc/current");
const SNAPSHOT_PATH = path.join(LIVE_DIR, "snapshot.json");
const AUDIT_PATH = path.join(LIVE_DIR, "audit.json");
const SIGNAL_PATH = path.join(LIVE_DIR, "rank-signal.json");
const STRATEGY_INDEX_PATH = path.join(LIVE_DIR, "lineup-strategy-index.json");
const DIFF_PATH = path.join(LIVE_DIR, "latest-diff.json");
const MANIFEST_PATH = path.join(LIVE_DIR, "manifest.json");
const ACTIVE_HARD_DATA_MANIFEST_PATH = rankingTarget.hard_data_manifest;
const [coverageTraits, coverageChampions, coverageItems] = await Promise.all([
  readFile(path.join(rankingTarget.hard_data_package_dir, "normalized", "traits.json"), "utf8").then((text) => JSON.parse(text)),
  readFile(path.join(rankingTarget.hard_data_package_dir, "normalized", "champions.json"), "utf8").then((text) => JSON.parse(text)),
  readFile(path.join(rankingTarget.hard_data_package_dir, "normalized", "items.json"), "utf8").then((text) => JSON.parse(text)),
]);
const MINIMUMS = buildLiveRankingCoverageMinimums({
  traits: coverageTraits,
  champions: coverageChampions,
  items: coverageItems,
});

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function fail(failures, reason, extra = {}) {
  failures.push({ reason, ...extra });
}

function countList(value) {
  return Array.isArray(value) ? value.length : 0;
}

function validateSnapshot(snapshot, failures) {
  if (!snapshot || typeof snapshot !== "object") {
    fail(failures, "snapshot_not_object");
    return;
  }
  for (const field of ["schema_version", "captured_at", "stat_date", "source"]) {
    if (!hasValue(snapshot[field])) fail(failures, "snapshot_missing_field", { field });
  }
  if (!/^\d{8}$/.test(String(snapshot.stat_date || ""))) {
    fail(failures, "snapshot_stat_date_not_yyyymmdd", { stat_date: snapshot.stat_date });
  }
  const snapshotTiers = Object.keys(snapshot.tiers || {}).sort();
  if (JSON.stringify(snapshotTiers) !== JSON.stringify(REQUIRED_TIERS)) {
    fail(failures, "snapshot_contains_non_master_plus_tiers", { expected: REQUIRED_TIERS, actual: snapshotTiers });
  }
  for (const tier of REQUIRED_TIERS) {
    const tierData = snapshot.tiers?.[tier];
    if (!tierData) {
      fail(failures, "snapshot_missing_tier", { tier });
      continue;
    }
    const traitCount = countList(tierData.main_trait_strength);
    if (traitCount < MINIMUMS.traitCount) {
      fail(failures, "trait_rank_below_minimum", { tier, traitCount, minimum: MINIMUMS.traitCount });
    }
    const equipCount = countList(tierData.equip_rank?.list);
    if (equipCount < MINIMUMS.equipCount) {
      fail(failures, "equip_rank_below_minimum", { tier, equipCount, minimum: MINIMUMS.equipCount });
    }
    // lineup_group_list is recipe enrichment only. Its absence must not block
    // the independent Master+ strength, hero, or item ranking overlay.
    for (const heroLevel of REQUIRED_HERO_LEVELS) {
      const heroCount = countList(tierData.hero_strength?.[heroLevel]);
      if (heroCount < MINIMUMS.heroCount) {
        fail(failures, "hero_rank_below_minimum", { tier, heroLevel, heroCount, minimum: MINIMUMS.heroCount });
      }
    }
    const detailCount = countList(tierData.trait_details);
    if (detailCount < traitCount) {
      fail(failures, "trait_detail_missing_rank_rows", { tier, traitCount, detailCount });
    }
    const emptyDetails = (tierData.trait_details || []).filter((detail) => countList(detail?.data?.main_buff_data) === 0);
    if (emptyDetails.length) {
      fail(failures, "trait_detail_empty_without_coverage", {
        tier,
        emptyCount: emptyDetails.length,
        examples: emptyDetails.slice(0, 5).map((detail) => detail.key),
      });
    }
  }
}

function validateAudit(audit, failures) {
  if (!audit || typeof audit !== "object") {
    fail(failures, "audit_not_object");
    return;
  }
  if (!["pass", "partial"].includes(audit.status)) {
    fail(failures, "audit_status_not_publishable", { status: audit.status, auditFailures: audit.failures || [] });
  }
  if (audit.status === "partial" && audit.strength_status !== "available") {
    fail(failures, "partial_audit_without_strength_status", { strength_status: audit.strength_status });
  }
  const auditTiers = Object.keys(audit.coverage?.tiers || {}).sort();
  if (JSON.stringify(auditTiers) !== JSON.stringify(REQUIRED_TIERS)) {
    fail(failures, "audit_contains_non_master_plus_tiers", { expected: REQUIRED_TIERS, actual: auditTiers });
  }
  for (const tier of REQUIRED_TIERS) {
    if (!audit.coverage?.tiers?.[tier]) fail(failures, "audit_missing_tier_coverage", { tier });
  }
}

function validateSignal(signal, refreshContract, failures) {
  if (!signal || typeof signal !== "object") {
    fail(failures, "rank_signal_not_object");
    return;
  }
  for (const field of ["battle_type", "lineup_version_id"]) {
    const expected = refreshContract?.source_identity?.[field];
    if (!hasValue(signal[field]) || String(signal[field]) !== String(expected || "")) {
      fail(failures, "rank_signal_source_identity_mismatch", { field, expected, actual: signal[field] });
    }
  }
  const signalTiers = Object.keys(signal.tiers || {}).sort();
  if (JSON.stringify(signalTiers) !== JSON.stringify(REQUIRED_TIERS)) {
    fail(failures, "rank_signal_contains_non_master_plus_tiers", { expected: REQUIRED_TIERS, actual: signalTiers });
  }
  for (const tier of REQUIRED_TIERS) {
    const tierSignal = signal.tiers?.[tier];
    if (!tierSignal) {
      fail(failures, "rank_signal_missing_tier", { tier });
      continue;
    }
    for (const field of ["top_traits", "top_heroes", "top_equips", "hero_item_signal", "top_lineups", "augment_lineup_signal"]) {
      if (!Array.isArray(tierSignal[field]) || tierSignal[field].length === 0) {
        fail(failures, "rank_signal_empty_section", { tier, field });
      }
    }
    const invalidHeroItemSignals = (tierSignal.hero_item_signal || []).filter((entry) => {
      return !entry.hero_id || !Array.isArray(entry.items) || entry.items.length === 0 || entry.interpretation !== "rank_prior_not_perfect_item_combo";
    });
    if (invalidHeroItemSignals.length) {
      fail(failures, "hero_item_signal_invalid_shape", {
        tier,
        examples: invalidHeroItemSignals.slice(0, 3),
      });
    }
    const invalidAugmentSignals = (tierSignal.augment_lineup_signal || []).filter((entry) => {
      return !entry.augment_id
        || entry.interpretation !== "lineup_association_prior_not_independent_augment_winrate"
        || entry.not_independent_winrate !== true
        || !Array.isArray(entry.associated_lineups)
        || entry.associated_lineups.length === 0;
    });
    if (invalidAugmentSignals.length) {
      fail(failures, "augment_lineup_signal_invalid_shape", {
        tier,
        examples: invalidAugmentSignals.slice(0, 3),
      });
    }
  }
}

function validateStrategyIndex(index, snapshot, signal, manifest, hardDataManifest, refreshContract, failures) {
  if (!index || typeof index !== "object") {
    fail(failures, "strategy_index_not_object");
    return;
  }
  if (index.schema !== NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA) {
    fail(failures, "strategy_index_schema_invalid", { schema: index.schema });
  } else {
    try {
      validateNormalizedRankingRecipeStorage(index);
    } catch (error) {
      fail(failures, "strategy_index_recipe_storage_invalid", { error: error.message });
    }
  }
  if (index.stat_date !== snapshot?.stat_date) {
    fail(failures, "strategy_index_stat_date_mismatch", {
      strategy_stat_date: index.stat_date,
      snapshot_stat_date: snapshot?.stat_date,
    });
  }
  const identity = index.source_identity || {};
  const expectedIdentity = {
    runtime_season_id: rankingTarget.season_id,
    active_patch_id: rankingTarget.patch_id,
    game_mode_id: rankingTarget.game_mode_id,
    package_id: rankingTarget.package_id,
    core_profile_id: rankingTarget.core_profile_id,
    hard_data_manifest_fingerprint: rankingTarget.hard_data_manifest_fingerprint,
    catalog_source_fingerprint: rankingTarget.catalog_source_fingerprint,
    patch_package: snapshot?.static_basis?.patch_package,
    patch_version: hardDataManifest?.version,
    upstream_season_id: rankingTarget.upstream_identity?.season || hardDataManifest?.season,
    battle_type: refreshContract?.source_identity?.battle_type,
    lineup_version_id: refreshContract?.source_identity?.lineup_version_id,
  };
  if (identity.ranking_set_id != null || rankingTarget.selection === "candidate") {
    expectedIdentity.ranking_set_id = rankingTarget.ranking_set_id;
  }
  for (const [field, expected] of Object.entries(expectedIdentity)) {
    if (String(identity[field] || "") !== String(expected || "")) {
      fail(failures, "strategy_index_source_identity_mismatch", { field, expected, actual: identity[field] });
    }
  }
  if (manifest?.current?.stat_date !== index.stat_date || signal?.stat_date !== index.stat_date) {
    fail(failures, "promoted_ranking_tuple_stat_date_mismatch", {
      manifest_stat_date: manifest?.current?.stat_date,
      signal_stat_date: signal?.stat_date,
      index_stat_date: index.stat_date,
    });
  }
  const indexTiers = Object.keys(index.tiers || {}).sort();
  if (JSON.stringify(indexTiers) !== JSON.stringify(REQUIRED_TIERS)) {
    fail(failures, "strategy_index_contains_non_master_plus_tiers", { expected: REQUIRED_TIERS, actual: indexTiers });
  }
  for (const tier of REQUIRED_TIERS) {
    const tierIndex = index.tiers?.[tier];
    if (!Array.isArray(tierIndex?.strength_anchors) || tierIndex.strength_anchors.length < MINIMUMS.traitCount) {
      fail(failures, "strategy_index_strength_anchors_below_minimum", {
        tier,
        count: countList(tierIndex?.strength_anchors),
        minimum: MINIMUMS.traitCount,
      });
    }
    for (const reverseKind of ["augment", "champion", "item", "trait"]) {
      if (!tierIndex?.reverse_indexes?.[reverseKind] || typeof tierIndex.reverse_indexes[reverseKind] !== "object") {
        fail(failures, "strategy_index_reverse_index_missing", { tier, reverseKind });
      }
    }
    const invalidStrengthAnchors = (tierIndex?.strength_anchors || []).filter((anchor) => (
      anchor?.quality?.schema !== "jcc-current-day-strength-gradient-v1"
      || !Number.isFinite(Number(anchor?.quality?.current_day_score))
      || anchor?.quality?.provenance?.history_can_change_score !== false
      || anchor?.quality?.provenance?.popularity_can_change_score !== false
      || anchor?.trend_evidence?.may_affect_current_day_score !== false
      || anchor?.trend_evidence?.may_affect_current_day_order !== false
    ));
    if (invalidStrengthAnchors.length) {
      fail(failures, "strategy_index_current_day_strength_gradient_invalid", {
        tier,
        examples: invalidStrengthAnchors.slice(0, 3).map((anchor) => anchor?.anchor_id || null),
      });
    }
    const candidates = index.tiers?.[tier]?.lineup_candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      fail(failures, "strategy_index_lineups_empty", {
        tier,
        count: countList(candidates),
      });
      continue;
    }
    const invalid = candidates.filter((candidate) => !candidate.lineup_group_id
      || !Array.isArray(candidate.variants)
      || !Array.isArray(candidate.core_unit_ids)
      || candidate.core_unit_ids.length === 0
      || !candidate.provenance?.canonical_roster_source
      || !candidate.provenance?.strength_source
      || !["exact", "compatible", "analogous", "unmatched"].includes(candidate.recipe_match?.classification)
      || !candidate.recipe_evidence?.source_interpretation);
    if (invalid.length) {
      fail(failures, "strategy_index_candidate_invalid", {
        tier,
        examples: invalid.slice(0, 3).map((candidate) => ({
          lineup_group_id: candidate.lineup_group_id,
          core_unit_count: countList(candidate.core_unit_ids),
          variant_count: countList(candidate.variants),
          has_provenance: Boolean(candidate.provenance?.canonical_roster_source
            && candidate.provenance?.strength_source),
          recipe_classification: candidate.recipe_match?.classification || null,
          recipe_evidence: candidate.recipe_evidence?.source_interpretation || null,
        })),
      });
    }
    const evidenceInvalid = candidates.filter((candidate) => {
      const rosterChanged = (candidate?.variants || []).some((variant) => {
        const variantRoster = (variant?.lineup_ids || []).map(String);
        const variantCore = (variant?.core_unit_ids || []).map(String);
        return variantRoster.length !== variantCore.length
          || variantCore.some((id) => !variantRoster.includes(id));
      });
      if (rosterChanged) return true;
      return (candidate?.variants || []).some((variant) => {
        const classification = variant?.recipe_evidence?.classification
          || candidate?.recipe_match?.classification
          || "unmatched";
        const evidence = variant?.recipe_evidence || candidate?.recipe_evidence || {};
        if (classification === "exact") {
          const required = ["roles", "items", "augments", "variants", "transitions", "positioning", "playbook", "lineup_code"];
          return evidence.use_as !== "bounded_recipe_enrichment"
            || !required.every((field) => evidence.allowed_fields?.includes(field))
            || evidence.may_replace_roster !== false
            || evidence.may_merge_variants !== false
            || evidence.may_inherit_strength !== false;
        }
        if (classification === "compatible") {
          return evidence.use_as !== "named_variant_difference_only"
            || JSON.stringify(evidence.allowed_fields || []) !== JSON.stringify(["variant_difference", "role_hints", "hero_item_lookup"])
            || (variant?.associated_augments || []).length > 0
            || (variant?.transitions || []).length > 0
            || variant?.positioning_template
            || variant?.playbook
            || variant?.lineup_code
            || evidence.may_replace_roster !== false
            || evidence.may_merge_variants !== false
            || evidence.may_inherit_strength !== false;
        }
        if (classification === "analogous") {
          return evidence.use_as !== "bounded_reference_only"
            || JSON.stringify(evidence.allowed_fields || []) !== JSON.stringify(["role_hints", "hero_item_lookup"])
            || (variant?.associated_augments || []).length > 0
            || (variant?.transitions || []).length > 0
            || variant?.playbook
            || variant?.lineup_code;
        }
        return evidence.use_as !== "unmatched" || (evidence.allowed_fields || []).length > 0;
      });
    });
    if (evidenceInvalid.length) {
      fail(failures, "strategy_index_recipe_evidence_scope_invalid", {
        tier,
        examples: evidenceInvalid.slice(0, 3).map((candidate) => ({
          lineup_group_id: candidate.lineup_group_id,
          classification: candidate.recipe_match?.classification || null,
          evidence: candidate.recipe_evidence || null,
        })),
      });
    }
    const formationInvalid = candidates.filter((candidate) => {
      const profiles = [candidate?.formation_profile, ...(candidate?.variants || []).map((variant) => variant?.formation_profile)];
      return profiles.some((profile) => !profile
        || profile.schema !== "jcc-lineup-formation-profile-v1"
        || profile.authority !== "parallel_to_national_strength_not_a_strength_adjustment"
        || !["low", "medium", "high", "unknown"].includes(profile.burden_band)
        || !Number.isFinite(Number(profile.evidence_coverage))
        || !Array.isArray(profile.unknowns)
         || (profile?.estimated_burden_score !== null && !Number.isFinite(Number(profile.estimated_burden_score))));
    });
    if (formationInvalid.length) {
      fail(failures, "strategy_index_formation_profile_invalid", {
        tier,
        examples: formationInvalid.slice(0, 3).map((candidate) => ({
          lineup_group_id: candidate?.lineup_group_id || null,
          formation_profile: candidate?.formation_profile || null,
        })),
      });
    }
    const strengthBurdenMixed = candidates.filter((candidate) => (
      Object.hasOwn(candidate?.strength_anchor?.quality || {}, "formation_burden")
      || Object.hasOwn(candidate?.strength_anchor?.quality || {}, "estimated_burden_score")
    ));
    if (strengthBurdenMixed.length) {
      fail(failures, "strategy_index_strength_and_formation_scores_mixed", {
        tier,
        examples: strengthBurdenMixed.slice(0, 3).map((candidate) => candidate?.lineup_group_id || null),
      });
    }
  }
  if (index.semantic_maintenance) {
    const maintenance = index.semantic_maintenance;
    if (!["ready", "degraded", "not_required"].includes(maintenance.status)
      || maintenance.current_day_strength_unchanged !== true
      || maintenance.authority !== "non_authoritative_semantic_annotation_only"
      || Object.hasOwn(maintenance, "prompt")
      || Object.hasOwn(maintenance, "response")) {
      fail(failures, "strategy_index_semantic_maintenance_receipt_invalid");
    }
  }
}

function validateRefreshRetention(snapshot, diff, manifest, failures) {
  if (!diff || typeof diff !== "object") {
    fail(failures, "diff_not_object");
    return;
  }
  if (!manifest || typeof manifest !== "object") {
    fail(failures, "manifest_not_object");
    return;
  }
  if (diff.stat_date !== snapshot.stat_date) {
    fail(failures, "diff_stat_date_mismatch", { snapshot_stat_date: snapshot.stat_date, diff_stat_date: diff.stat_date });
  }
  if (diff.previous_stat_date === snapshot.stat_date && manifest.same_stat_date_refresh !== true) {
    fail(failures, "same_stat_date_refresh_not_marked", {
      stat_date: snapshot.stat_date,
      previous_stat_date: diff.previous_stat_date,
      same_stat_date_refresh: manifest.same_stat_date_refresh,
    });
  }
}

const failures = [];
let snapshot;
let audit;
let signal;
let strategyIndex;
let diff;
let manifest;
let hardDataManifest;
let refreshContract;

try {
  snapshot = await readJson(SNAPSHOT_PATH);
} catch (error) {
  fail(failures, "snapshot_read_failed", { file: SNAPSHOT_PATH, error: error.message });
}

try {
  audit = await readJson(AUDIT_PATH);
} catch (error) {
  fail(failures, "audit_read_failed", { file: AUDIT_PATH, error: error.message });
}

try {
  signal = await readJson(SIGNAL_PATH);
} catch (error) {
  fail(failures, "rank_signal_read_failed", { file: SIGNAL_PATH, error: error.message });
}

try {
  strategyIndex = await readJson(STRATEGY_INDEX_PATH);
} catch (error) {
  fail(failures, "strategy_index_read_failed", { file: STRATEGY_INDEX_PATH, error: error.message });
}

try {
  diff = await readJson(DIFF_PATH);
} catch (error) {
  fail(failures, "diff_read_failed", { file: DIFF_PATH, error: error.message });
}

try {
  manifest = await readJson(MANIFEST_PATH);
} catch (error) {
  fail(failures, "manifest_read_failed", { file: MANIFEST_PATH, error: error.message });
}

try {
  hardDataManifest = await readJson(ACTIVE_HARD_DATA_MANIFEST_PATH);
} catch (error) {
  fail(failures, "active_hard_data_manifest_read_failed", { file: ACTIVE_HARD_DATA_MANIFEST_PATH, error: error.message });
}

try {
  refreshContract = await readJson(REFRESH_CONTRACT_PATH);
} catch (error) {
  fail(failures, "refresh_contract_read_failed", { file: REFRESH_CONTRACT_PATH, error: error.message });
}

if (snapshot) validateSnapshot(snapshot, failures);
if (audit) validateAudit(audit, failures);
if (snapshot) {
  const catalogCompatibility = auditLiveRankingCatalogCompatibility(snapshot, {
    champions: coverageChampions,
    items: coverageItems,
  });
  if (catalogCompatibility.status !== "pass") {
    fail(failures, "ranking_catalog_identity_incompatible", { catalog_compatibility: catalogCompatibility });
  }
  if (rankingTarget.selection === "candidate" && audit?.catalog_compatibility?.status !== "pass") {
    fail(failures, "candidate_audit_missing_catalog_compatibility");
  }
}
if (signal) validateSignal(signal, refreshContract, failures);
if (strategyIndex) validateStrategyIndex(strategyIndex, snapshot, signal, manifest, hardDataManifest, refreshContract, failures);
if (snapshot && diff && manifest) validateRefreshRetention(snapshot, diff, manifest, failures);
if (manifest && !manifest.current?.files?.includes("lineup-strategy-index.json")) {
  fail(failures, "manifest_missing_strategy_index");
}
for (const file of manifest?.current?.files || []) {
  try {
    await readJson(path.join(LIVE_DIR, file));
  } catch (error) {
    fail(failures, "manifest_file_missing_or_invalid", { file, error: error.message });
  }
}

if (failures.length) {
  console.error(JSON.stringify({ status: "fail", failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "pass",
  verified_dir: LIVE_DIR,
  stat_date: snapshot.stat_date,
  same_stat_date_refresh: manifest.same_stat_date_refresh === true,
  tiers: Object.keys(snapshot.tiers || {}).sort(),
  coverage: audit.coverage,
}, null, 2));
