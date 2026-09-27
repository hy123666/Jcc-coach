import { readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { buildLineupLifecycleContext } from "./build-jcc-lineup-lifecycle-context.mjs";
import { evaluateAugmentChoiceCandidate } from "../ui/electron/augment-choice-evaluator.js";
import {
  normalizeTargetContextAuthority,
  resolveTargetContextAuthority,
} from "../ui/electron/target-context-resolver.js";
import { cruiseCheckpointForStage } from "../ui/electron/cruise-checkpoint-agenda.js";

const DEFAULT_THRESHOLD = 0.7;
const TIMING_WINDOWS = new Set(["3-2", "4-1", "4-2", "5-1"]);
const DEFAULT_COOLDOWN_SECONDS_BY_TRIGGER = {
  shop_hold_sell_interest: 8,
  tempo_pivot: 20,
  direction_commit_or_exit: 30,
  streak_guard: 20,
  level_or_roll_timing: 20,
  shop_lock_decision: 12,
  bench_space_pressure: 12,
  item_slam_or_greed: 20,
  cap_gap_check: 30,
  augment_choice_advice: 5,
  item_choice_advice: 5,
  shop_hold_without_economy: 8,
  special_context_visual_probe: 45,
  early_direction_conversation: 45,
  lineup_convergence_checkpoint: 45,
};

function usage() {
  return [
    "Usage:",
    "  node tools/score-jcc-cruise-strategy.mjs --live-state <file> [--context <file>] [--out <file>] [--include-suppressed]",
    "",
    "Scores cruise-mode runtime advice tasks from current match live_state.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { includeSuppressed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--context") options.context = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--include-suppressed") options.includeSuppressed = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  const text = await readFile(file, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function choiceSetChoices(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.choices)) return value.choices;
  return [];
}

function firstNonEmptyArray(...values) {
  for (const value of values) {
    const rows = choiceSetChoices(value);
    if (rows.length) return rows;
  }
  return [];
}

function choiceSourceOf(value) {
  return String(value?.source || value?.provenance?.source || value?.source_policy || "").toLowerCase();
}

function isCurrentMatchUserReportedChoice(value) {
  return choiceSourceOf(value) === "current_match_user_report";
}

function userReportedChoicesFrom(value) {
  const choices = choiceSetChoices(value);
  if (!choices.length) return [];
  if (isCurrentMatchUserReportedChoice(value)) {
    return choices.map((choice) => (
      choice && typeof choice === "object" && !Array.isArray(choice)
        ? { ...choice, source: choice.source || "current_match_user_report" }
        : { name: choice, source: "current_match_user_report" }
    ));
  }
  return choices.filter(isCurrentMatchUserReportedChoice);
}

function firstUserReportedChoices(...values) {
  for (const value of values) {
    const choices = userReportedChoicesFrom(value);
    if (choices.length) return choices;
  }
  return [];
}

function currentMatchReportedChoiceSet(context, mode, activeMatchSessionId = null) {
  const choiceSet = context?.match_context?.reported_choice_sets_by_mode?.[mode]
    || context?.reported_choice_sets_by_mode?.[mode]
    || null;
  if (!choiceSet || !isCurrentMatchUserReportedChoice(choiceSet)) return null;
  if (
    activeMatchSessionId
    && choiceSet.match_session_id
    && String(choiceSet.match_session_id) !== String(activeMatchSessionId)
  ) return null;
  const choices = userReportedChoicesFrom(choiceSet);
  const expectedCount = Math.max(0, Number(choiceSet.expected_candidate_count || 0) || 0);
  if (!choices.length || (expectedCount && choices.length < expectedCount)) return null;
  return { ...choiceSet, choices };
}

function activeChoiceModeContracts(context = {}) {
  const root = context?.context || context || {};
  return asArray(root.active_choice_mode_contracts)
    .filter((contract) => contract && typeof contract === "object" && String(contract.mode || "").trim());
}

function numberOrNull(value) {
  if (value === undefined || value === null) return null;
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized === "") return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function stageMajor(stageRound) {
  const match = String(stageRound || "").match(/^(\d+)-/);
  return match ? Number(match[1]) : null;
}

function stageSortValue(stageRound) {
  const match = String(stageRound || "").match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  return Number(match[1]) * 100 + Number(match[2]);
}

function beforeStage(stageRound, targetStageRound) {
  const current = stageSortValue(stageRound);
  const target = stageSortValue(targetStageRound);
  return Number.isFinite(current) && Number.isFinite(target) && current < target;
}

function normalizeName(unit) {
  return unit?.name || unit?.hero_name || unit?.cn_name || unit?.display_name || unit?.n || unit?.id || unit?.i || "unknown";
}

function unitKey(unit) {
  return String(unit?.base_id || unit?.hero_id || unit?.id || unit?.i || normalizeName(unit));
}

function normalizeUnits(units) {
  return asArray(units).map((unit) => ({
    ...unit,
    key: unitKey(unit),
    name: normalizeName(unit),
    cost: numberOrNull(unit.cost),
    star: numberOrNull(unit.star || unit.stars),
  }));
}

function exactMatchSessionId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function effectiveEquipmentRowsFromContext(rawContext, field, activeMatchSessionId) {
  const root = rawContext?.context || rawContext || {};
  const equipment = root.equipment_context
    || root.cruise_decision_context?.equipment
    || null;
  const effectiveField = field === "item_bench" ? "effective_item_bench" : "effective_equipped_items";
  const source = equipment?.effective_source_by_field?.[field] || "";
  const activeMatchId = exactMatchSessionId(activeMatchSessionId);
  const sourceIsStructured = source === "mumu_4357"
    || source === "mumu_4357_authoritative_empty"
    || source === "trusted_mumu_4356_assignment"
    || source === "trusted_mumu_4356_authoritative_empty";
  const sourceIsCurrentUserConfirmation = source === "user_confirmed"
    && activeMatchId !== null
    && exactMatchSessionId(equipment?.user_confirmation_match_session_id) === activeMatchId;
  const sourceIsReliable = sourceIsStructured || sourceIsCurrentUserConfirmation;
  if (sourceIsReliable && Array.isArray(equipment?.[effectiveField])) {
    return equipment[effectiveField];
  }
  const userConfirmed = root.match_context?.user_confirmed_equipment
    || root.user_confirmed_equipment
    || null;
  if (
    activeMatchId === null
    || exactMatchSessionId(userConfirmed?.match_session_id || userConfirmed?.matchSessionId) !== activeMatchId
  ) return [];
  return asArray(userConfirmed?.[field]);
}

function hasExplicitEliminationEvidence(root, phase = root?.phase || {}) {
  const match = root?.match || root?.lifecycle || {};
  const statusText = String(
    phase.status_name
    || phase.phase_name
    || match.status
    || match.lifecycle_status
    || "",
  ).toLowerCase();
  return phase.elimination_confirmed === true
    || phase.match_ended === true
    || phase.game_over === true
    || match.elimination_confirmed === true
    || match.ended === true
    || match.game_over === true
    || ["eliminated", "match_ended", "game_over", "postgame"].some((token) => statusText.includes(token));
}

function collectLiveState(raw, context = {}) {
  const root = raw.live_state || raw;
  const economy = root.economy || root.player?.economy || {};
  const phase = root.phase || root.round || {};
  const board = root.board || root.own_board || {};
  const bench = root.bench || root.own_bench || {};
  const shop = root.shop || {};
  const items = root.items || {};
  const augments = root.augments || {};
  const choices = root.choices || {};
  const opponents = root.opponents || {};
  const matchVariables = root.match_variables || {};
  const matchSessionId = root.match_session_id || root.matchSessionId || raw.match_session_id || null;
  const stageRound = firstDefined(
    phase.stage_round,
    phase.stageRound,
    phase.round_key,
    phase.current_round,
    root.latest_stage_round_key,
    root.stage_round,
  );
  const rawItemBench = asArray(firstDefined(items.item_bench, items.bench, items.inventory, root.item_bench));
  const rawEquippedItems = asArray(firstDefined(items.equipped_items, items.equipped, root.equipped_items));
  const contextItemBench = effectiveEquipmentRowsFromContext(context, "item_bench", matchSessionId);
  const contextEquippedItems = effectiveEquipmentRowsFromContext(context, "equipped_items", matchSessionId);
  const reportedItemChoiceSet = currentMatchReportedChoiceSet(context, "item_choice", matchSessionId);
  const reportedAugmentChoiceSet = currentMatchReportedChoiceSet(context, "augment_choice", matchSessionId);
  const seasonChoiceContracts = activeChoiceModeContracts(context)
    .filter((contract) => !new Set(["augment_choice", "item_choice"]).has(contract.mode));
  const activeSeasonChoiceOptionsByMode = Object.fromEntries(
    seasonChoiceContracts.map((contract) => {
      const reportedSet = currentMatchReportedChoiceSet(context, contract.mode, matchSessionId);
      return [
        contract.mode,
        firstUserReportedChoices(
          reportedSet,
          choices.by_mode?.[contract.mode],
          root.active_choice_options_by_mode?.[contract.mode],
        ),
      ];
    }).filter(([, rows]) => rows.length),
  );

  const rawHp = numberOrNull(firstDefined(economy.hp, economy.health, economy.life));
  const explicitElimination = hasExplicitEliminationEvidence(root, phase);
  const normalizedHp = rawHp !== null && (rawHp <= 0 || rawHp > 150)
    ? (rawHp === 0 && explicitElimination ? 0 : null)
    : rawHp;
  return {
    raw: root,
    matchSessionId,
    economy: {
      gold: numberOrNull(firstDefined(economy.gold, economy.money)),
      hp: normalizedHp,
      level: numberOrNull(firstDefined(economy.level, economy.lv)),
      xp: firstDefined(economy.xp, economy.exp, null),
    },
    phase: {
      stageRound: stageRound ? String(stageRound) : null,
      status: firstDefined(phase.status, phase.s, root.status, null),
      eliminationConfirmed: explicitElimination,
    },
    boardUnits: normalizeUnits(firstDefined(
      board.board_units,
      board.units,
      board.local_board_units,
      board.local_board_units_candidate,
      root.board_units,
    )),
    benchUnits: normalizeUnits(firstDefined(
      bench.bench_units,
      bench.units,
      bench.local_bench_units,
      root.bench_units,
    )),
    shopUnits: normalizeUnits(firstDefined(
      shop.shop_units,
      shop.units,
      shop.current_shop_units,
      root.shop_units,
    )),
    itemBench: rawItemBench.length ? rawItemBench : contextItemBench,
    equippedItems: rawEquippedItems.length ? rawEquippedItems : contextEquippedItems,
    itemChoiceOptions: firstUserReportedChoices(
      reportedItemChoiceSet,
      items.choice_options,
      items.current_choice_set,
      root.item_choice_options,
    ),
    selectedAugments: asArray(firstDefined(augments.selected_augments, augments.selected, root.selected_augments)),
    augmentCurrentChoiceSet: reportedAugmentChoiceSet
      || [augments.current_choice_set, root.augment_current_choice_set].find((set) => userReportedChoicesFrom(set).length)
      || null,
    augmentPreviousChoiceSets: asArray(firstDefined(augments.previous_choice_sets, root.augment_previous_choice_sets))
      .filter((set) => userReportedChoicesFrom(set).length),
    augmentChoiceSetHistory: asArray(firstDefined(augments.choice_set_history, root.augment_choice_set_history))
      .filter((set) => userReportedChoicesFrom(set).length),
    augmentRerollPolicy: firstDefined(augments.reroll_policy, root.augment_reroll_policy, {}),
    augmentChoiceCandidates: firstUserReportedChoices(
      reportedAugmentChoiceSet,
      augments.current_choice_set,
      augments.choice_candidates,
      augments.choices,
    ),
    activeSeasonChoiceOptionsByMode,
    opponentSnapshots: [],
    matchVariables,
    strategy: root.strategy || {},
  };
}

function normalizeContext(raw = {}) {
  const root = raw.context || raw;
  const durableTargetPlan = root.target_plan || root.strategy?.target_plan || null;
  const declaredTargetAuthority = normalizeTargetContextAuthority(root.target_context_authority);
  const resolvedTarget = root.effective_target_context && declaredTargetAuthority !== "none"
    ? {
        authority: declaredTargetAuthority,
        target: root.effective_target_context,
        persisted: declaredTargetAuthority === "durable_target_plan",
        basis: root.target_context_basis || "pre_resolved_runtime_target_context",
      }
    : resolveTargetContextAuthority({
        currentTurnInstruction: root.current_turn_target_instruction || null,
        replacementIntent: durableTargetPlan?.replacement_intent || root.replacement_intent || null,
        durableTargetPlan,
        provisionalIntent: root.current_plan || root.latest_target_intent || null,
      });
  const targetPlan = resolvedTarget.target;
  const targetContextAuthority = resolvedTarget.authority;
  const hardData = root.hard_data_context || root.hard_data || {};
  const liveRankings = root.live_rankings_context || {};
  const entityWeights = hardData.entity_strategy_weights || hardData.strategy_weights || {};
  const heroSignals = new Map();
  const lineupSignals = [];

  for (const hero of asArray(firstDefined(
    liveRankings.top_heroes,
    liveRankings.signals?.top_heroes,
    liveRankings.route_contexts?.augment_choice?.signals?.top_heroes,
    liveRankings.route_contexts?.full_planning?.signals?.top_heroes,
  ))) {
    const id = String(firstDefined(hero.hero_id, hero.id, hero.unit_id, hero.champion_id, ""));
    if (id) heroSignals.set(id, hero);
  }
  for (const lineup of asArray(firstDefined(
    liveRankings.top_lineups,
    liveRankings.signals?.top_lineups,
    liveRankings.route_contexts?.augment_choice?.signals?.top_lineups,
    liveRankings.route_contexts?.full_planning?.signals?.top_lineups,
  ))) {
    if (lineup?.source_role === "national_master_plus_strength_anchor" && lineup?.metrics_authority === true) {
      lineupSignals.push(lineup);
    }
  }

  const targetIds = new Set();
  for (const value of [
    ...asArray(targetPlan?.unit_ids),
    ...asArray(targetPlan?.core_unit_ids),
    ...asArray(targetPlan?.units),
  ]) {
    targetIds.add(String(value?.id || value?.hero_id || value?.unit_id || value));
  }

  const targetNames = new Set();
  for (const value of [
    ...asArray(targetPlan?.unit_names),
    ...asArray(targetPlan?.core_unit_names),
    ...asArray(targetPlan?.champions),
  ]) {
    targetNames.add(String(value?.name || value).toLowerCase());
  }

  const activeContracts = activeChoiceModeContracts(root);
  const activeChoiceCooldowns = Object.fromEntries(
    activeContracts.flatMap((contract) => asArray(contract.advice_task_trigger_terms)
      .map((trigger) => [String(trigger || "").trim(), 5]))
      .filter(([trigger]) => trigger),
  );

  return {
    targetPlan,
    targetContextAuthority,
    targetContextResolution: resolvedTarget,
    lineupLifecycle: root.lineup_lifecycle
      || root.combat_cap_estimator?.lineup_lifecycle
      || root.combat_estimator?.lineup_lifecycle
      || null,
    hardData,
    liveRankings,
    entityWeights,
    combatCapEstimator: root.combat_cap_estimator || root.combat_estimator || root.cap_estimator || {},
    runtimeUserSettings: root.runtime_user_settings || root.user_settings || {},
    userMemory: root.user_memory || {},
    recentMatchSummaries: asArray(root.recent_match_summaries || root.recent_matches),
    previousAdviceState: root.previous_advice_state || root.previousAdviceState || {},
    cooldownSecondsByTrigger: {
      ...DEFAULT_COOLDOWN_SECONDS_BY_TRIGGER,
      ...activeChoiceCooldowns,
      ...(root.cooldown_seconds_by_trigger || root.interrupt_policy?.cooldown_seconds_by_trigger || {}),
    },
    activeChoiceModeContracts: activeContracts,
    heroSignals,
    lineupSignals,
    targetIds,
    targetNames,
    userContext: root.user_context || root.user || {},
    augmentChoiceEvidence: root.augment_choice_evidence
      || root.strategy_fit_packet?.augment_choice_evidence
      || {},
  };
}

function settingsEvidence(context) {
  const settings = context.runtimeUserSettings || {};
  const memory = context.userMemory || {};
  const entries = [];
  if (Object.keys(settings).length) {
    entries.push(evidence("runtime_user_settings", "User settings bias risk tolerance and execution timing", settings));
  }
  const strategyRows = normalizeUserStrategyRows(memory);
  if (strategyRows.length) {
    entries.push(evidence("user_strategy_rows", "User-approved custom strategy rows participate as soft strategy bias", strategyRows.slice(0, 8)));
  }
  if (asArray(memory.preferences).length || asArray(memory.habits).length || asArray(memory.review_notes).length) {
    entries.push(evidence("user_memory", "User-approved memory participates as a soft strategy bias", {
      preferences: asArray(memory.preferences).slice(0, 6),
      habits: asArray(memory.habits).slice(0, 6),
      review_notes: asArray(memory.review_notes).slice(0, 4),
    }));
  }
  return entries;
}

function textTokens(value) {
  return String(value || "").toLowerCase();
}

function hasAnyText(value, needles) {
  const text = textTokens(value);
  return needles.some((needle) => text.includes(textTokens(needle)));
}

function normalizeUserStrategyRows(memory = {}) {
  const rows = [
    ...asArray(memory.strategy_rows),
    ...asArray(memory.custom_strategy_rows),
    ...asArray(memory.approved_strategy_rows),
  ];
  return rows
    .filter((row) => row && row.enabled !== false && row.approved !== false && row.status !== "rejected")
    .map((row, index) => {
      const text = String(row.text || row.value || row.strategy || row.note || "").trim();
      const tags = [...new Set(asArray(row.tags).map((tag) => String(tag).trim()).filter(Boolean))];
      return {
        id: String(row.id || row.key || `strategy_row_${index + 1}`),
        text,
        tags,
        weight: Math.max(0.1, Math.min(2, numberOrNull(row.weight) || 1)),
        source: row.source || "user_confirmed_strategy_row",
        approved_at: row.approved_at || row.updated_at || null,
      };
    })
    .filter((row) => row.text || row.tags.length);
}

function classifyUserStrategyRow(row) {
  const haystack = `${row.text} ${row.tags.join(" ")}`;
  const labels = [];
  if (hasAnyText(haystack, ["稳前四", "保前四", "吃分", "top_four", "top4", "safe"])) labels.push("custom_safe_top_four");
  if (hasAnyText(haystack, ["冲吃鸡", "吃鸡", "上限", "first", "cap", "high_cap"])) labels.push("custom_play_for_first");
  if (hasAnyText(haystack, ["少d", "少 d", "不乱d", "省d", "多运营", "运营", "greed", "econ"])) labels.push("custom_economy_bias");
  if (hasAnyText(haystack, ["保血", "稳血", "连胜", "节奏", "tempo", "win_streak"])) labels.push("custom_tempo_bias");
  if (hasAnyText(haystack, ["连败", "空城", "lose_streak", "open_fort"])) labels.push("custom_lose_streak_bias");
  if (hasAnyText(haystack, ["提前", "慢手", "手速慢", "一回合", "one_round"])) labels.push("custom_early_notice");
  if (hasAnyText(haystack, ["不喜欢赌", "别赌", "少赌", "avoid_reroll"])) labels.push("custom_avoid_reroll");
  if (hasAnyText(haystack, ["喜欢赌", "赌狗", "慢d", "slow_roll", "reroll"])) labels.push("custom_reroll_comfort");
  return [...new Set(labels)];
}

function userStrategyBias(context) {
  const rows = normalizeUserStrategyRows(context.userMemory || {});
  const labels = [];
  const actions = [];
  let valueBonus = 0;
  const notes = [];
  for (const row of rows) {
    const rowLabels = classifyUserStrategyRow(row);
    labels.push(...rowLabels);
    if (rowLabels.includes("custom_safe_top_four")) {
      actions.push("respect_user_strategy:prefer_stable_top_four");
      valueBonus += 0.015 * row.weight;
      notes.push("偏稳前四/吃分");
    }
    if (rowLabels.includes("custom_play_for_first")) {
      actions.push("respect_user_strategy:allow_higher_cap_line");
      notes.push("允许更高上限路线");
    }
    if (rowLabels.includes("custom_economy_bias")) {
      actions.push("respect_user_strategy:avoid_low_value_rolls");
      notes.push("偏少 D、多运营");
    }
    if (rowLabels.includes("custom_tempo_bias")) {
      actions.push("respect_user_strategy:prioritize_hp_and_streak");
      valueBonus += 0.01 * row.weight;
      notes.push("偏节奏/保血");
    }
    if (rowLabels.includes("custom_lose_streak_bias")) {
      actions.push("respect_user_strategy:preserve_intentional_lose_streak_when_valid");
      notes.push("允许控连败");
    }
    if (rowLabels.includes("custom_early_notice")) {
      actions.push("respect_user_strategy:warn_before_complex_pivot");
      notes.push("提前提醒复杂变阵");
    }
    if (rowLabels.includes("custom_avoid_reroll")) {
      actions.push("respect_user_strategy:deprioritize_reroll_lines");
      notes.push("降低赌牌倾向");
    }
    if (rowLabels.includes("custom_reroll_comfort")) {
      actions.push("respect_user_strategy:consider_reroll_lines_if_spot_fits");
      notes.push("可接受慢 D/赌牌");
    }
  }
  return {
    rows,
    labels: [...new Set(labels)],
    actions: [...new Set(actions)],
    valueBonus: Math.min(0.06, valueBonus),
    notes: [...new Set(notes)].slice(0, 4),
  };
}

function settingsLabels(context) {
  const labels = [];
  const goal = String(context.runtimeUserSettings?.default_goal || "").toLowerCase();
  const speed = String(context.runtimeUserSettings?.operation_speed || "").toLowerCase();
  if (goal === "safe_top_four") labels.push("safe_top_four_bias");
  if (goal === "play_for_first") labels.push("first_place_bias");
  if (speed === "slow_needs_one_round_notice") labels.push("slow_operation_speed");
  if (speed === "fast_can_pivot_same_round") labels.push("fast_operation_speed");
  labels.push(...userStrategyBias(context).labels);
  return [...new Set(labels)];
}

function settingsActions(context) {
  const actions = [];
  const speed = String(context.runtimeUserSettings?.operation_speed || "").toLowerCase();
  const goal = String(context.runtimeUserSettings?.default_goal || "").toLowerCase();
  if (speed === "slow_needs_one_round_notice") actions.push("prepare_one_round_ahead");
  if (speed === "fast_can_pivot_same_round") actions.push("allow_same_round_pivot_if_high_confidence");
  if (goal === "safe_top_four") actions.push("prefer_robust_top_four_line");
  if (goal === "play_for_first") actions.push("consider_high_cap_line_if_spot_allows");
  actions.push(...userStrategyBias(context).actions);
  return [...new Set(actions)];
}

function applyUserSettingsToTask(task, context) {
  const extraEvidence = settingsEvidence(context);
  const extraLabels = settingsLabels(context);
  const extraActions = settingsActions(context);
  const strategyBias = userStrategyBias(context);
  if (!extraEvidence.length && !extraLabels.length && !extraActions.length) return task;
  const goal = context.runtimeUserSettings?.default_goal;
  const speed = context.runtimeUserSettings?.operation_speed;
  const suffix = [
    goal === "safe_top_four" ? "Prefer robust top-four value over greedy cap unless current spot is clearly winning." : null,
    speed === "slow_needs_one_round_notice" ? "Give one-round notice before large board swaps." : null,
    strategyBias.notes.length ? `User strategy rows: ${strategyBias.notes.join("; ")}.` : null,
  ].filter(Boolean).join(" ");
  return {
    ...task,
    short_advice: suffix ? `${task.short_advice} ${suffix}` : task.short_advice,
    evidence: [...asArray(task.evidence), ...extraEvidence].slice(0, 10),
    actions: [...new Set([...asArray(task.actions), ...extraActions])],
    semantic_labels: [...new Set([...asArray(task.semantic_labels), ...extraLabels])],
    value_score: Number(Math.min(0.99, (task.value_score || 0) + (goal === "safe_top_four" ? 0.02 : 0) + strategyBias.valueBonus).toFixed(2)),
  };
}

const conditionalDecisionTaskTriggers = new Set([
  "direction_commit_or_exit",
  "lineup_convergence_checkpoint",
  "level_or_roll_timing",
  "tempo_pivot",
  "cap_gap_check",
  "augment_choice_advice",
]);

function attachLifecycleConditionalDecision(task, context) {
  if (task?.conditional_decision || !conditionalDecisionTaskTriggers.has(task?.trigger_id)) return task;
  const decision = context?.lineupLifecycle?.conditional_decision;
  if (!decision || decision.schema !== "jcc-conditional-coach-decision-v1") return task;
  return {
    ...task,
    conditional_decision: decision,
    semantic_labels: [...new Set([...(task.semantic_labels || []), "conditional_coach_output"])],
  };
}

function normalizeStreakPlan(strategy) {
  const plan = strategy?.streak_plan || strategy?.streakPlan || strategy?.current_streak_plan || null;
  if (!plan) return null;
  const type = String(plan.type || plan.kind || plan.plan || "").toLowerCase();
  const active = plan.active !== false && plan.enabled !== false;
  return {
    ...plan,
    type,
    active,
    current_streak: numberOrNull(plan.current_streak || plan.currentStreak || plan.streak),
    desired: firstDefined(plan.desired, plan.intentional, plan.target, true),
  };
}

function lastEmittedAt(previousAdviceState, triggerId) {
  const emitted = [
    ...asArray(previousAdviceState.emitted_tasks),
    ...asArray(previousAdviceState.tasks),
    ...asArray(previousAdviceState.recent_tasks),
  ];
  let latest = null;
  for (const task of emitted) {
    if (task.trigger_id !== triggerId && task.triggerId !== triggerId) continue;
    const time = Date.parse(task.emitted_at || task.generated_at || task.created_at || task.time || "");
    if (Number.isFinite(time) && (latest === null || time > latest)) latest = time;
  }
  return latest;
}

function applyInterruptPolicy(candidates, context, threshold) {
  const now = Date.parse(context.previousAdviceState.now || context.previousAdviceState.current_time || "");
  const currentTime = Number.isFinite(now) ? now : Date.now();
  const adviceTasks = [];
  const suppressedTasks = [];
  for (const task of candidates) {
    const cooldownSeconds = numberOrNull(context.cooldownSecondsByTrigger[task.trigger_id]) || 0;
    const last = cooldownSeconds ? lastEmittedAt(context.previousAdviceState, task.trigger_id) : null;
    if (last !== null && currentTime - last < cooldownSeconds * 1000) {
      suppressedTasks.push({
        ...task,
        suppressed: true,
        suppression_reason: "cooldown_active",
        retry_after_seconds: Math.max(1, Math.ceil((cooldownSeconds * 1000 - (currentTime - last)) / 1000)),
      });
      continue;
    }
    if (task.value_score >= threshold) adviceTasks.push(task);
    else suppressedTasks.push({ ...task, suppressed: true, suppression_reason: "below_minimum_value_score" });
  }
  return { adviceTasks, suppressedTasks };
}

function idCandidates(unit) {
  return [
    unit.key,
    String(unit.id || ""),
    String(unit.i || ""),
    String(unit.hero_id || ""),
    String(unit.base_id || ""),
  ].filter(Boolean);
}

function contextForUnits(units, context) {
  const hits = [];
  const hardWeightHits = [];
  const rankHits = [];
  const seen = new Set();
  for (const unit of units) {
    const ids = idCandidates(unit);
    const name = String(unit.name || "").toLowerCase();
    const dedupeKey = `${ids[0] || name}:${name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const targetHit = ids.some((id) => context.targetIds.has(id)) || context.targetNames.has(name);
    if (targetHit) hits.push({ id: unit.key, name: unit.name });

    const hard = ids.map((id) => context.entityWeights[id]).find(Boolean);
    if (hard) {
      const weights = hard.weights || hard.strategy_weights?.weights || {};
      const maxWeight = Math.max(0, ...Object.values(weights).map((value) => numberOrNull(value) || 0));
      hardWeightHits.push({
        id: unit.key,
        name: unit.name,
        primary_axes: hard.primary_axes || hard.strategy_weights?.primary_axes || [],
        max_weight: maxWeight,
      });
    }

    const rank = ids.map((id) => context.heroSignals.get(id)).find(Boolean);
    if (rank) {
      rankHits.push({
        id: unit.key,
        name: unit.name,
        signal_score: numberOrNull(rank.signal_score),
        top4_rate: numberOrNull(rank.top4_rate),
        avg_rank: numberOrNull(rank.avg_rank),
      });
    }
  }
  return { hits, hardWeightHits, rankHits };
}

function contextScoreBonus(units, context) {
  const unitContext = contextForUnits(units, context);
  const targetBonus = Math.min(0.14, unitContext.hits.length * 0.05);
  const hardBonus = Math.min(0.08, unitContext.hardWeightHits.reduce((sum, hit) => sum + (hit.max_weight >= 30 ? 0.04 : 0.02), 0));
  const rankBonus = Math.min(0.08, unitContext.rankHits.reduce((sum, hit) => sum + ((hit.signal_score || 0) >= 1 ? 0.04 : 0.02), 0));
  const confidenceBonus = Math.min(0.14, targetBonus * 0.4 + hardBonus * 0.5 + rankBonus * 0.5);
  return { ...unitContext, targetBonus, hardBonus, rankBonus, confidenceBonus };
}

function topLineupSignal(context) {
  if (!context.lineupSignals.length) return null;
  const targetName = String(
    context.targetPlan?.name
      || context.targetPlan?.target_name
      || context.targetPlan?.lineup_name
      || "",
  ).toLowerCase();
  const targetIds = new Set([
    context.targetPlan?.candidate_id,
    context.targetPlan?.lineup_group_id,
    context.targetPlan?.id,
    context.targetPlan?.atomic_roster_id,
    context.targetPlan?.variant_id,
  ].map((value) => String(value || "").trim()).filter(Boolean));
  return context.lineupSignals.find((lineup) => {
    const name = String(lineup.name || lineup.title || "").toLowerCase();
    const lineupIds = [
      lineup.candidate_id,
      lineup.id,
      lineup.lineup_id,
      lineup.variant_id,
      lineup.atomic_roster_id,
    ].map((value) => String(value || "").trim()).filter(Boolean);
    return (targetName && name.includes(targetName))
      || [...targetIds].some((targetId) => lineupIds.includes(targetId));
  }) || null;
}

function lineupSignalsForDecision(context, limit = 64) {
  return context.lineupSignals
    .slice(0, limit)
    .map((lineup) => ({
      id: lineup.id || lineup.lineup_id || lineup.variant_id || null,
      name: lineup.name || lineup.title || lineup.display_name || null,
      display_name: lineup.display_name || lineup.name || lineup.title || null,
      signal_score: numberOrNull(lineup.signal_score),
      top4_rate: numberOrNull(lineup.top4_rate),
      top1_rate: numberOrNull(lineup.top1_rate),
      use_rate: numberOrNull(lineup.use_rate),
      main_carry: lineup.main_carry || null,
      primary_tank: lineup.primary_tank || lineup.main_tank || null,
      main_traits: asArray(lineup.main_traits || lineup.core_traits).slice(0, 8),
      source_role: lineup.source_role || null,
      atomic_roster_id: lineup.atomic_roster_id
        || lineup.atomic_roster?.id
        || lineup.canonical_variant?.variant_id
        || null,
      candidate_evidence_id: lineup.candidate_evidence_id || lineup.canonical_variant?.candidate_evidence_id || null,
      atomic_roster_members: asArray(
        lineup.atomic_roster_members
          || lineup.atomic_roster?.members
          || lineup.canonical_variant?.core_unit_names,
      ),
      strength_anchor: lineup.strength_anchor || lineup.ranking_strength_anchor || null,
      metrics_authority: lineup.metrics_authority || lineup.ranking_metrics_authority || null,
      variant_id: lineup.variant_id || lineup.canonical_variant?.variant_id || null,
      core_units: lineup.core_units || null,
      core_unit_ids: asArray(lineup.core_unit_ids || lineup.canonical_variant?.core_unit_ids),
      core_unit_names: asArray(lineup.core_unit_names || lineup.canonical_variant?.core_unit_names),
      canonical_variant: lineup.canonical_variant || null,
      variants: asArray(lineup.variants),
      canonical_lineup_identity: lineup.canonical_lineup_identity || null,
      semantic_signature: lineup.semantic_signature || null,
      atomic_variant_comparison: lineup.atomic_variant_comparison || null,
      mature_recipe_variants: asArray(lineup.mature_recipe_variants),
      mature_recipe_variant_receipt: lineup.mature_recipe_variant_receipt || null,
      recipe_match: lineup.recipe_match || null,
      recipe_evidence: lineup.recipe_evidence || null,
      strategy_profile: lineup.strategy_profile || null,
      lifecycle_prior: lineup.lifecycle_prior || lineup.strategy_profile?.lifecycle_prior || null,
      equipment_requirements: lineup.equipment_requirements || lineup.strategy_profile?.equipment_requirements || null,
      condition_priors: lineup.condition_priors || lineup.strategy_profile?.condition_priors || null,
      formation_profile: lineup.formation_profile || lineup.strategy_profile?.formation_profile || null,
      transition_populations: asArray(lineup.transition_populations || lineup.strategy_profile?.transition_populations),
      transition_steps: asArray(lineup.transition_steps || lineup.strategy_profile?.transition_steps),
      roster_is_atomic: lineup.roster_is_atomic ?? lineup.canonical_variant?.roster_is_atomic ?? null,
      atomic_evidence_available: lineup.atomic_evidence_available ?? Boolean(
        lineup.canonical_variant?.variant_id && (
          asArray(lineup.canonical_variant?.core_unit_names).length
          || asArray(lineup.canonical_variant?.core_unit_ids).length
        ),
      ),
      atomic_evidence_source: lineup.atomic_evidence_source || lineup.canonical_variant?.source || null,
      provenance: lineup.provenance || lineup.strategy_profile?.provenance || null,
      evidence_boundary: lineup.evidence_boundary || null,
    }))
    .filter((lineup) => lineup.id || lineup.name || lineup.main_carry || lineup.primary_tank);
}

function evidence(type, summary, value = undefined) {
  return value === undefined ? { type, summary } : { type, summary, value };
}

function contextEvidence(unitContext, context) {
  const entries = [];
  if (unitContext.hits.length) {
    entries.push(evidence("target_plan.hit_units", `命中目标阵容 ${context.targetPlan?.name || context.targetPlan?.id || "current_plan"} 的牌`, unitContext.hits));
  }
  if (unitContext.hardWeightHits.length) {
    entries.push(evidence("hard_data.entity_strategy_weights", `硬数据命中 ${unitContext.hardWeightHits.length} 个实体权重`, unitContext.hardWeightHits));
  }
  if (unitContext.rankHits.length) {
    entries.push(evidence("live_rankings.unit_signal", `掌盟大师以上排名命中 ${unitContext.rankHits.length} 个英雄信号`, unitContext.rankHits));
  }
  return entries;
}

function contextLabels(unitContext) {
  const labels = [];
  if (unitContext.hits.length) labels.push("target_plan_alignment");
  if (unitContext.hardWeightHits.length) labels.push("hard_data_weighted");
  if (unitContext.rankHits.length) labels.push("live_rankings_prior");
  return labels;
}

function countByKey(units) {
  const counts = new Map();
  for (const unit of units) {
    const current = counts.get(unit.key) || { key: unit.key, name: unit.name, count: 0 };
    current.count += 1;
    counts.set(unit.key, current);
  }
  return [...counts.values()];
}

function sharedUnits(shopUnits, ownedUnits) {
  const ownedKeys = new Set(ownedUnits.map((unit) => unit.key));
  return shopUnits.filter((unit) => ownedKeys.has(unit.key));
}

function estimateCombatCap(live, context, coverage, lineupSignal) {
  const explicit = context.combatCapEstimator || {};
  const boardPower = numberOrNull(explicit.board_power_score);
  const itemPower = numberOrNull(explicit.item_power_score);
  const capPower = numberOrNull(explicit.cap_power_score);
  const survivalPressure = numberOrNull(explicit.survival_pressure_score);
  const expectedDamageRisk = numberOrNull(explicit.expected_damage_risk);
  const starScore = live.boardUnits.reduce((sum, unit) => sum + (unit.star || 1), 0) / Math.max(1, live.boardUnits.length * 3);
  const itemScore = itemPower ?? Math.min(1, (live.itemBench.length + live.equippedItems.length) / 6);
  const hpRisk = live.economy.hp === null ? 0.4 : live.economy.hp <= 35 ? 0.9 : live.economy.hp <= 55 ? 0.65 : 0.3;
  const rankCap = numberOrNull(lineupSignal?.top4_rate) || numberOrNull(lineupSignal?.signal_score) || 0.5;
  return {
    board_power_score: boardPower ?? Number(Math.min(1, starScore * 0.45 + itemScore * 0.2 + coverage * 0.35).toFixed(2)),
    item_power_score: Number(itemScore.toFixed(2)),
    cap_power_score: capPower ?? Number(Math.min(1, coverage * 0.45 + Math.min(1, rankCap) * 0.35 + (live.economy.level || 0) / 30).toFixed(2)),
    survival_pressure_score: survivalPressure ?? Number(Math.min(1, hpRisk * 0.55 + (1 - Math.min(1, starScore)) * 0.25).toFixed(2)),
    expected_damage_risk: expectedDamageRisk ?? Number(hpRisk.toFixed(2)),
    estimator_policy: explicit.estimator_policy || "fast_estimate_not_full_simulation",
  };
}

function makeTask(triggerId, valueScore, confidence, title, shortAdvice, evidenceRows, actions, semanticLabels = []) {
  const stageRound = evidenceRows.find((entry) => entry?.type === "phase.stage_round")?.value || null;
  let normalizedShortAdvice = String(shortAdvice || "");
  if (stageRound && !beforeStage(stageRound, "2-1")) {
    normalizedShortAdvice = normalizedShortAdvice
      .replaceAll("2-1 海克斯", "当前阶段")
      .replaceAll("等海克斯定方向", "按当前阶段定方向");
  }
  const taskId = `${triggerId}:${crypto.createHash("sha1").update(JSON.stringify({ evidenceRows, actions })).digest("hex").slice(0, 10)}`;
  const priority = valueScore >= 0.86 ? "high" : valueScore >= 0.74 ? "medium" : "low";
  return {
    task_id: taskId,
    trigger_id: triggerId,
    priority,
    value_score: Number(valueScore.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    title,
    short_advice: normalizedShortAdvice,
    reason_summary: evidenceRows.map((entry) => entry.summary).filter(Boolean).slice(0, 3).join("；"),
    evidence: evidenceRows,
    actions,
    semantic_labels: [...new Set(semanticLabels)],
    conditional_decision: null,
  };
}

function scoreInterest(live, context) {
  const { gold } = live.economy;
  if (gold === null || live.shopUnits.length === 0) return [];
  const owned = [...live.boardUnits, ...live.benchUnits];
  const matches = sharedUnits(live.shopUnits, owned);
  const duplicateInShop = countByKey(live.shopUnits).filter((entry) => entry.count >= 2);
  const unitContext = contextScoreBonus([...live.shopUnits, ...matches], context);
  const nearBreakpoint = gold % 10 >= 7 || gold % 10 <= 1;
  if (!nearBreakpoint && matches.length === 0 && duplicateInShop.length === 0 && unitContext.hits.length === 0) return [];
  const valueScore = Math.min(0.97, 0.5 + (nearBreakpoint ? 0.18 : 0) + matches.length * 0.08 + duplicateInShop.length * 0.1 + unitContext.targetBonus + unitContext.hardBonus + unitContext.rankBonus);
  const planPhrase = unitContext.hits.length ? `命中 ${context.targetPlan?.name || "目标阵容"} 的 ${unitContext.hits.map((unit) => unit.name).slice(0, 2).join("、")}，` : matches.length ? `有 ${matches.map((unit) => unit.name).slice(0, 2).join("、")} 能接对子/体系，` : "";
  return [makeTask(
    "interest_breakpoint_decision",
    valueScore,
    Math.min(0.9, (matches.length || duplicateInShop.length ? 0.68 : 0.54) + unitContext.confidenceBonus),
    "嫖卡/利息判断",
    `商店刷新后先核对利息：金币 ${gold}，${planPhrase}不要为了低价值牌随便破整十。`,
    [
      evidence("economy.gold", `当前金币 ${gold}`, gold),
      evidence("shop.shop_units", `商店 ${live.shopUnits.length} 张牌`, live.shopUnits.map((unit) => unit.name)),
      evidence("shop_owned_overlap", `商店命中已有牌 ${matches.length} 张`, matches.map((unit) => unit.name)),
      ...contextEvidence(unitContext, context),
    ],
    ["review_hold_sell_for_interest"],
    ["sit_on_gold_interest", "sell_unit", ...contextLabels(unitContext)],
  )];
}

function scoreShopHoldSell(live, context) {
  const { gold } = live.economy;
  if (gold === null || live.shopUnits.length === 0) return [];
  const owned = [...live.boardUnits, ...live.benchUnits];
  const matches = sharedUnits(live.shopUnits, owned);
  const duplicateInShop = countByKey(live.shopUnits).filter((entry) => entry.count >= 2);
  const unitContext = contextScoreBonus([...live.shopUnits, ...matches], context);
  const interestRemainder = gold % 10;
  const atRiskInterest = interestRemainder <= 2 || interestRemainder >= 8;
  const targetHits = unitContext.hits.length;
  if (!atRiskInterest && matches.length === 0 && duplicateInShop.length === 0 && targetHits === 0) return [];
  const holdPressure = matches.length + duplicateInShop.length + targetHits;
  const valueScore = Math.min(0.96, 0.56 + holdPressure * 0.08 + (atRiskInterest ? 0.12 : 0) + unitContext.hardBonus + unitContext.rankBonus);
  const interestText = atRiskInterest ? `gold ${gold} is near an interest breakpoint` : `gold ${gold}`;
  const hitText = targetHits
    ? `target hits: ${unitContext.hits.map((unit) => unit.name).slice(0, 3).join(', ')}`
    : matches.length
      ? `owned-unit hits: ${matches.map((unit) => unit.name).slice(0, 3).join(', ')}`
      : 'pair/transition candidates are present';
  return [makeTask(
    'shop_hold_sell_interest',
    valueScore,
    Math.min(0.88, 0.6 + unitContext.confidenceBonus + (atRiskInterest ? 0.04 : 0)),
    'Shop hold/sell',
    `After the free shop refresh, decide before buying: ${interestText}; ${hitText}. If buying breaks interest, keep only target, pair, or key transition units and sell low-value fillers first.`,
    [
      evidence('economy.gold', `Current gold ${gold}`, gold),
      evidence('shop.shop_units', `Shop has ${live.shopUnits.length} units`, live.shopUnits.map((unit) => unit.name)),
      evidence('shop_owned_overlap', `Shop overlaps owned units: ${matches.length}`, matches.map((unit) => unit.name)),
      evidence('shop_duplicates', `Shop pair candidates: ${duplicateInShop.length}`, duplicateInShop),
      ...contextEvidence(unitContext, context),
    ],
    ['decide_shop_holds_before_buying_or_selling'],
    ['shop_hold_sell_interest', 'sit_on_gold_interest', 'sell_unit', ...contextLabels(unitContext)],
  )];
}

function scoreKeyUnitProgression(live, context) {
  if (!context.targetPlan || (!context.targetIds.size && !context.targetNames.size)) return [];
  const owned = [...live.boardUnits, ...live.benchUnits];
  const unitContext = contextScoreBonus(owned, context);
  if (!unitContext.hits.length) return [];
  const hitKeys = new Set(unitContext.hits.map((unit) => String(unit.id || unit.name || "")));
  const targetUnits = owned.filter((unit) => hitKeys.has(String(unit.key)) || hitKeys.has(String(unit.name)));
  const targetCounts = countByKey(targetUnits);
  const pairOrMore = targetCounts.filter((entry) => entry.count >= 2);
  const upgraded = targetUnits.filter((unit) => Number(unit.star) >= 2);
  const highCost = targetUnits.filter((unit) => Number(unit.cost) >= 4);
  const valueScore = Math.min(
    0.95,
    0.72
      + Math.min(0.08, unitContext.hits.length * 0.03)
      + Math.min(0.06, pairOrMore.length * 0.03)
      + Math.min(0.06, upgraded.length * 0.03)
      + Math.min(0.05, highCost.length * 0.025),
  );
  const names = [...new Set(targetUnits.map((unit) => unit.name).filter(Boolean))].slice(0, 4);
  return [makeTask(
    "key_unit_progression",
    valueScore,
    Math.min(0.9, 0.66 + unitContext.confidenceBonus + (upgraded.length ? 0.06 : 0)),
    "关键牌进度",
    `目标阵容关键牌发生实质进展：${names.join("、")}。结合当前阶段、经济、装备和已选强化，重新判断应继续留牌追质量、转为上人口，还是保持弹性。`,
    [
      evidence("target_plan.hit_units", `已拥有目标关键牌 ${names.length} 种`, targetUnits),
      evidence("target_plan.pair_or_more", `目标关键牌对子/多张 ${pairOrMore.length} 组`, pairOrMore),
      evidence("target_plan.upgraded_units", `目标关键牌已升星 ${upgraded.length} 个`, upgraded),
      evidence("phase.stage_round", `当前回合 ${live.phase.stageRound ?? "unknown"}`, live.phase.stageRound),
      ...contextEvidence(unitContext, context),
    ],
    [
      ...names.map((name) => `hold_or_reassess_key_unit:${name}`),
      "reassess_commit_roll_or_level_from_key_unit_progress",
    ],
    ["key_unit_progression", "direction_commit_or_exit", "level_or_roll_timing", ...contextLabels(unitContext)],
  )];
}

function scoreShopWithoutEconomy(live, context) {
  if (live.economy.gold !== null || live.shopUnits.length === 0) return [];
  const owned = [...live.boardUnits, ...live.benchUnits];
  const matches = sharedUnits(live.shopUnits, owned);
  const duplicateInShop = countByKey(live.shopUnits).filter((entry) => entry.count >= 2);
  const unitContext = contextScoreBonus([...live.shopUnits, ...matches], context);
  if (!matches.length && !duplicateInShop.length && !unitContext.hits.length) return [];
  const hitNames = [
    ...unitContext.hits.map((unit) => unit.name),
    ...matches.map((unit) => unit.name),
    ...duplicateInShop.map((entry) => entry.name),
  ].filter(Boolean);
  return [makeTask(
    "shop_hold_without_economy",
    Math.min(0.88, 0.72 + unitContext.targetBonus + unitContext.rankBonus),
    Math.min(0.78, 0.58 + unitContext.confidenceBonus),
    "Shop decision needs economy",
    `Shop has useful candidates (${[...new Set(hitNames)].slice(0, 3).join(", ")}), but gold/interest is missing. Hold target, pair, or key transition units only if it does not break the next interest point; refresh economy state before a hard buy/sell call.`,
    [
      evidence("economy.gold", "Gold is missing from live_state; need an economy refresh before strict interest advice", null),
      evidence("shop.shop_units", `Shop has ${live.shopUnits.length} units`, live.shopUnits.map((unit) => unit.name)),
      evidence("shop_owned_overlap", `Shop overlaps owned units: ${matches.length}`, matches.map((unit) => unit.name)),
      evidence("shop_duplicates", `Shop pair candidates: ${duplicateInShop.length}`, duplicateInShop),
      ...contextEvidence(unitContext, context),
    ],
    ["visual_sensing_probe:economy", "hold_only_target_pair_or_key_transition"],
    ["shop_hold_sell_interest", "visual_sensing_probe", "sit_on_gold_interest", ...contextLabels(unitContext)],
  )];
}

function scoreEarlyDirectionConversation(live, context) {
  const major = stageMajor(live.phase.stageRound);
  const isEarly = major === null || major <= 2;
  if (!isEarly || context.targetPlan) return [];

  const allUnits = [...live.boardUnits, ...live.benchUnits, ...live.shopUnits];
  const unitContext = contextScoreBonus(allUnits, context);
  const pairCandidates = countByKey(allUnits).filter((entry) => entry.count >= 2);
  const rankingDirections = lineupSignalsForDecision(context);
  const hasActiveEarlyDecision =
    rankingDirections.length > 0 ||
    live.shopUnits.length > 0 ||
    live.itemBench.length > 0 ||
    live.equippedItems.length > 0 ||
    live.selectedAugments.length > 0 ||
    live.augmentChoiceCandidates.length > 0 ||
    pairCandidates.length > 0 ||
    live.economy.gold === null ||
    live.economy.hp === null;
  if (!hasActiveEarlyDecision) return [];
  const missing = [];
  const valueScore = Math.min(0.9, 0.72 + Math.min(0.1, pairCandidates.length * 0.04) + unitContext.hardBonus + unitContext.rankBonus);
  const directionHint = rankingDirections.length
    ? `优先从当前掌盟大师以上候选中探索 ${rankingDirections.length} 条真实方向，再用强化、装备和来牌判断兑现顺序`
    : pairCandidates.length
    ? `先围绕对子/两星机会看过渡：${pairCandidates.map((entry) => entry.name).slice(0, 3).join(", ")}`
    : live.shopUnits.length
      ? "先从商店里的强过渡牌、体系对子、装备方向里临时找路，不要在海克斯前死锁阵容"
      : "先根据野怪掉牌和装备判断能不能走连胜；不顺就保经济等海克斯定方向";
  return [makeTask(
    "early_direction_conversation",
    valueScore,
    Math.min(0.82, 0.62 + unitContext.confidenceBonus),
    "Early cruise direction",
    `${directionHint}. 可以先问用户一句想硬玩什么；如果没有明确目标，就用当前牌/装备/2-1 海克斯动态决定连胜、连败或强过渡。${missing.length ? ` Missing: ${missing.join(", ")}; refresh self-state visual/economy fields.` : ""}`,
    [
      evidence("phase.stage_round", `Early stage ${live.phase.stageRound ?? "unknown"}`, live.phase.stageRound),
      evidence("board_bench_shop.units", `Visible own/shop unit context: ${allUnits.length} units`, allUnits.map((unit) => unit.name)),
      evidence("pair_candidates", `Pair/two-star candidates: ${pairCandidates.length}`, pairCandidates),
      ...(rankingDirections.length
        ? [evidence("live_rankings.lineup_candidates", `当前可比较的国服大师以上阵容方向 ${rankingDirections.length} 条`, rankingDirections)]
        : []),
      evidence("economy", "Economy/HP/level are required for interest and tempo calls", live.economy),
      evidence("items", `Item information count: ${live.itemBench.length + live.equippedItems.length}`, {
        item_bench: live.itemBench,
        equipped_items: live.equippedItems,
      }),
      ...contextEvidence(unitContext, context),
    ],
    ["ask_user_goal_if_unknown", "visual_sensing_probe:economy", "visual_sensing_probe:items", "play_strongest_transition_until_direction_commits"],
    ["early_direction_conversation", "shop_hold_sell_interest", "direction_commit_or_exit", "item_slam_or_greed", ...contextLabels(unitContext)],
  )];
}

function scoreLineupConvergenceCheckpoint(live, context) {
  const stage = live.phase.stageRound;
  if (!stage) return [];
  const major = stageMajor(stage);
  const fixedCheckpoint = cruiseCheckpointForStage(stage);
  if (!fixedCheckpoint || major === null || major < 2 || major > 4) return [];
  const selectedAugments = live.selectedAugments.map((entry) => entry?.name || entry?.text || entry?.id || entry).filter(Boolean);
  const allUnits = [...live.boardUnits, ...live.benchUnits, ...live.shopUnits];
  const pairCandidates = countByKey(allUnits).filter((entry) => entry.count >= 2).map((entry) => entry.name).filter(Boolean);
  const itemNames = [...live.itemBench, ...live.equippedItems]
    .map((entry) => entry?.name || entry?.item_name || entry?.display_name || entry)
    .filter(Boolean);
  const checkpoint = fixedCheckpoint.scorer_checkpoint;
  const durableTarget = context.targetContextAuthority === "durable_target_plan" && Boolean(context.targetPlan);
  const targetExecutionCheckpoint = durableTarget;
  const lineupSignal = topLineupSignal(context);
  const rankingDirections = lineupSignalsForDecision(context);
  const highCostCandidateTypes = new Set(["four_cost_carry", "legendary_cap"]);
  const hasHighCostCandidate = rankingDirections.some((candidate) => {
    const archetype = candidate?.lifecycle_prior?.archetype
      || candidate?.strategy_profile?.lifecycle_prior?.archetype
      || candidate?.strategy_profile?.archetype
      || null;
    return highCostCandidateTypes.has(String(archetype || ""));
  });
  // This checkpoint owns the visible Coach turn. Tempo, economy, and item
  // signals are evidence for the lineup agenda, not sibling answers that can
  // repeatedly reduce the result to "keep transitioning".
  const valueScore = checkpoint === "commit_and_execute" ? 0.93
    : checkpoint === "provisional_commit" ? 0.92
      : checkpoint === "narrow_candidates" ? 0.91
        : 0.90;
  const actions = targetExecutionCheckpoint
    ? ["validate_continue_or_exit_target_now", "give_roll_level_gold_item_and_board_execution", "state_the_single_condition_that_still_justifies_pivot"]
    : checkpoint === "explore_candidates"
    ? ["rank_two_or_three_candidate_lines", "state_item_augment_and_card_requirements", "preserve_economy_until_evidence_improves"]
    : checkpoint === "prepare_next_choice"
      ? ["refresh_direction_before_next_augment", "state_pre_3_2_or_pre_4_2_requirements", "fold_economy_and_item_tempo_into_direction"]
    : checkpoint === "narrow_candidates"
      ? ["name_one_primary_and_one_backup_line", "state_main_carry_tank_and_roll_level", "state_what_4_2_can_still_change"]
        : checkpoint === "provisional_commit"
        ? [
            "recommend_relative_commit_or_wait_for_next_stage",
            ...(stage === "3-5" && !durableTarget && hasHighCostCandidate
              ? ["state_level_7_transition_for_relevant_high_cost_candidates"]
              : []),
            "ask_at_most_one_non_blocking_user_preference_question",
            "state_cost_of_waiting",
          ]
        : ["commit_or_pivot_now", "give_roll_level_gold_and_core_unit_execution", "adapt_cap_to_hp_and_economy"];
  const strategicInstruction = checkpoint === "explore_candidates"
    ? "必须给出两到三条完整的真实阵容方向，说明主C、主坦、核心羁绊、过渡路线、装备/强化适配和转向条件；Ranking 是首要方向先验，当前棋盘只用于判断能否兑现。"
    : checkpoint === "prepare_next_choice"
      ? "必须在下一次强化前更新阵容方向：给出当前最值得探索的完整路线、备用路线和关键准备条件；不要只说保持灵活。"
    : checkpoint === "narrow_candidates"
      ? "必须把方向收束到两到三条可比较路线，明确每条的主C、主坦、成型人口、强化/装备影响和何时退出；不要只说保持灵活。"
      : checkpoint === "provisional_commit"
        ? `必须给出一条主线和一条备选，并说明等待下一检查点会改变什么；可以询问一次确认，但不能用‘证据不足’代替方向。${stage === "3-5" ? " 若候选中确有四费运营或九五路线且用户尚未确认目标，只简洁给出对应的七人口过渡阵容；不要在3-5展开4-1与4-2上八人口的启动经济比较，该比较留到3-7。" : ""}${fixedCheckpoint.focus === "phase_fork" ? " 需要比较三费赌狗、四费运营/快八和九五等生命周期分支。" : ""}`
        : "必须收束到一条主线和最多一条备选，说明当前下限、成型条件、经济/装备代价和最终确认问题。";
  return [makeTask(
    "lineup_convergence_checkpoint",
    valueScore,
    0.76,
    "Lineup convergence checkpoint",
    targetExecutionCheckpoint
      ? `Stage ${stage} entered target execution. Validate whether ${context.targetPlan?.name || context.targetPlan?.summary || "the confirmed target"} should continue or exit, then give the immediate roll, level, economy, item, and board actions. A named target without parsed unit ids is still an execution decision, not permission to stay silent.`
      : `Stage ${stage} entered ${checkpoint}. ${strategicInstruction} Use confirmed augments, equipment, own cards, economy, HP, and the captured Master+ Ranking Overlay candidates to move the player from flexible transition toward an executable lineup.`,
    [
      evidence("phase.stage_round", `Lineup agenda checkpoint ${stage}`, stage),
      evidence("augments.selected_augments", `Confirmed augments: ${selectedAugments.length}`, selectedAugments),
      evidence("items", `Known item facts: ${itemNames.length}`, itemNames),
      evidence("board_bench_shop.units", `Observed own/shop units: ${allUnits.length}`, allUnits.map((unit) => unit.name)),
      evidence("pair_candidates", `Pairs or upgrade signals: ${pairCandidates.length}`, pairCandidates),
      evidence("economy", "Current HP, gold, level, and XP constrain the commit", live.economy),
      ...(lineupSignal ? [evidence("live_rankings.lineup_signal", "Current captured Tencent/JCC Master+ lineup prior for convergence", lineupSignal)] : []),
      ...(rankingDirections.length
        ? [evidence("live_rankings.lineup_candidates", `Current captured Master+ directions available for comparison: ${rankingDirections.length}`, rankingDirections)]
        : []),
      ...(context.targetPlan ? [evidence("target_plan", "Confirmed target must receive an execution or exit decision after the final major choice", context.targetPlan)] : []),
    ],
    actions,
    ["lineup_convergence_checkpoint", "direction_commit_or_exit", checkpoint, fixedCheckpoint.semantic_label, ...(targetExecutionCheckpoint ? ["target_execution_checkpoint"] : [])],
  )];
}

function scoreLateLineupConvergenceCheckpoint(live, context) {
  const stage = live.phase.stageRound;
  const major = stageMajor(stage);
  const fixedCheckpoint = cruiseCheckpointForStage(stage);
  if (!stage || major === null || major < 5 || !fixedCheckpoint) return [];
  const target = context.targetPlan;
  const rankingDirections = lineupSignalsForDecision(context);
  const allUnits = [...live.boardUnits, ...live.benchUnits, ...live.shopUnits];
  const unitContext = contextScoreBonus(allUnits, context);
  const label = target
    ? "late_target_cap_review"
    : "late_lineup_commit_and_cap_review";
  return [makeTask(
    "lineup_convergence_checkpoint",
    0.96,
    0.74,
    "Late lineup ceiling checkpoint",
    target
      ? `Stage ${stage} requires a target ceiling/floor review. Compare the confirmed target's current quality, level 8/9/10 upgrades, high-cost replacements, economy cost, and whether a special trait breakpoint is worth the remaining HP.`
      : `Stage ${stage} requires a final lineup direction and ceiling review. Compare the strongest real Ranking directions, name a main line and fallback, then state what must be completed before the next loss.` ,
    [
      evidence("phase.stage_round", `Late lineup checkpoint ${stage}`, stage),
      evidence("economy", "Late-stage economy and HP constrain ceiling versus stabilization", live.economy),
      evidence("board_bench_shop.units", `Observed late-stage units: ${allUnits.length}`, allUnits.map((unit) => unit.name)),
      ...(rankingDirections.length
        ? [evidence("live_rankings.lineup_candidates", `Master+ directions available: ${rankingDirections.length}`, rankingDirections)]
        : []),
      ...(target ? [evidence("target_plan", "Confirmed target for ceiling review", target)] : []),
      ...contextEvidence(unitContext, context),
    ],
    target
      ? ["compare_current_floor_to_target_cap", "decide_level_8_9_10_or_quality", "state_target_exit_condition"]
      : ["choose_final_line_from_real_candidates", "compare_floor_and_ceiling", "state_commit_or_pivot_condition"],
    [label, "cap_gap_check", "lineup_convergence_checkpoint", "lineup_strategy_is_primary", fixedCheckpoint.semantic_label, ...contextLabels(unitContext)],
  )];
}

function normalizeCruiseTaskForCurrentStage(task, live) {
  if (!task || task.trigger_id !== "early_direction_conversation") return task;
  if (beforeStage(live.phase.stageRound, "2-1") || live.phase.stageRound === null) return task;
  const allUnits = [...live.boardUnits, ...live.benchUnits, ...live.shopUnits];
  const pairCandidates = countByKey(allUnits).filter((entry) => entry.count >= 2);
  const pairText = pairCandidates.length
    ? `围绕对子/两星过渡：${pairCandidates.map((entry) => entry.name).slice(0, 3).join(", ")}。`
    : "按当前场上、备战席和商店质量打最强过渡。";
  const augmentText = live.selectedAugments.length
    ? `已选强化：${live.selectedAugments.map((entry) => entry.name || entry.text || entry.id || entry).slice(0, 3).join(", ")}。`
    : "首个强化最终选择未记录，需要向用户确认刚刚选了哪个强化；不要再按选择前信息判断。";
  const missing = [];
  if (live.economy.gold === null) missing.push("gold");
  if (live.economy.hp === null) missing.push("hp");
  if (live.economy.level === null) missing.push("level");
  return {
    ...task,
    short_advice: `${live.phase.stageRound || "当前阶段"}：${pairText}${augmentText}${missing.length ? ` Missing: ${missing.join(", ")}; refresh self-state HUD before exact economy/tempo advice.` : ""}`,
    semantic_labels: [...new Set([...asArray(task.semantic_labels), "post_augment_no_wait_2_1"])],
  };
}

function scoreStreakGuard(live, context) {
  const streakPlan = normalizeStreakPlan(live.strategy);
  if (!streakPlan || !streakPlan.active) return [];
  const { hp, gold } = live.economy;
  const stage = live.phase.stageRound;
  const major = stageMajor(stage);
  const isLose = streakPlan.type.includes("lose") || streakPlan.type.includes("open") || streakPlan.type.includes("loss");
  const isWin = streakPlan.type.includes("win");
  if (!isLose && !isWin) return [];
  const boardContext = contextScoreBonus([...live.boardUnits, ...live.benchUnits, ...live.shopUnits], context);
  const hpDanger = hp !== null && ((major || 0) <= 3 ? hp <= 62 : hp <= 42);
  const buyablePower = boardContext.hits.length > 0 || sharedUnits(live.shopUnits, live.boardUnits).length > 0;
  const shouldSpeak = isLose ? hpDanger || buyablePower || (gold !== null && gold % 10 >= 8) : hpDanger || buyablePower;
  if (!shouldSpeak) return [];
  const valueScore = Math.min(0.95, 0.62 + (hpDanger ? 0.14 : 0) + (buyablePower ? 0.1 : 0) + boardContext.targetBonus * 0.5);
  const label = isLose ? "连败/空城保护" : "连胜保护";
  const advice = isLose
    ? `当前是连败/空城计划，但血量 ${hp ?? "未知"}、商店价值和利息要一起看：能继续控败就别乱上强度，血线危险就立刻转稳血。`
    : "Current plan is win streak: if shop/board has direct upgrades, protect tempo first; if own board and HP risk look weak, preserve economy instead of forcing spend.";
  return [makeTask(
    "streak_guard",
    valueScore,
    Math.min(0.86, 0.62 + boardContext.confidenceBonus),
    label,
    advice,
    [
      evidence("strategy.streak_plan", `当前 streak plan: ${streakPlan.type}`, streakPlan),
      evidence("economy.hp_gold", `血量/金币 ${hp ?? "unknown"}/${gold ?? "unknown"}`, { hp, gold }),
      evidence("phase.stage_round", `当前回合 ${stage ?? "unknown"}`, stage),
      ...contextEvidence(boardContext, context),
    ],
    ["evaluate_streak_plan_before_next_action"],
    [isLose ? "open_fort_lose_streak" : "win_streak_tempo", "streak_guard", ...contextLabels(boardContext)],
  )];
}

function scoreBenchSpace(live, context) {
  if (live.benchUnits.length < 7) return [];
  const unitContext = contextScoreBonus(live.benchUnits, context);
  const valueScore = Math.min(0.94, 0.54 + (live.benchUnits.length - 6) * 0.12 + live.shopUnits.length * 0.02);
  return [makeTask(
    "bench_space_pressure",
    valueScore,
    Math.min(0.85, 0.66 + unitContext.confidenceBonus),
    "备战席压力",
    `备战席已有 ${live.benchUnits.length} 个单位，下一次买牌前先清低价值挂件/无关卡，避免关键牌进不来。`,
    [
      evidence("bench.bench_units", `备战席 ${live.benchUnits.length} 个单位`, live.benchUnits.map((unit) => unit.name)),
      evidence("shop.shop_units", `当前商店 ${live.shopUnits.length} 张牌`, live.shopUnits.map((unit) => unit.name)),
      ...contextEvidence(unitContext, context),
    ],
    ["review_bench_sell_priority"],
    ["sell_unit", "bench_space_pressure", ...contextLabels(unitContext)],
  )];
}

function scoreLevelOrRoll(live, context) {
  const stage = live.phase.stageRound;
  const { gold, level, hp } = live.economy;
  const economyLeveling = context.combatCapEstimator?.economy_leveling || context.economy_leveling || {};
  if (economyLeveling.status === "ready" && asArray(economyLeveling.actions).length) {
    const best = lifecycleSafeEconomyAction(
      asArray(economyLeveling.actions)[0],
      asArray(economyLeveling.actions),
      live,
      context.lineupLifecycle,
    );
    const math = economyLeveling.leveling_math || {};
    const xp = economyLeveling.live_economy?.xp || {};
    const actionTextById = {
      hold_gold_interest: "先保利息",
      prelevel_next_round: "这波预升，等下回合自然升级",
      level_now_no_roll: "这波直接升人口，先不D",
      level_then_roll_small: "升人口后小D一手",
      roll_small_for_immediate_board_upgrades: "只小D修补当前板，不在7级追主C",
      roll_down_stabilize: "先D牌稳血，不急着升",
    };
    const short = actionTextById[best.action] || "重新评估升人口/D牌节奏";
    const details = [
      best.clicks !== undefined ? `点 ${best.clicks} 下` : null,
      best.gold_cost !== undefined ? `花 ${best.gold_cost} 金币` : null,
      best.gold_after !== undefined ? `剩 ${best.gold_after}` : null,
      best.interest_loss ? `少吃约 ${best.interest_loss} 块利息` : null,
      best.roll_equivalent_value ? `换一手高等级卡池价值约 ${best.roll_equivalent_value}` : null,
    ].filter(Boolean).join("，");
    return [makeTask(
      "level_or_roll_timing",
      Math.min(0.97, 0.66 + Math.max(0, best.score || 0) * 0.18),
      best.confidence === "high" ? 0.86 : best.confidence === "low" ? 0.62 : 0.76,
      "经济/升级节奏",
      `${short}${details ? `：${details}` : ""}。这是按当前 ${level ?? "?"}级 ${xp.display || `${live.economy.xp ?? "?"}`}、金币 ${gold ?? "未知"}、血量 ${hp ?? "未知"} 和目标卡池即时算的，不是固定节奏表。`,
      [
        evidence("economy.leveling_ev.best_action", `当前最优候选动作 ${best.action}`, best),
        evidence("economy.leveling_math", `距下一级 ${math.need_to_next_level ?? "unknown"} XP，预升/直升成本已按当前 XP policy 计算`, math),
        evidence("economy.xp_policy", "XP 规则可被海克斯/奇遇修改，scorer 只读取合成后的 policy", economyLeveling.xp_policy),
      ],
    [best.action, "compare_level_roll_interest_ev"],
      ["level_or_roll_timing", best.action, "sit_on_gold_interest", "win_streak_tempo", ...(best.lifecycle_prior_conflict ? ["lifecycle_prior_conflict"] : [])],
    )];
  }
  if (!stage || !TIMING_WINDOWS.has(stage)) return [];
  const unitContext = contextScoreBonus([...live.boardUnits, ...live.benchUnits], context);
  const hpRisk = hp !== null && hp <= (stageMajor(stage) >= 4 ? 45 : 62);
  const goldReady = gold !== null && gold >= 24;
  const valueScore = Math.min(0.96, 0.58 + (goldReady ? 0.13 : 0) + (hpRisk ? 0.17 : 0) + (live.boardUnits.length < (level || 0) ? 0.08 : 0) + unitContext.targetBonus * 0.5 + unitContext.rankBonus * 0.5);
  return [makeTask(
    "level_or_roll_timing",
    valueScore,
    Math.min(0.86, (hpRisk || goldReady ? 0.7 : 0.58) + unitContext.confidenceBonus),
    "节奏窗口",
    `${stage} 是节奏判断点：金币 ${gold ?? "未知"}、血量 ${hp ?? "未知"}、等级 ${level ?? "未知"}，先判断是稳血 D/拉人口，还是继续存钱。`,
    [
      evidence("phase.stage_round", `当前回合 ${stage}`, stage),
      evidence("economy.gold", `金币 ${gold ?? "unknown"}`, gold),
      evidence("economy.hp", `血量 ${hp ?? "unknown"}`, hp),
      evidence("economy.level", `等级 ${level ?? "unknown"}`, level),
      ...contextEvidence(unitContext, context),
    ],
    ["evaluate_level_or_roll_timing"],
    ["level_up", "roll_down_stabilize", "sit_on_gold_interest", ...contextLabels(unitContext)],
  )];
}

function lifecycleSafeEconomyAction(best, actions, live, lifecycle) {
  if (!best || lifecycle?.archetype !== "four_cost_carry" || live.economy.level !== 7) {
    return best;
  }
  if (best.action !== "roll_down_stabilize") return best;
  const goldCost = Number(best.gold_cost);
  if (!Number.isFinite(goldCost) || goldCost <= 6) return best;
  const lossBuffer = Number(lifecycle?.board_readiness?.loss_buffer_rounds);
  const overrideSignals = new Set(asArray(lifecycle?.override_signals));
  const survivalOverride = (Number.isFinite(lossBuffer) && lossBuffer <= 1)
    || overrideSignals.has("high_immediate_roll_marginal_gain")
    || overrideSignals.has("board_below_stabilization_floor");
  return {
    ...best,
    confidence: survivalOverride ? "medium" : best.confidence,
    guardrail: survivalOverride
      ? "level_7_four_cost_roll_has_survival_or_upgrade_override_evidence"
      : "level_7_four_cost_roll_conflicts_with_level_8_search_prior_and_requires_host_reconciliation",
    lifecycle_prior_conflict: survivalOverride ? false : true,
    lifecycle_conditional_evidence: {
      default_prior: "preserve_economy_for_level_8_four_cost_search",
      override_signals: [...overrideSignals],
      loss_buffer_rounds: Number.isFinite(lossBuffer) ? lossBuffer : null,
      original_action_preserved: true,
    },
  };
}

function scoreTempo(live, context) {
  const { hp, gold, level } = live.economy;
  const stage = live.phase.stageRound;
  const major = stageMajor(stage);
  if (hp === null || !major) return [];
  const danger =
    (major <= 2 && hp <= 72) ||
    (major === 3 && hp <= 58) ||
    (major === 4 && hp <= 42) ||
    (major >= 5 && hp <= 28);
  if (!danger) return [];
  const unitContext = contextScoreBonus([...live.boardUnits, ...live.benchUnits], context);
  return [makeTask(
    "tempo_pivot",
    Math.min(0.96, 0.72 + (major >= 4 ? 0.12 : 0) + (gold !== null && gold >= 30 ? 0.08 : 0) + unitContext.targetBonus * 0.4),
    Math.min(0.9, 0.72 + unitContext.confidenceBonus),
    "血量风险",
    `血量 ${hp} 在 ${stage} 已经偏危险，下一波优先稳血：能补强就补强，别只按原计划贪经济。`,
    [
      evidence("economy.hp", `当前血量 ${hp}`, hp),
      evidence("phase.stage_round", `当前回合 ${stage}`, stage),
      evidence("economy.gold_level", `金币/等级 ${gold ?? "unknown"}/${level ?? "unknown"}`),
      ...contextEvidence(unitContext, context),
    ],
    ["evaluate_stabilize_now"],
    ["roll_down_stabilize", "pivot", "win_streak_tempo", ...contextLabels(unitContext)],
  )];
}

function scoreShopLock(live, context) {
  const { gold } = live.economy;
  if (gold === null || live.shopUnits.length === 0) return [];
  const owned = [...live.boardUnits, ...live.benchUnits];
  const matches = sharedUnits(live.shopUnits, owned);
  const duplicateInShop = countByKey(live.shopUnits).filter((entry) => entry.count >= 2);
  const unitContext = contextScoreBonus([...live.shopUnits, ...matches], context);
  if (matches.length + duplicateInShop.length < 2 && unitContext.hits.length < 2) return [];
  const lowGold = gold < matches.length + duplicateInShop.length;
  const valueScore = Math.min(0.93, (lowGold ? 0.79 : 0.72) + unitContext.targetBonus + unitContext.rankBonus);
  return [makeTask(
    "shop_lock_decision",
    valueScore,
    Math.min(0.82, 0.62 + unitContext.confidenceBonus),
    "是否锁商店",
    `这家商店有多张可用牌但金币 ${gold} 有限制；如果买不完关键对子/体系牌，考虑锁一轮。`,
    [
      evidence("shop_owned_overlap", `命中已有牌 ${matches.length} 张`, matches.map((unit) => unit.name)),
      evidence("shop_duplicates", `商店内重复组 ${duplicateInShop.length} 组`, duplicateInShop),
      evidence("economy.gold", `当前金币 ${gold}`, gold),
      ...contextEvidence(unitContext, context),
    ],
    ["consider_lock_shop"],
    ["lock_shop", "sit_on_gold_interest", ...contextLabels(unitContext)],
  )];
}

function scoreItems(live, context) {
  if (live.itemBench.length < 2) return [];
  const { hp } = live.economy;
  const stage = live.phase.stageRound;
  const hpPressure = hp !== null && hp <= (stageMajor(stage) >= 4 ? 50 : 65);
  const boardContext = contextScoreBonus(live.boardUnits, context);
  const valueScore = Math.min(0.92, (hpPressure ? 0.82 : 0.69) + boardContext.targetBonus * 0.4);
  const posture = hpPressure ? "slam_now" : "wait_component";
  return [makeTask(
    "item_slam_or_greed",
    valueScore,
    Math.min(0.82, (hpPressure ? 0.68 : 0.55) + boardContext.confidenceBonus),
    "装备取舍",
    `装备栏有 ${live.itemBench.length} 件可用装备/散件；${hpPressure ? `血量 ${hp} 有压力，先按 slam_now 评估能否合保血装。` : "当前先按 wait_component 评估，但要结合持有人、目标阵容、工具和近端奖励窗口。"}`,
    [
      evidence("items.item_bench", `装备栏 ${live.itemBench.length} 件`, live.itemBench),
      evidence("economy.hp", `当前血量 ${hp ?? "unknown"}`, hp),
      evidence("phase.stage_round", `当前回合 ${stage ?? "unknown"}`, stage),
      evidence("equipment.decision_posture", `候选动作 ${posture}`, posture),
      ...contextEvidence(boardContext, context),
    ],
    [posture, "evaluate_item_slam_or_greed"],
    ["item_slam_or_greed", "win_streak_tempo", ...contextLabels(boardContext)],
  )];
}

function normalizeItemChoiceName(candidate) {
  return String(
    candidate?.name
    || candidate?.item_name
    || candidate?.title
    || candidate?.text
    || candidate?.normalized_text
    || candidate?.catalog_match?.name
    || candidate?.id
    || "",
  ).trim();
}

function scoreItemChoiceOption(candidate, live, context) {
  const name = normalizeItemChoiceName(candidate);
  const targetText = JSON.stringify({
    target_plan: context.targetPlan,
    user_context: context.userContext,
    user_memory: context.userMemory,
    board_units: live.boardUnits,
    bench_units: live.benchUnits,
    item_bench: live.itemBench,
    equipped_items: live.equippedItems,
  }).toLowerCase();
  let score = 0.5;
  const reasons = [];
  if (name && targetText.includes(name.toLowerCase())) {
    score += 0.2;
    reasons.push("matches current target/user/item context");
  }
  if (textHasAny(name, ["无尽", "巨人杀手", "破防", "轻语", "红霸符", "卢安娜", "正义", "ad", "attack"])) {
    score += textHasAny(targetText, ["物理", "霞", "烬", "凯特琳", "金克丝", "ad", "attack"]) ? 0.14 : 0.06;
    reasons.push("physical/carry item candidate");
  }
  if (textHasAny(name, ["帽", "法爆", "纳什", "蓝霸符", "青龙刀", "大天使", "ap", "magic"])) {
    score += textHasAny(targetText, ["法", "阿狸", "卡尔玛", "维迦", "ap", "magic"]) ? 0.14 : 0.05;
    reasons.push("AP/caster item candidate");
  }
  if (textHasAny(name, ["狂徒", "石像鬼", "救赎", "棘刺", "龙牙", "冕卫", "挑战护手", "tank", "frontline"])) {
    score += live.boardUnits.length ? 0.08 : 0.04;
    reasons.push("frontline/survival item candidate");
  }
  if (textHasAny(name, ["红霸符", "鬼书", "日炎"])) {
    score += 0.04;
    reasons.push("anti-heal value is broadly useful");
  }
  const confidence = choiceConfidence(candidate);
  return {
    ...candidate,
    name,
    score: Number(clampScore(score).toFixed(2)),
    confidence,
    reasons,
  };
}

function scoreItemChoice(live, context) {
  const rows = asArray(live.itemChoiceOptions).filter((candidate) => normalizeItemChoiceName(candidate));
  if (!rows.length) return [];
  const uniqueRows = rows.filter((candidate, index, all) =>
    all.findIndex((row) => normalizeItemChoiceName(row) === normalizeItemChoiceName(candidate)) === index).slice(0, 5);
  if (!uniqueRows.length) return [];
  const firstKind = String(uniqueRows.find((row) => row?.item_choice_kind)?.item_choice_kind || "");
  const firstLabel = String(uniqueRows.find((row) => row?.item_choice_label)?.item_choice_label || "").trim();
  const itemChoiceLabel = firstLabel || ({
    basic_component_forge: "基础装备锻造器",
    completed_item_forge: "装备锻造器",
    artifact_forge: "神器锻造器",
    radiant_item_choice: "光明装备选择",
  }[firstKind] || "装备选择");
  const ranked = uniqueRows
    .map((candidate) => scoreItemChoiceOption(candidate, live, context))
    .sort((left, right) => right.score - left.score);
  const names = ranked.map((candidate) => candidate.name);
  const best = ranked[0];
  const avgConfidence = uniqueRows.reduce((sum, candidate) => sum + choiceConfidence(candidate), 0) / uniqueRows.length;
  const missing = [];
  if (live.economy.hp === null) missing.push("hp");
  if (!live.boardUnits.length && !live.benchUnits.length) missing.push("board_or_bench");
  return [makeTask(
    "item_choice_advice",
    0.9,
    Math.min(0.92, Math.max(0.72, avgConfidence)),
    "Item forge choice",
    `${itemChoiceLabel}候选：${names.join(" / ")}。当前结构化证据优先看 ${best.name}，最终解释交给 host model 结合阵容/装备位判断。${missing.length ? ` Missing context: ${missing.join(", ")}.` : ""}`,
    [
      evidence("items.choice_options", `Visible ${itemChoiceLabel} options: ${names.join(" / ")}`, ranked),
      evidence("items.item_bench", `Item bench count: ${live.itemBench.length}`, live.itemBench),
      evidence("items.equipped_items", `Equipped item count: ${live.equippedItems.length}`, live.equippedItems),
      evidence("board.board_units", `Current board has ${live.boardUnits.length} units`, live.boardUnits.map((unit) => unit.name)),
      ...(context.targetPlan ? [evidence("target_plan", "Current target plan participates in item choice scoring", context.targetPlan)] : []),
    ],
    [
      `choose_item:${best.name}`,
      ...(missing.length ? missing.map((field) => `visual_sensing_probe:${field}`) : []),
    ],
    ["item_choice", "item_forge", "equipment_choice", ...missing.map((field) => `missing_${field}`)],
  )];
}

function scoreDirection(live, context) {
  if (!context.targetPlan) return [];
  const ownedContext = contextScoreBonus([...live.boardUnits, ...live.benchUnits], context);
  const lineupSignal = topLineupSignal(context);
  const targetTotal = Math.max(1, context.targetIds.size + context.targetNames.size);
  const coverage = Math.min(1, ownedContext.hits.length / targetTotal);
  const rankScore = numberOrNull(lineupSignal?.signal_score) || 0;
  const valueScore = Math.min(0.95, 0.58 + coverage * 0.16 + Math.min(0.12, rankScore * 0.08));
  if (valueScore < 0.7) return [];
  const action = coverage >= 0.45 ? "可以继续围绕当前目标推进" : "先保留目标，但不要过早锁死";
  return [makeTask(
    "direction_commit_or_exit",
    valueScore,
    Math.min(0.86, 0.58 + coverage * 0.18 + (rankScore ? 0.08 : 0)),
    "阵容方向判断",
    `${context.targetPlan.name || context.targetPlan.id || "当前目标阵容"} 当前覆盖 ${(coverage * 100).toFixed(0)}%，${action}。`,
    [
      evidence("target_plan.coverage", `目标阵容覆盖 ${(coverage * 100).toFixed(0)}%`, { coverage, hits: ownedContext.hits }),
      ...(lineupSignal ? [evidence("live_rankings.lineup_signal", "当前对局捕获的掌盟大师以上阵容先验", lineupSignal)] : []),
      ...contextEvidence(ownedContext, context),
    ],
    ["evaluate_commit_or_pivot"],
    ["pivot", "capped_board", "target_plan_alignment", "live_rankings_prior"],
  )];
}

function scoreCapGap(live, context) {
  if (!context.targetPlan) return [];
  const ownedContext = contextScoreBonus([...live.boardUnits, ...live.benchUnits], context);
  const targetTotal = Math.max(1, context.targetIds.size + context.targetNames.size);
  const coverage = Math.min(1, ownedContext.hits.length / targetTotal);
  const lineupSignal = topLineupSignal(context);
  const estimate = estimateCombatCap(live, context, coverage, lineupSignal);
  const capGap = Math.max(0, estimate.survival_pressure_score - estimate.cap_power_score);
  const boardGap = Math.max(0, estimate.expected_damage_risk - estimate.board_power_score);
  const rankScore = numberOrNull(lineupSignal?.signal_score) || 0;
  const major = stageMajor(live.phase.stageRound);
  const shouldSpeak = major >= 5 || capGap >= 0.22 || boardGap >= 0.22 || (coverage < 0.45 && rankScore >= 0.9);
  if (!shouldSpeak) return [];
  const valueScore = Math.min(0.96, 0.62 + capGap * 0.3 + boardGap * 0.22 + (rankScore >= 1 ? 0.06 : 0));
  return [makeTask(
    "cap_gap_check",
    valueScore,
    0.68,
    "阵容上限缺口",
    `${context.targetPlan.name || context.targetPlan.target_name || "current plan"} fast cap estimate is tight: cap ${(estimate.cap_power_score * 100).toFixed(0)}, survival pressure ${(estimate.survival_pressure_score * 100).toFixed(0)}. Decide how to stabilize, improve quality, level, or replace units inside the confirmed target.`,
    [
      evidence("combat_cap_estimator.fast_estimate", "轻量战力/上限估算，不是完整战斗模拟", estimate),
      evidence("target_plan.coverage", `目标阵容覆盖 ${(coverage * 100).toFixed(0)}%`, { coverage, hits: ownedContext.hits }),
      ...(lineupSignal ? [evidence("live_rankings.lineup_signal", "当前对局捕获的掌盟大师以上阵容先验", lineupSignal)] : []),
      ...contextEvidence(ownedContext, context),
    ],
    ["evaluate_cap_gap_within_confirmed_target"],
    ["cap_gap_check", "capped_board", "target_plan_alignment", "live_rankings_prior", ...contextLabels(ownedContext)],
  )];
}

function augmentName(candidate) {
  return String(candidate?.name || candidate?.augment_name || candidate?.text || candidate?.normalized_text || candidate?.id || "").trim();
}

function augmentConfidence(candidate) {
  return numberOrNull(candidate?.confidence ?? candidate?.provenance?.confidence) ?? 0.72;
}

function scoreAugmentChoice(live, context) {
  const candidates = live.augmentChoiceCandidates
    .map((candidate, index) => ({
      ...candidate,
      slot: Number.isFinite(Number(candidate?.slot)) ? Number(candidate.slot) : index,
      name: augmentName(candidate),
      confidence: augmentConfidence(candidate),
    }))
    .filter((candidate) => candidate.name);
  if (candidates.length < 2) return [];
  const uniqueNames = [...new Set(candidates.map((candidate) => candidate.name))].slice(0, 4);
  if (uniqueNames.length < 2) return [];
  const avgConfidence = candidates.reduce((sum, candidate) => sum + candidate.confidence, 0) / candidates.length;
  const valueScore = Math.min(0.98, 0.86 + Math.min(0.08, uniqueNames.length * 0.02));
  const contextBits = [];
  if (context.targetPlan?.name || context.targetPlan?.id) contextBits.push(`目标：${context.targetPlan.name || context.targetPlan.id}`);
  if (live.boardUnits.length) contextBits.push(`场上 ${live.boardUnits.length} 个单位`);
  if (live.itemBench.length || live.equippedItems.length) contextBits.push(`装备候选 ${live.itemBench.length + live.equippedItems.length} 个`);
  const contextText = contextBits.length ? `先结合${contextBits.join("、")}判断；` : "";
  return [makeTask(
    "augment_choice_advice",
    valueScore,
    Math.min(0.94, Math.max(0.76, avgConfidence)),
    "海克斯选择",
    `识别到海克斯候选：${uniqueNames.join(" / ")}。${contextText}先比较是否贴当前阵容、是否能保血/定方向，再决定选哪个或刷新哪个。`,
    [
      evidence("augments.choice_candidates", `海克斯候选 ${uniqueNames.length} 个`, candidates.slice(0, 6)),
      evidence("board.board_units", `当前场上 ${live.boardUnits.length} 个单位`, live.boardUnits.map((unit) => unit.name)),
      evidence("items", `装备候选 ${live.itemBench.length + live.equippedItems.length} 个`, {
        item_bench: live.itemBench,
        equipped_items: live.equippedItems,
      }),
      ...(context.targetPlan ? [evidence("target_plan", "当前目标阵容/计划会参与取舍", context.targetPlan)] : []),
    ],
    ["analyze_augment_choice_or_reroll"],
    ["augment_choice", "direction_commit_or_exit", "item_slam_or_greed"],
  )];
}

function augmentObservedAt(candidate) {
  return candidate?.observed_at || candidate?.at || candidate?.captured_at || candidate?.provenance?.observed_at || null;
}

function latestAugmentCandidates(candidates) {
  const normalized = asArray(candidates).filter(Boolean);
  const timed = normalized
    .map((candidate, index) => ({ candidate, index, time: Date.parse(augmentObservedAt(candidate) || "") }))
    .filter((entry) => Number.isFinite(entry.time));
  if (!timed.length) return normalized;
  const latest = Math.max(...timed.map((entry) => entry.time));
  return timed
    .filter((entry) => entry.time === latest)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.candidate);
}

function currentAugmentCandidates(live) {
  const current = userReportedChoicesFrom(live.augmentCurrentChoiceSet);
  if (current.length) return current;
  return latestAugmentCandidates(live.augmentChoiceCandidates);
}

function augmentChoiceHistory(live) {
  const history = live.augmentChoiceSetHistory.length
    ? live.augmentChoiceSetHistory
    : [
      ...live.augmentPreviousChoiceSets,
      ...(live.augmentCurrentChoiceSet ? [live.augmentCurrentChoiceSet] : []),
    ];
  return history
    .map((set) => ({ ...set, choices: userReportedChoicesFrom(set) }))
    .filter((set) => set.choices.length);
}

function textHasAny(value, needles) {
  const text = JSON.stringify(value || "").toLowerCase();
  return needles.some((needle) => text.includes(String(needle).toLowerCase()));
}

function clampScore(value, min = 0.02, max = 0.98) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeAugmentNameKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[!！]/g, "")
    .replace(/[＋]/g, "+")
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/(iii|ii|iv|i)$/u, (tier) => ({ i: "1", ii: "2", iii: "3", iv: "4" })[tier]);
}

function buildAugmentContextText(live, context) {
  return JSON.stringify({
    target_plan: context.targetPlan || {},
    user_context: context.userContext || {},
    user_memory: context.userMemory || {},
    runtime_user_settings: context.runtimeUserSettings || {},
    live_strategy: live.strategy || {},
  });
}

function augmentContextPolicy(context) {
  const cruiseConstraints = asArray(context.userContext?.cruise_context_constraints);
  const allConstraints = asArray(context.userContext?.constraints);
  const activeUserMessage = context.userContext?.active_user_message || null;
  return {
    primary_context: cruiseConstraints.length ? "cruise_accumulated_context" : "live_state_and_target_plan",
    active_task_message_is_overlay: Boolean(activeUserMessage),
    cruise_constraint_count: cruiseConstraints.length,
    total_constraint_count: allConstraints.length,
    active_mode: context.userContext?.active_mode || null,
    latest_cruise_constraint: cruiseConstraints.at(-1)?.message || null,
    active_user_message: activeUserMessage,
  };
}

function augmentSemanticProfile(candidate, context = {}) {
  const index = context.hardData?.augment_semantic_profiles || {};
  const byId = index.by_id || {};
  const byName = index.by_name || {};
  const ref = candidate?.ref;
  const address = ref?.address ?? candidate?.address;
  const parsedAddress = address == null ? null : String(address).match(/^jcc:([^:]+):augment:([^:]+)$/u);
  if (address != null && !parsedAddress) return null;
  if (ref?.kind != null && ref.kind !== "augment") return null;
  const seasons = [ref?.season_id, parsedAddress?.[1]].filter((value) => value != null).map(String);
  if (new Set(seasons).size > 1) return null;
  if (seasons.length && (!index.season_id || seasons.some((season) => season !== index.season_id))) return null;
  const ids = [ref?.id, parsedAddress?.[2], candidate?.catalog_match?.id, candidate?.id, candidate?.augment_id]
    .filter((value) => value != null).map(String);
  if (ids.length) {
    if (new Set(ids).size !== 1) return null;
    return Object.hasOwn(byId, ids[0]) ? byId[ids[0]] : null;
  }
  // A missing ref can use only a unique alias within this pinned profile index.
  // Never let the by_name map's last-write-wins hide an ambiguous canonical name.
  const names = new Set([candidate?.catalog_match?.name, candidate?.name, candidate?.normalized_text, candidate?.text]
    .map(normalizeAugmentNameKey).filter(Boolean));
  const matches = new Map();
  for (const [id, profile] of Object.entries(byId)) {
    if (names.has(normalizeAugmentNameKey(profile?.name))) matches.set(id, profile);
  }
  for (const [name, profile] of Object.entries(byName)) {
    const id = String(profile?.augment_id || "");
    if (names.has(normalizeAugmentNameKey(name)) && Object.hasOwn(byId, id)) matches.set(id, byId[id]);
  }
  return matches.size === 1 ? matches.values().next().value : null;
}

function augmentLineupEvidence(candidate, context = {}) {
  const typedEvidence = context.augmentChoiceEvidence || {};
  const profile = augmentSemanticProfile(candidate, context);
  const ids = profile ? [String(profile.augment_id)] : [];
  const names = profile ? [normalizeAugmentNameKey(profile.name)] : [];
  const find = (map) => {
    for (const id of ids) if (map?.[id] !== undefined) return map[id];
    const matches = Object.entries(map || {}).filter(([name]) => names.includes(normalizeAugmentNameKey(name)));
    if (matches.length === 1) return matches[0][1];
    return null;
  };
  const lineupFit = find(typedEvidence.lineup_fit_by_augment_id)
    ?? find(typedEvidence.lineup_fit_by_augment_name)
    ?? null;
  const candidateCoverage = find(typedEvidence.candidate_coverage_by_augment_id)
    ?? find(typedEvidence.candidate_coverage_by_augment_name)
    ?? null;
  return {
    lineup_fit: Number.isFinite(Number(lineupFit)) ? Number(lineupFit) : null,
    candidate_coverage: Number.isFinite(Number(candidateCoverage)) ? Number(candidateCoverage) : null,
    source: lineupFit !== null || candidateCoverage !== null ? "typed_lineup_augment_compatibility" : "core_profile_only",
    policy: {
      raw_compatibility_only: true,
      must_not_include_lineup_augment_fit_baseline: true,
      duplicate_associations_deduplicated_upstream: true,
    },
  };
}

function augmentEvaluationMatch(live, context) {
  return {
    stage_round: live.phase.stageRound,
    hp: live.economy.hp,
    gold: live.economy.gold,
    level: live.economy.level,
    board_power_score: Number.isFinite(Number(context.combatCapEstimator?.board_power_score))
      ? Number(context.combatCapEstimator.board_power_score)
      : null,
    selected_augment_count: asArray(live.selectedAugments).length,
    item_state: { bench: live.itemBench, equipped: live.equippedItems },
    owned_units: [...live.boardUnits, ...live.benchUnits],
    candidate_lineup_context: context.targetPlan || null,
  };
}

function augmentEvaluationDecision(candidate, context) {
  const compatibility = augmentLineupEvidence(candidate, context);
  return {
    goal: context.runtimeUserSettings?.default_goal || "balanced",
    target_context_authority: context.targetContextAuthority,
    lineup_fit: compatibility.lineup_fit,
    candidate_coverage: compatibility.candidate_coverage,
    compatibility_evidence: compatibility,
  };
}

function scoreAugmentCandidate(candidate, live, context) {
  const name = typeof candidate === "string" ? candidate : candidate.name;
  const profile = augmentSemanticProfile(candidate, context);
  const evaluation = evaluateAugmentChoiceCandidate({
    candidate: { ...candidate, name, id: profile?.augment_id || null },
    profile,
    match: augmentEvaluationMatch(live, context),
    decision: augmentEvaluationDecision(candidate, context),
  });
  const reasons = [];
  if (evaluation.resolution_status !== "resolved_active_core_profile") {
    reasons.push("candidate is absent from the Match-pinned active Core augment profile");
  } else {
    reasons.push(...Object.entries(evaluation.axis_scores || {})
      .filter(([, value]) => Number.isFinite(Number(value)))
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, 4)
      .map(([axis, value]) => `${axis}=${Number(value).toFixed(2)}`));
    if (evaluation.missing_fields.length) reasons.push(`missing:${evaluation.missing_fields.join(",")}`);
  }
  return {
    name,
    slot: Number.isFinite(Number(candidate?.slot)) ? Number(candidate.slot) : null,
    id: profile?.augment_id || null,
    category: profile?.category_ids?.[0] || "unresolved",
    category_source: evaluation.category_source,
    score: Number(evaluation.recommendation_score.toFixed(4)),
    reasons,
    objective_scores: evaluation.objective_scores,
    axis_scores: evaluation.axis_scores,
    target_context_authority: evaluation.target_context_authority || context.targetContextAuthority,
    goal: evaluation.goal || context.runtimeUserSettings?.default_goal || "balanced",
    confidence: evaluation.confidence,
    missing_fields: evaluation.missing_fields,
    resolution_status: evaluation.resolution_status,
    evaluator_policy: evaluation.policy || null,
  };
}

function chooseAugmentAction(ranked, live) {
  const best = ranked[0];
  const second = ranked[1];
  const history = augmentChoiceHistory(live);
  const previousSets = live.augmentPreviousChoiceSets.length || Math.max(0, history.length - 1);
  const rerollPolicy = live.augmentRerollPolicy || {};
  const maxVisibleSets = rerollPolicy.special_double_reroll_visible_options === 9 ? 3 : 2;
  const currentVisibleSetNumber = previousSets + 1;
  const canSeeMore = currentVisibleSetNumber < maxVisibleSets;
  const remainingVisibleSets = Math.max(0, maxVisibleSets - currentVisibleSetNumber);
  const missing = [];
  if (live.economy.gold === null) missing.push("gold");
  if (live.economy.hp === null) missing.push("hp");
  if (!live.itemBench.length && !live.equippedItems.length) missing.push("items");
  if (!best) {
    return {
      action: "choice_candidate_report_required",
      text: "请先报告当前三个强化候选；选择建议不会等待 OCR 或视觉候选。",
      missing: [...new Set([...missing, "augment_candidates"])],
    };
  }
  for (const field of asArray(best.missing_fields)) if (!missing.includes(field)) missing.push(field);
  const gap = best.score - (second?.score ?? 0);
  const missingCriticalForBest = missing.length >= 3 || best.resolution_status !== "resolved_active_core_profile";
  const canLockExceptional = best.score >= 0.76 && gap >= 0.14 && !missingCriticalForBest;

  if (canSeeMore && !canLockExceptional) {
    if (best.score < 0.42 || gap < 0.035) {
      return {
        action: "full_reroll_current_set",
        text: `这组三张都不够贴，建议全刷搏更高上限`,
        keep: null,
        reroll: ranked,
        policy: "full_reroll_when_current_set_is_weak_or_flat",
        missing,
        can_see_more: canSeeMore,
        current_visible_set_number: currentVisibleSetNumber,
        max_visible_sets: maxVisibleSets,
        remaining_visible_sets: remainingVisibleSets,
      };
    }
    const keep = best;
    const reroll = ranked.slice(1).sort((left, right) => left.score - right.score);
    return {
      action: `reroll_or_hold_backup:${best.name}`,
      text: `保留 ${keep.name} 作为保底，优先刷新 ${reroll.map((entry) => entry.name).join(" / ")}`,
      keep,
      reroll,
      policy: "hold_backup_reroll_weaker_slots",
      missing,
      can_see_more: canSeeMore,
      current_visible_set_number: currentVisibleSetNumber,
      max_visible_sets: maxVisibleSets,
      remaining_visible_sets: remainingVisibleSets,
    };
  }

  if (!canSeeMore && (gap >= 0.08 || best.score >= 0.62)) {
    return {
      action: `choose_augment:${best.name}`,
      text: `直接选 ${best.name}`,
      keep: best,
      reroll: [],
      policy: "choose_now",
      missing,
      can_see_more: canSeeMore,
      current_visible_set_number: currentVisibleSetNumber,
      max_visible_sets: maxVisibleSets,
      remaining_visible_sets: remainingVisibleSets,
    };
  }

  if (canLockExceptional) {
    return {
      action: `choose_augment:${best.name}`,
      text: `当前 ${best.name} 已经明显强于其他选项，可以直接选；如果你想搏更高上限，也可以保它再小刷弱项`,
      keep: best,
      reroll: [],
      policy: "choose_exceptional_or_hold_as_backup",
      missing,
      can_see_more: canSeeMore,
      current_visible_set_number: currentVisibleSetNumber,
      max_visible_sets: maxVisibleSets,
      remaining_visible_sets: remainingVisibleSets,
    };
  }

  return {
    action: `prefer_augment:${best.name}`,
    text: `优先选 ${best.name}，刷新机会可能接近用完，不要轻易放掉当前最好项`,
    keep: best,
    reroll: [],
    policy: "prefer_best_after_reroll_budget",
    missing,
    can_see_more: canSeeMore,
    current_visible_set_number: currentVisibleSetNumber,
    max_visible_sets: maxVisibleSets,
    remaining_visible_sets: remainingVisibleSets,
  };
}

function scoreAugmentChoiceV2(live, context) {
  const candidates = currentAugmentCandidates(live)
    .map((candidate, index) => ({
      ...candidate,
      slot: Number.isFinite(Number(candidate?.slot)) ? Number(candidate.slot) : index,
      name: augmentName(candidate),
      confidence: augmentConfidence(candidate),
    }))
    .filter((candidate) => candidate.name);
  if (candidates.length !== 3) return [];
  const uniqueCandidates = candidates.filter((candidate, index, rows) =>
    rows.findIndex((row) => row.name === candidate.name) === index).slice(0, 4);
  const uniqueNames = uniqueCandidates.map((candidate) => candidate.name);
  if (uniqueNames.length !== 3) return [];
  const avgConfidence = candidates.reduce((sum, candidate) => sum + candidate.confidence, 0) / candidates.length;
  const ranked = uniqueCandidates
    .map((candidate) => scoreAugmentCandidate(candidate, live, context))
    .sort((left, right) => right.score - left.score || (left.slot ?? 99) - (right.slot ?? 99) || String(left.id || left.name).localeCompare(String(right.id || right.name)));
  const decision = chooseAugmentAction(ranked, live);
  const history = augmentChoiceHistory(live);
  const priorNames = history
    .slice(0, -1)
    .flatMap((set) => asArray(set.choices).map(augmentName).filter(Boolean));
  const alternatives = ranked.slice(1, 4).map((entry) => `${entry.name}(${entry.category})`).join(" / ");
  const contextBits = [];
  if (context.targetPlan?.name || context.targetPlan?.id) contextBits.push(`target ${context.targetPlan.name || context.targetPlan.id}`);
  const contextPolicy = augmentContextPolicy(context);
  if (contextPolicy.cruise_constraint_count) contextBits.push(`cruise_context ${contextPolicy.cruise_constraint_count}`);
  if (contextPolicy.active_task_message_is_overlay) contextBits.push("active_task_message");
  if (live.selectedAugments.length) contextBits.push(`selected ${live.selectedAugments.map(augmentName).filter(Boolean).join("/")}`);
  if (live.boardUnits.length) contextBits.push(`board ${live.boardUnits.length}`);
  if (live.itemBench.length || live.equippedItems.length) contextBits.push(`items ${live.itemBench.length + live.equippedItems.length}`);
  const missingText = decision.missing.length ? ` Missing: ${decision.missing.join(", ")}; refresh visual self-state before committing if this changes the call.` : "";
  return [makeTask(
    "augment_choice_advice",
    Math.min(0.98, 0.86 + Math.min(0.08, uniqueNames.length * 0.02)),
    Math.min(0.94, Math.max(0.76, avgConfidence)),
    "Augment choice",
    `${decision.text}. Current options: ${uniqueNames.join(" / ")}.${alternatives ? ` Other candidates: ${alternatives}.` : ""}${contextBits.length ? ` Context: ${contextBits.join(", ")}.` : ""}${missingText}`,
    [
      evidence("augments.choice_candidates", `Current augment candidates: ${uniqueNames.join(" / ")}`, candidates.slice(0, 6)),
      evidence("augments.choice_history", `Previous augment choice sets are fallback evidence only: ${priorNames.length} previous names`, {
        current_choice_set: live.augmentCurrentChoiceSet || null,
        previous_choice_sets: live.augmentPreviousChoiceSets,
        reroll_policy: live.augmentRerollPolicy,
        previous_names: [...new Set(priorNames)].slice(0, 9),
      }),
      evidence("augments.ranked_recommendation", `Ranked augment call: ${ranked[0]?.name || "unknown"}`, {
        recommended_action: decision.action,
        recommendation_policy: decision.policy || null,
        keep: decision.keep || null,
        reroll: decision.reroll || [],
        can_see_more: decision.can_see_more,
        current_visible_set_number: decision.current_visible_set_number,
        max_visible_sets: decision.max_visible_sets,
        remaining_visible_sets: decision.remaining_visible_sets,
        missing_fields: decision.missing,
        context_policy: contextPolicy,
        ranked,
      }),
      evidence("augment.context_policy", "Cruise context is the primary strategic context; active augment-mode chat is a temporary overlay", contextPolicy),
      evidence("board.board_units", `Current board has ${live.boardUnits.length} units`, live.boardUnits.map((unit) => unit.name)),
      evidence("items", `Item candidates/equipped count: ${live.itemBench.length + live.equippedItems.length}`, {
        item_bench: live.itemBench,
        equipped_items: live.equippedItems,
      }),
      ...(live.selectedAugments.length ? [evidence("augments.selected_history", "Selected augment history participates in this call", live.selectedAugments)] : []),
      ...(context.targetPlan ? [evidence("target_plan", "Current target plan participates in augment scoring", context.targetPlan)] : []),
    ],
    [
      decision.action,
      ...(decision.keep ? [`prefer_augment:${decision.keep.name}`] : []),
      ...(decision.keep ? [`keep_augment_slot:${decision.keep.slot ?? "unknown"}:${decision.keep.name}`] : []),
      ...(decision.action === "full_reroll_current_set" ? ["reroll_all_augment_slots"] : []),
      ...asArray(decision.reroll).map((entry) => `reroll_augment_slot:${entry.slot ?? "unknown"}:${entry.name}`),
      ...(decision.missing.length ? decision.missing.map((field) => `visual_sensing_probe:${field}`) : []),
    ],
    ["augment_choice", "direction_commit_or_exit", "item_slam_or_greed", ...decision.missing.map((field) => `missing_${field}`)],
  )];
}

function choiceName(candidate) {
  return String(
    candidate?.name
    || candidate?.god_name
    || candidate?.reward_title
    || candidate?.title
    || candidate?.text
    || candidate?.normalized_text
    || candidate?.catalog_match?.name
    || candidate?.id
    || "",
  ).trim();
}

function choiceConfidence(candidate) {
  return numberOrNull(candidate?.confidence ?? candidate?.catalog_match?.confidence ?? candidate?.provenance?.confidence) ?? 0.72;
}

function scoreActiveSeasonChoiceOption(candidate, live, context) {
  const name = choiceName(candidate);
  const candidateText = JSON.stringify(candidate || {}).toLowerCase();
  const targetText = JSON.stringify({
    target_plan: context.targetPlan,
    user_context: context.userContext,
    user_memory: context.userMemory,
    match_variables: live.matchVariables,
    selected_augments: live.selectedAugments,
  }).toLowerCase();
  let score = 0.5;
  const reasons = [];
  if (name && targetText.includes(name.toLowerCase())) {
    score += 0.16;
    reasons.push("explicitly mentioned by current target/user context");
  }
  if (textHasAny(candidateText, ["金币", "经济", "利息", "宝箱", "gold", "econ", "chest"])) {
    score += live.economy.hp !== null && live.economy.hp >= 65 ? 0.08 : 0.02;
    reasons.push("economy reward depends on HP/tempo room");
  }
  if (textHasAny(candidateText, ["装备", "基础装备", "锻造器", "神器", "item", "anvil", "artifact"])) {
    score += live.itemBench.length || live.equippedItems.length ? 0.08 : 0.05;
    reasons.push("item reward should be matched to current components/holders");
  }
  if (textHasAny(candidateText, ["战力", "伤害", "护盾", "治疗", "combat", "shield", "heal"])) {
    score += live.economy.hp !== null && live.economy.hp <= 65 ? 0.1 : 0.05;
    reasons.push("combat/sustain reward is better when HP or tempo pressure exists");
  }
  return {
    ...candidate,
    name,
    score: Number(clampScore(score).toFixed(2)),
    reasons,
  };
}

function scoreActiveSeasonChoices(live, context) {
  return context.activeChoiceModeContracts
    .filter((contract) => !["augment_choice", "item_choice"].includes(contract.mode))
    .flatMap((contract) => {
      const rows = asArray(live.activeSeasonChoiceOptionsByMode?.[contract.mode])
        .filter((candidate) => choiceName(candidate));
      const uniqueRows = rows.filter((candidate, index, all) =>
        all.findIndex((row) => choiceName(row) === choiceName(candidate)) === index).slice(0, 6);
      if (uniqueRows.length < 2) return [];
      const ranked = uniqueRows
        .map((candidate) => scoreActiveSeasonChoiceOption(candidate, live, context))
        .sort((left, right) => right.score - left.score);
      const names = ranked.map((candidate) => candidate.name);
      const best = ranked[0];
      const avgConfidence = uniqueRows.reduce((sum, candidate) => sum + choiceConfidence(candidate), 0) / uniqueRows.length;
      const missing = [];
      if (live.economy.gold === null) missing.push("gold");
      if (live.economy.hp === null) missing.push("hp");
      if (!live.itemBench.length && !live.equippedItems.length) missing.push("items");
      const triggerId = asArray(contract.advice_task_trigger_terms)
        .map((term) => String(term || "").trim())
        .find(Boolean);
      if (!triggerId) return [];
      const promptHint = String(contract.visible_window_required_answer || "Rank the current visible options and choose one.").trim();
      return [makeTask(
        triggerId,
        0.91,
        Math.min(0.92, Math.max(0.74, avgConfidence)),
        contract.label || contract.kind || contract.mode,
        `${promptHint} Options: ${names.join(" / ")}. Deterministic evidence leader: ${best.name}.${missing.length ? ` Missing context: ${missing.join(", ")}.` : ""}`,
        [
          evidence(contract.candidate_paths?.[0] || `reported_choice_sets_by_mode.${contract.mode}`, `Current-match ${contract.label || contract.kind} options: ${names.join(" / ")}`, ranked),
          evidence("board.board_units", `Current board has ${live.boardUnits.length} units`, live.boardUnits.map((unit) => unit.name)),
          evidence("items", `Item inventory/equipped count: ${live.itemBench.length + live.equippedItems.length}`, {
            item_bench: live.itemBench,
            equipped_items: live.equippedItems,
          }),
          evidence("match_variables", "Confirmed current-match variables participate in this season choice", live.matchVariables || {}),
          ...(context.targetPlan ? [evidence("target_plan", "Current target plan participates in active-season choice scoring", context.targetPlan)] : []),
        ],
        [
          `choose:${contract.mode}:${best.name}`,
          ...missing.map((field) => `missing_context:${field}`),
        ],
        [contract.kind, contract.mode, "active_season_choice", ...missing.map((field) => `missing_${field}`)],
      )];
    });
}

function scoreSpecialContextOcrProbe(live, context) {
  const planAndUserText = JSON.stringify({
    target_plan: context.targetPlan,
    user_context: context.userContext,
    strategy: live.strategy,
  });
  const variables = live.matchVariables || {};
  if (!textHasAny(planAndUserText, ["法官", "judge"]) || variables.judge_effect || variables.judge_effect_text) return [];
  return [makeTask(
    "special_context_visual_probe",
    0.82,
    0.7,
    "Need Judge effect text",
    "Target/context references Judge, but the current match has no confirmed Judge effect text. Trigger host multimodal visual sensing on the visible trait/effect panel before hard-forcing or pivoting.",
    [
      evidence("target_plan", "Target plan/user context references Judge", context.targetPlan || context.userContext),
      evidence("match_variables.judge_effect", "Judge effect is missing from match variables", null),
    ],
    ["visual_sensing_probe:trait_effect:judge", "update_match_variable:judge_effect"],
    ["special_context_visual_probe", "direction_commit_or_exit", "pivot"],
  )];
}

function proactiveAdviceSuppressionReason(live) {
  const status = numberOrNull(live.phase.status);
  if (status === 2) return "non_self_current_view";
  if (live.economy.hp === 0 && live.phase.eliminationConfirmed) return "match_eliminated";
  return null;
}

function scoreLiveState(rawLive, context = {}) {
  const live = collectLiveState(rawLive, context);
  const strategyContext = normalizeContext(context);
  if (!strategyContext.lineupLifecycle) {
    strategyContext.lineupLifecycle = buildLineupLifecycleContext({
      liveState: rawLive,
      context,
    });
  }
  const threshold = numberOrNull(context.minimum_value_score_to_speak) || DEFAULT_THRESHOLD;
  const proactiveSuppressionReason = proactiveAdviceSuppressionReason(live);
  const candidates = proactiveSuppressionReason ? [] : [
    ...scoreInterest(live, strategyContext),
    ...scoreShopHoldSell(live, strategyContext),
    ...scoreShopWithoutEconomy(live, strategyContext),
    ...scoreKeyUnitProgression(live, strategyContext),
    ...scoreEarlyDirectionConversation(live, strategyContext),
    ...scoreLineupConvergenceCheckpoint(live, strategyContext),
    ...scoreLateLineupConvergenceCheckpoint(live, strategyContext),
    ...scoreStreakGuard(live, strategyContext),
    ...scoreBenchSpace(live, strategyContext),
    ...scoreLevelOrRoll(live, strategyContext),
    ...scoreTempo(live, strategyContext),
    ...scoreShopLock(live, strategyContext),
    ...scoreItems(live, strategyContext),
    ...scoreItemChoice(live, strategyContext),
    ...scoreDirection(live, strategyContext),
    ...scoreCapGap(live, strategyContext),
    ...scoreAugmentChoiceV2(live, strategyContext),
    ...scoreActiveSeasonChoices(live, strategyContext),
    ...scoreSpecialContextOcrProbe(live, strategyContext),
  ].map((task) => normalizeCruiseTaskForCurrentStage(task, live))
    .map((task) => applyUserSettingsToTask(task, strategyContext))
    .map((task) => attachLifecycleConditionalDecision(task, strategyContext))
    .sort((left, right) => right.value_score - left.value_score);

  const { adviceTasks, suppressedTasks } = applyInterruptPolicy(candidates, strategyContext, threshold);

  return {
    schema: "jcc-cruise-strategy-score-v1",
    match_session_id: live.matchSessionId,
    generated_at: new Date().toISOString(),
    minimum_value_score_to_speak: threshold,
    advice_tasks: adviceTasks,
    suppressed_tasks: suppressedTasks,
    live_state_summary: {
      stage_round: live.phase.stageRound,
      gold: live.economy.gold,
      hp: live.economy.hp,
      level: live.economy.level,
      phase_status: live.phase.status,
      proactive_suppression_reason: proactiveSuppressionReason,
      board_units: live.boardUnits.length,
      bench_units: live.benchUnits.length,
      shop_units: live.shopUnits.length,
      item_bench: live.itemBench.length,
      item_choice_options: live.itemChoiceOptions.length,
      augment_choice_candidates: live.augmentChoiceCandidates.length,
      active_season_choice_options_by_mode: Object.fromEntries(
        Object.entries(live.activeSeasonChoiceOptionsByMode || {}).map(([mode, rows]) => [mode, asArray(rows).length]),
      ),
      target_plan: strategyContext.targetPlan?.name || strategyContext.targetPlan?.id || null,
      lineup_lifecycle_archetype: strategyContext.lineupLifecycle?.archetype || null,
      board_readiness: strategyContext.lineupLifecycle?.board_readiness || null,
      live_rankings_unit_signals: strategyContext.heroSignals.size,
      runtime_user_settings: {
        rank_tier: strategyContext.runtimeUserSettings?.rank_tier || null,
        operation_speed: strategyContext.runtimeUserSettings?.operation_speed || null,
        default_goal: strategyContext.runtimeUserSettings?.default_goal || null,
      },
      user_memory_entries: asArray(strategyContext.userMemory?.preferences).length
        + asArray(strategyContext.userMemory?.habits).length
        + asArray(strategyContext.userMemory?.review_notes).length,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.liveState) throw new Error("--live-state is required");
  const liveState = await readJson(options.liveState);
  const context = options.context ? await readJson(options.context) : {};
  const result = scoreLiveState(liveState, context);
  if (!options.includeSuppressed) result.suppressed_tasks = [];
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) await writeFile(options.out, json, "utf8");
  else process.stdout.write(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export {
  applyUserSettingsToTask,
  collectLiveState,
  normalizeContext,
  scoreLiveState,
  lineupSignalsForDecision,
};
