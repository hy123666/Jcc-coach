import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const ACTIVE_CORE_PROFILE_SCHEMA = "jcc-game-knowledge-active-profile-v1";
export const ACTIVE_CORE_PROFILE_FILE = "active-profile.json";
export const GAME_KNOWLEDGE_RUNTIME_IDENTITY_SCHEMA = "jcc-game-knowledge-runtime-identity-v1";
const activeProfileCache = new Map();

function artifactFileSignature(file) {
  try {
    const stats = statSync(file);
    return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch {
    return null;
  }
}

function artifactSignatures(files) {
  return Object.fromEntries(files.map((file) => [file, artifactFileSignature(file)]));
}

function sameArtifactSignatures(left, right) {
  const keys = Object.keys(left || {});
  return keys.length === Object.keys(right || {}).length
    && keys.every((key) => left[key] !== null && left[key] === right[key]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createRuntimeLocalPackageId(seasonId, patchId) {
  const normalizedSeasonId = String(seasonId || "").trim();
  const normalizedPatchId = String(patchId || "").trim();
  if (!/^s\d+$/.test(normalizedSeasonId) || !/^s\d+_\d+$/.test(normalizedPatchId)) {
    throw new Error("Core Profile runtime identity season or patch id is invalid");
  }
  return `jcc-${normalizedSeasonId}-${normalizedPatchId}`;
}

export function validateGameKnowledgeRuntimeIdentity(runtimeIdentity, { label = "Core Profile runtime identity" } = {}) {
  if (!runtimeIdentity || typeof runtimeIdentity !== "object" || Array.isArray(runtimeIdentity)) {
    throw new Error(`${label} is missing`);
  }
  if (runtimeIdentity.schema !== GAME_KNOWLEDGE_RUNTIME_IDENTITY_SCHEMA) {
    throw new Error(`${label} schema is invalid`);
  }
  const requiredStrings = [
    "season_id",
    "patch_id",
    "game_mode_id",
    "package_id",
    "source_package_id",
    "hard_data_manifest",
  ];
  for (const field of requiredStrings) {
    if (!String(runtimeIdentity[field] || "").trim()) throw new Error(`${label}.${field} is missing`);
  }
  if (!/^s\d+$/.test(runtimeIdentity.season_id) || !/^s\d+_\d+$/.test(runtimeIdentity.patch_id)) {
    throw new Error(`${label} season or patch id is invalid`);
  }
  const expectedPackageId = createRuntimeLocalPackageId(runtimeIdentity.season_id, runtimeIdentity.patch_id);
  if (runtimeIdentity.package_id !== expectedPackageId) {
    throw new Error(`${label}.package_id must be the runtime-local id ${expectedPackageId}`);
  }
  const manifestPath = String(runtimeIdentity.hard_data_manifest).replaceAll("\\", "/");
  if (path.isAbsolute(manifestPath) || manifestPath === ".." || manifestPath.startsWith("../") || manifestPath.includes("/../")) {
    throw new Error(`${label}.hard_data_manifest must be a repository-relative path`);
  }
  const upstreamIdentity = runtimeIdentity.upstream_identity;
  if (!upstreamIdentity || typeof upstreamIdentity !== "object" || Array.isArray(upstreamIdentity)) {
    throw new Error(`${label}.upstream_identity is missing`);
  }
  for (const field of ["mode", "season", "version", "framework_name"]) {
    if (!String(upstreamIdentity[field] || "").trim()) throw new Error(`${label}.upstream_identity.${field} is missing`);
  }
  return Object.freeze({
    schema: GAME_KNOWLEDGE_RUNTIME_IDENTITY_SCHEMA,
    season_id: runtimeIdentity.season_id,
    patch_id: runtimeIdentity.patch_id,
    game_mode_id: runtimeIdentity.game_mode_id,
    package_id: runtimeIdentity.package_id,
    source_package_id: runtimeIdentity.source_package_id,
    hard_data_manifest: manifestPath,
    upstream_identity: Object.freeze({
      mode: String(upstreamIdentity.mode),
      season: String(upstreamIdentity.season),
      version: String(upstreamIdentity.version),
      framework_name: String(upstreamIdentity.framework_name),
    }),
  });
}

function sameRuntimeIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSourceIdentity(left, right) {
  if (!left || typeof left !== "object" || Array.isArray(left)) return false;
  if (!right || typeof right !== "object" || Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return JSON.stringify(leftKeys) === JSON.stringify(rightKeys)
    && leftKeys.every((key) => left[key] === right[key]);
}

function normalizeActivationBlockers(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))].sort();
}

function resolveAndValidateRuntimeIdentity(candidateOrActive, bundle, label, { required }) {
  const pointerIdentity = candidateOrActive?.runtime_identity || null;
  const bundleIdentity = bundle?.runtime_identity || null;
  if (!pointerIdentity && !bundleIdentity && !required) return null;
  if (!pointerIdentity || !bundleIdentity) throw new Error(`${label} runtime identity must exist in both pointer and bundle`);
  const normalizedPointer = validateGameKnowledgeRuntimeIdentity(pointerIdentity, { label: `${label} pointer runtime identity` });
  const normalizedBundle = validateGameKnowledgeRuntimeIdentity(bundleIdentity, { label: `${label} bundle runtime identity` });
  if (!sameRuntimeIdentity(normalizedPointer, normalizedBundle)) throw new Error(`${label} pointer and bundle runtime identity mismatch`);
  if (normalizedPointer.season_id !== candidateOrActive.season_id || normalizedPointer.patch_id !== candidateOrActive.patch_id) {
    throw new Error(`${label} runtime identity does not match pointer season or patch`);
  }
  if (bundle?.profile?.season_id && normalizedPointer.season_id !== bundle.profile.season_id) {
    throw new Error(`${label} runtime identity does not match bundle season`);
  }
  if (bundle?.profile?.patch_id && normalizedPointer.patch_id !== bundle.profile.patch_id) {
    throw new Error(`${label} runtime identity does not match bundle patch`);
  }
  return normalizedPointer;
}

function validateProfileArtifact(knowledgeRoot, generatedRoot, profile, {
  pathField,
  hashField,
  sizeField,
  label,
  bytes,
}) {
  if (!String(profile?.[pathField] || "").trim()) throw new Error(`${label} path is missing`);
  if (!/^[a-f0-9]{64}$/.test(String(profile?.[hashField] || ""))) throw new Error(`${label} hash is invalid`);
  const artifactFile = path.resolve(knowledgeRoot, profile[pathField]);
  if (!contained(generatedRoot, artifactFile)) throw new Error(`${label} path escapes generated root`);
  if (Buffer.byteLength(bytes) !== Number(profile[sizeField])) throw new Error(`${label} byte size does not match profile`);
  if (sha256(bytes) !== profile[hashField]) throw new Error(`${label} hash does not match profile`);
  return artifactFile;
}

function validatePublishedArtifactIdentity({
  profile,
  bundleFile,
  bundle,
  runtimeIdentity,
  decisionInputCatalogFile,
  decisionInputCatalog,
  augmentStageAuthorityFile,
  augmentStageAuthority,
  runtimeCatalogOverlayFile,
  runtimeCatalogOverlay,
  semanticFeatureIndexFile,
  semanticFeatureIndex,
  label,
}) {
  const generationRoot = path.join(path.dirname(path.dirname(bundleFile)), profile.combined_fingerprint || profile.core_profile_id);
  if (
    path.dirname(bundleFile) !== generationRoot
    || path.dirname(decisionInputCatalogFile) !== generationRoot
    || path.dirname(augmentStageAuthorityFile) !== generationRoot
    || path.dirname(runtimeCatalogOverlayFile) !== generationRoot
    || path.dirname(semanticFeatureIndexFile) !== generationRoot
  ) {
    throw new Error(`${label} artifacts must use the generation directory named by the Core Profile id`);
  }
  if (path.basename(runtimeCatalogOverlayFile) !== "runtime-catalog-overlay.json") {
    throw new Error(`${label} runtime catalog overlay path must end with runtime-catalog-overlay.json`);
  }
  if (path.basename(semanticFeatureIndexFile) !== "semantic-feature-index.json") {
    throw new Error(`${label} semantic feature index path must end with semantic-feature-index.json`);
  }
  const profileId = profile.combined_fingerprint || profile.core_profile_id;
  if (bundle?.schema !== "jcc-game-knowledge-bundle-v1" || bundle.combined_fingerprint !== profileId) {
    throw new Error(`${label} bundle identity mismatch`);
  }
  const sourceIdentity = decisionInputCatalog?.source_identity;
  const expectedHardDataSourceRef = `core_profile_hard_data_manifest:${runtimeIdentity.hard_data_manifest}`;
  if (
    decisionInputCatalog?.schema !== "jcc-decision-input-catalog-v1"
    || sourceIdentity?.season_id !== profile.season_id
    || sourceIdentity?.active_patch_id !== profile.patch_id
    || sourceIdentity?.core_profile_id !== profileId
    || sourceIdentity?.hard_data_source_ref !== expectedHardDataSourceRef
  ) {
    throw new Error(`${label} decision-input catalog source identity mismatch`);
  }
  if (
    augmentStageAuthority?.schema !== "jcc-decision-input-augment-stage-authority-v1"
    || !sameSourceIdentity(augmentStageAuthority.source_identity, sourceIdentity)
  ) {
    throw new Error(`${label} augment-stage authority source identity mismatch`);
  }
  if (!String(runtimeCatalogOverlay?.schema || "").trim() || !sameSourceIdentity(runtimeCatalogOverlay.source_identity, sourceIdentity)) {
    throw new Error(`${label} runtime catalog overlay source identity mismatch`);
  }
  if (
    semanticFeatureIndex?.schema !== "jcc-semantic-feature-index-v1"
    || semanticFeatureIndex?.identity?.season_id !== profile.season_id
    || semanticFeatureIndex?.identity?.patch_id !== profile.patch_id
    || semanticFeatureIndex?.identity?.core_profile_id !== profileId
  ) {
    throw new Error(`${label} semantic feature index identity mismatch`);
  }
  if (JSON.stringify(bundle?.semantic_feature_index || null) !== JSON.stringify(semanticFeatureIndex)) {
    throw new Error(`${label} embedded and published semantic feature indexes do not match`);
  }
}

function validateCandidate(
  knowledgeRoot,
  candidate,
  bundleBytes,
  decisionInputCatalogBytes,
  augmentStageAuthorityBytes,
  runtimeCatalogOverlayBytes,
  semanticFeatureIndexBytes,
) {
  if (candidate?.schema !== "jcc-game-knowledge-candidate-profile-v1") throw new Error("Core Profile candidate schema is invalid");
  if (!/^[a-f0-9]{64}$/.test(String(candidate.combined_fingerprint || ""))) throw new Error("Core Profile candidate fingerprint is invalid");
  if (!/^[a-f0-9]{64}$/.test(String(candidate.bundle_sha256 || ""))) throw new Error("Core Profile candidate bundle hash is invalid");
  if (!String(candidate.season_id || "").match(/^s\d+$/) || !String(candidate.patch_id || "").match(/^s\d+_\d+$/)) {
    throw new Error("Core Profile candidate season or patch identity is invalid");
  }
  const generatedRoot = path.join(knowledgeRoot, "generated");
  const bundleFile = validateProfileArtifact(knowledgeRoot, generatedRoot, candidate, {
    pathField: "bundle_path",
    hashField: "bundle_sha256",
    sizeField: "bundle_byte_size",
    label: "Core Profile bundle",
    bytes: bundleBytes,
  });
  const decisionInputCatalogFile = validateProfileArtifact(knowledgeRoot, generatedRoot, candidate, {
    pathField: "decision_input_catalog_path",
    hashField: "decision_input_catalog_sha256",
    sizeField: "decision_input_catalog_byte_size",
    label: "Core Profile decision-input catalog",
    bytes: decisionInputCatalogBytes,
  });
  const augmentStageAuthorityFile = validateProfileArtifact(knowledgeRoot, generatedRoot, candidate, {
    pathField: "augment_stage_authority_path",
    hashField: "augment_stage_authority_sha256",
    sizeField: "augment_stage_authority_byte_size",
    label: "Core Profile augment-stage authority",
    bytes: augmentStageAuthorityBytes,
  });
  const runtimeCatalogOverlayFile = validateProfileArtifact(knowledgeRoot, generatedRoot, candidate, {
    pathField: "runtime_catalog_overlay_path",
    hashField: "runtime_catalog_overlay_sha256",
    sizeField: "runtime_catalog_overlay_byte_size",
    label: "Core Profile runtime catalog overlay",
    bytes: runtimeCatalogOverlayBytes,
  });
  const semanticFeatureIndexFile = validateProfileArtifact(knowledgeRoot, generatedRoot, candidate, {
    pathField: "semantic_feature_index_path",
    hashField: "semantic_feature_index_sha256",
    sizeField: "semantic_feature_index_byte_size",
    label: "Core Profile semantic feature index",
    bytes: semanticFeatureIndexBytes,
  });
  const bundle = JSON.parse(bundleBytes);
  const pointerActivationBlockers = normalizeActivationBlockers(
    candidate.activation_blockers,
    "Core Profile candidate pointer activation_blockers",
  );
  const bundleActivationBlockers = normalizeActivationBlockers(
    bundle?.patch?.activation_blockers,
    "Core Profile candidate bundle patch.activation_blockers",
  );
  if (JSON.stringify(pointerActivationBlockers) !== JSON.stringify(bundleActivationBlockers)) {
    throw new Error("Core Profile candidate activation blockers do not match the immutable bundle");
  }
  if (bundleActivationBlockers.length > 0) {
    throw new Error(`Core Profile candidate has activation blockers: ${bundleActivationBlockers.join(", ")}`);
  }
  const runtimeIdentity = resolveAndValidateRuntimeIdentity(candidate, bundle, "Core Profile candidate", { required: true });
  const decisionInputCatalog = JSON.parse(decisionInputCatalogBytes);
  const augmentStageAuthority = JSON.parse(augmentStageAuthorityBytes);
  const runtimeCatalogOverlay = JSON.parse(runtimeCatalogOverlayBytes);
  const semanticFeatureIndex = JSON.parse(semanticFeatureIndexBytes);
  validatePublishedArtifactIdentity({
    profile: candidate,
    bundleFile,
    bundle,
    runtimeIdentity,
    decisionInputCatalogFile,
    decisionInputCatalog,
    augmentStageAuthorityFile,
    augmentStageAuthority,
    runtimeCatalogOverlayFile,
    runtimeCatalogOverlay,
    semanticFeatureIndexFile,
    semanticFeatureIndex,
    label: "Core Profile candidate",
  });
  return {
    bundleFile,
    bundle,
    runtimeIdentity,
    decisionInputCatalogFile,
    decisionInputCatalog,
    augmentStageAuthorityFile,
    augmentStageAuthority,
    runtimeCatalogOverlayFile,
    runtimeCatalogOverlay,
    semanticFeatureIndexFile,
    semanticFeatureIndex,
  };
}

export async function promoteGameKnowledgeCandidate({
  knowledgeRoot,
  candidateProfilePath,
  expectedCoreProfileId,
} = {}) {
  const root = path.resolve(knowledgeRoot || "data/game-knowledge/jcc");
  const candidateFile = path.resolve(candidateProfilePath || path.join(root, "candidates", "candidate-profile.json"));
  if (!contained(path.join(root, "candidates"), candidateFile)) throw new Error("Core Profile candidate path escapes candidates root");
  const candidate = JSON.parse(await readFile(candidateFile, "utf8"));
  if (!/^[a-f0-9]{64}$/.test(String(expectedCoreProfileId || ""))) {
    throw new Error("Core Profile promotion requires an expected Core Profile id");
  }
  if (candidate.combined_fingerprint !== expectedCoreProfileId) {
    throw new Error(`Core Profile candidate ${candidate.combined_fingerprint || "<missing>"} does not match expected ${expectedCoreProfileId}`);
  }
  const bundleFile = path.resolve(root, candidate.bundle_path || "");
  const decisionInputCatalogFile = path.resolve(root, candidate.decision_input_catalog_path || "");
  const augmentStageAuthorityFile = path.resolve(root, candidate.augment_stage_authority_path || "");
  const runtimeCatalogOverlayFile = path.resolve(root, candidate.runtime_catalog_overlay_path || "");
  const semanticFeatureIndexFile = path.resolve(root, candidate.semantic_feature_index_path || "");
  const bundleBytes = await readFile(bundleFile, "utf8");
  const decisionInputCatalogBytes = await readFile(decisionInputCatalogFile, "utf8");
  const augmentStageAuthorityBytes = await readFile(augmentStageAuthorityFile, "utf8");
  const runtimeCatalogOverlayBytes = await readFile(runtimeCatalogOverlayFile, "utf8");
  const semanticFeatureIndexBytes = await readFile(semanticFeatureIndexFile, "utf8");
  const validated = validateCandidate(
    root,
    candidate,
    bundleBytes,
    decisionInputCatalogBytes,
    augmentStageAuthorityBytes,
    runtimeCatalogOverlayBytes,
    semanticFeatureIndexBytes,
  );
  const { runtimeIdentity } = validated;
  const active = {
    schema: ACTIVE_CORE_PROFILE_SCHEMA,
    core_profile_id: candidate.combined_fingerprint,
    season_id: candidate.season_id,
    patch_id: candidate.patch_id,
    runtime_identity: runtimeIdentity,
    bundle_path: candidate.bundle_path,
    bundle_sha256: candidate.bundle_sha256,
    bundle_byte_size: candidate.bundle_byte_size,
    decision_input_catalog_path: candidate.decision_input_catalog_path,
    decision_input_catalog_sha256: candidate.decision_input_catalog_sha256,
    decision_input_catalog_byte_size: candidate.decision_input_catalog_byte_size,
    augment_stage_authority_path: candidate.augment_stage_authority_path,
    augment_stage_authority_sha256: candidate.augment_stage_authority_sha256,
    augment_stage_authority_byte_size: candidate.augment_stage_authority_byte_size,
    runtime_catalog_overlay_path: candidate.runtime_catalog_overlay_path,
    runtime_catalog_overlay_sha256: candidate.runtime_catalog_overlay_sha256,
    runtime_catalog_overlay_byte_size: candidate.runtime_catalog_overlay_byte_size,
    semantic_feature_index_path: candidate.semantic_feature_index_path,
    semantic_feature_index_sha256: candidate.semantic_feature_index_sha256,
    semantic_feature_index_byte_size: candidate.semantic_feature_index_byte_size,
    activation_policy: "new_match_only",
    promoted_at: new Date().toISOString(),
  };
  const activeFile = path.join(root, ACTIVE_CORE_PROFILE_FILE);
  const tempFile = `${activeFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempFile, `${JSON.stringify(active, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(tempFile, activeFile);
    activeProfileCache.delete(root);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
  return {
    active,
    activeFile,
    bundleFile: validated.bundleFile,
    decisionInputCatalogFile: validated.decisionInputCatalogFile,
    augmentStageAuthorityFile: validated.augmentStageAuthorityFile,
    runtimeCatalogOverlayFile: validated.runtimeCatalogOverlayFile,
  };
}

export async function restoreActiveGameKnowledgeProfile({
  knowledgeRoot,
  previousActiveProfileBytes,
  expectedCurrentCoreProfileId,
} = {}) {
  const root = path.resolve(knowledgeRoot || "data/game-knowledge/jcc");
  const activeFile = path.join(root, ACTIVE_CORE_PROFILE_FILE);
  const current = JSON.parse(await readFile(activeFile, "utf8"));
  if (current?.core_profile_id !== expectedCurrentCoreProfileId) {
    throw new Error("Active Core Profile changed before rollback");
  }
  const previousText = Buffer.isBuffer(previousActiveProfileBytes)
    ? previousActiveProfileBytes.toString("utf8")
    : String(previousActiveProfileBytes || "");
  const previous = JSON.parse(previousText);
  if (previous?.schema !== ACTIVE_CORE_PROFILE_SCHEMA || !/^[a-f0-9]{64}$/.test(String(previous.core_profile_id || ""))) {
    throw new Error("Previous active Core Profile rollback pointer is invalid");
  }
  const tempFile = `${activeFile}.${process.pid}.${randomUUID()}.rollback.tmp`;
  try {
    await writeFile(tempFile, previousText, { encoding: "utf8", flag: "wx" });
    await rename(tempFile, activeFile);
    activeProfileCache.delete(root);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
  return { activeFile, restored_core_profile_id: previous.core_profile_id };
}

export async function readGameKnowledgeGenerationLeases({ leaseFile } = {}) {
  if (!leaseFile) return [];
  let document;
  try {
    document = JSON.parse(await readFile(path.resolve(leaseFile), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (document?.schema !== "jcc-game-knowledge-generation-leases-v1") {
    throw new Error(`Game knowledge generation lease schema is invalid: ${leaseFile}`);
  }
  const leases = Array.isArray(document.leases) ? document.leases : [];
  return leases.map((lease) => ({
    core_profile_id: collectProtectedGenerationIds([lease], "generation lease")[0],
    ranking_overlay_id: /^\d{8}-[a-f0-9]{24}$/.test(String(lease?.ranking_overlay_id || ""))
      ? String(lease.ranking_overlay_id)
      : null,
    recipe_generation_id: /^[a-f0-9]{64}$/.test(String(lease?.recipe_generation_id || ""))
      ? String(lease.recipe_generation_id)
      : null,
    match_session_id: lease.match_session_id || null,
    status: lease.status || "active",
  }));
}

function collectProtectedGenerationIds(values, label) {
  if (values == null) return [];
  if (!Array.isArray(values) && !(values instanceof Set)) throw new Error(`${label} must be an array or Set`);
  return [...values].map((value) => {
    const id = typeof value === "string"
      ? value
      : value?.core_profile_id || value?.generation_id || value?.id;
    if (!/^[a-f0-9]{64}$/.test(String(id || ""))) throw new Error(`${label} contains an invalid Core Profile id`);
    return String(id);
  });
}

export async function pruneGameKnowledgeGenerations({
  knowledgeRoot,
  retainPrevious = 2,
  protectedCoreProfileIds,
  generationLeases,
} = {}) {
  const root = path.resolve(knowledgeRoot || "data/game-knowledge/jcc");
  const generatedRoot = path.join(root, "generated");
  const protectedIds = new Set([
    ...collectProtectedGenerationIds(protectedCoreProfileIds, "protectedCoreProfileIds"),
    ...collectProtectedGenerationIds(generationLeases, "generationLeases"),
  ]);
  const currentProfileIds = new Set();
  for (const pointerFile of [
    path.join(root, ACTIVE_CORE_PROFILE_FILE),
    path.join(root, "candidates", "candidate-profile.json"),
  ]) {
    try {
      const pointer = JSON.parse(await readFile(pointerFile, "utf8"));
      const id = String(pointer.core_profile_id || pointer.combined_fingerprint || "");
      if (/^[a-f0-9]{64}$/.test(id)) {
        protectedIds.add(id);
        currentProfileIds.add(id);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  let entries = [];
  try {
    entries = await readdir(generatedRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: [], retained: [] };
    throw error;
  }
  const generations = (await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map(async (entry) => ({
      id: entry.name,
      dir: path.join(generatedRoot, entry.name),
      mtimeMs: (await stat(path.join(generatedRoot, entry.name))).mtimeMs,
    })))).sort((left, right) => right.mtimeMs - left.mtimeMs);
  const retained = new Set(protectedIds);
  for (const generation of generations) {
    if (retained.has(generation.id)) continue;
    if ([...retained].filter((id) => !protectedIds.has(id)).length < Math.max(0, Number(retainPrevious) || 0)) {
      retained.add(generation.id);
    }
  }
  const removed = [];
  for (const generation of generations) {
    if (retained.has(generation.id)) continue;
    await rm(generation.dir, { recursive: true, force: true });
    removed.push(generation.id);
  }
  return { removed, retained: generations.map((entry) => entry.id).filter((id) => retained.has(id)), current_profile_ids: [...currentProfileIds] };
}

export function loadActiveGameKnowledgeProfileSync({ knowledgeRoot } = {}) {
  const root = path.resolve(knowledgeRoot || "data/game-knowledge/jcc");
  const activeFile = path.join(root, ACTIVE_CORE_PROFILE_FILE);
  if (!existsSync(activeFile)) throw new Error(`Active Core Profile is missing: ${activeFile}`);
  const activeText = readFileSync(activeFile, "utf8");
  const cached = activeProfileCache.get(root);
  const active = JSON.parse(activeText);
  if (active?.schema !== ACTIVE_CORE_PROFILE_SCHEMA || !/^[a-f0-9]{64}$/.test(String(active.core_profile_id || ""))) {
    throw new Error(`Active Core Profile pointer is invalid: ${activeFile}`);
  }
  const bundleFile = path.resolve(root, active.bundle_path || "");
  const decisionInputCatalogFile = path.resolve(root, active.decision_input_catalog_path || "");
  const augmentStageAuthorityFile = path.resolve(root, active.augment_stage_authority_path || "");
  const runtimeCatalogOverlayFile = path.resolve(root, active.runtime_catalog_overlay_path || "");
  const semanticFeatureIndexFile = path.resolve(root, active.semantic_feature_index_path || "");
  const profileArtifactFiles = [
    bundleFile,
    decisionInputCatalogFile,
    augmentStageAuthorityFile,
    runtimeCatalogOverlayFile,
    semanticFeatureIndexFile,
  ];
  const currentArtifactSignatures = artifactSignatures(profileArtifactFiles);
  if (
    cached?.activeText === activeText
    && sameArtifactSignatures(cached.artifactSignatures, currentArtifactSignatures)
  ) return cached.result;
  const generatedRoot = path.join(root, "generated");
  const bundleBytes = readFileSync(bundleFile, "utf8");
  const decisionInputCatalogBytes = readFileSync(decisionInputCatalogFile, "utf8");
  const augmentStageAuthorityBytes = readFileSync(augmentStageAuthorityFile, "utf8");
  const runtimeCatalogOverlayBytes = readFileSync(runtimeCatalogOverlayFile, "utf8");
  const semanticFeatureIndexBytes = readFileSync(semanticFeatureIndexFile, "utf8");
  const validatedBundleFile = validateProfileArtifact(root, generatedRoot, active, {
    pathField: "bundle_path",
    hashField: "bundle_sha256",
    sizeField: "bundle_byte_size",
    label: "Active Core Profile bundle",
    bytes: bundleBytes,
  });
  const validatedDecisionInputCatalogFile = validateProfileArtifact(root, generatedRoot, active, {
    pathField: "decision_input_catalog_path",
    hashField: "decision_input_catalog_sha256",
    sizeField: "decision_input_catalog_byte_size",
    label: "Active Core Profile decision-input catalog",
    bytes: decisionInputCatalogBytes,
  });
  const validatedAugmentStageAuthorityFile = validateProfileArtifact(root, generatedRoot, active, {
    pathField: "augment_stage_authority_path",
    hashField: "augment_stage_authority_sha256",
    sizeField: "augment_stage_authority_byte_size",
    label: "Active Core Profile augment-stage authority",
    bytes: augmentStageAuthorityBytes,
  });
  const validatedRuntimeCatalogOverlayFile = validateProfileArtifact(root, generatedRoot, active, {
    pathField: "runtime_catalog_overlay_path",
    hashField: "runtime_catalog_overlay_sha256",
    sizeField: "runtime_catalog_overlay_byte_size",
    label: "Active Core Profile runtime catalog overlay",
    bytes: runtimeCatalogOverlayBytes,
  });
  const validatedSemanticFeatureIndexFile = validateProfileArtifact(root, generatedRoot, active, {
    pathField: "semantic_feature_index_path",
    hashField: "semantic_feature_index_sha256",
    sizeField: "semantic_feature_index_byte_size",
    label: "Active Core Profile semantic feature index",
    bytes: semanticFeatureIndexBytes,
  });
  const bundle = JSON.parse(bundleBytes);
  const runtimeIdentity = resolveAndValidateRuntimeIdentity(active, bundle, "Active Core Profile", { required: true });
  const decisionInputCatalog = JSON.parse(decisionInputCatalogBytes);
  const augmentStageAuthority = JSON.parse(augmentStageAuthorityBytes);
  const runtimeCatalogOverlay = JSON.parse(runtimeCatalogOverlayBytes);
  const semanticFeatureIndex = JSON.parse(semanticFeatureIndexBytes);
  validatePublishedArtifactIdentity({
    profile: active,
    bundleFile: validatedBundleFile,
    bundle,
    runtimeIdentity,
    decisionInputCatalogFile: validatedDecisionInputCatalogFile,
    decisionInputCatalog,
    augmentStageAuthorityFile: validatedAugmentStageAuthorityFile,
    augmentStageAuthority,
    runtimeCatalogOverlayFile: validatedRuntimeCatalogOverlayFile,
    runtimeCatalogOverlay,
    semanticFeatureIndexFile: validatedSemanticFeatureIndexFile,
    semanticFeatureIndex,
    label: "Active Core Profile",
  });
  const result = Object.freeze({
    active: Object.freeze(active),
    bundle: Object.freeze(bundle),
    runtimeIdentity,
    identityAuthority: runtimeIdentity ? "core_profile" : "legacy_fallback_required",
    activeFile,
    bundleFile: validatedBundleFile,
    decisionInputCatalogFile: validatedDecisionInputCatalogFile,
    decisionInputCatalog: Object.freeze(decisionInputCatalog),
    augmentStageAuthorityFile: validatedAugmentStageAuthorityFile,
    augmentStageAuthority: Object.freeze(augmentStageAuthority),
    runtimeCatalogOverlayFile: validatedRuntimeCatalogOverlayFile,
    runtimeCatalogOverlay: Object.freeze(runtimeCatalogOverlay),
    semanticFeatureIndexFile: validatedSemanticFeatureIndexFile,
    semanticFeatureIndex: Object.freeze(semanticFeatureIndex),
  });
  activeProfileCache.set(root, {
    activeText,
    artifactSignatures: currentArtifactSignatures,
    result,
  });
  return result;
}
