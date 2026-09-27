#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA = 'jcc-season-in-place-archive-v1';
const KNOWLEDGE_ROOT = 'data/game-knowledge/jcc';

function archiveRelativePath(seasonId) {
  return path.posix.join('seasons', seasonId, 'archive-manifest.json');
}

async function writeAtomic(file, serialized) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readOptionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function validateRegisteredRetiredSeason({
  repoRoot = path.resolve(import.meta.dirname, '..'),
  seasonId,
} = {}) {
  if (!/^s\d+$/.test(String(seasonId || ''))) {
    throw new Error('Retired-version cleanup requires an explicit --season-id such as s17');
  }
  const resolvedRepoRoot = path.resolve(repoRoot);
  const knowledgeRoot = path.join(resolvedRepoRoot, KNOWLEDGE_ROOT);
  const rootManifest = await readJson(path.join(knowledgeRoot, 'manifest.json'));
  const expectedRelativePath = archiveRelativePath(seasonId);
  const registeredRelativePath = rootManifest.season_archives?.[seasonId];
  if (!registeredRelativePath) {
    throw new Error(`Refusing retired-version cleanup because ${seasonId} has no registered archive manifest`);
  }
  if (registeredRelativePath !== expectedRelativePath) {
    throw new Error(`Refusing retired-version cleanup because ${seasonId} archive is not registered at ${expectedRelativePath}`);
  }

  const archiveFile = path.resolve(knowledgeRoot, registeredRelativePath);
  const relativeArchiveFile = path.relative(knowledgeRoot, archiveFile);
  if (!relativeArchiveFile || relativeArchiveFile.startsWith('..') || path.isAbsolute(relativeArchiveFile)) {
    throw new Error(`Refusing retired-version cleanup because ${seasonId} archive escapes the game-knowledge root`);
  }
  const archiveBytes = await readFile(archiveFile);
  const archive = JSON.parse(archiveBytes.toString('utf8'));
  if (
    archive?.schema !== SCHEMA
    || archive.season_id !== seasonId
    || archive.status !== 'frozen_read_only_in_place'
    || archive.identity_policy?.local_season_id !== seasonId
    || archive.archive_policy?.source_updates_allowed !== false
    || archive.archive_policy?.physical_relocation_allowed !== false
    || archive.archive_policy?.excluded_from_new_default_compilation !== true
    || !/^[a-f0-9]{64}$/.test(String(archive.final_core_profile_id || ''))
    || !Array.isArray(archive.generated_core_profiles)
    || !archive.generated_core_profiles.some((profile) => profile?.core_profile_id === archive.final_core_profile_id)
  ) {
    throw new Error(`Refusing retired-version cleanup because the registered ${seasonId} archive manifest identity is invalid`);
  }
  const expectedDescriptor = rootManifest.season_descriptors?.[seasonId];
  if (!expectedDescriptor || archive.descriptor?.path !== path.posix.join(KNOWLEDGE_ROOT, expectedDescriptor)) {
    throw new Error(`Refusing retired-version cleanup because the registered ${seasonId} archive descriptor identity is invalid`);
  }

  const active = await readOptionalJson(path.join(knowledgeRoot, 'active-profile.json'));
  if (active?.season_id === seasonId || active?.runtime_identity?.season_id === seasonId) {
    throw new Error(`Refusing retired-version cleanup because ${seasonId} is the active season`);
  }
  const candidate = await readOptionalJson(path.join(knowledgeRoot, 'candidates', 'candidate-profile.json'));
  if (candidate?.season_id === seasonId || candidate?.runtime_identity?.season_id === seasonId) {
    throw new Error(`Refusing retired-version cleanup because ${seasonId} is the candidate season`);
  }

  return {
    season_id: seasonId,
    archive_file: archiveFile,
    archive_relative_path: path.posix.join(KNOWLEDGE_ROOT, registeredRelativePath),
    archive_manifest_sha256: sha256(archiveBytes),
    final_core_profile_id: archive.final_core_profile_id,
  };
}

async function artifact(repoRoot, relativePath, role) {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  const bytes = await readFile(path.join(repoRoot, normalizedPath));
  return {
    role,
    path: normalizedPath,
    sha256: sha256(bytes),
    byte_size: bytes.byteLength,
  };
}

async function filesUnder(root, relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relativePath = path.posix.join(relativeRoot.replaceAll('\\', '/'), entry.name);
    return entry.isDirectory() ? filesUnder(root, relativePath) : [relativePath];
  }));
  return nested.flat().sort();
}

async function directoryFingerprint(repoRoot, relativeRoot) {
  const normalizedRoot = relativeRoot.replaceAll('\\', '/').replace(/\/$/, '');
  const files = await filesUnder(repoRoot, normalizedRoot);
  const digest = createHash('sha256');
  let totalBytes = 0;
  for (const file of files) {
    const bytes = await readFile(path.join(repoRoot, file));
    const relativeFile = path.posix.relative(normalizedRoot, file);
    const fileHash = sha256(bytes);
    totalBytes += bytes.byteLength;
    digest.update(`${relativeFile}\0${bytes.byteLength}\0${fileHash}\n`);
  }
  return {
    path: normalizedRoot,
    file_count: files.length,
    total_bytes: totalBytes,
    tree_sha256: digest.digest('hex'),
  };
}

async function generatedCoreProfiles(repoRoot, seasonId) {
  const generatedRoot = path.join(repoRoot, 'data/game-knowledge/jcc/generated');
  const entries = await readdir(generatedRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const bundleFile = path.join(generatedRoot, entry.name, 'bundle.json');
    try {
      const bundle = await readJson(bundleFile);
      if (bundle?.profile?.season_id === seasonId) {
        const relativeRoot = path.relative(repoRoot, path.dirname(bundleFile)).replaceAll('\\', '/');
        results.push({
          core_profile_id: entry.name,
          patch_id: bundle.profile.patch_id,
          bundle_path: path.relative(repoRoot, bundleFile).replaceAll('\\', '/'),
          physical_tree: await directoryFingerprint(repoRoot, relativeRoot),
        });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return results.sort((left, right) => left.core_profile_id.localeCompare(right.core_profile_id));
}

async function rankingGenerations(repoRoot, seasonId) {
  const generationsRoot = path.join(repoRoot, 'data/live-rankings/jcc/generations');
  const entries = await readdir(generationsRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestFile = path.join(generationsRoot, entry.name, 'manifest.json');
    try {
      const manifest = await readJson(manifestFile);
      const identity = manifest?.runtime_identity ?? manifest?.source_identity ?? manifest;
      if (identity?.season_id === seasonId || identity?.runtime_season_id === seasonId || manifest?.season_id === seasonId) {
        const relativeRoot = path.relative(repoRoot, path.dirname(manifestFile)).replaceAll('\\', '/');
        results.push({
          generation_id: entry.name,
          core_profile_id: manifest.core_profile_id ?? identity.core_profile_id ?? null,
          manifest_path: path.relative(repoRoot, manifestFile).replaceAll('\\', '/'),
          physical_tree: await directoryFingerprint(repoRoot, relativeRoot),
        });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return results.sort((left, right) => left.generation_id.localeCompare(right.generation_id));
}

async function corePackages(repoRoot, seasonNumber) {
  const packagesRoot = path.join(repoRoot, 'data/core-patches/jcc');
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.posix.join('data/core-patches/jcc', entry.name, 'manifest.json');
    try {
      const manifest = await readJson(path.join(repoRoot, manifestPath));
      if (String(manifest.mode) !== seasonNumber) continue;
      const hardDataPath = path.posix.join('data/core-patches/jcc', entry.name, 'hard-data-manifest.json');
      packages.push({
        package_id: manifest.packageId,
        manifest: await artifact(repoRoot, manifestPath, 'core_package_manifest'),
        hard_data_manifest: await artifact(repoRoot, hardDataPath, 'hard_data_manifest'),
        physical_tree: await directoryFingerprint(repoRoot, path.posix.join('data/core-patches/jcc', entry.name)),
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return packages.sort((left, right) => left.package_id.localeCompare(right.package_id));
}

export async function buildSeasonArchive({ repoRoot = path.resolve(import.meta.dirname, '..'), seasonId, finalCoreProfileId = null }) {
  if (!/^s\d+$/.test(String(seasonId || ''))) throw new Error('A valid --season such as s17 is required');
  const knowledgeRoot = path.join(repoRoot, 'data/game-knowledge/jcc');
  const rootManifest = await readJson(path.join(knowledgeRoot, 'manifest.json'));
  const descriptorRelative = rootManifest.season_descriptors?.[seasonId];
  if (!descriptorRelative) throw new Error(`No registered season descriptor for ${seasonId}`);
  const descriptorPath = path.posix.join('data/game-knowledge/jcc', descriptorRelative);
  const descriptor = await readJson(path.join(repoRoot, descriptorPath));
  if (!finalCoreProfileId) {
    const active = await readJson(path.join(knowledgeRoot, 'active-profile.json'));
    if (active.season_id !== seasonId) {
      throw new Error(`Archiving inactive season ${seasonId} requires --final-core-profile-id`);
    }
    finalCoreProfileId = active.core_profile_id;
  }
  if (!/^[a-f0-9]{64}$/.test(String(finalCoreProfileId || ''))) throw new Error('Archive final Core Profile id must be a lowercase SHA-256 value');
  const patchEntries = [];
  for (const [patchId, patchRelative] of Object.entries(rootManifest.patch_manifests ?? {})) {
    const patchPath = path.posix.join('data/game-knowledge/jcc', patchRelative);
    const patch = await readJson(path.join(repoRoot, patchPath));
    if (patch.season_id === seasonId) patchEntries.push({ patch_id: patchId, artifact: await artifact(repoRoot, patchPath, 'patch_source_manifest') });
  }
  const seasonPatchRoot = `data/game-knowledge/jcc/seasons/${seasonId}/patches`;
  const patchManifestPaths = new Set(patchEntries.map((entry) => entry.artifact.path));
  const seasonPatchFiles = (await filesUnder(repoRoot, seasonPatchRoot).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  })).filter((file) => !patchManifestPaths.has(file));
  const sourceAssets = [
    await artifact(repoRoot, descriptorPath, 'season_descriptor'),
    ...patchEntries.map((entry) => entry.artifact),
    ...await Promise.all(seasonPatchFiles.map((file) => artifact(repoRoot, file, 'season_patch_asset'))),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const seasonCoreProfiles = await generatedCoreProfiles(repoRoot, seasonId);
  const finalCoreProfiles = seasonCoreProfiles.filter((profile) => profile.core_profile_id === finalCoreProfileId);
  if (finalCoreProfiles.length !== 1) throw new Error(`Final Core Profile ${finalCoreProfileId} is not an immutable ${seasonId} generation`);
  const finalRankingGenerations = (await rankingGenerations(repoRoot, seasonId))
    .filter((generation) => generation.core_profile_id === finalCoreProfileId);
  return stableValue({
    schema: SCHEMA,
    season_id: seasonId,
    status: 'frozen_read_only_in_place',
    archive_policy: {
      physical_relocation_allowed: false,
      source_updates_allowed: false,
      retained_for_active_last_known_good_and_rollback: true,
      excluded_from_new_default_compilation: true,
    },
    identity_policy: {
      local_season_id: seasonId,
      upstream_identity_is_provenance_only: true,
    },
    descriptor: {
      logical_id: descriptor.logical_id,
      path: descriptorPath,
    },
    final_core_profile_id: finalCoreProfileId,
    patches: patchEntries.map(({ patch_id, artifact: patchArtifact }) => ({ patch_id, path: patchArtifact.path })),
    source_assets: sourceAssets,
    core_packages: await corePackages(repoRoot, seasonId.slice(1)),
    generated_core_profiles: finalCoreProfiles,
    ranking_generations: finalRankingGenerations,
    retention_reference_policy: [
      'active Core Profile',
      'candidate Core Profile',
      'active ranking generation',
      'retained previous generation',
      'generation lease'
    ],
  });
}

export async function archiveSeason({ repoRoot, seasonId, finalCoreProfileId, outputFile, write = false }) {
  const archive = await buildSeasonArchive({ repoRoot, seasonId, finalCoreProfileId });
  const resolvedRepoRoot = path.resolve(repoRoot ?? path.resolve(import.meta.dirname, '..'));
  const knowledgeRoot = path.join(resolvedRepoRoot, KNOWLEDGE_ROOT);
  const registeredRelativePath = archiveRelativePath(seasonId);
  const registeredTarget = path.join(knowledgeRoot, registeredRelativePath);
  const target = path.resolve(outputFile ?? registeredTarget);
  const serialized = `${JSON.stringify(archive, null, 2)}\n`;
  if (write) {
    if (target !== path.resolve(registeredTarget)) {
      throw new Error(`Archive --write output must use the registered path ${registeredRelativePath}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, serialized);

    const rootManifestFile = path.join(knowledgeRoot, 'manifest.json');
    const rootManifest = await readJson(rootManifestFile);
    const currentRegistration = rootManifest.season_archives?.[seasonId];
    if (currentRegistration !== registeredRelativePath) {
      const updatedManifest = {
        ...rootManifest,
        season_archives: {
          ...(rootManifest.season_archives ?? {}),
          [seasonId]: registeredRelativePath,
        },
      };
      await writeAtomic(rootManifestFile, `${JSON.stringify(updatedManifest, null, 2)}\n`);
    }
  }
  return { archive, outputFile: target, registeredRelativePath, serialized };
}

function parseArgs(argv) {
  const options = { write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--write') options.write = true;
    else if (token === '--season') options.seasonId = argv[++index];
    else if (token === '--final-core-profile-id') options.finalCoreProfileId = argv[++index];
    else if (token === '--repo-root') options.repoRoot = path.resolve(argv[++index]);
    else if (token === '--output') options.outputFile = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

async function main() {
  const result = await archiveSeason(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ ok: true, season_id: result.archive.season_id, status: result.archive.status, output_file: result.outputFile, written: process.argv.includes('--write') })}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
