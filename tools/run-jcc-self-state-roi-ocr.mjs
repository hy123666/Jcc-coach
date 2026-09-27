import crypto from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { startSharedRapidOcrWorker } from "./jcc-rapidocr-resident-worker.mjs";
import { runProcessTreeBounded as runProcess } from "./jcc_process_runner.mjs";

const DEFAULT_OUT_DIR = ".jcc-runtime-data/runtime-evidence/self-state-roi-ocr";
const DEFAULT_PYTHON = process.env.JCC_OCR_PYTHON || ".venv-ocr/Scripts/python.exe";
const DEFAULT_CONFIG = "data/runtime/jcc/rapidocr-ppocrv5-mobile.yaml";

const HUD_ROI_SCRIPTS = [
  { field: "stage", script: "tools/roi_stage.py", outputs: ["phase.stage_round"] },
  { field: "gold", script: "tools/roi_gold.py", outputs: ["economy.gold"] },
  { field: "level_xp", script: "tools/roi_level_xp.py", outputs: ["economy.level", "economy.xp"] },
  { field: "hp", script: "tools/roi_hp_local.py", outputs: ["economy.hp"] },
];

function usage() {
  return [
    "Usage:",
    "  node tools/run-jcc-self-state-roi-ocr.mjs [--out-dir <dir>] [--out <file>] [--match-session-id <id>] [--fixture-image <png>] [--fields <stage,gold,level_xp,hp|all>]",
    "",
    "Runs the new self-state OCR pipeline: one frame capture -> Python ROI crop tasks -> resident OCR worker -> field aggregator.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    python: DEFAULT_PYTHON,
    config: DEFAULT_CONFIG,
    fields: "all",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else if (arg === "--fixture-image") options.fixtureImage = argv[++index];
    else if (arg === "--capture-source") options.captureSource = argv[++index];
    else if (arg === "--device") options.device = argv[++index];
    else if (arg === "--connect") options.connect = argv[++index];
    else if (arg === "--adb") options.adb = argv[++index];
    else if (arg === "--fields") options.fields = argv[++index];
    else if (arg === "--python") options.python = argv[++index];
    else if (arg === "--config") options.config = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readJsonIfExists(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

async function writeJson(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function runNode(args, options = {}) {
  return runProcess(process.execPath, args, { cwd: path.resolve(import.meta.dirname, ".."), ...options });
}

async function runPython(args, options = {}) {
  return runProcess(path.resolve(options.python || DEFAULT_PYTHON), args, { cwd: process.cwd() });
}

export async function resolvePythonExecutable(requested) {
  const candidates = [
    requested,
    process.env.JCC_OCR_PYTHON,
    ".venv-ocr/Scripts/python.exe",
    ".venv/Scripts/python.exe",
  ].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (await fileExists(resolved)) return resolved;
  }
  return requested || DEFAULT_PYTHON;
}

export async function startSelfStateRapidOcrWorker(options) {
  return startSharedRapidOcrWorker(options);
}

function normalizeAdbOption(adb) {
  if (!adb || adb === "adb") {
    return process.env.JCC_ADB || path.resolve(".omx", "bin", process.platform === "win32" ? "adb.exe" : "adb");
  }
  return adb;
}

function normalizeRuntimeAdbTarget(target) {
  if (!target) return null;
  if (typeof target === "string") return target.trim() || null;
  return target.serial || target.device || target.adb_device_id || target.id || null;
}

async function resolveRuntimeDeviceOption(options) {
  if (options.device || options.fixtureImage) return options;
  const runtimeState = await readJsonIfExists(".jcc-runtime-data/state/jcc-ui-runtime-state.json");
  const serviceState = await readJsonIfExists(".jcc-runtime-data/runtime-evidence/mumu-gi-live/current-watch/service-state.json");
  const activeMatchSessionId = runtimeState?.match_session?.match_session_id || null;
  const serviceUpdatedAt = Date.parse(serviceState?.updated_at || "");
  const serviceFreshForMatch = Boolean(
    serviceState?.updated_at
    && (!activeMatchSessionId || !serviceState?.match_session_id || serviceState.match_session_id === activeMatchSessionId)
    && Number.isFinite(serviceUpdatedAt)
    && Date.now() - serviceUpdatedAt <= 30 * 60 * 1000
  );
  if (
    serviceFreshForMatch
    && (
      serviceState?.ok === false
      || ["mumu_target_not_found", "watcher_spawn_failed", "watcher_failed"].includes(serviceState?.status)
      || (serviceState?.status === "stopped" && !serviceState?.recommended_target)
    )
  ) {
    return options;
  }
  const serviceTarget = serviceFreshForMatch ? normalizeRuntimeAdbTarget(serviceState?.recommended_target) : null;
  if (serviceTarget) return { ...options, device: serviceTarget };
  const stateTarget = normalizeRuntimeAdbTarget(runtimeState?.device_connection?.adb_target);
  if (stateTarget) return { ...options, device: stateTarget };
  return options;
}

async function captureFrame(options, outDir) {
  const captureDir = path.join(outDir, "capture");
  await mkdir(captureDir, { recursive: true });
  const args = [
    "tools/capture-jcc-visual-frame.mjs",
    "--out-dir", captureDir,
    "--label", "self_state_roi_ocr",
    "--persist-frame",
  ];
  if (options.device) args.push("--device", options.device);
  if (options.connect) args.push("--connect", options.connect);
  if (options.adb) args.push("--adb", normalizeAdbOption(options.adb));
  if (options.fixtureImage) args.push("--fixture-image", options.fixtureImage);
  if (options.captureSource) args.push("--capture-source", options.captureSource);
  const result = await runNode(args, {
    timeoutMs: Number(options.captureTimeoutMs || process.env.JCC_SELF_STATE_ROI_FRAME_CAPTURE_TIMEOUT_MS || 12000),
  });
  if (result.code !== 0) throw new Error(`frame capture failed: ${result.stderr || result.stdout}`);
  return path.join(captureDir, "visual-frame.json");
}

function selectedRoiScripts(fieldsText) {
  const fields = String(fieldsText || "all").split(",").map((field) => field.trim().toLowerCase()).filter(Boolean);
  if (!fields.length || fields.includes("all")) return HUD_ROI_SCRIPTS;
  const selected = new Set(fields);
  return HUD_ROI_SCRIPTS.filter((entry) => selected.has(entry.field) || entry.outputs.some((output) => selected.has(output.toLowerCase())));
}

async function runRoiScript(script, framePath, outDir, options) {
  const scriptOutDir = path.join(outDir, path.basename(script, ".py"));
  const result = await runPython([
    path.resolve(script),
    "--frame", path.resolve(framePath),
    "--out-dir", scriptOutDir,
  ], { python: options.python, timeoutMs: Number(options.roiScriptTimeoutMs || process.env.JCC_SELF_STATE_ROI_SCRIPT_TIMEOUT_MS || 8000) });
  if (result.code !== 0) throw new Error(`${script} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

async function collectCropTasks(framePath, outDir, options) {
  const selectedScripts = selectedRoiScripts(options.fields);
  const batches = await Promise.all(
    selectedScripts
      .map((entry) => runRoiScript(entry.script, framePath, outDir, options)),
  );
  const tasks = batches.flatMap((batch) => batch.tasks || []);
  const requestedFields = [...new Set(selectedScripts.flatMap((entry) => entry.outputs))];
  const requestedFieldDiagnostics = {};
  selectedScripts.forEach((entry, index) => {
    const batch = batches[index] || {};
    const artifacts = batch.artifacts && typeof batch.artifacts === "object" ? batch.artifacts : {};
    for (const field of entry.outputs) {
      const fieldTaskCount = tasks.filter((task) => task.field === field).length;
      requestedFieldDiagnostics[field] = {
        source_script: entry.script,
        task_count: fieldTaskCount,
        roi_status: fieldTaskCount > 0
          ? "crop_task_emitted"
          : artifacts.status || "no_crop_task_emitted",
        scoreboard_layout_status: artifacts.scoreboard_layout_status || null,
        local_row_status: artifacts.local_row_status || null,
        selected_row: artifacts.selected_row ?? null,
      };
    }
  });
  return { batches, tasks, requestedFields, requestedFieldDiagnostics };
}

async function runOcrTasks(tasks, worker, requestedFields, requestedFieldDiagnostics, options) {
  const results = [];
  for (const task of tasks) {
    const singleLineNumeric = task.evidence?.ocr_profile === "single_line_numeric";
    const response = await worker.ocr(task.crop_image, task.task_id, {
      text_score: singleLineNumeric ? 0.2 : 0.35,
      use_det: !singleLineNumeric,
      use_cls: !singleLineNumeric,
      priority: "background",
      timeoutMs: Number(process.env.JCC_HUD_SELF_STATE_OCR_TASK_TIMEOUT_MS || 3500),
      ownerMatchSessionId: options.matchSessionId || null,
    });
    const text = (response.blocks || []).map((block) => String(block.text || "").trim()).filter(Boolean).join(" ");
    results.push({
      task_id: task.task_id,
      field: task.field,
      source_script: task.source_script,
      crop_image: task.crop_image,
      evidence: task.evidence || null,
      text,
      blocks: response.blocks || [],
      timing_ms: response.timing_ms || null,
    });
  }
  return {
    schema: "jcc-ocr-result-batch-v1",
    ok: true,
    requested_fields: requestedFields,
    requested_field_diagnostics: requestedFieldDiagnostics,
    results,
  };
}

async function aggregateFields(ocrResultFile, outFile, options) {
  const result = await runPython([
    path.resolve("tools/jcc_ocr_field_aggregator.py"),
    "--ocr-result", path.resolve(ocrResultFile),
    "--out", path.resolve(outFile),
  ], { python: options.python, timeoutMs: Number(options.aggregateTimeoutMs || process.env.JCC_SELF_STATE_ROI_AGGREGATE_TIMEOUT_MS || 8000) });
  if (result.code !== 0) throw new Error(`OCR field aggregation failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function hasSelfStateFact(facts) {
  return Boolean(
    facts?.phase?.stage_round
    || facts?.economy?.hp !== null && facts?.economy?.hp !== undefined
    || facts?.economy?.gold !== null && facts?.economy?.gold !== undefined
    || facts?.economy?.level !== null && facts?.economy?.level !== undefined
    || facts?.economy?.xp !== null && facts?.economy?.xp !== undefined
  );
}

function missingSelfStateFields(facts) {
  const missing = [];
  if (!facts?.phase?.stage_round) missing.push("phase.stage_round");
  for (const field of ["hp", "gold", "level", "xp"]) {
    const value = facts?.economy?.[field];
    if (value === null || value === undefined || value === "") missing.push(`economy.${field}`);
  }
  return missing;
}

async function writeMinimalLiveState({ facts, outDir, options, observedAt }) {
  if (!hasSelfStateFact(facts)) return null;
  const liveState = {
    schema: "jcc-visual-live-state-v1",
    match_session_id: options.matchSessionId || null,
    observed_at: observedAt,
    updated_at: observedAt,
    mode: "refresh_self_state",
    visual_applied: {
      mode: "refresh_self_state",
      source: "self_state_roi_ocr",
      policy: "phase_and_economy_only_without_base_live_state",
    },
    phase: facts.phase?.stage_round ? {
      stage_round: facts.phase.stage_round,
      current_round_text: facts.phase.stage_round,
      stage_round_source: "self_state_roi_ocr",
    } : {},
    economy: {},
    field_status: {},
    metadata: {
      source: "self_state_roi_ocr",
      scope: "hud_self_state_minimal_live_state",
      base_live_state: null,
    },
  };
  for (const [field, value] of Object.entries(facts.economy || {})) {
    if (value === null || value === undefined || value === "") continue;
    liveState.economy[field] = value;
  }
  for (const [field, status] of Object.entries(facts.field_status || {})) {
    if (status.status !== "observed") continue;
    liveState.field_status[field] = {
      status: "candidate",
      source: status.source || "self_state_roi_ocr",
      confidence: status.confidence ?? null,
      promotion_status: "self_state_roi_ocr_minimal_live_state",
      raw_text: status.raw_text || null,
    };
  }
  const out = path.join(outDir, "self-state-roi-visual-live-state.json");
  await writeJson(out, liveState);
  return out;
}

async function deleteCropImages(tasks) {
  for (const task of tasks) {
    if (task.crop_image) await rm(task.crop_image, { force: true });
  }
}

export async function runSelfStateRoiOcrWithWorker(optionsInput = {}, worker = null) {
  let options = {
    outDir: DEFAULT_OUT_DIR,
    python: DEFAULT_PYTHON,
    config: DEFAULT_CONFIG,
    ...optionsInput,
  };
  options = await resolveRuntimeDeviceOption(options);
  options.python = await resolvePythonExecutable(options.python);
  const outDir = path.resolve(options.outDir, `self-state-roi-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(outDir, { recursive: true });
  const frameFile = await captureFrame(options, outDir);
  const frame = await readJson(frameFile);
  const framePath = frame.image?.path ? path.resolve(frame.image.path) : null;
  if (!framePath) throw new Error("self-state ROI OCR requires a persisted current frame path");
  const cropTaskDir = path.join(outDir, "crop-tasks");
  const {
    batches,
    tasks,
    requestedFields,
    requestedFieldDiagnostics,
  } = await collectCropTasks(framePath, cropTaskDir, options);
  const ownedWorker = worker || await startSelfStateRapidOcrWorker({
    python: options.python,
    config: options.config,
    timeoutMs: Number(process.env.JCC_UI_SELF_STATE_ROI_OCR_WORKER_READY_TIMEOUT_MS || process.env.JCC_RAPIDOCR_WORKER_TIMEOUT_MS || 45000),
  });
  try {
    const ocrResult = await runOcrTasks(tasks, ownedWorker, requestedFields, requestedFieldDiagnostics, options);
    const cropTaskFile = path.join(outDir, "roi-crop-task-batches.json");
    const ocrResultFile = path.join(outDir, "ocr-result-batch.json");
    const factsFile = path.join(outDir, "self-state-facts.json");
    await writeJson(cropTaskFile, {
      schema: "jcc-roi-crop-task-batch-collection-v1",
      ok: true,
      frame: framePath,
      batches,
      tasks,
    });
    await writeJson(ocrResultFile, ocrResult);
    const facts = await aggregateFields(ocrResultFile, factsFile, options);
    const missingFields = missingSelfStateFields(facts);
    const preserveDebugImages = missingFields.length > 0 || process.env.JCC_SELF_STATE_ROI_PRESERVE_DEBUG_IMAGES === "1";
    if (!preserveDebugImages) {
      await deleteCropImages(tasks);
      await rm(framePath, { force: true });
    }
    const observedAt = new Date().toISOString();
    const visualLiveStateFile = await writeMinimalLiveState({ facts, outDir, options, observedAt });
    const result = {
      ok: hasSelfStateFact(facts),
      schema: "jcc-self-state-roi-ocr-result-v1",
      status: hasSelfStateFact(facts) ? "self_state_roi_ocr_ready" : "self_state_roi_ocr_no_fields",
      mode: "refresh_self_state",
      observed_at: observedAt,
      match_session_id: options.matchSessionId || null,
      phase: {
        stage_round: facts.phase?.stage_round || null,
        current_round_text: facts.phase?.stage_round || null,
      },
      economy: facts.economy || {},
      field_status: facts.field_status || {},
      missing_fields: missingFields,
      artifacts: {
        frame: frameFile,
        crop_tasks: cropTaskFile,
        ocr_result_batch: ocrResultFile,
        self_state_facts: factsFile,
        visual_live_state: visualLiveStateFile,
        visual_observations: null,
      },
      storage_policy: {
        structured_json_only: true,
        raw_frame_deleted_after_processing: !preserveDebugImages,
        roi_images_deleted_after_processing: !preserveDebugImages,
        preserved_debug_images_reason: preserveDebugImages ? "missing_self_state_fields" : null,
      },
    };
    const out = options.out ? path.resolve(options.out) : path.join(outDir, "result.json");
    await writeJson(out, result);
    return result;
  } finally {
    if (!worker) await ownedWorker.stop();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runSelfStateRoiOcrWithWorker(options);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("run-jcc-self-state-roi-ocr.mjs")) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
