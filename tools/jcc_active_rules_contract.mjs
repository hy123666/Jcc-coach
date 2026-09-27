import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { choiceCheckpointSemanticTerms } from "./jcc_choice_checkpoint_contract.mjs";

function readJsonFile(file, { required = true } = {}) {
  if (!file || !existsSync(file)) {
    if (!required) return null;
    throw new Error(`Required JCC runtime rule file is missing: ${file}`);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (!required) return null;
    throw new Error(`Required JCC runtime rule file is invalid: ${file}: ${error.message || String(error)}`);
  }
}

function repoRelative(repoRoot, file) {
  return file ? path.relative(repoRoot, file).replaceAll("\\", "/") : null;
}

function rulesFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function commonDoctrineBySourceKey(coreKnowledgeBundle) {
  const entries = coreKnowledgeBundle?.common?.complete_game_doctrine?.entries;
  if (!Array.isArray(entries)) throw new Error("Active Core Profile is missing complete_game_doctrine entries");
  return Object.fromEntries(entries.map((entry) => [String(entry?.source_key || ""), entry?.content]));
}

function composeBaseGameRules(coreKnowledgeBundle, runtimeCommonContract) {
  if (runtimeCommonContract?.schema !== "jcc-runtime-common-choice-contract-v1") {
    throw new Error("Runtime common choice contract is missing or invalid");
  }
  const doctrine = commonDoctrineBySourceKey(coreKnowledgeBundle);
  return {
    schema: "jcc-base-game-rules-v1",
    scope: "base_game",
    selection_fact_policy: runtimeCommonContract.selection_fact_policy,
    runtime_choice_modes: runtimeCommonContract.runtime_choice_modes,
    coach_decision_model: doctrine.coach_decision_model,
    itemization_management: doctrine.itemization_management,
    economy_management: doctrine.economy_management,
    lineup_lifecycle_management: doctrine.lineup_lifecycle_management,
    host_model_invariants: doctrine.host_model_invariants,
  };
}

function loadProfileBackedRuleLayers(runtimePaths) {
  const coreKnowledgeBundle = runtimePaths.activeCoreKnowledgeBundle;
  const runtimeContractFile = runtimePaths.runtimeCommonChoiceContractFile;
  if (!coreKnowledgeBundle || !runtimeContractFile) return null;
  if (
    coreKnowledgeBundle.profile?.season_id !== runtimePaths.activeSeasonId
    || coreKnowledgeBundle.profile?.patch_id !== runtimePaths.activePatchId
  ) return null;
  const descriptor = coreKnowledgeBundle.season;
  if (descriptor?.runtime_contract?.schema !== "jcc-season-runtime-contract-v1") {
    throw new Error("Active Core Profile season descriptor is missing runtime_contract");
  }
  return {
    baseGameRules: composeBaseGameRules(coreKnowledgeBundle, readJsonFile(runtimeContractFile)),
    sourceSeasonNormalRules: structuredClone(descriptor.runtime_contract.normal_rules),
    sourceSeasonSpecialRules: structuredClone(descriptor.runtime_contract.special_rules),
    sourceAuthority: "game_knowledge_active_profile",
  };
}

const ALLOWED_PATCH_RULE_OVERRIDE_SURFACES = new Set([
  "normal_rules.choice_mechanics",
  "normal_rules.choice_pretriggers",
  "normal_rules.stage_decision_tasks",
  "normal_rules.stage_strategy_protocol",
  "normal_rules.host_model_invariants",
  "normal_rules.missing_choice_followups",
  "special_rules.mechanics.choice_mechanics",
  "special_rules.mechanics.choice_pretriggers",
  "special_rules.mechanics.match_variables",
  "special_rules.mechanics.manual_variable_fields",
  "special_rules.mechanics.stage_decision_tasks",
  "special_rules.mechanics.stage_strategy_protocol",
  "special_rules.host_mode_addons",
  "special_rules.host_mode_aliases",
  "special_rules.manual_variable_coach",
  "special_rules.host_model_invariants",
  "special_rules.missing_choice_followups",
]);

function nestedValue(root, segments) {
  return segments.reduce((value, segment) => value?.[segment], root);
}

function replaceNestedValue(root, segments, value) {
  if (!segments.length) return value;
  const [head, ...tail] = segments;
  return {
    ...(root && typeof root === "object" && !Array.isArray(root) ? root : {}),
    [head]: replaceNestedValue(root?.[head], tail, value),
  };
}

function collectOverrideLeafPaths(value, prefix) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  const entries = Object.entries(value);
  if (!entries.length) return [prefix];
  return entries.flatMap(([key, child]) => collectOverrideLeafPaths(child, `${prefix}.${key}`));
}

function applyDeclaredPatchRuleOverrides(sourceNormalRules, sourceSpecialRules, patchRuleOverrides) {
  if (!patchRuleOverrides) {
    return { seasonNormalRules: sourceNormalRules, seasonSpecialRules: sourceSpecialRules };
  }
  const declared = [...new Set(patchRuleOverrides.changed_rule_surfaces.map((surface) => String(surface || "").trim()).filter(Boolean))];
  if (!declared.length) throw new Error("Patch rule override must declare non-empty changed_rule_surfaces");
  for (const surface of declared) {
    if (!ALLOWED_PATCH_RULE_OVERRIDE_SURFACES.has(surface)) {
      throw new Error(`Patch rule override surface is not allowed: ${surface}`);
    }
  }
  for (let left = 0; left < declared.length; left += 1) {
    for (let right = left + 1; right < declared.length; right += 1) {
      if (declared[left].startsWith(`${declared[right]}.`) || declared[right].startsWith(`${declared[left]}.`)) {
        throw new Error(`Patch rule override surfaces must not overlap: ${declared[left]} / ${declared[right]}`);
      }
    }
  }
  const payloadPaths = [
    ...collectOverrideLeafPaths(patchRuleOverrides.normal_rules_override || {}, "normal_rules"),
    ...collectOverrideLeafPaths(patchRuleOverrides.special_rules_override || {}, "special_rules"),
  ].filter((surface) => !["normal_rules", "special_rules"].includes(surface));
  for (const payloadPath of payloadPaths) {
    if (!declared.some((surface) => payloadPath === surface || payloadPath.startsWith(`${surface}.`))) {
      throw new Error(`Patch rule override payload contains undeclared surface: ${payloadPath}`);
    }
  }
  let seasonNormalRules = sourceNormalRules;
  let seasonSpecialRules = sourceSpecialRules;
  for (const surface of declared) {
    const [scope, ...segments] = surface.split(".");
    const overrideRoot = scope === "normal_rules"
      ? patchRuleOverrides.normal_rules_override
      : patchRuleOverrides.special_rules_override;
    const value = nestedValue(overrideRoot, segments);
    if (value === undefined) throw new Error(`Patch rule override declares ${surface} without a matching payload`);
    if (scope === "normal_rules") seasonNormalRules = replaceNestedValue(seasonNormalRules, segments, value);
    else seasonSpecialRules = replaceNestedValue(seasonSpecialRules, segments, value);
  }
  return { seasonNormalRules, seasonSpecialRules };
}

function normalizeChoiceMechanicRows(rows, sourceLayer) {
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) throw new Error(`${sourceLayer}.choice_mechanics must be an array`);
  return rows.map((row, index) => {
    const mechanicId = String(row?.mechanic_id || "").trim();
    const kind = String(row?.kind || "").trim();
    const mode = String(row?.mode || "").trim();
    const phase = String(row?.phase || mode).trim();
    const label = String(row?.label || kind || mechanicId).trim();
    const stages = Array.isArray(row?.stages)
      ? row.stages.map((stage) => String(stage || "").trim()).filter(Boolean)
      : [];
    const intentTerms = Array.isArray(row?.intent_terms)
      ? row.intent_terms.map((term) => String(term || "").trim()).filter(Boolean)
      : [];
    const triggerTerms = [
      ...(Array.isArray(row?.trigger_terms) ? row.trigger_terms : []),
      ...(Array.isArray(row?.advice_task_trigger_terms) ? row.advice_task_trigger_terms : []),
    ].map((term) => String(term || "").trim()).filter(Boolean);
    const aliases = Array.isArray(row?.aliases)
      ? row.aliases.map((term) => String(term || "").trim()).filter(Boolean)
      : [];
    if (!mechanicId || !kind || !mode || !label || !stages.length || !intentTerms.length) {
      throw new Error(`${sourceLayer}.choice_mechanics[${index}] must declare mechanic_id, kind, mode, label, non-empty stages, and non-empty intent_terms`);
    }
    return {
      ...row,
      mechanic_id: mechanicId,
      kind,
      mode,
      phase,
      label,
      stages,
      intent_terms: [...new Set(intentTerms)],
      trigger_terms: [...new Set(triggerTerms)],
      aliases: [...new Set(aliases)],
      source_layer: sourceLayer,
    };
  });
}

export function collectChoiceMechanicsFromRules({ seasonNormalRules, seasonSpecialRules }) {
  const rows = [
    ...normalizeChoiceMechanicRows(seasonNormalRules?.choice_mechanics, "season_normal_rules"),
    ...normalizeChoiceMechanicRows(seasonSpecialRules?.mechanics?.choice_mechanics, "season_special_rules"),
  ];
  const stageOwners = new Map();
  for (const row of rows) {
    for (const stageRound of row.stages) {
      const existing = stageOwners.get(stageRound);
      if (existing) {
        throw new Error(`Choice stage ${stageRound} is declared by both ${existing} and ${row.mechanic_id}`);
      }
      stageOwners.set(stageRound, row.mechanic_id);
    }
  }
  return rows;
}

function buildRuntimeChoiceModeContracts(baseGameRules, choiceMechanics) {
  const baseContracts = baseGameRules?.runtime_choice_modes || {};
  const contractsByMode = new Map(
    Object.entries(baseContracts).map(([mode, contract]) => [mode, {
      source_layer: "base_game_rules",
      ...contract,
      mode,
    }]),
  );
  for (const mechanic of choiceMechanics) {
    contractsByMode.set(mechanic.mode, {
      ...(baseContracts[mechanic.mode] || {}),
      ...mechanic,
      mode: mechanic.mode,
    });
  }
  return [...contractsByMode.values()];
}

function validateRuntimeModeAliases(rulesBundle, contracts) {
  const aliases = rulesBundle?.season_special_rules?.host_mode_aliases || {};
  const contractModes = new Set(contracts.map((contract) => contract.mode));
  for (const alias of Object.keys(aliases)) {
    const canonicalMode = resolveRuntimeModeAlias(alias, rulesBundle);
    if (!contractModes.has(canonicalMode)) {
      throw new Error(`Runtime mode alias ${alias} resolves to undeclared mode ${canonicalMode || "unknown"}`);
    }
  }
}

const runtimeChoiceModeContractsCache = new WeakMap();

function validateRuntimeChoiceModeContracts(baseGameRules, choiceMechanics) {
  const contracts = buildRuntimeChoiceModeContracts(baseGameRules, choiceMechanics);
  for (const contract of contracts) {
    for (const field of ["mode", "kind", "phase", "label", "missing_selection_prompt_template"]) {
      if (!String(contract?.[field] || "").trim()) {
        throw new Error(`Runtime choice mode ${contract?.mode || "unknown"} is missing ${field}`);
      }
    }
    const candidateInputPolicy = String(contract.candidate_input_policy || "scoped_roi_text").trim();
    if (!new Set(["current_match_user_report", "scoped_roi_text"]).has(candidateInputPolicy)) {
      throw new Error(`Runtime choice mode ${contract.mode} has unsupported candidate_input_policy ${candidateInputPolicy}`);
    }
    if (candidateInputPolicy === "current_match_user_report") {
      const reportContract = contract.user_report_contract;
      if (!reportContract || typeof reportContract !== "object") {
        throw new Error(`Runtime choice mode ${contract.mode} must declare user_report_contract`);
      }
      for (const field of ["report_prompt", "refresh_report_prefix"]) {
        if (!String(reportContract[field] || "").trim()) {
          throw new Error(`Runtime choice mode ${contract.mode}.user_report_contract must declare ${field}`);
        }
      }
      if (reportContract.no_ocr_or_vision_fallback !== true) {
        throw new Error(`Runtime choice mode ${contract.mode} user-report flow must disable OCR and vision fallback`);
      }
    } else {
      for (const field of ["roi_tool", "ocr_worker_key", "ocr_worker_adapter", "vision_observation_field", "vision_instruction"]) {
        if (!String(contract?.[field] || "").trim()) {
          throw new Error(`Runtime choice mode ${contract.mode} is missing ${field}`);
        }
      }
    }
    if (!Array.isArray(contract.candidate_paths) || !contract.candidate_paths.length) {
      throw new Error(`Runtime choice mode ${contract.mode} must declare candidate_paths`);
    }
    if (!Array.isArray(contract.advice_task_trigger_terms) || !contract.advice_task_trigger_terms.length) {
      throw new Error(`Runtime choice mode ${contract.mode} must declare advice_task_trigger_terms`);
    }
    if (!String(contract.visible_window_required_answer || "").trim()) {
      throw new Error(`Runtime choice mode ${contract.mode} must declare visible_window_required_answer`);
    }
    const modeContext = contract.host_mode_context;
    if (!modeContext || typeof modeContext !== "object") {
      throw new Error(`Runtime choice mode ${contract.mode} must declare host_mode_context`);
    }
    for (const field of ["purpose", "response_expectation"]) {
      if (!String(modeContext[field] || "").trim()) {
        throw new Error(`Runtime choice mode ${contract.mode}.host_mode_context must declare ${field}`);
      }
    }
    for (const field of ["allowed_sources", "allowed_writes", "must_not_write"]) {
      if (!Array.isArray(modeContext[field])) {
        throw new Error(`Runtime choice mode ${contract.mode}.host_mode_context must declare ${field}`);
      }
    }
  }
}

export function collectRuntimeChoiceModeContracts(rulesBundle) {
  if (!rulesBundle || typeof rulesBundle !== "object") {
    throw new Error("Runtime choice mode contracts require a loaded active-rules bundle");
  }
  for (const field of ["base_game_rules", "season_normal_rules", "season_special_rules"]) {
    if (!rulesBundle[field] || typeof rulesBundle[field] !== "object") {
      throw new Error(`Runtime choice mode contracts require ${field}`);
    }
  }
  if (rulesBundle && typeof rulesBundle === "object" && runtimeChoiceModeContractsCache.has(rulesBundle)) {
    return runtimeChoiceModeContractsCache.get(rulesBundle);
  }
  const choiceMechanics = collectChoiceMechanicsFromRules({
    seasonNormalRules: rulesBundle?.season_normal_rules,
    seasonSpecialRules: rulesBundle?.season_special_rules,
  });
  const contracts = buildRuntimeChoiceModeContracts(rulesBundle?.base_game_rules, choiceMechanics);
  validateRuntimeChoiceModeContracts(rulesBundle?.base_game_rules, choiceMechanics);
  validateRuntimeModeAliases(rulesBundle, contracts);
  const stableContracts = Object.freeze(contracts.map((contract) => Object.freeze(contract)));
  if (rulesBundle && typeof rulesBundle === "object") runtimeChoiceModeContractsCache.set(rulesBundle, stableContracts);
  return stableContracts;
}

export function collectRuntimeManualVariableFields(rulesBundle) {
  if (!rulesBundle || typeof rulesBundle !== "object") {
    throw new Error("Runtime manual variable fields require a loaded active-rules bundle");
  }
  const declared = rulesBundle.season_special_rules?.mechanics?.manual_variable_fields;
  if (declared === undefined || declared === null) return [];
  if (!Array.isArray(declared)) throw new Error("season_special_rules.mechanics.manual_variable_fields must be an array");
  const declaredMatchVariables = new Set(
    Array.isArray(rulesBundle.season_special_rules?.mechanics?.match_variables)
      ? rulesBundle.season_special_rules.mechanics.match_variables.map(String)
      : [],
  );
  const seen = new Set();
  const seenLegacyPayloadFields = new Set();
  return declared.map((field, index) => {
    const key = String(field?.key || "").trim();
    const label = String(field?.label || "").trim();
    const optionSourceKey = String(field?.option_source_key || "").trim();
    const control = String(field?.control || "").trim();
    if (!key || !label || !optionSourceKey || !["single_select", "multi_select"].includes(control)) {
      throw new Error(`season_special_rules.mechanics.manual_variable_fields[${index}] must declare key, label, option_source_key, and a supported control`);
    }
    if (seen.has(key)) throw new Error(`Duplicate active-season manual variable field: ${key}`);
    if (!declaredMatchVariables.has(key)) {
      throw new Error(`Active-season manual variable field ${key} is absent from mechanics.match_variables`);
    }
    seen.add(key);
    const maxItems = control === "multi_select" ? Math.max(1, Number(field.max_items) || 1) : 1;
    const itemLabels = Array.isArray(field.item_labels) ? field.item_labels.map(String).filter(Boolean) : [];
    if (itemLabels.length > maxItems) {
      throw new Error(`Active-season manual variable field ${key} declares more item_labels than max_items`);
    }
    const legacyPayloadFields = Array.isArray(field.legacy_payload_fields)
      ? field.legacy_payload_fields.map(String).filter(Boolean)
      : [];
    for (const legacyField of legacyPayloadFields) {
      if (seenLegacyPayloadFields.has(legacyField)) {
        throw new Error(`Duplicate active-season manual variable legacy payload field: ${legacyField}`);
      }
      seenLegacyPayloadFields.add(legacyField);
    }
    return {
      key,
      label,
      control,
      option_source_key: optionSourceKey,
      option_group: String(field.option_group || optionSourceKey),
      section: field.section === "advanced" ? "advanced" : "primary",
      max_items: maxItems,
      item_labels: itemLabels,
      include_in_confirmation_summary: field.include_in_confirmation_summary === true,
      legacy_payload_fields: legacyPayloadFields,
      legacy_join_separator: String(field.legacy_join_separator || "+"),
      source_layer: "season_special_rules",
    };
  });
}

export function resolveRuntimeModeAlias(mode, rulesBundle) {
  const aliases = rulesBundle?.season_special_rules?.host_mode_aliases || {};
  let resolved = String(mode || "").trim();
  const visited = new Set();
  while (resolved && aliases[resolved]) {
    if (visited.has(resolved)) throw new Error(`Runtime mode alias cycle detected at ${resolved}`);
    visited.add(resolved);
    resolved = String(aliases[resolved] || "").trim();
  }
  return resolved;
}

export function runtimeChoiceModeContract(mode, rulesBundle) {
  const canonicalMode = resolveRuntimeModeAlias(mode, rulesBundle);
  if (!canonicalMode) return null;
  return collectRuntimeChoiceModeContracts(rulesBundle)
    .find((contract) => contract.mode === canonicalMode) || null;
}

function validateBaseGameRules(baseGameRules) {
  if (baseGameRules?.schema !== "jcc-base-game-rules-v1" || baseGameRules?.scope !== "base_game") {
    throw new Error("Base game rules must declare jcc-base-game-rules-v1 with scope=base_game");
  }
  if (!baseGameRules.coach_decision_model || typeof baseGameRules.coach_decision_model !== "object") {
    throw new Error("Base game rules must declare coach_decision_model");
  }
  if (baseGameRules.economy_management?.schema !== "jcc-economy-management-base-v1") {
    throw new Error("Base game rules must declare economy_management using jcc-economy-management-base-v1");
  }
  if (baseGameRules.itemization_management?.schema !== "jcc-itemization-management-base-v1") {
    throw new Error("Base game rules must declare itemization_management using jcc-itemization-management-base-v1");
  }
  if (!baseGameRules.runtime_choice_modes || typeof baseGameRules.runtime_choice_modes !== "object") {
    throw new Error("Base game rules must declare runtime_choice_modes");
  }
}

export function buildChoiceRuleCheckpointsFromLayers({ baseGameRules = null, seasonNormalRules, seasonSpecialRules }) {
  const mechanics = collectChoiceMechanicsFromRules({ seasonNormalRules, seasonSpecialRules });
  const descriptors = buildRuntimeChoiceModeContracts(baseGameRules || {}, mechanics);
  const descriptorByMode = new Map(descriptors.map((descriptor) => [descriptor.mode, descriptor]));
  const hostModeAliases = seasonSpecialRules?.host_mode_aliases || {};
  return mechanics.flatMap((mechanic) => {
    const descriptor = descriptorByMode.get(mechanic.mode) || mechanic;
    const aliases = [
      ...(Array.isArray(descriptor.aliases) ? descriptor.aliases : []),
      ...Object.keys(hostModeAliases).filter((alias) => resolveRuntimeModeAlias(alias, { season_special_rules: seasonSpecialRules }) === mechanic.mode),
    ];
    return mechanic.stages.map((stageRound) => {
      const checkpoint = {
        mechanic_id: mechanic.mechanic_id,
        kind: descriptor.kind || mechanic.kind,
        mode: mechanic.mode,
        phase: descriptor.phase || mechanic.phase,
        stage_round: stageRound,
        choice_label: descriptor.label || mechanic.label,
        label: `${stageRound} ${descriptor.label || mechanic.label}`,
        intent_terms: descriptor.intent_terms || mechanic.intent_terms,
        trigger_terms: descriptor.trigger_terms || mechanic.trigger_terms,
        advice_task_trigger_terms: descriptor.advice_task_trigger_terms || mechanic.advice_task_trigger_terms,
        aliases: [...new Set(aliases)],
        source_layer: mechanic.source_layer,
      };
      return {
        ...checkpoint,
        semantic_terms: choiceCheckpointSemanticTerms(checkpoint),
      };
    });
  });
}

export function promotionTupleMatchesRulesBundle(tuple, rulesBundle, { requireComplete = false } = {}) {
  if (!tuple) return !requireComplete;
  const identity = rulesBundle?.version_identity || {};
  const sourceFiles = rulesBundle?.source_files || {};
  if (requireComplete) {
    for (const field of ["season_id", "active_patch_id", "game_mode_id", "package_id", "hard_data_manifest"]) {
      if (!String(tuple[field] || "").trim()) return false;
    }
    if (identity.source_package_id && identity.source_package_id !== identity.package_id && !String(tuple.source_package_id || "").trim()) return false;
  }
  return (!tuple.season_id || tuple.season_id === identity.runtime_season_id)
    && (!tuple.active_patch_id || tuple.active_patch_id === identity.runtime_patch_id)
    && (!tuple.game_mode_id || tuple.game_mode_id === identity.game_mode_id)
    && (!tuple.package_id || tuple.package_id === identity.package_id)
    && (!tuple.source_package_id || tuple.source_package_id === identity.source_package_id)
    && (!tuple.hard_data_manifest || tuple.hard_data_manifest === sourceFiles.hard_data_manifest);
}

export function buildCoachRulesBriefFromLayers({
  baseGameRules,
  seasonNormalRules,
  seasonSpecialRules,
  patchStrategyOverrides = null,
  sourceFiles,
  versionIdentity,
}) {
  const choiceMechanics = collectChoiceMechanicsFromRules({ seasonNormalRules, seasonSpecialRules });
  validateRuntimeChoiceModeContracts(baseGameRules, choiceMechanics);
  validateRuntimeModeAliases(
    { season_special_rules: seasonSpecialRules },
    buildRuntimeChoiceModeContracts(baseGameRules, choiceMechanics),
  );
  const normalChoiceMechanics = choiceMechanics.filter((entry) => entry.source_layer === "season_normal_rules");
  const specialChoiceMechanics = choiceMechanics.filter((entry) => entry.source_layer === "season_special_rules");
  const seasonId = seasonSpecialRules?.season_id || seasonNormalRules?.season_id || versionIdentity?.runtime_season_id || null;
  const seasonName = seasonSpecialRules?.display_name || seasonNormalRules?.display_name || seasonId || "active season";
  const economyManagement = baseGameRules?.economy_management || null;
  const economyPatchOverride = patchStrategyOverrides?.economy_management_overrides || null;
  const itemizationManagement = baseGameRules?.itemization_management || null;
  const seasonItemizationInteractions = seasonSpecialRules?.mechanics?.itemization_interactions || null;
  const stageDecisionTasks = {
    ...(seasonNormalRules?.stage_decision_tasks || {}),
    ...(seasonSpecialRules?.mechanics?.stage_decision_tasks || {}),
  };
  const stageStrategyProtocol = {
    ...(seasonNormalRules?.stage_strategy_protocol || {}),
    ...(seasonSpecialRules?.mechanics?.stage_strategy_protocol || {}),
  };
  return {
    schema: "jcc-runtime-coach-rules-brief-v2",
    purpose: "Provider-neutral coach-facing rules compiled from reusable base rules, major-season rules, and an optional minor-patch strategy layer.",
    active_season: seasonId,
    active_patch_id: versionIdentity?.runtime_patch_id || null,
    display_name: seasonName,
    version_identity: versionIdentity,
    source_files: sourceFiles,
    decision_model: baseGameRules?.coach_decision_model || null,
    economy_management: {
      base_schema: economyManagement?.schema || null,
      patch_strategy_schema: economyPatchOverride?.schema || null,
      policy: "Apply reusable economy doctrine first. Treat patch strategy as a soft current-meta prior; live facts, confirmed choices, and newer user intent outrank it.",
    },
    itemization_management: {
      base_schema: itemizationManagement?.schema || null,
      scope: itemizationManagement?.scope || null,
      decision_sequence: itemizationManagement?.decision_sequence || [],
      missing_information_policy: itemizationManagement?.missing_information_policy || null,
      proactive_coach_policy: itemizationManagement?.proactive_coach_policy || null,
      host_model_invariants: itemizationManagement?.host_model_invariants || [],
      active_season_interactions: seasonItemizationInteractions,
      policy: "Use each currently reliable equipment field immediately. The deterministic layer may provide slam/wait posture; the Host model owns exact craft and holder decisions from current facts, hard data, daily priors, confirmed choices, user intent, and active-season interactions.",
    },
    stage_decision_tasks: stageDecisionTasks,
    stage_strategy_protocol: stageStrategyProtocol,
    timing: {
      choice_mechanics: choiceMechanics,
      normal_choices: normalChoiceMechanics,
      season_special_choices: specialChoiceMechanics,
    },
    model_must: [
      `Current ruleset ${seasonName}: normal choice checkpoints are ${normalChoiceMechanics.flatMap((entry) => entry.stages).join(", ") || "unknown"}.`,
      specialChoiceMechanics.length
        ? `Current ruleset ${seasonName}: special-choice checkpoints are ${specialChoiceMechanics.flatMap((entry) => entry.stages).join(", ")}.`
        : `Current ruleset ${seasonName}: no special-choice checkpoints are declared.`,
      "For every active choice mechanic, obey its compiled candidate_input_policy. A current-match user report supplies candidates only; explicit confirmation supplies the final selection.",
      "Use the current stage task and protocol before generic transition advice.",
      "Use live state, confirmed choices, and latest user intent before hard data, rankings, wiki memory, or patch strategy priors.",
      "Use economy management plus computed economic decision context for interest, leveling, rolling, streak, and open-sell decisions.",
      "Use itemization management plus effective equipment context for slam, wait, holder, transfer, remover, reforger, and utility-gap decisions.",
      "Never wait for structured recovery or visual candidates when the currently reliable equipment field is sufficient to decide.",
    ],
    model_must_not: [
      "Do not wait for a choice checkpoint that the current-turn contract marks current or past.",
      "Do not average old user plans with newer explicit decisions.",
      "Do not use patch strategy to redefine choice timing or major-season mechanics.",
    ],
  };
}

export function loadActiveRulesBundle({ repoRoot, runtimePaths }) {
  const profileLayers = loadProfileBackedRuleLayers(runtimePaths);
  if (!profileLayers) {
    throw new Error("Active Core Profile does not match the requested season/patch; production rules have no legacy fallback");
  }
  const baseGameRules = profileLayers.baseGameRules;
  validateBaseGameRules(baseGameRules);
  const sourceSeasonNormalRules = profileLayers.sourceSeasonNormalRules;
  const sourceSeasonSpecialRules = profileLayers.sourceSeasonSpecialRules;
  const patchStrategyOverrides = readJsonFile(runtimePaths.seasonPatchStrategyFile, { required: false });
  const patchRuleOverrides = readJsonFile(runtimePaths.seasonPatchRuleOverridesFile, { required: false });
  const versionIdentity = {
    runtime_season_id: runtimePaths.activeSeasonId || null,
    runtime_patch_id: runtimePaths.activePatchId || null,
    game_mode_id: runtimePaths.activeGameModeId || null,
    package_id: runtimePaths.activePackageId || null,
    source_package_id: runtimePaths.activeSourcePackageId || null,
    upstream_identity: runtimePaths.upstreamVersionIdentity || null,
  };
  const sourceFiles = {
    base_game_rules: repoRelative(repoRoot, runtimePaths.runtimeCommonChoiceContractFile),
    season_normal_rules: `${repoRelative(repoRoot, runtimePaths.activeCoreProfileBundleFile)}#season.runtime_contract.normal_rules`,
    season_special_rules: `${repoRelative(repoRoot, runtimePaths.activeCoreProfileBundleFile)}#season.runtime_contract.special_rules`,
    core_profile: repoRelative(repoRoot, runtimePaths.activeCoreProfileFile),
    patch_strategy_overrides: patchStrategyOverrides ? repoRelative(repoRoot, runtimePaths.seasonPatchStrategyFile) : null,
    patch_rule_overrides: patchRuleOverrides ? repoRelative(repoRoot, runtimePaths.seasonPatchRuleOverridesFile) : null,
    hard_data_manifest: runtimePaths.activeHardDataManifest || null,
  };
  const strategyPatchId = patchStrategyOverrides?.active_patch_id || patchStrategyOverrides?.patch_id || null;
  if (strategyPatchId && strategyPatchId !== versionIdentity.runtime_patch_id) {
    throw new Error(`Patch strategy ${strategyPatchId} does not match active patch ${versionIdentity.runtime_patch_id}`);
  }
  if (patchStrategyOverrides?.season_id && patchStrategyOverrides.season_id !== versionIdentity.runtime_season_id) {
    throw new Error(`Patch strategy season ${patchStrategyOverrides.season_id} does not match active season ${versionIdentity.runtime_season_id}`);
  }
  if (patchRuleOverrides && patchRuleOverrides.rules_changed !== true) {
    throw new Error("Patch rule override file exists without rules_changed=true");
  }
  if (patchRuleOverrides) {
    const overridePatchId = patchRuleOverrides.active_patch_id || patchRuleOverrides.patch_id || null;
    if (overridePatchId !== versionIdentity.runtime_patch_id) {
      throw new Error(`Patch rule override ${overridePatchId || "unknown"} does not match active patch ${versionIdentity.runtime_patch_id}`);
    }
    if (patchRuleOverrides.season_id !== versionIdentity.runtime_season_id) {
      throw new Error(`Patch rule override season ${patchRuleOverrides.season_id || "unknown"} does not match active season ${versionIdentity.runtime_season_id}`);
    }
    if (!Array.isArray(patchRuleOverrides.changed_rule_surfaces) || !patchRuleOverrides.changed_rule_surfaces.length) {
      throw new Error("Patch rule override must declare changed_rule_surfaces");
    }
    if (!patchRuleOverrides.old_behavior || !patchRuleOverrides.new_behavior || !patchRuleOverrides.rollback) {
      throw new Error("Patch rule override must declare old_behavior, new_behavior, and rollback");
    }
  }
  const { seasonNormalRules, seasonSpecialRules } = applyDeclaredPatchRuleOverrides(
    sourceSeasonNormalRules,
    sourceSeasonSpecialRules,
    patchRuleOverrides,
  );
  if (seasonNormalRules.season_id !== versionIdentity.runtime_season_id || seasonSpecialRules.season_id !== versionIdentity.runtime_season_id) {
    throw new Error("Patch rule overrides cannot change the active major-season id");
  }
  collectRuntimeManualVariableFields({ season_special_rules: seasonSpecialRules });
  const fingerprintInput = {
    version_identity: versionIdentity,
    source_files: sourceFiles,
    base_game_rules: baseGameRules,
    source_season_normal_rules: sourceSeasonNormalRules,
    source_season_special_rules: sourceSeasonSpecialRules,
    effective_season_normal_rules: seasonNormalRules,
    effective_season_special_rules: seasonSpecialRules,
    patch_strategy_overrides: patchStrategyOverrides,
    patch_rule_overrides: patchRuleOverrides,
  };
  const sourceFingerprint = rulesFingerprint(fingerprintInput);
  const coachRulesBrief = buildCoachRulesBriefFromLayers({
    baseGameRules,
    seasonNormalRules,
    seasonSpecialRules,
    patchStrategyOverrides,
    sourceFiles,
    versionIdentity,
  });
  return {
    schema: "jcc-runtime-active-rules-bundle-v2",
    version_identity: versionIdentity,
    source_fingerprint: sourceFingerprint,
    source_files: sourceFiles,
    base_game_rules: baseGameRules,
    season_normal_rules: seasonNormalRules,
    season_special_rules: seasonSpecialRules,
    patch_strategy_overrides: patchStrategyOverrides,
    patch_rule_overrides: patchRuleOverrides,
    rules_status: {
      status: "loaded",
      source_authority: profileLayers.sourceAuthority,
      core_profile_id: runtimePaths.activeCoreProfileId,
      legacy_rules: "retired_no_fallback",
      fail_closed_on_missing_or_invalid_major_rules: true,
      patch_strategy_optional: true,
      patch_rule_override_requires_explicit_declaration: true,
    },
    coach_rules_brief: {
      ...coachRulesBrief,
      rules_source_fingerprint: sourceFingerprint,
    },
    recency_policy: {
      latest_user_intent_wins: true,
      newer_choice_confirmations_win: true,
      observed_options_are_not_confirmed_selection: true,
    },
  };
}

export { readJsonFile as readActiveRuleJsonFile };
