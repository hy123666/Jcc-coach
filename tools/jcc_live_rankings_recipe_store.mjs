import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { retryTransientFileOperation } from "./jcc_transient_file_operations.mjs";

export const ACTIVE_RECIPE_POINTER_FILE = "active-recipe-generation.json";
export const ACTIVE_RECIPE_POINTER_SCHEMA = "jcc-live-ranking-active-recipe-generation-v1";
export const RECIPE_GENERATION_SCHEMA = "jcc-live-ranking-recipe-generation-v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectedGenerationPath(generationId) {
  return `recipe-generations/${generationId}/recipes.json`;
}

function normalizedIdentity(value = {}) {
  return {
    core_profile_id: String(value.core_profile_id || "").trim(),
    season_id: String(value.season_id || value.runtime_season_id || "").trim(),
    patch_id: String(value.patch_id || value.active_patch_id || "").trim(),
  };
}

function identityMatches(left, right) {
  const a = normalizedIdentity(left);
  const b = normalizedIdentity(right);
  return Boolean(a.core_profile_id && a.season_id && a.patch_id)
    && a.core_profile_id === b.core_profile_id
    && a.season_id === b.season_id
    && a.patch_id === b.patch_id;
}

function safeGenerationFile(rootDir, generationId) {
  if (!SHA256_PATTERN.test(generationId)) throw new Error("invalid recipe generation id");
  const root = path.resolve(rootDir);
  const generationFile = path.resolve(root, expectedGenerationPath(generationId));
  const relative = path.relative(root, generationFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("recipe generation path escapes live-ranking root");
  return generationFile;
}

function validateGenerationDocument(text, generationId, expectedIdentity) {
  if (sha256(text) !== generationId) throw new Error("recipe generation content hash mismatch");
  const document = JSON.parse(text);
  if (document?.schema !== RECIPE_GENERATION_SCHEMA) throw new Error("recipe generation schema is invalid");
  if (!identityMatches(document.identity, expectedIdentity)) throw new Error("recipe generation identity is incompatible with current Core Profile");
  return document;
}

export async function activateRankingRecipeGeneration({ rootDir, target, generation, lease }) {
  const root = path.resolve(rootDir);
  if (!lease || path.resolve(lease.rootDir || "") !== root) {
    throw new Error("recipe activation requires the live-ranking lifecycle lease for the same root");
  }
  const identity = normalizedIdentity(target);
  if (!SHA256_PATTERN.test(identity.core_profile_id) || !identity.season_id || !identity.patch_id) {
    throw new Error("recipe activation requires a complete Core Profile identity");
  }
  const generationId = String(generation?.generation_id || "").trim();
  const generationFile = safeGenerationFile(root, generationId);
  const info = lstatSync(generationFile);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("recipe generation must be a regular non-symlink file");
  const text = await readFile(generationFile, "utf8");
  const document = validateGenerationDocument(text, generationId, identity);
  const pointer = {
    schema: ACTIVE_RECIPE_POINTER_SCHEMA,
    status: "active",
    ...identity,
    generation_id: generationId,
    generation_path: expectedGenerationPath(generationId),
    source_roles: [...new Set((document.recipes || []).map((recipe) => recipe?.source_role).filter(Boolean))].sort(),
    accepted_recipe_count: Array.isArray(document.recipes) ? document.recipes.length : 0,
  };
  const pointerFile = path.join(root, ACTIVE_RECIPE_POINTER_FILE);
  const tempPointer = path.join(root, `.${ACTIVE_RECIPE_POINTER_FILE}.${randomUUID()}.tmp`);
  try {
    await retryTransientFileOperation(() => writeFile(tempPointer, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: "utf8", flag: "wx" }));
    await lease.renew();
    await lease.assertOwnership();
    await retryTransientFileOperation(() => rename(tempPointer, pointerFile));
  } finally {
    await rm(tempPointer, { force: true }).catch(() => {});
  }
  return { pointer, pointer_file: pointerFile, generation_file: generationFile };
}

export function resolveActiveRankingRecipeGenerationSync({ rootDir, expectedIdentity } = {}) {
  const root = path.resolve(rootDir);
  const expected = normalizedIdentity(expectedIdentity);
  const unavailable = (reason) => ({
    availability: "unavailable",
    reason,
    core_profile_id: expected.core_profile_id || null,
    season_id: expected.season_id || null,
    patch_id: expected.patch_id || null,
    generation_id: null,
    generation_path: null,
  });
  try {
    const pointerFile = path.join(root, ACTIVE_RECIPE_POINTER_FILE);
    const pointerInfo = lstatSync(pointerFile);
    if (!pointerInfo.isFile() || pointerInfo.isSymbolicLink()) return unavailable("active_recipe_pointer_is_not_a_regular_file");
    const pointer = JSON.parse(readFileSync(pointerFile, "utf8"));
    if (pointer?.schema !== ACTIVE_RECIPE_POINTER_SCHEMA || pointer?.status !== "active") return unavailable("active_recipe_pointer_is_invalid");
    if (!identityMatches(pointer, expected)) return unavailable("active_recipe_pointer_is_incompatible");
    const generationId = String(pointer.generation_id || "").trim();
    if (pointer.generation_path !== expectedGenerationPath(generationId)) return unavailable("active_recipe_pointer_path_is_invalid");
    const generationFile = safeGenerationFile(root, generationId);
    const generationInfo = lstatSync(generationFile);
    if (!generationInfo.isFile() || generationInfo.isSymbolicLink()) return unavailable("active_recipe_generation_is_not_a_regular_file");
    const text = readFileSync(generationFile, "utf8");
    const document = validateGenerationDocument(text, generationId, expected);
    return {
      availability: "available",
      reason: null,
      ...expected,
      generation_id: generationId,
      generation_path: pointer.generation_path,
      source_roles: Array.isArray(pointer.source_roles) ? pointer.source_roles : [],
      accepted_recipe_count: Array.isArray(document.recipes) ? document.recipes.length : 0,
    };
  } catch (error) {
    return unavailable(error?.code === "ENOENT" ? "active_recipe_generation_missing" : "active_recipe_generation_invalid");
  }
}

export function readRankingRecipeGenerationSync({ rootDir, generationId, expectedIdentity } = {}) {
  const generationFile = safeGenerationFile(rootDir, String(generationId || "").trim());
  const info = lstatSync(generationFile);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("recipe generation must be a regular non-symlink file");
  const text = readFileSync(generationFile, "utf8");
  const document = validateGenerationDocument(text, String(generationId || "").trim(), normalizedIdentity(expectedIdentity));
  return { document, generation_file: generationFile };
}
