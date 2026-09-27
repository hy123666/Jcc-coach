import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  resolvePythonExecutable,
  runAugmentChoiceRoiOcrAttempt,
  startAugmentChoiceRapidOcrWorker,
} from "./run-jcc-augment-choice-roi-ocr.mjs";
import { runExplicitAugmentChoiceDraftOcr } from "../ui/electron/augment-choice-draft-ocr.js";
import { stopSharedRapidOcrWorker } from "./jcc-rapidocr-resident-worker.mjs";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";

const root = path.resolve(import.meta.dirname, "..");

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolvePython() {
  const candidates = [
    process.env.JCC_OCR_PYTHON,
    ".venv-ocr/Scripts/python.exe",
    ".venv/Scripts/python.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(root, candidate);
    try {
      await access(resolved);
      return resolved;
    } catch {
      // Try the next configured interpreter.
    }
  }
  return "python";
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
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

function fixture(names) {
  const width = 900;
  const height = 600;
  const slotWidth = 1 / 3;
  const slotParts = [];
  const blocks = [];
  for (const [slot, name] of names.entries()) {
    const normalizedX = slot * slotWidth;
    slotParts.push({
      slot,
      part: "name",
      field: `augments.choices.${slot}.name`,
      panel_relative_roi: { x: normalizedX, y: 0, w: slotWidth, h: 0.3 },
    });
    slotParts.push({
      slot,
      part: "desc",
      field: `augments.choices.${slot}.description`,
      panel_relative_roi: { x: normalizedX, y: 0.3, w: slotWidth, h: 0.7 },
    });
    blocks.push({
      text: name,
      confidence: 0.98,
      rect: { x: (slot * 300) + 30, y: 40, w: 220, h: 50 },
    });
    blocks.push({
      text: `description-${slot}`,
      confidence: 0.94,
      rect: { x: (slot * 300) + 30, y: 260, w: 220, h: 50 },
    });
  }
  return {
    schema: "jcc-ocr-result-batch-v1",
    ok: true,
    results: [{
      task_id: "augment-choice-panel",
      field: "augments.current_choice_set",
      kind: "augment_choice_panel",
      roi: { x: 0, y: 0, w: width, h: height },
      evidence: { slot_parts: slotParts },
      blocks,
    }],
  };
}

async function aggregate(python, tempDir, id, names) {
  const input = path.join(tempDir, `${id}-ocr.json`);
  const output = path.join(tempDir, `${id}-facts.json`);
  await writeFile(input, `${JSON.stringify(fixture(names), null, 2)}\n`, "utf8");
  const result = await run(python, [
    "tools/jcc_augment_choice_field_aggregator.py",
    "--ocr-result", input,
    "--phase", "augment_choice",
    "--out", output,
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(await readFile(output, "utf8"));
}

async function main() {
  const catalog = JSON.parse(await readFile(createRuntimePaths(root).activeDecisionInputCatalogFile, "utf8"));
  const catalogRows = (catalog.entities || [])
    .filter((row) => row?.kind === "augment" && row?.id && row?.name)
    .slice(0, 6);
  assert.equal(catalogRows.length, 6, "current augment catalog must provide six fixture rows");

  const python = await resolvePython();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-augment-choice-regression-"));
  try {
    const firstNames = catalogRows.slice(0, 3).map((row) => row.name);
    const rerolledNames = [catalogRows[0], catalogRows[3], catalogRows[4]].map((row) => row.name);
    const first = await aggregate(python, tempDir, "initial", firstNames);
    const rerolled = await aggregate(python, tempDir, "rerolled", rerolledNames);
    const wrongWindow = await aggregate(python, tempDir, "wrong-window", [
      catalogRows[0].name,
      "not-a-current-augment-fixture",
      catalogRows[2].name,
    ]);

    for (const [label, facts, expectedNames] of [
      ["initial", first, firstNames],
      ["rerolled", rerolled, rerolledNames],
    ]) {
      assert.equal(facts.schema, "jcc-augment-choice-facts-v1", `${label} schema mismatch`);
      assert.equal(facts.ok, true, `${label} must be a stable catalog-matched choice window`);
      assert.equal(facts.choices.length, 3, `${label} must contain exactly three choices`);
      assert.deepEqual(facts.choices.map((choice) => choice.name), expectedNames, `${label} names mismatch`);
      assert(facts.choices.every((choice) => choice.catalog_match?.id), `${label} must retain catalog ids`);
      assert(facts.choices.every((choice) => choice.source === "resident_ocr_worker"), `${label} source mismatch`);
      assert(facts.choices.every((choice) => choice.description_lines.length === 1), `${label} descriptions must be preserved`);
    }

    assert.notDeepEqual(
      first.choices.map((choice) => choice.id),
      rerolled.choices.map((choice) => choice.id),
      "a rerolled visible choice set must replace the prior candidate fingerprint",
    );
    assert.equal(wrongWindow.ok, false, "catalog-unmatched text must fail the stable-window gate");
    assert.equal(wrongWindow.unresolved_choices.length, 1, "wrong-window fixture must expose one unresolved candidate");
    assert.equal(
      wrongWindow.rejection_reason,
      "augment_choice_requires_three_catalog_matched_candidates",
      "wrong-window rejection reason mismatch",
    );

    const realScreenshot = path.join(root, "data/runtime/jcc/fixtures/augment-choice/s17_8-2_1-gold-redacted.png");
    await access(realScreenshot);
    {
      const realDir = path.join(tempDir, "real-screenshot");
      const debugDir = path.join(realDir, "debug");
      const debugPanel = path.join(debugDir, "panel.png");
      const debugReport = path.join(debugDir, "report.json");
      try {
        const resolvedPython = await resolvePythonExecutable(python);
        await startAugmentChoiceRapidOcrWorker({
          python: resolvedPython,
          config: "data/runtime/jcc/rapidocr-ppocrv5-mobile.yaml",
          timeoutMs: 120000,
        });
        const started = Date.now();
        const attempt = await runExplicitAugmentChoiceDraftOcr({
          outDir: realDir,
          matchSessionId: "real-redacted-regression",
          captureSource: "fixture",
          framePath: realScreenshot,
          debugEvidenceDir: debugDir,
        });
        assert.equal(attempt.ok, false, "an S17 screenshot must not become a legal S18 augment draft");
        assert.ok(attempt.readable_choice_texts.length < 3, "a retired screenshot must not produce a complete active-season choice set");
        assert.ok(
          attempt.readable_choice_texts.every((choice) => choice.catalog_match?.id),
          "any overlapping name may survive only through a real active-catalog match",
        );
        assert.equal(attempt.artifacts?.crop_policy, "resident_worker_in_memory", "hot-path ROI preparation must remain inside the resident worker path");
        assert.equal(await fileExists(debugPanel), true, "the resident worker must retain the exact panel ROI image when an explicit debug path is supplied");
        assert.equal(await fileExists(debugReport), true, "Quick OCR must retain a compact diagnostic report beside the panel image");
        const report = JSON.parse(await readFile(debugReport, "utf8"));
        assert.equal(report.match_session_id, "real-redacted-regression");
        assert.deepEqual(report.readable_choice_texts, attempt.readable_choice_texts, "the diagnostic report must preserve the bounded active-catalog matches");
        assert.equal(report.ocr_results.length, 1, "the diagnostic report must preserve the exact panel OCR result without retaining the full frame");
        assert(Date.now() - started < 10000, "prewarmed real-frame ROI, OCR, and catalog matching must remain choice-window ready");
      } finally {
        await stopSharedRapidOcrWorker();
      }
    }

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "resident OCR result batches are aggregated by the augment-specific field aggregator",
        "exactly three current-catalog augment titles form a stable choice window",
        "description text remains attached to the correct slot",
        "rerolled candidates produce a new current choice fingerprint",
        "wrong-window or catalog-unmatched text is rejected instead of becoming a high-confidence choice",
        "the repository-owned privacy-redacted S17 screenshot cannot form a complete S18 choice set; any overlapping title must resolve through the active catalog",
      ],
      initial_choices: first.choices.map(({ slot, id, name }) => ({ slot, id, name })),
      rerolled_choices: rerolled.choices.map(({ slot, id, name }) => ({ slot, id, name })),
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
