#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_TARGETS = new Map([
  ['DA_TraitLadder', 'trait_ladder_reward_progress'],
  ['DA_BronzeForLifeI', 'bronze_trait_scaling'],
  ['DA_BronzeForLifeII', 'bronze_trait_scaling'],
]);
const EXPECTED_POPULATIONS = [4, 5, 6, 7, 8, 9, 10];
const EXPECTED_BASE_MAXIMUMS = new Map([[4, 4], [5, 6], [6, 7], [7, 9], [8, 10], [9, 11], [10, 12]]);
const EXPECTED_RETAINED_ROWS = new Map([[4, 40], [5, 2], [6, 9], [7, 2], [8, 5], [9, 9], [10, 14]]);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--snapshot') options.snapshot = argv[++index];
    else if (token === '--patch-source-manifest') options.patchSourceManifest = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

export function verifyDataTftTraitTrackerSnapshot(snapshot, expectedTarget = null) {
  assert.equal(snapshot.schema, 'jcc-datatft-trait-tracker-snapshot-v2');
  assert.deepEqual(snapshot.target, expectedTarget || { season_id: 's18', patch_id: 's18_1', external_season_number: 18 });
  assert.equal(snapshot.source?.provider_id, 'datatft');
  assert.match(snapshot.source?.index_asset_sha256 || '', /^[a-f0-9]{64}$/);
  assert.match(snapshot.source?.tracker_asset_sha256 || '', /^[a-f0-9]{64}$/);
  assert.equal(snapshot.source?.trust_role, 'supplemental_trait_diversity_roster_support');
  assert.deepEqual(snapshot.tracker_contract?.populations, EXPECTED_POPULATIONS);
  assert.equal(snapshot.tracker_contract?.roster_semantics, 'each roster is one atomic unit set and must never be unioned with another roster');

  const targets = new Map((snapshot.augment_targets || []).map((row) => [row.external_id, row.objective_id]));
  assert.deepEqual(targets, EXPECTED_TARGETS);
  assert.deepEqual(snapshot.support_keys, ['none']);
  assert.equal(snapshot.roster_groups?.length, 7);
  assert.deepEqual(snapshot.tracker_contract?.high_cost_role_filter?.required_high_cost_tank_count, 1);
  assert.deepEqual(snapshot.tracker_contract?.high_cost_role_filter?.required_high_cost_carry_count, 1);
  const rosterIds = new Set();
  for (const group of snapshot.roster_groups || []) {
    assert.ok(snapshot.support_keys.includes(group.support_key));
    assert.ok(EXPECTED_POPULATIONS.includes(group.population));
    assert.equal(group.upstream_row_count, 40);
    assert.equal(group.identity_evidence_rosters.length, 40);
    assert.equal(group.row_count, EXPECTED_RETAINED_ROWS.get(group.population));
    assert.equal(group.rosters.length, group.row_count);
    for (const roster of group.rosters) {
      assert.match(roster.roster_id, /^[a-f0-9]{64}$/);
      assert.equal(roster.source_champion_ids.length, group.population);
      assert.equal(new Set(roster.source_champion_ids).size, group.population);
      assert.equal(roster.active_trait_count, roster.trait_texts.length);
      assert.ok(roster.trait_texts.every((value) => /^\d+\S/u.test(value)));
      assert.ok(Number.isFinite(roster.quality));
      assert.ok(Number.isFinite(roster.total_cost));
      assert.ok(Number.isInteger(roster.high_cost_tank_count));
      assert.ok(Number.isInteger(roster.high_cost_carry_count));
      if (group.population >= 5) assert.equal(roster.satisfies_default_high_cost_role_filter, true);
      assert.equal(rosterIds.has(roster.roster_id), false, `duplicate roster id ${roster.roster_id}`);
      rosterIds.add(roster.roster_id);
    }
  }
  for (const [population, maximum] of EXPECTED_BASE_MAXIMUMS) {
    const group = snapshot.roster_groups.find((row) => row.support_key === 'none' && row.population === population);
    assert.equal(group?.maximum_active_trait_count, maximum, `unexpected no-emblem maximum at population ${population}`);
  }
  assert.equal(snapshot.counts?.staging_input_candidate_rows, rosterIds.size);
  assert.equal(snapshot.counts?.upstream_no_emblem_candidate_rows, 280);
  assert.equal(snapshot.counts?.role_eligible_candidate_rows, 41);
  assert.equal(snapshot.counts?.constraint_unavailable_fallback_rows, 40);
  assert.equal(snapshot.counts?.staging_input_candidate_rows, 81);
  assert.equal(snapshot.counts?.unit_slot_occurrences, 499);
  assert.equal(snapshot.counts?.unique_champion_entities_used, 40);
  assert.equal('roster_rows' in snapshot.counts, false, 'internal search candidates must not be labeled as final rosters');
  assert.equal('champion_references' in snapshot.counts, false, 'slot occurrences must not be labeled as distinct champions');
  return { support_keys: snapshot.support_keys.length, staging_input_candidate_rows: rosterIds.size };
}

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const options = parseArgs(process.argv.slice(2));
  const patchManifest = JSON.parse(await readFile(path.resolve(repoRoot, options.patchSourceManifest
    || 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-manifest.json'), 'utf8'));
  const snapshotFile = path.resolve(repoRoot, options.snapshot
    || 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/datatft-s18-trait-tracker.json');
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  const externalSeasonNumber = patchManifest.offline_core_supplement_sources?.datatft_s18_frozen?.season_number;
  const result = verifyDataTftTraitTrackerSnapshot(snapshot, {
    season_id: patchManifest.season_id,
    patch_id: patchManifest.patch_id,
    external_season_number: externalSeasonNumber,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, snapshot: snapshotFile, ...result })}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
