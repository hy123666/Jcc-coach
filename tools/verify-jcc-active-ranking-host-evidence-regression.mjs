import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  resolveActiveLiveRankingGeneration,
} from "./jcc_live_rankings_generation_store.mjs";
import {
  materializeRankingCandidateRecipes,
  NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA,
  validateNormalizedRankingRecipeStorage,
} from "./jcc_ranking_recipe_storage.mjs";
import { compactPipelineRankingCandidate } from "./run-jcc-cruise-runtime-pipeline.mjs";
import {
  materializeHostEvidence,
  restoreHostEvidence,
} from "../ui/electron/host-evidence-materialization.js";
import { compactHostTurnDelta, buildHostTurnDeltaPrompt, buildRuntimeHostContext } from "../ui/electron/runtime-service.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const rankingRoot = path.join(repoRoot, "data/live-rankings/jcc");
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const array = (value) => Array.isArray(value) ? value : [];
const candidateIds = (value) => array(value).map((row) => String(row?.candidate_evidence_id || "")).filter(Boolean);
const roster = (candidate) => array(candidate?.atomic_roster_members || candidate?.core_units || candidate?.champion_names);
function completeCandidateBodyCounts(value, counts = new Map()) {
  if (!value || typeof value !== "object") return counts;
  const canonical = value.strategy_profile?.canonical_variant;
  const evidenceId = value.candidate_evidence_id || canonical?.candidate_evidence_id;
  const hasCompleteBody = value.roster_is_atomic === true && roster(value).length > 0
    || canonical?.roster_is_atomic === true && roster(canonical).length > 0;
  if (!Array.isArray(value) && (value.candidate_id || value.id) && evidenceId && hasCompleteBody) {
    counts.set(evidenceId, (counts.get(evidenceId) || 0) + 1);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    completeCandidateBodyCounts(child, counts);
  }
  return counts;
}
function assertBoundedVariantHistory(value, location = "$") {
  if (!value || typeof value !== "object") return;
  if (value.candidate_id && Array.isArray(value.variants)) {
    assert.ok(value.variants.length <= 1, `${location}.variants must contain only the selected canonical variant`);
  }
  if (Array.isArray(value.mature_recipe_variants)) {
    assert.ok(value.mature_recipe_variants.length <= 6, `${location}.mature_recipe_variants must be bounded`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === "object") assertBoundedVariantHistory(child, `${location}.${key}`);
  }
}

const active = await resolveActiveLiveRankingGeneration({ rootDir: rankingRoot });
const indexPath = path.join(active.generation_dir, "lineup-strategy-index.json");
const index = JSON.parse(await readFile(indexPath, "utf8"));
assert.equal(index.schema, NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA);
const recipeStorageReceipt = validateNormalizedRankingRecipeStorage(index);
const activeTier = index?.tiers?.["0"];
const storedCandidates = array(activeTier?.lineup_candidates);
const rawCandidates = storedCandidates.map((candidate) => materializeRankingCandidateRecipes(candidate, activeTier));
assert.ok(rawCandidates.length > 10, "the Active Ranking generation must exercise a wide raw candidate pool");
assert.ok(storedCandidates.every((candidate) => (
  !Object.hasOwn(candidate, "mature_recipe_variants")
  && array(candidate.variants).every((variant) => !Object.hasOwn(variant, "mature_recipe_variants"))
)), "the Active Ranking generation must persist recipe relations by reference");

const rawEvidenceIds = candidateIds(rawCandidates);
assert.equal(new Set(rawEvidenceIds).size, rawEvidenceIds.length, "raw candidate_evidence_id values must be unique");
assert.ok(rawCandidates.every((candidate) => array(candidate.variants).every((variant) => variant.roster_is_atomic === true)));
assert.ok(rawCandidates.every((candidate) => array(candidate.variants).every((variant) => roster(variant).length > 0)));

const compactCandidates = rawCandidates
  .map((candidate, index) => compactPipelineRankingCandidate(candidate, index, active.pointer.generation_id))
  .filter(Boolean);
assert.equal(compactCandidates.length, rawCandidates.length);
assert.ok(compactCandidates.every((candidate) => candidate.candidate_evidence_id));
assert.ok(compactCandidates.every((candidate) => candidate.roster_is_atomic === true && roster(candidate).length > 0));

const strategicFit = {
  schema: "jcc-strategy-fit-packet-v1",
  requested_display_count: 3,
  candidate_working_set_source_count: compactCandidates.length,
  candidate_working_set: compactCandidates,
  strategic_checkpoint: { checkpoint_id: "lineup_direction_2-2", stage_round: "2-2" },
  strategic_obligation: { stage_round: "2-2", required_decisions: ["lineup_direction"] },
};
const strategicDelta = {
  schema: "jcc-host-current-turn-delta-v1",
  request_id: "active-ranking-strategic-2-2",
  request_hash: "active-ranking-strategic-2-2",
  mode: "cruise",
  user_message: "2-2 当前阵容方向",
  runtime_context: {
    strategy_fit_packet: structuredClone(strategicFit),
    selected_ranking_candidates: { candidates: structuredClone(compactCandidates) },
    strategy_evidence_prefetch: { evidence: { frontier: structuredClone(compactCandidates) } },
    strategy_evidence_coverage: {
      receipts: [{ facet_id: "candidate_frontier", source_domain: "ranking", evidence_keys: ["frontier"] }],
    },
  },
  selected_ranking_candidates: { candidates: structuredClone(compactCandidates) },
};
const materialized = materializeHostEvidence(strategicDelta, {
  runtimeContext: { strategy_fit_packet: strategicFit },
});
const restored = restoreHostEvidence(JSON.parse(JSON.stringify(materialized)));
const materializedSet = materialized.runtime_context.strategy_fit_packet.candidate_working_set;
const restoredSet = restored.runtime_context.strategy_fit_packet.candidate_working_set;
const materializedIds = candidateIds(materializedSet);
const restoredIds = candidateIds(restoredSet);

assert.equal(materializedSet.length, 10, "Agent working set must be capped at 10");
assert.equal(materialized.runtime_context.host_evidence_materialization.agent_candidate_count, 10);
assert.equal(materialized.runtime_context.host_evidence_materialization.retrieval_pool_count, compactCandidates.length);
assert.equal(new Set(materializedIds).size, materializedIds.length);
assert.ok(restoredSet.every((candidate) => candidate.roster_is_atomic === true && roster(candidate).length > 0));
assert.deepEqual(restoredIds, materializedIds);

const bodyCounts = completeCandidateBodyCounts(materialized);
for (const evidenceId of materializedIds) {
  assert.equal(bodyCounts.get(evidenceId), 1, `candidate evidence must be fully materialized once: ${evidenceId}`);
}
assert.ok(materialized.runtime_context.strategy_evidence_prefetch.evidence.frontier.every((row) => row?.schema === "jcc-host-evidence-address-reference-v1"));
assert.ok(materialized.runtime_context.selected_ranking_candidates.candidates.every((row) => row?.schema === "jcc-host-evidence-address-reference-v1"));
assert.ok(materialized.selected_ranking_candidates.candidates.every((row) => row?.schema === "jcc-host-evidence-address-reference-v1"));
assertBoundedVariantHistory(materialized);
assertBoundedVariantHistory(restored);

const strategicTransport = compactHostTurnDelta(strategicDelta, {
  capsule_id: "active-ranking-regression",
  fingerprint: active.pointer.content_sha256,
});
assert.ok(bytes(strategicTransport) <= 8 * 1024 * 1024, "strategic transport must remain below the absolute 8 MiB ceiling");
assert.ok(array(strategicTransport.runtime_context?.strategy_fit_packet?.candidate_working_set).length <= 10);
assertBoundedVariantHistory(strategicTransport);

const productionRankingRequest = {
  request_id: "active-ranking-production-projection",
  request_hash: "active-ranking-production-projection",
  mode: "daily_chat",
  request_kind: "host_question",
  ranking_recommendation: true,
  ranking_requested_count: 5,
  ranking_query_route_key: "daily:active-ranking-production-projection",
  user_message: "给我5套当前上分阵容",
  task: { type: "direct_chat" },
  context: {},
};
const productionContext = await import("../ui/electron/runtime-service.js").then(({ setRuntimeServiceState, buildRuntimeHostContext }) => {
  setRuntimeServiceState({
    active_mode: "daily_chat",
    daily_session: { status: "active", mode: "daily_chat", generation: 91 },
    match_session: { status: "idle", match_session_id: null },
    match_context: {},
    user_preferences: { rank_tier: "master" },
  });
  return buildRuntimeHostContext("daily_chat", null, productionRankingRequest);
});
const productionCandidates = array(productionContext?.selected_ranking_candidates?.candidates);
const productionCapability = productionContext?.strategy_evidence_plan?.provider_capability
  || productionContext?.strategy_evidence_snapshot?.identity?.provider_capability
  || "prefetch_complete";
if (productionCapability === "native_dynamic_tools") {
  assert.equal(productionCandidates.length, 0,
    "native-tools production projection must not prefetch Ranking candidates");
  assert.equal(Object.keys(productionContext?.strategy_evidence_prefetch?.evidence || {}).length, 0,
    "native-tools production projection must not prefetch evidence payloads");
  assert.ok(array(productionContext?.strategy_evidence_coverage?.receipts).some((receipt) => (
    receipt.delivery === "snapshot_bound_tool"
  )), "native-tools production projection must bind unresolved evidence to the query tool");
} else {
  assert.equal(productionCandidates.length, 10,
    "prefetch production Runtime projection must provide ten bounded candidates");
  assert.ok(productionCandidates.every((candidate) => (
    candidate.candidate_evidence_id
      && candidate.selected_variant_id
      && candidate.atomic_roster_id
      && candidate.roster_is_atomic === true
      && array(candidate.atomic_roster_members).length > 0
      && candidate.strategy_profile?.canonical_variant?.candidate_evidence_id
      && candidate.strategy_profile.canonical_variant.roster_is_atomic === true
      && array(candidate.strategy_profile.canonical_variant.atomic_roster_members).length > 0
  )), "production Host candidates must remain complete atomic evidence");
}
const productionRequest = { ...productionRankingRequest, runtime_context: productionContext };
for (const candidate of productionCandidates) {
  const source = rawCandidates.flatMap(row => array(row.variants))
    .find(row => row.candidate_evidence_id === candidate.candidate_evidence_id);
  assert.ok(source, "production candidate identity must resolve in the active source");
  assert.deepEqual(candidate.strategy_profile.canonical_variant.lineup_names, source.lineup_names);
  assert.deepEqual(candidate.strategy_profile.canonical_variant.mature_recipe_variants,
    array(source.mature_recipe_variants).slice(0, 6));
}
const negativeRoutes = ["聊一下当前上分思路", "大数据装备怎么出", "大数据强化怎么选", "给我5套装备", "经济和金币怎么管理"];
for (const [index, user_message] of negativeRoutes.entries()) {
  const context = await buildRuntimeHostContext("daily_chat", null, {
    request_id: `negative-ranking-route-${index}`, mode: "daily_chat", request_kind: "host_question", user_message,
  });
  assert.equal(array(context.selected_ranking_candidates?.candidates).length, 0, user_message);
}
const productionPrompt = buildHostTurnDeltaPrompt(productionRequest, {
  capsule_id: "active-ranking-production-projection",
  fingerprint: active.pointer.content_sha256,
});
const productionInput = JSON.parse(productionPrompt.slice(
  productionPrompt.indexOf("INPUT_JSON:\n") + "INPUT_JSON:\n".length,
));
const productionBodyCounts = completeCandidateBodyCounts(productionInput);
for (const candidate of productionCandidates) {
  assert.equal(productionBodyCounts.get(candidate.candidate_evidence_id), 1,
    `production wire must own each complete candidate body once: ${candidate.candidate_evidence_id}`);
}
assert.ok(Buffer.byteLength(productionPrompt, "utf8") < 512 * 1024,
  "production projected Ranking prompt must remain below the compact ordinary target");

const dailyDelta = {
  schema: "jcc-host-current-turn-delta-v1",
  request_id: "daily-chat-no-ranking-autoload",
  request_hash: "daily-chat-no-ranking-autoload",
  mode: "daily_chat",
  user_message: "聊一下当前上分思路",
  ranking_working_set_hint: 10,
  runtime_context: {
    active_mode: "daily_chat",
    daily_big_data: { available: true, ranking_overlay_id: active.pointer.generation_id },
  },
};
const dailyTransport = compactHostTurnDelta(dailyDelta, {
  capsule_id: "active-ranking-regression",
  fingerprint: active.pointer.content_sha256,
});
const dailyText = JSON.stringify(dailyTransport);
assert.equal(array(dailyTransport.runtime_context?.strategy_fit_packet?.candidate_working_set).length, 0);
assert.equal(array(dailyTransport.selected_ranking_candidates?.candidates).length, 0);
assert.equal(dailyText.includes("candidate_evidence_id"), false, "daily chat must not auto-load a full candidate pool");

const report = {
  ok: true,
  schema: "jcc-active-ranking-host-evidence-regression-v1",
  active_generation: active.pointer.generation_id,
  stat_date: active.pointer.stat_date,
  raw_candidate_count: rawCandidates.length,
  stored_candidate_bytes: bytes(storedCandidates),
  raw_candidate_bytes: bytes(rawCandidates),
  ranking_index_bytes: (await stat(indexPath)).size,
  raw_variant_count: rawCandidates.reduce((sum, candidate) => sum + array(candidate.variants).length, 0),
  raw_mature_recipe_variant_count: rawCandidates.reduce((sum, candidate) => sum + array(candidate.mature_recipe_variants).length, 0),
  recipe_storage_receipt: recipeStorageReceipt,
  agent_working_set_count: materializedSet.length,
  strategic_materialized_bytes: bytes(materialized),
  strategic_restored_bytes: bytes(restored),
  strategic_transport_bytes: bytes(strategicTransport),
  production_prompt_bytes: Buffer.byteLength(productionPrompt, "utf8"),
  negative_routes_checked: negativeRoutes.length,
  daily_chat_transport_bytes: bytes(dailyTransport),
  host_evidence_reference_count: materialized.runtime_context.host_evidence_materialization.reference_count,
  checks: [
    "active_generation_verified_without_mutation",
    "normalized_recipe_storage_materializes_losslessly",
    "stored_candidates_reference_recipe_relations",
    "raw_candidates_are_wide",
    "agent_working_set_at_most_10",
    "canonical_rosters_complete_after_restore",
    "candidate_evidence_materialized_once",
    "variants_and_mature_recipe_history_bounded",
    "daily_chat_does_not_autoload_ranking_pool",
    "strategic_2-2_working_set_bounded_and_complete",
    "production_runtime_projection_preserves_atomic_candidate_identity",
    "production_wire_owns_each_candidate_body_once",
    "production_projected_ranking_prompt_below_ceiling",
  ],
};
console.log(JSON.stringify(report, null, 2));
