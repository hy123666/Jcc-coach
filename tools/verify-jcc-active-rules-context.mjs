import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import {
  buildChoiceRuleCheckpointsFromLayers,
  collectRuntimeChoiceModeContracts,
  loadActiveRulesBundle,
  runtimeChoiceModeContract,
} from "./jcc_active_rules_contract.mjs";
import { textMentionsChoiceCheckpoint } from "./jcc_choice_checkpoint_contract.mjs";
import {
  buildHostCoachInstructions,
  readHostCoachInstructionContractSync,
} from "./jcc_host_coach_instruction_contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function read(relPath) {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

function readJson(relPath) {
  return JSON.parse(read(relPath).replace(/^\uFEFF/, ""));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(text, needle, message) {
  assert(text.includes(needle), `${message}\nMissing: ${needle}`);
}

function assertNotIncludes(text, needle, message) {
  assert(!text.includes(needle), `${message}\nUnexpected: ${needle}`);
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runHostCheckpointValidation(checkpoint, finalText) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-checkpoint-host-validation-"));
  try {
    const requestFile = path.join(tempDir, "request.json");
    const responseFile = path.join(tempDir, "response.json");
    const requestId = "verify-checkpoint-semantic-contract";
    const requestHash = "verify-checkpoint-semantic-contract-hash";
    await writeJson(requestFile, {
      type: "advice_response_requested",
      response_id: requestId,
      ai_native_policy: { output_model: "host_cli_main_model_required" },
      host_cli_agent_request: {
        request_id: requestId,
        request_hash: requestHash,
        mode: "cruise",
        context: {
          game_rule_contract: {
            past_choice_checkpoints: [checkpoint],
            current_choice_checkpoint: null,
          },
        },
      },
    });
    await writeJson(responseFile, {
      schema: "jcc-host-cli-coach-response-v1",
      generated_by: "current_cli_agent_main_model",
      request_id: requestId,
      request_hash: requestHash,
      final_text: finalText,
      confidence: "medium",
    });
    return spawnSync(process.execPath, [
      path.join(repoRoot, "tools", "run-jcc-host-coach-response.mjs"),
      "--request", requestFile,
      "--agent-response", responseFile,
    ], { cwd: repoRoot, encoding: "utf8" });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const runtimePaths = createRuntimePaths(repoRoot);
const bundle = loadActiveRulesBundle({ repoRoot, runtimePaths });
const baseRules = bundle.base_game_rules;
const normalRules = bundle.season_normal_rules;
const specialRules = bundle.season_special_rules;
const patchStrategy = bundle.patch_strategy_overrides;
const coachSignatureContract = readJson("data/runtime/jcc/host-coach-signature-contract.json");
const hostInstructionContract = readHostCoachInstructionContractSync();
const runtimeService = read("ui/electron/runtime-service.js");
const pipeline = read("tools/run-jcc-cruise-runtime-pipeline.mjs");
const contextPackBuilder = read("tools/build-jcc-host-agent-context-pack.mjs");
const activeRulesCompiler = read("tools/jcc_active_rules_contract.mjs");
const startMatchSession = read("tools/start-jcc-new-match-session.mjs");
const hostCoachResponseStart = runtimeService.indexOf("function detectRuleConflictingFinalText");
const hostCoachResponseEnd = runtimeService.indexOf("function keywordsToRegex", hostCoachResponseStart);
const hostCoachResponse = runtimeService.slice(hostCoachResponseStart, hostCoachResponseEnd);
const activeSeason = {
  season_id: bundle.version_identity?.runtime_season_id || null,
  active_patch_id: bundle.version_identity?.runtime_patch_id || null,
};

assert(baseRules.scope === "base_game", "base rules must remain reusable game doctrine");
assert(!Object.hasOwn(baseRules, "choice_mechanics"), "base rules must not own major-season choice timing");
assert(normalRules.scope === "season_normal" && normalRules.season_id === activeSeason.season_id, "normal rules must be keyed by the active major season");
assert(specialRules.scope === "season_special" && specialRules.season_id === activeSeason.season_id, "special rules must be keyed by the active major season");
assert(normalRules.patch_scope === "major_season_rules_not_patch_balance", "normal rules must reject patch balance ownership");
assert(specialRules.patch_scope === "major_season_rules_not_patch_balance", "special rules must reject patch balance ownership");
assert(!Object.hasOwn(normalRules, "economy_management_overrides"), "patch/meta economy strategy must not pollute major-season normal rules");
if (patchStrategy) {
  assert(patchStrategy.scope === "patch_strategy", "an active minor-patch strategy must remain a separate strategy layer");
  assert(patchStrategy.patch_id === activeSeason.active_patch_id, "patch strategy id must match the promoted active patch");
}
assert(bundle.schema === "jcc-runtime-active-rules-bundle-v2", "all consumers must receive the versioned active rules bundle");
assert(bundle.source_fingerprint?.length === 64, "active rule sources must have a deterministic fingerprint");
assert(bundle.version_identity?.runtime_season_id === activeSeason.season_id, "active rules must expose the promoted major-season identity");
assert(bundle.version_identity?.runtime_patch_id === activeSeason.active_patch_id, "active rules must expose the promoted minor-patch identity separately");
assert(bundle.coach_rules_brief?.schema === "jcc-runtime-coach-rules-brief-v2", "coach brief must be compiled by the shared rules compiler");
assert(
  (bundle.coach_rules_brief?.economy_management?.patch_strategy_schema || null)
    === (patchStrategy?.economy_management_overrides?.schema || null),
  "coach brief must identify an optional patch economy strategy without requiring one for every patch",
);
assert(baseRules.itemization_management?.schema === "jcc-itemization-management-base-v1", "base rules must own reusable itemization doctrine");
assert(bundle.coach_rules_brief?.itemization_management?.base_schema === "jcc-itemization-management-base-v1", "coach brief must compile reusable itemization doctrine");
assert(
  bundle.coach_rules_brief?.itemization_management?.active_season_interactions === null
    || typeof bundle.coach_rules_brief?.itemization_management?.active_season_interactions === "object",
  "coach brief must keep optional active-season itemization interactions separate from Common doctrine",
);
assert(bundle.coach_rules_brief?.itemization_management?.missing_information_policy?.never_wait_for_higher_or_lower_source === true, "compiled itemization doctrine must forbid waiting for another source");
const normalChoiceMechanics = normalRules.choice_mechanics || [];
const specialChoiceMechanics = specialRules.mechanics?.choice_mechanics || [];
const compiledChoiceMechanics = bundle.coach_rules_brief?.timing?.choice_mechanics || [];
const activeChoiceContracts = collectRuntimeChoiceModeContracts(bundle);
assert(compiledChoiceMechanics.length === normalChoiceMechanics.length + specialChoiceMechanics.length, "coach brief must expose every active major-season choice mechanic exactly once");
assert(compiledChoiceMechanics.every((entry) => Array.isArray(entry.stages) && entry.stages.length > 0), "compiled choice mechanics must retain data-driven timing");
assert(compiledChoiceMechanics.every((entry) => ["season_normal_rules", "season_special_rules"].includes(entry.source_layer)), "compiled choice mechanics must retain major-season source ownership");
assert(compiledChoiceMechanics.every((entry) => Array.isArray(entry.intent_terms) && entry.intent_terms.length > 0), "every active choice mechanic must declare intent_terms for season-neutral checkpoint validation");
const activeCheckpoints = buildChoiceRuleCheckpointsFromLayers({
  baseGameRules: baseRules,
  seasonNormalRules: normalRules,
  seasonSpecialRules: specialRules,
});
assert(activeCheckpoints.every((entry) => Array.isArray(entry.semantic_terms) && entry.semantic_terms.length > 0), "every compiled checkpoint must carry data-driven semantic terms");
const runtimeStyleCheckpoints = buildChoiceRuleCheckpointsFromLayers({
  seasonNormalRules: normalRules,
  seasonSpecialRules: specialRules,
});
assert(runtimeStyleCheckpoints.every((entry) => Array.isArray(entry.semantic_terms) && entry.semantic_terms.length > 0), "checkpoint compilation without reusable mode overlays must retain season-owned semantic terms");
const augmentCheckpoint = activeCheckpoints.find((entry) => entry.kind === "augment");
assert(augmentCheckpoint && textMentionsChoiceCheckpoint(`等${augmentCheckpoint.stage_round}强化出来后再决定`, augmentCheckpoint), "standard augment wording must remain recognized through active checkpoint terms");
for (const mechanic of specialChoiceMechanics) {
  const mechanicCheckpoint = activeCheckpoints.find((entry) => entry.mechanic_id === mechanic.mechanic_id);
  const semanticTerm = mechanic.intent_terms?.[0] || mechanic.label;
  assert(mechanicCheckpoint, `active special choice mechanic ${mechanic.mechanic_id} must compile a checkpoint`);
  assert(
    semanticTerm && textMentionsChoiceCheckpoint(`等${mechanicCheckpoint.stage_round}${semanticTerm}出来后再决定`, mechanicCheckpoint),
    `active special choice mechanic ${mechanic.mechanic_id} must be recognized through its declared semantic terms`,
  );
}
const futureCheckpoints = buildChoiceRuleCheckpointsFromLayers({
  seasonNormalRules: {
    choice_mechanics: [{
      mechanic_id: "rift_vote",
      kind: "rift",
      mode: "rift_vote",
      phase: "rift_vote",
      label: "rift vote",
      intent_terms: ["裂隙投票", "rift vote"],
      trigger_terms: ["rift_vote_advice"],
      aliases: ["rift ballot"],
      stages: ["2-4"],
    }],
  },
  seasonSpecialRules: { mechanics: {}, host_mode_aliases: {} },
});
assert(futureCheckpoints.length === 1 && futureCheckpoints[0].kind === "rift", "future-season fixture must compile only its declared choice mechanic");
assert(!futureCheckpoints.some((entry) => entry.kind === "god"), "future season without a star-god mechanic must not compile a star-god checkpoint");
assert(textMentionsChoiceCheckpoint("等2-4裂隙投票出来后再决定", futureCheckpoints[0]), "future-season checkpoint must use its declared intent terms");
assert(!textMentionsChoiceCheckpoint("等2-4星神出来后再决定", futureCheckpoints[0]), "future-season checkpoint must not inherit S17 star-god terms");

const rejectedFutureWait = await runHostCheckpointValidation(futureCheckpoints[0], "等2-4裂隙投票出来后再决定。");
assert(rejectedFutureWait.status === 0, "a readable answer with a possible rule conflict must be delivered instead of triggering another Provider turn");
const acceptedAbsentMechanicText = await runHostCheckpointValidation(futureCheckpoints[0], "等2-4星神出来后再决定。");
assert(acceptedAbsentMechanicText.status === 0, "Host validator must not apply an absent S17 mechanic to a future-season checkpoint");
assert(activeChoiceContracts === collectRuntimeChoiceModeContracts(bundle), "runtime choice descriptor compilation must be cached per immutable active-rules bundle");
assert(activeChoiceContracts.every((contract) => contract.advice_task_trigger_terms?.length && contract.visible_window_required_answer && contract.host_mode_context && contract.missing_selection_prompt_template), "every effective choice descriptor must carry routing, visible-answer, Host-context, and missing-selection contracts");
for (const invalidBundle of [null, {}, { base_game_rules: baseRules }]) {
  let failed = false;
  try {
    collectRuntimeChoiceModeContracts(invalidBundle);
  } catch {
    failed = true;
  }
  assert(failed, "runtime choice descriptor compilation must fail closed when the active-rules bundle is missing or incomplete");
}
for (const [alias, canonicalMode] of Object.entries(specialRules.host_mode_aliases || {})) {
  assert(runtimeChoiceModeContract(alias, bundle)?.mode === canonicalMode, `season mode alias ${alias} must resolve through the canonical descriptor compiler`);
}
for (const [label, hostModeAliases] of [
  ["undeclared target", { invalid_alias: "missing_choice_mode" }],
  ["alias cycle", { first_alias: "second_alias", second_alias: "first_alias" }],
]) {
  let failed = false;
  try {
    collectRuntimeChoiceModeContracts({
      ...bundle,
      season_special_rules: { ...specialRules, host_mode_aliases: hostModeAliases },
    });
  } catch {
    failed = true;
  }
  assert(failed, `runtime mode aliases must fail closed for ${label}`);
}
{
  const invalidBaseRules = structuredClone(baseRules);
  delete invalidBaseRules.runtime_choice_modes.augment_choice.missing_selection_prompt_template;
  let failed = false;
  try {
    collectRuntimeChoiceModeContracts({
      ...bundle,
      base_game_rules: invalidBaseRules,
    });
  } catch {
    failed = true;
  }
  assert(failed, "runtime choice descriptor compilation must fail when missing-selection behavior is undeclared");
}

assert(runtimePaths.seasonPatchStrategyFile.endsWith(path.join("seasons", activeSeason.season_id, "patches", activeSeason.active_patch_id, "strategy-overrides.json")), "runtime paths must resolve minor-patch strategy independently");
assert(!Object.hasOwn(runtimePaths, "legacySeasonNormalRuleFixtureFile"), "Runtime paths must not expose a legacy normal-rule fallback");
assert(!Object.hasOwn(runtimePaths, "legacySeasonSpecialRuleFixtureFile"), "Runtime paths must not expose a legacy special-rule fallback");
assert(runtimePaths.activePromotionTuple?.season_id === activeSeason.season_id, "runtime paths must expose the promoted atomic tuple");
assert(runtimePaths.activePromotionTuple?.active_patch_id === activeSeason.active_patch_id, "runtime paths must expose the promoted patch independently");

for (const [label, source] of [
  ["runtime service", runtimeService],
  ["cruise pipeline", pipeline],
  ["context pack", contextPackBuilder],
]) {
  assertIncludes(source, "loadActiveRulesBundle", `${label} must use the canonical active-rules compiler`);
  assertNotIncludes(source, "function buildCoachRulesBriefFromRules", `${label} must not keep a second coach-rules compiler`);
  assertNotIncludes(source, "season_normal_rules?.economy_management_overrides", `${label} must not read patch strategy from major-season normal rules`);
}

assertIncludes(runtimeService, "buildHostCoachInstructions", "runtime prompt must use the canonical host instruction builder");
assertIncludes(pipeline, "buildHostCoachInstructions", "pipeline request must use the canonical host instruction builder");
assertNotIncludes(runtimeService, "contractOrBriefMatchesCurrentStage", "runtime must not reuse caller-derived contracts on stage equality alone");
assertIncludes(runtimeService, "caller_supplied_derived_contract_reuse: false", "current-turn contract must declare caller-derived contracts non-authoritative");
assertIncludes(runtimeService, "runtime_rebuilt_per_host_call", "runtime must rebuild the current-turn contract for each host call");
assertIncludes(runtimeService, "rules_source_fingerprint", "runtime current-turn contract must bind the rule fingerprint");
assertIncludes(pipeline, "pipeline_rebuilt_for_current_advice_task", "pipeline must emit a task-scoped current-turn contract");
assertIncludes(runtimeService, "season_version_snapshot", "new matches must keep their season/version snapshot in canonical state");
assertIncludes(runtimeService, "matchSeasonSnapshotMatchesActiveRules", "runtime must fail closed on a mid-match active tuple mismatch");
assertIncludes(startMatchSession, "--season-snapshot-base64url", "Start Match child must require the caller-captured immutable snapshot");
assertIncludes(startMatchSession, "snapshot?.rules_source_fingerprint", "Start Match child must validate the captured rules fingerprint");
assertNotIncludes(startMatchSession, "loadActiveRulesBundle", "Start Match child must not re-resolve active rules after the boundary captures its snapshot");
assertNotIncludes(startMatchSession, "createRuntimePaths", "Start Match child must not re-resolve the active Core Profile pointer");
assertIncludes(runtimeService, "fingerprint === rulesBundle?.source_fingerprint", "runtime must fail closed on in-place rule drift during an active match");

const cruiseInstructions = buildHostCoachInstructions({ contract: hostInstructionContract, mode: "cruise" });
const lineupInstructions = buildHostCoachInstructions({ contract: hostInstructionContract, mode: "lineup_card" });
assert(cruiseInstructions.some((line) => line.includes("current_turn_contract")), "canonical instructions must make the model read the bound current turn first");
assert(cruiseInstructions.some((line) => line.includes("selected context")), "canonical instructions must make selected context authoritative");
assert(
  lineupInstructions.some((line) => line.includes("candidate_id") && line.includes("Runtime restores")),
  "lineup-card instructions must tell the Agent how to select evidence for Runtime materialization",
);
const invariantInstructions = JSON.stringify(hostInstructionContract);
assertNotIncludes(invariantInstructions.toLowerCase(), activeSeason.season_id.toLowerCase(), "runtime-invariant host instructions must not contain the active major-season id");
assertNotIncludes(invariantInstructions.toLowerCase(), activeSeason.active_patch_id.toLowerCase(), "runtime-invariant host instructions must not contain the active patch id");
assert(!/\b[1-9]-[1-9]\b/.test(invariantInstructions), "runtime-invariant host instructions must not hardcode game stages");
const invariantSignature = JSON.stringify(coachSignatureContract);
assertIncludes(invariantSignature, "the next user-owned advice or fixed strategic checkpoint absorbs", "common coach doctrine must document opening-variable absorption without creating a sibling answer");
for (const mechanic of specialChoiceMechanics) {
  assertNotIncludes(invariantSignature, mechanic.label, "runtime-invariant coach signature must not name an active major-season special mechanic");
  assertNotIncludes(pipeline, `\"${mechanic.mode}\"`, "common cruise routing must derive major-season special modes from active descriptors");
  assertNotIncludes(contextPackBuilder, `\"${mechanic.mode}\"`, "common context-pack builder must derive major-season special modes from active descriptors");
}

assertIncludes(activeRulesCompiler, "patch_strategy_overrides", "active rules compiler must preserve patch strategy provenance");
assertIncludes(activeRulesCompiler, "patch_rule_override_requires_explicit_declaration", "exceptional patch rule changes must be declared explicitly");
for (const mechanic of specialChoiceMechanics) {
  assertNotIncludes(activeRulesCompiler, mechanic.mechanic_id, "common active-rules compiler must not read a concrete major-season special mechanic id");
}
assertIncludes(hostCoachResponse, "function detectRuleConflictingFinalText", "host response merge must still validate final text against current rules");
assertIncludes(runtimeService, "possible_game_rule_text_conflict", "host response normalization must diagnose stale checkpoint advice without suppressing readable text");
assertNotIncludes(hostCoachResponse, 'kind === "augment"', "common Host response validation must not hardcode augment semantics");
assertNotIncludes(hostCoachResponse, 'kind === "god"', "common Host response validation must not hardcode S17 star-god semantics");
assertNotIncludes(pipeline, 'checkpoint.kind === "augment"', "common pipeline validation must not hardcode augment semantics");
assertNotIncludes(pipeline, 'checkpoint.kind === "god"', "common pipeline validation must not hardcode S17 star-god semantics");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-active-rules-context-verifier-v2",
  checked: [
    "base_major_season_minor_patch_layers_are_separate",
    "shared_active_rules_compiler_has_one_owner",
    "provider_neutral_host_instruction_builder_has_one_owner",
    "current_turn_contract_is_rebuilt_and_fingerprinted",
    "caller_stage_only_contract_reuse_removed",
    "new_match_version_snapshot_and_mid_match_mismatch_guard",
    "lineup_and_response_rule_contracts_preserved",
    "checkpoint_semantics_are_data_driven_across_major_seasons",
    "future_season_without_star_god_does_not_inherit_star_god_validation",
  ],
}, null, 2));
