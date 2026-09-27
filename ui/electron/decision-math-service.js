import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildKnowledgeRelationIndex, queryKnowledgeRelationIndex } from "./knowledge-relation-index.js";

import { evaluateFormula } from "../../tools/jcc-formula-evaluator.mjs";
import {
  evaluateLineupFeasibility,
  getLineupArchetypePolicy,
} from "../../tools/jcc-lineup-feasibility-engine.mjs";
import {
  buildMechanicalExpansionPlan,
  buildSemanticSeed,
} from "../../tools/jcc-semantic-seed.mjs";

export const DECISION_MATH_SERVICE_SCHEMA = "jcc-decision-math-service-v1";

const ATTRIBUTE_KEYS = Object.freeze({
  "生命": "hp",
  "暴击率": "crit_chance",
  "护甲": "armor",
  "攻击距离": "attack_range",
  "魔抗": "magic_resist",
  "初始法力值": "initial_mana",
  "物攻": "attack_damage",
  "法力值": "max_mana",
  "攻速": "attack_speed",
});

const STATIC_POINT_METRICS = new Set([
  "ability_power",
  "armor",
  "attack_damage",
  "attack_range",
  "crit_chance",
  "hp",
  "magic_resist",
  "max_mana",
]);

const STATIC_PERCENT_METRICS = new Set([
  "attack_damage",
  "attack_speed",
]);

const AMBIGUOUS_ATTRIBUTE_ALIAS_TERMS = new Set([
  "攻速",
  "护甲",
  "魔抗",
  "攻击",
  "法强",
  "血量",
  "生命",
]);

const QUESTION_MATH_PATTERN = /(法强|法术加成|攻击力|物攻|护甲|魔抗|攻速|攻击速度|生命值|最大生命|初始法力|几下|几次普攻|施法|启动|刷新概率|抽到|搜到|D到|牌库|升星|几张|扣.{0,8}血|掉.{0,8}血|玩家伤害|失败伤害|收入|利息|连胜|连败|经验|升级|升人口|上人口|买级|单次伤害|期望伤害|暴击伤害|击杀次数|最优装备|最好装备|装备.*最大化|伤害最大化|施法频率最大化)/i;

const DIRECT_COMMON_OPERATIONS = new Set(["damage", "pvp_player_damage", "economy", "level_timing"]);

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function shopPoolRows(value) {
  if (Array.isArray(value)) {
    return value.map((row, index) => row && typeof row === "object"
      ? row
      : { cost: index + 1, copies_per_champion: row });
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([cost, row]) => row && typeof row === "object"
    ? { cost: row.cost ?? Number(cost), ...row }
    : { cost: Number(cost), copies_per_champion: row });
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

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stableJson(value) {
  const normalizeObject = (input) => {
    if (Array.isArray(input)) return input.map(normalizeObject);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.keys(input)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, normalizeObject(input[key])]));
  };
  return JSON.stringify(normalizeObject(value));
}

function sha256(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sha256Raw(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error?.code === "ENOENT") return clone(fallback);
    throw error;
  }
}

function indexEntities(rows, aliasRows = [], kind = null) {
  const byId = new Map();
  const byName = new Map();
  const byAddress = new Map();
  const mentionEntries = [];
  for (const row of rows) {
    for (const key of [row?.id, row?.address, row?.mumu_base_id, ...(row?.raw_refs?.raw_star_ids || [])]) {
      if (key != null && String(key).trim()) byId.set(String(key), row);
    }
    const key = normalize(row?.name);
    if (key) {
      byName.set(key, [...(byName.get(key) || []), row]);
      mentionEntries.push({ term: row.name, normalized_term: key, row, canonical: true });
    }
    if (row?.address) byAddress.set(String(row.address), row);
  }
  for (const alias of aliasRows) {
    if (kind && alias?.ref?.kind !== kind) continue;
    const row = byAddress.get(String(alias?.ref?.address || "")) || byId.get(String(alias?.ref?.id || ""));
    const key = normalize(alias?.alias);
    if (!row || !key) continue;
    const matches = byName.get(key) || [];
    if (!matches.some((candidate) => candidate === row)) byName.set(key, [...matches, row]);
    mentionEntries.push({
      term: alias.alias,
      normalized_term: key,
      row,
      canonical: false,
      auto_confirm: alias.auto_confirm === true,
      evidence_kind: alias.evidence_kind || null,
      source: alias.source || null,
    });
  }
  return { rows, byId, byName, mentionEntries };
}

function resolveEntity(index, reference, kind) {
  if (reference && typeof reference === "object" && !Array.isArray(reference)) {
    const explicit = reference.id ?? reference.address ?? reference.name;
    return resolveEntity(index, explicit, kind);
  }
  const raw = String(reference ?? "").trim();
  if (!raw) return { status: "missing", kind, reference: raw, matches: [] };
  const byId = index.byId.get(raw);
  if (byId) return { status: "resolved", kind, reference: raw, entity: byId };
  const matches = index.byName.get(normalize(raw)) || [];
  if (matches.length === 1) return { status: "resolved", kind, reference: raw, entity: matches[0] };
  return {
    status: matches.length > 1 ? "ambiguous" : "not_found",
    kind,
    reference: raw,
    matches: matches.map((row) => ({ id: row.id, name: row.name, address: row.address })),
  };
}

function findMentionMatches(text, index, kind) {
  const source = normalize(text);
  const matches = [];
  const seen = new Set();
  for (const entry of index.mentionEntries || index.rows.map((row) => ({
    normalized_term: normalize(row.name), row,
  }))) {
    if (!entry.normalized_term) continue;
    const identity = String(entry.row?.address || entry.row?.id || entry.row?.name || "");
    if (!identity) continue;
    let start = source.indexOf(entry.normalized_term);
    while (start >= 0) {
      const matchIdentity = `${identity}:${start}:${entry.normalized_term}`;
      if (!seen.has(matchIdentity)) {
        seen.add(matchIdentity);
        matches.push({
          kind,
          row: entry.row,
          term: entry.term || entry.row?.name || entry.normalized_term,
          normalized_term: entry.normalized_term,
          canonical: entry.canonical === true,
          auto_confirm: entry.auto_confirm === true,
          evidence_kind: entry.evidence_kind || null,
          source: entry.source || null,
          start,
          end: start + entry.normalized_term.length,
          length: entry.normalized_term.length,
        });
      }
      start = source.indexOf(entry.normalized_term, start + entry.normalized_term.length);
    }
  }
  return matches;
}

function selectEntityMentions(text, catalogs, { preserveAmbiguity = false } = {}) {
  const source = normalize(text);
  const singleCharacterAliasHasEntityContext = (match) => {
    if (match.length !== 1 || match.canonical) return true;
    const prefix = source.slice(Math.max(0, match.start - 2), match.start);
    const suffix = source.slice(match.end);
    const precedingBoundary = match.start === 0
      || /[，。？！、,.;:：；！？]/u.test(source[match.start - 1])
      || /(用|玩|拿|上|找|追|有|换|卖|买)$/u.test(prefix);
    const followingBoundary = match.end === source.length
      || /^[，。？！、,.;:：；！？]/u.test(suffix)
      || /^(怎么|适合|出装|技能|羁绊|装备|几费|是谁|主c|主t|做|当|来|和|与)/iu.test(suffix);
    return precedingBoundary && followingBoundary;
  };
  const matches = Object.entries(catalogs)
    .flatMap(([kind, index]) => findMentionMatches(text, index, kind))
    .filter((entry) => entry.canonical || entry.evidence_kind !== "first_chars")
    .filter(singleCharacterAliasHasEntityContext)
    .sort((left, right) => right.length - left.length
      || Number(right.canonical) - Number(left.canonical)
      || left.start - right.start
      || String(left.row?.name).localeCompare(String(right.row?.name), "zh-CN"));
  const accepted = [];
  for (const match of matches) {
    if (accepted.some((entry) => match.start < entry.end && match.end > entry.start
      && !(preserveAmbiguity && match.start === entry.start && match.end === entry.end))) continue;
    accepted.push(match);
  }
  return accepted.sort((left, right) => left.start - right.start || right.length - left.length);
}

function championBaseStats(champion, star, parameters) {
  const starIndex = Math.max(0, Math.min(3, Number(star || 1) - 1));
  const output = {
    ability_power: finiteNumber(parameters?.combat_defaults?.base_ability_power, 100),
  };
  const legacyStats = asArray(champion?.stats_by_star)[starIndex]
    || asArray(champion?.stats_by_star)[0]
    || null;
  if (legacyStats) {
    Object.assign(output, {
      hp: finiteNumber(legacyStats.hp),
      attack_damage: finiteNumber(legacyStats.ad),
      attack_speed: finiteNumber(legacyStats.attack_speed),
      armor: finiteNumber(legacyStats.armor),
      magic_resist: finiteNumber(legacyStats.magic_resist),
      attack_range: finiteNumber(legacyStats.range),
      crit_chance: finiteNumber(legacyStats.crit_chance_pct),
      initial_mana: finiteNumber(legacyStats.initial_mana),
      max_mana: finiteNumber(legacyStats.max_mana),
    });
  }
  for (const [sourceKey, targetKey] of Object.entries(ATTRIBUTE_KEYS)) {
    const values = asArray(champion?.attributes_by_star?.[sourceKey]);
    const value = finiteNumber(values[starIndex] ?? values[0]);
    if (value != null) output[targetKey] = value;
  }
  return output;
}

function metricModifier(metric, source, extra = {}) {
  const normalizedMetric = {
    health: "hp",
    critical_strike: "crit_chance",
  }[metric.metric] || metric.metric;
  return {
    source_kind: source.kind,
    source_id: source.entity.id,
    source_name: source.entity.name,
    metric: normalizedMetric,
    value: finiteNumber(metric.value, 0),
    unit: metric.unit || "points",
    source_text: metric.source_text || null,
    ...extra,
  };
}

function collectEntityModifiers(source) {
  const modifiers = [];
  const conditional = [];
  for (const metric of asArray(source.entity?.structured_stats)) {
    modifiers.push(metricModifier(metric, source, { activation: "unconditional_static_stat" }));
  }
  const legacyStats = source.entity?.stats && typeof source.entity.stats === "object"
    ? source.entity.stats
    : {};
  for (const [sourceMetric, value] of Object.entries(legacyStats)) {
    const metric = {
      ad: "attack_damage",
      ap: "ability_power",
      attack_speed: "attack_speed",
      armor: "armor",
      magic_resist: "magic_resist",
      hp: "hp",
      mana: "max_mana",
      crit_chance: "crit_chance",
    }[sourceMetric];
    if (!metric) continue;
    modifiers.push(metricModifier({
      metric,
      value,
      unit: sourceMetric === "attack_speed" ? "percent" : "points",
      source_text: `${sourceMetric}:${value}`,
    }, source, { activation: "unconditional_static_stat_legacy_adapter" }));
  }
  for (const term of asArray(source.entity?.effects?.structured_terms)) {
    const trigger = term?.trigger?.kind || "unknown";
    for (const metric of asArray(term?.metrics)) {
      const row = metricModifier(metric, source, {
        trigger,
        activation: trigger === "basic_attack"
          ? "per_basic_attack"
          : term?.activation === "unconditional_static" ? "unconditional_static" : "condition_required",
        condition_text: term.source_text || source.entity?.effects?.source_text || null,
      });
      if (row.activation === "unconditional_static") modifiers.push(row);
      else conditional.push(row);
    }
  }
  for (const tag of asArray(source.entity?.effects?.conditional_tags)) {
    conditional.push({
      source_kind: source.kind,
      source_id: source.entity.id,
      source_name: source.entity.name,
      activation: "semantic_condition_not_mechanically_applied",
      trigger: tag.kind || "unknown",
      condition_text: tag.source_text || null,
    });
  }
  return { modifiers, conditional };
}

function applyStaticModifiers(baseStats, modifiers) {
  const stats = { ...baseStats };
  const applied = [];
  const unresolved = [];
  for (const modifier of modifiers) {
    const metric = modifier.metric;
    if (modifier.unit === "points" && STATIC_POINT_METRICS.has(metric)) {
      stats[metric] = finiteNumber(stats[metric], 0) + modifier.value;
      applied.push(modifier);
      continue;
    }
    if (modifier.unit === "percent" && STATIC_PERCENT_METRICS.has(metric)) {
      stats[metric] = finiteNumber(stats[metric], 0) * (1 + modifier.value / 100);
      applied.push(modifier);
      continue;
    }
    if (modifier.unit === "percent" && metric === "ability_power") {
      stats[metric] = finiteNumber(stats[metric], 100) + modifier.value;
      applied.push(modifier);
      continue;
    }
    if (modifier.unit === "percent" && metric === "crit_chance") {
      stats[metric] = finiteNumber(stats[metric], 0) + modifier.value;
      applied.push(modifier);
      continue;
    }
    if (modifier.unit === "percent" && metric === "damage_amp") {
      stats[metric] = finiteNumber(stats[metric], 0) + modifier.value;
      applied.push(modifier);
      continue;
    }
    if (modifier.unit === "percent" && metric === "hp") {
      stats[metric] = finiteNumber(stats[metric], 0) * (1 + modifier.value / 100);
      applied.push(modifier);
      continue;
    }
    unresolved.push(modifier);
  }
  return { stats, applied, unresolved };
}

function itemCategory(item) {
  const type = String(item?.type || item?.item_type || "");
  const tags = new Set(asArray(item?.tags).map((tag) => String(tag).toLowerCase()));
  if (tags.has("support") || type === "辅助装备" || type === "支援装备") return "support";
  if (tags.has("artifact") || type.includes("神器")) return "artifact";
  if (tags.has("radiant") || type.includes("光明")) return "radiant";
  if (tags.has("emblem") || type.includes("纹章")) return "emblem";
  if (tags.has("special") || type.includes("特殊")) return "special";
  if (tags.has("completed") || type.includes("成型") || type.includes("成装")) return "completed";
  return "other";
}

const COMPATIBILITY_EFFECTS = Object.freeze([
  "wound",
  "armor_shred",
  "magic_resist_shred",
  "penetration",
  "crit_chance",
  "mana_gain",
]);

function semanticCompatibilityProfile(entity) {
  const text = [
    entity?.name,
    entity?.basic_desc,
    entity?.desc,
    entity?.effects?.source_text,
    entity?.skill?.effects?.source_text,
  ].filter(Boolean).join(" ");
  const structuredMetrics = asArray(entity?.structured_stats)
    .map((stat) => ({
      attack_speed: "attack_speed",
      critical_strike: "crit_chance",
      mana_regen: "mana_gain",
    }[stat?.metric] || stat?.metric))
    .filter(Boolean);
  const effects = new Set(structuredMetrics);
  const triggers = new Set();
  const conditions = new Set();
  if (/重伤/u.test(text)) effects.add("wound");
  if (/护甲(?:削减|击碎)|破甲|护甲.{0,8}降低|降低.{0,8}护甲/u.test(text)) effects.add("armor_shred");
  if (/魔抗(?:削减|击碎)|破魔|魔抗.{0,8}降低|降低.{0,8}魔抗/u.test(text)) effects.add("magic_resist_shred");
  if (/穿透/u.test(text)) effects.add("penetration");
  if (/暴击/u.test(text)) effects.add("crit_chance");
  if (/回蓝|法力回复|获得(?:了)?\s*\d*法力|回复.{0,8}法力/u.test(text)) effects.add("mana_gain");
  if (/每次攻击|普攻|攻击时|攻击后|攻击造成/u.test(text)) triggers.add("basic_attack");
  if (/施放|施法|技能后/u.test(text)) triggers.add("cast");
  if (/战斗开始/u.test(text)) triggers.add("combat_start");
  if (/击杀|参与击败|目标倒下/u.test(text)) triggers.add("kill");
  if (/生命值低于|降至.{0,8}生命值|低于.{0,8}生命值/u.test(text)) conditions.add("low_health");
  if (/(?:仅限|仅适用于|适合|适用于|携带者.{0,8})(?:近战弈子|近战单位|近战英雄)/u.test(text)) conditions.add("melee");
  if (/(?:仅限|仅适用于|适合|适用于|携带者.{0,8})(?:远程弈子|远程单位|远程英雄)/u.test(text)) conditions.add("ranged");
  if (/唯一|只能装备.{0,8}一件|每位英雄仅限1件|每个弈子仅可装备1件/u.test(text)) conditions.add("unique_item_slot");
  return {
    text,
    effects: [...effects].filter(Boolean),
    triggers: [...triggers],
    conditions: [...conditions],
    nonStacking: /不会叠加|不能叠加|不叠加/u.test(text),
  };
}

function compatibilityEffectLabel(effect) {
  return {
    wound: "重伤",
    armor_shred: "护甲削减/破甲",
    magic_resist_shred: "魔抗削减/破魔",
    penetration: "穿透",
    crit_chance: "暴击",
    mana_gain: "启动/法力",
  }[effect] || effect;
}

function requestedItemCategories(request = {}) {
  const explicit = asArray(request.allowed_item_categories).map((value) => String(value)).filter(Boolean);
  return explicit.length ? [...new Set(explicit)] : ["completed"];
}

function itemCategoriesFromQuery(query) {
  const text = String(query || "").normalize("NFKC");
  const categories = [];
  if (/(普通装备|常规装备|成装|可合成装备)/i.test(text)) categories.push("completed");
  if (/(神器|奥恩神器|artifact)/i.test(text)) categories.push("artifact");
  if (/(光明装备|光明|radiant)/i.test(text)) categories.push("radiant");
  if (/(纹章|转职|emblem)/i.test(text)) categories.push("emblem");
  if (/(辅助装备|支援装备|support item)/i.test(text)) categories.push("support");
  if (/(特殊装备|special item)/i.test(text)) categories.push("special");
  return categories.length ? [...new Set(categories)] : ["completed"];
}

function isPlayerFacingEquippableItem(item) {
  if (item?.player_facing !== undefined || item?.equippable !== undefined) {
    return item.player_facing === true && item.equippable === true;
  }
  const name = String(item?.name || "").normalize("NFKC");
  const description = [item?.basic_desc, item?.desc].filter(Boolean).join(" ").normalize("NFKC");
  return !(
    /(宝箱|武器库|锻造器|装备推荐器|选择器|变形器)/u.test(name)
    || /开启.{0,12}(?:武器库|装备选择)|从.{0,12}武器库.{0,12}选择|(?:将这个|对一个|用在一个).{0,24}(?:使用|开启|激活|改变)/u.test(description)
  );
}

function combinationsWithoutReplacement(rows, count) {
  const output = [];
  const visit = (start, current) => {
    if (current.length === count) {
      output.push([...current]);
      return;
    }
    for (let index = start; index <= rows.length - (count - current.length); index += 1) {
      current.push(rows[index]);
      visit(index + 1, current);
      current.pop();
    }
  };
  visit(0, []);
  return output;
}

function finiteMetric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadoutMetrics(composition, parameters) {
  const stats = composition.composed_stats || {};
  const attackDamage = Math.max(0, finiteMetric(stats.attack_damage));
  const attackSpeed = Math.max(0.01, finiteMetric(stats.attack_speed, 0.01));
  const critChance = Math.max(0, Math.min(1, finiteMetric(stats.crit_chance) / 100));
  const critMultiplier = finiteMetric(parameters?.combat_defaults?.critical_damage_multiplier, 1.4);
  const damageAmp = Math.max(0, finiteMetric(stats.damage_amp) / 100);
  const autoAttackDpsProxy = attackDamage
    * attackSpeed
    * (1 + critChance * Math.max(0, critMultiplier - 1))
    * (1 + damageAmp);
  let manaPerAttack = finiteMetric(parameters?.combat_defaults?.mana_per_basic_attack, 10);
  for (const modifier of composition.conditional_modifiers || []) {
    if (modifier.trigger === "basic_attack" && modifier.metric === "mana" && modifier.unit === "points") {
      manaPerAttack += finiteMetric(modifier.value);
    }
  }
  const manaGap = Math.max(0, finiteMetric(stats.max_mana) - finiteMetric(stats.initial_mana));
  const attacksToFirstCast = manaPerAttack > 0 ? Math.ceil(manaGap / manaPerAttack) : null;
  const firstCastSecondsProxy = attacksToFirstCast == null ? null : attacksToFirstCast / attackSpeed;
  return {
    auto_attack_dps_proxy: Number(autoAttackDpsProxy.toFixed(4)),
    spell_power_proxy: Number((finiteMetric(stats.ability_power, 100) * (1 + damageAmp)).toFixed(4)),
    attacks_to_first_cast: attacksToFirstCast,
    first_cast_seconds_proxy: firstCastSecondsProxy == null ? null : Number(firstCastSecondsProxy.toFixed(4)),
    attack_damage: Number(attackDamage.toFixed(4)),
    attack_speed: Number(attackSpeed.toFixed(4)),
    ability_power: Number(finiteMetric(stats.ability_power, 100).toFixed(4)),
    damage_amp_pct: Number((damageAmp * 100).toFixed(4)),
    conflict_penalty: Number(finiteMetric(composition.item_conflicts?.conflict_penalty, 0).toFixed(4)),
    high_severity_conflict: composition.item_conflicts?.has_high_severity_conflict === true,
  };
}

function compactLoadout(row) {
  return {
    items: row.items.map((item) => ({
      id: item.id,
      name: item.name,
      category: itemCategory(item),
      artifact_subtype: item.artifact_subtype || item.artifact_category || item.subtype || null,
    })),
    metrics: row.metrics,
    unresolved_effect_count: row.unresolved_effect_count,
    unresolved_effects: row.unresolved_effects.slice(0, 6),
    conflicts: row.conflicts || null,
  };
}

function bestBy(rows, selector, direction = "max") {
  const filtered = rows.filter((row) => Number.isFinite(selector(row)));
  return filtered.sort((left, right) => direction === "min"
    ? selector(left) - selector(right)
    : selector(right) - selector(left))[0] || null;
}

function materialMissingInputs(request = {}) {
  return asArray(request.missing_material_inputs)
    .map((entry) => typeof entry === "string" ? { field: entry } : entry)
    .filter((entry) => entry?.field);
}

function populationFromTheorycraftQuery(query, fallback = null) {
  const text = String(query || "").normalize("NFKC");
  if (/(?:盗宗|四费赌狗|4费赌狗)/iu.test(text)) return 8;
  if (/(?:九五|95\s*阵容|95\s*体系|95\s*上限)/iu.test(text)) return 9;
  if (/(?:八四|84\s*阵容|84\s*体系)/iu.test(text)) return 8;
  const explicit = [...text.matchAll(/(?:^|\D)(1[0-2]|[1-9])\s*(?:人口|级)/gu)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 12);
  return explicit.at(-1) ?? fallback;
}

function candidateCountFromTheorycraftQuery(query, fallback = null) {
  const text = String(query || "").normalize("NFKC");
  const parseCount = (value) => {
    if (/^\d+$/.test(String(value))) return Number(value);
    return { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[String(value)] || null;
  };
  const matches = [
    ...text.matchAll(/(?:给我|推荐|列出|提供|生成|来|要)\s*(?:大数据|理论|Core[- ]?only)?\s*(\d{1,2}|[一二两三四五六七八九十])\s*(?:套|条|个)/giu),
    ...text.matchAll(/(\d{1,2}|[一二两三四五六七八九十])\s*(?:套阵容|套路线|套方案)/giu),
  ];
  const values = matches
    .map((match) => parseCount(match[1]))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 16);
  return values.at(-1) ?? fallback;
}

function theorycraftArchetypeFromQuery(query) {
  const text = String(query || "").normalize("NFKC");
  if (/(?:九五|95\s*(?:阵容|体系|上限))/iu.test(text)) {
    return { id: "legendary_cap", carry_cost: 5, target_population: 9, formation_posture: "high_cap_operation" };
  }
  if (/(?:八四|84\s*(?:阵容|体系))/iu.test(text)) {
    return { id: "four_cost_carry", carry_cost: 4, target_population: 8, formation_posture: "level_eight_core_formation" };
  }
  if (/(?:盗宗|四费赌狗|4费赌狗)/iu.test(text)) {
    return { id: "four_cost_carry", carry_cost: 4, target_population: 8, formation_posture: "four_cost_three_star_cap" };
  }
  const labels = ["一", "二", "三"];
  for (const [cost, id] of [[1, "one_cost_reroll"], [2, "two_cost_reroll"], [3, "three_cost_reroll"]]) {
    const pattern = new RegExp(`(?:${cost}费|${cost}费卡|${labels[cost - 1]}费|${labels[cost - 1]}费卡)(?:.{0,8}(?:赌狗|主.?C|核心|追三|三星|阵容|体系))?`, "iu");
    if (pattern.test(text)) {
      const targetPopulation = cost === 1 ? 7 : cost === 2 ? 8 : 8;
      return {
        id,
        carry_cost: cost,
        target_population: targetPopulation,
        formation_posture: "reroll_core_formation",
      };
    }
  }
  return null;
}

function transitionPopulationsFromTheorycraftQuery(query, finalPopulation) {
  const values = [...String(query || "").normalize("NFKC").matchAll(/(?:^|\D)(1[0-2]|[1-9])\s*人口/gu)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isInteger(value) && value >= 1 && value < finalPopulation);
  return [...new Set(values)].sort((left, right) => left - right);
}

function runtimeSemanticsForUnit(unit) {
  return unit?.runtime_semantics && typeof unit.runtime_semantics === "object"
    ? unit.runtime_semantics
    : {};
}

function populationCostForUnit(unit) {
  const cost = finiteNumber(runtimeSemanticsForUnit(unit).population_cost, 1);
  return Number.isFinite(cost) && cost >= 1 ? cost : 1;
}

function selectedVariantTraitIdForUnit(unit, request = {}) {
  const selected = request.selected_variants && typeof request.selected_variants === "object"
    ? request.selected_variants[String(unit?.id)] ?? request.selected_variants[unit?.name]
    : null;
  return String(
    unit?.selected_variant_trait_id
      ?? unit?.variant_trait_id
      ?? (typeof selected === "object" ? selected?.trait_id ?? selected?.id : selected)
      ?? "",
  ).trim() || null;
}

function traitContributionForUnit(unit, trait, request = {}) {
  const semantics = runtimeSemanticsForUnit(unit);
  const traitId = String(trait?.id ?? trait?.trait_id ?? "");
  const explicit = asArray(semantics.trait_contributions)
    .find((entry) => String(entry?.trait_id ?? entry?.id ?? "") === traitId);
  if (explicit) return finiteNumber(explicit.value, 1);
  const base = asArray(semantics.base_trait_contributions)
    .find((entry) => String(entry?.trait_id ?? entry?.id ?? "") === traitId);
  if (base) return finiteNumber(base.value, 1);
  const selectedVariantTraitId = selectedVariantTraitIdForUnit(unit, request);
  if (selectedVariantTraitId && selectedVariantTraitId === traitId) {
    return finiteNumber(semantics.variant_trait_contribution, 1);
  }
  return 1;
}

function noRankingSourceAudit(usedSourceKinds = []) {
  return {
    used_source_kinds: [...new Set(usedSourceKinds)],
    excluded_source_kinds: [
      "daily_rankings",
      "meta_map_strength",
      "winning_lineup_recipes",
      "hero_item_ranking_priors",
      "strategy_wiki",
      "cached_ranking_candidates",
    ],
  };
}

function normalizedTier(value) {
  const tier = normalize(value);
  return ({ silver: "1", gold: "2", prismatic: "3", "银": "1", "金": "2", "彩": "3" })[tier]
    || String(value ?? "").trim();
}

function modifierApplies(modifier, facts) {
  const conditions = modifier?.when || modifier?.conditions || {};
  return Object.entries(conditions).every(([field, expected]) => {
    const observed = facts?.[field];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (expected.min != null && finiteNumber(observed) < finiteNumber(expected.min)) return false;
      if (expected.max != null && finiteNumber(observed) > finiteNumber(expected.max)) return false;
      if (expected.equals != null && normalize(observed) !== normalize(expected.equals)) return false;
      return true;
    }
    return normalize(observed) === normalize(expected);
  });
}

function augmentDimensionVector(augment, request) {
  const dimensions = { immediate: 0, economy: 0, growth: 0, conditional: 0, risk: 0 };
  const effectBlocks = [];
  const sourceText = String(augment?.effects?.source_text || augment?.desc || "");
  for (const term of asArray(augment?.effects?.structured_terms)) {
    const trigger = term?.trigger?.kind || "unknown";
    const metrics = asArray(term?.metrics).map((metric) => ({
      metric: metric.metric,
      value: finiteNumber(metric.value, 0),
      unit: metric.unit || null,
      source_text: metric.source_text || null,
    }));
    const magnitude = metrics.reduce((sum, metric) => sum + Math.abs(metric.value), 0) || 1;
    const metricKinds = new Set(metrics.map((metric) => metric.metric));
    const immediate = trigger === "passive" && /(立刻|获得\d|gain)/i.test(term.source_text || sourceText);
    const recurring = ["round_start", "interval", "combat_elapsed", "cast"].includes(trigger);
    if (immediate) dimensions.immediate += magnitude;
    if ([...metricKinds].some((metric) => ["gold", "reroll", "shop_refresh", "interest"].includes(metric))) {
      dimensions.economy += magnitude * (recurring ? Math.max(1, finiteNumber(request?.current_facts?.expected_future_player_combats, 1)) : 1);
    }
    if (recurring || [...metricKinds].some((metric) => ["xp", "experience", "copies", "item", "team_size"].includes(metric))) {
      dimensions.growth += magnitude;
    }
    if (term?.activation === "condition_required") dimensions.conditional += 1;
    effectBlocks.push({ trigger, activation: term?.activation || null, metrics, source_text: term?.source_text || null });
  }
  for (const block of asArray(augment?.effects?.exact_effect_blocks)) {
    effectBlocks.push({ ...clone(block), activation: "exact_effect_block" });
  }
  dimensions.conditional += asArray(augment?.effects?.conditional_tags).length;
  dimensions.risk += asArray(augment?.effects?.dynamic_placeholders).length;
  if (augment?.effects?.parse_status !== "structured") dimensions.risk += 1;
  if (/(不再|失去|输掉|随机|代价|无法|不能)/i.test(sourceText)) dimensions.risk += 1;
  if (/(每个|每回合|永久|成长|升级|经验|复制|额外)/i.test(sourceText)) dimensions.growth += 1;
  if (/(立刻|立即)/i.test(sourceText)) dimensions.immediate += 1;

  const appliedRuleModifiers = [];
  for (const modifier of asArray(request.rule_modifiers)) {
    const candidateRef = modifier?.candidate ?? modifier?.augment ?? modifier?.candidate_id;
    if (candidateRef && ![augment.id, augment.address, augment.name].map(normalize).includes(normalize(candidateRef))) continue;
    if (!modifierApplies(modifier, request.current_facts || {})) continue;
    for (const dimension of Object.keys(dimensions)) {
      dimensions[dimension] += finiteNumber(modifier?.dimensions?.[dimension], 0);
    }
    appliedRuleModifiers.push({
      dimensions: clone(modifier.dimensions || {}),
      reason: modifier.reason || null,
      conditions: clone(modifier.when || modifier.conditions || {}),
    });
  }
  return {
    dimensions: Object.fromEntries(Object.entries(dimensions).map(([key, value]) => [key, Number(value.toFixed(4))])),
    effectBlocks,
    appliedRuleModifiers,
  };
}

function augmentParetoFrontier(rows) {
  const maximize = ["immediate", "economy", "growth"];
  const minimize = ["conditional", "risk"];
  return rows.filter((candidate) => !rows.some((other) => other !== candidate
    && maximize.every((key) => other.dimensions[key] >= candidate.dimensions[key])
    && minimize.every((key) => other.dimensions[key] <= candidate.dimensions[key])
    && (
      maximize.some((key) => other.dimensions[key] > candidate.dimensions[key])
      || minimize.some((key) => other.dimensions[key] < candidate.dimensions[key])
    )));
}

function nextTraitBreakpoint(trait, currentCount) {
  return asArray(trait?.breakpoints)
    .map((row) => ({ ...row, count: finiteNumber(row.count) }))
    .filter((row) => row.count != null && row.count > currentCount)
    .sort((left, right) => left.count - right.count)[0] || null;
}

function achievedTraitBreakpoint(trait, currentCount) {
  return asArray(trait?.breakpoints)
    .map((row) => ({ ...row, count: finiteNumber(row.count) }))
    .filter((row) => row.count != null && row.count <= currentCount)
    .sort((left, right) => right.count - left.count)[0] || null;
}

async function loadMechanicsParameters(packageDir) {
  const current = await readJson(path.join(packageDir, "normalized", "mechanics_parameters.json"), null);
  if (current) return current;
  const legacyShop = await readJson(path.join(packageDir, "formulas", "shop_odds.json"), null);
  return {
    schema: "jcc-version-mechanics-parameters-v1",
    identity: null,
    provenance: {
      authority: legacyShop ? "archived_active_patch_parameters" : "missing",
      runtime_policy: legacyShop ? "usable_for_matching_archived_patch_only" : "fail_closed",
    },
    standard_merge_rule: { copies_per_merge: 3, base_copies_by_star: { "1": 1, "2": 3, "3": 9 } },
    combat_defaults: { base_ability_power: 100, mana_per_basic_attack: 10, confidence: "common_baseline" },
    shop: legacyShop?.tables || null,
    formulas: legacyShop ? {
      shop_odds: { tables: legacyShop.tables, exactness: legacyShop.exactness },
      shop_specific_unit_odds: { tables: legacyShop.tables, exactness: legacyShop.exactness },
    } : {},
  };
}

export async function createDecisionMathService({
  hardDataPackageDir,
  coreProfileFile,
  coreProfile: suppliedCoreProfile = null,
  decisionInputCatalogFile,
  expectedIdentity = null,
}) {
  const packageDir = path.resolve(hardDataPackageDir);
  if ((!coreProfileFile && !suppliedCoreProfile) || !decisionInputCatalogFile) {
    throw new Error("decision_math_identity_artifacts_required");
  }
  const [
    manifest,
    hardDataManifest,
    coreProfile,
    decisionInputCatalogRaw,
    champions,
    items,
    augments,
    traits,
    seasonMechanics,
    parameters,
    itemConflicts,
  ] = await Promise.all([
    readJson(path.join(packageDir, "manifest.json")),
    readJson(path.join(packageDir, "hard-data-manifest.json")),
    suppliedCoreProfile || readJson(path.resolve(coreProfileFile)),
    readFile(path.resolve(decisionInputCatalogFile), "utf8"),
    readJson(path.join(packageDir, "normalized", "champions.json")),
    readJson(path.join(packageDir, "normalized", "items.json")),
    readJson(path.join(packageDir, "normalized", "augments.json")),
    readJson(path.join(packageDir, "normalized", "traits.json")),
    readJson(path.join(packageDir, "normalized", "season_mechanics.json"), { shop_extensions: [] }),
    loadMechanicsParameters(packageDir),
    readJson(path.join(packageDir, "indexes", "item_conflicts.json"), []),
  ]);
  const loadedIdentity = validateLoadedIdentity({
    manifest,
    hardDataManifest,
    coreProfile,
    decisionInputCatalog: JSON.parse(decisionInputCatalogRaw),
    decisionInputCatalogRaw,
    expectedIdentity,
  });
  const decisionInputCatalog = JSON.parse(decisionInputCatalogRaw);
  const decisionCatalogEntities = new Map(asArray(decisionInputCatalog.entities)
    .map((entity) => [String(entity.address), entity]));
  const sprites = asArray(seasonMechanics?.shop_extensions).flatMap((extension) => asArray(extension.entries));
  const catalogs = {
    champion: indexEntities(champions, decisionInputCatalog.aliases, "champion"),
    item: indexEntities(items, decisionInputCatalog.aliases, "item"),
    augment: indexEntities(augments, decisionInputCatalog.aliases, "augment"),
    trait: indexEntities(traits, decisionInputCatalog.aliases, "trait"),
    season_mechanic: indexEntities(sprites),
  };
  const itemConflictByAddress = new Map(asArray(itemConflicts)
    .filter((row) => row?.item_address)
    .map((row) => [String(row.item_address), row]));
  const itemConflictSummary = (entities, champion = null, traits = []) => {
    const rows = asArray(entities).map((item) => {
      const indexed = itemConflictByAddress.get(String(item?.address));
      const text = [item?.basic_desc, item?.desc].filter(Boolean).join(" ");
      const fallbackLock = /攻速(?:锁定|固定)|攻击速度(?:锁定|固定)|锁定为\s*0\.5/u.test(text);
      if (indexed && !fallbackLock) return indexed;
      if (indexed && fallbackLock && !asArray(indexed.constraints).some((row) => row?.metric === "attack_speed" && row?.mode === "locked")) {
        return {
          ...indexed,
          conflicts: [...new Set([...asArray(indexed.conflicts), "attack_speed_override"])],
          constraints: [...asArray(indexed.constraints), { metric: "attack_speed", mode: "locked", value: 0.5, unit: "absolute", source_text: text }],
          blocked_effects: [...new Set([...asArray(indexed.blocked_effects), "attack_speed"])],
          semantic_relations: [...asArray(indexed.semantic_relations), { relation: "relation.overrides", target: "effect.attack_speed", value: 0.5 }],
        };
      }
      return indexed || (fallbackLock ? {
        item_address: item.address,
        name: item.name,
        conflicts: ["attack_speed_override"],
        constraints: [{ metric: "attack_speed", mode: "locked", value: 0.5, unit: "absolute", source_text: text }],
        blocked_effects: ["attack_speed"],
        semantic_relations: [{ relation: "relation.overrides", target: "effect.attack_speed", value: 0.5 }],
        confidence: "deterministic_semantic_fallback",
      } : null);
    }).filter(Boolean);
    const overrides = rows.flatMap((row) => asArray(row.constraints)
      .filter((constraint) => constraint?.mode === "locked" && constraint.metric)
      .map((constraint) => ({ ...constraint, source_item: row.name || null })));
    const blocked = [...new Set(rows.flatMap((row) => asArray(row.blocked_effects)))];
    const conflicts = rows.flatMap((row) => asArray(row.conflicts));
    const itemProfiles = asArray(entities).map((item) => ({ item, profile: semanticCompatibilityProfile(item) }));
    const externalProfiles = [
      ...(champion ? [{ source_kind: "champion_skill", source_name: champion.name, profile: semanticCompatibilityProfile(champion.skill || champion) }] : []),
      ...asArray(traits).map((trait) => ({ source_kind: "trait", source_name: trait.name, profile: semanticCompatibilityProfile(trait) })),
    ];
    const semanticConflicts = [];
    for (const { item, profile } of itemProfiles) {
      const itemIndex = itemProfiles.findIndex((entry) => entry.item === item);
      const itemEffects = new Set(profile.effects);
      for (const external of externalProfiles) {
        for (const effect of COMPATIBILITY_EFFECTS) {
          if (!itemEffects.has(effect) || !external.profile.effects.includes(effect)) continue;
          semanticConflicts.push({
            conflict_type: "effect_overlap",
            severity: effect === "wound" || effect.endsWith("_shred") || effect === "penetration" ? "medium" : "low",
            item: item.name,
            source: external.source_name,
            source_kind: external.source_kind,
            effect,
            effect_label: compatibilityEffectLabel(effect),
            relation: "relation.conflicts_with",
            stacking: external.profile.nonStacking || profile.nonStacking ? "explicitly_non_stacking" : "requires_game_rule_check",
            explanation: `${external.source_name}已经提供${compatibilityEffectLabel(effect)}，${item.name}的同类效果可能产生重叠或边际收益下降。`,
          });
        }
      }
      for (const other of itemProfiles) {
        if (other.item === item || itemProfiles.indexOf(other) <= itemIndex) continue;
        for (const effect of COMPATIBILITY_EFFECTS) {
          if (!itemEffects.has(effect) || !other.profile.effects.includes(effect)) continue;
          semanticConflicts.push({
            conflict_type: "item_effect_overlap",
            severity: effect === "wound" || effect.endsWith("_shred") || effect === "penetration" ? "medium" : "low",
            item: item.name,
            source: other.item.name,
            effect,
            effect_label: compatibilityEffectLabel(effect),
            relation: "relation.conflicts_with",
            stacking: profile.nonStacking || other.profile.nonStacking ? "explicitly_non_stacking" : "requires_game_rule_check",
            explanation: `${item.name}和${other.item.name}都提供${compatibilityEffectLabel(effect)}，需要确认是否叠加；不能把重复效果自动当成更高收益。`,
          });
        }
      }
      if (profile.conditions.includes("melee") && champion && championAttackRange(champion) > 2) {
        semanticConflicts.push({
          conflict_type: "condition_mismatch",
          severity: "high",
          item: item.name,
          condition: "melee",
          champion: champion.name,
          relation: "relation.conditioned_on",
          explanation: `${item.name}要求近战接触条件，但${champion.name}的攻击距离为${championAttackRange(champion)}。`,
        });
      }
      if (profile.conditions.includes("ranged") && champion && championAttackRange(champion) <= 2) {
        semanticConflicts.push({
          conflict_type: "condition_mismatch",
          severity: "high",
          item: item.name,
          condition: "ranged",
          champion: champion.name,
          relation: "relation.conditioned_on",
          explanation: `${item.name}要求远程条件，但${champion.name}的攻击距离为${championAttackRange(champion)}。`,
        });
      }
      if (profile.conditions.includes("low_health") || profile.triggers.includes("kill")) {
        semanticConflicts.push({
          conflict_type: "conditional_effect_unverified",
          severity: "low",
          item: item.name,
          missing_facts: profile.conditions.includes("low_health") ? ["current_unit_hp"] : ["kill_access"],
          relation: "relation.conditioned_on",
          explanation: `${item.name}的收益依赖${profile.conditions.includes("low_health") ? "低血量" : "击杀"}条件，当前没有战斗状态证据时不能按即时收益计算。`,
        });
      }
    }
    const uniqueItemCounts = new Map();
    for (const { item, profile } of itemProfiles) {
      if (!profile.conditions.includes("unique_item_slot")) continue;
      const key = String(item?.address || item?.id || item?.name || "");
      uniqueItemCounts.set(key, (uniqueItemCounts.get(key) || 0) + 1);
    }
    for (const { item, profile } of itemProfiles) {
      const key = String(item?.address || item?.id || item?.name || "");
      if (profile.conditions.includes("unique_item_slot") && (uniqueItemCounts.get(key) || 0) > 1) {
        semanticConflicts.push({
          conflict_type: "unique_item_violation",
          severity: "high",
          item: item.name,
          condition: "unique_item_slot",
          relation: "relation.conditioned_on",
          explanation: `${item.name}标记为唯一装备，当前组合重复携带，不能按两件独立收益计算。`,
        });
      }
    }
    const dedupSemanticConflicts = [...new Map(semanticConflicts.map((row) => [
      JSON.stringify([row.conflict_type, row.item, row.source || "", row.effect || "", row.condition || ""]), row,
    ])).values()];
    const attackSpeedOverride = overrides.find((row) => row.metric === "attack_speed");
    const speedBonusItems = asArray(entities)
      .filter((item) => asArray(item?.structured_stats).some((stat) => stat?.metric === "attack_speed"))
      .map((item) => item.name);
    const overrideSourceItem = attackSpeedOverride?.source_item
      ? asArray(entities).find((item) => item?.name === attackSpeedOverride.source_item)
      : null;
    const overrideText = [overrideSourceItem?.basic_desc, overrideSourceItem?.desc].filter(Boolean).join(" ");
    const preservedEffects = [...new Set([
      ...asArray(overrideSourceItem?.structured_stats).map((stat) => stat?.metric),
      ...( /免疫|无法被控制|不受控制/u.test(overrideText) ? ["status_immunity"] : []),
      ...( /眩晕|晕眩|击飞|定身|沉默|嘲讽/u.test(overrideText) ? ["control"] : []),
      ...( /伤害增幅|伤害提升|造成额外伤害/u.test(overrideText) ? ["damage_amp"] : []),
      ...( /移动速度|移速/u.test(overrideText) ? ["movement_speed"] : []),
    ].filter((effect) => effect && effect !== "attack_speed"))];
    const effective = [
      ...(attackSpeedOverride && speedBonusItems.length ? [{
          conflict_type: "stat_override",
          severity: "high",
          overridden_stat: "attack_speed",
          override_value: attackSpeedOverride.value,
          blocked_effects: ["attack_speed"],
          wasted_effects: speedBonusItems.map((name) => ({ item: name, effect: "attack_speed" })),
          preserved_effects: preservedEffects,
          relation: "relation.overrides",
        }] : []),
      ...dedupSemanticConflicts,
    ];
    const conflictPenalty = dedupSemanticConflicts.reduce((total, row) => total + (
      row.severity === "high" ? 0.12 : row.severity === "medium" ? 0.05 : 0.015
    ), 0);
    return {
      conflicts: [...new Set(conflicts)],
      constraints: overrides,
      blocked_effects: blocked,
      effective_conflicts: effective,
      semantic_conflicts: dedupSemanticConflicts,
      compatibility_evidence: {
        items: itemProfiles.map(({ item, profile }) => ({
          item: item.name,
          effects: profile.effects,
          triggers: profile.triggers,
          conditions: profile.conditions,
        })),
        external_sources: externalProfiles.map(({ source_kind, source_name, profile }) => ({
          source_kind,
          source: source_name,
          effects: profile.effects,
          triggers: profile.triggers,
          conditions: profile.conditions,
        })),
      },
      conflict_penalty: Number(Math.min(0.35, conflictPenalty + (attackSpeedOverride && speedBonusItems.length ? 0.15 : 0)).toFixed(4)),
      has_high_severity_conflict: effective.some((row) => row.severity === "high"),
      policy: "hard_effect_override_is_reported; soft_overlap_and_unverified_conditions_reduce_fit_without_forcing_a_ban",
    };
  };

  const championAttackRange = (unit) => finiteNumber(asArray(unit?.attributes_by_star?.["攻击距离"])[0], 1);
  const championBaseHp = (unit) => finiteNumber(asArray(unit?.attributes_by_star?.["生命"])[0], 0);
  const championBaseAd = (unit) => finiteNumber(asArray(unit?.attributes_by_star?.["物攻"])[0], 0);
  const championSkillByStar = (unit, field) => Object.fromEntries(
    Object.entries(unit?.skill?.[field] || {})
      .map(([star, value]) => [String(star), String(value || "").trim()])
      .filter(([, value]) => value),
  );
  const championSkillText = (unit) => {
    const descriptions = Object.values(championSkillByStar(unit, "descriptions_by_star"));
    const values = Object.values(championSkillByStar(unit, "values_by_star"));
    return [...new Set([
      String(unit?.skill?.effects?.source_text || "").trim(),
      ...descriptions,
      ...values,
    ].filter(Boolean))].join("\n");
  };
  const championRoleScores = (unit) => {
    const range = championAttackRange(unit);
    const hp = championBaseHp(unit);
    const ad = championBaseAd(unit);
    const skillText = championSkillText(unit);
    const damageSignals = (skillText.match(/(?:物理伤害|魔法伤害|真实伤害|额外伤害|伤害增幅)/gu) || []).length;
    const tankSignals = (skillText.match(/(?:护盾|回复|治疗|减伤|格挡|晕眩|击飞|嘲讽|双抗|护甲|魔抗)/gu) || []).length;
    return {
      carry: finiteNumber(unit?.cost, 0) * 2
        + Math.min(5, damageSignals)
        + Math.min(3, ad / 45)
        + (range >= 3 ? 4 : 0),
      tank: finiteNumber(unit?.cost, 0) * 2
        + Math.min(6, tankSignals)
        + Math.min(5, hp / 300)
        + (range <= 2 ? 5 : -4),
      range,
    };
  };
  const compactChampionSkill = (unit) => {
    const descriptionsByStar = championSkillByStar(unit, "descriptions_by_star");
    const valuesByStar = championSkillByStar(unit, "values_by_star");
    return {
      name: unit?.skill?.name || null,
      type: unit?.skill?.type || null,
      summary: descriptionsByStar["1"] || String(unit?.skill?.effects?.source_text || "").trim() || null,
      descriptions_by_star: descriptionsByStar,
      values_by_star: valuesByStar,
    };
  };
  const compactCoreEntityDetail = (kind, entity) => {
    const patchMetadata = Object.fromEntries([
      "balance_overrides", "enabled", "availability_status", "disabled_reason", "offer_conditions",
    ].filter((key) => entity[key] !== undefined).map((key) => [key, structuredClone(entity[key])]));
    if (kind === "champion") {
      return {
        ...patchMetadata,
        kind,
        id: entity.id,
        address: entity.address,
        name: entity.name,
        cost: finiteNumber(entity.cost, 0),
        traits: asArray(entity.traits).map((trait) => ({ id: trait.id, name: trait.name })),
        skill: compactChampionSkill(entity),
        attributes_by_star: entity.attributes_by_star || null,
        semantic_role_proxy: championRoleScores(entity),
      };
    }
    if (kind === "trait") {
      return {
        ...patchMetadata,
        kind,
        id: entity.id,
        address: entity.address,
        name: entity.name,
        breakpoints: asArray(entity.breakpoints).map((row) => ({
          count: finiteNumber(row.count),
          effect: row.effect || row.desc || null,
        })),
        desc: entity.desc || entity.description || null,
      };
    }
    if (kind === "augment") {
      return {
        ...patchMetadata,
        kind,
        id: entity.id,
        address: entity.address,
        name: entity.name,
        tier: entity.tier || null,
        desc: entity.desc || null,
        effects: entity.effects || null,
      };
    }
    return {
      ...patchMetadata,
      kind,
      id: entity.id,
      address: entity.address,
      name: entity.name,
      category: itemCategory(entity),
      type: entity.type || entity.item_type || null,
      desc: entity.desc || entity.basic_desc || null,
      structured_stats: asArray(entity.structured_stats),
      effects: entity.effects || null,
      recipe: entity.recipe || entity.formula || null,
    };
  };

  async function composeUnitStats(request = {}) {
    const championResult = resolveEntity(catalogs.champion, request.champion, "champion");
    if (championResult.status !== "resolved") return failure("champion_resolution_failed", championResult, loadedIdentity);
    const sources = [];
    const resolution = [];
    for (const [kind, references] of [
      ["item", request.items],
      ["augment", request.augments],
      ["season_mechanic", request.season_mechanics],
    ]) {
      for (const reference of asArray(references)) {
        const result = resolveEntity(catalogs[kind], reference, kind);
        resolution.push(result);
        if (result.status === "resolved") sources.push({ kind, entity: result.entity });
      }
    }
    const baseStats = championBaseStats(championResult.entity, request.star, parameters);
    const unconditional = [];
    const conditional = [];
    const resolvedTraits = [];
    for (const source of sources) {
      const collected = collectEntityModifiers(source);
      unconditional.push(...collected.modifiers);
      conditional.push(...collected.conditional);
    }
    for (const traitRequest of asArray(request.traits)) {
      const reference = typeof traitRequest === "object" ? traitRequest.name ?? traitRequest.id : traitRequest;
      const result = resolveEntity(catalogs.trait, reference, "trait");
      resolution.push(result);
      if (result.status !== "resolved") continue;
      resolvedTraits.push(result.entity);
      const requestedCount = finiteNumber(typeof traitRequest === "object" ? traitRequest.count : null);
      const breakpoint = requestedCount == null
        ? null
        : asArray(result.entity.breakpoints).filter((row) => Number(row.count) <= requestedCount).at(-1) || null;
      if (breakpoint) conditional.push({
        source_kind: "trait",
        source_id: result.entity.id,
        source_name: result.entity.name,
        activation: "structured_trait_modifier_required",
        requested_count: requestedCount,
        breakpoint: breakpoint.count,
        condition_text: [result.entity?.text?.prefix, breakpoint?.effect].filter(Boolean).join(" "),
      });
      else conditional.push({
        source_kind: "trait",
        source_id: result.entity.id,
        source_name: result.entity.name,
        activation: "trait_breakpoint_required",
        requested_count: requestedCount,
        available_breakpoints: asArray(result.entity.breakpoints).map((row) => row.count),
      });
    }
    const resolutionIssues = resolution.filter((row) => row.status !== "resolved");
    if (resolutionIssues.length > 0) {
      return failure("explicit_entity_resolution_failed", { resolution_issues: resolutionIssues }, loadedIdentity);
    }
    const composed = applyStaticModifiers(baseStats, unconditional);
    const resolvedItems = sources.filter((source) => source.kind === "item").map((source) => source.entity);
    const conflictSummary = itemConflictSummary(resolvedItems, championResult.entity, resolvedTraits);
    const attackSpeedOverride = conflictSummary.constraints.find((row) => row.metric === "attack_speed" && row.mode === "locked");
    if (attackSpeedOverride) {
      composed.stats.attack_speed = finiteNumber(attackSpeedOverride.value, composed.stats.attack_speed);
      composed.applied.push({
        source_kind: "item_conflict",
        source_id: "stat_override",
        source_name: attackSpeedOverride.source_item || "装备属性覆盖",
        metric: "attack_speed",
        value: attackSpeedOverride.value,
        unit: "absolute",
        activation: "unconditional_stat_override",
      });
    }
    return {
      schema: DECISION_MATH_SERVICE_SCHEMA,
      operation: "compose_unit_stats",
      executable: true,
      confidence: composed.unresolved.length || conditional.length ? "partial_with_explicit_conditions" : "deterministic_for_supplied_static_modifiers",
      profile: profileIdentity(manifest, parameters, loadedIdentity),
      champion: { id: championResult.entity.id, name: championResult.entity.name, star: Number(request.star || 1) },
      base_stats: baseStats,
      composed_stats: composed.stats,
      applied_modifiers: composed.applied,
      conditional_modifiers: [...conditional, ...composed.unresolved],
      item_conflicts: conflictSummary,
      resolution_issues: [],
      assumptions: [
        "Only supplied entities and declared active trait breakpoints were considered.",
        "Conditional combat effects were not applied unless represented as unconditional static stats.",
        "This is deterministic stat composition, not full combat simulation.",
      ],
    };
  }

  async function attacksToCast(request = {}) {
    const composition = await composeUnitStats(request);
    if (!composition.executable) return composition;
    let manaPerAttack = finiteNumber(request.mana_per_attack, parameters?.combat_defaults?.mana_per_basic_attack);
    const appliedPerAttack = [];
    for (const modifier of composition.conditional_modifiers) {
      if (modifier.trigger === "basic_attack" && modifier.metric === "mana" && modifier.unit === "points") {
        manaPerAttack += modifier.value;
        appliedPerAttack.push(modifier);
      }
    }
    const formula = await evaluateFormula("attacks_to_cast", {
      initial_mana: composition.composed_stats.initial_mana,
      max_mana: composition.composed_stats.max_mana,
      immediate_mana: finiteNumber(request.immediate_mana, 0),
      mana_per_attack: manaPerAttack,
    }, { parameter_set: parameters });
    return {
      ...formula,
      schema: DECISION_MATH_SERVICE_SCHEMA,
      operation: "attacks_to_cast",
      profile: profileIdentity(manifest, parameters, loadedIdentity),
      champion: composition.champion,
      applied_per_attack_modifiers: appliedPerAttack,
      assumptions: [
        "This is the no-damage first-cast baseline.",
        "Damage-taken mana, attack animation, crowd control, mana lock, target loss, and conditional season effects are excluded unless explicitly supplied.",
      ],
    };
  }

  async function shopOdds(request = {}) {
    const championResult = request.champion ? resolveEntity(catalogs.champion, request.champion, "champion") : null;
    if (championResult && championResult.status !== "resolved") return failure("champion_resolution_failed", championResult, loadedIdentity);
    const cost = finiteNumber(request.cost, championResult?.entity?.cost);
    const poolRow = shopPoolRows(parameters?.shop?.pool_by_cost).find((row) => Number(row.cost) === cost);
    const defaultCopies = finiteNumber(poolRow?.copies_per_champion);
    const hasExplicitRemainingCopies = request.remaining_copies != null;
    const explicitRemainingCopies = hasExplicitRemainingCopies ? Number(request.remaining_copies) : null;
    if (hasExplicitRemainingCopies && (!Number.isInteger(explicitRemainingCopies) || explicitRemainingCopies < 0)) {
      return failure("invalid_remaining_copy_count", { remaining_copies: request.remaining_copies }, loadedIdentity);
    }
    const remainingCopies = hasExplicitRemainingCopies ? explicitRemainingCopies : defaultCopies;
    const variety = champions.filter((row) => Number(row.cost) === cost).length;
    const hasExplicitPoolTotal = request.pool_total_for_cost != null;
    if (hasExplicitRemainingCopies && remainingCopies !== defaultCopies && !hasExplicitPoolTotal) {
      return failure("pool_total_required_for_depleted_target_estimate", {
        remaining_copies: remainingCopies,
        default_copies: defaultCopies,
      }, loadedIdentity);
    }
    const explicitPoolTotal = hasExplicitPoolTotal ? Number(request.pool_total_for_cost) : null;
    if (hasExplicitPoolTotal && (!Number.isInteger(explicitPoolTotal) || explicitPoolTotal <= 0)) {
      return failure("invalid_pool_total_for_cost", { pool_total_for_cost: request.pool_total_for_cost }, loadedIdentity);
    }
    const poolTotal = hasExplicitPoolTotal ? explicitPoolTotal : defaultCopies != null ? defaultCopies * variety : null;
    if (remainingCopies != null && poolTotal != null && remainingCopies > poolTotal) {
      return failure("remaining_copies_exceed_pool_total", { remaining_copies: remainingCopies, pool_total_for_cost: poolTotal }, loadedIdentity);
    }
    const levelRow = shopOddsRows(parameters?.shop?.odds_by_level).find((row) => Number(row.level) === Number(request.level));
    if (!levelRow) return failure("shop_level_not_in_active_parameter_table", { level: request.level }, loadedIdentity);
    if (cost == null || remainingCopies == null || poolTotal == null) {
      return failure("missing_shop_parameters", { cost, remaining_copies: remainingCopies, pool_total_for_cost: poolTotal }, loadedIdentity);
    }
    const formula = await evaluateFormula("shop_odds", {
      level: request.level,
      cost,
      shop_slots: request.shop_slots ?? 5,
      rerolls: request.rerolls ?? 0,
      remaining_copies: remainingCopies,
      pool_total_for_cost: poolTotal,
    }, { parameter_set: parameters });
    return {
      ...formula,
      schema: DECISION_MATH_SERVICE_SCHEMA,
      operation: "shop_odds",
      confidence: parameters?.provenance?.authority === "carried_forward_unverified"
        ? "carried_forward_unverified"
        : formula.confidence,
      calculation_confidence: formula.confidence,
      profile: profileIdentity(manifest, parameters, loadedIdentity),
      champion: championResult?.entity ? { id: championResult.entity.id, name: championResult.entity.name, cost } : null,
      assumptions: [
        "Opponent ownership is unknown unless explicitly supplied; the default remaining-copy count is therefore an uncontested upper bound.",
        parameters?.provenance?.authority === "carried_forward_unverified"
          ? "The active shop table and bag sizes are carried forward and usable, but remain marked unverified until current-season authority replaces them."
          : parameters?.provenance?.authority === "common_user_confirmed_standard"
            ? "The shop table and bag sizes are the authoritative Common standard resolved into the selected Core Profile; an active season may replace them only with an explicit verified exception."
            : "The active shop table and bag sizes come from the selected version parameter set.",
      ],
    };
  }

  async function optimizeItemLoadouts(request = {}) {
    const championResult = resolveEntity(catalogs.champion, request.champion, "champion");
    if (championResult.status !== "resolved") {
      return failure("champion_required_for_item_optimizer", championResult, loadedIdentity);
    }
    const missingMaterialInputs = materialMissingInputs(request);
    const allowTheoryDefaults = request.force_theorycraft === true
      || request.theory_only === true
      || request.source_authority === "core_only_theory";
    if (missingMaterialInputs.length >= 3 && !allowTheoryDefaults) {
      return {
        ...failure("material_inputs_required_before_optimization", {
          missing_material_inputs: missingMaterialInputs,
          threshold: 3,
        }, loadedIdentity),
        followup_policy: "Ask for the listed material fields before calculating. Do not substitute ranking evidence.",
      };
    }
    const categories = requestedItemCategories(request);
    const invalidCategories = categories.filter((category) => !["completed", "artifact", "radiant", "support", "special", "emblem"].includes(category));
    if (invalidCategories.length) {
      return failure("unsupported_item_category", { invalid_categories: invalidCategories }, loadedIdentity);
    }
    const lockedResults = [];
    for (const reference of asArray(request.locked_items)) {
      const result = resolveEntity(catalogs.item, reference, "item");
      if (result.status !== "resolved") return failure("locked_item_resolution_failed", result, loadedIdentity);
      if (!isPlayerFacingEquippableItem(result.entity)) {
        return failure("locked_item_not_equippable", { id: result.entity.id, name: result.entity.name }, loadedIdentity);
      }
      lockedResults.push(result.entity);
    }
    const currentItemResults = [];
    for (const reference of asArray(request.current_items)) {
      const result = resolveEntity(catalogs.item, reference, "item");
      if (result.status !== "resolved") return failure("current_item_resolution_failed", result, loadedIdentity);
      if (!isPlayerFacingEquippableItem(result.entity)) {
        return failure("current_item_not_equippable", { id: result.entity.id, name: result.entity.name }, loadedIdentity);
      }
      currentItemResults.push(result.entity);
    }
    const slotCount = Math.max(1, Math.min(3, Number(request.slot_count || 3)));
    if (currentItemResults.length > slotCount) {
      return failure("current_items_exceed_slot_count", { current_item_count: currentItemResults.length, slot_count: slotCount }, loadedIdentity);
    }
    const currentItemsLocked = request.replace_current_items !== true;
    const effectiveLockedItems = [...lockedResults];
    if (currentItemsLocked) {
      const unmatchedExplicitLocks = new Map();
      for (const item of lockedResults) {
        const id = String(item.id);
        unmatchedExplicitLocks.set(id, (unmatchedExplicitLocks.get(id) || 0) + 1);
      }
      for (const item of currentItemResults) {
        const id = String(item.id);
        const overlap = unmatchedExplicitLocks.get(id) || 0;
        if (overlap > 0) unmatchedExplicitLocks.set(id, overlap - 1);
        else effectiveLockedItems.push(item);
      }
    }
    if (effectiveLockedItems.length > slotCount) {
      return failure("locked_items_exceed_slot_count", { locked_item_count: effectiveLockedItems.length, slot_count: slotCount }, loadedIdentity);
    }
    const lockedIds = new Set(effectiveLockedItems.map((item) => String(item.id)));
    const candidateItems = catalogs.item.rows
      .filter(isPlayerFacingEquippableItem)
      .filter((item) => categories.includes(itemCategory(item)))
      .filter((item) => !lockedIds.has(String(item.id)))
      .sort((left, right) => String(left.name).localeCompare(String(right.name), "zh-CN"));
    const openSlots = slotCount - effectiveLockedItems.length;
    const combinations = openSlots === 0
      ? [[]]
      : combinationsWithoutReplacement(candidateItems, openSlots);
    if (!combinations.length) {
      return failure("no_legal_item_loadouts", { categories, open_slots: openSlots }, loadedIdentity);
    }
    const evaluated = [];
    for (const combination of combinations) {
      const loadout = [...effectiveLockedItems, ...combination];
      const composition = await composeUnitStats({
        champion: championResult.entity.id,
        star: request.star || 1,
        items: loadout.map((item) => item.id),
        augments: request.augments,
        traits: request.traits,
        season_mechanics: request.season_mechanics,
      });
      if (!composition.executable) continue;
      evaluated.push({
        items: loadout,
        metrics: loadoutMetrics(composition, parameters),
        unresolved_effect_count: composition.conditional_modifiers.length,
        unresolved_effects: composition.conditional_modifiers,
        conflicts: composition.item_conflicts,
      });
    }
    if (!evaluated.length) return failure("item_loadout_evaluation_failed", { categories }, loadedIdentity);
    let currentLoadoutBaseline = null;
    if (currentItemResults.length) {
      const currentComposition = await composeUnitStats({
        champion: championResult.entity.id,
        star: request.star || 1,
        items: currentItemResults.map((item) => item.id),
        augments: request.augments,
        traits: request.traits,
        season_mechanics: request.season_mechanics,
      });
      if (currentComposition.executable) {
        currentLoadoutBaseline = compactLoadout({
          items: currentItemResults,
          metrics: loadoutMetrics(currentComposition, parameters),
          unresolved_effect_count: currentComposition.conditional_modifiers.length,
          unresolved_effects: currentComposition.conditional_modifiers,
          conflicts: currentComposition.item_conflicts,
        });
      }
    }
    const extrema = {
      maxAuto: Math.max(...evaluated.map((row) => row.metrics.auto_attack_dps_proxy)),
      minAuto: Math.min(...evaluated.map((row) => row.metrics.auto_attack_dps_proxy)),
      maxSpell: Math.max(...evaluated.map((row) => row.metrics.spell_power_proxy)),
      minSpell: Math.min(...evaluated.map((row) => row.metrics.spell_power_proxy)),
      maxCast: Math.max(...evaluated.map((row) => row.metrics.first_cast_seconds_proxy ?? Number.POSITIVE_INFINITY).filter(Number.isFinite)),
      minCast: Math.min(...evaluated.map((row) => row.metrics.first_cast_seconds_proxy ?? Number.POSITIVE_INFINITY).filter(Number.isFinite)),
    };
    const normalized = (value, low, high) => high > low ? (value - low) / (high - low) : 1;
    for (const row of evaluated) {
      const auto = normalized(row.metrics.auto_attack_dps_proxy, extrema.minAuto, extrema.maxAuto);
      const spell = normalized(row.metrics.spell_power_proxy, extrema.minSpell, extrema.maxSpell);
      const castSeconds = row.metrics.first_cast_seconds_proxy;
      const cast = Number.isFinite(castSeconds)
        ? 1 - normalized(castSeconds, extrema.minCast, extrema.maxCast)
        : 0;
      const conflictPenalty = Math.min(0.35, finiteMetric(row.metrics.conflict_penalty, 0));
      row.balanced_score = Number(Math.max(0, ((auto + spell + cast) / 3) - conflictPenalty).toFixed(6));
    }
    const maxAuto = bestBy([...evaluated], (row) => row.metrics.auto_attack_dps_proxy);
    const maxSpell = bestBy([...evaluated], (row) => row.metrics.spell_power_proxy);
    const fastestCast = bestBy([...evaluated], (row) => row.metrics.first_cast_seconds_proxy, "min");
    const balanced = bestBy([...evaluated], (row) => row.balanced_score);
    const frontierSeed = [...new Map([
      ...[...evaluated].sort((a, b) => b.metrics.auto_attack_dps_proxy - a.metrics.auto_attack_dps_proxy).slice(0, 32),
      ...[...evaluated].sort((a, b) => b.metrics.spell_power_proxy - a.metrics.spell_power_proxy).slice(0, 32),
      ...[...evaluated].filter((row) => Number.isFinite(row.metrics.first_cast_seconds_proxy))
        .sort((a, b) => a.metrics.first_cast_seconds_proxy - b.metrics.first_cast_seconds_proxy).slice(0, 32),
      ...[...evaluated].sort((a, b) => b.balanced_score - a.balanced_score).slice(0, 32),
    ].map((row) => [row.items.map((item) => item.id).join("|"), row])).values()];
    const pareto = frontierSeed.filter((candidate) => !frontierSeed.some((other) => other !== candidate
      && other.metrics.auto_attack_dps_proxy >= candidate.metrics.auto_attack_dps_proxy
      && other.metrics.spell_power_proxy >= candidate.metrics.spell_power_proxy
      && (other.metrics.first_cast_seconds_proxy ?? Number.POSITIVE_INFINITY) <= (candidate.metrics.first_cast_seconds_proxy ?? Number.POSITIVE_INFINITY)
      && (
        other.metrics.auto_attack_dps_proxy > candidate.metrics.auto_attack_dps_proxy
        || other.metrics.spell_power_proxy > candidate.metrics.spell_power_proxy
        || (other.metrics.first_cast_seconds_proxy ?? Number.POSITIVE_INFINITY) < (candidate.metrics.first_cast_seconds_proxy ?? Number.POSITIVE_INFINITY)
      ))).slice(0, 12);
    const semanticSeed = request.semantic_seed || buildSemanticSeed({
      query: request.query || "",
      context: request,
      targetRole: "itemization",
      sourcePolicy: request.source_authority || "active_core_profile_only",
    });
    return {
      schema: DECISION_MATH_SERVICE_SCHEMA,
      operation: "optimize_item_loadouts",
      executable: true,
      confidence: "deterministic_static_proxy_with_explicit_unresolved_effects",
      profile: profileIdentity(manifest, parameters, loadedIdentity),
      semantic_seed: semanticSeed,
      selection_owner: "agent",
      expansion_owner: "runtime_deterministic",
      champion: { id: championResult.entity.id, name: championResult.entity.name, star: Number(request.star || 1) },
      evidence_policy: "active_core_profile_only_no_rankings",
      source_audit: noRankingSourceAudit([
          "common_formula_kernel",
          "captured_core_profile_champion_catalog",
          "captured_core_profile_item_catalog",
          ...(asArray(request.augments).length ? ["explicit_or_confirmed_augment_facts"] : []),
          ...(asArray(request.traits).length ? ["trusted_active_trait_facts"] : []),
          ...(asArray(request.season_mechanics).length ? ["explicit_or_confirmed_season_mechanic_facts"] : []),
        ]),
      candidate_scope: {
        categories,
        default_category: "completed",
        special_categories_require_explicit_request: true,
        slot_count: slotCount,
        locked_items: effectiveLockedItems.map((item) => ({ id: item.id, name: item.name, category: itemCategory(item) })),
        current_items_locked: currentItemsLocked,
        replace_current_items: request.replace_current_items === true,
        duplicate_item_policy: "one_copy_per_item_unless_a_future_explicit_inventory_request_proves_duplicates",
      },
      evaluated_loadout_count: evaluated.length,
      current_loadout_baseline: currentLoadoutBaseline,
      missing_material_inputs: missingMaterialInputs,
      defaulted_inputs: asArray(request.defaulted_inputs),
      recommendations: {
        max_auto_attack_damage_proxy: maxAuto ? compactLoadout(maxAuto) : null,
        max_spell_power_proxy: maxSpell ? compactLoadout(maxSpell) : null,
        fastest_first_cast_proxy: fastestCast ? compactLoadout(fastestCast) : null,
        balanced_equal_weight_proxy: balanced ? compactLoadout(balanced) : null,
        bounded_pareto_frontier: pareto.map(compactLoadout),
      },
      candidate_frontier: pareto.map((row, index) => ({
        branch_id: `${semanticSeed.seed_id}:item:${index + 1}`,
        seed_id: semanticSeed.seed_id,
        selection_owner: "agent",
        expansion_owner: "runtime_deterministic",
        loadout: compactLoadout(row),
        claim_boundary: "core_only_theory_proxy_not_universal_best",
      })),
      assumptions: [
        "Normal completed items are the default candidate pool. Artifact, radiant, support, emblem, and special items enter only when explicitly allowed for this request or remain locked when already owned.",
        "The optimizer uses static stats and mechanically parsed per-basic-attack mana. Conditional, timed, execute, healing, targeting, and stacking effects remain unresolved evidence for the Agent.",
        "Auto-attack DPS, spell power, and first-cast speed are separate objectives. The equal-weight result is a convenience point, not a universal best-in-slot claim.",
        "Enemy resistance, damage taken mana, crowd control, mana lock, animation time, target access, and active season-mechanic state are not exact unless supplied.",
      ],
    };
  }

  async function evaluateAugmentEffectChoices(request = {}) {
    const missingMaterialInputs = materialMissingInputs(request);
    const allowTheoryDefaults = request.force_theorycraft === true
      || request.theory_only === true
      || request.source_authority === "core_only_theory";
    if (missingMaterialInputs.length >= 3 && !allowTheoryDefaults) {
      return {
        ...failure("material_inputs_required_before_optimization", {
          missing_material_inputs: missingMaterialInputs,
          threshold: 3,
        }, loadedIdentity),
        followup_policy: "Ask for the listed material fields before calculating. Do not substitute ranking evidence.",
      };
    }
    const explicitReferences = [
      ...asArray(request.candidates),
      ...asArray(request.candidate_augments),
      ...asArray(request.legal_candidates),
    ];
    let candidateEntities = [];
    let candidateSource = "explicit_current_choice_or_allowed_set";
    if (explicitReferences.length) {
      for (const reference of explicitReferences) {
        const result = resolveEntity(catalogs.augment, reference, "augment");
        if (result.status !== "resolved") return failure("augment_candidate_resolution_failed", result, loadedIdentity);
        const catalogEntity = decisionCatalogEntities.get(String(result.entity.address));
        if (!catalogEntity || catalogEntity.kind !== "augment") {
          return failure("augment_candidate_not_in_active_decision_catalog", {
            id: result.entity.id,
            name: result.entity.name,
          }, loadedIdentity);
        }
        if (request.tier != null && normalizedTier(catalogEntity.tier) !== normalizedTier(request.tier)) {
          return failure("augment_candidate_tier_mismatch", {
            candidate: { id: result.entity.id, name: result.entity.name, tier: catalogEntity.tier },
            requested_tier: request.tier,
          }, loadedIdentity);
        }
        candidateEntities.push(result.entity);
      }
    } else {
      const requestedTier = normalizedTier(request.tier);
      const requestedStage = String(request.stage || request.round || "").trim();
      candidateEntities = asArray(decisionInputCatalog.entities)
        .filter((entity) => entity.kind === "augment")
        .filter((entity) => !requestedTier || normalizedTier(entity.tier) === requestedTier)
        .filter((entity) => !requestedStage || asArray(entity.rounds).includes(requestedStage))
        .map((entity) => resolveEntity(catalogs.augment, entity.address, "augment"))
        .filter((result) => result.status === "resolved")
        .map((result) => result.entity);
      candidateSource = "active_decision_catalog_legal_set";
    }
    candidateEntities = [...new Map(candidateEntities.map((entity) => [String(entity.id), entity])).values()];
    if (!candidateEntities.length) {
      return failure("no_legal_augment_candidates", {
        tier: request.tier ?? null,
        stage: request.stage ?? request.round ?? null,
        stage_authority: decisionInputCatalog?.choice_descriptors?.augment?.stage_authority_source || null,
      }, loadedIdentity);
    }
    const candidates = candidateEntities
      .map((entity) => {
        const evaluated = augmentDimensionVector(entity, request);
        const catalogEntity = decisionCatalogEntities.get(String(entity.address));
        return {
          id: entity.id,
          address: entity.address,
          name: entity.name,
          tier: catalogEntity?.tier ?? entity.tier ?? null,
          stage_legality: catalogEntity?.stage_unknown
            ? "explicit_report_accepted_stage_unknown"
            : "active_catalog_stage_bound",
          dimensions: evaluated.dimensions,
          effect_blocks: evaluated.effectBlocks,
          rule_modifiers: evaluated.appliedRuleModifiers,
          unresolved_effects: [
            ...asArray(entity?.effects?.conditional_tags),
            ...asArray(entity?.effects?.dynamic_placeholders),
          ],
          assumptions: asArray(request.assumptions),
        };
      })
      .sort((left, right) => String(left.name).localeCompare(String(right.name), "zh-CN"));
    const pareto = augmentParetoFrontier(candidates);
    const semanticSeed = request.semantic_seed || buildSemanticSeed({
      query: request.query || "",
      context: request,
      targetRole: "augment_choice",
      sourcePolicy: request.source_authority || "active_core_profile_only",
    });
    return {
      schema: DECISION_MATH_SERVICE_SCHEMA,
      operation: "evaluate_augment_effect_choices",
      executable: true,
      confidence: "deterministic_effect_block_and_explicit_rule_modifier_evaluation",
      profile: profileIdentity(manifest, parameters, loadedIdentity),
      semantic_seed: semanticSeed,
      selection_owner: "agent",
      expansion_owner: "runtime_deterministic",
      evidence_policy: "active_core_profile_only_no_rankings",
      source_audit: noRankingSourceAudit([
        "captured_core_profile_augment_catalog",
        "active_decision_input_catalog_legality",
        ...(Object.keys(request.current_facts || {}).length ? ["reliable_current_match_facts"] : []),
        ...(asArray(request.rule_modifiers).length ? ["explicit_rule_modifiers"] : []),
      ]),
      candidate_source: candidateSource,
      candidates,
      pareto_frontier: pareto.map((row) => ({ id: row.id, name: row.name, dimensions: row.dimensions })),
      candidate_frontier: pareto.map((row, index) => ({
        branch_id: `${semanticSeed.seed_id}:augment:${index + 1}`,
        seed_id: semanticSeed.seed_id,
        selection_owner: "agent",
        expansion_owner: "runtime_deterministic",
        candidate: { id: row.id, name: row.name, dimensions: row.dimensions },
        claim_boundary: "core_only_theory_proxy_not_universal_best",
      })),
      missing_material_inputs: missingMaterialInputs,
      defaulted_inputs: asArray(request.defaulted_inputs),
      claim_boundaries: {
        universal_best_choice: false,
        ranking_strength: false,
        combat_simulation: false,
        dimensions_are_bounded_decision_proxies: true,
      },
      assumptions: [
        "Immediate, economy, growth, conditional, and risk dimensions come only from parsed effect blocks, explicit rule modifiers, and supplied current facts.",
        "The Pareto frontier preserves non-dominated tradeoffs and is not a hidden total ranking.",
        "Unparsed prose, dynamic placeholders, and unmet conditions remain explicit risk or conditional evidence.",
      ],
    };
  }

  async function solveTraitRosterRoleCoverage(request = {}) {
    const missingMaterialInputs = materialMissingInputs(request);
    const autoSelectCores = request.auto_select_cores === true
      || (!request.main_carry && !request.target_main_carry)
      || (!request.main_tank && !request.target_main_tank);
    if (missingMaterialInputs.length >= 3 && !autoSelectCores) {
      return {
        ...failure("material_inputs_required_before_optimization", {
          missing_material_inputs: missingMaterialInputs,
          threshold: 3,
        }, loadedIdentity),
        followup_policy: "Ask for the listed material fields before constructing a roster. Do not substitute ranking evidence.",
      };
    }
    const population = finiteNumber(request.population ?? request.level);
    if (!Number.isInteger(population) || population < 1 || population > 12) {
      return failure("valid_population_required_for_roster_solver", { population: request.population ?? request.level ?? null }, loadedIdentity);
    }
    const semanticSeed = request.semantic_seed || buildSemanticSeed({
      query: request.query || "",
      context: request,
      archetype: request.archetype,
      sourcePolicy: request.source_authority || "core_only_theory",
    });
    const expansionPlan = request.mechanical_expansion_plan || buildMechanicalExpansionPlan(semanticSeed, {
      population,
      stabilizePopulation: getLineupArchetypePolicy(request.archetype, population).stabilize_population,
      targetPopulation: getLineupArchetypePolicy(request.archetype, population).target_population,
      coreCost: getLineupArchetypePolicy(request.archetype, population).core_cost,
    });
    if (autoSelectCores) {
      const archetypePolicy = getLineupArchetypePolicy(request.archetype, population);
      const stageMaxUnitCost = request.max_unit_cost == null
        ? archetypePolicy.maxCoreUnitCostAt(population)
        : Math.max(1, finiteNumber(request.max_unit_cost, 5));
      const explicitCarry = request.main_carry || request.target_main_carry || null;
      const explicitTank = request.main_tank || request.target_main_tank || null;
      const resolvedCarry = explicitCarry ? resolveEntity(catalogs.champion, explicitCarry, "champion") : null;
      const resolvedTank = explicitTank ? resolveEntity(catalogs.champion, explicitTank, "champion") : null;
      if (resolvedCarry && resolvedCarry.status !== "resolved") return failure("main_carry_resolution_failed", resolvedCarry, loadedIdentity);
      if (resolvedTank && resolvedTank.status !== "resolved") return failure("main_tank_resolution_failed", resolvedTank, loadedIdentity);
      const minimumCarryCost = Math.max(1, finiteNumber(request.minimum_main_carry_cost,
        request.carry_cost_target
          ?? request.archetype?.carry_cost
          ?? (population >= 9 ? 5 : 4)));
      const maximumCarryCost = request.maximum_main_carry_cost == null
        ? stageMaxUnitCost
        : Math.max(minimumCarryCost, finiteNumber(request.maximum_main_carry_cost, minimumCarryCost));
      const minimumTankCost = Math.max(1, finiteNumber(
        request.minimum_main_tank_cost,
        archetypePolicy.is_reroll ? 1 : population >= 9 ? 4 : 3,
      ));
      const maximumTankCost = request.maximum_main_tank_cost == null
        ? stageMaxUnitCost
        : Math.max(minimumTankCost, finiteNumber(request.maximum_main_tank_cost, stageMaxUnitCost));
      const carryPool = resolvedCarry?.entity
        ? [resolvedCarry.entity]
        : catalogs.champion.rows
          .filter((unit) => finiteNumber(unit.cost, 0) >= minimumCarryCost)
          .filter((unit) => maximumCarryCost == null || finiteNumber(unit.cost, 0) <= maximumCarryCost)
          .sort((left, right) => championRoleScores(right).carry - championRoleScores(left).carry
            || String(left.name).localeCompare(String(right.name), "zh-CN"));
      const tankPool = resolvedTank?.entity
        ? [resolvedTank.entity]
        : catalogs.champion.rows
          .filter((unit) => finiteNumber(unit.cost, 0) >= minimumTankCost
            && (maximumTankCost == null || finiteNumber(unit.cost, 0) <= maximumTankCost)
            && championAttackRange(unit) <= 2)
          .sort((left, right) => championRoleScores(right).tank - championRoleScores(left).tank
            || String(left.name).localeCompare(String(right.name), "zh-CN"));
      const evaluated = [];
      for (const carry of carryPool.slice(0, 12)) {
        for (const tank of tankPool.slice(0, 16)) {
          if (String(carry.id) === String(tank.id)) continue;
          const result = await solveTraitRosterRoleCoverage({
            ...request,
            main_carry: carry.id,
            main_tank: tank.id,
            auto_select_cores: false,
            prefer_high_cost: request.prefer_high_cost ?? !archetypePolicy.is_reroll,
            max_unit_cost: stageMaxUnitCost,
            missing_material_inputs: [],
            transition_populations: [],
          });
          if (!result.executable) continue;
          const feasibility = evaluateLineupFeasibility({
            roster: result.roster,
            population,
            archetype: request.archetype,
            parameters,
            currentFacts: request.current_facts || request.match_facts || {},
            starTargets: request.star_targets,
            requiredConditions: request.required_conditions,
            sourceAuthority: "core_only_theory",
          });
          if (request.archetype && !feasibility.executable) continue;
          const activeTraits = result.trait_coverage.filter((trait) => trait.achieved_breakpoint);
          const highCostCount = result.roster.filter((unit) => unit.cost >= 4).length;
          const coreTraitIds = new Set([
            ...asArray(carry.traits).map((trait) => String(trait.id)),
            ...asArray(tank.traits).map((trait) => String(trait.id)),
          ]);
          const activeCoreTraits = activeTraits.filter((trait) => coreTraitIds.has(String(trait.id))).length;
          const roleScores = championRoleScores(carry).carry + championRoleScores(tank).tank;
          const highCostPreference = archetypePolicy.is_reroll ? -9 : 7;
          const theoreticalScore = activeTraits.length * 24
            + activeCoreTraits * 18
            + highCostCount * highCostPreference
            - feasibility.formation_profile.burden_score * 12
            + roleScores;
          evaluated.push({ result: { ...result, formation_profile: feasibility.formation_profile, feasibility }, carry, tank, theoreticalScore, activeTraits: activeTraits.length, highCostCount });
        }
      }
      evaluated.sort((left, right) => right.theoreticalScore - left.theoreticalScore
        || right.activeTraits - left.activeTraits
        || right.highCostCount - left.highCostCount
        || String(left.carry.name).localeCompare(String(right.carry.name), "zh-CN")
        || String(left.tank.name).localeCompare(String(right.tank.name), "zh-CN"));
      const uniqueRosters = [];
      const seenRosters = new Set();
      const displayRequestedCount = Number.isInteger(Number(request.candidate_count))
        && request.candidate_count !== null
        && request.candidate_count !== undefined
        && String(request.candidate_count).trim() !== ""
        ? Math.max(1, Math.min(16, Number(request.candidate_count)))
        : Number.isInteger(Number(request.requested_candidate_count))
          && request.requested_candidate_count !== null
          && request.requested_candidate_count !== undefined
          && String(request.requested_candidate_count).trim() !== ""
          ? Math.max(1, Math.min(16, Number(request.requested_candidate_count)))
          : null;
      const frontierRequestedCount = Number.isInteger(Number(request.frontier_candidate_count))
        && request.frontier_candidate_count !== null
        && request.frontier_candidate_count !== undefined
        && String(request.frontier_candidate_count).trim() !== ""
        ? Math.max(1, Math.min(16, Number(request.frontier_candidate_count)))
        : Math.max(8, displayRequestedCount || 0);
      for (const entry of evaluated) {
        const identity = entry.result.roster.map((unit) => unit.id).sort().join("|");
        if (seenRosters.has(identity)) continue;
        seenRosters.add(identity);
        uniqueRosters.push(entry);
        if (uniqueRosters.length >= frontierRequestedCount) break;
      }
      const selected = uniqueRosters[0];
      if (!selected) return failure("no_legal_auto_selected_roster", {
        population,
        archetype: request.archetype || null,
        carry_pool_size: carryPool.length,
        tank_pool_size: tankPool.length,
        stage_max_unit_cost: stageMaxUnitCost,
      }, loadedIdentity);

      const transitions = [];
      for (const transitionPopulation of asArray(request.transition_populations)) {
        const boundedPopulation = finiteNumber(transitionPopulation);
        if (!Number.isInteger(boundedPopulation) || boundedPopulation < 1 || boundedPopulation >= population) continue;
        const maxUnitCost = boundedPopulation <= 6 ? 3 : 4;
        const finalCarryTraitIds = new Set(asArray(selected.carry.traits).map((trait) => String(trait.id)));
        const finalTankTraitIds = new Set(asArray(selected.tank.traits).map((trait) => String(trait.id)));
        const temporaryPool = catalogs.champion.rows.filter((unit) => finiteNumber(unit.cost, 0) <= maxUnitCost);
        const temporaryCarry = temporaryPool
          .filter((unit) => asArray(unit.traits).some((trait) => finalCarryTraitIds.has(String(trait.id))))
          .sort((left, right) => championRoleScores(right).carry - championRoleScores(left).carry
            || finiteNumber(right.cost, 0) - finiteNumber(left.cost, 0))[0]
          || [...temporaryPool].sort((left, right) => championRoleScores(right).carry - championRoleScores(left).carry)[0];
        const temporaryTank = temporaryPool
          .filter((unit) => String(unit.id) !== String(temporaryCarry?.id)
            && championAttackRange(unit) <= 2
            && asArray(unit.traits).some((trait) => finalTankTraitIds.has(String(trait.id))))
          .sort((left, right) => championRoleScores(right).tank - championRoleScores(left).tank
            || finiteNumber(right.cost, 0) - finiteNumber(left.cost, 0))[0]
          || temporaryPool
            .filter((unit) => String(unit.id) !== String(temporaryCarry?.id) && championAttackRange(unit) <= 2)
            .sort((left, right) => championRoleScores(right).tank - championRoleScores(left).tank)[0];
        if (!temporaryCarry || !temporaryTank) continue;
        const transitionResult = await solveTraitRosterRoleCoverage({
          population: boundedPopulation,
          main_carry: temporaryCarry.id,
          main_tank: temporaryTank.id,
          auto_select_cores: false,
          max_unit_cost: maxUnitCost,
          missing_material_inputs: [],
          target_traits: [
            ...asArray(selected.carry.traits).map((trait) => trait.id),
            ...asArray(selected.tank.traits).map((trait) => trait.id),
          ],
        });
        if (!transitionResult.executable) continue;
        transitions.push({
          population: boundedPopulation,
          occupied_population: transitionResult.occupied_population,
          roster: transitionResult.roster,
          trait_coverage: transitionResult.trait_coverage,
          temporary_main_carry: { id: temporaryCarry.id, name: temporaryCarry.name },
          temporary_main_tank: { id: temporaryTank.id, name: temporaryTank.name },
          transitions_to: {
            main_carry: { id: selected.carry.id, name: selected.carry.name },
            main_tank: { id: selected.tank.id, name: selected.tank.name },
          },
          equipment_continuity: {
            policy: "Preserve the final carry and tank item packages on role-compatible temporary holders; exact items require the item optimizer or explicit owned-item facts.",
            carry_holder: temporaryCarry.name,
            tank_holder: temporaryTank.name,
          },
          ranking_authority: false,
        });
      }
      const phasePlans = asArray(selected.result.phase_plans).map((phase) => ({ ...phase }));
      if (archetypePolicy.is_reroll && population > archetypePolicy.stabilize_population) {
        const stabilizePopulation = archetypePolicy.stabilize_population;
        const stabilizeMaxCost = archetypePolicy.maxCoreUnitCostAt(stabilizePopulation);
        const stabilizeTank = catalogs.champion.rows
          .filter((unit) => String(unit.id) !== String(selected.carry.id))
          .filter((unit) => finiteNumber(unit.cost, 0) <= stabilizeMaxCost && championAttackRange(unit) <= 2)
          .sort((left, right) => championRoleScores(right).tank - championRoleScores(left).tank
            || finiteNumber(right.cost, 0) - finiteNumber(left.cost, 0)
            || String(left.name).localeCompare(String(right.name), "zh-CN"))[0];
        const stabilizeResult = stabilizeTank
          ? await solveTraitRosterRoleCoverage({
              ...request,
              population: stabilizePopulation,
              main_carry: selected.carry.id,
              main_tank: stabilizeTank.id,
              auto_select_cores: false,
              max_unit_cost: stabilizeMaxCost,
              prefer_high_cost: false,
              missing_material_inputs: [],
              transition_populations: [],
            })
          : null;
        const stabilizeIndex = phasePlans.findIndex((phase) => phase.population === stabilizePopulation);
        if (stabilizeIndex >= 0) {
          phasePlans[stabilizeIndex] = {
            ...phasePlans[stabilizeIndex],
            roster: stabilizeResult?.executable ? stabilizeResult.roster : [],
            stage_feasibility: stabilizeResult?.feasibility || null,
            temporary_main_tank: stabilizeResult?.executable
              ? { id: stabilizeTank.id, name: stabilizeTank.name, cost: stabilizeTank.cost }
              : null,
            stage_status: stabilizeResult?.executable ? "concrete_stage_roster" : "conditional_stage_roster_unavailable",
          };
        }
      }
      const candidateFrontier = uniqueRosters.map((entry, index) => ({
        schema: "jcc-lineup-candidate-frontier-entry-v1",
        branch_id: `${semanticSeed.seed_id}:branch:${index + 1}`,
        seed_id: semanticSeed.seed_id,
        selection_owner: "agent",
        expansion_owner: "runtime_deterministic",
        fallback_rank: index + 1,
        main_carry: { id: entry.carry.id, name: entry.carry.name, cost: entry.carry.cost },
        main_tank: { id: entry.tank.id, name: entry.tank.name, cost: entry.tank.cost },
        roster: entry.result.roster.map((unit) => ({ id: unit.id, name: unit.name, cost: unit.cost, population_cost: unit.population_cost || 1 })),
        active_traits: entry.result.trait_coverage
          .filter((trait) => trait.achieved_breakpoint)
          .map((trait) => ({ name: trait.name, count: trait.count, breakpoint: trait.achieved_breakpoint.count })),
        formation_profile: entry.result.formation_profile,
        phase_plans: asArray(entry.result.phase_plans).map((phase) => ({
          phase: phase.phase || null,
          population: phase.population ?? null,
          objective: phase.objective || null,
          roster: asArray(phase.roster).map((unit) => ({
            id: unit.id,
            name: unit.name,
            cost: unit.cost,
            population_cost: unit.population_cost || 1,
          })),
          stage_status: phase.stage_status || null,
        })),
        transition_chain: {
          status: asArray(entry.result.phase_plans).length ? "bounded_phase_plan" : "not_expanded",
          populations: asArray(entry.result.phase_plans).map((phase) => phase.population).filter(Number.isInteger),
          policy: "keep_each_branch_atomic; exact item continuity requires itemization evidence",
        },
        acquisition_profile: entry.result.acquisition_profile || null,
        economy_profile: entry.result.economy_profile || null,
        condition_profile: entry.result.condition_profile || null,
        proxy_score: Number(entry.theoreticalScore.toFixed(4)),
        claim_boundary: "core_only_theory_proxy_not_strength",
      }));
      return {
        ...selected.result,
        archetype: request.archetype || null,
        semantic_seed: semanticSeed,
        mechanical_expansion_plan: expansionPlan,
        core_selection: {
          mode: "deterministic_auto_selection",
          selection_owner: "agent",
          selection_status: "deterministic_fallback_until_agent_comparison",
          objective: request.objective || (archetypePolicy.is_reroll
            ? "stage_feasible_reroll_with_star_targets_and_role_coverage"
            : "theoretical_high_cap_with_trait_and_role_coverage"),
          main_carry: { id: selected.carry.id, name: selected.carry.name },
          main_tank: { id: selected.tank.id, name: selected.tank.name },
          proxy_score: Number(selected.theoreticalScore.toFixed(4)),
          policy: archetypePolicy.is_reroll
            ? "Core-only feasibility proxy: requested carry cost, stage cost ceiling, activated traits, role coverage, and formation burden. This is not Master+ strength."
            : "Core-only proxy: high-cost role potential, activated traits, role coverage, and legal roster structure. This is not Master+ strength.",
        },
        candidate_rosters: candidateFrontier,
        candidate_frontier: candidateFrontier,
        candidate_frontier_contract: {
          requested_count: displayRequestedCount,
          frontier_requested_count: frontierRequestedCount,
          returned_count: candidateFrontier.length,
          selection_owner: "agent",
          expansion_owner: "runtime_deterministic",
          display_count_is_separate: true,
          fallback_policy: "return_all_real_candidates_when_fewer_exist; never invent_rosters",
        },
        transitions,
        phase_plans: phasePlans,
        formation_profile: selected.result.formation_profile,
        feasibility: selected.result.feasibility,
        missing_material_inputs: missingMaterialInputs,
        defaulted_inputs: [
          ...asArray(request.defaulted_inputs),
          { field: "main_carry", default: selected.carry.name, reason: "user_delegated_core_selection" },
          { field: "main_tank", default: selected.tank.name, reason: "user_delegated_core_selection" },
        ],
        claim_boundaries: {
          ...selected.result.claim_boundaries,
          theoretical_high_cap_proxy_only: true,
        },
      };
    }
    const carryResult = resolveEntity(catalogs.champion, request.main_carry, "champion");
    if (carryResult.status !== "resolved") return failure("main_carry_resolution_failed", carryResult, loadedIdentity);
    const tankResult = resolveEntity(catalogs.champion, request.main_tank, "champion");
    if (tankResult.status !== "resolved") return failure("main_tank_resolution_failed", tankResult, loadedIdentity);

    const ownedUnits = [];
    for (const reference of asArray(request.owned_units)) {
      const result = resolveEntity(catalogs.champion, reference, "champion");
      if (result.status !== "resolved") return failure("owned_unit_resolution_failed", result, loadedIdentity);
      ownedUnits.push(result.entity);
    }
    const emblemTraits = [];
    for (const emblem of asArray(request.emblems)) {
      if (emblem == null) continue;
      const traitReference = typeof emblem === "object" ? emblem.trait ?? emblem.name ?? emblem.id : emblem;
      const result = resolveEntity(catalogs.trait, traitReference, "trait");
      if (result.status !== "resolved") return failure("emblem_trait_resolution_failed", result, loadedIdentity);
      emblemTraits.push({
        trait: result.entity,
        holder: typeof emblem === "object" ? emblem.holder || null : null,
        count: Math.max(1, Math.floor(finiteNumber(typeof emblem === "object" ? emblem.count : 1, 1))),
      });
    }
    const targetTraits = [];
    for (const target of asArray(request.target_traits)) {
      if (target == null) continue;
      const traitReference = typeof target === "object" ? target.trait ?? target.name ?? target.id : target;
      const result = resolveEntity(catalogs.trait, traitReference, "trait");
      if (result.status !== "resolved") return failure("target_trait_resolution_failed", result, loadedIdentity);
      const requestedCount = finiteNumber(typeof target === "object" ? target.count : null);
      targetTraits.push({
        trait: result.entity,
        count: requestedCount ?? nextTraitBreakpoint(result.entity, 0)?.count ?? 1,
      });
    }

    const roster = [...new Map([
      carryResult.entity,
      tankResult.entity,
      ...ownedUnits,
    ].map((unit) => [String(unit.id), unit])).values()];
    const rosterPopulationCost = (units) => units.reduce((sum, unit) => sum + populationCostForUnit(unit), 0);
    if (rosterPopulationCost(roster) > population) {
      return failure("required_units_exceed_population", {
        population,
        occupied_population: rosterPopulationCost(roster),
        required_units: roster.map((unit) => ({ id: unit.id, name: unit.name })),
      }, loadedIdentity);
    }
    if (!targetTraits.length) {
      const inferred = [...carryResult.entity.traits, ...tankResult.entity.traits];
      for (const traitRef of inferred) {
        const result = resolveEntity(catalogs.trait, traitRef.id || traitRef.name, "trait");
        if (result.status === "resolved" && !targetTraits.some((row) => row.trait.id === result.entity.id)) {
          targetTraits.push({ trait: result.entity, count: nextTraitBreakpoint(result.entity, 0)?.count ?? 1 });
        }
      }
    }
    const traitCountsFor = (units) => {
      const counts = new Map();
      for (const unit of units) {
        for (const trait of asArray(unit.traits)) {
          const contribution = traitContributionForUnit(unit, trait, request);
          counts.set(String(trait.id), (counts.get(String(trait.id)) || 0) + contribution);
        }
        const selectedVariantTraitId = selectedVariantTraitIdForUnit(unit, request);
        const hasSelectedVariantInBaseTraits = selectedVariantTraitId
          && asArray(unit.traits).some((trait) => String(trait.id) === selectedVariantTraitId);
        if (selectedVariantTraitId && !hasSelectedVariantInBaseTraits) {
          const contribution = finiteNumber(runtimeSemanticsForUnit(unit).variant_trait_contribution, 1);
          counts.set(selectedVariantTraitId, (counts.get(selectedVariantTraitId) || 0) + contribution);
        }
      }
      for (const emblem of emblemTraits) {
        counts.set(String(emblem.trait.id), (counts.get(String(emblem.trait.id)) || 0) + emblem.count);
      }
      return counts;
    };
    const unitRange = (unit) => finiteNumber(asArray(unit?.attributes_by_star?.["攻击距离"])[0], 1);
    while (rosterPopulationCost(roster) < population) {
      const selectedIds = new Set(roster.map((unit) => String(unit.id)));
      const counts = traitCountsFor(roster);
      const frontlineCount = roster.filter((unit) => unitRange(unit) <= 2).length;
      const backlineCount = roster.length - frontlineCount;
      const candidate = catalogs.champion.rows
        .filter((unit) => !selectedIds.has(String(unit.id)))
        .filter((unit) => rosterPopulationCost(roster) + populationCostForUnit(unit) <= population)
        .filter((unit) => request.max_unit_cost == null || finiteNumber(unit.cost, 0) <= finiteNumber(request.max_unit_cost))
        .map((unit) => {
          let score = 0;
          for (const target of targetTraits) {
            const current = counts.get(String(target.trait.id)) || 0;
            const contributes = asArray(unit.traits).some((trait) => String(trait.id) === String(target.trait.id));
            if (contributes && current < target.count) score += 100 + (target.count - current);
          }
          for (const traitRef of asArray(unit.traits)) {
            const traitResult = resolveEntity(catalogs.trait, traitRef.id || traitRef.name, "trait");
            if (traitResult.status !== "resolved") continue;
            const current = counts.get(String(traitResult.entity.id)) || 0;
            if (nextTraitBreakpoint(traitResult.entity, current)?.count === current + 1) score += 15;
          }
          if (unitRange(unit) <= 2 && frontlineCount === 0) score += 20;
          if (unitRange(unit) > 2 && backlineCount === 0) score += 20;
          score += (request.prefer_high_cost === true ? 1 : -1) * finiteNumber(unit.cost, 0) / 100;
          return { unit, score };
        })
        .sort((left, right) => right.score - left.score
          || (request.prefer_high_cost === true
            ? finiteNumber(right.unit.cost) - finiteNumber(left.unit.cost)
            : finiteNumber(left.unit.cost) - finiteNumber(right.unit.cost))
          || String(left.unit.name).localeCompare(String(right.unit.name), "zh-CN"))[0]?.unit;
      if (!candidate) break;
      roster.push(candidate);
    }
    if (rosterPopulationCost(roster) !== population) {
      return failure("insufficient_legal_units_for_population", {
        population,
        resolved_units: roster.length,
        occupied_population: rosterPopulationCost(roster),
      }, loadedIdentity);
    }

    const counts = traitCountsFor(roster);
    const traitCoverage = [...counts.entries()]
      .map(([traitId, count]) => {
        const result = resolveEntity(catalogs.trait, traitId, "trait");
        if (result.status !== "resolved") return null;
        const emblemCount = emblemTraits
          .filter((emblem) => String(emblem.trait.id) === traitId)
          .reduce((sum, emblem) => sum + emblem.count, 0);
        const achieved = achievedTraitBreakpoint(result.entity, count);
        const next = nextTraitBreakpoint(result.entity, count);
        return {
          id: result.entity.id,
          name: result.entity.name,
          count,
          natural_unit_count: count - emblemCount,
          emblem_count: emblemCount,
          achieved_breakpoint: achieved ? { count: achieved.count, effect: achieved.effect || null } : null,
          next_breakpoint: next ? { count: next.count, effect: next.effect || null } : null,
          target_count: targetTraits.find((target) => String(target.trait.id) === traitId)?.count ?? null,
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.count - left.count || String(left.name).localeCompare(String(right.name), "zh-CN"));
    const rosterOutput = roster.map((unit) => {
      const roles = [];
      if (String(unit.id) === String(carryResult.entity.id)) roles.push("main_carry");
      if (String(unit.id) === String(tankResult.entity.id)) roles.push("main_tank");
      roles.push(unitRange(unit) <= 2 ? "frontline" : "backline");
      if (ownedUnits.some((owned) => String(owned.id) === String(unit.id))) roles.push("owned_continuity");
      return {
        id: unit.id,
        address: unit.address,
        name: unit.name,
        cost: finiteNumber(unit.cost, 0),
        population_cost: populationCostForUnit(unit),
        selected_variant_trait_id: selectedVariantTraitIdForUnit(unit, request),
        roles: [...new Set(roles)],
        traits: asArray(unit.traits).map((trait) => ({ id: trait.id, name: trait.name })),
        skill: compactChampionSkill(unit),
        combat_profile: {
          attack_range: championAttackRange(unit),
          base_hp: championBaseHp(unit),
          base_attack_damage: championBaseAd(unit),
        },
      };
    });
    const costByTier = {};
    for (const unit of rosterOutput) costByTier[String(unit.cost)] = (costByTier[String(unit.cost)] || 0) + 1;
    const feasibility = evaluateLineupFeasibility({
      roster: rosterOutput,
      population,
      archetype: request.archetype,
      parameters,
      currentFacts: request.current_facts || request.match_facts || {},
      starTargets: request.star_targets,
      requiredConditions: request.required_conditions,
      sourceAuthority: "core_only_theory",
    });
    if (request.archetype && !feasibility.executable) {
      return failure("lineup_stage_feasibility_blocked", {
        population,
        archetype: request.archetype,
        rejection_reasons: feasibility.rejection_reasons,
        formation_profile: feasibility.formation_profile,
        phase_plans: feasibility.phase_plans,
      }, loadedIdentity);
    }
    return {
      schema: DECISION_MATH_SERVICE_SCHEMA,
      operation: "solve_trait_roster_role_coverage",
      executable: true,
      confidence: "deterministic_catalog_legality_and_coverage_solver",
      profile: profileIdentity(manifest, parameters, loadedIdentity),
      evidence_policy: "active_core_profile_only_no_rankings",
      source_audit: noRankingSourceAudit([
        "captured_core_profile_champion_catalog",
        "captured_core_profile_trait_catalog",
        "explicit_main_carry_and_main_tank",
        ...(ownedUnits.length ? ["reliable_owned_unit_facts"] : []),
        ...(emblemTraits.length ? ["explicit_or_confirmed_emblem_facts"] : []),
      ]),
      population,
      archetype: request.archetype || null,
      occupied_population: rosterOutput.reduce((sum, unit) => sum + finiteNumber(unit.population_cost, 1), 0),
      roster: rosterOutput,
      role_coverage: {
        main_carry: rosterOutput.some((unit) => unit.roles.includes("main_carry")),
        main_tank: rosterOutput.some((unit) => unit.roles.includes("main_tank")),
        frontline_count: rosterOutput.filter((unit) => unit.roles.includes("frontline")).length,
        backline_count: rosterOutput.filter((unit) => unit.roles.includes("backline")).length,
      },
      trait_coverage: traitCoverage,
      cost: {
        total_shop_cost: rosterOutput.reduce((sum, unit) => sum + unit.cost, 0),
        units_by_cost: costByTier,
        roster_purchase_cost: feasibility.economy_profile.roster_purchase_cost,
        star_target_purchase_cost: feasibility.economy_profile.star_target_purchase_cost,
        target_roster_purchase_cost: feasibility.economy_profile.target_roster_purchase_cost,
        target_unit_costs: feasibility.economy_profile.target_unit_costs,
        upgrade_and_roll_costs_included: false,
        star_target_costs_included: true,
        formation_economy_profile: feasibility.economy_profile,
      },
      emblems: emblemTraits.map((emblem) => ({
        trait: { id: emblem.trait.id, name: emblem.trait.name },
        holder: emblem.holder,
        count: emblem.count,
      })),
      missing_material_inputs: missingMaterialInputs,
      defaulted_inputs: asArray(request.defaulted_inputs),
      formation_profile: feasibility.formation_profile,
      feasibility,
      economy_profile: feasibility.economy_profile,
      phase_plans: feasibility.phase_plans,
      acquisition_profile: feasibility.acquisition_profile,
      condition_profile: feasibility.condition_profile,
      claim_boundaries: {
        strength_estimate: false,
        combat_simulation: false,
        ranking_recommendation: false,
        legal_roster_skeleton_and_coverage_only: true,
        stage_feasibility_checked: Boolean(request.archetype),
        exact_roll_probability: false,
      },
      assumptions: [
        "One roster slot contains one unique current-profile champion; star levels do not consume additional slots.",
        "Main carry and main tank are hard role constraints, while other frontline/backline labels use current catalog attack range only.",
        "Emblems add only their explicitly supplied trait count. The solver does not infer emblem ownership, craftability, holder legality, or combat value.",
        "The greedy skeleton prioritizes requested trait deficits, exact next breakpoints, role coverage, and the current archetype stage cost ceiling. It does not claim meta strength or simulate combat.",
        "Formation burden uses per-level shop odds, star-target copy pressure, explicit condition counts, and stage transitions; it is a bounded feasibility proxy rather than exact roll probability.",
      ],
    };
  }

  async function calculate(request = {}) {
    const operation = request.operation || "compose_unit_stats";
    if (operation === "compose_unit_stats") return composeUnitStats(request);
    if (operation === "attacks_to_cast") return attacksToCast(request);
    if (operation === "shop_odds") return shopOdds(request);
    if (operation === "optimize_item_loadouts") return optimizeItemLoadouts(request);
    if (operation === "evaluate_augment_effect_choices") return evaluateAugmentEffectChoices(request);
    if (operation === "solve_trait_roster_role_coverage") return solveTraitRosterRoleCoverage(request);
    if (operation === "star_upgrade_copies") {
      const sourceStar = Math.max(1, Number(request.source_star || 1));
      const targetStar = Math.max(sourceStar, Number(request.target_star || 3));
      const copiesPerMerge = Number(parameters?.standard_merge_rule?.copies_per_merge || 3);
      return {
        schema: DECISION_MATH_SERVICE_SCHEMA,
        operation,
        executable: true,
        confidence: "deterministic_common_rule",
        profile: profileIdentity(manifest, parameters, loadedIdentity),
        output: { base_copy_cost: copiesPerMerge ** (targetStar - sourceStar) },
      };
    }
    if (DIRECT_COMMON_OPERATIONS.has(operation)) {
      const formula = await evaluateFormula(operation, request, { parameter_set: parameters });
      return {
        ...formula,
        schema: DECISION_MATH_SERVICE_SCHEMA,
        operation,
        profile: profileIdentity(manifest, parameters, loadedIdentity),
      };
    }
    return failure("unsupported_operation", { operation }, loadedIdentity);
  }

  function queryCoreEntities(mentioned, query, allowedKinds = null) {
    const entities = [];
    for (const kind of ["champion", "trait", "item", "augment", "season_mechanic"]) {
      if (allowedKinds && !allowedKinds.has(kind)) continue;
      for (const entity of asArray(mentioned?.[kind]).slice(0, 8)) {
        entities.push(compactCoreEntityDetail(kind, entity));
      }
    }
    if (!entities.length) return failure("core_entity_not_resolved", { query }, loadedIdentity);
    return {
      schema: DECISION_MATH_SERVICE_SCHEMA,
      operation: "query_core_entities",
      executable: true,
      confidence: "exact_current_core_entity_detail",
      profile: profileIdentity(manifest, parameters, loadedIdentity),
      evidence_policy: "active_core_profile_only_no_rankings",
      source_audit: noRankingSourceAudit(["captured_core_profile_typed_entity_catalog"]),
      query,
      entities,
      claim_boundaries: {
        current_core_facts_only: true,
        ranking_strength: false,
        inferred_role_is_proxy_only: true,
      },
    };
  }

  async function calculateQuestion(text, context = {}) {
    const query = String(text || "");
    if (!QUESTION_MATH_PATTERN.test(query) && !context.force_theorycraft) return null;
    const lineupEntityIntent = /(阵容|羁绊|棋子|英雄|lineup|comp|trait)/i.test(query);
    const queryArchetype = context.archetype || theorycraftArchetypeFromQuery(query);
    const explicitLineupIntent = Boolean(queryArchetype)
      || /(?:给我|来一套|推荐|搭|组|构造|配一套|最高上限|过渡|替换).{0,12}(?:阵容|羁绊|棋子|英雄)|(?:阵容|羁绊).{0,12}(?:搭|组|构造|推荐|最高上限|过渡|替换)|九五|95\s*(?:阵容|体系)|lineup|comp/iu.test(query);
    let explicitAugmentIntent = /(强化|海克斯|augment)/i.test(query);
    const explicitItemIntent = /(装备|合装|成装|神器|光明装备|神装|item|equip)/i.test(query);
    const itemDecisionIntent = /(?:推荐|选择|怎么(?:配|出|选)|出装|神装|最好|适合|替换|分配).{0,12}(?:装备|合装|成装|神器|光明装备|item|equip)|(?:装备|合装|成装|神器|光明装备|神装|item|equip).{0,12}(?:推荐|选择|怎么(?:配|出|选)|最好|适合|替换|分配)/iu.test(query);
    const openItemLookupIntent = /(?:神器|装备|成装|光明装备|转职|纹章).{0,16}(?:呢|有哪些|有什么|找|看看|列出|里面|所有|自己选|最适配)|(?:找|看看|列出|从.{0,8}(?:神器|装备|成装|光明装备|转职|纹章)).{0,20}(?:适合|推荐|最好|候选)?/iu.test(query);
    const resolvedItemDecisionIntent = itemDecisionIntent || openItemLookupIntent;
    const augmentDecisionIntentFromText = /(?:推荐|选择|怎么选|最好|适合|刷新|保留).{0,12}(?:强化|海克斯|augment)|(?:强化|海克斯|augment).{0,12}(?:推荐|选择|怎么选|最好|适合|刷新|保留)/iu.test(query);
    const mentionMatches = selectEntityMentions(query, catalogs)
      .filter((entry) => entry.kind !== "item"
        || entry.canonical
        || explicitItemIntent
        || !AMBIGUOUS_ATTRIBUTE_ALIAS_TERMS.has(entry.normalized_term));
    const mentioned = Object.fromEntries(Object.keys(catalogs).map((kind) => {
      const rows = mentionMatches.filter((entry) => entry.kind === kind).map((entry) => entry.row);
      return [kind, [...new Map(rows.map((row) => [String(row.address || row.id || row.name), row])).values()]];
    }));
    const explicitAugmentCandidateSet = context.candidates
      || context.candidate_augments
      || context.current_match_user_report?.candidates
      || null;
    explicitAugmentIntent ||= mentioned.augment.length > 0;
    const augmentDecisionIntent = augmentDecisionIntentFromText
      || (asArray(explicitAugmentCandidateSet).length > 0 && explicitAugmentIntent);
    const champion = mentioned.champion[0] || context.champion || null;
    const openAugmentRecommendation = /(什么|哪些|最好|推荐|选择|怎么选)/i.test(query);
    const augmentCandidates = explicitAugmentCandidateSet
      || (openAugmentRecommendation ? [] : mentioned.augment.map((row) => row.id));
    const baseRequest = {
      ...context,
      query,
      champion: champion?.id || champion?.name || champion,
      star: context.star || 1,
      items: [...new Set([
        ...asArray(context.items),
        ...mentioned.item.map((row) => row.id),
      ])],
      augments: [...new Set([
        ...asArray(context.augments),
        ...mentioned.augment.map((row) => row.id),
      ])],
      traits: [
        ...asArray(context.traits),
        ...mentioned.trait.map((row) => ({ id: row.id, count: context.trait_counts?.[row.id] ?? context.trait_counts?.[row.name] })),
      ],
      season_mechanics: [...new Set([
        ...asArray(context.season_mechanics),
        ...mentioned.season_mechanic.map((row) => row.id),
      ])],
    };
    const entityDetailIntent = /(技能|属性|效果|几费|费用|定位|是什么|有哪些|怎么样|干什么|怎么玩)/i.test(query)
      && !/(搭|组|构造|推荐|最高上限|过渡).{0,8}(?:阵容|羁绊)|(?:阵容|羁绊).{0,8}(?:搭|组|构造|推荐|最高上限|过渡)/i.test(query);
    const mentionedEmblems = mentioned.trait
      .filter((trait) => {
        const traitName = escapeRegExp(trait.name);
        return new RegExp(`(?:${traitName}.{0,3}(?:纹章|转职)|(?:纹章|转职).{0,3}${traitName})`, "iu").test(query);
      })
      .map((trait) => ({ trait: trait.id, count: 1 }));
    const entityDetailKinds = new Set([
      ...(mentioned.champion.length ? ["champion"] : []),
      ...(mentioned.trait.length && lineupEntityIntent ? ["trait"] : []),
      ...(mentioned.item.length && (explicitItemIntent || (!explicitLineupIntent && !explicitAugmentIntent)) ? ["item"] : []),
      ...(mentioned.augment.length && explicitAugmentIntent ? ["augment"] : []),
      ...(mentioned.season_mechanic.length ? ["season_mechanic"] : []),
    ]);
    const hasScopedEntityDetail = [...entityDetailKinds]
      .some((kind) => asArray(mentioned[kind]).length > 0);
    const entityDetails = context.force_theorycraft && entityDetailIntent && hasScopedEntityDetail
      ? queryCoreEntities(mentioned, query, entityDetailKinds)
      : null;
    const lineupCorrectionIntent = /(?:阵容|羁绊|五费卡|主\s*c|主\s*t|主坦)[^。？！]{0,16}(?:没有|不对|不搭|不合格|重来|重做|重新|换一套)|(?:不就是|不对|不合格|重来|重做|重新|换一套|给一套|来一套)[^。？！]{0,16}(?:阵容|羁绊|五费卡|主\s*c|主\s*t|主坦)/iu.test(query);
    const lineupDecisionIntent = explicitLineupIntent || lineupCorrectionIntent;
    const semanticSeed = buildSemanticSeed({
      query,
      context: {
        ...context,
        intent: lineupEntityIntent ? "construct_or_evaluate_lineup" : "evaluate_strategy",
        requested_domains: [
          ...(lineupDecisionIntent ? ["lineup"] : []),
          ...(itemDecisionIntent ? ["itemization"] : []),
          ...(augmentDecisionIntent ? ["augment"] : []),
        ],
        target_role: context.target_role,
      },
      archetype: queryArchetype,
      referencedEntities: Object.values(mentioned).flat().map((row) => row?.name || row?.id),
      sourcePolicy: context.source_policy || (context.hard_data_only ? "active_core_profile_only" : "current_selected_context"),
    });
    const requestedDomains = [entityDetails, lineupDecisionIntent, resolvedItemDecisionIntent, augmentDecisionIntent]
      .filter(Boolean).length;
    if (entityDetails && requestedDomains === 1) return entityDetails;
    if (context.force_theorycraft && !entityDetails && !lineupDecisionIntent && !augmentDecisionIntent && resolvedItemDecisionIntent) {
      return calculate({
        ...baseRequest,
        operation: "optimize_item_loadouts",
        allowed_item_categories: context.allowed_item_categories || itemCategoriesFromQuery(query),
      });
    }
    if (context.force_theorycraft) {
      const solveLineupQuestion = async () => {
        const archetype = queryArchetype;
        const queryPopulation = populationFromTheorycraftQuery(query, null);
        const explicitPopulation = context.population ?? archetype?.target_population ?? queryPopulation ?? context.level;
        const population = explicitPopulation == null
          ? populationFromTheorycraftQuery(query, 9)
          : finiteNumber(explicitPopulation, populationFromTheorycraftQuery(query, 9));
        const transitionPopulations = asArray(context.transition_populations).length
          ? asArray(context.transition_populations)
          : transitionPopulationsFromTheorycraftQuery(query, population);
        const archetypePolicy = getLineupArchetypePolicy(archetype, population);
        return solveTraitRosterRoleCoverage({
          ...baseRequest,
          ...context,
          query,
          semantic_seed: semanticSeed,
          population,
          archetype,
          carry_cost_target: context.carry_cost_target ?? archetype?.carry_cost ?? null,
          main_carry: context.main_carry || context.target_main_carry || baseRequest.champion,
          main_tank: context.main_tank || context.target_main_tank,
          auto_select_cores: context.auto_select_cores === true
            || !(context.main_carry || context.target_main_carry || baseRequest.champion)
            || !(context.main_tank || context.target_main_tank),
          minimum_main_carry_cost: context.minimum_main_carry_cost
            ?? archetype?.carry_cost
            ?? (/(?:九五|95\s*阵容|95\s*体系|最高上限)/iu.test(query) ? 5 : null),
          maximum_main_carry_cost: context.maximum_main_carry_cost
            ?? archetype?.carry_cost
            ?? null,
          minimum_main_tank_cost: context.minimum_main_tank_cost
            ?? (/(?:九五|95\s*阵容|95\s*体系|最高上限)/iu.test(query) ? 4 : null),
          maximum_main_tank_cost: context.maximum_main_tank_cost
            ?? archetypePolicy.maxCoreUnitCost,
          max_unit_cost: context.max_unit_cost
            ?? archetypePolicy.maxCoreUnitCost,
          star_targets: context.star_targets,
          required_conditions: context.required_conditions,
          transition_populations: transitionPopulations,
          candidate_count: context.candidate_count
            ?? context.requested_candidate_count
            ?? candidateCountFromTheorycraftQuery(query)
            ?? null,
          emblems: asArray(context.emblems).length ? context.emblems : mentionedEmblems,
          target_traits: asArray(context.target_traits).length ? context.target_traits : baseRequest.traits,
        });
      };
      if (requestedDomains > 1) {
        const lineup = lineupDecisionIntent ? await solveLineupQuestion() : null;
        const selectedCarry = lineup?.core_selection?.main_carry?.id
          || lineup?.roster?.find((unit) => asArray(unit.roles).includes("main_carry"))?.id
          || baseRequest.champion
          || null;
          const itemization = resolvedItemDecisionIntent && selectedCarry
          ? await optimizeItemLoadouts({
              ...baseRequest,
              ...context,
              champion: selectedCarry,
              allowed_item_categories: context.allowed_item_categories || itemCategoriesFromQuery(query),
              missing_material_inputs: [],
            })
          : null;
        const augmentResult = augmentDecisionIntent
          ? await evaluateAugmentEffectChoices({
              ...context,
              candidates: augmentCandidates,
            })
          : null;
        const frontierIds = new Set(asArray(augmentResult?.pareto_frontier).map((row) => String(row.id)));
        const compactAugments = augmentResult?.executable
          ? {
              ...augmentResult,
              candidates: asArray(augmentResult.candidates)
                .filter((row) => frontierIds.has(String(row.id)))
                .slice(0, 12),
              pareto_frontier: asArray(augmentResult.pareto_frontier).slice(0, 12),
              candidate_count_before_compaction: asArray(augmentResult.candidates).length,
            }
          : augmentResult;
        return {
          schema: DECISION_MATH_SERVICE_SCHEMA,
          operation: "compose_theorycraft_decision",
          executable: [lineup, itemization, compactAugments].some((result) => result?.executable),
          confidence: "deterministic_multi_domain_core_evidence",
          profile: profileIdentity(manifest, parameters, loadedIdentity),
          evidence_policy: "active_core_profile_only_no_rankings",
          source_audit: noRankingSourceAudit([
            ...(entityDetails ? ["captured_core_profile_typed_entity_catalog"] : []),
            "captured_core_profile_champion_catalog",
            "captured_core_profile_trait_catalog",
            ...(itemization ? ["captured_core_profile_item_catalog", "common_formula_kernel"] : []),
            ...(compactAugments ? ["captured_core_profile_augment_catalog"] : []),
          ]),
          components: {
            entity_details: entityDetails,
            lineup,
            itemization,
            augments: compactAugments,
          },
          semantic_seed: semanticSeed,
          claim_boundaries: {
            ranking_strength: false,
            universal_best_lineup: false,
            universal_best_items: false,
            universal_best_augment: false,
            host_must_explain_tradeoffs_and_defaults: true,
          },
        };
      }
      if (!QUESTION_MATH_PATTERN.test(query)) {
        if (lineupDecisionIntent) return solveLineupQuestion();
        if (augmentDecisionIntent) {
          return evaluateAugmentEffectChoices({
            ...context,
            candidates: augmentCandidates,
          });
        }
        return hasScopedEntityDetail ? queryCoreEntities(mentioned, query, entityDetailKinds)
          : failure("theorycraft_domain_not_resolved", { query }, loadedIdentity);
      }
    }
    if (/(几下|几次普攻|普攻.*施法|施法.*普攻|启动)/.test(query)) {
      return calculate({ ...baseRequest, operation: "attacks_to_cast" });
    }
    if (/(刷新概率|抽到|搜到|D到|牌库)/i.test(query)) {
      return calculate({ ...baseRequest, operation: "shop_odds" });
    }
    if (/(升星|几张)/.test(query)) {
      const targetStar = /二星|2星/.test(query) ? 2 : 3;
      return calculate({ ...baseRequest, operation: "star_upgrade_copies", target_star: targetStar });
    }
    if (/(扣.{0,8}血|掉.{0,8}血|玩家伤害|失败伤害)/.test(query)) {
      const stageFromText = query.match(/([1-7])\s*阶段/)?.[1];
      const survivorsFromText = query.match(/(?:存活|剩下?|还剩)\s*(\d+)\s*(?:个|只|张)?/)?.[1];
      return calculate({
        ...baseRequest,
        operation: "pvp_player_damage",
        stage: context.stage ?? stageFromText,
        surviving_enemy_units: context.surviving_enemy_units ?? context.alive_enemy_units ?? survivorsFromText,
      });
    }
    if (/(收入|利息|连胜|连败|下回合.*金币)/.test(query)) {
      return calculate({ ...baseRequest, operation: "economy" });
    }
    if (/(经验|升级|升人口|上人口|买级|拉\s*\d+)/.test(query)) {
      const targetLevelFromText = query.match(/(?:升|上|拉|到)\s*(\d{1,2})\s*(?:级|人口)?/)?.[1];
      return calculate({
        ...baseRequest,
        operation: "level_timing",
        xp: context.xp ?? context.current_xp,
        target_level: context.target_level ?? targetLevelFromText,
      });
    }
    if (/(单次伤害|期望伤害|暴击伤害|击杀次数|伤害怎么算)/.test(query)) {
      return calculate({ ...baseRequest, operation: "damage" });
    }
    if (!champion) return failure("champion_required_for_stat_composition", { query }, loadedIdentity);
    return calculate({ ...baseRequest, operation: "compose_unit_stats" });
  }

  let knowledgeIndex;
  const createRelationIndex = (boundSources = {}) => buildKnowledgeRelationIndex({
    ...boundSources,
    snapshotId: boundSources.snapshotId || loadedIdentity.core_profile_id,
    coreProfileId: loadedIdentity.core_profile_id,
    core: { champions, items, augments, traits },
  });
  const queryKnowledge = (query = {}) => {
    knowledgeIndex ||= createRelationIndex();
    const names = asArray(query.entity_names).map((name) => {
      for (const kind of ["champion", "item", "augment", "trait"]) {
        const resolved = resolveEntity(catalogs[kind], name, kind);
        if (resolved.entity) return resolved.entity.id || resolved.entity.name;
      }
      return name;
    });
    return queryKnowledgeRelationIndex(knowledgeIndex, { ...query, entity_names: names });
  };
  return Object.freeze({
    schema: DECISION_MATH_SERVICE_SCHEMA,
    resolveMentionedFacts(text) {
      const mentions = selectEntityMentions(String(text || ""), catalogs, { preserveAmbiguity: true })
        .filter((entry) => entry.canonical || !AMBIGUOUS_ATTRIBUTE_ALIAS_TERMS.has(entry.normalized_term));
      const mentioned = Object.fromEntries(Object.keys(catalogs).map((kind) => [kind,
        [...new Map(mentions.filter((entry) => entry.kind === kind)
          .map((entry) => [String(entry.row.id || entry.row.name), entry.row])).values()],
      ]));
      if (!mentions.length) return null;
      const result = queryCoreEntities(mentioned, String(text || ""));
      const groups = new Map();
      for (const entry of mentions) {
        const key = `${entry.start}:${entry.end}`;
        groups.set(key, [...(groups.get(key) || []), entry]);
      }
      result.ambiguous_mentions = [...groups.values()].filter((group) => group.length > 1)
        .map((group) => ({ term: group[0].term || group[0].normalized_term,
          candidates: group.map((entry) => ({ kind: entry.kind, id: entry.row.id, name: entry.row.name })) }));
      result.truncated_entity_kinds = Object.entries(mentioned).filter(([, rows]) => rows.length > 8)
        .map(([kind, rows]) => ({ kind, total: rows.length, returned: 8 }));
      return result;
    },
    queryKnowledge,
    createRelationIndex,
    profile: profileIdentity(manifest, parameters, loadedIdentity),
    calculate,
    calculateQuestion,
    composeUnitStats,
    attacksToCast,
    shopOdds,
    optimizeItemLoadouts,
    evaluateAugmentEffectChoices,
    solveTraitRosterRoleCoverage,
  });
}

function validateLoadedIdentity({
  manifest,
  hardDataManifest,
  coreProfile,
  decisionInputCatalog,
  decisionInputCatalogRaw,
  expectedIdentity,
}) {
  const catalogIdentity = decisionInputCatalog?.source_identity || {};
  const coreProfileId = coreProfile?.core_profile_id || coreProfile?.combined_fingerprint || null;
  const recordedCatalogSha256 = coreProfile?.decision_input_catalog_sha256 || null;
  if (!coreProfileId || !recordedCatalogSha256 || !catalogIdentity?.catalog_source_fingerprint) {
    throw new Error("decision_math_identity_artifacts_incomplete");
  }
  if (sha256Raw(decisionInputCatalogRaw) !== recordedCatalogSha256) {
    throw new Error("decision_math_identity_mismatch:decision_input_catalog_sha256");
  }
  const observed = {
    core_profile_id: coreProfileId,
    season_id: manifest?.identity?.season_id || coreProfile?.season_id || null,
    patch_id: manifest?.runtime_patch_id || manifest?.identity?.patch_id || null,
    hard_data_manifest_fingerprint: sha256(manifest),
    catalog_source_fingerprint: catalogIdentity.catalog_source_fingerprint,
  };
  const artifactExpectations = {
    core_profile_id: catalogIdentity.core_profile_id,
    season_id: catalogIdentity.season_id,
    patch_id: catalogIdentity.active_patch_id,
    hard_data_manifest_fingerprint: catalogIdentity.hard_data_manifest_fingerprint,
  };
  for (const key of ["core_profile_id", "season_id", "patch_id", "hard_data_manifest_fingerprint"]) {
    if (String(artifactExpectations[key] || "") !== String(observed[key] || "")) {
      throw new Error(`decision_math_identity_mismatch:${key}`);
    }
    if (expectedIdentity?.[key] && String(expectedIdentity[key]) !== String(observed[key] || "")) {
      throw new Error(`decision_math_identity_mismatch:${key}`);
    }
  }
  if (expectedIdentity?.catalog_source_fingerprint
    && String(expectedIdentity.catalog_source_fingerprint) !== String(observed.catalog_source_fingerprint)) {
    throw new Error("decision_math_identity_mismatch:catalog_source_fingerprint");
  }
  return observed;
}

function profileIdentity(manifest, parameters, loadedIdentity) {
  return {
    ...loadedIdentity,
    season_id: loadedIdentity?.season_id || manifest?.identity?.season_id || null,
    patch_id: loadedIdentity?.patch_id || manifest?.runtime_patch_id || manifest?.identity?.patch_id || null,
    source_package_id: manifest?.packageId || null,
    parameter_authority: parameters?.provenance?.authority || "unknown",
  };
}

function failure(reason, details, profile = null) {
  return {
    schema: DECISION_MATH_SERVICE_SCHEMA,
    executable: false,
    confidence: "insufficient_or_ambiguous_input",
    reason,
    details,
    profile,
    output: {},
  };
}
