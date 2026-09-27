import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  JccRuntimeDaemon,
  preserveSqliteCanonicalState,
  runtimeDaemonContract,
} from "../ui/electron/runtime-daemon.js";
import { closeAllHostAgentSessions, runHostAgentRequest } from "../ui/electron/host-adapters.js";
import {
  handleRuntimeAction,
  rememberInMemoryPipelineResult,
  setRuntimeServiceState,
} from "../ui/electron/runtime-service.js";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rmWithRetry(target) {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await wait(150);
    }
  }
  console.warn(`cleanup warning: ${lastError?.message || lastError}`);
}

async function text(file) {
  return readFile(file, "utf8");
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonWithRetry(file, { timeoutMs = 3000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      lastError = error;
      await wait(intervalMs);
    }
  }
  throw lastError || new Error(`Timed out waiting for ${file}`);
}

function assertIncludes(source, needle, label) {
  assert(source.includes(needle), `${label} must include ${needle}`);
}

function assertNotIncludes(source, needle, label) {
  assert(!source.includes(needle), `${label} must not include ${needle}`);
}

async function verifyStaticContract() {
  const daemon = await text("ui/electron/runtime-daemon.js");
  const main = await text("ui/electron/main.js");
  const client = await text("ui/electron/runtime-daemon-client.js");
  const server = await text("ui/electron/runtime-daemon-server.js");
  assert(runtimeDaemonContract.schema === "jcc-runtime-daemon-v1", "daemon contract schema mismatch");
  assert(runtimeDaemonContract.shape === "independent_os_daemon_sqlite_backed", "daemon must be independent OS daemon shaped");
  assert(runtimeDaemonContract.state_owner === "jcc-runtime-daemon", "daemon must own runtime state");
  assert(runtimeDaemonContract.sqlite_store === "jcc-runtime-state-store-v5", "daemon must depend on sqlite store v5");
  assert(runtimeDaemonContract.control_transport === "http", "daemon control transport must be http");
  assert(runtimeDaemonContract.event_transport?.includes("websocket"), "daemon event transport must include websocket");
  assert(
    !runtimeDaemonContract.preemptive_host_actions?.includes("setMode"),
    "presentation mode changes must not preempt an owned Host response",
  );

  for (const needle of [
    "createRuntimeSqliteStore",
    "runtimeDaemonContract",
    "JccRuntimeDaemon",
    "handleRuntimeServiceAction",
    "hydrateServiceState",
    "getRuntimeServiceState",
    "setRuntimeServiceState",
    "service_state_hydrated",
    "ui_action_received",
    "ui_action_completed",
    "ui_action_failed",
    "upsertSession",
    "setJson(\"ui_runtime_state\"",
    "setJson(\"device_connection\"",
    "setJson(\"host_request_latest\"",
    "setJson(\"host_response_latest\"",
    "enqueue(\"host_request\"",
    "enqueue(\"host_response\"",
    "enqueue(\"visual_request\"",
    "strategy_memory_task",
    "cruise_advice_task",
    "host_request",
    "host_response",
    "live_rankings_update_latest",
    "advice_task_lifecycle_latest",
    "setJson(\"user_preferences\"",
    "context_pack:",
    "daemonQueuedActions",
    "commitRuntimeTransition",
    "onRuntimeEvent",
    "claimQueueItemById",
    "completeQueueItem(actionQueueItem.id",
    "retired_match_summary",
    "postgame_summary",
    "pruneClosedMatchSessions(20)",
  ]) {
    assertIncludes(daemon, needle, "runtime daemon");
  }
  assertNotIncludes(daemon, "enqueue(\"advice_task_lifecycle\"", "runtime daemon");
  assertIncludes(daemon, "compactAdviceTaskLifecycle", "runtime daemon");
  assertIncludes(daemon, "maintainStorage(\"stop_match\", \"TRUNCATE\")", "runtime daemon");
  assertIncludes(daemon, "maintainStorage(\"start_match\", \"PASSIVE\")", "runtime daemon");

  for (const needle of [
    "RuntimeDaemonClient",
    "const repoRoot = path.resolve(__dirname, \"../..\")",
    "function getDaemonClient",
    "getDaemonClient().action",
    "before-quit",
    "runtimeDaemonClient?.stop?.()",
  ]) {
    assertIncludes(main, needle, "electron main");
  }

  for (const needle of ["/health", "/action", "/state", "/queue", "/queue/update", "/shutdown"]) assertIncludes(client, needle, "runtime daemon client");
  for (const needle of ["http.createServer", "/health", "/action", "/events", "/ws", "/queue", "/queue/update", "/logs", "/shutdown"]) assertIncludes(server, needle, "runtime daemon server");
  assertNotIncludes(main, "getRuntimeDaemon", "electron main");
  assertNotIncludes(main, "import { handleRuntimeAction } from \"./runtime-service.js\"", "electron main");
  assertNotIncludes(main, "return await handleRuntimeAction(", "electron main");
  assertNotIncludes(daemon, "loadLegacyStateMirror", "runtime daemon canonical hydration");
}

async function verifyLegacyMirrorCannotBecomeCanonical() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-no-mirror-promotion-"));
  let daemon = null;
  try {
    const paths = createRuntimePaths(process.cwd(), { dataRoot: tempRoot });
    await writeJson(paths.uiStateFile, {
      schema: "jcc-ui-runtime-state-v1",
      stale_mirror_marker: "must-not-be-canonical",
      match_session: { status: "active", match_session_id: "stale-mirror-match" },
      response_task: { status: "running", response_task_id: "stale-mirror-task" },
      host_sessions: { match: { provider_session_id: "stale-provider-session" } },
    });
    setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      match_session: { status: "idle", match_session_id: null },
      response_task: { status: "idle", response_task_id: null },
    });
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
    const hydrated = await daemon.hydrateServiceState({ allowBootstrap: false });
    const canonical = daemon.store.getJson("ui_runtime_state");
    assert(hydrated.stale_mirror_marker !== "must-not-be-canonical", "legacy/current JSON mirror must not hydrate runtime state");
    assert(canonical.stale_mirror_marker !== "must-not-be-canonical", "JSON mirror must not be promoted into SQLite");
    assert(canonical.match_session?.match_session_id !== "stale-mirror-match", "stale mirror match must not resurrect");
    assert(canonical.response_task?.response_task_id !== "stale-mirror-task", "stale mirror response task must not resurrect");
    assert(
      daemon.store.listRecentEvents(200).some((event) => event.event_type === "daemon_default_runtime_state_seeded"
        && event.payload?.source === "daemon_start"
        && event.payload?.canonical_writer === "jcc_runtime_daemon"
        && event.payload?.legacy_json_policy === "compatibility_mirror_or_debug_export_only"),
      "empty SQLite must be atomically seeded by the daemon from service defaults and record mirror policy",
    );
    daemon.stop();
    daemon = null;
  } finally {
    daemon?.stop();
    await rmWithRetry(tempRoot);
  }
}

async function verifySqliteLifecycle() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-"));
  let daemon = null;
  try {
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
    assert(daemon.started === true, "daemon should start");
    const contract = daemon.store.getJson("runtime_daemon_contract");
    assert(contract?.schema === "jcc-runtime-daemon-v1", "daemon should persist contract");
    const events = daemon.store.listRecentEvents(5);
    assert(events.some((event) => event.event_type === "daemon_started"), "daemon should log daemon_started");
    const committedRuntimeEvents = [];
    const unsubscribe = daemon.onRuntimeEvent((event) => committedRuntimeEvents.push(event));
    daemon.persistResult("startMatch", {
      state: {
        device_connection: { status: "connected", adb_target: "127.0.0.1:7555" },
        host_cli: { provider: "codex", available: true },
        daily_session: { status: "inactive" },
        match_session: { match_session_id: "match-test", status: "active" },
        response_task_revision: 3,
        response_task: { status: "completed", response_task_id: "task-test", revision: 3 },
      },
      user_preferences: { rank_tier: "master" },
      context_pack: { scope: "match", ok: true },
      host_request: {
        request_id: "request-test",
        mode: "cruise",
        user_message: "test",
        runtime_context: {
          host_session_kind: "match",
          active_mode: "cruise",
          context_policy: { include_season_catalog: true },
        },
      },
      response: {
        schema: "jcc-host-cli-coach-response-v1",
        request_id: "request-test",
        final_text: "test response",
        confidence: "medium",
      },
      result: {
        visual_requests: {
          queue: [{ request_id: "visual-test", mode: "augment_choice", target: "augments.choices", status: "pending" }],
        },
        lifecycle: {
          active_tasks: [{ task_id: "advice-test" }],
        },
      },
    });
    assert(daemon.store.getJson("user_preferences").rank_tier === "master", "daemon should persist user preferences");
    assert(daemon.store.getJson("context_pack:match").ok === true, "daemon should persist context pack");
    assert(daemon.store.getJson("device_connection").adb_target === "127.0.0.1:7555", "daemon should persist device connection");
    assert(daemon.store.getJson("host_request_latest").request_id === "request-test", "daemon should persist compact host request");
    assert(daemon.store.getJson("host_response_latest").final_text === "test response", "daemon should persist compact host response");
    assert(daemon.store.getJson("advice_task_lifecycle_latest").active_tasks[0].task_id === "advice-test", "daemon should persist advice lifecycle");
    const persistedRevision = daemon.store.getJson("response_task_revision");
    assert(Number.isInteger(persistedRevision) && persistedRevision > 0, "daemon should allocate a positive canonical response task revision");
    assert(daemon.store.getJson("response_task")?.revision === persistedRevision, "canonical response task must carry the daemon-allocated revision");
    assert(
      committedRuntimeEvents.some((event) => event.event_type === "response_task_changed" && event.payload?.response_task_revision === persistedRevision),
      "daemon must publish response_task_changed only after canonical commit",
    );
    assert(daemon.store.listQueue({ queueName: "host_request" }).some((item) => item.status === "completed"), "daemon should queue host requests");
    assert(daemon.store.listQueue({ queueName: "host_response" }).some((item) => item.status === "completed"), "daemon should queue host responses");
    assert(daemon.store.listQueue({ queueName: "visual_request" }).some((item) => item.status === "pending"), "daemon should queue visual requests");
    assert(daemon.store.listQueue({ queueName: "advice_task_lifecycle" }).length === 0, "daemon must not queue repeated advice lifecycle snapshots");
    assert(daemon.store.listRecentEvents(20).some((event) => event.event_type === "advice_task_lifecycle_observed"), "daemon should retain compact lifecycle audit events");
    assert(daemon.store.listRecentEvents(10).some((event) => event.event_type === "host_request_recorded"), "daemon should log host request events");
    unsubscribe();
    daemon.stop();
    assert(daemon.started === false, "daemon should stop");
    daemon = null;
  } finally {
    daemon?.stop();
    await rmWithRetry(tempRoot);
  }
}

async function verifyHandleActionHydratesFromSqlite() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-action-"));
  let daemon;
  try {
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
    const sqliteFixtureState = {
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: "127.0.0.1:7555", checked_at: new Date().toISOString() },
      daily_session: { status: "active", mode: "daily_chat" },
      match_session: { status: "idle", match_session_id: null },
      response_task: { status: "idle", response_task_id: null },
      active_mode: "daily_chat",
      host_cli: { provider: "codex", preferred: "codex", display_name: "Codex CLI", available: false },
      host_sessions: {
        daily: { status: "runtime_owned", route_id: "daily", context_keys: [] },
        match: { status: "idle", route_id: "match", match_session_id: null, context_keys: [] },
      },
      user_preferences: {
        schema: "jcc-runtime-user-settings-v1",
        rank_tier: "master",
        operation_speed: "normal_can_pivot_next_round",
        default_goal: "balanced",
      },
    };
    const fixtureRevision = Number(daemon.store.getJson("response_task")?.revision || 0) + 1;
    sqliteFixtureState.response_task = { ...sqliteFixtureState.response_task, revision: fixtureRevision };
    sqliteFixtureState.response_task_revision = fixtureRevision;
    daemon.store.commitRuntimeTransition({
      state: sqliteFixtureState,
      responseTask: sqliteFixtureState.response_task,
      eventType: "verification_fixture_state_committed",
      eventPayload: { source: "verify_jcc_runtime_daemon" },
    });
    const result = await daemon.handleAction("getState", {}, null);
    assert(result.state.device_connection.adb_target === "127.0.0.1:7555", "handleAction should hydrate service from sqlite before dispatch");
    assert(daemon.store.getJson("ui_runtime_state").device_connection.adb_target === "127.0.0.1:7555", "handleAction should keep sqlite as canonical state");
    const beforeState = JSON.stringify(daemon.store.getJson("ui_runtime_state"));
    await daemon.handleAction("getState", {}, null);
    assert(JSON.stringify(daemon.store.getJson("ui_runtime_state")) === beforeState, "getState with unchanged fresh ADB health must not rewrite canonical state");
    assert(!Object.hasOwn(result.state, "runtime_event_log"), "renderer state must omit the internal runtime event log");
    const events = daemon.store.listRecentEvents(20);
    assert(!events.some((event) => event.event_type === "service_state_hydrated" && event.payload?.source === "sqlite"), "read-only getState must not append hydration audit events");
    assert(!events.some((event) => event.event_type === "ui_action_completed" && event.payload?.action === "getState"), "read-only getState must not append UI action lifecycle events");
    const memoryResult = await daemon.handleAction("saveStrategyMemory", { text: "verify strategy memory queue" }, null);
    assert(memoryResult.ok === true, "saveStrategyMemory action should succeed");
    assert(
      daemon.store.listQueue({ queueName: "strategy_memory_task" }).some((item) => item.status === "completed" && item.attempts >= 1),
      "daemon should run strategy memory through queue lifecycle",
    );
    daemon.stop();
  } finally {
    daemon?.stop();
    await rmWithRetry(tempRoot);
  }
}

async function verifyHydrateRepairsStaleConnectedMatchAndVariables() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-hydrate-repair-"));
  let daemon = null;
  try {
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
    daemon.store.setJson("manual_match_variables_latest", {
      schema: "jcc-runtime-manual-match-variables-ui-event-v1",
      match_session_id: "current-match",
      source: "user_confirmed_runtime_ui",
      confidence: "high",
      confirmed_at: "2026-06-21T00:00:00.000Z",
      values: {
        encounter: "verify_encounter",
        god_options: ["verify_god_a", "verify_god_b"],
        stargazing: "verify_observer",
      },
    });
    daemon.store.setJson("ui_runtime_state", {
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: "127.0.0.1:7555" },
      daily_session: { status: "inactive", mode: null },
      match_session: { status: "active", match_session_id: "current-match" },
      match_connection: {
        status: "connected_to_live_match",
        connected_at: "2026-06-21T00:00:00.000Z",
        last_live_state_match_session_id: "old-match",
      },
      response_task: { status: "idle" },
      active_mode: "cruise",
      manual_match_variables: null,
      host_cli: { provider: "codex", available: false },
      host_sessions: {
        daily: { status: "idle", route_id: "daily", context_keys: [] },
        match: { status: "idle", route_id: "match", match_session_id: "current-match", context_keys: [] },
      },
      user_preferences: {},
    });

    const result = await daemon.handleAction("getState", {}, null);
    assert(result.state.manual_match_variables?.values?.encounter === "verify_encounter", "daemon hydrate should merge latest confirmed variables back into UI state");
    assert(result.state.match_connection?.status === "waiting_for_current_match_live_state", "daemon hydrate should downgrade stale connected state from old match live_state");
    assert(result.state.match_connection?.rejected_live_state_match_session_id === "old-match", "daemon hydrate should preserve rejected old match id for diagnostics");
    assert(daemon.store.getJson("ui_runtime_state").match_connection.status === "connected_to_live_match", "read-only getState must not persist projected hydration repairs");
    assert(daemon.store.getJson("manual_match_variables_latest")?.values?.encounter === "verify_encounter", "read-only projection must leave canonical slice storage unchanged");
    daemon.stop();
  } finally {
    daemon?.stop?.();
    await rmWithRetry(tempRoot);
  }
}

async function verifyHydrateClearsStaleResponseTaskFromSqlite() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-stale-task-"));
  let daemon = null;
  try {
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
    daemon.store.setJson("ui_runtime_state", {
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: "127.0.0.1:7555" },
      daily_session: { status: "inactive", mode: null },
      match_session: { status: "active", match_session_id: "verify-match" },
      match_connection: { status: "waiting_for_current_match_live_state" },
      response_task: {
        status: "awaiting_host_cli_agent_response",
        response_task_id: "stale-augment-task",
        mode: "augment_choice",
        started_at: "2026-07-03T16:46:04.167Z",
      },
      active_mode: "augment_choice",
      host_cli: { provider: "kimi", preferred: "kimi", available: true, command: "kimi" },
      host_sessions: {
        daily: { status: "idle", route_id: "daily", context_keys: [] },
        match: { status: "runtime_owned", route_id: "match", match_session_id: "verify-match", context_keys: [] },
      },
      user_preferences: {},
    });
    daemon.store.setJson("response_task", {
      status: "awaiting_host_cli_agent_response",
      response_task_id: "stale-augment-task",
      mode: "augment_choice",
    });

    daemon.stop();
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();

    const result = await daemon.handleAction("getState", {}, null);
    assert(result.state.response_task?.status === "idle", "daemon hydrate must clear stale pending response_task from sqlite canonical state");
    assert(result.state.response_task?.previous_response_task_id === "stale-augment-task", "daemon hydrate should preserve stale task id for diagnostics");
    assert(daemon.store.getJson("ui_runtime_state").response_task.status === "idle", "daemon should persist cleared response_task into ui_runtime_state");
    assert(daemon.store.getJson("response_task").status === "idle", "daemon should persist cleared standalone response_task kv");
    daemon.stop();
  } finally {
    daemon?.stop?.();
    await rmWithRetry(tempRoot);
  }
}

async function verifyRestartClearsFreshResponseTaskFromPreviousProcess() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-fresh-task-"));
  let daemon = null;
  try {
    const startedAt = new Date().toISOString();
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
    daemon.store.setJson("ui_runtime_state", {
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: "127.0.0.1:7555" },
      daily_session: { status: "inactive", mode: null },
      match_session: { status: "active", match_session_id: "verify-match" },
      match_connection: { status: "waiting_for_current_match_live_state" },
      response_task: {
        status: "awaiting_host_cli_agent_response",
        response_task_id: "fresh-augment-task",
        mode: "augment_choice",
        started_at: startedAt,
      },
      active_mode: "augment_choice",
      host_cli: { provider: "kimi", preferred: "kimi", available: true, command: "kimi" },
      host_sessions: {
        daily: { status: "idle", route_id: "daily", context_keys: [] },
        match: { status: "runtime_owned", route_id: "match", match_session_id: "verify-match", context_keys: [] },
      },
      user_preferences: {},
    });
    daemon.store.setJson("response_task", {
      status: "awaiting_host_cli_agent_response",
      response_task_id: "fresh-augment-task",
      mode: "augment_choice",
      started_at: startedAt,
    });

    daemon.stop();
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();

    const result = await daemon.handleAction("getState", {}, null);
    assert(result.state.response_task?.status === "idle", "daemon restart must clear a fresh pending response_task owned by the previous process");
    assert(result.state.response_task?.previous_response_task_id === "fresh-augment-task", "daemon restart should retain the orphaned task id only for diagnostics");
    assert(daemon.store.getJson("ui_runtime_state").response_task.status === "idle", "daemon should persist the cleared previous-process task into ui_runtime_state");
    assert(daemon.store.getJson("response_task").status === "idle", "daemon should persist the cleared standalone response_task kv");
    daemon.stop();
  } finally {
    daemon?.stop?.();
    await rmWithRetry(tempRoot);
  }
}

async function verifyReadOnlyPollingPreservesLiveLongResponseTask() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-live-long-task-"));
  let daemon = null;
  try {
    const startedAt = new Date(Date.now() - 200_000).toISOString();
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
    const liveState = {
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: "127.0.0.1:7555" },
      daily_session: { status: "inactive", mode: null },
      match_session: { status: "active", match_session_id: "verify-live-match" },
      match_connection: { status: "connected_to_live_match" },
      response_task: {
        status: "running",
        response_task_id: "live-lineup-task",
        match_session_id: "verify-live-match",
        mode: "lineup_card",
        started_at: startedAt,
        provider_awaiting_since: startedAt,
      },
      active_mode: "lineup_card",
      host_cli: { provider: "codex", preferred: "codex", available: true, command: "codex" },
      user_preferences: {},
    };
    daemon.store.setJson("ui_runtime_state", liveState);
    daemon.store.setJson("response_task", liveState.response_task);

    const before = JSON.stringify(daemon.store.getJson("ui_runtime_state"));
    const result = await daemon.handleAction("getState", {}, null);
    assert(result.state.response_task?.response_task_id === "live-lineup-task", "read-only polling must not clear a live long-running response owner");
    assert(result.state.response_task?.status === "running", "read-only polling must preserve live response status");
    assert(JSON.stringify(daemon.store.getJson("ui_runtime_state")) === before, "read-only polling must not rewrite a live long-running response task");
  } finally {
    daemon?.stop?.();
    await rmWithRetry(tempRoot);
  }
}

async function verifyHydrateClearsFailedResponseTaskOutsideCurrentMatch() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-old-failed-task-"));
  let daemon = null;
  try {
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
    const failedTask = {
      status: "failed",
      response_task_id: "old-failed-cruise-task",
      mode: "cruise",
      match_session_id: "old-match",
      error: "Host CLI returned empty response",
      failed_at: "2026-07-04T11:54:36.586Z",
    };
    daemon.store.setJson("ui_runtime_state", {
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: "127.0.0.1:7555" },
      daily_session: { status: "active", mode: "daily_chat" },
      match_session: {
        status: "idle",
        match_session_id: null,
        previous_match_session_id: "old-match",
      },
      match_connection: { status: "idle" },
      response_task: failedTask,
      active_mode: "cruise",
      host_cli: { provider: "kimi", preferred: "kimi", available: true, command: "kimi" },
      user_preferences: {},
    });
    daemon.store.setJson("response_task", failedTask);

    daemon.stop();
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();

    const result = await daemon.handleAction("getState", {}, null);
    assert(result.state.response_task?.status === "idle", "daemon hydrate must clear failed match response_task after the match is idle");
    assert(result.state.response_task?.previous_response_task_id === "old-failed-cruise-task", "cleared failed task should keep previous id for diagnostics");
    assert(!String(JSON.stringify(result.state.response_task)).includes("Host CLI returned empty response"), "old empty-response error must not keep surfacing after match scope ended");
    assert(daemon.store.getJson("response_task").status === "idle", "standalone canonical response_task must also be cleared");
    const mirror = await readJsonWithRetry(daemon.store.paths.uiStateFile);
    assert(mirror.response_task?.status === "idle", "legacy UI state mirror must be refreshed after daemon clears stale response_task");
    assert(!String(JSON.stringify(mirror.response_task)).includes("Host CLI returned empty response"), "legacy UI state mirror must not keep stale empty-response errors");
    assert(
      daemon.store.listRecentEvents(50).some((event) => event.event_type === "daemon_cleared_out_of_scope_canonical_response_task"),
      "daemon should record the out-of-scope canonical response_task cleanup",
    );
    daemon.stop();
  } finally {
    daemon?.stop?.();
    await rmWithRetry(tempRoot);
  }
}

async function verifyHydratePreservesFreshHostCliCapabilities() {
  const reconciledCodex = preserveSqliteCanonicalState(
    {
      schema: "jcc-ui-runtime-state-v1",
      host_cli: {
        provider: "codex",
        preferred: "codex",
        available: true,
        version: "codex-cli current",
        command: "current-codex",
        capabilities: { provider: "codex", image_transport: "codex-exec---image" },
      },
    },
    {
      schema: "jcc-ui-runtime-state-v1",
      host_cli: {
        provider: "codex",
        preferred: "codex",
        available: false,
        version: null,
        command: "stale-codex",
        capabilities: null,
      },
    },
  );
  assert(reconciledCodex.host_cli.available === true, "fresh bootstrap Host availability must override stale SQLite probe state");
  assert(reconciledCodex.host_cli.version === "codex-cli current", "fresh bootstrap Host version must override stale SQLite probe state");
  assert(reconciledCodex.host_cli.command === "current-codex", "fresh bootstrap Host command must override stale SQLite probe state");
  assert(reconciledCodex.host_cli.capabilities?.provider === "codex", "fresh bootstrap Host capabilities must survive daemon reconciliation");

  const reconciledHostSession = preserveSqliteCanonicalState(
    {
      schema: "jcc-ui-runtime-state-v1",
      daily_session: { status: "active", mode: "daily_chat", generation: 3 },
      host_sessions: {
        daily: {
          status: "recovering",
          route_key: "daily:2",
          provider_session_id: "provider-daily-2",
          runtime_instance_id: "runtime-current",
        },
      },
    },
    {
      schema: "jcc-ui-runtime-state-v1",
      daily_session: { status: "active", mode: "daily_chat", generation: 2 },
      host_sessions: {
        daily: {
          status: "ready",
          route_key: "daily:2",
          provider_session_id: "provider-daily-2",
          runtime_instance_id: "runtime-stale",
        },
      },
    },
  );
  assert(reconciledHostSession.daily_session.generation === 3, "bootstrap daily generation must stay aligned with the current Host route");
  assert(reconciledHostSession.host_sessions.daily.status === "recovering", "bootstrap Host recovery state must override stale SQLite readiness");
  assert(reconciledHostSession.host_sessions.daily.runtime_instance_id === "runtime-current", "bootstrap Host session ownership must remain bound to the current runtime instance");

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-host-cli-"));
  let daemon = null;
  const previousKimiEnv = {
    JCC_UI_DISABLE_CODEX_EXEC: process.env.JCC_UI_DISABLE_CODEX_EXEC,
    JCC_KIMI_RUNTIME_HOME: process.env.JCC_KIMI_RUNTIME_HOME,
    JCC_SOURCE_KIMI_HOME: process.env.JCC_SOURCE_KIMI_HOME,
    KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
    KIMI_HOME: process.env.KIMI_HOME,
  };
  try {
    const fakeKimiRoot = path.join(tempRoot, "KIMI CLI");
    const fakeKimiHome = path.join(fakeKimiRoot, ".kimi-code");
    const fakeKimiBin = path.join(tempRoot, "CLI Launchers");
    const fakeKimiCommand = path.join(fakeKimiBin, process.platform === "win32" ? "kimi.cmd" : "kimi");
    await mkdir(fakeKimiBin, { recursive: true });
    await mkdir(fakeKimiHome, { recursive: true });
    await writeFile(path.join(fakeKimiHome, "config.toml"), 'default_model = "kimi-code/kimi-for-coding"\n', "utf8");
    process.env.JCC_KIMI_RUNTIME_HOME = fakeKimiHome;
    process.env.JCC_SOURCE_KIMI_HOME = fakeKimiHome;
    process.env.KIMI_CODE_HOME = fakeKimiHome;
    process.env.KIMI_HOME = fakeKimiHome;
    process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
    const fakeKimiContent = process.platform === "win32"
      ? [
          "@echo off",
          "if \"%1\"==\"provider\" if \"%2\"==\"list\" if \"%3\"==\"--json\" (",
          "  echo {\"models\":{\"kimi-code/kimi-for-coding\":{\"displayName\":\"K2.7 Code\",\"capabilities\":[\"image_in\"]}}}",
          "  exit /b 0",
          ")",
          "echo 0.99.0-test",
          "",
        ].join("\r\n")
      : [
          "#!/usr/bin/env sh",
          "if [ \"$1\" = \"provider\" ] && [ \"$2\" = \"list\" ] && [ \"$3\" = \"--json\" ]; then",
          "  printf '%s\\n' '{\"models\":{\"kimi-code/kimi-for-coding\":{\"displayName\":\"K2.7 Code\",\"capabilities\":[\"image_in\"]}}}'",
          "  exit 0",
          "fi",
          "echo 0.99.0-test",
          "",
        ].join("\n");
    await writeFile(fakeKimiCommand, fakeKimiContent, "utf8");
    if (process.platform !== "win32") await chmod(fakeKimiCommand, 0o755);
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
    daemon.store.setJson("ui_runtime_state", {
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected" },
      daily_session: { status: "inactive", mode: null },
      match_session: { status: "idle", match_session_id: null },
      match_connection: { status: "idle" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      host_cli: {
        provider: "kimi",
        preferred: "kimi",
        available: true,
        command: fakeKimiCommand,
        selected_model: null,
      },
      host_sessions: {
        daily: { status: "idle", route_id: "daily", context_keys: [] },
        match: { status: "idle", route_id: "match", match_session_id: null, context_keys: [] },
      },
      user_preferences: {},
    });

    const result = await daemon.handleAction("getState", {}, null);
    assert(result.state.host_cli?.provider === "kimi", "daemon reconcile must preserve the user-selected Kimi provider");
    assert(
      !result.state.host_cli?.capabilities || result.state.host_cli.capabilities.provider === "kimi",
      "daemon reconcile must not attach Codex capabilities to a Kimi-selected host state",
    );
    assert(
      !daemon.store.listRecentEvents(20).some((event) => event.event_type === "service_state_bootstrap_reconciled"),
      "daemon hydrate should not run host CLI model discovery during ordinary getState",
    );
    const bootstrapped = await daemon.handleAction("bootstrap", {}, null);
    assert(
      bootstrapped.state.host_cli?.provider === "kimi"
        || /bootstrap_detected_.*while_sqlite_prefers_kimi/.test(bootstrapped.state.host_cli?.model_options_error || ""),
      "explicit bootstrap must preserve Kimi or expose a safe reconnect diagnostic when discovery detects another provider",
    );
    assert(
      bootstrapped.state.host_cli.default_model_label
        || /bootstrap_detected_.*while_sqlite_prefers_kimi/.test(bootstrapped.state.host_cli.model_options_error || ""),
      "explicit daemon bootstrap must either preserve fresh Kimi model options or expose a safe reconnect diagnostic",
    );
    daemon.stop();
  } finally {
    daemon?.stop?.();
    for (const [key, value] of Object.entries(previousKimiEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rmWithRetry(tempRoot);
  }
}

async function verifyElectronDaemonUserSymptomFlow() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-symptom-"));
  const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  const previousDataDir = process.env.JCC_RUNTIME_DATA_DIR;
  process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
  process.env.JCC_RUNTIME_DATA_DIR = tempRoot;
  try {
    const daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
    const baseState = {
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: { status: "active", match_session_id: "verify-match" },
      match_connection: { status: "waiting_for_live_state" },
      response_task: { status: "idle" },
      active_mode: "manual_match_variables",
      runtime_triggers: { visual_by_stage: {} },
      visual_request_status: null,
      host_cli: { provider: "codex", available: false },
      host_sessions: {
        daily: { status: "idle", route_id: "daily", context_keys: [] },
        match: { status: "idle", route_id: "match", match_session_id: "verify-match", context_keys: [] },
      },
      user_preferences: {},
      user_strategy_memory: { strategies: [] },
    };
    daemon.store.setJson("ui_runtime_state", baseState);

    const variables = await daemon.handleAction("saveManualVariables", {
      encounter: "verify_encounter",
      firstGod: "verify_god_a",
      secondGod: "verify_god_b",
      observer: "verify_observer",
      target: "verify_target",
    }, null);
    assert(variables.ok === true, "daemon saveManualVariables should succeed");
    assert(variables.state.active_mode === "cruise", "daemon variable save should return active match to cruise");
    const canonicalVariables = daemon.store.getJson("ui_runtime_state").manual_match_variables.values;
    const mirroredVariables = daemon.store.getJson("manual_match_variables_latest").values;
    assert(canonicalVariables.target_plan_text === "verify_target", "daemon should persist the S18 match target in canonical ui state");
    assert(mirroredVariables.target_plan_text === "verify_target", "daemon should persist the S18 match-target mirror");
    assert(Object.keys(canonicalVariables.season_variables || {}).length === 0, "S18 must not persist retired S17 manual variables in canonical ui state");
    assert(Object.keys(mirroredVariables.season_variables || {}).length === 0, "S18 must not persist retired S17 manual variables in the compatibility mirror");

    const liveStateFile = path.join(tempRoot, "runtime-evidence", "mumu-gi-live", "current-watch", "cruise-live-state.json");
    await writeJson(liveStateFile, {
      schema: "verify-live-state",
      match_session_id: "verify-match",
      phase: { stage_round: "2-1", status: "choice" },
      own_board: { units: [{ name: "verify_unit", cost: 2, star: 1 }] },
      shop: { units: [{ name: "verify_shop_unit", cost: 2 }] },
      items: { item_bench: ["verify_component"] },
    });

    const visionRequestFile = path.join(tempRoot, "runtime-evidence", "ui-runtime", "verify-vision-request.json");
    const preparedRunFile = path.join(tempRoot, "runtime-evidence", "ui-runtime", "verify-prepared-visual-run.json");
    await writeJson(visionRequestFile, {
      schema: "jcc-host-visual-request-v1",
      request_id: "verify-augment-reroll",
      mode: "augment_choice",
      match_session_id: "verify-match",
    });
    await writeJson(preparedRunFile, {
      ok: true,
      status: "awaiting_host_cli_agent_response",
      schema: "jcc-pending-visual-run-v1",
      request: {
        request_id: "verify-augment-reroll",
        mode: "augment_choice",
        match_session_id: "verify-match",
      },
      artifacts: {
        vision_request: visionRequestFile,
      },
    });

    daemon.store.setJson("ui_runtime_state", {
      ...variables.state,
      active_mode: "augment_choice",
      response_task: { status: "idle" },
      visual_request_status: {
        status: "awaiting_host_cli_agent_response",
        mode: "augment_choice",
        reason: "user_confirmed_augment_reroll",
        request_id: "verify-augment-reroll",
        prepared_run_file: preparedRunFile,
        vision_request_file: visionRequestFile,
      },
    });
    const poll = await daemon.handleAction("pollCruiseAdvice", {}, null);
    assert(poll.status !== "awaiting_host_cli_agent_visual_response", "daemon poll must not resume a compatibility visual choice artifact");
    assert(poll.state.response_task?.status !== "awaiting_host_cli_agent_visual_response", "compatibility visual choice artifacts must not occupy the canonical answer lane");
    assert(poll.match_connection?.status === "connected_to_live_match", "daemon poll should promote match connection from real live_state");
    assert(daemon.store.getJson("ui_runtime_state").match_connection.status === "connected_to_live_match", "daemon should persist connected match state");
    assert(
      daemon.store.listRecentEvents(50).some((event) => event.event_type === "ui_action_completed" && event.payload?.action === "pollCruiseAdvice"),
      "daemon should record completed poll action for UI/event debugging",
    );
    daemon.stop();
  } finally {
    if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
    if (previousDataDir === undefined) delete process.env.JCC_RUNTIME_DATA_DIR;
    else process.env.JCC_RUNTIME_DATA_DIR = previousDataDir;
    await rmWithRetry(tempRoot);
  }
}

async function verifyStopMatchPreemptsBootstrapBeforeActionChain() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-daemon-stop-bootstrap-"));
  const logFile = path.join(tempRoot, "slow-codex.jsonl");
  const script = path.join(tempRoot, "slow-codex-app-server.mjs");
  const sourceHome = path.join(tempRoot, "source-codex-home");
  const runtimeHome = path.join(tempRoot, "runtime-codex-home");
  const previousEnv = {
    sourceHome: process.env.JCC_SOURCE_CODEX_HOME,
    runtimeHome: process.env.JCC_CODEX_RUNTIME_HOME,
    logFile: process.env.JCC_DAEMON_STOP_TEST_LOG,
  };
  let daemon = null;
  try {
    await mkdir(sourceHome, { recursive: true });
    await writeFile(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
    await writeFile(path.join(sourceHome, "config.toml"), 'model = "stub"\n', "utf8");
    await writeFile(script, `
import { appendFile } from "node:fs/promises";
import readline from "node:readline";
const logFile = process.env.JCC_DAEMON_STOP_TEST_LOG;
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", async (line) => {
  const message = JSON.parse(line);
  await appendFile(logFile, JSON.stringify({ pid: process.pid, method: message.method || null }) + "\\n", "utf8");
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
  if (message.method === "thread/start") {
    if (process.argv.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 10000));
    return send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "slow-thread" } } });
  }
  if (message.method === "turn/start") return send({ jsonrpc: "2.0", id: message.id,
    error: { code: -32603, message: "fixture stops after proving route startup" } });
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`, "utf8");
    process.env.JCC_SOURCE_CODEX_HOME = sourceHome;
    process.env.JCC_CODEX_RUNTIME_HOME = runtimeHome;
    process.env.JCC_DAEMON_STOP_TEST_LOG = logFile;

    const matchSessionId = "match-stop-during-bootstrap";
    const routeKey = `match:${matchSessionId}`;
    const runtimeState = {
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "disconnected", adb_target: null },
      daily_session: { status: "inactive", mode: null, generation: 1 },
      match_session: { status: "active", match_session_id: matchSessionId },
      match_connection: { status: "waiting_for_live_state" },
      watcher: { status: "idle", pid: null },
      response_task: { status: "idle", response_task_id: null },
      active_mode: "cruise",
      host_cli: { provider: "codex", available: true },
      host_sessions: {
        daily: { status: "ready", route_key: "daily:1", provider_session_id: "lobby-thread" },
        match: { status: "warming", route_key: routeKey, match_session_id: matchSessionId },
      },
      runtime_triggers: { visual_by_stage: { "3-2": { status: "done" } } },
      runtime_events: { latest: [{ match_session_id: matchSessionId, large: "x".repeat(10000) }] },
      runtime_event_log: [{ match_session_id: matchSessionId, large: "x".repeat(10000) }],
      runtime_event_detector: { match_session_id: matchSessionId, stage_round: "3-2" },
      runtime_event_advice: { handled: { old: { match_session_id: matchSessionId } }, retry_pending: {} },
      manual_match_variables: { match_session_id: matchSessionId, values: { encounter: "verify" } },
      match_context: {
        match_session_id: matchSessionId,
        large: "x".repeat(10000),
        latest_authoritative_facts: {
          stage_round: "x".repeat(400000),
          economy: {
            hp: "x".repeat(400000),
            gold: "x".repeat(400000),
            level: "x".repeat(400000),
            xp: "x".repeat(400000),
          },
        },
        choice_confirmations: [{
          choice_kind: "augment",
          stage_round: "3-2",
          selected_id: "oversized-choice",
          selected_name: "x".repeat(400000),
          confirmed_at: "2026-08-18T00:00:00.000Z",
        }],
      },
      resolved_decision_snapshot: { match_session_id: matchSessionId, stage_round: "3-2" },
      visual_request_status: { match_session_id: matchSessionId, status: "requested" },
      self_state_refresh: { match_session_id: matchSessionId, status: "running" },
      cruise_state_fingerprint: "stale-match-fingerprint",
      user_preferences: { rank_tier: "master", default_goal: "safe_top_four" },
      user_strategy_memory: { strategy_rows: [{ id: "keep-me", text: "保留长期偏好", approved: true }] },
      runtime_settings: { diagnostic_evidence_enabled: false },
    };
    setRuntimeServiceState(runtimeState);
    daemon = new JccRuntimeDaemon({ repoRoot: process.cwd(), dataRoot: tempRoot }).start();
    daemon.store.setJson("ui_runtime_state", runtimeState);
    daemon.store.setJson("manual_match_variables_latest", runtimeState.manual_match_variables);
    daemon.store.setJson("host_request_latest", { match_session_id: matchSessionId, request_id: "stale-request" });
    daemon.store.setJson("host_response_latest", { match_session_id: matchSessionId, final_text: "stale-response" });
    daemon.store.setJson("advice_task_lifecycle_latest", { match_session_id: matchSessionId, active_tasks: [] });
    daemon.store.upsertSession(matchSessionId, "match_session", "active", runtimeState.match_session);
    const oldMatchPipelineResult = {
      match_session_id: matchSessionId,
      score: {
        advice_tasks: [{
          task_id: "old-match-pipeline-advice",
          title: "Old match advice",
          short_advice: "Must remain scoped to the old match summary.",
        }],
      },
      lifecycle: { confirmed_tasks: [], skipped_tasks: [] },
    };
    const staleMatchQueue = daemon.store.enqueue("host_request", {
      match_session_id: matchSessionId,
      request_id: "stale-request",
    }, "pending", { scopeType: "match", scopeSessionId: matchSessionId });

    let releaseActionChain;
    daemon.actionChain = new Promise((resolve) => { releaseActionChain = resolve; });
    const stopStartedAt = Date.now();
    const stopPromise = daemon.handleAction("stopMatch", {}, null);
    const duplicateStopPromise = daemon.handleAction("stopMatch", {}, null);
    const pendingBootstrap = runHostAgentRequest({
      provider: "codex",
      available: true,
      spawn_command: process.execPath,
      spawn_prefix_args: [script, "slow"],
    }, "bootstrap", {
      parseJson: false,
      repoRoot: process.cwd(),
      hostCwd: tempRoot,
      timeoutMs: 15000,
      hostSessionKey: routeKey,
      taskId: `host-session-warmup:${routeKey}`,
    });
    const bootstrapResult = await Promise.race([
      pendingBootstrap,
      wait(3000).then(() => { throw new Error("Stop Match did not block provider bootstrap before actionChain"); }),
    ]);
    assert(bootstrapResult.ok === false, "preempted provider bootstrap must not produce a Host response");
    assert(Date.now() - stopStartedAt < 3000, "provider bootstrap blocking must be immediate while state cleanup remains queued");
    const bootstrapLog = await readFile(logFile, "utf8").catch(() => "");
    assert(!bootstrapLog.includes('"method":"thread/start"'), "a route stopped before provider creation must not spawn a late native session");
    const preemptionEvent = daemon.store.listRecentEvents(20).find((event) => event.event_type === "daemon_control_preemption_signalled");
    assert(preemptionEvent?.payload?.action === "stopMatch", "daemon must audit the preemptive Stop Match signal");
    assert(preemptionEvent?.payload?.match_bootstrap_preemption?.accepted === true, "daemon must target the persisted match route bootstrap");
    assert(preemptionEvent?.payload?.match_bootstrap_preemption?.route_start_blocked === true, "daemon must block a later bootstrap on the stopping route");

    releaseActionChain();
    const [stopped, duplicateStopped] = await Promise.race([
      Promise.all([stopPromise, duplicateStopPromise]),
      wait(15000).then(() => { throw new Error("Stop Match serialized cleanup did not complete after bootstrap preemption"); }),
    ]);
    assert(stopped.match_stopped === true, "Stop Match must complete the canonical match boundary");
    assert(duplicateStopped.ok === true, "a duplicate Stop Match must settle without failing the control lane");
    assert(stopped.state.match_session.status === "idle", "Stop Match must clear the active match");
    assert(stopped.state.daily_session.status === "active", "Stop Match must return to the existing lobby lifecycle");
    assert(stopped.state.host_sessions.match.status === "stopped", "Stop Match must close the match provider route");
    assert(stopped.state.host_sessions.daily.provider_session_id === "lobby-thread", "Stop Match must preserve the lobby provider route");
    const stoppedCanonicalState = daemon.store.getJson("ui_runtime_state");
    assert(stoppedCanonicalState.match_context === null, "Stop Match must clear the previous match context");
    assert(stoppedCanonicalState.manual_match_variables === null, "Stop Match must clear previous match variables");
    assert(stoppedCanonicalState.resolved_decision_snapshot === null, "Stop Match must clear the previous decision snapshot");
    assert(stoppedCanonicalState.visual_request_status === null, "Stop Match must clear previous visual request state");
    assert(stoppedCanonicalState.runtime_events.latest.length === 0, "Stop Match must clear previous runtime events");
    assert(stoppedCanonicalState.runtime_event_log.length === 0, "Stop Match must clear previous runtime event log");
    assert(Object.keys(stoppedCanonicalState.runtime_event_advice.handled).length === 0, "Stop Match must clear previous proactive advice history");
    assert(stoppedCanonicalState.user_preferences.rank_tier === "master", "Stop Match must preserve durable user preferences");
    assert(stoppedCanonicalState.user_strategy_memory.strategy_rows[0].id === "keep-me", "Stop Match must preserve approved strategy memory");
    assert(stoppedCanonicalState.runtime_settings.diagnostic_evidence_enabled === false, "Stop Match must preserve durable runtime settings");
    assert(daemon.store.db.prepare("SELECT status FROM runtime_sessions WHERE session_id = ?").get(matchSessionId)?.status === "stopped", "Stop Match must close the persisted match session row");
    const stoppedSessionPayload = JSON.parse(daemon.store.db.prepare("SELECT payload_json FROM runtime_sessions WHERE session_id = ?").get(matchSessionId)?.payload_json || "{}");
    assert(stoppedSessionPayload.postgame_summary?.schema === "jcc-postgame-decision-summary-v1", "Stop Match must persist a canonical compact postgame summary before reset");
    assert(stoppedSessionPayload.postgame_summary?.storage_policy?.store_full_live_state === false, "Stop Match summary must reject full live-state retention");
    assert(Buffer.byteLength(JSON.stringify(stoppedSessionPayload.postgame_summary), "utf8") <= 256 * 1024, "Stop Match summary must enforce the 256KB serialized hard limit");
    assert(String(stoppedSessionPayload.postgame_summary?.confirmed_choices?.[0]?.selected_name || "").length <= 300, "Stop Match summary must bound confirmation names before persistence");
    assert(Object.values(stoppedSessionPayload.postgame_summary?.economy_milestones || {}).every((value) => typeof value !== "string" || value.length <= 300), "Stop Match summary must bound every retained economy milestone string");
    assert(daemon.store.listRecentMatchSummaries(20).some((entry) => entry.match_session_id === matchSessionId), "canonical review reader must expose the stopped match summary");
    assert(daemon.store.getQueueItem(staleMatchQueue.id)?.status === "cancelled", "Stop Match must retire pending queue work owned by the match");
    assert(daemon.store.getJson("manual_match_variables_latest", null) === null, "Stop Match must remove the previous match variable mirror");
    assert(daemon.store.getJson("host_request_latest", null) === null, "Stop Match must remove the previous match request mirror");
    assert(daemon.store.getJson("host_response_latest", null) === null, "Stop Match must remove the previous match response mirror");

    const restarted = await runHostAgentRequest({
      provider: "codex",
      available: true,
      spawn_command: process.execPath,
      spawn_prefix_args: [script, "quick"],
    }, "bootstrap-after-stop", {
      parseJson: false,
      repoRoot: process.cwd(),
      hostCwd: tempRoot,
      timeoutMs: 3000,
      hostSessionKey: routeKey,
      taskId: `host-session-restart:${routeKey}`,
    });
    assert(
      !String(restarted.error || "").includes("route is stopping"),
      "serialized Stop Match cleanup must remove the route block for a later fresh lifecycle",
    );
    const restartLog = await readFile(logFile, "utf8").catch(() => "");
    assert(restartLog.includes('"method":"thread/start"'), "a later fresh lifecycle must be able to create a native provider thread");

    const stoppedSessionBeforeStart = daemon.store.db.prepare(`
      SELECT status, payload_json
      FROM runtime_sessions
      WHERE session_id = ?
    `).get(matchSessionId);
    const nextMatchSessionId = "match-started-after-explicit-stop";
    const canonicalStoppedState = daemon.store.getJson("ui_runtime_state");
    const canonicalStoppedTask = daemon.store.getJson("response_task");
    const startedAfterStopState = {
      ...canonicalStoppedState,
      match_session: {
        status: "active",
        match_session_id: nextMatchSessionId,
        started_at: "2026-08-21T00:00:00.000Z",
      },
      host_sessions: {
        ...canonicalStoppedState.host_sessions,
        match: {
          status: "idle",
          route_key: `match:${nextMatchSessionId}`,
          match_session_id: nextMatchSessionId,
        },
      },
      active_mode: "cruise",
      match_context: {
        match_session_id: nextMatchSessionId,
        latest_authoritative_facts: {
          stage_round: "4-2",
          economy: { hp: 37, gold: 42, level: 8, xp: 12 },
        },
      },
      response_task_revision: canonicalStoppedTask.revision,
      response_task: canonicalStoppedTask,
    };
    daemon.persistResult("startMatch", {
      ok: true,
      state: startedAfterStopState,
      previous_match_session_id: matchSessionId,
    });
    const stoppedSessionAfterStart = daemon.store.db.prepare(`
      SELECT status, payload_json
      FROM runtime_sessions
      WHERE session_id = ?
    `).get(matchSessionId);
    assert(stoppedSessionAfterStart?.status === "stopped", "Start Match after Stop Match must not rewrite the historical session as superseded");
    assert(stoppedSessionAfterStart?.payload_json === stoppedSessionBeforeStart?.payload_json, "Start Match after Stop Match must not rewrite the historical stopped-session payload");
    setRuntimeServiceState(startedAfterStopState);
    const nextMatchPipelineResult = {
      match_session_id: nextMatchSessionId,
      score: {
        advice_tasks: [{
          task_id: "new-match-pipeline-advice",
          title: "New match advice",
          short_advice: "Must remain scoped to the new match summary.",
        }],
      },
      lifecycle: { confirmed_tasks: [], skipped_tasks: [] },
    };
    assert(
      rememberInMemoryPipelineResult(path.join(tempRoot, "new-match-pipeline.json"), nextMatchPipelineResult),
      "the new match pipeline result must be retained under the new match id",
    );
    assert(
      rememberInMemoryPipelineResult(path.join(tempRoot, "old-match-pipeline-late.json"), oldMatchPipelineResult) === null,
      "a detached old-match pipeline completion must be rejected after Start Match creates a new match",
    );
    const nextStopped = await daemon.handleAction("stopMatch", {}, null);
    assert(nextStopped.match_stopped === true, "the newly started match must stop cleanly after a late old pipeline completion");
    const nextStoppedPayload = JSON.parse(daemon.store.db.prepare("SELECT payload_json FROM runtime_sessions WHERE session_id = ?").get(nextMatchSessionId)?.payload_json || "{}");
    assert(nextStoppedPayload.postgame_summary?.match_session_id === nextMatchSessionId, "the new match Stop summary must remain bound to the new match");
    assert(nextStoppedPayload.postgame_summary?.advice_tasks?.some((task) => task.task_id === "new-match-pipeline-advice"), "the new match Stop summary must read only its own pipeline results");
    assert(!nextStoppedPayload.postgame_summary?.advice_tasks?.some((task) => task.task_id === "old-match-pipeline-advice"), "a late old-match pipeline result must not pollute the new match Stop summary");

    const shutdownMatchSessionId = "match-started-for-clean-shutdown";
    const canonicalAfterNextStop = daemon.store.getJson("ui_runtime_state");
    const canonicalAfterNextStopTask = daemon.store.getJson("response_task");
    const shutdownState = {
      ...canonicalAfterNextStop,
      match_session: {
        status: "active",
        match_session_id: shutdownMatchSessionId,
        started_at: "2026-08-21T00:02:00.000Z",
      },
      host_sessions: {
        ...canonicalAfterNextStop.host_sessions,
        match: {
          status: "idle",
          route_key: `match:${shutdownMatchSessionId}`,
          match_session_id: shutdownMatchSessionId,
        },
      },
      active_mode: "cruise",
      response_task_revision: canonicalAfterNextStopTask.revision,
      response_task: canonicalAfterNextStopTask,
      match_context: {
        match_session_id: shutdownMatchSessionId,
        latest_authoritative_facts: {
          stage_round: "4-2",
          economy: { hp: 37, gold: 42, level: 8, xp: 12 },
        },
        choice_confirmations: [{
          choice_kind: "augment",
          stage_round: "3-2",
          selected_id: "shutdown-choice",
          selected_name: "Shutdown Choice",
          confirmed_at: "2026-08-21T00:01:00.000Z",
        }],
      },
    };
    daemon.persistResult("startMatch", {
      ok: true,
      state: shutdownState,
      previous_match_session_id: nextMatchSessionId,
    });
    setRuntimeServiceState(shutdownState);
    daemon.store.setJson("ui_runtime_state", shutdownState);
    daemon.store.upsertSession(shutdownMatchSessionId, "match_session", "active", shutdownState.match_session);
    const shutdownQueueItem = daemon.store.enqueue("host_request", {
      match_session_id: shutdownMatchSessionId,
      request_id: "shutdown-pending-request",
    }, "pending", { scopeType: "match", scopeSessionId: shutdownMatchSessionId });

    const shutdown = await daemon.handleAction("shutdown", { reason: "verify_clean_shutdown_match_retirement" }, null);
    assert(shutdown.ok === true, "clean shutdown should complete");
    assert(shutdown.stopped_match_session_id === shutdownMatchSessionId, "clean shutdown must return the captured active match id after clearing runtime state");
    assert(shutdown.state?.match_session?.status === "idle", "clean shutdown must return the cleared canonical runtime state to the daemon");
    assert(shutdown.retired_match_summary?.match_session_id === shutdownMatchSessionId, "clean shutdown must return the bounded retirement summary captured before reset");
    assert(shutdown.retired_match_summary?.economy_milestones?.stage_round === "4-2", "clean shutdown retirement summary must retain bounded pre-reset match facts");
    assert(Buffer.byteLength(JSON.stringify(shutdown.retired_match_summary), "utf8") <= 256 * 1024, "clean shutdown retirement summary must remain within the serialized hard limit");
    assert(daemon.store.db.prepare("SELECT status FROM runtime_sessions WHERE session_id = ?").get(shutdownMatchSessionId)?.status === "stopped", "clean shutdown must close the active SQLite match session as stopped");
    const shutdownSessionPayload = JSON.parse(daemon.store.db.prepare("SELECT payload_json FROM runtime_sessions WHERE session_id = ?").get(shutdownMatchSessionId)?.payload_json || "{}");
    assert(shutdownSessionPayload.postgame_summary?.match_session_id === shutdownMatchSessionId, "clean shutdown must persist the captured postgame summary on the stopped session");
    assert(daemon.store.getQueueItem(shutdownQueueItem.id)?.status === "cancelled", "clean shutdown must settle pending match-scoped queue work");
  } finally {
    daemon?.stop?.();
    await closeAllHostAgentSessions().catch(() => {});
    if (previousEnv.sourceHome === undefined) delete process.env.JCC_SOURCE_CODEX_HOME;
    else process.env.JCC_SOURCE_CODEX_HOME = previousEnv.sourceHome;
    if (previousEnv.runtimeHome === undefined) delete process.env.JCC_CODEX_RUNTIME_HOME;
    else process.env.JCC_CODEX_RUNTIME_HOME = previousEnv.runtimeHome;
    if (previousEnv.logFile === undefined) delete process.env.JCC_DAEMON_STOP_TEST_LOG;
    else process.env.JCC_DAEMON_STOP_TEST_LOG = previousEnv.logFile;
    await rmWithRetry(tempRoot);
  }
}

async function main() {
  try {
    await verifyStaticContract();
    await verifyLegacyMirrorCannotBecomeCanonical();
    await verifySqliteLifecycle();
    await verifyHandleActionHydratesFromSqlite();
    await verifyHydrateRepairsStaleConnectedMatchAndVariables();
    await verifyHydrateClearsStaleResponseTaskFromSqlite();
    await verifyRestartClearsFreshResponseTaskFromPreviousProcess();
    await verifyReadOnlyPollingPreservesLiveLongResponseTask();
    await verifyHydrateClearsFailedResponseTaskOutsideCurrentMatch();
    await verifyHydratePreservesFreshHostCliCapabilities();
    await verifyElectronDaemonUserSymptomFlow();
    await verifyStopMatchPreemptsBootstrapBeforeActionChain();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      checked: ["runtime-daemon-contract", "electron-main-daemon-boundary", "legacy-json-mirror-never-promoted", "sqlite-lifecycle", "handle-action-sqlite-hydration", "hydrate-repairs-stale-connected-match-and-variables", "hydrate-clears-stale-response-task", "restart-clears-fresh-response-task-from-previous-process", "read-only-polling-preserves-live-long-response-task", "hydrate-clears-failed-response-task-outside-current-match", "hydrate-preserves-fresh-host-cli-capabilities", "electron-daemon-user-symptom-flow", "stop-match-preempts-bootstrap-before-action-chain", "stop-then-start-preserves-stopped-session", "late-old-pipeline-does-not-pollute-new-match-summary", "clean-shutdown-retires-active-match"],
    }, null, 2)}\n`);
  } finally {
    await handleRuntimeAction("shutdown", { reason: "verify_jcc_runtime_daemon" }, null).catch(() => {});
  }
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
