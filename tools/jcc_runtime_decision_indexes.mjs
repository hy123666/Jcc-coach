function rows(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(rows(values).filter(Boolean).map(String))].sort();
}

function derivedAddress(entity, kind) {
  const parts = String(entity?.address || "").split(":");
  if (parts.length >= 4) return `${parts[0]}:${parts[1]}:${kind}:${entity.id}`;
  return `jcc:common:${kind}:${entity?.id || "unknown"}`;
}

function effectText(entity) {
  return [
    entity?.name,
    entity?.basic_desc,
    entity?.desc,
    entity?.skill?.name,
    entity?.skill?.effects?.source_text,
    entity?.effects?.source_text,
    entity?.text?.prefix,
    entity?.text?.desc2,
  ].filter(Boolean).join(" ");
}

const metricTags = Object.freeze({
  ability_power: ["magic_damage"],
  armor: ["armor", "frontline"],
  attack_damage: ["physical_damage"],
  attack_speed: ["attack_speed"],
  critical_strike: ["critical_strike"],
  damage_amp: ["damage_amp"],
  damage_reduction: ["damage_reduction", "frontline"],
  health: ["health", "frontline"],
  magic_resist: ["magic_resist", "frontline"],
  mana_regen: ["mana"],
  omnivamp: ["omnivamp", "sustain"],
});

const textTagRules = Object.freeze([
  [/魔法伤害|法术加成/u, "magic_damage"],
  [/物理伤害|物理加成/u, "physical_damage"],
  [/真实伤害/u, "true_damage"],
  [/护盾/u, "shield"],
  [/唯一|只能装备.{0,8}一件|每位英雄仅限1件|每个弈子仅可装备1件/u, "unique_or_limited"],
  [/治疗|回复.*生命|生命回复/u, "healing"],
  [/眩晕|击飞|定身|沉默|嘲讽|控制/u, "control"],
  [/范围|邻格|所有敌人|多个敌人/u, "aoe"],
  [/法力|回蓝/u, "mana"],
  [/每次攻击|普攻|攻击时|攻击后|攻击造成/u, "trigger_basic_attack"],
  [/施放|施法|技能后/u, "trigger_cast"],
  [/战斗开始/u, "trigger_combat_start"],
  [/击杀|参与击败|目标倒下/u, "trigger_kill"],
  [/生命值低于|降至.{0,8}生命值|低于.{0,8}生命值/u, "condition_low_health"],
  [/(?:仅限|仅适用于|适合|适用于|携带者.{0,8})(?:近战弈子|近战单位|近战英雄)/u, "requires_melee"],
  [/(?:仅限|仅适用于|适合|适用于|携带者.{0,8})(?:远程弈子|远程单位|远程英雄)/u, "requires_ranged"],
  [/攻速|攻击速度/u, "attack_speed"],
  [/攻速(?:锁定|固定)|攻击速度(?:锁定|固定)|锁定为\s*0\.5/u, "attack_speed_locked"],
  [/锁定|覆盖/u, "stat_override"],
  [/金币|利息|经济/u, "economy"],
  [/重伤/u, "wound"],
  [/护甲(?:削减|击碎)|破甲|护甲.{0,8}降低|降低.{0,8}护甲/u, "armor_shred"],
  [/魔抗(?:削减|击碎)|破魔|魔抗.{0,8}降低|降低.{0,8}魔抗/u, "magic_resist_shred"],
  [/暴击/u, "critical_strike"],
  [/削减.*魔抗|魔抗削减/u, "shred"],
  [/削减.*护甲|护甲削减/u, "sunder"],
]);

function semanticTags(entity) {
  const values = [...rows(entity?.tags)];
  for (const stat of rows(entity?.structured_stats)) values.push(...(metricTags[stat?.metric] || []));
  const text = effectText(entity);
  for (const [pattern, tag] of textTagRules) if (pattern.test(text)) values.push(tag);
  return unique(values);
}

function firstStarStat(champion, name, fallback = 0) {
  const values = champion?.attributes_by_star?.[name];
  const value = Array.isArray(values) ? Number(values[0]) : Number(values);
  return Number.isFinite(value) ? value : fallback;
}

function championProfile(champion) {
  const tags = semanticTags(champion);
  const range = firstStarStat(champion, "攻击距离", 1);
  const health = firstStarStat(champion, "生命", 0);
  const armor = firstStarStat(champion, "护甲", 0);
  const magicResist = firstStarStat(champion, "魔抗", 0);
  const maxMana = firstStarStat(champion, "法力值", 0);
  const hasMagic = tags.includes("magic_damage");
  const hasPhysical = tags.includes("physical_damage");
  const hasTrue = tags.includes("true_damage");
  const outputType = hasTrue && (hasMagic || hasPhysical)
    ? "true_or_mixed"
    : hasTrue
      ? "true"
      : hasMagic && hasPhysical
        ? "mixed"
        : hasMagic
          ? "magic"
          : hasPhysical
            ? "physical"
            : "mixed";
  const defensive = tags.includes("shield") || tags.includes("healing") || health >= 900 || armor + magicResist >= 100;
  const role = range >= 3
    ? (outputType === "magic" ? "ap_carry" : "ranged_carry")
    : defensive
      ? "frontline"
      : "melee";
  return {
    tags,
    range,
    role,
    output_type: outputType,
    cadence: maxMana > 0 ? "caster" : "basic_attacker",
  };
}

function strategyWeights({ tags, role, cost = 0 }) {
  const has = (tag) => tags.includes(tag);
  const weights = {
    immediate_power: Math.min(50, Math.max(0, Number(cost) * 5)),
    cap_power: Math.min(50, Math.max(0, Number(cost) * 8)),
    economy: has("economy") ? 30 : 0,
    tempo: has("attack_speed") || has("mana") ? 18 : 8,
    frontline: role === "frontline" ? 45 : has("frontline") ? 28 : 0,
    backline_damage: role?.includes("carry") ? 43 : has("magic_damage") || has("physical_damage") ? 24 : 0,
    utility: has("wound") || has("shred") || has("sunder") ? 24 : 8,
    sustain: has("healing") || has("shield") || has("omnivamp") || has("sustain") ? 28 : 0,
    control: has("control") ? 30 : 0,
    positioning: has("aoe") ? 12 : 0,
    pivot: 8,
    risk: 0,
  };
  const primaryAxes = Object.entries(weights)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([key]) => key);
  return { weights, primary_axes: primaryAxes, policy: "Deterministic semantic prior; current patch facts, rankings, and live state override it." };
}

function itemFit(item, champion, profile) {
  const tags = semanticTags(item);
  const metrics = new Set(rows(item.structured_stats).map((entry) => entry?.metric).filter(Boolean));
  let score = 8 + Math.min(15, Number(champion.cost || 0) * 3);
  const reasons = [];
  const add = (condition, points, reason) => {
    if (!condition) return;
    score += points;
    reasons.push(reason);
  };
  add(profile.role === "frontline" && ["health", "armor", "magic_resist", "damage_reduction"].some((key) => metrics.has(key)), 26, "frontline_stats");
  add(profile.role === "ap_carry" && (metrics.has("ability_power") || tags.includes("magic_damage")), 24, "ap_damage_stats");
  add(profile.role === "ap_carry" && metrics.has("mana_regen"), 16, "caster_startup");
  add(profile.role === "ranged_carry" && (metrics.has("attack_damage") || metrics.has("attack_speed") || metrics.has("critical_strike")), 24, "physical_carry_fit");
  add(profile.role === "melee" && (metrics.has("attack_damage") || metrics.has("attack_speed") || metrics.has("omnivamp")), 18, "melee_damage_fit");
  add((profile.role === "melee" || profile.role === "frontline") && (metrics.has("health") || metrics.has("armor") || metrics.has("magic_resist")), 14, "survival_fit");
  add(tags.includes("wound") || tags.includes("shred") || tags.includes("sunder"), 10, "team_utility");
  add(tags.includes("component"), 5, "component_temporary_value");
  add(tags.includes("emblem"), -6, "formation_dependent_emblem");
  return {
    champion_address: champion.address,
    champion_name: champion.name,
    cost: champion.cost,
    role: profile.role,
    output_type: profile.output_type,
    fit_score: Math.max(0, Math.min(100, score)),
    fit_reasons: unique(reasons),
  };
}

function entityWeightRow(kind, entity, tags, role = null, cost = 0) {
  const strategy = strategyWeights({ tags, role, cost });
  const addressParts = String(entity?.address || "").split(":");
  const strategyAddress = addressParts.length >= 4
    ? `${addressParts[0]}:${addressParts[1]}:entity_strategy_weights:${kind}_${entity.id}`
    : `jcc:common:entity_strategy_weights:${kind}_${entity?.id || "unknown"}`;
  return {
    address: strategyAddress,
    entity_kind: kind,
    entity_address: entity.address,
    entity_name: entity.name,
    strategy_weights: strategy,
    primary_axes: strategy.primary_axes,
    policy: strategy.policy,
  };
}

function recipeComponentCounts(item) {
  const counts = new Map();
  for (const id of rows(item?.recipe?.component_ids).map(String).filter(Boolean)) {
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()].map(([id, count]) => ({ id, count }));
}

function buildComponentCandidates(items) {
  const components = items.filter((item) => semanticTags(item).includes("component"));
  return components.map((component) => ({
    address: derivedAddress(component, "component_candidates"),
    component_address: component.address,
    component_name: component.name,
    candidates: items
      .filter((item) => rows(item?.recipe?.component_ids).map(String).includes(String(component.id)))
      .map((item) => {
        const componentIds = rows(item.recipe.component_ids).map(String);
        const ownIndex = componentIds.indexOf(String(component.id));
        return {
          item_address: item.address,
          item_name: item.name,
          item_tags: semanticTags(item),
          required_component_counts: recipeComponentCounts(item),
          other_component_ids: componentIds.filter((_, index) => index !== ownIndex),
        };
      })
      .sort((left, right) => left.item_name.localeCompare(right.item_name, "zh-CN")),
  }));
}

function buildItemWaitCost(items) {
  const completedItems = items.filter((item) => rows(item?.recipe?.component_ids).length > 0);
  return items
    .filter((item) => semanticTags(item).includes("component"))
    .map((component) => ({
      address: derivedAddress(component, "item_wait_cost"),
      component_address: component.address,
      component_name: component.name,
      possible_completed_items: completedItems
        .filter((item) => rows(item.recipe.component_ids).map(String).includes(String(component.id)))
        .map((item) => ({ item_address: item.address, name: item.name, tags: semanticTags(item) })),
      wait_cost_inputs: ["current_streak", "hp", "round", "component_probability_future", "immediate_power_delta"],
    }));
}

function buildItemConflicts(items) {
  return items.map((item) => {
    const tags = semanticTags(item);
    const text = effectText(item);
    const attackSpeedLocked = /攻速(?:锁定|固定)|攻击速度(?:锁定|固定)|锁定为\s*0\.5/u.test(text);
    const preservedEffects = unique([
      ...rows(item?.structured_stats).map((stat) => stat?.metric),
      ...( /免疫|无法被控制|不受控制/u.test(text) ? ["status_immunity"] : []),
      ...( /眩晕|晕眩|击飞|定身|沉默|嘲讽/u.test(text) ? ["control"] : []),
      ...( /伤害增幅|伤害提升|造成额外伤害/u.test(text) ? ["damage_amp"] : []),
      ...( /移动速度|移速/u.test(text) ? ["movement_speed"] : []),
    ].filter((effect) => effect && effect !== "attack_speed"));
    const effectTags = unique([
      ...(tags.includes("wound") ? ["effect.wound"] : []),
      ...(tags.includes("armor_shred") ? ["effect.armor_shred"] : []),
      ...(tags.includes("magic_resist_shred") ? ["effect.magic_resist_shred"] : []),
      ...(tags.includes("critical_strike") ? ["effect.crit_chance"] : []),
      ...(tags.includes("mana") ? ["effect.mana_gain"] : []),
      ...(tags.includes("attack_speed") ? ["effect.attack_speed"] : []),
    ]);
    const triggerTags = unique([
      ...(tags.includes("trigger_basic_attack") ? ["trigger.basic_attack"] : []),
      ...(tags.includes("trigger_cast") ? ["trigger.cast"] : []),
      ...(tags.includes("trigger_combat_start") ? ["trigger.combat_start"] : []),
      ...(tags.includes("trigger_kill") ? ["trigger.kill"] : []),
    ]);
    const conditionTags = unique([
      ...(tags.includes("condition_low_health") ? ["condition.requires_low_health"] : []),
      ...(tags.includes("requires_melee") ? ["condition.requires_melee"] : []),
      ...(tags.includes("requires_ranged") ? ["condition.requires_ranged"] : []),
      ...(tags.includes("unique_or_limited") ? ["condition.requires_item_slot"] : []),
    ]);
    const constraints = attackSpeedLocked
      ? [{
          metric: "attack_speed",
          mode: "locked",
          value: 0.5,
          unit: "absolute",
          source_text: text.match(/[^。；]*?(?:攻速|攻击速度)[^。；]*?(?:锁定|固定)[^。；]*/u)?.[0] || text,
        }]
      : [];
    return {
      address: derivedAddress(item, "item_conflict"),
      item_address: item.address,
      name: item.name,
      conflicts: [
        ...(attackSpeedLocked ? ["attack_speed_override"] : []),
        ...(tags.includes("wound") ? ["duplicate_wound_low_value"] : []),
        ...(tags.includes("mana") ? ["too_many_startup_items_can_reduce_damage_slots"] : []),
        ...(tags.includes("slot_pressure") ? ["uses_multiple_item_slots"] : []),
        ...(tags.includes("unique_or_limited") ? ["unique_or_limited_effect"] : []),
      ],
      constraints,
      blocked_effects: attackSpeedLocked ? ["attack_speed"] : [],
      preserved_effects: attackSpeedLocked ? preservedEffects : [],
      effect_tags: effectTags,
      trigger_tags: triggerTags,
      condition_tags: conditionTags,
      semantic_relations: attackSpeedLocked
        ? [{ relation: "relation.overrides", target: "effect.attack_speed", value: 0.5 }]
        : [],
      confidence: "deterministic_semantic_heuristic",
    };
  });
}

function buildItemHolders(items, itemHolderFit) {
  const fitByItem = new Map(itemHolderFit.map((entry) => [entry.item_address, entry]));
  return items.map((item) => {
    const fit = fitByItem.get(item.address);
    const candidates = rows(fit?.candidate_holders);
    const role = candidates[0]?.role || "flex";
    return {
      address: derivedAddress(item, "item_holder"),
      item_address: item.address,
      role,
      temporary_holder_candidates: candidates.slice(0, 10).map((candidate) => ({
        champion_address: candidate.champion_address,
        name: candidate.champion_name,
        reason: candidate.fit_reasons?.[0] || role,
      })),
      confidence: "deterministic_semantic_candidate_ranking",
    };
  });
}

export function buildRuntimeDecisionIndexes({ champions = [], traits = [], items = [], augments = [] } = {}) {
  const championProfiles = new Map(champions.map((champion) => [champion.id, championProfile(champion)]));
  const championDamageProfile = champions.map((champion) => {
    const profile = championProfiles.get(champion.id);
    return {
      address: derivedAddress(champion, "champion_damage_profile"), champion_address: champion.address,
      name: champion.name, cost: champion.cost, output_type: profile.output_type, cadence: profile.cadence,
      tags: profile.tags, confidence: "deterministic_semantic_heuristic",
    };
  });
  const championRoleProfile = champions.map((champion) => {
    const profile = championProfiles.get(champion.id);
    return {
      address: derivedAddress(champion, "champion_role_profile"), champion_address: champion.address,
      name: champion.name, role: profile.role, range: profile.range, cost: champion.cost,
      tags: profile.tags, confidence: "deterministic_semantic_heuristic",
    };
  });
  const itemHolderFit = items.map((item) => {
    const candidateHolders = champions
      .map((champion) => itemFit(item, champion, championProfiles.get(champion.id)))
      .sort((left, right) => right.fit_score - left.fit_score || right.cost - left.cost || left.champion_name.localeCompare(right.champion_name, "zh-CN"))
      .slice(0, 24);
    return {
      address: derivedAddress(item, "item_holder_fit"), item_address: item.address, item_name: item.name,
      item_type: item.type, item_tags: semanticTags(item), candidate_holders: candidateHolders,
      related_formulas: [], exactness: "deterministic_semantic_candidate_ranking",
    };
  });
  const championItemFit = champions.map((champion) => {
    const profile = championProfiles.get(champion.id);
    return {
      address: derivedAddress(champion, "champion_item_fit"), champion_address: champion.address,
      champion_name: champion.name, cost: champion.cost, role: profile.role, output_type: profile.output_type,
      item_candidates: items.map((item) => {
        const fit = itemFit(item, champion, profile);
        return {
          item_address: item.address,
          item_name: item.name,
          item_type: item.type,
          item_tags: semanticTags(item),
          fit_score: fit.fit_score,
          fit_reasons: fit.fit_reasons,
        };
      })
        .sort((left, right) => right.fit_score - left.fit_score || left.item_name.localeCompare(right.item_name, "zh-CN"))
        .slice(0, 24),
      exactness: "deterministic_semantic_candidate_ranking",
    };
  });
  const traitBreakpoints = traits.map((trait) => ({
    address: derivedAddress(trait, "trait_breakpoints"), trait_address: trait.address, name: trait.name,
    breakpoints: rows(trait.breakpoints).map((breakpoint) => ({
      ...breakpoint,
      tags: semanticTags({ name: trait.name, desc: breakpoint.effect }),
      values: [],
      effect_block: {
        address: `${derivedAddress(trait, "trait_breakpoint_effect_block")}_${breakpoint.level}`,
        raw: breakpoint.effect,
        values: [],
        numeric_values: [...String(breakpoint.effect || "").matchAll(/-?\d+(?:\.\d+)?/gu)].map((match) => Number(match[0])),
        effect_types: semanticTags({ desc: breakpoint.effect }),
        tags: semanticTags({ desc: breakpoint.effect }),
        formula_refs: [],
        parse_status: "structured_source_text",
      },
    })),
    tags: semanticTags(trait),
  }));
  const traitUnitMatrix = traits.map((trait) => {
    const members = champions.filter((champion) => rows(champion.traits).some((entry) => String(entry?.id) === String(trait.id)));
    const emblems = items.filter((item) => semanticTags(item).includes("emblem") && String(item.name).includes(trait.name));
    return {
      address: derivedAddress(trait, "trait_unit_matrix"), trait_address: trait.address, trait_name: trait.name,
      breakpoints: rows(trait.breakpoints).map((entry) => ({ count: entry.count, tags: semanticTags({ desc: entry.effect }), values: [] })),
      members: members.map((champion) => {
        const profile = championProfiles.get(champion.id);
        return { champion_address: champion.address, name: champion.name, cost: champion.cost, role: profile.role, output_type: profile.output_type };
      }),
      emblem_candidates: emblems.map((item) => ({ item_address: item.address, name: item.name })),
      exactness: "official_membership_plus_deterministic_semantic_roles",
    };
  });
  const entityStrategyWeights = [
    ...champions.map((entity) => {
      const profile = championProfiles.get(entity.id);
      return entityWeightRow("champion", entity, profile.tags, profile.role, entity.cost);
    }),
    ...traits.map((entity) => entityWeightRow("trait", entity, semanticTags(entity))),
    ...items.map((entity) => entityWeightRow("item", entity, semanticTags(entity))),
    ...augments.map((entity) => entityWeightRow("augment", entity, semanticTags(entity))),
  ];
  const componentToItemCandidates = buildComponentCandidates(items);
  const itemWaitCost = buildItemWaitCost(items);
  return {
    champion_damage_profile: championDamageProfile,
    champion_role_profile: championRoleProfile,
    champion_item_fit: championItemFit,
    item_holder_fit: itemHolderFit,
    item_holders: buildItemHolders(items, itemHolderFit),
    item_conflicts: buildItemConflicts(items),
    component_to_item_candidates: componentToItemCandidates,
    item_wait_cost: itemWaitCost,
    trait_breakpoints: traitBreakpoints,
    trait_unit_matrix: traitUnitMatrix,
    entity_strategy_weights: entityStrategyWeights,
  };
}
