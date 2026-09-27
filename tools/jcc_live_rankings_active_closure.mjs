import { lstatSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  activateLiveRankingGeneration,
  resolveLiveRankingGenerationPathSync,
} from "./jcc_live_rankings_generation_store.mjs";
import {
  activateRankingRecipeGeneration,
  readRankingRecipeGenerationSync,
} from "./jcc_live_rankings_recipe_store.mjs";
import { buildRankingRecipeFreshnessProfile } from "./jcc_ranking_recipe_freshness.mjs";
import {
  NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA,
  validateNormalizedRankingRecipeStorage,
} from "./jcc_ranking_recipe_storage.mjs";
import { isTransientFileOperationError, retryTransientFileOperation } from "./jcc_transient_file_operations.mjs";

export const ACTIVE_RANKING_CLOSURE_FILE = "active-ranking-closure.json";
export const ACTIVE_RANKING_CLOSURE_SCHEMA = "jcc-live-ranking-active-closure-v1";
export const ACTIVE_RANKING_CLOSURE_MIGRATION_FILE = "active-ranking-closure-format.json";
export const ACTIVE_RANKING_CLOSURE_MIGRATION_SCHEMA = "jcc-live-ranking-active-closure-format-v1";
export const CORE_RANKING_PUBLICATION_INTENT_FILE = "core-ranking-publication-intent.json";
export const CORE_RANKING_PUBLICATION_INTENT_SCHEMA = "jcc-core-ranking-publication-intent-v1";

const RANKING_GENERATION_ID = /^\d{8}-[a-f0-9]{24}$/u;
const RECIPE_GENERATION_ID = /^[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SEMANTIC_MAINTENANCE_SCHEMA = "jcc-ranking-semantic-maintenance-receipt-v1";
const SEMANTIC_MAINTENANCE_READY_STATUSES = new Set(["ready", "degraded", "not_required"]);
const validatedActiveClosureCache = new Map();

function normalizedIdentity(value = {}) {
  return {
    core_profile_id: String(value.core_profile_id || "").trim(),
    season_id: String(value.season_id || value.runtime_season_id || "").trim(),
    patch_id: String(value.patch_id || value.active_patch_id || "").trim(),
    catalog_fingerprint: String(value.catalog_fingerprint || value.catalog_source_fingerprint || "").trim(),
    hard_data_manifest_fingerprint: String(value.hard_data_manifest_fingerprint || "").trim(),
  };
}

function identityMatches(left, right) {
  const a = normalizedIdentity(left);
  const b = normalizedIdentity(right);
  return Boolean(a.core_profile_id && a.season_id && a.patch_id)
    && SHA256.test(a.catalog_fingerprint)
    && SHA256.test(b.catalog_fingerprint)
    && SHA256.test(a.hard_data_manifest_fingerprint)
    && SHA256.test(b.hard_data_manifest_fingerprint)
    && a.core_profile_id === b.core_profile_id
    && a.season_id === b.season_id
    && a.patch_id === b.patch_id
    && a.catalog_fingerprint === b.catalog_fingerprint
    && a.hard_data_manifest_fingerprint === b.hard_data_manifest_fingerprint;
}

function closureFile(rootDir) {
  return path.join(path.resolve(rootDir), ACTIVE_RANKING_CLOSURE_FILE);
}

function closureMigrationFile(rootDir) {
  return path.join(path.resolve(rootDir), ACTIVE_RANKING_CLOSURE_MIGRATION_FILE);
}

function closureDependencySignature(file) {
  try {
    const info = lstatSync(file);
    return `${info.isFile() ? "file" : info.isDirectory() ? "dir" : "other"}:${info.isSymbolicLink() ? "symlink" : "direct"}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch (error) {
    return error?.code === "ENOENT" ? "missing" : `error:${error?.code || "unknown"}`;
  }
}

function activeClosureDependencyFiles(rootDir) {
  const root = path.resolve(rootDir);
  const pointerPath = closureFile(root);
  const files = [pointerPath, closureMigrationFile(root)];
  try {
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    const rankingGenerationId = String(pointer?.ranking_generation_id || "").trim();
    if (RANKING_GENERATION_ID.test(rankingGenerationId)) {
      const generationDir = path.join(root, "generations", rankingGenerationId);
      const metadataFile = path.join(generationDir, "_generation.json");
      files.push(metadataFile);
      try {
        const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
        for (const artifact of Array.isArray(metadata?.artifacts) ? metadata.artifacts : []) {
          const relative = path.posix.normalize(String(artifact?.path || "").replaceAll("\\", "/"));
          if (!relative || relative === "." || relative.startsWith("../") || path.posix.isAbsolute(relative)) continue;
          const artifactFile = path.resolve(generationDir, ...relative.split("/"));
          const contained = path.relative(generationDir, artifactFile);
          if (!contained.startsWith("..") && !path.isAbsolute(contained)) files.push(artifactFile);
        }
      } catch {}
    }
    const recipeGenerationId = String(pointer?.recipe_generation_id || "").trim();
    if (RECIPE_GENERATION_ID.test(recipeGenerationId)) {
      files.push(path.join(root, "recipe-generations", recipeGenerationId, "recipes.json"));
    }
  } catch {}
  return [...new Set(files.map((file) => path.resolve(file)))];
}

function activeClosureDependencySignatures(rootDir) {
  return Object.fromEntries(activeClosureDependencyFiles(rootDir)
    .map((file) => [file, closureDependencySignature(file)]));
}

function sameClosureDependencySignatures(left, right) {
  const leftKeys = Object.keys(left || {});
  const rightKeys = Object.keys(right || {});
  return leftKeys.length === rightKeys.length
    && leftKeys.every((file) => left[file] === right[file]);
}

function closureFormatActivatedSync(rootDir) {
  const markerPath = closureMigrationFile(rootDir);
  try {
    const info = lstatSync(markerPath);
    if (!info.isFile() || info.isSymbolicLink()) return true;
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    return marker?.schema === ACTIVE_RANKING_CLOSURE_MIGRATION_SCHEMA
      && marker?.status === "activated";
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

async function markClosureFormatActivated(rootDir, pointer, lease) {
  const markerPath = closureMigrationFile(rootDir);
  const tempPath = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  const marker = {
    schema: ACTIVE_RANKING_CLOSURE_MIGRATION_SCHEMA,
    status: "activated",
    activated_at: new Date().toISOString(),
    publication_transaction_id: pointer.publication_transaction_id || null,
  };
  try {
    await retryTransientFileOperation(() => writeFile(tempPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" }));
    await lease.renew();
    await lease.assertOwnership();
    await retryTransientFileOperation(() => rename(tempPath, markerPath));
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
  return markerPath;
}

function publicationIntentFile(rootDir) {
  return path.join(path.resolve(rootDir), CORE_RANKING_PUBLICATION_INTENT_FILE);
}

function publicationIdentity({ identity, rankingGenerationId, recipeGenerationId, statDate } = {}) {
  return {
    ...normalizedIdentity(identity),
    stat_date: String(statDate || "").trim(),
    ranking_generation_id: String(rankingGenerationId || "").trim(),
    recipe_generation_id: String(recipeGenerationId || "").trim(),
  };
}

function publicationTransactionId(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function samePublicationIdentity(left, right) {
  return isDeepStrictEqual(publicationIdentity({
    identity: left,
    rankingGenerationId: left?.ranking_generation_id,
    recipeGenerationId: left?.recipe_generation_id,
    statDate: left?.stat_date,
  }), publicationIdentity({
    identity: right,
    rankingGenerationId: right?.ranking_generation_id,
    recipeGenerationId: right?.recipe_generation_id,
    statDate: right?.stat_date,
  }));
}

async function writePublicationIntent(rootDir, intent, lease) {
  const pointerPath = publicationIntentFile(rootDir);
  const tempPath = `${pointerPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await retryTransientFileOperation(() => writeFile(tempPath, `${JSON.stringify(intent, null, 2)}\n`, { encoding: "utf8", flag: "wx" }));
    await lease.renew();
    await lease.assertOwnership();
    await retryTransientFileOperation(() => rename(tempPath, pointerPath));
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
  return pointerPath;
}

export function readCoreRankingPublicationIntentSync({ rootDir } = {}) {
  const pointerPath = publicationIntentFile(rootDir);
  try {
    const info = lstatSync(pointerPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Core+Ranking publication intent is not a regular file");
    const intent = JSON.parse(readFileSync(pointerPath, "utf8"));
    if (intent?.schema !== CORE_RANKING_PUBLICATION_INTENT_SCHEMA
      || !SHA256.test(String(intent.transaction_id || ""))
      || !SHA256.test(String(intent.core_profile_id || ""))
      || !RANKING_GENERATION_ID.test(String(intent.ranking_generation_id || ""))
      || !RECIPE_GENERATION_ID.test(String(intent.recipe_generation_id || ""))
      || !/^\d{8}$/u.test(String(intent.stat_date || ""))
      || !new Set(["prepared", "core_committed", "closure_committed", "committed_needs_repair"]).has(intent.status)) {
      throw new Error("Core+Ranking publication intent is invalid");
    }
    if (publicationTransactionId(publicationIdentity({
      identity: intent,
      rankingGenerationId: intent.ranking_generation_id,
      recipeGenerationId: intent.recipe_generation_id,
      statDate: intent.stat_date,
    })) !== intent.transaction_id) {
      throw new Error("Core+Ranking publication intent transaction identity is invalid");
    }
    return { intent, intent_file: pointerPath };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function completeCoreRankingPublicationTransaction({
  rootDir,
  identity,
  rankingGenerationId,
  recipeGenerationId,
  statDate,
  lease,
  readActiveCoreProfile,
  promoteCoreProfile,
  activators,
  publicationOperations = {},
  crashHook,
} = {}) {
  const root = path.resolve(rootDir);
  if (!lease || path.resolve(lease.rootDir || "") !== root) {
    throw new Error("Core+Ranking publication requires the live-ranking lifecycle lease for the same root");
  }
  if (typeof readActiveCoreProfile !== "function" || typeof promoteCoreProfile !== "function") {
    throw new TypeError("Core+Ranking publication requires Core read and promotion callbacks");
  }
  const target = publicationIdentity({ identity, rankingGenerationId, recipeGenerationId, statDate });
  validateRankingClosureCandidateSync({
    rootDir: root,
    rankingGenerationId: target.ranking_generation_id,
    recipeGenerationId: target.recipe_generation_id,
    statDate: target.stat_date,
    identity: target,
  });
  await lease.assertOwnership();
  let stored = readCoreRankingPublicationIntentSync({ rootDir: root });
  const resumed = Boolean(stored);
  if (stored && !samePublicationIdentity(stored.intent, target)) {
    throw new Error(`another Core+Ranking publication identity is pending: ${stored.intent.transaction_id}`);
  }
  if (!stored) {
    const activeCore = await readActiveCoreProfile();
    const intent = {
      schema: CORE_RANKING_PUBLICATION_INTENT_SCHEMA,
      transaction_id: publicationTransactionId(target),
      status: "prepared",
      ...target,
      previous_core_profile_id: String(activeCore?.core_profile_id || "").trim() || null,
      prepared_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await writePublicationIntent(root, intent, lease);
    stored = { intent, intent_file: publicationIntentFile(root) };
    await crashHook?.("intent_prepared", intent);
  }

  let intent = stored.intent;
  let activeCore = await readActiveCoreProfile();
  if (activeCore?.core_profile_id !== target.core_profile_id) {
    if (activeCore?.core_profile_id !== intent.previous_core_profile_id) {
      throw new Error("active Core Profile conflicts with the durable Core+Ranking publication intent");
    }
    await promoteCoreProfile();
    activeCore = await readActiveCoreProfile();
    if (activeCore?.core_profile_id !== target.core_profile_id) {
      throw new Error("Core Profile promotion did not activate the intended identity");
    }
  }
  if (intent.status === "prepared") {
    intent = { ...intent, status: "core_committed", updated_at: new Date().toISOString() };
    await writePublicationIntent(root, intent, lease);
  }
  await crashHook?.("core_committed", intent);

  let activeClosure = resolveActiveRankingClosureSync({ rootDir: root, expectedIdentity: target });
  if (activeClosure.availability !== "available"
    || activeClosure.closure_status !== "available"
    || activeClosure.ranking_generation_id !== target.ranking_generation_id
    || activeClosure.recipe_generation_id !== target.recipe_generation_id) {
    try {
      await activateRankingClosure({
        rootDir: root,
        rankingGenerationId: target.ranking_generation_id,
        recipeGenerationId: target.recipe_generation_id,
        statDate: target.stat_date,
        identity: target,
        lease,
      });
    } catch (error) {
      const committed = resolveActiveRankingClosureSync({ rootDir: root, expectedIdentity: target });
      if (committed.availability !== "available"
        || committed.ranking_generation_id !== target.ranking_generation_id
        || committed.recipe_generation_id !== target.recipe_generation_id) {
        throw error;
      }
      intent = {
        ...intent,
        status: "committed_needs_repair",
        mirror_errors: [{ mirror: "closure_post_commit_metadata", error: error?.message || String(error) }],
        updated_at: new Date().toISOString(),
      };
      await writePublicationIntent(root, intent, lease).catch(() => {});
      return {
        status: "committed_needs_repair",
        transaction_id: intent.transaction_id,
        intent_file: publicationIntentFile(root),
        active_core_profile: activeCore,
        active_closure: committed,
        mirrors: { status: "degraded", errors: intent.mirror_errors },
        resumed,
      };
    }
    activeClosure = resolveActiveRankingClosureSync({ rootDir: root, expectedIdentity: target });
  }
  if (activeClosure.availability !== "available" || activeClosure.closure_status !== "available") {
    throw new Error("authoritative Ranking closure did not commit the intended identity");
  }
  if (!new Set(["closure_committed", "committed_needs_repair"]).has(intent.status)) {
    intent = { ...intent, status: "closure_committed", updated_at: new Date().toISOString() };
    await writePublicationIntent(root, intent, lease);
  }
  await crashHook?.("closure_committed", intent);

  const mirrors = await synchronizeRankingClosureCompatibilityMirrors({
    rootDir: root,
    identity: target,
    lease,
    activators,
  });
  if (mirrors.status !== "ready") {
    intent = {
      ...intent,
      status: "committed_needs_repair",
      mirror_errors: mirrors.errors,
      updated_at: new Date().toISOString(),
    };
    await writePublicationIntent(root, intent, lease);
    return {
      status: "committed_needs_repair",
      transaction_id: intent.transaction_id,
      intent_file: publicationIntentFile(root),
      active_core_profile: activeCore,
      active_closure: activeClosure,
      mirrors,
      resumed,
    };
  }
  await lease.assertOwnership();
  const intentFile = publicationIntentFile(root);
  const removePublicationIntent = publicationOperations.removeIntent
    || (() => retryTransientFileOperation(() => rm(intentFile, { force: false })));
  try {
    await removePublicationIntent({ intentFile, intent, lease });
  } catch (error) {
    const committed = resolveActiveRankingClosureSync({ rootDir: root, expectedIdentity: target });
    if (committed.availability !== "available"
      || committed.closure_status !== "available"
      || committed.ranking_generation_id !== target.ranking_generation_id
      || committed.recipe_generation_id !== target.recipe_generation_id) {
      throw error;
    }
    const cleanupErrors = [{
      operation: "publication_intent_cleanup",
      error: error?.message || String(error),
    }];
    intent = {
      ...intent,
      status: "committed_needs_repair",
      cleanup_errors: cleanupErrors,
      updated_at: new Date().toISOString(),
    };
    try {
      await writePublicationIntent(root, intent, lease);
    } catch (intentError) {
      cleanupErrors.push({
        operation: "publication_intent_repair_record",
        error: intentError?.message || String(intentError),
      });
    }
    return {
      status: "committed_needs_repair",
      transaction_id: intent.transaction_id,
      intent_file: intentFile,
      active_core_profile: activeCore,
      active_closure: committed,
      mirrors,
      cleanup: { status: "degraded", errors: cleanupErrors },
      resumed,
    };
  }
  return {
    status: "committed",
    transaction_id: intent.transaction_id,
    intent_file: null,
    active_core_profile: activeCore,
    active_closure: activeClosure,
    mirrors,
    resumed,
  };
}

export function recipeFreshnessProfileForRanking(document, rankingStatDate) {
  return buildRankingRecipeFreshnessProfile({
    rankingStatDate,
    sourceCapabilities: document?.capability?.source_capabilities || {},
    identityCompatible: true,
  });
}

async function synchronizeCurrentRankingMirror({ rootDir, active, lease }) {
  const root = path.resolve(rootDir);
  const currentDir = path.join(root, "current");
  const previousDir = path.join(root, "previous");
  let rotateCurrent = true;
  try {
    const currentSignal = JSON.parse(await readFile(path.join(currentDir, "rank-signal.json"), "utf8"));
    rotateCurrent = currentSignal?.stat_date !== active.stat_date;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (rotateCurrent) {
    const currentFiles = await collectCompatibilityMirrorFiles(currentDir);
    if (currentFiles.length > 0) {
      await synchronizeCompatibilityMirrorFiles({
        sourceDir: currentDir,
        destinationDir: previousDir,
        relativeFiles: currentFiles,
        lease,
      });
    }
  }
  const generationFiles = (active.ranking?.artifacts || [])
    .map((artifact) => String(artifact?.path || "").trim())
    .filter(Boolean);
  await synchronizeCompatibilityMirrorFiles({
    sourceDir: active.ranking.generation_dir,
    destinationDir: currentDir,
    relativeFiles: generationFiles,
    lease,
  });
  return {
    ok: true,
    current_dir: currentDir,
    previous_dir: previousDir,
    rotated_current_to_previous: Boolean(rotateCurrent),
    publication_mode: "file_atomic_compatibility_mirror",
  };
}

async function collectCompatibilityMirrorFiles(rootDir, relativeDir = "") {
  const absoluteDir = relativeDir
    ? path.join(rootDir, ...relativeDir.split("/"))
    : rootDir;
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Ranking compatibility mirror contains a symbolic link: ${entry.name}`);
    const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collectCompatibilityMirrorFiles(rootDir, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function replaceCompatibilityMirrorFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  const backup = `${destination}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.bak`;
  let destinationMoved = false;
  try {
    await retryTransientFileOperation(() => copyFile(source, temporary));
    try {
      await retryTransientFileOperation(() => rename(temporary, destination), { attempts: 6 });
    } catch (error) {
      if (!isTransientFileOperationError(error)) throw error;
      await retryTransientFileOperation(() => rename(destination, backup), { attempts: 6 });
      destinationMoved = true;
      try {
        await retryTransientFileOperation(() => rename(temporary, destination), { attempts: 6 });
      } catch (replacementError) {
        await retryTransientFileOperation(() => rename(backup, destination), { attempts: 6 }).catch(() => {});
        destinationMoved = false;
        throw replacementError;
      }
      await rm(backup, { force: true });
      destinationMoved = false;
    }
  } finally {
    if (destinationMoved) {
      await retryTransientFileOperation(() => rename(backup, destination), { attempts: 6 }).catch(() => {});
    }
    await rm(temporary, { force: true }).catch(() => {});
    await rm(backup, { force: true }).catch(() => {});
  }
}

async function synchronizeCompatibilityMirrorFiles({ sourceDir, destinationDir, relativeFiles, lease }) {
  const uniqueFiles = [...new Set(relativeFiles)].sort((left, right) => {
    if (left === "rank-signal.json") return 1;
    if (right === "rank-signal.json") return -1;
    return left.localeCompare(right);
  });
  await mkdir(destinationDir, { recursive: true });
  for (const relative of uniqueFiles) {
    const normalized = path.posix.normalize(relative.replaceAll("\\", "/"));
    if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      throw new Error(`Ranking compatibility mirror path is invalid: ${relative}`);
    }
    await lease.renew();
    await lease.assertOwnership();
    await replaceCompatibilityMirrorFile(
      path.join(sourceDir, ...normalized.split("/")),
      path.join(destinationDir, ...normalized.split("/")),
    );
  }
}

export function assertRankingSemanticMaintenanceReady({ strategyIndex, manifest, audit } = {}) {
  const receipt = strategyIndex?.semantic_maintenance;
  if (!receipt || receipt.schema !== SEMANTIC_MAINTENANCE_SCHEMA) {
    throw new Error("Ranking generation semantic maintenance receipt is missing");
  }
  if (!SEMANTIC_MAINTENANCE_READY_STATUSES.has(receipt.status)) {
    throw new Error(`Ranking generation semantic maintenance is not ready: ${receipt.status || "missing"}`);
  }
  if (receipt.authority !== "non_authoritative_semantic_annotation_only"
    || receipt.current_day_strength_unchanged !== true) {
    throw new Error("Ranking generation semantic maintenance authority is invalid");
  }
  if (!SHA256.test(String(receipt.input_hash || ""))) {
    throw new Error("Ranking generation semantic maintenance input hash is invalid");
  }
  if (receipt.status === "ready" && !SHA256.test(String(receipt.output_hash || ""))) {
    throw new Error("Ranking generation semantic maintenance output hash is invalid");
  }
  if (receipt.status === "not_required" && receipt.output_hash !== null) {
    throw new Error("Ranking generation not-required semantic maintenance must not carry an output hash");
  }
  if (receipt.status === "degraded" && !String(receipt.failure_code || "").trim()) {
    throw new Error("Ranking generation degraded semantic maintenance must carry a failure code");
  }
  if (receipt.status !== "degraded" && (receipt.failure_code || receipt.failure_reason)) {
    throw new Error("Ranking generation semantic maintenance contains a failure receipt");
  }
  if (!isDeepStrictEqual(manifest?.semantic_maintenance, receipt)
    || !isDeepStrictEqual(audit?.semantic_maintenance, receipt)) {
    throw new Error("Ranking generation semantic maintenance receipt is inconsistent across artifacts");
  }
  const candidates = strategyIndex?.tiers?.["0"]?.lineup_candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("Ranking generation has no semantic maintenance candidates");
  }
  const annotatedCount = candidates.filter((candidate) => candidate?.semantic_annotation).length;
  if (annotatedCount !== candidates.length || Number(receipt.annotation_count) !== annotatedCount) {
    throw new Error("Ranking generation semantic maintenance does not cover every lineup candidate");
  }
  const reusedCount = Number(receipt.reused_annotation_count);
  if (!Number.isInteger(reusedCount) || reusedCount < 0 || reusedCount > annotatedCount) {
    throw new Error("Ranking generation semantic maintenance reused annotation count is invalid");
  }
  return receipt;
}

function assertRankingGenerationSemanticMaintenanceReady(ranking) {
  const generationDir = ranking?.generation_dir;
  if (!generationDir) throw new Error("Ranking generation directory is missing");
  const readArtifact = (name) => JSON.parse(readFileSync(path.join(generationDir, name), "utf8"));
  const strategyIndex = readArtifact("lineup-strategy-index.json");
  if (strategyIndex?.schema !== NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA) {
    throw new Error(`Ranking generation must use ${NORMALIZED_RANKING_STRATEGY_INDEX_SCHEMA}`);
  }
  validateNormalizedRankingRecipeStorage(strategyIndex);
  return assertRankingSemanticMaintenanceReady({
    strategyIndex,
    manifest: readArtifact("manifest.json"),
    audit: readArtifact("audit.json"),
  });
}

function unavailable(reason, expectedIdentity = {}, closureStatus = "missing") {
  return {
    availability: "unavailable",
    reason,
    closure_status: closureStatus,
    core_profile_id: expectedIdentity.core_profile_id || null,
    season_id: expectedIdentity.season_id || null,
    patch_id: expectedIdentity.patch_id || null,
    stat_date: null,
    ranking_generation_id: null,
    recipe_generation_id: null,
    ranking: null,
    recipe: null,
    pointer: null,
    legacy_fallback: false,
  };
}

function rankingPointerFromMetadata(metadata) {
  return {
    schema: "jcc-live-ranking-active-generation-v1",
    status: "active",
    generation_id: metadata.generation_id,
    stat_date: metadata.stat_date,
    content_sha256: metadata.content_sha256,
    core_profile_id: metadata.core_profile_id,
    season_id: metadata.season_id,
    patch_id: metadata.patch_id,
    catalog_fingerprint: metadata.catalog_fingerprint,
    hard_data_manifest_fingerprint: metadata.hard_data_manifest_fingerprint,
    binding: {
      core_profile_id: metadata.core_profile_id,
      season_id: metadata.season_id,
      patch_id: metadata.patch_id,
      catalog_fingerprint: metadata.catalog_fingerprint,
      hard_data_manifest_fingerprint: metadata.hard_data_manifest_fingerprint,
    },
  };
}

function resolveClosureDocumentSync(rootDir, pointer, expectedIdentity, { requireSemanticMaintenance = true } = {}) {
  if (!pointer || pointer.schema !== ACTIVE_RANKING_CLOSURE_SCHEMA || pointer.status !== "active") {
    throw new Error("active Ranking closure pointer is invalid");
  }
  if (!identityMatches(pointer, expectedIdentity)) {
    throw new Error("active Ranking closure pointer is incompatible with the selected Core Profile");
  }
  const rankingGenerationId = String(pointer.ranking_generation_id || "").trim();
  const recipeGenerationId = String(pointer.recipe_generation_id || "").trim();
  if (!RANKING_GENERATION_ID.test(rankingGenerationId) || !RECIPE_GENERATION_ID.test(recipeGenerationId)) {
    throw new Error("active Ranking closure pointer generation ids are invalid");
  }
  const ranking = resolveLiveRankingGenerationPathSync({ rootDir, generationId: rankingGenerationId });
  if (!ranking || !identityMatches(ranking.metadata, expectedIdentity)) {
    throw new Error("active Ranking closure points to an incompatible Ranking generation");
  }
  const semanticMaintenance = requireSemanticMaintenance
    ? assertRankingGenerationSemanticMaintenanceReady(ranking)
    : null;
  const recipe = readRankingRecipeGenerationSync({
    rootDir,
    generationId: recipeGenerationId,
    expectedIdentity,
  });
  const statDate = String(pointer.stat_date || "").trim();
  const recipeFreshness = recipeFreshnessProfileForRanking(recipe.document, statDate);
  if (!/^\d{8}$/u.test(statDate) || ranking.metadata.stat_date !== statDate) {
    throw new Error("active Ranking closure ranking date does not match");
  }
  if (recipeFreshness.status === "unavailable") {
    throw new Error("active Ranking closure has no automatically usable recipe source");
  }
  return {
    availability: "available",
    closure_status: "available",
    reason: null,
    core_profile_id: expectedIdentity.core_profile_id,
    season_id: expectedIdentity.season_id,
    patch_id: expectedIdentity.patch_id,
    stat_date: statDate,
    ranking_generation_id: rankingGenerationId,
    recipe_generation_id: recipeGenerationId,
    ranking: {
      ...ranking,
      pointer: rankingPointerFromMetadata(ranking.metadata),
      ...(semanticMaintenance ? { semantic_maintenance: semanticMaintenance } : {}),
    },
    recipe: {
      ...recipe,
      generation_id: recipeGenerationId,
      stat_date: statDate,
      freshness: recipeFreshness,
    },
    pointer,
    legacy_fallback: false,
  };
}

function resolveActiveRankingClosureUncached(root, expected) {
  const pointerPath = closureFile(root);
  try {
    const info = lstatSync(pointerPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      return unavailable("active Ranking closure pointer is not a regular file", expected, "invalid");
    }
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    try {
      return resolveClosureDocumentSync(root, pointer, expected);
    } catch (error) {
      return unavailable(error?.message || "active Ranking closure is invalid", expected, "invalid");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return unavailable(error?.message || "active Ranking closure is unreadable", expected, "invalid");
    }
  }

  if (closureFormatActivatedSync(root)) {
    return unavailable("active Ranking closure is missing after paired-closure activation", expected, "invalid");
  }

  return unavailable(
    "active Ranking closure is missing; independent legacy Ranking and recipe pointers cannot prove one atomic publication",
    expected,
    "missing",
  );
}

export function resolveActiveRankingClosureSync({ rootDir, expectedIdentity, reuseValidated = false } = {}) {
  const root = path.resolve(rootDir);
  const expected = normalizedIdentity(expectedIdentity);
  if (!reuseValidated) return resolveActiveRankingClosureUncached(root, expected);

  const cacheKey = `${root}\n${JSON.stringify(expected)}`;
  const dependencySignatures = activeClosureDependencySignatures(root);
  const cached = validatedActiveClosureCache.get(cacheKey);
  if (cached && sameClosureDependencySignatures(cached.dependency_signatures, dependencySignatures)) {
    return cached.result;
  }
  const result = resolveActiveRankingClosureUncached(root, expected);
  validatedActiveClosureCache.set(cacheKey, {
    dependency_signatures: activeClosureDependencySignatures(root),
    result,
  });
  return result;
}

export function resolveRankingRefreshBaselineClosureSync({ rootDir, expectedIdentity } = {}) {
  const expected = normalizedIdentity(expectedIdentity);
  const compatible = resolveActiveRankingClosureSync({ rootDir, expectedIdentity: expected });
  if (compatible.closure_status !== "invalid") {
    return {
      ...compatible,
      target_compatible: compatible.availability === "available",
      replacement_required: false,
    };
  }

  const root = path.resolve(rootDir);
  const pointerPath = closureFile(root);
  try {
    const info = lstatSync(pointerPath);
    if (!info.isFile() || info.isSymbolicLink()) return { ...compatible, target_compatible: false, replacement_required: false };
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    const storedIdentity = normalizedIdentity(pointer);
    const stored = resolveClosureDocumentSync(root, pointer, storedIdentity, { requireSemanticMaintenance: false });
    if (stored.core_profile_id && stored.core_profile_id !== expected.core_profile_id) {
      return {
        ...stored,
        closure_status: "stale_core",
        reason: "active Ranking closure belongs to the previous Core Profile and must be atomically replaced",
        target_compatible: false,
        replacement_required: true,
      };
    }
    if (stored.core_profile_id === expected.core_profile_id) {
      return {
        ...stored,
        closure_status: "semantic_incomplete",
        reason: "active Ranking closure is structurally complete but semantic maintenance must be replaced",
        target_compatible: false,
        replacement_required: true,
      };
    }
  } catch {
    // Preserve the original fail-closed result when the stored closure cannot
    // prove that it is a complete previous-Core rollback generation.
  }
  return { ...compatible, target_compatible: false, replacement_required: false };
}

export function validateRankingClosureCandidateSync({
  rootDir,
  rankingGenerationId,
  recipeGenerationId,
  statDate,
  identity,
} = {}) {
  const root = path.resolve(rootDir);
  const expected = normalizedIdentity(identity);
  return resolveClosureDocumentSync(root, {
    schema: ACTIVE_RANKING_CLOSURE_SCHEMA,
    status: "active",
    ...expected,
    stat_date: statDate,
    ranking_generation_id: rankingGenerationId,
    recipe_generation_id: recipeGenerationId,
  }, expected);
}

export async function activateRankingClosure({ rootDir, rankingGenerationId, recipeGenerationId, statDate, identity, lease }) {
  const root = path.resolve(rootDir);
  if (!lease || path.resolve(lease.rootDir || "") !== root) {
    throw new Error("Ranking closure activation requires the live-ranking lifecycle lease for the same root");
  }
  const expected = normalizedIdentity(identity);
  const closure = validateRankingClosureCandidateSync({
    rootDir: root,
    rankingGenerationId,
    recipeGenerationId,
    statDate,
    identity: expected,
  });
  await lease.assertOwnership();
  const pointer = {
    schema: ACTIVE_RANKING_CLOSURE_SCHEMA,
    status: "active",
    ...expected,
    stat_date: closure.stat_date,
    ranking_generation_id: closure.ranking_generation_id,
    recipe_generation_id: closure.recipe_generation_id,
    published_at: new Date().toISOString(),
  };
  const pointerPath = closureFile(root);
  const tempPath = `${pointerPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await retryTransientFileOperation(() => writeFile(tempPath, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: "utf8", flag: "wx" }));
    await lease.renew();
    await lease.assertOwnership();
    await retryTransientFileOperation(() => rename(tempPath, pointerPath));
    await markClosureFormatActivated(root, pointer, lease);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
  return { pointer, pointer_file: pointerPath, ranking: closure.ranking, recipe: closure.recipe };
}

export async function restoreActiveRankingClosure({
  rootDir,
  previousPointerBytes,
  expectedCurrentRankingGenerationId,
  expectedCurrentRecipeGenerationId,
  lease,
} = {}) {
  const root = path.resolve(rootDir);
  if (!lease || path.resolve(lease.rootDir || "") !== root) {
    throw new Error("Ranking closure rollback requires the live-ranking lifecycle lease for the same root");
  }
  const pointerPath = closureFile(root);
  const current = JSON.parse(await readFile(pointerPath, "utf8"));
  if (current?.schema !== ACTIVE_RANKING_CLOSURE_SCHEMA
    || current?.status !== "active"
    || current.ranking_generation_id !== expectedCurrentRankingGenerationId
    || current.recipe_generation_id !== expectedCurrentRecipeGenerationId) {
    throw new Error("Active Ranking closure changed before rollback");
  }
  await lease.assertOwnership();
  if (previousPointerBytes === null || previousPointerBytes === undefined) {
    await retryTransientFileOperation(() => rm(pointerPath, { force: true }));
    return { pointer_file: pointerPath, restored: false };
  }
  const previousText = Buffer.isBuffer(previousPointerBytes)
    ? previousPointerBytes.toString("utf8")
    : String(previousPointerBytes);
  const previous = JSON.parse(previousText);
  resolveClosureDocumentSync(root, previous, normalizedIdentity(previous), { requireSemanticMaintenance: false });
  const tempPath = `${pointerPath}.${process.pid}.${Date.now()}.rollback.tmp`;
  try {
    await retryTransientFileOperation(() => writeFile(tempPath, previousText, { encoding: "utf8", flag: "wx" }));
    await lease.renew();
    await lease.assertOwnership();
    await retryTransientFileOperation(() => rename(tempPath, pointerPath));
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
  return { pointer_file: pointerPath, restored: true, pointer: previous };
}

export async function synchronizeRankingClosureCompatibilityMirrors({
  rootDir,
  identity,
  lease,
  activators = {},
} = {}) {
  const root = path.resolve(rootDir);
  if (!lease || path.resolve(lease.rootDir || "") !== root) {
    throw new Error("Ranking compatibility mirror synchronization requires the live-ranking lifecycle lease for the same root");
  }
  const expected = normalizedIdentity(identity);
  const active = resolveActiveRankingClosureSync({ rootDir: root, expectedIdentity: expected });
  if (active.availability !== "available" || active.closure_status !== "available") {
    throw new Error(`Ranking compatibility mirrors require an authoritative active closure: ${active.reason || active.closure_status}`);
  }
  const activateRanking = activators.activateRanking || activateLiveRankingGeneration;
  const activateRecipe = activators.activateRecipe || activateRankingRecipeGeneration;
  const synchronizeAdditionalMirrors = activators.synchronizeAdditionalMirrors || null;
  const errors = [];
  let ranking = null;
  let recipe = null;
  try {
    ranking = await activateRanking({
      rootDir: root,
      generationId: active.ranking_generation_id,
      lease,
    });
    if (ranking?.pointer?.generation_id !== active.ranking_generation_id) {
      throw new Error(`active-generation mirror activated ${ranking?.pointer?.generation_id || "missing"}; expected ${active.ranking_generation_id}`);
    }
  } catch (error) {
    ranking = null;
    errors.push({ mirror: "active-generation", error: error?.message || String(error) });
  }
  try {
    recipe = await activateRecipe({
      rootDir: root,
      target: expected,
      generation: { generation_id: active.recipe_generation_id },
      lease,
    });
    if (recipe?.pointer?.generation_id !== active.recipe_generation_id) {
      throw new Error(`active-recipe-generation mirror activated ${recipe?.pointer?.generation_id || "missing"}; expected ${active.recipe_generation_id}`);
    }
  } catch (error) {
    recipe = null;
    errors.push({ mirror: "active-recipe-generation", error: error?.message || String(error) });
  }
  let current = null;
  try {
    current = await synchronizeCurrentRankingMirror({ rootDir: root, active, lease });
  } catch (error) {
    errors.push({ mirror: "current-directory", error: error?.message || String(error) });
  }
  let additional = null;
  if (synchronizeAdditionalMirrors) {
    try {
      additional = await synchronizeAdditionalMirrors({ active, identity: expected, lease });
    } catch (error) {
      errors.push({ mirror: "additional-compatibility-mirrors", error: error?.message || String(error) });
    }
  }
  return {
    status: errors.length ? "degraded" : "ready",
    authoritative_closure: active.pointer,
    ranking,
    recipe,
    current,
    additional,
    errors,
  };
}
