import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getRuntimeServiceState,
  queuedStrategicObligationAdviceEvent,
  runtimeEventCanOpenHostAnswer,
  setRuntimeServiceState,
  shouldPersistRuntimeEventAdviceRetry,
  shouldStartAdviceForRuntimeEvent,
} from "../ui/electron/runtime-service.js";
import {
  createStrategicObligationQueueState,
  enqueueStrategicObligation,
} from "../ui/electron/cruise-strategic-obligation-queue.js";

const runtimeServiceSource = readFileSync("ui/electron/runtime-service.js", "utf8");
assert.equal(
  (runtimeServiceSource.match(/new Set\(\["lineup_convergence_checkpoint", "cap_gap_check", "direction_commit_or_exit"\]\)/g) || []).length,
  0,
  "strategic trigger identity must be owned by the shared predicate rather than reconstructed downstream",
);
assert(
  (runtimeServiceSource.match(/isStrategicRuntimeDecisionTriggerId\(/g) || []).length >= 4,
  "strategic admission and freshness paths should reuse the shared trigger predicate",
);

const contract = JSON.parse(readFileSync("data/runtime/jcc/runtime-ui-mode-contract.json", "utf8"));
const policy = Object.fromEntries(
  (contract.cruise_mode_policy?.interrupt_policy?.semantic_event_admission_policy || [])
    .map((entry) => [entry.category, entry]),
);
for (const category of [
  "tempo_decision_context",
  "streak_decision_context",
  "line_decision_context",
  "economy_management_context",
  "equipment_fit_context",
  "shop_decision_context",
]) {
  assert.equal(policy[category]?.opens_host_answer, false, `${category} must not independently open Cruise Host`);
}
assert.equal(policy.tempo_checkpoint, undefined, "retired tempo checkpoint category must be absent from the production contract");
assert.equal(policy.opening_checkpoint, undefined, "retired opening checkpoint category must be absent from the production contract");
assert.equal(policy.opening_low_frequency, undefined, "retired opening low-frequency category must be absent from the production contract");

for (const [category, entry] of Object.entries(policy)) {
  if (entry?.opens_host_answer !== false) continue;
  const forgedOrdinaryEvent = {
    type: `${category}_changed`,
    stage_round: "2-3",
    event_category: category,
    advice_eligible: true,
  };
  assert.equal(
    runtimeEventCanOpenHostAnswer(forgedOrdinaryEvent),
    false,
    `${category} must remain closed even when a producer marks an ordinary event advice-eligible`,
  );
  assert.equal(
    shouldPersistRuntimeEventAdviceRetry(forgedOrdinaryEvent, { reason: "response_task_active" }),
    false,
    `${category} must not survive as an automatic Host retry`,
  );
}

const fixedEvent = {
  type: "line_decision_context_changed",
  stage_round: "2-2",
  fixed_checkpoint_id: "direction_exploration",
  decision_trigger_id: "lineup_convergence_checkpoint",
  event_category: "line_decision_context",
  advice_eligible: true,
  current_hash: "verify-policy-direction-action",
  match_session_id: "verify-policy",
};
const registeredObligations = enqueueStrategicObligation(
  createStrategicObligationQueueState(),
  fixedEvent,
);
setRuntimeServiceState({
  ...getRuntimeServiceState(),
  active_mode: "cruise",
  match_session: { status: "active", match_session_id: "verify-policy" },
  response_task: { status: "idle", response_task_id: null },
  runtime_strategic_obligations: registeredObligations,
  runtime_event_advice: { handled: {}, retry_pending: {}, last_by_category: {}, last_by_trigger: {} },
});
const live = { phase: { stage_round: "2-3" }, economy: { hp: 100, gold: 20, level: 4, xp: 0 } };
const ordinary = shouldStartAdviceForRuntimeEvent({
  type: "stage_round_changed",
  stage_round: "2-3",
  event_category: "retired_stage_event",
  advice_eligible: true,
}, live);
assert.equal(ordinary.ok, false);
assert.equal(runtimeEventCanOpenHostAnswer({
  type: "stage_round_changed",
  stage_round: "2-3",
  advice_eligible: true,
}), false, "ordinary stage events cannot open a Host lane");
assert.equal(shouldPersistRuntimeEventAdviceRetry(
  { type: "stage_round_changed", stage_round: "2-3", advice_eligible: true },
  { reason: "response_task_active" },
), false, "ordinary events cannot be persisted as Host retries");

const fixedLive = { phase: { stage_round: "2-2" }, economy: { hp: 100, gold: 20, level: 4, xp: 0 } };
const queuedFixedEvent = queuedStrategicObligationAdviceEvent(fixedLive);
assert(queuedFixedEvent, "the persistent strategic obligation queue must materialize the fixed checkpoint delivery event");
const fixed = shouldStartAdviceForRuntimeEvent(queuedFixedEvent, fixedLive);
assert.equal(fixed.ok, true, "fixed strategic checkpoint must remain admissible even when its legacy semantic category is closed");
assert.equal(runtimeEventCanOpenHostAnswer(queuedFixedEvent), true, "registered fixed checkpoints can open a Host lane");
assert.equal(shouldPersistRuntimeEventAdviceRetry(queuedFixedEvent, { reason: "response_task_active" }), true,
  "fixed checkpoints with an exact persisted action identity may be retried after transient blocking");
assert.equal(runtimeEventCanOpenHostAnswer({ ...queuedFixedEvent, current_hash: null }), false,
  "a strategic event without an exact action identity must fail closed");
assert.equal(runtimeEventCanOpenHostAnswer({ explicit_user_card_action: true }), true, "explicit card actions can open a Host lane");

console.log(JSON.stringify({ ok: true, schema: "jcc-cruise-policy-closure-verification-v1" }, null, 2));
