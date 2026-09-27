import { spawn } from "node:child_process";
import path from "node:path";

const CHECKS = [
  ["visual_frame_capture", ["tools/verify-jcc-visual-frame-capture.mjs"], true],
  ["runtime_mode_sensing_map", ["tools/verify-jcc-runtime-mode-sensing-map.mjs"], true],
  ["self_state_roi_contract", ["tools/verify-jcc-new-ocr-runtime-contract.mjs"], true],
  ["self_state_roi_ocr", ["tools/verify-jcc-self-state-roi-ocr.mjs"], true],
  ["augment_choice_roi_boundary", ["tools/verify-jcc-augment-choice-roi-boundary.mjs"], true],
  ["augment_choice_catalog_regression", ["tools/verify-jcc-augment-choice-live-regression.mjs"], true],
  ["owned_augment_text_panel_boundary", ["tools/verify-jcc-owned-augment-text-panel-roi-boundary.mjs"], true],
  ["item_choice_roi_boundary", ["tools/verify-jcc-item-choice-roi-boundary.mjs"], true],
  ["item_icon_template_sets", ["tools/verify-jcc-item-icon-template-sets.mjs"], true],
  ["left_item_rail_roi_icon_boundary", ["tools/verify-jcc-left-item-rail-roi-icon-boundary.mjs"], true],
  ["left_item_rail_product_source", ["tools/verify-jcc-left-item-rail-product-source.mjs"], true],
  ["fixed_equipped_roi_removed", ["tools/verify-jcc-fixed-equipped-roi-removed.mjs"], true],
  ["mumu_equipment_source_priority", ["tools/verify-jcc-mumu-equipment-source-priority.mjs"], true],
  ["item_icon_ambiguity", ["tools/verify-jcc-visual-icon-ambiguity.mjs"], true],
  ["host_multimodal_vision_observation", ["tools/verify-jcc-vision-model-observation.mjs"], true],
  ["host_multimodal_runtime_observation", ["tools/verify-jcc-multimodal-runtime-observation.mjs"], true],
  ["visual_live_state_apply_merge", ["tools/verify-jcc-visual-live-state.mjs"], true],
  ["no_opponent_product_modes", ["tools/verify-jcc-no-opponent-product-modes.mjs"], true],
  ["runtime_ui_mode_contract", ["tools/verify-jcc-runtime-ui-mode-contract.mjs"], true],
  ["new_match_session_isolation", ["tools/verify-jcc-new-match-session-isolation.mjs"], true],
  ["cruise_strategy_semantics_contract", ["tools/verify-jcc-cruise-strategy-semantics-contract.mjs"], true],
  ["cruise_strategy_scorer", ["tools/verify-jcc-cruise-strategy-scorer.mjs"], true],
  ["cruise_trigger_coverage", ["tools/verify-jcc-cruise-trigger-coverage.mjs"], true],
  ["combat_cap_estimator_context", ["tools/verify-jcc-combat-cap-estimator-context.mjs"], true],
  ["cruise_runtime_pipeline", ["tools/verify-jcc-cruise-runtime-pipeline.mjs"], true],
  ["cruise_debug_trace", ["tools/verify-jcc-cruise-debug-trace.mjs"], true],
  ["choice_confirmation_hooks", ["tools/verify-jcc-choice-confirmation-hooks.mjs"], true],
  ["visual_icon_assets", ["tools/verify-jcc-visual-icon-assets.mjs"], true],
  ["selected_augment_side_rail_policy", ["tools/verify-jcc-selected-augment-side-rail-policy.mjs"], true],
  ["mumu_runtime_model_static_reverse_debug", ["tools/verify-jcc-mumu-runtime-model.mjs"], false],
  ["mumu_runtime_autodiscovery", ["tools/verify-jcc-mumu-runtime-autodiscovery.mjs"], false],
  ["lineup_display_contract", ["tools/verify-jcc-lineup-display-contract.mjs"], true],
  ["runtime_agent_wiki", ["tools/verify-jcc-runtime-agent-wiki.mjs"], true],
  ["adb_diagnostics_contract", ["tools/verify-jcc-adb-diagnostics.mjs"], true],
  ["action_pollution_guard", ["tools/verify-jcc-current-match-action-diff.mjs"], true],
  ["board_bench_action_candidates", ["tools/verify-jcc-board-bench-action-candidates.mjs"], true],
  ["runtime_coverage", ["tools/verify-jcc-runtime-coverage-report.mjs"], true],
  ["match_live_state_bootstrap", ["tools/verify-jcc-match-live-state-bootstrap.mjs"], true],
  ["adb_current_status", ["tools/diagnose-jcc-adb.mjs"], false],
];

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  const checks = [];
  for (const [name, args, required] of CHECKS) {
    const result = await runNode(args);
    const parsed = parseMaybeJson(result.stdout.trim());
    checks.push({
      name,
      required,
      ok: result.code === 0,
      code: result.code,
      summary: parsed || result.stdout.trim().slice(0, 1000),
      stderr: result.stderr.trim(),
    });
  }
  const requiredFailures = checks.filter((check) => check.required && !check.ok);
  const adb = checks.find((check) => check.name === "adb_current_status");
  const onlineDevices = Array.isArray(adb?.summary?.online_devices) ? adb.summary.online_devices : [];
  const mumuOnline = adb?.summary?.mumu_adb_runtime_ready === true;
  const report = {
    ok: requiredFailures.length === 0,
    required_failures: requiredFailures.map((check) => check.name),
    adb_available: adb?.ok === true && onlineDevices.length > 0,
    mumu_adb_runtime_ready: mumuOnline,
    recommended_mumu_device: adb?.summary?.recommended_mumu_device || null,
    adb_runtime_ready: mumuOnline,
    adb_status: adb?.summary || null,
    checks,
    mumu_discovery_command: "node tools/discover-jcc-mumu-adb-target.mjs",
    self_state_ocr_command: "node tools/run-jcc-self-state-roi-ocr.mjs --out-dir <dir> --device <recommended_mumu_device>",
    choice_candidate_intake: "current_match_user_report",
    choice_ocr_calibration_command: "node tools/run-jcc-augment-choice-roi-ocr.mjs --compatibility-calibration --phase augment_choice --out-dir <dir> --device <recommended_mumu_device>",
    choice_visual_calibration_command: "node tools/run-jcc-multimodal-runtime-observation.mjs --compatibility-calibration --frame <visual-frame.json> --live-state <state.json> --mode <mode> --out-dir <dir> --agent-response <host-cli-agent-response.json>",
    choice_calibration_warning: "Choice OCR and host vision are calibration-only and must never promote augment, descriptor-owned season-choice, or item/anvil candidates into active product truth.",
    mumu_logcat_command: "node tools/start-jcc-mumu-runtime-watch.mjs",
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
