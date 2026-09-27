import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { retryTransientFileOperation } from "./jcc_transient_file_operations.mjs";

export const ACTIVE_GENERATION_POINTER = "active-generation.json";
export const GENERATIONS_DIRECTORY = "generations";
export const REFRESH_LEASE_DIRECTORY = ".refresh-lease";
export const GENERATION_METADATA_FILE = "_generation.json";
export const GENERATION_SCHEMA = "jcc-live-ranking-generation-v1";
export const POINTER_SCHEMA = "jcc-live-ranking-active-generation-v1";
export const LEASE_SCHEMA = "jcc-live-ranking-refresh-lease-v1";
export const DEFAULT_PREVIOUS_GENERATIONS_TO_KEEP = 2;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STAT_DATE_PATTERN = /^\d{8}$/;
const GENERATION_ID_PATTERN = /^\d{8}-[a-f0-9]{24}$/;
const TEMP_GENERATION_PREFIX = ".tmp-generation-";
const TEMP_POINTER_PREFIX = ".tmp-active-generation-";
const STALE_LEASE_PREFIX = ".stale-refresh-lease-";
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const INCOMPLETE_LEASE_GRACE_MS = 10 * 1000;

function normalizeBinding(binding) {
  if (!binding) throw new Error("live-ranking binding requires an exact Core identity");
  const normalized = {
    core_profile_id: String(binding.core_profile_id || ""),
    season_id: String(binding.season_id || ""),
    patch_id: String(binding.patch_id || ""),
    catalog_fingerprint: String(binding.catalog_fingerprint || binding.catalog_source_fingerprint || ""),
    hard_data_manifest_fingerprint: String(binding.hard_data_manifest_fingerprint || ""),
  };
  if (!SHA256_PATTERN.test(normalized.core_profile_id)) throw new Error("live-ranking binding requires a valid Core Profile id");
  if (!normalized.season_id || !normalized.patch_id) throw new Error("live-ranking binding requires season and patch identities");
  if (!SHA256_PATTERN.test(normalized.catalog_fingerprint)) throw new Error("live-ranking binding requires a catalog fingerprint");
  if (!SHA256_PATTERN.test(normalized.hard_data_manifest_fingerprint)) throw new Error("live-ranking binding requires a hard-data manifest fingerprint");
  return normalized;
}

function sameBinding(left, right) {
  return JSON.stringify(normalizeBinding(left)) === JSON.stringify(normalizeBinding(right));
}

export function liveRankingBindingFromSourceIdentity(source = {}) {
  return normalizeBinding({
    core_profile_id: source.core_profile_id,
    season_id: source.runtime_season_id || source.season_id,
    patch_id: source.active_patch_id || source.patch_id,
    catalog_fingerprint: source.catalog_source_fingerprint || source.catalog_fingerprint,
    hard_data_manifest_fingerprint: source.hard_data_manifest_fingerprint,
  });
}

function storePaths(rootDir) {
  const root = path.resolve(rootDir);
  return {
    root,
    generations: path.join(root, GENERATIONS_DIRECTORY),
    pointer: path.join(root, ACTIVE_GENERATION_POINTER),
    lease: path.join(root, REFRESH_LEASE_DIRECTORY),
  };
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function normalizeArtifactPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")) {
    throw new Error(`invalid live-ranking artifact path: ${String(value)}`);
  }
  if (path.posix.isAbsolute(value) || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`live-ranking artifact path must be a normalized relative path: ${value}`);
  }
  if (value === GENERATION_METADATA_FILE) {
    throw new Error(`${GENERATION_METADATA_FILE} is reserved for generation metadata`);
  }
  return value;
}

function normalizeArtifacts(artifacts) {
  const rows = Array.isArray(artifacts)
    ? artifacts
    : Object.entries(artifacts || {}).map(([artifactPath, sha256]) => ({ path: artifactPath, sha256 }));
  if (rows.length === 0) throw new Error("complete live-ranking artifact set must not be empty");

  const seen = new Set();
  const normalized = rows.map((row) => {
    const artifactPath = normalizeArtifactPath(row?.path);
    const collisionKey = process.platform === "win32" ? artifactPath.toLowerCase() : artifactPath;
    if (seen.has(collisionKey)) throw new Error(`duplicate live-ranking artifact path: ${artifactPath}`);
    seen.add(collisionKey);
    const sha256 = String(row?.sha256 || "").toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) throw new Error(`invalid SHA-256 for live-ranking artifact ${artifactPath}`);
    return { path: artifactPath, sha256 };
  });
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function canonicalGenerationDigest(statDate, artifacts, binding) {
  const canonical = `${statDate}\n${JSON.stringify(normalizeBinding(binding))}\n${artifacts.map((entry) => `${entry.path}\0${entry.sha256}`).join("\n")}\n`;
  return createHash("sha256").update(canonical).digest("hex");
}

function pointerForGeneration(verified, publishedAt = new Date().toISOString()) {
  return {
    schema: POINTER_SCHEMA,
    generation_id: verified.generation_id,
    stat_date: verified.metadata.stat_date,
    content_sha256: verified.content_sha256,
    ...normalizeBinding(verified.metadata),
    published_at: publishedAt,
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonSynced(filePath, value) {
  await retryTransientFileOperation(async () => {
    let handle = null;
    let created = false;
    try {
      handle = await open(filePath, "wx");
      created = true;
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if (created) await rm(filePath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  });
}

async function syncFile(filePath) {
  await retryTransientFileOperation(async () => {
    const handle = await open(filePath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

async function assertPlainDirectory(directory, label) {
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory: ${directory}`);
}

async function assertPlainFile(filePath, root, label) {
  if (!isInside(root, filePath)) throw new Error(`${label} escaped its root: ${filePath}`);
  const info = await lstat(filePath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink regular file: ${filePath}`);
  const resolvedRoot = await realpath(root);
  const resolvedFile = await realpath(filePath);
  if (!isInside(resolvedRoot, resolvedFile)) throw new Error(`${label} resolved outside its root: ${filePath}`);
}

async function listCandidateArtifacts(directory, prefix = "", options = {}) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(directory, entry.name);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new Error(`candidate artifact tree contains a symlink: ${relativePath}`);
    if (info.isDirectory()) result.push(...await listCandidateArtifacts(fullPath, relativePath, options));
    else if (info.isFile()) {
      if (options.allowGenerationMetadata && relativePath === GENERATION_METADATA_FILE) result.push(relativePath);
      else result.push(normalizeArtifactPath(relativePath));
    }
    else throw new Error(`candidate artifact tree contains a non-regular entry: ${relativePath}`);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

export async function sha256File(filePath) {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function validateArtifactDirectory(directory, artifacts, label) {
  await assertPlainDirectory(directory, label);
  const actualPaths = await listCandidateArtifacts(directory);
  const expectedPaths = artifacts.map((entry) => entry.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`${label} does not match the caller-provided complete artifact set`);
  }
  for (const artifact of artifacts) {
    const filePath = path.resolve(directory, ...artifact.path.split("/"));
    await assertPlainFile(filePath, directory, `${label} artifact ${artifact.path}`);
    const actualHash = await sha256File(filePath);
    if (actualHash !== artifact.sha256) throw new Error(`${label} artifact hash mismatch: ${artifact.path}`);
  }
}

async function cleanupStoreTemps(paths) {
  const rootEntries = await readdir(paths.root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of rootEntries) {
    if (!entry.name.startsWith(TEMP_POINTER_PREFIX) && !entry.name.startsWith(STALE_LEASE_PREFIX)) continue;
    await rm(path.join(paths.root, entry.name), { recursive: true, force: true });
  }
  const generationEntries = await readdir(paths.generations, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of generationEntries) {
    if (entry.name.startsWith(TEMP_GENERATION_PREFIX)) {
      await rm(path.join(paths.generations, entry.name), { recursive: true, force: true });
    }
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function staleLeaseReason(leaseDir, now) {
  const ownerPath = path.join(leaseDir, "owner.json");
  const owner = await readJson(ownerPath).catch(() => null);
  if (!owner) {
    const leaseStat = await stat(leaseDir);
    return now - leaseStat.mtimeMs > INCOMPLETE_LEASE_GRACE_MS ? "unreadable_owner" : null;
  }
  if (owner.schema !== LEASE_SCHEMA) return null;
  if (owner.hostname !== os.hostname()) return null;
  if (!processExists(Number(owner.pid))) return "dead_local_owner";
  return null;
}

async function assertLeaseOwnership(paths, leaseId) {
  const owner = await readJson(path.join(paths.lease, "owner.json")).catch(() => null);
  if (owner?.lease_id !== leaseId) throw new Error("live-ranking refresh lease ownership was lost");
  if (owner.hostname !== os.hostname() || Number(owner.pid) !== process.pid) {
    throw new Error("live-ranking refresh lease owner process identity changed");
  }
  return owner;
}

export async function acquireLiveRankingRefreshLease(options) {
  const paths = storePaths(options.rootDir);
  const leaseMs = Number.isFinite(Number(options.leaseMs)) && Number(options.leaseMs) >= 1000
    ? Number(options.leaseMs)
    : DEFAULT_LEASE_MS;
  await mkdir(paths.root, { recursive: true });
  await assertPlainDirectory(paths.root, "live-ranking store root");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const leaseId = randomUUID();
    try {
      await mkdir(paths.lease);
      const now = Date.now();
      const owner = {
        schema: LEASE_SCHEMA,
        lease_id: leaseId,
        pid: process.pid,
        hostname: os.hostname(),
        acquired_at: new Date(now).toISOString(),
        expires_at: new Date(now + leaseMs).toISOString(),
      };
      try {
        await writeJsonSynced(path.join(paths.lease, "owner.json"), owner);
      } catch (error) {
        await rm(paths.lease, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      let released = false;
      return {
        leaseId,
        rootDir: paths.root,
        owner,
        async assertOwnership() {
          if (released) throw new Error("live-ranking refresh lease was already released");
          return assertLeaseOwnership(paths, leaseId);
        },
        async renew(durationMs = leaseMs) {
          if (released) throw new Error("live-ranking refresh lease was already released");
          const current = await assertLeaseOwnership(paths, leaseId);
          const renewed = { ...current, expires_at: new Date(Date.now() + Math.max(1000, Number(durationMs) || leaseMs)).toISOString() };
          const temp = path.join(paths.lease, `.owner-${leaseId}.tmp`);
          await writeJsonSynced(temp, renewed);
          await assertLeaseOwnership(paths, leaseId);
          await rename(temp, path.join(paths.lease, "owner.json"));
          return renewed;
        },
        async release() {
          if (released) return;
          released = true;
          const current = await readJson(path.join(paths.lease, "owner.json")).catch(() => null);
          if (current?.lease_id === leaseId) await rm(paths.lease, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const reason = await staleLeaseReason(paths.lease, Date.now()).catch(() => null);
      if (!reason) throw new Error("live-ranking refresh lease is already held by an active publisher");
      const stalePath = path.join(paths.root, `${STALE_LEASE_PREFIX}${Date.now()}-${randomUUID()}`);
      try {
        await rename(paths.lease, stalePath);
        await rm(stalePath, { recursive: true, force: true });
      } catch (recoveryError) {
        if (recoveryError?.code !== "ENOENT") throw recoveryError;
      }
    }
  }
  throw new Error("could not acquire live-ranking refresh lease after stale-owner recovery");
}

async function loadAndValidateGeneration(generationDir, expected = null) {
  await assertPlainDirectory(generationDir, "live-ranking generation");
  const metadataPath = path.join(generationDir, GENERATION_METADATA_FILE);
  await assertPlainFile(metadataPath, generationDir, "live-ranking generation metadata");
  const metadata = await readJson(metadataPath);
  if (metadata.schema !== GENERATION_SCHEMA || !GENERATION_ID_PATTERN.test(String(metadata.generation_id || ""))) {
    throw new Error("live-ranking generation metadata is invalid");
  }
  const binding = normalizeBinding(metadata);
  const artifacts = normalizeArtifacts(metadata.artifacts);
  const digest = canonicalGenerationDigest(metadata.stat_date, artifacts, binding);
  const generationId = `${metadata.stat_date}-${digest.slice(0, 24)}`;
  if (metadata.generation_id !== generationId || metadata.content_sha256 !== digest) {
    throw new Error("live-ranking generation identity does not match its artifact inventory");
  }
  if (expected && (
    expected.generation_id !== generationId
    || expected.stat_date !== metadata.stat_date
    || expected.content_sha256 !== digest
    || !sameBinding(expected, binding)
  )) {
    throw new Error("active-generation pointer does not match immutable generation metadata");
  }
  const actualPaths = await listCandidateArtifacts(generationDir, "", { allowGenerationMetadata: true });
  const expectedPaths = [GENERATION_METADATA_FILE, ...artifacts.map((entry) => entry.path)].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error("immutable live-ranking generation contains an unexpected or missing file");
  for (const artifact of artifacts) {
    const filePath = path.resolve(generationDir, ...artifact.path.split("/"));
    await assertPlainFile(filePath, generationDir, `generation artifact ${artifact.path}`);
    if (await sha256File(filePath) !== artifact.sha256) throw new Error(`immutable generation artifact hash mismatch: ${artifact.path}`);
  }
  return { metadata, artifacts, generation_id: generationId, content_sha256: digest };
}

export async function verifyLiveRankingGeneration(options) {
  const paths = storePaths(options.rootDir);
  const generationId = String(options.generationId || "");
  if (!GENERATION_ID_PATTERN.test(generationId)) throw new Error(`invalid live-ranking generation id: ${generationId}`);
  const generationDir = path.join(paths.generations, generationId);
  return { ...(await loadAndValidateGeneration(generationDir, options.expectedPointer || null)), generation_dir: generationDir };
}

export async function resolveActiveLiveRankingGeneration(options) {
  const paths = storePaths(options.rootDir);
  await assertPlainFile(paths.pointer, paths.root, "active-generation pointer");
  const pointer = await readJson(paths.pointer);
  if (pointer.schema !== POINTER_SCHEMA || !GENERATION_ID_PATTERN.test(String(pointer.generation_id || ""))) {
    throw new Error("active-generation pointer is invalid");
  }
  const verified = await verifyLiveRankingGeneration({
    rootDir: paths.root,
    generationId: pointer.generation_id,
    expectedPointer: pointer,
  });
  return { pointer, ...verified };
}

export async function activateLiveRankingGeneration(options) {
  const paths = storePaths(options.rootDir);
  const verified = await verifyLiveRankingGeneration({
    rootDir: paths.root,
    generationId: options.generationId,
  });
  const lease = options.lease || await acquireLiveRankingRefreshLease({ rootDir: paths.root, leaseMs: options.leaseMs });
  const ownsLease = !options.lease;
  let tempPointer = null;
  try {
    await lease.assertOwnership();
    const pointer = pointerForGeneration(verified);
    tempPointer = path.join(paths.root, `${TEMP_POINTER_PREFIX}${randomUUID()}`);
    await writeJsonSynced(tempPointer, pointer);
    await lease.assertOwnership();
    await rename(tempPointer, paths.pointer);
    tempPointer = null;
    return { ok: true, pointer, generation_dir: verified.generation_dir };
  } finally {
    if (tempPointer) await rm(tempPointer, { force: true }).catch(() => {});
    if (ownsLease) await lease.release();
  }
}

export function resolveLiveRankingGenerationPathSync(options) {
  const paths = storePaths(options.rootDir);
  const generationId = String(options.generationId || "");
  if (!GENERATION_ID_PATTERN.test(generationId)) throw new Error(`invalid live-ranking generation id: ${generationId}`);
  const generationDir = path.join(paths.generations, generationId);
  if (!existsSync(generationDir)) return null;
  const generationInfo = lstatSync(generationDir);
  if (!generationInfo.isDirectory() || generationInfo.isSymbolicLink()) throw new Error("ranking generation must be a non-symlink directory");
  const metadataFile = path.join(generationDir, GENERATION_METADATA_FILE);
  const metadataInfo = lstatSync(metadataFile);
  if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) throw new Error("ranking generation metadata must be a non-symlink file");
  const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  const binding = normalizeBinding(metadata);
  const artifacts = normalizeArtifacts(metadata.artifacts);
  const digest = canonicalGenerationDigest(metadata.stat_date, artifacts, binding);
  if (
    metadata.schema !== GENERATION_SCHEMA
    || metadata.generation_id !== generationId
    || metadata.content_sha256 !== digest
    || generationId !== `${metadata.stat_date}-${digest.slice(0, 24)}`
  ) {
    throw new Error("ranking generation metadata is invalid");
  }
  const actualPaths = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const info = lstatSync(absolutePath);
      if (info.isSymbolicLink()) throw new Error(`immutable ranking generation contains a symlink: ${relativePath}`);
      if (info.isDirectory()) visit(absolutePath, relativePath);
      else if (info.isFile()) actualPaths.push(relativePath);
      else throw new Error(`immutable ranking generation contains an unsupported entry: ${relativePath}`);
    }
  };
  visit(generationDir);
  actualPaths.sort((left, right) => left.localeCompare(right));
  const expectedPaths = [GENERATION_METADATA_FILE, ...artifacts.map((entry) => entry.path)].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("immutable live-ranking generation contains an unexpected or missing file");
  }
  for (const artifact of artifacts) {
    const filePath = path.resolve(generationDir, ...artifact.path.split("/"));
    if (!isInside(generationDir, filePath)) throw new Error(`generation artifact escapes its immutable directory: ${artifact.path}`);
    const info = lstatSync(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`generation artifact must be a non-symlink file: ${artifact.path}`);
    const actualHash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
    if (actualHash !== artifact.sha256) throw new Error(`immutable generation artifact hash mismatch: ${artifact.path}`);
  }
  return { metadata, artifacts, generation_id: generationId, generation_dir: generationDir };
}

export function resolveActiveLiveRankingGenerationPathSync(options) {
  if (options.generationId) {
    return resolveLiveRankingGenerationPathSync(options);
  }
  const paths = storePaths(options.rootDir);
  if (!existsSync(paths.pointer)) return null;
  const pointerInfo = lstatSync(paths.pointer);
  if (!pointerInfo.isFile() || pointerInfo.isSymbolicLink()) throw new Error("active-generation pointer must be a non-symlink file");
  const pointer = JSON.parse(readFileSync(paths.pointer, "utf8"));
  if (pointer.schema !== POINTER_SCHEMA || !GENERATION_ID_PATTERN.test(String(pointer.generation_id || ""))) {
    throw new Error("active-generation pointer is invalid");
  }
  const resolved = resolveLiveRankingGenerationPathSync({ rootDir: paths.root, generationId: pointer.generation_id });
  if (!resolved) throw new Error("active-generation pointer references a missing generation");
  if (
    resolved.metadata.stat_date !== pointer.stat_date
    || resolved.metadata.content_sha256 !== pointer.content_sha256
    || !sameBinding(pointer, resolved.metadata)
  ) {
    throw new Error("active-generation pointer does not match immutable generation metadata");
  }
  return { pointer, ...resolved };
}

export async function publishLiveRankingGeneration(options) {
  const paths = storePaths(options.rootDir);
  const statDate = String(options.statDate || "");
  if (!STAT_DATE_PATTERN.test(statDate)) throw new Error(`live-ranking statDate must be YYYYMMDD, got ${statDate}`);
  const binding = normalizeBinding(options.binding);
  const artifacts = normalizeArtifacts(options.artifacts);
  const candidateDir = path.resolve(options.candidateDir);
  const digest = canonicalGenerationDigest(statDate, artifacts, binding);
  const generationId = `${statDate}-${digest.slice(0, 24)}`;
  const generationDir = path.join(paths.generations, generationId);
  if (options.lease && path.resolve(options.lease.rootDir || "") !== paths.root) {
    throw new Error("live-ranking refresh lease belongs to a different store root");
  }
  const lease = options.lease || await acquireLiveRankingRefreshLease({ rootDir: paths.root, leaseMs: options.leaseMs });
  const ownsLease = !options.lease;
  let tempGeneration = null;
  let tempPointer = null;

  try {
    await lease.assertOwnership();
    await mkdir(paths.generations, { recursive: true });
    await assertPlainDirectory(paths.generations, "live-ranking generations directory");
    await cleanupStoreTemps(paths);
    await validateArtifactDirectory(candidateDir, artifacts, "live-ranking candidate");

    const existing = await lstat(generationDir).catch(() => null);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`generation destination is not a plain directory: ${generationId}`);
      await loadAndValidateGeneration(generationDir, { generation_id: generationId, stat_date: statDate, content_sha256: digest, ...binding });
    } else {
      tempGeneration = path.join(paths.generations, `${TEMP_GENERATION_PREFIX}${generationId}-${randomUUID()}`);
      await mkdir(tempGeneration);
      for (const artifact of artifacts) {
        const source = path.resolve(candidateDir, ...artifact.path.split("/"));
        const destination = path.resolve(tempGeneration, ...artifact.path.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        await retryTransientFileOperation(() => copyFile(source, destination, fsConstants.COPYFILE_EXCL));
        await syncFile(destination);
      }
      const metadata = {
        schema: GENERATION_SCHEMA,
        generation_id: generationId,
        stat_date: statDate,
        content_sha256: digest,
        ...binding,
        artifacts,
      };
      await writeJsonSynced(path.join(tempGeneration, GENERATION_METADATA_FILE), metadata);
      await loadAndValidateGeneration(tempGeneration, { generation_id: generationId, stat_date: statDate, content_sha256: digest, ...binding });
      await lease.assertOwnership();
      await retryTransientFileOperation(() => rename(tempGeneration, generationDir));
      tempGeneration = null;
    }

    const pointer = pointerForGeneration({
      generation_id: generationId,
      content_sha256: digest,
      metadata: { stat_date: statDate, ...binding },
    });
    const activatePointer = options.activatePointer !== false;
    if (activatePointer) {
      await lease.renew();
      await lease.assertOwnership();
      tempPointer = path.join(paths.root, `${TEMP_POINTER_PREFIX}${randomUUID()}`);
      await writeJsonSynced(tempPointer, pointer);
      await lease.assertOwnership();
      await retryTransientFileOperation(() => rename(tempPointer, paths.pointer));
      tempPointer = null;
    }
    return { ok: true, pointer, generation_dir: generationDir, created: !existing, activated: activatePointer };
  } finally {
    if (tempGeneration) await rm(tempGeneration, { recursive: true, force: true }).catch(() => {});
    if (tempPointer) await rm(tempPointer, { force: true }).catch(() => {});
    if (ownsLease) await lease.release();
  }
}

export async function pruneLiveRankingGenerations(options) {
  const paths = storePaths(options.rootDir);
  const keepPrevious = options.keepPrevious === undefined
    ? DEFAULT_PREVIOUS_GENERATIONS_TO_KEEP
    : Number(options.keepPrevious);
  if (!Number.isInteger(keepPrevious) || keepPrevious < 0) throw new Error("keepPrevious must be a non-negative integer");
  const leasedIds = new Set((options.leasedGenerationIds || []).map((value) => String(value)));
  for (const generationId of leasedIds) {
    if (!GENERATION_ID_PATTERN.test(generationId)) throw new Error(`invalid leased live-ranking generation id: ${generationId}`);
  }
  const explicitlyProtectedIds = new Set((options.protectedGenerationIds || []).map((value) => String(value)));
  for (const generationId of explicitlyProtectedIds) {
    if (!GENERATION_ID_PATTERN.test(generationId)) throw new Error(`invalid protected live-ranking generation id: ${generationId}`);
  }
  const validCoreProfileIds = options.validCoreProfileIds === undefined
    ? null
    : new Set((options.validCoreProfileIds || []).map((value) => String(value)));
  for (const coreProfileId of validCoreProfileIds || []) {
    if (!SHA256_PATTERN.test(coreProfileId)) throw new Error(`invalid retained Core Profile id: ${coreProfileId}`);
  }
  const validRecipeGenerationIds = options.validRecipeGenerationIds === undefined
    ? null
    : new Set((options.validRecipeGenerationIds || []).map((value) => String(value)));
  for (const generationId of validRecipeGenerationIds || []) {
    if (!SHA256_PATTERN.test(generationId)) throw new Error(`invalid retained recipe generation id: ${generationId}`);
  }
  if (options.lease && path.resolve(options.lease.rootDir || "") !== paths.root) {
    throw new Error("live-ranking refresh lease belongs to a different store root");
  }
  const lease = options.lease || await acquireLiveRankingRefreshLease({ rootDir: paths.root, leaseMs: options.leaseMs });
  const ownsLease = !options.lease;
  try {
    await lease.assertOwnership();
    const protectedIds = new Set([...leasedIds, ...explicitlyProtectedIds]);
    const activePointer = await readJson(paths.pointer).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (activePointer) {
      if (activePointer.schema !== POINTER_SCHEMA || !GENERATION_ID_PATTERN.test(String(activePointer.generation_id || ""))) {
        throw new Error("active-generation pointer is invalid");
      }
      normalizeBinding(activePointer);
      const activeGeneration = resolveLiveRankingGenerationPathSync({ rootDir: paths.root, generationId: activePointer.generation_id });
      if (!activeGeneration || activeGeneration.metadata.content_sha256 !== activePointer.content_sha256 || !sameBinding(activePointer, activeGeneration.metadata)) {
        throw new Error("active-generation pointer does not match immutable generation metadata");
      }
      protectedIds.add(activePointer.generation_id);
    }

    const candidatesDir = path.join(paths.root, "candidates");
    const candidateEntries = await readdir(candidatesDir, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const candidateIds = new Set();
    const candidateCoreProfileIds = new Set();
    const candidateRecipeGenerationIds = new Set();
    const removedCandidateCoreProfileIds = [];
    const removedBrokenCandidateCoreProfileIds = [];
    for (const entry of candidateEntries) {
      if (entry.isSymbolicLink()) throw new Error(`candidate ranking pointer must not be a symlink: ${entry.name}`);
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const candidateFile = path.join(candidatesDir, entry.name);
      const candidate = await readJson(candidateFile);
      if (candidate.schema !== "jcc-live-ranking-candidate-pointer-v1" || !GENERATION_ID_PATTERN.test(String(candidate.generation_id || ""))) {
        throw new Error(`candidate ranking pointer is invalid: ${entry.name}`);
      }
      const candidateBinding = normalizeBinding(candidate);
      if (validCoreProfileIds && !validCoreProfileIds.has(candidateBinding.core_profile_id)) {
        await lease.assertOwnership();
        await rm(candidateFile, { force: false });
        removedCandidateCoreProfileIds.push(candidateBinding.core_profile_id);
        continue;
      }
      const recipeGenerationId = String(candidate.recipe_generation_id || "");
      if (validRecipeGenerationIds
        && (!SHA256_PATTERN.test(recipeGenerationId) || !validRecipeGenerationIds.has(recipeGenerationId))) {
        await lease.assertOwnership();
        await rm(candidateFile, { force: false });
        removedBrokenCandidateCoreProfileIds.push(candidateBinding.core_profile_id);
        continue;
      }
      const candidateGeneration = resolveLiveRankingGenerationPathSync({ rootDir: paths.root, generationId: candidate.generation_id });
      if (!candidateGeneration || candidateGeneration.metadata.content_sha256 !== candidate.content_sha256 || !sameBinding(candidate, candidateGeneration.metadata)) {
        throw new Error(`candidate ranking pointer does not match immutable generation metadata: ${entry.name}`);
      }
      candidateIds.add(candidate.generation_id);
      candidateCoreProfileIds.add(candidateBinding.core_profile_id);
      if (SHA256_PATTERN.test(recipeGenerationId)) candidateRecipeGenerationIds.add(recipeGenerationId);
      protectedIds.add(candidate.generation_id);
    }

    const generationEntries = await readdir(paths.generations, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of generationEntries) {
      if (GENERATION_ID_PATTERN.test(entry.name) && (!entry.isDirectory() || entry.isSymbolicLink())) {
        throw new Error(`ranking generation must be a non-symlink directory: ${entry.name}`);
      }
    }
    const generationIds = generationEntries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && GENERATION_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
    const generationRecords = generationIds.map((generationId) => {
      const resolved = resolveLiveRankingGenerationPathSync({ rootDir: paths.root, generationId });
      const manifestArtifact = resolved?.artifacts.find((artifact) => artifact.path === "manifest.json");
      let manifest = null;
      if (manifestArtifact) {
        manifest = JSON.parse(readFileSync(path.join(resolved.generation_dir, manifestArtifact.path), "utf8"));
      }
      const managedSemanticGeneration = manifest?.schema_version === 1
        && manifest?.source_identity
        && manifest?.current
        && manifest?.retention_policy;
      return {
        generation_id: generationId,
        current_core: !validCoreProfileIds || validCoreProfileIds.has(resolved?.metadata?.core_profile_id),
        generated_at_ms: Date.parse(manifest?.generated_at || "") || 0,
        retainable_previous: !managedSemanticGeneration
          || ["ready", "degraded"].includes(manifest?.semantic_maintenance?.status),
      };
    }).sort((left, right) => (
      right.generated_at_ms - left.generated_at_ms
      || right.generation_id.localeCompare(left.generation_id)
    ));
    const previousIds = generationRecords
      .filter((record) => record.current_core && record.retainable_previous && !protectedIds.has(record.generation_id))
      .slice(0, keepPrevious)
      .map((record) => record.generation_id);
    for (const generationId of previousIds) protectedIds.add(generationId);
    const deleted = [];
    for (const generationId of generationRecords.map((record) => record.generation_id)) {
      if (protectedIds.has(generationId)) continue;
      await lease.assertOwnership();
      await rm(path.join(paths.generations, generationId), { recursive: true, force: false });
      deleted.push(generationId);
    }
    return {
      ok: true,
      active_generation_id: activePointer?.generation_id || null,
      candidate_generation_ids: [...candidateIds].sort(),
      candidate_core_profile_ids: [...candidateCoreProfileIds].sort(),
      candidate_recipe_generation_ids: [...candidateRecipeGenerationIds].sort(),
      removed_candidate_core_profile_ids: removedCandidateCoreProfileIds.sort(),
      removed_broken_candidate_core_profile_ids: removedBrokenCandidateCoreProfileIds.sort(),
      leased_generation_ids: [...leasedIds].sort(),
      explicitly_protected_generation_ids: [...explicitlyProtectedIds].sort(),
      previous_generation_ids: previousIds,
      retained_generation_ids: generationRecords.map((record) => record.generation_id).filter((id) => protectedIds.has(id)),
      discarded_unfinalized_generation_ids: generationRecords
        .filter((record) => !record.retainable_previous && deleted.includes(record.generation_id))
        .map((record) => record.generation_id),
      deleted_generation_ids: deleted,
    };
  } finally {
    if (ownsLease) await lease.release();
  }
}

export const completeAndPublishLiveRankingGeneration = publishLiveRankingGeneration;
