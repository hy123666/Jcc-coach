import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  loadActiveGameKnowledgeProfileSync,
  validateGameKnowledgeRuntimeIdentity,
} from "../../tools/jcc_game_knowledge_profile_store.mjs";
import { resolveActiveRankingClosureSync } from "../../tools/jcc_live_rankings_active_closure.mjs";
import { stableDecisionInputSourceJson } from "./decision-input-catalog.js";

export const runtimeStoreContract = {
  schema: "jcc-runtime-state-store-v5",
  owner: "jcc-runtime-orchestrator",
  host_cli_policy: "host_cli_is_thin_adapter_not_state_owner",
  storage_policy: "JCC runtime owns durable state in app.sqlite; legacy JSON files are compatibility mirrors or debug exports only.",
  override_env: "JCC_RUNTIME_DATA_DIR",
  database_file: "app.sqlite",
  sqlite_runtime: "node:sqlite",
  legacy_json_policy: "compatibility_mirror_or_debug_export_only",
  queue_policy: "daemon_managed_claim_complete_fail_retry_recover_with_fencing",
  strategy_wiki_policy: "raw evidence events are immutable; host-model wiki pages are version-scoped drafts/published pages with source_event_ids and stale/archived guards.",
};

function serializedAudit(value) {
  const serialized = JSON.stringify(value ?? null);
  return {
    original_payload_bytes: Buffer.byteLength(serialized, "utf8"),
    original_payload_hash: createHash("sha256").update(serialized).digest("hex"),
  };
}

export function canonicalHostRequestRef(hostRequest, responseTaskId = null) {
  if (!hostRequest || typeof hostRequest !== "object" || Array.isArray(hostRequest)) return null;
  if (hostRequest.schema === "jcc-host-request-ref-v1") {
    return {
      schema: "jcc-host-request-ref-v1",
      request_id: hostRequest.request_id || null,
      request_hash: hostRequest.request_hash || null,
      response_task_id: responseTaskId || hostRequest.response_task_id || null,
      match_session_id: hostRequest.match_session_id || null,
      mode: hostRequest.mode || null,
      request_kind: hostRequest.request_kind || null,
      origin_action_id: hostRequest.origin_action_id || null,
      evidence_policy_id: hostRequest.evidence_policy_id || null,
      task_type: hostRequest.task_type || null,
      stage_round: hostRequest.stage_round || null,
      capsule_ref: hostRequest.capsule_ref || null,
      data_ref: {
        stat_date: hostRequest.data_ref?.stat_date || null,
        season_id: hostRequest.data_ref?.season_id || null,
        patch_id: hostRequest.data_ref?.patch_id || null,
        package_id: hostRequest.data_ref?.package_id || null,
      },
      decision_snapshot_fingerprint: hostRequest.decision_snapshot_fingerprint || null,
      original_payload_bytes: Number(hostRequest.original_payload_bytes || 0),
      original_payload_hash: hostRequest.original_payload_hash || null,
      policy: "metadata_only_full_payload_lives_only_for_the_active_provider_turn",
    };
  }
  const runtimeContext = hostRequest.runtime_context || hostRequest.context?.runtime_context || {};
  const liveState = hostRequest.context?.live_state_summary || hostRequest.context?.live_state || {};
  const dailyBigData = hostRequest.daily_big_data || hostRequest.context?.daily_big_data || runtimeContext.daily_big_data || {};
  const dataRef = hostRequest.data_ref || {};
  return {
    schema: "jcc-host-request-ref-v1",
    request_id: hostRequest.request_id || hostRequest.response_id || hostRequest.host_cli_agent_request?.request_id || null,
    request_hash: hostRequest.request_hash || hostRequest.host_cli_agent_request?.request_hash || null,
    response_task_id: responseTaskId || hostRequest.response_task_id || null,
    match_session_id: hostRequest.match_session_id || runtimeContext.match_session?.match_session_id || null,
    mode: hostRequest.mode || hostRequest.context?.mode || null,
    request_kind: hostRequest.request_kind || null,
    origin_action_id: hostRequest.origin_action_id || null,
    evidence_policy_id: hostRequest.evidence_policy_id || null,
    task_type: hostRequest.task_type || hostRequest.task?.type || null,
    stage_round: hostRequest.stage_round
      || runtimeContext.current_turn_contract?.stage_round
      || runtimeContext.decision_snapshot?.stage_round
      || liveState.phase?.stage_round
      || null,
    capsule_ref: hostRequest.capsule_ref || null,
    data_ref: {
      stat_date: dataRef.stat_date || dailyBigData.stat_date || null,
      season_id: dataRef.season_id || hostRequest.season_id || runtimeContext.season_id || null,
      patch_id: dataRef.patch_id || hostRequest.patch_id || runtimeContext.patch_id || null,
      package_id: dataRef.package_id || hostRequest.package_id || runtimeContext.package_id || null,
    },
    decision_snapshot_fingerprint: hostRequest.decision_snapshot_fingerprint
      || runtimeContext.decision_snapshot?.snapshot_fingerprint
      || null,
    ...serializedAudit(hostRequest),
    policy: "metadata_only_full_payload_lives_only_for_the_active_provider_turn",
  };
}

export function sanitizeCanonicalPersistenceValue(value, context = {}) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCanonicalPersistenceValue(entry, context));
  }
  if (!value || typeof value !== "object") return value;
  const responseTaskId = value.response_task_id || context.responseTaskId || null;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === "host_request" && entry && typeof entry === "object" && !Array.isArray(entry)
      ? canonicalHostRequestRef(entry, responseTaskId)
      : sanitizeCanonicalPersistenceValue(entry, { responseTaskId }),
  ]));
}

function validateRuntimeIdentitySource(root, runtimeIdentity, label, { expectedSourceIdentity = null } = {}) {
  const identity = validateGameKnowledgeRuntimeIdentity(runtimeIdentity, { label });
  const manifestPath = path.resolve(root, identity.hard_data_manifest);
  const manifestRelativePath = path.relative(root, manifestPath);
  if (manifestRelativePath.startsWith("..") || path.isAbsolute(manifestRelativePath)) {
    throw new Error(`${label} hard-data manifest must stay inside the JCC runtime repository: ${manifestPath}`);
  }
  if (!existsSync(manifestPath)) throw new Error(`${label} hard-data manifest is missing: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${label} hard-data manifest is invalid: ${manifestPath}: ${error.message || String(error)}`);
  }
  const hasSeparatedSourceIdentity = Boolean(manifest?.source_package_id && manifest?.upstream_provenance);
  const upstream = hasSeparatedSourceIdentity ? manifest.upstream_provenance : manifest;
  const expectedManifestFields = {
    packageId: hasSeparatedSourceIdentity ? identity.package_id : identity.source_package_id,
    ...(hasSeparatedSourceIdentity ? { source_package_id: identity.source_package_id } : {}),
    runtime_patch_id: identity.patch_id,
  };
  for (const [field, expected] of Object.entries(expectedManifestFields)) {
    if (String(manifest?.[field] || "") !== String(expected)) {
      throw new Error(`${label} hard-data manifest ${field} does not match runtime identity: ${manifestPath}`);
    }
  }
  if (hasSeparatedSourceIdentity) {
    const expectedLocalIdentity = {
      season_id: identity.season_id,
      patch_id: identity.patch_id,
      mode_id: identity.game_mode_id.replace(/^jcc-/, ""),
    };
    for (const [field, expected] of Object.entries(expectedLocalIdentity)) {
      if (String(manifest?.identity?.[field] || "") !== String(expected)) {
        throw new Error(`${label} hard-data local identity ${field} does not match runtime identity: ${manifestPath}`);
      }
    }
  }
  const expectedUpstreamFields = {
    mode: identity.upstream_identity.mode,
    season: identity.upstream_identity.season,
    version: identity.upstream_identity.version,
    framework_name: identity.upstream_identity.framework_name,
  };
  const actualUpstreamFields = {
    mode: upstream?.mode,
    season: upstream?.season || upstream?.season_id,
    version: upstream?.version || upstream?.data_version,
    framework_name: upstream?.framework_name || upstream?.modeName,
  };
  for (const [field, expected] of Object.entries(expectedUpstreamFields)) {
    if (String(actualUpstreamFields[field] || "") !== String(expected)) {
      throw new Error(`${label} hard-data upstream ${field} does not match runtime identity: ${manifestPath}`);
    }
  }
  if (identity.game_mode_id !== `jcc-mode${manifest.mode}`) {
    throw new Error(`${label} game_mode_id does not match hard-data manifest mode: ${manifestPath}`);
  }
  const expectedManifestFingerprint = String(expectedSourceIdentity?.hard_data_manifest_fingerprint || "").trim();
  if (expectedManifestFingerprint) {
    const actualManifestFingerprint = createHash("sha256")
      .update(stableDecisionInputSourceJson(manifest))
      .digest("hex");
    if (actualManifestFingerprint !== expectedManifestFingerprint) {
      throw new Error(`${label} hard-data manifest fingerprint does not match immutable Core Profile metadata: ${manifestPath}`);
    }
  }
  return Object.freeze({ identity, manifestPath, manifest: Object.freeze(manifest) });
}

function compatibleRankingGeneration(activeRankingGeneration, activeCoreProfile, activeRuntimeIdentity) {
  if (!activeRankingGeneration?.generation_dir) return null;
  try {
    const strategyIndex = JSON.parse(readFileSync(
      path.join(activeRankingGeneration.generation_dir, "lineup-strategy-index.json"),
      "utf8",
    ).replace(/^\uFEFF/, ""));
    const source = strategyIndex?.source_identity || {};
    const coreSource = activeCoreProfile?.decisionInputCatalog?.source_identity || {};
    const expected = {
      runtime_season_id: activeRuntimeIdentity.season_id,
      active_patch_id: activeRuntimeIdentity.patch_id,
      game_mode_id: activeRuntimeIdentity.game_mode_id,
      package_id: activeRuntimeIdentity.package_id,
      core_profile_id: activeCoreProfile?.active?.core_profile_id,
      hard_data_manifest_fingerprint: coreSource.hard_data_manifest_fingerprint,
      catalog_source_fingerprint: coreSource.catalog_source_fingerprint,
    };
    if (Object.entries(expected).some(([field, value]) => !String(value || "") || String(source[field] || "") !== String(value))) {
      return null;
    }
    const binding = Object.freeze({
      core_profile_id: String(source.core_profile_id),
      season_id: String(source.runtime_season_id),
      patch_id: String(source.active_patch_id),
      catalog_fingerprint: String(source.catalog_source_fingerprint),
      hard_data_manifest_fingerprint: String(source.hard_data_manifest_fingerprint),
    });
    return Object.freeze({
      ...activeRankingGeneration,
      pointer: Object.freeze({
        ...activeRankingGeneration.pointer,
        binding,
      }),
    });
  } catch {
    return null;
  }
}

function resolveRuntimeDataRoot(repoRoot, options = {}) {
  const explicit = options.dataRoot || process.env.JCC_RUNTIME_DATA_DIR;
  return explicit ? path.resolve(explicit) : path.join(repoRoot, ".jcc-runtime-data");
}

function compactActiveRankingClosure(value) {
  if (!value || typeof value !== "object") return value || null;
  return {
    availability: value.availability || "unavailable",
    closure_status: value.closure_status || null,
    reason: value.reason || null,
    core_profile_id: value.core_profile_id || null,
    season_id: value.season_id || null,
    patch_id: value.patch_id || null,
    stat_date: value.stat_date || null,
    ranking_generation_id: value.ranking_generation_id || null,
    recipe_generation_id: value.recipe_generation_id || null,
    published_at: value.published_at || value.pointer?.published_at || null,
    legacy_fallback: value.legacy_fallback === true,
    pointer: value.pointer ? structuredClone(value.pointer) : null,
    ranking: value.ranking
      ? {
          generation_id: value.ranking.generation_id || value.ranking.pointer?.generation_id || null,
          generation_dir: value.ranking.generation_dir || null,
          pointer: value.ranking.pointer ? structuredClone(value.ranking.pointer) : null,
        }
      : null,
    recipe: value.recipe
      ? {
          generation_id: value.recipe.generation_id || null,
          stat_date: value.recipe.stat_date || null,
          generation_file: value.recipe.generation_file || null,
          freshness: value.recipe.freshness ? structuredClone(value.recipe.freshness) : null,
        }
      : null,
  };
}

export function createRuntimeStoragePaths(repoRoot, options = {}) {
  const root = path.resolve(repoRoot);
  const runtimeDataRoot = resolveRuntimeDataRoot(root, options);
  return {
    repoRoot: root,
    runtimeDataRoot,
    stateDir: path.join(runtimeDataRoot, "state"),
    currentWatchDir: path.join(runtimeDataRoot, "runtime-evidence", "mumu-gi-live", "current-watch"),
    legacyStateDir: path.join(root, ".omx", "state"),
  };
}

export function createRuntimePaths(repoRoot, options = {}) {
  const storage = createRuntimeStoragePaths(repoRoot, options);
  const { repoRoot: root, runtimeDataRoot, stateDir, currentWatchDir } = storage;
  const runtimeEvidenceDir = path.join(runtimeDataRoot, "runtime-evidence");
  const uiRuntimeDir = path.join(runtimeEvidenceDir, "ui-runtime");
  const liveRankingsRoot = path.resolve(options.liveRankingsRoot || path.join(root, "data", "live-rankings", "jcc"));
  const legacyLiveRankingsCurrentDir = path.join(liveRankingsRoot, "current");
  const gameKnowledgeRoot = path.join(root, "data", "game-knowledge", "jcc");
  const activeCoreProfile = loadActiveGameKnowledgeProfileSync({ knowledgeRoot: gameKnowledgeRoot });
  const coreIdentitySelection = validateRuntimeIdentitySource(
    root,
    activeCoreProfile.runtimeIdentity,
    "Active Core Profile runtime identity",
    { expectedSourceIdentity: activeCoreProfile?.decisionInputCatalog?.source_identity || null },
  );
  const activeRuntimeIdentity = coreIdentitySelection.identity;
  const rankingIdentity = {
    core_profile_id: activeCoreProfile?.active?.core_profile_id,
    season_id: activeRuntimeIdentity.season_id,
    patch_id: activeRuntimeIdentity.patch_id,
    catalog_fingerprint: activeCoreProfile?.decisionInputCatalog?.source_identity?.catalog_source_fingerprint,
    hard_data_manifest_fingerprint: activeCoreProfile?.decisionInputCatalog?.source_identity?.hard_data_manifest_fingerprint,
  };
  const activeRankingClosure = resolveActiveRankingClosureSync({
    rootDir: liveRankingsRoot,
    expectedIdentity: rankingIdentity,
    reuseValidated: true,
  });
  const publishedRankingGeneration = activeRankingClosure.availability === "available"
    ? activeRankingClosure.ranking
    : null;
  const activeRankingGeneration = compatibleRankingGeneration(
    publishedRankingGeneration,
    activeCoreProfile,
    activeRuntimeIdentity,
  );
  const liveRankingsCurrentDir = activeRankingGeneration?.generation_dir
    || path.join(liveRankingsRoot, "unavailable", activeCoreProfile.active.core_profile_id);
  const runtimeIdentityAuthority = "core_profile";
  const seasonId = String(activeRuntimeIdentity.season_id);
  const activePatchId = String(activeRuntimeIdentity.patch_id);
  const hardDataManifest = String(activeRuntimeIdentity.hard_data_manifest);
  const seasonPatchDir = path.dirname(path.join(root, hardDataManifest));
  const seasonDataDir = path.join(seasonPatchDir, "normalized");
  const seasonKnowledgeDir = path.join(root, "data", "game-knowledge", "jcc", "seasons", seasonId);
  const activePatchRulesDir = path.join(seasonKnowledgeDir, "patches", activePatchId);
  return {
    repoRoot: root,
    runtimeDataRoot,
    sqliteFile: path.join(runtimeDataRoot, "app.sqlite"),
    stateDir,
    runtimeEvidenceDir,
    uiRuntimeDir,
    currentWatchDir,
    legacyRuntimeDataRoot: path.join(root, ".omx"),
    legacyStateDir: storage.legacyStateDir,
    legacyUiStateFile: path.join(root, ".omx", "state", "jcc-ui-runtime-state.json"),
    currentSessionFile: path.join(stateDir, "jcc-current-match-session.json"),
    gameKnowledgeGenerationLeaseFile: path.join(stateDir, "jcc-game-knowledge-generation-leases.json"),
    uiStateFile: path.join(stateDir, "jcc-ui-runtime-state.json"),
    userSettingsFile: path.join(stateDir, "jcc-runtime-user-settings.json"),
    userMemoryFile: path.join(stateDir, "jcc-runtime-user-memory.json"),
    matchContextFile: path.join(stateDir, "jcc-runtime-match-context.json"),
    liveRankingsCurrentDir,
    legacyLiveRankingsCurrentDir,
    liveRankingsRoot,
    activeRankingGenerationId: activeRankingGeneration?.pointer?.generation_id || null,
    activeRankingGenerationFingerprint: activeRankingGeneration?.pointer?.content_sha256 || null,
    activeRankingGenerationStatDate: activeRankingGeneration?.pointer?.stat_date || null,
    activeRankingGenerationPointer: activeRankingGeneration?.pointer || null,
    activeRankingClosure: compactActiveRankingClosure(activeRankingClosure),
    liveRankingsManifestFile: path.join(liveRankingsCurrentDir, "manifest.json"),
    liveRankingsAuditFile: path.join(liveRankingsCurrentDir, "audit.json"),
    liveRankingsRankSignalFile: path.join(liveRankingsCurrentDir, "rank-signal.json"),
    liveRankingsStrategyIndexFile: path.join(liveRankingsCurrentDir, "lineup-strategy-index.json"),
    liveRankingsLatestDiffFile: path.join(liveRankingsCurrentDir, "latest-diff.json"),
    mumuCatalogOverlayFile: activeCoreProfile?.runtimeCatalogOverlayFile
      || path.join(root, "data", "runtime", "jcc", "mumu-catalog-overlay.json"),
    legacyMumuCatalogOverlayFile: path.join(root, "data", "runtime", "jcc", "mumu-catalog-overlay.json"),
    hostRequestContextPolicyContractFile: path.join(root, "data", "runtime", "jcc", "host-request-context-policy-contract.json"),
    coachSignatureContractFile: path.join(root, "data", "runtime", "jcc", "host-coach-signature-contract.json"),
    runtimeCommonChoiceContractFile: path.join(root, "data", "runtime", "jcc", "common-choice-runtime-contract.json"),
    runtimeSeasonContractFile: path.join(root, "data", "runtime", "jcc", "runtime-season-module-contract.json"),
    activeHardDataManifest: hardDataManifest,
    gameKnowledgeRoot,
    activeCoreProfileFile: activeCoreProfile?.activeFile || null,
    activeCoreProfileBundleFile: activeCoreProfile?.bundleFile || null,
    activeDecisionInputCatalogFile: activeCoreProfile?.decisionInputCatalogFile || null,
    activeDecisionInputCatalogSourceIdentity: activeCoreProfile?.decisionInputCatalog?.source_identity || null,
    activeDecisionInputAugmentStageAuthorityFile: activeCoreProfile?.augmentStageAuthorityFile || null,
    activeRuntimeCatalogOverlayFile: activeCoreProfile?.runtimeCatalogOverlayFile || null,
    activeSemanticFeatureIndexFile: activeCoreProfile?.semanticFeatureIndexFile || null,
    activeCoreProfileId: activeCoreProfile?.active?.core_profile_id || null,
    activeCoreProfile: activeCoreProfile?.active || null,
    activeCoreKnowledgeBundle: activeCoreProfile?.bundle || null,
    activeRuntimeIdentity,
    activeRuntimeIdentityAuthority: runtimeIdentityAuthority,
    activePromotionTuple: {
      season_id: seasonId,
      active_patch_id: activePatchId,
      game_mode_id: activeRuntimeIdentity.game_mode_id,
      package_id: activeRuntimeIdentity.package_id,
      source_package_id: activeRuntimeIdentity.source_package_id,
      hard_data_manifest: hardDataManifest,
      core_profile_id: activeCoreProfile?.active?.core_profile_id || null,
      upstream_identity: activeRuntimeIdentity.upstream_identity,
    },
    activeSeasonId: seasonId,
    activePatchId,
    activeGameModeId: activeRuntimeIdentity.game_mode_id,
    activePackageId: activeRuntimeIdentity.package_id,
    activeSourcePackageId: activeRuntimeIdentity.source_package_id,
    upstreamVersionIdentity: activeRuntimeIdentity.upstream_identity,
    seasonPatchStrategyFile: path.join(activePatchRulesDir, "strategy-overrides.json"),
    seasonPatchRuleOverridesFile: path.join(activePatchRulesDir, "rule-overrides.json"),
    seasonDataDir,
    perMatchVariablesFile: path.join(seasonDataDir, "per_match_variables.json"),
  };
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      const backup = `${file}.corrupt-${Date.now()}.bak`;
      await rename(file, backup).catch(() => {});
      return fallback;
    }
    throw error;
  }
}

export async function readDurableJson(file, fallback = null) {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      const backup = `${file}.corrupt-${Date.now()}.bak`;
      try {
        await rename(file, backup);
      } catch (backupError) {
        throw new Error(`Durable JSON is corrupt and backup failed: ${file}; backup_error=${backupError?.message || backupError}`);
      }
      const durableError = new Error(`Durable JSON is corrupt: ${file}; backup=${backup}`);
      durableError.code = "JCC_DURABLE_JSON_CORRUPT";
      durableError.backup = backup;
      throw durableError;
    }
    throw error;
  }
}

export async function writeJsonAtomic(file, value) {
  const resolved = path.resolve(file);
  await ensureDir(path.dirname(resolved));
  const temp = `${resolved}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await retryTransientFileOperation(() => rename(temp, resolved));
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export function isTransientWindowsFileLock(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(code)
    || /operation not permitted|resource busy|being used|access is denied|directory not empty/i.test(message);
}

async function retryTransientFileOperation(operation, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 12);
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs) || 25);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || 350);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientWindowsFileLock(error) || attempt === attempts - 1) throw error;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export async function writeLegacyJsonMirror(file, value) {
  return writeJsonAtomic(file, {
    ...(value && typeof value === "object" && !Array.isArray(value) ? value : { value }),
    _runtime_storage_note: {
      canonical_store: "app.sqlite",
      json_role: "legacy_compatibility_mirror_or_debug_export",
      written_at: nowIso(),
    },
  });
}

function nowIso() {
  return new Date().toISOString();
}

function stableHash(value) {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

const RUNTIME_EVENT_PAYLOAD_MAX_BYTES = 64 * 1024;
export const RUNTIME_QUEUE_PAYLOAD_MAX_BYTES = 256 * 1024;
export const RUNTIME_QUEUE_ERROR_MAX_BYTES = 256 * 1024;
export const RUNTIME_LOG_MESSAGE_MAX_BYTES = 64 * 1024;
export const RUNTIME_LOG_CONTEXT_MAX_BYTES = 256 * 1024;
export const RUNTIME_EVENT_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
export const RUNTIME_TERMINAL_QUEUE_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
export const RUNTIME_LOG_TOTAL_MAX_BYTES = 4 * 1024 * 1024;

function serializeWithinUtf8Budget(value, maxBytes, label) {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxBytes) {
    throw new RangeError(`${label} exceeds the ${maxBytes}-byte UTF-8 limit (${bytes} bytes)`);
  }
  return serialized;
}

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const kept = [];
  let bytes = 0;
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > maxBytes) break;
    kept.push(codePoint);
    bytes += codePointBytes;
  }
  return kept.join("");
}

function boundedQueueError(error, maxBytes = RUNTIME_QUEUE_ERROR_MAX_BYTES) {
  const normalized = sanitizeCanonicalPersistenceValue(error || {});
  const serialized = JSON.stringify(normalized);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= maxBytes) return serialized;
  return serializeWithinUtf8Budget({
    schema: "jcc-runtime-bounded-queue-error-v1",
    error_truncated: true,
    original_error_bytes: originalBytes,
    original_error_hash: createHash("sha256").update(serialized).digest("hex"),
    code: normalized?.code ? truncateUtf8(normalized.code, 1024) : null,
    name: normalized?.name ? truncateUtf8(normalized.name, 1024) : null,
    message: normalized?.message
      ? truncateUtf8(normalized.message, 16 * 1024)
      : normalized?.reason
        ? truncateUtf8(normalized.reason, 16 * 1024)
        : null,
  }, maxBytes, "runtime queue error");
}

function boundedLogContext(payload, maxBytes = RUNTIME_LOG_CONTEXT_MAX_BYTES) {
  const normalized = sanitizeCanonicalPersistenceValue(payload);
  const serialized = JSON.stringify(normalized);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= maxBytes) return serialized;
  return serializeWithinUtf8Budget({
    schema: "jcc-runtime-bounded-log-context-v1",
    context_truncated: true,
    original_context_bytes: originalBytes,
    original_context_hash: createHash("sha256").update(serialized).digest("hex"),
  }, maxBytes, "runtime log context");
}

function boundedEventPayload(payload, maxBytes = RUNTIME_EVENT_PAYLOAD_MAX_BYTES) {
  const normalized = payload && typeof payload === "object" ? payload : { value: payload };
  const serialized = JSON.stringify(normalized);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= maxBytes) return normalized;
  const identity = {};
  for (const key of [
    "schema",
    "type",
    "action",
    "source",
    "status",
    "reason",
    "error",
    "match_session_id",
    "response_task_id",
    "request_id",
    "event_key",
    "stage_round",
    "mode",
  ]) {
    const value = normalized[key];
    if (value === undefined || value === null) continue;
    identity[key] = typeof value === "string" ? value.slice(0, 1000) : value;
  }
  return {
    schema: "jcc-runtime-bounded-event-payload-v1",
    ...identity,
    payload_truncated: true,
    original_payload_bytes: originalBytes,
    original_payload_hash: createHash("sha256").update(serialized).digest("hex"),
  };
}

function parseJsonText(text, fallback = null) {
  if (text === undefined || text === null || text === "") return fallback;
  return JSON.parse(String(text).replace(/^\uFEFF/, ""));
}

function boundedPostgameScalar(value, maxStringLength = 300) {
  if (typeof value === "string") return value.slice(0, maxStringLength);
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function boundedPostgameSummary(summary, maxBytes = 256 * 1024) {
  if (!summary || typeof summary !== "object") return null;
  const serialized = JSON.stringify(summary);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return summary;
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  const compacted = {
    schema: "jcc-postgame-decision-summary-v1",
    match_session_id: String(summary.match_session_id || "").slice(0, 200) || null,
    started_at: String(summary.started_at || "").slice(0, 80) || null,
    ended_at: String(summary.ended_at || "").slice(0, 80) || null,
    closed_reason: String(summary.closed_reason || "").slice(0, 120) || null,
    result_rank: summary.result_rank !== null && summary.result_rank !== undefined && Number.isFinite(Number(summary.result_rank))
      ? Number(summary.result_rank)
      : null,
    economy_milestones: Object.fromEntries(Object.entries(summary.economy_milestones || {}).slice(0, 8).map(([key, value]) => [
      String(key).slice(0, 80),
      boundedPostgameScalar(value),
    ])),
    target_plan_history: [],
    confirmed_choices: [],
    equipment_summary: {},
    advice_tasks: [],
    user_confirmations: [],
    review_tags: [],
    storage_policy: {
      store_structured_decision_summary_only: true,
      store_raw_screenshots: false,
      store_full_raw_logs: false,
      store_full_live_state: false,
      max_recent_matches: 20,
      compacted_to_budget: true,
      serialized_hard_limit_kb: 256,
      original_serialized_bytes: originalBytes,
      state_store_guard_applied: true,
    },
  };
  if (Buffer.byteLength(JSON.stringify(compacted), "utf8") <= maxBytes) return compacted;
  return {
    schema: "jcc-postgame-decision-summary-v1",
    match_session_id: String(summary.match_session_id || "").slice(0, 200) || null,
    started_at: String(summary.started_at || "").slice(0, 80) || null,
    ended_at: String(summary.ended_at || "").slice(0, 80) || null,
    closed_reason: String(summary.closed_reason || "").slice(0, 120) || null,
    result_rank: summary.result_rank !== null && summary.result_rank !== undefined && Number.isFinite(Number(summary.result_rank))
      ? Number(summary.result_rank)
      : null,
    economy_milestones: {},
    target_plan_history: [],
    confirmed_choices: [],
    equipment_summary: {},
    advice_tasks: [],
    user_confirmations: [],
    review_tags: [],
    storage_policy: {
      store_structured_decision_summary_only: true,
      store_raw_screenshots: false,
      store_full_raw_logs: false,
      store_full_live_state: false,
      max_recent_matches: 20,
      compacted_to_budget: true,
      serialized_hard_limit_kb: 256,
      original_serialized_bytes: originalBytes,
      state_store_guard_applied: true,
      minimal_fallback: true,
    },
  };
}

function queueRowToObject(row) {
  return {
    id: row.id,
    queue_name: row.queue_name,
    status: row.status,
    payload: parseJsonText(row.payload_json, {}),
    attempts: Number(row.attempts || 0),
    max_attempts: Number(row.max_attempts || 3),
    locked_by: row.locked_by || null,
    locked_at: row.locked_at || null,
    lease_token: row.lease_token || null,
    lease_generation: Number(row.lease_generation || 0),
    available_at: row.available_at || null,
    completed_at: row.completed_at || null,
    error: parseJsonText(row.error_json, null),
    scope_type: row.scope_type || null,
    scope_session_id: row.scope_session_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function queueLeaseMatches(item, { workerId = null, leaseToken = null, leaseGeneration = null } = {}) {
  if (!item || item.status !== "running") return false;
  if (!leaseToken || String(leaseToken) !== String(item.lease_token || "")) return false;
  if (!Number.isInteger(Number(leaseGeneration)) || Number(leaseGeneration) !== Number(item.lease_generation || 0)) return false;
  if (workerId && String(workerId) !== String(item.locked_by || "")) return false;
  return true;
}

function wikiPageRowToObject(row) {
  return {
    page_id: row.page_id,
    namespace: row.namespace,
    category: row.category,
    season_id: row.season_id || null,
    patch_id: row.patch_id || null,
    scope: row.scope || "unclassified",
    title: row.title,
    status: row.status,
    summary: row.summary || "",
    body_md: row.body_md || "",
    tags: parseJsonText(row.tags_json, []),
    source_event_ids: parseJsonText(row.source_event_ids_json, []),
    confidence: row.confidence || "medium",
    valid_from_patch: row.valid_from_patch || null,
    valid_until_patch: row.valid_until_patch || null,
    stale_reason: row.stale_reason || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function wikiSourceEventRowToObject(row) {
  return {
    id: row.id,
    source_type: row.source_type,
    namespace: row.namespace,
    season_id: row.season_id || null,
    patch_id: row.patch_id || null,
    evidence_hash: row.evidence_hash,
    payload: parseJsonText(row.payload_json, {}),
    created_at: row.created_at,
  };
}

export class JccRuntimeSqliteStore {
  constructor(paths) {
    this.paths = paths;
    this.db = null;
  }

  open() {
    if (this.db) return this;
    mkdirSyncForDatabase(path.dirname(this.paths.sqliteFile));
    this.db = new DatabaseSync(this.paths.sqliteFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS runtime_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_kv (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_sessions (
        session_id TEXT PRIMARY KEY,
        session_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_name TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_queue_name_status_id
        ON runtime_queue(queue_name, status, id);
      CREATE TABLE IF NOT EXISTS runtime_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wiki_source_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        namespace TEXT NOT NULL,
        season_id TEXT,
        patch_id TEXT,
        evidence_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_type, evidence_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_wiki_source_events_scope
        ON wiki_source_events(namespace, season_id, patch_id, id);
      CREATE TABLE IF NOT EXISTS wiki_pages (
        page_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        category TEXT NOT NULL,
        season_id TEXT,
        patch_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        body_md TEXT,
        tags_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        confidence TEXT NOT NULL,
        valid_from_patch TEXT,
        valid_until_patch TEXT,
        stale_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wiki_pages_scope_status
        ON wiki_pages(namespace, season_id, category, status, updated_at);
      CREATE TABLE IF NOT EXISTS wiki_curation_runs (
        run_id TEXT PRIMARY KEY,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
    this.applyMigrations();
    this.ensureWikiScopeColumns();
    return this;
  }

  applyMigrations() {
    this.applyMigration(1, "initial_runtime_kv_events_sessions_queue");
    this.applyMigration(2, "sqlite_is_canonical_with_legacy_json_mirrors");
    this.applyMigration(3, "queue_inspect_structured_logs_and_supervisor_state");
    this.ensureQueueLifecycleColumns();
    this.applyMigration(4, "daemon_managed_queue_claim_retry_recovery");
    this.applyMigration(5, "strategy_wiki_source_events_pages_and_curation_runs");
    this.applyMigration(6, "queue_lease_fencing_tokens");
    this.applyMigration(7, "queue_session_scope_and_match_lifecycle_retention");
  }

  applyMigration(version, name) {
    const existing = this.db.prepare("SELECT version FROM runtime_migrations WHERE version = ?").get(version);
    if (existing) return;
    this.db.prepare(`
      INSERT INTO runtime_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(version, name, nowIso());
  }

  ensureQueueLifecycleColumns() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(runtime_queue)").all().map((column) => column.name));
    const additions = [
      ["attempts", "INTEGER NOT NULL DEFAULT 0"],
      ["max_attempts", "INTEGER NOT NULL DEFAULT 3"],
      ["locked_by", "TEXT"],
      ["locked_at", "TEXT"],
      ["lease_token", "TEXT"],
      ["lease_generation", "INTEGER NOT NULL DEFAULT 0"],
      ["available_at", "TEXT"],
      ["completed_at", "TEXT"],
      ["error_json", "TEXT"],
      ["scope_type", "TEXT"],
      ["scope_session_id", "TEXT"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE runtime_queue ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_queue_claim
        ON runtime_queue(queue_name, status, available_at, id);
      CREATE INDEX IF NOT EXISTS idx_runtime_queue_locked
        ON runtime_queue(status, locked_at);
      CREATE INDEX IF NOT EXISTS idx_runtime_queue_scope_status
        ON runtime_queue(scope_type, scope_session_id, status, id);
    `);
  }

  ensureWikiScopeColumns() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(wiki_pages)").all().map((column) => column.name));
    if (!columns.has("scope")) this.db.exec("ALTER TABLE wiki_pages ADD COLUMN scope TEXT NOT NULL DEFAULT 'unclassified'");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_wiki_pages_scope ON wiki_pages(scope, season_id, patch_id, status)");
    this.db.exec("CREATE TABLE IF NOT EXISTS wiki_snapshots (snapshot_id TEXT PRIMARY KEY, pages_json TEXT NOT NULL, created_at TEXT NOT NULL)");
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  writeJsonRow(key, value, updatedAt = nowIso()) {
    const sanitizedValue = sanitizeCanonicalPersistenceValue(value);
    this.db.prepare(`
      INSERT INTO runtime_kv (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, JSON.stringify(sanitizedValue), updatedAt);
    return sanitizedValue;
  }

  writeEventRow(eventType, payload = {}, createdAt = nowIso()) {
    const boundedPayload = boundedEventPayload(sanitizeCanonicalPersistenceValue(payload));
    const result = this.db.prepare(`
      INSERT INTO runtime_events (event_type, payload_json, created_at)
      VALUES (?, ?, ?)
    `).run(eventType, JSON.stringify(boundedPayload), createdAt);
    return {
      id: Number(result.lastInsertRowid),
      sequence: Number(result.lastInsertRowid),
      event_type: eventType,
      payload: boundedPayload,
      created_at: createdAt,
    };
  }

  setJson(key, value) {
    this.open();
    return this.writeJsonRow(key, value);
  }

  getJson(key, fallback = null) {
    this.open();
    const row = this.db.prepare("SELECT value_json FROM runtime_kv WHERE key = ?").get(key);
    return row ? parseJsonText(row.value_json, fallback) : fallback;
  }

  deleteJson(key) {
    this.open();
    return this.db.prepare("DELETE FROM runtime_kv WHERE key = ?").run(String(key)).changes;
  }

  appendEvent(eventType, payload = {}) {
    this.open();
    return this.writeEventRow(eventType, payload);
  }

  commitRuntimeTransition({
    state,
    responseTask = state?.response_task || { status: "idle" },
    eventType = "runtime_state_changed",
    eventPayload = {},
    failpoint = null,
  } = {}) {
    this.open();
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("commitRuntimeTransition requires a runtime state object");
    }
    const sanitizedState = sanitizeCanonicalPersistenceValue(state);
    const sanitizedResponseTask = sanitizeCanonicalPersistenceValue(responseTask);
    const revision = Math.max(
      0,
      Number(sanitizedResponseTask?.revision ?? sanitizedState.response_task_revision ?? 0) || 0,
    );
    const normalizedTask = parseJsonText(JSON.stringify({
      ...(sanitizedResponseTask && typeof sanitizedResponseTask === "object" ? sanitizedResponseTask : { status: "idle" }),
      revision,
    }), { status: "idle", revision });
    const normalizedState = {
      ...sanitizedState,
      response_task_revision: revision,
      response_task: normalizedTask,
    };
    const timestamp = nowIso();
    let event = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentTaskRow = this.db.prepare("SELECT value_json FROM runtime_kv WHERE key = 'response_task'").get();
      const currentTask = currentTaskRow ? parseJsonText(currentTaskRow.value_json, null) : null;
      const currentRevision = Math.max(0, Number(currentTask?.revision || 0) || 0);
      if (currentTask) {
        const normalizedCurrentTask = {
          ...currentTask,
          revision: currentRevision,
        };
        if (revision < currentRevision) {
          const error = new Error(`stale runtime transition revision ${revision}; canonical revision is ${currentRevision}`);
          error.code = "JCC_RUNTIME_TRANSITION_STALE";
          throw error;
        }
        if (revision === currentRevision && !isDeepStrictEqual(normalizedTask, normalizedCurrentTask)) {
          const error = new Error(`conflicting runtime transition at revision ${revision}`);
          error.code = "JCC_RUNTIME_TRANSITION_CONFLICT";
          throw error;
        }
        if (revision > currentRevision + 1) {
          const error = new Error(`runtime transition revision gap ${currentRevision} -> ${revision}`);
          error.code = "JCC_RUNTIME_TRANSITION_REVISION_GAP";
          throw error;
        }
      }
      this.writeJsonRow("ui_runtime_state", normalizedState, timestamp);
      if (failpoint === "after_state_write") throw new Error("commitRuntimeTransition failpoint: after_state_write");
      this.writeJsonRow("response_task", normalizedTask, timestamp);
      this.writeJsonRow("response_task_revision", revision, timestamp);
      if (failpoint === "after_task_write") throw new Error("commitRuntimeTransition failpoint: after_task_write");
      event = this.writeEventRow(eventType, {
        ...eventPayload,
        response_task_id: normalizedTask.response_task_id || null,
        response_task_status: normalizedTask.status || null,
        response_task_revision: revision,
        response_task_mode: normalizedTask.mode || null,
        match_session_id: normalizedState.match_session?.match_session_id
          || normalizedTask.match_session_id
          || null,
      }, timestamp);
      if (failpoint === "after_event_write") throw new Error("commitRuntimeTransition failpoint: after_event_write");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      state: normalizedState,
      response_task: normalizedTask,
      revision,
      event,
    };
  }

  upsertSession(sessionId, sessionType, status, payload = {}) {
    this.open();
    const timestamp = nowIso();
    const sanitizedPayload = sanitizeCanonicalPersistenceValue(payload);
    this.db.prepare(`
      INSERT INTO runtime_sessions (session_id, session_type, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        session_type = excluded.session_type,
        status = excluded.status,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(sessionId, sessionType, status, JSON.stringify(sanitizedPayload), timestamp, timestamp);
    return { session_id: sessionId, session_type: sessionType, status, updated_at: timestamp };
  }

  closeSession(sessionId, status = "stopped", payload = {}) {
    this.open();
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return null;
    const timestamp = nowIso();
    const current = this.db.prepare(`
      SELECT session_type, payload_json, created_at
      FROM runtime_sessions
      WHERE session_id = ?
    `).get(normalizedSessionId);
    const sessionType = current?.session_type || "match_session";
    const incomingPayload = payload && typeof payload === "object" ? { ...payload } : {};
    if (incomingPayload.postgame_summary) {
      incomingPayload.postgame_summary = boundedPostgameSummary(incomingPayload.postgame_summary);
    }
    const nextPayload = sanitizeCanonicalPersistenceValue({
      ...parseJsonText(current?.payload_json, {}),
      ...incomingPayload,
      match_session_id: normalizedSessionId,
      status,
      closed_at: incomingPayload.closed_at || timestamp,
    });
    this.db.prepare(`
      INSERT INTO runtime_sessions (session_id, session_type, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        status = excluded.status,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      normalizedSessionId,
      sessionType,
      String(status),
      JSON.stringify(nextPayload),
      current?.created_at || timestamp,
      timestamp,
    );
    return { session_id: normalizedSessionId, session_type: sessionType, status, updated_at: timestamp };
  }

  closeOtherActiveMatchSessions(activeSessionId = null, status = "abandoned") {
    this.open();
    const activeId = String(activeSessionId || "").trim() || null;
    const rows = this.db.prepare(`
      SELECT session_id
      FROM runtime_sessions
      WHERE session_type = 'match_session'
        AND status = 'active'
        AND (? IS NULL OR session_id <> ?)
    `).all(activeId, activeId);
    return rows.map((row) => this.closeSession(row.session_id, status, {
      closed_reason: "match_session_no_longer_canonical",
    }));
  }

  pruneClosedMatchSessions(keep = 20) {
    this.open();
    const limit = Math.max(0, Number(keep) || 0);
    const rows = this.db.prepare(`
      SELECT session_id
      FROM runtime_sessions
      WHERE session_type = 'match_session'
        AND status <> 'active'
      ORDER BY updated_at DESC
      LIMIT -1 OFFSET ?
    `).all(limit);
    if (!rows.length) return 0;
    return this.db.prepare(`
      DELETE FROM runtime_sessions
      WHERE session_id IN (${rows.map(() => "?").join(", ")})
    `).run(...rows.map((row) => row.session_id)).changes;
  }

  listRecentMatchSummaries(limit = 20) {
    this.open();
    const rows = this.db.prepare(`
      SELECT session_id, status, payload_json, created_at, updated_at
      FROM runtime_sessions
      WHERE session_type = 'match_session'
        AND status <> 'active'
        AND json_type(payload_json, '$.postgame_summary') = 'object'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(Math.max(0, Math.min(20, Number(limit) || 20)));
    return rows.map((row) => {
      const payload = parseJsonText(row.payload_json, {});
      return {
        ...payload.postgame_summary,
        match_session_id: payload.postgame_summary?.match_session_id || row.session_id,
        session_status: row.status,
        session_created_at: row.created_at,
        session_updated_at: row.updated_at,
      };
    });
  }

  enqueue(queueName, payload = {}, status = "pending", options = {}) {
    this.open();
    const timestamp = nowIso();
    const sanitizedPayload = sanitizeCanonicalPersistenceValue(payload);
    const serializedPayload = serializeWithinUtf8Budget(
      sanitizedPayload,
      RUNTIME_QUEUE_PAYLOAD_MAX_BYTES,
      `runtime queue payload for ${String(queueName)}`,
    );
    const result = this.db.prepare(`
      INSERT INTO runtime_queue
        (queue_name, status, payload_json, created_at, updated_at, attempts, max_attempts, available_at,
         scope_type, scope_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      queueName,
      status,
      serializedPayload,
      timestamp,
      timestamp,
      Number(options.attempts || 0),
      Number(options.maxAttempts || options.max_attempts || 3),
      options.availableAt || options.available_at || timestamp,
      options.scopeType || options.scope_type || null,
      options.scopeSessionId || options.scope_session_id || null,
    );
    return {
      id: Number(result.lastInsertRowid),
      queue_name: queueName,
      status,
      scope_type: options.scopeType || options.scope_type || null,
      scope_session_id: options.scopeSessionId || options.scope_session_id || null,
      created_at: timestamp,
    };
  }

  updateQueueItem(id, status, patch = {}, lease = {}) {
    this.open();
    const existing = this.getQueueItem(id);
    if (!existing) return null;
    if (existing.status === "running" && status === "completed") {
      return this.completeQueueItem(id, patch, lease);
    }
    if (existing.status === "running" && status !== "running") return null;
    if (existing.status === "running" && !queueLeaseMatches(existing, lease)) return null;
    const payload = sanitizeCanonicalPersistenceValue({ ...existing.payload, ...patch });
    const serializedPayload = serializeWithinUtf8Budget(
      payload,
      RUNTIME_QUEUE_PAYLOAD_MAX_BYTES,
      `runtime queue payload for item ${Number(id)}`,
    );
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE runtime_queue
      SET status = ?, payload_json = ?, updated_at = ?
      WHERE id = ?
        AND (? IS NULL OR lease_token = ?)
        AND (? IS NULL OR lease_generation = ?)
    `).run(
      String(status),
      serializedPayload,
      timestamp,
      Number(id),
      existing.status === "running" ? String(lease.leaseToken) : null,
      existing.status === "running" ? String(lease.leaseToken) : null,
      existing.status === "running" ? Number(lease.leaseGeneration) : null,
      existing.status === "running" ? Number(lease.leaseGeneration) : null,
    );
    return result.changes > 0 ? this.getQueueItem(id) : null;
  }

  settleHostRequest(requestId, status, patch = {}) {
    this.open();
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedRequestId) return [];
    const terminalStatus = String(status || "completed");
    const rows = this.db.prepare(`
      SELECT id, payload_json
      FROM runtime_queue
      WHERE queue_name = 'host_request'
        AND status IN ('pending', 'observed', 'retry', 'running')
        AND json_extract(payload_json, '$.request_id') = ?
      ORDER BY id ASC
    `).all(normalizedRequestId);
    if (!rows.length) return [];
    const timestamp = nowIso();
    const update = this.db.prepare(`
      UPDATE runtime_queue
      SET status = ?, payload_json = ?, completed_at = ?, updated_at = ?,
          locked_by = NULL, locked_at = NULL, lease_token = NULL
      WHERE id = ? AND status IN ('pending', 'observed', 'retry', 'running')
    `);
    const settled = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const payload = sanitizeCanonicalPersistenceValue({ ...parseJsonText(row.payload_json, {}), ...patch });
        const serializedPayload = serializeWithinUtf8Budget(
          payload,
          RUNTIME_QUEUE_PAYLOAD_MAX_BYTES,
          `runtime queue payload for item ${Number(row.id)}`,
        );
        const result = update.run(terminalStatus, serializedPayload, timestamp, timestamp, Number(row.id));
        if (result.changes > 0) settled.push(Number(row.id));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return settled;
  }

  getQueueItem(id) {
    this.open();
    const row = this.db.prepare(`
      SELECT id, queue_name, status, payload_json, created_at, updated_at, attempts, max_attempts,
             locked_by, locked_at, lease_token, lease_generation, available_at, completed_at, error_json
             , scope_type, scope_session_id
      FROM runtime_queue
      WHERE id = ?
    `).get(Number(id));
    return row ? queueRowToObject(row) : null;
  }

  claimQueueItem(queueName, { workerId = `worker:${process.pid}`, leaseMs = 30000 } = {}) {
    this.open();
    const timestamp = nowIso();
    const lockedAt = timestamp;
    const lockExpiresAt = new Date(Date.now() + Number(leaseMs)).toISOString();
    const leaseToken = randomUUID();
    let claimedId = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT id
        FROM runtime_queue
        WHERE queue_name = ?
          AND status IN ('pending', 'retry')
          AND (available_at IS NULL OR available_at <= ?)
        ORDER BY id ASC
        LIMIT 1
      `).get(String(queueName), timestamp);
      if (row) {
        const result = this.db.prepare(`
          UPDATE runtime_queue
          SET status = 'running',
              attempts = attempts + 1,
              locked_by = ?,
              locked_at = ?,
              lease_token = ?,
              lease_generation = lease_generation + 1,
              available_at = ?,
              updated_at = ?
          WHERE id = ? AND status IN ('pending', 'retry')
        `).run(String(workerId), lockedAt, leaseToken, lockExpiresAt, timestamp, Number(row.id));
        if (result.changes > 0) claimedId = Number(row.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return claimedId ? this.getQueueItem(claimedId) : null;
  }

  claimQueueItemById(id, { workerId = `worker:${process.pid}`, leaseMs = 30000 } = {}) {
    this.open();
    const timestamp = nowIso();
    const lockExpiresAt = new Date(Date.now() + Number(leaseMs)).toISOString();
    const leaseToken = randomUUID();
    const result = this.db.prepare(`
      UPDATE runtime_queue
      SET status = 'running',
          attempts = attempts + 1,
          locked_by = ?,
          locked_at = ?,
          lease_token = ?,
          lease_generation = lease_generation + 1,
          available_at = ?,
          updated_at = ?
      WHERE id = ? AND status IN ('pending', 'retry')
    `).run(String(workerId), timestamp, leaseToken, lockExpiresAt, timestamp, Number(id));
    return result.changes > 0 ? this.getQueueItem(id) : null;
  }

  completeQueueItem(id, patch = {}, lease = {}) {
    this.open();
    const item = this.getQueueItem(id);
    if (!queueLeaseMatches(item, lease)) return null;
    const payload = sanitizeCanonicalPersistenceValue({ ...item.payload, ...patch });
    const serializedPayload = serializeWithinUtf8Budget(
      payload,
      RUNTIME_QUEUE_PAYLOAD_MAX_BYTES,
      `runtime queue payload for item ${Number(id)}`,
    );
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE runtime_queue
      SET status = 'completed',
          payload_json = ?,
          locked_by = NULL,
          locked_at = NULL,
          lease_token = NULL,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
        AND status = 'running'
        AND lease_token = ?
        AND lease_generation = ?
    `).run(
      serializedPayload,
      timestamp,
      timestamp,
      Number(id),
      String(lease.leaseToken),
      Number(lease.leaseGeneration),
    );
    return result.changes > 0 ? this.getQueueItem(id) : null;
  }

  failQueueItem(id, error = {}, { retryDelayMs = 0, workerId = null, leaseToken = null, leaseGeneration = null } = {}) {
    this.open();
    const item = this.getQueueItem(id);
    if (!queueLeaseMatches(item, { workerId, leaseToken, leaseGeneration })) return null;
    const timestamp = nowIso();
    const shouldRetry = item.attempts < item.max_attempts;
    const status = shouldRetry ? "retry" : "failed";
    const availableAt = shouldRetry
      ? new Date(Date.now() + Number(retryDelayMs || 0)).toISOString()
      : item.available_at;
    const serializedError = boundedQueueError(error);
    const result = this.db.prepare(`
      UPDATE runtime_queue
      SET status = ?,
          locked_by = NULL,
          locked_at = NULL,
          lease_token = NULL,
          available_at = ?,
          error_json = ?,
          updated_at = ?
      WHERE id = ?
        AND status = 'running'
        AND lease_token = ?
        AND lease_generation = ?
    `).run(
      status,
      availableAt,
      serializedError,
      timestamp,
      Number(id),
      String(leaseToken),
      Number(leaseGeneration),
    );
    return result.changes > 0 ? this.getQueueItem(id) : null;
  }

  recoverStaleQueueItems({ staleMs = 60000, limit = 100 } = {}) {
    this.open();
    const cutoff = new Date(Date.now() - Number(staleMs)).toISOString();
    const timestamp = nowIso();
    const rows = this.db.prepare(`
      SELECT id
      FROM runtime_queue
      WHERE status = 'running'
        AND (
          (available_at IS NOT NULL AND available_at <= ?)
          OR (locked_at IS NOT NULL AND locked_at <= ?)
        )
      ORDER BY id ASC
      LIMIT ?
    `).all(timestamp, cutoff, Number(limit));
    const recovered = [];
    for (const row of rows) {
      const item = this.getQueueItem(row.id);
      const status = item.attempts < item.max_attempts ? "retry" : "failed";
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE runtime_queue
        SET status = ?,
            locked_by = NULL,
            locked_at = NULL,
            lease_token = NULL,
            available_at = ?,
            error_json = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        status,
        timestamp,
        boundedQueueError({ code: "STALE_QUEUE_LOCK_RECOVERED", stale_ms: Number(staleMs) }),
        timestamp,
        Number(row.id),
      );
      recovered.push(this.getQueueItem(row.id));
    }
    return recovered;
  }

  settleMatchQueueItems(matchSessionId, {
    status = "cancelled",
    reason = "match_session_closed",
  } = {}) {
    this.open();
    const normalizedMatchSessionId = String(matchSessionId || "").trim();
    if (!normalizedMatchSessionId) return [];
    const timestamp = nowIso();
    const nonterminalStatuses = ["pending", "retry", "running", "requested"];
    const rows = this.db.prepare(`
      SELECT id, payload_json
      FROM runtime_queue
      WHERE status IN (${nonterminalStatuses.map(() => "?").join(", ")})
        AND (
          (scope_type = 'match' AND scope_session_id = ?)
          OR json_extract(payload_json, '$.match_session_id') = ?
          OR json_extract(payload_json, '$.payload.match_session_id') = ?
          OR json_extract(payload_json, '$.request.match_session_id') = ?
        )
      ORDER BY id ASC
    `).all(
      ...nonterminalStatuses,
      normalizedMatchSessionId,
      normalizedMatchSessionId,
      normalizedMatchSessionId,
      normalizedMatchSessionId,
    );
    if (!rows.length) return [];
    const serializedRetirementError = boundedQueueError({
      code: "MATCH_SESSION_QUEUE_RETIRED",
      reason,
      match_session_id: normalizedMatchSessionId,
    });
    const update = this.db.prepare(`
      UPDATE runtime_queue
      SET status = ?, completed_at = ?, updated_at = ?,
          locked_by = NULL, locked_at = NULL, lease_token = NULL,
          error_json = ?
      WHERE id = ?
        AND status IN (${nonterminalStatuses.map(() => "?").join(", ")})
    `);
    const settled = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const result = update.run(
          String(status),
          timestamp,
          timestamp,
          serializedRetirementError,
          Number(row.id),
          ...nonterminalStatuses,
        );
        if (result.changes > 0) settled.push(Number(row.id));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return settled;
  }

  expireStaleNonterminalQueueItems({ staleMs = 6 * 60 * 60 * 1000 } = {}) {
    this.open();
    const cutoff = new Date(Date.now() - Math.max(60000, Number(staleMs) || 0)).toISOString();
    const timestamp = nowIso();
    const nonterminalStatuses = ["pending", "retry", "running", "requested"];
    const result = this.db.prepare(`
      UPDATE runtime_queue
      SET status = 'cancelled', completed_at = ?, updated_at = ?,
          locked_by = NULL, locked_at = NULL, lease_token = NULL,
          error_json = ?
      WHERE status IN (${nonterminalStatuses.map(() => "?").join(", ")})
        AND updated_at < ?
    `).run(
      timestamp,
      timestamp,
      boundedQueueError({ code: "STALE_NONTERMINAL_QUEUE_EXPIRED", stale_ms: Number(staleMs) }),
      ...nonterminalStatuses,
      cutoff,
    );
    return Number(result.changes || 0);
  }

  listQueue({ queueName = null, status = null, limit = 50 } = {}) {
    this.open();
    const clauses = [];
    const args = [];
    if (queueName) {
      clauses.push("queue_name = ?");
      args.push(String(queueName));
    }
    if (status) {
      clauses.push("status = ?");
      args.push(String(status));
    }
    args.push(Number(limit));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT id, queue_name, status, payload_json, created_at, updated_at, attempts, max_attempts,
             locked_by, locked_at, lease_token, lease_generation, available_at, completed_at, error_json
             , scope_type, scope_session_id
      FROM runtime_queue
      ${where}
      ORDER BY id DESC
      LIMIT ?
    `).all(...args);
    return rows.map(queueRowToObject);
  }

  appendLog(level, message, payload = {}) {
    this.open();
    const createdAt = nowIso();
    const boundedMessage = truncateUtf8(message, RUNTIME_LOG_MESSAGE_MAX_BYTES);
    const serializedPayload = boundedLogContext(payload);
    const result = this.db.prepare(`
      INSERT INTO runtime_logs (level, message, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(String(level), boundedMessage, serializedPayload, createdAt);
    return { id: Number(result.lastInsertRowid), level, message: boundedMessage, created_at: createdAt };
  }

  listLogs(limit = 50) {
    this.open();
    const rows = this.db.prepare(`
      SELECT id, level, message, payload_json, created_at
      FROM runtime_logs
      ORDER BY id DESC
      LIMIT ?
    `).all(Number(limit));
    return rows.map((row) => ({
      id: row.id,
      level: row.level,
      message: row.message,
      payload: parseJsonText(row.payload_json, {}),
      created_at: row.created_at,
    }));
  }

  enforceRetentionBudget({
    keepEvents = 2000,
    keepEventBytes = RUNTIME_EVENT_TOTAL_MAX_BYTES,
    keepLogs = 300,
    keepLogBytes = RUNTIME_LOG_TOTAL_MAX_BYTES,
    keepTerminalQueuePerName = 200,
    keepTerminalQueueTotal = 500,
    keepTerminalQueueBytes = RUNTIME_TERMINAL_QUEUE_TOTAL_MAX_BYTES,
    queueOverrides = { advice_task_lifecycle: 20 },
    keepWikiCurationRuns = 50,
    keepUnreferencedWikiSourceEvents = 100,
    wikiPendingMaxAgeMs = 24 * 60 * 60 * 1000,
  } = {}) {
    this.open();
    const expiredNonterminalQueue = this.expireStaleNonterminalQueueItems();
    const expiredWikiCurationRuns = this.expireStaleWikiCurationRuns({ staleMs: wikiPendingMaxAgeMs });
    const deleteTail = (table, idColumn, keep) => {
      const limit = Math.max(0, Number(keep || 0));
      if (limit === 0) {
        return this.db.prepare(`DELETE FROM ${table}`).run().changes;
      }
      return this.db.prepare(`
        DELETE FROM ${table}
        WHERE ${idColumn} NOT IN (
          SELECT ${idColumn}
          FROM ${table}
          ORDER BY ${idColumn} DESC
          LIMIT ?
        )
      `).run(limit).changes;
    };
    const deleteIds = (table, ids) => {
      let deletedCount = 0;
      for (let index = 0; index < ids.length; index += 500) {
        const batch = ids.slice(index, index + 500).map(Number);
        if (!batch.length) continue;
        deletedCount += this.db.prepare(`
          DELETE FROM ${table}
          WHERE id IN (${batch.map(() => "?").join(", ")})
        `).run(...batch).changes;
      }
      return deletedCount;
    };
    const idsOutsideByteBudget = (rows, byteBudget) => {
      const limit = Math.max(0, Number(byteBudget) || 0);
      let retainedBytes = 0;
      const staleIds = [];
      for (const row of rows) {
        const rowBytes = Number(row.row_bytes || 0);
        if (retainedBytes + rowBytes <= limit) retainedBytes += rowBytes;
        else staleIds.push(Number(row.id));
      }
      return staleIds;
    };
    const eventRows = this.db.prepare(`
      SELECT id, length(CAST(payload_json AS BLOB)) AS payload_bytes
      FROM runtime_events
      ORDER BY id DESC
    `).all();
    const deletedEventsByBytes = deleteIds("runtime_events", idsOutsideByteBudget(
      eventRows.map((row) => ({ id: row.id, row_bytes: row.payload_bytes })),
      keepEventBytes,
    ));
    const terminalStatuses = ["completed", "observed", "failed", "cancelled", "superseded"];
    const queueNames = this.db.prepare(`
      SELECT DISTINCT queue_name
      FROM runtime_queue
      WHERE status IN (${terminalStatuses.map(() => "?").join(", ")})
    `).all(...terminalStatuses).map((row) => row.queue_name);
    let deletedTerminalQueue = 0;
    const deletedTerminalQueueByName = {};
    for (const queueName of queueNames) {
      const configuredLimit = Object.prototype.hasOwnProperty.call(queueOverrides || {}, queueName)
        ? Math.max(0, Number(queueOverrides[queueName]) || 0)
        : Math.max(0, Number(keepTerminalQueuePerName) || 0);
      const staleRows = this.db.prepare(`
        SELECT id
        FROM runtime_queue
        WHERE queue_name = ?
          AND status IN (${terminalStatuses.map(() => "?").join(", ")})
        ORDER BY id DESC
        LIMIT -1 OFFSET ?
      `).all(queueName, ...terminalStatuses, configuredLimit);
      let queueDeleted = 0;
      for (let index = 0; index < staleRows.length; index += 500) {
        const ids = staleRows.slice(index, index + 500).map((row) => Number(row.id));
        if (!ids.length) continue;
        queueDeleted += this.db.prepare(`
          DELETE FROM runtime_queue
          WHERE id IN (${ids.map(() => "?").join(", ")})
        `).run(...ids).changes;
      }
      if (queueDeleted) deletedTerminalQueueByName[queueName] = queueDeleted;
      deletedTerminalQueue += queueDeleted;
    }
    const globalTerminalLimit = Math.max(0, Number(keepTerminalQueueTotal) || 0);
    const globallyStaleTerminalRows = this.db.prepare(`
      SELECT id
      FROM runtime_queue
      WHERE status IN (${terminalStatuses.map(() => "?").join(", ")})
      ORDER BY id DESC
      LIMIT -1 OFFSET ?
    `).all(...terminalStatuses, globalTerminalLimit);
    let deletedTerminalQueueGlobal = 0;
    for (let index = 0; index < globallyStaleTerminalRows.length; index += 500) {
      const ids = globallyStaleTerminalRows.slice(index, index + 500).map((row) => Number(row.id));
      if (!ids.length) continue;
      deletedTerminalQueueGlobal += this.db.prepare(`
        DELETE FROM runtime_queue
        WHERE id IN (${ids.map(() => "?").join(", ")})
      `).run(...ids).changes;
    }
    deletedTerminalQueue += deletedTerminalQueueGlobal;
    const terminalQueueRows = this.db.prepare(`
      SELECT id,
             length(CAST(payload_json AS BLOB)) + length(CAST(COALESCE(error_json, '') AS BLOB)) AS row_bytes
      FROM runtime_queue
      WHERE status IN (${terminalStatuses.map(() => "?").join(", ")})
      ORDER BY id DESC
    `).all(...terminalStatuses);
    const deletedTerminalQueueByBytes = deleteIds(
      "runtime_queue",
      idsOutsideByteBudget(terminalQueueRows, keepTerminalQueueBytes),
    );
    deletedTerminalQueue += deletedTerminalQueueByBytes;
    const deletedLogsByCount = deleteTail("runtime_logs", "id", keepLogs);
    const logRows = this.db.prepare(`
      SELECT id,
             length(CAST(message AS BLOB)) + length(CAST(payload_json AS BLOB)) AS row_bytes
      FROM runtime_logs
      ORDER BY id DESC
    `).all();
    const deletedLogsByBytes = deleteIds("runtime_logs", idsOutsideByteBudget(logRows, keepLogBytes));
    const deletedWikiCurationRuns = this.pruneWikiCurationRuns(keepWikiCurationRuns);
    const deletedWikiSourceEvents = this.pruneUnreferencedWikiSourceEvents(keepUnreferencedWikiSourceEvents);
    const deleted = {
      runtime_events: deleteTail("runtime_events", "id", keepEvents) + deletedEventsByBytes,
      runtime_events_by_bytes: deletedEventsByBytes,
      runtime_logs: deletedLogsByCount + deletedLogsByBytes,
      runtime_logs_by_bytes: deletedLogsByBytes,
      runtime_queue_terminal: deletedTerminalQueue,
      runtime_queue_terminal_global: deletedTerminalQueueGlobal,
      runtime_queue_terminal_by_bytes: deletedTerminalQueueByBytes,
      runtime_queue_terminal_by_name: deletedTerminalQueueByName,
      runtime_queue_nonterminal_expired: expiredNonterminalQueue,
      runtime_sessions_closed: this.pruneClosedMatchSessions(20),
      wiki_curation_runs_expired: expiredWikiCurationRuns,
      wiki_curation_runs: deletedWikiCurationRuns,
      wiki_source_events_unreferenced: deletedWikiSourceEvents,
    };
    this.db.exec("PRAGMA optimize");
    return {
      schema: "jcc-runtime-retention-budget-result-v1",
      canonical_store: "app.sqlite",
      deleted,
      kept: {
        runtime_events: Number(keepEvents),
        runtime_event_bytes: Number(keepEventBytes),
        runtime_logs: Number(keepLogs),
        runtime_log_bytes: Number(keepLogBytes),
        runtime_queue_terminal_per_name: Number(keepTerminalQueuePerName),
        runtime_queue_terminal_total: Number(keepTerminalQueueTotal),
        runtime_queue_terminal_bytes: Number(keepTerminalQueueBytes),
        runtime_queue_overrides: queueOverrides,
        wiki_curation_runs: Number(keepWikiCurationRuns),
        wiki_source_events_unreferenced: Number(keepUnreferencedWikiSourceEvents),
        wiki_pending_max_age_ms: Number(wikiPendingMaxAgeMs),
      },
    };
  }

  expireStaleWikiCurationRuns({ staleMs = 24 * 60 * 60 * 1000 } = {}) {
    this.open();
    const cutoff = new Date(Date.now() - Math.max(60_000, Number(staleMs) || 0)).toISOString();
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE wiki_curation_runs
      SET status = 'expired',
          output_json = ?,
          completed_at = ?
      WHERE status NOT IN ('completed', 'failed', 'cancelled', 'expired', 'superseded')
        AND created_at < ?
    `).run(
      JSON.stringify({ code: "STALE_WIKI_CURATION_RUN_EXPIRED", stale_ms: Number(staleMs) }),
      timestamp,
      cutoff,
    );
    return Number(result.changes || 0);
  }

  pruneWikiCurationRuns(keep = 50) {
    this.open();
    const limit = Math.max(0, Number(keep) || 0);
    const terminalStatuses = ["completed", "failed", "cancelled", "expired", "superseded"];
    const rows = this.db.prepare(`
      SELECT run_id
      FROM wiki_curation_runs
      WHERE status IN (${terminalStatuses.map(() => "?").join(", ")})
      ORDER BY COALESCE(completed_at, created_at) DESC, rowid DESC
      LIMIT -1 OFFSET ?
    `).all(...terminalStatuses, limit);
    if (!rows.length) return 0;
    return this.db.prepare(`
      DELETE FROM wiki_curation_runs
      WHERE run_id IN (${rows.map(() => "?").join(", ")})
    `).run(...rows.map((row) => row.run_id)).changes;
  }

  pruneUnreferencedWikiSourceEvents(keep = 100) {
    this.open();
    const protectedIds = new Set();
    for (const row of this.db.prepare("SELECT source_event_ids_json FROM wiki_pages").all()) {
      for (const id of parseJsonText(row.source_event_ids_json, [])) {
        if (Number.isFinite(Number(id))) protectedIds.add(Number(id));
      }
    }
    const pendingRuns = this.db.prepare(`
      SELECT input_json
      FROM wiki_curation_runs
      WHERE status NOT IN ('completed', 'failed', 'cancelled', 'expired', 'superseded')
    `).all();
    for (const row of pendingRuns) {
      const input = parseJsonText(row.input_json, {});
      for (const id of Array.isArray(input?.source_event_ids) ? input.source_event_ids : []) {
        if (Number.isFinite(Number(id))) protectedIds.add(Number(id));
      }
    }
    const limit = Math.max(0, Number(keep) || 0);
    const unreferenced = this.db.prepare("SELECT id FROM wiki_source_events ORDER BY id DESC")
      .all()
      .map((row) => Number(row.id))
      .filter((id) => !protectedIds.has(id));
    const staleIds = unreferenced.slice(limit);
    let deleted = 0;
    for (let index = 0; index < staleIds.length; index += 500) {
      const ids = staleIds.slice(index, index + 500);
      if (!ids.length) continue;
      deleted += this.db.prepare(`
        DELETE FROM wiki_source_events
        WHERE id IN (${ids.map(() => "?").join(", ")})
      `).run(...ids).changes;
    }
    return deleted;
  }

  checkpoint(mode = "PASSIVE") {
    this.open();
    const normalizedMode = String(mode || "PASSIVE").trim().toUpperCase();
    if (!new Set(["PASSIVE", "FULL", "RESTART", "TRUNCATE"]).has(normalizedMode)) {
      throw new Error(`Unsupported SQLite checkpoint mode: ${mode}`);
    }
    const row = this.db.prepare(`PRAGMA wal_checkpoint(${normalizedMode})`).get() || {};
    return {
      schema: "jcc-runtime-sqlite-checkpoint-v1",
      ok: Number(row.busy ?? 0) === 0,
      mode: normalizedMode,
      busy: Number(row.busy ?? 0),
      log_frames: Number(row.log ?? row.log_frames ?? 0),
      checkpointed_frames: Number(row.checkpointed ?? row.checkpointed_frames ?? 0),
    };
  }

  vacuum() {
    this.open();
    this.db.exec("VACUUM");
    return { schema: "jcc-runtime-sqlite-vacuum-v1", ok: true };
  }

  listMigrations() {
    this.open();
    return this.db.prepare(`
      SELECT version, name, applied_at
      FROM runtime_migrations
      ORDER BY version ASC
    `).all();
  }

  listRecentEvents(limit = 20) {
    this.open();
    const rows = this.db.prepare(`
      SELECT id, event_type, payload_json, created_at
      FROM runtime_events
      ORDER BY id DESC
      LIMIT ?
    `).all(Number(limit));
    return rows.map((row) => ({
      id: row.id,
      event_type: row.event_type,
      payload: parseJsonText(row.payload_json, {}),
      created_at: row.created_at,
    }));
  }

  listEventsAfter(afterId = 0, limit = 200) {
    this.open();
    const rows = this.db.prepare(`
      SELECT id, event_type, payload_json, created_at
      FROM runtime_events
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(Math.max(0, Number(afterId) || 0), Math.max(1, Math.min(1000, Number(limit) || 200)));
    return rows.map((row) => ({
      id: Number(row.id),
      sequence: Number(row.id),
      event_type: row.event_type,
      payload: parseJsonText(row.payload_json, {}),
      created_at: row.created_at,
    }));
  }

  addWikiSourceEvent({
    sourceType,
    namespace = "personal_strategy",
    seasonId = null,
    patchId = null,
    payload = {},
    evidenceHash = null,
  } = {}) {
    this.open();
    if (!sourceType) throw new Error("wiki source event requires sourceType");
    const timestamp = nowIso();
    const safePayload = sanitizeCanonicalPersistenceValue(payload || {});
    const hash = evidenceHash || stableHash({ sourceType, namespace, seasonId, patchId, payload: safePayload });
    this.db.prepare(`
      INSERT INTO wiki_source_events
        (source_type, namespace, season_id, patch_id, evidence_hash, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type, evidence_hash) DO NOTHING
    `).run(
      String(sourceType),
      String(namespace),
      seasonId ? String(seasonId) : null,
      patchId ? String(patchId) : null,
      hash,
      JSON.stringify(safePayload),
      timestamp,
    );
    const row = this.db.prepare(`
      SELECT id, source_type, namespace, season_id, patch_id, evidence_hash, payload_json, created_at
      FROM wiki_source_events
      WHERE source_type = ? AND evidence_hash = ?
    `).get(String(sourceType), hash);
    return wikiSourceEventRowToObject(row);
  }

  listWikiSourceEvents({ namespace = null, seasonId = null, patchId = null, limit = 50 } = {}) {
    this.open();
    const clauses = [];
    const args = [];
    if (namespace) {
      clauses.push("namespace = ?");
      args.push(String(namespace));
    }
    if (seasonId) {
      clauses.push("season_id = ?");
      args.push(String(seasonId));
    }
    if (patchId) {
      clauses.push("patch_id = ?");
      args.push(String(patchId));
    }
    args.push(Number(limit));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT id, source_type, namespace, season_id, patch_id, evidence_hash, payload_json, created_at
      FROM wiki_source_events
      ${where}
      ORDER BY id DESC
      LIMIT ?
    `).all(...args);
    return rows.map(wikiSourceEventRowToObject);
  }

  upsertWikiPage(page = {}) {
    this.open();
    const timestamp = nowIso();
    const pageId = String(page.page_id || `wiki_${randomUUID()}`);
    const existing = this.db.prepare("SELECT created_at, scope FROM wiki_pages WHERE page_id = ?").get(pageId);
    this.db.prepare(`
      INSERT INTO wiki_pages
        (page_id, namespace, category, season_id, patch_id, scope, title, status, summary, body_md,
         tags_json, source_event_ids_json, confidence, valid_from_patch, valid_until_patch,
         stale_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(page_id) DO UPDATE SET
        namespace = excluded.namespace,
        category = excluded.category,
        season_id = excluded.season_id,
        patch_id = excluded.patch_id,
        scope = excluded.scope,
        title = excluded.title,
        status = excluded.status,
        summary = excluded.summary,
        body_md = excluded.body_md,
        tags_json = excluded.tags_json,
        source_event_ids_json = excluded.source_event_ids_json,
        confidence = excluded.confidence,
        valid_from_patch = excluded.valid_from_patch,
        valid_until_patch = excluded.valid_until_patch,
        stale_reason = excluded.stale_reason,
        updated_at = excluded.updated_at
    `).run(
      pageId,
      String(page.namespace || "personal_strategy"),
      String(page.category || "patch_meta_strategy"),
      page.season_id ? String(page.season_id) : null,
      page.patch_id ? String(page.patch_id) : null,
      String(page.scope || existing?.scope || (page.season_id ? "current_season" : "unclassified")),
      String(page.title || "Untitled JCC Wiki Page").slice(0, 200),
      String(page.status || "draft"),
      String(page.summary || ""),
      String(page.body_md || ""),
      JSON.stringify(Array.isArray(page.tags) ? page.tags : []),
      JSON.stringify(Array.isArray(page.source_event_ids) ? page.source_event_ids : []),
      String(page.confidence || "medium"),
      page.valid_from_patch ? String(page.valid_from_patch) : null,
      page.valid_until_patch ? String(page.valid_until_patch) : null,
      page.stale_reason ? String(page.stale_reason) : null,
      existing?.created_at || timestamp,
      timestamp,
    );
    return this.getWikiPage(pageId);
  }

  getWikiPage(pageId) {
    this.open();
    const row = this.db.prepare(`
      SELECT page_id, namespace, category, season_id, patch_id, scope, title, status, summary, body_md,
             tags_json, source_event_ids_json, confidence, valid_from_patch, valid_until_patch,
             stale_reason, created_at, updated_at
      FROM wiki_pages
      WHERE page_id = ?
    `).get(String(pageId));
    return row ? wikiPageRowToObject(row) : null;
  }

  listWikiPages({ namespace = null, category = null, seasonId = null, scope = null, status = "published", includeArchived = false, limit = 50 } = {}) {
    this.open();
    const clauses = [];
    const args = [];
    if (namespace) {
      clauses.push("namespace = ?");
      args.push(String(namespace));
    }
    if (category) {
      clauses.push("category = ?");
      args.push(String(category));
    }
    if (seasonId) {
      clauses.push("season_id = ?");
      args.push(String(seasonId));
    }
    if (scope) {
      clauses.push("scope = ?");
      args.push(String(scope));
    }
    if (status) {
      clauses.push("status = ?");
      args.push(String(status));
    } else if (!includeArchived) {
      clauses.push("status != 'archived'");
    }
    args.push(Number(limit));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT page_id, namespace, category, season_id, patch_id, scope, title, status, summary, body_md,
             tags_json, source_event_ids_json, confidence, valid_from_patch, valid_until_patch,
             stale_reason, created_at, updated_at
      FROM wiki_pages
      ${where}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...args);
    return rows.map(wikiPageRowToObject);
  }

  captureWikiSnapshot(pages) {
    this.open();
    const body = JSON.stringify([...pages].sort((a, b) => a.page_id.localeCompare(b.page_id)));
    const id = createHash("sha256").update(body).digest("hex");
    this.db.prepare("INSERT OR IGNORE INTO wiki_snapshots(snapshot_id, pages_json, created_at) VALUES (?, ?, ?)").run(id, body, nowIso());
    return { snapshot_id: id, page_count: pages.length };
  }

  readWikiSnapshot(id) {
    this.open();
    const row = this.db.prepare("SELECT pages_json FROM wiki_snapshots WHERE snapshot_id = ?").get(String(id));
    if (!row || createHash("sha256").update(row.pages_json).digest("hex") !== id) throw new Error("wiki_snapshot_missing_or_corrupt");
    return JSON.parse(row.pages_json);
  }

  markWikiPagesStale({ seasonId = null, olderThanPatch = null, reason = "superseded_by_new_patch" } = {}) {
    this.open();
    const clauses = ["status = 'published'"];
    const args = [];
    if (seasonId) {
      clauses.push("season_id = ?");
      args.push(String(seasonId));
    }
    if (olderThanPatch) {
      clauses.push("category = 'patch_meta_strategy'");
      clauses.push("patch_id IS NOT NULL");
      clauses.push("patch_id != ?");
      args.push(String(olderThanPatch));
    }
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE wiki_pages
      SET status = 'stale',
          stale_reason = ?,
          valid_until_patch = COALESCE(valid_until_patch, ?),
          updated_at = ?
      WHERE ${clauses.join(" AND ")}
    `).run(String(reason), olderThanPatch ? String(olderThanPatch) : null, timestamp, ...args);
    return { changed: result.changes, updated_at: timestamp };
  }

  recordWikiCurationRun({ runId = null, triggerType = "manual_one_click", status = "completed", input = {}, output = {}, completedAt = null } = {}) {
    this.open();
    const id = String(runId || `wiki_curation_${randomUUID()}`);
    const createdAt = nowIso();
    const doneAt = completedAt || (status === "completed" ? createdAt : null);
    const safeInput = sanitizeCanonicalPersistenceValue(input || {});
    const safeOutput = sanitizeCanonicalPersistenceValue(output || {});
    this.db.prepare(`
      INSERT INTO wiki_curation_runs
        (run_id, trigger_type, status, input_json, output_json, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        output_json = excluded.output_json,
        completed_at = excluded.completed_at
    `).run(
      id,
      String(triggerType),
      String(status),
      JSON.stringify(safeInput),
      JSON.stringify(safeOutput),
      createdAt,
      doneAt,
    );
    return {
      run_id: id,
      trigger_type: String(triggerType),
      status: String(status),
      input: safeInput,
      output: safeOutput,
      created_at: createdAt,
      completed_at: doneAt,
    };
  }
}

function mkdirSyncForDatabase(dir) {
  mkdirSync(dir, { recursive: true });
}

export function createRuntimeSqliteStore(repoRoot, options = {}) {
  return new JccRuntimeSqliteStore(createRuntimePaths(repoRoot, options));
}
