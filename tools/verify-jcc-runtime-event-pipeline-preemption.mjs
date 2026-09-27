#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";

const root = process.cwd();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-event-preemption-"));
const matchSessionId = "verify-runtime-event-preemption";
const pipelineDelayMs = Number(process.env.JCC_VERIFY_RUNTIME_EVENT_PIPELINE_DELAY_MS || 4000);
// This guards the observe path from waiting on the background pipeline. The
// fixture's current deterministic event preparation takes a few seconds; the
// assertion is intentionally separate from production Host/Provider limits.
const observeReturnBudgetMs = Number(process.env.JCC_VERIFY_RUNTIME_EVENT_OBSERVE_RETURN_BUDGET_MS || 10000);
let currentSeasonVersionSnapshot = null;

for (const [name, value] of Object.entries({
  JCC_RUNTIME_DATA_DIR: tempRoot,
  JCC_UI_DISABLE_CODEX_EXEC: "1",
  JCC_TEST_RUNTIME_EVENT_PIPELINE_DELAY_MS: String(pipelineDelayMs),
  JCC_UI_AUTO_RUNTIME_EVENT_ADVICE_MIN_INTERVAL_MS: "0",
  JCC_DISABLE_RESIDENT_AUGMENT_CHOICE_OCR: "1",
  JCC_DISABLE_RESIDENT_GOD_CHOICE_OCR: "1",
  JCC_DISABLE_RESIDENT_ITEM_CHOICE_OCR: "1",
  JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR: "1",
  JCC_DISABLE_RESIDENT_OWNED_AUGMENT_TEXT_PANEL_OCR: "1",
  JCC_DISABLE_LEFT_ITEM_RAIL_ROI_ICON: "1",
  JCC_ALLOW_COLD_CHOICE_OCR_FALLBACK: "0",
  JCC_ALLOW_COLD_SELF_STATE_ROI_OCR_FALLBACK: "0",
  JCC_UI_BACKGROUND_SELF_STATE_REFRESH_INTERVAL_MS: "999999",
})) process.env[name] = value;

function fileUrl(file, tag) {
  return `${pathToFileURL(path.resolve(root, file)).href}?${tag}`;
}

function clone(value) {
  return structuredClone(value);
}

async function waitFor(predicate, label, timeoutMs = 20_000, diagnostic = null) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${label} timed out; last=${JSON.stringify(last)} diagnostic=${JSON.stringify(diagnostic?.() || null)}`);
}

async function removeTempRoot() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}

function baseState() {
  const now = new Date().toISOString();
  return {
    schema: "jcc-ui-runtime-state-v1",
    device_connection: { status: "connected", adb_target: null },
    daily_session: { status: "inactive" },
    match_session: {
      status: "active",
      match_session_id: matchSessionId,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      season_version_snapshot: currentSeasonVersionSnapshot,
    },
    match_connection: {
      status: "connected_to_live_match",
      initial_cruise_greeting_status: "ready_without_automatic_answer",
      initial_cruise_greeting_at: now,
    },
    active_mode: "cruise",
    host_cli: { provider: "codex", display_name: "Codex CLI", available: true },
    host_sessions: { match: { status: "idle", match_session_id: matchSessionId } },
    watcher: { status: "bounded_fixture", pid: null, source: "event_preemption_fixture" },
    self_state_refresh: { status: "completed", last_completed_at: now, reason: "fixture" },
    response_task: { status: "idle", response_task_id: null, revision: 0 },
    response_task_revision: 0,
    runtime_events: { latest: [], last_observed_at: null },
    runtime_event_detector: null,
    runtime_event_advice: { handled: {}, retry_pending: {}, last_by_category: {}, last_by_trigger: {}, last_started_at: null },
    runtime_triggers: { visual_by_stage: {}, choice_pretriggers: {}, missing_choice_prompts: {}, choice_confirmations: [] },
    match_context: {
      schema: "jcc-runtime-match-context-v1",
      match_session_id: matchSessionId,
      recent_user_messages: [],
      choice_confirmations: [{
        kind: "augment",
        choice_stage_round: "2-1",
        choice: "fixture augment",
        source: "event_preemption_fixture",
        observed_at: now,
      }],
      observed_choice_options_by_stage: {},
    },
    user_preferences: {},
  };
}

async function writeLiveState(file, stageRound, hp = 88, service = null) {
  const observedAt = new Date().toISOString();
  const gold = stageRound === "1-2" ? 10 : 22;
  const level = stageRound === "1-2" ? 3 : 4;
  const xp = stageRound === "1-2" ? "0/6" : "2/10";
  await writeFile(file, `${JSON.stringify({
    schema: "jcc-runtime-event-preemption-live-state-v1",
    match_session_id: matchSessionId,
    observed_at: observedAt,
    phase: { status: "planning", stage_round: stageRound },
    economy: {
      hp: { value: hp, source: "self_state_roi_ocr" },
      gold: { value: gold, source: "self_state_roi_ocr" },
      level: { value: level, source: "self_state_roi_ocr" },
      xp: { value: xp, source: "self_state_roi_ocr" },
    },
    own_board: { local_board_units: [] },
    own_bench: { units: [] },
    shop: { units: [] },
    items: { item_bench: [], equipped_items: [] },
    augments: {},
  }, null, 2)}\n`, "utf8");
  if (service) {
    service.setRuntimeServiceState({
      ...service.getRuntimeServiceState(),
      self_state_refresh: {
        status: "completed",
        last_completed_at: observedAt,
        last_self_state_roi_completed_at: observedAt,
        last_stage_round_observed_at: observedAt,
        last_stage_round: stageRound,
        last_stage_round_source: "self_state_roi_ocr",
        last_economy_observed_at: observedAt,
        last_economy_frame_anchor_status: "same_frame_stage_observed",
        last_economy: { hp, gold, level, xp },
        last_economy_sources: {
          hp: "self_state_roi_ocr",
          gold: "self_state_roi_ocr",
          level: "self_state_roi_ocr",
          xp: "self_state_roi_ocr",
        },
        last_missing_economy_fields: [],
      },
    });
  }
}

async function main() {
  const tag = `event-preemption=${Date.now()}`;
  const [{ createRuntimePaths }, service] = await Promise.all([
    import(fileUrl("ui/electron/runtime-state-store.js", tag)),
    import(fileUrl("ui/electron/runtime-service.js", tag)),
  ]);
  const paths = createRuntimePaths(root, { dataRoot: tempRoot });
  currentSeasonVersionSnapshot = createActiveCoreProfileSnapshot(root, { runtimePaths: paths });
  const canonicalSnapshots = [];
  service.configureRuntimeServicePaths({ dataRoot: tempRoot });
  service.setRuntimeServiceCanonicalStateWriter(async (nextState, meta) => {
    canonicalSnapshots.push({ state: clone(nextState), meta: clone(meta || {}), observed_at_ms: Date.now() });
  });
  await mkdir(paths.currentWatchDir, { recursive: true });
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.uiRuntimeDir, { recursive: true });
  await writeFile(paths.matchContextFile, `${JSON.stringify({
    schema: "jcc-runtime-match-context-v1",
    match_session_id: matchSessionId,
    recent_user_messages: [],
    choice_confirmations: [{
      kind: "augment",
      choice_stage_round: "2-1",
      choice: "fixture augment",
      source: "event_preemption_fixture",
      observed_at: new Date().toISOString(),
    }],
    observed_choice_options_by_stage: {},
  }, null, 2)}\n`, "utf8");
  const liveStateFile = path.join(paths.currentWatchDir, "cruise-live-state.json");

  const resetScenario = async (stageRound = "1-2", hp = 88) => {
    service.setRuntimeServiceState(baseState());
    canonicalSnapshots.length = 0;
    await rm(path.join(paths.stateDir, "jcc-cruise-advice-lifecycle.json"), { force: true });
    await writeLiveState(liveStateFile, stageRound, hp, service);
  };

  await resetScenario("2-2", 88);
  const preparingStartedAt = Date.now();
  const preparingResult = await service.handleRuntimeAction("observeRuntimeTick", {}, null);
  const preparingElapsedMs = Date.now() - preparingStartedAt;
  assert.equal(preparingResult.status, "response_preparing", "automatic event advice must return at durable preparing state");
  assert(
    preparingElapsedMs < observeReturnBudgetMs,
    `observeRuntimeTick exceeded the independent preparing budget: ${preparingElapsedMs}ms >= ${observeReturnBudgetMs}ms; observe_timing=${JSON.stringify(preparingResult.observe_timing || null)}; canonical_timeline=${JSON.stringify(canonicalSnapshots.map((entry) => ({ elapsed_ms: entry.observed_at_ms - preparingStartedAt, source: entry.meta?.source, status: entry.state.response_task?.status })))}`,
  );
  const firstTask = clone(preparingResult.response_task);
  assert.equal(firstTask.origin, "runtime_event");
  assert.equal(firstTask.status, "preparing");
  assert.equal(firstTask.match_session_id, matchSessionId);
  assert.equal(firstTask.pipeline_file, null, "canonical ownership must publish before pipeline context assembly");
  assert.equal(firstTask.runtime_event_context?.context_status, "preparing", "initial canonical task must expose a minimal preparing context");
  assert(Number.isInteger(firstTask.revision) && firstTask.revision > 0, "preparing task must have a canonical revision");
  const preparingInfo = service.hostCoachResponsePreparingInfo?.(firstTask);
  if (preparingInfo) {
    assert.equal(preparingInfo.slo_ms, 60_000, "runtime response SLO must remain 60 seconds");
    assert.equal(preparingInfo.slo_exceeded, false, "fresh preparing task must not exceed the response SLO");
  }
  assert(canonicalSnapshots.some((entry) => (
    entry.state.response_task?.response_task_id === firstTask.response_task_id
    && entry.state.response_task?.status === "preparing"
    && entry.meta?.event_type === "runtime_event_response_task_preparing"
  )), "canonical writer must observe preparing before pipeline completion");
  const settledTask = await waitFor(() => {
    const task = service.getRuntimeServiceState().response_task;
    if (task?.response_task_id === firstTask.response_task_id && task.status === "failed") {
      assert.fail(`runtime event pipeline failed before awaiting host: ${task.error || "unknown error"}`);
    }
    if (task?.status === "no_advice" && task.previous_response_task_id === firstTask.response_task_id) return task;
    return task?.response_task_id === firstTask.response_task_id
      && task.status === "awaiting_host_cli_agent_response"
      && task.host_request
      ? task
      : null;
  }, "preparing -> durable pipeline settlement", 40_000, () => service.getRuntimeServiceState().response_task);
  assert(settledTask.revision > firstTask.revision, "pipeline settlement must advance the response task revision");
  if (settledTask.status === "awaiting_host_cli_agent_response") {
    await service.handleRuntimeAction("stopResponse", {
      response_task_id: firstTask.response_task_id,
      response_task_revision: settledTask.revision,
    }, null);
  }

  await resetScenario("2-7", 88);
  service.setRuntimeServiceState({
    ...service.getRuntimeServiceState(),
    response_task: {
      status: "preparing",
      response_task_id: "future-choice-must-not-preempt-2-7",
      revision: 1,
      origin: "runtime_event",
      mode: "cruise",
      event_key: "fixed-checkpoint-2-7",
      match_session_id: matchSessionId,
    },
    runtime_triggers: {
      ...service.getRuntimeServiceState().runtime_triggers,
      choice_pretriggers: {
        "2-7:augment_choice:choice:3-2": {
          status: "scheduled",
          match_session_id: matchSessionId,
          stage_round: "2-7",
          target_stage_round: "3-2",
          mode: "augment_choice",
          phase: "choice",
          scheduled_at: new Date().toISOString(),
        },
      },
    },
  });
  const preChoicePreparation = await service.handleRuntimeAction("observeRuntimeTick", {}, null);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const preChoiceState = service.getRuntimeServiceState();
  assert.notEqual(
    preChoiceState.response_task?.status,
    "superseded_by_choice_window",
    "a future 3-2 prediction must not cancel the current 2-7 strategic answer",
  );
  if (preChoiceState.response_task?.response_task_id) {
    await service.handleRuntimeAction("stopResponse", {
      response_task_id: preChoiceState.response_task.response_task_id,
      response_task_revision: preChoiceState.response_task.revision,
    }, null);
  }

  await resetScenario("2-2", 88);
  const sendObserveStartedAt = Date.now();
  const openingResult = await service.handleRuntimeAction("observeRuntimeTick", {}, null);
  assert.equal(openingResult.status, "response_preparing");
  assert(Date.now() - sendObserveStartedAt < observeReturnBudgetMs, "opening observe must return inside the independent preparing budget");
  const openingTaskId = openingResult.response_task.response_task_id;
  const sendPromise = service.handleRuntimeAction("sendMessage", {
    mode: "cruise",
    text: "What should I keep for my current plan?",
  }, null);
  const userPreparing = await waitFor(() => {
    const task = service.getRuntimeServiceState().response_task;
    return task?.origin === "user" && task.response_task_id !== openingTaskId ? task : null;
  }, "user task preempts slow opening", 1000);
  assert.equal(userPreparing.status, "preparing", "manual user work must own the response lane immediately");
  const sendResult = await sendPromise;
  assert.equal(sendResult.status, "awaiting_host_cli_agent_response", "disabled host execution should expose the user host request");
  assert.equal(sendResult.state.response_task.origin, "user", `unexpected send response task: ${JSON.stringify(sendResult.state.response_task)}`);
  await new Promise((resolve) => setTimeout(resolve, pipelineDelayMs + 100));
  assert.equal(service.getRuntimeServiceState().response_task.response_task_id, sendResult.state.response_task.response_task_id, "cancelled opening pipeline must not overwrite the user task");
  await service.handleRuntimeAction("stopResponse", {
    response_task_id: sendResult.state.response_task.response_task_id,
    response_task_revision: sendResult.state.response_task.revision,
  }, null);

  await resetScenario("2-2", 88);
  const stopOpening = await service.handleRuntimeAction("observeRuntimeTick", {}, null);
  const stopStartedAt = Date.now();
  const stopResult = await service.handleRuntimeAction("stopResponse", {
    response_task_id: stopOpening.response_task.response_task_id,
    response_task_revision: stopOpening.response_task.revision,
  }, null);
  const stopElapsedMs = Date.now() - stopStartedAt;
  assert.equal(stopResult.state.response_task.status, "cancelled");
  assert(stopElapsedMs < 1000, `Stop was blocked after cancellation ownership changed for ${stopElapsedMs}ms`);
  await new Promise((resolve) => setTimeout(resolve, pipelineDelayMs + 100));
  assert.equal(service.getRuntimeServiceState().response_task.status, "cancelled", "stopped automatic pipeline must not publish a late result");

  await writeFile(paths.matchContextFile, `${JSON.stringify({
    schema: "jcc-runtime-match-context-v1",
    match_session_id: matchSessionId,
    recent_user_messages: [],
    choice_confirmations: [{
      kind: "augment",
      choice_stage_round: "2-1",
      choice: "fixture augment",
      source: "event_preemption_fixture",
      observed_at: new Date().toISOString(),
    }],
    observed_choice_options_by_stage: {},
  }, null, 2)}\n`, "utf8");
  await resetScenario("2-2", 88);
  const choiceReservedOpening = await service.handleRuntimeAction("observeRuntimeTick", {}, null);
  assert.equal(choiceReservedOpening.status, "response_preparing", `fixed 2-2 checkpoint must own the automatic lane before 2-1 reservation; result=${JSON.stringify({ status: choiceReservedOpening.status, message: choiceReservedOpening.message, events: choiceReservedOpening.runtime_events })}`);
  const choiceReservedOpeningTaskId = choiceReservedOpening.response_task.response_task_id;
  const choiceReservedOpeningEventKey = choiceReservedOpening.response_task.event_key;
  await writeLiveState(liveStateFile, "2-1", 88, service);
  const choiceWindowResult = await service.handleRuntimeAction("observeRuntimeTick", {}, null);
  assert.equal(
    choiceWindowResult.state?.runtime_event_detector?.last_snapshot?.stage_round,
    "2-1",
    "2-1 choice-window transition must update the fact snapshot while fixed strategic advice is preparing",
  );
  const choiceWindowState = service.getRuntimeServiceState();
  assert.equal(choiceWindowState.response_task?.response_task_id, null, "choice-window reservation must release the automatic Host lane");
  assert.equal(choiceWindowState.response_task?.status, "superseded_by_choice_window", "choice-window reservation must supersede the preparing automatic task with an explicit terminal status");
  assert(
    Object.values(choiceWindowState.runtime_event_advice?.handled || {}).some((entry) => (
      entry?.response_task_id === choiceReservedOpeningTaskId
      && entry?.status === "superseded_by_choice_window"
    )),
    "the displaced fixed strategic task must remain auditable after choice-window preemption",
  );
  assert(
    !Object.values(choiceWindowState.runtime_event_advice?.retry_pending || {}).some((retry) => (
      retry?.status === "pending_retry"
      && retry?.event_key === choiceReservedOpeningEventKey
    )),
    "the displaced strategic answer must not return during the 2-1 choice window",
  );
  await new Promise((resolve) => setTimeout(resolve, pipelineDelayMs + 100));
  assert.equal(service.getRuntimeServiceState().response_task?.response_task_id, null, "late strategic pipeline result must not reclaim the reserved choice lane");

  await resetScenario("1-2", 88);
  const structuredCardOpening = await service.handleRuntimeAction("observeRuntimeTick", {}, null);
  const structuredCardTask = {
    ...structuredCardOpening.response_task,
    mode: "augment_choice",
    structured_card_action: true,
    expiry_policy: "structured_card_action_must_return_unless_superseded_by_user",
    event_priority: 88,
  };
  service.setRuntimeServiceState({
    ...service.getRuntimeServiceState(),
    active_mode: "augment_choice",
    response_task: structuredCardTask,
  });
  await writeLiveState(liveStateFile, "2-1", 88, service);
  const structuredChoiceWindowResult = await service.handleRuntimeAction("observeRuntimeTick", {}, null);
  assert.equal(
    structuredChoiceWindowResult.state?.runtime_event_detector?.last_snapshot?.stage_round,
    "2-1",
    "structured-card protection scenario must observe the 2-1 choice window in the fact snapshot",
  );
  assert.equal(
    service.getRuntimeServiceState().response_task?.response_task_id,
    structuredCardTask.response_task_id,
    "choice-window events must not preempt an explicit structured-card answer owner",
  );
  await writeLiveState(liveStateFile, "2-6", 24, service);
  const structuredDangerResult = await service.handleRuntimeAction("observeRuntimeTick", {}, null);
  assert.equal(
    structuredDangerResult.state?.runtime_event_detector?.last_snapshot?.hp_bucket,
    "danger",
    "dangerous HP must update the fact snapshot without opening an automatic Host task",
  );
  assert(
    !structuredDangerResult.runtime_events?.some((event) => event.type === "hp_pressure_bucket_changed"),
    "dangerous HP must remain supporting evidence instead of becoming an automatic response owner",
  );
  assert.equal(
    service.getRuntimeServiceState().response_task?.response_task_id,
    structuredCardTask.response_task_id,
    "fact-only HP and stage changes must not preempt an explicit structured-card answer owner",
  );
  await service.handleRuntimeAction("stopResponse", {
    response_task_id: structuredCardTask.response_task_id,
    response_task_revision: service.getRuntimeServiceState().response_task.revision,
  }, null);
  await new Promise((resolve) => setTimeout(resolve, pipelineDelayMs + 100));

  await resetScenario("2-2", 88);
  const fixedStrategicOpening = await service.handleRuntimeAction("observeRuntimeTick", {}, null);
  const fixedStrategicTaskId = fixedStrategicOpening.response_task.response_task_id;
  const beforeDanger = service.getRuntimeServiceState();
  const resolvedAt = new Date().toISOString();
  service.setRuntimeServiceState({
    ...beforeDanger,
    runtime_triggers: {
      ...(beforeDanger.runtime_triggers || {}),
      missing_choice_prompts: {
        "2-1:augment": { asked_at: resolvedAt, confirmed_at: resolvedAt },
        "2-4:god": { asked_at: resolvedAt, confirmed_at: resolvedAt },
      },
    },
  });
  await writeLiveState(liveStateFile, "2-6", 24, service);
  const highPriorityResult = await service.handleRuntimeAction("observeRuntimeTick", {}, null);
  assert.equal(highPriorityResult.state?.runtime_event_detector?.last_snapshot?.stage_round, "2-6", "2-6 stage must update while fixed strategic work is preparing");
  assert.equal(highPriorityResult.state?.runtime_event_detector?.last_snapshot?.hp_bucket, "danger", "dangerous HP must remain available in the latest fact snapshot");
  assert(!highPriorityResult.runtime_events?.some((event) => event.type === "hp_pressure_bucket_changed"), "dangerous HP must not create an independent automatic Host event");
  const currentTask = service.getRuntimeServiceState().response_task;
  assert.notEqual(currentTask?.event_type, "hp_pressure_bucket_changed", "dangerous HP must never own the automatic response lane");
  assert(
    currentTask?.response_task_id === fixedStrategicTaskId
      || currentTask?.runtime_event_context?.strategic_obligation,
    `only the fixed strategic obligation may retain or replace the response owner: ${JSON.stringify(currentTask)}`,
  );
  assert.equal(service.getRuntimeServiceState().runtime_event_detector?.last_snapshot?.stage_round, "2-6", "event detector must advance even when an automatic task was already running");
  await service.handleRuntimeAction("stopResponse", {
    response_task_id: currentTask.response_task_id,
    response_task_revision: currentTask.revision,
  }, null);
  await new Promise((resolve) => setTimeout(resolve, pipelineDelayMs + 100));

  await resetScenario("2-2", 61);
  const failedTaskRevision = 7;
  service.setRuntimeServiceState({
    ...baseState(),
    response_task_revision: failedTaskRevision,
    response_task: {
      status: "failed",
      response_task_id: "user-host-timeout",
      revision: failedTaskRevision,
      origin: "user",
      mode: "cruise",
      match_session_id: matchSessionId,
      error: "host_coach_response_running_timeout",
      failed_at: new Date().toISOString(),
    },
  });
  const failedDelivery = await service.handleRuntimeAction("deliverReadyResponse", {}, null);
  assert.equal(failedDelivery.status, "response_failed", "a failed user host task must remain visible to the renderer");
  assert.equal(failedDelivery.response_task?.response_task_id, "user-host-timeout", "failed delivery must preserve task identity");
  const failedAck = await service.handleRuntimeAction("ackDeliveredResponse", {
    response_task_id: "user-host-timeout",
    response_task_revision: failedTaskRevision,
    reason: "failed_user_task_rendered",
  }, null);
  assert.equal(failedAck.status, "delivered", "renderer ACK must release a failed user task");
  assert.equal(failedAck.state?.response_task?.response_task_id, null, "failed user task ACK must release the only response lane");
  await writeLiveState(liveStateFile, "2-5", 58, service);
  const resumedAfterFailure = await service.handleRuntimeAction("observeRuntimeTick", {}, null);
  assert.equal(
    service.getRuntimeServiceState().runtime_event_detector?.last_snapshot?.stage_round,
    "2-5",
    "cruise must observe the latest stage after a failed user task is delivered and ACKed",
  );
  assert(
    !(resumedAfterFailure.runtime_events || []).some((event) => (
      event.stage_round === "2-5"
      && !event.fixed_checkpoint_id
      && !event.strategic_obligation
    )),
    "ordinary 2-5 stage changes must update facts without reopening the automatic Host lane",
  );
  if (resumedAfterFailure.response_task?.response_task_id) {
    assert(
      resumedAfterFailure.response_task?.runtime_event_context?.fixed_checkpoint_id
        || resumedAfterFailure.response_task?.runtime_event_context?.strategic_obligation,
      "only a fixed strategic obligation may own the resumed automatic response lane",
    );
  }
  assert.notEqual(resumedAfterFailure.status, "response_pending", "cruise must not stay pending after failed user-task ACK");
  assert.notEqual(resumedAfterFailure.status, "response_running", "cruise must not stay running after failed user-task ACK");
  if (resumedAfterFailure.response_task?.response_task_id) {
    await service.handleRuntimeAction("stopResponse", {
      response_task_id: resumedAfterFailure.response_task.response_task_id,
      response_task_revision: resumedAfterFailure.response_task.revision,
    }, null);
  }

  console.log(JSON.stringify({
    ok: true,
    preparing_elapsed_ms: preparingElapsedMs,
    stop_elapsed_ms: stopElapsedMs,
    checked: [
      "automatic event gate canonicalizes a revisioned preparing task before slow pipeline work",
      "automatic event pipeline settles preparing into durable awaiting-host or no-advice state",
      "manual sendMessage preempts a slow automatic opening task without waiting for its pipeline",
      "Stop cancels preparing automatic work and late detached completion cannot overwrite cancellation",
      "2-1 choice-window reservation preempts stale opening work without retrying it and fences the late result",
      "future 3-2 prediction does not reserve or preempt the current 2-7 strategic task",
      "choice-window and fact-only HP/stage changes preserve an explicit structured-card answer owner",
      "non-fixed stage and dangerous HP update the fact snapshot but never open or preempt the Host answer lane",
      "failed user host task remains deliverable, exact ACK releases the lane, and later fixed strategic obligations may resume without ordinary stage-event pollution",
    ],
  }, null, 2));

  service.setRuntimeServiceCanonicalStateWriter(null);
}

main()
  .finally(removeTempRoot)
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
