import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import {
  collectRuntimeChoiceModeContracts,
  loadActiveRulesBundle,
} from "./jcc_active_rules_contract.mjs";
import {
  buildHostCoachInstructions,
  HOST_COACH_INSTRUCTION_CONTRACT_PATH,
  readHostCoachInstructionContract,
  REQUIRED_HOST_COACH_MODES,
  validateHostCoachInstructionContract,
} from "./jcc_host_coach_instruction_contract.mjs";

const root = path.resolve(import.meta.dirname, "..");
const contractPath = HOST_COACH_INSTRUCTION_CONTRACT_PATH;

function collectStrings(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStrings(entry, output);
  }
  return output;
}

function assertNoMatches(label, text, checks) {
  for (const check of checks) {
    const match = text.match(check.pattern);
    assert.equal(
      match,
      null,
      `${label} must not contain ${check.name}: ${match?.[0] || ""}`,
    );
  }
}

function assertProviderNeutral(label, text) {
  const providerPattern = /\b(?:codex|kimi|claude|openai|anthropic|gemini|google|moonshot|qwen|deepseek)\b/i;
  const match = text.match(providerPattern);
  assert.equal(match, null, `${label} must be provider-neutral: ${match?.[0] || ""}`);
}

const forbiddenRuntimeLiteralChecks = [
  { name: "major season literal", pattern: /\bs\d{1,3}\b/i },
  { name: "mode-season literal", pattern: /\bmode\d+\b/i },
  { name: "patch-like dotted numeric id", pattern: /\b\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/ },
  { name: "choice stage literal", pattern: /\b\d{1,2}-\d{1,2}\b/ },
];

const contract = await readHostCoachInstructionContract();
const rawContract = await readFile(contractPath, "utf8");
const runtimePaths = createRuntimePaths(root);
const activeRulesBundle = loadActiveRulesBundle({ repoRoot: root, runtimePaths });
const baseRules = activeRulesBundle.base_game_rules;
const activeSpecialRules = activeRulesBundle.season_special_rules;
const activeChoiceContracts = collectRuntimeChoiceModeContracts(activeRulesBundle);
const activeSpecialChoiceModes = activeChoiceContracts.filter((entry) => entry.source_layer === "season_special_rules");
const runtimeServiceSource = await readFile(path.resolve(root, "ui/electron/runtime-service.js"), "utf8");
const validation = validateHostCoachInstructionContract(contract);
assert.deepEqual(validation, { ok: true, errors: [] });

assert.equal(path.resolve(root, "data/runtime/jcc/host-coach-instruction-contract.json"), contractPath);
assert.equal(contract.provider_neutral, true);
assert.equal(contract.runtime_invariant, true);
assert.equal(contract.season_specific_content_allowed, false);
assert.equal(contract.patch_specific_content_allowed, false);
assert.equal(contract.hardcoded_choice_stage_literals_allowed, false);
for (const activeSpecialChoiceMode of activeSpecialChoiceModes) {
  assert.equal(contract.modes[activeSpecialChoiceMode.mode], undefined, `${activeSpecialChoiceMode.mode} must not live in the runtime-invariant contract`);
  assert.equal(contract.required_modes.includes(activeSpecialChoiceMode.mode), false, `${activeSpecialChoiceMode.mode} must not be a runtime-invariant required mode`);
  assert.equal(Object.hasOwn(baseRules.runtime_choice_modes || {}, activeSpecialChoiceMode.mode), false, `reusable base rules must not register season-only mode ${activeSpecialChoiceMode.mode}`);
  assert.equal(runtimeServiceSource.includes(`"${activeSpecialChoiceMode.mode}"`), false, `common runtime must register ${activeSpecialChoiceMode.mode} from active descriptors, not literals`);
  for (const field of ["intent_terms", "candidate_paths", "missing_selection_prompt_template"]) {
    assert(activeSpecialChoiceMode[field], `active season choice descriptor ${activeSpecialChoiceMode.mode} must own ${field}`);
  }
  assert.equal(activeSpecialChoiceMode.candidate_input_policy, "current_match_user_report", `active season choice descriptor ${activeSpecialChoiceMode.mode} must use current-match user reports`);
  assert.equal(activeSpecialChoiceMode.user_report_contract?.report_required_before_advice, true, `active season choice descriptor ${activeSpecialChoiceMode.mode} must require a report before advice`);
  assert.equal(activeSpecialChoiceMode.user_report_contract?.no_ocr_or_vision_fallback, true, `active season choice descriptor ${activeSpecialChoiceMode.mode} must reject OCR/vision fallback`);
  for (const legacyField of ["roi_tool", "ocr_worker_key", "ocr_worker_adapter", "vision_observation_field"]) {
    assert.equal(activeSpecialChoiceMode[legacyField], undefined, `active season user-report choice descriptor ${activeSpecialChoiceMode.mode} must not retain ${legacyField}`);
  }
}

for (const mode of REQUIRED_HOST_COACH_MODES) {
  assert(contract.required_modes.includes(mode), `required_modes must include ${mode}`);
  assert(contract.modes[mode], `modes must include ${mode}`);
  const instructions = buildHostCoachInstructions({ contract, mode });
  assert(instructions.length > 10, `${mode} must build a substantial instruction list`);
  assert(instructions.some((line) => line.includes(contract.modes[mode].title)), `${mode} instructions must include active mode title`);
}

const allContractText = collectStrings(contract).join("\n");
assertProviderNeutral("contract", allContractText);
assertNoMatches("contract", allContractText, forbiddenRuntimeLiteralChecks);
assertNoMatches("raw contract", rawContract, forbiddenRuntimeLiteralChecks);
assert(
  allContractText.includes("item_bench_candidates_fallback_only")
    && allContractText.includes("do not treat them as owned structured facts"),
  "canonical host instructions must permit only conditional use of fallback item candidates",
);

const neutralSignatureContract = {
  signatures: {
    cruise: {
      required_semantics: [
        "Use supplied proactive evidence only when it materially changes the answer.",
        "Do not repeat stale proactive advice.",
      ],
      output_fields: [
        "generated_by",
        "final_text",
        "recommended_action",
        "confidence",
      ],
    },
  },
};

const first = buildHostCoachInstructions({
  contract,
  mode: "cruise",
  signatureContract: neutralSignatureContract,
});
const second = buildHostCoachInstructions({
  contract,
  mode: "cruise",
  signatureContract: neutralSignatureContract,
});
assert.deepEqual(first, second, "builder output must be deterministic");
assert(first.some((line) => line.startsWith("Optional Signature Semantics:")), "builder must include optional signature semantics");
assert(first.some((line) => line.startsWith("Optional Signature Output Fields:")), "builder must include optional signature output fields");

const unknownMode = buildHostCoachInstructions({ contract, mode: "unknown_mode" });
assert(unknownMode.some((line) => line.includes(contract.default_mode.title)), "unknown mode must use default add-on");

for (const activeSpecialChoiceMode of activeSpecialChoiceModes) {
  const alias = Object.entries(activeSpecialRules.host_mode_aliases || {})
    .find(([, canonicalMode]) => canonicalMode === activeSpecialChoiceMode.mode)?.[0];
  const mode = alias || activeSpecialChoiceMode.mode;
  const activeSeasonInstructions = buildHostCoachInstructions({
    contract,
    mode,
    seasonModeAddons: activeSpecialRules.host_mode_addons,
    modeAliases: activeSpecialRules.host_mode_aliases,
  });
  const expectedTitle = activeSpecialRules.host_mode_addons?.[activeSpecialChoiceMode.mode]?.title;
  assert(expectedTitle, `active season mode ${activeSpecialChoiceMode.mode} must declare a host mode add-on title`);
  assert(
    activeSeasonInstructions.some((line) => line.includes(expectedTitle)),
    `active season rules must supply ${activeSpecialChoiceMode.mode} through the canonical builder`,
  );
  assert(
    activeSeasonInstructions.some((line) => line.includes("Current Turn Context:")),
    "season mode add-ons must append to, not replace, invariant current-turn instructions",
  );
}

const builtText = first.concat(unknownMode).join("\n");
assertProviderNeutral("built instructions", builtText);
assertNoMatches("built instructions", builtText, forbiddenRuntimeLiteralChecks);

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-host-coach-instruction-contract-verifier-v1",
  checked: [
    "schema_valid",
    "all_required_modes_present",
    "provider_neutral_contract",
    "runtime_invariant_contract",
    "no_major_season_literals",
    "no_patch_id_literals",
    "no_choice_stage_literals",
    "deterministic_builder_output",
    "optional_signature_contract_composition",
    "unknown_mode_default_addon",
    "active_season_mode_addons_are_season_scoped",
    "season_mode_alias_is_explicit",
    "season_choice_sensing_contract_is_not_hardcoded_in_common_runtime",
    "fallback_item_candidates_are_conditional_not_authoritative",
  ],
}, null, 2)}\n`);
