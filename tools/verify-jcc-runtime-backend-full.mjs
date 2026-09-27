import { spawn } from "node:child_process";
import path from "node:path";

const CHECKS = [
  {
    id: "runtime_product_gate",
    command: ["tools/verify-jcc-runtime-product-gate.mjs"],
    covers: ["independent_daemon", "sqlite_canonical_state", "http_sse_websocket", "thin_host_cli_adapter", "selected_context", "retention_budget"],
  },
  {
    id: "runtime_sensing_suite",
    command: ["tools/verify-jcc-runtime-sensing-suite.mjs"],
    covers: ["modes", "host_multimodal_visual_sensing", "mumu_watch", "legacy_visual_debug_not_mainline"],
  },
  {
    id: "mumu_desktop_watch",
    command: ["tools/verify-jcc-mumu-runtime-watch-logcat.mjs"],
    covers: ["mumu_bridge", "cruise_pipeline", "self_state_refresh_request"],
  },
  {
    id: "mumu_self_view_anchor",
    command: ["tools/verify-jcc-mumu-self-view-anchor-promotion.mjs"],
    covers: ["self_board_gate", "4352_4353_fold", "phase_gate"],
  },
  {
    id: "no_opponent_snapshot_isolation",
    command: ["tools/verify-jcc-mumu-opponent-snapshot-isolation.mjs"],
    covers: ["removed_opponent_snapshot", "own_board_pollution_guard", "s2_current_view_guard"],
  },
  {
    id: "cruise_pipeline",
    command: ["tools/verify-jcc-cruise-runtime-pipeline.mjs"],
    covers: ["watcher_to_estimator_to_scorer", "advice_lifecycle", "mode_switching"],
  },
  {
    id: "host_agent_context_pack",
    command: ["tools/verify-jcc-host-agent-context-pack.mjs"],
    covers: ["runtime_agent_skill", "session_boundaries", "lazy_mode_context", "node_json_policy"],
  },
  {
    id: "runtime_worker_orchestrator",
    command: ["tools/verify-jcc-runtime-worker-orchestrator.mjs"],
    covers: ["deterministic_workers", "optional_structured_specialist_subagents", "single_visible_coach_voice", "host_model_final_response"],
  },
  {
    id: "season_module_boundaries",
    command: ["tools/verify-jcc-season-module-boundaries.mjs"],
    covers: ["season_version_data", "runtime_invariant_layers", "descriptor_driven_season_switching"],
  },
  {
    id: "match_session_retention_budget",
    command: ["tools/verify-jcc-match-session-retention-budget.mjs"],
    covers: ["compact_match_artifacts", "no_raw_frame_retention", "postgame_summary_rotation"],
  },
  {
    id: "cruise_scorer",
    command: ["tools/verify-jcc-cruise-strategy-scorer.mjs"],
    covers: ["strategy_triggers", "augment_advice", "special_visual_probe", "cooldown"],
  },
  {
    id: "user_settings_memory_review",
    command: ["tools/verify-jcc-user-settings-review-runtime.mjs"],
    covers: ["settings", "custom_strategy_rows", "conflict_notice", "postgame_summaries"],
  },
  {
    id: "choice_hooks",
    command: ["tools/verify-jcc-choice-confirmation-hooks.mjs"],
    covers: ["augment_confirm", "descriptor_choice_sequence", "choice_followup", "cross_match_guard"],
  },
  {
    id: "combat_cap_estimator",
    command: ["tools/verify-jcc-combat-cap-estimator-context.mjs"],
    covers: ["hard_data_scoring", "live_rankings_prior", "opponent_pressure"],
  },
  {
    id: "hard_data",
    command: ["tools/verify-jcc-hard-data.mjs"],
    covers: ["normalized_entities", "typed_indexes", "strategy_weights"],
  },
  {
    id: "live_rankings",
    command: ["tools/verify-jcc-live-rankings.mjs"],
    covers: ["daily_big_data", "rank_signal_source"],
  },
  {
    id: "rank_signal_contract",
    command: ["tools/verify-jcc-runtime-rank-signal-contract.mjs"],
    covers: ["daily_big_data_runtime_context"],
  },
  {
    id: "lineup_display_contract",
    command: ["tools/verify-jcc-lineup-display-contract.mjs"],
    covers: ["internal_lineup_plan", "cli_text_board", "external_code_paths_disabled"],
  },
  {
    id: "lineup_display_agent_bridge",
    command: ["tools/verify-jcc-lineup-display-agent-bridge.mjs"],
    covers: ["lineup_plan_to_mechanical_board", "host_agent_request_context", "no_hand_drawn_board"],
  },
  {
    id: "lineup_card_response_contract",
    command: ["tools/verify-jcc-lineup-card-response-contract.mjs"],
    covers: ["lineup_card_requires_pinned_result", "prose_only_lineup_rejected", "degraded_fallback_is_explicit"],
  },
  {
    id: "live_context_authority_regression",
    command: ["tools/verify-jcc-live-context-authority-regression.mjs"],
    covers: ["hud_self_state_stage_authority", "target_comp_intent_context", "lineup_card_degraded_visibility", "economy_question_preset"],
  },
  {
    id: "host_coach_request_normalization",
    command: ["tools/verify-jcc-host-coach-request-normalization.mjs"],
    covers: ["missing_ai_native_policy_normalization", "legacy_host_request_merge", "pending_host_request_merge"],
  },
  {
    id: "response_task_delivery_contract",
    command: ["tools/verify-jcc-response-task-delivery-contract.mjs"],
    covers: ["response_task_ack", "canonical_delivery", "stop_and_late_result_guard"],
  },
  {
    id: "daemon_control_lane_contract",
    command: ["tools/verify-jcc-daemon-control-lane-contract.mjs"],
    covers: ["fast_control_lane", "stop_match_not_blocked_by_host", "mode_switch_not_blocked_by_host"],
  },
  {
    id: "single_writer_canonical_state_contract",
    command: ["tools/verify-jcc-single-writer-canonical-state-contract.mjs"],
    covers: ["canonical_writer_inventory", "service_writer_exception_guard", "single_writer_release_blocker"],
  },
  {
    id: "stage_context_authority",
    command: ["tools/verify-jcc-stage-context-authority.mjs"],
    covers: ["fresh_hud_stage_authority", "stale_game_state_brief_rebuild", "host_prompt_stage_consistency"],
  },
  {
    id: "live_test_symptom_regression",
    command: ["tools/verify-jcc-live-test-symptom-regression.mjs"],
    covers: ["manual_question_delivery", "background_task_not_visible_answer", "real_test_stale_state_symptoms"],
  },
  {
    id: "runtime_live_debug_contracts",
    command: ["tools/verify-jcc-runtime-live-debug-contracts.mjs"],
    covers: ["runtime_debug_events", "live_failure_diagnostics", "no_hidden_empty_response"],
  },
  {
    id: "debug_trace",
    command: ["tools/verify-jcc-cruise-debug-trace.mjs"],
    covers: ["no_screenshot_retention", "light_debug_trace"],
  },
  {
    id: "coverage_report",
    command: ["tools/verify-jcc-runtime-coverage-report.mjs"],
    covers: ["honest_gap_report"],
  },
  {
    id: "final_status_report",
    command: ["tools/verify-jcc-runtime-final-status-report.mjs"],
    covers: ["verified_partial_missing_fallback_buckets"],
  },
];

const CHECK_TIMEOUT_MS = Number(process.env.JCC_RUNTIME_BACKEND_FULL_CHECK_TIMEOUT_MS || 150000);

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => {});
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

function runNode(scriptArgs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, scriptArgs, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      stderr += `\nbackend full child timed out after ${CHECK_TIMEOUT_MS}ms: ${scriptArgs.join(" ")}`;
      terminateProcessTree(child);
      finish({
        code: 124,
        stdout,
        stderr,
        elapsed_ms: Date.now() - startedAt,
      });
    }, CHECK_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({
      code: 1,
      stdout,
      stderr: error.message || String(error),
      elapsed_ms: Date.now() - startedAt,
    }));
    child.on("close", (code) => finish({
      code,
      stdout,
      stderr,
      elapsed_ms: Date.now() - startedAt,
    }));
  });
}

function parseJsonTail(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("\n{");
    if (start >= 0) {
      try {
        return JSON.parse(trimmed.slice(start + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function main() {
  const results = [];
  for (const check of CHECKS) {
    const run = await runNode(check.command);
    const parsed = parseJsonTail(run.stdout);
    const ok = run.code === 0 && (parsed?.ok === true || parsed?.status === "pass");
    results.push({
      id: check.id,
      ok,
      exit_code: run.code,
      elapsed_ms: run.elapsed_ms,
      covers: check.covers,
      summary: parsed?.checked || parsed?.notes || parsed?.coverage || parsed?.final_status_counts || null,
      stdout_tail: run.stdout.trim().slice(-1200),
      stderr_tail: run.stderr.trim().slice(-1200),
    });
  }
  const failed = results.filter((result) => !result.ok);
  const report = {
    ok: failed.length === 0,
    schema: "jcc-runtime-backend-full-verification-v1",
    checked_count: results.length,
    failed_count: failed.length,
    coverage: {
      data_sources: ["mumu_bridge", "host_multimodal_visual", "manual_variables"],
      state: ["new_match_isolation", "self_view_anchor", "no_opponent_snapshot_isolation", "live_state_standardization"],
      strategy: ["estimator", "scorer", "advice_lifecycle", "agent_output_events"],
      orchestration: ["deterministic_workers", "optional_structured_specialist_subagents", "runtime_orchestrator", "single_visible_host_coach"],
      memory_review: ["settings", "strategy_rows", "conflict_notices", "postgame_summaries"],
      data_layers: ["season_module", "hard_data", "live_rankings", "mumu_catalog_overlay"],
      retention: ["redacted_pipeline_output", "bounded_lifecycle_arrays", "structured_postgame_summaries"],
    },
    known_boundaries: [
      "MuMu 4353 is an own-unit candidate only after S=1 plus a fresh non-empty 4354 shop anchor.",
      "S=2 is observing/non-self current view and must not update own board or create opponent board facts.",
      "MuMu/ADB discovery is user-triggered binding or re-scan, not a normal startup side effect.",
      "Final coach text comes from the host CLI agent model; backend drafts must not be presented as final advice.",
      "Multi-worker acceleration is deterministic backend orchestration plus optional structured specialist subagents, not multiple visible LLM coaches.",
      "Optional specialist subagents inherit the host CLI model by default, return structured packets only, and cannot write final user-visible advice.",
      "Major-season data must switch through version modules while runtime session and mode contracts stay reusable.",
      "Full live_state/raw frame retention is debug-only; product match sessions keep compact structured artifacts.",
      "Equipment and selected augment side rails are visual/icon candidates unless confirmed or disambiguated.",
      "External lineup code paths are disabled in the product hot path; runtime emits internal text boards instead.",
      "Host multimodal visual accuracy still needs per-scene live-screen acceptance tests for equipment rails, side augments, and unit-attached items.",
    ],
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
