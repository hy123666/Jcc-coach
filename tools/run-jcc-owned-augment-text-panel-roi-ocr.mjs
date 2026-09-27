import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { startSharedRapidOcrWorker } from "./jcc-rapidocr-resident-worker.mjs";
import { runProcessTreeBounded as runProcess } from "./jcc_process_runner.mjs";

const DEFAULT_OUT_DIR = ".jcc-runtime-data/runtime-evidence/owned-augment-text-panel-roi-ocr";
const DEFAULT_PYTHON = process.env.JCC_OCR_PYTHON || ".venv-ocr/Scripts/python.exe";
const DEFAULT_CONFIG = "data/runtime/jcc/rapidocr-ppocrv5-mobile.yaml";

function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    python: DEFAULT_PYTHON,
    config: DEFAULT_CONFIG,
    timeoutMs: 8000,
    captureSource: process.env.JCC_CHOICE_CAPTURE_SOURCE || "auto",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--device") options.device = argv[++index];
    else if (arg === "--connect") options.connect = argv[++index];
    else if (arg === "--capture-source") options.captureSource = argv[++index];
    else if (arg === "--fixture-image") options.fixtureImage = argv[++index];
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else if (arg === "--python") options.python = argv[++index];
    else if (arg === "--config") options.config = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/run-jcc-owned-augment-text-panel-roi-ocr.mjs [--out-dir <dir>] [--fixture-image <png>] [--device <adb-id>]",
    "",
    "Runs the owned augment text-panel OCR path: one frame capture -> Python ROI crop task -> resident OCR worker -> owned-panel aggregator.",
  ].join("\n");
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

async function writeJson(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function runNode(args) {
  return runProcess(process.execPath, args, { cwd: path.resolve(import.meta.dirname, "..") });
}

function runPython(args, options = {}) {
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

export async function startOwnedAugmentTextPanelRapidOcrWorker(options) {
  return startSharedRapidOcrWorker(options);
}

async function captureFrame(options, outDir) {
  const captureDir = path.join(outDir, "capture");
  await mkdir(captureDir, { recursive: true });
  const args = [
    "tools/capture-jcc-visual-frame.mjs",
    "--out-dir", captureDir,
    "--label", "owned_augment_text_panel_roi_ocr",
    "--persist-frame",
  ];
  if (options.device) args.push("--device", options.device);
  if (options.connect) args.push("--connect", options.connect);
  if (options.fixtureImage) args.push("--fixture-image", options.fixtureImage);
  if (options.captureSource) args.push("--capture-source", options.captureSource);
  const result = await runNode(args);
  if (result.code !== 0) throw new Error(`frame capture failed: ${result.stderr || result.stdout}`);
  return path.join(captureDir, "visual-frame.json");
}

async function collectCropTasks(framePath, outDir, options) {
  const result = await runPython([
    path.resolve("tools/roi_owned_augment_text_panel.py"),
    "--frame", path.resolve(framePath),
    "--out-dir", outDir,
  ], { python: options.python });
  if (result.code !== 0) throw new Error(`owned augment text-panel ROI crop task failed: ${result.stderr || result.stdout}`);
  const batch = JSON.parse(result.stdout);
  return { batches: [batch], tasks: batch.tasks || [] };
}

async function runOcrTasks(tasks, worker, options) {
  const results = [];
  for (const task of tasks) {
    const response = await worker.ocr(task.crop_image, task.task_id, {
      text_score: 0.35,
      use_det: true,
      use_cls: true,
      timeoutMs: options.timeoutMs,
      ownerMatchSessionId: options.matchSessionId || null,
    });
    const text = (response.blocks || []).map((block) => String(block.text || "").trim()).filter(Boolean).join("");
    results.push({
      task_id: task.task_id,
      field: task.field,
      kind: task.kind,
      source_script: task.source_script,
      crop_image: task.crop_image,
      text,
      roi: task.roi,
      evidence: task.evidence || {},
      blocks: response.blocks || [],
      timing_ms: response.timing_ms || null,
    });
  }
  return {
    schema: "jcc-ocr-result-batch-v1",
    ok: true,
    results,
  };
}

async function aggregateFields(ocrResultFile, outFile, options) {
  const result = await runPython([
    path.resolve("tools/jcc_owned_augment_text_panel_aggregator.py"),
    "--ocr-result", path.resolve(ocrResultFile),
    "--out", path.resolve(outFile),
  ], { python: options.python });
  if (result.code !== 0) throw new Error(`owned augment text-panel aggregation failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

async function deleteTransientImages(tasks, framePath) {
  for (const task of tasks) {
    if (task.crop_image) await rm(task.crop_image, { force: true });
  }
  if (framePath) await rm(framePath, { force: true });
}

function selectedAugmentRows(facts) {
  return (facts?.facts?.selected_augments || []).map((row) => ({
    slot: row.slot,
    kind: "augment",
    choice_stage_round: row.choice_stage_round || null,
    name: row.name || row.text || null,
    text: row.text || row.name || null,
    id: row.id || row.entity_id || null,
    confidence: row.confidence ?? null,
    source: row.source || "user_triggered_owned_augment_text_panel_ocr",
  }));
}

function readableRows(facts) {
  return selectedAugmentRows(facts);
}

export async function runOwnedAugmentTextPanelRoiOcrAttempt({ options, worker, attemptDir, index = 1, started = Date.now() }) {
  await mkdir(attemptDir, { recursive: true });
  const timing = {};
  const step = async (key, fn) => {
    const stepStarted = Date.now();
    try {
      return await fn();
    } finally {
      timing[key] = Date.now() - stepStarted;
    }
  };
  let framePath = null;
  let tasks = [];
  try {
    const frameFile = await step("capture_frame_ms", () => captureFrame(options, attemptDir));
    const frame = await readJson(frameFile);
    framePath = frame.image?.path ? path.resolve(frame.image.path) : null;
    if (!framePath) throw new Error("owned augment text-panel OCR requires a persisted current frame path");
    const cropTaskDir = path.join(attemptDir, "crop-tasks");
    const cropData = await step("crop_tasks_ms", () => collectCropTasks(framePath, cropTaskDir, options));
    tasks = cropData.tasks;
    const ocrResult = await step("ocr_tasks_ms", () => runOcrTasks(tasks, worker, options));
    const cropTaskFile = path.join(attemptDir, "roi-crop-task-batches.json");
    const ocrResultFile = path.join(attemptDir, "ocr-result-batch.json");
    const factsFile = path.join(attemptDir, "owned-augment-text-panel-facts.json");
    await writeJson(cropTaskFile, {
      schema: "jcc-roi-crop-task-batch-collection-v1",
      ok: true,
      frame: framePath,
      batches: cropData.batches,
      tasks,
    });
    await writeJson(ocrResultFile, ocrResult);
    const facts = await step("aggregate_ms", () => aggregateFields(ocrResultFile, factsFile, options));
    await deleteTransientImages(tasks, options.fixtureImage ? null : framePath);
    framePath = null;
    tasks = [];
    const rows = readableRows(facts);
    return {
      index,
      ok: Boolean(facts?.ok),
      elapsed_ms: Date.now() - started,
      timing_ms: timing,
      out_dir: path.relative(process.cwd(), attemptDir),
      readable_choice_texts: rows,
      choice_counts: {
        selected_augments: selectedAugmentRows(facts).length,
      },
      artifacts: {
        frame: frameFile,
        crop_tasks: cropTaskFile,
        ocr_result_batch: ocrResultFile,
        owned_augment_text_panel_facts: factsFile,
      },
      facts,
    };
  } catch (error) {
    await deleteTransientImages(tasks, options.fixtureImage ? null : framePath).catch(() => {});
    return {
      index,
      ok: false,
      elapsed_ms: Date.now() - started,
      timing_ms: timing,
      out_dir: path.relative(process.cwd(), attemptDir),
      error: error.message || String(error),
    };
  }
}

export async function runOwnedAugmentTextPanelRoiOcr(optionsInput = {}, workerInput = null) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    python: DEFAULT_PYTHON,
    config: DEFAULT_CONFIG,
    timeoutMs: 8000,
    ...optionsInput,
  };
  options.python = await resolvePythonExecutable(options.python);
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const started = Date.now();
  const worker = workerInput || await startOwnedAugmentTextPanelRapidOcrWorker(options);
  let selected = null;
  try {
    selected = await runOwnedAugmentTextPanelRoiOcrAttempt({
      options,
      worker,
      attemptDir: path.join(outDir, "attempt-01"),
      index: 1,
      started,
    });
  } finally {
    if (!workerInput) await worker.stop();
  }
  const output = {
    ok: Boolean(selected?.ok),
    schema: "jcc-owned-augment-text-panel-roi-ocr-result-v1",
    status: selected?.ok ? "owned_augment_text_panel_observed" : "owned_augment_text_panel_missing",
    worker: worker ? { loaded_once: true, load_ms: worker.ready.load_ms } : null,
    attempts: selected ? [{
      index: selected.index,
      ok: selected.ok,
      elapsed_ms: selected.elapsed_ms,
      timing_ms: selected.timing_ms || null,
      out_dir: selected.out_dir,
      choice_counts: selected.choice_counts || null,
      readable_choice_texts: selected.readable_choice_texts || [],
      error: selected.error,
    }] : [],
    selected_report: selected?.ok ? {
      ok: true,
      readable_choice_texts: selected.readable_choice_texts,
      choice_counts: selected.choice_counts,
      artifacts: selected.artifacts,
    } : null,
    facts: selected?.facts || null,
    elapsed_ms: Date.now() - started,
    storage_policy: {
      raw_frames_persisted: false,
      raw_roi_images_persisted: false,
      retained_artifacts: "structured_json_only",
    },
  };
  await writeJson(path.join(outDir, "owned-augment-text-panel-roi-ocr-report.json"), output);
  return output;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  options.python = await resolvePythonExecutable(options.python);
  const result = await runOwnedAugmentTextPanelRoiOcr(options);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("run-jcc-owned-augment-text-panel-roi-ocr.mjs")) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
