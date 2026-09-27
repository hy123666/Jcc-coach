import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  pointPatchManifestAtHardDataGeneration,
  pruneHardDataGenerations,
  publishAndPointPatchHardDataCandidate,
  publishImmutableHardDataGeneration,
} from './jcc_hard_data_package_store.mjs';

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function makeStaging(repoRoot, name, generationId, marker) {
  const root = path.join(repoRoot, 'data/core-patches/jcc', `.staging-${name}`);
  await mkdir(path.join(root, 'indexes'), { recursive: true });
  await writeJson(path.join(root, 'manifest.json'), {
    packageId: 'jcc-s99-s99_1',
    mode: '99',
    season: '99',
    version: '99.1',
    runtime_patch_id: 's99_1',
    immutable: true,
    hard_data_generation_id: generationId,
    marker,
  });
  await writeJson(path.join(root, 'hard-data-manifest.json'), { schema: 'test-hard-data-manifest-v1', marker });
  await writeJson(path.join(root, 'indexes/augment_stage_authority.json'), { schema: 'test-stage-v1', marker });
  await writeJson(path.join(root, 'indexes/supplemental_source_audit.json'), { schema: 'test-audit-v1', marker });
  await writeJson(path.join(root, 'runtime-catalog-overlay.json'), { schema: 'test-overlay-v1', marker });
  return root;
}

const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'jcc-hard-data-package-store-'));
try {
  const abandonedLock = path.join(repoRoot, 'data/core-patches/jcc/.hard-data-lifecycle.lock');
  await writeJson(abandonedLock, { pid: 2147483647, acquired_at: '2000-01-01T00:00:00.000Z' });
  const patchManifestFile = path.join(repoRoot, 'data/game-knowledge/jcc/seasons/s99/patches/s99_1/source-manifest.json');
  const baseArtifacts = [
    ['hard_data_manifest', 'manifest.json'],
    ['hard_data_content_manifest', 'hard-data-manifest.json'],
    ['augment_stage_authority', 'indexes/augment_stage_authority.json'],
    ['supplemental_source_audit', 'indexes/supplemental_source_audit.json'],
    ['runtime_catalog_overlay', 'runtime-catalog-overlay.json'],
  ].map(([role, suffix]) => ({ role, path: `data/core-patches/jcc/legacy/${suffix}` }));
  await writeJson(patchManifestFile, {
    schema: 'jcc-game-knowledge-patch-source-manifest-v1',
    source_artifacts: baseArtifacts,
    runtime_mapping_validation: { catalog_overlay: 'data/core-patches/jcc/legacy/runtime-catalog-overlay.json' },
  });

  const firstId = '1'.repeat(64);
  const firstStaging = await makeStaging(repoRoot, 'first', firstId, 'first');
  const first = await publishImmutableHardDataGeneration({ repoRoot, stagingDir: firstStaging, generationId: firstId });
  assert.equal(first.source_artifacts.trait_diversity_roster_support, undefined, 'patch-specific companion data must stay optional');
  await pointPatchManifestAtHardDataGeneration({ repoRoot, patchManifestFile, publication: first });
  const firstManifestBytes = await readFile(path.join(first.generation_dir, 'manifest.json'));
  const simulatedActivePointer = {
    runtime_identity: { hard_data_manifest: first.source_artifacts.hard_data_manifest },
  };
  await writeJson(path.join(repoRoot, 'data/game-knowledge/jcc/generated', firstId, 'bundle.json'), simulatedActivePointer);

  const secondId = '2'.repeat(64);
  const secondStaging = await makeStaging(repoRoot, 'second', secondId, 'second');
  const [second] = await Promise.all([
    publishAndPointPatchHardDataCandidate({ repoRoot, stagingDir: secondStaging, generationId: secondId, patchManifestFile }),
    pruneHardDataGenerations({ repoRoot }),
  ]);
  assert.equal(simulatedActivePointer.runtime_identity.hard_data_manifest, first.source_artifacts.hard_data_manifest);
  assert.deepEqual(await readFile(path.join(first.generation_dir, 'manifest.json')), firstManifestBytes);
  const updatedPatch = JSON.parse(await readFile(patchManifestFile, 'utf8'));
  assert.equal(updatedPatch.hard_data_candidate.generation_id, secondId);
  assert.equal(updatedPatch.source_artifacts.find((row) => row.role === 'hard_data_manifest').path, second.source_artifacts.hard_data_manifest);

  const repeatedStaging = await makeStaging(repoRoot, 'repeated', secondId, 'second');
  const repeated = await publishImmutableHardDataGeneration({ repoRoot, stagingDir: repeatedStaging, generationId: secondId });
  assert.equal(repeated.generation_dir, second.generation_dir);
  assert.deepEqual(await readFile(path.join(first.generation_dir, 'manifest.json')), firstManifestBytes);

  const collisionStaging = await makeStaging(repoRoot, 'collision', secondId, 'different');
  await assert.rejects(
    publishImmutableHardDataGeneration({ repoRoot, stagingDir: collisionStaging, generationId: secondId }),
    /generation collision/,
  );

  const inheritedId = '3'.repeat(64);
  const inheritedStaging = await makeStaging(repoRoot, 'inherited', inheritedId, 'inherited');
  await publishImmutableHardDataGeneration({ repoRoot, stagingDir: inheritedStaging, generationId: inheritedId });
  updatedPatch.hard_data_inheritance = { generation_id: inheritedId, roles: ['mechanics_parameters'] };
  await writeJson(patchManifestFile, updatedPatch);

  const orphanId = '4'.repeat(64);
  const orphanStaging = await makeStaging(repoRoot, 'orphan', orphanId, 'orphan');
  await publishImmutableHardDataGeneration({ repoRoot, stagingDir: orphanStaging, generationId: orphanId });
  const pruned = await pruneHardDataGenerations({ repoRoot });
  assert.deepEqual(pruned.retained, [firstId, secondId, inheritedId]);
  assert.deepEqual(pruned.removed, [orphanId]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: 'jcc-hard-data-package-store-verifier-v1',
    checked: [
      'content-addressed generation publication',
      'abandoned publication lock recovery',
      'candidate source pointer update',
      'publication and candidate pointer update share the pruning lifecycle lock',
      'active generation remains byte-identical during same-patch refresh',
      'idempotent repeat publication',
      'generation collision fails closed',
      'manifest-declared inheritance generations retained',
      'referenced generations retained and orphan generations pruned',
    ],
  })}\n`);
} finally {
  await rm(repoRoot, { recursive: true, force: true });
}
