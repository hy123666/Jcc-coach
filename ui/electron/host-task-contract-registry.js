// Input contracts only. Materialized strategy evidence is rebuilt by Runtime,
// never carried forward from a previous Host turn.
const CONTROL_FIELDS = Object.freeze([
  "schema", "request_id", "request_hash", "response_id", "response_task", "task",
  "task_id", "response_task_id", "created_at", "mode", "request_kind", "origin",
  "origin_action_id", "user_message", "structured_card_action", "lineup_card_intent",
  "lineup_confirmation_requested", "lineup_confirmation_source", "lineup_target_sources_supported",
  "pinned_result_required", "expected_response_shape", "context_pack", "provider",
  "provider_readonly_tool_mode", "evidence_policy_id", "evidence_policy",
  "current_match_user_report", "choices", "choice_kind", "augment_candidate_names",
  "ranking_recommendation", "ranking_requested_count", "ranking_query_route_key",
  "ranking_working_set_hint", "strategic_decision_keys", "strategic_candidate_ids",
  "fact_capture", "runtime_event_context", "instructions", "fallback_text",
]);

const CONTEXT_FIELDS = Object.freeze([
  "choices", "lineup_card_intent", "lineup_confirmation_requested", "lineup_confirmation_source",
  "lineup_target_sources_supported", "mode", "user_message",
]);

export const HOST_TASK_CONTEXT_FIELDS = Object.freeze([
  "type", "task_id", "trigger_id", "decision_trigger_id", "decision_task_id",
  "fixed_checkpoint_id", "fixed_checkpoint_stage_round", "event_key", "event_type",
  "event_category", "priority", "title", "short_advice", "semantic_labels", "user_message",
  "explicit_user_card_action", "persistent_strategic_projection", "existing_strategic_obligation_delivery",
]);

export const HOST_SUPPORTING_EVENT_FIELDS = Object.freeze([
  "schema", "event_key", "event_type", "event_category", "stage_round",
  "fixed_checkpoint_id", "fixed_checkpoint_stage_round", "decision_trigger_id", "decision_task_id",
  "strategy_block_id", "fixed_checkpoint_block_sequence", "fixed_checkpoint_block_role",
  "existing_strategic_obligation_delivery", "catch_up_from_stage_round", "deferred_from_stage_round",
]);

const FACT_CAPTURE_RUNTIME_FIELDS = Object.freeze([
  "request_kind", "match_session_id", "current_stage_round", "fact_capture_catalog", "current_match_facts",
]);
const NO_FIELDS = Object.freeze([]);

function contract(id, outputContract, runtimeFields = NO_FIELDS) {
  return Object.freeze({
    id,
    allowed_control_fields: CONTROL_FIELDS,
    allowed_context_fields: CONTEXT_FIELDS,
    allowed_runtime_input_fields: runtimeFields,
    output_contract: outputContract,
    recovery_policy: "rebuild_from_ledger",
  });
}

const CONTRACTS = Object.freeze({
  default: contract("default", "final_text"),
  choice: contract("choice", "choice_handoff"),
  strategic_checkpoint: contract("strategic_checkpoint", "candidate_refs"),
  lineup_card: contract("lineup_card", "lineup_handoff"),
  fact_capture: contract("fact_capture", "fact_capture", FACT_CAPTURE_RUNTIME_FIELDS),
  core_only: contract("core_only", "final_text"),
  popular_recipe: contract("popular_recipe", "final_text"),
});

const MODE_CONTRACTS = Object.freeze({
  augment_choice: "choice", item_choice: "choice", strategic_checkpoint: "strategic_checkpoint",
  lineup_card: "lineup_card",
});
const REQUEST_KIND_CONTRACTS = Object.freeze({
  match_fact_capture: "fact_capture", hard_data_query: "core_only",
  daily_core_theory_query: "core_only", popular_recipe_query: "popular_recipe",
});

export function taskContractFor(mode, requestKind = null) {
  const kindKey = String(requestKind || "");
  const modeKey = String(mode || "").trim().toLowerCase();
  const id = Object.hasOwn(REQUEST_KIND_CONTRACTS, kindKey) ? REQUEST_KIND_CONTRACTS[kindKey]
    : Object.hasOwn(MODE_CONTRACTS, modeKey) ? MODE_CONTRACTS[modeKey] : "default";
  return CONTRACTS[id];
}

export function taskContractRegistry() { return CONTRACTS; }
