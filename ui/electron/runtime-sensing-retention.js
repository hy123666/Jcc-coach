import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

function finiteOption(value, fallback, minimum, label) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(resolved) || resolved < minimum) {
    throw new Error(`${label} must be a finite number >= ${minimum}`);
  }
  return resolved;
}

function containedEntry(root, name) {
  const candidate = path.resolve(root, name);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`sensing retention candidate escapes root: ${name}`);
  }
  return candidate;
}

async function artifactSize(target, isDirectory) {
  if (!isDirectory) return (await stat(target).catch(() => null))?.size || 0;
  const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
  const sizes = await Promise.all(entries.map(async (entry) => {
    const child = containedEntry(target, entry.name);
    return artifactSize(child, entry.isDirectory());
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

export async function pruneRuntimeSensingArtifactDirectory(directory, options = {}) {
  const root = path.resolve(directory);
  const maxEntries = finiteOption(options.maxEntries ?? options.maxFiles, 64, 1, "maxEntries");
  const maxAgeMs = finiteOption(options.maxAgeMs, 6 * 60 * 60 * 1000, 1000, "maxAgeMs");
  const maxBytes = options.maxBytes === undefined
    ? Number.POSITIVE_INFINITY
    : finiteOption(options.maxBytes, 64 * 1024 * 1024, 1, "maxBytes");
  const maxEntryBytes = options.maxEntryBytes === undefined
    ? Number.POSITIVE_INFINITY
    : finiteOption(options.maxEntryBytes, maxBytes, 1, "maxEntryBytes");
  const now = finiteOption(options.now, Date.now(), 0, "now");
  const protectedPaths = new Set((options.protectedPaths || []).map((entry) => path.resolve(entry)));
  const dirEntries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const entries = (await Promise.all(dirEntries.map(async (entry) => {
    const target = containedEntry(root, entry.name);
    const info = await stat(target).catch(() => null);
    if (!info) return null;
    return {
      target,
      name: entry.name,
      mtimeMs: info.mtimeMs,
      isDirectory: entry.isDirectory(),
      size: await artifactSize(target, entry.isDirectory()),
    };
  })))
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  const removed = [];
  const failed = [];
  let retainedBytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const protectedEntry = protectedPaths.has(entry.target);
    const withinBudget = index < maxEntries
      && now - entry.mtimeMs <= maxAgeMs
      && entry.size <= maxEntryBytes
      && retainedBytes + entry.size <= maxBytes;
    if (protectedEntry || withinBudget) {
      retainedBytes += entry.size;
      continue;
    }
    try {
      await rm(entry.target, { recursive: entry.isDirectory, force: true });
      removed.push(entry.target);
    } catch (error) {
      failed.push({ path: entry.target, error: error?.message || String(error) });
    }
  }
  return {
    scanned: entries.length,
    retained: entries.length - removed.length,
    scanned_bytes: entries.reduce((total, entry) => total + entry.size, 0),
    retained_bytes: retainedBytes,
    max_bytes: Number.isFinite(maxBytes) ? maxBytes : null,
    max_entry_bytes: Number.isFinite(maxEntryBytes) ? maxEntryBytes : null,
    removed,
    failed,
  };
}
