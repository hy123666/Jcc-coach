#!/usr/bin/env node

import assert from 'node:assert/strict';

import { applyBalancePatchSet } from './jcc_balance_patch_overlay.mjs';

const baseline = {
  identity: { season_id: 's18', patch_id: 's18_1', mode_id: 'mode18' },
  champions: [{ id: '1503', name: '可酷伯', raw_values: '265/315/430', attributes_by_star: { 生命: [700, 1260, 2268, 3276] }, skill: { effects: { source_text: '在2秒内持续回复265/315/430生命值。' } } }],
  traits: [{ id: '451', name: '永恒之森', breakpoints: [{ count: 7, effect: '生命值400' }] }],
  items: [{ id: '2081', name: '光明版石像鬼石板甲', basic_desc: '+300生命值', desc: '+300生命值' }],
  augments: [{ id: '30701', name: '贪财+', desc: '立刻获得10金币，然后在每个阶段开始时获得7金币。' }],
  sprites: [{ id: '181232', name: '钢铁核心', cost: 2, description: '在3-5阶段获得。' }],
};

const patch = {
  schema: 'jcc-core-balance-patch-v1',
  release_version: '18.1b',
  baseline: baseline.identity,
  operations: [
    { kind: 'replace_text', catalog: 'champions', name: '可酷伯', replacements: [{ from: '265/315/430', to: '265/315/460' }] },
    { kind: 'replace_field', catalog: 'champions', name: '可酷伯', path: 'attributes_by_star.生命', from: [700, 1260, 2268, 3276], to: [700, 1260, 2268, 3276] },
    { kind: 'replace_text', catalog: 'traits', name: '永恒之森', replacements: [{ from: '生命值400', to: '生命值450' }] },
    { kind: 'replace_text', catalog: 'items', name: '光明版石像鬼石板甲', replacements: [{ from: '+300生命值', to: '+400生命值' }] },
    { kind: 'replace_text', catalog: 'augments', name: '贪财+', replacements: [{ from: '立刻获得10金币', to: '立刻获得13金币' }] },
    { kind: 'replace_text', catalog: 'sprites', name: '钢铁核心', replacements: [{ from: '3-5阶段', to: '4-1阶段' }] },
  ],
};

const result = applyBalancePatchSet(baseline, patch);
const reordered = applyBalancePatchSet({ identity: baseline.identity, champions: [{id:'x',name:'x',details:{a:1,b:2}}] }, {
  schema:'jcc-core-balance-patch-v1', release_version:'test', baseline:baseline.identity,
  operations:[{kind:'replace_field',catalog:'champions',id:'x',path:'details',from:{b:2,a:1},to:{a:3,b:2}}],
});
assert.deepEqual(reordered.catalogs.champions[0].details,{a:3,b:2});
assert.equal(result.catalogs.champions[0].raw_values, '265/315/460');
assert.match(result.catalogs.champions[0].skill.effects.source_text, /265\/315\/460/u);
assert.equal(result.catalogs.traits[0].breakpoints[0].effect, '生命值450');
assert.equal(result.catalogs.items[0].desc, '+400生命值');
assert.match(result.catalogs.augments[0].desc, /立刻获得13金币/u);
assert.equal(result.catalogs.sprites[0].description, '在4-1阶段获得。');
assert.equal(result.audit.release_version, '18.1b');
assert.equal(result.audit.applied_operations, patch.operations.length);
assert.equal(result.audit.baseline.patch_id, 's18_1');

assert.throws(
  () => applyBalancePatchSet(baseline, { ...patch, baseline: { ...baseline.identity, patch_id: 's18_0' } }),
  /baseline mismatch/u,
);

const compositeBaseline = {
  identity: { season_id: 's18', patch_id: 's18_1', mode_id: 'mode18', hard_data_generation_id: 'parent-generation' },
  sprites: [{
    id: '181074',
    name: '后排之星',
    cost: 4,
    description: '基础75%。',
    source_variants: [
      { id: '181074', cost: 4, description: '基础75%。' },
      { id: '181075', cost: 4, description: '升级100%。' },
    ],
    upgrade: { cost: 4, effect: '升级100%。' },
  }],
};

const compositeResult = applyBalancePatchSet(compositeBaseline, {
  schema: 'jcc-core-balance-patch-v1',
  release_version: '18.1b',
  baseline: compositeBaseline.identity,
  operations: [
    { kind: 'replace_field', catalog: 'sprites', id: '181074', variant_id: '181075', path: 'cost', from: 4, to: 3 },
    { kind: 'replace_text', catalog: 'sprites', id: '181074', variant_id: '181075', replacements: [{ from: '100%', to: '115%' }] },
  ],
});
assert.equal(compositeResult.catalogs.sprites[0].cost, 4);
assert.equal(compositeResult.catalogs.sprites[0].source_variants[0].cost, 4);
assert.equal(compositeResult.catalogs.sprites[0].source_variants[1].cost, 3);
assert.equal(compositeResult.catalogs.sprites[0].source_variants[1].description, '升级115%。');
assert.equal(compositeResult.catalogs.sprites[0].upgrade.cost, 3);
assert.equal(compositeResult.catalogs.sprites[0].upgrade.effect, '升级115%。');

const synchronizedBaseResult = applyBalancePatchSet(compositeBaseline, {
  schema: 'jcc-core-balance-patch-v1',
  release_version: '18.1b',
  baseline: compositeBaseline.identity,
  operations: [
    { kind: 'replace_field', catalog: 'sprites', id: '181074', sync_base_variant: true, path: 'cost', from: 4, to: 3 },
  ],
});
assert.equal(synchronizedBaseResult.catalogs.sprites[0].cost, 3);
assert.equal(synchronizedBaseResult.catalogs.sprites[0].source_variants[0].cost, 3);
assert.equal(synchronizedBaseResult.catalogs.sprites[0].source_variants[1].cost, 4);
assert.equal(synchronizedBaseResult.catalogs.sprites[0].upgrade.cost, 4);

const rewardBaseline = {
  identity: baseline.identity,
  reward_tables: [{
    entity_tables: [{
      table_id: 'trait:453:rewards',
      groups: [{
        label: '130',
        outcomes: [{
          ordinal: 1,
          probability_pct: 100,
          probability_text: '100%',
          rewards: [{ title: '3金币', display_title: '3金币', count: 1, type: null, item_id: null, champion_id: null, champion_stars: null, icon: null }],
        }],
      }],
    }],
    season_tables: [],
    supplemental_unbound_tables: [],
  }],
};
const rewardResult = applyBalancePatchSet(rewardBaseline, {
  schema: 'jcc-core-balance-patch-v1',
  release_version: '18.2',
  source_note_sha256: 'a'.repeat(64),
  baseline: rewardBaseline.identity,
  operations: [{
    kind: 'patch_reward_group',
    catalog: 'reward_tables',
    singleton: true,
    table_id: 'trait:453:rewards',
    group_label: '130',
    invalidate_probabilities: true,
    changes: [
      { kind: 'replace_outcome', match_rewards: [{ title: '3金币' }], rewards: [{ title: '5金币' }] },
      { kind: 'add_outcome', rewards: [{ title: '凯特琳', type: 'hero', champion_id: '918051', champion_stars: 2 }] },
    ],
  }],
});
const rewardGroup = rewardResult.catalogs.reward_tables[0].entity_tables[0].groups[0];
assert.deepEqual(rewardGroup.outcomes.map((outcome) => outcome.rewards[0].title), ['5金币', '凯特琳']);
assert.ok(rewardGroup.outcomes.every((outcome) => outcome.probability_pct === null && outcome.probability_text === null));
assert.equal(rewardGroup.probability_status, 'rebalanced_values_not_published');
assert.equal(rewardGroup.patch_provenance.release_version, '18.2');
assert.equal(rewardGroup.outcomes[1].rewards[0].champion_stars, 2);

assert.throws(() => applyBalancePatchSet(rewardBaseline, {
  schema: 'jcc-core-balance-patch-v1',
  release_version: '18.2',
  baseline: rewardBaseline.identity,
  operations: [{
    kind: 'patch_reward_group', catalog: 'reward_tables', singleton: true,
    table_id: 'trait:453:rewards', group_label: '130',
    changes: [{ kind: 'replace_outcome', match_rewards: [{ title: '不存在' }], rewards: [{ title: '5金币' }] }],
  }],
}), /reward outcome is not unique/u);

process.stdout.write('jcc balance patch overlay verification passed\n');
