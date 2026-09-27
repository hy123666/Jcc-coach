import { EVALUATORS, evaluateFormula } from "./jcc-formula-evaluator.mjs";

function check(condition, message, details = undefined) {
  if (!condition) throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
}

function close(actual, expected, tolerance = 1e-9) {
  return Math.abs(actual - expected) <= tolerance;
}

const TEST_VERSION_PARAMETERS = {
  identity: { season_id: "test-season", patch_id: "test-patch" },
  formulas: {
    shop_odds: { tables: { odds_by_level: [{ level: 8, cost1: 15, cost2: 20, cost3: 32, cost4: 30, cost5: 3 }] } },
    shop_specific_unit_odds: { tables: { odds_by_level: [{ level: 8, cost1: 15, cost2: 20, cost3: 32, cost4: 30, cost5: 3 }] } },
  },
};

const cases = [
  async () => {
    const result = await evaluateFormula("damage", {
      damage_type: "physical", base_damage: 100, damage_amp_pct: 15,
      flat_penetration: 0, percent_penetration: 30, critical_chance: 80, critical_damage_multiplier: 140,
      armor: 100, magic_resist: 100, durability_pct: 10, shield: 0, health: 3000,
    });
    check(close(result.output.non_crit_damage, 60.88235294117647), "physical damage non-crit mismatch", result.output);
    check(close(result.output.crit_damage, 85.23529411764706), "physical damage crit mismatch", result.output);
    check(close(result.output.expected_damage, 80.36470588235295), "physical expected damage mismatch", result.output);
    check(result.output.hits_to_kill === 38, "physical hits-to-kill mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("damage", {
      damage_type: "true", base_damage: 100, bonus_damage_pct: 15,
      crit_chance: 80, crit_multiplier: 140, durability_pct: 10,
      armor: 100, magic_resist: 100, shield: 0, health: 3000,
    });
    check(close(result.output.non_crit_damage, 103.5), "true damage must still apply durability", result.output);
    check(close(result.output.crit_damage, 144.9), "true damage crit mismatch", result.output);
    check(close(result.output.expected_damage, 136.62), "true expected damage mismatch", result.output);
    check(result.output.hits_to_kill === 22, "true damage hits-to-kill mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("pvp_player_damage", { stage: 5, surviving_enemy_units: 3 });
    check(result.output.stage_base_damage === 10, "stage 5 base player damage mismatch", result.output);
    check(result.output.total_player_damage === 13, "stage 5 total player damage mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("damage", {
      damage_type: "physical",
      base_damage: 100,
      bonus_damage_pct: 20,
      flat_pen: 0,
      pct_pen: 0,
      crit_chance: 25,
      crit_multiplier: 140,
      armor: 50,
      durability_pct: 0,
      health: 500,
    });
    check(result.executable, "damage must be executable");
    check(close(result.output.raw_damage, 120), "damage raw_damage mismatch", result.output);
    check(close(result.output.expected_damage, 88), "damage expected_damage mismatch", result.output);
    check(result.output.hits_to_kill === 6, "damage hits_to_kill mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("ehp", { hp: 1000, armor: 50, magic_resist: 100, damage_mix: { physical_share: 0.5, magic_share: 0.5, true_share: 0 } });
    check(close(result.output.physical_ehp, 1500), "ehp physical mismatch", result.output);
    check(close(result.output.magic_ehp, 2000), "ehp magic mismatch", result.output);
    check(close(result.output.mixed_ehp, 1714.2857142857142), "ehp mixed mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("interest_break", { gold_before_action: 50, gold_after_action: 39 });
    check(result.output.interest_before === 5 && result.output.interest_after === 3 && result.output.interest_lost === 2, "interest break mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("resist_mitigation", { incoming_damage: 150, resist: 50 });
    check(close(result.output.mitigation_multiplier, 2 / 3), "resist mitigation multiplier mismatch", result.output);
    check(close(result.output.post_resist_damage, 100), "resist mitigation damage mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("penetration_effective_resist", { base_resist: 100, shred_pct: 40, pct_pen: 20, flat_pen: 10 });
    check(close(result.output.effective_resist, 38), "penetration effective resist mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("crit_expected_damage", { base_damage: 200, crit_chance: 50, crit_multiplier: 160 });
    check(close(result.output.expected_crit_multiplier, 1.3), "crit multiplier mismatch", result.output);
    check(close(result.output.expected_damage, 260), "crit expected damage mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("attack_speed_scaling", { base_attack_speed: 1, bonus_attack_speed_pct: 600, attack_speed_cap: 5 });
    check(result.output.final_attack_speed === 5, "attack speed scaling must clamp to cap", result.output);
  },
  async () => {
    const result = await evaluateFormula("dps_auto_attack", { ad: 100, attack_speed: 1.2, crit_chance: 50, crit_multiplier: 160, damage_amp: 20 });
    check(close(result.output.expected_auto_dps, 187.2), "auto attack dps mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("roll_probability", { level: 8, gold_to_roll: 20, shop_slots: 5, target_slot_probability: 0.01 });
    check(result.output.shops_seen === 10 && result.output.slot_trials === 50, "roll probability trials mismatch", result.output);
    check(close(result.output.hit_probability_1_plus, 1 - Math.pow(0.99, 50)), "roll probability hit mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("shop_odds", { level: 8, cost: 4, shop_slots: 5, rerolls: 0, remaining_copies: 10, pool_total_for_cost: 130 }, { parameter_set: TEST_VERSION_PARAMETERS });
    check(close(result.output.per_slot_cost_odds, 0.3), "shop odds cost odds mismatch", result.output);
    check(result.output.per_shop_cost_hit_odds > 0.83 && result.output.per_shop_cost_hit_odds < 0.84, "shop odds shop hit mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("defensive_marginal_value", {
      current_hp: 1000,
      current_armor: 50,
      current_mr: 50,
      damage_mix: { physical_share: 0.7, magic_share: 0.3, true_share: 0 },
      candidate_stats: { armor: 40 },
    });
    check(result.output.delta_physical_ehp > 390 && result.output.delta_physical_ehp < 410, "defensive marginal armor delta mismatch", result.output);
    check(result.output.best_defensive_stat === "armor", "defensive marginal best stat mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("stat_modifier_value", {
      unit_profile: { role: "ad_carry", ad: 80, attack_speed: 0.8, hp: 900, armor: 40, magic_resist: 40 },
      stat_modifiers: [{ stat_key: "ad", value: 20 }, { stat_key: "attack_speed_pct", value: 20 }],
      existing_modifiers: [{ stat_key: "ad", value: 10 }],
    });
    check(result.output.offensive_delta > 30, "stat modifier offensive delta must be positive", result.output);
    check(result.output.overlap_penalty > 0, "stat modifier overlap penalty must detect duplicate stats", result.output);
  },
  async () => {
    const result = await evaluateFormula("item_marginal_value", {
      unit_profile: { role: "ad_carry", ad: 85, attack_speed: 0.8, preferred_item_tags: ["physical_damage", "attack_speed"] },
      current_items: [],
      candidate_item: { id: "blade", tags: ["physical_damage", "completed"], stats: { ad: 25 } },
      enemy_damage_mix: { physical_share: 0.5, magic_share: 0.5 },
      team_gaps: ["physical_damage"],
      round_intent: { tempo_weight: 1.2, cap_weight: 1 },
    });
    check(result.output.recommendation_score > result.output.conflict_penalty, "item marginal value must produce usable recommendation score", result.output);
    check(result.output.offensive_tag_match > 0, "item marginal value must expose offensive tag match", result.output);
  },
  async () => {
    const result = await evaluateFormula("reward_choice_score", {
      reward_tags: ["economy", "gold", "tempo"],
      current_gaps: ["economy"],
      round_intent: { tempo_weight: 1, economy_weight: 1.1 },
      risk_level: "medium",
    });
    check(result.output.economy_score > 0 && result.output.final_score > result.output.economy_score, "reward choice must score economy and gap fill", result.output);
  },
  async () => {
    const result = await evaluateFormula("augment_direction_score", {
      augment_tags: ["attack_speed", "physical_damage"],
      board_direction: { tags: ["physical_damage"], gaps: ["attack_speed"] },
      items: [{ tags: ["attack_speed"] }],
      economy_state: { gold: 40, hp: 70 },
    });
    check(result.output.direction_alignment > 0, "augment direction must score tag overlap", result.output);
    check(result.output.risk_adjusted_score > 0, "augment direction must output risk adjusted score", result.output);
  },
  async () => {
    const result = await evaluateFormula("trait_delta", {
      current_trait_counts: { oracle: 3 },
      candidate_unit_traits: [{ id: "oracle", count: 1 }],
      emblems: [],
      trait_breakpoints: { oracle: [{ count: 2 }, { count: 4 }, { count: 6 }] },
    });
    check(result.output.new_breakpoints[0]?.activated_breakpoint === 4, "trait delta must detect activated breakpoint", result.output);
    check(result.output.next_breakpoint_distance === 2, "trait delta must expose next breakpoint distance", result.output);
  },
  async () => {
    const result = await evaluateFormula("component_completion", {
      owned_components: { sword: 1, bow: 1 },
      candidate_recipes: [{ item_id: "rageblade", required: { bow: 1, rod: 1 } }, { item_id: "deathblade", required: { sword: 2 } }],
    });
    check(result.output.completion_distance === 1, "component completion must compute exact missing distance", result.output);
    check(result.output.missing_components.length === 1, "component completion must expose missing component", result.output);
  },
  async () => {
    const result = await evaluateFormula("trait_breakpoint_distance", { current_trait_count: 5, breakpoints: [2, 4, 6, 8] });
    check(result.output.active_breakpoint === 4 && result.output.next_count_needed === 1, "trait breakpoint distance mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("hp_lethal_tolerance", { hp: 18, stage: 5, expected_loss_damage: 9, fight_loss_streak: 2 });
    check(result.output.losses_to_elimination === 2 && result.output.must_stabilize, "hp lethal tolerance mismatch", result.output);
    check(result.output.pvp_loss_stage_damage === 10, "hp lethal tolerance should use the Common stage base", result.output);
    check(result.output.max_alive_enemy_units_to_survive === 7 && result.output.lethal_alive_enemy_units === 8, "hp lethal tolerance survivor thresholds mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("hp_lethal_tolerance", { hp: 10, stage: 5, alive_enemy_units: 3 });
    check(result.output.expected_loss_damage === 13, "hp lethal tolerance should estimate loss from stage damage plus survivors", result.output);
    check(result.output.max_alive_enemy_units_to_survive === 0 && result.output.lethal_alive_enemy_units === 0, "low HP survivor-count tolerance mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("action_feasibility", { gold: 4, required_gold: 8, bench_slots: 0, required_bench_slots: 1, item_slots: 1, time_left: 2, estimated_operation_time: 4, recognized_state: "recognized" });
    check(!result.output.is_actionable, "action feasibility must block impossible action", result.output);
    check(result.output.blocking_constraints.includes("insufficient_gold") && result.output.blocking_constraints.includes("bench_full"), "action feasibility must explain blockers", result.output);
  },
  async () => {
    const result = await evaluateFormula("operation_time_budget", { user_speed_profile: { speed: "slow" }, time_left: 5, action_count: 4 });
    check(result.output.brief_or_explain_mode === "brief", "operation time budget must switch to brief mode", result.output);
  },
  async () => {
    const result = await evaluateFormula("positioning_risk", { enemy_target_logic: "backline line", enemy_aoe_tags: ["aoe"], my_carry_position: { row: 4, col: 2 }, my_tank_position: { row: 1, col: 2 } });
    check(result.output.total_risk >= 45, "positioning risk must detect stacked backline/line risk", result.output);
    check(result.output.recommended_template === "spread_carry_and_shift_tank_anchor", "positioning risk must recommend spread template", result.output);
  },
  async () => {
    const result = await evaluateFormula("economy", { round: "4-2", gold: 52, planned_xp_buy: 0, planned_spend: 14, streak: 5, pvp_result: "win" });
    check(result.output.interest === 3 && result.output.streak_bonus === 2 && result.output.combat_gold === 1, "economy must compute interest, streak and combat gold", result.output);
    check(result.output.next_gold === 49, "economy next gold mismatch", result.output);
  },
  async () => {
    const early = await evaluateFormula("economy", { round: "1-4", gold: 7, streak: 0, pvp_result: "none" });
    check(early.output.base_income === 3 && early.output.next_gold === 10, "round-specific opening income mismatch", early.output);
    const longStreak = await evaluateFormula("economy", { round: "3-1", gold: 20, streak: -6, pvp_result: "loss" });
    check(longStreak.output.streak_bonus === 3, "six-plus streak bonus mismatch", longStreak.output);
  },
  async () => {
    const result = await evaluateFormula("level_timing", { level: 7, xp: 0, gold: 56, target_level: 8 });
    check(result.output.xp_needed === 56 && result.output.gold_needed === 56 && result.output.can_level_now, "Common level curve mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("mana_cycle", { initial_mana: 20, max_mana: 80, mana_gain_rate: 12 });
    check(result.output.mana_needed_after_start === 60 && result.output.estimated_time_to_first_cast === 5, "mana cycle mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("attacks_to_cast", { initial_mana: 40, max_mana: 100, immediate_mana: 0, mana_per_attack: 15 });
    check(result.formula_address === "jcc:common:formula:attacks_to_cast", "attacks-to-cast must use the Common formula identity", result);
    check(result.output.minimum_basic_attacks_to_first_cast === 4, "attacks-to-cast baseline mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("cast_frequency", { initial_mana: 0, max_mana: 60, mana_gain_rate: 12, fight_duration: 16, cast_time: 1 });
    check(result.output.estimated_casts >= 2, "cast frequency must estimate repeated casts", result.output);
  },
  async () => {
    const result = await evaluateFormula("contest_adjusted_pool", { base_pool_copies: 18, owned_by_player: 6, owned_by_opponents: 7, dead_or_unavailable: 0 });
    check(result.output.remaining_copies === 5 && result.output.contest_severity === "severe", "contest pool mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("shop_specific_unit_odds", { level: 8, target_cost: 4, remaining_target_copies: 10, pool_total_for_cost: 120 }, { parameter_set: TEST_VERSION_PARAMETERS });
    check(close(result.output.specific_unit_slot_odds, 0.025), "shop specific unit odds mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("roll_down_budget", { gold: 42, stop_gold: 20, free_rerolls: 2, reroll_cost: 2 });
    check(result.output.shops_seen === 13 && result.output.slot_trials === 65 && result.output.gold_left === 20, "roll down budget mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("healing_effective_hp", { healing: 400, wound_pct: 33, missing_hp_cap: 300, resists: { armor: 50, magic_resist: 50 } });
    check(result.output.effective_healing === 268 && result.output.healing_ehp === 402, "healing EHP mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("shield_effective_hp", { shield: 300, armor: 50, magic_resist: 100, damage_mix: { physical_share: 0.5, magic_share: 0.5 } });
    check(result.output.physical_shield_ehp === 450 && result.output.magic_shield_ehp === 600, "shield EHP mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("board_trait_count", { board_units: [{ traits: ["oracle", "star"] }, { traits: [{ id: "oracle", count: 1 }] }], emblems: [{ trait: "oracle" }] });
    check(result.output.trait_counts.oracle === 3 && result.output.trait_counts.star === 1, "board trait count mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("skill_value_scaling", {
      star: 2,
      hp: 1000,
      skill_value_blocks: [
        {
          label: "damage",
          value_kind: "damage",
          values: [{ by_star: [{ star: 1, value: 100 }, { star: 2, value: 150 }, { star: 3, value: 240 }] }],
          formula_refs: ["jcc:common:formula:skill_value_scaling", "jcc:common:formula:damage"],
          primary_formula_refs: ["jcc:common:formula:damage", "jcc:common:formula:skill_value_scaling"],
          scoring_use: { fast_path_formula: "jcc:common:formula:damage", primary_formula_refs: ["jcc:common:formula:damage"] },
        },
        {
          label: "fixed damage reduction",
          value_kind: "mitigation",
          values: [{ by_star: [{ star: 1, value: 40 }, { star: 2, value: 60 }, { star: 3, value: 90 }] }],
          formula_refs: ["jcc:common:formula:defensive_marginal_value"],
          primary_formula_refs: ["jcc:common:formula:defensive_marginal_value"],
          scoring_use: { fast_path_formula: "jcc:common:formula:defensive_marginal_value", primary_formula_refs: ["jcc:common:formula:defensive_marginal_value"] },
        },
        {
          label: "rocket count",
          value_kind: "count",
          values: [{ by_star: [{ star: 1, value: 3 }, { star: 2, value: 5 }, { star: 3, value: 7 }] }],
          formula_refs: ["jcc:common:formula:attack_speed_scaling"],
          primary_formula_refs: ["jcc:common:formula:attack_speed_scaling"],
          scoring_use: { fast_path_formula: "jcc:common:formula:attack_speed_scaling", primary_formula_refs: ["jcc:common:formula:attack_speed_scaling"] },
        },
        {
          label: "life drain",
          value_kind: "healing",
          single_value: { value: 85 },
          formula_refs: ["jcc:common:formula:healing_effective_hp"],
          primary_formula_refs: ["jcc:common:formula:healing_effective_hp"],
          scoring_use: { fast_path_formula: "jcc:common:formula:healing_effective_hp", primary_formula_refs: ["jcc:common:formula:healing_effective_hp"] },
        },
        {
          label: "shield",
          value_kind: "shield",
          single_value: { value: 300 },
          formula_refs: ["jcc:common:formula:shield_effective_hp"],
          primary_formula_refs: ["jcc:common:formula:shield_effective_hp"],
          scoring_use: { fast_path_formula: "jcc:common:formula:shield_effective_hp", primary_formula_refs: ["jcc:common:formula:shield_effective_hp"] },
        },
      ],
    });
    check(result.output.damage_value === 150, "skill value scaling must resolve by star", result.output);
    check(result.output.mitigation_value === 60 && result.output.count_value === 5 && result.output.healing_value === 85 && result.output.shield_value === 300, "skill value scaling must preserve value-kind buckets for fast scoring", result.output);
    check(result.output.resolved_value_by_star.every((row) => row.fast_path_formula && row.primary_formula_refs?.length > 0), "skill value scaling must expose per-block fast-path formula doorplates", result.output);
    for (const formulaRef of ["jcc:common:formula:damage", "jcc:common:formula:defensive_marginal_value", "jcc:common:formula:attack_speed_scaling", "jcc:common:formula:healing_effective_hp", "jcc:common:formula:shield_effective_hp"]) {
      check(result.output.fast_path_formula_refs.includes(formulaRef) && result.output.primary_formula_refs.includes(formulaRef), `skill value scaling must surface ${formulaRef}`, result.output);
    }
  },
  async () => {
    const result = await evaluateFormula("damage_amp_stack", { base_damage: 100, amp_sources: [20, { value: 10 }], stacking_policy: "additive" });
    check(close(result.output.amped_damage, 130), "damage amp stack mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("damage_mix", { champion_tags: ["physical_damage"], item_tags: ["crit"], trait_tags: ["magic_damage"] });
    check(result.output.primary_damage_type === "physical" && result.output.physical_share > result.output.magic_share, "damage mix must infer primary damage type", result.output);
  },
  async () => {
    const result = await evaluateFormula("double_cast_effectiveness", { base_cast_value: 100, repeat_efficiency_pct: 50, estimated_casts: 3, overkill_or_shield_waste: 20 });
    check(close(result.output.extra_cast_value, 120), "double cast extra value mismatch", result.output);
    check(close(result.output.effective_total_cast_value, 420), "double cast total value mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("item_conflict_penalty", { current_items: [{ id: "a", tags: ["wound", "attack_speed"] }, { id: "b", tags: ["attack_speed"] }, { id: "c", tags: [] }], candidate_item: { id: "a", unique: true, tags: ["wound", "attack_speed"] }, role_slots: 3 });
    check(result.output.conflict_penalty > 0 && result.output.conflict_reasons.includes("item_slots_full") && result.output.conflict_reasons.includes("duplicate_unique"), "item conflict penalty must expose slot and unique conflicts", result.output);
  },
  async () => {
    const result = await evaluateFormula("item_stat_delta", { current_stats: { ad: 50, armor: 30 }, item_stats: { ad: 15, magic_resist: 20 } });
    check(result.output.new_stats.ad === 65 && result.output.new_stats.magic_resist === 20 && result.output.stat_delta_tags.includes("ad"), "item stat delta mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("resource_exchange", { gold: 10, xp: 4, rerolls: 2, items: [{ id: "x" }], duplicators: 1, hp: 10, risk_level: "high", round: 2 });
    check(result.output.estimated_gold_equivalent === 56 && result.output.risk_adjusted_value === 70 && close(result.output.tempo_value, 67.2), "resource exchange mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("comp_gap_score", { board_tags: ["frontline"], item_tags: ["wound"], enemy_tags: ["magic_damage"] });
    check(result.output.missing_gap_scores.frontline === 0 && result.output.missing_gap_scores.magic_resist > result.output.missing_gap_scores.control, "comp gap score mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("effect_block_value", { round_intent: { tempo_weight: 1, economy_weight: 1.1 }, effect_block: { tags: ["economy"], numeric_values: [{ value: 5 }], formula_refs: ["jcc:future:formula:trait_delta"], effect_types: ["grant"] } });
    check(result.output.resource_delta === 5 && result.output.choice_value > 0 && result.output.trait_delta_value === 20, "effect block value mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("encounter_rule_shift", { baseline_rules: { shop: true, interest: 5 }, encounter: { modifiers: [{ target: "interest", operation: "set", value: 7 }, { target: "bonus", value: 2 }], formula_refs: ["jcc:future:formula:economy"] } });
    check(result.output.modified_rules.interest === 7 && result.output.modified_rules.bonus === 2 && result.output.affected_formulas[0] === "jcc:future:formula:economy", "encounter rule shift mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("pivot_cost", { current_board: [{ id: "a" }, { id: "b" }, { id: "c" }], target_skeleton: [{ id: "a" }, { id: "d" }], shared_units: ["a"], lost_upgrades: 1, item_mismatch: 2 });
    check(result.output.gold_cost === 10 && result.output.trait_loss === 2 && result.output.pivot_risk === 62, "pivot cost mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("player_habit_bias", { decision_events: [{ type: "late_item", severity: 2 }], user_feedback: [{ habit: "late_item", weight: 3 }] });
    check(result.output.habit_biases.late_item === 5 && result.output.coaching_reminders[0] === "late_item", "player habit bias mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("star_upgrade_delta", { stats_before: { hp: 800, ad: 50, armor: 30, magic_resist: 30 }, stats_after: { hp: 1200, ad: 75, armor: 35, magic_resist: 35 }, skill_values_before: [{ value: 100 }], skill_values_after: [{ value: 180 }] });
    check(result.output.delta_hp === 400 && result.output.delta_ad === 25 && result.output.delta_skill_values === 80, "star upgrade delta mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("streak_value", { current_streak: 4, round_result: "win" });
    check(result.output.current_bonus === 1 && result.output.next_bonus === 2 && result.output.break_cost === 1, "streak value mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("summon_scaling", { summon_base_profile: { hp: 1000, armor: 30, magic_resist: 30, ad: 60, ap: 20, attack_speed: 0.8 }, trait_breakpoint: { multiplier: 1.5 }, summoner_star_sum: 4, stage: 3, item_or_trait_buffs: [{ id: "buff" }] });
    check(result.output.summon_quality_score > result.output.summon_frontline_value && result.output.scaling_delta > 0, "summon scaling mismatch", result.output);
  },
  async () => {
    const result = await evaluateFormula("review_attribution_score", { timeline_events: [{ type: "late_roll", severity: 2, confidence: 1.5 }, { type: "late_roll", severity: 1 }], decision_events: [{ type: "late_roll", severity: 2, confidence: 1.5 }, { type: "late_roll", severity: 1 }] });
    check(result.output.top_loss_reasons[0]?.reason === "late_roll", "review attribution must rank repeated reasons", result.output);
  },
  async () => {
    const result = await evaluateFormula("scouting_priority_score", { likely_next_opponents: [{ id: "A", weight: 20, threat: 10 }], contestants: [{ id: "B", weight: 22, contest: 15 }], time_left: 20 });
    check(result.output.scout_order[0]?.id === "B", "scouting priority must sort highest priority", result.output);
  },
  async () => {
    const result = await evaluateFormula("unsupported_formula", {});
    check(!result.executable && result.confidence === "unsupported_formula", "unsupported formula must return safe unsupported result", result);
  },
  async () => {
    const result = await evaluateFormula("action_feasibility", {});
    check(!result.executable && result.confidence === "missing_required_input", "missing live-decision inputs must block exact evaluator output", result);
    check(result.missing_inputs.some((row) => row.name === "gold") && result.missing_inputs.some((row) => row.name === "time_left"), "missing inputs must identify required live-state fields", result);
    check(Array.isArray(result.missing_live_state_fields) && result.missing_live_state_fields.includes("gold") && result.missing_live_state_fields.includes("time_left"), "missing live-state fields must be surfaced", result);
  },
];

const REQUIRED_EVALUATORS = [
  "action_feasibility",
  "attack_speed_scaling",
  "augment_direction_score",
  "attacks_to_cast",
  "board_trait_count",
  "cast_frequency",
  "comp_gap_score",
  "component_completion",
  "contest_adjusted_pool",
  "crit_expected_damage",
  "damage",
  "damage_amp_stack",
  "damage_mix",
  "defensive_marginal_value",
  "double_cast_effectiveness",
  "dps_auto_attack",
  "economy",
  "effect_block_value",
  "ehp",
  "encounter_rule_shift",
  "healing_effective_hp",
  "hp_lethal_tolerance",
  "interest_break",
  "item_conflict_penalty",
  "item_marginal_value",
  "item_stat_delta",
  "level_timing",
  "mana_cycle",
  "operation_time_budget",
  "penetration_effective_resist",
  "pivot_cost",
  "player_habit_bias",
  "positioning_risk",
  "pvp_player_damage",
  "resist_mitigation",
  "resource_exchange",
  "review_attribution_score",
  "reward_choice_score",
  "roll_down_budget",
  "roll_probability",
  "scouting_priority_score",
  "shield_effective_hp",
  "shop_odds",
  "shop_specific_unit_odds",
  "skill_value_scaling",
  "star_upgrade_delta",
  "stat_modifier_value",
  "streak_value",
  "summon_scaling",
  "trait_breakpoint_distance",
  "trait_delta",
  "unit_quality_score",
];

for (const name of REQUIRED_EVALUATORS) {
  check(typeof EVALUATORS[name] === "function", `${name} evaluator must be registered`);
}
check(Object.keys(EVALUATORS).length === REQUIRED_EVALUATORS.length, "evaluator registry must not have missing or stray entries", { expected: REQUIRED_EVALUATORS.length, actual: Object.keys(EVALUATORS).length });

for (const testCase of cases) await testCase();

console.log(JSON.stringify({ ok: true, evaluator_count: Object.keys(EVALUATORS).length, cases: cases.length }, null, 2));
