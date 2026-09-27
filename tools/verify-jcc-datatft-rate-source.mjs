#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_REWARD_KEYS = [
  '魔女', '羁绊天梯', '法球1', '法球2', '法球3', '法球4', '远征', '征战之路',
  '轻量魔法投掷', '魔法投掷', '金蛋', '混沌召唤16', '扩展包',
];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--snapshot') options.snapshot = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

function approximateProbabilityMass(outcomes) {
  const probabilities = outcomes.map((row) => row.probability_pct).filter(Number.isFinite);
  if (!probabilities.length) return null;
  return probabilities.reduce((total, value) => total + Math.round(value * 100), 0);
}

export function verifyDataTftRateSnapshot(snapshot) {
  assert.equal(snapshot.schema, 'jcc-datatft-rate-snapshot-v1');
  assert.equal(snapshot.target?.season_id, 's18');
  assert.equal(snapshot.source?.provider_id, 'datatft');
  assert.match(snapshot.source?.index_asset_sha256 || '', /^[a-f0-9]{64}$/);
  assert.match(snapshot.source?.encrypted_data_asset_sha256 || '', /^[a-f0-9]{64}$/);

  assert.deepEqual(snapshot.basic_information?.shop?.pool_by_cost, {
    '1': 30, '2': 25, '3': 18, '4': 10, '5': 9,
  });
  assert.deepEqual(snapshot.basic_information?.shop?.odds_by_level?.['8'], [15, 20, 32, 30, 3]);
  for (const [level, odds] of Object.entries(snapshot.basic_information?.shop?.odds_by_level || {})) {
    assert.equal(odds.length, 5, `level ${level} must contain five shop cost probabilities`);
    assert.ok(odds.every((value) => Number.isFinite(value) && value >= 0), `level ${level} shop odds must be finite`);
    assert.equal(odds.reduce((total, value) => total + value, 0), 100, `level ${level} shop odds must sum to 100`);
  }
  assert.deepEqual(snapshot.basic_information?.economy?.base_income_by_round, {
    '1-1': 0, '1-2': 2, '1-3': 2, '1-4': 3, '2-1': 4, '2-2': 5,
  });
  assert.deepEqual(snapshot.basic_information?.economy?.streak_bonus_by_length, {
    '1': 0, '2': 1, '3': 1, '4': 1, '5': 2, '6': 3, '7': 3, '8': 3,
  });

  const tierRows = snapshot.augment_tier_sequence_probabilities?.rows || [];
  assert.equal(tierRows.length, 18);
  assert.equal(snapshot.augment_tier_sequence_probabilities?.semantics, 'conditional_distribution_within_each_first_choice_tier_group');
  for (const tier of ['silver', 'gold', 'prismatic']) {
    const mass = tierRows.filter((row) => row.first_choice_tier === tier)
      .reduce((total, row) => total + Math.round(row.probability_pct * 10), 0);
    assert.ok(Math.abs(mass - 1000) <= 1, `${tier} conditional sequence probability must sum to 100% within source rounding`);
  }

  assert.deepEqual(Object.keys(snapshot.reward_tables || {}).sort(), [...EXPECTED_REWARD_KEYS].sort());
  assert.equal(Object.hasOwn(snapshot.reward_tables || {}, '战利品订阅'), false);
  assert.deepEqual(snapshot.exclusions, [{
    source_key: '战利品订阅',
    reason: 'explicit_product_exclusion_not_persisted_as_runtime_knowledge',
    present_upstream: true,
  }]);
  assert.deepEqual(snapshot.reward_tables?.['魔女']?.groups.map((group) => group.label), [
    '40', '85', '130', '185', '250', '365', '500', '650', '800',
  ]);
  assert.deepEqual(snapshot.reward_tables?.['羁绊天梯']?.groups.map((group) => group.label), [
    '2 Traits', '3 Traits', '4 Traits', '5 Traits', '6 Traits', '7 Traits', '8 Traits',
    '9 Traits', '10 Traits', '11 Traits', '12 Traits', '13 Traits', '14 Traits',
  ]);
  assert.deepEqual(['法球1', '法球2', '法球3', '法球4'].map((key) => snapshot.reward_tables[key]?.kind), ['orb', 'orb', 'orb', 'orb']);
  for (const [tableKey, table] of Object.entries(snapshot.reward_tables || {})) {
    assert.equal(table.outcome_semantics, 'every_reward_in_the_selected_outcome_is_granted_together');
    assert.ok(table.groups.length > 0, `${tableKey} must have reward groups`);
    for (const group of table.groups) {
      assert.ok(group.outcomes.length > 0, `${tableKey}/${group.label || 'default'} must have outcomes`);
      for (const outcome of group.outcomes) {
        assert.ok(outcome.rewards.length > 0, `${tableKey} reward outcome must remain a non-empty atomic bundle`);
        assert.ok(outcome.rewards.every((reward) => Number.isFinite(reward.count) && reward.count > 0));
      }
      const probabilityMass = approximateProbabilityMass(group.outcomes);
      if (probabilityMass !== null) {
        assert.ok(Math.abs(probabilityMass - 10000) <= 50, `${tableKey}/${group.label || 'default'} probability mass must be approximately 100% within source rounding`);
      }
    }
  }
  return {
    reward_tables: Object.keys(snapshot.reward_tables).length,
    reward_outcomes: snapshot.counts?.reward_outcomes,
    augment_tier_sequence_rows: tierRows.length,
  };
}

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const options = parseArgs(process.argv.slice(2));
  const snapshotFile = path.resolve(repoRoot, options.snapshot
    || 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/datatft-s18-rate.json');
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  const result = verifyDataTftRateSnapshot(snapshot);
  process.stdout.write(`${JSON.stringify({ ok: true, snapshot: snapshotFile, ...result })}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
