import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import {
  loadActiveRulesBundle,
  promotionTupleMatchesRulesBundle,
} from "./jcc_active_rules_contract.mjs";
import { compileGameKnowledge } from "./jcc_game_knowledge_compiler.mjs";
import { createActiveCoreProfileSnapshot } from "./jcc_test_core_profile_fixture.mjs";
import { startSession } from "./start-jcc-new-match-session.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const knowledgeRoot = path.join(repoRoot, "data", "game-knowledge", "jcc");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizedJson(value) {
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${normalizedJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function specialMechanicTerms(seasonDescriptor) {
  const mechanics = seasonDescriptor?.mechanics || [];
  const fields = seasonDescriptor?.manual_variable_fields || [];
  return [...new Set([
    ...mechanics.flatMap((mechanic) => [mechanic.id, mechanic.choice_kind, mechanic.kind]),
    ...fields.flatMap((field) => [field.key, field.option_source_key]),
    ...(seasonDescriptor?.season_entity_terms || []),
  ].map((entry) => String(entry || "").trim().toLowerCase()).filter((entry) => entry.length >= 5))];
}

const runtimePaths = createRuntimePaths(repoRoot);
const activeBundle = loadActiveRulesBundle({ repoRoot, runtimePaths });

assert(
  promotionTupleMatchesRulesBundle(runtimePaths.activePromotionTuple, activeBundle, { requireComplete: true }),
  "the active promotion tuple must match the active Core Profile rules bundle",
);
for (const field of ["season_id", "active_patch_id", "game_mode_id", "package_id", "hard_data_manifest"]) {
  assert(
    !promotionTupleMatchesRulesBundle(
      { ...runtimePaths.activePromotionTuple, [field]: `mismatch-${field}` },
      activeBundle,
      { requireComplete: true },
    ),
    `promotion tuple mismatch in ${field} must fail closed`,
  );
}

const [activeProfile, candidateProfile, knowledgeManifest] = await Promise.all([
  readFile(path.join(knowledgeRoot, "active-profile.json"), "utf8").then(JSON.parse),
  readFile(path.join(knowledgeRoot, "candidates", "candidate-profile.json"), "utf8").then(JSON.parse),
  readFile(path.join(knowledgeRoot, "manifest.json"), "utf8").then(JSON.parse),
]);
const activeGeneratedBundle = JSON.parse(await readFile(runtimePaths.activeCoreProfileBundleFile, "utf8"));
const currentActiveSourceCompilation = await compileGameKnowledge({
  repoRoot,
  knowledgeRoot,
  seasonId: activeProfile.season_id,
  patchId: activeProfile.patch_id,
  write: false,
});
const activeCompilation = {
  combinedFingerprint: activeProfile.core_profile_id,
  bundle: activeGeneratedBundle,
};
assert(activeGeneratedBundle.combined_fingerprint === activeProfile.core_profile_id, "active profile must reference its immutable generated bundle");
assert(activeCompilation.bundle.profile.season_id === activeProfile.season_id, "active bundle must retain the selected season identity");
assert(activeCompilation.bundle.runtime_identity.patch_id === activeProfile.patch_id, "active bundle must retain the selected patch identity");

const archiveRegistrations = Object.entries(knowledgeManifest.season_archives || {});
assert(archiveRegistrations.length > 0, "at least one retired season must be registered for generic isolation verification");
const activeDescriptor = activeCompilation.bundle.season;
const activeDescriptorText = JSON.stringify(activeDescriptor).toLowerCase();
const activeTerms = new Set(specialMechanicTerms(activeDescriptor));
const checkedArchivedSeasons = [];
for (const [archivedSeasonId, archiveRelativePath] of archiveRegistrations) {
  assert(archivedSeasonId !== activeProfile.season_id, `active season ${activeProfile.season_id} must not also be registered as retired`);
  const archive = JSON.parse(await readFile(path.join(knowledgeRoot, archiveRelativePath), "utf8"));
  assert(archive.season_id === archivedSeasonId, `archive registration identity mismatch for ${archivedSeasonId}`);
  assert(archive.status === "frozen_read_only_in_place", `${archivedSeasonId} must remain frozen`);
  assert(archive.archive_policy?.excluded_from_new_default_compilation === true, `${archivedSeasonId} must be excluded from default compilation`);
  const archivedPatchId = archive.patches?.at(-1)?.patch_id;
  assert(archivedPatchId, `${archivedSeasonId} archive must identify its final patch`);
  const archivedCoreProfileId = archive.final_core_profile_id;
  const archivedCoreRegistration = (archive.generated_core_profiles || [])
    .find((entry) => entry.core_profile_id === archivedCoreProfileId);
  assert(archivedCoreRegistration?.bundle_path, `${archivedSeasonId} archive must register its immutable final Core bundle`);
  const archivedBundle = JSON.parse(await readFile(path.join(repoRoot, archivedCoreRegistration.bundle_path), "utf8"));
  assert(archivedBundle.combined_fingerprint === archivedCoreProfileId, `${archivedSeasonId} archived bundle identity must match its archive manifest`);
  const archivedCompilation = {
    combinedFingerprint: archivedCoreProfileId,
    bundle: archivedBundle,
  };
  assert(archivedCompilation.combinedFingerprint !== activeCompilation.combinedFingerprint, `${archivedSeasonId} must not share the active Core Profile identity`);
  assert(archivedCompilation.bundle.profile.season_id === archivedSeasonId, `${archivedSeasonId} compilation must retain its own identity`);
  assert(archivedCompilation.bundle.common && typeof archivedCompilation.bundle.common === "object", `${archivedSeasonId} archive must retain its historical Common snapshot`);
  for (const term of specialMechanicTerms(archivedCompilation.bundle.season)) {
    if (activeTerms.has(term)) continue;
    assert(!activeDescriptorText.includes(term), `active season ${activeProfile.season_id} must not inherit retired ${archivedSeasonId} term: ${term}`);
  }
  checkedArchivedSeasons.push(archivedSeasonId);
}

assert(activeProfile.core_profile_id === runtimePaths.activeCoreProfileId, "Runtime paths must resolve the promoted Core Profile exactly");
const candidateProfileId = candidateProfile.combined_fingerprint || candidateProfile.core_profile_id;
assert(/^[a-f0-9]{64}$/.test(String(candidateProfileId || "")), "candidate pointer must reference one immutable Core Profile identity");
assert(candidateProfile.status === "candidate_not_promoted", "candidate pointer must remain explicitly non-authoritative");
if ((candidateProfile.activation_blockers || []).length > 0) {
  assert(candidateProfile.combined_fingerprint !== activeProfile.core_profile_id, "a blocked candidate must never be active");
}
if (candidateProfileId === activeProfile.core_profile_id) {
  assert((candidateProfile.activation_blockers || []).length === 0, "an active candidate identity must have no activation blockers");
  assert(activeProfile.season_id === candidateProfile.season_id && activeProfile.patch_id === candidateProfile.patch_id, "active and candidate identities must agree when they share a fingerprint");
}

const session = await startSession({
  matchSessionId: "verify-season-snapshot",
  seasonSnapshotBase64Url: Buffer.from(JSON.stringify(
    createActiveCoreProfileSnapshot(repoRoot),
  ), "utf8").toString("base64url"),
  dryRun: true,
});
const snapshot = session.season_version_snapshot;
assert(snapshot?.activation_policy === "new_match_only", "Start Match must capture new-match-only activation policy");
assert(snapshot?.core_profile_id === activeProfile.core_profile_id, "Start Match must pin the exact active Core Profile id");
assert(snapshot?.core_profile_ref?.core_profile_id === activeProfile.core_profile_id, "Start Match must retain the compact Core Profile reference");
assert(snapshot?.core_profile_artifacts?.bundle === runtimePaths.activeCoreProfileBundleFile, "Start Match must pin the immutable bundle path");
assert(snapshot?.core_profile_artifacts?.decision_input_catalog === runtimePaths.activeDecisionInputCatalogFile, "Start Match must pin the decision catalog path");
assert(snapshot?.core_profile_artifacts?.augment_stage_authority === runtimePaths.activeDecisionInputAugmentStageAuthorityFile, "Start Match must pin the augment-stage authority path");
assert(snapshot?.core_profile_artifacts?.runtime_catalog_overlay === runtimePaths.activeRuntimeCatalogOverlayFile, "Start Match must pin the catalog overlay path");
assert(
  normalizedJson(snapshot?.core_source_identity) === normalizedJson(runtimePaths.activeDecisionInputCatalogSourceIdentity),
  "Start Match must pin the compiled source identity",
);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-season-version-isolation-verifier-v2",
  checked: [
    "active_tuple_matches_one_core_profile",
    "all_promotion_tuple_fields_fail_closed",
    "archived_core_retains_its_historical_common_snapshot",
    "active_and_archived_season_identities_are_distinct",
    "active_descriptor_does_not_inherit_any_retired_season_only_terms",
    "candidate_pointer_is_non_authoritative",
    "blocked_candidates_cannot_equal_the_active_identity",
    "a_promoted_candidate_identity_requires_zero_blockers",
    "all_registered_archives_remain_independently_inspectable",
    "start_match_pins_core_profile_and_artifact_paths",
  ],
  active_season_id: activeProfile.season_id,
  checked_archived_seasons: checkedArchivedSeasons,
}, null, 2));
