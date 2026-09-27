import crypto from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcessTreeBounded as runProcess } from "./jcc_process_runner.mjs";

const DEFAULT_OUT_DIR = ".jcc-runtime-data/runtime-evidence/left-item-rail-roi-icon";
const DEFAULT_PYTHON = process.env.JCC_OCR_PYTHON || ".venv-ocr/Scripts/python.exe";

function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    python: DEFAULT_PYTHON,
    captureSource: process.env.JCC_LEFT_ITEM_RAIL_CAPTURE_SOURCE || process.env.JCC_CHOICE_CAPTURE_SOURCE || "auto",
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
    else if (arg === "--python") options.python = argv[++index];
    else if (arg === "--live-state") options.liveState = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/run-jcc-left-item-rail-roi-icon.mjs [--fixture-image <png>] [--live-state <json>] [--out <file>]",
    "",
    "Runs left item rail sensing: one frame capture -> ROI crop tasks -> item icon matcher -> item_bench_candidates observations.",
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

function subprocessTimeoutMs(options = {}) {
  const timeoutMs = Number(options.subprocessTimeoutMs || process.env.JCC_LEFT_ITEM_RAIL_ROI_ICON_REFRESH_TIMEOUT_MS || 6000);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 6000;
}

function runNode(args, options = {}) {
  return runProcess(process.execPath, args, {
    cwd: path.resolve(import.meta.dirname, ".."),
    timeoutMs: subprocessTimeoutMs(options),
  });
}

function runPython(args, options = {}) {
  return runProcess(path.resolve(options.python || DEFAULT_PYTHON), args, {
    cwd: process.cwd(),
    timeoutMs: subprocessTimeoutMs(options),
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

function normalizeAdbOption(adb) {
  if (!adb || adb === "adb") {
    return process.env.JCC_ADB || path.resolve(".omx", "bin", process.platform === "win32" ? "adb.exe" : "adb");
  }
  return adb;
}

async function captureFrame(options, outDir) {
  const captureDir = path.join(outDir, "capture");
  await mkdir(captureDir, { recursive: true });
  const args = [
    "tools/capture-jcc-visual-frame.mjs",
    "--out-dir", captureDir,
    "--label", "left_item_rail_roi_icon",
    "--persist-frame",
  ];
  if (options.device) args.push("--device", options.device);
  if (options.connect) args.push("--connect", options.connect);
  if (options.adb) args.push("--adb", normalizeAdbOption(options.adb));
  if (options.fixtureImage) args.push("--fixture-image", options.fixtureImage);
  if (options.captureSource) args.push("--capture-source", options.captureSource);
  const result = await runNode(args, options);
  if (result.code !== 0) throw new Error(`frame capture failed: ${result.stderr || result.stdout}`);
  return path.join(captureDir, "visual-frame.json");
}

async function collectCropTasks(framePath, outDir, options) {
  const result = await runPython([
    path.resolve("tools/roi_left_item_rail.py"),
    "--frame", path.resolve(framePath),
    "--out-dir", outDir,
  ], { python: options.python });
  if (result.code !== 0) throw new Error(`left item rail ROI crop failed: ${result.stderr || result.stdout}`);
  const batch = JSON.parse(result.stdout);
  return { batches: [batch], tasks: batch.tasks || [] };
}

async function matchIcons(cropTaskFile, outFile, options) {
  const result = await runNode([
    "tools/match-jcc-left-item-rail-icons.mjs",
    "--crop-tasks", cropTaskFile,
    "--out", outFile,
  ], options);
  if (result.code !== 0) throw new Error(`left item rail icon match failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

async function aggregateFields(iconMatchFile, outFile, options) {
  const result = await runNode([
    "tools/jcc_left_item_rail_field_aggregator.mjs",
    "--icon-matches", iconMatchFile,
    "--out", outFile,
  ], options);
  if (result.code !== 0) throw new Error(`left item rail field aggregation failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

async function buildVisualLiveState(liveStateFile, visualObservationsFile, outFile, options) {
  const result = await runNode([
    "tools/build-jcc-visual-live-state.mjs",
    "--live-state", liveStateFile,
    "--visual-observations", visualObservationsFile,
    "--out", outFile,
  ], options);
  if (result.code !== 0) throw new Error(`visual live-state merge failed: ${result.stderr || result.stdout}`);
  return JSON.parse(await readFile(outFile, "utf8"));
}

async function deleteCropImages(tasks) {
  for (const task of tasks) {
    if (task.crop_image) await rm(task.crop_image, { force: true });
  }
}

function hasItemBenchCandidates(observations) {
  return (observations.items?.item_bench_candidates || []).length > 0;
}

export async function runLeftItemRailRoiIcon(optionsInput = {}) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    python: DEFAULT_PYTHON,
    captureSource: process.env.JCC_LEFT_ITEM_RAIL_CAPTURE_SOURCE || process.env.JCC_CHOICE_CAPTURE_SOURCE || "auto",
    ...optionsInput,
  };
  options.python = await resolvePythonExecutable(options.python);
  const outDir = path.resolve(options.outDir, `left-item-rail-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(outDir, { recursive: true });
  const frameFile = await captureFrame(options, outDir);
  const frame = await readJson(frameFile);
  const framePath = frame.image?.path ? path.resolve(frame.image.path) : null;
  if (!framePath) throw new Error("left item rail ROI icon matcher requires a persisted current frame path");
  const cropTaskDir = path.join(outDir, "crop-tasks");
  const { batches, tasks } = await collectCropTasks(framePath, cropTaskDir, options);
  const cropTaskFile = path.join(outDir, "roi-crop-task-batches.json");
  const iconMatchFile = path.join(outDir, "icon-match-batch.json");
  const visualObservationsFile = path.join(outDir, "left-item-rail-visual-observations.json");
  await writeJson(cropTaskFile, {
    schema: "jcc-roi-crop-task-batch-collection-v1",
    ok: true,
    frame: framePath,
    batches,
    tasks,
  });
  const iconMatches = await matchIcons(cropTaskFile, iconMatchFile, options);
  const visualObservations = await aggregateFields(iconMatchFile, visualObservationsFile, options);
  await deleteCropImages(tasks);
  await rm(framePath, { force: true });

  let visualLiveStateFile = null;
  if (options.liveState) {
    visualLiveStateFile = path.join(outDir, "left-item-rail-visual-live-state.json");
    await buildVisualLiveState(path.resolve(options.liveState), visualObservationsFile, visualLiveStateFile, options);
  }

  const result = {
    ok: true,
    schema: "jcc-left-item-rail-roi-icon-result-v1",
    status: hasItemBenchCandidates(visualObservations)
      ? "left_item_rail_roi_icon_candidates_only"
      : "left_item_rail_roi_icon_observed_empty",
    mode: "refresh_self_state",
    match_session_id: options.matchSessionId || null,
    item_bench_count: 0,
    item_bench_candidate_count: visualObservations.items?.item_bench_candidates?.length || 0,
    artifacts: {
      frame: frameFile,
      crop_tasks: cropTaskFile,
      icon_match_batch: iconMatchFile,
      visual_observations: visualObservationsFile,
      visual_live_state: visualLiveStateFile,
    },
    storage_policy: {
      structured_json_only: true,
      raw_frame_deleted_after_processing: true,
      roi_images_deleted_after_processing: true,
    },
  };
  const out = options.out ? path.resolve(options.out) : path.join(outDir, "result.json");
  await writeJson(out, result);
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runLeftItemRailRoiIcon(options);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("run-jcc-left-item-rail-roi-icon.mjs")) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
