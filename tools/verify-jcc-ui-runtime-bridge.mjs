import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPack } from "./build-jcc-host-agent-context-pack.mjs";

const REQUIRED_UI_MODES = {
  cruise: "cruise",
  lineup: "lineup_card",
  vars: "manual_match_variables",
  chat: "daily_chat",
  prefs: "user_preferences",
  wiki: "strategy_wiki",
  review: "postgame_review",
};

async function text(file) {
  return readFile(file, "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(source, needle, label) {
  assert(source.includes(needle), `${label} must include ${needle}`);
}

function assertMatches(source, pattern, label) {
  assert(pattern.test(source), `${label} must match ${pattern}`);
}

function extractMarkedSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert(start >= 0 && end > start, `missing marked source ${startMarker}`);
  return source.slice(start + startMarker.length, end);
}

async function verifyCleanWindowCloseBehavior() {
  const mainSource = await text("ui/electron/main.js");
  const helperSource = extractMarkedSource(
    mainSource,
    "// TESTABLE_CLEAN_WINDOW_CLOSE_START",
    "// TESTABLE_CLEAN_WINDOW_CLOSE_END",
  );
  const runCleanWindowClose = new Function(`${helperSource}; return runCleanWindowClose;`)();

  const successCalls = [];
  const success = await runCleanWindowClose({
    cleanup: async () => {
      successCalls.push("cleanup");
      return { ok: true, status: "runtime_service_shutdown_cleaned" };
    },
    stopDaemon: async () => successCalls.push("stop_daemon"),
    close: () => successCalls.push("close_window"),
  });
  assert(success.ok === true && success.status === "window_closed_cleanly", "clean close should report a closed window");
  assert(successCalls.join(",") === "cleanup,stop_daemon,close_window", "clean close must preserve cleanup -> daemon stop -> window close order");

  const failureCalls = [];
  const failure = await runCleanWindowClose({
    cleanup: async () => {
      failureCalls.push("cleanup");
      return { ok: false, status: "watcher_termination_failed" };
    },
    stopDaemon: async () => failureCalls.push("stop_daemon"),
    close: () => failureCalls.push("close_window"),
  });
  assert(failure.ok === false && failure.status === "watcher_termination_failed", "degraded cleanup should remain visible to the renderer");
  assert(failureCalls.join(",") === "cleanup", "failed cleanup must keep the daemon and window open for retry");
}

async function verifyElectronBoundary() {
  const main = await text("ui/electron/main.js");
  const preload = await text("ui/electron/preload.js");
  const service = await text("ui/electron/runtime-service.js");
  const hostAdapters = await text("ui/electron/host-adapters.js");
  const hostInstructionContract = await text("data/runtime/jcc/host-coach-instruction-contract.json");
  const stateStore = await text("ui/electron/runtime-state-store.js");
  const app = await text("ui/src/App.tsx");
  assertIncludes(main, "contextIsolation: true", "electron main");
  assertIncludes(main, "nodeIntegration: false", "electron main");
  assertIncludes(main, "preload:", "electron main");
  assertIncludes(main, "ipcMain.handle(\"jcc-runtime:action\"", "electron main");
  assertIncludes(main, "RuntimeDaemonClient", "electron main should use the runtime daemon client");
  assertIncludes(main, "getDaemonClient().action", "electron main should route runtime actions through daemon HTTP");
  assertIncludes(main, "ensureDaemonEventForwarding", "electron main should subscribe to daemon events");
  assertIncludes(main, "createRetryableDaemonEventForwarder", "electron main should use a retryable event-forwarding starter");
  assertIncludes(main, "await daemonEventForwarder.ensure()", "electron main should await the retryable forwarding starter");
  assert(!main.includes("daemonEventForwardingStarted = true;\n  await"), "electron main must not set a permanent started flag before daemon startup succeeds");
  assertIncludes(main, "startSupervisor", "electron main should start daemon supervisor");
  assertIncludes(main, "daemon_reconnected", "electron main should notify renderer after daemon reconnect");
  assertIncludes(main, "jcc-runtime:event", "electron main should forward daemon events to renderer");
  assertIncludes(main, "action === \"closeWindow\"", "electron main should keep physical window ownership local");
  assertIncludes(main, "closeWindowThroughRuntime(window)", "electron main should gate physical close on daemon-owned cleanup");
  assertIncludes(main, "client.action(\"shutdown\", { reason: \"close_window\" })", "electron main should await canonical runtime cleanup before closing");
  assertIncludes(main, "stopDaemon: () => client.stop()", "electron main should stop its daemon transport before closing");
  assertIncludes(main, "action === \"minimizeWindow\"", "electron main should keep window minimize local");
  assert(!main.includes("getRuntimeDaemon"), "electron main must not embed the in-process daemon");
  assert(!main.includes("import { handleRuntimeAction } from \"./runtime-service.js\""), "electron main must not import runtime service directly");
  assert(!main.includes("return await handleRuntimeAction("), "electron main must not bypass daemon");
  assertIncludes(preload, "contextBridge.exposeInMainWorld(\"jccRuntime\"", "preload");
  assertIncludes(app, "appendMessageToStream(\"daily\"", "Stop Match status delivery");
  assert(!app.includes("setDailyMessages((value) => [\n        ...value,"), "Stop Match must not bypass the bounded daily message append helper");
  assertIncludes(app, "result.status === \"watcher_termination_failed\"", "Stop Match must distinguish watcher termination failure");
  assert(!preload.includes("runTool"), "preload must not expose generic runTool");
  assert(!preload.includes("runCommand"), "preload must not expose generic runCommand");
  assertIncludes(preload, "detectHostCli", "preload should expose host CLI detection");
  assertIncludes(preload, "getManualVariableOptions", "preload should expose active-descriptor manual variable options");
  assertIncludes(preload, "saveUserPreferences", "preload should expose user preference saving");
  assertIncludes(preload, "updateRankings", "preload should expose the single rankings update action");
  assert(!preload.includes("DailyIntelligence") && !preload.includes("daily_intelligence"), "preload must not expose Daily Intelligence task controls");
  assertIncludes(preload, "pollCruiseAdvice", "preload should expose cruise advice polling");
  assert(!preload.includes("requestGodRewardChoice"), "preload must not expose removed god reward 3-choice action");
  assertIncludes(preload, "resetDailySession", "preload should expose daily host session reset");
  assertIncludes(preload, "minimizeWindow", "preload should expose window minimize");
  assertIncludes(preload, "onRuntimeEvent", "preload should expose daemon event subscription");
  assertIncludes(preload, "ipcRenderer.on(\"jcc-runtime:event\"", "preload should subscribe to daemon event IPC");
  assertIncludes(preload, "\"ackDeliveredResponse\"", "preload allowlist should include delivered-response ack");
  assertIncludes(preload, "ackDeliveredResponse: (payload) => invoke(\"ackDeliveredResponse\", payload)", "preload should expose delivered-response ack");
  assertIncludes(service, "const toolAllowlist = new Set", "runtime service");
  assertIncludes(service, "detectNodeRuntime", "runtime service should resolve a real Node executable");
  assertIncludes(service, "skipped: Claude CLI bundled Node is not the JCC runtime host Node", "runtime service should not use Claude CLI bundled Node unless explicitly configured");
  assertIncludes(service, "runHostAgentRequest", "runtime service should call thin host adapters");
  assertIncludes(service, "resolveVisionImagePath", "runtime service should resolve a real visual frame path for host multimodal calls");
  assertIncludes(service, "imagePaths: imagePath ? [imagePath] : []", "runtime service should attach visual frames to host multimodal calls");
  assertIncludes(service, "Inspect the attached image using your native visual capability", "runtime service visual prompt must not treat the image path as the visual input");
  assertIncludes(service, "detectHostAgent", "runtime service should detect host agents through the adapter registry");
  assertIncludes(service, "createRuntimePaths", "runtime service should use the runtime-owned state store");
  assertIncludes(service, "from \"./runtime-state-store.js\"", "runtime service should import the runtime-owned state store");
  assertIncludes(service, "function buildHostTurnDeltaPrompt", "runtime service should build persistent-session selected-context deltas");
  assertIncludes(service, "async function runHostModel", "runtime service should centralize host model execution");
  assertIncludes(service, "buildHostCoachInstructions", "runtime service should build prompts from the canonical instruction contract");
  assertIncludes(hostInstructionContract, "static context capsule already loaded", "canonical host instructions should reuse bootstrapped static context");
  assertIncludes(hostInstructionContract, "Never use prior conversation memory as authority for mutable game facts", "canonical host instructions should keep mutable runtime facts authoritative");
  assertIncludes(service, "runtime_owned", "runtime service should own daily/match route state");
  assertIncludes(service, "function warmHostSession", "runtime service must warm persistent host CLI sessions once per route");
  assertIncludes(service, "buildHostTurnDeltaPrompt", "runtime service must send current dynamic facts as later turns");
  assert(!service.includes("buildBootstrapContextForFirstPrompt"), "runtime service must not inject bootstrap state through host session memory");
  assert(!service.includes("primeHostSessionFromFirstResponse"), "runtime service must not capture Codex session ids");
  assert(!service.includes("readOutputFileIfReady"), "runtime service must not depend on output-last-message files");
  assert(!service.includes("output_file_poll"), "runtime service must not poll final output files");
  assert(!service.includes("JCC_UI_ENABLE_BACKGROUND_SESSION_WARMUP"), "runtime service must not background-warm model sessions");
  assert(!service.includes("await ensureHostSession(sessionKind);"), "runtime service must not block a real user response on a separate session boot prompt");
  assertIncludes(service, "getNodeCommand", "runtime service should use a real Node executable for tools");
  assert(!service.includes("spawn(process.execPath"), "runtime service must not spawn Electron as Node");
  assertIncludes(service, "shell: false", "runtime service");
  assertIncludes(service, "case \"detectHostCli\"", "runtime service should support explicit host CLI test/save");
  assertIncludes(service, "hostCliCapabilities", "runtime service should expose host CLI model capability hints through adapters");
  assertIncludes(service, "provider: \"codex\"", "runtime service should expose a generic host provider field");
  assertIncludes(service, "display_name: \"Codex CLI\"", "runtime service should expose a generic host display name");
  assertIncludes(service, "available: host.available", "runtime service should mirror adapter availability into generic host field");
  assertIncludes(service, "reasoningEffortOptionsForModel", "runtime service should expose native reasoning effort options per model");
  assertIncludes(hostAdapters, "xhigh", "host adapter should allow xhigh for supported models");
  assertIncludes(hostAdapters, "--image", "Codex host adapter should pass visual frames with codex exec --image");
  assertIncludes(hostAdapters, "options.imagePaths", "Host adapter should accept per-request visual image attachments");
  assertIncludes(hostAdapters, "image_transport: \"app-server-local-image-input\"", "Host adapter contract should declare Codex persistent image transport");
  assertIncludes(hostAdapters, "image_transport: \"acp-session-prompt-image-base64\"", "Host adapter contract should declare Kimi CLI ACP image transport");
  assert(!hostAdapters.includes("kimi_vision_api"), "Host adapter contract must not retain the removed Kimi HTTP Vision provider");
  assert(!hostAdapters.includes("moonshot-files-ms-file-id"), "Host adapter contract must not retain the removed Moonshot file-id transport");
  assertIncludes(service, "normalizePrimaryHostProvider", "runtime service should keep Host CLI primary provider scoped to CLI adapters");
  assertIncludes(service, "const commandRequired = true", "runtime service should always require a CLI command for the primary Host CLI Agent");
  assert(!service.includes("kimi_vision_api"), "runtime service must not retain the removed Kimi HTTP Vision provider");
  assertIncludes(hostAdapters, "selectKnownModelAlias", "Host adapter should preserve provider model aliases exposed by the CLI");
  assertIncludes(hostAdapters, 'provider === "kimi"', "Discovery should keep Kimi model selection scoped to provider-native aliases");
  assertIncludes(hostAdapters, "selected_model: detected.selected_model || null", "Discovery should preserve only models accepted by the selected CLI catalog");
  assert(!hostAdapters.includes("detected.selected_model || normalizeModelId(payload.model)"), "Discovery must not reintroduce a model rejected by direct CLI catalog detection");
  assertIncludes(service, "case \"getManualVariableOptions\"", "runtime service should support active-descriptor manual variable options");
  assertIncludes(stateStore, "per_match_variables.json", "runtime state store should load manual variables from normalized active-season data");
  assertIncludes(service, "source: \"active_season_normalized_hard_data\"", "runtime service should source manual variables from the active season");
  assert(!service.includes("ensureVariableOption"), "runtime service must not add season-specific manual variable fallbacks");
  assert(!service.includes('id: "spring"'), "runtime service must not hardcode S17 Stargazer Spring");
  assert(!service.includes("\\u6cc9\\u6c34"), "runtime service must not hardcode Stargazer Spring display text");
  assertIncludes(service, "case \"saveUserPreferences\"", "runtime service should support user preference saving");
  assertIncludes(service, "case \"pollCruiseAdvice\"", "runtime service should support proactive cruise advice polling");
  assert(!service.includes("case \"requestGodRewardChoice\""), "runtime service must not route removed god reward 3-choice action");
  assert(!service.includes("{ phase: \"god_reward_choice\" }"), "runtime service must not scan removed god reward 3-choice phase");
  assertIncludes(service, "runtimeChoiceModeContract(runtimeMode)", "runtime service should resolve choice phases from the active rules descriptor");
  assertIncludes(service, "runtimeChoiceModeContract(runtimeMode)?.phase", "runtime service should derive choice scan phases from the active rules descriptor");
  assert(!service.includes('if (runtimeMode === "god_sequence")'), "common runtime must not hardcode the S17-only god mode dispatch");
  assertIncludes(service, "case \"minimizeWindow\"", "runtime service should support window minimize");
  assertIncludes(service, "host_sessions", "runtime service should keep a compatibility daily/match route state");
  assertIncludes(service, "context_keys", "runtime service should track runtime-owned context route metadata");
  assert(!service.includes("codex-response-mode-"), "runtime service must not create standalone mode injection response files");
  assert(!service.includes("Failed to inject mode context"), "runtime service must not fail user answers because a standalone mode injection failed");
  assert(!service.includes("\"exec\", \"resume\""), "runtime service must not resume Codex CLI sessions");
  assert(!service.includes("findNewCodexSessionId"), "runtime service must not capture Codex session ids");
  assertIncludes(service, "case \"resetDailySession\"", "runtime service should support daily host session reset");
  assertIncludes(service, "Daily runtime route reset", "runtime service should reset the runtime-owned daily route");
  assertIncludes(stateStore, "jcc-runtime-user-settings.json", "runtime state store should persist user preferences");
  assertIncludes(stateStore, "jcc-runtime-state-store-v5", "runtime state store should be sqlite-backed v5");
  assertIncludes(stateStore, "app.sqlite", "runtime state store should expose app.sqlite");
  assertIncludes(stateStore, "runtime_migrations", "runtime state store should record migrations");
  assertIncludes(stateStore, "runtime_logs", "runtime state store should support structured logs");
  assertIncludes(stateStore, "listQueue", "runtime state store should inspect daemon queues");
  assertIncludes(stateStore, "writeLegacyJsonMirror", "runtime state store should mark JSON as legacy mirrors");
  const daemon = await text("ui/electron/runtime-daemon.js");
  assertIncludes(daemon, "jcc-runtime-daemon-v1", "runtime daemon should declare a daemon contract");
  assertIncludes(daemon, "createRuntimeSqliteStore", "runtime daemon should persist through sqlite store");
  assertIncludes(daemon, "handleRuntimeServiceAction", "runtime daemon should delegate compatibility actions to runtime service");
  const daemonServer = await text("ui/electron/runtime-daemon-server.js");
  assertIncludes(daemonServer, "http.createServer", "runtime daemon server should expose HTTP transport");
  assertIncludes(daemonServer, "randomBytes", "runtime daemon server should create a local auth token");
  assertIncludes(daemonServer, "x-jcc-runtime-token", "runtime daemon server should require token auth");
  assertIncludes(daemonServer, "Unauthorized", "runtime daemon server should reject unauthorized actions");
  assertIncludes(daemonServer, "/health", "runtime daemon server should expose health endpoint");
  assertIncludes(daemonServer, "/action", "runtime daemon server should expose action endpoint");
  assertIncludes(daemonServer, "/events", "runtime daemon server should expose event stream endpoint");
  assertIncludes(daemonServer, "/ws", "runtime daemon server should expose WebSocket endpoint");
  assertIncludes(daemonServer, "/queue", "runtime daemon server should expose queue inspect endpoint");
  assertIncludes(daemonServer, "/logs", "runtime daemon server should expose structured log endpoint");
  assertIncludes(daemonServer, "encodeWebSocketFrame", "runtime daemon server should broadcast WebSocket frames");
  const daemonClient = await text("ui/electron/runtime-daemon-client.js");
  assertIncludes(daemonClient, "RuntimeDaemonClient", "runtime daemon client should exist");
  assertIncludes(daemonClient, "authHeaders", "runtime daemon client should send daemon auth token");
  assertIncludes(daemonClient, "x-jcc-runtime-token", "runtime daemon client should use token auth");
  assertIncludes(daemonClient, "ownsProcess", "runtime daemon client should only stop daemon processes it owns");
  assertIncludes(daemonClient, "subscribe", "runtime daemon client should subscribe to daemon events");
  assertIncludes(daemonClient, "readWebSocketEvents", "runtime daemon client should prefer WebSocket events");
  assertIncludes(daemonClient, "readEventStream", "runtime daemon client should parse SSE events");
  assertIncludes(daemonClient, "/action", "runtime daemon client should call action endpoint");
  assertIncludes(daemonClient, "websocket_with_sse_fallback", "runtime daemon client contract should include event stream shape");
  assertIncludes(daemonClient, "daemon-info.json", "runtime daemon client should discover existing daemon-info");
  assertIncludes(daemonClient, "daemon-reused", "runtime daemon client should reuse a healthy existing daemon");
  assertIncludes(daemonClient, "startSupervisor", "runtime daemon client should supervise daemon health");
  assertIncludes(service, "userSettings: userSettingsFile", "runtime service should pass user preferences into the in-process cruise pipeline");
  assertIncludes(service, "buildRuntimeHostContext", "runtime service should build a shared host request runtime context");
  assertIncludes(service, "enrichHostRequestWithRuntimeContext", "runtime service should enrich every host request with runtime context");
  assertIncludes(service, "readLiveRankingsSummary", "runtime service should summarize live rankings for the host model");
  assertIncludes(service, "readSeasonCatalogSummary", "runtime service should summarize current-season catalog for the host model");
  assertIncludes(service, "hostRuntimeContextPolicy", "runtime service should centralize host context policy");
  assertIncludes(service, "jcc-runtime-host-context-policy-contract-v1", "runtime service should identify the host context policy contract");
  assertIncludes(service, "resolveRuntimeContextPolicy", "runtime service should choose context by mode and user intent");
  assertIncludes(service, "textNeedsStrategyContext", "runtime service should detect strategy questions before loading heavier context");
  assertIncludes(service, "textNeedsRankingContext", "runtime service should distinguish preference context from ranking context");
  assertIncludes(service, "textNeedsSeasonCatalogContext", "runtime service should detect lineup/champion questions before loading season catalog");
  assertIncludes(service, "minimal_runtime_context_only", "runtime service should avoid loading strategy context for non-strategy prompts");
  assertIncludes(service, "mode_or_user_message_needs_strategy_context", "runtime service should explain why strategy context was attached");
  assertIncludes(service, "user_preferences: hostRequest?.user_preferences", "host request summary must expose user preferences to the host model");
  assertIncludes(service, "compactDailyRankingMetaMap", "the provider-session capsule must expose a compact current-day ranking map");
  assertIncludes(service, "selected_ranking_candidates", "each strategy turn must expose only query-selected ranking evidence");
  assertIncludes(service, "season_catalog: hostRequest?.season_catalog", "host request summary must expose current-season catalog to the host model");
  assertIncludes(service, "rank_tier", "host runtime context must include rank tier");
  assertIncludes(service, "stat_date", "host runtime context must include live ranking stat date");
  assertIncludes(service, "top_lineups", "host runtime context should include compact lineup signals");
  assert(!service.includes("child_process\"") || service.includes("import { spawn } from \"node:child_process\""), "runtime service may import child_process only for spawn");
  assert(!service.includes("import { exec") && !service.includes("execFile("), "runtime service must not use child_process exec/execFile");
  assert(!service.includes("powershell"), "runtime service must not route through PowerShell");
  assert(!service.includes("Set-Content"), "runtime service must not use PowerShell Set-Content");
  assertIncludes(service, "final_text", "runtime service should return host final_text as the visible answer");
  assertIncludes(service, "normalizeHostCoachResponse", "runtime service should normalize host CLI provenance at the adapter boundary");
  assertIncludes(service, "hostRequest?.response_id", "runtime service should map advice response_id to host request_id");
  assertIncludes(service, "hostRequest?.host_cli_agent_request?.request_id", "runtime service should map nested host_cli_agent_request ids");
  assertIncludes(service, "completePendingHostCoach(pending, codexResult.response, taskId, pipelineFile, hostRequest", "message host coach completion must validate against the active pipeline file and enriched runtime-context request");
  assertIncludes(service, "completePendingHostCoach(pending, codexResult.response, taskId, outFile, enrichedRequest", "cruise host coach completion must validate against the autopoll pipeline file and enriched runtime-context request");
  assertIncludes(service, "isCurrent: () => responseTaskStillOwnedAtRevision(owner)", "message host coach completion must guard latest-response publication with the captured response-task revision");
  assertIncludes(service, "isCurrent: () => responseTaskStillOwnedAtRevision(owner)", "runtime-event host coach completion must guard latest-response publication with task ownership and revision");
  assertIncludes(service, "request_source: \"enriched_runtime_context_request_event\"", "host coach completion should record when final validation used the enriched runtime-context request event");
  assertIncludes(service, "pinned_result", "host prompt should require structured pinned_result for lineup boards");
  assert(!service.includes("finishOpponentScan"), "runtime service must not expose removed opponent scan completion");
  assert(!service.includes("recordOpponentSnapshot"), "runtime service must not expose removed opponent snapshot capture");
  assert(!service.includes("response_draft.summary"), "runtime service must not promote response_draft.summary as visible text");
}

async function verifyModeMap() {
  const bridge = await text("ui/src/runtimeBridge.ts");
  const modeContract = JSON.parse(await text("data/runtime/jcc/runtime-ui-mode-contract.json"));
  assertIncludes(bridge, "RuntimeEvent", "runtime bridge should type daemon events");
  assertIncludes(bridge, "onRuntimeEvent?", "runtime bridge should expose optional runtime event subscription");
  assertIncludes(bridge, "runtime-ui-mode-contract.json", "runtime bridge should consume the canonical renderer mode contract");
  assertIncludes(bridge, "resolveAvailableMatchModes", "runtime bridge should resolve active-season renderer modes");
  assertIncludes(bridge, "Object.fromEntries(", "runtimeBridge mode map should be generated from the contract");
  const service = await text("ui/electron/runtime-service.js");
  for (const [uiMode, runtimeMode] of Object.entries(REQUIRED_UI_MODES)) {
    if (["chat", "prefs", "wiki", "review"].includes(uiMode)) {
      assertIncludes(bridge, `${uiMode}: "${runtimeMode}"`, "runtimeBridge daily mode map");
    }
    assertIncludes(service, `${uiMode}: "${runtimeMode}"`, "runtime-service invariant mode map");
  }
  for (const [backendMode, definition] of Object.entries(modeContract.modes || {})) {
    if (!definition?.renderer?.visible_in_match_rail) continue;
    assert(definition.renderer.ui_mode_key, `${backendMode} renderer mode must declare ui_mode_key`);
  }
  assertIncludes(service, "uiToRuntimeMode[contract.ui_mode_key] = contract.mode", "runtime service should register choice UI modes from active rule descriptors");
  assertIncludes(service, "refreshChoiceRuntimeModeSets(activeRulesBundle)", "runtime service should activate descriptor-driven choice modes");
  assert(!bridge.includes('scan: "opponent_power"'), "runtimeBridge must not map scan to removed opponent_power mode");
  assert(!bridge.includes('position: "opponent_positioning"'), "runtimeBridge must not map position to removed opponent_positioning mode");
  assert(!service.includes('scan: "opponent_power"'), "runtime-service must not map scan to removed opponent_power mode");
  assert(!service.includes('position: "opponent_positioning"'), "runtime-service must not map position to removed opponent_positioning mode");
}

async function verifyRendererCallsBridge() {
  const app = await text("ui/src/App.tsx");
  const bridge = await text("ui/src/runtimeBridge.ts");
  for (const method of [
    "runtime.bootstrap()",
    "runtime.detectHostCli(",
    "runtime.connectMumu()",
    "runtime.startMatch()",
    "runtime.stopMatch()",
    "runtime.setMode(",
    "runtime.sendMessage(",
    "runtime.stopResponse({",
    "runtime.getManualVariableOptions()",
    "runtime.saveManualVariables(",
    "runtime.saveRuntimeSettings(",
    "runtime.updateRankings()",
    "runtime.pollCruiseAdvice()",
    "runtime.resetDailySession()",
    "runtime.minimizeWindow()",
    "runtime.closeWindow()",
  ]) {
    assertIncludes(app, method, "App runtime bridge calls");
  }
  assertIncludes(bridge, "updateRankings():", "runtime bridge must expose the rankings update action");
  assert(!bridge.includes("DailyIntelligence") && !bridge.includes("daily_intelligence"), "runtime bridge must not model Daily Intelligence tasks");
  assertIncludes(app, "const startMatchInFlightRef = useRef(false)", "Start Match renderer delivery gate");
  assertIncludes(app, "await runtimeReconcileDrainRef.current?.whenIdle()", "Start Match must drain any prior canonical reconcile before resetting the match stream");
  assertIncludes(app, "if (startMatchInFlightRef.current) return false", "canonical delivery must remain unacknowledged while Start Match initializes the new stream");
  assertIncludes(app, "deliveredCoachResponseKeysRef.current.clear();\n        setLineupPlan(null)", "Start Match must clear delivery keys after replacing initial messages so canonical advice can replay once");
  assertIncludes(app, "const matchCreated = result.match_created === true", "renderer must distinguish canonical match creation from degraded readiness");
  assertIncludes(bridge, "export type StartMatchResult", "runtime bridge must type Start Match creation and readiness separately");
  assertIncludes(bridge, "match_created: true", "browser preview Start Match must satisfy the canonical creation gate");
  assertIncludes(bridge, "watcher_ready: true", "browser preview Start Match must expose watcher readiness");
  assertIncludes(bridge, "host_ready: true", "browser preview Start Match must expose Host readiness");
  assertIncludes(app, "\u8d85\u9ad8\uff1a\u6df1\u5ea6\u5c40\u9762/\u590d\u76d8", "App xhigh reasoning label");
  assertIncludes(app, "\u6700\u9ad8\uff1a\u91cd\u8981\u7b56\u7565\u51b3\u7b56", "App max reasoning label");
  assertIncludes(app, "Ultra\uff1a\u6700\u5f3a\u601d\u8003\uff08\u6162\uff09", "App ultra reasoning label");
  assert(!app.includes("modelReasoningLevelsHint"), "App must not synthesize reasoning levels from model-name regexes");
  assertIncludes(bridge, "\u8d85\u9ad8\uff1a\u6df1\u5ea6\u5c40\u9762/\u590d\u76d8", "runtime bridge xhigh reasoning label");
  assertIncludes(bridge, "\u6700\u9ad8\uff1a\u91cd\u8981\u7b56\u7565\u51b3\u7b56", "runtime bridge max reasoning label");
  assertIncludes(bridge, "Ultra\uff1a\u6700\u5f3a\u601d\u8003\uff08\u6162\uff09", "runtime bridge ultra reasoning label");
  assertIncludes(app, "\u62a5\u5237\u65b0\u7ed3\u679c", "App refresh-result prefill chip");
  assertIncludes(app, "prefillPreset(refreshReportPrompt);", "App refresh-result chip should prefill the descriptor-backed composer prompt");
  assert(!app.includes("runtime.requestAugmentReroll()"), "App must not auto-run backend augment reroll from the composer");
  assert(!app.includes("记录当前家"), "App must not expose removed opponent snapshot button");
  assert(!app.includes("完成扫描"), "App must not expose removed opponent scan completion button");
  assertIncludes(app, "const [dailyMessages", "App must keep daily chat messages separate");
  assertIncludes(app, "const [matchMessages", "App must keep match chat messages separate");
  assertIncludes(app, "const visibleMessages = matchActive ? matchMessages : dailyMessages", "App chat session isolation");
  assertIncludes(app, "开启新对话", "App should expose /new-style daily session reset");
  assertIncludes(app, "handleResetDailySession", "App should wire daily session reset");
  assertIncludes(app, "lineupPlan={lineupPlan}", "App pinned lineup plan must come from runtime state");
  assertIncludes(app, "pinnedPlanFromResponse", "App should convert host pinned_result into a mechanical pinned card");
  assertIncludes(app, "applyPinnedResult(response, options.stream)", "App should apply pinned_result through the unified coach response renderer and preserve its delivery stream");
  assertIncludes(app, "plan.moves && plan.moves.length > 0", "App pinned card should render move lists from runtime pinned_result");
  assertIncludes(app, "const emitCoachResponse = (", "App should centralize visible host coach rendering");
  assertIncludes(app, "emitCoachResponse(result.response,", "App should surface host coach responses returned by runtime actions");
  assert(!app.includes("onGodRewardChoice"), "App must not wire removed god reward 3-choice button");
  assert(!app.includes("星神二选一"), "App must source season-specific choice labels from the mode contract");
  assertIncludes(app, "mode?.primaryPresets.map", "App should render season-specific presets from the active mode descriptor");
  assertIncludes(app, "prefillPreset(mode?.primaryPresets[0]?.prompt || currentPrompt)", "User-report modes should prefill the contract-provided report template without sending it");
  assertIncludes(app, "preset.description", "App should expose contract-provided explanations for professional presets");
  assert(!app.includes("const economyQuestionPreset"), "App must not hardcode cruise professional presets outside the mode contract");
  assert(!app.includes("const rankingLineupPreset"), "App must not hardcode ranking presets outside the mode contract");
  assertIncludes(app, "manualVariablesFromRuntime(state.manual_match_variables, seasonVariableFields)", "App should hydrate confirmed manual variables through the active season descriptor");
  assertMatches(
    app,
    /manualVariablesFromRuntime\(\s*result\.variables \|\| result\.state\?\.manual_match_variables,\s*seasonVariableFields,\s*\)/,
    "App should refresh the pinned variable card from backend canonical variables through the active season descriptor",
  );
  assert(!app.includes("setConfirmedManualVariables(payload);"), "App must not optimistically confirm manual variables before backend persistence succeeds");
  assertIncludes(app, "variablesMatchCurrentSession", "App should not hydrate stale manual variables from a previous match");
  assertIncludes(app, "state.match_session?.status === \"active\"", "App should clear the pinned manual-variable card when the active match state has no variables");
  assertIncludes(app, "state.match_session?.ui_ready !== false", "App should not expose Match interaction before Host bootstrap is ready");
  assertIncludes(app, "setActiveView(\"variables\")", "App should keep the confirmed manual variables visible in the pinned card");
  assertMatches(
    app,
    /if \(matchCreated\) \{[\s\S]{0,1800}setActiveMode\("cruise"\);[\s\S]{0,1800}setPinnedPanelOpen\(true\);[\s\S]{0,200}setActiveView\("variables"\);/,
    "Start Match should stay in cruise while opening the variables card",
  );
  assert(!app.includes("text.includes(\"??\")"), "App must not infer augment reroll from mojibake text");
  assertIncludes(app, "runtime.onRuntimeEvent", "App should consume daemon runtime events instead of relying on polling for detached responses");
  assertIncludes(app, "createRuntimeReconcileDrain", "App should use one sequence-aware reconcile drain for events and watchdogs");
  assertIncludes(app, "runtimeReconcileHandlerRef.current", "App event subscription should call the latest reconcile handler instead of capturing initial renderer state");
  assertIncludes(app, "renderer mounted canonical reconcile", "App mount should reconcile already-completed canonical responses");
  assertIncludes(app, "bootstrap canonical reconcile", "App bootstrap should reconcile already-completed canonical responses");
  assertIncludes(app, "reconcileCanonicalRuntimeDelivery", "App should use canonical getState-deliver-render-ACK delivery");
  assertIncludes(app, "responseTaskDeliveryDecision", "App should route responses from response-task session and backend mode");
  assert(!app.includes("if (cancelled || reconcileInFlight) return"), "App must not drop runtime events while reconcile is busy");
  assert(!app.includes("let reconcileInFlight = false"), "App must not keep the old drop-on-busy event lock");
  assertIncludes(app, "watcher_observation", "App should run the semantic observer when a new watcher source revision is committed");
  assertIncludes(app, "window.setInterval(tick, 30000)", "App should keep only a 30-second reconciliation watchdog");
  assertIncludes(app, "response_task_revision", "App response acknowledgement must include the exact response task revision");
  assertIncludes(app, "response_task_revision: taskRevision", "App Stop request must include the exact response-task revision");
  assertIncludes(app, "discarded pre-Stop send result canonical reconcile", "App must canonical-reconcile instead of syncing a pre-Stop send result");
  assertIncludes(app, "if (!result.ok)", "App Stop handling must keep the response active when backend cancellation is rejected");
  assertIncludes(app, "manualModeLockRef", "App should keep manual visual modes from being overwritten by background cruise polling");
  for (const removedDeadAction of ["记住偏好", "复盘上一局", "检查策略冲突"]) {
    assert(!app.includes(removedDeadAction), `App must not render inert no-match action: ${removedDeadAction}`);
  }
  assertIncludes(app, "Date.now() + 120000", "App should hold manual mode focus long enough for the user to type and refresh choices");
  assertIncludes(app, "endManualChoiceFollowup", "App should explicitly end manual choice follow-up only after terminal user-visible completion");
  assertIncludes(app, "clearVisualFollowup();", "App should stop a no-choice follow-up without exiting the user's selected visual mode");
  assertIncludes(app, "endRef.current?.scrollIntoView", "App chat stream should auto-scroll to the newest message");
  assertIncludes(app, "deliveredCoachResponseKeysRef", "App should keep a bounded set of delivered coach response identities");
  assertIncludes(app, "rememberBoundedDeliveryKey", "App should de-dupe direct and canonical delivery even when hints interleave");
  assertIncludes(app, "uiModeFromBackendMode", "App should centralize contract-backed backend-to-UI mode mapping before applying manual mode focus rules");
  assertIncludes(app, "variableOptions={manualVariableOptions}", "App manual variables should come from active-season runtime data");
  assertIncludes(app, "setManualVariableOptions", "App should load manual variable options from runtime bridge");
  for (const staleDefault of [
    'useState("两个基础装备锻造器")',
    'useState("阿狸")',
    'useState("艾克")',
    'useState("女猎手")',
    'useState("三板甲剑魔一剑开天门")',
    'const godOptions = ["阿狸"',
    'const observerOptions =',
    'encounterAliases',
  ]) {
    assert(!app.includes(staleDefault), `App must not keep stale demo manual-variable default/list: ${staleDefault}`);
  }
  assertIncludes(app, "data-lineup-status={lineupStatus}", "App pinned card should expose its empty/pending/failed/stale semantic state");
  assertIncludes(app, "pinnedPanelShouldBeVisible", "Pinned result visibility should be independent from the selected pinned tab");
  assertIncludes(app, 'hidden={activeView !== "variables"}', "Pinned variables should remain mounted while the lineup tab is selected");
  assertIncludes(app, 'hidden={activeView !== "lineup"}', "Pinned lineup should remain mounted while the variables tab is selected");
  assertIncludes(app, "{plan ? (", "Pinned result must render lineup content only when a publishable plan exists");
  assertIncludes(app, "pinnedResultIsPublishable", "App should accept only backend-publishable lineup structures");
  assertIncludes(app, "setLineupStatus(\"pending\")", "A new lineup request should enter pending state without unmounting the pinned slot");
  assertIncludes(app, "继续保留上一张可用阵容", "Pending, failed, or stopped lineup requests should preserve the last published card");
  assertIncludes(app, "setLineupStatus(\"failed\")", "A failed lineup response should expose a visible failure state");
  assertIncludes(app, "setLineupStatus(\"stale\")", "Stopping a pending lineup request should mark the request stale");
  assertIncludes(app, "const previousMode = activeModeRef.current", "Match mode changes should retain rollback state");
  assertIncludes(app, "setActiveMode(previousMode)", "Failed match mode changes should roll back the optimistic UI mode");
  assertIncludes(app, "setDailyMode(previousMode)", "Failed daily mode changes should roll back the optimistic UI mode");
  assertIncludes(app, "推理强度", "Host CLI panel should expose reasoning effort selection");
  assertIncludes(app, "reasoningEffortOptionsForSelectedModel", "Host CLI panel should derive reasoning options from the selected CLI model catalog entry");
  assertIncludes(app, "runtimeState?.host_cli?.capabilities?.reasoning_effort_options", "Host CLI panel should prefer backend native reasoning capability hints");
  assertIncludes(app, "handleDetectHostCli", "Host CLI panel should wire detect-and-save action");
  assertIncludes(app, "Host CLI Agent", "Host CLI panel should be adapter-neutral in product labels");
  assertIncludes(app, "Kimi CLI 使用本机 OAuth 登录和 ACP 会话", "Host CLI panel should describe Kimi OAuth CLI and keep image transport capability-gated");
  assert(!app.includes("KIMI_API_KEY"), "Host CLI panel must not tell OAuth Kimi CLI users to configure a Kimi API key");
  assert(!app.includes("Kimi Vision API"), "Host CLI panel must not expose the optional HTTP Kimi file-id fallback as a normal host agent");
  assertIncludes(app, "display_name", "Host CLI panel should use generic display name when available");
  assertIncludes(app, "hostReasoning", "Host CLI panel should persist reasoning effort selection");
  assert(!app.includes('selectedHostProvider === "kimi" ? "default" : hostModel'), "Kimi detection must pass the user-selected model alias, not force default");
  assertIncludes(app, "const [rankTier", "User preferences should be controlled state");
  assertIncludes(app, "const [operationSpeed", "User preferences should be controlled state");
  assertIncludes(app, "const [defaultGoal", "User preferences should be controlled state");
  assertIncludes(app, "handleSaveUserPreferences", "User preferences should wire a real save action");
  assertIncludes(app, "用户偏好已保存", "User preferences compatibility save should remain available to runtime");
  assert(!app.includes('onSectionChange("prefs")'), "User preferences should not be exposed as a standalone menu section");
  assert(!app.includes('dailyMode === "prefs"'), "User preferences should not be exposed as a daily chat mode");
  assertIncludes(app, 'section === "diagnostics"', "Fault diagnostics should have a dedicated Settings section");
  assertIncludes(app, "故障诊断：OCR 截图与失败证据", "Settings should expose the fault-diagnostics entry directly");
  assertIncludes(app, "保留 OCR 与失败证据", "Fault diagnostics should explain the retained evidence");
  assertIncludes(app, "handleSaveRuntimeSettings", "Fault diagnostics should persist independently from strategy preferences");
  assertIncludes(app, "故障诊断已", "Fault diagnostics save should give visible feedback");
  assertIncludes(app, "const [previewClosed", "Browser preview should be able to hide the runtime panel");
  assertIncludes(app, "closed-preview", "Browser preview close should render a closed state");
  assertIncludes(app, "matchActive ? \"match-shell\" : \"daily-shell\"", "Daily and match shells should use different layout tracks");
  assert(!app.includes("response_draft"), "App must not render backend response_draft as final text");
  assert(!app.includes("latest_backend_draft"), "App must not render latest_backend_draft");
  assert(!app.includes("const positionUnits"), "App must not ship demo positioning units");
  assert(!app.includes("const lineupUnits"), "App must not ship demo lineup units");
  assertIncludes(app, "isRecoverableRuntimePollError", "App should classify recoverable background poll errors");
  assertIncludes(app, "isInternalHostPendingTimeout", "App should classify stale host coach pending timeouts as internal release state");
  assertIncludes(app, "isInternalRuntimeErrorText", "App should classify internal runtime error strings before rendering status text");
  assertIncludes(app, "userVisibleRuntimeErrorText", "App should sanitize backend runtime errors before displaying them");
  assertIncludes(app, "pipeline_failed", "App sanitizer should catch internal pipeline failure codes");
  assertIncludes(app, "visual_refresh_failed", "App sanitizer should catch internal visual refresh failure codes");
  assertIncludes(app, "host_coach_response_(?:preparing|pending|running)_timeout", "App sanitizer should catch stale host preparing/pending/running timeout codes");
  assertIncludes(app, "userVisibleHostFailureText", "App should map internal host errors to user-safe status text");
  assertIncludes(app, "userVisibleHostCliFailureText", "App should use a host-specific error sanitizer that preserves provider diagnostics");
  assertIncludes(app, "403|401|429|503|quota|usage limit|rate limit|login|auth|unauthorized|forbidden|provider", "Host-specific sanitizer should preserve provider status and quota/auth diagnostics");
  assertIncludes(app, "addHostFailureStatus", "App should de-duplicate host failure status messages across poll/delivery paths");
  assertIncludes(app, "host-failure:", "App should key host failure de-duplication by the backend error");
  assert(
    !/status\s*===\s*["']response_failed["'][\s\S]{0,220}addMessage\(\{\s*role:\s*["']status["'][\s\S]{0,120}userVisibleHostFailureText\(result\.error\)/.test(app),
    "App must not replay host failures without status de-duplication",
  );
  assert(!app.includes('text: result.error ?? "宿主 CLI Agent 回答失败。"'), "App must not directly show raw host coach errors in chat");
  assert(!app.includes("text: result.error ?? '宿主 CLI Agent 回答失败。'"), "App must not directly show raw host coach errors in chat");
  assert(!app.includes("addMessage({ role: \"status\", text: result.error ??"), "App must not directly show raw backend errors in status messages");
  assert(!app.includes("addDedupedStatus(`auto-poll-error:${error}`, error"), "App must not directly show raw cruise poll errors in chat");
  assertIncludes(app, "addDedupedStatus", "App should de-duplicate background runtime status messages");
  assertIncludes(app, "巡航观察暂时失败；我会继续监听，不会重复请求模型。", "App should not spam raw internal poll errors into chat");
  assert(!app.includes("text: result.error ?? \"巡航轮询失败。\""), "App must not directly show raw cruise poll errors on the background loop");
  assertIncludes(bridge, "preview_noop", "Browser preview close should report no-op instead of pretending to close");
  const styles = await text("ui/src/styles.css");
  assertIncludes(styles, ".daily-shell", "Daily shell layout should not reserve match-only tracks");
  assertIncludes(styles, ".match-shell", "Match shell layout should reserve mode and pinned tracks");
}

async function verifyDailyContextPacks() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "jcc-ui-context-pack-"));
  try {
    for (const mode of ["daily_chat", "postgame_review", "user_preferences", "strategy_wiki"]) {
      const pack = await buildPack({ scope: "mode", mode, outDir: temp });
      assert(pack.mode_id === mode, `daily mode context pack should build without match session: ${mode}`);
      assert(pack.match_session_id === null, `daily mode context pack must not invent match_session_id: ${mode}`);
      assert(pack.strategy_data_sources?.hard_data?.manifest, `context pack must declare hard-data source: ${mode}`);
      assert(pack.strategy_data_sources?.daily_big_data?.rank_signal, `context pack must declare daily big-data source: ${mode}`);
      assert(pack.strategy_data_sources?.runtime_estimators?.includes("tools/run-jcc-cruise-runtime-pipeline.mjs"), `context pack must declare runtime estimator pipeline: ${mode}`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function verifyHostContextPolicyContract() {
  const contract = JSON.parse(await text("data/runtime/jcc/host-request-context-policy-contract.json"));
  assert(contract.schema === "jcc-runtime-host-context-policy-contract-v1", "host context policy contract schema");
  assert(contract.user_preferences_policy.attach_when_modes.includes("augment_choice"), "policy should attach preferences in augment mode");
  assert(contract.daily_big_data_policy.attach_when_modes.includes("augment_choice"), "policy should attach rankings in augment mode");
  assert(contract.season_catalog_policy.attach_when_modes.includes("augment_choice"), "policy should attach season catalog in augment mode");
  assert(!contract.daily_big_data_policy.attach_when_modes.includes("user_preferences"), "policy should not attach rankings for pure preferences mode by default");
  assert(contract.strategy_intent_keywords.includes("上分"), "policy should trigger strategy context for ranking climb questions");
  assert(contract.ranking_intent_keywords.includes("上分"), "policy should trigger ranking context for ranking climb questions");
  assert(contract.season_catalog_intent_keywords.includes("阵容"), "policy should trigger season catalog for lineup questions");
  assert(contract.season_catalog_policy.forbid_old_season_invention === true, "policy should forbid old-season champion invention");
  assert(!contract.ranking_intent_keywords.includes("偏好"), "policy should not attach rankings just because the user edits preferences");
  assert(contract.required_runtime_reason_values.includes("minimal_runtime_context_only"), "policy should support minimal context reason");
}

async function main() {
  await verifyElectronBoundary();
  await verifyCleanWindowCloseBehavior();
  await verifyModeMap();
  await verifyRendererCallsBridge();
  await verifyDailyContextPacks();
  await verifyHostContextPolicyContract();
  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-ui-runtime-bridge-verification-v1",
    checks: [
      "electron_ipc_boundary",
      "clean_window_close_behavior",
      "mode_mapping_complete",
      "renderer_calls_bridge",
      "mode_action_buttons_call_backend",
      "daily_context_pack_without_match",
      "no_backend_draft_rendered_as_final_text",
      "daily_and_match_chat_are_isolated",
      "pinned_cards_require_real_runtime_plan",
      "host_agent_reasoning_effort_selector_present",
      "host_agent_reasoning_effort_options_are_model_capability_aware",
      "host_context_pack_declares_hard_data_and_daily_big_data",
      "browser_preview_close_is_noop",
      "browser_preview_can_hide_runtime_panel",
      "daily_shell_does_not_reserve_match_tracks",
      "host_request_context_policy_is_contract_backed",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
