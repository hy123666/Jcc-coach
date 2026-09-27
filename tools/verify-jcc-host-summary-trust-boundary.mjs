import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const service = await readFile("ui/electron/runtime-service.js", "utf8");

function sliceFunction(name) {
  const start = service.indexOf(`function ${name}`);
  assert(start >= 0, `${name} must exist`);
  const next = service.indexOf("\nfunction ", start + 1);
  return service.slice(start, next >= 0 ? next : service.length);
}

const compactLiveState = sliceFunction("compactLiveStateForHost");
const compactBoard = sliceFunction("compactCurrentBoardForDecision");
const compactEquipment = sliceFunction("compactEquipmentForDecision");
const trustedEquipment = sliceFunction("firstTrustedMumu4356EquippedRows");
const itemSnapshot = sliceFunction("itemMaterialSnapshot");
const choiceSummary = sliceFunction("summarizeChoiceCandidatesForHost");
const hasEvidence = sliceFunction("hasStrategyEvidence");
const eventGate = sliceFunction("shouldStartAdviceForRuntimeEvent");
const mergeVisualSelfState = sliceFunction("mergeVisualSelfStateFields");
const pipeline = await readFile("tools/run-jcc-cruise-runtime-pipeline.mjs", "utf8");
function slicePipelineFunction(name) {
  const start = pipeline.indexOf(`function ${name}`);
  assert(start >= 0, `${name} must exist in pipeline`);
  const next = pipeline.indexOf("\nfunction ", start + 1);
  return pipeline.slice(start, next >= 0 ? next : pipeline.length);
}
const gatedOwnBoardUnits = slicePipelineFunction("gatedOwnBoardUnits");

assert(!compactLiveState.includes("liveState.board?.units"), "host summary must not promote generic board.units as own_board");
assert(!compactLiveState.includes("liveState.board?.board_units"), "host summary must not promote generic board.board_units as own_board");
assert(!compactLiveState.includes("liveState.board_units"), "host summary must not promote root board_units as own_board");

assert(!compactBoard.includes("liveStateSummary?.board?.units"), "decision board context must not use generic board.units");
assert(!compactBoard.includes("liveStateSummary?.board_units"), "decision board context must not use root board_units");

assert(
  gatedOwnBoardUnits.includes("if (genericRows && fieldStatusProvesSelfBoard(status))")
    && !/genericRows[\s\S]{0,220}rowsProveSelfBoard\(genericRows\)/.test(gatedOwnBoardUnits),
  "generic board.units/board.board_units must require the strong S=1 + fresh 4354 shop anchor field status",
);

assert(compactEquipment.includes("filter(isMumu4357ItemBenchFact)"), "item bench host context must filter to mumu_4357_item_bench facts");
assert(compactEquipment.includes("item_bench_candidates_fallback_only"), "icon item bench candidates must remain fallback-only evidence");
assert(compactEquipment.includes("firstTrustedMumu4356EquippedRows("), "equipped-item host context must use the shared trusted 4356 filter");
assert(trustedEquipment.includes("value.filter(isTrustedMumu4356EquippedFact)"), "the shared trusted 4356 filter must reject non-authoritative equipped-item facts");
const compactMatchFacts = sliceFunction("compactMatchFactsForTurn");
assert(compactMatchFacts.includes("liveStateOwnsHud"), "match facts projection must support live-state HUD ownership");

assert(itemSnapshot.includes("compactEquipmentForDecision("), "item material events must reuse the canonical equipment projection");
assert(compactEquipment.includes("firstTrustedMumu4356EquippedRows("), "item material events must use the shared trusted 4356 filter");

assert(!choiceSummary.includes("context.reward_choices"), "choice host context must not accept removed reward_choices as live candidates");
assert(choiceSummary.includes("runtimeChoiceModeContract(mode)"), "choice host context must resolve the active mode contract");
assert(choiceSummary.includes("host_context_choice_field"), "choice host context must read the contract-owned choice field");
assert(choiceSummary.includes("genericChoiceMatchesActiveMode"), "generic choice context must be rejected unless its mode or kind matches the active mode contract");
assert(choiceSummary.indexOf("...currentStructuredChoice") < choiceSummary.indexOf("mode,"), "canonical active mode must overwrite any mode carried by generic choice evidence");
assert(choiceSummary.includes("kind: choiceContract.kind"), "canonical active choice kind must overwrite stale generic evidence");
assert(hasEvidence.includes("summarizeChoiceCandidatesForHost(hostRequest)"), "strategy evidence detection must reuse gated choice summarization");
assert(!hasEvidence.includes("context.reward_choices"), "strategy evidence detection must not treat reward_choices as evidence");

assert(service.includes("AUTO_RUNTIME_EVENT_ADVICE_MIN_INTERVAL_MS"), "runtime event advice must have a global auto-advice minimum interval");
assert(eventGate.includes("runtime_event_global_cooldown"), "runtime event gate must reject events inside the global cooldown");
assert(eventGate.includes("state.runtime_event_advice?.last_started_at"), "runtime event global cooldown must use last_started_at");

assert(mergeVisualSelfState.includes("fill_missing_or_newer_phase_economy_from_self_state_roi"), "self-state OCR merge policy must fill missing fields or replace older base state");
assert(mergeVisualSelfState.includes("self_state_roi_ocr_does_not_replace_existing_structured_stage"), "self-state OCR must not replace an existing structured stage");
assert(mergeVisualSelfState.includes("self_state_roi_ocr_does_not_replace_existing_structured_economy"), "self-state OCR must not replace existing structured economy fields");
assert(mergeVisualSelfState.includes("overrode_older_base_stage_round"), "newer self-state OCR may replace stale base stage");
assert(mergeVisualSelfState.includes("overrode_older_base_economy_field"), "newer self-state OCR may replace stale base economy");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "host live-state summary trusts only promoted own_board fields",
    "host equipment summary separates primary 4357 and trusted 4356 from fallback evidence",
    "choice host summary ignores removed reward-choice/generic stale fields",
    "runtime event advice has a global anti-spam cooldown",
    "self-state ROI OCR only fills missing HUD fields and quarantines conflicting replacements",
  ],
}, null, 2));
