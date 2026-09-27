import assert from "node:assert/strict";
import {
  setRuntimeServiceState,
  hostRequestWithOwnedStrategicContract,
  hostRequestIsStrategicTurn,
  hostCoachNativeOutputSchemaForRequest,
} from "../ui/electron/runtime-service.js";
import { assertProjectedHostRequest } from "../ui/electron/host-request-projection.js";
import { cruiseCheckpointAgendaSnapshot } from "../ui/electron/cruise-checkpoint-agenda.js";
import {
  createStrategicObligationQueueState, enqueueStrategicObligation, strategicObligationDeliveryEnvelope,
} from "../ui/electron/cruise-strategic-obligation-queue.js";

for (const checkpoint of cruiseCheckpointAgendaSnapshot()) {
  const owner = {
    response_task_id: "owned-request", mode: "cruise", origin: "runtime_event",
    match_session_id: "bound-match", event_key: checkpoint.checkpoint_id, revision: 4,
  };
  const event = {
    match_session_id: owner.match_session_id, event_key: owner.event_key,
    fixed_checkpoint_id: checkpoint.checkpoint_id, stage_round: checkpoint.stage_round,
    decision_trigger_id: "lineup_convergence_checkpoint",
  };
  const queue = enqueueStrategicObligation(createStrategicObligationQueueState(), event);
  const envelope = strategicObligationDeliveryEnvelope(queue);
  const task = { ...owner, status: "preparing", runtime_event_context: { ...event, strategic_obligation: envelope } };
  const install = (overrides = {}) => setRuntimeServiceState({
    match_session: { status: "active", match_session_id: owner.match_session_id },
    response_task: task, runtime_strategic_obligations: queue, ...overrides,
  });
  install();
  const request = { mode: "cruise", request_id: "pipeline-request", expected_response_shape: { final_text: "string" } };
  const before = hostRequestWithOwnedStrategicContract(request, owner);
  assert.equal(hostRequestIsStrategicTurn(before), true);
  assert.deepEqual(before.runtime_event_context.strategic_obligation, envelope);
  assert.deepEqual(before.expected_response_shape.strategic_completion.required_decisions, envelope.required_decisions);
  const candidates = [{ candidate_id: "candidate", selected_variant_id: "variant", candidate_evidence_id: "evidence" }];
  const after = hostRequestWithOwnedStrategicContract({ ...before,
    runtime_context: { strategy_fit_packet: { candidate_working_set: candidates } },
  }, owner);
  assert.deepEqual(after.expected_response_shape.strategic_completion.completion_receipts, envelope.completion_receipts);
  assert.equal(after.expected_response_shape.strategic_completion.selection_candidates[0].candidate_id, "candidate");
  assertProjectedHostRequest(after);
  const nativeSchema = hostCoachNativeOutputSchemaForRequest(after);
  assert(nativeSchema.properties.strategic_completion);
  assert(nativeSchema.properties.strategy_selection);
  assert.deepEqual(Object.keys(nativeSchema.properties.strategic_completion.properties.decision_outputs.properties).sort(),
    [...new Set(envelope.required_decisions)].sort());
  assert.equal(request.runtime_event_context, undefined);
  install({ response_task: { ...task, revision: 5 } });
  assert.doesNotThrow(() => hostRequestWithOwnedStrategicContract(request, owner));
  install({ response_task: { ...task, response_task_id: "replacement" } });
  assert.throws(() => hostRequestWithOwnedStrategicContract(request, owner), /owner_not_current/);
  install({ match_session: { status: "active", match_session_id: "different-match" } });
  assert.throws(() => hostRequestWithOwnedStrategicContract(request, owner), /owner_not_current/);
  install({ response_task: { ...task, runtime_event_context: event } });
  assert.throws(() => hostRequestWithOwnedStrategicContract(request, owner), /owner_obligation_missing/);
  install({ runtime_strategic_obligations: { ...queue, revision: queue.revision + 1 } });
  assert.throws(() => hostRequestWithOwnedStrategicContract(request, owner), /owner_obligation_stale/);
  install({ response_task: { ...task, runtime_event_context: { event_type: "shop_changed" } } });
  assert.equal(hostRequestWithOwnedStrategicContract(request, owner), request,
    "global pending obligations must not grant a non-strategic task strategic authority");
}
console.log(JSON.stringify({ ok: true, checked: "all_registered_checkpoints_request_owner_binding" }));
