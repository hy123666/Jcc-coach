import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { isCruiseFixedCheckpointStage } from "../ui/electron/cruise-checkpoint-agenda.js";
import {
  acceptanceReport, assertExpectedValidTask, journeyOptions, observeJourneyRuntimeRequests,
  REQUIRED_JOURNEY_TURNS, simulatedJourneyResponse, writeJourneyEvidence,
} from "./jcc-player-journey-acceptance.mjs";

const acceptanceOptions = journeyOptions();
if (acceptanceOptions.help || acceptanceOptions.plan) {
  console.log(JSON.stringify({
    usage: "node tools/verify-jcc-full-player-journey-sim.mjs [--real-host --provider codex|kimi --model MODEL --reasoning low]",
    default: "No provider calls; simulated responses must pass production validation and exact Runtime UI ACK.",
    real_host: "Detect and preset Host once, then use Runtime-generated requests through runHostModel in one Match provider session. No live run is started by --plan.",
    required_turns: REQUIRED_JOURNEY_TURNS,
    limits: acceptanceOptions,
    progress: "stderr per-step and heartbeat; stdout final JSON only",
  }, null, 2));
  process.exit(0);
}
const acceptanceTurns = [];
let requestObserver = null;
let matchProviderSessionId = null;
let detectedJourneyHost = null;
let currentStep = "initializing";
let failureStep = null;
let checkpointFailure = null;
const journeyTraces = new Map();
const journeyValidationFailures = new Map();
const rejectedResponses = [];
const nativeUsageEvents = [];
const requestSizes = new Map();
let activeAttempt = null;
function observeNativeNotification(message) {
  if (message.method !== "thread/tokenUsage/updated") return;
  nativeUsageEvents.push({ observed_at: new Date().toISOString(), ...structuredClone(message.params) });
}
function nativeUsageForAttempt(attempt, sessionId) {
  const matches = nativeUsageEvents.slice(attempt.native_event_start).filter((event) => !sessionId || event.threadId === sessionId);
  const previous = nativeUsageEvents.slice(0, attempt.native_event_start).filter((event) => !sessionId || event.threadId === sessionId).at(-1);
  const latest = matches.at(-1);
  const total = latest?.tokenUsage?.total;
  const baseline = previous?.tokenUsage?.total;
  return { source: "codex_thread/tokenUsage/updated", status: latest ? "observed" : "not_observed",
    prior_session_total: baseline || null, session_total: total || null,
    current_attempt_delta: total ? Object.fromEntries(Object.entries(total).filter(([, value]) => Number.isFinite(value)).map(([key, value]) => [key, value - (baseline?.[key] || 0)])) : null,
    baseline_kind: baseline ? "observed_before_dispatch" : "new_session_no_prior_usage_observed",
    last_native_turn: latest?.tokenUsage?.last || null, events: matches };
}
function fieldSizes(value, prefix = "", depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    return [{ field: name, bytes: bytes(child) }, ...(!Array.isArray(child) ? fieldSizes(child, name, depth + 1) : [])];
  }).sort((a, b) => b.bytes - a.bytes).slice(0, 40);
}

const root = process.cwd();
const acceptanceReportFile = acceptanceOptions.report ? path.resolve(root, acceptanceOptions.report) : null;
async function persistAcceptanceSnapshot(report) {
  const files = new Set([acceptanceReportFile || (acceptanceOptions.realHost ? path.join(root, ".omx/runtime-evidence/architecture-real-journey.json") : null)].filter(Boolean));
  for (const file of files) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  }
}
let progressFile = null;
const JOURNEY_DEADLINE_MS = Number(process.env.JCC_VERIFY_FULL_PLAYER_JOURNEY_DEADLINE_MS || (acceptanceOptions.realHost ? 3_600_000 : 480_000));
const CHILD_PROCESS_TIMEOUT_MS = 10_000;
const JOURNEY_VARIANT = String(process.env.JCC_VERIFY_FULL_PLAYER_JOURNEY_VARIANT || "baseline").trim() || "baseline";
const JOURNEY_MATCH_ID = String(process.env.JCC_VERIFY_FULL_PLAYER_JOURNEY_MATCH_ID || `journey-match-${JOURNEY_VARIANT}`).trim();
const JOURNEY_ITEM_CHOICE_KIND = String(process.env.JCC_VERIFY_FULL_PLAYER_JOURNEY_ITEM_CHOICE_KIND || "completed_item_forge").trim();

function fileUrl(file, tag) {
  return `${pathToFileURL(path.resolve(root, file)).href}?${tag}`;
}

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeoutMs || CHILD_PROCESS_TIMEOUT_MS);
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`node ${args.join(" ")} timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`node ${args.join(" ")} exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  });
}

function bytes(value) {
  const encoded = JSON.stringify(value);
  return Buffer.byteLength(encoded === undefined ? "undefined" : encoded, "utf8");
}

function expectHostRequest(result, label) {
  assert.equal(result.ok, true, `${label} should succeed`);
  assert.equal(result.status, "awaiting_host_cli_agent_response", `${label} should stop at host request under disabled host execution`);
  assert(result.host_request, `${label} should expose host_request`);
  return result.host_request;
}

function responseTaskFromResult(result) {
  return result?.response_task || result?.state?.response_task || null;
}

async function waitForResponseTaskStatus(
  service,
  window,
  responseTaskId,
  statuses,
  timeoutMs = Number(process.env.JCC_VERIFY_RESPONSE_PREPARATION_TIMEOUT_MS || 30_000),
) {
  const accepted = new Set(statuses);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await service.handleRuntimeAction("getState", {}, window);
    const task = current.state?.response_task;
    if ((task?.response_task_id === responseTaskId || task?.previous_response_task_id === responseTaskId)
      && ["failed", "no_advice", "cancelled", "expired"].includes(task.status)) {
      throw new Error(`expected valid fixture ${responseTaskId} reached ${task.status}: ${task.error || ""}`);
    }
    const ownsObservedTask = task?.response_task_id === responseTaskId
      || (task?.status === "no_advice" && task?.previous_response_task_id === responseTaskId);
    if (ownsObservedTask && accepted.has(task.status)) {
      return { ok: true, status: task.status, state: current.state, response_task: task, host_request: task.host_request || null };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const current = await service.handleRuntimeAction("getState", {}, window);
  const handled = Object.values(current.state?.runtime_event_advice?.handled || {})
    .find((entry) => entry?.response_task_id === responseTaskId || entry?.previous_response_task_id === responseTaskId) || null;
  const task = current.state?.response_task;
  throw new Error(`response task ${responseTaskId} did not reach ${[...accepted].join("/")}; current=${JSON.stringify({
    status: task?.status, response_task_id: task?.response_task_id, revision: task?.revision,
    mode: task?.mode, provider_invocation_task_id: task?.provider_invocation_task_id,
    error: task?.error, handled_status: handled?.status,
  })}`);
}

function assertRevisionedResponseTask(result, label) {
  const task = responseTaskFromResult(result);
  assert(task?.response_task_id, `${label} should expose response_task_id`);
  assert(Number.isInteger(task.revision) && task.revision > 0, `${label} should expose a positive response_task revision`);
  return task;
}

async function completeDeliverAndAckTask(service, window, pendingResult, label, response = {}) {
  const pendingTask = assertRevisionedResponseTask(pendingResult, label);
  assertExpectedValidTask(pendingTask, label);
  const request = requestObserver.resolve(pendingTask, pendingResult);
  const currentOwner = service.getRuntimeServiceState().response_task;
  for (const key of ["response_task_id", "revision", "mode", "origin", "match_session_id"]) {
    assert.equal(currentOwner?.[key], pendingTask[key], `${label}: live task ${key} changed before Host dispatch`);
  }
  const taskObligation = pendingTask.runtime_event_context?.strategic_obligation;
  const requestContract = service.journeyStrategicContract(request);
  if (pendingTask.mode === "cruise" && taskObligation?.completion_receipts?.length) {
    if (!requestContract?.completion_receipts?.length) {
      const evidence = await writeJourneyEvidence({ repoRoot: root, label, request, task: pendingTask, contract: requestContract, state: service.getRuntimeServiceState() });
      process.stderr.write(`[journey-sim] contract mismatch evidence: ${evidence}\n`);
    }
    assert(requestContract?.completion_receipts?.length, `${label}: Runtime task requires strategic coverage but generated Host request has no strategic contract; ${JSON.stringify({
      task_id: pendingTask.response_task_id, request_id: request.request_id,
      task_receipts: taskObligation.completion_receipts,
      request_mode: request.mode,
      request_event: request.runtime_event_context || request.context?.task?.runtime_event_context || null,
      fit_obligation: request.runtime_context?.strategy_fit_packet?.strategic_obligation || null,
      expected_shape: request.expected_response_shape,
    })}`);
  }
  const preparedAt = Date.now();
  const taskStarted = Date.parse(pendingTask.started_at || pendingTask.preparing_since || pendingTask.awaiting_since || "");
  assert(Number.isFinite(taskStarted), `${label}: preparation timestamp missing`);
  const preparationMs = Math.max(0, preparedAt - taskStarted);
  const requestBytes = assertBoundedProviderTurnDelta(service, request, label);
  activeAttempt = { label, request_id: request.request_id, task_id: pendingTask.response_task_id,
    started_at: new Date().toISOString(), native_event_start: nativeUsageEvents.length,
    turn_delta_bytes: requestBytes, evidence_fields: requestSizes.get(request.request_id) };
  mark(`${label}: ${acceptanceOptions.realHost ? "real runHostModel" : "simulated Host + production validation"}; request ${request.request_id}`);
  let completedTask;
  let dispatchTrace = null;
  if (acceptanceOptions.realHost) {
    // This production completion owner calls runHostModel and persists its
    // validated response, including quick-capture facts, before UI delivery.
    service.journeyRunBackground({ hostRequest: request, taskId: pendingTask.response_task_id, requestedMode: pendingTask.mode, origin: pendingTask.origin });
    const ready = await waitForResponseTaskStatus(service, window, pendingTask.response_task_id, ["completed"], acceptanceOptions.hostLimitMs);
    completedTask = ready.response_task;
    dispatchTrace = journeyTraces.get(pendingTask.response_task_id);
    assert(dispatchTrace?.provider_dispatch_at, `${label}: --real-host requires production dispatch evidence, not only an execution flag`);
    assert.equal(dispatchTrace.semantic_validation_status, "passed", `${label}: production validation trace missing`);
    const state = (await service.handleRuntimeAction("getState", {}, window)).state;
    const sessionId = state.host_sessions?.match?.provider_session_id;
    assert(sessionId, `${label}: real Host must expose its Match provider session`);
    if (matchProviderSessionId) assert.equal(sessionId, matchProviderSessionId, `${label}: Match provider session was replaced`);
    matchProviderSessionId = sessionId;
    if (request.request_kind === "match_fact_capture") {
      assert(completedTask.response?.fact_capture_result?.accepted?.length > 0, `${label}: valid quick capture must persist facts`);
    } else {
      service.normalizeHostCoachResponse(completedTask.response, request);
    }
  } else {
    const mock = simulatedJourneyResponse(service, request, label, response);
    let normalized = service.normalizeHostCoachResponse(mock, request);
    assert(normalized.final_text?.trim(), `${label}: production normalization requires body text`);
    if (request.request_kind === "match_fact_capture") {
      const capture = await service.journeyApplyCapture(normalized.fact_capture, {
        taskId: pendingTask.response_task_id, matchSessionId: pendingTask.match_session_id,
        isCurrent: () => service.getRuntimeServiceState().response_task?.response_task_id === pendingTask.response_task_id,
      });
      assert.equal(capture.ok, true, `${label}: Runtime fact persistence failed`);
      assert(capture.receipt?.accepted?.length > 0, `${label}: valid quick capture must persist facts`);
      normalized = { ...normalized, final_text: capture.final_text, fact_capture_result: capture.receipt };
    }
    const currentState = (await service.handleRuntimeAction("getState", {}, window)).state;
    assert.equal(currentState.response_task?.response_task_id, pendingTask.response_task_id, `${label}: completion owner changed`);
    const revision = currentState.response_task.revision + 1;
    service.setRuntimeServiceState({
      ...currentState, response_task_revision: revision,
      response_task: { ...currentState.response_task, status: "completed", revision, completed_at: new Date().toISOString(), response: normalized },
    });
    completedTask = service.getRuntimeServiceState().response_task;
  }
  assertExpectedValidTask(completedTask, label, { completed: true });
  const completedRevision = completedTask.revision;
  const hostMs = Date.now() - preparedAt;
  const deliveryStarted = Date.now();
  const delivered = await service.handleRuntimeAction("deliverReadyResponse", {}, window);
  const deliveryMs = Date.now() - deliveryStarted;
  assert.equal(delivered.status, "completed", `${label} should be deliverable after host completion`);
  assert.equal(delivered.response_task?.response?.final_text, completedTask.response.final_text, `${label}: delivered body must match validated body`);
  assert.equal(delivered.response_task?.response_task_id, pendingTask.response_task_id, `${label} delivery should preserve task identity`);
  assert.equal(delivered.response_task?.revision, completedRevision, `${label} delivery should expose the completed revision`);

  const staleAckStarted = Date.now();
  const staleAck = await service.handleRuntimeAction("ackDeliveredResponse", {
    response_task_id: pendingTask.response_task_id,
    response_task_revision: pendingTask.revision,
    reason: `${label}_stale_ack_probe`,
  }, window);
  assert.equal(staleAck.ok, false, `${label} stale revision ACK must be rejected`);
  const staleAckMs = Date.now() - staleAckStarted;
  assert.equal(staleAck.status, "response_task_revision_mismatch", `${label} stale ACK should fail on revision mismatch`);

  const exactAckStarted = Date.now();
  const ack = await service.handleRuntimeAction("ackDeliveredResponse", {
    response_task_id: pendingTask.response_task_id,
    response_task_revision: completedRevision,
    reason: `${label}_rendered`,
  }, window);
  assert.equal(ack.status, "delivered", `${label} exact task/revision ACK should succeed`);
  const exactAckMs = Date.now() - exactAckStarted;
  assert.equal(ack.state?.response_task?.response_task_id, null, `${label} exact ACK should release the response lane`);
  acceptanceTurns.push({ label, request_id: request.request_id, task_id: pendingTask.response_task_id,
    request_kind: request.request_kind || "host_question", task_revision: completedRevision,
    normalized: true, acknowledged: true, body_chars: completedTask.response.final_text.length,
    preparation_ms: preparationMs, host_ms: hostMs, delivery_ms: deliveryMs,
    stale_ack_ms: staleAckMs, ack_ms: exactAckMs,
    turn_delta_bytes: requestBytes, provider_session_id: acceptanceOptions.realHost ? matchProviderSessionId : null,
    real_host_dispatch: Boolean(dispatchTrace?.provider_dispatch_at),
    provider_dispatch_at: dispatchTrace?.provider_dispatch_at || null,
    first_token_ms: dispatchTrace?.first_token_ms ?? null,
    provider_elapsed_ms: dispatchTrace?.provider_elapsed_ms ?? null,
    prompt_chars: dispatchTrace?.prompt_chars ?? null,
    prompt_bytes: dispatchTrace?.prompt_bytes ?? null,
    output_chars: completedTask.response.final_text.length,
    output_bytes: Buffer.byteLength(completedTask.response.final_text, "utf8"),
    native_usage: acceptanceOptions.realHost ? nativeUsageForAttempt(activeAttempt, matchProviderSessionId) : null,
    validation_failures: journeyValidationFailures.get(pendingTask.response_task_id) || [],
    evidence_fields: activeAttempt.evidence_fields,
    target_met: hostMs <= acceptanceOptions.hostTargetMs,
    evidence_status: "validated_current_runtime_request",
  });
  requestObserver.release(pendingTask, request);
  activeAttempt = null;
  await persistAcceptanceSnapshot({ schema: "jcc-full-player-journey-progress-v1", status: "running", updated_at: new Date().toISOString(), current_step: label, real_host: acceptanceOptions.realHost, turns: acceptanceTurns });
  mark(`${label}: validated and ACKed revision ${completedRevision}; host ${hostMs}ms`);
  return { pendingTask, completedRevision, delivered, ack, response: completedTask.response };
}

async function deliverAndAckCompletedTask(service, window, completedResult, label) {
  const task = assertRevisionedResponseTask(completedResult, label);
  assertExpectedValidTask(task, label, { completed: true });
  const delivered = await service.handleRuntimeAction("deliverReadyResponse", {}, window);
  assert.equal(delivered.status, "completed", `${label} should remain visible until renderer ACK`);
  assert.equal(delivered.response_task?.revision, task.revision, `${label} delivery should preserve its exact revision`);
  const ack = await service.handleRuntimeAction("ackDeliveredResponse", {
    response_task_id: task.response_task_id,
    response_task_revision: task.revision,
    reason: `${label}_rendered`,
  }, window);
  assert.equal(ack.status, "delivered", `${label} exact task/revision ACK should succeed`);
  assert.equal(ack.state?.response_task?.response_task_id, null, `${label} ACK should release the response lane`);
  return { task, delivered, ack };
}

async function advanceStageAndDrain({ service, window, liveStateFile, stageRound, economy = {} }) {
  mark(`observe stage ${stageRound}`);
  await writeLiveState(liveStateFile, stageRound, economy);
  const result = await service.handleRuntimeAction("observeRuntimeTick", {}, window);
  assert.notEqual(result.status, "response_pending", `${stageRound} must not inherit a stale pending response lane`);
  assert.notEqual(result.status, "response_running", `${stageRound} must not inherit a stale running response lane`);
  if (!isCruiseFixedCheckpointStage(stageRound)) {
    if (["response_preparing", "awaiting_host_cli_agent_response", "completed"].includes(result.status)) {
      const current = await service.handleRuntimeAction("getState", {}, window);
      throw new Error(`${stageRound} non-fixed stage opened a Host answer: ${JSON.stringify({
        result_status: result.status,
        response_task: current.state?.response_task || responseTaskFromResult(result) || null,
        strategic_obligations: current.state?.runtime_strategic_obligations || null,
        runtime_events: result.runtime_events || [],
      })}`);
    }
    assert.notEqual(result.status, "response_preparing", `${stageRound} is not a fixed strategic checkpoint and must not open a Host answer`);
    assert.notEqual(result.status, "awaiting_host_cli_agent_response", `${stageRound} is not a fixed strategic checkpoint and must not wait for Host`);
    assert.notEqual(result.status, "completed", `${stageRound} is not a fixed strategic checkpoint and must not publish an automatic answer`);
    assert.equal(
      responseTaskFromResult(result)?.response_task_id || null,
      null,
      `${stageRound} is not a fixed strategic checkpoint and must leave the response lane idle`,
    );
    return result;
  }
  const checkpointRegistered = result.runtime_events?.some((event) => (
      event.fixed_checkpoint_stage_round === stageRound
      && event.fixed_checkpoint_id
      && event.strategy_block_id
    ));
  if (!checkpointRegistered) {
    const current = await service.handleRuntimeAction("getState", {}, window);
    checkpointFailure = {
      stage_round: stageRound,
      status: result.status,
      runtime_events: result.runtime_events || [],
      advice_eligible_events: result.advice_eligible_events || [],
      live_state_input: JSON.parse(await readFile(liveStateFile, "utf8")),
      state: current.state,
    };
  }
  assert(
    checkpointRegistered,
    `${stageRound} fixed strategic checkpoint should expose its registered checkpoint and strategic-block identity`,
  );
  assert.notEqual(result.status, "no_advice", `${stageRound} fixed strategic checkpoint must remain a delivery obligation`);
  const fixedCheckpointFailureContext = !["response_preparing", "awaiting_host_cli_agent_response", "completed"].includes(result.status)
    ? await service.handleRuntimeAction("getState", {}, window)
    : null;
  assert(
    ["response_preparing", "awaiting_host_cli_agent_response", "completed"].includes(result.status),
    `${stageRound} fixed strategic checkpoint must enter the durable Host delivery lane; ${JSON.stringify({
      status: result.status,
      response_task: fixedCheckpointFailureContext?.state?.response_task || result.response_task || null,
      runtime_events: result.runtime_events || [],
      advice_eligible_events: result.advice_eligible_events || [],
      retry_advice_events: result.retry_advice_events || [],
      runtime_strategic_obligations: fixedCheckpointFailureContext?.state?.runtime_strategic_obligations || null,
      runtime_event_advice: fixedCheckpointFailureContext?.state?.runtime_event_advice || null,
      runtime_event_detector: fixedCheckpointFailureContext?.state?.runtime_event_detector || null,
    })}`,
  );
  if (result.status === "response_preparing") {
    const preparingTask = assertRevisionedResponseTask(result, `${stageRound} preparing task`);
    const ready = await waitForResponseTaskStatus(
      service,
      window,
      preparingTask.response_task_id,
      ["awaiting_host_cli_agent_response", "completed"],
    );
    if (ready.status === "awaiting_host_cli_agent_response") {
      await completeDeliverAndAckTask(service, window, ready, `stage_${stageRound.replace("-", "_")}`);
    } else if (ready.status === "completed") {
      await deliverAndAckCompletedTask(service, window, ready, `stage_${stageRound.replace("-", "_")}`);
    } else throw new Error(`${stageRound}: expected valid task did not complete`);
  } else if (result.status === "awaiting_host_cli_agent_response") {
    await completeDeliverAndAckTask(service, window, result, `stage_${stageRound.replace("-", "_")}`);
  } else if (result.status === "completed" && responseTaskFromResult(result)?.response_task_id) {
    await deliverAndAckCompletedTask(service, window, result, `stage_${stageRound.replace("-", "_")}`);
  }
  return result;
}

function publishableLineupResponse(hostRequest) {
  const strategicObligation = hostRequest?.runtime_context?.absorbed_cruise_obligation?.strategic_obligation
    || hostRequest?.runtime_context?.strategy_fit_packet?.strategic_obligation
    || hostRequest?.runtime_context?.strategy_fit_packet?.next_coach_plan?.strategic_obligation
    || null;
  const candidateMembers = (candidate) => candidate?.atomic_roster_members
    || candidate?.canonical_variant?.atomic_roster_members
    || candidate?.atomic_roster?.atomic_roster_members
    || [];
  const workingSet = [
    hostRequest?.runtime_context?.strategy_fit_packet?.candidate_working_set,
    hostRequest?.context?.runtime_context?.strategy_fit_packet?.candidate_working_set,
    hostRequest?.runtime_context?.cruise_decision_context?.strategy_fit_packet?.candidate_working_set,
  ].find(Array.isArray);
  const candidatePool = workingSet ?? [
    hostRequest?.selected_ranking_candidates?.candidates,
    hostRequest?.runtime_context?.selected_ranking_candidates?.candidates,
    hostRequest?.context?.runtime_context?.selected_ranking_candidates?.candidates,
  ].find((candidates) => Array.isArray(candidates) && candidates.length) ?? [];
  const candidateIdentity = (candidate) => candidate?.candidate_id || candidate?.line_id || candidate?.id || null;
  const variantIdentity = (candidate) => candidate?.selected_variant_id
    || candidate?.variant_id
    || candidate?.atomic_roster_id
    || candidate?.canonical_variant?.variant_id
    || candidate?.canonical_variant?.atomic_roster_id
    || null;
  const completeByIdentity = new Map();
  for (const candidate of candidatePool.filter((entry) => candidateMembers(entry).length)) {
    const candidateId = candidateIdentity(candidate);
    const variantId = variantIdentity(candidate);
    if (candidateId && variantId && !completeByIdentity.has(`${candidateId}|${variantId}`)) {
      completeByIdentity.set(`${candidateId}|${variantId}`, candidate);
    }
  }
  const hydratedCandidatePool = candidatePool.map((candidate) => {
    if (candidateMembers(candidate).length) return candidate;
    const candidateId = candidateIdentity(candidate);
    const variantId = variantIdentity(candidate);
    return completeByIdentity.get(`${candidateId}|${variantId}`) || candidate;
  });
  const candidates = [];
  const selectedCandidateIds = new Set();
  for (const candidate of hydratedCandidatePool) {
    const candidateId = candidate?.candidate_id;
    if (!candidateId || selectedCandidateIds.has(candidateId)) continue;
    if ((candidate?.roster_is_atomic ?? candidate?.canonical_variant?.roster_is_atomic) === false) continue;
    if (!candidateMembers(candidate).length) continue;
    if (!(candidate?.candidate_evidence_id || candidate?.canonical_variant?.candidate_evidence_id)) continue;
    if (!candidate?.main_carry || !(candidate?.primary_tank || candidate?.main_tank)) continue;
    selectedCandidateIds.add(candidateId);
    candidates.push(candidate);
    if (candidates.length >= 3) break;
  }
  assert(candidates.length >= 1, `lineup journey fixture requires at least one complete strategic candidate; available=${JSON.stringify(hydratedCandidatePool.slice(0, 5).map((candidate) => ({
    candidate_id: candidate?.candidate_id || candidate?.line_id || candidate?.id || null,
    roster_is_atomic: candidate?.roster_is_atomic ?? candidate?.canonical_variant?.roster_is_atomic ?? null,
    member_count: candidateMembers(candidate).length,
    candidate_evidence_id: candidate?.candidate_evidence_id || candidate?.canonical_variant?.candidate_evidence_id || null,
    main_carry: candidate?.main_carry || null,
    primary_tank: candidate?.primary_tank || candidate?.main_tank || null,
  })))}`);
  const selected = candidates[0];
  const canonical = selected?.canonical_variant || selected?.strategy_profile?.canonical_variant || selected;
  const names = candidateMembers(selected)
    .map((unit) => unit?.champion_name || unit?.name || null)
    .filter(Boolean);
  assert(names.length >= 5, "lineup journey fixture requires enough atomic-roster champion names");
  const selectedVariantId = selected?.selected_variant_id
    || selected?.variant_id
    || selected?.atomic_roster_id
    || canonical?.selected_variant_id
    || canonical?.variant_id
    || canonical?.atomic_roster_id;
  assert(selectedVariantId, "lineup journey fixture requires an exact canonical variant identity");
  const cleanNames = (value) => [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry?.name || entry?.id || entry || "").trim())
    .filter(Boolean))];
  const canonicalLoadouts = (Array.isArray(canonical?.loadouts)
    ? canonical.loadouts
    : Array.isArray(canonical?.equipment_plan)
      ? canonical.equipment_plan
      : Array.isArray(selected?.loadouts)
        ? selected.loadouts
        : Array.isArray(selected?.equipment_plan)
          ? selected.equipment_plan
          : [])
    .map((entry) => ({
      unit: String(entry?.unit || entry?.name || entry?.champion || entry?.champion_name || "").trim(),
      items: cleanNames(entry?.items || entry?.equipment || entry?.item_names).slice(0, 3),
    }))
    .filter((entry) => entry.unit && entry.items.length);
  const roleName = (role) => typeof role === "string" ? role.trim()
    : String(role?.champion_name || role?.name || role?.display_name || "").trim();
  const mainCarry = roleName(canonical?.main_carry || canonical?.primary_carry || selected?.main_carry);
  const mainTank = roleName(canonical?.main_tank || canonical?.primary_tank || selected?.main_tank || selected?.primary_tank);
  assert(names.includes(mainCarry) && names.includes(mainTank), "fixture roles must name champions in the atomic roster");
  const coreTraits = cleanNames(canonical?.core_traits || canonical?.main_traits || selected?.core_traits || selected?.main_traits);
  const augmentConditions = cleanNames(canonical?.augment_conditions || canonical?.associated_augments || selected?.augment_conditions);
  const transitionPath = cleanNames(canonical?.transition_path || canonical?.transition_steps || canonical?.transition_populations || selected?.transition_path);
  const formationBurden = String(canonical?.formation_burden || selected?.formation_burden || "medium").trim();
  const cap = String(canonical?.cap || canonical?.ceiling || selected?.cap || "完成目标人口并补齐核心两星质量").trim();
  const floor = String(canonical?.floor || selected?.floor || "保持核心羁绊与主C主坦基础质量").trim();
  assert(mainCarry && mainTank && coreTraits.length, "lineup journey fixture requires canonical carry, tank, and trait evidence");
  const requiredDecisions = strategicObligation?.required_decisions || [];
  return {
    schema: "jcc-host-cli-coach-response-v1",
    generated_by: "current_cli_agent_main_model",
    request_id: hostRequest.request_id,
    request_hash: hostRequest.request_hash,
    mode: hostRequest.mode,
    final_text: candidates.map((candidate, index) => {
      const candidateName = candidate?.display_name || candidate?.line || candidate?.candidate_id;
      const roster = candidateMembers(candidate).map((unit) => unit?.champion_name || unit?.name).filter(Boolean).join("、");
      return `候选${index + 1}【${candidateName}】完整成员：${roster}`;
    }).join("；") + `。最终阵容卡锁定候选1【${selected?.display_name || selected?.line || selected?.candidate_id}】，其余候选仅作独立比较，不混入卡片。`,
    ...(strategicObligation?.completion_receipts?.length ? {
      strategic_completion: {
        queue_revision: strategicObligation.queue_revision,
        completion_receipts: strategicObligation.completion_receipts,
        covered_required_decisions: requiredDecisions,
        decision_outputs: Object.fromEntries(requiredDecisions.map((decision) => [decision, `已在阵容卡中完成 ${decision}`])),
      },
      strategy_selection: {
        status: "selected",
        selected_candidate_ids: candidates.map((candidate) => candidate.candidate_id),
        candidate_presentations: candidates,
      },
    } : {}),
    lineup_handoff: {
      candidate_id: selected.candidate_id,
      variant_id: selectedVariantId,
      target_source: "ranking",
      target_identity: selected?.display_name || selected?.line || selected.candidate_id,
      adjustments: ["结合当前已确认强化、装备和经济节奏执行该原子阵容。"],
      equipment_priority: canonicalLoadouts.flatMap((entry) => entry.items.map((item) => `${entry.unit}:${item}`)),
      positioning_intent: "前排承伤，主C与后排功能单位按当前对手调整。",
    },
  };
}

function mark(step) {
  currentStep = step;
  if (progressFile) appendFileSync(progressFile, `[${new Date().toISOString()}] ${step}\n`, "utf8");
  process.stderr.write(`[journey-sim] ${step}\n`);
}

function summaryHasCoreMatchContext(summary, label, expectedRankingOverlayId) {
  assert(summary.live_state_summary?.phase || summary.live_state_summary?.stage_round, `${label} should include stage/phase`);
  assert(summary.live_state_summary?.economy, `${label} should include hp/gold/level/xp economy`);
  assert(summary.live_state_summary?.own_board, `${label} should include own board`);
  assert(summary.live_state_summary?.own_bench, `${label} should include own bench`);
  assert(summary.live_state_summary?.shop, `${label} should include shop`);
  assert(summary.live_state_summary?.items, `${label} should include item facts`);
  assert(summary.runtime_context?.match_facts?.match_variables, `${label} should include match variables`);
  assert(summary.runtime_context?.match_facts?.latest_user_intent, `${label} should include latest user intent`);
  assert(summary.runtime_context?.game_rule_contract, `${label} should include game rule contract`);
  assert(summary.runtime_context?.coach_rules_brief?.schema === "jcc-runtime-coach-rules-brief-v2", `${label} should include coach rules brief`);
  assert(summary.runtime_context?.game_state_brief, `${label} should include game state brief`);
  assert(summary.runtime_context?.cruise_decision_context, `${label} should include cruise decision context`);
  assert(summary.runtime_context?.strategy_fit_packet, `${label} should include strategy fit packet`);
  assert.equal(summary.daily_big_data?.available, true, `${label} should carry the compatible Active Ranking overlay`);
  assert.equal(summary.daily_big_data?.ranking_overlay_id, expectedRankingOverlayId, `${label} should bind the current immutable Active Ranking generation`);
  assert(Object.keys(summary.daily_big_data?.tiers || {}).length > 0, `${label} should expose current-season Ranking tiers`);
  assert(summary.season_catalog, `${label} should include season catalog`);
}

function assertRuleBoundHostRequest({ request, activeRulesBundle, label }) {
  const runtimeContext = request?.runtime_context || request?.context?.runtime_context || request?.context || {};
  const requestRules = runtimeContext.active_rules_bundle || request?.context?.active_rules_bundle;
  const currentTurn = runtimeContext.current_turn_contract || request?.context?.current_turn_contract;
  assert(requestRules, `${label} should carry the active rules bundle`);
  assert.equal(requestRules.source_fingerprint, activeRulesBundle.source_fingerprint, `${label} should carry the active rules fingerprint`);
  assert.equal(currentTurn?.rules_source_fingerprint, activeRulesBundle.source_fingerprint, `${label} current turn should bind the active rules fingerprint`);
  assert.equal(requestRules.version_identity?.runtime_season_id, activeRulesBundle.version_identity.runtime_season_id, `${label} should use the active major season`);
  assert.equal(requestRules.version_identity?.runtime_patch_id, activeRulesBundle.version_identity.runtime_patch_id, `${label} should use the active minor patch identity`);
  assert.equal(requestRules.season_normal_rules?.scope, "season_normal", `${label} should carry major-season normal rules`);
  assert.equal(requestRules.season_special_rules?.scope, "season_special", `${label} should carry major-season special rules`);
  if (activeRulesBundle.patch_strategy_overrides) {
    assert.equal(requestRules.patch_strategy_overrides?.scope, "patch_strategy", `${label} should carry an explicitly declared minor-patch strategy as its own layer`);
  } else {
    assert(requestRules.patch_strategy_overrides == null, `${label} must not synthesize a minor-patch strategy layer when the active profile declares none`);
  }
  assert.equal(requestRules.source_files?.hard_data_manifest, activeRulesBundle.source_files.hard_data_manifest, `${label} should use the active hard-data manifest`);
}

function assertBoundedProviderTurnDelta(service, request, label) {
  const capsule = service.hostContextCapsuleForRequest(request, {
    routeKey: `match:${request.match_session_id}`,
    provider: request.runtime_context?.host_cli?.provider || "codex",
  });
  const delta = service.compactHostTurnDelta(request, capsule);
  const deltaBytes = bytes(delta);
  requestSizes.set(request.request_id, fieldSizes(delta));
  const maxBytes = service.hostRequestIsStrategicTurn(request)
    ? service.HOST_STRATEGIC_TURN_DELTA_MAX_BYTES
    : service.HOST_TURN_DELTA_MAX_BYTES;
  assert(deltaBytes <= maxBytes, `${label} provider turn delta must stay within the configured hard ceiling; got ${deltaBytes} bytes`);
  assert.equal(delta.schema, "jcc-host-current-turn-delta-v1", `${label} must use the canonical provider turn-delta schema`);
  assert.equal(delta.capsule_ref?.capsule_id, capsule.capsule_id, `${label} turn delta must reference its static capsule`);
  assert.equal(delta.runtime_context?.active_rules_bundle, undefined, `${label} turn delta must not resend the static active-rules bundle`);
  if (request.request_kind === "popular_recipe_query") {
    assert.equal(delta.evidence_policy_id, "popular_recipe_catalog_only", `${label} retains its isolated source authority`);
    assert.equal(delta.runtime_context?.popular_recipe_query_context?.status, "available", `${label} requires actual captured popular evidence`);
    assert.deepEqual(delta.runtime_context.popular_recipe_query_context, request.runtime_context.popular_recipe_query_context);
  } else if (request.request_kind === "match_fact_capture") {
    assert.equal(delta.request_kind, "match_fact_capture");
    assert.equal(delta.response_contract_ref?.fact_capture_required, true);
    assert.deepEqual(delta.runtime_context?.fact_capture_catalog, request.runtime_context?.fact_capture_catalog);
    assert(delta.runtime_context?.current_match_facts, `${label} retains current capture facts`);
  } else assert(delta.runtime_context?.current_turn_contract, `${label} turn delta must retain current-turn authority`);
  return deltaBytes;
}

function setEnv(name, value, previous) {
  previous.set(name, process.env[name]);
  if (value === null) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(previous) {
  for (const [name, value] of previous.entries()) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function writeLiveState(file, stageRound, extra = {}) {
  const liveState = {
    schema: "jcc-full-player-journey-live-state-v1",
    match_session_id: JOURNEY_MATCH_ID,
    observed_at: new Date().toISOString(),
    phase: { status: "planning", stage_round: stageRound },
    economy: {
      hp: { value: extra.hp ?? 88, source: "self_state_roi_ocr" },
      gold: { value: extra.gold ?? 42, source: "self_state_roi_ocr" },
      level: { value: extra.level ?? 5, source: "self_state_roi_ocr" },
      xp: { value: extra.xp ?? "4/20", source: "self_state_roi_ocr" },
    },
    own_board: {
      field_status: {
        status: "candidate",
        promotion_policy: "shop_self_view_anchor fresh_current_view",
        shop_anchor_fresh: true,
      },
      local_board_units: [
        { name: "慎", cost: 2, star: 2, position: { row: 2, col: 3 }, items: ["石像鬼石板甲"] },
        { name: "卡尔玛", cost: 1, star: 1, position: { row: 4, col: 5 }, items: ["无尽之刃"] },
      ],
    },
    own_bench: { units: [{ name: "阿利斯塔", cost: 2, star: 1 }, { name: "蕾欧娜", cost: 1, star: 1 }] },
    shop: { units: [{ name: "慎", cost: 2 }, { name: "阿利斯塔", cost: 2 }, { name: "霞", cost: 1 }] },
    items: {
      item_bench: [
        { name: "暴风大剑", source: "mumu_4357_item_rail" },
        { name: "反曲之弓", source: "mumu_4357_item_rail" },
      ],
      equipped_items: [
        { unit_name: "慎", item_name: "石像鬼石板甲", source: "mumu_4356_to_4353_trusted_assignment" },
        { unit_name: "卡尔玛", item_name: "无尽之刃", source: "mumu_4356_to_4353_trusted_assignment" },
      ],
    },
    match_variables: {},
    ...extra,
  };
  await writeFile(file, `${JSON.stringify(liveState, null, 2)}\n`, "utf8");
}

function createJourneyMatchContext() {
  return {
    schema: "jcc-runtime-match-context-v1",
    match_session_id: JOURNEY_MATCH_ID,
    match_variables: {},
    latest_target_intent: {
      text: "用户想围绕当前 S18 法系来牌运营，但允许根据硬数据和来牌转向。",
      authority: "provisional_preference",
      source: "journey_fixture",
      updated_at: "2026-07-06T12:00:00.000Z",
    },
    recent_user_messages: [
      { text: "这把想围绕当前法系来牌运营，但如果局面不支持就转。", mode: "cruise", observed_at: "2026-07-06T12:00:00.000Z" },
    ],
    observed_choice_options_by_stage: {},
    choice_confirmations: [],
    missing_choice_prompts: [],
  };
}

async function writeMatchContext(file, context) {
  await writeFile(file, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

async function runReportedChoiceTurn({ service, window, mode, text, label, itemChoiceKind = null, fallbackCandidateNames = [] }) {
  const uiMode = { augment_choice: "augment", item_choice: "item" }[mode];
  assert(uiMode, `${label} must use a registered choice UI mode`);
  const modeResult = await service.handleRuntimeAction("setMode", { mode: uiMode }, window);
  assert.equal(modeResult.ok, true, `${label} should enter ${mode}`);
  const choiceKind = uiMode === "augment" ? "augment" : "item";
  const expectedCandidateCount = choiceKind === "augment"
    ? 3
    : itemChoiceKind === "completed_item_forge"
      ? 5
      : 4;
  const currentStageRound = label.match(/\b\d+-\d+\b/)?.[0] || null;
  assert(currentStageRound, `${label} should declare the structured-card stage`);
  const options = await service.handleRuntimeAction("getDecisionInputOptions", {
    mode,
    choice_kind: choiceKind,
    stage_round: currentStageRound,
    ...(choiceKind === "augment" ? { tier_color: "gold" } : {}),
    ...(itemChoiceKind ? { item_choice_kind: itemChoiceKind } : {}),
    limit: expectedCandidateCount,
  }, window);
  assert.equal(options.ok, true, `${label} should load structured-card options`);
  let candidateOptions = options.options.candidates.slice(0, expectedCandidateCount);
  if (choiceKind === "augment" && candidateOptions.length < expectedCandidateCount) {
    candidateOptions = [];
    for (const name of fallbackCandidateNames.slice(0, expectedCandidateCount)) {
      const searched = await service.handleRuntimeAction("getDecisionInputOptions", {
        mode,
        choice_kind: choiceKind,
        stage_round: currentStageRound,
        tier_color: "gold",
        query: name,
        limit: 8,
      }, window);
      const exact = searched.options?.candidates?.find((candidate) => candidate.name === name);
      if (exact) candidateOptions.push(exact);
    }
  }
  const candidates = candidateOptions.map((candidate, index) => ({
    slot: index + 1,
    name: candidate.name,
    ref: candidate.ref,
    tier: candidate.tier,
    tier_color: candidate.tier_color,
    item_category: candidate.item_category,
    item_subtype: candidate.item_subtype,
  }));
  assert.equal(candidates.length, expectedCandidateCount, `${label} should load every required card candidate`);
  const result = await service.handleRuntimeAction("submitDecisionInput", {
    mode,
    choice_kind: choiceKind,
    stage_round: currentStageRound,
    ...(choiceKind === "augment" ? { tier: "gold" } : {}),
    ...(itemChoiceKind ? { item_choice_kind: itemChoiceKind } : {}),
    payload_binding: options.payload_binding,
    candidates,
    target_note: text,
    request_advice: true,
    advice_action: "global_advice",
  }, window);
  assert.equal(
    result.ok,
    true,
    `${label} structured card should persist and own one advice task; status=${result.status}; error=${result.error || ""}; binding=${JSON.stringify(result.binding || null)}`,
  );
  assert.equal(result.status, "decision_input_recorded", `${label} should record structured-card candidates`);
  const pendingTask = assertRevisionedResponseTask(result, `${label} structured-card advice`);
  const ready = await waitForResponseTaskStatus(service, window, pendingTask.response_task_id, ["awaiting_host_cli_agent_response"]);
  const hostRequest = ready.host_request;
  assert.equal(hostRequest?.schema, "jcc-host-request-ref-v1", `${label} should persist only a compact card-owned Host request reference`);
  const recordedChoiceSet = ready.state?.match_context?.reported_choice_sets_by_mode?.[mode] || null;
  assert.equal(recordedChoiceSet?.source, "structured_decision_input_card", `${label} must persist the structured card as canonical choice input`);
  assert.equal(recordedChoiceSet?.candidates?.length, candidates.length, `${label} must preserve every card candidate in canonical match state`);
  const summary = {
    choices: {
      source: "current_match_user_report",
      mode,
      candidates: recordedChoiceSet.candidates,
    },
  };
  await completeDeliverAndAckTask(service, window, ready, label);
  return { result, hostRequest, summary, candidates, payloadBinding: result.payload_binding, options, choiceKind, stageRound: currentStageRound };
}

async function confirmChoiceAndReturnToCruise({ service, window, mode, reportedTurn, label, selectedSlot = 1 }) {
  const selected = reportedTurn.candidates[selectedSlot - 1];
  assert(selected?.ref, `${label} should have a catalog-backed selected candidate`);
  const confirmation = await service.handleRuntimeAction("confirmDecisionSelection", {
    mode,
    choice_kind: reportedTurn.choiceKind,
    stage_round: reportedTurn.stageRound,
    payload_binding: reportedTurn.payloadBinding,
    slot: selectedSlot,
    ref: selected.ref,
  }, window);
  assert.equal(confirmation.ok, true, `${label} should succeed`);
  assert.equal(confirmation.status, "choice_confirmation_recorded", `${label} should record the card selection without creating a Coach follow-up`);
  assert.equal(confirmation.response_task, null, `${label} confirmation should not occupy the Host response lane`);
  assert.equal(confirmation.semantic_followup_owner?.response_policy, "no_confirmation_followup");
  const modeResult = await service.handleRuntimeAction("setMode", { mode: "cruise" }, window);
  assert.equal(modeResult.ok, true, `${label} should allow immediate return to cruise after persistence`);
  return confirmation;
}

async function main() {
  const startedAt = Date.now();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-full-player-journey-"));
  progressFile = path.join(tempRoot, "verify-jcc-full-player-journey-sim.progress.log");
  const previous = new Map();
  let service = null;
  let report = null;
  let shutdownResult = null;
  let augmentSummary = null;
  let itemSummary = null;
  setEnv("JCC_UI_DISABLE_CODEX_EXEC", "1", previous);
  setEnv("JCC_RUNTIME_DATA_DIR", tempRoot, previous);
  setEnv("JCC_DISABLE_RESIDENT_AUGMENT_CHOICE_OCR", "1", previous);
  setEnv("JCC_DISABLE_RESIDENT_ITEM_CHOICE_OCR", "1", previous);
  setEnv("JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR", "1", previous);
  setEnv("JCC_DISABLE_RESIDENT_OWNED_AUGMENT_TEXT_PANEL_OCR", "1", previous);
  setEnv("JCC_DISABLE_LEFT_ITEM_RAIL_ROI_ICON", "1", previous);
  setEnv("JCC_ALLOW_COLD_CHOICE_OCR_FALLBACK", "0", previous);
  setEnv("JCC_ALLOW_COLD_SELF_STATE_ROI_OCR_FALLBACK", "0", previous);
  setEnv("JCC_UI_DISABLE_BACKGROUND_SELF_STATE_REFRESH", "1", previous);
  setEnv("JCC_UI_AUTO_RUNTIME_EVENT_ADVICE_MIN_INTERVAL_MS", "0", previous);
  requestObserver = observeJourneyRuntimeRequests(root, acceptanceOptions.realHost ? observeNativeNotification : null,
    acceptanceOptions.realHost ? (response, request, error) => {
      if (!activeAttempt || activeAttempt.request_id !== request?.request_id) return;
      rejectedResponses.push({ source: "active_provider_attempt", label: activeAttempt.label,
        response: structuredClone(response), request: structuredClone(request), error: String(error.message || error) });
    } : null);
  const heartbeat = setInterval(() => process.stderr.write(`[journey-sim] still running: ${currentStep}; elapsed ${Date.now() - startedAt}ms\n`), 15_000);
  heartbeat.unref?.();

  try {
    const tag = `full-player-journey=${Date.now()}`;
    mark("import state store");
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const rulesModule = await import(fileUrl("tools/jcc_active_rules_contract.mjs", tag));
    mark("import runtime service");
    service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    service.setRuntimeServiceEventWriter((type, event) => {
      if (type === "host_turn_trace" && event.task_id) journeyTraces.set(event.task_id, event);
      if (type === "host_turn_trace" && event.task_id && event.validation_error) {
        const failures = journeyValidationFailures.get(event.task_id) || [];
        failures.push(event);
        journeyValidationFailures.set(event.task_id, failures);
        process.stderr.write(`[journey-sim] validation rejected: ${event.attempt_id}: ${event.validation_error}\n`);
      }
    });
    if (acceptanceOptions.realHost) {
      const { detectHostAgent } = await import("../ui/electron/host-adapters.js");
      detectedJourneyHost = await detectHostAgent({ provider: acceptanceOptions.provider, model: acceptanceOptions.model, reasoning_effort: acceptanceOptions.reasoning, repoRoot: root });
      assert.equal(detectedJourneyHost.available, true, detectedJourneyHost.error || "selected Host is unavailable");
      assert(detectedJourneyHost.command, "detected Host must have a real command");
      service.setRuntimeServiceState({ ...service.getRuntimeServiceState(), host_cli: detectedJourneyHost });
    }
    mark("runtime service imported");
    const runtimePaths = storeModule.createRuntimePaths(root);
    const activeRulesBundle = rulesModule.loadActiveRulesBundle({ repoRoot: root, runtimePaths });
    const activeDecisionCatalog = JSON.parse(await readFile(runtimePaths.activeDecisionInputCatalogFile, "utf8"));
    const fallbackAugmentNames = activeDecisionCatalog.entities
      .filter((entity) => entity.kind === "augment" && entity.tier_color === "gold")
      .slice(0, 3)
      .map((entity) => entity.name);
    assert.equal(fallbackAugmentNames.length, 3, "active S18 catalog should expose three globally searchable gold augments for the journey fixture");
    const hasGodSequence = Boolean(
      activeRulesBundle.season_special_rules?.mechanics?.choice_mechanics
        ?.some((mechanic) => mechanic.mode === "god_sequence"),
    );
    assert.equal(hasGodSequence, false, "active S18 descriptor must not expose the retired S17 star-god choice flow");
    const noopWindow = { close() {}, minimize() {} };

    assert.equal(path.resolve(runtimePaths.runtimeDataRoot), path.resolve(tempRoot), "journey sim must use isolated runtime data");
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await mkdir(runtimePaths.stateDir, { recursive: true });
    const liveStateFile = path.join(runtimePaths.currentWatchDir, "cruise-live-state.json");
    const matchContextFile = runtimePaths.matchContextFile;

    mark("daily greeting");
    const dailyGreeting = expectHostRequest(await service.handleRuntimeAction("sendMessage", {
      mode: "chat",
      text: "你好",
    }, noopWindow), "daily greeting");
    const dailyGreetingSummary = service.summarizeHostRequest(dailyGreeting);
    assert.equal(dailyGreetingSummary.runtime_context?.context_policy?.include_daily_big_data, false, "plain daily greeting should stay compact");
    assert(bytes(dailyGreetingSummary) < 12000, "plain daily greeting selected context should stay compact");

    mark("daily strategy");
    const dailyStrategy = expectHostRequest(await service.handleRuntimeAction("sendMessage", {
      mode: "chat",
      text: "我想看当前版本里慎、卡尔玛、阿利斯塔相关的运营方向。",
    }, noopWindow), "daily strategy chat");
    const dailyStrategySummary = service.summarizeHostRequest(dailyStrategy);
    const dailyStrategyUsesNativeTools = dailyStrategySummary.runtime_context?.strategy_evidence_plan?.provider_capability === "native_dynamic_tools";
    if (dailyStrategyUsesNativeTools) {
      assert(dailyStrategySummary.runtime_context?.knowledge_snapshot?.core_profile_id, "native daily strategy should pin Core snapshot");
      assert(dailyStrategySummary.runtime_context?.strategy_evidence_plan?.provider_capability === "native_dynamic_tools", "native daily strategy should preserve query capability");
    } else {
      assert.equal(dailyStrategySummary.daily_big_data?.available, true, "strategy daily chat should consume the current Active S18 Ranking overlay");
      assert.equal(dailyStrategySummary.daily_big_data?.ranking_overlay_id, runtimePaths.activeRankingGenerationId, "strategy daily chat must use the current Active Ranking generation identity");
      assert(Object.keys(dailyStrategySummary.daily_big_data?.tiers || {}).length > 0, "strategy daily chat must expose current S18 Ranking tiers");
      assert(dailyStrategySummary.season_catalog, "strategy daily chat should include season catalog");
    }

    mark("wiki curation");
    const wikiResult = await service.handleRuntimeAction("buildWikiCurationRequest", { trigger: "manual_one_click", limit: 20 }, noopWindow);
    assert.equal(wikiResult.status, "awaiting_host_cli_agent_response", "strategy wiki mode should expose host request under disabled execution");
    assert.equal(wikiResult.wiki_curation_request?.schema, "jcc-wiki-curation-host-request-v1", "wiki request should use wiki schema");

    mark("set active match");
    const activeCoreProfileSnapshot = service.captureMatchSeasonVersionSnapshot();
    assert.equal(activeCoreProfileSnapshot.ranking_overlay_identity?.availability, "available", "valid journey requires a published compatible Ranking snapshot");
    assert.equal(activeCoreProfileSnapshot.recipe_catalog_identity?.availability, "available", "valid journey requires published compatible recipes, not an unavailable Core-only test fixture");
    const journeyMatchContext = createJourneyMatchContext();
    service.setRuntimeServiceState({
      ...(await service.handleRuntimeAction("getState", {}, noopWindow)).state,
      match_session: {
        status: "active",
        match_session_id: JOURNEY_MATCH_ID,
        started_at: "2026-07-06T12:00:00.000Z",
        season_version_snapshot: activeCoreProfileSnapshot,
      },
      match_connection: { status: "connected_to_live_match" },
      active_mode: "cruise",
      device_connection: { status: "connected", adb_target: null },
      watcher: {
        status: "bounded_fixture",
        pid: null,
        source: "bounded_player_journey_fixture",
      },
      self_state_refresh: {
        status: "completed",
        last_completed_at: new Date().toISOString(),
        reason: "bounded_player_journey_fixture",
      },
      host_cli: detectedJourneyHost || { provider: "kimi", display_name: "Kimi Code CLI", available: true, selected_model: "follow_cli_default" },
      match_context: journeyMatchContext,
      response_task: { status: "idle", response_task_id: null, revision: 1 },
      response_task_revision: 1,
    });
    await writeMatchContext(matchContextFile, journeyMatchContext);
    await writeLiveState(liveStateFile, "1-3", { gold: 11, level: 3, xp: "0/6" });

    mark("initial observe");
    const initialCruise = await service.handleRuntimeAction("observeRuntimeTick", {}, noopWindow);
    assert.equal(initialCruise.status, "runtime_observed", "stage-1 readiness must not create a non-checkpoint coaching answer");
    assert.equal(initialCruise.response_task?.response?.final_text || null, null, "silent Start Match readiness must not occupy the visible answer lane");
    const initialState = await service.handleRuntimeAction("getState", {}, noopWindow);
    assert.equal(
      initialState.state?.match_connection?.initial_cruise_greeting_status,
      "ready_without_automatic_answer",
      "Start Match must record readiness without creating an obsolete automatic greeting",
    );

    mark("cruise user question");
    const userCruiseResult = await service.handleRuntimeAction("sendMessage", {
      mode: "cruise",
      text: "现在该留哪些牌？结合我想玩的方向和大数据说。",
    }, noopWindow);
    const userCruiseRequest = expectHostRequest(userCruiseResult, "cruise user question");
    const userCruiseSummary = service.summarizeHostRequest(userCruiseRequest);
    summaryHasCoreMatchContext(userCruiseSummary, "cruise user question", runtimePaths.activeRankingGenerationId);
    assertRuleBoundHostRequest({ request: userCruiseRequest, activeRulesBundle, label: "cruise user question" });
    const userCruiseTurnDeltaBytes = assertBoundedProviderTurnDelta(service, userCruiseRequest, "cruise user question");
    assert.equal(userCruiseSummary.runtime_context.host_cli.provider, detectedJourneyHost?.provider || "kimi", "host request should preserve selected provider metadata");
    await completeDeliverAndAckTask(service, noopWindow, userCruiseResult, "cruise_user_question");

    mark("1-4 opening checkpoint and 2-1 quiet window");
    await advanceStageAndDrain({
      service,
      window: noopWindow,
      liveStateFile,
      stageRound: "1-4",
      economy: { hp: 100, gold: 13, level: 3, xp: "2/6" },
    });
    await advanceStageAndDrain({
      service,
      window: noopWindow,
      liveStateFile,
      stageRound: "2-1",
      economy: { hp: 100, gold: 15, level: 3, xp: "2/6" },
    });

    mark("2-1 augment user report and confirmation");
    const firstAugment = await runReportedChoiceTurn({
      service,
      window: noopWindow,
      mode: "augment_choice",
      text: "三个强化选项是：高级贷款 / 宇宙大爆炸 / 贪财；当前装备是反曲之弓、巨人腰带。选哪个？要不要刷新？",
      label: "2-1 augment user report",
      fallbackCandidateNames: fallbackAugmentNames,
    });
    augmentSummary = firstAugment.summary;
    assert.equal(augmentSummary.choices?.candidates?.length, 3, "augment choice should include all three user-reported candidates");
    await confirmChoiceAndReturnToCruise({
      service,
      window: noopWindow,
      mode: "augment_choice",
      reportedTurn: firstAugment,
      label: "2-1 augment confirmation",
    });

    mark("2-2 automatic runtime event");
    await writeLiveState(liveStateFile, "2-2", { hp: 96, gold: 18, level: 4, xp: "4/10" });
    const runtimeEventAdvice = await service.handleRuntimeAction("observeRuntimeTick", {}, noopWindow);
    assert.equal(runtimeEventAdvice.status, "response_preparing", "2-2 stage event should durably reserve one response task before background pipeline work");
    const preparingTask = assertRevisionedResponseTask(runtimeEventAdvice, "2-2 runtime event preparing task");
    const runtimeEventAdviceReady = await waitForResponseTaskStatus(
      service,
      noopWindow,
      preparingTask.response_task_id,
      ["awaiting_host_cli_agent_response"],
    );
    assert.equal(runtimeEventAdviceReady.host_request?.schema, "jcc-host-request-ref-v1", "2-2 runtime event advice must persist only a compact Host request reference");
    assert.equal(
      preparingTask.runtime_event_context?.fixed_checkpoint_id,
      "direction_exploration",
      "2-2 automatic cruise should bind the registered direction-exploration checkpoint",
    );
    assert.equal(
      preparingTask.runtime_event_context?.strategy_block_id,
      "lineup_direction_commitment",
      "2-2 automatic cruise should bind the persistent lineup-direction strategic block",
    );
    assert.equal(
      preparingTask.runtime_event_context?.strategic_obligation?.complete_candidate_rosters_required,
      true,
      "2-2 strategic obligation must require complete atomic candidate rosters",
    );
    assert(
      preparingTask.runtime_event_context?.strategic_obligation?.required_decisions?.includes("complete_candidate_rosters"),
      "2-2 strategic obligation must preserve the complete-candidate decision contract",
    );
    await completeDeliverAndAckTask(service, noopWindow, runtimeEventAdviceReady, "automatic_2_2_runtime_event");

    for (const [label, action, payload, kind] of [
      ["ordinary_artifact_question", "sendMessage", { mode: "cruise", text: "普通提问：神器应该优先考虑哪些持有者？根据当前装备和棋盘说明，不是装备选择卡。" }, null],
      ["core_only_query", "sendCruiseHardDataQuery", { text: "只根据当前硬数据解释护甲减伤公式。" }, "hard_data_query"],
      ["popular_recipe_query", "sendCruisePopularRecipeQuery", { text: "查询当前热门阵容模板。" }, "popular_recipe_query"],
      ["quick_capture", "sendMessage", { mode: "cruise", request_kind: "match_fact_capture", text: "快速记录当前局事实：我的散件装备栏现在为空，请只执行清空散件记录，不要解释公式，不要给策略建议。" }, "match_fact_capture"],
    ]) {
      mark(label);
      const result = await service.handleRuntimeAction(action, payload, noopWindow);
      const request = expectHostRequest(result, label);
      if (kind) assert.equal(request.request_kind, kind, `${label}: Runtime must seal the requested entry kind`);
      if (label === "ordinary_artifact_question") assert.equal(request.mode, "cruise", "ordinary artifact question must not turn into an item card");
      if (label === "core_only_query") assert.equal(request.runtime_context?.context_policy?.hard_data_only, true);
      if (label === "popular_recipe_query") assert.equal(request.runtime_context?.popular_recipe_query_context?.status, "available", "valid popular fixture requires current published recipes");
      await completeDeliverAndAckTask(service, noopWindow, result, label);
    }

    mark("2-3 and 2-4 choice checkpoint progression");
    await advanceStageAndDrain({
      service,
      window: noopWindow,
      liveStateFile,
      stageRound: "2-3",
      economy: { hp: 94, gold: 22, level: 4, xp: "6/10" },
    });
    await advanceStageAndDrain({
      service,
      window: noopWindow,
      liveStateFile,
      stageRound: "2-4",
      economy: { hp: 91, gold: 26, level: 4, xp: "8/10" },
    });

    mark("2-4 standard carousel checkpoint");
    await assert.rejects(
      service.handleRuntimeAction("setMode", { mode: "god" }, noopWindow),
      /Unknown UI mode: god/,
      "S18 must fail closed when a retired S17 star-god mode is requested",
    );
    assert.equal((await service.handleRuntimeAction("setMode", { mode: "cruise" }, noopWindow)).ok, true, "2-4 carousel checkpoint should remain in cruise");

    mark("manual self-state refresh");
    service.setRuntimeServiceState({
      ...(await service.handleRuntimeAction("getState", {}, noopWindow)).state,
      response_task: { status: "idle", response_task_id: null },
      active_mode: "refresh_self_state",
    });
    const refreshResult = await service.handleRuntimeAction("sendMessage", {
      mode: "refresh_self_state",
      text: "刷新我方状态。",
    }, noopWindow);
    assert.equal(refreshResult.ok, true, "manual self-state refresh should return a visible local response");
    assert.equal(refreshResult.status, "manual_self_state_refresh_completed", "manual self-state refresh should complete locally instead of waiting on host CLI");
    assert(refreshResult.response?.final_text, "manual self-state refresh should produce final_text for the user");
    assert.equal(refreshResult.response?.generated_by, "jcc_runtime_manual_self_state_refresh", "manual self-state refresh should be generated by runtime local refresh path");
    assert.equal(refreshResult.refresh_result?.status, "self_state_roi_ocr_failed_no_visual_fallback", "disabled/no-device OCR simulation should return immediately without cold-starting OCR");
    await deliverAndAckCompletedTask(service, noopWindow, refreshResult, "manual_self_state_refresh");

    mark("resume cruise after delivered event and refresh");
    service.setRuntimeServiceState({
      ...(await service.handleRuntimeAction("getState", {}, noopWindow)).state,
      active_mode: "cruise",
    });
    const resumedCruise = await advanceStageAndDrain({
      service,
      window: noopWindow,
      liveStateFile,
      stageRound: "2-5",
      economy: { hp: 28, gold: 38, level: 5, xp: "0/20" },
    });
    assert.equal(
      responseTaskFromResult(resumedCruise)?.response_task_id || null,
      null,
      "2-5 must stay silent after the 2-2 direction-exploration obligation has been fully delivered and acknowledged",
    );

    mark("midgame progression with current-checkpoint user reports");
    for (const [stageRound, economy] of [
      ["2-7", { hp: 76, gold: 50, level: 5, xp: "8/20" }],
      ["3-1", { hp: 74, gold: 54, level: 5, xp: "10/20" }],
      ["3-2", { hp: 70, gold: 42, level: 6, xp: "0/36" }],
    ]) {
      await advanceStageAndDrain({ service, window: noopWindow, liveStateFile, stageRound, economy });
    }
    const secondAugment = await runReportedChoiceTurn({
      service,
      window: noopWindow,
      mode: "augment_choice",
      text: "三个强化选项是：团队建设 / 腐蚀 / 打捞桶+；装备没变。选哪个？要不要刷新？",
      label: "3-2 augment user report",
      fallbackCandidateNames: fallbackAugmentNames,
    });
    assert.equal(secondAugment.summary.choices?.candidates?.length, 3, "3-2 augment should use the new reported choice set");
    await confirmChoiceAndReturnToCruise({
      service,
      window: noopWindow,
      mode: "augment_choice",
      reportedTurn: secondAugment,
      label: "3-2 augment confirmation",
    });

    for (const [stageRound, economy] of [
      ["3-3", { hp: 68, gold: 46, level: 6, xp: "2/36" }],
      ["3-4", { hp: 64, gold: 49, level: 6, xp: "4/36" }],
      ["3-5", { hp: 61, gold: 52, level: 7, xp: "0/48" }],
    ]) {
      await advanceStageAndDrain({ service, window: noopWindow, liveStateFile, stageRound, economy });
    }
    assert.equal((await service.handleRuntimeAction("getState", {}, noopWindow)).state.active_mode, "cruise", "3-4 carousel checkpoint must not open a season-choice mode");

    await advanceStageAndDrain({
      service,
      window: noopWindow,
      liveStateFile,
      stageRound: "3-7",
      economy: { hp: 57, gold: 51, level: 7, xp: "0/48" },
    });
    const itemChoice = await runReportedChoiceTurn({
      service,
      window: noopWindow,
      mode: "item_choice",
      itemChoiceKind: JOURNEY_ITEM_CHOICE_KIND,
      text: "当前装备选择卡已经填满，请结合目标阵容给出选择建议。",
      label: `3-7 ${JOURNEY_ITEM_CHOICE_KIND} user report`,
    });
    itemSummary = itemChoice.summary;
    assert.equal(itemSummary.choices?.mode, "item_choice", "item choice should expose the active item mode context");
    assert.equal(
      itemSummary.choices?.candidates?.length,
      JOURNEY_ITEM_CHOICE_KIND === "completed_item_forge" ? 5 : 4,
      "item choice should preserve the candidate count required by its structured-card kind",
    );
    assert.equal((await service.handleRuntimeAction("setMode", { mode: "cruise" }, noopWindow)).ok, true, "item choice should return to cruise");

    for (const [stageRound, economy] of [
      ["4-1", { hp: 52, gold: 50, level: 7, xp: "6/48" }],
      ["4-2", { hp: 46, gold: 32, level: 8, xp: "0/60" }],
    ]) {
      await advanceStageAndDrain({ service, window: noopWindow, liveStateFile, stageRound, economy });
    }
    const thirdAugment = await runReportedChoiceTurn({
      service,
      window: noopWindow,
      mode: "augment_choice",
      text: "三个强化选项是：双排 / 飞升 / 三项赛 I；装备新增拳套。选哪个？要不要刷新？",
      label: "4-2 augment user report",
      fallbackCandidateNames: fallbackAugmentNames,
    });
    assert.equal(thirdAugment.summary.choices?.candidates?.length, 3, "4-2 augment should use the new reported choice set");
    await confirmChoiceAndReturnToCruise({
      service,
      window: noopWindow,
      mode: "augment_choice",
      reportedTurn: thirdAugment,
      label: "4-2 augment confirmation",
    });

    await advanceStageAndDrain({
      service,
      window: noopWindow,
      liveStateFile,
      stageRound: "4-3",
      economy: { hp: 43, gold: 28, level: 8, xp: "2/60" },
    });

    await advanceStageAndDrain({
      service,
      window: noopWindow,
      liveStateFile,
      stageRound: "4-4",
      economy: { hp: 39, gold: 21, level: 8, xp: "4/60" },
    });
    assert.equal((await service.handleRuntimeAction("getState", {}, noopWindow)).state.active_mode, "cruise", "4-4 carousel checkpoint must not open a season-choice mode");

    await advanceStageAndDrain({
      service,
      window: noopWindow,
      liveStateFile,
      stageRound: "4-5",
      economy: { hp: 35, gold: 24, level: 8, xp: "6/60" },
    });
    await advanceStageAndDrain({
      service,
      window: noopWindow,
      liveStateFile,
      stageRound: "4-7",
      economy: { hp: 30, gold: 35, level: 8, xp: "10/60" },
    });
    await advanceStageAndDrain({
      service,
      window: noopWindow,
      liveStateFile,
      stageRound: "5-3",
      economy: { hp: 24, gold: 18, level: 8, xp: "18/60" },
    });
    for (const stageRound of ["5-5", "6-1", "6-3", "6-5"]) {
      await advanceStageAndDrain({
        service,
        window: noopWindow,
        liveStateFile,
        stageRound,
        economy: { hp: 18, gold: 20, level: 9, xp: "0/84" },
      });
    }

    mark("lineup request");
    service.setRuntimeServiceState({
      ...(await service.handleRuntimeAction("getState", {}, noopWindow)).state,
      active_mode: "lineup_card",
      response_task: { status: "idle", response_task_id: null },
    });
    const lineupResult = await service.handleRuntimeAction("sendMessage", {
      mode: "lineup_card",
      text: "确认最终阵容：从当前完整候选中选择一个，生成最终阵容卡片，棋子放到 4x7 框里。",
      lineup_confirmation_requested: true,
    }, noopWindow);
    const lineupHostRequest = expectHostRequest(lineupResult, "lineup card request");
    const lineupSummary = service.summarizeHostRequest(lineupHostRequest);
    assertRuleBoundHostRequest({ request: lineupHostRequest, activeRulesBundle, label: "lineup card" });
    const lineupTurnDeltaBytes = assertBoundedProviderTurnDelta(service, lineupHostRequest, "lineup card request");
    summaryHasCoreMatchContext(lineupSummary, "lineup card request", runtimePaths.activeRankingGenerationId);
    assert.equal(lineupSummary.mode, "lineup_card", "lineup request must preserve lineup_card mode through selected context");
    const proseOnlyLineup = service.normalizeHostCoachResponse({
      schema: "jcc-host-cli-coach-response-v1",
      generated_by: "current_cli_agent_main_model",
      request_id: lineupHostRequest.request_id,
      request_hash: lineupHostRequest.request_hash,
      mode: lineupHostRequest.mode,
      final_text: "只返回文字，不生成阵容卡。",
      confidence: "medium",
    }, lineupHostRequest);
    assert.equal(proseOnlyLineup.final_text, "只返回文字，不生成阵容卡。", "lineup mode must preserve readable strategy text");
    assert.equal(proseOnlyLineup.pinned_result, null, "missing card facts must degrade only the card instead of rejecting the response");
    const lineupResponse = acceptanceOptions.realHost ? {} : publishableLineupResponse(lineupHostRequest);
    const lineupCompletion = await completeDeliverAndAckTask(service, noopWindow, lineupResult, "lineup_card", lineupResponse);
    const normalizedLineup = lineupCompletion.response;
    if (normalizedLineup.pinned_result) {
      assert.equal(normalizedLineup.pinned_result.slot, "lineup", "lineup mode should normalize a structured lineup card");
      assert(normalizedLineup.pinned_result.units?.length >= 5, "lineup card should contain a publishable current-season board");
      assert(
        normalizedLineup.pinned_result.loadouts?.[0]?.items?.length
          || normalizedLineup.pinned_result.equipment_status === "not_provided_in_evidence",
        "lineup card should preserve supplied loadouts or explicitly declare that equipment evidence is unavailable",
      );
      assert(normalizedLineup.pinned_result.moves?.length, "lineup card should include actionable moves");
    } else {
      assert(
        normalizedLineup.soft_quality_diagnostics?.some((diagnostic) => [
          "lineup_card_not_publishable",
          "lineup_card_materialization_failed",
        ].includes(diagnostic)),
        "missing exact positioning evidence may degrade only the card, not silently fail the response",
      );
      assert(normalizedLineup.final_text.includes("完整成员"), "lineup degradation must preserve readable strategy text");
    }

    service.setRuntimeServiceState({
      ...(await service.handleRuntimeAction("getState", {}, noopWindow)).state,
      match_session: { status: "completed", match_session_id: JOURNEY_MATCH_ID },
      response_task: { status: "idle", response_task_id: null },
      active_mode: "postgame_review",
    });
    mark("review request");
    const reviewRequest = expectHostRequest(await service.handleRuntimeAction("sendMessage", {
      mode: "review",
      text: "复盘这把经济节奏哪里容易掉队。",
    }, noopWindow), "postgame review request");
    const reviewSummary = service.summarizeHostRequest(reviewRequest);
    assert.equal(reviewSummary.runtime_context?.active_mode, "postgame_review", "review mode should map to postgame_review");
    assert.equal(reviewSummary.daily_big_data?.available, true, "postgame review should preserve the compatible Active Ranking overlay");
    assert.equal(reviewSummary.daily_big_data?.ranking_overlay_id, runtimePaths.activeRankingGenerationId, "postgame review must bind the current immutable Active Ranking generation");
    assert(Object.keys(reviewSummary.daily_big_data?.tiers || {}).length > 0, "postgame review must expose current-season Ranking tiers");

    report = {
      ok: true,
      schema: "jcc-full-player-journey-sim-v1",
      journey_variant: JOURNEY_VARIANT,
      match_session_id: JOURNEY_MATCH_ID,
      item_choice_kind: JOURNEY_ITEM_CHOICE_KIND,
      checked: [
        "daily_chat_compact_plain_greeting",
        "daily_strategy_chat_with_big_data_catalog",
        "strategy_wiki_curation_request",
        "start_match_active_context_and_silent_cruise_readiness",
        "cruise_user_question_has_full_selected_context",
        "response_task_revision_and_exact_ack",
        "automatic_runtime_event_after_user_ack",
        "full_stage_progression_keeps_semantic_events_observable_and_response_lane_releasable",
        "fixed_checkpoint_progression_through_3_5_4_3_4_5_and_5_3",
        "manual_refresh_self_state_returns_runtime_response",
        "disabled_resident_ocr_does_not_cold_start",
        "cruise_resumes_after_delivered_event_and_refresh",
        "augment_user_report_to_canonical_fact_and_compact_host_request_ref",
        "retired_season_choice_mode_fails_closed_at_standard_carousel_checkpoints",
        "item_user_report_to_canonical_fact_and_compact_host_request_ref",
        "lineup_card_preserves_readable_text_and_materializes_or_degrades_without_exact_positions",
        "direct_cruise_and_lineup_requests_use_current in-memory selected context while card tasks persist compact refs",
        "postgame_review_route",
        "explicit_runtime_shutdown_before_success",
      ],
      boundaries: {
        host_cli_execution: acceptanceOptions.realHost ? "real runHostModel through Runtime completion owner" : "simulated response; production normalization and exact ACK required; no provider latency measured",
        real_mumu_hud_ocr: "not exercised; HUD self-state and owned-augment panel OCR remain real-device acceptance tests",
        active_choice_candidate_intake: "current-match user reports exercised; active S18 augment and item/anvil choice intake does not use OCR or host vision",
      },
      sample_sizes: {
        daily_greeting_summary_bytes: bytes(dailyGreetingSummary),
        cruise_user_summary_bytes: bytes(userCruiseSummary),
        cruise_user_provider_turn_delta_bytes: userCruiseTurnDeltaBytes,
        lineup_summary_bytes: bytes(lineupSummary),
        lineup_provider_turn_delta_bytes: lineupTurnDeltaBytes,
      },
      elapsed_ms: Date.now() - startedAt,
    };
  } catch (error) {
    failureStep = currentStep;
    if (activeAttempt) {
      activeAttempt.host_ms = Date.now() - Date.parse(activeAttempt.started_at);
      activeAttempt.native_usage = nativeUsageForAttempt(activeAttempt, service?.getRuntimeServiceState()?.host_sessions?.match?.provider_session_id);
      activeAttempt.dispatch_trace = journeyTraces.get(activeAttempt.task_id) || null;
      activeAttempt.validation_failures = journeyValidationFailures.get(activeAttempt.task_id) || [];
      activeAttempt.response_task = service?.getRuntimeServiceState()?.response_task || null;
    }
    throw error;
  } finally {
    try {
      if (rejectedResponses.length) {
        const evidenceFile = path.join(root, ".omx/runtime-evidence", `journey-rejected-responses-${startedAt}.json`);
        await mkdir(path.dirname(evidenceFile), { recursive: true });
        await writeFile(evidenceFile, JSON.stringify(rejectedResponses));
        process.stderr.write(`[journey-sim] rejected response replay evidence: ${evidenceFile}\n`);
      }
      if (service) {
        mark("runtime shutdown");
        shutdownResult = await service.handleRuntimeAction("shutdown", {
          reason: "full_player_journey_sim_completed",
        }, { close() {}, minimize() {} });
      }
    } finally {
      clearInterval(heartbeat);
      requestObserver?.close();
      restoreEnv(previous);
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
  assert.equal(shutdownResult?.status, "runtime_service_shutdown_cleaned", "journey simulation must explicitly shut down runtime resources");
  report.shutdown = {
    status: shutdownResult.status,
    killed_watcher: shutdownResult.killed_watcher,
    stopped_host_process: shutdownResult.stopped_host_process,
  };
  report.elapsed_ms = Date.now() - startedAt;
  report.acceptance = acceptanceReport(acceptanceTurns, acceptanceOptions, report.elapsed_ms, JOURNEY_DEADLINE_MS);
  assert.equal(acceptanceTurns.length, 20, "full journey requires exactly 20 validated and ACKed Host turns; three final augment confirmations are state-only");
  for (const label of ["2-1 augment confirmation", "3-2 augment confirmation", "4-2 augment confirmation"]) {
    assert.equal(acceptanceTurns.filter((turn) => turn.label === label).length, 0, `${label} must not create a Host turn`);
  }
  assert.equal(acceptanceTurns.filter((turn) => turn.label === "stage_4_7").length, 0, "4-7 equipment and transition review must remain merged into the 3-7 checkpoint");
  for (const label of ["stage_3_7", "stage_6_1", "stage_6_3"]) {
    assert.equal(acceptanceTurns.filter((turn) => turn.label === label).length, 1, `${label} must be delivered exactly once`);
  }
  if (acceptanceOptions.realHost && acceptanceOptions.provider === "codex") assert(acceptanceTurns.every((turn) => turn.native_usage?.status === "observed"), "each real Codex turn requires native usage evidence");
  await persistAcceptanceSnapshot(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const hardDeadline = setTimeout(() => {
  console.error(`full player journey exceeded ${JOURNEY_DEADLINE_MS}ms hard deadline`);
  process.exit(124);
}, JOURNEY_DEADLINE_MS);
hardDeadline.unref?.();

main().catch(async (error) => {
  console.error(error?.stack || error?.message || String(error));
  const failedReport = {
    ok: false, schema: "jcc-full-player-journey-sim-v1", journey_variant: JOURNEY_VARIANT,
    acceptance: { validity: false, perf: false, target_met: false,
      real_host_dispatch: acceptanceTurns.some((turn) => turn.real_host_dispatch === true),
      failure_step: failureStep || currentStep, error: error?.message || String(error), turns: acceptanceTurns,
      failed_attempt: activeAttempt, limits_ms: { host_target: acceptanceOptions.hostTargetMs, host_tolerance: acceptanceOptions.hostLimitMs } },
    checkpoint_failure: checkpointFailure,
  };
  await persistAcceptanceSnapshot(failedReport);
  process.stdout.write(`${JSON.stringify(failedReport, null, 2)}\n`);
  process.exitCode = 1;
});
