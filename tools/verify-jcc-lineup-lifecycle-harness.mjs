import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildLineupLifecycleContext } from "./build-jcc-lineup-lifecycle-context.mjs";
import { buildLevelingEconomyContext } from "./build-jcc-leveling-economy-context.mjs";
import { buildStrategyTables } from "./build-jcc-strategy-tables.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const fixtureFile = path.resolve(
    import.meta.dirname,
    "..",
    "data",
    "runtime",
    "jcc",
    "fixtures",
    "coach-decision-benchmarks",
    "common-lineup-lifecycle-v1.json",
  );
  const fixture = JSON.parse((await readFile(fixtureFile, "utf8")).replace(/^\uFEFF/, ""));
  assert(fixture.season_neutral === true, "benchmark must remain season neutral");
  assert(fixture.cases.length >= 8, "benchmark must cover the common lineup lifecycle families");

  for (const scenario of fixture.cases) {
    const result = buildLineupLifecycleContext({
      liveState: scenario.live_state,
      context: scenario.context,
    });
    const expected = scenario.expect;
    assert(expected.correct_conclusion, `${scenario.id}: expert benchmark must define the correct conclusion`);
    assert(Array.isArray(expected.acceptable_alternatives), `${scenario.id}: expert benchmark must define acceptable alternatives`);
    assert(Array.isArray(expected.explicitly_wrong_actions) && expected.explicitly_wrong_actions.length, `${scenario.id}: expert benchmark must define explicitly wrong actions`);
    if (expected.archetype) assert(result.archetype === expected.archetype, `${scenario.id}: archetype mismatch`);
    if (expected.default_roll_level !== undefined) {
      assert(result.default_roll_level === expected.default_roll_level, `${scenario.id}: default roll level mismatch`);
    }
    if (expected.xp_alignment) assert(result.xp_alignment?.decision === expected.xp_alignment, `${scenario.id}: XP alignment mismatch`);
    for (const action of expected.preferred_actions || []) {
      assert(result.preferred_actions.includes(action), `${scenario.id}: missing preferred action ${action}`);
    }
    for (const action of expected.discouraged_actions || expected.forbidden_actions || []) {
      assert(result.discouraged_actions.includes(action), `${scenario.id}: missing discouraged action ${action}`);
    }
    for (const action of expected.explicitly_wrong_actions) {
      assert(result.discouraged_actions.includes(action), `${scenario.id}: scenario-specific wrong action is not discouraged ${action}`);
    }
    for (const action of expected.conditional_actions || []) {
      assert(result.conditional_actions.includes(action), `${scenario.id}: missing conditional action ${action}`);
    }
    for (const signal of expected.override_signals || []) {
      assert(result.override_signals.includes(signal), `${scenario.id}: missing override signal ${signal}`);
    }
    for (const action of expected.absent_preferred_actions || []) {
      assert(!result.preferred_actions.includes(action), `${scenario.id}: contradictory preferred action ${action}`);
    }
    for (const action of expected.absent_discouraged_actions || []) {
      assert(!result.discouraged_actions.includes(action), `${scenario.id}: contradictory discouraged action ${action}`);
    }
    assert(result.forbidden_actions.length === 0, `${scenario.id}: general lifecycle priors must not create global forbidden actions`);
    assert(Number.isFinite(result.board_readiness?.roll_marginal_gain_score), `${scenario.id}: roll marginal gain estimate missing`);
    for (const field of [
      "population_gain_score",
      "equipment_closure_score",
      "core_two_star_coverage_score",
      "immediate_upgrade_gain_score",
      "fault_tolerance_score",
    ]) {
      assert(Number.isFinite(result.board_readiness?.[field]), `${scenario.id}: ${field} missing`);
      assert(result.board_readiness[field] >= 0 && result.board_readiness[field] <= 1, `${scenario.id}: ${field} out of range`);
    }
    assert(Number.isInteger(result.board_readiness?.core_two_star_count), `${scenario.id}: core_two_star_count missing`);
    assert("main_carry_ready" in result.board_readiness, `${scenario.id}: main_carry_ready missing`);
    assert("main_tank_ready" in result.board_readiness, `${scenario.id}: main_tank_ready missing`);
    assert(!("opponent_board" in result.board_readiness), `${scenario.id}: opponent board sensing must stay absent`);
    assert(["high", "medium", "low"].includes(result.board_readiness?.readiness_confidence), `${scenario.id}: readiness confidence missing`);
    assert(typeof result.board_readiness?.decision_gap === "string", `${scenario.id}: board decision gap missing`);
    assert(["high", "medium", "low", "unknown"].includes(result.board_readiness?.next_level_value), `${scenario.id}: next-level value missing`);
    assert(result.conditional_decision?.schema === "jcc-conditional-coach-decision-v1", `${scenario.id}: conditional coach decision missing`);
    assert(result.conditional_decision?.default_line, `${scenario.id}: conditional coach default line missing`);
    assert(result.preferred_actions.includes(result.conditional_decision.immediate_action), `${scenario.id}: conditional immediate action must come from the preferred action set`);
    assert(result.conditional_decision?.if_signals.length <= 2, `${scenario.id}: conditional coach branch budget exceeded`);
    assert(result.conditional_decision?.exit_signals.length <= 2, `${scenario.id}: conditional coach exit budget exceeded`);
    for (const signal of result.conditional_decision.if_signals) {
      const supported = (
        signal.includes("next_level") && result.override_signals.includes("next_level_material_board_spike")
      ) || (
        signal.includes("pairs_or_core_copies") && result.override_signals.includes("high_immediate_roll_marginal_gain")
      ) || (
        signal.includes("contest") && result.override_signals.includes("contested_pool_or_timing_race")
      );
      assert(supported, `${scenario.id}: conditional branch lacks matching override evidence: ${signal}`);
    }
    for (const signal of result.conditional_decision.exit_signals) {
      const supported = (
        signal.includes("loss_buffer") && result.board_readiness.loss_buffer_rounds !== null && result.board_readiness.loss_buffer_rounds <= 1
      ) || (
        signal.includes("items_do_not_complete") && result.board_readiness.item_completion_score < 0.2
      ) || (
        signal.includes("target_overlap") && result.board_readiness.target_coverage_score < 0.25
      );
      assert(supported, `${scenario.id}: conditional exit lacks matching board evidence: ${signal}`);
    }
    assert(result.host_policy?.active_season_mechanics_source === "compiled_active_season_descriptor_only", `${scenario.id}: lifecycle must defer special mechanics to active descriptor`);

    const economy = buildLevelingEconomyContext({
      liveState: scenario.live_state,
      context: scenario.context,
      tables: buildStrategyTables(),
    });
    assert(economy.lineup_lifecycle?.archetype === result.archetype, `${scenario.id}: economy context must carry lifecycle identity`);
    if (result.archetype === "four_cost_carry" && scenario.live_state.economy.level === 7) {
      const survivalOverride = result.override_signals.some((signal) => [
        "lethal_or_single_loss_buffer",
        "high_immediate_roll_marginal_gain",
        "board_below_stabilization_floor",
      ].includes(signal));
      const maximumBudget = survivalOverride ? 12 : 6;
      assert(
        !(economy.actions || []).some((action) => action.action === "roll_down_stabilize" && Number(action.roll_budget || 0) > maximumBudget),
        `${scenario.id}: level-seven four-cost line exceeded its evidence-bounded repair budget`,
      );
    }
  }

  const missingStageHighCost = buildLineupLifecycleContext({
    liveState: {
      economy: { level: 7, gold: 50, hp: 80 },
      board: { board_units: [{ name: "EarlyFiveCost", cost: 5, star: 1 }] },
      bench: { bench_units: [] },
      items: { equipped_items: [] },
    },
    context: {},
  });
  assert(missingStageHighCost.archetype !== "early_high_cost_pivot", "missing stage must not masquerade as an early high-cost pivot window");

  const sparseBoard = buildLineupLifecycleContext({
    liveState: {
      phase: { stage_round: "2-3" },
      economy: { level: 5, gold: 30, hp: 92 },
      board: { board_units: [{ name: "Frontline", cost: 1, star: 1, role: "tank" }] },
      bench: { bench_units: [] },
      items: { equipped_items: [] },
    },
    context: {},
  });
  assert(sparseBoard.board_readiness.next_level_value !== "high", "empty population slots alone must not fabricate a high-value level-up spike");
  assert(sparseBoard.board_readiness.decision_gap !== "immediate_upgrade_gap", "low-confidence missing copy evidence must not fabricate an immediate roll gap");

  const formationProfile = {
    schema: "jcc-lineup-formation-profile-v1",
    burden_band: "high",
    estimated_burden_score: 0.72,
    target_population: 8,
    target_units: [
      { champion_id: "a", champion_name: "Carry", cost: 4 },
      { champion_id: "b", champion_name: "Tank", cost: 4 },
    ],
    unknowns: ["star_item_augment_emblem_and_special_mechanic_requirements_not_explicitly_declared"],
  };
  const formationContext = buildLineupLifecycleContext({
    liveState: {
      phase: { stage_round: "4-2" },
      economy: { level: 7, gold: 24, hp: 68 },
      board: { board_units: [{ name: "Carry", cost: 4, star: 2 }] },
      bench: { bench_units: [] },
      items: { equipped_items: [] },
    },
    context: { target_plan: { formation_profile: formationProfile } },
  });
  assert(formationContext.formation_profile === formationProfile, "formation profile must remain attached to the target lifecycle");
  assert(formationContext.formation_readiness?.schema === "jcc-current-formation-readiness-v1", "current formation readiness missing");
  assert(formationContext.formation_readiness?.burden_band === "high", "formation burden must remain visible beside readiness");
  assert(formationContext.formation_readiness?.acquired_target_unit_count === 1, "formation readiness must count observed target units");
  assert(formationContext.formation_readiness?.policy?.does_not_change_national_strength === true, "formation readiness must not alter national strength");

  console.log(JSON.stringify({
    ok: true,
    checked: [...fixture.cases.map((scenario) => scenario.id), "missing_stage_high_cost", "sparse_board_no_fake_level_spike"],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
