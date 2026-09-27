import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import {
  collectRuntimeChoiceModeContracts,
  loadActiveRulesBundle,
} from "./jcc_active_rules_contract.mjs";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const activeRuntimePaths = createRuntimePaths(root);
const activeRulesBundle = loadActiveRulesBundle({ repoRoot: root, runtimePaths: activeRuntimePaths });
const activeCoreProfileSnapshot = createActiveCoreProfileSnapshot(root, {
  runtimePaths: activeRuntimePaths,
});

function activeMatchSession(matchSessionId, extra = {}) {
  return {
    status: "active",
    match_session_id: matchSessionId,
    season_version_snapshot: structuredClone(activeCoreProfileSnapshot),
    ...extra,
  };
}

async function readText(file) {
  return readFile(path.join(root, file), "utf8");
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runNode(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += `\nnode child timed out after ${timeoutMs}ms: ${args.join(" ")}`;
      child.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message || String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function fileUrl(file, tag) {
  return `${pathToFileURL(path.resolve(root, file)).href}?${tag}`;
}

async function importRuntimeServiceUtility(label) {
  return import(fileUrl("ui/electron/runtime-service.js", `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`));
}

async function rmRecursiveWithRetry(target, attempts = 8) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100 + index * 75));
    }
  }
  throw lastError;
}

async function withRuntimeEnv(fn) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-start-match-symptom-"));
  const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  const previousDataDir = process.env.JCC_RUNTIME_DATA_DIR;
  const previousDisableSelfStateWorker = process.env.JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR;
  const previousStageOcrTimeout = process.env.JCC_UI_STAGE_SELF_STATE_ROI_OCR_TIMEOUT_MS;
  const previousSelfStateOcrTimeout = process.env.JCC_UI_SELF_STATE_ROI_OCR_TIMEOUT_MS;
  process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
  process.env.JCC_RUNTIME_DATA_DIR = tempRoot;
  process.env.JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR = "1";
  process.env.JCC_UI_STAGE_SELF_STATE_ROI_OCR_TIMEOUT_MS = "200";
  process.env.JCC_UI_SELF_STATE_ROI_OCR_TIMEOUT_MS = "200";
  try {
    return await fn(tempRoot);
  } finally {
    if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
    if (previousDataDir === undefined) delete process.env.JCC_RUNTIME_DATA_DIR;
    else process.env.JCC_RUNTIME_DATA_DIR = previousDataDir;
    if (previousDisableSelfStateWorker === undefined) delete process.env.JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR;
    else process.env.JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR = previousDisableSelfStateWorker;
    if (previousStageOcrTimeout === undefined) delete process.env.JCC_UI_STAGE_SELF_STATE_ROI_OCR_TIMEOUT_MS;
    else process.env.JCC_UI_STAGE_SELF_STATE_ROI_OCR_TIMEOUT_MS = previousStageOcrTimeout;
    if (previousSelfStateOcrTimeout === undefined) delete process.env.JCC_UI_SELF_STATE_ROI_OCR_TIMEOUT_MS;
    else process.env.JCC_UI_SELF_STATE_ROI_OCR_TIMEOUT_MS = previousSelfStateOcrTimeout;
    await rmRecursiveWithRetry(tempRoot);
  }
}

async function verifyStartMatchDoesNotPretendLiveCruise() {
  const app = await readText("ui/src/App.tsx");
  const service = await readText("ui/electron/runtime-service.js");
  assert(app.includes("正在等待游戏状态"), "Start Match UI must say it is waiting for real game state, not claim live cruise immediately");
  assert(app.includes("接入这把游戏后会自动进入巡航"), "Start Match UI must tell user cruise starts after game attach");
  assert(app.includes("已接入这把游戏，进入事件巡航"), "UI must announce real game attachment when match_connection becomes connected");
  assert(app.includes("实时监听已启动，但还没收到这局的游戏状态"), "UI must surface no-live-state watcher diagnostics instead of staying silent");
  assert(app.includes("liveMatchNoticeRef"), "live game attachment notice must be de-duplicated per match session");
  assert(app.includes("waiting_for_current_match_live_state"), "UI must surface stale/old live_state rejection instead of staying silent");
  assert(app.includes("已忽略上一局的旧状态"), "UI must explain that an old match live_state was ignored");
  assert(app.includes("shouldSuppressChoiceFollowupNoise"), "manual choice modes must suppress recoverable background reconciliation noise through the shared delivery guard");
  assert(app.includes("response_task_changed") && app.includes("watcher_observation") && app.includes("daemon_reconnected"), "renderer must react to durable daemon events instead of a 5-second cruise advice loop");
  assert(app.includes("window.setInterval(tick, 30000)"), "renderer polling must remain only a low-frequency canonical reconciliation watchdog");
  assert(service.includes("const adbSerial = typeof adbTarget === \"string\" ? adbTarget : adbTarget?.serial || null"), "Start Match must normalize string/object MuMu targets before starting watcher");
  assert(service.includes("if (adbSerial) args.push(\"--device\", adbSerial);"), "Start Match must pass the user-bound MuMu ADB target to watcher instead of rediscovering or waiting on a wrong instance");
  assert(service.includes("status: \"watcher_failed\""), "Start Match must expose watcher startup failures instead of reporting a healthy match");
  assert(service.includes("last_watcher_stdout"), "runtime service must retain watcher stdout for discovery/live-state diagnostics");
  assert(service.includes("watcher: state.watcher || null"), "no_live_state responses must include watcher state for UI diagnostics");
  assert(service.includes("readWatcherServiceState()"), "Start Match must wait for watcher service-state instead of declaring running after a fixed sleep");
  assert(service.includes("JCC_UI_WATCHER_READY_TIMEOUT_MS || 12000"), "watcher readiness must allow ADB cold start after reboot");
  assert(service.includes("JCC_UI_WATCHER_DISCOVERY_TIMEOUT_MS || 8000"), "watcher discovery must use a longer timeout than the generic fast discovery path");
  assert(service.includes("syncWatcherServiceState(\"poll_cruise_advice\")"), "cruise polling must sync wrapper service-state after discovery/startup");
  assert(service.includes("[\"discovering\", \"starting\", \"ready\"].includes(serviceState.status)"), "watcher readiness must accept the wrapper's discovering/starting/ready states");
  assert(service.includes("repairStaleWatcherProcess(\"poll_cruise_advice\")"), "cruise polling must downgrade stale persisted watcher PIDs that are no longer alive");
  assert(service.includes("clearBootstrapOnlyWatcherFailure"), "bootstrap must clear old watcher startup failures that never produced live_state/service-state");
  assert(service.includes("bootstrap_watcher_failed_without_service_state_or_live_state"), "old startup-only watcher failures must be diagnosable after bootstrap clears them");
  assert(!service.includes("recordUserChoiceConfirmationFromMessage(text, requestedMode, preMessageLiveState)"), "ordinary chat must not write augment or active-season final selections");
  assert(service.includes("recordMatchUserMessageContext(text, requestedMode, preMessageLiveState"), "ordinary match chat should still update current user intent for its one direct answer");
  assert(service.includes("has_economy: hasEconomyLiveEvidence(liveStateSummary.economy)"), "match evidence must not treat empty economy shells as valid gold/hp data");
  assert(service.includes("mergeMatchContextIntoLiveStateSummary(rawLiveStateSummary, matchContext)"), "host requests must merge current match_context into live_state_summary so confirmed variables reach the model");
  assert(service.includes("function normalizeLiveStateSummaryShape"), "host live_state_summary must normalize flat HUD fields into phase/economy JSON before model context is built");
  assert(service.includes("normalized.phase ="), "host live_state_summary must always expose phase.stage_round when a stage is known");
  assert(
    service.includes('economy.hp = normalizeSelfStateEconomyField("hp", firstUsefulValue(economy.hp, normalized.hp))')
      && service.includes("economy.gold = firstUsefulValue(economy.gold, normalized.gold)")
      && service.includes("economy.level = firstUsefulValue(economy.level, normalized.level)")
      && service.includes("economy.xp = firstUsefulValue(economy.xp, normalized.xp)"),
    "host live_state_summary must expose known economy fields while rejecting invalid active-match HP",
  );
  assert(!service.includes("normalized.board?.board_units"), "host live_state_summary must not promote generic board.board_units into own_board.units without the S=1 + 4354 shop anchor");
  assert(service.includes("normalized.bench?.bench_units"), "host live_state_summary must normalize watcher bench.bench_units into own_bench.units");
  assert(service.includes("normalized.shop?.shop_units"), "host live_state_summary must normalize watcher shop.shop_units into shop.units");
  assert(service.includes("strategy_fit_packet: cruiseDecisionContext?.strategy_fit_packet"), "strategy_fit_packet must be a first-class runtime_context field, not hidden only inside cruise_decision_context");
  assert(service.includes("function runtimeEventIsDurableContextUpdate"), "runtime events must separate durable match facts from stage-local advice");
  assert(service.includes('event?.decision_trigger_id === "lineup_convergence_checkpoint"'), "durable facts and the canonical lineup-convergence obligation may be retried after user-priority work");
  assert(service.includes('type: "match_variables_changed"') && service.includes('response_policy: "context_only"'), "match variables must remain context-only until the first 2-1 user-owned answer");
  assert(service.includes("runtimeEventAdviceRetryWindowMs(retry.event)"), "important blocked semantic events must not expire on the generic short retry window");
  assert(!service.includes("preemptActiveRuntimeEventResponseTask(\"manual_match_variables_confirmed\""), "manual variable confirmation must not create or preempt an answer owner");
  assert(service.includes("preemptActiveRuntimeEventResponseTask(\"user_message_received\""), "user messages must preempt low-priority runtime event responses before starting their own path");
  assert(!service.includes("requeueRuntimeEventAdvice(event, \"manual_match_variables_confirmed\")"), "manual variable confirmation must not enqueue a separate opening answer");
  assert(service.includes("`match_variables:${matchVariablesHash.slice(0, 12)}`"), "manual variables and the semantic detector must share one content-addressed event key");
  assert(service.includes("runtimeEventShouldRequeueAfterUserPriority(event)"), "only durable context events dropped behind a user/manual task should be retried");
  assert((service.match(/runtimeEventShouldRequeueAfterUserPriority\(event\)/g) || []).length >= 2, "stage-local runtime advice dropped behind user priority must not reappear at a later stage");
  assert(service.includes("\"awaiting_host_cli_agent_response\", \"response_pending\""), "runtime event advice reconcile must include host-pending handled states, not only running states");
  assert(service.includes("timeoutMs = hostCoachResponseTimeoutMs(state.response_task)"), "host adapter timeout must be aligned to the runtime response-task timeout contract");
  const startWatcher = await readText("tools/start-jcc-mumu-runtime-watch.mjs");
  assert(startWatcher.includes("status: \"discovering\""), "watcher wrapper must write service-state before slow discovery can trip UI readiness timeout");
  assert(startWatcher.includes("requested_device_health_checked"), "watcher wrapper must prefer the user-bound serial when it is healthy");
}

async function verifyManualVariablesPersistToPinnedCard() {
  const app = await readText("ui/src/App.tsx");
  const service = await readText("ui/electron/runtime-service.js");
  const bridge = await readText("ui/src/runtimeBridge.ts");
  assert(app.includes("manualVariablesFromRuntime"), "UI must map canonical runtime manual variables into pinned card payload");
  assert(
    /manualVariablesFromRuntime\(\s*result\.variables \|\| result\.state\?\.manual_match_variables,\s*seasonVariableFields,\s*\)/.test(app),
    "variable confirmation must refresh pinned card from backend canonical variables through the active season descriptor",
  );
  assert(app.includes("setActiveMode(\"cruise\")"), "variable confirmation should return the match UI to cruise mode");
  assert(service.includes("state.manual_match_variables = variables"), "runtime service must persist manual variables in state");
  assert(service.includes("writeMatchContextFromManualVariables"), "runtime service must write match context from confirmed variables");
  assert(bridge.includes("variables?: RuntimeState[\"manual_match_variables\"]"), "runtime bridge must expose canonical saved variables");
}

async function verifyUserReportedChoiceProductionBoundary() {
  const service = await readText("ui/electron/runtime-service.js");
  const app = await readText("ui/src/App.tsx");
  const contracts = collectRuntimeChoiceModeContracts(activeRulesBundle);
  const byMode = new Map(contracts.map((contract) => [contract.mode, contract]));

  for (const mode of ["augment_choice", "item_choice"]) {
    const contract = byMode.get(mode);
    assert(contract, `active choice contract missing ${mode}`);
  }
  const userReportedContracts = contracts.filter((contract) => contract.candidate_input_policy === "current_match_user_report");
  assert(userReportedContracts.length >= 2, "active rules must expose the registered common user-report choice contracts");
  for (const contract of userReportedContracts) {
    const { mode } = contract;
    assert.equal(contract.candidate_input_policy, "current_match_user_report", `${mode} candidates must come from current-match user reports`);
    assert.equal(contract.user_report_contract?.no_ocr_or_vision_fallback, true, `${mode} must explicitly disable OCR/vision fallback`);
    assert(String(contract.user_report_contract?.report_prompt || "").trim(), `${mode} must provide a report prompt`);
    assert(String(contract.user_report_contract?.refresh_report_prefix || "").trim(), `${mode} must provide a refresh-report prefix`);
  }

  for (const choiceOcrModule of [
    "run-jcc-augment-choice-roi-ocr.mjs",
    "run-jcc-god-choice-roi-ocr.mjs",
    "run-jcc-item-choice-roi-ocr.mjs",
  ]) {
    assert(!service.includes(`from \"../../tools/${choiceOcrModule}\"`), `production runtime must not import calibration-only ${choiceOcrModule}`);
  }
  const refreshModeSets = service.slice(
    service.indexOf("function refreshChoiceRuntimeModeSets"),
    service.indexOf("refreshChoiceRuntimeModeSets(activeRulesBundle);"),
  );
  assert(refreshModeSets.includes("manualReportChoiceRuntimeModes.add(contract.mode)"), "active user-report modes must enter the manual-report set");
  assert(!refreshModeSets.includes("choiceVisualRuntimeModes.add"), "active user-report modes must not enter the visual mode set");
  assert(!refreshModeSets.includes("fastTextChoiceRuntimeModes.add"), "active user-report modes must not enter the RapidOCR mode set");
  assert(service.includes("function choiceOcrWorkerAdapter"), "production runtime must retain an explicit compatibility fence for legacy callers");
  const choiceAdapter = service.slice(
    service.indexOf("function choiceOcrWorkerAdapter"),
    service.indexOf("function itemChoiceKindForOcrWorker"),
  );
  assert(choiceAdapter.includes("return null;"), "production choice OCR adapter must be hard-disabled");
  assert(!choiceAdapter.includes("run_attempt"), "production choice OCR adapter must not expose calibration runners");
  assert(app.includes("prefillPreset(refreshReportPrompt);"), "refresh-result controls must prefill the report composer");
  assert(!app.includes("sendPreset(refreshReportPrompt)"), "refresh-result controls must not auto-send an incomplete user report");
}

async function verifyRetiredChoiceCalibrationFailsClosed() {
  await withRuntimeEnv(async (tempRoot) => {
    const watchDir = path.join(tempRoot, "watch");
    const outDir = path.join(tempRoot, "visual-out");
    await mkdir(watchDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    const fixtureImage = path.join(tempRoot, "frame.png");
    await writeFile(fixtureImage, "not-a-real-image-fixture", "utf8");
    await writeJson(path.join(watchDir, "cruise-live-state.json"), {
      schema: "verify-live-state",
      match_session_id: "verify-match",
      phase: { stage_round: "2-4", status: "choice" },
    });
    await writeJson(path.join(watchDir, "pending-visual-requests.json"), {
      schema: "jcc-runtime-pending-visual-requests-v1",
      match_session_id: "verify-match",
      pending: [
        {
          request_id: "visual:verify-match:augment_choice:old",
          mode: "augment_choice",
          match_session_id: "verify-match",
          compatibility_calibration: true,
          queued_at: "2026-06-21T00:00:00.000Z",
          fields: ["augments.choices"],
          capture_policy: { first_capture_delay_ms: 0 },
        },
        {
          request_id: "visual:verify-match:legacy_choice_calibration:new",
          mode: "legacy_choice_calibration",
          match_session_id: "verify-match",
          compatibility_calibration: true,
          queued_at: "2026-06-21T00:00:01.000Z",
          fields: ["choices.legacy_choice_options"],
          capture_policy: { first_capture_delay_ms: 0 },
        },
      ],
    });

    const rejected = await runNode([
      "tools/run-jcc-pending-visual-request.mjs",
      "--watch-dir", watchDir,
      "--out-dir", outDir,
      "--request-id", "visual:verify-match:legacy_choice_calibration:new",
      "--fixture-image", fixtureImage,
    ]);
    assert.notEqual(rejected.code, 0, "choice visual compatibility work must reject invocations without explicit calibration capability");
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /calibration-only/i);

    const explicitlyMarkedLegacyRequest = await runNode([
      "tools/run-jcc-pending-visual-request.mjs",
      "--watch-dir", watchDir,
      "--out-dir", outDir,
      "--request-id", "visual:verify-match:legacy_choice_calibration:new",
      "--fixture-image", fixtureImage,
      "--compatibility-calibration",
    ]);
    assert.notEqual(explicitlyMarkedLegacyRequest.code, 0, "retired legacy choice calibration must remain unavailable even when a caller supplies the old compatibility flag");
    assert.match(
      `${explicitlyMarkedLegacyRequest.stdout}\n${explicitlyMarkedLegacyRequest.stderr}`,
      /Unsupported --mode legacy_choice_calibration/,
      "retired legacy calibration must fail at the registered-mode boundary",
    );

    const requestHelper = await readText("tools/request-jcc-choice-visual-refresh.mjs");
    const pendingRunner = await readText("tools/run-jcc-pending-visual-request.mjs");
    assert(requestHelper.includes("--compatibility-calibration"), "choice visual request helper must require explicit calibration capability");
    assert(requestHelper.includes("do_not_promote_choice_candidates"), "calibration artifacts must prohibit candidate promotion");
    assert(pendingRunner.includes("request?.compatibility_calibration !== true"), "pending runner must reject unmarked legacy choice requests");
    assert(!pendingRunner.includes("legacy_choice_calibration"), "pending visual runner must not register the retired legacy choice mode");
  });
}

async function verifyChoiceWindowsStayObserveOnlyAndIgnoreStaleVisualTriggers() {
  await withRuntimeEnv(async (tempRoot) => {
    const tag = `symptom=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    const initialState = {
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: { status: "waiting_for_live_state" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
      user_strategy_memory: { strategies: [] },
    };
    service.setRuntimeServiceState(initialState);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    const liveStateFile = path.join(runtimePaths.currentWatchDir, "cruise-live-state.json");
    const staleKey = "3-2:augment_choice";
    service.setRuntimeServiceState({
      ...initialState,
      match_connection: { status: "connected_to_live_match" },
      active_mode: "cruise",
      runtime_triggers: {
        visual_by_stage: {
          [staleKey]: {
            status: "visual_refresh_queued",
            mode: "augment_choice",
            stage_round: "3-2",
            visual_request_id: "missing-stale-request",
            queued_at: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      response_task: { status: "idle" },
    });
    await writeJson(liveStateFile, {
      schema: "verify-live-state",
      match_session_id: "verify-match",
      phase: { stage_round: "3-2", status: "choice" },
      own_board: { units: [{ name: "潘森", cost: 2, star: 2 }] },
    });
    const augment = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assert.equal(augment.status, "runtime_observed", `augment choice stage should stay observe-only/quiet when auto choice sensing is disabled, got ${augment.status}`);
    assert.equal(augment.observation_policy?.quiet_for_upcoming_choice, true);
    assert.equal(augment.phase_trigger?.mode, "augment_choice");
    assert.equal(augment.state.runtime_triggers?.visual_by_stage?.[staleKey]?.visual_request_id, "missing-stale-request", "observe-only mode must not mutate old queued visual requests");
  });
}

async function verifyUserSymptomFlowUsesReportedChoiceContext() {
  await withRuntimeEnv(async () => {
    const tag = `user-report-symptom-flow=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: { status: "waiting_for_live_state" },
      response_task: { status: "idle" },
      active_mode: "manual_match_variables",
      runtime_triggers: { visual_by_stage: {} },
      visual_request_status: null,
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
      user_strategy_memory: { strategies: [] },
    });

    const savedVariables = await service.handleRuntimeAction("saveManualVariables", {
      seasonVariables: {},
      target: "verify_target",
    }, {});
    assert.equal(savedVariables.ok, true);
    assert.equal(savedVariables.state.active_mode, "cruise", "confirmed variables should return the active match to cruise");
    assert.deepEqual(savedVariables.variables?.values?.season_variables, {}, "a season without manual variables must not inherit retired season fields");
    assert.equal(savedVariables.variables?.values?.target_plan_text, "verify_target");
    assert.deepEqual(savedVariables.state.match_context?.match_variables, {});
    assert.equal(savedVariables.state.match_context?.latest_target_intent?.text, "verify_target");
    assert.equal(savedVariables.state.match_context?.latest_target_intent?.authority, "provisional_user_intent");
    assert.equal(savedVariables.state.match_context?.target_plan, null);
    assert.equal(savedVariables.event?.type, "match_variables_changed", "manual variable confirmation should emit a semantic event");
    assert.equal(savedVariables.event?.response_policy, "context_only", "manual variables should wait for the first 2-1 user-owned answer");
    assert.equal(savedVariables.event?.advice_eligible, false, "manual variables should not occupy the Host lane");
    assert.equal(savedVariables.response?.final_text, undefined, "manual variables should show operational status instead of a second local strategy answer");
    assert.match(savedVariables.message || "", /已确认本局目标/, "a season without manual variables should confirm the target rather than retired variables");

    const liveStateFile = path.join(runtimePaths.currentWatchDir, "cruise-live-state.json");
    await writeJson(liveStateFile, {
      schema: "verify-live-state",
      match_session_id: "verify-match",
      phase: { stage_round: "2-1", status: "choice" },
      own_board: { units: [{ name: "verify_unit", cost: 2, star: 1 }] },
      shop: { units: [{ name: "verify_shop_unit", cost: 2 }] },
      items: { item_bench: ["verify_component"] },
    });

    const reportedChoiceSet = service.buildUserReportedChoiceSet({
      text: "Alpha / Bravo / Charlie; equipment: bow, belt",
      mode: "augment_choice",
      liveState: {
        match_session_id: "verify-match",
        phase: { stage_round: "2-1", status: "choice" },
        economy: { hp: 100, gold: 10, level: 3, xp: "0/6" },
      },
      observedAt: "2026-07-27T10:00:00.000Z",
    });
    assert(reportedChoiceSet, "a current-match augment report must create a choice set");
    assert.equal(reportedChoiceSet.source, "current_match_user_report");
    assert.deepEqual(reportedChoiceSet.candidates.map((entry) => entry.name), ["Alpha", "Bravo", "Charlie"]);

    service.setRuntimeServiceState({
      ...savedVariables.state,
      active_mode: "augment_choice",
      response_task: { status: "idle" },
      match_context: {
        ...(savedVariables.state.match_context || {}),
        match_session_id: "verify-match",
        reported_choice_sets_by_mode: { augment_choice: reportedChoiceSet },
        reported_choice_sets: [reportedChoiceSet],
      },
      visual_request_status: null,
    });

    const selected = service.currentUserReportedChoiceSetForAdvice(
      "augment_choice",
      { phase: { stage_round: "2-1" } },
      service.getRuntimeServiceState().match_context,
    );
    assert.equal(selected?.revision, 1, "same-checkpoint choice advice must use the latest user report");
    assert.equal(
      service.currentUserReportedChoiceSetForAdvice(
        "augment_choice",
        { phase: { stage_round: "2-2" } },
        service.getRuntimeServiceState().match_context,
      ),
      null,
      "a reported choice set must expire after its checkpoint",
    );

    const snapshot = service.buildDecisionSnapshot({
      mode: "augment_choice",
      hostRequest: { request_id: "verify-user-report-snapshot" },
      liveStateSummary: {
        observed_at: "2026-07-27T10:00:01.000Z",
        phase: { stage_round: "2-1" },
        economy: { hp: 100, gold: 10, level: 3, xp: "0/6" },
      },
      matchContext: service.getRuntimeServiceState().match_context,
      matchFacts: {},
    });
    assert.equal(snapshot.choice_set?.revision, 1);
    assert.equal(snapshot.choice_set?.candidates?.length, 3);
    assert.equal(service.getRuntimeServiceState().visual_request_status, null, "user-report intake must not create a production visual request");
  });
}

async function verifyInitialLiveMatchAttachKeepsHostLaneSilent() {
  await withRuntimeEnv(async () => {
    const tag = `initial-live-cruise=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: { status: "waiting_for_live_state" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
      user_strategy_memory: { strategies: [] },
    });

    const liveStateFile = path.join(runtimePaths.currentWatchDir, "cruise-live-state.json");
    await writeJson(liveStateFile, {
      schema: "verify-live-state",
      match_session_id: "verify-match",
      phase: { stage_round: "1-3", status: "planning" },
      own_board: { units: [{ name: "蕾欧娜", cost: 1, star: 1 }, { name: "凯特琳", cost: 1, star: 1 }] },
      bench: { units: [{ name: "科加斯", cost: 1, star: 1 }] },
      shop: { units: [{ name: "崔斯特", cost: 1 }, { name: "小木灵", cost: 1 }] },
      economy: { gold: 4, level: 3, xp: { value: 0, to_next: 2 } },
    });

    const poll = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assert.notEqual(poll.status, "awaiting_host_cli_agent_response", "first real live_state attach must not open an automatic Host answer");
    assert.equal(poll.match_connection?.status, "connected_to_live_match");
    assert.equal(poll.state.match_connection?.initial_cruise_greeting_status, "ready_without_automatic_answer");
    assert.equal(poll.response || poll.response_task?.response || null, null, "live-state attachment should rely on the deterministic UI status message and preserve the Host lane for strategic checkpoints");
  });
}

async function verifyStartMatchClearsOldVisualArtifacts() {
  await withRuntimeEnv(async (tempRoot) => {
    const tag = `start-match-clears-visual=${Date.now()}`;
    const { startSession } = await import(fileUrl("tools/start-jcc-new-match-session.mjs", tag));
    const outDir = path.join(tempRoot, "watch");
    const stateFile = path.join(tempRoot, "state", "session.json");
    await mkdir(outDir, { recursive: true });
    for (const file of ["latest-visual-live-state.json", "pending-visual-requests.json", "cruise-live-state.json"]) {
      await writeJson(path.join(outDir, file), { stale: true, match_session_id: "old-match" });
    }
    await startSession({
      matchSessionId: "new-match",
      outDir,
      stateFile,
      testWorkspaceRoot: tempRoot,
      seasonSnapshotBase64Url: Buffer.from(
        JSON.stringify(activeCoreProfileSnapshot),
        "utf8",
      ).toString("base64url"),
      dryRun: false,
    });
    for (const file of ["latest-visual-live-state.json", "pending-visual-requests.json", "cruise-live-state.json"]) {
      await assert.rejects(readFile(path.join(outDir, file), "utf8"), /ENOENT/, `${file} should be cleared when starting a new match`);
    }
  });
}

async function verifyPendingHostCoachBlocksDuplicateCruisePoll() {
  await withRuntimeEnv(async () => {
    const tag = `pending-host-coach-guard=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await mkdir(runtimePaths.uiRuntimeDir, { recursive: true });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-live-state",
      match_session_id: "verify-match",
      phase: { stage_round: "2-3", status: "planning" },
      economy: { gold: 24, hp: 96, level: 4 },
      own_board: { units: [{ name: "verify_frontline", cost: 1, star: 2 }] },
      shop: { units: [{ name: "verify_shop_unit", cost: 2 }] },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: { status: "connected_to_live_match" },
      response_task: {
        status: "awaiting_host_cli_agent_response",
        response_task_id: "verify-pending-coach",
        mode: "cruise",
        awaiting_since: new Date().toISOString(),
        host_request: {
          request_id: "verify-host-request",
          mode: "cruise",
          user_message: "verify pending advice",
        },
      },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      visual_request_status: null,
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
    });

    const poll = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assert.equal(poll.status, "response_pending", "cruise poll must not start another advice task while the previous host coach response is pending");
    assert.equal(poll.response_task?.response_task_id, "verify-pending-coach");
    assert.equal(poll.state.response_task?.response_task_id, "verify-pending-coach");
    assert(
      !existsSync(path.join(runtimePaths.uiRuntimeDir, "latest-cruise-autopoll-pipeline.json")),
      "pending host coach guard must not generate another cruise autopoll pipeline",
    );
  });
}

async function verifyStalePendingHostCoachReleasesCruisePoll() {
  await withRuntimeEnv(async () => {
    const previousTimeout = process.env.JCC_UI_HOST_COACH_PENDING_TIMEOUT_MS;
    process.env.JCC_UI_HOST_COACH_PENDING_TIMEOUT_MS = "1";
    try {
      const tag = `stale-pending-host-coach=${Date.now()}`;
      const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
      const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
      const runtimePaths = storeModule.createRuntimePaths(root);
      await mkdir(runtimePaths.currentWatchDir, { recursive: true });
      await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
        schema: "verify-live-state",
        match_session_id: "verify-match",
        phase: { stage_round: "2-5", status: "planning" },
        economy: { gold: 30, hp: 92, level: 5 },
        own_board: { units: [{ name: "verify_unit", cost: 2, star: 2 }] },
      });
      service.setRuntimeServiceState({
        schema: "jcc-ui-runtime-state-v1",
        device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
        daily_session: { status: "inactive", mode: null },
        match_session: activeMatchSession("verify-match"),
        match_connection: { status: "connected_to_live_match" },
        response_task: {
          status: "awaiting_host_cli_agent_response",
          response_task_id: "verify-stale-pending-coach",
          mode: "cruise",
          awaiting_since: new Date(Date.now() - 1000).toISOString(),
          host_request: { request_id: "verify-stale-host-request", mode: "cruise" },
        },
        active_mode: "cruise",
        runtime_triggers: { visual_by_stage: {} },
        visual_request_status: null,
        host_cli: { provider: "codex", available: false },
        host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
        user_preferences: {},
      });

      const poll = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
      assert.equal(poll.status, "response_failed", "stale pending host coach state must be delivered as a visible failure instead of blocking cruise forever");
      assert.equal(poll.error, "host_coach_response_pending_timeout");
      assert.equal(poll.response_task?.status, "failed");
      assert.equal(poll.response_task?.error, "host_coach_response_pending_timeout");
      assert.ok(!poll.state.response_task?.delivered_at, "stale pending host coach failure must stay undelivered until the UI renders and acks it");
      const ack = await service.handleRuntimeAction("ackDeliveredResponse", {
        response_task_id: poll.response_task?.response_task_id,
        response_task_revision: poll.response_task?.revision,
        reason: "verify_stale_pending_failure_rendered",
      }, {});
      assert.equal(ack.status, "delivered", "stale pending host coach failure must be marked delivered after the UI receives it");
      assert.ok(ack.state.response_task?.delivered_at, "acked stale pending host coach failure must persist delivered_at");
    } finally {
      if (previousTimeout === undefined) delete process.env.JCC_UI_HOST_COACH_PENDING_TIMEOUT_MS;
      else process.env.JCC_UI_HOST_COACH_PENDING_TIMEOUT_MS = previousTimeout;
    }
  });
}

async function verifyUserReportedChoiceHostCoachUsesDurableTimeout() {
  await withRuntimeEnv(async () => {
    const previousHostTimeout = process.env.JCC_UI_HOST_COACH_PENDING_TIMEOUT_MS;
    const previousManualTimeout = process.env.JCC_MANUAL_CHOICE_HOST_PENDING_TIMEOUT_MS;
    process.env.JCC_UI_HOST_COACH_PENDING_TIMEOUT_MS = "120000";
    process.env.JCC_MANUAL_CHOICE_HOST_PENDING_TIMEOUT_MS = "1";
    try {
      const tag = `user-reported-choice-durable-timeout=${Date.now()}`;
      const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
      const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
      const runtimePaths = storeModule.createRuntimePaths(root);
      await mkdir(runtimePaths.currentWatchDir, { recursive: true });
      await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
        schema: "verify-live-state",
        match_session_id: "verify-match",
        phase: { stage_round: "2-1", status: "choice" },
        economy: { gold: 12, hp: 100, level: 4 },
      });
      service.setRuntimeServiceState({
        schema: "jcc-ui-runtime-state-v1",
        device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
        daily_session: { status: "inactive", mode: null },
        match_session: activeMatchSession("verify-match"),
        match_connection: { status: "connected_to_live_match" },
        response_task: {
          status: "awaiting_host_cli_agent_response",
          response_task_id: "verify-manual-choice-host-coach",
          mode: "augment_choice",
          origin: "user",
          awaiting_since: new Date(Date.now() - 1000).toISOString(),
          expiry_policy: "user_question_must_return_even_if_window_passed",
        },
        active_mode: "augment_choice",
        runtime_triggers: { visual_by_stage: {} },
        visual_request_status: null,
        match_context: {
          match_session_id: "verify-match",
          reported_choice_sets_by_mode: {
            augment_choice: {
              schema: "jcc-user-reported-choice-set-v1",
              source: "current_match_user_report",
              mode: "augment_choice",
              match_session_id: "verify-match",
              choice_stage_round: "2-1",
              revision: 1,
              candidates: [{ name: "A" }, { name: "B" }, { name: "C" }],
            },
          },
        },
        host_cli: { provider: "kimi", available: true },
        host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
        user_preferences: {},
      });

      const poll = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
      assert.equal(poll.status, "response_failed", "user-reported choice host timeout must release the answer lane without pretending the host model completed");
      assert.equal(poll.error, "host_coach_response_pending_timeout");
      assert.equal(poll.response_task?.status, "failed");
      assert.equal(poll.response_task?.fallback_response, undefined, "production timeout must not synthesize an OCR-derived choice answer");
      assert.equal(poll.fallback_response, null, "poll result must not expose a calibration-derived choice fallback");
      assert.equal(poll.state.response_task?.error, "host_coach_response_pending_timeout");
      assert.notEqual(poll.state.response_task?.status, "awaiting_host_cli_agent_response");
    } finally {
      if (previousHostTimeout === undefined) delete process.env.JCC_UI_HOST_COACH_PENDING_TIMEOUT_MS;
      else process.env.JCC_UI_HOST_COACH_PENDING_TIMEOUT_MS = previousHostTimeout;
      if (previousManualTimeout === undefined) delete process.env.JCC_MANUAL_CHOICE_HOST_PENDING_TIMEOUT_MS;
      else process.env.JCC_MANUAL_CHOICE_HOST_PENDING_TIMEOUT_MS = previousManualTimeout;
    }
  });
}

async function verifyOldMatchLiveStateCannotAttachCurrentMatch() {
  await withRuntimeEnv(async () => {
    const tag = `old-match-live-state=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-live-state",
      match_session_id: "old-match",
      phase: { stage_round: "2-1", status: "choice" },
      own_board: { units: [{ name: "old_unit", cost: 2, star: 2 }] },
      economy: { gold: 99 },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("current-match"),
      match_connection: { status: "waiting_for_live_state" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "current-match" } },
      user_preferences: {},
    });

    const poll = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assert.equal(poll.status, "waiting_for_current_match_live_state");
    assert.equal(poll.rejected_base_match_session_id, "old-match");
    assert.notEqual(poll.state.match_connection?.status, "connected_to_live_match", "old match live_state must not attach the current match");
  });
}

async function verifyEmptyLiveStateDoesNotAttachCurrentMatch() {
  await withRuntimeEnv(async () => {
    const tag = `empty-live-state=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-empty-live-state",
      match_session_id: "current-match",
      phase: {},
      economy: {},
      items: {},
      augments: {},
      own_board: { units: [] },
      own_bench: { units: [] },
      shop: { units: [] },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("current-match"),
      match_connection: { status: "waiting_for_live_state" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "current-match" } },
      user_preferences: {},
    });

    const poll = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assert.notEqual(poll.state.match_connection?.status, "connected_to_live_match", "empty live_state shells must not attach the current match");
  });
}

async function verifyCurrentMatchStructuredStreamAttachesBeforeHudIsReady() {
  await withRuntimeEnv(async () => {
    const tag = `structured-stream-attaches=${Date.now()}`;
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("current-match"),
      match_connection: { status: "waiting_for_live_state" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "current-match" } },
      user_preferences: {},
    });

    const summary = service.compactLiveStateForHost({
      schema: "verify-current-match-structured-stream",
      match_session_id: "current-match",
      observed_at: new Date().toISOString(),
      source_revision: 7,
      phase: { stage_round: null, status: 5 },
      economy: { hp: null, gold: null, level: null, xp: null },
      shop: { shop_units: [{ name: "shop-anchor" }] },
      source: {
        kind: "mumu_runtime_watch",
        source_revision: 7,
        self_view_anchor_shop_4354: true,
        latest_source_observation: {
          source_revision: 7,
          observed_at: new Date().toISOString(),
          source_kind: "mumu_gi_logcat",
          source_command: 4354,
        },
      },
    });
    const changed = service.updateMatchConnectionFromLiveState(summary);
    const connected = service.getRuntimeServiceState().match_connection;

    assert.equal(changed, true, "a fresh current-match structured stream should advance the connection state");
    assert.equal(connected.status, "connected_to_live_match", "HUD OCR readiness must not masquerade as match attachment readiness");
    assert.equal(
      connected.source_health?.structured_source_status,
      "structured_match_stream_ready_hud_pending",
      "connection diagnostics should preserve that structured match attachment preceded HUD readiness",
    );
    assert.equal(connected.evidence?.has_structured_match_anchor, true);

    const hudReadySummary = {
      ...summary,
      phase: { stage_round: "2-1", status: 1 },
    };
    assert.equal(
      service.updateMatchConnectionFromLiveState(hudReadySummary),
      true,
      "HUD readiness arriving after structured attachment should persist the source-health transition",
    );
    assert.equal(
      service.getRuntimeServiceState().match_connection.source_health?.structured_source_status,
      "live_payload_ready",
    );
  });
}

async function verifyModeSwitchQuarantinesOldChoiceVisualState() {
  await withRuntimeEnv(async () => {
    const tag = `mode-switch-supersedes-choice=${Date.now()}`;
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: {
        status: "connected_to_live_match",
        last_live_state_match_session_id: "verify-match",
        initial_cruise_greeting_at: new Date().toISOString(),
      },
      response_task: { status: "idle" },
      active_mode: "augment_choice",
      runtime_triggers: { visual_by_stage: {} },
      visual_request_status: {
        status: "completed",
        mode: "augment_choice",
        reason: "verify_old_augment_completed",
        request_id: "verify-old-augment",
        completed_run_file: "missing-old-augment-file.json",
      },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
    });

    const switched = await service.handleRuntimeAction("setMode", { mode: "item" }, {});
    assert.equal(switched.ok, true);
    assert.equal(switched.state.active_mode, "item_choice");
    assert.equal(switched.status, "mode_set_choice_ready_for_user_report");
    assert.equal(switched.state.visual_request_status, null, "switching user-report choice modes must quarantine the old visual task without creating a new one");
    assert.equal(switched.user_report_contract?.no_ocr_or_vision_fallback, true);
    assert(String(switched.message || "").trim(), "user-report choice mode entry must tell the user what to report");
  });
}

async function verifyDeliveredVisualAdviceIsNotReplayed() {
  await withRuntimeEnv(async () => {
    const tag = `delivered-visual-not-replayed=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-live-state",
      match_session_id: "verify-match",
      phase: { stage_round: "2-2", status: 1 },
      own_board: { units: [{ name: "潘森", cost: 2 }] },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: {
        status: "connected_to_live_match",
        last_live_state_match_session_id: "verify-match",
        initial_cruise_greeting_at: new Date().toISOString(),
      },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      visual_request_status: {
        status: "advice_delivered",
        mode: "augment_choice",
        reason: "verify_old_delivered_augment",
        request_id: "verify-old-delivered-augment",
        advice_delivered_at: new Date().toISOString(),
      },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
    });

    const poll = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assert.notEqual(poll.status, "completed", "delivered augment advice must not be replayed during later cruise polling");
    assert.notEqual(poll.response?.final_text, "建议全刷这组三张。", "old delivered advice text must not be emitted again");
  });
}

async function verifyReportedChoiceStageDoesNotStartAutomaticSensing() {
  await withRuntimeEnv(async () => {
    const tag = `reported-choice-stage-no-auto-sensing=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-live-state",
      match_session_id: "verify-match",
      phase: { stage_round: "2-1", status: 4 },
      economy: { hp: 100, gold: 10, level: 3, xp: "0/6" },
    });

    const reportedChoiceSet = service.buildUserReportedChoiceSet({
      text: "Alpha / Bravo / Charlie",
      mode: "augment_choice",
      liveState: { phase: { stage_round: "2-1", status: 4 } },
      observedAt: new Date().toISOString(),
    });
    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: {
        status: "connected_to_live_match",
        last_live_state_match_session_id: "verify-match",
        initial_cruise_greeting_at: new Date().toISOString(),
      },
      response_task: { status: "idle" },
      active_mode: "augment_choice",
      runtime_triggers: { visual_by_stage: {} },
      match_context: {
        match_session_id: "verify-match",
        reported_choice_sets_by_mode: { augment_choice: reportedChoiceSet },
        reported_choice_sets: [reportedChoiceSet],
      },
      visual_request_status: null,
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
    });

    const poll = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assert.equal(poll.status, "runtime_observed", "choice checkpoints must stay observe-only until the user's direct report owns an answer");
    assert.equal(poll.observation_policy?.quiet_for_upcoming_choice, true);
    assert.equal(poll.phase_trigger?.mode, "augment_choice");
    assert.equal(poll.state.visual_request_status, null, "a reported choice checkpoint must not start OCR or host vision");
  });
}

async function verifyNewerBaseLiveStateBeatsOldVisualSummary() {
  await withRuntimeEnv(async () => {
    const tag = `base-beats-old-visual=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    const now = Date.now();
    const visualLiveStateFile = path.join(runtimePaths.currentWatchDir, "verify-old-visual-live-state.json");
    await writeJson(visualLiveStateFile, {
      schema: "verify-visual-live-state",
      match_session_id: "verify-match",
      observed_at: new Date(now - 20000).toISOString(),
      phase: { stage_round: "3-2", status: 1 },
      economy: { gold: 24, hp: 100 },
      board: { board_units: [{ name: "old_visual_unit" }] },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "latest-visual-live-state.json"), {
      status: "completed",
      completed_at: new Date(now - 20000).toISOString(),
      visual_live_state_file: visualLiveStateFile,
      request: { request_id: "old-visual", mode: "augment_choice", match_session_id: "verify-match" },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-base-live-state",
      match_session_id: "verify-match",
      observed_at: new Date(now).toISOString(),
      phase: { stage_round: "3-2", status: 1 },
      economy: { gold: 50, hp: 82 },
      board: { board_units: [{ name: "fresh_base_unit" }] },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: { status: "connected_to_live_match", last_live_state_match_session_id: "verify-match" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      visual_request_status: { status: "idle" },
      self_state_refresh: {
        status: "completed_self_state_roi_ocr",
        last_source: "self_state_roi_ocr",
        last_self_state_roi_visual_live_state_file: visualLiveStateFile,
        last_self_state_roi_completed_at: new Date(now).toISOString(),
      },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
    });

    const resolved = await service.resolveActiveLiveStateForRuntime({ purpose: "cruise" });
    assert.equal(resolved.source, "cruise_live_state", "cruise must prefer fresh MuMu base state over stale visual state from the same stage");
    assert.equal(resolved.live_state.economy.gold, 50);
    assert.equal(resolved.live_state.board.board_units[0].name, "fresh_base_unit");
  });
}

async function verifyCruiseBaseWithoutTimestampDoesNotUseWholeVisualState() {
  await withRuntimeEnv(async () => {
    const tag = `base-without-time-no-whole-visual=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    const now = Date.now();
    const visualLiveStateFile = path.join(runtimePaths.currentWatchDir, "verify-self-state-visual-live-state.json");
    await writeJson(visualLiveStateFile, {
      schema: "verify-visual-live-state",
      match_session_id: "verify-match",
      observed_at: new Date(now).toISOString(),
      mode: "refresh_self_state",
      phase: { stage_round: "3-6", status: 1 },
      economy: { gold: 50, hp: 82, level: 7, xp: { value: 10, to_next: 44 } },
      board: { board_units: [{ name: "old_visual_unit" }] },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "latest-visual-live-state.json"), {
      status: "completed",
      completed_at: new Date(now).toISOString(),
      visual_live_state_file: visualLiveStateFile,
      request: { request_id: "self-state-visual", mode: "refresh_self_state", match_session_id: "verify-match" },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-real-watcher-shape-without-observed-at",
      match_session_id: "verify-match",
      phase: { status: 1, stage_round: null },
      economy: { gold: null, hp: null, level: null, xp: null },
      board: { board_units: [{ name: "fresh_base_unit" }] },
      shop: { shop_units: [{ name: "fresh_shop_unit" }] },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: { status: "connected_to_live_match", last_live_state_match_session_id: "verify-match" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      visual_request_status: { status: "idle" },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
    });

    const resolved = await service.resolveActiveLiveStateForRuntime({ purpose: "cruise" });
    assert.equal(resolved.source, "cruise_live_state_with_visual_self_state_fields", "cruise should field-merge self-state visual facts instead of whole-state overriding base");
    assert.equal(resolved.live_state.board.board_units[0].name, "fresh_base_unit");
    assert.equal(resolved.live_state.shop.shop_units[0].name, "fresh_shop_unit");
    assert.equal(resolved.live_state.phase.stage_round, "3-6");
    assert.equal(resolved.live_state.economy.gold, 50);
    assert.equal(resolved.live_state.economy.hp, 82);
  });
}

async function verifyNewSelfStateRoiOverridesStaleBaseSelfStateFields() {
  await withRuntimeEnv(async () => {
    const tag = `self-state-roi-overrides-stale-base=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    const now = Date.now();
    const visualLiveStateFile = path.join(runtimePaths.currentWatchDir, "verify-new-self-state-roi-visual-live-state.json");
    await writeJson(visualLiveStateFile, {
      schema: "verify-visual-live-state",
      match_session_id: "verify-match",
      observed_at: new Date(now).toISOString(),
      mode: "refresh_self_state",
      phase: { stage_round: "3-6", status: 1 },
      economy: { gold: 50, hp: 78, level: 7, xp: { value: 24, to_next: 44 } },
      board: { board_units: [{ name: "old_visual_unit" }] },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "latest-visual-live-state.json"), {
      status: "completed",
      completed_at: new Date(now).toISOString(),
      visual_live_state_file: visualLiveStateFile,
      request: { request_id: "new-self-state-roi-visual", mode: "refresh_self_state", match_session_id: "verify-match" },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-stale-base-self-state-with-fresh-board",
      match_session_id: "verify-match",
      observed_at: new Date(now - 30000).toISOString(),
      phase: { status: 1, stage_round: "2-1" },
      economy: { gold: 8, hp: 100, level: 4, xp: null },
      board: { board_units: [{ name: "fresh_base_unit" }] },
      shop: { shop_units: [{ name: "fresh_shop_unit" }] },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: { status: "connected_to_live_match", last_live_state_match_session_id: "verify-match" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      visual_request_status: { status: "idle" },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
    });

    const resolved = await service.resolveActiveLiveStateForRuntime({ purpose: "cruise" });
    assert.equal(resolved.source, "cruise_live_state_with_visual_self_state_fields", "newer self-state ROI should field-override stale base HUD");
    assert.equal(resolved.live_state.phase.stage_round, "3-6");
    assert.equal(resolved.live_state.economy.gold, 50);
    assert.equal(resolved.live_state.economy.hp, 78);
    assert.equal(resolved.live_state.board.board_units[0].name, "fresh_base_unit");
    assert.equal(resolved.live_state.shop.shop_units[0].name, "fresh_shop_unit");
  });
}

async function verifyStateTrackedSelfStateRoiBeatsStaleLatestVisualRef() {
  await withRuntimeEnv(async () => {
    const tag = `state-self-state-roi-beats-stale-latest-visual=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    const now = Date.now();
    const staleVisualLiveStateFile = path.join(runtimePaths.currentWatchDir, "verify-stale-host-visual-live-state.json");
    const freshSelfStateRoiLiveStateFile = path.join(runtimePaths.currentWatchDir, "verify-fresh-self-state-roi-live-state.json");
    await writeJson(staleVisualLiveStateFile, {
      schema: "verify-stale-host-visual",
      match_session_id: "verify-match",
      observed_at: new Date(now - 120000).toISOString(),
      mode: "refresh_self_state",
      phase: { stage_round: "2-1", status: 1 },
      economy: { gold: 17, hp: 17, level: 3 },
    });
    await writeJson(freshSelfStateRoiLiveStateFile, {
      schema: "verify-fresh-self-state-roi-live-state",
      match_session_id: "verify-match",
      observed_at: new Date(now).toISOString(),
      mode: "refresh_self_state",
      visual_applied: { mode: "refresh_self_state", source: "self_state_roi_ocr" },
      phase: { stage_round: "2-3", status: 1, stage_round_source: "self_state_roi_ocr" },
      economy: { gold: 50, hp: 100, level: 4 },
      field_status: {
        "phase.stage_round": { source: "self_state_roi_ocr" },
        "economy.gold": { source: "self_state_roi_ocr" },
        "economy.hp": { source: "self_state_roi_ocr" },
      },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "latest-visual-live-state.json"), {
      status: "completed",
      completed_at: new Date(now - 120000).toISOString(),
      visual_live_state_file: staleVisualLiveStateFile,
      request: { request_id: "stale-host-visual", mode: "refresh_self_state", match_session_id: "verify-match" },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-base-with-fresh-board",
      match_session_id: "verify-match",
      observed_at: new Date(now - 30000).toISOString(),
      phase: { status: 1, stage_round: null },
      economy: { gold: null, hp: null, level: null, xp: null },
      board: { board_units: [{ name: "fresh_base_unit" }] },
      shop: { shop_units: [{ name: "fresh_shop_unit" }] },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: { status: "connected_to_live_match", last_live_state_match_session_id: "verify-match" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      visual_request_status: { status: "idle" },
      self_state_refresh: {
        status: "completed_self_state_roi_ocr",
        last_completed_at: new Date(now).toISOString(),
        last_self_state_roi_completed_at: new Date(now).toISOString(),
        last_source: "self_state_roi_ocr",
        last_visual_live_state_file: freshSelfStateRoiLiveStateFile,
        last_self_state_roi_visual_live_state_file: freshSelfStateRoiLiveStateFile,
      },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
    });

    const resolved = await service.resolveActiveLiveStateForRuntime({ purpose: "cruise" });
    assert.equal(resolved.source, "cruise_live_state_with_visual_self_state_fields", "state-tracked self-state ROI OCR should be merged even when latest visual ref is stale host vision");
    assert.equal(resolved.live_state.phase.stage_round, "2-3");
    assert.equal(resolved.live_state.economy.gold, 50);
    assert.equal(resolved.live_state.economy.hp, 100);
    assert.equal(resolved.live_state.board.board_units[0].name, "fresh_base_unit");
    assert.equal(resolved.freshness.self_state_roi_stage, "2-3");
    const choiceResolved = await service.resolveActiveLiveStateForRuntime({ purpose: "choice" });
    assert.equal(choiceResolved.source, "cruise_live_state_with_visual_self_state_fields", "choice-mode pipelines must also see self-state ROI OCR phase/economy");
    assert.equal(choiceResolved.live_state.phase.stage_round, "2-3");
    assert.equal(choiceResolved.live_state.economy.gold, 50);
  });
}

async function verifyOldSelfStateRoiFillsFreshBaseGapsWithoutOverwritingValues() {
  await withRuntimeEnv(async () => {
    const tag = `old-self-state-roi-fill-missing-fresh-base=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    const now = Date.now();
    const visualLiveStateFile = path.join(runtimePaths.currentWatchDir, "verify-old-self-state-roi-visual-live-state.json");
    await writeJson(visualLiveStateFile, {
      schema: "verify-visual-live-state",
      match_session_id: "verify-match",
      observed_at: new Date(now - 30000).toISOString(),
      mode: "refresh_self_state",
      phase: { stage_round: "2-1", status: 1 },
      economy: { gold: 8, hp: 100 },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "latest-visual-live-state.json"), {
      status: "completed",
      completed_at: new Date(now - 30000).toISOString(),
      visual_live_state_file: visualLiveStateFile,
      request: { request_id: "old-self-state-roi-visual", mode: "refresh_self_state", match_session_id: "verify-match" },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-fresh-base-self-state-roi-gaps",
      match_session_id: "verify-match",
      observed_at: new Date(now).toISOString(),
      phase: { status: 1, stage_round: null },
      economy: { gold: null, hp: null, level: null, xp: null },
      board: { board_units: [{ name: "fresh_base_unit" }] },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: { status: "connected_to_live_match", last_live_state_match_session_id: "verify-match" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      visual_request_status: { status: "idle" },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
    });

    const resolved = await service.resolveActiveLiveStateForRuntime({ purpose: "cruise" });
    assert.equal(resolved.source, "cruise_live_state_with_visual_self_state_fields", "older self-state ROI may fill missing HUD fields on a fresher base live_state");
    assert.equal(resolved.live_state.phase.stage_round, "2-1");
    assert.equal(resolved.live_state.economy.gold, 8);
    assert.equal(resolved.live_state.board.board_units[0].name, "fresh_base_unit");

    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-fresh-base-self-state-roi-real-values",
      match_session_id: "verify-match",
      observed_at: new Date(now + 1000).toISOString(),
      phase: { status: 1, stage_round: "2-3" },
      economy: { gold: 42, hp: 88, level: 5, xp: { value: 2, to_next: 20 } },
      board: { board_units: [{ name: "fresh_base_unit" }] },
    });
    const resolvedWithValues = await service.resolveActiveLiveStateForRuntime({ purpose: "cruise" });
    assert.equal(resolvedWithValues.live_state.phase.stage_round, "2-3", "older self-state ROI must not overwrite a fresher real stage_round");
    assert.equal(resolvedWithValues.live_state.economy.gold, 42, "older self-state ROI must not overwrite fresher real gold");
    assert.equal(resolvedWithValues.live_state.economy.hp, 88, "older self-state ROI must not overwrite fresher real hp");
  });
}

async function verifyCruiseStripsEmbeddedChoiceVisualFromBase() {
  await withRuntimeEnv(async () => {
    const tag = `cruise-strips-choice-visual=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-base-live-state-with-embedded-choice-visual",
      match_session_id: "verify-match",
      observed_at: new Date().toISOString(),
      phase: { stage_round: "3-6", status: 1 },
      economy: { gold: 50, hp: 82 },
      board: { board_units: [{ name: "fresh_base_unit" }] },
      augments: {},
      visual: {
        mode: "augment_choice",
        augments: { choices: [{ name: "old_augment_choice" }] },
      },
      visual_applied: { mode: "augment_choice", request_id: "old-choice" },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: { status: "connected_to_live_match", last_live_state_match_session_id: "verify-match" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      visual_request_status: { status: "idle" },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
    });

    const resolved = await service.resolveActiveLiveStateForRuntime({ purpose: "cruise" });
    assert.equal(resolved.live_state.augments.current_choice_set, undefined, "embedded legacy visual candidates must not become the canonical augment choice set");
    const summary = service.compactLiveStateForHost(resolved.live_state);
    assert.equal(summary.choices, undefined, "embedded legacy visual diagnostics must not enter the Host choice summary");
  });
}

async function verifyCruiseRejectsFreshChoiceVisualState() {
  await withRuntimeEnv(async () => {
    const tag = `cruise-rejects-choice-visual=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    const now = Date.now();
    const visualLiveStateFile = path.join(runtimePaths.currentWatchDir, "verify-current-choice-visual-live-state.json");
    await writeJson(visualLiveStateFile, {
      schema: "verify-choice-visual-live-state",
      match_session_id: "verify-match",
      observed_at: new Date(now).toISOString(),
      phase: { stage_round: "3-2", status: 4 },
      mode: "augment_choice",
      augments: { current_choice_set: { choices: [{ name: "潘朵拉的装备" }] } },
      board: { board_units: [{ name: "old_choice_visual_unit" }] },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "latest-visual-live-state.json"), {
      status: "completed",
      completed_at: new Date(now).toISOString(),
      visual_live_state_file: visualLiveStateFile,
      request: { request_id: "fresh-choice-visual", mode: "augment_choice", match_session_id: "verify-match" },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-base-live-state",
      match_session_id: "verify-match",
      observed_at: new Date(now).toISOString(),
      phase: { stage_round: "3-2", status: 1 },
      economy: { gold: 50, hp: 82 },
      board: { board_units: [{ name: "fresh_base_unit" }] },
      augments: {},
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: { status: "connected_to_live_match", last_live_state_match_session_id: "verify-match" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      visual_request_status: { status: "completed", mode: "augment_choice", request_id: "fresh-choice-visual" },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
    });

    const resolved = await service.resolveActiveLiveStateForRuntime({ purpose: "cruise" });
    assert.equal(resolved.source, "cruise_live_state", "cruise must not treat a completed choice-window visual result as current board state");
    assert.equal(resolved.live_state.board.board_units[0].name, "fresh_base_unit");
    assert.equal(resolved.live_state.augments.current_choice_set, undefined);
  });
}

async function verifyAutoCruiseDoesNotInheritPreviousUserMessage() {
  await withRuntimeEnv(async (tempRoot) => {
    const liveStateFile = path.join(tempRoot, "live-state.json");
    const adviceStateFile = path.join(tempRoot, "advice-state.json");
    const outFile = path.join(tempRoot, "pipeline.json");
    const now = new Date().toISOString();
    await writeJson(liveStateFile, {
      schema: "verify-live-state",
      match_session_id: "verify-match",
      observed_at: now,
      phase: { stage_round: "3-6", status: 1 },
      economy: { gold: 50, hp: 72, level: 6 },
      board: { board_units: [{ name: "fresh_current_unit" }] },
    });
    await writeJson(adviceStateFile, {
      schema: "jcc-cruise-advice-lifecycle-state-v1",
      match_session_id: "verify-match",
      mode: "augment_choice",
      active_task_context: {
        mode: "augment_choice",
        user_message: "选哪个？要不要刷新？",
        user_message_observed_at: new Date(Date.now() - 60000).toISOString(),
      },
      match_context: { user_constraints: [] },
      active_tasks: [],
      emitted_tasks: [],
      output_history: [],
    });
    const run = await runNode([
      "tools/run-jcc-cruise-runtime-pipeline.mjs",
      "--live-state", liveStateFile,
      "--advice-state", adviceStateFile,
      "--out", outFile,
      "--mode", "cruise",
    ]);
    assert.equal(run.code, 0, run.stderr || run.stdout);
    const output = JSON.parse(await readFile(outFile, "utf8"));
    assert.equal(output.source_context_summary?.has_active_user_message, false, "auto cruise poll must not replay an old manual augment question");
    assert.equal(output.standardized_live_state_summary?.phase?.stage_round, "3-6");
  });
}

async function verifySessionlessUsefulLiveStateCannotAttachCurrentMatch() {
  await withRuntimeEnv(async () => {
    const tag = `sessionless-live-state=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-sessionless-live-state",
      observed_at: new Date().toISOString(),
      phase: { stage_round: "3-2", status: 1 },
      economy: { gold: 40, hp: 100 },
      board: { board_units: [{ name: "stale_sessionless_unit" }] },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-current-match"),
      match_connection: { status: "waiting_for_live_state" },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-current-match" } },
      user_preferences: {},
    });

    const poll = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assert.equal(poll.status, "waiting_for_current_match_live_state");
    assert.equal(poll.state.match_connection?.status, "waiting_for_current_match_live_state");
  });
}

async function verifyCruiseQuietsNearUpcomingChoicePretrigger() {
  await withRuntimeEnv(async () => {
    const tag = `quiet-upcoming-choice=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-quiet-pretrigger-live-state",
      match_session_id: "verify-match",
      observed_at: new Date().toISOString(),
      phase: { stage_round: "1-4", status: 1 },
      economy: { gold: 0, hp: 100, level: 2 },
      board: { board_units: [{ name: "early_unit" }] },
      shop: { shop_units: [{ name: "shop_unit" }] },
    });

    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: activeMatchSession("verify-match"),
      match_connection: {
        status: "connected_to_live_match",
        last_live_state_match_session_id: "verify-match",
        initial_cruise_greeting_at: new Date().toISOString(),
      },
      response_task: { status: "idle" },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {}, choice_pretriggers: {} },
      visual_request_status: { status: "idle" },
      self_state_refresh: { status: "completed_self_state_roi_ocr", last_completed_at: new Date().toISOString() },
      host_cli: { provider: "codex", available: false },
      host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: "verify-match" } },
      user_preferences: {},
    });

    assert(service.shouldQuietCruiseForUpcomingChoice({
      phase: { stage_round: "1-4" },
    }), "1-4 should be a quiet cruise stage because 2-1 augment pretrigger is imminent");
    const poll = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assert.equal(poll.status, "runtime_observed", "background cruise must not start ordinary advice near 2-1 choice pretrigger");
    assert.equal(poll.observation_policy?.quiet_for_upcoming_choice, true);
    assert.equal(poll.phase_trigger.stage_round, "2-1");
    assert.equal(poll.phase_trigger.mode, "augment_choice");
  });
}

async function verifyUserReportedChoicePipelineTasks() {
  await withRuntimeEnv(async (tempRoot) => {
    const tag = `choice-user-report-pipeline=${Date.now()}`;
    const pipeline = await import(fileUrl("tools/run-jcc-cruise-runtime-pipeline.mjs", tag));

    async function runReportedChoice({ mode, stageRound, candidates, itemChoiceKind = null }) {
      const choiceSet = {
        schema: "jcc-user-reported-choice-set-v1",
        source: "current_match_user_report",
        match_session_id: "verify-user-report-pipeline",
        mode,
        choice_stage_round: stageRound,
        revision: 1,
        ...(itemChoiceKind ? { item_choice_kind: itemChoiceKind } : {}),
        candidates: candidates.map((name, slot) => ({ slot, name, source: "current_match_user_report", confidence: 1 })),
      };
      const contextFile = path.join(tempRoot, `${mode}-context.json`);
      const liveStateFile = path.join(tempRoot, `${mode}-live-state.json`);
      const adviceStateFile = path.join(tempRoot, `${mode}-advice-state.json`);
      await writeJson(contextFile, {
        force_response_reason: "verify_choice_user_report",
        minimum_value_score_to_speak: 0.1,
        user_context: { default_goal: "balanced" },
        match_context: {
          match_session_id: "verify-user-report-pipeline",
          reported_choice_sets_by_mode: { [mode]: choiceSet },
          reported_choice_sets: [choiceSet],
        },
      });
      await writeJson(liveStateFile, {
        schema: "verify-choice-user-report-live-state-v1",
        match_session_id: "verify-user-report-pipeline",
        phase: { stage_round: stageRound, status: "choice" },
        economy: { hp: 88, gold: 30, level: 6, xp: "2/20" },
        own_board: { units: [{ name: "Current unit", cost: 2, star: 2 }] },
        shop: { units: [{ name: "Shop unit", cost: 2 }] },
      });
      const result = await pipeline.runPipeline({
        liveState: liveStateFile,
        context: contextFile,
        adviceState: adviceStateFile,
        mode,
        userMessage: `Choose the best current ${mode} option from my report.`,
        forceResponseReason: "verify_choice_user_report",
        now: "2026-07-27T10:00:00.000Z",
      });
      const task = result.score.advice_tasks.find((entry) => entry.trigger_id === "user_message_response");
      assert(task, `${mode} user report must create the direct user answer owner`);
      const responseEvent = result.response_events.find((entry) =>
        entry.type === "advice_response_requested" && entry.trigger_id === "user_message_response");
      assert(responseEvent, `${mode} user report must request a direct host coach answer`);
      assert.equal(
        result.response_events.filter((entry) => entry.type === "advice_response_requested").length,
        1,
        `${mode} user interaction must have exactly one strategy-answer owner`,
      );
      const hostContext = responseEvent.host_cli_agent_request?.context || {};
      const choiceField = mode === "augment_choice" ? "augment_choices" : "item_choices";
      assert.equal(hostContext[choiceField]?.source, "current_match_user_report");
      assert.equal(hostContext[choiceField]?.candidates?.length, candidates.length);
      assert(!JSON.stringify(responseEvent).includes("rapidocr_worker"), `${mode} host request must not contain RapidOCR provenance`);
      assert(!JSON.stringify(responseEvent).includes("item_choice_roi_ocr"), `${mode} host request must not contain choice OCR provenance`);
      return result;
    }

    await runReportedChoice({
      mode: "augment_choice",
      stageRound: "2-1",
      candidates: ["Augment A", "Augment B", "Augment C"],
    });
    await runReportedChoice({
      mode: "item_choice",
      stageRound: "3-6",
      candidates: ["Item A", "Item B", "Item C", "Item D", "Item E"],
      itemChoiceKind: "completed_item_forge",
    });

    const cruiseLiveState = path.join(tempRoot, "post-choice-cruise-live-state.json");
    const cruiseAdviceState = path.join(tempRoot, "post-choice-cruise-advice-state.json");
    await writeJson(cruiseAdviceState, {
      schema: "jcc-cruise-advice-state-v1",
      match_session_id: "verify-user-report-pipeline",
      mode: "cruise",
      active_tasks: [{
        task_id: "old-augment-task",
        trigger_id: "augment_choice_advice",
        priority: "high",
        value_score: 0.95,
        confidence: 0.9,
        title: "Old augment advice",
        short_advice: "stale augment advice must not repeat in cruise",
        evidence: [],
        actions: [],
        state: "active",
        created_at: "2026-07-27T09:59:00.000Z",
        updated_at: "2026-07-27T09:59:00.000Z",
      }],
      emitted_events: [{
        type: "advice_task_created",
        task_id: "old-augment-task",
        trigger_id: "augment_choice_advice",
        observed_at: "2026-07-27T09:59:00.000Z",
      }],
    });
    await writeJson(cruiseLiveState, {
      schema: "verify-post-choice-cruise-live-state-v1",
      match_session_id: "verify-user-report-pipeline",
      phase: { stage_round: "2-2", status: 1 },
      economy: { gold: 10, hp: 98, level: 4 },
    });
    const cruiseResult = await pipeline.runPipeline({
      liveState: cruiseLiveState,
      adviceState: cruiseAdviceState,
      mode: "cruise",
      now: "2026-07-27T10:01:00.000Z",
    });
    assert(
      !cruiseResult.response_events.some((entry) => entry.type === "advice_response_requested" && entry.trigger_id === "augment_choice_advice"),
      "old choice advice must not be replayed after the checkpoint",
    );
  });
}

async function verifyBoardSummaryFieldCoverage() {
  const { compactLiveStateForHost } = await importRuntimeServiceUtility("board-summary-field-coverage");
  const pipeline = await readText("tools/run-jcc-cruise-runtime-pipeline.mjs");
  const summary = compactLiveStateForHost({
    own_board: { units: [{ champion_name: "霞", cost: 4, position: { row: 4, col: 7 } }] },
    bench: { bench_units: [{ champion_name: "潘森", cost: 2 }] },
    shop: { shop_units: [{ champion_name: "派克", cost: 2 }] },
    items: { item_bench: ["暴风之剑"] },
  });
  assert.equal(summary.own_board.units[0].name, "霞");
  assert.equal(summary.own_bench.units[0].name, "潘森");
  assert.equal(summary.shop.units[0].name, "派克");
  assert(summary.items, "live_state summary must keep item evidence for cruise answers");
  assert(pipeline.includes("const benchUnits = standardizedLiveState.own_bench.units.slice"), "pipeline host live_state_summary must expose own_bench units, not only bench count");
  assert(pipeline.includes("const shopUnits = standardizedLiveState.shop.units.slice"), "pipeline host live_state_summary must expose shop units, not only shop count");
  assert(pipeline.includes("unit.champion_name"), "pipeline compactUnit must preserve MuMu champion_name fields for host model advice");
}

async function verifyHostProvenanceNormalization() {
  const { normalizeHostCoachResponse } = await importRuntimeServiceUtility("host-provenance-normalization");
  const normalized = normalizeHostCoachResponse({
    schema: "jcc-host-cli-coach-response-v1",
    generated_by: "current_cli_agent_main_model",
    request_id: "symptom-request",
    request_hash: "symptom-hash",
    mode: "cruise",
    final_text: "先留对子，不卡利息再拿体系牌。",
    pinned_result: {
      slot: "lineup",
      title: "过渡阵容",
      units: [{ row: 4, col: 7, name: "霞" }],
    },
  }, { request_id: "symptom-request", request_hash: "symptom-hash", mode: "cruise" });
  assert.equal(normalized.generated_by, "current_cli_agent_main_model");
  assert.equal(normalized.request_id, "symptom-request");
  assert.equal(normalized.final_text, "先留对子，不卡利息再拿体系牌。");
  assert.equal(normalized.pinned_result, null, "an unbound hand-authored card must be dropped without losing readable strategy text");
}

async function verifyOpponentAndPinnedUiPaths() {
  const app = await readText("ui/src/App.tsx");
  const service = await readText("ui/electron/runtime-service.js");
  const instructionContract = JSON.parse(await readText("data/runtime/jcc/host-coach-instruction-contract.json"));
  assert(!app.includes("handleFinishOpponentScan"), "UI must not expose removed opponent scan handler");
  assert(!service.includes("finishOpponentScan(payload)"), "runtime service must not implement removed opponent scan finish");
  const emitCoachResponseBody = app.slice(
    app.indexOf("const emitCoachResponse ="),
    app.indexOf("const emitFastChoiceHint =", app.indexOf("const emitCoachResponse =")),
  );
  assert(emitCoachResponseBody.includes("applyPinnedResult(response, options.stream)"), "UI must apply pinned_result inside the same shared coach response delivery stream");
  assert(app.includes("emitCoachResponse(result.response, { respectManualLock: false })"), "normal/manual response paths must use the shared renderer instead of bypassing pinned_result handling");
  assert(app.includes("const displayTitle = activeView === \"variables\" ? title : plan?.title || title"), "UI pinned card must render the returned pinned_result title");
  assert(app.includes("plan.moves && plan.moves.length > 0"), "UI pinned card must render moves for lineup/target/transition as well as positioning");
  assert(service.includes("lineup_handoff_instructions"), "host prompt must request only the minimal lineup handoff for lineup/positioning boards");
  assert(service.includes("buildHostCoachInstructions"), "runtime must compose lineup instructions through the canonical host instruction builder");
  const lineupInvariant = instructionContract.base_instruction_sections?.find((entry) => entry.id === "lineup_card_requirement");
  assert(
    lineupInvariant?.instructions?.some((text) => text.includes("candidate_id") && text.includes("Runtime restores")),
    "canonical host instructions must tell the Agent how Runtime materializes an explicit lineup-card request",
  );
  assert(service.includes("Runtime materializes the complete canonical roster"), "host expected response contract must assign canonical card materialization to Runtime");
}

function buildHostRequestForRanking({ userMessage, dailyBigData, seasonCatalog }) {
  return {
    request_id: "symptom-ranking",
    request_hash: "symptom-ranking",
    mode: "daily_chat",
    user_message: userMessage,
    daily_big_data: dailyBigData,
    season_catalog: seasonCatalog,
    runtime_context: {
      daily_big_data: dailyBigData,
      season_catalog: seasonCatalog,
      context_policy: {
        include_daily_big_data: true,
        include_season_catalog: true,
      },
    },
  };
}

async function verifySelectedRankingCandidates() {
  const { summarizeHostRequest } = await importRuntimeServiceUtility("selected-ranking-candidates");
  const activeProfile = JSON.parse(await readText("data/game-knowledge/jcc/active-profile.json"));
  const overlay = JSON.parse(await readText(`data/game-knowledge/jcc/${activeProfile.runtime_catalog_overlay_path}`));
  const dailyBigData = {
    schema: "jcc-live-rankings-host-context-summary-v1",
    available: true,
    stat_date: "20990101",
    previous_stat_date: null,
    tiers: {
      "0": {
        label: "master_plus",
        top_traits: [],
        top_comps: [],
        lineup_groups: [{
          id: "verify-xayah-carry",
          display_name: "霞主C验证阵容",
          main_traits: ["验证羁绊"],
          summary: { avg_rank: 3.2, top1_rate: 0.18, top4_rate: 0.62, use_rate: 0.04 },
          strategy_profile: {
            main_carry: { champion_id: "14381", champion_name: "霞" },
            core_units: [{ champion_id: "14381", champion_name: "霞" }],
            variants: [],
          },
          variants: [{
            lineup_ids: ["14381"],
            core_chess_ids: ["14381"],
            main_traits: ["验证羁绊"],
            sub_traits: [],
          }],
        }],
      },
    },
  };
  const seasonCatalog = {
    champion_names: Object.values(overlay.champions_by_id || {}).map((champion) => champion.normalized_name || champion.name).filter(Boolean),
    champions_by_cost: {
      "4": [{ name: "霞", ids: ["14381"], ranking_ids: ["14381", "4381"] }],
    },
    traits: [],
  };
  const compact = summarizeHostRequest(buildHostRequestForRanking({
    userMessage: "给我一个霞主C的阵容图",
    dailyBigData,
    seasonCatalog,
  }));
  assert.equal(compact.selected_ranking_candidates, null, "summarization must not trigger Ranking retrieval from raw daily data or natural-language intent");
  const selected = {
    schema: "jcc-selected-ranking-candidates-v1",
    available: true,
    query_terms: ["霞"],
    candidates: dailyBigData.tiers["0"].lineup_groups,
  };
  const prepared = buildHostRequestForRanking({ userMessage: "给我一个霞主C的阵容图", dailyBigData, seasonCatalog });
  prepared.runtime_context.selected_ranking_candidates = selected;
  const preparedSummary = summarizeHostRequest(prepared);
  assert.equal(preparedSummary.selected_ranking_candidates.candidates[0].id, selected.candidates[0].id,
    "summarization must preserve candidates already selected by the evidence owner");
  const unavailable = summarizeHostRequest(buildHostRequestForRanking({
    userMessage: "给我一个霞主C的阵容图",
    dailyBigData: { schema: "jcc-live-rankings-host-context-summary-v1", available: false, reason: "compatible_rankings_unavailable" },
    seasonCatalog,
  }));
  assert.equal(unavailable.selected_ranking_candidates?.candidates?.length || 0, 0, "unavailable rankings must not synthesize ranking candidates from Core data");
}

async function verifySensingMapContract() {
  const map = JSON.parse(await readText("data/runtime/jcc/runtime-mode-sensing-map.json"));
  assert(!map.modes.god_sequence, "common sensing map must not own the S17-only choice mode");
  assert(map.modes.augment_choice.trigger.includes("mumu_4358_s4"), "augment choice must remain s=4 triggerable");
  for (const [mode, sensingPolicy] of [
    ["augment_choice", map.modes.augment_choice],
    ["item_choice", map.modes.item_choice],
  ]) {
    const reportContract = sensingPolicy?.user_report_contract
      || sensingPolicy?.steps?.find((step) => step.user_report_contract)?.user_report_contract;
    assert.equal(reportContract?.source, "current_match_user_report", `${mode} sensing map must use current-match user reports`);
    assert.equal(reportContract?.no_ocr_or_vision_fallback, true, `${mode} sensing map must disable OCR/vision candidate fallback`);
    assert.equal(reportContract?.fallback || "none", "none", `${mode} sensing map must not route candidate intake to a fallback model`);
  }
  assert(!map.modes.opponent_positioning, "removed opponent positioning mode must not exist");
  assert(!map.modes.opponent_power, "removed opponent power mode must not exist");
  assert(!map.modes.refresh_self_state.vision_model, "refresh self state must not route product facts through host multimodal vision");
  assert(map.modes.refresh_self_state.text_ocr?.length >= 5, "refresh self state must retain the daemon-owned HUD RapidOCR fields");
}

async function verifyCruiseSelfStateRefreshUsesFreshestRequest() {
  const service = await readText("ui/electron/runtime-service.js");
  const selfStateRunner = await readText("tools/run-jcc-self-state-roi-ocr.mjs");
  const watcher = await readText("tools/watch-jcc-mumu-runtime-logcat.mjs");
  assert(service.includes("BACKGROUND_SELF_STATE_REFRESH_INTERVAL_MS"), "cruise must schedule periodic HUD self-state refreshes for stage/gold/hp/level/xp");
  assert(service.includes("runBackgroundSelfStateRefresh"), "cruise polling must consume background self-state refreshes before asking for generic advice");
  assert(service.includes("startBackgroundSelfStateRefresh"), "cruise polling must start self-state refresh asynchronously instead of blocking advice on self-state vision");
  assert(service.includes("backgroundSelfStateRefreshPromise"), "cruise must single-flight background self-state refreshes");
  assert(!service.includes("const selfStateRefresh = await runBackgroundSelfStateRefresh(\"poll_cruise_background_self_state_refresh\")"), "cruise must not synchronously await background self-state visual refresh");
  assert(service.includes("runSelfStateRoiOcr"), "runtime-service must own self-state ROI OCR scheduling");
  assert(service.includes("noVisualFallback: true"), "background self-state refresh must remain OCR-first and must not silently start slow host vision");
  assert(selfStateRunner.includes("phase.stage_round") && selfStateRunner.includes("economy.gold"), "self-state ROI runner must aggregate stage and economy fields");
  assert(watcher.includes("source_only: true"), "watcher must remain a structured MuMu source instead of owning self-state OCR scheduling");
  assert(!watcher.includes("refresh_self_state"), "watcher must not retain the removed self-state visual queue path");
}

async function runStep(name, fn, timeoutMs = 60000) {
  let timer = null;
  const startedAt = performance.now();
  process.stderr.write(`[start-match-regression] start ${name}\n`);
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    process.stderr.write(`[start-match-regression] finished ${name} (${Math.round(performance.now() - startedAt)}ms)\n`);
  }
}

async function main() {
  await runStep("verifyStartMatchDoesNotPretendLiveCruise", verifyStartMatchDoesNotPretendLiveCruise);
  await runStep("verifyManualVariablesPersistToPinnedCard", verifyManualVariablesPersistToPinnedCard);
  await runStep("verifyUserReportedChoiceProductionBoundary", verifyUserReportedChoiceProductionBoundary);
  await runStep("verifyRetiredChoiceCalibrationFailsClosed", verifyRetiredChoiceCalibrationFailsClosed);
  await runStep("verifyChoiceWindowsStayObserveOnlyAndIgnoreStaleVisualTriggers", verifyChoiceWindowsStayObserveOnlyAndIgnoreStaleVisualTriggers);
  await runStep("verifyUserSymptomFlowUsesReportedChoiceContext", verifyUserSymptomFlowUsesReportedChoiceContext);
  await runStep("verifyInitialLiveMatchAttachKeepsHostLaneSilent", verifyInitialLiveMatchAttachKeepsHostLaneSilent);
  await runStep("verifyStartMatchClearsOldVisualArtifacts", verifyStartMatchClearsOldVisualArtifacts);
  await runStep("verifyPendingHostCoachBlocksDuplicateCruisePoll", verifyPendingHostCoachBlocksDuplicateCruisePoll);
  await runStep("verifyStalePendingHostCoachReleasesCruisePoll", verifyStalePendingHostCoachReleasesCruisePoll);
  await runStep("verifyUserReportedChoiceHostCoachUsesDurableTimeout", verifyUserReportedChoiceHostCoachUsesDurableTimeout);
  await runStep("verifyOldMatchLiveStateCannotAttachCurrentMatch", verifyOldMatchLiveStateCannotAttachCurrentMatch);
  await runStep("verifyEmptyLiveStateDoesNotAttachCurrentMatch", verifyEmptyLiveStateDoesNotAttachCurrentMatch);
  await runStep("verifyCurrentMatchStructuredStreamAttachesBeforeHudIsReady", verifyCurrentMatchStructuredStreamAttachesBeforeHudIsReady);
  await runStep("verifyModeSwitchQuarantinesOldChoiceVisualState", verifyModeSwitchQuarantinesOldChoiceVisualState);
  await runStep("verifyDeliveredVisualAdviceIsNotReplayed", verifyDeliveredVisualAdviceIsNotReplayed);
  await runStep("verifyReportedChoiceStageDoesNotStartAutomaticSensing", verifyReportedChoiceStageDoesNotStartAutomaticSensing);
  await runStep("verifyNewerBaseLiveStateBeatsOldVisualSummary", verifyNewerBaseLiveStateBeatsOldVisualSummary);
  await runStep("verifyCruiseBaseWithoutTimestampDoesNotUseWholeVisualState", verifyCruiseBaseWithoutTimestampDoesNotUseWholeVisualState);
  await runStep("verifyNewSelfStateRoiOverridesStaleBaseSelfStateFields", verifyNewSelfStateRoiOverridesStaleBaseSelfStateFields);
  await runStep("verifyStateTrackedSelfStateRoiBeatsStaleLatestVisualRef", verifyStateTrackedSelfStateRoiBeatsStaleLatestVisualRef);
  await runStep("verifyOldSelfStateRoiFillsFreshBaseGapsWithoutOverwritingValues", verifyOldSelfStateRoiFillsFreshBaseGapsWithoutOverwritingValues);
  await runStep("verifyCruiseStripsEmbeddedChoiceVisualFromBase", verifyCruiseStripsEmbeddedChoiceVisualFromBase);
  await runStep("verifyCruiseRejectsFreshChoiceVisualState", verifyCruiseRejectsFreshChoiceVisualState);
  await runStep("verifyAutoCruiseDoesNotInheritPreviousUserMessage", verifyAutoCruiseDoesNotInheritPreviousUserMessage);
  await runStep("verifySessionlessUsefulLiveStateCannotAttachCurrentMatch", verifySessionlessUsefulLiveStateCannotAttachCurrentMatch);
  await runStep("verifyCruiseQuietsNearUpcomingChoicePretrigger", verifyCruiseQuietsNearUpcomingChoicePretrigger);
  await runStep("verifyUserReportedChoicePipelineTasks", verifyUserReportedChoicePipelineTasks);
  await runStep("verifyBoardSummaryFieldCoverage", verifyBoardSummaryFieldCoverage);
  await runStep("verifyHostProvenanceNormalization", verifyHostProvenanceNormalization);
  await runStep("verifyOpponentAndPinnedUiPaths", verifyOpponentAndPinnedUiPaths);
  await runStep("verifySelectedRankingCandidates", verifySelectedRankingCandidates);
  await runStep("verifySensingMapContract", verifySensingMapContract);
  await runStep("verifyCruiseSelfStateRefreshUsesFreshestRequest", verifyCruiseSelfStateRefreshUsesFreshestRequest);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-start-match-symptom-regression-v1",
    checked: [
      "start_match_waits_for_real_live_state_before_claiming_cruise",
      "connected_live_state_announces_cruise_once",
      "manual_variables_persist_to_pinned_card_and_match_context",
      "active_choice_modes_require_current_match_user_reports_without_ocr_or_vision_fallback",
      "choice_visual_tools_require_explicit_compatibility_calibration",
      "user_reported_choice_sets_enter_decision_snapshots_and_expire_after_checkpoint",
      "initial_live_match_attach_keeps_host_lane_silent",
      "start_match_clears_old_visual_and_pending_request_artifacts",
      "pending_host_coach_response_blocks_duplicate_cruise_poll",
      "stale_pending_host_coach_response_releases_cruise_poll",
      "user_reported_choice_timeout_releases_lane_without_ocr_fallback",
      "old_match_live_state_cannot_attach_current_match",
      "empty_live_state_shell_does_not_attach_current_match",
      "choice_mode_switch_quarantines_old_visual_state_without_starting_new_visual_work",
      "delivered_visual_advice_is_not_replayed",
      "reported_choice_checkpoint_does_not_start_automatic_sensing",
      "fresh_base_live_state_wins_over_stale_same_stage_visual_for_cruise",
      "real_watcher_base_without_timestamp_uses_visual_self_state_fields_only",
      "newer_self_state_roi_overrides_stale_base_stage_gold_hp",
      "state_tracked_self_state_roi_ocr_beats_stale_latest_visual_ref",
      "older_self_state_roi_fills_missing_fresher_base_gaps_without_overwriting_values",
      "embedded_choice_visual_is_stripped_from_background_cruise_base",
      "cruise_rejects_completed_choice_visual_as_current_board_state",
      "auto_cruise_poll_does_not_replay_previous_manual_user_message",
      "sessionless_useful_live_state_cannot_attach_current_match",
      "background_cruise_quiets_near_upcoming_choice_pretrigger",
      "auto_cruise_responses_are_expiry_gated_before_display",
      "user_reported_active_choice_kinds_reach_exactly_one_advice_pipeline",
      "old_choice_advice_is_not_replayed_during_background_cruise",
      "registered_choice_windows_reserve_the_user_report_lane",
      "board_bench_shop_items_are_visible_to_host_summary",
      "host_response_generated_by_is_normalized_before_pipeline_merge",
      "opponent_board_product_modes_remain_absent",
      "lineup_or_self_positioning_answers_can_update_pinned_card",
      "user_target_lineup_questions_receive_selected_big_data_candidates",
      "mode_sensing_map_matches_user_report_choice_and_hud_self_state_boundaries",
      "cruise_self_state_refresh_consumes_freshest_stage_economy_item_request",
    ],
  }, null, 2)}\n`);
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
