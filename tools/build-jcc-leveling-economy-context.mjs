import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildStrategyTables } from "./build-jcc-strategy-tables.mjs";
import { interestForGold, scoreEconomyActions, targetCostProfile } from "./score-jcc-economy-actions.mjs";
import { buildLineupLifecycleContext } from "./build-jcc-lineup-lifecycle-context.mjs";

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-leveling-economy-context.mjs --live-state <file> [--context <file>] [--out <file>]",
    "",
    "Builds fast per-turn leveling/economy math from live_state + variable XP policy.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--context") options.context = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file, fallback = null) {
  if (!file || !existsSync(file)) return fallback;
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeXp(rawXp) {
  if (rawXp && typeof rawXp === "object" && !Array.isArray(rawXp)) {
    const value = numberOrNull(firstDefined(rawXp.value, rawXp.current, rawXp.xp));
    const toNext = numberOrNull(firstDefined(rawXp.to_next, rawXp.toNext, rawXp.next, rawXp.candidates?.xp_to_next));
    return {
      value,
      to_next: toNext,
      display: rawXp.display || rawXp.candidates?.display || (value !== null && toNext !== null ? `${value}/${toNext}` : null),
      source: rawXp.source || rawXp.provenance?.source || null,
      confidence: numberOrNull(rawXp.confidence ?? rawXp.provenance?.confidence),
    };
  }
  return {
    value: numberOrNull(rawXp),
    to_next: null,
    display: rawXp === undefined || rawXp === null ? null : String(rawXp),
    source: null,
    confidence: null,
  };
}

function collectLiveState(raw) {
  const root = raw.live_state || raw;
  const economy = root.economy || root.player?.economy || {};
  const phase = root.phase || root.round || {};
  const board = root.board || root.own_board || {};
  const bench = root.bench || root.own_bench || {};
  const shop = root.shop || {};
  return {
    match_session_id: root.match_session_id || raw.match_session_id || null,
    phase: {
      stage_round: firstDefined(phase.stage_round, phase.stageRound, phase.round_key, root.stage_round, null),
      status: firstDefined(phase.status, phase.s, root.status, null),
    },
    economy: {
      gold: numberOrNull(firstDefined(economy.gold, economy.money)),
      hp: numberOrNull(firstDefined(economy.hp, economy.health, economy.life)),
      level: numberOrNull(firstDefined(economy.level, economy.lv)),
      xp: normalizeXp(firstDefined(economy.xp, economy.exp)),
      streak: numberOrNull(firstDefined(economy.streak, economy.win_streak, economy.loss_streak, root.streak)),
    },
    board_units: asArray(firstDefined(board.board_units, board.units, root.board_units)),
    bench_units: asArray(firstDefined(bench.bench_units, bench.units, root.bench_units)),
    shop_units: asArray(firstDefined(shop.shop_units, shop.units, root.shop_units)),
    selected_augments: asArray(firstDefined(root.augments?.selected_augments, root.augments?.selected, root.selected_augments)),
    match_variables: root.match_variables || {},
  };
}

function normalizeContext(raw = {}) {
  const root = raw.context || raw;
  return {
    root,
    target_plan: root.target_plan || root.strategy?.target_plan || root.current_plan || null,
    live_rankings_context: root.live_rankings_context || {},
    runtime_user_settings: root.runtime_user_settings || root.user_settings || {},
    match_variables: root.match_variables || {},
    user_memory: root.user_memory || {},
  };
}

function textBlob(...values) {
  return values.map((value) => JSON.stringify(value || "")).join(" ").toLowerCase();
}

function policyWithModifiers({ live, context, tables }) {
  const matchVariables = {
    ...(context.match_variables || {}),
    ...(live.match_variables || {}),
  };
  const explicit = matchVariables.xp_policy || context.root?.xp_policy || context.target_plan?.xp_policy || {};
  const policy = {
    natural_xp_per_round: numberOrNull(explicit.natural_xp_per_round) ?? tables.leveling_rules.natural_xp_per_round,
    manual_xp_per_click: numberOrNull(explicit.manual_xp_per_click) ?? tables.leveling_rules.manual_xp_per_click,
    manual_xp_gold_cost: numberOrNull(explicit.manual_xp_gold_cost) ?? tables.leveling_rules.manual_xp_gold_cost,
    source: Object.keys(explicit).length ? "user_confirmed_or_match_variable" : tables.leveling_rules.source,
    modifiers: [],
    uncertainty: [],
  };

  const confirmedModifiers = [
    ...asArray(explicit.modifiers),
    ...asArray(matchVariables.xp_policy_modifiers),
  ];
  for (const modifier of confirmedModifiers) {
    if (!modifier || typeof modifier !== "object") continue;
    const patch = modifier.patch || modifier;
    const nextXp = numberOrNull(patch.manual_xp_per_click);
    const nextCost = numberOrNull(patch.manual_xp_gold_cost);
    const nextNatural = numberOrNull(patch.natural_xp_per_round);
    const nextXpToNextDelta = numberOrNull(patch.xp_to_next_delta);
    const xpPerClickDelta = numberOrNull(patch.manual_xp_per_click_delta);
    const xpGoldCostDelta = numberOrNull(patch.manual_xp_gold_cost_delta);
    const canBuyXp = patch.can_buy_xp;
    const shopRefreshXpGain = numberOrNull(patch.shop_refresh_xp_gain);
    const postCombatXpWin = numberOrNull(patch.post_player_combat_xp_win);
    const postCombatXpLoss = numberOrNull(patch.post_player_combat_xp_loss);
    const combatStartXpGain = numberOrNull(patch.player_combat_start_xp_gain);
    const perRoundXpGain = numberOrNull(patch.per_round_xp_gain);
    if (nextXp !== null) policy.manual_xp_per_click = nextXp;
    if (xpPerClickDelta !== null) policy.manual_xp_per_click = Math.max(0, policy.manual_xp_per_click + xpPerClickDelta);
    if (nextCost !== null) policy.manual_xp_gold_cost = nextCost;
    if (xpGoldCostDelta !== null) policy.manual_xp_gold_cost = Math.max(0, policy.manual_xp_gold_cost + xpGoldCostDelta);
    if (nextNatural !== null) policy.natural_xp_per_round = nextNatural;
    if (nextXpToNextDelta !== null) policy.xp_to_next_delta = (numberOrNull(policy.xp_to_next_delta) ?? 0) + nextXpToNextDelta;
    if (canBuyXp === false) policy.can_buy_xp = false;
    if (shopRefreshXpGain !== null) policy.shop_refresh_xp_gain = shopRefreshXpGain;
    if (postCombatXpWin !== null) policy.post_player_combat_xp_win = postCombatXpWin;
    if (postCombatXpLoss !== null) policy.post_player_combat_xp_loss = postCombatXpLoss;
    if (combatStartXpGain !== null) policy.player_combat_start_xp_gain = combatStartXpGain;
    if (perRoundXpGain !== null) policy.per_round_xp_gain = perRoundXpGain;
    if (modifier.on_level_up_rewards) policy.on_level_up_rewards = modifier.on_level_up_rewards;
    if (
      nextXp !== null
      || nextCost !== null
      || nextNatural !== null
      || nextXpToNextDelta !== null
      || xpPerClickDelta !== null
      || xpGoldCostDelta !== null
      || canBuyXp === false
      || shopRefreshXpGain !== null
      || postCombatXpWin !== null
      || postCombatXpLoss !== null
      || combatStartXpGain !== null
      || perRoundXpGain !== null
      || modifier.on_level_up_rewards
    ) {
      policy.source = modifier.source || "confirmed_xp_policy_modifier";
      policy.modifiers.push({
        key: modifier.key || modifier.name || "confirmed_modifier",
        patch: {
          ...(nextXp !== null ? { manual_xp_per_click: nextXp } : {}),
          ...(nextCost !== null ? { manual_xp_gold_cost: nextCost } : {}),
          ...(nextNatural !== null ? { natural_xp_per_round: nextNatural } : {}),
          ...(nextXpToNextDelta !== null ? { xp_to_next_delta: nextXpToNextDelta } : {}),
          ...(xpPerClickDelta !== null ? { manual_xp_per_click_delta: xpPerClickDelta } : {}),
          ...(xpGoldCostDelta !== null ? { manual_xp_gold_cost_delta: xpGoldCostDelta } : {}),
          ...(canBuyXp === false ? { can_buy_xp: false } : {}),
          ...(shopRefreshXpGain !== null ? { shop_refresh_xp_gain: shopRefreshXpGain } : {}),
          ...(postCombatXpWin !== null ? { post_player_combat_xp_win: postCombatXpWin } : {}),
          ...(postCombatXpLoss !== null ? { post_player_combat_xp_loss: postCombatXpLoss } : {}),
          ...(combatStartXpGain !== null ? { player_combat_start_xp_gain: combatStartXpGain } : {}),
          ...(perRoundXpGain !== null ? { per_round_xp_gain: perRoundXpGain } : {}),
          ...(modifier.on_level_up_rewards ? { on_level_up_rewards: modifier.on_level_up_rewards } : {}),
        },
        confidence: modifier.confidence || "high",
      });
    }
  }

  const blob = textBlob(live.selected_augments, matchVariables, context.user_memory);
  for (const modifier of asArray(tables.xp_modifier_catalog)) {
    if (!asArray(modifier.match).some((needle) => blob.includes(String(needle).toLowerCase()))) continue;
    if (modifier.patch && Object.keys(modifier.patch).length) {
      const patch = { ...modifier.patch };
      const xpToNextDelta = numberOrNull(patch.xp_to_next_delta);
      const xpPerClickDelta = numberOrNull(patch.manual_xp_per_click_delta);
      const xpGoldCostDelta = numberOrNull(patch.manual_xp_gold_cost_delta);
      delete patch.xp_to_next_delta;
      delete patch.manual_xp_per_click_delta;
      delete patch.manual_xp_gold_cost_delta;
      Object.assign(policy, patch);
      if (xpPerClickDelta !== null) policy.manual_xp_per_click = Math.max(0, policy.manual_xp_per_click + xpPerClickDelta);
      if (xpGoldCostDelta !== null) policy.manual_xp_gold_cost = Math.max(0, policy.manual_xp_gold_cost + xpGoldCostDelta);
      if (xpToNextDelta !== null) policy.xp_to_next_delta = (numberOrNull(policy.xp_to_next_delta) ?? 0) + xpToNextDelta;
      if (modifier.on_level_up_rewards) policy.on_level_up_rewards = modifier.on_level_up_rewards;
      policy.source = `xp_modifier:${modifier.key}`;
      policy.modifiers.push({ key: modifier.key, confidence: modifier.confidence, patch: modifier.patch, note: modifier.note });
    } else {
      policy.uncertainty.push({ key: modifier.key, confidence: modifier.confidence, note: modifier.note });
    }
  }
  return policy;
}

function buildLevelingEconomyContext({ liveState, context = {}, tables = buildStrategyTables() }) {
  const live = collectLiveState(liveState);
  const normalizedContext = normalizeContext(context);
  const level = live.economy.level;
  const gold = live.economy.gold;
  const xpValue = live.economy.xp.value;
  const xpPolicy = policyWithModifiers({ live, context: normalizedContext, tables });
  const tableXpToNext = numberOrNull(tables.leveling_rules.xp_to_next_by_level?.[String(level)] || tables.leveling_rules.xp_to_next_by_level?.[level]);
  const explicitXpToNext = live.economy.xp.to_next;
  const xpToNext = explicitXpToNext ?? Math.max(0, (tableXpToNext ?? 0) + (numberOrNull(xpPolicy.xp_to_next_delta) ?? 0));
  const canCompute = [level, gold, xpValue, xpToNext, xpPolicy.manual_xp_per_click, xpPolicy.manual_xp_gold_cost].every((value) => Number.isFinite(value));
  const currentInterest = interestForGold(gold);
  const targetProfile = targetCostProfile(normalizedContext, tables);
  const lineupLifecycle = buildLineupLifecycleContext({ liveState, context });

  if (!canCompute) {
    return {
      schema: "jcc-leveling-economy-context-v1",
      status: "missing_required_economy_fields",
      live_economy: { level, gold, xp: { value: xpValue, to_next: xpToNext, display: live.economy.xp.display, source: live.economy.xp.source } },
      xp_policy: xpPolicy,
      lineup_lifecycle: lineupLifecycle,
      actions: [],
      missing_fields: [
        !Number.isFinite(level) ? "level" : null,
        !Number.isFinite(gold) ? "gold" : null,
        !Number.isFinite(xpValue) ? "xp.value" : null,
        !Number.isFinite(xpToNext) ? "xp.to_next" : null,
      ].filter(Boolean),
    };
  }

  const scored = scoreEconomyActions({ live, context: normalizedContext, tables, xpPolicy, xpToNext });
  const actions = applyLineupLifecycleGuard(scored.actions, lineupLifecycle, live);

  return {
    schema: "jcc-leveling-economy-context-v1",
    status: "ready",
    live_economy: {
      level,
      gold,
      hp: live.economy.hp,
      xp: {
        value: xpValue,
        to_next: xpToNext,
        display: `${xpValue}/${xpToNext}`,
        source: explicitXpToNext !== null && explicitXpToNext !== undefined ? "live_state" : "strategy_table",
        base_table_to_next: tableXpToNext,
      },
      current_interest: currentInterest,
    },
    xp_policy: xpPolicy,
    leveling_math: {
      ...scored.math,
      lineup_lifecycle: lineupLifecycle,
    },
    lineup_lifecycle: lineupLifecycle,
    actions,
    decision_facts: scored.decision_facts || null,
  };
}

function applyLineupLifecycleGuard(scoredActions, lifecycle, live) {
  const actions = asArray(scoredActions).map((action) => ({ ...action }));
  if (lifecycle?.archetype !== "four_cost_carry" || live.economy.level !== 7) return actions;
  const overrideSignals = new Set(asArray(lifecycle?.override_signals));
  const survivalOverride = overrideSignals.has("lethal_or_single_loss_buffer")
    || overrideSignals.has("high_immediate_roll_marginal_gain")
    || overrideSignals.has("board_below_stabilization_floor");
  for (const action of actions) {
    if (action.action !== "roll_down_stabilize") continue;
    const originalBudget = Number(action.roll_budget);
    if (!Number.isFinite(originalBudget) || originalBudget <= 6) continue;
    const boundedBudget = survivalOverride ? Math.min(12, originalBudget) : 6;
    action.roll_budget = boundedBudget;
    action.gold_after = Number.isFinite(live.economy.gold) ? Math.max(0, live.economy.gold - boundedBudget) : action.gold_after;
    action.interest_after = Number.isFinite(action.gold_after) ? interestForGold(action.gold_after) : action.interest_after;
    action.interest_loss = Number.isFinite(action.gold_after) && Number.isFinite(live.economy.gold)
      ? Math.max(0, interestForGold(live.economy.gold) - interestForGold(action.gold_after))
      : action.interest_loss;
    action.score = Number(Math.min(action.score || 0, survivalOverride ? 0.7 : 0.58).toFixed(3));
    action.confidence = survivalOverride ? "medium" : "low";
    action.evidence = [
      ...asArray(action.evidence),
      "four_cost_carry_level_8_is_a_default_search_prior_not_a_mandate",
      survivalOverride
        ? "current_survival_or_immediate_upgrade_evidence_allows_bounded_level_7_repair"
        : "no_override_evidence_for_a_large_level_7_search",
    ];
  }
  return actions.sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.liveState) throw new Error("--live-state is required");
  const liveState = await readJson(options.liveState);
  const context = options.context ? await readJson(options.context, {}) : {};
  const result = buildLevelingEconomyContext({ liveState, context });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) await writeFile(options.out, json, "utf8");
  process.stdout.write(json);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { buildLevelingEconomyContext };
