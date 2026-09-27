#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildRuntimeEventFollowupAdviceTask,
  applyLifecycle,
  expireTasks,
  pipelineTaskIsPersistentStrategic,
  buildTaskContract,
  providerOwnsTaskExecution,
  pipelineTaskMayOpenHost,
  taskTtlSeconds,
} from "./run-jcc-cruise-runtime-pipeline.mjs";

const strategicEventContext = {
  event_key: "verify-direction-catchup",
  event_type: "line_decision_context_changed",
  event_category: "line_decision_context",
  decision_trigger_id: "lineup_convergence_checkpoint",
  stage_round: "2-5",
  fixed_checkpoint_id: "direction_exploration",
  fixed_checkpoint_stage_round: "2-2",
  semantic_labels: ["persistent_strategic_obligation_queue"],
  strategic_obligation: {
    queue_revision: 2,
    completion_receipts: [{ block_id: "lineup_direction", revision: 1, latest_checkpoint_id: "direction_exploration" }],
  },
  existing_strategic_obligation_delivery: true,
};

const sourceContext = { runtime_event_context: strategicEventContext };
const catchupTask = buildRuntimeEventFollowupAdviceTask(sourceContext, { phase: { stage_round: "2-5" } }, "2026-09-05T00:00:00.000Z");
assert(catchupTask, "a durable strategic obligation must materialize at its configured recovery stage");
assert.equal(pipelineTaskIsPersistentStrategic(catchupTask), true);
assert.equal(taskTtlSeconds(catchupTask, {}), null);
assert.equal(pipelineTaskMayOpenHost(catchupTask), true);
assert.equal(buildTaskContract(catchupTask).identity.stage_round, "2-5");
assert.equal(buildTaskContract(catchupTask).identity.task_identity, "direction_exploration");
assert.equal(buildTaskContract(catchupTask).lifecycle.ttl_policy, "retain_until_owner_settles");

const ordinaryStrategicTask = {
  task_id: "ordinary-strategic-without-queue",
  trigger_id: "runtime_event_followup",
  priority: "high",
  decision_trigger_id: "lineup_convergence_checkpoint",
  fixed_checkpoint_id: "direction_exploration",
  fixed_checkpoint_stage_round: "2-2",
  runtime_event_context: {
    decision_trigger_id: "lineup_convergence_checkpoint",
    fixed_checkpoint_id: "direction_exploration",
    stage_round: "2-2",
  },
};
assert.equal(pipelineTaskIsPersistentStrategic(ordinaryStrategicTask), false);
assert.equal(taskTtlSeconds(ordinaryStrategicTask, {}), 45);

const providerRunningTask = {
  task_id: "provider-running-task",
  trigger_id: "runtime_event_followup",
  event_key: "provider-running-event",
  stage_round: "3-2",
  status: "running",
  response_task_id: "provider-response-1",
  provider_awaiting_since: "2026-09-05T00:00:01.000Z",
  priority: "low",
};
assert.equal(providerOwnsTaskExecution(providerRunningTask), true);
assert.equal(taskTtlSeconds(providerRunningTask, {}), null,
  "a provider-running task must not be removed by ordinary queue TTL");
assert.equal(buildTaskContract(providerRunningTask).identity.stage_round, "3-2");
assert.equal(buildTaskContract(providerRunningTask).lifecycle.provider_execution.status, "running");

const identityLifecycle = {
  active_tasks: [],
  confirmed_tasks: [],
  skipped_tasks: [],
  expired_tasks: [],
  active_task_context: {},
  match_context: {},
  previous_advice_state: { emitted_tasks: [] },
  output_history: [],
};
const sameTriggerAtStageTwo = {
  task_id: "same-trigger-stage-two",
  trigger_id: "generic_strategy_task",
  stage_round: "2-5",
  priority: "medium",
  value_score: 0.8,
  confidence: 0.8,
  title: "stage two task",
  short_advice: "stage two",
  evidence: [],
  actions: [],
  semantic_labels: [],
};
const sameTriggerAtStageThree = {
  ...sameTriggerAtStageTwo,
  task_id: "same-trigger-stage-three",
  stage_round: "3-2",
  title: "stage three task",
  short_advice: "stage three",
};
applyLifecycle({
  lifecycle: identityLifecycle,
  score: { advice_tasks: [sameTriggerAtStageTwo, sameTriggerAtStageThree], suppressed_tasks: [] },
  options: {},
  now: "2026-09-05T00:00:00.000Z",
  sourceContext: {},
  standardizedLiveState: {},
});
assert.equal(identityLifecycle.active_tasks.length, 2,
  "same-trigger tasks at different stages must not merge into one queue entry");
assert.deepEqual(identityLifecycle.active_tasks.map((task) => task.stage_round), ["2-5", "3-2"]);
assert(identityLifecycle.active_tasks.every((task) => task.task_contract?.identity?.stage_round === task.stage_round),
  "task creation must persist the normalized stage identity in the task contract");

const providerLifecycle = {
  ...JSON.parse(JSON.stringify(identityLifecycle)),
  active_tasks: [{
    ...providerRunningTask,
    task_contract: buildTaskContract(providerRunningTask),
    expires_at: "2020-01-01T00:00:00.000Z",
  }],
};
const providerExpiryEvents = expireTasks(providerLifecycle, "2026-09-05T00:10:00.000Z");
assert.equal(providerExpiryEvents.length, 0);
assert.equal(providerLifecycle.active_tasks.length, 1,
  "provider-running task must remain active past ordinary queue TTL");
assert.equal(providerLifecycle.active_tasks[0].expires_at, null);

const lifecycle = {
  active_tasks: [{
    ...catchupTask,
    persistent_strategic_projection: true,
    expires_at: "2020-01-01T00:00:00.000Z",
  }, {
    ...ordinaryStrategicTask,
    expires_at: "2020-01-01T00:00:00.000Z",
  }],
  expired_tasks: [],
};
const events = expireTasks(lifecycle, "2026-09-05T00:01:00.000Z");
assert.equal(events.length, 1, "only an ordinary task may be expired by the advice TTL pass");
assert.equal(lifecycle.active_tasks.length, 1);
assert.equal(lifecycle.active_tasks[0].persistent_strategic_projection, true);
assert.equal(lifecycle.active_tasks[0].expires_at, null);
assert.equal(lifecycle.expired_tasks.length, 1);
assert.equal(lifecycle.expired_tasks[0].expiration_reason, "ttl_elapsed");

const delayedOrdinaryEvent = {
  ...ordinaryStrategicTask.runtime_event_context,
  event_key: "ordinary-delayed-event",
  stage_round: "2-5",
};
assert.equal(
  buildRuntimeEventFollowupAdviceTask({ runtime_event_context: delayedOrdinaryEvent }, { phase: { stage_round: "2-5" } }, "2026-09-05T00:00:00.000Z"),
  null,
  "a delayed strategic-looking event without a durable queue binding must remain fact-only",
);

const persistedLifecycle = {
  schema: "jcc-cruise-advice-lifecycle-state-v1",
  match_session_id: "verify-match",
  mode: "cruise",
  active_tasks: [],
  confirmed_tasks: [],
  skipped_tasks: [],
  expired_tasks: [],
  active_task_context: {},
  match_context: {},
  previous_advice_state: { emitted_tasks: [] },
  output_history: [],
};
const persistedTask = {
  ...catchupTask,
  priority: "high",
  evidence: [],
};
applyLifecycle({
  lifecycle: persistedLifecycle,
  score: { advice_tasks: [persistedTask], suppressed_tasks: [] },
  options: {},
  now: "2026-09-05T00:00:00.000Z",
  sourceContext: {},
  standardizedLiveState: {},
});
assert.equal(persistedLifecycle.active_tasks[0].persistent_strategic_projection, true,
  "the persistent projection identity must survive lifecycle persistence");
assert.equal(persistedLifecycle.active_tasks[0].expires_at, null,
  "the persisted strategic projection must not receive a TTL");

const restoredLifecycle = JSON.parse(JSON.stringify(persistedLifecycle));
const restoredEvents = expireTasks(restoredLifecycle, "2026-09-05T00:10:00.000Z");
assert.equal(restoredEvents.length, 0, "a serialized and restored strategic projection must remain outside ordinary TTL expiry");
assert.equal(restoredLifecycle.active_tasks[0].persistent_strategic_projection, true,
  "strategic projection identity must survive JSON persistence and restore");
assert.equal(restoredLifecycle.active_tasks[0].expires_at, null,
  "restored strategic projection must remain without an expiry timestamp");

const sameIdLifecycle = {
  ...JSON.parse(JSON.stringify(persistedLifecycle)),
  active_tasks: [{
    ...persistedLifecycle.active_tasks[0],
    task_id: "shared-event-id",
    persistent_strategic_projection: true,
    expires_at: null,
  }],
};
applyLifecycle({
  lifecycle: sameIdLifecycle,
  score: {
    advice_tasks: [{
      ...ordinaryStrategicTask,
      task_id: "shared-event-id",
      trigger_id: "runtime_event_followup",
      event_key: "shared-event-id",
      priority: "high",
      value_score: 0.9,
      evidence: [],
      actions: [],
      semantic_labels: [],
    }],
    suppressed_tasks: [],
  },
  options: {},
  now: "2026-09-05T00:11:00.000Z",
  sourceContext: {},
  standardizedLiveState: {},
});
assert.equal(sameIdLifecycle.active_tasks[0].persistent_strategic_projection, undefined,
  "an ordinary replacement with the same task id must not inherit strategic projection identity");
assert.equal(sameIdLifecycle.active_tasks[0].expires_at, "2026-09-05T00:11:45.000Z",
  "an ordinary replacement with the same task id must regain its ordinary TTL");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "durable strategic catch-up survives non-registered recovery stage",
    "strategic projection has no ordinary TTL",
    "ordinary strategic-looking task keeps ordinary TTL without queue binding",
    "expireTasks preserves durable projection and expires only ordinary task",
    "delayed unbound event remains fact-only",
    "serialized strategic projection remains durable after restore",
    "ordinary same-id replacement cannot inherit strategic projection",
    "provider-running task remains outside ordinary queue TTL",
    "same-trigger tasks retain distinct stage/task identity during merge",
  ],
}));
