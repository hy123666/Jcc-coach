import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const service = readFileSync("ui/electron/runtime-service.js", "utf8");
const modeContract = JSON.parse(readFileSync("data/runtime/jcc/runtime-ui-mode-contract.json", "utf8"));
const signatureContract = JSON.parse(readFileSync("data/runtime/jcc/host-coach-signature-contract.json", "utf8"));

function assertIncludes(needle, message) {
  assert(service.includes(needle), message);
}

function functionBody(name) {
  const asyncStart = service.indexOf(`async function ${name}`);
  const plainStart = service.indexOf(`function ${name}`);
  const start = asyncStart >= 0 ? asyncStart : plainStart;
  assert(start >= 0, `${name} must exist`);
  const next = service.indexOf("\nasync function ", start + 1);
  const nextPlain = service.indexOf("\nfunction ", start + 1);
  const candidates = [next, nextPlain].filter((index) => index > start);
  const end = candidates.length ? Math.min(...candidates) : service.length;
  return service.slice(start, end);
}

for (const action of ["getDecisionInputOptions", "submitDecisionInput", "confirmDecisionSelection"]) {
  assertIncludes(`case "${action}": return ${action}(body);`, `${action} must be exposed through handleRuntimeAction`);
}

const optionsBody = functionBody("getDecisionInputOptions");
assert(optionsBody.includes("buildDecisionInputPayloadBinding"), "decision options must expose immutable payload binding");
assert(optionsBody.includes("loadDecisionInputCatalog") || service.includes("loadDecisionInputCatalog"), "decision options must reuse decision-input-catalog.js loader");
assert(optionsBody.includes("searchDecisionInputCatalog"), "decision options must expose catalog search");
assert(optionsBody.includes("listDecisionInputCandidates"), "decision options must expose catalog list/filter candidates");
assert(optionsBody.includes("choice_set_revision"), "decision options must bind the active choice set revision");
assert(optionsBody.includes("report_id"), "decision options must bind a report id");
assert(optionsBody.includes("supportedDecisionInputModes()") && optionsBody.includes("supported_choice_kinds"), "decision options must support descriptor modes plus augment, star-god, and item/anvil kinds");
assert(optionsBody.includes('schema: "jcc-runtime-decision-input-options-v1"'), "decision options must return the runtimeBridge-compatible nested options schema");
assert(optionsBody.includes("options_by_group"), "decision options must expose grouped catalog options");
assert(optionsBody.includes("current_effective_equipment"), "decision options must expose current effective equipment");
assert(optionsBody.includes("catalog_candidates"), "decision options must keep backend catalog candidates available outside the nested bridge object");

const submitBody = functionBody("submitDecisionInput");
assert(submitBody.includes("payloadBindingMatchesCurrentDecisionInput"), "submit must reject stale card payload bindings");
assert(submitBody.includes("decision_input_payload_binding_required"), "submit must reject a missing card payload binding");
assert(!submitBody.includes("payload.payload_binding || currentBinding"), "submit must not silently mint a replacement client binding");
assert(!submitBody.includes("recordMatchUserMessageContext"), "submit must not round-trip structured candidates through free-text message parsing");
assert(submitBody.includes("recordStructuredReportedChoiceSet"), "submit must directly store structured reported choice sets");
assert(submitBody.includes("changed_sections"), "submit must return changed equipment sections");
assert(submitBody.includes("reported_choice_set"), "submit must keep candidate reports separate from final selections");
assert(submitBody.includes("structured_facts_recorded"), "submit must allow fact-update-only equipment submissions");
assert(submitBody.includes("fact_update_only"), "submit must mark fact-update-only submissions without opening a Host sibling");
assert(submitBody.includes("equipmentFactOnly"), "fact-only equipment persistence must be identified separately from candidate-bearing actions");
assert(
  submitBody.includes("const bindingCheck = equipmentFactOnly")
    && submitBody.includes("payloadBindingMatchesCurrentDecisionInput")
    && submitBody.includes("if (!bindingCheck.ok)"),
  "candidate-bearing actions must fail closed on stale bindings while fact-only equipment bypasses them",
);

const confirmBody = functionBody("confirmDecisionSelection");
assert(confirmBody.includes("payloadBindingMatchesCurrentDecisionInput"), "confirm must reject stale card payload bindings");
assert(confirmBody.includes("decision_input_payload_binding_required"), "confirm must reject a missing card payload binding");
assert(!confirmBody.includes("payload.payload_binding || buildDecisionInputPayloadBinding"), "confirm must not silently mint a replacement client binding");
assert(confirmBody.includes("recordStructuredDecisionSelection"), "confirm must record structured final selection separately");
assert(service.includes("structuredSelectionMatchesChoiceSet"), "confirm must verify the selected ref/name/slot belongs to the current exact choice set");
assert(
  functionBody("structuredSelectionMatchesChoiceSet").includes("!Number.isFinite(selectedSlot) || (!selectedRefKey && !selectedName)"),
  "final confirmation must require slot plus ref/name identity",
);
assert(confirmBody.includes("semantic_followup_owner"), "card confirmation result must expose its state-only response ownership");
assert(confirmBody.includes("已记录"), "card confirmation must return an immediate recorded status message");
assert(confirmBody.includes('response_policy: "no_confirmation_followup"'), "card confirmation must remain a state-only action");
assert(confirmBody.includes("response_task: null"), "card confirmation must not create a Host response task");
assert(!service.includes("enqueueStructuredDecisionFollowupTask"), "retired confirmation follow-up scheduling must be deleted");
assert(!service.includes("choice_confirmation_followup_not_created"), "retired orphan confirmation follow-up state must be deleted");
assert(!service.includes("choice_confirmation_followup_recovered"), "retired confirmation follow-up recovery must be deleted");

assertIncludes("function mergeUserConfirmedEquipmentSections", "user-confirmed equipment must merge by structured sections");
assertIncludes("components", "user-confirmed equipment must support components");
assertIncludes("completed", "user-confirmed equipment must support completed items");
assertIncludes("artifacts", "user-confirmed equipment must support artifacts");
assertIncludes("emblems", "user-confirmed equipment must support emblems");
assertIncludes("changed_sections", "equipment updates must report changed sections only");

const explicitFollowupBody = functionBody("enqueueExplicitStructuredRuntimeEventFollowup");
assert(explicitFollowupBody.includes("structured_card_immutable_snapshot"), "structured card advice must create an immutable latest-fact snapshot");
assert(explicitFollowupBody.includes("captureResponseTaskOwner"), "structured card advice must capture canonical task ownership before execution");
assert(explicitFollowupBody.includes("runRuntimeEventAdvicePipelineInBackground"), "structured card advice owner must start the Host runtime-event pipeline");
assert(explicitFollowupBody.includes("setImmediate"), "structured card Host work must start asynchronously after canonical persistence");

const adviceRequestBody = functionBody("structuredDecisionAdviceRequested");
assert(adviceRequestBody.indexOf("payload.advice_action") < adviceRequestBody.indexOf("payload.request_advice"), "explicit whole-card advice action must outrank the boolean default");
const semanticCategories = new Set(modeContract.cruise_mode_policy.interrupt_policy.semantic_event_admission_policy.map((entry) => entry.category));
assert(semanticCategories.has("choice_advice") && semanticCategories.has("global_choice_advice"), "explicit card advice categories must be registered in the event inventory");
assert(modeContract.structured_card_lifecycle_policy?.observer_dedupe_policy?.includes("cannot emit or retry a sibling"), "mode contract must suppress observer duplicate answers");
assert(modeContract.structured_card_lifecycle_policy?.confirmation_response_policy?.includes("response_task null"), "mode contract must make final confirmation state-only");
assert(signatureContract.interaction_event_contract?.choice_card_final_confirmation?.strategy_answer_on_confirmation === false, "signature contract must forbid a confirmation-only strategy answer");
assert(signatureContract.interaction_event_contract?.choice_card_final_confirmation?.response_policy === "state_only_no_host_task", "signature contract must keep final confirmation out of the Host lane");

const fastGreetingBody = functionBody("runInitialCruiseGreeting");
assert(fastGreetingBody.includes("ready_without_automatic_answer"), "Start Match connection readiness must not create a non-checkpoint coaching answer");
assert(!fastGreetingBody.includes("state.response_task"), "initial cruise readiness must not occupy the Host answer owner");
assert(!service.includes("default_opening_posture"), "legacy generic opening coaching must be deleted instead of competing with fixed strategic checkpoints");

assert(!service.includes("shouldDeferOpeningOrVariableFollowupForChoiceConfirmation"), "retired opening Host follow-up gate must be deleted");
assert(!service.includes("deferred_to_2_1_choice_confirmation"), "retired opening Host retry reason must be deleted");

assertIncludes("user_visible_response: false", "standalone visual host outputs must be marked non-user-visible evidence");
assertIncludes("canonical_delivery_policy: \"visual_evidence_only_not_host_response\"", "visual evidence artifacts must not masquerade as standalone host responses");

assertIncludes("const LINEUP_HOST_COACH_PENDING_TIMEOUT_MS = Number(process.env.JCC_LINEUP_HOST_COACH_PENDING_TIMEOUT_MS || 300000);", "lineup host budget must allow 300000ms");
const timeoutBody = functionBody("hostCoachResponseTimeoutMs");
assert(timeoutBody.includes('task?.mode === "lineup_card"') && timeoutBody.includes("LINEUP_HOST_COACH_PENDING_TIMEOUT_MS"), "only lineup response tasks should use the 300000ms budget");
assert(timeoutBody.includes("MANUAL_CHOICE_HOST_PENDING_TIMEOUT_MS"), "choice/manual tactical budgets must remain separate");

assertIncludes("buildLineupPinnedResultInstructions", "lineup_card turn prompts must use the short canonical pinned_result instructions");
assertIncludes("lineup_handoff_instructions", "lineup_card current turn must carry minimal handoff instructions");
assertIncludes("lineupPinnedResultSchemaDiagnostics", "lineup-card materialization must retain concrete schema diagnostics");
assertIncludes('"lineup_card_not_publishable"', "lineup-card diagnostics must remain observable without a correction turn");

assertIncludes("runtimeEventIsRawMaterialFactEvent(event)", "ordinary fact updates must be blocked from directly starting host advice");

console.log(JSON.stringify({
  schema: "jcc-structured-card-backend-actions-verifier-v1",
  ok: true,
  checks: [
    "structured_backend_actions_exposed",
    "payload_binding_match_session_stage_kind_revision_report",
    "stale_candidate_report_rejected_and_final_confirm_identity_rebased_narrowly",
    "candidate_report_separate_from_final_selection",
    "state_only_card_confirmation",
    "card_confirmation_suppresses_semantic_observer_sibling",
    "shared_user_confirmed_equipment_section_merge",
    "structured_card_owner_starts_host_pipeline",
    "missing_payload_binding_rejected",
    "whole_card_advice_semantics_registered",
    "initial_connection_readiness_without_automatic_answer",
    "lineup_budget_300000_only",
    "lineup_turn_instruction_and_diagnostics",
    "ordinary_fact_updates_do_not_occupy_host_lane",
  ],
}, null, 2));
