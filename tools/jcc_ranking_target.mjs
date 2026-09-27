import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function argumentValue(argv, name) {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be provided only once`);
  if (!indexes.length) return null;
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function profileCoreId(profile) {
  return String(profile?.core_profile_id || profile?.combined_fingerprint || "").trim();
}

function normalizedProfile(profile, profileKind, profileFile) {
  const coreProfileId = profileCoreId(profile);
  const runtimeIdentity = profile?.runtime_identity || {};
  if (!SHA256_PATTERN.test(coreProfileId)) throw new Error(`${profileKind} Core Profile id is invalid`);
  for (const field of ["season_id", "patch_id", "game_mode_id", "package_id", "hard_data_manifest"]) {
    if (!String(runtimeIdentity[field] || profile?.[field] || "").trim()) {
      throw new Error(`${profileKind} Core Profile is missing ${field}`);
    }
  }
  return {
    profile,
    profileKind,
    profileFile,
    coreProfileId,
    seasonId: String(profile.season_id || runtimeIdentity.season_id),
    patchId: String(profile.patch_id || runtimeIdentity.patch_id),
    gameModeId: String(runtimeIdentity.game_mode_id),
    packageId: String(runtimeIdentity.package_id),
    sourcePackageId: String(runtimeIdentity.source_package_id || runtimeIdentity.package_id),
    hardDataManifestRelative: String(runtimeIdentity.hard_data_manifest),
    upstreamIdentity: runtimeIdentity.upstream_identity || {},
    decisionInputCatalogRelative: String(profile.decision_input_catalog_path || ""),
    bundleRelative: String(profile.bundle_path || ""),
  };
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function rankingSetId(...values) {
  for (const value of values) {
    const match = String(value || "").trim().match(/(\d+)$/);
    if (match) return match[1];
  }
  throw new Error("Ranking target is missing a numeric upstream mode/set identity");
}

export function rankingPublicationScope(profileKind) {
  if (profileKind === "active") return "active";
  if (profileKind === "candidate") return "candidate";
  throw new Error(`Unsupported ranking publication profile: ${profileKind}`);
}

async function loadProfile(file, kind) {
  try {
    return normalizedProfile(await readJson(file), kind, file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function selectProfile({ active, candidate, requestedProfile, seasonId, patchId, expectedCoreProfileId, candidateManifest }) {
  const profiles = [active, candidate].filter(Boolean);
  if (requestedProfile === "active") return active;
  if (requestedProfile === "candidate") return candidate;
  if (candidateManifest) {
    const requested = path.resolve(candidateManifest);
    return profiles.find((entry) => path.resolve(entry.hardDataManifestAbsolute) === requested) || null;
  }
  if (expectedCoreProfileId) {
    return profiles.find((entry) => entry.coreProfileId === expectedCoreProfileId) || null;
  }
  if (seasonId || patchId) {
    return profiles.find((entry) => (
      (!seasonId || entry.seasonId === seasonId)
      && (!patchId || entry.patchId === patchId)
    )) || null;
  }
  return active;
}

export async function resolveRankingTarget({ repoRoot = DEFAULT_REPO_ROOT, argv = [] } = {}) {
  const root = path.resolve(repoRoot);
  const knowledgeRoot = path.join(root, "data", "game-knowledge", "jcc");
  const managedHardDataRoot = path.join(root, "data", "core-patches", "jcc");
  const requestedProfile = argumentValue(argv, "--profile") || "auto";
  const seasonId = argumentValue(argv, "--season");
  const patchId = argumentValue(argv, "--patch");
  const expectedCoreProfileId = argumentValue(argv, "--expected-core-profile-id");
  const candidateManifest = argumentValue(argv, "--candidate-manifest");
  if (!["auto", "active", "candidate"].includes(requestedProfile)) {
    throw new Error("--profile must be active, candidate, or auto");
  }
  if (expectedCoreProfileId && !SHA256_PATTERN.test(expectedCoreProfileId)) {
    throw new Error("--expected-core-profile-id must be a lowercase SHA-256");
  }

  const [active, candidate] = await Promise.all([
    loadProfile(path.join(knowledgeRoot, "active-profile.json"), "active"),
    loadProfile(path.join(knowledgeRoot, "candidates", "candidate-profile.json"), "candidate"),
  ]);
  for (const profile of [active, candidate].filter(Boolean)) {
    profile.hardDataManifestAbsolute = path.resolve(root, profile.hardDataManifestRelative);
    if (!isInside(managedHardDataRoot, profile.hardDataManifestAbsolute)) {
      throw new Error(`${profile.profileKind} hard-data manifest escapes the managed package root`);
    }
  }

  const selected = selectProfile({
    active,
    candidate,
    requestedProfile,
    seasonId,
    patchId,
    expectedCoreProfileId,
    candidateManifest: candidateManifest ? path.resolve(root, candidateManifest) : null,
  });
  if (!selected) throw new Error("No Core Profile matches the requested ranking target");
  if (seasonId && selected.seasonId !== seasonId) throw new Error("Ranking target season does not match --season");
  if (patchId && selected.patchId !== patchId) throw new Error("Ranking target patch does not match --patch");
  if (expectedCoreProfileId && selected.coreProfileId !== expectedCoreProfileId) {
    throw new Error("Ranking target Core Profile does not match --expected-core-profile-id");
  }

  const hardDataManifest = await readJson(selected.hardDataManifestAbsolute);
  const patchSourceManifestFile = path.join(
    knowledgeRoot,
    "seasons",
    selected.seasonId,
    "patches",
    selected.patchId,
    "source-manifest.json",
  );
  const patchSourceManifest = await readJson(patchSourceManifestFile);
  if (patchSourceManifest?.season_id !== selected.seasonId || patchSourceManifest?.patch_id !== selected.patchId) {
    throw new Error("Ranking target patch source manifest identity does not match the selected Core Profile");
  }
  const decisionInputCatalog = selected.decisionInputCatalogRelative
    ? await readJson(path.resolve(knowledgeRoot, selected.decisionInputCatalogRelative))
    : null;
  const compiledBundle = selected.bundleRelative
    ? await readJson(path.resolve(knowledgeRoot, selected.bundleRelative))
    : null;
  const commonSemanticDocument = compiledBundle?.common?.semantic_features || null;
  if (!commonSemanticDocument) throw new Error("Ranking target Core Profile is missing compiled Common semantic features");
  const sourceIdentity = decisionInputCatalog?.source_identity || {};
  return Object.freeze({
    schema: "jcc-live-ranking-target-v1",
    selection: selected.profileKind,
    publication_scope: rankingPublicationScope(selected.profileKind),
    season_id: selected.seasonId,
    patch_id: selected.patchId,
    game_mode_id: selected.gameModeId,
    ranking_set_id: rankingSetId(
      selected.upstreamIdentity?.mode,
      hardDataManifest?.mode,
      hardDataManifest?.identity?.mode_id,
      selected.gameModeId,
    ),
    package_id: selected.packageId,
    source_package_id: selected.sourcePackageId,
    core_profile_id: selected.coreProfileId,
    profile_file: selected.profileFile,
    hard_data_manifest: selected.hardDataManifestAbsolute,
    hard_data_package_dir: path.dirname(selected.hardDataManifestAbsolute),
    hard_data_manifest_value: hardDataManifest,
    patch_source_manifest: patchSourceManifestFile,
    ranking_sources: patchSourceManifest.ranking_sources || {},
    upstream_identity: selected.upstreamIdentity,
    hard_data_manifest_fingerprint: sourceIdentity.hard_data_manifest_fingerprint || null,
    catalog_source_fingerprint: sourceIdentity.catalog_source_fingerprint || null,
    common_semantic_document: commonSemanticDocument,
    candidate_pointer_file: path.join(root, "data", "live-rankings", "jcc", "candidates", `${selected.coreProfileId}.json`),
  });
}
