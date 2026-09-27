#!/usr/bin/env node
import strictAssert from "node:assert/strict";
import {
  buildDirectUserAbsorbedCruiseObligation,
  buildProactiveCoachContentAgenda,
  buildRuntimeProactiveDecisionSignal,
  detectRuntimeSemanticEvents,
  getRuntimeServiceState,
  markAbsorbedCruiseObligationAnsweredByTask,
  rememberRetryableRuntimeEventAdvice,
  readLiveRankingsSummarySync,
  retryableRuntimeEventAdviceEvents,
  setRuntimeServiceEventWriter,
  setRuntimeServiceState,
  shouldStartAdviceForRuntimeEvent,
} from "../ui/electron/runtime-service.js";
import { scoreLiveState } from "./score-jcc-cruise-strategy.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertFactOnlyGate(gate, label) {
  assert(gate?.ok === false, `${label} must remain outside the Host lane`);
  assert([
    "event_not_advice_eligible",
    "semantic_category_does_not_open_host_answer",
    "supporting_event_waits_for_fixed_checkpoint",
    "only_fixed_checkpoint_or_explicit_card_action_opens_host_answer",
  ].includes(gate?.reason), `${label} returned an unexpected fact-only reason: ${gate?.reason}`);
}

function liveState(stageRound) {
  const major = Number(stageRound.split("-")[0]);
  return {
    match_session_id: `verify-lineup-convergence-${stageRound}`,
    phase: { stage_round: stageRound, status: 1 },
    economy: {
      hp: major === 4 ? 48 : 72,
      gold: major === 2 ? 36 : 50,
      level: major === 2 ? 5 : major === 3 ? 7 : 8,
      xp: "0/36",
    },
    board_units: [{ name: "阿卡丽", star: 1 }, { name: "贾克斯", star: 1 }],
    bench_units: [{ name: "阿卡丽", star: 1 }],
    shop_units: [{ name: "千珏", star: 1 }],
    item_bench: [{ name: "暴风大剑" }, { name: "反曲之弓" }],
    selected_augments: [{ name: "飞升" }],
  };
}

const expected = new Map([
  ["2-2", "explore_candidates"],
  ["2-7", "prepare_next_choice"],
  ["3-3", "narrow_candidates"],
  ["3-5", "provisional_commit"],
  ["3-7", "provisional_commit"],
  ["4-3", "commit_and_execute"],
]);

const lateExpected = new Map([
  ["5-1", "late_target_cap_review"],
  ["5-3", "late_target_cap_review"],
  ["5-7", "late_target_cap_review"],
  ["6-1", "late_target_cap_review"],
  ["6-3", "late_target_cap_review"],
]);

const synchronousRankingSummary = readLiveRankingsSummarySync();
assert(synchronousRankingSummary?.available === true,
  "the synchronous proactive path must read the current compatible Active Ranking overlay");
assert(synchronousRankingSummary.ranking_overlay_id,
  "the synchronous proactive Ranking summary must retain the active overlay identity");
assert(firstArray(synchronousRankingSummary.tiers?.["0"]?.lineup_groups).length > 0,
  "the synchronous proactive Ranking summary must expose the Master+ lineup working pool");

setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: "verify-strategy-retry-coalesce" },
  runtime_event_advice: { handled: {}, retry_pending: {}, last_by_category: {}, last_by_trigger: {} },
});
const retryGate = { ok: false, reason: "response_task_active", category: "line_decision_context" };
const retryEvent = (stageRound, checkpointId, semanticKey) => ({
  match_session_id: "verify-strategy-retry-coalesce",
  type: "line_decision_context_changed",
  decision_trigger_id: "lineup_convergence_checkpoint",
  stage_round: stageRound,
  fixed_checkpoint_id: checkpointId,
  semantic_key: semanticKey,
  advice_eligible: true,
});
rememberRetryableRuntimeEventAdvice(
  retryEvent("2-2", "direction_exploration", "retry-2-2"),
  retryGate,
  "verify-strategy-retry-coalesce|2-2",
);
rememberRetryableRuntimeEventAdvice(
  retryEvent("2-5", "direction_exploration", "retry-2-5-recovery"),
  retryGate,
  "verify-strategy-retry-coalesce|2-5",
);
let retryEntries = Object.values(getRuntimeServiceState().runtime_event_advice.retry_pending)
  .filter((entry) => entry.status === "pending_retry");
assert(retryEntries.length === 0,
  "legacy retry_pending must not create a parallel owner for a strategic obligation without an exact queue binding");
rememberRetryableRuntimeEventAdvice(
  retryEvent("3-3", "post_3_2_narrowing", "retry-3-3"),
  retryGate,
  "verify-strategy-retry-coalesce|3-3",
);
retryEntries = Object.values(getRuntimeServiceState().runtime_event_advice.retry_pending)
  .filter((entry) => entry.status === "pending_retry");
assert(retryEntries.length === 0,
  "later strategic checkpoints must also remain owned by the persistent obligation queue instead of legacy retry_pending");

function firstArray(value) {
  return Array.isArray(value) ? value : [];
}

for (const [stageRound, checkpoint] of expected) {
  const result = scoreLiveState(liveState(stageRound), {
    minimum_value_score_to_speak: 0.7,
  });
  const task = result.advice_tasks.find((entry) => entry.trigger_id === "lineup_convergence_checkpoint");
  assert(task, `${stageRound} must admit an active lineup convergence task`);
  assert(task.semantic_labels.includes(checkpoint), `${stageRound} must carry checkpoint ${checkpoint}`);
  assert(task.actions.length >= 3, `${stageRound} must give an actionable agenda instead of a fact-only event`);
  const signal = buildRuntimeProactiveDecisionSignal(liveState(stageRound), {}, {
    phase: { stage_round: stageRound },
    economy: liveState(stageRound).economy,
  });
  assert(signal?.decision_trigger_id === "lineup_convergence_checkpoint", `${stageRound} production arbitration must select the lineup convergence agenda`);
  assert(signal.actions.length >= 3, `${stageRound} production signal must preserve actionable lineup steps`);
  assert(signal.strategy_block_id, `${stageRound} production signal must preserve its strategy block identity`);
  assert(Number.isInteger(signal.fixed_checkpoint_block_sequence), `${stageRound} production signal must preserve its block sequence`);
}

const completedExplorationRecoveryScore = scoreLiveState(liveState("2-5"), {
  minimum_value_score_to_speak: 0.7,
});
assert(!completedExplorationRecoveryScore.advice_tasks.some((entry) => entry.trigger_id === "lineup_convergence_checkpoint"),
  "2-5 must not create a standalone lineup-convergence checkpoint");

const formationReadinessSignal = buildRuntimeProactiveDecisionSignal(liveState("4-5"), {}, {
  phase: { stage_round: "4-5" },
  economy: liveState("4-5").economy,
});
assert(formationReadinessSignal?.decision_trigger_id === "lineup_convergence_checkpoint",
  "4-5 must produce a strategic formation-readiness signal");
strictAssert.equal(formationReadinessSignal.strategy_block_id, "formation_readiness_and_execution");
strictAssert.equal(formationReadinessSignal.fixed_checkpoint_block_role, "formation_readiness");
const formationReadinessAgenda = buildProactiveCoachContentAgenda(
  {
    type: "line_decision_context_changed",
    stage_round: "4-5",
    fixed_checkpoint_id: "formation_readiness_review",
    decision_trigger_id: "lineup_convergence_checkpoint",
    advice_eligible: true,
  },
  { category: "line_decision_context" },
  { phase: { stage_round: "4-5" } },
);
assert(formationReadinessAgenda.max_actions >= 8 && formationReadinessAgenda.max_sentences >= 12,
  "4-5 formation-readiness must receive the expanded strategic response budget");
assert(formationReadinessAgenda.required_decisions.includes("compare_level_8_quality_against_level_9_timing"),
  "4-5 agenda must require the level-eight versus level-nine decision");
const stageFourPreparationAgenda = buildProactiveCoachContentAgenda(
  {
    type: "line_decision_context_changed",
    stage_round: "3-7",
    fixed_checkpoint_id: "pre_4_stage_fork",
    decision_trigger_id: "lineup_convergence_checkpoint",
    advice_eligible: true,
  },
  { category: "line_decision_context" },
  { phase: { stage_round: "3-7" } },
);
assert(stageFourPreparationAgenda.required_decisions.includes("current_item_holders_and_transfer_order"),
  "3-7 agenda must review current item holders before stage four");
assert(stageFourPreparationAgenda.required_decisions.includes("target_progress_and_transition_replacement_order"),
  "3-7 agenda must review transition replacement order before stage four");
assert(stageFourPreparationAgenda.output_contract.join(" ").includes("standalone equipment reply"),
  "3-7 agenda must prevent a later duplicate equipment reply");

const highCostRankingContext = {
  live_rankings_context: {
    top_lineups: [{
      id: "four-cost-line",
      name: "四费运营测试线",
      source_role: "national_master_plus_strength_anchor",
      metrics_authority: true,
      lifecycle_prior: { archetype: "four_cost_carry" },
      main_carry: { champion_name: "四费主C", cost: 4 },
      primary_tank: { champion_name: "四费主坦", cost: 4 },
    }],
  },
};
const threeFiveHighCostScore = scoreLiveState(liveState("3-5"), highCostRankingContext);
const threeFiveHighCostTask = threeFiveHighCostScore.advice_tasks.find((entry) => entry.trigger_id === "lineup_convergence_checkpoint");
assert(threeFiveHighCostTask?.actions.includes("state_level_7_transition_for_relevant_high_cost_candidates"),
  "3-5 must request a level-seven transition only when a high-cost candidate is present");
const threeFiveAgenda = buildProactiveCoachContentAgenda(
  {
    type: "line_decision_context_changed",
    stage_round: "3-5",
    fixed_checkpoint_id: "three_cost_reroll_or_operation",
    decision_trigger_id: "lineup_convergence_checkpoint",
    advice_eligible: true,
  },
  { category: "line_decision_context" },
  { phase: { stage_round: "3-5" } },
);
assert(threeFiveAgenda.required_decisions.includes("level_7_transition_for_four_cost_or_nine_five_candidates"),
  "3-5 agenda must carry the conditional level-seven transition obligation");
assert(/Execution scope: At 3-5.*level-7 transition roster.*4-1.*4-2.*3-7/s.test(threeFiveAgenda.output_contract.join("\n")),
  "3-5 agenda must reserve the level-eight startup comparison for 3-7");
const threeSevenAgenda = buildProactiveCoachContentAgenda(
  {
    type: "line_decision_context_changed",
    stage_round: "3-7",
    fixed_checkpoint_id: "pre_4_stage_fork",
    decision_trigger_id: "lineup_convergence_checkpoint",
    advice_eligible: true,
  },
  { category: "line_decision_context" },
  { phase: { stage_round: "3-7" } },
);
assert(threeSevenAgenda.required_decisions.includes("level_8_at_4_1_vs_4_2_cost_and_contest_tradeoff"),
  "3-7 must retain the level-eight startup comparison");
const threeFiveDurableScore = scoreLiveState(liveState("3-5"), {
  ...highCostRankingContext,
  target_plan: { name: "已确认目标", status: "confirmed", authority: "durable_target_plan" },
});
const threeFiveDurableTask = threeFiveDurableScore.advice_tasks.find((entry) => entry.trigger_id === "lineup_convergence_checkpoint");
assert(!threeFiveDurableTask?.actions.includes("state_level_7_transition_for_relevant_high_cost_candidates"),
  "3-5 must not emit the candidate transition branch after a durable target is confirmed");

const choiceOwnedStrategicSession = "verify-choice-owned-strategy";
setRuntimeServiceEventWriter(() => {});
setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: choiceOwnedStrategicSession },
  match_context: {
    target_plan: {
      name: "峡谷野怪10",
      status: "confirmed",
      unit_names: ["阿卡丽", "千珏"],
    },
    choice_confirmations: [],
  },
  runtime_event_detector: { last_snapshot: null },
  runtime_event_advice: { handled: {}, last_by_category: {}, last_by_trigger: {}, retry_pending: {} },
});
const choiceOwnedBaseState = {
  ...liveState("3-3"),
  match_session_id: choiceOwnedStrategicSession,
  own_board: { units: [{ name: "阿卡丽", star: 1 }, { name: "贾克斯", star: 1 }] },
  own_bench: { units: [{ name: "阿卡丽", star: 1 }] },
  shop: { units: [{ name: "千珏", star: 1 }] },
};
detectRuntimeSemanticEvents(choiceOwnedBaseState, {
  match_context: getRuntimeServiceState().match_context,
});
const choiceOwnedFollowupState = {
  ...choiceOwnedBaseState,
  board_units: [...choiceOwnedBaseState.board_units, { name: "千珏", star: 1 }],
  own_board: { units: [...choiceOwnedBaseState.own_board.units, { name: "千珏", star: 1 }] },
};
const choiceOwnedFollowupContext = {
  ...getRuntimeServiceState().match_context,
  choice_confirmations: [{
    stage_round: "3-2",
    kind: "augment",
    selected: "后期收益",
    interaction_id: "choice-owned-strategy-3-2",
    response_task_id: "choice-owned-strategy-task",
    response_policy: "semantic_followup_owner",
  }],
};
const choiceOwnedEvents = detectRuntimeSemanticEvents(choiceOwnedFollowupState, {
  match_context: choiceOwnedFollowupContext,
});
const choiceOwnerEvent = choiceOwnedEvents.find((entry) => (
  entry.fixed_checkpoint_id === "post_3_2_narrowing"
  && entry.decision_trigger_id === "lineup_convergence_checkpoint"
));
assert(choiceOwnerEvent,
  "after a structured confirmation has released its direct task, 3-3 must still emit exactly one strategic owner carrying the confirmed choice context");
assert(choiceOwnerEvent.fixed_checkpoint_id === "post_3_2_narrowing",
  "the single 3-3 owner must retain the current fixed checkpoint identity");
assert(choiceOwnedEvents.filter((entry) => entry.advice_eligible === true).length === 1,
  "confirmed-choice context and target-line progression must not create a second automatic Host owner");
assert(getRuntimeServiceState().runtime_event_detector?.last_snapshot?.target_line_unit_names?.includes("千珏"),
  "the merged strategic owner must still be able to consume current target-line progression from the latest snapshot");

const idleCardState = getRuntimeServiceState();
for (const mode of ["cruise", "augment_choice", "item_choice", "manual_match_variables", "lineup_card"]) {
  setRuntimeServiceState({ ...idleCardState, active_mode: mode, response_task: { status: "idle" } });
  const gate = shouldStartAdviceForRuntimeEvent(choiceOwnerEvent, choiceOwnedFollowupState);
  strictAssert.equal(gate.ok, true, `${mode}: an idle card must not block the registered 3-3 checkpoint (${gate.reason})`);
  for (const status of ["preparing", "running", "awaiting_host_cli_agent_response", "cancelling"]) {
    setRuntimeServiceState({ ...idleCardState, active_mode: mode, response_task: {
      status, mode: "augment_choice", origin: "user", structured_card_action: true,
      response_task_id: "real-manual-owner", match_session_id: choiceOwnedStrategicSession,
    } });
    const occupied = shouldStartAdviceForRuntimeEvent(choiceOwnerEvent, choiceOwnedFollowupState);
    strictAssert.equal(occupied.reason, "response_task_active", `${mode}/${status}: real user task keeps the lane`);
  }
  setRuntimeServiceState({ ...idleCardState, active_mode: mode, response_task: { status: "cancelled" } });
  strictAssert.equal(shouldStartAdviceForRuntimeEvent(choiceOwnerEvent, choiceOwnedFollowupState).ok, true,
    `${mode}: settled cancellation must release the lane without changing tabs`);
}
setRuntimeServiceState(idleCardState);

const delayedDirectionAgenda = buildProactiveCoachContentAgenda(
  {
    type: "line_decision_context_changed",
    stage_round: "2-7",
    decision_trigger_id: "lineup_convergence_checkpoint",
    fixed_checkpoint_id: "direction_exploration",
    catch_up_from_stage_round: "2-2",
    deferred_after_occupied_lane: true,
    semantic_labels: ["explore_candidates", "deferred_after_occupied_lane"],
    advice_eligible: true,
  },
  { category: "line_decision_context" },
  { phase: { stage_round: "2-7" } },
);
strictAssert.equal(
  delayedDirectionAgenda.fixed_checkpoint?.checkpoint_id,
  "direction_exploration",
  "a delayed 2-2 answer must retain its explicit checkpoint identity at 2-7",
);
strictAssert.equal(
  delayedDirectionAgenda.fixed_checkpoint?.checkpoint_stage_round,
  "2-2",
  "a delayed 2-2 answer must keep the original checkpoint stage for auditability",
);

for (const [stageRound, checkpoint] of lateExpected) {
  const result = scoreLiveState(liveState(stageRound), {
    minimum_value_score_to_speak: 0.7,
    target_plan: { name: "峡谷野怪10", status: "confirmed" },
  });
  const task = result.advice_tasks.find((entry) => entry.trigger_id === "lineup_convergence_checkpoint");
  assert(task, `${stageRound} must admit a fixed late cap/floor task`);
  assert(task.semantic_labels.includes(checkpoint), `${stageRound} must carry ${checkpoint}`);
  const stageIdentity = stageRound.replace("-", "_");
  assert(task.semantic_labels.some((label) => label.startsWith(`fixed_checkpoint_${stageIdentity}_`)), `${stageRound} must carry its fixed checkpoint identity`);
}

for (const stageRound of ["2-1", "3-2", "4-2", "4-4", "5-2", "5-4", "6-4"]) {
  const result = scoreLiveState(liveState(stageRound), {
    minimum_value_score_to_speak: 0.7,
    target_plan: { name: "峡谷野怪10", status: "confirmed" },
  });
  assert(!result.advice_tasks.some((entry) => entry.trigger_id === "lineup_convergence_checkpoint"), `${stageRound} must not create a duplicate strategic checkpoint outside the registered agenda`);
}

const withDurableTarget = scoreLiveState(liveState("3-6"), {
  minimum_value_score_to_speak: 0.7,
  target_plan: { name: "5太空律动", status: "confirmed" },
});
assert(
  !withDurableTarget.advice_tasks.some((entry) => entry.trigger_id === "lineup_convergence_checkpoint"),
  "the no-target convergence agenda must stop after a durable target exists",
);

for (const stageRound of ["4-3", "4-5"]) {
  const targetPlan = {
    name: "5太空律动",
    status: "confirmed",
    authority: "durable_target_plan",
    source: "explicit_user_commitment",
  };
  const withTarget = scoreLiveState(liveState(stageRound), {
    minimum_value_score_to_speak: 0.7,
    target_plan: targetPlan,
  });
  const task = withTarget.advice_tasks.find((entry) => entry.trigger_id === "lineup_convergence_checkpoint");
  assert(task, `${stageRound} must keep an execution/exit agenda after a durable target exists`);
  assert(task.semantic_labels.includes("target_execution_checkpoint"), `${stageRound} must distinguish target execution from no-target exploration`);
  const signal = buildRuntimeProactiveDecisionSignal(liveState(stageRound), { target_plan: targetPlan }, {
    phase: { stage_round: stageRound },
    economy: liveState(stageRound).economy,
  });
  assert(signal?.decision_trigger_id === "lineup_convergence_checkpoint", `${stageRound} production arbitration must not go silent for a named target with no parsed unit ids`);
  assert(signal.semantic_labels.includes("target_execution_checkpoint"), `${stageRound} production signal must preserve target execution semantics`);
}

for (const [field, value] of [
  ["target_name", "5太空律动"],
  ["lineup_name", "5太空律动"],
  ["primary_carry", "娜美"],
]) {
  const aliasSignal = buildRuntimeProactiveDecisionSignal(liveState("4-3"), {
    target_plan: {
      [field]: value,
      status: "confirmed",
      authority: "durable_target_plan",
      source: "explicit_user_commitment",
    },
  }, {
    phase: { stage_round: "4-3" },
    economy: liveState("4-3").economy,
  });
  assert(aliasSignal?.decision_trigger_id === "lineup_convergence_checkpoint", `durable target field ${field} must keep the target execution agenda active`);
  assert(aliasSignal.semantic_labels.includes("target_execution_checkpoint"), `durable target field ${field} must not collapse back into generic discovery`);
}

const lateTarget = { target_plan: { name: "峡谷野怪10", status: "confirmed" } };
const lateTargetSignal = buildRuntimeProactiveDecisionSignal(liveState("5-3"), lateTarget, {
  phase: { stage_round: "5-3" },
  economy: liveState("5-3").economy,
});
assert(lateTargetSignal?.decision_trigger_id === "cap_gap_check"
  || lateTargetSignal?.decision_trigger_id === "lineup_convergence_checkpoint",
  "a confirmed target in stage five must select a strategic cap or lineup agenda");
assert(lateTargetSignal.semantic_labels.includes("late_target_cap_review"),
  "stage-five target execution must preserve the cap review label");
assert(lateTargetSignal.actions.includes("decide_level_8_9_10_or_quality"),
  "stage-five target execution must ask whether to level or stabilize quality");
strictAssert.equal(lateTargetSignal.strategy_block_id, "cap_floor_endgame");
strictAssert.equal(lateTargetSignal.fixed_checkpoint_block_role, "cap_floor_review");

const survivalState = liveState("3-6");
survivalState.economy.hp = 27;
const survivalSignal = buildRuntimeProactiveDecisionSignal(survivalState, {}, {
  phase: { stage_round: "3-6" },
  economy: survivalState.economy,
});
strictAssert.equal(survivalSignal, null, "non-checkpoint HP pressure must remain fact-only and must not open an automatic Host turn");

setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: "verify-strategic-owner" },
  response_task: {
    status: "running",
    origin: "runtime_event",
    mode: "cruise",
    response_task_id: "strategic-owner",
    event_key: "verify-strategic-owner|line_decision_context_changed|cap-gap",
    event_priority: 63,
    runtime_event_context: {
      decision_trigger_id: "cap_gap_check",
      event_category: "line_decision_context",
    },
  },
  runtime_event_advice: { handled: {}, last_by_category: {}, last_by_trigger: {}, retry_pending: {} },
});
const lowValueDuringStrategic = shouldStartAdviceForRuntimeEvent({
  match_session_id: "verify-strategic-owner",
  type: "level_roll_decision_context_changed",
  decision_trigger_id: "level_or_roll_timing",
  stage_round: "5-2",
  advice_eligible: true,
}, liveState("5-2"));
assertFactOnlyGate(lowValueDuringStrategic, "low-value tempo/economy events");

const ordinaryEventOutsideCheckpoint = shouldStartAdviceForRuntimeEvent({
  match_session_id: "verify-ordinary-event",
  type: "shop_decision_context_changed",
  decision_trigger_id: "shop_hold_sell_interest",
  stage_round: "2-3",
  advice_eligible: true,
}, liveState("2-3"));
assertFactOnlyGate(ordinaryEventOutsideCheckpoint, "ordinary events outside fixed checkpoints");

setRuntimeServiceState({
  ...getRuntimeServiceState(),
  runtime_event_detector: {
    ...(getRuntimeServiceState().runtime_event_detector || {}),
    last_scheduled_fixed_checkpoint_id: "pre_4_stage_fork",
  },
  runtime_event_advice: {
    ...(getRuntimeServiceState().runtime_event_advice || {}),
    retry_pending: {
      scheduledEquipmentReview: {
        status: "pending_retry",
        event: {
          match_session_id: "verify-ordinary-at-checkpoint",
          decision_trigger_id: "lineup_convergence_checkpoint",
          stage_round: "3-7",
          fixed_checkpoint_id: "pre_4_stage_fork",
        },
      },
    },
  },
});
const ordinaryEventAtCheckpoint = shouldStartAdviceForRuntimeEvent({
  match_session_id: "verify-ordinary-at-checkpoint",
  type: "equipment_fit_changed",
  event_category: "equipment_fit_context",
  decision_trigger_id: "item_slam_or_greed",
  stage_round: "4-7",
  advice_eligible: true,
}, liveState("4-7"));
assertFactOnlyGate(ordinaryEventAtCheckpoint, "ordinary equipment changes after the 3-7 equipment review");

setRuntimeServiceState({
  ...getRuntimeServiceState(),
  runtime_event_detector: {
    ...(getRuntimeServiceState().runtime_event_detector || {}),
    last_scheduled_fixed_checkpoint_id: "post_3_2_narrowing",
  },
  runtime_event_advice: {
    ...(getRuntimeServiceState().runtime_event_advice || {}),
    retry_pending: {
      scheduledNarrowing: {
        status: "pending_retry",
        event: {
          match_session_id: "verify-registered-support-at-checkpoint",
          decision_trigger_id: "lineup_convergence_checkpoint",
          stage_round: "3-3",
          fixed_checkpoint_id: "post_3_2_narrowing",
        },
      },
    },
  },
});
const registeredSupportAtCheckpoint = shouldStartAdviceForRuntimeEvent({
  match_session_id: "verify-registered-support-at-checkpoint",
  type: "line_decision_context_changed",
  event_category: "line_decision_context",
  decision_trigger_id: "key_unit_progression",
  layer: "decision_signal",
  stage_round: "3-3",
  advice_eligible: true,
}, liveState("3-3"));
assertFactOnlyGate(registeredSupportAtCheckpoint, "registered non-checkpoint line signals");

const skippedAt = new Date(Date.now() - 4 * 60 * 1000).toISOString();
const deferredEvent = {
  match_session_id: "verify-lineup-catch-up",
  type: "line_decision_context_changed",
  decision_trigger_id: "lineup_convergence_checkpoint",
  fixed_checkpoint_id: "three_cost_reroll_or_operation",
  fixed_checkpoint_stage_round: "3-5",
  semantic_key: "lineup-convergence:3-5:provisional_commit",
  stage_round: "3-5",
  advice_eligible: true,
  semantic_labels: ["provisional_commit"],
  actions: ["recommend relative convergence"],
};
setRuntimeServiceEventWriter(() => {});
setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: "verify-lineup-catch-up" },
  response_task: { status: "idle", response_task_id: null },
  runtime_event_advice: {
    handled: {},
    last_by_category: {},
    last_by_trigger: {},
    last_started_at: null,
    retry_pending: {
      "verify-lineup-catch-up|line_decision_context_changed|lineup-convergence:3-5:provisional_commit": {
        schema: "jcc-runtime-event-advice-retry-v1",
        status: "pending_retry",
        event_key: "verify-lineup-catch-up|line_decision_context_changed|lineup-convergence:3-5:provisional_commit",
        event: deferredEvent,
        first_skipped_at: skippedAt,
        last_skipped_at: skippedAt,
        retry_reason: "response_task_active",
      },
    },
  },
});
const catchUp = retryableRuntimeEventAdviceEvents({
  ...liveState("4-3"),
  match_session_id: "verify-lineup-catch-up",
  phase: { stage_round: "4-3", status: 1 },
});
assert(catchUp.length === 0, "strategic retries must be absorbed into the persistent obligation queue instead of opening a second Host scheduling source");
const adoptedStrategicRetry = getRuntimeServiceState().runtime_event_advice.retry_pending[
  "verify-lineup-catch-up|line_decision_context_changed|lineup-convergence:3-5:provisional_commit"
];
strictAssert.equal(adoptedStrategicRetry.status, "adopted_by_strategic_obligation_queue");
assert(
  getRuntimeServiceState().runtime_strategic_obligations?.obligations_by_block?.formation_readiness_and_execution,
  "the delayed strategic retry must be retained as a durable obligation for the next registered checkpoint",
);

const sameStageLiveState = {
  ...liveState("3-6"),
  match_session_id: "verify-lineup-same-stage-refresh",
  economy: { ...liveState("3-6").economy, hp: 49, gold: 41 },
  board_units: [...liveState("3-6").board_units, { name: "same-stage-new-unit", star: 2 }],
};
const latestSameStageSignal = buildRuntimeProactiveDecisionSignal(sameStageLiveState, {}, {
  phase: { stage_round: "3-6" },
  economy: sameStageLiveState.economy,
}, {
  fixed_checkpoint_id: "three_cost_reroll_or_operation",
  fixed_trigger_id: "lineup_convergence_checkpoint",
  force_fixed_checkpoint: false,
});
setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: "verify-lineup-same-stage-refresh" },
  response_task: { status: "idle", response_task_id: null },
  runtime_event_advice: {
    handled: {},
    last_by_category: {},
    last_by_trigger: {},
    last_started_at: null,
    retry_pending: {
      "verify-lineup-same-stage-refresh|line_decision_context_changed|lineup-convergence:3-6:provisional_commit": {
        schema: "jcc-runtime-event-advice-retry-v1",
        status: "pending_retry",
        event_key: "verify-lineup-same-stage-refresh|line_decision_context_changed|lineup-convergence:3-6:provisional_commit",
        event: {
          ...deferredEvent,
          match_session_id: "verify-lineup-same-stage-refresh",
          fixed_checkpoint_id: "three_cost_reroll_or_operation",
          fixed_checkpoint_stage_round: "3-5",
          stage_round: "3-5",
          semantic_key: "lineup-convergence:3-5:provisional_commit",
          current_hash: "stale-same-stage-hash",
          actions: ["stale action that must not survive"],
        },
        first_skipped_at: skippedAt,
        last_skipped_at: skippedAt,
        retry_reason: "response_task_active",
      },
    },
  },
});
const refreshedSameStage = retryableRuntimeEventAdviceEvents(sameStageLiveState);
assert(refreshedSameStage.length === 0, "same-stage strategic retries must also be adopted by the persistent obligation queue");
const adoptedSameStageRetry = getRuntimeServiceState().runtime_event_advice.retry_pending[
  "verify-lineup-same-stage-refresh|line_decision_context_changed|lineup-convergence:3-6:provisional_commit"
];
strictAssert.equal(adoptedSameStageRetry.status, "adopted_by_strategic_obligation_queue");
assert(
  getRuntimeServiceState().runtime_strategic_obligations?.obligations_by_block?.formation_readiness_and_execution,
  "same-stage strategic debt must remain available for recomputation at the current registered checkpoint",
);

const stageTwoEventKey = "verify-direct-absorption|line_decision_context_changed|lineup-convergence:2-2:explore_candidates";
setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: "verify-direct-absorption" },
  match_context: { recent_user_messages: [{ text: "现在该玩什么方向", observed_at: new Date().toISOString() }] },
  response_task: { status: "running", response_task_id: "direct-user-task", origin: "user", mode: "cruise" },
  runtime_event_advice: {
    handled: {},
    last_by_category: {},
    last_by_trigger: {},
    last_started_at: null,
    retry_pending: {
      [stageTwoEventKey]: {
        schema: "jcc-runtime-event-advice-retry-v1",
        status: "pending_retry",
        event_key: stageTwoEventKey,
        event: {
          ...deferredEvent,
          match_session_id: "verify-direct-absorption",
          stage_round: "2-5",
          fixed_checkpoint_id: "direction_exploration",
          fixed_checkpoint_stage_round: "2-2",
          catch_up_from_stage_round: "2-2",
          semantic_key: "lineup-convergence:2-2:explore_candidates",
          semantic_labels: ["explore_candidates"],
          actions: ["stale stage-two candidate exploration"],
        },
        first_skipped_at: skippedAt,
        last_skipped_at: skippedAt,
        retry_reason: "user_message_received",
      },
    },
  },
});
const directStageThreeState = {
  ...liveState("3-3"),
  match_session_id: "verify-direct-absorption",
};
const absorbed = buildDirectUserAbsorbedCruiseObligation(directStageThreeState);
assert(absorbed, "a direct user turn must absorb a pending lineup-convergence obligation");
strictAssert.equal(absorbed.stage_round, "3-3", "the absorbed obligation must use the current fixed checkpoint, not replay stage two");
assert(absorbed.semantic_labels.includes("narrow_candidates"), "stage-three absorption must narrow to a primary and backup");
assert(!absorbed.actions.includes("stale stage-two candidate exploration"), "absorbed advice must be rebuilt from current facts");
strictAssert.deepEqual(absorbed.source_event_keys, [stageTwoEventKey], "the direct turn must retain the exact obligation identity for completion");

const genericUserHostRequest = {
  mode: "cruise",
  request_kind: "host_question",
  user_message: "普通灵魂莲花有几个？",
};
strictAssert.equal(
  buildDirectUserAbsorbedCruiseObligation(directStageThreeState, genericUserHostRequest)?.stage_round,
  "3-3",
  "a user turn must carry the current strategic checkpoint instead of starving it",
);
const genericAbsorbed = buildDirectUserAbsorbedCruiseObligation(directStageThreeState, genericUserHostRequest);
assert(genericAbsorbed.strategic_obligation, "an absorbed user turn must carry the strategic obligation envelope");
assert(
  genericAbsorbed.strategic_obligation.required_decisions.includes("complete_candidate_rosters_and_roles"),
  "an absorbed user turn must preserve the complete-roster requirement",
);
const strategicUserHostRequest = {
  mode: "cruise",
  request_kind: "host_question",
  user_message: "结合当前阵容方向给我阵容收束和下一步行动",
};
strictAssert.ok(
  buildDirectUserAbsorbedCruiseObligation(directStageThreeState, strategicUserHostRequest),
  "a strategic user question may absorb the pending checkpoint into its integrated answer",
);

const absorbedHostRequest = {
  runtime_context: { absorbed_cruise_obligation: absorbed },
  response: {
    strategic_obligation_coverage: { ok: true },
  },
};
const completedKeys = markAbsorbedCruiseObligationAnsweredByTask(absorbedHostRequest, "direct-user-task");
strictAssert.deepEqual(completedKeys, [stageTwoEventKey], "successful direct delivery must close the absorbed cruise obligation exactly once");
const absorbedState = getRuntimeServiceState();
strictAssert.equal(
  absorbedState.runtime_event_advice.retry_pending[stageTwoEventKey].status,
  "answered_by_direct_user_task",
  "absorbed cruise work must not reopen as a second proactive answer",
);
strictAssert.equal(
  absorbedState.runtime_event_advice.handled[stageTwoEventKey].status,
  "answered_by_direct_user_task",
  "the cruise audit must record that the direct answer satisfied the obligation",
);
strictAssert.equal(retryableRuntimeEventAdviceEvents(directStageThreeState).length, 0, "completed absorption must leave no sibling cruise retry");
strictAssert.deepEqual(
  markAbsorbedCruiseObligationAnsweredByTask(absorbedHostRequest, "direct-user-task"),
  [],
  "duplicate completion must be idempotent",
);

const supersededEventKey = "verify-direct-supersede|line_decision_context_changed|lineup-convergence:2-6:explore_candidates";
const unrelatedEconomyEventKey = "verify-direct-supersede|economy_decision_context_changed|interest:20";
setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: "verify-direct-supersede" },
  match_context: { target_plan: { target_name: "5太空律动", status: "confirmed" } },
  response_task: { status: "running", response_task_id: "direct-target-task", origin: "user", mode: "cruise" },
  runtime_event_advice: {
    handled: {},
    last_by_category: {},
    last_by_trigger: {},
    last_started_at: null,
    retry_pending: {
      [supersededEventKey]: {
        schema: "jcc-runtime-event-advice-retry-v1",
        status: "pending_retry",
        event_key: supersededEventKey,
        event: {
          ...deferredEvent,
          match_session_id: "verify-direct-supersede",
          stage_round: "2-6",
          fixed_checkpoint_id: "direction_exploration",
          fixed_checkpoint_stage_round: "2-2",
          semantic_key: "lineup-convergence:2-6:explore_candidates",
        },
        first_skipped_at: skippedAt,
        last_skipped_at: skippedAt,
        retry_reason: "user_message_received",
      },
      [unrelatedEconomyEventKey]: {
        schema: "jcc-runtime-event-advice-retry-v1",
        status: "pending_retry",
        event_key: unrelatedEconomyEventKey,
        event: {
          match_session_id: "verify-direct-supersede",
          type: "economy_decision_context_changed",
          decision_trigger_id: "interest_threshold",
          semantic_key: "interest:20",
          stage_round: "2-6",
          advice_eligible: true,
        },
        first_skipped_at: skippedAt,
        last_skipped_at: skippedAt,
        retry_reason: "response_task_active",
      },
    },
  },
});
const supersededWithoutStage = buildDirectUserAbsorbedCruiseObligation({
  match_session_id: "verify-direct-supersede",
  phase: {},
  economy: {},
});
const stageLessRetries = retryableRuntimeEventAdviceEvents({
  match_session_id: "verify-direct-supersede",
  phase: {},
  economy: {},
});
assert(
  !stageLessRetries.some((event) => event.decision_trigger_id === "lineup_convergence_checkpoint"),
  "a pending lineup checkpoint must not reopen from its historical stage while the current stage is missing",
);
assert(supersededWithoutStage, "a missing current stage must not leave an old lineup checkpoint pending after a direct answer");
  strictAssert.equal(supersededWithoutStage.response_policy, "answer_user_without_unverifiable_strategic_replay");
strictAssert.equal(supersededWithoutStage.stage_round, null);
strictAssert.deepEqual(supersededWithoutStage.source_event_keys, [supersededEventKey]);
strictAssert.deepEqual(
  markAbsorbedCruiseObligationAnsweredByTask(
    { runtime_context: { absorbed_cruise_obligation: supersededWithoutStage } },
    "direct-target-task",
  ),
  [],
  "a stage-less direct response must not falsely complete an unverified strategic obligation",
);
const supersededState = getRuntimeServiceState();
strictAssert.equal(
  supersededState.runtime_event_advice.retry_pending[supersededEventKey].status,
  "adopted_by_strategic_obligation_queue",
  "the strategic obligation must remain durable until a current-stage response covers it",
);
assert(
  supersededState.runtime_event_advice.retry_pending[unrelatedEconomyEventKey].status !== "answered_by_direct_user_task",
  "absorbing lineup convergence must not consume unrelated proactive work",
);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-proactive-lineup-convergence-verification-v1",
  checked_stages: [...expected.keys()],
}, null, 2));
