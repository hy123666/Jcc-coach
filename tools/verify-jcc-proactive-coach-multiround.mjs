import assert from "node:assert/strict";

import {
  buildProactiveCoachContentAgenda,
  detectRuntimeSemanticEvents,
  getRuntimeServiceState,
  retryableRuntimeEventAdviceEvents,
  runtimeEventCurrentActionFingerprint,
  runtimeProactiveDecisionTriggerPolicySnapshot,
  setRuntimeServiceState,
  shouldDisplayAutoCruiseResult,
  shouldStartAdviceForRuntimeEvent,
} from "../ui/electron/runtime-service.js";

const matchSessionId = "verify-proactive-coach-multiround";
const oldIso = "2000-01-01T00:00:00.000Z";
const nowIso = () => new Date().toISOString();

function runtimeState(matchContext = {}) {
  return {
    schema: "jcc-ui-runtime-state-v1",
    active_mode: "cruise",
    match_session: {
      status: "active",
      match_session_id: matchSessionId,
    },
    match_context: matchContext,
    runtime_event_advice: {
      handled: {},
      retry_pending: {},
      last_by_category: {},
      last_by_trigger: {},
      last_started_at: null,
      last_started_stage_round: null,
    },
  };
}

function liveState({
  stageRound,
  gold = 24,
  hp = 84,
  status = 1,
  level = 5,
  xp = { value: 2, to_next: 20 },
  board = [{ name: "Verifier Frontline", cost: 1, star: 1 }],
  bench = [],
  shop = [],
  itemBench = [],
} = {}) {
  return {
    schema: "jcc-live-state-v1",
    match_session_id: matchSessionId,
    phase: { stage_round: stageRound, status },
    economy: { hp, gold, level, xp },
    own_board: { units: board },
    own_bench: { units: bench },
    shop: { units: shop },
    items: { item_bench: itemBench },
  };
}

function targetContext() {
  return {
    target_plan: {
      name: "Verifier Carry Reroll",
      authority: "explicit_user",
      unit_names: ["Verifier Carry", "Verifier Tank", "Verifier Pair"],
      updated_at: "2026-07-28T00:00:00.000Z",
    },
    recent_user_messages: [],
    choice_confirmations: [],
  };
}

function assertNoHostLaneOwner(message) {
  assert(!getRuntimeServiceState().response_task?.response_task_id, message);
}

function assertFactOnlyGate(gate, label) {
  assert.equal(gate.ok, false, `${label} must not occupy the Host lane`);
  assert([
  "event_not_advice_eligible",
  "semantic_category_does_not_open_host_answer",
  "supporting_event_waits_for_fixed_checkpoint",
  "only_fixed_checkpoint_or_explicit_card_action_opens_host_answer",
].includes(gate.reason), `${label} returned an unexpected fact-only reason: ${gate.reason}`);
}

function eventKey(event) {
  return [
    event.match_session_id || "match_unknown",
    event.type || "event_unknown",
    event.semantic_key || event.stage_round || event.snapshot_id || "semantic_unknown",
  ].join("|");
}

function decisionEvent({
  stageRound,
  triggerId = "shop_hold_sell_interest",
  type = "shop_decision_context_changed",
  semantic = "synthetic",
  actions = ["hold key unit only if it does not break interest"],
  labels = [],
  adviceEligible = true,
} = {}) {
  return {
    schema: "jcc-runtime-semantic-event-v1",
    id: `${type}:${stageRound}:${semantic}`,
    match_session_id: matchSessionId,
    type,
    layer: "decision_signal",
    semantic_key: `${type}:${stageRound}:${semantic}`,
    advice_eligible: adviceEligible,
    stage_round: stageRound,
    decision_trigger_id: triggerId,
    actions,
    semantic_labels: labels,
    observed_at: nowIso(),
  };
}

function confirmedChoiceEvent(stageRound = "2-2") {
  return {
    schema: "jcc-runtime-semantic-event-v1",
    id: `confirmed_choices_changed:${stageRound}`,
    match_session_id: matchSessionId,
    type: "confirmed_choices_changed",
    layer: "decision_context",
    semantic_key: `confirmed_choices:${stageRound}:verify`,
    advice_eligible: true,
    explicit_user_card_action: true,
    stage_round: stageRound,
    response_policy: "semantic_followup",
    observed_at: nowIso(),
  };
}

function hpDangerEvent(stageRound = "2-3") {
  return {
    schema: "jcc-runtime-semantic-event-v1",
    id: `hp_pressure_bucket_changed:${stageRound}`,
    match_session_id: matchSessionId,
    type: "hp_pressure_bucket_changed",
    layer: "decision_signal",
    semantic_key: `hp_pressure:${stageRound}:danger`,
    advice_eligible: true,
    stage_round: stageRound,
    current_bucket: "danger",
    observed_at: nowIso(),
  };
}

function withStartedAdviceAt(stageRound, patch = {}) {
  const state = getRuntimeServiceState();
  setRuntimeServiceState({
    ...state,
    runtime_event_advice: {
      ...(state.runtime_event_advice || {}),
      handled: state.runtime_event_advice?.handled || {},
      retry_pending: state.runtime_event_advice?.retry_pending || {},
      last_by_category: state.runtime_event_advice?.last_by_category || {},
      last_by_trigger: state.runtime_event_advice?.last_by_trigger || {},
      last_started_at: nowIso(),
      last_started_stage_round: stageRound,
      ...patch,
    },
  });
}

function clearGlobalIntervalButKeepRound(stageRound, patch = {}) {
  const state = getRuntimeServiceState();
  setRuntimeServiceState({
    ...state,
    runtime_event_advice: {
      ...(state.runtime_event_advice || {}),
      last_started_at: oldIso,
      last_started_stage_round: stageRound,
      ...patch,
    },
  });
}

function main() {
  assert(runtimeProactiveDecisionTriggerPolicySnapshot().lineup_convergence_checkpoint, "fixed strategic trigger policy must be exported from runtime-service");

  const context = targetContext();
  setRuntimeServiceState(runtimeState(context));

  detectRuntimeSemanticEvents(liveState({
    stageRound: "2-2",
    gold: 20,
    shop: [{ name: "Neutral One", cost: 1, star: 1 }],
  }), { match_context: context, source: "verify_multiround_2_2_baseline" });

  const rawFactEvents = detectRuntimeSemanticEvents(liveState({
    stageRound: "2-2",
    gold: 20,
    shop: [{ name: "Neutral Two", cost: 1, star: 1 }],
    board: [{ name: "Verifier Frontline", cost: 1, star: 1 }],
    bench: [{ name: "Verifier Bench", cost: 1, star: 1 }],
    itemBench: [{
      name: "Verifier Component",
      source: "mumu_4357_item_bench",
      provenance: { source: "mumu_4357_item_bench", command: 4357 },
    }],
  }), { match_context: context, source: "verify_multiround_2_2_raw_facts" });
  assert.equal(
    rawFactEvents.some((event) => ["runtime_snapshot_changed", "shop_material_changed", "board_bench_material_changed", "item_material_changed"].includes(event.type)),
    false,
    "ordinary material changes must stay in the latest snapshot instead of entering the automatic event pipeline",
  );
  const materialSnapshot = getRuntimeServiceState().runtime_event_detector?.last_snapshot || {};
  assert.equal(materialSnapshot.shop_count, 1);
  assert.equal(materialSnapshot.board_count, 1);
  assert.equal(materialSnapshot.bench_count, 1);
  assert.equal(materialSnapshot.item_bench_count, 1);
  assertNoHostLaneOwner("raw fact updates must not create a response task");

  const shopEvent2_3 = decisionEvent({ stageRound: "2-3", semantic: "first-action" });
  const firstGate = shouldStartAdviceForRuntimeEvent(shopEvent2_3, liveState({ stageRound: "2-3" }));
  assertFactOnlyGate(firstGate, "a non-checkpoint shop decision");

  withStartedAdviceAt("2-2", {
    last_started_at: oldIso,
    last_by_trigger: {
      shop_hold_sell_interest: {
        at: nowIso(),
        event_key: eventKey(shopEvent2_3),
      },
    },
  });
  const sameTriggerDuplicateGate = shouldStartAdviceForRuntimeEvent(
    decisionEvent({ stageRound: "2-4", semantic: "duplicate-trigger" }),
    liveState({ stageRound: "2-4" }),
  );
  assertFactOnlyGate(sameTriggerDuplicateGate, "same trigger duplicate");

  const sameRoundNormalGate = shouldStartAdviceForRuntimeEvent(
    decisionEvent({
      stageRound: "2-2",
      triggerId: "interest_breakpoint_decision",
      semantic: "same-round-normal",
    }),
    liveState({ stageRound: "2-2" }),
  );
  assertFactOnlyGate(sameRoundNormalGate, "normal same-round advice");

  const adjacentRoundNormalGate = shouldStartAdviceForRuntimeEvent(
    decisionEvent({
      stageRound: "2-3",
      triggerId: "interest_breakpoint_decision",
      semantic: "adjacent-round-normal",
    }),
    liveState({ stageRound: "2-3" }),
  );
  assertFactOnlyGate(adjacentRoundNormalGate, "normal 2-3 advice");

  const sameRoundChoiceGate = shouldStartAdviceForRuntimeEvent(confirmedChoiceEvent("2-2"), liveState({ stageRound: "2-2" }));
  assert.equal(sameRoundChoiceGate.ok, true, "confirmed choice follow-up is a cadence exception");
  const confirmedChoiceAgenda = buildProactiveCoachContentAgenda(
    confirmedChoiceEvent("2-2"),
    sameRoundChoiceGate,
    liveState({ stageRound: "2-2" }),
  );
  assert.equal(confirmedChoiceAgenda.depth, "expanded_short");
  for (const decision of [
    "selected_choice_immediate_implication",
    "data_backed_candidate_lines_or_confirmed_target_fit",
    "future_choice_priorities_and_acceptable_substitutes",
    "item_direction_and_current_holder_posture",
    "economy_roll_or_level_checkpoint",
  ]) {
    assert(confirmedChoiceAgenda.required_decisions.includes(decision), `confirmed choice agenda missing ${decision}`);
  }

  clearGlobalIntervalButKeepRound("2-5");
  const sameRoundDangerGate = shouldStartAdviceForRuntimeEvent(hpDangerEvent("2-5"), liveState({ stageRound: "2-5", hp: 32 }));
  assertFactOnlyGate(sameRoundDangerGate, "HP pressure");
  const stableHpDecision = runtimeEventCurrentActionFingerprint(
    "hp_pressure",
    "hp_pressure_bucket_changed",
    null,
    liveState({ stageRound: "2-5", hp: 32, gold: 40, level: 6, board: [{ name: "Verifier Frontline", cost: 2, star: 2 }] }),
  );
  const repeatedStableHpDecision = runtimeEventCurrentActionFingerprint(
    "hp_pressure",
    "hp_pressure_bucket_changed",
    null,
    liveState({ stageRound: "2-5", hp: 32, gold: 40, level: 6, board: [{ name: "Verifier Frontline", cost: 2, star: 2 }] }),
  );
  const changedHpDecision = runtimeEventCurrentActionFingerprint(
    "hp_pressure",
    "hp_pressure_bucket_changed",
    null,
    liveState({ stageRound: "2-5", hp: 32, gold: 20, level: 7, board: [{ name: "Verifier Carry", cost: 3, star: 2 }] }),
  );
  assert.equal(repeatedStableHpDecision, stableHpDecision, "unchanged HP decision context must keep one stable action fingerprint");
  assert.notEqual(changedHpDecision, stableHpDecision, "same HP bucket with changed economy, level, or board must recompute the decision action");

  const explicitPivot = decisionEvent({
    stageRound: "2-5",
    triggerId: "direction_commit_or_exit",
    type: "line_decision_context_changed",
    semantic: "explicit-pivot",
    actions: ["pivot out of failed opener"],
    labels: ["pivot", "commit"],
  });
  const explicitPivotGate = shouldStartAdviceForRuntimeEvent(explicitPivot, liveState({ stageRound: "2-5" }));
  assertFactOnlyGate(explicitPivotGate, "automatic pivot signals");

  const staleShopEvent2_2 = decisionEvent({ stageRound: "2-2", semantic: "stale-for-2-3" });
  setRuntimeServiceState({
    ...runtimeState(context),
    runtime_event_advice: {
      handled: {},
      last_by_category: {},
      last_by_trigger: {},
      last_started_at: null,
      last_started_stage_round: null,
      retry_pending: {
        [eventKey(staleShopEvent2_2)]: {
          status: "pending_retry",
          event_key: eventKey(staleShopEvent2_2),
          event: staleShopEvent2_2,
          first_skipped_at: nowIso(),
          last_skipped_at: nowIso(),
          retry_reason: "response_task_active",
          live_state_fingerprint: "fingerprint-from-2-2",
        },
      },
    },
  });
  assert.equal(
    retryableRuntimeEventAdviceEvents(liveState({ stageRound: "2-3" })).length,
    0,
    "2-2 pending ordinary advice must not be restored at 2-3",
  );
  assert.equal(
    getRuntimeServiceState().runtime_event_advice.retry_pending[eventKey(staleShopEvent2_2)]?.expired_reason,
    "non_strategic_event_not_retryable",
    "cross-stage stale advice must be marked expired instead of replayed",
  );
  assert.equal(
    shouldDisplayAutoCruiseResult({
      requestedStageRound: "2-2",
      currentStageRound: "2-3",
      eventType: "shop_decision_context_changed",
      requestedStateFingerprint: "old",
      currentStateFingerprint: "old",
    }),
    false,
    "ordinary 2-2 automatic advice must not display at 2-3",
  );

  setRuntimeServiceState({
    ...runtimeState(context),
    runtime_event_advice: {
      handled: {},
      retry_pending: {},
      last_by_category: {},
      last_by_trigger: {
        shop_hold_sell_interest: {
          at: oldIso,
          event_key: eventKey(shopEvent2_3),
        },
      },
      last_started_at: oldIso,
      last_started_stage_round: "2-3",
    },
  });
  const laterEligibleEvent = decisionEvent({
    stageRound: "2-4",
    triggerId: "interest_breakpoint_decision",
    semantic: "later-interest-breakpoint",
    actions: ["sell bench filler for 30 gold interest unless it is a core pair"],
  });
  const laterEligibleGate = shouldStartAdviceForRuntimeEvent(laterEligibleEvent, liveState({ stageRound: "2-4", gold: 29 }));
  assertFactOnlyGate(laterEligibleGate, "later non-checkpoint state");

  withStartedAdviceAt("2-4", {
    last_started_at: nowIso(),
    last_by_trigger: {
      interest_breakpoint_decision: {
        at: nowIso(),
        event_key: eventKey(laterEligibleEvent),
      },
    },
  });
  const nextNormalGate = shouldStartAdviceForRuntimeEvent(
    decisionEvent({
      stageRound: "3-1",
      triggerId: "shop_lock_decision",
      semantic: "3-1-normal-followup",
    }),
    liveState({ stageRound: "3-1", gold: 31 }),
  );
  assert.equal(nextNormalGate.ok, false, "normal 3-1 follow-up must yield to the current choice-pretrigger window");
  assert([
    "choice_window_reserved_for_user_report",
    "semantic_category_does_not_open_host_answer",
    "only_fixed_checkpoint_or_explicit_card_action_opens_host_answer",
  ].includes(nextNormalGate.reason),
  `normal 3-1 follow-up returned an unexpected fact-only reason: ${nextNormalGate.reason}`);

  const choiceAt3_1Gate = shouldStartAdviceForRuntimeEvent(confirmedChoiceEvent("3-1"), liveState({ stageRound: "3-1" }));
  assert.equal(choiceAt3_1Gate.ok, true, "choice/confirmation follow-up can override the normal 3-1 cadence block");

  console.log(JSON.stringify({
    ok: true,
    checked_rounds: ["2-2", "2-3", "2-5", "3-1"],
    checked: [
      "2-2 raw shop/board/item facts remain fact_update events and are rejected as raw_material_fact_event",
      "non-checkpoint shop decisions remain fact-only and cannot create a Host agenda",
      "non-checkpoint duplicate signals cannot occupy the Host lane",
      "normal same-round advice is cadence-blocked, 2-3 has no retired S17 choice reservation, and 3-1 yields to the standard augment pretrigger",
      "confirmed choice remains answerable while danger HP and automatic pivot remain fact-only",
      "2-2 pending ordinary advice expires at 2-3 and shouldDisplayAutoCruiseResult rejects cross-stage delivery",
      "2-4 later automatic signals remain fact-only outside a fixed checkpoint",
      "3-1 normal follow-up remains blocked by choice-window reservation while choice follow-up remains eligible",
    ],
  }, null, 2));
}

main();
