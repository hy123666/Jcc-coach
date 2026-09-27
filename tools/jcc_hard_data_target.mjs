import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";

const REMOVED_PATCH_DIR_ENV = "JCC_HARD_DATA_PATCH_DIR";

export function activeHardDataPackageDir(repoRoot) {
  return path.dirname(createRuntimePaths(repoRoot).activeHardDataManifest);
}

export function activeHardDataPath(repoRoot, ...parts) {
  return path.join(activeHardDataPackageDir(repoRoot), ...parts);
}

function argumentValue(argv, name) {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be provided only once`);
  if (indexes.length === 0) return null;
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a manifest path`);
  return value;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function hardDataPackageIdentity(managedRoot, manifestPath) {
  const packageDir = path.dirname(manifestPath);
  const relative = path.relative(managedRoot, packageDir).replaceAll('\\', '/');
  const generationMatch = relative.match(/^generations\/([a-f0-9]{64})$/);
  if (generationMatch) return { packageDir, generationId: generationMatch[1], legacyDirectoryPackageId: null };
  if (!relative.includes('/') && relative) return { packageDir, generationId: null, legacyDirectoryPackageId: relative };
  throw new Error(`hard-data manifest must use data/core-patches/jcc/<legacy-package>/manifest.json or generations/<sha256>/manifest.json: ${manifestPath}`);
}

export function resolveHardDataTarget({
  repoRoot,
  activeManifest,
  argv = [],
  env = process.env,
  allowCandidate = false,
}) {
  if (env?.[REMOVED_PATCH_DIR_ENV]) {
    throw new Error(
      `${REMOVED_PATCH_DIR_ENV} is forbidden because it bypasses the active promotion tuple; use --candidate-manifest for an explicit pre-promotion build or verification`,
    );
  }

  const candidateArg = argumentValue(argv, "--candidate-manifest");
  if (candidateArg && !allowCandidate) {
    throw new Error("--candidate-manifest is not allowed for this active-runtime operation");
  }

  const managedRoot = path.resolve(repoRoot, "data/core-patches/jcc");
  const manifestPath = path.resolve(repoRoot, candidateArg || activeManifest);
  if (path.basename(manifestPath) !== "manifest.json") {
    throw new Error(`hard-data target must point to manifest.json: ${manifestPath}`);
  }
  if (!isPathInside(managedRoot, manifestPath)) {
    throw new Error(`hard-data manifest must stay inside ${managedRoot}: ${manifestPath}`);
  }
  const packageIdentity = hardDataPackageIdentity(managedRoot, manifestPath);

  return {
    kind: candidateArg ? "candidate" : "active",
    manifestPath,
    ...packageIdentity,
  };
}

export function validateHardDataManifestIdentity(target, manifest) {
  const packageId = String(manifest?.packageId || "").trim();
  if (!packageId) throw new Error(`hard-data ${target.kind} manifest is missing packageId`);
  if (target.legacyDirectoryPackageId && packageId !== target.legacyDirectoryPackageId) {
    throw new Error(
      `hard-data ${target.kind} manifest packageId must match its legacy directory: expected ${target.legacyDirectoryPackageId}, got ${packageId}`,
    );
  }
  if (target.generationId) {
    if (manifest?.immutable !== true || manifest?.hard_data_generation_id !== target.generationId) {
      throw new Error(`hard-data ${target.kind} generation manifest must be immutable and match directory ${target.generationId}`);
    }
  }
  for (const field of ["mode", "season", "version"]) {
    if (!String(manifest?.[field] || "").trim()) {
      throw new Error(`hard-data ${target.kind} manifest is missing required identity field ${field}`);
    }
  }

  return manifest;
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function validateImmutableGenerationFiles(target, manifest) {
  if (!target.generationId) return;
  const declared = manifest?.hard_data_manifest;
  const contentFile = path.join(target.packageDir, String(declared?.file || "hard-data-manifest.json"));
  const contentBytes = await readFile(contentFile);
  if (contentBytes.length !== declared?.bytes || hash(contentBytes) !== declared?.sha256) {
    throw new Error(`hard-data ${target.kind} generation content manifest failed integrity validation`);
  }
  const content = JSON.parse(contentBytes.toString("utf8"));
  for (const [relativePath, expected] of Object.entries(content?.files || {})) {
    const normalized = path.posix.normalize(relativePath);
    if (normalized !== relativePath || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      throw new Error(`hard-data generation content path escapes package: ${relativePath}`);
    }
    const bytes = await readFile(path.join(target.packageDir, ...normalized.split("/")));
    if (bytes.length !== expected?.bytes || hash(bytes) !== expected?.sha256) {
      throw new Error(`hard-data ${target.kind} generation artifact failed integrity validation: ${relativePath}`);
    }
  }
}

export async function validateHardDataTarget(target) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(target.manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`hard-data ${target.kind} manifest is missing or invalid: ${target.manifestPath}`, { cause: error });
  }

  validateHardDataManifestIdentity(target, manifest);
  await validateImmutableGenerationFiles(target, manifest);
  return manifest;
}
