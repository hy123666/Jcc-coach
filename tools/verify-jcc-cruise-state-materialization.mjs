import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { persistPipelineResult, runPipeline } from "./run-jcc-cruise-runtime-pipeline.mjs";

const root = path.resolve(import.meta.dirname, "..");

function fileUrl(file, tag) {
  return `${pathToFileURL(path.resolve(root, file)).href}?${tag}`;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runPipelineInProcess(options) {
  const result = await runPipeline(options);
  await persistPipelineResult(result, options);
  return result;
}

async function removeTempRootWithRetry(tempRoot) {
  const retryableCodes = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      return;
    } catch (error) {
      if (!retryableCodes.has(error?.code) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 75 + attempt * 75));
    }
  }
}

async function withRuntimeEnv(fn) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-cruise-state-materialization-"));
  const previousDisable = process.env.JCC_UI_DISABLE_CODEX_EXEC;
  const previousDataDir = process.env.JCC_RUNTIME_DATA_DIR;
  let runtimeService = null;
  process.env.JCC_UI_DISABLE_CODEX_EXEC = "1";
  process.env.JCC_RUNTIME_DATA_DIR = tempRoot;
  try {
    return await fn(tempRoot, (service) => { runtimeService = service; });
  } finally {
    if (runtimeService) {
      await runtimeService.handleRuntimeAction("shutdown", {
        reason: "verify_cruise_state_materialization_cleanup",
      }, null).catch(() => {});
      runtimeService.setRuntimeServiceCanonicalStateWriter(null);
      runtimeService.setRuntimeServiceEventWriter(null);
      runtimeService.configureRuntimeServicePaths({ dataRoot: previousDataDir });
    }
    if (previousDisable === undefined) delete process.env.JCC_UI_DISABLE_CODEX_EXEC;
    else process.env.JCC_UI_DISABLE_CODEX_EXEC = previousDisable;
    if (previousDataDir === undefined) delete process.env.JCC_RUNTIME_DATA_DIR;
    else process.env.JCC_RUNTIME_DATA_DIR = previousDataDir;
    await removeTempRootWithRetry(tempRoot);
  }
}

function baseRuntimeState(matchSessionId, overrides = {}) {
  return {
    schema: "jcc-ui-runtime-state-v1",
    device_connection: { status: "connected", adb_target: { serial: "verify-mumu" } },
    daily_session: { status: "inactive", mode: null },
    match_session: { status: "active", match_session_id: matchSessionId },
    match_connection: {
      status: "connected_to_live_match",
      connected_at: "2026-06-22T10:00:00.000Z",
      last_live_state_at: "2026-06-22T10:00:00.000Z",
      last_live_state_match_session_id: matchSessionId,
      initial_cruise_greeting_status: "completed",
      initial_cruise_greeting_at: "2026-06-22T10:00:00.000Z",
    },
    response_task: { status: "idle" },
    active_mode: "cruise",
    runtime_triggers: { visual_by_stage: {}, choice_pretriggers: {} },
    visual_request_status: { status: "idle" },
    self_state_refresh: { status: "idle" },
    host_cli: { provider: "codex", available: false },
    host_sessions: { daily: { status: "idle" }, match: { status: "idle", match_session_id: matchSessionId } },
    user_preferences: {},
    ...overrides,
  };
}

function liveStateFixture({
  matchSessionId = "verify-match",
  observedAt = "2026-06-22T10:00:00.000Z",
  stageRound = "2-6",
  gold = 37,
  hp = 100,
  level = 4,
} = {}) {
  return {
    schema: "verify-live-state",
    match_session_id: matchSessionId,
    observed_at: observedAt,
    phase: { stage_round: stageRound, status: 1, stage_round_source: "self_state_roi_ocr" },
    economy: { gold, hp, level, xp: { value: 4, to_next: 6 } },
    board: { board_units: [{ name: "verify_board_unit", star: 1 }] },
    bench: { bench_units: [{ name: "verify_bench_unit", star: 1 }] },
    shop: { shop_units: [{ name: "verify_shop_unit" }] },
    items: { item_bench: ["verify_sword", "verify_armor"] },
  };
}

async function verifyResolvedHudPhaseEconomyFeedsPipeline() {
  await withRuntimeEnv(async (_tempRoot, registerRuntimeService) => {
    const tag = `materialized-hud=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    registerRuntimeService(service);
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    const now = Date.now();
    const hudLiveStateFile = path.join(runtimePaths.currentWatchDir, "verify-fresh-hud-live-state.json");
    await writeJson(hudLiveStateFile, {
      schema: "verify-fresh-hud-live-state",
      match_session_id: "verify-match",
      observed_at: new Date(now).toISOString(),
      mode: "refresh_self_state",
      visual_applied: { mode: "refresh_self_state", source: "self_state_roi_ocr" },
      phase: { stage_round: "2-3", status: 1, stage_round_source: "self_state_roi_ocr" },
      economy: { gold: 37, hp: 100, level: 4, xp: { value: 4, to_next: 6 } },
    });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), {
      schema: "verify-base-live-state",
      match_session_id: "verify-match",
      observed_at: new Date(now - 20000).toISOString(),
      phase: { status: 1, stage_round: null },
      economy: { gold: null, hp: null, level: null, xp: null },
      board: { board_units: [{ name: "fresh_base_unit" }] },
      shop: { shop_units: [{ name: "fresh_shop_unit" }] },
      items: { item_bench: ["verify_sword"] },
    });

    service.setRuntimeServiceState(baseRuntimeState("verify-match", {
      self_state_refresh: {
        status: "completed_self_state_roi_ocr",
        last_completed_at: new Date(now).toISOString(),
        last_self_state_roi_completed_at: new Date(now).toISOString(),
        last_source: "self_state_roi_ocr",
        last_visual_live_state_file: hudLiveStateFile,
        last_self_state_roi_visual_live_state_file: hudLiveStateFile,
      },
    }));

    const resolved = await service.resolveActiveLiveStateForRuntime({ purpose: "cruise" });
    assert.equal(resolved.live_state.phase.stage_round, "2-3");
    assert.equal(resolved.live_state.economy.gold, 37);
    assert.equal(resolved.live_state.board.board_units[0].name, "fresh_base_unit");

    const materialized = await service.materializeResolvedLiveStateForRuntime(resolved, "verify_pipeline_input");
    assert(materialized.file && materialized.file !== resolved.file, "merged HUD state must be written to a resolved live_state file");
    assert(existsSync(materialized.file), "resolved live_state file must exist for pipeline consumption");
    const materializedJson = JSON.parse(await readFile(materialized.file, "utf8"));
    assert.equal(materializedJson.phase.stage_round, "2-3");
    assert.equal(materializedJson.economy.gold, 37);
    assert.equal(materializedJson.runtime_resolution?.schema, "jcc-runtime-resolved-live-state-v1");

    const result = await runPipelineInProcess({
      liveState: materialized.file,
      adviceState: path.join(runtimePaths.stateDir, "verify-advice-lifecycle.json"),
      mode: "cruise",
      retainFullState: true,
      now: new Date(now).toISOString(),
    });
    assert.equal(result.standardized_live_state.phase.stage_round.value, "2-3", "pipeline must see HUD-merged stage, not raw null stage");
    assert.equal(result.standardized_live_state.economy.gold.value, 37, "pipeline must see HUD-merged gold, not raw null gold");
    assert.deepEqual(
      result.standardized_live_state.items.item_bench.map((item) => item.name || item.value || item),
      ["verify_sword"],
      "string item names must remain readable item facts after provenance is attached",
    );
  });
}

async function verifyUnchangedFactSnapshotSkipsBackgroundCruiseBeforeModel() {
  await withRuntimeEnv(async (_tempRoot, registerRuntimeService) => {
    const tag = `unchanged-cruise=${Date.now()}`;
    const storeModule = await import(fileUrl("ui/electron/runtime-state-store.js", tag));
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    registerRuntimeService(service);
    const runtimePaths = storeModule.createRuntimePaths(root);
    await mkdir(runtimePaths.currentWatchDir, { recursive: true });
    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), liveStateFixture());
    service.setRuntimeServiceState(baseRuntimeState("verify-match"));

    const first = await service.handleRuntimeAction("pollCruiseAdvice", {}, null);
    assert.notEqual(first.status, "unchanged_cruise_state_skipped", "first observation of a fact snapshot must be allowed");
    assert(service.getRuntimeServiceState().cruise_state_fingerprint?.hash, "first observation must record a cruise state fingerprint");

    const afterFirst = service.getRuntimeServiceState();
    service.setRuntimeServiceState({
      ...afterFirst,
      response_task: { status: "idle" },
      visual_request_status: { status: "idle" },
    });

    const second = await service.handleRuntimeAction("pollCruiseAdvice", {}, null);
    assert.equal(second.status, "unchanged_cruise_state_skipped", "same structured fact snapshot must not be sent to background cruise again");
    assert.equal(second.cruise_state_fingerprint.repeated_count, 1, "repeat count should record suppressed duplicate polling");

    await writeJson(path.join(runtimePaths.currentWatchDir, "cruise-live-state.json"), liveStateFixture({
      observedAt: "2026-06-22T10:00:10.000Z",
      gold: 50,
    }));
    const third = await service.handleRuntimeAction("pollCruiseAdvice", {}, null);
    assert.notEqual(third.status, "unchanged_cruise_state_skipped", "changed facts such as gold must unlock background cruise");
  });
}

async function verifyBackgroundCruiseSemanticDedupeButUserQuestionsBypass() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-cruise-semantic-cooldown-"));
  try {
    const liveFile = path.join(tmp, "live.json");
    const lifecycleFile = path.join(tmp, "advice-lifecycle.json");
    await writeJson(liveFile, liveStateFixture({
      matchSessionId: "cooldown-match",
      observedAt: "2026-06-22T10:00:00.000Z",
      stageRound: "2-5",
    }));
    const firstResult = await runPipelineInProcess({
      liveState: liveFile,
      adviceState: lifecycleFile,
      mode: "cruise",
      now: "2026-06-22T10:00:00.000Z",
    });
    assert(
      !firstResult.response_events.some((event) => event.type === "advice_response_requested"),
      "raw background pipeline polling must not bypass the fixed-checkpoint strategic obligation queue",
    );
    assert.equal(
      firstResult.lifecycle.output_history.length,
      0,
      "fact-only background polling must not create a synthetic advice history entry",
    );

    await writeJson(liveFile, liveStateFixture({
      matchSessionId: "cooldown-match",
      observedAt: "2026-06-22T10:00:10.000Z",
      stageRound: "2-5",
      gold: 38,
    }));
    const secondResult = await runPipelineInProcess({
      liveState: liveFile,
      adviceState: lifecycleFile,
      mode: "cruise",
      now: "2026-06-22T10:00:10.000Z",
    });
    assert(
      !secondResult.response_events.some((event) => event.type === "advice_response_requested"),
      "background polling must remain fact-only for same-stage economy changes",
    );

    const userResult = await runPipelineInProcess({
      liveState: liveFile,
      adviceState: lifecycleFile,
      mode: "cruise",
      userMessage: "Should I buy this shop?",
      forceResponseReason: "user_message",
      now: "2026-06-22T10:00:20.000Z",
    });
    assert(
      userResult.response_events.some((event) => event.type === "advice_response_requested"),
      "user-initiated questions must bypass background cruise cooldown and still get a host response task",
    );
  } finally {
    await removeTempRootWithRetry(tmp);
  }
}

async function verifyChoiceWindowUsesCurrentMatchUserReport() {
  await withRuntimeEnv(async (_tempRoot, registerRuntimeService) => {
    const tag = `choice-user-report-gate=${Date.now()}`;
    const service = await import(fileUrl("ui/electron/runtime-service.js", tag));
    registerRuntimeService(service);
    service.setRuntimeServiceState(baseRuntimeState("verify-match"));

    const quietAtTarget = service.shouldQuietCruiseForUpcomingChoice({
      phase: { stage_round: "2-1", status: 4 },
    });
    assert(quietAtTarget, "background cruise must stay quiet while the player reports the current choice set");
    assert.equal(quietAtTarget.entry.mode, "augment_choice");
    assert.equal(quietAtTarget.entry.target_stage_round, "2-1");
    const modeResult = await service.handleRuntimeAction("setMode", { mode: "augment" }, null);
    assert.equal(modeResult.status, "mode_set_choice_ready_for_user_report");
    assert.equal(modeResult.runtime_mode, "augment_choice");
    assert.equal(modeResult.state?.visual_request_status, null, "entering a user-report choice mode must not create visual work");
    assert.equal(modeResult.user_report_contract?.report_required_before_advice, true);
    assert.equal(modeResult.user_report_contract?.no_ocr_or_vision_fallback, true);
  });
}

await verifyResolvedHudPhaseEconomyFeedsPipeline();
await verifyUnchangedFactSnapshotSkipsBackgroundCruiseBeforeModel();
await verifyBackgroundCruiseSemanticDedupeButUserQuestionsBypass();
await verifyChoiceWindowUsesCurrentMatchUserReport();

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-cruise-state-materialization-verifier-v2",
  checked: [
    "hud_merged_phase_economy_materialized_before_pipeline",
    "string_item_names_remain_readable_in_host_summary",
    "unchanged_fact_snapshot_skips_background_cruise_before_model",
    "background_cruise_semantic_dedupe_keeps_user_questions_answerable",
    "choice_window_quiets_background_cruise_for_current_match_user_report",
    "choice_mode_entry_does_not_create_visual_work",
    "choice_report_ui_contract_is_prefill_only",
  ],
}, null, 2)}\n`);
process.exit(0);
