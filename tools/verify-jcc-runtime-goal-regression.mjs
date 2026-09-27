import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { compactLiveStateForHost, normalizeHostCoachResponse } from "../ui/electron/runtime-service.js";

const root = path.resolve(import.meta.dirname, "..");
process.env.JCC_DISABLE_RESIDENT_AUGMENT_CHOICE_OCR = process.env.JCC_DISABLE_RESIDENT_AUGMENT_CHOICE_OCR || "1";
process.env.JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR = process.env.JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR || "1";

async function readText(file) {
  return readFile(path.join(root, file), "utf8");
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function rmRetry(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(error?.code) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
    }
  }
}

function fileUrl(file, tag) {
  return `${pathToFileURL(path.resolve(root, file)).href}?${tag}`;
}

async function verifyHostResponseNormalization() {
  const request = {
    response_id: "advice-response-1",
    host_cli_agent_request: {
      request_id: "advice-response-1",
      request_hash: "hash-1",
    },
  };
  const normalized = normalizeHostCoachResponse({
    schema: "jcc-host-cli-coach-response-v1",
    generated_by: "current_cli_agent_main_model",
    request_id: "advice-response-1",
    request_hash: "hash-1",
    final_text: "这波先留对子，不卡利息的体系牌可以拿。",
  }, request);
  assert.equal(normalized.generated_by, "current_cli_agent_main_model");
  assert.equal(normalized.request_id, "advice-response-1");
  assert.equal(normalized.request_hash, "hash-1");
  assert.equal(normalized.confidence, "medium");
}

async function verifyPendingCoachUsesSelectedPipeline() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-goal-regression-"));
  try {
    const pipelineFile = path.join(tmp, "host-response-finished.json");
    const responseFile = path.join(tmp, "agent-response.json");
    await writeJson(pipelineFile, {
      schema: "verify-pipeline",
      response_events: [
        {
          schema: "jcc-runtime-advice-response-request-v1",
          type: "advice_response_requested",
          response_id: "host-response-1",
          ai_native_policy: { output_model: "host_cli_main_model_required" },
          response_draft: { summary: "draft" },
          host_cli_agent_request: {
            request_id: "host-response-1",
            request_hash: "host-hash-1",
            fallback_text: "draft",
          },
        },
      ],
    });
    await writeJson(responseFile, {
      schema: "jcc-host-cli-coach-response-v1",
      generated_by: "current_cli_agent_main_model",
      request_id: "host-response-1",
      request_hash: "host-hash-1",
      final_text: "外面两家质量高，下一波建议先补前排稳血。",
      confidence: "medium",
      pinned_result: {
        slot: "position",
        title: "Positioning Plan",
        units: [
          { row: 1, col: 4, name: "Pantheon" },
          { row: 4, col: 7, name: "Pyke", mark: "move" },
        ],
        moves: ["Move Pyke to the lower-right corner"],
      },
    });
    const run = await runNode([
      "tools/run-jcc-pending-host-coach-response.mjs",
      "--pipeline", pipelineFile,
      "--out-dir", tmp,
      "--agent-response", responseFile,
    ]);
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.status, "completed");
    assert.equal(parsed.advice_response?.coach_response?.final_text, "外面两家质量高，下一波建议先补前排稳血。");
    assert.equal(parsed.advice_response?.coach_response?.pinned_result, null);
    assert(
      parsed.advice_response?.coach_response?.soft_quality_diagnostics?.includes("lineup_card_not_publishable"),
      "an unbound positioning draft must be downgraded without losing the selected pipeline response",
    );
  } finally {
    await rmRetry(tmp);
  }
}

async function verifyModeVisualRefreshTool() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-visual-refresh-"));
  try {
    await writeJson(path.join(tmp, "summary.json"), {
      schema: "verify-summary",
      match_session_id: "verify-match",
      latest_phase_status: { s: 1 },
    });
    await writeJson(path.join(tmp, "pending-visual-requests.json"), {
      schema: "jcc-runtime-pending-visual-requests-v1",
      match_session_id: "verify-match",
      pending: [],
    });
    for (const mode of ["item_choice", "refresh_self_state"]) {
      const run = await runNode([
        "tools/request-jcc-choice-visual-refresh.mjs",
        "--watch-dir", tmp,
        "--mode", mode,
        "--source", "verify",
        ...(mode === "refresh_self_state" ? [] : ["--compatibility-calibration"]),
      ]);
      assert.equal(run.code, 0, `${mode}\n${run.stdout}\n${run.stderr}`);
      const parsed = JSON.parse(run.stdout);
      assert.equal(parsed.request.mode, mode);
      assert.equal(parsed.request.visual_backend, "host_cli_multimodal");
      assert.equal(parsed.request.storage_policy.persist_raw_frame, false);
      if (mode !== "refresh_self_state") {
        assert.equal(parsed.request.compatibility_calibration, true);
        assert.equal(parsed.request.state_policy.do_not_promote_choice_candidates, true);
      }
      assert.equal(parsed.visual_requests?.queue?.[0]?.request_id, parsed.request.request_id);
    }
    const pending = JSON.parse(await readFile(path.join(tmp, "pending-visual-requests.json"), "utf8"));
    assert.equal(pending.pending.length, 2);
    for (const removedMode of ["opponent_power", "opponent_positioning"]) {
      const removed = await runNode([
        "tools/request-jcc-choice-visual-refresh.mjs",
        "--watch-dir", tmp,
        "--mode", removedMode,
        "--source", "verify",
      ]);
      assert.notEqual(removed.code, 0, `${removedMode} must be rejected`);
      assert.match(removed.stderr || removed.stdout, /Unsupported --mode/, `${removedMode} should fail explicitly`);
    }
  } finally {
    await rmRetry(tmp);
  }
}

async function verifyLiveStateSummaryUsesRuntimeFieldNames() {
  const summary = compactLiveStateForHost({
    schema: "verify-live-state",
    own_board: {
      units: [
        { champion_name: "潘森", cost: 2, star_level: 2, position: { row: 2, col: 3 } },
      ],
    },
    bench: {
      bench_units: [
        { champion_name: "古拉加斯", cost: 2, star_level: 1 },
      ],
    },
    shop: {
      shop_units: [
        { champion_name: "派克", cost: 2 },
      ],
    },
  });
  assert.equal(summary.own_board.units[0].name, "潘森");
  assert.equal(summary.own_bench.units[0].name, "古拉加斯");
  assert.equal(summary.shop.units[0].name, "派克");
}

async function verifyUiContracts() {
  const service = await readText("ui/electron/runtime-service.js");
  const app = await readText("ui/src/App.tsx");
  const bridge = await readText("ui/src/runtimeBridge.ts");
  assert(service.includes('status: "mode_set_choice_ready_for_user_report"'), "setMode must arm active choice modes for a current-match user report");
  assert(!service.includes('status: "mode_set_choice_ready_for_manual_ocr"'), "setMode must not expose the retired manual-choice OCR state");
  assert(service.includes("tryFastChoiceTextObservation(requestedMode"), "user messages in choice modes must run current-frame OCR before any visual fallback");
  assert(service.includes("visualRuntimeModes.has(requestedMode)"), "sendMessage must guard visual modes with a fresh visual observation before pipeline");
  assert(service.includes("state.manual_match_variables = null"), "Start Match must clear previous match manual variables");
  assert(service.includes("tools/request-jcc-choice-visual-refresh.mjs"), "runtime service must allow the generic visual refresh tool");
  assert(service.includes("pinned_result"), "host prompt must ask for pinned_result");
  assert(app.includes("pinnedPlanFromResponse"), "App must convert pinned_result to pinned card state");
  assert(app.includes("applyPinnedResult(response, options.stream);"), "App must apply pinned results to the same delivery stream as the shared coach response");
  assert(app.includes("emitCoachResponse(result.response"), "App must route direct responses through the shared renderer that applies pinned_result");
  assert(bridge.includes("PinnedResultPayload"), "runtime bridge must type pinned_result payloads");
}

function assertObserveOnlyCruiseResult(result, label) {
  assert.equal(result.status, "runtime_observed", `${label} should observe current state without starting choice OCR`);
  assert.equal(result.observation_policy?.observe_only, true, `${label} must be observe-only`);
  assert.equal(result.observation_policy?.host_model_invoked, false, `${label} must not invoke host model`);
  assert.equal(result.observation_policy?.automatic_advice_must_use, "observeRuntimeTick_semantic_event_gate", `${label} must route automatic advice through observeRuntimeTick`);
}

async function verifyCruisePhasePollIsObserveOnly() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-phase-trigger-"));
  const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  const previousDataDir = process.env.JCC_RUNTIME_DATA_DIR;
  process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
  process.env.JCC_RUNTIME_DATA_DIR = tempRoot;
  try {
    const tag = `phase=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: { status: "active", match_session_id: "verify-match-session" },
      match_connection: {
        status: "waiting_for_live_state",
        connected_at: null,
        last_live_state_at: null,
        last_live_state_match_session_id: null,
        evidence: null,
      },
      response_task: { status: "idle", response_task_id: null },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      match_context: {
        choice_confirmations: [{
          kind: "augment",
          choice_stage_round: "2-1",
          selected: "verified augment",
          choice: "verified augment",
          observed_at: "2026-06-20T00:00:00.000Z",
        }],
      },
      host_cli: { provider: "codex", preferred: "codex", display_name: "Codex CLI", available: false },
      host_sessions: {
        daily: { status: "idle", route_id: "daily", context_keys: [] },
        match: { status: "idle", route_id: "match", match_session_id: "verify-match-session", context_keys: [] },
      },
      user_preferences: {},
      user_strategy_memory: { strategies: [] },
    });
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    const liveStateFile = path.join(runtimePaths.currentWatchDir, "cruise-live-state.json");
    await writeJson(liveStateFile, {
      schema: "jcc-phase-trigger-live-state-v1",
      match_session_id: "verify-match-session",
      phase: { stage_round: "2-4", status: "carousel" },
      own_board: { units: [{ name: "Pantheon", cost: 2, star: 2 }] },
      shop: { units: [{ name: "Gragas", cost: 2 }] },
    });
    const carousel = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assertObserveOnlyCruiseResult(carousel, "2-4 carousel cruise poll");
    assert.equal(carousel.state.match_connection?.status, "connected_to_live_match");
    const retiredChoiceVisualStateFile = path.join(tempRoot, "retired-choice-visual-live-state.json");
    await writeJson(retiredChoiceVisualStateFile, {
      schema: "jcc-visual-live-state-v1",
      match_session_id: "verify-match-session",
      phase: { stage_round: "2-4", status: "carousel" },
      own_board: { units: [{ name: "Pantheon", cost: 2, star: 2 }] },
      visual: {
        metadata: { source: "vision_model" },
        choices: {
          god_choice_options: [
            { name: "阿狸", confidence: 0.91, slot: 0 },
            { name: "艾克", confidence: 0.89, slot: 1 },
          ],
        }
      },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "latest-visual-live-state.json"), {
      schema: "jcc-runtime-latest-visual-live-state-ref-v1",
      generated_at: "2026-06-20T00:00:00.000Z",
      status: "completed",
      request: { request_id: "visual:verify-match-session:retired_choice:manual", mode: "god_sequence" },
      visual_live_state_file: retiredChoiceVisualStateFile,
      visual_observations_file: null,
    });
    await writeJson(liveStateFile, {
      schema: "jcc-phase-trigger-live-state-v1",
      match_session_id: "verify-match-session",
      phase: { stage_round: "3-2", status: "choice" },
      own_board: { units: [{ name: "Pantheon", cost: 2, star: 2 }] },
      shop: { units: [{ name: "Pyke", cost: 2 }] },
    });
    const augment = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assertObserveOnlyCruiseResult(augment, "3-2 cruise poll");

    const augmentVisualStateFile = path.join(tempRoot, "augment-visual-live-state.json");
    await writeJson(augmentVisualStateFile, {
      schema: "jcc-visual-live-state-v1",
      match_session_id: "verify-match-session",
      phase: { stage_round: "3-2", status: "choice" },
      own_board: { units: [{ name: "Pantheon", cost: 2, star: 2 }] },
      visual: {
        metadata: { source: "vision_model" },
        augments: {
          choices: [
            { name: "神赐锻炉", confidence: 0.91, slot: 0 },
            { name: "DD街区", confidence: 0.88, slot: 1 },
            { name: "清晰头脑", confidence: 0.87, slot: 2 },
          ],
        },
      },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "latest-visual-live-state.json"), {
      schema: "jcc-runtime-latest-visual-live-state-ref-v1",
      generated_at: "2026-06-20T00:00:01.000Z",
      status: "completed",
      request: { request_id: "visual:verify-match-session:augment_choice:manual", mode: "augment_choice" },
      visual_live_state_file: augmentVisualStateFile,
      visual_observations_file: null,
    });
    const augmentAgain = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assert.equal(augmentAgain.status, "unchanged_cruise_state_skipped");
    assert.equal(augmentAgain.observation_policy?.observe_only, true);
  } finally {
    if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
    if (previousDataDir === undefined) delete process.env.JCC_RUNTIME_DATA_DIR;
    else process.env.JCC_RUNTIME_DATA_DIR = previousDataDir;
    await rmRetry(tempRoot);
  }
}

async function verifyVisualLiveStateRequiresCurrentStageMatch() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-visual-stage-match-"));
  const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  const previousDataDir = process.env.JCC_RUNTIME_DATA_DIR;
  process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
  process.env.JCC_RUNTIME_DATA_DIR = tempRoot;
  try {
    const tag = `stage-match=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: { status: "active", match_session_id: "verify-match-session" },
      match_connection: { status: "connected_to_live_match" },
      response_task: { status: "idle", response_task_id: null },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      host_cli: { provider: "codex", preferred: "codex", display_name: "Codex CLI", available: false },
      host_sessions: {
        daily: { status: "idle", route_id: "daily", context_keys: [] },
        match: { status: "idle", route_id: "match", match_session_id: "verify-match-session", context_keys: [] },
      },
      user_preferences: {},
    });
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    const baseFile = path.join(runtimePaths.currentWatchDir, "cruise-live-state.json");
    const oldGodVisualFile = path.join(tempRoot, "old-god-visual-live-state.json");
    await writeJson(baseFile, {
      schema: "jcc-phase-trigger-live-state-v1",
      match_session_id: "verify-match-session",
      phase: { stage_round: "3-2", status: "choice" },
      own_board: { units: [{ name: "Pantheon", cost: 2, star: 2 }] },
    });
    await writeJson(oldGodVisualFile, {
      schema: "jcc-visual-live-state-v1",
      match_session_id: "verify-match-session",
      phase: { stage_round: "2-4", status: "choice" },
      visual: {
        choices: {
          god_choice_options: [
            { name: "阿狸", confidence: 0.91, slot: 0 },
            { name: "艾克", confidence: 0.89, slot: 1 },
          ],
        },
      },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "latest-visual-live-state.json"), {
      schema: "jcc-runtime-latest-visual-live-state-ref-v1",
      generated_at: "2026-06-20T00:00:02.000Z",
      status: "completed",
      request: { request_id: "visual:verify-match-session:god_sequence:old", mode: "god_sequence" },
      visual_live_state_file: oldGodVisualFile,
      visual_observations_file: null,
    });
    const active = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assertObserveOnlyCruiseResult(active, "3-2 cruise poll with stale god visual");

    const noStageVisualFile = path.join(tempRoot, "no-stage-visual-live-state.json");
    await writeJson(noStageVisualFile, {
      schema: "jcc-visual-live-state-v1",
      match_session_id: "verify-match-session",
      visual: {
        augments: {
          choices: [
            { name: "神赐锻炉", confidence: 0.91, slot: 0 },
            { name: "DD街区", confidence: 0.88, slot: 1 },
            { name: "清晰头脑", confidence: 0.87, slot: 2 },
          ],
        },
      },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "latest-visual-live-state.json"), {
      schema: "jcc-runtime-latest-visual-live-state-ref-v1",
      generated_at: "2026-06-20T00:00:03.000Z",
      status: "completed",
      request: { request_id: "visual:verify-match-session:augment_choice:manual", mode: "augment_choice" },
      visual_live_state_file: noStageVisualFile,
      visual_observations_file: null,
    });
    const stillWaiting = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assert.equal(stillWaiting.status, "unchanged_cruise_state_skipped");
    assert.equal(stillWaiting.observation_policy?.observe_only, true);
  } finally {
    if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
    if (previousDataDir === undefined) delete process.env.JCC_RUNTIME_DATA_DIR;
    else process.env.JCC_RUNTIME_DATA_DIR = previousDataDir;
    await rmRetry(tempRoot);
  }
}

async function verifyAugmentVisualDoesNotPolluteLaterCarouselCheckpoint() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-visual-stage-match-reverse-"));
  const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  const previousDataDir = process.env.JCC_RUNTIME_DATA_DIR;
  process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
  process.env.JCC_RUNTIME_DATA_DIR = tempRoot;
  try {
    const tag = `stage-match-reverse=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    const runtimePaths = storeModule.createRuntimePaths(root);
    service.setRuntimeServiceState({
      schema: "jcc-ui-runtime-state-v1",
      device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
      daily_session: { status: "inactive", mode: null },
      match_session: { status: "active", match_session_id: "verify-match-session" },
      match_connection: { status: "connected_to_live_match" },
      response_task: { status: "idle", response_task_id: null },
      active_mode: "cruise",
      runtime_triggers: { visual_by_stage: {} },
      match_context: {
        choice_confirmations: [
          { kind: "augment", choice_stage_round: "2-1", selected: "verified augment one", choice: "verified augment one" },
          { kind: "augment", choice_stage_round: "3-2", selected: "verified augment two", choice: "verified augment two" },
        ],
      },
      host_cli: { provider: "codex", preferred: "codex", display_name: "Codex CLI", available: false },
      host_sessions: {
        daily: { status: "idle", route_id: "daily", context_keys: [] },
        match: { status: "idle", route_id: "match", match_session_id: "verify-match-session", context_keys: [] },
      },
      user_preferences: {},
    });
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    const baseFile = path.join(runtimePaths.currentWatchDir, "cruise-live-state.json");
    const oldAugmentVisualFile = path.join(tempRoot, "old-augment-visual-live-state.json");
    await writeJson(baseFile, {
      schema: "jcc-phase-trigger-live-state-v1",
      match_session_id: "verify-match-session",
      phase: { stage_round: "3-4", status: "carousel" },
      own_board: { units: [{ name: "Pantheon", cost: 2, star: 2 }] },
    });
    await writeJson(oldAugmentVisualFile, {
      schema: "jcc-visual-live-state-v1",
      match_session_id: "verify-match-session",
      phase: { stage_round: "3-2", status: "choice" },
      visual: {
        augments: {
          choices: [
            { name: "神赐锻炉", confidence: 0.91, slot: 0 },
            { name: "DD街区", confidence: 0.88, slot: 1 },
            { name: "清晰头脑", confidence: 0.87, slot: 2 },
          ],
        },
      },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "latest-visual-live-state.json"), {
      schema: "jcc-runtime-latest-visual-live-state-ref-v1",
      generated_at: "2026-06-20T00:00:04.000Z",
      status: "completed",
      request: { request_id: "visual:verify-match-session:augment_choice:old", mode: "augment_choice" },
      visual_live_state_file: oldAugmentVisualFile,
      visual_observations_file: null,
    });
    const active = await service.handleRuntimeAction("pollCruiseAdvice", {}, {});
    assertObserveOnlyCruiseResult(active, "3-4 cruise poll with stale augment visual");
  } finally {
    if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
    if (previousDataDir === undefined) delete process.env.JCC_RUNTIME_DATA_DIR;
    else process.env.JCC_RUNTIME_DATA_DIR = previousDataDir;
    await rmRetry(tempRoot);
  }
}

await verifyHostResponseNormalization();
await verifyPendingCoachUsesSelectedPipeline();
await verifyModeVisualRefreshTool();
await verifyLiveStateSummaryUsesRuntimeFieldNames();
await verifyUiContracts();
await verifyCruisePhasePollIsObserveOnly();
await verifyVisualLiveStateRequiresCurrentStageMatch();
await verifyAugmentVisualDoesNotPolluteLaterCarouselCheckpoint();

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-runtime-goal-regression-v1",
  checks: [
    "host_cli_response_provenance_normalized",
    "pending_host_coach_uses_selected_pipeline",
    "choice_visual_calibration_and_active_self_refresh_queue",
    "live_state_summary_accepts_board_units_bench_units_shop_units",
    "pinned_result_typed_and_applied",
    "cruise_phase_poll_is_observe_only_and_does_not_start_choice_ocr",
    "visual_live_state_requires_current_stage_match",
    "augment_visual_does_not_pollute_later_carousel_checkpoint",
  ],
}, null, 2));
process.exit(0);
