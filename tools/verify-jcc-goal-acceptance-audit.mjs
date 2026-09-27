import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const REQUIREMENTS = [
  {
    id: "start_match_connects_then_cruises",
    label: "Start Match waits for real match evidence, then enters cruise and can proactively work from board/shop/state",
    productGateIds: [
      "new_match_session_isolation",
      "mumu_s1_self_anchor",
      "runtime_goal_regression",
      "cruise_trigger_coverage",
      "mumu_source_degraded_contract",
      "response_task_delivery",
    ],
    strictExternalIds: ["mumu_live"],
  },
  {
    id: "choice_stage_visual_triggers",
    label: "Cruise auto-triggers augment/god visual sensing for 2-1/3-2/4-2 and 2-4/3-4/4-4 without stale-stage pollution",
    productGateIds: [
      "runtime_goal_regression",
      "choice_confirmation_hooks",
      "runtime_ui_mode_contract",
    ],
  },
  {
    id: "own_board_units_available",
    label: "MuMu 4354 visible shop anchors self-view before 4353 promotes own board units and keeps opponent snapshots separate",
    productGateIds: ["mumu_s1_self_anchor"],
    strictExternalIds: ["mumu_live"],
  },
  {
    id: "host_coach_response_provenance",
    label: "Pending coach responses are completed by the current host CLI main model, not backend drafts",
    productGateIds: [
      "runtime_goal_regression",
      "host_adapter_stream_stub",
      "host_adapter_final_before_exit",
      "host_selected_context_contract",
      "host_response_json_decoder",
      "host_adapter_final_before_exit",
      "ui_host_failure_diagnostics",
    ],
  },
  {
    id: "opponent_board_sensing_removed",
    label: "Opponent board sensing is removed: runtime rejects opponent modes and never creates opponent board snapshots from current-view data",
    productGateIds: [
      "no_opponent_product_modes",
      "runtime_ui_mode_contract",
      "worker_orchestrator",
    ],
  },
  {
    id: "lineup_advice_updates_pinned_card",
    label: "Lineup and positioning answers use structured board output and update the pinned result card",
    productGateIds: [
      "runtime_goal_regression",
      "lineup_display_contract",
      "lineup_display_agent_bridge",
      "ui_runtime_bridge",
      "renderer_event_delivery",
    ],
  },
  {
    id: "hard_data_big_data_selected_context",
    label: "Strategy/lineup questions receive current-season catalog, user preferences, match variables, and readable big-data summaries",
    productGateIds: [
      "host_request_runtime_context",
      "electron_host_request_smoke",
      "host_selected_context_contract",
      "season_module_boundaries",
    ],
  },
  {
    id: "mode_skill_hook_loop_contract",
    label: "Runtime mode, skill, daemon, queue, and worker contracts are wired as product-level invariants",
    productGateIds: [
      "runtime_state_store",
      "runtime_daemon_server",
      "runtime_daemon_client",
      "product_gate_runtime_isolation",
      "runtime_ui_mode_contract",
      "worker_orchestrator",
      "open_design_runtime_maturity",
    ],
  },
  {
    id: "runtime_sensing_pipeline_reliable",
    label: "HUD and choice sensing use ADB-first capture, one resident OCR worker, bounded artifacts, and degraded MuMu source health without process accumulation",
    productGateIds: [
      "self_state_roi_capture_source",
      "mumu_runtime_autodiscovery",
      "mumu_source_degraded_contract",
      "rapidocr_resident_worker_lifecycle",
      "roi_subprocess_lifecycle",
      "runtime_sensing_artifact_retention",
    ],
    strictExternalIds: ["mumu_live"],
  },
  {
    id: "host_response_delivered_exactly_once",
    label: "Each user or semantic-event host response has one owner/revision, survives provider transport noise, and reaches the UI at most once",
    productGateIds: [
      "single_writer_canonical_transition",
      "response_task_delivery",
      "daemon_control_lane",
      "renderer_event_delivery",
      "coach_response_delivery_dedup",
      "host_response_json_decoder",
      "ui_host_failure_diagnostics",
    ],
  },
  {
    id: "live_rankings_preserve_last_known_good",
    label: "Live rankings publish only a passing staged candidate and preserve the last-known-good current snapshot on refresh failure",
    productGateIds: [
      "rankings_status_runtime_contract",
      "live_rankings_atomic_promotion",
      "live_rankings_sync_contract",
    ],
  },
  {
    id: "kimi_cli_optional_host",
    label: "Kimi CLI adapter is installed and can be accepted only after authenticated live generation passes",
    productGateIds: ["kimi_acp_adapter_stub"],
    strictExternalIds: ["kimi_live"],
    optional: true,
  },
];

function runNode(args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const terminateTree = async () => {
      if (child.exitCode !== null) return;
      if (process.platform === "win32" && child.pid) {
        await new Promise((done) => {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          const killerTimer = setTimeout(() => {
            try { killer.kill("SIGKILL"); } catch {}
            done();
          }, 2500);
          killer.once("error", () => { clearTimeout(killerTimer); done(); });
          killer.once("exit", () => { clearTimeout(killerTimer); done(); });
        });
      }
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
    };
    const timer = setTimeout(async () => {
      if (settled) return;
      timedOut = true;
      await terminateTree();
      finish({ code: 124, stdout, stderr: `${stderr}\nTimed out`.trim(), elapsed_ms: Date.now() - startedAt });
    }, Number(options.timeoutMs || 180000));
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (!timedOut) finish({ code: 1, stdout, stderr: error.message || String(error), elapsed_ms: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      if (!timedOut) finish({ code, stdout, stderr, elapsed_ms: Date.now() - startedAt });
    });
  });
}

function parseJsonTail(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("\n{");
    if (start >= 0) {
      try {
        return JSON.parse(text.slice(start + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function byId(results) {
  return new Map((Array.isArray(results) ? results : []).map((result) => [result.id, result]));
}

function statusForRequirement(requirement, productGateMap, strictExternal) {
  const productEvidence = requirement.productGateIds.map((id) => {
    const result = productGateMap.get(id);
    return {
      id,
      ok: result?.ok === true,
      covers: result?.covers || [],
    };
  });
  const missingProductEvidence = productEvidence.filter((evidence) => !evidence.ok).map((evidence) => evidence.id);
  const strictEvidence = (requirement.strictExternalIds || []).map((id) => strictExternal[id] || { id, ok: false, status: "not_run" });
  const missingStrictEvidence = strictEvidence.filter((evidence) => evidence.ok !== true).map((evidence) => evidence.id);

  if (missingProductEvidence.length) {
    return {
      status: "not_verified",
      missing_product_evidence: missingProductEvidence,
      product_evidence: productEvidence,
      strict_evidence: strictEvidence,
    };
  }

  if (missingStrictEvidence.length) {
    return {
      status: requirement.optional ? "optional_external_pending" : "external_acceptance_pending",
      missing_strict_evidence: missingStrictEvidence,
      product_evidence: productEvidence,
      strict_evidence: strictEvidence,
    };
  }

  return {
    status: "verified",
    product_evidence: productEvidence,
    strict_evidence: strictEvidence,
  };
}

async function main() {
  const strictMumu = !process.argv.includes("--skip-live-mumu");
  const strictKimi = !process.argv.includes("--skip-live-kimi");
  const durationIndex = process.argv.indexOf("--duration-ms");
  const durationMs = durationIndex >= 0 ? process.argv[durationIndex + 1] || "2500" : "2500";

  const productGateRun = await runNode(["tools/verify-jcc-runtime-product-gate.mjs"], { timeoutMs: 600000 });
  const productGate = parseJsonTail(productGateRun.stdout);
  const productGateMap = byId(productGate?.results);

  const strictExternal = {};
  if (strictMumu) {
    const mumuRun = await runNode(["tools/verify-jcc-live-acceptance-soak.mjs", "--require-live-mumu", "--duration-ms", durationMs], { timeoutMs: 120000 });
    const mumu = parseJsonTail(mumuRun.stdout);
    strictExternal.mumu_live = {
      id: "mumu_live",
      ok: mumuRun.code === 0 && mumu?.live_mumu?.live_mumu_accepted === true,
      status: mumu?.status || (mumuRun.code === 0 ? "pass" : "failed"),
      recommended_target: mumu?.live_mumu?.recommended_target || null,
      reason: mumu?.live_mumu?.reason || mumuRun.stderr.trim() || null,
    };
  } else {
    strictExternal.mumu_live = { id: "mumu_live", ok: false, status: "skipped" };
  }

  if (strictKimi) {
    const kimiRun = await runNode(["tools/verify-jcc-kimi-cli-live-availability.mjs", "--require-live"], { timeoutMs: 120000 });
    const kimi = parseJsonTail(kimiRun.stdout);
    strictExternal.kimi_live = {
      id: "kimi_live",
      ok: kimiRun.code === 0 && kimi?.live_generation_accepted === true,
      status: kimi?.status || (kimiRun.code === 0 ? "pass" : "failed"),
      command: kimi?.command || null,
      reason: kimi?.reason || kimiRun.stderr.trim() || null,
      next_step: kimi?.next_step || null,
    };
  } else {
    strictExternal.kimi_live = { id: "kimi_live", ok: false, status: "skipped" };
  }

  const requirements = REQUIREMENTS.map((requirement) => ({
    id: requirement.id,
    label: requirement.label,
    optional: requirement.optional === true,
    ...statusForRequirement(requirement, productGateMap, strictExternal),
  }));
  const required = requirements.filter((requirement) => !requirement.optional);
  const failed = required.filter((requirement) => requirement.status === "not_verified");
  const externalPending = required.filter((requirement) => requirement.status === "external_acceptance_pending");
  const verified = required.filter((requirement) => requirement.status === "verified");

  const report = {
    ok: productGateRun.code === 0 && failed.length === 0 && externalPending.length === 0,
    schema: "jcc-goal-acceptance-audit-v1",
    product_gate: {
      ok: productGateRun.code === 0 && productGate?.ok === true,
      checked_count: productGate?.checked_count || null,
      failed_count: productGate?.failed_count ?? null,
    },
    strict_external: strictExternal,
    summary: {
      required_total: required.length,
      required_verified: verified.length,
      required_not_verified: failed.length,
      required_external_pending: externalPending.length,
      optional_pending: requirements.filter((requirement) => requirement.optional && requirement.status !== "verified").length,
    },
    requirements,
    completion_policy: [
      "Do not mark the thread goal complete unless every non-optional requirement is verified.",
      "Kimi live generation is optional for the Codex-first runtime path, but cannot be claimed until authenticated strict live generation passes.",
      "MuMu live acceptance is required for real-game/replay acceptance because the goal includes runtime behavior against MuMu/ADB.",
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
