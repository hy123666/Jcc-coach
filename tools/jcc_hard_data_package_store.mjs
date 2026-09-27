import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const GENERATION_ID_PATTERN = /^[a-f0-9]{64}$/;
const PACKAGE_ROLES = Object.freeze({
  hard_data_manifest: 'manifest.json',
  hard_data_content_manifest: 'hard-data-manifest.json',
  augment_stage_authority: 'indexes/augment_stage_authority.json',
  supplemental_source_audit: 'indexes/supplemental_source_audit.json',
  trait_diversity_roster_support: 'normalized/trait_diversity_roster_support.json',
  runtime_catalog_overlay: 'runtime-catalog-overlay.json',
});
const REQUIRED_PACKAGE_ROLES = Object.freeze([
  'hard_data_manifest',
  'hard_data_content_manifest',
  'augment_stage_authority',
  'supplemental_source_audit',
  'runtime_catalog_overlay',
]);
const LIFECYCLE_LOCK_FILE = '.hard-data-lifecycle.lock';
const STALE_LOCK_MAX_AGE_MS = 10 * 60 * 1000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function repoRelative(repoRoot, file) {
  return path.relative(repoRoot, file).replaceAll('\\', '/');
}

async function treeFingerprint(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const rows = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) rows.push(...await treeFingerprint(root, child));
    else if (entry.isFile()) {
      const bytes = await readFile(path.join(root, child));
      rows.push({ path: child.replaceAll('\\', '/'), bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  return rows;
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function reclaimAbandonedLifecycleLock(lockFile) {
  let metadata = null;
  let lockStat = null;
  try {
    const [raw, currentStat] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)]);
    lockStat = currentStat;
    metadata = JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
  }
  const acquiredAt = Date.parse(metadata?.acquired_at || '');
  const ageMs = Number.isFinite(acquiredAt)
    ? Date.now() - acquiredAt
    : Date.now() - Number(lockStat?.mtimeMs || Date.now());
  const ownerPid = Number(metadata?.pid);
  if (processIsAlive(ownerPid)) return false;
  if (!Number.isSafeInteger(ownerPid) && ageMs < STALE_LOCK_MAX_AGE_MS) return false;
  try {
    await unlink(lockFile);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
}

async function withHardDataLifecycleLock(repoRoot, operation) {
  const managedRoot = path.resolve(repoRoot, 'data/core-patches/jcc');
  await mkdir(managedRoot, { recursive: true });
  const lockFile = path.join(managedRoot, LIFECYCLE_LOCK_FILE);
  let handle = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      handle = await open(lockFile, 'wx');
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, 'utf8');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await reclaimAbandonedLifecycleLock(lockFile);
      await delay(25);
    }
  }
  if (!handle) throw new Error('timed out waiting for the hard-data publication lifecycle lock');
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockFile).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  }
}

function generationIdFromPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  const match = normalized.match(/(?:^|\/)data\/core-patches\/jcc\/generations\/([a-f0-9]{64})(?:\/|$)/);
  return match?.[1] || null;
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function collectFiles(root, fileName) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(child, fileName));
    else if (entry.isFile() && entry.name === fileName) files.push(child);
  }
  return files;
}

async function referencedHardDataGenerationIds(repoRoot) {
  const referenced = new Set();
  const knowledgeRoot = path.join(repoRoot, 'data/game-knowledge/jcc');
  const generatedRoot = path.join(knowledgeRoot, 'generated');
  for (const bundleFile of await collectFiles(generatedRoot, 'bundle.json')) {
    const bundle = await readJsonIfExists(bundleFile);
    const id = generationIdFromPath(bundle?.runtime_identity?.hard_data_manifest);
    if (id) referenced.add(id);
  }
  const seasonsRoot = path.join(knowledgeRoot, 'seasons');
  for (const manifestFile of await collectFiles(seasonsRoot, 'source-manifest.json')) {
    const manifest = await readJsonIfExists(manifestFile);
    for (const artifact of manifest?.source_artifacts || []) {
      const id = generationIdFromPath(artifact?.path);
      if (id) referenced.add(id);
    }
    const candidateId = String(manifest?.hard_data_candidate?.generation_id || '');
    if (GENERATION_ID_PATTERN.test(candidateId)) referenced.add(candidateId);
    const inheritedId = String(manifest?.hard_data_inheritance?.generation_id || '');
    if (GENERATION_ID_PATTERN.test(inheritedId)) referenced.add(inheritedId);
  }
  return referenced;
}

async function publishImmutableHardDataGenerationUnlocked({ repoRoot, stagingDir, generationId }) {
  if (!GENERATION_ID_PATTERN.test(String(generationId || ''))) throw new Error('hard-data generation id must be a lowercase SHA-256 value');
  const managedRoot = path.resolve(repoRoot, 'data/core-patches/jcc');
  const generationsRoot = path.join(managedRoot, 'generations');
  const source = path.resolve(stagingDir);
  const relativeSource = path.relative(managedRoot, source);
  if (!relativeSource || relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) {
    throw new Error('hard-data staging directory must stay inside data/core-patches/jcc');
  }
  const target = path.join(generationsRoot, generationId);
  await mkdir(generationsRoot, { recursive: true });
  let existing = false;
  try {
    existing = (await stat(target)).isDirectory();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing) {
    const [sourceTree, targetTree] = await Promise.all([treeFingerprint(source), treeFingerprint(target)]);
    if (JSON.stringify(sourceTree) !== JSON.stringify(targetTree)) {
      throw new Error(`hard-data generation collision for ${generationId}`);
    }
    await rm(source, { recursive: true, force: true });
  } else {
    await rename(source, target);
  }
  const sourceArtifacts = {};
  for (const [role, relativePath] of Object.entries(PACKAGE_ROLES)) {
    const artifactFile = path.join(target, ...relativePath.split('/'));
    try {
      if ((await stat(artifactFile)).isFile()) sourceArtifacts[role] = repoRelative(repoRoot, artifactFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return {
    generation_id: generationId,
    generation_dir: target,
    generation_dir_relative: repoRelative(repoRoot, target),
    source_artifacts: sourceArtifacts,
  };
}

export async function publishImmutableHardDataGeneration(options) {
  return withHardDataLifecycleLock(options.repoRoot, () => publishImmutableHardDataGenerationUnlocked(options));
}

async function pointPatchManifestAtHardDataGenerationUnlocked({ repoRoot, patchManifestFile, publication }) {
  const file = path.resolve(patchManifestFile);
  const patch = JSON.parse(await readFile(file, 'utf8'));
  const requiredRoles = new Set(REQUIRED_PACKAGE_ROLES);
  const seen = new Set();
  patch.source_artifacts = (patch.source_artifacts || []).map((artifact) => {
    const nextPath = publication.source_artifacts?.[artifact.role];
    if (!nextPath) return artifact;
    seen.add(artifact.role);
    return { ...artifact, path: nextPath };
  });
  const missing = [...requiredRoles].filter((role) => !seen.has(role));
  if (missing.length) throw new Error(`patch source manifest is missing hard-data roles: ${missing.join(', ')}`);
  patch.hard_data_candidate = {
    schema: 'jcc-hard-data-candidate-reference-v1',
    generation_id: publication.generation_id,
    generation_dir: publication.generation_dir_relative,
    immutable: true,
  };
  if (patch.runtime_mapping_validation) {
    patch.runtime_mapping_validation.catalog_overlay = publication.source_artifacts.runtime_catalog_overlay;
  }
  await writeJsonAtomic(file, patch);
  return patch;
}

export async function pointPatchManifestAtHardDataGeneration(options) {
  return withHardDataLifecycleLock(options.repoRoot, () => pointPatchManifestAtHardDataGenerationUnlocked(options));
}

export async function publishAndPointPatchHardDataCandidate({ repoRoot, stagingDir, generationId, patchManifestFile }) {
  return withHardDataLifecycleLock(repoRoot, async () => {
    const publication = await publishImmutableHardDataGenerationUnlocked({ repoRoot, stagingDir, generationId });
    await pointPatchManifestAtHardDataGenerationUnlocked({ repoRoot, patchManifestFile, publication });
    const pointedManifest = JSON.parse(await readFile(path.join(publication.generation_dir, 'manifest.json'), 'utf8'));
    if (pointedManifest?.hard_data_generation_id !== publication.generation_id || pointedManifest?.immutable !== true) {
      throw new Error(`published hard-data candidate failed final generation validation: ${publication.generation_id}`);
    }
    return publication;
  });
}

async function pruneHardDataGenerationsUnlocked({ repoRoot } = {}) {
  const root = path.resolve(repoRoot || '.');
  const generationsRoot = path.join(root, 'data/core-patches/jcc/generations');
  const referenced = await referencedHardDataGenerationIds(root);
  let entries;
  try {
    entries = await readdir(generationsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: [], retained: [] };
    throw error;
  }
  const retained = [];
  const removed = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !GENERATION_ID_PATTERN.test(entry.name)) continue;
    const generationDir = path.join(generationsRoot, entry.name);
    if (referenced.has(entry.name)) {
      retained.push(entry.name);
      continue;
    }
    await rm(generationDir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return { removed, retained };
}

export async function pruneHardDataGenerations(options = {}) {
  const root = path.resolve(options.repoRoot || '.');
  return withHardDataLifecycleLock(root, () => pruneHardDataGenerationsUnlocked({ ...options, repoRoot: root }));
}

export const HARD_DATA_PACKAGE_ROLES = PACKAGE_ROLES;
