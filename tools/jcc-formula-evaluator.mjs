import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const COMMON_KNOWLEDGE_DIR = path.join(REPO_ROOT, "data", "game-knowledge", "jcc", "common");

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const array = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const shopOddsRows = (value) => {
  if (Array.isArray(value)) return value;
  return Object.entries(object(value)).map(([level, row]) => {
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
};
const percent = (value, fallback = 0) => {
  const n = number(value, fallback);
  return Math.abs(n) > 1 ? n / 100 : n;
};
const pow = Math.pow;
const sum = (values) => values.reduce((total, value) => total + number(value), 0);
const average = (values) => values.length ? sum(values) / values.length : 0;
const hasAny = (haystack, needles) => {
  const values = new Set(array(haystack).map((value) => String(value)));
  return array(needles).some((needle) => values.has(String(needle)));
};
const overlapCount = (a, b) => {
  const right = new Set(array(b).map((value) => String(value)));
  return array(a).filter((value) => right.has(String(value))).length;
};

async function readJson(...parts) {
  return JSON.parse(await readFile(path.join(COMMON_KNOWLEDGE_DIR, ...parts), "utf8"));
}

let formulaCache = null;
let evaluatorSpecCache = null;

async function formulaData(name) {
  formulaCache ||= new Map((await readJson("formulas.json")).entries.map((entry) => [entry.id.split(".").at(-1), entry]));
  return formulaCache.get(name) || {
    id: `formula.${name}`,
    exactness: "deterministic_kernel_with_explicit_inputs",
  };
}

async function evaluatorSpec(name) {
  if (!evaluatorSpecCache) {
    const contract = (await readJson("formula-runtime-specs.json")).entries[0];
    const refs = contract.live_field_refs || {};
    evaluatorSpecCache = new Map(Object.entries(contract.required_inputs || {}).map(([formulaName, inputNames]) => [
      formulaName,
      {
        formula_name: formulaName,
        inputs: inputNames.map((inputName) => ({
          name: inputName,
          address: `jcc:common:formula_input:${formulaName}_${inputName}`,
          live_field_refs: refs[inputName] || [inputName],
          missing_policy: "required_for_live_decision",
        })),
      },
    ]));
  }
  return evaluatorSpecCache.get(name) || { formula_name: name, inputs: [] };
}

function inputMissing(input, name) {
  if (!Object.hasOwn(object(input), name)) return true;
  const value = input[name];
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

export async function evaluateFormula(name, input = {}, options = {}) {
  if (!EVALUATORS[name]) {
    return {
      formula_name: name,
      executable: false,
      confidence: "unsupported_formula",
      reason: "No safe runtime evaluator is registered for this formula yet.",
      output: {},
    };
  }
  const commonFormula = await formulaData(name);
  const parameterSet = object(options.parameter_set ?? options.parameterSet ?? input.rule_parameters);
  const formulaParameters = object(parameterSet.formulas?.[name] ?? parameterSet[name]);
  const formula = {
    ...commonFormula,
    ...formulaParameters,
    address: commonFormula.address || `jcc:common:formula:${name}`,
    tables: formulaParameters.tables || commonFormula.tables || {},
  };
  const spec = await evaluatorSpec(name);
  const normalizedInput = normalizeEvaluatorInput(name, input);
  const missingRequiredInputs = (spec?.inputs || [])
    .filter((row) => row.missing_policy === "required_for_live_decision" && inputMissing(normalizedInput, row.name))
    .map((row) => ({
      name: row.name,
      address: row.address,
      live_field_refs: row.live_field_refs || [],
      missing_policy: row.missing_policy,
    }));
  if (missingRequiredInputs.length > 0) {
    return {
      formula_name: name,
      formula_address: formula.address,
      parameter_source: parameterSet.identity || null,
      executable: false,
      confidence: "missing_required_input",
      missing_inputs: missingRequiredInputs,
      missing_live_state_fields: [...new Set(missingRequiredInputs.flatMap((row) => row.live_field_refs).map((ref) => ref.split(":").at(-1)))],
      reason: "Required live-decision inputs are absent; refusing exact evaluator output to avoid fake precision.",
      output: {},
    };
  }
  const output = EVALUATORS[name](normalizedInput, formula);
  return {
    formula_name: name,
    formula_address: formula.address,
    parameter_source: parameterSet.identity || null,
    executable: true,
    confidence: formula.exactness || "runtime_evaluator",
    output,
  };
}

function normalizeEvaluatorInput(name, input = {}) {
  return { ...object(input) };
}

const STANDARD_PLAYER_DAMAGE_BY_STAGE = Object.freeze({ 1: 0, 2: 2, 3: 6, 4: 7, 5: 10, 6: 12, 7: 17, 8: 150 });

function stageBasePlayerDamage(input, formula) {
  const stage = number(input.stage, 3);
  const table = formula?.tables?.base_damage_by_stage || STANDARD_PLAYER_DAMAGE_BY_STAGE;
  return Math.max(0, number(input.pvp_loss_stage_damage, table[String(stage)] ?? table[stage] ?? 0));
}

function evalDamage(input) {
  const damageType = input.damage_type || "physical";
  const baseDamage = number(input.base_damage);
  const bonusDamagePct = percent(input.damage_amp_pct ?? input.bonus_damage_pct);
  const flatPen = number(input.flat_penetration ?? input.flat_pen);
  const pctPen = percent(input.percent_penetration ?? input.pct_pen);
  const critChance = percent(input.critical_chance ?? input.crit_chance);
  const critMultiplierInput = input.critical_damage_multiplier ?? input.crit_multiplier;
  const critMultiplier = Math.abs(number(critMultiplierInput, 1.4)) > 10 ? number(critMultiplierInput, 140) / 100 : number(critMultiplierInput, 1.4);
  const durabilityPct = percent(input.durability_pct);
  const shield = number(input.shield);
  const health = number(input.health);
  const resist = damageType === "magic" ? number(input.magic_resist) : number(input.armor);
  const rawDamage = baseDamage * (1 + bonusDamagePct);
  const effectiveResist = damageType === "true" ? 0 : Math.max(0, resist * (1 - pctPen) - flatPen);
  const mitigationMultiplier = damageType === "true" ? 1 : 100 / (100 + effectiveResist);
  const durabilityMultiplier = 1 - durabilityPct;
  const nonCritDamage = rawDamage * mitigationMultiplier * durabilityMultiplier;
  const critDamage = rawDamage * critMultiplier * mitigationMultiplier * durabilityMultiplier;
  const expectedDamage = nonCritDamage * (1 - critChance) + critDamage * critChance;
  const effectiveHealth = health + shield;
  return {
    raw_damage: rawDamage,
    effective_resist: effectiveResist,
    mitigation_multiplier: mitigationMultiplier,
    non_crit_damage: nonCritDamage,
    crit_damage: critDamage,
    expected_damage: expectedDamage,
    hits_to_kill: effectiveHealth > 0 && expectedDamage > 0 ? Math.ceil(effectiveHealth / expectedDamage) : null,
  };
}

function evalPvpPlayerDamage(input, formula) {
  const stageBaseDamage = stageBasePlayerDamage(input, formula);
  const survivingEnemyUnits = Math.max(0, number(input.surviving_enemy_units));
  return {
    stage_base_damage: stageBaseDamage,
    surviving_enemy_units: survivingEnemyUnits,
    total_player_damage: stageBaseDamage + survivingEnemyUnits,
  };
}

function evalEhp(input) {
  const hp = number(input.hp);
  const armor = number(input.armor);
  const magicResist = number(input.magic_resist);
  const durabilityPct = percent(input.durability_pct);
  const mix = input.damage_mix || {};
  const physicalShare = number(mix.physical_share, 0.5);
  const magicShare = number(mix.magic_share, 0.5);
  const trueShare = number(mix.true_share, 0);
  const durability = Math.max(0.01, 1 - durabilityPct);
  const physicalEhp = hp * (1 + armor / 100) / durability;
  const magicEhp = hp * (1 + magicResist / 100) / durability;
  const mixedEhp = hp > 0 ? 1 / (physicalShare / physicalEhp + magicShare / magicEhp + trueShare / hp) : 0;
  return {
    physical_ehp: physicalEhp,
    magic_ehp: magicEhp,
    mixed_ehp: mixedEhp,
    marginal_hp_value: hp > 0 ? mixedEhp / hp : 0,
    marginal_armor_value: hp / 100 / durability * physicalShare,
    marginal_mr_value: hp / 100 / durability * magicShare,
  };
}

function evalResistMitigation(input) {
  const incomingDamage = number(input.incoming_damage);
  const resist = number(input.resist);
  const mitigationMultiplier = 100 / (100 + Math.max(resist, -99));
  return {
    mitigation_multiplier: mitigationMultiplier,
    post_resist_damage: incomingDamage * mitigationMultiplier,
  };
}

function evalPenetrationEffectiveResist(input) {
  const baseResist = number(input.base_resist);
  const shredPct = percent(input.shred_pct);
  const sunderPct = percent(input.sunder_pct);
  const flatPen = number(input.flat_pen);
  const pctPen = percent(input.pct_pen);
  return {
    effective_resist: Math.max(0, baseResist * (1 - Math.max(shredPct, sunderPct)) * (1 - pctPen) - flatPen),
  };
}

function evalCritExpectedDamage(input) {
  const baseDamage = number(input.base_damage);
  const critChance = percent(input.crit_chance);
  const critMultiplier = Math.abs(number(input.crit_multiplier, 1.4)) > 10 ? number(input.crit_multiplier, 140) / 100 : number(input.crit_multiplier, 1.4);
  const expectedCritMultiplier = 1 + critChance * (critMultiplier - 1);
  return {
    expected_crit_multiplier: expectedCritMultiplier,
    expected_damage: baseDamage * expectedCritMultiplier,
  };
}

function evalAttackSpeedScaling(input) {
  const baseAttackSpeed = number(input.base_attack_speed);
  const bonusAttackSpeedPct = percent(input.bonus_attack_speed_pct);
  const attackSpeedCap = number(input.attack_speed_cap, 5);
  return {
    final_attack_speed: Math.min(baseAttackSpeed * (1 + bonusAttackSpeedPct), attackSpeedCap),
  };
}

function evalDpsAutoAttack(input) {
  const ad = number(input.ad);
  const attackSpeed = number(input.attack_speed);
  const crit = evalCritExpectedDamage({ base_damage: 1, crit_chance: input.crit_chance, crit_multiplier: input.crit_multiplier });
  const damageAmp = percent(input.damage_amp);
  return {
    expected_auto_dps: ad * attackSpeed * crit.expected_crit_multiplier * (1 + damageAmp),
  };
}

function evalInterestBreak(input) {
  const interest = (gold) => clamp(Math.floor(number(gold) / 10), 0, 5);
  const interestBefore = interest(input.gold_before_action);
  const interestAfter = interest(input.gold_after_action);
  return {
    interest_before: interestBefore,
    interest_after: interestAfter,
    interest_lost: interestBefore - interestAfter,
  };
}

function evalLevelTiming(input, formula) {
  const level = number(input.level);
  const targetLevel = number(input.target_level, level + 1);
  const xp = number(input.xp);
  const gold = number(input.gold);
  const curve = input.xp_curve || formula.tables?.xp_curve || [];
  const target = curve.find((row) => Number(row.level) === targetLevel);
  const current = curve.find((row) => Number(row.level) === level);
  const targetXp = number(target?.totalXp ?? target?.xpToReach ?? target?.xp, 0);
  const currentTotalXp = number(current?.totalXp ?? current?.xpToReach, 0) + xp;
  const xpNeeded = Math.max(0, targetXp - currentTotalXp);
  const goldNeeded = Math.ceil(xpNeeded / 4) * 4;
  return {
    xp_needed: xpNeeded,
    gold_needed: goldNeeded,
    can_level_now: gold >= goldNeeded,
    gold_after_level: gold - goldNeeded,
  };
}

function evalShopOdds(input, formula) {
  const level = number(input.level);
  const cost = number(input.cost);
  const shopSlots = number(input.shop_slots, 5);
  const rerolls = number(input.rerolls);
  const remainingCopies = number(input.remaining_copies, 1);
  const poolTotalForCost = number(input.pool_total_for_cost, 1);
  const oddsRow = shopOddsRows(formula.tables?.odds_by_level).find((row) => Number(row.level) === level) || {};
  const rawOdds = number(oddsRow[`cost${cost}`]);
  const rowValues = [1, 2, 3, 4, 5]
    .map((tier) => number(oddsRow[`cost${tier}`]))
    .filter((tier) => Number.isFinite(tier));
  const costOdds = rowValues.reduce((sum, tier) => sum + tier, 0) > 1.5
    ? rawOdds / 100
    : percent(rawOdds);
  const shopsSeen = rerolls + 1;
  const perSlotCostOdds = costOdds;
  const perShopCostHitOdds = 1 - pow(1 - costOdds, shopSlots);
  const specificUnitSlotOdds = costOdds * remainingCopies / Math.max(1, poolTotalForCost);
  return {
    per_slot_cost_odds: perSlotCostOdds,
    per_shop_cost_hit_odds: perShopCostHitOdds,
    estimated_specific_unit_hit_odds: 1 - pow(1 - specificUnitSlotOdds, shopSlots * shopsSeen),
  };
}

function evalRollProbability(input) {
  const level = number(input.level);
  const targetCost = number(input.target_cost);
  const targetRemainingCopies = number(input.target_remaining_copies, 1);
  const poolTotalForCost = number(input.pool_total_for_cost, 1);
  const goldToRoll = number(input.gold_to_roll);
  const shopSlots = number(input.shop_slots, 5);
  const costOdds = percent(input.cost_odds ?? input.target_cost_odds ?? 0);
  const targetSlotProbability = number(input.target_slot_probability, costOdds * targetRemainingCopies / Math.max(1, poolTotalForCost));
  const shopsSeen = Math.floor(goldToRoll / 2);
  const slotTrials = shopsSeen * shopSlots;
  return {
    level,
    target_cost: targetCost,
    shops_seen: shopsSeen,
    slot_trials: slotTrials,
    hit_probability_1_plus: 1 - pow(1 - targetSlotProbability, slotTrials),
    expected_copies: slotTrials * targetSlotProbability,
  };
}

function evalRollDownBudget(input) {
  const gold = number(input.gold);
  const stopGold = number(input.stop_gold);
  const freeRerolls = number(input.free_rerolls);
  const rerollCost = number(input.reroll_cost, 2);
  const shopsSeen = freeRerolls + Math.floor(Math.max(0, gold - stopGold) / rerollCost);
  return {
    shops_seen: shopsSeen,
    slot_trials: shopsSeen * 5,
    gold_left: gold - Math.max(0, shopsSeen - freeRerolls) * rerollCost,
  };
}

function evalDefensiveMarginalValue(input) {
  const current = evalEhp({
    hp: input.current_hp,
    armor: input.current_armor,
    magic_resist: input.current_mr,
    durability_pct: input.current_durability_pct,
    damage_mix: input.damage_mix,
  });
  const stats = input.candidate_stats || {};
  const after = evalEhp({
    hp: number(input.current_hp) + number(stats.hp),
    armor: number(input.current_armor) + number(stats.armor),
    magic_resist: number(input.current_mr) + number(stats.magic_resist ?? stats.mr),
    durability_pct: percent(input.current_durability_pct) + percent(stats.durability_pct),
    damage_mix: input.damage_mix,
  });
  const deltas = {
    delta_physical_ehp: after.physical_ehp - current.physical_ehp,
    delta_magic_ehp: after.magic_ehp - current.magic_ehp,
    delta_mixed_ehp: after.mixed_ehp - current.mixed_ehp,
  };
  const best = Object.entries({
    hp: number(stats.hp) ? deltas.delta_mixed_ehp : -Infinity,
    armor: number(stats.armor) ? deltas.delta_physical_ehp : -Infinity,
    magic_resist: number(stats.magic_resist ?? stats.mr) ? deltas.delta_magic_ehp : -Infinity,
    durability: number(stats.durability_pct) ? deltas.delta_mixed_ehp : -Infinity,
  }).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return { ...deltas, best_defensive_stat: best };
}

function evalStatModifierValue(input) {
  const unit = object(input.unit_profile);
  const modifiers = array(input.stat_modifiers);
  const existing = array(input.existing_modifiers);
  const role = String(unit.role || input.role || "");
  const baseAd = number(unit.ad, 50);
  const baseApWeight = number(unit.ap_weight, /ap|magic|caster/.test(role) ? 1 : 0.4);
  const baseAs = number(unit.attack_speed, 0.75);
  const baseHp = number(unit.hp, 800);
  const baseArmor = number(unit.armor, 30);
  const baseMr = number(unit.magic_resist, 30);
  const damageMix = object(input.damage_mix);
  const roleDamageWeight = /carry|damage|ap|ad|caster|ranged/.test(role) ? 1.15 : 0.55;
  const roleTankWeight = /tank|front|melee/.test(role) ? 1.1 : 0.45;
  const castWeight = /caster|mana|ap/.test(role) ? 1.0 : 0.35;
  let adDelta = 0;
  let apDelta = 0;
  let asDeltaPct = 0;
  let critDelta = 0;
  let ampDelta = 0;
  let hpDelta = 0;
  let armorDelta = 0;
  let mrDelta = 0;
  let manaDelta = 0;
  for (const mod of modifiers) {
    const key = String(mod.stat_key || mod.stat || "");
    const value = number(mod.value ?? mod.value_per_stack);
    const stacks = number(mod.max_stacks, mod.operation === "stack_on_attack" ? 6 : 1);
    const effectiveValue = value * Math.max(1, stacks);
    if (key === "ad") adDelta += effectiveValue;
    if (key === "ap") apDelta += effectiveValue;
    if (key === "attack_speed_pct") asDeltaPct += percent(effectiveValue);
    if (key === "crit_chance_pct") critDelta += percent(effectiveValue);
    if (key === "damage_amp_pct") ampDelta += percent(effectiveValue);
    if (key === "health") hpDelta += effectiveValue;
    if (key === "armor") armorDelta += effectiveValue;
    if (key === "magic_resist") mrDelta += effectiveValue;
    if (key === "mana" || key === "mana_regen") manaDelta += effectiveValue;
  }
  const before = evalEhp({ hp: baseHp, armor: baseArmor, magic_resist: baseMr, damage_mix: damageMix });
  const after = evalEhp({ hp: baseHp + hpDelta, armor: baseArmor + armorDelta, magic_resist: baseMr + mrDelta, damage_mix: damageMix });
  const overlapPenalty = sum(modifiers.map((mod) => {
    const key = mod.stat_key || mod.stat;
    const duplicate = existing.filter((row) => (row.stat_key || row.stat) === key).length;
    return duplicate * Math.max(2, Math.abs(number(mod.value ?? mod.value_per_stack)) * 0.08);
  }));
  const offensiveDelta = adDelta + apDelta * baseApWeight + baseAd * asDeltaPct + baseAd * critDelta * 0.4 + (baseAd + adDelta + apDelta * baseApWeight) * ampDelta;
  const defensiveDelta = after.mixed_ehp - before.mixed_ehp;
  const effectiveStatValue = offensiveDelta * roleDamageWeight + defensiveDelta * roleTankWeight / 20 + manaDelta * castWeight - overlapPenalty;
  return {
    offensive_delta: offensiveDelta,
    defensive_delta: defensiveDelta,
    mana_delta: manaDelta,
    effective_stat_value: effectiveStatValue,
    overlap_penalty: overlapPenalty,
  };
}

function evalItemMarginalValue(input) {
  const unit = object(input.unit_profile);
  const candidate = object(input.candidate_item);
  const tags = array(candidate.tags);
  const currentItems = array(input.current_items);
  const gaps = array(input.team_gaps);
  const intent = object(input.round_intent);
  const roleTags = array(unit.tags || unit.role_tags || unit.role);
  const roleMatchTags = [
    ...roleTags,
    unit.damage_type,
    unit.role,
    ...(/ad|physical/.test(String(unit.role || unit.damage_type || "")) ? ["physical_damage", "ad", "attack_speed", "crit"] : []),
    ...(/ap|magic|caster/.test(String(unit.role || unit.damage_type || "")) ? ["magic_damage", "ap", "mana"] : []),
    ...(/tank|front/.test(String(unit.role || "")) ? ["health", "armor", "magic_resist", "durability", "shield"] : []),
  ];
  const stats = object(candidate.stats);
  const statValue = evalStatModifierValue({
    unit_profile: unit,
    stat_modifiers: Object.entries(stats).map(([stat_key, value]) => ({ stat_key, value })),
    damage_mix: input.enemy_damage_mix,
    existing_modifiers: currentItems.flatMap((item) => Object.entries(object(item.stats)).map(([stat_key, value]) => ({ stat_key, value }))),
  });
  const offensiveTagMatch = overlapCount(tags, roleMatchTags);
  const gapFillScore = overlapCount(tags, gaps) * 18 + overlapCount(candidate.effect_types, gaps) * 14;
  const defensiveEhpDelta = statValue.defensive_delta;
  const conflictPenalty = currentItems.length >= 3 ? 100 : currentItems.some((item) => item.unique && candidate.unique && item.id === candidate.id) ? 80 : overlapCount(tags, currentItems.flatMap((item) => item.tags || [])) * 4;
  const tempoWeight = number(intent.tempo_weight, intent.id === "stabilize" ? 1.25 : 1);
  const capWeight = number(intent.cap_weight, intent.id === "greed_cap" ? 1.25 : 1);
  const immediatePowerScore = statValue.effective_stat_value / 4 + offensiveTagMatch * 10 + (defensiveEhpDelta > 0 ? Math.min(30, defensiveEhpDelta / 80) : 0);
  const futureFitScore = overlapCount(tags, array(unit.future_tags || unit.preferred_item_tags)) * 14 + capWeight * overlapCount(tags, ["artifact", "radiant", "emblem", "completed"]) * 8;
  return {
    immediate_power_score: immediatePowerScore,
    future_fit_score: futureFitScore,
    defensive_ehp_delta: defensiveEhpDelta,
    offensive_tag_match: offensiveTagMatch,
    conflict_penalty: conflictPenalty,
    recommendation_score: immediatePowerScore * tempoWeight + futureFitScore * capWeight + gapFillScore - conflictPenalty,
  };
}

function evalRewardChoiceScore(input) {
  const tags = array(input.reward_tags);
  const gaps = array(input.current_gaps);
  const risk = String(input.risk_level || "medium");
  const intent = object(input.round_intent);
  const immediateTags = ["immediate_power", "tempo", "unit", "item", "component", "health", "frontline"];
  const capTags = ["cap_power", "emblem", "artifact", "radiant", "five_cost", "late_game", "trait"];
  const economyTags = ["economy", "gold", "xp", "reroll", "interest"];
  const immediateScore = overlapCount(tags, immediateTags) * 22 + overlapCount(tags, gaps) * 14;
  const capScore = overlapCount(tags, capTags) * 24 + overlapCount(tags, gaps) * 8;
  const economyScore = overlapCount(tags, economyTags) * 22;
  const tempoWeight = number(intent.tempo_weight, risk === "high" ? 1.35 : 1);
  const capWeight = number(intent.cap_weight, risk === "low" ? 1.25 : 0.9);
  const economyWeight = number(intent.economy_weight, risk === "high" ? 0.75 : 1);
  const gapFillScore = overlapCount(tags, gaps) * 18;
  return {
    immediate_score: immediateScore,
    cap_score: capScore,
    economy_score: economyScore,
    final_score: immediateScore * tempoWeight + capScore * capWeight + economyScore * economyWeight + gapFillScore,
  };
}

function evalAugmentDirectionScore(input) {
  const tags = array(input.augment_tags);
  const direction = array(input.board_direction?.tags || input.board_direction);
  const itemTags = array(input.items).flatMap((item) => item.tags || []);
  const economy = object(input.economy_state);
  const alignment = overlapCount(tags, direction) + overlapCount(tags, itemTags) * 0.5;
  const reward = evalRewardChoiceScore({
    reward_tags: tags,
    current_gaps: array(input.board_direction?.gaps),
    round_intent: input.board_direction?.round_intent,
    risk_level: number(economy.hp, 70) < 35 ? "high" : "medium",
  });
  const economyPenalty = hasAny(tags, ["reroll", "three_star"]) && number(economy.gold) < 20 ? 12 : 0;
  const directionAlignment = alignment / Math.max(1, tags.length);
  return {
    direction_alignment: directionAlignment,
    risk_adjusted_score: reward.final_score + directionAlignment * 35 - economyPenalty,
  };
}

function evalTraitDelta(input) {
  const counts = object(input.current_trait_counts);
  const candidateTraits = array(input.candidate_unit_traits);
  const emblems = array(input.emblems);
  const breakpointsByTrait = object(input.trait_breakpoints);
  const rows = candidateTraits.map((trait) => {
    const traitId = String(trait.id || trait.trait || trait);
    const addCount = number(trait.count, 1) + emblems.filter((emblem) => String(emblem.trait || emblem.id) === traitId).length;
    const before = number(counts[traitId]);
    const after = before + addCount;
    const breakpoints = array(breakpointsByTrait[traitId] || trait.breakpoints).map((row) => number(row.count ?? row)).filter(Boolean).sort((a, b) => a - b);
    const activeBefore = breakpoints.filter((count) => before >= count).at(-1) || 0;
    const activeAfter = breakpoints.filter((count) => after >= count).at(-1) || 0;
    const next = breakpoints.find((count) => after < count) || null;
    return {
      trait_id: traitId,
      before,
      after,
      activated_breakpoint: activeAfter > activeBefore ? activeAfter : null,
      next_breakpoint_distance: next == null ? 0 : Math.max(0, next - after),
    };
  });
  return {
    new_breakpoints: rows.filter((row) => row.activated_breakpoint),
    next_breakpoint_distance: rows.length ? Math.min(...rows.map((row) => row.next_breakpoint_distance)) : null,
    trait_value_delta_tags: rows.flatMap((row) => [row.activated_breakpoint ? "activates_breakpoint" : "no_new_breakpoint", row.next_breakpoint_distance <= 1 ? "near_breakpoint" : "far_breakpoint"]),
  };
}

function evalUnitQualityScore(input) {
  const cost = number(input.cost);
  const star = number(input.star, 1);
  const role = String(input.role || "");
  const stats = object(input.stat_vector);
  const itemFit = number(input.item_fit);
  const traitFit = number(input.trait_fit);
  const statScore = number(stats.hp) / 120 + number(stats.ad) / 2 + number(stats.ap) / 3 + number(stats.attack_speed) * 20 + number(stats.armor) / 4 + number(stats.magic_resist) / 4;
  const roleBonus = /tank|front/.test(role) ? number(stats.hp) / 160 + number(stats.armor) / 3 + number(stats.magic_resist) / 3 : /carry|caster|ranged/.test(role) ? number(stats.ad) / 2 + number(stats.ap) / 2 + number(stats.attack_speed) * 25 : 8;
  return {
    quality_score: cost * 16 + star * star * 18 + statScore + roleBonus + itemFit + traitFit,
  };
}

function evalComponentCompletion(input) {
  const owned = object(input.owned_components);
  const recipes = array(input.candidate_recipes);
  const rows = recipes.map((recipe) => {
    const required = object(recipe.required || recipe.component_counts);
    const missing = Object.entries(required).map(([id, count]) => ({ id, count: Math.max(0, number(count) - number(owned[id])) })).filter((row) => row.count > 0);
    return {
      item_id: recipe.item_id || recipe.id,
      craftable: missing.length === 0,
      missing_components: missing,
      completion_distance: sum(missing.map((row) => row.count)),
    };
  }).sort((a, b) => a.completion_distance - b.completion_distance);
  return {
    craftable_items: rows.filter((row) => row.craftable).map((row) => row.item_id),
    missing_components: rows[0]?.missing_components || [],
    completion_distance: rows[0]?.completion_distance ?? null,
  };
}

function evalTraitBreakpointDistance(input) {
  const current = number(input.current_trait_count);
  const breakpoints = array(input.breakpoints).map((row) => number(row.count ?? row)).filter(Boolean).sort((a, b) => a - b);
  const active = breakpoints.filter((count) => current >= count).at(-1) || 0;
  const next = breakpoints.find((count) => current < count) || null;
  return {
    next_count_needed: next == null ? 0 : next - current,
    active_breakpoint: active,
  };
}

function evalHpLethalTolerance(input, formula) {
  const hp = number(input.hp);
  const stage = number(input.stage, 3);
  const pvpLossStageDamage = stageBasePlayerDamage(input, formula);
  const aliveEnemyUnits = Math.max(0, number(input.alive_enemy_units, 0));
  const expectedLossDamage = Math.max(1, number(input.expected_loss_damage, pvpLossStageDamage + aliveEnemyUnits));
  const streak = number(input.fight_loss_streak);
  const threshold = stage >= 5 || streak >= 3 ? 2 : 1;
  const losses = Math.floor(hp / expectedLossDamage);
  const maxAliveEnemyUnitsToSurvive = Math.max(0, hp - pvpLossStageDamage - 1);
  const lethalAliveEnemyUnits = Math.max(0, hp - pvpLossStageDamage);
  return {
    pvp_loss_stage_damage: pvpLossStageDamage,
    alive_enemy_units: aliveEnemyUnits,
    expected_loss_damage: expectedLossDamage,
    max_alive_enemy_units_to_survive: maxAliveEnemyUnitsToSurvive,
    lethal_alive_enemy_units: lethalAliveEnemyUnits,
    losses_to_elimination: losses,
    must_stabilize: losses <= threshold,
    exactness: "threshold_exact_for_given_stage_hp_and_survivor_count; future_alive_enemy_units_remain_estimate",
  };
}

function evalActionFeasibility(input) {
  const blocks = [];
  if (number(input.gold) < number(input.required_gold, 0)) blocks.push("insufficient_gold");
  if (number(input.bench_slots) < number(input.required_bench_slots, 0)) blocks.push("bench_full");
  if (number(input.item_slots) < number(input.required_item_slots, 0)) blocks.push("item_slots_full");
  if (String(input.recognized_state || "recognized") !== "recognized") blocks.push("state_not_recognized");
  if (number(input.time_left) < number(input.estimated_operation_time, 3)) blocks.push("not_enough_time");
  return {
    is_actionable: blocks.length === 0,
    blocking_constraints: blocks,
  };
}

function evalOperationTimeBudget(input) {
  const profile = object(input.user_speed_profile);
  const secondsPerAction = number(profile.seconds_per_action, profile.speed === "slow" ? 2.4 : profile.speed === "fast" ? 0.9 : 1.5);
  const availableActions = Math.floor(number(input.time_left) / Math.max(0.25, secondsPerAction));
  const actionCount = number(input.action_count);
  return {
    max_recommendation_complexity: availableActions <= 2 ? "one_step" : availableActions <= 5 ? "short_sequence" : "full_plan",
    brief_or_explain_mode: number(input.time_left) <= 6 || actionCount > availableActions ? "brief" : "explain",
    available_actions: availableActions,
  };
}

function evalPositioningRisk(input) {
  const targetLogic = String(input.enemy_target_logic || "");
  const aoeTags = array(input.enemy_aoe_tags);
  const carry = object(input.my_carry_position);
  const tank = object(input.my_tank_position);
  const sameCol = carry.col != null && tank.col != null && number(carry.col) === number(tank.col);
  const sameRow = carry.row != null && tank.row != null && number(carry.row) === number(tank.row);
  const aoeRisk = aoeTags.length * 12 + (sameRow ? 12 : 0);
  const lineRisk = /line|直线|same_col/.test(targetLogic) || sameCol ? 24 : 0;
  const backlineRisk = /backline|后排|farthest/.test(targetLogic) ? 30 : number(carry.row) >= 3 ? 8 : 0;
  const diveRisk = /dive|切入|assassin/.test(targetLogic) ? 28 : 0;
  const total = aoeRisk + lineRisk + backlineRisk + diveRisk;
  return {
    aoe_risk: aoeRisk,
    line_risk: lineRisk,
    backline_risk: backlineRisk,
    recommended_template: total >= 45 ? "spread_carry_and_shift_tank_anchor" : total >= 20 ? "minor_side_swap_or_split" : "hold_default",
    total_risk: total,
  };
}

function evalBoardTraitCount(input) {
  const counts = {};
  for (const unit of array(input.board_units)) {
    if (unit.bench_only) continue;
    for (const trait of array(unit.traits)) counts[String(trait.id || trait.trait || trait)] = (counts[String(trait.id || trait.trait || trait)] || 0) + number(trait.count, 1);
  }
  for (const emblem of array(input.emblems)) counts[String(emblem.trait || emblem.id || emblem)] = (counts[String(emblem.trait || emblem.id || emblem)] || 0) + number(emblem.count, 1);
  for (const rule of array(input.special_trait_rules)) {
    const id = String(rule.trait || rule.id || "");
    if (!id) continue;
    if (rule.operation === "set") counts[id] = number(rule.value);
    else counts[id] = (counts[id] || 0) + number(rule.value, 1);
  }
  return { trait_counts: counts };
}

function evalManaCycle(input) {
  const initialMana = number(input.initial_mana);
  const maxMana = number(input.max_mana);
  const needed = Math.max(0, maxMana - initialMana);
  const gainRate = number(input.mana_gain_rate, number(input.mana_per_second) + number(input.mana_per_attack) * number(input.attack_speed, 0.75) + number(input.damage_taken_mana));
  return {
    mana_needed_after_start: needed,
    estimated_time_to_first_cast: gainRate > 0 ? needed / gainRate : null,
  };
}

function evalAttacksToCast(input) {
  const initialMana = number(input.initial_mana);
  const maxMana = number(input.max_mana);
  const immediateMana = number(input.immediate_mana);
  const manaPerAttack = number(input.mana_per_attack);
  const manaNeeded = Math.max(0, maxMana - initialMana - immediateMana);
  return {
    mana_needed_after_start: manaNeeded,
    mana_per_attack: manaPerAttack,
    minimum_basic_attacks_to_first_cast: manaNeeded === 0
      ? 0
      : manaPerAttack > 0 ? Math.ceil(manaNeeded / manaPerAttack) : null,
    excludes_damage_taken_mana: true,
  };
}

function evalCastFrequency(input) {
  const mana = evalManaCycle(input);
  const fightDuration = number(input.fight_duration, 15);
  const castTime = number(input.cast_time, 1);
  const cycle = number(input.cast_cycle_time, Math.max(0.1, number(input.max_mana) / Math.max(0.1, number(input.mana_gain_rate, number(input.mana_per_second) + number(input.mana_per_attack) * number(input.attack_speed, 0.75)))));
  const firstCast = mana.estimated_time_to_first_cast == null ? Infinity : mana.estimated_time_to_first_cast;
  const casts = firstCast <= fightDuration ? 1 + Math.floor(Math.max(0, fightDuration - firstCast - castTime) / Math.max(0.1, cycle + castTime)) : 0;
  return { estimated_casts: casts };
}

function evalDamageAmpStack(input) {
  const baseDamage = number(input.base_damage);
  const sources = array(input.amp_sources).map((source) => percent(source.value ?? source));
  const policy = String(input.stacking_policy || "additive");
  const multiplier = policy === "multiplicative" ? sources.reduce((m, value) => m * (1 + value), 1) : 1 + sum(sources);
  return { amped_damage: baseDamage * multiplier, amp_multiplier: multiplier };
}

function evalDamageMix(input) {
  const tags = [...array(input.champion_tags), ...array(input.item_tags), ...array(input.trait_tags)].map(String);
  let physical = tags.filter((tag) => /physical|ad|attack|crit/.test(tag)).length;
  let magic = tags.filter((tag) => /magic|ap|mana|spell|caster/.test(tag)).length;
  let truth = tags.filter((tag) => /true/.test(tag)).length;
  if (!physical && !magic && !truth) physical = 1;
  const total = physical + magic + truth;
  const shares = { physical_share: physical / total, magic_share: magic / total, true_share: truth / total };
  const primary = Object.entries(shares).sort((a, b) => b[1] - a[1])[0][0].replace("_share", "");
  return { ...shares, primary_damage_type: primary };
}

function evalDoubleCastEffectiveness(input) {
  const base = number(input.base_cast_value);
  const efficiency = percent(input.repeat_efficiency_pct, 1);
  const casts = number(input.estimated_casts, 1);
  const waste = percent(input.overkill_or_shield_waste);
  const extra = base * efficiency * casts * (1 - waste);
  return {
    extra_cast_value: extra,
    effective_total_cast_value: base * casts + extra,
    repeat_cast_tempo_value: extra / Math.max(1, casts),
  };
}

function evalEconomy(input, formula) {
  const gold = number(input.gold);
  const plannedSpend = number(input.planned_spend) + number(input.planned_xp_buy);
  const afterSpend = gold - plannedSpend;
  const tables = formula?.tables || {};
  const interestCap = number(tables.normal_interest_cap, 5);
  const interest = clamp(Math.floor(Math.max(0, afterSpend) / 10), 0, interestCap);
  const streak = number(input.streak);
  const absStreak = Math.abs(streak);
  const streakBonus = number((tables.streak_bonus || []).find((row) => absStreak >= number(row.min_streak) && (row.max_streak == null || absStreak <= number(row.max_streak)))?.gold, absStreak >= 6 ? 3 : absStreak === 5 ? 2 : absStreak >= 2 ? 1 : 0);
  const combatGold = input.pvp_result === "win" ? number(tables.pvp_win_gold, 1) : number(tables.pvp_loss_gold, 0);
  const round = String(input.round || "");
  const standardIncome = tables.base_income_by_round?.[round] ?? (/^(?:[2-9]|\d{2,})-/.test(round) || /^2-(?:[2-9]|\d{2,})$/.test(round) ? tables.base_income_by_round?.["2-2+"] : undefined);
  const baseIncome = number(input.base_income, number(standardIncome, 5));
  return {
    base_income: baseIncome,
    interest,
    streak_bonus: streakBonus,
    combat_gold: combatGold,
    next_gold: afterSpend + baseIncome + interest + streakBonus + combatGold,
    interest_break: clamp(Math.floor(gold / 10), 0, 5) - interest,
  };
}

function evalHealingEffectiveHp(input) {
  const healing = number(input.healing);
  const wound = percent(input.wound_pct);
  const capValue = number(input.missing_hp_cap, Infinity);
  const resists = object(input.resists);
  const effective = Math.min(healing * (1 - wound), capValue);
  const relevantResist = number(resists.relevant ?? average([number(resists.armor), number(resists.magic_resist)]));
  return { effective_healing: effective, healing_ehp: effective * (1 + relevantResist / 100) };
}

function evalShieldEffectiveHp(input) {
  const shield = number(input.shield);
  const armor = number(input.armor);
  const mr = number(input.magic_resist);
  const mix = object(input.damage_mix);
  const physical = shield * (1 + armor / 100);
  const magic = shield * (1 + mr / 100);
  const mixed = shield > 0 ? 1 / (number(mix.physical_share, 0.5) / physical + number(mix.magic_share, 0.5) / magic + number(mix.true_share, 0) / shield) : 0;
  return { physical_shield_ehp: physical, magic_shield_ehp: magic, mixed_shield_ehp: mixed };
}

function evalContestAdjustedPool(input) {
  const remaining = Math.max(0, number(input.base_pool_copies) - number(input.owned_by_player) - number(input.owned_by_opponents) - number(input.dead_or_unavailable));
  const severityRatio = number(input.base_pool_copies) > 0 ? 1 - remaining / number(input.base_pool_copies) : 0;
  return {
    remaining_copies: remaining,
    contest_severity: severityRatio >= 0.7 ? "severe" : severityRatio >= 0.45 ? "contested" : severityRatio >= 0.2 ? "light" : "open",
  };
}

function evalShopSpecificUnitOdds(input, formula) {
  const level = number(input.level);
  const targetCost = number(input.target_cost);
  const remainingCopies = number(input.remaining_target_copies, 1);
  const poolTotalForCost = Math.max(1, number(input.pool_total_for_cost, 1));
  const oddsRow = shopOddsRows(formula.tables?.odds_by_level).find((row) => Number(row.level) === level) || {};
  const costOdds = percent(input.cost_odds ?? oddsRow[`cost${targetCost}`]);
  return { specific_unit_slot_odds: costOdds * remainingCopies / poolTotalForCost };
}

function evalItemConflictPenalty(input) {
  const current = array(input.current_items);
  const candidate = object(input.candidate_item);
  const roleSlots = number(input.role_slots, 3);
  const reasons = [];
  if (current.length >= roleSlots) reasons.push("item_slots_full");
  if (candidate.unique && current.some((item) => item.id === candidate.id || item.name === candidate.name)) reasons.push("duplicate_unique");
  const duplicateTags = overlapCount(candidate.tags, current.flatMap((item) => item.tags || []));
  if (duplicateTags >= 2) reasons.push("overlapping_function");
  return { conflict_penalty: reasons.length * 25 + duplicateTags * 4, conflict_reasons: reasons };
}

function evalItemStatDelta(input) {
  const current = object(input.current_stats);
  const item = object(input.item_stats);
  const next = { ...current };
  for (const [key, value] of Object.entries(item)) next[key] = number(next[key]) + number(value);
  return { new_stats: next, stat_delta_tags: Object.keys(item).filter((key) => number(item[key]) !== 0) };
}

function evalResourceExchange(input) {
  const goldEquivalent = number(input.gold) + number(input.xp) + number(input.rerolls) * 2 + array(input.items).length * 8 + number(input.duplicators) * 18 + number(input.hp) * (String(input.risk_level) === "high" ? 1.2 : 0.4);
  const riskMultiplier = String(input.risk_level) === "high" ? 1.25 : String(input.risk_level) === "low" ? 0.9 : 1;
  return {
    estimated_gold_equivalent: goldEquivalent,
    risk_adjusted_value: goldEquivalent * riskMultiplier,
    tempo_value: goldEquivalent * (number(input.round, 3) <= 3 ? 1.2 : 0.9),
  };
}

function evalCompGapScore(input) {
  const board = array(input.board_tags);
  const items = array(input.item_tags);
  const enemy = array(input.enemy_tags);
  const required = ["frontline", "backline_damage", "control", "wound", "sunder", "shred", "magic_resist", "armor"];
  const missing = {};
  for (const tag of required) {
    const covered = hasAny([...board, ...items], [tag]);
    const enemyPressure = hasAny(enemy, [tag, tag === "magic_resist" ? "magic_damage" : tag === "armor" ? "physical_damage" : tag]) ? 1.5 : 1;
    missing[tag] = covered ? 0 : 20 * enemyPressure;
  }
  return { missing_gap_scores: missing };
}

function evalEffectBlockValue(input) {
  const block = object(input.effect_block);
  const tags = array(block.tags);
  const values = array(block.numeric_values).map((row) => number(row.value ?? row));
  const formulas = array(block.formula_refs);
  const statDelta = formulas.some((ref) => String(ref).endsWith(":formula:stat_modifier_value"))
    || hasAny(tags, ["physical_damage", "magic_damage", "health", "armor", "magic_resist"])
    ? sum(values)
    : 0;
  const resourceDelta = hasAny(tags, ["economy", "item_reward"]) ? sum(values) : 0;
  const choiceValue = hasAny(block.effect_types, ["choice", "grant", "loot"]) ? 18 + resourceDelta : 0;
  const traitDeltaValue = formulas.some((ref) => String(ref).endsWith(":formula:trait_delta")) ? 20 : 0;
  return {
    block_value_score: statDelta + resourceDelta * 3 + choiceValue + traitDeltaValue,
    block_formula_refs: formulas,
    stat_delta: statDelta,
    resource_delta: resourceDelta,
    choice_value: choiceValue,
    trait_delta_value: traitDeltaValue,
  };
}

function evalEncounterRuleShift(input) {
  const baseline = object(input.baseline_rules);
  const encounter = object(input.encounter);
  const modified = { ...baseline };
  for (const mod of array(encounter.rule_modifiers || encounter.modifiers)) {
    const target = mod.target;
    if (!target) continue;
    if (mod.operation === "set") modified[target] = mod.value;
    else modified[target] = number(modified[target]) + number(mod.value);
  }
  return { modified_rules: modified, affected_formulas: array(encounter.formula_refs) };
}

function evalPivotCost(input) {
  const current = array(input.current_board);
  const shared = new Set(array(input.shared_units).map(String));
  const target = array(input.target_skeleton);
  const missing = target.filter((unit) => !shared.has(String(unit.id || unit))).length;
  const goldCost = missing * 4 + number(input.lost_upgrades) * 6;
  const upgradeLoss = number(input.lost_upgrades) * 18;
  const itemMismatch = number(input.item_mismatch) * 16;
  return { gold_cost: goldCost, trait_loss: Math.max(0, current.length - shared.size), upgrade_loss: upgradeLoss, pivot_risk: upgradeLoss + itemMismatch + missing * 12 };
}

function evalReviewAttributionScore(input) {
  const events = [...array(input.timeline_events), ...array(input.decision_events)];
  const scores = {};
  for (const event of events) {
    const reason = event.reason || event.type || "unknown";
    scores[reason] = (scores[reason] || 0) + number(event.severity, 1) * number(event.confidence, 1);
  }
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, score]) => ({ reason, score }));
  return { attribution_scores: scores, top_loss_reasons: top };
}

function evalPlayerHabitBias(input) {
  const events = array(input.decision_events);
  const feedback = array(input.user_feedback);
  const habits = {};
  for (const event of events) {
    const key = event.habit || event.type || "unknown";
    habits[key] = (habits[key] || 0) + number(event.severity, 1);
  }
  for (const row of feedback) if (row.habit) habits[row.habit] = (habits[row.habit] || 0) + number(row.weight, 1);
  return { habit_biases: habits, coaching_reminders: Object.entries(habits).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([habit]) => habit) };
}

function evalScoutingPriorityScore(input) {
  const candidates = [
    ...array(input.likely_next_opponents).map((row) => ({ ...object(row), weight: number(row.weight, 30) })),
    ...array(input.contestants).map((row) => ({ ...object(row), weight: number(row.weight, 22) })),
    ...array(input.lobby_leader ? [input.lobby_leader] : []).map((row) => ({ ...object(row), weight: number(row.weight, 18) })),
  ];
  const timePenalty = number(input.time_left) < 8 ? 8 : 0;
  const order = candidates.map((row) => ({ id: row.id || row.name, priority: number(row.weight) + number(row.threat) + number(row.contest) - timePenalty })).sort((a, b) => b.priority - a.priority);
  return { scout_order: order };
}

function evalSkillValueScaling(input) {
  const star = clamp(number(input.star, 1), 1, 3);
  const blocks = array(input.skill_value_blocks);
  const resolved = blocks.map((block) => {
    const series = array(block.values).flatMap((value) => array(value.by_star));
    const found = series.find((row) => number(row.star) === star);
    const scoringUse = object(block.scoring_use);
    const primaryFormulaRefs = [
      ...array(block.primary_formula_refs),
      ...array(scoringUse.primary_formula_refs),
    ].filter(Boolean);
    return {
      label: block.label,
      value_kind: block.value_kind,
      value: number(found?.value ?? block.single_value?.value),
      fast_path_formula: scoringUse.fast_path_formula || primaryFormulaRefs[0] || null,
      primary_formula_refs: [...new Set(primaryFormulaRefs)],
    };
  });
  const valueByKind = {};
  for (const row of resolved) valueByKind[row.value_kind || "effect_value"] = number(valueByKind[row.value_kind || "effect_value"]) + number(row.value);
  const fastPathFormulaRefs = [...new Set(resolved.map((row) => row.fast_path_formula).filter(Boolean))];
  const primaryFormulaRefs = [...new Set(resolved.flatMap((row) => row.primary_formula_refs || []))];
  return {
    resolved_value_by_star: resolved,
    value_by_kind: valueByKind,
    damage_value: number(valueByKind.damage),
    healing_value: number(valueByKind.healing),
    shield_value: number(valueByKind.shield),
    stat_value_delta: number(valueByKind.stat),
    mitigation_value: number(valueByKind.mitigation),
    count_value: number(valueByKind.count),
    duration_value: number(valueByKind.duration),
    effect_value: number(valueByKind.effect_value),
    fast_path_formula_refs: fastPathFormulaRefs,
    primary_formula_refs: primaryFormulaRefs,
    scaling_formula_refs: array(input.skill_value_blocks).flatMap((block) => block.formula_refs || []),
  };
}

function evalStarUpgradeDelta(input) {
  const before = object(input.stats_before);
  const after = object(input.stats_after);
  const skillBefore = array(input.skill_values_before).map((row) => number(row.value ?? row));
  const skillAfter = array(input.skill_values_after).map((row) => number(row.value ?? row));
  return {
    delta_hp: number(after.hp) - number(before.hp),
    delta_ad: number(after.ad) - number(before.ad),
    delta_ehp: evalEhp({ hp: number(after.hp) - number(before.hp), armor: number(after.armor), magic_resist: number(after.magic_resist) }).mixed_ehp,
    delta_skill_values: sum(skillAfter) - sum(skillBefore),
  };
}

function evalStreakValue(input) {
  const current = number(input.current_streak);
  const nextStreak = input.round_result === "win" ? Math.max(1, current + 1) : input.round_result === "loss" ? Math.min(-1, current - 1) : 0;
  const bonus = (s) => Math.abs(s) >= 6 ? 3 : Math.abs(s) === 5 ? 2 : Math.abs(s) >= 2 ? 1 : 0;
  return { current_bonus: bonus(current), next_bonus: bonus(nextStreak), break_cost: bonus(current) + Math.max(0, bonus(current) - bonus(nextStreak)) };
}

function evalSummonScaling(input) {
  const base = object(input.summon_base_profile);
  const breakpointMultiplier = number(input.trait_breakpoint?.multiplier, 1);
  const starScaling = number(input.summoner_star_sum) * 4;
  const stageScaling = number(input.stage) * 3;
  const buffFit = array(input.item_or_trait_buffs).length * 5;
  const frontline = number(base.hp) / 100 + number(base.armor) / 10 + number(base.magic_resist) / 10;
  const damage = number(base.ad) / 2 + number(base.ap) / 2 + number(base.attack_speed) * 10;
  const quality = (frontline + damage) * breakpointMultiplier + starScaling + stageScaling + buffFit;
  return { summon_quality_score: quality, summon_frontline_value: frontline, summon_damage_value: damage, scaling_delta: quality - (frontline + damage) };
}

export const EVALUATORS = {
  damage: evalDamage,
  pvp_player_damage: evalPvpPlayerDamage,
  ehp: evalEhp,
  resist_mitigation: evalResistMitigation,
  penetration_effective_resist: evalPenetrationEffectiveResist,
  crit_expected_damage: evalCritExpectedDamage,
  attack_speed_scaling: evalAttackSpeedScaling,
  dps_auto_attack: evalDpsAutoAttack,
  interest_break: evalInterestBreak,
  level_timing: evalLevelTiming,
  shop_odds: evalShopOdds,
  roll_probability: evalRollProbability,
  roll_down_budget: evalRollDownBudget,
  defensive_marginal_value: evalDefensiveMarginalValue,
  stat_modifier_value: evalStatModifierValue,
  item_marginal_value: evalItemMarginalValue,
  reward_choice_score: evalRewardChoiceScore,
  augment_direction_score: evalAugmentDirectionScore,
  trait_delta: evalTraitDelta,
  unit_quality_score: evalUnitQualityScore,
  component_completion: evalComponentCompletion,
  trait_breakpoint_distance: evalTraitBreakpointDistance,
  hp_lethal_tolerance: evalHpLethalTolerance,
  action_feasibility: evalActionFeasibility,
  operation_time_budget: evalOperationTimeBudget,
  positioning_risk: evalPositioningRisk,
  board_trait_count: evalBoardTraitCount,
  mana_cycle: evalManaCycle,
  attacks_to_cast: evalAttacksToCast,
  cast_frequency: evalCastFrequency,
  damage_amp_stack: evalDamageAmpStack,
  damage_mix: evalDamageMix,
  double_cast_effectiveness: evalDoubleCastEffectiveness,
  economy: evalEconomy,
  healing_effective_hp: evalHealingEffectiveHp,
  shield_effective_hp: evalShieldEffectiveHp,
  contest_adjusted_pool: evalContestAdjustedPool,
  shop_specific_unit_odds: evalShopSpecificUnitOdds,
  item_conflict_penalty: evalItemConflictPenalty,
  item_stat_delta: evalItemStatDelta,
  resource_exchange: evalResourceExchange,
  comp_gap_score: evalCompGapScore,
  effect_block_value: evalEffectBlockValue,
  encounter_rule_shift: evalEncounterRuleShift,
  pivot_cost: evalPivotCost,
  review_attribution_score: evalReviewAttributionScore,
  player_habit_bias: evalPlayerHabitBias,
  scouting_priority_score: evalScoutingPriorityScore,
  skill_value_scaling: evalSkillValueScaling,
  star_upgrade_delta: evalStarUpgradeDelta,
  streak_value: evalStreakValue,
  summon_scaling: evalSummonScaling,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , name, rawInput = "{}"] = process.argv;
  const result = await evaluateFormula(name, JSON.parse(rawInput));
  console.log(JSON.stringify(result, null, 2));
}
