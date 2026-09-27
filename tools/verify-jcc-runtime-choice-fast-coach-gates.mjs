import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function text(file) {
  return readFile(file, "utf8");
}

async function json(file) {
  return JSON.parse(await text(file));
}

function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `${label} missing start marker ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `${label} missing end marker ${endNeedle}`);
  return source.slice(start, end);
}

const [uiContract, service, bridge, app, decisionCard] = await Promise.all([
  json("data/runtime/jcc/runtime-ui-mode-contract.json"),
  text("ui/electron/runtime-service.js"),
  text("ui/src/runtimeBridge.ts"),
  text("ui/src/App.tsx"),
  text("ui/src/components/DecisionInputCard.tsx"),
]);

const activeChoiceContracts = [
  { mode: "augment_choice", contract: uiContract.modes?.augment_choice?.choice_poll_policy },
  { mode: "item_choice", contract: uiContract.modes?.item_choice?.choice_poll_policy },
].filter(Boolean);

assert.equal(activeChoiceContracts.length, 2, "common augment and item choice contracts must exist");
for (const { mode, contract } of activeChoiceContracts) {
  assert(contract, `${mode} active rules contract must exist`);
  assert.equal(contract.candidate_input_policy, "current_match_user_report", `${mode} must use current-match user reports`);
  assert.equal(contract.user_report_contract?.report_required_before_advice, true, `${mode} must require candidates before advice`);
  assert.equal(contract.user_report_contract?.current_match_only, true, `${mode} reports must be match-scoped`);
  assert.equal(contract.user_report_contract?.no_ocr_or_vision_fallback, true, `${mode} must not use OCR or vision fallback`);
  assert(contract.user_report_contract?.report_prompt, `${mode} must provide composer guidance`);
  assert(contract.user_report_contract?.refresh_report_prefix, `${mode} must provide a refresh-report prefix`);
  for (const removedField of ["roi_tool", "ocr_worker_key", "ocr_worker_adapter", "vision_observation_field"]) {
    assert.equal(contract[removedField], undefined, `${mode} must not retain active choice OCR field ${removedField}`);
  }
  const uiMode = uiContract.modes?.[mode];
  assert.equal(uiMode?.choice_poll_policy?.candidate_input_policy, "current_match_user_report", `${mode} UI contract must match active rules`);
  assert.equal(uiMode?.choice_poll_policy?.user_report_contract?.no_ocr_or_vision_fallback, true, `${mode} UI contract must reject OCR/vision fallback`);
}

assert(service.includes("const choiceVisualRuntimeModes = new Set();"), "active product choice visual mode set must remain empty");
assert(service.includes("const manualReportChoiceRuntimeModes = new Set();"), "runtime must maintain a descriptor-driven user-report choice set");
assert(service.includes('status: "mode_set_choice_ready_for_user_report"'), "mode entry must wait for the user report without starting sensing");
assert(service.includes("buildUserReportedChoiceSet"), "runtime must normalize the reported choice set");
assert(service.includes("currentUserReportedChoiceSetForAdvice"), "Host advice must consume the latest valid reported set");
assert(service.includes("choice_set_revision"), "refresh reports must create a revisioned current choice set");

const phaseTrigger = sliceBetween(
  service,
  "async function maybeHandleRuntimePhaseTrigger",
  "async function runPipelineForMessage",
  "phase trigger",
);
assert(phaseTrigger.includes("manualReportChoiceRuntimeModes.has(trigger.mode)"), "choice stage trigger must recognize user-report modes");
assert(phaseTrigger.indexOf("manualReportChoiceRuntimeModes.has(trigger.mode)") < phaseTrigger.indexOf("ENABLE_STAGE_CHOICE_AUTO_SENSING"), "user-report modes must return before compatibility sensing can run");

assert(
  bridge.includes("cardReportPolicy")
  && bridge.includes("decisionStages")
  && bridge.includes("candidateCountsByKind")
  && bridge.includes("requiredCandidateFields"),
  "renderer bridge must project the descriptor-owned structured-card contract",
);
assert(
  app.includes("activeMatchModeDescriptor?.manualChoice && activeMatchModeDescriptor.cardType"),
  "all descriptor-declared choice modes must open the structured card without season-specific UI branches",
);
assert(app.includes("structuredDecisionActive") && app.includes("!structuredDecisionActive"), "legacy composer presets must remain hidden while a structured decision card owns intake");
assert(decisionCard.includes("runtime.getDecisionInputOptions"), "structured card must load catalog-backed candidates and a payload binding");
assert(decisionCard.includes("runtime.submitDecisionInput"), "structured card must submit candidate/equipment deltas through one explicit action owner");
assert(decisionCard.includes("runtime.confirmDecisionSelection"), "structured card must expose a separate final confirmation action");
assert(decisionCard.includes("mode.refreshReportPrefix"), "refresh guidance must be descriptor-driven instead of a stale common copy string");
assert(decisionCard.includes("changedSlots") && decisionCard.includes("submitChoice"), "refresh workflow must preserve unchanged slots and wait for an explicit card submit");
assert(decisionCard.includes("mode.decisionStages"), "choice-stage tabs must come from common or active-season descriptors");
assert(!app.includes('activeMode === "god"') && !decisionCard.includes('mode.id === "god"'), "common UI must not hardcode an S17 choice branch");

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-runtime-choice-fast-coach-gates-v2",
  checked: [
    "current-match user report is the active candidate source",
    "active choice intake has no OCR or host-vision fallback",
    "mode entry waits for a report without opening sensing",
    "reported choice sets are match-scoped and revisioned",
    "structured card owns candidate intake, equipment deltas, advice, and final confirmation",
    "refresh edits preserve unchanged slots and require explicit resubmission",
    "choice stages and season-specific fields are descriptor-driven",
    "common UI remains season-neutral",
  ],
}, null, 2)}\n`);
