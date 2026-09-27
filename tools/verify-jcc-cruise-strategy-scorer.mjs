import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { scoreLiveState } from "./score-jcc-cruise-strategy.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

function byTrigger(tasks, triggerId) {
  return tasks.find((task) => task.trigger_id === triggerId);
}

function assertTaskShape(task) {
  assert(task.task_id, "advice task must have task_id");
  assert(task.trigger_id, "advice task must have trigger_id");
  assert(task.value_score >= 0.7, `advice task score too low: ${task.trigger_id}`);
  assert(task.short_advice && task.short_advice.length >= 12, `short advice missing: ${task.trigger_id}`);
  assert(Array.isArray(task.evidence) && task.evidence.length > 0, `evidence missing: ${task.trigger_id}`);
  assert(Array.isArray(task.actions) && task.actions.length > 0, `actions missing: ${task.trigger_id}`);
  assert(Array.isArray(task.semantic_labels), `semantic labels missing: ${task.trigger_id}`);
  assert(task.chain_of_thought === undefined, "advice task must not expose chain_of_thought");
}

async function main() {
  const scorerSource = await readFile(path.join(process.cwd(), "tools/score-jcc-cruise-strategy.mjs"), "utf8");
  assert(
    scorerSource.includes('lineup?.source_role === "national_master_plus_strength_anchor"')
      && scorerSource.includes("lineup?.metrics_authority === true"),
    "Cruise scoring must reject recipe-only lineup metrics",
  );
  const contract = JSON.parse(await readFile("data/runtime/jcc/cruise-strategy-scorer-contract.json", "utf8"));
  const uiMode = JSON.parse(await readFile("data/runtime/jcc/runtime-ui-mode-contract.json", "utf8"));
  assert(contract.schema === "jcc-cruise-strategy-scorer-contract-v1", "contract schema mismatch");
  assert(contract.input_contract?.hp_authority_policy?.includes("explicit elimination"), "scorer contract must not treat active HP zero as elimination by itself");
  assert(contract.binding_policy?.uses_semantics_as_labels_only === true, "scorer must use semantics as labels only");
  assert(contract.input_contract?.decision_source_order?.[0] === "current match live_state", "live_state must be first scorer source");
  for (const trigger of [
    "shop_hold_sell_interest",
    "streak_guard",
    "direction_commit_or_exit",
    "cap_gap_check",
  ]) {
    assert(contract.first_pass_triggers?.includes(trigger), `scorer contract trigger missing: ${trigger}`);
  }
  assert(contract.context_weighting?.target_plan?.accepted_fields?.includes("core_unit_ids"), "target plan core unit context missing");
  assert(contract.context_weighting?.hard_data_context?.preferred_source?.includes("active Core Profile"), "hard-data scorer source missing");
  assert(contract.context_weighting?.ranking_overlay_context?.preferred_source?.includes("captured by Start Match"), "Master+ Ranking Overlay scorer source missing");
  assert(contract.context_weighting?.combat_cap_estimator?.accepted_fields?.includes("board_power_score"), "combat/cap estimator contract missing");
  assert(contract.input_contract?.optional?.includes("lineup_lifecycle"), "lineup lifecycle scorer input missing");
  assert(contract.context_weighting?.lineup_lifecycle?.accepted_fields?.includes("discouraged_actions"), "lineup lifecycle conditional guardrail contract missing");
  assert(contract.context_weighting?.lineup_lifecycle?.accepted_fields?.includes("override_signals"), "lineup lifecycle override evidence contract missing");
  assert(uiMode.cruise_mode_policy?.strategy_scorer === "tools/score-jcc-cruise-strategy.mjs", "UI mode must point to scorer");

  const tmp = await mkdtemp(path.join(os.tmpdir(), "jcc-cruise-scorer-"));
  try {
    const activeState = {
      match_session_id: "match-test-scorer",
      phase: { stage_round: "3-2", status: 1 },
      economy: { gold: 19, hp: 54, level: 6, xp: "12/36" },
      board: {
        board_units: [
          { id: 11471, name: "Diana", star: 2 },
          { id: 11452, name: "Leona", star: 1 },
          { id: 11453, name: "Nasus", star: 1 }
        ]
      },
      bench: {
        bench_units: [
          { id: 11471, name: "Diana" },
          { id: 11471, name: "Diana" },
          { id: 11452, name: "Leona" },
          { id: 11460, name: "Illaoi" },
          { id: 11461, name: "Aurora" },
          { id: 11462, name: "Poppy" },
          { id: 11463, name: "Teemo" },
          { id: 11464, name: "Nasus" }
        ]
      },
      shop: {
        shop_units: [
          { id: 11471, name: "Diana" },
          { id: 11452, name: "Leona" },
          { id: 11452, name: "Leona" },
          { id: 11499, name: "Jinx" },
          { id: 11501, name: "Morgana" }
        ]
      },
      items: {
        item_bench: [
          { id: 1, name: "Recurve Bow" },
          { id: 2, name: "B. F. Sword" }
        ]
      },
      augments: {
        selected_augments: [{ name: "自我毁灭", observed_at: "2026-01-01T00:00:00.000Z" }],
        choice_candidates: [
          { name: "自我毁灭", at: "2026-01-01T00:00:00.000Z", confidence: 0.9 },
          { name: "一波带走俩", at: "2026-01-01T00:00:00.000Z", confidence: 0.9 },
          { name: "炽天使之拥", at: "2026-01-01T00:00:00.000Z", confidence: 0.9 },
          { name: "打捞桶+", at: "2026-01-01T00:00:10.000Z", confidence: 0.9 },
          { name: "新纪元+", at: "2026-01-01T00:00:10.000Z", confidence: 0.9 },
          { name: "物尽其用+", at: "2026-01-01T00:00:10.000Z", confidence: 0.9 }
        ].map((candidate) => ({ ...candidate, source: "current_match_user_report" }))
      },
      strategy: {
        streak_plan: {
          type: "lose_streak",
          active: true,
          desired: true,
          current_streak: 3
        }
      },
      visual: {
        augments: {
          choices: [
            { name: "???+", confidence: 0.91, source: "host_multimodal_visual_fixture" },
            { name: "???+", confidence: 0.9, source: "host_multimodal_visual_fixture" },
            { name: "????+", confidence: 0.9, source: "host_multimodal_visual_fixture" }
          ]
        }
      }
    };
    const quietState = {
      match_session_id: "match-test-quiet",
      phase: { stage_round: "2-2", status: 1 },
      economy: { gold: 13, hp: 96, level: 4 },
      board: { board_units: [{ id: 1, name: "Unit A" }, { id: 2, name: "Unit B" }] },
      bench: { bench_units: [{ id: 3, name: "Unit C" }] },
      shop: { shop_units: [] },
      items: { item_bench: [] },
    };
    const strategyContext = {
      target_plan: {
        id: "phantom-diana",
        name: "Phantom Diana",
        core_unit_ids: [11471],
        unit_ids: [11471, 11452, 11460, 11461],
        unit_names: ["Diana", "Leona", "Illaoi", "Aurora"],
        traits: ["Phantom", "Shepherd", "Judge"],
        plan_stage: "transition_to_target"
      },
      hard_data_context: {
        entity_strategy_weights: {
          "11471": {
            entity_kind: "champion",
            entity_name: "Diana",
            weights: { immediate_power: 22, cap_power: 34, tempo: 18, backline_damage: 42, pivot: 10 },
            primary_axes: ["backline_damage", "cap_power", "tempo"]
          },
          "11452": {
            entity_kind: "champion",
            entity_name: "Leona",
            weights: { frontline: 40, tempo: 20, control: 16 },
            primary_axes: ["frontline", "tempo"]
          }
        }
      },
      live_rankings_context: {
        source: "captured_tencent_master_plus_ranking_overlay",
        top_heroes: [
          { hero_id: "11471", signal_score: 1.18, top4_rate: 0.82, avg_rank: 2.9 },
          { hero_id: "11452", signal_score: 0.91, top4_rate: 0.75, avg_rank: 3.2 }
        ],
        top_lineups: [
          {
            id: "phantom-diana-meta",
            name: "Phantom Diana",
            signal_score: 1.04,
            top4_rate: 0.79,
            top1_rate: 0.24,
            avg_rank: 3.1,
            source_role: "national_master_plus_strength_anchor",
            metrics_authority: true,
          }
        ]
      },
      previous_advice_state: {
        now: "2026-01-01T00:00:05.000Z",
        emitted_tasks: [
          {
            trigger_id: "tempo_pivot",
            emitted_at: "2026-01-01T00:00:00.000Z"
          }
        ]
      },
      combat_cap_estimator: {
        board_power_score: 0.42,
        item_power_score: 0.31,
        cap_power_score: 0.48,
        survival_pressure_score: 0.81,
        expected_damage_risk: 0.68,
        estimator_policy: "fast_estimate_not_full_simulation"
      },
      user_context: {
        preference: "play_to_win",
        current_constraints: ["prefer Diana, but can pivot if contest is too high"]
      }
    };

    const activeFile = path.join(tmp, "active.json");
    const quietFile = path.join(tmp, "quiet.json");
    const earlyFile = path.join(tmp, "early.json");
    const contextFile = path.join(tmp, "context.json");
    await writeFile(activeFile, JSON.stringify(activeState, null, 2), "utf8");
    await writeFile(quietFile, JSON.stringify(quietState, null, 2), "utf8");
    await writeFile(earlyFile, JSON.stringify({
      match_session_id: "match-test-early-cruise",
      phase: { stage_round: "1-3", status: 1 },
      economy: { gold: null, hp: null, level: null, xp: null },
      board: { board_units: [{ id: 11453, name: "Nasus", star: 1 }] },
      bench: { bench_units: [{ id: 11463, name: "Teemo" }] },
      shop: { shop_units: [{ id: 11453, name: "Nasus" }, { id: 11460, name: "Illaoi" }] },
      items: { item_bench: [] },
    }, null, 2), "utf8");
    await writeFile(contextFile, JSON.stringify(strategyContext, null, 2), "utf8");

    const activeResult = await runNode(["tools/score-jcc-cruise-strategy.mjs", "--live-state", activeFile, "--include-suppressed"]);
    assert(activeResult.code === 0, `active scorer failed\n${activeResult.stdout}\n${activeResult.stderr}`);
    const active = JSON.parse(activeResult.stdout);
    assert(active.schema === "jcc-cruise-strategy-score-v1", "score schema mismatch");
    assert(active.match_session_id === "match-test-scorer", "match session id mismatch");
    assert(Array.isArray(active.advice_tasks) && active.advice_tasks.length >= 4, "active state should emit multiple advice tasks");
    for (const task of active.advice_tasks) assertTaskShape(task);
    assert(byTrigger(active.advice_tasks, "interest_breakpoint_decision"), "interest breakpoint advice missing");
    assert(byTrigger(active.advice_tasks, "shop_hold_sell_interest"), "shop hold/sell advice missing");
    assert(byTrigger(active.advice_tasks, "bench_space_pressure"), "bench space advice missing");
    assert(byTrigger(active.advice_tasks, "level_or_roll_timing"), "level/roll timing advice missing");
    assert(byTrigger(active.advice_tasks, "tempo_pivot"), "tempo pivot advice missing");
    assert(byTrigger(active.advice_tasks, "streak_guard"), "streak guard advice missing");
    assert(!byTrigger(active.advice_tasks, "contest_or_deny_units"), "contest/deny advice must not exist after opponent board removal");
    const augmentTask = byTrigger(active.advice_tasks, "augment_choice_advice");
    assert(augmentTask, "augment choice advice missing");
    assert(augmentTask.evidence.some((entry) => entry.type === "augments.ranked_recommendation"), "augment task must include ranked recommendation");
    assert(
      augmentTask.actions.some((action) =>
        action.startsWith("choose_augment:")
        || action.startsWith("prefer_augment:")
        || action === "reroll_all_augment_slots"
        || action.startsWith("full_reroll_current_set")),
      "augment task must choose, prefer, or explicitly reroll the current option set",
    );
    const choiceEvidence = augmentTask.evidence.find((entry) => entry.type === "augments.choice_candidates");
    assert(Array.isArray(choiceEvidence?.value) && choiceEvidence.value.length === 3, "augment advice should cite current host visual choice evidence");
    assert(!choiceEvidence.value.some((choice) => String(choice.name || "").includes("一波带走俩")), "augment evidence must not mix stale previous choice set");
    assert(!augmentTask.short_advice.includes("一波带走俩"), "augment advice must not mix stale previous choice set");
    assert(active.advice_tasks.some((task) => task.short_advice.includes("54") || task.short_advice.includes("19")), "advice must cite current evidence in visible text");

    const contextResult = await runNode(["tools/score-jcc-cruise-strategy.mjs", "--live-state", activeFile, "--context", contextFile, "--include-suppressed"]);
    assert(contextResult.code === 0, `context scorer failed\n${contextResult.stdout}\n${contextResult.stderr}`);
    const withContext = JSON.parse(contextResult.stdout);
    for (const task of withContext.advice_tasks) assertTaskShape(task);

    const contextInterest = byTrigger(withContext.advice_tasks, "interest_breakpoint_decision");
    assert(contextInterest, "context interest advice missing");
    assert(contextInterest.evidence.some((entry) => entry.type === "target_plan.hit_units"), "target plan hit evidence missing");
    assert(contextInterest.evidence.some((entry) => entry.type === "hard_data.entity_strategy_weights"), "hard-data weight evidence missing");
    assert(contextInterest.evidence.some((entry) => entry.type === "live_rankings.unit_signal"), "Master+ ranking unit signal evidence missing");
    assert(contextInterest.semantic_labels.includes("target_plan_alignment"), "target plan semantic label missing");

    const fourCostState = {
      match_session_id: "match-test-four-cost-lifecycle",
      phase: { stage_round: "3-5", status: 1 },
      economy: { gold: 42, hp: 61, level: 7, xp: { value: 0, to_next: 20 } },
      board: { board_units: [{ id: 1, name: "Frontline", star: 2 }] },
      bench: { bench_units: [] },
      shop: { shop_units: [] },
      items: { item_bench: [] },
    };
    const fourCost = scoreLiveState(fourCostState, {
      target_plan: { name: "Four-cost carry", primary_carry_cost: 4 },
      combat_cap_estimator: {
        economy_leveling: {
          status: "ready",
          actions: [
            { action: "roll_down_stabilize", gold_cost: 30, gold_after: 12, score: 0.95, confidence: "high" },
            { action: "hold_gold_interest", gold_cost: 0, gold_after: 42, score: 0.61, confidence: "medium" },
          ],
          leveling_math: {},
          live_economy: { xp: { display: "0/20" } },
        },
      },
    });
    const fourCostTiming = byTrigger(fourCost.advice_tasks, "level_or_roll_timing");
    assert(fourCostTiming, "four-cost lifecycle must still produce timing advice");
    assert(fourCostTiming.actions.includes("roll_down_stabilize"), "the scorer's original level-seven action must remain visible for Host reconciliation");
    assert(fourCostTiming.semantic_labels.includes("lifecycle_prior_conflict"), "a level-seven four-cost roll must expose its conflict with the normal level-eight prior");
    const timingActionEvidence = fourCostTiming.evidence.find((entry) => entry.type === "economy.leveling_ev.best_action");
    assert(timingActionEvidence?.value?.lifecycle_prior_conflict === true, "the timing evidence must preserve the conditional prior conflict instead of silently rewriting the action");
    assert(fourCostTiming.conditional_decision?.schema === "jcc-conditional-coach-decision-v1", "timing advice must carry the real lifecycle conditional decision");
    assert(fourCostTiming.semantic_labels.includes("conditional_coach_output"), "conditional advice must be explicitly labeled for Host rendering");
    assert(contextInterest.semantic_labels.includes("live_rankings_prior"), "Master+ ranking semantic label missing");
    assert(contextInterest.short_advice.includes("Phantom Diana") || contextInterest.short_advice.includes("Diana"), "context advice should mention target plan/core unit");
    assert(contextInterest.value_score >= byTrigger(active.advice_tasks, "interest_breakpoint_decision").value_score, "context should not lower high-value target-plan advice");

    const directionTask = byTrigger(withContext.advice_tasks, "direction_commit_or_exit");
    assert(directionTask, "target plan direction advice missing");
    assert(directionTask.evidence.some((entry) => entry.type === "target_plan.coverage"), "direction task must cite target plan coverage");
    assert(directionTask.evidence.some((entry) => entry.type === "live_rankings.lineup_signal"), "direction task must cite Master+ ranking lineup signal");

    const capGapTask = byTrigger(withContext.advice_tasks, "cap_gap_check");
    assert(capGapTask, "cap gap advice missing");
    assert(capGapTask.evidence.some((entry) => entry.type === "combat_cap_estimator.fast_estimate"), "cap gap must cite fast combat/cap estimate");
    assert(
      capGapTask.evidence.some((entry) => entry.type === "combat_cap_estimator.fast_estimate" && entry.value?.item_power_score === 0.31 && entry.value?.survival_pressure_score === 0.81),
      "cap gap estimate must preserve item and survival pressure inputs"
    );
    assert(capGapTask.evidence.some((entry) => entry.type === "target_plan.coverage"), "cap gap must cite target plan coverage");
    assert(capGapTask.semantic_labels.includes("capped_board"), "cap gap should carry capped_board label");

    assert(!byTrigger(withContext.advice_tasks, "contest_density_check"), "contest density advice must not exist after opponent board removal");

    const specialProbeTask = byTrigger(withContext.advice_tasks, "special_context_visual_probe");
    assert(specialProbeTask, "special context visual sensing probe missing for Judge target plan");
    assert(specialProbeTask.actions.includes("visual_sensing_probe:trait_effect:judge"), "Judge visual sensing probe action missing");

    assert(!byTrigger(withContext.advice_tasks, "tempo_pivot"), "recent tempo advice should be cooldown-suppressed");
    assert(
      withContext.suppressed_tasks.some((task) => task.trigger_id === "tempo_pivot" && task.suppression_reason === "cooldown_active"),
      "cooldown-suppressed tempo task missing from suppressed_tasks"
    );

    const quietResult = await runNode(["tools/score-jcc-cruise-strategy.mjs", "--live-state", quietFile]);
    assert(quietResult.code === 0, `quiet scorer failed\n${quietResult.stdout}\n${quietResult.stderr}`);
    const quiet = JSON.parse(quietResult.stdout);
    const quietLineupAgenda = byTrigger(quiet.advice_tasks, "lineup_convergence_checkpoint");
    assert(quietLineupAgenda, "a stage-2 state without a durable target must proactively open the candidate-direction agenda");
    assert(quietLineupAgenda.semantic_labels.includes("explore_candidates"), "the stage-2 agenda must explore candidates rather than remain silent");

    const earlyResult = await runNode(["tools/score-jcc-cruise-strategy.mjs", "--live-state", earlyFile]);
    assert(earlyResult.code === 0, `early scorer failed\n${earlyResult.stdout}\n${earlyResult.stderr}`);
    const early = JSON.parse(earlyResult.stdout);
    const earlyDirection = byTrigger(early.advice_tasks, "early_direction_conversation");
    assert(earlyDirection, "early direction conversation advice missing");
    assert(earlyDirection.actions.includes("ask_user_goal_if_unknown"), "early direction must ask for user goal if unknown");
    assert(earlyDirection.actions.includes("play_strongest_transition_until_direction_commits"), "early direction must keep flexible transition plan");
    assert(earlyDirection.actions.includes("visual_sensing_probe:economy"), "early direction must request economy refresh when missing");
    assert(earlyDirection.short_advice.includes("不要在海克斯前死锁阵容") || earlyDirection.short_advice.includes("海克斯"), "early advice must avoid hard-locking a comp before augment context");

    const futureMode = "future_relic_choice";
    const futureChoiceResult = scoreLiveState({
      match_session_id: "future-season-match",
      phase: { stage_round: "2-4", status: 1 },
      economy: { gold: 20, hp: 88, level: 5 },
      board: { board_units: [{ id: "future-unit", name: "Future Unit" }] },
      bench: { bench_units: [] },
      shop: { shop_units: [] },
      items: { item_bench: [{ name: "Recurve Bow" }] },
      choices: {
        by_mode: {
          [futureMode]: [
            { name: "Future Economy Relic", source: "current_match_user_report" },
            { name: "Future Combat Relic", source: "current_match_user_report" },
          ],
        },
      },
    }, {
      active_choice_mode_contracts: [{
        mode: futureMode,
        kind: "relic",
        phase: "relic_choice",
        label: "future relic choice",
        candidate_input_policy: "current_match_user_report",
        candidate_paths: [`match_context.reported_choice_sets_by_mode.${futureMode}.candidates`],
        advice_task_trigger_terms: ["future_relic_choice_advice"],
        visible_window_required_answer: "Choose one future relic now.",
      }],
      match_context: {
        reported_choice_sets_by_mode: {
          [futureMode]: {
            source: "current_match_user_report",
            match_session_id: "future-season-match",
            expected_candidate_count: 2,
            choices: [
              { name: "Future Economy Relic", source: "current_match_user_report" },
              { name: "Future Combat Relic", source: "current_match_user_report" },
            ],
          },
        },
      },
    });
    const futureChoiceTask = byTrigger(futureChoiceResult.advice_tasks, "future_relic_choice_advice");
    assert(futureChoiceTask, "a future major-season choice descriptor must create advice without common scorer changes");
    assert(futureChoiceTask.semantic_labels.includes(futureMode), "future-season choice task must preserve its descriptor mode");
    assert(!JSON.stringify(futureChoiceTask).includes("god_sequence"), "future-season choice task must not inherit an S17 mode");

    console.log(JSON.stringify({
      ok: true,
      checked: [
        "scorer contract",
        "UI scorer pointer",
        "active live_state emits evidence-backed advice_tasks",
        "target plan, hard data, and captured Master+ Ranking Overlay rerank advice",
        "shop hold/sell and streak guard first-pass scoring",
        "latest augment set scoring without stale candidate pollution",
        "special context visual sensing probe for target-plan-only information gaps",
        "early cruise direction conversation without fixed target plan",
        "future major-season choice descriptor produces generic scorer advice",
        "previous advice cooldown suppression",
        "cap gap first-pass scoring from survival pressure and own-state evidence",
        "stage-2 no-target state opens candidate-direction exploration",
        "no chain-of-thought field",
      ],
      active_triggers: active.advice_tasks.map((task) => task.trigger_id),
      context_triggers: withContext.advice_tasks.map((task) => task.trigger_id),
    }, null, 2));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
