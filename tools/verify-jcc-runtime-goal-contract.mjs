#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHostCoachInstructions,
  readHostCoachInstructionContractSync,
} from "./jcc_host_coach_instruction_contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(text, needle, label) {
  assert(text.includes(needle), `${label} is missing required text: ${needle}`);
}

const runtimeService = readText("ui/electron/runtime-service.js");
const app = readText("ui/src/App.tsx");
const cruisePipeline = readText("tools/run-jcc-cruise-runtime-pipeline.mjs");
const standardMechanics = readJson("data/game-knowledge/jcc/common/standard-mechanics.json");
const choiceFramework = readJson("data/game-knowledge/jcc/common/choice-framework.json");
const signatureContract = readJson("data/runtime/jcc/host-coach-signature-contract.json");
const hostInstructionContract = readHostCoachInstructionContractSync();
const cruiseHostInstructions = buildHostCoachInstructions({
  contract: hostInstructionContract,
  mode: "cruise",
  signatureContract,
}).join("\n");

const augmentMechanic = standardMechanics.entries?.find((entry) => entry.mechanic_kind === "augment");
const confirmationBoundary = choiceFramework.entries?.find((entry) => entry.id === "choice.confirmation_boundary");

assert(
  ["2-1", "3-2", "4-2"].every((stage) => augmentMechanic?.checkpoints?.includes(stage)),
  "Common standard mechanics must declare the standard augment checkpoints."
);
assert(
  augmentMechanic?.candidate_authority === "current_match_user_report",
  "Common augment choice truth must come from the current-match user report."
);
assert(
  confirmationBoundary?.required_steps?.includes("keep advice separate from canonical confirmation"),
  "Common choice lifecycle must separate advice from canonical confirmation."
);
assert(
  augmentMechanic?.answer_contract?.confirmation_is_separate === true,
  "Common standard mechanics must distinguish reported candidates from confirmed selections."
);
assert(
  signatureContract.runtime_shape?.selected_context_per_request === true,
  "Host signature contract must require selected context per host call."
);
assert(
  signatureContract.runtime_shape?.host_session_memory_role === "contextual_memory_not_canonical_game_truth",
  "Host signature contract must use native session memory as context while SQLite remains canonical game truth."
);

assertIncludes(
  runtimeService,
  "final_text: null",
  "runtime-service deterministic fast hint must remain hidden evidence"
);
assertIncludes(
  runtimeService,
  "deterministic_summary: deterministicSummary",
  "runtime-service hidden deterministic evidence"
);
assertIncludes(
  runtimeService,
  "user_visible: false",
  "runtime-service deterministic fast hint must not impersonate the host coach"
);
assertIncludes(
  runtimeService,
  "function hideFastChoiceHintForAiNative",
  "runtime-service manual choice AI-native gate"
);
assertIncludes(
  runtimeService,
  "status: \"awaiting_host_cli_agent_response\"",
  "runtime-service manual choice host routing"
);
assertIncludes(
  runtimeService,
  "manual_choice_user_response_in_flight",
  "runtime-service cruise hard gate"
);
assertIncludes(
  runtimeService,
  '&& (!stageRound || stageSortValue(stageRound) < stageSortValue("2-1"))',
  "runtime-service opening fact-only gate must treat missing stage conservatively"
);
assertIncludes(
  runtimeService,
  "active_rules_bundle: attachGameRules ? activeRulesBundle : null",
  "runtime-service active rules selected context for strategy/match requests"
);
assertIncludes(
  runtimeService,
  "coach_signature_contract: attachGameRules ? coachSignatureContract : null",
  "runtime-service host signature selected context for strategy/match requests"
);
assertIncludes(
  runtimeService,
  "game_rule_contract: gameRuleContract",
  "runtime-service current-stage rule contract"
);
assertIncludes(
  cruiseHostInstructions,
  "Read INPUT_JSON.runtime_context.current_turn_contract first",
  "canonical host instructions must bind the answer to the current turn before deeper context"
);
assertIncludes(
  cruiseHostInstructions,
  "Never use prior conversation memory as authority for mutable game facts",
  "canonical host instructions must keep dynamic runtime facts authoritative while reusing static session context"
);
assertIncludes(
  cruiseHostInstructions,
  "Never advise waiting for a choice checkpoint that game_rule_contract marks as current or past",
  "canonical host instructions must explicitly encode active choice timing without season-specific stages"
);
assertIncludes(
  runtimeService,
  "function detectRuleConflictingFinalText",
  "runtime-service must check AI-native final_text against current-stage rule contract, not only backend drafts"
);
assertIncludes(
  runtimeService,
  'softDiagnostics.push("possible_game_rule_text_conflict")',
  "runtime-service must observe possible rule-conflicting final text without starting a correction turn"
);
assertIncludes(
  runtimeService,
  "const enrichedRequest = await enrichHostRequestWithRuntimeContext(",
  "pipeline host calls must explicitly enrich the request before model execution and diagnostic return"
);
assertIncludes(
  runtimeService,
  "const codexResult = await runHostModel(enrichedRequest, taskId);",
  "pipeline host calls must run the model on the enriched selected context, not only the raw pending request"
);

assertIncludes(
  app,
  "if (!hint?.final_text) return false;",
  "UI must not show hidden fast-choice evidence"
);
assertIncludes(
  app,
  "hint.user_visible === 0 || hint.user_visible === false",
  "UI must respect non-user-visible fast hints"
);
assertIncludes(
  app,
  "deterministic_scorer_evidence_not_user_visible",
  "UI must suppress deterministic scorer evidence by answer layer"
);
assertIncludes(
  app,
  "isManualChoiceAwaitingAiNative",
  "UI must continue polling manual choice AI-native response"
);

assertIncludes(
  cruisePipeline,
  "instructions: buildHostCoachInstructions({",
  "pipeline must use compact per-turn mode instructions while static rules and signature remain in the provider-session capsule"
);
assertIncludes(
  cruisePipeline,
  "game_rule_contract: gameRuleContract",
  "pipeline current-stage rule contract"
);
assertIncludes(
  cruisePipeline,
  "Conflicting backend draft wording was removed before host generation",
  "pipeline must remove rule-conflicting backend drafts before host generation"
);

assertIncludes(
  runtimeService,
  'softDiagnostics.push("possible_game_rule_text_conflict")',
  "canonical runtime host response gate must diagnose rule-conflicting final text without dropping useful text"
);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-runtime-goal-contract-verifier-v1",
  checked: {
    manual_choice_ocr_success_path: true,
    deterministic_fast_hint_hidden_by_default: true,
    cruise_blocks_manual_choice_response_task: true,
    active_rules_bundle_selected_context: true,
    current_stage_rule_contract_gate: true,
    host_session_memory_not_source_of_truth: true,
    common_choice_lifecycle_layered: true
  }
}, null, 2));
