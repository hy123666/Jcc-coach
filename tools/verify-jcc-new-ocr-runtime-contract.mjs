import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function main() {
  const service = await readFile("ui/electron/runtime-service.js", "utf8");
  const sensingText = await readFile("data/runtime/jcc/runtime-mode-sensing-map.json", "utf8");
  const sensing = JSON.parse(sensingText);

  assert(service.includes("../../tools/run-jcc-self-state-roi-ocr.mjs"), "runtime must import the new self-state ROI OCR runner");
  assert(service.includes('"tools/run-jcc-self-state-roi-ocr.mjs"'), "runtime allowlist must include the new self-state ROI OCR runner");
  assert(service.includes("runSelfStateRoiOcrWithWorker(selfStateRoiOcrOptions, worker)"), "self-state refresh must execute through crop-task ROI OCR");
  assert(service.includes('last_source: "self_state_roi_ocr"'), "runtime must write only the new self-state ROI OCR source");
  assert(service.includes('return source === "self_state_roi_ocr";'), "runtime must only accept the new self-state ROI OCR source");

  assert(sensingText.includes('"roi_script": "tools/roi_stage.py"'), "sensing map must route stage through ROI script");
  assert(sensingText.includes('"roi_script": "tools/roi_gold.py"'), "sensing map must route gold through ROI script");
  assert(sensingText.includes('"roi_script": "tools/roi_level_xp.py"'), "sensing map must route level/xp through ROI script");
  assert(sensingText.includes('"roi_script": "tools/roi_hp_local.py"'), "sensing map must route HP through ROI script");
  assert(sensingText.includes('"aggregator": "tools/jcc_ocr_field_aggregator.py"'), "sensing map must route OCR text through the unified aggregator");
  assert.equal(
    sensing.global_policies?.hud_fact_sampling_trigger_policy,
    "runtime_watchdog_or_explicit_refresh_updates_context_only; only_registered_semantic_event_gates_may_open_host_response_lane",
    "HUD fact sampling must update context without directly opening a host response lane",
  );
  console.log("verify-jcc-new-ocr-runtime-contract: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
