const NUMBER = String.raw`(-?\d+(?:\.\d+)?)`;

const METRIC_PATTERNS = Object.freeze([
  ['damage_amp', new RegExp(`${NUMBER}%的?伤害增幅`, 'g'), 'percent'],
  ['damage_reduction', new RegExp(`${NUMBER}%的?伤害减免`, 'g'), 'percent'],
  ['attack_damage', new RegExp(`${NUMBER}%?(?:物理加成|攻击力)`, 'g'), 'percent'],
  ['ability_power', new RegExp(`${NUMBER}%?(?:法术加成|法术强度|法强)`, 'g'), 'points'],
  ['attack_speed', new RegExp(`${NUMBER}%的?攻击速度`, 'g'), 'percent'],
  ['critical_strike', new RegExp(`${NUMBER}%的?暴击(?:率|几率)`, 'g'), 'percent'],
  ['critical_damage', new RegExp(`${NUMBER}%的?暴击伤害`, 'g'), 'percent'],
  ['omnivamp', new RegExp(`${NUMBER}%的?全能(?:吸血|汲取)`, 'g'), 'percent'],
  ['armor', new RegExp(`${NUMBER}(?:点)?护甲`, 'g'), 'points'],
  ['magic_resist', new RegExp(`${NUMBER}(?:点)?(?:魔法抗性|魔抗)`, 'g'), 'points'],
  ['health', new RegExp(`${NUMBER}(?:点)?(?:生命上限|最大生命值|生命值)`, 'g'), 'points'],
  ['healing', new RegExp(`${NUMBER}(?:点)?治疗(?:效果|量)?`, 'g'), 'points'],
  ['healing', new RegExp(`${NUMBER}%的?(?:最大生命值|生命上限)(?:的)?治疗`, 'g'), 'percent_max_health'],
  ['shield', new RegExp(`${NUMBER}(?:点)?护盾`, 'g'), 'points'],
  ['shield', new RegExp(`${NUMBER}%的?(?:最大生命值|生命上限)(?:的)?护盾`, 'g'), 'percent_max_health'],
  ['mana_regen', new RegExp(`${NUMBER}(?:点)?法力回复`, 'g'), 'points'],
  ['mana', new RegExp(`${NUMBER}(?:点)?额外法力值`, 'g'), 'points'],
  ['mana', new RegExp(`获得${NUMBER}(?:点)?法力值`, 'g'), 'points'],
  ['team_size', new RegExp(`\\+${NUMBER}最大队伍规模`, 'g'), 'count'],
]);

const REWARD_PATTERNS = Object.freeze([
  { kind: 'artifact_anvil', pattern: /(\d+)个【?神器锻造器】?/g, unit: 'count' },
  { kind: 'completed_item_anvil', pattern: /(\d+)个【?成装锻造器】?/g, unit: 'count' },
  { kind: 'component_item_anvil', pattern: /(\d+)个【?基础装备锻造器】?/g, unit: 'count' },
  { kind: 'item_reforger', pattern: /(\d+)个?【?装备重铸器】?/g, unit: 'count' },
  { kind: 'item_remover', pattern: /(\d+)个?【?装备拆卸器】?/g, unit: 'count' },
  { kind: 'lesser_hero_duplicator', pattern: /(\d+)个?【?次级英雄复制器】?/g, unit: 'count' },
  { kind: 'mini_hero_duplicator', pattern: /(\d+)个?【?微型英雄复制器】?/g, unit: 'count' },
  { kind: 'hero_duplicator', pattern: /(\d+)个?【?英雄复制器】?/g, unit: 'count' },
  { kind: 'free_shop_refresh', pattern: /(?:获得|提供)?(\d+|一|两)次免费(?:的)?(?:商店)?刷新/g, unit: 'count' },
  { kind: 'shop_refresh', pattern: /(?:立刻|即刻|获得|提供)(\d+|一|两)次(?:商店)?刷新/g, unit: 'count' },
  { kind: 'experience', pattern: /(?:额外的?)?(\d+)经验(?:值)?/g, unit: 'points' },
  { kind: 'gold', pattern: /(?:获得|提供|掉落)?(\d+)金币/g, unit: 'count' },
  { kind: 'component_item', pattern: /(\d+)(?:件|个)?(随机)?基础装备(?!锻造器)/g, unit: 'count', randomGroup: 2 },
  { kind: 'completed_item', pattern: /(\d+)(?:件|个)?(随机)?成装(?!锻造器)/g, unit: 'count', randomGroup: 2 },
  { kind: 'emblem', pattern: /(\d+|一)个?(随机)?【?[^，。；、和]*?纹章】?/g, unit: 'count', randomGroup: 2 },
  { kind: 'artifact', pattern: /(\d+)(?:件|个)?(随机)?【?神器】?(?!锻造器)/g, unit: 'count', randomGroup: 2 },
  { kind: 'item', pattern: /(\d+)(?:件|个)?(随机)装备/g, unit: 'count', randomGroup: 2 },
  { kind: 'named_item', pattern: /(\d+)(?:件|个)?【([^】]+)】/g, unit: 'count', nameGroup: 2 },
  { kind: 'unit', pattern: /(\d+)个?(?:(\d+)星)?(?:(\d+)费)?[^，。；、和]*?弈子/g, unit: 'count', starGroup: 2, costGroup: 3 },
]);

function uniqueBy(items, keyFor) {
  return [...new Map(items.map((item) => [keyFor(item), item])).values()];
}

function normalizedText(sourceText) {
  return String(sourceText ?? '')
    .replace(/([一两二])(?=(?:个|件|把|张|次)(?:【|随机|基础|成装|神器|装备|纹章|弈子|刷新|奖励))/g, (value) => String(numericAmount(value)))
    .replace(/\s+/g, ' ')
    .trim();
}

function fragmentsOf(sourceText) {
  return normalizedText(sourceText)
    .replace(/(?:，|,)?并(?=在\d+个(?:玩家对战)?回合(?:之后|后))/g, '。')
    .split(/[。；;]/)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
}

export function dynamicPlaceholders(sourceText) {
  const patterns = [
    /当前(?:加成)?\s*[：:]\s*0%?(?:【[^】]+】0%?)*/g,
    /金币掉落数量\s*[：:]\s*0/g,
    /弈子\s*[：:]\s*\[\s*\]/g,
    /(?:【[^】]+】)?[\u4e00-\u9fffA-Za-z]+(?:[\u4e00-\u9fffA-Za-z【】]*)\s*[：:]\s*0(?:\.0+)?%?(?:\/(?:0|\d+(?:\.\d+)?)(?:金币)?)?/g,
    /[？?]{3,}/g,
  ];
  const results = [];
  for (const pattern of patterns) {
    for (const match of normalizedText(sourceText).matchAll(pattern)) {
      results.push({
        kind: 'upstream_dynamic_placeholder',
        source_text: match[0],
        authoritative_value: null,
      });
    }
  }
  return uniqueBy(results, (item) => item.source_text);
}

function stripPlaceholders(sourceText, placeholders) {
  return placeholders.reduce((text, placeholder) => text.replaceAll(placeholder.source_text, ' '), sourceText);
}

export function parseTypedMetrics(sourceText) {
  const metrics = [];
  const source = normalizedText(sourceText);
  for (const [metric, pattern, fixedUnit] of METRIC_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      const nearby = source.slice(Math.max(0, start - 12), start + match[0].length + 4);
      const decreases = /(?:损失|降低|减少|削减|失去)/u.test(nearby);
      metrics.push({
        metric,
        value: Number(match[1]),
        unit: fixedUnit,
        operation: decreases ? 'decrease' : 'increase',
        delta: decreases ? -Number(match[1]) : Number(match[1]),
        source_text: match[0],
      });
    }
  }
  for (const match of source.matchAll(new RegExp(`${NUMBER}(?:点)?护甲和(?:魔法抗性|魔抗)`, 'g'))) {
    const value = Number(match[1]);
    const start = match.index ?? 0;
    const nearby = source.slice(Math.max(0, start - 12), start + match[0].length + 4);
    const decreases = /(?:损失|降低|减少|削减|失去)/u.test(nearby);
    for (const metric of ['armor', 'magic_resist']) {
      metrics.push({
        metric,
        value,
        unit: 'points',
        operation: decreases ? 'decrease' : 'increase',
        delta: decreases ? -value : value,
        source_text: match[0],
      });
    }
  }
  if (/技能暴击/.test(sourceText)) {
    metrics.push({ metric: 'skill_crit', value: true, unit: 'boolean', source_text: '技能暴击' });
  }
  return uniqueBy(metrics, (item) => `${item.metric}:${item.value}:${item.unit}:${item.operation || 'set'}`);
}

function parseConditions(fragment) {
  const conditions = [];
  const level = fragment.match(/(?:到达|达到|升到|升至)(\d+)级/);
  if (level) {
    conditions.push({
      kind: 'level_threshold', operator: 'gte', value: Number(level[1]), unit: 'level', source_text: level[0],
    });
  }
  const health = fragment.match(/生命值(?:高于|低于|达到|在)\s*(\d+(?:\.\d+)?)%/);
  if (health) {
    const operator = /低于/.test(health[0]) ? 'lt' : (/高于/.test(health[0]) ? 'gt' : 'threshold');
    conditions.push({
      kind: 'health_threshold', operator, value: Number(health[1]), unit: 'percent', source_text: health[0],
    });
  }
  return conditions;
}

function expandLevelSchedule(fragment) {
  const match = fragment.match(/(?:在你)?(?:到达|达到|升到|升至)((?:\d+级(?:[、,，和及]\s*)?){2,})时/);
  if (!match) return [{ fragment, scheduled_level: null, schedule_source_text: null }];
  const levels = [...match[1].matchAll(/\d+/g)].map((entry) => Number(entry[0]));
  if (levels.length < 2) return [{ fragment, scheduled_level: null, schedule_source_text: null }];
  return levels.map((level) => ({
    fragment: fragment.replace(match[0], `达到${level}级时`),
    scheduled_level: level,
    schedule_source_text: match[0],
  }));
}

function parseTargets(fragment) {
  const targets = [];
  if (/己方|你的队伍|你的弈子|友方|全队/.test(fragment)) targets.push({ kind: 'team' });
  if (/敌方|敌人/.test(fragment)) targets.push({ kind: 'enemy_team' });
  if (/后排/.test(fragment)) targets.push({ kind: 'backline' });
  if (/前排/.test(fragment)) targets.push({ kind: 'frontline' });
  const frontRows = fragment.match(/前([一二两三四五六七八九十\d]+)排/);
  if (frontRows) targets.push({ kind: 'front_rows', count: numericAmount(frontRows[1]) });
  if (/相邻/.test(fragment)) targets.push({ kind: 'adjacent_units' });
  if (/其他邻格弈子/.test(fragment)) targets.push({ kind: 'other_adjacent_units' });
  if (/相距最近的那个己方弈子/.test(fragment)) targets.push({ kind: 'nearest_ally' });
  if (/生命值最低/.test(fragment)) targets.push({ kind: 'lowest_health_unit' });
  if (/最强/.test(fragment)) targets.push({ kind: 'strongest_unit' });
  if (/最前排中心/.test(fragment)) targets.push({ kind: 'front_center' });
  if (/携带(?:着)?(?:装备|【[^】]+】)的(?:己方|友方)?弈子/.test(fragment)) targets.push({ kind: 'equipped_unit' });
  const cost = fragment.match(/(\d+)费弈子/);
  if (cost) targets.push({ kind: 'unit_cost', cost: Number(cost[1]) });
  return uniqueBy(targets, (item) => JSON.stringify(item));
}

function parseTrigger(fragment) {
  if (/现在以及每个阶段开始时/.test(fragment)) return { kind: 'now_and_stage_start' };
  const recurringRounds = fragment.match(/(?:立刻|现在)以及之后的每(\d+)个玩家对战回合后/);
  if (recurringRounds) return { kind: 'now_and_player_combat_interval', rounds: Number(recurringRounds[1]) };
  const level = fragment.match(/(?:到达|达到|升到|升至)(\d+)级时/);
  if (level) return { kind: 'level_reached', level: Number(level[1]) };
  const playerRounds = fragment.match(/(?:在)?(\d+)个玩家对战(?:回合)?(?:之后|后)/);
  if (playerRounds) return { kind: 'player_combat_rounds_elapsed', rounds: Number(playerRounds[1]) };
  const genericRounds = fragment.match(/(?:在)?(\d+)个回合后/);
  if (genericRounds) return { kind: 'rounds_elapsed', rounds: Number(genericRounds[1]) };
  const elapsed = fragment.match(/战斗开始\s*(\d+(?:\.\d+)?)\s*秒后/);
  if (elapsed) return { kind: 'combat_elapsed', seconds: Number(elapsed[1]) };
  const interval = fragment.match(/每\s*(\d+(?:\.\d+)?)\s*秒/);
  if (interval) return { kind: 'interval', seconds: Number(interval[1]) };
  if (/每个阶段开始时/.test(fragment)) return { kind: 'stage_start' };
  if (/每(?:个)?回合开始时|每回合/.test(fragment)) return { kind: 'round_start' };
  if (/战斗开始时/.test(fragment)) return { kind: 'combat_start' };
  if (/回合开始时/.test(fragment)) return { kind: 'round_start' };
  if (/每当你的商店刷新时|商店刷新时/.test(fragment)) return { kind: 'shop_refresh' };
  const purchase = fragment.match(/每(?:次|当).*?购买.+?(?:时|，|,|都会)/);
  if (purchase) return { kind: 'purchase', source_text: purchase[0] };
  const levelUp = fragment.match(/每(?:次|当)你升级时|每当你升级时/);
  if (levelUp) return { kind: 'level_up', source_text: levelUp[0] };
  const enemyDeath = fragment.match(/在一名敌人倒下时|敌人倒下时/);
  if (enemyDeath) return { kind: 'enemy_death', source_text: enemyDeath[0] };
  const postKill = fragment.match(/参与击杀后|击杀后/);
  if (postKill) return { kind: 'post_kill', source_text: postKill[0] };
  const postAttacked = fragment.match(/受到攻击后/);
  if (postAttacked) return { kind: 'post_attacked', source_text: postAttacked[0] };
  const itemCrafted = fragment.match(/合成装备时/);
  if (itemCrafted) return { kind: 'item_crafted', source_text: itemCrafted[0] };
  if (/(?:输掉|失败)(?:你的)?(?:战斗环节|玩家战斗|战斗)?(?:之后|后)/.test(fragment)) return { kind: 'post_loss' };
  if (/(?:赢得|获胜)(?:你的)?(?:战斗环节|玩家战斗|战斗)?(?:之后|后)/.test(fragment)) return { kind: 'post_win' };
  if (/每次普攻/.test(fragment)) return { kind: 'basic_attack' };
  if (/施放(?:一次)?技能时|每次施放/.test(fragment)) return { kind: 'cast' };
  if (/立刻|即刻|现在/.test(fragment)) return { kind: 'immediate' };
  if (/(?:在|每次|每当|当|若|如果).+?(?:时|后|之后|都会)/u.test(fragment)) {
    return { kind: 'unmapped_condition', source_text: fragment.match(/(?:在|每次|每当|当|若|如果).+?(?:时|后|之后|都会)/u)?.[0] || fragment };
  }
  return { kind: 'passive' };
}

function repeatPolicyFor(fragment, trigger, rewards = []) {
  if (trigger.kind === 'now_and_stage_start') return { kind: 'immediate_then_every_stage' };
  if (trigger.kind === 'now_and_player_combat_interval') {
    return { kind: 'immediate_then_interval', interval_rounds: trigger.rounds };
  }
  if (['stage_start', 'round_start', 'shop_refresh', 'purchase', 'level_up', 'enemy_death', 'post_kill', 'post_attacked', 'item_crafted', 'basic_attack', 'cast', 'interval', 'post_loss', 'post_win'].includes(trigger.kind)) {
    return { kind: 'recurring' };
  }
  if (['level_reached', 'player_combat_rounds_elapsed', 'rounds_elapsed', 'combat_elapsed'].includes(trigger.kind)) {
    return { kind: 'once' };
  }
  if (/首次|只触发一次/.test(fragment) || (trigger.kind === 'passive' && rewards.length > 0)) {
    return { kind: 'once' };
  }
  return { kind: 'continuous' };
}

function parseDurations(fragment) {
  const results = [];
  for (const match of fragment.matchAll(/持续\s*(\d+(?:\.\d+)?)\s*秒/g)) {
    results.push({ kind: 'duration', value: Number(match[1]), unit: 'seconds', source_text: match[0] });
  }
  for (const match of fragment.matchAll(/持续\s*(\d+)\s*个?(?:回合|玩家对战回合)/g)) {
    results.push({ kind: 'duration', value: Number(match[1]), unit: 'rounds', source_text: match[0] });
  }
  const scopedDurations = [
    [/持续至本局游戏结束|在剩余游戏时间内|永久/g, 'game'],
    [/持续到战斗结束|持续至战斗结束/g, 'combat'],
  ];
  for (const [pattern, scope] of scopedDurations) {
    for (const match of fragment.matchAll(pattern)) {
      results.push({ kind: 'duration_scope', scope, source_text: match[0] });
    }
  }
  for (const match of fragment.matchAll(/接下来的?\s*(\d+)\s*个?阶段/g)) {
    results.push({ kind: 'duration', value: Number(match[1]), unit: 'stages', source_text: match[0] });
  }
  return results;
}

function parseStackingLimits(fragment) {
  const results = [];
  for (const match of fragment.matchAll(/(?:最多|至多)叠加\s*(\d+)\s*次/g)) {
    results.push({ kind: 'max_stacks', value: Number(match[1]), unit: 'stacks', source_text: match[0] });
  }
  for (const match of fragment.matchAll(/(?:最多|至多)\s*(\d+)\s*次/g)) {
    if (/叠加/.test(match[0])) continue;
    results.push({ kind: 'max_triggers', value: Number(match[1]), unit: 'count', source_text: match[0] });
  }
  if (/此效果可叠加/.test(fragment)) {
    results.push({ kind: 'stacking_policy', stackable: true, source_text: '此效果可叠加' });
  }
  return results;
}

function parseRelations(fragment, targets) {
  const relations = [];
  if (/弈子为其他邻格弈子提供/.test(fragment)) {
    relations.push({ source: { kind: 'unit' }, recipient: { kind: 'other_adjacent_units' }, verb: 'provide' });
  } else if (/为.+提供/.test(fragment)) {
    relations.push({ source: { kind: 'effect_owner' }, recipient: targets[0] || { kind: 'unspecified' }, verb: 'provide' });
  }
  if (/(?:己方弈子|你的队伍|你的弈子|相距最近的那个己方弈子).+获得/.test(fragment)) {
    relations.push({ source: { kind: 'augment_effect' }, recipient: targets[0] || { kind: 'ally' }, verb: 'grant' });
  }
  return uniqueBy(relations, (item) => JSON.stringify(item));
}

function clauseRole(fragment) {
  if (/^技能暴击\s*[：:]/.test(fragment)) return 'definition';
  if (/额外的?【?技能暴击】?提供/.test(fragment)) return 'conditional_interaction';
  return 'effect';
}

function overlaps(existingRanges, start, end) {
  return existingRanges.some(([left, right]) => start < right && end > left);
}

function numericAmount(value) {
  if (value === '一') return 1;
  if (value === '两' || value === '二') return 2;
  const chineseDigits = { 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (Object.hasOwn(chineseDigits, value)) return chineseDigits[value];
  return Number(value);
}

function hasRewardContext(fragment, start, matchedText) {
  if (/^(?:获得|提供|掉落|得到|选出)/.test(matchedText)) return true;
  const prefix = fragment.slice(0, start);
  const nearby = prefix.slice(-10);
  if (/(?:获得|提供|掉落|得到|选出)[^，、和及]{0,6}$/.test(nearby)) return true;
  const previous = prefix.slice(-1);
  return /[，,、和及]/.test(previous) && /(?:获得|提供|掉落|得到|选出)/.test(prefix);
}

function parseRewards(fragment, trigger) {
  const rewards = [];
  const claimedRanges = [];
  for (const spec of REWARD_PATTERNS) {
    spec.pattern.lastIndex = 0;
    for (const match of fragment.matchAll(spec.pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (!hasRewardContext(fragment, start, match[0])) continue;
      if (overlaps(claimedRanges, start, end)) continue;
      claimedRanges.push([start, end]);
      const reward = {
        kind: spec.kind,
        amount: numericAmount(match[1]),
        unit: spec.unit,
        delivery: trigger.kind === 'passive' || trigger.kind === 'immediate' ? 'immediate' : 'condition_met',
        random: spec.randomGroup ? Boolean(match[spec.randomGroup]) : false,
        source_text: match[0],
      };
      if (spec.starGroup && match[spec.starGroup]) reward.star = Number(match[spec.starGroup]);
      if (spec.costGroup && match[spec.costGroup]) reward.cost = Number(match[spec.costGroup]);
      if (spec.nameGroup && match[spec.nameGroup]) reward.item_name = match[spec.nameGroup];
      rewards.push(reward);
    }
  }
  return rewards.sort((left, right) => fragment.indexOf(left.source_text) - fragment.indexOf(right.source_text));
}

function randomOrDynamicTerms(fragment, rewards, placeholders) {
  const terms = [];
  if (rewards.some((reward) => reward.random)) {
    terms.push({
      kind: 'random_reward',
      reward_kinds: rewards.filter((reward) => reward.random).map((reward) => reward.kind),
      resolution: 'runtime_resolved',
    });
  }
  const probability = fragment.match(/(\d+(?:\.\d+)?)%几率/);
  if (probability) {
    terms.push({
      kind: 'probability', value: Number(probability[1]), unit: 'percent', source_text: probability[0],
    });
  }
  terms.push(...placeholders);
  return terms;
}

function activationFor(trigger, conditions) {
  return trigger.kind === 'passive' && conditions.length === 0
    ? 'unconditional_static'
    : 'condition_required';
}

function conditionalTagsFromTerms(terms) {
  return terms
    .filter((term) => term.conditions.length > 0
      || term.durations.length > 0
      || term.stacking_limits.length > 0
      || !['passive', 'immediate'].includes(term.trigger.kind))
    .map((term) => ({
      kind: term.durations.length > 0 || ['combat_elapsed', 'interval'].includes(term.trigger.kind)
        ? 'timing'
        : 'condition',
      source_text: term.source_text,
    }));
}

function unmappedAudit(terms) {
  const fragments = [];
  for (const term of terms) {
    const hasEffectPayload = term.metrics.length > 0
      || term.rewards.length > 0
      || term.durations.length > 0
      || term.stacking_limits.length > 0
      || term.random_or_dynamic_terms.length > 0;
    const numericTokens = term.source_text.match(/-?\d+(?:\.\d+)?%?/g) ?? [];
    const entirelyUnmapped = !hasEffectPayload
      && term.rewards.length === 0
      && term.conditions.length === 0
      && term.trigger.kind === 'passive';
    if (entirelyUnmapped) {
      fragments.push({
        source_text: term.source_text,
        reason: numericTokens.length ? 'unmapped_numeric_semantics' : 'unmapped_semantics',
        numeric_tokens: numericTokens,
      });
      continue;
    }

    if (!hasEffectPayload && (term.conditions.length > 0 || term.trigger.kind !== 'passive')) {
      fragments.push({
        source_text: term.source_text,
        reason: 'unmapped_effect_semantics',
        numeric_tokens: numericTokens,
      });
      continue;
    }

    let residual = term.source_text;
    const recognizedTexts = [
      ...term.conditions,
      ...term.metrics,
      ...term.rewards,
      ...term.durations,
      ...term.stacking_limits,
      ...term.random_or_dynamic_terms,
    ].map((entry) => entry.source_text).filter(Boolean);
    if (term.trigger?.source_text) recognizedTexts.push(term.trigger.source_text);
    for (const recognizedText of recognizedTexts) residual = residual.replace(recognizedText, ' ');
    residual = residual
      .replace(/(?:立刻|现在)以及之后的每\d+个玩家对战回合后/g, ' ')
      .replace(/\d+个玩家对战(?:回合)?后/g, ' ')
      .replace(/\d+个回合后/g, ' ')
      .replace(/战斗开始\s*\d+(?:\.\d+)?\s*秒后/g, ' ')
      .replace(/每\s*\d+(?:\.\d+)?\s*秒/g, ' ')
      .replace(/(?:输掉|失败)(?:你的)?(?:战斗环节|玩家战斗|战斗)?(?:之后|后)/g, ' ')
      .replace(/(?:赢得|获胜)(?:你的)?(?:战斗环节|玩家战斗|战斗)?(?:之后|后)/g, ' ');
    const semanticRemainder = residual
      .replace(/[，,、和及：:【】]/g, ' ')
      .replace(/(?:每当你的商店刷新时|商店刷新时|你都有|你的队伍|己方|友方|敌方|敌人|弈子|获得|提供|使|都会|这个|效果|为|其他|邻格|相距最近的那个)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const unconsumedNumbers = residual.match(/-?\d+(?:\.\d+)?%?/g) ?? [];
    if (unconsumedNumbers.length > 0 || /(?:持续|叠加|治疗|护盾|每次|每当|倒下|升级|购买|击杀|受到攻击|合成装备)/.test(semanticRemainder)) {
      fragments.push({
        source_text: term.source_text,
        reason: unconsumedNumbers.length > 0 ? 'unmapped_numeric_semantics' : 'unmapped_semantics',
        numeric_tokens: unconsumedNumbers,
      });
    }
  }
  return {
    status: fragments.length === 0
      ? 'complete'
      : (fragments.length === terms.length && fragments.every((entry) => entry.reason === 'unmapped_semantics')
        ? 'semantic_only'
        : 'partial'),
    fragments,
  };
}

export function parseTypedAugmentEffect(sourceText, { exactEffectBlocks = [] } = {}) {
  const source = normalizedText(sourceText);
  const placeholders = dynamicPlaceholders(source);
  const cleanSource = stripPlaceholders(source, placeholders);
  const terms = fragmentsOf(cleanSource).flatMap((sourceFragment) => expandLevelSchedule(sourceFragment)).map((scheduled) => {
    const fragment = scheduled.fragment;
    const role = clauseRole(fragment);
    const trigger = role === 'conditional_interaction'
      ? { kind: 'conditional_interaction', source_text: fragment }
      : parseTrigger(fragment);
    const conditions = scheduled.scheduled_level === null
      ? parseConditions(fragment)
      : [{
          kind: 'level_threshold',
          operator: 'eq',
          value: scheduled.scheduled_level,
          unit: 'level',
          source_text: `达到${scheduled.scheduled_level}级`,
        }];
    const metrics = role === 'definition' ? [] : parseTypedMetrics(fragment);
    const rewards = parseRewards(fragment, trigger);
    const durations = parseDurations(fragment);
    const stackingLimits = parseStackingLimits(fragment);
    const targets = parseTargets(fragment);
    const relations = parseRelations(fragment, targets);
    const dynamicTerms = randomOrDynamicTerms(fragment, rewards, []);
    return {
      trigger,
      activation: activationFor(trigger, conditions),
      conditions,
      targets,
      relations,
      metrics,
      rewards,
      durations,
      stacking_limits: stackingLimits,
      repeat_policy: repeatPolicyFor(fragment, trigger, rewards),
      random_or_dynamic_terms: dynamicTerms,
      source_text: fragment,
      clause_role: role,
      ...(scheduled.schedule_source_text ? { schedule_source_text: scheduled.schedule_source_text } : {}),
    };
  });
  const audit = unmappedAudit(terms);
  const mappedTerms = terms.filter((term) => {
    const hasStructuredEvidence = term.metrics.length > 0
      || term.rewards.length > 0
      || term.conditions.length > 0
      || term.durations.length > 0
      || term.stacking_limits.length > 0
      || term.random_or_dynamic_terms.length > 0
      || term.trigger.kind !== 'passive';
    return hasStructuredEvidence || !audit.fragments.some((item) => (
      item.source_text === term.source_text && item.reason === 'unmapped_semantics'
    ));
  });
  const conditionalTags = conditionalTagsFromTerms(mappedTerms);
  const parseStatus = exactEffectBlocks.length > 0
    ? (conditionalTags.length > 0 ? 'conditional' : 'exact')
    : (audit.status === 'semantic_only'
      ? 'semantic_only'
      : (audit.status === 'partial'
        ? 'partial'
        : (conditionalTags.length > 0 ? 'conditional' : 'structured')));
  return {
    schema: 'jcc-common-typed-effect-v1',
    parse_status: parseStatus,
    exact_effect_blocks: exactEffectBlocks,
    effect_terms: mappedTerms,
    structured_terms: mappedTerms,
    conditions: mappedTerms.flatMap((term) => term.conditions),
    targets: uniqueBy(mappedTerms.flatMap((term) => term.targets), (item) => JSON.stringify(item)),
    relations: uniqueBy(mappedTerms.flatMap((term) => term.relations || []), (item) => JSON.stringify(item)),
    metrics: uniqueBy(
      mappedTerms.flatMap((term) => term.metrics),
      (item) => `${item.metric}:${item.value}:${item.unit}:${item.operation || 'set'}`,
    ),
    rewards: mappedTerms.flatMap((term) => term.rewards),
    durations: mappedTerms.flatMap((term) => term.durations),
    stacking_limits: mappedTerms.flatMap((term) => term.stacking_limits),
    repeat_policies: uniqueBy(mappedTerms.map((term) => term.repeat_policy), (item) => JSON.stringify(item)),
    random_or_dynamic_terms: [
      ...mappedTerms.flatMap((term) => term.random_or_dynamic_terms),
      ...placeholders,
    ],
    conditional_tags: conditionalTags,
    dynamic_placeholders: placeholders,
    unmapped_audit: audit,
    source_text: sourceText,
  };
}

export const parseTypedEffectEnvelope = parseTypedAugmentEffect;
