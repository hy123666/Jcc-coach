import {
  canonicalHostRequestRef,
  createRuntimeSqliteStore,
  runtimeStoreContract,
  writeLegacyJsonMirror,
} from "./runtime-state-store.js";
import {
  configureRuntimeServicePaths,
  getRuntimeServiceState,
  handleRuntimeAction as handleRuntimeServiceAction,
  messageIsResponseStatusPing,
  reconcileActiveRankingStatus,
  setRuntimeServiceCanonicalStateWriter,
  setRuntimeServiceEventWriter,
  setRuntimeServiceState,
} from "./runtime-service.js";
import { cancelHostAgentRunDetailed, preemptHostAgentSessionStart } from "./host-adapters.js";
import { createHash } from "node:crypto";
import { buildRankingStatusViewModel } from "./ranking-status-view-model.js";

const sessionActions = new Set([
  "bootstrap",
  "startMatch",
  "stopMatch",
  "shutdown",
  "resetDailySession",
  "saveUserPreferences",
  "saveRuntimeSettings",
  "saveStrategyMemory",
  "saveManualVariables",
  "setMode",
  "sendMessage",
  "sendCruiseHardDataQuery",
  "sendDailyCoreTheoryQuery",
  "sendCruisePopularRecipeQuery",
  "stopResponse",
]);

const actionQueueMapping = {
  saveStrategyMemory: { queueName: "strategy_memory_task", status: "completed" },
  buildWikiCurationRequest: { queueName: "wiki_curation_task", status: "pending" },
  saveUserPreferences: { queueName: "user_preferences_task", status: "completed" },
  saveRuntimeSettings: { queueName: "runtime_settings_task", status: "completed" },
  saveManualVariables: { queueName: "manual_variables_task", status: "completed" },
  updateRankings: { queueName: "rankings_update_task", status: "completed" },
  pollCruiseAdvice: { queueName: "cruise_advice_task", status: "completed" },
};

const DAEMON_RESPONSE_TASK_HYDRATE_STALE_MS = Number(process.env.JCC_DAEMON_RESPONSE_TASK_HYDRATE_STALE_MS || 180000);
const daemonLegacyMirrorWrites = new WeakMap();

async function flushDaemonLegacyUiStateMirror(store, entry) {
  while (entry.pending) {
    const pending = entry.pending;
    entry.pending = null;
    try {
      await writeLegacyJsonMirror(pending.file, pending.state);
    } catch (error) {
      try {
        store.appendEvent("daemon_legacy_ui_state_mirror_write_failed", {
          action: pending.action,
          file: pending.file,
          error: error?.message || String(error),
          code: error?.code || null,
        });
      } catch {}
    }
  }
  entry.flush = null;
  if (entry.pending) entry.flush = Promise.resolve().then(() => flushDaemonLegacyUiStateMirror(store, entry));
}

function syncDaemonLegacyUiStateMirror(store, state, action) {
  const file = store?.paths?.uiStateFile;
  if (!file || !state) return;
  const entry = daemonLegacyMirrorWrites.get(store) || { pending: null, flush: null };
  entry.pending = { file, state: structuredClone(state), action };
  if (!entry.flush) entry.flush = Promise.resolve().then(() => flushDaemonLegacyUiStateMirror(store, entry));
  daemonLegacyMirrorWrites.set(store, entry);
}

function staleResponseTaskOnDaemonHydrate(task) {
  if (!task || ![
    "running",
    "response_pending",
    "awaiting_host_cli_agent_response",
    "awaiting_host_cli_agent_coach_response",
    "running_host_cli_visual",
  ].includes(task.status)) return false;
  const startedAt = Date.parse(
    task.started_at
      || task.awaiting_since
      || task.requested_at
      || task.host_request?.created_at
      || ""
  );
  if (!Number.isFinite(startedAt)) return false;
  return Date.now() - startedAt > DAEMON_RESPONSE_TASK_HYDRATE_STALE_MS;
}

function clearStaleDaemonResponseTask(state, reason, options = {}) {
  if (!state) return state;
  const outOfScope = !responseTaskCompatibleWithRuntimeState(state.response_task, state);
  const orphanedByProcessRestart = options.clearInFlight === true && Boolean(
    state.response_task
    && [
      "preparing",
      "running",
      "response_pending",
      "awaiting_host_cli_agent_response",
      "awaiting_host_cli_agent_coach_response",
      "running_host_cli_visual",
      "cancelling",
    ].includes(state.response_task.status),
  );
  if (!outOfScope && !orphanedByProcessRestart && !staleResponseTaskOnDaemonHydrate(state.response_task)) return state;
  return {
    ...state,
    response_task: clearedResponseTask(
      state.response_task,
      `${outOfScope ? "out_of_scope" : orphanedByProcessRestart ? "orphaned_process" : "stale"}_${reason}`,
    ),
  };
}

function reconcileHostCliState(bootHost = {}, sqliteHost = {}) {
  const sqliteProvider = sqliteHost?.provider || sqliteHost?.preferred || null;
  const bootProvider = bootHost?.provider || null;
  if (sqliteProvider && bootProvider && sqliteProvider !== bootProvider) {
    return {
      ...sqliteHost,
      capabilities: null,
      model_options: sqliteHost.model_options || null,
      model_options_error: sqliteHost.model_options_error || `bootstrap_detected_${bootProvider}_while_sqlite_prefers_${sqliteProvider}`,
      protocol: sqliteHost.protocol || (sqliteProvider === "kimi" ? "acp-json-rpc" : "codex-json-event-stream"),
      build_args: sqliteHost.build_args || (sqliteProvider === "kimi" ? ["acp"] : null),
    };
  }
  return {
    ...sqliteHost,
    ...bootHost,
    default_model: bootHost.default_model || sqliteHost.default_model || null,
    default_model_label: bootHost.default_model_label || sqliteHost.default_model_label || null,
    model_options: bootHost.model_options || sqliteHost.model_options || null,
    model_options_error: bootHost.model_options_error || sqliteHost.model_options_error || null,
    capabilities: bootHost.capabilities || sqliteHost.capabilities || null,
  };
}

const daemonQueuedActions = new Set([
  "saveStrategyMemory",
  "buildWikiCurationRequest",
  "saveUserPreferences",
  "saveRuntimeSettings",
  "saveManualVariables",
  "updateRankings",
  "pollCruiseAdvice",
  "sendMessage",
  "sendCruiseHardDataQuery",
  "sendDailyCoreTheoryQuery",
  "sendCruisePopularRecipeQuery",
]);

export async function dispatchRuntimeServiceAction(action, payload, window, dispatch = handleRuntimeServiceAction) {
  return dispatch(action, payload, window);
}

const daemonPreemptiveControlSignals = new Set([
  "startMatch",
  "stopMatch",
  "shutdown",
  "stopResponse",
  "sendMessage",
  "sendCruiseHardDataQuery",
  "sendDailyCoreTheoryQuery",
  "sendCruisePopularRecipeQuery",
]);

const daemonFastControlActions = new Set([
  "stopResponse",
]);

const daemonReadOnlyActions = new Set([
  "getState",
  "getDecisionInputOptions",
  "getManualVariableOptions",
]);

export const runtimeDaemonContract = {
  schema: "jcc-runtime-daemon-v1",
  shape: "independent_os_daemon_sqlite_backed",
  state_owner: "jcc-runtime-daemon",
  sqlite_store: runtimeStoreContract.schema,
  ui_policy: "Electron UI calls daemon; daemon owns runtime state and delegates host model calls through thin adapters.",
  control_transport: "http",
  event_transport: ["websocket", "sse"],
  preemptive_host_actions: [...daemonPreemptiveControlSignals],
};

function safePayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const clone = { ...payload };
  if (typeof clone.text === "string" && clone.text.length > 240) clone.text = `${clone.text.slice(0, 240)}...`;
  if (typeof clone.row_json === "string" && clone.row_json.length > 240) clone.row_json = `${clone.row_json.slice(0, 240)}...`;
  return clone;
}

function boundedIntentTags(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry || "").trim().slice(0, 64))
    .filter(Boolean))]
    .slice(0, 12);
}

function userMessageAudit(text, intentTags = []) {
  const normalized = String(text || "");
  return {
    text_byte_length: Buffer.byteLength(normalized, "utf8"),
    text_sha256: createHash("sha256").update(normalized).digest("hex"),
    intent_tags: boundedIntentTags(intentTags),
  };
}

function persistedActionPayload(action, payload) {
  if (!["sendMessage", "sendCruiseHardDataQuery", "sendDailyCoreTheoryQuery", "sendCruisePopularRecipeQuery"].includes(action)) return safePayload(payload);
  const source = payload && typeof payload === "object" ? payload : {};
  return {
    schema: "jcc-runtime-public-action-persistence-v1",
    action_id: source.action_id || null,
    request_id: source.request_id || null,
    response_task_id: source.response_task_id || null,
    mode: source.mode || null,
    request_kind: source.request_kind || (action === "sendCruiseHardDataQuery"
      ? "hard_data_query"
      : action === "sendDailyCoreTheoryQuery" ? "daily_core_theory_query"
      : action === "sendCruisePopularRecipeQuery" ? "popular_recipe_query" : "host_question"),
    origin_action_id: source.origin_action_id || null,
    evidence_policy_id: source.evidence_policy_id || null,
    item_choice_kind: source.item_choice_kind || null,
    ...userMessageAudit(source.text, source.intent_tags),
  };
}

function collectUserMessageTexts(value, out = new Set(), context = "") {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectUserMessageTexts(entry, out, context));
    return out;
  }
  if (!value || typeof value !== "object") return out;
  const schema = String(value.schema || "");
  const messageContext = context === "recent_user_messages"
    || schema === "jcc-runtime-match-user-message-v1"
    || context === "latest_user_intent";
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && (
      key === "user_message"
      || (key === "text" && messageContext)
      || key === "latest_user_intent_text"
    )) out.add(entry);
    else collectUserMessageTexts(entry, out, key);
  }
  return out;
}

function sanitizeUserMessagePersistence(value, rawMessages = collectUserMessageTexts(value)) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeUserMessagePersistence(entry, rawMessages));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && [...rawMessages].some((message) => message && entry.includes(message))) {
      const audit = userMessageAudit(entry, value.intent_tags);
      for (const [auditKey, auditValue] of Object.entries(audit)) {
        output[key === "text" ? auditKey : `${key}_${auditKey.replace(/^text_/, "")}`] = auditValue;
      }
      continue;
    }
    output[key] = sanitizeUserMessagePersistence(entry, rawMessages);
  }
  if (Object.hasOwn(output, "intent_tags")) output.intent_tags = boundedIntentTags(output.intent_tags);
  return output;
}

function queueScopeForAction(action, runtimeState) {
  const matchSessionId = runtimeState?.match_session?.status === "active"
    ? runtimeState.match_session.match_session_id || null
    : null;
  if (!matchSessionId) return { scopeType: "global", scopeSessionId: null };
  if (["saveManualVariables", "pollCruiseAdvice"].includes(action)) {
    return { scopeType: "match", scopeSessionId: matchSessionId };
  }
  if (["sendMessage", "sendCruiseHardDataQuery", "sendDailyCoreTheoryQuery", "sendCruisePopularRecipeQuery"].includes(action) && !["daily_chat", "postgame_review", "user_preferences", "strategy_wiki"].includes(runtimeState.active_mode)) {
    return { scopeType: "match", scopeSessionId: matchSessionId };
  }
  return { scopeType: "global", scopeSessionId: null };
}

function queueScopeForMatchSession(matchSessionId) {
  const normalized = String(matchSessionId || "").trim() || null;
  return normalized
    ? { scopeType: "match", scopeSessionId: normalized }
    : { scopeType: "global", scopeSessionId: null };
}

function rendererRuntimeState(state) {
  if (!state || typeof state !== "object") return state;
  const runtimeEvents = state.runtime_events && typeof state.runtime_events === "object"
    ? {
        last_observed_at: state.runtime_events.last_observed_at || null,
        latest_count: Array.isArray(state.runtime_events.latest) ? state.runtime_events.latest.length : 0,
      }
    : null;
  const runtimeEventAdvice = state.runtime_event_advice && typeof state.runtime_event_advice === "object"
    ? {
        last_by_category: state.runtime_event_advice.last_by_category || {},
        last_by_trigger: state.runtime_event_advice.last_by_trigger || {},
        last_started_at: state.runtime_event_advice.last_started_at || null,
        last_started_stage_round: state.runtime_event_advice.last_started_stage_round || null,
        handled_count: Object.keys(state.runtime_event_advice.handled || {}).length,
        retry_pending_count: Object.values(state.runtime_event_advice.retry_pending || {})
          .filter((entry) => entry?.status === "pending_retry").length,
      }
    : null;
  const projected = {
    ...state,
    ...(runtimeEvents ? { runtime_events: runtimeEvents } : {}),
    ...(runtimeEventAdvice ? { runtime_event_advice: runtimeEventAdvice } : {}),
  };
  delete projected.runtime_event_log;
  return projected;
}

function rendererRuntimeResult(result) {
  if (!result || typeof result !== "object" || !result.state) return result;
  return { ...result, state: rendererRuntimeState(result.state) };
}

function summarizeResult(result) {
  if (!result || typeof result !== "object") return { ok: Boolean(result) };
  return {
    ok: result.ok !== false,
    status: result.status || null,
    runtime_mode: result.runtime_mode || null,
    match_session_id: result.state?.match_session?.match_session_id || result.session?.match_session_id || null,
    active_mode: result.state?.active_mode || null,
    error: result.error || null,
  };
}

function compactResponse(response) {
  if (!response || typeof response !== "object") return null;
  return {
    schema: response.schema || null,
    request_id: response.request_id || null,
    final_text: typeof response.final_text === "string" ? response.final_text.slice(0, 1200) : null,
    recommended_action: response.recommended_action || null,
    confidence: response.confidence || null,
  };
}

function payloadAudit(value) {
  const json = JSON.stringify(value ?? null);
  return {
    payload_hash: createHash("sha256").update(json).digest("hex"),
    original_payload_bytes: Buffer.byteLength(json, "utf8"),
  };
}

function compactLifecycleTask(task) {
  if (!task || typeof task !== "object") return null;
  return {
    task_id: task.task_id || task.id || null,
    trigger_id: task.trigger_id || task.decision_trigger_id || null,
    status: task.status || null,
    priority: task.priority ?? null,
    stage_round: task.stage_round || task.requested_stage_round || null,
    expires_at: task.expires_at || null,
    update_count: task.update_count ?? null,
    value_score: task.value_score ?? null,
    confidence: task.confidence || null,
  };
}

export function compactAdviceTaskLifecycle(lifecycle) {
  if (!lifecycle || typeof lifecycle !== "object") return null;
  const activeTasks = Array.isArray(lifecycle.active_tasks) ? lifecycle.active_tasks : [];
  const expiredTasks = Array.isArray(lifecycle.expired_tasks) ? lifecycle.expired_tasks : [];
  const outputHistory = Array.isArray(lifecycle.output_history) ? lifecycle.output_history : [];
  return {
    schema: "jcc-advice-task-lifecycle-summary-v1",
    match_session_id: lifecycle.match_session_id || null,
    mode: lifecycle.mode || null,
    updated_at: lifecycle.updated_at || lifecycle.observed_at || new Date().toISOString(),
    active_task_count: activeTasks.length,
    active_tasks: activeTasks.slice(-20).map(compactLifecycleTask).filter(Boolean),
    expired_task_count: expiredTasks.length,
    expired_tasks_tail: expiredTasks.slice(-10).map(compactLifecycleTask).filter(Boolean),
    output_history_count: outputHistory.length,
    output_history_tail: outputHistory.slice(-10).map(compactLifecycleTask).filter(Boolean),
    ...payloadAudit(lifecycle),
  };
}

export function compactPersistedResponseTask(task) {
  if (!task || typeof task !== "object") return task;
  const compact = { ...task };
  for (const key of [
    "task",
    "task_text",
    "user_message",
    "latest_user_intent_text",
    "request_payload",
    "runtime_context",
    "context",
  ]) delete compact[key];
  if (task.host_request && typeof task.host_request === "object") {
    compact.host_request = canonicalHostRequestRef(task.host_request, task.response_task_id || null);
  }
  return compact;
}

function terminalHostRequestQueueStatus(task) {
  const status = task?.status || "";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (/^(?:preempted|superseded|stale_)/.test(status)) return "superseded";
  return null;
}

function hostRequestIdFromResponseTask(task) {
  return task?.response?.request_id
    || task?.host_request?.request_id
    || task?.host_request?.host_cli_agent_request?.request_id
    || task?.cancelled_host_request_id
    || null;
}

function latestQueueEntry(result) {
  const queue = result?.state?.visual_requests?.queue || result?.result?.visual_requests?.queue || result?.visual_requests?.queue;
  return Array.isArray(queue) ? queue.at(-1) || null : null;
}

function responseTaskHasUndeliveredValue(task) {
  if (!task || typeof task !== "object") return false;
  if ([
    "preparing",
    "running",
    "cancelling",
    "response_pending",
    "awaiting_host_cli_agent_response",
    "awaiting_host_cli_agent_coach_response",
    "running_host_cli_visual",
  ].includes(task.status)) return true;
  if (task.status === "completed" && task.response && !task.delivered_at) return true;
  if (task.status === "failed" && !task.delivered_at) return true;
  return false;
}

const dailyScopedResponseTaskModes = new Set([
  "daily_chat",
  "postgame_review",
  "user_preferences",
  "strategy_wiki",
]);

function responseTaskIsMatchScoped(task) {
  const mode = String(task?.mode || "");
  if (dailyScopedResponseTaskModes.has(mode)) return false;
  return Boolean(mode || responseTaskMatchSessionId(task));
}

function normalizeResponseTaskScope(task, runtimeState) {
  const normalized = task && typeof task === "object" ? { ...task } : { status: "idle" };
  if (responseTaskIsMatchScoped(normalized)) {
    return normalized;
  }
  return {
    ...normalized,
    daily_session_generation: normalized.daily_session_generation
      || Math.max(1, Number(runtimeState?.daily_session?.generation || 1) || 1),
  };
}

function responseTaskMatchSessionId(task) {
  return task?.match_session_id
    || task?.host_request?.match_session_id
    || task?.host_request?.runtime_context?.match_session?.match_session_id
    || null;
}

function responseTaskObservedAtMs(task) {
  const candidates = [
    task?.started_at,
    task?.awaiting_since,
    task?.requested_at,
    task?.completed_at,
    task?.failed_at,
    task?.created_at,
    task?.host_request?.created_at,
    task?.host_request?.requested_at,
  ];
  for (const value of candidates) {
    const parsed = Date.parse(value || "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function responseTaskCompatibleWithRuntimeState(task, runtimeState) {
  if (!task || !runtimeState) return true;
  if (!task.response_task_id && [null, undefined, "idle", "cancelled"].includes(task.status)) return true;
  const mode = task.mode || null;
  if (!responseTaskIsMatchScoped(task)) {
    if (runtimeState.match_session?.status === "active") return true;
    const taskGeneration = Number(task.daily_session_generation);
    return Number.isInteger(taskGeneration)
      && taskGeneration > 0
      && taskGeneration === dailySessionGeneration(runtimeState);
  }
  const currentMatchSession = runtimeState.match_session || {};
  if (currentMatchSession.status !== "active") return false;
  const taskMatchSessionId = responseTaskMatchSessionId(task);
  const currentMatchSessionId = currentMatchSession.match_session_id || null;
  if (taskMatchSessionId && currentMatchSessionId && taskMatchSessionId !== currentMatchSessionId) return false;
  if (!taskMatchSessionId && currentMatchSessionId) {
    const taskObservedAtMs = responseTaskObservedAtMs(task);
    const matchStartedAtMs = Date.parse(currentMatchSession.started_at || "");
    if (!Number.isFinite(taskObservedAtMs)) return false;
    if (Number.isFinite(matchStartedAtMs) && taskObservedAtMs < matchStartedAtMs) return false;
  }
  return true;
}

function clearedResponseTask(task, reason) {
  return {
    status: "idle",
    previous_status: `cleared_${task?.status || "unknown"}_${reason}`,
    previous_response_task_id: task?.response_task_id || null,
    previous_mode: task?.mode || null,
    previous_match_session_id: responseTaskMatchSessionId(task),
    cleared_at: new Date().toISOString(),
  };
}

const canonicalClearingResponseTaskStatuses = new Set([
  "failed",
  "dropped_for_user_priority",
  "preempted_by_higher_priority_context",
  "superseded_by_choice_confirmation",
  "superseded_by_choice_window",
  "superseded_by_mode_switch",
  "superseded_by_stage_change",
  "stale_logged_only",
  "cancelled",
]);

function incomingResponseTaskClearsCanonical(incomingTask) {
  if (!incomingTask || typeof incomingTask !== "object") return false;
  if (incomingTask.delivered_at || incomingTask.preempted_at || incomingTask.superseded_at || incomingTask.failed_at) return true;
  return canonicalClearingResponseTaskStatuses.has(incomingTask.status || "");
}

const automaticResponseTaskOrigins = new Set(["runtime_event", "auto_cruise"]);

function userPriorityResponseTask(task) {
  const origin = task?.origin || "";
  return origin === "user"
    || origin === "visual_advice"
    || origin.startsWith("user_");
}

function userTaskSupersedesAutomaticTask(incomingTask, canonicalTask, runtimeState = null) {
  if (!incomingTask?.response_task_id || !canonicalTask?.response_task_id) return false;
  if (incomingTask.response_task_id === canonicalTask.response_task_id) return false;
  if (!userPriorityResponseTask(incomingTask)) return false;
  if (!automaticResponseTaskOrigins.has(canonicalTask.origin || "")) return false;
  if (!responseTaskCompatibleWithRuntimeState(incomingTask, runtimeState)) return false;
  if (!responseTaskCompatibleWithRuntimeState(canonicalTask, runtimeState)) return false;
  return true;
}

function newerUserTaskSupersedesUndeliveredUserTask(incomingTask, canonicalTask, runtimeState = null) {
  if (!incomingTask?.response_task_id || !canonicalTask?.response_task_id) return false;
  if (incomingTask.response_task_id === canonicalTask.response_task_id) return false;
  if (!userPriorityResponseTask(incomingTask) || !userPriorityResponseTask(canonicalTask)) return false;
  if (!activeResponseTaskStatuses.has(incomingTask.status || "")) return false;
  if (!responseTaskCompatibleWithRuntimeState(incomingTask, runtimeState)) return false;
  if (!responseTaskCompatibleWithRuntimeState(canonicalTask, runtimeState)) return false;
  const incomingRevision = Number(incomingTask.revision);
  const canonicalRevision = Number(canonicalTask.revision);
  if (!Number.isInteger(incomingRevision) || !Number.isInteger(canonicalRevision)) return false;
  return incomingRevision > canonicalRevision;
}

const activeResponseTaskStatuses = new Set([
  "preparing",
  "running",
  "cancelling",
  "response_pending",
  "ai_native_requested",
  "awaiting_host_cli_agent_response",
  "awaiting_host_cli_agent_coach_response",
  "awaiting_host_cli_agent_visual_response",
  "running_host_cli_visual",
]);

const terminalResponseTaskStatuses = new Set([
  "failed",
  "cancelled",
  "dropped_for_user_priority",
  "stale_logged_only",
  "superseded_by_choice_window",
  "choice_confirmation_recorded",
  "fast_choice_text_no_choice",
  "fast_choice_text_capture_failed",
  "fast_choice_text_worker_failed",
]);

function responseTaskOwnerId(task) {
  return task?.response_task_id
    || task?.previous_response_task_id
    || task?.cancelled_response_task_id
    || task?.superseded_response_task_id
    || task?.previous_response_task?.response_task_id
    || null;
}

function responseTaskContentSignature(task) {
  if (!task || typeof task !== "object") return "null";
  const comparable = { ...task };
  delete comparable.revision;
  return JSON.stringify(comparable);
}

function responseTaskTransitionRank(task) {
  const status = task?.status || "idle";
  if (status === "preparing") return 10;
  if (activeResponseTaskStatuses.has(status)) return 20;
  if (terminalResponseTaskStatuses.has(status)) return 30;
  if (/^(?:preempted|superseded)/.test(status)) return 30;
  if (status === "completed") return 40;
  if (status === "delivered" || task?.delivered_at) return 50;
  return 0;
}

function responseTaskTransitionDecision(canonicalTask, incomingTask, runtimeState) {
  if (!responseTaskCompatibleWithRuntimeState(incomingTask, runtimeState)) {
    return { accepted: false, reason: "response_task_outside_runtime_scope" };
  }
  const canonicalOwner = responseTaskOwnerId(canonicalTask);
  const incomingOwner = responseTaskOwnerId(incomingTask);
  if (responseTaskContentSignature(canonicalTask) === responseTaskContentSignature(incomingTask)) {
    return { accepted: false, reason: "response_task_unchanged" };
  }
  if (canonicalOwner && incomingOwner && canonicalOwner === incomingOwner) {
    if (incomingResponseTaskClearsCanonical(incomingTask)) {
      return { accepted: true, reason: "same_response_task_cleared" };
    }
    if (responseTaskTransitionRank(incomingTask) < responseTaskTransitionRank(canonicalTask)) {
      return { accepted: false, reason: "response_task_status_regression" };
    }
    return { accepted: true, reason: "same_response_task_rebased" };
  }
  if (userTaskSupersedesAutomaticTask(incomingTask, canonicalTask, runtimeState)) {
    return { accepted: true, reason: "user_response_task_supersedes_automatic" };
  }
  if (newerUserTaskSupersedesUndeliveredUserTask(incomingTask, canonicalTask, runtimeState)) {
    return { accepted: true, reason: "newer_user_response_task_supersedes_older_user_task" };
  }
  if (responseTaskHasUndeliveredValue(canonicalTask)) {
    return { accepted: false, reason: "canonical_response_task_still_undelivered" };
  }
  if (!incomingOwner && !incomingTask?.response_task_id) {
    return { accepted: true, reason: "ownerless_terminal_or_idle_transition" };
  }
  return { accepted: true, reason: "new_response_task_owner" };
}

function shouldPreserveCanonicalResponseTask(incomingTask, canonicalTask, runtimeState = null) {
  if (!responseTaskHasUndeliveredValue(canonicalTask)) return false;
  if (!responseTaskCompatibleWithRuntimeState(canonicalTask, runtimeState)) return false;
  const transition = responseTaskTransitionDecision(canonicalTask, incomingTask, runtimeState);
  if (transition.accepted) return false;
  if (incomingResponseTaskClearsCanonical(incomingTask)) {
    return !responseTaskCompatibleWithRuntimeState(incomingTask, runtimeState);
  }
  if (!incomingTask || incomingTask.status === "idle") return true;
  if (canonicalTask.status === "completed" && canonicalTask.response && !canonicalTask.delivered_at && incomingTask.status !== "completed") return true;
  if (canonicalTask.status === "failed" && !canonicalTask.delivered_at && incomingTask.status !== "failed") return true;
  if (
    canonicalTask.response_task_id
    && incomingTask.response_task_id
    && canonicalTask.response_task_id !== incomingTask.response_task_id
  ) {
    return false;
  }
  if (canonicalTask.response_task_id && !incomingTask.response_task_id && incomingTask.status !== "completed") return true;
  if (canonicalTask.status === "completed" && canonicalTask.response && !canonicalTask.delivered_at && incomingTask.status !== "completed") return true;
  return false;
}

function mergeCanonicalSlices(state, store) {
  if (!state || typeof state !== "object") return state;
  let merged = state;
  const variables = store.getJson("manual_match_variables_latest", null);
  if (
    variables?.schema
    && merged.match_session?.status === "active"
    && variables.match_session_id === merged.match_session?.match_session_id
    && !merged.manual_match_variables
  ) {
    merged = { ...merged, manual_match_variables: variables };
  }
  const currentMatchSessionId = merged.match_session?.match_session_id || null;
  const connectedLiveStateSessionId = merged.match_connection?.last_live_state_match_session_id || null;
  if (
    merged.match_session?.status === "active"
    && merged.match_connection?.status === "connected_to_live_match"
    && currentMatchSessionId
    && connectedLiveStateSessionId
    && connectedLiveStateSessionId !== currentMatchSessionId
  ) {
    merged = {
      ...merged,
      match_connection: {
      ...merged.match_connection,
      status: "waiting_for_current_match_live_state",
      connected_at: null,
      rejected_live_state_match_session_id: connectedLiveStateSessionId,
      reason: "hydrated_state_live_state_match_session_mismatch",
      },
    };
  }
  return merged;
}

export function preserveSqliteCanonicalState(bootstrappedState, sqliteState) {
  if (!bootstrappedState || typeof bootstrappedState !== "object") return sqliteState;
  const preservedKeys = [
    "device_connection",
    "match_session",
    "match_connection",
    "response_task",
    "resolved_decision_snapshot",
    "active_mode",
    "host_cli",
    "visual_request_status",
    "visual_requests",
    "runtime_triggers",
    "cruise_state_fingerprint",
    "manual_match_variables",
    "match_context",
    "user_preferences",
    "runtime_settings",
    "user_strategy_memory",
  ];
  const merged = { ...bootstrappedState };
  const sanitizedSqliteState = clearStaleDaemonResponseTask(sqliteState, "during_daemon_reconcile");
  const bootstrapClearedDeadResponseTask = /^cleared_stale_/u.test(
    String(bootstrappedState.response_task?.previous_status || ""),
  );
  for (const key of preservedKeys) {
    if (key === "response_task" && bootstrapClearedDeadResponseTask) continue;
    if (key === "host_cli" && sanitizedSqliteState?.host_cli !== undefined) {
      merged.host_cli = reconcileHostCliState(bootstrappedState.host_cli || {}, sanitizedSqliteState.host_cli || {});
      continue;
    }
    if (sanitizedSqliteState?.[key] !== undefined) merged[key] = sanitizedSqliteState[key];
  }
  return clearStaleDaemonResponseTask(merged, "after_daemon_reconcile");
}

function activeMatchSessionId(runtimeState) {
  if (runtimeState?.match_session?.status !== "active") return null;
  return runtimeState.match_session.match_session_id || null;
}

function dailySessionGeneration(runtimeState) {
  const generation = Number(runtimeState?.daily_session?.generation);
  return Number.isInteger(generation) && generation > 0 ? generation : 1;
}

function detachedSnapshotOwnsCanonicalDailySession(canonicalState, incomingState) {
  if (activeMatchSessionId(canonicalState) || activeMatchSessionId(incomingState)) return true;
  return dailySessionGeneration(canonicalState) === dailySessionGeneration(incomingState);
}

function detachedSnapshotOwnsCanonicalMatch(canonicalState, incomingState) {
  const canonicalMatchId = activeMatchSessionId(canonicalState);
  const incomingMatchId = activeMatchSessionId(incomingState);
  if (!canonicalMatchId && !incomingMatchId) return true;
  return Boolean(canonicalMatchId && incomingMatchId && canonicalMatchId === incomingMatchId);
}

function matchSessionBoundaryOwnsCanonicalTransition(canonicalState, incomingState, meta = {}) {
  const incomingMatchId = activeMatchSessionId(incomingState);
  const canonicalMatchId = activeMatchSessionId(canonicalState);
  const payload = meta.event_payload || {};
  if (!incomingMatchId || payload.match_session_id !== incomingMatchId) return false;
  const expectedPreviousMatchId = payload.previous_match_session_id || null;
  if (canonicalMatchId !== expectedPreviousMatchId) return false;
  return incomingMatchId !== canonicalMatchId;
}

function hostSessionDescriptorOwnsCanonicalRoute(canonicalState, incomingState, routeKind, meta = {}) {
  if (!new Set(["daily", "match"]).has(routeKind)) return false;
  const incomingDescriptor = incomingState?.host_sessions?.[routeKind];
  const canonicalDescriptor = canonicalState?.host_sessions?.[routeKind];
  if (!incomingDescriptor?.route_key || meta?.event_payload?.route_key !== incomingDescriptor.route_key) return false;
  if (canonicalDescriptor?.route_key && canonicalDescriptor.route_key !== incomingDescriptor.route_key) return false;
  if (routeKind === "match") {
    const canonicalMatchId = activeMatchSessionId(canonicalState);
    return Boolean(
      canonicalMatchId
      && incomingDescriptor.match_session_id === canonicalMatchId
      && activeMatchSessionId(incomingState) === canonicalMatchId
    );
  }
  return dailySessionGeneration(canonicalState) === dailySessionGeneration(incomingState);
}

function responseTaskRevision(runtimeState) {
  const taskRevision = Number(runtimeState?.response_task?.revision);
  const stateRevision = Number(runtimeState?.response_task_revision);
  if (Number.isInteger(taskRevision) && taskRevision >= 0) return taskRevision;
  if (Number.isInteger(stateRevision) && stateRevision >= 0) return stateRevision;
  return 0;
}

function mergeDetachedHudContext(canonicalContext, incomingContext) {
  if (!incomingContext?.latest_hud_self_state) return canonicalContext || null;
  const canonicalFacts = canonicalContext?.latest_authoritative_facts || {};
  const incomingFacts = incomingContext?.latest_authoritative_facts || {};
  return {
    ...(canonicalContext || {}),
    latest_hud_self_state: incomingContext.latest_hud_self_state,
    updated_at: incomingContext.updated_at || canonicalContext?.updated_at || null,
    latest_authoritative_facts: {
      ...canonicalFacts,
      stage_round: incomingFacts.stage_round ?? canonicalFacts.stage_round ?? null,
      economy: incomingFacts.economy ?? canonicalFacts.economy ?? {},
      missing_economy_fields: incomingFacts.missing_economy_fields ?? canonicalFacts.missing_economy_fields ?? [],
      latest_hud_self_state: incomingFacts.latest_hud_self_state || incomingContext.latest_hud_self_state,
      updated_at: incomingFacts.updated_at || canonicalFacts.updated_at || incomingContext.updated_at || null,
    },
  };
}

function mergeDetachedRuntimeEventAdvice(canonicalAdvice, incomingAdvice, eventKeys) {
  const keys = [...new Set((Array.isArray(eventKeys) ? eventKeys : [eventKeys]).filter(Boolean))];
  const ownedEntries = Object.fromEntries(
    keys
      .filter((eventKey) => incomingAdvice?.handled?.[eventKey])
      .map((eventKey) => [eventKey, incomingAdvice.handled[eventKey]]),
  );
  if (!Object.keys(ownedEntries).length) return canonicalAdvice;
  return {
    ...(canonicalAdvice || {}),
    handled: {
      ...(canonicalAdvice?.handled || {}),
      ...ownedEntries,
    },
  };
}

function detachedWatcherEventOwnsCanonicalWatcher(canonicalState, incomingState, meta) {
  const payload = meta?.event_payload || {};
  const canonicalMatchId = activeMatchSessionId(canonicalState);
  const incomingMatchId = activeMatchSessionId(incomingState);
  const payloadMatchId = payload.match_session_id || null;
  if (!canonicalMatchId || canonicalMatchId !== incomingMatchId || canonicalMatchId !== payloadMatchId) return false;
  const expectedPid = Number(payload.supervisor_pid);
  const canonicalPid = Number(canonicalState?.watcher?.pid);
  return Number.isInteger(expectedPid) && expectedPid > 0 && canonicalPid === expectedPid;
}

export function mergeRuntimeServiceCanonicalSnapshot(canonicalState, incomingState, meta = {}) {
  if (!canonicalState || typeof canonicalState !== "object") {
    return { applied: true, reason: "canonical_state_missing", state: incomingState };
  }
  if (!incomingState || typeof incomingState !== "object") {
    return { applied: false, reason: "incoming_state_missing", state: canonicalState };
  }
  const eventType = String(meta.event_type || "");
  if (eventType === "app_session_boundary_started") {
    if (activeMatchSessionId(canonicalState) !== (meta.event_payload?.previous_match_session_id || null)
      || dailySessionGeneration(canonicalState) !== meta.event_payload?.previous_daily_session_generation
      || activeMatchSessionId(incomingState) !== null
      || dailySessionGeneration(incomingState) !== dailySessionGeneration(canonicalState) + 1) {
      return { applied: false, reason: "app_session_boundary_ownership_mismatch", state: canonicalState };
    }
    const revision = responseTaskRevision(canonicalState) + 1;
    return {
      applied: true, reason: eventType, accepted_response_task: true,
      state: { ...incomingState, response_task_revision: revision,
        response_task: { ...incomingState.response_task, revision } },
    };
  }
  if (eventType === "match_session_boundary_started") {
    if (!matchSessionBoundaryOwnsCanonicalTransition(canonicalState, incomingState, meta)) {
      return { applied: false, reason: "match_session_boundary_ownership_mismatch", state: canonicalState };
    }
    const revision = responseTaskRevision(canonicalState) + 1;
    return {
      applied: true,
      reason: "match_session_boundary_started",
      changed_keys: ["match_session", "host_sessions.match", "response_task"],
      accepted_response_task: true,
      state: {
        ...incomingState,
        response_task_revision: revision,
        response_task: {
          ...(incomingState.response_task || { status: "idle" }),
          revision,
        },
      },
    };
  }
  if (!detachedSnapshotOwnsCanonicalMatch(canonicalState, incomingState)) {
    return { applied: false, reason: "match_session_ownership_mismatch", state: canonicalState };
  }
  if (!detachedSnapshotOwnsCanonicalDailySession(canonicalState, incomingState)) {
    return { applied: false, reason: "daily_session_generation_mismatch", state: canonicalState };
  }

  const merged = { ...canonicalState };
  const changedKeys = [];
  const canonicalRevision = responseTaskRevision(canonicalState);
  const incomingRevision = responseTaskRevision(incomingState);
  const canonicalTask = canonicalState.response_task || null;
  const incomingTask = incomingState.response_task || null;
  const responseTaskDecision = responseTaskTransitionDecision(canonicalTask, incomingTask, canonicalState);
  let acceptedResponseTask = false;

  if (eventType === "host_session_state_changed") {
    const routeKind = String(meta?.event_payload?.route_kind || "");
    if (!hostSessionDescriptorOwnsCanonicalRoute(canonicalState, incomingState, routeKind, meta)) {
      return { applied: false, reason: "host_session_route_ownership_mismatch", state: canonicalState };
    }
    merged.host_sessions = {
      ...(canonicalState.host_sessions || {}),
      [routeKind]: incomingState.host_sessions[routeKind],
    };
    changedKeys.push(`host_sessions.${routeKind}`);
  }

  if (responseTaskDecision.accepted) {
    const canonicalNextRevision = canonicalRevision + 1;
    merged.response_task = {
      ...(incomingState.response_task || { status: "idle" }),
      revision: canonicalNextRevision,
    };
    merged.response_task_revision = canonicalNextRevision;
    acceptedResponseTask = true;
    changedKeys.push("response_task");
  }

  if (eventType === "hud_facts_changed") {
    if (incomingState.self_state_refresh !== undefined) {
      merged.self_state_refresh = incomingState.self_state_refresh;
      changedKeys.push("self_state_refresh");
    }
    const mergedContext = mergeDetachedHudContext(canonicalState.match_context, incomingState.match_context);
    if (mergedContext !== canonicalState.match_context) {
      merged.match_context = mergedContext;
      changedKeys.push("match_context.latest_hud_self_state");
    }
  } else if (eventType === "self_state_refresh_changed" && incomingState.self_state_refresh !== undefined) {
    merged.self_state_refresh = incomingState.self_state_refresh;
    changedKeys.push("self_state_refresh");
  } else if (eventType === "rankings_status_changed" && incomingState.rankings_status !== undefined) {
    merged.rankings_status = incomingState.rankings_status;
    changedKeys.push("rankings_status");
  } else if (eventType === "ranking_update_task_changed" && incomingState.ranking_update_task !== undefined) {
    merged.ranking_update_task = incomingState.ranking_update_task;
    changedKeys.push("ranking_update_task");
  } else if (eventType === "watcher_observation") {
    for (const key of ["watcher", "match_connection", "runtime_events", "runtime_event_detector", "runtime_triggers"]) {
      if (incomingState[key] === undefined) continue;
      merged[key] = incomingState[key];
      changedKeys.push(key);
    }
  } else if (
    [
      "watcher_process_stopped",
      "watcher_process_ownership_mismatch",
      "watcher_process_termination_failed",
      "watcher_process_marked_stopped",
    ].includes(eventType)
    && detachedWatcherEventOwnsCanonicalWatcher(canonicalState, incomingState, meta)
    && incomingState.watcher !== undefined
  ) {
    merged.watcher = incomingState.watcher;
    changedKeys.push("watcher");
  }

  if (changedKeys.includes("rankings_status") || changedKeys.includes("ranking_update_task")) {
    merged.ranking_status_view = buildRankingStatusViewModel({
      rankingsStatus: merged.rankings_status,
      updateTask: merged.ranking_update_task,
    });
    changedKeys.push("ranking_status_view");
  }

  if (acceptedResponseTask) {
    const eventKeys = meta?.event_payload?.event_keys
      || meta?.event_payload?.event_key
      || incomingState.response_task?.event_key
      || null;
    if (eventType.startsWith("runtime_event_response_task_")) {
      const mergedAdvice = mergeDetachedRuntimeEventAdvice(
        canonicalState.runtime_event_advice,
        incomingState.runtime_event_advice,
        eventKeys,
      );
      if (mergedAdvice !== canonicalState.runtime_event_advice) {
        merged.runtime_event_advice = mergedAdvice;
        changedKeys.push("runtime_event_advice.handled");
      }
    }
    if (eventType === "user_intent_direct_response_completed") {
      const mergedAdvice = mergeDetachedRuntimeEventAdvice(
        canonicalState.runtime_event_advice,
        incomingState.runtime_event_advice,
        eventKeys,
      );
      if (mergedAdvice !== canonicalState.runtime_event_advice) {
        merged.runtime_event_advice = mergedAdvice;
        changedKeys.push("runtime_event_advice.handled");
      }
    }
    if (eventType.startsWith("visual_advice_response_task_")) {
      const requestId = meta?.event_payload?.request_id || null;
      if (
        requestId
        && canonicalState.visual_request_status?.request_id === requestId
        && incomingState.visual_request_status?.request_id === requestId
      ) {
        merged.visual_request_status = incomingState.visual_request_status;
        changedKeys.push("visual_request_status");
      }
    }
  }

  if (!changedKeys.length) {
    return {
      applied: false,
      reason: responseTaskDecision.reason || (incomingRevision <= canonicalRevision ? "no_new_owned_fields" : "response_task_transition_rejected"),
      state: canonicalState,
    };
  }
  merged.updated_at = incomingState.updated_at || canonicalState.updated_at || new Date().toISOString();
  return {
    applied: true,
    reason: acceptedResponseTask ? responseTaskDecision.reason : "owned_fields_merged",
    changed_keys: [...new Set(changedKeys)],
    accepted_response_task: acceptedResponseTask,
    state: merged,
  };
}

function compactActionTask(action, result) {
  return {
    action,
    status: result?.status || null,
    ok: result?.ok !== false,
    mode: result?.runtime_mode || result?.state?.active_mode || null,
    match_session_id: result?.state?.match_session?.match_session_id || null,
    has_host_request: Boolean(result?.host_request),
    has_response: Boolean(result?.response),
    updated_at: new Date().toISOString(),
  };
}

export class JccRuntimeDaemon {
  constructor({ repoRoot, dataRoot = null }) {
    this.repoRoot = repoRoot;
    configureRuntimeServicePaths({ dataRoot });
    this.store = createRuntimeSqliteStore(repoRoot, dataRoot ? { dataRoot } : {});
    this.started = false;
    this.actionChain = Promise.resolve();
    this.serviceBootstrappedAt = 0;
    this.runtimeEventListeners = new Set();
  }

  onRuntimeEvent(listener) {
    if (typeof listener !== "function") return () => {};
    this.runtimeEventListeners.add(listener);
    return () => this.runtimeEventListeners.delete(listener);
  }

  emitCommittedRuntimeEvent(event) {
    if (!event) return;
    for (const listener of this.runtimeEventListeners) {
      try {
        listener(event);
      } catch (error) {
        try {
          this.store.appendEvent("daemon_runtime_event_listener_failed", {
            event_id: event.id || null,
            event_type: event.event_type || null,
            error: error?.message || String(error),
          });
        } catch {}
      }
    }
  }

  maintainStorage(reason, checkpointMode = "PASSIVE") {
    const retention = this.store.enforceRetentionBudget();
    const completedAt = new Date().toISOString();
    this.store.setJson("runtime_storage_maintenance_latest", {
      reason,
      retention,
      checkpoint_mode: checkpointMode,
      completed_at: completedAt,
    });
    const checkpoint = this.store.checkpoint(checkpointMode);
    return {
      schema: "jcc-runtime-storage-maintenance-result-v1",
      reason,
      retention,
      checkpoint,
      completed_at: completedAt,
    };
  }

  start() {
    if (this.started) return this;
    this.store.open();
    let persistedState = this.store.getJson("ui_runtime_state", null);
    if (!persistedState?.schema) {
      const serviceDefaultState = getRuntimeServiceState();
      const seeded = this.store.commitRuntimeTransition({
        state: serviceDefaultState,
        responseTask: serviceDefaultState.response_task || { status: "idle" },
        eventType: "daemon_default_runtime_state_seeded",
        eventPayload: {
          source: "daemon_start",
          canonical_writer: "jcc_runtime_daemon",
          legacy_json_policy: "compatibility_mirror_or_debug_export_only",
        },
      });
      persistedState = seeded.state;
      setRuntimeServiceState(persistedState);
      syncDaemonLegacyUiStateMirror(this.store, persistedState, "daemon_start_default_state");
    }
    const canonicalMatchSessionId = persistedState?.match_session?.status === "active"
      ? persistedState.match_session.match_session_id || null
      : null;
    this.store.closeOtherActiveMatchSessions(canonicalMatchSessionId, "abandoned");
    const persistedTaskOutOfScope = persistedState
      ? !responseTaskCompatibleWithRuntimeState(persistedState.response_task, persistedState)
      : false;
    const recoveredState = clearStaleDaemonResponseTask(persistedState, "during_daemon_start", { clearInFlight: true });
    if (recoveredState && recoveredState !== persistedState) {
      this.store.setJson("ui_runtime_state", recoveredState);
      this.store.setJson("response_task", compactPersistedResponseTask({
        ...normalizeResponseTaskScope(recoveredState.response_task, recoveredState),
        revision: responseTaskRevision(recoveredState),
      }));
      syncDaemonLegacyUiStateMirror(this.store, recoveredState, "daemon_start_recovery");
      this.store.appendEvent("daemon_recovered_stale_response_task_on_start", {
        previous_response_task_id: persistedState?.response_task?.response_task_id || null,
        previous_status: persistedState?.response_task?.status || null,
      });
      if (persistedTaskOutOfScope) {
        this.store.appendEvent("daemon_cleared_out_of_scope_canonical_response_task", {
          action: "daemon_start_recovery",
          canonical_status: persistedState?.response_task?.status || null,
          canonical_response_task_id: persistedState?.response_task?.response_task_id || null,
          canonical_mode: persistedState?.response_task?.mode || null,
          canonical_match_session_id: responseTaskMatchSessionId(persistedState?.response_task),
          current_match_session_id: persistedState?.match_session?.match_session_id || null,
          current_match_session_status: persistedState?.match_session?.status || null,
        });
      }
    }
    setRuntimeServiceCanonicalStateWriter((nextState, meta = {}) => (
      this.persistRuntimeServiceCanonicalSnapshot(nextState, meta)
    ));
    setRuntimeServiceEventWriter((eventType, event) => (
      this.store.appendEvent(eventType, sanitizeUserMessagePersistence(event))
    ));
    this.store.setJson("runtime_daemon_contract", runtimeDaemonContract);
    this.store.appendEvent("daemon_started", {
      schema: runtimeDaemonContract.schema,
      repo_root: this.repoRoot,
      sqlite_file: this.store.paths.sqliteFile,
    });
    const recovered = this.store.recoverStaleQueueItems({ staleMs: 120000, limit: 100 });
    if (recovered.length) {
      this.store.appendEvent("daemon_stale_queue_recovered_on_start", {
        count: recovered.length,
        queue_item_ids: recovered.map((item) => item.id),
      });
    }
    const maintenance = this.maintainStorage("daemon_start", "PASSIVE");
    this.store.appendEvent("daemon_storage_maintenance_completed", maintenance);
    this.started = true;
    return this;
  }

  persistRuntimeServiceCanonicalSnapshot(nextState, meta = {}) {
    const canonicalState = this.store.getJson("ui_runtime_state", null);
    const merged = mergeRuntimeServiceCanonicalSnapshot(canonicalState, nextState, meta);
    if (!merged.applied) {
      if (["match_session_ownership_mismatch", "daily_session_generation_mismatch"].includes(merged.reason)) {
        this.store.appendEvent("runtime_service_detached_snapshot_rejected", {
          source: meta.source || "runtime_service_detached_completion",
          reason: merged.reason,
          canonical_match_session_id: canonicalState?.match_session?.match_session_id || null,
          incoming_match_session_id: nextState?.match_session?.match_session_id || null,
          canonical_daily_session_generation: dailySessionGeneration(canonicalState),
          incoming_daily_session_generation: dailySessionGeneration(nextState),
          response_task_id: nextState?.response_task?.response_task_id || null,
          response_task_revision: responseTaskRevision(nextState),
        });
      }
      return merged;
    }
    this.persistResult(
      meta.source || "runtime_service_detached_completion",
      { ok: true, state: merged.state,
        new_app_session: meta.event_type === "app_session_boundary_started",
        stopped_match_session_id: meta.event_payload?.previous_match_session_id || null,
        retired_match_summary: meta.event_payload?.retired_match_summary || null,
      },
      {
        eventType: meta.event_type || null,
        eventPayload: {
          ...(meta.event_payload && typeof meta.event_payload === "object" ? meta.event_payload : {}),
          detached_merge_reason: merged.reason,
          detached_changed_keys: merged.changed_keys || [],
        },
        syncServiceState: false,
      },
    );
    return merged;
  }

  async hydrateServiceState(options = {}) {
    this.start();
    const allowBootstrap = options.allowBootstrap !== false;
    const forceBootstrap = Boolean(options.forceBootstrap);
    const persistRepairs = options.persistRepairs !== false;
    const sqliteState = this.store.getJson("ui_runtime_state", null);
    if (sqliteState?.schema) {
      const mergedState = mergeCanonicalSlices(sqliteState, this.store);
      const repaired = mergedState !== sqliteState;
      if (repaired && persistRepairs) {
        this.store.setJson("ui_runtime_state", mergedState);
        this.store.setJson("response_task", compactPersistedResponseTask({
          ...normalizeResponseTaskScope(mergedState.response_task, mergedState),
          revision: responseTaskRevision(mergedState),
        }));
        syncDaemonLegacyUiStateMirror(this.store, mergedState, "hydrate_repair");
        if (!responseTaskCompatibleWithRuntimeState(sqliteState.response_task, sqliteState)) {
          this.store.appendEvent("daemon_cleared_out_of_scope_canonical_response_task", {
            action: "hydrate",
            canonical_status: sqliteState.response_task?.status || null,
            canonical_response_task_id: sqliteState.response_task?.response_task_id || null,
            canonical_mode: sqliteState.response_task?.mode || null,
            canonical_match_session_id: responseTaskMatchSessionId(sqliteState.response_task),
            current_match_session_id: sqliteState.match_session?.match_session_id || null,
            current_match_session_status: sqliteState.match_session?.status || null,
          });
        }
        this.store.appendEvent("service_state_repaired_during_hydration", { source: "sqlite" });
      }
      setRuntimeServiceState(mergedState);
      if (options.audit !== false) this.store.appendEvent("service_state_hydrated", { source: "sqlite" });
      const bootstrapDue = forceBootstrap;
      if (!bootstrapDue) {
        if (options.audit !== false) {
          this.store.appendEvent("service_state_bootstrap_reconcile_skipped", {
            source: "sqlite",
            reason: allowBootstrap ? "explicit_bootstrap_required" : "bootstrap_reconcile_disabled_for_action",
            bootstrapped_at: this.serviceBootstrappedAt ? new Date(this.serviceBootstrappedAt).toISOString() : null,
          });
        }
        return mergedState;
      }
      const bootstrapped = await handleRuntimeServiceAction("bootstrap", {}, null);
      if (bootstrapped?.state) {
        this.serviceBootstrappedAt = Date.now();
        const reconciledState = bootstrapped.new_app_session
          ? bootstrapped.state : preserveSqliteCanonicalState(bootstrapped.state, mergedState);
        setRuntimeServiceState(reconciledState);
        this.persistResult("bootstrap", { ...bootstrapped, state: reconciledState });
        this.store.appendEvent("service_state_bootstrap_reconciled", {
          source: "sqlite",
          match_session_status: reconciledState.match_session?.status || null,
          watcher_status: reconciledState.watcher?.status || null,
        });
        return reconciledState;
      }
      return mergedState;
    }
    const serviceState = getRuntimeServiceState();
    if (persistRepairs) {
      this.store.setJson("ui_runtime_state", serviceState);
      this.store.setJson("response_task", compactPersistedResponseTask({
        ...normalizeResponseTaskScope(serviceState.response_task, serviceState),
        revision: responseTaskRevision(serviceState),
      }));
      this.store.appendEvent("service_state_hydrated", {
        source: "service_default",
        legacy_json_policy: "compatibility_mirror_or_debug_export_only",
      });
    }
    return serviceState;
  }

  async reconcileDerivedStateOnStart() {
    await this.hydrateServiceState({
      allowBootstrap: false,
      audit: false,
      persistRepairs: true,
    });
    if (getRuntimeServiceState().match_session?.status === "active") {
      const skipped = {
        applied: false,
        reason: "active_match_requires_pinned_snapshot_bootstrap",
      };
      this.store.appendEvent("daemon_start_ranking_reconcile_skipped", skipped);
      return skipped;
    }
    const rankingsStatus = await reconcileActiveRankingStatus({
      persist: true,
      source: "daemon_start_active_ranking_reconciled",
    });
    const result = {
      applied: true,
      reason: "idle_runtime_active_ranking_reconciled",
      stat_date: rankingsStatus?.stat_date || null,
      snapshot_in_use: rankingsStatus?.snapshot_in_use || null,
    };
    this.store.appendEvent("daemon_start_ranking_reconciled", result);
    return result;
  }

  stop() {
    if (!this.started) return;
    this.store.appendEvent("daemon_stopped", { repo_root: this.repoRoot });
    this.maintainStorage("daemon_stop", "TRUNCATE");
    setRuntimeServiceCanonicalStateWriter(null);
    setRuntimeServiceEventWriter(null);
    this.store.close();
    this.started = false;
  }

  async handleAction(action, payload, window) {
    let actionPayload = payload;
    const statusPingOnly = action === "sendMessage" && messageIsResponseStatusPing(payload?.text);
    if (daemonPreemptiveControlSignals.has(action) && !statusPingOnly) {
      const requestedTaskId = action === "stopResponse"
        ? String(payload?.response_task_id || "").trim() || null
        : null;
      const canonicalTask = action === "stopResponse" ? this.store.getJson("response_task", null) : null;
      const requestedRevision = Number(payload?.response_task_revision);
      const stopIdentityMatches = action !== "stopResponse"
        || (
          Boolean(requestedTaskId)
          && requestedTaskId === canonicalTask?.response_task_id
          && Number.isInteger(requestedRevision)
          && requestedRevision === Number(canonicalTask?.revision)
        );
      const cancellation = stopIdentityMatches
        ? cancelHostAgentRunDetailed(requestedTaskId)
        : {
            accepted: false,
            requested_task_id: requestedTaskId,
            matched_task_ids: [],
            cancelled_task_ids: [],
            matched_count: 0,
            cancelled_count: 0,
          };
      const runtimeState = this.store.getJson("ui_runtime_state", null);
      const matchRouteKey = runtimeState?.host_sessions?.match?.route_key
        || (runtimeState?.match_session?.match_session_id
          ? `match:${runtimeState.match_session.match_session_id}`
          : null);
      const dailyRouteKey = runtimeState?.host_sessions?.daily?.route_key
        || `daily:${dailySessionGeneration(runtimeState)}`;
      const bootstrapRouteKeys = action === "shutdown"
        ? [...new Set([dailyRouteKey, matchRouteKey].filter(Boolean))]
        : (action === "startMatch" || action === "stopMatch") && matchRouteKey
          ? [matchRouteKey]
          : [];
      const bootstrapPreemptions = bootstrapRouteKeys.map((routeKey) => preemptHostAgentSessionStart(routeKey, {
        closeActiveTransport: action === "shutdown",
      }));
      const matchBootstrapPreemption = bootstrapPreemptions.find((entry) => entry.host_session_key === matchRouteKey) || null;
      const stoppedHostProcess = cancellation.accepted
        || bootstrapPreemptions.some((entry) => entry.transport_close_requested);
      if (action === "stopResponse") {
        actionPayload = {
          ...(payload || {}),
          __daemon_preemptive_host_cancellation: {
            ...cancellation,
            response_task_revision: Number.isInteger(requestedRevision) ? requestedRevision : null,
          },
        };
      }
      this.store.appendEvent("daemon_control_preemption_signalled", {
        action,
        response_task_id: requestedTaskId,
        response_task_revision: Number.isInteger(requestedRevision) ? requestedRevision : null,
        identity_matched: stopIdentityMatches,
        stopped_host_process: stoppedHostProcess,
        match_bootstrap_preemption: matchBootstrapPreemption,
        bootstrap_preemptions: bootstrapPreemptions,
      });
    }
    const run = async () => this.handleActionLocked(action, actionPayload, window);
    if (daemonFastControlActions.has(action)) return run();
    const current = this.actionChain.catch(() => {}).then(run);
    this.actionChain = current.catch(() => {});
    return current;
  }

  async handleActionLocked(action, payload, window) {
    this.start();
    const readOnlyAction = daemonReadOnlyActions.has(action);
    await this.hydrateServiceState({
      allowBootstrap: action !== "bootstrap",
      audit: !readOnlyAction,
      persistRepairs: !readOnlyAction,
    });
    const mappedQueue = actionQueueMapping[action];
    const queueScope = queueScopeForAction(action, this.store.getJson("ui_runtime_state", null));
    const actionQueueItem = daemonQueuedActions.has(action)
      ? this.store.enqueue(mappedQueue?.queueName || "runtime_action_task", {
          action,
          payload: persistedActionPayload(action, payload),
        }, "pending", queueScope)
      : null;
    let claimedActionQueueItem = null;
    if (actionQueueItem) {
      claimedActionQueueItem = this.store.claimQueueItemById(actionQueueItem.id, {
        workerId: `daemon:${process.pid}`,
        leaseMs: 120000,
      });
      if (!claimedActionQueueItem) throw new Error(`daemon failed to claim action queue item ${actionQueueItem.id}`);
    }
    const logActionEvent = !readOnlyAction && action !== "observeRuntimeTick" && action !== "deliverReadyResponse";
    const actionId = logActionEvent
      ? this.store.appendEvent("ui_action_received", {
          action,
          payload: persistedActionPayload(action, payload),
          queue_item_id: actionQueueItem?.id || null,
        }).id
      : null;
    try {
      let result = await dispatchRuntimeServiceAction(action, payload, window);
      if (action === "bootstrap" && result?.state) {
        const sqliteState = this.store.getJson("ui_runtime_state", null);
        if (sqliteState?.schema && !result.new_app_session) {
          const mergedState = mergeCanonicalSlices(sqliteState, this.store);
          result = {
            ...result,
            state: preserveSqliteCanonicalState(result.state, mergedState),
          };
          setRuntimeServiceState(result.state);
        }
        this.serviceBootstrappedAt = Date.now();
      }
      const connectionChanged = action === "getState" && result?.state?.device_connection
        && JSON.stringify(result.state.device_connection) !== JSON.stringify(this.store.getJson("ui_runtime_state", null)?.device_connection);
      const persistedResult = readOnlyAction && !connectionChanged ? result : (this.persistResult(action, result) || result);
      if (actionQueueItem) {
        this.store.completeQueueItem(actionQueueItem.id, {
          result: summarizeResult(persistedResult),
        }, {
          workerId: claimedActionQueueItem.locked_by,
          leaseToken: claimedActionQueueItem.lease_token,
          leaseGeneration: claimedActionQueueItem.lease_generation,
        });
      }
      if (logActionEvent) {
        this.store.appendEvent("ui_action_completed", {
          action_id: actionId,
          action,
          result: summarizeResult(persistedResult),
          queue_item_id: actionQueueItem?.id || null,
        });
      }
      if (action === "stopMatch") {
        this.maintainStorage("stop_match", "TRUNCATE");
      } else if (action === "startMatch") {
        this.maintainStorage("start_match", "PASSIVE");
      }
      return rendererRuntimeResult(persistedResult);
    } catch (error) {
      const persistedError = error?.message || String(error);
      if (actionQueueItem) {
        this.store.failQueueItem(actionQueueItem.id, {
          error: persistedError,
        }, {
          retryDelayMs: 1000,
          workerId: claimedActionQueueItem?.locked_by || null,
          leaseToken: claimedActionQueueItem?.lease_token || null,
          leaseGeneration: claimedActionQueueItem?.lease_generation ?? null,
        });
      }
      this.store.appendEvent("ui_action_failed", {
        action_id: actionId,
        action,
        error: persistedError,
        queue_item_id: actionQueueItem?.id || null,
      });
      throw error;
    }
  }

  persistResult(action, result, options = {}) {
    if (!result || typeof result !== "object") return result;
    let state = result.state || {};
    if (result.state) {
      state = {
        ...state,
        response_task: compactPersistedResponseTask(normalizeResponseTaskScope(state.response_task, state)),
      };
      result = { ...result, state };
      const canonicalResponseTaskRaw = this.store.getJson("response_task", null);
      const canonicalResponseTask = canonicalResponseTaskRaw
        ? normalizeResponseTaskScope(canonicalResponseTaskRaw, state)
        : null;
      const canonicalScopeMigrationNeeded = Boolean(
        canonicalResponseTaskRaw
        && JSON.stringify(canonicalResponseTaskRaw) !== JSON.stringify(canonicalResponseTask),
      );
      const incomingResponseTask = state.response_task || null;
      const userSupersedesAutomatic = userTaskSupersedesAutomaticTask(
        incomingResponseTask,
        canonicalResponseTask,
        state,
      );
      const newerUserSupersedesOlderUser = newerUserTaskSupersedesUndeliveredUserTask(
        incomingResponseTask,
        canonicalResponseTask,
        state,
      );
      const canonicalOutOfScope = canonicalResponseTask && !responseTaskCompatibleWithRuntimeState(canonicalResponseTask, state);
      const incomingOutOfScope = incomingResponseTask && !responseTaskCompatibleWithRuntimeState(incomingResponseTask, state);
      const sameRevisionSameOwnerAndStatus = Boolean(
        canonicalResponseTask
        && incomingResponseTask
        && Number(canonicalResponseTask.revision || 0) === Number(incomingResponseTask.revision || 0)
        && (canonicalResponseTask.response_task_id || null) === (incomingResponseTask.response_task_id || null)
        && (canonicalResponseTask.status || null) === (incomingResponseTask.status || null),
      );
      const matchBoundaryStarted = ["match_session_boundary_started", "app_session_boundary_started"].includes(options.eventType);
      const shouldKeepCanonical = !matchBoundaryStarted
        && !canonicalOutOfScope
        && (
          sameRevisionSameOwnerAndStatus
          ||
          (incomingOutOfScope && responseTaskHasUndeliveredValue(canonicalResponseTask))
          || shouldPreserveCanonicalResponseTask(state.response_task, canonicalResponseTask, state)
        );
      let daemonGeneratedResponseTaskTransition = canonicalScopeMigrationNeeded;
      if (canonicalOutOfScope && !matchBoundaryStarted) {
        const cleared = clearedResponseTask(canonicalResponseTask, "canonical_task_outside_current_match");
        state = { ...state, response_task: cleared };
        result = { ...result, state };
        daemonGeneratedResponseTaskTransition = true;
        this.store.appendEvent("daemon_cleared_out_of_scope_canonical_response_task", {
          action,
          canonical_status: canonicalResponseTask?.status || null,
          canonical_response_task_id: canonicalResponseTask?.response_task_id || null,
          canonical_mode: canonicalResponseTask?.mode || null,
          canonical_match_session_id: responseTaskMatchSessionId(canonicalResponseTask),
          incoming_status: incomingResponseTask?.status || null,
          incoming_response_task_id: incomingResponseTask?.response_task_id || null,
          incoming_mode: incomingResponseTask?.mode || null,
          incoming_match_session_id: responseTaskMatchSessionId(incomingResponseTask),
          current_match_session_id: state.match_session?.match_session_id || null,
          current_match_session_status: state.match_session?.status || null,
        });
      } else if (matchBoundaryStarted) {
        this.store.appendEvent("daemon_accepted_new_match_response_task_boundary", {
          action,
          previous_response_task_id: canonicalResponseTask?.response_task_id || null,
          previous_match_session_id: responseTaskMatchSessionId(canonicalResponseTask),
          current_match_session_id: state.match_session?.match_session_id || null,
          incoming_status: incomingResponseTask?.status || null,
        });
      } else if (shouldKeepCanonical) {
        const incomingStatus = state.response_task?.status || null;
        const incomingResponseTaskId = state.response_task?.response_task_id || null;
        state = {
          ...state,
          response_task_revision: Number(canonicalResponseTask.revision || 0),
          response_task: canonicalResponseTask,
        };
        result = { ...result, state };
        this.store.appendEvent("daemon_preserved_canonical_response_task_on_persist", {
          action,
          canonical_status: canonicalResponseTask.status || null,
          canonical_response_task_id: canonicalResponseTask.response_task_id || null,
          incoming_status: incomingStatus,
          incoming_response_task_id: incomingResponseTaskId,
        });
      } else if (userSupersedesAutomatic) {
        this.store.appendEvent("daemon_dropped_automatic_response_for_user_priority", {
          action,
          canonical_status: canonicalResponseTask?.status || null,
          canonical_response_task_id: canonicalResponseTask?.response_task_id || null,
          canonical_revision: canonicalResponseTask?.revision ?? null,
          canonical_origin: canonicalResponseTask?.origin || null,
          incoming_status: incomingResponseTask?.status || null,
          incoming_response_task_id: incomingResponseTask?.response_task_id || null,
          incoming_revision: incomingResponseTask?.revision ?? null,
          incoming_origin: incomingResponseTask?.origin || null,
        });
      } else if (newerUserSupersedesOlderUser) {
        this.store.appendEvent("daemon_superseded_older_user_response_for_new_interaction", {
          action,
          canonical_status: canonicalResponseTask?.status || null,
          canonical_response_task_id: canonicalResponseTask?.response_task_id || null,
          canonical_revision: canonicalResponseTask?.revision ?? null,
          canonical_origin: canonicalResponseTask?.origin || null,
          incoming_status: incomingResponseTask?.status || null,
          incoming_response_task_id: incomingResponseTask?.response_task_id || null,
          incoming_revision: incomingResponseTask?.revision ?? null,
          incoming_origin: incomingResponseTask?.origin || null,
        });
      } else if (incomingOutOfScope) {
        const cleared = clearedResponseTask(incomingResponseTask, "state_task_outside_current_match");
        state = { ...state, response_task: cleared };
        result = { ...result, state };
        daemonGeneratedResponseTaskTransition = true;
        this.store.appendEvent("daemon_cleared_out_of_scope_incoming_response_task", {
          action,
          canonical_status: canonicalResponseTask?.status || null,
          canonical_response_task_id: canonicalResponseTask?.response_task_id || null,
          canonical_mode: canonicalResponseTask?.mode || null,
          canonical_match_session_id: responseTaskMatchSessionId(canonicalResponseTask),
          incoming_status: incomingResponseTask?.status || null,
          incoming_response_task_id: incomingResponseTask?.response_task_id || null,
          incoming_mode: incomingResponseTask?.mode || null,
          incoming_match_session_id: responseTaskMatchSessionId(incomingResponseTask),
          current_match_session_id: state.match_session?.match_session_id || null,
          current_match_session_status: state.match_session?.status || null,
        });
      }
      if (daemonGeneratedResponseTaskTransition) {
        const canonicalRevision = Math.max(0, Number(canonicalResponseTask?.revision || 0) || 0);
        state = {
          ...state,
          response_task_revision: canonicalRevision + 1,
          response_task: {
            ...(state.response_task || { status: "idle" }),
            revision: canonicalRevision + 1,
          },
        };
        result = { ...result, state };
      }
      const responseTaskChanged = JSON.stringify(canonicalResponseTask || null) !== JSON.stringify(state.response_task || null);
      const persistedState = sanitizeUserMessagePersistence(state);
      let transition;
      try {
        transition = this.store.commitRuntimeTransition({
          state: persistedState,
          responseTask: persistedState.response_task || { status: "idle" },
          eventType: options.eventType || (responseTaskChanged ? "response_task_changed" : "runtime_state_changed"),
          eventPayload: {
            source: action,
            canonical_writer: "jcc_runtime_daemon",
            ...(options.eventPayload && typeof options.eventPayload === "object" ? options.eventPayload : {}),
          },
        });
      } catch (error) {
        const canonicalAfterError = this.store.getJson("response_task", null);
        const responseTaskDiffKeys = [...new Set([
          ...Object.keys(canonicalAfterError || {}),
          ...Object.keys(persistedState?.response_task || {}),
        ])].filter((key) => (
          Object.hasOwn(canonicalAfterError || {}, key) !== Object.hasOwn(persistedState?.response_task || {}, key)
          || JSON.stringify(canonicalAfterError?.[key]) !== JSON.stringify(persistedState?.response_task?.[key])
        ));
        error.message = `${error.message} (action=${action}, incoming_task=${state.response_task?.response_task_id || "none"}, incoming_status=${state.response_task?.status || "none"}, incoming_revision=${state.response_task?.revision ?? "none"}, canonical_task=${canonicalAfterError?.response_task_id || "none"}, canonical_status=${canonicalAfterError?.status || "none"}, canonical_revision=${canonicalAfterError?.revision ?? "none"}, response_task_diff_keys=${responseTaskDiffKeys.join(",") || "none"})`;
        throw error;
      }
      const committedState = transition.state;
      state = {
        ...state,
        response_task_revision: committedState.response_task_revision,
        response_task: committedState.response_task,
      };
      result = { ...result, state };
      if (options.syncServiceState !== false) setRuntimeServiceState(state);
      syncDaemonLegacyUiStateMirror(this.store, committedState, action);
      this.emitCommittedRuntimeEvent(transition.event);
    }
    const boundaryAction = options.eventType === "app_session_boundary_started" ? "bootstrap"
      : options.eventType === "match_session_boundary_started" ? "startMatch" : action;
    this.applyMatchSessionBoundary(boundaryAction, {
      ...result,
      previous_match_session_id: result.previous_match_session_id
        || options.eventPayload?.previous_match_session_id
        || null,
      retired_match_summary: result.retired_match_summary
        || options.eventPayload?.retired_match_summary
        || null,
    }, state);
    if (state.device_connection) this.store.setJson("device_connection", state.device_connection);
    if (state.match_session) this.store.setJson("match_session_current", state.match_session);
    if (state.daily_session) this.store.setJson("daily_session_current", state.daily_session);
    if (state.host_cli) this.store.setJson("host_cli", state.host_cli);
    if (result.discovery) this.store.setJson("device_connection_discovery_latest", result.discovery);
    if (result.result?.rank_signal || result.result?.manifest || action === "updateRankings") {
      this.store.setJson("live_rankings_update_latest", result.result || { status: result.status || null });
    }
    if (result.user_preferences) this.store.setJson("user_preferences", result.user_preferences);
    if (result.runtime_settings) this.store.setJson("runtime_settings", result.runtime_settings);
    if (result.user_strategy_memory) this.store.setJson("user_strategy_memory", result.user_strategy_memory);
    if (result.variables) this.store.setJson("manual_match_variables_latest", result.variables);
    if (result.context_pack) this.store.setJson(`context_pack:${result.context_pack.scope || action}`, result.context_pack);
    if (result.host_request) {
      const hostRequestStatus = result.response
        ? "completed"
        : result.status === "awaiting_host_cli_agent_response"
          ? "pending"
          : result.status === "failed"
            ? "failed"
            : "observed";
      const hostRequestRef = canonicalHostRequestRef(result.host_request, state.response_task?.response_task_id || null);
      this.store.setJson("host_request_latest", hostRequestRef);
      this.store.enqueue("host_request",
        hostRequestRef,
        hostRequestStatus,
        queueScopeForMatchSession(result.host_request.match_session_id || state.match_session?.match_session_id),
      );
      this.store.appendEvent("host_request_recorded", {
        action,
        host_request: hostRequestRef,
        queue_status: hostRequestStatus,
      });
    }
    const hostRequestTerminalStatus = terminalHostRequestQueueStatus(state.response_task);
    const settledHostRequestId = hostRequestIdFromResponseTask(state.response_task);
    if (hostRequestTerminalStatus && settledHostRequestId) {
      const settledIds = this.store.settleHostRequest(settledHostRequestId, hostRequestTerminalStatus, {
        response_task_id: state.response_task?.response_task_id || state.response_task?.cancelled_response_task_id || null,
        response_task_revision: state.response_task?.revision ?? null,
        terminal_status: hostRequestTerminalStatus,
        settled_at: new Date().toISOString(),
      });
      if (settledIds.length) {
        this.store.appendEvent("host_request_queue_settled", {
          request_id: settledHostRequestId,
          status: hostRequestTerminalStatus,
          queue_item_ids: settledIds,
        });
      }
    }
    if (result.response) {
      this.store.setJson("host_response_latest", compactResponse(result.response));
      this.store.enqueue("host_response",
        compactResponse(result.response),
        "completed",
        queueScopeForMatchSession(result.response.match_session_id || state.match_session?.match_session_id),
      );
      this.store.appendEvent("host_response_recorded", {
        action,
        response: compactResponse(result.response),
      });
    }
    const queued = latestQueueEntry(result);
    if (queued) {
      this.store.enqueue("visual_request", {
        action,
        match_session_id: state.match_session?.match_session_id || queued.match_session_id || queued.request?.match_session_id || null,
        request_id: queued.request_id || queued.id || null,
        mode: queued.mode || null,
        target: queued.target || null,
        status: queued.status || null,
      }, queued.status || "pending", queueScopeForMatchSession(
        state.match_session?.match_session_id || queued.match_session_id || queued.request?.match_session_id,
      ));
    }
    if (result.result?.lifecycle?.active_tasks || result.pipeline?.lifecycle?.active_tasks) {
      const lifecycle = result.result?.lifecycle || result.pipeline?.lifecycle;
      const lifecycleSummary = compactAdviceTaskLifecycle(lifecycle);
      this.store.setJson("advice_task_lifecycle_latest", lifecycleSummary);
      this.store.appendEvent("advice_task_lifecycle_observed", lifecycleSummary);
    }
    if (!sessionActions.has(action)) return result;
    if (state.daily_session) {
      this.store.upsertSession("daily", "daily_session", state.daily_session.status || "unknown", state.daily_session);
    }
    const activeMatchSessionId = state.match_session?.status === "active"
      ? state.match_session.match_session_id || null
      : null;
    this.store.closeOtherActiveMatchSessions(activeMatchSessionId, "abandoned");
    if (activeMatchSessionId) {
      this.store.upsertSession(
        activeMatchSessionId,
        "match_session",
        state.match_session.status || "unknown",
        state.match_session
      );
    }
    return result;
  }

  applyMatchSessionBoundary(action, result, state) {
    const isStart = action === "startMatch";
    const isStop = action === "stopMatch" || action === "shutdown"
      || (action === "bootstrap" && result.new_app_session === true);
    if (!isStart && !isStop) return null;
    const previousMatchSessionId = isStart
      ? result.previous_match_session_id || null
      : result.stopped_match_session_id
        || (action === "stopMatch" ? state.match_session?.previous_match_session_id || null : null);
    const currentMatchSessionId = isStart ? state.match_session?.match_session_id || null : null;
    const previousPersistedSession = previousMatchSessionId
      ? this.store.db.prepare("SELECT status FROM runtime_sessions WHERE session_id = ?").get(previousMatchSessionId)
      : null;
    const shouldClosePreviousSession = Boolean(
      previousMatchSessionId
      && (!isStart || !previousPersistedSession || previousPersistedSession.status === "active"),
    );
    const queueItemIds = previousMatchSessionId
      ? this.store.settleMatchQueueItems(previousMatchSessionId, {
          reason: isStart ? "superseded_by_new_match" : "match_session_stopped",
        })
      : [];
    if (shouldClosePreviousSession) {
      this.store.closeSession(
        previousMatchSessionId,
        isStart ? "superseded" : "stopped",
        {
          closed_reason: isStart ? "superseded_by_new_match" : "user_stopped_match",
          ...(result.retired_match_summary ? { postgame_summary: result.retired_match_summary } : {}),
        },
      );
    }
    this.store.closeOtherActiveMatchSessions(currentMatchSessionId, "abandoned");
    const prunedClosedMatchSessions = this.store.pruneClosedMatchSessions(20);
    for (const key of [
      "manual_match_variables_latest",
      "host_request_latest",
      "host_response_latest",
      "advice_task_lifecycle_latest",
      "context_pack:match",
      "context_pack:mode",
    ]) this.store.deleteJson(key);
    this.store.appendEvent("match_session_scope_retired", {
      action,
      previous_match_session_id: previousMatchSessionId,
      current_match_session_id: currentMatchSessionId,
      previous_persisted_status: previousPersistedSession?.status || null,
      previous_session_closed: shouldClosePreviousSession,
      retired_queue_item_ids: queueItemIds,
      pruned_closed_match_sessions: prunedClosedMatchSessions,
      cleared_runtime_kv: [
        "manual_match_variables_latest",
        "host_request_latest",
        "host_response_latest",
        "advice_task_lifecycle_latest",
        "context_pack:match",
        "context_pack:mode",
      ],
    });
    return { previousMatchSessionId, currentMatchSessionId, queueItemIds };
  }
}

let singletonDaemon = null;

export function getRuntimeDaemon(options) {
  if (!singletonDaemon) singletonDaemon = new JccRuntimeDaemon(options);
  return singletonDaemon.start();
}
