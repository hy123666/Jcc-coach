import crypto from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { startSharedRapidOcrWorker } from "./jcc-rapidocr-resident-worker.mjs";
import { runProcessTreeBounded as runProcess } from "./jcc_process_runner.mjs";

const DEFAULT_OUT_DIR = ".jcc-runtime-data/runtime-evidence/augment-choice-roi-ocr";
const DEFAULT_PYTHON = process.env.JCC_OCR_PYTHON || ".venv-ocr/Scripts/python.exe";
const DEFAULT_CONFIG = "data/runtime/jcc/rapidocr-ppocrv5-mobile.yaml";
const repoRoot = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    python: DEFAULT_PYTHON,
    config: DEFAULT_CONFIG,
    phase: "augment_choice",
    timeoutMs: 15000,
    intervalMs: 900,
    captureSource: process.env.JCC_AUGMENT_QUICK_OCR_CAPTURE_SOURCE || "auto",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--phase") options.phase = argv[++index];
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--interval-ms") options.intervalMs = Number(argv[++index]);
    else if (arg === "--device") options.device = argv[++index];
    else if (arg === "--connect") options.connect = argv[++index];
    else if (arg === "--capture-source") options.captureSource = argv[++index];
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--pipeline-out") options.pipelineOut = argv[++index];
    else if (arg === "--advice-state") options.adviceState = argv[++index];
    else if (arg === "--force-response-reason") options.forceResponseReason = argv[++index];
    else if (arg === "--continuous") options.continuous = true;
    else if (arg === "--python") options.python = argv[++index];
    else if (arg === "--config") options.config = argv[++index];
    else if (arg === "--catalog") options.catalog = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/run-jcc-augment-choice-roi-ocr.mjs --phase augment_choice [--out-dir <dir>] [--timeout-ms <ms>] [--interval-ms <ms>] [--device <adb-id>] [--live-state <file>] [--pipeline-out <file>]",
    "",
    "Runs the augment-choice OCR pipeline: one frame capture -> Python ROI crop tasks -> resident OCR worker -> augment aggregator -> runtime pipeline.",
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

function runNode(args, options = {}) {
  return runProcess(process.execPath, args, {
    cwd: path.resolve(import.meta.dirname, ".."),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
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

export async function startAugmentChoiceRapidOcrWorker(options) {
  return startSharedRapidOcrWorker(options);
}

async function captureFrame(options, outDir, timeoutMs = options.timeoutMs) {
  const captureDir = path.join(outDir, "capture");
  await mkdir(captureDir, { recursive: true });
  const args = [
    "tools/capture-jcc-visual-frame.mjs",
    "--out-dir", captureDir,
    "--label", "augment_choice_roi_ocr",
    "--persist-frame",
  ];
  if (options.device) args.push("--device", options.device);
  if (options.connect) args.push("--connect", options.connect);
  if (options.captureSource) args.push("--capture-source", options.captureSource);
  const result = await runNode(args, { timeoutMs });
  if (result.code !== 0) throw new Error(`frame capture failed: ${result.stderr || result.stdout}`);
  return path.join(captureDir, "visual-frame.json");
}

async function collectAugmentCropTasks(framePath, outDir, options) {
  if (options.phase !== "augment_choice") {
    throw new Error(`augment-choice ROI OCR only supports phase augment_choice, got: ${options.phase}`);
  }
  const layout = await readJson(path.resolve("data/runtime/jcc/visual-roi-layout.json"));
  const panel = layout?.regions?.phase?.augment_choice_panel;
  const slots = layout?.regions?.augment_choice_text_slots || [];
  if (!panel || slots.length !== 3) throw new Error("augment choice ROI layout requires one panel and three slots");
  const relativeRoi = (child) => ({
    x: (Number(child.x) - Number(panel.x)) / Number(panel.w),
    y: (Number(child.y) - Number(panel.y)) / Number(panel.h),
    w: Number(child.w) / Number(panel.w),
    h: Number(child.h) / Number(panel.h),
  });
  const slotParts = [];
  for (const [index, slot] of slots.entries()) {
    const slotId = Number.isFinite(Number(slot?.slot)) ? Number(slot.slot) + 1 : index + 1;
    for (const part of ["name", "desc"]) {
      if (!slot?.[part]) continue;
      slotParts.push({
        slot: slotId,
        part,
        kind: "augment_choice",
        field: `choices.augment_choice.${slotId}.${part}`,
        normalized_roi: slot[part],
        panel_relative_roi: relativeRoi(slot[part]),
      });
    }
  }
  const task = {
    task_id: `augment_choice.panel.${crypto.randomUUID()}`,
    logical_task_id: "augment_choice.panel",
    field: "choices.augment_choice.panel",
    kind: "augment_choice",
    source_image: path.resolve(framePath),
    source_script: "resident_rapidocr_in_memory_roi",
    normalized_roi: panel,
    evidence: { phase: "augment_choice", normalized_roi: panel, slot_parts: slotParts },
  };
  const batch = {
    ok: true,
    schema: "jcc-roi-crop-task-batch-v1",
    frame: path.resolve(framePath),
    tasks: [task],
    timing_ms: { total: 0 },
    artifacts: { crop_policy: "resident_worker_in_memory" },
  };
  return { batches: [batch], tasks: batch.tasks || [] };
}

async function runOcrTasks(tasks, worker, options) {
  const results = [];
  for (const task of tasks) {
    const response = await worker.ocr(task.crop_image || task.source_image, task.task_id, {
      text_score: 0.35,
      use_det: true,
      use_cls: true,
      normalized_roi: task.normalized_roi || null,
      debugOutputImage: options.debugPanelPath || null,
      timeoutMs: options.timeoutMs,
      priority: "foreground",
      ownerMatchSessionId: options.matchSessionId || null,
    });
    const text = (response.blocks || []).map((block) => String(block.text || "").trim()).filter(Boolean).join("");
    results.push({
      task_id: task.task_id,
      field: task.field,
      kind: task.kind,
      source_script: task.source_script,
      crop_image: task.crop_image || null,
      text,
      roi: response.roi || task.roi || null,
      image_size: response.image_size || null,
      debug_output_image: response.debug_output_image || null,
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

function normalizeChoiceText(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function pointInRoi(roi, point) {
  return point && roi
    && point.x >= Number(roi.x) && point.x <= Number(roi.x) + Number(roi.w)
    && point.y >= Number(roi.y) && point.y <= Number(roi.y) + Number(roi.h);
}

function blockCenter(block) {
  const rect = block?.rect;
  if (!rect) return null;
  return { x: Number(rect.x) + Number(rect.w) / 2, y: Number(rect.y) + Number(rect.h) / 2 };
}

async function aggregateAugmentChoiceFields(ocrResult, outFile, options) {
  const catalogFile = path.resolve(options.catalog || createRuntimePaths(repoRoot).activeDecisionInputCatalogFile);
  const catalog = await readJson(catalogFile);
  const catalogByName = new Map((catalog?.entities || [])
    .filter((entry) => entry?.kind === "augment" && entry?.name)
    .map((entry) => [normalizeChoiceText(entry.name), entry]));
  const bySlot = new Map();
  for (const result of ocrResult?.results || []) {
    const width = Number(result?.image_size?.width || result?.roi?.w || 0);
    const height = Number(result?.image_size?.height || result?.roi?.h || 0);
    if (!(width > 0 && height > 0)) continue;
    for (const block of result?.blocks || []) {
      const text = String(block?.text || "").trim();
      const center = blockCenter(block);
      if (!text || !center) continue;
      const point = { x: center.x / width, y: center.y / height };
      const part = (result?.evidence?.slot_parts || []).find((entry) => pointInRoi(entry?.panel_relative_roi, point));
      if (!part) continue;
      const slot = Number(part.slot);
      const row = bySlot.get(slot) || { slot, nameParts: [], description_lines: [] };
      if (part.part === "name") row.nameParts.push(text);
      else if (part.part === "desc") row.description_lines.push(text);
      bySlot.set(slot, row);
    }
  }
  const choices = [];
  const unresolvedChoices = [];
  for (const row of [...bySlot.values()].sort((left, right) => left.slot - right.slot)) {
    const observedName = row.nameParts.join("");
    if (!observedName) continue;
    const match = catalogByName.get(normalizeChoiceText(observedName)) || null;
    const choice = {
      slot: row.slot,
      text: match?.name || observedName,
      name: match?.name || observedName,
      description_lines: row.description_lines,
      id: match?.id ? String(match.id) : null,
      confidence: match ? 0.96 : null,
      source: "resident_ocr_worker",
      catalog_match: match ? {
        kind: "augment",
        id: String(match.id),
        name: match.name,
        address: match.address || null,
        tier: match.tier || match.tier_color || null,
        icon_url: match.icon_url || null,
        confidence: 0.96,
        match_type: "exact_name",
      } : null,
    };
    if (match) choices.push(choice);
    else unresolvedChoices.push({ ...choice, rejection_reason: "augment_name_not_in_current_catalog" });
  }
  const ok = choices.length === 3 && unresolvedChoices.length === 0;
  const facts = {
    schema: "jcc-augment-choice-facts-v1",
    ok,
    phase: options.phase,
    choice_kind: "augment_choice",
    choices,
    unresolved_choices: unresolvedChoices,
    rejection_reason: ok ? null : "augment_choice_requires_three_catalog_matched_candidates",
  };
  await writeJson(outFile, facts);
  return facts;
}

function hasAugmentChoiceFacts(facts) {
  return facts?.ok === true
    && Array.isArray(facts?.choices)
    && facts.choices.length === 3
    && facts.choices.every((choice) => choice?.catalog_match?.id && choice?.id);
}

function compactAugmentChoiceRows(choices = []) {
  return choices.map((choice) => ({
    slot: choice.slot,
    text: choice.text || choice.name || null,
    name: choice.name || choice.text || null,
    description_lines: Array.isArray(choice.description_lines) ? choice.description_lines : [],
    id: choice.id || null,
    confidence: choice.confidence ?? null,
    source: choice.source || "augment_choice_roi_ocr",
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
  if (!hasAugmentChoiceFacts(facts)) return null;
  const compactChoices = compactAugmentChoiceRows(facts.choices);
  const liveState = {
    schema: "jcc-visual-live-state-v1",
    match_session_id: options.matchSessionId || `augment-choice:${path.basename(outDir)}`,
    observed_at: observedAt,
    updated_at: observedAt,
    mode: options.mode || options.phase,
    phase: { stage_round: null, status: options.phase === "augment_choice" ? 4 : null },
    economy: { gold: null, hp: null, level: null, xp: null },
    board: { board_units: [] },
    bench: { bench_units: [] },
    shop: { shop_units: [] },
    items: { item_bench: [], equipped_items: [], choice_options: [] },
    augments: {
      selected_augments: [],
      choice_candidates: facts.choice_kind === "augment_choice" ? compactChoices : [],
      current_choice_set: facts.choice_kind === "augment_choice"
        ? {
            at: observedAt,
            source: "augment_choice_roi_ocr",
            choices: compactChoices,
          }
        : null,
    },
    metadata: {
      source: "augment_choice_roi_ocr",
      choice_kind: facts.choice_kind,
    },
  };
  const out = path.join(outDir, `augment-choice-live-state-${crypto.randomUUID()}.json`);
  await writeJson(out, liveState);
  return out;
}

async function writeAugmentChoiceVisualObservations({ facts, outDir, options, observedAt }) {
  if (!hasAugmentChoiceFacts(facts)) return null;
  const compactChoices = compactAugmentChoiceRows(facts.choices);
  const observations = {
    schema: "jcc-visual-observations-v1",
    match_session_id: options.matchSessionId || `augment-choice:${path.basename(outDir)}`,
    phase: {
      phase: {
        value: options.phase,
        confidence: 0.95,
        source: "augment_choice_roi_ocr",
      },
    },
    economy: {},
    board: {},
    bench: {},
    shop: {},
    items: {},
    opponents: {},
    augments: {
      choices: facts.choice_kind === "augment_choice" ? compactChoices.map((choice) => ({
        ...choice,
        value: choice.name || choice.text || null,
        source: "augment_choice_roi_ocr",
        semantic_status: "visible_augment_choice_candidate",
      })) : [],
    },
    metadata: {
      source: "augment_choice_roi_ocr",
      observed_at: observedAt,
      created_at: observedAt,
      mode: options.mode || options.phase,
      phase: options.phase,
      choice_kind: facts.choice_kind,
      match_session_id: options.matchSessionId || null,
    },
  };
  const out = path.join(outDir, `augment-choice-visual-observations-${crypto.randomUUID()}.json`);
  await writeJson(out, observations);
  return out;
}

export async function runAugmentChoiceAdvicePipelineForSelection({ options, facts, outDir, visualLiveStateFile, visualObservationsFile, label = "choice" }) {
  if (!hasAugmentChoiceFacts(facts)) return null;
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

export async function runAugmentChoiceRoiOcrAttempt({ options, worker, attemptDir, index, started }) {
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
  const configuredTimeoutMs = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 15000;
  const deadlineAt = started + Math.max(1000, timeoutMs);
  const remainingMs = (minimum = 250) => {
    const remaining = deadlineAt - Date.now();
    if (remaining < minimum) throw new Error(`augment Quick OCR end-to-end timed out after ${timeoutMs}ms`);
    return remaining;
  };
  try {
    const suppliedFramePath = options.framePath ? path.resolve(options.framePath) : null;
    const frameFile = suppliedFramePath ? null : await step("capture_frame_ms", () => captureFrame(options, attemptDir, remainingMs(500)));
    const frame = frameFile ? await readJson(frameFile) : null;
    framePath = suppliedFramePath || (frame?.image?.path ? path.resolve(frame.image.path) : null);
    if (!framePath) throw new Error("choice ROI OCR requires a persisted current frame path");
    const cropTaskDir = path.join(attemptDir, "crop-tasks");
    remainingMs();
    const cropData = await step("crop_tasks_ms", () => collectAugmentCropTasks(framePath, cropTaskDir, options));
    tasks = cropData.tasks;
    const ocrResult = await step("ocr_tasks_ms", () => runOcrTasks(tasks, worker, { ...options, timeoutMs: remainingMs(500) }));
    const cropTaskFile = path.join(attemptDir, "roi-crop-task-batches.json");
    const ocrResultFile = path.join(attemptDir, "ocr-result-batch.json");
    const factsFile = path.join(attemptDir, "augment-choice-facts.json");
    await writeJson(cropTaskFile, {
      schema: "jcc-roi-crop-task-batch-collection-v1",
      ok: true,
      frame: framePath,
      batches: cropData.batches,
      tasks,
    });
    await writeJson(ocrResultFile, ocrResult);
    remainingMs();
    const facts = await step("aggregate_ms", () => aggregateAugmentChoiceFields(ocrResult, factsFile, options));
    await deleteTransientImages(tasks, suppliedFramePath ? null : framePath);
    framePath = null;
    tasks = [];
    const observedAt = new Date().toISOString();
    const visualObservationsFile = await writeAugmentChoiceVisualObservations({ facts, outDir: attemptDir, options, observedAt });
    const visualLiveStateFile = await writeMinimalLiveState({ facts, outDir: attemptDir, options, observedAt });
    remainingMs();
    return {
      index,
      ok: hasAugmentChoiceFacts(facts),
      elapsed_ms: Date.now() - started,
      timing_ms: timing,
      out_dir: path.relative(process.cwd(), attemptDir),
      readable_choice_texts: compactAugmentChoiceRows(facts.choices || []),
      unresolved_choice_texts: compactAugmentChoiceRows(facts.unresolved_choices || []),
      choice_counts: { augment_choices: facts.choice_kind === "augment_choice" ? facts.choices.length : 0 },
      artifacts: {
        frame: frameFile || suppliedFramePath,
        debug_panel: ocrResult?.results?.find((result) => result?.debug_output_image)?.debug_output_image
          || options.debugPanelPath
          || null,
        crop_policy: cropData.batches?.[0]?.artifacts?.crop_policy || null,
        crop_tasks: cropTaskFile,
        ocr_result_batch: ocrResultFile,
        choice_facts: factsFile,
        visual_observations: visualObservationsFile,
        visual_live_state: visualLiveStateFile,
      },
      facts,
    };
  } catch (error) {
    await deleteTransientImages(tasks, options.framePath ? null : framePath).catch(() => {});
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

export async function runAugmentChoiceRoiOcr(optionsInput = {}, workerInput = null) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    python: DEFAULT_PYTHON,
    config: DEFAULT_CONFIG,
    phase: "augment_choice",
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
  const worker = workerInput || await startAugmentChoiceRapidOcrWorker(options);
  try {
    let index = 0;
    do {
      index += 1;
      const attemptDir = path.join(outDir, `attempt-${String(index).padStart(2, "0")}`);
      const attempt = await runAugmentChoiceRoiOcrAttempt({ options, worker, attemptDir, index, started });
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
          const advicePipeline = await runAugmentChoiceAdvicePipelineForSelection({
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
    schema: "jcc-augment-choice-roi-ocr-result-v1",
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
  await writeJson(path.join(outDir, "augment-choice-roi-ocr-report.json"), output);
  return output;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  options.python = await resolvePythonExecutable(options.python);
  const result = await runAugmentChoiceRoiOcr(options);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("run-jcc-augment-choice-roi-ocr.mjs")) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
