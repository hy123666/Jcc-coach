import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  resolvePythonExecutable,
  runAugmentChoiceRoiOcrAttempt,
  startAugmentChoiceRapidOcrWorker,
} from "../../tools/run-jcc-augment-choice-roi-ocr.mjs";

export function augmentChoiceOcrAttemptTimeoutMs(value = process.env.JCC_AUGMENT_QUICK_OCR_ATTEMPT_TIMEOUT_MS) {
  const parsed = Number(value || 15000);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 15000;
}

export async function runExplicitAugmentChoiceDraftOcr({
  outDir,
  device = null,
  matchSessionId = null,
  captureSource = "auto",
  debugEvidenceDir = null,
  framePath = null,
  catalog = null,
} = {}) {
  if (debugEvidenceDir) {
    await rm(debugEvidenceDir, { recursive: true, force: true });
    await mkdir(debugEvidenceDir, { recursive: true });
  }
  const python = await resolvePythonExecutable(process.env.JCC_OCR_PYTHON || ".venv-ocr/Scripts/python.exe");
  const workerStartup = startAugmentChoiceRapidOcrWorker({
    python,
    config: "data/runtime/jcc/rapidocr-ppocrv5-mobile.yaml",
    timeoutMs: Number(process.env.JCC_RAPIDOCR_WORKER_READY_TIMEOUT_MS || 120000),
  });
  const foregroundWaitMs = Number(process.env.JCC_AUGMENT_QUICK_OCR_FOREGROUND_READY_WAIT_MS || 2000);
  let foregroundTimer = null;
  const worker = await Promise.race([
    workerStartup,
    new Promise((_, reject) => {
      foregroundTimer = setTimeout(() => {
        const error = new Error("shared RapidOCR worker is still prewarming");
        error.code = "JCC_RAPIDOCR_PREWARMING";
        reject(error);
      }, foregroundWaitMs);
    }),
  ]).finally(() => {
    if (foregroundTimer) clearTimeout(foregroundTimer);
  });
  const options = {
    outDir,
    phase: "augment_choice",
    mode: "augment_choice_draft",
    python,
    config: "data/runtime/jcc/rapidocr-ppocrv5-mobile.yaml",
    timeoutMs: augmentChoiceOcrAttemptTimeoutMs(),
    captureSource,
    matchSessionId,
    ...(debugEvidenceDir ? { debugPanelPath: path.join(debugEvidenceDir, "panel.png") } : {}),
    ...(framePath ? { framePath } : {}),
    ...(device ? { device } : {}),
    ...(catalog ? { catalog } : {}),
  };
  const attempt = await runAugmentChoiceRoiOcrAttempt({
    options,
    worker,
    attemptDir: path.join(outDir, "attempt-01"),
    index: 1,
    started: Date.now(),
  });
  if (debugEvidenceDir) {
    const readJsonIfAvailable = async (file) => {
      if (!file || path.extname(file).toLowerCase() !== ".json") return null;
      try {
        return JSON.parse(await readFile(file, "utf8"));
      } catch {
        return null;
      }
    };
    const frame = await readJsonIfAvailable(attempt?.artifacts?.frame);
    const ocrResult = await readJsonIfAvailable(attempt?.artifacts?.ocr_result_batch);
    const report = {
      schema: "jcc-augment-quick-ocr-debug-evidence-v1",
      captured_at: new Date().toISOString(),
      match_session_id: matchSessionId,
      device: device || null,
      capture_source_requested: captureSource,
      capture: frame ? {
        source: frame.source || null,
        adb_device_id: frame.adb_device_id || null,
        frame_id: frame.frame_id || null,
        bytes: frame.bytes ?? null,
        image: frame.image || null,
      } : null,
      panel_image: attempt?.artifacts?.debug_panel || options.debugPanelPath,
      ok: attempt?.ok === true,
      error: attempt?.error || null,
      elapsed_ms: attempt?.elapsed_ms ?? null,
      timing_ms: attempt?.timing_ms || null,
      readable_choice_texts: attempt?.readable_choice_texts || [],
      unresolved_choice_texts: attempt?.unresolved_choice_texts || [],
      ocr_results: ocrResult?.results || [],
    };
    await writeFile(path.join(debugEvidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    attempt.debug_evidence = {
      dir: debugEvidenceDir,
      panel: options.debugPanelPath,
      report: path.join(debugEvidenceDir, "report.json"),
    };
  }
  return attempt;
}
