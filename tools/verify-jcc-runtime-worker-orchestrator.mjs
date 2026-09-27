import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildWorkerPlan as buildWorkerPlanImpl } from "./build-jcc-runtime-worker-plan.mjs";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

const contract = await readJson("data/runtime/jcc/runtime-worker-orchestrator-contract.json");
const repoRoot = path.resolve(import.meta.dirname, "..");
const activePaths = createRuntimePaths(repoRoot);
const activeRulesBundle = loadActiveRulesBundle({ repoRoot, runtimePaths: activePaths });
const currentRulesBundle = activeRulesBundle;
const seasonVersionSnapshot = createActiveCoreProfileSnapshot(repoRoot, {
  runtimePaths: activePaths,
});
const buildWorkerPlan = (options) => buildWorkerPlanImpl({
  seasonVersionSnapshot,
  expectedCoreProfileId: activePaths.activeCoreProfileId,
  ...options,
  ...(options.rulesBundle ? { testOnly: true } : {}),
});

assert(contract.schema === "jcc-runtime-worker-orchestrator-contract-v1", "orchestrator contract schema mismatch");
assert(contract.product_shape?.visible_voice === "host_cli_agent", "visible voice must be the host CLI agent");
assert(contract.product_shape?.backend_workers_may_not_speak_to_user === true, "backend workers must not speak to user");
assert(contract.hot_path_llm_policy?.per_small_event_llm_subagents === "forbidden", "hot path must forbid per-event LLM subagents");
assert(contract.hot_path_llm_policy?.host_model_final_response === "required_when_user_visible_advice_is_needed", "host model final response requirement missing");
assert(contract.hot_path_llm_policy?.optional_specialist_agents?.max_parallel_specialists <= 3, "specialist fan-out must stay bounded");
assert(contract.hot_path_llm_policy?.optional_specialist_agents?.must_default_to_inherit_host_cli_model === true, "specialists must inherit host CLI model by default");
assert(Array.isArray(contract.hot_path_llm_policy?.optional_specialist_agents?.event_allowlist), "specialists must use explicit event allowlist");
assert(Array.isArray(contract.hot_path_llm_policy?.optional_specialist_agents?.event_denylist), "specialists must use explicit event denylist");
assert(contract.merge_policy?.then_build === "host_agent_response_request", "orchestrator must build host response request");
assert(contract.merge_policy?.merge_specialist_packets_into === "orchestrator_context.specialist_packets", "specialist packets must merge into orchestrator context");

const requiredWorkers = [
  "mumu_bridge_ingest",
  "host_visual_sensing",
  "live_state_normalizer",
  "hard_data_lookup",
  "live_rankings_lookup",
  "economy_resource_scorer",
  "combat_cap_estimator",
  "memory_review_worker",
];
for (const worker of requiredWorkers) {
  assert(contract.worker_lanes?.[worker], `missing worker lane: ${worker}`);
  assert(!contract.worker_lanes[worker].must_not_write?.includes(undefined), `bad must_not_write for ${worker}`);
}

const requiredSpecialists = [
  "cruise_strategy_specialist",
  "postgame_review_specialist",
  "strategy_memory_specialist",
];
for (const lane of requiredSpecialists) {
  const specialist = contract.specialist_agent_lanes?.[lane];
  assert(specialist, `missing specialist lane: ${lane}`);
  assert(specialist.kind === "host_cli_native_subagent", `${lane} must be a host CLI native subagent lane`);
  assert(specialist.model_policy === "inherit_host_cli_default_unless_user_overrides", `${lane} must inherit host CLI model by default`);
  assert(specialist.must_not_write?.includes("final_user_visible_text"), `${lane} must not write final user text`);
  assert(Array.isArray(specialist.trigger_event_ids) && specialist.trigger_event_ids.length > 0, `${lane} must use explicit trigger_event_ids`);
  assert(["merge_if_ready_before_deadline", "await_for_explicit_deep_response"].includes(specialist.join_policy), `${lane} must declare a valid join_policy`);
  assert(Number(specialist.deadline_ms) > 0, `${lane} must declare deadline_ms`);
}

assert(!contract.worker_lanes?.opponent_scan_aggregator, "opponent scan aggregator must not be a product worker lane");
assert(!contract.specialist_agent_lanes?.lobby_scout_specialist, "lobby scout specialist must not be a product specialist lane");

const modes = ["cruise", "augment_choice", "item_choice", "refresh_self_state", "daily_chat", "strategy_wiki", "lineup_card"];
const plans = [];
for (const mode of modes) {
  const plan = await buildWorkerPlan({ mode, event: `${mode}_test`, matchSessionId: "jcc-test-match" });
  plans.push(plan);
  assert(plan.visible_voice === "host_cli_agent", `${mode} visible voice mismatch`);
  assert(plan.final_user_text_source === "host_cli_agent_main_model", `${mode} final response source mismatch`);
  assert(plan.response_policy.single_visible_coach_voice === true, `${mode} single coach voice missing`);
  assert(plan.response_policy.optional_specialist_agents_hot_path === "forbidden", `${mode} specialist hot path guard missing`);
  assert(plan.parallel_groups.some((group) => group.group_id === "orchestrator_merge"), `${mode} missing merge group`);
  assert(plan.parallel_groups.at(-1)?.group_id === "final_response", `${mode} final response must be last group`);
  assert(plan.parallel_groups.at(-1)?.workers?.[0]?.id === "host_cli_model_response", `${mode} missing host response worker`);
}

const cruiseSpecialistPlan = await buildWorkerPlan({ mode: "cruise", event: "tempo_pivot", matchSessionId: "jcc-test-match" });
const cruiseSpecialistGroup = cruiseSpecialistPlan.parallel_groups.find((group) => group.group_id === "optional_specialist_agents");
assert(cruiseSpecialistGroup?.optional === true, "cruise complex event should include optional specialist group");
assert(cruiseSpecialistGroup.can_run_in_parallel === true, "specialist group must be parallel");
assert(cruiseSpecialistGroup.workers.some((worker) => worker.id === "cruise_strategy_specialist"), "cruise complex event must include cruise strategy specialist");
assert(cruiseSpecialistGroup.output_contract?.final_user_text_forbidden === true, "specialist output must forbid final user text");
assert(cruiseSpecialistGroup.join_policy === "merge_if_ready_before_deadline", "cruise specialist must not block hot-path host response");
assert(!cruiseSpecialistPlan.parallel_groups.find((group) => group.group_id === "orchestrator_merge")?.depends_on?.includes("optional_specialist_agents"), "cruise merge must not await background specialist");
assert(cruiseSpecialistPlan.response_policy.optional_specialist_agents_background_parallel === true, "plan must expose background specialist use");

const augmentFastPlan = await buildWorkerPlan({ mode: "augment_choice", event: "augment_reroll_first_response", matchSessionId: "jcc-test-match" });
assert(!augmentFastPlan.parallel_groups.some((group) => group.group_id === "optional_specialist_agents"), "augment fast response must not spawn LLM specialists");

for (const forbidden of contract.hot_path_llm_policy.optional_specialist_agents.event_denylist) {
  const plan = await buildWorkerPlan({ mode: "cruise", event: forbidden, matchSessionId: "jcc-test-match" });
  assert(!plan.parallel_groups.some((group) => group.group_id === "optional_specialist_agents"), `forbidden event ${forbidden} must not spawn specialists`);
}

const substringPlan = await buildWorkerPlan({ mode: "cruise", event: "prefix_tempo_pivot_suffix", matchSessionId: "jcc-test-match" });
assert(!substringPlan.parallel_groups.some((group) => group.group_id === "optional_specialist_agents"), "specialist trigger must not use substring matching");

const augmentPlan = plans.find((plan) => plan.mode === "augment_choice");
const itemPlan = plans.find((plan) => plan.mode === "item_choice");
for (const plan of [augmentPlan, itemPlan]) {
  assert(
    !plan.parallel_groups.some((group) => group.workers?.some((worker) => worker.id === "host_visual_sensing")),
    `${plan.mode} current-match user-report intake must not start host visual sensing`,
  );
}
assert(currentRulesBundle.season_special_rules?.mechanics?.choice_mechanics?.length === 0, "active S18 rules must not require an S17 season-only choice worker plan");
assert(!currentRulesBundle.season_special_rules?.mechanics?.manual_variable_fields?.length, "active S18 rules must not require S17 manual-variable work");
const selfRefreshPlan = plans.find((plan) => plan.mode === "refresh_self_state");
assert(selfRefreshPlan.parallel_groups.some((group) => group.workers?.some((worker) => worker.id === "hud_text_sensing")), "self refresh must execute its declared HUD OCR worker");

const sourceSeasonChoice = {
  user_report_contract: {
    source: "current_match_user_report",
    no_ocr_or_vision_fallback: true,
  },
};
const futureMode = "future_relic_choice";
const futureRulesBundle = {
  ...currentRulesBundle,
  season_special_rules: {
    ...currentRulesBundle.season_special_rules,
    season_id: "s18-fixture",
    mechanics: {
      ...currentRulesBundle.season_special_rules.mechanics,
      choice_mechanics: [{
        ...sourceSeasonChoice,
        mechanic_id: "future_relic_choice",
        ui_mode_key: "relic",
        kind: "relic",
        mode: futureMode,
        phase: "relic_choice",
        label: "future relic choice",
        stages: ["2-4"],
        candidate_input_policy: "current_match_user_report",
        intent_tag: "future_relic_choice_intent",
        intent_terms: ["future relic"],
        candidate_paths: [`match_context.reported_choice_sets_by_mode.${futureMode}.candidates`],
        trigger_terms: ["future_relic"],
        advice_task_trigger_terms: ["future_relic_choice_advice"],
        host_context_choice_field: "future_relic_choices",
        missing_selection_prompt_template: "Report the selected future relic from {stage_round}.",
        visible_window_required_answer: "Rank the visible future relic options and choose one.",
        host_mode_context: {
          purpose: "Rank a future-season relic choice from the current user report.",
          response_expectation: "Rank each reported relic once and choose one.",
          allowed_sources: ["current_match_user_report"],
          allowed_writes: ["final_user_visible_text"],
          must_not_write: ["canonical_match_facts"],
        },
        user_report_contract: {
          ...sourceSeasonChoice.user_report_contract,
          report_prompt: "Report the visible future relic options.",
          refresh_report_prefix: "Refreshed options: ",
          no_ocr_or_vision_fallback: true,
        },
      }],
      choice_pretriggers: {},
    },
    host_mode_aliases: {},
  },
};
const futureChoicePlan = await buildWorkerPlan({
  mode: futureMode,
  event: "future_relic_choice_test",
  matchSessionId: "jcc-test-match",
  rulesBundle: futureRulesBundle,
});
assert(futureChoicePlan.mode_sensing_policy?.mode === futureMode, "future-season choice mode must compile without a common hardcoded branch");
assert(futureChoicePlan.mode_sensing_policy?.user_report_contract?.source === "current_match_user_report", "future-season choice mode must inherit user-report intake");
assert(!futureChoicePlan.parallel_groups.some((group) => group.workers?.some((worker) => worker.id === "host_visual_sensing")), "future-season user-report choice must not start host visual sensing");
assert(!contract.mode_worker_sets?.god_sequence, "common worker sets must not name an S17-only mode");
for (const removedMode of ["opponent_power", "opponent_positioning"]) {
  let failed = false;
  try {
    await buildWorkerPlan({ mode: removedMode, event: "removed_mode_test", matchSessionId: "jcc-test-match" });
  } catch {
    failed = true;
  }
  assert(failed, `${removedMode} must not build a product worker plan`);
}

console.log(JSON.stringify({
  ok: true,
  checked_modes: modes,
  checked_workers: requiredWorkers,
  checked_specialists: requiredSpecialists,
  checked_policy: "deterministic workers plus data-driven active-season choices plus optional structured specialist subagents plus one visible host coach",
}, null, 2));
