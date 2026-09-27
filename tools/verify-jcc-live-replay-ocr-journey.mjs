import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeDaemonClient } from "../ui/electron/runtime-daemon-client.js";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const activeRuntimePaths = createRuntimePaths(repoRoot);
const activeRulesBundle = loadActiveRulesBundle({ repoRoot, runtimePaths: activeRuntimePaths });
const activeChoiceMechanics = [
  ...(activeRulesBundle.season_normal_rules?.choice_mechanics || []),
  ...(activeRulesBundle.season_special_rules?.mechanics?.choice_mechanics || []),
];
const DEFAULT_DURATION_MS = 25 * 60 * 1000;
const DEFAULT_DEVICE = "127.0.0.1:7555";
const REPLAY_VARIABLES = {
  god_1: "\u9524\u77f3",
  god_2: "\u4e9a\u7d22",
  encounter: "\u6700\u7ec8\u4e24\u540d\u73a9\u5bb6\u83b7\u5f9770\u91d1\u5e01",
  stargazing: "\u5973\u730e\u624b",
};

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = Number(options.timeoutMs || 0) > 0
      ? setTimeout(() => {
          child.kill();
          resolve({ code: 124, stdout, stderr: `${stderr}\nTimed out`.trim() });
        }, Number(options.timeoutMs))
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message || String(error) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function spawnNode(args, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return child;
}

function compactText(value, limit = 600) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function normalizeEconomy(economy = {}) {
  const unwrap = (value) => (value && typeof value === "object" && "value" in value ? value.value : value);
  return {
    hp: unwrap(economy.hp),
    gold: unwrap(economy.gold),
    level: unwrap(economy.level),
    xp: unwrap(economy.xp),
  };
}

function summarizeLiveState(liveState) {
  if (!liveState) return null;
  const phase = liveState.phase || {};
  const ownBoard = liveState.own_board || liveState.board || {};
  const ownBench = liveState.own_bench || liveState.bench || {};
  const shop = liveState.shop || {};
  const items = liveState.items || {};
  return {
    schema: liveState.schema || null,
    match_session_id: liveState.match_session_id || null,
    observed_at: liveState.observed_at || liveState.updated_at || null,
    stage_round: phase.stage_round || liveState.stage_round || phase.current_round_text || null,
    phase_status: phase.status ?? phase.mumu_status_code ?? null,
    economy: normalizeEconomy(liveState.economy || {}),
    board_count: Array.isArray(ownBoard.local_board_units) ? ownBoard.local_board_units.length
      : Array.isArray(ownBoard.board_units) ? ownBoard.board_units.length
        : Array.isArray(ownBoard.units) ? ownBoard.units.length
          : null,
    bench_count: Array.isArray(ownBench.units) ? ownBench.units.length
      : Array.isArray(ownBench.bench_units) ? ownBench.bench_units.length
        : null,
    shop_count: Array.isArray(shop.units) ? shop.units.length
      : Array.isArray(shop.shop_units) ? shop.shop_units.length
        : null,
    item_bench_count: Array.isArray(items.item_bench) ? items.item_bench.length : null,
    equipped_item_count: Array.isArray(items.equipped_items) ? items.equipped_items.length : null,
    current_choice_set: liveState.augments?.current_choice_set || liveState.god?.current_choice_set || liveState.item_choice?.current_choice_set || null,
  };
}

function liveStateStageRound(liveState) {
  return summarizeLiveState(liveState)?.stage_round || null;
}

function hasResolvedHudFacts(liveState) {
  const summary = summarizeLiveState(liveState);
  if (!summary) return false;
  return Boolean(
    summary.stage_round
    || summary.economy.hp !== null && summary.economy.hp !== undefined
    || summary.economy.gold !== null && summary.economy.gold !== undefined
    || summary.economy.level !== null && summary.economy.level !== undefined
    || summary.economy.xp !== null && summary.economy.xp !== undefined
  );
}

function hasCompleteCriticalHudFacts(liveState) {
  const summary = summarizeLiveState(liveState);
  if (!summary?.stage_round) return false;
  return ["hp", "gold", "level", "xp"].every((field) => (
    summary.economy[field] !== null && summary.economy[field] !== undefined && summary.economy[field] !== ""
  ));
}

function hasUsableCriticalHudFacts(liveState) {
  const summary = summarizeLiveState(liveState);
  if (!summary?.stage_round) return false;
  return ["hp", "gold", "level", "xp"].some((field) => (
    summary.economy[field] !== null && summary.economy[field] !== undefined && summary.economy[field] !== ""
  ));
}

function hasReplayRuntimeSignal(liveState) {
  const summary = summarizeLiveState(liveState);
  if (!summary) return false;
  return Boolean(
    summary.stage_round
    || summary.phase_status !== null && summary.phase_status !== undefined
    || summary.economy.hp !== null && summary.economy.hp !== undefined
    || summary.economy.gold !== null && summary.economy.gold !== undefined
    || summary.economy.level !== null && summary.economy.level !== undefined
    || summary.economy.xp !== null && summary.economy.xp !== undefined
    || Number(summary.board_count || 0) > 0
    || Number(summary.bench_count || 0) > 0
    || Number(summary.shop_count || 0) > 0
    || Number(summary.item_bench_count || 0) > 0
    || Number(summary.equipped_item_count || 0) > 0
    || summary.current_choice_set
  );
}

function summarizeSelfStateResult(parsed, code = 0, error = null) {
  return {
    code,
    ok: parsed?.ok === true,
    status: parsed?.status || null,
    observed_at: parsed?.observed_at || null,
    phase: parsed?.phase || null,
    economy: parsed?.economy || null,
    field_status: parsed?.field_status || null,
    error,
  };
}

function hostRequestHasSelectedContextSummary(entry) {
  const summary = entry?.summary || {};
  return Boolean(summary.has_live_state_summary && summary.has_runtime_context && summary.has_big_data);
}

function criticalHudFieldCoverage(observedSelfStateFields) {
  const required = ["phase.stage_round", "economy.hp", "economy.gold", "economy.level", "economy.xp"];
  const missing = required.filter((field) => !observedSelfStateFields[field]?.observed);
  return {
    required,
    missing,
    ok: missing.length === 0,
  };
}

function summarizeRuntimeState(state) {
  return {
    active_mode: state?.active_mode || null,
    match_session: state?.match_session || null,
    match_connection: state?.match_connection || null,
    response_task: state?.response_task ? {
      status: state.response_task.status,
      mode: state.response_task.mode || null,
      response_task_id: state.response_task.response_task_id || null,
      error: state.response_task.error || null,
    } : null,
    host_cli: state?.host_cli ? {
      provider: state.host_cli.provider || null,
      display_name: state.host_cli.display_name || null,
      available: Boolean(state.host_cli.available),
      command: state.host_cli.command || null,
      selected_model: state.host_cli.selected_model || null,
      default_model_label: state.host_cli.default_model_label || null,
    } : null,
    ocr_warmup: state?.runtime_triggers?.start_match_ocr_warmup || null,
    last_response: state?.last_response ? {
      generated_by: state.last_response.generated_by || null,
      confidence: state.last_response.confidence || null,
      final_text: compactText(state.last_response.final_text || "", 240),
    } : null,
  };
}

function summarizeFastChoiceDiagnostic(diagnostic) {
  if (!diagnostic) return null;
  const attempts = Array.isArray(diagnostic.result?.attempts)
    ? diagnostic.result.attempts
    : Array.isArray(diagnostic.summary?.attempts)
      ? diagnostic.summary.attempts
      : [];
  return {
    status: diagnostic.status || null,
    mode: diagnostic.mode || null,
    phase: diagnostic.phase || null,
    source: diagnostic.source || null,
    out_dir: diagnostic.out_dir || null,
    error: diagnostic.error || null,
    capture_started: diagnostic.capture_started ?? null,
    choice_counts: diagnostic.summary?.choice_counts || null,
    readable_choice_texts: diagnostic.summary?.readable_choice_texts || [],
    latest_attempt: diagnostic.summary?.latest_attempt || null,
    attempts_count: attempts.length,
    attempts_tail: attempts.slice(-5).map((attempt) => ({
      index: attempt?.index || null,
      ok: Boolean(attempt?.ok),
      elapsed_ms: attempt?.elapsed_ms || null,
      timing_ms: attempt?.timing_ms || null,
      out_dir: attempt?.out_dir || null,
      choice_counts: attempt?.choice_counts || null,
      readable_choice_texts: Array.isArray(attempt?.readable_choice_texts) ? attempt.readable_choice_texts.slice(0, 8) : [],
      error: attempt?.error || null,
    })),
    errors: diagnostic.summary?.errors || [],
    updated_at: diagnostic.updated_at || null,
  };
}

function modeForStage(stageRound) {
  return activeChoiceMechanics.find((entry) => entry.stages?.includes(stageRound))?.mode || null;
}

function contractForRuntimeChoiceMode(mode) {
  const base = activeRulesBundle.base_game_rules?.runtime_choice_modes?.[mode] || null;
  const seasonal = activeChoiceMechanics.find((entry) => entry.mode === mode) || null;
  return base || seasonal ? { ...(base || {}), ...(seasonal || {}), mode } : null;
}

function uiModeForRuntimeChoiceMode(mode) {
  return contractForRuntimeChoiceMode(mode)?.ui_mode_key || null;
}

function promptForRuntimeChoiceMode(mode) {
  return contractForRuntimeChoiceMode(mode)?.default_user_prompt || "选哪个？";
}

function parseTimeMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function latestStageObservation(observations) {
  let latest = null;
  for (const observation of observations) {
    if (!observation?.stage_round) continue;
    const observedAtMs = parseTimeMs(observation.observed_at);
    const elapsedMs = Number(observation.elapsed_ms);
    const rank = Number.isFinite(observedAtMs)
      ? observedAtMs
      : Number.isFinite(elapsedMs)
        ? elapsedMs
        : 0;
    if (!latest || rank >= latest.rank) latest = { ...observation, rank };
  }
  return latest;
}

async function waitForLiveState(file, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await readJsonOrNull(file);
    if (value) return value;
    await sleep(500);
  }
  return null;
}

async function runSelfStateOcrProbe({
  outRoot,
  matchSessionId,
  device,
  adb,
  runtimeDataDir,
  prefix,
  index,
}) {
  const selfStateOut = path.join(outRoot, "self-state-ocr", `${prefix}-${String(index).padStart(3, "0")}.json`);
  const selfState = await runNode([
    "tools/run-jcc-self-state-roi-ocr.mjs",
    "--out", selfStateOut,
    "--out-dir", path.dirname(selfStateOut),
    "--match-session-id", matchSessionId,
    "--device", device,
    "--adb", adb,
    "--capture-source", "mumu-shell",
  ], {
    timeoutMs: 30000,
    env: { JCC_RUNTIME_DATA_DIR: runtimeDataDir },
  });
  let parsed = null;
  try { parsed = selfState.code === 0 ? JSON.parse(selfState.stdout) : await readJsonOrNull(selfStateOut); } catch {}
  return {
    ...summarizeSelfStateResult(
      parsed,
      selfState.code,
      selfState.code === 0 ? null : compactText(selfState.stderr || selfState.stdout, 1000),
    ),
    artifact: selfStateOut,
  };
}

async function stopChild(child, name, events) {
  if (!child || child.exitCode !== null) return;
  events.push({ type: `${name}_stop_requested`, at: new Date().toISOString() });
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(2500),
  ]).catch(() => {});
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  const durationMs = Math.max(1000, Number(argValue("--duration-ms", String(DEFAULT_DURATION_MS))));
  const device = argValue("--device", DEFAULT_DEVICE);
  const outRoot = path.resolve(argValue("--out-dir", path.join(".jcc-runtime-data", "runtime-evidence", "live-replay-ocr-journey", new Date().toISOString().replace(/[:.]/g, "-"))));
  const keepData = hasFlag("--keep-data") || true;
  const realHost = hasFlag("--real-host");
  const sampleIntervalMs = Math.max(1000, Number(argValue("--sample-interval-ms", "5000")));
  const selfStateIntervalMs = Math.max(5000, Number(argValue("--self-state-interval-ms", "15000")));
  const hostProbeIntervalMs = Math.max(15000, Number(argValue("--host-probe-interval-ms", "45000")));
  const waitForReplayReady = !hasFlag("--no-wait-for-replay-ready");
  const replayReadyTimeoutMs = Math.max(0, Number(argValue("--replay-ready-timeout-ms", String(10 * 60 * 1000))));
  const replayReadyProbeIntervalMs = Math.max(2000, Number(argValue("--replay-ready-probe-interval-ms", "5000")));
  const adb = argValue("--adb", path.resolve(".omx", "bin", process.platform === "win32" ? "adb.exe" : "adb"));
  const requestedMatchSessionId = argValue("--match-session-id", null);
  let matchSessionId = requestedMatchSessionId || `replay-pending-${Date.now()}`;
  const progressFile = path.join(outRoot, "progress.jsonl");
  const reportFile = path.join(outRoot, "report.json");
  const runtimeDataDir = path.join(outRoot, "runtime-data");
  const watchDir = path.join(outRoot, "mumu-watch");
  const events = [];
  const daemonLogs = [];
  const samples = [];
  const resolvedSamples = [];
  const hostRequests = [];
  const hostDeliveries = [];
  const runtimeSelfStateRefreshResults = [];
  const selfStateResults = [];
  const choiceResults = [];
  const directChoiceOcrResults = [];
  const failures = [];

  const appendProgress = async (entry) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    await mkdir(path.dirname(progressFile), { recursive: true });
    await writeFile(progressFile, `${line}\n`, { flag: "a", encoding: "utf8" });
  };

  await mkdir(outRoot, { recursive: true });
  await writeJson(path.join(outRoot, "input-match-variables.json"), {
    schema: "jcc-live-replay-input-v1",
    requested_match_session_id: requestedMatchSessionId,
    match_session_id: matchSessionId,
    replay_variables: REPLAY_VARIABLES,
    device,
    duration_ms: durationMs,
    real_host: realHost,
    wait_for_replay_ready: waitForReplayReady,
    replay_ready_timeout_ms: replayReadyTimeoutMs,
  });

  const client = new RuntimeDaemonClient({
    repoRoot,
    electronDir: path.join(repoRoot, "ui", "electron"),
    nodeCommand: process.execPath,
    env: {
      ...process.env,
      JCC_RUNTIME_DATA_DIR: runtimeDataDir,
      JCC_RUNTIME_DAEMON_PORT: "0",
      JCC_UI_DISABLE_CODEX_EXEC: realHost ? "0" : "1",
      JCC_CHOICE_CAPTURE_SOURCE: "mumu-shell",
      JCC_ALLOW_COLD_CHOICE_OCR_FALLBACK: "0",
      JCC_ALLOW_COLD_SELF_STATE_ROI_OCR_FALLBACK: "0",
    },
    log: (type, payload) => daemonLogs.push({ type, payload, at: new Date().toISOString() }),
  });

  let watcher = null;
  try {
    await appendProgress({ type: "preflight_discovery_start", device });
    const discovery = await runNode([
      "tools/discover-jcc-mumu-adb-target.mjs",
      "--adb", adb,
      "--ports", device.split(":").at(-1) || "7555",
      "--timeout-ms", "8000",
    ], { timeoutMs: 30000 });
    let discoveryJson = null;
    try { discoveryJson = JSON.parse(discovery.stdout); } catch {}
    await writeJson(path.join(outRoot, "adb-discovery.json"), {
      code: discovery.code,
      stdout: discoveryJson || discovery.stdout,
      stderr: discovery.stderr,
    });
    assert(discovery.code === 0, `ADB discovery failed: ${discovery.stderr || discovery.stdout}`);
    const targetOk = (discoveryJson?.candidates || []).some((candidate) => candidate.serial === device && candidate.health?.usable_for_runtime !== false)
      || discoveryJson?.recommended_target?.serial === device;
    assert(targetOk, `ADB ${device} is not a healthy MuMu/JCC target; see ${path.join(outRoot, "adb-discovery.json")}`);

    await appendProgress({ type: "daemon_start" });
    await client.ensureStarted();
    client.subscribe((event) => {
      if (event?.type) events.push({ ...event, captured_at: new Date().toISOString() });
    }).catch((error) => {
      events.push({ type: "event_stream_error", error: error?.message || String(error), captured_at: new Date().toISOString() });
    });

    await client.action("bootstrap", {});
    const start = await client.action("startMatch", requestedMatchSessionId ? { match_session_id: requestedMatchSessionId } : {});
    await appendProgress({ type: "start_match", status: start.status || null });
    const startState = start.state || (await client.state()).state;
    matchSessionId = startState?.match_session?.match_session_id || matchSessionId;
    await writeJson(path.join(outRoot, "input-match-variables.json"), {
      schema: "jcc-live-replay-input-v1",
      requested_match_session_id: requestedMatchSessionId,
      match_session_id: matchSessionId,
      replay_variables: REPLAY_VARIABLES,
      device,
      duration_ms: durationMs,
      real_host: realHost,
      wait_for_replay_ready: waitForReplayReady,
      replay_ready_timeout_ms: replayReadyTimeoutMs,
    });
    const warmup = startState?.runtime_triggers?.start_match_ocr_warmup || null;
    assert(
      warmup?.status === "ready" || warmup?.status === "partial_failed" || warmup?.status === "warming_timeout",
      "Start Match did not record OCR warmup state"
    );
    if (warmup?.status !== "ready") failures.push({ type: "ocr_warmup_not_fully_ready_within_start_budget", warmup });

    const variables = await client.action("saveManualVariables", {
      encounter: REPLAY_VARIABLES.encounter,
      firstGod: `${REPLAY_VARIABLES.god_1} \u5951\u7ea6\u4e4b\u795e`,
      secondGod: `${REPLAY_VARIABLES.god_2} \u6df1\u6e0a\u4e4b\u795e`,
      observer: REPLAY_VARIABLES.stargazing,
    });
    await appendProgress({ type: "match_variables_saved", status: variables.status || null, message: variables.message || null });

    watcher = spawnNode([
      "tools/start-jcc-mumu-runtime-watch.mjs",
      "--adb", adb,
      "--device", device,
      "--out-dir", watchDir,
      "--match-session-id", matchSessionId,
      "--duration-ms", String(durationMs + (waitForReplayReady ? replayReadyTimeoutMs : 0) + 3000),
      "--summary-interval-ms", "3000",
      "--ports", device.split(":").at(-1) || "7555",
      "--clear-logcat-first",
      "--runtime-ui-mode", "cruise",
    ], {
      env: {
        JCC_RUNTIME_DATA_DIR: runtimeDataDir,
        JCC_CHOICE_CAPTURE_SOURCE: "mumu-shell",
      },
    });
    watcher.stdout.on("data", async (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        await appendProgress({ type: "watcher_stdout", text: compactText(line, 1000) }).catch(() => {});
      }
    });
    watcher.stderr.on("data", async (chunk) => {
      await appendProgress({ type: "watcher_stderr", text: compactText(String(chunk), 1000) }).catch(() => {});
    });
    watcher.on("close", (code) => {
      events.push({ type: "watcher_closed", code, captured_at: new Date().toISOString() });
    });

    const liveStateFile = path.join(watchDir, "cruise-live-state.json");
    const firstLive = await waitForLiveState(liveStateFile, 45000);
    assert(firstLive, `watcher did not materialize live_state within 45s: ${liveStateFile}`);
    await appendProgress({ type: "first_live_state", summary: summarizeLiveState(firstLive) });

    let readyEvidence = null;
    if (waitForReplayReady) {
      await appendProgress({
        type: "waiting_for_replay_ready",
        message: "Start playback now. Formal journey timing begins after MuMu live_state or HUD OCR shows in-game facts.",
        timeout_ms: replayReadyTimeoutMs,
      });
      const readyStartedAt = Date.now();
      let probeIndex = 0;
      while (Date.now() - readyStartedAt < replayReadyTimeoutMs) {
        probeIndex += 1;
        const liveState = await readJsonOrNull(liveStateFile);
        const resolvedLiveState = await client.action("getResolvedLiveState", {
          purpose: "live_replay_ready_gate",
        }).catch(() => null);
        const selfStateProbe = await runSelfStateOcrProbe({
          outRoot,
          matchSessionId,
          device,
          adb,
          runtimeDataDir,
          prefix: "ready-probe",
          index: probeIndex,
        }).catch((error) => ({ ok: false, status: "ready_probe_failed", error: error?.message || String(error) }));
        const liveSummary = summarizeLiveState(liveState);
        const resolvedSummary = summarizeLiveState(resolvedLiveState?.live_state);
        const selfStateLive = selfStateProbe ? {
          phase: selfStateProbe.phase || {},
          economy: selfStateProbe.economy || {},
        } : null;
        const readyByLive = hasReplayRuntimeSignal(liveState) || hasReplayRuntimeSignal(resolvedLiveState?.live_state);
        const readyByHud = Boolean(selfStateProbe?.ok || selfStateProbe?.phase?.stage_round);
        await appendProgress({
          type: "replay_ready_probe",
          probe_index: probeIndex,
          elapsed_ms: Date.now() - readyStartedAt,
          ready: readyByLive || readyByHud,
          live_state: liveSummary,
          resolved_live_state: resolvedSummary,
          self_state_ocr: selfStateProbe ? {
            ok: selfStateProbe.ok,
            status: selfStateProbe.status,
            phase: selfStateProbe.phase,
            economy: selfStateProbe.economy,
            artifact: selfStateProbe.artifact,
            error: selfStateProbe.error,
          } : null,
        });
        if (readyByLive || readyByHud) {
          readyEvidence = {
            ready_at: new Date().toISOString(),
            elapsed_ms: Date.now() - readyStartedAt,
            ready_by_live_state: readyByLive,
            ready_by_hud_ocr: readyByHud,
            live_state: liveSummary,
            resolved_live_state: resolvedSummary,
            self_state_ocr: selfStateProbe,
          };
          await appendProgress({ type: "replay_ready", evidence: readyEvidence });
          break;
        }
        await sleep(replayReadyProbeIntervalMs);
      }
      assert(readyEvidence, `Replay did not become ready within ${replayReadyTimeoutMs}ms; start playback or inspect ${progressFile}`);
    }

    const startedAt = Date.now();
    let lastSelfStateAt = 0;
    let lastHostProbeAt = 0;
    let lastChoiceStage = null;
    while (Date.now() - startedAt < durationMs) {
      const elapsedMs = Date.now() - startedAt;
      const liveState = await readJsonOrNull(liveStateFile);
      const runtime = await client.state().catch((error) => ({ ok: false, error: error?.message || String(error) }));
      const resolvedLiveState = await client.action("getResolvedLiveState", {
        purpose: "live_replay_ocr_journey_sample",
      }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
      const queue = await client.queue({ limit: 20 }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
      const liveSummary = summarizeLiveState(liveState);
      const resolvedSummary = summarizeLiveState(resolvedLiveState?.live_state);
      const runtimeSummary = summarizeRuntimeState(runtime.state);
      resolvedSamples.push({
        elapsed_ms: elapsedMs,
        status: resolvedLiveState?.status || null,
        ok: resolvedLiveState?.ok === true,
        file: resolvedLiveState?.file || null,
        freshness: resolvedLiveState?.freshness || null,
        live_state: resolvedSummary,
      });
      samples.push({
        elapsed_ms: elapsedMs,
        live_state: liveSummary,
        resolved_live_state: resolvedSummary,
        runtime: runtimeSummary,
        queue_count: Array.isArray(queue.queue) ? queue.queue.length : null,
        queue_running: Array.isArray(queue.queue) ? queue.queue.filter((item) => item.status === "running").length : null,
      });

      const observe = await client.action("observeRuntimeTick", {}).catch((error) => ({ ok: false, error: error?.message || String(error) }));
      const delivery = await client.action("deliverReadyResponse", {}).catch((error) => ({ ok: false, error: error?.message || String(error) }));
      if (delivery?.status && !["no_response_ready", "response_pending", "response_running"].includes(delivery.status)) {
        hostDeliveries.push({
          elapsed_ms: elapsedMs,
          source: "deliverReadyResponse_after_observe",
          ok: delivery.ok === true,
          status: delivery.status,
          has_response: Boolean(delivery.response?.final_text || delivery.response?.content),
          response_task_status: delivery.response_task?.status || null,
          error: delivery.error || null,
        });
      }
      if (observe?.host_request) {
        hostRequests.push({
          elapsed_ms: elapsedMs,
          source: "observeRuntimeTick",
          status: observe.status,
          mode: observe.host_request.mode || null,
          summary: observe.host_request.context ? {
            has_live_state_summary: Boolean(observe.host_request.context.live_state_summary),
            has_runtime_context: Boolean(observe.host_request.runtime_context || observe.host_request.context.runtime_context),
            has_big_data: Boolean(observe.host_request.daily_big_data || observe.host_request.context.daily_big_data),
            user_message: observe.host_request.user_message || null,
          } : null,
        });
      }
      if (!realHost && elapsedMs - lastHostProbeAt >= hostProbeIntervalMs) {
        lastHostProbeAt = elapsedMs;
        const hostProbe = await client.action("sendMessage", {
          mode: "cruise",
          text: "巡航中：根据当前结构化状态给一句简短建议。",
        }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
        if (hostProbe?.host_request || hostProbe?.state?.response_task?.host_request) {
          const request = hostProbe.host_request || hostProbe.state.response_task.host_request;
          hostRequests.push({
            elapsed_ms: elapsedMs,
            source: "sendMessage_cruise_host_probe",
            status: hostProbe.status,
            mode: request.mode || null,
            summary: request.context ? {
              has_live_state_summary: Boolean(request.context.live_state_summary),
              has_runtime_context: Boolean(request.runtime_context || request.context.runtime_context),
              has_big_data: Boolean(request.daily_big_data || request.context.daily_big_data),
              user_message: request.user_message || null,
            } : null,
          });
        } else {
          hostRequests.push({
            elapsed_ms: elapsedMs,
            source: "sendMessage_cruise_host_probe",
            status: hostProbe?.status || null,
            mode: null,
            ok: hostProbe?.ok === true,
            error: hostProbe?.error || null,
          });
        }
        await client.action("stopResponse", {}).catch(() => null);
      }

      if (elapsedMs - lastSelfStateAt >= selfStateIntervalMs) {
        lastSelfStateAt = elapsedMs;
        const runtimeRefresh = await client.action("sendMessage", {
          mode: "cruise",
          text: "刷新我方状态。",
        }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
        runtimeSelfStateRefreshResults.push({
          elapsed_ms: elapsedMs,
          ok: runtimeRefresh?.ok === true,
          status: runtimeRefresh?.status || null,
          response: runtimeRefresh?.response ? {
            final_text: runtimeRefresh.response.final_text || null,
            confidence: runtimeRefresh.response.confidence || null,
          } : null,
          self_state_refresh: runtimeRefresh?.self_state_refresh || null,
          refresh_result_status: runtimeRefresh?.refresh_result?.status || null,
          error: runtimeRefresh?.error || null,
        });
        const selfStateProbe = await runSelfStateOcrProbe({
          outRoot,
          matchSessionId,
          device,
          adb,
          runtimeDataDir,
          prefix: "self-state",
          index: selfStateResults.length + 1,
        });
        selfStateResults.push({
          elapsed_ms: elapsedMs,
          ...selfStateProbe,
        });
      }

      const postRefreshResolved = runtimeSelfStateRefreshResults.length
        ? await client.action("getResolvedLiveState", {
            purpose: "live_replay_ocr_journey_post_self_state_refresh",
          }).catch((error) => ({ ok: false, error: error?.message || String(error) }))
        : null;
      const postRefreshResolvedSummary = summarizeLiveState(postRefreshResolved?.live_state);
      const latestSelfState = selfStateResults.at(-1) || null;
      const stageObservation = latestStageObservation([
        {
          source: "post_refresh_resolved_live_state",
          stage_round: postRefreshResolvedSummary?.stage_round || null,
          observed_at: postRefreshResolvedSummary?.observed_at || null,
          elapsed_ms: elapsedMs,
        },
        {
          source: "resolved_live_state",
          stage_round: resolvedSummary?.stage_round || null,
          observed_at: resolvedSummary?.observed_at || null,
          elapsed_ms: elapsedMs,
        },
        {
          source: "raw_watcher_live_state",
          stage_round: liveSummary?.stage_round || null,
          observed_at: liveSummary?.observed_at || null,
          elapsed_ms: elapsedMs,
        },
        {
          source: "self_state_roi_ocr",
          stage_round: latestSelfState?.phase?.stage_round || null,
          observed_at: latestSelfState?.observed_at || null,
          elapsed_ms: latestSelfState?.elapsed_ms,
        },
      ]);
      const stageForChoice = stageObservation?.stage_round || null;
      const choiceMode = modeForStage(stageForChoice);
      if (choiceMode && lastChoiceStage !== stageForChoice) {
        lastChoiceStage = stageForChoice;
        const uiMode = uiModeForRuntimeChoiceMode(choiceMode);
        const prompt = promptForRuntimeChoiceMode(choiceMode);
        let setModeResult = null;
        let sendChoiceResult = null;
        if (uiMode) {
          setModeResult = await client.action("setMode", { mode: uiMode }).catch((error) => ({
            ok: false,
            error: error?.message || String(error),
          }));
          sendChoiceResult = await client.action("sendMessage", {
            mode: uiMode,
            text: prompt,
          }).catch((error) => ({
            ok: false,
            error: error?.message || String(error),
          }));
        }
        choiceResults.push({
          elapsed_ms: elapsedMs,
          stage_round: stageForChoice,
          trigger_stage_source: stageObservation?.source || null,
          trigger_stage_observed_at: stageObservation?.observed_at || null,
          mode: choiceMode,
          product_path: "setMode_then_sendMessage",
          product_path_kind: "manual_choice_mode_product_path",
          product_path_scope: "script_drives_the_same_manual_mode_and_sendMessage_path_as_the_UI;not_unattended_cruise_auto_choice",
          set_mode: setModeResult ? {
            ok: setModeResult.ok === true,
            status: setModeResult.status || null,
            runtime_mode: setModeResult.runtime_mode || null,
            worker_prewarm_status: setModeResult.warmup?.status || null,
            error: setModeResult.error || null,
          } : null,
          send_message: sendChoiceResult ? {
            ok: sendChoiceResult.ok === true,
            status: sendChoiceResult.status || null,
            response_task_status: sendChoiceResult.state?.response_task?.status || null,
            visual_status: sendChoiceResult.state?.visual_request_status?.status || null,
            has_fast_choice_text: Boolean(sendChoiceResult.fast_choice_text || sendChoiceResult.state?.visual_request_status?.fast_choice_text),
            has_host_request: Boolean(sendChoiceResult.host_request || sendChoiceResult.state?.response_task?.host_request),
            has_response: Boolean(sendChoiceResult.response),
            message: sendChoiceResult.message || null,
            error: sendChoiceResult.error || null,
            fast_choice_diagnostic: summarizeFastChoiceDiagnostic(
              sendChoiceResult.state?.runtime_triggers?.last_fast_choice_text
                || sendChoiceResult.state?.visual_request_status?.last_fast_choice_text
                || null,
            ),
            fast_choice_failure: summarizeFastChoiceDiagnostic(
              sendChoiceResult.state?.runtime_triggers?.last_fast_choice_text_failure
                || sendChoiceResult.state?.visual_request_status?.last_fast_choice_text_failure
                || null,
            ),
          } : null,
          ok: Boolean(
            setModeResult?.ok === true
            && sendChoiceResult?.ok === true
            && [
              "awaiting_host_cli_agent_response",
              "completed",
              "choice_confirmation_recorded",
            ].includes(sendChoiceResult?.status)
          ),
        });
        const choiceDelivery = await client.action("deliverReadyResponse", {}).catch((error) => ({ ok: false, error: error?.message || String(error) }));
        if (choiceDelivery?.status && !["no_response_ready", "response_pending", "response_running"].includes(choiceDelivery.status)) {
          hostDeliveries.push({
            elapsed_ms: elapsedMs,
            source: "deliverReadyResponse_after_manual_choice",
            ok: choiceDelivery.ok === true,
            status: choiceDelivery.status,
            has_response: Boolean(choiceDelivery.response?.final_text || choiceDelivery.response?.content),
            response_task_status: choiceDelivery.response_task?.status || null,
            error: choiceDelivery.error || null,
          });
        }
        const script = contractForRuntimeChoiceMode(choiceMode)?.roi_tool;
        if (!script) throw new Error(`Active choice mode ${choiceMode} does not declare roi_tool`);
        const choiceOutDir = path.join(outRoot, "choice-ocr", `${stageForChoice}-${choiceMode}`);
        const choice = await runNode([
          script,
          "--out-dir", choiceOutDir,
          "--timeout-ms", "10000",
          "--interval-ms", "1000",
          "--device", device,
          "--capture-source", "mumu-shell",
          "--match-session-id", matchSessionId,
          "--live-state", liveStateFile,
        ], {
          timeoutMs: 30000,
          env: { JCC_RUNTIME_DATA_DIR: runtimeDataDir },
        });
        let parsed = null;
        try { parsed = choice.stdout ? JSON.parse(choice.stdout) : null; } catch {}
        directChoiceOcrResults.push({
          elapsed_ms: elapsedMs,
          stage_round: stageForChoice,
          trigger_stage_source: stageObservation?.source || null,
          trigger_stage_observed_at: stageObservation?.observed_at || null,
          mode: choiceMode,
          code: choice.code,
          ok: parsed?.ok === true,
          status: parsed?.status || null,
          selected_report: parsed?.selected_report || null,
          elapsed_ocr_ms: parsed?.elapsed_ms || null,
          error: choice.code === 0 ? null : compactText(choice.stderr || choice.stdout, 1000),
          out_dir: choiceOutDir,
        });
      }

      await appendProgress({
        type: "sample",
        elapsed_ms: elapsedMs,
        live_state: liveSummary,
        resolved_live_state: resolvedSummary,
        runtime: runtimeSummary,
        observe_status: observe?.status || null,
      });
      await sleep(sampleIntervalMs);
    }

    const finalState = await client.state();
    const finalLive = await readJsonOrNull(liveStateFile);
    const finalResolved = await client.action("getResolvedLiveState", {
      purpose: "live_replay_ocr_journey_final",
    }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
    const observedSelfStateFields = {};
    for (const result of selfStateResults) {
      for (const [field, status] of Object.entries(result.field_status || {})) {
        if (!observedSelfStateFields[field]) observedSelfStateFields[field] = { observed: 0, total: 0, last_raw_text: null };
        observedSelfStateFields[field].total += 1;
        if (status?.status === "observed") {
          observedSelfStateFields[field].observed += 1;
          observedSelfStateFields[field].last_raw_text = status.raw_text || null;
        }
      }
    }
    const hudCoverage = criticalHudFieldCoverage(observedSelfStateFields);
    const hudOcrOk = selfStateResults.length > 0 && selfStateResults.every((entry) => entry.ok) && hudCoverage.ok;
    const runtimeResolvedSamplesWithHud = resolvedSamples.filter((entry) => hasResolvedHudFacts(entry.live_state)).length;
    const runtimeResolvedSamplesWithUsableHud = resolvedSamples.filter((entry) => hasUsableCriticalHudFacts(entry.live_state)).length;
    const runtimeResolvedSamplesWithCompleteHud = resolvedSamples.filter((entry) => hasCompleteCriticalHudFacts(entry.live_state)).length;
    const runtimeLiveStatePromoted = hasUsableCriticalHudFacts(finalResolved?.live_state) || runtimeResolvedSamplesWithUsableHud > 0;
    const runtimeSelfStateRefreshOk = runtimeSelfStateRefreshResults.length > 0 && runtimeSelfStateRefreshResults.some((entry) => entry.ok);
    const selfStateStages = [...new Set(selfStateResults.map((entry) => entry.phase?.stage_round).filter(Boolean))];
    const choiceCheckpointStages = selfStateStages.filter((stageRound) => modeForStage(stageRound));
    const choiceSensingExpected = choiceCheckpointStages.length > 0;
    const choiceRunsFailed = choiceResults.some((entry) => entry.ok !== true);
    const productManualChoicePathOk = (!choiceSensingExpected || choiceResults.length > 0) && !choiceRunsFailed;
    const productAutoChoicePathExpected = hasFlag("--expect-auto-choice");
    const productAutoChoicePathOk = productAutoChoicePathExpected
      ? choiceResults.some((entry) => entry.product_path_kind === "auto_choice_product_path" && entry.ok)
      : null;
    const hostRequestExpected = !realHost;
    const hostRequestsWithSelectedContext = hostRequests.filter(hostRequestHasSelectedContextSummary).length;
    const hostDeliveryOk = realHost
      ? hostDeliveries.some((entry) => entry.ok === true && entry.has_response)
      : true;
    const hostRequestOk = realHost
      ? hostDeliveryOk
      : hostRequestsWithSelectedContext > 0;
    const acceptance = {
      raw_mumu_ok: Boolean(finalLive) && samples.length > 0,
      hud_ocr_ok: hudOcrOk,
      runtime_live_state_promoted: runtimeLiveStatePromoted,
      runtime_self_state_refresh_ok: runtimeSelfStateRefreshOk,
      choice_sensing_expected: choiceSensingExpected,
      choice_checkpoint_stages: choiceCheckpointStages,
      product_manual_choice_path_ok: productManualChoicePathOk,
      product_auto_choice_path_expected: productAutoChoicePathExpected,
      product_auto_choice_path_ok: productAutoChoicePathOk,
      choice_runs_failed: choiceRunsFailed,
      host_request_expected: hostRequestExpected,
      host_request_ok: hostRequestOk,
      host_delivery_ok: hostDeliveryOk,
      evidence: {
        raw_live_state_file: liveStateFile,
        resolved_samples: resolvedSamples.length,
        resolved_samples_with_hud: runtimeResolvedSamplesWithHud,
        resolved_samples_with_usable_hud: runtimeResolvedSamplesWithUsableHud,
        resolved_samples_with_complete_hud: runtimeResolvedSamplesWithCompleteHud,
        runtime_self_state_refresh_runs: runtimeSelfStateRefreshResults.length,
        self_state_ocr_runs: selfStateResults.length,
        choice_ocr_runs: choiceResults.length,
        direct_choice_ocr_runs: directChoiceOcrResults.length,
        host_requests: hostRequests.length,
        host_requests_with_selected_context: hostRequestsWithSelectedContext,
        host_deliveries: hostDeliveries.length,
        critical_hud_fields: hudCoverage,
      },
    };
    const acceptanceFailures = [];
    if (!acceptance.raw_mumu_ok) acceptanceFailures.push({ type: "acceptance_raw_mumu_missing" });
    if (!acceptance.hud_ocr_ok) acceptanceFailures.push({ type: "acceptance_hud_ocr_failed", critical_hud_fields: hudCoverage });
    if (!acceptance.runtime_self_state_refresh_ok) acceptanceFailures.push({ type: "acceptance_runtime_self_state_refresh_failed" });
    if (!acceptance.runtime_live_state_promoted) acceptanceFailures.push({ type: "acceptance_runtime_live_state_not_promoted" });
    if (!acceptance.product_manual_choice_path_ok) acceptanceFailures.push({
      type: choiceRunsFailed ? "acceptance_choice_ocr_failed" : "acceptance_choice_checkpoint_reached_but_no_choice_ocr",
      choice_checkpoint_stages: choiceCheckpointStages,
      choice_results: choiceResults.map((entry) => ({
        stage_round: entry.stage_round,
        mode: entry.mode,
        product_path: entry.product_path,
        set_mode_status: entry.set_mode?.status || null,
        send_message_status: entry.send_message?.status || null,
        response_task_status: entry.send_message?.response_task_status || null,
        visual_status: entry.send_message?.visual_status || null,
        has_fast_choice_text: entry.send_message?.has_fast_choice_text || false,
        has_host_request: entry.send_message?.has_host_request || false,
        ok: entry.ok,
      })),
    });
    if (productAutoChoicePathExpected && !acceptance.product_auto_choice_path_ok) {
      acceptanceFailures.push({
        type: "acceptance_auto_choice_path_not_proven",
        note: "This harness normally proves the manual UI choice path by setMode+sendMessage. Pass --expect-auto-choice only when unattended auto choice is a product requirement for this run.",
      });
    }
    if (!acceptance.host_request_ok) acceptanceFailures.push({ type: "acceptance_host_request_missing" });
    failures.push(...acceptanceFailures);
    const report = {
      ok: failures.length === 0,
      schema: "jcc-live-replay-ocr-journey-v1",
      status: failures.length === 0 ? "completed_with_no_internal_failures" : "completed_with_failures",
      duration_ms: durationMs,
      wait_for_replay_ready: waitForReplayReady,
      replay_ready_timeout_ms: replayReadyTimeoutMs,
      replay_ready_evidence: readyEvidence,
      out_dir: outRoot,
      runtime_data_dir: runtimeDataDir,
      watch_dir: watchDir,
      device,
      match_session_id: matchSessionId,
      real_host: realHost,
      match_variables: {
        god_options: [`${REPLAY_VARIABLES.god_1} \u5951\u7ea6\u4e4b\u795e`, `${REPLAY_VARIABLES.god_2} \u6df1\u6e0a\u4e4b\u795e`],
        encounter: REPLAY_VARIABLES.encounter,
        stargazing: REPLAY_VARIABLES.stargazing,
      },
      summary: {
        samples: samples.length,
        host_requests: hostRequests.length,
        host_deliveries: hostDeliveries.length,
        self_state_ocr_runs: selfStateResults.length,
        self_state_ocr_ok: selfStateResults.filter((entry) => entry.ok).length,
        self_state_observed_fields: observedSelfStateFields,
        product_choice_runs: choiceResults.length,
        product_choice_ok: choiceResults.filter((entry) => entry.ok).length,
        direct_choice_ocr_runs: directChoiceOcrResults.length,
        direct_choice_ocr_ok: directChoiceOcrResults.filter((entry) => entry.ok).length,
        event_types: [...new Set(events.map((event) => event.type).filter(Boolean))],
        daemon_log_types: [...new Set(daemonLogs.map((entry) => entry.type).filter(Boolean))],
        final_live_state: summarizeLiveState(finalLive),
        final_resolved_live_state: summarizeLiveState(finalResolved?.live_state),
        final_runtime_state: summarizeRuntimeState(finalState.state),
      },
      acceptance,
      failures,
      samples,
      resolved_samples: resolvedSamples,
      runtime_self_state_refresh_results: runtimeSelfStateRefreshResults,
      host_requests: hostRequests,
      host_deliveries: hostDeliveries,
      self_state_results: selfStateResults,
      choice_results: choiceResults,
      direct_choice_ocr_results: directChoiceOcrResults,
      events_tail: events.slice(-100),
      daemon_logs_tail: daemonLogs.slice(-100),
      boundaries: {
        real_mumu_adb: true,
        real_screenshot_ocr: true,
        host_cli_execution: realHost ? "enabled" : "disabled_by_default_for_sensing_validation; pass --real-host to test provider latency/auth",
        raw_frames: "transient; OCR scripts delete frames/ROI after structured artifacts",
      },
    };
    await writeJson(reportFile, report);
    if (!report.ok) process.exitCode = 1;
    console.log(JSON.stringify({
      ok: report.ok,
      report: reportFile,
      summary: report.summary,
      acceptance: report.acceptance,
      failures: report.failures.slice(0, 10),
      next_step: "Inspect report.self_state_results, report.choice_results, and report.host_requests for real replay acceptance gaps.",
    }, null, 2));
  } catch (error) {
    failures.push({ type: "fatal", error: error?.stack || error?.message || String(error) });
    await writeJson(reportFile, {
      ok: false,
      schema: "jcc-live-replay-ocr-journey-v1",
      status: "failed",
      out_dir: outRoot,
      runtime_data_dir: runtimeDataDir,
      watch_dir: watchDir,
      device,
      match_session_id: matchSessionId,
      failures,
      samples,
      resolved_samples: resolvedSamples,
      runtime_self_state_refresh_results: runtimeSelfStateRefreshResults,
      host_requests: hostRequests,
      host_deliveries: hostDeliveries,
      self_state_results: selfStateResults,
      choice_results: choiceResults,
      direct_choice_ocr_results: directChoiceOcrResults,
      events_tail: events.slice(-100),
      daemon_logs_tail: daemonLogs.slice(-100),
    });
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  } finally {
    await stopChild(watcher, "watcher", events).catch(() => {});
    client.stopEvents();
    await client.stop().catch(() => {});
    if (!keepData && process.exitCode !== 1) await rm(outRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main();
