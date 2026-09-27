#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--snapshot') options.snapshot = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

export async function verifyDataTftDatabaseSource(options = {}) {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const file = path.resolve(repoRoot, options.snapshot || 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/datatft-s18-database.json');
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(snapshot.schema, 'jcc-datatft-database-snapshot-v1');
  assert.equal(snapshot.target?.season_id, 's18');
  assert.equal(snapshot.source?.trust_role, 'supplemental_structured_hard_data');
  assert.deepEqual(snapshot.counts, {
    champions: 65,
    items: 149,
    traits: 36,
    augments: 256,
    nature_sprites: 170,
  });
  assert.deepEqual(snapshot.category_definitions?.augment?.map((row) => row.id), [
    'economy', 'combat', 'equipment', 'synergy', 'exclusive', 'other',
  ]);
  assert.deepEqual(snapshot.category_definitions?.nature_sprite?.map((row) => row.id), [
    'champion', 'item', 'shop', 'combat', 'gold_xp', 'risky', 'misc',
  ]);
  const awakening = snapshot.catalogs.augments.find((row) => row.jccname === '核心位的觉悟' || row.name === 'C位的觉悟');
  assert.ok(awakening, 'C位的觉悟 must exist');
  assert.deepEqual(awakening.round, ['3-2', '4-2']);
  assert.ok(awakening.category_ids.length > 0);
  assert.ok(snapshot.catalogs.augments.every((row) => ['silver', 'gold', 'prismatic'].includes(row.tier_color)));
  assert.ok(snapshot.catalogs.augments.every((row) => row.round.every((round) => ['2-1', '3-2', '4-2'].includes(round))));
  assert.ok(snapshot.catalogs.nature_sprites.every((row) => row.upgrade?.effect));
  assert.ok(snapshot.catalogs.nature_sprites.every((row) => row.category_id && row.category_label));
  assert.ok(snapshot.catalogs.nature_sprites.every((row) => Array.isArray(row.available_rounds) && row.available_rounds.length > 0));
  for (const row of snapshot.catalogs.nature_sprites) {
    const groupedRounds = Object.values(row.stage_groups || {}).flat();
    assert.deepEqual(groupedRounds, row.available_rounds, `${row.title} stage groups must cover every available round exactly once`);
    assert.ok(row.available_rounds.every((round) => {
      const [stage, subround] = round.split('-').map(Number);
      return stage < 8 || (stage === 8 && subround <= 1);
    }), `${row.title} must not expose a nature-sprite round after 8-1`);
    assert.equal(Object.keys(row.stage_groups || {}).some((stage) => Number(stage) > 8), false);
    if (row.stage_groups?.['8']) assert.deepEqual(row.stage_groups['8'], ['8-1']);
  }
  assert.ok(snapshot.catalogs.nature_sprites.some((row) => row.stage_groups?.['3']?.includes('3-1')));
  assert.ok(snapshot.catalogs.nature_sprites.some((row) => row.stage_groups?.['7']?.includes('7-7')));
  assert.ok(snapshot.catalogs.nature_sprites.some((row) => row.stage_groups?.['8']?.includes('8-1')));
  return { file, snapshot };
}

async function main() {
  const result = await verifyDataTftDatabaseSource(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ ok: true, file: result.file, counts: result.snapshot.counts })}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
