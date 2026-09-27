function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function addCostWeight(weights, cost, weight) {
  const normalizedCost = numberOrNull(cost);
  const normalizedWeight = numberOrNull(weight);
  if (normalizedCost === null || normalizedWeight === null || normalizedWeight <= 0) return;
  const key = String(clamp(Math.round(normalizedCost), 1, 5));
  weights[key] = Number(((weights[key] || 0) + normalizedWeight).toFixed(3));
}

function unitPlanWeight(unit, fallbackWeight) {
  const explicit = numberOrNull(unit?.strategy_weight ?? unit?.weight ?? unit?.value_weight);
  if (explicit !== null) return explicit;
  const roleText = String(unit?.role || unit?.tag || unit?.tags || "").toLowerCase();
  if (unit?.is_core || unit?.core || roleText.includes("carry") || roleText.includes("core") || roleText.includes("主c") || roleText.includes("核心")) return 1.25;
  return fallbackWeight;
}

function resolveUnitCost(unit, tables = {}) {
  const explicit = numberOrNull(unit?.cost || unit?.tier || unit?.price);
  if (explicit !== null) return explicit;
  const byId = tables.champion_cost_index?.by_id || {};
  const byName = tables.champion_cost_index?.by_name || {};
  const ids = [unit?.id, unit?.champion_id, unit?.hero_id, unit?.base_id].filter((value) => value !== undefined && value !== null);
  for (const id of ids) {
    const cost = numberOrNull(byId[String(id)]);
    if (cost !== null) return cost;
  }
  const names = [unit?.name, unit?.champion_name, unit?.hero_name, unit?.normalized_name].filter(Boolean);
  for (const name of names) {
    const cost = numberOrNull(byName[String(name)]);
    if (cost !== null) return cost;
  }
  return null;
}

function collectRankingHeroes(context) {
  return [
    ...asArray(context.live_rankings?.top_heroes),
    ...asArray(context.live_rankings_context?.top_heroes),
    ...asArray(context.live_rankings?.signals?.top_heroes),
    ...asArray(context.live_rankings_context?.signals?.top_heroes),
    ...asArray(context.live_rankings?.route_contexts?.full_planning?.signals?.top_heroes),
    ...asArray(context.live_rankings_context?.route_contexts?.full_planning?.signals?.top_heroes),
    ...Object.values(context.live_rankings?.tiers || {}).flatMap((tier) => asArray(tier?.top_heroes)),
    ...Object.values(context.live_rankings_context?.tiers || {}).flatMap((tier) => asArray(tier?.top_heroes)),
  ];
}

function targetCostWeights(context, tables = {}) {
  const weights = {};
  const regularUnits = [
    ...asArray(context.target_plan?.units),
    ...asArray(context.target_plan?.champions),
  ];
  const coreUnits = asArray(context.target_plan?.core_units);

  for (const unit of regularUnits) {
    addCostWeight(weights, resolveUnitCost(unit, tables), unitPlanWeight(unit, 0.55));
  }
  for (const unit of coreUnits) {
    addCostWeight(weights, resolveUnitCost(unit, tables), unitPlanWeight(unit, 1.25));
  }

  const rankingHeroes = collectRankingHeroes(context)
    .map((hero) => {
      const cost = numberOrNull(hero?.cost || hero?.tier || hero?.price);
      const signal = numberOrNull(hero?.signal_score ?? hero?.score ?? hero?.top4_rate ?? hero?.use_rate) ?? 0;
      return cost !== null ? { cost, signal } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.signal - left.signal)
    .slice(0, 12);

  for (const hero of rankingHeroes) {
    addCostWeight(weights, hero.cost, clamp(hero.signal, 0.05, 1) * 0.8);
  }

  return weights;
}

function interestForGold(gold) {
  if (!Number.isFinite(gold)) return null;
  return Math.floor(Math.min(Math.max(gold, 0), 50) / 10);
}

function targetCostProfile(context, tables = {}) {
  const units = [
    ...asArray(context.target_plan?.units),
    ...asArray(context.target_plan?.core_units),
    ...asArray(context.target_plan?.champions),
  ];
  const costs = units.map((unit) => resolveUnitCost(unit, tables)).filter((value) => value !== null);
  const rankingHeroes = collectRankingHeroes(context);
  const rankingCosts = rankingHeroes
    .map((hero) => {
      const cost = numberOrNull(hero?.cost || hero?.tier || hero?.price);
      const signal = numberOrNull(hero?.signal_score ?? hero?.score ?? hero?.top4_rate ?? hero?.use_rate) ?? 0;
      return cost !== null ? { cost, signal } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.signal - left.signal)
    .slice(0, 8)
    .map((row) => row.cost);
  const explicitTargetLevel = numberOrNull(context.target_plan?.target_level ?? context.target_plan?.roll_level ?? context.target_plan?.key_level);
  const maxPlanCost = costs.length ? Math.max(...costs) : null;
  const maxRankingCost = rankingCosts.length ? Math.max(...rankingCosts) : null;
  const maxCost = Math.max(maxPlanCost || 0, maxRankingCost || 0) || null;
  const costWeights = targetCostWeights(context, tables);
  const inferredTargetLevel = explicitTargetLevel
    ?? (maxCost >= 5 ? 9 : maxCost === 4 ? 8 : maxCost === 3 ? 7 : maxCost === 2 ? 6 : null);
  return {
    max_core_cost: maxCost,
    max_plan_cost: maxPlanCost,
    max_ranking_cost: maxRankingCost,
    cost_weights: costWeights,
    weighted_core_cost: Object.entries(costWeights).length
      ? Number((Object.entries(costWeights).reduce((sum, [cost, weight]) => sum + Number(cost) * weight, 0)
        / Object.values(costWeights).reduce((sum, weight) => sum + weight, 0)).toFixed(3))
      : null,
    target_level: inferredTargetLevel,
    source: explicitTargetLevel
      ? "target_plan_explicit"
      : maxPlanCost && maxRankingCost
        ? "mixed_target_plan_and_live_rankings"
        : maxRankingCost
          ? "live_rankings_cost_inferred"
          : maxPlanCost
            ? "target_plan_core_cost_inferred"
            : "unknown",
  };
}

function shopPoolValue(level, context, tables) {
  const odds = asArray(tables.shop_odds_by_level?.[String(level)] || tables.shop_odds_by_level?.[level]);
  if (!odds.length) return 0;
  const profile = targetCostProfile(context, tables);
  const costWeights = profile.cost_weights || {};
  const totalWeight = Object.values(costWeights).reduce((sum, weight) => sum + weight, 0);
  if (totalWeight > 0) {
    const weighted = Object.entries(costWeights).reduce((sum, [cost, weight]) => {
      const costIndex = clamp(Number(cost), 1, 5) - 1;
      return sum + (odds[costIndex] || 0) * weight;
    }, 0) / totalWeight;
    return Number(weighted.toFixed(3));
  }
  if (!profile.max_core_cost) {
    return Number((odds[3] * 0.55 + odds[4] * 0.9 + odds[2] * 0.2).toFixed(3));
  }
  const targetIndex = clamp(profile.max_core_cost, 1, 5) - 1;
  return Number(((odds[targetIndex] || 0) + (odds[targetIndex + 1] || 0) * 0.35).toFixed(3));
}

function actionEnvelope(action) {
  return {
    ...action,
    score: Number((action.score || 0).toFixed(3)),
    confidence: action.confidence || "medium",
  };
}

function resourcePolicySummary(xpPolicy = {}) {
  return {
    can_buy_xp: xpPolicy.can_buy_xp !== false,
    manual_xp_per_click: xpPolicy.manual_xp_per_click,
    manual_xp_gold_cost: xpPolicy.manual_xp_gold_cost,
    natural_xp_per_round: xpPolicy.natural_xp_per_round,
    shop_refresh_xp_gain: xpPolicy.shop_refresh_xp_gain ?? null,
    post_player_combat_xp_win: xpPolicy.post_player_combat_xp_win ?? null,
    post_player_combat_xp_loss: xpPolicy.post_player_combat_xp_loss ?? null,
    player_combat_start_xp_gain: xpPolicy.player_combat_start_xp_gain ?? null,
    per_round_xp_gain: xpPolicy.per_round_xp_gain ?? null,
    on_level_up_rewards: xpPolicy.on_level_up_rewards ?? null,
    modifiers: asArray(xpPolicy.modifiers).map((modifier) => modifier.key).filter(Boolean),
  };
}

function addMissingFact(missing, field, reason) {
  if (!field || missing.some((entry) => entry.field === field)) return;
  missing.push({ field, reason });
}

function economyDecisionFacts({ live, context, xpPolicy }) {
  const missing = [];
  const available = [];
  const boardUnits = asArray(live.board_units);
  const benchUnits = asArray(live.bench_units);
  const shopUnits = asArray(live.shop_units);
  const selectedAugments = asArray(live.selected_augments);
  const targetPlan = context.target_plan || null;
  const userMemory = context.user_memory || {};
  const latestIntent = userMemory.latest_user_intent || userMemory.latest_intent || null;
  const choiceConfirmations = asArray(userMemory.choice_confirmations);
  const matchVariables = context.match_variables || {};
  const items = context.root?.items || context.root?.equipment || context.items || context.equipment || {};
  const itemBench = [
    ...asArray(items.item_bench),
    ...asArray(items.inventory),
    ...asArray(items.components),
  ];
  const equippedItems = [
    ...asArray(items.equipped_items),
    ...asArray(items.trusted_equipped_items),
    ...asArray(items.unit_equipment),
  ];

  if (Number.isFinite(live.economy.hp)) available.push("hp");
  else addMissingFact(missing, "hp", "HP pressure can overturn hold/greed versus stabilize decisions.");

  if (live.phase.stage_round) available.push("stage_round");
  else addMissingFact(missing, "stage_round", "Stage decides whether level, prelevel, or roll timing is urgent.");

  if (live.economy.xp?.source || Number.isFinite(live.economy.xp?.value)) available.push("xp");

  if (boardUnits.length) available.push("own_board_units");
  else addMissingFact(missing, "own_board_units", "Board quality and open slots decide whether leveling creates real strength.");

  if (benchUnits.length) available.push("bench_units");
  else addMissingFact(missing, "bench_units", "Pairs and near-upgrades decide whether spending beats holding interest.");

  if (shopUnits.length) available.push("shop_units");
  else addMissingFact(missing, "shop_units", "Current shop upgrades can make a buy/sell interest decision urgent.");

  if (Number.isFinite(numberOrNull(live.economy.streak))) available.push("streak");
  else addMissingFact(missing, "streak", "Win/loss streak value can justify breaking or protecting interest.");

  if (selectedAugments.length || choiceConfirmations.length) available.push("confirmed_choices");
  else addMissingFact(missing, "confirmed_choices", "Confirmed augments or descriptor-owned season choices can change interest cap, XP policy, tempo, and line commitment.");

  if (itemBench.length || equippedItems.length) available.push("equipment_facts");
  else addMissingFact(missing, "equipment_facts", "Component/item fit decides whether a level or roll converts into actual combat strength.");

  if (targetPlan || latestIntent) available.push("user_target_or_latest_intent");
  else addMissingFact(missing, "user_target_or_latest_intent", "User target line changes whether to greed for level, roll for reroll, or pivot.");

  if (matchVariables && Object.keys(matchVariables).length) available.push("match_variables");
  else addMissingFact(missing, "match_variables", "Descriptor-owned season mechanics may change baseline economy assumptions.");

  const policyModifiers = asArray(xpPolicy?.modifiers);
  if (policyModifiers.length) available.push("resource_policy_modifiers");

  return {
    schema: "jcc-economy-decision-facts-v1",
    available,
    missing_decision_facts: missing,
    model_must_check: [
      "whether the current board can actually win or save enough HP",
      "whether shop/bench pairs create immediate strength without wasting future economy",
      "whether components/equipped items fit the intended line or a data-backed pivot",
      "whether confirmed augments or descriptor-owned season choices change XP, interest cap, rewards, or tempo",
      "whether latest user intent should be followed, held conditionally, or challenged with big-data evidence",
      "whether scouting/contest information is missing and would materially change a level-8/level-9 or reroll decision",
    ],
    authority: "These facts tell the host model what to evaluate. Numeric action scores are heuristic candidates, not final advice.",
  };
}

function scoreEconomyActions({ live, context, tables, xpPolicy, xpToNext }) {
  const level = live.economy.level;
  const gold = live.economy.gold;
  const hp = live.economy.hp;
  const xpValue = live.economy.xp.value;
  const needToNext = Math.max(0, xpToNext - xpValue);
  const clickXp = xpPolicy.manual_xp_per_click;
  const clickCost = xpPolicy.manual_xp_gold_cost;
  const canBuyXp = xpPolicy.can_buy_xp !== false;
  const clicksToLevelNow = needToNext === 0 ? 0 : Math.ceil(needToNext / clickXp);
  const goldToLevelNow = clicksToLevelNow * clickCost;
  const goldAfterLevelNow = gold - goldToLevelNow;
  const currentInterest = interestForGold(gold);
  const decisionFacts = economyDecisionFacts({ live, context, xpPolicy });
  const interestAfterLevelNow = interestForGold(goldAfterLevelNow);
  const interestLossLevelNow = Math.max(0, (currentInterest ?? 0) - (interestAfterLevelNow ?? 0));
  const naturalXp = xpPolicy.natural_xp_per_round;
  const prelevelNeed = Math.max(0, needToNext - naturalXp);
  const clicksToPrelevel = prelevelNeed === 0 ? 0 : Math.ceil(prelevelNeed / clickXp);
  const prelevelLandingXp = xpValue + clicksToPrelevel * clickXp;
  const canPrelevel = prelevelLandingXp < xpToNext && prelevelLandingXp + naturalXp >= xpToNext;
  const goldToPrelevel = clicksToPrelevel * clickCost;
  const goldAfterPrelevel = gold - goldToPrelevel;
  const interestAfterPrelevel = interestForGold(goldAfterPrelevel);
  const interestLossPrelevel = Math.max(0, (currentInterest ?? 0) - (interestAfterPrelevel ?? 0));
  const currentPoolValue = shopPoolValue(level, context, tables);
  const nextPoolValue = shopPoolValue(level + 1, context, tables);
  const targetPoolGain = Number(Math.max(0, nextPoolValue - currentPoolValue).toFixed(3));
  const rollEquivalentValue = Number((targetPoolGain * 10).toFixed(2));
  const hpRisk = hp === null ? 0.4 : hp <= 35 ? 0.95 : hp <= 55 ? 0.68 : hp <= 75 ? 0.42 : 0.22;
  const boardUnderfilled = live.board_units.length < level;
  const targetProfile = targetCostProfile(context, tables);
  const targetLevelPressure = targetProfile.target_level && level < targetProfile.target_level ? clamp((targetProfile.target_level - level) / 3, 0, 1) : 0;
  const actions = [];

  actions.push(actionEnvelope({
    action: "hold_gold_interest",
    gold_after: gold,
    interest_after: currentInterest,
    interest_loss: 0,
    score: 0.35 + (currentInterest >= 5 ? 0.18 : 0) - hpRisk * 0.18 - targetLevelPressure * 0.12,
    evidence: ["preserves_interest"],
  }));

  if (canBuyXp && canPrelevel && goldAfterPrelevel >= 0) {
    actions.push(actionEnvelope({
      action: "prelevel_next_round",
      clicks: clicksToPrelevel,
      gold_cost: goldToPrelevel,
      gold_after: goldAfterPrelevel,
      interest_after: interestAfterPrelevel,
      interest_loss: interestLossPrelevel,
      landing_xp: `${prelevelLandingXp}/${xpToNext}`,
      next_round_level: level + 1,
      next_shop_pool_level: level + 1,
      roll_equivalent_value: rollEquivalentValue,
      target_pool_gain: targetPoolGain,
      score: 0.45 + targetPoolGain * 1.8 + rollEquivalentValue * 0.08 + targetLevelPressure * 0.2 - interestLossPrelevel * 0.08 - hpRisk * 0.08,
      evidence: ["natural_xp_finishes_next_level", "preserves_more_gold_than_level_now"],
    }));
  }

  if (canBuyXp && goldAfterLevelNow >= 0) {
    actions.push(actionEnvelope({
      action: "level_now_no_roll",
      clicks: clicksToLevelNow,
      gold_cost: goldToLevelNow,
      gold_after: goldAfterLevelNow,
      interest_after: interestAfterLevelNow,
      interest_loss: interestLossLevelNow,
      landing_level: level + 1,
      landing_xp_overflow: Math.max(0, xpValue + clicksToLevelNow * clickXp - xpToNext),
      next_shop_pool_level: level + 1,
      roll_equivalent_value: rollEquivalentValue,
      target_pool_gain: targetPoolGain,
      score: 0.38 + hpRisk * 0.22 + targetPoolGain * 1.6 + targetLevelPressure * 0.2 + (boardUnderfilled ? 0.08 : 0) - interestLossLevelNow * 0.1,
      evidence: ["immediate_level", boardUnderfilled ? "board_can_add_unit" : "level_for_shop_pool"],
    }));
  }

  if (canBuyXp && goldAfterLevelNow >= 2) {
    const goldAfter = goldAfterLevelNow - 2;
    const interestLoss = Math.max(0, (currentInterest ?? 0) - (interestForGold(goldAfter) ?? 0));
    actions.push(actionEnvelope({
      action: "level_then_roll_small",
      clicks: clicksToLevelNow,
      gold_cost: goldToLevelNow + 2,
      gold_after: goldAfter,
      interest_after: interestForGold(goldAfter),
      interest_loss: interestLoss,
      roll_count: 1,
      next_shop_pool_level: level + 1,
      target_pool_gain: targetPoolGain,
      score: 0.34 + hpRisk * 0.25 + targetPoolGain * 1.7 + targetLevelPressure * 0.15 - interestLoss * 0.11,
      evidence: ["buys_one_high_level_shop"],
    }));
  }

  if (hpRisk >= 0.65 && gold >= 20) {
    const rollBudget = Math.min(20, Math.max(0, gold - 10));
    const goldAfter = Math.max(0, gold - rollBudget);
    actions.push(actionEnvelope({
      action: "roll_down_stabilize",
      gold_after: goldAfter,
      roll_budget: rollBudget,
      interest_loss: Math.max(0, (currentInterest ?? 0) - interestForGold(goldAfter)),
      score: 0.42 + hpRisk * 0.36 - targetPoolGain * 0.15,
      evidence: ["hp_risk_high"],
    }));
  }

  return {
    actions: actions.sort((left, right) => right.score - left.score),
    decision_facts: decisionFacts,
    math: {
      need_to_next_level: needToNext,
      natural_xp_per_round: naturalXp,
      manual_xp_per_click: clickXp,
      manual_xp_gold_cost: clickCost,
      can_buy_xp: canBuyXp,
      shop_refresh_xp_gain: xpPolicy.shop_refresh_xp_gain ?? null,
      post_player_combat_xp_win: xpPolicy.post_player_combat_xp_win ?? null,
      post_player_combat_xp_loss: xpPolicy.post_player_combat_xp_loss ?? null,
      player_combat_start_xp_gain: xpPolicy.player_combat_start_xp_gain ?? null,
      per_round_xp_gain: xpPolicy.per_round_xp_gain ?? null,
      resource_policy: resourcePolicySummary(xpPolicy),
      clicks_to_level_now: clicksToLevelNow,
      gold_to_level_now: goldToLevelNow,
      clicks_to_prelevel_next_round: canPrelevel ? clicksToPrelevel : null,
      gold_to_prelevel_next_round: canPrelevel ? goldToPrelevel : null,
      can_prelevel: canPrelevel,
      target_profile: targetProfile,
      current_shop_pool_value: currentPoolValue,
      next_shop_pool_value: nextPoolValue,
      target_pool_gain: targetPoolGain,
    },
  };
}

export { interestForGold, scoreEconomyActions, shopPoolValue, targetCostProfile };
