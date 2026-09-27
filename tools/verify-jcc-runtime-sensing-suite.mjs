import { spawn } from "node:child_process";

const TESTS = [
  {
    id: "mode_contract",
    command: ["node", "tools/verify-jcc-runtime-ui-mode-contract.mjs"],
    covers: ["product_modes", "opponent_modes_removed", "choice_modes", "self_refresh"],
  },
  {
    id: "mode_sensing_map",
    command: ["node", "tools/verify-jcc-runtime-mode-sensing-map.mjs"],
    covers: ["mode_to_sensing_paths", "s1_s2_policy", "4353_4354_4356_4357_contract"],
  },
  {
    id: "obsolete_debug_tools_removed",
    command: ["node", "tools/verify-jcc-no-opponent-product-modes.mjs"],
    covers: ["obsolete_legacy_debug_tools_absent", "opponent_product_modes_absent"],
  },
  {
    id: "self_state_roi_contract",
    command: ["node", "tools/verify-jcc-new-ocr-runtime-contract.mjs"],
    covers: ["python_roi_crop_tasks", "resident_ocr_worker", "self_state_aggregator"],
  },
  {
    id: "self_state_roi_ocr",
    command: ["node", "tools/verify-jcc-self-state-roi-ocr.mjs"],
    covers: ["stage_hp_gold_level_xp", "crop_task_batch", "structured_hud_facts"],
  },
  {
    id: "owned_augment_text_panel_boundary",
    command: ["node", "tools/verify-jcc-owned-augment-text-panel-roi-boundary.mjs"],
    covers: ["manual_owned_augment_panel", "same_match_confirmation", "no_side_rail_truth"],
  },
  {
    id: "user_reported_choice_contract",
    command: ["node", "tools/verify-jcc-user-reported-choice-contract.mjs"],
    covers: ["current_match_choice_report", "no_choice_ocr_or_vision_fallback", "choice_revision_freshness"],
  },
  {
    id: "choice_composer_prefill",
    command: ["node", "tools/verify-jcc-choice-composer-prefill-ui.mjs"],
    covers: ["descriptor_driven_report_prompt", "refresh_prefix_prefill", "no_auto_send"],
  },
  {
    id: "choice_fast_coach_gates",
    command: ["node", "tools/verify-jcc-runtime-choice-fast-coach-gates.mjs"],
    covers: ["user_report_mode_entry", "reported_choice_context", "season_neutral_ui"],
  },
  {
    id: "item_icon_template_sets",
    command: ["node", "tools/verify-jcc-item-icon-template-sets.mjs"],
    covers: ["item_icon_matcher", "template_sets", "scene_scoped_candidate_pools"],
  },
  {
    id: "left_item_rail_product_source",
    command: ["node", "tools/verify-jcc-left-item-rail-product-source.mjs"],
    covers: ["refresh_self_state", "left_item_rail", "legacy_icon_quarantine"],
  },
  {
    id: "left_item_rail_roi_boundary",
    command: ["node", "tools/verify-jcc-left-item-rail-roi-icon-boundary.mjs"],
    covers: ["roi_crop_only", "scene_scoped_item_matcher", "fallback_candidates_only"],
  },
  {
    id: "fixed_equipped_roi_removed",
    command: ["node", "tools/verify-jcc-fixed-equipped-roi-removed.mjs"],
    covers: ["no_fixed_equipped_roi", "4356_to_4353_assignment", "s2_diagnostic_only"],
  },
  {
    id: "mumu_equipment_source_priority",
    command: ["node", "tools/verify-jcc-mumu-equipment-source-priority.mjs"],
    covers: ["4357_inventory_primary", "4356_coordinate_assignment", "icon_matcher_fallback_only"],
  },
  {
    id: "icon_assets",
    command: ["node", "tools/verify-jcc-visual-icon-assets.mjs"],
    covers: ["icon_manifest", "catalog_icon_urls", "deterministic_paths"],
  },
  {
    id: "icon_ambiguity",
    command: ["node", "tools/verify-jcc-visual-icon-ambiguity.mjs"],
    covers: ["reference_possible_ids", "disambiguation_needed", "same_icon_not_forced_unique"],
  },
  {
    id: "mumu_s1_self_anchor",
    command: ["node", "tools/verify-jcc-mumu-s1-self-anchor.mjs"],
    covers: ["mumu_bridge", "self_view_anchor", "own_board_phase_gate", "s2_no_opponent_facts"],
  },
  {
    id: "mumu_shop_anchor_guards",
    command: ["node", "tools/verify-jcc-mumu-shop-anchor-guards.mjs"],
    covers: ["mumu_bridge", "shop_self_view_anchor", "replay_guard", "cross_match_guard", "stale_anchor_guard"],
  },
  {
    id: "mumu_runtime_watch",
    command: ["node", "tools/verify-jcc-mumu-runtime-watch-logcat.mjs"],
    covers: ["cruise_pipeline", "mumu_bridge", "advice_task_pipeline"],
  },
  {
    id: "mumu_watch_item_source_diagnostics",
    command: ["node", "tools/verify-jcc-mumu-watch-item-source-diagnostics.mjs"],
    covers: ["4357_source_absence", "equipment_command_drift", "equipment_parse_rejection", "clean_empty_4357"],
  },
  {
    id: "mumu_board_grid_mapping",
    command: ["node", "tools/verify-jcc-mumu-board-grid-mapping.mjs"],
    covers: ["mumu_bridge", "own_board_positioning", "board_grid_mapping", "bench_pollution_guard"],
  },
  {
    id: "host_summary_current_view_scope",
    command: ["node", "tools/verify-jcc-host-summary-current-view-scope.mjs"],
    covers: ["host_context", "current_view_scope_guard", "own_board_not_polluted"],
  },
  {
    id: "mainline_no_mojibake",
    command: ["node", "tools/verify-jcc-mainline-no-mojibake.mjs"],
    covers: ["node_utf8_json_policy", "catalog_chinese_names", "host_response_writer_no_bom"],
  },
  {
    id: "leveling_economy_ev",
    command: ["node", "tools/verify-jcc-leveling-economy-context.mjs"],
    covers: ["xp_progress_fraction", "variable_xp_policy", "economy_ev_actions", "cruise_leveling_advice"],
  },
  {
    id: "resource_policy_catalog",
    command: ["node", "tools/verify-jcc-resource-policy-catalog.mjs"],
    covers: ["resource_taxonomy", "xp_view_derivation", "pending_fail_closed", "known_policy_fields"],
  },
];

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const results = [];
  for (const test of TESTS) {
    const [command, ...args] = test.command;
    const started = Date.now();
    const result = await run(command, args);
    const elapsedMs = Date.now() - started;
    let parsed = null;
    try {
      const trimmed = result.stdout.trim();
      const jsonStart = trimmed.indexOf("{");
      if (jsonStart >= 0) parsed = JSON.parse(trimmed.slice(jsonStart));
    } catch {
      parsed = null;
    }
    results.push({
      id: test.id,
      ok: result.code === 0,
      elapsed_ms: elapsedMs,
      covers: test.covers,
      summary: parsed?.checked || parsed?.ok || null,
      stdout_tail: result.stdout.trim().slice(-1200),
      stderr_tail: result.stderr.trim().slice(-1200),
    });
  }
  const failed = results.filter((entry) => !entry.ok);
  const output = {
    ok: failed.length === 0,
    suite: "jcc-runtime-sensing-suite",
    test_count: results.length,
    failed_count: failed.length,
    mode_coverage: {
      cruise: ["mode_contract", "self_state_roi_contract", "self_state_roi_ocr", "mumu_runtime_watch", "leveling_economy_ev", "resource_policy_catalog"],
      augment_choice: ["mode_sensing_map", "user_reported_choice_contract", "choice_composer_prefill", "choice_fast_coach_gates", "owned_augment_text_panel_boundary"],
      descriptor_choice_modes: ["active_season_descriptor", "user_reported_choice_contract", "choice_composer_prefill", "choice_fast_coach_gates"],
      item_choice: ["mode_sensing_map", "user_reported_choice_contract", "choice_composer_prefill", "choice_fast_coach_gates", "mumu_equipment_source_priority"],
      refresh_self_state: ["mode_contract", "mode_sensing_map", "self_state_roi_ocr", "left_item_rail_product_source", "left_item_rail_roi_boundary", "fixed_equipped_roi_removed"],
      manual_match_variables: ["mode_contract"],
      opponent_board_modes: ["mode_contract", "mode_sensing_map", "mumu_s1_self_anchor", "obsolete_debug_tools_removed"],
    },
    product_boundary: "active choice candidates are current-match user reports; choice OCR/vision, opponent board unit sensing, opponent_power, and opponent_positioning are absent from the active product sensing suite",
    results,
  };
  console.log(JSON.stringify(output, null, 2));
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
