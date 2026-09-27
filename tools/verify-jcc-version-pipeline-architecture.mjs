import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { rankingPublicationScope, resolveRankingTarget } from "./jcc_ranking_target.mjs";
import { classifyRankingPipelineUpdate, runVersionPipeline } from "./run-jcc-version-pipeline.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function exists(relativePath) {
  try {
    await access(path.join(repoRoot, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function text(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function snapshotFile(relativePath) {
  try {
    const bytes = await readFile(path.join(repoRoot, relativePath));
    return { exists: true, byte_size: bytes.length, sha256: sha256(bytes) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, byte_size: 0, sha256: null };
    throw error;
  }
}

async function snapshotTree(relativeRoot) {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        files.push({
          path: path.relative(absoluteRoot, absolute).replaceAll("\\", "/"),
          byte_size: bytes.length,
          sha256: sha256(bytes),
        });
      }
    }
  }
  await visit(absoluteRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function snapshotCandidateAndGenerations() {
  return {
    candidate: await snapshotFile("data/game-knowledge/jcc/candidates/candidate-profile.json"),
    generations: await snapshotTree("data/game-knowledge/jcc/generated"),
  };
}

const manifest = JSON.parse(await text("data/game-knowledge/jcc/manifest.json"));
const harnessContract = JSON.parse(await text("data/runtime/jcc/harness-entrypoint-contract.json"));
const packageDocument = JSON.parse(await text("package.json"));
const pipeline = await text("tools/run-jcc-version-pipeline.mjs");
const compiler = await text("tools/jcc_game_knowledge_compiler.mjs");
const activeRules = await text("tools/jcc_active_rules_contract.mjs");
const runtimePaths = await text("ui/electron/runtime-state-store.js");
const agents = await text("AGENTS.md");
const rankingTargetSource = await text("tools/jcc_ranking_target.mjs");
const automaticRankingTarget = await resolveRankingTarget({ repoRoot, argv: ["--profile", "auto"] });
const activeRankingTarget = await resolveRankingTarget({ repoRoot, argv: ["--profile", "active"] });
const candidateProfile = JSON.parse(await text("data/game-knowledge/jcc/candidates/candidate-profile.json"));

assert.equal(manifest.generation?.candidate_profile, "candidates/candidate-profile.json");
assert.equal(manifest.generation?.candidate_compilation, "isolated_only");
assert.equal(manifest.generation?.production_activation, "explicit_verified_promotion_only");

assert.equal(harnessContract.schema, "jcc-harness-entrypoint-contract-v1");
assert.equal(harnessContract.authority_registry, "docs/requirements/requirements-registry.json");
assert.equal(harnessContract.modules?.versioning?.contract, "data/runtime/jcc/knowledge-profile-contract.json");
assert.equal(harnessContract.modules?.versioning?.pipeline, "tools/run-jcc-version-pipeline.mjs");
assert.ok(Array.isArray(harnessContract.verification_profiles?.version_update));
assert.ok(
  harnessContract.verification_profiles.version_update.includes("tools/verify-jcc-live-ranking-recipe-sources.mjs"),
  "cross-harness version updates must run the independent ranking recipe verifier",
);
for (const closureVerifier of [
  "tools/verify-jcc-live-ranking-active-closure-store.mjs",
  "tools/verify-jcc-live-ranking-active-closure.mjs",
  "tools/verify-jcc-ranking-coverage-audit.mjs",
]) {
  assert.ok(
    harnessContract.verification_profiles.version_update.includes(closureVerifier),
    `cross-harness version updates must run ${closureVerifier}`,
  );
}
assert.equal(Object.hasOwn(harnessContract.verification_profiles, "s18_source_adapter"), false);

for (const [patchId, patchPath] of Object.entries(manifest.patch_manifests || {})) {
  const patch = JSON.parse(await text(path.posix.join("data/game-knowledge/jcc", patchPath)));
  if (manifest.season_archives?.[patch.season_id]) continue;
  assert.ok(patch.source_adapter?.id, `active patch ${patchId} must own a source adapter`);
  assert.ok(Array.isArray(patch.source_adapter?.verifiers));
  assert.ok(patch.source_adapter.verifiers.length >= 1, `active patch ${patchId} must own source verifiers`);
  assert.ok(patch.source_adapter.verifiers.every((entry) => entry.command?.startsWith("tools/") && Array.isArray(entry.arguments)));
}

assert.equal(packageDocument.scripts?.["knowledge:pipeline"], "node tools/run-jcc-version-pipeline.mjs");
for (const phase of ["inspect", "compile", "intelligence", "rankings", "verify", "promote", "archive", "prune"]) {
  assert.match(pipeline, new RegExp(`\\b${phase}\\b`), `version pipeline must expose ${phase}`);
}
assert.match(pipeline, /expected-core-profile-id/);
assert.match(pipeline, /activation_blockers/);
assert.deepEqual(
  classifyRankingPipelineUpdate({
    ok: true,
    output_dir: null,
    status: "ranking_strength_unavailable_recipes_cached",
  }),
  {
    status: "partial",
    degraded: true,
    ranking_overlay_published: false,
    active_pointer_preserved: true,
  },
  "recipe-only refresh must not be reported as a published ranking overlay",
);
assert.deepEqual(
  classifyRankingPipelineUpdate({
    ok: true,
    output_dir: "data/live-rankings/jcc/generations/prepared",
    sync: {
      prepared_generation: { generation_id: "20260831-aaaaaaaaaaaaaaaaaaaaaaaa" },
      ranking_target: { publication_scope: "active" },
    },
  }),
  {
    status: "prepared",
    degraded: false,
    ranking_overlay_published: false,
    active_pointer_preserved: true,
  },
  "a deferred generic rankings update must remain prepared until semantic maintenance finalizes it",
);
assert.deepEqual(
  classifyRankingPipelineUpdate({ ok: true, output_dir: "data/live-rankings/jcc/generations/example" }),
  {
    status: "published",
    degraded: false,
    ranking_overlay_published: true,
    active_pointer_preserved: false,
  },
  "a verified immutable overlay is the only published state",
);
assert.deepEqual(
  classifyRankingPipelineUpdate({
    ok: true,
    output_dir: "data/live-rankings/jcc/generations/candidate",
    sync: { ranking_target: { publication_scope: "candidate" } },
  }),
  {
    status: "published",
    degraded: false,
    ranking_overlay_published: true,
    active_pointer_preserved: true,
  },
  "candidate overlay publication must preserve the production active pointer",
);
assert.match(pipeline, /pruneRankingRecipeGenerations/);
assert.match(pipeline, /validRecipeGenerationIds:\s*recipeGenerationIds/,
  "Ranking prune must remove candidate pointers whose pinned recipe generation no longer exists");
assert.match(pipeline, /\.\.\.rankings\.candidate_recipe_generation_ids/,
  "recipe prune must protect exact recipe generations pinned by retained Ranking candidates");
assert.match(pipeline, /protectedCoreProfileIds:\s*coreProfiles\.current_profile_ids/,
  "recipe candidate retention must follow active/pending Core pointers, including recipe-only candidates");
assert.match(pipeline, /validCoreProfileIds:\s*coreProfiles\.current_profile_ids/,
  "Ranking candidate retention must not inherit historical Core disk retention");
assert.match(
  pipeline,
  /const rankingLease = await acquireLiveRankingRefreshLease[\s\S]*?pruneLiveRankingGenerations[\s\S]*?lease: rankingLease[\s\S]*?pruneRankingRecipeGenerations[\s\S]*?lease: rankingLease/,
  "ranking overlay and recipe pruning must share one lifecycle lease",
);
assert.match(pipeline, /import \{ randomUUID \} from "node:crypto"/);
assert.match(pipeline, /readGameKnowledgeGenerationLeases/);
assert.match(pipeline, /generationLeases\.map\(\(lease\) => lease\.recipe_generation_id\)/);
assert.doesNotMatch(pipeline, /relativeScript === "tools\/verify-jcc-version-pipeline-architecture\.mjs"/);
assert.match(pipeline, /source_adapter\?\.verifiers/);
assert.match(
  pipeline,
  /relativeScript === "tools\/verify-jcc-hard-data\.mjs" && candidateHardDataManifest[\s\S]*?"--candidate-manifest", candidateHardDataManifest/,
  "pre-promotion version verification must validate the candidate hard-data generation instead of the older Active generation",
);
assert.match(pipeline, /is archived and cannot be promoted/);
assert.match(pipeline, /is archived and cannot compile a writable candidate/);
assert.match(pipeline, /not_retained_in_frozen_source_manifest/);
assert.match(pipeline, /function containedToolFile/);
assert.match(pipeline, /update-jcc-live-rankings\.mjs/);
assert.match(
  pipeline,
  /async function rankings[\s\S]*?publication\.ranking_overlay_published === true[\s\S]*?await prune\([\s\S]*?retainPrevious/,
  "a successful Ranking publication must run bounded generation cleanup automatically",
);
assert.match(pipeline, /"--profile", "candidate"/);
assert.match(pipeline, /completeCoreRankingPublicationTransaction/);
assert.match(pipeline, /publication\.status !== "committed"/);
assert.match(pipeline, /pruning_required: false/);
assert.match(pipeline, /ok: maintenance\.ok === true && maintenance\.repair_required !== true/);
assert.match(pipeline, /retryable: maintenance\.ok !== true \|\| maintenance\.repair_required === true/);
assert.match(pipeline, /validateRankingClosureCandidateSync/);
assert.match(pipeline, /acquireLiveRankingRefreshLease/);
assert.match(pipeline, /verifyLiveRankingGeneration/);
assert.match(pipeline, /verify-jcc-live-rankings\.mjs/);
assert.match(pipeline, /"--defer-activation"/);
assert.match(pipeline, /required_before_finalize/);
assert.match(pipeline, /finalize-jcc-ranking-maintenance\.mjs/);
assert.match(pipeline, /recipe_generation_id/);
const rankingsFunctionOffset = pipeline.indexOf("async function rankings");
const deferredUpdateOffset = pipeline.indexOf('"--defer-activation"', rankingsFunctionOffset);
const maintenanceOffset = pipeline.indexOf("finalizePreparedRankingMaintenance(update, options)", rankingsFunctionOffset);
const finalizerOffset = pipeline.indexOf('tools/finalize-jcc-ranking-maintenance.mjs', maintenanceOffset);
assert.ok(
  rankingsFunctionOffset >= 0
    && deferredUpdateOffset > rankingsFunctionOffset
    && maintenanceOffset > deferredUpdateOffset
    && finalizerOffset > maintenanceOffset,
  "generic rankings must prepare with deferred activation, run semantic maintenance, and finalize the maintained publication",
);
const promotionFunctionOffset = pipeline.indexOf("async function promote");
assert.ok(promotionFunctionOffset >= 0);
const rankingLeaseOffset = pipeline.indexOf("rankingLease = await acquireLiveRankingRefreshLease", promotionFunctionOffset);
const closureValidationOffset = pipeline.indexOf("preparedRankingClosure = validateRankingClosureCandidateSync", promotionFunctionOffset);
const transactionOffset = pipeline.indexOf("completeCoreRankingPublicationTransaction({", promotionFunctionOffset);
const corePromotionOffset = pipeline.indexOf("promoteCoreProfile: () => promoteGameKnowledgeCandidate", promotionFunctionOffset);
assert.ok(
  rankingLeaseOffset > promotionFunctionOffset
    && rankingLeaseOffset < closureValidationOffset
    && closureValidationOffset < transactionOffset
    && transactionOffset < corePromotionOffset,
  "candidate Ranking and pinned recipe identities must be validated before the durable Core+Ranking publication transaction",
);
assert.doesNotMatch(pipeline, /ranking_activation_unavailable/);
assert.doesNotMatch(pipeline, /restoreActiveRankingClosure/);
assert.equal(automaticRankingTarget.selection, "active", "an unqualified production refresh must follow the active Core Profile");
assert.equal(automaticRankingTarget.core_profile_id, activeRankingTarget.core_profile_id);
assert.equal(
  automaticRankingTarget.publication_scope,
  "active",
  "an unqualified production refresh must publish only against the active Core Profile",
);
assert.equal(rankingPublicationScope("candidate"), "candidate");
assert.equal(rankingPublicationScope("active"), "active");
if (automaticRankingTarget.season_id !== activeRankingTarget.season_id) {
  assert.notEqual(
    automaticRankingTarget.ranking_set_id,
    activeRankingTarget.ranking_set_id,
    "different major seasons must retain distinct ranking set identities",
  );
}
const mismatchedActiveSeason = automaticRankingTarget.season_id !== activeRankingTarget.season_id
  ? automaticRankingTarget.season_id
  : (activeRankingTarget.season_id === "s999" ? "s998" : "s999");
await assert.rejects(
  resolveRankingTarget({ repoRoot, argv: ["--profile", "active", "--season", mismatchedActiveSeason] }),
  /does not match --season/,
  "an explicit candidate season must not be completed from the active Core Profile",
);
await assert.rejects(
  resolveRankingTarget({ repoRoot, argv: ["--profile", "candidate", "--expected-core-profile-id", "0".repeat(64)] }),
  /does not match --expected-core-profile-id|No Core Profile matches/,
  "ranking refresh must fail closed on expected Core Profile mismatch",
);
assert.doesNotMatch(rankingTargetSource, /season_id\s*:\s*["']s\d+/);
assert.doesNotMatch(rankingTargetSource, /patch_id\s*:\s*["']s\d+_\d+/);
assert.doesNotMatch(compiler, /seasonId === ["']s\d+["']/);
assert.doesNotMatch(compiler, /seasonId = ["']s\d+["']/);
assert.doesNotMatch(compiler, /patchId = ["']s\d+_\d+["']/);
assert.match(compiler, /assertNoForeignLocalSeasonIdentifiers/);

assert.doesNotMatch(activeRules, /allowLegacyRuleFixtures/);
assert.doesNotMatch(activeRules, /legacy_rule_fixture/);
assert.doesNotMatch(runtimePaths, /legacySeasonNormalRuleFixtureFile/);
assert.doesNotMatch(runtimePaths, /legacySeasonSpecialRuleFixtureFile/);
assert.doesNotMatch(runtimePaths, /legacyBaseGameRuleFixtureFile/);

for (const retiredPath of [
  "tools/migrate-jcc-active-rules-to-game-knowledge.mjs",
  "tools/migrate-jcc-common-doctrine.mjs",
  "tools/verify-jcc-game-knowledge-shadow-parity.mjs",
  "tools/promote-jcc-game-knowledge-profile.mjs",
  "data/runtime/jcc/fixtures/legacy-rules/common/base-game-rules.json",
  "data/runtime/jcc/fixtures/legacy-rules/s17/normal-rules.json",
  "data/runtime/jcc/fixtures/legacy-rules/s17/special-rules.json",
]) {
  assert.equal(await exists(retiredPath), false, `retired migration surface must stay deleted: ${retiredPath}`);
}

for (const packageEntry of await readdir(path.join(repoRoot, "data/core-patches/jcc"), { withFileTypes: true })) {
  if (!packageEntry.isDirectory()) continue;
  for (const retiredRelative of ["graphs", "runtime-fixtures", "indexes/hot"]) {
    assert.equal(
      await exists(path.posix.join("data/core-patches/jcc", packageEntry.name, retiredRelative)),
      false,
      `retired generated surface must stay deleted: ${packageEntry.name}/${retiredRelative}`,
    );
  }
}

for (const requiredText of [
  "# JCC Runtime Host CLI Context",
  "canonical project rules are AGENTS.md",
  "Return the exact JSON shape requested by the prompt.",
]) {
  assert.match(agents, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

const [archivedSeasonId] = Object.keys(manifest.season_archives || {});
assert.ok(archivedSeasonId, "architecture verifier requires one registered archived season fixture");
const archivedPatchEntry = Object.entries(manifest.patch_manifests || {})
  .map(([patchId, relativePath]) => [patchId, relativePath, null])
  .find(([, relativePath]) => {
    const normalized = String(relativePath || "").replaceAll("\\", "/");
    return normalized.startsWith(`seasons/${archivedSeasonId}/patches/`);
  });
assert.ok(archivedPatchEntry, `archived season ${archivedSeasonId} must retain one registered patch for read-only audit`);

const archiveWriteBoundaryBefore = await snapshotCandidateAndGenerations();
await assert.rejects(
  runVersionPipeline({
    phase: "compile",
    seasonId: archivedSeasonId,
    patchId: archivedPatchEntry[0],
    expectedCoreProfileId: "0".repeat(64),
    write: true,
  }),
  new RegExp(`Season ${archivedSeasonId} is archived and cannot compile a writable candidate`),
);
const archiveWriteBoundaryAfter = await snapshotCandidateAndGenerations();
assert.deepEqual(
  archiveWriteBoundaryAfter,
  archiveWriteBoundaryBefore,
  "rejected archived compile --write must not change candidate bytes or any generated path/content",
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-version-pipeline-architecture-verifier-v1",
  checked: [
    "machine_readable_harness_entrypoint",
    "explicit_candidate_compile_and_promotion",
    "generic_version_pipeline_phases",
    "rankings_is_first_class_and_intelligence_is_a_compatibility_alias",
    "ranking_recipe_verifier_registered_for_cross_harness_updates",
    "ranking_overlay_and_recipe_pruning_share_one_lifecycle_lease",
    "automatic_ranking_target_follows_active_core_profile",
    "candidate_rankings_cannot_replace_production_pointer",
    "ranking_publication_requires_semantically_ready_paired_closure",
    "cross_season_and_core_profile_target_mismatch_fail_closed",
    "legacy_rule_fallback_retired",
    "graph_telemetry_hot_shards_stay_retired",
    "agents_architecture_navigation",
    "archived_compile_write_fails_before_candidate_or_generation_mutation",
  ],
})}\n`);
