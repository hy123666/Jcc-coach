#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildSeasonArchive } from './archive-jcc-season.mjs';

const KNOWLEDGE_ROOT = 'data/game-knowledge/jcc';

function expectedArchivePath(seasonId) {
  return path.posix.join('seasons', seasonId, 'archive-manifest.json');
}

async function verifyRegisteredArchive({ repoRoot, knowledgeRoot, seasonId, relativeArchive }) {
  assert.match(seasonId, /^s\d+$/, 'Registered archive season id must use the s<number> form');
  assert.equal(
    relativeArchive,
    expectedArchivePath(seasonId),
    `Registered archive for ${seasonId} must use its controlled in-place path`,
  );
  const archiveFile = path.resolve(knowledgeRoot, relativeArchive);
  assert.ok(
    archiveFile.startsWith(`${path.resolve(knowledgeRoot)}${path.sep}`),
    `Registered archive for ${seasonId} must remain inside the game-knowledge root`,
  );
  const persisted = JSON.parse(await readFile(archiveFile, 'utf8'));
  assert.equal(persisted.season_id, seasonId, `Registered archive key must match ${seasonId} content`);
  const rebuilt = await buildSeasonArchive({
    repoRoot,
    seasonId,
    finalCoreProfileId: persisted.final_core_profile_id,
  });
  assert.deepEqual(persisted, rebuilt, `Persisted archive manifest must match current immutable ${seasonId} source identities`);
  assert.equal(persisted.status, 'frozen_read_only_in_place');
  assert.equal(persisted.archive_policy.physical_relocation_allowed, false);
  assert.equal(persisted.archive_policy.source_updates_allowed, false);
  assert.equal(persisted.archive_policy.excluded_from_new_default_compilation, true);
  assert.ok(persisted.source_assets.some((entry) => entry.role === 'season_descriptor'));
  assert.ok(persisted.source_assets.some((entry) => entry.role === 'season_patch_asset'));
  assert.ok(
    persisted.source_assets.every((entry) => !entry.path.startsWith('data/runtime/jcc/seasons/')),
    `${seasonId} archived game knowledge must not remain in the Runtime contract tree`,
  );
  assert.ok(persisted.core_packages.length >= 1, `${seasonId} core packages must remain archived in place`);
  assert.ok(persisted.generated_core_profiles.length >= 1, `${seasonId} generated Core Profiles must remain discoverable for rollback`);
  assert.ok(
    persisted.generated_core_profiles.some((entry) => entry.core_profile_id === persisted.final_core_profile_id),
    `${seasonId} final Core Profile must be present in the archived generation references`,
  );
  const archivedCoreProfileIds = persisted.generated_core_profiles.map((entry) => entry.core_profile_id);
  assert.equal(
    new Set(archivedCoreProfileIds).size,
    archivedCoreProfileIds.length,
    `${seasonId} archive must not duplicate Core Profile retention references`,
  );
  assert.ok(
    persisted.generated_core_profiles.every((entry) => (
      entry.physical_tree?.path === path.posix.join(KNOWLEDGE_ROOT, 'generated', entry.core_profile_id)
    )),
    `${seasonId} archived Core Profile references must identify their immutable generated directories`,
  );
  assert.ok(persisted.retention_reference_policy.includes('active Core Profile'));
  assert.ok(persisted.retention_reference_policy.includes('generation lease'));
  assert.ok(persisted.source_assets.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  const physicalTrees = [
    ...persisted.core_packages.map((entry) => entry.physical_tree),
    ...persisted.generated_core_profiles.map((entry) => entry.physical_tree),
    ...persisted.ranking_generations.map((entry) => entry.physical_tree),
  ];
  assert.ok(physicalTrees.length > 0, 'Archived rollback assets must carry physical directory fingerprints');
  assert.ok(physicalTrees.every((tree) => (
    tree
    && Number.isInteger(tree.file_count)
    && tree.file_count > 0
    && Number.isInteger(tree.total_bytes)
    && tree.total_bytes > 0
    && /^[a-f0-9]{64}$/.test(tree.tree_sha256)
  )), 'Every archived rollback directory must have a complete physical tree fingerprint');
  return {
    season_id: seasonId,
    archive_path: relativeArchive,
    source_assets: persisted.source_assets.length,
    core_packages: persisted.core_packages.length,
    generated_core_profiles: persisted.generated_core_profiles.length,
    ranking_generations: persisted.ranking_generations.length,
    retention_reference_kinds: persisted.retention_reference_policy.length,
    protected_core_profile_ids: archivedCoreProfileIds,
  };
}

export async function verifySeasonArchives({ repoRoot = path.resolve(import.meta.dirname, '..') } = {}) {
  const knowledgeRoot = path.join(repoRoot, KNOWLEDGE_ROOT);
  const rootManifest = JSON.parse(await readFile(path.join(knowledgeRoot, 'manifest.json'), 'utf8'));
  const registrations = Object.entries(rootManifest.season_archives ?? {});
  assert.ok(registrations.length > 0, 'Game-knowledge manifest must register at least one season archive');
  const archives = [];
  for (const [seasonId, relativeArchive] of registrations) {
    archives.push(await verifyRegisteredArchive({ repoRoot, knowledgeRoot, seasonId, relativeArchive }));
  }
  const protectedCoreProfileIds = new Set(archives.flatMap((archive) => archive.protected_core_profile_ids));
  for (const archive of archives) {
    for (const coreProfileId of archive.protected_core_profile_ids) {
      assert.ok(protectedCoreProfileIds.has(coreProfileId), `${archive.season_id} Core Profile must be retained by the registered archive set`);
    }
  }
  return {
    registered_archives: archives.length,
    protected_core_profiles: protectedCoreProfileIds.size,
    archives,
  };
}

async function main() {
  const result = await verifySeasonArchives();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
