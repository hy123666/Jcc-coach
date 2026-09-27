const REROLL_ARCHETYPES = new Set([
  "one_cost_reroll",
  "two_cost_reroll",
  "three_cost_reroll",
]);

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, finiteNumber(value, 0)));
}

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function shopOddsRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([level, row]) => {
    if (Array.isArray(row)) {
      return Object.fromEntries([
        ["level", Number(level)],
        ...row.map((odds, index) => [`cost${index + 1}`, odds]),
      ]);
    }
    return row && typeof row === "object"
      ? { level: row.level ?? Number(level), ...row }
      : { level: Number(level) };
  });
}

function normalizeArchetypeId(archetype) {
  return String(archetype?.id || archetype || "").trim() || null;
}

function maxCoreCostForPopulation(policy, population) {
  const level = finiteNumber(population, policy.stabilize_population);
  if (policy.id === "legendary_cap") return 5;
  if (policy.id === "four_cost_carry" || policy.id === "eight_four_operation") return level >= 9 ? 5 : 4;
  if (REROLL_ARCHETYPES.has(policy.id)) {
    if (level <= policy.stabilize_population) return policy.core_cost;
    return Math.min(5, policy.core_cost + Math.max(0, level - policy.stabilize_population));
  }
  return null;
}

export function getLineupArchetypePolicy(archetype, population = null) {
  const id = normalizeArchetypeId(archetype);
  const requestedCost = finiteNumber(archetype?.carry_cost ?? archetype?.main_carry_cost);
  const policies = {
    one_cost_reroll: {
      id,
      style: "reroll",
      core_cost: 1,
      stabilize_population: 5,
      target_population: 7,
      default_star_targets: [{ role: "main_carry", star: 3 }],
      roll_window: "early_level_slow_or_hyper_roll",
    },
    two_cost_reroll: {
      id,
      style: "reroll",
      core_cost: 2,
      stabilize_population: 6,
      target_population: 8,
      default_star_targets: [{ role: "main_carry", star: 3 }],
      roll_window: "level_six_reroll_then_leveling",
    },
    three_cost_reroll: {
      id,
      style: "reroll",
      core_cost: 3,
      stabilize_population: 7,
      target_population: 8,
      default_star_targets: [{ role: "main_carry", star: 3 }],
      roll_window: "level_seven_reroll_then_leveling",
    },
    four_cost_carry: {
      id,
      style: "four_cost_reroll_or_level_eight",
      core_cost: 4,
      stabilize_population: 8,
      target_population: 8,
      default_star_targets: [{ role: "main_carry", star: 3 }],
      roll_window: "level_eight_quality_before_level_nine",
    },
    eight_four_operation: {
      id,
      style: "level_eight_operation",
      core_cost: 4,
      stabilize_population: 8,
      target_population: 8,
      default_star_targets: [{ role: "main_carry", star: 2 }, { role: "main_tank", star: 2 }],
      roll_window: "level_eight_stabilize",
    },
    legendary_cap: {
      id,
      style: "high_cap_operation",
      core_cost: 5,
      stabilize_population: 8,
      target_population: 9,
      default_star_targets: [{ role: "main_carry", star: 2 }, { role: "main_tank", star: 2 }],
      roll_window: "level_nine_high_cap",
    },
  };
  const policy = policies[id] || {
    id,
    style: "unknown",
    core_cost: requestedCost,
    stabilize_population: finiteNumber(population, 8),
    target_population: finiteNumber(population, 8),
    default_star_targets: [],
    roll_window: "unknown",
  };
  return {
    ...policy,
    requested_population: finiteNumber(population),
    max_core_unit_cost: maxCoreCostForPopulation(policy, population ?? policy.target_population),
    maxCoreUnitCostAt: (level) => maxCoreCostForPopulation(policy, level),
    max_core_unit_cost_at: (level) => maxCoreCostForPopulation(policy, level),
    is_reroll: REROLL_ARCHETYPES.has(id),
  };
}

function findUnitByRole(roster, role) {
  return roster.find((unit) => Array.isArray(unit?.roles) && unit.roles.includes(role)) || null;
}

function unitCost(unit) {
  return finiteNumber(unit?.cost, 0);
}

function unitPopulationCost(unit) {
  return Math.max(1, finiteNumber(unit?.population_cost, 1));
}

function unitStarPurchaseCost(unit, star = 1) {
  return unitCost(unit) * copiesForStar(Math.max(1, Math.min(3, Math.floor(finiteNumber(star, 1)))));
}

function copiesForStar(star) {
  if (star >= 3) return 9;
  if (star === 2) return 3;
  return 1;
}

function conditionValues(conditions, ...keys) {
  for (const key of keys) {
    if (Array.isArray(conditions?.[key]) && conditions[key].length) return conditions[key];
  }
  return [];
}

function resolveStarTargets(requested, policy, roster) {
  const supplied = asArray(requested).filter((target) => target && typeof target === "object");
  const targets = supplied.length ? supplied : policy.default_star_targets;
  return targets.map((target) => {
    const unit = target.unit || findUnitByRole(roster, target.role);
    const star = Math.max(1, Math.min(3, Math.floor(finiteNumber(target.star ?? target.stars, 2))));
    return {
      role: target.role || null,
      unit_id: target.unit_id || unit?.id || null,
      unit_name: target.unit_name || unit?.name || null,
      unit_cost: unit ? unitCost(unit) : null,
      star,
      total_copies_from_one_star: copiesForStar(star),
      source: supplied.length ? "explicit" : "archetype_default",
    };
  }).filter((target) => target.unit_id || target.unit_name || target.role);
}

function oddsForCost(parameters, level, cost) {
  const row = shopOddsRows(parameters?.shop?.odds_by_level)
    .find((candidate) => Number(candidate.level) === Number(level));
  if (!row) return null;
  const value = row[`cost${cost}`] ?? row[cost] ?? null;
  const parsed = finiteNumber(value);
  if (parsed == null) return null;
  const rowValues = [1, 2, 3, 4, 5]
    .map((tier) => finiteNumber(row[`cost${tier}`] ?? row[tier]))
    .filter((tier) => tier != null);
  const rowUsesPercentPoints = rowValues.reduce((sum, tier) => sum + tier, 0) > 1.5;
  return rowUsesPercentPoints ? parsed / 100 : parsed;
}

function buildPhasePlans(policy, population, roster, currentFacts = {}) {
  const stabilize = policy.stabilize_population;
  const target = finiteNumber(population, policy.target_population);
  const mainCarry = findUnitByRole(roster, "main_carry");
  const mainTank = findUnitByRole(roster, "main_tank");
  const phasePlans = [];
  if (policy.is_reroll) {
    const stageMax = policy.maxCoreUnitCostAt(stabilize);
    const stageCarry = mainCarry && unitCost(mainCarry) <= stageMax ? mainCarry : null;
    const stageTank = mainTank && unitCost(mainTank) <= stageMax ? mainTank : null;
    phasePlans.push({
      phase: `level_${stabilize}_reroll`,
      population: stabilize,
      required_core_cost_at_most: policy.core_cost,
      main_carry: stageCarry ? { id: stageCarry.id, name: stageCarry.name, cost: unitCost(stageCarry) } : null,
      main_tank: stageTank ? { id: stageTank.id, name: stageTank.name, cost: unitCost(stageTank) } : null,
      future_main_carry: stageCarry || !mainCarry ? null : { id: mainCarry.id, name: mainCarry.name, cost: unitCost(mainCarry) },
      future_main_tank: stageTank || !mainTank ? null : { id: mainTank.id, name: mainTank.name, cost: unitCost(mainTank) },
      stage_role_gap: {
        main_carry: !stageCarry,
        main_tank: !stageTank,
      },
      objective: "reach_core_star_targets_before_buying_high_cost_cap_units",
      roll_window: policy.roll_window,
      current_level: finiteNumber(currentFacts.level),
    });
  }
  if (target > stabilize) {
    if (policy.id === "legendary_cap" && stabilize < target) {
      phasePlans.push({
        phase: `level_${stabilize}_startup`,
        population: stabilize,
        required_core_cost_at_most: 4,
        objective: "choose_immediate_stabilize_or_delayed_leveling_from_hp_economy_and_temporary_high_cost_units",
        delayed_start_allowed: true,
      });
    }
    phasePlans.push({
      phase: `level_${target}_upgrade`,
      population: target,
      required_core_cost_at_most: policy.maxCoreUnitCostAt(target),
      objective: policy.is_reroll ? "add_functional_high_cost_units_after_stabilization" : "complete_primary_formation",
      main_carry: mainCarry ? { id: mainCarry.id, name: mainCarry.name, cost: unitCost(mainCarry) } : null,
      main_tank: mainTank ? { id: mainTank.id, name: mainTank.name, cost: unitCost(mainTank) } : null,
    });
  }
  if (!phasePlans.length) {
    phasePlans.push({
      phase: `population_${target}_formation`,
      population: target,
      required_core_cost_at_most: policy.maxCoreUnitCostAt(target),
      objective: "complete_primary_formation",
      main_carry: mainCarry ? { id: mainCarry.id, name: mainCarry.name, cost: unitCost(mainCarry) } : null,
      main_tank: mainTank ? { id: mainTank.id, name: mainTank.name, cost: unitCost(mainTank) } : null,
    });
  }
  if (policy.id === "legendary_cap") {
    phasePlans.push({
      phase: "high_cap",
      population: Math.max(10, target + 1),
      required_core_cost_at_most: 5,
      objective: "add_five_cost_quality_and_complete_high_cap_traits",
    });
  }
  return phasePlans;
}

export function evaluateLineupFeasibility({
  roster = [],
  population,
  archetype = null,
  parameters = null,
  currentFacts = {},
  starTargets = [],
  requiredConditions = {},
  sourceAuthority = "core_only_theory",
} = {}) {
  const policy = getLineupArchetypePolicy(archetype, population);
  const targetPopulation = finiteNumber(population, policy.target_population);
  const coreMax = policy.maxCoreUnitCostAt(targetPopulation);
  const carry = findUnitByRole(roster, "main_carry");
  const tank = findUnitByRole(roster, "main_tank");
  const highCostUnits = roster.filter((unit) => unitCost(unit) >= 4);
  const coreCostViolations = coreMax == null
    ? []
    : roster.filter((unit) => unitCost(unit) > coreMax).map((unit) => ({
        id: unit.id,
        name: unit.name,
        cost: unitCost(unit),
        allowed_at_population: coreMax,
      }));
  const rejectionReasons = [];
  if (carry && policy.core_cost != null && policy.is_reroll && unitCost(carry) !== policy.core_cost) {
    rejectionReasons.push({ code: "main_carry_cost_mismatch", unit: carry.name, expected: policy.core_cost, actual: unitCost(carry) });
  }
  if (coreCostViolations.length && policy.is_reroll && targetPopulation <= policy.stabilize_population) {
    rejectionReasons.push({
      code: "required_stage_core_contains_unavailable_high_cost_units",
      population: targetPopulation,
      max_core_unit_cost: coreMax,
      units: coreCostViolations,
    });
  }
  if (policy.id && !carry) rejectionReasons.push({ code: "main_carry_missing" });
  if (policy.id && !tank) rejectionReasons.push({ code: "main_tank_missing" });
  const starPlan = resolveStarTargets(starTargets, policy, roster);
  const oddsLevels = [...new Set([
    policy.stabilize_population,
    targetPopulation,
    finiteNumber(currentFacts.level),
  ].filter((level) => Number.isInteger(level) && level > 0))];
  const odds = oddsLevels.map((level) => ({
    level,
    by_cost: Object.fromEntries([1, 2, 3, 4, 5].map((cost) => [cost, oddsForCost(parameters, level, cost)])),
  }));
  const copyPressure = starPlan.map((target) => ({
    ...target,
    unit_cost: target.unit_cost ?? (target.unit_id
      ? roster.find((unit) => String(unit.id) === String(target.unit_id))?.cost ?? null
      : null),
    probability_relevant_cost: target.unit_id
      ? roster.find((unit) => String(unit.id) === String(target.unit_id))?.cost ?? null
      : null,
    contest_adjustment: currentFacts?.remaining_copies || currentFacts?.contested_units
      ? "current_pool_facts_supplied"
      : "unknown_uncontested_upper_bound",
  }));
  const highCostPressure = clamp01(highCostUnits.length / Math.max(1, roster.length) * 0.8);
  const starPressure = clamp01(copyPressure.filter((target) => target.star >= 3).length * 0.35);
  const conditionPressure = clamp01(
    conditionValues(requiredConditions, "required_items", "required_item_ids").length * 0.12
      + conditionValues(requiredConditions, "required_emblems", "required_emblem_ids").length * 0.2
      + conditionValues(requiredConditions, "required_augments", "required_augment_ids").length * 0.2
      + asArray(requiredConditions.special_mechanics).length * 0.15,
  );
  const transitionPressure = policy.is_reroll && targetPopulation > policy.stabilize_population ? 0.08 : 0;
  const burdenScore = Number((0.35 * highCostPressure + 0.35 * starPressure + 0.2 * conditionPressure + 0.1 * transitionPressure).toFixed(3));
  const formationProfile = {
    schema: "jcc-lineup-formation-profile-v2",
    authority: "shared_common_method_with_core_and_optional_ranking_inputs",
    source_authority: sourceAuthority,
    archetype: policy.id,
    style: policy.style,
    target_population: targetPopulation,
    stabilize_population: policy.stabilize_population,
    core_cost: policy.core_cost,
    max_core_unit_cost: coreMax,
    burden_score: burdenScore,
    burden_band: rejectionReasons.length ? "blocked" : burdenScore >= 0.66 ? "high" : burdenScore >= 0.33 ? "medium" : "low",
    components: {
      high_cost_dependency: highCostPressure,
      star_target_pressure: starPressure,
      explicit_condition_pressure: conditionPressure,
      transition_pressure: transitionPressure,
    },
    high_cost_units: highCostUnits.map((unit) => ({ id: unit.id, name: unit.name, cost: unitCost(unit) })),
    core_cost_violations: coreCostViolations,
    unknowns: [
      ...(currentFacts?.remaining_copies || currentFacts?.contested_units ? [] : ["current_remaining_copies_and_contest_pressure"]),
      ...(parameters ? [] : ["shop_odds_parameters"]),
      ...(Object.keys(requiredConditions).length ? [] : ["explicit_item_augment_emblem_and_mechanic_conditions"]),
    ],
  };
  const phasePlans = buildPhasePlans(policy, targetPopulation, roster, currentFacts);
  const targetByUnitId = new Map(copyPressure
    .filter((target) => target.unit_id)
    .map((target) => [String(target.unit_id), target]));
  const targetByUnitName = new Map(copyPressure
    .filter((target) => target.unit_name)
    .map((target) => [String(target.unit_name).trim().toLowerCase(), target]));
  const targetUnitCosts = roster.map((unit) => {
    const target = targetByUnitId.get(String(unit.id))
      || targetByUnitName.get(String(unit.name || "").trim().toLowerCase());
    const star = target?.star || 1;
    return {
      id: unit.id,
      name: unit.name,
      cost: unitCost(unit),
      star,
      copies: copiesForStar(star),
      purchase_cost: unitStarPurchaseCost(unit, star),
      target_role: target?.role || null,
    };
  });
  const rosterPurchaseCost = roster.reduce((sum, unit) => sum + unitCost(unit), 0);
  const targetRosterPurchaseCost = targetUnitCosts.reduce((sum, unit) => sum + unit.purchase_cost, 0);
  const starTargetPurchaseCost = copyPressure.reduce((sum, target) => {
    const unit = target.unit_id
      ? roster.find((entry) => String(entry.id) === String(target.unit_id))
      : roster.find((entry) => String(entry.name || "").trim().toLowerCase() === String(target.unit_name || "").trim().toLowerCase());
    return sum + (unit ? unitStarPurchaseCost(unit, target.star) : 0);
  }, 0);
  const status = rejectionReasons.length ? "blocked" : formationProfile.unknowns.length ? "conditional" : "feasible";
  return {
    schema: "jcc-lineup-feasibility-v1",
    executable: status !== "blocked",
    status,
    policy: {
      id: policy.id,
      style: policy.style,
      core_cost: policy.core_cost,
      stabilize_population: policy.stabilize_population,
      target_population: policy.target_population,
      roll_window: policy.roll_window,
    },
    phase_plans: phasePlans,
    formation_profile: formationProfile,
    acquisition_profile: {
      shop_odds_by_level: odds,
      star_targets: copyPressure,
      estimate_boundary: "per-slot shop odds and copy pressure only; not a full combat or exact roll-probability simulation",
    },
    economy_profile: {
      roster_purchase_cost: rosterPurchaseCost,
      star_target_purchase_cost: starTargetPurchaseCost,
      target_roster_purchase_cost: targetRosterPurchaseCost,
      target_unit_costs: targetUnitCosts,
      star_copy_cost_is_separate: false,
      target_cost_scope: "roster_unit_purchase_cost_by_target_star_only",
      roll_and_xp_cost_requires_current_gold_level_xp: true,
    },
    condition_profile: {
      required_items: conditionValues(requiredConditions, "required_items", "required_item_ids"),
      required_augments: conditionValues(requiredConditions, "required_augments", "required_augment_ids"),
      required_emblems: conditionValues(requiredConditions, "required_emblems", "required_emblem_ids"),
      special_mechanics: asArray(requiredConditions.special_mechanics),
    },
    rejection_reasons: rejectionReasons,
  };
}
