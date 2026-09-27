#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_SNAPSHOT = path.resolve(
  import.meta.dirname,
  '../data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/official-s18-augments.json',
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function argValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

async function main() {
  const argv = process.argv.slice(2);
  const snapshotFile = path.resolve(argValue(argv, '--snapshot', DEFAULT_SNAPSHOT));
  const patchManifestFile = path.resolve(argValue(argv, '--patch-source-manifest',
    'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-manifest.json'));
  const patchManifest = JSON.parse(await readFile(patchManifestFile, 'utf8'));
  const expectedSeason = patchManifest.season_id;
  const expectedPatch = patchManifest.patch_id;
  const expectedMode = `mode${patchManifest.upstream_source.mode}`;
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  assert.equal(snapshot.schema, 'jcc-official-augment-snapshot-v1');
  assert.deepEqual(snapshot.target, { season_id: expectedSeason, patch_id: expectedPatch, mode_id: expectedMode });
  assert.equal(snapshot.upstream_identity.mode, patchManifest.upstream_source.mode);
  assert.equal(snapshot.upstream_identity.season, patchManifest.upstream_source.season_id);
  assert.equal(snapshot.source.trust_role, 'primary_augment_entity_authority');
  assert.equal(snapshot.augments.length, snapshot.counts.rows);
  assert.equal(new Set(snapshot.augments.map((row) => row.id)).size, snapshot.augments.length);
  assert.equal(new Set(snapshot.augments.map((row) => row.name)).size, snapshot.counts.unique_names);
  assert.deepEqual(
    snapshot.counts.by_tier,
    Object.fromEntries([1, 2, 3].map((tier) => [String(tier), snapshot.augments.filter((row) => row.tier === tier).length])),
  );
  const lightRoll = snapshot.augments.find((row) => row.name === '轻量魔法投掷');
  assert.ok(lightRoll, 'official catalog must contain 轻量魔法投掷');
  assert.equal(lightRoll.id, '10559');
  assert.equal(lightRoll.tier, 1);
  assert.match(lightRoll.description, /投掷一个骰子/);
  assert.ok(snapshot.augments.length > 0, 'official augment catalog is empty');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    snapshot_sha256: sha256(await readFile(snapshotFile)),
    rows: snapshot.augments.length,
    unique_names: snapshot.counts.unique_names,
    light_magic_roll: { id: lightRoll.id, tier: lightRoll.tier },
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
