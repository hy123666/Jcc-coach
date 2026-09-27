import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JccRuntimeDaemon } from "../ui/electron/runtime-daemon.js";
import { createRuntimeSqliteStore } from "../ui/electron/runtime-state-store.js";
import {
  createStrategicObligationQueueState,
  enqueueStrategicObligation,
  strategicObligationDeliveryEnvelope,
} from "../ui/electron/cruise-strategic-obligation-queue.js";
import {
  configureRuntimeServicePaths,
  detectRuntimeSemanticEvents,
  getRuntimeServiceState,
  handleRuntimeAction,
  hostCoachResponseRunningInfo,
  markDirectUserIntentEventAnsweredByTask,
  normalizeSelfStateEconomyField,
  retryableRuntimeEventAdviceEvents,
  runtimeArtifactFileToken,
  setRuntimeServiceCanonicalStateWriter,
  setRuntimeServiceState,
  settleCancellingResponseTaskAfterHostTurn,
  shouldDisplayAutoCruiseResult,
  shouldStartAdviceForRuntimeEvent,
  resolveActiveLiveStateForRuntime,
} from "../ui/electron/runtime-service.js";

const root = path.resolve(import.meta.dirname, "..");
const originalRuntimeDataRoot = path.resolve(process.env.JCC_RUNTIME_DATA_DIR || path.join(root, ".jcc-runtime-data"));

async function text(file) {
  return readFile(path.join(root, file), "utf8");
}

function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `${label} missing start marker: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `${label} missing end marker: ${endNeedle}`);
  return source.slice(start, end);
}

async function withTempDaemon(fn) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-response-task-contract-"));
  let daemon = null;
  try {
    daemon = new JccRuntimeDaemon({ repoRoot: root, dataRoot: tempRoot }).start();
    await fn(daemon);
  } finally {
    if (daemon?.started) {
      await daemon.handleAction("shutdown", {
        reason: "verify_response_task_temp_daemon_cleanup",
      }, null).catch(() => {});
      await daemon.actionChain?.catch?.(() => {});
    }
    daemon?.stop?.();
    configureRuntimeServicePaths({ dataRoot: originalRuntimeDataRoot });
    await removeTempRootWithRetry(tempRoot);
  }
}

async function removeTempRootWithRetry(tempRoot) {
  const retryableCodes = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 50,
      });
      return;
    } catch (error) {
      if (!retryableCodes.has(error?.code)) throw error;
      if (attempt === 7) {
        process.stderr.write(`warning: deferred Windows temp SQLite cleanup for ${tempRoot}: ${error.code}\n`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 75 + attempt * 75));
    }
  }
}

function baseState(responseTask) {
  return {
    schema: "jcc-ui-runtime-state-v1",
    device_connection: { status: "connected" },
    daily_session: { status: "inactive" },
    match_session: { status: "active", match_session_id: "verify-match" },
    response_task: responseTask,
    active_mode: "cruise",
    host_cli: { provider: "codex", available: true },
  };
}

function verifyDecisionScopedFreshnessAndArtifactNames() {
  const token = runtimeArtifactFileToken("runtime-event-followup:c021738e-fe74-4fb6-86b4-adca5ff13ff6");
  assert(!/[<>:"/\\|?*\x00-\x1F]/.test(token), "runtime artifact filename token must exclude Windows-invalid characters");
  assert(token.includes("runtime-event-followup-c021738e"), "runtime artifact token must remain diagnosable after sanitization");

  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "2-5",
    eventType: "line_decision_context_changed",
    eventCategory: "line_decision_context",
    requestedStateFingerprint: "old-whole-state",
    currentStateFingerprint: "new-unrelated-state",
    requestedActionFingerprint: "same-line-action",
    currentActionFingerprint: "same-line-action",
  }), true, "decision-stable lineup advice must survive unrelated same-stage live-state churn");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "2-5",
    eventType: "line_decision_context_changed",
    eventCategory: "line_decision_context",
    requestedActionFingerprint: null,
    currentActionFingerprint: "current-line-action",
  }), false, "decision-stable advice must fail closed when its captured action fingerprint is missing");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: null,
    eventType: "line_decision_context_changed",
    eventCategory: "line_decision_context",
    requestedActionFingerprint: "line-action",
    currentActionFingerprint: "line-action",
  }), false, "non-durable advice must fail closed when the current stage is unavailable");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "2-5",
    eventType: "line_decision_context_changed",
    eventCategory: "line_decision_context",
    requestedStateFingerprint: "old-whole-state",
    currentStateFingerprint: "new-unrelated-state",
    requestedActionFingerprint: "line-action-before",
    currentActionFingerprint: "line-action-after",
  }), false, "decision-stable advice must expire when its own recommended action changes");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "2-6",
    eventType: "economic_decision_context_changed",
    eventCategory: "economy_management_context",
    requestedStateFingerprint: "old-whole-state",
    currentStateFingerprint: "new-unrelated-state",
    requestedActionFingerprint: "same-economy-action",
    currentActionFingerprint: "same-economy-action",
  }), true, "decision-stable economy advice may survive one ordinary round when its action has not been superseded");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "3-1",
    eventType: "economic_decision_context_changed",
    eventCategory: "economy_management_context",
  }), false, "decision-stable advice must not cross a major-stage boundary");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "2-5",
    eventType: "shop_decision_context_changed",
    eventCategory: "shop_decision_context",
    decisionTriggerId: "shop_hold_sell_interest",
    requestedActionFingerprint: "old-shop-action",
    currentActionFingerprint: "new-shop-action",
    requestedStateFingerprint: "same-shop-state",
    currentStateFingerprint: "same-shop-state",
  }), false, "scorer-driven exact-shop advice must expire when target or choice context changes its action");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "2-5",
    eventType: "shop_decision_context_changed",
    eventCategory: "shop_decision_context",
    decisionTriggerId: "shop_hold_sell_interest",
    requestedActionFingerprint: "same-shop-action",
    currentActionFingerprint: "same-shop-action",
    requestedStateFingerprint: "same-shop-state",
    currentStateFingerprint: "same-shop-state",
  }), true, "scorer-driven exact-shop advice remains deliverable only when both action and material fingerprints match");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "2-5",
    eventType: "shop_decision_context_changed",
    eventCategory: "shop_decision_context",
    decisionTriggerId: "shop_hold_sell_interest",
    requestedActionFingerprint: null,
    currentActionFingerprint: "current-shop-action",
    requestedStateFingerprint: "same-shop-state",
    currentStateFingerprint: "same-shop-state",
  }), false, "scorer-driven exact-shop advice must fail closed without its captured action fingerprint");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "2-5",
    eventType: "shop_decision_context_changed",
    eventCategory: "shop_decision_context",
    requestedStateFingerprint: "old-shop-state",
    currentStateFingerprint: "new-shop-state",
  }), false, "shop-specific advice must remain exact-state fresh");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "2-5",
    eventType: "shop_decision_context_changed",
    eventCategory: "shop_decision_context",
    requestedStateFingerprint: null,
    currentStateFingerprint: "current-shop-state",
  }), false, "shop-specific advice must fail closed when its captured material fingerprint is missing");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: null,
    eventType: "shop_decision_context_changed",
    eventCategory: "shop_decision_context",
    requestedStateFingerprint: "captured-shop-state",
    currentStateFingerprint: "captured-shop-state",
  }), false, "strict shop advice must fail closed when the current stage is unavailable");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-5",
    currentStageRound: "2-5",
    eventType: "bench_capacity_pressure",
    eventCategory: "bench_pressure",
    requestedStateFingerprint: "captured-bench-state",
    currentStateFingerprint: null,
  }), false, "bench-pressure advice must fail closed when the current material fingerprint is missing");
  assert.equal(shouldDisplayAutoCruiseResult({
    requestedStageRound: "2-1",
    currentStageRound: null,
    eventType: "confirmed_choices_changed",
    eventCategory: "confirmed_choice_context",
  }), true, "durable confirmed-choice follow-up may remain deliverable while transient stage sensing is missing");

  const checkpointState = (stageRound) => ({
    schema: "jcc-live-state-v1",
    match_session_id: "verify-checkpoint-fingerprint",
    phase: { stage_round: stageRound },
    economy: { hp: 80, gold: 30, level: 5, xp: { value: 2, to_next: 20 } },
    own_board: { units: [{ name: "unit-a", star: 2 }] },
    own_bench: { units: [] },
    shop: { units: [] },
    items: {},
  });
  const checkpointContext = { recent_user_messages: [], choice_confirmations: [] };
  setRuntimeServiceState({
    schema: "jcc-ui-runtime-state-v1",
    match_session: { status: "active", match_session_id: "verify-checkpoint-fingerprint" },
    match_context: checkpointContext,
    runtime_event_advice: { handled: {}, retry_pending: {}, last_by_category: {}, last_started_at: null },
  });
  detectRuntimeSemanticEvents(checkpointState("2-3"), { match_context: checkpointContext, source: "verify_checkpoint_baseline" });
  const checkpointEvent = detectRuntimeSemanticEvents(checkpointState("2-5"), { match_context: checkpointContext, source: "verify_checkpoint_change" })
    .find((event) => event.fixed_checkpoint_id === "direction_exploration");
  assert(checkpointEvent?.current_hash, "2-5 recovery must preserve the pending 2-2 action fingerprint");
  assert.equal(checkpointEvent?.fixed_checkpoint_stage_round, "2-2");
  assert.equal(
    checkpointEvent?.strategic_obligation?.latest_checkpoint_id,
    "direction_exploration",
    "2-5 recovery must carry the existing 2-2 persistent obligation envelope",
  );
}

async function verifyDaemonDoesNotEraseUndeliveredCanonicalResponseTask() {
  await withTempDaemon(async (daemon) => {
    const completedTask = {
      revision: 1,
      status: "completed",
      response_task_id: "verify-task",
      mode: "augment_choice",
      origin: "user",
      completed_at: new Date().toISOString(),
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        request_id: "verify-task",
        final_text: "verified host answer",
        confidence: "medium",
      },
    };
    daemon.store.setJson("response_task", completedTask);

    daemon.persistResult("observeRuntimeTick", {
      state: baseState({ status: "idle" }),
      status: "runtime_observed",
    });

    assert.equal(
      daemon.store.getJson("ui_runtime_state").response_task.response_task_id,
      "verify-task",
      "daemon must preserve undelivered completed host response when an observe tick returns idle state",
    );
    assert.equal(
      daemon.store.getJson("response_task").response.final_text,
      "verified host answer",
      "daemon standalone canonical response_task must still contain the host answer",
    );
    assert(
      daemon.store.listRecentEvents(20).some((event) => event.event_type === "daemon_preserved_canonical_response_task_on_persist"),
      "daemon should log that it preserved canonical response_task over incoming idle state",
    );
    assert.equal(
      getRuntimeServiceState().response_task?.response_task_id,
      "verify-task",
      "daemon canonical preservation must also sync the in-memory runtime service state so UI delivery can see the answer",
    );
  });
}

async function verifyDaemonDoesNotErasePreparingCanonicalResponseTask() {
  await withTempDaemon(async (daemon) => {
    const preparingTask = {
      revision: 1,
      status: "preparing",
      response_task_id: "verify-preparing-task",
      match_session_id: "verify-match",
      mode: "cruise",
      origin: "user",
      preparing_since: new Date().toISOString(),
    };
    daemon.store.setJson("response_task", preparingTask);

    daemon.persistResult("observeRuntimeTick", {
      state: baseState({ status: "idle", response_task_id: null }),
      status: "runtime_observed",
    });

    for (const task of [
      daemon.store.getJson("ui_runtime_state").response_task,
      daemon.store.getJson("response_task"),
    ]) {
      assert.equal(task?.status, "preparing", "ownerless idle snapshots must not clear a preparing answer owner");
      assert.equal(task?.response_task_id, "verify-preparing-task");
    }
  });
}

async function verifyDaemonDoesNotEraseCancellingCanonicalResponseTask() {
  await withTempDaemon(async (daemon) => {
    const cancellingTask = {
      revision: 4,
      status: "cancelling",
      response_task_id: "verify-cancelling-task",
      match_session_id: "verify-match",
      mode: "cruise",
      origin: "user",
      cancellation_requested_at: new Date().toISOString(),
    };
    daemon.store.setJson("response_task", cancellingTask);

    daemon.persistResult("observeRuntimeTick", {
      state: baseState({ status: "idle", response_task_id: null }),
      status: "runtime_observed",
    });

    for (const task of [
      daemon.store.getJson("ui_runtime_state").response_task,
      daemon.store.getJson("response_task"),
    ]) {
      assert.equal(task?.status, "cancelling", "ownerless idle snapshots must not clear a retained cancellation owner");
      assert.equal(task?.response_task_id, "verify-cancelling-task");
      assert.equal(task?.revision, 4);
    }
  });
}

async function verifyDaemonAllowsAckToMarkCanonicalResponseTaskDelivered() {
  await withTempDaemon(async (daemon) => {
    const completedTask = {
      revision: 1,
      status: "completed",
      response_task_id: "verify-task",
      mode: "augment_choice",
      origin: "user",
      completed_at: new Date().toISOString(),
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        request_id: "verify-task",
        final_text: "verified host answer",
        confidence: "medium",
      },
    };
    daemon.store.setJson("response_task", completedTask);
    daemon.persistResult("ackDeliveredResponse", {
      state: baseState({
        ...completedTask,
        revision: 2,
        response_task_id: null,
        delivered_at: new Date().toISOString(),
      }),
      status: "completed",
      response: completedTask.response,
    });

    assert.equal(
      daemon.store.getJson("response_task").response_task_id,
      null,
      "daemon must allow ackDeliveredResponse to clear response_task_id after UI delivery",
    );
    assert(
      daemon.store.getJson("response_task").delivered_at,
      "daemon must persist delivered_at after UI delivery",
    );
  });
}

async function verifyDaemonDoesNotPreserveCanonicalTaskAfterExplicitClear() {
  await withTempDaemon(async (daemon) => {
    const runningTask = {
      revision: 1,
      status: "running",
      response_task_id: "verify-running-task",
      mode: "cruise",
      origin: "runtime_event",
      started_at: new Date().toISOString(),
    };
    daemon.store.setJson("response_task", runningTask);
    daemon.persistResult("sendMessage", {
      state: baseState({
        ...runningTask,
        revision: 2,
        status: "preempted_by_higher_priority_context",
        response_task_id: null,
        preempted_at: new Date().toISOString(),
      }),
      status: "choice_confirmation_recorded",
    });

    assert.equal(
      daemon.store.getJson("response_task").status,
      "preempted_by_higher_priority_context",
      "daemon must not restore canonical running task after the runtime explicitly preempts it",
    );
    assert.equal(
      daemon.store.getJson("response_task").response_task_id,
      null,
      "daemon must persist the cleared response_task_id after explicit preemption",
    );
  });
}

async function verifyNewUserTaskSupersedesUndeliveredAutomaticAnswer() {
  await withTempDaemon(async (daemon) => {
    const automaticTask = {
      revision: 7,
      status: "completed",
      response_task_id: "automatic-task",
      match_session_id: "verify-match",
      mode: "cruise",
      origin: "runtime_event",
      completed_at: "2026-01-01T00:00:10.000Z",
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        request_id: "automatic-task",
        final_text: "stale automatic answer",
        confidence: "medium",
      },
    };
    const userTask = {
      revision: 8,
      status: "preparing",
      response_task_id: "user-task",
      match_session_id: "verify-match",
      mode: "cruise",
      origin: "user",
      started_at: "2026-01-01T00:00:11.000Z",
    };
    daemon.store.setJson("response_task", automaticTask);

    daemon.persistResult("sendMessage", {
      state: baseState(userTask),
      status: "awaiting_host_cli_agent_response",
    });

    const canonical = daemon.store.getJson("response_task");
    assert.equal(canonical.response_task_id, "user-task", "new user task must replace an older undelivered automatic answer");
    assert.equal(canonical.origin, "user", "canonical response ownership must remain with the direct user task");
    assert.equal(canonical.revision, 8, "newer user revision must remain canonical");
    assert(
      daemon.store.listRecentEvents(20).some((event) => event.event_type === "daemon_dropped_automatic_response_for_user_priority"),
      "daemon should record why the undelivered automatic answer was discarded",
    );
  });
}

async function verifyNewUserTaskSupersedesOlderUndeliveredUserAnswer() {
  await withTempDaemon(async (daemon) => {
    const olderUserTask = {
      revision: 11,
      status: "completed",
      response_task_id: "older-user-task",
      match_session_id: "verify-match",
      mode: "cruise",
      origin: "user",
      completed_at: "2026-01-01T00:00:10.000Z",
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        request_id: "older-user-task",
        final_text: "older answer that was never delivered",
        confidence: "medium",
      },
    };
    const newerUserTask = {
      revision: 12,
      status: "preparing",
      response_task_id: "newer-user-task",
      match_session_id: "verify-match",
      mode: "cruise",
      origin: "user",
      started_at: "2026-01-01T00:00:11.000Z",
    };
    daemon.store.setJson("response_task", olderUserTask);

    daemon.persistResult("sendMessage", {
      state: baseState(newerUserTask),
      status: "response_preparing",
    });

    const canonical = daemon.store.getJson("response_task");
    assert.equal(canonical.response_task_id, "newer-user-task", "a newer direct user interaction must own the response lane");
    assert.equal(canonical.origin, "user", "the replacement must remain a direct user task");
    assert.equal(canonical.revision, 12, "the newer user task revision must remain canonical");
    assert(
      daemon.store.listRecentEvents(20).some((event) => event.event_type === "daemon_superseded_older_user_response_for_new_interaction"),
      "daemon should retain an audit event for the superseded undelivered user answer",
    );
  });
}

async function verifyManualVariablesPreserveCanonicalResponseOwner() {
  await withTempDaemon(async (daemon) => {
    const automaticTask = {
      revision: 9,
      status: "running",
      response_task_id: "automatic-variable-task",
      match_session_id: "verify-match",
      mode: "cruise",
      origin: "runtime_event",
      event_key: "match_variables_changed:old",
      started_at: new Date().toISOString(),
    };
    const runtimeState = {
      ...baseState(automaticTask),
      response_task_revision: 9,
      active_mode: "manual_match_variables",
      runtime_event_advice: { handled: {}, pending: [] },
      runtime_events: [],
      manual_match_variables: null,
    };
    daemon.store.setJson("ui_runtime_state", runtimeState);
    daemon.store.setJson("response_task", automaticTask);
    setRuntimeServiceState(runtimeState);

    const result = await daemon.handleAction("saveManualVariables", {
      encounter: "verify encounter",
      firstGod: "verify god one",
      secondGod: "verify god two",
      observer: "verify observer",
    }, null);

    assert.equal(result.ok, true, "manual variable confirmation should complete instead of retrying on a revision conflict");
    const canonical = daemon.store.getJson("response_task");
    assert(canonical.revision >= 9, "manual variable persistence must not roll back the canonical response-task revision");
    assert.equal(canonical.response_task_id, "automatic-variable-task", "context-only manual variables must not preempt the current response owner");
    assert.equal(canonical.status, "running", "context-only manual variables must preserve the current response status");
    assert(
      !daemon.store.listRecentEvents(50).some((event) => event.event_type === "ui_action_failed" && /conflicting runtime transition/i.test(JSON.stringify(event.payload_json || event))),
      "manual variable confirmation must not emit a conflicting runtime transition failure",
    );
  });
}

async function verifyHostRequestQueueSettlesWithAsyncResponseTask() {
  await withTempDaemon(async (daemon) => {
    const completedRevision = Number(daemon.store.getJson("response_task_revision", 0) || 0) + 1;
    daemon.store.enqueue("host_request", {
      request_id: "verify-async-host-request",
      mode: "cruise",
    }, "pending");
    daemon.persistResult("canonicalHostResponse", {
      state: baseState({
        revision: completedRevision,
        status: "completed",
        response_task_id: "verify-async-task",
        match_session_id: "verify-match",
        mode: "cruise",
        origin: "user",
        host_request: { request_id: "verify-async-host-request", mode: "cruise" },
        response: {
          schema: "jcc-host-cli-coach-response-v1",
          request_id: "verify-async-host-request",
          final_text: "async answer",
          confidence: "medium",
        },
        completed_at: new Date().toISOString(),
      }),
      status: "completed",
    });

    const rows = daemon.store.listQueue({ queueName: "host_request", limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "completed", "async Host response must settle its original request queue row");
    assert.equal(rows[0].payload.terminal_status, "completed");
  });

  await withTempDaemon(async (daemon) => {
    const completedRevision = Number(daemon.store.getJson("response_task_revision", 0) || 0) + 1;
    daemon.store.enqueue("host_request", {
      request_id: "verify-running-host-request",
      mode: "cruise",
    }, "pending");
    const claimed = daemon.store.claimQueueItem("host_request", { workerId: "verify-host-worker" });
    assert.equal(claimed?.status, "running", "host request should enter the real claimed/running lifecycle before settlement");

    daemon.persistResult("canonicalHostResponse", {
      state: baseState({
        revision: completedRevision,
        status: "completed",
        response_task_id: "verify-running-task",
        match_session_id: "verify-match",
        mode: "cruise",
        origin: "user",
        host_request: { request_id: "verify-running-host-request", mode: "cruise" },
        response: {
          schema: "jcc-host-cli-coach-response-v1",
          request_id: "verify-running-host-request",
          final_text: "claimed async answer",
          confidence: "medium",
        },
        completed_at: new Date().toISOString(),
      }),
      status: "completed",
    });

    const rows = daemon.store.listQueue({ queueName: "host_request", limit: 10 });
    assert.equal(rows[0].status, "completed", "claimed/running Host request must settle when its response task completes");
    assert.equal(rows[0].locked_by, null, "terminal host request must release its queue lock");
  });

  await withTempDaemon(async (daemon) => {
    const completedRevision = Number(daemon.store.getJson("response_task_revision", 0) || 0) + 1;
    const completedTask = {
      revision: completedRevision,
      status: "completed",
      response_task_id: "verify-fast-completion-task",
      match_session_id: "verify-match",
      mode: "cruise",
      origin: "user",
      host_request: { request_id: "verify-fast-completion-request", mode: "cruise" },
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        request_id: "verify-fast-completion-request",
        final_text: "fast answer",
        confidence: "medium",
      },
      completed_at: new Date().toISOString(),
    };
    daemon.persistResult("canonicalHostResponse", {
      state: baseState(completedTask),
      status: "completed",
    });
    daemon.persistResult("sendMessage", {
      state: baseState({
        revision: completedRevision - 1,
        status: "awaiting_host_cli_agent_response",
        response_task_id: "verify-fast-completion-task",
        match_session_id: "verify-match",
        mode: "cruise",
        origin: "user",
        host_request: { request_id: "verify-fast-completion-request", mode: "cruise" },
      }),
      status: "awaiting_host_cli_agent_response",
      host_request: { request_id: "verify-fast-completion-request", mode: "cruise" },
    });

    const rows = daemon.store.listQueue({ queueName: "host_request", limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "completed", "completion-before-enqueue race must still leave the request terminal");
  });
}

async function verifyStoppedResponseSettlesHostRequestQueue() {
  await withTempDaemon(async (daemon) => {
    const task = {
      revision: 4,
      status: "preparing",
      response_task_id: "verify-stop-host-task",
      match_session_id: "verify-match",
      mode: "cruise",
      origin: "user",
      host_request: { request_id: "verify-stop-host-request", mode: "cruise" },
      started_at: new Date().toISOString(),
    };
    const runtimeState = { ...baseState(task), response_task_revision: 4 };
    daemon.store.setJson("ui_runtime_state", runtimeState);
    daemon.store.setJson("response_task", task);
    daemon.store.setJson("response_task_revision", 4);
    daemon.store.enqueue("host_request", task.host_request, "pending");
    setRuntimeServiceState(runtimeState);

    const result = await daemon.handleAction("stopResponse", {
      response_task_id: task.response_task_id,
      response_task_revision: task.revision,
    }, null);

    assert.equal(result.ok, true);
    assert.equal(result.state.response_task.status, "cancelled");
    assert.equal(result.state.response_task.cancelled_host_request_id, "verify-stop-host-request");
    const rows = daemon.store.listQueue({ queueName: "host_request", limit: 10 });
    assert.equal(rows[0].status, "cancelled", "Stop must settle the correlated host request queue row");
  });
}

async function verifyDaemonClearsOldUnscopedMatchTaskForNewMatch() {
  await withTempDaemon(async (daemon) => {
    const oldTask = {
      revision: 1,
      status: "running",
      response_task_id: "old-unscoped-task",
      mode: "cruise",
      origin: "runtime_event",
      started_at: "2026-01-01T00:00:00.000Z",
    };
    daemon.store.setJson("response_task", oldTask);
    daemon.persistResult("observeRuntimeTick", {
      state: {
        ...baseState({ status: "idle" }),
        match_session: {
          status: "active",
          match_session_id: "new-match",
          started_at: "2026-01-01T00:10:00.000Z",
        },
      },
      status: "runtime_observed",
    });

    const task = daemon.store.getJson("response_task");
    assert.equal(
      task.status,
      "idle",
      "daemon must clear an old unscoped match response_task when a new active match starts",
    );
    assert.match(
      task.previous_status || "",
      /canonical_task_outside_current_match/,
      "daemon clear reason should identify out-of-current-match canonical task",
    );
  });
}

async function verifyDaemonPreservesCurrentCanonicalOverStaleIncomingTask() {
  await withTempDaemon(async (daemon) => {
    const canonicalTask = {
      revision: 1,
      status: "completed",
      response_task_id: "current-answer-task",
      match_session_id: "current-match",
      mode: "cruise",
      origin: "runtime_event",
      completed_at: "2026-01-01T00:11:00.000Z",
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        request_id: "current-answer-task",
        final_text: "current canonical answer must survive stale incoming state",
        confidence: "medium",
      },
    };
    daemon.store.setJson("response_task", canonicalTask);
    daemon.persistResult("observeRuntimeTick", {
      state: {
        ...baseState({
          status: "running",
          response_task_id: "old-incoming-task",
          match_session_id: "old-match",
          mode: "cruise",
          origin: "runtime_event",
          started_at: "2026-01-01T00:00:00.000Z",
        }),
        match_session: {
          status: "active",
          match_session_id: "current-match",
          started_at: "2026-01-01T00:10:00.000Z",
        },
      },
      status: "runtime_observed",
    });

    const task = daemon.store.getJson("response_task");
    assert.equal(task.response_task_id, "current-answer-task", "daemon must not let stale incoming task clear a current canonical answer");
    assert.equal(task.response?.final_text, canonicalTask.response.final_text, "current canonical final_text must remain deliverable");
    assert(
      daemon.store.listRecentEvents(20).some((event) => event.event_type === "daemon_preserved_canonical_response_task_on_persist"),
      "daemon should log canonical preservation over stale incoming task",
    );
  });
}

async function verifyDaemonPreservesCurrentCanonicalOverStaleIncomingClearTask() {
  await withTempDaemon(async (daemon) => {
    const canonicalTask = {
      revision: 1,
      status: "completed",
      response_task_id: "current-answer-task",
      match_session_id: "current-match",
      mode: "cruise",
      origin: "runtime_event",
      completed_at: "2026-01-01T00:11:00.000Z",
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        request_id: "current-answer-task",
        final_text: "current canonical answer must survive stale incoming clear state",
        confidence: "medium",
      },
    };
    daemon.store.setJson("response_task", canonicalTask);
    daemon.persistResult("observeRuntimeTick", {
      state: {
        ...baseState({
          status: "failed",
          response_task_id: "old-incoming-task",
          match_session_id: "old-match",
          mode: "cruise",
          origin: "runtime_event",
          failed_at: "2026-01-01T00:00:00.000Z",
          error: "old_task_failed_after_new_match",
        }),
        match_session: {
          status: "active",
          match_session_id: "current-match",
          started_at: "2026-01-01T00:10:00.000Z",
        },
      },
      status: "runtime_observed",
    });

    const task = daemon.store.getJson("response_task");
    assert.equal(task.response_task_id, "current-answer-task", "daemon must not let stale incoming failed task clear a current canonical answer");
    assert.equal(task.response?.final_text, canonicalTask.response.final_text, "current canonical final_text must survive stale incoming clear task");
  });
}

function verifyHostAnswerTimeoutStartsAtProviderDispatch() {
  const now = Date.now();
  const queuedAt = new Date(now - 150_000).toISOString();
  const queued = hostCoachResponseRunningInfo({
    status: "running",
    response_task_id: "queued-before-provider",
    mode: "augment_choice",
    structured_card_action: true,
    awaiting_since: queuedAt,
  }, now);
  assert.equal(queued.provider_started, false, "a queued task must not pretend the provider has started");
  assert.equal(queued.stale, false, "provider queue time must not consume the model answer budget");

  const providerBaseline = hostCoachResponseRunningInfo({
    status: "running",
    response_task_id: "running-at-provider",
    mode: "augment_choice",
    structured_card_action: true,
    awaiting_since: queuedAt,
    provider_awaiting_since: new Date(now - 1_000).toISOString(),
  }, now);
  const providerStartedAt = new Date(now - providerBaseline.timeout_ms - 1_000).toISOString();
  const running = hostCoachResponseRunningInfo({
    status: "running",
    response_task_id: "running-at-provider",
    mode: "augment_choice",
    structured_card_action: true,
    awaiting_since: queuedAt,
    provider_awaiting_since: providerStartedAt,
  }, now);
  assert.equal(running.provider_started, true);
  assert.equal(running.stale, true, "the answer timeout must begin once the native provider turn starts");
}

async function verifyDeliverReadyResponseDeliversTimeoutFailure() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-deliver-timeout-contract-"));
  const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  const previousTimeout = process.env.JCC_HOST_COACH_PENDING_TIMEOUT_MS;
  try {
    configureRuntimeServicePaths({ dataRoot: tempRoot });
    process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
    process.env.JCC_HOST_COACH_PENDING_TIMEOUT_MS = "1";
    setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected" },
      daily_session: { status: "inactive" },
      match_session: {
        status: "active",
        match_session_id: "verify-delivery-match",
        started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
      match_connection: { status: "connected_to_live_match" },
      active_mode: "cruise",
      host_cli: { provider: "codex", available: true },
      watcher: { status: "bounded_fixture", pid: null, source: "response_task_delivery_fixture" },
      response_task: {
        status: "running",
        response_task_id: "timeout-task",
        match_session_id: "verify-delivery-match",
        mode: "cruise",
        origin: "user",
        expiry_policy: "user_question_must_return_even_if_window_passed",
        started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        provider_awaiting_since: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
    });
    const result = await handleRuntimeAction("deliverReadyResponse", {}, null);
    assert.equal(result.status, "response_failed", "deliverReadyResponse must return the failed response after timeout reconciliation");
    assert.equal(result.response_task?.error, "host_coach_response_running_timeout", "failed task should preserve timeout error");
    assert.equal(
      result.response_task?.response_task_id,
      "timeout-task",
      "failed timeout task must keep response_task_id so the real UI helper can ack it",
    );
    assert(!result.state?.response_task?.delivered_at, "failed timeout task must stay undelivered until the UI renders and acks it");
    const uiRenderedResponseTaskId = result.response_task?.response_task_id ?? result.state?.response_task?.response_task_id ?? null;
    assert(uiRenderedResponseTaskId, "UI-shaped ack path requires a non-null response_task_id");
    const ack = await handleRuntimeAction("ackDeliveredResponse", {
      response_task_id: uiRenderedResponseTaskId,
      response_task_revision: result.response_task?.revision ?? result.state?.response_task?.revision,
      reason: "verify_failed_timeout_rendered",
    }, null);
    assert.equal(ack.status, "delivered", "ackDeliveredResponse must mark a rendered failed timeout task delivered");
    assert(ack.state?.response_task?.delivered_at, "acked failed timeout task must be marked delivered after UI receives it");
    assert.equal(ack.state?.response_task?.response_task_id, null, "UI ack is the point where delivered response_task_id is cleared");
    const followup = await handleRuntimeAction("observeRuntimeTick", {}, null);
    assert.notEqual(
      followup.status,
      "response_failed_ready",
      "acked failed timeout task must not be redelivered on the next runtime tick",
    );
  } finally {
    await handleRuntimeAction("shutdown", { reason: "verify_response_task_delivery_cleanup" }, null).catch(() => {});
    if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
    if (previousTimeout === undefined) delete process.env.JCC_HOST_COACH_PENDING_TIMEOUT_MS;
    else process.env.JCC_HOST_COACH_PENDING_TIMEOUT_MS = previousTimeout;
    configureRuntimeServicePaths({ dataRoot: originalRuntimeDataRoot });
    await removeTempRootWithRetry(tempRoot);
  }
}

async function verifyDeliverReadyResponseSilencesAutomaticTimeout() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-deliver-automatic-timeout-contract-"));
  const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  const previousTimeout = process.env.JCC_HOST_COACH_PENDING_TIMEOUT_MS;
  try {
    configureRuntimeServicePaths({ dataRoot: tempRoot });
    process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
    process.env.JCC_HOST_COACH_PENDING_TIMEOUT_MS = "1";
    setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected" },
      daily_session: { status: "inactive" },
      match_session: {
        status: "active",
        match_session_id: "verify-automatic-delivery-match",
        started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
      match_connection: { status: "connected_to_live_match" },
      active_mode: "cruise",
      host_cli: { provider: "codex", available: true },
      watcher: { status: "bounded_fixture", pid: null, source: "automatic_response_task_delivery_fixture" },
      response_task: {
        status: "running",
        response_task_id: "automatic-timeout-task",
        match_session_id: "verify-automatic-delivery-match",
        mode: "cruise",
        origin: "runtime_event",
        started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        provider_awaiting_since: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
    });
    const result = await handleRuntimeAction("deliverReadyResponse", {}, null);
    assert.equal(result.ok, true, "expired automatic advice must settle without a UI error");
    assert.equal(result.status, "stale_logged_only", "expired automatic advice must be audit-only");
    assert.equal(result.stale_reason, "host_coach_response_running_timeout", "automatic audit must preserve the timeout reason");
    assert.equal(result.state?.response_task?.status, "stale_logged_only", "canonical automatic task must be terminal audit state");
    assert.equal(result.state?.response_task?.response_task_id, null, "expired automatic task must release the answer lane immediately");
    assert(result.state?.response_task?.delivered_at, "expired automatic task must not wait for renderer acknowledgement");
  } finally {
    await handleRuntimeAction("shutdown", { reason: "verify_automatic_response_task_delivery_cleanup" }, null).catch(() => {});
    if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
    if (previousTimeout === undefined) delete process.env.JCC_HOST_COACH_PENDING_TIMEOUT_MS;
    else process.env.JCC_HOST_COACH_PENDING_TIMEOUT_MS = previousTimeout;
    configureRuntimeServicePaths({ dataRoot: originalRuntimeDataRoot });
    await removeTempRootWithRetry(tempRoot);
  }
}

async function verifyAutomaticCompletedResponseExpiresBeforeDelivery() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-automatic-delivery-expiry-contract-"));
  const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  const watchDir = path.join(tempRoot, "runtime-evidence", "mumu-gi-live", "current-watch");
  try {
    configureRuntimeServicePaths({ dataRoot: tempRoot });
    process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
    await mkdir(watchDir, { recursive: true });
    const cases = [
      {
        label: "same_stage_fingerprint_drift",
        live: { phase: { stage_round: "2-5", status: 1 }, economy: { hp: 70, gold: 30 } },
        task: {
          origin: "runtime_event",
          requested_stage_round: "2-5",
          event_type: "shop_decision_context_changed",
          runtime_event_context: { event_type: "shop_decision_context_changed", stage_round: "2-5", live_state_fingerprint: "older-fingerprint" },
        },
        reason: "automatic_response_context_changed_before_delivery",
      },
      {
        label: "non_self_current_view",
        live: { phase: { stage_round: "2-5", status: 2 }, economy: { hp: 70, gold: 30 } },
        task: {
          origin: "runtime_event",
          requested_stage_round: "2-5",
          event_type: "confirmed_choices_changed",
          event_category: "confirmed_choice_context",
        },
        deliverable: true,
      },
      {
        label: "temporarily_missing_current_stage",
        live: { phase: { status: 1 }, economy: { hp: 70, gold: 30 } },
        task: {
          origin: "runtime_event",
          requested_stage_round: "2-5",
          event_type: "line_decision_context_changed",
          event_category: "line_decision_context",
        },
        deferred: true,
      },
      {
        label: "temporarily_missing_current_stage_poll",
        action: "pollCruiseAdvice",
        live: { phase: { status: 1 }, economy: { hp: 70, gold: 30 } },
        task: {
          origin: "runtime_event",
          requested_stage_round: "2-5",
          event_type: "line_decision_context_changed",
          event_category: "line_decision_context",
        },
        deferred: true,
      },
      {
        label: "preparing_action_fingerprint",
        live: { phase: { stage_round: "2-5", status: 1 }, economy: { hp: 70, gold: 30 } },
        task: {
          origin: "runtime_event",
          requested_stage_round: "2-5",
          event_type: "stage_round_changed",
          event_category: "retired_stage_event",
          runtime_event_context: {
            context_status: "preparing",
            event_type: "stage_round_changed",
            event_category: "retired_stage_event",
            stage_round: "2-5",
          },
        },
        reason: "automatic_response_context_changed_before_delivery",
      },
      {
        label: "match_eliminated",
        live: { phase: { stage_round: "7-1", status: 1, elimination_confirmed: true }, economy: { hp: 0, gold: 10 } },
        task: { origin: "runtime_event", requested_stage_round: "7-1", event_type: "line_decision_context_changed" },
        reason: "match_eliminated",
      },
      {
        label: "automatic_cruise_expired",
        live: { phase: { stage_round: "2-1", status: 1 }, economy: { hp: 100, gold: 10 } },
        task: { origin: "runtime_event", requested_stage_round: "1-4", event_type: "fixed_strategic_checkpoint" },
        reason: "automatic_response_context_changed_before_delivery",
      },
      {
        label: "fresh_hud_stage_supersedes_stale_live_state",
        live: { phase: { stage_round: "2-5", status: 1 }, economy: { hp: 70, gold: 30 } },
        hud: {
          schema: "jcc-runtime-latest-hud-self-state-v1",
          source: "self_state_roi_ocr",
          observed_at: new Date().toISOString(),
          stage_round: "2-6",
          economy: {},
          missing_economy_fields: ["hp", "gold", "level", "xp"],
        },
        task: { origin: "runtime_event", requested_stage_round: "2-5", event_type: "shop_decision_context_changed" },
        reason: "automatic_response_context_changed_before_delivery",
      },
    ];

    for (const scenario of cases) {
      const liveState = {
        schema: "jcc-live-state-v1",
        match_session_id: "verify-automatic-delivery-expiry-match",
        own_board: { units: [] },
        own_bench: { units: [] },
        shop: { units: [] },
        items: {},
        ...scenario.live,
      };
      await writeFile(path.join(watchDir, "cruise-live-state.json"), `${JSON.stringify(liveState, null, 2)}\n`, "utf8");
      setRuntimeServiceState({
        schema: "jcc-ui-runtime-state-v1",
        device_connection: { status: "connected" },
        daily_session: { status: "inactive" },
        match_session: {
          status: "active",
          match_session_id: "verify-automatic-delivery-expiry-match",
          started_at: new Date(Date.now() - 60_000).toISOString(),
        },
        match_connection: { status: "connected_to_live_match" },
        active_mode: "cruise",
        match_context: scenario.hud ? { latest_hud_self_state: scenario.hud } : {},
        self_state_refresh: scenario.hud ? {
          status: "completed_self_state_roi_ocr",
          last_stage_round: scenario.hud.stage_round,
          last_stage_round_source: "self_state_roi_ocr",
          last_completed_at: scenario.hud.observed_at,
          last_self_state_roi_completed_at: scenario.hud.observed_at,
        } : { last_completed_at: new Date().toISOString() },
        host_cli: { provider: "codex", available: true },
        watcher: { status: "bounded_fixture", pid: null, source: "automatic_delivery_expiry_fixture" },
        response_task: {
          status: "completed",
          response_task_id: `automatic-completed-${scenario.label}`,
          match_session_id: "verify-automatic-delivery-expiry-match",
          mode: "cruise",
          response: { final_text: `stale response for ${scenario.label}` },
          ...scenario.task,
          requested_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        },
      });
      const resolved = await resolveActiveLiveStateForRuntime({ purpose: "automatic_delivery_expiry_fixture" });
      assert.equal(resolved.live_state?.phase?.stage_round, scenario.live.phase.stage_round,
        `${scenario.label} must resolve its own fixture stage before testing delivery`);
      const result = await handleRuntimeAction(scenario.action || "deliverReadyResponse", {}, null);
      assert.equal(result.ok, true, `${scenario.label} expiry must settle without a renderer error`);
      if (scenario.deliverable) {
        assert.equal(result.status, "completed", `${scenario.label} must preserve an already completed stable answer`);
        assert.equal(result.response?.final_text, `stale response for ${scenario.label}`, `${scenario.label} must expose the completed Host answer`);
        assert.equal(result.state?.response_task?.response_task_id, `automatic-completed-${scenario.label}`, `${scenario.label} must keep ownership until renderer ACK`);
        continue;
      }
      if (scenario.deferred) {
        assert.equal(result.status, "response_pending", `${scenario.label} must wait for a verifiable stage instead of deleting the answer`);
        assert.equal(result.state?.response_task?.response_task_id, `automatic-completed-${scenario.label}`, `${scenario.label} must preserve the response owner while freshness is temporarily unverifiable`);
        continue;
      }
      assert.equal(result.status, "stale_logged_only", `${scenario.label} must not deliver completed automatic advice: ${JSON.stringify({
        pending_reason: result.pending_reason,
        resolved_stage: result.state?.resolved_decision_snapshot?.stage_round,
        accepted_stage: result.state?.runtime_event_detector?.last_accepted_live_state?.stage_round,
      })}`);
      assert.equal(result.stale_reason, scenario.reason, `${scenario.label} must expose the exact audit reason`);
      assert.equal(result.state?.response_task?.response_task_id, null, `${scenario.label} must release the response lane`);
    }
  } finally {
    await handleRuntimeAction("shutdown", { reason: "verify_automatic_delivery_expiry_cleanup" }, null).catch(() => {});
    if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
    configureRuntimeServicePaths({ dataRoot: originalRuntimeDataRoot });
    await removeTempRootWithRetry(tempRoot);
  }
}

async function verifyDailyResponseDeliversWithoutActiveMatch() {
  await withTempRuntimeService(async () => {
    const completedTask = {
      status: "completed",
      response_task_id: "daily-completed-task",
      revision: 7,
      mode: "daily_chat",
      origin: "user",
      completed_at: new Date().toISOString(),
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        request_id: "daily-completed-task",
        final_text: "daily answer must be visible without an active match",
        confidence: "medium",
      },
    };
    setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "idle" },
      daily_session: { status: "active", mode: "daily_chat" },
      match_session: { status: "inactive", match_session_id: null },
      active_mode: "daily_chat",
      host_cli: { provider: "codex", available: true },
      response_task: completedTask,
    });

    const delivered = await handleRuntimeAction("deliverReadyResponse", {}, null);
    assert.equal(delivered.status, "completed", "daily response must be deliverable without an active match");
    assert.equal(delivered.response?.final_text, completedTask.response.final_text, "daily delivery must preserve the exact host answer");
    assert.equal(delivered.response_task?.revision, completedTask.revision, "daily delivery must expose the exact task revision for acknowledgement");

    const ack = await handleRuntimeAction("ackDeliveredResponse", {
      response_task_id: completedTask.response_task_id,
      response_task_revision: completedTask.revision,
      reason: "verify_daily_response_rendered",
    }, null);
    assert.equal(ack.status, "delivered", "daily response must remain deliverable until exact acknowledgement");
  });
}

async function verifyAckRequiresExactTaskRevision() {
  await withTempRuntimeService(async () => {
    const task = {
      status: "completed",
      response_task_id: "revision-task",
      revision: 11,
      mode: "daily_chat",
      origin: "user",
      completed_at: new Date().toISOString(),
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        request_id: "revision-task",
        final_text: "revision guarded answer",
        confidence: "medium",
      },
    };
    setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      daily_session: { status: "active", mode: "daily_chat" },
      match_session: { status: "inactive", match_session_id: null },
      active_mode: "daily_chat",
      response_task: task,
    });

    const missingRevision = await handleRuntimeAction("ackDeliveredResponse", {
      response_task_id: task.response_task_id,
    }, null);
    assert.equal(missingRevision.ok, false, "ack without task revision must be rejected");
    assert.equal(missingRevision.status, "response_task_revision_required");
    assert.equal(missingRevision.state?.response_task?.delivered_at, undefined, "rejected ack must not mark the task delivered");

    const staleRevision = await handleRuntimeAction("ackDeliveredResponse", {
      response_task_id: task.response_task_id,
      response_task_revision: task.revision - 1,
    }, null);
    assert.equal(staleRevision.ok, false, "ack with stale task revision must be rejected");
    assert.equal(staleRevision.status, "response_task_revision_mismatch");
    assert.equal(staleRevision.state?.response_task?.response_task_id, task.response_task_id, "stale ack must leave the current task intact");
  });
}

async function verifyAbsorbedCruiseSettlesOnlyAfterDeliveryAck() {
  await withTempRuntimeService(async () => {
    const completedEventKey = "delivery-ack-match|line_decision_context_changed|lineup-convergence:3-3:narrow_candidates";
    const completionReceipts = [{
      block_id: "lineup_direction_commitment",
      revision: 1,
      latest_checkpoint_id: "post_3_2_narrowing",
    }];
    const strategicObligation = {
      schema: "jcc-cruise-strategic-obligation-delivery-envelope-v1",
      queue_revision: 1,
      completion_receipts: completionReceipts,
      required_decisions: ["complete_candidate_rosters_and_roles"],
      complete_candidate_rosters_required: true,
      latest_checkpoint_id: "post_3_2_narrowing",
    };
    const completedObligation = {
      schema: "jcc-direct-user-absorbed-cruise-obligation-v1",
      response_policy: "answer_user_first_then_absorb_current_cruise_agenda",
      source_event_keys: [completedEventKey],
      source_stage_rounds: ["2-5"],
      stage_round: "3-3",
      completion_receipts: completionReceipts,
      strategic_obligation: strategicObligation,
    };
    const completedTask = {
      status: "completed",
      response_task_id: "delivery-ack-completed-task",
      revision: 7,
      mode: "cruise",
      origin: "user",
      match_session_id: "delivery-ack-match",
      completed_at: new Date().toISOString(),
      absorbed_cruise_obligation: completedObligation,
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        request_id: "delivery-ack-completed-task",
        final_text: "current-stage answer",
        confidence: "medium",
        strategic_obligation_coverage: { ok: true },
      },
    };
    setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      daily_session: { status: "active", mode: "daily_chat" },
      match_session: { status: "active", match_session_id: "delivery-ack-match" },
      active_mode: "cruise",
      response_task: completedTask,
      runtime_event_advice: {
        handled: {},
        last_by_category: {},
        last_by_trigger: {},
        last_started_at: null,
        retry_pending: {
          [completedEventKey]: {
            schema: "jcc-runtime-event-advice-retry-v1",
            status: "pending_retry",
            event_key: completedEventKey,
            event: {
              match_session_id: "delivery-ack-match",
              type: "line_decision_context_changed",
              decision_trigger_id: "lineup_convergence_checkpoint",
              fixed_checkpoint_id: "post_3_2_narrowing",
              semantic_key: "lineup-convergence:3-3:narrow_candidates",
              stage_round: "3-3",
            },
          },
        },
      },
    });

    const completedPing = await handleRuntimeAction("sendMessage", { text: "?", mode: "cruise" }, null);
    assert.equal(completedPing.status, "response_status_ready", "punctuation must observe a completed-undelivered owner without replacing it");
    assert.equal(completedPing.state.response_task.response_task_id, completedTask.response_task_id);
    assert.equal(
      completedPing.state.runtime_event_advice.retry_pending[completedEventKey].status,
      "pending_retry",
      "Host completion alone must not settle an absorbed Cruise obligation",
    );

    const staleAck = await handleRuntimeAction("ackDeliveredResponse", {
      response_task_id: completedTask.response_task_id,
      response_task_revision: completedTask.revision - 1,
    }, null);
    assert.equal(staleAck.ok, false);
    assert.equal(staleAck.state.runtime_event_advice.retry_pending[completedEventKey].status, "pending_retry");

    const delivered = await handleRuntimeAction("ackDeliveredResponse", {
      response_task_id: completedTask.response_task_id,
      response_task_revision: completedTask.revision,
      reason: "verify_absorbed_cruise_delivery_ack",
    }, null);
    assert.equal(delivered.status, "delivered");
    assert.equal(
      delivered.state.runtime_event_advice.handled[completedEventKey].status,
      "answered_by_direct_user_task",
      "only the exact UI delivery ACK may settle the absorbed Cruise obligation",
    );
    assert.equal(
      delivered.state.runtime_event_advice.retry_pending[completedEventKey],
      undefined,
      "a delivered absorbed Cruise obligation must leave the retry queue",
    );

    const failedEventKey = "delivery-ack-match|line_decision_context_changed|lineup-convergence:4-2:commit_and_execute";
    const failedTask = {
      status: "failed",
      response_task_id: "delivery-ack-failed-task",
      revision: 11,
      mode: "cruise",
      origin: "user",
      match_session_id: "delivery-ack-match",
      failed_at: new Date().toISOString(),
      error: "host_failed",
      absorbed_cruise_obligation: {
        ...completedObligation,
        source_event_keys: [failedEventKey],
        source_stage_rounds: ["3-5"],
        stage_round: "4-2",
      },
    };
    setRuntimeServiceState({
      ...delivered.state,
      active_mode: "cruise",
      response_task: failedTask,
      runtime_event_advice: {
        ...(delivered.state.runtime_event_advice || {}),
        retry_pending: {
          ...(delivered.state.runtime_event_advice?.retry_pending || {}),
          [failedEventKey]: {
            schema: "jcc-runtime-event-advice-retry-v1",
            status: "pending_retry",
            event_key: failedEventKey,
            event: {
              match_session_id: "delivery-ack-match",
              type: "line_decision_context_changed",
              decision_trigger_id: "lineup_convergence_checkpoint",
              semantic_key: "lineup-convergence:4-2:commit_and_execute",
              stage_round: "4-2",
            },
          },
        },
      },
    });
    const failedPing = await handleRuntimeAction("sendMessage", { text: "？", mode: "cruise" }, null);
    assert.equal(failedPing.status, "response_status_failed_ready", "punctuation must observe a failed-undelivered owner without replacing it");
    assert.equal(failedPing.state.response_task.response_task_id, failedTask.response_task_id);
    const failedAck = await handleRuntimeAction("ackDeliveredResponse", {
      response_task_id: failedTask.response_task_id,
      response_task_revision: failedTask.revision,
      reason: "verify_failed_response_rendered",
    }, null);
    assert.equal(failedAck.status, "delivered");
    assert.equal(
      failedAck.state.runtime_event_advice.retry_pending[failedEventKey].status,
      "pending_retry",
      "rendering a failed answer must not consume the Cruise obligation",
    );
  });
}

async function verifyMergedStrategicDeliverySettlesEveryCoveredBlock() {
  await withTempRuntimeService(async () => {
    const matchSessionId = "merged-strategic-delivery-match";
    const directionEvent = {
      match_session_id: matchSessionId,
      type: "line_decision_context_changed",
      decision_trigger_id: "lineup_convergence_checkpoint",
      fixed_checkpoint_id: "direction_exploration",
      fixed_checkpoint_stage_round: "2-2",
      stage_round: "2-2",
      event_key: `${matchSessionId}:direction`,
    };
    const formationEvent = {
      match_session_id: matchSessionId,
      type: "line_decision_context_changed",
      decision_trigger_id: "lineup_convergence_checkpoint",
      fixed_checkpoint_id: "three_cost_reroll_or_operation",
      fixed_checkpoint_stage_round: "3-5",
      stage_round: "3-5",
      event_key: `${matchSessionId}:formation`,
    };
    let queue = createStrategicObligationQueueState();
    queue = enqueueStrategicObligation(queue, directionEvent);
    queue = enqueueStrategicObligation(queue, formationEvent);
    const envelope = strategicObligationDeliveryEnvelope(queue);
    assert.equal(envelope.completion_receipts.length, 2, "merged strategic delivery must carry one exact receipt per pending block");

    const task = {
      status: "completed",
      response_task_id: "merged-strategic-delivery-task",
      revision: 19,
      mode: "cruise",
      origin: "user",
      match_session_id: matchSessionId,
      completed_at: new Date().toISOString(),
      absorbed_cruise_obligation: {
        schema: "jcc-direct-user-absorbed-cruise-obligation-v1",
        response_policy: "answer_user_first_then_absorb_current_cruise_agenda",
        source_event_keys: [directionEvent.event_key, formationEvent.event_key],
        source_stage_rounds: [directionEvent.stage_round, formationEvent.stage_round],
        stage_round: formationEvent.stage_round,
        completion_receipts: envelope.completion_receipts,
        strategic_obligation: envelope,
      },
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        request_id: "merged-strategic-delivery-task",
        final_text: "merged strategic answer",
        confidence: "high",
        strategic_obligation_coverage: { ok: true },
      },
    };
    const retries = Object.fromEntries([directionEvent, formationEvent].map((event) => [
      event.event_key,
      {
        schema: "jcc-runtime-event-advice-retry-v1",
        status: "adopted_by_strategic_obligation_queue",
        event_key: event.event_key,
        event,
      },
    ]));
    setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      match_session: { status: "active", match_session_id: matchSessionId },
      active_mode: "cruise",
      response_task: task,
      runtime_strategic_obligations: queue,
      runtime_event_advice: {
        handled: {},
        retry_pending: retries,
        last_by_category: {},
        last_by_trigger: {},
        last_started_at: null,
      },
    });

    const delivered = await handleRuntimeAction("ackDeliveredResponse", {
      response_task_id: task.response_task_id,
      response_task_revision: task.revision,
      reason: "verify_merged_strategic_delivery",
    }, null);
    assert.equal(delivered.status, "delivered");
    assert.deepEqual(
      Object.keys(delivered.state.runtime_strategic_obligations?.obligations_by_block || {}),
      [],
      "one verified merged answer must settle every strategic block covered by its exact receipts",
    );
    for (const event of [directionEvent, formationEvent]) {
      assert.equal(
        delivered.state.runtime_event_advice.handled[event.event_key]?.status,
        "answered_by_direct_user_task",
        `merged delivery must settle ${event.fixed_checkpoint_id}`,
      );
    }
  });
}

async function verifyCancelledStrategicProviderTurnRequeuesObligation() {
  await withTempRuntimeService(async () => {
    const matchSessionId = "strategic-cancellation-match";
    const eventKey = `${matchSessionId}:direction`;
    const strategicEvent = {
      match_session_id: matchSessionId,
      type: "line_decision_context_changed",
      decision_trigger_id: "lineup_convergence_checkpoint",
      fixed_checkpoint_id: "direction_exploration",
      fixed_checkpoint_stage_round: "2-2",
      stage_round: "2-2",
      event_key: eventKey,
    };
    const queue = enqueueStrategicObligation(createStrategicObligationQueueState(), strategicEvent);
    const envelope = strategicObligationDeliveryEnvelope(queue);
    setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      runtime_strategic_obligations: queue,
      match_session: { status: "active", match_session_id: matchSessionId },
      active_mode: "cruise",
      response_task: {
        status: "cancelling",
        response_task_id: "strategic-cancelling-task",
        revision: 23,
        mode: "cruise",
        origin: "runtime_event",
        match_session_id: matchSessionId,
        event_key: eventKey,
        runtime_event_context: { ...strategicEvent, strategic_obligation: envelope },
        cancellation_reason: "host_coach_response_running_timeout",
        cancellation_requested_at: new Date().toISOString(),
      },
      runtime_event_advice: {
        handled: {
          [eventKey]: {
            schema: "jcc-runtime-event-advice-v1",
            status: "running",
            event_key: eventKey,
            event: strategicEvent,
            runtime_event_context: strategicEvent,
          },
        },
        retry_pending: {},
        last_by_category: {},
        last_by_trigger: {},
        last_started_at: null,
      },
    });

    const settled = await settleCancellingResponseTaskAfterHostTurn(
      "strategic-cancelling-task",
      "verify_strategic_provider_timeout_settled",
    );
    assert.equal(settled, true);
    const current = getRuntimeServiceState();
    assert.equal(
      current.runtime_event_advice?.handled?.[eventKey]?.status,
      "cancelled_retry_pending",
      "provider settlement must release the old Owner without consuming the strategic obligation",
    );
    assert.equal(
      Object.keys(current.runtime_event_advice?.retry_pending || {}).length,
      0,
      "a timed-out strategic turn must not create a second transient queue",
    );
    assert.deepEqual(current.runtime_strategic_obligations, queue,
      "provider settlement must preserve exact durable revisions and all required fields");
    assert.equal(current.response_task?.status, "cancelled");
    assert.equal(current.response_task?.response_task_id, null);
  });
}

async function verifyStopResponseRejectsStaleTaskId() {
  await withTempRuntimeService(async () => {
    const task = {
      status: "running",
      response_task_id: "current-running-task",
      revision: 3,
      mode: "daily_chat",
      origin: "user",
      started_at: new Date().toISOString(),
    };
    setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      daily_session: { status: "active", mode: "daily_chat" },
      match_session: { status: "inactive", match_session_id: null },
      active_mode: "daily_chat",
      response_task: task,
    });

    const result = await handleRuntimeAction("stopResponse", {
      response_task_id: "stale-renderer-task",
    }, null);
    assert.equal(result.ok, false, "stale stop request must be rejected rather than reported as accepted");
    assert.equal(result.status, "response_task_id_mismatch");
    assert.equal(result.state?.response_task?.response_task_id, task.response_task_id, "stale stop must not replace or cancel the current task");
    assert.equal(result.state?.response_task?.status, task.status, "stale stop must not mutate the current task status");
  });
}

async function verifyStopResponseDoesNotFakeRunningHostCancellation() {
  for (const status of ["awaiting_host_cli_agent_response", "running", "response_pending"]) {
    await withTempRuntimeService(async () => {
      const task = {
        status,
        response_task_id: `${status}-without-process-handle`,
        revision: 9,
        mode: "daily_chat",
        origin: "user",
        started_at: new Date().toISOString(),
        awaiting_since: new Date().toISOString(),
      };
      setRuntimeServiceState({
        schema: "jcc-ui-runtime-state-v1",
        daily_session: { status: "active", mode: "daily_chat", generation: 1 },
        match_session: { status: "inactive", match_session_id: null },
        active_mode: "daily_chat",
        response_task: task,
      });

      const result = await handleRuntimeAction("stopResponse", {
        response_task_id: task.response_task_id,
        response_task_revision: task.revision,
      }, null);
      assert.equal(result.ok, false, `${status} Host task without accepted process cancellation must not report success`);
      assert.equal(result.status, "response_cancellation_failed");
      assert.equal(result.state?.response_task?.response_task_id, task.response_task_id);
      assert.equal(result.state?.response_task?.status, task.status, "failed cancellation must keep canonical task ownership intact");
    });
  }
}

async function verifyAcceptedProviderCancellationSettlesWithoutSecondStop() {
  await withTempRuntimeService(async (tempRoot) => {
    for (const provider of ["codex", "kimi"]) {
      const taskId = `${provider}-accepted-cancellation`;
      setRuntimeServiceState({
        schema: "jcc-ui-runtime-state-v1",
        daily_session: { status: "inactive" },
        match_session: { status: "active", match_session_id: "verify-match" },
        active_mode: "cruise",
        host_cli: { provider, available: true },
        response_task_revision: 12,
        response_task: {
          status: "cancelling",
          response_task_id: taskId,
          revision: 12,
          match_session_id: "verify-match",
          mode: "cruise",
          origin: "user",
          cancellation_requested_at: new Date().toISOString(),
          cancellation: {
            accepted: true,
            matched_count: 1,
            retained_count: 1,
            retained_task_ids: [taskId],
          },
        },
      });

      const settled = await settleCancellingResponseTaskAfterHostTurn(
        taskId,
        `${provider}_native_turn_settled`,
      );
      assert.equal(settled, true, `${provider} provider settlement must close an accepted cancellation`);
      const current = getRuntimeServiceState().response_task;
      assert.equal(current?.status, "cancelled");
      assert.equal(current?.response_task_id, null);
      assert.equal(current?.cancelled_response_task_id, taskId);
      assert.equal(current?.provider_settlement_source, `${provider}_native_turn_settled`);
      assert(current?.cancellation_settled_at, "provider settlement must be auditable");

      const canonical = readCanonicalResponseTask(tempRoot);
      assert.equal(canonical.response_task?.status, "cancelled");
      assert.equal(canonical.response_task?.cancelled_response_task_id, taskId);
      assert.equal(canonical.ui_state_task?.status, "cancelled");
    }
  });
}

async function withTempRuntimeService(fn) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-service-contract-"));
  const store = createRuntimeSqliteStore(root, { dataRoot: tempRoot }).open();
  try {
    configureRuntimeServicePaths({ dataRoot: tempRoot });
    setRuntimeServiceCanonicalStateWriter(async (nextState) => {
      store.setJson("ui_runtime_state", nextState);
      if (nextState?.response_task) store.setJson("response_task", nextState.response_task);
    });
    await fn(tempRoot);
  } finally {
    setRuntimeServiceCanonicalStateWriter(null);
    store.close();
    configureRuntimeServicePaths({ dataRoot: originalRuntimeDataRoot });
    await removeTempRootWithRetry(tempRoot);
  }
}

function readCanonicalResponseTask(tempRoot) {
  const store = createRuntimeSqliteStore(root, { dataRoot: tempRoot });
  try {
    return {
      ui_state_task: store.getJson("ui_runtime_state", {})?.response_task || null,
      response_task: store.getJson("response_task", null),
    };
  } finally {
    store.close();
  }
}

async function waitForCanonicalResponseTask(tempRoot, predicate, label) {
  const deadline = Date.now() + 2000;
  let last = null;
  while (Date.now() < deadline) {
    last = readCanonicalResponseTask(tempRoot).response_task;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label} did not appear in canonical response_task; last=${JSON.stringify(last)}`);
}

async function verifyStopResponseCancelsPreparingSendMessageBeforeAsyncWorkPublishes() {
  const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  const previousDelay = process.env.JCC_TEST_SEND_MESSAGE_PREPARING_DELAY_MS;
  try {
    process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
    process.env.JCC_TEST_SEND_MESSAGE_PREPARING_DELAY_MS = "300";
    await withTempRuntimeService(async (tempRoot) => {
      setRuntimeServiceState({
        schema: "jcc-ui-runtime-state-v1",
        device_connection: { status: "connected" },
        daily_session: { status: "inactive" },
        match_session: {
          status: "active",
          match_session_id: "verify-stop-preparing",
          started_at: new Date().toISOString(),
        },
        match_connection: { status: "connected_to_live_match" },
        active_mode: "cruise",
        host_cli: { provider: "codex", available: true },
        host_sessions: { match: { status: "idle", match_session_id: "verify-stop-preparing" } },
        response_task: { status: "idle", response_task_id: null },
        runtime_triggers: {},
        user_preferences: {},
      });

      const sendPromise = handleRuntimeAction("sendMessage", {
        text: "verify stop during preparing",
        mode: "cruise",
      }, null);
      const preparingTask = await waitForCanonicalResponseTask(
        tempRoot,
        (task) => task?.status === "preparing" && task?.response_task_id,
        "preparing sendMessage task",
      );
      const stopResult = await handleRuntimeAction("stopResponse", {
        response_task_id: preparingTask.response_task_id,
        response_task_revision: preparingTask.revision,
      }, null);
      assert.equal(stopResult.state?.response_task?.status, "cancelled", "stopResponse must cancel the preparing sendMessage task");
      assert.equal(stopResult.state?.response_task?.cancelled_response_task_id, preparingTask.response_task_id);

      const sendResult = await sendPromise;
      assert.equal(sendResult.status, "response_cancelled", "sendMessage continuation must observe the cancellation before host work");
      assert.equal(sendResult.state?.response_task?.status, "cancelled", "sendMessage must not replace the cancelled task with a late response_task");

      const delivery = await handleRuntimeAction("deliverReadyResponse", {}, null);
      assert.equal(delivery.status, "no_response_ready", "stopped preparing task must not become a deliverable response");

      const canonical = readCanonicalResponseTask(tempRoot);
      for (const task of [canonical.ui_state_task, canonical.response_task]) {
        assert.equal(task?.status, "cancelled", "canonical stores must keep the stopped task cancelled");
        assert.equal(task?.cancelled_response_task_id, preparingTask.response_task_id);
        assert.equal(task?.response, undefined, "stopped task must not publish a late host response");
        assert.equal(task?.fallback_response, undefined, "stopped task must not publish a late OCR fallback response");
      }
    });
  } finally {
    if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
    if (previousDelay === undefined) delete process.env.JCC_TEST_SEND_MESSAGE_PREPARING_DELAY_MS;
    else process.env.JCC_TEST_SEND_MESSAGE_PREPARING_DELAY_MS = previousDelay;
  }
}

async function verifyStopMatchClearsCancelledResponseTaskAtCanonicalBoundary() {
  await withTempRuntimeService(async (tempRoot) => {
    setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected" },
      daily_session: { status: "inactive" },
      match_session: {
        status: "active",
        match_session_id: "verify-stop-match",
        started_at: new Date().toISOString(),
      },
      match_connection: { status: "connected_to_live_match" },
      active_mode: "cruise",
      host_cli: { provider: "codex", available: true },
      response_task: {
        status: "running",
        response_task_id: "stop-match-task",
        match_session_id: "verify-stop-match",
        mode: "cruise",
        origin: "runtime_event",
        started_at: new Date().toISOString(),
      },
    });

    const result = await handleRuntimeAction("stopMatch", {}, null);
    assert.equal(result.ok, true, "stopMatch should complete");
    assert.equal(result.state?.watcher?.status, "idle", "stopMatch must clear stale watcher status when no watcher process is alive");
    assert.equal(result.state?.self_state_refresh?.status, "idle", "stopMatch must clear stale HUD refresh state");

    const canonical = readCanonicalResponseTask(tempRoot);
    for (const task of [canonical.ui_state_task, canonical.response_task]) {
      assert.equal(task?.status, "idle", "stopMatch must persist the canonical match-boundary reset after cancelling active work");
      assert.equal(task?.response_task_id, null, "stopMatch must clear response_task_id in canonical stores");
      assert.equal(task?.cleared_reason, "match_session_stopped", "stopMatch must identify the canonical boundary that cleared the task");
      assert.equal(task?.cancelled_response_task_id, undefined, "transient cancellation diagnostics must not survive the canonical match reset");
    }
  });
}

async function verifySetModePreservesResponseTaskInCanonicalStore() {
  const previousDisable = process.env.JCC_DISABLE_RESIDENT_AUGMENT_CHOICE_OCR;
  process.env.JCC_DISABLE_RESIDENT_AUGMENT_CHOICE_OCR = "1";
  try {
    await withTempRuntimeService(async (tempRoot) => {
      setRuntimeServiceState({
        schema: "jcc-ui-runtime-state-v1",
        device_connection: { status: "connected" },
        daily_session: { status: "inactive" },
        match_session: {
          status: "active",
          match_session_id: "verify-mode-switch",
          started_at: new Date().toISOString(),
        },
        match_connection: { status: "connected_to_live_match" },
        active_mode: "season_choice_sequence",
        host_cli: { provider: "codex", available: true },
        runtime_triggers: {},
        response_task: {
          status: "awaiting_host_cli_agent_response",
          response_task_id: "mode-switch-task",
          match_session_id: "verify-mode-switch",
          mode: "season_choice_sequence",
          origin: "user",
          awaiting_since: new Date().toISOString(),
        },
      });

      const result = await handleRuntimeAction("setMode", { mode: "augment" }, null);
      assert.equal(result.ok, true, "setMode augment should complete");

      const canonical = readCanonicalResponseTask(tempRoot);
      for (const task of [canonical.ui_state_task, canonical.response_task]) {
        assert.equal(task?.status, "awaiting_host_cli_agent_response", "setMode must not cancel or supersede the active user-owned answer");
        assert.equal(task?.response_task_id, "mode-switch-task", "mode switching must preserve the current response owner");
        assert.equal(task?.mode, "season_choice_sequence", "mode switching must not rewrite the owning task backend mode");
        assert.equal(task?.match_session_id, "verify-mode-switch", "setMode must keep match session identity on canonical task");
      }
    });
  } finally {
    if (previousDisable === undefined) delete process.env.JCC_DISABLE_RESIDENT_AUGMENT_CHOICE_OCR;
    else process.env.JCC_DISABLE_RESIDENT_AUGMENT_CHOICE_OCR = previousDisable;
  }
}

async function verifyRuntimeServiceResponseTaskContract() {
  const service = await text("ui/electron/runtime-service.js");
  const targetContextResolver = await text("ui/electron/target-context-resolver.js");
  const daemon = await text("ui/electron/runtime-daemon.js");
  const augmentOcr = await text("tools/run-jcc-augment-choice-roi-ocr.mjs");
  const setModeBody = sliceBetween(service, "async function setMode(payload)", "async function saveManualVariables", "setMode OCR reservation");
  const firstSetModeAwait = setModeBody.indexOf("await ");
  assert(
    setModeBody.indexOf("state.active_mode = runtimeMode") >= 0
      && firstSetModeAwait >= 0
      && setModeBody.indexOf("state.active_mode = runtimeMode") < firstSetModeAwait,
    "setMode must reserve the foreground choice mode before any asynchronous work can admit another HUD OCR job",
  );
  const stageOcrBody = sliceBetween(
    service,
    "async function refreshStageFromSelfStateRoiOcr",
    "async function runBackgroundSelfStateRefresh",
    "stage-only HUD OCR reservation",
  );
  assert(
    stageOcrBody.includes("foregroundAugmentQuickOcrReservationActive()"),
    "the stage-only HUD OCR bypass must respect the foreground augment-mode reservation",
  );
  assert(
    daemon.includes('const statusPingOnly = action === "sendMessage" && messageIsResponseStatusPing(payload?.text)')
      && daemon.includes("daemonPreemptiveControlSignals.has(action) && !statusPingOnly"),
    "a punctuation-only status observation must be classified before daemon-level Host cancellation",
  );
  assert(
    augmentOcr.includes('task_id: `augment_choice.panel.${crypto.randomUUID()}`')
      && /writeMinimalLiveState[\s\S]{0,240}remainingMs\(\);[\s\S]{0,80}return \{/.test(augmentOcr),
    "every Quick OCR attempt must use a unique worker identity and enforce its deadline through final aggregation/publication",
  );
  assert(
    service.includes("absorbed_cruise_obligation: absorbedCruiseObligation")
      && service.includes("markAbsorbedCruiseObligationAnsweredByTask")
      && service.includes("ui_delivery_ack_absorbed_cruise_obligation"),
    "direct user and structured-card completion must carry the absorbed Cruise obligation until exact UI delivery ACK settles it",
  );
  assert(
    service.includes('const shouldDisplay = !deliveryExpiry || deliveryExpiry.disposition === "defer";'),
    "runtime-event completion may preserve only fresh or explicitly deferred answers; every other expiry shape must remain stale",
  );
  const settlementCalls = service.match(/settleCancellingResponseTaskAfterHostTurn\(/g) || [];
  assert(
    service.includes("async function settleCancellingResponseTaskAfterHostTurn")
      && settlementCalls.length >= 9
      && service.includes('status: "cancelled_by_user_stop"')
      && service.includes('event_type: "response_task_cancelled"'),
    "every background Host completion/rejection path must settle an accepted cancellation and release the answer lane",
  );
  const app = await text("ui/src/App.tsx");
  const sendMessageBody = sliceBetween(
    service,
    "async function sendMessage(payload)",
    "async function pollCruiseAdvice()",
    "sendMessage response ownership",
  );
  assert(
    /status: "running",[\s\S]{0,220}origin: "user"/.test(sendMessageBody)
      && /status: "awaiting_host_cli_agent_response",[\s\S]{0,260}origin: "user"/.test(sendMessageBody),
    "direct user response tasks must retain origin=user across preparing, running, and awaiting transitions",
  );
  assert(
    !app.includes("opening_checkpoint")
      && app.includes("if (!next || isResponding || isTransitioning) return;"),
    "the stop control must cancel any visible active Host task, including proactive cruise, while mode transitions still block premature sends",
  );
  assert(
    app.includes("host_coach_response_(?:preparing|pending|running)_timeout"),
    "the renderer must translate preparing, pending, and running host timeout codes instead of leaking internal errors",
  );
  assert(
    app.includes("(?:conflicting|stale) runtime transition|runtime transition revision gap"),
    "the renderer must not leak canonical transition internals even if a future regression reaches the UI boundary",
  );
  assert(
    app.includes("const [modeTransitionPending, setModeTransitionPending] = useState(false)")
      && app.includes("isTransitioning={modeTransitionPending}"),
    "manual mode controls must expose an explicit transition-pending state",
  );
  assert(
    service.includes("function markDirectUserIntentEventAnsweredByTask")
      && service.includes('status: "answered_by_direct_user_task"')
      && service.includes('response_policy: "direct_user_task_only"')
      && service.includes('response_policy: "context_only"')
      && service.includes("event_key: completedUserIntentEventKey")
      && daemon.includes('eventType === "user_intent_direct_response_completed"'),
    "a successful direct user answer must own its intent event while target-plan changes remain context-only",
  );
  assert(
    service.includes('from "./target-context-resolver.js"')
      && targetContextResolver.includes('authority: "durable_target_plan"')
      && targetContextResolver.includes('authority: "provisional_user_intent"')
      && targetContextResolver.includes('persisted: false')
      && service.includes('const durableTargetPlan = targetContext.authority === "provisional_user_intent"')
      && service.includes('const lifecycleTargetPlan = targetContext.authority === "provisional_user_intent"')
      && service.includes('const sourceTarget = resolvedTarget.authority === "provisional_user_intent"')
      && service.includes("latest_target_intent: latestTargetIntent")
      && service.includes("target_context_authority: targetContext.authority")
      && !service.includes("matchFacts?.target_plan || matchFacts?.latest_target_intent || liveStateSummary?.target_plan || null"),
    "provisional lineup intent must remain separately authority-labelled context and must never be shaped as a durable target_plan",
  );
  assert(
    !app.includes('reason: "choice confirmation semantic follow-up"')
      && !app.includes('reason: "manual variables semantic follow-up"'),
    "confirmation-only interactions must persist context without scheduling a Host follow-up",
  );
  const backgroundHost = sliceBetween(
    service,
    "function runHostCoachForPipelineInBackground",
    "function summarizeFastChoiceTextResult",
    "background host coach",
  );
  assert(
    backgroundHost.includes("coach?.status === \"awaiting_host_cli_agent_response\"")
      && backgroundHost.includes("host_request: coach.host_request")
      && backgroundHost.includes("host_coach_status: coach.status"),
    "background host pipeline must persist disabled-exec awaiting host_request instead of failing on missing final_text",
  );
  assert(
    /await persistStateAndCanonicalResponseTask\(\);\s*runHostCoachForPipelineInBackground\(/.test(service)
      && /await persistStateAndCanonicalResponseTask\(\);\s*runDirectHostModelForUserMessageInBackground\(/.test(service),
    "every caller must persist captured response-task ownership to canonical SQLite before launching background host work",
  );
  const persistCanonical = sliceBetween(
    service,
    "async function persistStateAndCanonicalResponseTask(meta = {})",
    "async function readLatestVisualLiveStateRef()",
    "canonical response task persistence",
  );
  assert(
    persistCanonical.includes("state.response_task = withCurrentMatchSessionIdForResponseTask(state.response_task)")
      && persistCanonical.includes("runtimeServiceCanonicalStateWriter(snapshot,"),
    "canonical response_task persistence must mechanically attach current match_session_id before handing state to the daemon writer",
  );
  assert(
    backgroundHost.includes("const matchSessionId = state.response_task?.match_session_id")
      && backgroundHost.includes("const owner = captureResponseTaskOwner(taskId, requestedMode, matchSessionId)")
      && backgroundHost.includes("responseTaskStillOwnedAtRevision(owner)"),
    "background host completion must publish only while its captured task revision still owns the response lane",
  );
  assert(
    backgroundHost.includes("response: coach.response"),
    "background host completion must store the final model response on response_task",
  );
  assert(
    !backgroundHost.includes("delivered_at"),
    "background host completion must not mark delivered_at before UI renders and acks it",
  );

  const ownershipGate = sliceBetween(
    service,
    "function responseTaskCanReceiveHostResult",
    "function cancelResponseTaskHostRun",
    "response task ownership gate",
  );
  assert(
    ownershipGate.includes("activeResponseTaskId === taskId")
      && ownershipGate.includes("currentStatus === \"idle\""),
    "host result gate must accept the in-process active task even if a daemon hydrate temporarily wrote idle state",
  );

  const manualRefresh = sliceBetween(
    service,
    "async function runManualSelfStateRefreshForUserMessage",
    "function startBackgroundSelfStateRefresh",
    "manual self-state refresh",
  );
  assert(
    manualRefresh.includes("force: true")
      && manualRefresh.includes("noVisualFallback: true")
      && manualRefresh.includes("summarizeManualSelfStateRefresh(refreshResult)")
      && manualRefresh.includes("persistStateAndCanonicalResponseTask"),
    "refresh self-state user action must run local forced ROI/OCR refresh and return a visible receipt through canonical response_task",
  );

  const sendMessage = sliceBetween(service, "async function sendMessage", "async function pollCruiseAdvice", "sendMessage");
  assert(
    sendMessage.indexOf("messageRequestsSelfStateRefresh(text)") >= 0
      && sendMessage.indexOf("messageRequestsSelfStateRefresh(text)") < sendMessage.indexOf("const preMessageLiveState")
      && sendMessage.indexOf("messageRequestsSelfStateRefresh(text)") < sendMessage.indexOf("activeResponseTaskId = taskId"),
    "refresh self-state preset must bypass normal host chat and enter the local self-state refresh path before creating a host response task",
  );

  const observeTick = sliceBetween(
    service,
    "async function observeRuntimeTick",
    "async function stopResponse",
    "observe runtime tick",
  );
  assert(
    observeTick.includes("state.response_task?.status === \"failed\" && !state.response_task?.delivered_at")
      && observeTick.includes('status: "response_failed_ready"')
      && observeTick.includes("response_task: state.response_task"),
    "observeRuntimeTick must expose failed response_task as delivery-ready without consuming it",
  );
  const observeFailedReadyBlock = observeTick.slice(
    observeTick.indexOf('if (state.response_task?.status === "failed"'),
    observeTick.indexOf('const runningReconciled = await reconcileRunningHostCoachResponseTask("observe_runtime_tick")'),
  );
  assert(
    !observeFailedReadyBlock.includes("delivered_at:")
      && !observeFailedReadyBlock.includes("response_task_id: null")
      && !observeFailedReadyBlock.includes("activeResponseTaskId = null"),
    "observeRuntimeTick must not clear failed response_task ownership before deliverReadyResponse can show it",
  );
  const delivery = sliceBetween(
    service,
    "async function deliverReadyResponse",
    "async function observeRuntimeTick",
    "delivery-only response",
  );
  assert(
    delivery.includes('reconcilePreparingHostCoachResponseTask("delivery_only")')
      && delivery.includes('reconcileRunningHostCoachResponseTask("delivery_only")')
      && delivery.includes('reconcilePendingHostCoachResponseTask("delivery_only")'),
    "deliverReadyResponse must reconcile preparing/running/pending host tasks so completed or timed-out answers can reach the UI",
  );
  assert(
    service.includes("const HOST_COACH_PREPARING_TIMEOUT_MS")
      && service.includes("async function reconcilePreparingHostCoachResponseTask")
      && service.includes("ownerRunning")
      && service.includes("requeueStrategicRuntimeTask(task, error)")
      && service.includes('preparation_health: "active_beyond_slo"')
      && service.includes('preparation_health: strategicRetryPending ? "requeued_same_obligation" : "orphaned_after_runtime_restart"')
      && service.includes('status: "stale_logged_only"')
      && service.includes('error = "host_coach_response_preparing_owner_missing"'),
    "preparing tasks must preserve a live owner beyond the SLO and recover an orphaned owner without duplicate Provider work",
  );
  const runningReconcile = sliceBetween(
    service,
    "async function reconcileRunningHostCoachResponseTask",
    "async function reconcilePendingHostCoachResponseTask",
    "running response reconciliation",
  );
  const pendingReconcile = sliceBetween(
    service,
    "async function reconcilePendingHostCoachResponseTask",
    "function userManualChoiceResponseInFlight",
    "pending response reconciliation",
  );
  for (const [label, body] of [["running", runningReconcile], ["pending", pendingReconcile]]) {
    assert(
      body.includes("automaticHostResponseTask(staleTask)")
        && body.includes('status: "stale_logged_only"')
        && body.includes("previous_response_task_id: taskId")
        && body.includes("failed: !automatic"),
      `${label} automatic Host timeouts must be audit-only while user-owned timeouts remain visible failures`,
    );
  }
  assert(
    app.includes("function hasAutomaticHostResponseTask")
      && app.includes("automatic-quiet-wait")
      && app.includes("automatic cruise response continuation"),
    "renderer must wait quietly for automatic cruise tasks instead of appending one pending chat message per task",
  );
  assert(
    delivery.includes("responseTaskIsUndeliveredFailed()"),
    "deliverReadyResponse must not short-circuit timeout reconciliation before failed response delivery",
  );
  assert(
    delivery.includes('response_task: taskForDelivery')
      && !delivery.includes('releaseManualChoiceModeAfterDelivery(taskForDelivery')
      && delivery.includes("undeliveredFailedResponseTaskPayload"),
    "deliverReadyResponse must return ready responses without clearing response_task ownership; UI ack owns delivered_at",
  );
  const sendMessageDelivery = sliceBetween(service, "async function sendMessage", "async function pollCruiseAdvice", "sendMessage delivery");
  assert(
    sendMessageDelivery.includes("response_task: state.response_task")
      && !sendMessageDelivery.includes("delivered_at: new Date().toISOString()"),
    "sendMessage synchronous host/local responses must return the response_task for UI ack instead of marking delivered",
  );
  const ackDelivery = sliceBetween(
    service,
    "async function ackDeliveredResponse",
    "function responseTaskIsUndeliveredFailed",
    "ack delivered response",
  );
  assert(
    ackDelivery.includes("delivered_at: new Date().toISOString()")
      && ackDelivery.includes("response_task_id: null")
      && ackDelivery.includes("releaseManualChoiceModeAfterDelivery(deliveredTask, reason)")
      && ackDelivery.includes("persistStateAndCanonicalResponseTask("),
    "ackDeliveredResponse must be the only normal path that clears a rendered completed/failed response_task",
  );
  const stopResponse = sliceBetween(
    service,
    "async function stopResponse",
    "async function getResolvedLiveState",
    "stop response",
  );
  assert(
    stopResponse.includes("status: \"response_task_id_mismatch\"")
      && stopResponse.includes("requestedTaskId !== currentResponseTaskId")
      && stopResponse.includes("requestedTaskId !== currentActiveTaskId")
      && stopResponse.includes("currentActiveTaskId.startsWith(`${requestedTaskId}:`)"),
    "stopResponse must ignore stale task ids while allowing parent task ids to cancel correction subtasks",
  );
  assert(
    stopResponse.includes("cancelHostAgentRunDetailed(taskId)")
      && stopResponse.includes("hostProcessMustBeCancelled")
      && stopResponse.includes("hostCoachResponseRunningInfo(state.response_task).running")
      && stopResponse.includes("cancellationHandleRetained")
      && stopResponse.includes("retainedHandleAlreadySettled")
      && stopResponse.includes('status: "response_cancellation_pending"')
      && stopResponse.includes('status: "response_cancellation_failed"')
      && stopResponse.includes("if (hostProcessMustBeCancelled && !cancellation.accepted && !retainedHandleAlreadySettled)"),
    "stopResponse must retain an accepted pending cancellation and must not clear an awaiting host task unless the adapter process accepted or already settled cancellation",
  );
  const runningInfo = sliceBetween(
    service,
    "function hostCoachResponseRunningInfo",
    "async function reconcileRunningHostCoachResponseTask",
    "running host response timeout",
  );
  assert(
    runningInfo.includes("task.awaiting_since || task.started_at || task.requested_at")
      && runningInfo.indexOf("task.awaiting_since") < runningInfo.indexOf("task.started_at"),
    "running response timeout must start from the actual Host-await boundary, not an older event or task creation timestamp",
  );
  const stopMatch = sliceBetween(
    service,
    "async function stopMatch",
    "async function resetDailySession",
    "stop match",
  );
  assert(
    stopMatch.includes("cancelResponseTaskHostRun(previousResponseTask, \"cancelled_by_stop_match\")")
      && stopMatch.includes("cancelled_reason: \"cancelled_by_stop_match\"")
      && stopMatch.includes("activeResponseTaskId = null")
      && stopMatch.includes("stopped_host_process: stoppedHostProcess"),
    "Stop Match must cancel any active match response_task host process and clear activeResponseTaskId",
  );
  const resetDailySession = sliceBetween(
    service,
    "async function resetDailySession",
    "async function setMode",
    "daily session reset",
  );
  assert(
    resetDailySession.includes("const nextGeneration = previousGeneration + 1")
      && resetDailySession.includes("cancelResponseTaskHostRun(previousTask, \"cancelled_by_daily_session_reset\")")
      && resetDailySession.includes("daily_session_generation: nextGeneration")
      && resetDailySession.includes("persistStateAndCanonicalResponseTask()"),
    "daily reset must advance generation, cancel the old host task, and persist the new canonical boundary",
  );
  assert(
    !service.includes("messageIsChoiceConfirmationOnly")
      && !service.includes("superseded_by_choice_confirmation")
      && service.includes("const reportedChoiceSet = null")
      && service.includes('response_policy: "direct_user_task_only"'),
    "ordinary chat must retain direct answer ownership and must never use the removed implicit choice-confirmation supersede path",
  );
  const hostCoachCompletion = sliceBetween(
    service,
    "async function completePendingHostCoach",
    "async function runHostCoachForPipeline",
    "host coach completion",
  );
  assert(
    hostCoachCompletion.includes("pending.request_event?.type === \"advice_response_requested\"")
      && hostCoachCompletion.includes("normalizeAdviceResponseRequestEvent(immutableRequestEvent")
      && hostCoachCompletion.includes("hostCliAgentRequest: hostRequestOverride || immutableRequestEvent.host_cli_agent_request || pending.request")
      && hostCoachCompletion.includes("isValidatedHostResponse(agentResponse, requestEvent.host_cli_agent_request)")
      && !hostCoachCompletion.includes("request_id: immutableHostRequest.request_id")
      && hostCoachCompletion.includes("host coach completion is missing its immutable advice request event"),
    "host completion must retain task-owned provenance without overwriting the current executed request identity",
  );
  const pipelineHostRun = sliceBetween(
    service,
    "async function runHostCoachForPipeline",
    "async function maybeDelaySendMessagePreparingForTest",
    "pipeline host run",
  );
  assert(
    backgroundHost.includes("runHostCoachForPipeline(pipelineFile, taskId, {")
      && backgroundHost.includes("isCurrent: () => responseTaskStillOwnedAtRevision(owner)")
      && pipelineHostRun.includes("completePendingHostCoach(pending, codexResult.response, taskId, pipelineFile, enrichedRequest, options)"),
    "pipeline Host merge must receive the exact response-task ownership predicate so cancelled/superseded answers cannot update the latest response ref",
  );
  assert(
    hostCoachCompletion.includes("response_task_not_current_before_merge")
      && hostCoachCompletion.includes("runtimeArtifactFileToken(taskId")
      && hostCoachCompletion.includes("`host-coach-response-run-${taskFileToken}.json`")
      && hostCoachCompletion.includes("host_coach_response_file: path.resolve(responseRunFile)"),
    "Host merge artifacts must use a Windows-safe task-scoped token and must not start after response-task ownership is lost",
  );
  const manualChoiceFallback = sliceBetween(
    service,
    "async function completeManualChoiceFallbackResponseTask",
    "function shouldReturnToCruiseAfterManualChoiceDelivery",
    "manual choice fallback response task",
  );
  assert(
    manualChoiceFallback.includes('status: "failed"')
      && service.includes('schema: "jcc-runtime-manual-choice-fallback-status-v1"')
      && service.includes('generated_by: "jcc_runtime_manual_choice_status_fallback"')
      && manualChoiceFallback.includes("fallback_response: response")
      && manualChoiceFallback.includes("error: reason")
      && !manualChoiceFallback.includes("\n    response,"),
    "manual choice fallback must keep the task failed and store OCR fallback as a runtime status fallback, not as a host coach response",
  );
  assert(
    app.includes("const emitRuntimeFallbackStatus")
      && app.includes("jcc-runtime-manual-choice-fallback-status-v1")
      && app.includes("if (!emitRuntimeFallbackStatus(result.fallback_response || undefined))")
      && app.includes("emitCoachResponse(result.fallback_response || undefined"),
    "UI must render manual choice OCR fallback as status first and only pass non-runtime fallback responses to emitCoachResponse",
  );
  assert(
    app.includes("const responseTaskIsUserCancellable")
      && app.includes('"preparing"')
      && app.includes('"awaiting_host_cli_agent_response"')
      && app.includes("const composerIsResponding = isResponding || responseTaskIsUserCancellable(runtimeState?.response_task)")
      && app.includes("isResponding={composerIsResponding}"),
    "UI composer stop button must stay active while a canonical response_task is preparing/running/pending, not only while sendMessage is awaiting",
  );
  const sendMessageTaskRegistration = sliceBetween(
    service,
    "async function sendMessage",
    "if (isMatchActive && messageRequestsSelfStateRefresh(text))",
    "send message early response task registration",
  );
  assert(
    sendMessageTaskRegistration.includes('status: "preparing"')
      && sendMessageTaskRegistration.includes("await persistStateAndCanonicalResponseTask();")
      && sendMessageTaskRegistration.includes("userMessageTaskIsCurrent"),
    "sendMessage must persist a cancellable preparing response_task before asynchronous OCR/pipeline/host preparation",
  );
  assert(
    !service.includes("function maybeStartOpeningCheckpoint")
      && service.includes('if (isCruiseFixedCheckpointStage(stage)) return "fixed_checkpoint"')
      && !service.includes('return "tempo_checkpoint"')
      && service.includes('source: "runtime_event_response_task_preparing"'),
    "only registered fixed checkpoints may enter the canonical runtime-event response-task lane",
  );
  assert(
    daemon.includes("function incomingResponseTaskClearsCanonical")
      && daemon.includes("preempted_by_higher_priority_context"),
    "runtime-daemon must treat explicit preempt/supersede/failure tasks as canonical-clearing updates, not preserve old running tasks",
  );

  const leftItemRail = sliceBetween(
    service,
    "async function runLeftItemRailRoiIconRefresh",
    "async function refreshStageFromSelfStateRoiOcr",
    "left item rail fallback",
  );
  assert(
    leftItemRail.includes("JCC_DISABLE_LEFT_ITEM_RAIL_ROI_ICON")
      && leftItemRail.includes("left_item_rail_roi_icon_disabled"),
    "left item rail icon matcher must be explicitly disableable because 4357 is the primary item rail source",
  );
  assert(
    leftItemRail.includes("JCC_LEFT_ITEM_RAIL_ROI_ICON_REFRESH_TIMEOUT_MS")
      && leftItemRail.includes("|| 6000")
      && leftItemRail.includes("subprocessTimeoutMs"),
    "left item rail fallback must pass a practical timeout into every bounded subprocess",
  );
  const backgroundRefresh = sliceBetween(
    service,
    "async function runBackgroundSelfStateRefresh",
    "async function runManualSelfStateRefreshForUserMessage",
    "background self-state refresh",
  );
  assert(
    !backgroundRefresh.includes("Promise.race([")
      && backgroundRefresh.includes("const leftItemRailRun = await leftItemRailPromise"),
    "background item fallback must await bounded subprocess completion instead of releasing its single-flight lock while child work continues",
  );
  const backgroundRefreshGate = sliceBetween(
    service,
    "function hasForegroundVisualOrResponseInFlight",
    "function supersedeVisualRequestIfStageChanged",
    "background self-state refresh gate",
  );
  assert(
    backgroundRefreshGate.includes('"fast_choice_text_ready"')
      && backgroundRefreshGate.includes('"fast_hint_delivered"'),
    "completed fast choice OCR/hint states must not permanently block later HUD refreshes",
  );
  const backgroundRefreshStarter = sliceBetween(
    service,
    "function startBackgroundSelfStateRefresh",
    "async function continuePendingVisualToAdvice",
    "background self-state refresh starter",
  );
  assert(
    service.includes("BACKGROUND_SELF_STATE_REFRESH_MAX_RUNNING_MS")
      && service.includes("function expireStaleBackgroundSelfStateRefresh")
      && service.includes("backgroundSelfStateRefreshPromise = null")
      && service.includes("backgroundSelfStateRefreshRunId = null")
      && service.includes("backgroundSelfStateRefreshStartedAt = 0")
      && backgroundRefresh.includes("backgroundSelfStateRefreshStillOwned(runId)")
      && service.includes("backgroundSelfStateRefreshRunId === runId"),
    "background HUD refresh must release stale scheduler ownership, start a replacement, and drop late results from the superseded run",
  );
}

function verifyUserInteractionOwnsIntentAndTargetContext() {
  const liveState = {
    schema: "jcc-live-state-v1",
    match_session_id: "verify-causal-intent",
    phase: { stage_round: "2-5" },
    economy: { hp: 82, gold: 32, level: 5, xp: { value: 4, to_next: 20 } },
    own_board: { units: [] },
    own_bench: { units: [] },
    shop: { units: [] },
    items: {},
  };
  setRuntimeServiceState({
    schema: "jcc-ui-runtime-state-v1",
    match_session: { status: "active", match_session_id: "verify-causal-intent" },
    match_context: { recent_user_messages: [] },
    runtime_event_advice: {
      handled: {},
      retry_pending: {},
      last_by_category: {},
      last_started_at: null,
    },
  });
  detectRuntimeSemanticEvents(liveState, { match_context: { recent_user_messages: [] }, source: "verify_baseline" });

  const interactionContext = {
    recent_user_messages: [{
      text: "我想玩新星特攻队阿卡丽，后续海克斯怎么选？",
      mode: "cruise",
      stage_round: "2-5",
      source: "runtime_ui_user_message",
      intent_tags: ["lineup_intent"],
      interaction_id: "verify-direct-task",
      response_task_id: "verify-direct-task",
    }],
  };
  setRuntimeServiceState({
    ...getRuntimeServiceState(),
    match_context: interactionContext,
  });
  const interactionEvents = detectRuntimeSemanticEvents(liveState, {
    match_context: interactionContext,
    source: "verify_direct_interaction",
  });
  assert(
    !interactionEvents.some((event) => event.type === "latest_user_intent_changed"),
    "a strategic user message must remain in match context and its direct response task without reopening an automatic Cruise event lane",
  );
  assert.equal(
    getRuntimeServiceState().match_context.recent_user_messages.at(-1)?.response_task_id,
    "verify-direct-task",
    "the direct user task must retain causal ownership in match context",
  );
  assert(!interactionEvents.some((event) => event.type === "target_plan_changed"), "a lineup-related question must not masquerade as a durable target-plan change");

  const eventKey = markDirectUserIntentEventAnsweredByTask("verify-direct-task");
  assert(eventKey?.includes("latest_user_intent_changed"));
  const runtimeState = getRuntimeServiceState();
  assert.equal(runtimeState.runtime_event_advice.handled[eventKey].status, "answered_by_direct_user_task");
  assert.equal(runtimeState.runtime_event_advice.handled[eventKey].response_task_id, "verify-direct-task");

  const equipmentReplyContext = {
    recent_user_messages: [
      ...interactionContext.recent_user_messages,
      {
        text: "弓拳套腰带，贾克斯有泰坦的坚决和汲取剑",
        mode: "cruise",
        stage_round: "2-5",
        source: "runtime_ui_user_message",
        intent_tags: ["user_confirmed_equipment"],
        interaction_id: "verify-equipment-direct-task",
        response_task_id: "verify-equipment-direct-task",
        response_policy: "direct_user_task_only",
        user_confirmed_equipment_update: {
          revision: 1,
          update_kind: "snapshot",
          item_bench_count: 3,
          equipped_item_count: 2,
        },
      },
    ],
    user_confirmed_equipment: {
      schema: "jcc-user-confirmed-equipment-v1",
      match_session_id: "verify-causal-intent",
      source: "user_confirmed",
      revision: 1,
      item_bench: [{ name: "反曲之弓" }, { name: "拳套" }, { name: "巨人腰带" }],
      equipped_items: [{ owner_unit: "贾克斯", name: "泰坦的坚决" }, { owner_unit: "贾克斯", name: "汲取剑" }],
    },
  };
  setRuntimeServiceState({
    ...getRuntimeServiceState(),
    match_context: equipmentReplyContext,
  });
  const equipmentReplyEvents = detectRuntimeSemanticEvents(liveState, {
    match_context: equipmentReplyContext,
    source: "verify_equipment_direct_interaction",
  });
  assert.equal(
    equipmentReplyContext.recent_user_messages.at(-1).response_policy,
    "direct_user_task_only",
    "the equipment reply itself must remain the one direct answer owner",
  );
  assert(!equipmentReplyEvents.some((event) => event.type === "latest_user_intent_changed"),
    "a pure equipment fact report must not create a derived strategic intent event");
  assert(
    !equipmentReplyEvents.some((event) => (
      event.advice_eligible
      && !String(event.source || "").startsWith("persistent_strategic_obligation_queue")
    )),
    "the equipment report must not open its own Host lane; only the fixed strategic obligation may answer",
  );

  const targetContext = {
    ...runtimeState.match_context,
    target_plan: {
      name: "新星特攻队阿卡丽",
      source: "user_confirmed",
      authority: "explicit_user",
    },
  };
  setRuntimeServiceState({
    ...runtimeState,
    match_context: targetContext,
  });
  const targetEvents = detectRuntimeSemanticEvents(liveState, {
    match_context: targetContext,
    source: "verify_durable_target_plan",
  });
  assert(
    !targetEvents.some((event) => event.type === "target_plan_changed"),
    "a durable target-plan mutation must update shared match context without reopening a legacy automatic Cruise event lane",
  );
  assert.equal(
    getRuntimeServiceState().match_context.target_plan.name,
    "新星特攻队阿卡丽",
    "the durable target plan must remain available to the next fixed strategic obligation",
  );

  const staleIntentRetryKey = "verify-match|latest_user_intent_changed|legacy-intent";
  const staleTargetRetryKey = "verify-match|target_plan_changed|legacy-target";
  setRuntimeServiceState({
    ...getRuntimeServiceState(),
    runtime_event_advice: {
      handled: {},
      last_by_category: {},
      last_started_at: null,
      retry_pending: {
        [staleIntentRetryKey]: {
          status: "pending_retry",
          first_skipped_at: new Date().toISOString(),
          event: {
            type: "latest_user_intent_changed",
            advice_eligible: true,
            match_session_id: "verify-match",
            semantic_key: "legacy-intent",
          },
        },
        [staleTargetRetryKey]: {
          status: "pending_retry",
          first_skipped_at: new Date().toISOString(),
          event: {
            type: "target_plan_changed",
            advice_eligible: true,
            match_session_id: "verify-match",
            semantic_key: "legacy-target",
          },
        },
      },
    },
  });
  assert.deepEqual(retryableRuntimeEventAdviceEvents(liveState), [], "legacy intent/target retries must never reopen automatic answer lanes");
  const prunedRetryState = getRuntimeServiceState().runtime_event_advice.retry_pending;
  assert.equal(prunedRetryState[staleIntentRetryKey].expired_reason, "interaction_context_only");
  assert.equal(prunedRetryState[staleTargetRetryKey].expired_reason, "interaction_context_only");

  const mixedConfirmationContext = {
    ...getRuntimeServiceState().match_context,
    choice_confirmations: [{
      kind: "augment",
      choice_stage_round: "2-1",
      choice: "猛将的荣耀",
      interaction_id: "verify-direct-task",
      response_task_id: "verify-direct-task",
      response_policy: "direct_user_task_only",
    }],
  };
  setRuntimeServiceState({
    ...getRuntimeServiceState(),
    match_context: mixedConfirmationContext,
  });
  const mixedConfirmationEvents = detectRuntimeSemanticEvents(liveState, {
    match_context: mixedConfirmationContext,
    source: "verify_mixed_confirmation_and_question",
  });
  assert(
    !mixedConfirmationEvents.some((event) => event.type === "confirmed_choices_changed"),
    "a confirmation embedded in a direct user message must update match context without creating a second automatic answer owner",
  );
  assert.equal(
    getRuntimeServiceState().match_context.choice_confirmations.at(-1)?.choice,
    "猛将的荣耀",
    "the mixed confirmation must remain available to the next fixed strategic checkpoint",
  );

  const pureConfirmationContext = {
    ...getRuntimeServiceState().match_context,
    choice_confirmations: [
      ...mixedConfirmationContext.choice_confirmations,
      {
        kind: "augment",
        choice_stage_round: "3-2",
        choice: "升级咯！",
        interaction_id: "verify-confirm-only-task",
        response_task_id: "verify-confirm-only-task",
        response_policy: "semantic_followup_owner",
      },
    ],
  };
  setRuntimeServiceState({
    ...getRuntimeServiceState(),
    match_context: pureConfirmationContext,
  });
  const pureConfirmationEvents = detectRuntimeSemanticEvents(liveState, {
    match_context: pureConfirmationContext,
    source: "verify_confirmation_only_followup",
  });
  assert(
    !pureConfirmationEvents.some((event) => event.type === "confirmed_choices_changed"),
    "detector must not create a second confirmation owner when the structured confirmation path owns the follow-up",
  );
  const pureConfirmationStrategicEvent = pureConfirmationEvents.find((event) => (
    event.existing_strategic_obligation_delivery === true
    && event.decision_trigger_id === "lineup_convergence_checkpoint"
  ));
  assert(
    pureConfirmationStrategicEvent,
    "a confirmation-only interaction must leave the current fixed strategic obligation available for the canonical follow-up owner",
  );
  assert.equal(
    pureConfirmationStrategicEvent.response_policy || "semantic_followup_owner_with_strategic_checkpoint",
    "semantic_followup_owner_with_strategic_checkpoint",
    "the confirmation follow-up contract must carry the strategic checkpoint agenda when it owns the visible turn",
  );
}

async function verifySelfStateRoiMergeContract() {
  const service = await text("ui/electron/runtime-service.js");
  const normalizeSelfState = sliceBetween(
    service,
    "function normalizeSelfStateEconomyField",
    "function summarizeManualSelfStateRefresh",
    "self-state economy normalization",
  );
  assert(
    normalizeSelfState.includes("valueIsMissing(value)")
      && normalizeSelfState.includes("valueIsMissing(raw)"),
    "self-state normalization must reject missing values before Number(null) can create a false zero",
  );
  assert(
    normalizeSelfState.includes('field === "hp"')
      && normalizeSelfState.includes("number <= 0 || number > 150"),
    "active HUD HP must reject zero at the canonical promotion boundary",
  );
  for (const missingOrInvalidHp of [null, undefined, "", " ", "\t", " \n ", 0, "0", -1]) {
    assert.equal(
      normalizeSelfStateEconomyField("hp", missingOrInvalidHp),
      null,
      `active HUD HP must reject ${String(missingOrInvalidHp)} instead of promoting a false value`,
    );
  }
  assert.equal(normalizeSelfStateEconomyField("hp", 87), 87, "valid active HUD HP must survive normalization");
  assert.equal(normalizeSelfStateEconomyField("gold", 0), 0, "real zero gold must remain observable");
  assert.equal(normalizeSelfStateEconomyField("gold", " \t "), null, "blank gold text must remain missing");
  assert.equal(normalizeSelfStateEconomyField("xp", " \n "), null, "blank XP text must remain missing");
  const genericNumericNormalization = sliceBetween(
    service,
    "function normalizeNumericRuntimeValue",
    "function economyBucket",
    "generic runtime numeric normalization",
  );
  assert(
    genericNumericNormalization.includes('typeof raw === "string" ? raw.trim() : raw')
      && genericNumericNormalization.includes('if (normalized === "") return null'),
    "generic runtime numeric normalization must reject whitespace-only text before Number coercion",
  );
  assert(
    service.includes("function sanitizePersistedSelfStateAuthority")
      && service.includes("sanitizePersistedSelfStateAuthority(state)"),
    "runtime hydration must remove historically persisted false-zero HUD authority",
  );
  const applySelfState = sliceBetween(
    service,
    "function applySelfStateRoiOcrRunToSelfStateRefresh",
    "function summarizeManualSelfStateRefresh",
    "self-state ROI apply",
  );
  assert(
    applySelfState.includes("const isStageOnly = status === \"completed_self_state_roi_stage_ocr\"")
      && applySelfState.includes("const observedEconomy = {}")
      && applySelfState.includes("const previousEconomyHasFrameAnchor")
      && applySelfState.includes("previousEconomyHasFrameAnchor ? previous.last_economy || {} : {}")
      && applySelfState.includes("previousEconomyHasFrameAnchor ? previous.last_economy_sources || {} : {}")
      && applySelfState.includes("last_economy: nextEconomy")
      && applySelfState.includes("last_economy_observed_at: isStageOnly")
      && applySelfState.includes("previousEconomyHasFrameAnchor ? previous.last_economy_observed_at || previous.last_self_state_roi_completed_at || null : null")
      && applySelfState.includes("last_previous_full_self_state_economy_evidence")
      && applySelfState.includes("last_stage_roi_visual_live_state_file"),
    "stage-only OCR must update stage authority without discarding independently fresh economy or extending its freshness",
  );

  const mergeSelfState = sliceBetween(
    service,
    "function mergeVisualSelfStateFields",
    "function visualLiveStateMode",
    "self-state ROI live_state merge",
  );
  assert(
    mergeSelfState.includes("visualIsOlderSelfState")
      && mergeSelfState.includes("older_self_state_roi_ocr_does_not_replace_existing_structured_economy")
      && !/visualObservedAt\s*<\s*baseObservedAt[\s\S]{0,120}return baseLiveState;/.test(mergeSelfState),
    "older self-state ROI snapshots must be allowed to fill missing base fields instead of being dropped wholesale",
  );
  assert(
    mergeSelfState.includes("valueIsMissing")
      && mergeSelfState.includes("const hadBaseValue = !valueIsMissing(economy[field])")
      && mergeSelfState.includes("if (valueIsMissing(visualValue)) continue"),
    "self-state merge must treat unknown/unrecognized as missing and avoid overwriting real base values with stale ROI",
  );

  const resolver = sliceBetween(
    service,
    "async function resolveActiveLiveStateForRuntime",
    "function compactUnitForHost",
    "active live_state resolver",
  );
  assert(
    service.includes("async function readLatestSelfStateRoiOcrLiveStates")
      && service.includes("last_stage_roi_visual_live_state_file")
      && service.includes("latest-self-state-roi-${scope}-live-state.json")
      && service.includes("writeSharedLatest: !isStageOnly")
      && resolver.includes("selfStateRoiOcrStates")
      && resolver.includes("self_state_roi_merge_count")
      && resolver.includes(".sort((a, b) =>")
      && resolver.includes(".reduce("),
    "resolver must merge multiple self-state ROI candidates while stage-only artifacts stay out of the shared latest visual ref",
  );
}

if (process.argv.includes("--automatic-delivery-expiry-only")) {
  await verifyAutomaticCompletedResponseExpiresBeforeDelivery();
  process.stdout.write(`${JSON.stringify({ ok: true, checked: "automatic_completed_response_expiry" })}\n`);
  process.exit(0);
}

async function runCheck(name, check) {
  const startedAt = Date.now();
  process.stderr.write(`[response-task-delivery] start ${name}\n`);
  await check();
  process.stderr.write(`[response-task-delivery] pass ${name} ${Date.now() - startedAt}ms\n`);
}

await runCheck("decision_scoped_freshness", verifyDecisionScopedFreshnessAndArtifactNames);
await runCheck("preserve_completed_task", verifyDaemonDoesNotEraseUndeliveredCanonicalResponseTask);
await runCheck("preserve_preparing_task", verifyDaemonDoesNotErasePreparingCanonicalResponseTask);
await runCheck("preserve_cancelling_task", verifyDaemonDoesNotEraseCancellingCanonicalResponseTask);
await runCheck("ack_completed_task", verifyDaemonAllowsAckToMarkCanonicalResponseTaskDelivered);
await runCheck("explicit_task_clear", verifyDaemonDoesNotPreserveCanonicalTaskAfterExplicitClear);
await runCheck("user_supersedes_automatic", verifyNewUserTaskSupersedesUndeliveredAutomaticAnswer);
await runCheck("newer_user_supersedes_older", verifyNewUserTaskSupersedesOlderUndeliveredUserAnswer);
await runCheck("manual_variables_preserve_owner", verifyManualVariablesPreserveCanonicalResponseOwner);
await runCheck("host_request_queue_settlement", verifyHostRequestQueueSettlesWithAsyncResponseTask);
await runCheck("stopped_response_queue_settlement", verifyStoppedResponseSettlesHostRequestQueue);
await runCheck("clear_old_unscoped_match_task", verifyDaemonClearsOldUnscopedMatchTaskForNewMatch);
await runCheck("preserve_current_over_stale_task", verifyDaemonPreservesCurrentCanonicalOverStaleIncomingTask);
await runCheck("preserve_current_over_stale_clear", verifyDaemonPreservesCurrentCanonicalOverStaleIncomingClearTask);
await runCheck("provider_dispatch_timeout_origin", verifyHostAnswerTimeoutStartsAtProviderDispatch);
await runCheck("deliver_timeout_failure", verifyDeliverReadyResponseDeliversTimeoutFailure);
await runCheck("silence_automatic_timeout", verifyDeliverReadyResponseSilencesAutomaticTimeout);
await runCheck("automatic_delivery_expiry", verifyAutomaticCompletedResponseExpiresBeforeDelivery);
await runCheck("daily_delivery_without_match", verifyDailyResponseDeliversWithoutActiveMatch);
await runCheck("ack_exact_revision", verifyAckRequiresExactTaskRevision);
await runCheck("absorbed_cruise_delivery_ack", verifyAbsorbedCruiseSettlesOnlyAfterDeliveryAck);
await runCheck("merged_strategic_delivery", verifyMergedStrategicDeliverySettlesEveryCoveredBlock);
await runCheck("cancelled_provider_requeues", verifyCancelledStrategicProviderTurnRequeuesObligation);
await runCheck("reject_stale_stop", verifyStopResponseRejectsStaleTaskId);
await runCheck("stop_does_not_fake_cancellation", verifyStopResponseDoesNotFakeRunningHostCancellation);
await runCheck("accepted_provider_cancellation", verifyAcceptedProviderCancellationSettlesWithoutSecondStop);
await runCheck("cancel_preparing_send", verifyStopResponseCancelsPreparingSendMessageBeforeAsyncWorkPublishes);
await runCheck("stop_match_canonical_clear", verifyStopMatchClearsCancelledResponseTaskAtCanonicalBoundary);
await runCheck("set_mode_preserves_task", verifySetModePreservesResponseTaskInCanonicalStore);
await runCheck("runtime_service_contract", verifyRuntimeServiceResponseTaskContract);
await runCheck("user_interaction_ownership", verifyUserInteractionOwnsIntentAndTargetContext);
await runCheck("self_state_roi_merge", verifySelfStateRoiMergeContract);
await handleRuntimeAction("shutdown", { reason: "verify_response_task_delivery_final_cleanup" }, null).catch(() => {});

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-response-task-delivery-contract-verifier-v1",
  checked: [
    "daemon_preserves_undelivered_completed_response_task",
    "decision_scoped_freshness_and_windows_safe_artifact_names",
    "daemon_preserves_preparing_response_task_owner",
    "daemon_preserves_cancelling_response_task_owner",
    "daemon_allows_delivery_to_mark_response_task_delivered",
    "daemon_does_not_preserve_running_task_after_explicit_preempt",
    "new_user_task_supersedes_undelivered_automatic_answer",
    "new_user_task_supersedes_older_undelivered_user_answer",
    "manual_variables_preemption_advances_canonical_revision",
    "host_request_queue_settles_with_async_response_task",
    "host_request_queue_settles_after_stop",
    "pipeline_merge_obeys_response_task_revision_ownership",
    "daemon_clears_old_unscoped_match_task_for_new_match",
    "daemon_preserves_current_canonical_over_stale_incoming_task",
    "daemon_preserves_current_canonical_over_stale_incoming_clear_task",
    "host_answer_timeout_starts_at_native_provider_dispatch",
    "deliver_ready_response_delivers_timeout_failure",
    "deliver_ready_response_silences_automatic_timeout",
    "automatic_completed_response_distinguishes_expired_deferred_and_transient_view_delivery",
    "daily_response_delivers_without_active_match",
    "ack_requires_exact_task_revision",
    "absorbed_cruise_settles_only_after_exact_ui_delivery_ack",
    "merged_strategic_delivery_settles_every_covered_block",
    "cancelled_strategic_provider_turn_requeues_obligation",
    "punctuation_observes_completed_and_failed_undelivered_owner",
    "stop_response_rejects_stale_task_id",
    "stop_response_does_not_fake_running_host_cancellation",
    "accepted_codex_and_kimi_cancellation_settles_without_second_stop",
    "stop_response_cancels_preparing_send_message_before_async_work_publishes",
    "stop_match_writes_cancelled_response_task_to_canonical_store",
    "daily_reset_cancels_old_generation_response_task",
    "set_mode_supersede_writes_response_task_to_canonical_store",
    "background_host_task_persists_before_async_model",
    "background_host_result_stays_undelivered_until_ui_delivery",
    "active_task_can_receive_result_after_hydrate_idle_race",
    "observe_tick_reports_failed_response_ready",
    "delivery_reconciles_pending_host_tasks",
    "manual_self_state_refresh_uses_forced_local_roi_path",
    "stage_only_roi_stage_authority_does_not_refresh_economy",
    "missing_hud_values_do_not_coerce_to_zero_and_stale_false_zero_is_sanitized",
    "older_self_state_roi_fills_missing_base_fields",
    "resolver_merges_stage_and_full_self_state_roi_candidates",
    "automatic_cruise_does_not_lock_player_input",
    "running_timeout_internal_error_is_not_player_visible",
    "mode_transition_blocks_premature_manual_send",
    "direct_user_answer_suppresses_duplicate_intent_event",
    "direct_user_interaction_owns_one_answer_and_target_plan_remains_context_only",
    "equipment_reply_owns_one_direct_answer_and_derived_events_remain_context_only",
  ],
}, null, 2)}\n`);
