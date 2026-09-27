#!/usr/bin/env node

import assert from 'node:assert/strict';

import { parseTypedAugmentEffect } from './jcc_typed_effect_parser.mjs';

function termWithReward(effect, kind) {
  return effect.effect_terms.find((term) => term.rewards.some((reward) => reward.kind === kind));
}

function metric(effect, kind, value) {
  return effect.effect_terms
    .flatMap((term) => term.metrics)
    .find((entry) => entry.metric === kind && entry.value === value);
}

{
  const effect = parseTypedAugmentEffect('在你到达9级时，提供27金币。');
  const goldTerm = termWithReward(effect, 'gold');
  assert(goldTerm, 'level-gated gold reward must be typed');
  assert.deepEqual(goldTerm.conditions, [{
    kind: 'level_threshold',
    operator: 'gte',
    value: 9,
    unit: 'level',
    source_text: '到达9级',
  }]);
  assert.equal(goldTerm.trigger.kind, 'level_reached');
  assert.equal(goldTerm.activation, 'condition_required');
  assert.deepEqual(goldTerm.repeat_policy, { kind: 'once' });
  assert.deepEqual(goldTerm.rewards[0], {
    kind: 'gold',
    amount: 27,
    unit: 'count',
    delivery: 'condition_met',
    random: false,
    source_text: '提供27金币',
  });
  assert.equal(
    effect.effect_terms.some((term) => term.trigger.kind === 'passive'
      && term.rewards.some((reward) => reward.kind === 'gold' && reward.amount === 27)),
    false,
    'level-gated gold must never be emitted as an immediate passive reward',
  );
  assert.equal(effect.unmapped_audit.status, 'complete');
}

{
  const effect = parseTypedAugmentEffect(
    '己方获得25%暴击几率、10%暴击伤害和【技能暴击】。技能暴击：技能伤害可产生暴击。',
  );
  assert(metric(effect, 'critical_strike', 25));
  assert(metric(effect, 'critical_damage', 10));
  assert(metric(effect, 'skill_crit', true));
  assert(effect.targets.some((target) => target.kind === 'team'));
}

{
  const effect = parseTypedAugmentEffect(
    '获得3件随机基础装备、2金币和1个【装备重铸器】。',
  );
  assert.deepEqual(effect.rewards.map((reward) => [reward.kind, reward.amount, reward.random]), [
    ['component_item', 3, true],
    ['gold', 2, false],
    ['item_reforger', 1, false],
  ]);
  assert(effect.random_or_dynamic_terms.some((term) => term.kind === 'random_reward'));
}

{
  const effect = parseTypedAugmentEffect(
    '获得1个随机【纹章】。在5个玩家对战回合后获得1个【神器锻造器】。',
  );
  assert.equal(termWithReward(effect, 'emblem').rewards[0].random, true);
  const artifactTerm = termWithReward(effect, 'artifact_anvil');
  assert.equal(artifactTerm.trigger.kind, 'player_combat_rounds_elapsed');
  assert.equal(artifactTerm.trigger.rounds, 5);
  assert.deepEqual(artifactTerm.repeat_policy, { kind: 'once' });
}

{
  const effect = parseTypedAugmentEffect(
    '立刻获得1件随机成装，并在8个玩家对战回合之后提供1个基础装备。',
  );
  const completedItem = termWithReward(effect, 'completed_item');
  const componentItem = termWithReward(effect, 'component_item');
  assert.equal(completedItem.trigger.kind, 'immediate');
  assert.equal(completedItem.rewards[0].delivery, 'immediate');
  assert.equal(componentItem.trigger.kind, 'player_combat_rounds_elapsed');
  assert.equal(componentItem.trigger.rounds, 8);
  assert.equal(componentItem.rewards[0].delivery, 'condition_met');
}

{
  const effect = parseTypedAugmentEffect(
    '现在以及每个阶段开始时，获得8经验值和2次免费刷新。',
  );
  const experience = termWithReward(effect, 'experience');
  assert(experience);
  assert.equal(experience.trigger.kind, 'now_and_stage_start');
  assert.deepEqual(experience.repeat_policy, { kind: 'immediate_then_every_stage' });
  assert(effect.rewards.some((reward) => reward.kind === 'free_shop_refresh' && reward.amount === 2));
}

{
  const effect = parseTypedAugmentEffect(
    '你的弈子获得12%攻击速度，持续8秒，最多叠加3次。',
  );
  assert(metric(effect, 'attack_speed', 12));
  assert.deepEqual(effect.durations, [{ kind: 'duration', value: 8, unit: 'seconds', source_text: '持续8秒' }]);
  assert.deepEqual(effect.stacking_limits, [{
    kind: 'max_stacks',
    value: 3,
    unit: 'stacks',
    source_text: '最多叠加3次',
  }]);
}

{
  const effect = parseTypedAugmentEffect(
    '获得10次免费刷新、6经验值、1个3费弈子、1个随机纹章、1个神器和1个装备重铸器。',
  );
  const kinds = new Set(effect.rewards.map((reward) => reward.kind));
  for (const kind of ['free_shop_refresh', 'experience', 'unit', 'emblem', 'artifact', 'item_reforger']) {
    assert(kinds.has(kind), `expected typed reward ${kind}`);
  }
  assert.deepEqual(effect.repeat_policies, [{ kind: 'once' }]);
}

{
  const effect = parseTypedAugmentEffect('在你达到5级、6级、7级和8级时获得1个【基础装备锻造器】。');
  assert.deepEqual(effect.effect_terms.map((term) => term.trigger), [
    { kind: 'level_reached', level: 5 },
    { kind: 'level_reached', level: 6 },
    { kind: 'level_reached', level: 7 },
    { kind: 'level_reached', level: 8 },
  ]);
  assert.deepEqual(effect.effect_terms.map((term) => term.conditions[0]?.value), [5, 6, 7, 8]);
  assert(effect.effect_terms.every((term) => term.repeat_policy.kind === 'once'));
  assert(effect.effect_terms.every((term) => term.rewards[0]?.delivery === 'condition_met'));
  assert.equal(effect.unmapped_audit.status, 'complete');
}

{
  const effect = parseTypedAugmentEffect('获得1个【三相之力】和1件随机装备。');
  assert(effect.rewards.some((reward) => (
    reward.kind === 'named_item' && reward.item_name === '三相之力' && reward.amount === 1
  )));
  assert(effect.rewards.some((reward) => (
    reward.kind === 'item' && reward.random === true && reward.amount === 1
  )));
}

{
  const effect = parseTypedAugmentEffect('每当月相翻转时，使相邻弈子进入星辉共鸣。');
  assert.equal(effect.parse_status, 'partial');
  assert.equal(effect.unmapped_audit.status, 'partial');
  assert.equal(effect.effect_terms[0].trigger.kind, 'unmapped_condition');
  assert.equal(effect.effect_terms[0].activation, 'condition_required');
  assert.deepEqual(effect.unmapped_audit.fragments, [{
    source_text: '每当月相翻转时，使相邻弈子进入星辉共鸣',
    reason: 'unmapped_effect_semantics',
    numeric_tokens: [],
  }]);
}

{
  const effect = parseTypedAugmentEffect('在输掉你的战斗环节之后，获得2金币和一次免费的商店刷新。');
  assert.equal(effect.effect_terms[0].trigger.kind, 'post_loss');
  assert.deepEqual(effect.effect_terms[0].repeat_policy, { kind: 'recurring' });
  assert(effect.rewards.some((reward) => reward.kind === 'gold' && reward.amount === 2));
  assert(effect.rewards.some((reward) => reward.kind === 'free_shop_refresh' && reward.amount === 1));
}

{
  const effect = parseTypedAugmentEffect('前两排的敌方弈子们每2秒损失4护甲和魔抗。');
  assert(effect.targets.some((target) => target.kind === 'enemy_team'));
  assert(effect.targets.some((target) => target.kind === 'front_rows' && target.count === 2));
  assert(effect.metrics.some((entry) => entry.metric === 'armor' && entry.delta === -4));
  assert(effect.metrics.some((entry) => entry.metric === 'magic_resist' && entry.delta === -4));
  assert.equal(effect.effect_terms[0].trigger.kind, 'interval');
}

{
  const effect = parseTypedAugmentEffect('未知机制会提升17层。');
  assert.equal(effect.parse_status, 'partial');
  assert.equal(effect.unmapped_audit.fragments[0].reason, 'unmapped_numeric_semantics');
}

{
  const effect = parseTypedAugmentEffect('每回合开始时，使相邻弈子进入星辉共鸣。');
  assert.equal(effect.parse_status, 'partial');
  assert.deepEqual(effect.unmapped_audit.fragments, [{
    source_text: '每回合开始时，使相邻弈子进入星辉共鸣',
    reason: 'unmapped_effect_semantics',
    numeric_tokens: [],
  }]);
}

{
  const effect = parseTypedAugmentEffect('获得2金币，并使星辉共鸣提升17层。');
  assert.equal(effect.parse_status, 'partial');
  assert.deepEqual(effect.unmapped_audit.fragments, [{
    source_text: '获得2金币，并使星辉共鸣提升17层',
    reason: 'unmapped_numeric_semantics',
    numeric_tokens: ['17'],
  }]);
}

{
  const effect = parseTypedAugmentEffect(
    '获得45金币。在每个回合开始时，在50金币之上，每拥有10金币就会获得1次永久的刷新(最多80金币)。',
  );
  assert.deepEqual(
    effect.rewards.filter((reward) => reward.kind === 'gold').map((reward) => reward.amount),
    [45],
    'gold thresholds and holdings must not be reclassified as rewards',
  );
}

console.log(JSON.stringify({
  ok: true,
  schema: 'jcc-common-typed-effect-parser-verification-v1',
}, null, 2));
