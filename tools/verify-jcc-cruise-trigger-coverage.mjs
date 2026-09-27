import { readFile } from "node:fs/promises";

import {
  runtimeProactiveDecisionTriggerPolicySnapshot,
  runtimeSemanticEventAdmissionPolicySnapshot,
} from "../ui/electron/runtime-service.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ids(entries) {
  return new Set((entries || []).map((entry) => entry.id));
}

async function main() {
  const semantics = JSON.parse(await readFile("data/runtime/jcc/cruise-strategy-semantics-contract.json", "utf8"));
  const uiMode = JSON.parse(await readFile("data/runtime/jcc/runtime-ui-mode-contract.json", "utf8"));
  const scorer = JSON.parse(await readFile("data/runtime/jcc/cruise-strategy-scorer-contract.json", "utf8"));

  const archetypes = ids(semantics.strategy_archetypes);
  for (const required of [
    "fast_8",
    "slow_roll",
    "hyper_roll",
    "open_fort_lose_streak",
    "win_streak_tempo",
    "sit_on_gold_interest",
    "roll_down_stabilize",
    "pivot",
    "capped_board",
  ]) {
    assert(archetypes.has(required), `strategy archetype missing: ${required}`);
  }

  const operations = ids(semantics.operation_terms);
  for (const required of ["refresh", "sit_on_level", "level_up", "lock_shop", "sell_unit"]) {
    assert(operations.has(required), `operation term missing: ${required}`);
  }

  const semanticTriggers = ids(semantics.cruise_trigger_extensions);
  for (const required of [
    "interest_breakpoint_decision",
    "streak_guard",
    "level_or_roll_timing",
    "shop_lock_decision",
    "bench_space_pressure",
    "key_unit_progression",
    "item_slam_or_greed",
    "cap_gap_check",
  ]) {
    assert(semanticTriggers.has(required), `semantic trigger missing: ${required}`);
  }

  const uiTriggers = ids(uiMode.cruise_mode_policy?.proactive_advice_triggers);
  for (const required of ["direction_commit_or_exit", "lineup_convergence_checkpoint", "cap_gap_check"]) {
    assert(uiTriggers.has(required), `UI proactive trigger missing: ${required}`);
  }

  const scorerTriggers = new Set(scorer.first_pass_triggers || []);
  for (const required of [
    "interest_breakpoint_decision",
    "shop_hold_sell_interest",
    "key_unit_progression",
    "bench_space_pressure",
    "level_or_roll_timing",
    "tempo_pivot",
    "streak_guard",
    "shop_lock_decision",
    "item_slam_or_greed",
    "direction_commit_or_exit",
    "cap_gap_check",
    "early_direction_conversation",
  ]) {
    assert(scorerTriggers.has(required), `scorer trigger missing: ${required}`);
  }

  assert(scorer.context_weighting?.target_plan, "target plan context weighting missing");
  assert(scorer.context_weighting?.hard_data_context, "hard data context weighting missing");
  assert(scorer.context_weighting?.ranking_overlay_context, "Master+ Ranking Overlay context weighting missing");
  assert(scorer.context_weighting?.previous_advice_state?.accepted_fields?.includes("emitted_tasks"), "previous advice cooldown context missing");
  assert(scorer.context_weighting?.combat_cap_estimator?.default_builder === "tools/build-jcc-combat-cap-estimator-context.mjs", "combat/cap default builder missing");
  assert(scorer.context_weighting?.combat_cap_estimator?.accepted_fields?.includes("item_power_score"), "combat/cap item power field missing");
  assert(scorer.context_weighting?.combat_cap_estimator?.accepted_fields?.includes("survival_pressure_score"), "combat/cap survival pressure field missing");
  assert(semantics.binding_policy?.is_strategy_source === false, "semantics must remain non-strategy-source");

  const cooldowns = uiMode.cruise_mode_policy?.interrupt_policy?.cooldown_seconds_by_trigger || {};
  const cooldownResolution = uiMode.cruise_mode_policy?.interrupt_policy?.cooldown_resolution_policy || {};
  assert(cooldownResolution.never_stack_both === true, "trigger and semantic category cooldowns must not stack");
  assert(cooldownResolution.global_cadence_still_applies === true, "global proactive cadence must remain independent of trigger cooldown resolution");
  const runtimeTriggerPolicy = runtimeProactiveDecisionTriggerPolicySnapshot();
  for (const required of [
    "direction_commit_or_exit",
    "lineup_convergence_checkpoint",
    "cap_gap_check",
  ]) {
    assert(Number(cooldowns[required]) > 0, `UI cooldown missing for trigger: ${required}`);
    assert(runtimeTriggerPolicy[required], `runtime proactive admission missing for trigger: ${required}`);
    assert(runtimeTriggerPolicy[required].event_type, `runtime event type missing for trigger: ${required}`);
    assert(runtimeTriggerPolicy[required].category, `runtime event category missing for trigger: ${required}`);
    assert(
      runtimeTriggerPolicy[required].cooldown_ms === Number(cooldowns[required]) * 1000,
      `runtime cooldown drift for trigger: ${required}`,
    );
  }
  assert(
    JSON.stringify(Object.keys(runtimeTriggerPolicy).sort()) === JSON.stringify([...uiTriggers].sort()),
    "runtime proactive admission triggers must exactly match the UI product contract",
  );

  const semanticAdmissionEntries = uiMode.cruise_mode_policy?.interrupt_policy?.semantic_event_admission_policy || [];
  const semanticAdmissionByCategory = Object.fromEntries(
    semanticAdmissionEntries.map((entry) => [entry.category, entry]),
  );
  const runtimeSemanticAdmission = runtimeSemanticEventAdmissionPolicySnapshot();
  assert(
    JSON.stringify(Object.keys(runtimeSemanticAdmission).sort()) === JSON.stringify(Object.keys(semanticAdmissionByCategory).sort()),
    "runtime semantic event admission categories must exactly match the UI product contract",
  );
  for (const [category, contractPolicy] of Object.entries(semanticAdmissionByCategory)) {
    const runtimePolicy = runtimeSemanticAdmission[category];
    assert(runtimePolicy, `runtime semantic admission missing category: ${category}`);
    assert(runtimePolicy.cooldown_ms === Number(contractPolicy.cooldown_seconds || 0) * 1000, `semantic cooldown drift: ${category}`);
    assert(runtimePolicy.priority === Number(contractPolicy.priority || 0), `semantic priority drift: ${category}`);
    assert(runtimePolicy.opens_host_answer === (contractPolicy.opens_host_answer !== false), `semantic answer-lane policy drift: ${category}`);
    assert(
      JSON.stringify([...runtimePolicy.event_types].sort()) === JSON.stringify([...(contractPolicy.event_types || [])].sort()),
      `semantic event-type drift: ${category}`,
    );
  }
  for (const triggerPolicy of Object.values(runtimeTriggerPolicy)) {
    assert(runtimeSemanticAdmission[triggerPolicy.category], `proactive trigger category lacks semantic admission policy: ${triggerPolicy.category}`);
  }
  assert(!uiTriggers.has("item_slam_or_greed"), "ordinary equipment changes must not be a proactive Host trigger");
  assert(
    scorer.non_proactive_tasks?.special_context_visual_probe?.may_open_proactive_host_answer === false,
    "special context visual probe must remain evidence-only",
  );
  assert(
    scorer.non_proactive_tasks?.special_context_visual_probe?.answer_ownership === "context_evidence_only",
    "special context visual probe answer ownership must be explicit",
  );

  const refreshPolicy = uiMode.cruise_mode_policy?.interrupt_policy?.self_state_refresh_policy;
  assert(refreshPolicy?.default_enabled === true, "self state refresh policy must be enabled by default");
  for (const required of ["economy.gold", "economy.hp", "economy.level", "economy.xp"]) {
    assert(refreshPolicy.hud_refresh_fields?.includes(required), `HUD self state refresh field missing: ${required}`);
  }
  for (const required of ["items.item_bench", "items.equipped_items"]) {
    assert(refreshPolicy.structured_context_fields_read_without_visual_refresh?.includes(required), `structured self state context field missing: ${required}`);
  }

  console.log(JSON.stringify({
    ok: true,
    checked: {
      strategy_archetypes: [...archetypes],
      operation_terms: [...operations],
      semantic_triggers: [...semanticTriggers],
      ui_triggers: [...uiTriggers],
      scorer_first_pass_triggers: [...scorerTriggers],
      runtime_admission_triggers: Object.keys(runtimeTriggerPolicy),
      runtime_semantic_admission_categories: Object.keys(runtimeSemanticAdmission),
    },
    first_pass_scorer_notes: [
      "cap_gap_check uses a fast combat/cap estimator, not full combat simulation",
      "cap_gap_check uses survival pressure and own-state evidence, not opponent board snapshots",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
