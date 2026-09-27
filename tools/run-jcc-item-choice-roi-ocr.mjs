import crypto from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { startSharedRapidOcrWorker } from "./jcc-rapidocr-resident-worker.mjs";
import { runProcessTreeBounded as runProcess } from "./jcc_process_runner.mjs";

const DEFAULT_OUT_DIR = ".jcc-runtime-data/runtime-evidence/item-choice-roi-ocr";
const DEFAULT_PYTHON = process.env.JCC_OCR_PYTHON || ".venv-ocr/Scripts/python.exe";
const DEFAULT_CONFIG = "data/runtime/jcc/rapidocr-ppocrv5-mobile.yaml";

function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    python: DEFAULT_PYTHON,
    config: DEFAULT_CONFIG,
    phase: "item_choice",
    itemChoiceKind: "basic_component_forge",
    timeoutMs: 8000,
    intervalMs: 900,
    captureSource: process.env.JCC_CHOICE_CAPTURE_SOURCE || "auto",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--phase") options.phase = argv[++index];
    else if (arg === "--item-choice-kind") options.itemChoiceKind = argv[++index];
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--interval-ms") options.intervalMs = Number(argv[++index]);
    else if (arg === "--device") options.device = argv[++index];
    else if (arg === "--connect") options.connect = argv[++index];
    else if (arg === "--capture-source") options.captureSource = argv[++index];
    else if (arg === "--fixture-image") options.fixtureImage = argv[++index];
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--pipeline-out") options.pipelineOut = argv[++index];
    else if (arg === "--advice-state") options.adviceState = argv[++index];
    else if (arg === "--force-response-reason") options.forceResponseReason = argv[++index];
    else if (arg === "--continuous") options.continuous = true;
    else if (arg === "--python") options.python = argv[++index];
    else if (arg === "--config") options.config = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/run-jcc-item-choice-roi-ocr.mjs --phase item_choice [--item-choice-kind basic_component_forge|completed_item_forge|artifact_forge] [--out-dir <dir>] [--fixture-image <png>] [--device <adb-id>] [--live-state <file>] [--pipeline-out <file>]",
    "",
    "Runs the item-choice OCR pipeline: one frame capture -> Python ROI crop tasks -> resident OCR worker -> item aggregator -> runtime pipeline.",
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

export async function startItemChoiceRapidOcrWorker(options) {
  return startSharedRapidOcrWorker(options);
}

async function captureFrame(options, outDir) {
  const captureDir = path.join(outDir, "capture");
  await mkdir(captureDir, { recursive: true });
  const args = [
    "tools/capture-jcc-visual-frame.mjs",
    "--out-dir", captureDir,
    "--label", "item_choice_roi_ocr",
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

async function collectItemCropTasks(framePath, outDir, options) {
  if (options.phase !== "item_choice") {
    throw new Error(`item-choice ROI OCR only supports phase item_choice, got: ${options.phase}`);
  }
  const result = await runPython([
    path.resolve("tools/roi_item_choice.py"),
    "--frame", path.resolve(framePath),
    "--out-dir", outDir,
    "--phase", options.phase,
    "--item-choice-kind", options.itemChoiceKind || "basic_component_forge",
  ], { python: options.python });
  if (result.code !== 0) throw new Error(`item choice ROI crop task failed: ${result.stderr || result.stdout}`);
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

async function aggregateItemChoiceFields(ocrResultFile, outFile, options) {
  const result = await runPython([
    path.resolve("tools/jcc_item_choice_field_aggregator.py"),
    "--ocr-result", path.resolve(ocrResultFile),
    "--phase", options.phase,
    "--item-choice-kind", options.itemChoiceKind || "basic_component_forge",
    "--out", path.resolve(outFile),
  ], { python: options.python });
  if (result.code !== 0) throw new Error(`item choice field aggregation failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function hasItemChoiceFacts(facts) {
  const choices = Array.isArray(facts?.choices) ? facts.choices : [];
  const expectedCount = Number(facts?.expected_count || 0);
  return facts?.ok === true
    && expectedCount > 0
    && choices.length === expectedCount
    && choices.every((choice) => choice?.id && choice?.catalog_match?.id);
}

function compactItemChoiceRows(choices = []) {
  return choices.map((choice) => ({
    slot: choice.slot,
    text: choice.text || choice.name || null,
    name: choice.name || choice.text || null,
    raw_text: choice.raw_text || null,
    id: choice.id || null,
    item_choice_kind: choice.item_choice_kind || null,
    item_choice_label: choice.item_choice_label || null,
    confidence: choice.confidence ?? null,
    source: choice.source || "item_choice_roi_ocr",
    catalog_match: choice.catalog_match ? {
      kind: choice.catalog_match.kind || null,
      id: choice.catalog_match.id || null,
      name: choice.catalog_match.name || null,
      confidence: choice.catalog_match.confidence ?? null,
      match_type: choice.catalog_match.match_type || null,
    } : null,
  }));
}

async function writeMinimalLiveState({ facts, outDir, options, observedAt }) {
  if (!hasItemChoiceFacts(facts)) return null;
  const compactChoices = compactItemChoiceRows(facts.choices);
  const liveState = {
    schema: "jcc-visual-live-state-v1",
    match_session_id: options.matchSessionId || `item-choice:${path.basename(outDir)}`,
    observed_at: observedAt,
    updated_at: observedAt,
    mode: options.mode || options.phase,
    phase: { stage_round: null, status: null },
    economy: { gold: null, hp: null, level: null, xp: null },
    board: { board_units: [] },
    bench: { bench_units: [] },
    shop: { shop_units: [] },
    items: {
      item_bench: [],
      equipped_items: [],
      choice_options: compactChoices,
      current_choice_set: {
        at: observedAt,
        source: "item_choice_roi_ocr",
        item_choice_kind: facts.item_choice_kind || options.itemChoiceKind || "basic_component_forge",
        item_choice_label: facts.item_choice_label || null,
        choices: compactChoices,
      },
    },
    augments: { selected_augments: [], choice_candidates: [], current_choice_set: null },
    metadata: {
      source: "item_choice_roi_ocr",
      choice_kind: facts.choice_kind,
      item_choice_kind: facts.item_choice_kind || options.itemChoiceKind || "basic_component_forge",
      item_choice_label: facts.item_choice_label || null,
    },
  };
  const out = path.join(outDir, `item-choice-live-state-${crypto.randomUUID()}.json`);
  await writeJson(out, liveState);
  return out;
}

async function writeItemChoiceVisualObservations({ facts, outDir, options, observedAt }) {
  if (!hasItemChoiceFacts(facts)) return null;
  const compactChoices = compactItemChoiceRows(facts.choices);
  const observations = {
    schema: "jcc-visual-observations-v1",
    match_session_id: options.matchSessionId || `item-choice:${path.basename(outDir)}`,
    phase: {
      phase: {
        value: options.phase,
        confidence: 0.95,
        source: "item_choice_roi_ocr",
      },
    },
    economy: {},
    board: {},
    bench: {},
    shop: {},
    items: {
      choice_options: compactChoices.map((choice) => ({
        ...choice,
        value: choice.name || choice.text || null,
        source: "item_choice_roi_ocr",
        semantic_status: "visible_item_choice_candidate",
      })),
    },
    opponents: {},
    augments: {},
    metadata: {
      source: "item_choice_roi_ocr",
      observed_at: observedAt,
      created_at: observedAt,
      mode: options.mode || options.phase,
      phase: options.phase,
      choice_kind: facts.choice_kind,
      item_choice_kind: facts.item_choice_kind || options.itemChoiceKind || "basic_component_forge",
      item_choice_label: facts.item_choice_label || null,
      match_session_id: options.matchSessionId || null,
    },
  };
  const out = path.join(outDir, `item-choice-visual-observations-${crypto.randomUUID()}.json`);
  await writeJson(out, observations);
  return out;
}

export async function runItemChoiceAdvicePipelineForSelection({ options, facts, outDir, visualLiveStateFile, visualObservationsFile, label = "choice" }) {
  if (!hasItemChoiceFacts(facts)) return null;
  let mergedLiveState = visualLiveStateFile;
  if (options.liveState && visualObservationsFile) {
    mergedLiveState = path.join(outDir, `${label}-merged-live-state.json`);
    const merge = await runNode([
      "tools/build-jcc-visual-live-state.mjs",
      "--live-state", options.liveState,
      "--visual-observations", visualObservationsFile,
      "--out", mergedLiveState,
    ]);
    if (merge.code !== 0) {
      return { ok: false, step: "merge_visual_live_state", error: merge.stderr || merge.stdout };
    }
  }
  const pipelineOut = options.pipelineOut && label === "choice"
    ? options.pipelineOut
    : path.join(outDir, `${label}-cruise-pipeline.json`);
  const args = [
    "tools/run-jcc-cruise-runtime-pipeline.mjs",
    "--live-state", mergedLiveState,
    "--out", pipelineOut,
    "--mode", options.mode || options.phase,
  ];
  if (options.adviceState) args.push("--advice-state", options.adviceState);
  if (options.forceResponseReason) args.push("--force-response-reason", options.forceResponseReason);
  const pipeline = await runNode(args);
  if (pipeline.code !== 0) {
    return { ok: false, step: "run_cruise_pipeline", error: pipeline.stderr || pipeline.stdout };
  }
  return {
    ok: true,
    merged_live_state: path.relative(process.cwd(), mergedLiveState),
    pipeline_out: path.relative(process.cwd(), pipelineOut),
  };
}

async function deleteTransientImages(tasks, framePath) {
  for (const task of tasks) {
    if (task.crop_image) await rm(task.crop_image, { force: true });
  }
  if (framePath) await rm(framePath, { force: true });
}

export async function runItemChoiceRoiOcrAttempt({ options, worker, attemptDir, index, started }) {
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
    if (!framePath) throw new Error("item choice ROI OCR requires a persisted current frame path");
    const cropTaskDir = path.join(attemptDir, "crop-tasks");
    const cropData = await step("crop_tasks_ms", () => collectItemCropTasks(framePath, cropTaskDir, options));
    tasks = cropData.tasks;
    const ocrResult = await step("ocr_tasks_ms", () => runOcrTasks(tasks, worker, options));
    const cropTaskFile = path.join(attemptDir, "roi-crop-task-batches.json");
    const ocrResultFile = path.join(attemptDir, "ocr-result-batch.json");
    const factsFile = path.join(attemptDir, "item-choice-facts.json");
    await writeJson(cropTaskFile, {
      schema: "jcc-roi-crop-task-batch-collection-v1",
      ok: true,
      frame: framePath,
      batches: cropData.batches,
      tasks,
    });
    await writeJson(ocrResultFile, ocrResult);
    const facts = await step("aggregate_ms", () => aggregateItemChoiceFields(ocrResultFile, factsFile, options));
    await deleteTransientImages(tasks, options.fixtureImage ? null : framePath);
    framePath = null;
    tasks = [];
    const observedAt = new Date().toISOString();
    const visualObservationsFile = await writeItemChoiceVisualObservations({ facts, outDir: attemptDir, options, observedAt });
    const visualLiveStateFile = await writeMinimalLiveState({ facts, outDir: attemptDir, options, observedAt });
    return {
      index,
      ok: hasItemChoiceFacts(facts),
      elapsed_ms: Date.now() - started,
      timing_ms: timing,
      out_dir: path.relative(process.cwd(), attemptDir),
      readable_choice_texts: compactItemChoiceRows(facts.choices || []),
      choice_counts: { item_choices: facts.choice_kind === "item_choice_panel" ? facts.choices.length : 0 },
      artifacts: {
        frame: frameFile,
        crop_tasks: cropTaskFile,
        ocr_result_batch: ocrResultFile,
        choice_facts: factsFile,
        visual_observations: visualObservationsFile,
        visual_live_state: visualLiveStateFile,
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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runItemChoiceRoiOcr(optionsInput = {}, workerInput = null) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    python: DEFAULT_PYTHON,
    config: DEFAULT_CONFIG,
    phase: "item_choice",
    itemChoiceKind: "basic_component_forge",
    timeoutMs: 8000,
    intervalMs: 900,
    ...optionsInput,
  };
  options.python = await resolvePythonExecutable(options.python);
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const started = Date.now();
  const attempts = [];
  const observedChoiceSets = [];
  let selected = null;
  let lastFingerprint = null;
  const worker = workerInput || await startItemChoiceRapidOcrWorker(options);
  try {
    let index = 0;
    do {
      index += 1;
      const attemptDir = path.join(outDir, `attempt-${String(index).padStart(2, "0")}`);
      const attempt = await runItemChoiceRoiOcrAttempt({ options, worker, attemptDir, index, started });
      attempts.push({
        index: attempt.index,
        ok: attempt.ok,
        elapsed_ms: attempt.elapsed_ms,
        timing_ms: attempt.timing_ms || null,
        out_dir: attempt.out_dir,
        choice_counts: attempt.choice_counts || null,
        readable_choice_texts: attempt.readable_choice_texts || [],
        error: attempt.error,
      });
      if (attempt.ok) {
        selected = attempt;
        const fingerprint = JSON.stringify((attempt.readable_choice_texts || []).map((row) => ({
          slot: row.slot,
          id: row.id || null,
          name: row.name || row.text || null,
        })));
        if (fingerprint && fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          const label = `choice-set-${String(observedChoiceSets.length + 1).padStart(2, "0")}`;
          const advicePipeline = await runItemChoiceAdvicePipelineForSelection({
            options,
            facts: attempt.facts,
            outDir,
            visualLiveStateFile: attempt.artifacts.visual_live_state,
            visualObservationsFile: attempt.artifacts.visual_observations,
            label,
          });
          observedChoiceSets.push({
            attempt_index: attempt.index,
            elapsed_ms: attempt.elapsed_ms,
            fingerprint,
            report: {
              readable_choice_texts: attempt.readable_choice_texts,
              artifacts: attempt.artifacts,
            },
            advice_pipeline: advicePipeline,
          });
        }
        if (!options.continuous) break;
      }
      if (Date.now() - started >= options.timeoutMs) break;
      await sleep(options.intervalMs);
    } while (Date.now() - started < options.timeoutMs);
  } finally {
    if (!workerInput) await worker.stop();
  }
  const output = {
    ok: Boolean(selected),
    schema: "jcc-item-choice-roi-ocr-result-v1",
    phase: options.phase,
    status: selected ? "choice_observed" : "timed_out_without_choice",
    worker: worker ? { loaded_once: true, load_ms: worker.ready.load_ms } : null,
    attempts,
    observed_choice_set_count: observedChoiceSets.length,
    observed_choice_sets: observedChoiceSets.map((entry) => ({
      attempt_index: entry.attempt_index,
      elapsed_ms: entry.elapsed_ms,
      fingerprint: entry.fingerprint,
      advice_pipeline: entry.advice_pipeline,
    })),
    selected_report: selected ? {
      ok: true,
      item_choice_kind: selected.readable_choice_texts?.find((row) => row.item_choice_kind)?.item_choice_kind || options.itemChoiceKind || "basic_component_forge",
      item_choice_label: selected.readable_choice_texts?.find((row) => row.item_choice_label)?.item_choice_label || null,
      readable_choice_texts: selected.readable_choice_texts,
      choice_counts: selected.choice_counts,
      artifacts: selected.artifacts,
    } : null,
    advice_runs: observedChoiceSets,
    latest_advice_pipeline: observedChoiceSets.at(-1)?.advice_pipeline || null,
    advice_pipeline: observedChoiceSets.at(-1)?.advice_pipeline || null,
    elapsed_ms: Date.now() - started,
    storage_policy: {
      raw_frames_persisted: false,
      raw_roi_images_persisted: false,
      retained_artifacts: "structured_json_only",
    },
  };
  await writeJson(path.join(outDir, "item-choice-roi-ocr-report.json"), output);
  return output;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  options.python = await resolvePythonExecutable(options.python);
  const result = await runItemChoiceRoiOcr(options);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("run-jcc-item-choice-roi-ocr.mjs")) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
