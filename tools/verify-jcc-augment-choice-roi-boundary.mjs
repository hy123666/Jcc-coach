import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePaths = createRuntimePaths(repoRoot);
const activeRulesBundle = loadActiveRulesBundle({ repoRoot, runtimePaths });

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const removedPaths = [
  "tools/roi_choice_panel.py",
  "tools/jcc_choice_field_aggregator.py",
  "tools/run-jcc-choice-panel-roi-ocr.mjs",
];

for (const relativePath of removedPaths) {
  assert(!existsSync(path.join(repoRoot, relativePath)), `${relativePath} must stay removed; use augment-specific ROI files.`);
}

const augmentRoi = readText("tools/roi_augment_choice.py");
const augmentRunner = readText("tools/run-jcc-augment-choice-roi-ocr.mjs");
const augmentAggregator = readText("tools/jcc_augment_choice_field_aggregator.py");
const runtimeService = readText("ui/electron/runtime-service.js");

const forbiddenNeedles = [
  "roi_choice_panel",
  "jcc_choice_field_aggregator",
  "run-jcc-choice-panel-roi-ocr",
  "choice_panel_roi_ocr",
  "choice-panel-roi-ocr",
  "choice_panel_search",
  "runChoicePanel",
  "ChoicePanel",
];

for (const needle of forbiddenNeedles) {
  const haystack = [augmentRoi, augmentRunner, augmentAggregator, runtimeService].join("\n");
  assert(!haystack.includes(needle), `Old generic choice OCR name leaked back into product path: ${needle}`);
}

for (const needle of ["god_choice_options", "item_choice_options"]) {
  const haystack = [augmentRoi, augmentRunner, augmentAggregator].join("\n");
  assert(!haystack.includes(needle), `Non-augment choice field leaked into augment ROI path: ${needle}`);
}

assert(augmentRoi.includes("SOURCE_SCRIPT = \"tools/roi_augment_choice.py\""), "augment ROI script must identify itself as the augment-specific cropper.");
assert(augmentRoi.includes("def augment_slots"), "augment ROI script must use augment-specific slot naming.");
assert(augmentRunner.includes("augment-choice ROI OCR only supports phase augment_choice"), "augment runner must reject non-augment phases.");
assert(augmentAggregator.includes("\"schema\": \"jcc-augment-choice-facts-v1\""), "augment aggregator must emit augment-specific facts.");
const augmentContract = activeRulesBundle.base_game_rules?.runtime_choice_modes?.augment_choice;
assert(augmentContract?.candidate_input_policy === "current_match_user_report", "active augment candidates must come from the current-match user report.");
assert(augmentContract?.user_report_contract?.no_ocr_or_vision_fallback === true, "active augment choice must forbid OCR and visual fallback.");
assert(!runtimeService.includes('from "../../tools/run-jcc-augment-choice-roi-ocr.mjs"'), "production runtime must not import the calibration-only augment ROI runner.");
assert(runtimeService.includes("void runtimeMode;\n  void rulesBundle;\n  return null;"), "production runtime must hard-fence legacy choice OCR adapters.");

console.log("verify-jcc-augment-choice-roi-boundary: calibration-only ok");
