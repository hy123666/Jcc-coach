import assert from "node:assert/strict";

import {
  buildDecisionSnapshot,
  detectRuntimeSemanticEvents,
  getRuntimeServiceState,
  runtimeEventCurrentActionFingerprint,
  setRuntimeServiceState,
  shouldDisplayAutoCruiseResult,
  shouldStartAdviceForRuntimeEvent,
} from "../ui/electron/runtime-service.js";
import { scoreLiveState } from "./score-jcc-cruise-strategy.mjs";

function runtimeState(matchContext = {}) {
  return {
    schema: "jcc-ui-runtime-state-v1",
    active_mode: "cruise",
    match_session: {
      status: "active",
      match_session_id: "verify-proactive-coach",
    },
    match_context: matchContext,
    runtime_event_advice: {
      handled: {},
      retry_pending: {},
      last_by_category: {},
      last_started_at: null,
    },
  };
}

function liveState({
  stageRound = "2-5",
  gold = 31,
  hp = 82,
  level = 5,
  xp = { value: 4, to_next: 20 },
  status = 1,
  board = [],
  bench = [],
  shop = [],
  items = {},
  eliminationConfirmed = false,
} = {}) {
  return {
    schema: "jcc-live-state-v1",
    match_session_id: "verify-proactive-coach",
    phase: {
      stage_round: stageRound,
      status,
      ...(eliminationConfirmed ? { match_ended: true, elimination_confirmed: true } : {}),
    },
    economy: { hp, gold, level, xp },
    own_board: { units: board },
    own_bench: { units: bench },
    shop: { units: shop },
    items,
  };
}

function main() {
  const targetContext = {
    target_plan: {
      name: "新星特攻队阿卡丽",
      authority: "explicit_user",
      unit_names: ["阿卡丽", "贾克斯", "千珏"],
    },
    recent_user_messages: [],
    choice_confirmations: [],
  };
  const rawEconomyState = liveState({ stageRound: "3-5", gold: 36, level: 6, xp: { value: 20, to_next: 36 } });
  setRuntimeServiceState(runtimeState(targetContext));
  const rawEconomyHash = runtimeEventCurrentActionFingerprint(
    "economy_management_context",
    "economic_decision_context_changed",
    null,
    rawEconomyState,
  );
  const hudObservedAt = new Date().toISOString();
  const hudContext = {
    ...targetContext,
    latest_hud_self_state: {
      stage_round: "3-6",
      economy: { hp: 82, gold: 0, level: 7, xp: { value: 0, to_next: 56 } },
      missing_economy_fields: [],
      economy_frame_anchor_status: "same_frame_stage_observed",
      observed_at: hudObservedAt,
    },
  };
  setRuntimeServiceState(runtimeState(hudContext));
  const hudEconomyHash = runtimeEventCurrentActionFingerprint(
    "economy_management_context",
    "economic_decision_context_changed",
    null,
    rawEconomyState,
  );
  assert.notEqual(hudEconomyHash, rawEconomyHash, "same-frame HUD economy must change the decision-family action fingerprint");
  const hudSnapshot = buildDecisionSnapshot({
    mode: "cruise",
    liveStateSummary: rawEconomyState,
    matchContext: hudContext,
    matchFacts: { target_plan: targetContext.target_plan, choice_confirmations: [] },
  });
  assert.equal(hudSnapshot.stage_round, "3-6");
  assert.deepEqual(hudSnapshot.economy, { hp: 82, gold: 0, level: 7, xp: 0 });

  setRuntimeServiceState(runtimeState(targetContext));
  const baselineState = liveState({
    stageRound: "2-3",
    board: [{ name: "亚托克斯", cost: 1, star: 1 }],
    shop: [{ name: "盖伦", cost: 1, star: 1 }],
  });
  const baselineEvents = detectRuntimeSemanticEvents(
    baselineState,
    { match_context: targetContext, source: "verify_nonfixed_baseline" },
  );
  assert.equal(baselineEvents.length, 0, "a non-fixed observation must remain fact-only and cannot open the Host lane even when strategic debt exists");
  const changedNonfixedState = liveState({
    stageRound: "2-3",
    board: [{ name: "亚托克斯", cost: 1, star: 1 }],
    bench: [{ name: "阿卡丽", cost: 2, star: 1 }],
    shop: [{ name: "阿卡丽", cost: 2, star: 1 }, { name: "贾克斯", cost: 2, star: 1 }],
  });
  const changedNonfixedEvents = detectRuntimeSemanticEvents(
    changedNonfixedState,
    { match_context: targetContext, source: "verify_nonfixed_material_change" },
  );
  assert(
    changedNonfixedEvents.every((event) => event.existing_strategic_obligation_delivery === true),
    "shop, board, bench, pair, and key-unit changes must not create an ordinary automatic event",
  );
  const nonfixedSnapshot = getRuntimeServiceState().runtime_event_detector?.last_snapshot || {};
  assert.equal(nonfixedSnapshot.shop_count, 2);
  assert.equal(nonfixedSnapshot.bench_count, 1);
  assert(nonfixedSnapshot.shop_material_hash && nonfixedSnapshot.board_bench_material_hash);
  assert(!getRuntimeServiceState().response_task?.response_task_id);

  setRuntimeServiceState(runtimeState(targetContext));
  detectRuntimeSemanticEvents(baselineState, { match_context: targetContext, source: "verify_fixed_baseline" });
  const fixedEvents = detectRuntimeSemanticEvents(liveState({
    stageRound: "2-5",
    board: [{ name: "亚托克斯", cost: 1, star: 1 }],
    bench: [{ name: "阿卡丽", cost: 2, star: 1 }],
    shop: [{ name: "阿卡丽", cost: 2, star: 1 }, { name: "贾克斯", cost: 2, star: 1 }],
  }), { match_context: targetContext, source: "verify_fixed_material_consumption" });
  assert.equal(fixedEvents.length, 1, "2-5 must recover the one pending 2-2 strategic answer");
  const fixedEvent = fixedEvents[0];
  assert.equal(fixedEvent.fixed_checkpoint_id, "direction_exploration");
  assert.equal(fixedEvent.fixed_checkpoint_stage_round, "2-2");
  assert.equal(fixedEvent.decision_trigger_id, "lineup_convergence_checkpoint");
  assert(fixedEvent.current_hash);
  assert.equal(fixedEvent.strategic_obligation?.latest_checkpoint_id, "direction_exploration");

  const directIntentContext = {
    ...targetContext,
    recent_user_messages: [{
      text: "我想改玩幻灵战队，这把接下来怎么玩？",
      mode: "cruise",
      stage_round: "2-5",
      intent_tags: ["lineup_intent"],
      response_task_id: "verify-direct-user-task",
      interaction_id: "verify-direct-user-task",
    }],
  };
  setRuntimeServiceState({ ...getRuntimeServiceState(), match_context: directIntentContext });
  const catchupEvents = detectRuntimeSemanticEvents(liveState({ stageRound: "2-7" }), {
    match_context: directIntentContext,
    source: "verify_direct_intent_context_only",
  });
  assert.equal(catchupEvents.length, 1, "the pending fixed obligation must remain available after a direct user turn");
  assert.equal(catchupEvents[0].fixed_checkpoint_id, "pre_3_2_direction_preparation");
  assert(catchupEvents[0].strategic_obligation?.required_checkpoint_ids?.includes("direction_exploration"),
    "the newer 2-7 checkpoint must carry the unresolved 2-2 obligation in its merged same-block contract");
  assert(!catchupEvents.some((event) => event.type === "latest_user_intent_changed"), "user context must not create a sibling automatic event");
  assert.equal(getRuntimeServiceState().match_context.recent_user_messages.at(-1)?.response_task_id, "verify-direct-user-task");

  setRuntimeServiceState(runtimeState(targetContext));
  const choiceWindowEvent = {
    type: "shop_decision_context_changed",
    layer: "decision_signal",
    semantic_key: "shop_decision:2-1:test",
    advice_eligible: true,
    stage_round: "2-1",
    decision_trigger_id: "shop_hold_sell_interest",
  };
  const choiceGate = shouldStartAdviceForRuntimeEvent(choiceWindowEvent, liveState({ stageRound: "2-1" }));
  assert.equal(choiceGate.ok, false);
  assert.equal(choiceGate.reason, "only_fixed_checkpoint_or_explicit_card_action_opens_host_answer");
  const contractOwnedChoiceGate = shouldStartAdviceForRuntimeEvent({
    type: "stage_round_changed",
    layer: "decision_signal",
    semantic_key: "stage_round:2-1:contract-owned-choice-window",
    advice_eligible: true,
    stage_round: "2-1",
  }, liveState({ stageRound: "2-1" }));
  assert.equal(contractOwnedChoiceGate.ok, false);
  assert.equal(contractOwnedChoiceGate.reason, "only_fixed_checkpoint_or_explicit_card_action_opens_host_answer");

  setRuntimeServiceState({
    ...runtimeState(targetContext),
    runtime_event_advice: {
      handled: {},
      retry_pending: {},
      last_started_at: null,
      last_by_category: {
        shop_decision_context: { at: new Date().toISOString() },
      },
      last_by_trigger: {
        shop_hold_sell_interest: { at: new Date().toISOString(), event_key: "older-shop-event" },
      },
    },
  });
  const cooldownGate = shouldStartAdviceForRuntimeEvent({
    ...choiceWindowEvent,
    stage_round: "2-4",
    semantic_key: "shop_decision:2-4:cooldown",
  }, liveState({ stageRound: "2-4" }));
  assert.equal(cooldownGate.ok, false);
  assert(["only_fixed_checkpoint_or_explicit_card_action_opens_host_answer", "supporting_event_waits_for_fixed_checkpoint"].includes(cooldownGate.reason));

  const differentShopTriggerGate = shouldStartAdviceForRuntimeEvent({
    ...choiceWindowEvent,
    stage_round: "2-4",
    semantic_key: "shop_decision:2-4:different-trigger",
    decision_trigger_id: "shop_lock_decision",
  }, liveState({ stageRound: "2-4" }));
  assert.equal(differentShopTriggerGate.ok, false, "retired shop triggers must not reopen the automatic Host lane");

  setRuntimeServiceState(runtimeState(targetContext));
  const observingGate = shouldStartAdviceForRuntimeEvent({
    ...choiceWindowEvent,
    stage_round: "2-5",
    semantic_key: "shop_decision:2-5:observing",
  }, liveState({ stageRound: "2-5", status: 2 }));
  assert.equal(observingGate.ok, false);
  assert.equal(observingGate.reason, "non_self_current_view");

  const missingStageGate = shouldStartAdviceForRuntimeEvent({
    type: "early_direction_context_changed",
    advice_eligible: true,
    decision_trigger_id: "early_direction_conversation",
  }, liveState({ stageRound: null }));
  assert.equal(missingStageGate.ok, false, "non-durable proactive advice must not start without a stage");
  assert.equal(missingStageGate.reason, "stage_round_missing_for_non_durable_advice", "missing-stage proactive events must remain facts instead of opening a doomed Host task");

  setRuntimeServiceState(runtimeState(targetContext));
  const activeZeroHpGate = shouldStartAdviceForRuntimeEvent({
    ...choiceWindowEvent,
    stage_round: "2-3",
    semantic_key: "shop_decision:2-3:false-zero-hp",
  }, liveState({ stageRound: "2-3", hp: 0 }));
  assert.notEqual(activeZeroHpGate.reason, "match_eliminated", "HP 0 without explicit end evidence must not suppress active-match coaching");

  setRuntimeServiceState(runtimeState(targetContext));
  const eliminatedGate = shouldStartAdviceForRuntimeEvent({
    ...choiceWindowEvent,
    stage_round: "5-5",
    semantic_key: "shop_decision:5-5:eliminated",
  }, liveState({ stageRound: "5-5", hp: 0, eliminationConfirmed: true }));
  assert.equal(eliminatedGate.ok, false);
  assert.equal(eliminatedGate.reason, "match_eliminated");

  const observingScore = scoreLiveState(liveState({ stageRound: "5-5", status: 2, hp: 20, gold: 40 }), {});
  assert.equal(observingScore.advice_tasks.length, 0, "the scorer must not create live-action advice for S=2/non-self view");
  assert.equal(observingScore.live_state_summary.proactive_suppression_reason, "non_self_current_view");
  const activeZeroHpScore = scoreLiveState(liveState({ stageRound: "2-3", status: 1, hp: 0, gold: 20 }), {});
  assert.notEqual(activeZeroHpScore.live_state_summary.proactive_suppression_reason, "match_eliminated");
  assert.equal(activeZeroHpScore.live_state_summary.hp, null, "untrusted active-match HP 0 must be exposed as missing to strategy scoring");
  const activeNegativeHpScore = scoreLiveState(liveState({ stageRound: "2-3", status: 1, hp: -1, gold: 20 }), {});
  assert.equal(activeNegativeHpScore.live_state_summary.hp, null, "negative active-match HP must remain missing to strategy scoring");
  const whitespaceEconomyScore = scoreLiveState(liveState({ stageRound: "2-3", status: 1, hp: " \t ", gold: " \n " }), {});
  assert.equal(whitespaceEconomyScore.live_state_summary.hp, null, "whitespace HP must remain missing to strategy scoring");
  assert.equal(whitespaceEconomyScore.live_state_summary.gold, null, "whitespace gold must remain missing to strategy scoring");
  const realZeroGoldScore = scoreLiveState(liveState({ stageRound: "2-3", status: 1, hp: 87, gold: 0 }), {});
  assert.equal(realZeroGoldScore.live_state_summary.gold, 0, "real numeric zero gold must survive strategy scoring");
  const eliminatedScore = scoreLiveState(liveState({ stageRound: "7-1", status: 1, hp: 0, gold: 10, eliminationConfirmed: true }), {});
  assert.equal(eliminatedScore.advice_tasks.length, 0, "the scorer must not create postgame advice at zero HP");
  assert.equal(eliminatedScore.live_state_summary.proactive_suppression_reason, "match_eliminated");

  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "2-6",
    eventType: "shop_decision_context_changed",
    requestedStateFingerprint: "before",
    currentStateFingerprint: "after",
  }), false, "ordinary proactive advice must not cross a stage boundary");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "2-5",
    eventType: "shop_decision_context_changed",
    requestedStateFingerprint: "before",
    currentStateFingerprint: "after",
  }), false, "ordinary proactive advice must not display after its live-state fingerprint changes");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-1",
    currentStageRound: "2-2",
    eventType: "confirmed_choices_changed",
    requestedStateFingerprint: "before",
    currentStateFingerprint: "after",
  }), true, "confirmed choice follow-up may survive a stage transition because the fact is durable");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "non-fixed shop, board, bench, pair, and key-unit changes remain fact-only while existing fixed strategic debt may catch up",
      "fixed checkpoint owns one merged strategic obligation",
      "direct intent remains context-only while an existing fixed obligation remains deliverable",
      "choice windows do not restore retired automatic shop or tempo Host lanes",
      "retired shop and tempo triggers cannot reopen the Host lane",
      "non-self and eliminated states suppress proactive advice",
      "automatic advice uses decision-scoped freshness instead of whole-state churn",
    ],
  }, null, 2));
}

main();
