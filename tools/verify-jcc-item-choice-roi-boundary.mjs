import { readFileSync } from "node:fs";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const runtimePaths = createRuntimePaths(repoRoot);
const activeRulesBundle = loadActiveRulesBundle({ repoRoot, runtimePaths });

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const roi = readText("tools/roi_item_choice.py");
const aggregator = readText("tools/jcc_item_choice_field_aggregator.py");
const runner = readText("tools/run-jcc-item-choice-roi-ocr.mjs");
const runtime = readText("ui/electron/runtime-service.js");
const modeMap = JSON.parse(readText("data/runtime/jcc/runtime-mode-sensing-map.json"));
const uiContract = JSON.parse(readText("data/runtime/jcc/runtime-ui-mode-contract.json"));

assert(roi.includes("basic_component_forge_name_row"), "item ROI must read the dedicated basic component forge ROI");
assert(roi.includes("completed_item_forge_name_row"), "item ROI must read the dedicated completed item forge ROI");
assert(roi.includes("artifact_forge_name_row"), "item ROI must read the dedicated artifact forge ROI");
assert(roi.includes("basic_component_forge"), "item ROI must support basic component forge as the default kind");
assert(roi.includes("completed_item_forge"), "item ROI must support completed item forge separately");
assert(roi.includes("artifact_forge"), "item ROI must support artifact forge separately");
assert(roi.includes("items.choice_options"), "item ROI must emit items.choice_options fields");
assert(!roi.includes("augment_choice_text_slots"), "item ROI must not reuse augment slots");
assert(!roi.includes("god_choice_text_slots"), "item ROI must not reuse god slots");
assert(!roi.includes("item_choice_forge_name_row"), "item ROI must not fall back to the old generic forge ROI name");

assert(aggregator.includes('"schema": "jcc-item-choice-facts-v1"'), "item aggregator must emit the item-choice facts schema");
assert(aggregator.includes('"source": "item_choice_roi_ocr"'), "item aggregator must mark item_choice_roi_ocr as source");
assert(aggregator.includes('"item_choice_kind"'), "item aggregator must emit item_choice_kind");
assert(aggregator.includes("item_matches_choice_kind"), "item aggregator must gate catalog matches by item choice kind");
for (const forbidden of ["augments", "god_choice_options", "god_reward_options"]) {
  assert(!aggregator.includes(forbidden), `item aggregator must not write ${forbidden}`);
}

assert(runner.includes("roi_item_choice.py"), "item runner must call the dedicated item ROI script");
assert(runner.includes("jcc_item_choice_field_aggregator.py"), "item runner must call the dedicated item aggregator");
assert(runner.includes("--item-choice-kind"), "item runner must pass item_choice_kind into ROI and aggregation");
assert(runner.includes("selected_report") && runner.includes("item_choice_kind"), "item runner report must expose item_choice_kind directly");
assert(runner.includes("runItemChoiceRoiOcrAttempt"), "item runner must expose one-frame attempt for resident worker reuse");
assert(runner.includes("runItemChoiceAdvicePipelineForSelection"), "item runner must materialize pipeline evidence for the host model");
assert(runner.includes("items: {") && runner.includes("choice_options: compactChoices"), "item runner must put options into items.choice_options");
for (const forbidden of ["current_choice_set: facts.choice_kind === \"augment_choice\"", "choices.god_choice_options"]) {
  assert(!runner.includes(forbidden), `item runner must not include ${forbidden}`);
}

assert(!runtime.includes('from "../../tools/run-jcc-item-choice-roi-ocr.mjs"'), "production runtime must not import the calibration-only item ROI runner");
assert(runtime.includes("normalizeItemChoiceKind"), "runtime must normalize item_choice_kind");
assert(runtime.includes("fastChoiceEntryMatchesOptions"), "runtime must prevent reusing stale item-choice pipelines across forge kinds");
const itemContract = activeRulesBundle.base_game_rules?.runtime_choice_modes?.item_choice;
assert(itemContract?.candidate_input_policy === "current_match_user_report", "active item candidates must come from the current-match user report");
assert(itemContract?.user_report_contract?.no_ocr_or_vision_fallback === true, "active item choice must forbid OCR and visual fallback");

assert(modeMap.modes.item_choice.user_report_contract?.source === "current_match_user_report", "mode map must route item choice through current-match user reports");
assert(modeMap.modes.item_choice.user_report_contract?.fallback === "none", "mode map must forbid item-choice OCR/vision fallback");
assert(modeMap.modes.item_choice.user_report_contract?.expected_count_by_kind?.basic_component_forge === 4, "basic component forge should expect four reported names");
assert(modeMap.modes.item_choice.user_report_contract?.expected_count_by_kind?.completed_item_forge === 5, "completed item forge should expect five reported names");
assert(modeMap.modes.item_choice.user_report_contract?.expected_count_by_kind?.artifact_forge === 4, "artifact forge should expect four reported names");
assert(modeMap.modes.item_choice.user_report_contract?.expected_count_by_kind?.radiant_item_choice === 4, "radiant choice should expect four reported names");
assert(/manual/i.test(modeMap.modes.item_choice.manual_trigger_policy || ""), "mode map must keep item choice manual-triggered");

assert(uiContract.modes.item_choice.choice_poll_policy?.worker === "current_match_user_report_with_host_scoring", "UI contract must route item choice through user reports and host scoring");
assert(uiContract.modes.item_choice.choice_poll_policy?.default_item_choice_kind === "basic_component_forge", "UI contract must default item choice to basic component forge");
assert(uiContract.modes.item_choice.choice_poll_policy?.expected_count_by_kind?.artifact_forge === 4, "UI contract must expect four visible artifact forge names");
assert(uiContract.modes.item_choice.choice_poll_policy?.expected_count_by_kind?.radiant_item_choice === 4, "UI contract must expect four radiant choice names");
assert(/cruise must not auto-run/i.test(uiContract.modes.item_choice.choice_poll_policy?.manual_trigger_policy || ""), "UI contract must forbid cruise auto-running item forge ROI");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "dedicated item ROI crop task",
    "dedicated item choice aggregator",
    "dedicated item runner",
    "production runtime excludes item-choice calibration OCR",
    "current-match user-report item forge policy",
  ],
}, null, 2));
