import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import {
  loadActiveRulesBundle,
  runtimeChoiceModeContract,
} from "./jcc_active_rules_contract.mjs";
import { resolveMatchCoreProfileRuntimePaths } from "./build-jcc-host-agent-context-pack.mjs";

const ORCHESTRATOR_CONTRACT = "data/runtime/jcc/runtime-worker-orchestrator-contract.json";
const MODE_SENSING_MAP = "data/runtime/jcc/runtime-mode-sensing-map.json";

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-runtime-worker-plan.mjs --mode <mode_id> [--event <event_id>] [--match-session-id <id>] [--season-snapshot-base64url <value>] [--expected-core-profile-id <sha256>] [--out <file>]",
    "",
    "Builds a deterministic worker plan. It does not run workers and does not call an LLM.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { mode: "cruise", event: "mode_tick" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--event") options.event = argv[++index];
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else if (arg === "--season-snapshot-base64url") options.seasonVersionSnapshot = argv[++index];
    else if (arg === "--expected-core-profile-id") options.expectedCoreProfileId = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse((await readFile(path.resolve(file), "utf8")).replace(/^\uFEFF/, ""));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function classifySensingWorker(workerId) {
  return [
    "mumu_bridge_ingest",
    "host_visual_sensing",
    "hud_text_sensing",
    "live_state_normalizer",
  ].includes(workerId);
}

function classifyScoringWorker(workerId) {
  return [
    "hard_data_lookup",
    "live_rankings_lookup",
    "economy_resource_scorer",
    "combat_cap_estimator",
    "memory_review_worker",
  ].includes(workerId);
}

function workerSummary(contract, workerId) {
  const lane = contract.worker_lanes?.[workerId];
  if (!lane) throw new Error(`Unknown worker lane in contract: ${workerId}`);
  return {
    id: workerId,
    kind: lane.kind,
    hot_path: lane.hot_path,
    latency_budget_ms: lane.latency_budget_ms,
    inputs: lane.inputs || [],
    outputs: lane.outputs || [],
    must_not_write: lane.must_not_write || [],
  };
}

function allowedSpecialistLanes(contract, mode, event) {
  const eventId = String(event || "");
  const policy = contract.hot_path_llm_policy?.optional_specialist_agents || {};
  const denylist = new Set(policy.event_denylist || []);
  const allowlist = new Set(policy.event_allowlist || []);
  if (denylist.has(eventId) || !allowlist.has(eventId)) return [];
  const lanes = Object.entries(contract.specialist_agent_lanes || {})
    .filter(([, lane]) => (lane.allowed_modes || []).includes(mode))
    .filter(([, lane]) => {
      const triggers = lane.trigger_event_ids || [];
      return triggers.includes(eventId);
    })
    .map(([id, lane]) => ({
      id,
      kind: lane.kind,
      default_agent_type: lane.default_agent_type,
      model_policy: lane.model_policy,
      latency_class: lane.latency_class,
      join_policy: lane.join_policy,
      deadline_ms: lane.deadline_ms,
      fallback_behavior: lane.fallback_behavior,
      inputs: lane.inputs || [],
      outputs: lane.outputs || [],
      must_not_write: lane.must_not_write || [],
      dispatch_policy: "optional_background_parallel_structured_packet",
    }));
  const maxParallel = contract.hot_path_llm_policy?.optional_specialist_agents?.max_parallel_specialists || 3;
  return lanes.slice(0, maxParallel);
}

function selectedRuntimePaths(options) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(import.meta.dirname, ".."));
  const activePaths = options.runtimePaths || createRuntimePaths(repoRoot);
  if (options.testOnly === true) return activePaths;
  if (!options.matchSessionId) return activePaths;
  if (!options.seasonVersionSnapshot || !options.expectedCoreProfileId) {
    throw new Error("match worker plan requires --season-snapshot-base64url and --expected-core-profile-id");
  }
  return resolveMatchCoreProfileRuntimePaths({
    repoRoot,
    baseRuntimePaths: activePaths,
    seasonVersionSnapshot: options.seasonVersionSnapshot,
    expectedCoreProfileId: options.expectedCoreProfileId,
  });
}

function activeRulesBundle(options, runtimePaths) {
  if (options.rulesBundle && options.testOnly === true) return options.rulesBundle;
  return loadActiveRulesBundle({ repoRoot: path.resolve(options.repoRoot || path.resolve(import.meta.dirname, "..")), runtimePaths });
}

function activeChoiceModeSensingPolicy(choiceContract) {
  const reportContract = choiceContract?.user_report_contract || {};
  return {
    source: "compiled_active_rules_choice_mode_contract",
    mode: choiceContract.mode,
    kind: choiceContract.kind,
    phase: choiceContract.phase,
    stages: choiceContract.stages || [],
    candidate_input_policy: choiceContract.candidate_input_policy,
    user_report_contract: choiceContract.candidate_input_policy === "current_match_user_report"
      ? {
          enabled: true,
          source: "current_match_user_report",
          target: choiceContract.candidate_paths?.[0] || null,
          role: "current_match_user_report_only",
          report_prompt: reportContract.report_prompt || null,
          refresh_report_prefix: reportContract.refresh_report_prefix || null,
          no_ocr_or_vision_fallback: reportContract.no_ocr_or_vision_fallback === true,
          fallback: "none",
        }
      : null,
    writes: ["choices.pending_confirmation", "advice_task"],
    must_not_write: choiceContract.host_mode_context?.must_not_write || [],
  };
}

async function buildWorkerPlan(options) {
  const [contract, sensingMap] = await Promise.all([
    options.orchestratorContract || readJson(ORCHESTRATOR_CONTRACT),
    options.sensingMap || readJson(MODE_SENSING_MAP),
  ]);
  const selectedPaths = selectedRuntimePaths(options);
  const rulesBundle = activeRulesBundle(options, selectedPaths);
  const choiceContract = runtimeChoiceModeContract(options.mode, rulesBundle);
  const modeWorkers = contract.mode_worker_sets?.[options.mode]
    || (choiceContract ? contract.active_season_choice_mode_worker_set : null);
  if (!modeWorkers) throw new Error(`Unknown mode for worker plan: ${options.mode}`);

  const sensingWorkers = unique(modeWorkers.filter(classifySensingWorker));
  const scoringWorkers = unique(modeWorkers.filter(classifyScoringWorker));
  const groups = [];
  if (sensingWorkers.length) {
    groups.push({
      group_id: "sensing",
      can_run_in_parallel: true,
      depends_on: [],
      workers: sensingWorkers.map((worker) => workerSummary(contract, worker)),
    });
  }
  if (scoringWorkers.length) {
    groups.push({
      group_id: "scoring",
      can_run_in_parallel: true,
      depends_on: sensingWorkers.length ? ["sensing"] : [],
      workers: scoringWorkers.map((worker) => workerSummary(contract, worker)),
    });
  }
  const specialistLanes = allowedSpecialistLanes(contract, options.mode, options.event);
  if (specialistLanes.length) {
    groups.push({
      group_id: "optional_specialist_agents",
      can_run_in_parallel: true,
      optional: true,
      depends_on: [sensingWorkers.length ? "sensing" : null, scoringWorkers.length ? "scoring" : null].filter(Boolean),
      workers: specialistLanes,
      join_policy: specialistLanes.some((lane) => lane.join_policy === "await_for_explicit_deep_response")
        ? "await_for_explicit_deep_response"
        : "merge_if_ready_before_deadline",
      deadline_ms: Math.max(...specialistLanes.map((lane) => Number(lane.deadline_ms) || 0)),
      output_contract: {
        packet_schema: "jcc-runtime-specialist-analysis-packet-v1",
        final_user_text_forbidden: true,
        merge_target: "orchestrator_context.specialist_packets",
      },
    });
  }
  groups.push({
    group_id: "orchestrator_merge",
    can_run_in_parallel: false,
    depends_on: [
      sensingWorkers.length ? "sensing" : null,
      scoringWorkers.length ? "scoring" : null,
      specialistLanes.some((lane) => lane.join_policy === "await_for_explicit_deep_response") ? "optional_specialist_agents" : null,
    ].filter(Boolean),
    workers: [
      {
        id: "runtime_orchestrator_merge",
        kind: "deterministic_merge",
        outputs: ["orchestrator_context", "host_agent_response_request"],
        must_not_write: ["final_user_visible_text"],
      },
    ],
  });
  groups.push({
    group_id: "final_response",
    can_run_in_parallel: false,
    depends_on: ["orchestrator_merge"],
    workers: [
      {
        id: "host_cli_model_response",
        kind: "host_cli_agent_main_model",
        outputs: ["final_advice_response"],
        must_not_write: ["raw_screenshot_retention", "current_match_live_state"],
      },
    ],
  });

  return {
    schema: "jcc-runtime-worker-plan-v1",
    generated_at: new Date().toISOString(),
    mode: options.mode,
    event: options.event,
    match_session_id: options.matchSessionId || null,
    core_profile_id: selectedPaths.activeCoreProfileId || null,
    core_profile_artifacts: options.matchSessionId
      ? {
          bundle: selectedPaths.activeCoreProfileBundleFile,
          decision_input_catalog: selectedPaths.activeDecisionInputCatalogFile,
          runtime_catalog_overlay: selectedPaths.activeRuntimeCatalogOverlayFile,
          semantic_feature_index: selectedPaths.activeSemanticFeatureIndexFile,
          hard_data_manifest: selectedPaths.activeHardDataManifest,
        }
      : null,
    visible_voice: contract.product_shape.visible_voice,
    final_user_text_source: contract.product_shape.final_user_text_source,
    mode_sensing_policy: sensingMap.modes?.[options.mode]
      || (choiceContract ? activeChoiceModeSensingPolicy(choiceContract) : null),
    parallel_groups: groups,
    response_policy: {
      single_visible_coach_voice: true,
      backend_drafts_not_final: true,
      host_model_final_response_required: true,
      optional_specialist_agents_hot_path: "forbidden",
      optional_specialist_agents_background_parallel: specialistLanes.length > 0,
      optional_specialist_agents_final_text_forbidden: true,
    },
    source_contracts: {
      orchestrator: ORCHESTRATOR_CONTRACT,
      sensing_map: MODE_SENSING_MAP,
      active_rules: rulesBundle.source_files || null,
      core_profile_id: selectedPaths.activeCoreProfileId || null,
      core_profile_artifacts: options.matchSessionId
        ? {
            bundle: selectedPaths.activeCoreProfileBundleFile,
            decision_input_catalog: selectedPaths.activeDecisionInputCatalogFile,
            runtime_catalog_overlay: selectedPaths.activeRuntimeCatalogOverlayFile,
            semantic_feature_index: selectedPaths.activeSemanticFeatureIndexFile,
            hard_data_manifest: selectedPaths.activeHardDataManifest,
          }
        : null,
    },
  };
}

async function writePlan(plan, outFile) {
  const resolved = path.resolve(outFile);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return resolved;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const plan = await buildWorkerPlan(options);
  if (options.out) {
    const out = await writePlan(plan, options.out);
    console.log(JSON.stringify({ ok: true, out, mode: plan.mode, event: plan.event }, null, 2));
  } else {
    console.log(JSON.stringify(plan, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export { activeChoiceModeSensingPolicy, buildWorkerPlan, writePlan };
