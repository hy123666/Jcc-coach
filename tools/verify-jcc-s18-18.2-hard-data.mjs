#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
function one(rows, name) {
  const matches = rows.filter((row) => row.name === name);
  assert.equal(matches.length, 1, `${name} must resolve exactly once`);
  return matches[0];
}
function includesAll(value, expected, label) {
  for (const part of expected) assert.ok(String(value).includes(String(part)), `${label} is missing ${part}`);
}

export async function verifyS18Patch182(manifestFile) {
  const manifest = await json(path.resolve(manifestFile));
  const root = path.dirname(path.resolve(manifestFile));
  assert.equal(manifest.identity?.season_id, 's18');
  assert.equal(manifest.identity?.patch_id, 's18_2');
  assert.equal(manifest.version, '18.18.2');
  assert.equal(manifest.release_version, '18.2');
  assert.equal(manifest.upstream_provenance?.version, '18.18.2');

  const [mechanics, champions, traits, items, augments, seasonMechanics, rewardTables] = await Promise.all([
    json(path.join(root, 'normalized/mechanics_parameters.json')),
    json(path.join(root, 'normalized/champions.json')),
    json(path.join(root, 'normalized/traits.json')),
    json(path.join(root, 'normalized/items.json')),
    json(path.join(root, 'normalized/augments.json')),
    json(path.join(root, 'normalized/season_mechanics.json')),
    json(path.join(root, 'normalized/reward_tables.json')),
  ]);

  assert.deepEqual(mechanics.progression.xp_to_next_level, {
    '2': 2, '3': 6, '4': 10, '5': 20, '6': 36, '7': 56, '8': 64, '9': 64,
  });
  assert.deepEqual(mechanics.progression.cumulative_xp_to_level, {
    '2': 0, '3': 2, '4': 8, '5': 18, '6': 38, '7': 74, '8': 130, '9': 194, '10': 258,
  });
  assert.deepEqual(
    Object.fromEntries(['8', '9', '10'].map((level) => [level, mechanics.progression.reference_purchase_gold_at_standard_natural_timing[level]])),
    { '8': 56, '9': 64, '10': 64 },
  );
  assert.equal(mechanics.provenance.inherited_from.generation_id, manifest.parent_core_generation_id);
  assert.equal(mechanics.provenance.authority, 'common_user_confirmed_standard');
  assert.equal(mechanics.provenance.patch_overrides.progression.balance_release, '18.2');

  const expectations = [
    ['阿卡丽', ['25'], (row) => row.attributes_by_star['法力值'][0]],
    ['卡蜜尔', ['60/100/250'], (row) => row.skill.raw_values],
    ['蕾欧娜', ['30', '90', '60/80/100/130'], (row) => `${row.attributes_by_star['初始法力值'][0]}|${row.attributes_by_star['法力值'][0]}|${row.skill.raw_values}`],
    ['韦鲁斯', ['415/625/1000/1700'], (row) => `${row.skill.raw_values}|${row.skill.effects.source_text}`],
    ['维迦', ['永久获得3%'], (row) => row.skill.effects.source_text],
    ['凯尔', ['62/92/96'], (row) => row.skill.raw_values],
    ['乐芙兰', ['260/390/615/1045', '100/150/230/390'], (row) => row.skill.raw_values],
    ['沃里克', ['45'], (row) => row.attributes_by_star['物攻'][0]],
    ['芸阿娜', ['160/240/370/630'], (row) => row.skill.raw_values],
    ['阿兹尔', ['43/65/103/175'], (row) => row.skill.raw_values],
    ['黛安娜', ['30', '55/85/135/230', '100/225/375'], (row) => `${row.attributes_by_star['法力值'][0]}|${row.skill.raw_values}`],
    ['卡兹克', ['40'], (row) => row.attributes_by_star['物攻'][0]],
    ['深红锋喙鸟', ['55', '22/33/48'], (row) => `${row.attributes_by_star['物攻'][0]}|${row.skill.raw_values}`],
    ['易', ['62', '130,195,315'], (row) => `${row.attributes_by_star['物攻'][0]}|${row.balance_overrides.spell_form_magic_damage_by_star}`],
    ['雷恩加尔', ['0.75'], (row) => row.attributes_by_star['攻速'][0]],
    ['伊泽瑞尔', ['250/375'], (row) => row.skill.raw_values],
    ['奈德丽', ['300/450'], (row) => row.skill.raw_values],
    ['苍蓝雕纹魔像', ['敌人最密集的方向', '330/430'], (row) => `${row.skill.effects.source_text}|${row.skill.raw_values}`],
    ['艾希', ['465/700'], (row) => row.skill.raw_values],
    ['艾翁', ['185/350', '155/235'], (row) => row.skill.raw_values],
    ['茂凯', ['30', '90'], (row) => `${row.attributes_by_star['初始法力值'][0]}|${row.attributes_by_star['法力值'][0]}`],
    ['塔里克', ['100/225', '250/375'], (row) => row.skill.raw_values],
  ];
  for (const [name, expected, select] of expectations) includesAll(select(one(champions, name)), expected, name);
  const redTree = one(champions, '绯红印记树怪').skill;
  includesAll(`${redTree.descriptions_by_star['3']}|${redTree.values_by_star['3']}`, ['70%', '1000', '300%'], '绯红印记树怪 3星');
  includesAll(one(champions, '奈德丽').skill.descriptions_by_star['3'], ['3000'], '奈德丽 3星');
  includesAll(one(champions, '纳尔').skill.descriptions_by_star['3'], ['每次攻击提供20怒气', '250', '15000'], '纳尔 3星');
  includesAll(one(champions, '拉克丝').skill.descriptions_by_star['3'], ['6500'], '拉克丝 3星');
  includesAll(one(champions, '德莱文').skill.descriptions_by_star['3'], ['99999'], '德莱文 3星');
  assert.deepEqual(one(champions, '艾翁').balance_overrides, { initial_cells: 3, frontline_cells: 2, backline_cells: 1 });

  const swiftshot = one(traits, '迅捷射手');
  assert.deepEqual(swiftshot.breakpoints.map((row) => row.effect.match(/\+(\d+)%/)?.[1]), ['3', '5', '8', '12']);
  const executioner = one(traits, '裁决使').balance_overrides;
  assert.equal(executioner.tier_2_true_damage_enabled, false);
  assert.equal(executioner.true_damage_calculation_order, 'after_resistance_settlement');
  assert.deepEqual(executioner.true_damage_enabled_breakpoints, [3, 4]);
  assert.deepEqual(one(traits, '花仙子').balance_overrides.golden_pixie_thresholds, [170000, 200000, 300000, 400000, 500000, 600000]);
  assert.equal(one(traits, '魔女').balance_overrides.reward_probability_status, 'rebalanced_values_not_published');
  const covenTable = rewardTables.entity_tables.find((table) => table.table_id === 'trait:453:rewards');
  assert.ok(covenTable, '魔女结构化奖励表必须存在');
  const rewardGroup = (label) => covenTable.groups.find((group) => group.label === label);
  const rewardTitles = (outcome) => outcome.rewards.map((reward) => reward.title);
  const group130 = rewardGroup('130');
  const group185 = rewardGroup('185');
  const group250 = rewardGroup('250');
  const group365 = rewardGroup('365');
  assert.equal(group130.outcomes.length, 4);
  assert.equal(group185.outcomes.length, 4);
  assert.ok([...group130.outcomes, ...group185.outcomes].every((outcome) => (
    outcome.probability_pct === null && outcome.probability_text === null
  )));
  assert.equal(group130.probability_status, 'rebalanced_values_not_published');
  assert.equal(group185.probability_status, 'rebalanced_values_not_published');
  assert.ok(group130.outcomes.some((outcome) => (
    rewardTitles(outcome).join('|') === '凯特琳|基础装备|3金币'
      && outcome.rewards[0].champion_stars === 2
  )));
  assert.ok(group185.outcomes.some((outcome) => rewardTitles(outcome).join('|') === '成装锻造器|10金币'));
  assert.ok(group185.outcomes.some((outcome) => (
    rewardTitles(outcome).join('|') === '成装锻造器|凯特琳|卡蜜尔'
      && outcome.rewards.slice(1).every((reward) => reward.champion_stars === 2)
  )));
  assert.deepEqual(group250.outcomes.map((outcome) => rewardTitles(outcome)), [
    ['成装锻造器', '20金币'],
    ['莫甘娜', '幸运装备宝箱', '随机成装', '3金币'],
    ['幸运装备宝箱', '18金币', '装备重铸器'],
    ['魔女拉克丝', '基础装备锻造器', '幸运装备宝箱', '18金币'],
    ['神器锻造器', '成装锻造器', '18金币'],
  ]);
  assert.equal(group250.outcomes[1].rewards[0].champion_stars, 2);
  assert.ok(group365.outcomes.every((outcome) => rewardTitles(outcome).includes('额外12金币')));
  assert.ok(group365.outcomes.some((outcome) => (
    rewardTitles(outcome).slice(0, 3).join('|') === '光明版秘法手套|凯南|15金币'
      && outcome.rewards[1].champion_stars === 2
  )));

  const disabled = one(augments, '水乳交融');
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.availability_status, 'disabled');
  assert.ok(augments.filter((row) => row.name === '致命丽花').every((row) => row.per_game_player_limit === 1));
  assert.equal(one(augments, '女巫使魔').shared_per_game_limit.group, 'coven_familiar_or_dark_ritual');
  assert.deepEqual(one(augments, '黑暗仪式').balance_overrides.redeem_ap_by_tier, [7, 15, 50, 75, 125, 200, 300]);
  assert.equal(one(augments, '拼盘天梯').per_game_player_limit, 1);

  const horizon = one(items, '视界专注');
  assert.equal(horizon.availability_status, 'enabled');
  assert.equal(horizon.source_proof.published_values, false);
  assert.match(horizon.desc, /未公布效果数值/);
  assert.equal(one(items, '碎舰者').source, 'jcc_official_s18_source_docs');
  assert.equal(seasonMechanics.balance_overrides.nature_sprite_probability_status, 'rebalanced_values_not_published');
  assert.equal(manifest.balance_patch?.applied_operations, 27);
  return { generation_id: manifest.hard_data_generation_id, counts: { champions: champions.length, traits: traits.length, items: items.length, augments: augments.length } };
}

async function main() {
  const result = await verifyS18Patch182(argument('--manifest') || (() => { throw new Error('--manifest is required'); })());
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
}
