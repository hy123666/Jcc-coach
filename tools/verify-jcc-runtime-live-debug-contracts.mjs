import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  normalizeHostCoachResponse,
} from "../ui/electron/runtime-service.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const serviceSource = readFileSync(path.join(repoRoot, "ui/electron/runtime-service.js"), "utf8");
const daemonSource = readFileSync(path.join(repoRoot, "ui/electron/runtime-daemon.js"), "utf8");
const hostAdaptersSource = readFileSync(path.join(repoRoot, "ui/electron/host-adapters.js"), "utf8");
const appSource = readFileSync(path.join(repoRoot, "ui/src/App.tsx"), "utf8");
const augmentRunnerSource = readFileSync(path.join(repoRoot, "tools/run-jcc-augment-choice-roi-ocr.mjs"), "utf8");
const augmentAggregatorSource = readFileSync(path.join(repoRoot, "tools/jcc_augment_choice_field_aggregator.py"), "utf8");
const itemRunnerSource = readFileSync(path.join(repoRoot, "tools/run-jcc-item-choice-roi-ocr.mjs"), "utf8");
const itemAggregatorSource = readFileSync(path.join(repoRoot, "tools/jcc_item_choice_field_aggregator.py"), "utf8");

function assertIncludes(source, needle, message) {
  assert(source.includes(needle), message);
}

function pythonCommand() {
  for (const candidate of ["py", "python"]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return null;
}

function verifyLineupCardDeliveryBoundary() {
  const identity = {
    schema: "jcc-host-cli-coach-response-v1",
    generated_by: "current_cli_agent_main_model",
  };
  const request = {
    mode: "lineup_card",
    season_catalog: {
      champion_names: ["贾克斯", "潘森", "蕾欧娜", "阿卡丽", "菲奥娜", "慎", "奥恩", "千珏"],
    },
  };
  const proseOnly = normalizeHostCoachResponse(
    { ...identity, final_text: "走贾克斯。", confidence: "medium" },
    request,
  );
  assert.equal(proseOnly.final_text, "走贾克斯。");
  assert.equal(proseOnly.pinned_result, null, "prose-only lineup advice must deliver text without publishing a card");
  const incompleteCard = normalizeHostCoachResponse({
      ...identity,
      final_text: "走贾克斯。",
      confidence: "medium",
      pinned_result: {
        slot: "lineup",
        title: "烂卡",
        units: [
          { row: 1, col: 1, name: "贾克斯" },
          { row: 1, col: 2, name: "潘森" },
          { row: 1, col: 3, name: "蕾欧娜" },
        ],
        loadouts: [{ unit: "贾克斯", items: ["饮血剑"] }],
        moves: ["3-2 找贾克斯。"],
      },
    }, request);
  assert.equal(incompleteCard.final_text, "走贾克斯。");
  assert.equal(incompleteCard.pinned_result, null, "an incomplete card must be dropped without discarding readable strategy text");
  const accepted = normalizeHostCoachResponse({
    ...identity,
    final_text: "目标阵容按贾克斯成型。",
    confidence: "medium",
    pinned_result: {
      slot: "lineup",
      title: "贾克斯目标阵容",
      units: [
        { row: 1, col: 1, name: "潘森" },
        { row: 1, col: 2, name: "蕾欧娜" },
        { row: 1, col: 3, name: "慎" },
        { row: 1, col: 4, name: "奥恩" },
        { row: 2, col: 3, name: "贾克斯" },
        { row: 3, col: 3, name: "阿卡丽" },
        { row: 4, col: 4, name: "菲奥娜" },
      ],
      loadouts: [{ unit: "贾克斯", items: ["饮血剑", "泰坦的坚决"] }],
      moves: ["6 级慢 D 贾克斯三星。"],
    },
  }, request);
  assert.equal(accepted.pinned_result.units.length, 7);
}

function verifyStaticContracts() {
  assertIncludes(serviceSource, "latest_authoritative_facts: buildAuthoritativeMatchFactsSnapshot", "match context updates must rebuild authoritative facts");
  assertIncludes(serviceSource, "selectAuthoritativeLiveStateSummary({", "host context must select authoritative live_state instead of blindly trusting stale request context");
  assertIncludes(serviceSource, "lineupPinnedResultIsPublishable", "lineup cards must have a hard publishability gate");
  assert(!serviceSource.includes("normalizeHostCoachResponse(retry.response, enrichedHostRequest, { allowLineupFallback: true })"), "retired Provider correction retries must remain absent");
  assertIncludes(daemonSource, "daemonFastControlActions", "stopResponse must bypass the serialized action chain");
  assertIncludes(daemonSource, '"stopResponse"', "stopResponse must be registered as a fast control action");
  assertIncludes(hostAdaptersSource, "const taskPrefix = `${normalizedTaskId}:`;", "host adapter cancellation must cancel response child tasks");
  assertIncludes(hostAdaptersSource, "!activeTaskId.startsWith(taskPrefix)", "host adapter cancellation must only keep unrelated active host processes");
  assertIncludes(serviceSource, "status: \"response_task_id_mismatch\"", "runtime stopResponse must ignore stale stop clicks instead of clearing a newer response task");
  assertIncludes(serviceSource, "currentActiveTaskId.startsWith(`${requestedTaskId}:`)", "runtime stopResponse must let a parent task id cancel its active child task");
  assertIncludes(appSource, "responseGenerationRef", "UI must ignore late sendMessage results after stop");
  assertIncludes(appSource, "response_task_id: taskId", "UI must pass the current response_task_id to stopResponse");
  assertIncludes(appSource, "response_task_revision: taskRevision", "UI must pass the current response_task revision to stopResponse");
  assertIncludes(augmentRunnerSource, "facts?.ok === true", "augment OCR runner must require stable accepted facts");
  assertIncludes(augmentRunnerSource, "facts.choices.length === 3", "augment OCR runner must require all three slots");
  assertIncludes(augmentAggregatorSource, "augment_choice_requires_three_catalog_matched_candidates", "augment OCR aggregator must reject non-catalog dirty candidates");
  assertIncludes(itemRunnerSource, "facts?.ok === true", "item OCR runner must require stable accepted facts");
  assertIncludes(itemRunnerSource, "choices.length === expectedCount", "item OCR runner must require the expected forge candidate count");
  assertIncludes(itemRunnerSource, "choice?.id && choice?.catalog_match?.id", "item OCR runner must require catalog-matched item candidates");
  assertIncludes(itemAggregatorSource, "item_choice_requires_catalog_matched_expected_candidates", "item OCR aggregator must reject non-catalog dirty candidates");
}

function verifyAugmentDirtyOcrRejected() {
  const py = pythonCommand();
  if (!py) {
    console.warn("[verify] Python not found; skipped dynamic augment dirty OCR check.");
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "jcc-augment-dirty-"));
  const ocrResult = path.join(dir, "ocr-result.json");
  const out = path.join(dir, "facts.json");
  writeFileSync(ocrResult, JSON.stringify({
    results: [
      {
        id: "augment-panel",
        ok: true,
        text: "232/200 魔偶大人呜哈哈 not an augment",
        roi: { x: 0, y: 0, w: 300, h: 300 },
        evidence: {
          slot_parts: [
            { slot: 0, part: "name", field: "augment_slot_0_name", panel_relative_roi: { x: 0, y: 0, w: 1, h: 0.3 } },
            { slot: 1, part: "name", field: "augment_slot_1_name", panel_relative_roi: { x: 0, y: 0.33, w: 1, h: 0.3 } },
            { slot: 2, part: "name", field: "augment_slot_2_name", panel_relative_roi: { x: 0, y: 0.66, w: 1, h: 0.3 } },
          ],
        },
        blocks: [
          { text: "232/200", rect: { x: 10, y: 20, w: 120, h: 20 }, confidence: 0.99 },
          { text: "魔偶大人呜哈哈", rect: { x: 10, y: 120, w: 180, h: 20 }, confidence: 0.99 },
          { text: "not an augment", rect: { x: 10, y: 220, w: 180, h: 20 }, confidence: 0.99 },
        ],
      },
    ],
  }, null, 2));
  const result = spawnSync(py, [
    path.join(repoRoot, "tools/jcc_augment_choice_field_aggregator.py"),
    "--ocr-result", ocrResult,
    "--phase", "augment_choice",
    "--out", out,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const facts = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(facts.ok, false, "dirty non-choice OCR must not be accepted as stable augment choices");
  assert.equal(facts.choices.length, 0, "unmatched OCR strings must not enter accepted choices");
  assert.equal(facts.unresolved_choices.length, 3, "dirty OCR strings should remain diagnostic evidence");
}

function verifyItemDirtyOcrRejected() {
  const py = pythonCommand();
  if (!py) {
    console.warn("[verify] Python not found; skipped dynamic item dirty OCR check.");
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "jcc-item-dirty-"));
  const ocrResult = path.join(dir, "ocr-result.json");
  const out = path.join(dir, "facts.json");
  writeFileSync(ocrResult, JSON.stringify({
    results: [
      {
        id: "item-row",
        ok: true,
        text: "232/200 wrong panel words",
        roi: { x: 0, y: 0, w: 400, h: 80 },
        evidence: {
          slot_parts: [
            { slot: 0, part: "name", field: "items.choice_options.0.name", panel_relative_roi: { x: 0.0, y: 0, w: 0.25, h: 1 } },
            { slot: 1, part: "name", field: "items.choice_options.1.name", panel_relative_roi: { x: 0.25, y: 0, w: 0.25, h: 1 } },
            { slot: 2, part: "name", field: "items.choice_options.2.name", panel_relative_roi: { x: 0.5, y: 0, w: 0.25, h: 1 } },
            { slot: 3, part: "name", field: "items.choice_options.3.name", panel_relative_roi: { x: 0.75, y: 0, w: 0.25, h: 1 } },
          ],
        },
        blocks: [
          { text: "232/200", rect: { x: 10, y: 20, w: 70, h: 20 }, confidence: 0.99 },
          { text: "wrong", rect: { x: 110, y: 20, w: 70, h: 20 }, confidence: 0.99 },
          { text: "panel", rect: { x: 210, y: 20, w: 70, h: 20 }, confidence: 0.99 },
          { text: "words", rect: { x: 310, y: 20, w: 70, h: 20 }, confidence: 0.99 },
        ],
      },
    ],
  }, null, 2));
  const result = spawnSync(py, [
    path.join(repoRoot, "tools/jcc_item_choice_field_aggregator.py"),
    "--ocr-result", ocrResult,
    "--phase", "item_choice",
    "--item-choice-kind", "basic_component_forge",
    "--out", out,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const facts = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(facts.ok, false, "dirty non-item OCR must not be accepted as stable item choices");
  assert.equal(facts.choices.length, 0, "unmatched item OCR strings must not enter accepted choices");
  assert.equal(facts.unresolved_choices.length, 4, "dirty item OCR strings should remain diagnostic evidence");
}

verifyLineupCardDeliveryBoundary();
verifyStaticContracts();
verifyAugmentDirtyOcrRejected();
verifyItemDirtyOcrRejected();

console.log(JSON.stringify({
  ok: true,
  checks: [
    "authoritative_facts_static_contract",
    "lineup_card_hard_contract",
    "augment_dirty_ocr_rejected",
    "item_dirty_ocr_rejected",
    "god_incomplete_ocr_rejected",
    "stop_response_fast_control_contract",
  ],
}, null, 2));
