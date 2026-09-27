import { normalizeTargetContextAuthority } from "./target-context-resolver.js";

const GOALS = new Set(["safe_top_four", "balanced", "win_first"]);

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function roundScore(value) {
  return Number(clamp01(value).toFixed(4));
}

function finite(value, fallback = null) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function featureSet(profile) {
  return new Set(Array.isArray(profile?.features) ? profile.features : []);
}

function any(set, features) {
  return features.some((feature) => set.has(feature));
}

function add(score, amount) {
  return clamp01(score + amount);
}

function normalizeGoal(value) {
  const goal = String(value || "balanced");
  return GOALS.has(goal) ? goal : "balanced";
}

function normalizeStage(value) {
  const match = String(value || "").match(/(\d+)\s*[-_/]\s*(\d+)/u);
  return match ? { stage: Number(match[1]), round: Number(match[2]), value: `${Number(match[1])}-${Number(match[2])}` } : null;
}

function missingMaterialFields(profile, match) {
  const missing = [];
  for (const field of profile?.required_context_fields || []) {
    if (field === "hp" && finite(match?.hp) === null) missing.push(field);
    else if (field === "gold" && finite(match?.gold) === null) missing.push(field);
    else if (field === "level" && finite(match?.level) === null) missing.push(field);
    else if (field === "board_power_score" && finite(match?.board_power_score) === null) missing.push(field);
    else if (field === "selected_augment_count" && finite(match?.selected_augment_count) === null) missing.push(field);
    else if (field === "stage_round" && !normalizeStage(match?.stage_round)) missing.push(field);
    else if (field === "item_state" && !match?.item_state && !match?.items) missing.push(field);
    else if (field === "unit_copy_progress" && !match?.unit_copy_progress) missing.push(field);
    else if (field === "candidate_lineup_context" && !match?.candidate_lineup_context) missing.push(field);
    else if (field === "owned_units" && !match?.owned_units) missing.push(field);
  }
  return [...new Set(missing)].sort();
}

function staticPotential(features) {
  const axes = {
    immediate_power: 0,
    sustained_power: 0,
    economy_trajectory: 0,
    shop_access: 0,
    leveling_tempo: 0,
    item_economy: 0,
    trait_enablement: 0,
    star_up_progress: 0,
    cap_value: 0,
    flexibility: 0.5,
    variance: 0,
    commitment: 0,
    failure_severity: 0,
    payout_latency: 0,
    reliability: 0.82,
  };
  const combatEffects = [
    "effect.attack_damage", "effect.spell_power", "effect.attack_speed", "effect.mana_gain",
    "effect.armor", "effect.magic_resist", "effect.health", "effect.durability", "effect.damage_amp",
    "effect.damage_reduction", "effect.healing", "effect.shield", "effect.control",
  ];
  const combatCount = combatEffects.filter((feature) => features.has(feature)).length;
  if (features.has("category.combat")) {
    axes.immediate_power = add(axes.immediate_power, 0.48);
    axes.sustained_power = add(axes.sustained_power, 0.42);
  }
  axes.immediate_power = add(axes.immediate_power, Math.min(0.42, combatCount * 0.07));
  axes.sustained_power = add(axes.sustained_power, Math.min(0.48, combatCount * 0.08));
  if (features.has("category.economy") || features.has("effect.economy")) axes.economy_trajectory = add(axes.economy_trajectory, 0.68);
  if (features.has("effect.shop_access")) {
    axes.shop_access = 0.8;
    axes.star_up_progress = add(axes.star_up_progress, 0.25);
  }
  if (any(features, ["effect.leveling", "effect.experience", "effect.team_size"])) {
    axes.leveling_tempo = 0.82;
    axes.cap_value = add(axes.cap_value, 0.28);
  }
  if (any(features, ["effect.item_generation", "effect.item_conversion", "effect.loot"])) {
    axes.item_economy = 0.78;
    axes.cap_value = add(axes.cap_value, 0.2);
  }
  if (features.has("effect.trait_enablement")) {
    axes.trait_enablement = 0.85;
    axes.cap_value = add(axes.cap_value, 0.32);
  }
  if (any(features, ["effect.star_up", "effect.unit_generation"])) {
    axes.star_up_progress = add(axes.star_up_progress, 0.72);
    axes.cap_value = add(axes.cap_value, 0.22);
  }
  if (features.has("delivery.immediate")) axes.immediate_power = add(axes.immediate_power, 0.12);
  if (features.has("delivery.recurring")) {
    axes.sustained_power = add(axes.sustained_power, 0.15);
    axes.cap_value = add(axes.cap_value, 0.1);
  }
  if (features.has("delivery.delayed")) axes.payout_latency = 0.84;
  if (features.has("delivery.milestone")) axes.payout_latency = Math.max(axes.payout_latency, 0.58);
  if (features.has("reliability.guaranteed")) axes.reliability = 0.95;
  if (features.has("reliability.conditional")) axes.reliability -= 0.2;
  if (features.has("reliability.random")) {
    axes.reliability -= 0.16;
    axes.variance = 0.72;
  }
  if (features.has("reliability.choice")) axes.flexibility = add(axes.flexibility, 0.16);
  if (features.has("commitment.universal")) axes.flexibility = add(axes.flexibility, 0.22);
  if (any(features, ["commitment.trait_locked", "commitment.champion_locked"])) {
    axes.commitment = 0.78;
    axes.flexibility -= 0.3;
  } else if (any(features, ["commitment.ad", "commitment.ap", "commitment.frontline", "commitment.reroll", "commitment.fast_level"])) {
    axes.commitment = 0.38;
    axes.flexibility -= 0.12;
  }
  if (features.has("risk.random_variance")) axes.variance = Math.max(axes.variance, 0.72);
  if (features.has("risk.delayed_payout")) axes.payout_latency = Math.max(axes.payout_latency, 0.84);
  if (features.has("risk.lock_in")) axes.commitment = Math.max(axes.commitment, 0.72);
  if (features.has("risk.failure_loss")) axes.failure_severity = 0.88;
  if (features.has("risk.hp_cost")) axes.failure_severity = Math.max(axes.failure_severity, 0.72);
  if (any(features, ["risk.interest_loss", "risk.rule_restriction"])) axes.failure_severity = Math.max(axes.failure_severity, 0.55);
  return Object.fromEntries(Object.entries(axes).map(([key, value]) => [key, roundScore(value)]));
}

function realizationFor(features, potential, match, missing) {
  const hp = clamp01((finite(match?.hp, 60)) / 100);
  const board = clamp01(finite(match?.board_power_score, 0.5));
  const survivalBuffer = clamp01(hp * 0.62 + board * 0.38);
  let conditionReadiness = potential.reliability;
  if (missing.length) conditionReadiness -= Math.min(0.32, missing.length * 0.08);
  if (features.has("delivery.delayed")) conditionReadiness *= 0.35 + survivalBuffer * 0.65;
  if (features.has("condition.requires_gold")) conditionReadiness *= clamp01(finite(match?.gold, 20) / 40);
  if (features.has("condition.requires_hp")) conditionReadiness *= hp;
  if (features.has("condition.requires_board_strength")) conditionReadiness *= board;
  if (features.has("rule_change.augment_tier") || features.has("condition.requires_future_augment_slot")) {
    const selectedCount = finite(match?.selected_augment_count, null);
    const stage = normalizeStage(match?.stage_round);
    const futureSlotAvailable = selectedCount !== null
      ? selectedCount < 2
      : stage ? stage.stage < 4 || (stage.stage === 4 && stage.round < 2) : false;
    conditionReadiness *= futureSlotAvailable ? 1 : 0.08;
  }
  const risk = clamp01(
    potential.variance * 0.24
    + potential.commitment * 0.2
    + potential.failure_severity * 0.24
    + potential.payout_latency * (1 - survivalBuffer) * 0.72,
  );
  return {
    hp_readiness: roundScore(hp),
    board_readiness: roundScore(board),
    condition_readiness: roundScore(conditionReadiness),
    realization_score: roundScore(conditionReadiness * (1 - potential.payout_latency * (1 - survivalBuffer) * 0.55)),
    risk_score: roundScore(risk),
  };
}

function lineupContextScore(authority, decision, potential) {
  const suppliedFit = clamp01(finite(decision?.lineup_fit, 0.5));
  const coverage = clamp01(finite(decision?.candidate_coverage, potential.flexibility));
  if (authority === "current_turn_instruction" || authority === "current_turn_replacement") return suppliedFit * 0.88 + coverage * 0.12;
  if (authority === "durable_target_plan") return suppliedFit * 0.78 + coverage * 0.22;
  if (authority === "provisional_user_intent") return suppliedFit * 0.38 + coverage * 0.62;
  return potential.flexibility;
}

export function evaluateAugmentChoiceCandidate({ candidate = {}, profile = null, match = {}, decision = {} } = {}) {
  if (!profile || profile.schema !== "jcc-augment-semantic-profile-v1") {
    return {
      candidate_ref: String(candidate?.id ?? candidate?.augment_id ?? candidate?.name ?? "unknown"),
      name: candidate?.name || null,
      resolution_status: "unresolved_active_core_profile",
      category_source: "unresolved",
      objective_scores: null,
      axis_scores: null,
      recommendation_score: 0,
      missing_fields: ["active_core_augment_profile"],
      confidence: 0,
    };
  }
  const features = featureSet(profile);
  const potential = staticPotential(features);
  const missing = missingMaterialFields(profile, match);
  const realization = realizationFor(features, potential, match, missing);
  const authority = normalizeTargetContextAuthority(decision?.target_context_authority);
  const lineupFit = lineupContextScore(authority, decision, potential);
  const stabilization = clamp01(
    potential.immediate_power * 0.55
    + potential.sustained_power * 0.2
    + potential.shop_access * 0.1
    + potential.item_economy * 0.08
    + potential.leveling_tempo * 0.07,
  );
  const growth = clamp01(
    potential.economy_trajectory * 0.24
    + potential.leveling_tempo * 0.2
    + potential.item_economy * 0.15
    + potential.trait_enablement * 0.12
    + potential.star_up_progress * 0.12
    + potential.cap_value * 0.17,
  );
  const axisScores = {
    ...potential,
    stabilization_score: roundScore(stabilization),
    growth_score: roundScore(growth),
    lineup_fit_score: roundScore(lineupFit),
    candidate_coverage_score: roundScore(finite(decision?.candidate_coverage, potential.flexibility)),
    condition_readiness_score: realization.condition_readiness,
    realization_score: realization.realization_score,
    risk_score: realization.risk_score,
  };
  const top4Fit = clamp01(
    stabilization * 0.36
    + realization.realization_score * 0.2
    + potential.flexibility * 0.14
    + lineupFit * 0.16
    + growth * 0.14
    - realization.risk_score * 0.28,
  );
  const firstFit = clamp01(
    growth * 0.34
    + potential.cap_value * 0.2
    + lineupFit * 0.18
    + realization.realization_score * 0.16
    + potential.flexibility * 0.12
    - realization.risk_score * 0.16,
  );
  const goal = normalizeGoal(decision?.goal);
  const recommendation = goal === "safe_top_four"
    ? top4Fit * 0.76 + firstFit * 0.24
    : goal === "win_first"
      ? top4Fit * 0.32 + firstFit * 0.68
      : top4Fit * 0.54 + firstFit * 0.46;
  const evidenceConfidence = profile.feature_evidence?.length
    ? profile.feature_evidence.reduce((sum, entry) => sum + (entry.confidence === "high" ? 1 : entry.confidence === "medium" ? 0.72 : 0.45), 0) / profile.feature_evidence.length
    : 0.5;
  return {
    candidate_ref: String(candidate?.id ?? candidate?.augment_id ?? profile.augment_id),
    slot: finite(candidate?.slot, null),
    name: candidate?.name || profile.name || null,
    resolution_status: "resolved_active_core_profile",
    category_source: "active_core_profile",
    target_context_authority: authority,
    goal,
    objective_scores: {
      top4_objective_fit: roundScore(top4Fit),
      first_objective_fit: roundScore(firstFit),
      derived_not_observed: true,
    },
    axis_scores: axisScores,
    recommendation_score: roundScore(recommendation),
    missing_fields: missing,
    confidence: roundScore(evidenceConfidence * (1 - Math.min(0.35, missing.length * 0.08))),
    policy: {
      supporting_evidence_for_host: true,
      not_top4_or_first_probability: true,
      lineup_compatibility_counted_once: true,
      lineup_baseline_must_exclude_existing_augment_fit: true,
      ranking_unavailable_allows_core_only_evaluation: true,
    },
  };
}

export function rankAugmentChoiceCandidates(candidates = [], context = {}) {
  const rows = candidates.map((entry, index) => evaluateAugmentChoiceCandidate({
    candidate: { ...(entry?.candidate || entry), slot: entry?.candidate?.slot ?? entry?.slot ?? index },
    profile: entry?.profile || null,
    match: context.match || {},
    decision: { ...(context.decision || {}), ...(entry?.decision || {}) },
  }));
  return rows.sort((left, right) => (
    right.recommendation_score - left.recommendation_score
    || right.confidence - left.confidence
    || finite(left.slot, Number.MAX_SAFE_INTEGER) - finite(right.slot, Number.MAX_SAFE_INTEGER)
    || left.candidate_ref.localeCompare(right.candidate_ref)
  ));
}

export { GOALS as AUGMENT_CHOICE_GOALS };
