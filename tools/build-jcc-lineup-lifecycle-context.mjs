import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { loadActiveRulesBundle } from "./jcc_active_rules_contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function stageMajor(stageRound) {
  const match = String(stageRound || "").match(/^(\d+)-/);
  return match ? Number(match[1]) : null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function resolveProfileContext(profileContext = null, baseRules = null) {
  if (baseRules) {
    return {
      core_profile_id: profileContext?.core_profile_id || null,
      rules_source_fingerprint: profileContext?.rules_source_fingerprint || null,
      base_game_rules: baseRules,
      source: profileContext?.source || "explicit_base_rules",
    };
  }
  if (profileContext?.base_game_rules) {
    return {
      core_profile_id: profileContext.core_profile_id || null,
      rules_source_fingerprint: profileContext.rules_source_fingerprint || null,
      base_game_rules: profileContext.base_game_rules,
      source: profileContext.source || "captured_core_profile",
    };
  }
  const runtimePaths = createRuntimePaths(repoRoot);
  const rulesBundle = loadActiveRulesBundle({ repoRoot, runtimePaths });
  return {
    core_profile_id: runtimePaths.activeCoreProfileId || null,
    rules_source_fingerprint: rulesBundle.source_fingerprint || null,
    base_game_rules: rulesBundle.base_game_rules,
    source: "standalone_active_profile_resolution",
  };
}

function normalizeUnit(unit) {
  const roleText = [unit?.role, unit?.role_tag, unit?.tags, unit?.position_role]
    .flatMap(asArrayOrScalar)
    .join(" ")
    .toLowerCase();
  return {
    ...unit,
    name: String(unit?.name || unit?.hero_name || unit?.cn_name || unit?.id || "unknown"),
    cost: numberOrNull(unit?.cost ?? unit?.tier ?? unit?.price),
    star: numberOrNull(unit?.star ?? unit?.stars) ?? 1,
    role_text: roleText,
  };
}

function asArrayOrScalar(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function normalizeLiveState(raw = {}) {
  const root = raw.live_state || raw;
  const phase = root.phase || root.round || {};
  const economy = root.economy || root.player?.economy || {};
  const board = root.board || root.own_board || {};
  const bench = root.bench || root.own_bench || {};
  const shop = root.shop || {};
  const items = root.items || root.equipment || {};
  const xpRaw = economy.xp || economy.exp || {};
  return {
    stage_round: firstDefined(phase.stage_round, phase.stageRound, root.stage_round, null),
    hp: numberOrNull(firstDefined(economy.hp, economy.health, economy.life)),
    gold: numberOrNull(firstDefined(economy.gold, economy.money)),
    level: numberOrNull(firstDefined(economy.level, economy.lv)),
    xp: {
      value: numberOrNull(typeof xpRaw === "object" ? firstDefined(xpRaw.value, xpRaw.current, xpRaw.xp) : xpRaw),
      to_next: numberOrNull(typeof xpRaw === "object" ? firstDefined(xpRaw.to_next, xpRaw.toNext, xpRaw.next) : null),
    },
    board_units: asArray(firstDefined(board.board_units, board.units, root.board_units, root.own_board_units)).map(normalizeUnit),
    bench_units: asArray(firstDefined(bench.bench_units, bench.units, root.bench_units, root.own_bench_units)).map(normalizeUnit),
    shop_units: asArray(firstDefined(shop.shop_units, shop.units, root.shop_units)).map(normalizeUnit),
    item_bench: asArray(firstDefined(items.item_bench, items.inventory, items.components)),
    equipped_items: asArray(firstDefined(items.equipped_items, items.equipped, items.unit_equipment)),
  };
}

function normalizeContext(raw = {}) {
  const root = raw.context || raw;
  return {
    root,
    target_plan: root.target_plan || root.strategy?.target_plan || root.current_plan || null,
  };
}

function normalizedArchetype(value) {
  const raw = String(value || "").trim().toLowerCase();
  const aliases = {
    one_cost: "one_cost_reroll",
    one_cost_reroll: "one_cost_reroll",
    low_cost_reroll: "one_cost_reroll",
    two_cost: "two_cost_reroll",
    two_cost_reroll: "two_cost_reroll",
    three_cost: "three_cost_reroll",
    three_cost_reroll: "three_cost_reroll",
    three_cost_carry_candidate: "three_cost_reroll",
    four_cost: "four_cost_carry",
    four_cost_carry: "four_cost_carry",
    four_cost_level_eight_candidate: "four_cost_carry",
    fast_8: "four_cost_carry",
    legendary: "legendary_cap",
    legendary_cap: "legendary_cap",
    fast_9: "legendary_cap",
    emblem: "emblem_conditioned",
    emblem_conditioned: "emblem_conditioned",
    early_high_cost_pivot: "early_high_cost_pivot",
  };
  return aliases[raw] || null;
}

function normalizedUnitName(value) {
  return String(value || "").trim().toLowerCase();
}

function formationProfileForPlan(plan = {}) {
  return plan?.formation_profile
    || plan?.strategy_profile?.formation_profile
    || plan?.candidate?.formation_profile
    || null;
}

function buildFormationReadiness(profile, live, boardReadiness) {
  if (!profile || typeof profile !== "object") return null;
  const targetUnits = asArray(profile.target_units);
  const observedUnits = [...live.board_units, ...live.bench_units];
  const observedNames = new Set(observedUnits.map((unit) => normalizedUnitName(unit.name)).filter(Boolean));
  const acquiredTargets = targetUnits.filter((unit) => observedNames.has(normalizedUnitName(unit.champion_name)));
  const targetCount = targetUnits.length;
  const targetCoverage = targetCount ? clamp01(acquiredTargets.length / targetCount) : null;
  const targetPopulation = numberOrNull(profile.target_population);
  const populationCoverage = targetPopulation && live.level !== null
    ? clamp01(live.level / targetPopulation)
    : null;
  const highCostTargets = targetUnits.filter((unit) => Number(unit.cost) >= 4);
  const acquiredHighCost = highCostTargets.filter((unit) => observedNames.has(normalizedUnitName(unit.champion_name)));
  const highCostCoverage = highCostTargets.length
    ? clamp01(acquiredHighCost.length / highCostTargets.length)
    : null;
  const components = [
    { id: "target_unit_coverage", value: targetCoverage, weight: 0.45 },
    { id: "population_coverage", value: populationCoverage, weight: 0.25 },
    { id: "high_cost_unit_coverage", value: highCostCoverage, weight: 0.2 },
    { id: "board_quality", value: numberOrNull(boardReadiness?.board_quality_score), weight: 0.1 },
  ];
  const known = components.filter((component) => component.value !== null);
  const weight = known.reduce((sum, component) => sum + component.weight, 0);
  const readinessScore = weight
    ? Number((known.reduce((sum, component) => sum + component.value * component.weight, 0) / weight).toFixed(3))
    : null;
  const burden = profile.estimated_burden_score;
  const unknowns = [
    ...(Array.isArray(profile.unknowns) ? profile.unknowns : []),
    targetCount ? null : "target_unit_roster_unavailable",
    populationCoverage === null ? "current_level_unavailable" : null,
  ].filter(Boolean);
  return {
    schema: "jcc-current-formation-readiness-v1",
    authority: "current_match_only_derived_from_static_formation_profile_and_live_facts",
    burden_band: profile.burden_band || "unknown",
    burden_score: Number.isFinite(Number(burden)) ? Number(burden) : null,
    readiness_score: readinessScore,
    readiness_band: readinessScore === null ? "unknown"
      : readinessScore >= 0.75 ? "ready"
        : readinessScore >= 0.5 ? "forming"
          : "early_or_incomplete",
    target_population: targetPopulation,
    current_level: live.level,
    target_unit_count: targetCount,
    acquired_target_unit_count: acquiredTargets.length,
    acquired_target_units: acquiredTargets.map((unit) => unit.champion_name),
    high_cost_target_count: highCostTargets.length,
    acquired_high_cost_target_count: acquiredHighCost.length,
    components,
    unknowns,
    policy: {
      does_not_change_national_strength: true,
      does_not_infer_unobserved_requirements: true,
      does_not_persist_as_ranking_fact: true,
    },
  };
}

function candidateStrategyProfile(candidate = {}) {
  return candidate.strategy_profile || candidate;
}

function candidateMainCarry(profile = {}) {
  return profile.main_carry
    || asArray(profile.variants).find((variant) => variant?.main_carry)?.main_carry
    || null;
}

function candidateCoreNames(profile = {}) {
  const variant = asArray(profile.variants)[0] || {};
  const explicitCoreNames = [...new Set([
    candidateMainCarry(profile)?.champion_name,
    ...asArray(profile.core_units).map((unit) => unit?.champion_name || unit?.name),
    ...asArray(variant.core_units).map((unit) => unit?.champion_name || unit?.name),
  ].map(normalizedUnitName).filter(Boolean))];
  if (explicitCoreNames.length) return explicitCoreNames;
  return [...new Set(asArray(variant.lineup_names).map(normalizedUnitName).filter(Boolean))];
}

function equivalentCopyCount(unit) {
  const star = numberOrNull(unit?.star ?? unit?.stars) ?? 1;
  if (star >= 3) return 9;
  if (star >= 2) return 3;
  return 1;
}

function assessLineupCandidateStageReadiness({
  candidate = {},
  stageRound = null,
  currentBoardShopBench = {},
  metaStrength = 0,
  augmentFit = 0,
  itemFit = 0,
  currentBoardFit = 0,
  durableTargetAligned = false,
  level = null,
  gold = null,
  hp = null,
} = {}) {
  const profile = candidateStrategyProfile(candidate);
  const lifecyclePrior = profile.lifecycle_prior || {};
  const carry = candidateMainCarry(profile) || {};
  const carryCost = numberOrNull(lifecyclePrior.main_carry_cost ?? carry.cost);
  const archetype = normalizedArchetype(lifecyclePrior.archetype)
    || (carryCost === 1 ? "one_cost_reroll"
      : carryCost === 2 ? "two_cost_reroll"
        : carryCost === 3 ? "three_cost_reroll"
          : carryCost === 4 ? "four_cost_carry"
            : carryCost !== null && carryCost >= 5 ? "legendary_cap" : "flex_transition");
  const targetPopulation = numberOrNull(lifecyclePrior.target_population)
    ?? numberOrNull(asArray(profile.variants)[0]?.population);
  const major = stageMajor(stageRound);
  const boardUnits = [...asArray(currentBoardShopBench.board_units), ...asArray(currentBoardShopBench.bench_units)]
    .map(normalizeUnit);
  const coreNames = candidateCoreNames(profile);
  const carryName = normalizedUnitName(carry.champion_name || carry.name);
  const matchedCoreUnits = boardUnits.filter((unit) => coreNames.includes(normalizedUnitName(unit.name)));
  const matchedCoreNames = [...new Set(matchedCoreUnits.map((unit) => normalizedUnitName(unit.name)))];
  const carryUnits = carryName
    ? boardUnits.filter((unit) => normalizedUnitName(unit.name) === carryName)
    : [];
  const carryCopies = carryUnits.reduce((sum, unit) => sum + equivalentCopyCount(unit), 0);
  const carryBestStar = carryUnits.reduce((best, unit) => Math.max(best, numberOrNull(unit.star) || 1), 0);
  const coreTwoStarCount = matchedCoreUnits.filter((unit) => (numberOrNull(unit.star) || 1) >= 2).length;
  const coreCoverage = coreNames.length ? clamp01(matchedCoreNames.length / coreNames.length) : 0;
  const boardSignalStrong = currentBoardFit >= 0.6
    || carryBestStar >= 2
    || (matchedCoreNames.length >= 2 && coreCoverage >= 0.5);
  const evidenceSignals = [
    metaStrength >= 0.55 ? "current_master_plus_meta_support" : null,
    augmentFit >= 0.55 ? "confirmed_augment_fit" : null,
    itemFit >= 0.55 ? "confirmed_item_fit" : null,
    boardSignalStrong ? "material_core_board_progress" : null,
    carryCopies >= 3 ? "main_carry_copy_progress" : null,
    targetPopulation !== null && level !== null && Number(level) >= Math.max(1, targetPopulation - 1)
      ? "population_window_reachable"
      : null,
  ].filter(Boolean);
  const independentFitCount = [
    metaStrength >= 0.55,
    augmentFit >= 0.55,
    itemFit >= 0.55,
    boardSignalStrong,
  ].filter(Boolean).length;
  const formedCore = durableTargetAligned && (
    (carryBestStar >= 2 && matchedCoreNames.length >= 2)
    || (coreTwoStarCount >= 2 && coreCoverage >= 0.5)
  );

  let state = "observe_only";
  let continuityPriority = 0;
  const hostGuardrails = [
    "stage_readiness_is_a_soft_live_state_assessment_not_a_fixed_fee_table",
    "do_not_create_or_change_durable_target_from_this_assessment_alone",
  ];

  if (formedCore) {
    state = "formed_core_continue";
    continuityPriority = 3;
    hostGuardrails.push("do_not_replace_formed_core_with_unrelated_higher_cost_meta_line");
  } else if (major === null) {
    state = "unknown_stage";
  } else if (major <= 2) {
    if ((carryCost === 1 || carryCost === 2) && boardSignalStrong && carryCopies >= 3 && independentFitCount >= 3) {
      state = "conditional_start";
      continuityPriority = 1;
    } else if (carryCost !== null && carryCost >= 3) {
      state = "future_target";
    }
  } else if (major === 3) {
    if (carryCost !== null && carryCost <= 3 && boardSignalStrong && independentFitCount >= 2) {
      state = durableTargetAligned ? "build_toward" : "conditional_start";
      continuityPriority = durableTargetAligned ? 2 : 1;
    } else if (carryCost !== null && carryCost >= 4) {
      state = carryCopies > 0 && matchedCoreNames.length >= 2 ? "build_toward" : "future_target";
      continuityPriority = state === "build_toward" ? 1 : 0;
    }
  } else if (durableTargetAligned && boardSignalStrong) {
    state = "build_toward";
    continuityPriority = 2;
  } else if (carryCost !== null && carryCost >= 4) {
    const populationReachable = targetPopulation === null
      || level === null
      || Number(level) >= Math.max(1, targetPopulation - 1);
    state = populationReachable && (carryCopies > 0 || matchedCoreNames.length >= 2)
      ? "conditional_start"
      : "future_target";
    continuityPriority = state === "conditional_start" ? 1 : 0;
  } else if (boardSignalStrong && independentFitCount >= 3) {
    state = "conditional_start";
    continuityPriority = 1;
  }

  return {
    schema: "jcc-lineup-candidate-stage-readiness-v1",
    season_neutral: true,
    state,
    continuity_priority: continuityPriority,
    durable_target_aligned: Boolean(durableTargetAligned),
    may_create_durable_target: false,
    archetype,
    main_carry_cost: carryCost,
    target_population: targetPopulation,
    current_stage_round: stageRound || null,
    current_level: numberOrNull(level),
    current_gold: numberOrNull(gold),
    current_hp: numberOrNull(hp),
    evidence: {
      matched_core_count: matchedCoreNames.length,
      core_name_count: coreNames.length,
      core_coverage: Number(coreCoverage.toFixed(3)),
      core_two_star_count: coreTwoStarCount,
      main_carry_copies_equivalent: carryCopies,
      main_carry_best_star: carryBestStar,
      independent_fit_count: independentFitCount,
      signals: evidenceSignals,
    },
    host_guardrails: hostGuardrails,
    score_policy: "readiness constrains interpretation and established-target continuity; it is not a hidden sixth percentage in weighted fit",
  };
}

function planUnits(plan = {}) {
  return [
    ...asArray(plan.units),
    ...asArray(plan.core_units),
    ...asArray(plan.champions),
    ...asArray(plan.carries),
    ...asArrayOrScalar(plan.primary_carry),
    ...asArrayOrScalar(plan.main_carry),
  ].filter((unit) => unit && typeof unit === "object");
}

function inferArchetype(plan, live) {
  const explicit = normalizedArchetype(plan?.archetype || plan?.lineup_archetype || plan?.plan_type);
  if (explicit) return { archetype: explicit, source: "target_plan_explicit" };
  if (plan?.emblem_role || plan?.required_emblem || numberOrNull(plan?.emblem_count) > 0) {
    return { archetype: "emblem_conditioned", source: "target_plan_emblem_condition" };
  }
  const costs = planUnits(plan).map((unit) => numberOrNull(unit.cost ?? unit.tier ?? unit.price)).filter(Number.isFinite);
  const explicitCarryCost = numberOrNull(
    plan?.primary_carry_cost
    ?? plan?.carry_cost
    ?? plan?.primary_carry?.cost
    ?? plan?.main_carry?.cost,
  );
  const carryCost = explicitCarryCost ?? (costs.length ? Math.max(...costs) : null);
  if (carryCost === 1) return { archetype: "one_cost_reroll", source: "primary_carry_cost" };
  if (carryCost === 2) return { archetype: "two_cost_reroll", source: "primary_carry_cost" };
  if (carryCost === 3) return { archetype: "three_cost_reroll", source: "primary_carry_cost" };
  if (carryCost === 4) return { archetype: "four_cost_carry", source: "primary_carry_cost" };
  if (carryCost >= 5) return { archetype: "legendary_cap", source: "primary_carry_cost" };

  const major = stageMajor(live.stage_round);
  const earlyHighCost = live.board_units.find((unit) => (unit.cost || 0) >= 4);
  if (Number.isFinite(major) && major <= 3 && earlyHighCost) {
    return { archetype: "early_high_cost_pivot", source: "early_natural_high_cost_unit" };
  }
  return { archetype: "flex_transition", source: "insufficient_target_identity" };
}

function unitMatchesPlan(unit, plan = {}) {
  const names = new Set([
    ...asArray(plan.unit_names),
    ...asArray(plan.core_unit_names),
    ...planUnits(plan).map((entry) => entry.name),
  ].filter(Boolean).map((name) => String(name).toLowerCase()));
  return names.has(String(unit.name || "").toLowerCase());
}

function primaryCarryName(plan = {}) {
  return String(plan.primary_carry?.name || plan.main_carry?.name || plan.primary_carry_name || "").trim().toLowerCase();
}

function primaryTankName(plan = {}) {
  return String(
    plan.primary_tank?.name
    || plan.main_tank?.name
    || plan.primary_tank_name
    || plan.main_tank_name
    || "",
  ).trim().toLowerCase();
}

function unitMatchesName(unit, names) {
  const unitName = String(unit?.name || "").trim().toLowerCase();
  return Boolean(unitName) && names.some((name) => String(name || "").trim().toLowerCase() === unitName);
}

function sortUnitsByReadiness(units) {
  return [...units].sort((left, right) => (
    (Number(right.star || 0) - Number(left.star || 0))
    || (Number(right.cost || 0) - Number(left.cost || 0))
    || String(left.name || "").localeCompare(String(right.name || ""))
  ));
}

function isFrontlineLike(unit) {
  return /frontline|tank|guardian|defender|warden|bruiser|protector|shield|melee|front/.test(unit.role_text);
}

function isDamageLike(unit) {
  return /carry|damage|backline|marksman|caster|assassin|sniper|artillery|dps|burst|output/.test(unit.role_text);
}

function holderMatchesUnit(item, unit) {
  const holderName = String(item?.holder_name || item?.holder || item?.holder_display_name || "").trim().toLowerCase();
  if (holderName && holderName === String(unit?.name || "").trim().toLowerCase()) return true;
  const holderIds = [
    item?.holder_id,
    item?.holder_base_id,
    item?.holder_champion_address,
    item?.holder_champion_id,
  ].map((value) => String(value ?? "").trim()).filter(Boolean);
  const unitIds = [
    unit?.id,
    unit?.base_id,
    unit?.champion_address,
    unit?.champion_id,
  ].map((value) => String(value ?? "").trim()).filter(Boolean);
  return holderIds.some((id) => unitIds.includes(id));
}

function buildBoardReadiness(live, plan, doctrine) {
  const board = live.board_units;
  const bench = live.bench_units;
  const primaryName = primaryCarryName(plan);
  const tankName = primaryTankName(plan);
  const primaryCarry = primaryName
    ? [...board, ...bench].find((unit) => String(unit.name).toLowerCase() === primaryName)
    : null;
  const mainCarry = primaryCarry
    || sortUnitsByReadiness(board.filter(isDamageLike))[0]
    || sortUnitsByReadiness(bench.filter(isDamageLike))[0]
    || null;
  const mainTank = (tankName
    ? [...board, ...bench].find((unit) => String(unit.name).toLowerCase() === tankName)
    : null)
    || sortUnitsByReadiness(board.filter(isFrontlineLike))[0]
    || sortUnitsByReadiness(bench.filter(isFrontlineLike))[0]
    || null;
  const frontline = board.filter(isFrontlineLike);
  const damageUnits = board.filter(isDamageLike);
  const coreTargetNames = [
    primaryName,
    tankName,
    ...asArray(plan?.core_unit_names),
    ...asArray(plan?.unit_names),
    ...planUnits(plan).map((unit) => unit?.name),
  ].map((name) => String(name || '').trim().toLowerCase()).filter(Boolean);
  const normalizedCoreTargetNames = [...new Set(coreTargetNames)];
  const coreTargetUnits = normalizedCoreTargetNames.length
    ? board.filter((unit) => unitMatchesName(unit, normalizedCoreTargetNames))
    : board.filter((unit) => unit.star >= 2);
  const coreTwoStarCount = coreTargetUnits.filter((unit) => unit.star >= 2).length;
  const coreTargetCount = normalizedCoreTargetNames.length || Math.max(1, Math.min(board.length, 2));
  const coreTwoStarCoverage = clamp01(coreTwoStarCount / Math.max(1, coreTargetCount));
  const twoStarCount = board.filter((unit) => unit.star >= 2).length;
  const targetHits = board.filter((unit) => unitMatchesPlan(unit, plan));
  const completedItemCount = live.equipped_items.length;
  const equippedCounts = new Map();
  for (const unit of board) equippedCounts.set(String(unit.name || '').toLowerCase(), 0);
  for (const item of live.equipped_items) {
    const holder = board.find((unit) => holderMatchesUnit(item, unit));
    if (!holder) continue;
    const key = String(holder.name || '').toLowerCase();
    equippedCounts.set(key, (equippedCounts.get(key) || 0) + 1);
  }
  const mainCarryEquipmentCount = mainCarry ? (equippedCounts.get(String(mainCarry.name || '').toLowerCase()) || 0) : 0;
  const mainTankEquipmentCount = mainTank ? (equippedCounts.get(String(mainTank.name || '').toLowerCase()) || 0) : 0;
  const equippedBoardUnitCount = [...equippedCounts.values()].filter((count) => count > 0).length;
  const populationCoverage = live.level ? clamp01(board.length / Math.max(1, live.level)) : 0;
  const populationGainScore = live.level
    ? clamp01(
      Math.max(0, (live.level - board.length) / Math.max(1, live.level)) * 0.52
      + Math.min(1, bench.length / Math.max(1, live.level)) * 0.24
      + (board.length < live.level ? 0.18 : 0.04),
    )
    : 0;
  const starQuality = board.length
    ? clamp01(board.reduce((sum, unit) => sum + Math.min(3, unit.star), 0) / (board.length * 2.25))
    : 0;
  const frontlineReadiness = frontline.length
    ? clamp01(frontline.reduce((sum, unit) => sum + (unit.star >= 2 ? 1 : 0.55), 0) / Math.max(2, frontline.length) + (mainTank?.star >= 2 ? 0.08 : 0))
    : clamp01(twoStarCount / Math.max(3, board.length));
  const damageReadiness = mainCarry
    ? clamp01((mainCarry.star >= 2 ? 0.65 : 0.32) + Math.min(0.35, completedItemCount * 0.12) + (mainCarryEquipmentCount > 0 ? 0.08 : 0))
    : damageUnits.length
      ? clamp01(damageUnits.reduce((sum, unit) => sum + (unit.star >= 2 ? 0.55 : 0.28), 0) / Math.max(1, damageUnits.length))
      : clamp01(twoStarCount / Math.max(4, board.length));
  const itemCompletion = clamp01(completedItemCount / Math.max(3, board.length ? 6 : 3));
  const equipmentClosureScore = clamp01(
    (mainCarry ? Math.min(1, mainCarryEquipmentCount / 2) * 0.44 : 0.08)
    + (mainTank ? Math.min(1, mainTankEquipmentCount / 2) * 0.32 : 0.06)
    + (equippedBoardUnitCount ? Math.min(1, equippedBoardUnitCount / Math.max(1, Math.min(board.length, 5))) * 0.24 : 0),
  );
  const targetCoverage = plan && Object.keys(plan).length
    ? clamp01(targetHits.length / Math.max(1, asArray(plan.unit_names).length || planUnits(plan).length || 4))
    : 0;
  const mainCarryReady = Boolean(mainCarry && mainCarry.star >= 2);
  const mainTankReady = Boolean(mainTank && mainTank.star >= 2);
  const coreTwoStarDeficit = Math.max(0, coreTargetCount - coreTwoStarCount);
  const faultToleranceScore = clamp01(
    (live.hp === null ? 0.2 : live.hp >= 70 ? 0.3 : live.hp >= 50 ? 0.22 : live.hp >= 30 ? 0.12 : 0.05)
    + (mainTankReady ? 0.2 : 0.08)
    + (coreTwoStarCoverage * 0.18)
    + (populationCoverage >= 1 ? 0.12 : 0.05),
  );
  const immediateUpgradeGainScore = clamp01(
    (coreTwoStarDeficit > 0 ? Math.min(0.36, coreTwoStarDeficit * 0.11) : 0)
    + (populationGainScore * 0.22)
    + (equipmentClosureScore * 0.14)
    + (mainCarryReady ? 0.05 : 0.12)
    + (mainTankReady ? 0.03 : 0.08)
    + (faultToleranceScore < 0.35 ? 0.08 : 0),
  );
  const boardQuality = clamp01(
    populationCoverage * 0.12
    + starQuality * 0.16
    + frontlineReadiness * 0.14
    + damageReadiness * 0.14
    + itemCompletion * 0.05
    + equipmentClosureScore * 0.1
    + targetCoverage * 0.05
    + coreTwoStarCoverage * 0.13
    + faultToleranceScore * 0.08
    + immediateUpgradeGainScore * 0.03,
  );
  const expectedLossDamage = numberOrNull(
    doctrine?.risk_model?.estimated_loss_damage_by_stage?.[String(stageMajor(live.stage_round))],
  ) ?? (stageMajor(live.stage_round) >= 5 ? 14 : stageMajor(live.stage_round) === 4 ? 13 : stageMajor(live.stage_round) === 3 ? 10 : 7);
  const lossBufferRounds = live.hp === null ? null : Math.max(0, Math.floor(live.hp / expectedLossDamage));
  const counts = new Map();
  for (const unit of [...board, ...bench]) {
    const key = `${unit.name}::${unit.star}`;
    const current = counts.get(key) || { name: unit.name, star: unit.star, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  const reliablePairs = [...counts.values()].filter((entry) => entry.star === 1 && entry.count >= 2);
  const pairs = reliablePairs.map(({ name, star, count }) => ({ name, star, count, copies_needed_for_next_star: 3 - count }));
  const carryCopies = numberOrNull(plan?.primary_carry_copies ?? plan?.carry_copies);
  const rollMarginalGain = clamp01(
    Math.min(0.42, pairs.length * 0.11)
    + (coreTwoStarDeficit > 0 ? Math.min(0.18, coreTwoStarDeficit * 0.06) : 0)
    + (!mainCarryReady ? 0.16 : 0)
    + (!mainTankReady ? 0.08 : 0)
    + (carryCopies !== null ? Math.min(0.22, carryCopies / 40) : 0)
    + (populationGainScore * 0.12)
    + (equipmentClosureScore * 0.08)
    + (faultToleranceScore < 0.35 ? 0.08 : 0),
  );
  const readinessConfidence = missingCriticalReadinessEvidence({
    frontline,
    damageUnits,
    primaryCarry,
    mainCarry,
    mainTank,
    live,
    carryCopies,
    pairs,
    normalizedCoreTargetNames,
  }).length >= 3
    ? "low"
    : boardQuality >= 0.58 && faultToleranceScore >= 0.45
      ? "high"
      : "medium";
  const hasReliableImmediateUpgradeEvidence = readinessConfidence !== "low"
    && (pairs.length > 0 || carryCopies !== null || coreTwoStarDeficit > 0);
  const decisionGap = boardQuality < 0.42
    ? "stabilization_gap"
    : immediateUpgradeGainScore >= 0.55 && hasReliableImmediateUpgradeEvidence
      ? "immediate_upgrade_gap"
      : equipmentClosureScore < 0.28
        ? "equipment_closure_gap"
        : populationGainScore >= 0.32
          ? "population_slot_gap"
          : "no_material_gap";
  const explicitNextLevelSpike = planBoolean(plan, "next_level_adds_material_trait", "next_level_adds_key_unit", "next_level_is_power_spike");
  const requiredTargetLevel = planNumber(plan, "target_level", "roll_level", "key_level", "required_level");
  const targetNeedsHigherLevel = requiredTargetLevel !== null && live.level !== null && requiredTargetLevel > live.level;
  const nextLevelValue = explicitNextLevelSpike
    ? "high"
    : targetNeedsHigherLevel || (populationGainScore >= 0.32 && (targetCoverage >= 0.5 || bench.length > 0))
      ? "medium"
      : live.level === null
        ? "unknown"
        : "low";
  return {
    schema: 'jcc-board-readiness-v1',
    estimator_policy: 'own_state_fast_estimate_not_full_combat_simulation',
    board_quality_score: Number(boardQuality.toFixed(3)),
    population_coverage_score: Number(populationCoverage.toFixed(3)),
    population_gain_score: Number(populationGainScore.toFixed(3)),
    frontline_readiness_score: Number(frontlineReadiness.toFixed(3)),
    damage_readiness_score: Number(damageReadiness.toFixed(3)),
    item_completion_score: Number(itemCompletion.toFixed(3)),
    equipment_closure_score: Number(equipmentClosureScore.toFixed(3)),
    target_coverage_score: Number(targetCoverage.toFixed(3)),
    core_two_star_count: coreTwoStarCount,
    core_two_star_coverage_score: Number(coreTwoStarCoverage.toFixed(3)),
    two_star_count: twoStarCount,
    frontline_unit_count: frontline.length,
    completed_item_count: completedItemCount,
    primary_carry: primaryCarry ? { name: primaryCarry.name, cost: primaryCarry.cost, star: primaryCarry.star } : null,
    primary_carry_ready: Boolean(primaryCarry?.star >= 2),
    main_carry: mainCarry ? { name: mainCarry.name, cost: mainCarry.cost, star: mainCarry.star, ready: mainCarryReady, location: board.some((unit) => String(unit.name || '').toLowerCase() === String(mainCarry.name || '').toLowerCase()) ? 'board' : 'bench' } : null,
    main_carry_ready: mainCarryReady,
    main_tank: mainTank ? { name: mainTank.name, cost: mainTank.cost, star: mainTank.star, ready: mainTankReady, location: board.some((unit) => String(unit.name || '').toLowerCase() === String(mainTank.name || '').toLowerCase()) ? 'board' : 'bench' } : null,
    main_tank_ready: mainTankReady,
    upgrade_pairs: pairs,
    roll_marginal_gain_score: Number(rollMarginalGain.toFixed(3)),
    roll_marginal_gain_policy: 'copy_progress_and_immediate_upgrade_proxy_not_shop_odds_simulation',
    immediate_upgrade_gain_score: Number(immediateUpgradeGainScore.toFixed(3)),
    fault_tolerance_score: Number(faultToleranceScore.toFixed(3)),
    readiness_confidence: readinessConfidence,
    decision_gap: decisionGap,
    next_level_value: nextLevelValue,
    expected_loss_damage: expectedLossDamage,
    loss_buffer_rounds: lossBufferRounds,
    can_absorb_two_losses: lossBufferRounds !== null && lossBufferRounds >= 2,
    missing_evidence: missingCriticalReadinessEvidence({
      frontline,
      damageUnits,
      primaryCarry,
      mainCarry,
      mainTank,
      live,
      carryCopies,
      pairs,
      normalizedCoreTargetNames,
    }),
  };
}

function missingCriticalReadinessEvidence({
  frontline,
  damageUnits,
  primaryCarry,
  mainCarry,
  mainTank,
  live,
  carryCopies,
  pairs,
  normalizedCoreTargetNames,
}) {
  return [
    frontline.length || mainTank ? null : 'frontline_role_tags_or_primary_tank',
    damageUnits.length || primaryCarry || mainCarry ? null : 'damage_role_or_primary_carry',
    live.equipped_items.length ? null : 'equipped_item_assignments',
    carryCopies !== null || pairs.length ? null : 'copy_progress_for_roll_marginal_gain',
    normalizedCoreTargetNames.length ? null : 'core_two_star_targets',
    mainTank ? null : 'main_tank_identity',
  ].filter(Boolean);
}
function defaultRollLevel(archetype) {
  return {
    one_cost_reroll: 4,
    two_cost_reroll: 6,
    three_cost_reroll: 7,
    four_cost_carry: 8,
    legendary_cap: 9,
  }[archetype] ?? null;
}

function planBoolean(plan, ...keys) {
  return keys.some((key) => plan?.[key] === true);
}

function planNumber(plan, ...keys) {
  for (const key of keys) {
    const value = numberOrNull(plan?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function buildOverrideSignals({ live, plan, boardReadiness }) {
  const signals = [];
  const contestCount = planNumber(plan, "contest_count", "contested_players");
  const contested = plan?.contested === true || (contestCount !== null && contestCount > 0);
  const targetLevel = planNumber(plan, "target_level", "roll_level", "key_level", "required_level");
  const supportCosts = [
    ...asArray(plan?.required_support_costs),
    ...asArray(plan?.support_unit_costs),
    ...planUnits(plan).filter((unit) => unit?.support === true || unit?.required_for_trait === true).map((unit) => unit.cost),
  ].map(numberOrNull).filter(Number.isFinite);
  const stage = String(live.stage_round || "");

  if (contested) signals.push("contested_pool_or_timing_race");
  if (planBoolean(plan, "must_contest_shop_pool", "level_timing_urgent", "immediate_level_required")) {
    signals.push("explicit_level_timing_urgency");
  }
  if (planBoolean(plan, "next_level_adds_material_trait", "next_level_adds_key_unit", "next_level_is_power_spike")) {
    signals.push("next_level_material_board_spike");
  }
  if (targetLevel !== null && live.level !== null && targetLevel > live.level) {
    signals.push("target_plan_requires_higher_level");
  }
  if (supportCosts.some((cost) => cost >= 4) && live.level !== null && live.level < 8) {
    signals.push("higher_cost_support_required_for_structure");
  }
  if (boardReadiness.loss_buffer_rounds !== null && boardReadiness.loss_buffer_rounds <= 1) {
    signals.push("lethal_or_single_loss_buffer");
  }
  if (boardReadiness.roll_marginal_gain_score >= 0.55) signals.push("high_immediate_roll_marginal_gain");
  if (boardReadiness.board_quality_score < 0.42) signals.push("board_below_stabilization_floor");
  if (/^(3-5|3-6|4-1|4-2)$/.test(stage)) signals.push("major_tempo_window");
  return [...new Set(signals)];
}

function xpAlignment(live, doctrine, overrideSignals = []) {
  const value = live.xp.value;
  const toNext = live.xp.to_next;
  if (![value, toNext].every(Number.isFinite)) return { decision: "unknown", reason: "xp_missing" };
  const gap = Math.max(0, toNext - value);
  const naturalXp = numberOrNull(doctrine?.economy_alignment?.natural_xp_per_round) ?? 2;
  const manualXp = numberOrNull(doctrine?.economy_alignment?.manual_xp_per_purchase) ?? 4;
  if (gap > 0 && gap <= naturalXp && manualXp > gap) {
    const tempoOverrides = overrideSignals.filter((signal) => [
      "contested_pool_or_timing_race",
      "explicit_level_timing_urgency",
      "next_level_material_board_spike",
      "lethal_or_single_loss_buffer",
    ].includes(signal));
    const buyNowEvidence = tempoOverrides.includes("lethal_or_single_loss_buffer")
      || tempoOverrides.includes("explicit_level_timing_urgency")
      || (
        tempoOverrides.includes("contested_pool_or_timing_race")
        && tempoOverrides.includes("next_level_material_board_spike")
      );
    return {
      decision: buyNowEvidence ? "buy_xp_now_for_tempo_override" : "wait_for_natural_xp",
      policy_strength: buyNowEvidence ? "current_match_override" : tempoOverrides.length ? "weak_prior" : "normal_prior",
      gap,
      natural_xp_per_round: naturalXp,
      manual_xp_per_purchase: manualXp,
      avoids_overbuy_xp: manualXp - gap,
      override_signals: tempoOverrides,
      conditional_alternative: tempoOverrides.length && !buyNowEvidence
        ? "buy_xp_now_if_the_level_secures_a_material_board_spike_or_wins_a_contested_timing_race"
        : null,
    };
  }
  return {
    decision: gap === 0 ? "already_at_threshold" : "manual_xp_can_be_evaluated",
    gap,
    natural_xp_per_round: naturalXp,
    manual_xp_per_purchase: manualXp,
  };
}

function lifecycleActions({ archetype, live, plan, boardReadiness, xp, overrideSignals }) {
  const preferred = [];
  const discouraged = [];
  const conditional = [];
  const contested = plan?.contested === true || numberOrNull(plan?.contest_count) > 0;
  const carryCopies = numberOrNull(plan?.primary_carry_copies ?? plan?.carry_copies);
  const stage = String(live.stage_round || "");

  if (archetype === "one_cost_reroll") {
    if ((live.level || 0) <= 4 && (carryCopies === null || carryCopies >= 7)) preferred.push("roll_for_primary_carry_at_level_4");
    preferred.push("preserve_recovery_floor_around_32");
    discouraged.push("push_level_6_before_primary_carry_progress");
  } else if (archetype === "two_cost_reroll") {
    if ((live.level || 0) === 6) preferred.push("slow_roll_above_interest_floor");
    discouraged.push("push_level_7_before_core_progress");
  } else if (archetype === "three_cost_reroll") {
    if ((live.level || 0) === 7 && !boardReadiness.primary_carry_ready) preferred.push("find_primary_carry_two_star_before_greeding");
    preferred.push("reassess_slow_roll_floor_from_contest_and_economy");
    discouraged.push("blind_push_level_8");
    if (overrideSignals.includes("higher_cost_support_required_for_structure")) {
      conditional.push("consider_level_8_before_finishing_three_star_when_higher_cost_support_unlocks_the_board");
      discouraged.push("blind_finish_three_star_without_checking_next_level_board_spike");
    }
  } else if (archetype === "four_cost_carry") {
    if ((live.level || 0) < 8 && contested && stage === "4-1") preferred.push("push_level_8_on_4_1_then_search");
    else if ((live.level || 0) < 8 && (stage === "4-2" || stage > "4-2")) preferred.push("push_level_8_on_4_2_then_search");
    else if ((live.level || 0) < 8) preferred.push("preserve_economy_to_reach_level_8");
    discouraged.push("large_roll_at_level_7_for_two_star_four_cost_without_survival_or_board_upgrade_evidence");
    if (overrideSignals.includes("lethal_or_single_loss_buffer") || overrideSignals.includes("high_immediate_roll_marginal_gain")) {
      conditional.push("spend_at_level_7_for_immediate_board_stabilization_when_waiting_for_8_is_not_survivable");
    }
    if (overrideSignals.includes("lethal_or_single_loss_buffer")) {
      discouraged.push("greed_level_8_without_survival_buffer");
    }
  } else if (archetype === "legendary_cap") {
    preferred.push("push_level_9_only_with_loss_buffer_and_stable_board");
    if (!boardReadiness.can_absorb_two_losses || boardReadiness.board_quality_score < 0.52) preferred.push("stabilize_before_greeding_level_9");
    discouraged.push("greed_level_9_without_loss_buffer");
  } else if (archetype === "emblem_conditioned") {
    preferred.push("validate_emblem_condition_with_current_rankings_and_holder_fit");
    discouraged.push("treat_emblem_as_automatic_commit");
  } else if (archetype === "early_high_cost_pivot") {
    preferred.push("validate_early_high_cost_against_hp_equipment_choices_and_rankings");
    discouraged.push("commit_from_one_early_high_cost_without_fit");
  } else {
    preferred.push("keep_flexible_until_evidence_supports_a_lineup_archetype");
  }

  if (xp.decision === "buy_xp_now_for_tempo_override") {
    preferred.push("buy_xp_now_for_material_tempo_override");
    discouraged.push("wait_for_natural_xp_despite_material_timing_override");
  } else if (xp.decision === "wait_for_natural_xp") {
    preferred.push("avoid_manual_xp_overbuy_when_natural_xp_completes_level");
    discouraged.push("buy_four_xp_for_two_xp_gap_without_tempo_reason");
    if (xp.conditional_alternative) conditional.push(xp.conditional_alternative);
  }
  return {
    preferred_actions: [...new Set(preferred)],
    conditional_actions: [...new Set(conditional)],
    discouraged_actions: [...new Set(discouraged)],
    forbidden_actions: [],
  };
}

function buildConditionalDecision({ archetype, boardReadiness, actions, overrideSignals }) {
  const immediateAction = actions.preferred_actions[0] || "hold_flexible_until_material_evidence_changes";
  const ifSignals = [];
  const exitSignals = [];
  if (overrideSignals.includes("next_level_material_board_spike")) {
    ifSignals.push("if_the_next_level_adds_a_material_trait_or_key_unit_then_level_for_the_spike");
  }
  if (overrideSignals.includes("high_immediate_roll_marginal_gain")) {
    ifSignals.push("if_current_pairs_or_core_copies_can_create_immediate_upgrades_then_spend_a_bounded_amount");
  }
  if (overrideSignals.includes("contested_pool_or_timing_race")) {
    ifSignals.push("if_contest_makes_the_normal_timing_too_slow_then_act_one_window_earlier");
  }
  if (boardReadiness.loss_buffer_rounds !== null && boardReadiness.loss_buffer_rounds <= 1) {
    exitSignals.push("exit_greedy_economy_or_cap_plan_when_only_one_estimated_loss_buffer_remains");
  }
  if (boardReadiness.item_completion_score < 0.2) {
    exitSignals.push("do_not_lock_a_line_when_items_do_not_complete_its_carry_or_frontline_loop");
  }
  if (boardReadiness.target_coverage_score < 0.25 && archetype !== "flex_transition") {
    exitSignals.push("reopen_the_direction_when_target_overlap_stays_low_after_the_next_major_choice");
  }
  return {
    schema: "jcc-conditional-coach-decision-v1",
    default_line: immediateAction,
    why_now: [
      `archetype:${archetype}`,
      `decision_gap:${boardReadiness.decision_gap}`,
      `readiness_confidence:${boardReadiness.readiness_confidence}`,
    ],
    if_signals: [...new Set(ifSignals)].slice(0, 2),
    exit_signals: [...new Set(exitSignals)].slice(0, 2),
    immediate_action: immediateAction,
    output_budget: "one_default_line_up_to_two_material_branches_one_immediate_action",
  };
}

function buildLineupLifecycleContext({ liveState = {}, context = {}, baseRules = null, profileContext = null } = {}) {
  const resolvedProfile = resolveProfileContext(profileContext || context?.__jcc_profile_context || null, baseRules);
  const rules = resolvedProfile.base_game_rules;
  const doctrine = rules.lineup_lifecycle_management || {};
  const live = normalizeLiveState(liveState);
  const normalizedContext = normalizeContext(context);
  const plan = normalizedContext.target_plan || {};
  const formationProfile = formationProfileForPlan(plan);
  const inferred = inferArchetype(plan, live);
  const boardReadiness = buildBoardReadiness(live, plan, doctrine);
  const overrideSignals = buildOverrideSignals({ live, plan, boardReadiness });
  const xp = xpAlignment(live, doctrine, overrideSignals);
  const actions = lifecycleActions({
    archetype: inferred.archetype,
    live,
    plan,
    boardReadiness,
    xp,
    overrideSignals,
  });
  const conditionalDecision = buildConditionalDecision({
    archetype: inferred.archetype,
    boardReadiness,
    actions,
    overrideSignals,
  });
  const formationReadiness = buildFormationReadiness(formationProfile, live, boardReadiness);
  return {
    schema: "jcc-lineup-lifecycle-context-v1",
    season_neutral: true,
    core_profile_id: resolvedProfile.core_profile_id,
    rules_source_fingerprint: resolvedProfile.rules_source_fingerprint,
    profile_source: resolvedProfile.source,
    archetype: inferred.archetype,
    archetype_source: inferred.source,
    default_roll_level: defaultRollLevel(inferred.archetype),
    current_stage_round: live.stage_round || null,
    current_level: live.level,
    current_gold: live.gold,
    current_hp: live.hp,
    contested: plan?.contested === true || numberOrNull(plan?.contest_count) > 0,
    prior_strength: Object.keys(plan).length ? "contextual_prior" : "weak_prior",
    formation_profile: formationProfile,
    formation_readiness: formationReadiness,
    override_signals: overrideSignals,
    xp_alignment: xp,
    board_readiness: boardReadiness,
    conditional_decision: conditionalDecision,
    ...actions,
    host_policy: {
      use_as_guardrail_not_script: true,
      default_levels_are_priors_not_mandates: true,
      discouraged_actions_require_missing_override_evidence: true,
      rankings_and_live_state_can_override_when_evidence_is_explicit: true,
      active_season_mechanics_source: "compiled_active_season_descriptor_only",
      full_combat_simulation: false,
    },
  };
}

export { assessLineupCandidateStageReadiness, buildLineupLifecycleContext };
