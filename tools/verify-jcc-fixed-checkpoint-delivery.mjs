#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  automaticRuntimeEventFreshness,
  strategicCheckpointDeliveryDecision,
  runtimeHasCurrentStrategicCheckpointOwner,
  queuedStrategicObligationAdviceEvent,
  strategicDeliveryAuthorization,
  fixedCheckpointScheduleDecision,
  effectiveLastDeliveredFixedCheckpointId,
  effectiveScheduledFixedCheckpointId,
  clearScheduledFixedCheckpointForEvent,
  markFixedCheckpointDelivered,
  buildProactiveCoachContentAgenda,
  detectRuntimeSemanticEvents,
  runtimeProactiveDecisionTriggerPolicySnapshot,
  runtimeEventCanOpenHostAnswer,
  setRuntimeServiceState,
  getRuntimeServiceState,
  requeueStrategicRuntimeTask,
  rememberStrategicObligationEvent,
  shouldStartAdviceForRuntimeEvent,
} from "../ui/electron/runtime-service.js";
import {
  cruiseCheckpointForStage,
  cruiseRecoveryPolicyForStage,
  isCruiseFixedCheckpointStage,
} from "../ui/electron/cruise-checkpoint-agenda.js";
import {
  createStrategicObligationQueueState,
  enqueueStrategicObligation,
  strategicObligationDeliveryEnvelope,
} from "../ui/electron/cruise-strategic-obligation-queue.js";

const capCheckpoint = cruiseCheckpointForStage("5-3");
assert.equal(capCheckpoint?.checkpoint_id, "second_ceiling_floor_review");
assert.equal(isCruiseFixedCheckpointStage("2-5"), false,
  "2-5 is a recovery stage and must not create an independent fixed-checkpoint owner");
assert.deepEqual(cruiseRecoveryPolicyForStage("2-5")?.recovers_checkpoint_ids, ["direction_exploration"]);

const capAgenda = buildProactiveCoachContentAgenda(
  {
    type: "line_decision_context_changed",
    stage_round: "5-3",
    decision_trigger_id: "cap_gap_check",
    fixed_checkpoint_id: "second_ceiling_floor_review",
    semantic_labels: ["cap_floor_review"],
    advice_eligible: true,
  },
  { category: "line_decision_context", fixed_checkpoint_id: "second_ceiling_floor_review" },
  { phase: { stage_round: "5-3" } },
);
assert.equal(capAgenda.fixed_checkpoint?.checkpoint_id, capCheckpoint.checkpoint_id);
assert.equal(capAgenda.primary_decision, capCheckpoint.answer_contract.primary_decision);
assert(capAgenda.required_decisions.includes("remaining_cap_gap"));
assert.match(capAgenda.next_checkpoint, /5-7/);

const delayedCapFreshness = automaticRuntimeEventFreshness({
  requestedStageRound: "5-1",
  currentStageRound: "5-3",
  eventType: "line_decision_context_changed",
  eventCategory: "line_decision_context",
  decisionTriggerId: "cap_gap_check",
});
assert.equal(delayedCapFreshness.fresh, true);
assert.equal(delayedCapFreshness.policy.scope, "key_coaching_obligation");

const delayedDirectionFreshness = automaticRuntimeEventFreshness({
  requestedStageRound: "3-3",
  currentStageRound: "3-5",
  eventType: "line_decision_context_changed",
  eventCategory: "line_decision_context",
  decisionTriggerId: "direction_commit_or_exit",
});
assert.equal(delayedDirectionFreshness.fresh, true);

const staleCheckpoint = strategicCheckpointDeliveryDecision({
  requested_stage_round: "2-2",
  runtime_event_context: {
    decision_trigger_id: "lineup_convergence_checkpoint",
    fixed_checkpoint_id: "direction_exploration",
  },
}, "2-5");
assert.equal(staleCheckpoint.publish, true, "the 2-2 direction checkpoint remains eligible for catch-up through 2-5");
assert.equal(staleCheckpoint.reason, "fixed_checkpoint_still_current_or_catchup_window",
  "2-5 must be treated as a recovery window for the still-current 2-2 obligation, not as another fixed checkpoint");

const lateExplorationCatchup = strategicCheckpointDeliveryDecision({
  requested_stage_round: "2-2",
  runtime_event_context: {
    decision_trigger_id: "lineup_convergence_checkpoint",
    fixed_checkpoint_id: "direction_exploration",
  },
}, "2-7");
assert.equal(lateExplorationCatchup.publish, true, "the 2-2 direction checkpoint remains eligible through the 2-7 preparation window");

const supersededExploration = strategicCheckpointDeliveryDecision({
  requested_stage_round: "2-2",
  runtime_event_context: {
    decision_trigger_id: "lineup_convergence_checkpoint",
    fixed_checkpoint_id: "direction_exploration",
  },
}, "3-3");
assert.equal(supersededExploration.publish, false, "3-3 narrowing supersedes an unresolved 2-2 direction obligation");
assert.equal(supersededExploration.reason, "fixed_checkpoint_superseded_by_later_same_block_checkpoint");

const currentCheckpoint = strategicCheckpointDeliveryDecision({
  requested_stage_round: "2-2",
  runtime_event_context: {
    decision_trigger_id: "lineup_convergence_checkpoint",
    fixed_checkpoint_id: "direction_exploration",
  },
}, "2-3");
assert.equal(currentCheckpoint.publish, true, "a delayed checkpoint may catch up before the next fixed checkpoint");

const missingCheckpoint = fixedCheckpointScheduleDecision({
  currentStageRound: "3-3",
  lastEmittedCheckpointId: "pre_3_2_direction_preparation",
  deliveredCheckpointIds: [
    "direction_exploration",
    "pre_3_2_direction_preparation",
  ],
});
assert.equal(missingCheckpoint.due, true, "a fixed checkpoint remains due until its strategic signal is emitted");
assert.deepEqual(missingCheckpoint.missed_checkpoint_ids, [], "adjacent fixed checkpoints do not invent an intermediate debt");

const recoveredCheckpointDebt = fixedCheckpointScheduleDecision({
  currentStageRound: "3-3",
  lastEmittedCheckpointId: "pre_3_2_direction_preparation",
  deliveredCheckpointIds: [],
});
assert.deepEqual(
  recoveredCheckpointDebt.missed_checkpoint_ids,
  ["direction_exploration"],
  "an emitted-only legacy marker must not erase earlier strategic obligations without delivery receipts",
);

const completedExplorationAtRecoveryStage = fixedCheckpointScheduleDecision({
  currentStageRound: "2-5",
  deliveredCheckpointIds: ["direction_exploration"],
});
assert.equal(completedExplorationAtRecoveryStage.due, false,
  "2-5 must be a silent no-op after the complete 2-2 exploration obligation is delivered");
assert.deepEqual(completedExplorationAtRecoveryStage.obligation_checkpoint_ids, [],
  "2-5 must not invent a new obligation after 2-2 is complete");

const pendingExplorationAtRecoveryStage = fixedCheckpointScheduleDecision({
  currentStageRound: "2-5",
  deliveredCheckpointIds: [],
});
assert.equal(pendingExplorationAtRecoveryStage.due, true,
  "2-5 must recover an undelivered 2-2 exploration obligation using the latest state");
assert.deepEqual(pendingExplorationAtRecoveryStage.obligation_checkpoint_ids, ["direction_exploration"]);
assert.equal(pendingExplorationAtRecoveryStage.checkpoint?.checkpoint_id, "direction_exploration",
  "the recovered task must retain the 2-2 obligation identity instead of creating a 2-5 identity");

const skippedObservationDebt = fixedCheckpointScheduleDecision({
  currentStageRound: "2-6",
  deliveredCheckpointIds: [],
});
assert.equal(skippedObservationDebt.due, true, "sampling that skips exact checkpoint frames must still recover due strategic debt");
assert.deepEqual(
  skippedObservationDebt.obligation_checkpoint_ids,
  ["direction_exploration"],
  "2-6 is not a new automatic checkpoint; it only carries the undelivered 2-2 obligation using fresh state",
);

const inFlightCheckpoint = fixedCheckpointScheduleDecision({
  currentStageRound: "2-2",
  lastEmittedCheckpointId: null,
  lastScheduledCheckpointId: "direction_exploration",
});
assert.equal(inFlightCheckpoint.due, false,
  "a fixed checkpoint already in flight must not create duplicate Host tasks on every observer tick");
assert.equal(inFlightCheckpoint.scheduled, true);

const gateEvent = {
  type: "line_decision_context_changed",
  stage_round: "5-3",
  decision_trigger_id: "cap_gap_check",
  fixed_checkpoint_id: "second_ceiling_floor_review",
  fixed_checkpoint_stage_round: "5-3",
  semantic_key: "verification-new-cap-event",
  current_hash: "verification-new-action",
  advice_eligible: true,
  match_session_id: "verification-match",
};
const queuedState = enqueueStrategicObligation(
  createStrategicObligationQueueState(),
  gateEvent,
);
setRuntimeServiceState({
  runtime_event_detector: {
    last_scheduled_fixed_checkpoint_id: "direction_exploration",
    last_emitted_fixed_checkpoint_id: null,
  },
});
const failedCheckpointEvent = {
  decision_trigger_id: "lineup_convergence_checkpoint",
  fixed_checkpoint_id: "direction_exploration",
};
assert.equal(clearScheduledFixedCheckpointForEvent(failedCheckpointEvent, "host_request_failed"), true,
  "a failed fixed checkpoint must release its in-flight schedule marker");
assert.equal(fixedCheckpointScheduleDecision({
  currentStageRound: "2-2",
  lastEmittedCheckpointId: null,
  lastScheduledCheckpointId: null,
}).due, true,
"after failure the same fixed checkpoint must be eligible for a retry");
assert.equal(markFixedCheckpointDelivered(failedCheckpointEvent, "2-2"), false,
  "a checkpoint without an exact completion receipt must remain pending");
assert.equal(fixedCheckpointScheduleDecision({
  currentStageRound: "2-2",
  lastEmittedCheckpointId: null,
  lastScheduledCheckpointId: null,
}).due, true,
"a checkpoint without an exact completion receipt must remain retryable");

const recoverySourceEvent = {
  type: "line_decision_context_changed",
  stage_round: "2-2",
  fixed_checkpoint_id: "direction_exploration",
  fixed_checkpoint_stage_round: "2-2",
  decision_trigger_id: "lineup_convergence_checkpoint",
  semantic_key: "verification-direction-recovery",
  current_hash: "verification-direction-recovery-action",
  advice_eligible: true,
  match_session_id: "verification-direction-recovery-match",
};
const recoveryQueue = enqueueStrategicObligation(
  createStrategicObligationQueueState(),
  recoverySourceEvent,
);
setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: recoverySourceEvent.match_session_id },
  response_task: null,
  runtime_strategic_obligations: recoveryQueue,
  runtime_event_advice: { handled: {}, retry_pending: {}, last_by_category: {}, last_by_trigger: {} },
});
const recoveryEvent = queuedStrategicObligationAdviceEvent({ phase: { stage_round: "2-5" } });
assert(recoveryEvent, "2-5 must materialize the pending 2-2 obligation from the persistent queue");
assert.equal(strategicDeliveryAuthorization(recoveryEvent, "2-5").kind, "configured_recovery_stage");
assert.equal(shouldStartAdviceForRuntimeEvent(recoveryEvent, {
  phase: { stage_round: "2-5" },
  economy: { hp: 100, gold: 30, level: 5, xp: 0 },
}).ok, true, "2-5 recovery must be admitted from the configured recovery policy");
assert.equal(queuedStrategicObligationAdviceEvent({ phase: { stage_round: "2-6" } }), null,
  "2-6 must not create an unconfigured recovery turn");
assert.equal(strategicDeliveryAuthorization({ ...recoveryEvent, stage_round: "2-6" }, "2-6").ok, false,
  "an event boolean cannot forge recovery at an unregistered stage");

const oneCostMatchId = "verification-one-cost-window-match";
const oneCostTarget = {
  candidate_id: "lineup:one-cost",
  name: "一费追三阵容",
  authority: "durable_target_plan",
  reroll_cost: 1,
  main_carry: { champion_id: "unit:one", champion_name: "一费主C", cost: 1 },
};
setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: oneCostMatchId },
  match_context: { target_plan: oneCostTarget },
  response_task: null,
  runtime_event_detector: { delivered_fixed_checkpoint_ids: ["direction_exploration"] },
  runtime_strategic_obligations: createStrategicObligationQueueState(),
  runtime_event_advice: { handled: {}, retry_pending: {}, last_by_category: {}, last_by_trigger: {} },
});
const oneCostEvents = detectRuntimeSemanticEvents({
  phase: { stage_round: "2-5", status: 1 },
  economy: { hp: 88, gold: 48, level: 4, xp: 8 },
  board: { units: [] },
  bench: { units: [] },
}, { match_context: { target_plan: oneCostTarget }, source: "verify_one_cost_window" });
const oneCostEvent = oneCostEvents.find((event) => event.fixed_checkpoint_id === "one_cost_reroll_window");
assert(oneCostEvent, "2-5 must create the registered conditional obligation for a durable one-cost reroll target");
assert.equal(strategicDeliveryAuthorization(oneCostEvent, "2-5").kind, "current_conditional_checkpoint");
assert(oneCostEvent.required_decisions.includes("fifty_gold_slow_roll_and_recovery_posture"));
const oneCostQueueRevision = getRuntimeServiceState().runtime_strategic_obligations.revision;
detectRuntimeSemanticEvents({
  phase: { stage_round: "2-5", status: 1 },
  economy: { hp: 88, gold: 48, level: 4, xp: 8 },
  board: { units: [] },
  bench: { units: [] },
}, { match_context: { target_plan: oneCostTarget }, source: "verify_one_cost_window_repeat" });
assert.equal(getRuntimeServiceState().runtime_strategic_obligations.revision, oneCostQueueRevision,
  "repeated observations must reuse one conditional obligation instead of creating duplicates");

setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: "verification-non-one-cost-window-match" },
  match_context: { target_plan: { ...oneCostTarget, reroll_cost: 4, main_carry: { cost: 4 }, candidate_id: "lineup:four-cost" } },
  response_task: null,
  runtime_event_detector: { delivered_fixed_checkpoint_ids: ["direction_exploration"] },
  runtime_strategic_obligations: createStrategicObligationQueueState(),
  runtime_event_advice: { handled: {}, retry_pending: {}, last_by_category: {}, last_by_trigger: {} },
});
const nonOneCostEvents = detectRuntimeSemanticEvents({
  phase: { stage_round: "2-5", status: 1 },
  economy: { hp: 88, gold: 48, level: 4, xp: 8 },
}, { match_context: getRuntimeServiceState().match_context, source: "verify_non_one_cost_window" });
assert(!nonOneCostEvents.some((event) => event.fixed_checkpoint_id === "one_cost_reroll_window"),
  "2-5 must stay silent for targets that are not one-cost reroll lines");

const sameBlockCatchupSource = {
  type: "line_decision_context_changed",
  stage_round: "3-3",
  fixed_checkpoint_id: "post_3_2_narrowing",
  fixed_checkpoint_stage_round: "3-3",
  decision_trigger_id: "lineup_convergence_checkpoint",
  current_hash: "verification-new-direction-action",
  advice_eligible: true,
  match_session_id: "verification-same-block-catchup-match",
};
let sameBlockQueue = enqueueStrategicObligation(
  createStrategicObligationQueueState(),
  {
    ...sameBlockCatchupSource,
    stage_round: "2-2",
    fixed_checkpoint_id: "direction_exploration",
    fixed_checkpoint_stage_round: "2-2",
    current_hash: "verification-old-direction-action",
  },
);
const sameBlockSourceQueueRevision = sameBlockQueue.revision;
sameBlockQueue = enqueueStrategicObligation(sameBlockQueue, sameBlockCatchupSource);
setRuntimeServiceState({
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: sameBlockCatchupSource.match_session_id },
  response_task: null,
  runtime_strategic_obligations: sameBlockQueue,
  runtime_event_advice: { handled: {}, retry_pending: {}, last_by_category: {}, last_by_trigger: {} },
});
const sameBlockCatchupEvent = {
  ...sameBlockCatchupSource,
  stage_round: "3-3",
  fixed_checkpoint_id: "direction_exploration",
  fixed_checkpoint_stage_round: "2-2",
  current_hash: "verification-old-direction-action",
  strategic_obligation: { queue_revision: sameBlockSourceQueueRevision },
  deferred_after_occupied_lane: true,
  retry_of_event_key: "verification-old-direction-event",
};
assert.equal(
  strategicDeliveryAuthorization(sameBlockCatchupEvent, "3-3").kind,
  "same_block_checkpoint_catchup",
  "a deferred older checkpoint must be authorized generically after a later checkpoint takes over the same strategic block",
);
assert.equal(
  shouldStartAdviceForRuntimeEvent(sameBlockCatchupEvent, { phase: { stage_round: "3-3" }, economy: { hp: 80, gold: 40 } }).ok,
  true,
  "same-block catchup must remain a Host-admissible strategic obligation rather than disappearing after the checkpoint advances",
);

setRuntimeServiceState({
  runtime_event_detector: {
    last_emitted_fixed_checkpoint_id: "direction_exploration",
    last_delivered_fixed_checkpoint_id: null,
  },
  runtime_event_advice: {
    handled: {
      "legacy-failed-checkpoint": {
        status: "failed",
        event: failedCheckpointEvent,
      },
    },
    retry_pending: {},
  },
});
assert.equal(effectiveLastDeliveredFixedCheckpointId(), null,
  "legacy emitted marker from a failed checkpoint must be migrated back to retryable state");

setRuntimeServiceState({
  runtime_event_detector: {
    last_emitted_fixed_checkpoint_id: "direction_exploration",
    last_delivered_fixed_checkpoint_id: null,
  },
  runtime_event_advice: {
    handled: {
      "legacy-completed-checkpoint": {
        status: "completed",
        event: failedCheckpointEvent,
      },
    },
    retry_pending: {},
  },
});
assert.equal(effectiveLastDeliveredFixedCheckpointId(), "direction_exploration",
  "legacy completed checkpoint marker must remain delivered after migration");

setRuntimeServiceState({
  runtime_event_detector: {
    last_scheduled_fixed_checkpoint_id: "direction_exploration",
  },
  runtime_event_advice: {
    handled: {},
    retry_pending: {},
  },
});
assert.equal(effectiveScheduledFixedCheckpointId(), null,
  "an orphaned scheduled marker must not suppress retry after a Runtime crash");

setRuntimeServiceState({
  runtime_event_detector: {
    last_scheduled_fixed_checkpoint_id: "direction_exploration",
  },
  runtime_event_advice: {
    handled: {
      "active-checkpoint": {
        status: "preparing",
        event: failedCheckpointEvent,
      },
    },
    retry_pending: {},
  },
});
assert.equal(effectiveScheduledFixedCheckpointId(), "direction_exploration",
  "an active scheduled checkpoint must continue suppressing duplicate Host tasks");

setRuntimeServiceState({
  response_task: {
    origin: "runtime_event",
    status: "response_pending",
    runtime_event_context: {
      decision_trigger_id: "lineup_convergence_checkpoint",
      fixed_checkpoint_id: "direction_exploration",
      stage_round: "2-2",
    },
  },
});
assert.equal(runtimeHasCurrentStrategicCheckpointOwner("2-5"), false,
  "a delayed strategic response from an earlier checkpoint must not block the current checkpoint");
assert.equal(runtimeHasCurrentStrategicCheckpointOwner("2-2"), true,
  "an in-flight strategic response must reserve its own checkpoint");

const commitAgenda = buildProactiveCoachContentAgenda(
  {
    type: "line_decision_context_changed",
    stage_round: "3-7",
    decision_trigger_id: "direction_commit_or_exit",
    fixed_checkpoint_id: "pre_4_stage_fork",
    semantic_labels: ["provisional_commit"],
    advice_eligible: true,
  },
  { category: "line_decision_context", fixed_checkpoint_id: "pre_4_stage_fork" },
  { phase: { stage_round: "3-7" } },
);
assert.equal(commitAgenda.fixed_checkpoint?.checkpoint_id, "pre_4_stage_fork");
assert.equal(commitAgenda.primary_decision, "pre_4_stage_direction_fork");
assert(commitAgenda.required_decisions.includes("current_mainline_and_backup"));
assert(commitAgenda.required_decisions.includes("level_8_at_4_1_vs_4_2_cost_and_contest_tradeoff"));

const formationAgenda = buildProactiveCoachContentAgenda(
  {
    type: "stage_round_changed",
    stage_round: "4-5",
    decision_trigger_id: "lineup_convergence_checkpoint",
    fixed_checkpoint_id: "formation_readiness_review",
    semantic_labels: ["formation_readiness"],
    advice_eligible: true,
  },
  { category: "line_decision_context", fixed_checkpoint_id: "formation_readiness_review" },
  { phase: { stage_round: "4-5" } },
);
assert.equal(formationAgenda.fixed_checkpoint?.checkpoint_id, "formation_readiness_review");
assert.equal(formationAgenda.primary_decision, "formation_readiness_and_directionality");
assert(formationAgenda.required_decisions.includes("compare_level_8_quality_against_level_9_timing"));
assert.match(formationAgenda.output_contract.join(" "), /formation-readiness checkpoint/);

const stageFourPreparationAgenda = buildProactiveCoachContentAgenda(
  {
    type: "stage_round_changed",
    stage_round: "3-7",
    decision_trigger_id: "lineup_convergence_checkpoint",
    fixed_checkpoint_id: "pre_4_stage_fork",
    semantic_labels: ["provisional_commit"],
    advice_eligible: true,
  },
  { category: "line_decision_context", fixed_checkpoint_id: "pre_4_stage_fork" },
  { phase: { stage_round: "3-7" } },
);
assert.equal(stageFourPreparationAgenda.fixed_checkpoint?.checkpoint_id, "pre_4_stage_fork");
assert(stageFourPreparationAgenda.required_decisions.includes("current_item_holders_and_transfer_order"));
assert(stageFourPreparationAgenda.required_decisions.includes("target_progress_and_transition_replacement_order"));
assert.match(stageFourPreparationAgenda.output_contract.join(" "), /completed-item holders/);

const delayedExplorationAgenda = buildProactiveCoachContentAgenda(
  {
    type: "line_decision_context_changed",
    stage_round: "2-3",
    decision_trigger_id: "lineup_convergence_checkpoint",
    fixed_checkpoint_id: "direction_exploration",
    semantic_labels: ["explore_candidates", "deferred_after_occupied_lane"],
    advice_eligible: true,
  },
  { category: "line_decision_context" },
  { phase: { stage_round: "2-3" } },
);
assert.equal(delayedExplorationAgenda.fixed_checkpoint?.checkpoint_id, "direction_exploration");
assert.equal(delayedExplorationAgenda.fixed_checkpoint?.checkpoint_stage_round, "2-2");
assert(delayedExplorationAgenda.required_decisions.includes("complete_candidate_rosters"));

const switchedCapAgenda = buildProactiveCoachContentAgenda(
  {
    type: "line_decision_context_changed",
    stage_round: "5-3",
    decision_trigger_id: "cap_gap_check",
    fixed_checkpoint_id: "second_ceiling_floor_review",
    semantic_labels: ["cap_floor_review", "current_checkpoint"],
    advice_eligible: true,
  },
  { category: "line_decision_context", fixed_checkpoint_id: "second_ceiling_floor_review" },
  { phase: { stage_round: "5-3" } },
);
assert.equal(switchedCapAgenda.fixed_checkpoint?.checkpoint_id, "second_ceiling_floor_review");
assert.equal(switchedCapAgenda.fixed_checkpoint?.checkpoint_stage_round, "5-3");
assert(switchedCapAgenda.required_decisions.includes("remaining_cap_gap"));

const policies = runtimeProactiveDecisionTriggerPolicySnapshot();
assert.equal(policies.cap_gap_check.event_type, "line_decision_context_changed");
assert.deepEqual(Object.keys(policies).sort(), [
  "cap_gap_check",
  "direction_commit_or_exit",
  "lineup_convergence_checkpoint",
].sort(), "only fixed strategic triggers may open the runtime Host lane");

setRuntimeServiceState({
  active_mode: "cruise",
  match_session: {
    status: "active",
    match_session_id: "verification-match",
  },
  response_task: null,
  runtime_strategic_obligations: queuedState,
  runtime_event_advice: {
    last_started_at: new Date(Date.now() - 1000).toISOString(),
    last_started_stage_round: "5-1",
    last_by_trigger: {
      cap_gap_check: {
        at: new Date(Date.now() - 1000).toISOString(),
        event_key: "verification-old-cap-event",
      },
    },
    last_by_category: {},
    handled: {},
    retry_pending: {},
  },
});

const queuedGateEvent = queuedStrategicObligationAdviceEvent({ phase: { stage_round: "5-3" } });
assert(queuedGateEvent, "the current fixed checkpoint must be emitted from the persisted strategic queue");

const gate = shouldStartAdviceForRuntimeEvent(
  queuedGateEvent,
  {
    phase: { stage_round: "5-3" },
    economy: { hp: 55, gold: 60 },
  },
);
assert.equal(gate.ok, true, JSON.stringify(gate));

const bogusCatchup = shouldStartAdviceForRuntimeEvent(
  {
    ...gateEvent,
    strategic_obligation: queuedGateEvent.strategic_obligation,
    stage_round: "5-5",
    fixed_checkpoint_id: "unknown-checkpoint",
    existing_strategic_obligation_delivery: true,
  },
  { phase: { stage_round: "5-5" }, economy: { hp: 55, gold: 60 } },
);
assert.equal(bogusCatchup.ok, false, "unbound strategic recovery events must remain closed");

const staleIdentity = shouldStartAdviceForRuntimeEvent(
  {
    ...gateEvent,
    strategic_obligation: queuedGateEvent.strategic_obligation,
    match_session_id: "different-match",
    current_hash: "different-action",
  },
  { phase: { stage_round: "5-3" }, economy: { hp: 55, gold: 60 } },
);
assert.equal(staleIdentity.ok, false, "strategic events from another match or action fingerprint must remain closed");
assert.equal(runtimeEventCanOpenHostAnswer(staleIdentity.event || {
  ...queuedGateEvent,
  match_session_id: "different-match",
  current_hash: "different-action",
}), false, "retry persistence must use the same bound strategic admission rule");

const lifecycleEvent = (stage) => ({
  stage_round: stage,
  fixed_checkpoint_id: cruiseCheckpointForStage(stage).checkpoint_id,
  decision_trigger_id: "lineup_convergence_checkpoint",
});
let lifecycleQueue = enqueueStrategicObligation(createStrategicObligationQueueState(), lifecycleEvent("3-3"));
lifecycleQueue = enqueueStrategicObligation(lifecycleQueue, lifecycleEvent("3-5"));
const oldDelivery = strategicObligationDeliveryEnvelope(lifecycleQueue);
lifecycleQueue = enqueueStrategicObligation(lifecycleQueue, lifecycleEvent("4-3"));
setRuntimeServiceState({
  runtime_strategic_obligations: lifecycleQueue,
  runtime_event_detector: { last_scheduled_fixed_checkpoint_id: "final_lineup_confirmation" },
});
assert.equal(markFixedCheckpointDelivered({
  ...lifecycleEvent("3-5"), strategic_obligation: oldDelivery,
}, "4-3"), true, "an unchanged supporting block may complete independently");
const afterCompositeAck = getRuntimeServiceState();
assert(afterCompositeAck.runtime_strategic_obligations.obligations_by_block.lineup_direction_commitment);
assert(!afterCompositeAck.runtime_strategic_obligations.obligations_by_block.formation_readiness_and_execution);
assert.deepEqual(afterCompositeAck.runtime_event_detector.delivered_fixed_checkpoint_ids, ["three_cost_reroll_or_operation"]);
assert.equal(afterCompositeAck.runtime_event_detector.last_scheduled_fixed_checkpoint_id, "final_lineup_confirmation");
assert.equal(markFixedCheckpointDelivered({
  ...lifecycleEvent("3-5"), strategic_obligation: oldDelivery,
}, "4-3"), false, "duplicate/stale ACK must not advance detector or obligation state");
assert.deepEqual(getRuntimeServiceState().runtime_strategic_obligations, afterCompositeAck.runtime_strategic_obligations);
assert.deepEqual(getRuntimeServiceState().runtime_event_detector, afterCompositeAck.runtime_event_detector);
const currentDelivery = strategicObligationDeliveryEnvelope(afterCompositeAck.runtime_strategic_obligations);
assert.equal(markFixedCheckpointDelivered({
  ...lifecycleEvent("4-3"), strategic_obligation: currentDelivery,
}, "4-3"), true);
assert.equal(Object.keys(getRuntimeServiceState().runtime_strategic_obligations.obligations_by_block).length, 0);
const deliveredQueueRevision = getRuntimeServiceState().runtime_strategic_obligations.revision;
rememberStrategicObligationEvent(lifecycleEvent("4-3"));
assert.equal(getRuntimeServiceState().runtime_strategic_obligations.revision, deliveredQueueRevision,
  "a late retry must not resurrect an ACKed checkpoint");

for (const [choiceStage, checkpointStage] of [["3-2", "3-3"], ["4-2", "4-3"]]) {
  const event = { ...lifecycleEvent(checkpointStage), match_session_id: "verification-match" };
  const pendingQueue = enqueueStrategicObligation(createStrategicObligationQueueState(), event);
  const envelope = strategicObligationDeliveryEnvelope(pendingQueue);
  setRuntimeServiceState({
    match_session: { status: "active", match_session_id: "verification-match" },
    runtime_strategic_obligations: pendingQueue,
    runtime_event_detector: {},
    runtime_event_advice: { handled: {}, retry_pending: {}, last_by_category: {}, last_by_trigger: {} },
  });
  const ownerTask = {
    response_task_id: "owner-attempt", match_session_id: "verification-match",
    requested_at: "2000-01-01T00:00:00.000Z",
    requested_stage_round: choiceStage,
    runtime_event_context: { ...event, strategic_obligation: envelope },
  };
  const beforeRetry = getRuntimeServiceState().runtime_strategic_obligations;
  for (const reason of ["user_message_received", "strategic_host_timeout", "ordinary_ttl_expired", "user_stop_response"]) {
    assert.equal(requeueStrategicRuntimeTask(ownerTask, reason), true);
    assert.deepEqual(getRuntimeServiceState().runtime_strategic_obligations, beforeRetry,
      "attempt expiry/preemption must not reduce or revise durable obligations");
    assert.deepEqual(getRuntimeServiceState().runtime_event_advice.retry_pending, {},
      "the response owner must not create a second retry queue");
  }
  assert.equal(requeueStrategicRuntimeTask({ ...ownerTask, match_session_id: "old-match" }, "late_failure"), false);
  assert.equal(requeueStrategicRuntimeTask({ match_session_id: "verification-match" }, "unrelated_user_failure"), false);
  assert.equal(rememberStrategicObligationEvent({ ...event, match_session_id: "old-match" }), null);
  assert.deepEqual(getRuntimeServiceState().runtime_strategic_obligations, beforeRetry);
}

console.log(JSON.stringify({
  ok: true,
  fixed_checkpoint: capCheckpoint.checkpoint_id,
  delayed_cap_requeues: true,
  delayed_direction_requeues: true,
  fixed_checkpoint_cooldown_does_not_block_new_stage: true,
  strategic_answer_contract: true,
  direction_commit_uses_fixed_checkpoint_contract: true,
  delayed_checkpoint_contract_is_preserved: true,
  same_block_catchup_until_3_3: true,
  later_same_block_checkpoint_supersedes: true,
}, null, 2));
