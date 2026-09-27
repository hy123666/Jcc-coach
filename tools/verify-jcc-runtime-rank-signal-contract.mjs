import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA } from "./jcc_ranking_recipe_storage.mjs";
import { classifyRankingCapabilityStatus } from "./jcc_live_rankings_capability_status.mjs";

const CONTRACT_PATH = path.resolve("data/live-rankings/jcc/runtime-strategy-signal-contract.json");
const REFRESH_CONTRACT_PATH = path.resolve("data/live-rankings/jcc/runtime-agent-refresh-contract.json");
const BOOTSTRAP_PATH = path.resolve("tools/bootstrap-jcc-runtime-agent.mjs");
const REQUIRED_TIERS = ["0"];
const REQUIRED_SIGNAL_SECTIONS = ["top_traits", "top_heroes", "top_equips", "hero_item_signal", "top_lineups", "augment_lineup_signal"];

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSourcePath(sourcePath) {
  const value = String(sourcePath || "");
  const prefix = "active_hard_data_manifest:";
  if (!value.startsWith(prefix)) return path.resolve(value);
  const manifestPath = path.resolve(createRuntimePaths(path.resolve(".")).activeHardDataManifest);
  return path.resolve(path.dirname(manifestPath), value.slice(prefix.length));
}

function fail(failures, reason, extra = {}) {
  failures.push({ reason, ...extra });
}

function checkPrecedence(routeId, precedence, failures) {
  if (!Array.isArray(precedence)) {
    fail(failures, "route_precedence_not_array", { routeId });
    return;
  }
  for (const field of ["hard_data", "live_state", "rank_signal"]) {
    if (!precedence.includes(field)) fail(failures, "route_precedence_missing_field", { routeId, field });
  }
  if (precedence.indexOf("rank_signal") < precedence.indexOf("hard_data") || precedence.indexOf("rank_signal") < precedence.indexOf("live_state")) {
    fail(failures, "rank_signal_precedence_too_high", { routeId, precedence });
  }
}

const failures = [];
let contract;
let signal;
let audit;
let manifest;
let strategyIndex;
const runtimePaths = createRuntimePaths(path.resolve("."));
const rankingAvailable = Boolean(runtimePaths.activeRankingGenerationId);

try {
  contract = await readJson(CONTRACT_PATH);
} catch (error) {
  fail(failures, "contract_read_failed", { file: CONTRACT_PATH, error: error.message });
}

if (contract) {
  for (const field of ["schema_version", "contract_id", "data_sources", "tier_selection", "precedence", "route_signal_policy", "runtime_context_contract"]) {
    if (contract[field] === undefined) fail(failures, "contract_missing_field", { field });
  }

  for (const sourceField of ["rank_signal", "audit", "manifest", "strategy_index"]) {
    const sourcePath = contract.data_sources?.[sourceField];
    if (!sourcePath) {
      fail(failures, "contract_missing_data_source", { sourceField });
      continue;
    }
    if (rankingAvailable) {
      const runtimeFile = {
        rank_signal: runtimePaths.liveRankingsRankSignalFile,
        audit: runtimePaths.liveRankingsAuditFile,
        manifest: runtimePaths.liveRankingsManifestFile,
        strategy_index: runtimePaths.liveRankingsStrategyIndexFile,
      }[sourceField];
      if (!(await exists(runtimeFile))) fail(failures, "contract_data_source_missing_file", { sourceField, sourcePath: runtimeFile });
    }
  }

  if (rankingAvailable) {
    try {
      signal = await readJson(runtimePaths.liveRankingsRankSignalFile);
      audit = await readJson(runtimePaths.liveRankingsAuditFile);
      manifest = await readJson(runtimePaths.liveRankingsManifestFile);
      strategyIndex = await readJson(runtimePaths.liveRankingsStrategyIndexFile);
    } catch (error) {
      fail(failures, "linked_data_read_failed", { error: error.message });
    }
  }
}

if (rankingAvailable && !classifyRankingCapabilityStatus(audit, strategyIndex).full_ranking_overlay_available) {
  fail(failures, "ranking_capabilities_incomplete", { status: audit?.status, auditFailures: audit?.failures || [] });
}

if (signal) {
  for (const tier of REQUIRED_TIERS) {
    const tierSignal = signal.tiers?.[tier];
    if (!tierSignal) {
      fail(failures, "rank_signal_missing_tier", { tier });
      continue;
    }
    for (const section of REQUIRED_SIGNAL_SECTIONS) {
      if (!Array.isArray(tierSignal[section]) || tierSignal[section].length === 0) {
        fail(failures, "rank_signal_empty_section", { tier, section });
      }
    }
    const badHeroItemRows = (tierSignal.hero_item_signal || []).filter((row) => {
      return !row.hero_id || !Array.isArray(row.items) || row.items.length === 0 || row.interpretation !== "rank_prior_not_perfect_item_combo";
    });
    if (badHeroItemRows.length) {
      fail(failures, "hero_item_signal_invalid_shape", {
        tier,
        examples: badHeroItemRows.slice(0, 3),
      });
    }
    const badAugmentRows = (tierSignal.augment_lineup_signal || []).filter((row) => {
      return !row.augment_id
        || row.interpretation !== "lineup_association_prior_not_independent_augment_winrate"
        || row.not_independent_winrate !== true
        || !Array.isArray(row.associated_lineups)
        || row.associated_lineups.length === 0;
    });
    if (badAugmentRows.length) {
      fail(failures, "augment_lineup_signal_invalid_shape", {
        tier,
        examples: badAugmentRows.slice(0, 3),
      });
    }
  }
}

if (contract) {
  const routeIds = Object.keys(contract.route_signal_policy || {}).sort();
  const contractRouteIds = Object.keys(contract.route_signal_policy || {}).sort();
  for (const routeId of routeIds) {
    const policy = contract.route_signal_policy?.[routeId];
    if (!policy) {
      fail(failures, "contract_missing_route_policy", { routeId });
      continue;
    }
    if (!Array.isArray(policy.signal_sections) || policy.signal_sections.length === 0) {
      fail(failures, "route_policy_empty_signal_sections", { routeId });
    }
    for (const section of policy.signal_sections || []) {
      if (!REQUIRED_SIGNAL_SECTIONS.includes(section)) fail(failures, "route_policy_unknown_signal_section", { routeId, section });
    }
    checkPrecedence(routeId, policy.precedence, failures);
  }
  for (const routeId of ["item_craft", "holder_assignment"]) {
    if (!contract.route_signal_policy?.[routeId]?.signal_sections?.includes("hero_item_signal")) {
      fail(failures, "hero_item_signal_missing_from_item_route", { routeId });
    }
  }
  if (!contract.route_signal_policy?.augment_choice?.signal_sections?.includes("augment_lineup_signal")) {
    fail(failures, "augment_lineup_signal_missing_from_augment_route");
  }
}

if (contract) {
  if (contract.schema_version !== 4) {
    fail(failures, "strategy_signal_contract_schema_not_v4", { schema_version: contract.schema_version });
  }
  if (contract.strategy_index_policy?.schema !== NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA) {
    fail(failures, "strategy_index_policy_schema_not_v4", { schema: contract.strategy_index_policy?.schema });
  }
  const gradientPolicy = JSON.stringify(contract.strategy_index_policy?.current_day_strength_gradient || {});
  for (const phrase of ["top-four", "average-rank", "top-one", "direct composite weight is 0", "Recipe evidence only"]) {
    if (!gradientPolicy.includes(phrase)) fail(failures, "current_day_strength_gradient_policy_missing_boundary", { phrase });
  }
  for (const field of [
    "strength_anchors",
    "recipe_match",
    "recipe_evidence",
    "hero_profiles",
    "reverse_indexes",
    "recipe_catalog",
    "recipe_catalog_ids",
    "recipe_relation_field_catalog",
    "recipe_relation_value_catalog",
    "recipe_relation_catalog",
    "recipe_storage",
    "data_quality",
  ]) {
    if (!contract.strategy_index_policy?.required_evidence?.includes(field)) {
      fail(failures, "strategy_index_policy_missing_required_evidence", { field });
    }
  }
  const recipeStoragePolicy = JSON.stringify(contract.strategy_index_policy?.recipe_storage || {});
  for (const phrase of ["expanded semantic hash", "requested candidate", "v3 expanded generations"]) {
    if (!recipeStoragePolicy.includes(phrase)) {
      fail(failures, "strategy_index_recipe_storage_policy_missing_boundary", { phrase });
    }
  }
  const historyRole = String(contract.usage_policy?.history_role || "");
  if (!historyRole.includes("Runtime never reads history") || !historyRole.includes("zero score weight")) {
    fail(failures, "history_role_missing_compiled_auxiliary_boundary");
  }
  if (!String(contract.history_policy?.live_match_use || "").startsWith("compiled_same_binding_auxiliary_evidence_only")) {
    fail(failures, "history_policy_missing_same_binding_auxiliary_boundary", { live_match_use: contract.history_policy?.live_match_use });
  }
  if (contract.history_policy?.score_weight !== 0
    || contract.history_policy?.may_change_candidate_order !== false
    || contract.history_policy?.may_change_candidate_membership !== false) {
    fail(failures, "history_policy_can_change_current_day_strength");
  }
  const supportedTiers = Object.keys(contract.tier_selection?.supported_tier_parts || {}).sort();
  for (const tier of REQUIRED_TIERS) {
    if (!supportedTiers.includes(tier)) fail(failures, "tier_selection_missing_supported_tier", { tier });
  }
  if (JSON.stringify(supportedTiers) !== JSON.stringify(REQUIRED_TIERS)) {
    fail(failures, "tier_selection_must_be_master_plus_only", { supported_tiers: supportedTiers });
  }
  if (String(contract.tier_selection?.default_tier_part) !== "0") {
    fail(failures, "tier_selection_default_not_master_plus", { default_tier_part: contract.tier_selection?.default_tier_part });
  }
  const policyText = JSON.stringify(contract.hero_item_signal_policy || {});
  for (const phrase of ["perfect_three_item_combo", "visible_live_state", "owned_components", "hard_data_item_fit"]) {
    if (!policyText.includes(phrase)) fail(failures, "hero_item_signal_policy_missing_guardrail", { phrase });
  }
  const augmentPolicyText = JSON.stringify(contract.augment_lineup_signal_policy || {});
  for (const phrase of ["lineup_association_prior", "not_independent_winrate", "visible_live_state", "selected_augments"]) {
    if (!augmentPolicyText.includes(phrase)) fail(failures, "augment_lineup_signal_policy_missing_guardrail", { phrase });
  }
}

const refreshText = await readFile(REFRESH_CONTRACT_PATH, "utf8");
const contractText = contract ? JSON.stringify(contract) : "";
const bootstrapText = await readFile(BOOTSTRAP_PATH, "utf8");
if (/Codex App scheduled automation|Codex App daily automation/i.test(refreshText) || /Codex App scheduled automation|Codex App daily automation/i.test(contractText)) {
  fail(failures, "codex_app_automation_dependency_detected");
}
if (!refreshText.includes("runtime-strategy-signal-contract.json") || !refreshText.includes("load-jcc-runtime-rank-signal.mjs")) {
  fail(failures, "refresh_contract_missing_strategy_signal_references");
}
if (!refreshText.includes("Runtime must never read history files or day-over-day diff directly")
  || !refreshText.includes("cannot change current-day score, order, membership")) {
  fail(failures, "refresh_contract_missing_compiled_trend_boundary");
}
if (!bootstrapText.includes("verify-jcc-runtime-rank-signal-contract.mjs")) {
  fail(failures, "bootstrap_missing_rank_signal_verifier");
}
if (!bootstrapText.includes("load-jcc-runtime-rank-signal.mjs")) {
  fail(failures, "bootstrap_missing_rank_signal_loader");
}
if (!bootstrapText.includes('"--local-only"')) {
  fail(failures, "bootstrap_ranking_guard_may_attempt_network");
}
if (!bootstrapText.includes("activeRankingGenerationId") || !bootstrapText.includes("core_only_runtime_ready")) {
  fail(failures, "bootstrap_missing_core_only_unavailable_branch");
}
const localGuard = spawnSync("node", ["tools/ensure-jcc-live-rankings.mjs", "--local-only"], {
  cwd: path.resolve("."),
  encoding: "utf8",
});
if (localGuard.status !== 0) {
  fail(failures, "local_ranking_guard_failed", { stderr: String(localGuard.stderr || "").slice(0, 300) });
} else {
  try {
    const status = JSON.parse(String(localGuard.stdout || "{}"));
    if (status.network_attempted !== false || !["live_rankings_ready", "live_rankings_unavailable"].includes(status.status)) {
      fail(failures, "local_ranking_guard_invalid_status", { status });
    }
  } catch (error) {
    fail(failures, "local_ranking_guard_invalid_json", { error: error.message });
  }
}

if (manifest?.current?.files && !manifest.current.files.includes("rank-signal.json")) {
  fail(failures, "manifest_missing_rank_signal");
}
if (manifest?.current?.files && !manifest.current.files.includes("lineup-strategy-index.json")) {
  fail(failures, "manifest_missing_strategy_index");
}
if (rankingAvailable && strategyIndex?.schema !== NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA) {
  fail(failures, "promoted_strategy_index_schema_not_v4", { schema: strategyIndex?.schema });
}
const reverseIndexKeys = contract?.strategy_index_policy?.reverse_index_policy?.keys || [];
for (const forbidden of ["family_id", "raw_family_id", "trait_family_id"]) {
  if (reverseIndexKeys.includes(forbidden)) fail(failures, "raw_family_semantic_reverse_index_forbidden", { forbidden });
}
if (!reverseIndexKeys.includes("canonical_trait_id")) {
  fail(failures, "canonical_trait_reverse_index_missing");
}

if (failures.length) {
  console.error(JSON.stringify({ status: "fail", failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "pass",
  contract_id: contract.contract_id,
  ranking_status: rankingAvailable ? "available" : "unavailable",
  stat_date: signal?.stat_date || null,
  tiers: REQUIRED_TIERS,
  routes: Object.keys(contract.route_signal_policy || {}).sort(),
  context_artifact_path: contract.runtime_context_contract.artifact_path,
}, null, 2));
