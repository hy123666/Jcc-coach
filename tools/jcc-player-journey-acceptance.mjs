import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export async function writeJourneyEvidence({ repoRoot, label, request, task, contract, state }) {
  const directory = path.join(repoRoot, ".omx", "evidence", "strict-journey", `${Date.now()}-${label.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "request.json"), `${JSON.stringify(request, null, 2)}\n`);
  const summary = {
    label, generated_at: new Date().toISOString(),
    owner: Object.fromEntries(["response_task_id", "revision", "mode", "origin", "event_key", "match_session_id", "status"].map((key) => [key, task?.[key] ?? null])),
    runtime_event_context: task?.runtime_event_context || null,
    task_host_request_ref: task?.host_request || null,
    request_id: request?.request_id, request_hash: request?.request_hash,
    request_top_keys: Object.keys(request || {}), context_keys: Object.keys(request?.context || {}),
    root_event: request?.runtime_event_context || null,
    nested_task_event: request?.context?.task?.runtime_event_context || null,
    context_event: request?.context?.runtime_event_context || null,
    fit_obligation: request?.runtime_context?.strategy_fit_packet?.strategic_obligation || null,
    resolved_strategic_contract: contract, expected_response_shape: request?.expected_response_shape,
    queue: state?.runtime_strategic_obligations || null,
    environment: { JCC_UI_DISABLE_CODEX_EXEC: process.env.JCC_UI_DISABLE_CODEX_EXEC || null,
      host_provider: state?.host_cli?.provider, active_mode: state?.active_mode,
      host_execution: "API paused before provider; request observed without mutation at persistence-ref boundary" },
  };
  await writeFile(path.join(directory, "owner-context-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return directory;
}

export const REQUIRED_JOURNEY_TURNS = Object.freeze([
  "2-1 augment user report", "automatic_2_2_runtime_event",
  "ordinary_artifact_question", "3-2 augment user report", "stage_3_3",
  "4-2 augment user report", "stage_4_3",
  "lineup_card", "core_only_query", "popular_recipe_query", "quick_capture",
]);

export function journeyOptions(args = process.argv.slice(2), env = process.env) {
  const options = {
    realHost: false, help: false, plan: false, report: null, provider: env.JCC_JOURNEY_PROVIDER || "codex",
    model: env.JCC_JOURNEY_MODEL || null, reasoning: env.JCC_JOURNEY_REASONING || "low",
    prepareLimitMs: Number(env.JCC_VERIFY_RESPONSE_PREPARATION_TIMEOUT_MS || 30_000),
    hostLimitMs: Number(env.JCC_JOURNEY_HOST_LIMIT_MS || 180_000),
    hostTargetMs: 60_000,
    deliveryLimitMs: Number(env.JCC_JOURNEY_DELIVERY_LIMIT_MS || 2_000),
    ackLimitMs: Number(env.JCC_JOURNEY_ACK_LIMIT_MS || 5_000),
  };
  const values = { "--provider": "provider", "--model": "model", "--reasoning": "reasoning", "--report": "report" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--real-host") options.realHost = true;
    else if (arg === "--help") options.help = true;
    else if (arg === "--plan") options.plan = true;
    else if (Object.hasOwn(values, arg)) {
      assert(args[index + 1] && !args[index + 1].startsWith("--"), `${arg} requires a value`);
      options[values[arg]] = args[++index];
    } else throw new Error(`Unknown journey argument: ${arg}`);
  }
  assert(["codex", "kimi"].includes(options.provider), "journey provider must be codex or kimi");
  for (const key of ["prepareLimitMs", "hostLimitMs", "deliveryLimitMs", "ackLimitMs"]) {
    assert(Number.isFinite(options[key]) && options[key] > 0, `${key} must be positive and finite`);
  }
  return options;
}

export function assertExpectedValidTask(task, label, { completed = false } = {}) {
  assert(task?.response_task_id, `${label}: expected valid fixture must own a response task`);
  assert(Number.isInteger(task.revision) && task.revision > 0, `${label}: missing task revision`);
  const allowed = completed ? ["completed"] : ["awaiting_host_cli_agent_response", "completed"];
  assert(allowed.includes(task.status), `${label}: expected valid fixture failed: ${task.status}; ${task.error || ""}`);
  if (completed) {
    assert(typeof task.response?.final_text === "string" && task.response.final_text.trim(), `${label}: completed task has no body`);
    assert(!task.response?.fallback && !task.response?.degraded, `${label}: degraded response is not valid fixture success`);
    for (const value of [task.response, task.response?.strategy_selection, task.response?.pinned_result]) {
      assert(!["unknown", "unavailable", "no_evidence", "no_advice", "failed"].includes(value?.status), `${label}: unavailable evidence is not valid fixture success`);
    }
  }
}

export function acceptanceReport(turns, options, elapsedMs, deadlineMs) {
  for (const label of REQUIRED_JOURNEY_TURNS) assert(turns.some((turn) => turn.label === label), `missing acceptance turn: ${label}`);
  const validity = turns.length > 0 && turns.every((turn) => turn.normalized === true && turn.acknowledged === true && turn.body_chars > 0
    && (!options.realHost || turn.real_host_dispatch === true));
  const perf = elapsedMs <= deadlineMs && turns.every((turn) => (
    Number.isFinite(turn.preparation_ms) && turn.preparation_ms <= options.prepareLimitMs
    && Number.isFinite(turn.host_ms) && turn.host_ms <= options.hostLimitMs
    && Number.isFinite(turn.delivery_ms) && turn.delivery_ms <= options.deliveryLimitMs
    && Number.isFinite(turn.ack_ms) && turn.ack_ms <= options.ackLimitMs
  ));
  const targetMet = turns.every((turn) => turn.host_ms <= options.hostTargetMs);
  assert(validity, "journey validity failed");
  assert(perf, "journey performance limits exceeded");
  return {
    validity, perf, target_met: targetMet,
    real_host_dispatch: options.realHost && turns.every((turn) => turn.real_host_dispatch === true),
    host_execution: options.realHost ? "real_runHostModel" : "simulated_response_with_production_validation",
    ui_ack: "Runtime delivery and renderer-ACK API contract; no browser rendering exercised",
    limits_ms: { preparation: options.prepareLimitMs, host_target: options.hostTargetMs, host_tolerance: options.hostLimitMs, delivery: options.deliveryLimitMs, ack: options.ackLimitMs, journey: deadlineMs },
    turns,
  };
}

// Read-only observation at the existing persistence-ref boundary. The complete
// request comes from Runtime, not reconstructed from ref metadata or fixtures.
export function observeJourneyRuntimeRequests(repoRoot, onNativeNotification = null, onValidationFailure = null) {
  const captured = new Map();
  const symbolKey = `jcc.journey.request-observer.${process.pid}.${Date.now()}`;
  const symbol = Symbol.for(symbolKey);
  const notificationSymbol = Symbol.for(`${symbolKey}.native`);
  globalThis[notificationSymbol] = onNativeNotification;
  const validationSymbol = Symbol.for(`${symbolKey}.validation`);
  globalThis[validationSymbol] = onValidationFailure;
  globalThis[symbol] = (request, taskId) => {
    if (!request || request.schema === "jcc-host-request-ref-v1" || !request.runtime_context) return;
    const entry = { request: structuredClone(request), captured_at: Date.now() };
    if (taskId) captured.set(`task:${taskId}`, entry);
    if (request.request_id) captured.set(`request:${request.request_id}`, entry);
  };
  const serviceUrl = pathToFileURL(path.join(repoRoot, "ui/electron/runtime-service.js")).href;
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const base = url.split("?")[0];
      if (onNativeNotification && base === pathToFileURL(path.join(repoRoot, "ui/electron/host-adapters.js")).href) {
        const marker = "const emitNotification = (message) => {";
        const source = String(result.source);
        assert.equal(source.split(marker).length, 2, "Host native notification observation boundary changed");
        return { ...result, source: source.replace(marker, `${marker}\n    globalThis[Symbol.for(${JSON.stringify(`${symbolKey}.native`)})]?.(message);`) };
      }
      if (base === serviceUrl) {
        const marker = "canonicalHostRequestRef as hostRequestPersistenceRef,";
        let source = String(result.source);
        assert.equal(source.split(marker).length, 2, "Runtime request-ref import changed");
        if (onValidationFailure) {
          const normalizer = "function normalizeHostCoachResponse(";
          assert.equal(source.split(normalizer).length, 2, "Runtime normalization observation boundary changed");
          source = source.replace(normalizer, "function journeyOriginalNormalizeHostCoachResponse(");
          source += `\nfunction normalizeHostCoachResponse(response, request, options) { try { return journeyOriginalNormalizeHostCoachResponse(response, request, options); } catch (error) { globalThis[Symbol.for(${JSON.stringify(`${symbolKey}.validation`)})]?.(response, request, error); throw error; } }\n`;
        }
        return { ...result, source: `${source.replace(marker, "canonicalHostRequestRef as journeyOriginalRequestRef,")}\nfunction hostRequestPersistenceRef(request, taskId) { globalThis[Symbol.for(${JSON.stringify(symbolKey)})]?.(request, taskId); return journeyOriginalRequestRef(request, taskId); }\nexport { runDirectHostModelForUserMessageInBackground as journeyRunBackground, strategicResponseContractForHostRequest as journeyStrategicContract, augmentEvaluatorRankingForHostRequest as journeyAugmentRanking, applyMatchFactCapture as journeyApplyCapture };` };
      }
      return result;
    },
  });
  return {
    resolve(task, result) {
      const entry = captured.get(`task:${task.response_task_id}`) || captured.get(`request:${task.host_request?.request_id}`);
      const direct = result?.host_request;
      const request = entry?.request || (direct?.schema !== "jcc-host-request-ref-v1" ? direct : null);
      assert(request?.request_id && request?.runtime_context, `${task.response_task_id}: complete Runtime request was not observed; keys=${JSON.stringify([...captured.keys()])}; ref=${JSON.stringify(task.host_request)}; observed_keys=${JSON.stringify(Object.keys(request || {}))}`);
      assert.equal(request.request_id, task.host_request?.request_id || request.request_id, "captured request owner mismatch");
      return request;
    },
    release(task, request) {
      captured.delete(`task:${task.response_task_id}`);
      captured.delete(`request:${request.request_id}`);
    },
    close() { hooks.deregister(); captured.clear(); delete globalThis[symbol]; delete globalThis[notificationSymbol]; delete globalThis[validationSymbol]; },
  };
}

export function simulatedJourneyResponse(service, request, label, override = {}) {
  const response = {
    schema: "jcc-host-cli-coach-response-v1", generated_by: "current_cli_agent_main_model",
    request_id: request.request_id, request_hash: request.request_hash, mode: request.mode,
    final_text: `${label}: retain the current verified board while comparing the supplied evidence.`,
    recommended_action: null, confidence: "medium", followup_question: null,
    ...override,
  };
  const schema = service.hostCoachNativeOutputSchemaForRequest(request);
  if (schema.properties.choice_recommendation) {
    const ranking = service.journeyAugmentRanking(request);
    const candidates = request.choices?.candidates || request.context?.choices?.candidates || [];
    const names = ranking.length === 3 ? ranking : candidates.map((entry) => entry.name || entry);
    assert.equal(names.length, 3, `${label}: Runtime must supply the three current card candidates`);
    response.choice_recommendation = { candidate_ranking: names, refresh_action: "keep_and_pick", selected_candidate: names[0], refresh_slots: [], reason: "Simulation uses the supplied evaluator order." };
  }
  const contract = service.journeyStrategicContract(request);
  if (contract) {
    const selected = contract.selection_candidates.slice(0, 3);
    assert(selected.length > 0, `${label}: valid strategic fixture has no complete Runtime candidates`);
    const conclusions = Object.fromEntries(contract.required_decisions.map((key) => [key,
      `${key}: keep ${selected[0].display_name} as the current direction, preserve owned core units and equipment, and spend only after checking the current economy.`,
    ]));
    response.final_text += `\n${selected.map((candidate) => candidate.display_name).join("; ")}\n${Object.values(conclusions).join("\n")}`;
    response.strategic_completion = { decision_outputs: conclusions };
    response.strategy_selection = { status: "selected", selected_candidate_ids: selected.map((candidate) => candidate.candidate_id), selected_candidate_refs: selected };
  }
  if (request.request_kind === "match_fact_capture") {
    assert.equal(label, "quick_capture", "simulation capture operation must match its explicit clear-equipment input");
    response.fact_capture = { schema: "jcc-match-fact-capture-v1", operations: [{ op: "clear_equipment", category: "components" }], unresolved: [] };
  }
  return response;
}
