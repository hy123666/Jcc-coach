import { createHash } from "node:crypto";

const textId = (value) => value == null ? null : String(value).slice(0, 180);
const elapsed = (from, to) => {
  const duration = Date.parse(to) - Date.parse(from);
  return from && to && Number.isFinite(duration) && duration >= 0 ? duration : null;
};

export function createHostTurnTrace({ request = {}, task = {}, invocation = {}, taskId, prompt = "", now = new Date().toISOString() } = {}) {
  return {
    schema: "jcc-host-turn-trace-v1",
    trace_id: createHash("sha256").update(`${taskId || request.request_id}:${now}`).digest("hex").slice(0, 24),
    request_id: textId(request.request_id),
    task_id: textId(task.response_task_id || taskId),
    attempt_id: textId(taskId),
    task_revision: task.revision ?? null,
    match_session_id: textId(invocation.route?.match_session_id),
    host_session_id: textId(invocation.host_session_id),
    host_route_key: textId(invocation.route?.key),
    projection_revision: textId(request.projection_hash),
    evidence_manifest_id: textId(request.runtime_context?.strategy_evidence_snapshot?.evidence_snapshot_id
      || invocation.stable_strategy_evidence?.fingerprint),
    stable_evidence_reused: invocation.stable_evidence_reused === true,
    context_sync_required: invocation.context_sync_required === true,
    transport_recovery_required: invocation.transport_recovery_required === true,
    turn_delta_bytes: invocation.turn_prompt_bytes ?? null,
    prompt_bytes: Buffer.byteLength(prompt, "utf8"),
    prompt_chars: prompt.length,
    prepared_at: now,
    provider_dispatch_at: null,
    provider_accepted_at: null,
    first_token_at: null,
    final_event_at: null,
    attempt_ended_at: null,
    normalization_status: "pending",
    semantic_validation_status: "pending",
    delivery_status: "pending",
  };
}

export function updateHostTurnTrace(trace, phase, { now = new Date().toISOString(), sessionId, status, validationError } = {}) {
  const next = { ...trace };
  if (sessionId) next.host_session_id = textId(sessionId);
  if (phase === "dispatch") next.provider_dispatch_at ||= now;
  if (phase === "accepted") next.provider_accepted_at ||= now;
  if (phase === "first_token") next.first_token_at ||= now;
  if (phase === "final") {
    next.final_event_at = now;
    next.attempt_ended_at = now;
    next.normalization_status = "decoded";
  }
  if (phase === "failed") {
    next.attempt_ended_at = now;
    next.normalization_status = status === "decode_failed" ? "decode_failed" : "transport_failed";
    next.semantic_validation_status = "not_run";
    next.delivery_status = "failed";
  }
  if (phase === "validation") {
    next.validation_error = status === "failed" ? String(validationError || "").slice(0, 2000) : null;
    next.normalization_status = status === "passed" ? "normalized" : "rejected";
    next.semantic_validation_status = status;
    next.delivery_status = status === "passed" ? "ready" : "withheld";
  }
  next.queue_and_start_ms = elapsed(next.prepared_at, next.provider_dispatch_at);
  next.first_token_ms = elapsed(next.provider_dispatch_at, next.first_token_at);
  next.provider_elapsed_ms = elapsed(next.provider_dispatch_at, next.attempt_ended_at);
  next.total_elapsed_ms = elapsed(next.prepared_at, now);
  return next;
}

export function hostDeliveryTrace(task = {}, now = new Date().toISOString()) {
  return {
    schema: "jcc-host-turn-delivery-trace-v1",
    task_id: textId(task.response_task_id || task.previous_response_task_id),
    task_revision: task.revision ?? null,
    match_session_id: textId(task.match_session_id),
    delivery_status: task.status === "completed" ? "renderer_acknowledged" : "failure_acknowledged",
    delivered_at: now,
  };
}
