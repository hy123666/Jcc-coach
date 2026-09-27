import { inferAugmentCategoryIds } from "./augment-semantic-taxonomy.js";

const SEMANTIC_FEATURE_INDEX_SCHEMA = "jcc-semantic-feature-index-v1";
const SEMANTIC_FEATURE_PACKET_SCHEMA = "jcc-semantic-feature-packet-v1";
const FEATURE_NAMESPACES = new Set([
  "identity", "category", "role", "effect", "trigger", "target", "output", "cadence", "condition",
  "delivery", "reliability", "scaling", "commitment", "rule_change", "failure", "risk", "tempo",
  "route", "objective", "formation", "evidence",
]);

const EFFECT_PATTERNS = Object.freeze([
  ["effect.attack_damage", /(?:攻击力|物理伤害|attack damage|\bad\b)/iu],
  ["effect.spell_power", /(?:法术强度|法术加成|法强|magic power|ability power|\bap\b)/iu],
  ["effect.attack_speed", /(?:攻击速度|攻速|attack speed)/iu],
  ["effect.mana_gain", /(?:回蓝|法力回复|获得法力|mana gain|mana per attack)/iu],
  ["effect.mana", /(?:初始法力|最大法力|法力值|mana)/iu],
  ["effect.armor", /(?:护甲|armor)/iu],
  ["effect.magic_resist", /(?:魔抗|魔法抗性|magic resist)/iu],
  ["effect.health", /(?:生命值|最大生命|health|\bhp\b)/iu],
  ["effect.durability", /(?:耐久度|durability)/iu],
  ["effect.damage_amp", /(?:伤害增幅|增伤|damage amp)/iu],
  ["effect.damage_reduction", /(?:伤害减免|减伤|damage reduction)/iu],
  ["effect.penetration", /(?:穿透|破甲|shred|penetration)/iu],
  ["effect.wound", /(?:重伤|降低受到的治疗|anti.?heal)/iu],
  ["effect.armor_shred", /(?:护甲(?:削减|击碎)|破甲|护甲.{0,8}降低|降低.{0,8}护甲)/iu],
  ["effect.magic_resist_shred", /(?:魔抗(?:削减|击碎)|破魔|魔抗.{0,8}降低|降低.{0,8}魔抗)/iu],
  ["effect.crit_chance", /(?:暴击率|暴击几率|critical strike)/iu],
  ["effect.healing", /(?:治疗|回复生命|吸血|healing|omnivamp)/iu],
  ["effect.shield", /(?:护盾|shield)/iu],
  ["effect.control", /(?:眩晕|定身|沉默|击飞|嘲讽|控制|stun|crowd control)/iu],
  ["effect.economy", /(?:金币|利息|经济|gold|economy)/iu],
  ["effect.experience", /(?:经验|升级|experience|\bxp\b)/iu],
  ["effect.item_generation", /(?:获得.*装备|装备锻造|item generation|item grant)/iu],
  ["effect.team_size", /(?:队伍规模|人口上限|team size)/iu],
  ["rule_change.stat_override", /(?:攻速|攻击速度).{0,8}(?:锁定|固定)|(?:锁定|覆盖).{0,8}(?:攻速|攻击速度)/iu],
]);

const TRIGGER_PATTERNS = Object.freeze([
  ["trigger.combat_start", /(?:战斗开始|combat start)/iu],
  ["trigger.basic_attack", /(?:普攻|每次攻击|攻击时|攻击后|攻击造成|basic attack)/iu],
  ["trigger.cast", /(?:施法|释放技能|cast)/iu],
  ["trigger.kill", /(?:击杀|参与击杀|参与击败|\bkill(?:s|ed|ing)?\b|\btakedowns?\b)/iu],
  ["trigger.low_health", /(?:低于.*生命|生命值低于|low health)/iu],
  ["trigger.timed", /(?:\d+\s*秒|每隔.*秒|after .*second|every .*second)/iu],
  ["trigger.round_start", /(?:回合开始|round start)/iu],
  ["trigger.shop_refresh", /(?:刷新商店|商店刷新|shop refresh)/iu],
  ["trigger.level_up", /(?:升级时|提升等级|level up)/iu],
  ["trigger.purchase", /(?:购买后|购买时|purchase)/iu],
]);

const AUGMENT_SEMANTIC_PATTERNS = Object.freeze([
  ["effect.item_conversion", /(?:装备.*变化|装备.*转换|重铸|拆卸|item conversion|reroll.*item)/iu],
  ["effect.shop_access", /(?:免费.*刷新|商店刷新|刷新商店|商店概率|shop refresh|shop odds)/iu],
  ["effect.leveling", /(?:购买经验|获得.*经验|升级|人口|level|experience|\bxp\b)/iu],
  ["effect.trait_enablement", /(?:羁绊|特质|职业|纹章|转职|trait|emblem)/iu],
  ["effect.star_up", /(?:升星|三星|二星|复制器|star.?up|duplicator)/iu],
  ["effect.unit_generation", /(?:获得.*弈子|获得.*棋子|获得.*英雄|复制器|grant.*unit)/iu],
  ["effect.loot", /(?:战利品|奖励|宝箱|法球|锻造器|loot|reward|anvil)/iu],
  ["trigger.combat_result", /(?:战斗后|战斗环节之后|玩家对战回合后|combat result|after combat)/iu],
  ["trigger.win", /(?:获胜|胜利|赢下|如果你赢|when you win)/iu],
  ["trigger.loss", /(?:失败|输掉|如果你输|when you lose|after losing)/iu],
  ["trigger.player_elimination", /(?:玩家被淘汰|玩家出局|player eliminated)/iu],
  ["trigger.stage_start", /(?:阶段开始|stage start)/iu],
  ["trigger.after_rounds", /(?:\d+\s*(?:个|场|轮)?回合后|需要\s*\d+\s*个回合|after\s*\d+\s*round)/iu],
  ["trigger.item_equipped", /(?:携带.*装备|装备给|equipped|holder)/iu],
  ["trigger.unit_star_up", /(?:升星时|达到三星|star.?up)/iu],
  ["trigger.trait_threshold", /(?:达到.*羁绊|登场.*羁绊|trait threshold)/iu],
  ["delivery.immediate", /(?:即刻|立即|立刻|马上|immediately)/iu],
  ["delivery.recurring", /(?:每回合|回合开始时|每当|每次|每个玩家战斗|持续\s*\d+\s*(?:个|场|轮)?回合|each round|whenever|every time)/iu],
  ["delivery.delayed", /(?:回合后|倒计时|孵化|之后获得|未来.*回合|after.*round|countdown|delayed)/iu],
  ["delivery.milestone", /(?:达到|完成|累计|当你.*时|upon reaching|after earning)/iu],
  ["delivery.permanent", /(?:永久|接下来的时间|全局|permanent)/iu],
  ["reliability.random", /(?:随机|骰子|\brandom(?:ly)?\b|\d+%\s*(?:概率|几率).{0,16}(?:获得|触发|掉落)|\d+%\s+chance\s+to\b)/iu],
  ["reliability.choice", /(?:选择|任选|从.*中选|choose|select one)/iu],
  ["reliability.conditional", /(?:如果|若|当|需要|之后|每当|条件|if |when |requires?)/iu],
  ["scaling.per_round", /(?:每回合|每个回合|per round|each round)/iu],
  ["scaling.per_stage", /(?:每阶段|阶段开始|per stage)/iu],
  ["scaling.per_level", /(?:每级|每个等级|根据等级|per level)/iu],
  ["scaling.per_star", /(?:每星级|根据星级|per star)/iu],
  ["scaling.per_trait", /(?:每个羁绊|羁绊数|per trait)/iu],
  ["scaling.per_kill", /(?:每次击杀|参与击杀|参与击败|每参与击败|per kill|takedown)/iu],
  ["scaling.capped", /(?:最多|上限|至多|up to|capped)/iu],
  ["scaling.uncapped", /(?:无限|无上限|uncapped)/iu],
  ["commitment.reroll", /(?:追三|三星|刷新商店|慢D|reroll)/iu],
  ["commitment.fast_level", /(?:快速升级|升到\s*[89]|上[89]|fast.?level|fast.?8|fast.?9)/iu],
  ["commitment.trait_locked", /(?:特定羁绊|指定羁绊|羁绊专属|trait-specific)/iu],
  ["commitment.champion_locked", /(?:英雄专属|弈子专属|技能现在|成为一名|champion-specific|hero augment)/iu],
  ["rule_change.shop", /(?:商店.*转化|刷新商店时.*获得|商店概率|shop.*(?:change|convert))/iu],
  ["rule_change.interest", /(?:利息上限|不再.*利息|无法.*利息|interest cap|no longer.*interest)/iu],
  ["rule_change.leveling", /(?:不能再购买经验|购买经验.*额外|经验费用|cannot buy.*xp|xp purchase)/iu],
  ["rule_change.items", /(?:装备会随机变化|装备转换|装备.*拆分|item.*change|item.*convert)/iu],
  ["rule_change.trait_count", /(?:羁绊计数|提供\s*\+?\d+\s*羁绊|trait count)/iu],
  ["rule_change.combat", /(?:输掉该回合|技能现在|战斗规则|lose the round|combat rule)/iu],
  ["rule_change.augment_tier", /(?:下一个强化符文.*位阶|next augment.*tier)/iu],
  ["failure.condition_unmet", /(?:否则|未达成|条件未满足|otherwise|if not)/iu],
  ["failure.payout_unreached", /(?:倒计时|孵化|玩家被淘汰|被淘汰前|countdown|before payout)/iu],
  ["failure.round_loss", /(?:输掉该回合|直接失败|lose the round)/iu],
  ["failure.resource_forfeit", /(?:失去|不再获得|无法获得|forfeit|lose all)/iu],
  ["risk.hp_cost", /(?:损失.*生命值|扣除.*生命值|消耗.*生命值|lose.*health|hp cost)/iu],
  ["risk.interest_loss", /(?:不再.*利息|无法.*利息|失去.*利息|no interest)/iu],
  ["risk.random_variance", /(?:随机|骰子|\brandom(?:ly)?\b|\d+%\s*(?:概率|几率).{0,16}(?:获得|触发|掉落)|\d+%\s+chance\s+to\b)/iu],
  ["risk.delayed_payout", /(?:回合后|倒计时|孵化|玩家被淘汰|after.*round|countdown)/iu],
  ["risk.lock_in", /(?:专属|指定英雄|指定羁绊|不能再|champion-specific|trait-specific)/iu],
  ["risk.failure_loss", /(?:输掉该回合|失败时损失|否则失去|lose the round)/iu],
  ["risk.rule_restriction", /(?:不能再|无法|限制|cannot|no longer)/iu],
]);

const AUGMENT_CATEGORY_FEATURES = Object.freeze({
  combat: ["category.combat", "objective.stabilization"],
  economy: ["category.economy", "objective.economy"],
  equipment: ["category.equipment", "route.itemization"],
  trait: ["category.trait", "objective.trait_coverage", "objective.lineup_fit"],
  tempo: ["category.tempo", "objective.stabilization"],
  exclusive: ["category.exclusive", "objective.lineup_fit"],
  special: ["category.special"],
});

const AUGMENT_CATEGORY_ALIASES = Object.freeze({
  combat: "combat",
  power: "combat",
  "战力": "combat",
  economy: "economy",
  econ: "economy",
  "经济": "economy",
  equipment: "equipment",
  item: "equipment",
  "装备": "equipment",
  trait: "trait",
  emblem: "trait",
  "羁绊": "trait",
  tempo: "tempo",
  "节奏": "tempo",
  exclusive: "exclusive",
  hero: "exclusive",
  "专属": "exclusive",
  other: "special",
  special: "special",
  "其他": "special",
  "特殊": "special",
});

const AUGMENT_MEANINGFUL_PREFIXES = Object.freeze([
  "effect.", "trigger.", "delivery.", "reliability.", "scaling.", "commitment.", "rule_change.", "failure.", "risk.",
]);

const ROUTE_FEATURES = Object.freeze({
  lineup_direction: "route.lineup_direction",
  lineup_data_query: "route.lineup_data_query",
  lineup_execution: "route.lineup_execution",
  itemization: "route.itemization",
  augment_choice: "route.augment_choice",
  roll_or_level: "route.roll_or_level",
  economy: "route.economy",
  positioning: "route.positioning",
  transition: "route.transition",
  numeric_calculation: "route.numeric_calculation",
});

function asArray(value) {
  return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).flatMap((value) => (
    Array.isArray(value) ? value : [value]
  )).map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
}

function orderedUniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of asArray(values).flat()) {
    const text = String(value ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stableText(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function semanticTextFragments(values) {
  return orderedUniqueStrings(asArray(values).flatMap((value) => {
    if (typeof value === "string" || typeof value === "number") return [value];
    if (!value || typeof value !== "object") return [];
    return [value.source_text, value.text, value.description, value.desc];
  })).join(" ");
}

function augmentSemanticText(entity) {
  const effects = entity?.effects || {};
  return semanticTextFragments([
    entity?.desc,
    entity?.description,
    effects?.source_text,
    ...asArray(effects?.exact_effect_blocks),
    ...asArray(effects?.structured_terms),
    ...asArray(effects?.structured_terms).flatMap((term) => asArray(term?.metrics)),
  ]);
}

function randomEquipmentRewardPlaceholder(entity) {
  const name = String(entity?.normalized_name || entity?.name || "").normalize("NFKC").trim();
  const placeholderName = /^(?:随机(?:基础装备|成装|纹章)|random\s+(?:component|completed(?:\s+item)?|emblem))$/iu.test(name);
  if (!placeholderName) return false;
  const meaningfulDescription = semanticTextFragments([
    entity?.basic_desc,
    entity?.desc,
    entity?.description,
    entity?.effects?.source_text,
  ]).replaceAll(name, "").replaceAll("-", "").trim();
  return !meaningfulDescription
    && !asArray(entity?.structured_stats).length
    && !asArray(entity?.effects?.structured_terms).length
    && !entity?.recipe
    && !entity?.primary_role
    && !asArray(entity?.browse_facets).length;
}

export function semanticFeatureTaxonomy(commonSemanticDocument) {
  const entries = asArray(commonSemanticDocument?.entries);
  const features = new Set(asArray(entries.find((entry) => entry?.id === "controlled_feature_ids")?.values));
  const relations = new Set(asArray(entries.find((entry) => entry?.id === "controlled_relation_ids")?.values));
  if (!features.size || !relations.size) throw new Error("Common semantic feature registry is missing controlled ids");
  for (const feature of features) {
    if (!FEATURE_NAMESPACES.has(String(feature).split(".")[0])) throw new Error(`Unknown controlled semantic feature: ${feature}`);
  }
  for (const relation of relations) {
    if (!String(relation).startsWith("relation.")) throw new Error(`Unknown controlled semantic relation: ${relation}`);
  }
  return {
    logical_id: commonSemanticDocument.logical_id,
    features,
    relations,
    feature_ids: [...features].sort(),
    relation_ids: [...relations].sort(),
  };
}

function assertControlled(values, allowed, kind) {
  for (const value of uniqueStrings(values)) {
    if (!allowed.has(value)) throw new Error(`Unknown controlled semantic ${kind}: ${value}`);
  }
}

function featureMatches(text, mappings) {
  return mappings.filter(([, pattern]) => pattern.test(text)).map(([feature]) => feature);
}

function augmentCategories(entity) {
  const raw = [
    ...asArray(entity?.category_ids),
    ...asArray(entity?.category_labels),
    ...asArray(entity?.tags)
      .map((tag) => String(tag || "").match(/^augment_category:(.+)$/iu)?.[1])
      .filter(Boolean),
  ];
  const declared = uniqueStrings(raw.map((value) => AUGMENT_CATEGORY_ALIASES[String(value || "").trim().toLowerCase()]));
  return declared.length ? declared : inferAugmentCategoryIds(entity);
}

function augmentRequiredContextFields(features) {
  const set = new Set(features);
  const fields = [];
  if (set.has("delivery.delayed") || set.has("risk.hp_cost") || set.has("failure.payout_unreached")) fields.push("hp", "board_power_score");
  if (set.has("effect.economy") || set.has("risk.interest_loss") || set.has("rule_change.interest")) fields.push("gold");
  if (set.has("effect.leveling") || set.has("rule_change.leveling")) fields.push("level", "gold");
  if (set.has("effect.shop_access") || set.has("effect.star_up")) fields.push("unit_copy_progress");
  if (set.has("effect.item_conversion") || set.has("effect.item_generation")) fields.push("item_state");
  if (set.has("effect.trait_enablement") || set.has("commitment.trait_locked")) fields.push("candidate_lineup_context");
  if (set.has("commitment.champion_locked")) fields.push("owned_units");
  if (set.has("rule_change.augment_tier")) fields.push("selected_augment_count", "stage_round");
  return uniqueStrings(fields);
}

function augmentFeatureEvidence(entity, features) {
  const categories = new Set(augmentCategories(entity).flatMap((category) => asArray(AUGMENT_CATEGORY_FEATURES[category])));
  const declaredCategoryFeatures = new Set([...categories, "route.augment_choice"]);
  return features.map((feature) => {
    const fromCategory = declaredCategoryFeatures.has(feature);
    const fromDefault = feature === "delivery.immediate"
      || feature === "reliability.guaranteed"
      || feature === "commitment.universal";
    return {
      feature,
      source: fromCategory ? "declared_source_category" : fromDefault ? "absence_of_explicit_constraint" : "normalized_effect_text",
      confidence: fromCategory ? "high" : fromDefault ? "medium" : entity?.effects?.parse_status === "structured" ? "high" : "medium",
    };
  });
}

function referencedRewardItems(sourceText, referenceNames = {}) {
  const normalized = String(sourceText || "").normalize("NFKC").toLowerCase();
  return asArray(referenceNames.items).filter((item) => (
    item?.normalized_name?.length >= 2 && normalized.includes(item.normalized_name)
  ));
}

function rewardKindsForText(sourceText, grantedItems = []) {
  const rewardKinds = [];
  if (/(?:神器|奥恩神器|artifact)/iu.test(sourceText)) rewardKinds.push("artifact");
  if (/(?:光明装备|光明版|radiant)/iu.test(sourceText)) rewardKinds.push("radiant_item");
  if (/(?:纹章|转职|emblem)/iu.test(sourceText)) rewardKinds.push("emblem");
  if (/(?:金铲铲|spatula)/iu.test(sourceText)) rewardKinds.push("spatula");
  if (/(?:金锅锅|pan)/iu.test(sourceText)) rewardKinds.push("pan");
  if (/(?:成装锻造器|基础装备锻造器|神器锻造器|锻造器|anvil)/iu.test(sourceText)) rewardKinds.push("anvil");
  if (/(?:装备|item)/iu.test(sourceText) && !rewardKinds.length) rewardKinds.push("equipment");
  for (const item of grantedItems) {
    const category = String(item.category || "").normalize("NFKC").toLowerCase();
    if (/(?:神器|artifact)/iu.test(category)) rewardKinds.push("artifact");
    else if (/(?:光明|radiant)/iu.test(category)) rewardKinds.push("radiant_item");
    else if (/(?:纹章|转职|emblem)/iu.test(category)) rewardKinds.push("emblem");
    else rewardKinds.push("equipment");
  }
  return uniqueStrings(rewardKinds);
}

function rewardResolutionForText(sourceText, fallbackResolution) {
  if (/(?:随机|random)/iu.test(sourceText)) return "random_unresolved_until_observed";
  if (/(?:选择|任选|提供\s*\d+\s*个选项|choice)/iu.test(sourceText)) return "player_choice";
  return fallbackResolution;
}

function rewardEventsFromDescription(entity, fallbackResolution, referenceNames) {
  const description = String(entity?.description || entity?.desc || entity?.effects?.source_text || "")
    .normalize("NFKC")
    .trim();
  if (!description) return [];
  return description
    .split(/[。；;]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause && /(?:获得|提供|奖励|grant|provide)/iu.test(clause))
    .map((clause, index) => {
      const delayed = clause.match(/(\d+)\s*(?:个)?(?:玩家对战)?回合(?:之后|后)/u);
      const grantedItems = referencedRewardItems(clause, referenceNames);
      return {
        event_id: `reward-event-${index + 1}`,
        delivery_timing: delayed ? "delayed" : "immediate",
        trigger: delayed ? { kind: "after_rounds", rounds: Number(delayed[1]) } : null,
        resolution: rewardResolutionForText(clause, fallbackResolution),
        reward_kinds: rewardKindsForText(clause, grantedItems),
        granted_items: grantedItems.map((item) => ({
          item_id: item.id,
          item_name: item.name,
          category: item.category || null,
        })),
        source_text: clause,
      };
    })
    .filter((event) => event.reward_kinds.length);
}

function rewardTableRefsForAugment(entity, referenceNames = {}) {
  const id = String(entity?.id ?? entity?.address ?? "");
  const name = String(entity?.normalized_name || entity?.name || "").normalize("NFKC").trim();
  return uniqueStrings(asArray(referenceNames.rewardTables).filter((table) => {
    const ref = table?.entity_ref || {};
    return String(ref.kind || "") === "augment"
      && ((id && String(ref.id || "") === id)
        || (name && String(ref.name || table?.name || "").normalize("NFKC").trim() === name));
  }).map((table) => table.table_id).filter(Boolean));
}

function compileAugmentRewardPromise(entity, features, referenceNames = {}) {
  const sourceText = augmentSemanticText(entity);
  const grantedItems = referencedRewardItems(sourceText, referenceNames);
  const rewardKinds = rewardKindsForText(sourceText, grantedItems);
  if (!rewardKinds.length) return null;
  const featureSet = new Set(features);
  const timing = [
    featureSet.has("delivery.immediate") ? "immediate" : null,
    featureSet.has("delivery.delayed") ? "delayed" : null,
    featureSet.has("delivery.recurring") ? "recurring" : null,
    featureSet.has("delivery.milestone") ? "milestone" : null,
  ].filter(Boolean);
  const resolution = featureSet.has("reliability.choice")
    ? "player_choice"
    : featureSet.has("reliability.random")
      ? "random_unresolved_until_observed"
      : featureSet.has("reliability.conditional")
        ? "conditional"
        : "deterministic";
  const rewardEvents = rewardEventsFromDescription(entity, resolution, referenceNames);
  const craftResource = rewardKinds.includes("spatula") || rewardKinds.includes("pan");
  const unresolvedRandomReward = rewardKinds.some((kind) => !["spatula", "pan"].includes(kind));
  return {
    schema: "jcc-augment-reward-promise-v1",
    reward_kinds: uniqueStrings(rewardKinds),
    delivery_timing: uniqueStrings([
      ...rewardEvents.map((event) => event.delivery_timing),
      ...timing,
    ]).length ? uniqueStrings([
      ...rewardEvents.map((event) => event.delivery_timing),
      ...timing,
    ]) : ["immediate"],
    resolution,
    reward_events: rewardEvents,
    reward_table_refs: rewardTableRefsForAugment(entity, referenceNames),
    craft_resource: craftResource,
    granted_items: grantedItems.map((item) => ({
      item_id: item.id,
      item_name: item.name,
      category: item.category || null,
    })),
    requires_user_resolution: resolution === "random_unresolved_until_observed" && unresolvedRandomReward,
    source_text: sourceText || null,
    policy: {
      consume_after_confirmed_choice: true,
      ask_once_only_when_strategy_relevant: true,
      spatula_or_pan_is_a_craft_resource_not_an_already_resolved_emblem: craftResource,
      no_entity_name_special_cases: true,
    },
  };
}

function compileAugmentProfile(entity, features, referenceNames = {}) {
  const parseStatus = String(entity?.effects?.parse_status || "unknown");
  const meaningful = features.filter((feature) => AUGMENT_MEANINGFUL_PREFIXES.some((prefix) => feature.startsWith(prefix)));
  return {
    schema: "jcc-augment-semantic-profile-v1",
    augment_id: String(entity?.id ?? entity?.address ?? entity?.name ?? ""),
    name: entity?.normalized_name || entity?.name || null,
    tier: entity?.tier ?? null,
    tier_color: entity?.tier_color || null,
    category_ids: augmentCategories(entity),
    features: uniqueStrings(features),
    feature_evidence: augmentFeatureEvidence(entity, uniqueStrings(features)),
    required_context_fields: augmentRequiredContextFields(features),
    parse_status: parseStatus,
    semantic_coverage: meaningful.length ? (parseStatus === "structured" ? "classified_structured" : "classified_semantic") : "unclassified",
    source_ref: entity?.address || entity?.id || null,
    reward_promise: compileAugmentRewardPromise(entity, features, referenceNames),
    policy: {
      static_potential_only: true,
      contains_numeric_choice_score: false,
      runtime_context_required_for_all_choice_axes: true,
      no_strength_claim_without_current_context: true,
      no_entity_name_special_cases: true,
    },
  };
}

function entitySemanticText(kind, entity) {
  if (kind === "augment") return augmentSemanticText(entity);
  return stableText(entity);
}

function normalizedTraits(entity) {
  return uniqueStrings(asArray(entity?.traits).map((trait) => (
    typeof trait === "object" ? trait.id ?? trait.name : trait
  )));
}

function championRoleFeatures(entity) {
  const text = stableText([
    entity?.primary_role,
    entity?.role,
    entity?.role_key,
    entity?.supplemental_source?.role,
    entity?.supplemental_source?.role_key,
    entity?.skill,
  ]).toLowerCase();
  const range = finiteNumber(entity?.attributes_by_star?.["攻击距离"]?.[0] ?? entity?.attack_range);
  const features = [];
  if (/(?:坦克|前排|tank|frontline|fighter|战士)/iu.test(text) || (range !== null && range <= 2)) {
    features.push("role.frontline", "output.tank");
  }
  if (/(?:后排|carry|输出|射手|法师|marksman|mage)/iu.test(text) || (range !== null && range >= 3)) {
    features.push("role.backline");
  }
  if (/(?:法术|法师|magic|mage|spell|\bap\b)/iu.test(text)) features.push("output.ap", "cadence.spell_cast");
  if (/(?:物理|射手|attack|marksman|\bad\b)/iu.test(text)) features.push("output.ad", "cadence.attack");
  if (features.includes("output.ap") && features.includes("output.ad")) features.push("output.mixed");
  return features;
}

function entityPacket(kind, entity, taxonomy, referenceNames = {}) {
  const id = String(entity?.id ?? entity?.address ?? entity?.name ?? "").trim();
  if (!id) return null;
  const text = entitySemanticText(kind, entity);
  const features = [`identity.${kind}`, "evidence.core_profile"];
  features.push(...featureMatches(text, EFFECT_PATTERNS), ...featureMatches(text, TRIGGER_PATTERNS));
  if (kind === "champion") features.push(...championRoleFeatures(entity));
  if (kind === "item") {
    if (/(?:神器|光明|特殊|artifact|radiant|special)/iu.test(text)) features.push("condition.conditional_effect");
    if (features.includes("rule_change.stat_override")) features.push("failure.effect_overridden");
  }
  if (kind === "augment") {
    const categories = augmentCategories(entity);
    for (const category of categories) features.push(...asArray(AUGMENT_CATEGORY_FEATURES[category]));
    features.push(...featureMatches(text, AUGMENT_SEMANTIC_PATTERNS));
    if (/(?:己方(?:队伍|弈子|单位)?|全队|你的队伍|所有弈子|your team|all allies)/iu.test(text)) features.push("target.team");
    if (/(?:前排|最前排|frontline)/iu.test(text)) features.push("target.frontline", "commitment.frontline");
    if (/(?:后排|最后两排|backline)/iu.test(text)) features.push("target.backline");
    if (/(?:攻击力|物理伤害|attack damage|ad carry)/iu.test(text)) features.push("commitment.ad");
    if (/(?:法术强度|法强|施法|回蓝|ap carry)/iu.test(text)) features.push("commitment.ap");
    const normalizedText = text.normalize("NFKC").toLowerCase();
    if (asArray(referenceNames.traits).some((name) => normalizedText.includes(name))) {
      features.push("commitment.trait_locked");
    }
    if (categories.includes("exclusive")
      || asArray(referenceNames.champions).some((name) => normalizedText.includes(name))) {
      features.push("commitment.champion_locked");
    }
    if (!features.some((feature) => feature.startsWith("reliability."))) features.push("reliability.guaranteed");
    if (!features.some((feature) => feature.startsWith("delivery."))) features.push("delivery.immediate");
    if (!features.some((feature) => feature.startsWith("commitment."))) features.push("commitment.universal");
    if (categories.includes("economy")) features.push("route.economy", "objective.economy");
    if (categories.includes("equipment")) features.push("route.itemization");
    if (categories.includes("trait")) features.push("route.lineup_direction", "objective.trait_coverage");
    features.push("route.augment_choice");
  }
  if (kind === "trait") features.push("route.lineup_direction", "objective.trait_coverage");
  const relations = normalizedTraits(entity).map((traitId) => ({
    type: "relation.has_trait",
    target_kind: "trait",
    target_id: traitId,
  }));
  for (const feature of uniqueStrings(features)) {
    if (feature.startsWith("effect.")) {
      relations.push({ type: "relation.affects", target_kind: "semantic_feature", target_id: feature });
    } else if (feature.startsWith("trigger.")) {
      relations.push({ type: "relation.activates_after", target_kind: "semantic_feature", target_id: feature });
    }
  }
  if (kind === "item" && features.includes("rule_change.stat_override")) {
    relations.push({ type: "relation.overrides", target_kind: "semantic_feature", target_id: "effect.attack_speed" });
  }
  if (kind === "augment") {
    for (const item of referencedRewardItems(text, referenceNames)) {
      relations.push({ type: "relation.grants", target_kind: "item", target_id: item.id });
    }
  }
  assertControlled(features, taxonomy.features, "feature");
  assertControlled(relations.map((relation) => relation.type), taxonomy.relations, "relation");
  const packet = {
    entity_kind: kind,
    entity_id: id,
    name: entity?.normalized_name || entity?.name || null,
    features: uniqueStrings(features),
    relations,
    source_ref: entity?.address || entity?.id || null,
  };
  if (kind === "augment") packet.augment_profile = compileAugmentProfile(entity, packet.features, referenceNames);
  return packet;
}

export function compileCoreSemanticFeatureIndex({
  commonSemanticDocument,
  champions = [],
  items = [],
  augments = [],
  traits = [],
  rewardTables = [],
  identity = {},
} = {}) {
  const taxonomy = semanticFeatureTaxonomy(commonSemanticDocument);
  const excludedRewardPlaceholderItems = asArray(items).filter(randomEquipmentRewardPlaceholder);
  const semanticItems = asArray(items).filter((entity) => !randomEquipmentRewardPlaceholder(entity));
  const referenceNames = {
    champions: uniqueStrings(asArray(champions).map((entity) => entity?.normalized_name || entity?.name))
      .map((name) => name.normalize("NFKC").toLowerCase())
      .filter((name) => name.length >= 2),
    traits: uniqueStrings(asArray(traits).map((entity) => entity?.normalized_name || entity?.name))
      .map((name) => name.normalize("NFKC").toLowerCase())
      .filter((name) => name.length >= 2),
    items: semanticItems.map((entity) => ({
      id: String(entity?.id ?? entity?.address ?? entity?.name ?? ""),
      name: entity?.normalized_name || entity?.name || null,
      normalized_name: String(entity?.normalized_name || entity?.name || "").normalize("NFKC").toLowerCase(),
      category: entity?.category || entity?.type_name || entity?.type || entity?.classification || null,
    })).filter((item) => item.id && item.normalized_name.length >= 2),
    rewardTables: asArray(rewardTables),
  };
  const entities = [
    ...asArray(champions).map((entity) => entityPacket("champion", entity, taxonomy, referenceNames)),
    ...semanticItems.map((entity) => entityPacket("item", entity, taxonomy, referenceNames)),
    ...asArray(augments).map((entity) => entityPacket("augment", entity, taxonomy, referenceNames)),
    ...asArray(traits).map((entity) => entityPacket("trait", entity, taxonomy, referenceNames)),
  ].filter(Boolean).sort((left, right) => (
    left.entity_kind.localeCompare(right.entity_kind) || left.entity_id.localeCompare(right.entity_id)
  ));
  const featureToEntities = {};
  const relationToEntities = {};
  const routeToFeatures = {};
  for (const entity of entities) {
    for (const feature of entity.features) {
      (featureToEntities[feature] ||= []).push(`${entity.entity_kind}:${entity.entity_id}`);
      if (feature.startsWith("route.")) (routeToFeatures[feature] ||= []).push(...entity.features.filter((value) => value.startsWith("effect.") || value.startsWith("objective.")));
    }
    for (const relationRow of entity.relations) {
      (relationToEntities[relationRow.type] ||= []).push(`${entity.entity_kind}:${entity.entity_id}`);
    }
  }
  for (const key of Object.keys(featureToEntities)) featureToEntities[key] = uniqueStrings(featureToEntities[key]);
  for (const key of Object.keys(relationToEntities)) relationToEntities[key] = uniqueStrings(relationToEntities[key]);
  for (const key of Object.keys(routeToFeatures)) routeToFeatures[key] = uniqueStrings(routeToFeatures[key]);
  const augmentRows = entities.filter((entity) => entity.entity_kind === "augment");
  const parseStatusCounts = {};
  for (const row of augmentRows) {
    const status = row.augment_profile?.parse_status || "unknown";
    parseStatusCounts[status] = (parseStatusCounts[status] || 0) + 1;
  }
  return {
    schema: SEMANTIC_FEATURE_INDEX_SCHEMA,
    identity: structuredClone(identity),
    taxonomy: {
      logical_id: taxonomy.logical_id,
      feature_count: taxonomy.features.size,
      relation_count: taxonomy.relations.size,
    },
    entities,
    feature_to_entities: featureToEntities,
    relation_to_entities: relationToEntities,
    route_to_features: routeToFeatures,
    audit: {
      excluded_reward_placeholder_item_ids: uniqueStrings(excludedRewardPlaceholderItems.map((entity) => entity?.id ?? entity?.address ?? entity?.name)),
      augment_profile_count: augmentRows.length,
      unclassified_augment_ids: augmentRows
        .filter((row) => row.augment_profile?.semantic_coverage === "unclassified")
        .map((row) => row.entity_id)
        .sort(),
      uncategorized_augment_ids: augmentRows
        .filter((row) => !row.augment_profile?.category_ids?.length)
        .map((row) => row.entity_id)
        .sort(),
      augment_parse_status_counts: Object.fromEntries(Object.entries(parseStatusCounts).sort(([left], [right]) => left.localeCompare(right))),
    },
    policy: {
      typed_facts_remain_authoritative: true,
      features_only_score_within_existing_channels: true,
      no_vector_or_graph_runtime: true,
    },
  };
}

export function semanticFeaturesForEntity(index, kind, id) {
  return index?.entities?.find((entry) => entry.entity_kind === kind && entry.entity_id === String(id)) || null;
}

function relation(type, targetKind, targetId, taxonomy) {
  if (!targetId) return null;
  assertControlled([type], taxonomy.relations, "relation");
  return { type, target_kind: targetKind, target_id: String(targetId) };
}

export function compileRankingSemanticFeaturePacket(candidate, commonSemanticDocument, identity = {}) {
  const taxonomy = semanticFeatureTaxonomy(commonSemanticDocument);
  const features = ["identity.lineup", "evidence.ranking_recipe", "route.lineup_data_query", "route.lineup_execution"];
  const relations = [];
  const carryId = candidate?.main_carry?.champion_id;
  if (carryId) {
    features.push("role.main_carry");
    relations.push(relation("relation.has_main_carry", "champion", carryId, taxonomy));
  }
  for (const variant of asArray(candidate?.variants)) {
    const rosterMembers = asArray(variant?.atomic_roster_members).length
      ? asArray(variant.atomic_roster_members)
      : asArray(variant?.lineup_ids);
    for (const member of rosterMembers) {
      const memberId = typeof member === "object"
        ? member?.champion_id || member?.unit_id || member?.id
        : member;
      if (memberId) relations.push(relation("relation.contains", "champion", memberId, taxonomy));
    }
    const tankId = variant?.primary_tank?.champion_id;
    if (tankId) {
      features.push("role.main_tank");
      relations.push(relation("relation.has_main_tank", "champion", tankId, taxonomy));
    }
    for (const augmentId of asArray(variant?.associated_augment_ids)) relations.push(relation("relation.compatible_with", "augment", augmentId, taxonomy));
    for (const transition of asArray(variant?.transitions)) {
      const transitionId = transition?.variant_id || transition?.transition_id || transition?.id;
      if (transitionId) relations.push(relation("relation.transitions_to", "lineup_variant", transitionId, taxonomy));
    }
    if (asArray(variant?.transitions).some((entry) => entry?.semantic_role === "published_transition")) features.push("formation.has_published_transition", "tempo.transition");
  }
  const targetPopulation = finiteNumber(candidate?.lifecycle_prior?.target_population);
  if (targetPopulation !== null) features.push("condition.requires_population");
  const requiredItems = [
    ...asArray(candidate?.equipment_requirements?.main_carry?.formation_required_items),
    ...asArray(candidate?.equipment_requirements?.primary_tank?.formation_required_items),
  ];
  if (requiredItems.length) features.push("condition.requires_item", "risk.item_dependency");
  for (const item of requiredItems) {
    const itemId = item?.item_id || item?.id;
    if (itemId) relations.push(relation("relation.requires_item", "item", itemId, taxonomy));
  }
  if (requiredItems.some((item) => item?.item_id && /(?:emblem|纹章|转职)/iu.test(stableText(item)))) features.push("condition.requires_emblem");
  const archetype = String(candidate?.lifecycle_prior?.archetype || "");
  if (/reroll|three_cost/iu.test(archetype)) features.push("tempo.reroll");
  if (/four_cost|legendary/iu.test(archetype)) features.push("tempo.fast_level", "risk.high_cost_dependency", "risk.high_economy_cost");
  assertControlled(features, taxonomy.features, "feature");
  return {
    schema: SEMANTIC_FEATURE_PACKET_SCHEMA,
    scope: "ranking_lineup_instance",
    identity: {
      core_profile_id: identity.core_profile_id || null,
      ranking_overlay_id: identity.ranking_overlay_id || null,
      stat_date: identity.stat_date || null,
      ranking_overlay_binding: "enclosing_immutable_generation",
    },
    features: uniqueStrings(features),
    relations: relations.filter(Boolean),
    conditions: {
      target_population: targetPopulation,
      formation_required_item_ids: uniqueStrings(requiredItems.map((item) => item?.item_id)),
    },
    policy: {
      recipe_observation_only: true,
      cannot_change_strength_metrics: true,
      cannot_modify_common_vocabulary: true,
    },
  };
}

export function mapMatchFactsToSemanticFeatures(matchFacts = {}, commonSemanticDocument, identity = {}) {
  const taxonomy = semanticFeatureTaxonomy(commonSemanticDocument);
  const text = stableText(matchFacts);
  const features = ["identity.match_state", "evidence.current_match"];
  features.push(...featureMatches(text, EFFECT_PATTERNS), ...featureMatches(text, TRIGGER_PATTERNS));
  const stage = String(matchFacts?.stage_round ?? matchFacts?.stage ?? "");
  const stageNumber = finiteNumber(stage.split("-")[0]);
  if (stageNumber !== null) features.push(stageNumber <= 2 ? "tempo.early" : stageNumber <= 4 ? "tempo.mid" : "tempo.late");
  const gold = finiteNumber(matchFacts?.gold ?? matchFacts?.economy?.gold);
  if (gold !== null && gold < 20) features.push("risk.high_economy_cost");
  assertControlled(features, taxonomy.features, "feature");
  return {
    schema: SEMANTIC_FEATURE_PACKET_SCHEMA,
    scope: "current_match_transient",
    identity: {
      core_profile_id: identity.core_profile_id || null,
      ranking_overlay_id: identity.ranking_overlay_id || null,
      match_session_id: identity.match_session_id || null,
    },
    features: uniqueStrings(features),
    relations: [],
    conditions: { stage_round: stage || null, gold },
    policy: { persist_to_common_core_or_ranking: false },
  };
}

function collectOwnedUnitIds(matchFacts) {
  const ids = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach((entry) => visit(entry));
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) {
      if (/(?:champion|hero|unit|chess)_?id$/iu.test(childKey) && (typeof child === "string" || typeof child === "number")) ids.push(String(child));
      else if (typeof child === "object") visit(child);
    }
  };
  const latest = matchFacts?.latest_authoritative_facts || {};
  const live = matchFacts?.live_state_summary || latest?.live_state_summary || {};
  const currentBoard = matchFacts?.current_board_shop_bench || latest?.current_board_shop_bench || {};
  for (const source of [
    matchFacts?.own_board,
    matchFacts?.own_bench,
    matchFacts?.board_units,
    matchFacts?.bench_units,
    live?.own_board,
    live?.own_bench,
    currentBoard?.board_units,
    currentBoard?.bench_units,
  ]) visit(source);
  return new Set(uniqueStrings(ids));
}

function featureRowForChampion(index, championId) {
  return asArray(index?.entities).find((entry) => (
    entry?.entity_kind === "champion" && entry?.entity_id === String(championId || "")
  )) || null;
}

function roleCompatibleSubstitution(option, owned, coreSemanticFeatureIndex) {
  if (!coreSemanticFeatureIndex || !owned.size) return null;
  const lineupIds = orderedUniqueStrings(option?.lineup_ids);
  const roleTargets = [
    { role: "main_carry", champion_id: option?.main_carry?.champion_id, preferred_features: ["role.backline", "output.ap", "output.ad"] },
    { role: "primary_tank", champion_id: option?.primary_tank?.champion_id, preferred_features: ["role.frontline", "output.tank"] },
  ];
  for (const target of roleTargets) {
    const targetId = String(target.champion_id || "");
    if (!targetId || owned.has(targetId) || !lineupIds.includes(targetId)) continue;
    const targetFeatures = new Set(featureRowForChampion(coreSemanticFeatureIndex, targetId)?.features || []);
    const substituteId = [...owned].sort().find((ownedId) => {
      if (lineupIds.includes(ownedId)) return false;
      const ownedFeatures = new Set(featureRowForChampion(coreSemanticFeatureIndex, ownedId)?.features || []);
      return target.preferred_features.some((feature) => targetFeatures.has(feature) && ownedFeatures.has(feature));
    });
    if (!substituteId) continue;
    return {
      role: target.role,
      replaces_champion_id: targetId,
      substitute_champion_id: substituteId,
      source: "current_match_owned_role_compatible_single_substitution",
      ranking_authority: false,
    };
  }
  return null;
}

function selectTransitionParentVariant(candidate, preferredVariantId) {
  const variants = asArray(candidate?.variants);
  if (!variants.length) return null;
  const requestedId = String(
    preferredVariantId
    ?? candidate?.query_variant_id
    ?? candidate?.canonical_variant?.variant_id
    ?? "",
  ).trim();
  if (!requestedId) return null;
  return variants.find((variant) => String(variant?.variant_id || "") === requestedId) || null;
}

function requestLocalTransitionGapFill(variant, published, owned, level) {
  if (!Number.isInteger(level) || level < 4 || level > 7) return null;
  if (published.some((option) => finiteNumber(option?.population) === level)) return null;
  const finalLineupIds = orderedUniqueStrings(variant?.lineup_ids);
  if (finalLineupIds.length < level) return null;
  const anchor = [...published]
    .filter((option) => {
      const population = finiteNumber(option?.population);
      return Number.isInteger(population) && population < level;
    })
    .sort((left, right) => finiteNumber(right?.population) - finiteNumber(left?.population))[0];
  if (!anchor) return null;
  const anchorIds = orderedUniqueStrings(anchor?.lineup_ids);
  if (anchorIds.length !== finiteNumber(anchor?.population)) return null;
  const additions = [
    ...finalLineupIds.filter((id) => owned.has(id) && !anchorIds.includes(id)),
    ...finalLineupIds.filter((id) => !anchorIds.includes(id)),
  ];
  const lineupIds = orderedUniqueStrings([...anchorIds, ...additions]).slice(0, level);
  if (lineupIds.length !== level) return null;
  return {
    ...anchor,
    semantic_role: "generated_transition_gap_fill",
    semantic_role_source: "runtime_request_local_gap_fill",
    node_status: "request_local_ephemeral_node",
    effective_full_node: true,
    population: level,
    lineup_ids: lineupIds,
    lineup_names: [],
    main_carry: anchor?.main_carry?.champion_id ? anchor.main_carry : variant?.main_carry || null,
    primary_tank: anchor?.primary_tank?.champion_id ? anchor.primary_tank : variant?.primary_tank || null,
    provenance: {
      source_parent_variant_id: variant?.variant_id || null,
      source_anchor_population: finiteNumber(anchor?.population),
      ranking_authority: false,
      request_local_only: true,
    },
    evidence_boundary: "request_local_gap_fill_not_master_plus_recipe_or_strength",
  };
}

function transitionRuntimeFit(option, owned, level, coreSemanticFeatureIndex, { allowSubstitution = false } = {}) {
  const lineupIds = orderedUniqueStrings(option?.lineup_ids);
  const substitution = allowSubstitution
    ? roleCompatibleSubstitution(option, owned, coreSemanticFeatureIndex)
    : null;
  const adaptedLineupIds = substitution
    ? lineupIds.map((id) => id === substitution.replaces_champion_id ? substitution.substitute_champion_id : id)
    : lineupIds;
  const population = finiteNumber(option?.population);
  return {
    ...option,
    runtime_fit: {
      owned_unit_overlap: lineupIds.filter((id) => owned.has(id)).length,
      add_unit_ids: lineupIds.filter((id) => !owned.has(id)),
      remove_unit_ids: [...owned].filter((id) => !adaptedLineupIds.includes(id)),
      adapted_lineup_ids: adaptedLineupIds,
      substitution,
      target_population_distance: level === null || population === null ? null : Math.abs(level - population),
      strength_claim: false,
    },
  };
}

export function rankTransitionOptionsForMatch(
  candidate,
  matchFacts = {},
  coreSemanticFeatureIndex = null,
  { preferredVariantId = null } = {},
) {
  const parentVariant = selectTransitionParentVariant(candidate, preferredVariantId);
  if (!parentVariant) return null;
  const published = asArray(parentVariant?.transitions).filter((option) => option?.semantic_role === "published_transition");
  if (!published.length) return null;
  const owned = collectOwnedUnitIds(matchFacts);
  const level = finiteNumber(matchFacts?.level ?? matchFacts?.player_level ?? matchFacts?.game_state?.level);
  const exactPublished = Number.isInteger(level)
    ? published.find((option) => finiteNumber(option?.population) === level) || null
    : null;
  const ephemeral = exactPublished ? null : requestLocalTransitionGapFill(parentVariant, published, owned, level);
  const nearestPublished = exactPublished || ephemeral ? null : [...published].sort((left, right) => {
    const leftDistance = level === null ? 0 : Math.abs(level - finiteNumber(left?.population));
    const rightDistance = level === null ? 0 : Math.abs(level - finiteNumber(right?.population));
    return leftDistance - rightDistance;
  })[0];
  const selectedSource = exactPublished || ephemeral || nearestPublished;
  if (!selectedSource) return null;
  const selected = transitionRuntimeFit(selectedSource, owned, level, coreSemanticFeatureIndex, { allowSubstitution: true });
  const alternatives = published
    .filter((option) => option !== exactPublished && option !== nearestPublished)
    .slice(0, 2)
    .map((option) => transitionRuntimeFit(option, owned, level, coreSemanticFeatureIndex));
  return {
    source_parent_variant_id: parentVariant?.variant_id || null,
    selected,
    alternatives,
    policy: {
      current_match_only: true,
      selected_parent_variant_only: true,
      exact_population_published_node_first: true,
      request_local_gap_fill_maximum: ephemeral ? 1 : 0,
      request_local_role_substitution_maximum: selected.runtime_fit.substitution ? 1 : 0,
      persisted_generated_nodes: 0,
      no_strength_inference: true,
    },
  };
}

export { ROUTE_FEATURES, SEMANTIC_FEATURE_INDEX_SCHEMA, SEMANTIC_FEATURE_PACKET_SCHEMA };
