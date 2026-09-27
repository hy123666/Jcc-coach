import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertFile(relativePath) {
  assert(existsSync(path.join(repoRoot, relativePath)), `${relativePath} must exist`);
}

const files = [
  "tools/roi_owned_augment_text_panel.py",
  "tools/jcc_owned_augment_text_panel_aggregator.py",
  "tools/run-jcc-owned-augment-text-panel-roi-ocr.mjs",
];

for (const file of files) assertFile(file);

const layout = readJson("data/runtime/jcc/visual-roi-layout.json");
const regions = layout.regions || {};
const panel = regions.owned_augment_text_panel;
const slots = regions.owned_augment_text_panel_slots || [];

assert(panel, "layout must define regions.owned_augment_text_panel");
assert(Array.isArray(slots) && slots.length === 3, "layout must define exactly three owned augment text-panel slots");
assert(slots.every((slot) => slot.kind === "augment"), "every owned text-panel slot must be a selected augment");
assert(slots[0].choice_stage_round === "2-1", "slot 0 must map to the 2-1 augment");
assert(slots[1].choice_stage_round === "3-2", "slot 1 must map to the 3-2 augment");
assert(slots[2].choice_stage_round === "4-2", "slot 2 must map to the 4-2 augment");
assert(slots.every((slot) => slot.text && typeof slot.text.x === "number"), "every owned text-panel slot must carry a text ROI");

const roiScript = readText("tools/roi_owned_augment_text_panel.py");
const aggregator = readText("tools/jcc_owned_augment_text_panel_aggregator.py");
const runner = readText("tools/run-jcc-owned-augment-text-panel-roi-ocr.mjs");
const runtimeService = readText("ui/electron/runtime-service.js");
const modeMap = readJson("data/runtime/jcc/runtime-mode-sensing-map.json");
const uiContract = readJson("data/runtime/jcc/runtime-ui-mode-contract.json");

assert(roiScript.includes("SOURCE_SCRIPT = \"tools/roi_owned_augment_text_panel.py\""), "owned text-panel ROI script must identify itself");
assert(roiScript.includes("owned_augment_text_panel_slots"), "owned text-panel ROI script must use the dedicated layout slots");
assert(!/rapidocr|ocr|catalog|match_augment/i.test(roiScript), "owned text-panel ROI script must crop only; no OCR or catalog matching");

assert(aggregator.includes("\"schema\": \"jcc-owned-augment-text-panel-facts-v1\""), "owned text-panel aggregator must emit its own schema");
assert(aggregator.includes("user_triggered_owned_augment_text_panel_ocr"), "owned text-panel aggregator must use the distinct manual source");
assert(aggregator.includes("owned_augment_text_panel_confirmed"), "owned text-panel aggregator must emit owned-panel augment confirmation events");
assert(!aggregator.includes("augment_choice_text_slots"), "owned text-panel aggregator must not inspect augment-choice three-card slots");
assert(!aggregator.includes("god_choice_text_slots"), "owned text-panel aggregator must not inspect god-choice two-card slots");
assert(!aggregator.includes("current_god_final"), "owned text-panel aggregator must not retain an S17 final-god field");

assert(runner.includes("roi_owned_augment_text_panel.py"), "owned text-panel runner must call the dedicated ROI cropper");
assert(runner.includes("jcc_owned_augment_text_panel_aggregator.py"), "owned text-panel runner must call the dedicated aggregator");
assert(!runner.includes("roi_augment_choice.py"), "owned text-panel runner must not call augment-choice ROI");
assert(!runner.includes("roi_god_choice.py"), "owned text-panel runner must not call god-choice ROI");
assert(!runner.includes("jcc_augment_choice_field_aggregator.py"), "owned text-panel runner must not call augment-choice aggregator");
assert(!runner.includes("jcc_god_choice_field_aggregator.py"), "owned text-panel runner must not call god-choice aggregator");
assert(!runner.includes("currentGodRow"), "owned text-panel runner must not retain an S17 final-god row");

assert(runtimeService.includes("startOwnedAugmentTextPanelRapidOcrWorker"), "runtime must use a dedicated owned text-panel OCR worker boundary");
const ownedPanelRuntimeStart = runtimeService.indexOf("async function runOwnedAugmentTextPanelOcrForUserMessage({ taskId })");
const ownedPanelRuntimeEnd = runtimeService.indexOf("function messageRequestsOwnedAugmentTextPanelOcr", ownedPanelRuntimeStart);
assert(ownedPanelRuntimeStart >= 0 && ownedPanelRuntimeEnd > ownedPanelRuntimeStart, "runtime must contain the owned text-panel manual trigger implementation");
const ownedPanelRuntime = runtimeService.slice(ownedPanelRuntimeStart, ownedPanelRuntimeEnd);
assert(ownedPanelRuntime.includes("getOwnedAugmentTextPanelRapidOcrWorker()"), "owned text-panel trigger must use its own resident worker");
assert(!ownedPanelRuntime.includes("getAugmentChoiceRapidOcrWorker()"), "owned text-panel trigger must not reuse the augment-choice three-card worker");
assert(ownedPanelRuntime.includes("initialMatchSessionId"), "owned text-panel trigger must capture initial match_session_id");
assert(ownedPanelRuntime.includes("activeResponseTaskId !== taskId"), "owned text-panel trigger must drop stale task results");
assert(ownedPanelRuntime.includes("currentMatchSessionId !== initialMatchSessionId"), "owned text-panel trigger must drop cross-match OCR results");
assert(ownedPanelRuntime.includes("owned_augment_text_panel_ocr_stale_result_dropped"), "owned text-panel stale drops must be logged for replay review");
assert(ownedPanelRuntime.includes("已读取已拥有强化符文"), "owned text-panel OCR must return a user-visible read receipt");
assert(ownedPanelRuntime.includes("response: state.response_task.response"), "owned text-panel OCR must return a top-level response for UI display");
assert(ownedPanelRuntime.includes("persistStateAndCanonicalResponseTask"), "owned text-panel OCR must persist canonical response_task for daemon/UI reconciliation");

const sensing = modeMap.modes?.augment_choice?.owned_augment_text_panel_roi || {};
assert(sensing.enabled === true, "owned augment text-panel sensing must be enabled after ROI calibration");
assert(sensing.trigger === "manual_augment_mode_owned_augment_panel_preset_only", "owned text-panel sensing must remain manual augment-mode only");
assert(sensing.roi_script === "tools/roi_owned_augment_text_panel.py", "mode map must point at the owned text-panel ROI script");
assert(sensing.aggregator === "tools/jcc_owned_augment_text_panel_aggregator.py", "mode map must point at the owned text-panel aggregator");
assert(sensing.source === "user_triggered_owned_augment_text_panel_ocr", "mode map must preserve the owned text-panel source");
assert((sensing.must_not_write || []).includes("current_choice_set"), "owned text-panel sensing must not overwrite current visible choice set");

const uiPanel = uiContract.modes?.augment_choice?.manual_owned_augment_text_panel || {};
assert(uiPanel.roi_script === "tools/roi_owned_augment_text_panel.py", "UI contract must point at the owned text-panel ROI script");
assert(uiPanel.aggregator === "tools/jcc_owned_augment_text_panel_aggregator.py", "UI contract must point at the owned text-panel aggregator");
assert(uiPanel.pollution_policy?.includes("Do not run from cruise"), "UI contract must forbid cruise-triggered owned text-panel OCR");

const forbiddenProductNeedles = [
  "roi_choice_panel",
  "jcc_choice_field_aggregator",
  "poll-jcc-legacy-choice-ocr-debug",
];
const productText = [
  roiScript,
  aggregator,
  runner,
  readText("data/runtime/jcc/runtime-mode-sensing-map.json"),
  readText("data/runtime/jcc/runtime-ui-mode-contract.json"),
].join("\n");
for (const needle of forbiddenProductNeedles) {
  assert(!productText.includes(needle), `owned text-panel product path must not mention old generic/debug choice path: ${needle}`);
}

console.log("verify-jcc-owned-augment-text-panel-roi-boundary: ok");
