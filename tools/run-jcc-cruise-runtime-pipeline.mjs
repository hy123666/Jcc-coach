import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildContext } from "./build-jcc-combat-cap-estimator-context.mjs";
import {
  applyUserSettingsToTask,
  normalizeContext as normalizeStrategyContext,
  scoreLiveState,
} from "./score-jcc-cruise-strategy.mjs";
import { renderJccLineupTextBoard } from "./render-jcc-lineup-text-board.mjs";
import { buildLevelingEconomyContext } from "./build-jcc-leveling-economy-context.mjs";
import { buildLineupLifecycleContext } from "./build-jcc-lineup-lifecycle-context.mjs";
import { buildStrategyTables } from "./build-jcc-strategy-tables.mjs";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { resolveEquipmentFactLayers } from "../ui/electron/runtime-equipment-context.js";
import {
  buildChoiceRuleCheckpointsFromLayers,
  collectRuntimeChoiceModeContracts,
  loadActiveRulesBundle,
  resolveRuntimeModeAlias,
  runtimeChoiceModeContract,
} from "./jcc_active_rules_contract.mjs";
import { textMentionsChoiceCheckpoint } from "./jcc_choice_checkpoint_contract.mjs";
import { cruiseCheckpointForStage } from "../ui/electron/cruise-checkpoint-agenda.js";
import {
  classifyPersistedTargetPlanAuthority,
  normalizeTargetContextAuthority,
} from "../ui/electron/target-context-resolver.js";
import {
  buildHostCoachInstructions,
  readHostCoachInstructionContractSync,
} from "./jcc_host_coach_instruction_contract.mjs";
import { compactMatureRecipeVariantPacket } from "./jcc_mature_recipe_variant_packet.mjs";
import {
  boundedCandidateWorkingSet,
  candidateIdentityKey,
  candidateWorkingSetLimitForStrategic,
  candidateWorkingSetLimitForDisplay,
  dedupeCandidateWorkingSet,
  selectCandidateWorkingSetForDurableTarget,
} from "./jcc-candidate-working-set.mjs";
import {
  HOST_TURN_DELTA_TARGET_BYTES,
  HOST_TURN_DELTA_ABSOLUTE_MAX_BYTES,
  HOST_STRATEGIC_TURN_DELTA_TARGET_BYTES,
  HOST_STRATEGIC_TURN_DELTA_ABSOLUTE_MAX_BYTES,
} from "../ui/electron/jcc-host-budget-contract.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
let runtimePaths = createRuntimePaths(repoRoot);
const runtimeStrategyTablesByCoreProfileId = new Map();
const COACH_SIGNATURE_CONTRACT = "data/runtime/jcc/host-coach-signature-contract.json";
const INVARIANT_RUNTIME_MODES = [
  "cruise",
  "refresh_self_state",
  "daily_chat",
  "strategy_wiki",
  "lineup_card",
];
const DEFAULT_TASK_TTL_SECONDS_BY_PRIORITY = {
  high: 45,
  medium: 30,
  low: 18,
};
const PRIORITY_RANK = {
  low: 1,
  medium: 2,
  high: 3,
};
const RESPONSE_REQUEST_COOLDOWN_SECONDS = 20;
const BACKGROUND_TRIGGER_COOLDOWN_SECONDS = 45;
const DATA_SOURCE_CONTRACT = {
  mumu_bridge: {
    fields: ["own_board.units", "own_bench.units", "shop.units", "phase.status", "phase.stage_round"],
    confidence_floor_for_strong_advice: 0.82,
  },
  host_multimodal_visual: {
    fields: ["non_choice_screen_context", "conditional_equipment_context_evidence"],
    confidence_floor_for_strong_advice: 0.76,
  },
  mumu_4357_item_bench: {
    fields: ["items.item_bench"],
    confidence_floor_for_strong_advice: 0.9,
  },
  left_item_rail_roi_icon: {
    fields: ["items.item_bench_candidates"],
    confidence_floor_for_strong_advice: 0.62,
  },
  mumu_4356_equipment_to_4353_own_unit: {
    fields: ["items.equipped_items"],
    confidence_floor_for_strong_advice: 0.86,
  },
  economy_small_roi_interim: {
    fields: ["economy.gold", "economy.hp", "economy.level", "economy.xp"],
    confidence_floor_for_strong_advice: 0.68,
  },
  user_confirmed: {
    fields: ["match_variables.*", "target_plan", "user_preferences"],
    confidence_floor_for_strong_advice: 0.9,
  },
};

function readRuntimeRuleFile(file, fallback = null) {
  if (!file || !existsSync(file)) {
    if (fallback !== null) return fallback;
    throw new Error(`Required JCC runtime rule file is missing: ${file}`);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (fallback !== null) return fallback;
    throw new Error(`Required JCC runtime rule file is invalid: ${file}: ${error.message || String(error)}`);
  }
}

function strategyTablesForRuntimeProfile(profilePaths = runtimePaths) {
  const coreProfileId = String(profilePaths?.activeCoreProfileId || "").trim();
  if (!/^[a-f0-9]{64}$/.test(coreProfileId)) {
    throw new Error("Strategy tables require a valid captured core_profile_id");
  }
  if (!runtimeStrategyTablesByCoreProfileId.has(coreProfileId)) {
    runtimeStrategyTablesByCoreProfileId.set(coreProfileId, buildStrategyTables({
      mumu_catalog_overlay: readRuntimeRuleFile(profilePaths.activeRuntimeCatalogOverlayFile, {}),
      semantic_feature_index: readRuntimeRuleFile(profilePaths.activeSemanticFeatureIndexFile, {}),
    }));
  }
  return runtimeStrategyTablesByCoreProfileId.get(coreProfileId);
}

function buildActiveRulesBundle() {
  return loadActiveRulesBundle({ repoRoot, runtimePaths });
}

let ACTIVE_RULES_BUNDLE = buildActiveRulesBundle();
let CRUISE_RUNTIME_PROFILE_CONTEXT = null;
let runtimeStrategyTables = strategyTablesForRuntimeProfile(runtimePaths);
let ACTIVE_CHOICE_MODE_CONTRACTS = collectRuntimeChoiceModeContracts(ACTIVE_RULES_BUNDLE);
const SPECIALIZED_BASE_CHOICE_MODES = new Set(["augment_choice", "item_choice"]);
let ACTIVE_SEASON_CHOICE_MODE_CONTRACTS = ACTIVE_CHOICE_MODE_CONTRACTS
  .filter((contract) => !SPECIALIZED_BASE_CHOICE_MODES.has(contract.mode));
let ACTIVE_CHOICE_EVIDENCE_TYPES = new Set(
  ACTIVE_CHOICE_MODE_CONTRACTS.flatMap((contract) => [
    ...(contract.candidate_paths || []),
    ...(contract.task_candidate_evidence_types || []),
  ]),
);
let SUPPORTED_RUNTIME_MODES = new Set([
  ...INVARIANT_RUNTIME_MODES,
  ...ACTIVE_CHOICE_MODE_CONTRACTS.map((contract) => contract.mode),
  ...Object.keys(ACTIVE_RULES_BUNDLE.season_special_rules?.host_mode_aliases || {}),
]);
const COACH_SIGNATURE_CONTRACT_DATA = readRuntimeRuleFile(path.join(repoRoot, COACH_SIGNATURE_CONTRACT), null);
const HOST_COACH_INSTRUCTION_CONTRACT = readHostCoachInstructionContractSync();

function buildCruiseRuntimeProfileContext(profilePaths = runtimePaths, rulesBundle = ACTIVE_RULES_BUNDLE) {
  const coreProfileId = String(profilePaths.activeCoreProfileId || "").trim();
  if (!/^[a-f0-9]{64}$/.test(coreProfileId)) {
    throw new Error("Cruise Runtime Profile requires a valid captured core_profile_id");
  }
  if (!profilePaths.activeHardDataManifest || !rulesBundle?.base_game_rules) {
    throw new Error("Cruise Runtime Profile requires captured hard-data and base-game rules");
  }
  const rulesProfileId = String(rulesBundle?.rules_status?.core_profile_id || "").trim();
  if (rulesProfileId && rulesProfileId !== coreProfileId) {
    throw new Error(`Cruise Runtime Profile rules ${rulesProfileId} do not match captured Core Profile ${coreProfileId}`);
  }
  if (
    rulesBundle?.version_identity?.runtime_season_id
    && rulesBundle.version_identity.runtime_season_id !== profilePaths.activeSeasonId
  ) {
    throw new Error("Cruise Runtime Profile rules season does not match captured Runtime paths");
  }
  if (
    rulesBundle?.version_identity?.runtime_patch_id
    && rulesBundle.version_identity.runtime_patch_id !== profilePaths.activePatchId
  ) {
    throw new Error("Cruise Runtime Profile rules patch does not match captured Runtime paths");
  }
  return Object.freeze({
    core_profile_id: coreProfileId,
    hard_data_manifest: profilePaths.activeHardDataManifest,
    rules_source_fingerprint: rulesBundle.source_fingerprint || null,
    base_game_rules: rulesBundle.base_game_rules,
    semantic_feature_index: profilePaths.activeSemanticFeatureIndexFile,
    source: "configureCruiseRuntimeProfile",
  });
}

CRUISE_RUNTIME_PROFILE_CONTEXT = buildCruiseRuntimeProfileContext();

export function configureCruiseRuntimeProfile({ nextRuntimePaths = null, rulesBundle = null } = {}) {
  const configuredPaths = nextRuntimePaths || runtimePaths;
  const configuredRules = rulesBundle || loadActiveRulesBundle({ repoRoot, runtimePaths: configuredPaths });
  const configuredProfileContext = buildCruiseRuntimeProfileContext(configuredPaths, configuredRules);
  const configuredChoiceModeContracts = collectRuntimeChoiceModeContracts(configuredRules);
  const configuredSeasonChoiceModeContracts = configuredChoiceModeContracts
    .filter((contract) => !SPECIALIZED_BASE_CHOICE_MODES.has(contract.mode));
  const configuredChoiceEvidenceTypes = new Set(
    configuredChoiceModeContracts.flatMap((contract) => [
      ...(contract.candidate_paths || []),
      ...(contract.task_candidate_evidence_types || []),
    ]),
  );
  const configuredRuntimeModes = new Set([
    ...INVARIANT_RUNTIME_MODES,
    ...configuredChoiceModeContracts.map((contract) => contract.mode),
    ...Object.keys(configuredRules.season_special_rules?.host_mode_aliases || {}),
  ]);
  const configuredStrategyTables = strategyTablesForRuntimeProfile(configuredPaths);

  runtimePaths = configuredPaths;
  ACTIVE_RULES_BUNDLE = configuredRules;
  ACTIVE_CHOICE_MODE_CONTRACTS = configuredChoiceModeContracts;
  ACTIVE_SEASON_CHOICE_MODE_CONTRACTS = configuredSeasonChoiceModeContracts;
  ACTIVE_CHOICE_EVIDENCE_TYPES = configuredChoiceEvidenceTypes;
  SUPPORTED_RUNTIME_MODES = configuredRuntimeModes;
  runtimeStrategyTables = configuredStrategyTables;
  CRUISE_RUNTIME_PROFILE_CONTEXT = configuredProfileContext;
  return {
    core_profile_id: CRUISE_RUNTIME_PROFILE_CONTEXT.core_profile_id,
    rules_source_fingerprint: ACTIVE_RULES_BUNDLE.source_fingerprint || null,
  };
}

function normalizeStageRound(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "value")
    ? value.value
    : value;
  if (typeof raw === "string") {
    const match = raw.match(/(\d+)\s*[-_/]\s*(\d+)/);
    if (match) return `${Number(match[1])}-${Number(match[2])}`;
    return raw.trim() || null;
  }
  return null;
}

function stageSortValue(stageRound) {
  const normalized = normalizeStageRound(stageRound);
  if (!normalized) return null;
  const [stage, round] = normalized.split("-").map(Number);
  if (!Number.isFinite(stage) || !Number.isFinite(round)) return null;
  return stage * 100 + round;
}

function stageIsAtOrAfter(stageRound, expectedStageRound) {
  const current = stageSortValue(stageRound);
  const expected = stageSortValue(expectedStageRound);
  return Number.isFinite(current) && Number.isFinite(expected) && current >= expected;
}

function stageProtocolForRange(protocols, stageRound) {
  const current = normalizeStageRound(stageRound);
  if (!current || !protocols || typeof protocols !== "object") return null;
  if (protocols[current]) return protocols[current];
  for (const [key, protocol] of Object.entries(protocols)) {
    const [start, end] = String(key).split("_to_").map((value) => normalizeStageRound(value));
    if (!start || !end) continue;
    if (stageSortValue(current) >= stageSortValue(start) && stageSortValue(current) <= stageSortValue(end)) {
      return protocol;
    }
  }
  return null;
}

function activeChoiceCheckpoints(rulesBundle = ACTIVE_RULES_BUNDLE) {
  return buildChoiceRuleCheckpointsFromLayers({
    baseGameRules: rulesBundle?.base_game_rules,
    seasonNormalRules: rulesBundle?.season_normal_rules,
    seasonSpecialRules: rulesBundle?.season_special_rules,
  })
    .map((entry) => ({ ...entry, stage_round: normalizeStageRound(entry.stage_round) }))
    .filter((entry) => entry.stage_round)
    .sort((left, right) => stageSortValue(left.stage_round) - stageSortValue(right.stage_round));
}

function valueAtPath(root, fieldPath) {
  let value = root;
  for (const segment of String(fieldPath || "").split(".").filter(Boolean)) value = value?.[segment];
  return value;
}

function choiceCandidatesAtPath(root, fieldPath) {
  return choiceSetChoices(valueAtPath(root, fieldPath));
}

function currentMatchUserReportedChoiceSet(matchContext, mode, activeMatchSessionId = null) {
  const choiceSet = matchContext?.reported_choice_sets_by_mode?.[mode] || null;
  if (!choiceSet || choiceSet.source !== "current_match_user_report") return null;
  if (
    activeMatchSessionId
    && choiceSet.match_session_id
    && String(choiceSet.match_session_id) !== String(activeMatchSessionId)
  ) return null;
  const candidates = choiceSetChoices(choiceSet.candidates);
  const expectedCount = Math.max(0, Number(choiceSet.expected_candidate_count || 0) || 0);
  if (!candidates.length || (expectedCount && candidates.length < expectedCount)) return null;
  return { ...choiceSet, candidates };
}

function visibleCandidatesForContract(standardizedLiveState, contract, matchContext = null) {
  if (contract?.candidate_input_policy === "current_match_user_report") {
    const choiceSet = currentMatchUserReportedChoiceSet(
      matchContext,
      contract.mode,
      standardizedLiveState?.match_session_id || null,
    );
    return choiceSet
      ? {
          candidates: choiceSet.candidates,
          field_path: `match_context.reported_choice_sets_by_mode.${contract.mode}.candidates`,
          choice_set: choiceSet,
        }
      : { candidates: [], field_path: null, choice_set: null };
  }
  const candidateRoot = matchContext ? { ...standardizedLiveState, match_context: matchContext } : standardizedLiveState;
  for (const fieldPath of contract?.candidate_paths || []) {
    const candidates = choiceCandidatesAtPath(candidateRoot, fieldPath);
    if (candidates.length) return { candidates, field_path: fieldPath, choice_set: null };
  }
  return { candidates: [], field_path: null, choice_set: null };
}

function choiceConfirmedInLifecycle(matchContext, kind, stageRound) {
  const normalizedStage = normalizeStageRound(stageRound);
  return asArray(matchContext?.choice_confirmations).some((entry) =>
    entry?.kind === kind
    && normalizeStageRound(entry.choice_stage_round) === normalizedStage
    && String(entry.choice || entry.selected || "").trim()
  );
}

function userReportedChoiceOptionsFromLifecycle(matchContext, kind, stageRound) {
  const normalizedStage = normalizeStageRound(stageRound);
  const contract = ACTIVE_CHOICE_MODE_CONTRACTS.find((entry) => entry.kind === kind) || null;
  if (!contract) return null;
  const choiceSet = currentMatchUserReportedChoiceSet(matchContext, contract.mode, null);
  if (!choiceSet) return null;
  const reportedStage = normalizeStageRound(choiceSet.choice_stage_round);
  if (normalizedStage && reportedStage && normalizedStage !== reportedStage) return null;
  return choiceSet;
}

function visibleChoiceWindowFromLiveState(standardizedLiveState, lifecycle = {}) {
  const requestedMode = resolveRuntimeModeAlias(lifecycle?.mode || "cruise", ACTIVE_RULES_BUNDLE);
  const orderedContracts = [
    ...ACTIVE_CHOICE_MODE_CONTRACTS.filter((contract) => contract.mode === requestedMode),
    ...ACTIVE_CHOICE_MODE_CONTRACTS.filter((contract) => contract.mode !== requestedMode),
  ];
  for (const contract of orderedContracts) {
    const visible = visibleCandidatesForContract(standardizedLiveState, contract, lifecycle?.match_context || null);
    if (!visible.candidates.length) continue;
    if (contract.mode !== requestedMode && visible.candidates.length < 2) continue;
    return {
      kind: contract.kind,
      mode: contract.mode,
      phase: contract.phase,
      stage_round: normalizeStageRound(standardizedLiveState?.phase?.stage_round?.value),
      label: `visible ${contract.label} window`,
      source: visible.field_path,
      candidate_count: visible.candidates.length,
      observed_options: visible.candidates.slice(0, 6),
      required_answer: contract.visible_window_required_answer,
    };
  }
  return null;
}

function buildGameRuleContract(standardizedLiveState, lifecycle) {
  const currentStage = normalizeStageRound(standardizedLiveState?.phase?.stage_round?.value);
  const matchContext = lifecycle?.match_context || {};
  const checkpoints = activeChoiceCheckpoints(ACTIVE_RULES_BUNDLE);
  const passedOrCurrent = checkpoints.filter((entry) => currentStage && stageIsAtOrAfter(currentStage, entry.stage_round));
  const visibleChoiceWindow = visibleChoiceWindowFromLiveState(standardizedLiveState, lifecycle);
  const unknownFinalChoices = passedOrCurrent
    .filter((entry) => !choiceConfirmedInLifecycle(matchContext, entry.kind, entry.stage_round))
    .map((entry) => ({
      ...entry,
      observed_options: userReportedChoiceOptionsFromLifecycle(matchContext, entry.kind, entry.stage_round) || null,
    }));
  const activeChoiceStages = checkpoints.reduce((output, entry) => {
    if (!output[entry.kind]) output[entry.kind] = [];
    output[entry.kind].push(entry.stage_round);
    return output;
  }, {});
  return {
    schema: "jcc-game-rule-contract-v1",
    stage_round: currentStage || null,
    rule_sources: ACTIVE_RULES_BUNDLE.source_files,
    active_choice_checkpoints: checkpoints,
    active_choice_stages: activeChoiceStages,
    visible_choice_window: visibleChoiceWindow,
    current_choice_checkpoint: checkpoints.find((entry) => currentStage === entry.stage_round) || null,
    past_choice_checkpoints: passedOrCurrent.filter((entry) => currentStage !== entry.stage_round),
    unknown_final_choices: unknownFinalChoices,
    must: [
      "Treat this game_rule_contract as hard constraints for this answer.",
      "Use confirmed match choices when present. Current-match user reports are candidate sets, not final selections.",
      ...(visibleChoiceWindow ? [
        `A ${visibleChoiceWindow.label} was reported for this match. Answer that choice directly from the reported candidates even if HUD stage_round is missing.`,
      ] : []),
      "If a past choice checkpoint has no confirmed final selection, state it is unknown or ask the user instead of guessing.",
      "Latest match user intent and choice confirmations override older conflicting context.",
    ],
    must_not: [
      "Do not tell the user to wait for a choice checkpoint that is current or already past.",
      ...passedOrCurrent.map((entry) => `Do not say to wait for ${entry.stage_round} ${entry.kind}; that checkpoint is current or already past.`),
      ...(visibleChoiceWindow ? [
        `Do not answer the visible ${choiceKindLabel(visibleChoiceWindow)} with generic transition, economy, or wait-for-later advice.`,
      ] : []),
      "Do not treat user-reported candidate options as a final selected choice.",
    ],
  };
}

function choiceKindLabel(choice) {
  if (choice && typeof choice === "object") return choice.choice_label || choice.label || choice.kind || "choice";
  return choice || "choice";
}

function choiceOptionNames(observedOptions) {
  const candidates = Array.isArray(observedOptions)
    ? observedOptions
    : observedOptions?.choices
      || observedOptions?.options
      || observedOptions?.choice_candidates
      || observedOptions?.candidates
      || [];
  return asArray(candidates)
    .map((entry) => String(entry?.name || entry?.text || entry?.raw_text || entry?.label || entry || "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function latestMatchUserIntent(matchContext) {
  const messages = asArray(matchContext?.recent_user_messages);
  const latest = [...messages].reverse().find((entry) => String(entry?.text || entry || "").trim());
  if (!latest) return null;
  return {
    text: String(latest.text || latest).trim(),
    mode: latest.mode || null,
    observed_at: latest.observed_at || latest.at || null,
  };
}

function buildCurrentStageRuleSemantics({ gameRuleContract, unknownChoices = [] } = {}) {
  const stageRound = normalizeStageRound(gameRuleContract?.stage_round);
  const visibleChoiceWindow = gameRuleContract?.visible_choice_window || null;
  const lines = [];
  if (visibleChoiceWindow) {
    const optionText = choiceOptionNames(visibleChoiceWindow.observed_options);
    lines.push(`A ${visibleChoiceWindow.label} is visible now${optionText.length ? ` with candidates ${optionText.join(" / ")}` : ""}. Answer this choice directly; do not give generic cruise advice.`);
  }
  if (!stageRound) {
    lines.push(visibleChoiceWindow
      ? "HUD stage is unknown, but the visible choice window is current evidence and is enough to answer the user's choice question."
      : "Current stage is unknown; do not invent timing-sensitive advice.");
    return lines;
  }
  const currentCheckpoint = gameRuleContract?.current_choice_checkpoint || null;
  if (currentCheckpoint) {
    lines.push(`Current stage ${stageRound} is a ${choiceKindLabel(currentCheckpoint)} checkpoint. Answer choice questions now; do not say to wait for ${stageRound}.`);
  } else {
    lines.push(`Current stage is ${stageRound}. Use this stage before generic game memory.`);
  }
  for (const entry of asArray(gameRuleContract?.past_choice_checkpoints)) {
    lines.push(`${entry.stage_round} ${choiceKindLabel(entry)} checkpoint is already past; never tell the user to wait for it.`);
  }
  for (const entry of asArray(unknownChoices)) {
    const options = asArray(entry.observed_options).filter(Boolean);
    const optionText = options.length ? ` Observed candidates were ${options.join(" / ")}.` : "";
    lines.push(`Final selected ${choiceKindLabel(entry)} at ${entry.stage_round} is unknown.${optionText} If it affects advice, ask what was selected instead of guessing.`);
  }
  return uniqueStrings(lines);
}

function buildGameStateBrief(standardizedLiveState, lifecycle, gameRuleContract) {
  const currentStage = normalizeStageRound(standardizedLiveState?.phase?.stage_round?.value || gameRuleContract?.stage_round);
  const matchContext = lifecycle?.match_context || {};
  const currentCheckpoint = gameRuleContract?.current_choice_checkpoint || null;
  const pastCheckpoints = asArray(gameRuleContract?.past_choice_checkpoints);
  const unknownFinalChoices = asArray(gameRuleContract?.unknown_final_choices);
  const allCheckpoints = asArray(gameRuleContract?.active_choice_checkpoints)
    .filter((entry) => entry?.stage_round)
    .sort((left, right) => stageSortValue(left.stage_round) - stageSortValue(right.stage_round));
  const nextChoiceCheckpoint = allCheckpoints.find((entry) =>
    currentStage && stageSortValue(entry.stage_round) > stageSortValue(currentStage)
  ) || null;
  const unknownChoices = unknownFinalChoices.map((entry) => ({
    kind: entry.kind,
    label: choiceKindLabel(entry),
    stage_round: entry.stage_round,
    status: "final_selection_unknown",
    observed_options: choiceOptionNames(entry.observed_options),
  }));
  const currentStageRuleSemantics = buildCurrentStageRuleSemantics({
    gameRuleContract,
    unknownChoices,
  });
  const confirmedChoices = asArray(matchContext.choice_confirmations)
    .slice(-6)
    .map((entry) => ({
      kind: entry?.kind || null,
      stage_round: normalizeStageRound(entry?.choice_stage_round || entry?.stage_round),
      selected: entry?.choice || entry?.selected || null,
      observed_at: entry?.observed_at || entry?.confirmed_at || null,
    }))
    .filter((entry) => entry.kind && entry.stage_round && entry.selected);
  const blockedCheckpoints = [
    ...pastCheckpoints,
    currentCheckpoint,
  ].filter(Boolean);
  return {
    schema: "jcc-runtime-game-state-brief-v1",
    purpose: "Read this before drafting. It is the compact semantic state for this answer.",
    active_mode: lifecycle?.mode || "cruise",
    stage_round: currentStage || null,
    situation: currentCheckpoint
      ? `Currently at ${currentCheckpoint.stage_round} ${choiceKindLabel(currentCheckpoint)}.`
      : unknownChoices.length
        ? `After ${unknownChoices.at(-1).stage_round} ${unknownChoices.at(-1).label}; final selected choice is unknown.`
        : currentStage
          ? `Current stage is ${currentStage}.`
          : "Current stage is unknown.",
    current_choice_checkpoint: currentCheckpoint,
    visible_choice_window: gameRuleContract?.visible_choice_window || null,
    next_choice_checkpoint: nextChoiceCheckpoint,
    current_stage_rule_semantics: currentStageRuleSemantics,
    unknown_final_choices: unknownChoices,
    confirmed_choices: confirmedChoices,
    latest_user_intent: latestMatchUserIntent(matchContext),
    forbidden_waiting_for: blockedCheckpoints.map((entry) => ({
      kind: entry.kind,
      stage_round: entry.stage_round,
      reason: "choice checkpoint is current or already past",
    })),
    required_model_behavior: [
      "Use this brief before generic game knowledge.",
      "Use current_stage_rule_semantics as the plain-language meaning of the current stage.",
      "Do not say to wait for any checkpoint listed in forbidden_waiting_for.",
      "If an unknown_final_choice affects the answer, ask what the user selected instead of guessing.",
      "Latest user intent overrides older match intent unless the newest live_state clearly contradicts it.",
    ],
  };
}

function formatGameRuleBriefText({ gameStateBrief, gameRuleContract, coachRulesBrief, lifecycle }) {
  const lines = [
    "GAME_RULE_BRIEF:",
    `- current_stage: ${gameStateBrief?.stage_round || gameRuleContract?.stage_round || "unknown"}`,
  ];
  for (const mechanic of asArray(coachRulesBrief?.timing?.choice_mechanics)) {
    const mechanicId = safeText(mechanic?.mechanic_id || "choice").replace(/[^a-z0-9_]+/gi, "_");
    const stages = asArray(mechanic?.stages).filter(Boolean);
    if (stages.length) lines.push(`- ${mechanicId}_stages: ${stages.join(", ")}`);
  }
  if (gameStateBrief?.situation) lines.push(`- situation: ${gameStateBrief.situation}`);
  const visibleChoiceRequiredAnswer = safeText(gameRuleContract?.visible_choice_window?.required_answer);
  if (visibleChoiceRequiredAnswer) {
    lines.push(`- visible_choice_required_answer: ${visibleChoiceRequiredAnswer.slice(0, 220)}`);
  }
  const stageTask = coachRulesBrief?.stage_decision_tasks?.[gameStateBrief?.stage_round || gameRuleContract?.stage_round];
  if (stageTask) lines.push(`- current_stage_task: ${safeText(stageTask).slice(0, 260)}`);
  const stageProtocol = coachRulesBrief?.stage_strategy_protocol?.[gameStateBrief?.stage_round || gameRuleContract?.stage_round]
    || stageProtocolForRange(coachRulesBrief?.stage_strategy_protocol, gameStateBrief?.stage_round || gameRuleContract?.stage_round);
  if (stageProtocol) {
    if (stageProtocol.coach_goal) lines.push(`- current_stage_coach_goal: ${safeText(stageProtocol.coach_goal).slice(0, 220)}`);
    const mustConsider = asArray(stageProtocol.must_consider)
      .map((item) => safeText(item).slice(0, 60))
      .filter(Boolean)
      .slice(0, 8);
    if (mustConsider.length) lines.push(`- must_consider_now: ${mustConsider.join(", ")}`);
    if (stageProtocol.required_answer) lines.push(`- required_answer_now: ${safeText(stageProtocol.required_answer).slice(0, 180)}`);
    if (stageProtocol.missing_selection_policy) lines.push(`- missing_selection_policy: ${safeText(stageProtocol.missing_selection_policy).slice(0, 180)}`);
    const avoid = asArray(stageProtocol.avoid)
      .map((item) => safeText(item).slice(0, 70))
      .filter(Boolean);
    if (avoid.length) lines.push(`- avoid_now: ${avoid.join(", ")}`);
  }
  const contextPriority = asArray(coachRulesBrief?.decision_model?.context_priority)
    .map((item) => safeText(item).slice(0, 80))
    .filter(Boolean)
    .slice(0, 5);
  if (contextPriority.length) lines.push(`- context_priority: ${contextPriority.join(" > ")}`);
  const stageSemantics = asArray(gameStateBrief?.current_stage_rule_semantics)
    .map((line) => safeText(line, "")?.slice(0, 220))
    .filter(Boolean);
  if (stageSemantics.length) lines.push(`- current_stage_rule_semantics: ${stageSemantics.join(" | ")}`);
  const forbidden = asArray(gameStateBrief?.forbidden_waiting_for)
    .map((entry) => `${entry.kind || "choice"} ${entry.stage_round || ""}`.trim())
    .filter(Boolean);
  if (forbidden.length) lines.push(`- never_wait_for_now_or_past: ${uniqueStrings(forbidden).join(", ")}`);
  const unknownFinalChoices = asArray(gameStateBrief?.unknown_final_choices)
    .map((entry) => {
      const options = asArray(entry.observed_options).filter(Boolean);
      return `${entry.kind || entry.label || "choice"} ${entry.stage_round || ""}${options.length ? ` observed=${options.join("/")}` : ""}`.trim();
    })
    .filter(Boolean);
  if (unknownFinalChoices.length) lines.push(`- unknown_final_selected_choices: ${unknownFinalChoices.join(" | ")}`);
  const latestIntent = gameStateBrief?.latest_user_intent?.text
    || asArray(lifecycle?.match_context?.recent_user_messages).at(-1)?.text
    || null;
  if (latestIntent) lines.push(`- latest_user_intent_wins: ${safeText(latestIntent).slice(0, 160)}`);
  lines.push("- rule: Do not say to wait for a checkpoint listed above. If a final selected choice is unknown after that checkpoint, ask what was selected.");
  return lines.join("\n");
}

function textImpliesWaitingForCheckpoint(text) {
  return new RegExp("(?:\\u7b49|\\u7b49\\u5f85|\\u5148\\u770b|\\u786e\\u8ba4|\\u51fa\\u6765|\\u540e\\u518d|\\u518d\\u51b3\\u5b9a|wait|after|until)", "i").test(String(text || ""));
}

function detectRuleConflictingDraftFields(task, gameRuleContract) {
  if (!task || typeof task !== "object" || !gameRuleContract) return [];
  const blockedCheckpoints = [
    ...asArray(gameRuleContract.past_choice_checkpoints),
    gameRuleContract.current_choice_checkpoint,
  ].filter(Boolean);
  if (!blockedCheckpoints.length) return [];
  const fields = [
    ["task.title", task.title],
    ["task.short_advice", task.short_advice],
    ["task.reason_summary", task.reason_summary],
    ["task.recommended_action", task.recommended_action],
    ["task.actions", asArray(task.actions).join(" ")],
    ["task.evidence.summary", asArray(task.evidence).map((entry) => entry?.summary).join(" ")],
  ];
  const conflicts = [];
  for (const [field, value] of fields) {
    const text = String(value || "");
    if (!text || !textImpliesWaitingForCheckpoint(text)) continue;
    for (const checkpoint of blockedCheckpoints) {
      if (!textMentionsChoiceCheckpoint(text, checkpoint)) continue;
      conflicts.push({
        field,
        stage_round: checkpoint.stage_round,
        kind: checkpoint.kind,
        reason: "backend_draft_mentions_waiting_for_current_or_past_choice_checkpoint",
      });
    }
  }
  return conflicts;
}

function usage() {
  return [
    "Usage:",
    "  node tools/run-jcc-cruise-runtime-pipeline.mjs --live-state <file> [--context <file>] [--advice-state <file>] [--out <file>]",
    "    [--mode <mode>] [--finish-mode]",
    "    [--user-message <text>] [--confirm-task-id <id>] [--skip-task-id <id>] [--force-response-reason <reason>] [--runtime-event-context-json <json>] [--now <iso>]",
    "    [--live-rankings <file>] [--user-settings <file>] [--user-memory <file>] [--recent-matches-dir <dir>]",
    "    [--debug-trace <jsonl>] [--debug-max-mb <number>] [--retain-full-state] [--stdout-summary]",
    "",
    "Runs live_state -> estimator context -> cruise scorer -> advice task lifecycle.",
    "--out writes a redacted replay-safe result by default. Use --retain-full-state only for explicit temporary diagnostics.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    adviceState: path.join(runtimePaths.stateDir, "jcc-cruise-advice-lifecycle.json"),
    mode: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--context") options.context = argv[++index];
    else if (arg === "--advice-state") options.adviceState = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--finish-mode") options.finishMode = true;
    else if (arg === "--user-message") options.userMessage = argv[++index];
    else if (arg === "--confirm-task-id") options.confirmTaskId = argv[++index];
    else if (arg === "--skip-task-id") options.skipTaskId = argv[++index];
    else if (arg === "--force-response-reason") options.forceResponseReason = argv[++index];
    else if (arg === "--runtime-event-context-json") options.runtimeEventContextJson = argv[++index];
    else if (arg === "--now") options.now = argv[++index];
    else if (arg === "--live-rankings") options.liveRankings = argv[++index];
    else if (arg === "--user-settings") options.userSettings = argv[++index];
    else if (arg === "--user-memory") options.userMemory = argv[++index];
    else if (arg === "--recent-matches-dir") options.recentMatchesDir = argv[++index];
    else if (arg === "--debug-trace") options.debugTrace = argv[++index];
    else if (arg === "--debug-max-mb") options.debugMaxMb = numberOrNull(argv[++index]);
    else if (arg === "--retain-full-state") options.retainFullState = true;
    else if (arg === "--stdout-summary") options.stdoutSummary = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.mode && !SUPPORTED_RUNTIME_MODES.has(options.mode)) {
    throw new Error(`Unsupported runtime mode: ${options.mode}`);
  }
  return options;
}

async function readJson(file, fallback = null) {
  if (!file || !existsSync(file)) return fallback;
  const text = await readFile(file, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function numberOrNull(value) {
  if (value === undefined || value === null) return null;
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized === "") return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function positivePlayerHpOrNull(value) {
  const fromObject = value && typeof value === "object" && !Array.isArray(value);
  const raw = fromObject && Object.hasOwn(value, "value") ? value.value : value;
  const hp = numberOrNull(raw);
  if (hp === null || hp <= 0 || hp > 150) return null;
  return fromObject ? { ...value, value: hp } : hp;
}

function isoPlusSeconds(now, seconds) {
  const time = Date.parse(now);
  const base = Number.isFinite(time) ? time : Date.now();
  return new Date(base + seconds * 1000).toISOString();
}

function provenance({ source, confidence, observedAt, freshnessMs = 0, status = "candidate" }) {
  return {
    source,
    confidence: Number((confidence ?? 0).toFixed ? confidence.toFixed(2) : confidence),
    freshness_ms: freshnessMs,
    observed_at: observedAt,
    status,
  };
}

function valueWithProvenance(value, source, confidence, now, status = "candidate") {
  const fromObject = value && typeof value === "object" && !Array.isArray(value);
  const raw = fromObject && Object.hasOwn(value, "value") ? value.value : value;
  const hasValue = raw !== undefined && raw !== null && raw !== "";
  return {
    value: hasValue ? raw : null,
    ...(fromObject && Object.hasOwn(value, "to_next") ? { to_next: value.to_next } : {}),
    ...(fromObject && Object.hasOwn(value, "display") ? { display: value.display } : {}),
    ...(fromObject && Object.hasOwn(value, "candidates") ? { candidates: value.candidates } : {}),
    ...provenance({
      source: hasValue ? (fromObject ? (value.source || value.provenance?.source || source) : source) : null,
      confidence: hasValue ? (fromObject ? (numberOrNull(value.confidence ?? value.provenance?.confidence) ?? confidence) : confidence) : 0,
      observedAt: fromObject ? (value.observed_at || value.captured_at || value.provenance?.observed_at || now) : now,
      freshnessMs: fromObject ? (numberOrNull(value.freshness_ms ?? value.age_ms ?? value.provenance?.freshness_ms) ?? (hasValue ? 0 : null)) : (hasValue ? 0 : null),
      status: hasValue ? (fromObject ? (value.status || value.provenance?.status || status) : status) : "missing",
    }),
  };
}

function arrayWithProvenance(values, source, confidence, now, status = "candidate") {
  return asArray(values).map((entry) => {
    const entryObject = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : { value: entry, name: entry };
    return {
      ...entryObject,
      provenance: provenance({
        source: entryObject.source || entryObject.provenance?.source || source,
        confidence: numberOrNull(entryObject.confidence ?? entryObject.provenance?.confidence) ?? confidence,
        observedAt: entryObject.observed_at || entryObject.at || entryObject.captured_at || entryObject.provenance?.observed_at || now,
        freshnessMs: numberOrNull(entryObject.freshness_ms ?? entryObject.age_ms ?? entryObject.provenance?.freshness_ms) ?? 0,
        status: entryObject.status || entryObject.provenance?.status || status,
      }),
    };
  });
}

function timestampMs(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function confirmedAugmentChoiceText(entry) {
  const raw = entry?.choice ?? entry?.selected ?? entry?.selected_choice ?? entry?.name ?? entry?.text ?? null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw.name ?? raw.text ?? raw.choice ?? raw.selected ?? raw.id ?? raw.entity_id ?? null;
  }
  return raw;
}

function confirmedAugmentChoiceObject(entry) {
  const raw = entry?.choice ?? entry?.selected ?? entry?.selected_choice ?? null;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function sameMatchSessionId(candidate, activeMatchSessionId) {
  const candidateMatchSessionId = candidate?.match_session_id || candidate?.matchSessionId || null;
  if (!candidateMatchSessionId || !activeMatchSessionId) return true;
  return String(candidateMatchSessionId) === String(activeMatchSessionId);
}

function sameMatchContext(matchContext, activeMatchSessionId) {
  if (!matchContext || typeof matchContext !== "object") return true;
  return sameMatchSessionId(matchContext, activeMatchSessionId);
}

function sameMatchEntries(entries, activeMatchSessionId) {
  return asArray(entries).filter((entry) => sameMatchSessionId(entry, activeMatchSessionId));
}

function currentMatchScopedFact(candidate, activeMatchSessionId) {
  if (!candidate || typeof candidate !== "object" || !activeMatchSessionId) return null;
  const candidateMatchSessionId = candidate.match_session_id || candidate.matchSessionId || null;
  if (!candidateMatchSessionId) return null;
  return String(candidateMatchSessionId) === String(activeMatchSessionId) ? candidate : null;
}

function exactSameMatchContext(matchContext, activeMatchSessionId) {
  if (!matchContext || typeof matchContext !== "object" || !activeMatchSessionId) return false;
  const contextMatchSessionId = matchContext.match_session_id || matchContext.matchSessionId || null;
  return Boolean(contextMatchSessionId)
    && String(contextMatchSessionId) === String(activeMatchSessionId);
}

function confirmedSelectedAugmentsFromMatchContext(matchContext, now, activeMatchSessionId = null) {
  if (!sameMatchContext(matchContext, activeMatchSessionId)) return [];
  const byStage = new Map();
  for (const entry of sameMatchEntries(matchContext?.choice_confirmations, activeMatchSessionId)) {
    const kind = String(entry?.kind || entry?.choice_kind || "").toLowerCase();
    const choiceKind = String(entry?.choice_kind || "").toLowerCase();
    if (!(kind === "augment" || kind === "augment_choice" || choiceKind === "augment_choice")) continue;
    const stageRound = normalizeStageRound(entry?.choice_stage_round || entry?.stage_round);
    if (!stageRound) continue;
    const choiceObject = confirmedAugmentChoiceObject(entry);
    const text = safeText(confirmedAugmentChoiceText(entry));
    if (!text) continue;
    const source = entry?.source || choiceObject.source || "user_confirmed_runtime_ui_or_chat";
    const observedAt = entry?.confirmed_at || entry?.observed_at || entry?.created_at || now;
    const candidate = {
      ...choiceObject,
      name: safeText(choiceObject.name) || safeText(choiceObject.text) || text,
      text,
      choice_stage_round: stageRound,
      source,
      confirmed_at: entry?.confirmed_at || observedAt,
      observed_at: observedAt,
      semantic_status: "user_confirmed",
    };
    if (entry?.confidence !== undefined) candidate.confidence = numberOrNull(entry.confidence) ?? entry.confidence;
    if (entry?.catalog_match) candidate.catalog_match = entry.catalog_match;
    const previous = byStage.get(stageRound);
    if (!previous || timestampMs(candidate.confirmed_at || candidate.observed_at) >= timestampMs(previous.confirmed_at || previous.observed_at)) {
      byStage.set(stageRound, candidate);
    }
  }
  return [...byStage.values()].sort((left, right) => stageSortValue(left.choice_stage_round) - stageSortValue(right.choice_stage_round));
}

function itemBenchSource(rows) {
  const sources = asArray(rows).map((entry) => String(entry?.source || entry?.provenance?.source || ""));
  if (sources.some((source) => source === "mumu_4357_item_bench")) return "mumu_4357_item_bench";
  if (asArray(rows).some((entry) => String(entry?.promotion_policy || entry?.provenance?.promotion_policy || "") === "structured_4357_left_item_rail_primary")) return "mumu_4357_item_bench";
  return "host_multimodal_visual";
}

function removedOpponentViewScope() {
  return ["opponent", "current_view"].join("_");
}

function removedOpponentViewSnapshotScope() {
  return ["opponent", "current_view", "candidate"].join("_");
}

function ownScopedRows(values) {
  return asArray(values).filter((entry) =>
    entry?.owner_scope !== "non_self_current_view_diagnostic"
    && entry?.owner_scope !== removedOpponentViewScope()
    && entry?.snapshot_scope !== "non_self_current_view_diagnostic_candidate"
    && entry?.snapshot_scope !== removedOpponentViewSnapshotScope()
  );
}

function leftItemRailRoiIconRows(values) {
  return ownScopedRows(values).filter((entry) =>
    String(entry?.source || entry?.provenance?.source || "").startsWith("left_item_rail_roi_icon")
  );
}

function mumu4357ItemBenchRows(values) {
  return ownScopedRows(values).filter((entry) => {
    const source = String(entry?.source || entry?.provenance?.source || "");
    const policy = String(entry?.promotion_policy || entry?.provenance?.promotion_policy || "");
    return source === "mumu_4357_item_bench"
      || policy === "structured_4357_left_item_rail_primary";
  });
}

function formalItemBenchRows(values) {
  return ownScopedRows(values).filter((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return Boolean(entry);
    const source = String(entry?.source || entry?.provenance?.source || "");
    if (source.startsWith("left_item_rail_roi_icon")) return false;
    return true;
  });
}

function mumu4356OwnEquippedRows(values) {
  return ownScopedRows(values).filter((entry) => {
    const source = String(entry?.source || entry?.provenance?.source || "");
    const ownerScope = String(entry?.owner_scope || entry?.provenance?.owner_scope || "");
    const assignmentStatus = String(entry?.assignment_status || entry?.provenance?.assignment_status || "");
    const policy = String(entry?.promotion_policy || entry?.provenance?.promotion_policy || "").toLowerCase();
    const assignedUnitId = firstDefined(
      entry?.assigned_unit_base_hero_id,
      entry?.assigned_unit_id,
      entry?.base_hero_id,
      entry?.unit_base_hero_id,
      entry?.unit_id,
    );
    return source === "mumu_4356_equipment_to_4353_own_unit"
      && ownerScope === "own_unit"
      && assignmentStatus === "assigned"
      && assignedUnitId !== undefined
      && assignedUnitId !== null
      && assignedUnitId !== ""
      && policy.includes("s1_4354")
      && policy.includes("4356_rect_to_4353");
  });
}

function nonEmptyOrNull(values) {
  return asArray(values).length ? values : null;
}

function promotionPolicyOf(value) {
  return String(value?.promotion_policy || value?.provenance?.promotion_policy || "").toLowerCase();
}

function fieldStatusProvesSelfBoard(status) {
  if (!status || typeof status !== "object") return false;
  const policy = promotionPolicyOf(status);
  return String(status.status || "").toLowerCase() === "candidate"
    && policy.includes("shop_self_view_anchor")
    && policy.includes("fresh_current_view")
    && status.shop_anchor_fresh === true;
}

function rowsProveSelfBoard(rows) {
  return asArray(rows).some((entry) => {
    const semantic = String(entry?.semantic_status || "").toLowerCase();
    const source = String(entry?.source || entry?.provenance?.source || "").toLowerCase();
    return semantic.includes("self_view_anchor")
      || source.includes("shop_self_view_anchor")
      || promotionPolicyOf(entry).includes("shop_self_view_anchor");
  });
}

function gatedOwnBoardUnits(root, board) {
  const localRows = nonEmptyOrNull(board.local_board_units)
    || nonEmptyOrNull(board.local_board_units_candidate);
  const genericRows = nonEmptyOrNull(board.units)
    || nonEmptyOrNull(board.board_units);
  const status = root.field_status?.["board.local_board_units_candidate"] || board.field_status || null;
  if (localRows && (fieldStatusProvesSelfBoard(status) || (!status && rowsProveSelfBoard(localRows)))) {
    return localRows;
  }
  if (genericRows && fieldStatusProvesSelfBoard(status)) {
    return genericRows;
  }
  return null;
}

function fieldStatusAllowsCurrentRows(status) {
  if (!status || typeof status !== "object") return true;
  return ["candidate", "observed", "observed_non_empty", "observed_empty", "verified"]
    .includes(String(status.status || "").toLowerCase());
}

function gatedOwnBenchUnits(root, bench) {
  const rows = firstDefined(bench.bench_units, bench.units, bench.local_bench_units, root.bench_units);
  const status = root.field_status?.["bench.bench_units"] || bench.field_status || null;
  return fieldStatusAllowsCurrentRows(status) ? rows : null;
}

function collectionDataQuality(root, path, currentRows, staleRows = undefined) {
  const status = root.field_status?.[path] || null;
  const statusValue = String(status?.status || "").toLowerCase();
  const hasCurrentRows = Array.isArray(currentRows) && currentRows.length > 0;
  const hasStaleRows = Array.isArray(staleRows) && staleRows.length > 0;
  let normalizedStatus = statusValue === "capture_failed" || statusValue === "failed"
    ? "capture_failed"
    : ["held_or_waiting", "stale", "stale_reference", "expired"].includes(statusValue)
      ? "stale_reference"
      : statusValue === "observed_empty"
        ? "observed_empty"
        : hasCurrentRows
          ? "observed_non_empty"
          : hasStaleRows
            ? "stale_reference"
            : ["observed", "valid", "confirmed"].includes(statusValue)
              ? "observed_empty"
              : "not_observed";
  return {
    status: normalizedStatus,
    source: status?.source || status?.source_type || root.source?.kind || null,
    confidence: Number.isFinite(Number(status?.confidence)) ? Number(status.confidence) : null,
    ...(hasStaleRows ? { last_known_value: staleRows, usable_for: "conditional_only" } : {}),
  };
}

function choiceSetChoices(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.choices)) return value.choices;
  return [];
}

function confidenceBand(confidence) {
  if ((confidence || 0) >= 0.82) return "high";
  if ((confidence || 0) >= 0.62) return "medium";
  if ((confidence || 0) > 0) return "low";
  return "missing";
}

function visualObservedValue(observation) {
  if (!observation || typeof observation !== "object") return null;
  if (!["visual_candidate", "verified"].includes(String(observation.status || ""))) return null;
  return observation.value;
}

function buildStandardLiveState(rawLive, sourceContext, now) {
  const root = rawLive.live_state || rawLive;
  const visual = root.visual || rawLive.visual || {};
  const activeMatchSessionId = collectMatchSessionId(rawLive);
  const matchContext = sourceContext.match_context || {};
  const phase = root.phase || root.round || {};
  const economy = root.economy || root.player?.economy || {};
  const board = root.own_board || root.board || {};
  const bench = root.bench || root.own_bench || {};
  const shop = root.shop || {};
  const items = root.items || {};
  const augments = root.augments || {};
  const choices = root.choices || {};
  const visualItems = visual.items || {};
  const visualEconomy = visual.economy || {};
  const matchVariables = root.match_variables || sourceContext.match_variables || {};
  const targetPlan = sourceContext.target_plan || sourceContext.strategy?.target_plan || sourceContext.current_plan || root.target_plan || null;
  const rawBoardUnits = gatedOwnBoardUnits(root, board);
  const rawBenchUnits = gatedOwnBenchUnits(root, bench);
  const staleBoardUnits = asArray(board.stale_local_board_units_reference?.units);
  const staleBenchUnits = asArray(bench.stale_bench_units_reference?.units);
  const boardUnits = arrayWithProvenance(rawBoardUnits, "mumu_bridge_shop_self_view_anchor", 0.9, now, "candidate");
  const benchUnits = arrayWithProvenance(rawBenchUnits, "mumu_bridge", 0.9, now, "candidate");
  const boardDataQuality = collectionDataQuality(root, "board.local_board_units_candidate", rawBoardUnits, staleBoardUnits);
  const benchDataQuality = collectionDataQuality(root, "bench.bench_units", rawBenchUnits, staleBenchUnits);
  const shopUnits = arrayWithProvenance(firstDefined(shop.shop_units, shop.units, shop.current_shop_units, root.shop_units), "mumu_bridge", 0.9, now, "candidate");
  const rawItemBench = firstDefined(
    nonEmptyOrNull(mumu4357ItemBenchRows(items.item_bench)),
    nonEmptyOrNull(mumu4357ItemBenchRows(items.bench)),
    nonEmptyOrNull(mumu4357ItemBenchRows(items.inventory)),
    nonEmptyOrNull(mumu4357ItemBenchRows(root.item_bench)),
    nonEmptyOrNull(formalItemBenchRows(items.item_bench)),
    nonEmptyOrNull(formalItemBenchRows(items.bench)),
    nonEmptyOrNull(formalItemBenchRows(items.inventory)),
    nonEmptyOrNull(formalItemBenchRows(root.item_bench)),
  );
  const rawItemBenchCandidates = firstDefined(
    nonEmptyOrNull(leftItemRailRoiIconRows(items.item_bench_candidates)),
    nonEmptyOrNull(leftItemRailRoiIconRows(visualItems.item_bench_candidates)),
  );
  const rawItemBenchSource = itemBenchSource(rawItemBench);
  const itemBench = arrayWithProvenance(
    rawItemBench,
    rawItemBenchSource,
    rawItemBenchSource === "mumu_4357_item_bench" ? 0.92 : 0.72,
    now,
    "candidate",
  );
  const itemBenchCandidates = arrayWithProvenance(
    rawItemBenchCandidates,
    "left_item_rail_roi_icon",
    0.62,
    now,
    "context_evidence",
  );
  const itemChoiceSet = currentMatchUserReportedChoiceSet(matchContext, "item_choice", activeMatchSessionId);
  const rawItemChoiceOptions = itemChoiceSet?.candidates || null;
  const itemChoiceOptions = arrayWithProvenance(
    rawItemChoiceOptions,
    "current_match_user_report",
    0.96,
    now,
    "user_reported_candidate",
  );
  const rawEquippedItems = firstDefined(
    nonEmptyOrNull(mumu4356OwnEquippedRows(items.equipped_items)),
    nonEmptyOrNull(mumu4356OwnEquippedRows(items.equipped)),
    nonEmptyOrNull(mumu4356OwnEquippedRows(root.equipped_items)),
  );
  const equippedItems = arrayWithProvenance(
    rawEquippedItems,
    "mumu_4356_equipment_to_4353_own_unit",
    0.86,
    now,
    "candidate",
  );
  const confirmedSelectedAugments = confirmedSelectedAugmentsFromMatchContext(matchContext, now, activeMatchSessionId);
  const selectedAugments = arrayWithProvenance(
    confirmedSelectedAugments,
    "match_context_choice_confirmation",
    0.96,
    now,
    "user_confirmed",
  );
  const rawSelectedAugmentCandidates = firstDefined(
    nonEmptyOrNull(augments.selected_augments),
    nonEmptyOrNull(augments.selected),
    nonEmptyOrNull(root.selected_augments),
  );
  const augmentChoiceSet = currentMatchUserReportedChoiceSet(matchContext, "augment_choice", activeMatchSessionId);
  const augmentChoiceCandidates = augmentChoiceSet?.candidates || [];
  const activeSeasonChoiceSetsByMode = Object.fromEntries(
    ACTIVE_SEASON_CHOICE_MODE_CONTRACTS.map((contract) => [
      contract.mode,
      currentMatchUserReportedChoiceSet(matchContext, contract.mode, activeMatchSessionId),
    ]).filter(([, choiceSet]) => choiceSet),
  );
  const selectedAugmentCandidates = arrayWithProvenance(
    asArray(rawSelectedAugmentCandidates).map((entry) => ({
      ...(entry && typeof entry === "object" && !Array.isArray(entry) ? entry : { name: entry }),
      promotion_status: "requires_match_context_choice_confirmation",
    })),
    "unconfirmed_selected_augment_candidate",
    0.48,
    now,
    "requires_confirmation",
  );
  return {
    schema: "jcc-runtime-live-state-standard-v1",
    match_session_id: activeMatchSessionId,
    generated_at: now,
    phase: {
      stage_round: valueWithProvenance(firstDefined(phase.stage_round, phase.stageRound, phase.round_key, phase.current_round, root.latest_stage_round_key, root.stage_round), "mumu_bridge", 0.78, now),
      status: valueWithProvenance(firstDefined(phase.status, phase.s, root.status), "mumu_bridge", 0.86, now),
    },
    own_board: {
      units: boardUnits,
      last_known_value: boardDataQuality.last_known_value || [],
      source_policy: "Only promote MuMu 4353-minus-4352 after visible 4354 shop data anchors the local actionable view; S codes are phase/status evidence only.",
      confidence_band: confidenceBand(boardUnits.length ? Math.min(...boardUnits.map((unit) => unit.provenance.confidence)) : 0),
    },
    own_bench: {
      units: benchUnits,
      last_known_value: benchDataQuality.last_known_value || [],
      confidence_band: confidenceBand(benchUnits.length ? Math.min(...benchUnits.map((unit) => unit.provenance.confidence)) : 0),
    },
    shop: {
      units: shopUnits,
      confidence_band: confidenceBand(shopUnits.length ? Math.min(...shopUnits.map((unit) => unit.provenance.confidence)) : 0),
    },
    economy: {
      gold: valueWithProvenance(firstDefined(economy.gold, economy.money, visualObservedValue(visualEconomy.gold)), "economy_small_roi_interim", 0.68, now),
      hp: valueWithProvenance(positivePlayerHpOrNull(firstDefined(economy.hp, economy.health, economy.life, visualObservedValue(visualEconomy.hp))), "economy_small_roi_interim", 0.68, now),
      level: valueWithProvenance(firstDefined(economy.level, economy.lv, visualObservedValue(visualEconomy.level)), "economy_small_roi_interim", 0.68, now),
      xp: valueWithProvenance(firstDefined(economy.xp, economy.exp, visualObservedValue(visualEconomy.xp)), "economy_small_roi_interim", 0.58, now),
    },
    items: {
      item_bench: itemBench,
      item_bench_candidates: itemBenchCandidates,
      equipped_items: equippedItems,
      choice_options: itemChoiceOptions,
      confidence_band: confidenceBand([...itemBench, ...itemBenchCandidates, ...equippedItems].length ? Math.min(...[...itemBench, ...itemBenchCandidates, ...equippedItems].map((item) => item.provenance.confidence)) : 0),
    },
    augments: {
      selected_augments: selectedAugments,
      selected_augment_candidates: selectedAugmentCandidates,
      choice_candidates: arrayWithProvenance(augmentChoiceCandidates, "current_match_user_report", 0.96, now, "user_reported_candidate"),
      current_choice_set: augmentChoiceSet
        ? { ...augmentChoiceSet, choices: arrayWithProvenance(augmentChoiceCandidates, "current_match_user_report", 0.96, now, "user_reported_candidate") }
        : null,
      confidence_band: confidenceBand(selectedAugments.length ? Math.min(...selectedAugments.map((augment) => augment.provenance.confidence)) : 0),
      selected_augments_source_policy: "final selected augments come only from same-match choice_confirmations; raw live_state/visual selected_augments are candidates until confirmed",
    },
    choices: {
      by_mode: Object.fromEntries(
        Object.entries(activeSeasonChoiceSetsByMode).map(([mode, choiceSet]) => [
          mode,
          arrayWithProvenance(
            choiceSet?.candidates || null,
            "current_match_user_report",
            0.96,
            now,
            "user_reported_candidate",
          ),
        ]),
      ),
    },
    match_variables: {
      values: matchVariables,
      provenance: provenance({ source: "user_confirmed", confidence: Object.keys(matchVariables).length ? 0.94 : 0, observedAt: now, freshnessMs: 0, status: Object.keys(matchVariables).length ? "verified" : "missing" }),
    },
    target_plan: {
      value: targetPlan,
      provenance: provenance({ source: targetPlan ? "runtime_context" : null, confidence: targetPlan ? 0.85 : 0, observedAt: now, freshnessMs: 0, status: targetPlan ? "candidate" : "missing" }),
    },
    strategy_context: {
      value: {
        ...(sourceContext.strategy || {}),
        ...(root.strategy || {}),
        runtime_user_settings: sourceContext.runtime_user_settings || {},
        user_memory: sourceContext.user_memory || {},
        recent_matches_dir: sourceContext.recent_matches_dir || null,
      },
      provenance: provenance({ source: "runtime_context", confidence: 0.72, observedAt: now, freshnessMs: 0 }),
    },
    confidence_policy: {
      data_source_contract: DATA_SOURCE_CONTRACT,
      high_confidence_sources: ["mumu_bridge", "mumu_4357_item_bench", "user_confirmed"],
      medium_confidence_sources: ["mumu_4356_equipment_to_4353_own_unit", "economy_small_roi_interim", "user_triggered_snapshot"],
      low_confidence_rule: "Low-confidence OCR/icon/inferred fields may shape cautious wording, but must not drive high-urgency advice alone.",
    },
    data_quality: {
      current_board: boardDataQuality,
      current_bench: benchDataQuality,
      policy: "Observed values are current facts; observed_empty is an explicit empty state; not_observed and capture_failed are unknown; stale_reference is conditional context only and cannot authorize an exact action.",
    },
  };
}

function stripProvenanceRows(rows) {
  return asArray(rows).map((row) => {
    if (!row || typeof row !== "object") return row;
    const { provenance: rowProvenance, ...rest } = row || {};
    if (!rowProvenance) return rest;
    return {
      ...rest,
      source: rest.source || rowProvenance.source || null,
      source_type: rest.source_type || rowProvenance.source_type || null,
      promotion_policy: rest.promotion_policy || rowProvenance.promotion_policy || null,
      promotion_status: rest.promotion_status || rowProvenance.promotion_status || null,
      assignment_status: rest.assignment_status || rowProvenance.assignment_status || null,
      owner_scope: rest.owner_scope || rowProvenance.owner_scope || null,
      confidence: rest.confidence ?? rowProvenance.confidence ?? null,
      observed_at: rest.observed_at || rowProvenance.observed_at || null,
      freshness_ms: rest.freshness_ms ?? rowProvenance.freshness_ms ?? null,
      status: rest.status || rowProvenance.status || null,
    };
  });
}

function buildPipelineEquipmentContext(standardizedLiveState, matchContext = null) {
  const activeMatchSessionId = standardizedLiveState?.match_session_id || null;
  return resolveEquipmentFactLayers({
    structuredEquipment: {
      item_bench_from_4357: stripProvenanceRows(standardizedLiveState?.items?.item_bench),
      trusted_equipped_items_from_4356_assignment: stripProvenanceRows(standardizedLiveState?.items?.equipped_items),
      item_bench_candidates_fallback_only: stripProvenanceRows(standardizedLiveState?.items?.item_bench_candidates),
    },
    userConfirmedEquipment: currentMatchScopedFact(matchContext?.user_confirmed_equipment, activeMatchSessionId),
    activeMatchSessionId,
  });
}

function buildScoringLiveState(standardizedLiveState, matchContext = null) {
  const xpValue = standardizedLiveState.economy.xp.value;
  const xpCandidates = standardizedLiveState.economy.xp.candidates || {};
  const equipment = buildPipelineEquipmentContext(standardizedLiveState, matchContext);
  return {
    match_session_id: standardizedLiveState.match_session_id,
    phase: {
      stage_round: standardizedLiveState.phase.stage_round.value,
      status: standardizedLiveState.phase.status.value,
    },
    economy: {
      gold: standardizedLiveState.economy.gold.value,
      hp: standardizedLiveState.economy.hp.value,
      level: standardizedLiveState.economy.level.value,
      xp: xpValue === null || xpValue === undefined
        ? null
        : {
            value: xpValue,
            to_next: xpCandidates.xp_to_next ?? standardizedLiveState.economy.xp.to_next ?? null,
            display: xpCandidates.display ?? standardizedLiveState.economy.xp.display ?? null,
            source: standardizedLiveState.economy.xp.source,
            confidence: standardizedLiveState.economy.xp.confidence,
          },
    },
    board: {
      board_units: stripProvenanceRows(standardizedLiveState.own_board.units),
      source_policy: standardizedLiveState.own_board.source_policy,
      confidence_band: standardizedLiveState.own_board.confidence_band,
    },
    bench: {
      bench_units: stripProvenanceRows(standardizedLiveState.own_bench.units),
      confidence_band: standardizedLiveState.own_bench.confidence_band,
    },
    shop: {
      shop_units: stripProvenanceRows(standardizedLiveState.shop.units),
      confidence_band: standardizedLiveState.shop.confidence_band,
    },
    items: {
      item_bench: equipment.effective_item_bench,
      item_bench_candidates: stripProvenanceRows(standardizedLiveState.items.item_bench_candidates),
      equipped_items: equipment.effective_equipped_items,
      choice_options: stripProvenanceRows(standardizedLiveState.items.choice_options),
      confidence_band: standardizedLiveState.items.confidence_band,
      effective_source_by_field: equipment.effective_source_by_field,
      reliability_by_field: equipment.reliability_by_field,
    },
    augments: {
      selected_augments: stripProvenanceRows(standardizedLiveState.augments.selected_augments),
      selected_augment_candidates: stripProvenanceRows(standardizedLiveState.augments.selected_augment_candidates),
      choice_candidates: stripProvenanceRows(standardizedLiveState.augments.choice_candidates),
      confidence_band: standardizedLiveState.augments.confidence_band,
    },
    choices: {
      by_mode: Object.fromEntries(
        Object.entries(standardizedLiveState.choices.by_mode || {}).map(([mode, rows]) => [
          mode,
          stripProvenanceRows(rows),
        ]),
      ),
    },
    match_variables: standardizedLiveState.match_variables.values || {},
    target_plan: standardizedLiveState.target_plan.value || null,
    strategy: standardizedLiveState.strategy_context.value || {},
    confidence_policy: standardizedLiveState.confidence_policy,
  };
}

function textIncludesAny(value, needles) {
  const text = JSON.stringify(value || "").toLowerCase();
  return needles.some((needle) => text.includes(needle.toLowerCase()));
}

function collectItemNames(standardizedLiveState) {
  return [
    ...standardizedLiveState.items.item_bench,
    ...standardizedLiveState.items.item_bench_candidates,
    ...standardizedLiveState.items.equipped_items,
  ].map((item) => String(item.name || item.item_name || item.display_name || item.id || item.item_id || ""));
}

function detectEmblemChoiceState(standardizedLiveState) {
  const variables = standardizedLiveState.match_variables.values || {};
  const explicit = variables.emblem_choice_encounter || variables.three_emblem_encounter || null;
  const itemNames = collectItemNames(standardizedLiveState);
  const offeredFromExplicit = asArray(explicit?.offered_emblems || explicit?.emblems || explicit);
  const offeredFromItems = itemNames.filter((name) => /转职|纹章|冠冕|emblem|crest|crown/i.test(name));
  const removerCandidates = itemNames.filter((name) => /拆卸|卸除|移除|重铸|敲|remover|magnetic/i.test(name));
  const offered = [...new Set([...offeredFromExplicit, ...offeredFromItems].map((value) => String(value)).filter(Boolean))];
  const explicitDetected = Boolean(explicit);
  const itemDetected = offeredFromItems.length >= 2;
  if (!explicitDetected && !itemDetected) return null;
  return {
    detected: true,
    source: explicitDetected ? "user_confirmed_runtime_ui" : "items.item_bench_candidates_left_item_rail_roi_icon",
    offered_emblems: offered.slice(0, 6),
    remover_consumable_count: Number.isFinite(Number(explicit?.remover_consumable_count))
      ? Number(explicit.remover_consumable_count)
      : removerCandidates.length || "unknown",
    confidence: explicitDetected ? 0.94 : 0.72,
    evidence: {
      explicit_variable: explicit || null,
      item_name_candidates: itemNames,
      remover_candidates: removerCandidates,
    },
  };
}

function makeSyntheticTask({ triggerId, priority, valueScore, confidence, title, shortAdvice, evidence, actions, semanticLabels, now }) {
  return {
    task_id: `${triggerId}:${Buffer.from(`${title}:${JSON.stringify(evidence)}`).toString("base64url").slice(0, 10)}`,
    trigger_id: triggerId,
    priority,
    value_score: valueScore,
    confidence,
    title,
    short_advice: shortAdvice,
    reason_summary: evidence.map((entry) => entry.summary).join("；"),
    evidence,
    actions,
    semantic_labels: semanticLabels,
    generated_at: now,
  };
}

function buildDataSourceAdviceTasks(standardizedLiveState, now) {
  const tasks = [];
  const emblemChoice = detectEmblemChoiceState(standardizedLiveState);
  if (emblemChoice) {
    const emblemText = emblemChoice.offered_emblems.length ? emblemChoice.offered_emblems.join("、") : "当前转职";
    const removeText = emblemChoice.remover_consumable_count === "unknown"
      ? "拆卸/敲掉道具数量未知，先扫左侧装备栏确认"
      : `可处理道具 ${emblemChoice.remover_consumable_count} 个`;
    tasks.push(makeSyntheticTask({
      triggerId: "emblem_choice_planning",
      priority: "high",
      valueScore: 0.9,
      confidence: emblemChoice.confidence,
      title: "三转职奇遇规划",
      shortAdvice: `检测到三转职奇遇候选：${emblemText}。${removeText}，先结合目标阵容/来牌判断保留哪个方向，低价值转职不要急着绑死阵容。`,
      evidence: [
        { type: "match_variables.emblem_choice_encounter", summary: "三转职奇遇或装备栏转职候选", value: emblemChoice },
        { type: "items.item_bench", summary: "左侧装备栏/道具栏可作为转职和拆卸道具来源", value: collectItemNames(standardizedLiveState) },
      ],
      actions: ["evaluate_emblem_direction", "scan_item_bench_if_needed", "update_target_plan_or_hold"],
      semanticLabels: ["emblem_choice_encounter", "direction_commit_or_exit", "item_slam_or_greed"],
      now,
    }));
  }
  return tasks;
}

function buildUserMessageAdviceTask(sourceContext, lifecycle, standardizedLiveState, now) {
  const message = String(sourceContext?.user_context?.active_user_message || "").trim();
  if (!message) return null;
  const targetPlan = lifecycle?.match_context?.target_plan || sourceContext?.target_plan || sourceContext?.match_context?.target_plan || null;
  const stageRound = standardizedLiveState?.phase?.stage_round?.value || null;
  const evidence = [
    { type: "active_user_message", summary: message.slice(0, 180), value: { text: message } },
    targetPlan ? { type: "target_plan", summary: String(targetPlan.summary || targetPlan.text || targetPlan.name || "").slice(0, 180), value: targetPlan } : null,
    stageRound ? { type: "phase.stage_round", summary: `current stage ${stageRound}`, value: stageRound } : null,
  ].filter(Boolean);
  return makeSyntheticTask({
    triggerId: "user_message_response",
    priority: "high",
    valueScore: 1,
    confidence: 0.95,
    title: "回答用户当前问题",
    shortAdvice: "直接回答用户当前问题；综合最新阶段、经济、血量、棋盘、备战、商店、装备、已确认选择、目标阵容、大数据和规则。缺关键事实时先说明缺口，再给条件建议。",
    evidence,
    actions: ["answer_current_user_question_with_latest_match_context"],
    semanticLabels: ["user_message_response", "latest_user_intent", "ai_native_coach"],
    now,
  });
}

function buildRuntimeEventFollowupAdviceTask(sourceContext, standardizedLiveState, now) {
  const runtimeEventContext = sourceContext?.runtime_event_context;
  if (!runtimeEventContext || typeof runtimeEventContext !== "object" || Array.isArray(runtimeEventContext)) return null;
  const eventTrigger = String(runtimeEventContext.decision_trigger_id || "");
  const isExplicitCardAction = runtimeEventContext.explicit_user_card_action === true;
  const stageRound = safeText(
    runtimeEventContext.stage_round,
    standardizedLiveState?.phase?.stage_round?.value || null,
  );
  const checkpointId = safeText(
    runtimeEventContext.fixed_checkpoint_id,
    runtimeEventContext.checkpoint_answer_contract?.checkpoint_id || null,
  );
  const registeredCheckpoint = cruiseCheckpointForStage(stageRound);
  const isStrategicCheckpoint = PIPELINE_STRATEGIC_TRIGGER_IDS.has(eventTrigger)
    && Boolean(
      registeredCheckpoint
        && checkpointId
        && registeredCheckpoint.checkpoint_id === checkpointId,
    );
  const isDurableStrategicDelivery = pipelineTaskIsPersistentStrategic({
    decision_trigger_id: eventTrigger,
    fixed_checkpoint_id: checkpointId,
    runtime_event_context: runtimeEventContext,
  }, sourceContext);
  // Ordinary live-state changes are facts for the next strategic checkpoint.
  // Do not create a temporary Host task only to filter it later: that leaves
  // lifecycle/UI churn and can make the send control appear busy.
  if (!isStrategicCheckpoint && !isDurableStrategicDelivery && !isExplicitCardAction) return null;
  const eventKey = safeText(runtimeEventContext.event_key);
  if (!eventKey) return null;
  const eventType = safeText(runtimeEventContext.event_type, "runtime_event");
  const eventCategory = safeText(runtimeEventContext.event_category, "proactive_decision");
  const evidence = [
    {
      type: "runtime_event_context",
      summary: `${eventType}:${eventCategory}`,
      value: runtimeEventContext,
    },
    stageRound
      ? { type: "phase.stage_round", summary: `current stage ${stageRound}`, value: stageRound }
      : null,
  ].filter(Boolean);
  const task = makeSyntheticTask({
    triggerId: "runtime_event_followup",
    priority: "high",
    valueScore: 1,
    confidence: numberOrNull(runtimeEventContext.confidence) ?? 0.9,
    title: "主动巡航决策",
    shortAdvice: PIPELINE_STRATEGIC_TRIGGER_IDS.has(eventTrigger)
      ? "完成当前已注册固定战略检查点的完整回答合同；以阵容战略为主线，合并必要的经济、装备和节奏影响，不输出泛化碎片，也不丢失完整候选阵容和必需字段。scorer 任务只是证据，不是另一个回答所有者。"
      : "回答显式结构化卡片动作；scorer 任务只是证据，不是另一个回答所有者。",
    evidence,
    actions: ["render_ai_native_runtime_event_followup"],
    semanticLabels: uniqueStrings([
      "runtime_event_followup",
      eventType,
      eventCategory,
      runtimeEventContext.decision_trigger_id,
    ]),
    now,
  });
  return {
    ...task,
    task_id: `${task.task_id}:${createHash("sha256").update(eventKey).digest("hex").slice(0, 16)}`,
    ...(runtimeEventContext.decision_trigger_id ? { decision_trigger_id: runtimeEventContext.decision_trigger_id } : {}),
    ...(runtimeEventContext.decision_task_id ? { decision_task_id: runtimeEventContext.decision_task_id } : {}),
    ...(checkpointId ? { fixed_checkpoint_id: checkpointId } : {}),
    ...(stageRound && checkpointId
      ? { fixed_checkpoint_stage_round: stageRound }
      : {}),
    ...(stageRound ? { stage_round: stageRound } : {}),
    event_key: eventKey,
    event_type: eventType,
    event_category: eventCategory,
    runtime_event_context: runtimeEventContext,
    ...(runtimeEventContext.explicit_user_card_action === true
      ? { explicit_user_card_action: true }
      : {}),
    checkpoint_answer_contract: runtimeEventContext.checkpoint_answer_contract || null,
    coach_content_agenda: runtimeEventContext.coach_content_agenda || null,
  };
}











function newLifecycle(matchSessionId, now) {
  return {
    schema: "jcc-cruise-advice-lifecycle-state-v1",
    match_session_id: matchSessionId || null,
    mode: "cruise",
    updated_at: now,
    active_tasks: [],
    confirmed_tasks: [],
    skipped_tasks: [],
    expired_tasks: [],
    active_task_context: {},
    match_context: {
      user_constraints: [],
      confirmed_actions: [],
      skipped_actions: [],
      mode_history: [],
      recent_user_messages: [],
      observed_choice_options_by_stage: {},
      reported_choice_sets_by_mode: {},
      reported_choice_sets: [],
      choice_confirmations: [],
      missing_choice_prompts: [],
      manual_scouting_notes: [],
    },
    previous_advice_state: {
      now,
      emitted_tasks: [],
    },
    output_history: [],
  };
}

function cleanMatchContextExtras(matchContext) {
  const clean = { ...(matchContext || {}) };
  for (const key of [
    "opponent_" + "lobby_scans",
    "opponent_" + "scan_summaries",
    "opponent_" + "snapshots",
    "opponents",
  ]) {
    delete clean[key];
  }
  return clean;
}

function normalizeLifecycle(raw, matchSessionId, now) {
  if (!raw || raw.schema !== "jcc-cruise-advice-lifecycle-state-v1" || raw.match_session_id !== matchSessionId) {
    return newLifecycle(matchSessionId, now);
  }
  return {
    ...raw,
    updated_at: now,
    active_tasks: asArray(raw.active_tasks),
    confirmed_tasks: asArray(raw.confirmed_tasks),
    skipped_tasks: asArray(raw.skipped_tasks),
    expired_tasks: asArray(raw.expired_tasks),
    active_task_context: raw.active_task_context || {},
    match_context: {
      ...cleanMatchContextExtras(raw.match_context),
      user_constraints: asArray(raw.match_context?.user_constraints),
      confirmed_actions: asArray(raw.match_context?.confirmed_actions),
      skipped_actions: asArray(raw.match_context?.skipped_actions),
      mode_history: asArray(raw.match_context?.mode_history),
      recent_user_messages: asArray(raw.match_context?.recent_user_messages),
      observed_choice_options_by_stage: raw.match_context?.observed_choice_options_by_stage || {},
      reported_choice_sets_by_mode: raw.match_context?.reported_choice_sets_by_mode || {},
      reported_choice_sets: asArray(raw.match_context?.reported_choice_sets),
      choice_confirmations: asArray(raw.match_context?.choice_confirmations),
      missing_choice_prompts: asArray(raw.match_context?.missing_choice_prompts),
      manual_scouting_notes: asArray(raw.match_context?.manual_scouting_notes),
    },
    previous_advice_state: {
      ...(raw.previous_advice_state || {}),
      now,
      emitted_tasks: asArray(raw.previous_advice_state?.emitted_tasks),
    },
    output_history: asArray(raw.output_history),
  };
}

function collectMatchSessionId(liveState) {
  const root = liveState.live_state || liveState;
  return root.match_session_id || root.matchSessionId || liveState.match_session_id || null;
}

function taskAlreadyActive(lifecycle, taskId) {
  return lifecycle.active_tasks.some((task) => task.task_id === taskId);
}

function taskStageIdentity(task = {}, sourceContext = {}) {
  const runtimeEventContext = task?.runtime_event_context
    || sourceContext?.runtime_event_context
    || {};
  return normalizeStageRound(
    task?.task_contract?.identity?.stage_round
      || task?.fixed_checkpoint_stage_round
      || task?.requested_stage_round
      || task?.stage_round
      || runtimeEventContext?.fixed_checkpoint_stage_round
      || runtimeEventContext?.requested_stage_round
      || runtimeEventContext?.stage_round
      || sourceContext?.stage_round,
  );
}

function providerOwnsTaskExecution(task = {}, sourceContext = {}) {
  const providerState = task?.provider_execution
    || task?.task_contract?.lifecycle?.provider_execution
    || sourceContext?.provider_execution
    || {};
  const status = String(
    (typeof providerState === "string" ? providerState : providerState?.status)
      || task?.status
      || sourceContext?.status
      || "",
  ).trim();
  const responseTaskId = firstPipelineText(
    providerState?.response_task_id,
    task?.response_task_id,
    sourceContext?.response_task_id,
  );
  const providerStartedAt = firstPipelineText(
    providerState?.provider_awaiting_since,
    providerState?.provider_started_at,
    task?.provider_awaiting_since,
    task?.provider_started_at,
    sourceContext?.provider_awaiting_since,
    sourceContext?.provider_started_at,
  );
  return Boolean(
    responseTaskId
      && providerStartedAt
      && ["running", "awaiting_host_cli_agent_response"].includes(status),
  );
}

function buildTaskContract(task = {}, sourceContext = {}) {
  const stageRound = taskStageIdentity(task, sourceContext);
  const explicitIdentity = firstPipelineText(
    task?.task_contract?.identity?.task_identity,
    task?.task_identity,
    task?.response_task_id,
    task?.decision_task_id,
    task?.fixed_checkpoint_id,
    task?.event_key,
  );
  const triggerId = firstPipelineText(task?.trigger_id, task?.decision_trigger_id, "unknown_trigger");
  const taskIdentity = explicitIdentity || triggerId;
  const providerRunning = providerOwnsTaskExecution(task, sourceContext);
  const persistentStrategic = pipelineTaskIsPersistentStrategic(task, sourceContext);
  return {
    schema: "jcc-advice-task-contract-v1",
    identity: {
      task_identity: taskIdentity,
      trigger_id: triggerId,
      decision_trigger_id: firstPipelineText(
        task?.decision_trigger_id,
        task?.runtime_event_context?.decision_trigger_id,
        null,
      ),
      fixed_checkpoint_id: firstPipelineText(
        task?.fixed_checkpoint_id,
        task?.runtime_event_context?.fixed_checkpoint_id,
        null,
      ),
      stage_round: stageRound || null,
      merge_key: `${triggerId}|${taskIdentity}|${stageRound || "stage_unknown"}`,
    },
    lifecycle: {
      provider_execution: providerRunning
        ? {
            status: "running",
            response_task_id: firstPipelineText(
              task?.response_task_id,
              sourceContext?.response_task_id,
            ),
            provider_awaiting_since: firstPipelineText(
              task?.provider_awaiting_since,
              task?.provider_started_at,
              sourceContext?.provider_awaiting_since,
              sourceContext?.provider_started_at,
            ),
          }
        : { status: "not_running" },
      ttl_policy: providerRunning || persistentStrategic ? "retain_until_owner_settles" : "ordinary_queue_ttl",
      persistent_strategic_obligation: persistentStrategic,
      host_lane_eligible: pipelineTaskMayOpenHost(task, sourceContext),
    },
  };
}

function mergeTaskIndex(lifecycle, task, sourceContext = {}) {
  const byId = lifecycle.active_tasks.findIndex((entry) => entry.task_id === task.task_id);
  if (byId >= 0) return byId;
  const incomingContract = buildTaskContract(task, sourceContext);
  return lifecycle.active_tasks.findIndex((entry) => (
    buildTaskContract(entry).identity.merge_key === incomingContract.identity.merge_key
  ));
}

function taskTtlSeconds(task, sourceContext) {
  if (buildTaskContract(task, sourceContext).lifecycle.ttl_policy === "retain_until_owner_settles") return null;
  const custom = sourceContext.advice_task_ttl_seconds_by_priority || sourceContext.output_policy?.advice_task_ttl_seconds_by_priority || {};
  return numberOrNull(custom[task.priority]) || DEFAULT_TASK_TTL_SECONDS_BY_PRIORITY[task.priority] || DEFAULT_TASK_TTL_SECONDS_BY_PRIORITY.medium;
}

function taskExpiresAt(task, sourceContext, now) {
  const ttlSeconds = taskTtlSeconds(task, sourceContext);
  return ttlSeconds === null ? null : isoPlusSeconds(now, ttlSeconds);
}

function expireTasks(lifecycle, now) {
  const events = [];
  const currentTime = Date.parse(now);
  if (!Number.isFinite(currentTime)) return events;
  const retained = [];
  for (const task of lifecycle.active_tasks) {
    const taskContract = buildTaskContract(task);
    if (taskContract.lifecycle.ttl_policy === "retain_until_owner_settles") {
      retained.push({ ...task, task_contract: taskContract, expires_at: null });
      continue;
    }
    const expiresAt = Date.parse(task.expires_at || "");
    if (Number.isFinite(expiresAt) && expiresAt <= currentTime) {
      lifecycle.expired_tasks.push({ ...task, expired_at: now, expiration_reason: "ttl_elapsed" });
      events.push({ type: "advice_task_expired", task_id: task.task_id, trigger_id: task.trigger_id, observed_at: now });
    } else {
      retained.push(task);
    }
  }
  lifecycle.active_tasks = retained;
  return events;
}

function taskDecisionMetadata(task) {
  const metadata = {};
  for (const key of [
    "decision_trigger_id",
    "decision_task_id",
    "fixed_checkpoint_id",
    "fixed_checkpoint_stage_round",
    "requested_stage_round",
    "stage_round",
    "event_key",
    "event_type",
    "event_category",
    "checkpoint_answer_contract",
    "coach_content_agenda",
    "explicit_user_card_action",
  ]) {
    const value = task?.[key];
    if (value !== null && value !== undefined) metadata[key] = value;
  }
  if (pipelineTaskIsPersistentStrategic(task)) {
    metadata.persistent_strategic_projection = true;
  }
  return metadata;
}

function taskWithoutDecisionMetadata(task) {
  const next = { ...(task || {}) };
  for (const key of [
    "decision_trigger_id",
    "decision_task_id",
    "fixed_checkpoint_id",
    "fixed_checkpoint_stage_round",
    "requested_stage_round",
    "stage_round",
    "event_key",
    "event_type",
    "event_category",
    "checkpoint_answer_contract",
    "coach_content_agenda",
    "explicit_user_card_action",
    "persistent_strategic_projection",
    "task_contract",
  ]) delete next[key];
  return next;
}

function shouldSpeakTask(task, sourceContext, lifecycle) {
  const policy = sourceContext.output_policy || sourceContext.interrupt_policy || {};
  const forceReason = sourceContext.force_response_reason || policy.force_response_reason;
  if (forceReason) return { speak: true, reason: String(forceReason) };
  const decisionTriggerId = String(task?.decision_trigger_id || task?.trigger_id || "");
  if (PIPELINE_STRATEGIC_TRIGGER_IDS.has(decisionTriggerId) && task?.fixed_checkpoint_id) {
    return { speak: true, reason: "fixed_checkpoint_obligation" };
  }
  const minimumPriority = policy.minimum_speak_priority || "medium";
  const minimumScore = numberOrNull(policy.minimum_speak_value_score) ?? 0.74;
  const activeMode = lifecycle.mode || "cruise";
  if (activeMode !== "cruise") return { speak: true, reason: "active_task_mode" };
  if ((PRIORITY_RANK[task.priority] || 0) >= (PRIORITY_RANK[minimumPriority] || 2) && (task.value_score || 0) >= minimumScore) {
    return { speak: true, reason: "priority_value_gate" };
  }
  return { speak: false, reason: "record_only_low_interrupt_value" };
}

function taskMatchesActiveMode(task, mode) {
  if (!task || !mode || mode === "cruise") return false;
  const trigger = String(task.trigger_id || "");
  if (trigger === "user_message_response") return true;
  const contract = runtimeChoiceModeContract(mode, ACTIVE_RULES_BUNDLE);
  if (!contract) return trigger.includes(mode);
  return contract.advice_task_trigger_terms.some((term) => trigger === term || trigger.includes(term));
}

function isChoiceModeTask(task) {
  const trigger = String(task?.trigger_id || "");
  return ACTIVE_CHOICE_MODE_CONTRACTS.some((contract) =>
    contract.advice_task_trigger_terms.some((term) => trigger === term || trigger.includes(term))
  );
}

function isManualModeUserRequest(sourceContext) {
  return String(sourceContext?.force_response_reason || "").startsWith("manual_")
    || Boolean(sourceContext?.user_context?.active_user_message);
}

function chooseTasksForOutput(tasks, lifecycle) {
  const activeTasks = asArray(tasks);
  const mode = lifecycle.mode || "cruise";
  const modeTasks = activeTasks.filter((task) => taskMatchesActiveMode(task, mode));
  const candidates = modeTasks.length
    ? modeTasks
    : activeTasks.filter((task) => !(mode === "cruise" && isChoiceModeTask(task)));
  return candidates
    .slice()
    .sort((left, right) => {
      const priority = (PRIORITY_RANK[right.priority] || 0) - (PRIORITY_RANK[left.priority] || 0);
      if (priority !== 0) return priority;
      return (right.value_score || 0) - (left.value_score || 0);
    });
}

function responseOwnerRank(task, lifecycle) {
  const trigger = String(task?.trigger_id || "");
  const decisionTrigger = String(task?.decision_trigger_id || trigger);
  if (trigger === "user_message_response") return 1;
  if (PIPELINE_STRATEGIC_TRIGGER_IDS.has(decisionTrigger) && task?.fixed_checkpoint_id) return 2;
  if ((lifecycle.mode || "cruise") !== "cruise" && taskMatchesActiveMode(task, lifecycle.mode)) return 2;
  if (trigger === "runtime_event_followup") return 3;
  return 4;
}

function isCurrentStrategicCheckpointTask(task, standardizedLiveState) {
  const decisionTrigger = String(task?.decision_trigger_id || task?.trigger_id || "");
  const currentStageRound = normalizeStageRound(stageBucket(standardizedLiveState));
  const taskStageRound = normalizeStageRound(
    task?.fixed_checkpoint_stage_round || task?.requested_stage_round || task?.stage_round,
  );
  return PIPELINE_STRATEGIC_TRIGGER_IDS.has(decisionTrigger)
    && Boolean(task?.fixed_checkpoint_id)
    && Boolean(currentStageRound)
    && taskStageRound === currentStageRound;
}

function responseOwnerLabel(rank) {
  if (rank === 1) return "direct_user_message_response";
  if (rank === 2) return "strategic_checkpoint_or_active_explicit_mode_task";
  if (rank === 3) return "runtime_event_followup";
  return "highest_value_proactive_task";
}

function taskWasTouchedThisRun(task, events) {
  return asArray(events).some((event) =>
    (event.type === "advice_task_created" || event.type === "advice_task_updated")
    && event.task_id === task?.task_id,
  );
}

function hasRecentResponseRequest(task, lifecycle, now, cooldownSeconds = RESPONSE_REQUEST_COOLDOWN_SECONDS) {
  const currentTime = Date.parse(now) || Date.now();
  return asArray(lifecycle.output_history).some((entry) => {
    if (entry.type !== "advice_response_requested") return false;
    if (entry.task_id !== task.task_id) return false;
    const observedAt = Date.parse(entry.observed_at || "");
    return Number.isFinite(observedAt) && currentTime - observedAt < cooldownSeconds * 1000;
  });
}

function stageBucket(standardizedLiveState) {
  return standardizedLiveState?.phase?.stage_round?.value || "stage_unknown";
}

function goldBucket(standardizedLiveState) {
  const gold = numberOrNull(standardizedLiveState?.economy?.gold?.value);
  if (gold === null) return "gold_unknown";
  return `gold_${Math.floor(gold / 10) * 10}`;
}

function taskSemanticKey(task, standardizedLiveState) {
  const labels = asArray(task?.semantic_labels).slice(0, 3).join("+") || "no_labels";
  return [
    task?.trigger_id || "unknown_trigger",
    labels,
    stageBucket(standardizedLiveState),
    goldBucket(standardizedLiveState),
  ].join("|");
}

function hasRecentSemanticResponseRequest(task, lifecycle, standardizedLiveState, now, cooldownSeconds = BACKGROUND_TRIGGER_COOLDOWN_SECONDS) {
  const currentTime = Date.parse(now) || Date.now();
  const semanticKey = taskSemanticKey(task, standardizedLiveState);
  return asArray(lifecycle.output_history).some((entry) => {
    if (entry.type !== "advice_response_requested") return false;
    if (entry.semantic_key !== semanticKey) return false;
    const observedAt = Date.parse(entry.observed_at || "");
    return Number.isFinite(observedAt) && currentTime - observedAt < cooldownSeconds * 1000;
  });
}

function actionSummary(actions) {
  const list = asArray(actions).filter(Boolean);
  if (!list.length) return "review_current_spot";
  return list[0];
}

function responseId(task, now) {
  return `response:${task.task_id}:${Date.parse(now) || Date.now()}`;
}

function buildFollowupSensingRequest(task) {
  // Active choice intake is user-reported. Refreshing prefills the composer;
  // it must not reserve another Host turn or start background visual sensing.
  void task;
  return null;
}

function taskEvidenceValue(task, type) {
  return asArray(task.evidence).find((entry) => entry?.type === type)?.value || null;
}

function extractLineupPlan(task) {
  if (task?.lineup_plan && typeof task.lineup_plan === "object") return task.lineup_plan;
  if (task?.positioning_lineup_plan && typeof task.positioning_lineup_plan === "object") return task.positioning_lineup_plan;
  if (task?.target_lineup_plan && typeof task.target_lineup_plan === "object") return task.target_lineup_plan;
  if (task?.transition_lineup_plan && typeof task.transition_lineup_plan === "object") return task.transition_lineup_plan;
  if (task?.next_pivot_lineup_plan && typeof task.next_pivot_lineup_plan === "object") return task.next_pivot_lineup_plan;
  for (const evidence of asArray(task?.evidence)) {
    if ([
      "lineup_plan",
      "target.lineup_plan",
      "transition.lineup_plan",
      "next_pivot.lineup_plan",
      "positioning.lineup_plan",
      "lineup_display.plan",
      "live_rankings.lineup_plan",
      "agent_generated.lineup_plan",
    ].includes(evidence?.type) && evidence.value && typeof evidence.value === "object") {
      return evidence.value;
    }
  }
  return null;
}

function buildLineupDisplayContext(task) {
  const lineupPlan = extractLineupPlan(task);
  if (!lineupPlan) return null;
  try {
    return {
      schema: "jcc-lineup-display-context-v1",
      source: "mechanical_renderer",
      renderer: "tools/render-jcc-lineup-text-board.mjs",
      lineup_plan: lineupPlan,
      lineup_board_text: renderJccLineupTextBoard(lineupPlan, { color: false }).trimEnd(),
      render_policy: "When answering target, transition, next-pivot, positioning, or any lineup display task, embed lineup_board_text verbatim. Do not redraw or reinterpret the board layout.",
    };
  } catch (error) {
    return {
      schema: "jcc-lineup-display-context-v1",
      source: "mechanical_renderer",
      status: "render_failed",
      error: error.message || String(error),
      lineup_plan: lineupPlan,
      render_policy: "If rendering fails, explain the structured lineup plan in text and do not invent a board.",
    };
  }
}

function hasMojibakeText(value) {
  const text = String(value || "");
  const markerCodes = [
    0xfffd, // replacement character
    0x951b, // ?
    0x9286, // ?
    0x9225, // ?
    0x934a, // ?
    0x9348, // ?
    0x5a34, // ?
    0x9423, // ?
    0x6769, // ?
    0x7441, // ?
    0x741b, // ?
    0x95b2, // ?
    0x7ed7, // ?
    0x95c1, // ?
  ];
  return markerCodes.some((code) => text.includes(String.fromCharCode(code)))
    || text.includes("?{");
}

function safeText(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (!text || hasMojibakeText(text)) return fallback;
  return text;
}

function firstPipelineText(...values) {
  for (const value of values) {
    const text = safeText(value);
    if (text) return text;
  }
  return null;
}

const HOST_REQUEST_TRANSPORT_TARGET_BYTES = HOST_TURN_DELTA_TARGET_BYTES;
const HOST_REQUEST_TRANSPORT_HARD_LIMIT_BYTES = HOST_TURN_DELTA_ABSOLUTE_MAX_BYTES;
const HOST_STRATEGIC_REQUEST_TARGET_BYTES = HOST_STRATEGIC_TURN_DELTA_TARGET_BYTES;
const HOST_STRATEGIC_REQUEST_HARD_LIMIT_BYTES = HOST_STRATEGIC_TURN_DELTA_ABSOLUTE_MAX_BYTES;
const HOST_REQUEST_SANITIZER_WORKING_LIMIT_BYTES = 32 * 1024 * 1024;
const HOST_REQUEST_SANITIZER_MAX_DEPTH = 32;
const LIFECYCLE_PERSISTENCE_BUDGET_BYTES = 512 * 1024;
const HOST_VALUE_MAX_STRING_BYTES = 4096;
const HOST_VALUE_MAX_ARRAY_ITEMS = 64;
const HOST_VALUE_MAX_OBJECT_ENTRIES = 128;

function clampUtf8Text(value, maxBytes = HOST_VALUE_MAX_STRING_BYTES) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "...";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") + suffixBytes <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low)}${suffix}`;
}

function sanitizeForHostAgent(value, depth = 0, tracker = null) {
  const budget = tracker || { remaining: HOST_REQUEST_TRANSPORT_HARD_LIMIT_BYTES };
  if (budget.remaining <= 0) {
    budget.exhausted = true;
    return null;
  }
  if (depth > HOST_REQUEST_SANITIZER_MAX_DEPTH) {
    budget.depth_exceeded = true;
    return null;
  }
  if (typeof value === "string") {
    const clean = safeText(value);
    if (clean === null) return null;
    const bounded = clampUtf8Text(clean);
    budget.remaining -= Buffer.byteLength(bounded, "utf8") + 2;
    return bounded;
  }
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const output = [];
    for (const entry of value.slice(0, HOST_VALUE_MAX_ARRAY_ITEMS)) {
      const sanitized = sanitizeForHostAgent(entry, depth + 1, budget);
      if (sanitized !== null && sanitized !== undefined) output.push(sanitized);
      if (budget.remaining <= 0) break;
    }
    return output;
  }
  const output = {};
  for (const [key, entry] of Object.entries(value).slice(0, HOST_VALUE_MAX_OBJECT_ENTRIES)) {
    budget.remaining -= Buffer.byteLength(key, "utf8") + 4;
    if (budget.remaining <= 0) {
      budget.exhausted = true;
      break;
    }
    const sanitized = sanitizeForHostAgent(entry, depth + 1, budget);
    if (sanitized !== null && sanitized !== undefined) output[key] = sanitized;
    if (budget.remaining <= 0) break;
  }
  return output;
}

function boundedLifecycleForPersistence(lifecycle) {
  return sanitizeForHostAgent(lifecycle, 0, { remaining: LIFECYCLE_PERSISTENCE_BUDGET_BYTES });
}

function requestHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function exactHostRequestBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function finalizeHostRequestTransport(request, {
  targetBytes = HOST_REQUEST_TRANSPORT_TARGET_BYTES,
  hardLimitBytes = HOST_REQUEST_TRANSPORT_HARD_LIMIT_BYTES,
  sanitizerExhausted = false,
} = {}) {
  if (!request || typeof request !== "object") throw new TypeError("host request must be an object");
  if (sanitizerExhausted) {
    throw new Error("host_request_transport_sanitizer_exhausted_before_finalization");
  }
  const unsigned = structuredClone(request);
  delete unsigned.request_hash;
  unsigned.context = unsigned.context && typeof unsigned.context === "object"
    ? unsigned.context
    : {};
  unsigned.context.transport_budget = {
    ...(unsigned.context.transport_budget || {}),
    target_bytes: targetBytes,
    hard_limit_bytes: hardLimitBytes,
    measurement: "final_compact_json_utf8_bytes_including_request_hash",
    observed_exact_bytes: 0,
    soft_target_exceeded: false,
    within_hard_limit: true,
  };

  let finalized = null;
  let observed = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    unsigned.context.transport_budget.observed_exact_bytes = observed;
    unsigned.context.transport_budget.soft_target_exceeded = observed > targetBytes;
    unsigned.context.transport_budget.within_hard_limit = observed <= hardLimitBytes;
    finalized = { ...unsigned, request_hash: requestHash(unsigned) };
    const nextObserved = exactHostRequestBytes(finalized);
    if (nextObserved === observed) break;
    observed = nextObserved;
  }
  const stableBytes = exactHostRequestBytes(finalized);
  if (stableBytes !== finalized.context.transport_budget.observed_exact_bytes) {
    throw new Error("host_request_transport_measurement_did_not_stabilize");
  }
  if (stableBytes > hardLimitBytes) {
    throw new Error(`host_request_transport_hard_limit_exceeded:${stableBytes}>${hardLimitBytes}`);
  }
  return finalized;
}

function buildHostLiveStateSummary(standardizedLiveState) {
  const boardUnits = standardizedLiveState.own_board.units.slice(0, 10).map(compactUnit);
  const benchUnits = standardizedLiveState.own_bench.units.slice(0, 10).map(compactUnit);
  const shopUnits = standardizedLiveState.shop.units.slice(0, 8).map(compactUnit);
  const itemBench = stripProvenanceRows(standardizedLiveState.items.item_bench).slice(0, 10);
  const itemBenchCandidates = stripProvenanceRows(standardizedLiveState.items.item_bench_candidates).slice(0, 10);
  const equippedItems = stripProvenanceRows(standardizedLiveState.items.equipped_items).slice(0, 18);
  const choiceOptions = stripProvenanceRows(standardizedLiveState.items.choice_options).slice(0, 5);
  const confirmedAugments = stripProvenanceRows(standardizedLiveState.augments.selected_augments).slice(0, 6);
  const selectedAugmentCandidates = stripProvenanceRows(standardizedLiveState.augments.selected_augment_candidates).slice(0, 6);
  return {
    stage_round: standardizedLiveState.phase.stage_round.value,
    phase_status: standardizedLiveState.phase.status.value,
    gold: standardizedLiveState.economy.gold.value,
    hp: standardizedLiveState.economy.hp.value,
    level: standardizedLiveState.economy.level.value,
    xp: standardizedLiveState.economy.xp.value,
    own_board_units: standardizedLiveState.own_board.units.length,
    own_bench_units: standardizedLiveState.own_bench.units.length,
    shop_units: standardizedLiveState.shop.units.length,
    own_board: {
      units: boardUnits,
      source_policy: standardizedLiveState.own_board.source_policy,
      confidence_band: standardizedLiveState.own_board.confidence_band,
    },
    own_bench: {
      units: benchUnits,
      confidence_band: standardizedLiveState.own_bench.confidence_band,
    },
    shop: {
      units: shopUnits,
      confidence_band: standardizedLiveState.shop.confidence_band,
    },
    items: {
      item_bench_count: standardizedLiveState.items.item_bench.length,
      item_bench_candidate_count: standardizedLiveState.items.item_bench_candidates.length,
      equipped_item_count: standardizedLiveState.items.equipped_items.length,
      choice_option_count: standardizedLiveState.items.choice_options.length,
      item_bench: itemBench,
      item_bench_candidates: itemBenchCandidates,
      equipped_items: equippedItems,
      choice_options: choiceOptions,
      confidence_band: standardizedLiveState.items.confidence_band,
    },
    augments: {
      selected_augments: confirmedAugments,
      selected_augment_candidates: selectedAugmentCandidates,
      selected_augments_source_policy: standardizedLiveState.augments.selected_augments_source_policy,
    },
    match_variables: standardizedLiveState.match_variables.values || {},
    target_plan: standardizedLiveState.target_plan.value || null,
  };
}

function buildCurrentModeChoiceContext(mode, standardizedLiveState, matchContext = null) {
  const contract = runtimeChoiceModeContract(mode, ACTIVE_RULES_BUNDLE);
  const contextField = String(contract?.host_context_choice_field || "").trim();
  if (!contextField) return {};
  const visible = visibleCandidatesForContract(standardizedLiveState, contract, matchContext);
  if (!visible.candidates.length) return {};
  return {
    [contextField]: {
      schema: "jcc-host-choice-candidates-v1",
      source: visible.choice_set?.source || visible.field_path || "active_mode_choice_candidates",
      source_field_path: visible.field_path || null,
      mode,
      kind: contract.kind || "choice",
      stage_round: visible.choice_set?.choice_stage_round || standardizedLiveState.phase.stage_round.value || null,
      choice_set_revision: visible.choice_set?.revision || null,
      candidates: stripProvenanceRows(visible.candidates).slice(0, 6),
    },
  };
}

function compactEconomyRulesForPipelineDecision(rulesBundle = ACTIVE_RULES_BUNDLE) {
  const base = rulesBundle?.base_game_rules?.economy_management || null;
  const patch = rulesBundle?.patch_strategy_overrides?.economy_management_overrides || null;
  return {
    schema: "jcc-economy-management-selected-context-v1",
    purpose: "Compact economy doctrine for this host call. Treat numeric thresholds as reference priors, not formulas.",
    base: base ? {
      schema: base.schema || null,
      scope: base.scope || null,
      core_principles: asArray(base.core_principles).slice(0, 6),
      interest_reference: {
        thresholds: asArray(base.interest_threshold_math?.thresholds),
        interest_cap_gold: base.interest_threshold_math?.interest_cap_gold ?? null,
        caveat: base.interest_threshold_math?.caveat || null,
      },
      open_sell_policy: base.open_sell_policy ? {
        meaning: base.open_sell_policy.meaning || null,
        host_policy: base.open_sell_policy.host_policy || null,
      } : null,
      level_timing_reference: base.level_timing_priors ? {
        level_8: base.level_timing_priors.level_8 || null,
        reroll_level_priors: base.level_timing_priors.reroll_level_priors || null,
        interpretation: "Timing priors are examples. Current line, contest, HP, economy augments, and user target can override.",
      } : null,
      event_policy: base.event_policy || null,
    } : null,
    patch_strategy: patch ? {
      schema: patch.schema || null,
      scope: patch.scope || null,
      tempo_bias: patch.tempo_bias || null,
      event_policy: patch.event_policy || null,
      host_model_policy: asArray(patch.host_model_policy).slice(0, 4),
    } : null,
    model_rule: "The host model must reconcile these priors with live HP/gold/level/XP, board/shop/bench upgrades, equipment fit, confirmed choices, latest user intent, and big-data line fit.",
  };
}

function buildPipelineEconomicDecisionContext({ standardizedLiveState, lifecycle, liveStateSummary, equipment }) {
  const economyLiveState = {
    phase: {
      stage_round: liveStateSummary?.stage_round ?? null,
      status: liveStateSummary?.phase_status ?? null,
    },
    economy: {
      gold: liveStateSummary?.gold ?? null,
      hp: liveStateSummary?.hp ?? null,
      level: liveStateSummary?.level ?? null,
      xp: liveStateSummary?.xp ?? null,
      streak: standardizedLiveState?.economy?.streak?.value ?? null,
    },
    board_units: standardizedLiveState?.own_board?.units || [],
    bench_units: standardizedLiveState?.own_bench?.units || [],
    shop_units: standardizedLiveState?.shop?.units || [],
    selected_augments: standardizedLiveState?.augments?.selected_augments || [],
    match_variables: lifecycle?.match_context?.match_variables || standardizedLiveState?.match_variables?.values || {},
    items: {
      item_bench: equipment?.effective_item_bench || [],
      equipped_items: equipment?.effective_equipped_items || [],
    },
  };
  const context = {
    target_plan: lifecycle?.match_context?.target_plan || standardizedLiveState?.target_plan?.value || null,
    match_variables: lifecycle?.match_context?.match_variables || standardizedLiveState?.match_variables?.values || {},
    user_memory: {
      latest_user_intent: lifecycle?.match_context?.latest_user_constraint || asArray(lifecycle?.match_context?.recent_user_messages).at(-1) || null,
      choice_confirmations: asArray(lifecycle?.match_context?.choice_confirmations).slice(-6),
    },
    equipment: equipment || {},
    __jcc_profile_context: CRUISE_RUNTIME_PROFILE_CONTEXT,
  };
  try {
    const result = buildLevelingEconomyContext({
      liveState: economyLiveState,
      context,
      tables: runtimeStrategyTables,
    });
    const pinnedLifecycle = buildLineupLifecycleContext({
      liveState: economyLiveState,
      context,
      profileContext: CRUISE_RUNTIME_PROFILE_CONTEXT,
    });
    result.lineup_lifecycle = pinnedLifecycle;
    if (result.leveling_math) result.leveling_math.lineup_lifecycle = pinnedLifecycle;
    const actions = asArray(result?.actions).slice(0, 4).map((action) => ({
      action: action.action || null,
      score: action.score ?? null,
      confidence: action.confidence || null,
      gold_cost: action.gold_cost ?? null,
      gold_after: action.gold_after ?? null,
      interest_after: action.interest_after ?? null,
      interest_loss: action.interest_loss ?? null,
      clicks: action.clicks ?? null,
      roll_budget: action.roll_budget ?? null,
      evidence: asArray(action.evidence).slice(0, 5),
    }));
    const decisionFacts = result?.decision_facts || {};
    return {
      schema: "jcc-economic-decision-context-v1",
      source_schema: result?.schema || null,
      status: result?.status || "unknown",
      policy: "Pipeline economy evidence. heuristic_top_candidate is not a command; host model must check missing_decision_facts and current line/board/item fit before final advice.",
      live_economy: result?.live_economy || null,
      xp_policy: result?.xp_policy ? {
        source: result.xp_policy.source || null,
        modifiers: asArray(result.xp_policy.modifiers).map((modifier) => modifier?.key || modifier).filter(Boolean).slice(0, 6),
        uncertainty: asArray(result.xp_policy.uncertainty).slice(0, 4),
      } : null,
      leveling_math: result?.leveling_math ? {
        need_to_next_level: result.leveling_math.need_to_next_level ?? null,
        clicks_to_level_now: result.leveling_math.clicks_to_level_now ?? null,
        gold_to_level_now: result.leveling_math.gold_to_level_now ?? null,
        can_prelevel: result.leveling_math.can_prelevel ?? null,
        target_profile: result.leveling_math.target_profile || null,
        target_pool_gain: result.leveling_math.target_pool_gain ?? null,
      } : null,
      heuristic_top_candidate: actions[0] || null,
      actions,
      decision_factors: {
        available: asArray(decisionFacts.available),
        model_must_check: asArray(decisionFacts.model_must_check),
        authority: decisionFacts.authority || "Numeric action scores are heuristic candidates, not final advice.",
      },
      missing_decision_facts: asArray(decisionFacts.missing_decision_facts),
      missing_fields: uniqueStrings([
        ...asArray(result?.missing_fields),
        ...asArray(decisionFacts.missing_decision_facts).map((entry) => entry?.field).filter(Boolean),
      ]),
    };
  } catch (error) {
    return {
      schema: "jcc-economic-decision-context-v1",
      status: "unavailable",
      policy: "Pipeline economy context builder failed; host must fall back to live economy fields and economy_management_context.",
      live_economy: null,
      heuristic_top_candidate: null,
      actions: [],
      missing_decision_facts: [{ field: "economic_decision_context", reason: "pipeline economy builder failed" }],
      missing_fields: ["economic_decision_context"],
      diagnostics_ref: "pipeline:economic_decision_context_unavailable",
    };
  }
}

const PIPELINE_STRATEGIC_TRIGGER_IDS = new Set([
  "lineup_convergence_checkpoint",
  "cap_gap_check",
  "direction_commit_or_exit",
]);

function pipelineTaskIsPersistentStrategic(task = {}, sourceContext = {}) {
  const runtimeEventContext = task?.runtime_event_context
    || sourceContext?.runtime_event_context
    || null;
  const triggerId = String(
    runtimeEventContext?.decision_trigger_id
      || task?.decision_trigger_id
      || task?.trigger_id
      || "",
  );
  if (!PIPELINE_STRATEGIC_TRIGGER_IDS.has(triggerId)) return false;
  const checkpointId = firstPipelineText(
    runtimeEventContext?.fixed_checkpoint_id,
    task?.fixed_checkpoint_id,
    runtimeEventContext?.checkpoint_answer_contract?.checkpoint_id,
  );
  if (!checkpointId) return false;
  const strategicObligation = runtimeEventContext?.strategic_obligation
    || task?.strategic_obligation
    || sourceContext?.strategic_obligation
    || null;
  const hasCompletionReceipt = asArray(strategicObligation?.completion_receipts).length > 0;
  const persistentLabel = [
    ...asArray(task?.semantic_labels),
    ...asArray(runtimeEventContext?.semantic_labels),
  ].includes("persistent_strategic_obligation_queue");
  return task?.persistent_strategic_projection === true
    || task?.existing_strategic_obligation_delivery === true
    || runtimeEventContext?.existing_strategic_obligation_delivery === true
    || hasCompletionReceipt
    || persistentLabel;
}

function pipelineTaskMayOpenHost(task, sourceContext = {}) {
  if (task?.task_contract?.lifecycle?.host_lane_eligible === true) return true;
  const taskTriggerId = String(task?.trigger_id || "");
  if (taskTriggerId === "user_message_response") return true;
  if (taskTriggerId !== "runtime_event_followup") return false;
  const runtimeEventContext = task?.runtime_event_context
    || sourceContext?.runtime_event_context
    || null;
  const runtimeTrigger = String(
    runtimeEventContext?.decision_trigger_id
      || task?.decision_trigger_id
      || task?.task_contract?.identity?.decision_trigger_id
      || "",
  );
  if (task?.explicit_user_card_action === true || runtimeEventContext?.explicit_user_card_action === true) return true;
  if (!PIPELINE_STRATEGIC_TRIGGER_IDS.has(runtimeTrigger)) return false;
  const stageRound = firstPipelineText(
    runtimeEventContext?.stage_round,
    task?.fixed_checkpoint_stage_round,
    task?.task_contract?.identity?.stage_round,
    sourceContext?.stage_round,
  );
  const checkpointId = firstPipelineText(
    runtimeEventContext?.fixed_checkpoint_id,
    task?.fixed_checkpoint_id,
    task?.task_contract?.identity?.fixed_checkpoint_id,
    runtimeEventContext?.checkpoint_answer_contract?.checkpoint_id,
  );
  const registeredCheckpoint = cruiseCheckpointForStage(stageRound);
  return Boolean(
    (registeredCheckpoint
      && checkpointId
      && registeredCheckpoint.checkpoint_id === checkpointId)
      || pipelineTaskIsPersistentStrategic(task, sourceContext)
      || task?.task_contract?.lifecycle?.persistent_strategic_obligation === true,
  );
}

function filterPipelineHostTasks(score, sourceContext) {
  const adviceTasks = asArray(score?.advice_tasks);
  const hostAdviceTasks = adviceTasks.filter((task) => pipelineTaskMayOpenHost(task, sourceContext));
  const suppressed = adviceTasks
    .filter((task) => !hostAdviceTasks.includes(task))
    .map((task) => ({
      ...task,
      suppression_reason: "automatic_cruise_task_is_fact_only_supporting_evidence",
      retry_after_seconds: null,
    }));
  return {
    ...score,
    host_advice_tasks: hostAdviceTasks,
    advice_tasks: hostAdviceTasks,
    suppressed_tasks: [...asArray(score?.suppressed_tasks), ...suppressed],
    policy: "Only explicit user turns and registered strategic checkpoint events may open the Host lane; all other scorer tasks remain supporting evidence.",
  };
}

function retireLegacyNonHostTasks(lifecycle, now, sourceContext = {}) {
  const retained = [];
  for (const task of asArray(lifecycle.active_tasks)) {
    if (pipelineTaskMayOpenHost(task, sourceContext)) {
      retained.push(task);
      continue;
    }
    lifecycle.expired_tasks.push({
      ...task,
      expired_at: now,
      expiration_reason: "automatic_host_lane_removed",
    });
  }
  lifecycle.active_tasks = retained;
  return lifecycle;
}

function pipelineStrategicTask(task, sourceContext, gameStateBrief) {
  const runtimeEventContext = sourceContext?.runtime_event_context;
  const triggerId = firstPipelineText(
    runtimeEventContext?.decision_trigger_id,
    task?.decision_trigger_id,
    task?.trigger_id,
  );
  if (!PIPELINE_STRATEGIC_TRIGGER_IDS.has(triggerId)) return null;
  return {
    trigger_id: triggerId,
    stage_round: firstPipelineText(
      runtimeEventContext?.stage_round,
      task?.stage_round,
      gameStateBrief?.stage_round,
    ),
    semantic_labels: uniqueStrings([
      ...asArray(task?.semantic_labels),
      ...asArray(runtimeEventContext?.semantic_labels),
    ]).slice(0, 12),
    event_category: firstPipelineText(
      runtimeEventContext?.event_category,
      task?.event_category,
      "line_decision_context",
    ),
    event_type: firstPipelineText(runtimeEventContext?.event_type, task?.event_type, "line_decision_context_changed"),
    coach_content_agenda: runtimeEventContext?.coach_content_agenda || null,
    strategic_obligation: runtimeEventContext?.strategic_obligation || null,
  };
}

function compactPipelineRankingCandidate(candidate, index, rankingOverlayId = null) {
  if (!candidate || typeof candidate !== "object") return null;
  const variants = asArray(candidate.variants || candidate.strategy_profile?.variants);
  const requestedVariantId = firstPipelineText(
    candidate.selected_variant_id,
    candidate.query_variant_id,
    candidate.variant_id,
  );
  const selectedVariant = requestedVariantId
    ? [candidate.canonical_variant, ...variants].find((variant) => (
        firstPipelineText(variant?.variant_id, variant?.id) === requestedVariantId
      )) || null
    : candidate.canonical_variant
      || variants.find((variant) => variant?.roster_is_atomic === true && [
        variant?.lineup_names,
        variant?.atomic_roster_members,
        variant?.core_units,
      ].some((value) => asArray(value).length > 0))
      || null;
  if (requestedVariantId && !selectedVariant) return null;
  const coreUnits = asArray(
    selectedVariant?.core_units
      || selectedVariant?.atomic_roster_members
      || candidate.core_units
      || candidate.units
      || candidate.core_unit_names,
  );
  const coreUnitIds = asArray(
    selectedVariant?.core_unit_ids
      || selectedVariant?.lineup_ids
      || candidate.core_unit_ids,
  );
  const compactUnit = (unit) => {
    if (!unit || typeof unit !== "object") return { champion_name: String(unit || "") };
    return {
      champion_id: unit.champion_id || unit.hero_id || unit.id || null,
      champion_name: unit.champion_name || unit.hero_name || unit.name || unit.display_name || null,
      source_unit_id: unit.source_unit_id || null,
      entity_kind: unit.entity_kind || null,
      occupies_population: unit.occupies_population === true,
      catalog_resolution: unit.catalog_resolution || null,
      cost: numberOrNull(unit.cost),
      star: numberOrNull(unit.star || unit.stars),
    };
  };
  const compactFormationProfile = (profile) => {
    if (!profile || typeof profile !== "object") return profile || null;
    const economy = profile.formation_economy_profile && typeof profile.formation_economy_profile === "object"
      ? {
          roster_purchase_cost: numberOrNull(profile.formation_economy_profile.roster_purchase_cost),
          star_target_purchase_cost: numberOrNull(profile.formation_economy_profile.star_target_purchase_cost),
          target_roster_purchase_cost: numberOrNull(profile.formation_economy_profile.target_roster_purchase_cost),
          target_unit_costs: asArray(profile.formation_economy_profile.target_unit_costs).slice(0, 16).map((unit) => ({
            id: unit?.id || unit?.champion_id || null,
            name: unit?.name || unit?.champion_name || null,
            cost: numberOrNull(unit?.cost),
            star: numberOrNull(unit?.star),
            copies: numberOrNull(unit?.copies),
            purchase_cost: numberOrNull(unit?.purchase_cost),
            target_role: unit?.target_role || null,
          })),
          roll_and_xp_cost_requires_current_gold_level_xp: profile.formation_economy_profile.roll_and_xp_cost_requires_current_gold_level_xp === true,
        }
      : null;
    const acquisition = profile.acquisition_profile && typeof profile.acquisition_profile === "object"
      ? {
          star_targets: asArray(profile.acquisition_profile.star_targets).slice(0, 6).map((target) => ({
            role: target?.role || null,
            unit_id: target?.unit_id || null,
            unit_name: target?.unit_name || null,
            unit_cost: numberOrNull(target?.unit_cost),
            star: numberOrNull(target?.star),
            total_copies_from_one_star: numberOrNull(target?.total_copies_from_one_star),
            source: target?.source || null,
          })),
          estimate_boundary: profile.acquisition_profile.estimate_boundary || null,
        }
      : null;
    const shared = profile.shared_feasibility && typeof profile.shared_feasibility === "object"
      ? {
          source_authority: profile.shared_feasibility.source_authority || null,
          archetype: profile.shared_feasibility.archetype || null,
          style: profile.shared_feasibility.style || null,
          target_population: numberOrNull(profile.shared_feasibility.target_population),
          stabilize_population: numberOrNull(profile.shared_feasibility.stabilize_population),
          burden_score: numberOrNull(profile.shared_feasibility.burden_score),
          burden_band: profile.shared_feasibility.burden_band || null,
          components: profile.shared_feasibility.components || null,
          core_cost_violations: asArray(profile.shared_feasibility.core_cost_violations).slice(0, 8),
          unknowns: asArray(profile.shared_feasibility.unknowns).slice(0, 8),
        }
      : null;
    return {
      authority: profile.authority || null,
      target_population: numberOrNull(profile.target_population),
      roster_unit_count: numberOrNull(profile.roster_unit_count),
      required_population: numberOrNull(profile.required_population),
      formation_burden: profile.formation_burden || profile.burden || null,
      readiness: profile.readiness || profile.state || null,
      estimated_burden_score: numberOrNull(profile.estimated_burden_score),
      burden_band: profile.burden_band || null,
      evidence_coverage: numberOrNull(profile.evidence_coverage),
      high_cost_counts: profile.high_cost_counts || null,
      high_cost_units: asArray(profile.high_cost_units).slice(0, 10).map(compactUnit),
      trait_breakpoints: asArray(profile.trait_breakpoints).slice(0, 10),
      transition_support: profile.transition_support || null,
      explicit_requirements: profile.explicit_requirements || null,
      formation_economy_profile: economy,
      acquisition_profile: acquisition,
      shared_feasibility: shared,
      unknowns: asArray(profile.unknowns).slice(0, 8),
      runtime_reconcile: asArray(profile.runtime_reconcile).slice(0, 12),
    };
  };
  const compactVariant = (variant) => ({
    variant_id: variant?.variant_id || variant?.id || null,
    population: numberOrNull(variant?.population || variant?.target_population),
    core_unit_ids: asArray(variant?.core_unit_ids || variant?.lineup_ids).slice(0, 16),
    core_units: asArray(variant?.core_units || variant?.units)
      .slice(0, 16)
      .map(compactUnit),
    lineup_names: asArray(variant?.lineup_names || variant?.champion_names || variant?.units)
      .map((unit) => typeof unit === "object" ? unit.champion_name || unit.name || unit.display_name : unit)
      .filter(Boolean)
      .slice(0, 16),
    main_carry: variant?.main_carry || null,
    primary_tank: variant?.primary_tank || null,
    equipment_priority: variant?.equipment_priority || null,
    lifecycle_prior: variant?.lifecycle_prior || null,
    condition_priors: variant?.condition_priors || null,
    formation_profile: compactFormationProfile(variant?.formation_profile),
    canonical_lineup_identity: variant?.canonical_lineup_identity || null,
    atomic_roster_statistics: variant?.atomic_roster_statistics || null,
    atomic_variant_difference: variant?.atomic_variant_difference || null,
    ...compactMatureRecipeVariantPacket({
      variants: variant?.mature_recipe_variants,
      receipt: variant?.mature_recipe_variant_receipt,
      limit: 6,
    }),
    associated_augments: asArray(variant?.associated_augments).slice(0, 12),
    transitions: asArray(variant?.transitions).slice(0, 4).map((transition) => ({
      semantic_role: transition?.semantic_role || transition?.role || null,
      population: numberOrNull(transition?.population || transition?.target_population),
      lineup_names: asArray(transition?.lineup_names || transition?.champion_names || transition?.units)
        .map((unit) => typeof unit === "object" ? unit.champion_name || unit.name || unit.display_name : unit)
        .filter(Boolean)
        .slice(0, 16),
    })),
  });
  const championNames = asArray(
    [
      selectedVariant?.lineup_names,
      selectedVariant?.champion_names,
      selectedVariant?.atomic_roster_members,
      selectedVariant?.core_units,
      candidate.champion_names,
      candidate.core_unit_names,
      candidate.atomic_roster_members,
      candidate.core_units,
    ].find((value) => asArray(value).length > 0),
  )
    .map((unit) => typeof unit === "object" ? unit.champion_name || unit.name || unit.display_name : unit)
    .filter(Boolean);
  const compactCandidateFormationProfile = compactFormationProfile(candidate.formation_profile);
  const compactEquipmentRequirements = candidate.equipment_requirements && typeof candidate.equipment_requirements === "object"
    ? Object.fromEntries(Object.entries(candidate.equipment_requirements)
      .filter(([key]) => ["main_carry", "primary_tank", "secondary_carry", "core"].includes(key))
      .map(([key, value]) => [key, {
        holder_id: value?.holder_id || value?.champion_id || null,
        holder_name: value?.holder_name || value?.champion_name || null,
        published_priority_item_names: asArray(value?.published_priority_item_names).slice(0, 6),
        published_priority_item_ids: asArray(value?.published_priority_item_ids).slice(0, 6),
        source_interpretation: value?.source_interpretation || null,
      }]))
    : candidate.equipment_requirements || null;
  const compactStrengthAnchor = candidate.strength_anchor && typeof candidate.strength_anchor === "object"
    ? {
        anchor_id: candidate.strength_anchor.anchor_id || null,
        metrics: candidate.strength_anchor.metrics || null,
        quality: candidate.strength_anchor.quality
          ? {
              current_day_score: numberOrNull(candidate.strength_anchor.quality.current_day_score),
              floor_score: numberOrNull(candidate.strength_anchor.quality.floor_score),
              ceiling_score: numberOrNull(candidate.strength_anchor.quality.ceiling_score),
              band: candidate.strength_anchor.quality.band || null,
              classification: candidate.strength_anchor.quality.classification || null,
              sample_band: candidate.strength_anchor.quality.sample_band || null,
            }
          : null,
        source_interpretation: candidate.strength_anchor.source_interpretation || null,
      }
    : candidate.strength_anchor || null;
  const compactSemanticFeatures = candidate.semantic_features && typeof candidate.semantic_features === "object"
    ? Object.fromEntries(Object.entries(candidate.semantic_features).slice(0, 20))
    : candidate.semantic_features || null;
  const matureRecipeVariantPacket = compactMatureRecipeVariantPacket({
    variants: selectedVariant?.mature_recipe_variants || candidate.mature_recipe_variants,
    receipt: selectedVariant?.mature_recipe_variant_receipt || candidate.mature_recipe_variant_receipt,
    limit: 6,
  });
  return {
    candidate_id: candidate.candidate_id || candidate.id || candidate.lineup_group_id || `ranking-candidate-${index + 1}`,
    name: candidate.name || candidate.display_name || null,
    main_traits: asArray(candidate.main_traits || candidate.main_trait_list).slice(0, 8),
    champion_names: (championNames.length ? championNames : coreUnits.map((unit) => compactUnit(unit).champion_name).filter(Boolean)).slice(0, 16),
    selected_variant_id: selectedVariant?.variant_id || selectedVariant?.id || requestedVariantId || null,
    atomic_roster_id: selectedVariant?.atomic_roster_id || candidate.atomic_roster_id || null,
    candidate_evidence_id: selectedVariant?.candidate_evidence_id || candidate.candidate_evidence_id || null,
    roster_is_atomic: selectedVariant
      ? selectedVariant.roster_is_atomic === true ? true : null
      : candidate.roster_is_atomic === true ? true : null,
    main_carry: selectedVariant?.main_carry || candidate.main_carry || candidate.primary_carry || null,
    primary_tank: selectedVariant?.primary_tank || candidate.primary_tank || candidate.main_tank || null,
    top1_rate: numberOrNull(candidate.top1_rate ?? candidate.metrics?.top1_rate),
    top4_rate: numberOrNull(candidate.top4_rate ?? candidate.metrics?.top4_rate),
    use_rate: numberOrNull(candidate.use_rate ?? candidate.metrics?.use_rate),
    signal_score: numberOrNull(candidate.signal_score ?? candidate.strength_score),
    strength_anchor: compactStrengthAnchor,
    source_role: candidate.source_role || null,
    metrics_authority: candidate.metrics_authority ?? null,
    recipe_match: (() => {
      const match = selectedVariant?.recipe_match || candidate.recipe_match;
      if (!match || typeof match !== "object") return match || null;
      return {
        classification: match.classification || match.match_kind || null,
        source_role: match.source_role || null,
        source_id: match.source_id || match.recipe_id || null,
        freshness: match.freshness || null,
        coverage: match.coverage || null,
        evidence_boundary: match.evidence_boundary || null,
      };
    })(),
    formation_profile: compactFormationProfile(selectedVariant?.formation_profile) || compactCandidateFormationProfile,
    canonical_lineup_identity: selectedVariant?.canonical_lineup_identity || candidate.canonical_lineup_identity || null,
    semantic_signature: candidate.semantic_signature || null,
    atomic_variant_comparison: candidate.atomic_variant_comparison || null,
    ...matureRecipeVariantPacket,
    ...(candidate.main_trait_list ? { main_trait_list: asArray(candidate.main_trait_list).slice(0, 8) } : {}),
    ...(coreUnits.length || coreUnitIds.length ? {
      core_unit_ids: coreUnitIds.slice(0, 16),
      core_units: coreUnits.slice(0, 16).map(compactUnit),
    } : {}),
    ...(selectedVariant?.atomic_roster_members
      ? { atomic_roster_members: asArray(selectedVariant.atomic_roster_members).slice(0, 16).map(compactUnit) }
      : {}),
    ...(selectedVariant ? { variants: [compactVariant(selectedVariant)] } : {}),
    ...((selectedVariant?.associated_augments || candidate.associated_augments)
      ? { associated_augments: asArray(selectedVariant?.associated_augments || candidate.associated_augments).slice(0, 16) }
      : {}),
    ...(selectedVariant?.main_carry?.item_names?.length
      ? { main_carry_item_packages: [{
          population: numberOrNull(selectedVariant.population),
          item_ids: asArray(selectedVariant.main_carry.item_ids).slice(0, 6),
          item_names: asArray(selectedVariant.main_carry.item_names).slice(0, 6),
          source_interpretation: selectedVariant.main_carry.source_interpretation || null,
        }] }
      : candidate.main_carry_item_packages
        ? { main_carry_item_packages: asArray(candidate.main_carry_item_packages).slice(0, 2) }
        : {}),
    ...(selectedVariant?.equipment_priority
      ? { equipment_requirements: selectedVariant.equipment_priority }
      : compactEquipmentRequirements ? { equipment_requirements: compactEquipmentRequirements } : {}),
    ...((selectedVariant?.lifecycle_prior || candidate.lifecycle_prior)
      ? { lifecycle_prior: selectedVariant?.lifecycle_prior || candidate.lifecycle_prior }
      : {}),
    ...((selectedVariant?.condition_priors || candidate.condition_priors)
      ? { condition_priors: selectedVariant?.condition_priors || candidate.condition_priors }
      : {}),
    ...(compactSemanticFeatures ? { semantic_features: compactSemanticFeatures } : {}),
    provenance: {
      canonical_roster_source: candidate.provenance?.canonical_roster_source || selectedVariant?.semantic_role_source || null,
      strength_source: candidate.provenance?.strength_source || compactStrengthAnchor?.source_interpretation || null,
      recipe_source: candidate.provenance?.recipe_source || selectedVariant?.recipe_match?.source_role || null,
      recipe_metrics_used: candidate.provenance?.recipe_metrics_used === true,
      ranking_overlay_id: candidate.provenance?.ranking_overlay_id || rankingOverlayId || null,
    },
    evidence_boundary: {
      canonical_roster_source: candidate.provenance?.canonical_roster_source || selectedVariant?.semantic_role_source || null,
      strength_source: candidate.provenance?.strength_source || compactStrengthAnchor?.source_interpretation || null,
      recipe_source: candidate.provenance?.recipe_source || selectedVariant?.recipe_match?.source_role || null,
      recipe_metrics_used: candidate.provenance?.recipe_metrics_used === true,
      selected_atomic_variant_only: true,
      ranking_overlay_id: candidate.provenance?.ranking_overlay_id || rankingOverlayId || null,
      sibling_variant_union_excluded: true,
    },
  };
}

function pipelineCandidateEvidenceCompleteness(candidate) {
  if (!candidate || typeof candidate !== "object") return -1;
  const canonicalVariant = asArray(candidate.variants)[0] || null;
  return (
    Math.min(16, asArray(candidate.champion_names).length) * 4
    + Math.min(16, asArray(candidate.core_units).length) * 4
    + Math.min(16, asArray(canonicalVariant?.lineup_names).length) * 5
    + (candidate.roster_is_atomic === true ? 12 : 0)
    + (candidate.main_carry ? 6 : 0)
    + (candidate.primary_tank ? 6 : 0)
    + (candidate.equipment_requirements ? 5 : 0)
    + (candidate.lifecycle_prior ? 5 : 0)
    + (candidate.formation_profile ? 5 : 0)
    + (candidate.provenance?.ranking_overlay_id ? 8 : 0)
    + (candidate.evidence_boundary?.selected_atomic_variant_only === true ? 8 : 0)
  );
}

function buildPipelineStrategicFitPacket({ strategyTask, sourceContext, gameStateBrief, lineupLifecycle, economicDecisionContext, estimatorContext, targetContext }) {
  const liveRankings = estimatorContext?.context?.live_rankings_context || {};
  const rankingIdentity = runtimePaths.activeRankingGenerationId
    || liveRankings.ranking_overlay_id
    || sourceContext?.live_rankings_context?.ranking_overlay_id
    || null;
  const sourceRankingIdentity = sourceContext?.live_rankings_context?.ranking_overlay_id || null;
  const acceptedRankingIdentities = new Set([
    rankingIdentity,
    runtimePaths.activeRankingGenerationId,
    liveRankings.ranking_overlay_id,
    liveRankings.content_fingerprint,
  ].filter(Boolean).map(String));
  const sourceRankingContextMatches = Boolean(
    sourceRankingIdentity
      && acceptedRankingIdentities.has(String(sourceRankingIdentity)),
  );
  const sourceCandidates = [
    ...(sourceRankingContextMatches ? asArray(sourceContext?.live_rankings_context?.top_lineups) : []),
    ...(sourceRankingContextMatches ? asArray(sourceContext?.live_rankings_context?.lineup_groups) : []),
    ...(sourceRankingContextMatches ? asArray(sourceContext?.live_rankings_context?.lineup_candidates) : []),
    ...asArray(liveRankings.top_lineups),
    ...asArray(liveRankings.lineup_groups),
    ...asArray(liveRankings.lineup_candidates),
    ...Object.values(liveRankings.tiers || {}).flatMap((tier) => [
      ...asArray(tier?.lineup_groups),
      ...asArray(tier?.lineup_candidates),
    ]),
  ];
  const compactedCandidates = sourceCandidates
    .map((candidate, index) => compactPipelineRankingCandidate(candidate, index, rankingIdentity))
    .filter((candidate) => candidateIdentityKey(candidate));
  const sourceCandidatePool = dedupeCandidateWorkingSet(compactedCandidates);
  // The initial working set is evidence for the Host, never the final display
  // list. Keep one complete atomic variant per group and expand the bounded
  // pool with the user's requested display count. The complete current-day
  // index remains available through the bound read-only expansion operation.
  const requestedDisplayCount = Number(sourceContext?.requested_display_count);
  const normalizedRequestedDisplayCount = Number.isInteger(requestedDisplayCount) && requestedDisplayCount > 0
    ? requestedDisplayCount
    : null;
  const candidateWorkingSetLimit = candidateWorkingSetLimitForStrategic({
    requestedDisplayCount: normalizedRequestedDisplayCount || 3,
    declaredLimit: sourceContext?.candidate_working_set_limit,
    sourceCount: sourceCandidatePool.length,
  });
  const scopedCandidatePool = targetContext?.authority === "durable_target_plan"
    ? selectCandidateWorkingSetForDurableTarget(sourceCandidatePool, targetContext.target, { maxComparators: 2 })
    : sourceCandidatePool;
  const candidateWorkingSet = boundedCandidateWorkingSet(scopedCandidatePool, {
    displayCount: normalizedRequestedDisplayCount || 3,
    limit: candidateWorkingSetLimit,
  });
  const candidateWorkingSetSourceCount = scopedCandidatePool.length;
  const candidateWorkingSetTruncated = candidateWorkingSet.length < candidateWorkingSetSourceCount;
  const stageRound = strategyTask?.stage_round || gameStateBrief?.stage_round || null;
  const capCheck = strategyTask?.trigger_id === "cap_gap_check";
  const strategicObligation = strategyTask?.strategic_obligation || null;
  const defaultRequiredDecisions = capCheck
    ? [
        "state_current_floor_quality_and_target_cap_gap",
        "compare_stabilize_now_save_for_level_or_spend_for_cap_using_hp_economy_and_board_quality",
        "name_the_next_high_value_replacement_or_population_unit",
        "state_the_next_checkpoint_that_changes_the_action",
      ]
    : [
        "name_complete_ranking_backed_candidate_directions",
        "compare_main_carry_main_tank_core_traits_and_formation_stage",
        "explain_equipment_augment_transition_and_pivot_conditions",
        "state_the_next_checkpoint_that_narrows_or_confirms_the_direction",
      ];
  const candidateReferences = candidateWorkingSet.map((candidate) => ({
    candidate_id: candidate.candidate_id,
    selected_variant_id: candidate.selected_variant_id,
    candidate_evidence_id: candidate.candidate_evidence_id,
    atomic_roster_id: candidate.atomic_roster_id,
    display_name: candidate.name,
    detail_ref: `candidate_working_set:${candidate.candidate_id}`,
  }));
  return {
    schema: "jcc-strategy-fit-packet-v1",
    source: "pipeline_strategic_request",
    policy: "Runtime supplies a bounded current-Master+ working set and deterministic lifecycle/economy evidence. The Host Agent selects and explains coherent directions; it must not invent missing Ranking candidates or rewrite strength metrics.",
    semantic_seed: sourceContext?.semantic_seed || sourceContext?.runtime_event_context?.semantic_seed || null,
    // Keep the strategic answer contract ahead of the large candidate payload.
    // The transport sanitizer is budgeted and preserves object insertion order;
    // the contract must survive even when the complete evidence set is large.
    next_coach_plan: {
      schema: "jcc-strategic-coach-agenda-v1",
      priority: capCheck ? "cap_and_floor_first" : "lineup_direction_first",
      required_decisions: uniqueStrings([
        ...asArray(strategicObligation?.required_decisions),
        ...defaultRequiredDecisions,
      ]),
      stage_round: stageRound,
      coach_content_agenda: strategyTask?.coach_content_agenda || null,
      strategic_obligation: strategicObligation,
    },
    strategic_obligation: strategicObligation,
    candidate_working_set_count: candidateWorkingSet.length,
    candidate_working_set_source_count: candidateWorkingSetSourceCount,
    candidate_working_set_retained_count: candidateWorkingSet.length,
    candidate_working_set_limit: candidateWorkingSetLimit,
    candidate_working_set_truncated: candidateWorkingSetTruncated,
    requested_display_count: normalizedRequestedDisplayCount,
    agent_selected_display_count: null,
    inputs_summary: {
      stage_round: stageRound,
      target_context_authority: targetContext?.authority || "none",
      ranking_overlay_id: rankingIdentity,
      discarded_mismatched_source_context: Boolean(sourceRankingIdentity && !sourceRankingContextMatches),
      ranking_candidates_available: candidateWorkingSet.length,
      ranking_candidates_source_count: candidateWorkingSetSourceCount,
      board_is_feasibility_evidence_only: true,
    },
    big_data_support: {
      available: Boolean(rankingIdentity && candidateWorkingSet.length),
      ranking_overlay_id: rankingIdentity,
      source: rankingIdentity ? "current_master_plus_overlay" : "unavailable_in_pipeline_input",
      selection_policy: "ranking_is_the_working_pool; Agent owns final semantic selection",
      candidate_working_set_hint: candidateWorkingSet.length,
      candidate_working_set_source_count: candidateWorkingSetSourceCount,
      candidate_working_set_truncated: candidateWorkingSetTruncated,
      strength_metrics_are_deterministic: true,
      board_units_are_opportunity_evidence_only: true,
    },
    candidate_working_set: candidateWorkingSet,
    candidate_frontier: candidateReferences,
    candidate_lines: candidateReferences,
    formation_profile: lineupLifecycle?.formation_profile || lineupLifecycle?.board_readiness || null,
    lineup_lifecycle: lineupLifecycle,
    economy_management: {
      economy_management_context: compactEconomyRulesForPipelineDecision(ACTIVE_RULES_BUNDLE),
      economic_decision_context: economicDecisionContext,
    },
    missing_facts: asArray(gameStateBrief?.unknown_final_choices),
    target_alignment: targetContext?.authority === "durable_target_plan"
      ? "durable_target_plan_available"
      : targetContext?.authority === "provisional_user_intent"
        ? "provisional_user_intent_only"
        : "agent_must_keep_candidates_open",
  };
}

function buildPipelineCruiseDecisionContext({ standardizedLiveState, lifecycle, liveStateSummary, gameRuleContract, gameStateBrief, task, sourceContext, estimatorContext }) {
  const equipment = buildPipelineEquipmentContext(standardizedLiveState, lifecycle?.match_context || null);
  const economicDecisionContext = buildPipelineEconomicDecisionContext({ standardizedLiveState, lifecycle, liveStateSummary, equipment });
  const targetPlan = lifecycle?.match_context?.target_plan
    || sourceContext?.match_context?.target_plan
    || sourceContext?.target_plan
    || liveStateSummary?.target_plan
    || null;
  const declaredTargetAuthority = normalizeTargetContextAuthority(
    lifecycle?.match_context?.target_context_authority
      || sourceContext?.match_context?.target_context_authority
      || sourceContext?.target_context_authority
      || targetPlan?.authority,
  );
  const targetContext = {
    target: targetPlan,
    authority: declaredTargetAuthority !== "none"
      ? declaredTargetAuthority
      : classifyPersistedTargetPlanAuthority(targetPlan),
  };
  const lineupLifecycle = buildLineupLifecycleContext({
    liveState: standardizedLiveState,
    context: {
      target_plan: targetContext.target,
      target_context_authority: targetContext.authority,
    },
    profileContext: CRUISE_RUNTIME_PROFILE_CONTEXT,
  });
  const strategyTask = pipelineStrategicTask(task, sourceContext, gameStateBrief);
  const strategyFitPacket = strategyTask
    ? buildPipelineStrategicFitPacket({
        strategyTask,
        sourceContext,
        gameStateBrief,
        lineupLifecycle,
        economicDecisionContext,
        estimatorContext,
        targetContext,
      })
    : {
        schema: "jcc-strategy-fit-packet-v1",
        source: "pipeline_minimal",
        policy: "Pipeline supplies minimal economy evidence here. Electron runtime may enrich with full big-data candidate fit; host model must not infer missing lineup-fit certainty.",
        economy_management: {
          economy_management_context: compactEconomyRulesForPipelineDecision(ACTIVE_RULES_BUNDLE),
          economic_decision_context: economicDecisionContext,
        },
        lineup_lifecycle: lineupLifecycle,
        missing_facts: asArray(gameStateBrief?.unknown_final_choices),
        target_alignment: "unknown_without_full_runtime_fit_packet",
      };
  return {
    schema: "jcc-cruise-decision-context-v1",
    purpose: "Pipeline-selected context for AI-native cruise advice. Use as evidence, not a deterministic answer template.",
    // Strategic identity and agenda are transport invariants. Keep them ahead
    // of the large evidence packet so budget sanitization cannot orphan the
    // checkpoint contract from its trigger.
    decision_trigger_id: strategyTask?.trigger_id || null,
    coach_content_agenda: strategyTask?.coach_content_agenda || null,
    strategy_fit_packet: strategyFitPacket,
    stage_round: gameStateBrief?.stage_round || gameRuleContract?.stage_round || liveStateSummary?.stage_round || null,
    latest_user_intent: lifecycle?.match_context?.latest_user_constraint || asArray(lifecycle?.match_context?.recent_user_messages).at(-1) || null,
    match_variables: lifecycle?.match_context?.match_variables || liveStateSummary?.match_variables || {},
    target_plan: lifecycle?.match_context?.target_plan || liveStateSummary?.target_plan || null,
    confirmed_choices: asArray(lifecycle?.match_context?.choice_confirmations).slice(-6),
    economy: {
      hp: liveStateSummary?.hp ?? null,
      gold: liveStateSummary?.gold ?? null,
      level: liveStateSummary?.level ?? null,
      xp: liveStateSummary?.xp ?? null,
      streak: standardizedLiveState?.economy?.streak?.value ?? null,
    },
    current_board_shop_bench: {
      own_board_units: liveStateSummary?.own_board_units ?? null,
      own_bench_units: liveStateSummary?.own_bench_units ?? null,
      shop_units: liveStateSummary?.shop_units ?? null,
      own_board: liveStateSummary?.own_board || null,
      pairs_or_upgrades_need_model_assessment: true,
    },
    equipment,
    economy_management_context: compactEconomyRulesForPipelineDecision(ACTIVE_RULES_BUNDLE),
    economic_decision_context: economicDecisionContext,
    lineup_lifecycle: lineupLifecycle,
    required_output_judgement: {
      line_fit: "aligned|weak|unknown with short reason",
      tempo_plan: "winstreak|stable_economy|greed|stabilize|pivot|pre_level|roll|ask_missing_fact",
      missing_facts: "ask only for facts that materially change the next decision",
    },
  };
}

function buildHostCoachAgentRequest({ requestId, task, lifecycle, standardizedLiveState, estimatorContext, followupSensingRequest, sourceContext }) {
  const lineupDisplay = buildLineupDisplayContext(task);
  const gameRuleContract = buildGameRuleContract(standardizedLiveState, lifecycle);
  const gameStateBrief = buildGameStateBrief(standardizedLiveState, lifecycle, gameRuleContract);
  const liveStateSummary = buildHostLiveStateSummary(standardizedLiveState);
  const currentModeChoiceContext = buildCurrentModeChoiceContext(
    lifecycle.mode || "cruise",
    standardizedLiveState,
    lifecycle.match_context || null,
  );
  const cruiseDecisionContext = buildPipelineCruiseDecisionContext({
    standardizedLiveState,
    lifecycle,
    liveStateSummary,
    gameRuleContract,
    gameStateBrief,
    task,
    sourceContext,
    estimatorContext,
  });
  const gameRuleBriefText = formatGameRuleBriefText({
    gameStateBrief,
    gameRuleContract,
    coachRulesBrief: ACTIVE_RULES_BUNDLE.coach_rules_brief,
    lifecycle,
  });
  const taskForHost = {
    ...task,
    game_rule_contract: gameRuleContract,
  };
  const strategicDecisionTrigger = firstPipelineText(
    task?.decision_trigger_id,
    sourceContext?.runtime_event_context?.decision_trigger_id,
    cruiseDecisionContext?.decision_trigger_id,
    task?.trigger_id,
  );
  const strategicTurn = PIPELINE_STRATEGIC_TRIGGER_IDS.has(String(strategicDecisionTrigger || ""));
  const transportTargetBytes = strategicTurn
    ? HOST_STRATEGIC_REQUEST_TARGET_BYTES
    : HOST_REQUEST_TRANSPORT_TARGET_BYTES;
  const transportHardLimitBytes = strategicTurn
    ? HOST_STRATEGIC_REQUEST_HARD_LIMIT_BYTES
    : HOST_REQUEST_TRANSPORT_HARD_LIMIT_BYTES;
  const transportBudget = {
    remaining: Math.max(transportHardLimitBytes, HOST_REQUEST_SANITIZER_WORKING_LIMIT_BYTES),
    exhausted: false,
  };
  const request = sanitizeForHostAgent({
    schema: "jcc-host-cli-coach-response-request-v1",
    type: "host_cli_agent_coach_response_request",
    request_id: requestId,
    provider: "current_cli_agent_main_model",
    model_variable: true,
    instructions: buildHostCoachInstructions({
      contract: HOST_COACH_INSTRUCTION_CONTRACT,
      mode: lifecycle.mode || "cruise",
      signatureContract: null,
      seasonModeAddons: null,
      modeAliases: null,
    }),
    expected_response_shape: {
      schema: "jcc-host-cli-coach-response-v1",
      generated_by: "current_cli_agent_main_model",
      final_text: strategicTurn
        ? "string; natural Chinese strategic coaching answer with the complete checkpoint agenda; expand enough to name the real directions, rationale, conditions, and next action"
        : "string; one to three concise Chinese sentences",
      ...(strategicTurn ? {
        candidate_refs: "optional exact [{candidate_id, variant_id, candidate_evidence_id}] identities needed for Runtime preservation or materialization",
      } : {}),
      ...(lifecycle.mode === "lineup_card" ? {
        lineup_handoff: "minimal target identity and semantic adjustments; Runtime materializes the card",
      } : {}),
    },
    response_style: {
      final_text_is_ai_native: true,
      fallback_text_is_not_final: true,
      no_chain_of_thought: true,
      max_sentences_default: strategicTurn ? 10 : 3,
    },
    task: compactTask(taskForHost),
    followup_sensing_request: followupSensingRequest,
      context: {
        mode: lifecycle.mode || "cruise",
        // Live facts are required evidence. Place them before the large
        // Ranking packet so ordered budget sanitization cannot orphan the
        // current board, bench, economy, or equipment context.
        live_state_summary: liveStateSummary,
        transport_budget: {
          target_bytes: strategicTurn
            ? HOST_STRATEGIC_REQUEST_TARGET_BYTES
            : HOST_REQUEST_TRANSPORT_TARGET_BYTES,
          hard_limit_bytes: strategicTurn
            ? HOST_STRATEGIC_REQUEST_HARD_LIMIT_BYTES
            : HOST_REQUEST_TRANSPORT_HARD_LIMIT_BYTES,
          policy: strategicTurn
            ? "strategic_target_4MiB_hard_limit_8MiB_preserve_live_facts_checkpoint_contract_and_atomic_candidates"
            : "ordinary_turn_1MiB_target_2MiB_max",
        },
        current_turn_contract: {
        schema: "jcc-runtime-current-turn-contract-v1",
        authority: "pipeline_rebuilt_for_current_advice_task",
        match_session_id: lifecycle.match_session_id || standardizedLiveState.match_session_id || null,
        active_mode: lifecycle.mode || "cruise",
        stage_round: gameStateBrief.stage_round || gameRuleContract.stage_round || null,
        rules_source_fingerprint: ACTIVE_RULES_BUNDLE.source_fingerprint || null,
        version_identity: ACTIVE_RULES_BUNDLE.version_identity || null,
        source_policy: {
          runtime_fact_authority: ["live_state_summary", "match_context", "game_state_brief"],
          rule_authority: ["game_rule_contract", "coach_rules_brief", "active_rules_bundle.source_files"],
          soft_priors_only: ["patch_strategy_overrides", "daily_big_data", "strategy_wiki_context"],
        },
      },
      active_user_message: lifecycle.active_task_context?.user_message || null,
      runtime_event_context: sourceContext?.runtime_event_context || null,
      decision_trigger_id: cruiseDecisionContext.decision_trigger_id || null,
      coach_content_agenda: cruiseDecisionContext.coach_content_agenda || null,
      ranking_working_set_hint: cruiseDecisionContext.strategy_fit_packet?.big_data_support?.candidate_working_set_hint || null,
      game_rule_brief_text: gameRuleBriefText,
      game_rule_contract: gameRuleContract,
      game_state_brief: gameStateBrief,
      match_context: {
        match_variables: lifecycle.match_context?.match_variables || standardizedLiveState.match_variables.values || {},
        target_plan: lifecycle.match_context?.target_plan || standardizedLiveState.target_plan.value || null,
        recent_user_messages: asArray(lifecycle.match_context?.recent_user_messages).slice(-12),
        observed_choice_options_by_stage: null,
        reported_choice_sets_by_mode: lifecycle.match_context?.reported_choice_sets_by_mode || null,
        reported_choice_sets: asArray(lifecycle.match_context?.reported_choice_sets).slice(-12),
        choice_confirmations: asArray(lifecycle.match_context?.choice_confirmations).slice(-12),
        missing_choice_prompts: asArray(lifecycle.match_context?.missing_choice_prompts).slice(-12),
        manual_scouting_notes: asArray(lifecycle.match_context?.manual_scouting_notes).slice(-12),
      },
      ...currentModeChoiceContext,
      cruise_decision_context: cruiseDecisionContext,
      confidence_policy: standardizedLiveState.confidence_policy,
      estimator: estimatorContext?.context?.combat_cap_estimator || null,
      ranked_augment_recommendation: taskEvidenceValue(task, "augments.ranked_recommendation"),
      lineup_display: lineupDisplay,
    },
  }, 0, transportBudget);
  return finalizeHostRequestTransport(request, {
    targetBytes: transportTargetBytes,
    hardLimitBytes: transportHardLimitBytes,
    sanitizerExhausted: transportBudget.exhausted === true,
  });
}

function buildAdviceResponse(task, lifecycle, standardizedLiveState, estimatorContext, sourceContext, now, reason) {
  const evidence = asArray(task.evidence).slice(0, 4);
  const followupSensingRequest = buildFollowupSensingRequest(task);
  const response_id = responseId(task, now);
  const hostCliAgentRequest = buildHostCoachAgentRequest({
    requestId: response_id,
    task,
    lifecycle,
    standardizedLiveState,
    estimatorContext,
    followupSensingRequest,
    sourceContext,
  });
  return {
    schema: "jcc-runtime-advice-response-request-v1",
    type: "advice_response_requested",
    response_id,
    task_id: task.task_id,
    trigger_id: task.trigger_id,
    mode: lifecycle.mode || "cruise",
    generated_at: now,
    urgency: task.priority,
    confidence: task.confidence,
    output_reason: reason,
    status: "awaiting_host_cli_agent_response",
    final_response_required: true,
    user_visible_text: null,
    ai_native_policy: {
      output_model: "host_cli_main_model_required",
      structure_is_guidance_not_cage: true,
      structured_envelope_required: true,
      style: "short_actionable_coach_advice",
      allow_model_to_rephrase: true,
      require_model_rendering: true,
      fallback_is_not_final_answer: true,
      avoid_hidden_chain_of_thought: true,
      rendering_policy: {
        agent_can_merge_fields: true,
        agent_can_omit_low_value_evidence: true,
        why_and_evidence_expandable: true,
        do_not_render_as_table_by_default: true,
        visible_text_can_be_one_or_two_sentences: true,
      },
    },
    response_draft: {
      title: safeText(task.title, "coach_advice"),
      summary: safeText(task.short_advice, "awaiting_host_cli_main_model_final_response"),
      visible_text: null,
      recommended_action: actionSummary(task.actions),
      why: safeText(task.reason_summary) || evidence.map((entry) => safeText(entry.summary)).filter(Boolean).join("; "),
      confidence: task.confidence,
      urgency: task.priority,
      expires_at: task.expires_at || null,
      evidence,
      actions: asArray(task.actions),
      followup_sensing_request: followupSensingRequest,
    },
    host_cli_agent_request: hostCliAgentRequest,
    followup_sensing_request: followupSensingRequest,
    prompt_context: {
      active_user_message: lifecycle.active_task_context?.user_message || null,
      live_state_summary: buildHostLiveStateSummary(standardizedLiveState),
      confidence_policy: standardizedLiveState.confidence_policy,
      estimator: estimatorContext?.context?.combat_cap_estimator || null,
      task,
    },
  };
}

function compactUnit(unit) {
  if (!unit || typeof unit !== "object") return unit;
  const position = unit.position || unit.pos || unit.hex || null;
  const boardGrid = position?.board_grid || unit.board_grid || position?.grid || unit.grid || null;
  return {
    id: firstDefined(unit.id, unit.unit_id, unit.hero_id, unit.champion_id, null),
    base_id: firstDefined(unit.base_id, unit.baseHeroId, unit.base_hero_id, null),
    name: firstDefined(unit.name, unit.unit_name, unit.hero_name, unit.champion_name, unit.display_name, null),
    cost: firstDefined(unit.cost, unit.price, null),
    star: firstDefined(unit.star, unit.star_level, null),
    items: Array.isArray(unit.items) ? unit.items.slice(0, 3) : Array.isArray(unit.equipment) ? unit.equipment.slice(0, 3) : undefined,
    x: firstDefined(unit.x, position?.x, null),
    y: firstDefined(unit.y, position?.y, null),
    ...(boardGrid
      ? {
        board_grid: {
          row: boardGrid.row,
          col: boardGrid.col,
          col_from_left: boardGrid.col_from_left,
          col_from_right: boardGrid.col_from_right,
          position_words: boardGrid.position_words || null,
          confidence: boardGrid.confidence ?? null,
        },
      }
      : {}),
  };
}

function compactItem(item) {
  if (!item || typeof item !== "object") return item;
  const name = firstDefined(
    item.name,
    item.item_name,
    item.display_name,
    item.text,
    item.raw_text,
    item.catalog_match?.name,
    null,
  );
  return {
    id: firstDefined(item.id, item.item_id, item.catalog_match?.id, null),
    name,
    ...(item.item_class ? { item_class: item.item_class } : {}),
    ...(Array.isArray(item.template_sets) && item.template_sets.length ? { template_sets: item.template_sets.slice(0, 6) } : {}),
    ...(item.text && item.text !== name ? { text: item.text } : {}),
    ...(item.raw_text && item.raw_text !== name ? { raw_text: item.raw_text } : {}),
    ...(item.slot !== undefined ? { slot: item.slot } : {}),
    owner_scope: firstDefined(item.owner_scope, item.scope, null),
    confidence: numberOrNull(item.confidence ?? item.provenance?.confidence),
    ...(item.evidence_layer ? { evidence_layer: item.evidence_layer } : {}),
    ...(item.semantic_status ? { semantic_status: item.semantic_status } : {}),
    ...(item.promotion_status ? { promotion_status: item.promotion_status } : {}),
    ...(item.disambiguation_needed !== undefined ? { disambiguation_needed: item.disambiguation_needed === true } : {}),
    ...(Array.isArray(item.possible_ids) && item.possible_ids.length ? { possible_ids: item.possible_ids.slice(0, 8) } : {}),
  };
}

function compactEvidence(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const compact = {
    type: entry.type || null,
    summary: entry.summary || null,
  };
  const preserveValueTypes = new Set([
    "augment.context_policy",
    "augments.ranked_recommendation",
    "augments.choice_candidates",
    "items.choice_options",
  ]);
  if (preserveValueTypes.has(entry.type) || ACTIVE_CHOICE_EVIDENCE_TYPES.has(entry.type)) {
    compact.value = entry.value || null;
  }
  return compact;
}

function compactTask(task) {
  if (!task || typeof task !== "object") return task;
  const gameRuleContract = task.game_rule_contract || null;
  const ruleConflicts = detectRuleConflictingDraftFields(task, gameRuleContract);
  const conflictingFieldNames = new Set(ruleConflicts.map((entry) => String(entry.field || "").replace(/^task\./, "")));
  const draftFields = {
    title: safeText(task.title),
    short_advice: safeText(task.short_advice),
    reason_summary: safeText(task.reason_summary),
    actions: asArray(task.actions).slice(0, 6),
  };
  for (const field of ["title", "short_advice", "reason_summary", "actions"]) {
    if (conflictingFieldNames.has(field)) delete draftFields[field];
  }
  return {
    task_id: task.task_id,
    trigger_id: task.trigger_id,
    task_identity: task.task_identity || task.task_contract?.identity?.task_identity || null,
    stage_round: task.stage_round || task.task_contract?.identity?.stage_round || null,
    ...(task.task_contract ? { task_contract: task.task_contract } : {}),
    ...(task.decision_trigger_id ? { decision_trigger_id: task.decision_trigger_id } : {}),
    ...(task.fixed_checkpoint_id ? { fixed_checkpoint_id: task.fixed_checkpoint_id } : {}),
    ...(task.fixed_checkpoint_stage_round ? { fixed_checkpoint_stage_round: task.fixed_checkpoint_stage_round } : {}),
    ...(task.event_key ? { event_key: task.event_key } : {}),
    ...(task.coach_content_agenda ? { coach_content_agenda: task.coach_content_agenda } : {}),
    priority: task.priority,
    value_score: numberOrNull(task.value_score),
    confidence: numberOrNull(task.confidence),
    ...draftFields,
    semantic_labels: asArray(task.semantic_labels).slice(0, 8),
    evidence: asArray(task.evidence).slice(0, 4).map(compactEvidence),
    ...(ruleConflicts.length ? {
      rule_conflict_warnings: ruleConflicts,
      draft_policy: "Conflicting backend draft wording was removed before host generation. Use evidence plus context.game_rule_contract/game_state_brief instead.",
    } : {}),
  };
}

function compactEvent(event) {
  if (!event || typeof event !== "object") return event;
  return {
    type: event.type,
    task_id: event.task_id || null,
    trigger_id: event.trigger_id || null,
    suppression_reason: event.suppression_reason || null,
    observed_at: event.observed_at || event.generated_at || null,
    mode: event.mode || null,
    previous_mode: event.previous_mode || null,
    output_policy: event.output_policy || null,
    scan_id: event.scan_id || null,
    scan_goal: event.scan_goal || null,
    snapshot_count: event.snapshot_count ?? null,
    response_id: event.response_id || null,
    reason: event.reason || null,
  };
}

function compactResponseEvent(event) {
  if (!event || typeof event !== "object") return event;
  if (event.type === "advice_response_requested") {
    return {
      type: event.type,
      response_id: event.response_id,
      task_id: event.task_id,
      trigger_id: event.trigger_id,
      mode: event.mode,
      urgency: event.urgency,
      confidence: event.confidence,
      output_reason: event.output_reason,
      status: event.status || null,
      final_response_required: event.final_response_required === true,
      user_visible_text: null,
      ai_native_policy: event.ai_native_policy
        ? {
            output_model: event.ai_native_policy.output_model || null,
            structure_is_guidance_not_cage: event.ai_native_policy.structure_is_guidance_not_cage === true,
            structured_envelope_required: event.ai_native_policy.structured_envelope_required === true,
            require_model_rendering: event.ai_native_policy.require_model_rendering === true,
            fallback_is_not_final_answer: event.ai_native_policy.fallback_is_not_final_answer === true,
            allow_model_to_rephrase: event.ai_native_policy.allow_model_to_rephrase === true,
            rendering_policy: event.ai_native_policy.rendering_policy || null,
          }
        : null,
      host_cli_agent_request_ref: event.host_cli_agent_request
        ? {
            schema: "jcc-host-request-ref-v1",
            request_id: event.host_cli_agent_request.request_id || event.response_id || null,
            request_hash: event.host_cli_agent_request.request_hash || null,
            mode: event.host_cli_agent_request.mode || event.mode || null,
            task_type: event.host_cli_agent_request.task?.type || null,
            trigger_id: event.host_cli_agent_request.task?.trigger_id || event.trigger_id || null,
            persistence_policy: "metadata_only_full_payload_is_runtime_memory_only",
          }
        : null,
      response_draft: {
        title: event.response_draft?.title || null,
        summary: event.response_draft?.summary || null,
        visible_text: null,
        recommended_action: event.response_draft?.recommended_action || null,
        confidence: event.response_draft?.confidence ?? null,
        urgency: event.response_draft?.urgency || null,
        expires_at: event.response_draft?.expires_at || null,
        evidence: asArray(event.response_draft?.evidence).slice(0, 4).map(compactEvidence),
        actions: asArray(event.response_draft?.actions).slice(0, 6),
        followup_sensing_request: event.response_draft?.followup_sensing_request || null,
      },
      followup_sensing_request: event.followup_sensing_request || null,
    };
  }
  return {
    type: event.type,
    task_id: event.task_id || null,
    trigger_id: event.trigger_id || null,
    reason: event.reason || event.output_policy || null,
    user_visible_text: event.user_visible_text || null,
  };
}

function buildLiveStateDebugSummary(standardizedLiveState) {
  return {
    match_session_id: standardizedLiveState.match_session_id,
    phase: {
      stage_round: standardizedLiveState.phase.stage_round.value,
      status: standardizedLiveState.phase.status.value,
    },
    economy: {
      gold: standardizedLiveState.economy.gold.value,
      hp: standardizedLiveState.economy.hp.value,
      level: standardizedLiveState.economy.level.value,
      xp: standardizedLiveState.economy.xp.value,
    },
    counts: {
      board_units: standardizedLiveState.own_board.units.length,
      bench_units: standardizedLiveState.own_bench.units.length,
      shop_units: standardizedLiveState.shop.units.length,
      item_bench: standardizedLiveState.items.item_bench.length,
      item_bench_candidates: standardizedLiveState.items.item_bench_candidates.length,
      equipped_items: standardizedLiveState.items.equipped_items.length,
      item_choice_options: standardizedLiveState.items.choice_options.length,
      selected_augments: standardizedLiveState.augments.selected_augments.length,
      selected_augment_candidates: standardizedLiveState.augments.selected_augment_candidates.length,
      augment_choice_candidates: standardizedLiveState.augments.choice_candidates.length,
      active_choice_options_by_mode: Object.fromEntries(
        Object.entries(standardizedLiveState.choices.by_mode || {}).map(([mode, rows]) => [mode, asArray(rows).length]),
      ),
    },
    samples: {
      board_units: standardizedLiveState.own_board.units.slice(0, 10).map(compactUnit),
      bench_units: standardizedLiveState.own_bench.units.slice(0, 10).map(compactUnit),
      shop_units: standardizedLiveState.shop.units.slice(0, 5).map(compactUnit),
      item_bench: standardizedLiveState.items.item_bench.slice(0, 8).map(compactItem),
      item_bench_candidates: standardizedLiveState.items.item_bench_candidates.slice(0, 8).map(compactItem),
      item_choice_options: standardizedLiveState.items.choice_options.slice(0, 5).map(compactItem),
      selected_augments: standardizedLiveState.augments.selected_augments.slice(0, 6).map(compactItem),
      selected_augment_candidates: standardizedLiveState.augments.selected_augment_candidates.slice(0, 6).map(compactItem),
      augment_choice_candidates: standardizedLiveState.augments.choice_candidates.slice(0, 3).map(compactItem),
      active_choice_options_by_mode: Object.fromEntries(
        Object.entries(standardizedLiveState.choices.by_mode || {}).map(([mode, rows]) => [
          mode,
          asArray(rows).slice(0, 6).map(compactItem),
        ]),
      ),
    },
    confidence_bands: {
      board: standardizedLiveState.own_board.confidence_band,
      bench: standardizedLiveState.own_bench.confidence_band,
      shop: standardizedLiveState.shop.confidence_band,
      items: standardizedLiveState.items.confidence_band,
      augments: standardizedLiveState.augments.confidence_band,
    },
    match_variable_keys: Object.keys(standardizedLiveState.match_variables.values || {}).slice(0, 24),
  };
}

function buildDebugTraceRecord(result) {
  const estimator = result.estimator_context?.context?.combat_cap_estimator || {};
  return {
    schema: "jcc-runtime-light-debug-trace-v1",
    generated_at: result.generated_at,
    match_session_id: result.match_session_id,
    mode: result.mode,
    storage_policy: {
      raw_screenshots_saved: false,
      raw_logcat_saved: false,
      full_live_state_saved: false,
      full_estimator_context_saved: false,
      content: "lightweight advice replay summary only",
    },
    live_state_summary: buildLiveStateDebugSummary(result.standardized_live_state),
    estimator_scores: {
      board_power_score: numberOrNull(estimator.board_power_score),
      item_power_score: numberOrNull(estimator.item_power_score),
      cap_power_score: numberOrNull(estimator.cap_power_score),
      economy_score: numberOrNull(estimator.economy_score),
      tempo_score: numberOrNull(estimator.tempo_score),
      survival_pressure_score: numberOrNull(estimator.survival_pressure_score),
      contest_density_score: numberOrNull(estimator.contest_density_score),
      expected_damage_risk: numberOrNull(estimator.expected_damage_risk),
      pivot_pressure_score: numberOrNull(estimator.pivot_pressure_score),
      estimator_policy: estimator.estimator_policy || null,
    },
    scorer: {
      advice_tasks: asArray(result.score?.advice_tasks).map(compactTask),
      suppressed_tasks: asArray(result.score?.suppressed_tasks).map((task) => ({
        ...compactTask(task),
        suppression_reason: task.suppression_reason || null,
        retry_after_seconds: task.retry_after_seconds || null,
      })),
    },
    lifecycle_events: asArray(result.events).map((event) => ({
      type: event.type,
      task_id: event.task_id || null,
      trigger_id: event.trigger_id || null,
      suppression_reason: event.suppression_reason || null,
      observed_at: event.observed_at || result.generated_at,
      mode: event.mode || null,
      previous_mode: event.previous_mode || null,
    })),
    response_events: asArray(result.response_events).map(compactResponseEvent),
    user_actions: {
      confirmed_tasks: asArray(result.lifecycle?.confirmed_tasks).slice(-10).map(compactTask),
      skipped_tasks: asArray(result.lifecycle?.skipped_tasks).slice(-10).map(compactTask),
      latest_user_message: result.lifecycle?.active_task_context?.user_message || null,
    },
  };
}

async function maybeRotateDebugTrace(file, maxMb) {
  const maxBytes = Math.max(1, numberOrNull(maxMb) ?? 8) * 1024 * 1024;
  if (!existsSync(file)) return;
  const info = await stat(file);
  if (info.size < maxBytes) return;
  const rotated = `${file}.1`;
  await rm(rotated, { force: true });
  await rename(file, rotated);
}

async function writeDebugTrace(result, options) {
  if (!options.debugTrace) return null;
  const tracePath = path.resolve(options.debugTrace);
  await mkdir(path.dirname(tracePath), { recursive: true });
  await maybeRotateDebugTrace(tracePath, options.debugMaxMb);
  const record = buildDebugTraceRecord(result);
  await appendFile(tracePath, `${JSON.stringify(record)}\n`, "utf8");
  return {
    path: tracePath,
    schema: record.schema,
    storage_policy: record.storage_policy,
  };
}

function compactLifecycle(lifecycle) {
  return {
    schema: lifecycle.schema,
    match_session_id: lifecycle.match_session_id,
    mode: lifecycle.mode,
    updated_at: lifecycle.updated_at,
    active_tasks: asArray(lifecycle.active_tasks).map(compactTask),
    confirmed_tasks: asArray(lifecycle.confirmed_tasks).slice(-20).map(compactTask),
    skipped_tasks: asArray(lifecycle.skipped_tasks).slice(-20).map(compactTask),
    expired_tasks: asArray(lifecycle.expired_tasks).slice(-20).map(compactTask),
    active_task_context_summary: {
      has_user_message: Boolean(lifecycle.active_task_context?.user_message),
    },
    match_context_summary: {
      user_constraints: asArray(lifecycle.match_context?.user_constraints).length,
      confirmed_actions: asArray(lifecycle.match_context?.confirmed_actions).length,
      skipped_actions: asArray(lifecycle.match_context?.skipped_actions).length,
      mode_history: asArray(lifecycle.match_context?.mode_history).slice(-12),
      manual_scouting_notes: asArray(lifecycle.match_context?.manual_scouting_notes).length,
    },
    previous_advice_state: {
      emitted_tasks: asArray(lifecycle.previous_advice_state?.emitted_tasks).slice(-40),
    },
    output_history: asArray(lifecycle.output_history).slice(-40),
  };
}

function compactScore(score) {
  return {
    schema: score?.schema || null,
    generated_at: score?.generated_at || null,
    advice_tasks: asArray(score?.advice_tasks).map(compactTask),
    suppressed_tasks: asArray(score?.suppressed_tasks).map((task) => ({
      ...compactTask(task),
      suppression_reason: task.suppression_reason || null,
      retry_after_seconds: task.retry_after_seconds || null,
    })),
    live_state_summary: score?.live_state_summary || null,
    interrupt_policy: score?.interrupt_policy || null,
  };
}

function compactSourceContext(sourceContext) {
  return {
    has_target_plan: Boolean(sourceContext?.target_plan || sourceContext?.strategy?.target_plan || sourceContext?.current_plan),
    has_active_user_message: Boolean(sourceContext?.user_context?.active_user_message),
    active_mode: sourceContext?.user_context?.active_mode || null,
    cruise_context_constraints: asArray(sourceContext?.user_context?.cruise_context_constraints).length,
    user_context_constraints: asArray(sourceContext?.user_context?.constraints).length,
    runtime_user_settings: sourceContext?.runtime_user_settings || {},
    user_memory_summary: {
      preferences: asArray(sourceContext?.user_memory?.preferences).length,
      habits: asArray(sourceContext?.user_memory?.habits).length,
      strategy_rows: asArray(sourceContext?.user_memory?.strategy_rows).length,
      strategy_conflict_notices: asArray(sourceContext?.user_memory?.strategy_conflict_notices).length,
    },
    recent_matches_dir_configured: Boolean(sourceContext?.recent_matches_dir),
  };
}

function buildRedactedPipelineResult(result) {
  const estimator = result.estimator_context?.context?.combat_cap_estimator || {};
  return {
    schema: "jcc-cruise-runtime-pipeline-result-redacted-v1",
    original_schema: result.schema,
    match_session_id: result.match_session_id,
    generated_at: result.generated_at,
    mode: result.mode,
    storage_policy: {
      raw_screenshots_saved: false,
      raw_logcat_saved: false,
      full_live_state_saved: false,
      full_estimator_context_saved: false,
      full_source_context_saved: false,
      content: "redacted pipeline result for replay/status/stdout by default",
      full_state_escape_hatch: "--retain-full-state",
    },
    source_context_summary: compactSourceContext(result.source_context || {}),
    standardized_live_state_summary: buildLiveStateDebugSummary(result.standardized_live_state),
    estimator_scores: {
      board_power_score: numberOrNull(estimator.board_power_score),
      item_power_score: numberOrNull(estimator.item_power_score),
      cap_power_score: numberOrNull(estimator.cap_power_score),
      economy_score: numberOrNull(estimator.economy_score),
      tempo_score: numberOrNull(estimator.tempo_score),
      survival_pressure_score: numberOrNull(estimator.survival_pressure_score),
      contest_density_score: numberOrNull(estimator.contest_density_score),
      expected_damage_risk: numberOrNull(estimator.expected_damage_risk),
      pivot_pressure_score: numberOrNull(estimator.pivot_pressure_score),
      target_coverage_score: numberOrNull(estimator.target_coverage_score),
      estimator_policy: estimator.estimator_policy || null,
    },
    score: compactScore(result.score),
    lifecycle: compactLifecycle(result.lifecycle),
    events: asArray(result.events).map(compactEvent),
    response_events: asArray(result.response_events).map(compactResponseEvent),
    debug_trace: result.debug_trace || null,
  };
}

function dedupeRecentUserMessages(messages, limit = 24) {
  const seen = new Set();
  const deduped = [];
  for (const entry of asArray(messages).slice().reverse()) {
    const text = String(entry?.text || entry?.message || entry || "").trim();
    if (!text) continue;
    const mode = String(entry?.mode || "");
    const observedAt = String(entry?.observed_at || entry?.at || "");
    const key = `${text}\u0000${mode}\u0000${observedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped.reverse().slice(-limit);
}

function mergeActiveUserMessageIntoSourceContext(sourceContext, previousLifecycle, options, now) {
  const mode = options.mode || previousLifecycle?.mode || "cruise";
  const message = options.userMessage || null;
  const activeMatchSessionId = previousLifecycle?.match_session_id || null;
  const matchConstraints = asArray(previousLifecycle?.match_context?.user_constraints).slice(-20);
  const sourceMatchContext = sourceContext.match_context || {};
  const previousMatchContext = cleanMatchContextExtras(previousLifecycle.match_context);
  const cleanSourceMatchContext = sameMatchContext(sourceMatchContext, activeMatchSessionId)
    ? cleanMatchContextExtras(sourceMatchContext)
    : {};
  const sourceChoiceConfirmations = sameMatchEntries(sourceContext.choice_confirmations, activeMatchSessionId);
  const sourceMissingChoicePrompts = sameMatchEntries(sourceContext.missing_choice_prompts, activeMatchSessionId);
  const contextRecentMessages = [
    ...asArray(sourceContext.recent_user_messages),
    ...asArray(cleanSourceMatchContext.recent_user_messages),
  ].slice(-12);
  previousLifecycle.match_context = {
    ...previousMatchContext,
    recent_user_messages: dedupeRecentUserMessages([
      ...asArray(previousMatchContext.recent_user_messages),
      ...contextRecentMessages,
    ]),
    observed_choice_options_by_stage: {
      ...(previousMatchContext.observed_choice_options_by_stage || {}),
      ...(sourceContext.observed_choice_options_by_stage || {}),
      ...(cleanSourceMatchContext.observed_choice_options_by_stage || {}),
    },
    reported_choice_sets_by_mode: {
      ...(previousMatchContext.reported_choice_sets_by_mode || {}),
      ...(sourceContext.reported_choice_sets_by_mode || {}),
      ...(cleanSourceMatchContext.reported_choice_sets_by_mode || {}),
    },
    reported_choice_sets: [
      ...sameMatchEntries(previousMatchContext.reported_choice_sets, activeMatchSessionId),
      ...sameMatchEntries(sourceContext.reported_choice_sets, activeMatchSessionId),
      ...sameMatchEntries(cleanSourceMatchContext.reported_choice_sets, activeMatchSessionId),
    ].slice(-20),
    choice_confirmations: [
      ...sameMatchEntries(previousMatchContext.choice_confirmations, activeMatchSessionId),
      ...sourceChoiceConfirmations,
      ...sameMatchEntries(cleanSourceMatchContext.choice_confirmations, activeMatchSessionId),
    ].slice(-24),
    missing_choice_prompts: [
      ...sameMatchEntries(previousMatchContext.missing_choice_prompts, activeMatchSessionId),
      ...sourceMissingChoicePrompts,
      ...sameMatchEntries(cleanSourceMatchContext.missing_choice_prompts, activeMatchSessionId),
    ].slice(-24),
    manual_scouting_notes: [
      ...asArray(previousMatchContext.manual_scouting_notes),
      ...asArray(sourceContext.manual_scouting_notes),
      ...asArray(cleanSourceMatchContext.manual_scouting_notes),
    ].slice(-20),
    match_variables: {
      ...(previousMatchContext.match_variables || {}),
      ...(cleanSourceMatchContext.match_variables || {}),
      ...(sourceContext.match_variables || {}),
    },
    target_plan: cleanSourceMatchContext.target_plan || previousMatchContext.target_plan || sourceContext.target_plan || null,
  };
  const existingConstraints = asArray(sourceContext.user_context?.constraints);
  const constraints = [
    ...matchConstraints.map((entry) => ({
      ...entry,
      source: entry.source || "match_cruise_context",
    })),
    ...existingConstraints,
  ];
  if (!message && !constraints.length) return;
  if (message) {
    const recentUserMessages = asArray(previousLifecycle.match_context?.recent_user_messages);
    recentUserMessages.push({
      text: message,
      mode,
      observed_at: now,
      source: "active_task_chat",
    });
    previousLifecycle.match_context.recent_user_messages = dedupeRecentUserMessages(recentUserMessages);
    constraints.push({
      message,
      mode,
      observed_at: now,
      source: "active_task_chat",
    });
  }
  sourceContext.user_context = {
    ...(sourceContext.user_context || {}),
    active_user_message: message,
    active_mode: mode,
    active_user_message_observed_at: message ? now : null,
    constraints,
    cruise_context_constraints: matchConstraints,
  };
  sourceContext.match_context = {
    ...cleanMatchContextExtras(sourceContext.match_context),
    recent_user_messages: dedupeRecentUserMessages(previousLifecycle.match_context?.recent_user_messages, 12),
    observed_choice_options_by_stage: previousLifecycle.match_context?.observed_choice_options_by_stage || null,
    reported_choice_sets_by_mode: previousLifecycle.match_context?.reported_choice_sets_by_mode || null,
    reported_choice_sets: asArray(previousLifecycle.match_context?.reported_choice_sets).slice(-12),
    choice_confirmations: asArray(previousLifecycle.match_context?.choice_confirmations).slice(-12),
    missing_choice_prompts: asArray(previousLifecycle.match_context?.missing_choice_prompts).slice(-12),
    manual_scouting_notes: asArray(previousLifecycle.match_context?.manual_scouting_notes).slice(-12),
    match_variables: previousLifecycle.match_context?.match_variables || sourceContext.match_variables || null,
    target_plan: previousLifecycle.match_context?.target_plan || sourceContext.target_plan || null,
    latest_user_constraint: message ? {
      message,
      mode,
      observed_at: now,
    } : sourceContext.match_context?.latest_user_constraint || matchConstraints.at(-1) || null,
  };
}

function buildOutputEvents({ events, lifecycle, standardizedLiveState, estimatorContext, sourceContext, now }) {
  const outputEvents = [];
  const taskRecords = [];
  const recordedTaskIds = new Set();
  const eligibleTypes = new Set(["advice_task_created", "advice_task_updated"]);
  const userInitiated = Boolean(sourceContext.force_response_reason || sourceContext.user_context?.active_user_message);
  const manualModeUserRequest = isManualModeUserRequest(sourceContext);
  const activeMode = lifecycle.mode || "cruise";
  function addTaskRecord(task, source) {
    if (!task || recordedTaskIds.has(task.task_id)) return;
    recordedTaskIds.add(task.task_id);
    let recordOnlyReason = null;
    let gate = null;
    if (activeMode === "cruise" && isChoiceModeTask(task)) {
      recordOnlyReason = "choice_mode_task_not_spoken_in_background_cruise";
    } else if (
      manualModeUserRequest
      && activeMode !== "cruise"
      && !["user_message_response", "runtime_event_followup"].includes(String(task.trigger_id || ""))
      && !taskMatchesActiveMode(task, lifecycle.mode)
    ) {
      recordOnlyReason = "manual_active_mode_user_request_yields_to_matching_mode_task";
    } else if (
      activeMode !== "cruise"
      && !["user_message_response", "runtime_event_followup"].includes(String(task.trigger_id || ""))
      && !taskMatchesActiveMode(task, lifecycle.mode)
    ) {
      recordOnlyReason = "non_matching_active_mode_task";
    } else {
      gate = shouldSpeakTask(task, sourceContext, lifecycle);
      if (!gate.speak) recordOnlyReason = gate.reason;
    }
    if (
      !recordOnlyReason
      && !userInitiated
      && (
        hasRecentResponseRequest(task, lifecycle, now)
        || (activeMode === "cruise" && hasRecentSemanticResponseRequest(task, lifecycle, standardizedLiveState, now))
      )
    ) {
      recordOnlyReason = "host_response_request_cooldown";
    }
    taskRecords.push({
      task,
      source,
      gateReason: gate?.reason || null,
      recordOnlyReason,
      ownerRank: responseOwnerRank(task, lifecycle),
    });
  }
  for (const event of events) {
    if (!eligibleTypes.has(event.type)) continue;
    const task = lifecycle.active_tasks.find((entry) => entry.task_id === event.task_id);
    addTaskRecord(task, "current_run_event");
  }
  // A lower-value event can arrive while the current fixed checkpoint is
  // still pending. Include that obligation in the same Owner decision even
  // when it was created by an earlier run and was not touched this run.
  for (const task of lifecycle.active_tasks) {
    if (isCurrentStrategicCheckpointTask(task, standardizedLiveState)) {
      addTaskRecord(task, "current_strategic_checkpoint");
    }
  }
  if (!taskRecords.some((record) => !record.recordOnlyReason)) {
    for (const task of chooseTasksForOutput(lifecycle.active_tasks, lifecycle)) {
      if (!userInitiated && !taskWasTouchedThisRun(task, events)) continue;
      addTaskRecord(task, "active_task_fallback");
      if (taskRecords.some((record) => !record.recordOnlyReason)) break;
    }
  }
  const ownerRecord = taskRecords
    .filter((record) => !record.recordOnlyReason)
    .sort((left, right) => {
      const owner = left.ownerRank - right.ownerRank;
      if (owner !== 0) return owner;
      const priority = (PRIORITY_RANK[right.task.priority] || 0) - (PRIORITY_RANK[left.task.priority] || 0);
      if (priority !== 0) return priority;
      return (right.task.value_score || 0) - (left.task.value_score || 0);
    })[0] || null;
  for (const record of taskRecords) {
    if (ownerRecord && record.task.task_id === ownerRecord.task.task_id) {
      outputEvents.push(buildAdviceResponse(
        record.task,
        lifecycle,
        standardizedLiveState,
        estimatorContext,
        sourceContext,
        now,
        record.gateReason || responseOwnerLabel(record.ownerRank),
      ));
      continue;
    }
    outputEvents.push({
      type: "advice_response_recorded_only",
      task_id: record.task.task_id,
      trigger_id: record.task.trigger_id,
      reason: record.recordOnlyReason || `${responseOwnerLabel(ownerRecord?.ownerRank || 4)}_owns_response`,
      observed_at: now,
    });
  }
  return outputEvents;
}



function applyLifecycle({ lifecycle, score, options, now, sourceContext, standardizedLiveState }) {
  const events = [];
  const sourceMatchContext = sourceContext?.match_context || null;
  if (sourceMatchContext && sameMatchContext(sourceMatchContext, lifecycle.match_session_id)) {
    const currentMatchEquipment = currentMatchScopedFact(
      sourceMatchContext.user_confirmed_equipment,
      lifecycle.match_session_id,
    );
    if (currentMatchEquipment) {
      lifecycle.match_context.user_confirmed_equipment = currentMatchEquipment;
    }
    if (exactSameMatchContext(sourceMatchContext, lifecycle.match_session_id)
      && Array.isArray(sourceMatchContext.equipment_context_prompts)) {
      lifecycle.match_context.equipment_context_prompts = sourceMatchContext.equipment_context_prompts.slice(-8);
    }
  }
  events.push(...expireTasks(lifecycle, now));
  if (!options.userMessage) {
    delete lifecycle.active_task_context.user_message;
    delete lifecycle.active_task_context.user_message_observed_at;
  }
  if (options.mode && options.mode !== lifecycle.mode) {
    const previousMode = lifecycle.mode;
    lifecycle.mode = options.mode;
    const nextActiveTaskContext = {
      ...lifecycle.active_task_context,
      mode_started_at: now,
      mode: options.mode,
    };
    if (!options.userMessage) {
      delete nextActiveTaskContext.user_message;
      delete nextActiveTaskContext.user_message_observed_at;
    }
    lifecycle.active_task_context = nextActiveTaskContext;
    lifecycle.match_context.mode_history.push({ from: previousMode, to: options.mode, observed_at: now });
    events.push({ type: "runtime_mode_changed", previous_mode: previousMode, mode: options.mode, observed_at: now });
  }
  if (options.finishMode && lifecycle.mode !== "cruise") {
    const previousMode = lifecycle.mode;
    lifecycle.mode = "cruise";
    lifecycle.active_task_context = {
      ...lifecycle.active_task_context,
      mode_finished_at: now,
      previous_mode: previousMode,
    };
    lifecycle.match_context.mode_history.push({ from: previousMode, to: "cruise", reason: "finish_mode", observed_at: now });
    events.push({ type: "runtime_mode_returned_to_cruise", previous_mode: previousMode, observed_at: now });
  }
  if (options.userMessage) {
    const nextContext = {
      ...lifecycle.active_task_context,
      user_message: options.userMessage,
      user_message_observed_at: now,
    };
    lifecycle.active_task_context = {
      ...nextContext,
    };
    lifecycle.match_context.user_constraints.push({
      message: options.userMessage,
      mode: lifecycle.mode || "cruise",
      observed_at: now,
    });
    events.push({ type: "user_message_received", message: options.userMessage, observed_at: now });
  }
  if (options.confirmTaskId) {
    const task = lifecycle.active_tasks.find((entry) => entry.task_id === options.confirmTaskId) || { task_id: options.confirmTaskId };
    lifecycle.active_tasks = lifecycle.active_tasks.filter((entry) => entry.task_id !== options.confirmTaskId);
    lifecycle.confirmed_tasks.push({ ...task, confirmed_at: now });
    lifecycle.match_context.confirmed_actions.push({
      task_id: options.confirmTaskId,
      trigger_id: task.trigger_id || null,
      mode: lifecycle.mode || "cruise",
      confirmed_at: now,
      actions: asArray(task.actions),
    });
    events.push({ type: "advice_task_confirmed", task_id: options.confirmTaskId, observed_at: now });
    if (lifecycle.mode !== "cruise") {
      const previousMode = lifecycle.mode;
      lifecycle.mode = "cruise";
      lifecycle.match_context.mode_history.push({ from: previousMode, to: "cruise", reason: "task_confirmed", observed_at: now });
      events.push({ type: "runtime_mode_returned_to_cruise", previous_mode: previousMode, reason: "task_confirmed", observed_at: now });
    }
  }
  if (options.skipTaskId) {
    const task = lifecycle.active_tasks.find((entry) => entry.task_id === options.skipTaskId) || { task_id: options.skipTaskId };
    lifecycle.active_tasks = lifecycle.active_tasks.filter((entry) => entry.task_id !== options.skipTaskId);
    lifecycle.skipped_tasks.push({ ...task, skipped_at: now });
    lifecycle.match_context.skipped_actions.push({
      task_id: options.skipTaskId,
      trigger_id: task.trigger_id || null,
      mode: lifecycle.mode || "cruise",
      skipped_at: now,
    });
    events.push({ type: "advice_task_skipped", task_id: options.skipTaskId, observed_at: now });
    if (lifecycle.mode !== "cruise") {
      const previousMode = lifecycle.mode;
      lifecycle.mode = "cruise";
      lifecycle.match_context.mode_history.push({ from: previousMode, to: "cruise", reason: "task_skipped", observed_at: now });
      events.push({ type: "runtime_mode_returned_to_cruise", previous_mode: previousMode, reason: "task_skipped", observed_at: now });
    }
  }

  for (const task of asArray(score.advice_tasks)) {
    const taskContract = buildTaskContract(task, {
      ...sourceContext,
      stage_round: taskStageIdentity(task, sourceContext)
        || standardizedLiveState?.phase?.stage_round?.value
        || null,
    });
    const taskWithContract = { ...task, task_contract: taskContract };
    const mergeIndex = mergeTaskIndex(lifecycle, taskWithContract, sourceContext);
    if (mergeIndex < 0) {
      lifecycle.active_tasks.push({
        task_id: task.task_id,
        trigger_id: task.trigger_id,
        task_identity: taskContract.identity.task_identity,
        stage_round: taskContract.identity.stage_round,
        ...taskDecisionMetadata(task),
        task_contract: taskContract,
        priority: task.priority,
        value_score: task.value_score,
        confidence: task.confidence,
        title: task.title,
        short_advice: task.short_advice,
        reason_summary: task.reason_summary || null,
        evidence: asArray(task.evidence).slice(0, 8),
        actions: asArray(task.actions),
        semantic_labels: asArray(task.semantic_labels),
        created_at: now,
        updated_at: now,
        expires_at: taskExpiresAt(task, sourceContext, now),
        update_count: 0,
      });
      events.push({ type: "advice_task_created", task_id: task.task_id, trigger_id: task.trigger_id, observed_at: now });
    } else {
      const previous = lifecycle.active_tasks[mergeIndex];
      lifecycle.active_tasks[mergeIndex] = {
        ...taskWithoutDecisionMetadata(previous),
        task_id: task.task_id,
        trigger_id: task.trigger_id,
        task_identity: taskContract.identity.task_identity,
        stage_round: taskContract.identity.stage_round,
        ...taskDecisionMetadata(task),
        task_contract: taskContract,
        priority: task.priority,
        value_score: task.value_score,
        confidence: task.confidence,
        title: task.title,
        short_advice: task.short_advice,
        reason_summary: task.reason_summary || previous.reason_summary || null,
        evidence: asArray(task.evidence).slice(0, 8),
        actions: asArray(task.actions),
        semantic_labels: asArray(task.semantic_labels),
        updated_at: now,
        expires_at: taskExpiresAt(task, sourceContext, now),
        update_count: (previous.update_count || 0) + 1,
      };
      events.push({ type: "advice_task_updated", task_id: task.task_id, trigger_id: task.trigger_id, observed_at: now });
    }
    lifecycle.previous_advice_state.emitted_tasks.push({
      task_id: task.task_id,
      trigger_id: task.trigger_id,
      emitted_at: now,
    });
  }
  for (const task of asArray(score.suppressed_tasks)) {
    events.push({
      type: "advice_task_suppressed",
      task_id: task.task_id,
      trigger_id: task.trigger_id,
      suppression_reason: task.suppression_reason,
      retry_after_seconds: task.retry_after_seconds || null,
      observed_at: now,
    });
  }

  lifecycle.previous_advice_state.now = now;
  lifecycle.previous_advice_state.emitted_tasks = lifecycle.previous_advice_state.emitted_tasks.slice(-200);
  lifecycle.confirmed_tasks = lifecycle.confirmed_tasks.slice(-100);
  lifecycle.skipped_tasks = lifecycle.skipped_tasks.slice(-100);
  lifecycle.expired_tasks = lifecycle.expired_tasks.slice(-100);
  lifecycle.output_history = asArray(lifecycle.output_history).slice(-100);
  lifecycle.match_context.user_constraints = asArray(lifecycle.match_context.user_constraints).slice(-80);
  lifecycle.match_context.confirmed_actions = asArray(lifecycle.match_context.confirmed_actions).slice(-80);
  lifecycle.match_context.skipped_actions = asArray(lifecycle.match_context.skipped_actions).slice(-80);
  lifecycle.match_context.mode_history = asArray(lifecycle.match_context.mode_history).slice(-80);
  lifecycle.match_context.recent_user_messages = dedupeRecentUserMessages(lifecycle.match_context.recent_user_messages);
  lifecycle.match_context.reported_choice_sets = asArray(lifecycle.match_context.reported_choice_sets).slice(-20);
  lifecycle.match_context.choice_confirmations = asArray(lifecycle.match_context.choice_confirmations).slice(-24);
  lifecycle.match_context.missing_choice_prompts = asArray(lifecycle.match_context.missing_choice_prompts).slice(-24);
  lifecycle.match_context.manual_scouting_notes = asArray(lifecycle.match_context.manual_scouting_notes).slice(-20);
  lifecycle.updated_at = now;
  return events;
}

function mergeAdditionalAdviceTasks(score, tasks) {
  if (!tasks.length) return score;
  return {
    ...score,
    advice_tasks: [...asArray(score.advice_tasks), ...tasks]
      .sort((left, right) => (right.value_score || 0) - (left.value_score || 0)),
  };
}

async function runPipeline(options) {
  const now = options.now || new Date().toISOString();
  const liveState = await readJson(options.liveState);
  const sourceContext = options.context ? await readJson(options.context, {}) : {};
  const runtimeUserSettings = options.runtimeUserSettings && typeof options.runtimeUserSettings === "object"
    ? structuredClone(options.runtimeUserSettings)
    : await readJson(options.userSettings, {});
  const userMemory = options.userMemorySnapshot && typeof options.userMemorySnapshot === "object"
    ? structuredClone(options.userMemorySnapshot)
    : await readJson(options.userMemory, {});
  if (Object.keys(runtimeUserSettings || {}).length) sourceContext.runtime_user_settings = runtimeUserSettings;
  if (Object.keys(userMemory || {}).length) sourceContext.user_memory = userMemory;
  if (options.recentMatchesDir) sourceContext.recent_matches_dir = options.recentMatchesDir;
  if (options.forceResponseReason) sourceContext.force_response_reason = options.forceResponseReason;
  if (options.runtimeEventContextJson) {
    try {
      sourceContext.runtime_event_context = JSON.parse(options.runtimeEventContextJson);
    } catch (error) {
      throw new Error(`Invalid --runtime-event-context-json: ${error.message || String(error)}`);
    }
  }
  const matchSessionId = collectMatchSessionId(liveState);
  const previousLifecycle = normalizeLifecycle(await readJson(options.adviceState, null), matchSessionId, now);
  mergeActiveUserMessageIntoSourceContext(sourceContext, previousLifecycle, options, now);
  const standardizedLiveState = buildStandardLiveState(liveState, sourceContext, now);
  const scoringMatchContext = sourceContext.match_context || previousLifecycle.match_context || null;
  const scoringLiveState = buildScoringLiveState(standardizedLiveState, scoringMatchContext);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-cruise-scoring-live-state-"));
  let estimatorContext;
  try {
    const scoringLiveStateFile = path.join(tempDir, "live-state.json");
    await writeFile(scoringLiveStateFile, `${JSON.stringify(scoringLiveState, null, 2)}\n`, "utf8");
    estimatorContext = await buildContext({
      liveState: scoringLiveStateFile,
      context: options.context,
      liveRankings: options.liveRankings,
      profileContext: CRUISE_RUNTIME_PROFILE_CONTEXT,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  const scoringContext = {
    ...(estimatorContext.context || {}),
    ...sourceContext,
    live_rankings_context: estimatorContext.context?.live_rankings_context || {},
    active_choice_mode_contracts: ACTIVE_CHOICE_MODE_CONTRACTS,
    equipment_context: buildPipelineEquipmentContext(standardizedLiveState, scoringMatchContext),
    previous_advice_state: previousLifecycle.previous_advice_state,
  };
  if (sourceContext.minimum_value_score_to_speak !== undefined) {
    scoringContext.minimum_value_score_to_speak = sourceContext.minimum_value_score_to_speak;
  }
  const normalizedStrategyContext = normalizeStrategyContext(scoringContext);
  const rawScore = mergeAdditionalAdviceTasks(
    scoreLiveState(scoringLiveState, scoringContext),
    [
      buildUserMessageAdviceTask(sourceContext, previousLifecycle, standardizedLiveState, now),
      buildRuntimeEventFollowupAdviceTask(sourceContext, standardizedLiveState, now),
      ...buildDataSourceAdviceTasks(standardizedLiveState, now),
    ]
      .filter(Boolean)
      .map((task) => applyUserSettingsToTask(task, normalizedStrategyContext)),
  );
  const score = filterPipelineHostTasks(rawScore, sourceContext);
  const lifecycle = normalizeLifecycle(previousLifecycle, matchSessionId, now);
  retireLegacyNonHostTasks(lifecycle, now, sourceContext);
  const events = applyLifecycle({ lifecycle, score, options, now, sourceContext, standardizedLiveState });
  const responseEvents = buildOutputEvents({ events, lifecycle, standardizedLiveState, estimatorContext, sourceContext, now });
  lifecycle.output_history.push(...responseEvents.map((event) => ({
    type: event.type,
    response_id: event.response_id || null,
    task_id: event.task_id,
    trigger_id: event.trigger_id,
    semantic_key: event.type === "advice_response_requested"
      ? taskSemanticKey(event.host_cli_agent_request?.task || { trigger_id: event.trigger_id }, standardizedLiveState)
      : null,
    observed_at: now,
  })));
  return {
    schema: "jcc-cruise-runtime-pipeline-result-v1",
    match_session_id: matchSessionId,
    generated_at: now,
    source_context: sourceContext,
    mode: lifecycle.mode,
    standardized_live_state: standardizedLiveState,
    estimator_context: estimatorContext,
    core_profile_id: CRUISE_RUNTIME_PROFILE_CONTEXT.core_profile_id,
    score,
    lifecycle,
    events,
    response_events: responseEvents,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.liveState) throw new Error("--live-state is required");
  const result = await runPipeline(options);
  const persisted = await persistPipelineResult(result, options);
  process.stdout.write(`${JSON.stringify(persisted.stdout_summary)}\n`);
}

async function persistPipelineResult(result, options = {}) {
  const debugTrace = await writeDebugTrace(result, options);
  if (debugTrace) result.debug_trace = debugTrace;
  const lifecyclePath = path.resolve(options.adviceState);
  await mkdir(path.dirname(lifecyclePath), { recursive: true });
  const persistedLifecycle = boundedLifecycleForPersistence(result.lifecycle);
  await writeFile(lifecyclePath, `${JSON.stringify(persistedLifecycle, null, 2)}\n`, "utf8");
  const outputResult = options.retainFullState ? result : buildRedactedPipelineResult(result);
  const json = `${JSON.stringify(outputResult, null, 2)}\n`;
  if (options.out) {
    await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await writeFile(options.out, json, "utf8");
  }
  return {
    output_result: outputResult,
    stdout_summary: {
      schema: "jcc-cruise-runtime-pipeline-output-ref-v1",
      output_file: options.out ? path.resolve(options.out) : null,
      match_session_id: outputResult.match_session_id || null,
      generated_at: outputResult.generated_at || null,
      mode: outputResult.mode || null,
      response_count: asArray(outputResult.response_events).length,
      storage_policy: "metadata_only_stdout",
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export {
  applyLifecycle,
  buildTaskContract,
  buildRuntimeEventFollowupAdviceTask,
  buildRedactedPipelineResult,
  buildStandardLiveState,
  compactPipelineRankingCandidate,
  expireTasks,
  providerOwnsTaskExecution,
  pipelineTaskIsPersistentStrategic,
  pipelineTaskMayOpenHost,
  persistPipelineResult,
  runPipeline,
  taskTtlSeconds,
};
