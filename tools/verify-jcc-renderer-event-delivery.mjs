import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "../ui/node_modules/typescript/lib/typescript.js";

async function loadRuntimeBridgeModule() {
  const source = await readFile("ui/src/runtimeBridge.ts", "utf8");
  const runtimeUiModeContract = JSON.parse(
    await readFile("data/runtime/jcc/runtime-ui-mode-contract.json", "utf8"),
  );
  const selfContainedSource = source.replace(
    'import runtimeUiModeContractJson from "../../data/runtime/jcc/runtime-ui-mode-contract.json";',
    `const runtimeUiModeContractJson = ${JSON.stringify(runtimeUiModeContract)};`,
  );
  assert.notEqual(selfContainedSource, source, "runtimeBridge verifier must inline the UI mode contract import");
  const compiled = ts.transpileModule(selfContainedSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "runtimeBridge.ts",
  }).outputText;
  const encoded = Buffer.from(compiled, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}`);
}

async function loadDaemonForwarderFactory() {
  const source = await readFile("ui/electron/main.js", "utf8");
  const match = source.match(
    /\/\/ TESTABLE_DAEMON_FORWARDER_START\s*([\s\S]*?)\s*\/\/ TESTABLE_DAEMON_FORWARDER_END/,
  );
  assert(match, "main.js must expose the pure retryable daemon forwarder helper between test markers");
  return Function(`"use strict";\n${match[1]}\nreturn createRetryableDaemonEventForwarder;`)();
}

async function verifyIndependentFollowupTimers() {
  const source = await readFile("ui/src/App.tsx", "utf8");
  assert(source.includes("const visualFollowupTimerRef = useRef<number | null>(null);"), "renderer must retain a visual follow-up timer");
  assert(source.includes("const deliveryFollowupTimerRef = useRef<number | null>(null);"), "renderer must own a separate canonical-delivery timer");
  const deliveryBlock = source.match(/const scheduleDeliveryFollowup = \(reason: string, delayMs = 1200\) => \{([\s\S]*?)\n  \};/);
  assert(deliveryBlock, "renderer must expose the canonical-delivery scheduler");
  assert(deliveryBlock[1].includes("deliveryFollowupTimerRef.current"), "canonical delivery must use its dedicated timer");
  assert(!deliveryBlock[1].includes("if (visualFollowupTimerRef.current !== null) return"), "visual polling must not block canonical coach delivery");
}

function completedTask({
  id,
  revision,
  mode,
  matchSessionId = null,
  origin = "user",
  text = "answer",
}) {
  return {
    status: "completed",
    response_task_id: id,
    revision,
    mode,
    match_session_id: matchSessionId,
    origin,
    response: {
      schema: "jcc-host-cli-coach-response-v1",
      mode,
      final_text: text,
      confidence: "medium",
    },
  };
}

async function verifyDeliveryRoutingAndAck(bridge) {
  const rendered = [];
  const acknowledgements = [];
  const states = [];
  let deliveryCalls = 0;
  let canonicalState = {
    match_session: { status: "idle", match_session_id: null },
    active_mode: "daily_chat",
    response_task: null,
  };

  const runtime = {
    async getState() {
      return { ok: true, state: canonicalState };
    },
    async observeRuntimeTick() {
      return { ok: true, status: "runtime_observed", state: canonicalState };
    },
    async deliverReadyResponse() {
      deliveryCalls += 1;
      let task = canonicalState.response_task;
      if (task?.status === "running" && task.response_task_id === "running-to-completed-task") {
        task = completedTask({
          id: task.response_task_id,
          revision: task.revision,
          mode: task.mode,
          matchSessionId: task.match_session_id,
          origin: task.origin,
          text: "reconciled active response",
        });
        canonicalState = { ...canonicalState, response_task: task };
      }
      return {
        ok: task?.status === "completed",
        status: task?.status === "completed" ? "completed" : "no_response_ready",
        state: canonicalState,
        response_task: task,
        response: task?.response,
      };
    },
    async ackDeliveredResponse(payload) {
      acknowledgements.push(payload);
      canonicalState = {
        ...canonicalState,
        response_task: {
          ...canonicalState.response_task,
          status: "completed",
          delivered_at: "2026-07-11T00:00:00.000Z",
          response_task_id: null,
        },
      };
      return { ok: true, status: "delivered", state: canonicalState };
    },
  };

  canonicalState = {
    match_session: { status: "active", match_session_id: "match-1" },
    active_mode: "augment_choice",
    response_task: completedTask({
      id: "match-task",
      revision: 7,
      mode: "augment_choice",
      matchSessionId: "match-1",
      text: "拿第三个海克斯。",
    }),
  };
  await bridge.reconcileCanonicalRuntimeDelivery({
    runtime,
    reason: "completed event after Start Match",
    onState: (state) => states.push(state),
    onDelivery: ({ stream, response }) => {
      rendered.push({ stream, text: response?.final_text });
      return true;
    },
  });

  assert.deepEqual(rendered.shift(), { stream: "match", text: "拿第三个海克斯。" });
  assert.deepEqual(acknowledgements.shift(), {
    response_task_id: "match-task",
    response_task_revision: 7,
    reason: "completed event after Start Match",
  });
  assert(states.length >= 2, "delivery reconcile should publish canonical state before and after ACK");

  const callsBeforeActiveReconcile = deliveryCalls;
  canonicalState = {
    match_session: { status: "active", match_session_id: "match-1" },
    active_mode: "cruise",
    response_task: {
      status: "running",
      response_task_id: "running-to-completed-task",
      revision: 9,
      mode: "cruise",
      match_session_id: "match-1",
      origin: "user",
    },
  };
  await bridge.reconcileCanonicalRuntimeDelivery({
    runtime,
    reason: "active task reconciliation",
    onState: (state) => states.push(state),
    onDelivery: ({ stream, response }) => {
      rendered.push({ stream, text: response?.final_text });
      return true;
    },
  });
  assert.equal(deliveryCalls, callsBeforeActiveReconcile + 1, "active canonical tasks must call backend delivery reconciliation");
  assert.deepEqual(rendered.shift(), { stream: "match", text: "reconciled active response" });
  assert.deepEqual(acknowledgements.shift(), {
    response_task_id: "running-to-completed-task",
    response_task_revision: 9,
    reason: "active task reconciliation",
  });

  canonicalState = {
    match_session: { status: "idle", match_session_id: null },
    active_mode: "daily_chat",
    response_task: completedTask({
      id: "daily-task",
      revision: 11,
      mode: "daily_chat",
      text: "日常回答。",
    }),
  };
  await bridge.reconcileCanonicalRuntimeDelivery({
    runtime,
    reason: "bootstrap canonical delivery",
    onState: () => {},
    onDelivery: ({ stream, response }) => {
      rendered.push({ stream, text: response?.final_text });
      return true;
    },
  });
  assert.deepEqual(rendered.shift(), { stream: "daily", text: "日常回答。" });
  assert.deepEqual(acknowledgements.shift(), {
    response_task_id: "daily-task",
    response_task_revision: 11,
    reason: "bootstrap canonical delivery",
  });

  canonicalState = {
    match_session: { status: "active", match_session_id: "match-2" },
    active_mode: "cruise",
    response_task: completedTask({
      id: "daily-during-match-task",
      revision: 12,
      mode: "daily_chat",
      text: "日常回答保留在日常流。",
    }),
  };
  const matchNotices = [];
  await bridge.reconcileCanonicalRuntimeDelivery({
    runtime,
    reason: "daily response completed during active match",
    onState: () => {},
    onDelivery: ({ stream, response, result }) => {
      rendered.push({ stream, text: response?.final_text });
      if (bridge.dailyDeliveryNeedsActiveMatchNotice({ stream, state: result.state })) {
        matchNotices.push("daily response ready notice");
      }
      return true;
    },
  });
  assert.deepEqual(rendered.shift(), { stream: "daily", text: "日常回答保留在日常流。" });
  assert.deepEqual(matchNotices, ["daily response ready notice"], "active match must get a visible notice for completed daily responses");
  assert.deepEqual(acknowledgements.shift(), {
    response_task_id: "daily-during-match-task",
    response_task_revision: 12,
    reason: "daily response completed during active match",
  });
}

async function verifyCrossPathReplayExactlyOnce(bridge) {
  const rendered = [];
  const acknowledgements = [];
  let canonicalState = {
    match_session: { status: "active", match_session_id: "match-replay" },
    active_mode: "cruise",
    response_task: completedTask({
      id: "cross-path-task",
      revision: 17,
      mode: "cruise",
      matchSessionId: "match-replay",
      text: "one canonical answer",
    }),
  };
  const runtime = {
    async getState() {
      return { ok: true, state: canonicalState };
    },
    async observeRuntimeTick() {
      return { ok: true, status: "runtime_observed", state: canonicalState };
    },
    async deliverReadyResponse() {
      const task = canonicalState.response_task;
      return {
        ok: task?.status === "completed" && Boolean(task?.response_task_id),
        status: task?.status === "completed" && task?.response_task_id ? "completed" : "no_response_ready",
        state: canonicalState,
        response_task: task,
        response: task?.response,
      };
    },
    async ackDeliveredResponse(payload) {
      acknowledgements.push(payload);
      canonicalState = {
        ...canonicalState,
        response_task: {
          ...canonicalState.response_task,
          response_task_id: null,
          delivered_at: "2026-07-28T00:00:00.000Z",
        },
      };
      return { ok: true, status: "delivered", state: canonicalState };
    },
  };
  const reconcile = (reason) => bridge.reconcileCanonicalRuntimeDelivery({
    runtime,
    reason,
    onState: () => {},
    onDelivery: ({ response }) => {
      rendered.push(response?.final_text);
      return true;
    },
  });

  await reconcile("initial canonical state");
  const drain = bridge.createRuntimeReconcileDrain(async (request) => {
    if (request.observe) await runtime.observeRuntimeTick();
    await reconcile(request.reason);
  });
  drain.request({ sequence: 21, observe: false, reason: "event stream replay" });
  await drain.whenIdle();
  drain.request({ sequence: 21, observe: true, reason: "watchdog reconcile" });
  await drain.whenIdle();

  assert.deepEqual(rendered, ["one canonical answer"], "initial state, event replay, and watchdog must render one strategy answer total");
  assert.equal(acknowledgements.length, 1, "cross-path replay must ACK the completed task exactly once");
  assert.deepEqual(acknowledgements[0], {
    response_task_id: "cross-path-task",
    response_task_revision: 17,
    reason: "initial canonical state",
  });
}

async function verifyCardOpenDeliveryAndNextCheckpoint(bridge) {
  for (const mode of ["augment_choice", "item_choice", "manual_match_variables", "lineup_card"]) {
    let rendered = 0;
    let acks = 0;
    const state = { active_mode: mode, match_session: { status: "active", match_session_id: "card-open-match" } };
    const runtime = {
      async getState() { return { ok: true, state }; },
      async deliverReadyResponse() { return { ok: true, status: "completed", state, response_task: state.response_task, response: state.response_task.response }; },
      async ackDeliveredResponse(payload) {
        assert.equal(rendered, acks + 1, "ACK must follow a real render");
        assert.equal(payload.response_task_id, state.response_task.response_task_id);
        acks++;
        state.response_task = { ...state.response_task, status: "delivered", delivered_at: new Date().toISOString() };
        return { ok: true, state };
      },
    };
    for (const stage of ["2-7", "3-3"]) {
      state.response_task = completedTask({ id: `${mode}:${stage}`, revision: acks + 1, mode: "cruise", matchSessionId: "card-open-match", origin: "runtime_event" });
      const result = await bridge.reconcileCanonicalRuntimeDelivery({ runtime, reason: "card-open-regression", onDelivery: () => { rendered++; return true; } });
      assert.equal(result.status, "rendered_and_acked");
      await bridge.reconcileCanonicalRuntimeDelivery({ runtime, reason: "duplicate-event", onDelivery: () => { throw new Error("duplicate render"); } });
      assert.equal(state.active_mode, mode, "automatic delivery must not change the selected card");
    }
    assert.equal(acks, 2, "the next checkpoint must deliver without changing cards");
  }
}

async function verifyTrailingDrain(bridge) {
  const calls = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const drain = bridge.createRuntimeReconcileDrain(async (request) => {
    calls.push(request.sequence);
    if (calls.length === 1) {
      firstStarted();
      await firstBlocked;
    }
  });

  drain.request({ sequence: 1, reason: "first event" });
  await firstStartedPromise;
  drain.request({ sequence: 2, reason: "event while reconcile is busy" });
  releaseFirst();
  await drain.whenIdle();

  assert.deepEqual(calls, [1, 2], "a second event received during reconcile must trigger a trailing drain");
  assert.equal(drain.snapshot().processedSequence, 2);
}

async function verifyStaleObserveTrailingDrain(bridge) {
  const calls = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const drain = bridge.createRuntimeReconcileDrain(async (request) => {
    calls.push({ sequence: request.sequence, observe: request.observe, reason: request.reason });
    if (calls.length === 1) {
      firstStarted();
      await firstBlocked;
    }
  });

  drain.request({ sequence: 5, observe: false, reason: "current response event" });
  await firstStartedPromise;
  drain.request({ sequence: 5, observe: true, reason: "duplicate watcher observe after snapshot" });
  releaseFirst();
  await drain.whenIdle();

  assert.deepEqual(
    calls.map((call) => ({ sequence: call.sequence, observe: call.observe })),
    [
      { sequence: 5, observe: false },
      { sequence: 5, observe: true },
    ],
    "duplicate observe:true received after pendingObserve snapshot must run a trailing observe drain",
  );
}

function verifyStopAndLineupGuards(bridge) {
  assert.equal(bridge.runtimeResultGenerationIsCurrent(4, 5), false, "a pre-Stop send result must not overwrite canonical state");
  assert.equal(bridge.runtimeResultGenerationIsCurrent(5, 5), true);

  assert.equal(bridge.pinnedPanelShouldBeVisible({
    explicitlyOpen: true,
    lineupPlan: null,
    lineupStatus: "idle",
    activeMode: "cruise",
  }), true, "a user-opened pinned slot must stay mounted while switching to an empty lineup tab");
  assert.equal(bridge.pinnedPanelShouldBeVisible({
    explicitlyOpen: false,
    lineupPlan: null,
    lineupStatus: "idle",
    activeMode: "cruise",
  }), false, "an untouched empty pinned slot may remain collapsed to preserve match chat space");
  assert.equal(bridge.hostCliCandidateStatusLabel({
    provider: "kimi",
    available: false,
    discovery_status: "runtime_required",
  }), "Electron required", "browser preview must not misreport its inability to scan local CLI installations as not found");
  assert.equal(bridge.hostCliCandidateStatusLabel({
    provider: "kimi",
    available: false,
    discovery_status: "probe_failed",
  }), "Detected, unavailable", "an installed CLI that failed its probe must not be labeled not found");
  assert.equal(bridge.preferredAvailableHostProvider({
    agents: [
      { provider: "codex", available: true },
      { provider: "kimi", available: true },
    ],
    selectedProvider: "kimi",
    canonicalProvider: "codex",
  }), "kimi", "rescanning must preserve the user's still-available provider selection");

  assert.equal(bridge.pinnedResultIsPublishable({
    slot: "lineup",
    title: "valid",
    units: [
      { row: 1, col: 1, name: "A" },
      { row: 1, col: 2, name: "B" },
      { row: 2, col: 1, name: "C" },
      { row: 2, col: 2, name: "D" },
    ],
    loadouts: [{ unit: "A", items: ["item"] }],
    moves: ["next step"],
  }), true);
  assert.equal(bridge.pinnedResultIsPublishable({
    schema: "jcc-internal-lineup-plan-v1",
    slot: "lineup",
    title: "valid final lineup with unknown equipment",
    units: [
      { row: 1, col: 1, name: "A" },
      { row: 1, col: 2, name: "B" },
      { row: 2, col: 1, name: "C" },
      { row: 2, col: 2, name: "D" },
      { row: 3, col: 1, name: "E" },
      { row: 3, col: 2, name: "F" },
      { row: 4, col: 1, name: "G" },
    ],
    equipment_status: "unknown",
    loadouts: [],
    moves: ["next step"],
  }), true, "renderer must accept the backend contract's explicit unknown-equipment final card");
  assert.equal(bridge.pinnedResultIsPublishable({
    degraded: true,
    units: [{ row: 1, col: 1, name: "A" }],
    loadouts: [{ unit: "A", items: ["item"] }],
    moves: ["next step"],
  }), false, "renderer must not publish backend-degraded lineup cards");

  const staleCruise = bridge.responseTaskDeliveryDecision({
    task: completedTask({
      id: "old-cruise",
      revision: 3,
      mode: "cruise",
      matchSessionId: "match-1",
      origin: "runtime_event",
    }),
    state: {
      match_session: { status: "active", match_session_id: "match-1" },
      active_mode: "augment_choice",
    },
  });
  assert.equal(
    staleCruise.action,
    "deliver",
    "an open card without an active answer owner must not withhold a completed Cruise answer",
  );
  assert.equal(staleCruise.stream, "match");
  assert.equal(bridge.responseTaskDeliveryDecision({
    task: completedTask({ id: "old-cruise", revision: 3, mode: "cruise", matchSessionId: "match-1", origin: "runtime_event" }),
    state: { match_session: { status: "active", match_session_id: "match-1" }, active_mode: "cruise" },
  }).action, "deliver", "returning to Cruise must release the same deferred automatic answer");

  assert.equal(bridge.lineupDeliveryGuardDecision({
    response: { mode: "lineup_card", final_text: "old lineup" },
    task: completedTask({ id: "old-lineup", revision: 1, mode: "lineup_card", matchSessionId: "match-1" }),
    expectedTaskId: null,
    lineupRequestInFlight: true,
    source: "canonical",
  }), "defer_without_ack", "canonical lineup must defer without ACK while a lineup request is in-flight but has no expected task id yet");
  assert.equal(bridge.lineupDeliveryGuardDecision({
    response: { mode: "lineup_card", final_text: "current lineup" },
    task: completedTask({ id: "current-lineup", revision: 1, mode: "lineup_card", matchSessionId: "match-1" }),
    expectedTaskId: "current-lineup",
    lineupRequestInFlight: false,
    source: "canonical",
  }), "deliver", "matching current lineup task may publish");
  assert.equal(bridge.lineupDeliveryGuardDecision({
    response: { mode: "lineup_card", final_text: "old lineup" },
    task: completedTask({ id: "old-lineup", revision: 1, mode: "lineup_card", matchSessionId: "match-1" }),
    expectedTaskId: "current-lineup",
    lineupRequestInFlight: false,
    source: "canonical",
  }), "suppress_and_ack", "old lineup task id must be suppressed and ACKed when it clearly mismatches the current expected lineup task");
}

async function verifyDaemonForwarderRetry() {
  const createRetryableDaemonEventForwarder = await loadDaemonForwarderFactory();
  let starts = 0;
  let subscriptions = 0;
  const never = new Promise(() => {});
  const forwarder = createRetryableDaemonEventForwarder({
    ensureStarted: async () => {
      starts += 1;
      if (starts === 1) throw new Error("first start failed");
    },
    subscribe: () => {
      subscriptions += 1;
      return never;
    },
    onEvent: () => {},
    onError: () => {},
  });

  await assert.rejects(forwarder.ensure(), /first start failed/);
  assert.equal(forwarder.isStarted(), false);
  await forwarder.ensure();
  assert.equal(forwarder.isStarted(), true);
  assert.equal(starts, 2, "a failed first start must be retried");
  assert.equal(subscriptions, 1, "only the successful start should subscribe");
}

async function main() {
  const bridge = await loadRuntimeBridgeModule();
  const appSource = await readFile("ui/src/App.tsx", "utf8");
  for (const name of [
    "createRuntimeReconcileDrain",
    "reconcileCanonicalRuntimeDelivery",
    "responseTaskDeliveryDecision",
    "runtimeResultGenerationIsCurrent",
    "pinnedResultIsPublishable",
    "pinnedPanelShouldBeVisible",
    "hostCliCandidateStatusLabel",
    "preferredAvailableHostProvider",
    "dailyDeliveryNeedsActiveMatchNotice",
    "lineupDeliveryGuardDecision",
  ]) {
    assert.equal(typeof bridge[name], "function", `runtimeBridge must export ${name}`);
  }

  await verifyDeliveryRoutingAndAck(bridge);
  await verifyCrossPathReplayExactlyOnce(bridge);
  await verifyCardOpenDeliveryAndNextCheckpoint(bridge);
  await verifyTrailingDrain(bridge);
  await verifyStaleObserveTrailingDrain(bridge);
  verifyStopAndLineupGuards(bridge);
  await verifyDaemonForwarderRetry();
  await verifyIndependentFollowupTimers();
  const pollCruiseBody = appSource.slice(
    appSource.indexOf("const pollCruiseOnce = async"),
    appSource.indexOf("const handleObservedRuntimeResult", appSource.indexOf("const pollCruiseOnce = async")),
  );
  assert(!pollCruiseBody.includes('result.status === "completed" && emitCoachResponse'), "pollCruiseOnce must route completed responses through canonical delivery instead of rendering through a second path");

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-renderer-event-delivery-verifier-v1",
    checks: [
      "initial_daily_mount_then_match_completion_routes_to_match_and_acks",
      "event_received_during_reconcile_triggers_trailing_drain",
      "bootstrap_delivers_completed_daily_response",
      "daily_response_completed_during_active_match_gets_match_visible_notice",
      "stopped_generation_cannot_overwrite_canonical_state",
      "lineup_pre_task_id_guard_defers_without_ack",
      "lineup_task_id_mismatch_suppresses_and_acks",
      "lineup_renderer_accepts_only_publishable_backend_structure",
      "open_card_does_not_block_canonical_cruise_delivery",
      "duplicate_or_older_observe_true_requests_trigger_trailing_drain",
      "daemon_event_forwarding_retries_after_first_start_failure",
      "active_tasks_enter_backend_delivery_reconciliation",
      "poll_cruise_has_no_second_direct_response_renderer",
      "visual_polling_does_not_block_canonical_delivery_timer",
      "initial_state_event_replay_and_watchdog_deliver_one_response_exactly_once",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
